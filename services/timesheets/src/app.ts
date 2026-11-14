// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of the timesheets service. */
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
import { createConsumers } from './events/consumers.js';
import { PROGRAM_SITES, mappings, units } from './migration/mappings/index.js';
import { createTimesheetsRepository } from './repo/repository.js';
import { TIMESHEETS_SCHEMA } from './repo/tables.js';
import { registerRoutes } from './routes/index.js';

/** Service name: log `service`, repository and migration owner, and push-subscription prefix. */
export const SERVICE_NAME = 'timesheets';

/** Equals `info.version` of `contracts/openapi.yaml` and the version `src/main.ts` starts tracing with. */
export const SERVICE_VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Dependencies `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
}

/** Builds the timesheets Fastify app with every route and hook registered; never listens. */
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
    ...(options.db === undefined ? { schema: TIMESHEETS_SCHEMA } : { pool: options.db }),
  });
  const db = app.opt2.db;
  if (db === undefined) throw new Error(`${SERVICE_NAME} requires a database`);

  // An injected throwaway pool names its own schema; the service's own pool names `timesheets`.
  const repository = createTimesheetsRepository({ clock, schema: db.schema });

  const publisher = options.publisher ?? createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID, emulatorHost });
  // Only a publisher built here closes with the app; an injected one belongs to the caller.
  if (options.publisher === undefined) {
    app.addHook('onClose', async () => {
      await publisher.close();
    });
  }

  // Precedes the routes, so its onSend hook covers the root-level export read too; registerMigrationHandlers requires it.
  registerWritePositionHeader(app);
  registerRoutes(app, { db, repository, clock });
  registerMigrationHandlers(app, { owner: SERVICE_NAME, repository, mappings, units, db, programSiteId: (programId) => PROGRAM_SITES[programId] });
  registerConsumers(app, { service: SERVICE_NAME, consumers: createConsumers({ repository }), publisher, db });
  return app;
}
