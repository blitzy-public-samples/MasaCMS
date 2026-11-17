// JSON API `category` and `contentCategoryAssign` handlers over a throwaway `content` schema with tenant-a, tenant-b and
// umbrella registered. Expected shapes follow what Masa 7.6.1 on ACF 2023 answers for the same calls.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { buildEnvelope, isCfUuid, LegacyApiError, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type TenantDb, type TenantTx, type TransactionCallOptions } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  createCategory,
  listPoolCategories,
  readCategory,
  setCategoryAssignments,
  type CategoryBean,
} from '../../src/domain/categories.js';
import {
  actorFromClaims,
  CONTENT_CONFIG_DEFAULTS,
  type Actor,
  type DomainDeps,
  type SiteContentSettings,
} from '../../src/domain/context.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { FeedRunner, FeedTableSpec } from '../../src/repo/bean-feed-sql.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { categoryHandler, contentCategoryAssignHandler } from '../../src/routes/jsonapi/category.js';
import {
  createJsonApiParams,
  rowsSource,
  type BeanFeedSource,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiResult,
} from '../../src/routes/jsonapi/types.js';

type Struct = Record<string, unknown>;
type CategoryRow = Awaited<ReturnType<ContentRepository['categories']['categoriesBySite']>>[number];
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

const clock = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 456));
const PORT = 8080;
const POOL = TENANT_UMBRELLA.siteId;
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const C1 = cfId('C', 1);
const H1 = cfId('H', 1);
const H2 = cfId('H', 2);

function actor(site: TenantFixture, roles: string[], sub = cfId('U', 1)): Actor {
  const claims: UserClaims = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub,
    sid: 'session-1',
    tid: site.tenantId,
    site: site.siteId,
    roles,
    s2: false,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
  return actorFromClaims(claims, 'Admin User');
}

const ANONYMOUS = actorFromClaims(undefined, '');
/** tenant-a's Categories module user: category pool `umbrella`, content pool `tenant-a`. */
const EDITOR_A = actor(TENANT_A, ['m:010']);
/** tenant-a's Site Manager module user. */
const MANAGER_A = actor(TENANT_A, ['m:000']);
/** tenant-b's Categories module user: every pool its own site. */
const EDITOR_B = actor(TENANT_B, ['m:010']);
/** tenant-a's site Admin, whose private pool is tenant-a. */
const SITE_ADMIN_A = actor(TENANT_A, ['site-admin']);
const S2_A = actor(TENANT_A, ['s2']);
/** A tenant-a user in the umbrella group holding the Categories module grant on umbrella. */
const POOL_EDITOR_A = actor(TENANT_A, ['system-user'], cfId('U', 2));
const POOL_EDITORS = cfId('G', 1);
const CATEGORIES_MODULE = '00000000000000000000000000000000010';

function urls(siteId: string): LegacySiteUrlConfig {
  return {
    siteId,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: `:${PORT}`,
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: siteId,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  };
}

function endpointOf(siteId: string): string {
  return jsonApiEndpoint({
    adminSSL: false,
    requestProtocol: 'http',
    serverName: 'localhost',
    serverPort: `:${PORT}`,
    context: '',
    mode: 'json',
    siteId,
  });
}

interface CallArgs {
  method: Op;
  entityName?: 'category' | 'contentCategoryAssign';
  site?: TenantFixture;
  actor?: Actor;
  id?: string;
  ids?: string[];
  url?: Struct;
  form?: Struct;
  csrf?: boolean;
}

/** A call as ../jsonapi.ts builds it, with a CSRF check that answers `csrf` (default true) and records its calls. */
function callFor(a: CallArgs): JsonApiCall & { validateCsrf: ReturnType<typeof vi.fn> } {
  const site = a.site ?? TENANT_A;
  const entityName = a.entityName ?? 'category';
  const url: Struct = { ...a.url };
  const form: Struct = { ...a.form };
  const raw = Object.entries(url)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const caller = a.actor ?? ANONYMOUS;
  const apiContext: JsonApiRequestContext = {
    siteId: site.siteId,
    mode: 'json',
    endpoint: endpointOf(site.siteId),
    url,
    form,
    method: a.method,
    isAggregateQuery: false,
    user: { loggedIn: caller.isLoggedIn, systemUser: caller.isLoggedIn },
    allowAction: () => caller.roles.length > 0,
    site: urls(site.siteId),
    customImageSizes: () => Promise.resolve([]),
  };
  const settings: SiteContentSettings = {
    siteId: site.siteId,
    site: site.siteId,
    locking: 'None',
    contentApprovalScript: '',
    contentRejectionScript: '',
    contentPendingScript: '',
    contentCanceledScript: '',
    contactEmail: '',
    urls: urls(site.siteId),
  };
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:${entityName}.${a.method.toLowerCase()}`,
    method: a.method,
    entityName,
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.ids === undefined ? {} : { ids: a.ids }),
    pathInfo: [site.siteId, entityName],
    params: createJsonApiParams(Object.entries({ ...url, ...form })),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: site.siteId,
    tenantId: site.tenantId,
    actor: caller,
    site: settings,
    apiContext,
    httpMethod: a.method === 'save' ? 'POST' : a.method === 'delete' ? 'DELETE' : 'GET',
    headers: {},
    validateCsrf: vi.fn(() => Promise.resolve(a.csrf ?? true)),
  };
}

let handle: ThrowawaySchema;
let deps: DomainDeps;

function ctx(): ContentRouteContext {
  return { domain: deps } as unknown as ContentRouteContext;
}

/** Runs `op` of `handler` for `call`. */
function invoke(handler: EntityHandler, op: Op, call: JsonApiCall): Promise<JsonApiResult> {
  const fn = handler[op];
  if (fn === undefined) throw new Error(`${handler.entity} has no ${op}`);
  return fn(ctx(), call);
}

/** Runs `op` of the category handler for a call built from `a`. */
function onCategory(op: Op, a: Omit<CallArgs, 'method' | 'entityName'> = {}): Promise<JsonApiResult> {
  return invoke(categoryHandler, op, callFor({ ...a, method: op }));
}

/** Runs `op` of the contentCategoryAssign handler for a call built from `a`. */
function onAssign(op: Op, a: Omit<CallArgs, 'method' | 'entityName'> = {}): Promise<JsonApiResult> {
  return invoke(contentCategoryAssignHandler, op, callFor({ ...a, method: op, entityName: 'contentCategoryAssign' }));
}

/** The `data` struct of a result. */
function dataOf(result: JsonApiResult): Struct {
  expect(result.error).toBeUndefined();
  return result.data as Struct;
}

/** The items of a collection result. */
function itemsOf(result: JsonApiResult): Struct[] {
  return dataOf(result)['items'] as Struct[];
}

const linksOf = (data: Struct): Struct => data['links'] as Struct;
const category = (handlerActor: Actor, input: Struct): Promise<CategoryBean> => createCategory(deps, handlerActor, input);
const trimmed = (id: string): string => id.replaceAll('-', '');

/** The `content.category` rows tenant `tenantId` holds. */
function categoryCount(tenantId: string): Promise<number> {
  return withTenant(handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.category`);
    return rows[0]?.n ?? 0;
  });
}

/** The `data` of `result` as the JSON API puts it on the wire (envelope serializer and the entity's coercions). */
function wire(method: string, result: JsonApiResult): Struct {
  const serializer = contentApiSerializer(result.serializerEntity ?? '');
  const { body } = serializeResponse(buildEnvelope({ method, data: result.data }), { serializer });
  return (JSON.parse(body) as { data: Struct }).data;
}

const EP_A = endpointOf(TENANT_A.siteId);
const EP_B = endpointOf(TENANT_B.siteId);
let ROOT: CategoryBean;
let CHILD: CategoryBean;
let OWN_A: CategoryBean;
let OWN_B: CategoryBean;

describe.skipIf(!(await pgAvailable()))('JSON API category and contentCategoryAssign handlers', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-category-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-category-test', state: 'open' });
    await seedRegistry(handle.app);
    const repository = createContentRepository({ clock, schema: handle.schema });
    deps = { db: handle.app, repository, clock, config: CONTENT_CONFIG_DEFAULTS };
    ROOT = await category(EDITOR_A, { siteid: POOL, name: 'Parent Topic' });
    CHILD = await category(EDITOR_A, { siteid: POOL, name: 'Child Topic', parentid: ROOT.categoryid });
    OWN_A = await category(EDITOR_A, { siteid: TENANT_A.siteId, name: 'Own Topic' });
    OWN_B = await category(EDITOR_B, { siteid: TENANT_B.siteId, name: 'Bee Topic' });
    await withTenant(handle.app, TENANT_UMBRELLA.tenantId, async (tx) => {
      await repository.projections.upsertGroupProjection(tx, { groupId: POOL_EDITORS, siteId: POOL, groupName: 'Category Editors', isPublic: 1, deleted: false });
      await repository.projections.replaceGroupPermissions(tx, POOL_EDITORS, POOL, [{ contentId: CATEGORIES_MODULE, siteId: POOL, type: 'module' }]);
    });
    await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      repository.projections.replaceUserMemberships(tx, POOL_EDITOR_A.userId, TENANT_A.siteId, [POOL_EDITORS]),
    );
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      for (const [histId, assigned] of [[H1, CHILD], [H2, OWN_A]] as const) {
        await setCategoryAssignments(tx, deps.repository, {
          data: { categoryID: assigned.categoryid, [`categoryAssign${trimmed(assigned.categoryid)}`]: '0' },
          contentId: C1,
          contentHistId: histId,
          siteId: TENANT_A.siteId,
          poolCategories: [{ categoryid: assigned.categoryid }],
          current: [],
        });
      }
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('category reads', () => {
    it('findOne reads a tenant-a pool category stored under the umbrella tenant, with the cCategory edit link', async () => {
      const result = await onCategory('findOne', { actor: EDITOR_A, id: CHILD.categoryid });
      expect(result.status).toBe(200);
      const data = wire('findOne', result);
      expect(data).toMatchObject({
        id: CHILD.categoryid,
        categoryid: CHILD.categoryid,
        siteid: POOL,
        name: 'Child Topic',
        parentid: ROOT.categoryid,
        path: `${ROOT.categoryid},${CHILD.categoryid}`,
        filename: 'parent-topic/child-topic',
        isnew: 0,
        entityname: 'category',
      });
      expect(linksOf(data)).toMatchObject({
        edit:
          `/admin/?muraAction=cCategory.edit&categoryID=${CHILD.categoryid}` +
          `&parentID=${ROOT.categoryid}&siteid=${POOL}&compactDisplay=false`,
        contentassignments: `${EP_A}/contentCategoryAssign?categoryID=${CHILD.categoryid}`,
        kids: `${EP_A}/category?parentid=${CHILD.categoryid}`,
        crumbs: `${EP_A}/category/${CHILD.categoryid}/crumbs`,
        permissions: `${EP_A}/category/${CHILD.categoryid}/permissions`,
      });
      const anonymous = wire('findOne', await onCategory('findOne', { id: CHILD.categoryid }));
      expect(anonymous).toMatchObject({ id: CHILD.categoryid, name: 'Child Topic' });
      expect(linksOf(anonymous)).not.toHaveProperty('edit');
    });

    it.each([
      ['a tenant-b caller for the umbrella category', TENANT_B, () => CHILD.categoryid],
      ['a tenant-a caller for tenant-b\'s category', TENANT_A, () => OWN_B.categoryid],
      ['a missing id', TENANT_A, () => cfId('X', 1)],
    ])('findOne answers the new bean of the request site for %s', async (_label, site, id) => {
      const result = await onCategory('findOne', { site, id: id() });
      expect(result.status).toBe(200);
      expect(wire('findOne', result)).toMatchObject({ id: '', categoryid: '', name: '', siteid: site.siteId, isnew: 1 });
    });

    it.each([
      [TENANT_A, ['Own Topic']],
      [TENANT_B, ['Bee Topic']],
    ])('findAll for %o lists only the request site\'s categories', async (site, names) => {
      const data = wire('findAll', await onCategory('findAll', { site }));
      expect((data['items'] as Struct[]).map((item) => item['name'])).toEqual(names);
      expect(data).toMatchObject({ totalitems: names.length, itemsperpage: 1000 });
    });

    it.each([
      ['`*`, the registered content pool', '*'],
      ['an ungranted site, which keeps the own site', TENANT_B.siteId],
    ])('findAll with contentpoolid %s reads tenant-a\'s own categories', async (_label, contentpoolid) => {
      const items = itemsOf(await onCategory('findAll', { url: { contentpoolid } }));
      expect(items.map((item) => item['name'])).toEqual(['Own Topic']);
    });

    it('findQuery filters by a wildcard name and projects `fields` to the listed columns', async () => {
      const byName = itemsOf(await onCategory('findQuery', { url: { name: 'Own*' } }));
      expect(byName.map((item) => item['categoryid'])).toEqual([OWN_A.categoryid]);
      const result = await onCategory('findQuery', { url: { fields: 'name' } });
      const [item] = (wire('findQuery', result)['items'] as Struct[]);
      expect(Object.keys(item ?? {}).sort()).toEqual(['categoryid', 'entityname', 'id', 'isnew', 'name', 'siteid']);
      expect(item).toMatchObject({ categoryid: OWN_A.categoryid, name: 'Own Topic', isnew: 0, siteid: '' });
    });

    it('findQuery rejects a `notes` filter as invalidParameters', async () => {
      await expect(onCategory('findQuery', { url: { notes: 'n1' } })).rejects.toEqual(
        new LegacyApiError('invalidParameters'),
      );
    });

    it('findMany answers the feed rows in `ids` order, a repeated id repeated, and other tenants\' ids absent', async () => {
      const ids = [cfId('X', 2), OWN_A.categoryid, CHILD.categoryid, OWN_A.categoryid];
      const data = wire('findMany', await onCategory('findMany', { ids }));
      expect((data['items'] as Struct[]).map((item) => item['categoryid'])).toEqual([OWN_A.categoryid, OWN_A.categoryid]);
      expect(data['totalitems']).toBe(1);
    });

    it('findNew answers a new bean of the request site with the empty-id links', async () => {
      const data = wire('findNew', await onCategory('findNew'));
      expect(data).toMatchObject({ id: '', categoryid: '', siteid: TENANT_A.siteId, isnew: 1 });
      expect(linksOf(data)).toMatchObject({
        permissions: `${EP_A}/category//permissions`,
        contentassignments: `${EP_A}/contentCategoryAssign?categoryID=`,
      });
    });

    it.each<[string, Op, Omit<CallArgs, 'method' | 'entityName'>]>([
      ['findNew of `category/new`', 'findNew', { id: 'new' }],
      ['findNew of `?method=findNew&entityname=category`', 'findNew', { url: { method: 'findNew', entityname: 'category' } }],
      ['findOne of an unknown id', 'findOne', { id: cfId('X', 1) }],
      ['save with validation errors', 'save', { actor: EDITOR_A, form: { name: '' } }],
    ])('%s answers the new bean\'s init dates in the JSON date format', async (_label, op, args) => {
      const data = wire(op, await onCategory(op, args));
      expect(data).toMatchObject({ isnew: 1, datecreated: '2026-06-30T10:00:00', lastupdate: '2026-06-30T10:00:00' });
    });

    it.each([
      ['anonymous', ANONYMOUS, undefined, { read: true, delete: false, save: false }],
      ['the Categories module user on a pool category', EDITOR_A, () => CHILD.categoryid, { read: true, delete: false, save: false }],
      ['the Categories module user on an own-site category', EDITOR_A, () => OWN_A.categoryid, { read: true, delete: true, save: true }],
      ['the site Admin on a pool category', SITE_ADMIN_A, () => CHILD.categoryid, { read: true, delete: false, save: false }],
      ['the site Admin on an own-site category', SITE_ADMIN_A, () => OWN_A.categoryid, { read: true, delete: true, save: true }],
      ['an S2 user on a pool category', S2_A, () => CHILD.categoryid, { read: true, delete: true, save: true }],
      ['a pool-site module group member on a pool category', POOL_EDITOR_A, () => CHILD.categoryid, { read: true, delete: true, save: true }],
      ['a pool-site module group member on an own-site category', POOL_EDITOR_A, () => OWN_A.categoryid, { read: true, delete: false, save: false }],
      ['the Site Manager module user', MANAGER_A, () => OWN_A.categoryid, { read: true, delete: false, save: false }],
    ])('findPermissions for %s', async (_label, caller, id, expected) => {
      const call = callFor({ method: 'findPermissions', actor: caller, ...(id === undefined ? {} : { id: id() }) });
      expect(dataOf(await invoke(categoryHandler, 'findPermissions', call))).toEqual(expected);
    });

    it('findProperties describes the category entity', async () => {
      const data = dataOf(await onCategory('findProperties'));
      expect(data).toMatchObject({
        historical: false,
        dynamic: false,
        links: { endpoint: `${EP_A}/category`, self: `${EP_A}/category/properties` },
      });
      expect((data['properties'] as Struct[]).map((property) => property['name'])).toContain('categoryid');
    });
  });

  describe('category writes', () => {
    it.each([
      ['anonymous', ANONYMOUS, true, { error: 'authorization' }],
      ['the Site Manager module user', MANAGER_A, true, { error: 'authorization' }],
      ['a failed CSRF check', EDITOR_A, false, { error: 'invalidTokens' }],
    ])('save by %s writes nothing', async (_label, caller, csrf, expected) => {
      const before = await categoryCount(TENANT_A.tenantId);
      const call = callFor({ method: 'save', actor: caller, csrf, form: { name: 'Denied Topic' } });
      expect(await invoke(categoryHandler, 'save', call)).toEqual(expected);
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      expect(await categoryCount(TENANT_A.tenantId)).toBe(before);
    });

    it('the Categories module user creates, updates and deletes a category of the request site', async () => {
      const created = await onCategory('save', { actor: EDITOR_A, form: { name: 'Created Topic' } });
      expect(created.status).toBe(200);
      const data = wire('save', created);
      const id = String(data['categoryid']);
      expect(isCfUuid(id)).toBe(true);
      expect(data).toMatchObject({
        id,
        name: 'Created Topic',
        siteid: TENANT_A.siteId,
        filename: 'created-topic',
        path: id,
        isnew: 0,
        saveerrors: '',
        errors: {},
      });
      expect(linksOf(data)['edit']).toBeUndefined();
      expect(await readCategory(deps, EDITOR_A, id)).toMatchObject({ name: 'Created Topic', isnew: '0', lastupdateby: 'Admin User' });

      const updated = wire('save', await onCategory('save', { actor: EDITOR_A, form: { categoryid: id, name: 'Renamed Topic' } }));
      expect(updated).toMatchObject({ id, name: 'Renamed Topic', errors: {} });
      expect(await readCategory(deps, EDITOR_A, id)).toMatchObject({ name: 'Renamed Topic' });

      const removal = callFor({ method: 'delete', actor: EDITOR_A, id });
      expect(await invoke(categoryHandler, 'delete', removal)).toEqual({ status: 200, data: '' });
      expect(removal.validateCsrf).toHaveBeenCalledTimes(1);
      expect(await readCategory(deps, EDITOR_A, id)).toMatchObject({ categoryid: '', isnew: 1 });
    });

    it('save answers the request values with the validation errors as a 403 and stores nothing', async () => {
      const before = await categoryCount(TENANT_A.tenantId);
      const result = await onCategory('save', { actor: EDITOR_A, form: { name: '' } });
      expect(result.status).toBe(403);
      expect(wire('save', result)).toMatchObject({ name: '', saveerrors: '', errors: { name: expect.any(String) } });
      expect(await categoryCount(TENANT_A.tenantId)).toBe(before);
    });

    it('delete of a category no tenant of the caller holds answers \'\' without a CSRF check', async () => {
      const call = callFor({ method: 'delete', actor: EDITOR_B, site: TENANT_B, id: CHILD.categoryid });
      expect(await invoke(categoryHandler, 'delete', call)).toEqual({ status: 200, data: '' });
      expect(call.validateCsrf).not.toHaveBeenCalled();
      expect(await readCategory(deps, EDITOR_A, CHILD.categoryid)).toMatchObject({ isnew: '0' });
    });

    it.each([
      ['anonymous', ANONYMOUS, true, { error: 'authorization' }, 0],
      ['a failed CSRF check', EDITOR_A, false, { error: 'invalidTokens' }, 1],
    ])('delete by %s keeps the category', async (_label, caller, csrf, expected, csrfCalls) => {
      const call = callFor({ method: 'delete', actor: caller, csrf, url: { categoryid: OWN_A.categoryid } });
      expect(await invoke(categoryHandler, 'delete', call)).toEqual(expected);
      expect(call.validateCsrf).toHaveBeenCalledTimes(csrfCalls);
      expect(await readCategory(deps, EDITOR_A, OWN_A.categoryid)).toMatchObject({ isnew: '0' });
    });
  });

  describe('contentCategoryAssign', () => {
    const assign = (a: Omit<CallArgs, 'entityName'>): JsonApiCall & { validateCsrf: ReturnType<typeof vi.fn> } =>
      callFor({ ...a, entityName: 'contentCategoryAssign' });

    it('findQuery by contenthistid joins the umbrella category\'s name, parent name, filename and path', async () => {
      const result = await onAssign('findQuery', { url: { contenthistid: H1 } });
      const items = wire('findQuery', result)['items'] as Struct[];
      expect(items).toHaveLength(1);
      const [item = {}] = items;
      expect(item).toMatchObject({
        contenthistid: H1,
        contentid: C1,
        categoryid: CHILD.categoryid,
        categoryname: 'Child Topic',
        parentname: 'Parent Topic',
        parentid: ROOT.categoryid,
        filename: 'parent-topic/child-topic',
        path: `${ROOT.categoryid},${CHILD.categoryid}`,
        siteid: TENANT_A.siteId,
        isfeature: 0,
        isnew: 0,
        entityname: 'contentCategoryAssign',
      });
      expect(item).not.toHaveProperty('id');
      expect(linksOf(item)).toMatchObject({
        category: `${EP_A}/category/${CHILD.categoryid}`,
        activecontent: `${EP_A}/content/${C1}`,
        content: `${EP_A}/content/?contenthistid=${H1}`,
      });
      expect(linksOf(item)).not.toHaveProperty('permissions');
    });

    it('findAll lists the request site\'s assignments in clustered-key order, an own-site category joined too', async () => {
      const items = itemsOf(await onAssign('findAll'));
      expect(items.map((item) => [item['contenthistid'], item['categoryname']])).toEqual([
        [H1, 'Child Topic'],
        [H2, 'Own Topic'],
      ]);
    });

    it.each([
      ['findQuery', { contenthistid: H1 }],
      ['findAll', {}],
    ] as const)('%s for tenant-b reads none of tenant-a\'s assignments', async (method, url) => {
      const result = await onAssign(method, { site: TENANT_B, url });
      expect(itemsOf(result)).toEqual([]);
      expect(dataOf(result)['links']).toMatchObject({ self: expect.stringContaining(EP_B) });
    });

    it('countOnly counts the unjoined rows and `fields` selects the listed columns without the join', async () => {
      expect(wire('findQuery', await onAssign('findQuery', { url: { countOnly: 'true' } }))).toEqual({ count: '2' });
      const result = await onAssign('findQuery', { url: { categoryid: CHILD.categoryid, fields: 'contentid' } });
      expect(wire('findQuery', result)['items']).toEqual([{ contentid: C1, entityname: 'contentCategoryAssign', isnew: 0, siteid: '' }]);
    });

    it('a filter on a joined column fails as legacy\'s SQL does', async () => {
      await expect(onAssign('findQuery', { url: { categoryname: 'Child Topic' } })).rejects.toThrow();
    });

    it.each(['findOne', 'findNew'] as const)('%s answers the request site\'s first assignment, else the unloaded bean', async (method) => {
      const first = wire(method, await onAssign(method, { id: cfId('X', 3) }));
      expect(first).toMatchObject({ contenthistid: H1, categoryid: CHILD.categoryid, categoryname: 'Child Topic', isnew: 0 });
      const none = wire(method, await onAssign(method, { site: TENANT_B, id: cfId('X', 3) }));
      expect(none).toMatchObject({ contenthistid: '', categoryid: '', siteid: TENANT_B.siteId, isnew: 1 });
    });

    it('findMany fails reordering by the missing id unless a URL sort is given', async () => {
      await expect(onAssign('findMany', { ids: [H1] })).rejects.toThrow('Element ID is undefined in I2.');
      const sorted = itemsOf(await onAssign('findMany', { ids: [H1], url: { sort: 'orderno' } }));
      expect(sorted).toHaveLength(2);
      expect(itemsOf(await onAssign('findMany', { site: TENANT_B, ids: [H1] }))).toEqual([]);
    });

    it.each([
      ['anonymous', ANONYMOUS, { read: true, delete: false, save: false }],
      ['the Site Manager module user', MANAGER_A, { read: true, delete: true, save: true }],
      ['the Categories module user', EDITOR_A, { read: true, delete: false, save: false }],
    ])('findPermissions for %s', async (_label, caller, expected) => {
      expect(dataOf(await onAssign('findPermissions', { actor: caller }))).toEqual(expected);
    });

    it('findProperties describes the assignment entity', async () => {
      const data = dataOf(await onAssign('findProperties'));
      expect(data).toMatchObject({ links: { endpoint: `${EP_A}/contentCategoryAssign` } });
    });

    it.each([
      ['save', 'a failed CSRF check', MANAGER_A, false, TENANT_A, { error: 'invalidTokens' }],
      ['save', 'anonymous', ANONYMOUS, true, TENANT_A, { error: 'authorization' }],
      ['delete', 'anonymous', ANONYMOUS, true, TENANT_A, { error: 'authorization' }],
      ['delete', 'a failed CSRF check', MANAGER_A, false, TENANT_A, { error: 'invalidTokens' }],
      ['delete', 'a site without assignments', MANAGER_A, true, TENANT_B, { status: 200, data: '' }],
    ] as const)('%s with %s answers without writing', async (method, _label, caller, csrf, site, expected) => {
      const call = assign({ method, actor: caller, csrf, site, form: { contenthistid: H1, categoryid: CHILD.categoryid, isfeature: 1 } });
      expect(await invoke(contentCategoryAssignHandler, method, call)).toEqual(expected);
      expect(itemsOf(await onAssign('findQuery', { url: { contenthistid: H1 } }))).toMatchObject([{ isfeature: 0 }]);
    });

    it.each(['save', 'delete'] as const)('%s by the Site Manager module user fails before any write', async (method) => {
      const call = assign({ method, actor: MANAGER_A, form: { contenthistid: H1, categoryid: CHILD.categoryid, isfeature: 1 } });
      await expect(invoke(contentCategoryAssignHandler, method, call)).rejects.toThrow(
        'Complex object types cannot be converted to simple values.',
      );
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      expect(itemsOf(await onAssign('findAll'))).toHaveLength(2);
    });
  });
});

// ---- the SQL-bounded feeds against the whole-site reads the handlers evaluated in memory before them ----

/** tcontentcategories columns, as the category feed projected each row it read. */
const READ_CATEGORY_COLUMNS = [
  'categoryid', 'siteid', 'parentid', 'datecreated', 'lastupdate', 'lastupdateby', 'name', 'notes', 'isinterestgroup',
  'isactive', 'isopen', 'sortby', 'sortdirection', 'restrictgroups', 'path', 'remoteid', 'remotesourceurl', 'remotepubdate',
  'urltitle', 'filename', 'isfeatureable',
] as const;

/** The id and site equality the handlers applied in memory: trailing spaces dropped, then lower-cased. */
function sqlKey(value: unknown): string {
  return (typeof value === 'string' ? value : '').replace(/ +$/u, '').toLowerCase();
}

/** The scope a feed spec was built for; the reading repository answers it with whole-site reads. */
type ReadScope =
  | { kind: 'category'; siteId: string; categoryIds?: readonly string[] }
  | { kind: 'assignment'; siteId: string; contentHistId?: string; categories?: readonly unknown[] };

/** A feed source evaluating in memory the rows `load` reads on first use. */
function readRows(load: () => Promise<Struct[]>): BeanFeedSource<Struct> {
  let memory: Promise<BeanFeedSource<Struct>> | undefined;
  const held = (): Promise<BeanFeedSource<Struct>> => (memory ??= load().then((rows) => rowsSource(rows)));
  return {
    columns: [],
    isEmpty: async () => (await held()).isEmpty(),
    filterThrows: async (where) => (await held()).filterThrows(where),
    count: async (query) => (await held()).count(query),
    rows: async (query, offset, limit) => (await held()).rows(query, offset, limit),
    orders: () => false,
    scan: async (request, visit, revisit) => (await held()).scan(request, visit, revisit),
  };
}

/** The join index the assignment feed read whole: the category pool's categories, then the request site's, first per key. */
async function readIndex(domain: DomainDeps, call: JsonApiCall): Promise<Map<string, CategoryRow>> {
  const pool = await listPoolCategories(domain, { ...call.actor, tenantId: call.tenantId, siteId: call.siteId });
  const own = await withTenant(domain.db, call.tenantId, (tx) => domain.repository.categories.categoriesBySite(tx, { siteId: call.siteId }));
  const index = new Map<string, CategoryRow>();
  for (const row of [...pool, ...own]) if (!index.has(sqlKey(row.categoryid))) index.set(sqlKey(row.categoryid), row);
  return index;
}

/** A scope's rows as the handlers selected them: every row of the site, then the ids filter or category join in memory. */
async function readScope(domain: DomainDeps, call: JsonApiCall, run: FeedRunner, scope: ReadScope): Promise<Struct[]> {
  const { categories, content } = domain.repository;
  if (scope.kind === 'category') {
    const rows = await run(async (tx) =>
      (await categories.categoriesBySite(tx, { siteId: scope.siteId })).map(
        (row): Struct => Object.fromEntries(READ_CATEGORY_COLUMNS.map((column) => [column, row[column]])),
      ),
    );
    const wanted = scope.categoryIds === undefined ? undefined : new Set(scope.categoryIds.map(sqlKey));
    return wanted === undefined ? rows : rows.filter((row) => wanted.has(sqlKey(row['categoryid'])));
  }
  const histId = scope.contentHistId;
  const rows = await run(async (tx) =>
    (histId === undefined
      ? await content.siteCategoryAssignments(tx, { siteId: scope.siteId })
      : (await content.categoryAssignments(tx, { contentHistId: histId })).filter((row) => sqlKey(row.siteid) === sqlKey(scope.siteId))
    ).map((row): Struct => ({ ...row })),
  );
  if (scope.categories === undefined || rows.length === 0) return rows;
  const index = await readIndex(domain, call);
  return rows.flatMap((row) => {
    const category = index.get(sqlKey(row['categoryid']));
    if (category === undefined) return [];
    const parent = category.parentid === null ? undefined : index.get(sqlKey(category.parentid));
    const joined = { categoryname: category.name, parentname: parent?.name ?? null, parentid: category.parentid };
    return [{ ...row, ...joined, filename: category.filename, path: category.path }];
  });
}

/** `domain` whose category and assignment feeds read every site row and evaluate the request in memory. */
function readingDomain(domain: DomainDeps, call: JsonApiCall): DomainDeps {
  const { repository } = domain;
  const spec = (scope: ReadScope): FeedTableSpec => scope as unknown as FeedTableSpec;
  const reading = {
    ...repository,
    categories: { ...repository.categories, siteCategoriesFeed: (args: Struct) => spec({ kind: 'category', ...args } as ReadScope) },
    content: { ...repository.content, categoryAssignmentsFeed: (args: Struct) => spec({ kind: 'assignment', ...args } as ReadScope) },
    beanFeed: {
      source: (run: FeedRunner, scope: FeedTableSpec) => readRows(() => readScope(domain, call, run, scope as unknown as ReadScope)),
    },
  };
  return { ...domain, repository: reading as unknown as ContentRepository };
}

/** The URL scope legacy parses from `raw`: decoded keys and values. */
function urlOf(raw: string): Struct {
  const url: Struct = {};
  for (const item of raw.split('&').filter((part) => part !== '')) {
    const [key = '', ...rest] = item.split('=');
    url[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
  }
  return url;
}

/** What a handler answered for `call` (status, error and the wire body), or what it raised. */
async function outcomeOf(handler: EntityHandler, op: Op, call: JsonApiCall, domain: DomainDeps): Promise<Struct> {
  const fn = handler[op];
  if (fn === undefined) throw new Error(`${handler.entity} has no ${op}`);
  try {
    const result = await fn({ domain } as unknown as ContentRouteContext, call);
    if (result.error !== undefined) return { status: result.status, error: result.error };
    const serializer = contentApiSerializer(result.serializerEntity ?? '');
    return { status: result.status, body: serializeResponse(buildEnvelope({ method: op, data: result.data }), { serializer }).body };
  } catch (err) {
    const error = err as Error & { type?: unknown };
    return { thrown: error.constructor.name, message: error.message, type: error.type };
  }
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date => new Date(y, mo - 1, d, h, mi, s, ms);
const K = (n: number): string => cfId('K', n);
const KB = (n: number): string => cfId('B', n);
const KU = (n: number): string => cfId('U', n);
const FH = (n: number): string => cfId('F', n);
/** A mixed-case own-site category id; the pool holds its upper-case form, which the join index takes first. */
const K_MIXED = 'Km000008-aaaa-BBBB-CCCCDDDDEEEEFFFF';
/** A short id the char(35) column pads. */
const K_SHORT = 'SHORT-ID';
const F_MIXED = 'Fm000005-aaaa-BBBB-CCCCDDDDEEEEFFFF';

const categoryRow = (categoryid: string, siteid: string, values: Struct): Struct => ({ categoryid, siteid, ...values });
const OWN_CATEGORIES: Struct[] = [
  categoryRow(K(1), 'tenant-a', { name: 'Alpha', isactive: 1, isinterestgroup: 0, datecreated: at(2026, 1, 5), filename: 'alpha', path: K(1), isfeatureable: 1 }),
  categoryRow(K(2), 'tenant-a', { name: 'alpha ', isactive: 0, isinterestgroup: 0, datecreated: at(2025, 12, 31), filename: 'alpha-2', path: K(2) }),
  categoryRow(K(3), 'tenant-a', {
    name: 'Beta',
    parentid: K(1),
    isactive: 1,
    remotepubdate: at(2026, 2, 1, 8, 30, 0, 123),
    filename: 'alpha/beta',
    path: `${K(1)},${K(3)}`,
    notes: 'n1',
  }),
  categoryRow(K(4), 'tenant-a', { isactive: null, datecreated: at(2026, 1, 5) }),
  categoryRow(K(5), 'tenant-a', { name: 'ÁLPHA', isactive: 1, isinterestgroup: 1, datecreated: at(2026, 3, 1) }),
  categoryRow(K(6), 'tenant-a', { name: 'gamma_x', isinterestgroup: 1, isopen: 1, isactive: 1 }),
  categoryRow(K(7), 'tenant-a', { name: 'Zeta', isactive: 1, sortby: 'name', sortdirection: 'desc' }),
  categoryRow(K_MIXED, 'tenant-a', { name: 'delta', isactive: 1, filename: 'delta' }),
  categoryRow(K_SHORT, 'tenant-a', { name: 'Short', isactive: 0 }),
  categoryRow(K(9), 'tenant-a', { name: 'a😀b', isactive: 1 }),
  categoryRow(K(10), 'tenant-a', { name: '', isactive: 1 }),
  categoryRow(K(11), 'Tenant-A', { name: 'Cased Site' }),
  categoryRow(K(12), 'other-site', { name: 'Other' }),
];
const B_CATEGORIES: Struct[] = [
  categoryRow(KB(1), 'tenant-b', { name: 'Alpha', isactive: 1, datecreated: at(2026, 1, 5) }),
  categoryRow(KB(2), 'tenant-b', { name: 'beta', isactive: 0 }),
  categoryRow(KB(3), 'tenant-b', { isactive: 1 }),
  categoryRow(KB(4), 'tenant-b', { name: 'Omega', parentid: KB(1), isactive: 1 }),
  categoryRow(K(1), 'tenant-b', { name: 'Bee Alpha', isactive: 1 }),
];
const POOL_CATEGORIES: Struct[] = [
  categoryRow(KU(1), POOL, { name: 'Pool Root', filename: 'pool-root', path: KU(1) }),
  categoryRow(KU(2), POOL, { name: 'Pool Child', parentid: KU(1), filename: 'pool-root/pool-child', path: `${KU(1)},${KU(2)}` }),
  categoryRow(K_MIXED.toUpperCase(), POOL, { name: 'Pool Shadow' }),
  categoryRow(KU(4), POOL, { name: 'Shadow Child', parentid: K_MIXED.toLowerCase() }),
  categoryRow(KU(5), POOL, { name: 'Orphan', parentid: cfId('Z', 9) }),
];

const assignmentRow = (contenthistid: string, categoryid: string, siteid: string | null, values: Struct = {}): Struct => ({
  contenthistid,
  categoryid,
  siteid,
  contentid: C1,
  isfeature: 0,
  ...values,
});
const A_ASSIGNMENTS: Struct[] = [
  assignmentRow(FH(1), KU(2), 'tenant-a', { orderno: 1 }),
  assignmentRow(FH(1), K(1), 'tenant-a', { orderno: 2, isfeature: 1, featurestart: at(2026, 1, 1), featurestop: at(2026, 12, 31, 23, 59, 59) }),
  assignmentRow(FH(1), cfId('X', 9), 'tenant-a', { orderno: 3 }),
  assignmentRow(FH(2), K(3), 'tenant-a', { orderno: 2, isfeature: 2, featurestart: at(2026, 3, 1) }),
  assignmentRow(FH(2), KU(1), 'tenant-a', { orderno: null, contentid: null }),
  assignmentRow(FH(3), K_MIXED.toLowerCase(), 'tenant-a', { orderno: 5 }),
  assignmentRow(FH(3), KU(4), 'tenant-a', { orderno: 1, featurestop: at(2026, 6, 30) }),
  assignmentRow(FH(3).toLowerCase(), KU(5), 'tenant-a', { orderno: 4 }),
  assignmentRow(F_MIXED, K(5), 'tenant-a', { orderno: 7, isfeature: 1 }),
  assignmentRow(FH(6), K(6), 'TENANT-A ', { orderno: 6 }),
  assignmentRow(FH(7), K(7), 'other-site', { orderno: 1 }),
  assignmentRow(FH(8), K(2), null, { orderno: 1 }),
  assignmentRow(FH(9), K_SHORT, 'tenant-a', { orderno: 0, featurestart: at(2025, 12, 31) }),
];
const B_ASSIGNMENTS: Struct[] = [
  assignmentRow(FH(21), KB(1), 'tenant-b', { orderno: 1 }),
  assignmentRow(FH(21), K(1), 'tenant-b', { orderno: 2, isfeature: 1 }),
  assignmentRow(FH(22), KU(1), 'tenant-b', { orderno: 3 }),
  assignmentRow(FH(23), KB(4), 'tenant-b', { orderno: null }),
];

// Filters (conditions, null, like, lists, or and grouping), sorts, paging, maxItems, countOnly, fields and content pools.
const CATEGORY_QUERIES: string[] = [
  '', 'name=alpha', 'name=ALPHA%20', 'name=Alpha*', 'name=*a*', 'name=like%5Ea_pha', 'name=like%5E%5Bab%5D%25', 'name=null', 'name=neq%5Enull',
  'name=', 'name=in%5Ealpha%2CBeta', 'name=notin%5Ealpha', 'name=gt%5Eb', 'name=lte%5Ebeta', 'name=*%F0%9F%98%80*', 'name=like%5Ea_b',
  'isactive=1', 'isactive=null', 'isactive=gt%5E0', 'isactive=0&or&name=Beta', 'openGrouping&isactive=1&or&isinterestgroup=1&closeGrouping&name=neq%5Enull',
  'datecreated=2026-01-05', 'datecreated=gt%5E2026-01-01', 'remotepubdate=null', 'remotepubdate=2026-02-01%2008%3A30%3A00.123', 'parentid=null',
  `parentid=${K(1)}`, `id=${K(3).toLowerCase()}`, `categoryid=${K_MIXED.toUpperCase()}`, 'siteid=TENANT-A', 'filename=alpha%2Fbeta', 'notes=n1',
  'sort=-name', 'sort=isactive%2C-name', 'sort=-datecreated%2Cname', 'sortBy=name&sortDirection=desc', 'sortBy=isactive%2Cname', 'sort=filename',
  'sort=tcontentcategories.name', 'sort=nope', 'sort=categoryname', 'itemsPerPage=2', 'itemsPerPage=2&pageIndex=2', 'itemsPerPage=3&pageIndex=4',
  'startIndex=3&itemsPerPage=2', 'maxitems=3', 'maxitems=3&itemsPerPage=2&pageIndex=2', 'itemsPerPage=*', 'itemsPerPage=0', 'maxitems=*',
  'countOnly=true', 'countOnly=true&isactive=1',
  'fields=name%2Cisactive&sort=-name', 'fields=nope', 'contentpoolid=*', 'contentpoolid=*&sort=-name&itemsPerPage=3&pageIndex=2',
  'contentpoolid=tenant-b%2Ctenant-a&name=alpha', 'contentpoolid=*&countOnly=true', 'contentpoolid=*&sort=isactive%2Cname&maxitems=6', 'contentpoolid=TENANT-B',
];
const ASSIGNMENT_QUERIES: string[] = [
  '', `contenthistid=${FH(1)}`, `contenthistid=${FH(3)}`, `contenthistid=${FH(3).toLowerCase()}`, `contenthistid=${F_MIXED.toUpperCase()}`,
  `contenthistid=${F_MIXED}`, `contenthistid=${FH(1)}&or&orderno=7`, `contenthistid=${FH(1)}&orderno=gt%5E1`, 'contenthistid=*0000003*',
  `contenthistid=${FH(7)}`, `categoryid=${K(1)}`, `categoryid=${K_MIXED}`, 'isfeature=1', 'isfeature=gt%5E0', 'orderno=gt%5E1', 'orderno=null',
  'orderno=in%5E1%2C2', 'featurestart=null', 'featurestart=gt%5E2026-01-01', 'contentid=null', 'siteid=TENANT-A', 'siteid=like%5Etenant%25',
  'sort=-orderno', 'sort=featurestop', 'sort=-featurestop%2Ccontenthistid', 'sort=categoryid%2C-isfeature', 'sortBy=orderno&sortDirection=desc',
  'sort=categoryname', 'categoryname=Pool%20Child', 'featuresop=1', 'parentid=null', 'itemsPerPage=2&pageIndex=2', 'startIndex=4&itemsPerPage=3',
  'maxitems=2', 'itemsPerPage=*', 'maxitems=*', 'countOnly=true', `countOnly=true&contenthistid=${FH(1)}`, 'fields=contentid%2Corderno', 'fields=categoryname', 'contentpoolid=*',
  'contentpoolid=*&sort=-orderno&itemsPerPage=2&pageIndex=2', 'contentpoolid=tenant-b%2Ctenant-a', `contentpoolid=*&contenthistid=${FH(21)}`,
  'contentpoolid=*&countOnly=true',
];

describe.skipIf(!(await pgAvailable()))('category and contentCategoryAssign feeds in SQL against the in-memory evaluation', () => {
  let feedHandle: ThrowawaySchema;
  let feedDeps: DomainDeps;
  let recordedDeps: DomainDeps;
  const statements: { tenantId: string; sql: string; rows: number }[] = [];

  /** `tx`, recording each statement and the rows it returned. */
  function recordingTx(tx: TenantTx): TenantTx {
    return {
      kind: tx.kind,
      tenantId: tx.tenantId,
      schema: tx.schema,
      onCommit: (cb, onError) => {
        tx.onCommit(cb, onError);
      },
      query: (async (text: string | { text: string }, values?: unknown[]) => {
        const result = await tx.query(text, values);
        statements.push({ tenantId: tx.tenantId, sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
        return result;
      }) as TenantTx['query'],
    };
  }

  /** `db`, whose tenant transactions record their statements. */
  function recordingDb(db: TenantDb): TenantDb {
    return {
      schema: db.schema,
      withTenant: <T,>(tenantId: string, fn: (tx: TenantTx) => Promise<T>, options?: TransactionCallOptions): Promise<T> =>
        options === undefined ? db.withTenant(tenantId, (tx) => fn(recordingTx(tx))) : db.withTenant(tenantId, (tx) => fn(recordingTx(tx)), options),
      withMetadata: (fn, options) => (options === undefined ? db.withMetadata(fn) : db.withMetadata(fn, options)),
      end: () => db.end(),
    };
  }

  async function insertRows(tenantId: string, table: string, rows: readonly Struct[]): Promise<void> {
    await withTenant(feedHandle.app, tenantId, async (tx) => {
      for (const row of rows) {
        const names = Object.keys(row);
        const placeholders = names.map((_, i) => `$${String(i + 2)}`).join(', ');
        await tx.query(`INSERT INTO ${feedHandle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${placeholders})`, [
          tx.tenantId,
          ...Object.values(row),
        ]);
      }
    });
  }

  beforeAll(async () => {
    feedHandle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(feedHandle.app, CONTENT_UNITS);
    await closeGates(feedHandle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-category-feed-test', allowLegacy: true });
    await openGates(feedHandle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-category-feed-test', state: 'open' });
    await seedRegistry(feedHandle.app);
    // tenant-a's content pool lists tenant-b too, so `contentpoolid` feeds merge two site tenants.
    await feedHandle.app.withMetadata((tx) =>
      tx.query(`UPDATE ${feedHandle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
        [TENANT_A.siteId, TENANT_B.siteId],
        [TENANT_A.tenantId, TENANT_B.tenantId],
        TENANT_A.tenantId,
      ]),
    );
    await insertRows(TENANT_A.tenantId, 'category', OWN_CATEGORIES);
    await insertRows(TENANT_B.tenantId, 'category', B_CATEGORIES);
    await insertRows(TENANT_UMBRELLA.tenantId, 'category', POOL_CATEGORIES);
    await insertRows(TENANT_A.tenantId, 'content_category_assign', A_ASSIGNMENTS);
    await insertRows(TENANT_B.tenantId, 'content_category_assign', B_ASSIGNMENTS);
    feedDeps = { db: feedHandle.app, repository: createContentRepository({ clock, schema: feedHandle.schema }), clock, config: CONTENT_CONFIG_DEFAULTS };
    recordedDeps = { ...feedDeps, db: recordingDb(feedHandle.app) };
  });

  afterAll(async () => {
    await feedHandle?.drop();
  });

  /** The SQL feed's outcome for a call, after asserting it equals the in-memory evaluation's for the same call. */
  async function compare(handler: EntityHandler, a: CallArgs): Promise<Struct> {
    const entityName = handler === categoryHandler ? 'category' : 'contentCategoryAssign';
    const expected = await outcomeOf(handler, a.method, callFor({ ...a, entityName }), readingDomain(feedDeps, callFor({ ...a, entityName })));
    const actual = await outcomeOf(handler, a.method, callFor({ ...a, entityName }), feedDeps);
    expect(actual).toEqual(expected);
    return actual;
  }

  /** The `data` of a compared outcome's wire body. */
  function bodyData(outcome: Struct): Struct {
    expect(outcome['body']).toEqual(expect.any(String));
    return (JSON.parse(String(outcome['body'])) as { data: Struct }).data;
  }

  const cases = (queries: readonly string[]): [string, 'findQuery' | 'findAll', string][] =>
    [TENANT_A, TENANT_B].flatMap((site) =>
      (['findQuery', 'findAll'] as const).flatMap((method) => queries.map((raw): [string, 'findQuery' | 'findAll', string] => [site.siteId, method, raw])),
    );
  const siteOf = (siteId: string): TenantFixture => (siteId === TENANT_B.siteId ? TENANT_B : TENANT_A);

  it.each(cases(CATEGORY_QUERIES))('category on %s: %s %s', async (siteId, method, raw) => {
    await compare(categoryHandler, { method, site: siteOf(siteId), url: urlOf(raw) });
  });

  it.each<[string, string[], string]>([
    ['case variants, repeats, padding, other tenants and a missing id', [K(3), K_MIXED.toLowerCase(), cfId('X', 1), K(3), 'short-id', 'SHORT-ID  ', KB(1), K(1).toLowerCase()], ''],
    ['the same ids under a URL sort', [K(3), K_MIXED.toLowerCase(), K(3), 'short-id', K(1)], 'sort=-name'],
    ['the same ids over the content pool', [K(1), KB(1), K(1).toUpperCase(), KB(4)], 'contentpoolid=*'],
    ['a page of the content pool, sorted', [K(1), KB(1), K(3), KB(4), K(5)], 'contentpoolid=*&sort=name&itemsPerPage=2&pageIndex=2'],
    ['ids no statement can bind', ['a\u0000b', '\uD800', K(7)], ''],
    ['countOnly, which findMany ignores', [K(1), K(2)], 'countOnly=true'],
    ['no ids', [], ''],
  ])('category findMany with %s', async (_label, ids, raw) => {
    await compare(categoryHandler, { method: 'findMany', ids, url: urlOf(raw) });
  });

  it.each(cases(ASSIGNMENT_QUERIES))('contentCategoryAssign on %s: %s %s', async (siteId, method, raw) => {
    await compare(contentCategoryAssignHandler, { method, site: siteOf(siteId), url: urlOf(raw) });
  });

  it.each<[string, TenantFixture, string[], string]>([
    ['ids and no URL sort', TENANT_A, [FH(1)], ''],
    ['ids and a URL sort', TENANT_A, [FH(1)], 'sort=-orderno'],
    ['ids over the content pool, paged', TENANT_A, [FH(1)], 'contentpoolid=*&sort=orderno&itemsPerPage=2&pageIndex=2'],
    ['no ids', TENANT_B, [], ''],
  ])('contentCategoryAssign findMany with %s', async (_label, site, ids, raw) => {
    await compare(contentCategoryAssignHandler, { method: 'findMany', site, ids, url: urlOf(raw) });
  });

  it.each<[string, TenantFixture]>([
    ['findOne', TENANT_A],
    ['findOne', TENANT_B],
    ['findOne', TENANT_UMBRELLA],
    ['findNew', TENANT_A],
  ])('contentCategoryAssign %s on %o answers the first joined assignment', async (method, site) => {
    await compare(contentCategoryAssignHandler, { method: method as Op, site, id: cfId('X', 3) });
  });

  it('answers the rows the in-memory evaluation selects, so the comparisons exercise the corpus', async () => {
    const categoryIds = async (a: CallArgs): Promise<unknown[]> =>
      (bodyData(await compare(categoryHandler, a))['items'] as Struct[]).map((item) => item['categoryid']);
    const padded = K_SHORT.padEnd(35);
    expect(await categoryIds({ method: 'findAll' })).toEqual([K(4), K(10), K(9), K(1), K(2), K(5), K(3), K_MIXED, K(6), padded, K(7)]);
    // The padded short id is read, but the `ids` reorder compares it untrimmed, so it drops out.
    expect(await categoryIds({ method: 'findMany', ids: [K(3), K_MIXED.toLowerCase(), K(3), 'short-id', KB(1)] })).toEqual([K(3), K_MIXED, K(3)]);
    expect(await categoryIds({ method: 'findMany', ids: ['short-id'], url: urlOf('sort=name') })).toEqual([padded]);
    expect(await categoryIds({ method: 'findQuery', url: urlOf('contentpoolid=*&name=alpha') })).toEqual([K(1), K(2), KB(1)]);
    const assignments = async (a: CallArgs): Promise<unknown[]> =>
      (bodyData(await compare(contentCategoryAssignHandler, a))['items'] as Struct[]).map((item) => [item['contenthistid'], item['categoryname']]);
    expect(await assignments({ method: 'findAll' })).toEqual([
      [FH(1), 'Alpha'],
      [FH(1), 'Pool Child'],
      [FH(2), 'Beta'],
      [FH(2), 'Pool Root'],
      [FH(3), 'Shadow Child'],
      [FH(3), 'Pool Shadow'],
      [FH(6), 'gamma_x'],
      [FH(9), 'Short'],
      [F_MIXED, 'ÁLPHA'],
      [FH(3).toLowerCase(), 'Orphan'],
    ]);
    // The bounded findQuery reads the version's case forms in category id order.
    const version = { method: 'findQuery', url: urlOf(`contenthistid=${FH(3)}`) } as const;
    expect(await assignments(version)).toEqual([
      [FH(3), 'Shadow Child'],
      [FH(3).toLowerCase(), 'Orphan'],
      [FH(3), 'Pool Shadow'],
    ]);
    const parents = (bodyData(await compare(contentCategoryAssignHandler, version))['items'] as Struct[]).map((item) => [item['parentname'], item['parentid']]);
    expect(parents).toEqual([
      ['Pool Shadow', K_MIXED.toLowerCase()],
      ['', cfId('Z', 9)],
      ['', ''],
    ]);
    expect(bodyData(await compare(contentCategoryAssignHandler, { method: 'findQuery', url: urlOf('countOnly=true') }))).toEqual({ count: '11' });
  });

  describe('statements', () => {
    /** The recorded statements over `table` (`category` or `content_category_assign`). */
    const reads = (table: string): { tenantId: string; sql: string; rows: number }[] =>
      statements.filter((s) => s.sql.includes(`"${feedHandle.schema}"."${table}"`));

    async function run(handler: EntityHandler, a: CallArgs): Promise<Struct[]> {
      statements.length = 0;
      const entityName = handler === categoryHandler ? 'category' : 'contentCategoryAssign';
      const outcome = await outcomeOf(handler, a.method, callFor({ ...a, entityName }), recordedDeps);
      return (bodyData(outcome)['items'] as Struct[] | undefined) ?? [];
    }

    it.each<[string, Struct, number]>([
      ['one site', { sort: 'name', itemsPerPage: '3', pageIndex: '2' }, 3],
      ['each of two content-pool sites', { contentpoolid: '*', sort: 'name', itemsPerPage: '2', pageIndex: '2' }, 4],
    ])('a category page reads at most offset + limit rows from %s', async (_label, url, bound) => {
      expect(await run(categoryHandler, { method: 'findQuery', url })).toHaveLength(Number(url['itemsPerPage']));
      const pages = reads('category').filter((s) => s.sql.includes(' LIMIT '));
      expect(new Set(pages.map((s) => s.tenantId)).size).toBe(url['contentpoolid'] === undefined ? 1 : 2);
      expect(pages.every((s) => s.rows <= bound)).toBe(true);
      expect(reads('category').every((s) => s.rows <= bound)).toBe(true);
      expect(OWN_CATEGORIES.length).toBeGreaterThan(bound);
    });

    it('a category findMany reads only the listed categories', async () => {
      expect(await run(categoryHandler, { method: 'findMany', ids: [K(3), K(1)] })).toHaveLength(2);
      expect(Math.max(...reads('category').map((s) => s.rows))).toBe(2);
    });

    it('an assignment page reads at most offset + limit assignment rows', async () => {
      expect(await run(contentCategoryAssignHandler, { method: 'findQuery', url: { itemsPerPage: '2', pageIndex: '2' } })).toHaveLength(2);
      expect(reads('content_category_assign').some((s) => s.sql.includes(' LIMIT '))).toBe(true);
      expect(reads('content_category_assign').every((s) => s.rows <= 2)).toBe(true);
    });

    it.each<[string, EntityHandler, string, boolean]>([
      ['a sort on the date-hinted featurestop', contentCategoryAssignHandler, 'sort=-featurestop%2Ccontenthistid&itemsPerPage=2', false],
      ['date, list and grouped filters', contentCategoryAssignHandler, 'openGrouping&featurestart=gt%5E2025-01-01&or&orderno=in%5E1%2C2&closeGrouping', false],
      ['a like on names', categoryHandler, 'name=*a*&sort=-isactive%2Cname&itemsPerPage=3', false],
      ['an `_` like over stored astral text', categoryHandler, 'name=like%5Ea_b', false],
      ['an `_` like matching stored astral text by code units', categoryHandler, 'name=like%5Ea__b&itemsPerPage=1', false],
      ['a NUL in an equality criteria', categoryHandler, 'name=Al%00pha&itemsPerPage=2', false],
      ['a NUL in an in list', categoryHandler, 'name=in%5EAl%00pha%2C%00&itemsPerPage=2', false],
    ])('%s reads the whole scope only when SQL cannot evaluate it exactly', async (_label, handler, raw, whole) => {
      await compare(handler, { method: 'findQuery', url: urlOf(raw) });
      await run(handler, { method: 'findQuery', url: urlOf(raw) });
      const table = handler === categoryHandler ? 'category' : 'content_category_assign';
      const scans = reads(table).filter((s) => !s.sql.includes(' LIMIT ') && !s.sql.includes('count(*)') && !s.sql.includes('EXISTS'));
      expect(scans.length > 0).toBe(whole);
    });

    it.each(['findOne', 'findNew'] as const)('%s reads one assignment row, not the site', async (method) => {
      statements.length = 0;
      const outcome = await outcomeOf(contentCategoryAssignHandler, method, callFor({ method, entityName: 'contentCategoryAssign', id: cfId('X', 3) }), recordedDeps);
      expect(bodyData(outcome)).toMatchObject({ contenthistid: FH(1), categoryid: K(1), categoryname: 'Alpha', isnew: 0 });
      const first = reads('content_category_assign').filter((s) => s.sql.includes(' LIMIT '));
      expect(first.map((s) => s.rows)).toEqual([1]);
      expect(reads('content_category_assign').every((s) => s.rows <= 1)).toBe(true);
    });
  });
});
