// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance rollups over the recording db: the rebuild each fixture write runs, checked against a bigint reference of `usp_finance_rollup`, and the fixture and `/v1` reads of its rows. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSINESS_DATE, TENANT_A, TENANT_B, asOf, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import { getRollups } from '../../src/domain/rollup.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { programBindingRow, recordRow } from '../helpers/records.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const FIXTURE_ROLLUPS = `${FIXTURE_PREFIX}/rollups`;
const V1_ROLLUPS = '/v1/finance/rollups';
const FIELD_ORDER = ['period', 'state', 'record_count', 'total_amount', 'computed_at'];
const ALL_ROWS = { pageIndex: 1, itemsPerPage: 1000 };

/** Period, state and four-decimal amount of one record. */
type Amounted = readonly [period: string, state: string, amount: string];

/** A rollup row as the fixture serializes it. */
type FixtureRollup = { period: string; state: string; record_count: number; total_amount: string; computed_at: string };

// Every period stays within the fixture's period-total bound; the 2026-04 and 2026-05 groups total what Number arithmetic rounds or loses.
const TENANT_A_RECORDS: readonly Amounted[] = [
  ['2026-04', 'APPROVED', '999999999999989.0000'],
  ['2026-04', 'APPROVED', '9.9999'],
  ['2026-04', 'REJECTED', '-999999999999989.0000'],
  ['2026-04', 'REJECTED', '-9.9999'],
  ['2026-04', 'IN-PROGRESS', '0.1000'],
  ['2026-04', 'IN-PROGRESS', '0.2000'],
  ['2026-04', 'SUBMITTED', '0.1000'],
  ['2026-04', 'SUBMITTED', '-0.2000'],
  ['2026-04', 'RE-SUBMITTED', '0.0001'],
  ['2026-05', 'APPROVED', '1250.5000'],
  ['2026-05', 'APPROVED', '-250.5000'],
  ['2026-05', 'APPROVED', '0.0001'],
  ['2026-05', 'IN-PROGRESS', '123456789012345.6789'],
  ['2026-05', 'IN-PROGRESS', '-123456789012345.6788'],
  ['2026-05', 'RE-SUBMITTED', '-0.1000'],
  ['2026-05', 'RE-SUBMITTED', '-0.2000'],
  ['2026-05', 'REJECTED', '42.4200'],
  ['2026-05', 'SUBMITTED', '0.0000'],
  ['2026-05', 'SUBMITTED', '0.0000'],
  ['2026-06', 'APPROVED', '100.0000'],
  ['2026-06', 'APPROVED', '100.0000'],
  ['2026-06', 'APPROVED', '100.0000'],
  ['2026-06', 'IN-PROGRESS', '19.9900'],
  ['2026-06', 'IN-PROGRESS', '-19.9900'],
  ['2026-06', 'RE-SUBMITTED', '7.0700'],
  ['2026-06', 'REJECTED', '-5000.0000'],
  ['2026-06', 'REJECTED', '4999.9999'],
  ['2026-06', 'SUBMITTED', '0.3333'],
  ['2026-06', 'SUBMITTED', '0.3333'],
  ['2026-06', 'SUBMITTED', '0.3334'],
];

/** The record the fixture write creates; finance.cfc creates every record IN-PROGRESS. */
const WRITTEN: Amounted = ['2026-06', 'IN-PROGRESS', '0.0001'];

/** A stored tenant-a group no record holds any longer, which the rebuild must drop. */
const STALE_GROUP = { period: '2025-12', state: 'APPROVED', record_count: 9, total_amount: '9.0000' };

/** Tenant-b's record and its stored group, neither of which a tenant-a rebuild or read may reach. */
const TENANT_B_RECORD: Amounted = ['2026-06', 'APPROVED', '5.0000'];
const TENANT_B_GROUP = { period: '2026-06', state: 'APPROVED', record_count: 1, total_amount: '5.0000' };

/** Fixture datetime text of `date` in the process zone, as envelope.cfc's `yyyy-mm-dd'T'HH:nn:ss` mask renders it. */
function fixtureStamp(date: Date): string {
  return `${asOf(date)}T${date.toTimeString().slice(0, 8)}`;
}

/** Code-unit order of two ASCII texts, as Latin1_General_BIN2 orders them. */
function binary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Four-decimal text of an amount scaled by 10^4. */
function fourDecimals(scaled: bigint): string {
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(5, '0');
  return `${scaled < 0n ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** Reference `usp_finance_rollup` output: count and bigint-exact total per period and state, in binary order, stamped `computedAt`. */
function referenceRollups(records: readonly Amounted[], computedAt: string): FixtureRollup[] {
  const groups = new Map<string, { period: string; state: string; count: number; scaled: bigint }>();
  for (const [period, state, amount] of records) {
    const key = `${period}|${state}`;
    const group = groups.get(key) ?? { period, state, count: 0, scaled: 0n };
    group.count += 1;
    group.scaled += BigInt(amount.replace('.', ''));
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => binary(a.period, b.period) || binary(a.state, b.state))
    .map(({ period, state, count, scaled }) => ({ period, state, record_count: count, total_amount: fourDecimals(scaled), computed_at: computedAt }));
}

const STAMP = fixtureStamp(TEST_CLOCK.now());
const EXPECTED = referenceRollups([...TENANT_A_RECORDS, WRITTEN], STAMP);
/** When the stored groups were last rebuilt, a day before the clock. */
const EARLIER = new Date(TEST_CLOCK.now().getTime() - 86_400_000);

/** A fixture list page of rollup rows, as envelope.cfc `listResponse` renders it. */
type FixturePage = {
  method: string;
  data: { items: FixtureRollup[]; startindex: number; endindex: number; itemsperpage: number; totalitems: number; totalpages: number; pageindex: number };
};

/** A `/v1` rollup list. */
type V1List = { data: FixtureRollup[] };

/** The parsed JSON body of `res`. */
function bodyOf<T = FixturePage>(res: InjectResponse): T {
  return JSON.parse(res.body) as T;
}

/** Validates `res` against the contract operation of `path`. */
function assertContract(res: InjectResponse, path: string): void {
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
}

let t: TestApp;

beforeEach(async () => {
  t = await buildTestApp();
  t.db.seed('record', [
    ...TENANT_A_RECORDS.map(([period, state, amount]) => recordRow({ period, state, amount })),
    recordRow({ period: TENANT_B_RECORD[0], state: TENANT_B_RECORD[1], amount: TENANT_B_RECORD[2], siteid: TENANT_B.siteId }),
  ]);
});

afterEach(async () => {
  await t?.app.close();
});

/** Stores tenant-a's STALE_GROUP and tenant-b's TENANT_B_GROUP as committed rollup rows rebuilt at EARLIER. */
function seedStoredGroups(): void {
  t.db.seed('rollup', [
    { ...STALE_GROUP, tenant_id: TENANT_A.tenantId, computed_at: EARLIER, legacy_program_id: programBindingRow(TENANT_A.siteId).legacy_program_id },
    { ...TENANT_B_GROUP, tenant_id: TENANT_B.tenantId, computed_at: EARLIER, legacy_program_id: programBindingRow(TENANT_B.siteId).legacy_program_id },
  ]);
}

/** Creates the WRITTEN record through the fixture as a tenant-a preparer, which rebuilds the program rollup in the write's transaction. */
async function writeRecord(): Promise<InjectResponse> {
  const [period, , amount] = WRITTEN;
  t.db.clear();
  const res = await t.app.inject({
    method: 'POST',
    url: `${FIXTURE_PREFIX}/records`,
    headers: { ...(await headersFor('finance.preparer', { site: TENANT_A.siteId })), 'content-type': 'application/json' },
    payload: { title: 'Rollup trigger', amount, period },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

/** A tenant read of `url` by `subject`. */
async function read(url: string, subject = 'finance.approver', site = TENANT_A.siteId): Promise<InjectResponse> {
  return t.app.inject({ method: 'GET', url, headers: await headersFor(subject, { site, csrf: false }) });
}

describe('rebuild at a fixture write', () => {
  it('totals each period and state exactly as a bigint reference sum, one row per present group', async () => {
    seedStoredGroups();
    await writeRecord();
    const stored = await t.db.withTenant(TENANT_A.tenantId, (tx) => getRollups(tx, { paging: ALL_ROWS }));
    expect(stored.total).toBe(EXPECTED.length);
    expect(
      stored.rows.map((row) => ({
        period: row.period,
        state: row.state,
        record_count: row.record_count,
        total_amount: row.total_amount,
        computed_at: fixtureStamp(row.computed_at),
      })),
    ).toEqual(EXPECTED);
    expect(stored.rows.every((row) => row.computed_at.getTime() === TEST_CLOCK.now().getTime())).toBe(true);
    expect(stored.rows.every((row) => row.legacy_program_id === programBindingRow(TENANT_A.siteId).legacy_program_id)).toBe(true);
  });

  it('replaces the tenant rollup rows with one changelog row each, all in the write transaction', async () => {
    seedStoredGroups();
    const res = await writeRecord();
    const writes = t.db.writes();
    const rollupOps = writes.filter((write) => write.table === 'finance.rollup').map((write) => [write.op, write.row.period, write.row.state]);
    expect(rollupOps).toEqual([['delete', STALE_GROUP.period, STALE_GROUP.state], ...EXPECTED.map((row) => ['insert', row.period, row.state])]);
    const changelog = writes.filter((write) => write.table === 'finance.changelog').map((write) => write.row);
    expect(changelog.filter((row) => row.table === 'rollup').map((row) => row.op)).toEqual(rollupOps.map(([op]) => op));
    const xids = new Set(changelog.map((row) => String(row.xid)));
    expect([...xids]).toEqual([t.db.lastXid()]);
    expect(res.headers['x-opt2-write-position']).toBe(`finance=${t.db.lastXid()}`);
    expect(writes.every((write) => write.tenantId === TENANT_A.tenantId)).toBe(true);
    expect(t.db.rows('rollup', TENANT_B.tenantId).map((row) => [row.period, row.state, row.record_count, row.total_amount])).toEqual([
      [TENANT_B_GROUP.period, TENANT_B_GROUP.state, TENANT_B_GROUP.record_count, TENANT_B_GROUP.total_amount],
    ]);
  });
});

describe('fixture read', () => {
  it.each([
    ['every row', ALL_ROWS],
    ['a middle page', { pageIndex: 2, itemsPerPage: 4 }],
    ['a page past the end', { pageIndex: 5, itemsPerPage: 4 }],
  ])('answers %s in binary period and state order with the catalog field order and four-decimal totals', async (_case, { pageIndex, itemsPerPage }) => {
    await writeRecord();
    const res = await read(`${FIXTURE_ROLLUPS}?pageIndex=${pageIndex}&itemsPerPage=${itemsPerPage}`);
    expect(res.statusCode, res.body).toBe(200);
    assertContract(res, FIXTURE_ROLLUPS);
    const { method, data } = bodyOf(res);
    const start = (pageIndex - 1) * itemsPerPage;
    expect(method).toBe('finance.rollups');
    expect(data).toMatchObject({ totalitems: EXPECTED.length, itemsperpage: itemsPerPage, pageindex: pageIndex, startindex: start + 1 });
    expect(data.items).toEqual(EXPECTED.slice(start, start + itemsPerPage));
    for (const item of data.items) {
      expect(Object.keys(item)).toEqual(FIELD_ORDER);
      expect(item.total_amount).toMatch(/^-?\d+\.\d{4}$/);
      expect(Number.isInteger(item.record_count)).toBe(true);
    }
  });

  it("answers only the caller tenant's rows", async () => {
    seedStoredGroups();
    await writeRecord();
    const tenantA = await read(`${FIXTURE_ROLLUPS}?itemsPerPage=1000`);
    expect(bodyOf(tenantA).data.items).toEqual(EXPECTED);
    const tenantB = await read(`${FIXTURE_ROLLUPS}?itemsPerPage=1000`, 'finance.approver', TENANT_B.siteId);
    expect(tenantB.statusCode, tenantB.body).toBe(200);
    expect(bodyOf(tenantB).data.items).toEqual([{ ...TENANT_B_GROUP, computed_at: fixtureStamp(EARLIER) }]);
  });

  it('answers an empty page while the program holds records but no rollup rows, rebuilding nothing on read', async () => {
    t.db.clear();
    const fixture = await read(`${FIXTURE_ROLLUPS}?itemsPerPage=1000`, 'finance.preparer');
    expect(fixture.statusCode, fixture.body).toBe(200);
    assertContract(fixture, FIXTURE_ROLLUPS);
    expect(bodyOf(fixture).data).toMatchObject({ items: [], totalitems: 0, totalpages: 0 });
    const v1 = await read(V1_ROLLUPS, 'finance.preparer');
    expect(bodyOf<V1List>(v1)).toEqual({ data: [] });
    expect(t.db.writes()).toEqual([]);
    expect(t.db.rows('rollup')).toEqual([]);
  });
});

describe('/v1 read', () => {
  // Rollups are rebuilt only at record writes, as finance.cfc refreshRollup does, so asOf never restamps the stored rows.
  it.each([
    ['no asOf', ''],
    ['the business date', `?asOf=${BUSINESS_DATE}`],
    ['a later date', '?asOf=2027-01-31'],
  ])('answers the rebuild instant as computed_at with %s, writing nothing', async (_case, query) => {
    await writeRecord();
    t.db.clear();
    const res = await read(`${V1_ROLLUPS}${query}`);
    expect(res.statusCode, res.body).toBe(200);
    assertContract(res, V1_ROLLUPS);
    expect(bodyOf<V1List>(res)).toEqual({ data: EXPECTED });
    expect(t.db.writes()).toEqual([]);
  });
});
