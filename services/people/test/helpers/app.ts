/** Shared scaffolding of the people suites: the app built for `app.inject` over a recording database, a fake task port, a capturing publisher and the identity double. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN } from '@opt2/platform/auth';
import type { EventPublisher } from '@opt2/platform/events';
import {
  CHANGELOG_TABLE,
  UNIT_GATE_TABLE,
  closeGates,
  ensureUnitGates,
  openGates,
  type GatePhase,
  type GateState,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import { loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import {
  assertCreateInput,
  resolvePageSize,
  type CreateTaskInput,
  type CreateTaskResult,
  type DeleteTaskResult,
  type QueueState,
  type TaskInfo,
  type TaskPage,
  type TaskPageRequest,
  type TaskPort,
} from '@opt2/platform/tasks';
import { tenantDbFromPool, type Pool, type QueryConfig, type QueryResult, type QueryResultRow, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  TENANT_A,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type RoleSubject,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp, peopleEnvSchema, type PeopleEnv } from '../../src/app.js';
import { NO_FAULTS, type FaultHooks } from '../../src/domain/faults.js';
import { PEOPLE_UNITS, type PeopleUnit } from '../../src/repo/tables.js';
import { createIdentityDouble, type IdentityDouble } from './identity-double.js';

const STATE_DIR_PREFIX = 'opt2-people-test-';
const SCHEMA = 'people';
const GATEWAY_CALLER = 'gateway';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** Local ports of people and its identity and strategies-content callees, as `harness/repro/ports.env` fixes them. */
const LOCAL_PORTS = Object.freeze({ identity: 8111, people: 8112, 'strategies-content': 8114 } as const);

const localUrl = (port: number): string => `http://127.0.0.1:${String(port)}`;

/** State directories this module created; only these are given test secrets and removed when their app closes. */
const helperStateDirs = new Set<string>();

function newStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX));
  helperStateDirs.add(dir);
  return dir;
}

function removeHelperStateDir(dir: string): void {
  if (!helperStateDirs.has(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  helperStateDirs.delete(dir);
}

/** A fresh state directory outside the checkout holding the platform test key pair and push key. */
export async function createTestStateDir(): Promise<string> {
  const dir = newStateDir();
  await writeTestSecrets(dir);
  return dir;
}

/**
 * Parsed local people environment from literals and `TZ`; `overrides` merge last, `undefined` removing a variable.
 * `OPT2_STATE_DIR` defaults to `stateDir`, else a fresh directory of this module; `PG_*` are placeholders, as suites inject the database.
 */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}, stateDir?: string): PeopleEnv {
  const source: Record<string, string | undefined> = {
    PORT: String(LOCAL_PORTS.people),
    OPT2_SERVICE_NAME: SERVICE_NAME,
    OPT2_ENV: 'local',
    OPT2_DB_AUTH: 'password',
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'opt2_people_test',
    PG_USER: 'people_app',
    PG_PASSWORD: 'unused',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_JWKS_URL: `${localUrl(LOCAL_PORTS.identity)}/.well-known/jwks.json`,
    // The self entry is the outbox-sweep chain's task target.
    OPT2_SERVICE_URLS: JSON.stringify(Object.fromEntries(Object.entries(LOCAL_PORTS).map(([service, port]) => [service, localUrl(port)]))),
    OPT2_STATE_DIR: 'OPT2_STATE_DIR' in overrides ? undefined : (stateDir ?? newStateDir()),
    OPT2_TASKS_ADAPTER: 'local',
    OPT2_STORAGE_ADAPTER: 'local',
    TZ: process.env.TZ || 'UTC',
    ...overrides,
  };
  const defined = Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return loadEnv(peopleEnvSchema, Object.fromEntries(defined));
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date. */
export const TEST_CLOCK: Clock = businessClock();

/** A clock tests step forward or reset; each `now()` returns a fresh Date. */
export interface MutableClock extends Clock {
  /** Moves the clock by `ms`; a negative value steps back. */
  advance(ms: number): void;
  set(date: Date | string): void;
}

function instantOf(date: Date | string): number {
  const ms = new Date(date).getTime();
  if (Number.isNaN(ms)) throw new TypeError(`Invalid date for a mutable clock: ${String(date)}`);
  return ms;
}

/** A {@link MutableClock} starting at `start`, {@link TEST_CLOCK}'s instant by default; throws TypeError for an invalid date. */
export function createMutableClock(start: Date | string = TEST_CLOCK.now()): MutableClock {
  let current = instantOf(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      if (!Number.isFinite(ms)) throw new RangeError(`A mutable clock advances by a finite number of milliseconds, got ${String(ms)}`);
      current += ms;
    },
    set(date) {
      current = instantOf(date);
    },
  };
}

/** One statement the recording pool received; `text` is whitespace-collapsed. */
export interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Selects statements by a RegExp searched in the collapsed text, or by a predicate. */
export type StatementMatcher = RegExp | ((text: string, values: readonly unknown[]) => boolean);

/** Rows a responder answers, or a function computing them that may throw to fail the statement. */
export type ResponderRows = readonly QueryResultRow[] | ((text: string, values: readonly unknown[]) => readonly QueryResultRow[]);

/** A unit's seeded gate: its state, or its state and phase. */
export type RecordingGateSeed = GateState | { state: GateState; phase?: GatePhase };

/** Gates and responders a {@link RecordingDb} starts with; a later response takes precedence over an earlier one. */
export interface RecordingDbSeed {
  gates?: Readonly<Partial<Record<PeopleUnit, RecordingGateSeed>>>;
  responses?: ReadonlyArray<readonly [StatementMatcher, ResponderRows]>;
}

/** A `TenantDb` over an in-memory pool that runs the platform transaction runner, records every statement and never connects. */
export interface RecordingDb extends TenantDb {
  /** Every statement in order, transaction control and `set_config` included. */
  statements(): RecordedStatement[];
  /** INSERT, UPDATE and DELETE statements, also inside a `WITH` query; `SELECT … FOR UPDATE` is not a write. */
  writes(): RecordedStatement[];
  /** Empties the recording; responders and gates stay. */
  clear(): void;
  /** Adds a responder above every earlier one and the built-in answers; it sees every statement. */
  respond(matcher: StatementMatcher, rows: ResponderRows): void;
  /** Sets a unit's gate; a closed gate is held by the recording database, any other by no holder. */
  setGate(unit: PeopleUnit, state: GateState, phase?: GatePhase): void;
  /** Every gate, ordered by unit. */
  gates(): UnitGate[];
}

interface GateRow {
  unit: string;
  state: GateState;
  holder_id: string | null;
  phase: GatePhase;
}

/** One pooled connection: the xid its open transaction's first changelog insert took. */
interface Connection {
  xid: bigint | undefined;
}

interface Answer {
  rows: QueryResultRow[];
  rowCount: number | null;
}

const RECORDING_HOLDER = 'recording-db';
const FIRST_XID = 1000n;
const ENDED_POOL = 'Cannot use a pool after calling end on the pool';
const TRANSACTION_CONTROL: ReadonlySet<string> = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const WRITE_VERBS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);
const CTE_WRITE = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+(?:\s+AS\s+\S+)?\s+SET)\b/i;
const GATE_TABLE = new RegExp(`(?:"?[a-z_][a-z0-9_]*"?\\.)?"?${UNIT_GATE_TABLE}"?(?![\\w"])`, 'i');
const CHANGELOG_INSERT = new RegExp(`^INSERT INTO (?:"?[a-z_][a-z0-9_]*"?\\.)?"?${CHANGELOG_TABLE}"?\\s`, 'i');
const RETURNING_XID = /\bRETURNING\s+xid(?:::\w+)?(?:\s+AS\s+"?([\w$]+)"?)?\s*$/i;
const SELECT_COLUMNS = /^SELECT\s+(.+?)\s+FROM\s/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstWord(text: string): string {
  return /^\s*([A-Za-z_]+)/.exec(text)?.[1]?.toUpperCase() ?? '';
}

function isWrite(text: string): boolean {
  const verb = firstWord(text);
  return WRITE_VERBS.has(verb) || (verb === 'WITH' && CTE_WRITE.test(text));
}

function matches(matcher: StatementMatcher, text: string, values: readonly unknown[]): boolean {
  return matcher instanceof RegExp ? text.search(matcher) !== -1 : matcher(text, values);
}

function toUnitGate(row: GateRow): UnitGate {
  return { unit: row.unit, state: row.state, holderId: row.holder_id, phase: row.phase };
}

function gateRow(unit: string, seeded: RecordingGateSeed): GateRow {
  const { state, phase = 'quiet' } = typeof seeded === 'string' ? { state: seeded } : seeded;
  return { unit, state, holder_id: state === 'closed' ? RECORDING_HOLDER : null, phase };
}

/** Changelog tuples of an insert: every tuple starts with the shared `$1` tenant parameter. */
function changelogTuples(text: string): number {
  return Math.max(1, (text.match(/\(\s*\$1\s*,/g) ?? []).length);
}

/**
 * Creates a {@link RecordingDb} on schema `people`. Responders answer first, newest first; then gate reads answer from the
 * gate map, where every people unit starts `open`, phase `quiet`; gate inserts are no-ops; a changelog insert returns its
 * transaction's xid, counting up from 1000; any other statement answers no rows.
 */
export function createRecordingDb(seed: RecordingDbSeed = {}): RecordingDb {
  const gateMap = new Map<string, GateRow>(PEOPLE_UNITS.map((unit) => [unit, gateRow(unit, 'open')]));
  for (const [unit, seeded] of Object.entries(seed.gates ?? {})) {
    if (seeded !== undefined) gateMap.set(unit, gateRow(unit, seeded));
  }
  const responders: Array<readonly [StatementMatcher, ResponderRows]> = [...(seed.responses ?? [])];
  let recorded: RecordedStatement[] = [];
  let nextXid = FIRST_XID;
  let ended = false;

  function gateAnswer(text: string, values: readonly unknown[]): Answer | undefined {
    const verb = firstWord(text);
    if (verb === 'INSERT') return { rows: [], rowCount: 0 };
    if (verb !== 'SELECT') return undefined;
    const columns = (SELECT_COLUMNS.exec(text)?.[1] ?? '*').split(',').map((column) => column.trim().replace(/"/g, ''));
    const wanted = Array.isArray(values[0]) ? new Set(values[0].map(String)) : undefined;
    const rows = [...gateMap.values()]
      .filter((gate) => wanted === undefined || wanted.has(gate.unit))
      .sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0))
      .map((gate): QueryResultRow =>
        columns.includes('*') ? { ...gate } : Object.fromEntries(columns.map((column) => [column, gate[column as keyof GateRow] ?? null])),
      );
    return { rows, rowCount: rows.length };
  }

  function changelogAnswer(conn: Connection, text: string): Answer | undefined {
    const returning = RETURNING_XID.exec(text);
    if (returning === null) return undefined;
    if (conn.xid === undefined) {
      conn.xid = nextXid;
      nextXid += 1n;
    }
    const alias = returning[1] ?? 'xid';
    const xid = conn.xid.toString();
    const rows = Array.from({ length: changelogTuples(text) }, (): QueryResultRow => ({ [alias]: xid }));
    return { rows, rowCount: rows.length };
  }

  function builtIn(conn: Connection, text: string, values: readonly unknown[]): Answer {
    const verb = firstWord(text);
    if (TRANSACTION_CONTROL.has(verb)) return { rows: [], rowCount: null };
    const special = GATE_TABLE.test(text)
      ? gateAnswer(text, values)
      : CHANGELOG_INSERT.test(text)
        ? changelogAnswer(conn, text)
        : undefined;
    return special ?? { rows: [], rowCount: 0 };
  }

  /** Forgets the xid once a control statement ends the transaction; a `ROLLBACK TO SAVEPOINT` leaves it open. */
  function control(conn: Connection, text: string): void {
    const verb = firstWord(text);
    if (verb === 'COMMIT' || verb === 'END' || (verb === 'ROLLBACK' && !/^ROLLBACK TO\b/i.test(text))) conn.xid = undefined;
  }

  async function run(conn: Connection, input: string | QueryConfig, params?: unknown[]): Promise<QueryResult> {
    if (ended) throw new Error(ENDED_POOL);
    const text = collapse(typeof input === 'string' ? input : input.text);
    const values: unknown[] = [...((typeof input === 'string' ? undefined : input.values) ?? params ?? [])];
    recorded.push({ text, values });
    const responder = responders.findLast(([matcher]) => matches(matcher, text, values));
    let answer: Answer;
    if (responder === undefined) {
      answer = builtIn(conn, text, values);
    } else {
      const [, rows] = responder;
      const answered = typeof rows === 'function' ? rows(text, values) : rows;
      answer = { rows: answered.map((row) => ({ ...row })), rowCount: answered.length };
    }
    control(conn, text);
    // The transaction runner reads COMMIT's command tag to tell a commit from PostgreSQL's rollback of a failed transaction.
    return { command: firstWord(text), rowCount: answer.rowCount, oid: 0, fields: [], rows: answer.rows };
  }

  const newConnection = (): Connection => ({ xid: undefined });
  const fakePool = {
    async connect() {
      if (ended) throw new Error(ENDED_POOL);
      const conn = newConnection();
      return {
        query: (input: string | QueryConfig, params?: unknown[]): Promise<QueryResult> => run(conn, input, params),
        // A connection released mid-transaction is destroyed, which ends its transaction uncommitted.
        release: (): void => {
          conn.xid = undefined;
        },
      };
    },
    query: (input: string | QueryConfig, params?: unknown[]): Promise<QueryResult> => run(newConnection(), input, params),
    async end(): Promise<void> {
      ended = true;
    },
    // tenantDbFromPool subscribes to pool events; no connection of this pool ever emits one.
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(fakePool as unknown as Pool, { schema: SCHEMA });

  // tenantDbFromPool freezes its TenantDb, so the recording members sit on an object that delegates to it; `listen` is left
  // out, as no LISTEN session can open without a server.
  return {
    schema: base.schema,
    withTenant: (tenantId, fn, options) => base.withTenant(tenantId, fn, options),
    withMetadata: (fn, options) => base.withMetadata(fn, options),
    end: () => base.end(),
    statements: () => [...recorded],
    writes: () => recorded.filter((statement) => isWrite(statement.text)),
    clear() {
      recorded = [];
    },
    respond(matcher, rows) {
      responders.push([matcher, rows]);
    },
    setGate(unit, state, phase = 'quiet') {
      gateMap.set(unit, gateRow(unit, { state, phase }));
    },
    gates: () => [...gateMap.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)).map(toUnitGate),
  };
}

/** A task the fake port holds; a deleted task is a tombstone whose name stays reserved. */
export interface FakeTask {
  readonly input: CreateTaskInput;
  readonly deleted: boolean;
}

/** In-memory `TaskPort` keyed by `(queue, name)` that records every created task and never dispatches. */
export interface FakeTaskPort extends TaskPort {
  readonly kind: 'local';
  /** Every created task, tombstones included, in creation order. */
  readonly tasks: readonly FakeTask[];
  /** Makes the next `times` creates on `queue`, or on any queue when omitted, reject after their input is checked. */
  failCreate(times?: number, queue?: string): void;
}

interface StoredTask {
  input: CreateTaskInput;
  deleted: boolean;
}

/** Creates a {@link FakeTaskPort}; a repeated `(queue, name)`, live or deleted, answers `created: false` as ALREADY_EXISTS does. */
export function createFakeTaskPort(): FakeTaskPort {
  const tasks: StoredTask[] = [];
  const paused = new Set<string>();
  const failures: Array<{ queue: string | undefined; remaining: number }> = [];

  const find = (queue: string, name: string): StoredTask | undefined =>
    tasks.find((task) => task.input.queue === queue && task.input.name === name);
  const live = (queue: string, name: string): StoredTask | undefined => {
    const task = find(queue, name);
    return task === undefined || task.deleted ? undefined : task;
  };
  const infoOf = ({ input }: StoredTask): TaskInfo => ({
    queue: input.queue,
    name: input.name,
    scheduleTime: new Date(input.scheduleTime.getTime()),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    status: 'pending',
    attempts: 0,
  });

  return {
    kind: 'local',
    tasks,

    async create(input: CreateTaskInput): Promise<CreateTaskResult> {
      assertCreateInput(input);
      const failure = failures.find((entry) => entry.remaining > 0 && (entry.queue === undefined || entry.queue === input.queue));
      if (failure !== undefined) {
        failure.remaining -= 1;
        throw new Error(`fake task port: injected create failure on ${input.queue}/${input.name}`);
      }
      if (find(input.queue, input.name) !== undefined) return { name: input.name, created: false };
      tasks.push({ input, deleted: false });
      return { name: input.name, created: true };
    },

    async delete(queue: string, name: string): Promise<DeleteTaskResult> {
      const task = live(queue, name);
      if (task !== undefined) task.deleted = true;
      return { name, deleted: task !== undefined };
    },

    async list(queue: string, page?: TaskPageRequest): Promise<TaskPage> {
      const pageSize = resolvePageSize(page?.pageSize);
      const queued = tasks.filter((task) => task.input.queue === queue && !task.deleted);
      const start = page?.pageToken === undefined ? 0 : Number(page.pageToken);
      const end = start + pageSize;
      const listed = queued.slice(start, end).map(infoOf);
      return end < queued.length ? { tasks: listed, nextPageToken: String(end) } : { tasks: listed };
    },

    async get(queue: string, name: string): Promise<TaskInfo | undefined> {
      const task = live(queue, name);
      return task === undefined ? undefined : infoOf(task);
    },

    async pauseQueue(queue: string): Promise<void> {
      paused.add(queue);
    },

    async resumeQueue(queue: string): Promise<void> {
      paused.delete(queue);
    },

    async queueState(queue: string): Promise<QueueState> {
      return { queue, paused: paused.has(queue) };
    },

    close: (): Promise<void> => Promise.resolve(),

    failCreate(times = 1, queue) {
      failures.push({ queue, remaining: times });
    },
  };
}

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface BuildTestAppOptions<
  D extends TenantDb = RecordingDb,
  P extends TaskPort = FakeTaskPort,
  E extends EventPublisher = CapturingPublisher,
> {
  /** A parsed environment such as `testEnv(overrides)`; a state directory this module created gets the test secrets and is removed on close. */
  env?: PeopleEnv;
  /** Replaces the recording database, for example with a throwaway schema's `app`. */
  db?: D;
  identity?: IdentityDouble;
  clock?: Clock;
  faults?: FaultHooks;
  taskPort?: P;
  publisher?: E;
}

/** A ready people app and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  readonly app: FastifyInstance;
  readonly env: PeopleEnv;
  readonly publisher: E;
  readonly identity: IdentityDouble;
  readonly db: D;
  readonly clock: Clock;
  /** Holds the platform test secrets. */
  readonly stateDir: string;
  readonly taskPort: P;
  /** Closes the app, then removes the state directory when this module created it; repeated calls share the first outcome. */
  close(): Promise<void>;
}

type AppParts = Omit<TestApp<TenantDb, TaskPort, EventPublisher>, 'close'>;

interface Assembled {
  readonly parts: AppParts;
  closeApp(): Promise<void>;
  removeStateDir(): void;
}

/** Builds and readies the app; a failed build closes what it built and removes a state directory of this module, then rethrows. */
async function assemble(opts: BuildTestAppOptions<TenantDb, TaskPort, EventPublisher>): Promise<Assembled> {
  const env = opts.env ?? testEnv({}, await createTestStateDir());
  const stateDir = env.OPT2_STATE_DIR;
  const removeStateDir = (): void => {
    removeHelperStateDir(stateDir);
  };
  let app: FastifyInstance | undefined;
  try {
    // A directory testEnv created holds no secrets yet; a directory the caller chose is never written.
    if (opts.env !== undefined && helperStateDirs.has(stateDir)) await writeTestSecrets(stateDir);
    const clock = opts.clock ?? TEST_CLOCK;
    const db = opts.db ?? createRecordingDb();
    const identity = opts.identity ?? createIdentityDouble({ clock });
    const publisher = opts.publisher ?? createCapturingPublisher();
    const taskPort = opts.taskPort ?? createFakeTaskPort();
    const faults = opts.faults ?? NO_FAULTS;
    app = await buildApp({ env, verifierOverride: testVerifier(), clock, publisher, taskPort, identityClient: identity.identityClient, db, faults });
    // The CSRF pre-handler and the routes reach identity through app.opt2.client.
    identity.install(app);
    await app.ready();
    const built = app;
    return {
      parts: { app: built, env, publisher, identity, db, clock, stateDir, taskPort },
      closeApp: async () => {
        await built.close();
      },
      removeStateDir,
    };
  } catch (err) {
    // The build error is the one reported; a failure closing the partial app must not replace it.
    await app?.close().catch(() => undefined);
    removeStateDir();
    throw err;
  }
}

/** Builds people over the fakes (recording database, identity double, fake task port, capturing publisher) and awaits `ready`; it never listens. */
export function buildTestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher>(
  opts?: BuildTestAppOptions<D, P, E>,
): Promise<TestApp<D, P, E>>;
export async function buildTestApp(
  opts: BuildTestAppOptions<TenantDb, TaskPort, EventPublisher> = {},
): Promise<TestApp<TenantDb, TaskPort, EventPublisher>> {
  const { parts, closeApp, removeStateDir } = await assemble(opts);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await closeApp();
      } finally {
        removeStateDir();
      }
    })());
  return { ...parts, close };
}

const PG_VARIABLES = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const PG_GATE_HOLDER = 'people-test-app';

/** Whether every bootstrap `PG_*` variable is set and the server accepts a connection; `pgAvailable` alone rejects when PG_HOST is set and another is unset. */
async function pgReady(): Promise<boolean> {
  return PG_VARIABLES.every((name) => Boolean(process.env[name])) ? pgAvailable() : false;
}

/** Whether PostgreSQL suites can run, decided once at import, for `describe.skipIf(!PG_AVAILABLE)`. */
export const PG_AVAILABLE: boolean = await pgReady();

/** What {@link withPgApp} answers instead of running its callback. */
export interface PgSkipped {
  readonly skipped: true;
  readonly reason: string;
}

/** A people app over a migrated throwaway schema with the fixture registry and open unit gates. */
export interface PgTestApp<P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  readonly app: FastifyInstance;
  readonly schema: ThrowawaySchema;
  /** The schema's app-role `TenantDb`, which the app runs on. */
  readonly db: TenantDb;
  readonly identity: IdentityDouble;
  readonly publisher: E;
  readonly clock: Clock;
  readonly taskPort: P;
}

/** Options of {@link withPgApp}: those of {@link buildTestApp} but the database. */
export type WithPgAppOptions<P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> = Omit<
  BuildTestAppOptions<TenantDb, P, E>,
  'db'
>;

/**
 * Runs `fn` against people over a throwaway schema with every migration applied, the fixture registry seeded and every
 * people unit gate open; then closes the app, drops the schema and removes the state directory, whatever `fn` did.
 * Answers {@link PgSkipped} without calling `fn` when `PG_*` is unset or the server is unreachable.
 */
export function withPgApp<T, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher>(
  fn: (ctx: PgTestApp<P, E>) => Promise<T>,
  opts?: WithPgAppOptions<P, E>,
): Promise<T | PgSkipped>;
export async function withPgApp<T>(
  fn: (ctx: PgTestApp<TaskPort, EventPublisher>) => Promise<T>,
  opts: WithPgAppOptions<TaskPort, EventPublisher> = {},
): Promise<T | PgSkipped> {
  if (!(await pgReady())) return { skipped: true, reason: 'PostgreSQL is not configured or not reachable through PG_*' };
  const schema = await createThrowawaySchema({ service: SERVICE_NAME, migrationsDir: MIGRATIONS_DIR });
  let assembled: Assembled | undefined;
  try {
    await seedRegistry(schema.app, schema.schema);
    await ensureUnitGates(schema.app, PEOPLE_UNITS);
    // openGates reopens only its holder's gates, so the new `legacy` gates are first closed under this helper's holder.
    await closeGates(schema.app, { units: PEOPLE_UNITS, holderId: PG_GATE_HOLDER, allowLegacy: true });
    await openGates(schema.app, { units: PEOPLE_UNITS, holderId: PG_GATE_HOLDER, state: 'open' });
    assembled = await assemble({ ...opts, db: schema.app });
    const { app, identity, publisher, clock, taskPort } = assembled.parts;
    return await fn({ app, schema, db: schema.app, identity, publisher, clock, taskPort });
  } finally {
    try {
      await assembled?.closeApp();
    } finally {
      try {
        await schema.drop();
      } finally {
        assembled?.removeStateDir();
      }
    }
  }
}

/** Options of {@link headersFor}. */
export interface HeadersForOptions {
  /** Site of a user token; `tenant-a` by default. */
  site?: string;
  /** Callee of the invocation credential; people by default. */
  audience?: string;
  /** Masa `UserID` of a user token; one per subject by default. */
  sub?: string;
}

function roleSubjectNamed(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) throw new TypeError(`ROLE_SET has no subject named ${name}`);
  return found;
}

/** `app.inject` headers presenting `subject`, or the `ROLE_SET` subject of that name, to people; rejects with TypeError for an unknown name. */
export async function headersFor(subject: RoleSubject | string, opts: HeadersForOptions = {}): Promise<Record<string, string>> {
  const resolved = typeof subject === 'string' ? roleSubjectNamed(subject) : subject;
  return authHeadersFor(resolved, {
    site: opts.site ?? TENANT_A.siteId,
    audience: opts.audience ?? SERVICE_NAME,
    ...(opts.sub === undefined ? {} : { sub: opts.sub }),
  });
}

/** Claims of a user token; a people `TestActor` has this shape. */
export interface UserHeadersInput {
  sub: string;
  site: string;
  roles: readonly string[];
  s2?: boolean;
  sid?: string;
}

/** Headers of a user request arriving through the gateway: the user token in `authorization` and the gateway's local service token beside it. */
export async function userHeaders(claims: UserHeadersInput): Promise<Record<string, string>> {
  const { sub, site, roles, s2, sid } = claims;
  const [userToken, gatewayToken] = await Promise.all([
    mintUserToken({ sub, site, roles, s2, sid }),
    mintServiceToken({ caller: GATEWAY_CALLER, audience: SERVICE_NAME }),
  ]);
  return { authorization: `Bearer ${userToken}`, [INVOCATION_HEADER]: `Bearer ${gatewayToken}` };
}
