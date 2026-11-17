/** The SQL feed source against the in-memory beanFeed evaluator over the same rows: identical pages, counts and errors. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_ENTITIES } from '../../src/legacy/jsonapi-entities.js';
import type { JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { FeedRunner, FeedTableSpec } from '../../src/repo/bean-feed-sql.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { COMMENT, CONTENT_UNITS } from '../../src/repo/tables.js';
import {
  beanFeedQuery,
  createJsonApiParams,
  mergedSource,
  rowsSource,
  type BeanFeedOptions,
  type BeanFeedSource,
  type JsonApiCall,
} from '../../src/routes/jsonapi/types.js';
import { scopeRows } from '../helpers/feed.js';

type Row = Record<string, unknown>;

const SITE = TENANT_A.siteId;
const EMPTY_SITE = 'no-rows-site';
const NAN_SITE = 'nan-site';
const ASTRAL_SITE = 'astral-site';
const ENDPOINT = `http://localhost:8080/index.cfm/_api/json/v1/${SITE}`;
const cfId = (n: number): string => `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const STATS = CONTENT_ENTITIES.stats;
const COMMENTS = CONTENT_ENTITIES.comment;

const STATS_FIELDS = ['contentID', 'siteID', 'views', 'rating', 'totalVotes', 'upVotes', 'downVotes', 'comments', 'disableComments', 'majorVersion', 'minorVersion', 'lockID', 'lockType'];
const STATS_OPTIONS: BeanFeedOptions = {
  primaryKey: STATS.primaryKey,
  propertyNames: STATS_FIELDS,
  columns: STATS_FIELDS,
  hints: STATS.hints,
  relations: [...STATS.hasMany, ...STATS.hasOne],
  table: 'tcontentstats',
};
const COMMENT_COLUMNS = COMMENT.columns.map((column) => column.name).filter((name) => name !== 'tenant_id');
const COMMENT_OPTIONS: BeanFeedOptions = {
  primaryKey: 'commentid',
  propertyNames: [...COMMENT_COLUMNS, 'errors', 'isnew', 'nextn', 'nope'],
  defaultSort: { sortBy: 'entered', sortDirection: 'asc' },
  columns: COMMENT_COLUMNS,
  hints: COMMENTS.hints,
  relations: [...COMMENTS.hasMany, ...COMMENTS.hasOne],
  table: 'tcontentcomments',
};
/** `hints` without `name`'s. */
const withoutHint = <H extends Readonly<Record<string, unknown>>>(hints: H, name: string): H =>
  Object.fromEntries(Object.entries(hints).filter(([key]) => key !== name)) as H;
// `entered` without its date hint compares as varchar, which CFML cannot do with a date value.
const UNDATED_HINTS = withoutHint(COMMENTS.hints, 'entered');
const UNRATED_HINTS = withoutHint(STATS.hints, 'rating');

/**
 * The URL scope legacy parses from `raw`: decoded keys and values, a later key replacing an earlier one. `%uXXXX` is
 * one UTF-16 code unit, so a value can carry the lone surrogates a JSON body can.
 */
function urlScope(raw: string): Row {
  const url: Row = {};
  for (const item of raw.split('&').filter((part) => part !== '')) {
    const [key = '', ...rest] = item.split('=');
    const unit = (_: string, hex: string): string => String.fromCharCode(parseInt(hex, 16));
    const decode = (s: string): string => decodeURIComponent(s.replaceAll('+', ' ').replace(/%u([0-9A-Fa-f]{4})/g, unit));
    const name = decode(key);
    const existing = Object.keys(url).find((k) => k.toLowerCase() === name.toLowerCase());
    url[existing ?? name] = decode(rest.join('='));
  }
  return url;
}

/** The call ../jsonapi.ts would hand a handler for `raw`. */
function callFor(method: string, raw: string, entityName: string): JsonApiCall {
  const url = urlScope(raw);
  const apiContext = {
    siteId: SITE,
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: {},
    method,
    isAggregateQuery: false,
    user: { loggedIn: true, systemUser: true },
    allowAction: () => false,
    customImageSizes: () => Promise.resolve([]),
  } as unknown as JsonApiRequestContext;
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:${entityName}.${method.toLowerCase()}`,
    method,
    entityName,
    pathInfo: [SITE, entityName],
    params: createJsonApiParams(Object.entries(url)),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: SITE,
    tenantId: TENANT_A.tenantId,
    actor: { userId: 'U1', fullName: '', isLoggedIn: true, s2: true, roles: ['s2'], siteId: SITE, tenantId: TENANT_A.tenantId },
    site: {} as JsonApiCall['site'],
    apiContext,
    httpMethod: 'GET',
    headers: {},
    validateCsrf: () => Promise.resolve(true),
  };
}

/** What one beanFeedQuery call answered or raised, with the URL scope it left. */
type Outcome = { value: unknown; url: Row } | { error: { name: string; message: string; type: unknown }; url: Row };

async function outcomeOf(rows: readonly Row[] | BeanFeedSource<Row>, method: string, raw: string, entity: string, options: BeanFeedOptions): Promise<Outcome> {
  const call = callFor(method, raw, entity);
  try {
    const value = await beanFeedQuery(rows, call, options);
    return { value, url: { ...call.apiContext.url } };
  } catch (err) {
    const error = err as Error & { type?: unknown };
    return { error: { name: error.constructor.name, message: error.message, type: error.type }, url: { ...call.apiContext.url } };
  }
}

let handle: ThrowawaySchema;
let dropSchema: (() => Promise<void>) | undefined;
let repo: ContentRepository;
const statements: { sql: string; rows: number }[] = [];

/** A transaction handle that records each feed statement and its row count. */
function recording(tx: TenantTx): TenantTx {
  return {
    kind: tx.kind,
    tenantId: tx.tenantId,
    schema: tx.schema,
    onCommit: (cb, onError) => {
      tx.onCommit(cb, onError);
    },
    query: (async (text: string | { text: string }, values?: unknown[]) => {
      const result = await tx.query(text, values);
      statements.push({ sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
      return result;
    }) as TenantTx['query'],
  };
}

const runner = (tenantId: string): FeedRunner => (fn) => withTenant(handle.app, tenantId, (tx) => fn(recording(tx)));

/** Every statement recorded since `statements` was emptied reads at most one batch: a LIMIT, an aggregate or a cursor FETCH. */
function expectBounded(from: string): void {
  for (const { sql, rows } of statements) {
    const fetched = /^FETCH FORWARD (\d+) FROM bean_feed_scan_\d+$/.exec(sql);
    if (fetched !== null) expect(Number(fetched[1])).toBeLessThanOrEqual(500);
    if (sql.startsWith('SELECT ') && sql.includes(from)) expect(sql).toMatch(/ LIMIT |^SELECT \(SELECT count\(\*\)|^SELECT EXISTS \(/);
    expect(rows).toBeLessThanOrEqual(500);
  }
}

/** The scope spec of `comment` rows of `siteId`, in comment id order. */
function commentSpec(siteId: string): FeedTableSpec {
  return {
    defs: [COMMENT],
    from: `${handle.schema}.comment`,
    where: ['tenant_id = $1', 'siteid = $2'],
    values: [siteId],
    columns: Object.fromEntries(
      COMMENT.columns.filter((column) => column.name !== 'tenant_id').map((column) => [column.name, { sql: column.name, type: column.type }]),
    ),
    tieBreak: ['commentid'],
  };
}

const BULK_SITE = 'bulk-site';
const BULK_ROWS = 3000;
// The bulk row whose name, `Йx`, a range class raises on.
const BULK_RAISING_ROW = 1500;

/**
 * `count` comment rows of `siteId` numbered after `first`: every fifth name holds an `x`, one Cyrillic name a range class
 * raises on; dates, counts and numeric-text urls repeat and hold NULLs, and some urls are text no number reads.
 */
async function insertBulk(tenantId: string, siteId: string, first: number, count: number): Promise<void> {
  await withTenant(handle.app, tenantId, (tx) =>
    tx.query(
      `INSERT INTO ${handle.schema}.comment (tenant_id, commentid, siteid, name, entered, flagcount, isapproved, url)` +
        ` SELECT $1, lpad(g::text, 8, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF', $2,` +
        ` CASE WHEN g = $3::integer + ${String(BULK_RAISING_ROW)} THEN 'Йx' WHEN g % 5 = 0 THEN 'ax' || (g % 13) ELSE 'b' || (g % 13) END,` +
        ` CASE WHEN g % 11 = 0 THEN NULL ELSE timestamp '2026-01-01' + (g % 17) * interval '1 day' END,` +
        ` CASE WHEN g % 7 = 0 THEN NULL ELSE g % 9 END, 1,` +
        ` CASE WHEN g % 10 = 0 THEN NULL WHEN g % 97 = 0 AND g % 5 <> 0 THEN 'n/a' ELSE (g % 89)::text END` +
        ` FROM generate_series($3::integer + 1, $3::integer + $4::integer) AS g`,
      [tx.tenantId, siteId, first, count],
    ),
  );
}

async function insert(tenantId: string, table: string, rows: readonly Row[]): Promise<void> {
  await withTenant(handle.app, tenantId, async (tx) => {
    for (const row of rows) {
      const names = Object.keys(row);
      const placeholders = names.map((_, i) => `$${String(i + 2)}`).join(', ');
      await tx.query(`INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${placeholders})`, [
        tx.tenantId,
        ...Object.values(row),
      ]);
    }
  });
}

const stat = (n: number, values: Row, siteid = SITE): Row => ({ contentid: cfId(n), siteid, views: 0, rating: 0, ...values });
const STAT_ROWS: Row[] = [
  stat(1, { views: 3, rating: 4.5, lockid: 'U9', locktype: 'node', majorversion: 1, minorversion: 0 }),
  stat(2, { views: 3, rating: 0.1, lockid: 'u9', locktype: 'Node ', minorversion: 2 }),
  stat(3, { views: 7, rating: 4.5, locktype: 'nöde', majorversion: 2 }),
  stat(4, { views: 0, rating: -2.25, lockid: '', totalvotes: 4 }),
  stat(5, { views: 10, rating: 1e20, locktype: 'NODE\t', comments: 2 }),
  stat(6, { views: 9, rating: -0, locktype: '10', disablecomments: 1 }),
  stat(7, { views: -1, rating: 3, locktype: '9' }),
  stat(8, { views: 3, rating: 4.5, locktype: 'a😀b' }),
  stat(9, { views: 3, rating: 4.5, locktype: 'x_y', upvotes: 5 }),
  stat(10, { views: 12, rating: 2, locktype: 'Ä' }),
  stat(11, { views: 12, rating: 2, locktype: 'a' }),
  stat(12, { views: 12, rating: 2, locktype: 'A' }),
  stat(13, { views: 12, rating: 2, locktype: 'á', majorversion: 1 }),
  stat(14, { views: 5, rating: 1, locktype: 'a\u0323\u0302' }),
  stat(15, { views: 5, rating: 1, locktype: 'a\u0302\u0323' }),
  stat(16, { views: 5, rating: 1, locktype: ' ' }),
  stat(17, { views: 5, rating: 1, locktype: 'ß' }),
  stat(18, { views: 5, rating: 1, locktype: 'ss' }),
  stat(19, { views: 5, rating: 1, locktype: 'ſ' }),
  stat(20, { views: 5, rating: 1, locktype: 'K' }),
  stat(21, { views: 5, rating: 1, locktype: '\u212A' }),
  stat(22, { views: 5, rating: 1, locktype: 'ǅ' }),
  stat(23, { views: 5, rating: 1, locktype: 'µ' }),
  stat(24, { views: 5, rating: 1, locktype: 'Μ' }),
  stat(25, { views: 5, rating: 1, locktype: 'ı' }),
  stat(26, { views: 5, rating: 1, locktype: 'İ' }),
  stat(27, { views: 5, rating: 1, locktype: 'x%y' }),
  stat(28, { views: 5, rating: 1, locktype: 'a\u00a0' }),
  stat(29, { views: 5, rating: 1, locktype: '' }),
  stat(30, { views: 3, rating: 4.5, locktype: 'node', majorversion: 1 }, 'other-site'),
  stat(31, { views: 3, rating: Number.NaN, locktype: 'n' }, NAN_SITE),
  stat(32, { views: 4, rating: 2, locktype: 'm' }, NAN_SITE),
  stat(33, { views: 5, rating: Number.POSITIVE_INFINITY, locktype: 'o' }, NAN_SITE),
  // Astral text of several planes (plane 15 holds the unit image's own range), case variants, trailing spaces, and
  // texts whose collation a NUL inside an operand changes: a contraction, a reordered mark and a Thai prevowel.
  stat(51, { views: 1, locktype: '😀' }, ASTRAL_SITE),
  stat(52, { views: 2, locktype: '😁' }, ASTRAL_SITE),
  stat(53, { views: 3, locktype: 'a😀b' }, ASTRAL_SITE),
  stat(54, { views: 3, locktype: 'A😀B  ' }, ASTRAL_SITE),
  stat(55, { views: 4, locktype: '\u{10400}' }, ASTRAL_SITE),
  stat(56, { views: 4, locktype: '\u{10428}' }, ASTRAL_SITE),
  stat(57, { views: 5, locktype: 'x\u{1D7D8}\u{20000}y' }, ASTRAL_SITE),
  stat(58, { views: 5, locktype: '\u{E0041}\u{F0000}\u{10FFFF}' }, ASTRAL_SITE),
  stat(59, { views: 6, locktype: 'ab' }, ASTRAL_SITE),
  stat(60, { views: 6, locktype: 'AB\t' }, ASTRAL_SITE),
  stat(61, { views: 7, locktype: 'Й' }, ASTRAL_SITE),
  stat(62, { views: 7, locktype: 'a\u0323\u0302' }, ASTRAL_SITE),
  stat(63, { views: 7, locktype: '\u0e40\u0e01' }, ASTRAL_SITE),
  stat(64, { views: 8, locktype: '' }, ASTRAL_SITE),
  stat(65, { views: 8 }, ASTRAL_SITE),
  stat(66, { views: 9, locktype: 'é😀ß' }, ASTRAL_SITE),
];

const comment = (n: number, values: Row, siteid = SITE): Row => ({ commentid: cfId(n), siteid, ...values });
const COMMENT_ROWS: Row[] = [
  comment(101, { name: 'Alice', entered: new Date(2026, 0, 5), flagcount: 0, isapproved: 1, email: 'a@x.org', comments: '50% off_now' }),
  comment(102, { name: 'bob', entered: new Date(2026, 1, 1, 8, 30, 0, 123), flagcount: 2, isapproved: 0, parentid: cfId(101) }),
  comment(103, { name: 'Carol ', entered: new Date(2025, 11, 31), flagcount: 5, isapproved: 1 }),
  comment(104, { name: 'alice\t', entered: new Date(2026, 0, 5), flagcount: 10, isapproved: 1, parentid: cfId(101) }),
  comment(105, { name: 'ÁLICE', flagcount: 1, isapproved: 0, comments: 'a😀b' }),
  comment(106, { name: 'Bob', entered: new Date(2026, 1, 1, 8, 30, 0, 123), isapproved: 1 }),
  comment(107, { entered: new Date(2026, 2, 1), flagcount: 2, isapproved: 1, comments: 'plain' }),
  comment(108, { name: 'a😀b', entered: new Date(2024, 5, 30, 23, 59, 59, 999), flagcount: 3, isapproved: 1 }),
  comment(109, { name: '', flagcount: 3, isapproved: null }),
  comment(110, { name: 'Zed', entered: new Date(2026, 0, 5), flagcount: 0, isapproved: 1, comments: 'x_y' }),
  comment(201, { name: 'Bob', entered: new Date(2026, 0, 6), flagcount: 1, isapproved: 1 }, SITE),
  comment(202, { name: 'alice', entered: new Date(2026, 0, 5), flagcount: 4, isapproved: 0 }, SITE),
];

// Requests on stats rows: every condition, null, like, lists, grouping, sorts, paging, countOnly, and their errors.
const STATS_QUERIES: string[] = [
  '',
  'views=3', 'views=gt%5E3', 'views=gte%5E3', 'views=lt%5E3', 'views=lte%5E3', 'views=neq%5E3', 'views=in%5E3', 'views=notin%5E3',
  'views=like%5E3', 'views=*3', 'views=abc', 'views=%203', 'views=3.0', 'views=-1', 'views=null', 'views=neq%5Enull', 'views=gt%5Enull',
  'views=in%5E3%2C7', 'views=3%01',
  'rating=4.5', 'rating=gt%5E0', 'rating=lt%5E0', 'rating=0', 'rating=-0', 'rating=1e20', 'rating=100000000000000000000', 'rating=0.1',
  'majorversion=null', 'majorversion=neq%5Enull', 'majorversion=1', 'majorversion=in%5Enull',
  'locktype=node', 'locktype=NODE', 'locktype=n%C3%B6de', 'locktype=node%20', 'locktype=gt%5Em', 'locktype=lt%5Enode', 'locktype=gte%5E9',
  'locktype=in%5Enode%2C9', 'locktype=notin%5Enode', 'locktype=in%5E', 'locktype=notin%5E', 'locktype=*od*', 'locktype=begins%5En',
  'locktype=ends%5Ee', 'locktype=contains%5E%C3%B6', 'locktype=like%5En_de', 'locktype=like%5E%5Bnm%5Dode', 'locktype=like%5E%5Ba-n%5Dode',
  'locktype=like%5E%25%5B0-9%5D', 'locktype=like%5Ea_b', 'locktype=like%5Ea%25b', 'locktype=like%5Ex_y', 'locktype=like%5Ex%5B_%5Dy',
  'locktype=like%5Ex%5B%25%5Dy', 'locktype=like%5E%5B%5D%5D', 'locktype=like%5E%5Bz-a%5D', 'locktype=like%5E%5B', 'locktype=10', 'locktype=gt%5E9',
  'locktype=null', 'locktype=neq%5Enull', 'locktype=', 'locktype=%20', 'locktype=a', 'locktype=%C3%A1', 'locktype=ss', 'locktype=SS',
  'locktype=like%5Ess', 'locktype=like%5Es', 'locktype=like%5Ek', 'locktype=like%5E%E2%84%AA', 'locktype=like%5E%C7%86', 'locktype=like%5E%C7%84',
  'locktype=like%5E%CE%BC', 'locktype=like%5Ei', 'locktype=like%5E%C4%B1', 'locktype=like%5E%5Bk-l%5D', 'locktype=like%5E%5B%C2%B5%5D',
  'locktype=a%CC%A3%CC%82', 'locktype=a%00', 'locktype=like%5Ea%00', 'locktype=*', 'locktype=a%C2%A0', 'locktype=like%5Ea',
  'lockid=u9', 'lockid=U9', 'lockid=', 'lockid=null', 'lockid=like%5Eu_', 'contentid=00000001-aaaa-bbbb-ccccddddeeeeffff', `id=${cfId(3)}`,
  'siteid=TENANT-A', 'views=3&or&locktype=10', 'openGrouping&views=3&or&views=7&closeGrouping&locktype=node',
  'views=3&orOpenGrouping&locktype=9&closeGrouping', 'andOpenGrouping&views=0&closeGrouping', 'openGrouping&views=3', 'closeGrouping',
  'views=3&closeGrouping', 'isnew=1', 'content=x', 'addObjects=1', 'views=foo%5Ebar%5Ebaz',
  'sort=views', 'sort=-views', 'sort=views%2C-rating', 'sort=locktype', 'sort=-locktype', 'sort=lockid', 'sort=majorversion', 'sort=-majorversion',
  'sort=rating%2Clocktype', 'sort=-rating', 'orderby=-views', 'sortBy=views&sortDirection=desc', 'sortBy=locktype%2Cviews&sortDirection=DESC',
  'sortBy=views', 'sortDirection=desc', 'sort=tcontentstats.views', 'sort=other.views', 'sort=nope', 'sort=views%3Bdrop', 'sort=-locktype&sort=views',
  'sortBy=tusers.password', 'sort=locktype&locktype=like%5Ea%25',
  'itemsPerPage=2', 'itemsPerPage=2&pageIndex=2', 'itemsPerPage=3&pageIndex=3', 'itemsPerPage=*', 'itemsPerPage=0', 'itemsPerPage=-2',
  'itemsPerPage=1.5', 'itemsPerPage=2&pageIndex=99', 'itemsPerPage=2&pageIndex=0', 'itemsPerPage=2&pageIndex=-1', 'pageIndex=2.5&itemsPerPage=2',
  'itemsPerPage=-1&pageIndex=2', 'itemsPerPage=-2&pageIndex=-3', 'startIndex=3', 'startIndex=0', 'startIndex=3&itemsPerPage=2',
  'startIndex=99&itemsPerPage=2', 'startIndex=-4&itemsPerPage=2', 'nextn=2', 'nextN=2&pageIndex=2', 'offset=1', 'maxitems=3',
  'maxitems=3&itemsPerPage=2&pageIndex=2', 'maxitems=*', 'maxitems=-1', 'maxitems=2.5', 'size=2', 'limit=1', 'maxItems=abc',
  'views=3&sort=-rating&itemsPerPage=2&pageIndex=2', 'locktype=like%5E%25a%25&sort=-locktype&maxitems=4&itemsPerPage=3&pageIndex=2',
  'countOnly=true', 'countOnly=true&views=3', 'countOnly=1&maxitems=1', 'countOnly=true&sort=nope', 'countOnly=true&groupBy=views',
  'countOnly=true&locktype=like%5Ea_b', 'countOnly=no&views=3',
  'innerJoin=content', 'leftJoin=content', 'innerJoin=site', 'groupBy=views', 'sum=views', 'sum=views&sort=views',
  // LIKE classes the in-memory feed cannot compute on some values, alone, behind other errors and in clause order.
  'locktype=like%5E%5B!-%2F%5D', 'locktype=like%5E%5Ba-%5C%5D', 'locktype=begins%5E%5Bx--z%5D', 'locktype=begins%5Ezz%5B!-%2F%5D',
  'locktype=begins%5En%5B!-%2F%5D', 'locktype=begins%5E%5Ba-z%5D', 'locktype=begins%5E%5B%C3%BEa-z%5D', 'locktype=x*%5B%5E', 'locktype=*%5B%5E',
  'locktype=like%5E%5B%5D', 'countOnly=true&locktype=like%5E%5B!-%2F%5D',
  'locktype=like%5E%5B!-%2F%5D&sort=nope', 'locktype=begins%5Ezz%5B!-%2F%5D&sort=nope', 'countOnly=true&groupBy=views&locktype=like%5E%5B!-%2F%5D',
  'views=like%5E%5B0-9%5D', 'views=like%5E%5B!-%2F%5D', 'rating=like%5E%5B!-%2F%5D', 'rating=like%5E%5B!-%2F%5D&sort=nope', 'rating=like%5E%5B0-9%5D',
  'locktype=like%5E%5B!-%2F%5D&views=like%5E%5Bx--z%5D', 'views=like%5E%5Bx--z%5D&locktype=like%5E%5B!-%2F%5D',
  'locktype=like%5E%5B!-%2F%5D&sort=-rating', 'locktype=like%5E%5B!-%2F%5D&maxitems=-1',
];

// Requests on comment rows, whose `entered` timestamps and NULL names the stats rows lack.
const COMMENT_QUERIES: string[] = [
  '', 'entered=2026-01-05', 'entered=gt%5E2026-01-01', 'entered=1%2F5%2F2026', 'entered=in%5E2026-01-05', 'entered=notin%5E2026-01-05',
  'entered=null', 'entered=neq%5Enull', 'entered=x', 'entered=2026-02-01%2008%3A30%3A00.123', 'entered=lte%5E2024-06-30%2023%3A59%3A59.999',
  "entered=%7Bts%20'2026-01-05%2000%3A00%3A00'%7D", 'entered=gt%5E1%2F5%2F2026%2011%3A00%20PM', 'entered=like%5E2026',
  'name=bob', 'name=BOB', 'name=alice', 'name=*o*', 'name=like%5Ea_b', 'name=like%5Ea%25b', 'name=null', 'name=neq%5Enull', 'name=', 'name=in%5E',
  'name=gt%5Eb', 'comments=like%5E%2550%5B%25%5D%25', 'comments=like%5E%25%5B_%5D%25', 'comments=like%5Ea_b', 'flagcount=gt%5E1',
  'flagcount=in%5E2', 'flagcount=notin%5E2', 'isapproved=1', 'isapproved=null', 'parentid=null', `parentid=${cfId(101)}`,
  'isapproved=1&or&name=bob&flagcount=0', 'openGrouping&name=bob&or&flagcount=5&closeGrouping&isapproved=1',
  'sort=entered', 'sort=-entered', 'sort=-entered%2Cname', 'sort=name', 'sort=-name%2C-flagcount', 'sort=parentid', 'sort=-isapproved%2Centered',
  'sortDirection=desc', 'sortBy=flagcount&sortDirection=desc', 'nope=1', 'sort=nope', 'itemsPerPage=3&pageIndex=2', 'startIndex=5&itemsPerPage=2',
  'countOnly=true&entered=gt%5E2026-01-01', 'name=bob&sort=entered', 'name=alice&sort=entered', 'name=carol&sort=entered',
  'isapproved=0&sort=entered', 'isapproved=0&sort=-isapproved%2Centered',
  // A complex value and a LIKE class raising on the same row, in either clause order, and behind a sort that would pair.
  'entered=x&name=contains%5E%5B!-%2F%5D', 'name=contains%5E%5B!-%2F%5D&entered=x', 'name=contains%5E%5B!-%2F%5D&sort=entered',
  'comments=like%5E%25%5Ba-c%5D%25',
];

// The beanFeedQuery LIKE cases of jsonapi-types.test.ts, and classes the in-memory feed cannot compute, on name.
const LIKE_QUERIES: string[] = [
  'begins%5E_b', 'begins%5Ea%5Bbx%5D', 'ends%5Eb%5Bc-d%5D', 'begins%5Ea%5B%5D.%5Dc', 'begins%5E%5Bab', 'begins%5Ea.c', 'contains%5E(a%2Bb)',
  'begins%5EABC', 'ends%5Ec', 'begins%5Ea', 'begins%5Ea%25b', 'begins%5Ea%25%25b', 'like%5E%25', 'contains%5Ea%25b', 'begins%5Eab%25b',
  'ends%5E%5B_%5Dc', 'contains%5E%5B%25%5D', 'ends%5Ebx', 'ends%5Ex_', 'ends%5Ebx%20', 'contains%5E%5Bz-a%5D', 'contains%5E%5Bz-ab%5D',
  'ends%5E%5Bz-ab-c%5D',
  'begins%5E%5Ba-Z%5D', 'begins%5E%5BA-z%5D', 'begins%5E%5Ba-c%5D', 'contains%5E%5B%5D', 'begins%5E%5Ba-c-e%5D', 'begins%5E%5Bd-%5D',
  'begins%5E%5BZ-a5%5D', 'begins%5E%5B9-A%5D', 'x*%5B%5E', 'begins%5Ezz%5B!-%2F%5D',
  'contains%5E%5B!-%2F%5D', 'contains%5E%5Ba-%5C%5D', 'begins%5E%5Bx--z%5D', 'begins%5E%5B%C3%BEa-z%5D', 'begins%5E%5Ba-z%5D', '*%5B%5E',
  'like%5E%5B', 'begins%5Eb%5Ba-c%5D', 'begins%5Ec%5Ba-c%5D', 'begins%5Ed%5Ba-c%5D', 'begins%5Ee%5Ba-c%5D', 'begins%5Ee%5B%C3%BEa-c%5D',
  'begins%5Ef%5Ba-c%5D', 'begins%5Ef%5B!-%2F%5D', 'begins%5Eg%5B!-%2F%5D', 'begins%5Eh%5Ba-c%5D', 'ends%5E%5B0-9%5D', 'like%5E%5Ba-c%5D_',
].map((criteria) => `name=${criteria}`);

// Requests on astral text: likes by code unit (`_`, classes and ranges holding astral characters or lone surrogates,
// lone-surrogate literals matching halves), NUL in patterns, criteria and lists, lone-surrogate operands, countOnly.
const ASTRAL_QUERIES: string[] = [
  'locktype=like%5E_', 'locktype=like%5E__', 'locktype=like%5E___', 'locktype=like%5E%25_', 'locktype=like%5E_%25', 'locktype=like%5E%25__%25',
  'locktype=like%5Ea_b', 'locktype=like%5Ea__b', 'locktype=like%5E%25_%F0%9F%98%80%25', 'locktype=like%5E%25%F0%9F%98%80%25',
  'locktype=like%5E%F0%90%90%A8', 'locktype=like%5E%uD801%uDC28', 'locktype=like%5Ex%25y', 'locktype=like%5E%25%F4%8F%BF%BF',
  'locktype=like%5E%5B%F0%9F%98%80%5D_', 'locktype=like%5E%5B%F0%9F%98%80%5D%5B%F0%9F%98%80%5D', 'locktype=like%5E%25%5B%F0%9F%98%80%5D',
  'locktype=like%5E%5Ba-%F0%9F%98%80%5D%25', 'locktype=like%5E%5B%uD800-%uDBFF%5D%25', 'locktype=like%5E%25%5B%uDC00-%uDFFF%5D',
  'locktype=like%5E%5B%F0%90%90%80%5D%25', 'locktype=like%5E%5B%uDE00%5D', 'locktype=like%5E%25%5B%uDE00b%5D',
  'locktype=like%5E%25%uD83D%25', 'locktype=like%5E%uD83D_', 'locktype=like%5E_%uDE00', 'locktype=like%5E%25%uDB80%25', 'locktype=like%5E%25%uD800%25',
  'locktype=like%5Ea%00%25', 'locktype=like%5E%25%00', 'locktype=like%5E%5B%00a%5D%25', 'locktype=like%5E%5B%00%5D', 'locktype=*%F0%9F%98%80*',
  'locktype=a%00b', 'locktype=%00', 'locktype=%D0%98%00%CC%86', 'locktype=%D0%98%CC%86', 'locktype=a%CC%82%00%CC%A3', 'locktype=%E0%B9%80%00%E0%B8%81',
  'locktype=in%5Ea%00b%2C%00', 'locktype=notin%5E%D0%98%00%CC%86', 'locktype=neq%5Ea%00b', 'locktype=gt%5Ea%00', 'locktype=lte%5E%D0%98%00%CC%86',
  'locktype=%uD83D', 'locktype=x%uD83D', 'locktype=neq%5E%uD83D', 'locktype=in%5E%uD83D', 'locktype=notin%5E%uD83D', 'locktype=in%5E%uD83D%2Cab',
  'locktype=notin%5E%uD83D%2Cab', 'locktype=gt%5E%uD83D', 'locktype=in%5E%uD83D&or&views=8', 'locktype=notin%5E%uD83D&or&views=8',
  'locktype=%F0%9F%98%80', 'locktype=A%F0%9F%98%80B', 'locktype=in%5E%F0%9F%98%81%2Cab',
  'locktype=like%5E%25_%25&sort=views&itemsPerPage=3&pageIndex=2', 'locktype=like%5E__&sort=-views&itemsPerPage=2', 'sort=locktype',
  'locktype=like%5E%25%uD83D%25&sort=-locktype&itemsPerPage=2',
  'countOnly=true&locktype=like%5E__', 'countOnly=true&locktype=like%5E%25%uD83D%25', 'countOnly=true&locktype=like%5E%25%00',
  'countOnly=true&locktype=%uD83D', 'countOnly=true&locktype=notin%5E%uD83D%2C%00',
  'locktype=like%5E%5Ba-c%5D', 'locktype=begins%5E%5Ba-c%5D', 'locktype=ends%5E%5B0-9%5D', 'locktype=like%5E%5B%uD83D-%uDE00%5D',
  'locktype=like%5E%5B%F0%9F%98%80-a%5D', 'locktype=begins%5Ea%5B%uDE00%5D', 'locktype=x*%5B%5E',
];

/** A comment row of `siteid` holding only `values`. */
const commentOf = (n: number, siteid: string, values: Row): Row => ({ commentid: cfId(n), siteid, ...values });
const LIKE_SITE = 'like-site';
const CLASS_SITE = 'class-site';
const RAISE_SITE = 'raise-site';
const LONG_SITE = 'long-site';
const FIRST_LIKE_SITE = 'first-like-site';
const FIRST_COMPLEX_SITE = 'first-complex-site';
// The LIKE_ROWS and CLASS_ROWS names of jsonapi-types.test.ts, then a value per kind of code unit a class may raise on.
const LIKE_SITE_ROWS: Row[] = ['abc', 'ABD', 'a.c', 'a]c', '[ab', '(a+b)', 'xbx  ', '', 'a%_c', null].map((name, i) => commentOf(301 + i, LIKE_SITE, { name }));
const CLASS_SITE_ROWS: Row[] = 'b B z Z _ [ ^ m á Á ç d - e % 5 ax% xb a'.split(' ').map((name, i) => commentOf(321 + i, CLASS_SITE, { name }));
const RAISE_SITE_ROWS: Row[] = ['abc', 'bЙ', 'c中文', 'd😀', 'eþ', 'f!', 'gb', 'zz!', 'zz', null, '', 'xb', 'x%', '9', 'þ'].map((name, i) =>
  commentOf(401 + i, RAISE_SITE, { name, url: i === 6 ? 'x' : null }),
);
const LONG_SITE_ROWS: Row[] = ['a'.repeat(60), `${'a'.repeat(60)}c`, `${'a'.repeat(408)}þaaa`, 'b'.repeat(500)].map((name, i) =>
  commentOf(601 + i, LONG_SITE, { name }),
);
const ENTERED = new Date(2026, 0, 5);
// Each site's first raising row raises on one param only: a LIKE class first, then a complex value, or the other way.
const FIRST_ROWS: Row[] = [
  commentOf(501, FIRST_LIKE_SITE, { name: 'abc', entered: null }),
  commentOf(502, FIRST_LIKE_SITE, { name: null, entered: ENTERED }),
  commentOf(511, FIRST_COMPLEX_SITE, { name: null, entered: ENTERED }),
  commentOf(512, FIRST_COMPLEX_SITE, { name: 'abc', entered: null }),
];
const COMMENT_SCOPES: readonly (readonly [string, string, readonly Row[]])[] = [
  ['comment like rows', LIKE_SITE, LIKE_SITE_ROWS],
  ['comment class rows', CLASS_SITE, CLASS_SITE_ROWS],
  ['comment raise rows', RAISE_SITE, RAISE_SITE_ROWS],
  ['comment long rows', LONG_SITE, LONG_SITE_ROWS],
  ['comment first like', FIRST_LIKE_SITE, FIRST_ROWS.slice(0, 2)],
  ['comment first complex', FIRST_COMPLEX_SITE, FIRST_ROWS.slice(2)],
];
// A begins pattern of `classes` [a-c] classes; 409 is the most SQL compiles, a class raising on a code unit without a rank.
const CLASS_HEAVY = (classes: number): string => `name=begins%5E${'%5Ba-c%5D'.repeat(classes)}`;
const REDOS = `name=like%5E${'%25a'.repeat(8)}%25b`;

/** Each request case: method, query string, options name. */
const OPTION_SETS: Readonly<Record<string, BeanFeedOptions>> = {
  stats: STATS_OPTIONS,
  'stats without the rating hint': { ...STATS_OPTIONS, hints: UNRATED_HINTS },
  'stats with a numeric locktype': { ...STATS_OPTIONS, hints: { ...STATS.hints, lockType: 'integer' } },
  'stats with a date locktype': { ...STATS_OPTIONS, hints: { ...STATS.hints, lockType: 'date' } },
  'stats without hints': { ...STATS_OPTIONS, hints: {} },
  'stats with row columns': { ...STATS_OPTIONS, columns: undefined },
  comment: COMMENT_OPTIONS,
  'comment with a varchar entered': { ...COMMENT_OPTIONS, hints: UNDATED_HINTS },
  'comment with row columns': { ...COMMENT_OPTIONS, columns: undefined },
};

describe.skipIf(!(await pgAvailable()))('SQL beanFeed source against the in-memory evaluator', () => {
  const sources: Record<string, { sql: BeanFeedSource<Row>; rows: Row[] }> = {};

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    const created = handle;
    dropSchema = () => created.drop();
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'bean-feed-sql-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'bean-feed-sql-test', state: 'open' });
    repo = createContentRepository({ schema: handle.schema });
    await insert(TENANT_A.tenantId, 'content_stats', STAT_ROWS);
    await insert(TENANT_B.tenantId, 'content_stats', [stat(40, { views: 3, rating: 4.5, locktype: 'node' })]);
    await insert(TENANT_A.tenantId, 'comment', COMMENT_ROWS.filter((row) => Number(String(row['commentid']).slice(0, 8)) < 200));
    await insert(TENANT_B.tenantId, 'comment', COMMENT_ROWS.filter((row) => Number(String(row['commentid']).slice(0, 8)) >= 200));
    await insert(TENANT_A.tenantId, 'comment', COMMENT_SCOPES.flatMap(([, , rows]) => rows));
    await insertBulk(TENANT_A.tenantId, BULK_SITE, 10_000, BULK_ROWS);
    await insertBulk(TENANT_B.tenantId, BULK_SITE, 20_000, 1000);
    const scopes: [string, FeedTableSpec, string][] = [
      ['bulk', commentSpec(BULK_SITE), TENANT_A.tenantId],
      ['bulk of tenant B', commentSpec(BULK_SITE), TENANT_B.tenantId],
      ...COMMENT_SCOPES.map(([name, siteId]): [string, FeedTableSpec, string] => [name, commentSpec(siteId), TENANT_A.tenantId]),
      ['stats', repo.stats.siteStatsFeed({ siteId: SITE }), TENANT_A.tenantId],
      ['stats of ids', repo.stats.siteStatsFeed({ siteId: SITE, contentIds: [cfId(3), cfId(1).toLowerCase(), cfId(9), cfId(99)] }), TENANT_A.tenantId],
      ['stats of no site rows', repo.stats.siteStatsFeed({ siteId: EMPTY_SITE }), TENANT_A.tenantId],
      ['stats with NaN', repo.stats.siteStatsFeed({ siteId: NAN_SITE }), TENANT_A.tenantId],
      ['stats with astral text', repo.stats.siteStatsFeed({ siteId: ASTRAL_SITE }), TENANT_A.tenantId],
      ['comment', commentSpec(SITE), TENANT_A.tenantId],
      ['comment of tenant B', commentSpec(SITE), TENANT_B.tenantId],
      ['comment of no site rows', commentSpec(EMPTY_SITE), TENANT_A.tenantId],
    ];
    for (const [name, spec, tenantId] of scopes) {
      const sql = repo.beanFeed.source<Row>(runner(tenantId), spec);
      sources[name] = { sql, rows: await scopeRows(sql) };
    }
  });

  afterAll(async () => {
    await dropSchema?.();
  });

  /** The in-memory and SQL outcomes of one request over a named scope. */
  async function compare(scope: string, method: string, raw: string, options: BeanFeedOptions, entity: string): Promise<Outcome> {
    const source = sources[scope];
    if (source === undefined) throw new Error(`no scope ${scope}`);
    const expected = await outcomeOf(source.rows, method, raw, entity, options);
    const actual = await outcomeOf(source.sql, method, raw, entity, options);
    expect(actual).toEqual(expected);
    return expected;
  }

  it('reads the rows siteStats read: the site and tenant scope in clustered key order', async () => {
    const legacy = await withTenant(handle.app, TENANT_A.tenantId, async (tx) =>
      (
        await tx.query(
          `SELECT contentid, siteid, views, rating, totalvotes, upvotes, downvotes, comments, majorversion, minorversion, lockid, locktype,` +
            ` disablecomments FROM ${handle.schema}.content_stats WHERE tenant_id = $1 AND siteid = $2 ORDER BY contentid, siteid`,
          [tx.tenantId, SITE],
        )
      ).rows,
    );
    expect(sources['stats']?.rows).toEqual(legacy);
    expect(sources['stats']?.rows).toHaveLength(29);
    expect(sources['stats of ids']?.rows.map((row) => row['contentid'])).toEqual([cfId(1), cfId(3), cfId(9)]);
  });

  const statsCases = Object.entries(OPTION_SETS)
    .filter(([name]) => name.startsWith('stats'))
    .flatMap(([name]) => STATS_QUERIES.map((raw): [string, string] => [name, raw]));
  it.each(statsCases)('stats findQuery under %s: %s', async (name, raw) => {
    await compare('stats', 'findQuery', raw, OPTION_SETS[name] ?? STATS_OPTIONS, 'stats');
  });

  const commentCases = Object.entries(OPTION_SETS)
    .filter(([name]) => name.startsWith('comment'))
    .flatMap(([name]) => COMMENT_QUERIES.map((raw): [string, string] => [name, raw]));
  it.each(commentCases)('comment findQuery under %s: %s', async (name, raw) => {
    await compare('comment', 'findQuery', raw, OPTION_SETS[name] ?? COMMENT_OPTIONS, 'comment');
  });

  const astralCases = Object.entries(OPTION_SETS)
    .filter(([name]) => name.startsWith('stats'))
    .flatMap(([name]) => ASTRAL_QUERIES.map((raw): [string, string] => [name, raw]));
  it.each(astralCases)('stats findQuery over astral text under %s: %s', async (name, raw) => {
    await compare('stats with astral text', 'findQuery', raw, OPTION_SETS[name] ?? STATS_OPTIONS, 'stats');
  });

  const likeCases = COMMENT_SCOPES.slice(0, 3).flatMap(([scope]) =>
    ['comment', 'comment with row columns'].flatMap((name) => LIKE_QUERIES.map((raw): [string, string, string] => [scope, name, raw])),
  );
  it.each(likeCases)('%s findQuery under %s: %s', async (scope, name, raw) => {
    await compare(scope, 'findQuery', raw, OPTION_SETS[name] ?? COMMENT_OPTIONS, 'comment');
  });

  it('raises the in-memory LIKE errors at the rows they are reached on, so the comparison exercises the data', async () => {
    const outcome = async (scope: string, raw: string, options = COMMENT_OPTIONS): Promise<unknown> => {
      const found = await compare(scope, 'findQuery', `${raw}&sort=commentid`, options, 'comment');
      return 'value' in found ? ((found.value as { items?: Row[] }).items ?? []).map((row) => Number(String(row['commentid']).slice(0, 8))) : found.error;
    };
    const unsupported = (content: string): unknown => ({ name: 'UnsupportedFeedQueryError', message: `LIKE class [${content}]` });
    // Cyrillic, CJK, astral text and þ have no rank a range orders.
    for (const raw of ['name=begins%5Eb%5Ba-c%5D', 'name=begins%5Ec%5Ba-c%5D', 'name=begins%5Ed%5Ba-c%5D', 'name=begins%5Ee%5Ba-c%5D']) {
      expect(await outcome('comment raise rows', raw)).toEqual(unsupported('a-c'));
    }
    expect(await outcome('comment raise rows', 'name=begins%5Ee%5B%C3%BEa-c%5D')).toEqual([405]);
    expect(await outcome('comment raise rows', 'name=begins%5E%5Ba-z%5D')).toEqual(unsupported('a-z'));
    expect(await outcome('comment raise rows', 'name=begins%5E%5B%C3%BEa-z%5D')).toEqual([401, 402, 403, 404, 405, 406, 407, 408, 409, 412, 413, 415]);
    expect(await outcome('comment raise rows', 'name=begins%5Ef%5Ba-c%5D')).toEqual([]);
    expect(await outcome('comment raise rows', 'name=begins%5Ef%5B!-%2F%5D')).toEqual(unsupported('!-/'));
    expect(await outcome('comment raise rows', 'name=begins%5Ezz%5B!-%2F%5D')).toEqual(unsupported('!-/'));
    expect(await outcome('comment class rows', 'name=begins%5Ezz%5B!-%2F%5D')).toEqual([]);
    expect(await outcome('comment class rows', 'name=contains%5E%5Ba-%5C%5D')).toEqual(unsupported('a-\\'));
    expect(await outcome('comment class rows', 'name=begins%5E%5Bx--z%5D')).toEqual(unsupported('x--z'));
    expect(await outcome('comment class rows', 'name=x*%5B%5E')).toEqual([338]);
    expect(await outcome('comment class rows', 'name=contains%5E%5B%5D')).toEqual([]);
    expect(await outcome('comment class rows', 'name=begins%5E%5Ba-c%5D')).toEqual([321, 322, 329, 330, 337, 339]);
    // Within a row the first param in clause order raises; across rows the first row that raises decides.
    const undated = { ...COMMENT_OPTIONS, hints: UNDATED_HINTS };
    expect(await outcome('comment', 'entered=x&name=contains%5E%5B!-%2F%5D', undated)).toMatchObject({ name: 'TypeError' });
    expect(await outcome('comment', 'name=contains%5E%5B!-%2F%5D&entered=x', undated)).toEqual(unsupported('!-/'));
    expect(await outcome('comment first like', 'entered=x&name=contains%5E%5B!-%2F%5D', undated)).toEqual(unsupported('!-/'));
    expect(await outcome('comment first complex', 'name=contains%5E%5B!-%2F%5D&entered=x', undated)).toMatchObject({ name: 'TypeError' });
  });

  it.each([
    ['a class-heavy pattern as long as SQL compiles', CLASS_HEAVY(409)],
    ['a backtracking-hostile pattern over 60 characters', REDOS],
  ])('answers %s in SQL in bounded time', async (_label, raw) => {
    const started = performance.now();
    await compare('comment long rows', 'findQuery', raw, COMMENT_OPTIONS, 'comment');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it.each<[string, string, string, string, Readonly<Record<string, unknown>> | undefined]>([
    ['stats', 'findAll', 'views=3&sort=-views&itemsPerPage=4&pageIndex=2', 'stats', undefined],
    ['stats', 'findAll', 'countOnly=true', 'stats', undefined],
    ['stats of ids', 'findMany', '', 'stats', undefined],
    ['stats of ids', 'findMany', 'sort=-views', 'stats', undefined],
    ['stats of ids', 'findMany', 'countOnly=true', 'stats', undefined],
    ['stats of no site rows', 'findQuery', 'views=3&itemsPerPage=2&startIndex=4', 'stats', undefined],
    ['stats with NaN', 'findQuery', 'sort=rating', 'stats', undefined],
    ['stats with NaN', 'findQuery', 'sort=-rating%2Clocktype', 'stats', undefined],
    ['stats with NaN', 'findQuery', 'rating=neq%5E2', 'stats', undefined],
    ['stats with NaN', 'findQuery', 'rating=gt%5E1', 'stats', undefined],
    ['stats with NaN', 'findQuery', 'rating=notin%5E2', 'stats', undefined],
    ['comment of no site rows', 'findQuery', 'nope=1&sort=nope', 'comment', undefined],
    ['stats', 'findOne', 'itemsPerPage=1', 'stats', { views: 3, maxitems: '3' }],
    ['stats', 'findOne', '', 'stats', { locktype: 'NODE', sort: '-views' }],
    ['stats', 'findOne', '', 'stats', { locktype: '\uD800' }],
    ['stats', 'findOne', '', 'stats', { cachedWithin: '5' }],
    ['comment', 'findOne', '', 'comment', { entered: '2026-01-05', countOnly: 'true' }],
  ])('%s %s %s, expanded %j', async (scope, method, raw, entity, expandedParams) => {
    const base = entity === 'stats' ? STATS_OPTIONS : COMMENT_OPTIONS;
    const options = expandedParams === undefined ? base : { ...base, expandedParams };
    await compare(scope, method, raw, options, entity);
    await compare(scope, method, raw, { ...options, columns: undefined }, entity);
  });

  it('answers the legacy rows for representative requests, so the comparison exercises the data', async () => {
    const ids = (outcome: Outcome): unknown =>
      'value' in outcome ? ((outcome.value as { items?: Row[] }).items ?? []).map((row) => Number(String(row['contentid']).slice(0, 8))) : outcome.error;
    expect(ids(await compare('stats', 'findQuery', 'locktype=node&sort=contentid', STATS_OPTIONS, 'stats'))).toEqual([1, 2, 5]);
    expect(ids(await compare('stats', 'findQuery', 'locktype=a&sort=contentid', STATS_OPTIONS, 'stats'))).toEqual([11, 12, 28]);
    expect(ids(await compare('stats', 'findQuery', 'locktype=a%CC%A3%CC%82', STATS_OPTIONS, 'stats'))).toEqual([14, 15]);
    expect(ids(await compare('stats', 'findQuery', 'locktype=like%5Ea_b', STATS_OPTIONS, 'stats'))).toEqual([]);
    expect(ids(await compare('stats', 'findQuery', 'locktype=like%5Ek', STATS_OPTIONS, 'stats'))).toEqual([20]);
    expect(ids(await compare('stats', 'findQuery', 'views=12&sort=locktype', STATS_OPTIONS, 'stats'))).toEqual([11, 12, 13, 10]);
    expect(await compare('stats', 'findQuery', 'countOnly=true&views=3', STATS_OPTIONS, 'stats')).toMatchObject({ value: { count: 4 } });
    const converted = await compare('comment', 'findQuery', 'entered=x', { ...COMMENT_OPTIONS, hints: UNDATED_HINTS }, 'comment');
    expect(converted).toMatchObject({ error: { name: 'TypeError', message: 'Complex object types cannot be converted to simple values.' } });
    const single = await compare('comment', 'findQuery', 'name=carol&sort=entered', { ...COMMENT_OPTIONS, hints: UNDATED_HINTS }, 'comment');
    expect(single).toHaveProperty('value');
    const paired = await compare('comment', 'findQuery', 'name=alice&sort=entered', { ...COMMENT_OPTIONS, hints: UNDATED_HINTS }, 'comment');
    expect(paired).toMatchObject({ error: { name: 'TypeError' } });
  });

  it('answers the in-memory rows for astral, NUL and lone-surrogate requests, so the comparison exercises the data', async () => {
    const ids = async (raw: string): Promise<unknown> => {
      const outcome = await compare('stats with astral text', 'findQuery', `${raw}&sort=contentid`, STATS_OPTIONS, 'stats');
      return 'value' in outcome ? ((outcome.value as { items?: Row[] }).items ?? []).map((row) => Number(String(row['contentid']).slice(0, 8))) : outcome.error;
    };
    expect(await ids('locktype=like%5Ea__b')).toEqual([53, 54]);
    expect(await ids('locktype=like%5E___')).toEqual([53, 54, 57, 58, 62, 66]);
    expect(await ids('locktype=like%5E%25%uD83D%25')).toEqual([51, 52, 53, 54, 66]);
    expect(await ids('locktype=like%5E%25%uDB80%25')).toEqual([58]);
    expect(await ids('locktype=like%5E%25%uD800%25')).toEqual([]);
    expect(await ids('locktype=a%00b')).toEqual([59, 60]);
    expect(await ids('locktype=%00')).toEqual([64]);
    // NUL blocks the contraction, so the operand does not collate as Й does without it.
    expect(await ids('locktype=%D0%98%CC%86')).toEqual([61]);
    expect(await ids('locktype=%D0%98%00%CC%86')).toEqual([]);
    expect(await ids('locktype=neq%5E%uD83D')).toHaveLength(15);
    expect(await ids('locktype=in%5E%uD83D&or&views=8')).toEqual([64, 65]);
    const counted = await compare('stats with astral text', 'findQuery', 'countOnly=true&locktype=notin%5E%uD83D%2C%00', STATS_OPTIONS, 'stats');
    expect(counted).toMatchObject({ value: { count: 14 } });
  });

  it('pages with one count and one LIMIT/OFFSET statement that returns only the page rows', async () => {
    const feedStatements = (): { sql: string; rows: number }[] => statements.filter((s) => s.sql.includes('content_stats'));
    statements.length = 0;
    const page = await beanFeedQuery(sources['stats']?.sql ?? [], callFor('findQuery', 'views=gte%5E3&sort=-views&itemsPerPage=2&pageIndex=2', 'stats'), STATS_OPTIONS);
    expect(page).toMatchObject({ page: { recordCount: 27, pageIndex: 2, nextN: 2 } });
    expect(feedStatements().map((s) => (s.sql.includes('LIMIT') ? 'page' : s.sql.includes('count(*)') ? 'count' : 'other'))).toEqual(['count', 'page']);
    expect(feedStatements()[1]?.rows).toBe(2);

    statements.length = 0;
    await beanFeedQuery(sources['stats']?.sql ?? [], callFor('findQuery', 'countOnly=true&views=3', 'stats'), STATS_OPTIONS);
    expect(feedStatements().map((s) => s.sql.includes('LIMIT'))).toEqual([false]);

    statements.length = 0;
    await beanFeedQuery(sources['stats']?.sql ?? [], callFor('findQuery', 'itemsPerPage=2&pageIndex=99&sort=nope', 'stats'), STATS_OPTIONS).catch(() => undefined);
    expect(feedStatements()).toEqual([]);
  });

  const ASTRAL = 'stats with astral text';
  const NUMERIC_LOCKTYPE = OPTION_SETS['stats with a numeric locktype'] ?? STATS_OPTIONS;
  const UNRATED = OPTION_SETS['stats without the rating hint'] ?? STATS_OPTIONS;
  const CLASSES = 'comment class rows';
  const RAISES = 'comment raise rows';
  const LONG = 'comment long rows';
  // `scan` is a cursor read of the scope a batch at a time, which only the documented fallbacks issue.
  it.each<[string, string[], string, string, BeanFeedOptions]>([
    ['a plain like', ['count', 'page'], 'stats', 'locktype=like%5Enode&itemsPerPage=2', STATS_OPTIONS],
    ['an `_` like over astral text', ['count', 'page'], 'stats', 'locktype=like%5Ea__b&itemsPerPage=1', STATS_OPTIONS],
    ['an `_` like over astral text, countOnly', ['count'], ASTRAL, 'countOnly=true&locktype=like%5E_', STATS_OPTIONS],
    ['a class holding an astral character', ['count', 'first'], ASTRAL, 'locktype=like%5E%5Ba-%F0%9F%98%80%5D%25&itemsPerPage=2', STATS_OPTIONS],
    ['a lone-surrogate like', ['count', 'page'], ASTRAL, 'locktype=like%5E%25%uD83D%25&itemsPerPage=2', STATS_OPTIONS],
    ['a NUL like, countOnly', ['count'], ASTRAL, 'countOnly=true&locktype=like%5Ea%00%25', STATS_OPTIONS],
    ['a NUL criteria', ['count', 'page'], ASTRAL, 'locktype=a%00b&itemsPerPage=1', STATS_OPTIONS],
    ['a NUL in an in list', ['count', 'page'], ASTRAL, 'locktype=in%5Ea%00b%2C%00&itemsPerPage=2', STATS_OPTIONS],
    ['a lone-surrogate equality', ['count', 'page'], ASTRAL, 'locktype=neq%5E%uD83D&itemsPerPage=2', STATS_OPTIONS],
    ['a lone surrogate in a not in list', ['count', 'page'], ASTRAL, 'locktype=notin%5E%uD83D%2Cab&itemsPerPage=2', STATS_OPTIONS],
    ['a lone surrogate ordered against text', ['scan', 'scan'], ASTRAL, 'locktype=gt%5E%uD83D&itemsPerPage=2', STATS_OPTIONS],
    ['a sort over NaN ratings', ['count', 'scan', 'scan'], 'stats with NaN', 'sort=rating&itemsPerPage=1', STATS_OPTIONS],
    ['a numeric hint on a text column', ['scan'], 'stats', 'locktype=1&itemsPerPage=2', NUMERIC_LOCKTYPE],
    ['a class that can raise on no row', ['count', 'page'], CLASSES, 'name=contains%5E%5Ba-c%5D&itemsPerPage=2', COMMENT_OPTIONS],
    ['a class that can raise, reached on no row', ['count', 'page'], CLASSES, 'name=begins%5Ezz%5B!-%2F%5D&or&commentid=*&itemsPerPage=2', COMMENT_OPTIONS],
    ['a class raising on a row', ['count', 'first'], RAISES, 'name=begins%5Eb%5Ba-c%5D&itemsPerPage=2', COMMENT_OPTIONS],
    ['a class raising on a row, countOnly', ['count', 'first'], RAISES, 'countOnly=true&name=contains%5E%5B!-%2F%5D', COMMENT_OPTIONS],
    ['a class raising on a row before a sort error', ['first'], RAISES, 'name=contains%5E%5B!-%2F%5D&sort=nope', COMMENT_OPTIONS],
    ['a class raising on no row before a sort error', ['first'], CLASSES, 'name=begins%5Ezz%5B!-%2F%5D&sort=nope', COMMENT_OPTIONS],
    ['a class raising on a float column without the text SQL holds', ['scan'], 'stats', 'rating=like%5E%5B!-%2F%5D&sort=nope', UNRATED],
    ['a backtracking-hostile pattern', ['count', 'page'], LONG, `${REDOS}&or&commentid=*`, COMMENT_OPTIONS],
    ['a class-heavy pattern as long as SQL compiles', ['count', 'first'], LONG, CLASS_HEAVY(409), COMMENT_OPTIONS],
    ['a class-heavy pattern longer than SQL compiles', ['scan'], LONG, CLASS_HEAVY(410), COMMENT_OPTIONS],
    ['a literal pattern as long as SQL compiles', ['count'], LONG, `name=begins%5E${'b'.repeat(16383)}`, COMMENT_OPTIONS],
    ['a literal pattern longer than SQL compiles', ['scan'], LONG, `name=begins%5E${'b'.repeat(16384)}`, COMMENT_OPTIONS],
  ])('%s reads %j', async (_label, kinds, scope, raw, options) => {
    const comment = scope.startsWith('comment');
    statements.length = 0;
    await compare(scope, 'findQuery', raw, options, comment ? 'comment' : 'stats');
    const from = comment ? ` FROM ${handle.schema}.comment ` : '."content_stats" ';
    const read = statements
      .filter((s) => s.sql.includes(from))
      .map((s) => (s.sql.startsWith('DECLARE ') ? 'scan' : s.sql.includes(' OFFSET ') ? 'page' : s.sql.endsWith(' LIMIT 1') ? 'first' : s.sql.includes('count(*)') ? 'count' : 'scope'));
    expect(read).toEqual(kinds);
    expectBounded(from);
  });

  describe('filters without a SQL form over thousands of rows', () => {
    const bulkFrom = (): string => ` FROM ${handle.schema}.comment `;
    /** A LIKE pattern past the lengths SQL compiles: `%` repeated, then `tail`. */
    const longLike = (tail: string): string => `name=like%5E${'%25'.repeat(16_400)}${tail}`;
    const LONG_X = longLike('x%25');
    const LONG_B = longLike('b%25');
    // Past the length SQL compiles for a class that can raise; it raises on the bulk row named `Йx`.
    const LONG_RAISING = `name=like%5E${'%25'.repeat(2050)}%5Ba-c%5Dx%25`;
    const URL_NUMERIC: BeanFeedOptions = { ...COMMENT_OPTIONS, hints: { ...COMMENTS.hints, url: 'integer' } };
    const UNDATED = OPTION_SETS['comment with a varchar entered'] ?? COMMENT_OPTIONS;

    it.each<[string, BeanFeedOptions, string]>([
      ['the first page of one', COMMENT_OPTIONS, `${LONG_X}&itemsPerPage=1`],
      ['a middle page of one', COMMENT_OPTIONS, `${LONG_X}&itemsPerPage=1&pageIndex=300`],
      ['the last page of one', COMMENT_OPTIONS, `${LONG_X}&itemsPerPage=1&pageIndex=600`],
      ['a page past the end', COMMENT_OPTIONS, `${LONG_X}&itemsPerPage=1&pageIndex=900`],
      ['countOnly', COMMENT_OPTIONS, `countOnly=true&${LONG_X}`],
      ['a sort SQL orders, descending over ties and NULLs', COMMENT_OPTIONS, `${LONG_X}&sort=-flagcount%2Cname&itemsPerPage=7&pageIndex=40`],
      ['a sort SQL cannot order, the first page', URL_NUMERIC, `${LONG_X}&sort=url&itemsPerPage=5`],
      ['a sort SQL cannot order, a middle page over ties and NULLs', URL_NUMERIC, `${LONG_X}&sort=url&itemsPerPage=5&pageIndex=60`],
      ['a sort SQL cannot order, descending, the last page', URL_NUMERIC, `${LONG_X}&sort=-url%2Cflagcount&itemsPerPage=50&pageIndex=13`],
      ['a sort over values the comparator cannot order', URL_NUMERIC, `${LONG_B}&sort=url&itemsPerPage=25&pageIndex=7`],
      ['a sort pairing complex values', UNDATED, `${LONG_X}&sort=entered&itemsPerPage=1`],
      ['a class raising on a row deep in the scope', COMMENT_OPTIONS, `${LONG_RAISING}&itemsPerPage=1`],
      ['a class raising on a row deep in the scope, countOnly', COMMENT_OPTIONS, `countOnly=true&${LONG_RAISING}`],
      ['a complex value on the first row before the raising class', UNDATED, `entered=x&${LONG_RAISING}`],
      ['a raising class before a sort pairing complex values', UNDATED, `${LONG_RAISING}&sort=entered`],
      ['a raising class before a sort error', COMMENT_OPTIONS, `${LONG_RAISING}&sort=nope`],
    ])('answers %s as the in-memory evaluator does, from batch-bounded reads', async (_label, options, raw) => {
      statements.length = 0;
      await compare('bulk', 'findQuery', raw, options, 'comment');
      expectBounded(bulkFrom());
    });

    it('answers the bulk rows, so the comparison exercises the data', async () => {
      const ids = (outcome: Outcome): unknown =>
        'value' in outcome ? ((outcome.value as { items?: Row[] }).items ?? []).map((row) => row['name']) : outcome.error;
      expect(sources['bulk']?.rows).toHaveLength(BULK_ROWS);
      expect(await compare('bulk', 'findQuery', `countOnly=true&${LONG_X}`, COMMENT_OPTIONS, 'comment')).toMatchObject({ value: { count: 600 } });
      expect(ids(await compare('bulk', 'findQuery', `${LONG_X}&sort=-name&itemsPerPage=1`, COMMENT_OPTIONS, 'comment'))).toEqual(['Йx']);
      const raised = await compare('bulk', 'findQuery', `${LONG_RAISING}&itemsPerPage=1`, COMMENT_OPTIONS, 'comment');
      expect(raised).toMatchObject({ error: { name: 'UnsupportedFeedQueryError', message: 'LIKE class [a-c]' } });
      const paired = await compare('bulk', 'findQuery', `${LONG_X}&sort=entered&itemsPerPage=1`, UNDATED, 'comment');
      expect(paired).toMatchObject({ error: { name: 'TypeError' } });
    });

    it('pages one row from a count scan and a page scan that stops at its first batch', async () => {
      statements.length = 0;
      await compare('bulk', 'findQuery', `${LONG_X}&itemsPerPage=1`, COMMENT_OPTIONS, 'comment');
      expect(statements.filter((s) => s.sql.includes(bulkFrom())).map((s) => s.sql.split(' ')[0])).toEqual(['DECLARE', 'DECLARE']);
      const fetches = new Map<string, number>();
      for (const { sql } of statements.filter((s) => s.sql.startsWith('FETCH '))) {
        expect(sql).toMatch(/^FETCH FORWARD 500 FROM /);
        const cursor = sql.split(' ').at(-1) ?? '';
        fetches.set(cursor, (fetches.get(cursor) ?? 0) + 1);
      }
      // Six full batches and the empty one that ends the count scan, then the page scan's first batch.
      expect([...fetches.values()]).toEqual([7, 1]);
      expect(statements.filter((s) => s.sql.startsWith('CLOSE '))).toHaveLength(2);
    });

    it('re-reads only the page rows of a sort SQL cannot order, from the scan snapshot', async () => {
      statements.length = 0;
      await compare('bulk', 'findQuery', `${LONG_X}&sort=url&itemsPerPage=5&pageIndex=60`, URL_NUMERIC, 'comment');
      expect(statements.filter((s) => s.sql.startsWith('DECLARE ')).map((s) => / SCROLL CURSOR /.test(s.sql) && !/NO SCROLL/.test(s.sql))).toEqual([false, true]);
      const revisited = statements.filter((s) => /^(MOVE|FETCH) /.test(s.sql) && !s.sql.startsWith('FETCH FORWARD 500 '));
      expect(revisited[0]?.sql).toMatch(/^MOVE ABSOLUTE 0 FROM /);
      expect(revisited.filter((s) => s.sql.startsWith('FETCH ')).reduce((total, s) => total + s.rows, 0)).toBe(5);
    });

    it.each<[string, readonly string[], BeanFeedOptions, string]>([
      ['the first page', ['bulk', 'bulk of tenant B'], COMMENT_OPTIONS, `${LONG_X}&itemsPerPage=1`],
      ['a sort SQL cannot order, a page across the sources', ['bulk', 'bulk of tenant B'], URL_NUMERIC, `${LONG_X}&sort=-url&itemsPerPage=40&pageIndex=10`],
      ['a sort over values the comparator cannot order', ['bulk', 'bulk of tenant B'], URL_NUMERIC, `${LONG_B}&sort=url&itemsPerPage=9&pageIndex=11`],
      ['countOnly', ['bulk', 'bulk of tenant B'], COMMENT_OPTIONS, `countOnly=true&${LONG_X}`],
      ['a class raising in the second source only', ['bulk of tenant B', 'bulk'], COMMENT_OPTIONS, `${LONG_RAISING}&itemsPerPage=1`],
    ])('merges %s as the concatenated rows do', async (_label, scopes, options, raw) => {
      const parts = scopes.flatMap((scope) => sources[scope] ?? []);
      const expected = await outcomeOf(parts.flatMap((part) => part.rows), 'findQuery', raw, 'comment', options);
      statements.length = 0;
      expect(await outcomeOf(mergedSource(parts.map((part) => part.sql)), 'findQuery', raw, 'comment', options)).toEqual(expected);
      expectBounded(bulkFrom());
    });

    it('ranks a merged page afresh when a write between its ranking and its revisit shifts a source', async () => {
      const [bulk, other] = [sources['bulk'], sources['bulk of tenant B']];
      if (bulk === undefined || other === undefined) throw new Error('no bulk scopes');
      // Ahead of every bulk row in scope order, and onto the page by its name and url.
      const extra: Row = { commentid: cfId(9999), siteid: BULK_SITE, name: 'ax0', flagcount: 1, isapproved: 1, url: '88' };
      let writes = 0;
      const written: BeanFeedSource<Row> = {
        ...other.sql,
        scan: async (request, visit, revisit) => {
          if (visit === undefined && writes === 0) {
            writes += 1;
            await insert(TENANT_B.tenantId, 'comment', [extra]);
          }
          return other.sql.scan(request, visit, revisit);
        },
      };
      const raw = `${LONG_X}&sort=-url&itemsPerPage=40&pageIndex=10`;
      const items = (outcome: Outcome): unknown => ('value' in outcome ? (outcome.value as { items?: Row[] }).items : outcome.error);
      try {
        const answered = items(await outcomeOf(mergedSource([bulk.sql, written]), 'findQuery', raw, 'comment', URL_NUMERIC));
        expect(writes).toBe(1);
        expect(answered).toEqual(items(await outcomeOf([...bulk.rows, ...(await scopeRows(other.sql))], 'findQuery', raw, 'comment', URL_NUMERIC)));
        expect(answered).not.toEqual(items(await outcomeOf([...bulk.rows, ...other.rows], 'findQuery', raw, 'comment', URL_NUMERIC)));
      } finally {
        await withTenant(handle.app, TENANT_B.tenantId, (tx) =>
          tx.query(`DELETE FROM ${handle.schema}.comment WHERE tenant_id = $1 AND commentid = $2`, [tx.tenantId, extra['commentid']]),
        );
      }
    });
  });

  describe('merged sources', () => {
    let merged: BeanFeedSource<Row>;
    let rows: Row[];

    beforeAll(() => {
      const parts = [sources['comment'], sources['comment of tenant B']].flatMap((part) => (part === undefined ? [] : [part]));
      merged = mergedSource(parts.map((part) => part.sql));
      rows = parts.flatMap((part) => part.rows);
    });

    it.each(COMMENT_QUERIES.flatMap((raw) => ['comment', 'comment with a varchar entered'].map((name): [string, string] => [name, raw])))(
      'merge under %s: %s',
      async (name, raw) => {
        const options = OPTION_SETS[name] ?? COMMENT_OPTIONS;
        const expected = await outcomeOf(rows, 'findQuery', raw, 'comment', options);
        expect(await outcomeOf(merged, 'findQuery', raw, 'comment', options)).toEqual(expected);
        const memory = mergedSource([rowsSource(rows.slice(0, 4)), rowsSource(rows.slice(4))]);
        expect(await outcomeOf(memory, 'findQuery', raw, 'comment', options)).toEqual(expected);
      },
    );

    const UNDATED = OPTION_SETS['comment with a varchar entered'] ?? COMMENT_OPTIONS;
    it.each<[string, readonly string[], string, BeanFeedOptions, string]>([
      ['a LIKE class in the first source before a complex value in the second', ['comment first like', 'comment first complex'], 'entered=x&name=contains%5E%5B!-%2F%5D', UNDATED, 'UnsupportedFeedQueryError'],
      ['a complex value in the first source before a LIKE class in the second', ['comment first complex', 'comment first like'], 'entered=x&name=contains%5E%5B!-%2F%5D', UNDATED, 'TypeError'],
      ['a LIKE class in the second source before a complex pair the first sorts', ['comment', 'comment raise rows'], 'isapproved=1&or&url=contains%5E%5B!-%2F%5D&sort=entered', UNDATED, 'UnsupportedFeedQueryError'],
      ['a LIKE class in the second source only', ['comment class rows', 'comment raise rows'], 'name=begins%5Eb%5Ba-c%5D', COMMENT_OPTIONS, 'UnsupportedFeedQueryError'],
    ])('raises %s as the concatenated rows do', async (_label, scopes, raw, options, error) => {
      const parts = scopes.flatMap((scope) => sources[scope] ?? []);
      const expected = await outcomeOf(parts.flatMap((part) => part.rows), 'findQuery', raw, 'comment', options);
      expect(await outcomeOf(mergedSource(parts.map((part) => part.sql)), 'findQuery', raw, 'comment', options)).toEqual(expected);
      expect(expected).toMatchObject({ error: { name: error } });
    });
  });
});
