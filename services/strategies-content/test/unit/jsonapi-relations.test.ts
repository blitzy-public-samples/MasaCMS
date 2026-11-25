// JSON API related-entity reads through the composition root over a throwaway `content` schema: expandEntity's
// relations (jsonApiUtility.cfc:2424-2497) and the `<entity>/<id>/<relation>` paths (1086-1150). Expected shapes follow
// Masa 7.6.1 on ACF 2023; `site` values come from a programs-sites double.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LEGACY_ERROR_MAP, type LegacyApiErrorType } from '@opt2/platform/legacy-compat';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, loadOpenApiDocument, pgAvailable } from '@opt2/platform/testing';
import { createCategory } from '../../src/domain/categories.js';
import { saveContent } from '../../src/domain/content.js';
import { UndefinedLegacyMethodError } from '../../src/domain/context.js';
import { createFeed } from '../../src/domain/feeds.js';
import { saveVariationTargeting } from '../../src/domain/variations.js';
import { createSitesClient } from '../../src/legacy/sites-client.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { createRelatedEntityReader, relationPathOf } from '../../src/routes/jsonapi-relations.js';
import type { JsonApiCall } from '../../src/routes/jsonapi/index.js';
import { ADMIN, END, HOME, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;

const OPENAPI = loadOpenApiDocument(new URL('../../contracts/openapi.yaml', import.meta.url), parse) as object;
const API = `/_api/json/v1/${SITE_ID}`;
const SITES_SERVICE = 'programs-sites';
const SITE_VALUES_PATH = '/internal/v1/sites/json-api-values:lookup';
/** contentCommentBean.allowQueryParams' field list for a caller without the comments module (contentCommentBean.cfc:755). */
const PUBLIC_COMMENT_FIELDS =
  'comments,links,entered,isspam,flagcount,parentid,name,isapproved,kids,isdeleted,userid,subscribe,isnew,contentid,path,siteid,id,remoteid,contenthistid';
const C1 = cfId('C', 1);
const C2 = cfId('C', 2);
const FILE_ID = cfId('F', 1);

/** The `site` findOne values the programs-sites double answers for `siteId` under `baseUrl`. */
function siteValues(baseUrl: string, siteId: string): Struct {
  return {
    links: {
      entities: baseUrl,
      all: `${baseUrl}/site`,
      properties: `${baseUrl}/site/properties`,
      self: `${baseUrl}/site`,
      permissions: `${baseUrl}/site/${siteId}/permissions`,
    },
    domain: 'tenant-a.example.test',
    siteid: siteId,
    isnew: 0,
    id: siteId,
    entityname: 'site',
  };
}

let fx: ContentFixture;
let t: TestApp<TenantDb>;
let ALPHA = '';
let BETA = '';
let CAT = '';
let KID = '';
let FEED = '';
/** getEndPoint() of the injected requests. */
let EP = '';

/** Saves a tenant-a page through the domain and returns its content id. */
async function page(data: Struct): Promise<string> {
  const saved = await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, type: 'Page', approved: 1, ...data });
  expect(saved.errors).toEqual({});
  return saved.bean.contentId();
}

/** Stores a tenant-a comment row on ALPHA. */
async function comment(values: Struct): Promise<void> {
  await withTenant(fx.handle.app, TENANT_A.tenantId, async (tx) => {
    const row: Struct = { contentid: ALPHA, siteid: SITE_ID, isapproved: 1, isspam: 0, isdeleted: 0, flagcount: 0, subscribe: 0, ...values };
    const names = Object.keys(row);
    const placeholders = names.map((_, i) => `$${String(i + 2)}`).join(', ');
    await tx.query(`INSERT INTO ${fx.handle.schema}.comment (tenant_id, ${names.join(', ')}) VALUES ($1, ${placeholders})`, [tx.tenantId, ...Object.values(row)]);
  });
}

/** GET `path` of the site's JSON API from `on` as `subject`, checked against the contract's operation. */
async function get(path: string, subject: ContentSubject = 's2', on: TestApp<TenantDb> = t): Promise<{ status: number; body: Struct }> {
  const url = `${API}${path}`;
  const res = await on.app.inject({ method: 'GET', url, headers: await contentHeaders(subject) });
  assertResponseMatchesOpenApi(OPENAPI, {
    method: 'GET',
    path: `/_api/json/v1/{siteid}/{path}`,
    status: res.statusCode,
    contentType: res.headers['content-type'],
    body: res.body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Struct };
}

/** The `data` of a 200 answer reporting `method`. */
async function data(path: string, method: string, subject: ContentSubject = 's2', on: TestApp<TenantDb> = t): Promise<Struct> {
  const { status, body } = await get(path, subject, on);
  expect({ status, method: body['method'], keys: Object.keys(body) }).toEqual({ status: 200, method, keys: ['apiversion', 'data', 'method'] });
  return body['data'] as Struct;
}

/** The error envelope processRequest's catch serializes for `type`, reporting `method`. */
function errorOf(type: LegacyApiErrorType, method: string): Struct {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return { apiversion: 'v1', method, error: expect.objectContaining({ message, code }) };
}

/** The test app, answering the programs-sites site values lookup from {@link siteValues}. */
function relationsApp(env: Record<string, string> = {}): Promise<TestApp<TenantDb>> {
  return buildTestApp({
    db: fx.handle.app,
    clock: fx.deps.clock,
    env,
    clientHandlers: {
      [SITES_SERVICE]: {
        [`POST ${SITE_VALUES_PATH}`]: (req) => {
          const { baseUrl, siteIds } = req.json as { baseUrl: string; siteIds: string[] };
          return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: { items: siteIds.map((id) => siteValues(baseUrl, id)) } };
        },
      },
    },
  });
}

const items = (collection: Struct): Struct[] => collection['items'] as Struct[];
const linksOf = (value: Struct): Struct => value['links'] as Struct;
const sitesLookups = () => t.client.requests.filter((req) => req.service === SITES_SERVICE);

describe.skipIf(!(await pgAvailable()))('JSON API related entities through the composition root', () => {
  beforeAll(async () => {
    fx = await createContentFixture('jsonapi-relations-test');
    await page({ contentid: HOME, parentid: END, title: 'Home' });
    ALPHA = await page({ parentid: HOME, title: 'Alpha', filename: 'alpha' });
    BETA = await page({ parentid: ALPHA, title: 'Beta', filename: 'alpha/beta' });
    await comment({ commentid: C1, name: 'Commenter', comments: 'First', entered: new Date(2026, 5, 1, 9, 0, 0), path: C1 });
    await comment({ commentid: C2, name: 'Replier', comments: 'Reply', entered: new Date(2026, 5, 1, 10, 0, 0), parentid: C1, path: `${C1},${C2}` });
    const domain = { db: fx.deps.db, repository: fx.deps.repository, clock: fx.deps.clock, config: fx.deps.config };
    CAT = (await createCategory(domain, ADMIN, { siteid: SITE_ID, name: 'Cat' })).categoryid;
    KID = (await createCategory(domain, ADMIN, { siteid: SITE_ID, name: 'Cat Kid', parentid: CAT })).categoryid;
    const feed = await createFeed(fx.deps, ADMIN, { siteid: SITE_ID, type: 'Local', name: 'Relations Feed' });
    expect(feed.errors).toEqual({});
    FEED = feed.text('feedid');
    t = await relationsApp();
    EP = String(linksOf(await data(`/content/${ALPHA}?fields=title,links`, 'findOne'))['entities']);
  });

  afterAll(async () => {
    await t?.close();
    await fx?.drop();
  });

  beforeEach(() => {
    t.client.clear();
  });

  describe('relation paths', () => {
    it.each([
      ['content', () => `/content/${ALPHA}/kids`],
      ['contentnav', () => `/contentnav/${ALPHA}/kids`],
      ['content, with expand dropped', () => `/content/${ALPHA}/kids?expand=kids`],
    ])('reads the kids of %s through the content findQuery by the loaded parent id', async (_label, path) => {
      const kids = await data(path(), 'findQuery');
      expect(items(kids).map((item) => ({ id: item['id'], title: item['title'], entityname: item['entityname'] }))).toEqual([{ id: BETA, title: 'Beta', entityname: 'content' }]);
      expect(linksOf(kids)['self']).toBe(`${EP}/content/?parentid=${ALPHA}&pageIndex=1`);
    });

    it.each<ContentSubject>(['s2', 'anonymous'])('reads content comments through the comment findQuery as %s, with the comment config fields', async (subject) => {
      const comments = await data(`/content/${ALPHA}/comments`, 'findQuery', subject);
      expect(items(comments).map((item) => item['id'])).toEqual([C1, C2]);
      expect(items(comments).every((item) => !('comments' in item) && !('email' in item))).toBe(true);
      expect(linksOf(comments)['self']).toBe(`${EP}/comment/?contentid=${ALPHA}&pageIndex=1`);
    });

    it('answers the countOnly of a relation path', async () => {
      expect(await data(`/content/${ALPHA}/comments?countOnly=1`, 'findQuery')).toEqual({ count: '2' });
    });

    it('filters content category assignments by the content id as contenthistid, as legacy does', async () => {
      const assignments = await data(`/content/${ALPHA}/categoryassignments`, 'findQuery', 'anonymous');
      expect({ items: items(assignments), entityname: assignments['entityname'], self: linksOf(assignments)['self'] }).toEqual({
        items: [],
        entityname: 'contentCategoryAssign',
        self: `${EP}/contentCategoryAssign/?contenthistid=${ALPHA}&pageIndex=0`,
      });
    });

    it.each([
      ['content', () => `/content/${ALPHA}/site`],
      ['category', () => `/category/${CAT}/site`],
      ['comment', () => `/comment/${C1}/site`],
      ['feed', () => `/feed/${FEED}/site`],
    ])('answers the site of a %s from programs-sites as the service itself, anonymously too', async (_label, path) => {
      for (const subject of ['s2', 'anonymous'] as const) {
        const site = await data(path(), 'findOne', subject);
        expect(site).toEqual(siteValues(EP, SITE_ID));
        // The oracle's wire order (ACF struct order).
        expect([Object.keys(site), Object.keys(linksOf(site))]).toEqual([
          ['domain', 'links', 'id', 'siteid', 'isnew', 'entityname'],
          ['all', 'permissions', 'properties', 'self', 'entities'],
        ]);
      }
      expect(sitesLookups().map(({ method, path: called, json, userToken }) => ({ method, called, json, userToken }))).toEqual(
        Array.from({ length: 2 }, () => ({ method: 'POST', called: SITE_VALUES_PATH, json: { baseUrl: EP, siteIds: [SITE_ID] }, userToken: null })),
      );
    });

    it.each([
      ['changeset', 'changeset'],
      ['stats', 'stats'],
    ])('reads the %s of content as the signed-in administrator and refuses it anonymously with 401', async (relation, entity) => {
      const related = await data(`/content/${ALPHA}/${relation}`, 'findOne');
      expect(related['entityname']).toBe(entity);
      const anonymous = await get(`/content/${ALPHA}/${relation}`, 'anonymous');
      expect(anonymous).toEqual({ status: 401, body: errorOf('authorization', 'findOne') });
    });

    it('answers a new changeset bean for content without a change set', async () => {
      const changeset = await data(`/content/${ALPHA}/changeset`, 'findOne');
      expect({ isnew: changeset['isnew'], siteid: changeset['siteid'] }).toEqual({ isnew: 1, siteid: SITE_ID });
    });

    it.each([
      ['the parent of content', () => `/content/${ALPHA}/parent?fields=title`, () => ({ id: HOME, title: 'Home' })],
      ['the parent of content, with expand dropped', () => `/content/${ALPHA}/parent?fields=title&expand=kids`, () => ({ id: HOME, title: 'Home' })],
      ['the active content of a fileMetaData loaded by the path id as contentid', () => `/fileMetaData/${ALPHA}/activeContent?fields=title`, () => ({ id: ALPHA, title: 'Alpha' })],
      ['the parent of a category', () => `/category/${KID}/parent?fields=name`, () => ({ id: CAT, name: 'Cat' })],
      ['the parent of a comment', () => `/comment/${C2}/parent`, () => ({ id: C1, name: 'Commenter' })],
    ])('reads %s through its findOne', async (_label, path, expected) => {
      expect(await data(path(), 'findOne')).toEqual(expect.objectContaining(expected()));
    });

    it('loads a comment by its id as contentid for its content, so the content is a new bean', async () => {
      const content = await data(`/comment/${C1}/content?fields=title`, 'findOne');
      expect({ isnew: content['isnew'], title: content['title'] }).toEqual({ isnew: 1, title: '' });
      expect(content['id']).not.toBe(ALPHA);
    });

    it.each([
      ['comment', () => `/comment/${C1}/kids`, () => [C2], () => `${EP}/comment/?parentid=${C1}&pageIndex=1`],
      ['category', () => `/category/${CAT}/kids?fields=name`, () => [KID], () => `${EP}/category/?parentid=${CAT}&pageIndex=1`],
    ])('reads the kids of a %s through its findQuery by the source primary key', async (_label, path, ids, self) => {
      const kids = await data(path(), 'findQuery');
      expect({ ids: items(kids).map((item) => item['id']), self: linksOf(kids)['self'] }).toEqual({ ids: ids(), self: self() });
    });

    it.each([
      ['category content assignments', () => `/category/${CAT}/contentassignments`, 'findQuery'],
      ['changeset category assignments', () => `/changeset/${ALPHA}/categoryassignments`, 'findQuery'],
      ['changeset content assignments', () => `/changeset/${ALPHA}/contentassignments`, 'findQuery'],
      ['the content of stats, whose bean has no loadBy', () => `/stats/${ALPHA}/content?fields=title`, 'findOne'],
      ['the site of stats, whose bean has no loadBy', () => `/stats/${ALPHA}/site`, 'findOne'],
    ])('answers %s with the legacy 500', async (_label, path, method) => {
      expect(await get(path())).toEqual({ status: 500, body: errorOf('server_error', method) });
    });

    it.each(['content', 'site', 'fileMetaData'])('refuses the file %s path as the file method call legacy resolves it to', async (relation) => {
      expect(await get(`/file/${FILE_ID}/${relation}`)).toEqual({ status: 400, body: errorOf('invalidMethodCall', 'file') });
    });

    it('answers programs-sites unavailability with the legacy 503', async () => {
      t.client.failNext(SITES_SERVICE);
      expect((await get(`/content/${ALPHA}/site`)).status).toBe(503);
    });

    describe('of variationTargeting, with variations on', () => {
      let variations: TestApp<TenantDb>;
      let TARGETING = '';

      beforeAll(async () => {
        const { saved } = await saveVariationTargeting({ ...fx.deps, config: { ...fx.deps.config, variations: true } }, ADMIN, { contentid: BETA, siteid: SITE_ID });
        TARGETING = saved?.targetingid ?? '';
        variations = await relationsApp({ MURA_VARIATIONS: 'true' });
      });

      afterAll(async () => {
        await variations?.close();
      });

      it.each([
        ['without a row, from the new bean loadBy leaves', () => ALPHA],
        ['from the item\'s stored row', () => BETA],
      ])('reads the content of a variationTargeting loaded by the path id as contentid %s', async (_label, id) => {
        expect(await data(`/variationTargeting/${id()}/content?fields=title`, 'findOne', 's2', variations)).toEqual(expect.objectContaining({ id: id(), isnew: 0 }));
      });

      it('reads the site of a variationTargeting loaded by its primary key', async () => {
        expect(TARGETING).not.toBe('');
        expect(await data(`/variationTargeting/${TARGETING}/site`, 'findOne', 's2', variations)).toEqual(siteValues(EP, SITE_ID));
      });
    });
  });

  describe('reader and resolution', () => {
    it.each([
      ['content', 'nosuch', undefined],
      ['content', 'KIDS', 'findQuery'],
      ['contentnav', 'parent', 'findOne'],
      ['stats', 'content', 'findOne'],
      ['file', 'content', 'file'],
      ['fileMetaData', 'file', 'findOne'],
    ])('resolves the %s relation %s to %j', (entity, name, method) => {
      expect(relationPathOf(entity, name)?.method).toBe(method);
    });

    it('rejects the crumbs of a bean without getCrumbIterator as legacy\'s undefined method', async () => {
      const reader = createRelatedEntityReader({ domain: fx.deps } as unknown as ContentRouteContext, createSitesClient(t.client));
      const view = { entityName: 'comment', configName: 'comment', primaryKey: 'commentid', allValues: {}, hasMany: [], hasOne: [] };
      await expect(reader.crumbs({} as JsonApiCall, view)).rejects.toBeInstanceOf(UndefinedLegacyMethodError);
    });
  });

  describe('expansions', () => {
    it('expands every relation with expand=all for the signed-in administrator', async () => {
      const alpha = await data(`/content/${ALPHA}?fields=title&expand=all`, 'findOne');
      expect(Object.keys(alpha)).toEqual(
        expect.arrayContaining(['site', 'categoryassignments', 'changeset', 'stats', 'comments', 'kids', 'parent', 'crumbs', 'relatedcontent']),
      );
      expect(alpha['site']).toEqual(siteValues(EP, SITE_ID));
      expect((alpha['parent'] as Struct)['id']).toBe(HOME);
      expect(items(alpha['kids'] as Struct).map((item) => item['id'])).toEqual([BETA]);
      expect(items(alpha['relatedcontent'] as Struct).map((set) => set['name'])).toEqual(['Default']);
      expect(sitesLookups()).toHaveLength(1);
    });

    it.each(['all', '*', 'stats', 'changeset'])('refuses expand=%s anonymously with 401, as the related findOne does', async (expand) => {
      expect(await get(`/content/${ALPHA}?fields=title&expand=${encodeURIComponent(expand)}`, 'anonymous')).toEqual({
        status: 401,
        body: errorOf('authorization', 'findOne'),
      });
    });

    it.each(['categoryassignments', 'comments', 'site', 'relatedcontent'])('expands %s anonymously', async (expand) => {
      const alpha = await data(`/content/${ALPHA}?fields=title&expand=${expand}`, 'findOne', 'anonymous');
      expect(alpha[expand]).toBeDefined();
    });

    it('links expanded comments by the params allowQueryParams leaves, in ACF key order', async () => {
      const alpha = await data(`/content/${ALPHA}?fields=title&expand=comments`, 'findOne', 'anonymous');
      expect(linksOf(alpha['comments'] as Struct)['self']).toBe(`${EP}/comment/?contentid=${ALPHA}&FIELDS=${PUBLIC_COMMENT_FIELDS}&isdeleted=0&isspam=0&pageIndex=1`);
    });

    it.each([
      ['2', true],
      ['x', false],
      ['', false],
    ])('nests expansions within expanddepth=%j only while the depth allows', async (depth, nested) => {
      const alpha = await data(`/content/${ALPHA}?fields=title&expand=kids,comments&expanddepth=${depth}`, 'findOne');
      const [kid] = items(alpha['kids'] as Struct);
      const [first] = items(alpha['comments'] as Struct);
      expect({ kidComments: kid?.['comments'] !== undefined, commentKids: typeof first?.['kids'] === 'object' }).toEqual({ kidComments: nested, commentKids: nested });
    });

    it('reads the site once per request for every item that expands it', async () => {
      const kids = await data(`/content?parentid=${HOME}&expand=site`, 'findQuery');
      expect(items(kids).map((item) => item['site'])).toEqual([siteValues(EP, SITE_ID)]);
      expect(sitesLookups()).toHaveLength(1);
    });

    it.each([
      ['comment', () => `/comment/${C2}?expand=content,parent,site,kids`, ['content', 'parent', 'site', 'kids']],
      ['category', () => `/category/${CAT}?expand=all`, ['kids', 'contentassignments', 'site', 'crumbs']],
      ['feed', () => `/feed/${FEED}?expand=site`, ['site']],
      ['stats', () => `/stats/${ALPHA}?expand=content,site`, ['content', 'site']],
    ])('expands the relations of a %s through their entities', async (_label, path, keys) => {
      const expanded = await data(path(), 'findOne');
      for (const key of keys) expect(expanded[key]).toEqual(expect.any(Object));
    });

    it.each([
      ['findOne', () => `/feed/${FEED}?fields=name&expand=site`, (body: Struct) => body],
      ['findQuery', () => `/feed?fields=name&expand=site`, (body: Struct) => items(body)[0] ?? {}],
    ])('reads the site of a feed %s by feedid, as legacy does under its url.entityname, so its id is empty', async (method, path, item) => {
      expect(item(await data(path(), method))['site']).toEqual({ ...siteValues(EP, SITE_ID), id: '' });
    });

    it.each(['crumbs', 'relatedcontent'])('answers expand=%s of a feed with the legacy 500', async (expand) => {
      expect(await get(`/feed/${FEED}?fields=path&expand=${expand}`)).toEqual({ status: 500, body: errorOf('server_error', 'findOne') });
    });

    it('answers programs-sites unavailability during an expansion with the legacy 503', async () => {
      t.client.failNext(SITES_SERVICE);
      expect((await get(`/content/${ALPHA}?fields=title&expand=site`)).status).toBe(503);
    });
  });
});
