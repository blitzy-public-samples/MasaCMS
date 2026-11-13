// Unit leases in `migration.unit_lease`: one holder per unit, shared by write windows and transitions.
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { MetadataTx } from '@opt2/platform/tenancy';

import type { MigrationContext } from '../context.js';

/** Kind of lease holder. */
export type LeaseKind = 'window' | 'transition';

/** One lease: `unit` is held by `holderId` since `acquiredAt`. */
export interface LeaseRow {
  unit: string;
  holderId: string;
  kind: LeaseKind;
  acquiredAt: Date;
}

/**
 * Input of {@link acquireLeases}; `budgetMs` bounds the wait for units other holders own, `signal` aborts its transactions,
 * `sleep` replaces the timer in tests.
 */
export interface AcquireLeasesInput {
  units: string[];
  holderId: string;
  kind: LeaseKind;
  budgetMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** Poll interval between acquisition attempts while another holder owns a requested unit. */
export const LEASE_RETRY_INTERVAL_MS = 200;

const UNIQUE_VIOLATION = '23505';
const QUERY_CANCELED = '57014';
const LOCK_NOT_AVAILABLE = '55P03';
const RETRYABLE_CODES: ReadonlySet<unknown> = new Set([UNIQUE_VIOLATION, QUERY_CANCELED, LOCK_NOT_AVAILABLE]);
const SET_STATEMENT_TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, true)";
const LEASE_TABLE = 'unit_lease';
const COLUMNS = 'unit, holder_id, kind, acquired_at';

type LeaseContext = Pick<MigrationContext, 'db'>;
type AcquireContext = Pick<MigrationContext, 'db' | 'clock'>;

interface LeaseRecord {
  unit: string;
  holder_id: string;
  kind: LeaseKind;
  acquired_at: Date;
}

/** Other holders kept a requested unit for the whole acquisition budget. */
export class LeaseUnavailableError extends LegacyServiceUnavailableError {
  override readonly name: string = 'LeaseUnavailableError';

  constructor(
    readonly units: string[],
    readonly holderId: string,
    readonly conflictingHolders: string[],
  ) {
    const holders = conflictingHolders.length > 0 ? conflictingHolders.join(', ') : 'another holder';
    super(`Units ${units.join(', ')} are leased by ${holders}; ${holderId} could not acquire them`, 'auto', 'lease-unavailable');
  }
}

// Qualified by the handle's schema, so a throwaway test schema is read rather than a literal `migration.`.
function leaseTable(tx: MetadataTx): string {
  return `${tx.schema}.${LEASE_TABLE}`;
}

function toLeaseRow(record: LeaseRecord): LeaseRow {
  return { unit: record.unit, holderId: record.holder_id, kind: record.kind, acquiredAt: record.acquired_at };
}

function byUnit(a: LeaseRow, b: LeaseRow): number {
  return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0;
}

// 23505: another holder committed a requested unit; 57014: the statement timeout ended the wait on one held uncommitted;
// 55P03: a lock_timeout the role or database sets ended it.
function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && RETRYABLE_CODES.has(error.code);
}

/**
 * One attempt in one transaction: keeps the units `holderId` already holds and inserts the rest, or fails whole with 23505,
 * 57014 or 55P03. `remaining` returns the budget left in ms, which bounds the insert's whole wait on other transactions.
 */
function tryAcquire(ctx: AcquireContext, units: string[], input: AcquireLeasesInput, remaining: () => number): Promise<LeaseRow[]> {
  return ctx.db.withMetadata(async (tx) => {
    const table = leaseTable(tx);
    const held = await tx.query<LeaseRecord>(
      `SELECT ${COLUMNS} FROM ${table} WHERE holder_id = $1 AND unit = ANY($2::text[])`,
      [input.holderId, units],
    );
    const heldUnits = new Set(held.rows.map((row) => row.unit));
    const missing = units.filter((unit) => !heldUnits.has(unit));
    if (missing.length === 0) return held.rows.map(toLeaseRow).sort(byUnit);
    // statement_timeout 0 disables the timeout, so an exhausted budget still gets the shortest positive one.
    await tx.query(SET_STATEMENT_TIMEOUT_SQL, [`${Math.max(1, Math.ceil(remaining()))}ms`]);
    // Rows go in in the caller's sorted order, so holders contend in one order and cannot deadlock. No ON CONFLICT:
    // a unit another holder owns fails the whole statement, so nothing partial is ever held.
    const inserted = await tx.query<LeaseRecord>(
      `INSERT INTO ${table} (${COLUMNS})
       SELECT u.unit, $1::text, $2::text, $3::timestamp(3) FROM unnest($4::text[]) WITH ORDINALITY AS u(unit, ord) ORDER BY u.ord
       RETURNING ${COLUMNS}`,
      [input.holderId, input.kind, ctx.clock.now(), missing],
    );
    return [...held.rows, ...inserted.rows].map(toLeaseRow).sort(byUnit);
  }, { signal: input.signal });
}

/** Holders other than `holderId` of any of `units`, sorted; `signal` aborts the read. */
async function otherHolders(ctx: LeaseContext, units: string[], holderId: string, signal?: AbortSignal): Promise<string[]> {
  const { rows } = await ctx.db.withMetadata(
    (tx) =>
      tx.query<{ holder_id: string }>(
        `SELECT DISTINCT holder_id FROM ${leaseTable(tx)} WHERE unit = ANY($1::text[]) AND holder_id <> $2`,
        [units, holderId],
      ),
    { signal },
  );
  return rows.map((row) => row.holder_id).sort();
}

/**
 * Leases every unit of `input.units` to `input.holderId` atomically; units it already holds are kept as they are.
 * @returns the holder's leases of the requested units, sorted by unit.
 * @throws LeaseUnavailableError when another holder still owns a requested unit once `budgetMs` has passed.
 */
export async function acquireLeases(ctx: AcquireContext, input: AcquireLeasesInput): Promise<LeaseRow[]> {
  const units = [...new Set(input.units)].sort();
  const sleep = input.sleep ?? ((ms: number) => delay(ms));
  const startedAt = ctx.clock.now().getTime();
  const remaining = (): number => input.budgetMs - (ctx.clock.now().getTime() - startedAt);
  for (;;) {
    try {
      return await tryAcquire(ctx, units, input, remaining);
    } catch (error) {
      if (!isRetryable(error)) throw error;
    }
    const remainingMs = remaining();
    if (remainingMs <= 0) break;
    await sleep(Math.min(LEASE_RETRY_INTERVAL_MS, remainingMs));
  }
  // The budget and the signal end together, so an aborted lookup still reports the units as unavailable.
  const holders = await otherHolders(ctx, units, input.holderId, input.signal).catch((error: unknown) => {
    if (input.signal?.aborted === true) return [];
    throw error;
  });
  throw new LeaseUnavailableError(units, input.holderId, holders);
}

/** Deletes every lease of `holderId`; call only after every gate it closed is reopened or reset. @returns the number released. */
export async function releaseLeases(ctx: LeaseContext, holderId: string): Promise<number> {
  const result = await ctx.db.withMetadata((tx) => tx.query(`DELETE FROM ${leaseTable(tx)} WHERE holder_id = $1`, [holderId]));
  return result.rowCount ?? 0;
}

/** Every lease `holderId` holds, sorted by unit. */
export async function leasesOf(ctx: LeaseContext, holderId: string): Promise<LeaseRow[]> {
  const { rows } = await ctx.db.withMetadata((tx) =>
    tx.query<LeaseRecord>(`SELECT ${COLUMNS} FROM ${leaseTable(tx)} WHERE holder_id = $1`, [holderId]),
  );
  return rows.map(toLeaseRow).sort(byUnit);
}

/** Holder id of each leased unit among `units`; unleased units are absent. */
export async function holdersOf(ctx: LeaseContext, units: readonly string[]): Promise<Map<string, string>> {
  const { rows } = await ctx.db.withMetadata((tx) =>
    tx.query<{ unit: string; holder_id: string }>(
      `SELECT unit, holder_id FROM ${leaseTable(tx)} WHERE unit = ANY($1::text[])`,
      [units],
    ),
  );
  return new Map(rows.map((row) => [row.unit, row.holder_id]));
}
