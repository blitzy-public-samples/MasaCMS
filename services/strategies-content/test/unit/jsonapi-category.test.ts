// JSON API `category` and `contentCategoryAssign` handlers over a throwaway `content` schema with tenant-a, tenant-b and
// umbrella registered. Expected shapes follow what Masa 7.6.1 on ACF 2023 answers for the same calls.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { buildEnvelope, isCfUuid, LegacyApiError, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
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
import { createCategory, readCategory, setCategoryAssignments, type CategoryBean } from '../../src/domain/categories.js';
import {
  actorFromClaims,
  CONTENT_CONFIG_DEFAULTS,
  type Actor,
  type DomainDeps,
  type SiteContentSettings,
} from '../../src/domain/context.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { categoryHandler, contentCategoryAssignHandler } from '../../src/routes/jsonapi/category.js';
import { createJsonApiParams, type EntityHandler, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';

type Struct = Record<string, unknown>;
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

const clock = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 456));
const PORT = 8080;
const POOL = TENANT_UMBRELLA.siteId;
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const C1 = cfId('C', 1);
const H1 = cfId('H', 1);
const H2 = cfId('H', 2);

function actor(site: TenantFixture, roles: string[]): Actor {
  const claims: UserClaims = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: cfId('U', 1),
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
    customImageSizes: [],
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

    it.each([
      ['anonymous', ANONYMOUS, undefined, { read: true, delete: false, save: false }],
      ['the Categories module user on a pool category', EDITOR_A, () => CHILD.categoryid, { read: true, delete: true, save: true }],
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
