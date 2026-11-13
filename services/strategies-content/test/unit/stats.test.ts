/** Content stats and ratings: the stats bean's defaults, setters and value struct, its load/save, the comment stat and the rating reads. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  STATS_DEFAULTS,
  getAvgRating,
  getTopRated,
  loadStats,
  readRate,
  saveStatsInTx,
  setCommentStat,
  setStatsValues,
  statsValues,
  type ContentStats,
} from '../../src/domain/stats.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const SITE = TENANT_A.siteId;
const HOME_ID = '00000000000000000000000000000000001';

// commentsProxy.getContentStats for an item without a stats row, recorded from the legacy oracle (site `default`).
const RECORDED_NO_ROW_JSON = JSON.parse(
  '{"contentid":"00000000000000000000000000000000001","downvotes":0,"totalvotes":0,"majorversion":0,"minorversion":0,' +
    '"locktype":"","comments":0,"siteid":"default","disablecomments":0,"lockid":"","views":0,"rating":0,"upvotes":0}',
) as Record<string, unknown>;

const lowerKeys = (values: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));

describe('STATS_DEFAULTS and statsValues', () => {
  it('reproduce the recorded getContentStats struct of an item without a stats row', () => {
    const values = statsValues({ ...STATS_DEFAULTS, contentID: HOME_ID, siteID: 'default' });
    expect(lowerKeys(values)).toEqual(RECORDED_NO_ROW_JSON);
    expect(Object.keys(values)).toEqual([
      'contentID', 'siteID', 'views', 'rating', 'totalVotes', 'upVotes', 'downVotes', 'comments', 'disableComments',
      'majorVersion', 'minorVersion', 'lockID', 'lockType',
    ]);
    expect(Object.isFrozen(STATS_DEFAULTS)).toBe(true);
  });

  it('add isNew 0 for loaded stats, as bean.set of a non-empty query does', () => {
    const values = statsValues({ ...STATS_DEFAULTS, isNew: 0 });
    expect(Object.keys(lowerKeys(values)).sort()).toEqual([...Object.keys(RECORDED_NO_ROW_JSON), 'isnew'].sort());
    expect(values.isNew).toBe(0);
  });

  it('pass every field through its setter over the defaults, matching keys case-insensitively', () => {
    expect(statsValues({ VIEWS: '12', Rating: ' 3.5 ', totalvotes: 'x', CONTENTID: '  C  ', lockid: null, tenant_id: 'ignored' })).toEqual({
      ...STATS_DEFAULTS,
      views: 12,
      rating: 3.5,
      contentID: 'C',
    });
  });
});

describe('setStatsValues', () => {
  const base: ContentStats = { ...STATS_DEFAULTS, views: 7, lockID: 'L' };

  it.each<[string, unknown, number]>([
    ['a number', 4, 4],
    ['decimal text', '2.25', 2.25],
    ['padded text', '\t9 ', 9],
    ['exponent text', '1e3', 1000],
    ['non-numeric text', 'abc', 7],
    ['empty text (a NULL column)', '', 7],
    ['null', null, 7],
    ['NaN', Number.NaN, 7],
    ['Infinity', Number.POSITIVE_INFINITY, 7],
    ['an overflowing decimal', '1e309', 7],
    ['a boolean', true, 7],
  ])('setViews with %s stores %j', (_label, value, expected) => {
    expect(setStatsValues(base, { views: value }).views).toBe(expected);
  });

  it.each<[unknown, string]>([
    ['  U  ', 'U'],
    [null, ''],
    [5, '5'],
  ])('setValue stores lockID %j as %j', (value, expected) => {
    expect(setStatsValues(base, { lockID: value }).lockID).toBe(expected);
  });

  it('ignores undefined values and leaves the input unchanged', () => {
    expect(setStatsValues(base, { views: undefined, lockType: undefined })).toEqual(base);
    setStatsValues(base, { views: 1 });
    expect(base.views).toBe(7);
  });
});

let handle: ThrowawaySchema;
let repo: ContentRepository;

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);

async function rate(contentId: string, rates: readonly (number | null)[], siteId = SITE): Promise<void> {
  await inA(async (tx) => {
    for (const [n, value] of rates.entries()) {
      await repo.platform.insert(tx, 'content_rating', { contentid: contentId, userid: cfId('U', n + 1), siteid: siteId, rate: value, entered: NOW });
    }
  });
}

describe.skipIf(!(await pgAvailable()))('domain/stats over a throwaway content schema', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'stats-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'stats-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('loadStats returns the trimmed key over the defaults without inserting a row when none exists', async () => {
    const stats = await inA((tx) => loadStats(tx, repo, ` ${cfId('S', 1)} `, SITE));
    expect(stats).toEqual({ ...STATS_DEFAULTS, contentID: cfId('S', 1), siteID: SITE });
    expect('isNew' in stats).toBe(false);
    expect(await inA((tx) => repo.stats.readStats(tx, { contentId: cfId('S', 1), siteId: SITE }))).toBeNull();
  });

  it('saveStatsInTx inserts the row, then updates it, and loadStats reads it back as loaded', async () => {
    const key = { ...STATS_DEFAULTS, contentID: cfId('S', 2), siteID: SITE };
    const inserted = await inA((tx) => saveStatsInTx(tx, repo, { ...key, views: 3, lockID: cfId('U', 9), lockType: 'node' }));
    expect(inserted).toEqual({ ...key, views: 3, lockID: cfId('U', 9), lockType: 'node' });
    const loaded = await inA((tx) => loadStats(tx, repo, key.contentID, SITE));
    expect(loaded).toEqual({ ...inserted, isNew: 0 });
    const updated = await inA((tx) => saveStatsInTx(tx, repo, { ...loaded, lockID: '', lockType: '', majorVersion: 2, minorVersion: 1, rating: 4.5 }));
    expect(updated).toEqual({ ...loaded, lockID: '', lockType: '', majorVersion: 2, minorVersion: 1, rating: 4.5 });
    const stored = await inA((tx) => repo.stats.readStats(tx, { contentId: key.contentID, siteId: SITE }));
    expect(stored).toMatchObject({ views: 3, rating: 4.5, majorversion: 2, minorversion: 1, lockid: null, locktype: null });
    expect(statsValues(await inA((tx) => loadStats(tx, repo, key.contentID, SITE)))).toMatchObject({ lockID: '', lockType: '', isNew: 0 });
  });

  it('setCommentStat counts only approved comments that are neither spam nor deleted, keeping the other stats', async () => {
    const contentId = cfId('S', 3);
    await inA((tx) => saveStatsInTx(tx, repo, { ...STATS_DEFAULTS, contentID: contentId, siteID: SITE, views: 5 }));
    await inA(async (tx) => {
      const comment = { contentid: contentId, siteid: SITE, entered: NOW, name: 'n' };
      await repo.comments.insertComment(tx, { ...comment, isapproved: 1, isspam: 0, isdeleted: 0 });
      await repo.comments.insertComment(tx, { ...comment, isapproved: 1, isspam: 0, isdeleted: 0 });
      await repo.comments.insertComment(tx, { ...comment, isapproved: 0, isspam: 0, isdeleted: 0 });
      await repo.comments.insertComment(tx, { ...comment, isapproved: 1, isspam: 1, isdeleted: 0 });
      await repo.comments.insertComment(tx, { ...comment, isapproved: 1, isspam: 0, isdeleted: 1 });
    });
    const stats = await inA((tx) => setCommentStat(tx, repo, contentId, SITE));
    expect(stats).toEqual({ ...STATS_DEFAULTS, contentID: contentId, siteID: SITE, views: 5, comments: 2, isNew: 0 });
    expect((await inA((tx) => loadStats(tx, repo, contentId, SITE))).comments).toBe(2);
    const fresh = await inA((tx) => setCommentStat(tx, repo, cfId('S', 4), SITE));
    expect(fresh).toEqual({ ...STATS_DEFAULTS, contentID: cfId('S', 4), siteID: SITE, comments: 0, isNew: 0 });
  });

  // Rows of the legacy getAvgRating query, recorded on SQL Server 2022 over the same ratings.
  it.each<[string, number, (number | null)[], unknown]>([
    ['no ratings', 1, [], null],
    ['one rating of 4', 2, [4], { theavg: 4, thecount: 1, upvotes: null, downvotes: null }],
    ['one rating of 1', 3, [1], { theavg: 1, thecount: 1, upvotes: 0, downvotes: 1 }],
    ['ratings 1, 4 and 5', 4, [1, 4, 5], { theavg: 3, thecount: 3, upvotes: 2, downvotes: 1 }],
    ['ratings 2 and 3', 5, [2, 3], { theavg: 2, thecount: 2, upvotes: null, downvotes: null }],
    ['a NULL rate and 5', 6, [null, 5], { theavg: 5, thecount: 2, upvotes: null, downvotes: null }],
  ])('getAvgRating with %s matches the recorded legacy row', async (_label, n, rates, expected) => {
    const contentId = cfId('R', n);
    await rate(contentId, rates);
    expect(await inA((tx) => getAvgRating(tx, repo, contentId, SITE))).toEqual(expected);
  });

  it('readRate returns the stored rating with trimmed keys, or the rate bean defaults', async () => {
    const contentId = cfId('Q', 1);
    await rate(contentId, [4, null]);
    const stored = await inA((tx) => readRate(tx, repo, { contentId, siteId: SITE, userId: cfId('U', 1), now: NOW }));
    expect(stored).toEqual({ contentID: contentId, userID: cfId('U', 1), siteID: SITE, entered: NOW, rate: 4, isNew: 0 });
    const nullRate = await inA((tx) => readRate(tx, repo, { contentId, siteId: SITE, userId: cfId('U', 2) }));
    expect(nullRate).toMatchObject({ rate: 0, isNew: 0 });
    const later = new Date(2026, 6, 1);
    const none = await inA((tx) => readRate(tx, repo, { contentId: ` ${contentId}`, siteId: SITE, userId: cfId('U', 3), now: later }));
    expect(none).toEqual({ contentID: contentId, userID: cfId('U', 3), siteID: SITE, entered: later, rate: 0, isNew: 1 });
  });

  it('getTopRated joins the version file columns and drops the join key', async () => {
    const withFile = cfId('T', 1);
    const without = cfId('T', 2);
    await inA(async (tx) => {
      const file = await repo.files.insertFile(tx, { siteid: SITE, contentid: withFile, filename: 'a.pdf', fileext: 'pdf', contenttype: 'application', contentsubtype: 'pdf', filesize: 42 });
      const version = { siteid: SITE, type: 'File', subtype: 'Default', moduleid: '00000000000000000000000000000000000', active: 1, approved: 1, display: 1 };
      await repo.content.insertVersion(tx, { ...version, contentid: withFile, contenthistid: cfId('H', 1), fileid: file.fileid, title: 'With file' });
      await repo.content.insertVersion(tx, { ...version, type: 'Page', contentid: without, contenthistid: cfId('H', 2), title: 'Without file' });
    });
    await rate(withFile, [5, 5]);
    await rate(without, [2, 3]);
    const top = await inA((tx) => getTopRated(tx, repo, { siteId: SITE, threshold: 2, limit: 2 }));
    expect(top.map((row) => [row.contentid, row.theavg, row.thecount, row.filesize, row.fileext, row.contenttype, row.contentsubtype])).toEqual([
      [withFile, 5, 2, 42, 'pdf', 'application', 'pdf'],
      [without, 2, 2, null, null, null, null],
    ]);
    expect(top.every((row) => !('fileid' in row))).toBe(true);
    expect(await inA((tx) => getTopRated(tx, repo, { siteId: SITE, threshold: 3 }))).toEqual([]);
  });
});
