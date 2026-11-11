import type { Pool } from 'pg';
import {
  runTransaction,
  type TxBase,
  type TenantDb,
  type TransactionCallOptions,
  type TransactionRunnerOptions,
} from './transaction.js';

/** The closed list of service-schema tables that hold tenant metadata, never tenant data, and carry no RLS. */
export const NON_TENANT_TABLES = ['tenant_registry', 'tenant_grant', 'unit_gate', 'open_operation', 'migration_watermark'] as const;

/** Name of a non-tenant table. */
export type NonTenantTable = (typeof NON_TENANT_TABLES)[number];

const nonTenantTables: ReadonlySet<string> = new Set(NON_TENANT_TABLES);

/** True when `name` is one of the non-tenant tables; every other table is tenant-owned. */
export function isNonTenantTable(name: string): name is NonTenantTable {
  return nonTenantTables.has(name);
}

/** A transaction over non-tenant tables only; its `app.tenant_id` is empty. */
export interface MetadataTx extends TxBase {
  readonly kind: 'metadata';
}

/** Runs `fn` in one transaction with an empty `app.tenant_id`, so RLS hides every tenant row and rejects tenant writes. */
export function runMetadataTransaction<T>(
  pool: Pool,
  opts: TransactionRunnerOptions,
  fn: (tx: MetadataTx) => Promise<T>,
  options?: TransactionCallOptions,
): Promise<T> {
  return runTransaction(pool, opts, '', (base): MetadataTx => ({ ...base, kind: 'metadata' }), fn, options);
}

/** Runs `fn` in a transaction that acts for no tenant; the gateway and migration use it for their coordination tables. */
export function withMetadata<T>(db: TenantDb, fn: (tx: MetadataTx) => Promise<T>, options?: TransactionCallOptions): Promise<T> {
  return options === undefined ? db.withMetadata(fn) : db.withMetadata(fn, options);
}
