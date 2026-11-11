/** Public surface of `@opt2/platform/tenancy`: tenant ids, RLS DDL, tenant and metadata transactions, pools, registry and grants. */
export { TENANT_NAMESPACE, SYSTEM_TENANT_ID, tenantIdForSite, isTenantId, assertTenantId, InvalidTenantIdError } from './tenant-id.js';
export { TENANT_SETTING, RLS_POLICY_NAME, rlsSql, tenantRegistrySql, tenantGrantSql } from './rls.js';
export {
  withTenant,
  currentTransaction,
  currentTenantTx,
  requireTenantTx,
  OutsideTenantTransactionError,
  TransactionEndedError,
  TransactionRolledBackError,
} from './transaction.js';
export type { TenantDb, TenantTx, TxBase, Queryable, CommitCallback, CommitErrorHandler, TransactionCallOptions } from './transaction.js';
export { withMetadata, NON_TENANT_TABLES, isNonTenantTable } from './metadata.js';
export type { MetadataTx, NonTenantTable } from './metadata.js';
export { createPool, tenantDbFromPool, iamDbUser } from './pool.js';
// TenantDbOptions is tenantDbFromPool's parameter type; outside platform it is reachable only through this subpath.
export type { DbEnv, CreatePoolOptions, TenantDbOptions } from './pool.js';
export {
  registeredTenants,
  registryEntryForTenant,
  tenantForRegisteredSite,
  siteForTenant,
  poolTenantFor,
  contentPoolTenants,
  userPoolFanoutTenants,
  tenantRegistryConsumer,
  SITE_CHANGED_TOPIC,
  TenantMismatchError,
} from './registry.js';
export type { PoolKind, TenantRegistryEntry, RegistrySource, SiteChangedPayload, SiteChangedEvent } from './registry.js';
export { writeGrant, hasGrant } from './grants.js';
export type { GrantInput, GrantKey, GrantSource } from './grants.js';
export type { Pool, PoolClient, QueryResult, QueryResultRow, QueryConfig } from 'pg';
