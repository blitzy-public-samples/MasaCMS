/** The JSON API `site` feed port: findQuery params, SQL conditions, ORDER BY, TOP, the query iterator and the paged package. */
import { describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  addFeedParam,
  applyFeedProps,
  applyQueryParams,
  cfUrlDecode,
  feedRows,
  isAggregateQuery,
  iteratorPage,
  newSiteFeed,
  packagePage,
  queryRow,
  rowAt,
  scopeBaseUrl,
  siteColumn,
  topRows,
  type FeedSource,
  type SiteFeed,
} from '../../../src/legacy/json-api-site-feed.js';
import type { SiteRow } from '../../../src/legacy/site-fields.js';

const ENDPOINT = 'http://localhost/index.cfm/_api/json/v1/a';

// Three stored sites: `a` pools a and b, `b` has an archive date, `c` no domain.
const ROWS: ReadonlyMap<string, SiteRow> = new Map([
  ['a', { siteid: 'a', domain: 'alpha.test', orderno: 2, pagelimit: 1000, archivedate: null, contentpoolid: 'a,b' }],
  ['b', { siteid: 'b', domain: 'beta.test', orderno: 1, pagelimit: 1000, archivedate: new Date(2020, 5, 1), contentpoolid: null }],
  ['c', { siteid: 'c', domain: null, orderno: 3, pagelimit: 1000, archivedate: null, contentpoolid: null }],
]);

const SOURCE: FeedSource = {
  rows: async (siteIds) => siteIds.flatMap((siteId) => ROWS.get(siteId.toLowerCase()) ?? []),
  contentPool: async (siteId) => {
    const row = ROWS.get(siteId);
    return row === undefined ? undefined : String(row.contentpoolid ?? siteId);
  },
};

/** A feed of site `a` over all three sites. */
function feedOfAll(): SiteFeed {
  return { ...newSiteFeed('a'), contentPool: 'a,b,c' };
}

/** Site ids the findQuery `query` selects from all three sites, in order. */
async function selected(query: string): Promise<string[]> {
  const feed = feedOfAll();
  const url = Object.fromEntries(new URLSearchParams(query));
  const { url: scope } = applyQueryParams(feed, url, query, ENDPOINT);
  applyFeedProps(feed, scope, { validPools: '' });
  return (await feedRows(feed, SOURCE)).map((row) => String(row.siteid));
}

/** What `run` throws: the legacy error type, the 503 reason, or `none`. */
async function failureOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'none';
  } catch (error) {
    if (error instanceof LegacyApiError) return error.type;
    if (error instanceof LegacyServiceUnavailableError) return `503 ${error.reason ?? ''}`;
    throw error;
  }
}

describe('siteColumn', () => {
  it.each([
    ['DOMAIN', 'domain', 'varchar'],
    ['orderNo', 'orderno', 'numeric'],
    ['archiveDate', 'archivedate', 'timestamp'],
  ])('types %s as column %s of type %s', (name, column, type) => {
    expect(siteColumn(name)).toEqual({ column, type });
  });

  it('knows no column outside tsettings', () => {
    expect(siteColumn('bogus')).toBeUndefined();
  });
});

describe('findQuery conditions', () => {
  it.each([
    ['domain=alpha.test', ['a']],
    ['domain=ALPHA.TEST%20%20', ['a']],
    ['domain=neq%5Ealpha.test', ['b']],
    ['domain=*eta*', ['b']],
    ['domain=like%5E%25a.test', ['a', 'b']],
    ['domain=begins%5Eal', ['a']],
    ['domain=ends%5E.test', ['a', 'b']],
    ['domain=contains%5Eta', ['b']],
    ['domain=like%5E%5Bb%5D%25', ['b']],
    ['domain=null', ['c']],
    ['domain=neq%5Enull', ['a', 'b']],
    ['domain=in%5Ealpha.test,x', ['a']],
    ['domain=notin%5Ealpha.test', ['b']],
    ['orderno=gt%5E1', ['a', 'c']],
    ['orderno=gte%5E2', ['a', 'c']],
    ['orderno=lt%5E2', ['b']],
    ['orderno=lte%5E2', ['a', 'b']],
    ['orderno=in%5E1', ['b']],
    ['orderno=in%5E1,3', []],
    ['orderno=notin%5E1,3', ['a', 'b', 'c']],
    ['orderno=in%5E1,abc', []],
    ['orderno=notin%5E1', ['a', 'c']],
    ['domain=site.domain', ['a', 'b']],
    ['domain=tsettings.domain', ['a', 'b']],
    ['domain=like%5Esite.domain', []],
    ['archivedate=gt%5E1/1/2000', ['b']],
    ['archivedate=2020-06-01', ['b']],
    ['id=b', ['b']],
    ['tsettings.siteid=c', ['c']],
    ['domain=alpha.test&or&orderno=1', ['a', 'b']],
    ['openGrouping&domain=alpha.test&or&orderno=3&closeGrouping', ['a', 'c']],
    ['orOpenGrouping&domain=x&closeGrouping', []],
    ['domain%5B1%5D=alpha.test', ['a']],
    ['innerJoin=content&leftJoin=content', ['a', 'b', 'c']],
    ['nextn=1&value=x&orderby=', ['a', 'b', 'c']],
  ])('%s selects %j', async (query, siteIds) => {
    expect(await selected(query)).toEqual(siteIds);
  });

  it.each([
    ['bogus=1', 'server_error'],
    ['orderno=abc', 'server_error'],
    ['archivedate=abc', 'server_error'],
    ['domain=bogus%5Ex', 'server_error'],
    ['domain=gt%5Enull', 'server_error'],
    ['domain=tsettings.bogus', 'server_error'],
    ['domain=in%5Esite.domain', 'server_error'],
    ['tcontent.title=x', 'server_error'],
    ['params=x', 'server_error'],
    ['changesetid=1', 'server_error'],
    ['openGrouping&domain=x', 'server_error'],
    ['tusers.username=admin', 'authorization'],
    ['orderno=site.orderno', 'server_error'],
    ['orderno=', 'server_error'],
    ['domain=site.orderno', '503 site-feed-conversion'],
    ['archivedate=in%5Eabc', '503 site-feed-conversion'],
    ['domain=content.title', '503 site-feed-join'],
    ['dbo.tsettings.domain=x', '503 site-feed-identifier'],
    ['sum=orderno', '503 site-feed-aggregate'],
  ])('%s fails as %s', async (query, failure) => {
    expect(await failureOf(() => selected(query))).toBe(failure);
  });

  it('builds the base URL from the query string in order, encoding values and keeping blank ones bare', () => {
    const feed = feedOfAll();
    const query = 'method=findQuery&domain=a%5Eb%2Cc&pageIndex=2&openGrouping&x=*';
    const { baseUrl } = applyQueryParams(feed, Object.fromEntries(new URLSearchParams(query)), query, ENDPOINT);
    expect(baseUrl).toBe(`${ENDPOINT}/site/?method=findQuery&domain=a%5Eb%2Cc&openGrouping&x=*`);
  });

  it('carries the joined sort params into the scope setFeedProps reads', () => {
    const feed = feedOfAll();
    const { url } = applyQueryParams(feed, { sort: '-orderno' }, 'sort=-orderno', ENDPOINT);
    expect(url).toEqual({ sort: '-orderno' });
  });
});

describe('ORDER BY', () => {
  it.each([
    ['sort=-orderno', ['c', 'a', 'b']],
    ['sort=domain', ['c', 'a', 'b']],
    ['sort=%2Bdomain,-orderno', ['c', 'a', 'b']],
    ['sort=-domain', ['b', 'a', 'c']],
    ['orderby=tsettings.orderno', ['b', 'a', 'c']],
    ['sortby=orderno&sortdirection=desc', ['c', 'a', 'b']],
    ['sortby=domain,orderno&sortdirection=sideways', ['c', 'a', 'b']],
  ])('%s orders the rows %j', async (query, siteIds) => {
    expect(await selected(query)).toEqual(siteIds);
  });

  it.each([
    ['sort=-bogus', 'server_error'],
    ['orderby=domain%20sideways', 'server_error'],
    ['orderby=domain%20desc', 'server_error'],
    ['orderby=dom%24ain', 'server_error'],
    ['sortby=tsettings.domain', 'server_error'],
    ['sortby=domain;drop', 'server_error'],
    ['sort=tusers.username', 'authorization'],
    ['sortby=tusers.username', 'authorization'],
  ])('%s fails as %s', async (query, failure) => {
    expect(await failureOf(() => selected(query))).toBe(failure);
  });

  it('skips the ORDER BY for a count', async () => {
    const feed = { ...feedOfAll(), orderBy: 'bogus' };
    expect((await feedRows(feed, SOURCE, true)).map((row) => row.siteid)).toEqual(['a', 'b', 'c']);
  });
});

describe('feed props', () => {
  it.each([
    [{ contentpoolid: '*' }, '', ['a', 'b']],
    [{ contentpoolid: 'b,c,x' }, 'a,b,c', ['b', 'c']],
    [{ contentpoolid: 'x' }, 'a', ['a']],
    [{}, '', ['a']],
  ])('reads the pool of %j bounded by the API site pool %j', async (props, validPools, siteIds) => {
    const feed = newSiteFeed('a');
    applyFeedProps(feed, props, { validPools });
    expect((await feedRows(feed, SOURCE)).map((row) => row.siteid)).toEqual(siteIds);
  });

  it.each([
    [{ maxitems: '1' }, 1],
    [{ maxitems: '*' }, 0],
    [{ maxitems: 'abc' }, 0],
    [{ maxitems: '5', size: '2' }, 2],
    [{ size: '2', limit: '1' }, 1],
    [{ limit: 'abc' }, 0],
  ])('takes TOP from %j as %s', (props, maxItems) => {
    const feed = newSiteFeed('a');
    applyFeedProps(feed, props, { validPools: '' });
    expect(feed.maxItems).toBe(maxItems);
  });

  it.each([
    [{ distinct: 'yes' }, { distinct: true }],
    [{ distinct: 'maybe' }, { distinct: false }],
    [{ fields: 'domain,bogus' }, { fields: ['domain', 'siteid'] }],
    [{ fields: 'SiteID' }, { fields: ['siteid'] }],
    [{ sortby: ' domain ', sortdirection: 'DESC' }, { sortBy: 'domain', sortDirection: 'DESC' }],
    [{ sort: 'a,-b,x', orderby: 'ignored' }, { orderBy: 'a,tsettings.b desc,x' }],
  ])('sets %j as %j', (props, expected) => {
    const feed = newSiteFeed('a');
    applyFeedProps(feed, props, { validPools: '' });
    expect(feed).toMatchObject(expected);
  });

  it.each([
    ['nextn', '5', { nextN: 5 }],
    ['NextN', 'x', { nextN: 1000 }],
    ['orderby', 'domain', { orderBy: 'domain' }],
    ['fields', 'domain', { fields: [] }],
  ])('hands setter %s=%s to the feed as %j', (field, criteria, expected) => {
    const feed = newSiteFeed('a');
    addFeedParam(feed, field, criteria);
    expect(feed).toMatchObject({ ...expected, params: [] });
  });

  it.each(['params', 'allvalues', 'configbean'])('fails setter %s, which dereferences its text', (field) => {
    expect(() => addFeedParam(newSiteFeed('a'), field, 'x')).toThrow(LegacyApiError);
  });

  it('keeps an empty field only as a grouping', () => {
    const feed = newSiteFeed('a');
    addFeedParam(feed, '$$', 'x');
    addFeedParam(feed, '', '', 'EQUALS', 'openGrouping');
    expect(feed.params).toEqual([{ relationship: 'openGrouping' }]);
  });
});

describe('TOP and the query row', () => {
  const rows = [...ROWS.values()];

  it.each([
    [0, ['a', 'b', 'c']],
    [2, ['a', 'b']],
  ])('keeps TOP %s rows', (maxItems, siteIds) => {
    expect(topRows({ ...newSiteFeed('a'), maxItems }, rows).map((row) => row.siteid)).toEqual(siteIds);
  });

  it.each([1.5, -1])('refuses TOP %s as the SQL does', (maxItems) => {
    expect(() => topRows({ ...newSiteFeed('a'), maxItems }, rows)).toThrow(LegacyApiError);
  });

  it('reads the selected columns, NULL and unselected ones blank', () => {
    const row = queryRow({ ...newSiteFeed('a'), fields: ['domain', 'siteid'] }, ROWS.get('c'));
    expect(row).toEqual({ domain: '', siteid: 'c' });
    expect(queryRow(newSiteFeed('a'), undefined)).toMatchObject({ siteid: '', domain: '', orderno: '' });
  });

  it.each([
    [1, 'a'],
    [1.5, 'a'],
    [3, 'c'],
    [0, undefined],
    [4, undefined],
  ])('reads row %s as %s', (position, siteid) => {
    expect(rowAt(rows, position)?.siteid).toBe(siteid);
  });
});

describe('iteratorPage', () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it.each([
    [3, 1000, {}, { maxRecordsPerPage: 1000, pageIndex: 1, positions: [1, 2, 3] }],
    [3, 2, { pageindex: '2' }, { maxRecordsPerPage: 2, pageIndex: 2, positions: [3] }],
    [3, 2, { pageindex: '9' }, { maxRecordsPerPage: 2, pageIndex: 1, positions: [1, 2] }],
    [1, 1000, { itemsperpage: '0' }, { maxRecordsPerPage: 1, pageIndex: 1, positions: [1] }],
    [1, 1000, { itemsperpage: '*' }, { maxRecordsPerPage: 1, pageIndex: 1, positions: [1] }],
    [1, 1000, { itemsperpage: 'abc' }, { maxRecordsPerPage: 1000, pageIndex: 1, positions: [1] }],
    [1, 1000, { itemsperpage: '-1' }, { maxRecordsPerPage: -1, pageIndex: 1, positions: [] }],
    [1, 1000, { itemsperpage: '0.5', pageindex: '2' }, { maxRecordsPerPage: 0.5, pageIndex: 2, positions: [1.5] }],
    [1, 1000, { pageindex: '0' }, { maxRecordsPerPage: 1000, pageIndex: 0, positions: range(-999, 0) }],
    [1, 1000, { startindex: '0' }, { maxRecordsPerPage: 1000, pageIndex: 0, positions: [] }],
    [1, 1000, { startindex: '-3' }, { maxRecordsPerPage: 1000, pageIndex: 0, positions: range(-3, 0) }],
    [3, 1, { startindex: '2' }, { maxRecordsPerPage: 1, pageIndex: 2, positions: [2] }],
    [0, 1000, { startindex: '5' }, { maxRecordsPerPage: 1000, pageIndex: 1, positions: [] }],
    [2, 0, {}, { maxRecordsPerPage: 2, pageIndex: 1, positions: [1, 2] }],
  ])('pages %s rows of %s per page under %j', (count, nextN, url, page) => {
    expect(iteratorPage(count, nextN, url)).toEqual({ count, ...page });
  });
});

describe('packagePage', () => {
  it('links the first, previous, last and next pages around a middle page', () => {
    const data = packagePage({ count: 5, maxRecordsPerPage: 2, pageIndex: 2, positions: [3, 4] }, ['x', 'y'], {
      aggregate: false,
      iteratorEntity: 'site',
      endpoint: ENDPOINT,
      baseUrl: `${ENDPOINT}/?&a=1`,
    });
    expect(data).toEqual({
      totalItems: 5,
      totalPages: 3,
      pageIndex: 2,
      items: ['x', 'y'],
      startindex: 3,
      endindex: 4,
      itemsperpage: 2,
      entityname: 'site',
      links: {
        self: `${ENDPOINT}/?&a=1&pageIndex=2`,
        entities: ENDPOINT,
        properties: `${ENDPOINT}/site/properties`,
        permissions: `${ENDPOINT}/site/permissions`,
        first: `${ENDPOINT}/?&a=1&pageIndex=1`,
        previous: `${ENDPOINT}/?&a=1&pageIndex=1`,
        last: `${ENDPOINT}/?&a=1&pageIndex=3`,
        next: `${ENDPOINT}/?&a=1&pageIndex=3`,
      },
    });
    // ColdFusion struct order, as the oracle serializes a collection.
    expect(Object.keys(data)).toEqual(['pageIndex', 'itemsperpage', 'totalPages', 'totalItems', 'links', 'items', 'endindex', 'entityname', 'startindex']);
  });

  it.each([
    [true, 'site', 'bean', ['self', 'entities', 'properties', 'permissions']],
    [false, 'bean', 'bean', ['self', 'entities']],
  ] as const)('names an aggregate %s over iterator entity %s %s, linking %j', (aggregate, iteratorEntity, entityname, links) => {
    const data = packagePage({ count: 0, maxRecordsPerPage: 1000, pageIndex: 1, positions: [] }, [], {
      aggregate,
      iteratorEntity,
      endpoint: ENDPOINT,
      baseUrl: `${ENDPOINT}/?`,
    });
    expect(data).toMatchObject({ entityname, totalItems: 0, pageIndex: 0, startindex: 0, endindex: 0, items: [] });
    expect(Object.keys(data.links as object).sort()).toEqual([...links].sort());
  });
});

describe('scopeBaseUrl', () => {
  it.each([
    [{}, {}, '?&method=findall'],
    [{ method: 'undefined' }, {}, '?&method=findall'],
    [{ Method: 'findMany', pageIndex: '2' }, { method: 'x', IDS: 'a' }, '?&method=x&ids=a'],
  ])('lists url %j then form %j as %s', (url, form, query) => {
    expect(scopeBaseUrl(ENDPOINT, url, form, 'findall')).toBe(`${ENDPOINT}/${query}`);
  });
});

describe('isAggregateQuery', () => {
  it.each([
    [{}, '', false],
    [{ distinct: 'false' }, 'distinct=false', true],
    [{ GroupBy: 'domain' }, 'GroupBy=domain', true],
    [{ distinct: 'true', fields: 'domain' }, 'distinct=true&fields=domain', false],
    [{ x: 'sum[1]' }, 'x=sum[1]', true],
  ])('reads url %j as aggregate: %s', (url, queryString, aggregate) => {
    expect(isAggregateQuery(url, queryString)).toBe(aggregate);
  });
});

describe('cfUrlDecode', () => {
  it.each([
    ['a+b', 'a b'],
    ['%41%C3%A9', 'Aé'],
    ['100%', '100%'],
    ['%zz', '%zz'],
    ['%C3', '%C3'],
  ])('decodes %j as %j', (text, decoded) => {
    expect(cfUrlDecode(text)).toBe(decoded);
  });
});
