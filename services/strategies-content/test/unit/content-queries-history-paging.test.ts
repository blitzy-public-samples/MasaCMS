/** `repo/content-queries` history order, `historyPage` pages and `historyBatches` keyset batches over a throwaway `content` schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  HISTORY_BATCH_SIZE,
  SITE_TREE_MODULE_ID,
  archiveHist,
  draftHist,
  hist,
  historyBatches,
  historyPage,
  pendingChangesets,
  type HistoryRead,
} from '../../src/repo/content-queries.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

type Row = Record<string, unknown>;

/** A CF-format id whose first group is `<prefix><n>`. */
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const at = (stamp: string): Date => new Date(stamp);

const SITE = TENANT_A.siteId;
const ITEM = cfId('C', 1);
const ARGS = { contentId: ITEM.toLowerCase(), siteId: SITE };
const CS = cfId('Q', 1);
const [RQ_A, RQ_B, RQ_C] = [1, 2, 3].map((n) => cfId('R', n)) as [string, string, string];
// Within each tie the lower tcontent_id has the higher contenthistid, and rows are inserted by descending tcontent_id.
const [AR_OLD, AR_TIE1, AR_TIE2, AR_NULL, LIVE] = [1, 3, 2, 4, 5].map((n) => cfId('H', n)) as [string, string, string, string, string];
const [DR_REQ, DR_TIE, DR_NULL1, DR_NULL2] = [7, 6, 9, 8].map((n) => cfId('H', n)) as [string, string, string, string];
const [CS_TIE1, CS_TIE2, CS_OLD] = [11, 10, 12].map((n) => cfId('H', n)) as [string, string, string];
const OTHER_ITEM_VERSION = cfId('H', 99);

const HISTORY_COLUMNS = [
  'menutitle', 'contentid', 'contenthistid', 'fileid', 'type', 'lastupdateby', 'lastupdatebyid', 'active', 'approved', 'lastupdate',
  'display', 'displaystart', 'displaystop', 'moduleid', 'isnav', 'notes', 'isfeature', 'inheritobjects', 'filename', 'targetparams',
  'releasedate',
];
const APPROVAL_JOIN = ['approvalstatus', 'requestid', 'approvalgroupid'];

const ALL_ROWS: Record<HistoryRead, (tx: TenantTx, args: { contentId: string; siteId: string }) => Promise<Row[]>> = {
  hist,
  draftHist,
  pendingChangesets,
  archiveHist,
};

const COLUMNS: Record<HistoryRead, string[]> = {
  hist: [
    ...HISTORY_COLUMNS,
    'siteid', 'featurestart', 'featurestop', 'changesetid', 'changesetname', 'changsetpublished', 'changesetpublishdate',
    'majorversion', 'minorversion', ...APPROVAL_JOIN,
  ],
  draftHist: [...HISTORY_COLUMNS, 'path', ...APPROVAL_JOIN],
  pendingChangesets: [...HISTORY_COLUMNS, 'path', 'changesetpublishdate', 'changesetname', 'changesetid', ...APPROVAL_JOIN],
  archiveHist: [...HISTORY_COLUMNS, 'path', ...APPROVAL_JOIN],
};

/** `contenthistid/requestid` of a version row, `-` for no request. */
const rowKey = (row: Row): string => `${String(row.contenthistid)}/${String(row.requestid ?? '-')}`;
const none = (contentHistId: string): string => `${contentHistId}/-`;

const EXPECTED: Record<HistoryRead, string[]> = {
  hist: [
    none(CS_TIE1), `${CS_TIE2}/${RQ_C}`, none(CS_OLD), `${DR_REQ}/${RQ_A}`, `${DR_REQ}/${RQ_B}`, none(DR_TIE), none(LIVE), none(AR_TIE1),
    none(AR_TIE2), none(AR_OLD), none(DR_NULL1), none(AR_NULL), none(DR_NULL2),
  ],
  draftHist: [`${DR_REQ}/${RQ_A}`, `${DR_REQ}/${RQ_B}`, none(DR_TIE), none(DR_NULL1), none(DR_NULL2)],
  pendingChangesets: [none(CS_TIE1), `${CS_TIE2}/${RQ_C}`, none(CS_OLD)],
  archiveHist: [none(AR_TIE1), none(AR_TIE2), none(AR_OLD), none(AR_NULL)],
};
const READS = Object.keys(EXPECTED) as HistoryRead[];

let handle: ThrowawaySchema;

/** Inserts `rows` into `table` in the transaction tenant; each row names its own columns. */
async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

/** A version of `ITEM` with identity `tcontentId` (null for the next generated one); `fields` override any column. */
const version = (tcontentId: number | null, contenthistid: string, lastupdate: Date | null, fields: Row = {}): Row => ({
  ...(tcontentId === null ? {} : { tcontent_id: tcontentId }),
  contentid: ITEM,
  contenthistid,
  siteid: SITE,
  moduleid: SITE_TREE_MODULE_ID,
  type: 'Page',
  menutitle: 'Item',
  path: ITEM,
  active: 0,
  approved: 1,
  lastupdate,
  ...fields,
});

const draft = { approved: 0 };
const inChangeset = { approved: 0, changesetid: CS };

async function seed(tx: TenantTx): Promise<void> {
  const versions = [
    version(140, AR_OLD, at('2026-01-01T09:00')),
    version(120, AR_TIE1, at('2026-02-01T09:00')),
    version(130, AR_TIE2, at('2026-02-01T09:00')),
    version(110, AR_NULL, null),
    version(150, LIVE, at('2026-03-01T09:00'), { active: 1 }),
    version(160, DR_REQ, at('2026-04-01T09:00'), draft),
    version(170, DR_TIE, at('2026-04-01T09:00'), draft),
    version(105, DR_NULL1, null, draft),
    version(115, DR_NULL2, null, draft),
    version(180, CS_TIE1, at('2026-05-01T09:00'), inChangeset),
    version(190, CS_TIE2, at('2026-05-01T09:00'), inChangeset),
    version(200, CS_OLD, at('2026-04-15T09:00'), inChangeset),
    version(100, OTHER_ITEM_VERSION, at('2026-06-01T09:00'), { contentid: cfId('C', 2) }),
  ];
  await insert(tx, 'content', [...versions].sort((a, b) => Number(b.tcontent_id) - Number(a.tcontent_id)));
  await insert(
    tx,
    'approval_request',
    [
      [RQ_B, DR_REQ],
      [RQ_A, DR_REQ],
      [RQ_C, CS_TIE2],
    ].map(([requestid, contenthistid]) => ({ requestid, contenthistid, siteid: SITE, userid: cfId('U', 1), groupid: cfId('G', 1), status: 'Pending' })),
  );
  await insert(tx, 'changeset', [{ changesetid: CS, siteid: SITE, name: 'Summer', published: 0, publishdate: at('2026-07-01T00:00') }]);
}

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

/** Runs `fn` in a TENANT_A transaction that is then rolled back. */
async function inRolledBackA<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const rollback = new Error('rollback');
  let result: T | undefined;
  await inA(async (tx) => {
    result = await fn(tx);
    throw rollback;
  }).catch((err: unknown) => {
    if (err !== rollback) throw err;
  });
  return result as T;
}

/** Every batch `historyBatches` yields for `read` of `args`. */
async function batchesOf(tx: TenantTx, read: HistoryRead, args: typeof ARGS, batchSize?: number): Promise<Row[][]> {
  const batches: Row[][] = [];
  for await (const batch of historyBatches(tx, read, args, batchSize)) batches.push(batch);
  return batches;
}

const byReadAnd = <T>(values: readonly T[]): [HistoryRead, T][] => READS.flatMap((read) => values.map((value): [HistoryRead, T] => [read, value]));

describe.skipIf(!(await pgAvailable()))('repo/content-queries history paging and batches', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await inA(seed);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each(READS)('%s lists every row newest first, ties by tcontent_id then request id, nulls last', async (read) => {
    const rows = await inA((tx) => ALL_ROWS[read](tx, ARGS));
    expect(rows.map(rowKey)).toEqual(EXPECTED[read]);
    expect(Object.keys(rows[0] ?? {})).toEqual(COLUMNS[read]);
  });

  it.each(byReadAnd([1, 2, 3]))('historyPage pages %s by %i rows with its total', async (read, limit) => {
    const all = await inA((tx) => ALL_ROWS[read](tx, ARGS));
    const rows: Row[] = [];
    for (let offset = 0; offset < all.length; offset += limit) {
      const page = await inA((tx) => historyPage(tx, read, ARGS, { limit, offset }));
      expect(page.total).toBe(EXPECTED[read].length);
      expect(page.rows.length).toBe(Math.min(limit, all.length - offset));
      for (const row of page.rows) expect(Object.keys(row)).toEqual(COLUMNS[read]);
      rows.push(...page.rows);
    }
    expect(rows).toEqual(all);
    expect(await inA((tx) => historyPage(tx, read, ARGS, { limit }))).toEqual({ rows: all.slice(0, limit), total: all.length });
  });

  it.each(byReadAnd([0, 5]))('historyPage past the end of %s (offset total + %i) returns no rows with the total', async (read, beyond) => {
    const total = EXPECTED[read].length;
    expect(await inA((tx) => historyPage(tx, read, ARGS, { limit: 2, offset: total + beyond }))).toEqual({ rows: [], total });
  });

  it('historyPage counts nothing for unknown content', async () => {
    expect(await inA((tx) => historyPage(tx, 'hist', { contentId: cfId('Z', 9), siteId: SITE }, { limit: 10 }))).toEqual({ rows: [], total: 0 });
  });

  it.each(byReadAnd([1, 2, undefined]))('historyBatches reads every row of %s in batches of %s', async (read, batchSize) => {
    const [all, batches] = await inA(async (tx) => [await ALL_ROWS[read](tx, ARGS), await batchesOf(tx, read, ARGS, batchSize)] as const);
    const size = batchSize ?? HISTORY_BATCH_SIZE;
    expect(batches.map((batch) => batch.length)).toEqual(
      Array.from({ length: Math.ceil(all.length / size) }, (_, i) => Math.min(size, all.length - i * size)),
    );
    for (const row of batches.flat()) expect(Object.keys(row)).toEqual(COLUMNS[read]);
    expect(batches.flat()).toEqual(all);
  });

  it.each([1, undefined])('historyBatches yields no batch for unknown content in batches of %s', async (batchSize) => {
    expect(await inA((tx) => batchesOf(tx, 'hist', { contentId: cfId('Z', 9), siteId: SITE }, batchSize))).toEqual([]);
  });

  it('historyBatches neither repeats nor shifts rows when a newer version is saved between batches', async () => {
    const newest = cfId('H', 50);
    const [before, read, after] = await inRolledBackA(async (tx) => {
      const all = await hist(tx, ARGS);
      const batches = historyBatches(tx, 'hist', ARGS, 2);
      const first = await batches.next();
      await insert(tx, 'content', [version(null, newest, at('2026-08-01T09:00'))]);
      const rows: Row[] = first.done ? [] : [...first.value];
      for await (const batch of batches) rows.push(...batch);
      return [all, rows, await hist(tx, ARGS)] as const;
    });
    expect(read).toEqual(before);
    expect(after.map(rowKey)).toEqual([none(newest), ...EXPECTED.hist]);
  });

  it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
    ['limit 0', (tx) => historyPage(tx, 'hist', ARGS, { limit: 0 })],
    ['limit 1001', (tx) => historyPage(tx, 'hist', ARGS, { limit: 1001 })],
    ['limit 1.5', (tx) => historyPage(tx, 'hist', ARGS, { limit: 1.5 })],
    ['a negative offset', (tx) => historyPage(tx, 'hist', ARGS, { limit: 1, offset: -1 })],
    ['batch size 0', (tx) => historyBatches(tx, 'hist', ARGS, 0).next()],
  ])('rejects %s with a RangeError', async (_label, read) => {
    await expect(inA(read)).rejects.toBeInstanceOf(RangeError);
  });

  it('makes historyPage and historyBatches wait out an executing window and fail with UnitReadBlockedError', async () => {
    const holderId = `window-${randomUUID()}`;
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId, phase: 'executing', allowLegacy: true });
    try {
      const reads: [string, (tx: TenantTx) => Promise<unknown>][] = [
        ['historyPage', (tx) => historyPage(tx, 'hist', ARGS, { limit: 1 })],
        ['historyBatches', (tx) => historyBatches(tx, 'hist', ARGS).next()],
      ];
      for (const [label, read] of reads) {
        const err = await withGatedTenant(handle.app, TENANT_A.tenantId, read, { budgetMs: 200 }).catch((caught: unknown) => caught);
        expect(err, label).toBeInstanceOf(UnitReadBlockedError);
      }
    } finally {
      await openGates(handle.app, { units: CONTENT_UNITS, holderId, state: 'legacy' });
    }
  });
});
