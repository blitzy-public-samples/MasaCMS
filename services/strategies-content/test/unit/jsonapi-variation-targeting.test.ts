// JSON API `variationTargeting` handlers. Expected bodies are what the Masa 7.6.1 oracle on ACF 2023 answers with
// `variations` on (and, for the disabled case, off), with the site, endpoint and generated ids substituted.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyApiError, isCfUuid, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type QueryConfig, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, type Actor, type DomainDeps } from '../../src/domain/context.js';
import { withVariationTargetingFeed } from '../../src/domain/variations.js';
import { contentApiSerializer, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import { variationTargetingHandler as handler } from '../../src/routes/jsonapi/variation-targeting.js';
import {
  beanFeedQuery,
  createJsonApiParams,
  rowsSource,
  type JsonApiCall,
  type JsonApiHandlerFn,
  type JsonApiResult,
} from '../../src/routes/jsonapi/types.js';
import { scopeRows } from '../helpers/feed.js';

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
  /** The request site, which is also the API instance's; SITE by default. */
  site?: string;
}

/** One resolved call as ../jsonapi.ts hands it over; `csrfChecks` counts validateCsrf calls. */
function callFor(o: CallOptions): JsonApiCall & { csrfChecks: number } {
  const raw = o.raw ?? '';
  const url = o.url ?? urlScope(raw);
  const site = o.site ?? SITE;
  const apiContext = {
    siteId: site,
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: o.form ?? {},
    method: o.method,
    isAggregateQuery: false,
    user: { loggedIn: (o.actor ?? ANONYMOUS).isLoggedIn, systemUser: true },
    allowAction: () => false,
    customImageSizes: () => Promise.resolve([]),
  } as unknown as JsonApiRequestContext;
  const call = {
    mode: 'json' as const,
    family: '/_api/json/v1',
    routeKey: `api:variationtargeting.${o.method.toLowerCase()}`,
    method: o.method,
    entityName: 'variationTargeting',
    ...(o.id === undefined ? {} : { id: o.id }),
    ...(o.ids === undefined ? {} : { ids: o.ids }),
    pathInfo: [site, 'variationTargeting'],
    params: createJsonApiParams(Object.entries({ ...url, ...o.form })),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: site,
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
  const UNREGISTERED_READS: Method[] = ['findOne', 'findMany', 'findAll', 'findNew', 'findQuery'];

  it.each(UNREGISTERED_READS)('%s refuses with authorization before any read or CSRF check', async (method) => {
    const call = callFor({ method, id: ABSENT_ID, actor: SUPER_USER });
    await expect(run(offline(false), method, call)).rejects.toSatisfy(
      (e: unknown) => e instanceof LegacyApiError && e.type === 'authorization',
    );
    expect(call.csrfChecks).toBe(0);
  });

  it.each<[string, Actor]>([
    ['anonymous', ANONYMOUS],
    ['a super user', SUPER_USER],
  ])('findProperties answers %s what it answers with the setting on', async (_label, who) => {
    const off = await run(offline(false), 'findProperties', { id: 'properties', actor: who });
    expect(off).toEqual(await run(offline(true), 'findProperties', { id: 'properties', actor: who }));
    expect(off.status).toBe(200);
  });

  it.each<[string, Actor, { read: boolean; delete: boolean; save: boolean }]>([
    ['anonymous', ANONYMOUS, { read: false, delete: false, save: false }],
    ['the Content module', CONTENT_EDITOR, { read: false, delete: true, save: true }],
    ['a super user', SUPER_USER, { read: false, delete: true, save: true }],
  ])('findPermissions on the bare path answers %s without read, which AllowAccess refuses an unregistered entity', async (_label, who, expected) => {
    const result = await run(offline(false), 'findPermissions', { id: 'permissions', actor: who });
    expect(wire(result, 'findPermissions')).toEqual({ apiversion: 'v1', data: expected, method: 'findPermissions' });
  });

  // getEntityConfig registers the entity on the site's API instance before findProperties reads a property (oracle).
  it.each<[string, Row, string | undefined]>([
    ['every property', {}, undefined],
    ['an unknown property', { properties: 'nosuch' }, 'server_error'],
  ])(
    'a findProperties of %s registers the entity for its site in this context only, serving reads to the Content module',
    async (_label, form, failure) => {
      const ctx = offline(false);
      const OTHER_SITE = TENANT_B.siteId;
      const thrown = (type: string) => (e: unknown) => e instanceof LegacyApiError && e.type === type;
      const permissions = async (who: Actor, site = SITE): Promise<unknown> =>
        (wire(await run(ctx, 'findPermissions', { id: 'permissions', actor: who, site }), 'findPermissions') as { data: unknown }).data;

      expect(await permissions(CONTENT_EDITOR)).toEqual({ read: false, delete: true, save: true });
      await expect(run(ctx, 'findNew', { id: 'new', actor: CONTENT_EDITOR })).rejects.toSatisfy(thrown('authorization'));

      const properties = run(ctx, 'findProperties', { id: 'properties', form, site: SITE.toUpperCase() });
      if (failure === undefined) await expect(properties).resolves.toMatchObject({ status: 200 });
      else await expect(properties).rejects.toSatisfy(thrown(failure));

      expect(await permissions(CONTENT_EDITOR)).toEqual({ read: true, delete: true, save: true });
      expect(await permissions(SUPER_USER)).toEqual({ read: true, delete: true, save: true });
      expect(await permissions(ANONYMOUS)).toEqual({ read: false, delete: false, save: false });
      await expect(run(ctx, 'findNew', { id: 'new', actor: CONTENT_EDITOR })).resolves.toMatchObject({ status: 200 });
      for (const method of ['findOne', 'findAll', 'findQuery', 'findMany'] as const) {
        // Past the registration and the access check, each reads the (unusable) store.
        await expect(run(ctx, method, { id: ABSENT_ID, ids: [ABSENT_ID], actor: CONTENT_EDITOR })).rejects.toThrow(/was used/);
      }
      for (const method of ['findOne', 'findAll', 'findQuery', 'findMany', 'findNew'] as const) {
        await expect(run(ctx, method, { id: ABSENT_ID, ids: [ABSENT_ID], actor: ANONYMOUS })).resolves.toEqual({ error: 'authorization' });
      }

      expect(await permissions(CONTENT_EDITOR, OTHER_SITE)).toEqual({ read: false, delete: true, save: true });
      await expect(run(ctx, 'findNew', { id: 'new', actor: CONTENT_EDITOR, site: OTHER_SITE })).rejects.toSatisfy(thrown('authorization'));
      await expect(run(offline(false), 'findNew', { id: 'new', actor: CONTENT_EDITOR })).rejects.toSatisfy(thrown('authorization'));
    },
  );
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

  it.each([true, false])('save validates CSRF first: a bad token is invalidTokens even for an anonymous caller (variations=%s)', async (variations) => {
    const call = callFor({ method: 'save', actor: ANONYMOUS, csrf: false, form: { initjs: 'x' } });
    expect(await run(offline(variations), 'save', call)).toEqual({ error: 'invalidTokens' });
    expect(call.csrfChecks).toBe(1);
  });

  it.each<[Actor, boolean]>([
    [ANONYMOUS, true],
    [VARIATION_EDITOR, true],
    [VARIATION_EDITOR, false],
  ])('save with valid tokens answers authorization without the Content module (%#)', async (who, variations) => {
    const call = callFor({ method: 'save', actor: who, form: { initjs: 'x' } });
    expect(await run(offline(variations), 'save', call)).toEqual({ error: 'authorization' });
    expect(call.csrfChecks).toBe(1);
  });
});

describe('beanFeedQuery for findMany', () => {
  it.each<[string, boolean]>([
    ['findMany', false],
    ['findAll', true],
  ])('%s with countOnly=true answers a count: %s', async (method, counted) => {
    const rows = [{ targetingid: 'A', contentid: null, siteid: SITE, initjs: null, targetingjs: null }];
    const result = await beanFeedQuery(rows, callFor({ method, url: { countOnly: 'true' } }), { primaryKey: 'targetingid', propertyNames: [] });
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

  it('the feed source holds the columns of the tenant rows in primary-key order', async () => {
    const rows = await withVariationTargetingFeed(deps, CONTENT_EDITOR, {}, (source) => scopeRows(source));
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
        // Base URL params in ACF's struct iteration order.
        self: `${ENDPOINT}/?&method=findall&expanddepth=1&siteid=${SITE}&entityname=variationTargeting&pageIndex=1`,
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

  // A blank row (queryRowToStruct before row 1) sets '' on a new bean, whose targetingid beanORM.init made a createUUID().
  it.each<[string, string, (id: string) => Row]>([
    ['every value', 'itemsPerPage=2&pageIndex=0', (id) => ({ contentid: '', initjs: '', targetingjs: '', links: beanLinks(id) })],
    ['a field list', 'itemsPerPage=2&pageIndex=0&fields=initjs', (id) => ({ initjs: '', targetingid: id })],
  ])('findQuery before the first record answers the beans of blank rows with %s, each under a fresh id', async (_label, raw, values) => {
    const data = (wire(await run(ctx, 'findQuery', { raw, actor: CONTENT_EDITOR }), 'findQuery') as { data: Row }).data;
    expect(data).toMatchObject({ totalitems: 2, pageindex: 0, startindex: -1 });
    const items = data['items'] as Row[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      const id = String(item['id']);
      expect(isCfUuid(id)).toBe(true);
      expect(item).toEqual({ ...values(id), targetingid: id, id, siteid: '', isnew: 0, entityname: 'variationTargeting' });
    }
    expect(items[0]?.['id']).not.toBe(items[1]?.['id']);
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

  /** The handlers with the `variations` setting off over the same schema. */
  const offCtx = (): RouteContext => contextOf({ ...deps, config: { ...deps.config, variations: false } });

  it.each<[string, Actor, string | undefined, boolean, { read: boolean; delete: boolean; save: boolean }]>([
    ['the Content module on a stored id', CONTENT_EDITOR, 'stored', true, { read: true, delete: true, save: true }],
    ['the Content module on the bare path', CONTENT_EDITOR, 'permissions', true, { read: true, delete: true, save: true }],
    ['the Content module on an absent id', CONTENT_EDITOR, ABSENT_ID, true, { read: true, delete: true, save: true }],
    ['anonymous', ANONYMOUS, 'stored', true, { read: false, delete: false, save: false }],
    ['the Variation module only', VARIATION_EDITOR, 'stored', true, { read: false, delete: false, save: false }],
    ['the Content module on a stored id, the setting off', CONTENT_EDITOR, 'stored', false, { read: false, delete: true, save: true }],
    ['anonymous on a stored id, the setting off', ANONYMOUS, 'stored', false, { read: false, delete: false, save: false }],
  ])('findPermissions for %s', async (_label, who, id, variations, expected) => {
    const result = await run(variations ? ctx : offCtx(), 'findPermissions', { id: id === 'stored' ? ids.first : id, actor: who });
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

  it.each([true, false])('delete of an absent row answers empty data to anyone without a CSRF check (variations=%s)', async (variations) => {
    const call = callFor({ method: 'delete', id: ABSENT_ID, actor: ANONYMOUS, csrf: false });
    expect(await run(variations ? ctx : offCtx(), 'delete', call)).toEqual({ data: '' });
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

  it('with the setting off, a super user saves and deletes as with it on', async () => {
    const saveCall = callFor({ method: 'save', actor: SUPER_USER, form: { contentid: HOME_ID, initjs: 'off();' } });
    const saved = await run(offCtx(), 'save', saveCall);
    expect(saveCall.csrfChecks).toBe(1);
    expect(saved.status).toBe(200);
    const data = (wire(saved, 'save') as { data: Row }).data;
    const id = String(data['targetingid']);
    expect(data).toEqual({ ...storedData(id, { contentid: HOME_ID, initjs: 'off();', targetingjs: '' }), saveerrors: false, errors: {} });
    const stored = await run(ctx, 'findOne', { id, actor: CONTENT_EDITOR });
    expect((wire(stored, 'findOne') as { data: Row }).data['initjs']).toBe('off();');

    const deleteCall = callFor({ method: 'delete', id, actor: SUPER_USER });
    expect(await run(offCtx(), 'delete', deleteCall)).toEqual({ data: '' });
    expect(deleteCall.csrfChecks).toBe(1);
    const after = await run(ctx, 'findOne', { id, actor: CONTENT_EDITOR });
    expect(wire(after, 'findOne')).toEqual({ apiversion: 'v1', data: newBeanData(id), method: 'findOne' });
  });

  /** Targeting and changelog rows of tenant A. */
  async function writeCounts(): Promise<{ rows: number; changes: number }> {
    return withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const count = async (table: string): Promise<number> =>
        (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.${table}`)).rows[0]?.n ?? 0;
      return { rows: await count('variation_targeting'), changes: await count('changelog') };
    });
  }

  const X36 = 'X'.repeat(36);
  const X100 = 'X'.repeat(100);
  const T40 = 'T'.repeat(40);
  /** Stands for the stored row `ids.first` in a case's path id and params. */
  const STORED = '<stored>';
  /** The data of `ids.first` as stored, with `values` set on it. */
  const storedFirst = (values: Partial<{ contentid: string; initjs: string }> = {}): Row =>
    storedData(ids.first, { contentid: HOME_ID, initjs: 'updated();', targetingjs: '[1]', ...values });
  /** The data of a new bean under `id`, with `values` set on it. */
  const newBean = (id: string, values: Row = {}): Row => ({ ...newBeanData(id), ...values, links: beanLinks(id, String(values['contentid'] ?? '')) });

  // The oracle's answers (save reads no `variations` setting): the bean reloaded by its primary key with the request
  // values it holds set on it, saveerrors false and the field errors, under 403.
  it.each<[string, { id?: string; form: Row; errors: string[]; data: (id: string) => Row }]>([
    ['a new bean with a 36-character contentid', { form: { contentid: X36, initjs: 'a36' }, errors: ['contentid'], data: (id) => newBean(id, { contentid: X36, initjs: 'a36' }) }],
    [
      'a new bean with a 100-character contentid',
      { form: { contentid: X100, initjs: 'a100', targetingjs: 't' }, errors: ['contentid'], data: (id) => newBean(id, { contentid: X100, initjs: 'a100', targetingjs: 't' }) },
    ],
    [
      'a stored bean updated by path id with an overlong contentid',
      { id: STORED, form: { contentid: X36, initjs: 'b36' }, errors: ['contentid'], data: () => storedFirst({ contentid: X36, initjs: 'b36' }) },
    ],
    [
      'a stored bean its targetingid param names, with an overlong contentid',
      { form: { targetingid: STORED, contentid: X36 }, errors: ['contentid'], data: () => storedFirst({ contentid: X36 }) },
    ],
    [
      'an overlong targetingid param on a stored path id',
      { id: STORED, form: { targetingid: T40, initjs: 'd40' }, errors: ['targetingid'], data: () => newBean(T40, { initjs: 'd40' }) },
    ],
    [
      'an overlong targetingid param and contentid on a stored path id',
      { id: STORED, form: { targetingid: T40, contentid: X36 }, errors: ['contentid', 'targetingid'], data: () => newBean(T40, { contentid: X36 }) },
    ],
    [
      'a new bean with an overlong contentid and loadBy and base bean params',
      {
        form: { contentid: X36, isnew: '0', returnformat: 'json', cachedwithin: '5', errors: 'e', fromMuraCache: 'true', instanceid: 'I', initjs: '  padded  ' },
        errors: ['contentid'],
        data: (id) => newBean(id, { contentid: X36, initjs: 'padded', isnew: 0, returnformat: 'json', cachedwithin: '5' }),
      },
    ],
    [
      'a stored bean with an overlong contentid and loadBy params it does not hold',
      { id: STORED, form: { contentid: X36, isnew: '1', returnformat: 'json' }, errors: ['contentid'], data: () => ({ ...storedFirst({ contentid: X36 }), isnew: 1 }) },
    ],
    ['an overlong contentid with saveErrors=no', { form: { contentid: X36, saveErrors: 'no' }, errors: ['contentid'], data: (id) => newBean(id, { contentid: X36 }) }],
  ])('save of %s answers 403 with the field errors and writes nothing', async (_label, c) => {
    const stored = (value: unknown): unknown => (value === STORED ? ids.first : value);
    const form = Object.fromEntries(Object.entries(c.form).map(([key, value]) => [key, stored(value)]));
    const before = await writeCounts();
    const result = await run(ctx, 'save', { ...(c.id === undefined ? {} : { id: ids.first }), actor: CONTENT_EDITOR, form });
    expect(result.status).toBe(403);
    const data = (wire(result, 'save') as { data: Row }).data;
    const id = String(data['targetingid']);
    expect(data).toEqual({
      ...c.data(id),
      saveerrors: false,
      errors: Object.fromEntries(c.errors.map((key) => [key, `The property named '${key}' is not valid`])),
    });
    expect(await writeCounts()).toEqual(before);
    expect((wire(await run(ctx, 'findOne', { id: ids.first, actor: CONTENT_EDITOR }), 'findOne') as { data: Row }).data).toEqual(storedFirst());
  });

  // PostgreSQL text holds no NUL, which legacy stores (EX-UNSTORABLE-TEXT-VARIATIONTARGETING).
  it.each<[string, { id?: string; form: Row }]>([
    ['a NUL in initjs of a new bean', { form: { contentid: HOME_ID, initjs: 'a\u0000b' } }],
    ['a NUL in targetingjs of a stored bean', { id: STORED, form: { targetingjs: 'a\u0000b' } }],
    ['a NUL in the targetingid param that re-keys a stored path id', { id: STORED, form: { targetingid: 'T\u0000T', initjs: 'x' } }],
  ])('save of %s answers invalidParameters and writes nothing', async (_label, c) => {
    const before = await writeCounts();
    const result = await run(ctx, 'save', { ...(c.id === undefined ? {} : { id: ids.first }), actor: CONTENT_EDITOR, form: c.form });
    expect(result).toEqual({ error: 'invalidParameters' });
    expect(await writeCounts()).toEqual(before);
    expect((wire(await run(ctx, 'findOne', { id: ids.first, actor: CONTENT_EDITOR }), 'findOne') as { data: Row }).data).toEqual(storedFirst());
  });

  it('save of an unpaired surrogate stores U+FFFD, as node-postgres encodes it', async () => {
    const result = await run(ctx, 'save', { actor: CONTENT_EDITOR, form: { contentid: HOME_ID, initjs: '\uD800x' } });
    expect(result.status).toBe(200);
    const id = String((wire(result, 'save') as { data: Row }).data['targetingid']);
    expect((wire(await run(ctx, 'findOne', { id, actor: CONTENT_EDITOR }), 'findOne') as { data: Row }).data['initjs']).toBe('\uFFFDx');
    expect(await run(ctx, 'delete', { id, actor: CONTENT_EDITOR })).toEqual({ data: '' });
  });

  it('save with saveErrors=true writes the invalid bean, which the char(35) column refuses, writing nothing', async () => {
    const before = await writeCounts();
    await expect(run(ctx, 'save', { actor: CONTENT_EDITOR, form: { contentid: X36, saveErrors: 'true' } })).rejects.toMatchObject({ code: '22001' });
    expect(await writeCounts()).toEqual(before);
  });
});

/** The id key findMany matched in memory before its ids reached SQL: trailing spaces dropped, then lower-cased. */
const memoryKey = (id: string): string => id.replace(/ +$/u, '').toLowerCase();

const KELVIN_ID = '\u212Aelvin-04';
const DOTTED_ID = '\u0130d-05';
const SIGMA_ID = '\u039F\u0394\u039F\u03A3-06';
const UPPER_ID = '0000000A-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const LOWER_ID = '0000000b-aaaa-bbbb-ccccddddeeeeffff';

/** A stored targeting row in column order. */
const targeting = (targetingid: string, contentid: string | null, siteid: string | null, initjs: string | null, targetingjs: string | null): Row => ({
  targetingid,
  siteid,
  initjs,
  targetingjs,
  contentid,
});

// Case and trailing-space variants, NULLs, an empty id, astral text in two columns, and ids outside ASCII that
// String.prototype.toLowerCase and PostgreSQL's lower() fold differently.
const TENANT_A_ROWS: Row[] = [
  targeting(UPPER_ID, HOME_ID, SITE, 'init();', '[1]'),
  targeting(LOWER_ID, 'ABC', SITE, null, null),
  targeting('MiXeD-03', null, 'other-site', '  padded  ', 'x_y'),
  targeting(KELVIN_ID, 'ABC', SITE, 'a\u{1F600}b', 'k'),
  targeting(DOTTED_ID, 'abc', 'TENANT-A', '\u00C1LICE', null),
  targeting(SIGMA_ID, HOME_ID, SITE, 'alice', 'x%y'),
  targeting('', null, null, null, null),
  targeting('trail-08 ', 'ABC ', SITE, 'Init();', '[2]'),
  targeting('KELVIN-04', HOME_ID, `${SITE} `, 'init();', ''),
  targeting('zz-10', 'ABC', SITE, 'b', 'a\u{1F600}b'),
];
const TENANT_B_ROWS: Row[] = [targeting(UPPER_ID, 'B', SITE, 'tenant-b', null), targeting('bb-only', 'B', SITE, 'tenant-b', null)];

/** A findQuery or findAll request: its query string and, where it differs, the URL scope dispatch leaves. */
type FeedCase = [method: 'findQuery' | 'findAll', raw: string, url?: Row];

const FEED_CASES: FeedCase[] = [
  ...[
    '', 'contentid=ABC', 'contentid=abc', 'contentid=ABC%20', 'contentid=null', 'contentid=neq%5Enull', 'initjs=null', 'initjs=*it*',
    'initjs=like%5Ei_it%25', 'initjs=like%5E%5Bai%5D%25', 'targetingjs=like%5Ex_y', 'siteid=like%5Eother_site', 'siteid=in%5Etenant-a%2Cother-site',
    'siteid=notin%5Eother-site', 'siteid=TENANT-A', 'initjs=%C3%A1lice', 'initjs=alice', 'initjs=a%00', 'targetingid=gt%5Em',
    `targetingid=lt%5E${LOWER_ID}`, `id=${LOWER_ID.toUpperCase()}`, 'targetingid=kelvin-04', 'targetingid=', 'contentid=ABC&or&initjs=null',
    'openGrouping&contentid=ABC&or&siteid=other-site&closeGrouping&targetingjs=null', 'sort=contentid', 'sort=-contentid',
    'sort=-initjs%2Ctargetingid', 'sort=targetingjs', 'sortBy=siteid&sortDirection=desc', 'sort=siteid%2C-contentid', 'orderby=-targetingid',
    'itemsPerPage=2&pageIndex=2', 'itemsPerPage=3&pageIndex=3', 'itemsPerPage=4&pageIndex=99', 'startIndex=4&itemsPerPage=2',
    'nextn=3&pageIndex=2', 'maxitems=3', 'maxitems=3&itemsPerPage=2&pageIndex=2', 'maxitems=*', 'itemsPerPage=*', 'offset=1',
    'countOnly=true', 'countOnly=true&contentid=ABC', 'countOnly=1&maxitems=1', 'countOnly=true&initjs=like%5Ei_it%25',
    'fields=initjs%2Ccontentid', 'fields=initjs&sort=-initjs', 'fields=nosuch', 'contentid=ABC&sort=-targetingid&itemsPerPage=2&pageIndex=2',
    'sort=nope', 'isnew=1', 'addObjects=1', 'groupBy=siteid', 'innerJoin=content',
  ].map((raw): FeedCase => ['findQuery', raw]),
  ['findQuery', 'initjs=x', { initjs: '\uD800' }],
  ...['', 'sort=-contentid&itemsPerPage=2&pageIndex=2', 'countOnly=true', 'maxitems=2', 'contentid=ABC', 'fields=targetingjs'].map(
    (raw): FeedCase => ['findAll', raw],
  ),
];

const MANY_IDS: string[][] = [
  [LOWER_ID.toUpperCase(), ABSENT_ID, 'mixed-03'],
  [UPPER_ID, UPPER_ID.toLowerCase(), `${UPPER_ID}   `, UPPER_ID],
  ['kelvin-04'],
  ['\u212AELVIN-04'],
  ['i\u0307d-05'],
  ['\u0130D-05'],
  ['id-05'],
  ['\u03BF\u03B4\u03BF\u03C2-06'],
  ['\u03BF\u03B4\u03BF\u03C3-06'],
  [`${SIGMA_ID}  `],
  ['', ' '],
  ['TRAIL-08'],
  ['a\u0000'],
  ['\uD800', 'zz-10'],
  ['bb-only'],
  [],
];
const MANY_URLS: string[] = ['', 'sort=-contentid', 'sort=targetingid', 'countOnly=true', 'itemsPerPage=1&pageIndex=2', 'fields=initjs', 'maxitems=1', 'sort=nope'];

describe.skipIf(!(await pgAvailable()))('feeds read in SQL against the in-memory feed over every tenant row', () => {
  let schema: ThrowawaySchema;
  let dropSchema: (() => Promise<void>) | undefined;
  let feedDeps: DomainDeps;
  const statements: { sql: string; rows: number }[] = [];

  /** `tx` recording each statement it runs and the rows it returned. */
  function recordingTx(tx: TenantTx): TenantTx {
    return {
      kind: tx.kind,
      tenantId: tx.tenantId,
      schema: tx.schema,
      onCommit: (cb, onError) => {
        tx.onCommit(cb, onError);
      },
      query: (async (text: string | QueryConfig, values?: unknown[]) => {
        const result = await tx.query(text, values);
        statements.push({ sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
        return result;
      }) as TenantTx['query'],
    };
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    const created = schema;
    dropSchema = () => created.drop();
    await ensureUnitGates(schema.app, CONTENT_UNITS);
    await closeGates(schema.app, { units: CONTENT_UNITS, holderId: 'jsonapi-variation-feed-test', allowLegacy: true });
    await openGates(schema.app, { units: CONTENT_UNITS, holderId: 'jsonapi-variation-feed-test', state: 'open' });
    for (const [tenantId, rows] of [
      [TENANT_A.tenantId, TENANT_A_ROWS],
      [TENANT_B.tenantId, TENANT_B_ROWS],
    ] as const) {
      await withTenant(schema.app, tenantId, async (tx) => {
        for (const row of rows) {
          await tx.query(
            `INSERT INTO ${schema.schema}.variation_targeting (tenant_id, targetingid, siteid, initjs, targetingjs, contentid) VALUES ($1, $2, $3, $4, $5, $6)`,
            [tx.tenantId, ...Object.values(row)],
          );
        }
      });
    }
    const db = schema.app;
    const recording: TenantDb = {
      schema: db.schema,
      withTenant: (tenantId, fn, options) => db.withTenant(tenantId, (tx) => fn(recordingTx(tx)), options),
      withMetadata: (fn, options) => db.withMetadata(fn, options),
      end: () => db.end(),
    };
    const clock = fixedClock(new Date(2026, 5, 30, 10, 15, 42));
    feedDeps = {
      db: recording,
      repository: createContentRepository({ clock, schema: schema.schema }),
      clock,
      config: { ...CONTENT_CONFIG_DEFAULTS, variations: true },
    };
  });

  afterAll(async () => {
    await dropSchema?.();
  });

  /** The rows the handlers read whole before: every targeting row of the tenant without its tenant column. */
  async function memoryRows(): Promise<Row[]> {
    const rows = await withTenant(schema.app, TENANT_A.tenantId, (tx) => feedDeps.repository.variation.targetingsOfTenant(tx));
    return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'tenant_id')));
  }

  /** The handlers over the in-memory feed of `rows`, as they read before. */
  function inMemory(rows: Row[]): RouteContext {
    const repository = { ...feedDeps.repository, beanFeed: { source: () => rowsSource(rows) } } as unknown as ContentRepository;
    return contextOf({ ...feedDeps, repository });
  }

  /** The wire body of one handler call, or the error it raised. */
  async function outcome(context: RouteContext, method: Method, o: Omit<CallOptions, 'method'>): Promise<unknown> {
    try {
      return wire(await run(context, method, { ...o, actor: CONTENT_EDITOR }), method);
    } catch (err) {
      const error = err as Error & { type?: unknown };
      return { error: error.constructor.name, message: error.message, type: error.type };
    }
  }

  /** findMany of `ids` over SQL and over the in-memory feed of the rows the handler kept before. */
  async function compareMany(ids: string[], raw: string): Promise<unknown> {
    const wanted = new Set(ids.map(memoryKey));
    const kept = (await memoryRows()).filter((row) => wanted.has(memoryKey(String(row['targetingid']))));
    const expected = await outcome(inMemory(kept), 'findMany', { ids, raw });
    expect(await outcome(contextOf(feedDeps), 'findMany', { ids, raw })).toEqual(expected);
    return expected;
  }

  /** The kind of each variation_targeting statement recorded since `statements` was emptied. */
  const shapes = (): string[] =>
    statements
      .filter((s) => s.sql.includes('variation_targeting'))
      .map((s) => (s.sql.includes('LIMIT') ? 'page' : s.sql.includes('count(*)') ? 'count' : s.sql.includes('targetingid::text ~') ? 'ids' : 'other'));

  it('holds the rows the handlers read before, column for column and in their order', async () => {
    const rows = await withVariationTargetingFeed(feedDeps, CONTENT_EDITOR, {}, (source) => scopeRows(source));
    const before = await memoryRows();
    expect(rows).toEqual(before);
    expect(rows.map((row) => Object.keys(row))).toEqual(before.map((row) => Object.keys(row)));
    expect(rows).toHaveLength(TENANT_A_ROWS.length);
  });

  it.each(FEED_CASES)('%s %s %j answers what the in-memory feed answers', async (method, raw, url) => {
    const o = url === undefined ? { raw } : { raw, url };
    const expected = await outcome(inMemory(await memoryRows()), method, o);
    expect(await outcome(contextOf(feedDeps), method, o)).toEqual(expected);
  });

  it.each(MANY_IDS.flatMap((ids) => MANY_URLS.map((raw): [string[], string] => [ids, raw])))(
    'findMany of %j with %s answers what the in-memory feed answers',
    async (ids, raw) => {
      await compareMany(ids, raw);
    },
  );

  it('selects the rows the in-memory feed selects, so the comparison exercises the data', async () => {
    const itemIds = (body: unknown): unknown => ((body as { data: { items?: Row[] } }).data.items ?? []).map((item) => item['id']);
    expect(itemIds(await compareMany(['kelvin-04'], 'sort=targetingid'))).toEqual(expect.arrayContaining(['KELVIN-04', KELVIN_ID]));
    expect(itemIds(await compareMany(['kelvin-04'], 'sort=targetingid'))).toHaveLength(2);
    expect(itemIds(await compareMany(['\u03BF\u03B4\u03BF\u03C2-06'], ''))).toEqual([SIGMA_ID]);
    expect(itemIds(await compareMany(['\u03BF\u03B4\u03BF\u03C3-06'], ''))).toEqual([]);
    expect(itemIds(await compareMany(['\u0130D-05', 'TRAIL-08', ''], ''))).toEqual([DOTTED_ID, 'trail-08', '']);
    expect(itemIds(await compareMany(['bb-only', UPPER_ID], ''))).toEqual([UPPER_ID]);
    const query = await outcome(contextOf(feedDeps), 'findQuery', { raw: 'initjs=like%5Ei_it%25&sort=targetingid' });
    expect(itemIds(query)).toEqual([UPPER_ID, 'KELVIN-04', 'trail-08']);
  });

  it('reads one count and one page holding only the page rows', async () => {
    statements.length = 0;
    await outcome(contextOf(feedDeps), 'findQuery', { raw: 'contentid=neq%5Enull&sort=-targetingid&itemsPerPage=2&pageIndex=2' });
    expect(shapes()).toEqual(['count', 'page']);
    expect(statements.filter((s) => s.sql.includes('variation_targeting')).map((s) => s.rows)).toEqual([1, 2]);

    statements.length = 0;
    await outcome(contextOf(feedDeps), 'findMany', { ids: [UPPER_ID, LOWER_ID, 'zz-10'], raw: 'itemsPerPage=1&pageIndex=2' });
    expect(shapes()).toEqual(['count', 'page']);
    expect(statements.filter((s) => s.sql.includes('variation_targeting')).map((s) => s.rows)).toEqual([1, 1]);

    statements.length = 0;
    await outcome(contextOf(feedDeps), 'findAll', { raw: 'countOnly=true' });
    expect(shapes()).toEqual(['count']);
  });

  it('reads the stored ids outside ASCII only for a findMany id outside ASCII', async () => {
    statements.length = 0;
    await outcome(contextOf(feedDeps), 'findMany', { ids: ['\u0130D-05', 'zz-10'], raw: '' });
    expect(shapes()).toEqual(['ids', 'count', 'page']);
    expect(statements.find((s) => s.sql.includes('targetingid::text ~'))?.rows).toBe(3);
  });
});
