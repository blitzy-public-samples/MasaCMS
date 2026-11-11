/** Reverse-projection writers of target changes into live legacy SQL Server tables, and the projector checkpoint. */
import { Buffer } from 'node:buffer';

import sql from 'mssql';
import type { Request } from 'mssql';

import { LEGACY_PROGRAM_ID_COLUMN, decodeRow, programTableName } from '@opt2/platform/migration-kit';
import type { CanonicalColumn, CanonicalValue, ChangeOp, ProjectedChangeRow } from '@opt2/platform/migration-kit';

import { findColumn, parseQualifiedName, qualifiedName } from '../extract/index.js';
import type { CatalogColumn, LegacyTableRef, TableCatalog } from '../extract/index.js';
import { quoteIdent } from '../legacy/index.js';
import type { LegacyTableTarget } from '../owners/index.js';

/** Projector checkpoint table of the legacy database, one row per owner and tenant. */
export const CHECKPOINT_TABLE = 'opt2_sync.projector_checkpoint';

/** Anything that issues requests: a pool, or the batch transaction every writer here runs in. */
export interface RequestScope {
  request(): Request;
}

/** One stored checkpoint; xids and seq are decimal strings because xid8 values exceed 2^53. */
export interface CheckpointRow {
  owner: string;
  tenantId: string;
  cursorXid: string;
  cursorSeq: string;
  appliedHorizon: string;
  batchId: string | null;
  rowsApplied: number;
  updatedAt: Date | null;
}

/** Checkpoint values one batch writes; the server sets `updated_at`. */
export type CheckpointWrite = Omit<CheckpointRow, 'batchId' | 'updatedAt'> & { batchId: string };

interface CheckpointRecord {
  owner: string;
  tenant_id: string;
  cursor_xid: string;
  cursor_seq: string;
  applied_horizon: string;
  batch_id: string | null;
  rows_applied: number;
  updated_at: Date | null;
}

// Decimals arrive as varchar so no xid passes through a JS number.
const CHECKPOINT_SELECT = `SELECT owner, tenant_id, CONVERT(varchar(20), cursor_xid) AS cursor_xid, CONVERT(varchar(20), cursor_seq) AS cursor_seq, CONVERT(varchar(20), applied_horizon) AS applied_horizon, batch_id, rows_applied, updated_at FROM ${CHECKPOINT_TABLE}`;

const CHECKPOINT_UPSERT = `UPDATE ${CHECKPOINT_TABLE} WITH (UPDLOCK, HOLDLOCK) SET cursor_xid = CAST(@cursorXid AS decimal(20,0)), cursor_seq = CAST(@cursorSeq AS bigint), applied_horizon = CASE WHEN applied_horizon > CAST(@appliedHorizon AS decimal(20,0)) THEN applied_horizon ELSE CAST(@appliedHorizon AS decimal(20,0)) END, batch_id = @batchId, rows_applied = @rowsApplied, updated_at = SYSDATETIME() WHERE owner = @owner AND tenant_id = @tenantId;
IF @@ROWCOUNT = 0 INSERT INTO ${CHECKPOINT_TABLE} (owner, tenant_id, cursor_xid, cursor_seq, applied_horizon, batch_id, rows_applied, updated_at) VALUES (@owner, @tenantId, CAST(@cursorXid AS decimal(20,0)), CAST(@cursorSeq AS bigint), CAST(@appliedHorizon AS decimal(20,0)), @batchId, @rowsApplied, SYSDATETIME());
${CHECKPOINT_SELECT} WHERE owner = @owner AND tenant_id = @tenantId;`;

function toCheckpoint(record: CheckpointRecord): CheckpointRow {
  return {
    owner: record.owner,
    tenantId: record.tenant_id,
    cursorXid: record.cursor_xid,
    cursorSeq: record.cursor_seq,
    appliedHorizon: record.applied_horizon,
    batchId: record.batch_id,
    rowsApplied: record.rows_applied,
    updatedAt: record.updated_at,
  };
}

function bindCheckpointKey(request: Request, owner: string, tenantId: string): void {
  request.input('owner', sql.NVarChar(64), owner);
  request.input('tenantId', sql.VarChar(36), tenantId);
}

/** Stored checkpoints, ordered by owner and tenant; `owners` keeps only those owners' rows. */
export async function readCheckpoints(scope: RequestScope, filter: { owners?: readonly string[] } = {}): Promise<CheckpointRow[]> {
  const request = scope.request();
  let where = '';
  if (filter.owners !== undefined) {
    if (filter.owners.length === 0) return [];
    const names = filter.owners.map((owner, index) => {
      const name = `o${String(index)}`;
      request.input(name, sql.NVarChar(64), owner);
      return `@${name}`;
    });
    where = ` WHERE owner IN (${names.join(', ')})`;
  }
  const result = await request.query<CheckpointRecord>(`${CHECKPOINT_SELECT}${where} ORDER BY owner, tenant_id`);
  return result.recordset.map(toCheckpoint);
}

/** The checkpoint of one owner and tenant, or null before its first batch. */
export async function readCheckpoint(scope: RequestScope, owner: string, tenantId: string): Promise<CheckpointRow | null> {
  const request = scope.request();
  bindCheckpointKey(request, owner, tenantId);
  const result = await request.query<CheckpointRecord>(`${CHECKPOINT_SELECT} WHERE owner = @owner AND tenant_id = @tenantId`);
  const record = result.recordset[0];
  return record === undefined ? null : toCheckpoint(record);
}

/** Writes the batch's checkpoint in the batch transaction and returns the stored row; the applied horizon never moves back. */
export async function upsertCheckpoint(scope: RequestScope, row: CheckpointWrite): Promise<CheckpointRow> {
  const request = scope.request();
  bindCheckpointKey(request, row.owner, row.tenantId);
  request.input('cursorXid', sql.VarChar(sql.MAX), row.cursorXid);
  request.input('cursorSeq', sql.VarChar(sql.MAX), row.cursorSeq);
  request.input('appliedHorizon', sql.VarChar(sql.MAX), row.appliedHorizon);
  request.input('batchId', sql.NVarChar(64), row.batchId);
  request.input('rowsApplied', sql.Int, row.rowsApplied);
  // UPDATE and INSERT return no result set, so the first one is the closing SELECT's.
  const result = await request.query<CheckpointRecord>(CHECKPOINT_UPSERT);
  const stored = result.recordset[0];
  if (stored === undefined) throw new Error(`checkpoint of ${row.owner} / ${row.tenantId} was not stored`);
  return toCheckpoint(stored);
}

/** A target change in legacy form: the physical legacy table and the decoded legacy images. */
export interface LegacyChange {
  owner: string;
  tenantId: string;
  unit: string;
  xid: string;
  seq: string;
  op: ChangeOp;
  /** Legacy table name the ownership catalog resolves; `Program_<id>.<table>` for a folded table. */
  legacyTable: string;
  physicalTable: LegacyTableRef;
  /** Columns the images are encoded over, without `legacy_program_id`. */
  columns: CanonicalColumn[];
  /** Encoded legacy key as the owner projected it; the whole-row encoding for keyless tables. */
  key: string;
  before?: Record<string, CanonicalValue>;
  after?: Record<string, CanonicalValue>;
  /** Legacy names of the columns an update changed. */
  changedColumns?: string[];
  operationId?: string;
  programId?: number;
}

/** The unit a changelog row is decoded for, with the legacy columns its owner encodes that unit's images over. */
export interface DecodeLegacyContext {
  owner: string;
  tenantId: string;
  unit: string;
  /** The owner's declaration of the unit's legacy columns, in encoding order: `ExportTable.columns` of the unit's export; the changes feed carries none. */
  columns: readonly CanonicalColumn[];
}

function isProgramColumn(name: string): boolean {
  return name.toLowerCase() === LEGACY_PROGRAM_ID_COLUMN;
}

/** Value of column `name` in an image, matched case-insensitively as SQL Server resolves names; undefined when absent. */
function valueOf(image: Readonly<Record<string, CanonicalValue>>, name: string): CanonicalValue | undefined {
  if (Object.hasOwn(image, name)) return image[name];
  const lower = name.toLowerCase();
  const found = Object.keys(image).find((key) => key.toLowerCase() === lower);
  return found === undefined ? undefined : image[found];
}

function withoutProgramColumn(image: Record<string, CanonicalValue>): Record<string, CanonicalValue> {
  return Object.fromEntries(Object.entries(image).filter(([name]) => !isProgramColumn(name)));
}

function tableRef(name: string): LegacyTableRef {
  const { schema, table } = parseQualifiedName(name);
  return { schema, table, qualified: qualifiedName(schema, table) };
}

/**
 * Decodes the row's legacy projection for `ctx.unit`; null when the row has none (target-only tables).
 * A folded row is addressed to its `Program_<id>` schema, with the program id taken from the projection or the image.
 */
export function decodeLegacyChange(row: ProjectedChangeRow, ctx: DecodeLegacyContext): LegacyChange | null {
  const projections = row.legacy.filter((entry) => entry.unit === ctx.unit);
  const projection = projections[0];
  if (projection === undefined) return null;
  // Every unit has exactly one legacy table, so a second projection means the owner and the ownership file disagree.
  if (projections.length > 1) {
    throw new Error(`changelog row ${row.xid}:${row.seq} of ${row.table} has ${String(projections.length)} legacy projections for unit ${ctx.unit}`);
  }
  const decode = (encoding: string | null): Record<string, CanonicalValue> | undefined =>
    encoding === null ? undefined : decodeRow(ctx.columns, encoding);
  const before = decode(projection.before);
  const after = decode(projection.after);
  const imageProgramId = valueOf(before ?? after ?? {}, LEGACY_PROGRAM_ID_COLUMN);
  const programId = projection.legacyProgramId ?? (typeof imageProgramId === 'string' ? Number(imageProgramId) : undefined);
  const legacyTable =
    programId === undefined ? projection.legacyTable : programTableName(programId, parseQualifiedName(projection.legacyTable).table);

  const change: LegacyChange = {
    owner: ctx.owner,
    tenantId: ctx.tenantId,
    unit: ctx.unit,
    xid: row.xid,
    seq: row.seq,
    op: row.op,
    legacyTable,
    physicalTable: tableRef(legacyTable),
    columns: ctx.columns.filter((column) => !isProgramColumn(column.name)),
    key: projection.key,
  };
  if (before !== undefined) change.before = withoutProgramColumn(before);
  if (after !== undefined) change.after = withoutProgramColumn(after);
  if (row.op === 'update') change.changedColumns = projection.columns.filter((name) => !isProgramColumn(name));
  if (row.operationId !== null) change.operationId = row.operationId;
  if (programId !== undefined) change.programId = programId;
  return change;
}

const BINARY_COLLATION = 'Latin1_General_BIN2';

function textOf(column: CatalogColumn, value: string | Buffer): string {
  if (typeof value !== 'string') throw new TypeError(`column ${column.name} (${column.sqlType}) expects text, got bytes`);
  return value;
}

function bytesOf(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'hex');
}

/** Target type of `CAST(@p AS …)` for a column whose canonical text converts exactly. */
function castType(column: CatalogColumn): string {
  switch (column.sqlType) {
    case 'decimal':
    case 'numeric':
      return `decimal(${String(column.precision)},${String(column.numericScale ?? 0)})`;
    case 'int':
    case 'smallint':
    case 'tinyint':
    case 'bigint':
    case 'bit':
    case 'float':
    case 'real':
    case 'money':
    case 'smallmoney':
    case 'uniqueidentifier':
      return column.sqlType;
    default:
      throw new TypeError(`column ${column.name} has no parameter conversion for SQL Server type ${column.sqlType}`);
  }
}

/**
 * Binds a canonical value for `column` as `@name` and returns its SQL expression, typed as the column: text in the
 * column's character family, bytes as varbinary, numbers through CAST and timestamps through CONVERT style 126, so no
 * value passes through a JS number or Date. NULL binds nothing and returns `NULL`.
 */
export function bindValue(request: Pick<Request, 'input'>, name: string, column: CatalogColumn, value: CanonicalValue): string {
  if (value === null) return 'NULL';
  const param = `@${name}`;
  switch (column.sqlType) {
    case 'char':
    case 'varchar':
    case 'text':
      request.input(name, sql.VarChar(sql.MAX), textOf(column, value));
      return param;
    case 'nchar':
    case 'nvarchar':
    case 'ntext':
    case 'xml':
      request.input(name, sql.NVarChar(sql.MAX), textOf(column, value));
      return param;
    case 'binary':
    case 'varbinary':
    case 'image':
      request.input(name, sql.VarBinary(sql.MAX), bytesOf(value));
      return param;
    case 'datetime':
    case 'smalldatetime':
    case 'datetime2':
    case 'date':
      request.input(name, sql.VarChar(sql.MAX), textOf(column, value));
      return `CONVERT(${column.sqlType}, ${param}, 126)`;
    default: {
      const type = castType(column);
      request.input(name, sql.VarChar(sql.MAX), textOf(column, value));
      return `CAST(${param} AS ${type})`;
    }
  }
}

type Bind = (column: CatalogColumn, value: CanonicalValue) => string;

/** Numbers the request's parameters `p0`, `p1`, … */
function binder(request: Request): Bind {
  let next = 0;
  return (column, value) => bindValue(request, `p${String(next++)}`, column, value);
}

/** Column expression comparable with a bound value: large-object types are cast to their max-length equivalents. */
function comparable(column: CatalogColumn): { expr: string; family: 'text' | 'binary' | 'other' } {
  const name = quoteIdent(column.name);
  switch (column.sqlType) {
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
      return { expr: name, family: 'text' };
    case 'text':
      // varchar(max), not nvarchar(max): its DATALENGTH must match the varchar parameter a text column binds.
      return { expr: `CAST(${name} AS varchar(max))`, family: 'text' };
    case 'ntext':
    case 'xml':
      return { expr: `CAST(${name} AS nvarchar(max))`, family: 'text' };
    case 'binary':
    case 'varbinary':
      return { expr: name, family: 'binary' };
    case 'image':
      return { expr: `CAST(${name} AS varbinary(max))`, family: 'binary' };
    default:
      return { expr: name, family: 'other' };
  }
}

/** Key equality under the column's own collation, as SQL Server enforces key uniqueness. */
function keyCondition(column: CatalogColumn, value: CanonicalValue, bind: Bind): string {
  const { expr } = comparable(column);
  return value === null ? `${quoteIdent(column.name)} IS NULL` : `${expr} = ${bind(column, value)}`;
}

/**
 * Exact, null-aware equality for matching one of several identical rows: the default collation ignores case and
 * trailing spaces, and binary comparison pads with zeros, so text compares under a binary collation and both compare lengths.
 */
function exactCondition(column: CatalogColumn, value: CanonicalValue, bind: Bind): string {
  if (value === null) return `${quoteIdent(column.name)} IS NULL`;
  const { expr, family } = comparable(column);
  const param = bind(column, value);
  switch (family) {
    case 'text':
      return `(${expr} COLLATE ${BINARY_COLLATION} = ${param} AND DATALENGTH(${expr}) = DATALENGTH(${param}))`;
    case 'binary':
      return `(${expr} = ${param} AND DATALENGTH(${expr}) = DATALENGTH(${param}))`;
    case 'other':
      return `${expr} = ${param}`;
  }
}

const PREDICATE = /^\s*(\w+)\s*(?:=\s*(.+?)|in\s*\((.+)\))\s*$/i;
const LITERAL = /^\s*(?:'((?:[^']|'')*)'|(-?\d+))\s*$/;

/**
 * SQL form of an ownership row predicate of the shape `<column> = <literal>` or `<column> in (<literals>)` over a
 * column of the table; undefined for any other predicate (one decided through a parent row or a class map).
 */
function rowPredicateCondition(catalog: TableCatalog, predicate: string | null, bind: Bind): string | undefined {
  const match = predicate === null ? null : PREDICATE.exec(predicate);
  const column = match?.[1] === undefined ? undefined : findColumn(catalog, match[1]);
  if (match === null || column === undefined) return undefined;
  const values: string[] = [];
  for (const part of (match[2] ?? match[3] ?? '').split(',')) {
    const literal = LITERAL.exec(part);
    if (literal === null) return undefined;
    values.push(literal[1] === undefined ? (literal[2] ?? '') : literal[1].replaceAll("''", "'"));
  }
  return `${comparable(column).expr} IN (${values.map((value) => bind(column, value)).join(', ')})`;
}

/** Legacy diverged from the target's before-image: the change found no legacy row to act on; the caller rolls the batch back. */
export class ProjectionConflictError extends Error {
  override readonly name = 'ProjectionConflictError';
  readonly table: string;
  readonly op: ChangeOp;
  readonly key: string;

  constructor(change: Pick<LegacyChange, 'legacyTable' | 'op' | 'key'>) {
    super(`${change.op} of ${change.legacyTable} found no matching legacy row`);
    this.table = change.legacyTable;
    this.op = change.op;
    this.key = change.key;
  }
}

/** How one change is written: the live table, the change's ownership target, and the split-table merge source. */
export interface ApplyLegacyOptions {
  /** Live catalog of `change.physicalTable`. */
  tableCatalog: TableCatalog;
  target: LegacyTableTarget;
  split: boolean;
  /** Columns the change's unit owns; `'whole-table'` owns every column of its rows. */
  ownedColumns: readonly string[] | 'whole-table';
  /** Ownership key of the table (`UnitCatalog.keyColumnsOf`); absent or empty uses the live primary key. */
  keyColumns?: readonly string[];
  /** Other owners' values for the change's key, merged into a split-table row this change inserts. */
  fetchOtherParts?: (change: LegacyChange) => Promise<Record<string, CanonicalValue>[]>;
}

/** Legacy rows the change inserted, updated, deleted or found already current. */
export interface ApplyResult {
  rows: number;
}

type Assignment = readonly [column: CatalogColumn, value: CanonicalValue];
type Where = (bind: Bind) => string;

function columnOf(catalog: TableCatalog, name: string, role: string): CatalogColumn {
  const column = findColumn(catalog, name);
  if (column === undefined) throw new TypeError(`${role} ${name} is not a column of ${catalog.qualified}`);
  return column;
}

function tableName(catalog: TableCatalog): string {
  return `${quoteIdent(catalog.schema)}.${quoteIdent(catalog.table)}`;
}

function imageOf(change: LegacyChange, side: 'before' | 'after'): Record<string, CanonicalValue> {
  const image = change[side];
  if (image === undefined) throw new TypeError(`${change.op} of ${change.legacyTable} carries no ${side}-image`);
  return image;
}

function assignments(catalog: TableCatalog, image: Readonly<Record<string, CanonicalValue>>): Assignment[] {
  return Object.entries(image).map(([name, value]): Assignment => [columnOf(catalog, name, 'column'), value]);
}

/** Key columns by the extractor's rule: none when the live table has no primary key, else the ownership key or the primary key. */
function keyColumnsOf(catalog: TableCatalog, names: readonly string[] | undefined): CatalogColumn[] | null {
  if (!catalog.hasPrimaryKey) return null;
  return (names !== undefined && names.length > 0 ? names : catalog.primaryKey).map((name) => columnOf(catalog, name, 'key column'));
}

function keyWhere(change: LegacyChange, key: readonly CatalogColumn[], image: Readonly<Record<string, CanonicalValue>>): Where {
  return (bind) =>
    key
      .map((column) => {
        const value = valueOf(image, column.name);
        if (value === undefined) throw new TypeError(`${change.op} of ${change.legacyTable} carries no value for key column ${column.name}`);
        return keyCondition(column, value, bind);
      })
      .join(' AND ');
}

function ownedBy(opts: ApplyLegacyOptions): (column: CatalogColumn) => boolean {
  if (!opts.split || opts.ownedColumns === 'whole-table') return () => true;
  const owned = new Set(opts.ownedColumns.map((name) => name.toLowerCase()));
  return (column) => owned.has(column.name.toLowerCase());
}

function sameValue(a: CanonicalValue | undefined, b: CanonicalValue): boolean {
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return a === b;
}

function rowsOf(result: { rowsAffected: number[] }): number {
  return result.rowsAffected.reduce((sum, rows) => sum + rows, 0);
}

async function updateRow(scope: RequestScope, catalog: TableCatalog, set: readonly Assignment[], where: Where): Promise<number> {
  const request = scope.request();
  const bind = binder(request);
  const assigned = set.map(([column, value]) => `${quoteIdent(column.name)} = ${bind(column, value)}`).join(', ');
  return rowsOf(await request.query(`UPDATE ${tableName(catalog)} SET ${assigned} WHERE ${where(bind)}`));
}

async function countRows(scope: RequestScope, catalog: TableCatalog, where: Where): Promise<number> {
  const request = scope.request();
  const result = await request.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tableName(catalog)} WHERE ${where(binder(request))}`);
  return result.recordset[0]?.n ?? 0;
}

/** Inserts one row; a NULL identity value is omitted so SQL Server generates it, a non-null one is inserted explicitly. */
async function insertRow(scope: RequestScope, catalog: TableCatalog, values: readonly Assignment[]): Promise<number> {
  const identity = new Set(catalog.identityColumns);
  const written = values.filter(([column, value]) => value !== null || !identity.has(column.name));
  const request = scope.request();
  const bind = binder(request);
  const table = tableName(catalog);
  const columns = written.map(([column]) => quoteIdent(column.name)).join(', ');
  const insert = `INSERT INTO ${table} (${columns}) VALUES (${written.map(([column, value]) => bind(column, value)).join(', ')});`;
  if (!written.some(([column]) => identity.has(column.name))) return rowsOf(await request.query(insert));
  // One table per session may have IDENTITY_INSERT on, and the pooled session outlives the batch, so every path switches it off.
  return rowsOf(
    await request.query(
      `SET IDENTITY_INSERT ${table} ON;\nBEGIN TRY\n${insert}\nEND TRY\nBEGIN CATCH\nSET IDENTITY_INSERT ${table} OFF;\nTHROW;\nEND CATCH;\nSET IDENTITY_INSERT ${table} OFF;`,
    ),
  );
}

/** The row a change inserts: its own after-image, completed on a split table by every other owner's part for the key. */
async function insertImage(change: LegacyChange, opts: ApplyLegacyOptions, after: Readonly<Record<string, CanonicalValue>>): Promise<Assignment[]> {
  const merged = new Map<string, Assignment>();
  const add = (image: Readonly<Record<string, CanonicalValue>>): void => {
    for (const assignment of assignments(opts.tableCatalog, image)) {
      const name = assignment[0].name.toLowerCase();
      if (!merged.has(name)) merged.set(name, assignment);
    }
  };
  add(after);
  if (opts.split && opts.fetchOtherParts !== undefined) {
    for (const part of await opts.fetchOtherParts(change)) add(withoutProgramColumn(part));
  }
  return [...merged.values()];
}

async function upsertKeyed(scope: RequestScope, change: LegacyChange, opts: ApplyLegacyOptions, key: readonly CatalogColumn[]): Promise<ApplyResult> {
  const catalog = opts.tableCatalog;
  const after = imageOf(change, 'after');
  const keyNames = new Set(key.map((column) => column.name));
  const identity = new Set(catalog.identityColumns);
  const owned = ownedBy(opts);
  const set = assignments(catalog, after).filter(([column]) => owned(column) && !keyNames.has(column.name) && !identity.has(column.name));
  const where = keyWhere(change, key, after);
  const existing = set.length > 0 ? await updateRow(scope, catalog, set, where) : await countRows(scope, catalog, where);
  if (existing > 0) return { rows: existing };
  return { rows: await insertRow(scope, catalog, await insertImage(change, opts, after)) };
}

async function updateKeyed(scope: RequestScope, change: LegacyChange, opts: ApplyLegacyOptions, key: readonly CatalogColumn[]): Promise<ApplyResult> {
  const catalog = opts.tableCatalog;
  const after = imageOf(change, 'after');
  const locator = change.before ?? after;
  const changed = change.changedColumns === undefined ? undefined : new Set(change.changedColumns.map((name) => name.toLowerCase()));
  const keyNames = new Set(key.map((column) => column.name));
  const identity = new Set(catalog.identityColumns);
  const owned = ownedBy(opts);
  const set = assignments(catalog, after).filter(
    ([column, value]) =>
      (changed === undefined || changed.has(column.name.toLowerCase())) &&
      owned(column) &&
      !identity.has(column.name) &&
      !(keyNames.has(column.name) && sameValue(valueOf(locator, column.name), value)),
  );
  if (set.length === 0) return { rows: 0 };
  const rows = await updateRow(scope, catalog, set, keyWhere(change, key, locator));
  if (rows > 0) return { rows };
  // A split row is reassembled from every owner's part, so a missing one is inserted rather than treated as divergence.
  if (!opts.split) throw new ProjectionConflictError(change);
  return { rows: await insertRow(scope, catalog, await insertImage(change, opts, after)) };
}

async function deleteKeyed(scope: RequestScope, change: LegacyChange, opts: ApplyLegacyOptions, key: readonly CatalogColumn[]): Promise<ApplyResult> {
  const request = scope.request();
  const bind = binder(request);
  const conditions = [keyWhere(change, key, imageOf(change, 'before'))(bind)];
  const predicate = opts.split ? rowPredicateCondition(opts.tableCatalog, opts.target.rowPredicate, bind) : undefined;
  if (predicate !== undefined) conditions.push(predicate);
  // Zero rows is not divergence: the row is already absent.
  return { rows: rowsOf(await request.query(`DELETE FROM ${tableName(opts.tableCatalog)} WHERE ${conditions.join(' AND ')}`)) };
}

/** Deletes exactly one legacy row equal to the before-image in every column, preserving the multiplicity of duplicates. */
async function deleteOne(scope: RequestScope, change: LegacyChange, catalog: TableCatalog): Promise<void> {
  const request = scope.request();
  const bind = binder(request);
  const where = assignments(catalog, imageOf(change, 'before'))
    .map(([column, value]) => exactCondition(column, value, bind))
    .join(' AND ');
  const rows = rowsOf(await request.query(`DELETE TOP (1) FROM ${tableName(catalog)} WHERE ${where}`));
  // Inserting an update's after-image anyway would change the multiset.
  if (rows === 0) throw new ProjectionConflictError(change);
}

async function applyKeyless(scope: RequestScope, change: LegacyChange, catalog: TableCatalog): Promise<ApplyResult> {
  switch (change.op) {
    case 'insert':
      return { rows: await insertRow(scope, catalog, assignments(catalog, imageOf(change, 'after'))) };
    case 'delete':
      await deleteOne(scope, change, catalog);
      return { rows: 1 };
    case 'update':
      await deleteOne(scope, change, catalog);
      await insertRow(scope, catalog, assignments(catalog, imageOf(change, 'after')));
      return { rows: 1 };
  }
}

/**
 * Writes one change into its live legacy table within the caller's transaction; it never begins or commits one.
 * Keyed inserts upsert by key; keyless rows are matched exactly on their full before-image.
 * @throws ProjectionConflictError when legacy no longer holds the row the change expects.
 */
export async function applyLegacyChange(tx: RequestScope, change: LegacyChange, opts: ApplyLegacyOptions): Promise<ApplyResult> {
  const key = keyColumnsOf(opts.tableCatalog, opts.keyColumns);
  if (key === null) return applyKeyless(tx, change, opts.tableCatalog);
  switch (change.op) {
    case 'insert':
      return upsertKeyed(tx, change, opts, key);
    case 'update':
      return updateKeyed(tx, change, opts, key);
    case 'delete':
      return deleteKeyed(tx, change, opts, key);
  }
}

/** What a batch of changes touches, for the projector's post-commit site refreshes, cache purges and watermarks. */
export interface ApplySummary {
  /** Changes in the batch. */
  rows: number;
  /** Legacy table names as in `LegacyChange.legacyTable`. */
  tables: Set<string>;
  /** Site ids found in the images' `SiteID` column. */
  siteIds: Set<string>;
  touchesTcontent: boolean;
  touchesTsettings: boolean;
}

function isDboTable(ref: LegacyTableRef, table: string): boolean {
  return ref.schema.toLowerCase() === 'dbo' && ref.table.toLowerCase() === table;
}

/** Summarises the tables and sites a batch of changes touches. */
export function summarise(changes: readonly LegacyChange[]): ApplySummary {
  const summary: ApplySummary = { rows: changes.length, tables: new Set(), siteIds: new Set(), touchesTcontent: false, touchesTsettings: false };
  for (const change of changes) {
    summary.tables.add(change.legacyTable);
    summary.touchesTcontent ||= isDboTable(change.physicalTable, 'tcontent');
    summary.touchesTsettings ||= isDboTable(change.physicalTable, 'tsettings');
    for (const image of [change.before, change.after]) {
      const site = image === undefined ? undefined : valueOf(image, 'SiteID');
      // char(n) site columns arrive space-padded.
      const trimmed = typeof site === 'string' ? site.replace(/ +$/, '') : '';
      if (trimmed !== '') summary.siteIds.add(trimmed);
    }
  }
  return summary;
}

