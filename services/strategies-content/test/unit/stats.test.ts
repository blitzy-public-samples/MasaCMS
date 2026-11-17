/** Content stats and ratings: the stats bean's defaults, setters and value struct, its load/save, the comment stat, the rating reads and save, and the JSON API `stats` findOne route. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  STATS_DEFAULTS,
  getAvgRating,
  getTopRated,
  loadStats,
  readRate,
  saveRate,
  saveStatsInTx,
  setCommentStat,
  setStatsValues,
  statsValues,
  storedRate,
  type ContentStats,
} from '../../src/domain/stats.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS, UNIT_OF } from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

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
  it('STATS_DEFAULTS holds the contentStatsBean init values: zero counts and versions, empty keys and lock', () => {
    expect(STATS_DEFAULTS).toEqual({
      contentID: '',
      siteID: '',
      views: 0,
      rating: 0,
      totalVotes: 0,
      upVotes: 0,
      downVotes: 0,
      comments: 0,
      disableComments: 0,
      majorVersion: 0,
      minorVersion: 0,
      lockID: '',
      lockType: '',
    });
  });

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

describe('storedRate', () => {
  // Own oracle: the rate tcontentratings stored for each posted rate, or undefined where the save answered the error page.
  it.each<[string, number | undefined]>([
    ['4', 4],
    [' 4 ', 4],
    ['2.7', 2],
    ['2.99999999999999999999', 2],
    ['-3', -3],
    ['+3', 3],
    ['-0.5', 0],
    ['.5', 0],
    ['5.', 5],
    ['00007', 7],
    ['1e2', 100],
    ['1E+1', 10],
    ['4.5e0', 4],
    ['1e-400', 0],
    ['2147483647.9', 2147483647],
    ['2147483647.9e0', 2147483647],
    ['-2147483648.5', -2147483648],
    [`${'0'.repeat(42)}1`, 1],
    [`0.${'0'.repeat(37)}1`, 0],
    [`0.${'0'.repeat(38)}1`, undefined],
    [`1.${'0'.repeat(40)}`, undefined],
    ['2147483648', undefined],
    ['3000000000', undefined],
    ['-2147483649', undefined],
    ['1e10', undefined],
    ['1e309', undefined],
    ['abc', undefined],
    ['', undefined],
    ['1d', undefined],
    ['0x10', undefined],
    ['1,000', undefined],
  ])('stores the rate %j as %j', (rate, expected) => {
    expect(storedRate(rate)).toBe(expected);
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

  it.each<[string, number, boolean, number[], 'insert' | 'approve' | 'delete', number]>([
    ['new comments on an item without a stats row', 11, false, [], 'insert', 2],
    ['new comments on an item with a stats row', 12, true, [1], 'insert', 3],
    ['approvals on an item without a stats row', 13, false, [0, 0], 'approve', 2],
    ['approvals on an item with a stats row', 14, true, [0, 0], 'approve', 2],
    ['deletes on an item without a stats row', 15, false, [1, 1], 'delete', 0],
    ['deletes on an item with a stats row', 16, true, [1, 1], 'delete', 0],
  ])('setCommentStat in concurrent transactions with %s stores the committed count', async (_label, n, statsRow, approved, kind, expected) => {
    const contentId = cfId('W', n);
    const comment = { contentid: contentId, siteid: SITE, entered: NOW, name: 'n', isapproved: 1, isspam: 0, isdeleted: 0 };
    const ids = await inA(async (tx) => {
      const stored: string[] = [];
      for (const isapproved of approved) {
        stored.push((await repo.comments.insertComment(tx, { ...comment, isapproved })).commentid);
      }
      return stored;
    });
    if (statsRow) {
      await inA((tx) => setCommentStat(tx, repo, contentId, SITE));
    }
    expect((await inA((tx) => repo.stats.readStats(tx, { contentId, siteId: SITE }))) !== null).toBe(statsRow);
    const change = (tx: TenantTx, i: number): Promise<unknown> =>
      kind === 'insert'
        ? repo.comments.insertComment(tx, comment)
        : kind === 'approve'
          ? repo.comments.setApproved(tx, { commentId: ids[i] as string, isApproved: 1 })
          : repo.comments.setDeleted(tx, { commentId: ids[i] as string, isDeleted: 1 });
    let release: () => void = () => undefined;
    let counted: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const statSet = new Promise<void>((resolve) => (counted = resolve));
    // The first transaction stays open after its stat until the second is seen waiting on a lock.
    const first = inA(async (tx) => {
      await change(tx, 0);
      await setCommentStat(tx, repo, contentId, SITE);
      counted();
      await held;
    });
    await Promise.race([statSet, first]);
    const outcome = inA(async (tx) => {
      await change(tx, 1);
      return setCommentStat(tx, repo, contentId, SITE);
    }).catch((err: unknown) => err);
    let settled = false;
    void outcome.then(() => (settled = true));
    const waiting = async (): Promise<boolean> =>
      (await handle.adminPool.query('SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.usename = $1', [handle.roles.app])).rows.length > 0;
    while (!settled && !(await waiting())) await new Promise((resolve) => setTimeout(resolve, 20));
    const blocked = !settled;
    release();
    await first;
    const second = await outcome;
    expect(blocked).toBe(true);
    expect(second).not.toBeInstanceOf(Error);
    expect((second as ContentStats).comments).toBe(expected);
    expect((await inA((tx) => repo.stats.readStats(tx, { contentId, siteId: SITE })))?.comments).toBe(expected);
  });

  it('saveRate keeps the comment and version stats a concurrent writer commits while the rating waits on the item lock', async () => {
    const contentId = cfId('V', 1);
    await inA(async (tx) => {
      await saveStatsInTx(tx, repo, { ...STATS_DEFAULTS, contentID: contentId, siteID: SITE, views: 5 });
      await repo.comments.insertComment(tx, { contentid: contentId, siteid: SITE, entered: NOW, name: 'n', isapproved: 1, isspam: 0, isdeleted: 0 });
    });
    let release: () => void = () => undefined;
    let written: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const statsWritten = new Promise<void>((resolve) => (written = resolve));
    // The competing transaction holds the item lock after its stats writes until the rating is seen waiting.
    const competing = inA(async (tx) => {
      await setCommentStat(tx, repo, contentId, SITE);
      await repo.stats.setVersionNumbers(tx, { contentId, siteId: SITE, majorVersion: 3, minorVersion: 2 });
      written();
      await held;
    });
    await Promise.race([statsWritten, competing]);
    const rating = withGatedTenant(handle.app, TENANT_A.tenantId, (tx) =>
      saveRate(tx, repo, { contentId, siteId: SITE, userId: cfId('U', 1), rate: 5, now: NOW }, { requestId: 'stats-test' }),
    ).catch((err: unknown) => err);
    let settled = false;
    void rating.then(() => (settled = true));
    const waiting = async (): Promise<boolean> =>
      (await handle.adminPool.query('SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.usename = $1', [handle.roles.app])).rows.length > 0;
    while (!settled && !(await waiting())) await new Promise((resolve) => setTimeout(resolve, 20));
    const blocked = !settled;
    release();
    await competing;
    expect(blocked).toBe(true);
    expect(await rating).toEqual({ theavg: 5, thecount: 1, upvotes: null, downvotes: null });
    expect(await inA((tx) => repo.stats.readStats(tx, { contentId, siteId: SITE }))).toMatchObject({
      views: 5,
      rating: 5,
      totalvotes: 1,
      upvotes: 1,
      downvotes: 0,
      comments: 1,
      majorversion: 3,
      minorversion: 2,
    });
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

const STATS_TABLE = /"content"\."content_stats"/;
const STORED_ID = cfId('M', 1);
const STORED_ROW = Object.freeze({
  tenant_id: TENANT_A.tenantId,
  contentid: STORED_ID,
  siteid: SITE,
  views: 12,
  rating: 3.5,
  totalvotes: 4,
  upvotes: 3,
  downvotes: 1,
  comments: 2,
  disablecomments: 1,
  majorversion: 2,
  minorversion: 1,
  lockid: cfId('U', 9),
  locktype: 'node',
});
const STORED_STATS: ContentStats = {
  contentID: STORED_ID,
  siteID: SITE,
  views: 12,
  rating: 3.5,
  totalVotes: 4,
  upVotes: 3,
  downVotes: 1,
  comments: 2,
  disableComments: 1,
  majorVersion: 2,
  minorVersion: 1,
  lockID: cfId('U', 9),
  lockType: 'node',
};

/** The verb and table a write statement names, e.g. `UPDATE "content"."content_stats"`. */
const writeTarget = (sql: string): string => /^(INSERT INTO|UPDATE|DELETE FROM) (\S+)/.exec(sql)?.slice(1, 3).join(' ') ?? sql;

describe('domain/stats over the recording database', () => {
  const memoryRepo = createContentRepository({ clock: TEST_CLOCK });
  let db: RecordingDb;
  const inMemory = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(db, TENANT_A.tenantId, fn);
  /** Answers every content_stats statement with the stored row, and its UPDATE with `updated`. */
  const storeRow = (updated: object = STORED_ROW): void =>
    db.respond(STATS_TABLE, (_params, sql) => [{ ...(/^UPDATE /.test(sql) ? updated : STORED_ROW) }]);

  beforeEach(() => {
    db = createRecordingDb();
    seedRecordingDb(db);
  });

  it('loadStats of a node without a stats row answers the defaults keyed to it with one tenant read and no write', async () => {
    const stats = await inMemory((tx) => loadStats(tx, memoryRepo, IDS.content.pageOne, SITE));
    expect(stats).toEqual({ ...STATS_DEFAULTS, contentID: IDS.content.pageOne, siteID: SITE });
    expect(db.statements.filter((s) => STATS_TABLE.test(s.sql)).map((s) => s.tenantId)).toEqual([TENANT_A.tenantId]);
    expect(db.writes()).toEqual([]);
  });

  it('loadStats overlays a stored row on the defaults as a loaded bean, which statsValues keys as getAllValues does, and writes nothing', async () => {
    storeRow();
    const stats = await inMemory((tx) => loadStats(tx, memoryRepo, STORED_ID, SITE));
    expect(stats).toEqual({ ...STORED_STATS, isNew: 0 });
    expect(statsValues(stats)).toEqual({ ...STORED_STATS, isNew: 0 });
    expect(Object.keys(statsValues(stats))).toEqual([...Object.keys(STATS_DEFAULTS), 'isNew']);
    expect(db.writes()).toEqual([]);
  });

  it('saveStatsInTx inserts a missing row in one content_stats write, under the unit write gate and logged in the changelog', async () => {
    expect(await inMemory((tx) => saveStatsInTx(tx, memoryRepo, STORED_STATS))).toEqual(STORED_STATS);
    const writes = db.writes();
    expect(writes.map(({ sql }) => writeTarget(sql))).toEqual(['INSERT INTO "content"."content_stats"', 'INSERT INTO "content"."changelog"']);
    expect(writes[0]?.params).toEqual([TENANT_A.tenantId, STORED_ID, SITE, 12, 3.5, 4, 3, 1, 2, 1, 2, 1, cfId('U', 9), 'node']);
    expect(writes[1]?.params.slice(1, 3)).toEqual(['content_stats', 'insert']);
    const gate = db.statements.findIndex(
      (s) => /"unit_gate" .*FOR SHARE$/.test(s.sql) && JSON.stringify(s.params).includes(UNIT_OF.content_stats),
    );
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(db.statements.indexOf(writes[0] as (typeof db.statements)[number]));
  });

  it('saveStatsInTx updates a stored row in one content_stats write, storing an empty lock as NULL, logged as an update', async () => {
    storeRow({ ...STORED_ROW, views: 13, lockid: null, locktype: null });
    const changed: ContentStats = { ...STORED_STATS, views: 13, lockID: '', lockType: '', isNew: 0 };
    expect(await inMemory((tx) => saveStatsInTx(tx, memoryRepo, changed))).toEqual(changed);
    const writes = db.writes();
    expect(writes.map(({ sql }) => writeTarget(sql))).toEqual(['UPDATE "content"."content_stats"', 'INSERT INTO "content"."changelog"']);
    expect(writes[0]?.params.slice(0, 11)).toEqual([13, 3.5, 4, 3, 1, 2, 1, 2, 1, null, null]);
    expect(writes[1]?.params.slice(1, 3)).toEqual(['content_stats', 'update']);
  });

  it('saveStatsInTx writes nothing while legacy holds the stats unit', async () => {
    db.setGate(UNIT_OF.content_stats, 'legacy');
    await expect(inMemory((tx) => saveStatsInTx(tx, memoryRepo, STORED_STATS))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(db.writes()).toEqual([]);
  });
});

describe('JSON API stats findOne route', () => {
  const node = IDS.content.pageOne;
  const api = `http://localhost/index.cfm/_api/json/v1/${SITE}`;
  let t: TestApp;

  const getStats = async (subject: ContentSubject): Promise<{ status: number; body: unknown }> => {
    t.db.clear();
    const res = await t.app.inject({ method: 'GET', url: `/_api/json/v1/${SITE}/stats/${node}`, headers: await contentHeaders(subject, { site: SITE }) });
    return { status: res.statusCode, body: JSON.parse(res.body) as unknown };
  };

  beforeAll(async () => {
    const db = createRecordingDb();
    seedRecordingDb(db);
    t = await buildTestApp({ db });
  });

  afterAll(async () => {
    await t?.close();
  });

  it.each<ContentSubject>(['s2', 'site-admin', 'editor'])(
    'answers %s the recorded bean defaults of a node without a stats row in the envelope, writing nothing',
    async (subject) => {
      expect(await getStats(subject)).toEqual({
        status: 200,
        body: {
          apiversion: 'v1',
          method: 'findOne',
          data: {
            ...RECORDED_NO_ROW_JSON,
            contentid: node,
            siteid: SITE,
            id: node,
            links: {
              entities: api,
              all: `${api}/stats`,
              properties: `${api}/stats/properties`,
              self: `${api}/stats/${node}`,
              permissions: `${api}/stats/${node}/permissions`,
              content: `${api}/content/${node}`,
              site: `${api}/site`,
            },
            entityname: 'stats',
          },
        },
      });
      expect(t.db.statements.some((s) => STATS_TABLE.test(s.sql))).toBe(true);
      expect(t.db.writes()).toEqual([]);
    },
  );

  it.each<ContentSubject>(['anonymous', 'member', 'system-user'])(
    'answers %s, who lacks the content module, the legacy authorization error without reading stats',
    async (subject) => {
      expect(await getStats(subject)).toEqual({
        status: 401,
        body: { apiversion: 'v1', method: 'findOne', error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } },
      });
      expect(t.db.statements.some((s) => STATS_TABLE.test(s.sql))).toBe(false);
      expect(t.db.writes()).toEqual([]);
    },
  );
});
