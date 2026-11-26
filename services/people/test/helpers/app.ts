/** Shared scaffolding of the people suites: the app built for `app.inject` over a recording database, a fake task port, a capturing publisher and the identity double. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import type { EventPublisher } from '@opt2/platform/events';
import {
  CHANGELOG_TABLE,
  UNIT_GATE_TABLE,
  type GatePhase,
  type GateState,
  type UnitGate,
} from '@opt2/platform/migration-kit';
import { loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { QueryResult, QueryResultRow, TenantDb } from '@opt2/platform/tenancy';
import {
  businessClock,
  collapseSql,
  createCapturingPublisher,
  createFakeTaskPort as createSharedFakeTaskPort,
  createHeadersFor,
  fakePoolTenantDb,
  localTestEnv,
  mintServiceToken,
  mintUserToken,
  testVerifier,
  writeTestSecrets,
  type CapturingPublisher,
  type FakeTask,
  type FakeTaskPort as SharedFakeTaskPort,
} from '@opt2/platform/testing';
import { SERVICE_NAME, buildApp, peopleEnvSchema, type PeopleEnv } from '../../src/app.js';
import { NO_FAULTS, type FaultHooks } from '../../src/domain/faults.js';
import { PEOPLE_UNITS, type PeopleUnit } from '../../src/repo/tables.js';
import { createIdentityDouble, type IdentityDouble } from './identity-double.js';

const STATE_DIR_PREFIX = 'opt2-people-test-';
const SCHEMA = 'people';
const GATEWAY_CALLER = 'gateway';

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

/** Parsed local people environment; `overrides` merge last, `undefined` removing a variable; `OPT2_STATE_DIR` defaults to `stateDir`, else a fresh directory of this module. */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}, stateDir?: string): PeopleEnv {
  // The self entry is the outbox-sweep chain's task target.
  const callees = ['identity', 'people', 'strategies-content'];
  const database = { name: 'opt2_people_test', user: 'people_app' };
  return loadEnv(peopleEnvSchema, localTestEnv({ service: SERVICE_NAME, database, callees, stateDir: () => stateDir ?? newStateDir(), extra: { OPT2_STORAGE_ADAPTER: 'local' } }, overrides));
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
const TRANSACTION_CONTROL: ReadonlySet<string> = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const WRITE_VERBS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);
const CTE_WRITE = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+(?:\s+AS\s+\S+)?\s+SET)\b/i;
const GATE_TABLE = new RegExp(`(?:"?[a-z_][a-z0-9_]*"?\\.)?"?${UNIT_GATE_TABLE}"?(?![\\w"])`, 'i');
const CHANGELOG_INSERT = new RegExp(`^INSERT INTO (?:"?[a-z_][a-z0-9_]*"?\\.)?"?${CHANGELOG_TABLE}"?\\s`, 'i');
const RETURNING_XID = /\bRETURNING\s+xid(?:::\w+)?(?:\s+AS\s+"?([\w$]+)"?)?\s*$/i;
const SELECT_COLUMNS = /^SELECT\s+(.+?)\s+FROM\s/i;

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

  async function run(conn: Connection, sql: string, values: unknown[]): Promise<QueryResult> {
    const text = collapseSql(sql);
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

  // `listen` is left out, as no LISTEN session can open without a server.
  return {
    ...fakePoolTenantDb<Connection>({
      schema: SCHEMA,
      session: () => ({ xid: undefined }),
      // A connection released mid-transaction is destroyed, which ends its transaction uncommitted.
      release: (conn) => {
        conn.xid = undefined;
      },
      run,
    }),
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

/** The platform fake task port with `tasks` as the list of every created task, tombstones included, in creation order. */
export interface FakeTaskPort extends Omit<SharedFakeTaskPort, 'tasks' | 'failCreate'> {
  readonly tasks: readonly FakeTask[];
  /** Makes the next `times` creates on `queue`, or on any queue when omitted, reject after their input is checked. */
  failCreate(times?: number, queue?: string): void;
}

/** Creates a {@link FakeTaskPort}; a repeated `(queue, name)`, live or deleted, answers `created: false` as ALREADY_EXISTS does. */
export function createFakeTaskPort(): FakeTaskPort {
  const port = createSharedFakeTaskPort();
  return { ...port, tasks: port.created, failCreate: (times = 1, queue) => port.failCreate(queue, times) };
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

/** `app.inject` headers presenting a subject, or the `ROLE_SET` subject of that name, to people. */
export const headersFor = createHeadersFor({ audience: SERVICE_NAME });

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
