/** Legacy extraction: SQL Server catalog metadata, scope filters, canonical row streams and the Program_<id> fold. */
export {
  readTableCatalog,
  listLegacyTables,
  clearCatalogCache,
  qualifiedName,
  parseQualifiedName,
  isLegacySchema,
  findColumn,
  OPT2_SYNC_SCHEMA,
  PROGRAM_SCHEMA_PATTERN,
  CatalogError,
  TableNotFoundError,
  UnsupportedColumnTypeError,
} from './catalog.js';
export type { LegacyTableRef, CatalogColumn, TableCatalog, CatalogPool } from './catalog.js';

export { buildScopeFilter, bindScope, rowInScope, MAX_SCOPE_PARAMETERS } from './scope.js';
export type { ScopeValue, ExtractScope, ScopeTerm, ScopeParam, ScopeFilter } from './scope.js';

export {
  streamCanonicalRows,
  describeStream,
  compareCanonicalRows,
  compareKeyValues,
  DEFAULT_SORT_RUN_BYTES,
  DEFAULT_HIGH_WATER_MARK,
  ExtractError,
  ExtractOrderError,
} from './stream.js';
export type { CanonicalRow, KeyValue, StreamOptions, StreamShape } from './stream.js';

export { migratableTables, partitionLegacyTables, DYNAMIC_TABLE_PATTERN } from './tables.js';
export type { MigratableTable, SkippedTable, TablePartition } from './tables.js';

export { streamFoldedRows, streamLegacyTable, describeLegacyTable, FoldShapeError } from './fold.js';
export type {
  FoldPart,
  FoldedStreamOptions,
  LegacyTableShape,
  LegacyTableDeps,
  LegacyTableOptions,
} from './fold.js';
