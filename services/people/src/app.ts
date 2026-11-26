/** Composition root of the people service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import {
  baseEnvSchema,
  createService,
  loadEnv,
  processEnvSchema,
  publisherEmulatorHost,
  systemClock,
  z,
  type Clock,
  type CreateServiceOptions,
  type FastifyInstance,
  type LoadedEnv,
} from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createFaultHooks, FAULT_ENV, killStepOf, type FaultHooks } from './domain/faults.js';
import { expirePasswordsSetting } from './domain/password-expiry.js';
import { rosterOperationStatus } from './domain/roster-protocol.js';
import { rosterRecoveryHook } from './domain/roster-recovery.js';
import { peopleConsumerRegistrations } from './events/consumers.js';
import { createPeopleEvents } from './events/publish.js';
import { peoplePayloadValidators } from './events/topics.js';
import { createIdentityClient, type IdentityClient } from './legacy/identity-client.js';
import { PEOPLE_MAPPINGS } from './migration/mappings/index.js';
import { dropOwnerlessRows } from './migration/ownerless-rows.js';
import { SCHEMA, createPeopleRepository } from './repo/repository.js';
import { PEOPLE_UNITS } from './repo/tables.js';
import { favoritesSurfaceOf, favoritesTargetRefused, favoritesTemplateMissing } from './routes/favorites.js';
import { legacyApiPrefixes, legacyApiSettings, registerRoutes } from './routes/index.js';
import { createPeopleTaskPort, ensureStartupChains, registerQueueControlRoutes, registerSweep } from './tasks/port.js';

/** Service name of logs, invocation credentials, subscriptions and the outbox. */
export const SERVICE_NAME = 'people';

/** Equals `info.version` of `contracts/openapi.yaml`. */
export const SERVICE_VERSION = '1.0.0';

/** Services people calls through `OPT2_SERVICE_URLS`: itself (its outbox sweep's task target), identity and strategies-content. */
const CALLEES: readonly string[] = [SERVICE_NAME, 'identity', 'strategies-content'];

/** Base variables of the people process plus the Masa password-expiry setting and the roster fault step, with its own name, its database and every callee's URL required. */
export const peopleEnvSchema = processEnvSchema(
  baseEnvSchema.extend({
    // A blank or unevaluable value is 0, as configBean takes it, so no value fails start-up.
    MURA_EXPIREPASSWORDS: z.string().optional().transform(expirePasswordsSetting),
    // Fault suites only; a value naming another package's fault leaves no kill step.
    [FAULT_ENV]: z.string().optional().transform(killStepOf),
  }),
  { service: SERVICE_NAME, callees: CALLEES, database: true },
);

/** Parsed environment of the people process. */
export type PeopleEnv = LoadedEnv<typeof peopleEnvSchema>;

// Default project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: PeopleEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
  identityClient?: IdentityClient;
  faults?: FaultHooks;
}

/** Builds the people Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(peopleEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  // contentServer.cfc matches these leads with CFML's case-insensitive `eq`; the context comes from Masa's `MURA_<KEY>` variables, as the routes read it.
  const noCasePathPrefixes = legacyApiPrefixes(legacyApiSettings(process.env).context);
  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    noCasePathPrefixes,
    surfaceOf: favoritesSurfaceOf,
    containerRefusesTarget: favoritesTargetRefused,
    skipsStartupScan: favoritesTemplateMissing,
    // api.cfm lower-cases the module, resource and action segments before dispatching, so the archive route matches any case.
    legacyFixturePaths: true,
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
    const { db, logger, client } = app.opt2;
    if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);
    const serviceUrls = env.OPT2_SERVICE_URLS;

    const payloadValidators = new Map(Object.entries(peoplePayloadValidators));
    const publisher =
      options.publisher ??
      (owned.publisher = createPublisher({
        projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID,
        emulatorHost,
        payloadValidators,
      }));
    createOutbox({ service: SERVICE_NAME, db, publisher, logger, clock, payloadValidators });

    const port = options.taskPort ?? (owned.taskPort = await createPeopleTaskPort(env, { db, clock, logger }));

    // An injected throwaway pool names its own schema; the service's own pool names `people`.
    const repository = createPeopleRepository({ clock, schema: db.schema });
    const events = createPeopleEvents(repository);
    const identity = options.identityClient ?? createIdentityClient(client);
    const faults = options.faults ?? createFaultHooks({}, { killStep: env[FAULT_ENV] });
    registerWritePositionHeader(app);

    await registerRoutes(app, { repository, events, db, clock, logger, client, identity, env, faults, expirePasswords: env.MURA_EXPIREPASSWORDS });
    registerMigrationHandlers(app, {
      owner: SERVICE_NAME,
      repository: repository.base,
      mappings: PEOPLE_MAPPINGS,
      units: PEOPLE_UNITS,
      db,
      // The person's ownerless rows go first, so an event the platform withholds cannot skip them.
      emitStateEvents: async (tx, change, write) => {
        await dropOwnerlessRows(repository, tx, change, write);
        await events.emitStateEvents(tx, change, write);
      },
      targetOnlyColumns: events.targetOnlyColumns,
      operationStatus: rosterOperationStatus,
    });
    registerConsumers(app, { service: SERVICE_NAME, consumers: peopleConsumerRegistrations(repository), publisher, db });
    registerSweep(app, { port, serviceUrls, clock, recoveryHooks: [rosterRecoveryHook({ db, repo: repository, events, identity })] });
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
