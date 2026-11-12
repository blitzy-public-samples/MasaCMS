/** `repo/feed-queries` feed reads and the local-feed listing of `getFeed` over a throwaway `content` schema. */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { ContentQueryError, ROOT_PARENT_ID, SITE_TREE_MODULE_ID } from '../../src/repo/content-queries.js';
import {
  FEED_HIST_TABLES,
  FEED_SORT_OPTIONS,
  FeedAuthorizationError,
  contentItems,
  defaultFeeds,
  feedAdvancedParams,
  feedById,
  feedByName,
  feedByRemoteId,
  feedContent,
  feedItems,
  feedTypeCount,
  feedsByCategoryId,
  listFeeds,
  type FeedCriteria,
  type FeedParamInput,
} from '../../src/repo/feed-queries.js';
import { CONTENT_UNITS, UNIT_OF } from '../../src/repo/tables.js';

const cfId = (n: number): string => `${n.toString(16).toUpperCase().padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const SITE = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;
const HOME = `${'0'.repeat(34)}1`;
const FOLDER = cfId(0x10);
const P = {
  ALPHA: cfId(0x20),
  BETA: cfId(0x21),
  GAMMA: cfId(0x22),
  DELTA: cfId(0x23),
  EPSILON: cfId(0x24),
  ZETA: cfId(0x25),
  COMP: cfId(0x26),
  MOD: cfId(0x27),
  EVENTS: cfId(0x28),
  THETA: cfId(0x29),
  EV1: cfId(0x30),
  EV2: cfId(0x31),
} as const;
/** The version id of content `id`. */
const H = (id: string): string => `H${id.slice(1)}`;
const CAT_1 = cfId(0x40);
const CAT_2 = cfId(0x41);
const CAT_3 = cfId(0x42);
const F1 = cfId(0x50);
const F2 = cfId(0x51);
const F3 = cfId(0x52);
const FB = cfId(0x53);
const TODAY = new Date(2026, 5, 30, 12, 0, 0);
/** A stand-in for legacy-compat's CF date reading: ISO dates and datetimes only. */
const parseDate = (text: string): Date | null => {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text);
  return Number.isNaN(d.getTime()) ? null : d;
};

type Row = Record<string, unknown>;
let handle: ThrowawaySchema;

async function insert(tx: TenantTx, table: string, rows: readonly Row[]): Promise<void> {
  for (const row of rows) {
    const names = Object.keys(row);
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [tx.tenantId, ...Object.values(row)],
    );
  }
}

const page = (id: string, row: Row, site = SITE): Row => ({
  siteid: site,
  moduleid: SITE_TREE_MODULE_ID,
  parentid: FOLDER,
  contentid: id,
  contenthistid: H(id),
  type: 'Page',
  active: 1,
  approved: 1,
  isnav: 1,
  display: 1,
  searchexclude: 0,
  ...row,
});

const inA = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_A.tenantId, fn);
const inU = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_UMBRELLA.tenantId, fn);
const inB = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, TENANT_B.tenantId, fn);
const base: FeedCriteria = { siteId: SITE, today: TODAY, contentIds: [FOLDER], sortBy: 'title', sortDirection: 'asc', maxItems: 0 };
const titles = (rows: readonly Row[]): unknown[] => rows.map((row) => row.title);
const withParams = (rows: FeedParamInput[], extra: Partial<FeedCriteria> = {}): FeedCriteria => ({ ...base, advanced: { rows, parseDate }, ...extra });

describe.skipIf(!(await pgAvailable()))('repo/feed-queries', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await inA(async (tx) => {
      await insert(tx, 'content', [
        page(HOME, { parentid: ROOT_PARENT_ID, title: 'Home' }),
        page(FOLDER, { parentid: HOME, type: 'Folder', title: 'Folder' }),
        page(P.ALPHA, { title: 'Alpha', menutitle: 'Alpha', lastupdate: '2025-01-05 00:00:00', releasedate: '2025-01-05 00:00:00', credits: 'Zed', orderno: 1, tags: 'red' }),
        page(P.BETA, { title: 'beta', menutitle: 'beta', lastupdate: '2025-01-04 00:00:00', releasedate: '2025-01-04 00:00:00', credits: 'amy', orderno: 2, isfeature: 1 }),
        page(P.GAMMA, { title: 'Gamma', menutitle: 'Gamma', display: 2, displaystart: '2026-01-01 00:00:00', displaystop: '2027-01-01 00:00:00', orderno: 3, lastupdate: '2025-01-03 00:00:00' }),
        page(P.DELTA, { title: 'Delta', isnav: 0 }),
        page(P.EPSILON, { title: 'Epsilon', searchexclude: 1 }),
        page(P.ZETA, { title: 'Zeta', approved: 0 }),
        page(P.COMP, { title: 'Comp', type: 'Component', moduleid: `${'0'.repeat(34)}3`, isnav: 0 }),
        page(P.MOD, { title: 'Mod', type: 'Module' }),
        page(P.EVENTS, { title: 'Events', type: 'Calendar', orderno: 4, lastupdate: '2025-01-02 00:00:00' }),
        page(P.THETA, { title: 'Theta', display: 2, displaystart: '2026-09-01 00:00:00' }),
        page(P.EV1, { parentid: P.EVENTS, title: 'Ev1', display: 2, displaystart: '2026-07-10 00:00:00' }),
        page(P.EV2, { parentid: P.EVENTS, title: 'Ev2', display: 2, displaystart: '2027-08-01 00:00:00' }),
      ]);
      await insert(tx, 'content_stats', [
        { contentid: P.ALPHA, siteid: SITE, rating: 4.5, totalvotes: 10 },
        { contentid: P.BETA, siteid: SITE, rating: 3, totalvotes: 2 },
      ]);
      await insert(tx, 'content_tag', [
        { contenthistid: H(P.ALPHA), contentid: P.ALPHA, siteid: SITE, tag: 'red' },
        { contenthistid: H(P.BETA), contentid: P.BETA, siteid: SITE, tag: 'Blue', taggroup: 'colors' },
      ]);
      await insert(tx, 'category', [
        { categoryid: CAT_1, siteid: SITE, name: 'Top', path: `'${CAT_1}'` },
        { categoryid: CAT_2, siteid: SITE, name: 'Sub', path: `'${CAT_1}','${CAT_2}'`, parentid: CAT_1 },
      ]);
      await insert(tx, 'content_category_assign', [
        { contenthistid: H(P.ALPHA), categoryid: CAT_1, contentid: P.ALPHA, isfeature: 1, siteid: SITE },
        { contenthistid: H(P.BETA), categoryid: CAT_2, contentid: P.BETA, isfeature: 0, siteid: SITE },
        { contenthistid: H(P.GAMMA), categoryid: CAT_1, contentid: P.GAMMA, isfeature: 0, siteid: SITE },
        { contenthistid: H(P.GAMMA), categoryid: CAT_2, contentid: P.GAMMA, isfeature: 2, featurestart: '2026-01-01 00:00:00', siteid: SITE },
        { contenthistid: H(P.ALPHA), categoryid: CAT_3, contentid: P.ALPHA, isfeature: 0, siteid: SITE },
      ]);
      await insert(tx, 'extend_attribute', [
        { attributeid: 7, siteid: SITE, name: 'priority', validation: 'Numeric' },
        { attributeid: 8, siteid: SITE, name: 'eventdate', validation: 'Date' },
      ]);
      await insert(tx, 'extend_data', [
        { baseid: H(P.ALPHA), attributeid: 7, siteid: SITE, attributevalue: '5', numericvalue: 5, stringvalue: '5' },
        { baseid: H(P.BETA), attributeid: 7, siteid: SITE, attributevalue: '2', numericvalue: 2, stringvalue: '2' },
        { baseid: H(P.GAMMA), attributeid: 8, siteid: SITE, attributevalue: '2025-01-01', datetimevalue: '2025-01-01 00:00:00', stringvalue: '2025-01-01' },
      ]);
      await insert(tx, 'content_object', [{ contenthistid: H(P.BETA), objectid: cfId(0x60), object: 'comments', siteid: SITE, columnid: 1, orderno: 1 }]);
      await insert(tx, 'feed', [
        { feedid: F1, siteid: SITE, name: 'News', type: 'Local', ispublic: 1, isactive: 1, isdefault: 1, remoteid: 'R-1', channellink: 'http://x' },
        { feedid: F2, siteid: SITE, name: 'archive', type: 'local', ispublic: 0, isactive: 0, isdefault: 0 },
        { feedid: F3, siteid: SITE, name: 'Remote', type: 'Remote', ispublic: 0, isactive: 1, isdefault: 0 },
      ]);
      await insert(tx, 'feed_item', [
        { feedid: F1, itemid: FOLDER, type: 'contentID' },
        { feedid: F1, itemid: CAT_1, type: 'categoryID' },
      ]);
      await insert(tx, 'feed_advanced_param', [
        { paramid: cfId(0x71), feedid: F1, param: 2, relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'x', datatype: 'varchar' },
        { paramid: cfId(0x70), feedid: F1, param: 1, relationship: 'and', field: 'tcontent.menutitle', condition: 'Equals', criteria: 'y', datatype: 'varchar' },
      ]);
    });
    await inU((tx) => insert(tx, 'category', [{ categoryid: CAT_3, siteid: TENANT_UMBRELLA.siteId, name: 'Pooled', path: `'${CAT_3}'` }]));
    await inB(async (tx) => {
      await insert(tx, 'content', [page(cfId(0x90), { title: 'Bravo', siteid: SITE_B }, SITE_B)]);
      await insert(tx, 'feed', [{ feedid: FB, siteid: SITE_B, name: 'BNews', type: 'Local', isactive: 1 }]);
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('exports the sort options and hist tables', () => {
    expect(FEED_SORT_OPTIONS).toContain('expires');
    expect(FEED_HIST_TABLES).toEqual(['content_tag', 'content_category_assign', 'content_object', 'content_related', 'content_assignment']);
  });

  it('lists feeds, defaults and lookups', async () => {
    expect((await inA((tx) => listFeeds(tx, { siteId: SITE, type: 'LOCAL' }))).map((f) => f.name)).toEqual(['archive', 'News']);
    expect((await inA((tx) => listFeeds(tx, { siteId: SITE, type: 'local', publicOnly: true }))).map((f) => f.name)).toEqual(['News']);
    expect((await inA((tx) => listFeeds(tx, { siteId: SITE, type: 'local', activeOnly: true }))).map((f) => f.name)).toEqual(['News']);
    expect((await inA((tx) => defaultFeeds(tx, { siteId: SITE }))).map((f) => f.feedid)).toEqual([F1]);
    const f1 = await inA((tx) => feedById(tx, { feedId: F1.toLowerCase() }));
    expect(f1?.name).toBe('News');
    expect(Object.keys(f1 ?? {})).not.toContain('tenant_id');
    expect(await inA((tx) => feedById(tx, { feedId: cfId(0xff) }))).toBeNull();
    expect((await inA((tx) => feedByName(tx, { siteId: SITE, name: 'news ' })))?.feedid).toBe(F1);
    expect((await inA((tx) => feedByRemoteId(tx, { siteId: SITE, remoteId: 'r-1' })))?.feedid).toBe(F1);
    expect(await inB((tx) => feedById(tx, { feedId: F1 }))).toBeNull();
    expect((await inA((tx) => feedItems(tx, { feedId: F1 }))).map((i) => i.itemid)).toEqual([FOLDER, CAT_1].sort());
    expect(await inA((tx) => feedItems(tx, { feedId: F1, type: 'categoryid' }))).toEqual([{ feedid: F1, itemid: CAT_1, type: 'categoryID' }]);
    const params = await inA((tx) => feedAdvancedParams(tx, { feedId: F1 }));
    expect(params.map((r) => r.param)).toEqual(['1', '2']);
    expect(await inA((tx) => contentItems(tx, { feedId: F1, siteId: SITE }))).toEqual([{ contentid: FOLDER, menutitle: null, type: 'Folder', siteid: SITE }]);
    expect((await inA((tx) => contentItems(tx, { siteId: SITE, contentIds: [P.ALPHA, P.ZETA] }))).map((r) => r.contentid)).toEqual([P.ALPHA, P.ZETA]);
    expect(await inA((tx) => contentItems(tx, { siteId: SITE }))).toEqual([]);
    expect(await inA((tx) => feedsByCategoryId(tx, { siteId: SITE, categoryId: CAT_1 }))).toEqual([{ name: 'News', channellink: 'http://x', type: 'Local' }]);
    expect(await inA((tx) => feedsByCategoryId(tx, { siteId: SITE, categoryId: 'ALL' }))).toHaveLength(1);
    expect(await inA((tx) => feedTypeCount(tx, { siteId: SITE, type: 'local' }))).toEqual([{ total: 1 }]);
    expect(await inA((tx) => feedTypeCount(tx, { siteId: SITE }))).toEqual([{ total: 2 }]);
    expect(await inA((tx) => feedTypeCount(tx, {}))).toEqual([{ total: 2 }]);
  });

  it('lists a local feed with legacy filters and sorts', async () => {
    expect(titles(await inA((tx) => feedContent(tx, base)))).toEqual(['Alpha', 'beta', 'Events', 'Gamma']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, showNavOnly: false })))).toEqual(['Alpha', 'beta', 'Delta', 'Events', 'Gamma']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, showExcludeSearch: true })))).toContain('Epsilon');
    expect(titles(await inA((tx) => feedContent(tx, { ...base, liveOnly: false })))).toEqual(['Alpha', 'beta', 'Events', 'Gamma', 'Theta', 'Zeta']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, type: 'component' })))).toEqual(['Comp']);
    expect(await inA((tx) => feedContent(tx, { ...base, countOnly: true }))).toEqual({ count: 4 });
    expect(titles(await inA((tx) => feedContent(tx, { ...base, maxItems: 2 })))).toEqual(['Alpha', 'beta']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, sortBy: 'rating', sortDirection: 'DESC' })))).toEqual(['Alpha', 'beta', 'Gamma', 'Events']);
    expect(titles(await inA((tx) => feedContent(tx, { siteId: SITE, today: TODAY, contentIds: [FOLDER] })))).toEqual(['Alpha', 'beta', 'Gamma', 'Events']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, sortBy: 'priority', sortDirection: 'desc' })))).toEqual(['Alpha', 'beta', 'Gamma', 'Events']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, orderBy: 'tcontent.menutitle desc,title' })))).toEqual(['Gamma', 'beta', 'Alpha', 'Events']);
    expect(await inA((tx) => feedContent(tx, { ...base, orderBy: 'random' }))).toHaveLength(4);
    expect(await inA((tx) => feedContent(tx, { ...base, sortBy: 'random' }))).toHaveLength(4);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: 'title; drop' }))).rejects.toBeInstanceOf(ContentQueryError);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: 'title sideways' }))).rejects.toThrow(/Invalid sort direction/);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, tag: 'RED' })))).toEqual(['Alpha']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, categoryIds: [CAT_1, CAT_2] })))).toEqual(['Alpha', 'beta', 'Gamma']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, categoryIds: [CAT_1, CAT_2], useCategoryIntersect: true })))).toEqual(['Gamma']);
    expect(await inA((tx) => feedContent(tx, { ...base, categoryIds: [] }))).toEqual([]);
  });

  it.each<[string, FeedParamInput[], string[]]>([
    ['Equals', [{ relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'ALPHA', datatype: 'varchar' }], ['Alpha']],
    ['Contains', [{ field: 'tcontent.title', condition: 'Contains', criteria: 'amm', datatype: 'varchar' }], ['Gamma']],
    ['Begins', [{ field: 'tcontent.title', condition: 'Begins', criteria: 'BE', datatype: 'varchar' }], ['beta']],
    ['in', [{ field: 'tcontent.title', condition: 'in', criteria: 'alpha,Gamma', datatype: 'varchar' }], ['Alpha', 'Gamma']],
    ['not in', [{ field: 'tcontent.title', condition: 'NOT IN', criteria: 'alpha,Gamma', datatype: 'varchar' }], ['beta', 'Events']],
    ['is null', [{ field: 'tcontent.credits', condition: 'Equals', criteria: 'null', datatype: 'varchar' }], ['Events', 'Gamma']],
    ['is not null', [{ field: 'tcontent.credits', condition: 'NEQ', criteria: 'NULL', datatype: 'varchar' }], ['Alpha', 'beta']],
    ['numeric', [{ field: 'tcontent.orderno', condition: 'GT', criteria: '1', datatype: 'numeric' }], ['beta', 'Events', 'Gamma']],
    ['empty datatype looks the column up', [{ field: 'tcontent.orderno', condition: 'LTE', criteria: '2' }], ['Alpha', 'beta']],
    ['timestamp', [{ field: 'tcontent.releasedate', condition: 'GT', criteria: '2025-01-04', datatype: 'timestamp' }], ['Alpha']],
    [
      'grouping',
      [
        { relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'Alpha', datatype: 'varchar' },
        { relationship: 'orOpenGrouping' },
        { relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'beta', datatype: 'varchar' },
        { relationship: 'or', field: 'tcontent.title', condition: 'Equals', criteria: 'Gamma', datatype: 'varchar' },
        { relationship: 'closeGrouping' },
      ],
      ['Alpha', 'beta', 'Gamma'],
    ],
    [
      'and not grouping',
      [
        { relationship: 'and not (' },
        { relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'Alpha', datatype: 'varchar' },
        { relationship: ')' },
      ],
      ['beta', 'Events', 'Gamma'],
    ],
    ['invalid params are skipped', [{ relationship: 'and', field: '', condition: 'Equals', criteria: 'x' }], ['Alpha', 'beta', 'Events', 'Gamma']],
    ['extended numeric', [{ field: 'Priority', condition: 'GT', criteria: '3', datatype: 'varchar' }], ['Alpha']],
    ['extended by attribute id', [{ field: '7', condition: 'Equals', criteria: '2', datatype: 'varchar' }], ['beta']],
    ['extended like', [{ field: 'priority', condition: 'Contains', criteria: '5', datatype: 'varchar' }], ['Alpha']],
    ['extended null', [{ field: 'priority', condition: 'Equals', criteria: 'null', datatype: 'varchar' }], ['Events', 'Gamma']],
    ['tag param', [{ field: 'tcontenttags.tag', condition: 'Equals', criteria: 'blue', datatype: 'varchar' }], ['beta']],
    ['tag param not in', [{ field: 'tcontenttags.tag', condition: 'not in', criteria: 'blue', datatype: 'varchar' }], ['Alpha', 'Events', 'Gamma']],
    ['category assignment', [{ field: 'tcontentcategoryassign.categoryid', condition: 'Equals', criteria: CAT_2, datatype: 'varchar' }], ['beta', 'Gamma']],
    ['category name through the pool', [{ field: 'tcontentcategories.name', condition: 'Equals', criteria: 'sub', datatype: 'varchar' }], ['beta', 'Gamma']],
    ['category not in', [{ field: 'tcontentcategories.name', condition: 'not in', criteria: 'sub', datatype: 'varchar' }], ['Alpha', 'Events']],
    ['implied hist join', [{ field: 'tcontentobjects.object', condition: 'Equals', criteria: 'comments', datatype: 'varchar' }], ['beta']],
    ['left-joined stats', [{ field: 'tcontentstats.totalvotes', condition: 'GTE', criteria: '5', datatype: 'numeric' }], ['Alpha']],
  ])('advanced param %s', async (_label, rows, expected) => {
    expect(titles(await inA((tx) => feedContent(tx, withParams(rows))))).toEqual(expected);
  });

  it.each<[string, FeedParamInput[], new (...args: never[]) => Error, RegExp]>([
    ['a restricted table', [{ field: 'tusers.username', condition: 'Equals', criteria: 'x' }], FeedAuthorizationError, /restricted/],
    ['an unknown table', [{ field: 'tfoo.bar', condition: 'Equals', criteria: 'x' }], ContentQueryError, /Invalid object name/],
    ['the file metadata alias', [{ field: 'tcontentfilemetadata.alttext', condition: 'Equals', criteria: 'x' }], ContentQueryError, /multiple times/],
    ['an unknown column', [{ field: 'tcontent.nosuch', condition: 'Equals', criteria: 'x', datatype: 'varchar' }], ContentQueryError, /Invalid column name/],
    ['NULL with GT', [{ field: 'tcontent.title', condition: 'GT', criteria: 'null', datatype: 'varchar' }], ContentQueryError, /NULL/],
    ['a bad numeric', [{ field: 'tcontent.orderno', condition: 'Equals', criteria: 'abc', datatype: 'numeric' }], ContentQueryError, /CF_SQL_NUMERIC/],
    ['an unknown condition', [{ field: 'tcontent.title', condition: 'between', criteria: 'x', datatype: 'varchar' }], ContentQueryError, /condition/],
  ])('rejects %s', async (_label, rows, type, message) => {
    const result = inA((tx) => feedContent(tx, withParams(rows)));
    await expect(result).rejects.toBeInstanceOf(type);
    await expect(result).rejects.toThrow(message);
  });


  it.each<[string, FeedParamInput[], string[]]>([
    ['bit', [{ field: 'tcontent.isnav', condition: 'Equals', criteria: 'yes', datatype: 'boolean' }], ['Alpha', 'beta', 'Events', 'Gamma']],
    ['date truncates to the day', [{ field: 'tcontent.releasedate', condition: 'GTE', criteria: '2025-01-05T10:00:00', datatype: 'date' }], ['Alpha']],
    ['EndsWith', [{ field: 'tcontent.title', condition: 'EndsWith', criteria: 'TA', datatype: 'varchar' }], ['beta']],
    ['Contains on a number is equality', [{ field: 'tcontent.orderno', condition: 'Contains', criteria: '2', datatype: 'numeric' }], ['beta']],
    ['in list on a number column', [{ field: 'tcontent.orderno', condition: 'in', criteria: '1,3', datatype: 'varchar' }], ['Alpha', 'Gamma']],
    ['omitted condition is Equals', [{ field: 'tcontent.title', criteria: 'alpha', datatype: 'varchar' }], ['Alpha']],
    ['NEQ', [{ field: 'tcontent.title', condition: 'NEQ', criteria: 'alpha', datatype: 'varchar' }], ['beta', 'Events', 'Gamma']],
    ['LT', [{ field: 'tcontent.orderno', condition: 'LT', criteria: '2', datatype: 'numeric' }], ['Alpha']],
    ['empty datatype timestamp lookup', [{ field: 'tcontent.releasedate', condition: '>', criteria: '2025-01-04' }], ['Alpha']],
    ['empty datatype extended date', [{ field: 'eventdate', condition: 'Equals', criteria: '2025-01-01' }], ['Gamma']],
  ])('more advanced params: %s', async (_label, rows, expected) => {
    expect(titles(await inA((tx) => feedContent(tx, withParams(rows))))).toEqual(expected);
  });

  it.each<[string, FeedParamInput[]]>([
    ['a numeric list legacy blanks', [{ field: 'tcontent.orderno', condition: 'in', criteria: '1,3', datatype: 'numeric' }]],
    ['a bad bit', [{ field: 'tcontent.isnav', condition: 'Equals', criteria: 'maybe', datatype: 'bit' }]],
    ['a float column without datatype', [{ field: 'tcontentstats.rating', condition: 'Equals', criteria: '3' }]],
    ['a NULL condition', [{ field: 'tcontent.title', condition: null, criteria: 'x', datatype: 'varchar' }]],
    ['an unknown cfsqltype', [{ field: 'tcontent.title', condition: 'Equals', criteria: 'x', datatype: 'tcontenttitle' }]],
    ['a three-part field', [{ field: 'tcontentcategoryassign.a.b', condition: 'Equals', criteria: 'x', datatype: 'varchar' }]],
    ['a case-variant category table', [{ field: 'TContentCategoryAssign.categoryid', condition: 'Equals', criteria: 'x', datatype: 'varchar' }]],
  ])('rejects %s', async (_label, rows) => {
    await expect(inA((tx) => feedContent(tx, withParams(rows)))).rejects.toBeInstanceOf(ContentQueryError);
  });

  it('rejects a text column compared as a timestamp at the database', async () => {
    await expect(
      inA((tx) => feedContent(tx, withParams([{ field: 'tcontent.title', condition: 'Equals', criteria: '2025-01-01', datatype: 'timestamp' }]))),
    ).rejects.toThrow();
  });

  it('resolves category params in the category-pool tenant', async () => {
    const rows = [{ field: 'tcontentcategories.name', condition: 'Equals', criteria: 'pooled', datatype: 'varchar' }];
    expect(titles(await inA((tx) => feedContent(tx, withParams(rows))))).toEqual([]);
    expect(titles(await inA((tx) => feedContent(tx, withParams(rows, { categoryPool: inU }))))).toEqual(['Alpha']);
  });

  it('binds bare sort and aggregate names as SQL Server does', async () => {
    expect(titles(await inA((tx) => feedContent(tx, { ...base, orderBy: 'menutitle desc' })))).toEqual(['Gamma', 'beta', 'Alpha', 'Events']);
    expect(await inA((tx) => feedContent(tx, { ...base, orderBy: 'views' }))).toHaveLength(4);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: 'active' }))).rejects.toThrow(/Ambiguous/);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: 'nosuch' }))).rejects.toThrow(/Invalid column/);
    await expect(inA((tx) => feedContent(tx, { ...base, sortBy: '', aggregates: { groupBy: ['type'], count: ['*'] } }))).rejects.toThrow(/Ambiguous/);
    const [stats] = await inA((tx) =>
      feedContent(tx, {
        ...base,
        sortBy: '',
        aggregates: { avg: ['tcontent.orderno'], min: ['tcontent.title'], max: ['tcontentstats.rating'], count: ['tcontent.credits'] },
      }),
    );
    expect(stats).toEqual({ avg_orderno: 2, min_title: 'Alpha', max_rating: 4.5, count_credits: 2 });
  });


  it('covers the remaining sort, type and grouping paths', async () => {
    expect(titles(await inA((tx) => feedContent(tx, { ...base, sortBy: 'comment' })))).toEqual(['Alpha', 'beta', 'Gamma', 'Events']);
    expect(await inA((tx) => feedContent(tx, { ...base, sortBy: 'comments' }))).toHaveLength(4);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, type: '*', showNavOnly: false })))).toEqual(['Alpha', 'beta', 'Comp', 'Delta', 'Events', 'Gamma']);
    expect(await inA((tx) => feedContent(tx, { ...base, type: 'Form' }))).toEqual([]);
    expect(await inA((tx) => feedContent(tx, { ...base, type: 'Variation' }))).toEqual([]);
    expect(await inA((tx) => feedContent(tx, { ...base, categoryIds: [], useCategoryIntersect: true }))).toEqual([]);
    expect(titles(await inA((tx) => feedContent(tx, withParams([{ field: 'priority', condition: 'Equals', criteria: 'two', datatype: 'varchar' }]))))).toEqual([]);
    const grouped = withParams([
      { relationship: 'and', field: 'tcontent.title', condition: 'Equals', criteria: 'Alpha', datatype: 'varchar' },
      { relationship: '(' },
      { relationship: 'and', field: 'tcontent.orderno', condition: 'GTE', criteria: '1', datatype: 'numeric' },
      { relationship: ')' },
      { relationship: 'or not (' },
      { relationship: 'and', field: 'tcontent.orderno', condition: 'GTE', criteria: '2', datatype: 'numeric' },
      { relationship: ')' },
    ]);
    expect(titles(await inA((tx) => feedContent(tx, grouped)))).toEqual(['Alpha']);
    await expect(inA((tx) => feedContent(tx, { ...base, maxItems: -1 }))).rejects.toThrow(/TOP/);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: ',,' }))).rejects.toThrow(/ORDER BY/);
    await expect(inA((tx) => feedContent(tx, { ...base, orderBy: ' , ' }))).rejects.toBeInstanceOf(ContentQueryError);
    expect(await inA((tx) => feedContent(tx, { siteId: SITE, today: TODAY, contentIds: [FOLDER], countOnly: true, tag: 'red' }))).toEqual({ count: 1 });
  });

  it('filters features', async () => {
    expect(titles(await inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, featureType: 'architecture' })))).toEqual(['beta']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, featureType: 'category', categoryIds: [CAT_1, CAT_2] })))).toEqual(['Alpha', 'Gamma']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, categoryIds: [CAT_1] })))).toEqual(['Alpha']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true })))).toEqual(['beta']);
    expect(titles(await inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, categoryIds: [CAT_1], useCategoryIntersect: true })))).toEqual(['Alpha']);
    const fromParam = withParams([{ field: 'tcontentcategoryassign.categoryid', condition: 'in', criteria: `${CAT_1},${CAT_2}`, datatype: 'varchar' }], {
      isFeaturesOnly: true,
      featureType: 'category',
    });
    expect(titles(await inA((tx) => feedContent(tx, fromParam)))).toEqual(['Alpha', 'Gamma']);
    await expect(inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, featureType: 'category' }))).rejects.toThrow(/no feature filter/);
    await expect(
      inA((tx) => feedContent(tx, { ...base, isFeaturesOnly: true, categoryIds: [CAT_1, CAT_2], useCategoryIntersect: true })),
    ).rejects.toThrow(/HASFEATURES/);
  });

  it('applies the calendar display window with the caller clock', async () => {
    const calendar = { ...base, contentIds: [P.EVENTS] };
    expect(titles(await inA((tx) => feedContent(tx, calendar)))).toEqual(['Ev1']);
    expect(titles(await inA((tx) => feedContent(tx, { ...calendar, from: new Date(2026, 0, 1), to: new Date(2026, 1, 1) })))).toEqual([]);
    expect(titles(await inA((tx) => feedContent(tx, { ...calendar, today: new Date(2027, 6, 15) })))).toEqual(['Ev1', 'Ev2']);
  });

  it('serves fields, distinct and aggregates', async () => {
    const [row] = await inA((tx) => feedContent(tx, { ...base, fields: ['Title', 'bogus'], maxItems: 1 }));
    expect(Object.keys(row ?? {})).toEqual(['title', 'displayinterval', 'displaystart', 'displaystop', 'display', 'siteid', 'contentid', 'parenttype']);
    expect(row?.parenttype).toBe('Folder');
    expect(titles(await inA((tx) => feedContent(tx, { ...base, distinct: true })))).toEqual(['Alpha', 'beta', 'Events', 'Gamma']);
    await expect(inA((tx) => feedContent(tx, { ...base, distinct: true, sortBy: 'priority' }))).rejects.toThrow(/DISTINCT/);
    const groups = await inA((tx) => feedContent(tx, { ...base, sortBy: '', aggregates: { groupBy: ['tcontent.type'], count: ['*'], sum: ['tcontent.orderno'] } }));
    expect([...groups].sort((a, b) => String(a.type).localeCompare(String(b.type)))).toEqual([
      { type: 'Calendar', count: 1, sum_orderno: 4 },
      { type: 'Page', count: 3, sum_orderno: 6 },
    ]);
    await expect(inA((tx) => feedContent(tx, { ...base, aggregates: { sum: ['tusers.x'] } }))).rejects.toBeInstanceOf(FeedAuthorizationError);
    await expect(inA((tx) => feedContent(tx, { ...base, sortBy: 'tsettings.siteid' }))).rejects.toBeInstanceOf(FeedAuthorizationError);
  });

  it('refuses remote feeds, alternate tables and the marketing sort', async () => {
    await expect(inA((tx) => feedContent(tx, { ...base, type: 'Remote' }))).rejects.toThrow('This function is not available for remote feeds.');
    await expect(inA((tx) => feedContent(tx, { ...base, altTable: 'tplugin_x' }))).rejects.toThrow(/alternate table/);
    expect(await inA((tx) => feedContent(tx, { ...base, altTable: 'TContent' }))).toHaveLength(4);
    await expect(inA((tx) => feedContent(tx, { ...base, sortBy: 'mxpRelevance' }))).rejects.toThrow(/mxpRelevance/);
  });

  it('keeps tenants apart', async () => {
    expect(titles(await inA((tx) => feedContent(tx, { ...base, contentPoolSiteIds: [SITE, SITE_B] })))).toEqual(['Alpha', 'beta', 'Events', 'Gamma']);
    expect(titles(await inB((tx) => feedContent(tx, { ...base, siteId: SITE_B, contentPoolSiteIds: [SITE, SITE_B] })))).toEqual(['Bravo']);
    expect((await inB((tx) => listFeeds(tx, { siteId: SITE, type: 'local' })))).toEqual([]);
    expect(await inB((tx) => feedTypeCount(tx, {}))).toEqual([{ total: 1 }]);
  });

  it('waits out a legacy write window', async () => {
    const holderId = `window-${randomUUID()}`;
    const units = [UNIT_OF.content, UNIT_OF.feed];
    await closeGates(handle.app, { units, holderId, phase: 'executing', allowLegacy: true });
    try {
      await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => feedContent(tx, base), { budgetMs: 200 })).rejects.toBeInstanceOf(UnitReadBlockedError);
      await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => listFeeds(tx, { siteId: SITE, type: 'local' }), { budgetMs: 200 })).rejects.toBeInstanceOf(
        UnitReadBlockedError,
      );
    } finally {
      await openGates(handle.app, { units, holderId, state: 'legacy' });
    }
  });
});
