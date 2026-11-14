// JSON API `content` handlers over a throwaway `content` schema. Expected shapes follow Masa 7.6.1 on ACF 2023
// (test/fixtures/legacy-jsonapi-recorded.json); CFML-rendered values fail closed with the legacy 503.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildEnvelope, isCfUuid, serializeResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_UMBRELLA, assertResponseMatchesOpenApi, pgAvailable, seedRegistry } from '@opt2/platform/testing';
import { saveContent, type ContentSaveSite } from '../../src/domain/content.js';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { CONTENT_ENTITIES } from '../../src/legacy/jsonapi-entities.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { contentExpansionResolver, contentHandler, contentNavViews } from '../../src/routes/jsonapi/content.js';
import { createJsonApiParams, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

type Struct = Record<string, unknown>;
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

const FX = JSON.parse(readFileSync(new URL('../fixtures/legacy-jsonapi-recorded.json', import.meta.url), 'utf8')) as {
  oracle: { home: { data: Struct } };
};
const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
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
    customImageSizes: [],
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
    apiContext,
    httpMethod: method === 'save' ? 'POST' : method === 'delete' ? 'DELETE' : 'GET',
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

/** Validates `result`, enveloped as the dispatcher sends it, against the contract's `GET|POST /_api/json/v1/{siteid}/{path}` for a one-segment path. */
function assertContract(method: 'GET' | 'POST', path: string, result: JsonApiResult): void {
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
    [{ contenthistid: ALPHA_FIRST_VERSION }] = (await versions(ALPHA)) as Array<{ contenthistid: string }>;
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

    it.each(['comments', 'stats', 'site', 'relatedcontent'])('fails closed expanding %s, which another finder serves', async (relation) => {
      await expect(on('findOne', { id: ALPHA, url: { fields: 'title', expand: relation } })).rejects.toEqual(unavailable(`content-expand-${relation}`));
    });
  });

  describe('render', () => {
    it.each(['no/such', 'no/such/index.json', 'no/such/_/a/b'])('answers the legacy 404 for the unknown filename %s', async (id) => {
      await expect(on('findOne', { id, render: { variation: false } })).rejects.toMatchObject({ name: 'ContentNotFoundError' });
    });

    it.each([
      ['a stored filename', { id: 'alpha', render: { variation: false } }],
      ['an index file and URL vars after it', { id: 'alpha/_/a/b/index.cfm', render: { variation: false } }],
      ['the home page', { id: 'null', render: { variation: false } }],
      ['a tag search of the home page', { id: 'tag/alpha', render: { variation: false } }],
      ['a variation', { id: 'remote-1', render: { variation: true } }],
      ['a linkservid', { id: 'no/such', render: { variation: false }, url: { linkservid: cfId('X', 4) } }],
    ] satisfies Array<[string, CallArgs]>)('fails closed for %s, which the CFML renderer answers', async (_label, args) => {
      await expect(on('findOne', args)).rejects.toEqual(unavailable('cfml-render'));
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
      // getFilteredValues params url.expanddepth before packageIteratorArray reads the URL scope.
      expect((data['links'] as Struct)['self']).toBe(`${EP}/?&entityname=content&expanddepth=1&method=findall&pageIndex=1`);
    });

    it('findQuery filters by the query string under /content/ paging links, counts, and lets domain errors through', async () => {
      const data = wire(await on('findQuery', { url: { title: 'Alpha' } }));
      expect((data['items'] as Struct[]).map((item) => [item['id'], item['title']])).toEqual([[ALPHA, 'Alpha']]);
      expect((data['links'] as Struct)['self']).toBe(`${EP}/content/?title=Alpha&pageIndex=1`);
      // findQuery's exclusion list lacks countOnly, so on content it also filters as an extended attribute and counts none.
      expect(wire(await on('findQuery', { url: { title: 'Alpha', countOnly: 'true' } }))).toEqual({ count: '0' });
      await expect(on('findQuery', { url: { title: 'Alpha', offset: '1' } })).rejects.toEqual(legacyError('server_error'));
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
    it('refuses a failed CSRF check with invalidTokens before writing', async () => {
      const call = callFor('save', { actor: ADMIN, form: { parentid: HOME, type: 'Page', title: 'Never', approved: 1 }, csrf: false });
      expect(await run('save', call)).toEqual({ error: 'invalidTokens' });
      expect(call.validateCsrf).toHaveBeenCalledTimes(1);
      expect(await fx.rows('content', 'title = $1', ['Never'])).toEqual([]);
    });

    it('saves a new page and answers the reloaded version keyed by contenthistid', async () => {
      const result = await on('save', { actor: ADMIN, form: { parentid: HOME, type: 'Page', title: 'Saved', approved: 1 } });
      expect(result.status).toBe(200);
      const data = wire(result);
      const [stored] = (await fx.rows('content', 'title = $1 AND active = 1', ['Saved'])) as Array<{ contenthistid: string; contentid: string }>;
      expect(data).toMatchObject({ id: stored?.contenthistid, contentid: stored?.contentid, title: 'Saved', isnew: 0, saveerrors: '', errors: {} });
    });

    it('answers a save with errors with 403, the request values set back unless saveErrors is true', async () => {
      const form = { contentid: ALPHA, parentid: HOME, type: 'Page', title: 'Bad', template: 'x/y.cfm' };
      const result = await on('save', { actor: ADMIN, form });
      expect(result.status).toBe(403);
      expect(wire(result)).toMatchObject({ id: ALPHA, title: 'Bad', errors: { template: 'invalid template' }, saveerrors: '' });
      const kept = wire(await on('save', { actor: ADMIN, form: { ...form, saveErrors: ' true ' } }));
      expect(kept).toMatchObject({ id: ALPHA, title: 'Alpha', saveerrors: true });
    });

    it.each([
      ['a Form save without the Forms module', 'save', SITE_MANAGER, { form: { parentid: HOME, type: 'Form', title: 'Survey' } }],
      ['an anonymous save', 'save', ANONYMOUS, { form: { parentid: HOME, type: 'Page', title: 'Anon' } }],
      ['a member save', 'save', { ...NOBODY, roles: ['member'] }, { form: { parentid: HOME, type: 'Page', title: 'Member' } }],
      ['an anonymous delete', 'delete', ANONYMOUS, { id: HOME }],
    ] satisfies Array<[string, Op, Actor, CallArgs]>)('raises authorization for %s', async (_label, op, actor, args) => {
      await expect(on(op, { ...args, actor })).rejects.toEqual(legacyError('authorization'));
      expect(await fx.rows('content', 'title IN ($1, $2, $3)', ['Survey', 'Anon', 'Member'])).toEqual([]);
    });

    it('saves an author\'s save unapproved', async () => {
      const authors = cfId('G', 9);
      const author: Actor = { ...SITE_MANAGER, userId: cfId('U', 9) };
      await fx.inTenant(async (tx) => {
        await fx.repo.projections.upsertGroupProjection(tx, { groupId: authors, siteId: SITE_ID, groupName: 'Authors', isPublic: 0, deleted: false });
        await fx.repo.projections.replaceUserMemberships(tx, author.userId, SITE_ID, [authors]);
        await fx.repo.projections.replaceGroupPermissions(tx, authors, SITE_ID, [{ contentId: HOME, siteId: SITE_ID, type: 'author' }]);
      });
      wire(await on('save', { actor: author, form: { parentid: HOME, type: 'Page', title: 'Authored', approved: 1 } }));
      expect((await fx.rows('content', 'title = $1', ['Authored']))[0]).toMatchObject({ approved: 0, lastupdatebyid: author.userId });
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
  });

  describe('contract', () => {
    it('answers entities, collections and rejected saves in the envelopes the contract declares', async () => {
      assertContract('GET', 'content', await on('findOne', { id: HOME }));
      assertContract('GET', 'content', await on('findQuery', { url: { title: 'Alpha' } }));
      assertContract('GET', 'contentnav', await on('findNew'));
      const rejected = await on('save', { actor: ADMIN, form: { contentid: ALPHA, parentid: HOME, type: 'Page', title: 'Bad', template: 'x/y.cfm' } });
      assertContract('POST', 'content', rejected);
    });
  });

  describe('shared exports', () => {
    it('the expansion resolver fails closed on relations of other entities', async () => {
      const resolver = contentExpansionResolver(routeCtx(), callFor('findOne'));
      const stats = CONTENT_ENTITIES.content.hasOne.find((prop) => prop.name === 'stats');
      if (stats === undefined) throw new Error('content has no stats relation');
      await expect(resolver.hasOne(stats, ALPHA, { expand: 'stats', expanded: 1 })).rejects.toEqual(unavailable('content-expand-stats'));
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
  });
});
