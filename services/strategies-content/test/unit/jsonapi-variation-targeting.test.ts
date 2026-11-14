// JSON API `variationTargeting` handlers. Expected bodies are what the Masa 7.6.1 oracle on ACF 2023 answers with
// `variations` on (and, for the disabled case, off), with the site, endpoint and generated ids substituted.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, isCfUuid, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { listVariationTargetings } from '../../src/domain/variations.js';
import { contentApiSerializer, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { variationTargetingHandler as handler } from '../../src/routes/jsonapi/variation-targeting.js';
import {
  beanFeedQuery,
  createJsonApiParams,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
} from '../../src/routes/jsonapi/types.js';

type Row = Record<string, unknown>;
type RouteContext = Parameters<JsonApiHandlerFn>[0];

const SITE = TENANT_A.siteId;
const ENDPOINT = `http://localhost:20980/index.cfm/_api/json/v1/${SITE}`;
const ABSENT_ID = '11111111-2222-3333-4444555566667777';
const HOME_ID = '00000000000000000000000000000000001';

function actor(roles: string[], overrides: Partial<Actor> = {}): Actor {
  const loggedIn = roles.length > 0;
  return {
    userId: loggedIn ? 'U0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF' : '',
    fullName: '',
    isLoggedIn: loggedIn,
    s2: false,
    roles,
    siteId: loggedIn ? SITE : '',
    tenantId: loggedIn ? TENANT_A.tenantId : '',
    ...overrides,
  };
}

const ANONYMOUS = actor([]);
const CONTENT_EDITOR = actor(['system-user', 'm:000']);
const VARIATION_EDITOR = actor(['system-user', 'm:099']);
const SUPER_USER = actor(['s2'], { s2: true });

/** The URL scope legacy parses from `raw`. */
function urlScope(raw: string): Row {
  const url: Row = {};
  for (const item of raw.split('&').filter((part) => part !== '')) {
    const [key = '', ...rest] = item.split('=');
    url[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return url;
}

interface CallOptions {
  method: string;
  id?: string;
  ids?: string[];
  /** The query string; findQuery reads its filters from it. */
  raw?: string;
  /** The URL scope when it holds more than `raw`, as dispatch leaves it. */
  url?: Row;
  form?: Row;
  actor?: Actor;
  csrf?: boolean;
}

/** One resolved call as ../jsonapi.ts hands it over; `csrfChecks` counts validateCsrf calls. */
function callFor(o: CallOptions): JsonApiCall & { csrfChecks: number } {
  const raw = o.raw ?? '';
  const url = o.url ?? urlScope(raw);
  const apiContext = {
    siteId: SITE,
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: o.form ?? {},
    method: o.method,
    isAggregateQuery: false,
    user: { loggedIn: (o.actor ?? ANONYMOUS).isLoggedIn, systemUser: true },
    allowAction: () => false,
    customImageSizes: [],
  } as unknown as JsonApiRequestContext;
  const call = {
    mode: 'json' as const,
    family: '/_api/json/v1',
    routeKey: `api:variationtargeting.${o.method.toLowerCase()}`,
    method: o.method,
    entityName: 'variationTargeting',
    ...(o.id === undefined ? {} : { id: o.id }),
    ...(o.ids === undefined ? {} : { ids: o.ids }),
    pathInfo: [SITE, 'variationTargeting'],
    params: createJsonApiParams(Object.entries({ ...url, ...o.form })),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: SITE,
    tenantId: TENANT_A.tenantId,
    actor: o.actor ?? ANONYMOUS,
    site: {} as JsonApiCall['site'],
    apiContext,
    httpMethod: 'GET',
    headers: {},
    csrfChecks: 0,
    validateCsrf: () => {
      call.csrfChecks += 1;
      return Promise.resolve(o.csrf ?? true);
    },
  };
  return call;
}

/** A db or repository whose every use fails the test. */
function untouchable<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error(`${label} was used`);
      },
    },
  ) as T;
}

function contextOf(domain: DomainDeps): RouteContext {
  return { domain } as unknown as RouteContext;
}

const offline = (variations: boolean): RouteContext =>
  contextOf({
    db: untouchable<TenantDb>('db'),
    repository: untouchable<ContentRepository>('repository'),
    clock: fixedClock(new Date(2026, 5, 30)),
    config: { ...CONTENT_CONFIG_DEFAULTS, variations },
  });

type Method = 'findOne' | 'findMany' | 'findAll' | 'findNew' | 'findQuery' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

/** Runs `method` on `call`, or on a call built from `o`. */
async function run(
  ctx: RouteContext,
  method: Method,
  o: Omit<CallOptions, 'method'> | JsonApiCall = {},
): Promise<JsonApiResult> {
  const fn = handler[method];
  if (fn === undefined) throw new Error(`${method} is not served`);
  return fn(ctx, 'apiContext' in o ? o : callFor({ method, ...o }));
}

/** The response body the front controller sends for `result`, parsed. */
function wire(result: JsonApiResult, method: string): unknown {
  const { body } = serializeResponse(
    { apiversion: 'v1', method, data: result.data },
    { statusCode: result.status ?? 200, serializer: contentApiSerializer('variationTargeting') },
  );
  return JSON.parse(body);
}

/** The links legacy builds for a targeting bean. */
function beanLinks(targetingId: string, contentId = ''): Row {
  return {
    all: `${ENDPOINT}/variationTargeting`,
    site: `${ENDPOINT}/site`,
    permissions: `${ENDPOINT}/variationTargeting/${targetingId}/permissions`,
    properties: `${ENDPOINT}/variationTargeting/properties`,
    self: `${ENDPOINT}/variationTargeting/${targetingId}`,
    entities: ENDPOINT,
    ...(contentId === '' ? {} : { content: `${ENDPOINT}/content/${contentId}` }),
  };
}

/** findOne and findNew data of a bean no row backs. */
function newBeanData(targetingId: string): Row {
  return {
    contentid: '',
    initjs: '',
    targetingjs: '',
    links: beanLinks(targetingId),
    siteid: SITE,
    cachedwithin: '0',
    targetingid: targetingId,
    returnformat: 'self',
    id: targetingId,
    isnew: 1,
    entityname: 'variationTargeting',
  };
}

/** The data of a stored bean. */
function storedData(targetingId: string, values: { contentid: string; initjs: string; targetingjs: string }): Row {
  return {
    ...values,
    links: beanLinks(targetingId, values.contentid),
    siteid: SITE,
    targetingid: targetingId,
    id: targetingId,
    isnew: 0,
    entityname: 'variationTargeting',
  };
}

const PROPERTIES: Row[] = [
  { fieldtype: 'id', length: '35', required: true, nullable: false, html: 'false', name: 'targetingid', datatype: 'char', default: '' },
  {
    fieldtype: 'many-to-one',
    loadkey: 'siteid',
    length: '25',
    required: false,
    cascade: 'none',
    nullable: true,
    html: 'false',
    fkcolumn: 'siteid',
    name: 'site',
    datatype: 'varchar',
    relatesto: 'site',
    default: '',
  },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'initjs', datatype: 'text', default: 'null' },
  { fieldtype: '', required: false, html: 'false', nullable: true, name: 'targetingjs', datatype: 'text', default: 'null' },
  {
    fieldtype: 'one-to-one',
    loadkey: 'contentid',
    length: '35',
    required: false,
    cascade: 'none',
    nullable: true,
    html: 'false',
    fkcolumn: 'contentid',
    name: 'content',
    datatype: 'char',
    relatesto: 'content',
    default: '',
  },
];

/** findProperties data; `table` is reported to admins and super users only. */
function propertiesData(properties: Row[], table?: string): Row {
  return {
    displayname: 'variationTargeting',
    properties,
    historical: false,
    links: {
      swagger_json: `${ENDPOINT}/swagger?mode=json&entities=variationTargeting`,
      endpoint: `${ENDPOINT}/variationTargeting`,
      swagger_rest: `${ENDPOINT}/swagger?mode=rest&entities=variationTargeting`,
      self: `${ENDPOINT}/variationTargeting/properties`,
      entities: ENDPOINT,
    },
    dynamic: false,
    ...(table === undefined ? {} : { table }),
    primarykey: 'targetingid',
    public: false,
    bundleable: 'true',
    orderby: '',
    entityname: 'variationTargeting',
    scaffold: false,
  };
}

const METHODS: Method[] = ['findOne', 'findMany', 'findAll', 'findNew', 'findQuery', 'findProperties', 'findPermissions', 'save', 'delete'];

describe('variationTargetingHandler', () => {
  it('serves the generic methods of the registered entity', () => {
    expect(handler.entity).toBe('variationTargeting');
    expect(handler.config.moduleId).toBe('00000000000000000000000000000000000');
    for (const method of METHODS) expect(handler[method]).toBeTypeOf('function');
  });
});

describe('with the variations setting off', () => {
  it.each(METHODS)('%s refuses with authorization before any read, write or CSRF check', async (method) => {
    const call = callFor({ method, id: ABSENT_ID, actor: SUPER_USER });
    await expect(run(offline(false), method, call)).rejects.toSatisfy(
      (e: unknown) => e instanceof LegacyApiError && e.type === 'authorization',
    );
    expect(call.csrfChecks).toBe(0);
  });
});

describe('access refused before the store is read', () => {
  it.each<[Method, Actor]>([
    ['findOne', ANONYMOUS],
    ['findNew', ANONYMOUS],
    ['findAll', ANONYMOUS],
    ['findQuery', ANONYMOUS],
    ['findMany', ANONYMOUS],
    ['findOne', VARIATION_EDITOR],
  ])('%s answers authorization to an actor without the Content module (%#)', async (method, who) => {
    const result = await run(offline(true), method, { id: ABSENT_ID, ids: [ABSENT_ID], actor: who });
    expect(result).toEqual({ error: 'authorization' });
  });

  const READS: Method[] = ['findOne', 'findNew', 'findAll', 'findQuery', 'findMany'];
  const MATRIX: [string, Actor, boolean][] = [
    ['anonymous', ANONYMOUS, false],
    ['member', actor(['member']), false],
    ['system-user', actor(['system-user']), false],
    ['Variation module (m:099)', VARIATION_EDITOR, false],
    ['Users module (m:008)', actor(['system-user', 'm:008']), false],
    ['Content module (m:000)', CONTENT_EDITOR, true],
    ['site-admin', actor(['site-admin']), true],
    ['s2', SUPER_USER, true],
  ];

  it.each(READS.flatMap((method) => MATRIX.map(([label, who, allowed]): [Method, string, Actor, boolean] => [method, label, who, allowed])))(
    '%s by %s is served only with the Content module permission',
    async (method, _label, who, allowed) => {
      const call = run(offline(true), method, { id: ABSENT_ID, ids: [ABSENT_ID], actor: who });
      // findNew reads nothing; every other read reaches the (unusable) store once allowed.
      if (!allowed) await expect(call).resolves.toEqual({ error: 'authorization' });
      else if (method === 'findNew') await expect(call).resolves.toMatchObject({ status: 200 });
      else await expect(call).rejects.toThrow(/was used/);
    },
  );

  it('save validates CSRF first: a bad token is invalidTokens even for an anonymous caller', async () => {
    const call = callFor({ method: 'save', actor: ANONYMOUS, csrf: false, form: { initjs: 'x' } });
    expect(await run(offline(true), 'save', call)).toEqual({ error: 'invalidTokens' });
    expect(call.csrfChecks).toBe(1);
  });

  it.each([ANONYMOUS, VARIATION_EDITOR])('save with valid tokens answers authorization without the Content module (%#)', async (who) => {
    const call = callFor({ method: 'save', actor: who, form: { initjs: 'x' } });
    expect(await run(offline(true), 'save', call)).toEqual({ error: 'authorization' });
    expect(call.csrfChecks).toBe(1);
  });
});

describe('beanFeedQuery for findMany', () => {
  it.each<[string, boolean]>([
    ['findMany', false],
    ['findAll', true],
  ])('%s with countOnly=true answers a count: %s', (method, counted) => {
    const rows = [{ targetingid: 'A', contentid: null, siteid: SITE, initjs: null, targetingjs: null }];
    const result = beanFeedQuery(rows, callFor({ method, url: { countOnly: 'true' } }), { primaryKey: 'targetingid', propertyNames: [] });
    expect('count' in result).toBe(counted);
  });
});

describe('findProperties', () => {
  it.each<[string, Actor, string | undefined]>([
    ['anonymous', ANONYMOUS, undefined],
    ['a super user', SUPER_USER, 'tcontentvariationtargeting'],
    ['a site admin', actor(['site-admin']), 'tcontentvariationtargeting'],
  ])('answers the bean metadata to %s without an access check', async (_label, who, table) => {
    const result = await run(offline(true), 'findProperties', { id: 'properties', actor: who });
    expect(result.status).toBe(200);
    expect(wire(result, 'findProperties')).toEqual({ apiversion: 'v1', data: propertiesData(PROPERTIES, table), method: 'findProperties' });
  });

  it.each<[string, Row[]]>([
    ['TARGETINGID,Content', [PROPERTIES[0] as Row, PROPERTIES[4] as Row]],
    ['initjs,site', [PROPERTIES[2] as Row, PROPERTIES[1] as Row]],
    ['initjs,initjs', [PROPERTIES[2] as Row, PROPERTIES[2] as Row]],
    ['isnew,errors,saveerrors,frommuracache,instanceid', []],
  ])('lists the requested properties=%s in request order', async (properties, expected) => {
    const result = await run(offline(true), 'findProperties', { id: 'properties', form: { properties } });
    expect(wire(result, 'findProperties')).toEqual({ apiversion: 'v1', data: propertiesData(expected), method: 'findProperties' });
  });

  it.each(['nosuch', 'siteid', 'contentid', 'bundleable'])('a property=%s the bean does not declare is a server_error', async (properties) => {
    await expect(run(offline(true), 'findProperties', { id: 'properties', form: { properties } })).rejects.toSatisfy(
      (e: unknown) => e instanceof LegacyApiError && e.type === 'server_error',
    );
  });
});

let handle: ThrowawaySchema;
let deps: DomainDeps;
let ctx: RouteContext;

const collection = (items: Row[], links: Row, extra: Row = {}): Row => {
  const total = items.length;
  return {
    pageindex: total === 0 ? 0 : 1,
    itemsperpage: 1000,
    totalpages: total === 0 ? 0 : 1,
    totalitems: total,
    links: {
      permissions: `${ENDPOINT}/variationTargeting/permissions`,
      properties: `${ENDPOINT}/variationTargeting/properties`,
      entities: ENDPOINT,
      ...links,
    },
    items,
    endindex: total,
    entityname: 'variationTargeting',
    startindex: total === 0 ? 0 : 1,
    ...extra,
  };
};

describe.skipIf(!(await pgAvailable()))('over a throwaway content schema', () => {
  const ids: { first: string; second: string } = { first: '', second: '' };

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-variation-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-variation-test', state: 'open' });
    const clock = fixedClock(new Date(2026, 5, 30, 10, 15, 42));
    deps = {
      db: handle.app,
      repository: createContentRepository({ clock, schema: handle.schema }),
      clock,
      config: { ...CONTENT_CONFIG_DEFAULTS, variations: true },
    };
    ctx = contextOf(deps);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('findOne of an id no row holds answers a new bean with the load keys and empty scripts', async () => {
    const result = await run(ctx, 'findOne', { id: ABSENT_ID, actor: CONTENT_EDITOR });
    expect(result.status).toBe(200);
    expect(wire(result, 'findOne')).toEqual({ apiversion: 'v1', data: newBeanData(ABSENT_ID), method: 'findOne' });
  });

  it('findNew answers a new bean under a fresh CF id', async () => {
    const result = await run(ctx, 'findNew', { id: 'new', actor: CONTENT_EDITOR });
    const data = (wire(result, 'findNew') as { data: Row }).data;
    const id = String(data['targetingid']);
    expect(isCfUuid(id)).toBe(true);
    expect(data).toEqual(newBeanData(id));
  });

  it('findAll over no rows answers the empty collection', async () => {
    const url = { method: 'findall', siteid: SITE };
    const result = await run(ctx, 'findAll', { url, actor: CONTENT_EDITOR });
    expect(wire(result, 'findAll')).toEqual({
      apiversion: 'v1',
      data: collection([], { self: `${ENDPOINT}/?&method=findall&siteid=${SITE}&entityname=variationTargeting&pageIndex=0` }),
      method: 'findAll',
    });
  });

  it('save inserts under a new id after one CSRF check and answers the reloaded bean', async () => {
    const call = callFor({
      method: 'save',
      actor: CONTENT_EDITOR,
      form: { contentid: HOME_ID, initjs: 'init();', targetingjs: '[1]', siteid: 'other-site' },
    });
    const result = await run(ctx, 'save', call);
    expect(call.csrfChecks).toBe(1);
    expect(result.status).toBe(200);
    const data = (wire(result, 'save') as { data: Row }).data;
    ids.first = String(data['targetingid']);
    expect(isCfUuid(ids.first)).toBe(true);
    expect(data).toEqual({
      ...storedData(ids.first, { contentid: HOME_ID, initjs: 'init();', targetingjs: '[1]' }),
      saveerrors: false,
      errors: {},
    });
  });

  it('findOne answers the stored bean', async () => {
    const result = await run(ctx, 'findOne', { id: ids.first, actor: CONTENT_EDITOR });
    expect(wire(result, 'findOne')).toEqual({
      apiversion: 'v1',
      data: storedData(ids.first, { contentid: HOME_ID, initjs: 'init();', targetingjs: '[1]' }),
      method: 'findOne',
    });
  });

  it('save by path id updates the trimmed values it is given and keeps the others; saveErrors echoes a boolean param', async () => {
    const form = { targetingid: ids.first, initjs: '  updated();\n', saveErrors: 'yes' };
    const result = await run(ctx, 'save', { id: ids.first, actor: CONTENT_EDITOR, form });
    expect((wire(result, 'save') as { data: Row }).data).toEqual({
      ...storedData(ids.first, { contentid: HOME_ID, initjs: 'updated();', targetingjs: '[1]' }),
      saveerrors: true,
      errors: {},
    });
  });

  it('save of a second bean with only a content id stores empty scripts', async () => {
    const result = await run(ctx, 'save', { actor: CONTENT_EDITOR, form: { contentid: 'ABC', initjs: null } });
    const data = (wire(result, 'save') as { data: Row }).data;
    ids.second = String(data['targetingid']);
    expect(data).toEqual({ ...storedData(ids.second, { contentid: 'ABC', initjs: '', targetingjs: '' }), saveerrors: false, errors: {} });
  });

  it('listVariationTargetings returns the columns of the tenant rows in primary-key order', async () => {
    const rows = await listVariationTargetings(deps, CONTENT_EDITOR);
    expect(rows.map((row) => row.targetingid)).toEqual([ids.first, ids.second].sort());
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['contentid', 'initjs', 'siteid', 'targetingid', 'targetingjs']);
  });

  const stored = (): Row[] =>
    [
      storedData(ids.first, { contentid: HOME_ID, initjs: 'updated();', targetingjs: '[1]' }),
      storedData(ids.second, { contentid: 'ABC', initjs: '', targetingjs: '' }),
    ].sort((a, b) => String(a['targetingid']).localeCompare(String(b['targetingid'])));

  it('findAll answers every row of the site in primary-key order', async () => {
    const result = await run(ctx, 'findAll', { url: { method: 'findall', siteid: SITE }, actor: CONTENT_EDITOR });
    expect(wire(result, 'findAll')).toEqual({
      apiversion: 'v1',
      data: collection(stored(), {
        self: `${ENDPOINT}/?&method=findall&siteid=${SITE}&entityname=variationTargeting&expanddepth=1&pageIndex=1`,
      }),
      method: 'findAll',
    });
  });

  it.each<[string, (rows: Row[]) => Row[]]>([
    ['contentid=ABC', (rows) => rows.filter((row) => row['contentid'] === 'ABC')],
    ['contentid=NOPE', () => []],
    ['contentid=AB*', (rows) => rows.filter((row) => row['contentid'] === 'ABC')],
    ['site=x', (rows) => rows],
    ['content=x', (rows) => rows],
    ['errors=1', (rows) => rows],
    ['sortBy=contentid&sortDirection=desc', (rows) => [...rows].sort((a, b) => (a['contentid'] === 'ABC' ? -1 : b['contentid'] === 'ABC' ? 1 : 0))],
  ])('findQuery %s filters and sorts as the bean feed does', async (raw, select) => {
    const result = await run(ctx, 'findQuery', { raw, actor: CONTENT_EDITOR });
    const data = (wire(result, 'findQuery') as { data: Row }).data;
    expect(data['items']).toEqual(select(stored()));
  });

  it('findQuery fields selects only the named table columns, with the primary key', async () => {
    const result = await run(ctx, 'findQuery', { raw: 'fields=initjs,nosuch', actor: CONTENT_EDITOR });
    const items = ((wire(result, 'findQuery') as { data: Row }).data['items'] as Row[]).map((item) => item);
    expect(items).toEqual(
      stored().map((row) => ({
        targetingid: row['targetingid'],
        nosuch: '',
        initjs: row['initjs'],
        id: row['targetingid'],
        siteid: '',
        isnew: 0,
        entityname: 'variationTargeting',
      })),
    );
  });

  it('findQuery countOnly answers the count as text', async () => {
    const result = await run(ctx, 'findQuery', { raw: 'countOnly=true&contentid=ABC', actor: CONTENT_EDITOR });
    expect(wire(result, 'findQuery')).toEqual({ apiversion: 'v1', data: { count: '1' }, method: 'findQuery' });
  });

  it.each<[string, string]>([
    ['isnew=1', 'server_error'],
    ['saveErrors=true', 'server_error'],
    ['sortBy=nosuch', 'server_error'],
    ['addObjects=1', 'invalidParameters'],
  ])('findQuery %s fails as legacy does (%s)', async (raw, type) => {
    await expect(run(ctx, 'findQuery', { raw, actor: CONTENT_EDITOR })).rejects.toSatisfy(
      (e: unknown) => e instanceof LegacyApiError && e.type === type,
    );
  });

  it('findMany answers the listed rows in list order, ignoring countOnly and unknown ids', async () => {
    const listed = [ids.second.toLowerCase(), ABSENT_ID, ids.first];
    const result = await run(ctx, 'findMany', { ids: listed, url: { countOnly: 'true' }, actor: CONTENT_EDITOR });
    const data = (wire(result, 'findMany') as { data: Row }).data;
    expect((data['items'] as Row[]).map((item) => item['id'])).toEqual([ids.second, ids.first]);
    expect(data['totalitems']).toBe(2);
  });

  it('findMany keeps the feed order when the URL sorts', async () => {
    const result = await run(ctx, 'findMany', { ids: [ids.first, ids.second], url: { sort: '-contentid' }, actor: CONTENT_EDITOR });
    const items = (wire(result, 'findMany') as { data: Row }).data['items'] as Row[];
    expect(items.map((item) => item['contentid'])).toEqual(['ABC', HOME_ID]);
  });

  it.each<[string, Actor, string | undefined, { read: boolean; delete: boolean; save: boolean }]>([
    ['the Content module on a stored id', CONTENT_EDITOR, 'stored', { read: true, delete: true, save: true }],
    ['the Content module on the bare path', CONTENT_EDITOR, 'permissions', { read: true, delete: true, save: true }],
    ['the Content module on an absent id', CONTENT_EDITOR, ABSENT_ID, { read: true, delete: true, save: true }],
    ['anonymous', ANONYMOUS, 'stored', { read: false, delete: false, save: false }],
    ['the Variation module only', VARIATION_EDITOR, 'stored', { read: false, delete: false, save: false }],
  ])('findPermissions for %s', async (_label, who, id, expected) => {
    const result = await run(ctx, 'findPermissions', { id: id === 'stored' ? ids.first : id, actor: who });
    expect(wire(result, 'findPermissions')).toEqual({ apiversion: 'v1', data: expected, method: 'findPermissions' });
  });

  it('save with a targetingid param that is not the load key saves the loaded values under that id', async () => {
    const result = await run(ctx, 'save', { id: ids.first, actor: CONTENT_EDITOR, form: { targetingid: ' REKEYED ', targetingjs: '[2]' } });
    expect((wire(result, 'save') as { data: Row }).data).toEqual({
      ...storedData('REKEYED', { contentid: HOME_ID, initjs: 'updated();', targetingjs: '[2]' }),
      saveerrors: false,
      errors: {},
    });
    const original = await run(ctx, 'findOne', { id: ids.first, actor: CONTENT_EDITOR });
    expect((wire(original, 'findOne') as { data: Row }).data['targetingjs']).toBe('[1]');
  });

  it('delete of an absent row answers empty data to anyone without a CSRF check', async () => {
    const call = callFor({ method: 'delete', id: ABSENT_ID, actor: ANONYMOUS, csrf: false });
    expect(await run(ctx, 'delete', call)).toEqual({ data: '' });
    expect(call.csrfChecks).toBe(0);
  });

  it('delete of a stored row checks AllowAction before CSRF', async () => {
    const anonymous = callFor({ method: 'delete', id: 'REKEYED', actor: ANONYMOUS });
    expect(await run(ctx, 'delete', anonymous)).toEqual({ error: 'authorization' });
    expect(anonymous.csrfChecks).toBe(0);
    const badToken = callFor({ method: 'delete', id: 'REKEYED', actor: CONTENT_EDITOR, csrf: false });
    expect(await run(ctx, 'delete', badToken)).toEqual({ error: 'invalidTokens' });
    const kept = await run(ctx, 'findOne', { id: 'REKEYED', actor: CONTENT_EDITOR });
    expect((wire(kept, 'findOne') as { data: Row }).data['isnew']).toBe(0);
  });

  it('delete removes the row a uuid targetingid param names, then findOne answers a new bean', async () => {
    const call = callFor({ method: 'delete', id: ABSENT_ID, actor: CONTENT_EDITOR, form: { targetingid: ids.second } });
    expect(await run(ctx, 'delete', call)).toEqual({ data: '' });
    expect(call.csrfChecks).toBe(1);
    const after = await run(ctx, 'findOne', { id: ids.second, actor: CONTENT_EDITOR });
    expect(wire(after, 'findOne')).toEqual({ apiversion: 'v1', data: newBeanData(ids.second), method: 'findOne' });
  });
});
