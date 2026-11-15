// A real owner service over a throwaway PostgreSQL schema: genuine changelog rows, xid8 positions, commit-safe horizons
// and unit gates behind the platform migration handlers, reached through the real owners client.
import type { AddressInfo } from 'node:net';

import { LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import {
  UNIT_GATE_TABLE,
  awaitReadable,
  createRepository,
  defineMapping,
  migrationKitSql,
  qualified,
  readGates,
  registerMigrationHandlers,
  registerWritePositionHeader,
  type GatePhase,
  type GateState,
  type Mapping,
  type MappingSpec,
  type Repository,
  type RepositoryRow,
  type TableDefinition,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import {
  baseEnvSchema,
  createService,
  createServiceClient,
  loadEnv,
  systemClock,
  type BaseEnv,
  type Clock,
  type FastifyInstance,
} from '@opt2/platform/service-kit';
import { tenantRegistrySql, withMetadata, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  seedRegistry,
  testInvocationMinter,
  testVerifier,
  type TenantFixture,
  type ThrowawayRoles,
} from '@opt2/platform/testing';

import { createOwnersClient, type DataOwner, type OwnersClient, type UnitCatalog } from '../../src/owners/index.js';

import { createTestDirs } from './env.js';
import { FIXTURE_CATALOG, FIXTURE_TARGET_TABLES, MAILINGLIST_MEMBERS_MAPPING, TIMAGESIZES_MAPPING, fixtureTargetDdl } from './fixtures.js';

/** Whether the `PG_*` server accepts connections; suites gate their PostgreSQL cases on it. */
export const PG_AVAILABLE: boolean = await pgAvailable();

/** Skip reason of the PostgreSQL cases when {@link PG_AVAILABLE} is false. */
export const PG_SKIP_REASON = 'PostgreSQL unavailable (PG_* env)';

/** Holder id of every gate {@link PgOwner.setGate} closes; a `/gate` call naming it can reopen the gate by compare-and-set. */
export const PG_OWNER_GATE_HOLDER = 'pg-owner';

/** Path of the owner's public test rows route: GET reads a table behind its unit gate, POST writes one row. */
export const PG_OWNER_ROWS_PATH = '/test/v1/rows';

/** Service name the owners client calls as; its local token carries `platform.migration`. */
const CALLER = 'migration';

/** URL of a callee nobody starts: a closed loopback port, so a stray call fails fast. */
const UNREACHABLE_URL = 'http://127.0.0.1:1';

const DEFAULT_MAPPINGS: readonly MappingSpec[] = [TIMAGESIZES_MAPPING, MAILINGLIST_MEMBERS_MAPPING];
const DEFAULT_TENANTS: readonly TenantFixture[] = [TENANT_A, TENANT_B, TENANT_UMBRELLA];
const KEYLESS_ORDER = ['legacy_row_hash', 'occurrence'];
const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const XID_SQL = 'SELECT pg_current_xact_id()::text AS xid';

/** Settings of {@link startPgOwner}. */
export interface PgOwnerOptions {
  owner: DataOwner;
  /** Defaults to `[TIMAGESIZES_MAPPING, MAILINGLIST_MEMBERS_MAPPING]`; each must target a table of `fixtureTargetDdl`. */
  mappings?: readonly MappingSpec[];
  /** Units the migration handlers serve; defaults to the mappings' units. */
  units?: readonly string[];
  /** Tenants the registry holds; the first is the default tenant of writes. Defaults to A, B and umbrella. */
  tenants?: readonly TenantFixture[];
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Catalog of the owners client; defaults to `FIXTURE_CATALOG`. */
  catalog?: UnitCatalog;
}

/** Tenant of one write or transaction; defaults to the owner's first tenant. */
export interface TenantOption {
  tenantId?: string;
}

/** Outcome of {@link PgOwner.write}: the callback's result and the committed transaction's xid in decimal. */
export interface PgOwnerWrite<T> {
  result: T;
  xid: string;
}

/** A tenant transaction kept open across calls, so the commit-safe horizon stays at or below its xid. */
export interface HeldTransaction {
  readonly tenantId: string;
  /** `pg_current_xact_id()` of the transaction, assigned when it opened. */
  readonly xid: string;
  /** Runs `fn` inside the transaction. */
  run<T>(fn: (tx: TenantTx, repo: Repository) => Promise<T>): Promise<T>;
  /** Writes `row` through the repository: upsert for a keyed table, insert for a keyless one; returns the stored row. */
  write<R = RepositoryRow>(table: string, row: RepositoryRow): Promise<R>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** A started owner and its handles. */
export interface PgOwner {
  readonly owner: DataOwner;
  /** `http://127.0.0.1:<port>` of the listening app. */
  readonly url: string;
  readonly app: FastifyInstance;
  /** TenantDb of the throwaway schema's app role, shared with the app. */
  readonly db: TenantDb;
  readonly schema: string;
  readonly roles: Readonly<ThrowawayRoles>;
  readonly repository: Repository;
  readonly units: readonly string[];
  readonly tenants: readonly TenantFixture[];
  /** Owners client calling this owner as `migration`. */
  readonly ownersClient: OwnersClient;
  /** Runs `fn` as one target write transaction and returns its result with the transaction's xid. */
  write<T>(fn: (tx: TenantTx, repo: Repository) => Promise<T>, opts?: TenantOption): Promise<PgOwnerWrite<T>>;
  /** Opens a held transaction with its xid assigned. */
  openTransaction(opts?: TenantOption): Promise<HeldTransaction>;
  /** Sets the gates of `units` (default every handler unit) to `open`, phase `quiet`, so target writes proceed. */
  openGates(units?: readonly string[]): Promise<UnitGate[]>;
  /** Forces one gate's state and phase; a `closed` gate is held by {@link PG_OWNER_GATE_HOLDER}. */
  setGate(unit: string, state: GateState, phase?: GatePhase): Promise<UnitGate>;
  /** Rolls back held transactions, closes the app and clients, drops the schema and roles and removes the temp dirs; idempotent. */
  close(): Promise<void>;
}

type Step = () => Promise<void>;

/** Runs every step even when an earlier one fails; rejects with the failure or an AggregateError. */
async function runSteps(steps: readonly Step[], label: string): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, `${label} failed in several steps`);
  if (failures.length === 1) throw failures[0];
}

/** The fixture table definitions the mappings target; throws for a target `fixtureTargetDdl` does not create. */
function tableDefinitions(mappings: readonly Mapping[]): TableDefinition[] {
  const byTable = new Map<string, TableDefinition>();
  for (const mapping of mappings) {
    const table = mapping.targetTable.slice(mapping.targetTable.indexOf('.') + 1);
    const definition = FIXTURE_TARGET_TABLES.find((candidate) => candidate.table === table);
    if (definition === undefined) {
      const known = FIXTURE_TARGET_TABLES.map((candidate) => candidate.table).join(', ');
      throw new TypeError(`pg-owner creates only the fixture target tables ${known}; ${mapping.targetTable} is not one`);
    }
    byTable.set(table, definition);
  }
  return [...byTable.values()];
}

/** Local env of `owner`: loopback placeholders only, parsed as production parses it. */
function ownerEnv(owner: DataOwner, stateDir: string): BaseEnv {
  return loadEnv(baseEnvSchema, {
    // Required by the schema; the app listens on an ephemeral loopback port instead.
    PORT: '1',
    OPT2_SERVICE_NAME: owner,
    OPT2_ENV: 'local',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: `${UNREACHABLE_URL}/.well-known/jwks.json`,
    OPT2_STATE_DIR: stateDir,
    TZ: process.env.TZ || 'UTC',
    LOG_LEVEL: 'error',
  });
}

async function transactionXid(tx: TenantTx): Promise<string> {
  const { rows } = await tx.query<{ xid: string }>(XID_SQL);
  return (rows[0] as { xid: string }).xid;
}

/** Keyed tables are upserted, keyless ones inserted as a further occurrence. */
function writeRow<R>(repository: Repository, tx: TenantTx, table: string, row: RepositoryRow): Promise<R> {
  return repository.definition(table).key === null ? repository.insert<R>(tx, table, row) : repository.upsert<R>(tx, table, row);
}

function orderBy(definition: TableDefinition): string {
  return (definition.key ?? KEYLESS_ORDER).map((column) => `"${column}"`).join(', ');
}

const TABLE_PARAMS = {
  type: 'object',
  properties: { table: { type: 'string' } },
  required: ['table'],
} as const;

const READ_QUERY = {
  type: 'object',
  properties: { tenantId: { type: 'string', pattern: UUID_PATTERN }, budgetMs: { type: 'integer', minimum: 0 } },
  required: ['tenantId'],
} as const;

const WRITE_QUERY = {
  type: 'object',
  properties: { tenantId: { type: 'string', pattern: UUID_PATTERN } },
  required: ['tenantId'],
} as const;

/** Public test routes: a read behind the table's unit gate (optional `budgetMs` wait) and a target write whose response carries its write position. */
function registerRowRoutes(app: FastifyInstance, db: TenantDb, repository: Repository): void {
  const config = { opt2: { public: true as const } };

  app.get<{ Params: { table: string }; Querystring: { tenantId: string; budgetMs?: number } }>(
    `${PG_OWNER_ROWS_PATH}/:table`,
    { config, schema: { params: TABLE_PARAMS, querystring: READ_QUERY } },
    async (request) => {
      const { table } = request.params;
      const { tenantId, budgetMs } = request.query;
      const definition = repository.definition(table);
      const rows = await withTenant(db, tenantId, async (tx) => {
        if (definition.unit !== undefined) {
          await awaitReadable(tx, [definition.unit], budgetMs === undefined ? {} : { budgetMs });
        }
        return (await tx.query(`SELECT * FROM ${qualified(tx.schema, table)} ORDER BY ${orderBy(definition)}`)).rows;
      });
      return { rows };
    },
  );

  app.post<{ Params: { table: string }; Querystring: { tenantId: string }; Body: RepositoryRow }>(
    `${PG_OWNER_ROWS_PATH}/:table`,
    { config, schema: { params: TABLE_PARAMS, querystring: WRITE_QUERY, body: { type: 'object' } } },
    async (request) => {
      const { table } = request.params;
      const row = await withTenant(db, request.query.tenantId, (tx) => writeRow<RepositoryRow>(repository, tx, table, request.body));
      return { row };
    },
  );
}

/** Raised inside a held transaction's callback so that withTenant rolls it back. */
class HeldRollback extends Error {
  override readonly name = 'HeldRollback';
}

type HeldStep =
  | { kind: 'run'; run: (tx: TenantTx) => Promise<unknown>; resolve: (value: unknown) => void; reject: (err: unknown) => void }
  | { kind: 'commit' }
  | { kind: 'rollback' };

/** A held transaction with its owner-side controls. */
interface HeldControl {
  transaction: HeldTransaction;
  /** Rolls the transaction back unless it is already ending, then waits for it to end. */
  abandon(): Promise<void>;
  /** Resolves once the transaction has ended, however it ended. */
  settled: Promise<unknown>;
}

/**
 * Opens a transaction whose callback runs posted steps until commit or rollback; steps execute inside the callback, so
 * the repository finds the tenant transaction it requires in scope.
 */
async function holdTransaction(db: TenantDb, repository: Repository, tenantId: string): Promise<HeldControl> {
  const queue: HeldStep[] = [];
  let wake: (() => void) | undefined;
  const post = (step: HeldStep): void => {
    queue.push(step);
    wake?.();
    wake = undefined;
  };
  const next = async (): Promise<HeldStep> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() as HeldStep;
  };

  let opened: (xid: string) => void = () => undefined;
  const started = new Promise<string>((resolve) => {
    opened = resolve;
  });
  const finished = withTenant(db, tenantId, async (tx) => {
    opened(await transactionXid(tx));
    for (;;) {
      const step = await next();
      if (step.kind === 'commit') return;
      if (step.kind === 'rollback') throw new HeldRollback();
      try {
        step.resolve(await step.run(tx));
      } catch (err) {
        step.reject(err);
      }
    }
  });
  // Settles with the transaction's failure, or undefined after COMMIT; never rejects, so no outcome goes unhandled.
  const outcome = finished.then(
    () => undefined,
    (err: unknown) => err,
  );
  const xid = await Promise.race([
    started,
    outcome.then((err) => {
      throw err ?? new Error('Held transaction ended before it opened');
    }),
  ]);

  let state: 'open' | 'ending' = 'open';
  const ended = (): Error => new Error(`Held transaction ${xid} has already ended`);
  const end = async (kind: 'commit' | 'rollback'): Promise<void> => {
    if (state !== 'open') throw ended();
    state = 'ending';
    post({ kind });
    const err = await outcome;
    if (err !== undefined && !(kind === 'rollback' && err instanceof HeldRollback)) throw err;
  };
  const run = <T>(fn: (tx: TenantTx, repo: Repository) => Promise<T>): Promise<T> => {
    if (state !== 'open') return Promise.reject(ended());
    return new Promise<T>((resolve, reject) => {
      post({ kind: 'run', run: (tx) => fn(tx, repository), resolve: resolve as (value: unknown) => void, reject });
    });
  };
  const transaction: HeldTransaction = Object.freeze({
    tenantId,
    xid,
    run,
    write: <R = RepositoryRow>(table: string, row: RepositoryRow) => run((tx) => writeRow<R>(repository, tx, table, row)),
    commit: () => end('commit'),
    rollback: () => end('rollback'),
  });
  return {
    transaction,
    // A commit or rollback the suite already started reports its own outcome, so it is only waited for here.
    abandon: async () => {
      if (state === 'open') return end('rollback');
      await outcome;
    },
    settled: outcome,
  };
}

/** Forces `units`' gates to `state` and `phase`, creating missing rows; a `closed` gate gets {@link PG_OWNER_GATE_HOLDER}. */
async function forceGates(db: TenantDb, units: readonly string[], state: GateState, phase: GatePhase): Promise<UnitGate[]> {
  await withMetadata(db, (tx) =>
    tx.query(
      `INSERT INTO ${qualified(tx.schema, UNIT_GATE_TABLE)} (unit, state, holder_id, phase)
       SELECT unnest($1::text[]), $2::text, $3::text, $4::text
       ON CONFLICT (unit) DO UPDATE
         SET state = EXCLUDED.state, holder_id = EXCLUDED.holder_id, phase = EXCLUDED.phase, updated_at = localtimestamp(3)`,
      [[...units], state, state === 'closed' ? PG_OWNER_GATE_HOLDER : null, phase],
    ),
  );
  return readGates(db, units);
}

/** Starts a listening owner app over a fresh throwaway schema with the registry seeded and every gate `legacy`. */
export async function startPgOwner(opts: PgOwnerOptions): Promise<PgOwner> {
  const { owner, clock = systemClock } = opts;
  const mappings = (opts.mappings ?? DEFAULT_MAPPINGS).map(defineMapping);
  const units = [...new Set(opts.units ?? mappings.map((mapping) => mapping.unit))];
  const tenants = [...(opts.tenants ?? DEFAULT_TENANTS)];
  const defaultTenant = tenants[0];
  if (defaultTenant === undefined) throw new TypeError('startPgOwner needs at least one tenant');
  const tables = tableDefinitions(mappings);
  // Every generated statement names this schema; createThrowawaySchema rewrites it to the throwaway one.
  const sourceSchema = owner.replace(/-/g, '_');

  const closers: Step[] = [];
  const shutdown = (): Promise<void> => runSteps([...closers].reverse(), `pg-owner ${owner} shutdown`);
  try {
    const dirs = await createTestDirs();
    closers.push(() => dirs.cleanup());
    const throwaway = await createThrowawaySchema({
      service: owner,
      schemaName: sourceSchema,
      extraSql: [tenantRegistrySql(sourceSchema), migrationKitSql(sourceSchema), fixtureTargetDdl(sourceSchema)],
    });
    closers.push(() => throwaway.drop());
    const db = throwaway.app;
    const { schema } = throwaway;
    await seedRegistry(db);
    await withMetadata(db, (tx) =>
      tx.query(`DELETE FROM ${qualified(tx.schema, 'tenant_registry')} WHERE NOT (tenant_id = ANY($1::uuid[]))`, [
        tenants.map((tenant) => tenant.tenantId),
      ]),
    );

    const app = await createService({
      name: owner,
      version: '1.0.0',
      env: ownerEnv(owner, dirs.stateDir),
      verifierOverride: testVerifier(owner),
      clock,
      pool: db,
    });
    // Not runtime.shutdown(), which also stops the process-wide tracing a suite may have started; drop() ends the pool.
    closers.push(() => app.opt2.client.close());
    closers.push(() => app.close());
    registerWritePositionHeader(app);
    const repository = createRepository({ owner, schema, tables, clock });
    registerMigrationHandlers(app, { owner, repository, mappings, units });
    registerRowRoutes(app, db, repository);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;

    const serviceClient = createServiceClient({
      serviceUrls: { [owner]: url },
      self: CALLER,
      credentials: testInvocationMinter({ caller: CALLER }),
    });
    closers.push(() => serviceClient.close());
    const ownersClient = createOwnersClient({ client: serviceClient, catalog: opts.catalog ?? FIXTURE_CATALOG });

    const held = new Set<HeldControl>();
    const tenantOf = (option: TenantOption = {}): string => option.tenantId ?? defaultTenant.tenantId;
    let closing: Promise<void> | undefined;

    return Object.freeze({
      owner,
      url,
      app,
      db,
      schema,
      roles: throwaway.roles,
      repository,
      units: Object.freeze([...units]),
      tenants: Object.freeze(tenants),
      ownersClient,
      write: <T>(fn: (tx: TenantTx, repo: Repository) => Promise<T>, option?: TenantOption) =>
        withTenant(db, tenantOf(option), async (tx) => {
          const result = await fn(tx, repository);
          return { result, xid: await transactionXid(tx) };
        }),
      openTransaction: async (option?: TenantOption) => {
        const control = await holdTransaction(db, repository, tenantOf(option));
        held.add(control);
        void control.settled.then(() => held.delete(control));
        return control.transaction;
      },
      openGates: (gateUnits: readonly string[] = units) => forceGates(db, gateUnits, 'open', 'quiet'),
      setGate: async (unit: string, state: GateState, phase: GatePhase = 'quiet') =>
        (await forceGates(db, [unit], state, phase))[0] as UnitGate,
      close: () =>
        (closing ??= runSteps([...[...held].map((control) => () => control.abandon()), shutdown], `pg-owner ${owner} close`)),
    } satisfies PgOwner);
  } catch (err) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], `pg-owner ${owner} failed to start and to clean up`);
    }
    throw err;
  }
}
