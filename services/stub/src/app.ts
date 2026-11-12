/** Composition root of the platform-proof stub service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox, registerOutboxSweep } from '@opt2/platform/outbox';
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
import { createTaskPort, ensureOwnRecurring, registerQueueControl, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { stubConsumers } from './events/consumers.js';
import { NOTE_CREATED_TOPIC, noteCreatedValidator } from './events/topics.js';
import { mappings } from './migration/mappings/index.js';
import { STUB_OWNER, STUB_SCHEMA, createStubRepository } from './repo/repository.js';
import { STUB_UNITS } from './repo/tables.js';
import { registerRoutes } from './routes/index.js';

/** Equals `info.version` of `contracts/openapi.yaml`. */
const VERSION = '1.0.0';

// Default project of the harness's local Pub/Sub topology; the stub is local only and never deployed.
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

/** Builds the stub Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(baseEnvSchema);
  const app = await createService({
    name: STUB_OWNER,
    version: VERSION,
    env,
    clock: options.clock ?? systemClock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: STUB_SCHEMA } : { pool: options.db }),
  });
  const { db, clock, logger } = app.opt2;
  if (db === undefined) throw new Error(`${STUB_OWNER}: createService opened no database`);
  const serviceUrls = env.OPT2_SERVICE_URLS;

  const payloadValidators = new Map([[NOTE_CREATED_TOPIC, noteCreatedValidator]]);
  const publisher =
    options.publisher ??
    createPublisher({
      projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
      emulatorHost: env.PUBSUB_EMULATOR_HOST,
      payloadValidators,
    });
  createOutbox({ service: STUB_OWNER, db, publisher, logger, clock, payloadValidators });

  const taskPort = options.taskPort ?? (await createTaskPort(env, { db, clock, logger }));

  // Only what buildApp created is closed, the task port before the publisher; injected instances belong to the caller.
  app.addHook('onClose', async () => {
    try {
      if (taskPort !== options.taskPort) await taskPort.close();
    } finally {
      if (publisher !== options.publisher) await publisher.close();
    }
  });

  // An injected throwaway pool names its own schema; the service's own pool names `stub`.
  const repository = createStubRepository({ clock, schema: db.schema });
  // Must precede registerMigrationHandlers, which refuses to register without it.
  registerWritePositionHeader(app);

  await registerRoutes(app, { db, repository, clock });
  registerConsumers(app, { service: STUB_OWNER, consumers: stubConsumers(repository, clock), publisher, db });
  registerMigrationHandlers(app, { owner: STUB_OWNER, repository, mappings, units: STUB_UNITS, db });
  registerOutboxSweep(app, { service: STUB_OWNER, port: taskPort, serviceUrls, clock });
  registerQueueControl(app, { port: taskPort, service: STUB_OWNER, serviceUrls, clock });

  app.addHook('onReady', async () => {
    await ensureOwnRecurring(taskPort, { service: STUB_OWNER, serviceUrls, clock });
  });
  return app;
}
