/** Dependency order of the legacy tables for backfill and projection. */
export {
  computeDependencyOrder,
  buildDependencyOrder,
  loadOrderInventory,
  parentOf,
  toMigrationOrderReport,
  writeMigrationOrderReport,
  compareTableNames,
  MIGRATION_ORDER_REPORT,
  EXPECTED_HEAD,
  SITE_ROOT_TABLE,
  PROGRAM_SITE_TABLE,
  DependencyOrderError,
} from './dependency-order.js';
export type {
  OrderRelationKind,
  TableRef,
  OrderRelation,
  OrderInventory,
  OrderCatalog,
  TenantFrom,
  OrderEntry,
  DeferredColumn,
  DependencyOrder,
  BuildDependencyOrderOptions,
  ComputeDependencyOrderOptions,
  MigrationOrderReport,
} from './dependency-order.js';
