import { assertTenantId } from './tenant-id.js';
import type { TenantDb, TenantTx } from './transaction.js';
import type { MetadataTx } from './metadata.js';

/** A grant the writing tenant gives `grantee` over one resource; the grantor is always the transaction's tenant. */
export interface GrantInput {
  grantee: string;
  kind: string;
  resourceId: string;
}

/** Identifies one stored grant. */
export interface GrantKey {
  grantor: string;
  grantee: string;
  kind: string;
  resourceId: string;
}

/** Where grants are read: a TenantDb, read in its own metadata transaction, or an already open transaction. */
export type GrantSource = TenantDb | TenantTx | MetadataTx;

/** Records a grant from `tx.tenantId` to `input.grantee` inside the grantor's transaction; a repeated grant is a no-op. */
export async function writeGrant(tx: TenantTx, input: GrantInput): Promise<void> {
  // Widened so a metadata transaction reaching here through a cast or untyped caller is still refused.
  if ((tx as TenantTx | MetadataTx).kind !== 'tenant') {
    throw new TypeError('A tenant grant must be written in its grantor tenant transaction');
  }
  const grantee = assertTenantId(input.grantee);
  await tx.query(
    `INSERT INTO ${tx.schema}.tenant_grant (grantor_tenant, grantee_tenant, kind, resource_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tx.tenantId, grantee, input.kind, input.resourceId],
  );
}

/** True when `key.grantor` has granted `key.grantee` the `kind` grant on `key.resourceId`. */
export async function hasGrant(source: GrantSource, key: GrantKey): Promise<boolean> {
  const values = [assertTenantId(key.grantor), assertTenantId(key.grantee), key.kind, key.resourceId];
  const result = await read(source, (tx) =>
    tx.query(
      `SELECT 1 FROM ${tx.schema}.tenant_grant WHERE grantor_tenant = $1 AND grantee_tenant = $2 AND kind = $3 AND resource_id = $4`,
      values,
    ),
  );
  return result.rows.length > 0;
}

// An open transaction is queried directly, so a handler already inside one needs no second connection.
function read<T>(source: GrantSource, fn: (tx: TenantTx | MetadataTx) => Promise<T>): Promise<T> {
  return 'withMetadata' in source ? source.withMetadata(fn) : fn(source);
}
