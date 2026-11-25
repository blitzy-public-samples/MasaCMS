// JSON API `content` handlers over a throwaway `content` schema. Expected shapes follow Masa 7.6.1 on ACF 2023
// (test/fixtures/legacy-jsonapi-recorded.json); CFML-rendered values fail closed with the legacy 503.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildEnvelope, isCfUuid, serializeResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_UMBRELLA, assertResponseMatchesOpenApi, loadOpenApiDocument, pgAvailable, seedRegistry } from '@opt2/platform/testing';
import { saveContent, type ContentSaveSite } from '../../src/domain/content.js';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { CONTENT_ENTITIES } from '../../src/legacy/jsonapi-entities.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { CONTENT_RENDER_EXCEPTION, contentExpansionResolver, contentHandler, contentNavViews } from '../../src/routes/jsonapi/content.js';
import { createJsonApiParams, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { recordingRelatedReader } from '../helpers/related-reader.js';

type Struct = Record<string, unknown>;
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'delete';

const FX = JSON.parse(readFileSync(new URL('../fixtures/legacy-jsonapi-recorded.json', import.meta.url), 'utf8')) as {
  oracle: { home: { data: Struct } };
};
const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;
const ANONYMOUS = actorFromClaims(undefined, '');
/** A tenant-a system user with Site Manager module access only. */
const SITE_MANAGER: Actor = { ...NOBODY, roles: ['system-user', 'm:000'] };
const EP = jsonApiEndpoint({ adminSSL: false, requestProtocol: 'http', serverName: 'localhost', serverPort: '', context: '', mode: 'json', siteId: SITE_ID });
const SITE_TREE = '00000000000000000000000000000000000';

interface CallArgs {
  actor?: Actor;
  id?: string;
  ids?: string[];
  url?: Struct;
  form?: Struct;
  csrf?: boolean;
  render?: { variation: boolean };
  site?: Partial<ContentSaveSite> & Struct;
  defaultSiteUrls?: ContentSaveSite['urls'];
}

/** A call as ../jsonapi.ts builds it, with a CSRF check that answers `csrf` (default true) and records its calls. */
function callFor(method: Op, a: CallArgs = {}): JsonApiCall & { validateCsrf: ReturnType<typeof vi.fn> } {
  const url: Struct = { ...a.url };
  const form: Struct = { ...a.form };
  const actor = a.actor ?? ANONYMOUS;
  const raw = Object.entries(url)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const apiContext: JsonApiRequestContext = {
    siteId: SITE_ID,
    mode: 'json',
    endpoint: EP,
    url,
    form,
    method,
    isAggregateQuery: false,
    user: { loggedIn: actor.isLoggedIn, systemUser: actor.isLoggedIn },
    allowAction: () => false,
    site: SITE.urls,
    customImageSizes: () => Promise.resolve([]),
  };
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:content.${method.toLowerCase()}`,
    method,
    entityName: 'content',
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.ids === undefined ? {} : { ids: a.ids }),
    ...(a.render === undefined ? {} : { render: a.render }),
    pathInfo: [SITE_ID, 'content'],
    params: createJsonApiParams(Object.entries({ ...url, ...form })),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: SITE_ID,
    tenantId: TENANT_A.tenantId,
    actor,
    site: { ...SITE, ...a.site },
    ...(a.defaultSiteUrls === undefined ? {} : { defaultSiteUrls: a.defaultSiteUrls }),
    apiContext,
    httpMethod: method === 'delete' ? 'DELETE' : 'GET',
    headers: {},
    validateCsrf: vi.fn(() => Promise.resolve(a.csrf ?? true)),
  };
}

let fx: ContentFixture;

/** The route context the handlers read. */
const routeCtx = (): ContentRouteContext => ({ domain: fx.deps, storage: fx.deps.storage }) as unknown as ContentRouteContext;

/** Runs `op` of the content handler for `call`. */
function run(op: Op, call: JsonApiCall): Promise<JsonApiResult> {
  const fn = contentHandler[op];
  if (fn === undefined) throw new Error(`content has no ${op}`);
  return fn(routeCtx(), call);
}

/** Runs `op` for a call built from `a`. */
const on = (op: Op, a: CallArgs = {}): Promise<JsonApiResult> => run(op, callFor(op, a));

/** The `data` of `result` as the JSON API puts it on the wire. */
function wire(result: JsonApiResult): Struct {
  expect(result.error).toBeUndefined();
  expect(result.serializerEntity).toBe('content');
  const { body } = serializeResponse(buildEnvelope({ method: 'findOne', data: result.data }), { serializer: contentApiSerializer('content') });
  return (JSON.parse(body) as { data: Struct }).data;
}

const itemsOf = (result: JsonApiResult): Struct[] => wire(result)['items'] as Struct[];

/** Validates `result`, enveloped as the dispatcher sends it, against the contract's `GET /_api/json/v1/{siteid}/{path}` for a one-segment path. */
function assertContract(method: 'GET', path: string, result: JsonApiResult): void {
  const status = result.status ?? 200;
  const { body, headers } = serializeResponse(buildEnvelope({ method: 'findOne', data: result.data }), {
    statusCode: status,
    serializer: contentApiSerializer('content'),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: `/_api/json/v1/${SITE_ID}/${path}`, status, contentType: headers['Content-Type'], body });
}
const titlesOf = (result: JsonApiResult): unknown[] => itemsOf(result).map((item) => item['title']);
const legacyError = (type: string): unknown => expect.objectContaining({ name: 'LegacyApiError', type });
const unavailable = (reason: string): unknown => expect.objectContaining({ name: 'LegacyServiceUnavailableError', reason });

/** The stored tenant-a versions of `contentId`, oldest first. */
const versions = (contentId: string): Promise<Struct[]> => fx.rows('content', 'contentid = $1', [contentId]);

/** Saves a tenant-a page through the domain and returns its content id. */
async function page(data: Struct, site: ContentSaveSite = SITE, actor: Actor = ADMIN): Promise<string> {
  const saved = await saveContent(fx.deps, actor, site, { siteid: site.siteId, type: 'Page', approved: 1, ...data });
  expect(saved.errors).toEqual({});
  return saved.bean.contentId();
}

let ALPHA = '';
let BETA = '';
let ALPHA_FIRST_VERSION = '';

describe.skipIf(!(await pgAvailable()))('JSON API content handler', () => {
  beforeAll(async () => {
    fx = await createContentFixture('jsonapi-content-test');
    await page({ contentid: HOME, parentid: END, title: 'Home' });
    ALPHA = await page({ parentid: HOME, title: 'Alpha', filename: 'alpha' });
    [{ contenthistid: ALPHA_FIRST_VERSION }] = (await versions(ALPHA)) as [{ contenthistid: string }, ...Array<{ contenthistid: string }>];
    await page({ contentid: ALPHA, parentid: HOME, title: 'Alpha', filename: 'alpha', summary: 'second' });
    BETA = await page({ parentid: ALPHA, title: 'Beta' });
    await page({ parentid: HOME, title: 'Members', restricted: 1 });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  describe('findOne', () => {
    it('answers the home page with the oracle\'s fields and links, and no edit link for an anonymous caller', async () => {
      const data = wire(await on('findOne', { id: HOME }));
      const oracle = FX.oracle.home.data;
      expect(Object.keys(data).sort()).toEqual(Object.keys(oracle).sort());
      expect(Object.keys(data['links'] as Struct).sort()).toEqual(Object.keys(oracle['links'] as Struct).sort());
      expect(data).toMatchObject({
        id: HOME,
        contentid: HOME,
        parentid: END,
        title: 'Home',
        isnew: 0,
        active: 1,
        approved: 1,
        moduleid: SITE_TREE,
        url: 'http://localhost/',
        assocurl: 'http://localhost/',
        images: {},
        entityname: 'content',
      });
      expect(data['links']).toMatchObject({ self: `${EP}/content/${HOME}`, kids: `${EP}/content?parentid=${HOME}`, parent: `${EP}/content/${END}` });
    });

    it('loads by the contenthistid param before the contentid param and the path id', async () => {
      const first = wire(await on('findOne', { id: HOME, url: { contenthistid: ALPHA_FIRST_VERSION, contentid: HOME, fields: 'summary' } }));
      expect(first).toMatchObject({ id: ALPHA, summary: '' });
      const active = wire(await on('findOne', { id: HOME, url: { contentid: ALPHA, fields: 'summary,contenthistid' } }));
      expect(active).toMatchObject({ id: ALPHA, summary: 'second' });
      expect(active['contenthistid']).not.toBe(ALPHA_FIRST_VERSION);
    });

    it('answers an unknown id with 200 and legacy\'s new bean under a fresh content id', async () => {
      const result = await on('findOne', { id: cfId('X', 1) });
      expect(result.status).toBe(200);
      const data = wire(result);
      expect(data).toMatchObject({ isnew: 1, siteid: SITE_ID, title: '', entityname: 'content' });
      expect(isCfUuid(String(data['id']))).toBe(true);
      expect(data['id']).not.toBe(cfId('X', 1));
    });

    it('adds the cArch.edit link for a system user AllowAction allows', async () => {
      const data = wire(await on('findOne', { actor: ADMIN, id: HOME, url: { fields: 'title,links' } }));
      const [home] = (await versions(HOME)) as Array<{ contenthistid: string }>;
      expect((data['links'] as Struct)['edit']).toBe(
        `/admin/?muraAction=cArch.edit&contenthistid=${home?.contenthistid ?? ''}&contentid=${HOME}&type=Page&siteid=${SITE_ID}` +
          `&topid=${HOME}&parentid=${END}&moduleid=${SITE_TREE}&compactdisplay=false`,
      );
      const denied = wire(await on('findOne', { actor: NOBODY, id: HOME, url: { fields: 'title,links' } }));
      expect((denied['links'] as Struct)['edit']).toBeUndefined();
    });

    it.each([
      ['every value', { fields: '*' }, 'content-all-values'],
      ['extended data', { fields: 'title,extendeddata' }, 'content-field-extendeddata'],
      ['a value the bean does not hold', { fields: 'title,colour' }, 'content-extended-attribute'],
      ['the form-protection include', { ishuman: '' }, 'cfml-render'],
    ])('fails closed for %s', async (_label, url, reason) => {
      await expect(on('findOne', { id: HOME, url })).rejects.toEqual(unavailable(reason));
    });

    it('expands kids, the parent (a new bean for the home page\'s END) and the crumbs as the oracle does', async () => {
      const home = wire(await on('findOne', { id: HOME, url: { fields: 'title', expand: 'parent' } }));
      expect(home['parent']).toMatchObject({ isnew: 1, title: '', siteid: SITE_ID, entityname: 'content' });
      const data = wire(await on('findOne', { id: ALPHA, url: { fields: 'title', expand: 'kids,parent' } }));
      expect(data['parent']).toMatchObject({ id: HOME, isnew: 0, title: 'Home' });
      expect(data['kids']).toMatchObject({ totalitems: 1, entityname: 'content', items: [{ id: BETA, title: 'Beta' }] });
      expect(((data['kids'] as Struct)['links'] as Struct)['self']).toBe(`${EP}/content/?parentid=${ALPHA}&pageIndex=1`);
      const crumbs = wire(await on('findOne', { id: ALPHA, url: { fields: 'title,links,path', expand: 'crumbs' } }))['crumbs'] as Struct;
      expect((crumbs['items'] as Struct[]).map((item) => item['title'])).toEqual(['Alpha', 'Home']);
      expect(crumbs).toMatchObject({ totalitems: 2, itemsperpage: 2, entityname: 'content' });
    });

    it.each([
      ['comments', () => ({ read: 'findQuery', entityName: 'comment', expand: 'comments', expanded: 1, params: { contentid: ALPHA } })],
      ['stats', () => ({ read: 'findOne', entityName: 'stats', id: ALPHA, expand: 'stats', expanded: 1 })],
      ['site', () => ({ read: 'findOne', entityName: 'site', id: SITE_ID, expand: 'site', expanded: 1 })],
      ['relatedcontent', () => ({ read: 'relatedContent', entityName: 'content', expand: '', expanded: 1 })],
    ])('expands %s through the related reader with the values expandEntity passes', async (relation, read) => {
      const { reader, reads } = recordingRelatedReader();
      const data = wire(await run('findOne', { ...callFor('findOne', { id: ALPHA, url: { fields: 'title', expand: relation } }), related: reader }));
      expect(reads).toEqual([read()]);
      expect(data[relation]).toBeDefined();
    });
  });

  describe('render', () => {
    it.each([
      ['a stored filename', { id: 'alpha', render: { variation: false } }],
      ['an index file and URL vars after it', { id: 'alpha/_/a/b/index.cfm', render: { variation: false } }],
      ['the home page', { id: 'null', render: { variation: false } }],
      ['a tag search of the home page', { id: 'tag/alpha', render: { variation: false } }],
      ['an unknown filename, whose 404 page data the renderer answers', { id: 'no/such', render: { variation: false } }],
      ['an unknown filename under an index file', { id: 'no/such/index.json', render: { variation: false } }],
      ['an unknown filename before URL vars', { id: 'no/such/_/a/b', render: { variation: false } }],
      ['a variation', { id: 'remote-1', render: { variation: true } }],
      ['a linkservid', { id: 'no/such', render: { variation: false }, url: { linkservid: cfId('X', 4) } }],
    ] satisfies Array<[string, CallArgs]>)('fails closed for %s, which the CFML renderer answers', async (_label, args) => {
      await expect(on('findOne', args)).rejects.toEqual(
        expect.objectContaining({
          name: 'LegacyServiceUnavailableError',
          reason: 'cfml-render',
          message: expect.stringContaining(`(${CONTENT_RENDER_EXCEPTION})`),
        }),
      );
      expect(CONTENT_RENDER_EXCEPTION).toBe('EX-CONTENT-RENDER');
    });
  });

  describe('lists', () => {
    it('findMany keeps the ids order unless a sort is given', async () => {
      expect(titlesOf(await on('findMany', { ids: [BETA, ALPHA], url: { contentid: `${BETA},${ALPHA}`, countOnly: 'true' } }))).toEqual(['Beta', 'Alpha']);
      expect(titlesOf(await on('findMany', { ids: [BETA, ALPHA], url: { sort: 'title' } }))).toEqual(['Alpha', 'Beta']);
      const data = wire(await on('findMany', { ids: [BETA, ALPHA] }));
      expect((data['links'] as Struct)['self']).toContain('&method=findmany');
    });

    it('findAll counts with countOnly and lists the site feed with the findall paging links', async () => {
      // The site feed leaves out the home page (includeHomePage 0).
      expect(wire(await on('findAll', { url: { countOnly: 'true' } }))).toEqual({ count: '3' });
      const data = wire(await on('findAll'));
      expect(data).toMatchObject({ totalitems: 3, entityname: 'content' });
      // getFilteredValues params url.expanddepth before packageIteratorArray reads the URL scope, whose params go out in
      // ACF's struct iteration order.
      expect((data['links'] as Struct)['self']).toBe(`${EP}/?&expanddepth=1&method=findall&entityname=content&pageIndex=1`);
    });

    it('findQuery filters by the query string under /content/ paging links, counts, and lets domain errors through', async () => {
      const data = wire(await on('findQuery', { url: { title: 'Alpha' } }));
      expect((data['items'] as Struct[]).map((item) => [item['id'], item['title']])).toEqual([[ALPHA, 'Alpha']]);
      expect((data['links'] as Struct)['self']).toBe(`${EP}/content/?title=Alpha&pageIndex=1`);
      // findQuery's exclusion list lacks countOnly, so on content it also filters as an extended attribute and counts none.
      expect(wire(await on('findQuery', { url: { title: 'Alpha', countOnly: 'true' } }))).toEqual({ count: '0' });
      await expect(on('findQuery', { url: { title: 'Alpha', offset: '1' } })).rejects.toEqual(legacyError('server_error'));
    });

    it.each([
      ['its row value', 'title', () => ({ title: 'Alpha' })],
      ['a value of the active version its row lacks', 'url', () => ({ url: 'http://localhost/alpha/' })],
    ] satisfies Array<[string, string, () => Struct]>)('findQuery with fields serializes %s', async (_label, fields, expected) => {
      expect(itemsOf(await on('findQuery', { url: { title: 'Alpha', fields } }))).toEqual([
        { contentid: ALPHA, id: ALPHA, siteid: SITE_ID, isnew: 0, entityname: 'content', ...expected() },
      ]);
    });

    it.each([
      ['page 0', { itemsPerPage: '1', pageIndex: '0' }, 1, { pageindex: 0, startindex: 0, endindex: 0, totalpages: 1 }],
      ['a negative page', { itemsPerPage: '2', pageIndex: '-1' }, 2, { pageindex: -1, startindex: -3, endindex: -2, totalpages: 1 }],
    ] satisfies Array<[string, Struct, number, Struct]>)('findQuery serializes the new beans of the blank rows of %s', async (_label, paging, count, values) => {
      const data = wire(await on('findQuery', { url: { title: 'Alpha', fields: 'title', ...paging } }));
      const blank = { contentid: '', title: '', id: '', siteid: '', isnew: 1, entityname: 'content' };
      expect(data).toMatchObject({ totalitems: 1, ...values, items: Array.from({ length: count }, () => blank) });
    });

    it('findQuery fails closed on the URLs of blank rows when no default site is registered', async () => {
      await expect(on('findQuery', { url: { title: 'Alpha', pageIndex: '0' } })).rejects.toEqual(unavailable('content-pool-site-urls'));
    });

    it('findQuery builds the URLs of blank rows with the default site settings and their links on the request endpoint', async () => {
      const defaultSiteUrls = { ...SITE.urls, siteId: 'default', domain: 'default.example', requestDomain: 'default.example' };
      const url = { title: 'Alpha', pageIndex: '0', fields: 'url,assocurl,images,links' };
      const [item] = itemsOf(await on('findQuery', { url, defaultSiteUrls }));
      expect(item).toMatchObject({ url: 'http://default.example/', assocurl: 'http://default.example/', images: {}, contentid: '', siteid: '' });
      expect(item?.['links']).toMatchObject({ self: `${EP}/content/`, all: `${EP}/content`, rendered: `${EP}/content/_path/` });
    });

    it.each([
      ["by contentid after a blank row, whose page query is of site ''", 'title', 1],
      ['by contenthistid after a blank row', 'title,contenthistid', 0],
    ])('findQuery reads a row %s as contentDAO reads it', async (_name, fields, isnew) => {
      const items = itemsOf(await on('findQuery', { url: { title: 'Alpha', pageIndex: '0.5', itemsPerPage: '2', fields } }));
      expect(items.map((item) => [item['title'], item['isnew']])).toEqual([['', 1], ['Alpha', isnew]]);
    });

    it('findQuery fails closed on a sortBy no extended attribute backs once more than one row could answer', async () => {
      await expect(on('findQuery', { url: { sortBy: 'nosuchattr' } })).rejects.toEqual(unavailable('feed-extended-sort-unordered'));
      expect(titlesOf(await on('findQuery', { url: { title: 'Alpha', sortBy: 'nosuchattr' } }))).toEqual(['Alpha']);
    });

    it('findQuery pages no row for a negative page size, with legacy page values', async () => {
      expect(wire(await on('findQuery', { url: { title: 'Alpha', itemsPerPage: '-1' } }))).toMatchObject({
        items: [],
        totalitems: 1,
        totalpages: -1,
        pageindex: 1,
        startindex: 1,
        endindex: -1,
        itemsperpage: -1,
      });
    });

    it('counts a fields feed as any feed', async () => {
      expect(wire(await on('findAll', { url: { countOnly: 'true', fields: 'title' } }))).toEqual({ count: '3' });
    });

    it.each([
      ['an aggregate', { sum: 'orderno' }],
      ['a join', { innerJoin: 'tcontentstats' }],
    ])('findQuery fails closed for %s, which the feed reads do not reproduce', async (_label, url) => {
      await expect(on('findQuery', { url })).rejects.toEqual(unavailable('feed-content-unsupported'));
    });

    it('applies the extranet permission filter only where the site settings ask for it', async () => {
      expect(titlesOf(await on('findQuery', { url: { title: 'Members' } }))).toEqual(['Members']);
      expect(titlesOf(await on('findQuery', { url: { title: 'Members' }, site: { extranet: 1 } }))).toEqual([]);
    });

    it('reads content-pool items in their own tenant and fails closed on their site URLs', async () => {
      const umbrella: ContentSaveSite = { ...SITE, siteId: TENANT_UMBRELLA.siteId, urls: { ...SITE.urls, siteId: TENANT_UMBRELLA.siteId } };
      const umbrellaAdmin: Actor = { ...ADMIN, siteId: TENANT_UMBRELLA.siteId, tenantId: TENANT_UMBRELLA.tenantId };
      await page({ contentid: HOME, parentid: END, title: 'Umbrella Home' }, umbrella, umbrellaAdmin);
      const pooled = await saveContent(fx.deps, umbrellaAdmin, umbrella, { siteid: umbrella.siteId, type: 'Page', approved: 1, parentid: HOME, title: 'Pooled' });
      await fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          [SITE_ID, TENANT_UMBRELLA.siteId],
          [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId],
          TENANT_A.tenantId,
        ]),
      );
      try {
        await expect(on('findQuery', { url: { title: 'Pooled', contentpoolid: '*' } })).rejects.toEqual(unavailable('content-pool-site-urls'));
        const pooledId = pooled.bean.contentId();
        expect(itemsOf(await on('findQuery', { url: { title: 'Pooled', contentpoolid: '*', fields: 'title' } }))).toEqual([
          { contentid: pooledId, title: 'Pooled', id: pooledId, siteid: umbrella.siteId, isnew: 0, entityname: 'content' },
        ]);
        const row = { siteid: umbrella.siteId, contenthistid: pooled.bean.contentHistId(), title: 'Pooled' };
        const [view] = await contentNavViews(routeCtx(), callFor('findQuery', { url: { fields: 'title' } }), [row], { expand: '', expanded: 0 });
        expect(view?.allValues).toMatchObject({ Title: 'Pooled', ContentHistID: row.contenthistid });
      } finally {
        await seedRegistry(fx.handle.app);
      }
    });
  });

  describe('findNew, findProperties and findPermissions', () => {
    it('findNew answers a new bean of the site under a fresh id, without an edit link for a bean without a parent', async () => {
      const data = wire(await on('findNew', { actor: ADMIN }));
      expect(data).toMatchObject({ isnew: 1, siteid: SITE_ID, active: 1, type: 'Page', moduleid: SITE_TREE });
      expect(isCfUuid(String(data['id']))).toBe(true);
      expect((data['links'] as Struct)['edit']).toBeUndefined();
    });

    it('findProperties describes the registration', async () => {
      const data = wire(await on('findProperties'));
      expect(data).toMatchObject({ primarykey: 'contentid', entityname: 'content', public: true });
    });

    it.each([
      ['an S2 admin on a stored item', ADMIN, () => HOME, {}, { read: true, save: true, delete: true }],
      ['a system user without node permission', NOBODY, () => HOME, {}, { read: true, save: false, delete: false }],
      ['a new item without a parent', ADMIN, () => cfId('X', 2), {}, { read: true, save: false, delete: false }],
      ['an id that loads nothing', ADMIN, () => 'permissions', {}, { read: false, save: false, delete: false }],
      ['a Form request without the Forms module', SITE_MANAGER, () => HOME, { type: 'Form' }, { read: true, save: false, delete: false }],
    ] satisfies Array<[string, Actor, () => string, Struct, Struct]>)('findPermissions for %s', async (_label, actor, id, url, expected) => {
      expect(wire(await on('findPermissions', { actor, id: id(), url }))).toEqual(expected);
    });
  });

  describe('save', () => {
    // The save writes the decision-list table tcontenteventreminders, so it stays on legacy; the dispatcher answers it with the legacy 503.
    it('defines no handler for the withheld save of content and contentnav', () => {
      expect(Object.hasOwn(contentHandler, 'save')).toBe(false);
    });
  });

  describe('delete', () => {
    it('ignores a failed CSRF check on a version delete', async () => {
      const call = callFor('delete', { actor: ADMIN, url: { contenthistid: ALPHA_FIRST_VERSION } });
      call.validateCsrf.mockResolvedValue(false);
      expect(await run('delete', call)).toEqual({ status: 200, data: '', serializerEntity: 'content' });
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      expect((await versions(ALPHA)).some((row) => row['contenthistid'] === ALPHA_FIRST_VERSION)).toBe(true);
    });

    it('raises invalidTokens on a content delete and answers a missing item without a CSRF check', async () => {
      await expect(on('delete', { actor: ADMIN, id: BETA, csrf: false })).rejects.toEqual(legacyError('invalidTokens'));
      expect(await versions(BETA)).not.toEqual([]);
      const missing = callFor('delete', { actor: ADMIN, id: cfId('X', 3) });
      expect(await run('delete', missing)).toMatchObject({ data: '' });
      expect(missing.validateCsrf).not.toHaveBeenCalled();
    });

    it('deletes the item after AllowAction and the CSRF check', async () => {
      const doomed = await page({ parentid: HOME, title: 'Doomed' });
      expect(await on('delete', { actor: ADMIN, id: doomed })).toMatchObject({ data: '' });
      expect(await versions(doomed)).toEqual([]);
    });

    it('raises authorization for an anonymous delete', async () => {
      const before = await versions(HOME);
      await expect(on('delete', { actor: ANONYMOUS, id: HOME })).rejects.toEqual(legacyError('authorization'));
      expect(await versions(HOME)).toEqual(before);
    });
  });

  describe('contract', () => {
    it('answers entities and collections in the envelopes the contract declares', async () => {
      assertContract('GET', 'content', await on('findOne', { id: HOME }));
      assertContract('GET', 'content', await on('findQuery', { url: { title: 'Alpha' } }));
      assertContract('GET', 'contentnav', await on('findNew'));
    });
  });

  describe('shared exports', () => {
    it('the expansion resolver reads relations of other entities through the call\'s related reader, which it requires', async () => {
      const stats = CONTENT_ENTITIES.content.hasOne.find((prop) => prop.name === 'stats');
      if (stats === undefined) throw new Error('content has no stats relation');
      const { reader, reads } = recordingRelatedReader();
      const resolver = contentExpansionResolver(routeCtx(), { ...callFor('findOne'), related: reader });
      expect(await resolver.hasOne(stats, ALPHA, { expand: 'stats', expanded: 1 })).toEqual({ related: 'stats', id: ALPHA });
      expect(reads).toEqual([{ read: 'findOne', entityName: 'stats', id: ALPHA, expand: 'stats', expanded: 1 }]);
      await expect(contentExpansionResolver(routeCtx(), callFor('findOne')).hasOne(stats, ALPHA, { expand: 'stats', expanded: 1 })).rejects.toThrow(
        'carries no related-entity reader',
      );
    });

    it('contentNavViews reads each row\'s full version behind the row values', async () => {
      const [alpha] = (await fx.rows('content', 'contentid = $1 AND active = 1', [ALPHA])) as Array<{ contenthistid: string }>;
      const [view] = await contentNavViews(routeCtx(), callFor('findQuery'), [{ siteid: SITE_ID, contenthistid: alpha?.contenthistid, title: 'Row title' }], {
        expand: '',
        expanded: 0,
      });
      expect(view?.values).toMatchObject({ title: 'Row title', contentid: ALPHA });
      expect(view?.allValues).toMatchObject({ Summary: 'second' });
    });

    it('contentNavViews reads rows of several tenants together as it reads each row alone, a missing version giving its site\'s new bean', async () => {
      const umbrella: ContentSaveSite = { ...SITE, siteId: TENANT_UMBRELLA.siteId, urls: { ...SITE.urls, siteId: TENANT_UMBRELLA.siteId } };
      const pooled = await saveContent(fx.deps, { ...ADMIN, siteId: umbrella.siteId, tenantId: TENANT_UMBRELLA.tenantId }, umbrella, {
        siteid: umbrella.siteId,
        type: 'Page',
        approved: 1,
        contentid: HOME,
        parentid: END,
        title: 'Umbrella Home',
      });
      const activeOf = async (contentId: string): Promise<string> => String((await fx.rows('content', 'contentid = $1 AND active = 1', [contentId]))[0]?.['contenthistid']);
      const rows = [
        { siteid: SITE_ID, contenthistid: await activeOf(ALPHA) },
        { siteid: umbrella.siteId, contenthistid: pooled.bean.contentHistId() },
        { siteid: SITE_ID, contenthistid: cfId('H', 1) },
        { siteid: SITE_ID, contenthistid: '' },
        { siteid: SITE_ID, contenthistid: await activeOf(BETA) },
        { siteid: umbrella.siteId, contenthistid: cfId('H', 2) },
      ];
      // A bean's instance id, and a new bean's ids, are fresh on every read.
      const masked = (view: { allValues: Readonly<Struct> } | undefined): string => {
        const ids = Object.entries(view?.allValues ?? {}).flatMap(([key, value]) => (/^(content(hist)?id|instanceid)$/i.test(key) && value !== '' ? [String(value)] : []));
        return ids.reduce((text, id) => text.replaceAll(id, '<id>'), JSON.stringify(view));
      };
      await fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          [SITE_ID, TENANT_UMBRELLA.siteId],
          [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId],
          TENANT_A.tenantId,
        ]),
      );
      try {
        const call = callFor('findQuery', { url: { fields: 'title,summary' } });
        const opts = { expand: '', expanded: 0 };
        const together = await contentNavViews(routeCtx(), call, rows, opts);
        const alone = [];
        for (const row of rows) alone.push(...(await contentNavViews(routeCtx(), call, [row], opts)));
        const value = (view: { allValues: Readonly<Struct> }, name: string): unknown => Object.entries(view.allValues).find(([key]) => key.toLowerCase() === name)?.[1];
        expect(together.map((view) => [value(view, 'isnew'), value(view, 'title') ?? '', value(view, 'siteid')])).toEqual([
          [0, 'Alpha', SITE_ID],
          [0, 'Umbrella Home', umbrella.siteId],
          [1, '', SITE_ID],
          [1, '', SITE_ID],
          [0, 'Beta', SITE_ID],
          [1, '', umbrella.siteId],
        ]);
        expect(together.map(masked)).toEqual(alone.map(masked));
      } finally {
        await seedRegistry(fx.handle.app);
      }
    });

    it.each([
      ['a row that fails closed before a row of an unregistered site', 'first', unavailable('content-extended-attribute')],
      ['a row of an unregistered site before a row that fails closed', 'last', expect.objectContaining({ message: expect.stringContaining('Site nowhere is not a registered site') })],
    ])('contentNavViews throws the error of the first failing row for %s', async (_label, alphaAt, expected) => {
      const alpha = { siteid: SITE_ID, contenthistid: String((await fx.rows('content', 'contentid = $1 AND active = 1', [ALPHA]))[0]?.['contenthistid']) };
      const nowhere = { siteid: 'nowhere', contenthistid: cfId('H', 3) };
      const rows = alphaAt === 'first' ? [alpha, nowhere] : [nowhere, alpha];
      await expect(contentNavViews(routeCtx(), callFor('findQuery', { url: { fields: 'title,colour' } }), rows, { expand: '', expanded: 0 })).rejects.toEqual(expected);
    });
  });
});
