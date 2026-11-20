// Unit tests for backfill and feed applies over owner doubles: batch ids and size, the applier-killed exit, per-tenant
// batches, receipts and watermarks, split fan-out and unit selection, tenant resolution, and the refusal to write
// target-authoritative units.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  APPLY_ORIGINS,
  DEFAULT_UMBRELLA_SITE_ID,
  decodeRow,
  encodeRow,
  type ApplyRequest,
  type CanonicalColumn,
  type WatermarkRecord,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { pgAvailable } from '@opt2/platform/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  ApplyFaultConfigError,
  BackfillAuthorityError,
  BackfillBaselineError,
  DEFAULT_BATCH_SIZE,
  FeedAuthorityError,
  applyTableDiff,
  batchIdFor,
  batchSizeOf,
  createApplyTenantResolver,
  createBatchSender,
  createOwnerBatcher,
  fanOut,
  parseApplyFault,
  restartFeedFor,
  runBackfill,
  runFeed,
  umbrellaTenantId,
  type ApplyChange,
  type ApplyFault,
  type ApplyTableDiffOptions,
  type BackfillResult,
  type BatchIdParts,
  type BatchSender,
  type OwnerBatcher,
  type OwnerBatcherOptions,
} from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import { currentAuthority } from '../../src/cutover/index.js';
import { OwnerCallError, type DataOwner } from '../../src/owners/index.js';
import { MIGRATION_SCHEMA_SKIP_REASON, buildTestContext, type TestContext } from '../helpers/context.js';
import { TEST_SOURCE_SHA, createTestDirs, type TestDirs } from '../helpers/env.js';
import { createFakeLegacyDb, type FakeLegacyDb } from '../helpers/fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  FIXTURE_OWNERSHIP,
  TABLES,
  UNITS,
  V0001,
  V0002,
  blackoutRow,
  personArchiveRow,
  seedFakeLegacy,
  userRow,
} from '../helpers/fixtures.js';
import { createCallLog, type CallLog } from '../helpers/gateway-double.js';
import { createOwnerDoubles, type OwnerDoubles } from '../helpers/owner-double.js';

const config = loadConfig();
const schemaAvailable = await pgAvailable();

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID);
const LIVE_DB = 'masa_test';
const SNAPSHOT_SEQ = 1;
const BACKUP_LSN = '42';
const FINISHED_AT = '2026-06-30T12:00:00.000';

const text = (...names: string[]): CanonicalColumn[] => names.map((name) => ({ name, type: 's' }));
const USER_COLUMNS: CanonicalColumn[] = [...text('UserID', 'SiteID'), { name: 'Type', type: 'i' }, ...text('Fname')];
const IMAGE_SIZE_COLUMNS = text('sizeID', 'siteID', 'name');
const MAILING_LIST_COLUMNS = text('MLID', 'SiteID', 'Name');
// Columns of every tusers share: person (GroupName, Fname), user account (UserName, Type, SiteID), credential (Password), login state (LastLogin).
const SPLIT_COLUMNS: CanonicalColumn[] = [
  ...text('UserID', 'GroupName', 'Fname', 'UserName', 'Password'),
  { name: 'Type', type: 'i' },
  ...text('SiteID', 'LastLogin'),
];

// The apply wire selects no events: owners write the state events of a migration origin's applies and never a process event.
const APPLY_FIELDS: ReadonlySet<string> = new Set([
  'batchId',
  'origin',
  'legacyTable',
  'tenantId',
  'siteId',
  'legacyProgramId',
  'columns',
  'units',
  'holderId',
  'rows',
  'watermark',
] satisfies (keyof ApplyRequest)[]);
const MIGRATION_ORIGINS = APPLY_ORIGINS.filter((origin): origin is OwnerBatcherOptions['origin'] => origin !== 'legacy-window');

/** What the injected `exit` throws, so a test observes the exit instead of losing its process. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${String(code)})`);
  }
}

const throwingExit = (code: number): never => {
  throw new ExitCalled(code);
};

interface Harness {
  doubles: OwnerDoubles;
  log: CallLog;
  sender: BatchSender;
  exit: Mock<(code: number) => never>;
}

/** Owner doubles over the fixture catalog and a sender to them whose `exit` throws {@link ExitCalled}. */
function harness(fault: ApplyFault | null = null): Harness {
  const log = createCallLog();
  const doubles = createOwnerDoubles(FIXTURE_CATALOG, { log });
  const exit = vi.fn(throwingExit);
  return { doubles, log, sender: createBatchSender({ owners: doubles.client, fault, exit }), exit };
}

function userChange(siteId: string, index: number): ApplyChange {
  const userId = `${siteId}-${String(index).padStart(5, '0')}`;
  return { op: 'upsert', row: encodeRow(USER_COLUMNS, { UserID: userId, SiteID: siteId, Type: 2, Fname: `User ${String(index)}` }) };
}

function forwardWatermark(legacyTable: string): WatermarkRecord {
  return { legacyTable, direction: 'forward', snapshotSeq: SNAPSHOT_SEQ, backupLsn: BACKUP_LSN, finishedAt: FINISHED_AT };
}

/** A `people` backfill batcher of `tusers` at snapshot 1 with the default batch size, unless `overrides` say otherwise. */
function batcherOf(sender: BatchSender, overrides: Partial<OwnerBatcherOptions> = {}): OwnerBatcher {
  return createOwnerBatcher({
    owner: 'people',
    legacyTable: 'tusers',
    direction: 'backfill',
    snapshotSeq: SNAPSHOT_SEQ,
    origin: 'backfill',
    columns: USER_COLUMNS,
    batchSize: DEFAULT_BATCH_SIZE,
    sender,
    watermark: null,
    ...overrides,
  });
}

const idOf = (tenantId: string, ordinal: number): string =>
  batchIdFor({ direction: 'backfill', snapshotSeq: SNAPSHOT_SEQ, legacyTable: 'tusers', tenantId, ordinal });

function userRequest(ordinal: number): ApplyRequest {
  return {
    batchId: idOf(TENANT_A, ordinal),
    origin: 'backfill',
    legacyTable: 'tusers',
    tenantId: TENANT_A,
    columns: USER_COLUMNS,
    rows: [userChange('tenant-a', ordinal)],
  };
}

/** A tenant-a `Type=2` tusers row over {@link SPLIT_COLUMNS}. */
function splitUser(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values = { UserID: userId, GroupName: null, Fname: 'Fixture', UserName: userId.toLowerCase(), Password: `hash-${userId}`, Type: 2, SiteID: 'tenant-a' };
  return { ...values, LastLogin: null, ...overrides };
}

const SPLIT_GROUP = splitUser('G1', { GroupName: 'Editors', Fname: null, UserName: null, Password: null, Type: 1 });

/** Rows of `unit` the `owner` double exports for `tenantId`, decoded over the exported columns. */
async function exportedRows(doubles: OwnerDoubles, owner: DataOwner, unit: string, tenantId: string = TENANT_A): Promise<Record<string, unknown>[]> {
  const page = await doubles.client.export(owner, { unit, tenantId });
  return page.tables.flatMap((table) => table.rows.map((row) => decodeRow(table.columns, row.row)));
}

describe('batch identity and size', () => {
  it('sizes batches at the configured 1,000 rows', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(1000);
    expect(batchSizeOf(config)).toBe(1000);
    expect(batchSizeOf({ backfill: { batchRows: 250 } })).toBe(250);
  });

  const parts: BatchIdParts = { direction: 'backfill', snapshotSeq: SNAPSHOT_SEQ, legacyTable: 'tusers', tenantId: TENANT_A, ordinal: 0 };

  it('derives a 64-character lowercase hex id that equal parts repeat', () => {
    const id = batchIdFor(parts);

    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(batchIdFor({ ...parts })).toBe(id);
  });

  it.each<{ part: keyof BatchIdParts; change: Partial<BatchIdParts> }>([
    { part: 'direction', change: { direction: 'feed' } },
    { part: 'snapshotSeq', change: { snapshotSeq: 2 } },
    { part: 'legacyTable', change: { legacyTable: 'tusersmemb' } },
    { part: 'tenantId', change: { tenantId: TENANT_B } },
    { part: 'ordinal', change: { ordinal: 1 } },
  ])('derives another id when $part changes', ({ change }) => {
    expect(batchIdFor({ ...parts, ...change })).not.toBe(batchIdFor(parts));
  });
});

describe('parseApplyFault', () => {
  it.each<[string | undefined, ApplyFault | null]>([
    [undefined, null],
    ['', null],
    ['apply:kill-after:3', { point: 'acknowledged', batch: 3 }],
  ])('reads OPT2_FAULT %j as %j', (value, expected) => {
    expect(parseApplyFault(value)).toStrictEqual(expected);
  });

  it.each(['apply:kill-after:x', 'apply:other:1', 'apply:kill-after:0'])('rejects the malformed entry %j', (value) => {
    expect(() => parseApplyFault(value)).toThrow(ApplyFaultConfigError);
  });
});

describe('createBatchSender', () => {
  it('exits with 137 right after the second acknowledged batch and not before', async () => {
    const { doubles, sender, exit } = harness({ point: 'acknowledged', batch: 2 });

    await sender.apply('people', userRequest(0));
    expect(exit).not.toHaveBeenCalled();
    await expect(sender.apply('people', userRequest(1))).rejects.toThrow(new ExitCalled(137));

    expect(exit).toHaveBeenCalledExactlyOnceWith(137);
    expect(doubles.owner('people').batches.map((batch) => batch.batchId)).toEqual([idOf(TENANT_A, 0), idOf(TENANT_A, 1)]);
    expect(sender.acknowledged).toBe(2);
  });

  it('never exits without a fault', async () => {
    const { sender, exit } = harness();

    for (const ordinal of [0, 1, 2]) await sender.apply('people', userRequest(ordinal));

    expect(exit).not.toHaveBeenCalled();
    expect(sender.acknowledged).toBe(3);
  });

  it('rejects with the owner failure after one attempt, without retrying', async () => {
    const { doubles, log, sender } = harness();
    const failure = new Error('owner unavailable');
    doubles.owner('people').failNext('apply', { once: failure });

    await expect(sender.apply('people', userRequest(0))).rejects.toBe(failure);

    expect(log.ops('owner:people')).toEqual(['apply']);
    expect(doubles.owner('people').batches).toEqual([]);
    expect(sender.acknowledged).toBe(0);
  });
});

describe('createOwnerBatcher', () => {
  it('sends 2,500 tenant-a and 10 tenant-b rows as per-tenant batches, only the last carrying the forward watermark', async () => {
    const { doubles, log, sender } = harness();
    const watermark = forwardWatermark('tusers');
    const batcher = batcherOf(sender, { watermark });

    for (let index = 0; index < 2500; index += 1) await batcher.add(TENANT_A, userChange('tenant-a', index));
    for (let index = 0; index < 10; index += 1) await batcher.add(TENANT_B, userChange('tenant-b', index));
    const stats = await batcher.finish();

    const batches = doubles.owner('people').batches;
    const layoutOf = (tenantId: string): [string, number][] =>
      batches.filter((batch) => batch.tenantId === tenantId).map((batch) => [batch.batchId, batch.rows.length]);
    expect(layoutOf(TENANT_A)).toEqual([
      [idOf(TENANT_A, 0), 1000],
      [idOf(TENANT_A, 1), 1000],
      [idOf(TENANT_A, 2), 500],
    ]);
    expect(layoutOf(TENANT_B)).toEqual([[idOf(TENANT_B, 0), 10]]);
    expect(batches.every((batch) => batch.origin === 'backfill' && batch.legacyTable === 'tusers')).toBe(true);
    expect(stats).toEqual({
      owner: 'people',
      legacyTable: 'tusers',
      batches: 4,
      changes: 2510,
      perTenant: { [TENANT_A]: 2500, [TENANT_B]: 10 },
      watermark: 'batch',
    });

    const last = batches.at(-1);
    expect(batches.filter((batch) => batch.watermark !== undefined)).toEqual([last]);
    expect(last?.watermark).toEqual({ direction: 'forward', finishedAt: FINISHED_AT, snapshotSeq: SNAPSHOT_SEQ, backupLsn: BACKUP_LSN });
    expect(doubles.owner('people').watermarks.get('tusers|forward')).toEqual(watermark);
    expect(log.ops('owner:people')).not.toContain('putWatermark');
  });

  it('puts the watermark of a table without rows alone, with no apply', async () => {
    const { doubles, log, sender } = harness();
    const watermark = forwardWatermark('tmailinglist');
    const batcher = batcherOf(sender, { owner: 'communications', legacyTable: 'tmailinglist', columns: MAILING_LIST_COLUMNS, watermark });

    const stats = await batcher.finish();

    expect(stats).toMatchObject({ batches: 0, changes: 0, watermark: 'putWatermark' });
    expect(log.ops('owner:communications')).toEqual(['putWatermark']);
    expect(doubles.owner('communications').watermarks.get('tmailinglist|forward')).toEqual(watermark);
  });

  it.each(MIGRATION_ORIGINS)('sends %s batches with only apply fields, so owners emit state events alone', async (origin) => {
    const { doubles, sender } = harness();
    const feed = origin === 'migration-feed';
    const batcher = batcherOf(sender, { origin, batchSize: 2, ...(feed ? { direction: 'feed', units: [UNITS.person] } : {}) });

    for (let index = 0; index < 5; index += 1) await batcher.add(TENANT_A, userChange('tenant-a', index));
    await batcher.finish();

    const batches = doubles.owner('people').batches;
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(Object.keys(batch).filter((key) => !APPLY_FIELDS.has(key))).toEqual([]);
      expect(batch.origin).toBe(origin);
      expect(batch.units).toEqual(feed ? [UNITS.person] : undefined);
    }
  });

  it('applies a resent batch once: the owner answers the repeat as a duplicate', async () => {
    const { doubles, sender } = harness();
    const request: ApplyRequest = { ...userRequest(0), rows: [userChange('tenant-a', 0), userChange('tenant-a', 1)] };

    const first = await sender.apply('people', request);
    const second = await sender.apply('people', request);

    expect(first).toMatchObject({ batchId: request.batchId, duplicate: false, applied: 2 });
    expect(second).toMatchObject({ batchId: request.batchId, duplicate: true, applied: 0, skipped: 0 });
    expect(doubles.owner('people').batches).toHaveLength(1);
    expect(doubles.owner('people').rows.get('tusers')).toHaveLength(2);
    expect(sender.acknowledged).toBe(2);
  });

  it.each<{ arrangement: string; prior: ApplyRequest[]; answer: object; userIds: string[] }>([
    {
      arrangement: 'sent first, with its 400, storing and receipting nothing',
      prior: [],
      answer: { name: 'OwnerCallError', status: 400, body: { error: { code: 'invalid_request' } } },
      userIds: [],
    },
    {
      arrangement: 'resent after a valid batch of its id, as a duplicate',
      prior: [userRequest(0)],
      answer: { batchId: idOf(TENANT_A, 0), duplicate: true, applied: 0, skipped: 0 },
      userIds: ['tenant-a-00000'],
    },
  ])('answers a keyed tusers batch of insert rows $arrangement', async ({ prior, answer, userIds }) => {
    const { doubles, sender } = harness();
    for (const request of prior) await sender.apply('people', request);
    const inserts: ApplyRequest = { ...userRequest(0), rows: [{ ...userChange('tenant-a', 1), op: 'insert' }] };

    const outcome = await sender.apply('people', inserts).catch((reason: unknown) => reason);

    expect(outcome).toMatchObject(answer);
    const people = doubles.owner('people');
    expect(people.batches.map((batch) => batch.batchId)).toEqual(prior.map((request) => request.batchId));
    expect((people.rows.get('tusers') ?? []).map((row) => row.values.UserID)).toEqual(userIds);
    expect([...(people.appliedBatchIds.get(TENANT_A) ?? [])]).toEqual(prior.map((request) => request.batchId));
  });

  it('applies one batch id once per tenant: both tenants write it, and each tenant answers its repeat as a duplicate', async () => {
    const { doubles, sender } = harness();
    const batchId = idOf(TENANT_A, 0);
    const sites = [
      { tenantId: TENANT_A, siteId: 'tenant-a' },
      { tenantId: TENANT_B, siteId: 'tenant-b' },
    ];
    const requests = sites.map(
      ({ tenantId, siteId }): ApplyRequest => ({ ...userRequest(0), batchId, tenantId, rows: [userChange(siteId, 0), userChange(siteId, 1)] }),
    );

    const results = [];
    for (const request of [...requests, ...requests]) results.push(await sender.apply('people', request));

    expect(results).toMatchObject([
      { batchId, duplicate: false, applied: 2, skipped: 0 },
      { batchId, duplicate: false, applied: 2, skipped: 0 },
      { batchId, duplicate: true, applied: 0, skipped: 0 },
      { batchId, duplicate: true, applied: 0, skipped: 0 },
    ]);
    const people = doubles.owner('people');
    expect(people.batches.map((batch) => [batch.tenantId, batch.batchId])).toEqual([
      [TENANT_A, batchId],
      [TENANT_B, batchId],
    ]);
    expect(people.rows.get('tusers')).toHaveLength(4);
    for (const { tenantId, siteId } of sites) {
      expect((await exportedRows(doubles, 'people', UNITS.person, tenantId)).map((row) => row.UserID), siteId).toEqual([`${siteId}-00000`, `${siteId}-00001`]);
    }
  });

  it.each<{ table: string; columns: CanonicalColumn[]; change: ApplyChange; receivers: DataOwner[] }>([
    { table: 'tusers', columns: USER_COLUMNS, change: userChange('tenant-a', 0), receivers: ['identity', 'people'] },
    {
      table: 'timagesizes',
      columns: IMAGE_SIZE_COLUMNS,
      change: { op: 'upsert', row: encodeRow(IMAGE_SIZE_COLUMNS, { sizeID: 'SIZE-1', siteID: 'tenant-a', name: 'thumbnail' }) },
      receivers: ['programs-sites'],
    },
  ])('fans a $table change out to $receivers only', async ({ table, columns, change, receivers }) => {
    const { doubles, sender } = harness();
    const batchers = new Map(
      FIXTURE_CATALOG.ownersForLegacyTable(table).map((owner) => [owner, batcherOf(sender, { owner, legacyTable: table, columns })] as const),
    );

    await fanOut(batchers, TENANT_A, change);
    for (const batcher of batchers.values()) await batcher.finish();

    expect([...batchers.keys()]).toEqual(receivers);
    for (const owner of doubles.owners()) {
      const rows = doubles.owner(owner).batches.flatMap((batch) => batch.rows.map((row) => row.row));
      expect(rows, owner).toEqual(receivers.includes(owner as DataOwner) ? [change.row] : []);
    }
  });
});

describe('owner apply of selected units', () => {
  const change = (op: ApplyChange['op'], values: Record<string, unknown>): ApplyChange => ({ op, row: encodeRow(SPLIT_COLUMNS, values) });
  const feedRequest = (units: string[], rows: ApplyChange[]): ApplyRequest => ({
    batchId: batchIdFor({ direction: 'feed', snapshotSeq: SNAPSHOT_SEQ, legacyTable: 'tusers', tenantId: TENANT_A, ordinal: 0 }),
    origin: 'migration-feed',
    legacyTable: 'tusers',
    tenantId: TENANT_A,
    columns: SPLIT_COLUMNS,
    units,
    rows,
  });

  it('writes only the login-state share of tusers, leaving every other unit of both owners as it was', async () => {
    const { doubles, sender } = harness();
    doubles.owner('identity').seedRows('tusers', TENANT_A, [splitUser('U1'), splitUser('U2'), SPLIT_GROUP], SPLIT_COLUMNS);
    doubles.owner('people').seedRows('tusers', TENANT_A, [splitUser('U1'), splitUser('U2')], SPLIT_COLUMNS);
    const excluded: [DataOwner, string][] = [
      ['identity', UNITS.groupAccount],
      ['identity', UNITS.userAccount],
      ['identity', UNITS.credential],
      ['people', UNITS.person],
    ];
    const exports = (): Promise<Record<string, unknown>[][]> => Promise.all(excluded.map(([owner, unit]) => exportedRows(doubles, owner, unit)));
    const before = await exports();

    const result = await sender.apply(
      'identity',
      feedRequest(
        [UNITS.loginState],
        [
          change('upsert', splitUser('U1', { Fname: 'Renamed', UserName: 'renamed', Password: 'hash-new', LastLogin: '2026-06-02 08:00:00' })),
          change('delete', splitUser('U2')),
          change('upsert', splitUser('U3', { LastLogin: '2026-06-02 09:00:00' })),
          change('upsert', { ...SPLIT_GROUP, GroupName: 'Writers', LastLogin: '2026-06-02 10:00:00' }),
        ],
      ),
    );

    expect(result).toMatchObject({ duplicate: false, applied: 3, skipped: 1 });
    expect(await exportedRows(doubles, 'identity', UNITS.loginState)).toEqual([
      { UserID: 'U1', LastLogin: '2026-06-02 08:00:00' },
      { UserID: 'U3', LastLogin: '2026-06-02 09:00:00' },
    ]);
    expect(before.map((rows) => rows.length)).toEqual([1, 2, 2, 2]);
    expect(await exports()).toEqual(before);
    expect(doubles.owner('people').batches).toEqual([]);
  });

  it.each<{ owner: DataOwner; unit: string; mapped: string }>([
    { owner: 'identity', unit: UNITS.person, mapped: UNITS.userAccount },
    { owner: 'people', unit: UNITS.loginState, mapped: UNITS.person },
    { owner: 'people', unit: UNITS.personArchive, mapped: UNITS.person },
  ])('refuses $owner a tusers batch naming $unit with its 400, storing and receipting nothing', async ({ owner, unit, mapped }) => {
    const { doubles, sender } = harness();
    const request = feedRequest([unit], [change('upsert', splitUser('U1'))]);

    const error = await sender.apply(owner, request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(OwnerCallError);
    expect(error).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: `${owner} maps tusers to no unit ${unit}` } } });
    const state = doubles.owner(owner);
    expect(state.batches).toEqual([]);
    expect(state.rows.get('tusers')).toBeUndefined();
    expect(state.appliedBatchIds.size).toBe(0);
    expect(await sender.apply(owner, { ...request, units: [mapped] })).toMatchObject({ duplicate: false, applied: 1 });
  });
});

describe('createApplyTenantResolver', () => {
  let dirs: TestDirs;
  let legacy: FakeLegacyDb;

  beforeEach(async () => {
    dirs = await createTestDirs();
    legacy = createFakeLegacyDb({ database: LIVE_DB });
    seedFakeLegacy(legacy);
    legacy.defineTable('dbo.temails', [
      { name: 'EmailID', type: 'char', length: 35, nullable: false },
      { name: 'SiteID', type: 'nvarchar', length: 25 },
    ], { primaryKey: ['EmailID'] });
    legacy.defineTable('dbo.temailstats', [
      { name: 'EmailID', type: 'char', length: 35 },
      { name: 'Email', type: 'nvarchar', length: 100 },
    ]);
    legacy.seed('dbo.temails', [{ EmailID: 'EMAIL-B', SiteID: 'tenant-b' }]);
  });

  afterEach(async () => {
    await legacy.close();
    await dirs.cleanup();
  });

  /** Fixture ownership plus `temails` resolved by site and `temailstats` by its `temails` parent, as the live file records them. */
  async function ownershipWithParentTable(): Promise<string> {
    const file = path.join(dirs.stateDir, 'table-ownership.json');
    const tables = [
      ...FIXTURE_OWNERSHIP.tables,
      { table: 'temails', owner: 'communications', tenantResolution: 'siteID', siteIdColumn: 'SiteID', targets: [] },
      {
        table: 'temailstats',
        owner: 'communications',
        tenantResolution: 'parent:temails',
        siteIdColumn: null,
        tenantParent: { table: 'temails', join: 'temailstats.EmailID = temails.EmailID' },
        targets: [],
      },
    ];
    await writeFile(file, `${JSON.stringify({ ...FIXTURE_OWNERSHIP, tables }, null, 2)}\n`, 'utf8');
    return file;
  }

  it.each<{ name: string; table: string; row: Record<string, unknown>; tenantId: string; orphan: boolean }>([
    { name: 'a tenant-a row', table: 'tusers', row: userRow({ SiteID: 'tenant-a' }), tenantId: TENANT_A, orphan: false },
    { name: 'a pooled row of the pool site', table: 'tusers', row: userRow({ SiteID: DEFAULT_UMBRELLA_SITE_ID, isPublic: 1 }), tenantId: UMBRELLA, orphan: false },
    { name: 'a child row without a site', table: 'temailstats', row: { EmailID: 'EMAIL-B', Email: 'reader@example.test' }, tenantId: TENANT_B, orphan: false },
    {
      name: 'a child row without a parent',
      table: 'temailstats',
      row: { EmailID: 'EMAIL-NONE', Email: 'reader@example.test' },
      tenantId: umbrellaTenantId(config),
      orphan: true,
    },
  ])('places $name', async ({ table, row, tenantId, orphan }) => {
    const ctx = { legacy, catalog: FIXTURE_CATALOG, config: { ...config, paths: { ...config.paths, tableOwnership: await ownershipWithParentTable() } } };

    const tenants = await createApplyTenantResolver(ctx, { database: LIVE_DB });
    await tenants.prepare(table, [row]);

    expect(tenants.resolve(table, row)).toEqual({ tenantId, orphan });
    expect(tenants.siteTenants()).toEqual(['default', DEFAULT_UMBRELLA_SITE_ID, 'tenant-a', 'tenant-b'].map(tenantIdForSite).sort());
  });
});

/** Every call the context's owner doubles received. */
function ownerCalls(test: TestContext): { owner: string; method: string }[] {
  const doubles = test.owners;
  if (doubles === null) throw new Error('The test context has no owner doubles');
  return doubles.owners().flatMap((owner) => doubles.owner(owner).calls.map((call) => ({ owner, method: call.method })));
}

/** Snapshot 1 of the fake's live database, which stands in for its read-only restored copy. */
const SNAPSHOT: ApplyTableDiffOptions['to'] = {
  seq: SNAPSHOT_SEQ,
  kind: 'feed',
  state: 'ready',
  databaseName: LIVE_DB,
  backupPath: '/var/opt/mssql/backup/snap-1.bak',
  checkpointLsn: BACKUP_LSN,
  lastLsn: '43',
  takenAt: new Date('2026-06-30T12:00:00.000Z'),
  transitionId: null,
  sourceSha: TEST_SOURCE_SHA,
  manifestComplete: false,
  fileStore: null,
};

const TUSERS: ApplyTableDiffOptions['table'] = {
  name: 'tusers',
  owner: 'split',
  owners: ['identity', 'people'],
  physical: [{ ref: { schema: 'dbo', table: 'tusers', qualified: 'dbo.tusers' } }],
  folded: false,
  keyColumns: ['UserID'],
};

describe('feed authority under v0002', () => {
  let test: TestContext;

  beforeAll(async () => {
    test = await buildTestContext({ bridge: false, gateway: { active: V0002.tableVersion }, cutover: { versions: [V0001, V0002] } });
  });

  afterAll(() => test.close());

  it('refuses to restart the feed for a target-authoritative people unit before any owner call', async () => {
    const error = await restartFeedFor(test.ctx, { units: [UNITS.mailingList, UNITS.person] }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FeedAuthorityError);
    expect((error as FeedAuthorityError).units).toEqual([UNITS.person]);
    expect(ownerCalls(test)).toEqual([]);
  });

  it('diffs tusers for no owner, every tusers unit being target-authoritative', async () => {
    const authority = await currentAuthority({ gateway: test.gateway, config: test.ctx.config.paths });
    const writableUnits = new Set(FIXTURE_CATALOG.units().map((unit) => unit.id).filter((unit) => !authority.isTargetAuthoritative(unit)));

    const result = await applyTableDiff(test.ctx, {
      table: TUSERS,
      to: SNAPSHOT,
      writableUnits,
      direction: 'feed',
      tenantsFor: () => Promise.reject(new Error('a refused diff reads no tenants')),
      sender: createBatchSender({ owners: test.ctx.owners, fault: null, exit: throwingExit }),
      batchSize: DEFAULT_BATCH_SIZE,
    });

    expect(writableUnits).toEqual(new Set([UNITS.mailingList, UNITS.mailingListMember]));
    expect(result.owners.map((owner) => [owner.owner, owner.status])).toEqual([
      ['identity', 'not-writable'],
      ['people', 'not-writable'],
    ]);
    expect(ownerCalls(test)).toEqual([]);
  });
});

const INSERT_SNAPSHOT_SQL =
  'INSERT INTO migration.snapshot (seq, database_name, backup_file, checkpoint_lsn, last_lsn, kind, state, manifest_complete, taken_at, source_sha) ' +
  'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';

describe.skipIf(!schemaAvailable)(`backfill and feed authority over migration.snapshot (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})`, () => {
  let test: TestContext;
  let first: BackfillResult;

  const applyCount = (): number => ownerCalls(test).filter((call) => call.method === 'apply').length;
  const appliedBatches = (): { owner: string; request: ApplyRequest }[] => {
    const doubles = test.owners;
    if (doubles === null) throw new Error('The test context has no owner doubles');
    return doubles.owners().flatMap((owner) => doubles.owner(owner).batches.map((request) => ({ owner, request })));
  };

  beforeAll(async () => {
    test = await buildTestContext({ migrationDb: true, legacySeed: true, gateway: { active: null }, cutover: { versions: [V0001, V0002] } });
    // Every unit gets a row, so each owner export knows its columns when the after-backfill point reconciles it.
    test.legacy.seed(TABLES['synthetic.person_archive'].qualified, [personArchiveRow()]);
    test.legacy.seed(TABLES['Program_1.blackout'].qualified, [blackoutRow()]);
    await test.ctx.db.withMetadata((tx) =>
      tx.query(INSERT_SNAPSHOT_SQL, [
        SNAPSHOT.seq,
        SNAPSHOT.databaseName,
        SNAPSHOT.backupPath,
        SNAPSHOT.checkpointLsn,
        SNAPSHOT.lastLsn,
        'seed',
        'ready',
        false,
        SNAPSHOT.takenAt,
        TEST_SOURCE_SHA,
      ]),
    );
    first = await runBackfill(test.ctx, { snapshotSeq: SNAPSHOT_SEQ });
  });

  afterAll(() => test.close());

  it('backfills with no active version as backfill batches, each table watermarked at the snapshot', () => {
    const batches = appliedBatches();

    expect(first).toMatchObject({ snapshotSeq: SNAPSHOT_SEQ, exitCode: 0, reconciliation: { point: 'after-backfill', result: 'zero-difference' } });
    expect(new Set(batches.filter(({ request }) => request.legacyTable === 'tusers').map(({ owner }) => owner))).toEqual(new Set(['identity', 'people']));
    for (const { owner, request } of batches) {
      expect(request.origin).toBe('backfill');
      expect(Object.keys(request).filter((key) => !APPLY_FIELDS.has(key))).toEqual([]);
      // A folded table's watermark is stored under its Program_N name, never under one Program_<id> part.
      const legacyTable = FIXTURE_CATALOG.foldProgramTable(request.legacyTable).legacyTable;
      expect(test.owners?.owner(owner).watermarks.get(`${legacyTable}|forward`), `${owner} ${legacyTable}`).toMatchObject({
        direction: 'forward',
        snapshotSeq: SNAPSHOT_SEQ,
        backupLsn: BACKUP_LSN,
      });
    }
  });

  it('backfills again under v0001 with the same batch ids, which the owners take as duplicates', async () => {
    test.gateway.setActive(V0001.tableVersion);
    const applied = appliedBatches().map(({ request }) => request.batchId);
    const calls = applyCount();

    await runBackfill(test.ctx, { snapshotSeq: SNAPSHOT_SEQ });

    expect(applyCount() - calls).toBe(applied.length);
    expect(appliedBatches().map(({ request }) => request.batchId)).toEqual(applied);
  });

  it('refuses a backfill of a second snapshot under v0001, naming the snapshot the owners hold, before any batch', async () => {
    test.gateway.setActive(V0001.tableVersion);
    const second = SNAPSHOT_SEQ + 1;
    // SQL Server database names are case-insensitive, so the upper-cased name opens the same fake database under a name migration.snapshot has not recorded.
    await test.ctx.db.withMetadata((tx) =>
      tx.query(INSERT_SNAPSHOT_SQL, [
        second,
        SNAPSHOT.databaseName.toUpperCase(),
        `/var/opt/mssql/backup/snap-${String(second)}.bak`,
        SNAPSHOT.checkpointLsn,
        SNAPSHOT.lastLsn,
        'seed',
        'ready',
        false,
        SNAPSHOT.takenAt,
        TEST_SOURCE_SHA,
      ]),
    );
    const calls = applyCount();

    const error = await runBackfill(test.ctx, { snapshotSeq: second }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BackfillBaselineError);
    expect((error as BackfillBaselineError).message).toContain(
      `Backfill of snapshot ${String(second)} refused: owners hold forward watermarks from snapshot ${String(SNAPSHOT_SEQ)} for `,
    );
    const { held } = error as BackfillBaselineError;
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map((mark) => mark.snapshotSeq))).toEqual(new Set([SNAPSHOT_SEQ]));
    expect(held).toEqual(expect.arrayContaining([{ owner: 'communications', table: 'tmailinglist', snapshotSeq: SNAPSHOT_SEQ }]));
    expect(applyCount()).toBe(calls);
  });

  it('refuses backfill under v0002, naming every target-authoritative unit, before any batch', async () => {
    test.gateway.setActive(V0002.tableVersion);
    const authority = await currentAuthority({ gateway: test.gateway, config: test.ctx.config.paths });
    const calls = applyCount();

    const error = await runBackfill(test.ctx, { snapshotSeq: SNAPSHOT_SEQ }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BackfillAuthorityError);
    const { units } = error as BackfillAuthorityError;
    expect(units).toEqual([...authority.targetUnits]);
    expect(units).toEqual(expect.arrayContaining([UNITS.person, UNITS.userAccount, UNITS.credential]));
    expect(units).not.toContain(UNITS.mailingList);
    expect(applyCount()).toBe(calls);
  });

  it('feeds under v0002 without sending a batch to any target-authoritative unit', async () => {
    test.gateway.setActive(V0002.tableVersion);
    const calls = applyCount();

    const result = await runFeed(test.ctx, { snapshotSeq: SNAPSHOT_SEQ });

    const statusOf = (table: string, owner: string) =>
      result.tables.find((entry) => entry.table === table)?.owners.find((entry) => entry.owner === owner)?.status;
    expect(result).toMatchObject({ tableVersion: V0002.tableVersion, exitCode: 0, reconciliation: { result: 'zero-difference' } });
    expect(result.files).toMatchObject({ status: 'skipped-target-authoritative' });
    expect(statusOf('tusers', 'identity')).toBe('not-writable');
    expect(statusOf('tusers', 'people')).toBe('not-writable');
    expect(statusOf('tmailinglist', 'communications')).toBe('up-to-date');
    expect(applyCount()).toBe(calls);
  });
});

describe.skipIf(!schemaAvailable)(`backfill after a feed to the same snapshot (skipped: ${MIGRATION_SCHEMA_SKIP_REASON})`, () => {
  let test: TestContext;

  /** Records ready seed snapshot `seq` of the fake's database under `databaseName`. */
  const recordSnapshot = (seq: number, databaseName: string): Promise<unknown> =>
    test.ctx.db.withMetadata((tx) =>
      tx.query(INSERT_SNAPSHOT_SQL, [
        seq,
        databaseName,
        `/var/opt/mssql/backup/snap-${String(seq)}.bak`,
        SNAPSHOT.checkpointLsn,
        SNAPSHOT.lastLsn,
        'seed',
        'ready',
        false,
        SNAPSHOT.takenAt,
        TEST_SOURCE_SHA,
      ]),
    );

  beforeAll(async () => {
    test = await buildTestContext({ migrationDb: true, legacySeed: true, gateway: { active: null }, cutover: { versions: [V0001, V0002] } });
    test.legacy.seed(TABLES['synthetic.person_archive'].qualified, [personArchiveRow()]);
    test.legacy.seed(TABLES['Program_1.blackout'].qualified, [blackoutRow()]);
    await recordSnapshot(SNAPSHOT_SEQ, SNAPSHOT.databaseName);
  });

  afterAll(() => test.close());

  it('refuses a backfill of snapshot 2 after backfill(1) and feed(2) before any batch, so keyless tables keep their occurrences', async () => {
    const second = SNAPSHOT_SEQ + 1;
    const communications = test.owners?.owner('communications');
    const tables = ['tmailinglist', 'tmailinglistmembers'] as const;
    const keyless = (): (number | undefined)[] => tables.map((table) => communications?.rows.get(table)?.length);
    const applies = (): number => ownerCalls(test).filter((call) => call.method === 'apply').length;
    expect(await runBackfill(test.ctx, { snapshotSeq: SNAPSHOT_SEQ })).toMatchObject({ exitCode: 0 });
    test.gateway.setActive(V0001.tableVersion);
    // The upper-cased name opens the same fake database, so the feed to snapshot 2 finds no change and only moves the watermarks.
    await recordSnapshot(second, SNAPSHOT.databaseName.toUpperCase());
    expect(await runFeed(test.ctx, { snapshotSeq: second })).toMatchObject({ snapshotSeq: second, exitCode: 0 });
    expect(communications?.watermarks.get('tmailinglist|forward')).toMatchObject({ snapshotSeq: second });
    const occurrences = keyless();
    const calls = applies();

    const error = await runBackfill(test.ctx, { snapshotSeq: second }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BackfillBaselineError);
    expect(error).toMatchObject({
      baselineSeq: SNAPSHOT_SEQ,
      message: expect.stringContaining(`Backfill of snapshot ${String(second)} refused: the target was backfilled from snapshot ${String(SNAPSHOT_SEQ)};`),
    });
    expect((error as BackfillBaselineError).held).toEqual(
      expect.arrayContaining([{ owner: 'communications', table: 'tmailinglistmembers', snapshotSeq: second }]),
    );
    // One occurrence per legacy row, the duplicated member row included.
    expect(occurrences).toEqual(tables.map((table) => test.legacy.rows(TABLES[table].qualified).length));
    expect(keyless()).toEqual(occurrences);
    expect(applies()).toBe(calls);
  });
});
