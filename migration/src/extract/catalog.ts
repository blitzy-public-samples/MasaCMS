/** SQL Server catalog reader: legacy table lists and column, primary-key and identity metadata, memoised per database. */
import sql from 'mssql';
import type { ConnectionPool } from 'mssql';

import { CanonicalEncodingError, canonicalTypeForSqlServer } from '@opt2/platform/migration-kit';
import type { CanonicalColumn, CanonicalTypeInfo } from '@opt2/platform/migration-kit';

/** Schema of the projector checkpoint in the legacy database; never a legacy table. */
export const OPT2_SYNC_SCHEMA = 'opt2_sync';

/** Fixture per-program schema (`Program_1`, `Program_2`, …); group 1 is the program id. */
export const PROGRAM_SCHEMA_PATTERN = /^Program_(\d+)$/i;

const DEFAULT_SCHEMA = 'dbo';
const SYNTHETIC_SCHEMA = 'synthetic';
const READ_ONLY = 'READ_ONLY';

/** One physical legacy table; `qualified` is the migration-wide name (bare for `dbo`, `<schema>.<table>` otherwise). */
export interface LegacyTableRef {
  readonly schema: string;
  readonly table: string;
  readonly qualified: string;
}

/**
 * One column, in catalog order. `scale` is the canonical scale, present only for `d` columns (NUMERIC_SCALE, or 4 for
 * money); `maxLength` is CHARACTER_MAXIMUM_LENGTH, -1 for `max`.
 */
export interface CatalogColumn extends CanonicalColumn {
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly maxLength: number | null;
  readonly precision: number | null;
  // Raw NUMERIC_SCALE lives here, not in `scale`: `scale` is CanonicalColumn's encoding scale, which encodeRow reads.
  readonly numericScale: number | null;
  readonly ordinal: number;
}

/** Frozen metadata of one table; `primaryKey` follows key order and every name equals a `columns[].name`. */
export interface TableCatalog {
  readonly database: string;
  readonly schema: string;
  readonly table: string;
  readonly qualified: string;
  readonly columns: readonly CatalogColumn[];
  readonly primaryKey: readonly string[];
  readonly identityColumns: readonly string[];
  readonly hasPrimaryKey: boolean;
}

/** The pool surface the reader uses; `config.database` names the pool's database when set. */
export type CatalogPool = Pick<ConnectionPool, 'request'> & { config?: { database?: string | undefined } };

/** A catalog read failed for `table` of `database`. */
export class CatalogError extends Error {
  readonly database: string;
  readonly table: string;

  constructor(message: string, details: { database: string; table: string; cause?: unknown }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'CatalogError';
    this.database = details.database;
    this.table = details.table;
  }
}

/** The table has no INFORMATION_SCHEMA.COLUMNS rows in the database. */
export class TableNotFoundError extends CatalogError {
  constructor(database: string, table: string) {
    super(`table ${table} not found in database ${database}`, { database, table });
    this.name = 'TableNotFoundError';
  }
}

/** A column's SQL Server type has no canonical form; `cause` is the migration-kit error. */
export class UnsupportedColumnTypeError extends CatalogError {
  readonly column: string;
  readonly sqlType: string;

  constructor(details: { database: string; table: string; column: string; sqlType: string; cause: unknown }) {
    super(`column ${details.table}.${details.column} of database ${details.database} has unsupported type '${details.sqlType}'`, details);
    this.name = 'UnsupportedColumnTypeError';
    this.column = details.column;
    this.sqlType = details.sqlType;
  }
}

/** Migration-wide table name: bare for `dbo`, `<schema>.<table>` otherwise. */
export function qualifiedName(schema: string, table: string): string {
  return schema.toLowerCase() === DEFAULT_SCHEMA ? table : `${schema}.${table}`;
}

function unbracket(part: string): string {
  return part.length >= 2 && part.startsWith('[') && part.endsWith(']') ? part.slice(1, -1) : part;
}

/** Splits `tcontent`, `dbo.tcontent` or `[Program_1].[timesheet]` at the first `.`; a bare name is in `dbo`. */
export function parseQualifiedName(name: string): { schema: string; table: string } {
  const dot = name.indexOf('.');
  if (dot < 0) return { schema: DEFAULT_SCHEMA, table: unbracket(name) };
  return { schema: unbracket(name.slice(0, dot)), table: unbracket(name.slice(dot + 1)) };
}

/** True for the schemas holding legacy data: `dbo`, `synthetic` and `Program_<n>`. */
export function isLegacySchema(schema: string): boolean {
  const lower = schema.toLowerCase();
  return lower === DEFAULT_SCHEMA || lower === SYNTHETIC_SCHEMA || PROGRAM_SCHEMA_PATTERN.test(schema);
}

/** Column by name: exact spelling first, then case-insensitively, as SQL Server resolves identifiers. */
export function findColumn(
  source: Pick<TableCatalog, 'columns'> | readonly CatalogColumn[],
  name: string,
): CatalogColumn | undefined {
  const columns = 'columns' in source ? source.columns : source;
  const exact = columns.find((column) => column.name === name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  return columns.find((column) => column.name.toLowerCase() === lower);
}

interface ColumnRecord {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  NUMERIC_PRECISION: number | null;
  NUMERIC_SCALE: number | null;
  ORDINAL_POSITION: number;
}

interface NameRecord {
  name: string;
}

const TABLE_CATALOG_SQL = `
DECLARE @object_id int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@table));
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, ORDINAL_POSITION
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
  ORDER BY ORDINAL_POSITION;
SELECT c.name
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = @object_id AND i.is_primary_key = 1 AND ic.key_ordinal > 0
  ORDER BY ic.key_ordinal;
SELECT name FROM sys.identity_columns WHERE object_id = @object_id ORDER BY column_id;`;

const LEGACY_TABLES_SQL = `SELECT s.name AS schema_name, t.name AS table_name
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE t.is_ms_shipped = 0`;

const DATABASE_NAME_SQL = 'SELECT DB_NAME() AS name';

const UPDATEABILITY_SQL = "SELECT CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Updateability')) AS updateability";

const FINGERPRINT_SQL = `SELECT (SELECT COUNT_BIG(*) FROM sys.tables) AS table_count,
  (SELECT COUNT_BIG(*) FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id) AS column_count,
  (SELECT MAX(modify_date) FROM sys.tables) AS last_modified`;

interface PromiseStore<K, V> {
  get(key: K): Promise<V> | undefined;
  set(key: K, value: Promise<V>): unknown;
  delete(key: K): boolean;
}

const databaseNames = new WeakMap<object, Promise<string>>();
const updateabilities = new Map<string, Promise<string>>();
const fingerprints = new Map<string, string>();
const tableLists = new Map<string, Promise<readonly LegacyTableRef[]>>();
const tableCatalogs = new Map<string, Map<string, Promise<TableCatalog>>>();

/** Returns the stored promise for `key`, or stores `start()`'s; a rejected promise is removed so the next call reads afresh. */
function remember<K, V>(store: PromiseStore<K, V>, key: K, start: () => Promise<V>): Promise<V> {
  const cached = store.get(key);
  if (cached !== undefined) return cached;
  const pending: Promise<V> = start().catch((error: unknown) => {
    if (store.get(key) === pending) store.delete(key);
    throw error;
  });
  store.set(key, pending);
  return pending;
}

async function queryDatabaseName(pool: CatalogPool): Promise<string> {
  const result = await pool.request().query<{ name: string | null }>(DATABASE_NAME_SQL);
  const name = result.recordset[0]?.name;
  if (!name) throw new Error('DB_NAME() returned no database for the pool');
  return name;
}

function databaseName(pool: CatalogPool): Promise<string> {
  const configured = pool.config?.database;
  if (configured !== undefined && configured !== '') return Promise.resolve(configured);
  return remember(databaseNames, pool, () => queryDatabaseName(pool));
}

async function queryUpdateability(pool: CatalogPool): Promise<string> {
  const result = await pool.request().query<{ updateability: string | null }>(UPDATEABILITY_SQL);
  return result.recordset[0]?.updateability ?? '';
}

function fingerprintPart(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function queryFingerprint(pool: CatalogPool): Promise<string> {
  const result = await pool.request().query<{ table_count: unknown; column_count: unknown; last_modified: unknown }>(FINGERPRINT_SQL);
  const row = result.recordset[0];
  return [row?.table_count, row?.column_count, row?.last_modified].map(fingerprintPart).join('|');
}

/**
 * Resolves the pool's database and drops its memoised entries when its schema may have changed: READ_ONLY databases
 * (restored snapshots) are trusted for the process lifetime, any other is fingerprinted before an entry is served.
 */
async function currentDatabase(pool: CatalogPool): Promise<{ database: string; key: string }> {
  const database = await databaseName(pool);
  const key = database.toLowerCase();
  const updateability = await remember(updateabilities, key, () => queryUpdateability(pool));
  if (updateability.toUpperCase() !== READ_ONLY) {
    const fingerprint = await queryFingerprint(pool);
    if (fingerprints.get(key) !== fingerprint) {
      tableLists.delete(key);
      tableCatalogs.delete(key);
      fingerprints.set(key, fingerprint);
    }
  }
  return { database, key };
}

function toRef(table: string | LegacyTableRef): LegacyTableRef {
  const { schema, table: name } = typeof table === 'string' ? parseQualifiedName(table) : table;
  return { schema, table: name, qualified: qualifiedName(schema, name) };
}

function catalogColumn(database: string, table: string, row: ColumnRecord): CatalogColumn {
  const sqlType = row.DATA_TYPE.toLowerCase();
  const numericScale = row.NUMERIC_SCALE ?? null;
  let canonical: CanonicalTypeInfo;
  try {
    canonical = canonicalTypeForSqlServer(sqlType, { scale: numericScale ?? undefined });
  } catch (error) {
    if (!(error instanceof CanonicalEncodingError)) throw error;
    throw new UnsupportedColumnTypeError({ database, table, column: row.COLUMN_NAME, sqlType, cause: error });
  }
  return Object.freeze({
    name: row.COLUMN_NAME,
    type: canonical.type,
    ...(canonical.scale === undefined ? {} : { scale: canonical.scale }),
    sqlType,
    nullable: row.IS_NULLABLE.toUpperCase() === 'YES',
    maxLength: row.CHARACTER_MAXIMUM_LENGTH ?? null,
    precision: row.NUMERIC_PRECISION ?? null,
    numericScale,
    ordinal: row.ORDINAL_POSITION,
  });
}

async function queryTableCatalog(pool: CatalogPool, database: string, ref: LegacyTableRef): Promise<TableCatalog> {
  const request = pool.request();
  request.input('schema', sql.NVarChar(128), ref.schema);
  request.input('table', sql.NVarChar(128), ref.table);
  const result = await request.query<[ColumnRecord, NameRecord, NameRecord]>(TABLE_CATALOG_SQL);
  const sets: readonly (readonly unknown[] | undefined)[] = result.recordsets;
  const columnRows = (sets[0] ?? []) as readonly ColumnRecord[];
  if (columnRows.length === 0) throw new TableNotFoundError(database, ref.qualified);

  const columns = Object.freeze(columnRows.map((row) => catalogColumn(database, ref.qualified, row)));
  const columnNames = (index: number): readonly string[] =>
    Object.freeze(
      ((sets[index] ?? []) as readonly NameRecord[]).map((row) => {
        const column = findColumn(columns, row.name);
        if (column === undefined) {
          throw new CatalogError(`key or identity column ${row.name} is not a column of ${ref.qualified}`, { database, table: ref.qualified });
        }
        return column.name;
      }),
    );
  const primaryKey = columnNames(1);
  return Object.freeze({
    database,
    schema: ref.schema,
    table: ref.table,
    qualified: ref.qualified,
    columns,
    primaryKey,
    identityColumns: columnNames(2),
    hasPrimaryKey: primaryKey.length > 0,
  });
}

async function queryLegacyTables(pool: CatalogPool): Promise<readonly LegacyTableRef[]> {
  const result = await pool.request().query<{ schema_name: string; table_name: string }>(LEGACY_TABLES_SQL);
  const refs = result.recordset
    .filter((row) => isLegacySchema(row.schema_name))
    .map((row) => Object.freeze({ schema: row.schema_name, table: row.table_name, qualified: qualifiedName(row.schema_name, row.table_name) }));
  refs.sort((a, b) => (a.qualified < b.qualified ? -1 : a.qualified > b.qualified ? 1 : 0));
  return Object.freeze(refs);
}

/** Column, primary-key and identity metadata of one table of the pool's database; `table` is a name or a ref. */
export async function readTableCatalog(pool: CatalogPool, table: string | LegacyTableRef): Promise<TableCatalog> {
  const ref = toRef(table);
  const { database, key } = await currentDatabase(pool);
  let catalogs = tableCatalogs.get(key);
  if (catalogs === undefined) {
    catalogs = new Map();
    tableCatalogs.set(key, catalogs);
  }
  return remember(catalogs, ref.qualified.toLowerCase(), () => queryTableCatalog(pool, database, ref));
}

/** User tables of the `dbo`, `synthetic` and `Program_<n>` schemas, sorted by `qualified` in code-unit order. */
export async function listLegacyTables(pool: CatalogPool): Promise<readonly LegacyTableRef[]> {
  const { key } = await currentDatabase(pool);
  return remember(tableLists, key, () => queryLegacyTables(pool));
}

/** Forgets memoised metadata of `database` (case-insensitive), or of every database; call after dropping or restoring one. */
export function clearCatalogCache(database?: string): void {
  if (database === undefined) {
    updateabilities.clear();
    fingerprints.clear();
    tableLists.clear();
    tableCatalogs.clear();
    return;
  }
  const key = database.toLowerCase();
  updateabilities.delete(key);
  fingerprints.delete(key);
  tableLists.delete(key);
  tableCatalogs.delete(key);
}
