// The one test composition of a MigrationContext: the real createMigrationContext over in-process doubles of SQL Server,
// the bridge, the owners, the gateway and the service mesh, with config paths and reports under temporary directories.
import path from 'node:path';

import { createLogger, type Logger } from '@opt2/platform/logging';
import {
  UnknownServiceError,
  systemClock,
  type Clock,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { MetadataTx, QueryConfig, TenantDb, TenantTx, TxBase } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, rewriteMigrationSql, type ThrowawaySchema } from '@opt2/platform/testing';

import type { LoadedMigrationConfig, ResolvedPaths } from '../../src/config.js';
import { createMigrationContext, type MigrationContext, type ServiceCaller } from '../../src/context.js';
import { createBridgeClient } from '../../src/legacy/bridge.js';
import type { OwnersClient } from '../../src/owners/client.js';
import type { UnitCatalog } from '../../src/owners/units.js';
import { migrationsDirFor } from '../../src/paths.js';

import { startBridgeDouble, type BridgeDouble, type BridgeDoubleOptions } from './bridge-double.js';
import {
  TEST_BRIDGE_KEY,
  createControlledSleep,
  createMutableClock,
  createTestDirs,
  testEnv,
  type ControlledSleep,
  type MutableClock,
  type TestDirs,
} from './env.js';
import { createFakeLegacyDb, type FakeLegacyDb } from './fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  seedFakeLegacy,
  writeCutoverDir,
  writeInventoryFile,
  writeOwnershipFile,
  type FixtureCutoverDir,
  type SeedFakeLegacyOptions,
  type WriteCutoverDirOptions,
} from './fixtures.js';
import { createCallLog, createGatewayDouble, type CallLog, type GatewayDouble, type GatewayDoubleOptions } from './gateway-double.js';
import { createOwnerDoubles, type OwnerDoubles } from './owner-double.js';

/** Schema name the migration code and `createMigrationContext` require of the context's pool. */
const MIGRATION_SCHEMA = 'migration';

/** Workload the routed client calls as unless a caller view is taken. */
const MIGRATION_CALLER: ServiceCaller = 'migration';

/** `POST /internal/v1/task-queues/<queue>/<op>`, the queue-control route of `@opt2/platform/tasks`. */
const QUEUE_CONTROL_ROUTE = /^\/internal\/v1\/task-queues\/(?<queue>[^/]+)\/(?<op>pause|resume|ensure)$/;

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'content-type': 'application/json' });

// ---------------------------------------------------------------------------------------------------------------------
// Routed service client

/** Answers one call a suite routes to a callee. */
export type ServiceHandler = (req: ServiceRequest) => Promise<ServiceResponse<unknown>> | ServiceResponse<unknown>;

/** A call the routed client received, with the workload that made it. */
export interface RoutedServiceCall extends ServiceRequest {
  caller: string;
}

/** Options of {@link createRoutedServiceClient}. */
export interface RoutedServiceClientOptions {
  /** Receives `client:<service>` / `<METHOD> <path>` for every call. */
  log?: CallLog;
  /** Clock of the slot named in default `ensure` answers; the system clock by default. */
  clock?: Clock;
}

/** A service client calling as `migration` that dispatches each call by callee, recording every caller view's calls. */
export interface RoutedServiceClient extends ServiceClient {
  /** Calls of every caller view, in call order. */
  readonly calls: RoutedServiceCall[];
  /** The same router calling as `caller`; `migration` returns this client. */
  as(caller: string): ServiceClient;
}

/** The 200 a creator's queue-control route answers, for a callee no handler serves; undefined for any other call. */
function queueControlAnswer(req: ServiceRequest, clock: Clock): ServiceResponse<unknown> | undefined {
  const groups = req.method === 'POST' ? QUEUE_CONTROL_ROUTE.exec(req.path)?.groups : undefined;
  if (groups?.queue === undefined || groups.op === undefined) return undefined;
  const queue = decodeURIComponent(groups.queue);
  const { service } = req;
  const slot = `${queue}-${String(Math.floor(clock.now().getTime() / 1000))}`;
  const body =
    groups.op === 'ensure'
      ? { queue, service, ensured: { queue, name: slot, created: false, reason: 'live' } }
      : groups.op === 'pause'
        ? { queue, service, paused: true, running: 0 }
        : { queue, service, paused: false };
  return { status: 200, headers: { ...JSON_HEADERS }, body };
}

/**
 * A {@link RoutedServiceClient} over `handlers` keyed by callee; queue-control calls to a callee without a handler answer 200.
 * @throws UnknownServiceError (rejected) for any other call to a callee without a handler.
 */
export function createRoutedServiceClient(
  handlers: Readonly<Record<string, ServiceHandler>>,
  opts: RoutedServiceClientOptions = {},
): RoutedServiceClient {
  const clock = opts.clock ?? systemClock;
  const calls: RoutedServiceCall[] = [];
  const views = new Map<string, ServiceClient>();

  const send = async (caller: string, req: ServiceRequest): Promise<ServiceResponse<unknown>> => {
    calls.push({ ...req, caller });
    opts.log?.append(`client:${req.service}`, `${req.method} ${req.path}`, { caller });
    const handler = Object.hasOwn(handlers, req.service) ? handlers[req.service] : undefined;
    const answer = handler === undefined ? queueControlAnswer(req, clock) : await handler(req);
    if (answer === undefined) throw new UnknownServiceError(req.service);
    return answer;
  };

  const viewOf = (caller: string): ServiceClient => ({
    request: <T>(req: ServiceRequest) => send(caller, req) as Promise<ServiceResponse<T>>,
    close: () => Promise.resolve(),
  });

  const router: RoutedServiceClient = {
    calls,
    request: <T>(req: ServiceRequest) => send(MIGRATION_CALLER, req) as Promise<ServiceResponse<T>>,
    close: () => Promise.resolve(),
    as(caller) {
      if (caller === MIGRATION_CALLER) return router;
      let view = views.get(caller);
      if (view === undefined) {
        view = viewOf(caller);
        views.set(caller, view);
      }
      return view;
    },
  };
  return router;
}

// ---------------------------------------------------------------------------------------------------------------------
// The `migration` schema

/** Skip reason of the suites whose context needs the `migration` schema on PostgreSQL. */
export const MIGRATION_SCHEMA_SKIP_REASON = 'PostgreSQL unavailable: set PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE';

/** A migrated throwaway `migration` schema. */
export interface MigrationSchemaHandle {
  /** Pool named `migration` whose statements run against the throwaway schema. */
  db: TenantDb;
  /** Physical name of the throwaway schema. */
  schema: string;
  /** Ends the pools and drops the schema and its roles; repeated calls share one drop. */
  drop(): Promise<void>;
}

/**
 * The throwaway app pool as the `migration` pool createMigrationContext requires (it rejects `app`, named after the
 * throwaway schema): statements naming `migration.` or `tx.schema` are rewritten to the throwaway schema, as its migrations were.
 */
function migrationNamedDb(throwaway: ThrowawaySchema): TenantDb {
  const rewrite = (sql: string): string => rewriteMigrationSql(sql, MIGRATION_SCHEMA, throwaway.schema, throwaway.roles);
  const rewritingQuery = (tx: TxBase): TxBase['query'] =>
    ((text: string | QueryConfig, values?: unknown[]) =>
      tx.query(typeof text === 'string' ? rewrite(text) : { ...text, text: rewrite(text.text) }, values)) as TxBase['query'];
  const bindTenant = (tx: TenantTx): TenantTx => Object.freeze({ ...tx, schema: MIGRATION_SCHEMA, query: rewritingQuery(tx) });
  const bindMetadata = (tx: MetadataTx): MetadataTx => Object.freeze({ ...tx, schema: MIGRATION_SCHEMA, query: rewritingQuery(tx) });
  return Object.freeze({
    schema: MIGRATION_SCHEMA,
    withTenant: (tenantId, fn, options) => throwaway.app.withTenant(tenantId, (tx) => fn(bindTenant(tx)), options),
    withMetadata: (fn, options) => throwaway.app.withMetadata((tx) => fn(bindMetadata(tx)), options),
    // drop() ends the pools.
    end: () => Promise.resolve(),
  } satisfies TenantDb);
}

/** A throwaway schema migrated with `migration/db/migrations`, or null when the `PG_*` server is unreachable. */
export async function withMigrationSchema(): Promise<MigrationSchemaHandle | null> {
  if (!(await pgAvailable())) return null;
  const throwaway = await createThrowawaySchema({ service: MIGRATION_SCHEMA, migrationsDir: migrationsDirFor('migration') });
  return { db: migrationNamedDb(throwaway), schema: throwaway.schema, drop: throwaway.drop };
}

/** The `migration` pool of a context built without a schema: every transaction rejects, so no suite reaches PostgreSQL unasked. */
function absentMigrationDb(): TenantDb {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error('This test context has no migration schema: build it with migrationDb: true or a TenantDb'));
  return Object.freeze({ schema: MIGRATION_SCHEMA, withTenant: refuse, withMetadata: refuse, end: () => Promise.resolve() });
}

// ---------------------------------------------------------------------------------------------------------------------
// Test context

/** Doubles and settings of {@link buildTestContext}; every one defaults to a fresh in-process double. */
export interface TestContextOptions {
  /** Raw variables over {@link testEnv}'s defaults; `undefined` removes one. */
  env?: Partial<Record<string, string>>;
  clock?: MutableClock;
  legacy?: FakeLegacyDb;
  /** Seeds the fake legacy database with `seedFakeLegacy`, with these options when an object. */
  legacySeed?: boolean | SeedFakeLegacyOptions;
  /** Settings of the bridge double; `false` starts none and leaves the bridge client on a closed loopback port. */
  bridge?: BridgeDoubleOptions | false;
  /** Owner doubles over the catalog (the default), or an owners client such as `PgOwner.ownersClient`. */
  owners?: 'doubles' | OwnersClient;
  /** Owners the doubles cover; every owner of the catalog's units by default. */
  ownerNames?: string[];
  gateway?: GatewayDoubleOptions;
  /** `true` migrates a throwaway `migration` schema; a TenantDb named `migration` is used as given. */
  migrationDb?: boolean | TenantDb;
  /** Cut-over files written for the context; under its state directory by default. */
  cutover?: WriteCutoverDirOptions;
  /** Unit catalog of the context and the owner doubles; `FIXTURE_CATALOG` by default. */
  catalog?: UnitCatalog;
  /** Handlers of the routed service client by callee name. */
  serviceHandlers?: Record<string, ServiceHandler>;
}

/** A built context and the doubles behind it. */
export interface TestContext {
  /** The real context, with config paths under the temp directories and `clientAs` answered by the routed client. */
  ctx: MigrationContext;
  legacy: FakeLegacyDb;
  bridge: BridgeDouble | null;
  gateway: GatewayDouble;
  /** Null when an owners client was supplied. */
  owners: OwnerDoubles | null;
  clock: MutableClock;
  sleep: ControlledSleep;
  dirs: TestDirs;
  /** Call log shared by every double and the routed client. */
  log: CallLog;
  cutover: { cutoverDir: string; groupsFile: string };
  client: ReturnType<typeof createRoutedServiceClient>;
  /** The schema this context migrated; null without one or when a TenantDb was supplied. */
  migrationSchema: MigrationSchemaHandle | null;
  /** Closes the context, the bridge double and the owned schema, then removes the temp directories; idempotent. */
  close(): Promise<void>;
}

/** Resources a test context opened, closed in field order. */
interface Opened {
  ctx?: MigrationContext;
  bridge?: BridgeDouble;
  schema?: MigrationSchemaHandle;
  cutover?: FixtureCutoverDir;
  dirs: TestDirs;
}

/** Closes every opened resource in order; one failure is rethrown as is, several as an AggregateError. */
async function closeOpened(opened: Opened): Promise<void> {
  const { ctx, bridge, schema, cutover, dirs } = opened;
  const steps = [
    ctx && (() => ctx.close()),
    bridge && (() => bridge.close()),
    schema && (() => schema.drop()),
    cutover && (() => cutover.cleanup()),
    () => dirs.cleanup(),
  ];
  const failures: unknown[] = [];
  for (const step of steps) {
    if (step === undefined) continue;
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Closing the test context failed');
}

/** A logger that writes nothing. */
function silentLogger(): Logger {
  return createLogger({ service: MIGRATION_SCHEMA, version: '1.0.0', env: 'local', level: 'silent', destination: { write: () => undefined } });
}

/** `config` with the given resolved paths replaced. */
function withPaths(config: LoadedMigrationConfig, paths: Partial<ResolvedPaths>): LoadedMigrationConfig {
  return Object.freeze({ ...config, paths: Object.freeze({ ...config.paths, ...paths }) });
}

/**
 * Builds a context through `createMigrationContext` with every external dependency an in-process double, cut-over,
 * ownership, inventory and reports paths under fresh temp directories, and no database unless `migrationDb` asks for one.
 * @throws Error with message {@link MIGRATION_SCHEMA_SKIP_REASON} when `migrationDb: true` and PostgreSQL is unreachable.
 */
export async function buildTestContext(opts: TestContextOptions = {}): Promise<TestContext> {
  const opened: Opened = { dirs: await createTestDirs() };
  const { dirs } = opened;
  try {
    const log = createCallLog();
    const clock = opts.clock ?? createMutableClock();
    const sleep = createControlledSleep(clock);
    const legacy = opts.legacy ?? createFakeLegacyDb();
    if (opts.legacySeed !== undefined && opts.legacySeed !== false) {
      seedFakeLegacy(legacy, opts.legacySeed === true ? {} : opts.legacySeed);
    }

    const bridgeOptions = opts.bridge === false ? undefined : opts.bridge;
    const bridge = opts.bridge === false ? null : await startBridgeDouble({ clock, log, ...bridgeOptions });
    if (bridge !== null) opened.bridge = bridge;
    const gateway = createGatewayDouble({ log, ...opts.gateway });
    const catalog = opts.catalog ?? FIXTURE_CATALOG;

    let owners: OwnerDoubles | null = null;
    let ownersClient: OwnersClient;
    if (opts.owners === undefined || opts.owners === 'doubles') {
      owners = createOwnerDoubles(catalog, { owners: opts.ownerNames, log, sleep: sleep.sleep, clock });
      ownersClient = owners.client;
    } else {
      ownersClient = opts.owners;
    }

    const cutover = await writeCutoverDir({ dir: path.join(dirs.stateDir, 'cutover'), ...opts.cutover });
    opened.cutover = cutover;
    const opt2Dir = path.join(dirs.stateDir, 'opt2');
    const [tableOwnership, inventory] = await Promise.all([writeOwnershipFile(opt2Dir), writeInventoryFile(opt2Dir)]);
    const env = testEnv({
      dirs,
      bridgeOrigin: bridge?.origin,
      OPT2_BRIDGE_HMAC_KEY: bridgeOptions?.key ?? TEST_BRIDGE_KEY,
      ...opts.env,
    });

    let migrationSchema: MigrationSchemaHandle | null = null;
    let db: TenantDb;
    if (opts.migrationDb === true) {
      migrationSchema = await withMigrationSchema();
      if (migrationSchema === null) throw new Error(MIGRATION_SCHEMA_SKIP_REASON);
      opened.schema = migrationSchema;
      db = migrationSchema.db;
    } else {
      db = opts.migrationDb === undefined || opts.migrationDb === false ? absentMigrationDb() : opts.migrationDb;
    }

    const client = createRoutedServiceClient(opts.serviceHandlers ?? {}, { log, clock });
    const base = await createMigrationContext({
      env,
      clock,
      logger: silentLogger(),
      db,
      legacy,
      bridge: createBridgeClient({ origin: bridge?.origin ?? env.LEGACY_ORIGIN, key: env.OPT2_BRIDGE_HMAC_KEY }),
      catalog,
      owners: ownersClient,
      gateway,
      client,
    });
    let contextClosed = false;
    // The real clientAs would open HTTP clients that mint local credentials; every caller goes through the router instead.
    const ctx: MigrationContext = Object.freeze({
      ...base,
      config: withPaths(base.config, {
        cutoverDir: cutover.cutoverDir,
        groupsFile: cutover.groupsFile,
        tableOwnership,
        inventory,
        reportsDir: dirs.reportsDir,
      }),
      clientAs(caller: ServiceCaller): ServiceClient {
        if (contextClosed) throw new Error('The migration context is closed');
        return client.as(caller);
      },
      close() {
        contextClosed = true;
        return base.close();
      },
    });
    opened.ctx = ctx;

    let closing: Promise<void> | undefined;
    return {
      ctx,
      legacy,
      bridge,
      gateway,
      owners,
      clock,
      sleep,
      dirs,
      log,
      cutover: { cutoverDir: cutover.cutoverDir, groupsFile: cutover.groupsFile },
      client,
      migrationSchema,
      close: () => (closing ??= closeOpened(opened)),
    };
  } catch (error) {
    try {
      await closeOpened(opened);
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Building the test context failed and closing what it opened failed');
    }
    throw error;
  }
}
