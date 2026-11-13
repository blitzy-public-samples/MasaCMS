// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of the finance service. */
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
import { createStoragePort, type StoragePort } from '@opt2/platform/storage';
import { createPool, type TenantDb } from '@opt2/platform/tenancy';
import { consumers } from './events/consumers.js';
import { mappings, units } from './migration/mappings/index.js';
import { createExportObjects } from './migration/objects.js';
import { createFinanceRepository } from './repo/repository.js';
import { OWNER, SCHEMA } from './repo/tables.js';
import { registerRoutes, type FinanceDeps } from './routes/index.js';

/** Equals `info.version` of `contracts/openapi.yaml`. */
const VERSION = '1.0.0';

// Project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** Dependencies `buildApp` uses instead of building its own from the environment; an injected `db` needs an injected `stagingDb`. */
export interface BuildAppOptions {
  env?: BaseEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  /** Attachment staging ledger handle: a pool of its own on the schema of `db`. */
  stagingDb?: TenantDb;
  publisher?: EventPublisher;
  storage?: StoragePort;
}

/** Builds the finance Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  // The staging pool must reach the injected pool's database as its role, which only the caller that opened it knows.
  if (options.db !== undefined && options.stagingDb === undefined) {
    throw new TypeError('buildApp: an injected db needs an injected stagingDb');
  }
  const env = options.env ?? loadEnv(baseEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: OWNER,
    version: VERSION,
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });

  // Only what buildApp creates is closed with the app; injected instances belong to the caller.
  const owned: (() => Promise<void>)[] = [];
  app.addHook('onClose', async () => {
    await Promise.all(owned.map((close) => close()));
  });

  try {
    const db = options.db ?? app.opt2.db;
    if (db === undefined) throw new Error('finance requires a database');

    // Signs local URLs on the clock that the attachment file route verifies them with.
    const storage = options.storage ?? (await createStoragePort(env, { now: () => clock.now().getTime() }));

    let publisher = options.publisher;
    if (publisher === undefined) {
      const created = createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID, emulatorHost });
      owned.push(() => created.close());
      publisher = created;
    }

    let stagingDb = options.stagingDb;
    if (stagingDb === undefined) {
      const created = await openStagingDb(env);
      owned.push(() => created.end());
      stagingDb = created;
    }

    const repository = createFinanceRepository({ db, stagingDb, storage, clock });
    // Must precede the routes, so its onSend hook covers every write, and registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);

    const deps: FinanceDeps = { db, repository, storage, clock };
    await registerRoutes(app, deps);
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository,
      mappings,
      units,
      db,
      exportObjects: createExportObjects({ storage, repository }),
    });
    registerConsumers(app, { service: OWNER, consumers, publisher, db });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Opens the one-connection staging ledger pool on schema `finance` with the settings createService opened the service pool with. */
async function openStagingDb(env: BaseEnv): Promise<TenantDb> {
  const { OPT2_DB_AUTH, PG_DATABASE } = env;
  if (OPT2_DB_AUTH === undefined || PG_DATABASE === undefined) {
    throw new Error(`Schema ${SCHEMA} needs OPT2_DB_AUTH and PG_DATABASE`);
  }
  return createPool({ env: { ...env, OPT2_DB_AUTH, PG_DATABASE }, schema: SCHEMA, max: 1 });
}

/** Closes a failed build's app with its owned resources, its service client and, when `ownsPool`, its pool; failures are logged. */
async function closePartialApp(app: FastifyInstance, ownsPool: boolean): Promise<void> {
  const { client, db, logger } = app.opt2;
  for (const step of [() => app.close(), () => client.close(), () => (ownsPool ? db?.end() : undefined)]) {
    try {
      await step();
    } catch (err) {
      logger.error({ error: err instanceof Error ? err : new Error(String(err)) }, 'start-up cleanup failed');
    }
  }
}
