// JSON API `changeset` and `changesetCategoryAssignment` handlers over a throwaway `content` schema with tenant-a and
// tenant-b registered. Expected shapes follow what Masa 7.6.1 on ACF 2023 answers for the same calls.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { buildEnvelope, isCfUuid, LegacyApiError, LegacyServiceUnavailableError, serializeResponse } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { withTenant, type QueryResultRow, type TenantTx } from '@opt2/platform/tenancy';
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
import { actorFromClaims, CONTENT_CONFIG_DEFAULTS, type Actor, type DomainDeps, type SiteContentSettings } from '../../src/domain/context.js';
import type { LegacySiteUrlConfig } from '../../src/legacy/content-urls.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { FeedRunner, FeedTableSpec } from '../../src/repo/bean-feed-sql.js';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { changesetCategoryAssignmentHandler, changesetHandler } from '../../src/routes/jsonapi/changeset.js';
import {
  createJsonApiParams,
  rowsSource,
  type BeanFeedSource,
  type EntityHandler,
  type JsonApiCall,
  type JsonApiResult,
} from '../../src/routes/jsonapi/types.js';

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

/** Runs `op` of `handler` for `call` over `domain`. */
function invokeWith(domain: DomainDeps, handler: EntityHandler, op: Op, call: JsonApiCall): Promise<JsonApiResult> {
  const fn = handler[op];
  if (fn === undefined) throw new Error(`${handler.entity} has no ${op}`);
  return fn({ domain } as unknown as ContentRouteContext, call);
}

/** What a handler over `domain` answered on the wire or raised for a call built from `a`, with the URL scope the call left. */
async function outcomeOf(domain: DomainDeps, a: CallArgs): Promise<unknown> {
  const call = callFor(a);
  const handler = a.entityName === 'changeset' ? changesetHandler : changesetCategoryAssignmentHandler;
  try {
    const result = await invokeWith(domain, handler, a.method, call);
    if (result.error !== undefined) return { result, url: { ...call.apiContext.url } };
    return { status: result.status, data: wire(a.method, result), url: { ...call.apiContext.url } };
  } catch (err) {
    const error = err as Error & { type?: unknown };
    return { error: { name: error.constructor.name, message: error.message, type: error.type } };
  }
}

/** The id equality the whole-site findMany filter applied: case-insensitive, trailing spaces ignored. */
const sqlKey = (value: unknown): string => (typeof value === 'string' ? value : '').replace(/ +$/u, '').toLowerCase();

/** The rows the whole-site reads returned: each site table in primary-key order without its tenant column. */
interface WholeSite {
  changesets: Struct[];
  assignments: Struct[];
}

/** `domain` whose change-set feeds read `site` through the in-memory evaluator, findMany's ids picked by {@link sqlKey}. */
function inMemoryDeps(domain: DomainDeps, site: WholeSite): DomainDeps {
  const repository = domain.repository;
  const held = new WeakMap<FeedTableSpec, Struct[]>();
  const pick = (rows: Struct[], key: string, ids: readonly string[] | undefined): Struct[] => {
    if (ids === undefined) return rows;
    const wanted = new Set(ids.map(sqlKey));
    return rows.filter((row) => wanted.has(sqlKey(row[key])));
  };
  const changesets: ContentRepository['changesets'] = {
    ...repository.changesets,
    siteChangesetsFeed(args) {
      const spec = repository.changesets.siteChangesetsFeed(args);
      held.set(spec, pick(site.changesets, 'changesetid', args.changesetIds));
      return spec;
    },
    siteCategoryAssignmentsFeed(args) {
      const spec = repository.changesets.siteCategoryAssignmentsFeed(args);
      held.set(spec, pick(site.assignments, 'assignmentid', args.assignmentIds));
      return spec;
    },
  };
  const beanFeed: ContentRepository['beanFeed'] = {
    source: <R extends QueryResultRow>(_run: FeedRunner, spec: FeedTableSpec): BeanFeedSource<R> =>
      rowsSource(held.get(spec) ?? []) as unknown as BeanFeedSource<R>,
  };
  return { ...domain, repository: { ...repository, changesets, beanFeed } };
}

/** A transaction handle that records each statement and the rows it returned. */
function recording(tx: TenantTx, statements: { sql: string; rows: number }[]): TenantTx {
  return {
    kind: tx.kind,
    tenantId: tx.tenantId,
    schema: tx.schema,
    onCommit: (cb, onError) => {
      tx.onCommit(cb, onError);
    },
    query: (async (text: string | { text: string }, values?: unknown[]) => {
      const result = await tx.query(text, values);
      statements.push({ sql: typeof text === 'string' ? text : text.text, rows: result.rows.length });
      return result;
    }) as TenantTx['query'],
  };
}

/** `domain` recording every feed statement, and counting the whole-site reads of both tables. */
function recordingDeps(domain: DomainDeps, statements: { sql: string; rows: number }[], wholeSiteReads: { n: number }): DomainDeps {
  const repository = domain.repository;
  const changesets: ContentRepository['changesets'] = {
    ...repository.changesets,
    siteChangesets(tx, args) {
      wholeSiteReads.n++;
      return repository.changesets.siteChangesets(tx, args);
    },
    siteCategoryAssignments(tx, args) {
      if (args.assignmentId === undefined) wholeSiteReads.n++;
      return repository.changesets.siteCategoryAssignments(tx, args);
    },
  };
  const beanFeed: ContentRepository['beanFeed'] = {
    source: <R extends QueryResultRow>(run: FeedRunner, spec: FeedTableSpec): BeanFeedSource<R> =>
      repository.beanFeed.source<R>((fn) => run((tx) => fn(recording(tx, statements))), spec),
  };
  return { ...domain, repository: { ...repository, changesets, beanFeed } };
}

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

  describe('SQL feeds against the in-memory evaluator over the whole-site rows', () => {
    const SITE = TENANT_UMBRELLA;
    const OTHER_SITE = 'umbrella-other';
    const WHO = actor(TENANT_UMBRELLA, ['system-user', 'm:014', 'm:000']);
    const MIXED = 'MiXeD001-aaaa-BBBB-ccccDDDDeeeeFFFF';
    const LOWER = cfId('c', 3).toLowerCase();
    const SHORT = 'short-id';
    const C = (n: number): string => cfId('C', n);
    const D = (n: number): string => cfId('D', n);
    const day = (month: number, date: number, hours = 0, minutes = 0): Date => new Date(2026, month - 1, date, hours, minutes);

    const CHANGESETS: Struct[] = [
      { changesetid: C(1), name: 'Alpha', description: 'first', created: day(1, 5), publishdate: day(7, 1, 10, 15), published: 0, lastupdateby: 'Ann' },
      { changesetid: C(2), name: 'alpha', description: null, created: day(1, 5), published: 1, lastupdate: day(2, 1), closedate: day(3, 1) },
      { changesetid: LOWER, name: 'Beta ', created: day(2, 1), publishdate: day(7, 1, 10, 15), published: 0, remoteid: 'R1' },
      { changesetid: MIXED, name: 'beta', created: day(3, 1), published: null, remotepubdate: day(4, 1) },
      { changesetid: SHORT, name: 'Gamma_Launch', created: day(3, 1), publishdate: day(1, 1), published: 1 },
      { changesetid: C(6), name: null, created: null, published: 0 },
      { changesetid: C(7), name: '', description: '', created: day(5, 5), published: 0 },
      { changesetid: C(8), name: 'a\u{1F600}b', created: day(6, 1), published: 2 },
      { changesetid: C(9), name: 'Ünïcode', created: day(6, 2), publishdate: day(8, 1), published: 0 },
      { changesetid: C(10), name: 'Zed', created: day(6, 3), publishdate: day(7, 1, 10, 15), published: 1, lastupdatebyid: cfId('E', 1) },
      { changesetid: C(11), name: 'Delta 50%', created: day(6, 4), published: 0 },
      { changesetid: C(12), siteid: OTHER_SITE, name: 'Other site', created: day(1, 1), published: 0 },
    ].map((row) => ({ siteid: SITE.siteId, ...row }));

    const ASSIGNMENTS: Struct[] = [
      { assignmentid: D(1), changesetid: C(1), categoryid: CAT_1 },
      { assignmentid: D(2), changesetid: C(1).toLowerCase(), categoryid: CAT_2 },
      { assignmentid: 'dShort', changesetid: C(1), categoryid: null },
      { assignmentid: cfId('d', 4).toLowerCase(), changesetid: MIXED, categoryid: CAT_1 },
      { assignmentid: D(5), changesetid: MIXED.toUpperCase(), categoryid: CAT_2.toLowerCase() },
      { assignmentid: D(6), changesetid: C(10), categoryid: CAT_1 },
      { assignmentid: D(7), changesetid: null, categoryid: CAT_1 },
      { assignmentid: D(8), siteid: OTHER_SITE, changesetid: C(1), categoryid: CAT_1 },
    ].map((row) => ({ siteid: SITE.siteId, ...row }));

    let whole: WholeSite;
    let memory: DomainDeps;

    /** Inserts `rows` into `content.<table>` of the umbrella tenant. */
    async function insertRows(table: string, rows: readonly Struct[]): Promise<void> {
      await withTenant(handle.app, SITE.tenantId, async (tx) => {
        for (const row of rows) {
          const names = Object.keys(row);
          const placeholders = names.map((_, i) => `$${String(i + 2)}`).join(', ');
          await tx.query(`INSERT INTO ${handle.schema}.${table} (tenant_id, ${names.join(', ')}) VALUES ($1, ${placeholders})`, [
            tx.tenantId,
            ...Object.values(row),
          ]);
        }
      });
    }

    beforeAll(async () => {
      await insertRows('changeset', CHANGESETS);
      await insertRows('changeset_category_assign', ASSIGNMENTS);
      const strip = (row: Struct): Struct => Object.fromEntries(Object.entries(row).filter(([column]) => column !== 'tenant_id'));
      whole = await withTenant(handle.app, SITE.tenantId, async (tx) => ({
        changesets: (await deps.repository.changesets.siteChangesets(tx, { siteId: SITE.siteId })).map(strip),
        assignments: (await deps.repository.changesets.siteCategoryAssignments(tx, { siteId: SITE.siteId })).map(strip),
      }));
      memory = inMemoryDeps(deps, whole);
    });

    it('scopes both feeds to the rows, values and order of the whole-site reads', async () => {
      const all = (spec: FeedTableSpec): Promise<Struct[]> =>
        withTenant(handle.app, SITE.tenantId, (tx) => deps.repository.beanFeed.source<Struct>((fn) => fn(tx), spec).all());
      expect(whole.changesets).toHaveLength(11);
      expect(whole.assignments).toHaveLength(7);
      const changesets = await all(deps.repository.changesets.siteChangesetsFeed({ siteId: SITE.siteId }));
      expect(changesets).toEqual(whole.changesets);
      expect(changesets.map((row) => Object.keys(row))).toEqual(whole.changesets.map((row) => Object.keys(row)));
      expect(await all(deps.repository.changesets.siteCategoryAssignmentsFeed({ siteId: SITE.siteId }))).toEqual(whole.assignments);
    });

    const CHANGESET_QUERIES: Struct[] = [
      {}, { name: 'alpha' }, { name: 'ALPHA ' }, { name: '*a*' }, { name: 'like^a_b' }, { name: 'like^%[_]%' }, { name: 'Gamma_Launch' },
      { name: 'null' }, { name: 'neq^null' }, { name: '' }, { name: 'in^alpha,beta' }, { name: 'notin^alpha' }, { name: 'gt^m' },
      { name: 'begins^d' }, { name: 'contains^50%' }, { name: 'unicode' }, { description: 'null' }, { published: '1' }, { published: 'gt^0' },
      { published: 'null' }, { published: 'in^0,2' }, { published: 'abc' }, { publishdate: 'gt^2026-01-01' }, { publishdate: '2026-07-01 10:15:00' },
      { publishdate: 'null' }, { created: 'lt^2026-03-01' }, { created: 'in^2026-01-05,2026-03-01' }, { closedate: 'neq^null' }, { remotepubdate: 'x' },
      { name: 'alpha', or: '', published: '1' }, { openGrouping: '', name: 'alpha', or: '', published: '2', closeGrouping: '', description: 'null' },
      { sort: '-name' }, { sort: 'publishdate' }, { sort: '-publishdate,name' }, { sort: 'published,-created' }, { sortBy: 'created', sortDirection: 'desc' },
      { sort: 'tchangesets.name' }, { sort: 'nope' }, { orderby: '-created' }, { itemsPerPage: '3', pageIndex: '2' }, { itemsPerPage: '4', pageIndex: '99' },
      { startIndex: '5', itemsPerPage: '2' }, { maxitems: '3' }, { maxitems: '5', itemsPerPage: '2', pageIndex: '3' }, { nextn: '2' },
      { itemsPerPage: '*' }, { maxitems: '*', itemsPerPage: '0' },
      { countOnly: 'true' }, { countOnly: 'true', name: '*a*' }, { countOnly: 'true', name: 'like^a_b' }, { fields: 'name,publishdate', sort: '-publishdate' },
      { id: MIXED.toUpperCase() }, { changesetid: LOWER.toUpperCase() }, { lastupdatebyid: 'x' }, { tags: 'x' },
      { expand: 'categoryassignments', itemsPerPage: '3' }, { expand: 'categoryassignments', name: 'beta' },
    ];
    const CHANGESET_IDS = [C(10), C(1).toLowerCase(), MISSING, C(1), LOWER.toUpperCase(), MIXED.toUpperCase(), 'SHORT-ID', '', 'x\u0000', '\uD800', C(12)];
    const FIND_MANY_URLS: Struct[] = [{}, { sort: '-name' }, { countOnly: 'true' }, { itemsPerPage: '2', pageIndex: '2' }, { fields: 'name' }, { expand: 'categoryassignments' }];
    const ASSIGNMENT_QUERIES: Struct[] = [
      {}, { changesetid: C(1) }, { changesetid: C(1).toLowerCase() }, { changesetid: MIXED }, { categoryid: `in^${CAT_1},${CAT_2.toLowerCase()}` },
      { categoryid: 'null' }, { categoryid: 'neq^null' }, { changesetid: 'null' }, { siteid: 'UMBRELLA' }, { sort: '-categoryid' },
      { sort: 'changesetid,-assignmentid' }, { itemsPerPage: '2', pageIndex: '2' }, { countOnly: 'true', changesetid: C(1) }, { changeset: 'x' },
      { assignmentid: 'like^%A%' }, { assignmentid: '*short*' }, { id: 'DSHORT' }, { maxitems: '2' }, { fields: 'categoryid' },
    ];
    const ASSIGNMENT_IDS = [D(1).toLowerCase(), 'DSHORT', cfId('d', 4).toUpperCase(), MISSING, D(1), D(8)];

    const cases: [string, CallArgs][] = [
      ...CHANGESET_QUERIES.map((url): [string, CallArgs] => ['changeset findQuery', { method: 'findQuery', entityName: 'changeset', url }]),
      ...[{}, { itemsPerPage: '2', pageIndex: '2' }, { countOnly: 'true' }, { sort: '-name', maxitems: '4' }, { expand: 'categoryassignments' }].map(
        (url): [string, CallArgs] => ['changeset findAll', { method: 'findAll', entityName: 'changeset', url }],
      ),
      ...FIND_MANY_URLS.map((url): [string, CallArgs] => ['changeset findMany', { method: 'findMany', entityName: 'changeset', ids: CHANGESET_IDS, url }]),
      ['changeset findMany without ids', { method: 'findMany', entityName: 'changeset', ids: [] }],
      ...[C(1), MIXED, SHORT, C(10), C(6)].map((id): [string, CallArgs] => [
        'changeset findOne expanding',
        { method: 'findOne', entityName: 'changeset', id, url: { expand: 'categoryassignments' } },
      ]),
      ...ASSIGNMENT_QUERIES.map((url): [string, CallArgs] => ['assignment findQuery', { method: 'findQuery', entityName: 'changesetCategoryAssignment', url }]),
      ...[{}, { countOnly: 'true' }, { itemsPerPage: '3', pageIndex: '2' }].map((url): [string, CallArgs] => [
        'assignment findAll',
        { method: 'findAll', entityName: 'changesetCategoryAssignment', url },
      ]),
      ...[{}, { sort: '-categoryid' }, { itemsPerPage: '1', pageIndex: '2' }].map((url): [string, CallArgs] => [
        'assignment findMany',
        { method: 'findMany', entityName: 'changesetCategoryAssignment', ids: ASSIGNMENT_IDS, url },
      ]),
    ];

    it.each(cases)('%s %j answers what the whole-site read answered', async (_label, a) => {
      const args: CallArgs = { ...a, site: SITE, actor: WHO };
      expect(await outcomeOf(deps, args)).toEqual(await outcomeOf(memory, args));
    });

    it('selects the rows the cases are about, so the comparison exercises the data', async () => {
      const names = async (a: CallArgs): Promise<unknown[]> => {
        const data = wire(a.method, await invokeWith(deps, changesetHandler, a.method, callFor({ ...a, site: SITE, actor: WHO })));
        return itemsOf(data).map((item) => item['name']);
      };
      // Each listed id answers its row in list order, whatever its case or padding; a repeated id repeats it.
      const listed = await names({ method: 'findMany', entityName: 'changeset', ids: CHANGESET_IDS });
      expect(listed).toEqual(['Zed', 'Alpha', 'Alpha', 'Beta', 'beta', 'Gamma_Launch']);
      expect(await names({ method: 'findQuery', entityName: 'changeset', url: { name: 'alpha' } })).toEqual(['Alpha', 'alpha']);
      expect(await names({ method: 'findQuery', entityName: 'changeset', url: { name: 'like^a_b' } })).toEqual([]);
      const expanded = wire(
        'findOne',
        await invokeWith(deps, changesetHandler, 'findOne', callFor({ method: 'findOne', entityName: 'changeset', site: SITE, actor: WHO, id: MIXED, url: { expand: 'categoryassignments' } })),
      );
      const expandedIds = itemsOf(expanded['categoryassignments'] as Struct).map((item) => String(item['assignmentid']));
      expect(expandedIds.sort()).toEqual([cfId('d', 4).toLowerCase(), D(5)].sort());
    });

    it('reads one count and one page for a page request, only the requested ids for findMany, and never the whole site', async () => {
      const statements: { sql: string; rows: number }[] = [];
      const wholeSiteReads = { n: 0 };
      const recorded = recordingDeps(deps, statements, wholeSiteReads);
      // The statements over the feed tables; the others are the read barrier's gate checks.
      const feed = (): { sql: string; rows: number }[] =>
        statements.filter((s) => ['changeset', 'changeset_category_assign'].some((table) => s.sql.includes(`"${handle.schema}"."${table}" WHERE`)));
      const kinds = (): string[] => feed().map((s) => (s.sql.includes(' LIMIT ') ? 'page' : s.sql.includes('count(*)') ? 'count' : 'other'));

      const page = await invokeWith(
        recorded,
        changesetHandler,
        'findQuery',
        callFor({ method: 'findQuery', entityName: 'changeset', site: SITE, actor: WHO, url: { published: '0', sort: '-created', itemsPerPage: '2', pageIndex: '2' } }),
      );
      expect(itemsOf(wire('findQuery', page))).toHaveLength(2);
      expect(kinds()).toEqual(['count', 'page']);
      expect(feed()[1]?.rows).toBe(2);

      statements.length = 0;
      const many = await invokeWith(recorded, changesetHandler, 'findMany', callFor({ method: 'findMany', entityName: 'changeset', site: SITE, actor: WHO, ids: CHANGESET_IDS }));
      expect(itemsOf(wire('findMany', many))).toHaveLength(6);
      expect(kinds()).toEqual(['count', 'page']);
      expect(feed()[1]?.rows).toBe(5);
      expect(feed().every((s) => s.sql.includes('legacy_char_ci'))).toBe(true);

      statements.length = 0;
      const expanded = await invokeWith(
        recorded,
        changesetHandler,
        'findQuery',
        callFor({ method: 'findQuery', entityName: 'changeset', site: SITE, actor: WHO, url: { name: 'in^alpha,beta', expand: 'categoryassignments' } }),
      );
      expect(itemsOf(wire('findQuery', expanded))).toHaveLength(4);
      const assignmentPages = feed().filter((s) => s.sql.includes('changeset_category_assign') && s.sql.includes(' LIMIT '));
      expect(assignmentPages.map((s) => s.rows)).toEqual([3, 2]);
      expect(Math.max(...feed().map((s) => s.rows))).toBeLessThan(whole.assignments.length);

      statements.length = 0;
      await invokeWith(recorded, changesetCategoryAssignmentHandler, 'findQuery', callFor({ method: 'findQuery', entityName: 'changesetCategoryAssignment', site: SITE, actor: WHO, url: { countOnly: 'true' } }));
      expect(kinds()).toEqual(['count']);
      expect(wholeSiteReads.n).toBe(0);
    });
  });
});
