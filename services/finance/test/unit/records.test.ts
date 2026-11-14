// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Record create and reads against usp_finance_create and finance.cfc `finance/records[/{id}[/versions]]`, over the recording db. */
import { afterEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import {
  FinanceDomainError,
  createRecord,
  getRecord,
  listRecords,
  listVersions,
  type FinanceActor,
  type FinanceDomainDeps,
  type RecordInput,
} from '../../src/domain/records.js';
import { requireProgram, validateRecordInput, type RecordField } from '../../src/legacy/checks.js';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/envelope.js';
import { findRecord, listRecords as queryRecords, listVersions as queryVersions } from '../../src/repo/queries.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import type { FinanceRecordRow, FinanceRecordVersionRow } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, headersFor, type RecordedWrite, type RecordingDb, type RecordingSeed, type TestApp } from '../helpers/app.js';
import { PROGRAM_FOR_SITE, programBindingRow, recordRow, versionRow } from '../helpers/records.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;

const RECORDS = '/legacy-fixtures/cfml/api.cfm/finance/records';
const PREPARER = { roles: ['finance.preparer'] } as const;
const PREPARER_ID = '11111111-2222-3333-4444555566667777';
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const VALID = { title: 'Q2 travel', amount: '1250.5', period: '2026-06' } as const;
const SITES = ['tenant-a', 'tenant-b'] as const;
const TENANT_A_ID = tenantIdForSite('tenant-a');
const TENANT_B_ID = tenantIdForSite('tenant-b');
const BOUND: RecordingSeed = { program_binding: [programBindingRow('tenant-a'), programBindingRow('tenant-b')] };
const ONLY_B_BOUND: RecordingSeed = { program_binding: [programBindingRow('tenant-b')] };
// envelope.cfc errorMap messages of the types the record paths raise.
const INVALID_PARAMETERS = 'Invalid parameters';
const NOT_FOUND = 'Not Found';
const FORBIDDEN = 'Insufficient Account Permissions';

/** A fixture CF id ending in `n`. */
const recordId = (n: number): string => `A0000000-0000-0000-${String(n).padStart(16, '0')}`;

/** tenant-a records seeded out of list order, each `[n, days before the business date]`. */
const LISTED: readonly FinanceRecordRow[] = (
  [
    [1, 0],
    [2, 2],
    [3, 1],
    [4, 2],
    [5, 3],
  ] as const
).map(([n, days]) => ({ ...recordRow({ id: recordId(n), title: `Record ${n}` }), created: new Date(2026, 5, 30 - days, 12, 0, 0) }));
/** finance.cfc `ORDER BY created, record_id` of LISTED. */
const LIST_ORDER = [5, 2, 4, 3, 1].map(recordId);
const OTHER_TENANT = recordRow({ id: recordId(9), siteid: 'tenant-b', title: 'Tenant B record' });
const LIST_SEED: RecordingSeed = { ...BOUND, record: [...LISTED, OTHER_TENANT] };

const VERSIONED = recordRow({ id: recordId(7), state: 'REJECTED', version: 3, title: 'Versioned' });
/** VERSIONED's version rows, seeded out of version order. */
const VERSIONS: readonly FinanceRecordVersionRow[] = [
  versionRow(VERSIONED, { action: 'reject', version: 3 }),
  versionRow(VERSIONED, { action: 'create', version: 1 }),
  versionRow(VERSIONED, { action: 'submit', version: 2 }),
];
const VERSION_SEED: RecordingSeed = { ...BOUND, record: [VERSIONED], record_version: VERSIONS };

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((t) => t.app.close()));
});

/** A finance test app over a recording db seeded with `seed`, closed after the test. */
async function open(seed: RecordingSeed = BOUND): Promise<TestApp> {
  const t = await buildTestApp({ seed });
  apps.push(t);
  return t;
}

/** Headers of a finance preparer whose token names `site`. */
function preparer(site: string = 'tenant-a'): Promise<Record<string, string>> {
  return headersFor(PREPARER, { site, sub: PREPARER_ID });
}

/** A JSON-body create as a preparer of `site`. */
async function post(t: TestApp, payload: Readonly<Record<string, unknown>>, site?: string): Promise<Injected> {
  return t.app.inject({ method: 'POST', url: RECORDS, headers: await preparer(site), payload: { ...payload } });
}

/** A GET of `RECORDS + path` as a preparer of `site`. */
async function get(t: TestApp, path: string, site?: string): Promise<Injected> {
  return t.app.inject({ url: `${RECORDS}${path}`, headers: await preparer(site) });
}

/** The fixture error envelope of `method` with the invalid_request code. */
function errorBody(method: string, message: string): Record<string, unknown> {
  return { apiversion: 'v1', method, error: { code: 'invalid_request', message } };
}

/** `<op> <bare table>` of each write that is not a changelog row. */
function dataWriteKeys(writes: readonly RecordedWrite[]): string[] {
  return writes.filter((w) => w.table !== 'finance.changelog').map((w) => `${w.op} ${w.table.replace(/^finance\./, '')}`);
}

/** The changelog rows among `writes`. */
function changelogRows(writes: readonly RecordedWrite[]): Readonly<Record<string, unknown>>[] {
  return writes.filter((w) => w.table === 'finance.changelog').map((w) => w.row);
}

/** Domain collaborators over `t`'s recording db, storage and clock. */
function domainDeps(t: TestApp): FinanceDomainDeps {
  return { repository: createFinanceRepository({ db: t.db, stagingDb: t.db.handle(), storage: t.storage, clock: t.clock }), storage: t.storage, clock: t.clock };
}

describe('envelope.cfc errorMap rows of the record paths', () => {
  it('maps invalidParameters to 400 and notFound to 404 with their fixture messages', () => {
    expect(FIXTURE_ERROR_MAP.invalidParameters).toEqual({ status: 400, code: 'invalid_request', message: INVALID_PARAMETERS });
    expect(FIXTURE_ERROR_MAP.notFound).toEqual({ status: 404, code: 'invalid_request', message: NOT_FOUND });
  });
});

describe('POST finance/records', () => {
  it.each(SITES)('creates an IN-PROGRESS record at version 1 with one create version row for %s', async (site) => {
    const t = await open();
    const tenantId = tenantIdForSite(site);
    const res = await post(t, VALID, site);
    expect(res.statusCode).toBe(200);
    const id: string = res.json().data.record_id;
    expect([isCfUuid(id), id.length]).toEqual([true, 35]);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'finance.records',
      data: {
        record_id: id,
        siteid: site,
        title: 'Q2 travel',
        amount: '1250.5000',
        period: '2026-06',
        state: 'IN-PROGRESS',
        version: 1,
        created: '2026-06-30T12:00:00',
        createdbyid: PREPARER_ID,
        lastupdate: '',
        lastupdatebyid: '',
      },
    });

    const writes = t.db.writes();
    const records = writes.filter((w) => w.table === 'finance.record');
    const versions = writes.filter((w) => w.table === 'finance.record_version');
    expect(records.map((w) => w.op)).toEqual(['insert']);
    expect(versions.map((w) => w.op)).toEqual(['insert']);
    expect(records[0]?.row).toMatchObject({
      tenant_id: tenantId,
      record_id: id,
      siteid: site,
      title: 'Q2 travel',
      amount: '1250.5000',
      period: '2026-06',
      state: 'IN-PROGRESS',
      version: 1,
      created: TEST_CLOCK.now(),
      createdbyid: PREPARER_ID,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: PROGRAM_FOR_SITE[site],
    });
    const versionId = String(versions[0]?.row.version_id);
    expect([isCfUuid(versionId), versionId.length]).toEqual([true, 35]);
    expect(versions[0]?.row).toMatchObject({
      tenant_id: tenantId,
      record_id: id,
      version: 1,
      state: 'IN-PROGRESS',
      title: 'Q2 travel',
      amount: '1250.5000',
      period: '2026-06',
      action: 'create',
      actor_user_id: PREPARER_ID,
      created: TEST_CLOCK.now(),
      legacy_program_id: PROGRAM_FOR_SITE[site],
    });

    const changelog = changelogRows(writes);
    expect(changelog.map((row) => `${String(row.op)} ${String(row.table)}`)).toEqual(dataWriteKeys(writes));
    expect(new Set(changelog.map((row) => row.xid)).size).toBe(1);
    for (const row of changelog) expect(row).toMatchObject({ origin: 'target', actor_user_id: PREPARER_ID, at: TEST_CLOCK.now() });
    expect(writes.every((w) => w.tenantId === tenantId)).toBe(true);
    expect(t.csrf.calls.map((call) => call.context)).toEqual(['']);
  });

  it.each<[string, Record<string, string>, string, string]>([
    ['a 255-character title', { ...VALID, title: 'T'.repeat(255) }, 'T'.repeat(255), '1250.5000'],
    ['a negative amount with four decimals', { ...VALID, amount: '-12.3456' }, 'Q2 travel', '-12.3456'],
    ['an amount padded with spaces', { ...VALID, amount: ' 42 ' }, 'Q2 travel', '42.0000'],
    ['an amount of fifteen integer digits', { ...VALID, amount: '999999999999999' }, 'Q2 travel', '999999999999999.0000'],
  ])('accepts %s, storing the amount as four-decimal numeric(19,4) text', async (_case, payload, title, amount) => {
    const t = await open();
    const res = await post(t, payload);
    expect([res.statusCode, res.json().data.title, res.json().data.amount]).toEqual([200, title, amount]);
    expect(t.db.rows('record', TENANT_A_ID).map((row) => [row.title, row.amount])).toEqual([[title, amount]]);
  });
});

describe('finance/records without a program binding', () => {
  it.each<[string, (t: TestApp) => Promise<Injected>, string]>([
    ['a create', (t) => post(t, VALID), 'finance.records'],
    ['the record list', (t) => get(t, ''), 'finance.records'],
    ['a record', (t) => get(t, `/${MISSING_ID}`), 'finance.records'],
    ['a version list', (t) => get(t, `/${MISSING_ID}/versions`), 'finance.records.versions'],
  ])('answers invalidParameters for %s when the tenant has no program binding, writing nothing', async (_case, send, method) => {
    const t = await open(ONLY_B_BOUND);
    const res = await send(t);
    expect([res.statusCode, res.json()]).toEqual([400, errorBody(method, INVALID_PARAMETERS)]);
    expect(t.db.writes()).toEqual([]);
  });

  it('still creates for a bound tenant beside an unbound one', async () => {
    const t = await open(ONLY_B_BOUND);
    expect((await post(t, VALID)).statusCode).toBe(400);
    const res = await post(t, VALID, 'tenant-b');
    expect(res.statusCode).toBe(200);
    expect(t.db.rows('record').map((row) => [row.tenant_id, row.legacy_program_id])).toEqual([[TENANT_B_ID, 2]]);
  });
});

describe('POST finance/records validation', () => {
  it.each<[string, Readonly<Record<string, unknown>>, RecordField]>([
    ['a missing title', { amount: '1250.5', period: '2026-06' }, 'title'],
    ['a blank title', { ...VALID, title: ' \t ' }, 'title'],
    ['a title over 255 characters', { ...VALID, title: 'T'.repeat(256) }, 'title'],
    ['a missing amount', { title: 'Q2 travel', period: '2026-06' }, 'amount'],
    ['a non-numeric amount', { ...VALID, amount: 'twelve' }, 'amount'],
    ['an amount with five decimals', { ...VALID, amount: '1.23456' }, 'amount'],
    ['an amount in exponent form', { ...VALID, amount: '1e3' }, 'amount'],
    ['an amount of sixteen integer digits', { ...VALID, amount: '1234567890123456' }, 'amount'],
    ['a missing period', { title: 'Q2 travel', amount: '1250.5' }, 'period'],
    ['a thirteenth month', { ...VALID, period: '2026-13' }, 'period'],
    ['a one-digit month', { ...VALID, period: '2026-6' }, 'period'],
  ])('answers invalidParameters for %s, writing nothing', async (_case, payload, field) => {
    const validation = validateRecordInput(payload, 'create');
    expect(validation).toEqual({ ok: false, type: 'invalidParameters', message: INVALID_PARAMETERS, field });
    const t = await open();
    const res = await post(t, payload);
    expect([res.statusCode, res.json()]).toEqual([400, errorBody('finance.records', INVALID_PARAMETERS)]);
    expect(res.json().error.message).toBe((validation as Extract<typeof validation, { ok: false }>).message);
    expect(t.db.writes()).toEqual([]);
    expect(t.db.rows('record')).toEqual([]);
  });
});

describe('GET finance/records', () => {
  it.each<[string, string, string[], Record<string, number>]>([
    ['the default page', '', LIST_ORDER, { startindex: 1, endindex: 5, itemsperpage: 50, totalitems: 5, totalpages: 1, pageindex: 1 }],
    ['page 2 of size 2', '?pageIndex=2&itemsPerPage=2', LIST_ORDER.slice(2, 4), { startindex: 3, endindex: 4, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 2 }],
    ['the short last page', '?pageIndex=3&itemsPerPage=2', LIST_ORDER.slice(4), { startindex: 5, endindex: 5, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 3 }],
    ['a page past the end', '?pageIndex=4&itemsPerPage=2', [], { startindex: 7, endindex: 5, itemsperpage: 2, totalitems: 5, totalpages: 3, pageindex: 4 }],
  ])('lists %s of the tenant records by created, then id, with the fixture paging fields', async (_case, query, ids, paging) => {
    const t = await open(LIST_SEED);
    const res = await get(t, query);
    expect([res.statusCode, res.json().method]).toEqual([200, 'finance.records']);
    const { items, ...fields } = res.json().data as { items: { record_id: string }[] } & Record<string, number>;
    expect(items.map((item) => item.record_id)).toEqual(ids);
    expect(fields).toEqual(paging);
  });

  it('returns one record in its fixture row shape', async () => {
    const t = await open(LIST_SEED);
    const row = LISTED[2] as FinanceRecordRow;
    const res = await get(t, `/${row.record_id}`);
    expect([res.statusCode, res.json()]).toEqual([
      200,
      {
        apiversion: 'v1',
        method: 'finance.records',
        data: {
          record_id: recordId(3),
          siteid: 'tenant-a',
          title: 'Record 3',
          amount: '100.0000',
          period: '2026-06',
          state: 'IN-PROGRESS',
          version: 1,
          created: '2026-06-29T12:00:00',
          createdbyid: row.createdbyid,
          lastupdate: '',
          lastupdatebyid: '',
        },
      },
    ]);
  });

  it.each<[string, string, string]>([
    ['an unknown record', `/${MISSING_ID}`, 'finance.records'],
    ['the versions of an unknown record', `/${MISSING_ID}/versions`, 'finance.records.versions'],
  ])('answers notFound for %s', async (_case, path, method) => {
    const t = await open(LIST_SEED);
    const res = await get(t, path);
    expect([res.statusCode, res.json()]).toEqual([404, errorBody(method, NOT_FOUND)]);
  });

  it('lists a record version rows by version number with the fixture paging fields', async () => {
    const t = await open(VERSION_SEED);
    const fixtureVersion = (row: FinanceRecordVersionRow): Record<string, unknown> => ({
      version_id: row.version_id,
      record_id: row.record_id,
      version: row.version,
      state: 'REJECTED',
      title: 'Versioned',
      amount: '100.0000',
      period: '2026-06',
      action: row.action,
      actor_user_id: row.actor_user_id,
      created: '2026-06-30T12:00:00',
    });
    const ordered = [...VERSIONS].sort((a, b) => a.version - b.version);
    const all = await get(t, `/${VERSIONED.record_id}/versions`);
    expect([all.statusCode, all.json().method]).toEqual([200, 'finance.records.versions']);
    expect(all.json().data).toEqual({
      items: ordered.map(fixtureVersion),
      startindex: 1,
      endindex: 3,
      itemsperpage: 50,
      totalitems: 3,
      totalpages: 1,
      pageindex: 1,
    });
    expect(ordered.map((row) => [row.version, row.action])).toEqual([
      [1, 'create'],
      [2, 'submit'],
      [3, 'reject'],
    ]);
    const page = await get(t, `/${VERSIONED.record_id}/versions?pageIndex=2&itemsPerPage=2`);
    expect(page.json().data).toEqual({
      items: ordered.slice(2).map(fixtureVersion),
      startindex: 3,
      endindex: 3,
      itemsperpage: 2,
      totalitems: 3,
      totalpages: 2,
      pageindex: 2,
    });
  });
});

describe('finance/records tenant isolation', () => {
  it('reads only the token tenant: a tenant-b record is absent from tenant-a lists and reads', async () => {
    const t = await open(LIST_SEED);
    const list = await get(t, '?itemsPerPage=1000');
    expect(list.json().data.items.map((item: { record_id: string }) => item.record_id)).toEqual(LIST_ORDER);
    expect(t.db.queries().filter((q) => /FROM "finance"\."record"/.test(q.sql)).map((q) => q.tenantId)).toEqual([TENANT_A_ID, TENANT_A_ID]);
    for (const [path, method] of [
      [`/${OTHER_TENANT.record_id}`, 'finance.records'],
      [`/${OTHER_TENANT.record_id}/versions`, 'finance.records.versions'],
    ] as const) {
      const res = await get(t, path);
      expect([res.statusCode, res.json()]).toEqual([404, errorBody(method, NOT_FOUND)]);
    }
    const asB = await get(t, `/${OTHER_TENANT.record_id}`, 'tenant-b');
    expect([asB.statusCode, asB.json().data.title]).toEqual([200, 'Tenant B record']);
  });

  it('refuses a siteid naming another site than the token, reading no record', async () => {
    const t = await open(LIST_SEED);
    const res = await get(t, '?siteid=tenant-b');
    expect([res.statusCode, res.json()]).toEqual([403, errorBody('finance.records', FORBIDDEN)]);
    expect(t.db.queries().some((q) => /"finance"\."record"/.test(q.sql))).toBe(false);
  });
});

/** Record and version reads `fn` issues in one `tenantId` transaction of `db`, as `[sql, params, tenant]`. */
async function readsOf<T>(db: RecordingDb, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<{ result: T; reads: unknown[][] }> {
  db.clear();
  const result = await db.withTenant(tenantId, fn);
  const reads = db
    .queries()
    .filter((q) => /FROM "finance"\."record(?:_version)?"/.test(q.sql))
    .map((q) => [q.sql, q.params, q.tenantId]);
  return { result, reads };
}

describe('record domain reads', () => {
  it('getRecord reads the tenant record through repo/queries findRecord in schema finance', async () => {
    const db = createRecordingDb({ ...LIST_SEED });
    const domain = await readsOf(db, TENANT_A_ID, (tx) => getRecord(tx, recordId(3)));
    expect(domain.result).toEqual(LISTED[2]);
    expect(domain.reads).toEqual((await readsOf(db, TENANT_A_ID, (tx) => findRecord(tx, recordId(3)))).reads);
    expect(domain.reads).toEqual([[expect.stringMatching(/^SELECT .* FROM "finance"\."record" WHERE "record_id" = \$1$/), [recordId(3)], TENANT_A_ID]]);
  });

  it('listRecords reads the count, then one page, through repo/queries listRecords in schema finance', async () => {
    const db = createRecordingDb({ ...LIST_SEED });
    const paging = { pageIndex: 2, itemsPerPage: 2 };
    const domain = await readsOf(db, TENANT_A_ID, (tx) => listRecords(tx, paging));
    expect(domain.result.total).toBe(5);
    expect(domain.result.rows.map((row) => row.record_id)).toEqual(LIST_ORDER.slice(2, 4));
    expect(domain.reads).toEqual((await readsOf(db, TENANT_A_ID, (tx) => queryRecords(tx, paging))).reads);
    expect(domain.reads).toEqual([
      [expect.stringMatching(/^SELECT count\(\*\)::integer AS "total" FROM "finance"\."record"$/), [], TENANT_A_ID],
      [expect.stringMatching(/ FROM "finance"\."record" ORDER BY "created", "record_id" COLLATE "C" LIMIT \$1 OFFSET \$2$/), [2, 2], TENANT_A_ID],
    ]);
  });

  it('listVersions checks the record, then reads its versions by version number through repo/queries', async () => {
    const db = createRecordingDb({ ...VERSION_SEED });
    const paging = { pageIndex: 1, itemsPerPage: 1000 };
    const domain = await readsOf(db, TENANT_A_ID, (tx) => listVersions(tx, VERSIONED.record_id, paging));
    expect(domain.result).toEqual({ rows: [...VERSIONS].sort((a, b) => a.version - b.version), total: 3 });
    const viaQueries = await readsOf(db, TENANT_A_ID, async (tx) => {
      await findRecord(tx, VERSIONED.record_id);
      return queryVersions(tx, VERSIONED.record_id, paging);
    });
    expect(domain.reads).toEqual(viaQueries.reads);
    expect(domain.reads.map(([sql]) => /"finance"\."record(?:_version)?"/.test(String(sql)))).toEqual([true, true, true]);
  });

  it.each<[string, string, string]>([
    ['an unknown id', TENANT_A_ID, MISSING_ID],
    ['a record of another tenant', TENANT_A_ID, OTHER_TENANT.record_id],
    ['a tenant-a record read in a tenant-b transaction', TENANT_B_ID, recordId(3)],
  ])('throws notFound for %s', async (_case, tenantId, id) => {
    const db = createRecordingDb({ ...LIST_SEED });
    await expect(db.withTenant(tenantId, (tx) => getRecord(tx, id))).rejects.toMatchObject({ name: 'FinanceDomainError', type: 'notFound', message: NOT_FOUND });
    await expect(db.withTenant(tenantId, (tx) => listVersions(tx, id, { pageIndex: 1, itemsPerPage: 50 }))).rejects.toBeInstanceOf(FinanceDomainError);
  });
});

describe('record domain create', () => {
  const input: RecordInput = { title: 'Q2 travel', amount: 12_505_000n, period: '2026-06' };
  const actor: FinanceActor = { userId: PREPARER_ID, siteId: 'tenant-a' };

  it('returns the written record and its create version row, with CF ids and the injected clock', async () => {
    const t = await open();
    const { record, version } = await t.db.withTenant(TENANT_A_ID, (tx) => createRecord(tx, domainDeps(t), input, actor));
    expect(record).toMatchObject({
      tenant_id: TENANT_A_ID,
      siteid: 'tenant-a',
      title: 'Q2 travel',
      amount: '1250.5000',
      period: '2026-06',
      state: 'IN-PROGRESS',
      version: 1,
      created: TEST_CLOCK.now(),
      createdbyid: PREPARER_ID,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: PROGRAM_FOR_SITE['tenant-a'],
    });
    expect(version).toMatchObject({
      tenant_id: TENANT_A_ID,
      record_id: record.record_id,
      version: 1,
      state: 'IN-PROGRESS',
      amount: '1250.5000',
      action: 'create',
      actor_user_id: PREPARER_ID,
      created: TEST_CLOCK.now(),
      legacy_program_id: PROGRAM_FOR_SITE['tenant-a'],
    });
    for (const id of [record.record_id, version.version_id]) expect([isCfUuid(id), id.length]).toEqual([true, 35]);
    const writes = t.db.writes();
    expect(dataWriteKeys(writes)).toEqual(['insert record', 'insert record_version']);
    expect(changelogRows(writes).map((row) => `${String(row.op)} ${String(row.table)}`)).toEqual(['insert record', 'insert record_version']);
    expect(t.db.rows('record', TENANT_A_ID)).toEqual([record]);
  });

  it('throws invalidParameters without a program binding, before any write', async () => {
    const t = await open(ONLY_B_BOUND);
    await expect(t.db.withTenant(TENANT_A_ID, (tx) => createRecord(tx, domainDeps(t), input, actor))).rejects.toMatchObject({
      name: 'FinanceDomainError',
      type: 'invalidParameters',
      message: INVALID_PARAMETERS,
    });
    await expect(t.db.withTenant(TENANT_A_ID, (tx) => requireProgram(tx, TENANT_A_ID))).rejects.toMatchObject({ type: 'invalidParameters' });
    expect(t.db.writes()).toEqual([]);
  });
});
