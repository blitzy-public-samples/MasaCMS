/** Composition root of the always-on migration service: windows, projection, authority, legacy steps, gates, transitions, scheduler, background control and faults. */
import { serializeError } from '@opt2/platform/logging';
import { createService, systemClock, type Clock, type CreateServiceOptions, type FastifyInstance } from '@opt2/platform/service-kit';
import { reconcileRecurringQueues } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';

import { createMigrationContext, type CreateContextOptions, type MigrationContext } from './context.js';
import { preloadCutover } from './cutover/index.js';
import { assertSqlServerSource, loadMigrationServerEnv, type MigrationEnv } from './env.js';
import { createFaultRegistry } from './faults/index.js';
import type { BridgeClient } from './legacy/bridge.js';
import { createBackgroundState } from './quiesce/background.js';
import { createProjector } from './reverse/index.js';
import { registerRoutes, type RouteDeps } from './routes/index.js';
import { SCHEDULER_KEYS, createSchedulerService, readSchedulerKey } from './scheduler/index.js';
import { createTransitionService } from './transition/index.js';
import { createStartupGuardRunner, createWindowService } from './windows/index.js';

const SERVICE_NAME = 'migration';
/** Equals `info.version` of `contracts/openapi.yaml`. */
const SERVICE_VERSION = '1.0.0';
const MIGRATION_SCHEMA = 'migration';

/** Ports `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: MigrationEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  /** `migration`-schema pool; createService opens one from `env` when absent. */
  db?: TenantDb;
  legacy?: CreateContextOptions['legacy'];
  owners?: CreateContextOptions['owners'];
  gateway?: CreateContextOptions['gateway'];
  bridge?: BridgeClient;
  /** False registers the routes without starting any loop or start-up recovery (tests, route matrix export); defaults to true. */
  startBackground?: boolean;
}

/** The services every route module is bound to. */
type Services = Omit<RouteDeps, 'ctx'>;

/** A running timer chain; `stop` cancels the next run and waits for the one in flight. */
interface Loop {
  stop(): Promise<void>;
}

/** What every loop iteration consults before it runs, and where its failure is logged. */
interface LoopDeps {
  logger: MigrationContext['logger'];
  isSuspended(): Promise<boolean>;
}

/**
 * Runs `iteration` `intervalMs` after the previous run settled, skipping while background work is suspended.
 * A failure is logged and the chain continues.
 */
function startLoop(name: string, intervalMs: number, iteration: () => Promise<void>, deps: LoopDeps): Loop {
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> | undefined;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(tick, intervalMs);
    // The listening server keeps the process alive; a chain alone never does.
    timer.unref();
  }

  function tick(): void {
    timer = undefined;
    inflight = (async () => {
      try {
        if (!(await deps.isSuspended())) await iteration();
      } catch (error) {
        deps.logger.warn({ error: serializeError(error) }, `${name} failed; it runs again in ${String(intervalMs)} ms`);
      }
    })().finally(() => {
      inflight = undefined;
      schedule();
    });
  }

  schedule();
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inflight;
    },
  };
}

/** Ensures the recurring task chains: every outbox sweep, local-only ones in the local stack, and the site monitor once handed off. @throws Error naming each chain not ensured */
async function reconcileRecurring(ctx: MigrationContext): Promise<void> {
  const monitor = await readSchedulerKey(ctx.db, SCHEDULER_KEYS.siteMonitor);
  // Decided as `opt2-ops resume` decides it: a chain before the hand-off would run the monitor beside the native ACF task.
  const withSiteMonitor = monitor !== null && monitor.nativeExisted && monitor.state === 'target' && !monitor.targetTriggerDisabled;
  const results = await reconcileRecurringQueues(ctx.client, {
    serviceUrls: ctx.env.OPT2_SERVICE_URLS,
    withSiteMonitor,
    includeLocalOnly: ctx.env.OPT2_ENV === 'local',
  });
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(
      `Recurring chains not ensured: ${failed.map(({ queue, service, error }) => `${queue} on ${service}: ${error ?? 'not ensured'}`).join('; ')}`,
    );
  }
}

/**
 * Starts the projector, window and transition recovery, the bridge poll and the recurring-task reconcile.
 * @returns the stop of all of them, which waits for the work in flight.
 */
function startBackground(ctx: MigrationContext, services: Services): () => Promise<void> {
  const { projector, windows, transitions, background } = services;
  const deps: LoopDeps = { logger: ctx.logger, isSuspended: () => background.isSuspended() };
  const logFailure =
    (what: string) =>
    (error: unknown): void => {
      ctx.logger.warn({ error: serializeError(error) }, `${what} failed at start-up`);
    };
  let stopping = false;
  let retryLoop: Loop | undefined;

  // Not gated by suspension: legacy-bound reads of target-authoritative units wait on the projection barrier it advances.
  projector.start();
  const recovery = Promise.all([
    windows
      .resumeWindows()
      .catch(logFailure('Write window recovery'))
      .then(() => {
        if (!stopping) retryLoop = windows.startImportRetryLoop();
      }),
    transitions.resume().then(() => undefined, logFailure('Transition resume')),
  ]);
  const loops = [
    // A request inside the Masa application, so ColdFusion never reaches its three-day idle application expiry.
    startLoop(
      'Legacy bridge poll',
      ctx.config.background.bridgePollMs,
      async () => {
        await ctx.bridge.schedulerDescribe();
      },
      deps,
    ),
    startLoop('Recurring task reconcile', ctx.config.background.tasksReconcileMs, () => reconcileRecurring(ctx), deps),
  ];

  return async () => {
    stopping = true;
    await Promise.all(loops.map((loop) => loop.stop()));
    await recovery;
    await retryLoop?.stop();
    await projector.stop();
  };
}

/** Builds the services in dependency order over one context. */
function composeServices(ctx: MigrationContext): Services {
  const faults = createFaultRegistry(ctx);
  const background = createBackgroundState(ctx);
  // Late-bound: the guard's reload windows belong to the window service, which needs the projector built first.
  const startupGuard = createStartupGuardRunner(ctx, () => windows.runReloadWindow());
  const projector = createProjector(ctx, { hooks: faults.projectorHooks(), startupGuard });
  const windows = createWindowService(ctx, {
    projector,
    hooks: faults.windowHooks(),
    shouldRun: async () => !(await background.isSuspended()),
  });
  const scheduler = createSchedulerService(ctx);
  // The transition keeps its own guard, which reloads without a window whose lease would wait on the transition's leases.
  const transitions = createTransitionService(ctx, { projector, windows, scheduler });
  return { faults, background, projector, windows, scheduler, transitions };
}

/** Starts background work on ready when asked, stops it before the server closes, then the services and the context once requests drained. */
function registerLifecycle(app: FastifyInstance, ctx: MigrationContext, services: Services, background: boolean): void {
  let stopBackground: () => Promise<void> = () => Promise.resolve();
  if (background) {
    app.addHook('onReady', (done) => {
      stopBackground = startBackground(ctx, services);
      done();
    });
  }
  app.addHook('preClose', async () => {
    await stopBackground();
  });
  // After in-flight requests have finished, so no route starts window or transition work behind these stops.
  app.addHook('onClose', async () => {
    try {
      await services.windows.stop();
      await services.transitions.stop();
    } finally {
      await ctx.close();
    }
  });
}

/** Closes what a failed build opened: the app, the context, the service client and, when `ownsPool`, the pool; failures are logged. */
async function closePartialApp(app: FastifyInstance, ctx: MigrationContext | undefined, ownsPool: boolean): Promise<void> {
  const { client, db, logger } = app.opt2;
  for (const step of [() => app.close(), () => ctx?.close(), () => client.close(), () => (ownsPool ? db?.end() : undefined)]) {
    try {
      await step();
    } catch (error) {
      logger.error({ error: serializeError(error) }, 'start-up cleanup failed');
    }
  }
}

/** Builds and readies the migration service app with every contract route registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadMigrationServerEnv();
  // Checked before createService opens a pool, so an unsupported legacy source fails without leaking one.
  assertSqlServerSource(env);
  const clock = options.clock ?? systemClock;
  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: MIGRATION_SCHEMA } : { pool: options.db }),
  });

  let ctx: MigrationContext | undefined;
  try {
    const { logger, db, client } = app.opt2;
    ctx = await createMigrationContext({
      env,
      clock,
      logger,
      db,
      client,
      legacy: options.legacy,
      owners: options.owners,
      gateway: options.gateway,
      bridge: options.bridge,
    });
    // Requests and loops then select committed versions from memory instead of reading files on the event loop.
    await preloadCutover(ctx.config.paths);
    const services = composeServices(ctx);
    registerRoutes(app, { ctx, ...services });
    registerLifecycle(app, ctx, services, options.startBackground !== false);
    await app.ready();
    return app;
  } catch (error) {
    await closePartialApp(app, ctx, options.db === undefined);
    throw error;
  }
}

/** Builds the app with its background work and listens on `PORT` on every interface; SIGTERM shuts it down through service-kit. */
export async function startServer(): Promise<FastifyInstance> {
  const app = await buildApp({ startBackground: true });
  try {
    await app.listen({ port: app.opt2.env.PORT, host: '0.0.0.0' });
  } catch (error) {
    // A built app's pools, clients and loops would keep the process alive without the kit's shutdown.
    await app.opt2.shutdown().catch((shutdownError: unknown) => {
      app.opt2.logger.error({ error: serializeError(shutdownError) }, 'shutdown after a failed listen failed');
    });
    throw error;
  }
  return app;
}
