/** Per-tenant counts of outbox rows still to publish, which migration's position endpoint reports while a transition drains. */
import { registeredTenants, withTenant, type TenantDb } from '../tenancy/index.js';
import { outboxTable } from './ddl.js';

/** Lists the tenants whose outbox rows are counted. */
export type TenantsOf = (db: TenantDb) => Promise<readonly string[]>;

/** Every tenant of the service's `tenant_registry`, without repeats. */
export const registryTenants: TenantsOf = async (db) => [
  ...new Set((await registeredTenants(db)).map((entry) => entry.tenantId)),
];

/** Outbox counts of one tenant: `unpublished` excludes held rows, `held` counts rows of open operations. */
export interface TenantDrainCount {
  tenantId: string;
  unpublished: number;
  held: number;
}

/** Per-tenant counts ordered by tenant id, with their totals. */
export interface OutboxDrainCounts {
  tenants: TenantDrainCount[];
  unpublished: number;
  held: number;
}

/** Counts unpublished and held outbox rows of every listed tenant, each in its own tenant transaction under RLS. */
export async function outboxDrainCounts(db: TenantDb, opts?: { tenantsOf?: TenantsOf }): Promise<OutboxDrainCounts> {
  const table = outboxTable(db.schema);
  // Each WHERE repeats its partial index predicate, so the counts read only pending and held rows.
  const sql =
    `SELECT (SELECT count(*) FROM ${table} WHERE published_at IS NULL AND NOT held) AS unpublished,` +
    ` (SELECT count(*) FROM ${table} WHERE held) AS held`;
  // Case-folded as withTenant folds them, so one tenant is never counted twice.
  const tenantIds = new Set((await (opts?.tenantsOf ?? registryTenants)(db)).map((id) => id.toLowerCase()));
  const tenants: TenantDrainCount[] = [];
  // Sequential, so the count holds at most one pooled connection at a time.
  for (const tenantId of tenantIds) {
    tenants.push(
      await withTenant(db, tenantId, async (tx) => {
        const {
          rows: [row],
        } = await tx.query<{ unpublished: string; held: string }>(sql);
        return { tenantId: tx.tenantId, unpublished: Number(row?.unpublished), held: Number(row?.held) };
      }),
    );
  }
  tenants.sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0));
  return {
    tenants,
    unpublished: tenants.reduce((sum, t) => sum + t.unpublished, 0),
    held: tenants.reduce((sum, t) => sum + t.held, 0),
  };
}
