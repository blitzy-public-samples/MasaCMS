/** The ccategory admin routes of `routes/v1/ccategory.ts` through `app.inject` over a throwaway `content` schema and an identity CSRF double. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, moduleRole } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { WRITE_POSITION_HEADER_LC, closeGates, ensureUnitGates, openGates, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  CSRF_CONSUME_PATH,
  createService,
  fixedClock,
  loadEnv,
  type CsrfConsumeRequest,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
} from '@opt2/platform/service-kit';
import { withTenant } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createCategory, type CategoryBean } from '../../src/domain/categories.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor } from '../../src/domain/context.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS, type CategoryRow } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { registerCategoryRoutes } from '../../src/routes/v1/ccategory.js';

const SERVICE = 'strategies-content';
const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const OPENAPI = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const SITE = TENANT_A.siteId;
const POOL = TENANT_UMBRELLA.siteId;
const UMBRELLA = TENANT_UMBRELLA.tenantId;
const USER = 'C1D2E3F4-0001-4A5B-8C7D9E0F1A2B3C4D';
const m = (digits: string): string => moduleRole(`00000000000000000000000000000000${digits}`);
const NAME_ERROR = { name: "The property named 'name' is not valid" };
const LIST = '/v1/sites/tenant-a/categories';
const CSRF = { csrf_token: 'TOKEN', csrf_token_expires: '260630110000000' } as const;

/** tenant-a's site Admin: category pool `umbrella`, public user pool `umbrella`, private user pool its own. */
const A: Actor = actorFromClaims(
  { iss: 'opt2-local-identity', aud: 'opt2-local', sub: USER, sid: 's1', tid: TENANT_A.tenantId, site: SITE, roles: [Roles.siteAdmin], s2: false, epoch: 0, iat: 0, exp: 0 },
  'Admin User',
);

/** The contract operations mapped to ccategory actions, in the registered form. */
const CONTRACT_ROUTES = Object.entries(OPENAPI.paths)
  .flatMap(([path, item]) => Object.entries(item).map(([method, op]) => ({ path, method, op })))
  .filter(({ op }) => ((op['x-opt2-legacy-actions'] as string[] | undefined) ?? []).some((action) => action.startsWith('ccategory.')))
  .map(({ path, method, op }) => ({
    method: method.toUpperCase(),
    url: path.replace(/\{(\w+)\}/g, ':$1'),
    transport: op['x-opt2-transport'],
    requires: [...(op['x-opt2-requires'] as string[])].sort(),
  }))
  .sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));

describe.skipIf(!(await pgAvailable()))('ccategory admin routes', () => {
  let handle: ThrowawaySchema;
  let repo: ContentRepository;
  let app: FastifyInstance;
  let csrfValid = true;
  const consumed: CsrfConsumeRequest[] = [];
  let alpha: CategoryBean;
  let beta: CategoryBean;
  let child: CategoryBean;
  const [publicGroup, privateGroup] = ['G0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF', 'G0000002-AAAA-BBBB-CCCCDDDDEEEEFFFF'];

  /** The `content.category` row of `categoryId` as tenant `tenantId` sees it. */
  const stored = (tenantId: string, categoryId: string): Promise<CategoryRow | undefined> =>
    withTenant(handle.app, tenantId, async (tx) => (await tx.query<CategoryRow>(`SELECT * FROM ${handle.schema}.category WHERE categoryid = $1`, [categoryId])).rows[0]);

  /** Changelog rows of the umbrella and tenant-a tenants. */
  const changelogCount = async (): Promise<number> => {
    let total = 0;
    for (const tenantId of [UMBRELLA, TENANT_A.tenantId]) {
      total += await withTenant(handle.app, tenantId, async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.changelog`)).rows[0]?.n ?? 0);
    }
    return total;
  };

  /** A user token of `site` with `roles` and the gateway's invocation credential. */
  const headersFor = async (roles: readonly string[], site = SITE): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await mintUserToken({ sub: USER, site, roles: [...roles] })}`,
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
  });

  /** Sends a request and asserts its answer against the contract when `contract` holds. */
  const send = async (
    method: 'GET' | 'POST',
    url: string,
    opts: { roles?: readonly string[]; site?: string; form?: Record<string, string>; contract?: boolean } = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(await headersFor(opts.roles ?? [Roles.siteAdmin], opts.site)), ...(opts.form === undefined ? {} : FORM) },
      ...(opts.form === undefined ? {} : { payload: new URLSearchParams(opts.form).toString() }),
    });
    if (opts.contract !== false) {
      assertResponseMatchesOpenApi(OPENAPI, { method, path: url.split('?')[0] ?? url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    }
    return res;
  };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, schemaName: 'content', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'ccategory-routes-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'ccategory-routes-test', state: 'open' });
    await seedRegistry(handle.app);
    repo = createContentRepository({ clock: CLOCK, schema: handle.schema });
    const domain = { db: handle.app, repository: repo, clock: CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    beta = await createCategory(domain, A, { siteid: POOL, name: 'Beta Topic' });
    alpha = await createCategory(domain, A, { siteid: POOL, name: 'Alpha Topic' });
    child = await createCategory(domain, A, { siteid: POOL, name: 'Child Topic', parentid: beta.categoryid });
    await withTenant(handle.app, UMBRELLA, (tx) => repo.projections.upsertGroupProjection(tx, { groupId: publicGroup, siteId: POOL, groupName: 'Members', isPublic: 1, deleted: false }));
    await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      repo.projections.upsertGroupProjection(tx, { groupId: privateGroup, siteId: SITE, groupName: 'Editors', isPublic: 0, deleted: false }),
    );

    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8114',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      clock: CLOCK,
      verifierOverride: testVerifier(SERVICE),
      pool: handle.app,
      logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
    });
    registerWritePositionHeader(app);
    const ctx = {
      domain,
      clock: CLOCK,
      actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Admin User'),
    } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;
    await registerCategoryRoutes(app, ctx);
    await app.ready();
    // Identity's CSRF consume, which adminCsrf calls through the app's service client.
    const request = async (req: ServiceRequest) => {
      if (req.service !== 'identity' || req.path !== CSRF_CONSUME_PATH) throw new Error(`unexpected call ${req.service} ${req.path}`);
      consumed.push(req.json as CsrfConsumeRequest);
      return { status: 200, headers: {}, body: { valid: csrfValid } };
    };
    Object.defineProperty(app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.drop();
  });

  beforeEach(() => {
    consumed.length = 0;
    csrfValid = true;
  });

  const node = (bean: CategoryBean, hasKids: number, children: unknown[] = []) => ({
    categoryID: bean.categoryid,
    parentID: bean.parentid,
    name: bean.name,
    hasKids,
    isOpen: 1,
    isInterestGroup: 1,
    isActive: 1,
    restrictGroups: '',
    children,
  });

  it('registers exactly the contract ccategory operations with their transport and roles', () => {
    const routes = collectRouteMatrix(app)
      .routes.filter((route) => route.url.startsWith('/v1/'))
      .map((route) => ({ method: route.method, url: route.url, transport: route.transport, requires: [...(route.requires ?? [])].sort() }))
      .sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
    expect(CONTRACT_ROUTES).toHaveLength(3);
    expect(routes).toEqual(CONTRACT_ROUTES);
  });

  it('lists the category pool tree level by level in name order', async () => {
    const res = await send('GET', LIST);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rc: { categories: [node(alpha, 0), node(beta, 1, [node(child, 0)])] } });
  });

  it('reads the edit model of a pooled category with the restrict groups and the tree', async () => {
    const res = await send('GET', `${LIST}/${child.categoryid}`);
    expect(res.statusCode).toBe(200);
    const { rc } = res.json<{ rc: Record<string, unknown> }>();
    expect(rc.categoryBean).toMatchObject({ categoryid: child.categoryid, siteid: POOL, name: 'Child Topic', parentid: beta.categoryid, errors: {} });
    expect(rc.rsRestrictGroups).toEqual([
      { userID: publicGroup, groupName: 'Members', isPublic: 1 },
      { userID: privateGroup, groupName: 'Editors', isPublic: 0 },
    ]);
    expect(rc.categories).toEqual([node(alpha, 0), node(beta, 1, [node(child, 0)])]);
  });

  it('reads the new bean for an id that matches no category', async () => {
    const res = await send('GET', `${LIST}/F0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ rc: { categoryBean: Record<string, unknown> } }>().rc.categoryBean).toMatchObject({ categoryid: '', name: '', isnew: 1 });
  });

  it('updates a pooled category in the umbrella tenant after consuming the token, then redirects to the list with siteid', async () => {
    const res = await send('POST', LIST, { form: { action: 'update', categoryID: alpha.categoryid, name: 'Alpha Renamed', isActive: '1', isInterestGroup: '1', ...CSRF } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: true, errors: {}, redirect: { circuit: 'cCategory', action: 'list', params: [['siteid', SITE]] } });
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBeDefined();
    expect(consumed).toEqual([expect.objectContaining({ token: 'TOKEN', expires: CSRF.csrf_token_expires, context: alpha.categoryid })]);
    expect((await stored(UMBRELLA, alpha.categoryid))?.name).toBe('Alpha Renamed');
  });

  it('re-renders an add whose bean has errors with the edit model and writes nothing', async () => {
    const before = await changelogCount();
    const res = await send('POST', LIST, { form: { action: 'add', categoryID: '', name: '', ...CSRF } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ saved: boolean; errors: unknown; redirect: unknown; data: { rc: Record<string, unknown> } }>();
    expect([body.saved, body.errors, body.redirect]).toEqual([false, NAME_ERROR, null]);
    expect(body.data.rc.categoryBean).toMatchObject({ categoryid: '', siteid: SITE, errors: NAME_ERROR });
    expect(body.data.rc.rsRestrictGroups).toHaveLength(2);
    expect(body.data.rc.categories).toHaveLength(2);
    expect(await changelogCount()).toBe(before);
  });

  it.each([
    ['update', { action: 'update', categoryID: '', name: 'Never' }],
    ['add', { action: 'Add', categoryID: '', name: 'Never Added' }],
  ])('answers a refused token on %s with a model without categoryBean and writes nothing', async (_label, form) => {
    csrfValid = false;
    const before = await changelogCount();
    const res = await send('POST', LIST, { form: { ...form, ...CSRF } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: false, errors: {}, redirect: null, data: { rc: {} } });
    expect(consumed).toHaveLength(1);
    expect(await changelogCount()).toBe(before);
  });

  it('skips a delete with a refused token and still redirects to the list', async () => {
    csrfValid = false;
    const res = await send('POST', LIST, { form: { action: 'delete', categoryid: child.categoryid, ...CSRF } });
    expect(res.json()).toEqual({ saved: false, errors: {}, redirect: { circuit: 'cCategory', action: 'list', params: [['siteid', SITE]] } });
    expect((await stored(UMBRELLA, child.categoryid))?.name).toBe('Child Topic');
  });

  it('fails a save without categoryid before consuming the token, as legacy dereferences it', async () => {
    const res = await send('POST', LIST, { form: { action: 'add', name: 'No Id', ...CSRF }, contract: false });
    expect(res.statusCode).toBe(500);
    expect(consumed).toEqual([]);
  });

  it.each([
    ['GET', LIST],
    ['GET', `${LIST}/F0000003-AAAA-BBBB-CCCCDDDDEEEEFFFF`],
    ['POST', LIST],
  ] as const)('%s %s denies Categories without Site Manager and admits both module grants', async (method, url) => {
    const form = method === 'POST' ? { action: 'delete', categoryid: 'F0000002-AAAA-BBBB-CCCCDDDDEEEEFFFF', ...CSRF } : undefined;
    const denied = await send(method, url, { roles: [m('010')], ...(form === undefined ? {} : { form }) });
    expect(denied.statusCode).toBe(403);
    expect(consumed).toEqual([]);
    expect((await send(method, url, { roles: [m('010'), m('000')], ...(form === undefined ? {} : { form }) })).statusCode).toBe(200);
  });

  it.each([
    ['a site Admin of another site', [Roles.siteAdmin], TENANT_B.siteId],
    ['Site Manager alone', [m('000')], SITE],
  ] as const)('refuses %s', async (_label, roles, site) => {
    expect((await send('GET', LIST, { roles, site })).statusCode).toBe(403);
  });
});
