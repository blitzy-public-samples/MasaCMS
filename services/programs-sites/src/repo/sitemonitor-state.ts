/** The site-monitor cursor, the target's `application.lastMonitored`, and the run lease that serialises passes: the one `sitemonitor_state` row of the system tenant. */
import { SYSTEM_TENANT_ID, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { WriteContext } from '@opt2/platform/migration-kit';
import { createProgramsSitesRepository, type ProgramsSitesRepository } from './repository.js';
import { SITE_MONITOR_STATE } from './tables.js';

const TABLE = SITE_MONITOR_STATE.table;
const KEY = { id: 1 } as const;
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';

/** A `sitemonitor_state` row as pg returns it. */
type StateRow = {
  tenant_id: string;
  id: number;
  last_monitored: Date | null;
  updated_at: Date;
  lease_id: string | null;
  lease_until: Date | null;
};

// The table is qualified by the transaction's schema, which the service opens as `programs_sites` and isolation
// tests as their throwaway schema.
/** `<schema>.sitemonitor_state` of the transaction's schema. */
function cursorTable(tx: TenantTx): string {
  return `${tx.schema}.${TABLE}`;
}

/** Runs `fn` in a system-tenant transaction that first takes the row's advisory lock, which serialises writers before the row exists. */
function inStateTx<T>(db: TenantDb, clock: Clock, fn: (tx: TenantTx, repo: ProgramsSitesRepository) => Promise<T>): Promise<T> {
  const repo = createProgramsSitesRepository({ clock, schema: db.schema });
  return withTenant(db, SYSTEM_TENANT_ID, async (tx) => {
    await tx.query(ADVISORY_LOCK_SQL, [cursorTable(tx)]);
    return fn(tx, repo);
  });
}

/** The stored cursor and the row's last update; both null while the row is absent. */
export interface CursorState {
  readonly lastMonitored: Date | null;
  readonly updatedAt: Date | null;
}

function cursorStateOf(row: Pick<StateRow, 'last_monitored' | 'updated_at'> | undefined): CursorState {
  return { lastMonitored: row?.last_monitored ?? null, updatedAt: row?.updated_at ?? null };
}

/** The stored cursor with the row's `updated_at`. */
export function readState(db: TenantDb): Promise<CursorState> {
  return withTenant(db, SYSTEM_TENANT_ID, async (tx) => {
    const { rows } = await tx.query<Pick<StateRow, 'last_monitored' | 'updated_at'>>(
      `SELECT last_monitored, updated_at FROM ${cursorTable(tx)} WHERE tenant_id = $1 AND id = 1`,
      [tx.tenantId],
    );
    return cursorStateOf(rows[0]);
  });
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

/** Stores `at` as the cursor unconditionally, creating the row on first use, with `updated_at` from `clock`; resolves the stored state; `ctx` defaults to the request's provenance. */
export async function writeCursor(db: TenantDb, at: Date, clock: Clock = systemClock, ctx: WriteContext = {}): Promise<CursorState> {
  const row = await inStateTx(db, clock, (tx, repo) =>
    repo.upsert<StateRow>(tx, TABLE, { ...KEY, last_monitored: at, updated_at: clock.now() }, ctx),
  );
  return cursorStateOf(row);
}

/** Answer of `acquireLease`: the stored cursor (null before the first pass) when granted, `busy` while another holder's lease is live. */
export type LeaseGrant = { readonly status: 'granted'; readonly lastMonitored: Date | null } | { readonly status: 'busy' };

/** Takes the run lease for `leaseId` until `until` unless another holder's lease outlasts `clock.now()`. */
export function acquireLease(db: TenantDb, leaseId: string, until: Date, clock: Clock = systemClock, ctx: WriteContext = {}): Promise<LeaseGrant> {
  return inStateTx(db, clock, async (tx, repo): Promise<LeaseGrant> => {
    const now = clock.now();
    const row = await repo.findByKey<StateRow>(tx, TABLE, KEY);
    if (row !== null && row.lease_id !== null && row.lease_until !== null && row.lease_until.getTime() > now.getTime()) {
      return { status: 'busy' };
    }
    const stored = await repo.upsert<StateRow>(tx, TABLE, { ...KEY, lease_id: leaseId, lease_until: until, updated_at: now }, ctx);
    return { status: 'granted', lastMonitored: stored.last_monitored };
  });
}

/** Moves the cursor forward to `at` while `leaseId` holds the lease, never backwards; false once it no longer holds it. */
export function advanceCursor(db: TenantDb, leaseId: string, at: Date, clock: Clock = systemClock, ctx: WriteContext = {}): Promise<boolean> {
  return inStateTx(db, clock, async (tx, repo) => {
    const row = await repo.findByKey<StateRow>(tx, TABLE, KEY);
    if (row === null || row.lease_id !== leaseId) {
      return false;
    }
    if (row.last_monitored === null || row.last_monitored.getTime() < at.getTime()) {
      await repo.update(tx, TABLE, KEY, { last_monitored: at, updated_at: clock.now() }, ctx);
    }
    return true;
  });
}

/** Clears the lease while `leaseId` holds it; false when it does not. */
export function releaseLease(db: TenantDb, leaseId: string, clock: Clock = systemClock, ctx: WriteContext = {}): Promise<boolean> {
  return inStateTx(db, clock, async (tx, repo) => {
    const row = await repo.findByKey<StateRow>(tx, TABLE, KEY);
    if (row === null || row.lease_id !== leaseId) {
      return false;
    }
    await repo.update(tx, TABLE, KEY, { lease_id: null, lease_until: null, updated_at: clock.now() }, ctx);
    return true;
  });
}
