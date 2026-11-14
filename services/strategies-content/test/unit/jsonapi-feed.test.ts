// JSON API `feed` handlers over a throwaway `content` schema. Expected shapes and verdicts follow what Masa 7.6.1 on
// ACF 2023 answers for the same calls: feedBean.getEntityName() is `content`, so bean-object checks treat a feed as content.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildEnvelope, LegacyApiError, serializeResponse } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, pgAvailable, type TenantFixture } from '@opt2/platform/testing';
import { saveContent, type ContentSaveSite } from '../../src/domain/content.js';
import { actorFromClaims, UndefinedLegacyMethodError, type Actor } from '../../src/domain/context.js';
import { createFeed, readFeed } from '../../src/domain/feeds.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { feedHandler } from '../../src/routes/jsonapi/feed.js';
import { createJsonApiParams, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';
import { ADMIN, END, HOME, NOBODY, SITE, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

type Struct = Record<string, unknown>;
type Op = 'findOne' | 'findMany' | 'findAll' | 'findQuery' | 'findNew' | 'findProperties' | 'findPermissions' | 'save' | 'delete';

const ANONYMOUS = actorFromClaims(undefined, '');
/** A tenant-a system user holding only the Collections module (`m:011`). */
const COLLECTIONS: Actor = { ...NOBODY, roles: ['system-user', 'm:011'] };
const ADMIN_B: Actor = { ...ADMIN, siteId: TENANT_B.siteId, tenantId: TENANT_B.tenantId };
const SITE_B: ContentSaveSite = { ...SITE, siteId: TENANT_B.siteId, urls: { ...SITE.urls, siteId: TENANT_B.siteId, filePoolId: TENANT_B.siteId } };
const EP = jsonApiEndpoint({
  adminSSL: false,
  requestProtocol: 'http',
  serverName: 'localhost',
  serverPort: '',
  context: '',
  mode: 'json',
  siteId: TENANT_A.siteId,
});

// The keys the oracle's findOne of an unknown feed id answers (78: instance values plus id, links and entityname).
const FIND_ONE_KEYS =
  'activeonly,additionalcolumns,allowhtml,altname,alttable,authtype,autoimport,avgvalarray,cachedwithin,categoryid,channellink,contentid,' +
  'contentpoolid,countvalarray,cssclass,datecreated,description,displaycomments,displaykids,displaylist,displayname,' +
  'displayratings,displaysummaries,distinct,entityname,featuretype,feedid,fieldaliases,fields,groupbyarray,id,imageheight,' +
  'imagesize,imagewidth,includehomepage,isactive,isdefault,isfeaturesonly,islocked,isnew,ispublic,joins,keyfield,lang,' +
  'lastupdate,lastupdateby,links,liveonly,maxitems,maxvalarray,minvalarray,name,nextn,orderby,pageindex,params,parentid,' +
  'pendingparam,remoteid,remotepubdate,remotesourceurl,restricted,restrictgroups,showexcludesearch,shownavonly,siteid,' +
  'sortby,sortdirection,sorttable,sumvalarray,table,tablefieldlist,tablefieldlookup,type,usecategoryintersect,version,' +
  'viewalllabel,viewalllink';

interface CallArgs {
  site?: TenantFixture;
  actor?: Actor;
  id?: string;
  ids?: string[];
  url?: Struct;
  form?: Struct;
  csrf?: boolean;
}

/** A call as ../jsonapi.ts builds it, with a CSRF check that answers `csrf` (default true) and records its calls. */
function callFor(method: Op, a: CallArgs = {}): JsonApiCall & { validateCsrf: ReturnType<typeof vi.fn> } {
  const site = a.site ?? TENANT_A;
  const url: Struct = { ...a.url };
  const form: Struct = { ...a.form };
  const caller = a.actor ?? ANONYMOUS;
  const raw = Object.entries(url)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  const apiContext: JsonApiRequestContext = {
    siteId: site.siteId,
    mode: 'json',
    endpoint: EP.replace(TENANT_A.siteId, site.siteId),
    url,
    form,
    method,
    isAggregateQuery: false,
    user: { loggedIn: caller.isLoggedIn, systemUser: caller.isLoggedIn },
    allowAction: () => false,
    site: { ...SITE.urls, siteId: site.siteId },
    customImageSizes: [],
  };
  return {
    mode: 'json',
    family: '/_api/json/v1',
    routeKey: `api:feed.${method.toLowerCase()}`,
    method,
    entityName: 'feed',
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.ids === undefined ? {} : { ids: a.ids }),
    pathInfo: [site.siteId, 'feed'],
    params: createJsonApiParams(Object.entries({ ...url, ...form })),
    query: { raw, params: createJsonApiParams(Object.entries(url)) },
    siteId: site.siteId,
    tenantId: site.tenantId,
    actor: caller,
    site: { ...SITE, siteId: site.siteId },
    apiContext,
    httpMethod: method === 'save' ? 'POST' : method === 'delete' ? 'DELETE' : 'GET',
    headers: {},
    validateCsrf: vi.fn(() => Promise.resolve(a.csrf ?? true)),
  };
}

let fx: ContentFixture;

/** Runs `op` of the feed handler for `call`. */
function run(op: Op, call: JsonApiCall): Promise<JsonApiResult> {
  const fn = feedHandler[op];
  if (fn === undefined) throw new Error(`feed has no ${op}`);
  return fn({ domain: fx.deps } as unknown as ContentRouteContext, call);
}

/** Runs `op` for a call built from `a`. */
const on = (op: Op, a: CallArgs = {}): Promise<JsonApiResult> => run(op, callFor(op, a));

/** The `data` of `result` as the JSON API puts it on the wire. */
function wire(result: JsonApiResult): Struct {
  expect(result.error).toBeUndefined();
  const { body } = serializeResponse(buildEnvelope({ method: 'findOne', data: result.data }), {
    serializer: contentApiSerializer(result.serializerEntity ?? ''),
  });
  return (JSON.parse(body) as { data: Struct }).data;
}

const itemsOf = (result: JsonApiResult): Struct[] => wire(result)['items'] as Struct[];
const legacyError = (type: string): unknown => expect.objectContaining({ name: 'LegacyApiError', type });
const stored = async (feedId: string): Promise<boolean> => (await readFeed(fx.deps, ADMIN, { feedId })).isNew === 0;

/** A tenant-a feed created through the domain; `parentid` HOME lets an S2 actor pass AllowAction. */
async function feed(data: Struct, actor: Actor = ADMIN): Promise<string> {
  const bean = await createFeed(fx.deps, actor, { siteid: actor.siteId, type: 'Local', ...data });
  expect(bean.errors).toEqual({});
  return bean.text('feedid');
}

let OPEN = '';
let PLAIN = '';
let LOCKED = '';
let ITEMS = '';

describe.skipIf(!(await pgAvailable()))('JSON API feed handler', () => {
  beforeAll(async () => {
    fx = await createContentFixture('jsonapi-feed-test');
    for (const [actor, site, title] of [[ADMIN, SITE, 'Home'], [ADMIN_B, SITE_B, 'Home B']] as const) {
      const saved = await saveContent(fx.deps, actor, site, { siteid: site.siteId, type: 'Page', approved: 1, contentid: HOME, parentid: END, title });
      expect(saved.errors).toEqual({});
    }
    OPEN = await feed({ name: 'Open', parentid: HOME });
    PLAIN = await feed({ name: 'Plain' });
    LOCKED = await feed({ name: 'Locked', parentid: HOME, islocked: 1 });
    ITEMS = await feed({ name: 'Items', contentid: HOME });
    await feed({ name: 'Bee' }, ADMIN_B);
  });

  afterAll(async () => {
    await fx?.drop();
  });

  describe('reads', () => {
    it('findOne answers an unknown id anonymously with the fresh bean of the request site, as the oracle does', async () => {
      const data = wire(await on('findOne', { id: cfId('X', 1) }));
      expect(Object.keys(data).sort().join(',')).toBe(FIND_ONE_KEYS);
      expect(data).toMatchObject({
        id: '',
        feedid: '',
        siteid: TENANT_A.siteId,
        isnew: 1,
        entityname: 'feed',
        type: 'local',
        table: 'tcontent',
        cachedwithin: '0',
        displaysummaries: '1',
        distinct: false,
        params: [],
        lastupdate: '2026-06-30T10:15:42',
        fieldaliases: { tag: { datatype: 'varchar', field: 'tcontenttags.tag' } },
      });
      expect(data['links']).toEqual({
        all: `${EP}/content`,
        properties: `${EP}/content/properties`,
        self: `${EP}/content/`,
        history: `${EP}/content//history`,
        rendered: `${EP}/content/_path/`,
        crumbs: `${EP}/content//crumbs`,
        relatedcontent: `${EP}/content//relatedcontent`,
        permissions: `${EP}/content//permissions`,
        site: `${EP}/site`,
        entities: EP,
      });
    });

    it.each([
      ['an S2 admin, whom AllowAction allows', ADMIN, true],
      ['an anonymous caller', ANONYMOUS, false],
    ])('findOne with fields reads the stored feed for %s, with the cFeed edit link only when allowed', async (_label, actor, edit) => {
      const data = wire(await on('findOne', { actor, id: OPEN, url: { fields: 'name,links' } }));
      expect(data).toMatchObject({ id: OPEN, name: 'Open', contentid: '', siteid: TENANT_A.siteId, isnew: 0, entityname: 'feed' });
      const editUrl = `/admin/?muraAction=cFeed.edit&feedID=${OPEN}&siteid=${TENANT_A.siteId}&type=Local&compactDisplay=false`;
      expect((data['links'] as Struct)['edit']).toBe(edit ? editUrl : undefined);
    });

    it('findQuery needs the Collections module and lists only the site\'s feeds under /content/ paging links', async () => {
      expect(await on('findQuery', { url: { name: 'Open' } })).toEqual({ error: 'authorization' });
      const result = await on('findQuery', { actor: COLLECTIONS, url: { name: 'Open' } });
      const data = wire(result);
      expect((data['items'] as Struct[]).map((item) => item['name'])).toEqual(['Open']);
      expect(data).toMatchObject({ entityname: 'feed', totalitems: 1 });
      expect((data['links'] as Struct)['self']).toBe(`${EP}/content/?name=Open&pageIndex=1`);
      expect((data['links'] as Struct)['properties']).toBe(`${EP}/feed/properties`);
      const all = itemsOf(await on('findQuery', { actor: COLLECTIONS, url: { islocked: 0 } }));
      expect(all.map((item) => item['name']).sort()).toEqual(['Items', 'Open', 'Plain']);
    });

    it('findQuery reads only the selected columns of a fields SELECT, so siteid stays empty', async () => {
      const [item] = itemsOf(await on('findQuery', { actor: COLLECTIONS, url: { name: 'Plain', fields: 'name,bogus' } }));
      expect(item).toEqual({ contentid: '', feedid: PLAIN, id: PLAIN, siteid: '', isnew: 0, entityname: 'feed', name: 'Plain', bogus: '' });
    });

    it.each([
      [{ displaysummaries: '1' }, 'invalidParameters'],
      [{ isnew: '0' }, 'server_error'],
    ])('findQuery by %o fails as legacy does', async (url, type) => {
      await expect(on('findQuery', { actor: COLLECTIONS, url })).rejects.toEqual(legacyError(type));
    });

    it('findQuery ignores the `site` relation, which holds no value, and counts with countOnly as legacy\'s text count', async () => {
      expect(itemsOf(await on('findQuery', { actor: COLLECTIONS, url: { site: 'x', name: 'Plain' } }))).toHaveLength(1);
      expect(wire(await on('findQuery', { actor: COLLECTIONS, url: { countOnly: 'true' } }))).toEqual({ count: '4' });
    });

    it('findAll counts anonymously with countOnly and otherwise refuses `feed` with invalidParameters', async () => {
      expect(wire(await on('findAll', { url: { countOnly: 'true' } }))).toEqual({ count: '4' });
      await expect(on('findAll')).rejects.toEqual(legacyError('invalidParameters'));
    });

    it('findMany keeps the ids order under explicit fields and fails at hasImage under the contentnav defaults', async () => {
      expect(await on('findMany', { ids: [PLAIN, OPEN] })).toEqual({ error: 'authorization' });
      const items = itemsOf(await on('findMany', { actor: COLLECTIONS, ids: [PLAIN, OPEN], url: { fields: 'name,url' } }));
      expect(items.map((item) => [item['name'], item['url'], item['entityname']])).toEqual([
        ['Plain', '', 'content'],
        ['Open', '', 'content'],
      ]);
      await expect(on('findMany', { actor: COLLECTIONS, ids: [OPEN] })).rejects.toBeInstanceOf(UndefinedLegacyMethodError);
      expect(wire(await on('findMany', { actor: COLLECTIONS, ids: [cfId('X', 2)] }))).toMatchObject({ totalitems: 0, items: [] });
    });

    it('findNew fails at hasImage unless fields leave images out under url.entityname=content', async () => {
      await expect(on('findNew', { actor: ADMIN })).rejects.toBeInstanceOf(UndefinedLegacyMethodError);
      await expect(on('findNew', { url: { fields: 'name' } })).rejects.toBeInstanceOf(UndefinedLegacyMethodError);
      const data = wire(await on('findNew', { url: { fields: 'name,url', entityname: 'content' } }));
      expect(data).toEqual({ contentid: '', id: '', siteid: TENANT_A.siteId, isnew: 1, url: '', entityname: 'content', name: '' });
    });

    it('findProperties answers without an access check under the `content` display name', async () => {
      expect(wire(await on('findProperties'))).toMatchObject({ displayname: 'content', primarykey: 'feedid', public: false });
    });

    it.each([
      ['anonymous on a stored feed', ANONYMOUS, () => OPEN, { read: true, save: false, delete: false }],
      ['an S2 admin on a feed under Home', ADMIN, () => OPEN, { read: true, save: true, delete: true }],
      ['an S2 admin on a feed without a parent', ADMIN, () => PLAIN, { read: true, save: false, delete: false }],
      ['an S2 admin on an unknown id', ADMIN, () => 'permissions', { read: true, save: false, delete: false }],
      ['anonymous on a feed whose content id loads', ANONYMOUS, () => ITEMS, { read: true, save: false, delete: false }],
    ])('findPermissions for %s', async (_label, actor, id, expected) => {
      expect(wire(await on('findPermissions', { actor, id: id() }))).toEqual(expected);
    });

    it('fails findPermissions where legacy hands getNodePerm the feed\'s missing crumb array', async () => {
      await expect(on('findPermissions', { actor: ADMIN, id: ITEMS })).rejects.toThrow(/CRUMBDATA/);
    });
  });

  describe('writes', () => {
    it('save checks CSRF first and then refuses a feed AllowAction denies, writing nothing', async () => {
      const denied = callFor('save', { actor: ADMIN, form: { name: 'Nope' } });
      expect(await run('save', denied)).toEqual({ error: 'authorization' });
      expect(denied.validateCsrf).toHaveBeenCalledOnce();
      expect(await on('save', { actor: ADMIN, form: { name: 'Nope', parentid: HOME }, csrf: false })).toEqual({ error: 'invalidTokens' });
      expect(wire(await on('findQuery', { actor: COLLECTIONS, url: { name: 'Nope', countOnly: 'true' } }))).toEqual({ count: '0' });
    });

    it('save creates an allowed feed and then fails at hasImage, as the oracle does after its write', async () => {
      await expect(on('save', { actor: ADMIN, form: { name: 'Created', parentid: HOME } })).rejects.toBeInstanceOf(UndefinedLegacyMethodError);
      const [item] = itemsOf(await on('findQuery', { actor: COLLECTIONS, url: { name: 'Created' } }));
      expect(item).toMatchObject({ name: 'Created', parentid: HOME, lastupdateby: 'Admin User', contentpoolid: TENANT_A.siteId, isnew: 0 });
    });

    it('save updates with fields under url.entityname=content, and answers 403 with the request values on errors', async () => {
      const url = { fields: 'name,url,lang', entityname: 'content' };
      const updated = await on('save', { actor: ADMIN, id: OPEN, url, form: { feedid: OPEN, name: 'Opened' } });
      expect(updated.status).toBe(200);
      expect(wire(updated)).toMatchObject({ id: OPEN, name: 'Opened', url: '', entityname: 'content', saveerrors: '', errors: {} });
      const invalid = await on('save', { actor: ADMIN, id: OPEN, url, form: { feedid: OPEN, name: 'Broken', lang: '' } });
      expect(invalid.status).toBe(403);
      expect(wire(invalid)).toMatchObject({ name: 'Broken', lang: '', errors: { lang: "The property named 'lang' is not valid" } });
      const after = await readFeed(fx.deps, ADMIN, { feedId: OPEN });
      expect([after.text('name'), after.text('lang')]).toEqual(['Opened', 'en-us']);
    });

    it('delete answers \'\' for a missing feed without a CSRF check', async () => {
      const missing = callFor('delete', { actor: ADMIN, id: cfId('X', 3) });
      expect(await run('delete', missing)).toEqual({ status: 200, data: '' });
      expect(missing.validateCsrf).not.toHaveBeenCalled();
    });

    it.each([
      ['AllowAction denies', ANONYMOUS, () => OPEN, true, { error: 'authorization' }, true],
      ['the token is invalid', ADMIN, () => OPEN, false, { error: 'invalidTokens' }, true],
      ['the feed is locked', ADMIN, () => LOCKED, true, { status: 200, data: '' }, true],
      ['it is allowed', ADMIN, () => OPEN, true, { status: 200, data: '' }, false],
    ])('delete when %s', async (_label, actor, id, csrf, expected, remains) => {
      expect(await on('delete', { actor, id: id(), csrf })).toEqual(expected);
      expect(await stored(id())).toBe(remains);
    });
  });
});
