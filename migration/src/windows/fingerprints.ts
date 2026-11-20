// Row fingerprints: one hash per legacy row of a window's tables, read before and after legacy executes, so the window
// import compares only the tables and keys legacy changed.
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import type { ConnectionPool } from 'mssql';

import type { MigrationContext } from '../context.js';
import {
  MAX_SCOPE_PARAMETERS,
  bindScope,
  buildScopeFilter,
  describeLegacyTable,
  parseQualifiedName,
  readTableCatalog,
  type CatalogColumn,
  type ExtractScope,
  type ScopeFilter,
  type ScopeValue,
  type TableCatalog,
} from '../extract/index.js';
import { quoteIdent } from '../legacy/index.js';
import type { UnitCatalog } from '../owners/index.js';
import { cancellableQuery } from '../reverse/apply-legacy.js';
import { FILE_OBJECT_UNIT } from '../reverse/files.js';

/** Ports a fingerprint read goes through. */
export type FingerprintContext = Pick<MigrationContext, 'legacy' | 'catalog'>;

/** One keyed row's hash, with its primary-key values as the driver returned them. */
export interface KeyedRowHash {
  readonly key: readonly unknown[];
  readonly hash: string;
}

/** Row hashes of one legacy table within a scope: by primary key, or as a multiset of hashes for a keyless table. */
export type TableFingerprint =
  | { readonly table: string; readonly keyed: true; readonly keyColumns: readonly string[]; readonly rows: ReadonlyMap<string, KeyedRowHash> }
  | { readonly table: string; readonly keyed: false; readonly hashes: ReadonlyMap<string, number> };

/** Fingerprints of a window's legacy tables under `scope`, by {@link fingerprintKey}; a table left out was not fingerprinted. */
export interface WindowFingerprints {
  readonly scope: ExtractScope;
  readonly tables: ReadonlyMap<string, TableFingerprint>;
  readonly elapsedMs: number;
}

/** Reads the fingerprints of `tables` under `scope`; `signal` cancels the reads. */
export type FingerprintReader = (ctx: FingerprintContext, tables: readonly string[], scope: ExtractScope, signal?: AbortSignal) => Promise<WindowFingerprints>;

/** What legacy did to one table's rows between two fingerprints: nothing, rows found by the values of one key column, or unknown. */
export type TableChange =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'keys'; readonly column: string; readonly values: readonly ScopeValue[] }
  | { readonly kind: 'whole' };

/** Rows one table's fingerprint holds at most; a larger table is not fingerprinted. */
export const MAX_FINGERPRINT_ROWS = 250_000;

/** SELECTs a fingerprint read runs at once, and the key partitions a large table is read in; SQL Server Express uses at most four cores. */
export const FINGERPRINT_CONCURRENCY = 4;

/** Rows times columns, by SQL Server's counts, from which a keyed table is read in {@link FINGERPRINT_CONCURRENCY} key partitions at once. */
export const PARTITION_CELLS = 100_000;

/** Most bytes a non-max varbinary concatenation holds without truncating it. */
const CHUNK_BYTES = 8000;
/** Bytes of the length prefix each hashed value carries. */
const LENGTH_BYTES = 4;
/** Largest varbinary form of a fixed-size type: decimal(38) takes 20 bytes. */
const FIXED_BYTES = 20;

const FIXED_TYPES: ReadonlySet<string> = new Set([
  'int',
  'smallint',
  'tinyint',
  'bigint',
  'bit',
  'float',
  'real',
  'decimal',
  'numeric',
  'money',
  'smallmoney',
  'datetime',
  'smalldatetime',
  'datetime2',
  'date',
  'uniqueidentifier',
]);
/** Bytes per declared length unit of each sized type. */
const SIZED_TYPES: ReadonlyMap<string, number> = new Map([
  ['char', 1],
  ['varchar', 1],
  ['binary', 1],
  ['varbinary', 1],
  ['nchar', 2],
  ['nvarchar', 2],
]);
/** Large-object types with the max type each is read as before its bytes are hashed; image casts to varbinary(max) itself. */
const LOB_TYPES: ReadonlyMap<string, string | undefined> = new Map([
  ['text', 'varchar(max)'],
  ['ntext', 'nvarchar(max)'],
  ['xml', 'nvarchar(max)'],
  ['image', undefined],
]);

const UNCHANGED: TableChange = Object.freeze({ kind: 'unchanged' });
const WHOLE: TableChange = Object.freeze({ kind: 'whole' });

/** Lookup form of a legacy table name: no `dbo.`, lower case. */
export function fingerprintKey(table: string): string {
  return table.replace(/^dbo\./i, '').toLowerCase();
}

/** Legacy tables the window import reads for `units`, each once in unit order; the file-object unit reads none. */
export function fingerprintTables(catalog: Pick<UnitCatalog, 'legacyTablesOf'>, units: readonly string[]): string[] {
  const tables = new Map<string, string>();
  for (const unit of [...new Set(units)].sort()) {
    if (unit === FILE_OBJECT_UNIT) continue;
    for (const table of catalog.legacyTablesOf(unit)) if (!tables.has(fingerprintKey(table))) tables.set(fingerprintKey(table), table);
  }
  return [...tables.values()];
}

/** Whether two scopes bind the same names to the same values. */
export function sameScope(a: ExtractScope, b: ExtractScope): boolean {
  const text = (scope: ExtractScope): string =>
    scope === 'table' ? 'table' : JSON.stringify(Object.entries(scope).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return text(a) === text(b);
}

function isHashable(column: CatalogColumn): boolean {
  return FIXED_TYPES.has(column.sqlType) || SIZED_TYPES.has(column.sqlType) || LOB_TYPES.has(column.sqlType);
}

/** Bytes a column's varbinary form takes at most; undefined for max and large-object columns. */
function worstBytes(column: CatalogColumn): number | undefined {
  if (FIXED_TYPES.has(column.sqlType)) return FIXED_BYTES;
  const unit = SIZED_TYPES.get(column.sqlType);
  if (unit === undefined || column.maxLength === null || column.maxLength < 0) return undefined;
  return column.maxLength * unit;
}

/** `expr`'s bytes behind their 4-byte length, cast to `binary`; NULL hashes as 0xFFFFFFFF, apart from every empty value. */
function hashTerm(expr: string, binary: 'varbinary(8000)' | 'varbinary(max)'): string {
  return `ISNULL(CAST(DATALENGTH(${expr}) AS binary(4)) + CAST(${expr} AS ${binary}), 0xFFFFFFFF)`;
}

/** SELECT of each row's key as `k0`, `k1`, … and its 16-byte row hash as `h` within `whereSql`, one row past `maxRows` at most; undefined for a type the hash does not read. */
export function fingerprintSql(
  catalog: Pick<TableCatalog, 'schema' | 'table' | 'columns' | 'primaryKey'>,
  whereSql: string,
  maxRows = MAX_FINGERPRINT_ROWS,
): string | undefined {
  if (catalog.columns.length === 0 || !catalog.columns.every(isHashable)) return undefined;
  // Columns that fit are grouped in chunks of at most 8,000 bytes, so no non-max concatenation truncates; the others join whole.
  const chunks: { terms: string[]; bytes: number }[] = [];
  const large: string[] = [];
  for (const column of catalog.columns) {
    const name = quoteIdent(column.name);
    const bytes = worstBytes(column);
    if (bytes === undefined || bytes + LENGTH_BYTES > CHUNK_BYTES) {
      const through = LOB_TYPES.get(column.sqlType);
      large.push(hashTerm(through === undefined ? name : `CAST(${name} AS ${through})`, 'varbinary(max)'));
      continue;
    }
    const term = hashTerm(name, 'varbinary(8000)');
    const last = chunks.at(-1);
    if (last !== undefined && last.bytes + bytes + LENGTH_BYTES <= CHUNK_BYTES) {
      last.terms.push(term);
      last.bytes += bytes + LENGTH_BYTES;
    } else chunks.push({ terms: [term], bytes: bytes + LENGTH_BYTES });
  }
  // One HASHBYTES per row; the first part cast to varbinary(max) makes the whole concatenation max-typed, so nothing truncates it.
  const parts = [...chunks.map((chunk) => `(${chunk.terms.join(' + ')})`), ...large];
  const row = `HASHBYTES('SHA2_256', ${parts.map((part, index) => (index === 0 ? `CAST(${part} AS varbinary(max))` : part)).join(' + ')})`;
  const select = [...catalog.primaryKey.map((name, index) => `${quoteIdent(name)} AS [k${String(index)}]`), `CAST(${row} AS binary(16)) AS [h]`];
  return `SELECT TOP (${String(maxRows + 1)}) ${select.join(', ')} FROM ${quoteIdent(catalog.schema)}.${quoteIdent(catalog.table)}${whereSql}`;
}

/** `whereSql` narrowed to key partition `index` of `count`; CHECKSUM only spreads rows over the partitions, each row into exactly one. */
export function partitionWhere(whereSql: string, keyColumns: readonly string[], index: number, count: number): string {
  const partition = `ABS(CAST(CHECKSUM(${keyColumns.map(quoteIdent).join(', ')}) AS bigint)) % ${String(count)} = ${String(index)}`;
  return whereSql === '' ? ` WHERE ${partition}` : ` WHERE (${whereSql.replace(/^ WHERE /, '')}) AND ${partition}`;
}

/** Identity text of a primary key's driver values, apart for every distinct value and type. */
function keyText(key: readonly unknown[]): string {
  return JSON.stringify(
    key.map((value) => {
      if (Buffer.isBuffer(value)) return { b: value.toString('hex') };
      if (value instanceof Date) return { t: value.getTime() };
      if (typeof value === 'bigint') return { i: value.toString() };
      return value;
    }),
  );
}

function hashText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('hex') : String(value);
}

/** One table's read under a scope: its filter and SELECTs, one per key partition, and each partition's rows once read. */
interface TableRead {
  readonly table: string;
  readonly catalog: TableCatalog;
  readonly filter: ScopeFilter;
  readonly texts: readonly string[];
  readonly parts: Record<string, unknown>[][];
}

/** One SELECT to run: partition `index` of `count` of a table, with its estimated cost. */
interface PartItem {
  readonly key: string;
  readonly table: string;
  readonly index: number;
  readonly count: number;
  readonly cost: number;
}

/** Row and column counts of `@t<i>`, `v.i` naming the table, its rows from its heap or clustered index; NULL counts for no such table. */
function tableSizesSql(count: number): string {
  const values = Array.from({ length: count }, (_, index) => `(${String(index)}, @t${String(index)})`).join(', ');
  return `SELECT v.i AS [i], (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = OBJECT_ID(v.name) AND p.index_id IN (0, 1)) AS [rows],
  (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = OBJECT_ID(v.name)) AS [columns] FROM (VALUES ${values}) AS v(i, name)`;
}

/**
 * The SELECTs of `tables`, `[key, table]` each, costed by rows times columns: {@link FINGERPRINT_CONCURRENCY} key partitions
 * from {@link PARTITION_CELLS} up to the row cap, else one; `signal` cancels the size read.
 */
async function partItems(pool: ConnectionPool, tables: readonly [string, string][], signal: AbortSignal): Promise<PartItem[]> {
  const request = pool.request();
  for (const [index, [, table]] of tables.entries()) {
    const { schema, table: name } = parseQualifiedName(table);
    request.input(`t${String(index)}`, `${quoteIdent(schema)}.${quoteIdent(name)}`);
  }
  const { recordset } = await cancellableQuery<{ i: number; rows: unknown; columns: unknown }>(request, tableSizesSql(tables.length), signal);
  const sizes = new Map(recordset.map((row) => [row.i, row]));
  return tables.flatMap(([key, table], index) => {
    const rows = Number(sizes.get(index)?.rows ?? 0);
    const cells = rows * Number(sizes.get(index)?.columns ?? 0);
    const count = cells >= PARTITION_CELLS && rows <= MAX_FINGERPRINT_ROWS ? FINGERPRINT_CONCURRENCY : 1;
    return Array.from({ length: count }, (_, part) => ({ key, table, index: part, count, cost: cells / count }));
  });
}

/** Runs `run` over `items`, {@link FINGERPRINT_CONCURRENCY} at a time, starting none once one failed and aborting `failed` with it. @throws the first failure once the runs in flight ended */
async function inPool<T>(items: readonly T[], run: (item: T) => Promise<void>, failed: AbortController): Promise<void> {
  const pending = [...items];
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    for (let next = pending.shift(); next !== undefined && failures.length === 0; next = pending.shift()) {
      try {
        await run(next);
      } catch (error) {
        failures.push(error);
        failed.abort(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FINGERPRINT_CONCURRENCY, pending.length) }, worker));
  if (failures.length > 0) throw failures[0];
}

/** One table's read under `scope` in `count` key partitions, or one for a keyless table; undefined for a folded table or a column type the hash does not read. */
async function planTable(ctx: FingerprintContext, pool: ConnectionPool, table: string, scope: ExtractScope, count: number, signal: AbortSignal): Promise<TableRead | undefined> {
  const shape = await describeLegacyTable({ legacy: ctx.legacy, catalog: ctx.catalog }, { table });
  signal.throwIfAborted();
  if (shape.folded) return undefined;
  const catalog = await readTableCatalog(pool, table);
  signal.throwIfAborted();
  const filter = buildScopeFilter(catalog.columns, scope);
  const parts = catalog.hasPrimaryKey ? count : 1;
  const texts: string[] = [];
  for (let index = 0; index < parts; index += 1) {
    const text = fingerprintSql(catalog, parts === 1 ? filter.whereSql : partitionWhere(filter.whereSql, catalog.primaryKey, index, parts));
    if (text === undefined) return undefined;
    texts.push(text);
  }
  return { table, catalog, filter, texts, parts: [] };
}

/** The table's fingerprint merged from its partitions' rows; undefined past the row cap. */
function fingerprintOf({ table, catalog, parts }: TableRead): TableFingerprint | undefined {
  if (parts.reduce((sum, records) => sum + records.length, 0) > MAX_FINGERPRINT_ROWS) return undefined;
  if (!catalog.hasPrimaryKey) {
    const hashes = new Map<string, number>();
    for (const records of parts) {
      for (const record of records) {
        const hash = hashText(record.h);
        hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
      }
    }
    return { table, keyed: false, hashes };
  }
  const rows = new Map<string, KeyedRowHash>();
  for (const records of parts) {
    for (const record of records) {
      const key = catalog.primaryKey.map((_, index) => record[`k${String(index)}`]);
      rows.set(keyText(key), { key, hash: hashText(record.h) });
    }
  }
  return { table, keyed: true, keyColumns: catalog.primaryKey, rows };
}

/**
 * Reads `tables`' fingerprints from the live legacy database, {@link FINGERPRINT_CONCURRENCY} SELECTs at a time, costliest
 * first, each table's catalog read once by its first SELECT. @throws the first read's failure once the reads in flight ended
 */
export const readFingerprints: FingerprintReader = async (ctx, tables, scope, signal) => {
  const started = performance.now();
  const failed = new AbortController();
  const bound = signal === undefined ? failed.signal : AbortSignal.any([signal, failed.signal]);
  const unique = new Map<string, string>();
  for (const table of tables) if (!unique.has(fingerprintKey(table))) unique.set(fingerprintKey(table), table);
  const found = new Map<string, TableFingerprint>();
  if (unique.size === 0) return { scope, tables: found, elapsedMs: Math.round(performance.now() - started) };
  bound.throwIfAborted();
  const pool = await ctx.legacy.live();
  const items = await partItems(pool, [...unique], bound);
  items.sort((a, b) => b.cost - a.cost);
  const reads = new Map<string, Promise<TableRead | undefined>>();
  await inPool(
    items,
    async ({ key, table, index, count }) => {
      bound.throwIfAborted();
      let planned = reads.get(key);
      if (planned === undefined) {
        planned = planTable(ctx, pool, table, scope, count, bound);
        reads.set(key, planned);
      }
      const read = await planned;
      const text = read?.texts[index];
      if (read === undefined || text === undefined) return;
      const request = pool.request();
      bindScope(request, read.filter);
      read.parts[index] = (await cancellableQuery<Record<string, unknown>>(request, text, bound)).recordset;
    },
    failed,
  );
  for (const key of unique.keys()) {
    const read = await reads.get(key);
    const fingerprint = read === undefined ? undefined : fingerprintOf(read);
    if (fingerprint !== undefined) found.set(key, fingerprint);
  }
  return { scope, tables: found, elapsedMs: Math.round(performance.now() - started) };
};

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([hash, count]) => b.get(hash) === count);
}

/** A key value a scope filter and an export match can bind: text or a safe integer, a bit as 0 or 1; undefined otherwise. */
function scopeValueOf(value: unknown): ScopeValue | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return undefined;
}

/** What legacy did to one table between `before` and `after`: its added, removed and rehashed keys, by the key column with the fewest values among them. */
export function diffFingerprints(before: TableFingerprint | undefined, after: TableFingerprint | undefined): TableChange {
  if (before === undefined || after === undefined) return WHOLE;
  if (!before.keyed || !after.keyed) return !before.keyed && !after.keyed && sameCounts(before.hashes, after.hashes) ? UNCHANGED : WHOLE;
  if (before.keyColumns.length !== after.keyColumns.length || before.keyColumns.some((name, index) => after.keyColumns[index] !== name)) return WHOLE;
  const changed: (readonly unknown[])[] = [];
  for (const [text, row] of before.rows) if (after.rows.get(text)?.hash !== row.hash) changed.push(row.key);
  for (const [text, row] of after.rows) if (!before.rows.has(text)) changed.push(row.key);
  if (changed.length === 0) return UNCHANGED;
  // The first column in key order wins a tie; too many values, or one no filter binds, leave the table to a whole compare.
  let best: { column: string; values: Set<unknown> } | undefined;
  for (const [index, column] of before.keyColumns.entries()) {
    const values = new Set(changed.map((key) => key[index]));
    if (best === undefined || values.size < best.values.size) best = { column, values };
  }
  if (best === undefined || best.values.size > MAX_SCOPE_PARAMETERS) return WHOLE;
  const values = [...best.values].map(scopeValueOf);
  if (values.some((value) => value === undefined)) return WHOLE;
  return { kind: 'keys', column: best.column, values: values as ScopeValue[] };
}
