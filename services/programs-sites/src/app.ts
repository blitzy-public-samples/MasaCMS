/** Composition root of the programs-sites service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  baseEnvSchema,
  createService,
  loadEnv,
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
import { registerRoutes, registerSiteMonitorRoutes } from './routes/index.js';
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
  const app = await createService({
    name: OWNER,
    version: VERSION,
    env,
    clock: options.clock ?? systemClock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });
  const { db, clock, logger } = app.opt2;
  if (db === undefined) throw new Error(`${OWNER}: createService opened no database`);
  const serviceUrls = env.OPT2_SERVICE_URLS;

  // Only what buildApp creates is closed with the app; injected instances belong to the caller.
  const owned: { close(): Promise<void> }[] = [];
  const own = <T extends { close(): Promise<void> }>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  app.addHook('onClose', async () => {
    await Promise.all(owned.map((resource) => resource.close()));
  });

  const payloadValidators = new Map([[SITE_CHANGED_TOPIC, siteChangedValidator]]);
  const publisher =
    options.publisher ??
    own(
      createPublisher({
        projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
        emulatorHost: env.PUBSUB_EMULATOR_HOST,
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
}
