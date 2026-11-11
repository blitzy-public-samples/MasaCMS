/** The site-monitor cursor, the target's `application.lastMonitored`: the one `sitemonitor_state` row of the system tenant. */
import { SYSTEM_TENANT_ID, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { SITE_MONITOR_STATE } from './tables.js';

// Plain statements, not the platform repository: the cursor is no unit, so it writes no changelog row, takes no gate
// and records no write position. The table is qualified by the transaction's schema, which the service opens as
// `programs_sites` and isolation tests as their throwaway schema.
/** `<schema>.sitemonitor_state` of the transaction's schema. */
function cursorTable(tx: TenantTx): string {
  return `${tx.schema}.${SITE_MONITOR_STATE.table}`;
}

/** The stored cursor; null when the row is absent or its `last_monitored` is NULL. */
export function readCursor(db: TenantDb): Promise<Date | null> {
  return withTenant(db, SYSTEM_TENANT_ID, async (tx) => {
    const { rows } = await tx.query<{ last_monitored: Date | null }>(
      `SELECT last_monitored FROM ${cursorTable(tx)} WHERE tenant_id = $1 AND id = 1`,
      [tx.tenantId],
    );
    return rows[0]?.last_monitored ?? null;
  });
}

/** Stores `at` as the cursor, creating the row on first use, with `updated_at` from `clock`. */
export async function writeCursor(db: TenantDb, at: Date, clock: Clock = systemClock): Promise<void> {
  await withTenant(db, SYSTEM_TENANT_ID, async (tx) => {
    await tx.query(
      `INSERT INTO ${cursorTable(tx)} (tenant_id, id, last_monitored, updated_at) VALUES ($1, 1, $2, $3)` +
        ' ON CONFLICT (tenant_id, id) DO UPDATE SET last_monitored = EXCLUDED.last_monitored, updated_at = EXCLUDED.updated_at',
      [tx.tenantId, at, clock.now()],
    );
  });
}
