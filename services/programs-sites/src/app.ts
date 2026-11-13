/** Composition root of the programs-sites service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
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
import type { TaskPort } from '@opt2/platform/tasks';
import { SITE_CHANGED_TOPIC, type TenantDb } from '@opt2/platform/tenancy';
import { createSitesDomain } from './domain/sites.js';
import { siteChangedValidator, siteRegistryConsumerRegistration } from './events/consumers.js';
import { mappings, units } from './migration/mappings/index.js';
import { OWNER, SCHEMA, createProgramsSitesRepository } from './repo/repository.js';
import { JSON_API_SITE_PREFIXES, SITEMONITOR_RUN_PREFIXES, registerRoutes, registerSiteMonitorRoutes } from './routes/index.js';
import { createProgramsSitesTaskPort, ensureStartupChains, registerQueueControlRoutes, registerSweep } from './tasks/port.js';

/** Equals `info.version` of `contracts/openapi.yaml`. */
const VERSION = '1.0.0';

// Default project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
}

/** Builds the programs-sites Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(baseEnvSchema);
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: OWNER,
    version: VERSION,
    env,
    clock: options.clock ?? systemClock,
    verifierOverride: options.verifierOverride,
    noCasePathPrefixes: [...SITEMONITOR_RUN_PREFIXES, ...JSON_API_SITE_PREFIXES],
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });

  // Only what buildApp creates is closed with the app; injected instances belong to the caller.
  const owned: { close(): Promise<void> }[] = [];
  const own = <T extends { close(): Promise<void> }>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  app.addHook('onClose', async () => {
    await Promise.all(owned.map((resource) => resource.close()));
  });

  try {
    const { db, clock, logger } = app.opt2;
    if (db === undefined) throw new Error(`${OWNER}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    const payloadValidators = new Map([[SITE_CHANGED_TOPIC, siteChangedValidator]]);
    const publisher =
      options.publisher ??
      own(
        createPublisher({
          projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
          emulatorHost,
          payloadValidators,
        }),
      );
    createOutbox({ service: OWNER, db, publisher, logger, clock, payloadValidators });

    const port = options.taskPort ?? own(await createProgramsSitesTaskPort(env, { db, clock, logger }));

    // An injected throwaway pool names its own schema; the service's own pool names `programs_sites`.
    const repository = createProgramsSitesRepository({ clock, schema: db.schema });
    // Must precede registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);

    await registerRoutes(app, { db, repository, port, clock, serviceUrls, env });
    registerConsumers(app, { service: OWNER, consumers: [siteRegistryConsumerRegistration], publisher, db });
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository,
      mappings,
      units,
      db,
      emitStateEvents: createSitesDomain({ repo: repository }).emitStateEvents,
    });
    await registerSweep(app, { port, serviceUrls, clock });
    await registerSiteMonitorRoutes(app, { db, port, clock, serviceUrls });
    await registerQueueControlRoutes(app, { port, serviceUrls, clock });

    // Outbox-sweep chain only: the site-monitor chain starts solely through `opt2-tasks reconcile --with-sitemonitor`.
    app.addHook('onReady', async () => {
      await ensureStartupChains(port, { serviceUrls, clock });
    });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Closes a failed build's app with its owned resources, its service client and, when `ownsPool`, its pool; failures are logged. */
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
