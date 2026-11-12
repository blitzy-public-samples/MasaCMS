// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance rollup domain: SQL-grouped rebuilds and paged reads against a throwaway `finance` schema. */
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { StoragePort } from '@opt2/platform/storage';
import { tenantDbFromPool, tenantIdForSite, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { FINANCE_STATES } from '../../src/domain/lifecycle.transitions.js';
import { formatMoney, sumMoney, type Money } from '../../src/domain/money.js';
import { FinanceDomainError, createRecord, transitionRecord, type FinanceActor, type FinanceDomainDeps } from '../../src/domain/records.js';
import { getRollups, rebuildRollups, type RollupRow } from '../../src/domain/rollup.js';
import type { RecordPaging } from '../../src/repo/queries.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { UNITS, type FinanceRollupRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 0, 0, 0, 0);
const LATER = new Date(2026, 6, 1, 12, 30, 15, 120);
// 999999999999999.9999, the largest numeric(19,4) value, as Money.
const MAX: Money = 9_999_999_999_999_999_999n;
const PROGRAM_ID = 7;
// A program no tenant of the schema is bound to.
const FOREIGN_PROGRAM_ID = PROGRAM_ID + 1;
const PREPARER = ['finance.preparer'];
const FIRST_PAGE: RecordPaging = { pageIndex: 1, itemsPerPage: 1000 };

/** One record a grouping case seeds; `program` defaults to the case tenant's own program. */
type Seed = { period: string; state: string; amount: Money; program?: number };

/** Period, state, count and four-decimal total of one rollup group. */
type Summary = [string, string, number, string];

/** Code-point order of two texts, as COLLATE "C" orders them. */
function binary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Period, state, count and four-decimal total of each domain rollup row. */
function summary(rows: readonly RollupRow[]): Summary[] {
  return rows.map((row) => [row.period, row.state, row.recordCount, formatMoney(row.totalAmount)]);
}

/** Period, state, count, total, stamp, program and tenant of each stored rollup row. */
function storedSummary(rows: readonly FinanceRollupRow[]): [string, string, number, string, number, number, string][] {
  return rows.map((row) => [row.period, row.state, row.record_count, row.total_amount, row.computed_at.getTime(), row.legacy_program_id, row.tenant_id]);
}

/** `tx` that appends the row count of every query result it answers to `counts`. */
function counting(tx: TenantTx, counts: number[]): TenantTx {
  const query = (async (text: string, values?: unknown[]) => {
    const result = await tx.query(text, values);
    counts.push(result.rows.length);
    return result;
  }) as TenantTx['query'];
  return { ...tx, query };
}

/** Storage port the rollup paths never touch. */
function unusedStorage(): StoragePort {
  const unused = (): never => {
    throw new Error('not used by the rollup domain');
  };
  return { kind: 'local', put: unused, get: unused, stream: unused, open: unused, delete: unused, head: unused, signedUrl: unused };
}

const available = await pgAvailable();

describe.skipIf(!available)('finance rollup domain against PostgreSQL', () => {
  const site = 'rollup-domain-a';
  const tenant = tenantIdForSite(site);
  const unbound = tenantIdForSite('rollup-domain-unbound');
  const actor: FinanceActor = { userId: '11111111-2222-3333-4444555566667777', siteId: site };
  let handle: ThrowawaySchema;
  let stagingDb: TenantDb;
  let deps: FinanceDomainDeps;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'finance',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    stagingDb = tenantDbFromPool(handle.connect('app', { max: 1 }), { schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'rollup-domain-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'rollup-domain-test', state: 'open' });
    await bind(site, PROGRAM_ID);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    const storage = unusedStorage();
    const clock = fixedClock(NOW);
    deps = { repository: createFinanceRepository({ db: handle.app, stagingDb, storage, clock }), storage, clock };
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, id = tenant): Promise<T> {
    return handle.app.withTenant(id, fn);
  }

  /** `<op> <table> <actor>` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<string[]> {
    const { rows } = await tx.query<{ op: string; table: string; actor_user_id: string | null }>(
      `SELECT op, "table", actor_user_id FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows.map((row) => `${row.op} ${row.table} ${row.actor_user_id ?? '-'}`);
  }

  /** Binds the tenant of `siteId` to program `programId`; returns the tenant id. */
  async function bind(siteId: string, programId: number): Promise<string> {
    const id = tenantIdForSite(siteId);
    await inTenant(
      (tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.program_binding (tenant_id, site_id, legacy_program_id, updated_at) VALUES ($1, $2, $3, $4)`,
          [id, siteId, programId, NOW],
        ),
      id,
    );
    return id;
  }

  let nextProgramId = PROGRAM_ID + 2;

  /** Seeds `seeds` under a fresh tenant with its own program, rebuilds through `wrap(tx)` at NOW; returns rebuilt and stored rows. */
  async function rebuiltFrom(
    seeds: readonly Seed[],
    wrap: (tx: TenantTx) => TenantTx = (tx) => tx,
  ): Promise<{ rows: RollupRow[]; stored: FinanceRollupRow[]; tenantId: string; programId: number }> {
    const programId = nextProgramId++;
    const siteId = `rollup-domain-p${programId}`;
    const tenantId = await bind(siteId, programId);
    return inTenant(async (tx) => {
      for (const seed of seeds) {
        await deps.repository.insertRecord(tx, {
          tenant_id: tx.tenantId,
          siteid: siteId,
          title: 'Seed',
          amount: formatMoney(seed.amount),
          period: seed.period,
          state: seed.state,
          version: 1,
          created: NOW,
          createdbyid: actor.userId,
          lastupdate: null,
          lastupdatebyid: null,
          legacy_program_id: seed.program ?? programId,
        });
      }
      const rows = await rebuildRollups(wrap(tx), deps, { now: NOW });
      return { rows, stored: (await getRollups(tx, { paging: FIRST_PAGE })).rows, tenantId, programId };
    }, tenantId);
  }

  it.each<[string, Seed[], Summary[]]>([
    ['no records', [], []],
    [
      'hyphenated states in binary order',
      [
        { period: '2026-10', state: 'REJECTED', amount: 1n },
        { period: '2026-10', state: 'RE-SUBMITTED', amount: 2n },
        { period: '2026-09', state: 'SUBMITTED', amount: 3n },
        { period: '2026-10', state: 'REJECTED', amount: -4n },
      ],
      [
        ['2026-09', 'SUBMITTED', 1, '0.0003'],
        ['2026-10', 'RE-SUBMITTED', 1, '0.0002'],
        ['2026-10', 'REJECTED', 2, '-0.0003'],
      ],
    ],
    [
      'exact totals beyond Number precision',
      [
        { period: '2026-06', state: 'APPROVED', amount: MAX - 1n },
        { period: '2026-06', state: 'APPROVED', amount: 1n },
        { period: '2026-07', state: 'APPROVED', amount: 1000n },
        { period: '2026-07', state: 'APPROVED', amount: 2000n },
        { period: '2026-08', state: 'REJECTED', amount: 1n - MAX },
        { period: '2026-08', state: 'REJECTED', amount: -1n },
      ],
      [
        ['2026-06', 'APPROVED', 2, '999999999999999.9999'],
        ['2026-07', 'APPROVED', 2, '0.3000'],
        ['2026-08', 'REJECTED', 2, '-999999999999999.9999'],
      ],
    ],
    [
      'negative amounts',
      [
        { period: '2026-06', state: 'REJECTED', amount: -1_2500n },
        { period: '2026-06', state: 'REJECTED', amount: -2_5000n },
        { period: '2026-06', state: 'REJECTED', amount: 1n },
        { period: '2026-07', state: 'SUBMITTED', amount: -5000n },
        { period: '2026-07', state: 'SUBMITTED', amount: 5000n },
      ],
      [
        ['2026-06', 'REJECTED', 3, '-3.7499'],
        ['2026-07', 'SUBMITTED', 2, '0.0000'],
      ],
    ],
    [
      'only the records of the tenant program',
      [
        { period: '2026-06', state: 'SUBMITTED', amount: 1n },
        { period: '2026-06', state: 'SUBMITTED', amount: 2n, program: FOREIGN_PROGRAM_ID },
        { period: '2026-08', state: 'APPROVED', amount: 3n, program: FOREIGN_PROGRAM_ID },
      ],
      [['2026-06', 'SUBMITTED', 1, '0.0001']],
    ],
  ])('groups %s, stamping and storing each group', async (_label, seeds, expected) => {
    const { rows, stored, tenantId, programId } = await rebuiltFrom(seeds);
    expect(summary(rows)).toEqual(expected);
    expect(rows.every((row) => row.computedAt === NOW)).toBe(true);
    expect(storedSummary(stored)).toEqual(expected.map((row) => [...row, NOW.getTime(), programId, tenantId]));
  });

  it('keeps every record count and the exact grand total in unique groups ordered by period, then state', async () => {
    const seed = fc.record({
      period: fc.constantFrom('2025-12', '2026-01', '2026-06', '2026-09', '2026-10'),
      state: fc.constantFrom(...FINANCE_STATES),
      // Bounded so that no group of up to 40 records totals beyond numeric(19,4).
      amount: fc.bigInt({ min: -MAX / 40n, max: MAX / 40n }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(seed, { maxLength: 40 }), async (seeds: Seed[]) => {
        const { rows } = await rebuiltFrom(seeds);
        expect(sumMoney(rows.map((row) => row.totalAmount))).toBe(sumMoney(seeds.map((s) => s.amount)));
        expect(rows.reduce((count, row) => count + row.recordCount, 0)).toBe(seeds.length);
        expect(rows).toEqual([...rows].sort((a, b) => binary(a.period, b.period) || binary(a.state, b.state)));
        for (const row of rows) {
          const members = seeds.filter((s) => s.period === row.period && s.state === row.state);
          expect(row).toEqual({
            ...row,
            recordCount: members.length,
            totalAmount: sumMoney(members.map((m) => m.amount)),
            computedAt: NOW,
          });
        }
        expect(new Set(rows.map((row) => `${row.period}\n${row.state}`)).size).toBe(rows.length);
      }),
      { numRuns: 20 },
    );
  });

  it('transfers one row per group, not one per record', async () => {
    const seeds = Array.from({ length: 30 }, (_, i): Seed => ({
      period: '2026-06',
      state: i % 2 === 0 ? 'APPROVED' : 'REJECTED',
      amount: 1n,
    }));
    const counts: number[] = [];
    const { rows } = await rebuiltFrom(seeds, (tx) => counting(tx, counts));
    expect(summary(rows)).toEqual([
      ['2026-06', 'APPROVED', 15, '0.0015'],
      ['2026-06', 'REJECTED', 15, '0.0015'],
    ]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(rows.length);
  });

  it('rebuilds from the program records with one changelog row per replaced row, and repeats identically', async () => {
    await inTenant(async (tx) => {
      const travel = await createRecord(tx, deps, { title: 'Travel', amount: 12_3450n, period: '2026-06' }, actor);
      await createRecord(tx, deps, { title: 'Refund', amount: -2_0001n, period: '2026-06' }, actor);
      await createRecord(tx, deps, { title: 'Stamps', amount: 5n, period: '2026-10' }, actor);
      await transitionRecord(tx, deps, { id: travel.record.record_id, action: 'submit', roles: PREPARER }, actor);
      await deps.repository.insertRecord(tx, { ...travel.record, record_id: undefined, row_version: undefined, legacy_program_id: PROGRAM_ID + 1 });
    });
    const expected = [
      ['2026-06', 'IN-PROGRESS', 1, '-2.0001'],
      ['2026-06', 'SUBMITTED', 1, '12.3450'],
      ['2026-10', 'IN-PROGRESS', 1, '0.0005'],
    ];
    const inserts = Array.from({ length: 3 }, () => `insert rollup ${actor.userId}`);
    const deletes = Array.from({ length: 3 }, () => `delete rollup ${actor.userId}`);
    const ctx = { actorUserId: actor.userId };

    const first = await inTenant(async (tx) => {
      const rows = await rebuildRollups(tx, deps, { now: NOW, ctx });
      expect(await written(tx)).toEqual(inserts);
      return rows;
    });
    expect(summary(first)).toEqual(expected);
    const stored = (await inTenant((tx) => getRollups(tx, { paging: FIRST_PAGE }))).rows;
    expect(storedSummary(stored)).toEqual(expected.map((row) => [...row, NOW.getTime(), PROGRAM_ID, tenant]));

    const second = await inTenant(async (tx) => {
      const rows = await rebuildRollups(tx, deps, { now: NOW, ctx });
      expect(await written(tx)).toEqual([...deletes, ...inserts]);
      return rows;
    });
    expect(second).toEqual(first);
    expect(storedSummary((await inTenant((tx) => getRollups(tx, { paging: FIRST_PAGE }))).rows)).toEqual(storedSummary(stored));
  });

  it('stamps every row with the rebuild instant and pages the stored rows as the fixture read does', async () => {
    const rebuilt = await inTenant((tx) => rebuildRollups(tx, deps, { now: LATER }));
    expect(rebuilt.every((row) => row.computedAt === LATER)).toBe(true);
    const page = await inTenant((tx) => getRollups(tx, { paging: { pageIndex: 2, itemsPerPage: 2 } }));
    expect(page.total).toBe(rebuilt.length);
    expect(page.rows.map((row) => [row.period, row.state, row.computed_at.getTime()])).toEqual(
      rebuilt.slice(2, 4).map((row) => [row.period, row.state, LATER.getTime()]),
    );
    const all = await inTenant((tx) => getRollups(tx, { paging: FIRST_PAGE }));
    expect(all.total).toBe(rebuilt.length);
    expect(all.rows.map((row) => [row.period, row.state, row.record_count, row.total_amount, row.computed_at.getTime()])).toEqual(
      summary(rebuilt).map((row) => [...row, LATER.getTime()]),
    );
  });

  it('counts a record written earlier in the same transaction', async () => {
    const rows = await inTenant(async (tx) => {
      const { record } = await createRecord(tx, deps, { title: 'Desk', amount: 1_0000n, period: '2027-01' }, actor);
      return rebuildRollups(tx, deps, { now: record.created });
    });
    expect(summary(rows).filter(([period]) => period === '2027-01')).toEqual([['2027-01', 'IN-PROGRESS', 1, '1.0000']]);
  });

  it('refuses to rebuild for a tenant without a program and reads no rows for it', async () => {
    const rebuild = inTenant((tx) => rebuildRollups(tx, deps, { now: NOW }), unbound);
    await expect(rebuild).rejects.toBeInstanceOf(FinanceDomainError);
    await expect(rebuild).rejects.toMatchObject({ type: 'invalidParameters' });
    expect(await inTenant((tx) => getRollups(tx, { paging: FIRST_PAGE }), unbound)).toEqual({ rows: [], total: 0 });
  });
});
