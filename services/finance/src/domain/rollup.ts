// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance rollups: record count and total amount per period and state, rebuilt as `usp_finance_rollup` rebuilds them. */
import { awaitReadable, qualified, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { FinanceDomainError, type FinanceDomainDeps } from './records.js';
import { formatMoney, moneyFromNumeric, type Money } from './money.js';
import type { NewFinanceRollup } from '../repo/repository.js';
import { findProgramBinding, listRollups as queryRollupPage, type Page, type RecordPaging } from '../repo/queries.js';
import { FINANCE_RECORD, type FinanceRollupRow } from '../repo/tables.js';

/** One rollup group: its record count and exact total, stamped with the rebuild instant. */
export type RollupRow = { period: string; state: string; recordCount: number; totalAmount: Money; computedAt: Date };

/** Settings of a rebuild: `now` stamps every row as `computed_at`; `ctx` is the provenance of its changelog rows. */
export type RebuildOptions = { now: Date; ctx?: WriteContext };

/** Settings of a rollup read: the fixture page to answer. */
export type RollupQuery = { paging: RecordPaging };

/** One group of `groupsSql`: its record count and numeric text total. */
type RollupGroup = { period: string; state: string; record_count: number; total_amount: string };

/** Record count and numeric text total per period and state of one program, in binary order; RLS scopes the rows to the tenant. */
function groupsSql(schema: string): string {
  // The fixture rebuilds one Program_<id> schema, so only the rows folded from, or written under, the tenant's program count.
  return (
    `SELECT "period", "state", count(*)::integer AS "record_count", sum("amount")::text AS "total_amount"` +
    ` FROM ${qualified(schema, FINANCE_RECORD.table)} WHERE "legacy_program_id" = $1` +
    ' GROUP BY "period", "state" ORDER BY "period" COLLATE "C", "state" COLLATE "C"'
  );
}

/**
 * Replaces the tenant's rollup rows with those computed from its program's records, each stamped `now`; returns the new rows.
 * Throws `invalidParameters` when the tenant has no program, as the fixture does for a site without one.
 */
export async function rebuildRollups(tx: TenantTx, deps: FinanceDomainDeps, { now, ctx = {} }: RebuildOptions): Promise<RollupRow[]> {
  const binding = await findProgramBinding(tx);
  if (binding === null) throw new FinanceDomainError('invalidParameters');
  await awaitReadable(tx, [FINANCE_RECORD.unit]);
  const { rows: groups } = await tx.query<RollupGroup>(groupsSql(tx.schema), [binding.legacy_program_id]);
  const rollups: RollupRow[] = groups.map((group) => ({
    period: group.period,
    state: group.state,
    recordCount: group.record_count,
    totalAmount: moneyFromNumeric(group.total_amount),
    computedAt: now,
  }));
  const stored: NewFinanceRollup[] = rollups.map((row) => ({
    tenant_id: tx.tenantId,
    period: row.period,
    state: row.state,
    record_count: row.recordCount,
    total_amount: formatMoney(row.totalAmount),
    computed_at: row.computedAt,
    legacy_program_id: binding.legacy_program_id,
  }));
  await deps.repository.replaceRollups(tx, stored, ctx);
  return rollups;
}

/** The stored rollup rows the fixture `GET finance/rollups` answers: the requested page, with the total count. */
export async function getRollups(tx: TenantTx, { paging }: RollupQuery): Promise<Page<FinanceRollupRow>> {
  // The fixture's read neither rebuilds nor takes an `asOf`: stored rows change only through rebuildRollups at each record write.
  return queryRollupPage(tx, paging);
}
