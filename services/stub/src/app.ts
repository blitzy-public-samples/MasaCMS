/** Composition root of the platform-proof stub service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox, registerOutboxSweep } from '@opt2/platform/outbox';
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
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: STUB_OWNER,
    version: VERSION,
    env,
    clock: options.clock ?? systemClock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: STUB_SCHEMA } : { pool: options.db }),
  });

  // Only what buildApp created is closed, the task port before the publisher; injected instances belong to the caller.
  const owned: { publisher?: EventPublisher; taskPort?: TaskPort } = {};
  app.addHook('onClose', async () => {
    try {
      await owned.taskPort?.close();
    } finally {
      await owned.publisher?.close();
    }
  });

  try {
    const { db, clock, logger } = app.opt2;
    if (db === undefined) throw new Error(`${STUB_OWNER}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    const payloadValidators = new Map([[NOTE_CREATED_TOPIC, noteCreatedValidator]]);
    const publisher =
      options.publisher ??
      (owned.publisher = createPublisher({
        projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
        emulatorHost,
        payloadValidators,
      }));
    createOutbox({ service: STUB_OWNER, db, publisher, logger, clock, payloadValidators });

    const taskPort = options.taskPort ?? (owned.taskPort = await createTaskPort(env, { db, clock, logger }));

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
