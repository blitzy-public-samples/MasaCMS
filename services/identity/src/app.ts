/** Composition root of the identity service. */
import { createPublisher, readTopicSchema, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  baseEnvSchema,
  createService,
  loadEnv,
  publisherEmulatorHost,
  systemClock,
  type Clock,
  type CreateServiceOptions,
  type FastifyInstance,
  type LoadedEnv,
} from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import { tenantRegistryConsumer, type TenantDb } from '@opt2/platform/tenancy';
import { operationStatus } from './domain/account-operations.js';
import { createTokenService, type IdentityPlatformAdapter, type TokenSigner } from './domain/tokens.js';
import { personContactRegistration } from './events/person-contact.js';
import { createIdentityEvents, identityPayloadValidators } from './events/publish.js';
import { mappings } from './migration/mappings/index.js';
import { SCHEMA, createIdentityRepository } from './repo/repository.js';
import { IDENTITY_UNITS } from './repo/tables.js';
import { legacyApiPrefixes, legacyApiSettings, registerRoutes } from './routes/index.js';
import { createIdentityTaskPort, ensureStartupChains, registerQueueControlRoutes, registerSweep } from './tasks/port.js';

/** Service name of logs, invocation credentials, subscriptions and the outbox. */
export const SERVICE_NAME = 'identity';

/** Equals `info.version` of `contracts/openapi.yaml`. */
export const SERVICE_VERSION = '1.0.0';

/** Identity reads only the base variables; `OPT2_ENV=cloud` with `GOOGLE_CLOUD_PROJECT` selects Identity Platform issuance. */
export const identityEnvSchema = baseEnvSchema;

/** Parsed environment of the identity process. */
export type IdentityEnv = LoadedEnv<typeof identityEnvSchema>;

// Default project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Payload schema of `programs-sites.site.changed.v1`, read once from the producer's contracts. */
const siteChangedSchema = readTopicSchema(
  new URL('../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: IdentityEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
  /** Cloud token adapter; the cloud token service requires one. */
  identityPlatform?: IdentityPlatformAdapter;
  /** Local RS256 signer; defaults to the key pair in `OPT2_STATE_DIR`. */
  signer?: TokenSigner;
}

/** Builds the identity Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(identityEnvSchema);
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  // Read from the process environment like the route registry, which carries Masa's `MURA_<KEY>` configuration.
  const noCasePathPrefixes = legacyApiPrefixes(legacyApiSettings(process.env).context);
  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock: options.clock ?? systemClock,
    verifierOverride: options.verifierOverride,
    noCasePathPrefixes,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
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
    const { db, clock, logger, client } = app.opt2;
    if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    const payloadValidators = new Map(Object.entries(identityPayloadValidators));
    const publisher =
      options.publisher ??
      (owned.publisher = createPublisher({
        projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
        emulatorHost,
        payloadValidators,
      }));
    createOutbox({ service: SERVICE_NAME, db, publisher, logger, clock, payloadValidators });

    const port = options.taskPort ?? (owned.taskPort = await createIdentityTaskPort(env, { db, clock, logger }));

    // An injected throwaway pool names its own schema; the service's own pool names `identity`.
    const repository = createIdentityRepository({ clock, schema: db.schema });
    // Must precede registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);

    const tokens = createTokenService({
      env,
      clock,
      db,
      repo: repository,
      signer: options.signer,
      identityPlatform: options.identityPlatform,
    });
    await registerRoutes(app, { repository, db, clock, client, tokens });
    registerMigrationHandlers(app, {
      owner: SERVICE_NAME,
      repository: repository.base,
      mappings,
      units: IDENTITY_UNITS,
      db,
      emitStateEvents: createIdentityEvents(repository).emitStateEvents,
      operationStatus,
    });
    registerConsumers(app, {
      service: SERVICE_NAME,
      consumers: [{ consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema }, personContactRegistration(repository)],
      publisher,
      db,
    });
    registerSweep(app, { port, serviceUrls, clock });
    registerQueueControlRoutes(app, { port, serviceUrls, clock });

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
