// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance rollups: record count and total amount per period and state, rebuilt as `usp_finance_rollup` rebuilds them. */
import { awaitReadable, qualified, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { FinanceDomainError, type FinanceDomainDeps } from './records.js';
import { formatMoney, moneyFromNumeric, sumMoney, type Money } from './money.js';
import type { NewFinanceRollup } from '../repo/repository.js';
import { findProgramBinding, listRollups as queryRollupPage, type Page, type RecordPaging } from '../repo/queries.js';
import { FINANCE_RECORD, type FinanceRollupRow } from '../repo/tables.js';

/** The fields of one record a rollup groups and totals. */
export type RollupSourceRow = { period: string; state: string; amount: Money };

/** One rollup group: its record count and exact total, stamped with the rebuild instant. */
export type RollupRow = { period: string; state: string; recordCount: number; totalAmount: Money; computedAt: Date };

/** Settings of a rebuild: `now` stamps every row as `computed_at`; `ctx` is the provenance of its changelog rows. */
export type RebuildOptions = { now: Date; ctx?: WriteContext };

/** Settings of a rollup read: one fixture page when `paging` is given, else every row. */
export type RollupQuery = { paging?: RecordPaging };

/** Rows per query while `listRollups` reads every row: the largest page the fixture paging admits. */
const ROLLUP_PAGE_SIZE = 1000;

/** The period, state and numeric text amount of every record of one program; RLS scopes the rows to the tenant. */
function sourceSql(schema: string): string {
  // The fixture rebuilds one Program_<id> schema, so only the rows folded from, or written under, the tenant's program count.
  return `SELECT "period", "state", "amount"::text AS "amount" FROM ${qualified(schema, FINANCE_RECORD.table)} WHERE "legacy_program_id" = $1`;
}

/** Orders text by Unicode code point, as `Latin1_General_BIN2` and PostgreSQL `COLLATE "C"` do. */
function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Map entries ordered by key in binary order. */
function sortedEntries<V>(map: Map<string, V>): [string, V][] {
  return [...map].sort(([a], [b]) => compareBinary(a, b));
}

/** Groups `records` by period and state, counting and exactly totalling each group, ordered by period, then state, in binary order. */
export function computeRollups(records: Iterable<RollupSourceRow>, now: Date): RollupRow[] {
  const groups = new Map<string, Map<string, Money[]>>();
  for (const { period, state, amount } of records) {
    let byState = groups.get(period);
    if (byState === undefined) {
      byState = new Map<string, Money[]>();
      groups.set(period, byState);
    }
    const amounts = byState.get(state);
    if (amounts === undefined) byState.set(state, [amount]);
    else amounts.push(amount);
  }
  const rows: RollupRow[] = [];
  for (const [period, byState] of sortedEntries(groups)) {
    for (const [state, amounts] of sortedEntries(byState)) {
      rows.push({ period, state, recordCount: amounts.length, totalAmount: sumMoney(amounts), computedAt: now });
    }
  }
  return rows;
}

/**
 * Replaces the tenant's rollup rows with those computed from its program's records, each stamped `now`; returns the new rows.
 * Throws `invalidParameters` when the tenant has no program, as the fixture does for a site without one.
 */
export async function rebuildRollups(tx: TenantTx, deps: FinanceDomainDeps, { now, ctx = {} }: RebuildOptions): Promise<RollupRow[]> {
  const binding = await findProgramBinding(tx);
  if (binding === null) throw new FinanceDomainError('invalidParameters');
  await awaitReadable(tx, [FINANCE_RECORD.unit]);
  const { rows: source } = await tx.query<{ period: string; state: string; amount: string }>(sourceSql(tx.schema), [
    binding.legacy_program_id,
  ]);
  const rollups = computeRollups(
    source.map((row) => ({ period: row.period, state: row.state, amount: moneyFromNumeric(row.amount) })),
    now,
  );
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

/** Every stored rollup row of the tenant, by period, then state, in binary order. */
export async function listRollups(tx: TenantTx): Promise<FinanceRollupRow[]> {
  const rows: FinanceRollupRow[] = [];
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = await queryRollupPage(tx, { pageIndex, itemsPerPage: ROLLUP_PAGE_SIZE });
    rows.push(...page.rows);
    if (page.rows.length < ROLLUP_PAGE_SIZE) return rows;
  }
}

/** The stored rollup rows the fixture `GET finance/rollups` answers: the requested page, or every row, with the total count. */
export async function getRollups(tx: TenantTx, { paging }: RollupQuery = {}): Promise<Page<FinanceRollupRow>> {
  // The fixture's read neither rebuilds nor takes an `asOf`: stored rows change only through rebuildRollups at each record write.
  if (paging !== undefined) return queryRollupPage(tx, paging);
  const rows = await listRollups(tx);
  return { rows, total: rows.length };
}
