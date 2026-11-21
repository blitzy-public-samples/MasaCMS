// Shared JSON API handler helpers of src/routes/jsonapi/types.ts. Feed cases follow what the Masa 7.6.1 oracle on
// ACF 2023 answers for non-content entity queries (e.g. `comment?foo=bar` is ignored, `comment?offset=1` is a 500).
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { Actor } from '../../src/domain/context.js';
import { CONTENT_ENTITIES } from '../../src/legacy/jsonapi-entities.js';
import { ITERATOR_BLANK_ROW_LIMIT, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import {
  authorizationDenied,
  beanFeedQuery,
  createJsonApiParams,
  entityAccessAllowed,
  entityActionAllowed,
  findPropertiesFor,
  isBlankFeedRow,
  isInLegacyOrder,
  jsonApiResultOf,
  mergedSource,
  permissionsOf,
  rowsSource,
  UnsupportedFeedQueryError,
  type BeanFeedOptions,
  type BeanFeedResult,
  type BeanFeedSource,
  type FeedOrderTerm,
  type JsonApiCall,
} from '../../src/routes/jsonapi/types.js';
import { scopeRows } from '../helpers/feed.js';

type Row = Record<string, unknown>;

const ENDPOINT = 'http://localhost:8080/index.cfm/_api/json/v1/tenant-a';
const COMMENT = CONTENT_ENTITIES.comment;

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: '',
    fullName: '',
    isLoggedIn: false,
    s2: false,
    roles: [],
    siteId: '',
    tenantId: '',
    ...overrides,
  };
}

const ANONYMOUS = actor();
const ADMIN = actor({ userId: 'U1', isLoggedIn: true, roles: ['site-admin'], siteId: 'tenant-a', tenantId: 'T' });
const COMMENT_MODERATOR = actor({
  userId: 'U2',
  isLoggedIn: true,
  roles: ['m:015'],
  siteId: 'tenant-a',
  tenantId: 'T',
});

/** The URL scope legacy parses from `raw`: decoded keys and values, a later key replacing an earlier one. */
function urlScope(raw: string): Record<string, unknown> {
  const url: Record<string, unknown> = {};
  for (const item of raw.split('&').filter((part) => part !== '')) {
    const [key = '', ...rest] = item.split('=');
    const decode = (s: string): string => decodeURIComponent(s.replaceAll('+', ' '));
    const name = decode(key);
    const existing = Object.keys(url).find((k) => k.toLowerCase() === name.toLowerCase());
    url[existing ?? name] = decode(rest.join('='));
  }
  return url;
}

function callFor(
  a: { method?: string; raw?: string; url?: Record<string, unknown>; params?: Record<string, unknown> } & {
    actor?: Actor;
    entityName?: string;
    isAggregateQuery?: boolean;
  } = {},
): JsonApiCall {
  const raw = a.raw ?? '';
  const url = a.url ?? urlScope(raw);
  const apiContext = {
    siteId: 'tenant-a',
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: {},
    method: a.method ?? 'findQuery',
    isAggregateQuery: a.isAggregateQuery ?? false,
    user: { loggedIn: false, systemUser: false },
    allowAction: () => false,
    customImageSizes: () => Promise.resolve([]),
  } as unknown as JsonApiRequestContext;
  const params = createJsonApiParams(Object.entries({ ...url, ...a.params }));
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:${a.entityName ?? 'comment'}.${(a.method ?? 'findQuery').toLowerCase()}`,
    method: a.method ?? 'findQuery',
    entityName: a.entityName ?? 'comment',
    pathInfo: ['tenant-a', a.entityName ?? 'comment'],
    params,
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: 'tenant-a',
    tenantId: 'T',
    actor: a.actor ?? ANONYMOUS,
    site: {} as JsonApiCall['site'],
    apiContext,
    httpMethod: 'GET',
    headers: {},
    validateCsrf: () => Promise.resolve(true),
  };
}

const ROWS: Row[] = [
  {
    commentid: 'C1',
    name: 'Alice',
    entered: new Date(2026, 0, 5),
    flagcount: 0,
    isapproved: 1,
    siteid: 'tenant-a',
    parentid: null,
  },
  {
    commentid: 'C2',
    name: 'bob',
    entered: new Date(2026, 1, 1),
    flagcount: 2,
    isapproved: 0,
    siteid: 'tenant-a',
    parentid: 'C1',
  },
  {
    commentid: 'C3',
    name: 'Carol ',
    entered: new Date(2025, 11, 31),
    flagcount: 5,
    isapproved: 1,
    siteid: 'tenant-a',
    parentid: null,
  },
];

const OPTIONS: BeanFeedOptions = {
  primaryKey: 'commentid',
  propertyNames: [
    'commentid',
    'name',
    'entered',
    'flagcount',
    'isapproved',
    'siteid',
    'parentid',
    'errors',
    'isnew',
    'lastupdateby',
    'nextn',
  ],
  defaultSort: { sortBy: 'entered', sortDirection: 'asc' },
  hints: COMMENT.hints,
  relations: [...COMMENT.hasMany, ...COMMENT.hasOne],
  table: 'tcontentcomments',
};

function page<R>(result: BeanFeedResult<R>): Extract<BeanFeedResult<R>, { items: unknown[] }> {
  if (!('items' in result)) throw new Error('expected a page');
  return result;
}

function ids(result: BeanFeedResult<Row>): unknown[] {
  return page(result).items.map((row) => row['commentid']);
}

function query(raw: string, options: Partial<BeanFeedOptions> = {}, rows: Row[] = ROWS): Promise<BeanFeedResult<Row>> {
  return beanFeedQuery(rows, callFor({ raw }), { ...OPTIONS, ...options });
}

describe('createJsonApiParams', () => {
  const params = createJsonApiParams([
    ['Method', 'findQuery'],
    ['siteid', 'tenant-a'],
    ['METHOD', 'findAll'],
    ['n', 5],
    ['flag', true],
    ['list', ['a']],
  ]);

  it('reads keys ignoring case, a later duplicate replacing the value at the first position and casing', () => {
    expect(params.get('method')).toBe('findAll');
    expect(params.has('SITEID')).toBe(true);
    expect(params.has('missing')).toBe(false);
    expect(params.entries().map(([key]) => key)).toEqual(['Method', 'siteid', 'n', 'flag', 'list']);
    expect(params.toRecord()).toEqual({ Method: 'findAll', siteid: 'tenant-a', n: 5, flag: true, list: ['a'] });
  });

  it.each([
    ['n', '5'],
    ['flag', 'true'],
    ['missing', ''],
    ['siteid', 'tenant-a'],
  ])('converts %s to a CFML string', (name, expected) => {
    expect(params.string(name)).toBe(expected);
  });

  it('refuses a complex value as CFML does', () => {
    expect(() => params.string('list')).toThrow(TypeError);
  });
});

describe('result helpers', () => {
  it.each([
    [{ errors: { title: 'required' } }, 403],
    [{ ERRORS: { title: 'required' } }, 403],
    [{ errors: {} }, 200],
    [{ errors: 'x' }, 200],
    [[{ errors: { a: 1 } }], 200],
    [null, 200],
  ])('jsonApiResultOf(%j) answers %i', (data, status) => {
    expect(jsonApiResultOf(data)).toEqual({ status, data });
  });

  it('carries the serializer entity only when given', () => {
    expect(jsonApiResultOf({ id: 'x' }, 'comment')).toEqual({
      status: 200,
      data: { id: 'x' },
      serializerEntity: 'comment',
    });
  });

  it('denies with the authorization exception', () => {
    expect(authorizationDenied()).toEqual({ error: 'authorization' });
  });
});

describe('entity access and action verdicts', () => {
  it.each([
    ['anonymous on public comment', ANONYMOUS, COMMENT, true, false],
    ['anonymous on changeset', ANONYMOUS, CONTENT_ENTITIES.changeset, false, false],
    ['comments module grant', COMMENT_MODERATOR, COMMENT, true, true],
    ['site admin on changeset', ADMIN, CONTENT_ENTITIES.changeset, true, true],
    ['s2 on stats', actor({ isLoggedIn: true, s2: true }), CONTENT_ENTITIES.stats, true, true],
  ])('%s', (_label, who, config, access, action) => {
    expect(entityAccessAllowed(who, config)).toBe(access);
    expect(entityActionAllowed(who, config)).toBe(action);
  });

  it.each([
    [
      'no site id',
      { hasSiteId: false, readAllowed: true, actionAllowed: true, saveAllowed: true },
      [false, false, false],
    ],
    [
      'anonymous comment (allowSave)',
      { hasSiteId: true, readAllowed: true, actionAllowed: false, saveAllowed: true },
      [true, false, true],
    ],
    ['anonymous changeset', { hasSiteId: true, readAllowed: false, actionAllowed: false }, [false, false, false]],
    ['module grant', { hasSiteId: true, readAllowed: true, actionAllowed: true }, [true, true, true]],
    [
      'bean allowDelete',
      { hasSiteId: true, readAllowed: true, actionAllowed: false, deleteAllowed: true },
      [true, true, false],
    ],
  ])('permissionsOf: %s', (_label, input, [read, del, save]) => {
    expect(permissionsOf(input)).toEqual({ read, delete: del, save });
  });
});

describe('findPropertiesFor', () => {
  const KEYS = ['displayname', 'properties', 'historical', 'links', 'dynamic', 'primarykey', 'public', 'bundleable', 'orderby', 'entityname', 'scaffold'];

  it.each<[string, Actor, string | undefined]>([
    ['anonymous users, without table', ANONYMOUS, undefined],
    ['admins, with the bean table', ADMIN, 'tcontentcomments'],
  ])('answers the entity metadata in legacy key order to %s', (_label, who, table) => {
    const result = findPropertiesFor(COMMENT, callFor({ method: 'findProperties', actor: who }));
    expect(Object.keys(result)).toEqual(table === undefined ? KEYS : [...KEYS.slice(0, 5), 'table', ...KEYS.slice(5)]);
    expect(result['table']).toBe(table);
    expect(isInLegacyOrder(result)).toBe(true);
    expect(result).toMatchObject({
      displayname: 'comment',
      primarykey: 'commentid',
      public: true,
      bundleable: false,
      orderby: 'entered asc',
      entityname: 'comment',
      links: {
        swagger_json: `${ENDPOINT}/swagger?mode=json&entities=comment`,
        endpoint: `${ENDPOINT}/comment`,
        swagger_rest: `${ENDPOINT}/swagger?mode=rest&entities=comment`,
        self: `${ENDPOINT}/comment/properties`,
        entities: ENDPOINT,
      },
    });
  });

  it('answers each property in legacy key order, as a copy of the recorded format', () => {
    const properties = findPropertiesFor(COMMENT, callFor({ method: 'findProperties' }))['properties'] as Row[];
    const kids = properties.find((p) => p['name'] === 'kids') as Row;
    expect(Object.entries(kids)).toEqual([
      ['fieldtype', 'one-to-many'],
      ['loadkey', 'parentid'],
      ['length', '50'],
      ['required', false],
      ['cascade', 'delete'],
      ['nullable', true],
      ['html', 'false'],
      ['fkcolumn', 'primaryKey'],
      ['name', 'kids'],
      ['datatype', 'varchar'],
      ['relatesto', 'comment'],
      ['orderby', 'created asc'],
      ['default', 'null'],
    ]);
    expect(isInLegacyOrder(kids)).toBe(true);
    expect(Object.isFrozen(kids)).toBe(false);
  });

  it('lists requested properties in request order, filtered by the registered fields', () => {
    const call = callFor({ method: 'findProperties', params: { properties: 'Entered,name,kids,foo,flagcount' } });
    const names = (findPropertiesFor(COMMENT, call)['properties'] as Row[]).map((p) => p['name']);
    expect(names).toEqual(['entered', 'name', 'kids', 'flagcount']);
  });

  // The oracle answers each of these with a 500 server_error.
  it.each<[keyof typeof CONTENT_ENTITIES, string]>([
    ['file', 'nonexistentprop'],
    ['file', 'contentid'],
    ['file', 'fileMetaData'],
    ['stats', 'contentid'],
    ['content', 'links'],
    ['comment', 'links'],
    ['feed', 'pageindex,nonexist'],
    ['category', 'nonexistentprop'],
    ['contentCategoryAssign', 'nonexistentprop'],
  ])('%s properties=%s, which the bean does not declare, raises server_error', (entity, properties) => {
    const call = callFor({ method: 'findProperties', entityName: entity, params: { properties } });
    expect(() => findPropertiesFor(CONTENT_ENTITIES[entity], call)).toThrow(
      expect.objectContaining({ type: 'server_error' }) as LegacyApiError,
    );
  });

  // Non-persistent declared properties and names outside the entity's fields are skipped, as the oracle answers.
  it.each<[keyof typeof CONTENT_ENTITIES, string, string[]]>([
    ['content', 'foo', []],
    ['content', 'body', []],
    ['content', 'active,nonexistentprop', ['active']],
    ['content', 'title,siteid', ['title', 'siteid']],
    ['content', 'Title,title,isnew', ['title', 'title']],
    ['file', 'fileField,isnew,saveErrors,errors,fromMuraCache,instanceID', []],
    ['file', 'filename,site', ['filename', 'site']],
    ['fileMetaData', 'filesize,created,remotepubdate', ['remotepubdate']],
    ['feed', 'pageindex', ['pageindex']],
    ['contentCategoryAssign', 'parent,categoryname', ['parent']],
  ])('%s properties=%s lists %j', (entity, properties, expected) => {
    const call = callFor({ method: 'findProperties', entityName: entity, params: { properties } });
    const names = (findPropertiesFor(CONTENT_ENTITIES[entity], call)['properties'] as Row[]).map((p) => p['name']);
    expect(names).toEqual(expected);
  });
});

describe('beanFeedQuery', () => {
  it('serves findAll in the feed default order with the default page', async () => {
    const call = callFor({ method: 'findAll' });
    const result = page(await beanFeedQuery(ROWS, call, OPTIONS));
    expect(result.items.map((r) => r['commentid'])).toEqual(['C3', 'C1', 'C2']);
    expect(result.baseUrl).toBeUndefined();
    expect(result.page).toEqual({
      recordCount: 3,
      pageCount: 1,
      pageIndex: 1,
      firstOnPage: 1,
      lastOnPage: 3,
      nextN: 1000,
      entityName: 'comment',
    });
    expect(call.apiContext.url['entityname']).toBe('comment');
  });

  it('never filters in findAll', async () => {
    expect(ids(await beanFeedQuery(ROWS, callFor({ method: 'findAll', raw: 'name=bob' }), OPTIONS))).toEqual([
      'C3',
      'C1',
      'C2',
    ]);
  });

  it.each([
    ['name=bob', ['C2']],
    ['NAME=BOB%20%20', ['C2']],
    ['name=*o*', ['C3', 'C2']],
    ['name=ends%5El', ['C3']],
    ['name=begins%5E%5Bab%5D', ['C1', 'C2']],
    // The `^` of a negated class splits the criteria list, leaving condition `begins` and criteria `[`.
    ['name=begins%5E%5B%5Ec%5D', []],
    ['name=like%5Eb_b', ['C2']],
    ['name=contains%5E.', []],
    ['flagcount=gt%5E1', ['C3', 'C2']],
    ['flagcount=gte%5E2', ['C3', 'C2']],
    ['flagcount=lt%5E2', ['C1']],
    ['flagcount=lte%5E2', ['C1', 'C2']],
    ['flagcount=neq%5E2', ['C3', 'C1']],
    ['flagcount=like%5E5', ['C3']],
    ['flagcount=in%5E2', ['C2']],
    ['name=in%5Ebob%2Calice', ['C1', 'C2']],
    ['name=notin%5Ebob', ['C3', 'C1']],
    ['name=in%5E', []],
    ['parentid=null', ['C3', 'C1']],
    ['parentid=neq%5Enull', ['C2']],
    ['parentid=gt%5Enull', []],
    ['parentid=C1', ['C2']],
    ['parentid=neq%5EC1', []],
    ['id=C1', ['C1']],
    ['entered=gte%5E2026-01-01', ['C1', 'C2']],
    ['entered=1%2F5%2F2026', ['C1']],
    ["entered=%7Bts%20'2026-01-05%2000%3A00%3A00'%7D", ['C1']],
    ['entered=gt%5E1%2F5%2F2026%2011%3A00%20PM', ['C2']],
    ['entered=lt%5E1%2F1%2F2026%2012%3A00%20AM', ['C3']],
    ['isapproved=1&or&name=bob&flagcount=0', ['C3', 'C1']],
    ['openGrouping&name=bob&or&flagcount=5&closeGrouping&isapproved=1', ['C3']],
    ['isapproved=0&orOpenGrouping&name=alice&closeGrouping', ['C1', 'C2']],
    ['andOpenGrouping&flagcount=0&closeGrouping', ['C1']],
    ['openGrouping%5B1%5D&name=bob', ['C2']],
    ['foo=bar', ['C3', 'C1', 'C2']],
    ['errors=1&lastupdateby=x&changesetid=x&countOnly=no', ['C3', 'C1', 'C2']],
    ['innerJoin=nothing&leftJoin=nothing', ['C3', 'C1', 'C2']],
    ['sum=&name=bob', ['C2']],
    ['siteid=tenant-a', ['C3', 'C1', 'C2']],
    ['siteid=umbrella', []],
  ])('findQuery %s', async (raw, expected) => {
    expect(ids(await query(raw))).toEqual(expected);
  });

  const LIKE_ROWS: Row[] = [
    { commentid: 'L1', name: 'abc' },
    { commentid: 'L2', name: 'ABD' },
    { commentid: 'L3', name: 'a.c' },
    { commentid: 'L4', name: 'a]c' },
    { commentid: 'L5', name: '[ab' },
    { commentid: 'L6', name: '(a+b)' },
    { commentid: 'L7', name: 'xbx  ' },
    { commentid: 'L8', name: '' },
    { commentid: 'L9', name: 'a%_c' },
    { commentid: 'L10', name: null },
  ];

  // begins, ends and like/contains wrap the criteria as `x%`, `%x` and `%x%`.
  it.each([
    ['_ as one character', 'begins%5E_b', ['L1', 'L2', 'L7']],
    ['a class', 'begins%5Ea%5Bbx%5D', ['L1', 'L2']],
    ['a range, ignoring case', 'ends%5Eb%5Bc-d%5D', ['L1', 'L2']],
    ['a class closed by its first ], so [] matches nothing', 'begins%5Ea%5B%5D.%5Dc', []],
    ['an unclosed [ as a class to the end of the pattern', 'begins%5E%5Bab', []],
    ['. as a literal', 'begins%5Ea.c', ['L3']],
    ['( and + as literals', 'contains%5E(a%2Bb)', ['L6']],
    ['literals ignoring case', 'begins%5EABC', ['L1']],
    ['% at the start', 'ends%5Ec', ['L1', 'L3', 'L4', 'L9']],
    ['% at the end', 'begins%5Ea', ['L1', 'L2', 'L3', 'L4', 'L9']],
    ['% in the middle', 'begins%5Ea%25b', ['L1', 'L2']],
    ['%% as one %', 'begins%5Ea%25%25b', ['L1', 'L2']],
    ['% alone', 'like%5E%25', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9']],
    ['runs in order', 'contains%5Ea%25b', ['L1', 'L2', 'L5', 'L6']],
    ['runs that cannot share characters', 'begins%5Eab%25b', []],
    ['_ inside a class as a literal', 'ends%5E%5B_%5Dc', ['L9']],
    ['% inside a class as a literal', 'contains%5E%5B%25%5D', ['L9']],
    ['trailing spaces of the value ignored', 'ends%5Ebx', ['L7']],
    ['trailing spaces of the value not matched by _', 'ends%5Ex_', []],
    ['trailing spaces of the pattern kept', 'ends%5Ebx%20', []],
    ['nothing for a class of a reversed range', 'contains%5E%5Bz-a%5D', []],
    ['the other items of a class with a reversed range', 'contains%5E%5Bz-ab%5D', ['L1', 'L2', 'L5', 'L6', 'L7']],
    ['a range beside a reversed one', 'ends%5E%5Bz-ab-c%5D', ['L1', 'L3', 'L4', 'L5', 'L9']],
  ])('findQuery LIKE matches %s (name=%s)', async (_label, criteria, expected) => {
    expect(ids(await query(`name=${criteria}`, { defaultSort: undefined }, LIKE_ROWS))).toEqual(expected);
  });

  const CLASS_ROWS: Row[] = 'b B z Z _ [ ^ m á Á ç d - e % 5 ax% xb a'
    .split(' ')
    .map((name, i) => ({ commentid: `K${i + 1}`, name }));
  const LETTERS = ['K1', 'K2', 'K3', 'K4', 'K8', 'K9', 'K10', 'K11', 'K12', 'K14', 'K17', 'K18', 'K19'];

  // SQL Server 2022 (SQL_Latin1_General_CP1_CI_AS, nvarchar) answers for the same names and patterns.
  it.each([
    ['[a-Z] across case', 'begins%5E%5Ba-Z%5D', LETTERS],
    ['[A-z] without _, [ and ^', 'begins%5E%5BA-z%5D', LETTERS],
    ['accented letters in [a-c], but not ç', 'begins%5E%5Ba-c%5D', ['K1', 'K2', 'K9', 'K10', 'K17', 'K19']],
    ['nothing for []', 'contains%5E%5B%5D', []],
    ['an unclosed class to the end, its % a member', 'begins%5E%5Bab', ['K1', 'K2', 'K15', 'K19']],
    ['a - after a range dropped', 'begins%5E%5Ba-c-e%5D', ['K1', 'K2', 'K9', 'K10', 'K14', 'K17', 'K19']],
    ['a trailing - as a member', 'begins%5E%5Bd-%5D', ['K12', 'K13']],
    ['nothing for a reversed mixed-case range beside a member', 'begins%5E%5BZ-a5%5D', ['K16']],
    ['a digit-to-letter range', 'begins%5E%5B9-A%5D', ['K17', 'K19']],
    ['a negated unclosed class a trailing ^ leaves', 'x*%5B%5E', ['K18']],
    ['an unsupported class no value reaches', 'begins%5Ezz%5B!-%2F%5D', []],
  ])('findQuery LIKE class matches %s (name=%s)', async (_label, criteria, expected) => {
    expect(ids(await query(`name=${criteria}`, { defaultSort: undefined }, CLASS_ROWS))).toEqual(expected);
  });

  it.each([
    ['a range with a symbol end', 'contains%5E%5B!-%2F%5D'],
    ['a range with a \\ end', 'contains%5E%5Ba-%5C%5D'],
    ['a class with --', 'begins%5E%5Bx--z%5D'],
  ])('findQuery LIKE does not compute %s (name=%s) in memory', async (_label, criteria) => {
    await expect(query(`name=${criteria}`, { defaultSort: undefined }, CLASS_ROWS)).rejects.toThrow(UnsupportedFeedQueryError);
  });

  it('decides a character outside the reproduced collation order by class members only', async () => {
    const rows: Row[] = [
      { commentid: 'U1', name: 'þ' },
      { commentid: 'U2', name: 'b' },
    ];
    expect(ids(await query('name=begins%5E%5B%C3%BEa-z%5D', { defaultSort: undefined }, rows))).toEqual(['U1', 'U2']);
    await expect(query('name=begins%5E%5Ba-z%5D', { defaultSort: undefined }, rows)).rejects.toThrow(UnsupportedFeedQueryError);
  });

  it('matches a LIKE pattern in bounded time on text that makes a backtracking regex explode', async () => {
    const rows: Row[] = [
      { commentid: 'R1', name: 'a'.repeat(60) },
      { commentid: 'R2', name: `${'a'.repeat(60)}c` },
    ];
    const started = performance.now();
    const result = ids(await query(`name=like%5E${'%25a'.repeat(8)}%25b`, { defaultSort: undefined }, rows));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toEqual([]);
  });

  it.each([
    ['addObjects=1', 'invalidParameters'],
    ['name=like%5E%5B!-%2F%5D&addObjects=1', 'invalidParameters'],
    ['name=zz%5Ex', 'server_error'],
    ['name=foo%5Ebar%5Ebaz', 'server_error'],
    ['flagcount=*1', 'server_error'],
    ['flagcount=in%5E1%2C2', 'server_error'],
    ['entered=x', 'server_error'],
    ['entered=2026-02-30', 'server_error'],
    ['isnew=1', 'server_error'],
    ['name=in%5Enull', 'server_error'],
    ['openGrouping&name=bob', 'server_error'],
    ['closeGrouping', 'server_error'],
    ['name=bob&closeGrouping', 'server_error'],
    ['entered=1%2F5%2F2026%2013%3A00%20PM', 'server_error'],
    ['offset=1', 'server_error'],
    ['sort=name%3Bdrop', 'server_error'],
    ['sort=other.name', 'server_error'],
    ['sort=tcontentcomments.nope', 'server_error'],
    ['sort=%2B', 'server_error'],
    ['sort=.name', 'server_error'],
    ['sortBy=bad%20field', 'server_error'],
    ['sortBy=name.part', 'server_error'],
    ['sort=tusers.password', 'authorization'],
    ['sortBy=tusers.password', 'authorization'],
    ['innerJoin=site', 'authorization'],
    ['leftJoin=comment', 'server_error'],
    ['maxitems=-1', 'server_error'],
    ['maxitems=2.5', 'server_error'],
    ['groupBy=name', 'server_error'],
    ['count=*', 'server_error'],
  ])('findQuery %s throws %s', async (raw, type) => {
    await expect(query(raw)).rejects.toThrow(expect.objectContaining({ type }) as LegacyApiError);
  });

  it.each([
    ['innerJoin=content', OPTIONS],
    ['groupBy=entered', OPTIONS],
    ['sum=flagcount', { ...OPTIONS, defaultSort: undefined }],
    ['countOnly=true&groupBy=name', OPTIONS],
    ['countOnly=true&innerJoin=comment', OPTIONS],
  ])('findQuery %s is not computed in memory', async (raw, options) => {
    await expect(beanFeedQuery(ROWS, callFor({ raw }), options)).rejects.toThrow(UnsupportedFeedQueryError);
  });

  it('ignores aggregates and keeps the column SELECT when the URL scope has fields', async () => {
    const call = callFor({ raw: 'count=*', url: { count: '*', fields: 'name' } });
    expect(ids(await beanFeedQuery(ROWS, call, OPTIONS))).toEqual(['C3', 'C1', 'C2']);
    expect(call.apiContext.url['fields']).toBe('name,commentid');
    const grouped = callFor({ raw: 'groupBy=name', url: { groupBy: 'name', fields: 'name' } });
    await expect(beanFeedQuery(ROWS, grouped, OPTIONS)).rejects.toThrow(LegacyApiError);
  });

  it.each([
    ['sort=-flagcount', ['C3', 'C2', 'C1']],
    ['sort=%2Bname', ['C1', 'C2', 'C3']],
    ['sort=isapproved%2C-entered', ['C2', 'C1', 'C3']],
    ['orderby=-name', ['C3', 'C2', 'C1']],
    ['sort=name&orderby=-name', ['C1', 'C2', 'C3']],
    ['sort=tcontentcomments.flagcount', ['C1', 'C2', 'C3']],
    ['sort=name%20', ['C1', 'C2', 'C3']],
    ['sort=parentid', ['C1', 'C3', 'C2']],
    ['sort=-parentid', ['C2', 'C1', 'C3']],
    ['sortBy=flagcount&sortDirection=desc', ['C3', 'C2', 'C1']],
    ['sortBy=isapproved,flagcount&sortDirection=DESC', ['C2', 'C3', 'C1']],
    ['sortDirection=desc', ['C2', 'C1', 'C3']],
    ['sortDirection=sideways', ['C3', 'C1', 'C2']],
    ['maxitems=2', ['C3', 'C1']],
    ['maxitems=2&size=1', ['C3']],
    ['size=2&limit=1', ['C3']],
    ['maxitems=*', ['C3', 'C1', 'C2']],
    ['maxitems=abc&size=abc', ['C3', 'C1', 'C2']],
  ])('orders and limits %s', async (raw, expected) => {
    expect(ids(await query(raw))).toEqual(expected);
  });

  it('writes the joined sort back into the URL scope', async () => {
    const call = callFor({ raw: 'sort=-name' });
    await beanFeedQuery(ROWS, call, OPTIONS);
    expect(call.apiContext.url['sort']).toBe('-name');
  });

  it('keeps the row order when neither the request nor the feed sorts', async () => {
    expect(ids(await query('name=*', { defaultSort: undefined }))).toEqual(['C1', 'C2', 'C3']);
  });

  it.each([
    ['itemsPerPage=2', ['C3', 'C1'], { pageCount: 2, pageIndex: 1, firstOnPage: 1, lastOnPage: 2, nextN: 2 }],
    ['itemsPerPage=2&pageIndex=2', ['C2'], { pageCount: 2, pageIndex: 2, firstOnPage: 3, lastOnPage: 3, nextN: 2 }],
    ['itemsPerPage=*', ['C3', 'C1', 'C2'], { pageCount: 1, pageIndex: 1, nextN: 3 }],
    ['itemsPerPage=abc', ['C3', 'C1', 'C2'], { nextN: 1000 }],
    ['itemsPerPage=2&pageIndex=5', ['C3', 'C1'], { pageIndex: 1 }],
    ['itemsPerPage=2&startIndex=2', ['C1'], { pageIndex: 1, firstOnPage: 1, lastOnPage: 2 }],
    ['itemsPerPage=1&startIndex=3', ['C2'], { pageIndex: 3 }],
    ['startIndex=0', [], { pageIndex: 0 }],
    ['nextn=1', ['C3'], { nextN: 1, pageCount: 3 }],
    ['itemsPerPage=-1', [], { pageCount: -3, pageIndex: 1, firstOnPage: 1, lastOnPage: -1, nextN: -1 }],
    ['itemsPerPage=-2&pageIndex=-1', [], { pageCount: -1, pageIndex: 1, firstOnPage: 1, lastOnPage: -2, nextN: -2 }],
    ['itemsPerPage=2&pageIndex=1.5', ['C1', 'C2'], { pageCount: 2, pageIndex: 1.5, firstOnPage: 2, lastOnPage: 3 }],
  ])('pages %s', async (raw, expected, pageValues) => {
    const result = page(await query(raw));
    expect(result.items.map((r) => r['commentid'])).toEqual(expected);
    expect(result.page).toMatchObject({ recordCount: 3, ...pageValues });
  });

  it.each([
    ['startIndex=4&isnew=1', 1],
    ['pageIndex=-3', -3],
    ['pageIndex=0', 0],
  ])('pages an empty feed for %s without reading a row', async (raw, pageIndex) => {
    const result = page(await beanFeedQuery([], callFor({ raw }), OPTIONS));
    expect(result.items).toEqual([]);
    expect(result.page).toMatchObject({ recordCount: 0, pageIndex });
  });

  it.each([
    ['itemsPerPage=2&pageIndex=0', 2, [], { pageIndex: 0, nextN: 2 }],
    ['itemsPerPage=1&pageIndex=-1', 1, [], { pageIndex: -1, nextN: 1 }],
    ['startIndex=-1', 2, [], { nextN: 1000 }],
    ['pageIndex=0.5&itemsPerPage=3', 2, ['C3'], { pageIndex: 0.5, nextN: 3 }],
  ] satisfies Array<[string, number, string[], Row]>)('pages the blank rows %s reads before the first record, then its rows', async (raw, blank, rows, pageValues) => {
    const result = page(await query(raw));
    const blankRow = { commentid: '', name: '', entered: '', flagcount: '', isapproved: '', siteid: '', parentid: '' };
    expect(result.items).toEqual([...Array.from({ length: blank }, () => blankRow), ...rows.map((id) => expect.objectContaining({ commentid: id }))]);
    expect(result.items.map((row) => isBlankFeedRow(row))).toEqual([...Array.from({ length: blank }, () => true), ...rows.map(() => false)]);
    expect(result.page).toMatchObject({ recordCount: 3, ...pageValues });
  });

  it('reads the records the double page index steps to, past one it rounds over', async () => {
    const ids = page(await query('itemsPerPage=3')).items.map((row) => row['commentid']);
    // (1.2 - 1) * 5 = 0.9999999999999998, whose second step rounds to 3.
    expect(page(await query('pageIndex=1.2&itemsPerPage=5')).items.map((row) => row['commentid'])).toEqual([ids[0], ids[2]]);
  });

  it('fails closed on more blank rows than the limit, whose legacy answer turns on its request timeout', async () => {
    expect(page(await query(`itemsPerPage=${ITERATOR_BLANK_ROW_LIMIT}&pageIndex=0`)).items).toHaveLength(ITERATOR_BLANK_ROW_LIMIT);
    await expect(query(`itemsPerPage=${ITERATOR_BLANK_ROW_LIMIT + 1}&pageIndex=0`)).rejects.toThrow(
      expect.objectContaining({ name: 'LegacyServiceUnavailableError', reason: 'iterator-blank-rows-timeout' }) as LegacyServiceUnavailableError,
    );
  });

  it.each([
    ['countOnly=true', 3],
    ['countOnly=1&name=bob', 1],
    ['countOnly=yes&maxitems=1', 3],
    ['countOnly=true&sort=name%3Bdrop', 3],
  ])('counts %s', async (raw, count) => {
    expect(await query(raw)).toEqual({ count });
  });

  it('pages findMany rows whatever countOnly says, as legacy findMany never counts', async () => {
    const result = page(await beanFeedQuery(ROWS, callFor({ method: 'findMany', raw: 'countOnly=true' }), OPTIONS));
    expect(result.items).toHaveLength(3);
    expect(result.baseUrl).toBeUndefined();
  });

  it('builds the findQuery base URL from the query string, skipping pageIndex and empty values', async () => {
    const result = page(await query('Name=b%20o&pageindex=2&or&sort=-name'));
    expect(result.baseUrl).toBe(`${ENDPOINT}/comment/?Name=b+o&or&sort=-name`);
  });

  it('filters by expansion params, leaves the excluded ones to the feed props and pages from the URL scope', async () => {
    const call = callFor({ method: 'findOne', raw: 'itemsPerPage=1', url: { itemsPerPage: '1' } });
    const result = page(await beanFeedQuery(ROWS, call, { ...OPTIONS, expandedParams: { isapproved: 1, maxitems: '1' } }));
    expect(result.items.map((r) => r['commentid'])).toEqual(['C3']);
    expect(result.page).toMatchObject({ recordCount: 1, nextN: 1 });
    expect(result.baseUrl).toBe(`${ENDPOINT}/comment/?isapproved=1`);
    // A key no column holds is a filter there too, which SQL Server rejects.
    await expect(beanFeedQuery(ROWS, call, { ...OPTIONS, expandedParams: { cachedWithin: '5' } })).rejects.toThrow(
      LegacyApiError,
    );
  });

  it('checks columns against the declared column list and compares string timestamps', async () => {
    const rows: Row[] = [
      { commentid: 'S1', entered: '2026-01-05 00:00:00.000' },
      { commentid: 'S2', entered: '2026-03-01 08:30:00' },
    ];
    const options = { ...OPTIONS, columns: ['commentid', 'entered'] };
    expect(ids(await query('entered=gt%5E2026-02-01&sort=-entered', options, rows))).toEqual(['S2']);
    await expect(query('name=x', options, rows)).rejects.toThrow(LegacyApiError);
  });
});

describe('the scan evaluator of sources without a SQL form', () => {
  const NAMES = ['alice', 'Alice', 'ÁLICE', 'bob', 'Bob ', 'carol', null, '', 'Йan', 'zed', 'a😀b'];

  /** `count` comment rows whose names, dates and flag counts repeat and hold NULLs; `nan` makes some flag counts NaN. */
  function rowsOf(count: number, nan = false): Row[] {
    return Array.from({ length: count }, (_, i) => ({
      commentid: `S${String(i).padStart(4, '0')}`,
      name: NAMES[i % NAMES.length] ?? null,
      entered: i % 13 === 0 ? null : new Date(2026, 0, 1 + (i % 6)),
      flagcount: nan && i % 9 === 4 ? Number.NaN : i % 7 === 0 ? null : i % 4,
      isapproved: i % 3,
      siteid: 'tenant-a',
      parentid: null,
    }));
  }

  /** Comment rows whose names share a 2000-character prefix, so their order keys pass the sort's memory budget; `paired` repeats each name. */
  function longNameRows(count: number, paired = false): Row[] {
    return Array.from({ length: count }, (_, i) => ({
      commentid: `L${String(i).padStart(4, '0')}`,
      name: `${'n'.repeat(2000)}${String(paired ? Math.floor(i / 2) : (i * 7919) % count).padStart(4, '0')}`,
      entered: new Date(2026, 0, 1 + (i % 3)),
      flagcount: i % 5,
      isapproved: 1,
      siteid: 'tenant-a',
      parentid: null,
    }));
  }

  /**
   * Hooks of {@link scanOnly}: a check after each batch, an abort at a batch of a scan, the rows each 1-based scan reads
   * (a write between scans), and what a revisit answers in place of the rows at its positions.
   */
  interface ScanHooks {
    afterBatch?: () => Promise<void>;
    abort?: { scan: number; batch: number };
    read?: (scan: number) => readonly Row[];
    answer?: (rows: Row[]) => Row[];
  }

  /** A source over `rows` answering every query by scans only, `batch` rows at a time, as a source without a SQL form does. */
  function scanOnly(rows: readonly Row[], hooks: ScanHooks = {}, batch = 7): BeanFeedSource<Row> {
    const memory = rowsSource(rows);
    let scans = 0;
    return {
      columns: memory.columns,
      isEmpty: () => memory.isEmpty(),
      filterThrows: () => Promise.resolve(undefined),
      count: () => Promise.resolve({ kind: 'rows' }),
      rows: () => Promise.reject(new Error('A scan-only source pages no rows itself')),
      orders: () => false,
      scan: async (_request, visit, revisit) => {
        scans += 1;
        const held = hooks.read?.(scans) ?? rows;
        if (visit !== undefined) {
          for (let from = 0, at = 1; from < held.length; from += batch, at += 1) {
            if (hooks.abort?.scan === scans && hooks.abort.batch === at) throw new Error('aborted');
            const more = await visit(held.slice(from, from + batch));
            await hooks.afterBatch?.();
            if (!more) break;
          }
        }
        if (revisit === undefined) return [];
        const found = (await revisit()).flatMap((position) => held.slice(position - 1, position));
        return hooks.answer?.(found) ?? found;
      },
    };
  }

  /** What beanFeedQuery answers or raises for `raw` over `rows`. */
  async function outcome(rows: readonly Row[] | BeanFeedSource<Row>, raw: string, options: BeanFeedOptions): Promise<unknown> {
    const call = callFor({ raw });
    try {
      return { value: await beanFeedQuery(rows, call, options), url: { ...call.apiContext.url } };
    } catch (err) {
      const error = err as Error & { type?: unknown };
      return { error: { name: error.constructor.name, message: error.message, type: error.type } };
    }
  }

  const VARCHAR_ENTERED: BeanFeedOptions = { ...OPTIONS, hints: Object.fromEntries(Object.entries(COMMENT.hints).filter(([name]) => name !== 'entered')) };
  const QUERIES = [
    '', 'itemsPerPage=7', 'itemsPerPage=7&pageIndex=20', 'itemsPerPage=7&pageIndex=43', 'itemsPerPage=*', 'startIndex=5&itemsPerPage=4',
    'sort=name', 'sort=-name&itemsPerPage=9&pageIndex=5', 'sort=name%2C-flagcount&itemsPerPage=5&pageIndex=9', 'sort=-flagcount%2Cname&itemsPerPage=11&pageIndex=3',
    'sort=flagcount&itemsPerPage=13&pageIndex=2', 'name=*a*', 'name=*a*&sort=-entered&itemsPerPage=3&pageIndex=4', 'maxitems=10&sort=-name',
    'countOnly=true', 'countOnly=true&name=*b*', 'name=begins%5E%5Ba-c%5D', 'name=begins%5E%5Ba-c%5D&sort=nope', 'countOnly=true&name=begins%5E%5Ba-c%5D',
    'entered=x', 'entered=x&name=begins%5E%5Ba-c%5D', 'sort=entered', 'name=bob&sort=entered', 'name=zed&sort=entered%2Cname', 'sort=nope',
  ];
  const HINTED: readonly (readonly [string, BeanFeedOptions])[] = [
    ['date entered', OPTIONS],
    ['varchar entered', VARCHAR_ENTERED],
  ];
  const CASES = [false, true].flatMap((nan) =>
    HINTED.flatMap(([hinted, options]) =>
      QUERIES.map((raw): [string, string, string, BeanFeedOptions, boolean] => [nan ? 'NaN counts' : 'finite counts', hinted, raw, options, nan]),
    ),
  );

  it.each(CASES)('answers rows with %s and a %s as the in-memory evaluator does: %s', async (_counts, _hinted, raw, options, nan) => {
    const rows = rowsOf(300, nan);
    expect(await outcome(scanOnly(rows), raw, options)).toEqual(await outcome(rows, raw, options));
  });

  it.each([
    'sort=name&itemsPerPage=9&pageIndex=7', 'name=*a*&itemsPerPage=4&pageIndex=3', 'countOnly=true&name=*o*',
    'sort=-flagcount%2Cname&itemsPerPage=50&pageIndex=2', 'name=begins%5E%5Ba-c%5D', 'sort=flagcount',
  ])('merges scan-only sources as their concatenated rows answer: %s', async (raw) => {
    const rows = rowsOf(300, true);
    const merged = mergedSource([scanOnly(rows.slice(0, 120)), scanOnly(rows.slice(120))]);
    expect(await outcome(merged, raw, OPTIONS)).toEqual(await outcome(rows, raw, OPTIONS));
  });

  /** rowsOf(300, true) with one `entered` value per 120/180-row part, so each part sorts alone but the parts' values compare. */
  function oneEnteredEach(): Row[] {
    return rowsOf(300, true).map((row, at) => (at === 17 || at === 211 ? row : { ...row, entered: null }));
  }

  it.each<[string, Row[], FeedOrderTerm, BeanFeedOptions, string]>([
    ['complex values in both sources', oneEnteredEach(), { column: 'entered', field: 'entered', desc: true, type: 'varchar' }, VARCHAR_ENTERED, 'sort=-entered%2Cname&itemsPerPage=4&pageIndex=3'],
    ['complex values in both sources', oneEnteredEach(), { column: 'entered', field: 'entered', desc: false, type: 'varchar' }, VARCHAR_ENTERED, 'sort=entered&itemsPerPage=5&pageIndex=2'],
    ['NaN counts', rowsOf(300, true), { column: 'flagcount', field: 'flagcount', desc: false, type: 'numeric' }, OPTIONS, 'sort=flagcount&itemsPerPage=6&pageIndex=4'],
    ['NaN counts', rowsOf(300, true), { column: 'flagcount', field: 'flagcount', desc: true, type: 'numeric' }, OPTIONS, 'sort=-flagcount%2Cname&itemsPerPage=50&pageIndex=2'],
  ])('merges in-memory sources one sort must order, for %s, as their concatenated rows answer: %s', async (_label, rows, term, options, raw) => {
    const parts = [rowsSource(rows.slice(0, 120)), rowsSource(rows.slice(120))];
    // Each part sorts its own rows, but rows across the parts need the scan evaluator's one sort.
    expect(await mergedSource(parts).count({ order: [term] })).toEqual({ kind: 'rows' });
    expect(await outcome(mergedSource(parts), raw, options)).toEqual(await outcome(rows, raw, options));
  });

  describe('a merged page over a source written between its reads', () => {
    const rows = rowsOf(300);
    const first = rows.slice(0, 120);
    const second = rows.slice(120);
    const RAW = 'name=*a*&sort=name&itemsPerPage=6&pageIndex=2';

    /** The page items beanFeedQuery answers for RAW over `source`. */
    async function items(source: readonly Row[] | BeanFeedSource<Row>): Promise<Row[]> {
      return page(await beanFeedQuery(source, callFor({ raw: RAW }), OPTIONS)).items;
    }

    /** The two parts merged, the second reading what `read` hands each of its scans, which `reads` records. */
    function merged(read: (scan: number) => readonly Row[], reads: number[], answer?: (rows: Row[]) => Row[]): BeanFeedSource<Row> {
      const hooks: ScanHooks = {
        read: (scan) => {
          reads.push(scan);
          return read(scan);
        },
        ...(answer === undefined ? {} : { answer }),
      };
      return mergedSource([scanOnly(first), scanOnly(second, hooks)]);
    }

    it('ranks a page with rows of both parts once while neither changes', async () => {
      const answered = await items(rows);
      expect([answered.some((row) => first.includes(row)), answered.some((row) => second.includes(row))]).toEqual([true, true]);
      const reads: number[] = [];
      expect(await outcome(merged(() => second, reads), RAW, OPTIONS)).toEqual(await outcome(rows, RAW, OPTIONS));
      // The count, the page's ranking, then its revisit.
      expect(reads).toEqual([1, 2, 3]);
    });

    it.each<[string, (page: readonly Row[]) => Row[]]>([
      ['a row the filter skips, inserted ahead of the page', () => [{ ...second[0], commentid: 'X0001', name: 'zed' }, ...second]],
      ['a row tied with the page rows, inserted ahead of them', (shown) => [{ ...shown.at(-1), commentid: 'X0002' }, ...second]],
      ['a row deleted ahead of the page', () => second.slice(1)],
      ['a page row updated', (shown) => second.map((row) => (row === shown.at(-1) ? { ...row, parentid: 'C1' } : row))],
    ])('ranks the page afresh after %s between the ranking and the revisit', async (_label, change) => {
      const shown = await items(rows);
      expect(second).toContain(shown.at(-1));
      const after = change(shown);
      const reads: number[] = [];
      const answered = await items(merged((scan) => (scan < 3 ? second : after), reads));
      expect(answered).toEqual(await items([...first, ...after]));
      // The revisit answers rows the ranking did not rank there, so a second ranking and its revisit follow.
      expect(reads).toEqual([1, 2, 3, 4, 5]);
    });

    it('fails the page closed when the part changes between every ranking and its revisit', async () => {
      const after = second.map((row) => ({ ...row, parentid: 'C1' }));
      const reads: number[] = [];
      await expect(items(merged((scan) => (scan % 2 === 0 ? second : after), reads))).rejects.toMatchObject({
        constructor: LegacyApiError,
        type: 'server_error',
      });
      expect(reads).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it.each<[string, (rows: Row[]) => Row[]]>([
      ['one row short', (found) => found.slice(1)],
      ['one row over', (found) => [...found, ...found.slice(0, 1)]],
    ])('fails a page closed whose revisit answers %s of its positions', async (_label, answer) => {
      const single: number[] = [];
      const read = (scan: number): readonly Row[] => {
        single.push(scan);
        return rows;
      };
      const source = scanOnly(rows, { answer, read });
      await expect(items(source)).rejects.toMatchObject({ constructor: LegacyApiError, type: 'server_error' });
      // A source whose revisit reads the ranking's own snapshot is ranked once.
      expect(single).toEqual([1, 2]);
      const reads: number[] = [];
      await expect(items(merged(() => second, reads, answer))).rejects.toMatchObject({ constructor: LegacyApiError, type: 'server_error' });
      expect(reads).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  describe('order keys past the memory budget', () => {
    let root: string;
    let previous: string | undefined;

    beforeEach(async () => {
      previous = process.env['TMPDIR'];
      root = await mkdtemp(path.join(tmpdir(), 'scan-evaluator-test-'));
      process.env['TMPDIR'] = root;
    });

    afterEach(async () => {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
      await rm(root, { recursive: true, force: true });
    });

    const SPILLING: [string, Row[], BeanFeedOptions, string][] = [
      ['a middle page', longNameRows(2000), OPTIONS, 'sort=name&itemsPerPage=3&pageIndex=300'],
      ['every row, descending', longNameRows(2000), OPTIONS, 'sort=-name%2Cflagcount&itemsPerPage=*'],
      ['the complex values a pair of tied names compares', longNameRows(2000, true), VARCHAR_ENTERED, 'sort=name%2Centered&itemsPerPage=1'],
    ];

    // Merged sources spill their rows' digests with the keys.
    it.each(
      ['one source', 'merged sources'].flatMap((kind) =>
        SPILLING.map(([label, rows, options, raw]): [string, string, Row[], BeanFeedOptions, string] => [label, kind, rows, options, raw]),
      ),
    )('answers %s over %s from spilled keys and removes them', async (_label, kind, rows, options, raw) => {
      let spilled = false;
      const hooks: ScanHooks = {
        afterBatch: async () => {
          spilled ||= (await readdir(root)).length > 0;
        },
      };
      const source = kind === 'one source' ? scanOnly(rows, hooks) : mergedSource([scanOnly(rows.slice(0, 900), hooks), scanOnly(rows.slice(900), hooks)]);
      expect(await outcome(source, raw, options)).toEqual(await outcome(rows, raw, options));
      expect(spilled).toBe(true);
      expect(await readdir(root)).toEqual([]);
    });

    it.each([
      ['the count scan', 1],
      ['the page scan', 2],
    ])('removes the spilled keys when %s is aborted', async (_label, scan) => {
      const source = scanOnly(longNameRows(2000), { abort: { scan, batch: 250 } });
      await expect(beanFeedQuery(source, callFor({ raw: 'sort=name&itemsPerPage=2&pageIndex=40' }), OPTIONS)).rejects.toThrow('aborted');
      expect(await readdir(root)).toEqual([]);
    });
  });
});

describe('mergedSource', () => {
  it('scans all rows of sources too large to spread into one call, in source order', async () => {
    const size = 150_000;
    const first: Row[] = Array.from({ length: size }, (_, i) => ({ id: i }));
    const second: Row[] = Array.from({ length: size }, (_, i) => ({ id: size + i }));
    const rows = await scopeRows(mergedSource([rowsSource(first), rowsSource(second)]));
    expect(rows).toHaveLength(2 * size);
    expect([0, size - 1, size, 2 * size - 1].map((at) => rows[at]?.['id'])).toEqual([0, size - 1, size, 2 * size - 1]);
    expect(rows.every((row, at) => row['id'] === at)).toBe(true);
  });
});
