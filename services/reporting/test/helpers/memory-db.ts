// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** In-memory PostgreSQL stand-in for the reporting schema: transactions, savepoints, forced RLS on tenant tables, and only the statements reporting and the platform run. */
import { tenantDbFromPool, type TenantDb } from '@opt2/platform/tenancy';
import { EXPORT_DEFINITION, EXPORT_JOB, SCHEMA } from '../../src/repo/tables.js';

/** One stored row, keyed by column name, in the value forms node-postgres returns. */
export type Row = Record<string, unknown>;

/** Tables the memory database holds. */
export type MemoryTable =
  | 'export_definition'
  | 'export_job'
  | 'session_tracking'
  | 'changelog'
  | 'inbox'
  | 'consumer_aggregate_version'
  | 'outbox'
  | 'tenant_registry'
  | 'unit_gate'
  | 'migration_batch'
  | 'migration_watermark';

/** One finished transaction: its `app.tenant_id`, every statement it ran and how it ended. */
export interface RecordedTransaction {
  tenantId: string | null;
  statements: readonly string[];
  /** The INSERT, UPDATE and DELETE statements among `statements`. */
  writes: readonly string[];
  outcome: 'commit' | 'rollback';
}

/** A TenantDb over in-memory tables, with access to the committed rows and the finished transactions. */
export interface MemoryDb extends TenantDb {
  /** Committed rows of `table`, every tenant's, as copies. */
  rows(table: MemoryTable): Row[];
  /** Adds committed rows to `table`; tenant tables need `tenant_id`. */
  seed(table: MemoryTable, rows: readonly Row[]): void;
  /** Every finished transaction, oldest first. */
  readonly transactions: readonly RecordedTransaction[];
}

/** A statement this stand-in does not implement, so a suite fails instead of passing on a guessed answer. */
export class UnsupportedStatementError extends Error {
  override readonly name = 'UnsupportedStatementError';
}

/** An error shaped as node-postgres raises it, with its SQLSTATE in `code`. */
class PgError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface QueryAnswer {
  command: string;
  rows: Row[];
  rowCount: number | null;
  fields: never[];
}

type Tables = Map<MemoryTable, Row[]>;

/** One open transaction's working copy. */
interface Working {
  tables: Tables;
  savepoints: Map<string, Tables>;
  statements: string[];
  xid: bigint | null;
}

interface Session {
  tenantId: string | null;
  lockTimeout: string;
  tx: Working | null;
}

type Handler = (match: RegExpExecArray, params: readonly unknown[], session: Session, tx: Working) => QueryAnswer;

const TENANT_TABLES: ReadonlySet<MemoryTable> = new Set<MemoryTable>([
  'export_definition',
  'export_job',
  'session_tracking',
  'changelog',
  'inbox',
  'consumer_aggregate_version',
  'outbox',
  'migration_batch',
]);

/** The key an insert conflicts on: the migrations' primary key, tenant_registry's unique `tenant_id`, none for the sequenced changelog. */
const UNIQUE_KEYS: Readonly<Record<MemoryTable, readonly string[] | null>> = {
  export_definition: ['tenant_id', 'definition_id'],
  export_job: ['tenant_id', 'job_id'],
  session_tracking: ['tenant_id', 'trackingid'],
  changelog: null,
  inbox: ['tenant_id', 'event_id'],
  consumer_aggregate_version: ['tenant_id', 'subscription', 'aggregate_type', 'aggregate_id'],
  outbox: ['event_id'],
  tenant_registry: ['tenant_id'],
  unit_gate: ['unit'],
  migration_batch: ['tenant_id', 'batch_id'],
  migration_watermark: ['legacy_table', 'direction'],
};

const ALL_TABLES = Object.keys(UNIQUE_KEYS) as MemoryTable[];

/** Columns of the two catalogued tables, every one NULL unless set. */
const CATALOGUED: Partial<Record<MemoryTable, readonly string[]>> = {
  export_definition: EXPORT_DEFINITION.columns.map((column) => column.name),
  export_job: EXPORT_JOB.columns.map((column) => column.name),
};

const WRITE = /^(INSERT|UPDATE|DELETE)\b/;
const NOW_EXPRESSION = /^(LOCALTIMESTAMP|localtimestamp)\(3\)$/;

/** `sql` on one line, with identifier quotes removed. */
function normalise(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/"(\w+)"/g, '$1').trim();
}

/** A stored or bound value as text: primitives as themselves, dates in ISO form, arrays and objects as JSON, NULL as ''. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : JSON.stringify(value);
}

function answer(rows: Row[], command = 'SELECT', rowCount: number | null = rows.length): QueryAnswer {
  return { command, rows, rowCount, fields: [] };
}

function cloneTables(tables: Tables): Tables {
  return new Map([...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
}

function tableName(name: string): MemoryTable {
  if (!(ALL_TABLES as string[]).includes(name)) throw new UnsupportedStatementError(`table ${name} is not held in memory`);
  return name as MemoryTable;
}

function rowsOf(tx: Working, table: MemoryTable): Row[] {
  const rows = tx.tables.get(table);
  if (rows === undefined) throw new UnsupportedStatementError(`table ${table} is not held in memory`);
  return rows;
}

/** Whether forced RLS lets the session's tenant see `row`. */
function visible(table: MemoryTable, row: Row, session: Session): boolean {
  if (!TENANT_TABLES.has(table)) return true;
  return session.tenantId !== null && text(row.tenant_id).toLowerCase() === session.tenantId.toLowerCase();
}

/** Throws the RLS WITH CHECK error unless `row` belongs to the session's tenant. */
function checkPolicy(table: MemoryTable, row: Row, session: Session): void {
  if (!visible(table, row, session)) {
    throw new PgError(`new row violates row-level security policy for table "${table}"`, '42501');
  }
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text; -1 when unbalanced. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `source` split at `separator` outside parentheses and quotes, each part trimmed. */
function splitTopLevel(source: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth === 0 && source.startsWith(separator, i)) {
      parts.push(source.slice(start, i).trim());
      start = i + separator.length;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** The value one expression binds: a `$n` parameter with its cast dropped, NULL, a literal or the clock's now. */
function boundValue(expression: string, params: readonly unknown[], now: () => Date): unknown {
  const placeholder = /^\$(\d+)(?:::[\w[\]]+)?$/.exec(expression);
  if (placeholder !== null) return params[Number(placeholder[1]) - 1] ?? null;
  if (/^NULL$/i.test(expression)) return null;
  const literal = /^'((?:[^']|'')*)'$/.exec(expression);
  if (literal?.[1] !== undefined) return literal[1].replace(/''/g, "'");
  if (/^(true|false)$/i.test(expression)) return expression.toLowerCase() === 'true';
  if (NOW_EXPRESSION.test(expression)) return now();
  throw new UnsupportedStatementError(`expression ${expression} is not evaluated in memory`);
}

/** A term of a WHERE conjunction as a row predicate. */
function predicate(term: string, params: readonly unknown[]): (row: Row) => boolean {
  const param = (index: string | undefined): unknown => params[Number(index) - 1];
  let m = /^\(?(\w+) = \$(\d+)\)?$/.exec(term);
  if (m !== null) {
    const [, column = '', index] = m;
    return (row) => row[column] !== null && text(row[column]) === text(param(index));
  }
  m = /^lower\((\w+)\) = lower\(\$(\d+)\)$/.exec(term);
  if (m !== null) {
    const [, column = '', index] = m;
    return (row) => text(row[column]).toLowerCase() === text(param(index)).toLowerCase();
  }
  m = /^(\w+) IN \(((?:'\w+'(?:, )?)+)\)$/.exec(term);
  if (m !== null) {
    const [, column = '', list = ''] = m;
    const values = list.split(', ').map((value) => value.slice(1, -1));
    return (row) => values.includes(text(row[column]));
  }
  m = /^(\w+) = ANY\(\$(\d+)::text\[\]\)$/.exec(term);
  if (m !== null) {
    const [, column = '', index] = m;
    const values = (param(index) as unknown[]).map(text);
    return (row) => values.includes(text(row[column]));
  }
  m = /^(\w+) IS NOT NULL$/.exec(term);
  if (m !== null) {
    const [, column = ''] = m;
    return (row) => row[column] !== null && row[column] !== undefined;
  }
  m = /^(\w+) IS NULL$/.exec(term);
  if (m !== null) {
    const [, column = ''] = m;
    return (row) => row[column] === null || row[column] === undefined;
  }
  m = /^\(\$(\d+)::bpchar IS NULL OR (\w+) COLLATE C > \$\1::bpchar\)$/.exec(term);
  if (m !== null) {
    const [, index, column = ''] = m;
    const after = param(index);
    return (row) => after === null || text(row[column]) > text(after);
  }
  throw new UnsupportedStatementError(`predicate ${term} is not evaluated in memory`);
}

/** The predicate of a WHERE clause of AND-joined terms; every row without one. */
function whereOf(clause: string | undefined, params: readonly unknown[]): (row: Row) => boolean {
  if (clause === undefined) return () => true;
  const terms = splitTopLevel(clause, ' AND ').map((term) => predicate(term, params));
  return (row) => terms.every((term) => term(row));
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const [x, y] = [text(a), text(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Rows sorted by an ORDER BY list of columns, each optionally `COLLATE C`. */
function ordered(rows: Row[], clause: string | undefined): Row[] {
  if (clause === undefined) return rows;
  const columns = clause.split(', ').map((item) => /^(\w+)(?: COLLATE C)?$/.exec(item)?.[1]);
  if (columns.some((column) => column === undefined)) throw new UnsupportedStatementError(`ORDER BY ${clause} is not evaluated in memory`);
  return [...rows].sort((a, b) => {
    for (const column of columns as string[]) {
      const order = compareValues(a[column], b[column]);
      if (order !== 0) return order;
    }
    return 0;
  });
}

/** `row` through a select or RETURNING list of `*`, columns and `column::text AS alias` items. */
function project(list: string, row: Row): Row {
  if (list === '*') return { ...row };
  return Object.fromEntries(
    splitTopLevel(list).map((item) => {
      const m = /^(\w+)(::text)?(?: AS (\w+))?$/.exec(item);
      if (m === null) throw new UnsupportedStatementError(`select item ${item} is not evaluated in memory`);
      const [, column = '', asText, alias] = m;
      const value = row[column] ?? null;
      return [alias ?? column, asText !== undefined && value !== null ? text(value) : value];
    }),
  );
}

/** A bound wall-clock timestamp as `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.MS')` renders it once stored as timestamp(3). */
function wallClockText(value: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text(value));
  if (m === null) throw new UnsupportedStatementError(`timestamp ${text(value)} is not evaluated in memory`);
  const [, date = '', minutes = '', seconds = '00', fraction = ''] = m;
  return `${date}T${minutes}:${seconds}.${fraction.padEnd(3, '0')}`;
}

/** A stored migration watermark in the handlers' `WATERMARK_COLUMNS` form. */
function watermarkRecord(row: Row): Row {
  return {
    legacy_table: row.legacy_table,
    direction: row.direction,
    snapshot_seq: row.snapshot_seq === null ? null : text(row.snapshot_seq),
    backup_lsn: row.backup_lsn === null ? null : text(row.backup_lsn),
    finished_at: row.finished_at,
  };
}

/** Rows of `VALUES (…)[, (…)]` for `columns`; the text after the last tuple is returned as `rest`. */
function valueTuples(source: string, columns: readonly string[], params: readonly unknown[], now: () => Date): { rows: Row[]; rest: string } {
  let rest = source;
  const rows: Row[] = [];
  while (rest.startsWith('(')) {
    const end = closingParen(rest, 0);
    if (end < 0) throw new UnsupportedStatementError(`unbalanced VALUES ${source}`);
    const expressions = splitTopLevel(rest.slice(1, end));
    rows.push(Object.fromEntries(columns.map((column, i) => [column, boundValue(expressions[i] ?? 'NULL', params, now)])));
    rest = rest.slice(end + 1).replace(/^, /, '');
  }
  return { rows, rest: rest.trim() };
}

/** Creates a {@link MemoryDb} over schema `reporting`, its clock read for column defaults; nothing connects to PostgreSQL. */
export function createMemoryDb(options: { now: () => Date }): MemoryDb {
  const { now } = options;
  let committed: Tables = new Map(ALL_TABLES.map((table) => [table, []]));
  const transactions: RecordedTransaction[] = [];
  let nextXid = 1000n;
  let nextSeq = 0n;

  const xidOf = (tx: Working): bigint => {
    if (tx.xid === null) {
      tx.xid = nextXid;
      nextXid += 1n;
    }
    return tx.xid;
  };

  /** A row as stored after an INSERT: catalogue columns NULL, then the table's defaults, then the inserted values. */
  function storedRow(table: MemoryTable, values: Row, tx: Working): Row {
    const base: Row = Object.fromEntries((CATALOGUED[table] ?? []).map((column) => [column, null]));
    if (table === 'export_job') Object.assign(base, { state: 'queued', row_version: '0' });
    if (table === 'inbox') base.received_at = now();
    if (table === 'consumer_aggregate_version') base.updated_at = now();
    if (table === 'unit_gate') Object.assign(base, { state: 'legacy', holder_id: null, phase: 'quiet', updated_at: now() });
    if (table === 'migration_batch') base.applied_at = now();
    const row = { ...base, ...values };
    if (table === 'changelog') {
      nextSeq += 1n;
      Object.assign(row, { xid: String(xidOf(tx)), seq: String(nextSeq) });
    }
    return row;
  }

  function conflicting(table: MemoryTable, tx: Working, row: Row, columns: readonly string[]): Row | undefined {
    return rowsOf(tx, table).find((stored) => columns.every((column) => text(stored[column]).toLowerCase() === text(row[column]).toLowerCase()));
  }

  const insert: Handler = (m, params, session, tx) => {
    const [, , name = '', columnText = '', tail = ''] = m;
    const table = tableName(name);
    const columns = columnText.split(', ');
    const { rows, rest } = valueTuples(tail, columns, params, now);
    const clause = /^(?:ON CONFLICT(?: \(([\w, ]+)\))? DO NOTHING)? ?(?:RETURNING (.+))?$/.exec(rest);
    if (clause === null) throw new UnsupportedStatementError(`INSERT tail ${rest} is not evaluated in memory`);
    const [, conflictText, returning] = clause;
    const ignore = rest.startsWith('ON CONFLICT');
    const key = conflictText?.split(', ') ?? UNIQUE_KEYS[table];
    const stored: Row[] = [];
    for (const values of rows) {
      const row = storedRow(table, values, tx);
      checkPolicy(table, row, session);
      if (key !== null && conflicting(table, tx, row, key) !== undefined) {
        if (ignore) continue;
        throw new PgError(`duplicate key value violates unique constraint on ${table} (${key.join(', ')})`, '23505');
      }
      rowsOf(tx, table).push(row);
      stored.push(row);
    }
    xidOf(tx);
    return answer(returning === undefined ? [] : stored.map((row) => project(returning, row)), 'INSERT', stored.length);
  };

  const registryUpsert: Handler = (m, params, _session, tx) => {
    const [, columnText = '', tail = ''] = m;
    const [values] = valueTuples(tail, columnText.split(', '), params, now).rows;
    if (values === undefined) throw new UnsupportedStatementError('registry upsert without VALUES');
    const registry = rowsOf(tx, 'tenant_registry');
    const index = registry.findIndex((row) => row.tenant_id === values.tenant_id);
    const current = registry[index];
    xidOf(tx);
    if (current === undefined) {
      registry.push(values);
      return answer([], 'INSERT', 1);
    }
    if (BigInt(text(current.aggregate_version)) >= BigInt(text(values.aggregate_version))) return answer([], 'INSERT', 0);
    registry[index] = values;
    return answer([], 'INSERT', 1);
  };

  const select: Handler = (m, params, session, tx) => {
    const [, list = '', , name = '', where, order, limit, offset] = m;
    const table = tableName(name);
    const matches = whereOf(where, params);
    let rows = ordered(rowsOf(tx, table).filter((row) => visible(table, row, session) && matches(row)), order);
    const skip = offset === undefined ? 0 : Number(params[Number(offset) - 1]);
    rows = rows.slice(skip, limit === undefined ? undefined : skip + Number(params[Number(limit) - 1]));
    return answer(rows.map((row) => project(list, row)));
  };

  const update: Handler = (m, params, session, tx) => {
    const [, , name = '', assignments = '', where, returning] = m;
    const table = tableName(name);
    const sets = splitTopLevel(assignments).map((assignment) => {
      const parts = /^(\w+) = (.+)$/.exec(assignment);
      if (parts === null) throw new UnsupportedStatementError(`assignment ${assignment} is not evaluated in memory`);
      return [parts[1] ?? '', boundValue(parts[2] ?? '', params, now)] as const;
    });
    const matches = whereOf(where, params);
    const rows = rowsOf(tx, table);
    const changed: Row[] = [];
    rows.forEach((row, i) => {
      if (!visible(table, row, session) || !matches(row)) return;
      const next = { ...row, ...Object.fromEntries(sets) };
      checkPolicy(table, next, session);
      rows[i] = next;
      changed.push(next);
    });
    xidOf(tx);
    return answer(returning === undefined ? [] : changed.map((row) => project(returning, row)), 'UPDATE', changed.length);
  };

  /** Removes the rows the session's tenant sees that match the WHERE clause, every visible row without one. */
  const deleteRows: Handler = (m, params, session, tx) => {
    const [, , name = '', where, returning] = m;
    const table = tableName(name);
    const matches = whereOf(where, params);
    const rows = rowsOf(tx, table);
    const removed = rows.filter((row) => visible(table, row, session) && matches(row));
    rows.splice(0, rows.length, ...rows.filter((row) => !removed.includes(row)));
    xidOf(tx);
    return answer(returning === undefined ? [] : removed.map((row) => project(returning, row)), 'DELETE', removed.length);
  };

  const countRows: Handler = (m, _params, session, tx) => {
    const [, , name = ''] = m;
    const table = tableName(name);
    return answer([{ total: rowsOf(tx, table).filter((row) => visible(table, row, session)).length }]);
  };

  const outboxCounts: Handler = (_m, _params, session, tx) => {
    const rows = rowsOf(tx, 'outbox').filter((row) => visible('outbox', row, session));
    const unpublished = rows.filter((row) => row.published_at === null && row.held !== true).length;
    return answer([{ unpublished: String(unpublished), held: String(rows.filter((row) => row.held === true).length) }]);
  };

  const inboxBySubscription: Handler = (_m, _params, session, tx) => {
    const counts = new Map<string, number>();
    for (const row of rowsOf(tx, 'inbox').filter((candidate) => visible('inbox', candidate, session))) {
      counts.set(text(row.subscription), (counts.get(text(row.subscription)) ?? 0) + 1);
    }
    return answer([...counts].map(([subscription, count]) => ({ subscription, count: String(count) })));
  };

  const changes: Handler = (_m, params, session, tx) => {
    const [horizon, afterXid, afterSeq, limit] = params.map((value) => text(value));
    const after = (row: Row): boolean =>
      BigInt(text(row.xid)) > BigInt(afterXid ?? '0') ||
      (BigInt(text(row.xid)) === BigInt(afterXid ?? '0') && BigInt(text(row.seq)) > BigInt(afterSeq ?? '0'));
    const rows = rowsOf(tx, 'changelog')
      .filter((row) => visible('changelog', row, session) && BigInt(text(row.xid)) < BigInt(horizon ?? '0') && after(row))
      .sort((a, b) => Number(BigInt(text(a.xid)) - BigInt(text(b.xid))) || Number(BigInt(text(a.seq)) - BigInt(text(b.seq))))
      .slice(0, Number(limit));
    const at = (value: unknown): string => {
      const d = value instanceof Date ? value : new Date(text(value));
      const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    };
    return answer(rows.map((row) => ({ ...row, at: at(row.at) })));
  };

  const watermarks: Handler = (_m, params, _session, tx) => {
    const [legacyTable, direction] = params;
    const rows = ordered(
      rowsOf(tx, 'migration_watermark').filter(
        (row) => (legacyTable === null || row.legacy_table === legacyTable) && (direction === null || row.direction === direction),
      ),
      'legacy_table, direction',
    );
    return answer(rows.map(watermarkRecord));
  };

  /** The watermark upsert: the `(legacy_table, direction)` row inserted or replaced, its timestamp kept as to_char renders it. */
  const watermarkUpsert: Handler = (_m, params, _session, tx) => {
    const [legacyTable, direction, snapshotSeq, backupLsn, finishedAt] = params;
    const row: Row = { legacy_table: legacyTable, direction, snapshot_seq: snapshotSeq ?? null, backup_lsn: backupLsn ?? null, finished_at: wallClockText(finishedAt) };
    const marks = rowsOf(tx, 'migration_watermark');
    const index = marks.findIndex((stored) => stored.legacy_table === legacyTable && stored.direction === direction);
    if (index < 0) marks.push(row);
    else marks[index] = row;
    xidOf(tx);
    return answer([watermarkRecord(row)], 'INSERT', 1);
  };

  /** The migration export's first page of a single-key table: the tenant's rows by key text, each with its key as the cursor. */
  const exportPage: Handler = (m, params, session, tx) => {
    const [, keyColumn = '', cursorColumn = '', name = ''] = m;
    const table = tableName(name);
    const [tenantId, limit] = params;
    const rows = rowsOf(tx, table)
      .filter((row) => visible(table, row, session) && text(row.tenant_id) === text(tenantId))
      .sort((a, b) => compareValues(text(a[keyColumn]), text(b[keyColumn])))
      .slice(0, Number(limit));
    return answer(rows.map((row) => ({ ...row, [cursorColumn]: [text(row[keyColumn])] })));
  };

  /** The migration export's first page of a single integer-key table: the tenant's rows by numeric key, each with its key text as the cursor. */
  const integerExportPage: Handler = (m, params, session, tx) => {
    const [, keyColumn = '', cursorColumn = '', name = ''] = m;
    const table = tableName(name);
    const [tenantId, limit] = params;
    const keyOf = (row: Row): bigint => {
      const key = text(row[keyColumn]);
      if (!/^-?\d+$/.test(key)) throw new UnsupportedStatementError(`ORDER BY ${keyColumn} of non-integer ${key} is not evaluated in memory`);
      return BigInt(key);
    };
    const rows = rowsOf(tx, table)
      .filter((row) => visible(table, row, session) && text(row.tenant_id) === text(tenantId))
      .map((row) => [keyOf(row), row] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .slice(0, Number(limit))
      .map(([, row]) => row);
    return answer(rows.map((row) => ({ ...row, [cursorColumn]: [text(row[keyColumn])] })));
  };

  const control = (command: string, run?: (session: Session, name: string) => void): Handler => {
    return (m, _params, session) => {
      run?.(session, m[1] ?? '');
      return answer([], command, null);
    };
  };

  const savepoint = (session: Session, name: string): void => {
    session.tx?.savepoints.set(name, cloneTables(session.tx.tables));
  };
  const rollbackTo = (session: Session, name: string): void => {
    const saved = session.tx?.savepoints.get(name);
    if (session.tx === null || saved === undefined) throw new PgError(`savepoint "${name}" does not exist`, '3B001');
    session.tx.tables = cloneTables(saved);
  };
  const release = (session: Session, name: string): void => {
    session.tx?.savepoints.delete(name);
  };

  const SELECT_ONE = /^SELECT (\*|[\w:, ]+?) FROM (\w+)\.(\w+)(?: WHERE (.+?))?(?: ORDER BY ([\w, ]+?))?(?: LIMIT \$(\d+))?(?: OFFSET \$(\d+))?(?: FOR (?:UPDATE|SHARE(?: NOWAIT)?))?$/;

  // Checked in order; the first pattern that matches answers the statement.
  const rules: ReadonlyArray<readonly [RegExp, Handler]> = [
    [/^SAVEPOINT (\w+)$/, control('SAVEPOINT', savepoint)],
    [/^ROLLBACK TO SAVEPOINT (\w+)$/, control('ROLLBACK', rollbackTo)],
    [/^RELEASE SAVEPOINT (\w+)$/, control('RELEASE', release)],
    [/^SELECT set_config\('app\.tenant_id', \$1, true\)$/, (_m, params, session) => {
      session.tenantId = params[0] === '' || params[0] === null ? null : text(params[0]);
      return answer([{ set_config: params[0] }]);
    }],
    [/^SELECT set_config\('lock_timeout', \$1, true\)$/, (_m, params, session) => {
      session.lockTimeout = text(params[0]);
      return answer([{ set_config: params[0] }]);
    }],
    [/^SELECT current_setting\('lock_timeout'\) AS value$/, (_m, _params, session) => answer([{ value: session.lockTimeout }])],
    [/^SELECT pg_snapshot_xmin\(pg_current_snapshot\(\)\)::text AS value$/, (_m, _params, _session, tx) =>
      answer([{ value: String(tx.xid ?? nextXid) }])],
    [/^SELECT pg_snapshot_xmax\(pg_current_snapshot\(\)\)::text AS value$/, () => answer([{ value: String(nextXid) }])],
    [/^SELECT to_regclass\(\$1\) IS NOT NULL AS outbox, to_regclass\(\$2\) IS NOT NULL AS inbox$/, () => answer([{ outbox: true, inbox: true }])],
    [/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/, () => answer([{ pg_advisory_xact_lock: '' }])],
    [/^SELECT count\(\*\)::integer AS total FROM (\w+)\.(\w+)$/, countRows],
    [/^SELECT \(SELECT count\(\*\) FROM \w+\.outbox WHERE published_at IS NULL AND NOT held\) AS unpublished, \(SELECT count\(\*\) FROM \w+\.outbox WHERE held\) AS held$/, outboxCounts],
    [/^SELECT subscription, count\(\*\)::text AS count FROM \w+\.inbox GROUP BY subscription$/, inboxBySubscription],
    [/^SELECT c\.xid::text AS xid, c\.seq::text AS seq, c\.table, c\.op, c\.key, c\.before, c\.after, c\.columns, c\.origin, c\.actor_user_id, c\.actor_service, to_char\(c\.at, 'YYYY-MM-DD HH24:MI:SS\.MS'\) AS at, c\.request_id, c\.operation_id FROM \w+\.changelog AS c WHERE c\.xid < \$1::xid8 AND \(c\.xid, c\.seq\) > \(\$2::xid8, \$3::bigint\) ORDER BY c\.xid, c\.seq LIMIT \$4$/, changes],
    [/^SELECT \*, ARRAY\[\((\w+)\)::text\] AS (\w+) FROM \w+\.(\w+) WHERE tenant_id = \$1 ORDER BY \(\1\)::text COLLATE C NULLS FIRST LIMIT \$2$/, exportPage],
    [/^SELECT \*, ARRAY\[\((\w+)\)::text\] AS (\w+) FROM \w+\.(\w+) WHERE tenant_id = \$1 ORDER BY \1 NULLS FIRST LIMIT \$2$/, integerExportPage],
    [/^SELECT legacy_table, direction, .+ FROM \w+\.migration_watermark WHERE \(\$1::text IS NULL OR legacy_table = \$1\) AND \(\$2::text IS NULL OR direction = \$2\) ORDER BY legacy_table, direction$/, watermarks],
    [/^SELECT ([\w, ]+) FROM (\w+)\.(unit_gate) WHERE (?:\$1::text\[\] IS NULL OR )?unit = ANY\(\$1::text\[\]\)(?: ORDER BY (unit))?(?: FOR SHARE(?: NOWAIT)?)?$/, (m, params, session, tx) => {
      const units = params[0] === null ? undefined : (params[0] as unknown[]).map(text);
      const gates = ordered(rowsOf(tx, 'unit_gate').filter((row) => units === undefined || units.includes(text(row.unit))), 'unit');
      return answer(gates.map((row) => project(m[1] ?? '*', row)));
    }],
    [/^INSERT INTO \w+\.unit_gate \(unit\) SELECT unnest\(\$1::text\[\]\) ON CONFLICT \(unit\) DO NOTHING$/, (_m, params, _session, tx) => {
      const gates = rowsOf(tx, 'unit_gate');
      const missing = [...new Set((params[0] as unknown[]).map(text))].filter((unit) => !gates.some((row) => row.unit === unit));
      gates.push(...missing.map((unit) => storedRow('unit_gate', { unit }, tx)));
      xidOf(tx);
      return answer([], 'INSERT', missing.length);
    }],
    [/^INSERT INTO \w+\.tenant_registry \(([\w, ]+)\) VALUES (\(.+?\)) ON CONFLICT \(tenant_id\) DO UPDATE SET .+ WHERE \w+\.tenant_registry\.aggregate_version < EXCLUDED\.aggregate_version$/, registryUpsert],
    [/^INSERT INTO \w+\.migration_watermark \(legacy_table, direction, snapshot_seq, backup_lsn, finished_at\) VALUES \(\$1, \$2, \$3, \$4, \$5\) ON CONFLICT \(legacy_table, direction\) DO UPDATE SET snapshot_seq = EXCLUDED\.snapshot_seq, backup_lsn = EXCLUDED\.backup_lsn, finished_at = EXCLUDED\.finished_at RETURNING legacy_table, direction, .+$/, watermarkUpsert],
    [/^INSERT INTO (\w+)\.(\w+) \(([\w, ]+)\) VALUES (.+)$/, insert],
    [/^UPDATE (\w+)\.(\w+) SET (.+?)(?: WHERE (.+?))?(?: RETURNING (.+))?$/, update],
    [/^DELETE FROM (\w+)\.(\w+)(?: WHERE (.+?))?(?: RETURNING (.+))?$/, deleteRows],
    [SELECT_ONE, select],
  ];

  function begin(session: Session): QueryAnswer {
    if (session.tx !== null) throw new PgError('there is already a transaction in progress', '25001');
    session.tx = { tables: cloneTables(committed), savepoints: new Map(), statements: ['BEGIN'], xid: null };
    return answer([], 'BEGIN', null);
  }

  function finish(session: Session, outcome: RecordedTransaction['outcome']): QueryAnswer {
    const tx = session.tx;
    if (tx === null) return answer([], 'ROLLBACK', null);
    tx.statements.push(outcome === 'commit' ? 'COMMIT' : 'ROLLBACK');
    if (outcome === 'commit') committed = tx.tables;
    transactions.push({
      tenantId: session.tenantId,
      statements: tx.statements,
      writes: tx.statements.filter((statement) => WRITE.test(statement)),
      outcome,
    });
    session.tx = null;
    session.tenantId = null;
    return answer([], outcome === 'commit' ? 'COMMIT' : 'ROLLBACK', null);
  }

  function run(session: Session, sql: string, params: readonly unknown[]): QueryAnswer {
    if (sql === 'BEGIN') return begin(session);
    if (sql === 'COMMIT') return finish(session, 'commit');
    if (sql === 'ROLLBACK') return finish(session, 'rollback');
    const tx = session.tx;
    if (tx === null) throw new UnsupportedStatementError(`statement outside a transaction: ${sql}`);
    tx.statements.push(sql);
    for (const [pattern, handler] of rules) {
      const match = pattern.exec(sql);
      if (match !== null) return handler(match, params, session, tx);
    }
    throw new UnsupportedStatementError(`no in-memory rule for: ${sql}`);
  }

  /** Runs one statement of `session`, noting a failure in its transaction before it propagates. */
  function execute(session: Session, statement: string | { text: string; values?: unknown[] }, values?: unknown[]): QueryAnswer {
    const sql = normalise(typeof statement === 'string' ? statement : statement.text);
    const params = (typeof statement === 'string' ? values : (statement.values ?? values)) ?? [];
    try {
      return run(session, sql, params);
    } catch (err) {
      session.tx?.statements.push(`-- failed: ${err instanceof Error ? err.message : text(err)}`);
      throw err;
    }
  }

  const pool = {
    on: () => pool,
    end: (): Promise<void> => Promise.resolve(),
    connect() {
      const session: Session = { tenantId: null, lockTimeout: '0', tx: null };
      return Promise.resolve({
        query: (statement: string | { text: string; values?: unknown[] }, values?: unknown[]): Promise<QueryAnswer> =>
          Promise.resolve().then(() => execute(session, statement, values)),
        release: (): void => {
          if (session.tx !== null) finish(session, 'rollback');
        },
      });
    },
  };

  const db = tenantDbFromPool(pool as never, { schema: SCHEMA });
  return Object.freeze({
    schema: db.schema,
    withTenant: db.withTenant.bind(db),
    withMetadata: db.withMetadata.bind(db),
    end: db.end.bind(db),
    transactions,
    rows(table: MemoryTable): Row[] {
      return (committed.get(table) ?? []).map((row) => ({ ...row }));
    },
    seed(table: MemoryTable, rows: readonly Row[]): void {
      const stored = committed.get(table);
      if (stored === undefined) throw new UnsupportedStatementError(`table ${table} is not held in memory`);
      stored.push(...rows.map((row) => ({ ...row })));
    },
  });
}
