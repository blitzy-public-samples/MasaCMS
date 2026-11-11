// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Grantor lookup over `tenant_grant`; grants are written by platform `writeGrant` and confirmed by `hasGrant`. */
import { withMetadata, type GrantInput, type TenantDb } from '@opt2/platform/tenancy';

/** The tenant that granted `grantee` the `kind` grant on `resourceId`, or null when none has. */
export async function findGrantor(db: TenantDb, { grantee, kind, resourceId }: GrantInput): Promise<string | null> {
  // Qualified by the handle's schema, as platform hasGrant is, not the fixed SCHEMA constant, so a throwaway schema is read.
  const result = await withMetadata(db, (tx) =>
    tx.query<{ grantor_tenant: string }>(
      `SELECT grantor_tenant FROM ${tx.schema}.tenant_grant WHERE grantee_tenant = $1 AND kind = $2 AND resource_id = $3 ORDER BY grantor_tenant LIMIT 1`,
      [grantee, kind, resourceId],
    ),
  );
  return result.rows[0]?.grantor_tenant ?? null;
}
