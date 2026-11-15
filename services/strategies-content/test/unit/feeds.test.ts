/** Collections (GS-CO-13) over the recording pool: cfeed gate, feed writes, cfeed.update, pooled feed content, remote import and the JSON API feed entity. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LEGACY_ERROR_MAP } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import type { ContentSaveSite } from '../../src/domain/content.js';
// configBean's defaults and the actor shape exist only in domain/context; a copy here would fork them.
import { CONTENT_CONFIG_DEFAULTS, type Actor } from '../../src/domain/context.js';
import {
  createFeed,
  deleteFeed,
  doAutoImport,
  feedAccess,
  feedContent,
  importRemoteFeed,
  listFeeds,
  readFeed,
  updateFeed,
  updateFeedAction,
  type FeedDeps,
  type FetchRemote,
} from '../../src/domain/feeds.js';
import { feedPoolSites } from '../../src/domain/pools.js';
// The start-up predicate is checked through its one implementation rather than a restatement.
import { violatesStartupPredicate } from '../../src/domain/startup-guard.js';
import { feedItemRemoteId, parseFeedXml, rssChannelItems } from '../../src/legacy/remote-feed.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, userHeaders, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, contentRow, feedRow, seedRecordingDb, tenantASeed } from '../helpers/seed.js';
import { contentHeaders } from '../helpers/tokens.js';

type Row = Record<string, unknown>;
type Deps = Parameters<typeof importRemoteFeed>[0];
type Repository = FeedDeps['repository'];
type FeedSeed = ReturnType<typeof feedRow>;
type Version = Awaited<ReturnType<Repository['content']['readActiveByRemoteId']>>[number];

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SITE = TENANT_A.siteId;
const NOW = TEST_CLOCK.now();
const SECTION = IDS.content.section;
const LONG_NAME = 'Augusta Ada King, Countess of Lovelace, Baroness Wentworth of Nettlestead';
const ADMIN: Actor = {
  userId: 'C0000000-0000-0000-0000000000000005',
  fullName: LONG_NAME,
  isLoggedIn: true,
  s2: true,
  roles: ['s2'],
  siteId: SITE,
  tenantId: TENANT_A.tenantId,
};
const LIST_REDIRECT = { kind: 'redirect', action: 'cFeed.list', append: ['siteid'] };
const REMOTE_NEWS_URL = 'https://feeds.example.org/opt2.rss';
const EXTRA = Object.freeze({
  pooled: 'A9000000-0000-0000-0000000000000010',
  listed: 'A9000000-0000-0000-0000000000000011',
  locked: 'A9000000-0000-0000-0000000000000012',
  dormant: 'A9000000-0000-0000-0000000000000013',
  importedNode: 'A1000000-0000-0000-0000000000000099',
});

/** tenant-a's seeded collections: Latest News (local), Remote News (autoimport) and Remote Digest. */
const SEEDED_FEEDS: readonly FeedSeed[] = tenantASeed()
  .rows.filter(({ table }) => table.table === 'feed')
  .map(({ row }) => row as FeedSeed);

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Remote News</title>
<item><title>First</title><link>https://feeds.example.org/1</link><guid>opt2-item-1</guid><pubDate>Tue, 10 Jun 2025 04:00:00 GMT</pubDate><description>First body</description></item>
<item><title>Second</title><link>https://feeds.example.org/2</link><pubDate>Wed, 11 Jun 2025 04:00:00 GMT</pubDate><description>Second body</description></item>
</channel></rss>`;
const [FIRST_ID = '', SECOND_ID = ''] = rssChannelItems(parseFeedXml(RSS)).map((item) => feedItemRemoteId(item));

const SITE_SETTINGS: ContentSaveSite = {
  siteId: SITE,
  site: 'Tenant A',
  locking: 'None',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentPendingScript: '',
  contentCanceledScript: '',
  contactEmail: '',
  urls: {
    siteId: SITE,
    scheme: 'http',
    domain: 'tenant-a.opt2.test',
    requestDomain: 'tenant-a.opt2.test',
    previewDomain: '',
    serverPort: '',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: TENANT_UMBRELLA.siteId,
    configFileAssetPath: '',
    assetPath: '',
    siteAssetPath: '',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

const FEED_READ = /^SELECT tcontentfeeds\.feedid\b.* FROM "content"\."feed" tcontentfeeds WHERE /;
const FEED_LOCK = /^SELECT \* FROM "content"\."feed" WHERE .* FOR UPDATE$/;
const FEED_UPDATE = /^UPDATE "content"\."feed" SET (.+) WHERE "tenant_id" = \$\d+ AND "feedid" = \$(\d+) RETURNING \*$/;
const FEED_DELETE = /^DELETE FROM "content"\."feed" WHERE /;
const CONTENT_INSERT = /^INSERT INTO "content"\."content" \(/;
const FEED_CONTENT_READ = /^SELECT tcontent\.siteid AS siteid\b/;

/** The recording pool, its domain collaborators, the feed rows its feed responders read and write, and the active versions its remote-id lookup answers. */
interface Pool {
  db: RecordingDb;
  deps: Deps;
  feeds: FeedSeed[];
  versions: Version[];
}

const lower = (value: unknown): string => String(value ?? '').toLowerCase();

/** Column values of a recorded `INSERT INTO t (columns) VALUES ($1, …)`, the one-row form the platform repository writes. */
function valuesOf(sql: string, params: readonly unknown[]): Row {
  const columns = /^INSERT INTO \S+ \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  return Object.fromEntries(columns.split(', ').map((column, at) => [column.replaceAll('"', ''), params[at] ?? null]));
}

/** Every row the pool was asked to insert into `content.<table>`, in order. */
function inserted(db: RecordingDb, table: string): Row[] {
  return db.statements.filter(({ sql }) => sql.startsWith(`INSERT INTO "content"."${table}" (`)).map(({ sql, params }) => valuesOf(sql, params));
}

/** The `"column" = $n` assignments and keys of every recorded UPDATE of `content.<table>`. */
function updated(db: RecordingDb, table: string): Row[] {
  return db.statements
    .filter(({ sql }) => sql.startsWith(`UPDATE "content"."${table}" SET `))
    .map(({ sql, params }) => Object.fromEntries([...sql.matchAll(/"(\w+)" = \$(\d+)/g)].map(([, column = '', at = '0']) => [column, params[Number(at) - 1]])));
}

/** The content tables written, in order, as `<verb> <table>`; the changelog row each write carries is left out. */
function writtenTables(db: RecordingDb): string[] {
  return db.writes().flatMap(({ sql }) => {
    const [, verb = '', table = ''] = /^(INSERT|UPDATE|DELETE)\b.*?"content"\."(\w+)"/.exec(sql) ?? [];
    return table === '' || table === 'changelog' ? [] : [`${verb.toLowerCase()} ${table}`];
  });
}

/**
 * The recording pool over the content seed with `extraFeeds` beside the seeded collections. A fresh pool per test, as
 * registry writes outlive `reset`.
 */
function createPool(extraFeeds: readonly FeedSeed[] = []): Pool {
  const db = createRecordingDb();
  seedRecordingDb(db);
  const feeds = [...SEEDED_FEEDS, ...extraFeeds].map((row) => ({ ...row }));
  const versions: Version[] = [];
  const stored = (tenantId: string | null, ids: readonly unknown[]): FeedSeed[] =>
    feeds.filter((row) => row.tenant_id === tenantId && ids.map(lower).includes(lower(row.feedid)));
  // The seed answers a read with every row of its table; feeds answer by id, or by listFeeds' site, type and flags.
  db.respond(FEED_READ, (params, sql, { tenantId }) => {
    if (Array.isArray(params[0])) return stored(tenantId, params[0]);
    return feeds
      .filter(
        (row) =>
          row.tenant_id === tenantId &&
          row.siteid === params[0] &&
          lower(row.type) === lower(params[1]) &&
          (!sql.includes('tcontentfeeds.ispublic = 1') || row.ispublic === 1) &&
          (!sql.includes('tcontentfeeds.isactive = 1') || row.isactive === 1),
      )
      .sort((a, b) => lower(a.name).localeCompare(lower(b.name)) || a.feedid.localeCompare(b.feedid));
  });
  db.respond(FEED_LOCK, (params, _sql, { tenantId }) => stored(tenantId, params.slice(1).flat()));
  db.respond(FEED_UPDATE, (params, sql, { tenantId }) => {
    const [, assignments = '', keyAt = '0'] = FEED_UPDATE.exec(sql) ?? [];
    const [row] = stored(tenantId, [params[Number(keyAt) - 1]]);
    if (row === undefined) return [];
    for (const [, column = '', at = '0'] of assignments.matchAll(/"(\w+)" = \$(\d+)/g)) Object.assign(row, { [column]: params[Number(at) - 1] });
    return [{ ...row }];
  });
  db.respond(FEED_DELETE, (params, _sql, { tenantId }) => {
    const [row] = stored(tenantId, params.slice(1));
    if (row === undefined) return [];
    feeds.splice(feeds.indexOf(row), 1);
    return [row];
  });
  // PostgreSQL numbers the identity column, which the changelog encoding reads back.
  let identity = 0;
  db.respond(CONTENT_INSERT, (params, sql) => [{ ...valuesOf(sql, params), tcontent_id: (identity += 1) }]);
  const base = createContentRepository({ clock: TEST_CLOCK, schema: db.schema });
  // A content save probes remote ids and candidate filenames until a lookup finds none, which the seed never answers.
  const repository: Repository = {
    ...base,
    content: {
      ...base.content,
      readActiveByRemoteId: async (_tx, args) => versions.filter((version) => lower(version.remoteid) === lower(args.remoteId)),
      readActiveByFilename: async () => [],
    },
  };
  return { db, deps: { db, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS }, feeds, versions };
}

/** A fetch answering `body` for every URL and recording each URL asked for; nothing leaves the process. */
function fakeFetch(body = RSS): FetchRemote & { urls: string[] } {
  const urls: string[] = [];
  const fetchRemote: FetchRemote = async (url) => {
    urls.push(url);
    return { status: 200, body };
  };
  return Object.assign(fetchRemote, { urls });
}

/** An active tenant-a version as the content reads answer it, without file or approval joins. */
function versionRow(overrides: Parameters<typeof contentRow>[0]): Version {
  return {
    ...contentRow(overrides),
    filesize: null,
    contenttype: null,
    contentsubtype: null,
    fileext: null,
    assocfilename: null,
    approvalstatus: null,
    requestid: null,
    approvalgroupid: null,
  };
}

/** Lists tenant-b in tenant-a's registered content pool, as programs-sites.site.changed.v1 would. */
async function poolTenantB(db: RecordingDb): Promise<void> {
  await db.withMetadata((tx) =>
    tx.query('INSERT INTO content.tenant_registry (tenant_id, content_pool_ids, content_pool_tenants) VALUES ($1, $2, $3)', [
      TENANT_A.tenantId,
      [SITE, TENANT_B.siteId],
      [TENANT_A.tenantId, TENANT_B.tenantId],
    ]),
  );
}

describe('cfeed gate', () => {
  const holding = (roles: string[], s2 = false): Actor => ({ ...ADMIN, s2, roles });

  it.each([
    ['S2', true, holding(['s2'], true)],
    ['the site Admin role', true, holding(['site-admin'])],
    ['Collections with Site Manager', true, holding(['system-user', 'm:011', 'm:000'])],
    ['Collections alone', false, holding(['system-user', 'm:011'])],
  ])('answers %s with a collections manager: %s; without one: false', (_label, allowed, actor) => {
    expect(feedAccess(actor, { hasFeedManager: true })).toBe(allowed);
    expect(feedAccess(actor, { hasFeedManager: false })).toBe(false);
  });
});

describe('feed writes', () => {
  it('creates a feed stamped with the clock and the first 50 characters of the actor name', async () => {
    const { db, deps } = createPool();
    const bean = await createFeed(deps, ADMIN, { siteid: SITE, name: 'Fresh', type: 'Local' });
    expect(bean.errors).toEqual({});
    expect(inserted(db, 'feed')).toEqual([
      expect.objectContaining({ feedid: bean.text('feedid'), name: 'Fresh', siteid: SITE, lastupdate: NOW, lastupdateby: LONG_NAME.slice(0, 50) }),
    ]);
  });

  it('updates the stored feed with the same stamp', async () => {
    const { db, deps, feeds } = createPool();
    const bean = await updateFeed(deps, ADMIN, { feedid: IDS.feeds.local, name: 'Renamed' });
    expect(bean.errors).toEqual({});
    expect(updated(db, 'feed')).toEqual([
      expect.objectContaining({ feedid: IDS.feeds.local, name: 'Renamed', lastupdate: NOW, lastupdateby: LONG_NAME.slice(0, 50) }),
    ]);
    expect(feeds.find((row) => row.feedid === IDS.feeds.local)).toMatchObject({ name: 'Renamed', lastupdate: NOW });
  });

  it('leaves a locked feed and the trash untouched', async () => {
    const { db, deps, feeds } = createPool([feedRow({ feedid: EXTRA.locked, name: 'Locked', islocked: 1 })]);
    expect(await deleteFeed(deps, ADMIN, EXTRA.locked)).toMatchObject({ deleted: false, trash: null });
    expect(db.writes()).toEqual([]);
    expect(feeds.map((row) => row.feedid)).toContain(EXTRA.locked);
  });

  it('throws an unlocked feed into the trash as objectClass feed, then deletes its row', async () => {
    const { db, deps, feeds } = createPool();
    expect((await deleteFeed(deps, ADMIN, IDS.feeds.remoteManual)).deleted).toBe(true);
    expect(writtenTables(db)).toEqual(['insert trash', 'delete feed']);
    expect(inserted(db, 'trash')).toEqual([
      expect.objectContaining({ objectid: IDS.feeds.remoteManual, objectclass: 'feed', objectlabel: 'Remote Digest', objecttype: 'Remote', siteid: SITE }),
    ]);
    expect(feeds.map((row) => row.feedid)).not.toContain(IDS.feeds.remoteManual);
  });

  it("returns the site's local and remote collections as separate lists, inactive ones included", async () => {
    const { deps } = createPool([feedRow({ feedid: EXTRA.dormant, name: 'Archive', type: 'Remote', isactive: 0 })]);
    const { rsLocal, rsRemote } = await listFeeds(deps, ADMIN, SITE);
    expect(rsLocal.map((row) => row.name)).toEqual(['Latest News']);
    expect(rsRemote.map((row) => row.name)).toEqual(['Archive', 'Remote Digest', 'Remote News']);
  });
});

describe('cfeed.update', () => {
  it.each([
    ['add', { action: 'add', name: 'Added', type: 'Local' }, ['insert feed']],
    ['update', { action: 'update', feedid: IDS.feeds.local, name: 'Updated' }, ['update feed']],
    ['delete', { action: 'delete', feedid: IDS.feeds.remoteManual }, ['insert trash', 'delete feed']],
  ])('redirects to cFeed.list appending siteid after a successful %s', async (_label, rc, tables) => {
    const { db, deps } = createPool();
    expect(await updateFeedAction(deps, ADMIN, { siteid: SITE, ...rc })).toEqual(LIST_REDIRECT);
    expect(writtenTables(db)).toEqual(tables);
  });

  it('saves the edited display object params instead of the feed when an assignment and JSON instance params are posted', async () => {
    const { db, deps } = createPool();
    const rc = {
      siteid: SITE,
      action: 'update',
      feedid: IDS.feeds.local,
      name: 'Ignored',
      assignmentID: IDS.hist.sectionActive,
      regionID: 2,
      orderno: 1,
      instanceParams: '{"displaylist":"Title"}',
    };
    expect(await updateFeedAction(deps, ADMIN, rc)).toEqual(LIST_REDIRECT);
    expect(updated(db, 'feed')).toEqual([]);
    const objectLock = db.statements.find(({ sql }) => /^SELECT \* FROM "content"\."content_object" WHERE .* FOR UPDATE$/.test(sql));
    expect(objectLock?.params.flat()).toEqual(expect.arrayContaining([IDS.hist.sectionActive, 2, 1]));
  });

  it.each([
    ['add', { action: 'add', name: 'Invalid', lang: '' }],
    ['update', { action: 'update', feedid: IDS.feeds.local, lang: '' }],
  ])('re-renders the form with the bean errors and writes nothing when an %s fails validation', async (_label, rc) => {
    const { db, deps } = createPool();
    const outcome = await updateFeedAction(deps, ADMIN, { siteid: SITE, ...rc });
    expect(outcome.kind).toBe('rerender');
    expect(outcome.kind === 'rerender' ? outcome.feedBean.errors : undefined).toEqual({ lang: "The property named 'lang' is not valid" });
    expect(db.writes()).toEqual([]);
  });
});

describe('feedContent of a local feed', () => {
  const contentReadTenants = (db: RecordingDb): Array<string | null> =>
    db.statements.filter(({ sql }) => FEED_CONTENT_READ.test(sql)).map(({ tenantId }) => tenantId);

  /** The pooled feed as read, its content reads cleared from the recording. */
  async function pooledFeed(): Promise<{ pool: Pool; bean: Awaited<ReturnType<typeof readFeed>> }> {
    const pool = createPool([feedRow({ feedid: EXTRA.pooled, name: 'Pooled', contentpoolid: '*', maxitems: 0 })]);
    await poolTenantB(pool.db);
    const bean = await readFeed(pool.deps, ADMIN, { feedId: EXTRA.pooled });
    pool.db.clear();
    return { pool, bean };
  }

  it("reads contentPoolID '*' in one transaction per registered content-pool tenant and merges both sites' rows in the feed sort", async () => {
    const { pool, bean } = await pooledFeed();
    const sites = await feedPoolSites(pool.db, TENANT_A.tenantId, '*');
    expect(sites).toEqual([
      { siteId: SITE, tenantId: TENANT_A.tenantId },
      { siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId },
    ]);
    const rows = await feedContent(pool.deps, ADMIN, bean);
    expect(contentReadTenants(pool.db)).toEqual(sites.map((site) => site.tenantId));
    expect(new Set(rows.map((row) => row.siteid))).toEqual(new Set([SITE, TENANT_B.siteId]));
    const updatedAt = rows.map((row) => row.lastupdate?.getTime() ?? 0);
    expect(updatedAt).toEqual([...updatedAt].sort((a, b) => b - a));
  });

  it('cuts the merged rows at maxItems, and leaves paging by nextN to the iterator', async () => {
    const { pool, bean } = await pooledFeed();
    const all = await feedContent(pool.deps, ADMIN, bean);
    expect(all.length).toBeGreaterThan(3);
    bean.setValue('nextN', 2);
    expect(await feedContent(pool.deps, ADMIN, bean)).toEqual(all);
    bean.setValue('maxItems', 3);
    expect(await feedContent(pool.deps, ADMIN, bean)).toEqual(all.slice(0, 3));
  });

  it('merges the content-pool sites in the sort the feed names', async () => {
    const { pool, bean } = await pooledFeed();
    bean.setValue('sortBy', 'title');
    bean.setValue('sortDirection', 'asc');
    const titles = (await feedContent(pool.deps, ADMIN, bean)).map((row) => lower(row.title));
    expect(titles).toEqual([...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('reads only the own site when a listed contentPoolID names a site outside the registered content pool', async () => {
    const listed = `${SITE},${TENANT_B.siteId}`;
    const pool = createPool([feedRow({ feedid: EXTRA.listed, name: 'Listed', contentpoolid: listed })]);
    expect(await feedPoolSites(pool.db, TENANT_A.tenantId, listed)).toEqual([{ siteId: SITE, tenantId: TENANT_A.tenantId }]);
    const bean = await readFeed(pool.deps, ADMIN, { feedId: EXTRA.listed });
    pool.db.clear();
    const rows = await feedContent(pool.deps, ADMIN, bean);
    expect(contentReadTenants(pool.db)).toEqual([TENANT_A.tenantId]);
    expect(pool.db.statements.filter(({ tenantId }) => tenantId === TENANT_B.tenantId)).toEqual([]);
    expect(new Set(rows.map((row) => row.siteid))).toEqual(new Set([SITE]));
  });

  it.each([
    ['expands the listed category through its descendants in the category-pool tenant', 0, true],
    ['filters by the listed category alone under useCategoryIntersect', 1, false],
  ])('%s', async (_label, intersect, readsCategoryPool) => {
    const pool = createPool();
    const bean = await readFeed(pool.deps, ADMIN, { feedId: IDS.feeds.local });
    bean.setValue('categoryID', IDS.categories.pooledChild);
    bean.setValue('useCategoryIntersect', intersect);
    pool.db.clear();
    await feedContent(pool.deps, ADMIN, bean);
    const categoryReads = pool.db.statements.filter(({ sql, tenantId }) => tenantId === TENANT_UMBRELLA.tenantId && sql.includes('"content"."category"'));
    expect(categoryReads.length > 0).toBe(readsCategoryPool);
    const [contentRead] = pool.db.statements.filter(({ sql }) => FEED_CONTENT_READ.test(sql));
    expect(contentRead?.params.flat()).toContain(IDS.categories.pooledChild);
  });
});

describe('remote import', () => {
  /** The content rows the import's saves wrote, after checking each reached the pool as an INSERT. */
  const writtenVersions = (db: RecordingDb, result: Awaited<ReturnType<typeof importRemoteFeed>>) => {
    const written = result.saves.flatMap((save) => save.written);
    expect(inserted(db, 'content').map((row) => row.contenthistid)).toEqual(written.map((row) => row.contenthistid));
    return written;
  };

  it("saves each RSS item, last visible first, as a Page version under the feed's parent with the item's remote id, none matching the start-up predicate", async () => {
    const { db, deps } = createPool();
    const fetchRemote = fakeFetch();
    const result = await importRemoteFeed(deps, ADMIN, SITE_SETTINGS, { feedId: IDS.feeds.remoteAuto, remoteId: 'All' }, fetchRemote);
    expect(fetchRemote.urls).toEqual([REMOTE_NEWS_URL]);
    expect(result.success).toBe(true);
    const written = writtenVersions(db, result);
    expect(written.map((row) => [row.title, row.remoteid, row.parentid, row.siteid, row.type])).toEqual([
      ['Second', SECOND_ID, SECTION, SITE, 'Page'],
      ['First', FIRST_ID, SECTION, SITE, 'Page'],
    ]);
    expect(new Set(written.map((row) => row.contentid)).size).toBe(2);
    expect(written.filter((row) => violatesStartupPredicate(row))).toEqual([]);
  });

  it('saves a new version of the node already holding an item remote id rather than a second node', async () => {
    const pool = createPool();
    const existing = versionRow({ contentid: EXTRA.importedNode, parentid: SECTION, remoteid: FIRST_ID, title: 'First', filename: 'section/first' });
    pool.versions.push(existing);
    const result = await importRemoteFeed(pool.deps, ADMIN, SITE_SETTINGS, { feedId: IDS.feeds.remoteAuto, remoteId: 'All' }, fakeFetch());
    const written = writtenVersions(pool.db, result);
    expect(written.map((row) => row.remoteid)).toEqual([SECOND_ID, FIRST_ID]);
    const reimported = written.filter((row) => row.contentid === EXTRA.importedNode);
    expect(reimported.map((row) => row.remoteid)).toEqual([FIRST_ID]);
    expect(reimported[0]?.contenthistid).not.toBe(existing.contenthistid);
  });
});

describe('doAutoImport', () => {
  // The step route answers 400 for a site the registry does not hold; the domain step itself imports nothing for it.
  it('imports and fetches nothing for a site the registry does not hold', async () => {
    const { db, deps } = createPool();
    const fetchRemote = fakeFetch();
    expect(await doAutoImport({ ...deps, siteId: 'no-such-site', fetchRemote, siteFor: () => SITE_SETTINGS })).toEqual({ siteId: 'no-such-site', imports: [] });
    expect(fetchRemote.urls).toEqual([]);
    expect(db.statements.filter(({ sql }) => FEED_READ.test(sql))).toEqual([]);
  });

  it('fetches only the active remote feeds marked autoimport = 1', async () => {
    const dormant = feedRow({ feedid: EXTRA.dormant, name: 'Dormant', type: 'Remote', isactive: 0, autoimport: 1, parentid: SECTION, channellink: 'https://feeds.example.org/dormant.rss' });
    const pool = createPool([dormant]);
    const fetchRemote = fakeFetch();
    const result = await doAutoImport({ ...pool.deps, siteId: SITE, fetchRemote, siteFor: () => SITE_SETTINGS });
    expect(fetchRemote.urls).toEqual([REMOTE_NEWS_URL]);
    expect(result.imports.map((entry) => entry.feedBean.text('feedid'))).toEqual([IDS.feeds.remoteAuto]);
    const remoteList = pool.db.statements.find(({ sql, params }) => FEED_READ.test(sql) && params[1] === 'Remote');
    expect(remoteList?.sql).toContain('tcontentfeeds.isactive = 1');
  });
});

describe('routes over the composed app', () => {
  let t: TestApp;
  const collectionsOnly = (): Promise<Record<string, string>> =>
    userHeaders({ sub: 'C0000000-0000-0000-0000000000000011', site: SITE, roles: ['system-user', 'm:011'] });

  beforeAll(async () => {
    t = await buildTestApp({ db: createPool().db });
  });

  afterAll(async () => {
    await t?.close();
  });

  it.each(['', '?feedManager=0', '?hasFeedManager=false&feedmanager=no'])(
    'decides the cfeed.list gate from the verified roles alone, whatever the query says (%j)',
    async (query) => {
      const admitted = await t.app.inject({ method: 'GET', url: `/v1/sites/${SITE}/feeds${query}`, headers: await contentHeaders('site-admin') });
      expect(admitted.statusCode).toBe(200);
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: `/v1/sites/${SITE}/feeds`, status: 200, contentType: admitted.headers['content-type'], body: admitted.body });
      const { rc } = admitted.json() as { rc: { rsLocal: Row[]; rsRemote: Row[] } };
      expect([rc.rsLocal.map((row) => row.name), rc.rsRemote.map((row) => row.name)]).toEqual([['Latest News'], ['Remote Digest', 'Remote News']]);
      const refused = await t.app.inject({ method: 'GET', url: `/v1/sites/${SITE}/feeds${query}`, headers: await collectionsOnly() });
      expect(refused.statusCode).toBe(403);
    },
  );

  it('answers GET /_api/json/v1/tenant-a/feed/<id> with the stored feed', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/_api/json/v1/${SITE}/feed/${IDS.feeds.local}`, headers: await contentHeaders('site-admin') });
    expect(res.statusCode).toBe(200);
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: `/_api/json/v1/${SITE}/feed`, status: 200, contentType: res.headers['content-type'], body: res.body });
    expect(res.json()).toMatchObject({ data: { feedid: IDS.feeds.local, name: 'Latest News', siteid: SITE, type: 'Local' } });
  });

  /** A JSON API `feed` call of `method` for `subject`, with whether it read the site's feeds before answering. */
  async function feedMethod(method: string, subject: 'anonymous' | 'site-admin'): Promise<{ status: number; body: unknown; readFeeds: boolean }> {
    t.db.clear();
    const res = await t.app.inject({ method: 'GET', url: `/_api/json/v1/${SITE}/feed/?method=${method}&entityname=feed`, headers: await contentHeaders(subject) });
    assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: `/_api/json/v1/${SITE}/feed`, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return { status: res.statusCode, body: res.json(), readFeeds: t.db.statements.some(({ sql }) => sql.includes('"content"."feed"')) };
  }

  it.each(['anonymous', 'site-admin'] as const)(
    'answers feed.findAll for %s with 400 invalidParameters after its access check, which resolves the public content entity, passes and the feeds are read',
    async (subject) => {
      const { status, code, message } = LEGACY_ERROR_MAP.invalidParameters;
      expect(await feedMethod('findAll', subject)).toMatchObject({ status, body: { error: { code, message } }, readFeeds: true });
    },
  );

  it('refuses an anonymous feed.findQuery with the authorization error before any feed read', async () => {
    const { status, code, message } = LEGACY_ERROR_MAP.authorization;
    expect(await feedMethod('findQuery', 'anonymous')).toMatchObject({ status, body: { error: { code, message } }, readFeeds: false });
  });
});
