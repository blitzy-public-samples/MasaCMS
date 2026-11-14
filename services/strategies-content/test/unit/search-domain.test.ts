/** `domain/search` (GS-CO-06): carch.search, public search, JSON API content findQuery and cnav.searchsitedata over a throwaway `content` schema. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
import { saveContent, type ContentSaveSite } from '../../src/domain/content.js';
import type { Actor } from '../../src/domain/context.js';
import { FeedContentUnsupportedError, createFeed } from '../../src/domain/feeds.js';
import { UnregisteredTenantError } from '../../src/domain/pools.js';
import {
  contentQueryCriteria,
  findContentQuery,
  privateSearch,
  publicSearch,
  searchSiteData,
  type ContentFeedStep,
  type ContentQueryOptions,
  type ContentQueryRequest,
} from '../../src/domain/search.js';
import { ADMIN, END, HOME, SITE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

const param = (field: string, criteria: string, condition = 'eq', relationship = 'and'): ContentFeedStep => ({
  kind: 'addParam',
  param: { field, criteria, condition, relationship, datatype: '' },
});
const set = (key: string, value: unknown): ContentFeedStep => ({ kind: 'setValue', key, value });

describe('contentQueryCriteria', () => {
  it.each<[string, Record<string, unknown>, string, ContentQueryOptions, ContentFeedStep[], string]>([
    [
      'wildcard, caret and id filters in query-string order, pageIndex and excluded keys skipped',
      { title: '*orch*', id: 'ABC', summary: 'neq^x', pageIndex: '2', maxItems: '5' },
      'title=*orch*&id=ABC&pageIndex=2&summary=neq%5Ex&maxItems=5',
      {},
      [param('title', '%orch%', 'like'), param('contentid', 'ABC'), param('summary', 'x', 'neq'), set('maxItems', '5')],
      'title=*orch*&id=ABC&summary=neq%5Ex&maxItems=5',
    ],
    [
      'or, changesetid, the joined sort, a sortBy sort, the content-pool bound and liveOnly',
      { or: '', title: 'a', changesetid: 'C1', sort: '-title,rating,menutitle', shownavonly: 'false', liveOnly: '0', contentpoolid: 'tenant-a,zz' },
      'or&title=a&changesetid=C1&sort=-title,rating,menutitle&shownavonly=false&liveOnly=0&contentpoolid=tenant-a,zz',
      { contentPoolIds: ['Tenant-A'], siteManagerAccess: true },
      [
        param('title', 'a', 'eq', 'or'),
        set('activeOnly', 0),
        param('changesetid', 'C1'),
        set('contentPoolID', 'tenant-a'),
        set('activeOnly', 0),
        set('liveOnly', '0'),
        set('sortBy', 'rating'),
        set('orderBy', 'tcontent.title desc'),
        set('shownavonly', 0),
      ],
      'or&title=a&changesetid=C1&sort=-title%2Crating%2Cmenutitle&shownavonly=false&liveOnly=0&contentpoolid=tenant-a%2Czz',
    ],
    [
      'groupings, scalar values, an empty join and URL-decoded keys',
      { openGrouping: '', title: 7, closeGrouping: '', innerJoin: '', 'my key': true, 'a%E0%A4': 'v' },
      'openGrouping&title=7&closeGrouping&innerJoin=&my+key=true&a%E0%A4=v',
      {},
      [param('', '', 'EQUALS', 'openGrouping'), param('title', '7'), param('', '', 'EQUALS', 'closeGrouping'), param('my key', 'true'), param('a%E0%A4', 'v')],
      'openGrouping&title=7&closeGrouping&innerJoin&my+key=true&a%25E0%25A4=v',
    ],
    [
      'every other feed prop, liveOnly ignored without Site Manager access',
      {
        sort: 'a,+b.c,x', contentpoolid: '*', type: 'Component', liveOnly: 'true', includeHomePage: '1', useCategoryIntersect: 'yes',
        showexcludesearch: 'true', sortdirection: 'asc', sortby: 'title', distinct: 'false', fields: 'title', maxitems: '*', size: '7',
        limit: 'x', cachedWithin: '60',
      },
      '',
      {},
      [
        set('contentPoolID', '*'),
        set('type', 'Component'),
        set('orderBy', 'a,b.c asc,x'),
        set('includeHomePage', 1),
        set('useCategoryIntersect', 'yes'),
        set('showexcludesearch', 1),
        set('sortdirection', 'asc'),
        set('sortby', 'title'),
        set('type', 'Component'),
        set('distinct', 'false'),
        set('fields', 'title,contentid'),
        set('maxItems', 0),
        set('maxItems', '7'),
        set('cachedWithin', 60 / 86_400),
      ],
      '',
    ],
    [
      'expandEntity params, each by equality with an unencoded base URL',
      { parentid: 'P', maxItems: '0', expand: 'kids' },
      'expand=kids',
      { expanded: 1 },
      [param('parentid', 'P', 'EQUALS'), set('maxItems', '0')],
      'parentid=P',
    ],
  ])('%s', (_name, params, queryString, opts, steps, baseQuery) => {
    const criteria = contentQueryCriteria(params, queryString, opts);
    expect(criteria.steps).toEqual(steps);
    expect(criteria.baseQuery).toBe(baseQuery);
  });

  it.each<[Record<string, unknown>, string, unknown]>([
    [{}, 'feedid[1]=F1', { kind: 'feedId', feedId: 'F1' }],
    [{ feedid: 'F2' }, 'feedid=F2', { kind: 'feedId', feedId: 'F2' }],
    [{}, 'feedid=F3', { kind: 'entity' }],
    [{ feedname: 'News' }, 'feedname=News', { kind: 'feedName', name: 'News' }],
  ])('selects the source feed of %j and %s', (params, queryString, source) => {
    expect(contentQueryCriteria(params, queryString).source).toEqual(source);
  });

  it.each([
    [{ countOnly: 'true' }, true],
    [{ countOnly: 'maybe' }, false],
    [{}, false],
  ])('countOnly of %j is %s', (params, countOnly) => {
    expect(contentQueryCriteria(params, '').countOnly).toBe(countOnly);
  });

  it.each([
    [{ sum: 'x' }, 'sum=x'],
    [{ leftJoin: 'site' }, 'leftJoin=site'],
  ])('refuses %j, which feedContent cannot reproduce', (params, queryString) => {
    expect(() => contentQueryCriteria(params, queryString)).toThrow(FeedContentUnsupportedError);
  });
});

describe('searchSiteData', () => {
  const sites = [
    { siteid: 'tenant-b', site: 'Tenant B' },
    { siteid: 'default', site: 'default' },
    { siteid: 'zeta', site: null },
    { siteid: 'tenant-a', site: 'Tenant A' },
  ];
  it.each<[boolean, string[], string, string[]]>([
    [true, [], '', ['zeta', 'default', 'tenant-a', 'tenant-b']],
    [false, [], '', []],
    [false, ['tenant-a'], '', ['tenant-a']],
    [false, ['Tenant-A'], '', []],
    [true, [], 'Tenant', ['tenant-a', 'tenant-b']],
    [true, [], 'tenant', ['tenant-a', 'tenant-b']],
    [true, [], 'TENANT', []],
    [true, [], 't_n', ['tenant-a', 'tenant-b']],
    [true, [], 'tenant-[^a]', ['tenant-b']],
    [false, ['tenant-a', 'tenant-b'], 'tenant-[a]', ['tenant-a']],
  ])('isS2 %s with site array %j and search %j', (isS2, userSiteIds, searchString, expected) => {
    expect(searchSiteData({ sites, userSiteIds, isS2, searchString }).map((row) => row.siteid)).toEqual(expected);
  });
});

describe.skipIf(!(await pgAvailable()))('search over the content schema', () => {
  let fx: ContentFixture;
  const LEAFLET_FILE = cfId('F', 1);
  const STAND_FILE = cfId('F', 2);
  const CATEGORY = cfId('T', 1);
  const UMBRELLA_SITE: ContentSaveSite = {
    ...SITE,
    siteId: TENANT_UMBRELLA.siteId,
    urls: { ...SITE.urls, siteId: TENANT_UMBRELLA.siteId, filePoolId: TENANT_UMBRELLA.siteId },
  };
  const UMBRELLA_ADMIN: Actor = { ...ADMIN, siteId: TENANT_UMBRELLA.siteId, tenantId: TENANT_UMBRELLA.tenantId };
  const B_ADMIN: Actor = { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
  const titles = (rows: ReadonlyArray<{ title: string | null }>): Array<string | null> => rows.map((row) => row.title);

  const page = async (data: Record<string, unknown>, site: ContentSaveSite = SITE, actor: Actor = ADMIN): Promise<string> => {
    const saved = await saveContent(fx.deps, actor, site, { siteid: site.siteId, type: 'Page', approved: 1, ...data });
    expect(saved.errors).toEqual({});
    return saved.bean.contentId();
  };
  /** Stores a PDF in the umbrella file pool and points the active version of `contentId` in `tenantId` at it. */
  const attach = async (tenantId: string, contentId: string, fileId: string, filename: string): Promise<void> => {
    await withGatedTenant(fx.handle.app, TENANT_UMBRELLA.tenantId, (tx) =>
      fx.repo.files.insertFile(tx, { fileid: fileId, siteid: TENANT_UMBRELLA.siteId, filename, fileext: 'pdf', filesize: 123, contenttype: 'application', contentsubtype: 'pdf' }),
    );
    await withGatedTenant(fx.handle.app, tenantId, async (tx) => {
      const found = await tx.query(`SELECT contenthistid FROM ${fx.handle.schema}.content WHERE contentid = $1 AND active = 1`, [contentId]);
      const [row] = found.rows as Array<{ contenthistid: string }>;
      await fx.repo.content.updateVersion(tx, row?.contenthistid ?? '', { fileid: fileId });
    });
  };

  beforeAll(async () => {
    fx = await createContentFixture('search-domain-test');
    await page({ contentid: HOME, parentid: END, title: 'Home' });
    await page({ parentid: HOME, title: 'Orchid' });
    await page({ parentid: HOME, title: 'Rose', summary: 'an orchid relative' });
    await attach(TENANT_A.tenantId, await page({ parentid: HOME, title: 'Orchid leaflet' }), LEAFLET_FILE, 'leaflet.pdf');
    await page({ contentid: HOME, parentid: END, title: 'Umbrella Home' }, UMBRELLA_SITE, UMBRELLA_ADMIN);
    await attach(TENANT_UMBRELLA.tenantId, await page({ parentid: HOME, title: 'Leaflet stand' }, UMBRELLA_SITE, UMBRELLA_ADMIN), STAND_FILE, 'stand.pdf');
    await withGatedTenant(fx.handle.app, TENANT_UMBRELLA.tenantId, (tx) =>
      fx.repo.categories.insertCategory(tx, { categoryid: CATEGORY, siteid: TENANT_UMBRELLA.siteId, name: 'Flowers', path: `'${CATEGORY}'` }),
    );
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('privateSearch: legacy defaults, exact titles first, pooled file columns and the keywords session effect', async () => {
    const result = await privateSearch(fx.deps, ADMIN, { siteId: SITE.siteId, keywords: 'orchid', startRow: 31 });
    expect(titles(result.rows)).toEqual(['Orchid', 'Orchid leaflet', 'Rose']);
    expect(result.paging).toEqual({ recordsPerPage: 30, startRow: 31 });
    expect(result.sessionEffect).toEqual({ kind: 'keywords', keywords: 'orchid' });
    const leaflet = result.rows.find((row) => row.title === 'Orchid leaflet');
    expect([leaflet?.fileid, leaflet?.fileext, leaflet?.filesize, leaflet?.assocfilename]).toEqual([LEAFLET_FILE, 'pdf', 123, 'leaflet.pdf']);
    expect((await privateSearch(fx.deps, B_ADMIN, { siteId: TENANT_B.siteId, keywords: 'orchid', startRow: 1 })).rows).toEqual([]);
  });

  it('privateSearch: a file search spans the sites pooling their files in the site, merged in the gateway order', async () => {
    const own = await privateSearch(fx.deps, ADMIN, { siteId: SITE.siteId, keywords: 'leaflet', searchType: 'file', startRow: 1 });
    expect(own.rows.map((row) => [row.title, row.fileext, row.assocfilename])).toEqual([['Orchid leaflet', 'pdf', 'leaflet.pdf']]);
    const spanned = await privateSearch(fx.deps, UMBRELLA_ADMIN, { siteId: TENANT_UMBRELLA.siteId, keywords: 'leaflet', searchType: 'file', startRow: 1 });
    expect(spanned.rows.map((row) => [row.title, row.fileext])).toEqual([['Leaflet stand', 'pdf'], ['Orchid leaflet', 'pdf']]);
    const exact = await privateSearch(fx.deps, UMBRELLA_ADMIN, { siteId: TENANT_UMBRELLA.siteId, keywords: 'Leaflet stand', searchType: 'file', startRow: 1 });
    expect(titles(exact.rows)).toEqual(['Leaflet stand']);
  });

  it('publicSearch: live matches with pooled file columns, and a category list resolved in the category pool', async () => {
    const rows = await publicSearch(fx.deps, ADMIN, { siteId: SITE.siteId, keywords: 'orchid' });
    expect(titles(rows).sort()).toEqual(['Orchid', 'Orchid leaflet', 'Rose']);
    expect(rows.find((row) => row.title === 'Orchid leaflet')?.fileext).toBe('pdf');
    expect(await publicSearch(fx.deps, ADMIN, { siteId: SITE.siteId, keywords: 'orchid', categoryId: CATEGORY })).toEqual([]);
  });

  it('refuses a token tenant without a registry entry', async () => {
    const stranger: Actor = { ...ADMIN, siteId: 'nowhere', tenantId: tenantIdForSite('nowhere') };
    await expect(privateSearch(fx.deps, stranger, { siteId: 'nowhere', keywords: 'x', startRow: 1 })).rejects.toBeInstanceOf(UnregisteredTenantError);
  });

  describe('findContentQuery', () => {
    const query = (params: Record<string, unknown>, queryString: string, extra: Partial<ContentQueryRequest> = {}) =>
      findContentQuery(fx.deps, ADMIN, { siteId: SITE.siteId, extranet: false, params, queryString, ...extra });
    const filtered = { title: '*rchid*', sort: 'title' };
    const filteredQuery = 'title=*rchid*&sort=title';

    it('filters, sorts and returns the base URL query', async () => {
      const result = await query(filtered, filteredQuery);
      expect('rows' in result && [titles(result.rows), result.paging, result.baseQuery]).toEqual([
        ['Orchid', 'Orchid leaflet'],
        { recordCount: 2, nextN: 20, pageIndex: 1 },
        filteredQuery,
      ]);
    });

    it.each<[Record<string, unknown>, Array<string | null>, unknown]>([
      [{ itemsPerPage: '1', pageIndex: '2' }, ['Orchid leaflet'], { recordCount: 2, nextN: 1, pageIndex: 2 }],
      [{ itemsPerPage: '*' }, ['Orchid', 'Orchid leaflet'], { recordCount: 2, nextN: 2, pageIndex: 1 }],
      [{ itemsPerPage: '1', startIndex: '2' }, ['Orchid leaflet'], { recordCount: 2, nextN: 1, pageIndex: 2 }],
      [{ itemsPerPage: '2', startIndex: '2' }, ['Orchid leaflet'], { recordCount: 2, nextN: 2, pageIndex: 1 }],
      [{ pageIndex: '9' }, ['Orchid', 'Orchid leaflet'], { recordCount: 2, nextN: 20, pageIndex: 1 }],
    ])('pages by the URL scope %j', async (url, expected, paging) => {
      const result = await query(filtered, filteredQuery, { url });
      expect('rows' in result && [titles(result.rows), result.paging]).toEqual([expected, paging]);
    });

    it('resets a start index over no rows', async () => {
      const result = await query({ title: 'nomatch' }, 'title=nomatch', { url: { startIndex: '1' } });
      expect('rows' in result && result.paging).toEqual({ recordCount: 0, nextN: 20, pageIndex: 1 });
    });

    it.each([[{ offset: '1' }], [{ pageIndex: '0' }]])('answers server_error for the URL scope %j', async (url) => {
      await expect(query(filtered, filteredQuery, { url })).rejects.toMatchObject({ type: 'server_error' });
      await expect(query(filtered, filteredQuery, { url })).rejects.toBeInstanceOf(LegacyApiError);
    });

    it('counts without paging, a countOnly query key filtering as an extended attribute', async () => {
      expect(await query({ countOnly: 'true', title: 'Rose' }, 'title=Rose')).toEqual({ count: 1 });
      expect(await query({ countOnly: 'true' }, 'countOnly=true')).toEqual({ count: 0 });
    });

    it('reads a stored feed by id, and an unknown feed as a new feed of the request site', async () => {
      const feed = await createFeed(fx.deps, ADMIN, { siteid: SITE.siteId, name: 'Kids', type: 'Local', contentid: HOME, maxitems: 0 });
      const feedId = feed.text('feedid');
      const stored = await query({ feedid: feedId }, `feedid=${feedId}`);
      expect('rows' in stored && titles(stored.rows).sort()).toEqual(['Orchid', 'Orchid leaflet', 'Rose']);
      const missing = await query({ feedid: cfId('Z', 9), sort: 'title' }, 'sort=title');
      expect('rows' in missing && titles(missing.rows)).toEqual(['Orchid', 'Orchid leaflet', 'Rose']);
      const named = await query({ feedname: 'Kids' }, 'feedname=Kids');
      expect('rows' in named && named.rows).toHaveLength(3);
    });
  });
});
