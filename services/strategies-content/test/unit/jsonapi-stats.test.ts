/** JSON API `stats` handlers over a throwaway content schema, against what the Masa 7.6.1 oracle on ACF 2023 answers (site default). */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, UndefinedLegacyMethodError, type Actor } from '../../src/domain/context.js';
import { STATS_DEFAULTS, saveStatsInTx } from '../../src/domain/stats.js';
import type { JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { statsHandler } from '../../src/routes/jsonapi/stats.js';
import { createJsonApiParams, type JsonApiCall, type JsonApiHandlerFn } from '../../src/routes/jsonapi/types.js';

type Row = Record<string, unknown>;
type Method = 'findOne' | 'findMany' | 'findAll' | 'findNew' | 'findQuery' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

const SITE = TENANT_A.siteId;
const ENDPOINT = `http://localhost:8080/index.cfm/_api/json/v1/${SITE}`;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);
const cfId = (n: number): string => `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const NO_ROW_ID = cfId(90);

const actor = (overrides: Partial<Actor> = {}): Actor => ({
  userId: '',
  fullName: '',
  isLoggedIn: false,
  s2: false,
  roles: [],
  siteId: '',
  tenantId: '',
  ...overrides,
});
const ANONYMOUS = actor();
const CONTENT_MODULE_USER = actor({ userId: 'U1', isLoggedIn: true, roles: ['system-user', 'm:000'], siteId: SITE, tenantId: TENANT_A.tenantId });
const OTHER_MODULE_USER = actor({ userId: 'U2', isLoggedIn: true, roles: ['system-user', 'm:015'], siteId: SITE, tenantId: TENANT_A.tenantId });

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

interface CallInput {
  method: Method;
  raw?: string;
  actor?: Actor;
  id?: string;
  ids?: string[];
  tenantId?: string;
  csrf?: boolean;
}

/** The call ../jsonapi.ts would hand the handler, with its CSRF validations counted. */
function callFor(a: CallInput): JsonApiCall & { csrfChecks: number } {
  const raw = a.raw ?? '';
  const url = urlScope(raw);
  const who = a.actor ?? CONTENT_MODULE_USER;
  const apiContext = {
    siteId: SITE,
    mode: 'json',
    endpoint: ENDPOINT,
    url,
    form: {},
    method: a.method,
    isAggregateQuery: false,
    user: { loggedIn: who.isLoggedIn, systemUser: who.roles.includes('system-user') },
    allowAction: () => false,
    customImageSizes: [],
  } as unknown as JsonApiRequestContext;
  const call = {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:stats.${a.method.toLowerCase()}`,
    method: a.method,
    entityName: 'stats',
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.ids === undefined ? {} : { ids: a.ids }),
    pathInfo: [SITE, 'stats'],
    params: createJsonApiParams(Object.entries(url)),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: SITE,
    tenantId: a.tenantId ?? TENANT_A.tenantId,
    actor: who,
    site: {} as JsonApiCall['site'],
    apiContext,
    httpMethod: a.method === 'save' ? 'POST' : a.method === 'delete' ? 'DELETE' : 'GET',
    headers: {},
    csrfChecks: 0,
    validateCsrf(): Promise<boolean> {
      call.csrfChecks += 1;
      return Promise.resolve(a.csrf ?? true);
    },
  } satisfies JsonApiCall & { csrfChecks: number };
  return call;
}

let handle: ThrowawaySchema;
let repo: ContentRepository;
let ctx: ContentRouteContext;

const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => withTenant(handle.app, tenantId, fn);

/** The handler of `method`, which `statsHandler` must define. */
function handlerOf(method: Method): JsonApiHandlerFn {
  const fn = statsHandler[method];
  if (fn === undefined) throw new Error(`statsHandler has no ${method}`);
  return fn;
}

const run = (input: CallInput): ReturnType<JsonApiHandlerFn> => handlerOf(input.method)(ctx, callFor(input));

/** The stats rows and changelog rows of tenant A, to show a call wrote nothing. */
async function writesOfA(): Promise<{ stats: number; changes: number }> {
  return inTenant(TENANT_A.tenantId, async (tx) => {
    const count = async (table: string): Promise<number> =>
      (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.${table}`)).rows[0]?.n ?? -1;
    return { stats: await count('content_stats'), changes: await count('changelog') };
  });
}

/** The `id`s of a collection's items. */
function itemIds(data: unknown): unknown[] {
  return ((data as { items: Row[] }).items ?? []).map((item) => item['id']);
}

describe.skipIf(!(await pgAvailable()))('JSON API stats handlers', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-stats-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-stats-test', state: 'open' });
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    ctx = {
      domain: { db: handle.app, repository: repo, clock: fixedClock(NOW), config: CONTENT_CONFIG_DEFAULTS },
    } as unknown as ContentRouteContext;
    const stats = { ...STATS_DEFAULTS, siteID: SITE };
    await inTenant(TENANT_A.tenantId, async (tx) => {
      await saveStatsInTx(tx, repo, { ...stats, contentID: cfId(3), views: 7, rating: 4.5, lockID: 'U9', lockType: 'node' });
      await saveStatsInTx(tx, repo, { ...stats, contentID: cfId(1), views: 3 });
      await saveStatsInTx(tx, repo, { ...stats, contentID: cfId(2), views: 3, comments: 2 });
      await saveStatsInTx(tx, repo, { ...stats, contentID: cfId(4), siteID: 'other-site', views: 3 });
    });
    await inTenant(TENANT_B.tenantId, (tx) => saveStatsInTx(tx, repo, { ...stats, contentID: cfId(5), siteID: SITE, views: 3 }));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each<Method>(['findOne', 'findAll', 'findQuery', 'findMany'])('%s answers authorization without the content module', async (method) => {
    for (const who of [ANONYMOUS, OTHER_MODULE_USER]) {
      expect(await run({ method, actor: who, id: cfId(1), ids: [cfId(1)], raw: 'views=3' })).toEqual({ error: 'authorization' });
    }
  });

  it('findOne of an item without a stats row answers the bean defaults and writes nothing', async () => {
    const before = await writesOfA();
    const result = await run({ method: 'findOne', id: NO_ROW_ID });
    expect(result).toMatchObject({ status: 200, serializerEntity: 'stats' });
    expect(result.data).toEqual({
      contentID: NO_ROW_ID,
      siteID: SITE,
      views: 0,
      rating: 0,
      totalVotes: 0,
      upVotes: 0,
      downVotes: 0,
      comments: 0,
      disableComments: 0,
      majorVersion: 0,
      minorVersion: 0,
      lockID: '',
      lockType: '',
      id: NO_ROW_ID,
      links: {
        entities: ENDPOINT,
        all: `${ENDPOINT}/stats`,
        properties: `${ENDPOINT}/stats/properties`,
        self: `${ENDPOINT}/stats/${NO_ROW_ID}`,
        permissions: `${ENDPOINT}/stats/${NO_ROW_ID}/permissions`,
        content: `${ENDPOINT}/content/${NO_ROW_ID}`,
        site: `${ENDPOINT}/site`,
      },
      entityname: 'stats',
    });
    expect(await writesOfA()).toEqual(before);
  });

  it('findOne of an item with a stats row answers its values as a loaded bean', async () => {
    const result = await run({ method: 'findOne', id: cfId(3) });
    expect(result.data).toMatchObject({ contentID: cfId(3), views: 7, rating: 4.5, lockID: 'U9', lockType: 'node', isNew: 0, id: cfId(3) });
  });

  it('findAll pages the site rows of the tenant in clustered key order', async () => {
    const call = callFor({ method: 'findAll' });
    const result = await handlerOf('findAll')(ctx, call);
    expect(itemIds(result.data)).toEqual([cfId(1), cfId(2), cfId(3)]);
    expect(result.data).toMatchObject({ totalItems: 3, entityname: 'stats', items: [{ isNew: 0, entityname: 'stats' }, {}, {}] });
    expect(call.apiContext.url).toMatchObject({ entityname: 'stats' });
  });

  it.each<[string, Method, string, Partial<CallInput>, unknown]>([
    ['filters by a stats column', 'findQuery', 'views=3', {}, [cfId(1), cfId(2)]],
    ['ignores a name the bean holds no value for', 'findQuery', 'isnew=0&content=x', {}, [cfId(1), cfId(2), cfId(3)]],
    ['sorts by the URL sort', 'findQuery', 'sort=-views', {}, [cfId(3), cfId(1), cfId(2)]],
    ['keeps the ids order', 'findMany', '', { ids: [cfId(3), cfId(9), cfId(1)] }, [cfId(3), cfId(1)]],
    ['repeats a repeated id', 'findMany', '', { ids: [cfId(2), cfId(2)] }, [cfId(2), cfId(2)]],
    ['keeps the feed order when the URL sorts', 'findMany', 'sort=-comments', { ids: [cfId(1), cfId(2)] }, [cfId(2), cfId(1)]],
    ['ignores countOnly', 'findMany', 'countOnly=true', { ids: [cfId(1)] }, [cfId(1)]],
  ])('%s (%s %s)', async (_label, method, raw, extra, expected) => {
    expect(itemIds((await run({ method, raw, ...extra })).data)).toEqual(expected);
  });

  it.each<[Method, string, number]>([
    ['findAll', 'countOnly=true', 3],
    ['findQuery', 'views=3&countOnly=true', 2],
  ])('%s with %s answers the count', async (method, raw, count) => {
    expect((await run({ method, raw })).data).toEqual({ count });
  });

  it('findQuery links its pages from the query string', async () => {
    const data = (await run({ method: 'findQuery', raw: 'views=3' })).data as { links: Row };
    expect(data.links['self']).toBe(`${ENDPOINT}/stats/?views=3&pageIndex=1`);
  });

  it.each<[string, Actor, boolean]>([
    ['anonymous', ANONYMOUS, false],
    ['a content module user', CONTENT_MODULE_USER, true],
  ])('findPermissions for %s answers without an access check', async (_label, who, allowed) => {
    expect((await run({ method: 'findPermissions', actor: who, id: 'permissions' })).data).toEqual({ read: allowed, delete: allowed, save: allowed });
  });

  it('findProperties answers anonymous callers', async () => {
    expect((await run({ method: 'findProperties', actor: ANONYMOUS })).data).toMatchObject({ displayname: 'stats', primarykey: 'contentid' });
  });

  it.each<[Method, string, number]>([
    ['findNew', 'new', 0],
    ['delete', cfId(1), 0],
    ['findPermissions', cfId(1), 0],
    ['findPermissions', '00000000000000000000000000000000001', 0],
    ['save', 'new', 1],
  ])('%s %s fails on the missing loadBy and writes nothing', async (method, id, csrfChecks) => {
    const before = await writesOfA();
    const call = callFor({ method, id, actor: ANONYMOUS, raw: 'views=99' });
    await expect(handlerOf(method)(ctx, call)).rejects.toThrow(UndefinedLegacyMethodError);
    expect(call.csrfChecks).toBe(csrfChecks);
    expect(await writesOfA()).toEqual(before);
  });

  it('save with failing CSRF tokens answers invalidTokens', async () => {
    expect(await run({ method: 'save', id: cfId(1), csrf: false })).toEqual({ error: 'invalidTokens' });
  });
});
