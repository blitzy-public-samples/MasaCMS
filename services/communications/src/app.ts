// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { AuthOverrides } from '@opt2/platform/auth';
import { createPublisher, registerConsumers, type EventPublisher, type TopicValidator } from '@opt2/platform/events';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox, registerOutboxSweep } from '@opt2/platform/outbox';
import {
  baseEnvSchema,
  createService,
  envPort,
  envUrl,
  loadEnv,
  publisherEmulatorHost,
  requiredEnvString,
  systemClock,
  type Clock,
  type FastifyInstance,
  type LoadedEnv,
} from '@opt2/platform/service-kit';
import { ensureOwnRecurring, registerQueueControl, type TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createMailpitDeliveryStatus, type DeliveryStatusSource } from './domain/delivery-status.js';
import { loginMailRecovery } from './domain/login-mail.js';
import { createSmtpTransport, type MailTransport } from './domain/mail-transport.js';
import { createSenderAddressSource, type SenderAddressSource } from './domain/sender-address.js';
import { scheduledTaskRecovery } from './domain/survey-schedule.js';
import { buildConsumers } from './events/consumers.js';
import { DELIVERY_STATUS_CHANGED_TOPIC, deliveryStatusChangedValidator } from './events/delivery-status-changed.js';
import { MAPPINGS } from './migration/mappings/index.js';
import { OWNER, SCHEMA, createCommunicationsRepository } from './repo/repository.js';
import { UNITS } from './repo/tables.js';
import { registerRoutes } from './routes/index.js';
import { createCommunicationsTaskPort } from './tasks/port.js';
import { registerReminderTaskRoute } from './tasks/reminder.js';

/** Name of the service in logs, outbox rows, push subscriptions and its sweep queue. */
export const SERVICE_NAME = OWNER;

/** Equals `info.version` of `contracts/openapi.yaml`. */
export const SERVICE_VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Base variables plus the SMTP relay address and the Mailpit API origin of delivery confirmation. */
export const communicationsEnvSchema = baseEnvSchema.extend({
  SMTP_HOST: requiredEnvString(),
  SMTP_PORT: envPort(),
  MAILPIT_API_URL: envUrl(),
});

// LoadedEnv rather than z.infer: createService and the route deps need the adapter choices loadEnv always sets.
/** Parsed communications environment, as `loadEnv(communicationsEnvSchema)` returns it. */
export type CommunicationsEnv = Readonly<LoadedEnv<typeof communicationsEnvSchema>>;

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: CommunicationsEnv;
  clock?: Clock;
  verifierOverride?: AuthOverrides;
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
  mailTransport?: MailTransport;
  deliveryStatus?: DeliveryStatusSource;
  senderAddress?: SenderAddressSource;
}

/** Builds the communications Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(communicationsEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });
  const { db, logger } = app.opt2;
  if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);
  const serviceUrls = env.OPT2_SERVICE_URLS;

  const payloadValidators = new Map<string, TopicValidator>([
    [DELIVERY_STATUS_CHANGED_TOPIC, deliveryStatusChangedValidator],
  ]);
  const publisher =
    options.publisher ??
    createPublisher({
      projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
      emulatorHost,
      payloadValidators,
    });
  const outbox = createOutbox({ service: SERVICE_NAME, db, publisher, logger, clock, payloadValidators });

  const taskPort = options.taskPort ?? (await createCommunicationsTaskPort(env, { db, clock, logger }));

  // An injected throwaway pool names its own schema; the service's own pool names `communications`.
  const repository = createCommunicationsRepository({ clock, schema: db.schema });
  // No SMTP credential: the environment carries only the relay address, and local Mailpit takes no AUTH.
  const mail = options.mailTransport ?? createSmtpTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT });
  const deliveryStatus = options.deliveryStatus ?? createMailpitDeliveryStatus({ baseUrl: env.MAILPIT_API_URL });
  const senderAddress = options.senderAddress ?? createSenderAddressSource({ db });

  // Must precede the routes, so its onSend hook covers every write, and registerMigrationHandlers, which refuses to register without it.
  registerWritePositionHeader(app);

  await registerRoutes(app, { db, repository, clock, env, mail, deliveryStatus, senderAddress, taskPort });
  registerMigrationHandlers(app, { owner: OWNER, repository, mappings: MAPPINGS, units: UNITS, db });
  registerConsumers(app, {
    service: SERVICE_NAME,
    consumers: buildConsumers({ db, repository, mail, deliveryStatus, senderAddress, taskPort, clock, env, logger }),
    publisher,
    db,
  });
  registerOutboxSweep(app, {
    service: SERVICE_NAME,
    port: taskPort,
    runtime: outbox,
    serviceUrls,
    clock,
    recoveryHooks: [
      loginMailRecovery({ db, repository, clock, logger, transport: mail, deliveryStatus, senderAddress }),
      scheduledTaskRecovery({ db, repository, clock, logger, taskPort, serviceUrls }),
    ],
  });
  registerReminderTaskRoute(app, { db, repository, clock });
  registerQueueControl(app, { port: taskPort, service: SERVICE_NAME, serviceUrls, clock });

  app.addHook('onReady', async () => {
    await ensureOwnRecurring(taskPort, { service: SERVICE_NAME, serviceUrls, clock });
  });
  // The task port, publisher and mail transport close with the app whether built here or injected; the pool is service-kit's.
  app.addHook('onClose', async () => {
    try {
      await taskPort.close();
    } finally {
      try {
        await publisher.close();
      } finally {
        await mail.close();
      }
    }
  });
  return app;
}
