// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of the e-signature service. */
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
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
import type { TenantDb } from '@opt2/platform/tenancy';
import { consumers } from './events/consumers.js';
import { createPeopleClient, type PeopleClient } from './legacy/people-client.js';
import { mappings, units } from './migration/mappings/index.js';
import { createEsignatureRepository } from './repo/repository.js';
import { OWNER, SCHEMA } from './repo/tables.js';
import { registerRoutes, type EsignatureDeps } from './routes/index.js';

/** Service name: log `service`, repository and migration owner, and push-subscription prefix. */
export const SERVICE_NAME = OWNER;

/** Equals `info.version` of `contracts/openapi.yaml` and the version `src/main.ts` starts tracing with. */
export const SERVICE_VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Dependencies `buildApp` uses instead of building its own from the environment; injected ones stay open when the app closes. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  peopleClient?: PeopleClient;
  /** Carries only the consumers' dead letters: e-signature produces no topic. */
  publisher?: EventPublisher;
}

/** Builds the e-signature Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(baseEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // api.cfm lower-cases the module, resource and action segments before dispatching, so the fixture routes match any case.
    legacyFixturePaths: true,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });

  // Only a publisher built here closes with the app; an injected one belongs to the caller.
  let ownedPublisher: EventPublisher | undefined;
  app.addHook('onClose', async () => {
    await ownedPublisher?.close();
  });

  try {
    const db = app.opt2.db;
    if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);

    const repository = createEsignatureRepository({ db, clock });
    const peopleClient = options.peopleClient ?? createPeopleClient({ client: app.opt2.client });
    const publisher =
      options.publisher ??
      (ownedPublisher = createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID, emulatorHost }));

    const deps: EsignatureDeps = { db, repository, clock, peopleClient };
    await registerRoutes(app, deps);
    // Fastify extends a root onSend hook to the route plugins registered before it. Must precede
    // registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);
    registerMigrationHandlers(app, { owner: OWNER, repository, mappings, units, db });
    registerConsumers(app, { service: SERVICE_NAME, consumers, publisher, db });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Closes a failed build's app with its owned publisher, its service client and, when `ownsPool`, its pool; failures are logged. */
async function closePartialApp(app: FastifyInstance, ownsPool: boolean): Promise<void> {
  const { client, db } = app.opt2;
  for (const step of [() => app.close(), () => client.close(), () => (ownsPool ? db?.end() : undefined)]) {
    try {
      await step();
    } catch (err) {
      // app.log is the service's log-record.v1 logger, whose `error` serializer takes any thrown value.
      app.log.error({ error: err }, 'start-up cleanup failed');
    }
  }
}
