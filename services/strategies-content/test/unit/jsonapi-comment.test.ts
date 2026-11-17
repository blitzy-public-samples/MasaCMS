/** JSON API `comment` feeds over a throwaway content schema: SQL-bounded answers equal the whole-site in-memory feed. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates, qualified } from '@opt2/platform/migration-kit';
import { withTenant, type QueryResultRow, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type TenantFixture, type ThrowawaySchema } from '@opt2/platform/testing';
import { getComments } from '../../src/domain/comments.js';
import { CONTENT_CONFIG_DEFAULTS, type Actor } from '../../src/domain/context.js';
import type { JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { FeedTableSpec } from '../../src/repo/bean-feed-sql.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { commentHandler } from '../../src/routes/jsonapi/comment.js';
import { createJsonApiParams, rowsSource, type JsonApiCall, type JsonApiHandlerFn } from '../../src/routes/jsonapi/types.js';

type Row = Record<string, unknown>;
type Method = 'findMany' | 'findAll' | 'findQuery';
type BeanMethod = 'findOne' | 'findNew' | 'findPermissions' | 'save';

const SITE = TENANT_A.siteId;
const OTHER_SITE = 'other-site';
const ENDPOINT = `http://localhost:8080/index.cfm/_api/json/v1/${SITE}`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const cfId = (n: number): string => `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const C1 = cfId(901);
const C2 = cfId(902);
// A stored id in mixed case, which legacy's case-insensitive `IN` still finds.
const MIXED_ID = '00000003-aAaA-bBbB-cCcCdDdDeEeEfFfF';
const TIE = new Date(2026, 0, 5, 9, 0, 0);

const actor = (overrides: Partial<Actor>): Actor => ({
  userId: '',
  fullName: '',
  isLoggedIn: false,
  s2: false,
  roles: [],
  siteId: SITE,
  tenantId: TENANT_A.tenantId,
  ...overrides,
});
const PUBLIC = actor({});
const MODULE_USER = actor({ userId: 'U1', isLoggedIn: true, roles: ['system-user', 'm:015', 'm:000'] });

const comment = (id: string, values: Row, siteid = SITE): Row => ({ commentid: id, siteid, ...values });
const SITE_ROWS: Row[] = [
  comment(cfId(1), { contentid: C1, name: 'Alice', comments: 'Great post', email: 'a@x.test', entered: TIE, isapproved: 1, flagcount: 0, path: cfId(1) }),
  comment(cfId(2).toLowerCase(), { contentid: C1, name: 'bob', comments: 'Me too', entered: TIE, isapproved: 1, isspam: 1, parentid: cfId(1), subscribe: 1 }),
  comment(MIXED_ID, { contentid: C2, name: 'Carol ', comments: 'x_y', isapproved: 0, isdeleted: 1, flagcount: 2 }),
  comment(cfId(4), { contentid: C2, comments: 'No name', entered: new Date(2026, 1, 1, 8, 30, 0, 123), isapproved: 0, flagcount: 3, parentid: cfId(1) }),
  comment(cfId(5), { contentid: C1, name: 'ALICE', comments: '50% off', entered: TIE, isapproved: 1, flagcount: 1, subscribe: 0 }),
  comment(cfId(6), { contentid: C1, name: 'Zed', url: 'http://zed.test', entered: new Date(2025, 11, 31), isapproved: null, parentid: cfId(4).toLowerCase() }),
  comment(cfId(7), { contentid: C2, name: 'Dan', comments: 'Later', entered: new Date(2026, 2, 1), isapproved: 1, flagcount: 0, parentid: cfId(1), ip: '10.0.0.1' }),
  comment(cfId(8), { contentid: C1, name: 'ålice', comments: 'Accented', entered: new Date(2026, 0, 6), isapproved: 1, remoteid: 'R-8' }),
];
const FOREIGN_ROWS: Row[] = [comment(cfId(20), { name: 'Elsewhere', entered: TIE, isapproved: 1 }, OTHER_SITE)];
const TENANT_B_ROWS: Row[] = [comment(cfId(30), { name: 'Alice', entered: TIE, isapproved: 1, parentid: cfId(1) })];

/** The URL scope legacy parses from `raw`: decoded keys and values, a later key replacing an earlier one. */
function urlScope(raw: string): Row {
  const url: Row = {};
  for (const item of raw.split('&').filter((part) => part !== '')) {
    const [key = '', ...rest] = item.split('=');
    const decode = (s: string): string => decodeURIComponent(s.replaceAll('+', ' '));
    const name = decode(key);
    const existing = Object.keys(url).find((k) => k.toLowerCase() === name.toLowerCase());
    url[existing ?? name] = decode(rest.join('='));
  }
  return url;
}

/** The call ../jsonapi.ts would hand the handler. */
function callFor(method: Method, raw: string, who: Actor, ids?: string[]): JsonApiCall {
  const url = urlScope(raw);
  const apiContext = {
    siteId: SITE,
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: {},
    method,
    isAggregateQuery: false,
    user: { loggedIn: who.isLoggedIn, systemUser: who.roles.includes('system-user') },
    allowAction: () => false,
    customImageSizes: () => Promise.resolve([]),
  } as unknown as JsonApiRequestContext;
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:comment.${method.toLowerCase()}`,
    method,
    entityName: 'comment',
    ...(ids === undefined ? {} : { ids }),
    pathInfo: [SITE, 'comment'],
    params: createJsonApiParams(Object.entries(url)),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: SITE,
    tenantId: TENANT_A.tenantId,
    actor: who,
    site: { siteId: SITE, urls: { scheme: 'http' } } as unknown as JsonApiCall['site'],
    apiContext,
    httpMethod: 'GET',
    headers: {},
    validateCsrf: () => Promise.resolve(true),
  };
}

/** A bean call by `who` on `tenant`'s site as the entity route resolves it: path site as the `siteid` param, `raw` as the URL. */
function beanCall(method: BeanMethod, tenant: TenantFixture, id: string | undefined, raw = '', who: Actor = MODULE_USER): JsonApiCall {
  const call = callFor('findAll', raw, { ...who, siteId: tenant.siteId, tenantId: tenant.tenantId });
  return {
    ...call,
    routeKey: `api:comment.${method.toLowerCase()}`,
    method,
    ...(id === undefined ? {} : { id }),
    pathInfo: [tenant.siteId, 'comment'],
    params: createJsonApiParams([...Object.entries(call.apiContext.url), ['siteid', tenant.siteId]]),
    siteId: tenant.siteId,
    tenantId: tenant.tenantId,
    site: { siteId: tenant.siteId, urls: { scheme: 'http' } } as unknown as JsonApiCall['site'],
    apiContext: { ...call.apiContext, siteId: tenant.siteId, method, endpoint: `http://localhost:8080/index.cfm/_api/json/v1/${tenant.siteId}` },
  };
}

/** One recorded statement of a tenant transaction and the rows it returned. */
interface Statement {
  sql: string;
  rows: number;
}

/** `db` with every statement its tenant transactions run appended to `log`. */
function recordingDb(db: TenantDb, log: Statement[]): TenantDb {
  return {
    schema: db.schema,
    withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      return db.withTenant(tenantId, (tx) =>
        fn({
          ...tx,
          async query<R extends QueryResultRow = QueryResultRow>(text: Parameters<TenantTx['query']>[0], values?: unknown[]) {
            const result = await tx.query<R>(text, values);
            log.push({ sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
            return result;
          },
        }),
      );
    },
    withMetadata<T>(fn: Parameters<TenantDb['withMetadata']>[0], options?: Parameters<TenantDb['withMetadata']>[1]): Promise<T> {
      return db.withMetadata(fn, options) as Promise<T>;
    },
    end: () => db.end(),
  };
}

/** The removed findMany row test: SQL Server `IN` equality of a stored id, case-insensitive with trailing spaces ignored. */
function sameId(stored: string, id: string): boolean {
  return stored.trimEnd().toLowerCase() === id.trimEnd().toLowerCase();
}

let handle: ThrowawaySchema;
let dropSchema: (() => Promise<void>) | undefined;
let repo: ContentRepository;
let ctx: ContentRouteContext;
const statements: Statement[] = [];

async function insert(tenantId: string, rows: readonly Row[]): Promise<void> {
  await withTenant(handle.app, tenantId, async (tx) => {
    for (const row of rows) {
      const names = Object.keys(row);
      const placeholders = names.map((_, i) => `$${String(i + 2)}`).join(', ');
      await tx.query(`INSERT INTO ${handle.schema}.comment (tenant_id, ${names.join(', ')}) VALUES ($1, ${placeholders})`, [tx.tenantId, ...Object.values(row)]);
    }
  });
}

/** The previous handler's context: each feed evaluates in memory over the site's whole `getComments` feed (findMany: its `sameId` rows). */
async function wholeSiteContext(who: Actor): Promise<ContentRouteContext> {
  const all = await getComments(ctx.domain, who, { siteId: SITE, maxItems: 0 });
  const rows: Row[] = all.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'tenant_id')));
  const specIds = new WeakMap<FeedTableSpec, readonly string[] | undefined>();
  const repository = {
    ...repo,
    comments: {
      ...repo.comments,
      commentFeedSpec(args: { siteId: string; commentIds?: readonly string[] }): FeedTableSpec {
        const spec = repo.comments.commentFeedSpec(args);
        specIds.set(spec, args.commentIds);
        return spec;
      },
    },
    beanFeed: {
      source(_run: unknown, spec: FeedTableSpec) {
        const ids = specIds.get(spec);
        return rowsSource(ids === undefined ? rows : rows.filter((row) => ids.some((id) => sameId(String(row['commentid']), id))));
      },
    },
  };
  return { ...ctx, domain: { ...ctx.domain, repository } } as unknown as ContentRouteContext;
}

/** The handler of `method`. */
function handlerOf(method: Method | BeanMethod): JsonApiHandlerFn {
  const fn = commentHandler[method];
  if (fn === undefined) throw new Error(`commentHandler has no ${method}`);
  return fn;
}

/** What a handler call answered or raised, with the URL scope it left, serialized so key order counts. */
async function outcomeOf(context: ContentRouteContext, method: Method, raw: string, who: Actor, ids?: string[]): Promise<string> {
  const call = callFor(method, raw, who, ids);
  try {
    const result = await handlerOf(method)(context, call);
    return JSON.stringify({ result, url: call.apiContext.url });
  } catch (err) {
    const error = err as Error & { type?: unknown };
    return JSON.stringify({ error: { name: error.constructor.name, message: error.message, type: error.type }, url: call.apiContext.url });
  }
}

/** The recorded statements that read the comment table. */
function commentReads(): Statement[] {
  const table = `${qualified(handle.schema, 'comment')} `;
  return statements.filter((s) => s.sql.includes(table));
}

/** The `id`s of a collection answer. */
function itemIds(outcome: string): unknown {
  const parsed = JSON.parse(outcome) as { result?: { data?: { items?: Row[]; count?: number } }; error?: unknown };
  return parsed.result?.data?.items?.map((item) => item['id']) ?? parsed.result?.data?.count ?? parsed.error;
}

const ID_VARIANTS = [cfId(1).toLowerCase(), cfId(2).toUpperCase(), MIXED_ID.toUpperCase(), `${cfId(4)}  `, cfId(1), cfId(20), cfId(30), 'missing', `${cfId(5)}\u0000`];

// Requests over the site's comments: filters, grouping, sorts, paging, countOnly, kids expansion and their errors.
const FEED_CASES: [Method, string][] = [
  ['findAll', ''],
  ['findAll', 'countOnly=true'],
  ['findAll', 'itemsPerPage=2&pageIndex=2'],
  ['findAll', 'itemsPerPage=3&pageIndex=99'],
  ['findAll', 'itemsPerPage=*'],
  ['findAll', 'maxItems=3'],
  ['findAll', 'maxItems=*'],
  ['findAll', 'maxItems=3&itemsPerPage=2&pageIndex=2'],
  ['findAll', 'startIndex=4&itemsPerPage=2'],
  ['findAll', 'sortBy=name&sortDirection=desc'],
  ['findAll', 'sort=-entered%2Cname'],
  ['findAll', 'expand=kids'],
  ['findQuery', ''],
  ['findQuery', 'name=alice'],
  ['findQuery', 'name=ALICE&sort=-flagcount'],
  ['findQuery', 'name=*li*'],
  ['findQuery', 'name=neq%5Ealice'],
  ['findQuery', 'name=in%5Ealice%2Cbob'],
  ['findQuery', 'name=null'],
  ['findQuery', 'name=neq%5Enull'],
  ['findQuery', 'name=carol'],
  ['findQuery', 'comments=like%5Ex_y'],
  ['findQuery', 'comments=*50%25*'],
  ['findQuery', 'flagcount=gt%5E0'],
  ['findQuery', 'flagcount=in%5E0%2C3'],
  ['findQuery', 'isapproved=null'],
  ['findQuery', 'entered=2026-01-05%2009%3A00%3A00'],
  ['findQuery', 'entered=gt%5E2026-01-05'],
  ['findQuery', 'entered=null'],
  ['findQuery', `parentid=${cfId(1).toLowerCase()}`],
  ['findQuery', 'parentid=null&sort=name'],
  ['findQuery', 'isspam=1'],
  ['findQuery', 'isdeleted=1'],
  ['findQuery', 'isapproved=1&or&name=carol'],
  ['findQuery', 'openGrouping&name=bob&or&flagcount=3&closeGrouping&isapproved=0'],
  ['findQuery', 'sort=-flagcount%2Cname'],
  ['findQuery', 'sort=contentid'],
  ['findQuery', 'sort=-isapproved'],
  ['findQuery', 'sort=flagcount&itemsPerPage=3&pageIndex=2'],
  ['findQuery', 'sort=name&itemsPerPage=2&pageIndex=2'],
  ['findQuery', 'sortBy=entered&sortDirection=desc&itemsPerPage=3'],
  ['findQuery', 'countOnly=true&name=*a*'],
  ['findQuery', 'name=*a*&maxItems=2'],
  ['findQuery', 'expand=kids&parentid=null'],
  ['findQuery', 'expand=kids&expanddepth=2&parentid=null&maxitems=2'],
  ['findQuery', 'nope=1'],
  ['findQuery', 'sort=nope'],
  ['findQuery', 'isnew=1'],
  ['findMany', ''],
  ['findMany', 'sort=-entered'],
  ['findMany', 'sort=contentid'],
  ['findMany', 'countOnly=true'],
  ['findMany', 'itemsPerPage=2&pageIndex=2'],
  ['findMany', 'expand=kids'],
];

describe.skipIf(!(await pgAvailable()))('JSON API comment feeds', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    const created = handle;
    dropSchema = () => created.drop();
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-comment-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-comment-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    ctx = {
      domain: { db: recordingDb(handle.app, statements), repository: repo, clock: fixedClock(NOW), config: CONTENT_CONFIG_DEFAULTS },
    } as unknown as ContentRouteContext;
    await insert(TENANT_A.tenantId, [...SITE_ROWS, ...FOREIGN_ROWS]);
    await insert(TENANT_B.tenantId, TENANT_B_ROWS);
  });

  afterAll(async () => {
    await dropSchema?.();
  });

  const cases = [PUBLIC, MODULE_USER].flatMap((who) =>
    FEED_CASES.map(([method, raw]): [string, Method, string, Actor] => [who === PUBLIC ? 'public' : 'module user', method, raw, who]),
  );
  it.each(cases)('%s %s %s answers what the whole-site feed answered', async (_label, method, raw, who) => {
    const ids = method === 'findMany' ? ID_VARIANTS : undefined;
    const expected = await outcomeOf(await wholeSiteContext(who), method, raw, who, ids);
    expect(await outcomeOf(ctx, method, raw, who, ids)).toBe(expected);
  });

  it.each<[string, Method, string, string[] | undefined, unknown]>([
    ['the site rows of the tenant in entered then id order', 'findAll', '', undefined, [MIXED_ID, cfId(6), cfId(1), cfId(2).toLowerCase(), cfId(5), cfId(8), cfId(4), cfId(7)]],
    ['a case-insensitive name filter', 'findQuery', 'name=alice', undefined, [cfId(1), cfId(5)]],
    ['a page of a sort', 'findQuery', 'sort=-flagcount%2Cname&itemsPerPage=2&pageIndex=2', undefined, [cfId(5), cfId(1)]],
    ['the count', 'findQuery', 'countOnly=true&parentid=null', undefined, 4],
    ['the ids in their order with repeats', 'findMany', '', ID_VARIANTS, [cfId(1), cfId(2).toLowerCase(), MIXED_ID, cfId(1)]],
    ['the rows of ids with trailing spaces in feed order when sorted', 'findMany', 'sort=-entered', ID_VARIANTS, [cfId(4), cfId(1), cfId(2).toLowerCase(), MIXED_ID]],
    ['no row for no id', 'findMany', '', [], []],
  ])('answers %s', async (_label, method, raw, ids, expected) => {
    expect(itemIds(await outcomeOf(ctx, method, raw, MODULE_USER, ids))).toEqual(expected);
  });

  // A blank row (queryRowToStruct before row 1) sets '' on a new bean; set() skips its empty commentID, which
  // getCommentID creates when the field list reads it, each bean its own.
  it('answers the beans of blank rows before the first record, each under a fresh id', async () => {
    const outcome = JSON.parse(await outcomeOf(ctx, 'findAll', 'itemsPerPage=2&pageIndex=0', MODULE_USER)) as { result: { data: { items: Row[]; startindex: number } } };
    const { items, startindex } = outcome.result.data;
    expect(startindex).toBe(-1);
    expect(items).toHaveLength(2);
    for (const item of items) {
      const id = String(item['id']);
      expect(isCfUuid(id)).toBe(true);
      expect(item).toMatchObject({
        commentID: id,
        siteid: '',
        name: '',
        flagcount: 0,
        isapproved: 0,
        entered: NOW.toJSON(),
        isnew: 0,
        entityname: 'comment',
        links: expect.objectContaining({ self: `${ENDPOINT}/comment/${id}`, kids: `${ENDPOINT}/comment?parentid=${id}` }) as unknown,
      });
    }
    expect(items[0]?.['id']).not.toBe(items[1]?.['id']);
  });

  it('expands kids from the site rows of the tenant', async () => {
    const outcome = JSON.parse(await outcomeOf(ctx, 'findQuery', `expand=kids&id=${cfId(1)}`, MODULE_USER)) as { result: { data: { items: Row[] } } };
    const kids = outcome.result.data.items[0]?.['kids'] as { items: Row[] };
    expect(kids.items.map((item) => item['id'])).toEqual([cfId(4), cfId(7)]);
  });

  it.each<[string, Method, string, string[] | undefined, number[]]>([
    ['a findQuery page', 'findQuery', 'name=*a*&sort=-entered&itemsPerPage=2&pageIndex=2', undefined, [2]],
    ['a findMany page', 'findMany', 'itemsPerPage=2', [cfId(1), cfId(4), cfId(7)], [2]],
    ['a page and its kids expansion', 'findQuery', `id=${cfId(1)}&expand=kids`, undefined, [1, 2]],
  ])('reads %s with one count and one LIMIT/OFFSET statement per feed, returning only its rows', async (_label, method, raw, ids, pageRows) => {
    statements.length = 0;
    await outcomeOf(ctx, method, raw, MODULE_USER, ids);
    const reads = commentReads();
    const kinds = reads.map((s) => (/\bLIMIT\b.*\bOFFSET\b/.test(s.sql) ? 'page' : s.sql.includes('count(*)') ? 'count' : s.sql));
    expect(kinds).toEqual(pageRows.flatMap(() => ['count', 'page']));
    expect(reads.filter((_, index) => index % 2 === 1).map((s) => s.rows)).toEqual(pageRows);
  });

  it('answers countOnly with the count statement alone', async () => {
    statements.length = 0;
    expect(itemIds(await outcomeOf(ctx, 'findAll', 'countOnly=true', MODULE_USER))).toBe(8);
    const reads = commentReads();
    expect(reads.map((s) => s.sql.includes('count(*)') && !s.sql.includes('LIMIT'))).toEqual([true]);
  });

  it("findOne reads by id in the token tenant only, answering a new bean for tenant-b's comment where legacy loads it by id alone", async () => {
    const findOne = commentHandler.findOne;
    if (findOne === undefined) throw new Error('commentHandler has no findOne');
    const dataOf = async (id: string): Promise<Row> => {
      const base = callFor('findAll', '', PUBLIC);
      const call: JsonApiCall = { ...base, method: 'findOne', routeKey: 'api:comment.findone', id, apiContext: { ...base.apiContext, method: 'findOne' } };
      return (await findOne(ctx, call)).data as Row;
    };
    expect(await dataOf(cfId(1))).toMatchObject({ id: cfId(1), name: 'Alice', isnew: 0 });
    const foreign = await dataOf(cfId(30));
    expect(foreign).toMatchObject({ name: '', isnew: 1 });
    expect(String(foreign['id']).toUpperCase()).not.toBe(cfId(30).toUpperCase());
  });

  /** The `data` a bean call answered. */
  async function beanData(call: JsonApiCall): Promise<Row> {
    const result = await handlerOf(call.method as BeanMethod)(ctx, call);
    return result.data as Row;
  }

  const siteOf = (data: Row): Row => ({ siteid: data['siteid'], isnew: data['isnew'] });

  const NEW_BEAN_CALLS: [string, BeanMethod, string | undefined, string][] = [
    ['comment/new', 'findOne', 'new', ''],
    ['an unknown id', 'findOne', cfId(999), ''],
    ['findNew', 'findNew', undefined, ''],
    ['a failed new-comment save', 'save', undefined, ''],
    ['a failed new-comment save without the overlay', 'save', undefined, 'saveErrors=true'],
  ];
  it.each([TENANT_A, TENANT_B].flatMap((tenant) => NEW_BEAN_CALLS.map((c) => [tenant.siteId, ...c, tenant] as const)))(
    '%s: %s answers a new bean of the request site',
    async (site, _label, method, id, raw, tenant) => {
      expect(siteOf(await beanData(beanCall(method, tenant, id, raw)))).toEqual({ siteid: site, isnew: 1 });
    },
  );

  it.each([
    ['its request site', TENANT_A, cfId(1), SITE],
    ['another site of the tenant', TENANT_A, cfId(20), OTHER_SITE],
    ['a site other than the request site', TENANT_B, cfId(30), SITE],
  ])('findOne of a comment stored under %s keeps its own siteid', async (_label, tenant, id, stored) => {
    expect(siteOf(await beanData(beanCall('findOne', tenant, id)))).toEqual({ siteid: stored, isnew: 0 });
  });

  it.each([
    ['a stored parent keeps its own siteid', TENANT_A, cfId(4), { siteid: SITE, isnew: 0 }],
    ['a missing parent holds the request site', TENANT_B, cfId(30), { siteid: TENANT_B.siteId, isnew: 1 }],
  ])('expand=parent: %s', async (_label, tenant, id, expected) => {
    const data = await beanData(beanCall('findOne', tenant, id, 'expand=parent'));
    expect(siteOf(data['parent'] as Row)).toEqual(expected);
  });

  // [label, id, whether a row loads]: an unloaded bean holds the request site.
  const PERMISSION_IDS: [string, string, boolean][] = [
    ['an unknown CF UUID', cfId(999), false],
    ['an unknown 35-character id', '12345678901234567890123456789012345', false],
    ['a non-UUID id', 'abc', false],
    ['the comment/permissions path', 'permissions', false],
    ['a stored comment', cfId(1), true],
  ];
  it.each(
    PERMISSION_IDS.flatMap(([label, id, loads]): [string, string, string, Actor, Row][] => [
      [label, 'public', id, PUBLIC, { read: true, delete: false, save: !loads }],
      [label, 'module user', id, MODULE_USER, { read: true, delete: true, save: true }],
    ]),
  )('findPermissions of %s answers the %s what legacy answers', async (_label, _who, id, who, expected) => {
    expect(await beanData(beanCall('findPermissions', TENANT_A, id, '', who))).toEqual(expected);
  });

  it('findPermissions without an id fails as legacy does on an undefined argument', async () => {
    await expect(beanData(beanCall('findPermissions', TENANT_A, undefined))).rejects.toMatchObject({ name: 'LegacyApiError', type: 'server_error' });
  });
});
