// JSON API `changeset` and `changesetCategoryAssignment` handlers over a throwaway `content` schema with tenant-a and
// tenant-b registered. Expected shapes follow what Masa 7.6.1 on ACF 2023 answers for the same calls.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { buildEnvelope, isCfUuid, LegacyApiError, LegacyServiceUnavailableError, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { actorFromClaims, CONTENT_CONFIG_DEFAULTS, type Actor, type DomainDeps, type SiteContentSettings } from '../../src/domain/context.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { changesetCategoryAssignmentHandler, changesetHandler } from '../../src/routes/jsonapi/changeset.js';
import { createJsonApiParams, type EntityHandler, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';

type Struct = Record<string, unknown>;
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'save' | 'delete';
type Entity = 'changeset' | 'changesetCategoryAssignment';

const clock = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 456));
const PORT = 8080;
const cfId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(7, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
const CAT_1 = cfId('A', 1);
const CAT_2 = cfId('A', 2);
const MISSING = cfId('F', 9);

function actor(site: TenantFixture, roles: string[], s2 = false): Actor {
  const claims: UserClaims = {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: cfId('E', 1),
    sid: 'session-1',
    tid: site.tenantId,
    site: site.siteId,
    roles,
    s2,
    epoch: 1,
    iat: 0,
    exp: 0,
  };
  return actorFromClaims(claims, 'Admin User');
}

const ANONYMOUS = actorFromClaims(undefined, '');
const MEMBER_A = actor(TENANT_A, ['member']);
/** tenant-a's Site Manager user: the assignment module, not Change Sets. */
const EDITOR_A = actor(TENANT_A, ['system-user', 'm:000']);
/** tenant-a's Change Sets module user. */
const PUBLISHER_A = actor(TENANT_A, ['system-user', 'm:014']);
/** tenant-a's user of both modules. */
const MANAGER_A = actor(TENANT_A, ['system-user', 'm:014', 'm:000']);
const ADMIN_A = actor(TENANT_A, ['site-admin']);
const PUBLISHER_B = actor(TENANT_B, ['system-user', 'm:014']);

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
  entityName: Entity;
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
    routeKey: `api:${a.entityName.toLowerCase()}.${a.method.toLowerCase()}`,
    method: a.method,
    entityName: a.entityName,
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.ids === undefined ? {} : { ids: a.ids }),
    pathInfo: [site.siteId, a.entityName],
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

/** Runs `op` of the changeset handler for a call built from `a`. */
function onChangeset(op: Op, a: Omit<CallArgs, 'method' | 'entityName'> = {}): Promise<JsonApiResult> {
  return invoke(changesetHandler, op, callFor({ ...a, method: op, entityName: 'changeset' }));
}

/** Runs `op` of the changesetCategoryAssignment handler for a call built from `a`. */
function onAssignment(op: Op, a: Omit<CallArgs, 'method' | 'entityName'> = {}): Promise<JsonApiResult> {
  return invoke(changesetCategoryAssignmentHandler, op, callFor({ ...a, method: op, entityName: 'changesetCategoryAssignment' }));
}

/** The `data` of `result` as the JSON API puts it on the wire (envelope serializer and the entity's coercions). */
function wire(method: string, result: JsonApiResult): Struct {
  expect(result.error).toBeUndefined();
  const serializer = contentApiSerializer(result.serializerEntity ?? '');
  const { body } = serializeResponse(buildEnvelope({ method, data: result.data }), { serializer });
  return (JSON.parse(body) as { data: Struct }).data;
}

const itemsOf = (data: Struct): Struct[] => data['items'] as Struct[];
const linksOf = (data: Struct): Struct => data['links'] as Struct;
const EP_A = endpointOf(TENANT_A.siteId);

/** The `content.<table>` rows tenant `tenantId` holds. */
function rowCount(table: string, tenantId: string): Promise<number> {
  return withTenant(handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.${table}`);
    return rows[0]?.n ?? 0;
  });
}

/** Saves a new change set in `site` as `who` and answers its wire data. */
async function createChangeset(form: Struct, who: Actor = PUBLISHER_A, site: TenantFixture = TENANT_A): Promise<Struct> {
  return wire('save', await onChangeset('save', { site, actor: who, id: 'new', form }));
}

let SPRING: Struct;
let AUTUMN: Struct;

describe.skipIf(!(await pgAvailable()))('JSON API changeset and changesetCategoryAssignment handlers', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await closeGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-changeset-test', allowLegacy: true });
    await openGates(handle.app, { units: CONTENT_UNITS, holderId: 'jsonapi-changeset-test', state: 'open' });
    await seedRegistry(handle.app);
    deps = { db: handle.app, repository: createContentRepository({ clock, schema: handle.schema }), clock, config: CONTENT_CONFIG_DEFAULTS };
    SPRING = await createChangeset({ name: 'Spring Launch', description: 'Seasonal', categoryid: `${CAT_1},${CAT_2}`, tags: 'season' });
    AUTUMN = await createChangeset({ name: 'Autumn Launch', publishdate: '2026-07-01 10:15:42' });
    await createChangeset({ name: 'Bee Launch' }, PUBLISHER_B, TENANT_B);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  describe('changeset access', () => {
    it.each([
      ['anonymous', ANONYMOUS],
      ['a member', MEMBER_A],
      ['a Site Manager user without Change Sets', EDITOR_A],
    ])('refuses %s every read and write', async (_label, who) => {
      for (const op of ['findOne', 'findMany', 'findAll', 'findQuery', 'findNew'] as const) {
        expect(await onChangeset(op, { actor: who, id: String(SPRING['id']), ids: [String(SPRING['id'])] })).toEqual({ error: 'authorization' });
      }
      const save = callFor({ method: 'save', entityName: 'changeset', actor: who, id: 'new', form: { name: 'Denied' } });
      expect(await invoke(changesetHandler, 'save', save)).toEqual({ error: 'authorization' });
      // save validates the token before AllowAction, as legacy does.
      expect(save.validateCsrf).toHaveBeenCalledTimes(1);
      const remove = callFor({ method: 'delete', entityName: 'changeset', actor: who, id: String(SPRING['id']) });
      expect(await invoke(changesetHandler, 'delete', remove)).toEqual({ error: 'authorization' });
      expect(remove.validateCsrf).not.toHaveBeenCalled();
      expect(await rowCount('changeset', TENANT_A.tenantId)).toBe(2);
    });

    it('answers findPermissions and findProperties without an access check', async () => {
      const id = String(SPRING['id']);
      expect(wire('findPermissions', await onChangeset('findPermissions', { id }))).toEqual({ read: false, delete: false, save: false });
      expect(wire('findPermissions', await onChangeset('findPermissions', { actor: PUBLISHER_A, id }))).toEqual({
        read: true,
        delete: true,
        save: true,
      });
      expect(wire('findPermissions', await onChangeset('findPermissions', { actor: PUBLISHER_A, id: 'permissions' }))).toEqual({
        read: true,
        delete: true,
        save: true,
      });
      const anonymous = wire('findProperties', await onChangeset('findProperties'));
      expect(anonymous).not.toHaveProperty('table');
      expect(anonymous).toMatchObject({ primarykey: 'changesetid', bundleable: false, orderby: '', entityname: 'changeset' });
    });
  });

  describe('changeset reads', () => {
    it('findOne reads the stored change set with its category and tag lists and relation links', async () => {
      const id = String(SPRING['id']);
      const data = wire('findOne', await onChangeset('findOne', { actor: PUBLISHER_A, id }));
      expect(data).toMatchObject({
        id,
        changesetid: id,
        siteid: TENANT_A.siteId,
        name: 'Spring Launch',
        description: 'Seasonal',
        published: 0,
        publishdate: '',
        lastupdateby: 'Admin User',
        lastupdatebyid: PUBLISHER_A.userId,
        isnew: 0,
        entityname: 'changeset',
        tags: 'season',
      });
      expect(String(data['categoryid']).split(',').sort()).toEqual([CAT_1, CAT_2]);
      expect(data).not.toHaveProperty('errors');
      expect(linksOf(data)).toEqual({
        all: `${EP_A}/changeset`,
        permissions: `${EP_A}/changeset/${id}/permissions`,
        properties: `${EP_A}/changeset/properties`,
        categoryassignments: `${EP_A}/changesetCategoryAssignment?changesetID=${id}`,
        self: `${EP_A}/changeset/${id}`,
        entities: EP_A,
        contentassignments: `${EP_A}/content?changesetID=${id}`,
      });
    });

    it.each([
      ['a missing id', TENANT_A, PUBLISHER_A, MISSING],
      ["another site's change set", TENANT_B, PUBLISHER_B, ''],
    ])('findOne answers a new bean of the request site under a fresh id for %s', async (_label, site, who, id) => {
      const requested = id === '' ? String(SPRING['id']) : id;
      const data = wire('findOne', await onChangeset('findOne', { site, actor: who, id: requested }));
      expect(data).toMatchObject({ siteid: site.siteId, name: '', isnew: 1, categoryid: '', tags: '', lastupdateby: 'Admin User' });
      expect(isCfUuid(String(data['id']))).toBe(true);
      expect(data['id']).not.toBe(requested);
      expect(data['created']).toBe('2026-06-30T10:00:00');
    });

    it('findNew answers a new bean of the request site without expanding', async () => {
      const data = wire('findNew', await onChangeset('findNew', { actor: PUBLISHER_A, url: { expand: 'categoryassignments' } }));
      expect(data).toMatchObject({ siteid: TENANT_A.siteId, isnew: 1, published: 0, entityname: 'changeset' });
      expect(data).not.toHaveProperty('categoryassignments');
      expect(isCfUuid(String(data['changesetid']))).toBe(true);
    });

    it('findAll lists the site\'s change sets by name; iterator items stay new without category lists', async () => {
      const data = wire('findAll', await onChangeset('findAll', { actor: PUBLISHER_A }));
      expect(itemsOf(data).map((item) => item['name'])).toEqual(['Autumn Launch', 'Spring Launch']);
      expect(itemsOf(data)[1]).toMatchObject({ id: SPRING['id'], isnew: 1, categoryid: '', tags: '', description: 'Seasonal' });
      expect(data).toMatchObject({ totalitems: 2, itemsperpage: 1000, entityname: 'changeset' });
      expect(itemsOf(data)[0]?.['publishdate']).toBe('2026-07-01T10:15:00');
    });

    it('findQuery filters, ignores an unknown sortBy and counts', async () => {
      const data = wire('findQuery', await onChangeset('findQuery', { actor: PUBLISHER_A, url: { name: 'Spring*', sortBy: 'bogus' } }));
      expect(itemsOf(data).map((item) => item['name'])).toEqual(['Spring Launch']);
      expect(linksOf(data)['self']).toBe(`${EP_A}/changeset/?name=Spring*&sortBy=bogus&pageIndex=1`);
      const counted = wire('findQuery', await onChangeset('findQuery', { actor: PUBLISHER_A, url: { countOnly: 'true' } }));
      expect(counted).toEqual({ count: '2' });
    });

    it.each([
      ['lastupdatebyid, a value without a property', { lastupdatebyid: 'x' }, 'invalidParameters'],
      ['addobjects', { addobjects: '1' }, 'invalidParameters'],
      ['tags, a property without a column', { tags: 'x' }, 'server_error'],
    ])('findQuery rejects %s', async (_label, url, type) => {
      await expect(onChangeset('findQuery', { actor: PUBLISHER_A, url })).rejects.toMatchObject({ type });
    });

    it('findQuery selects only the listed columns; other listed fields keep the iterator template values', async () => {
      const data = wire('findQuery', await onChangeset('findQuery', { actor: PUBLISHER_A, url: { name: 'Spring Launch', fields: 'name,tags' } }));
      expect(itemsOf(data)).toEqual([
        { name: 'Spring Launch', tags: '', changesetid: SPRING['id'], id: SPRING['id'], siteid: '', isnew: 1, entityname: 'changeset' },
      ]);
    });

    it('findMany keeps the ids order unless the URL sorts', async () => {
      const ids = [String(SPRING['id']), MISSING, String(AUTUMN['id'])];
      const listed = wire('findMany', await onChangeset('findMany', { actor: PUBLISHER_A, ids }));
      expect(itemsOf(listed).map((item) => item['name'])).toEqual(['Spring Launch', 'Autumn Launch']);
      const sorted = wire('findMany', await onChangeset('findMany', { actor: PUBLISHER_A, ids, url: { sort: 'name' } }));
      expect(itemsOf(sorted).map((item) => item['name'])).toEqual(['Autumn Launch', 'Spring Launch']);
    });

    it('reads only the request site\'s change sets', async () => {
      const data = wire('findAll', await onChangeset('findAll', { site: TENANT_B, actor: PUBLISHER_B }));
      expect(itemsOf(data).map((item) => item['name'])).toEqual(['Bee Launch']);
    });

    it.each([
      ['every property in getProperties order', {}, 17],
      ['the requested persistent properties in request order', { properties: 'name,isnew,siteid' }, 2],
    ])('findProperties lists %s', async (_label, url, count) => {
      const data = wire('findProperties', await onChangeset('findProperties', { actor: ADMIN_A, url }));
      const properties = data['properties'] as Struct[];
      expect(properties).toHaveLength(count);
      expect(data).toMatchObject({ table: 'tchangesets', bundleable: false });
      if (count === 2) {
        expect(properties.map((p) => p['name'])).toEqual(['name', 'siteid']);
        expect(properties[0]).toEqual({
          fieldtype: '',
          length: '50',
          required: 'true',
          html: 'false',
          nullable: false,
          name: 'name',
          datatype: 'varchar',
          default: '',
        });
      } else {
        expect(properties[0]).toMatchObject({ fieldtype: 'id', name: 'changesetid', datatype: 'char', length: '35' });
        expect(properties.find((p) => p['name'] === 'categoryassignments')).toMatchObject({
          fieldtype: 'one-to-many',
          relatesto: 'changesetCategoryAssignment',
          default: 'null',
        });
      }
    });

    it('findProperties fails on an unknown property, as props[p] does', async () => {
      await expect(onChangeset('findProperties', { url: { properties: 'bogus' } })).rejects.toMatchObject({ type: 'server_error' });
    });

    it('fails closed on url.ishuman', async () => {
      await expect(onChangeset('findOne', { actor: PUBLISHER_A, id: MISSING, url: { ishuman: '1' } })).rejects.toBeInstanceOf(
        LegacyServiceUnavailableError,
      );
      await expect(onChangeset('findNew', { actor: PUBLISHER_A, url: { ishuman: '' } })).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    });
  });

  describe('changeset writes', () => {
    it('save creates a change set, stamps the actor and answers the reload', async () => {
      const call = callFor({ method: 'save', entityName: 'changeset', actor: PUBLISHER_A, id: 'new', form: { name: '  Winter  ', published: 'x' } });
      const result = await invoke(changesetHandler, 'save', call);
      expect(result.status).toBe(200);
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      const data = wire('save', result);
      expect(data).toMatchObject({ name: 'Winter', published: 0, isnew: 0, siteid: TENANT_A.siteId, saveerrors: '', errors: {} });
      expect(data['lastupdatebyid']).toBe(PUBLISHER_A.userId);
      expect(data['id']).toBe(data['changesetid']);
      const reread = wire('findOne', await onChangeset('findOne', { actor: PUBLISHER_A, id: String(data['id']) }));
      expect(reread).toMatchObject({ name: 'Winter', isnew: 0 });
      await onChangeset('delete', { actor: PUBLISHER_A, id: String(data['id']) });
    });

    it('save without a name answers 403 with the request values on the reloaded bean and stores nothing', async () => {
      const before = await rowCount('changeset', TENANT_A.tenantId);
      const result = await onChangeset('save', { actor: PUBLISHER_A, id: 'new', form: { name: '', description: 'kept', isNew: '7' } });
      expect(result.status).toBe(403);
      const data = wire('save', result);
      expect(data['errors']).toEqual({ name: "The property named 'name' is not valid" });
      // The isNew hint serializes the stored request text as a number.
      expect(data).toMatchObject({ description: 'kept', isnew: 7, saveerrors: '', name: '' });
      expect(await rowCount('changeset', TENANT_A.tenantId)).toBe(before);
    });

    it('save with saveErrors true skips the overlay', async () => {
      const result = await onChangeset('save', { actor: PUBLISHER_A, id: 'new', form: { name: '', description: 'dropped', saveErrors: 'true' } });
      expect(result.status).toBe(403);
      // The serializer writes the stored 'true' text as a boolean.
      expect(wire('save', result)).toMatchObject({ description: '', saveerrors: true });
    });

    it('save of a path id no row holds, without a changesetid value, stores the bean under a fresh id', async () => {
      const data = wire('save', await onChangeset('save', { actor: PUBLISHER_A, id: MISSING, form: { name: 'Fresh' } }));
      expect(data['id']).not.toBe(MISSING);
      expect(data).toMatchObject({ name: 'Fresh', isnew: 0 });
      await onChangeset('delete', { actor: PUBLISHER_A, id: String(data['id']) });
    });

    it('save updates a stored change set by its changesetid value and keeps unsupplied values', async () => {
      const id = String(AUTUMN['id']);
      const data = wire('save', await onChangeset('save', { actor: PUBLISHER_A, form: { changesetid: id, description: 'Harvest' } }));
      expect(data).toMatchObject({ id, name: 'Autumn Launch', description: 'Harvest', publishdate: '2026-07-01T10:15:00', isnew: 0 });
    });

    it('save with a refused token answers invalidTokens and stores nothing', async () => {
      const before = await rowCount('changeset', TENANT_A.tenantId);
      expect(await onChangeset('save', { actor: PUBLISHER_A, id: 'new', form: { name: 'Nope' }, csrf: false })).toEqual({ error: 'invalidTokens' });
      expect(await rowCount('changeset', TENANT_A.tenantId)).toBe(before);
    });

    it('delete of a missing id answers \'\' without consuming a token', async () => {
      const call = callFor({ method: 'delete', entityName: 'changeset', actor: PUBLISHER_A, id: MISSING });
      expect(await invoke(changesetHandler, 'delete', call)).toEqual({ status: 200, data: '' });
      expect(call.validateCsrf).not.toHaveBeenCalled();
    });

    it('delete checks the token, then throws the change set in the trash and removes it with its assignments', async () => {
      const created = await createChangeset({ name: 'Temporary', categoryid: CAT_1 });
      const id = String(created['id']);
      expect(await onChangeset('delete', { actor: PUBLISHER_A, id, csrf: false })).toEqual({ error: 'invalidTokens' });
      const trashBefore = await rowCount('trash', TENANT_A.tenantId);
      const call = callFor({ method: 'delete', entityName: 'changeset', actor: PUBLISHER_A, form: { changesetid: id } });
      expect(await invoke(changesetHandler, 'delete', call)).toEqual({ status: 200, data: '' });
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      expect(await rowCount('trash', TENANT_A.tenantId)).toBe(trashBefore + 1);
      expect(wire('findOne', await onChangeset('findOne', { actor: PUBLISHER_A, id }))).toMatchObject({ isnew: 1 });
    });
  });

  describe('changeset relation expansion', () => {
    it('findOne expands categoryAssignments through the assignment feed', async () => {
      const id = String(SPRING['id']);
      const data = wire('findOne', await onChangeset('findOne', { actor: MANAGER_A, id, url: { expand: 'categoryassignments' } }));
      const expanded = data['categoryassignments'] as Struct;
      expect(expanded).toMatchObject({ totalitems: 2, itemsperpage: 1000, entityname: 'changesetCategoryAssignment' });
      expect(linksOf(expanded)['self']).toBe(`${EP_A}/changesetCategoryAssignment/?changesetID=${id}&pageIndex=1`);
      expect(itemsOf(expanded).map((item) => item['categoryid']).sort()).toEqual([CAT_1, CAT_2]);
      expect(itemsOf(expanded)[0]).toMatchObject({ changesetid: id, siteid: TENANT_A.siteId, isnew: 0 });
    });

    it('refuses the expansion without the assignment module and fails closed on contentAssignments', async () => {
      const id = String(SPRING['id']);
      await expect(onChangeset('findOne', { actor: PUBLISHER_A, id, url: { expand: 'categoryassignments' } })).rejects.toBeInstanceOf(LegacyApiError);
      await expect(onChangeset('findOne', { actor: MANAGER_A, id, url: { expand: 'contentassignments' } })).rejects.toBeInstanceOf(
        LegacyServiceUnavailableError,
      );
    });
  });

  describe('changesetCategoryAssignment', () => {
    it('refuses a caller without the Site Manager module', async () => {
      for (const op of ['findOne', 'findAll', 'findQuery', 'findNew'] as const) {
        expect(await onAssignment(op, { actor: PUBLISHER_A, id: MISSING })).toEqual({ error: 'authorization' });
      }
      expect(await onAssignment('save', { actor: PUBLISHER_A, id: 'new', form: { categoryid: CAT_1 } })).toEqual({ error: 'authorization' });
    });

    it('findOne of a missing id answers the bean loadBy leaves', async () => {
      const data = wire('findOne', await onAssignment('findOne', { actor: EDITOR_A, id: MISSING }));
      expect(data).toEqual({
        changesetid: '',
        categoryid: '',
        assignmentid: MISSING,
        siteid: TENANT_A.siteId,
        cachedwithin: '0',
        returnformat: 'self',
        id: MISSING,
        isnew: 1,
        entityname: 'changesetCategoryAssignment',
        links: {
          all: `${EP_A}/changesetCategoryAssignment`,
          site: `${EP_A}/site`,
          permissions: `${EP_A}/changesetCategoryAssignment/${MISSING}/permissions`,
          properties: `${EP_A}/changesetCategoryAssignment/properties`,
          self: `${EP_A}/changesetCategoryAssignment/${MISSING}`,
          entities: EP_A,
        },
      });
    });

    it('save stores, reads, lists and deletes an assignment', async () => {
      const changesetId = String(AUTUMN['id']);
      const saveCall = callFor({
        method: 'save',
        entityName: 'changesetCategoryAssignment',
        actor: EDITOR_A,
        id: 'new',
        form: { changesetid: changesetId, categoryid: ` ${CAT_2} ` },
      });
      const saved = wire('save', await invoke(changesetCategoryAssignmentHandler, 'save', saveCall));
      expect(saveCall.validateCsrf).toHaveBeenCalledTimes(1);
      expect(saved).toMatchObject({ changesetid: changesetId, categoryid: CAT_2, siteid: TENANT_A.siteId, isnew: 0, saveerrors: false, errors: {} });
      const id = String(saved['id']);
      expect(isCfUuid(id)).toBe(true);
      expect(linksOf(saved)['changeset']).toBe(`${EP_A}/changeset/${changesetId}`);

      expect(wire('findOne', await onAssignment('findOne', { actor: EDITOR_A, id }))).toMatchObject({ assignmentid: id, isnew: 0 });
      const listed = wire('findQuery', await onAssignment('findQuery', { actor: EDITOR_A, url: { changesetid: changesetId } }));
      expect(itemsOf(listed).map((item) => item['id'])).toEqual([id]);
      expect(wire('findQuery', await onAssignment('findQuery', { actor: EDITOR_A, url: { changeset: 'x' } }))['totalitems']).toBe(3);
      expect(wire('findMany', await onAssignment('findMany', { actor: EDITOR_A, ids: [id] }))['totalitems']).toBe(1);

      const updated = wire('save', await onAssignment('save', { actor: EDITOR_A, form: { assignmentid: id, categoryid: CAT_1, saveErrors: 'yes' } }));
      expect(updated).toMatchObject({ id, changesetid: changesetId, categoryid: CAT_1, saveerrors: true });

      const permissions = wire('findPermissions', await onAssignment('findPermissions', { actor: EDITOR_A, id }));
      expect(permissions).toEqual({ read: true, delete: true, save: true });

      const missing = callFor({ method: 'delete', entityName: 'changesetCategoryAssignment', actor: EDITOR_A, id: MISSING });
      expect(await invoke(changesetCategoryAssignmentHandler, 'delete', missing)).toEqual({ status: 200, data: '' });
      expect(missing.validateCsrf).not.toHaveBeenCalled();
      expect(await onAssignment('delete', { actor: PUBLISHER_A, id })).toEqual({ error: 'authorization' });
      expect(await onAssignment('delete', { actor: EDITOR_A, id, csrf: false })).toEqual({ error: 'invalidTokens' });
      expect(await onAssignment('delete', { actor: EDITOR_A, id })).toEqual({ status: 200, data: '' });
      expect(wire('findOne', await onAssignment('findOne', { actor: EDITOR_A, id }))).toMatchObject({ isnew: 1 });
    });

    it('expands its changeset through the changeset findOne and fails closed on category and site', async () => {
      const data = wire('findNew', await onAssignment('findNew', { actor: MANAGER_A }));
      expect(data).toMatchObject({ siteid: TENANT_A.siteId, isnew: 1, cachedwithin: '0' });
      const found = await onAssignment('findOne', { actor: MANAGER_A, id: MISSING, url: { expand: 'changeset' } });
      expect(wire('findOne', found)['changeset']).toMatchObject({ siteid: TENANT_A.siteId, isnew: 1, entityname: 'changeset' });
      await expect(onAssignment('findOne', { actor: EDITOR_A, id: MISSING, url: { expand: 'changeset' } })).rejects.toBeInstanceOf(LegacyApiError);
      for (const expand of ['category', 'site']) {
        await expect(onAssignment('findOne', { actor: MANAGER_A, id: MISSING, url: { expand } })).rejects.toBeInstanceOf(
          LegacyServiceUnavailableError,
        );
      }
    });

    it('findProperties answers the ORM metadata', async () => {
      const data = wire('findProperties', await onAssignment('findProperties', { actor: ADMIN_A }));
      expect((data['properties'] as Struct[]).map((p) => p['name'])).toEqual(['site', 'category', 'changeset', 'assignmentid']);
      expect(data).toMatchObject({ bundleable: 'true', table: 'tchangesetcategoryassign', primarykey: 'assignmentid' });
    });
  });
});
