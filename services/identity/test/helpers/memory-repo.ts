/** In-memory data layer of the identity suites: a recording `TenantDb` over a fake pg pool, and an `IdentityRepository` held in memory. */
// Ids, trimming and timestamps come from the platform helpers the real repository uses, never from local copies.
import { cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import {
  GATE_PHASES,
  GATE_STATES,
  OPEN_OPERATION_TABLE,
  RepositoryError,
  UNIT_GATE_TABLE,
  acquireWriteGates,
  awaitReadable,
  isMigrationAuthority,
  type ChangeOp,
  type GatePhase,
  type GateState,
  type RepositoryRow,
  type TableDefinition,
  type UnitGate,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { localTimestamp } from '@opt2/platform/outbox';
import { systemClock } from '@opt2/platform/service-kit';
import {
  assertTenantId,
  requireTenantTx,
  tenantDbFromPool,
  type Pool,
  type QueryConfig,
  type QueryResult,
  type QueryResultRow,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import {
  OWNER,
  READ_PAGE_SIZE,
  SCHEMA,
  charKey,
  createIdentityRepository,
  lastUpdateInfo,
  type AccountFilter,
  type AccountInput,
  type AccountOperationInput,
  type AccountOperationPatch,
  type AccountRecordRow,
  type AccountUpdate,
  type AuditActor,
  type AuditNames,
  type CountedGroupList,
  type CountedGroupPage,
  type CountedGroupRow,
  type CredentialValues,
  type CsrfClaimFilter,
  type CsrfClaimInput,
  type CsrfClaimPurge,
  type DeviceInput,
  type DeviceLookup,
  type EmailAccountRow,
  type ExpiredTokenPurge,
  type GroupAddressInput,
  type GroupAddressUpdate,
  type GroupExtendDataReplacement,
  type GroupInput,
  type GroupMemberCount,
  type GroupMemberPage,
  type GroupMemberProbe,
  type GroupMemberRow,
  type GroupMembership,
  type GroupRelation,
  type GroupUpdate,
  type IdentityRepository,
  type IdentityRepositoryOptions,
  type KeyedGroupMember,
  type ListPage,
  type ListedAccountCount,
  type ListedPage,
  type MembershipRecords,
  type ModuleGrant,
  type OAuthClientInput,
  type OAuthClientValues,
  type OAuthTokenInput,
  type OpenOperationLookup,
  type PermissionGrant,
  type PersonContactInput,
  type PoolGroupRow,
  type RedirectInput,
  type RemoteSessionInput,
  type ReusableTokenLookup,
  type SessionAdminState,
  type SessionInsert,
  type SessionLockMode,
  type SessionPatch,
  type StrikeValues,
  type UsernameCandidateRow,
} from '../../src/repo/repository.js';
import {
  ACCOUNT_OPERATION,
  AGGREGATE_VERSION,
  CREDENTIAL,
  CSRF_CLAIM,
  GROUP_ACCOUNT,
  GROUP_ADDRESS,
  GROUP_EXTEND_DATA,
  GROUP_FAVORITE,
  GROUP_INTEREST,
  GROUP_TAG,
  GROUP_TRASH,
  IDENTITY_UNITS,
  LOGIN_STATE,
  MEMBERSHIP,
  OAUTH_CLIENT,
  OAUTH_TOKEN,
  OWNED_TABLES,
  PERMISSION,
  PERSON_CONTACT,
  REDIRECT,
  REMOTE_SESSION,
  SESSION,
  USER_ACCOUNT,
  USER_DEVICE,
  USER_STRIKE,
  type AccountOperationRow,
  type AccountOperationState,
  type AggregateVersionRow,
  type CredentialRow,
  type CsrfClaimRow,
  type CsrfClaimState,
  type GroupAccountRow,
  type GroupAddressRow,
  type GroupExtendDataRow,
  type GroupFavoriteRow,
  type GroupInterestRow,
  type GroupTagRow,
  type GroupTrashRow,
  type IdentityTableDefinition,
  type IdentityTableName,
  type IdentityUnit,
  type LoginStateRow,
  type MembershipRow,
  type OAuthClientRow,
  type OAuthTokenRow,
  type PermissionRow,
  type PersonContactRow,
  type RedirectRow,
  type RemoteSessionRow,
  type SessionRow,
  type UserAccountRow,
  type UserDeviceRow,
  type UserStrikeRow,
} from '../../src/repo/tables.js';
import type { GroupFeedPage, GroupFeedQuery } from '../../src/repo/group-feed.js';
import { conditionTest, feedOrder } from '../../src/routes/legacy-api.js';

const DEFINITIONS: ReadonlyMap<string, IdentityTableDefinition> = new Map(OWNED_TABLES.map((def) => [def.table, def]));

/** bigint columns, which pg returns as decimal strings. */
const INT8_COLUMNS: Readonly<Partial<Record<IdentityTableName, readonly string[]>>> = {
  group_account: ['row_version'],
  session: ['epoch'],
  person_contact: ['aggregate_version'],
  aggregate_version: ['row_version'],
};

/** Value pg returns for `value` in `column` of `table`: int8 columns as decimal text, everything else unchanged. */
function pgValue(table: string, column: string, value: unknown): unknown {
  const int8 = INT8_COLUMNS[table as IdentityTableName]?.includes(column) === true;
  return int8 && (typeof value === 'number' || typeof value === 'bigint') ? String(value) : value;
}

/** A copy of `row` that shares no Date or array with it. */
function copyRow<R extends object>(row: R): R {
  const copy: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    copy[column] = value instanceof Date ? new Date(value.getTime()) : Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return copy as R;
}

/** A pg error with SQLSTATE `code`, shaped as node-postgres raises it. */
function pgError(code: string, message: string, fields: Readonly<Record<string, string>> = {}): Error {
  return Object.assign(new Error(message), { code, ...fields });
}

function uniqueViolation(table: string, constraint: string): Error {
  return pgError('23505', `duplicate key value violates unique constraint "${constraint}"`, { schema: SCHEMA, table, constraint });
}

// Recording database

/** A statement the fake pool received; `sql` is whitespace-collapsed, `tenantId` the transaction's `app.tenant_id` ('' in a metadata transaction or outside one). */
export interface RecordedStatement {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly tenantId: string;
}

/** Verb of a recorded write. */
export type WriteVerb = 'INSERT' | 'UPDATE' | 'DELETE';

/** A write statement; `table` is its first target, unquoted, e.g. `identity.session`. */
export interface RecordedWrite extends RecordedStatement {
  readonly table: string;
  readonly verb: WriteVerb;
}

/** Selects the statements a responder answers: a RegExp searched in the collapsed SQL, or a predicate. */
export type QueryMatcher = RegExp | ((sql: string, values: readonly unknown[]) => boolean);

/** Rows a responder answers, or a function computing them; a throw fails the statement as a pg error would. */
export type ResponderRows = readonly QueryResultRow[] | ((sql: string, values: readonly unknown[]) => readonly QueryResultRow[]);

/** Gates and responders a {@link RecordingDb} starts with; a later response takes precedence over an earlier one. */
export interface RecordingDbSeed {
  gates?: Partial<Record<IdentityUnit, { state: GateState; phase?: GatePhase }>>;
  responses?: ReadonlyArray<readonly [QueryMatcher, ResponderRows]>;
}

/**
 * `TenantDb` of schema `identity` whose transactions the platform runner drives over an in-memory pool. It models an empty
 * database: inserts answer their bound values, reads answer no rows unless a responder or a built-in (gates, open operations,
 * xids, settings, advisory locks) answers them.
 */
export interface RecordingDb extends TenantDb {
  /** Adds a canned answer, checked before every earlier responder and every built-in answer, transaction control included. */
  respond(matcher: QueryMatcher, rows: ResponderRows): void;
  /** Writes of committed transactions, in commit order. */
  writes(): RecordedWrite[];
  /** Every statement, committed or not, in arrival order. */
  statements(): RecordedStatement[];
  /** Empties both logs and drops every responder; gates stay. */
  clear(): void;
  /** Sets a unit's committed gate with no holder; `phase` defaults to `quiet`. */
  setGate(unit: IdentityUnit, state: GateState, phase?: GatePhase): void;
  /** Committed gates, by unit. */
  gates(): UnitGate[];
}

type GateRow = {
  unit: string;
  state: GateState;
  holder_id: string | null;
  phase: GatePhase;
};

type OperationRow = {
  operation_id: string;
  kind: string;
  units: string[];
  started_at: Date;
};

interface Savepoint {
  readonly name: string;
  readonly writes: number;
  readonly gates: Map<string, GateRow>;
  readonly operations: Map<string, OperationRow | null>;
  readonly settings: Map<string, string>;
}

/** One pooled connection; gate and open-operation changes stay pending until COMMIT, a deletion pending as null. */
interface Connection {
  inTransaction: boolean;
  /** A statement failed, so every later one fails until ROLLBACK, as PostgreSQL's aborted transaction state. */
  aborted: boolean;
  tenantId: string;
  xid: bigint | undefined;
  pending: RecordedWrite[];
  gates: Map<string, GateRow>;
  operations: Map<string, OperationRow | null>;
  settings: Map<string, string>;
  savepoints: Savepoint[];
  /** Row each table's last `SELECT … FOR UPDATE|SHARE` answered, the base of a later `UPDATE … RETURNING`. */
  locked: Map<string, QueryResultRow>;
}

interface Answer {
  rows: QueryResultRow[];
  rowCount: number | null;
}

const FIRST_XID = 1000n;
const ENDED_POOL = 'Cannot use a pool after calling end on the pool';
const WRITE_VERBS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);
const MAIN_VERBS: ReadonlySet<string> = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'VALUES', 'MERGE']);
const CONTROL_VERBS: ReadonlySet<string> = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const SET_TENANT = /set_config\('app\.tenant_id'/i;
const LOCKING_READ = /\bFOR (?:NO KEY |KEY )?(?:UPDATE|SHARE)\b/i;
const DEFAULT_SETTINGS: Readonly<Record<string, string>> = { lock_timeout: '0' };
const WRITE_TARGET =
  /(?<!\b(?:FOR|DO|KEY)\s+)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)/gi;
/** An expression no parameter or literal binds. */
const UNBOUND = Symbol('unbound');

function tableReference(table: string): RegExp {
  return new RegExp(`(?<![\\w$"])(?:"?[a-z_][a-z0-9_]*"?\\.)?"?${table}"?(?![\\w"])`, 'i');
}

const GATE_TABLE = tableReference(UNIT_GATE_TABLE);
const OPERATION_TABLE = tableReference(OPEN_OPERATION_TABLE);

function collapse(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function firstWord(text: string): string {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1]?.toUpperCase() ?? '';
}

function unquote(name: string): string {
  return name.trim().replace(/"/g, '').toLowerCase();
}

/** Calls `visit` with each index of `text` outside quotes, with the parenthesis depth there; stops when `visit` returns true. */
function scanTopLevel(text: string, visit: (index: number, depth: number) => boolean): void {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (visit(i, depth)) return;
    if (ch === ')') depth -= 1;
  }
}

/** Index of the `)` closing the `(` at `open`; -1 when unbalanced. */
function closingParen(text: string, open: number): number {
  let found = -1;
  scanTopLevel(text.slice(open), (i, depth) => {
    if (text.charAt(open + i) === ')' && depth === 1) {
      found = open + i;
      return true;
    }
    return false;
  });
  return found;
}

/** Index of the keyword `word` outside parentheses and quotes; -1 when absent. */
function topLevelIndex(sql: string, word: string): number {
  let found = -1;
  scanTopLevel(sql, (i, depth) => {
    const boundary = i === 0 || !/[\w$]/.test(sql.charAt(i - 1));
    if (depth === 0 && boundary && sql.slice(i, i + word.length).toUpperCase() === word && !/[\w$]/.test(sql.charAt(i + word.length))) {
      found = i;
      return true;
    }
    return false;
  });
  return found;
}

/** `text` split at commas outside parentheses and quotes, each part trimmed. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scanTopLevel(text, (i, depth) => {
    if (depth === 0 && text.charAt(i) === ',') {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    return false;
  });
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** The verb the statement executes and every verb it contains, CTE bodies of a `WITH` query included. */
function verbsOf(sql: string): { main: string; all: string[] } {
  const leading = firstWord(sql);
  if (leading !== 'WITH') return { main: leading, all: [leading] };
  const all: string[] = [];
  let main = leading;
  scanTopLevel(sql, (i, depth) => {
    const ch = sql.charAt(i);
    if (ch === '(' && depth === 1) {
      all.push(firstWord(sql.slice(i + 1)));
    } else if (depth === 0 && i >= 4 && /[A-Za-z]/.test(ch) && !/[\w$]/.test(sql.charAt(i - 1))) {
      const word = firstWord(sql.slice(i));
      if (MAIN_VERBS.has(word)) {
        main = word;
        all.push(word);
        return true;
      }
    }
    return false;
  });
  return { main, all };
}

function writeTargets(sql: string): string[] {
  return [...sql.matchAll(WRITE_TARGET)].flatMap((match) => (match[1] === undefined ? [] : [unquote(match[1])]));
}

/** Value an expression binds: a `$n` parameter or a literal, any cast ignored; `UNBOUND` for anything else. */
function boundValue(expression: string, params: readonly unknown[]): unknown {
  const text = expression.trim();
  const placeholder = /^\$(\d+)(?:::[\w\s[\]"]+)?$/.exec(text);
  if (placeholder?.[1] !== undefined) return params[Number(placeholder[1]) - 1] ?? null;
  const literal = /^'((?:[^']|'')*)'(?:::[\w\s[\]"]+)?$/.exec(text);
  if (literal?.[1] !== undefined) return literal[1].replace(/''/g, "'");
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^(?:true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^(?:NULL|DEFAULT)$/i.test(text)) return null;
  return UNBOUND;
}

/** A text array parameter as strings; undefined for NULL or a non-array. */
function textArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? [...new Set(value.map(String))] : undefined;
}

/** Rows of an `INSERT INTO t (cols) VALUES (…)[, (…)]`; undefined for any other statement shape. */
function insertedRows(sql: string, params: readonly unknown[]): Record<string, unknown>[] | undefined {
  const head = /^INSERT INTO \S+ \(/i.exec(sql);
  if (head === null) return undefined;
  const columnsEnd = closingParen(sql, head[0].length - 1);
  if (columnsEnd < 0) return undefined;
  const columns = splitTopLevel(sql.slice(head[0].length, columnsEnd)).map(unquote);
  const afterColumns = sql.slice(columnsEnd + 1);
  const valuesKeyword = /^\s*VALUES\s*/i.exec(afterColumns);
  if (valuesKeyword === null) return undefined;
  const rows: Record<string, unknown>[] = [];
  let rest = afterColumns.slice(valuesKeyword[0].length);
  while (rest.startsWith('(')) {
    const end = closingParen(rest, 0);
    if (end < 0) return undefined;
    const values = splitTopLevel(rest.slice(1, end));
    rows.push(
      Object.fromEntries(
        columns.map((column, i) => {
          const value = boundValue(values[i] ?? 'NULL', params);
          return [column, value === UNBOUND ? null : value];
        }),
      ),
    );
    rest = rest.slice(end + 1).replace(/^\s*,\s*/, '');
  }
  return rows;
}

/** `row` with every declared column of an identity table, unlisted ones NULL, and int8 columns as decimal text. */
function completeRow(target: string | undefined, row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const [schema, table] = (target ?? '').split('.');
  const def = schema === SCHEMA && table !== undefined ? DEFINITIONS.get(table) : undefined;
  if (def === undefined) return { ...row };
  return Object.fromEntries(def.columns.map((column) => [column.name, pgValue(def.table, column.name, row[column.name] ?? null)]));
}

/** `row` projected through the statement's `RETURNING` list; `xid`, when no column supplies it, is the transaction's xid. */
function projectReturning(sql: string, row: Readonly<Record<string, unknown>>, xid: () => string): QueryResultRow | undefined {
  const at = topLevelIndex(sql, 'RETURNING');
  if (at < 0) return undefined;
  const projected: QueryResultRow = {};
  for (const item of splitTopLevel(sql.slice(at + 'RETURNING'.length))) {
    if (item === '*') {
      Object.assign(projected, copyRow(row));
      continue;
    }
    const aliased = /^(.+?)\s+AS\s+("?[\w$]+"?)$/i.exec(item);
    const expression = aliased?.[1] ?? item;
    const column = unquote(expression.split('::')[0] ?? expression);
    projected[unquote(aliased?.[2] ?? column)] = column in row ? row[column] : column === 'xid' ? xid() : null;
  }
  return projected;
}

/** Table a statement updates or reads first, unquoted; undefined when it names none. */
function statementTable(sql: string): string | undefined {
  const name = /^UPDATE (\S+)/i.exec(sql)?.[1] ?? /\bFROM (\S+)/i.exec(sql)?.[1];
  return name === undefined ? undefined : unquote(name);
}

/** Assignments of an `UPDATE … SET` list that bind a parameter or literal, by column. */
function assignmentsOf(sql: string, params: readonly unknown[]): Map<string, unknown> {
  const assigned = new Map<string, unknown>();
  const set = topLevelIndex(sql, 'SET');
  if (set < 0) return assigned;
  const tail = sql.slice(set + 'SET'.length);
  const ends = ['WHERE', 'FROM', 'RETURNING'].map((word) => topLevelIndex(tail, word)).filter((index) => index >= 0);
  for (const assignment of splitTopLevel(tail.slice(0, ends.length === 0 ? undefined : Math.min(...ends)))) {
    const parts = /^("?[\w$]+"?)\s*=\s*(.+)$/.exec(assignment);
    if (parts?.[1] === undefined || parts[2] === undefined) continue;
    const value = boundValue(parts[2], params);
    if (value !== UNBOUND) assigned.set(unquote(parts[1]), value);
  }
  return assigned;
}

function isGateState(value: unknown): value is GateState {
  return (GATE_STATES as readonly unknown[]).includes(value);
}

function isGatePhase(value: unknown): value is GatePhase {
  return (GATE_PHASES as readonly unknown[]).includes(value);
}

/** Enforces the `unit_gate` CHECK constraints, as an insert or update of an invalid state or phase fails in PostgreSQL. */
function checkedGate(row: GateRow): GateRow {
  for (const [column, valid] of [
    ['state', isGateState(row.state)],
    ['phase', isGatePhase(row.phase)],
  ] as const) {
    if (!valid) {
      throw pgError('23514', `new row for relation "${UNIT_GATE_TABLE}" violates check constraint "${UNIT_GATE_TABLE}_${column}_check"`, {
        schema: SCHEMA,
        table: UNIT_GATE_TABLE,
        constraint: `${UNIT_GATE_TABLE}_${column}_check`,
      });
    }
  }
  return row;
}

function toUnitGate(row: GateRow): UnitGate {
  return { unit: row.unit, state: row.state, holderId: row.holder_id, phase: row.phase };
}

function gateColumns(sql: string): string[] {
  const list = /^SELECT (.+?) FROM /i.exec(sql)?.[1] ?? '*';
  return list.trim() === '*' ? ['unit', 'state', 'holder_id', 'phase'] : splitTopLevel(list).map(unquote);
}

function matches(matcher: QueryMatcher, sql: string, values: readonly unknown[]): boolean {
  return matcher instanceof RegExp ? sql.search(matcher) !== -1 : matcher(sql, values);
}

function newConnection(): Connection {
  return {
    inTransaction: false,
    aborted: false,
    tenantId: '',
    xid: undefined,
    pending: [],
    gates: new Map(),
    operations: new Map(),
    settings: new Map(),
    savepoints: [],
    locked: new Map(),
  };
}


/**
 * Creates a {@link RecordingDb}; nothing connects to PostgreSQL. Every identity unit's gate starts `open`, holder null, phase
 * `quiet`, unless `seed.gates` says otherwise.
 */
export function createRecordingDb(seed: RecordingDbSeed = {}): RecordingDb {
  const committedGates = new Map<string, GateRow>();
  for (const unit of IDENTITY_UNITS) committedGates.set(unit, { unit, state: 'open', holder_id: null, phase: 'quiet' });
  for (const [unit, gate] of Object.entries(seed.gates ?? {})) {
    if (gate !== undefined) committedGates.set(unit, checkedGate({ unit, state: gate.state, holder_id: null, phase: gate.phase ?? 'quiet' }));
  }
  const committedOperations = new Map<string, OperationRow>();
  const responders: Array<readonly [QueryMatcher, ResponderRows]> = [...(seed.responses ?? [])];
  const sequences = new Map<string, bigint>();
  const openXids = new Set<bigint>();
  let statementLog: RecordedStatement[] = [];
  let writeLog: RecordedWrite[] = [];
  let nextXid = FIRST_XID;
  let ended = false;

  const gateOf = (conn: Connection, unit: string): GateRow | undefined => conn.gates.get(unit) ?? committedGates.get(unit);
  const gateUnits = (conn: Connection): string[] => [...new Set([...committedGates.keys(), ...conn.gates.keys()])];
  const operationOf = (conn: Connection, id: string): OperationRow | undefined =>
    conn.operations.has(id) ? (conn.operations.get(id) ?? undefined) : committedOperations.get(id);
  const operationsOf = (conn: Connection): OperationRow[] =>
    [...new Set([...committedOperations.keys(), ...conn.operations.keys()])].flatMap((id) => {
      const operation = operationOf(conn, id);
      return operation === undefined ? [] : [operation];
    });

  function putGate(conn: Connection, row: GateRow): void {
    if (conn.inTransaction) conn.gates.set(row.unit, row);
    else committedGates.set(row.unit, row);
  }

  function putOperation(conn: Connection, id: string, row: OperationRow | null): void {
    if (conn.inTransaction) conn.operations.set(id, row);
    else if (row === null) committedOperations.delete(id);
    else committedOperations.set(id, row);
  }

  /** The transaction's xid, assigned on first use, as PostgreSQL assigns one at the first write. */
  function xidOf(conn: Connection): string {
    if (conn.xid === undefined) {
      conn.xid = nextXid;
      nextXid += 1n;
      if (conn.inTransaction) openXids.add(conn.xid);
    }
    return conn.xid.toString();
  }

  /** `pg_snapshot_xmin`: the oldest open xid, else the next one to be assigned. */
  function horizon(): bigint {
    let oldest: bigint | undefined;
    for (const xid of openXids) if (oldest === undefined || xid < oldest) oldest = xid;
    return oldest ?? nextXid;
  }

  function endTransaction(conn: Connection): void {
    if (conn.xid !== undefined) openXids.delete(conn.xid);
    Object.assign(conn, newConnection());
  }

  function commit(conn: Connection): void {
    writeLog.push(...conn.pending);
    for (const [unit, gate] of conn.gates) committedGates.set(unit, gate);
    for (const [id, operation] of conn.operations) {
      if (operation === null) committedOperations.delete(id);
      else committedOperations.set(id, operation);
    }
  }

  function savepointIndex(conn: Connection, sql: string): number {
    const name = unquote(/(\S+)$/.exec(sql)?.[1] ?? '');
    const index = conn.savepoints.map((savepoint) => savepoint.name).lastIndexOf(name);
    if (index < 0) throw pgError('3B001', `savepoint "${name}" does not exist`);
    return index;
  }

  function gateAnswer(conn: Connection, sql: string, verb: string, params: readonly unknown[]): Answer | undefined {
    const units = textArray(params[0]);
    if (verb === 'INSERT') {
      // The ensure insert names only the unit column, so a new gate takes the DDL defaults.
      const added = (units ?? []).filter((unit) => gateOf(conn, unit) === undefined);
      for (const unit of added) putGate(conn, { unit, state: 'legacy', holder_id: null, phase: 'quiet' });
      return { rows: [], rowCount: added.length };
    }
    if (verb === 'SELECT') {
      const columns = gateColumns(sql);
      const rows = (units ?? gateUnits(conn)).sort().flatMap((unit): QueryResultRow[] => {
        const gate = gateOf(conn, unit);
        return gate === undefined ? [] : [Object.fromEntries(columns.map((column) => [column, (gate as Record<string, unknown>)[column] ?? null]))];
      });
      return { rows, rowCount: rows.length };
    }
    if (verb !== 'UPDATE') return undefined;
    const where = sql.slice(Math.max(0, topLevelIndex(sql, 'WHERE')));
    const param = (index: string | undefined): unknown => (index === undefined ? undefined : params[Number(index) - 1]);
    const closable = /\(state = ANY\(\$(\d+)(?:::text\[\])?\) OR holder_id = \$(\d+)\)/i.exec(where);
    const holderOnly = closable === null ? /\bholder_id = \$(\d+)/i.exec(where) : null;
    const closableStates = textArray(param(closable?.[1])) ?? [];
    const holder = param(closable?.[2] ?? holderOnly?.[1]);
    const eligible = (gate: GateRow): boolean => {
      const held = typeof holder === 'string' && gate.holder_id === holder;
      if (closable !== null) return closableStates.includes(gate.state) || held;
      return holderOnly === null || held;
    };
    const assigned = assignmentsOf(sql, params);
    const value = <K extends 'state' | 'holder_id' | 'phase'>(gate: GateRow, column: K): GateRow[K] =>
      (assigned.has(column) ? assigned.get(column) : gate[column]) as GateRow[K];
    // Every new row is checked before any is stored, so a failing statement changes nothing.
    const changed = (units ?? []).flatMap((unit): GateRow[] => {
      const gate = gateOf(conn, unit);
      if (gate === undefined || !eligible(gate)) return [];
      return [checkedGate({ unit, state: value(gate, 'state'), holder_id: value(gate, 'holder_id'), phase: value(gate, 'phase') })];
    });
    for (const gate of changed) putGate(conn, gate);
    const rows = changed.flatMap((gate): QueryResultRow[] => {
      const row = projectReturning(sql, gate, () => xidOf(conn));
      return row === undefined ? [] : [row];
    });
    return { rows, rowCount: changed.length };
  }

  function operationAnswer(conn: Connection, sql: string, verb: string, params: readonly unknown[]): Answer | undefined {
    if (verb === 'INSERT') {
      let added = 0;
      for (const row of insertedRows(sql, params) ?? []) {
        const id = String(row.operation_id);
        if (operationOf(conn, id) !== undefined) continue;
        putOperation(conn, id, { operation_id: id, kind: String(row.kind), units: textArray(row.units) ?? [], started_at: systemClock.now() });
        added += 1;
      }
      return { rows: [], rowCount: added };
    }
    if (verb === 'DELETE') {
      const index = /\boperation_id = \$(\d+)/i.exec(sql)?.[1];
      const id = index === undefined ? undefined : params[Number(index) - 1];
      const present = typeof id === 'string' && operationOf(conn, id) !== undefined;
      if (present) putOperation(conn, id, null);
      return { rows: [], rowCount: present ? 1 : 0 };
    }
    if (verb !== 'SELECT') return undefined;
    const overlapping = textArray(params[0]);
    const rows = operationsOf(conn)
      .filter((operation) => overlapping === undefined || operation.units.some((unit) => overlapping.includes(unit)))
      .sort(
        (a, b) =>
          a.started_at.getTime() - b.started_at.getTime() || (a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0),
      )
      .map((operation) => ({
        operation_id: operation.operation_id,
        kind: operation.kind,
        units: [...operation.units],
        started_at: new Date(operation.started_at.getTime()),
        started: localTimestamp(operation.started_at).replace(' ', 'T'),
      }));
    return { rows, rowCount: rows.length };
  }

  function scalarValue(conn: Connection, expression: string, fn: string | undefined, params: readonly unknown[]): unknown {
    if (fn === undefined) {
      const value = boundValue(expression, params);
      return value === UNBOUND ? null : value;
    }
    const open = expression.indexOf('(');
    const args = splitTopLevel(expression.slice(open + 1, closingParen(expression, open))).map((arg) => boundValue(arg, params));
    const [name, setting] = args;
    switch (fn) {
      case 'pg_current_xact_id':
        return xidOf(conn);
      case 'pg_snapshot_xmin':
        return horizon().toString();
      case 'pg_snapshot_xmax':
        return nextXid.toString();
      case 'set_config':
        if (typeof name !== 'string') return null;
        conn.settings.set(name, setting === undefined || setting === null || setting === UNBOUND ? '' : String(setting));
        return conn.settings.get(name) ?? null;
      case 'current_setting':
        return typeof name === 'string' ? (conn.settings.get(name) ?? DEFAULT_SETTINGS[name] ?? null) : null;
      case 'nextval': {
        // Every sequence descends from -1, as the child id sequences of 0005_child_id_sequences.sql do.
        const key = expression.replace(/\$(\d+)/g, (_match, n: string) => String(params[Number(n) - 1]));
        const next = (sequences.get(key) ?? 0n) - 1n;
        sequences.set(key, next);
        return next.toString();
      }
      default:
        if (fn.startsWith('pg_try_advisory')) return true;
        return fn.startsWith('pg_advisory') ? '' : null;
    }
  }

  /** A SELECT without FROM always returns exactly one row. */
  function scalarAnswer(conn: Connection, sql: string, params: readonly unknown[]): Answer {
    const row: QueryResultRow = {};
    for (const item of splitTopLevel(sql.replace(/^SELECT\s+/i, ''))) {
      const aliased = /^(.+?)\s+AS\s+("?[\w$]+"?)$/i.exec(item);
      const expression = (aliased?.[1] ?? item).trim();
      const fn = /^([A-Za-z_]\w*)\s*\(/.exec(expression)?.[1]?.toLowerCase();
      row[unquote(aliased?.[2] ?? fn ?? '?column?')] = scalarValue(conn, expression, fn, params);
    }
    return { rows: [row], rowCount: 1 };
  }

  function builtIn(conn: Connection, sql: string, verb: string, params: readonly unknown[]): Answer {
    if (CONTROL_VERBS.has(verb)) return { rows: [], rowCount: null };
    const special = GATE_TABLE.test(sql)
      ? gateAnswer(conn, sql, verb, params)
      : OPERATION_TABLE.test(sql)
        ? operationAnswer(conn, sql, verb, params)
        : undefined;
    if (special !== undefined) return special;
    if (verb === 'SELECT' && topLevelIndex(sql, 'FROM') < 0) return scalarAnswer(conn, sql, params);
    if (verb === 'INSERT') {
      const target = writeTargets(sql)[0];
      const inserted = insertedRows(sql, params);
      const rows = (inserted ?? []).flatMap((row): QueryResultRow[] => {
        const returned = projectReturning(sql, completeRow(target, row), () => xidOf(conn));
        return returned === undefined ? [] : [returned];
      });
      return { rows, rowCount: inserted?.length ?? 0 };
    }
    if (verb === 'UPDATE') {
      const table = statementTable(sql);
      const locked = table === undefined ? undefined : conn.locked.get(table);
      if (table === undefined || locked === undefined) return { rows: [], rowCount: 0 };
      const updated: QueryResultRow = { ...locked };
      for (const [column, value] of assignmentsOf(sql, params)) updated[column] = value;
      conn.locked.set(table, updated);
      const returned = projectReturning(sql, updated, () => xidOf(conn));
      return { rows: returned === undefined ? [] : [returned], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  /** Applies transaction control and the tenant setting once the statement succeeded; returns the command tag. */
  function control(conn: Connection, sql: string, verb: string, params: readonly unknown[]): string {
    if (SET_TENANT.test(sql)) conn.tenantId = typeof params[0] === 'string' ? params[0] : '';
    switch (verb) {
      case 'BEGIN':
      case 'START':
        conn.inTransaction = true;
        return 'BEGIN';
      case 'COMMIT':
      case 'END': {
        // COMMIT of an aborted transaction rolls it back, and PostgreSQL tags it ROLLBACK.
        const failed = conn.aborted;
        if (!failed) commit(conn);
        endTransaction(conn);
        return failed ? 'ROLLBACK' : 'COMMIT';
      }
      case 'ROLLBACK': {
        if (!/^ROLLBACK TO\b/i.test(sql)) {
          endTransaction(conn);
          return 'ROLLBACK';
        }
        const index = savepointIndex(conn, sql);
        const savepoint = conn.savepoints[index] as Savepoint;
        conn.savepoints.length = index + 1;
        conn.pending.length = savepoint.writes;
        conn.gates = new Map(savepoint.gates);
        conn.operations = new Map(savepoint.operations);
        conn.settings = new Map(savepoint.settings);
        conn.aborted = false;
        return 'ROLLBACK';
      }
      case 'SAVEPOINT':
        conn.savepoints.push({
          name: unquote(/(\S+)$/.exec(sql)?.[1] ?? ''),
          writes: conn.pending.length,
          gates: new Map(conn.gates),
          operations: new Map(conn.operations),
          settings: new Map(conn.settings),
        });
        return 'SAVEPOINT';
      case 'RELEASE':
        conn.savepoints.length = savepointIndex(conn, sql);
        return 'RELEASE';
      default:
        return verb;
    }
  }

  async function run(conn: Connection, input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    if (ended) throw new Error(ENDED_POOL);
    const sql = collapse(typeof input === 'string' ? input : input.text);
    const params: unknown[] = [...((typeof input === 'string' ? undefined : input.values) ?? values ?? [])];
    const verbs = verbsOf(sql);
    const verb = verbs.main;
    const tenantId = conn.tenantId;
    statementLog.push({ sql, values: params, tenantId });
    if (conn.aborted && verb !== 'ROLLBACK' && verb !== 'COMMIT' && verb !== 'END') {
      throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
    }
    let answer: Answer;
    try {
      const responder = responders.findLast(([matcher]) => matches(matcher, sql, params));
      if (responder === undefined) {
        answer = builtIn(conn, sql, verb, params);
      } else {
        const [, rows] = responder;
        const answered = typeof rows === 'function' ? rows(sql, params) : rows;
        answer = { rows: answered.map((row) => ({ ...row })), rowCount: answered.length };
      }
    } catch (err) {
      if (conn.inTransaction) conn.aborted = true;
      throw err;
    }
    const writeVerb = verbs.all.find((candidate) => WRITE_VERBS.has(candidate)) as WriteVerb | undefined;
    if (writeVerb !== undefined) {
      const write: RecordedWrite = { sql, values: params, tenantId, table: writeTargets(sql)[0] ?? '', verb: writeVerb };
      if (conn.inTransaction) {
        xidOf(conn);
        conn.pending.push(write);
      } else {
        writeLog.push(write);
      }
    }
    const lockedRow = answer.rows[0];
    const lockedTable = verb === 'SELECT' && LOCKING_READ.test(sql) ? statementTable(sql) : undefined;
    if (lockedTable !== undefined && lockedRow !== undefined) conn.locked.set(lockedTable, { ...lockedRow });
    const command = control(conn, sql, verb, params);
    return { command, rowCount: answer.rowCount, oid: 0, fields: [], rows: answer.rows };
  }

  const fakePool = {
    async connect() {
      if (ended) throw new Error(ENDED_POOL);
      const conn = newConnection();
      return {
        query: (input: string | QueryConfig, values?: unknown[]): Promise<QueryResult> => run(conn, input, values),
        // A connection released mid-transaction is destroyed, which ends its transaction uncommitted.
        release: (): void => {
          if (conn.inTransaction) endTransaction(conn);
        },
      };
    },
    async end(): Promise<void> {
      ended = true;
    },
    on: (): void => undefined,
  };
  const base = tenantDbFromPool(fakePool as unknown as Pool, { schema: SCHEMA });

  // tenantDbFromPool freezes its TenantDb, so the recording members sit on an object that delegates to it.
  return {
    schema: base.schema,
    withTenant: (tenantId, fn) => base.withTenant(tenantId, fn),
    withMetadata: (fn, options) => base.withMetadata(fn, options),
    end: () => base.end(),
    respond(matcher, rows) {
      responders.push([matcher, rows]);
    },
    writes: () => writeLog.map((write) => ({ ...write, values: [...write.values] })),
    statements: () => statementLog.map((statement) => ({ ...statement, values: [...statement.values] })),
    clear() {
      statementLog = [];
      writeLog = [];
      responders.length = 0;
    },
    setGate(unit, state, phase = 'quiet') {
      committedGates.set(unit, checkedGate({ unit, state, holder_id: null, phase }));
    },
    gates: () => [...committedGates.values()].sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)).map(toUnitGate),
  };
}


// Memory repository

/** Row type of each identity table, by table name. */
export interface IdentityRowTypes {
  group_account: GroupAccountRow;
  user_account: UserAccountRow;
  credential: CredentialRow;
  login_state: LoginStateRow;
  membership: MembershipRow;
  permission: PermissionRow;
  user_address: GroupAddressRow;
  user_interest: GroupInterestRow;
  user_tag: GroupTagRow;
  user_favorite: GroupFavoriteRow;
  extend_data_user_activity: GroupExtendDataRow;
  user_strike: UserStrikeRow;
  remote_session: RemoteSessionRow;
  user_device: UserDeviceRow;
  redirect: RedirectRow;
  oauth_client: OAuthClientRow;
  oauth_token: OAuthTokenRow;
  trash: GroupTrashRow;
  session: SessionRow;
  csrf_claim: CsrfClaimRow;
  account_operation: AccountOperationRow;
  person_contact: PersonContactRow;
  aggregate_version: AggregateVersionRow;
}

/** Rows a {@link MemoryIdentityRepo} starts with; each row is stored under its own `tenant_id`. */
export interface IdentitySeed {
  accounts?: readonly UserAccountRow[];
  credentials?: readonly CredentialRow[];
  loginStates?: readonly LoginStateRow[];
  groups?: readonly GroupAccountRow[];
  memberships?: readonly MembershipRow[];
  permissions?: readonly PermissionRow[];
  groupAddresses?: readonly GroupAddressRow[];
  groupInterests?: readonly GroupInterestRow[];
  groupTags?: readonly GroupTagRow[];
  groupFavorites?: readonly GroupFavoriteRow[];
  groupExtendData?: readonly GroupExtendDataRow[];
  groupTrash?: readonly GroupTrashRow[];
  strikes?: readonly UserStrikeRow[];
  sessions?: readonly SessionRow[];
  csrfClaims?: readonly CsrfClaimRow[];
  accountOperations?: readonly AccountOperationRow[];
  oauthClients?: readonly OAuthClientRow[];
  oauthTokens?: readonly OAuthTokenRow[];
  redirects?: readonly RedirectRow[];
  remoteSessions?: readonly RemoteSessionRow[];
  devices?: readonly UserDeviceRow[];
  personContacts?: readonly PersonContactRow[];
  aggregateVersions?: readonly AggregateVersionRow[];
}

/** One mutation of the memory repository, as a changelog row records it: `before` for update and delete, `after` for insert and update. */
export interface MemoryWrite {
  readonly tenantId: string;
  readonly table: IdentityTableName;
  readonly op: ChangeOp;
  readonly key: Readonly<RepositoryRow>;
  readonly before?: Readonly<RepositoryRow>;
  readonly after?: Readonly<RepositoryRow>;
}

/** Repository members the memory store cannot honour without SQL; reading one throws. */
type Unimplemented =
  | 'base'
  | 'read'
  | 'insertAbsent'
  | 'deleteOne'
  | 'replaceOne';

/** The recording members of a {@link MemoryIdentityRepo}. */
interface MemoryExtras {
  /** Every mutation since creation or the last `clear`, in order. */
  writes(): MemoryWrite[];
  /** Empties `writes`; stored rows stay. */
  clear(): void;
  /** Copies of the stored rows of `table`, of one tenant or of all. */
  rows<T extends IdentityTableName>(table: T, tenantId?: string): IdentityRowTypes[T][];
}

/**
 * `IdentityRepository` over in-memory tables. Each helper sees only rows of `tx.tenantId`, waits on and honours the unit gates
 * through `tx` as the real repository does, and stores and returns copies. Mutations apply when the call settles and are not
 * undone when the transaction rolls back.
 */
export type MemoryIdentityRepo = IdentityRepository & MemoryExtras;

const SEED_TABLES: Readonly<Record<keyof IdentitySeed, IdentityTableName>> = {
  accounts: USER_ACCOUNT.table,
  credentials: CREDENTIAL.table,
  loginStates: LOGIN_STATE.table,
  groups: GROUP_ACCOUNT.table,
  memberships: MEMBERSHIP.table,
  permissions: PERMISSION.table,
  groupAddresses: GROUP_ADDRESS.table,
  groupInterests: GROUP_INTEREST.table,
  groupTags: GROUP_TAG.table,
  groupFavorites: GROUP_FAVORITE.table,
  groupExtendData: GROUP_EXTEND_DATA.table,
  groupTrash: GROUP_TRASH.table,
  strikes: USER_STRIKE.table,
  sessions: SESSION.table,
  csrfClaims: CSRF_CLAIM.table,
  accountOperations: ACCOUNT_OPERATION.table,
  oauthClients: OAUTH_CLIENT.table,
  oauthTokens: OAUTH_TOKEN.table,
  redirects: REDIRECT.table,
  remoteSessions: REMOTE_SESSION.table,
  devices: USER_DEVICE.table,
  personContacts: PERSON_CONTACT.table,
  aggregateVersions: AGGREGATE_VERSION.table,
};

/** Members of the real repository, so the memory one can tell an unimplemented member from any other property. */
const REPOSITORY_MEMBERS: ReadonlySet<string> = new Set(Object.keys(createIdentityRepository()));

/** Key columns of these tables are plain `text` or `char`; every other identity key column is legacy_char_ci or legacy_ci. */
const EXACT_KEY_TABLES: ReadonlySet<string> = new Set([SESSION.table, CSRF_CLAIM.table, ACCOUNT_OPERATION.table, AGGREGATE_VERSION.table]);

/** The states `account_operation_open_user_idx` and `account_operation_open_username_idx` cover. */
const OPEN_OPERATION_STATES: readonly AccountOperationState[] = ['prepared', 'committed'];
const ONE_MINUTE_MS = 60_000;
/** Width of the legacy `char(35)` id columns. */
const ID_WIDTH = 35;

/** DAO `cfqueryparam null="#value eq ''#"`: an empty string is stored as NULL. */
function daoNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** beanORM `addQueryParam`: a non-key value that is empty or the text `null` (any case) is stored as NULL. */
function ormRow<R extends RepositoryRow>(row: R, table: { key: readonly string[] | null }): R {
  const stored: RepositoryRow = {};
  for (const [column, value] of Object.entries(row)) {
    const empty = typeof value === 'string' && (value === '' || value.toLowerCase() === 'null');
    stored[column] = empty && !(table.key ?? []).includes(column) ? null : value;
  }
  return stored as R;
}

/** CFML boolean of a numeric flag; NULL reads as false. */
function flag(value: number | boolean | null): boolean {
  return value === true || (typeof value === 'number' && value !== 0);
}

/** A posted id the legacy `char(35)` column can hold. */
function storableId(value: string): boolean {
  return value !== '' && value.length <= ID_WIDTH;
}

/** `at` one calendar day earlier on the local wall clock, as CFML `dateAdd('d', -1, at)`. */
function dayBefore(at: Date): Date {
  const day = new Date(at.getTime());
  day.setDate(day.getDate() - 1);
  return day;
}

function storedAdminState(text: string | null): SessionAdminState {
  return text === null ? {} : (JSON.parse(text) as SessionAdminState);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** Defined values of `row` other than `tenant_id` and the columns in `skip`. */
function writable(row: Readonly<RepositoryRow>, skip: readonly string[] = []): RepositoryRow {
  return Object.fromEntries(Object.entries(row).filter(([column, value]) => value !== undefined && column !== 'tenant_id' && !skip.includes(column)));
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value.getTime());
}

/** The legacy_char_ci form of a value; null for NULL. */
function ci(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : charKey(value);
}

/** Equality under legacy_char_ci; NULL equals nothing. */
function ciEq(a: string | null | undefined, b: string | null | undefined): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && charKey(a) === charKey(b);
}

function isOpenState(state: unknown): boolean {
  return (OPEN_OPERATION_STATES as readonly unknown[]).includes(state);
}

/** `value COLLATE "C" ILIKE pattern ESCAPE ''`: `%` any run, `_` one character, ASCII letters folded, every other character literal. */
function cIlike(value: string, pattern: string): boolean {
  const fold = (text: string): string[] => Array.from(text.replace(/[A-Z]/g, (c) => c.toLowerCase()));
  const chars = fold(value);
  const wanted = fold(pattern);
  let i = 0;
  let j = 0;
  let star = -1;
  let resume = 0;
  while (i < chars.length) {
    if (wanted[j] === '%') {
      star = j;
      resume = i;
      j += 1;
    } else if (j < wanted.length && (wanted[j] === '_' || wanted[j] === chars[i])) {
      i += 1;
      j += 1;
    } else if (star !== -1) {
      resume += 1;
      i = resume;
      j = star + 1;
    } else {
      return false;
    }
  }
  while (wanted[j] === '%') j += 1;
  return j === wanted.length;
}

type Order<R> = (a: R, b: R) => number;

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** An ORDER BY term; NULLs sort last ascending and first descending unless `nulls` says otherwise, as in PostgreSQL. */
function by<R>(value: (row: R) => unknown, opts: { desc?: boolean; nulls?: 'first' | 'last' } = {}): Order<R> {
  const desc = opts.desc === true;
  const nullsFirst = (opts.nulls ?? (desc ? 'first' : 'last')) === 'first';
  return (a, b) => {
    const x = value(a);
    const y = value(b);
    const xNull = x === null || x === undefined;
    const yNull = y === null || y === undefined;
    if (xNull || yNull) return xNull && yNull ? 0 : xNull === nullsFirst ? -1 : 1;
    const order = compareValues(x, y);
    return desc ? -order : order;
  };
}

function sorted<R>(rows: readonly R[], ...orders: Order<R>[]): R[] {
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const result = order(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
}

/** Item texts of `jsonb_array_elements_text(text::jsonb -> path…)`; none for NULL or when the path holds no array. */
function jsonTexts(text: string | null, path: readonly string[]): string[] {
  if (text === null) return [];
  let node: unknown = JSON.parse(text);
  for (const step of path) node = typeof node === 'object' && node !== null && !Array.isArray(node) ? (node as Record<string, unknown>)[step] : undefined;
  if (!Array.isArray(node)) return [];
  return node.flatMap((item: unknown) => (item === null ? [] : [typeof item === 'object' ? JSON.stringify(item) : String(item)]));
}


/**
 * Creates a {@link MemoryIdentityRepo} holding `seed`; `options` are those of `createIdentityRepository`.
 * Throws the pg unique violation when two seed rows share a key or a unique index.
 */
export function createMemoryIdentityRepo(seed: IdentitySeed = {}, options: IdentityRepositoryOptions = {}): MemoryIdentityRepo {
  const { clock = systemClock, schema = SCHEMA, pageSize = READ_PAGE_SIZE } = options;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize must be a positive integer, not ${pageSize}`);
  /** Table → tenant → stored key → row. */
  const store = new Map<string, Map<string, Map<string, RepositoryRow>>>();
  const sequences = new Map<string, number>();
  let changes: MemoryWrite[] = [];

  function definition(table: string): IdentityTableDefinition {
    const def = DEFINITIONS.get(table);
    if (def === undefined) throw new RepositoryError(`is not a declared table of schema ${schema}`, table);
    return def;
  }

  function tenantRows(table: string, tenantId: string): Map<string, RepositoryRow> {
    let tenants = store.get(table);
    if (tenants === undefined) {
      tenants = new Map();
      store.set(table, tenants);
    }
    let rows = tenants.get(tenantId);
    if (rows === undefined) {
      rows = new Map();
      tenants.set(tenantId, rows);
    }
    return rows;
  }

  /** Stored rows of `table` in `tenantId` that `where` accepts; internal references, copied before they leave the repository. */
  function scan<T extends IdentityTableName>(table: T, tenantId: string, where: (row: IdentityRowTypes[T]) => boolean = () => true): IdentityRowTypes[T][] {
    return ([...tenantRows(table, tenantId).values()] as unknown as IdentityRowTypes[T][]).filter(where);
  }

  /** The stored key of `row`, folded as the key columns' collation compares them. */
  function keyOf(def: TableDefinition, row: Readonly<RepositoryRow>): string {
    const exact = EXACT_KEY_TABLES.has(def.table);
    return JSON.stringify((def.key ?? []).map((column) => {
      const value = row[column];
      return typeof value === 'string' && !exact ? charKey(value) : (value ?? null);
    }));
  }

  function find<T extends IdentityTableName>(def: IdentityTableDefinition<T>, tenantId: string, key: Readonly<RepositoryRow>): IdentityRowTypes[T] | undefined {
    return tenantRows(def.table, tenantId).get(keyOf(def, key)) as IdentityRowTypes[T] | undefined;
  }

  function checkColumns(def: TableDefinition, tenantId: string, row: Readonly<RepositoryRow>): void {
    const undeclared = Object.keys(row).find((column) => !def.columns.some((declared) => declared.name === column));
    if (undeclared !== undefined) throw new RepositoryError(`has no column ${undeclared}`, def.table);
    const tenant = row.tenant_id;
    if (tenant !== undefined && tenant !== null && String(tenant).toLowerCase() !== tenantId) {
      throw new RepositoryError(`row tenant ${String(tenant)} is not the transaction tenant ${tenantId}`, def.table);
    }
  }

  function checkKey(def: TableDefinition, key: Readonly<RepositoryRow>): void {
    const missing = (def.key ?? []).find((column) => key[column] === undefined || key[column] === null);
    if (missing !== undefined) throw new RepositoryError(`key has no value for ${missing}`, def.table);
  }

  /** Throws the pg unique violation `row` raises against the other stored rows; `self` is the stored key of the row it replaces. */
  function checkUnique(def: TableDefinition, tenantId: string, row: Readonly<RepositoryRow>, self?: string): void {
    const rows = tenantRows(def.table, tenantId);
    const id = keyOf(def, row);
    if (id !== self && rows.has(id)) throw uniqueViolation(def.table, `${def.table}_pkey`);
    if (def.table === SESSION.table) {
      // UNIQUE (session_id) spans tenants, which RLS hides from each other but the index does not.
      for (const [tenant, sessions] of store.get(SESSION.table) ?? []) {
        for (const [stored, other] of sessions) {
          if ((tenant !== tenantId || stored !== self) && other.session_id === row.session_id) {
            throw uniqueViolation(def.table, `${def.table}_session_id_key`);
          }
        }
      }
    }
    if (def.table === ACCOUNT_OPERATION.table && isOpenState(row.state)) {
      for (const [stored, other] of rows) {
        if (stored === self || !isOpenState(other.state)) continue;
        if (ciEq(text(other.user_id), text(row.user_id))) throw uniqueViolation(def.table, 'account_operation_open_user_idx');
        if (ciEq(text(other.username), text(row.username))) throw uniqueViolation(def.table, 'account_operation_open_username_idx');
      }
    }
  }

  /** `row` as pg returns it: every declared column, the transaction tenant, int8 columns as decimal text. */
  function storedRow(def: TableDefinition, tenantId: string, row: Readonly<RepositoryRow>): RepositoryRow {
    const stored: RepositoryRow = {};
    for (const { name } of def.columns) stored[name] = name === 'tenant_id' ? tenantId : pgValue(def.table, name, row[name] ?? null);
    return copyRow(stored);
  }

  /** Stores `row` as a new row of `tenantId`, raising the pg error a NULL or repeated key raises. */
  function place(def: TableDefinition, tenantId: string, row: Readonly<RepositoryRow>): RepositoryRow {
    const stored = storedRow(def, tenantId, row);
    const missing = (def.key ?? []).find((column) => stored[column] === null);
    if (missing !== undefined) {
      throw pgError('23502', `null value in column "${missing}" of relation "${def.table}" violates not-null constraint`, {
        schema,
        table: def.table,
        column: missing,
      });
    }
    checkUnique(def, tenantId, stored);
    tenantRows(def.table, tenantId).set(keyOf(def, stored), stored);
    return stored;
  }

  function log(tenantId: string, def: TableDefinition, op: ChangeOp, before?: RepositoryRow, after?: RepositoryRow): void {
    const source = after ?? before ?? {};
    changes.push({
      tenantId,
      table: def.table as IdentityTableName,
      op,
      key: Object.fromEntries((def.key ?? []).map((column) => [column, source[column] ?? null])),
      ...(before === undefined ? {} : { before: copyRow(before) }),
      ...(after === undefined ? {} : { after: copyRow(after) }),
    });
  }

  function insertNow(def: TableDefinition, tenantId: string, row: Readonly<RepositoryRow>): RepositoryRow {
    const stored = place(def, tenantId, row);
    log(tenantId, def, 'insert', undefined, stored);
    return copyRow(stored);
  }

  /** Applies the patch `patchOf` computes from the stored row with `key`; undefined when no row has it or `patchOf` returns null. */
  function patchNow(
    def: TableDefinition,
    tenantId: string,
    key: Readonly<RepositoryRow>,
    patchOf: (current: Readonly<RepositoryRow>) => RepositoryRow | null,
  ): RepositoryRow | undefined {
    const rows = tenantRows(def.table, tenantId);
    const id = keyOf(def, key);
    const before = rows.get(id);
    if (before === undefined) return undefined;
    const patch = patchOf(before);
    if (patch === null) return undefined;
    checkColumns(def, tenantId, patch);
    const after = storedRow(def, tenantId, { ...before, ...writable(patch) });
    checkUnique(def, tenantId, after, id);
    const next = keyOf(def, after);
    if (next !== id) rows.delete(id);
    rows.set(next, after);
    log(tenantId, def, 'update', before, after);
    return copyRow(after);
  }

  function removeNow(def: TableDefinition, tenantId: string, key: Readonly<RepositoryRow>): RepositoryRow | undefined {
    const rows = tenantRows(def.table, tenantId);
    const id = keyOf(def, key);
    const removed = rows.get(id);
    if (removed === undefined) return undefined;
    rows.delete(id);
    log(tenantId, def, 'delete', removed);
    return copyRow(removed);
  }

  /** The next value of a child id sequence, descending from -1 as 0005_child_id_sequences.sql declares. */
  function nextId(def: TableDefinition, column: string): number {
    const key = `${def.table}.${column}`;
    const next = (sequences.get(key) ?? 0) - 1;
    sequences.set(key, next);
    return next;
  }

  /** The transaction tenant, after the real repository's guard: an open tenant transaction on this schema. */
  function tenantOf(tx: TenantTx): string {
    requireTenantTx();
    if ((tx as { kind?: unknown } | undefined)?.kind !== 'tenant' || tx.schema !== schema) {
      throw new RepositoryError(`needs a tenant transaction on schema ${schema}`);
    }
    return tx.tenantId;
  }

  /** Takes the write gate of `def`'s unit in `tx`, unless a migration authority passes it. */
  async function writeGate(tx: TenantTx, def: TableDefinition, ctx: WriteContext): Promise<void> {
    if (def.unit !== undefined && !isMigrationAuthority(ctx.authority)) await acquireWriteGates(tx, [def.unit]);
  }

  /** The transaction tenant once no window phase blocks reading `units`; a migration apply's `ctx` reads without the wait. */
  async function gated(tx: TenantTx, units: readonly string[], ctx?: WriteContext): Promise<string> {
    const tenantId = tenantOf(tx);
    if (ctx?.authority === undefined) await awaitReadable(tx, units);
    return tenantId;
  }

  // The generic platform members are served too, because domain code writes trash, redirect and credential rows through them.
  async function insert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    const tenantId = tenantOf(tx);
    const def = definition(table);
    checkColumns(def, tenantId, row);
    await writeGate(tx, def, ctx);
    return insertNow(def, tenantId, writable(row)) as R;
  }

  /** `update` whose patch `patchOf` computes from the row as stored when the write runs; null when absent or refused. */
  async function updateWhere(
    tx: TenantTx,
    table: string,
    key: RepositoryRow,
    patchOf: (current: Readonly<RepositoryRow>) => RepositoryRow | null,
    ctx: WriteContext,
  ): Promise<RepositoryRow | null> {
    const tenantId = tenantOf(tx);
    const def = definition(table);
    checkColumns(def, tenantId, key);
    checkKey(def, key);
    await writeGate(tx, def, ctx);
    return patchNow(def, tenantId, key, patchOf) ?? null;
  }

  async function update<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, patch: RepositoryRow, ctx: WriteContext = {}): Promise<R | null> {
    const def = definition(table);
    checkColumns(def, tenantOf(tx), patch);
    const values = writable(patch);
    if (Object.keys(values).length === 0) throw new RepositoryError('update patch sets no column', table);
    return (await updateWhere(tx, table, key, () => values, ctx)) as R | null;
  }

  async function upsert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    const tenantId = tenantOf(tx);
    const def = definition(table);
    checkColumns(def, tenantId, row);
    checkKey(def, row);
    const values = writable(row);
    await writeGate(tx, def, ctx);
    const current = tenantRows(def.table, tenantId).get(keyOf(def, values));
    if (current === undefined) return insertNow(def, tenantId, values) as R;
    const set = writable(values, def.key ?? []);
    if (Object.keys(set).length === 0) return copyRow(current) as R;
    return patchNow(def, tenantId, values, () => set) as R;
  }

  async function remove<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, ctx: WriteContext = {}): Promise<R | null> {
    const tenantId = tenantOf(tx);
    const def = definition(table);
    checkColumns(def, tenantId, key);
    checkKey(def, key);
    await writeGate(tx, def, ctx);
    return (removeNow(def, tenantId, key) ?? null) as R | null;
  }

  async function findByKey<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow): Promise<R | null> {
    const tenantId = tenantOf(tx);
    const def = definition(table);
    checkColumns(def, tenantId, key);
    checkKey(def, key);
    if (def.unit !== undefined) await awaitReadable(tx, [def.unit]);
    const row = tenantRows(def.table, tenantId).get(keyOf(def, key));
    return (row === undefined ? null : copyRow(row)) as R | null;
  }

  /** Deletes each row of `keys` through `remove`; returns how many existed. */
  async function removeKeys(tx: TenantTx, table: string, keys: readonly RepositoryRow[], ctx: WriteContext): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if ((await remove(tx, table, key, ctx)) !== null) removed += 1;
    }
    return removed;
  }


  const byUserid = by<{ userid: string }>((row) => charKey(row.userid));

  async function findAccountsByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow[]> {
    const tenantId = await gated(tx, [USER_ACCOUNT.unit]);
    const wanted = charKey(javaTrim(username));
    const rows = scan(
      USER_ACCOUNT.table,
      tenantId,
      (row) =>
        row.type === 2 &&
        row.inactive === 0 &&
        row.opt2_state === 'active' &&
        ci(row.username) === wanted &&
        (poolSiteId === undefined || ciEq(row.siteid, poolSiteId)),
    );
    return sorted(rows, byUserid).map(copyRow);
  }

  async function findAccountByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow | null> {
    return (await findAccountsByUsername(tx, username, poolSiteId))[0] ?? null;
  }

  async function findAccountById(
    tx: TenantTx,
    userId: string,
    opts: { includePending?: boolean } = {},
    ctx?: WriteContext,
  ): Promise<UserAccountRow | null> {
    const tenantId = await gated(tx, [USER_ACCOUNT.unit], ctx);
    const row = find(USER_ACCOUNT, tenantId, { userid: userId });
    return row !== undefined && (row.opt2_state === 'active' || opts.includePending === true) ? copyRow(row) : null;
  }

  /** The users of `tenantId` an open account operation keeps closed, by user id key. */
  function closedUserKeys(tenantId: string): Set<string> {
    return new Set(scan(ACCOUNT_OPERATION.table, tenantId, (operation) => isOpenState(operation.state)).map((operation) => charKey(operation.user_id)));
  }

  /** `units` plus the membership unit an `unassigned` filter reads. */
  function filterUnits(units: readonly string[], filter: AccountFilter | undefined): string[] {
    return filter?.unassigned === undefined ? [...units] : [...units, MEMBERSHIP.unit];
  }

  /** Whether account `row` of `tenantId` passes `filter`; a NULL column fails every given predicate, as SQL Server's comparisons do. */
  function passesFilter(row: UserAccountRow, tenantId: string, filter: AccountFilter = {}): boolean {
    const { unassigned } = filter;
    const held = (): boolean => scan(MEMBERSHIP.table, tenantId, (membership) => ciEq(membership.userid, row.userid)).length > 0;
    return (
      (filter.isPublic === undefined || row.ispublic === filter.isPublic) &&
      (filter.s2 === undefined || row.s2 === filter.s2) &&
      (filter.excludeS2Users !== true || (row.s2 !== null && row.s2 !== 1)) &&
      (filter.inActive === undefined || row.inactive === filter.inActive) &&
      (filter.siteIds === undefined || filter.siteIds.some((siteId) => ciEq(row.siteid, siteId))) &&
      (unassigned === undefined || (!(unassigned.ownMemberships && held()) && !unassigned.assignedElsewhere.some((userId) => ciEq(userId, row.userid))))
    );
  }

  /** The Type=2 accounts of `tenantId`, of pool site `siteId` unless null. */
  function scopedAccounts(tenantId: string, siteId: string | null, where: (row: UserAccountRow) => boolean = () => true): UserAccountRow[] {
    return scan(USER_ACCOUNT.table, tenantId, (row) => row.type === 2 && (siteId === null || ciEq(row.siteid, siteId)) && where(row));
  }

  async function readAccountRecords(tx: TenantTx, userIds: readonly string[], filter?: AccountFilter): Promise<AccountRecordRow[]> {
    const tenantId = await gated(tx, filterUnits([USER_ACCOUNT.unit, CREDENTIAL.unit, LOGIN_STATE.unit], filter));
    const wanted = new Set(userIds.map(charKey));
    const closed = closedUserKeys(tenantId);
    // A closed account is read whatever the filter, so the caller still waits for it.
    const accounts = scan(
      USER_ACCOUNT.table,
      tenantId,
      (row) => row.type === 2 && wanted.has(charKey(row.userid)) && (filter === undefined || closed.has(charKey(row.userid)) || passesFilter(row, tenantId, filter)),
    );
    return sorted(accounts, byUserid).map((row) => {
      const { tenant_id: _tenantId, ...account } = copyRow(row);
      return {
        ...account,
        passwordcreated: copyDate(find(CREDENTIAL, tenantId, { userid: row.userid })?.passwordcreated ?? null),
        lastlogin: copyDate(find(LOGIN_STATE, tenantId, { userid: row.userid })?.lastlogin ?? null),
        closed: closed.has(charKey(row.userid)),
      };
    });
  }

  async function countListedAccounts(tx: TenantTx, scope: { siteId: string | null; filter?: AccountFilter }): Promise<ListedAccountCount> {
    const tenantId = await gated(tx, filterUnits([USER_ACCOUNT.unit], scope.filter));
    const count = scopedAccounts(tenantId, scope.siteId, (row) => row.opt2_state === 'active' && passesFilter(row, tenantId, scope.filter)).length;
    const scoped = new Set(scopedAccounts(tenantId, scope.siteId).map((row) => charKey(row.userid)));
    const operations = scan(ACCOUNT_OPERATION.table, tenantId, (operation) => isOpenState(operation.state) && scoped.has(charKey(operation.user_id)));
    return { count, closed: sorted(operations.map((operation) => operation.user_id), by(charKey)) };
  }

  async function readUsernameCandidates(
    tx: TenantTx,
    query: { siteId: string; pattern: string; filter?: AccountFilter; limit: number },
  ): Promise<UsernameCandidateRow[]> {
    const tenantId = await gated(tx, filterUnits([USER_ACCOUNT.unit], query.filter));
    const closed = closedUserKeys(tenantId);
    const matched = scopedAccounts(tenantId, query.siteId, (row) => row.opt2_state === 'active' && passesFilter(row, tenantId, query.filter)).filter(
      (row): row is UserAccountRow & { username: string } => row.username !== null && cIlike(row.username, query.pattern),
    );
    return sorted(matched, byUserid)
      .slice(0, query.limit)
      .map(({ userid, username }) => ({ userid, username, closed: closed.has(charKey(userid)) }));
  }

  async function foreignMemberIds(tx: TenantTx, userIds: readonly string[] | null): Promise<string[]> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit, USER_ACCOUNT.unit, GROUP_ACCOUNT.unit]);
    const wanted = userIds === null ? null : new Set(userIds.map(charKey));
    const foreign = new Map<string, string>();
    for (const membership of scan(MEMBERSHIP.table, tenantId, (row) => wanted === null || wanted.has(charKey(row.userid)))) {
      const stored = find(USER_ACCOUNT, tenantId, { userid: membership.userid }) ?? find(GROUP_ACCOUNT, tenantId, { userid: membership.userid });
      if (stored === undefined && !foreign.has(charKey(membership.userid))) foreign.set(charKey(membership.userid), membership.userid);
    }
    return sorted([...foreign.values()], by(charKey));
  }

  async function readMembershipRecords(tx: TenantTx, userIds: readonly string[]): Promise<MembershipRecords> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit]);
    const wanted = new Set(userIds.map(charKey));
    const rows = scan(MEMBERSHIP.table, tenantId, (row) => wanted.has(charKey(row.userid)));
    const operations = scan(ACCOUNT_OPERATION.table, tenantId, (operation) => isOpenState(operation.state) && wanted.has(charKey(operation.user_id)));
    return {
      rows: sorted(rows, byUserid, by((row) => charKey(row.groupid))).map(({ userid, groupid }) => ({ userid, groupid })),
      closed: sorted(operations.map((operation) => operation.user_id), by(charKey)),
    };
  }

  async function isUsernameTaken(tx: TenantTx, username: string, exceptUserId: string): Promise<boolean> {
    const tenantId = await gated(tx, [USER_ACCOUNT.unit]);
    const wanted = charKey(javaTrim(username));
    const except = charKey(javaTrim(exceptUserId));
    return scan(USER_ACCOUNT.table, tenantId, (row) => row.type === 2 && ci(row.username) === wanted && charKey(row.userid) !== except).length > 0;
  }

  function insertAccount(tx: TenantTx, row: AccountInput, ctx: WriteContext = {}): Promise<UserAccountRow> {
    const stored: Omit<UserAccountRow, 'tenant_id'> = {
      userid: row.userid,
      username: daoNull(row.username),
      type: row.type,
      admin: row.admin ?? null,
      s2: row.s2,
      perm: row.perm,
      inactive: row.inactive,
      ispublic: row.ispublic,
      siteid: daoNull(row.siteid),
      remoteid: daoNull(row.remoteid),
      tablist: daoNull(row.tablist),
      opt2_state: row.opt2_state ?? 'active',
    };
    return insert<UserAccountRow>(tx, USER_ACCOUNT.table, stored, ctx);
  }

  function updateAccount(tx: TenantTx, userId: string, values: AccountUpdate, ctx: WriteContext = {}): Promise<UserAccountRow | null> {
    const patch: AccountUpdate = {
      remoteid: daoNull(values.remoteid),
      s2: values.s2,
      type: values.type,
      inactive: values.inactive,
      username: daoNull(values.username),
      ispublic: values.ispublic,
      // userDAO.update writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
      siteid: javaTrim(values.siteid ?? ''),
      tablist: daoNull(values.tablist),
    };
    return update<UserAccountRow>(tx, USER_ACCOUNT.table, { userid: userId }, patch, ctx);
  }

  function setAccountState(tx: TenantTx, userId: string, state: UserAccountRow['opt2_state'], ctx: WriteContext = {}): Promise<UserAccountRow | null> {
    return update<UserAccountRow>(tx, USER_ACCOUNT.table, { userid: userId }, { opt2_state: state }, ctx);
  }

  async function deleteAccount(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<boolean> {
    const account = await remove(tx, USER_ACCOUNT.table, { userid: userId }, ctx);
    await remove(tx, CREDENTIAL.table, { userid: userId }, ctx);
    await remove(tx, LOGIN_STATE.table, { userid: userId }, ctx);
    return account !== null;
  }

  function readCredential(tx: TenantTx, userId: string): Promise<CredentialRow | null> {
    return findByKey<CredentialRow>(tx, CREDENTIAL.table, { userid: userId });
  }

  function writeCredential(tx: TenantTx, userId: string, values: CredentialValues, ctx: WriteContext = {}): Promise<CredentialRow> {
    return upsert<CredentialRow>(tx, CREDENTIAL.table, { userid: userId, password: daoNull(values.password), passwordcreated: values.passwordcreated }, ctx);
  }

  function touchLastLogin(tx: TenantTx, userId: string, at: Date, ctx: WriteContext = {}): Promise<LoginStateRow> {
    return upsert<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId, lastlogin: at }, ctx);
  }

  function insertLoginState(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<LoginStateRow> {
    return insert<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId, lastlogin: null }, ctx);
  }

  function findGroup(tx: TenantTx, groupId: string): Promise<GroupAccountRow | null> {
    return findByKey<GroupAccountRow>(tx, GROUP_ACCOUNT.table, { userid: groupId });
  }

  async function findGroupsByIds(tx: TenantTx, groupIds: readonly string[]): Promise<GroupAccountRow[]> {
    if (groupIds.length === 0) return [];
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const wanted = new Set(groupIds.map(charKey));
    return sorted(scan(GROUP_ACCOUNT.table, tenantId, (row) => wanted.has(charKey(row.userid))), byUserid).map(copyRow);
  }

  async function findGroupByName(tx: TenantTx, groupName: string, opts: { siteId: string; isPublic?: boolean }): Promise<GroupAccountRow | null> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const visibility = opts.isPublic === undefined ? null : opts.isPublic ? 1 : 0;
    const found = scan(
      GROUP_ACCOUNT.table,
      tenantId,
      (row) =>
        row.type === 1 && ci(row.groupname) === charKey(groupName) && ciEq(row.siteid, opts.siteId) && (visibility === null || row.ispublic === visibility),
    );
    const first = sorted(found, byUserid)[0];
    return first === undefined ? null : copyRow(first);
  }

  async function findGroupsByColumn(
    tx: TenantTx,
    column: 'groupname' | 'username' | 'remoteid',
    value: string,
    siteIds: readonly string[],
  ): Promise<GroupAccountRow[]> {
    if (siteIds.length === 0) return [];
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const found = scan(
      GROUP_ACCOUNT.table,
      tenantId,
      (row) => ci(row[column]) === charKey(value) && siteIds.includes(row.siteid ?? '') && (column !== 'groupname' || row.type === 1),
    );
    return sorted(found, byUserid).map(copyRow);
  }

  async function countAccountsByColumn(tx: TenantTx, column: 'username' | 'remoteid', value: string, siteIds: readonly string[]): Promise<number> {
    if (siteIds.length === 0) return 0;
    const tenantId = await gated(tx, [USER_ACCOUNT.unit]);
    return scan(USER_ACCOUNT.table, tenantId, (row) => ci(row[column]) === charKey(value) && siteIds.includes(row.siteid ?? '')).length;
  }

  /** Type=1 groups of `poolSiteId` with that visibility, by lowered name (NULL first) then userid. */
  function groupsOf(tenantId: string, poolSiteId: string, isPublic: boolean | number, excludeAdmin: boolean): GroupAccountRow[] {
    const visibility = flag(isPublic) ? 1 : 0;
    // A NULL groupname fails `<> 'Admin'` in SQL Server too, so it is excluded with the Admin groups.
    const rows = scan(
      GROUP_ACCOUNT.table,
      tenantId,
      (row) =>
        row.type === 1 &&
        row.ispublic === visibility &&
        ciEq(row.siteid, poolSiteId) &&
        (!excludeAdmin || (row.groupname !== null && row.groupname.replace(/ +$/, '').toLowerCase() !== 'admin')),
    );
    return sorted(
      rows,
      by((row) => row.groupname?.toLowerCase() ?? null, { nulls: 'first' }),
      byUserid,
    );
  }

  async function listGroups(
    tx: TenantTx,
    poolSiteId: string,
    isPublic: boolean | number,
    opts: { excludeAdmin?: boolean } = {},
  ): Promise<GroupAccountRow[]> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    return groupsOf(tenantId, poolSiteId, isPublic, opts.excludeAdmin === true).map(copyRow);
  }

  async function listCountedGroups(tx: TenantTx, poolSiteId: string, isPublic: boolean | number): Promise<CountedGroupList> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit, MEMBERSHIP.unit, USER_ACCOUNT.unit]);
    const listed = groupsOf(tenantId, poolSiteId, isPublic, false);
    const listedIds = new Set(listed.map((group) => charKey(group.userid)));
    const counts = new Map<string, number>();
    for (const membership of scan(MEMBERSHIP.table, tenantId, (row) => listedIds.has(charKey(row.groupid)))) {
      // Members of either Type count: an active account and a member group each add one.
      const account = find(USER_ACCOUNT, tenantId, { userid: membership.userid });
      const counted = (account?.opt2_state === 'active' ? 1 : 0) + (find(GROUP_ACCOUNT, tenantId, { userid: membership.userid }) === undefined ? 0 : 1);
      const groupKey = charKey(membership.groupid);
      if (counted > 0) counts.set(groupKey, (counts.get(groupKey) ?? 0) + counted);
    }
    const groups: CountedGroupRow[] = listed.map((group) => ({ ...copyRow(group), counter: counts.get(charKey(group.userid)) ?? null }));
    // The closure rides on the listed rows, so a listing without groups names no closing user.
    const closed = groups.length === 0 ? [] : affectingUsers(tenantId, (groupId) => listedIds.has(charKey(groupId)));
    return { groups: closed.length > 0 ? groups.slice(0, pageSize) : groups, closed };
  }

  async function pageCountedGroups(tx: TenantTx, poolSiteId: string, isPublic: boolean | number, page: ListPage): Promise<CountedGroupPage> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit, MEMBERSHIP.unit, USER_ACCOUNT.unit]);
    // SQL Server sorts a NULL Perm last under DESC; the name order breaks ties.
    const listed = sorted(
      groupsOf(tenantId, poolSiteId, isPublic, false),
      by((row) => row.perm, { desc: true, nulls: 'last' }),
      by((row) => row.groupname?.toLowerCase() ?? null, { nulls: 'first' }),
      byUserid,
    );
    const windowed = listed.slice(page.offset, page.offset + page.limit);
    const windowIds = new Set(windowed.map((group) => charKey(group.userid)));
    const counts = new Map<string, number>();
    for (const membership of scan(MEMBERSHIP.table, tenantId, (row) => windowIds.has(charKey(row.groupid)))) {
      const account = find(USER_ACCOUNT, tenantId, { userid: membership.userid });
      const counted = (account?.opt2_state === 'active' ? 1 : 0) + (find(GROUP_ACCOUNT, tenantId, { userid: membership.userid }) === undefined ? 0 : 1);
      const groupKey = charKey(membership.groupid);
      if (counted > 0) counts.set(groupKey, (counts.get(groupKey) ?? 0) + counted);
    }
    const groups: CountedGroupRow[] = windowed.map((group) => ({ ...copyRow(group), counter: counts.get(charKey(group.userid)) ?? null }));
    // The closure rides on the window's groups, so a window without groups names no closing user.
    const closed = groups.length === 0 ? [] : affectingUsers(tenantId, (groupId) => windowIds.has(charKey(groupId)));
    return { groups, total: listed.length, closed };
  }

  async function* groupFeedPages(
    tx: TenantTx,
    poolSiteId: string,
    isPublic: boolean | number,
    opts: { includeS2?: boolean; inactive?: number } = {},
  ): AsyncGenerator<GroupAccountRow[], void, undefined> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const visibility = flag(isPublic) ? 1 : 0;
    // A NULL s2 or inactive matches neither filter, as in SQL.
    const rows = scan(
      GROUP_ACCOUNT.table,
      tenantId,
      (row) =>
        row.type === 1 &&
        row.ispublic === visibility &&
        ciEq(row.siteid, poolSiteId) &&
        (opts.includeS2 === true || row.s2 === 0) &&
        (opts.inactive === undefined || row.inactive === opts.inactive),
    );
    const ordered = sorted(rows, byUserid);
    for (let start = 0; start < ordered.length; start += pageSize) yield ordered.slice(start, start + pageSize).map(copyRow);
  }

  /** readGroupFeed with the feed's own row tests and order, which its SQL reproduces. */
  async function readGroupFeed(tx: TenantTx, poolSiteId: string, isPublic: boolean | number, query: GroupFeedQuery): Promise<GroupFeedPage> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const visibility = flag(isPublic) ? 1 : 0;
    const groups: Array<Array<(row: GroupAccountRow) => boolean>> = [];
    query.filters.forEach(({ relationship, condition }, i) => {
      if (i === 0 || relationship === 'or') groups.push([conditionTest(condition)]);
      else groups.at(-1)?.push(conditionTest(condition));
    });
    const rows = scan(
      GROUP_ACCOUNT.table,
      tenantId,
      (row) =>
        row.type === 1 &&
        row.ispublic === visibility &&
        ciEq(row.siteid, poolSiteId) &&
        (query.includeS2 === true || row.s2 === 0) &&
        (query.inactive === undefined || row.inactive === query.inactive) &&
        (groups.length === 0 || groups.some((group) => group.every((test) => test(row)))),
    );
    const ordered = [...rows].sort((a, b) => feedOrder(query.order, a, b));
    return { rows: ordered.slice(0, query.limit).map(copyRow), total: Math.min(ordered.length, query.top) };
  }

  async function listPoolGroups(tx: TenantTx, poolSiteId: string, isPublic: 0 | 1): Promise<PoolGroupRow[]> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const rows = scan(GROUP_ACCOUNT.table, tenantId, (row) => row.type === 1 && row.ispublic === isPublic && ciEq(row.siteid, poolSiteId));
    return sorted(
      rows,
      by((row) => row.perm, { desc: true, nulls: 'last' }),
      by((row) => row.groupname?.toLowerCase() ?? null, { nulls: 'first' }),
      byUserid,
    ).map((row) => ({ userid: row.userid, groupname: row.groupname, siteid: row.siteid ?? poolSiteId, ispublic: isPublic, perm: row.perm }));
  }

  /** The person contact naming an actor that has no login snapshot. */
  async function actorContact(tx: TenantTx, actor: AuditActor | null): Promise<AuditNames | null> {
    return actor === null || actor.fromSnapshot ? null : findPersonContact(tx, actor.userId);
  }

  async function insertGroup(tx: TenantTx, input: GroupInput, actor: AuditActor | null, ctx: WriteContext = {}): Promise<GroupAccountRow> {
    const userid = input.userid === undefined || input.userid === '' ? cfUuid() : input.userid;
    const audit = lastUpdateInfo(actor, { userid, fname: input.fname, lname: input.lname }, await actorContact(tx, actor));
    const now = clock.now();
    const row: Omit<GroupAccountRow, 'tenant_id' | 'row_version'> & { row_version: number } = {
      userid,
      groupname: daoNull(input.groupname),
      fname: daoNull(input.fname),
      lname: daoNull(input.lname),
      username: daoNull(input.username),
      password: daoNull(input.password),
      passwordcreated: now,
      email: daoNull(input.email),
      company: daoNull(input.company),
      jobtitle: daoNull(input.jobtitle),
      mobilephone: daoNull(input.mobilephone),
      website: daoNull(input.website),
      type: input.type,
      subtype: daoNull(input.subtype),
      ext: null,
      contactform: daoNull(input.contactform),
      admin: null,
      s2: input.s2,
      lastlogin: null,
      lastupdate: now,
      lastupdateby: daoNull(audit.lastupdateby),
      lastupdatebyid: daoNull(audit.lastupdatebyid),
      perm: input.perm,
      inactive: input.inactive,
      ispublic: input.ispublic,
      siteid: daoNull(input.siteid),
      subscribe: input.subscribe,
      notes: daoNull(input.notes),
      description: daoNull(input.description),
      interests: daoNull(input.interests),
      keepprivate: input.keepprivate,
      photofileid: daoNull(input.photofileid),
      imname: daoNull(input.imname),
      imservice: daoNull(input.imservice),
      created: now,
      remoteid: daoNull(input.remoteid),
      tags: daoNull(input.tags),
      tablist: daoNull(input.tablist),
      row_version: 1,
    };
    return insert<GroupAccountRow>(tx, GROUP_ACCOUNT.table, row, ctx);
  }

  async function updateGroup(
    tx: TenantTx,
    groupId: string,
    input: GroupUpdate,
    actor: AuditActor | null,
    ctx: WriteContext = {},
  ): Promise<GroupAccountRow | null> {
    const tenantId = await gated(tx, [GROUP_ACCOUNT.unit]);
    const current = find(GROUP_ACCOUNT, tenantId, { userid: groupId });
    if (current === undefined) return null;
    const audit = lastUpdateInfo(actor, { userid: current.userid, fname: input.fname, lname: input.lname }, await actorContact(tx, actor));
    const now = clock.now();
    const password = input.password ?? '';
    const patch: RepositoryRow = {
      remoteid: daoNull(input.remoteid),
      fname: daoNull(input.fname),
      lname: daoNull(input.lname),
      groupname: daoNull(input.groupname),
      email: daoNull(input.email),
      ...(password === '' ? {} : { password, passwordcreated: now }),
      s2: input.s2,
      type: input.type,
      subtype: daoNull(input.subtype),
      contactform: daoNull(input.contactform),
      lastupdate: now,
      lastupdateby: daoNull(audit.lastupdateby),
      lastupdatebyid: daoNull(audit.lastupdatebyid),
      inactive: input.inactive,
      username: daoNull(input.username),
      ispublic: input.ispublic,
      company: daoNull(input.company),
      jobtitle: daoNull(input.jobtitle),
      website: daoNull(input.website),
      notes: daoNull(input.notes),
      subscribe: input.subscribe,
      // userDAO.update writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
      siteid: javaTrim(input.siteid ?? ''),
      mobilephone: daoNull(input.mobilephone),
      description: daoNull(input.description),
      interests: daoNull(input.interests),
      photofileid: daoNull(input.photofileid),
      keepprivate: input.keepprivate,
      imname: daoNull(input.imname),
      imservice: daoNull(input.imservice),
      tags: daoNull(input.tags),
      tablist: daoNull(input.tablist),
    };
    // The version counts saves, so it is read from the row as stored when this write runs.
    const updated = await updateWhere(
      tx,
      GROUP_ACCOUNT.table,
      { userid: current.userid },
      (stored) => ({ ...patch, row_version: (BigInt(String(stored.row_version)) + 1n).toString() }),
      ctx,
    );
    return updated as GroupAccountRow | null;
  }

  function deleteGroupRow(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<GroupAccountRow | null> {
    return remove<GroupAccountRow>(tx, GROUP_ACCOUNT.table, { userid: groupId }, ctx);
  }


  /** Throws unless `groupId` is a group of this tenant; a user's child rows belong to people. */
  async function requireGroup(tx: TenantTx, groupId: string, table: string): Promise<void> {
    if ((await findGroup(tx, groupId)) === null) throw new RepositoryError(`owner ${groupId} is not a group of this tenant`, table);
  }

  async function insertGroupAddress(tx: TenantTx, row: GroupAddressInput, ctx: WriteContext = {}): Promise<GroupAddressRow> {
    await requireGroup(tx, row.userid, GROUP_ADDRESS.table);
    const stored: Omit<GroupAddressRow, 'tenant_id'> = {
      addressid: row.addressid === undefined || row.addressid === '' ? cfUuid() : row.addressid,
      userid: row.userid,
      siteid: daoNull(row.siteid),
      addressname: daoNull(row.addressname) ?? 'Primary',
      address1: daoNull(row.address1),
      address2: daoNull(row.address2),
      city: daoNull(row.city),
      state: daoNull(row.state),
      zip: daoNull(row.zip),
      country: daoNull(row.country),
      phone: daoNull(row.phone),
      fax: daoNull(row.fax),
      isprimary: row.isprimary ?? 1,
      addressnotes: daoNull(row.addressnotes),
      addressurl: daoNull(row.addressurl),
      longitude: row.longitude ?? 0,
      latitude: row.latitude ?? 0,
      addressemail: daoNull(row.addressemail),
      hours: daoNull(row.hours),
    };
    return insert<GroupAddressRow>(tx, GROUP_ADDRESS.table, stored, ctx);
  }

  async function updateGroupAddress(tx: TenantTx, addressId: string, values: GroupAddressUpdate, ctx: WriteContext = {}): Promise<GroupAddressRow | null> {
    await requireGroup(tx, values.userid, GROUP_ADDRESS.table);
    const patch: Omit<GroupAddressRow, 'tenant_id' | 'addressid' | 'isprimary'> = {
      phone: daoNull(values.phone),
      address1: daoNull(values.address1),
      address2: daoNull(values.address2),
      city: daoNull(values.city),
      state: daoNull(values.state),
      zip: daoNull(values.zip),
      fax: daoNull(values.fax),
      addressnotes: daoNull(values.addressnotes),
      siteid: javaTrim(values.siteid ?? ''),
      userid: daoNull(values.userid),
      addressname: daoNull(values.addressname),
      country: daoNull(values.country),
      addressurl: daoNull(values.addressurl),
      longitude: values.longitude ?? 0,
      latitude: values.latitude ?? 0,
      addressemail: daoNull(values.addressemail),
      hours: daoNull(values.hours),
    };
    return update<GroupAddressRow>(tx, GROUP_ADDRESS.table, { addressid: addressId }, patch, ctx);
  }

  async function setPrimaryGroupAddress(tx: TenantTx, groupId: string, addressId: string, ctx: WriteContext = {}): Promise<void> {
    await requireGroup(tx, groupId, GROUP_ADDRESS.table);
    const tenantId = await gated(tx, [GROUP_ADDRESS.unit]);
    // Rows already at the target value are skipped, so no change records a no-op update.
    const others = scan(GROUP_ADDRESS.table, tenantId, (row) => ciEq(row.userid, groupId) && !ciEq(row.addressid, addressId) && row.isprimary !== 0);
    for (const { addressid } of sorted(others, by((row) => charKey(row.addressid)))) {
      await update(tx, GROUP_ADDRESS.table, { addressid }, { isprimary: 0 }, ctx);
    }
    await updateWhere(tx, GROUP_ADDRESS.table, { addressid: addressId }, (current) => (current.isprimary === 1 ? null : { isprimary: 1 }), ctx);
  }

  async function listGroupAddresses(tx: TenantTx, groupId: string): Promise<GroupAddressRow[]> {
    const tenantId = await gated(tx, [GROUP_ADDRESS.unit]);
    const rows = scan(GROUP_ADDRESS.table, tenantId, (row) => ciEq(row.userid, groupId));
    return sorted(
      rows,
      by((row) => row.isprimary, { desc: true, nulls: 'last' }),
      by((row) => charKey(row.addressid)),
    ).map(copyRow);
  }

  /** Deletes every extended value stored under `baseId`. */
  async function deleteExtendRows(tx: TenantTx, baseId: string, ctx: WriteContext): Promise<number> {
    const tenantId = await gated(tx, [GROUP_EXTEND_DATA.unit]);
    const stale = sorted(
      scan(GROUP_EXTEND_DATA.table, tenantId, (row) => ciEq(row.baseid, baseId)),
      by((row) => row.dataid),
    );
    return removeKeys(tx, GROUP_EXTEND_DATA.table, stale.map(({ dataid }) => ({ dataid })), ctx);
  }

  async function deleteGroupAddresses(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_ADDRESS.table);
    const tenantId = await gated(tx, [GROUP_ADDRESS.unit]);
    const stale = sorted(
      scan(GROUP_ADDRESS.table, tenantId, (row) => ciEq(row.userid, groupId)),
      by((row) => charKey(row.addressid)),
    ).map((row) => row.addressid);
    for (const addressid of stale) {
      await remove(tx, GROUP_ADDRESS.table, { addressid }, ctx);
      await deleteExtendRows(tx, addressid, ctx);
    }
    return stale.length;
  }

  async function replaceGroupInterests(
    tx: TenantTx,
    input: { groupId: string; categoryIds: readonly string[]; onlyCategoryIds?: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<void> {
    await requireGroup(tx, input.groupId, GROUP_INTEREST.table);
    const tenantId = await gated(tx, [GROUP_INTEREST.unit]);
    const only = input.onlyCategoryIds === undefined ? null : new Set(input.onlyCategoryIds.map(charKey));
    const stale = sorted(
      scan(GROUP_INTEREST.table, tenantId, (row) => ciEq(row.userid, input.groupId) && (only === null || only.has(charKey(row.categoryid)))),
      by((row) => charKey(row.categoryid)),
    );
    await removeKeys(tx, GROUP_INTEREST.table, stale.map(({ categoryid }) => ({ userid: input.groupId, categoryid })), ctx);
    const held = new Set(scan(GROUP_INTEREST.table, tenantId, (row) => ciEq(row.userid, input.groupId)).map((row) => charKey(row.categoryid)));
    for (const categoryId of input.categoryIds) {
      if (!storableId(categoryId) || held.has(charKey(categoryId))) continue;
      await insert(tx, GROUP_INTEREST.table, { userid: input.groupId, categoryid: categoryId }, ctx);
      held.add(charKey(categoryId));
    }
  }

  async function groupInterestIds(tx: TenantTx, groupId: string): Promise<string[]> {
    const tenantId = await gated(tx, [GROUP_INTEREST.unit]);
    const rows = scan(GROUP_INTEREST.table, tenantId, (row) => ciEq(row.userid, groupId));
    return sorted(rows, by((row) => charKey(row.categoryid))).map((row) => row.categoryid);
  }

  async function hasGroupExtendData(tx: TenantTx, groupId: string): Promise<boolean> {
    const tenantId = await gated(tx, [GROUP_EXTEND_DATA.unit]);
    return scan(GROUP_EXTEND_DATA.table, tenantId, (row) => ciEq(row.baseid, groupId)).length > 0;
  }

  async function listGroupRelationRows(tx: TenantTx, relation: GroupRelation, groupIds: readonly string[]): Promise<RepositoryRow[]> {
    if (groupIds.length === 0) return [];
    const wanted = new Set(groupIds.map(charKey));
    const held = (userid: string | null): boolean => userid !== null && wanted.has(charKey(userid));
    switch (relation) {
      case 'tuserstags': {
        const tenantId = await gated(tx, [GROUP_TAG.unit]);
        return sorted(scan(GROUP_TAG.table, tenantId, (row) => held(row.userid)), by((row) => row.tagid)).map(copyRow);
      }
      case 'tusersinterests': {
        const tenantId = await gated(tx, [GROUP_INTEREST.unit]);
        const rows = scan(GROUP_INTEREST.table, tenantId, (row) => held(row.userid));
        return sorted(rows, by((row) => charKey(row.userid)), by((row) => charKey(row.categoryid))).map(copyRow);
      }
      case 'tuseraddresses': {
        const tenantId = await gated(tx, [GROUP_ADDRESS.unit]);
        return sorted(scan(GROUP_ADDRESS.table, tenantId, (row) => held(row.userid)), by((row) => charKey(row.addressid))).map(copyRow);
      }
      case 'tusersfavorites': {
        const tenantId = await gated(tx, [GROUP_FAVORITE.unit]);
        return sorted(scan(GROUP_FAVORITE.table, tenantId, (row) => held(row.userid)), by((row) => charKey(row.favoriteid))).map(copyRow);
      }
      case 'tusersmemb': {
        const tenantId = await gated(tx, [MEMBERSHIP.unit]);
        const rows = scan(MEMBERSHIP.table, tenantId, (row) => held(row.userid));
        return sorted(rows, by((row) => charKey(row.userid)), by((row) => charKey(row.groupid))).map(copyRow);
      }
    }
  }

  /** Deletes every tag stored for `groupId`. */
  async function deleteTagRows(tx: TenantTx, groupId: string, ctx: WriteContext): Promise<number> {
    const tenantId = await gated(tx, [GROUP_TAG.unit]);
    const stale = sorted(
      scan(GROUP_TAG.table, tenantId, (row) => ciEq(row.userid, groupId)),
      by((row) => row.tagid),
    );
    return removeKeys(tx, GROUP_TAG.table, stale.map(({ tagid }) => ({ tagid })), ctx);
  }

  async function replaceGroupTags(tx: TenantTx, input: { groupId: string; siteId: string; tags: string | null }, ctx: WriteContext = {}): Promise<GroupTagRow[]> {
    await requireGroup(tx, input.groupId, GROUP_TAG.table);
    await deleteTagRows(tx, input.groupId, ctx);
    const created: GroupTagRow[] = [];
    for (const item of (input.tags ?? '').split(',')) {
      const value = javaTrim(item);
      if (value === '') continue;
      const row: Omit<GroupTagRow, 'tenant_id'> = { tagid: nextId(GROUP_TAG, 'tagid'), userid: input.groupId, siteid: input.siteId, tag: value };
      created.push(await insert<GroupTagRow>(tx, GROUP_TAG.table, row, ctx));
    }
    return created;
  }

  async function deleteGroupTags(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_TAG.table);
    return deleteTagRows(tx, groupId, ctx);
  }

  async function deleteGroupFavorites(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_FAVORITE.table);
    const tenantId = await gated(tx, [GROUP_FAVORITE.unit]);
    const stale = sorted(
      scan(GROUP_FAVORITE.table, tenantId, (row) => ciEq(row.userid, groupId)),
      by((row) => charKey(row.favoriteid)),
    );
    return removeKeys(tx, GROUP_FAVORITE.table, stale.map(({ favoriteid }) => ({ favoriteid })), ctx);
  }

  async function replaceGroupExtendData(
    tx: TenantTx,
    input: { groupId: string; rows: readonly GroupExtendDataReplacement[] },
    ctx: WriteContext = {},
  ): Promise<GroupExtendDataRow[]> {
    await requireGroup(tx, input.groupId, GROUP_EXTEND_DATA.table);
    const inserted: GroupExtendDataRow[] = [];
    for (const { attributeId, values } of input.rows) {
      const tenantId = await gated(tx, [GROUP_EXTEND_DATA.unit]);
      const stale = sorted(
        scan(GROUP_EXTEND_DATA.table, tenantId, (row) => ciEq(row.baseid, input.groupId) && row.attributeid === attributeId),
        by((row) => row.dataid),
      );
      await removeKeys(tx, GROUP_EXTEND_DATA.table, stale.map(({ dataid }) => ({ dataid })), ctx);
      if (values === null) continue;
      const row: Omit<GroupExtendDataRow, 'tenant_id'> = {
        dataid: nextId(GROUP_EXTEND_DATA, 'dataid'),
        baseid: input.groupId,
        attributeid: attributeId,
        ...values,
      };
      inserted.push(await insert<GroupExtendDataRow>(tx, GROUP_EXTEND_DATA.table, row, ctx));
    }
    return inserted;
  }

  async function deleteGroupExtendData(tx: TenantTx, baseId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, baseId, GROUP_EXTEND_DATA.table);
    return deleteExtendRows(tx, baseId, ctx);
  }


  async function membershipsOf(tx: TenantTx, userId: string): Promise<GroupMembership[]> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit, GROUP_ACCOUNT.unit]);
    const groups = scan(MEMBERSHIP.table, tenantId, (row) => ciEq(row.userid, userId)).flatMap((membership) => {
      const group = find(GROUP_ACCOUNT, tenantId, { userid: membership.groupid });
      return group === undefined ? [] : [group];
    });
    return sorted(groups, byUserid).map((group) => ({ userId: group.userid, groupName: group.groupname, siteId: group.siteid, isPublic: group.ispublic }));
  }

  async function membershipGroupIds(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<string[]> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit], ctx);
    const rows = scan(MEMBERSHIP.table, tenantId, (row) => ciEq(row.userid, userId));
    return sorted(rows, by((row) => charKey(row.groupid))).map((row) => row.groupid);
  }

  /** Inserts each storable id of `groupIds` the user does not already hold; returns the inserted ids. */
  async function insertMemberships(tx: TenantTx, userId: string, groupIds: readonly string[], ctx: WriteContext): Promise<string[]> {
    const held = new Set((await membershipGroupIds(tx, userId)).map(charKey));
    const added: string[] = [];
    for (const groupId of groupIds) {
      if (!storableId(groupId) || held.has(charKey(groupId))) continue;
      await insert(tx, MEMBERSHIP.table, { userid: userId, groupid: groupId }, ctx);
      held.add(charKey(groupId));
      added.push(groupId);
    }
    return added;
  }

  async function replaceMemberships(
    tx: TenantTx,
    input: { userId: string; groupIds: readonly string[]; onlyGroupIds?: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<{ removed: string[]; added: string[] }> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit]);
    const only = input.onlyGroupIds === undefined ? null : new Set(input.onlyGroupIds.map(charKey));
    const stale = sorted(
      scan(MEMBERSHIP.table, tenantId, (row) => ciEq(row.userid, input.userId) && (only === null || only.has(charKey(row.groupid)))),
      by((row) => charKey(row.groupid)),
    ).map((row) => row.groupid);
    await removeKeys(tx, MEMBERSHIP.table, stale.map((groupid) => ({ userid: input.userId, groupid })), ctx);
    const added = await insertMemberships(tx, input.userId, input.groupIds, ctx);
    return { removed: stale, added };
  }

  async function clearBadMemberships(
    tx: TenantTx,
    input: { userId: string; siteId: string; s2: number | boolean | null; ispublic: number | boolean | null },
    ctx: WriteContext = {},
  ): Promise<string[]> {
    if (flag(input.s2) || !flag(input.ispublic)) return [];
    const tenantId = await gated(tx, [MEMBERSHIP.unit, GROUP_ACCOUNT.unit]);
    const publicGroups = new Set(
      scan(GROUP_ACCOUNT.table, tenantId, (row) => ciEq(row.siteid, input.siteId) && row.type === 1 && row.ispublic === 1).map((row) => charKey(row.userid)),
    );
    const bad = sorted(
      scan(MEMBERSHIP.table, tenantId, (row) => ciEq(row.userid, input.userId) && !publicGroups.has(charKey(row.groupid))),
      by((row) => charKey(row.groupid)),
    ).map((row) => row.groupid);
    await removeKeys(tx, MEMBERSHIP.table, bad.map((groupid) => ({ userid: input.userId, groupid })), ctx);
    return bad;
  }

  async function addMembership(tx: TenantTx, userId: string, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await insertMemberships(tx, userId, [groupId], ctx)).length > 0;
  }

  async function removeMembership(tx: TenantTx, userId: string, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await remove(tx, MEMBERSHIP.table, { userid: userId, groupid: groupId }, ctx)) !== null;
  }

  /**
   * Users whose open account operation holds, held or will hold a membership of a group `inGroup` accepts, by user id:
   * a stored membership, the `groupIds` of its before-image, or the `memberships.groupIds` of its pending change.
   */
  function affectingUsers(tenantId: string, inGroup: (groupId: string) => boolean): string[] {
    const users = scan(ACCOUNT_OPERATION.table, tenantId, (operation) => isOpenState(operation.state))
      .filter(
        (operation) =>
          scan(MEMBERSHIP.table, tenantId, (held) => ciEq(held.userid, operation.user_id) && inGroup(held.groupid)).length > 0 ||
          jsonTexts(operation.before_values, ['groupIds']).some(inGroup) ||
          jsonTexts(operation.pending_change, ['memberships', 'groupIds']).some(inGroup),
      )
      .map((operation) => operation.user_id);
    return sorted(
      users,
      by((userId) => charKey(userId)),
      by((userId) => userId),
    );
  }

  /** Members of `groupId` with their sort key, the lowered last name: active Type=2 accounts named by their contact, and member groups. */
  function memberRows(tenantId: string, groupId: string, includeS2: boolean): KeyedGroupMember[] {
    const members: GroupMemberRow[] = [];
    for (const membership of scan(MEMBERSHIP.table, tenantId, (row) => ciEq(row.groupid, groupId))) {
      const account = find(USER_ACCOUNT, tenantId, { userid: membership.userid });
      if (account !== undefined && account.opt2_state === 'active' && (includeS2 || account.s2 === 0)) {
        const contact = find(PERSON_CONTACT, tenantId, { user_id: account.userid });
        const { userid, type, username, siteid, ispublic, s2, inactive, perm, remoteid, tablist } = account;
        members.push({
          userid, type, username, siteid, ispublic, s2, inactive,
          fname: contact?.fname ?? null,
          lname: contact?.lname ?? null,
          email: contact?.email ?? null,
          company: contact?.company ?? null,
          groupname: contact?.groupname ?? null,
          passwordcreated: find(CREDENTIAL, tenantId, { userid })?.passwordcreated ?? null,
          jobtitle: contact?.jobtitle ?? null,
          mobilephone: contact?.mobilephone ?? null,
          website: contact?.website ?? null,
          subtype: contact?.subtype ?? null,
          contactform: contact?.contactform ?? null,
          lastlogin: find(LOGIN_STATE, tenantId, { userid })?.lastlogin ?? null,
          lastupdate: contact?.lastupdate ?? null,
          lastupdateby: contact?.lastupdateby ?? null,
          lastupdatebyid: contact?.lastupdatebyid ?? null,
          perm,
          subscribe: contact?.subscribe ?? null,
          notes: contact?.notes ?? null,
          description: contact?.description ?? null,
          interests: contact?.interests ?? null,
          keepprivate: contact?.keepprivate ?? null,
          photofileid: contact?.photofileid ?? null,
          imname: contact?.imname ?? null,
          imservice: contact?.imservice ?? null,
          created: contact?.created ?? null,
          remoteid,
          tags: contact?.tags ?? null,
          tablist,
        });
      }
      const group = find(GROUP_ACCOUNT, tenantId, { userid: membership.userid });
      if (group !== undefined && (includeS2 || group.s2 === 0)) {
        const { tenant_id: _tenant, password: _password, ext: _ext, admin: _admin, row_version: _version, ...member } = group;
        members.push(member);
      }
    }
    // Legacy orders by lname, NULL first; the lowered names compare by code point, as the "C" collation does.
    return sorted(
      members.map((member) => ({ key: member.lname === null ? null : member.lname.toLowerCase(), member })),
      by((keyed) => keyed.key, { nulls: 'first' }),
      by((keyed) => charKey(keyed.member.userid)),
    );
  }

  async function* memberPages(
    tx: TenantTx,
    groupId: string,
    opts: { includeS2?: boolean; limit?: number } = {},
  ): AsyncGenerator<GroupMemberPage, void, undefined> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit, USER_ACCOUNT.unit, CREDENTIAL.unit, LOGIN_STATE.unit, GROUP_ACCOUNT.unit]);
    const members = memberRows(tenantId, groupId, opts.includeS2 === true).slice(0, opts.limit);
    const closed = affectingUsers(tenantId, (id) => ciEq(id, groupId));
    // The first page is yielded even when empty, carrying the closure; later pages only when they hold members.
    for (let start = 0; start === 0 || start < members.length; start += pageSize) {
      yield { members: members.slice(start, start + pageSize), closed: start === 0 ? closed : [] };
    }
  }

  async function membersOf(tx: TenantTx, groupId: string, opts: { includeS2?: boolean } = {}): Promise<GroupMemberRow[]> {
    const members: GroupMemberRow[] = [];
    for await (const page of memberPages(tx, groupId, opts)) for (const { member } of page.members) members.push(member);
    return members;
  }

  async function probeMembers(tx: TenantTx, groupId: string, opts: { includeS2?: boolean } = {}): Promise<GroupMemberProbe> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit, USER_ACCOUNT.unit, CREDENTIAL.unit, LOGIN_STATE.unit, GROUP_ACCOUNT.unit]);
    return {
      listed: memberRows(tenantId, groupId, opts.includeS2 === true).length > 0,
      closed: affectingUsers(tenantId, (id) => ciEq(id, groupId)),
    };
  }

  async function countMembers(tx: TenantTx, groupId: string, opts: { includeS2?: boolean } = {}): Promise<GroupMemberCount> {
    const tenantId = await gated(tx, [MEMBERSHIP.unit, USER_ACCOUNT.unit, CREDENTIAL.unit, LOGIN_STATE.unit, GROUP_ACCOUNT.unit]);
    return {
      total: memberRows(tenantId, groupId, opts.includeS2 === true).length,
      closed: affectingUsers(tenantId, (id) => ciEq(id, groupId)),
    };
  }

  const byPermissionKey = [
    by<PermissionRow>((row) => charKey(row.contentid)),
    by<PermissionRow>((row) => charKey(row.groupid)),
    by<PermissionRow>((row) => charKey(row.siteid)),
    by<PermissionRow>((row) => charKey(row.type)),
  ];

  async function permissionsFor(tx: TenantTx, input: { contentId: string; siteId: string; type?: string }): Promise<PermissionRow[]> {
    const tenantId = await gated(tx, [PERMISSION.unit]);
    const rows = scan(
      PERMISSION.table,
      tenantId,
      (row) => ciEq(row.contentid, input.contentId) && ciEq(row.siteid, input.siteId) && (input.type === undefined || ciEq(row.type, input.type)),
    );
    return sorted(rows, ...byPermissionKey).map(copyRow);
  }

  async function groupPermissions(tx: TenantTx, groupId: string, siteId: string, ctx?: WriteContext): Promise<PermissionRow[]> {
    const tenantId = await gated(tx, [PERMISSION.unit], ctx);
    const rows = scan(PERMISSION.table, tenantId, (row) => ciEq(row.groupid, groupId) && ciEq(row.siteid, siteId));
    return sorted(
      rows,
      by((row) => charKey(row.contentid)),
      by((row) => charKey(row.type)),
    ).map(copyRow);
  }

  /** Deletes every permission of the node or module `contentId` in `siteId`; returns the deleted rows. */
  async function deletePermissions(tx: TenantTx, contentId: string, siteId: string, ctx: WriteContext): Promise<PermissionRow[]> {
    const tenantId = await gated(tx, [PERMISSION.unit]);
    const stale = sorted(
      scan(PERMISSION.table, tenantId, (row) => ciEq(row.contentid, contentId) && ciEq(row.siteid, siteId)),
      by((row) => charKey(row.groupid)),
      by((row) => charKey(row.type)),
    ).map(({ contentid, groupid, siteid, type }) => ({ contentid, groupid, siteid, type }));
    const removed: PermissionRow[] = [];
    for (const key of stale) {
      const row = await remove<PermissionRow>(tx, PERMISSION.table, key, ctx);
      if (row !== null) removed.push(row);
    }
    return removed;
  }

  async function replaceNodePermissions(
    tx: TenantTx,
    input: { contentId: string; siteId: string; grants: readonly PermissionGrant[] },
    ctx: WriteContext = {},
  ): Promise<PermissionRow[]> {
    await deletePermissions(tx, input.contentId, input.siteId, ctx);
    const inserted: PermissionRow[] = [];
    for (const grant of input.grants) {
      const row = { contentid: input.contentId, groupid: grant.groupId, siteid: input.siteId, type: grant.type };
      inserted.push(await insert<PermissionRow>(tx, PERMISSION.table, row, ctx));
    }
    return inserted;
  }

  async function replaceModulePermissions(
    tx: TenantTx,
    input: { moduleId: string; siteId: string; groupIds: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<{ rows: PermissionRow[]; removed: PermissionRow[] }> {
    const removed = await deletePermissions(tx, input.moduleId, input.siteId, ctx);
    const inserted: PermissionRow[] = [];
    // A CFML list loop skips empty items; repeated ids are inserted again and fail on the key, as legacy's insert does.
    for (const groupId of input.groupIds.filter((id) => id !== '')) {
      const row = { contentid: input.moduleId, groupid: groupId, siteid: input.siteId, type: 'module' };
      inserted.push(await insert<PermissionRow>(tx, PERMISSION.table, row, ctx));
    }
    return { rows: inserted, removed };
  }

  async function moduleGrants(tx: TenantTx, groupIds: readonly string[], siteId: string): Promise<ModuleGrant[]> {
    if (groupIds.length === 0) return [];
    const tenantId = await gated(tx, [PERMISSION.unit]);
    const wanted = new Set(groupIds.map(charKey));
    const rows = scan(PERMISSION.table, tenantId, (row) => ciEq(row.type, 'module') && ciEq(row.siteid, siteId) && wanted.has(charKey(row.groupid)));
    return sorted(
      rows,
      by((row) => charKey(row.contentid)),
      by((row) => charKey(row.groupid)),
    ).map((row) => ({ contentId: row.contentid, groupId: row.groupid }));
  }


  async function readStrike(tx: TenantTx, username: string): Promise<UserStrikeRow | null> {
    const tenantId = await gated(tx, [USER_STRIKE.unit]);
    const first = sorted(
      scan(USER_STRIKE.table, tenantId, (row) => ci(row.username) === charKey(username)),
      by((row) => charKey(row.username)),
    )[0];
    return first === undefined ? null : copyRow(first);
  }

  async function ensureStrike(tx: TenantTx, username: string, at: Date, ctx: WriteContext = {}): Promise<UserStrikeRow> {
    const stored = await readStrike(tx, username);
    if (stored !== null) return stored;
    return insert<UserStrikeRow>(tx, USER_STRIKE.table, { username, strikes: 0, lastattempt: new Date(at.getTime() - ONE_MINUTE_MS) }, ctx);
  }

  async function setStrike(tx: TenantTx, username: string, values: StrikeValues, ctx: WriteContext = {}): Promise<UserStrikeRow | null> {
    const stored = await readStrike(tx, username);
    if (stored === null) return null;
    return update<UserStrikeRow>(tx, USER_STRIKE.table, { username: stored.username }, { strikes: values.strikes, lastattempt: values.lastattempt }, ctx);
  }

  async function addStrike(tx: TenantTx, username: string, at: Date, ctx: WriteContext = {}): Promise<UserStrikeRow | null> {
    const stored = await readStrike(tx, username);
    if (stored === null) return null;
    // SQL `strikes + 1` leaves a NULL count NULL; the count is read as stored when the write runs.
    const updated = await updateWhere(
      tx,
      USER_STRIKE.table,
      { username: stored.username },
      (current) => ({ strikes: typeof current.strikes === 'number' ? current.strikes + 1 : null, lastattempt: at }),
      ctx,
    );
    return updated as UserStrikeRow | null;
  }

  function findSession(tx: TenantTx, sessionId: string): Promise<SessionRow | null> {
    return findByKey<SessionRow>(tx, SESSION.table, { session_id: sessionId });
  }

  // Row locks have no counterpart here: each write applies at once, so the lock mode changes nothing.
  async function lockSession(tx: TenantTx, sessionId: string, _mode: SessionLockMode): Promise<SessionRow | null> {
    const row = find(SESSION, tenantOf(tx), { session_id: sessionId });
    return row === undefined ? null : copyRow(row);
  }

  function insertSession(tx: TenantTx, row: SessionInsert, ctx: WriteContext = {}): Promise<SessionRow> {
    const now = clock.now();
    const stored: RepositoryRow = {
      user_id: null,
      site_id: null,
      login_snapshot: null,
      jar_ref: null,
      ended_at: null,
      admin_state: null,
      epoch: 0,
      ...row,
      created_at: now,
      updated_at: now,
    };
    return insert<SessionRow>(tx, SESSION.table, stored, ctx);
  }

  function updateSession(tx: TenantTx, sessionId: string, patch: SessionPatch, ctx: WriteContext = {}): Promise<SessionRow | null> {
    return update<SessionRow>(tx, SESSION.table, { session_id: sessionId }, { ...patch, updated_at: clock.now() }, ctx);
  }

  async function deleteSession(tx: TenantTx, sessionId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await remove(tx, SESSION.table, { session_id: sessionId }, ctx)) !== null;
  }

  async function readSessionAdminState(tx: TenantTx, sessionId: string): Promise<SessionAdminState | null> {
    const row = await findSession(tx, sessionId);
    return row === null ? null : storedAdminState(row.admin_state);
  }

  async function mergeSessionAdminState(
    tx: TenantTx,
    sessionId: string,
    values: Readonly<SessionAdminState>,
    ctx: WriteContext = {},
  ): Promise<SessionAdminState | null> {
    const current = find(SESSION, tenantOf(tx), { session_id: sessionId });
    if (current === undefined) return null;
    const merged = { ...storedAdminState(current.admin_state), ...values };
    await updateSession(tx, sessionId, { admin_state: JSON.stringify(merged) }, ctx);
    return merged;
  }

  function findRemoteSession(tx: TenantTx, userId: string): Promise<RemoteSessionRow | null> {
    return findByKey<RemoteSessionRow>(tx, REMOTE_SESSION.table, { userid: userId });
  }

  async function findRemoteSessionByToken(tx: TenantTx, authToken: string): Promise<RemoteSessionRow | null> {
    const tenantId = await gated(tx, [REMOTE_SESSION.unit]);
    const first = sorted(scan(REMOTE_SESSION.table, tenantId, (row) => ciEq(row.authtoken, authToken)), byUserid)[0];
    return first === undefined ? null : copyRow(first);
  }

  function saveRemoteSession(tx: TenantTx, row: RemoteSessionInput, ctx: WriteContext = {}): Promise<RemoteSessionRow> {
    return upsert<RemoteSessionRow>(tx, REMOTE_SESSION.table, row, ctx);
  }

  async function deleteRemoteSession(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await remove(tx, REMOTE_SESSION.table, { userid: userId }, ctx)) !== null;
  }

  async function findDevice(tx: TenantTx, lookup: DeviceLookup): Promise<UserDeviceRow | null> {
    const tenantId = await gated(tx, [USER_DEVICE.unit]);
    const rows = scan(
      USER_DEVICE.table,
      tenantId,
      (row) => ciEq(row.deviceid, lookup.deviceId) && ciEq(row.userid, lookup.userId) && (lookup.siteId === undefined || ciEq(row.siteid, lookup.siteId)),
    );
    const first = sorted(rows, by((row) => charKey(row.deviceid)))[0];
    return first === undefined ? null : copyRow(first);
  }

  function saveDevice(tx: TenantTx, row: DeviceInput, ctx: WriteContext = {}): Promise<UserDeviceRow> {
    return upsert<UserDeviceRow>(tx, USER_DEVICE.table, ormRow(row, USER_DEVICE), ctx);
  }

  function findRedirect(tx: TenantTx, redirectId: string): Promise<RedirectRow | null> {
    return findByKey<RedirectRow>(tx, REDIRECT.table, { redirectid: redirectId });
  }

  async function removePrevRedirects(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<number> {
    const tenantId = await gated(tx, [REDIRECT.unit]);
    const stale = sorted(
      scan(REDIRECT.table, tenantId, (row) => ciEq(row.userid, userId)),
      by((row) => charKey(row.redirectid)),
    );
    return removeKeys(tx, REDIRECT.table, stale.map(({ redirectid }) => ({ redirectid })), ctx);
  }

  function insertRedirect(tx: TenantTx, row: RedirectInput, ctx: WriteContext = {}): Promise<RedirectRow> {
    const stored: Omit<RedirectRow, 'tenant_id'> = { redirectid: cfUuid(), url: row.url, created: clock.now(), userid: row.userid, siteid: row.siteid };
    return insert<RedirectRow>(tx, REDIRECT.table, ormRow(stored, REDIRECT), ctx);
  }

  async function listOAuthClients(tx: TenantTx, siteId: string, page: ListPage): Promise<ListedPage<OAuthClientRow>> {
    const tenantId = await gated(tx, [OAUTH_CLIENT.unit]);
    const clients = sorted(
      scan(OAUTH_CLIENT.table, tenantId, (row) => ciEq(row.siteid, siteId)),
      by((row) => charKey(row.clientid)),
    );
    return { items: clients.slice(page.offset, page.offset + page.limit).map(copyRow), total: clients.length };
  }

  function findOAuthClient(tx: TenantTx, clientId: string): Promise<OAuthClientRow | null> {
    return findByKey<OAuthClientRow>(tx, OAUTH_CLIENT.table, { clientid: clientId });
  }

  function insertOAuthClient(tx: TenantTx, row: OAuthClientInput, ctx: WriteContext = {}): Promise<OAuthClientRow> {
    const stored = { ...row, clientid: row.clientid === undefined || row.clientid === '' ? cfUuid() : row.clientid };
    return insert<OAuthClientRow>(tx, OAUTH_CLIENT.table, ormRow(stored, OAUTH_CLIENT), ctx);
  }

  function updateOAuthClient(tx: TenantTx, clientId: string, values: OAuthClientValues, ctx: WriteContext = {}): Promise<OAuthClientRow | null> {
    return update<OAuthClientRow>(tx, OAUTH_CLIENT.table, { clientid: clientId }, ormRow(values, OAUTH_CLIENT), ctx);
  }

  async function deleteOAuthClient(tx: TenantTx, clientId: string, ctx: WriteContext = {}): Promise<boolean> {
    const tenantId = await gated(tx, [OAUTH_TOKEN.unit]);
    const tokens = sorted(
      scan(OAUTH_TOKEN.table, tenantId, (row) => ciEq(row.clientid, clientId)),
      by((row) => charKey(row.token)),
    );
    await removeKeys(tx, OAUTH_TOKEN.table, tokens.map(({ token }) => ({ token })), ctx);
    return (await remove(tx, OAUTH_CLIENT.table, { clientid: clientId }, ctx)) !== null;
  }

  function findToken(tx: TenantTx, token: string): Promise<OAuthTokenRow | null> {
    return findByKey<OAuthTokenRow>(tx, OAUTH_TOKEN.table, { token });
  }

  /** The first token, by token, of the stored ones `where` accepts, read behind the token unit's window phase. */
  async function firstToken(tx: TenantTx, where: (row: OAuthTokenRow) => boolean): Promise<OAuthTokenRow | null> {
    const tenantId = await gated(tx, [OAUTH_TOKEN.unit]);
    const first = sorted(scan(OAUTH_TOKEN.table, tenantId, where), by((row) => charKey(row.token)))[0];
    return first === undefined ? null : copyRow(first);
  }

  function findTokenByAccessCode(tx: TenantTx, code: string): Promise<OAuthTokenRow | null> {
    return firstToken(tx, (row) => ciEq(row.accesscode, code));
  }

  function insertToken(tx: TenantTx, row: OAuthTokenInput, ctx: WriteContext = {}): Promise<OAuthTokenRow> {
    return insert<OAuthTokenRow>(tx, OAUTH_TOKEN.table, ormRow(row, OAUTH_TOKEN), ctx);
  }

  async function deleteToken(tx: TenantTx, token: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await remove(tx, OAUTH_TOKEN.table, { token }, ctx)) !== null;
  }

  /** Deletes the stored tokens `where` accepts, by token; returns the number deleted. */
  async function deleteTokensWhere(tx: TenantTx, where: (row: OAuthTokenRow) => boolean, ctx: WriteContext): Promise<number> {
    const tenantId = await gated(tx, [OAUTH_TOKEN.unit]);
    const stale = sorted(scan(OAUTH_TOKEN.table, tenantId, where), by((row) => charKey(row.token)));
    return removeKeys(tx, OAUTH_TOKEN.table, stale.map(({ token }) => ({ token })), ctx);
  }

  function deleteTokensByUser(tx: TenantTx, userId: string, tokens?: readonly string[], ctx: WriteContext = {}): Promise<number> {
    const only = tokens === undefined ? null : new Set(tokens.map(charKey));
    return deleteTokensWhere(tx, (row) => ciEq(row.userid, userId) && (only === null || only.has(charKey(row.token))), ctx);
  }

  function findReusableToken(tx: TenantTx, lookup: ReusableTokenLookup): Promise<OAuthTokenRow | null> {
    // Plain equality, as the legacy feed compares: an empty userId never matches the NULL a user-less token stores.
    return firstToken(
      tx,
      (row) =>
        ciEq(row.clientid, lookup.clientId) &&
        ciEq(row.granttype, lookup.grantType) &&
        ciEq(row.userid, lookup.userId) &&
        row.expires.getTime() > lookup.now.getTime(),
    );
  }

  function purgeExpiredTokens(tx: TenantTx, purge: ExpiredTokenPurge, ctx: WriteContext = {}): Promise<number> {
    const cutoff = dayBefore(purge.now).getTime();
    return deleteTokensWhere(
      tx,
      (row) => ciEq(row.clientid, purge.clientId) && ciEq(row.granttype, purge.grantType) && row.expires.getTime() < cutoff,
      ctx,
    );
  }


  async function insertCsrfClaim(tx: TenantTx, claim: CsrfClaimInput, ctx: WriteContext = {}): Promise<CsrfClaimRow | null> {
    const now = clock.now();
    const row: Omit<CsrfClaimRow, 'tenant_id'> = {
      session_id: claim.sessionId,
      token: claim.token,
      state: claim.state,
      request_id: claim.requestId ?? null,
      claimed_at: claim.claimedAt ?? now,
      used_at: claim.state === 'used' ? (claim.usedAt ?? now) : null,
    };
    // The primary key decides the single winner, so of concurrent claims the first insert to run wins.
    try {
      return await insert<CsrfClaimRow>(tx, CSRF_CLAIM.table, row, ctx);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  function findCsrfClaim(tx: TenantTx, sessionId: string, token: string): Promise<CsrfClaimRow | null> {
    return findByKey<CsrfClaimRow>(tx, CSRF_CLAIM.table, { session_id: sessionId, token });
  }

  /** A claim's age instant: its use time, else its claim time. */
  function claimTime(row: CsrfClaimRow): number {
    return (row.used_at ?? row.claimed_at).getTime();
  }

  async function listCsrfClaims(tx: TenantTx, sessionId: string, filter: CsrfClaimFilter = {}): Promise<CsrfClaimRow[]> {
    const tenantId = tenantOf(tx);
    const since = filter.since?.getTime();
    const rows = scan(
      CSRF_CLAIM.table,
      tenantId,
      (row) => row.session_id === sessionId && (filter.state === undefined || row.state === filter.state) && (since === undefined || claimTime(row) >= since),
    );
    return sorted(
      rows,
      by((row) => row.claimed_at),
      by((row) => row.token),
    ).map(copyRow);
  }

  async function setCsrfClaimState(
    tx: TenantTx,
    sessionId: string,
    token: string,
    from: CsrfClaimState,
    to: CsrfClaimState,
    opts: { usedAt?: Date } = {},
    ctx: WriteContext = {},
  ): Promise<boolean> {
    const updated = await updateWhere(
      tx,
      CSRF_CLAIM.table,
      { session_id: sessionId, token },
      (current) => (current.state === from ? { state: to, used_at: to === 'used' ? (opts.usedAt ?? clock.now()) : null } : null),
      ctx,
    );
    return updated !== null;
  }

  async function deleteCsrfClaim(tx: TenantTx, sessionId: string, token: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await remove(tx, CSRF_CLAIM.table, { session_id: sessionId, token }, ctx)) !== null;
  }

  async function purgeCsrfClaims(tx: TenantTx, purge: CsrfClaimPurge, ctx: WriteContext = {}): Promise<number> {
    const tenantId = tenantOf(tx);
    const cutoff = purge.olderThan?.getTime();
    const stale = sorted(
      scan(
        CSRF_CLAIM.table,
        tenantId,
        (row) => (purge.sessionId === undefined || row.session_id === purge.sessionId) && (cutoff === undefined || claimTime(row) < cutoff),
      ),
      by((row) => row.session_id),
      by((row) => row.token),
    );
    return removeKeys(tx, CSRF_CLAIM.table, stale.map(({ session_id, token }) => ({ session_id, token })), ctx);
  }

  function insertAccountOperation(tx: TenantTx, row: AccountOperationInput, ctx: WriteContext = {}): Promise<AccountOperationRow> {
    const now = clock.now();
    const stored: Omit<AccountOperationRow, 'tenant_id'> = {
      operation_id: row.operation_id ?? cfUuid(),
      user_id: row.user_id,
      kind: row.kind,
      state: row.state,
      username: row.username ?? null,
      pending_change: row.pending_change ?? null,
      before_values: row.before_values ?? null,
      commit_xid: row.commit_xid ?? null,
      created_at: now,
      updated_at: now,
    };
    return insert<AccountOperationRow>(tx, ACCOUNT_OPERATION.table, stored, ctx);
  }

  function findAccountOperation(tx: TenantTx, operationId: string): Promise<AccountOperationRow | null> {
    return findByKey<AccountOperationRow>(tx, ACCOUNT_OPERATION.table, { operation_id: operationId });
  }

  async function lockAccountOperation(tx: TenantTx, operationId: string): Promise<AccountOperationRow | null> {
    const row = find(ACCOUNT_OPERATION, tenantOf(tx), { operation_id: operationId });
    return row === undefined ? null : copyRow(row);
  }

  async function findAccountOperations(tx: TenantTx, operationIds: readonly string[]): Promise<AccountOperationRow[]> {
    if (operationIds.length === 0) return [];
    const wanted = new Set(operationIds);
    return sorted(
      scan(ACCOUNT_OPERATION.table, tenantOf(tx), (row) => wanted.has(row.operation_id)),
      by((row) => row.operation_id),
    ).map(copyRow);
  }

  async function findOpenAccountOperation(tx: TenantTx, lookup: OpenOperationLookup): Promise<AccountOperationRow | null> {
    const userId = lookup.userId ?? null;
    const username = lookup.username ?? null;
    const open = scan(
      ACCOUNT_OPERATION.table,
      tenantOf(tx),
      (row) => isOpenState(row.state) && ((userId !== null && ciEq(row.user_id, userId)) || (username !== null && ciEq(row.username, username))),
    );
    const first = sorted(
      open,
      by((row) => row.created_at),
      by((row) => row.operation_id),
    )[0];
    return first === undefined ? null : copyRow(first);
  }

  async function setAccountOperationState(
    tx: TenantTx,
    operationId: string,
    fromStates: readonly AccountOperationState[],
    to: AccountOperationState,
    patch: AccountOperationPatch = {},
    ctx: WriteContext = {},
  ): Promise<boolean> {
    const updated = await updateWhere(
      tx,
      ACCOUNT_OPERATION.table,
      { operation_id: operationId },
      (current) => ((fromStates as readonly unknown[]).includes(current.state) ? { ...patch, state: to, updated_at: clock.now() } : null),
      ctx,
    );
    return updated !== null;
  }

  function upsertPersonContact(tx: TenantTx, row: PersonContactInput, ctx: WriteContext = {}): Promise<PersonContactRow> {
    return upsert<PersonContactRow>(tx, PERSON_CONTACT.table, { ...row, updated_at: row.updated_at ?? clock.now() }, ctx);
  }

  function findPersonContact(tx: TenantTx, userId: string): Promise<PersonContactRow | null> {
    return findByKey<PersonContactRow>(tx, PERSON_CONTACT.table, { user_id: userId });
  }

  async function findContactsByEmail(tx: TenantTx, email: string): Promise<PersonContactRow[]> {
    const rows = scan(PERSON_CONTACT.table, tenantOf(tx), (row) => ciEq(row.email, email));
    return sorted(rows, by((row) => charKey(row.user_id))).map(copyRow);
  }

  async function findAccountsByEmail(tx: TenantTx, email: string, userId?: string): Promise<EmailAccountRow[]> {
    const tenantId = await gated(tx, [USER_ACCOUNT.unit]);
    const found = scan(PERSON_CONTACT.table, tenantId, (row) => ciEq(row.email, email)).flatMap((contact): EmailAccountRow[] => {
      const account = find(USER_ACCOUNT, tenantId, { userid: contact.user_id });
      const listed =
        account !== undefined &&
        account.type === 2 &&
        account.inactive === 0 &&
        account.opt2_state === 'active' &&
        (userId === undefined || ciEq(account.userid, userId));
      return listed ? [{ ...copyRow(account), fname: contact.fname, lname: contact.lname }] : [];
    });
    return sorted(found, byUserid);
  }

  async function nextAggregateVersion(tx: TenantTx, aggregateType: string, aggregateId: string, ctx: WriteContext = {}): Promise<number> {
    const tenantId = tenantOf(tx);
    await writeGate(tx, AGGREGATE_VERSION, ctx);
    const key = { aggregate_type: aggregateType, aggregate_id: aggregateId };
    const bumped = patchNow(AGGREGATE_VERSION, tenantId, key, (current) => ({ row_version: (BigInt(String(current.row_version)) + 1n).toString() }));
    if (bumped !== undefined) return Number(bumped.row_version);
    insertNow(AGGREGATE_VERSION, tenantId, { ...key, row_version: 1 });
    return 1;
  }

  function rows<T extends IdentityTableName>(table: T, tenantId?: string): IdentityRowTypes[T][] {
    definition(table);
    const tenants = store.get(table);
    const selected = tenantId === undefined ? [...(tenants?.values() ?? [])] : [tenants?.get(tenantId.toLowerCase())];
    return selected.flatMap((stored) => [...(stored?.values() ?? [])].map(copyRow)) as unknown as IdentityRowTypes[T][];
  }

  function writes(): MemoryWrite[] {
    return changes.map((change) => ({
      ...change,
      key: copyRow(change.key),
      ...(change.before === undefined ? {} : { before: copyRow(change.before) }),
      ...(change.after === undefined ? {} : { after: copyRow(change.after) }),
    }));
  }

  for (const [field, table] of Object.entries(SEED_TABLES) as Array<[keyof IdentitySeed, IdentityTableName]>) {
    const def = definition(table);
    for (const row of seed[field] ?? []) {
      const tenantId = assertTenantId(row.tenant_id);
      checkColumns(def, tenantId, row);
      place(def, tenantId, row);
    }
  }

  const repository: Omit<IdentityRepository, Unimplemented> & MemoryExtras = {
    owner: OWNER,
    schema,
    definition: (table: string): TableDefinition => {
      const def = definition(table);
      return { ...def, columns: def.columns.map((column) => ({ ...column })), key: def.key === null ? null : [...def.key] };
    },
    units: (): string[] => [...IDENTITY_UNITS],
    insert,
    update,
    upsert,
    delete: remove,
    findByKey,
    findAccountsByUsername,
    findAccountByUsername,
    findAccountById,
    readAccountRecords,
    countListedAccounts,
    readUsernameCandidates,
    foreignMemberIds,
    isUsernameTaken,
    insertAccount,
    updateAccount,
    setAccountState,
    deleteAccount,
    readCredential,
    writeCredential,
    touchLastLogin,
    insertLoginState,
    findGroup,
    findGroupsByIds,
    findGroupByName,
    findGroupsByColumn,
    countAccountsByColumn,
    listGroups,
    listCountedGroups,
    pageCountedGroups,
    groupFeedPages,
    readGroupFeed,
    listPoolGroups,
    insertGroup,
    updateGroup,
    deleteGroupRow,
    insertGroupAddress,
    updateGroupAddress,
    setPrimaryGroupAddress,
    listGroupAddresses,
    deleteGroupAddresses,
    replaceGroupInterests,
    groupInterestIds,
    hasGroupExtendData,
    listGroupRelationRows,
    replaceGroupTags,
    deleteGroupTags,
    deleteGroupFavorites,
    replaceGroupExtendData,
    deleteGroupExtendData,
    membershipsOf,
    membershipGroupIds,
    readMembershipRecords,
    replaceMemberships,
    clearBadMemberships,
    addMembership,
    removeMembership,
    membersOf,
    memberPages,
    probeMembers,
    countMembers,
    permissionsFor,
    groupPermissions,
    replaceNodePermissions,
    replaceModulePermissions,
    moduleGrants,
    readStrike,
    ensureStrike,
    setStrike,
    addStrike,
    findSession,
    lockSession,
    insertSession,
    updateSession,
    deleteSession,
    readSessionAdminState,
    mergeSessionAdminState,
    findRemoteSession,
    findRemoteSessionByToken,
    saveRemoteSession,
    deleteRemoteSession,
    findDevice,
    saveDevice,
    findRedirect,
    removePrevRedirects,
    insertRedirect,
    listOAuthClients,
    findOAuthClient,
    insertOAuthClient,
    updateOAuthClient,
    deleteOAuthClient,
    findToken,
    findTokenByAccessCode,
    insertToken,
    deleteToken,
    deleteTokensByUser,
    findReusableToken,
    purgeExpiredTokens,
    insertCsrfClaim,
    findCsrfClaim,
    listCsrfClaims,
    setCsrfClaimState,
    deleteCsrfClaim,
    purgeCsrfClaims,
    insertAccountOperation,
    findAccountOperation,
    lockAccountOperation,
    findAccountOperations,
    findOpenAccountOperation,
    setAccountOperationState,
    upsertPersonContact,
    findPersonContact,
    findContactsByEmail,
    findAccountsByEmail,
    nextAggregateVersion,
    writes,
    clear: () => {
      changes = [];
    },
    rows,
  };

  // A test reaching a member that needs SQL fails loudly instead of reading undefined.
  return new Proxy(Object.freeze(repository), {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && !Reflect.has(target, property) && REPOSITORY_MEMBERS.has(property)) {
        throw new Error(`memory repo: ${property} not implemented`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as MemoryIdentityRepo;
}

