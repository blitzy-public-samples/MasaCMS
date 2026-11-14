// Shared JSON API handler helpers of src/routes/jsonapi/types.ts. Feed cases follow what the Masa 7.6.1 oracle on
// ACF 2023 answers for non-content entity queries (e.g. `comment?foo=bar` is ignored, `comment?offset=1` is a 500).
import { describe, expect, it } from 'vitest';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { Actor } from '../../src/domain/context.js';
import { CONTENT_ENTITIES } from '../../src/legacy/jsonapi-entities.js';
import type { JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import {
  authorizationDenied,
  beanFeedQuery,
  createJsonApiParams,
  entityAccessAllowed,
  entityActionAllowed,
  findPropertiesFor,
  jsonApiResultOf,
  permissionsOf,
  UnsupportedFeedQueryError,
  type BeanFeedOptions,
  type BeanFeedResult,
  type JsonApiCall,
} from '../../src/routes/jsonapi/types.js';

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
    customImageSizes: [],
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

function page<R>(result: BeanFeedResult<R>): Extract<BeanFeedResult<R>, { items: R[] }> {
  if (!('items' in result)) throw new Error('expected a page');
  return result;
}

function ids(result: BeanFeedResult<Row>): unknown[] {
  return page(result).items.map((row) => row['commentid']);
}

function query(raw: string, options: Partial<BeanFeedOptions> = {}, rows: Row[] = ROWS): BeanFeedResult<Row> {
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
  it('answers the registration metadata in legacy key order, without table for anonymous users', () => {
    const result = findPropertiesFor(COMMENT, callFor({ method: 'findProperties' }));
    expect(Object.keys(result)).toEqual([
      'displayname',
      'properties',
      'historical',
      'links',
      'dynamic',
      'primarykey',
      'public',
      'bundleable',
      'orderby',
      'entityname',
      'scaffold',
    ]);
    expect(result).toMatchObject({
      displayname: 'comment',
      primarykey: 'commentid',
      public: true,
      entityname: 'comment',
      links: {
        swagger_json: `${ENDPOINT}/swagger?mode=json&entities=comment`,
        endpoint: `${ENDPOINT}/comment`,
        swagger_rest: `${ENDPOINT}/swagger?mode=rest&entities=comment`,
        self: `${ENDPOINT}/comment/properties`,
        entities: ENDPOINT,
      },
    });
    const properties = result['properties'] as Row[];
    const names = properties.map((p) => p['name']);
    expect(names).toContain('kids');
    expect(names).toContain('entered');
    expect(names).not.toContain('isnew');
    expect(names).not.toContain('commentid');
    expect(properties.find((p) => p['name'] === 'kids')).toEqual({
      fieldtype: 'one-to-many',
      loadkey: 'parentid',
      fkcolumn: 'primaryKey',
      name: 'kids',
      datatype: 'varchar',
      relatesto: 'comment',
    });
    expect(properties.find((p) => p['name'] === 'entered')).toEqual({
      fieldtype: '',
      name: 'entered',
      datatype: 'datetime',
    });
  });

  it('lists requested properties in request order, filtered by the registered fields', () => {
    const call = callFor({ method: 'findProperties', params: { properties: 'Entered,name,kids,foo,flagcount' } });
    const names = (findPropertiesFor(COMMENT, call)['properties'] as Row[]).map((p) => p['name']);
    expect(names).toEqual(['entered', 'kids', 'flagcount']);
  });

  it('lists the primary key and many-to-one relations of an entity without a field list, and table for admins', () => {
    const result = findPropertiesFor(CONTENT_ENTITIES.category, callFor({ method: 'findProperties', actor: ADMIN }));
    expect(result).toHaveProperty('table');
    const properties = result['properties'] as Row[];
    expect(properties[0]).toEqual({ fieldtype: 'id', name: 'categoryid' });
    expect(properties.find((p) => p['name'] === 'parent')).toEqual({
      fieldtype: 'many-to-one',
      loadkey: 'categoryid',
      fkcolumn: 'parentid',
      name: 'parent',
      relatesto: 'category',
    });
    expect(properties.find((p) => p['name'] === 'isactive')).toEqual({
      fieldtype: '',
      name: 'isactive',
      datatype: 'int',
    });
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

  // Non-persistent and undescribed declared properties are skipped; the oracle also lists `filename` and `title`.
  it.each<[keyof typeof CONTENT_ENTITIES, string, string[]]>([
    ['content', 'foo', []],
    ['content', 'active,nonexistentprop', ['active']],
    ['file', 'fileField,isnew,saveErrors,errors,fromMuraCache,instanceID', []],
    ['file', 'filename', []],
    ['file', 'site', ['site']],
    ['fileMetaData', 'filesize,created,remotepubdate', ['remotepubdate']],
    ['feed', 'pageindex', ['pageindex']],
  ])('%s properties=%s lists %j', (entity, properties, expected) => {
    const call = callFor({ method: 'findProperties', entityName: entity, params: { properties } });
    const names = (findPropertiesFor(CONTENT_ENTITIES[entity], call)['properties'] as Row[]).map((p) => p['name']);
    expect(names).toEqual(expected);
  });

  // Each name is in the oracle's default listing, which has no file `filemetadata`, stats `contentid` or
  // fileMetaData `filesize` and `created`.
  it.each<[keyof typeof CONTENT_ENTITIES, string[]]>([
    ['file', ['fileid', 'filesize', 'created', 'deleted', 'remotepubdate', 'content', 'site']],
    ['fileMetaData', ['metaid', 'remotepubdate', 'file', 'activecontent', 'content', 'site']],
    [
      'stats',
      [
        'views',
        'rating',
        'totalvotes',
        'upvotes',
        'downvotes',
        'comments',
        'disablecomments',
        'majorversion',
        'minorversion',
        'content',
        'site',
      ],
    ],
  ])('the %s default listing names only declared persistent or related properties', (entity, expected) => {
    const call = callFor({ method: 'findProperties', entityName: entity });
    const names = (findPropertiesFor(CONTENT_ENTITIES[entity], call)['properties'] as Row[]).map((p) => p['name']);
    expect(names).toEqual(expected);
  });
});

describe('beanFeedQuery', () => {
  it('serves findAll in the feed default order with the default page', () => {
    const call = callFor({ method: 'findAll' });
    const result = page(beanFeedQuery(ROWS, call, OPTIONS));
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

  it('never filters in findAll', () => {
    expect(ids(beanFeedQuery(ROWS, callFor({ method: 'findAll', raw: 'name=bob' }), OPTIONS))).toEqual([
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
  ])('findQuery %s', (raw, expected) => {
    expect(ids(query(raw))).toEqual(expected);
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
  ])('findQuery LIKE matches %s (name=%s)', (_label, criteria, expected) => {
    expect(ids(query(`name=${criteria}`, { defaultSort: undefined }, LIKE_ROWS))).toEqual(expected);
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
  ])('findQuery LIKE class matches %s (name=%s)', (_label, criteria, expected) => {
    expect(ids(query(`name=${criteria}`, { defaultSort: undefined }, CLASS_ROWS))).toEqual(expected);
  });

  it.each([
    ['a range with a symbol end', 'contains%5E%5B!-%2F%5D'],
    ['a range with a \\ end', 'contains%5E%5Ba-%5C%5D'],
    ['a class with --', 'begins%5E%5Bx--z%5D'],
  ])('findQuery LIKE does not compute %s (name=%s) in memory', (_label, criteria) => {
    expect(() => query(`name=${criteria}`, { defaultSort: undefined }, CLASS_ROWS)).toThrow(UnsupportedFeedQueryError);
  });

  it('decides a character outside the reproduced collation order by class members only', () => {
    const rows: Row[] = [
      { commentid: 'U1', name: 'þ' },
      { commentid: 'U2', name: 'b' },
    ];
    expect(ids(query('name=begins%5E%5B%C3%BEa-z%5D', { defaultSort: undefined }, rows))).toEqual(['U1', 'U2']);
    expect(() => query('name=begins%5E%5Ba-z%5D', { defaultSort: undefined }, rows)).toThrow(UnsupportedFeedQueryError);
  });

  it('matches a LIKE pattern in bounded time on text that makes a backtracking regex explode', () => {
    const rows: Row[] = [
      { commentid: 'R1', name: 'a'.repeat(60) },
      { commentid: 'R2', name: `${'a'.repeat(60)}c` },
    ];
    const started = performance.now();
    const result = ids(query(`name=like%5E${'%25a'.repeat(8)}%25b`, { defaultSort: undefined }, rows));
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
    ['pageIndex=0', 'server_error'],
    ['groupBy=name', 'server_error'],
    ['count=*', 'server_error'],
  ])('findQuery %s throws %s', (raw, type) => {
    expect(() => query(raw)).toThrow(expect.objectContaining({ type }) as LegacyApiError);
  });

  it.each([
    ['innerJoin=content', OPTIONS],
    ['groupBy=entered', OPTIONS],
    ['sum=flagcount', { ...OPTIONS, defaultSort: undefined }],
    ['countOnly=true&groupBy=name', OPTIONS],
    ['countOnly=true&innerJoin=comment', OPTIONS],
  ])('findQuery %s is not computed in memory', (raw, options) => {
    expect(() => beanFeedQuery(ROWS, callFor({ raw }), options)).toThrow(UnsupportedFeedQueryError);
  });

  it('ignores aggregates and keeps the column SELECT when the URL scope has fields', () => {
    const call = callFor({ raw: 'count=*', url: { count: '*', fields: 'name' } });
    expect(ids(beanFeedQuery(ROWS, call, OPTIONS))).toEqual(['C3', 'C1', 'C2']);
    expect(call.apiContext.url['fields']).toBe('name,commentid');
    const grouped = callFor({ raw: 'groupBy=name', url: { groupBy: 'name', fields: 'name' } });
    expect(() => beanFeedQuery(ROWS, grouped, OPTIONS)).toThrow(LegacyApiError);
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
  ])('orders and limits %s', (raw, expected) => {
    expect(ids(query(raw))).toEqual(expected);
  });

  it('writes the joined sort back into the URL scope', () => {
    const call = callFor({ raw: 'sort=-name' });
    beanFeedQuery(ROWS, call, OPTIONS);
    expect(call.apiContext.url['sort']).toBe('-name');
  });

  it('keeps the row order when neither the request nor the feed sorts', () => {
    expect(ids(query('name=*', { defaultSort: undefined }))).toEqual(['C1', 'C2', 'C3']);
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
  ])('pages %s', (raw, expected, pageValues) => {
    const result = page(query(raw));
    expect(result.items.map((r) => r['commentid'])).toEqual(expected);
    expect(result.page).toMatchObject({ recordCount: 3, ...pageValues });
  });

  it('pages an empty feed from its first page', () => {
    const result = page(beanFeedQuery([], callFor({ raw: 'startIndex=4&isnew=1' }), OPTIONS));
    expect(result.items).toEqual([]);
    expect(result.page).toMatchObject({ recordCount: 0, pageIndex: 1 });
  });

  it.each([
    ['countOnly=true', 3],
    ['countOnly=1&name=bob', 1],
    ['countOnly=yes&maxitems=1', 3],
    ['countOnly=true&sort=name%3Bdrop', 3],
  ])('counts %s', (raw, count) => {
    expect(query(raw)).toEqual({ count });
  });

  it('pages findMany rows whatever countOnly says, as legacy findMany never counts', () => {
    const result = page(beanFeedQuery(ROWS, callFor({ method: 'findMany', raw: 'countOnly=true' }), OPTIONS));
    expect(result.items).toHaveLength(3);
    expect(result.baseUrl).toBeUndefined();
  });

  it('builds the findQuery base URL from the query string, skipping pageIndex and empty values', () => {
    const result = page(query('Name=b%20o&pageindex=2&or&sort=-name'));
    expect(result.baseUrl).toBe(`${ENDPOINT}/comment/?Name=b+o&or&sort=-name`);
  });

  it('filters by expansion params, leaves the excluded ones to the feed props and pages from the URL scope', () => {
    const call = callFor({ method: 'findOne', raw: 'itemsPerPage=1', url: { itemsPerPage: '1' } });
    const result = page(beanFeedQuery(ROWS, call, { ...OPTIONS, expandedParams: { isapproved: 1, maxitems: '1' } }));
    expect(result.items.map((r) => r['commentid'])).toEqual(['C3']);
    expect(result.page).toMatchObject({ recordCount: 1, nextN: 1 });
    expect(result.baseUrl).toBe(`${ENDPOINT}/comment/?isapproved=1`);
    // A key no column holds is a filter there too, which SQL Server rejects.
    expect(() => beanFeedQuery(ROWS, call, { ...OPTIONS, expandedParams: { cachedWithin: '5' } })).toThrow(
      LegacyApiError,
    );
  });

  it('checks columns against the declared column list and compares string timestamps', () => {
    const rows: Row[] = [
      { commentid: 'S1', entered: '2026-01-05 00:00:00.000' },
      { commentid: 'S2', entered: '2026-03-01 08:30:00' },
    ];
    const options = { ...OPTIONS, columns: ['commentid', 'entered'] };
    expect(ids(query('entered=gt%5E2026-02-01&sort=-entered', options, rows))).toEqual(['S2']);
    expect(() => query('name=x', options, rows)).toThrow(LegacyApiError);
  });
});
