// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of the reporting service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  baseEnvSchema,
  createService,
  loadEnv,
  publisherEmulatorHost,
  systemClock,
  type BaseEnv,
  type Clock,
  type CreateServiceOptions,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { createStoragePort, type StoragePort } from '@opt2/platform/storage';
import { QUEUES, createTaskPort, registerQueueControl, registerTaskRoute, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { ReportingDeps } from './domain/deps.js';
import { consumers } from './events/consumers.js';
import { registerFixtureRoutes } from './legacy/index.js';
import { mappings, units } from './migration/mappings/index.js';
import { createExportObjects } from './migration/objects.js';
import { createReportingRepository } from './repo/repository.js';
import { OWNER, SCHEMA } from './repo/tables.js';
import { registerRoutes } from './routes/index.js';
import { createExportRunEnqueuer, createExportRunProbe } from './tasks/enqueue.js';
import { exportRunTaskOptions } from './tasks/handler.js';

/** Equals `info.version` of `contracts/openapi.yaml`. */
const VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Fastify form of the `reporting-export-run` target path: the handler reads `{exportId}` as a route param. */
const EXPORT_RUN_ROUTE = QUEUES['reporting-export-run'].targetPath.replace(/\{(\w+)\}/g, ':$1');

/** Dependencies `buildApp` uses instead of building its own from the environment; injected ones stay open when the app closes. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
  storage?: StoragePort;
  tasks?: TaskPort;
}

/** Builds the reporting Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(baseEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: OWNER,
    version: VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });

  // Only what buildApp creates is closed with the app; injected instances belong to the caller.
  const owned: (() => Promise<void>)[] = [];
  app.addHook('onClose', async () => {
    await Promise.all(owned.map((close) => close()));
  });

  try {
    const db = app.opt2.db;
    if (db === undefined) throw new Error(`${OWNER}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    // Signs local URLs on the clock that the export file route verifies them with.
    const storage = options.storage ?? (await createStoragePort(env, { now: () => clock.now().getTime() }));

    let tasks = options.tasks;
    if (tasks === undefined) {
      const created = await createTaskPort(env, { db, clock, logger: app.opt2.logger });
      owned.push(() => created.close());
      tasks = created;
    }

    // Reporting produces no topic: the publisher carries only the consumers' dead letters.
    let publisher = options.publisher;
    if (publisher === undefined) {
      const created = createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID, emulatorHost });
      owned.push(() => created.close());
      publisher = created;
    }

    const repository = createReportingRepository({ db, storage, clock });
    const deps: ReportingDeps = {
      db,
      repository,
      storage,
      clock,
      client: app.opt2.client,
      enqueue: createExportRunEnqueuer({ tasks, serviceUrls, clock }),
      runScheduled: createExportRunProbe({ tasks }),
    };

    await registerFixtureRoutes(app, deps);
    await registerRoutes(app, deps);
    // Fastify extends a root onSend hook to the route plugins registered before it. Must precede
    // registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository,
      mappings,
      units,
      db,
      exportObjects: createExportObjects({ storage, repository }),
    });
    registerConsumers(app, { service: OWNER, consumers, publisher, db });
    registerTaskRoute(app, EXPORT_RUN_ROUTE, exportRunTaskOptions(deps));
    registerQueueControl(app, { port: tasks, service: OWNER, serviceUrls, clock });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Closes a failed build's app with its owned ports, its service client and, when `ownsPool`, its pool; failures are logged. */
async function closePartialApp(app: FastifyInstance, ownsPool: boolean): Promise<void> {
  const { client, db, logger } = app.opt2;
  for (const step of [() => app.close(), () => client.close(), () => (ownsPool ? db?.end() : undefined)]) {
    try {
      await step();
    } catch (err) {
      logger.error({ error: serializeError(err) }, 'start-up cleanup failed');
    }
  }
}
