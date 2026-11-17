// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { AuthOverrides } from '@opt2/platform/auth';
import { createPublisher, registerConsumers, type EventPublisher, type TopicValidator } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox, registerOutboxSweep } from '@opt2/platform/outbox';
import {
  IDENTITY_SERVICE,
  baseEnvSchema,
  createService,
  loadEnv,
  processEnvSchema,
  publisherEmulatorHost,
  type BaseEnv,
  type Clock,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { ensureOwnRecurring, registerQueueControl, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { siteRegistryConsumerRegistration } from './events/consumers.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledValidator } from './events/survey-scheduled.js';
import { MAPPINGS } from './migration/mappings/index.js';
import { OWNER, SCHEMA, createSurveysRepository } from './repo/repository.js';
import { UNITS } from './repo/tables.js';
import { registerRoutes } from './routes/index.js';
import { registerLaunchTaskRoute } from './tasks/launch.js';
import { createSurveysTaskPort } from './tasks/port.js';

/** Equals `info.version` of `contracts/openapi.yaml`. */
const VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/**
 * Base variables with surveys' own name, its database and the URLs of its callees required: itself (its outbox sweep's
 * task target), identity (CSRF) and communications (scheduled tasks).
 */
export const surveysEnvSchema = processEnvSchema(baseEnvSchema, {
  service: OWNER,
  callees: [OWNER, IDENTITY_SERVICE, 'communications'],
  database: true,
});

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: AuthOverrides;
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
}

/** Builds the surveys Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(surveysEnvSchema);
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: OWNER,
    version: VERSION,
    env,
    clock: options.clock,
    verifierOverride: options.verifierOverride,
    legacyFixturePaths: true,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });
  // The task port and publisher close with the app whether built here or injected; the pool is service-kit's.
  const held: { publisher?: EventPublisher; taskPort?: TaskPort } = { publisher: options.publisher, taskPort: options.taskPort };
  app.addHook('onClose', async () => {
    try {
      await held.taskPort?.close();
    } finally {
      await held.publisher?.close();
    }
  });

  try {
    const { db, clock, logger } = app.opt2;
    if (db === undefined) throw new Error(`${OWNER}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    const payloadValidators = new Map<string, TopicValidator>([[SURVEY_SCHEDULED_TOPIC, surveyScheduledValidator]]);
    const publisher = (held.publisher ??= createPublisher({
      projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
      emulatorHost,
      payloadValidators,
    }));
    const outbox = createOutbox({ service: OWNER, db, publisher, logger, clock, payloadValidators });

    const taskPort = (held.taskPort ??= await createSurveysTaskPort(env, { db, clock, logger }));

    // An injected throwaway pool names its own schema; the service's own pool names `surveys`.
    const repository = createSurveysRepository({ clock, schema: db.schema });
    // Must precede registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);

    await registerRoutes(app, { db, repository, clock, env });
    registerMigrationHandlers(app, { owner: OWNER, repository, mappings: MAPPINGS, units: UNITS, db });
    registerConsumers(app, { service: OWNER, consumers: [siteRegistryConsumerRegistration], publisher, db });
    registerOutboxSweep(app, { service: OWNER, port: taskPort, runtime: outbox, serviceUrls, clock });
    registerLaunchTaskRoute(app, { db, repository, clock });
    registerQueueControl(app, { port: taskPort, service: OWNER, serviceUrls, clock });

    app.addHook('onReady', async () => {
      await ensureOwnRecurring(taskPort, { service: OWNER, serviceUrls, clock });
    });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Closes a failed build's app with its task port and publisher, its service client and, when `ownsPool`, its pool; failures are logged. */
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
