// Connections and clients shared by the migration service and the `opt2-migrate` commands, wired once.
import {
  createCloudInvocationMinter,
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  type InvocationMinter,
  type LocalSigningKeys,
} from '@opt2/platform/auth';
import { createLogger, serializeError, type Logger } from '@opt2/platform/logging';
import { createServiceClient, systemClock, type Clock, type ServiceClient } from '@opt2/platform/service-kit';
import { createPool, type TenantDb } from '@opt2/platform/tenancy';

import { loadConfig } from './config.js';
import { createGatewayClient, type GatewayClient } from './cutover/gateway-client.js';
import { assertSqlServerSource, loadMigrationEnv, type MigrationEnv } from './env.js';
import { createBridgeClient, type BridgeClient } from './legacy/bridge.js';
import { createLegacyDb, type LegacyDb } from './legacy/legacy-db.js';
import { createOwnersClient, type OwnersClient } from './owners/client.js';
import { loadUnitCatalog, type UnitCatalog } from './owners/units.js';

const SERVICE_NAME = 'migration';
const SERVICE_VERSION = '1.0.0';
const MIGRATION_SCHEMA = 'migration';

/** Workload identity a service client calls as: `migration` holds `platform.migration`, `operator` holds `platform.operator`. */
export type ServiceCaller = 'migration' | 'operator';

/** Connections and clients shared by the migration service and the `opt2-migrate` commands. */
export interface MigrationContext {
  readonly env: MigrationEnv;
  readonly config: ReturnType<typeof loadConfig>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Pool of the `migration` schema only; its coordination tables are non-tenant, so it is used through `withMetadata`. */
  readonly db: TenantDb;
  readonly legacy: LegacyDb;
  readonly bridge: BridgeClient;
  readonly catalog: UnitCatalog;
  readonly owners: OwnersClient;
  readonly gateway: GatewayClient;
  /** Service client calling as `migration`. */
  readonly client: ServiceClient;
  /** Service client calling as `caller`, one per caller; `migration` returns `client`. @throws Error once the context is closed. */
  clientAs(caller: ServiceCaller): ServiceClient;
  /** Closes the resources this context created, newest first; injected ports stay open. Repeated calls share one close. */
  close(): Promise<void>;
}

/** Ports used instead of the ones the context would create, for example fakes in tests. */
export interface CreateContextOptions {
  env?: MigrationEnv;
  clock?: Clock;
  logger?: Logger;
  /** Pool of the `migration` schema. */
  db?: TenantDb;
  legacy?: LegacyDb;
  bridge?: BridgeClient;
  catalog?: UnitCatalog;
  owners?: OwnersClient;
  gateway?: GatewayClient;
  /** Service client calling as `migration`. */
  client?: ServiceClient;
}

/** Callee URLs: `OPT2_SERVICE_URLS` plus the gateway and the running migration service, as service-kit's own client resolves them. */
function serviceUrlsOf(env: MigrationEnv): Record<string, string> {
  return {
    ...env.OPT2_SERVICE_URLS,
    ...(env.OPT2_GATEWAY_URL === undefined ? {} : { gateway: env.OPT2_GATEWAY_URL }),
    ...(env.OPT2_MIGRATION_URL === undefined ? {} : { migration: env.OPT2_MIGRATION_URL }),
  };
}

/** Invocation minter per caller: local service tokens signed with the state-directory key pair, or Google ID tokens in the cloud. */
function invocationMinters(env: MigrationEnv): (caller: ServiceCaller) => InvocationMinter {
  if (env.OPT2_ENV === 'cloud') {
    // The cloud credential is this process's service account whatever the caller, so operator calls need an operator account.
    const cloud = createCloudInvocationMinter();
    return () => cloud;
  }
  // Keys load at the first call, so building a context reads no secret; a failed load is not cached.
  let keys: Promise<LocalSigningKeys> | undefined;
  const signingKeys = (): Promise<LocalSigningKeys> =>
    (keys ??= loadLocalSigningKeys(env.OPT2_STATE_DIR, { requirePrivate: true }).catch((error: unknown) => {
      keys = undefined;
      throw error;
    }));
  return (caller) => ({
    async headersFor(target, opts) {
      return createLocalInvocationMinter({ keys: await signingKeys(), caller }).headersFor(target, opts);
    },
  });
}

/** Opens the `migration` schema pool with the environment's database settings. */
async function openMigrationPool(env: MigrationEnv, logger: Logger): Promise<TenantDb> {
  const { OPT2_DB_AUTH, PG_DATABASE } = env;
  if (OPT2_DB_AUTH === undefined || PG_DATABASE === undefined) {
    throw new Error(`Schema ${MIGRATION_SCHEMA} needs OPT2_DB_AUTH and PG_DATABASE`);
  }
  return createPool({
    env: { ...env, OPT2_DB_AUTH, PG_DATABASE },
    schema: MIGRATION_SCHEMA,
    onError: (error) => logger.error({ error: serializeError(error) }, 'database pool error'),
  });
}

/** Runs every closer, newest first; one failure is rethrown as is, several as an AggregateError. */
async function closeAll(closers: (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Closing the migration context failed');
}

/**
 * Builds the context from the environment, creating every port `options` does not supply; SQL Server pools and local signing keys open on first use.
 * @throws UnsupportedLegacyDatabaseError when the legacy database is not SQL Server.
 */
export async function createMigrationContext(options: CreateContextOptions = {}): Promise<MigrationContext> {
  const env = options.env ?? loadMigrationEnv();
  assertSqlServerSource(env);
  const config = loadConfig();
  const catalog = options.catalog ?? loadUnitCatalog(config.paths.tableOwnership);
  const clock = options.clock ?? systemClock;
  // stderr, so the stdout of an `opt2-migrate` command carries only its JSON summary line.
  const logger =
    options.logger ??
    createLogger({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      env: env.OPT2_ENV,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      destination: process.stderr,
    });

  const closers: (() => Promise<void>)[] = [];
  const own = <T>(resource: T, close: (resource: T) => Promise<void>): T => {
    closers.push(() => close(resource));
    return resource;
  };
  let closing: Promise<void> | undefined;

  try {
    const db = options.db ?? own(await openMigrationPool(env, logger), (pool) => pool.end());
    if (db.schema !== MIGRATION_SCHEMA) {
      throw new TypeError(`The migration context needs the ${MIGRATION_SCHEMA} schema pool, got ${db.schema}`);
    }

    const minterFor = invocationMinters(env);
    const serviceUrls = serviceUrlsOf(env);
    const newClient = (caller: ServiceCaller): ServiceClient =>
      own(createServiceClient({ serviceUrls, self: caller, credentials: minterFor(caller) }), (created) => created.close());
    const client = options.client ?? newClient('migration');
    const clients = new Map<ServiceCaller, ServiceClient>([['migration', client]]);
    const clientAs = (caller: ServiceCaller): ServiceClient => {
      if (closing !== undefined) throw new Error('The migration context is closed');
      let found = clients.get(caller);
      if (found === undefined) {
        found = newClient(caller);
        clients.set(caller, found);
      }
      return found;
    };

    const legacy = options.legacy ?? own(createLegacyDb(env), (created) => created.close());
    const bridge = options.bridge ?? createBridgeClient({ origin: env.LEGACY_ORIGIN, key: env.OPT2_BRIDGE_HMAC_KEY });
    const owners = options.owners ?? createOwnersClient({ client, catalog });
    const gateway =
      options.gateway ?? createGatewayClient({ migrationClient: client, operatorClient: clientAs('operator'), clock });

    return Object.freeze({
      env,
      config,
      clock,
      logger,
      db,
      legacy,
      bridge,
      catalog,
      owners,
      gateway,
      client,
      clientAs,
      close: () => (closing ??= closeAll(closers)),
    });
  } catch (error) {
    try {
      await closeAll(closers);
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Creating the migration context failed and closing what it opened failed');
    }
    throw error;
  }
}
