/** Shared scaffolding of the programs-sites suites: the app built for `app.inject` over in-memory task, database and service-client fakes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLIENT_ROUTE_KEY,
  businessClock,
  clientPathPattern,
  closingParen,
  collapseSql,
  createCapturingPublisher,
  createFakeTaskPort as createSharedFakeTaskPort,
  createHeadersFor,
  fakePoolTenantDb,
  fixedClock,
  localTestEnv,
  localTestUrl,
  pathWithoutQuery,
  splitTopLevel,
  testVerifier,
  writeTestSecrets,
  type ClientHandler,
  type FakeTaskPort as SharedFakeTaskPort,
  type FakeTaskPortOptions as SharedFakeTaskPortOptions,
} from '@opt2/platform/testing';
import type { QueryResult, QueryResultRow, TenantDb } from '@opt2/platform/tenancy';
import type { CreateTaskInput, TaskPort } from '@opt2/platform/tasks';
import {
  CSRF_CONSUME_PATH,
  loadEnv,
  type Clock,
  type FastifyInstance,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { buildApp, programsSitesEnvSchema, type BuildAppOptions } from '../../src/app.js';

export { fixedClock };

const SERVICE = 'programs-sites';
const SCHEMA = 'programs_sites';
const STATE_DIR_PREFIX = 'opt2-programs-sites-';

/** Raw environment that `loadEnv(programsSitesEnvSchema)` accepts in local mode; an override of `undefined` removes the variable. */
export function testEnv(overrides: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  return localTestEnv(
    {
      service: SERVICE,
      database: { name: 'opt2_test', user: 'programs_sites_app' },
      pgFromProcessEnv: true,
      callees: ['identity', 'migration', 'strategies-content', 'programs-sites'],
      stateDir: () => mkdtempSync(path.join(tmpdir(), STATE_DIR_PREFIX)),
      extra: { OPT2_GATEWAY_URL: localTestUrl('gateway'), OPT2_MIGRATION_URL: localTestUrl('migration'), OPT2_STORAGE_ADAPTER: 'local', TZ: process.env.TZ ?? 'UTC' },
    },
    overrides,
  );
}

/** Clock every suite shares: local `2026-06-30T12:00:00`, the seed's business date. */
export const TEST_CLOCK: Clock = businessClock();

/** A task the fake port holds; a `done` or `deleted` task is a tombstone whose name stays reserved. */
export interface FakeTaskRecord {
  readonly input: CreateTaskInput;
  readonly done: boolean;
  readonly deleted: boolean;
}

/** Options of {@link createFakeTaskPort}. */
export type FakeTaskPortOptions = Omit<SharedFakeTaskPortOptions, 'tenantKeyed'>;

/** The platform fake task port, tenant-keyed as the local adapter is, with a standing `failCreate` and `tasks` snapshots. */
export interface FakeTaskPort extends Omit<SharedFakeTaskPort, 'tasks' | 'failCreate'> {
  /** Makes matching creates throw until cleared with `null`. */
  failCreate(predicate: ((input: CreateTaskInput) => boolean) | null): void;
  /** Snapshot of every created task, tombstones included, in creation order. */
  tasks(queue?: string): FakeTaskRecord[];
}

/** Creates a {@link FakeTaskPort}; tasks are keyed by `(tenant, queue, name)` as in the local adapter, and a repeated key answers `created: false`. */
export function createFakeTaskPort(options: FakeTaskPortOptions = {}): FakeTaskPort {
  const port = createSharedFakeTaskPort({ ...options, tenantKeyed: true });
  return {
    ...port,
    failCreate(predicate) {
      port.failCreate(null);
      if (predicate !== null) port.failCreate(predicate, Infinity);
    },
    tasks: (queue) =>
      port.created
        .filter((task) => queue === undefined || task.input.queue === queue)
        .map((task) => ({ input: task.input, done: port.done.has(task), deleted: task.deleted })),
  };
}

/** Write-authority state of a fake unit gate. */
export type FakeGateState = 'legacy' | 'open' | 'closed';

/** Window or transition phase of a fake unit gate. */
export type FakeGatePhase = 'quiet' | 'executing' | 'importing' | 'import-pending';

/** One statement the fake pool received; `sql` is whitespace-collapsed. */
export interface RecordedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** `app.tenant_id` of the transaction; null in a metadata transaction or outside one. */
  readonly tenantId: string | null;
  /** `none` outside a transaction and for its `BEGIN`, before `set_config` names the tenant. */
  readonly kind: 'tenant' | 'metadata' | 'none';
}

/** Rows a responder answers, or a function computing them that may throw to fail the statement. */
export type ResponderRows = readonly QueryResultRow[] | ((params: unknown[], sql: string) => QueryResultRow[]);

/** A canned answer; a string pattern matches as a case-insensitive substring of the collapsed SQL. */
export interface Responder {
  readonly pattern: string | RegExp;
  readonly rows: ResponderRows;
}

/** Responders and gate states a {@link RecordingDb} starts with. */
export interface RecordingDbSeed {
  responders?: readonly Responder[];
  gates?: Readonly<Record<string, FakeGateState>>;
}

/** `TenantDb` over an in-memory pool: the platform transaction runner, every statement recorded, answers from responders, gates and defaults. */
export interface RecordingDb extends TenantDb {
  /** Adds a responder above every earlier one and the defaults; it sees every statement, gate reads and transaction control included. */
  respond(pattern: string | RegExp, rows: ResponderRows): void;
  /** Sets a unit's gate; a unit never set reads as `open`, holder null, phase `quiet`. */
  setGate(unit: string, state: FakeGateState, phase?: FakeGatePhase, holderId?: string | null): void;
  statements(): RecordedStatement[];
  /** Statements that write: a leading INSERT, UPDATE or DELETE, or one in a `WITH …` query; `SELECT … FOR UPDATE` is not a write. */
  writes(): RecordedStatement[];
  /** Writes into `table`, named `schema.table` or bare; double quotes are ignored. */
  writesTo(table: string): RecordedStatement[];
  /** Empties the recording; responders and gates stay. */
  clear(): void;
  /** Statements recorded before `buildTestApp` cleared the recording. */
  startup: readonly RecordedStatement[];
}

interface GateRow {
  unit: string;
  state: FakeGateState;
  holder_id: string | null;
  phase: FakeGatePhase;
}

/**
 * One pooled connection: `tenantId` undefined until `set_config` runs, `xid` assigned at the transaction's first write,
 * `locked` the row each table's last `SELECT … FOR UPDATE` in the transaction answered.
 */
interface Session {
  tenantId: string | null | undefined;
  xid: bigint | undefined;
  inTransaction: boolean;
  locked: Map<string, QueryResultRow>;
}

interface Answer {
  rows: QueryResultRow[];
  rowCount: number | null;
}

const WRITE_VERBS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);
const MAIN_VERBS: ReadonlySet<string> = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'MERGE']);
const TRANSACTION_CONTROL: ReadonlySet<string> = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'SET']);
const SET_TENANT = /set_config\('app\.tenant_id'/i;
const GATE_TABLE = /(?:"?[a-z_][a-z0-9_]*"?\.)?"?unit_gate"?(?![\w"])/i;
const WRITE_TARGET =
  /(?<!\b(?:FOR|DO|KEY)\s+)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
const WORD = /^\s*([A-Za-z_][A-Za-z0-9_]*)/;
const FIRST_XID = 1000n;
// Quotes the SQL scanners skip: string literals and quoted identifiers.
const QUOTES = '\'"';

function firstWord(text: string): string {
  return WORD.exec(text)?.[1]?.toUpperCase() ?? '';
}

function unquote(name: string): string {
  return name.replace(/"/g, '').toLowerCase();
}

/** The verb the statement executes and every verb it contains, CTE bodies of a `WITH` query included. */
function verbsOf(sql: string): { main: string; all: string[] } {
  const leading = firstWord(sql);
  if (leading !== 'WITH') return { main: leading, all: [leading] };
  const all: string[] = [];
  let depth = 0;
  let quote = '';
  for (let i = 4; i < sql.length; i += 1) {
    const ch = sql.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
      if (depth === 1) all.push(firstWord(sql.slice(i + 1)));
    } else if (ch === ')') {
      depth -= 1;
    } else if (depth === 0 && /[A-Za-z]/.test(ch) && !/[\w$]/.test(sql.charAt(i - 1))) {
      const word = firstWord(sql.slice(i));
      if (MAIN_VERBS.has(word)) return { main: word, all: [...all, word] };
    }
  }
  return { main: leading, all };
}

function isWrite(sql: string): boolean {
  return verbsOf(sql).all.some((verb) => WRITE_VERBS.has(verb));
}

function writeTargets(sql: string): string[] {
  return [...sql.matchAll(WRITE_TARGET)].flatMap((match) => (match[1] === undefined ? [] : [unquote(match[1])]));
}

/** Value a VALUES expression binds: a `$n` parameter (any cast ignored), NULL, a literal, else null. */
function boundValue(expression: string, params: readonly unknown[]): unknown {
  const placeholder = /^\$(\d+)(?:::.*)?$/.exec(expression);
  if (placeholder?.[1] !== undefined) return params[Number(placeholder[1]) - 1] ?? null;
  const literal = /^'((?:[^']|'')*)'(?:::.*)?$/.exec(expression);
  if (literal?.[1] !== undefined) return literal[1].replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(expression)) return Number(expression);
  if (/^(true|false)$/i.test(expression)) return expression.toLowerCase() === 'true';
  return null;
}

/** Rows of an `INSERT INTO t (cols) VALUES (…)[, (…)]` with every column bound; undefined for any other statement shape. */
function insertedRows(sql: string, params: readonly unknown[]): Record<string, unknown>[] | undefined {
  const head = /^INSERT INTO \S+ \(/i.exec(sql);
  if (head === null) return undefined;
  const columnsEnd = closingParen(sql, head[0].length - 1, QUOTES);
  if (columnsEnd < 0) return undefined;
  const columns = splitTopLevel(sql.slice(head[0].length, columnsEnd), QUOTES).map(unquote);
  const afterColumns = sql.slice(columnsEnd + 1);
  const valuesKeyword = /^\s*VALUES\s*/i.exec(afterColumns);
  if (valuesKeyword === null) return undefined;
  const rows: Record<string, unknown>[] = [];
  let rest = afterColumns.slice(valuesKeyword[0].length);
  while (rest.startsWith('(')) {
    const end = closingParen(rest, 0, QUOTES);
    if (end < 0) return undefined;
    const values = splitTopLevel(rest.slice(1, end), QUOTES);
    rows.push(Object.fromEntries(columns.map((column, i) => [column, boundValue(values[i] ?? 'NULL', params)])));
    rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
  }
  return rows;
}

/** `row` with every column it lacks reading as NULL, as `RETURNING *` returns columns the INSERT did not list. */
function everyColumn(row: QueryResultRow): QueryResultRow {
  return new Proxy(row, {
    has: (target, key) => typeof key === 'string' || key in target,
    get: (target, key, receiver): unknown => (typeof key === 'string' && !(key in target) ? null : (Reflect.get(target, key, receiver) as unknown)),
  });
}

/** `row` projected through a `RETURNING` list; `xid`, when no column supplies it, is the transaction's xid. */
function projectReturning(sql: string, row: Readonly<Record<string, unknown>>, xid: () => string): QueryResultRow | undefined {
  const returning = /\bRETURNING (.+)$/i.exec(sql)?.[1];
  if (returning === undefined) return undefined;
  const items = splitTopLevel(returning, QUOTES);
  if (items.length === 1 && items[0] === '*') return everyColumn({ ...row });
  const projected: QueryResultRow = {};
  for (const item of items) {
    if (item === '*') {
      Object.assign(projected, row);
      continue;
    }
    const aliased = /^(.+?)\s+AS\s+("?[\w$]+"?)$/i.exec(item);
    const expression = aliased?.[1] ?? item;
    const column = unquote(expression.split('::')[0] ?? expression);
    const name = unquote(aliased?.[2] ?? column);
    projected[name] = column in row ? row[column] : column === 'xid' ? xid() : null;
  }
  return projected;
}

/** Table a statement reads first (`FROM`) or updates, unquoted; undefined when it names none. */
function statementTable(sql: string): string | undefined {
  const name = /^UPDATE (\S+)/i.exec(sql)?.[1] ?? /\bFROM (\S+)/i.exec(sql)?.[1];
  return name === undefined ? undefined : unquote(name);
}

/** `base` with an `UPDATE … SET` list applied; an assignment that binds no parameter or literal keeps `base`'s value. */
function updatedRow(sql: string, params: readonly unknown[], base: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined {
  const list = /^UPDATE \S+ SET (.+?)(?= WHERE | FROM | RETURNING |$)/i.exec(sql)?.[1];
  if (list === undefined) return undefined;
  const row: Record<string, unknown> = { ...base };
  for (const assignment of splitTopLevel(list, QUOTES)) {
    const parts = /^("?[\w$]+"?)\s*=\s*(.+)$/.exec(assignment);
    if (parts?.[1] === undefined || parts[2] === undefined) continue;
    const column = unquote(parts[1]);
    const value = boundValue(parts[2], params);
    row[column] = value === null && parts[2].toUpperCase() !== 'NULL' && column in base ? base[column] : value;
  }
  return row;
}

function scalarAlias(sql: string, fallback: string): string {
  return unquote(/\bAS ("?[\w$]+"?)\s*$/i.exec(sql)?.[1] ?? fallback);
}

function unitsParam(value: unknown): string[] | undefined {
  return Array.isArray(value) ? [...new Set(value.map(String))] : undefined;
}

function pick(row: GateRow, columns: readonly string[]): QueryResultRow {
  const source: Readonly<Record<string, unknown>> = { ...row };
  return Object.fromEntries(columns.map((column) => [column, source[column] ?? null]));
}

function selectedColumns(sql: string): string[] {
  const list = /^SELECT (.+?) FROM /i.exec(sql)?.[1] ?? '*';
  return list.trim() === '*' ? ['unit', 'state', 'holder_id', 'phase'] : splitTopLevel(list, QUOTES).map(unquote);
}

/**
 * Creates a {@link RecordingDb} of schema `programs_sites`; nothing connects to PostgreSQL. Without a matching responder:
 * transaction control and `set_config` answer no rows; `unit_gate` ensures, reads and compare-and-set updates run on the
 * in-memory gates; `INSERT … VALUES` and `UPDATE … SET` answer their `RETURNING` from the bound values, an UPDATE over the
 * row its transaction last locked in that table; xids and snapshot horizons come from one counter; any other SELECT
 * answers no rows and any other write one affected row.
 */
export function createRecordingDb(seed: RecordingDbSeed = {}): RecordingDb {
  const responders: Responder[] = [...(seed.responders ?? [])];
  const gates = new Map<string, GateRow>();
  for (const [unit, state] of Object.entries(seed.gates ?? {})) gates.set(unit, { unit, state, holder_id: null, phase: 'quiet' });
  let recorded: RecordedStatement[] = [];
  let nextXid = FIRST_XID;
  const openXids = new Set<bigint>();

  const gateOf = (unit: string): GateRow => gates.get(unit) ?? { unit, state: 'open', holder_id: null, phase: 'quiet' };
  const kindOf = (session: Session): RecordedStatement['kind'] =>
    session.tenantId === undefined ? 'none' : session.tenantId === null ? 'metadata' : 'tenant';
  const xidOf = (session: Session): string => {
    if (session.xid === undefined) {
      session.xid = nextXid;
      nextXid += 1n;
      if (session.inTransaction) openXids.add(session.xid);
    }
    return session.xid.toString();
  };
  const endTransaction = (session: Session): void => {
    if (session.xid !== undefined) openXids.delete(session.xid);
    Object.assign(session, { tenantId: undefined, xid: undefined, inTransaction: false });
    session.locked.clear();
  };
  const matches = (pattern: string | RegExp, sql: string): boolean =>
    typeof pattern === 'string' ? sql.toLowerCase().includes(collapseSql(pattern).toLowerCase()) : sql.search(pattern) !== -1;

  function gateAnswer(sql: string, verb: string, params: readonly unknown[]): Answer | undefined {
    if (!GATE_TABLE.test(sql)) return undefined;
    const units = unitsParam(params[0]);
    if (verb === 'INSERT') {
      const added = (units ?? []).filter((unit) => !gates.has(unit));
      for (const unit of added) gates.set(unit, gateOf(unit));
      return { rows: [], rowCount: added.length };
    }
    if (verb === 'SELECT') {
      const rows = (units ?? [...gates.keys()]).sort().map((unit) => pick(gateOf(unit), selectedColumns(sql)));
      return { rows, rowCount: rows.length };
    }
    if (verb !== 'UPDATE') return undefined;
    const holderId = typeof params[1] === 'string' ? params[1] : null;
    const held = (gate: GateRow): boolean => holderId !== null && gate.holder_id === holderId;
    const candidates = (units ?? []).map(gateOf);
    let changed: GateRow[];
    if (/SET state = 'closed', holder_id = \$2, phase = \$3/i.test(sql)) {
      const closable = unitsParam(params[3]) ?? [];
      changed = candidates.filter((gate) => closable.includes(gate.state) || held(gate));
      for (const gate of changed) Object.assign(gate, { state: 'closed', holder_id: holderId, phase: String(params[2]) as FakeGatePhase });
    } else if (/SET phase = \$3/i.test(sql)) {
      changed = candidates.filter(held);
      for (const gate of changed) gate.phase = String(params[2]) as FakeGatePhase;
    } else if (/SET state = \$3, holder_id = NULL/i.test(sql)) {
      changed = candidates.filter(held);
      for (const gate of changed) Object.assign(gate, { state: String(params[2]) as FakeGateState, holder_id: null, phase: 'quiet' });
    } else {
      return undefined;
    }
    for (const gate of changed) gates.set(gate.unit, gate);
    const rows = changed.flatMap((gate): QueryResultRow[] => {
      const row = projectReturning(sql, { ...gate }, () => '0');
      return row === undefined ? [] : [row];
    });
    return { rows, rowCount: changed.length };
  }

  function defaultAnswer(session: Session, sql: string, verb: string, params: readonly unknown[]): Answer {
    if (TRANSACTION_CONTROL.has(verb)) return { rows: [], rowCount: null };
    if (/^SELECT set_config\(/i.test(sql)) return { rows: [], rowCount: 0 };
    const gate = gateAnswer(sql, verb, params);
    if (gate !== undefined) return gate;
    if (verb === 'SELECT' && /\bpg_current_xact_id\(\)/i.test(sql)) {
      return { rows: [{ [scalarAlias(sql, 'pg_current_xact_id')]: xidOf(session) }], rowCount: 1 };
    }
    const snapshot = /\bpg_snapshot_(xmin|xmax)\(pg_current_snapshot\(\)\)/i.exec(sql)?.[1];
    if (verb === 'SELECT' && snapshot !== undefined) {
      const oldestOpen = [...openXids].reduce<bigint | undefined>((min, xid) => (min === undefined || xid < min ? xid : min), undefined);
      const value = snapshot.toLowerCase() === 'xmin' ? (oldestOpen ?? nextXid) : nextXid;
      return { rows: [{ [scalarAlias(sql, `pg_snapshot_${snapshot.toLowerCase()}`)]: value.toString() }], rowCount: 1 };
    }
    if (/^SELECT current_setting\('lock_timeout'\)/i.test(sql)) {
      return { rows: [{ [scalarAlias(sql, 'current_setting')]: '0' }], rowCount: 1 };
    }
    if (verb === 'UPDATE') {
      const table = statementTable(sql);
      const updated = updatedRow(sql, params, (table === undefined ? undefined : session.locked.get(table)) ?? {});
      const row = updated === undefined ? undefined : projectReturning(sql, updated, () => xidOf(session));
      return { rows: row === undefined ? [] : [row], rowCount: 1 };
    }
    if (WRITE_VERBS.has(verb)) {
      const inserted = verb === 'INSERT' ? insertedRows(sql, params) : undefined;
      const rows = (inserted ?? []).flatMap((row): QueryResultRow[] => {
        const returned = projectReturning(sql, row, () => xidOf(session));
        return returned === undefined ? [] : [returned];
      });
      return { rows, rowCount: inserted?.length ?? 1 };
    }
    return { rows: [], rowCount: verb === 'SELECT' ? 0 : null };
  }

  async function run(session: Session, text: string, params: unknown[]): Promise<QueryResult> {
    const sql = collapseSql(text);
    const verb = verbsOf(sql).main;
    if (verb === 'BEGIN' || verb === 'START') session.inTransaction = true;
    if (SET_TENANT.test(sql)) session.tenantId = typeof params[0] === 'string' && params[0] !== '' ? params[0] : null;
    if (session.inTransaction && isWrite(sql)) xidOf(session);
    recorded.push({ sql, params, tenantId: session.tenantId ?? null, kind: kindOf(session) });
    try {
      const responder = responders.findLast((candidate) => matches(candidate.pattern, sql));
      let answer: Answer;
      if (responder === undefined) {
        answer = defaultAnswer(session, sql, verb, params);
      } else {
        const rows = typeof responder.rows === 'function' ? responder.rows([...params], sql) : responder.rows;
        answer = { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
      }
      const table = verb === 'SELECT' && /\bFOR (?:NO KEY )?UPDATE\b/i.test(sql) ? statementTable(sql) : undefined;
      const lockedRow = answer.rows[0];
      if (table !== undefined && lockedRow !== undefined) session.locked.set(table, lockedRow);
      return { command: verb, rowCount: answer.rowCount, oid: 0, fields: [], rows: answer.rows };
    } finally {
      if (verb === 'COMMIT' || verb === 'END' || (verb === 'ROLLBACK' && !/^ROLLBACK TO\b/i.test(sql))) endTransaction(session);
    }
  }

  const newSession = (): Session => ({ tenantId: undefined, xid: undefined, inTransaction: false, locked: new Map() });

  return {
    ...fakePoolTenantDb({ schema: SCHEMA, session: newSession, run }),
    startup: [],
    respond(pattern, rows) {
      responders.push({ pattern, rows });
    },
    setGate(unit, state, phase = 'quiet', holderId = null) {
      gates.set(unit, { unit, state, holder_id: holderId, phase });
    },
    statements: () => [...recorded],
    writes: () => recorded.filter((statement) => isWrite(statement.sql)),
    writesTo(table) {
      const wanted = unquote(table);
      const bare = !wanted.includes('.');
      return recorded.filter(
        (statement) =>
          isWrite(statement.sql) &&
          writeTargets(statement.sql).some((target) => target === wanted || (bare && target.split('.').pop() === wanted)),
      );
    },
    clear() {
      recorded = [];
    },
  };
}

/** Handlers per callee: one for every call, or several keyed `'<METHOD> <path>'`, where a `{name}` segment matches any one segment. */
export type ClientHandlers = Readonly<Record<string, ClientHandler | Readonly<Record<string, ClientHandler>>>>;

/** One service call the recorder received; `raw` is the request as sent. */
export interface RecordedServiceCall {
  readonly service: string;
  readonly method: ServiceRequest['method'];
  readonly path: string;
  readonly query: ServiceRequest['query'];
  readonly json: unknown;
  readonly raw: ServiceRequest;
}

/** Write authority migration reports for a unit. */
export type UnitAuthority = 'legacy' | 'target';

/** Status of a failed legacy step: 503 when it did not complete, 504 when its deadline passed. */
export type LegacyStepFailure = 503 | 504;

/** Fake service client: records each call, then answers from handlers, else from the identity and migration defaults. */
export interface ClientRecorder {
  readonly requests: RecordedServiceCall[];
  /** Calls to `service`, optionally only those whose path matches `path`, `{name}` segments included. */
  requestsTo(service: string, path?: string): RecordedServiceCall[];
  /** Adds a handler of one method and path pattern, above every handler given earlier. */
  on(service: string, method: ServiceRequest['method'], path: string, handler: ClientHandler): void;
  /** Sets the `valid` the default identity CSRF consume answers; initially true. */
  csrfValid(valid: boolean): void;
  /** Sets what the default migration `/internal/v1/authority` reports for `units`; every unit starts `legacy`. */
  setAuthority(units: readonly string[], authority: UnitAuthority): void;
  /** Makes the default migration legacy-step run of `step` answer `status` (503 by default); `null` restores success. */
  failStep(step: string, status?: LegacyStepFailure | null): void;
  /** Empties `requests`; handlers and default answers stay. */
  clear(): void;
  /** The recording `request`, as installed on `app.opt2.client`; an unmatched call throws after it is recorded. */
  request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>>;
  /** Replaces `request` on the app's existing service client, which route modules captured at registration. */
  install(app: FastifyInstance): void;
}

interface ClientRoute {
  readonly service: string;
  readonly method: ServiceRequest['method'];
  readonly path: string;
  readonly pattern: RegExp;
  readonly handler: ClientHandler;
}

const IDENTITY = 'identity';
const MIGRATION = 'migration';
const AUTHORITY_PATH = '/internal/v1/authority';
const LEGACY_STEPS_PATH = '/internal/v1/legacy-steps';
const LEGACY_UNAVAILABLE = Object.freeze({
  apiversion: 'v1',
  method: '',
  error: Object.freeze({ code: 'server_error', message: 'Unhandled Exception' }),
});

function clientRoute(service: string, method: ServiceRequest['method'], routePath: string, handler: ClientHandler): ClientRoute {
  return { service, method, path: routePath, pattern: clientPathPattern(routePath), handler };
}

/** Creates a {@link ClientRecorder}; `clock` stamps the default legacy-step `serverTime`. */
export function createClientRecorder(handlers: ClientHandlers = {}, options: { clock?: Clock } = {}): ClientRecorder {
  const clock = options.clock ?? TEST_CLOCK;
  const requests: RecordedServiceCall[] = [];
  const routes: ClientRoute[] = [];
  const perService = new Map<string, ClientHandler>();
  const authority = new Map<string, UnitAuthority>();
  const failedSteps = new Map<string, LegacyStepFailure>();
  let csrf = true;

  for (const [service, entry] of Object.entries(handlers)) {
    if (typeof entry === 'function') {
      perService.set(service, entry);
      continue;
    }
    for (const [key, handler] of Object.entries(entry)) {
      const parsed = CLIENT_ROUTE_KEY.exec(key);
      if (parsed?.[1] === undefined || parsed[2] === undefined) throw new TypeError(`client handler key must be '<METHOD> <path>': ${key}`);
      routes.push(clientRoute(service, parsed[1] as ServiceRequest['method'], parsed[2], handler));
    }
  }

  const defaults: readonly ClientRoute[] = [
    clientRoute(IDENTITY, 'POST', CSRF_CONSUME_PATH, () => ({ status: 200, headers: {}, body: { valid: csrf } })),
    clientRoute(MIGRATION, 'GET', AUTHORITY_PATH, (req) => {
      const units = [req.query?.units ?? []].flat().flatMap((list) => list.split(',')).filter((unit) => unit !== '');
      return {
        status: 200,
        headers: {},
        body: {
          // The cut-over versions move units to the target from v0002 on.
          tableVersion: [...authority.values()].includes('target') ? 'v0002' : 'v0001',
          units: Object.fromEntries(units.map((unit) => [unit, authority.get(unit) ?? 'legacy'])),
          allTarget: units.length > 0 && units.every((unit) => authority.get(unit) === 'target'),
        },
      };
    }),
    clientRoute(MIGRATION, 'POST', LEGACY_STEPS_PATH, (req) => {
      const body = (req.json ?? {}) as { step?: unknown; siteId?: unknown };
      const step = typeof body.step === 'string' ? body.step : '';
      const failure = failedSteps.get(step);
      if (failure !== undefined) return { status: failure, headers: {}, body: LEGACY_UNAVAILABLE };
      return {
        status: 200,
        headers: {},
        body: {
          step,
          completed: true,
          serverTime: clock.now().toISOString(),
          ...(typeof body.siteId === 'string' ? { siteId: body.siteId } : {}),
        },
      };
    }),
  ];

  const handlerFor = (req: ServiceRequest): ClientHandler | undefined => {
    const requestPath = pathWithoutQuery(req.path);
    const matching = (route: ClientRoute): boolean =>
      route.service === req.service && route.method === req.method && route.pattern.test(requestPath);
    return routes.findLast(matching)?.handler ?? perService.get(req.service) ?? defaults.find(matching)?.handler;
  };

  async function request<T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    requests.push({ service: req.service, method: req.method, path: req.path, query: req.query, json: req.json, raw: req });
    const handler = handlerFor(req);
    if (handler === undefined) throw new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`);
    return (await handler(req)) as ServiceResponse<T>;
  }

  return {
    requests,
    requestsTo(service, routePath) {
      const pattern = routePath === undefined ? undefined : clientPathPattern(routePath);
      return requests.filter((call) => call.service === service && (pattern === undefined || pattern.test(pathWithoutQuery(call.path))));
    },
    on(service, method, routePath, handler) {
      routes.push(clientRoute(service, method, routePath, handler));
    },
    csrfValid(valid) {
      csrf = valid;
    },
    setAuthority(units, state) {
      for (const unit of units) authority.set(unit, state);
    },
    failStep(step, status = 503) {
      if (status === null) failedSteps.delete(step);
      else failedSteps.set(step, status);
    },
    clear() {
      requests.length = 0;
    },
    request,
    install(app) {
      Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
    },
  };
}

type EventPublisher = NonNullable<BuildAppOptions['publisher']>;
type CapturingPublisher = ReturnType<typeof createCapturingPublisher>;

/** Options of {@link buildTestApp}; it creates every fake it is not given. */
export interface TestAppOptions<
  D extends TenantDb = RecordingDb,
  P extends TaskPort = FakeTaskPort,
  E extends EventPublisher = CapturingPublisher,
> {
  /** Merged into {@link testEnv}. */
  envOverrides?: Readonly<Record<string, string | undefined>>;
  clock?: Clock;
  verifierOverride?: BuildAppOptions['verifierOverride'];
  db?: D;
  publisher?: E;
  taskPort?: P;
  clientHandlers?: ClientHandlers;
  /** Options of the task port created when `taskPort` is absent. */
  taskPortOptions?: FakeTaskPortOptions;
}

/** A ready app and the fakes behind it. */
export interface TestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher> {
  app: FastifyInstance;
  publisher: E;
  taskPort: P;
  client: ClientRecorder;
  db: D;
  clock: Clock;
  /** Raw environment the app was built from. */
  env: Record<string, string>;
}

/** Closes the app a failed build created, then removes the helper-owned state directory; a cleanup error never replaces the build error. */
async function discardFailedBuild(app: FastifyInstance | undefined, removeStateDir: () => void): Promise<void> {
  try {
    // close() also runs the onClose hooks after a rejected ready(); the removal below covers a build that never added them.
    await app?.close();
  } finally {
    removeStateDir();
  }
}

/**
 * Builds the programs-sites app over in-memory fakes, installs the client recorder and awaits `ready`; it never listens.
 * On failure it closes the app it built and removes the state directory it created, then rethrows the original error.
 */
export function buildTestApp<D extends TenantDb = RecordingDb, P extends TaskPort = FakeTaskPort, E extends EventPublisher = CapturingPublisher>(
  opts?: TestAppOptions<D, P, E>,
): Promise<TestApp<D, P, E>>;
export async function buildTestApp(
  opts: TestAppOptions<TenantDb, TaskPort, EventPublisher> = {},
): Promise<TestApp<TenantDb, TaskPort, EventPublisher>> {
  const env = testEnv(opts.envOverrides);
  // A state directory testEnv created is the app's own, so it is removed when the app closes or fails to build.
  const ownStateDir = opts.envOverrides === undefined || !('OPT2_STATE_DIR' in opts.envOverrides);
  const removeStateDir = (): void => {
    const stateDir = env.OPT2_STATE_DIR;
    if (ownStateDir && stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
  };
  let app: FastifyInstance | undefined;
  try {
    const parsed = loadEnv(programsSitesEnvSchema, env);
    await writeTestSecrets(parsed.OPT2_STATE_DIR);
    const clock = opts.clock ?? TEST_CLOCK;
    let recording: RecordingDb | undefined;
    const db = opts.db ?? (recording = createRecordingDb());
    const publisher = opts.publisher ?? createCapturingPublisher();
    const taskPort = opts.taskPort ?? createFakeTaskPort(opts.taskPortOptions);
    const client = createClientRecorder(opts.clientHandlers, { clock });

    app = await buildApp({ env: parsed, clock, verifierOverride: opts.verifierOverride ?? testVerifier(), db, publisher, taskPort });
    // A synchronous throw in a callback hook leaves close() pending, so a removal error goes to done.
    app.addHook('onClose', (_instance, done) => {
      try {
        removeStateDir();
      } catch (err) {
        done(err as Error);
        return;
      }
      done();
    });
    client.install(app);
    await app.ready();
    if (recording !== undefined) {
      recording.startup = recording.statements();
      recording.clear();
    }
    return { app, publisher, taskPort, client, db, clock, env };
  } catch (err) {
    await discardFailedBuild(app, removeStateDir).catch(() => undefined);
    throw err;
  }
}

/** `app.inject` headers presenting a subject, or the `ROLE_SET` subject of that name, to programs-sites; user tokens name `site`, tenant-a by default. */
export const headersFor = createHeadersFor({ audience: SERVICE });
