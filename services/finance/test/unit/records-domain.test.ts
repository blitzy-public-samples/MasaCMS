// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance record domain against a throwaway `finance` schema: create, transitions and edits with their version and changelog rows. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { TransitionRejectedError } from '@opt2/platform/state-machine';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import type { StoragePort } from '@opt2/platform/storage';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type { FinanceAction } from '../../src/domain/lifecycle.transitions.js';
import {
  FinanceDomainError,
  createRecord,
  getRecord,
  listRecords,
  listVersions,
  transitionRecord,
  type FinanceActor,
  type FinanceDomainDeps,
  type RecordInput,
} from '../../src/domain/records.js';
import { createFinanceRepository } from '../../src/repo/repository.js';
import { UNITS, type FinanceRecordRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const PREPARER = ['finance.preparer'];
const APPROVER = ['finance.approver'];
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const SITE_A = 'records-a';
const SITE_B = 'records-b';
const ACTOR_A: FinanceActor = { userId: '11111111-2222-3333-4444555566667777', siteId: SITE_A };
const ACTOR_B: FinanceActor = { userId: '22222222-2222-3333-4444555566667777', siteId: SITE_B };
const TRAVEL: RecordInput = { title: 'Travel', amount: 125050000n, period: '2026-06' };
// 999999999999999.9999, the largest numeric(19,4) value.
const MAX = 9_999_999_999_999_999_999n;

type Step = readonly [action: FinanceAction, roles: readonly string[], to: string];

/** Storage port the record paths never touch. */
function unusedStorage(): StoragePort {
  const unused = (): never => {
    throw new Error('not used by the record domain');
  };
  return { kind: 'local', put: unused, get: unused, stream: unused, open: unused, delete: unused, head: unused, signedUrl: unused };
}

describe('FinanceDomainError', () => {
  it.each([
    ['notFound', 'Not Found'],
    ['invalidParameters', 'Invalid parameters'],
  ] as const)('%s carries the fixture message %s', (type, message) => {
    const error = new FinanceDomainError(type);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'FinanceDomainError', type, message });
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('finance record domain against PostgreSQL', () => {
  const tenantA = tenantIdForSite(SITE_A);
  const tenantB = tenantIdForSite(SITE_B);
  let handle: ThrowawaySchema;
  let deps: FinanceDomainDeps;

  /** Binds `tenantId` to `Program_<programId>`, as a migration apply does. */
  async function bind(tenantId: string, siteId: string, programId: number): Promise<void> {
    await handle.app.withTenant(tenantId, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.program_binding (tenant_id, site_id, legacy_program_id, updated_at) VALUES ($1, $2, $3, $4)`, [
        tenantId,
        siteId,
        programId,
        NOW,
      ]),
    );
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'finance',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await bind(tenantA, SITE_A, 1);
    await bind(tenantB, SITE_B, 2);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    const storage = unusedStorage();
    const clock = fixedClock(NOW);
    deps = { repository: createFinanceRepository({ db: handle.app, storage, clock }), storage, clock };
  });

  /** Moves every finance gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: UNITS, holderId: 'records-domain-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'records-domain-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantA): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  /** `<op> <table> <actor>` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<string[]> {
    const { rows } = await tx.query<{ op: string; table: string; actor_user_id: string }>(
      `SELECT op, "table", actor_user_id FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows.map((row) => `${row.op} ${row.table} ${row.actor_user_id}`);
  }

  async function count(table: string, tenant = tenantA): Promise<number> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.${table}`);
      return (rows[0] as { n: number }).n;
    }, tenant);
  }

  function create(input: RecordInput = TRAVEL) {
    return inTenant((tx) => createRecord(tx, deps, input, ACTOR_A));
  }

  function transition(id: string, action: FinanceAction, roles: readonly string[], input?: Partial<RecordInput>) {
    return inTenant((tx) => transitionRecord(tx, deps, { id, action, roles, ...(input === undefined ? {} : { input }) }, ACTOR_A));
  }

  it('creates an IN-PROGRESS record at version 1 with one create version row in the same transaction', async () => {
    const { record, version } = await inTenant(async (tx) => {
      const result = await createRecord(tx, deps, TRAVEL, ACTOR_A);
      expect(await written(tx)).toEqual([`insert record ${ACTOR_A.userId}`, `insert record_version ${ACTOR_A.userId}`]);
      return result;
    });
    expect(record).toMatchObject({
      tenant_id: tenantA,
      siteid: SITE_A,
      title: 'Travel',
      amount: '12505.0000',
      period: '2026-06',
      state: 'IN-PROGRESS',
      version: 1,
      createdbyid: ACTOR_A.userId,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: 1,
      row_version: '1',
    });
    expect(version).toMatchObject({
      tenant_id: tenantA,
      record_id: record.record_id,
      version: 1,
      state: 'IN-PROGRESS',
      title: 'Travel',
      amount: '12505.0000',
      period: '2026-06',
      action: 'create',
      actor_user_id: ACTOR_A.userId,
      legacy_program_id: 1,
    });
    expect([record.created.getTime(), version.created.getTime()]).toEqual([NOW.getTime(), NOW.getTime()]);
    expect([isCfUuid(record.record_id), isCfUuid(version.version_id)]).toEqual([true, true]);
    expect(version.version_id).not.toBe(record.record_id);
  });

  it('takes legacy_program_id from the tenant binding and the site from the actor', async () => {
    const { record, version } = await inTenant((tx) => createRecord(tx, deps, TRAVEL, ACTOR_B), tenantB);
    expect(record).toMatchObject({ tenant_id: tenantB, siteid: SITE_B, legacy_program_id: 2 });
    expect(version.legacy_program_id).toBe(2);
  });

  it('answers invalidParameters when the tenant has no program binding and writes nothing', async () => {
    const unbound = tenantIdForSite('records-unbound');
    await expect(inTenant((tx) => createRecord(tx, deps, TRAVEL, ACTOR_A), unbound)).rejects.toMatchObject({
      name: 'FinanceDomainError',
      type: 'invalidParameters',
      message: 'Invalid parameters',
    });
    expect([await count('record', unbound), await count('changelog', unbound)]).toEqual([0, 0]);
  });

  it.each<[string, readonly Step[]]>([
    ['submit then approve', [['submit', PREPARER, 'SUBMITTED'], ['approve', APPROVER, 'APPROVED']]],
    [
      'reject and resubmit cycles with an edit',
      [
        ['submit', PREPARER, 'SUBMITTED'],
        ['reject', APPROVER, 'REJECTED'],
        ['resubmit', PREPARER, 'RE-SUBMITTED'],
        ['reject', APPROVER, 'REJECTED'],
        ['edit', PREPARER, 'REJECTED'],
        ['resubmit', PREPARER, 'RE-SUBMITTED'],
        ['approve', APPROVER, 'APPROVED'],
      ],
    ],
    ['edits before submit', [['edit', PREPARER, 'IN-PROGRESS'], ['edit', PREPARER, 'IN-PROGRESS'], ['submit', PREPARER, 'SUBMITTED']]],
  ])('%s writes one record update and one version row per step', async (_, steps) => {
    const { record } = await create();
    for (const [index, [action, roles, to]] of steps.entries()) {
      const version = index + 2;
      const result = await inTenant(async (tx) => {
        const applied = await transitionRecord(tx, deps, { id: record.record_id, action, roles }, ACTOR_A);
        expect(await written(tx)).toEqual([`update record ${ACTOR_A.userId}`, `insert record_version ${ACTOR_A.userId}`]);
        return applied;
      });
      expect(result.record).toMatchObject({ state: to, version, lastupdatebyid: ACTOR_A.userId, row_version: String(version) });
      expect(result.record.lastupdate?.getTime()).toBe(NOW.getTime());
      expect(result.version).toMatchObject({ record_id: record.record_id, version, state: to, action, actor_user_id: ACTOR_A.userId });
    }
    const history = await inTenant((tx) => listVersions(tx, record.record_id));
    expect(history.map((row) => [row.version, row.action])).toEqual([[1, 'create'], ...steps.map(([action], index) => [index + 2, action])]);
  });

  it('edit sets only the fields present and snapshots the result; other actions ignore input', async () => {
    const { record } = await create({ title: 'Original', amount: 10000n, period: '2026-06' });
    const partial = await transition(record.record_id, 'edit', PREPARER, { amount: -25n });
    expect(partial.record).toMatchObject({ title: 'Original', amount: '-0.0025', period: '2026-06', version: 2 });
    expect(partial.version).toMatchObject({ title: 'Original', amount: '-0.0025', period: '2026-06', version: 2, action: 'edit' });

    const full = await transition(record.record_id, 'edit', PREPARER, { title: 'New', amount: 99990000n, period: '2026-07' });
    expect(full.version).toMatchObject({ title: 'New', amount: '9999.0000', period: '2026-07', version: 3 });

    const submitted = await transition(record.record_id, 'submit', PREPARER, { title: 'Ignored' });
    expect(submitted.record).toMatchObject({ title: 'New', state: 'SUBMITTED', version: 4 });
    expect(submitted.version).toMatchObject({ title: 'New', state: 'SUBMITTED', version: 4, action: 'submit' });
  });

  it('edit without input still writes a new version', async () => {
    const { record } = await create();
    const { record: edited, version } = await transition(record.record_id, 'edit', PREPARER);
    expect(edited).toMatchObject({ title: 'Travel', amount: '12505.0000', state: 'IN-PROGRESS', version: 2 });
    expect(version).toMatchObject({ version: 2, action: 'edit' });
  });

  /** Creates one tenant-A record per amount in `period` and returns the records. */
  async function fill(period: string, amounts: readonly bigint[]): Promise<FinanceRecordRow[]> {
    const records: FinanceRecordRow[] = [];
    for (const amount of amounts) records.push((await create({ ...TRAVEL, amount, period })).record);
    return records;
  }

  it.each<[string, string, readonly bigint[], bigint, readonly [string, number]]>([
    ['refuses a positive sum past the bound', '2031-01', [MAX], 1n, ['invalidParameters', 0]],
    ['refuses a negative sum past the bound', '2031-02', [-MAX, 5n], -1n, ['invalidParameters', 0]],
    ['accepts a positive sum of exactly the bound', '2031-03', [MAX - 1n, -7n], 1n, ['0.0001', 2]],
    ['accepts a negative sum of exactly the bound', '2031-04', [1n - MAX], -1n, ['-0.0001', 2]],
    ['sums each sign apart, so an opposite amount fits a full period', '2031-05', [MAX], -MAX, ['-999999999999999.9999', 2]],
  ])('create %s of a program period', async (_, period, existing, amount, expected) => {
    await fill(period, existing);
    const before = await count('changelog');
    const outcome = await create({ ...TRAVEL, amount, period }).then(
      ({ record }) => record.amount,
      (error: unknown) => (error as FinanceDomainError).type,
    );
    expect([outcome, (await count('changelog')) - before]).toEqual(expected);
  });

  it.each<[string, readonly [string, bigint], readonly [string, bigint], Partial<RecordInput>]>([
    ['moves the record into a full period', ['2032-01', MAX], ['2032-02', 1n], { period: '2032-01' }],
    ['raises the amount past the bound', ['2032-03', MAX - 5n], ['2032-03', 5n], { amount: 6n }],
    ['lowers the amount past the negative bound', ['2032-04', -MAX], ['2032-04', 0n], { amount: -1n }],
    ['moves the record with a new amount that no longer fits', ['2032-05', MAX - 1n], ['2032-06', 1n], { period: '2032-05', amount: 2n }],
  ])('refuses an edit that %s and writes nothing', async (_, [otherPeriod, otherAmount], [period, amount], input) => {
    await fill(otherPeriod, [otherAmount]);
    const [record] = (await fill(period, [amount])) as [FinanceRecordRow];
    const before = await count('changelog');
    await expect(transition(record.record_id, 'edit', PREPARER, input)).rejects.toMatchObject({ name: 'FinanceDomainError', type: 'invalidParameters' });
    expect(await count('changelog')).toBe(before);
    expect(await inTenant((tx) => getRecord(tx, record.record_id))).toMatchObject({ period, amount: record.amount, version: 1 });
    expect(await inTenant((tx) => listVersions(tx, record.record_id))).toHaveLength(1);
  });

  it('excludes the edited record from its own period sum and accepts an edit that fits exactly', async () => {
    const [full] = (await fill('2032-07', [MAX])) as [FinanceRecordRow];
    expect((await transition(full.record_id, 'edit', PREPARER, { amount: MAX })).record).toMatchObject({ amount: '999999999999999.9999', version: 2 });
    expect((await transition(full.record_id, 'edit', PREPARER)).record).toMatchObject({ version: 3 });
    await fill('2032-08', [MAX - 1n]);
    const moved = await transition(full.record_id, 'edit', PREPARER, { period: '2032-08', amount: 1n });
    expect(moved.record).toMatchObject({ period: '2032-08', amount: '0.0001', version: 4 });
  });

  it('never refuses a lifecycle action other than edit in a full period', async () => {
    const [full, zero] = (await fill('2032-09', [MAX, 0n])) as [FinanceRecordRow, FinanceRecordRow];
    const steps: readonly [string, FinanceAction, readonly string[]][] = [
      [full.record_id, 'submit', PREPARER],
      [full.record_id, 'approve', APPROVER],
      [zero.record_id, 'submit', PREPARER],
      [zero.record_id, 'reject', APPROVER],
      [zero.record_id, 'resubmit', PREPARER],
      [zero.record_id, 'approve', APPROVER],
    ];
    const states: string[] = [];
    for (const [id, action, roles] of steps) states.push((await transition(id, action, roles)).record.state);
    expect(states).toEqual(['SUBMITTED', 'APPROVED', 'SUBMITTED', 'REJECTED', 'RE-SUBMITTED', 'APPROVED']);
  });

  it('makes creates wait on the tenant write lock for an uncommitted create that took the last room of a period', async () => {
    const period = '2032-10';
    await fill(period, [MAX - 1n]);
    let locked = (): void => undefined;
    let release = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = inTenant(async (tx) => {
      await createRecord(tx, deps, { ...TRAVEL, amount: 1n, period }, ACTOR_A);
      locked();
      await released;
    });
    await isLocked;
    const waiting = Promise.allSettled([1n, 1n].map((amount) => create({ ...TRAVEL, amount, period })));
    // Long enough for an unserialised create to read the committed period and finish.
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const results = await waiting;
    expect(results.map((result) => (result.status === 'rejected' ? (result.reason as FinanceDomainError).type : result.status))).toEqual([
      'invalidParameters',
      'invalidParameters',
    ]);
  });

  it.each([
    ['an illegal state', 'approve', APPROVER, 409, 'illegalTransition'],
    ['a wrong role', 'submit', APPROVER, 403, 'authorization'],
    ['no finance role', 'submit', [], 403, 'authorization'],
  ] as const)('rejects %s with TransitionRejectedError and writes nothing', async (_, action, roles, statusCode, code) => {
    const { record } = await create();
    const before = await count('changelog');
    const error = await transition(record.record_id, action, roles).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransitionRejectedError);
    expect(error).toMatchObject({ statusCode, code });
    expect(await count('changelog')).toBe(before);
    expect(await inTenant((tx) => getRecord(tx, record.record_id))).toMatchObject({ state: 'IN-PROGRESS', version: 1 });
  });

  it('rejects every action on an APPROVED record with 409', async () => {
    const { record } = await create();
    await transition(record.record_id, 'submit', PREPARER);
    await transition(record.record_id, 'approve', APPROVER);
    await expect(transition(record.record_id, 'edit', PREPARER)).rejects.toMatchObject({ statusCode: 409, code: 'illegalTransition' });
  });

  it('answers notFound for a missing record before the role check', async () => {
    await expect(transition(MISSING_ID, 'submit', [])).rejects.toMatchObject({
      name: 'FinanceDomainError',
      type: 'notFound',
      message: 'Not Found',
    });
  });

  it('getRecord and listVersions answer notFound for a missing record', async () => {
    await expect(inTenant((tx) => getRecord(tx, MISSING_ID))).rejects.toBeInstanceOf(FinanceDomainError);
    await expect(inTenant((tx) => listVersions(tx, MISSING_ID))).rejects.toMatchObject({ type: 'notFound' });
  });

  it('listRecords returns the requested page and the total', async () => {
    const site = 'records-paging';
    const tenant = tenantIdForSite(site);
    await bind(tenant, site, 7);
    const ids: string[] = [];
    for (const title of ['a', 'b', 'c']) {
      ids.push((await inTenant((tx) => createRecord(tx, deps, { ...TRAVEL, title }, { ...ACTOR_A, siteId: site }), tenant)).record.record_id);
    }
    // Equal `created` values order by id.
    const ordered = [...ids].sort();
    const page = await inTenant((tx) => listRecords(tx, { pageIndex: 2, itemsPerPage: 2 }), tenant);
    expect(page.total).toBe(3);
    expect(page.rows.map((row) => row.record_id)).toEqual(ordered.slice(2));
    expect(await inTenant((tx) => listRecords(tx, { pageIndex: 3, itemsPerPage: 2 }), tenant)).toEqual({ rows: [], total: 3 });
  });

  it('keeps a tenant-A record out of reach of a tenant-B transaction', async () => {
    const { record } = await create();
    await expect(inTenant((tx) => getRecord(tx, record.record_id), tenantB)).rejects.toMatchObject({ type: 'notFound' });
    await expect(
      inTenant((tx) => transitionRecord(tx, deps, { id: record.record_id, action: 'submit', roles: PREPARER }, ACTOR_B), tenantB),
    ).rejects.toMatchObject({ type: 'notFound' });
    expect(await inTenant((tx) => getRecord(tx, record.record_id))).toMatchObject({ state: 'IN-PROGRESS', version: 1 });
  });

  it('propagates the gate rejection while the units are legacy-authoritative', async () => {
    const { record } = await create();
    await setGates('legacy');
    await expect(create()).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(transition(record.record_id, 'submit', PREPARER)).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
  });

  it('serialises concurrent transitions of one record on its row lock', async () => {
    const { record } = await create();
    const results = await Promise.allSettled([
      transition(record.record_id, 'submit', PREPARER),
      transition(record.record_id, 'submit', PREPARER),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 409 } });
    expect((await inTenant((tx) => listVersions(tx, record.record_id))).map((row) => row.version)).toEqual([1, 2]);
  });
});
