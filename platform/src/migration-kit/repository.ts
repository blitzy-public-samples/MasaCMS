/** Gated, audited writes of tenant-owned service tables: unit gate, row write, changelog row and write position in one transaction. */
import { changedColumns, encodeKey, encodeRow, legacyRowHash, type CanonicalColumn } from './canonical.js';
import { CHANGELOG_TABLE, isPlatformInfraTable, qualified, type ChangeOp, type ChangeOrigin } from './ddl.js';
import { acquireWriteGates, awaitReadable, isMigrationAuthority, type MigrationAuthority } from './gates.js';
import { requireTenantTx, type TenantTx } from '../tenancy/index.js';
import { currentRequestContext, recordWritePosition, systemClock, type Clock } from '../service-kit/index.js';
import { localTimestamp } from '../outbox/index.js';

/** A row keyed by column name, as a write supplies it or pg returns it. */
export type RepositoryRow = Record<string, unknown>;

/** One target table: catalog columns in catalog order, primary key without `tenant_id` (`null` when keyless), and its gated unit. */
export interface TableDefinition {
  table: string;
  columns: CanonicalColumn[];
  key: string[] | null;
  unit?: string;
}

/** Provenance of a write; actor and request ids default to the active request context, `origin` to `target`. */
export interface WriteContext {
  origin?: ChangeOrigin;
  operationId?: string;
  actorUserId?: string;
  actorService?: string;
  requestId?: string;
  authority?: MigrationAuthority;
}

/** Settings of `createRepository`; `owner` is the service name its write positions carry. */
export interface RepositoryOptions {
  owner: string;
  schema: string;
  tables: readonly TableDefinition[];
  clock?: Clock;
}

/** Raised for an undeclared, platform or malformed table, a transaction mismatch, a tenant mismatch, or a missing or unknown column. */
export class RepositoryError extends Error {
  override readonly name: string = 'RepositoryError';

  constructor(
    message: string,
    readonly table?: string,
  ) {
    super(table === undefined ? message : `${table}: ${message}`);
  }
}

/** Writes and gated reads of one service schema; every method takes the caller's open tenant transaction first. */
export interface Repository {
  readonly owner: string;
  readonly schema: string;
  /** The frozen definition of `table`; throws RepositoryError for an undeclared table. */
  definition(table: string): TableDefinition;
  /** Distinct declared units in declaration order. */
  units(): string[];
  /** Inserts `row` under the transaction tenant (keyless rows get their hash and next occurrence) and returns the stored row. */
  insert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx?: WriteContext): Promise<R>;
  /**
   * Inserts each row of a keyed table whose tenant and `conflict` values no stored row holds, with one changelog row each.
   * @returns the rows inserted, in input order.
   */
  insertAbsent<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    rows: readonly RepositoryRow[],
    conflict: readonly string[],
    ctx?: WriteContext,
  ): Promise<R[]>;
  /** Sets `patch` on the row with `key`; null when no row has it. */
  update<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, patch: RepositoryRow, ctx?: WriteContext): Promise<R | null>;
  /** Inserts `row`, or sets its non-key columns on the stored row with the same key. */
  upsert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx?: WriteContext): Promise<R>;
  /** Deletes the row with `key`; null when no row has it. */
  delete<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, ctx?: WriteContext): Promise<R | null>;
  /** Deletes the highest occurrence of a keyless row; null when none matches. */
  deleteOne<R = RepositoryRow>(tx: TenantTx, table: string, contentRow: RepositoryRow, ctx?: WriteContext): Promise<R | null>;
  /** Replaces one occurrence of a keyless row with `afterContentRow`; null when `beforeContentRow` matches none. */
  replaceOne<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    beforeContentRow: RepositoryRow,
    afterContentRow: RepositoryRow,
    ctx?: WriteContext,
  ): Promise<R | null>;
  /** Runs `fn` once no unit of `units` is in a write window's executing or import phase; that phase cannot start until `tx` ends. */
  read<T>(tx: TenantTx, units: string | readonly string[], fn: () => Promise<T>): Promise<T>;
  /** The row with `key`, read behind its unit's window phase; null when absent. */
  findByKey<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow): Promise<R | null>;
}

const TENANT_COLUMN = 'tenant_id';
const ROW_HASH_COLUMN = 'legacy_row_hash';
const OCCURRENCE_COLUMN = 'occurrence';
const KEYLESS_MANAGED: ReadonlySet<string> = new Set([TENANT_COLUMN, ROW_HASH_COLUMN, OCCURRENCE_COLUMN]);
const TENANT_ONLY: ReadonlySet<string> = new Set([TENANT_COLUMN]);
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
/** PostgreSQL's limit on the bind parameters of one statement. */
const MAX_BIND_PARAMETERS = 65_535;
/** Parameters a batched changelog insert shares across its rows, and those each row adds (key and after image). */
const CHANGE_SHARED_PARAMETERS = 11;
const CHANGE_ROW_PARAMETERS = 2;

type TableKind = 'keyed' | 'keyless' | 'any';

interface PreparedTable {
  readonly definition: TableDefinition;
  /** Schema-qualified, quoted table name. */
  readonly name: string;
  readonly columnNames: ReadonlySet<string>;
  /** Columns other than `tenant_id` and, for keyless tables, `legacy_row_hash` and `occurrence`. */
  readonly data: CanonicalColumn[];
  readonly dataNames: string[];
  /** `<schema>.<table>`, the advisory-lock prefix of keyless rows. */
  readonly lockPrefix: string;
}

interface Change {
  op: ChangeOp;
  key: string;
  before: string | null;
  after: string | null;
  columns: string[];
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Why `def` cannot be written through a repository, or undefined when it can. */
function definitionProblem(def: TableDefinition, names: readonly string[], columnNames: ReadonlySet<string>): string | undefined {
  if (isPlatformInfraTable(def.table)) return 'is a platform table written only by platform internals';
  if (columnNames.size !== names.length) return 'lists a column twice';
  if (!columnNames.has(TENANT_COLUMN)) return `has no ${TENANT_COLUMN} column`;
  if (def.key === null) {
    return columnNames.has(ROW_HASH_COLUMN) && columnNames.has(OCCURRENCE_COLUMN)
      ? undefined
      : `is keyless but lacks ${ROW_HASH_COLUMN} or ${OCCURRENCE_COLUMN}`;
  }
  return def.key.length > 0 && def.key.every((column) => column !== TENANT_COLUMN && columnNames.has(column))
    ? undefined
    : `key must name declared columns other than ${TENANT_COLUMN}`;
}

function prepareTable(schema: string, def: TableDefinition): PreparedTable {
  const name = qualified(schema, def.table);
  const key = def.key;
  const names = def.columns.map((column) => column.name);
  const columnNames: ReadonlySet<string> = new Set(names);
  const problem = definitionProblem(def, names, columnNames);
  if (problem !== undefined) {
    throw new RepositoryError(problem, def.table);
  }
  const columns = Object.freeze(def.columns.map((column) => Object.freeze({ ...column }))) as CanonicalColumn[];
  const definition: TableDefinition = Object.freeze({
    table: def.table,
    columns,
    key: key === null ? null : (Object.freeze([...key]) as string[]),
    ...(def.unit === undefined ? {} : { unit: def.unit }),
  });
  const managed = key === null ? KEYLESS_MANAGED : TENANT_ONLY;
  const data = Object.freeze(columns.filter((column) => !managed.has(column.name))) as CanonicalColumn[];
  return { definition, name, columnNames, data, dataNames: data.map((column) => column.name), lockPrefix: `${schema}.${def.table}` };
}

/** Throws unless every column of `row` is declared and its `tenant_id`, when set, is the transaction tenant. */
function checkRow(t: PreparedTable, tx: TenantTx, row: RepositoryRow): void {
  const undeclared = Object.keys(row).find((column) => !t.columnNames.has(column));
  if (undeclared !== undefined) {
    throw new RepositoryError(`has no column ${undeclared}`, t.definition.table);
  }
  const tenant = row[TENANT_COLUMN];
  if (tenant !== undefined && tenant !== null && String(tenant).toLowerCase() !== tx.tenantId) {
    throw new RepositoryError(`row tenant ${String(tenant)} is not the transaction tenant ${tx.tenantId}`, t.definition.table);
  }
}

/** Defined values of `row` other than `tenant_id` and the columns in `skip`. */
function writableValues(row: RepositoryRow, skip: readonly string[] = []): RepositoryRow {
  return Object.fromEntries(
    Object.entries(row).filter(([column, value]) => value !== undefined && column !== TENANT_COLUMN && !skip.includes(column)),
  );
}

/** Tenant then key values of `key`, in key order; throws when a key column has no value. */
function keyValues(t: PreparedTable, tx: TenantTx, key: RepositoryRow): unknown[] {
  const columns = t.definition.key ?? [];
  const missing = columns.find((column) => key[column] === undefined || key[column] === null);
  if (missing !== undefined) {
    throw new RepositoryError(`key has no value for ${missing}`, t.definition.table);
  }
  return [tx.tenantId, ...columns.map((column) => key[column])];
}

/** Predicate on tenant and key with placeholders numbered from `first`, matching `keyValues`. */
function keyWhere(t: PreparedTable, first: number): string {
  return [TENANT_COLUMN, ...(t.definition.key ?? [])].map((column, i) => `${ident(column)} = $${first + i}`).join(' AND ');
}

function image(t: PreparedTable, row: RepositoryRow): string {
  return encodeRow(t.definition.columns, row);
}

function changeKey(t: PreparedTable, row: RepositoryRow): string {
  const key = t.definition.key;
  return key === null ? encodeRow(t.data, row) : encodeKey(t.definition.columns, key, row);
}

function updateChange(t: PreparedTable, before: RepositoryRow, after: RepositoryRow): Change {
  return {
    op: 'update',
    key: changeKey(t, before),
    before: image(t, before),
    after: image(t, after),
    columns: changedColumns(t.data, before, after),
  };
}

async function insertRow(tx: TenantTx, t: PreparedTable, values: RepositoryRow, ignoreConflict: boolean): Promise<RepositoryRow | undefined> {
  const columns = Object.keys(values);
  const { rows } = await tx.query(
    `INSERT INTO ${t.name} (${columns.map(ident).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})` +
      `${ignoreConflict ? ' ON CONFLICT DO NOTHING' : ''} RETURNING *`,
    Object.values(values),
  );
  return rows[0];
}

/** Throws unless `conflict` names declared columns other than `tenant_id`. */
function checkConflict(t: PreparedTable, conflict: readonly string[]): void {
  if (conflict.length === 0 || !conflict.every((column) => column !== TENANT_COLUMN && t.columnNames.has(column))) {
    throw new RepositoryError(`conflict must name declared columns other than ${TENANT_COLUMN}`, t.definition.table);
  }
}

/** Rows per batched insert so that neither its row statement nor its changelog statement exceeds MAX_BIND_PARAMETERS. */
function rowsPerStatement(columnCount: number): number {
  return Math.min(
    Math.floor((MAX_BIND_PARAMETERS - 1) / Math.max(columnCount, 1)),
    Math.floor((MAX_BIND_PARAMETERS - CHANGE_SHARED_PARAMETERS) / CHANGE_ROW_PARAMETERS),
  );
}

/** One multi-row insert of `rows` that skips each row whose tenant and `conflict` values a stored row holds; returns the rows inserted. */
async function insertRowsAbsent(
  tx: TenantTx,
  t: PreparedTable,
  rows: readonly RepositoryRow[],
  columns: readonly string[],
  conflict: readonly string[],
): Promise<RepositoryRow[]> {
  const values: unknown[] = [tx.tenantId];
  const tuples = rows.map((row) => {
    const cells = columns.map((column) => {
      if (row[column] === undefined) return 'DEFAULT';
      values.push(row[column]);
      return `$${values.length}`;
    });
    return `(${['$1', ...cells].join(', ')})`;
  });
  const { rows: stored } = await tx.query(
    `INSERT INTO ${t.name} (${[TENANT_COLUMN, ...columns].map(ident).join(', ')}) VALUES ${tuples.join(', ')}` +
      ` ON CONFLICT (${[TENANT_COLUMN, ...conflict].map(ident).join(', ')}) DO NOTHING RETURNING *`,
    values,
  );
  return stored;
}

async function selectRow(tx: TenantTx, t: PreparedTable, keyVals: unknown[], forUpdate: boolean): Promise<RepositoryRow | undefined> {
  const { rows } = await tx.query(`SELECT * FROM ${t.name} WHERE ${keyWhere(t, 1)}${forUpdate ? ' FOR UPDATE' : ''}`, keyVals);
  return rows[0];
}

/** Sets `values` on the row with `keyVals`, which the caller has locked FOR UPDATE. */
async function updateRow(tx: TenantTx, t: PreparedTable, keyVals: unknown[], values: RepositoryRow): Promise<RepositoryRow> {
  const columns = Object.keys(values);
  const { rows } = await tx.query(
    `UPDATE ${t.name} SET ${columns.map((column, i) => `${ident(column)} = $${i + 1}`).join(', ')}` +
      ` WHERE ${keyWhere(t, columns.length + 1)} RETURNING *`,
    [...Object.values(values), ...keyVals],
  );
  return rows[0] as RepositoryRow;
}

/** Serialises writers of identical keyless rows; locks are taken in sorted order so two writers never deadlock. */
async function lockHashes(tx: TenantTx, t: PreparedTable, hashes: readonly string[]): Promise<void> {
  for (const hash of [...new Set(hashes)].sort()) {
    await tx.query(ADVISORY_LOCK_SQL, [`${t.lockPrefix}:${hash}`]);
  }
}

const OCCURRENCE_WHERE = `${ident(TENANT_COLUMN)} = $1 AND ${ident(ROW_HASH_COLUMN)} = $2`;

/** Deletes and returns the highest occurrence of `hash`, so the remaining occurrences stay numbered 1..n. */
async function removeOccurrence(tx: TenantTx, t: PreparedTable, hash: string): Promise<RepositoryRow | undefined> {
  const occurrence = ident(OCCURRENCE_COLUMN);
  const { rows } = await tx.query(
    `DELETE FROM ${t.name} WHERE ${OCCURRENCE_WHERE}` +
      ` AND ${occurrence} = (SELECT max(${occurrence}) FROM ${t.name} WHERE ${OCCURRENCE_WHERE}) RETURNING *`,
    [tx.tenantId, hash],
  );
  return rows[0];
}

/** Inserts the content columns of `row` as the next occurrence of `hash`. */
async function insertOccurrence(tx: TenantTx, t: PreparedTable, row: RepositoryRow, hash: string): Promise<RepositoryRow> {
  const { rows } = await tx.query<{ next: string }>(
    `SELECT (coalesce(max(${ident(OCCURRENCE_COLUMN)}), 0) + 1)::text AS next FROM ${t.name} WHERE ${OCCURRENCE_WHERE}`,
    [tx.tenantId, hash],
  );
  const values: RepositoryRow = { [TENANT_COLUMN]: tx.tenantId };
  for (const column of t.dataNames) {
    values[column] = row[column] ?? null;
  }
  values[ROW_HASH_COLUMN] = hash;
  values[OCCURRENCE_COLUMN] = (rows[0] as { next: string }).next;
  return (await insertRow(tx, t, values, false)) as RepositoryRow;
}

/** Builds the repository of `schema`; throws RepositoryError for a platform, duplicate or malformed table definition. */
export function createRepository({ owner, schema, tables, clock = systemClock }: RepositoryOptions): Repository {
  const changelogInto =
    `INSERT INTO ${qualified(schema, CHANGELOG_TABLE)}` +
    ' (tenant_id, "table", op, key, before, after, columns, origin, actor_user_id, actor_service, at, request_id, operation_id)';
  const changelogInsert = `${changelogInto} VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, $12, $13) RETURNING xid::text AS xid`;
  const prepared = new Map<string, PreparedTable>();
  for (const def of tables) {
    if (prepared.has(def.table)) {
      throw new RepositoryError('is declared twice', def.table);
    }
    prepared.set(def.table, prepareTable(schema, def));
  }
  const declaredUnits = [...new Set(tables.flatMap((def) => (def.unit === undefined ? [] : [def.unit])))];
  const positioned = new WeakSet<TenantTx>();

  function lookup(table: string): PreparedTable {
    const t = prepared.get(table);
    if (t === undefined) {
      throw new RepositoryError(`is not a declared table of schema ${schema}`, table);
    }
    return t;
  }

  function guard(tx: TenantTx): void {
    requireTenantTx();
    if ((tx as { kind?: unknown } | undefined)?.kind !== 'tenant' || tx.schema !== schema) {
      throw new RepositoryError(`needs a tenant transaction on schema ${schema}`);
    }
  }

  function open(tx: TenantTx, table: string, kind: TableKind): PreparedTable {
    guard(tx);
    const t = lookup(table);
    const keyless = t.definition.key === null;
    if ((kind === 'keyed' && keyless) || (kind === 'keyless' && !keyless)) {
      throw new RepositoryError(
        keyless ? 'has no primary key; write it with insert, deleteOne or replaceOne' : 'has a primary key; write it with insert, update, upsert or delete',
        table,
      );
    }
    return t;
  }

  async function gate(tx: TenantTx, t: PreparedTable, ctx: WriteContext): Promise<void> {
    const unit = t.definition.unit;
    if (unit !== undefined && !isMigrationAuthority(ctx.authority)) {
      await acquireWriteGates(tx, [unit]);
    }
  }

  /** Origin, actors, time, request and operation of a changelog row, in changelog column order. */
  function provenance(ctx: WriteContext): unknown[] {
    const request = currentRequestContext();
    return [
      ctx.origin ?? 'target',
      ctx.actorUserId ?? request?.user?.sub ?? null,
      ctx.actorService ?? request?.service?.name ?? null,
      localTimestamp(clock.now()),
      ctx.requestId ?? request?.requestId ?? null,
      ctx.operationId ?? null,
    ];
  }

  /** Records the xid of `logged` as the owner write position when `tx` commits, once per transaction. */
  function recordPosition(tx: TenantTx, logged: readonly { xid: string }[]): void {
    if (positioned.has(tx)) {
      return;
    }
    positioned.add(tx);
    // Every changelog row of one transaction carries the same xid.
    const xid = (logged[0] as { xid: string }).xid;
    tx.onCommit(() => {
      // recordWritePosition throws outside a request, where no response carries the position.
      if (currentRequestContext() !== undefined) {
        recordWritePosition(owner, xid);
      }
    });
  }

  async function logChange(tx: TenantTx, t: PreparedTable, change: Change, ctx: WriteContext): Promise<void> {
    const { rows } = await tx.query<{ xid: string }>(changelogInsert, [
      tx.tenantId,
      t.definition.table,
      change.op,
      change.key,
      change.before,
      change.after,
      change.columns,
      ...provenance(ctx),
    ]);
    recordPosition(tx, rows);
  }

  function insertChange(t: PreparedTable, stored: RepositoryRow): Change {
    return { op: 'insert', key: changeKey(t, stored), before: null, after: image(t, stored), columns: t.dataNames };
  }

  /** Writes the insert changelog rows of `stored`, which is not empty, in one statement and in its order. */
  async function logInserts(tx: TenantTx, t: PreparedTable, stored: readonly RepositoryRow[], ctx: WriteContext): Promise<void> {
    const changes = stored.map((row) => insertChange(t, row));
    const { op, before, columns } = changes[0] as Change;
    const values: unknown[] = [tx.tenantId, t.definition.table, op, before, columns, ...provenance(ctx)];
    const tuples = changes.map((change) => {
      values.push(change.key, change.after);
      return `($1, $2, $3, $${values.length - 1}, $4, $${values.length}, $5::text[], $6, $7, $8, $9, $10, $11)`;
    });
    const { rows } = await tx.query<{ xid: string }>(`${changelogInto} VALUES ${tuples.join(', ')} RETURNING xid::text AS xid`, values);
    recordPosition(tx, rows);
  }

  function deleteChange(t: PreparedTable, removed: RepositoryRow): Change {
    return { op: 'delete', key: changeKey(t, removed), before: image(t, removed), after: null, columns: t.dataNames };
  }

  async function insert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    const t = open(tx, table, 'any');
    checkRow(t, tx, row);
    let stored: RepositoryRow;
    if (t.definition.key === null) {
      const hash = legacyRowHash(t.data, row);
      await gate(tx, t, ctx);
      await lockHashes(tx, t, [hash]);
      stored = await insertOccurrence(tx, t, row, hash);
    } else {
      await gate(tx, t, ctx);
      stored = (await insertRow(tx, t, { [TENANT_COLUMN]: tx.tenantId, ...writableValues(row) }, false)) as RepositoryRow;
    }
    await logChange(tx, t, insertChange(t, stored), ctx);
    return stored as R;
  }

  async function insertAbsent<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    rows: readonly RepositoryRow[],
    conflict: readonly string[],
    ctx: WriteContext = {},
  ): Promise<R[]> {
    const t = open(tx, table, 'keyed');
    checkConflict(t, conflict);
    for (const row of rows) {
      checkRow(t, tx, row);
    }
    if (rows.length === 0) {
      return [];
    }
    await gate(tx, t, ctx);
    const writable = rows.map((row) => writableValues(row));
    const present = new Set(writable.flatMap((row) => Object.keys(row)));
    const columns = t.dataNames.filter((column) => present.has(column));
    const size = rowsPerStatement(columns.length);
    const inserted: RepositoryRow[] = [];
    for (let start = 0; start < writable.length; start += size) {
      const stored = await insertRowsAbsent(tx, t, writable.slice(start, start + size), columns, conflict);
      if (stored.length > 0) {
        await logInserts(tx, t, stored, ctx);
        inserted.push(...stored);
      }
    }
    return inserted as R[];
  }

  async function update<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    key: RepositoryRow,
    patch: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    const t = open(tx, table, 'keyed');
    checkRow(t, tx, key);
    checkRow(t, tx, patch);
    const values = writableValues(patch);
    if (Object.keys(values).length === 0) {
      throw new RepositoryError('update patch sets no column', table);
    }
    const keyVals = keyValues(t, tx, key);
    await gate(tx, t, ctx);
    const before = await selectRow(tx, t, keyVals, true);
    if (before === undefined) {
      return null;
    }
    const after = await updateRow(tx, t, keyVals, values);
    await logChange(tx, t, updateChange(t, before, after), ctx);
    return after as R;
  }

  async function upsert<R = RepositoryRow>(tx: TenantTx, table: string, row: RepositoryRow, ctx: WriteContext = {}): Promise<R> {
    const t = open(tx, table, 'keyed');
    checkRow(t, tx, row);
    const keyVals = keyValues(t, tx, row);
    const values = writableValues(row);
    await gate(tx, t, ctx);
    let before = await selectRow(tx, t, keyVals, true);
    if (before === undefined) {
      const inserted = await insertRow(tx, t, { [TENANT_COLUMN]: tx.tenantId, ...values }, true);
      if (inserted !== undefined) {
        await logChange(tx, t, insertChange(t, inserted), ctx);
        return inserted as R;
      }
      // A concurrent transaction committed the same key after the first read; its row is updated instead.
      before = await selectRow(tx, t, keyVals, true);
      if (before === undefined) {
        throw new RepositoryError('insert conflicts with a row outside this key or tenant', table);
      }
    }
    const set = writableValues(values, t.definition.key ?? []);
    if (Object.keys(set).length === 0) {
      return before as R;
    }
    const after = await updateRow(tx, t, keyVals, set);
    await logChange(tx, t, updateChange(t, before, after), ctx);
    return after as R;
  }

  async function remove<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow, ctx: WriteContext = {}): Promise<R | null> {
    const t = open(tx, table, 'keyed');
    checkRow(t, tx, key);
    const keyVals = keyValues(t, tx, key);
    await gate(tx, t, ctx);
    const { rows } = await tx.query(`DELETE FROM ${t.name} WHERE ${keyWhere(t, 1)} RETURNING *`, keyVals);
    const removed = rows[0];
    if (removed === undefined) {
      return null;
    }
    await logChange(tx, t, deleteChange(t, removed), ctx);
    return removed as R;
  }

  async function deleteOne<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    contentRow: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    const t = open(tx, table, 'keyless');
    checkRow(t, tx, contentRow);
    const hash = legacyRowHash(t.data, contentRow);
    await gate(tx, t, ctx);
    await lockHashes(tx, t, [hash]);
    const removed = await removeOccurrence(tx, t, hash);
    if (removed === undefined) {
      return null;
    }
    await logChange(tx, t, deleteChange(t, removed), ctx);
    return removed as R;
  }

  async function replaceOne<R = RepositoryRow>(
    tx: TenantTx,
    table: string,
    beforeContentRow: RepositoryRow,
    afterContentRow: RepositoryRow,
    ctx: WriteContext = {},
  ): Promise<R | null> {
    const t = open(tx, table, 'keyless');
    checkRow(t, tx, beforeContentRow);
    checkRow(t, tx, afterContentRow);
    const beforeHash = legacyRowHash(t.data, beforeContentRow);
    const afterHash = legacyRowHash(t.data, afterContentRow);
    await gate(tx, t, ctx);
    await lockHashes(tx, t, [beforeHash, afterHash]);
    const removed = await removeOccurrence(tx, t, beforeHash);
    if (removed === undefined) {
      return null;
    }
    const stored = await insertOccurrence(tx, t, afterContentRow, afterHash);
    await logChange(tx, t, updateChange(t, removed, stored), ctx);
    return stored as R;
  }

  async function read<T>(tx: TenantTx, units: string | readonly string[], fn: () => Promise<T>): Promise<T> {
    guard(tx);
    await awaitReadable(tx, typeof units === 'string' ? [units] : units);
    return fn();
  }

  async function findByKey<R = RepositoryRow>(tx: TenantTx, table: string, key: RepositoryRow): Promise<R | null> {
    const t = open(tx, table, 'keyed');
    checkRow(t, tx, key);
    const keyVals = keyValues(t, tx, key);
    const select = async (): Promise<R | null> => ((await selectRow(tx, t, keyVals, false)) ?? null) as R | null;
    const unit = t.definition.unit;
    return unit === undefined ? select() : read(tx, unit, select);
  }

  return Object.freeze({
    owner,
    schema,
    definition: (table: string): TableDefinition => lookup(table).definition,
    units: (): string[] => [...declaredUnits],
    insert,
    insertAbsent,
    update,
    upsert,
    delete: remove,
    deleteOne,
    replaceOne,
    read,
    findByKey,
  });
}
