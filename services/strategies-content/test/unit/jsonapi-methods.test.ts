// JSON API public methods over a throwaway `content` schema with tenant-a, whose file and category pools are the umbrella
// site. Expected shapes follow what Masa 7.6.1 on ACF 2023 answers for the same calls.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildEnvelope, serializeResponse } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_UMBRELLA, assertResponseMatchesOpenApi, pgAvailable, seedRegistry } from '@opt2/platform/testing';
import { createCategory, type CategoryBean } from '../../src/domain/categories.js';
import { saveContent } from '../../src/domain/content.js';
import { actorFromClaims, type Actor } from '../../src/domain/context.js';
import { contentApiSerializer, jsonApiEndpoint, type JsonApiRequestContext } from '../../src/legacy/jsonapi-serializers.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { CONTENT_METHODS } from '../../src/routes/jsonapi/methods.js';
import { createJsonApiParams, type JsonApiCall, type JsonApiResult } from '../../src/routes/jsonapi/types.js';
import { ADMIN, END, HOME, NOBODY, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

type Struct = Record<string, unknown>;
type Method = 'findCrumbArray' | 'findVersionHistory' | 'findRelatedContent' | 'findCalendarItems' | 'getURLForImage' | 'submitForm';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const ANONYMOUS = actorFromClaims(undefined, '');
/** A tenant-a user with the Categories module, which category writes need. */
const CATEGORY_EDITOR: Actor = { ...NOBODY, userId: cfId('U', 3), roles: ['system-user', 'm:010'] };
const EP = jsonApiEndpoint({ adminSSL: false, requestProtocol: 'http', serverName: 'localhost', serverPort: '', context: '', mode: 'json', siteId: SITE_ID });
const POOL = TENANT_UMBRELLA.siteId;
const DEFAULT_SET = '00000000000000000000000000000000000';
const GALLERY_SET = cfId('R', 1);
const PAGE_SUBTYPE = cfId('Q', 1);
const SPECIAL_SUBTYPE = cfId('Q', 2);
const USERS_SET = cfId('R', 2);
const IMAGE = cfId('F', 1);
const BROCHURE = cfId('F', 2);

interface CallArgs {
  actor?: Actor;
  entityName?: string;
  id?: string;
  /** Path segments after the site id, e.g. `['content', id, 'crumbs']`. */
  path?: string[];
  relatedContentSetId?: string;
  url?: Struct;
  siteId?: string;
  site?: Struct;
}

/** A call as ../jsonapi.ts builds it for `method`. */
function callFor(method: Method, a: CallArgs = {}): JsonApiCall {
  const url: Struct = { ...a.url };
  const actor = a.actor ?? ANONYMOUS;
  const apiContext: JsonApiRequestContext = {
    siteId: SITE_ID,
    mode: 'json',
    endpoint: EP,
    url,
    form: {},
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
    routeKey: `api:${method.toLowerCase()}`,
    method,
    entityName: a.entityName ?? '',
    ...(a.id === undefined ? {} : { id: a.id }),
    ...(a.relatedContentSetId === undefined ? {} : { relatedContentSetId: a.relatedContentSetId }),
    pathInfo: [SITE_ID, ...(a.path ?? [method])],
    params: createJsonApiParams(Object.entries({ siteid: SITE_ID, ...url })),
    query: { raw: '', params: createJsonApiParams(Object.entries(url)) },
    siteId: a.siteId ?? SITE_ID,
    tenantId: TENANT_A.tenantId,
    actor,
    site: { ...SITE, ...a.site },
    apiContext,
    httpMethod: 'GET',
    headers: {},
    validateCsrf: () => Promise.reject(new Error('These methods validate no CSRF token')),
  };
}

let fx: ContentFixture;

const routeCtx = (): ContentRouteContext => ({ domain: fx.deps, storage: fx.deps.storage }) as unknown as ContentRouteContext;

/** Runs `method` for `call`. */
function run(method: Method, call: JsonApiCall): Promise<JsonApiResult> {
  const handler = CONTENT_METHODS[method];
  if (handler === undefined) throw new Error(`no ${method}`);
  return handler(routeCtx(), call);
}

const on = (method: Method, a: CallArgs = {}): Promise<JsonApiResult> => run(method, callFor(method, a));

/** The enveloped body of `result` as the dispatcher sends it, checked against the contract's `GET /_api/json/v1/{siteid}`. */
function body(method: Method, result: JsonApiResult): Struct {
  expect(result.error).toBeUndefined();
  expect(result.rawJson).toBeUndefined();
  const status = result.status ?? 200;
  const serializer = result.serializerEntity === undefined ? undefined : contentApiSerializer(result.serializerEntity);
  const response = serializeResponse(buildEnvelope({ method, data: result.data }), { statusCode: status, ...(serializer === undefined ? {} : { serializer }) });
  const contentType = response.headers['Content-Type'];
  assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: `/_api/json/v1/${SITE_ID}`, status, contentType, body: response.body });
  return JSON.parse(response.body) as Struct;
}

const wire = (method: Method, result: JsonApiResult): Struct => body(method, result)['data'] as Struct;
/** The menu titles findCalendarItems lists for a call built from `a`. */
const calendarTitles = async (a: CallArgs): Promise<unknown[]> =>
  (wire('findCalendarItems', await on('findCalendarItems', a)) as unknown as Struct[]).map((row) => row['menutitle']);
const itemsOf = (method: Method, result: JsonApiResult): Struct[] => wire(method, result)['items'] as Struct[];
const legacyError = (type: string): unknown => expect.objectContaining({ name: 'LegacyApiError', type });
const unavailable = (reason: string): unknown => expect.objectContaining({ name: 'LegacyServiceUnavailableError', reason });

/** Saves a tenant-a page through the domain and returns its content id. */
async function page(data: Struct): Promise<string> {
  const saved = await saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, type: 'Page', approved: 1, ...data });
  expect(saved.errors).toEqual({});
  return saved.bean.contentId();
}

/** Inserts `row` into `content.<table>` in `tenantId` through the platform repository. */
function insert(table: string, row: Struct, tenantId: string = TENANT_A.tenantId): Promise<unknown> {
  return withGatedTenant(fx.handle.app, tenantId, (tx) => fx.repo.platform.insert(tx, table, row));
}

let ALPHA = '';
let BETA = '';
let GAMMA = '';
let CALENDAR = '';
let SCHEDULED = '';
let PRIVATE = '';
let LAUNCH = '';
let TALK = '';
let SPECIAL = '';
let EPSILON = '';
let ROOT_TOPIC: CategoryBean;
let CHILD_TOPIC: CategoryBean;

describe.skipIf(!(await pgAvailable()))('JSON API public methods', () => {
  beforeAll(async () => {
    fx = await createContentFixture('jsonapi-methods-test');
    await page({ contentid: HOME, parentid: END, title: 'Home' });
    ALPHA = await page({ parentid: HOME, title: 'Alpha', filename: 'alpha' });
    BETA = await page({ parentid: ALPHA, title: 'Beta' });
    GAMMA = await page({ parentid: HOME, title: 'Gamma' });
    await insert('extend_subtype', { subtypeid: PAGE_SUBTYPE, siteid: SITE_ID, type: 'Page', subtype: 'Default', basetable: 'tcontent' });
    await insert('extend_rc_set', { relatedcontentsetid: GALLERY_SET, subtypeid: PAGE_SUBTYPE, siteid: SITE_ID, name: 'Gallery', orderno: 1 });
    await page({
      contentid: ALPHA,
      parentid: HOME,
      title: 'Alpha',
      filename: 'alpha',
      summary: 'second',
      relatedcontentsetdata: JSON.stringify([
        { relatedcontentsetid: DEFAULT_SET, items: [BETA, GAMMA] },
        { relatedcontentsetid: GALLERY_SET, items: [GAMMA] },
      ]),
    });
    // The fixed clock stamps both versions alike; the first is made the older, as two real saves are.
    const [first] = (await fx.rows('content', 'contentid = $1', [ALPHA])) as Array<{ contenthistid: string }>;
    await fx.inTenant((tx) =>
      tx.query(`UPDATE ${fx.handle.schema}.content SET lastupdate = lastupdate - interval '1 minute' WHERE contenthistid = $1`, [first?.contenthistid]),
    );
    await insert('extend_subtype', { subtypeid: SPECIAL_SUBTYPE, siteid: SITE_ID, type: 'Page', subtype: 'Special', basetable: 'tcontent' });
    await insert('extend_rc_set', { relatedcontentsetid: USERS_SET, subtypeid: SPECIAL_SUBTYPE, siteid: SITE_ID, name: 'Members', entitytype: 'user', orderno: 1 });
    SPECIAL = await page({ parentid: HOME, title: 'Special', subtype: 'Special' });
    const zeta = await page({ parentid: HOME, title: 'Zeta' });
    EPSILON = await page({ parentid: HOME, title: 'Epsilon', relatedcontentsetdata: JSON.stringify([{ relatedcontentsetid: DEFAULT_SET, items: [zeta] }]) });
    // A related item displayed daily, which contentIntervalManager expands.
    await fx.inTenant((tx) =>
      tx.query(`UPDATE ${fx.handle.schema}.content SET display = 2, displaystart = $1, displayinterval = $2 WHERE contentid = $3`, [
        new Date(2026, 5, 1),
        '{"type":"daily","repeats":1}',
        zeta,
      ]),
    );
    // Gamma's file sits in the umbrella file pool, which the related-content query cannot join.
    await fx.inTenant((tx) => tx.query(`UPDATE ${fx.handle.schema}.content SET fileid = $1 WHERE contentid = $2`, [IMAGE, GAMMA]));
    CALENDAR = await page({ type: 'Calendar', parentid: HOME, title: 'Events', filename: 'events' });
    LAUNCH = await page({ parentid: CALENDAR, title: 'Launch', filename: 'events/launch' });
    TALK = await page({ parentid: CALENDAR, title: 'Talk', filename: 'events/talk' });
    const later = await page({ parentid: CALENDAR, title: 'Later', filename: 'events/later' });
    PRIVATE = await page({ type: 'Calendar', parentid: HOME, title: 'Private', filename: 'private', restricted: 1 });
    const meeting = await page({ parentid: PRIVATE, title: 'Meeting', filename: 'private/meeting' });
    // Always-displayed items holding display dates, as migrated rows can; saves clear them and contentIntervalManager keeps them as they are.
    for (const [contentId, start, stop] of [
      [LAUNCH, new Date(2026, 5, 10), new Date(2026, 5, 10, 23, 59)],
      [TALK, new Date(2026, 5, 20, 14, 0), null],
      [later, new Date(2026, 7, 1, 9, 0), null],
      [meeting, new Date(2026, 5, 12, 9, 0), null],
    ] as const) {
      await fx.inTenant((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.content SET displaystart = $1, displaystop = $2 WHERE contentid = $3`, [start, stop, contentId]),
      );
    }
    SCHEDULED = await page({ type: 'Calendar', parentid: HOME, title: 'Fairs' });
    await page({ parentid: SCHEDULED, title: 'Fair', display: 2, displaystart: new Date(2026, 5, 15, 9, 0), displaystop: new Date(2026, 5, 15, 17, 0) });
    ROOT_TOPIC = await createCategory(fx.deps, CATEGORY_EDITOR, { siteid: POOL, name: 'Parent Topic' });
    CHILD_TOPIC = await createCategory(fx.deps, CATEGORY_EDITOR, { siteid: POOL, name: 'Child Topic', parentid: ROOT_TOPIC.categoryid });
    for (const [fileid, filename, fileext] of [
      [IMAGE, 'photo.jpg', 'jpg'],
      [BROCHURE, 'brochure.pdf', 'pdf'],
    ] as const) {
      await withGatedTenant(fx.handle.app, TENANT_UMBRELLA.tenantId, (tx) =>
        fx.repo.files.insertFile(tx, {
          fileid,
          siteid: POOL,
          filename,
          fileext,
          filesize: 10,
          contenttype: 'image',
          contentsubtype: fileext,
          created: new Date(2026, 5, 1),
        }),
      );
    }
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('exports the six carried methods only', () => {
    expect(Object.keys(CONTENT_METHODS)).toEqual([
      'findCrumbArray',
      'findVersionHistory',
      'findRelatedContent',
      'findCalendarItems',
      'getURLForImage',
      'submitForm',
    ]);
    expect(Object.isFrozen(CONTENT_METHODS)).toBe(true);
  });

  describe('findCrumbArray', () => {
    it('answers /content/{id}/crumbs node to root and writes the path route\'s URL scope', async () => {
      const call = callFor('findCrumbArray', { entityName: 'content', id: BETA, path: ['content', BETA, 'crumbs'] });
      const data = wire('findCrumbArray', await run('findCrumbArray', call));
      expect((data['items'] as Struct[]).map((item) => item['title'])).toEqual(['Beta', 'Alpha', 'Home']);
      expect(data).toMatchObject({ totalitems: 3, itemsperpage: 3, entityname: 'content' });
      expect((data['items'] as Struct[])[0]).toMatchObject({ id: BETA, entityname: 'content' });
      expect(call.apiContext.url).toMatchObject({ id: BETA, siteid: SITE_ID, entityname: 'content' });
    });

    it('reads contentnav as content when the method is called by name', async () => {
      const data = wire('findCrumbArray', await on('findCrumbArray', { url: { entityname: 'contentnav', id: ALPHA } }));
      expect((data['items'] as Struct[]).map((item) => item['title'])).toEqual(['Alpha', 'Home']);
    });

    it('answers /category/{id}/crumbs from the umbrella category pool, root first, as a categoryBean collection', async () => {
      const result = await on('findCrumbArray', { entityName: 'category', id: CHILD_TOPIC.categoryid, path: ['category', CHILD_TOPIC.categoryid, 'crumbs'] });
      expect(result.serializerEntity).toBe('category');
      const data = wire('findCrumbArray', result);
      expect((data['items'] as Struct[]).map((item) => [item['name'], item['siteid']])).toEqual([
        ['Parent Topic', POOL],
        ['Child Topic', POOL],
      ]);
      expect(data).toMatchObject({ totalitems: 2, entityname: 'categoryBean' });
    });

    it.each(['comment', 'nosuchentity'])('answers the legacy 500 for %s crumbs', async (entityName) => {
      await expect(on('findCrumbArray', { entityName, id: cfId('X', 1) })).rejects.toEqual(legacyError('server_error'));
    });

    it('answers no crumbs for a content id that loads a new bean', async () => {
      expect(wire('findCrumbArray', await on('findCrumbArray', { entityName: 'content', id: cfId('X', 2) }))).toMatchObject({ items: [], totalitems: 0 });
    });

    it('checks AllowAccess before the missing crumb iterator of a module entity', async () => {
      expect(await on('findCrumbArray', { entityName: 'changeset', id: cfId('X', 1) })).toEqual({ error: 'authorization' });
      await expect(on('findCrumbArray', { actor: ADMIN, entityName: 'changeset', id: cfId('X', 1) })).rejects.toEqual(legacyError('server_error'));
    });

    it('fails closed expanding a category crumb relation', async () => {
      await expect(on('findCrumbArray', { entityName: 'category', id: CHILD_TOPIC.categoryid, url: { expand: 'kids' } })).rejects.toEqual(
        unavailable('category-crumbs-expand-kids'),
      );
    });
  });

  describe('findVersionHistory', () => {
    it.each([
      ['an anonymous caller', ANONYMOUS],
      ['a reader without node permission', NOBODY],
    ])('denies %s', async (_label, actor) => {
      expect(await on('findVersionHistory', { actor, id: ALPHA, path: ['content', ALPHA, 'history'] })).toEqual({ error: 'authorization' });
    });

    it('lists an editor every version, newest first, each self link naming its version', async () => {
      const call = callFor('findVersionHistory', { actor: ADMIN, id: ALPHA, path: ['content', ALPHA, 'history'] });
      const data = wire('findVersionHistory', await run('findVersionHistory', call));
      const items = data['items'] as Struct[];
      expect(items.map((item) => item['summary'])).toEqual(['second', '']);
      for (const item of items) {
        expect((item['links'] as Struct)['self']).toBe(`${EP}/content/${ALPHA}?contenthistid=${String(item['contenthistid'])}`);
      }
      expect(data).toMatchObject({ totalitems: 2, entityname: 'content' });
      // The history route writes no URL siteid (jsonApiUtility.cfc:1040-1046).
      expect(call.apiContext.url).toMatchObject({ id: ALPHA, entityname: 'content' });
      expect(call.apiContext.url).not.toHaveProperty('siteid');
    });

    it.each([
      ['pageIndex', { itemsPerPage: 1, pageIndex: 2 }, [''], 2],
      ['startIndex', { itemsPerPage: 1, startIndex: 2 }, [''], 2],
      ['a page past the last record', { itemsPerPage: 1, pageIndex: 9 }, ['second'], 1],
    ])('pages by the URL scope\'s %s', async (_label, url, summaries, pageIndex) => {
      const data = wire('findVersionHistory', await on('findVersionHistory', { actor: ADMIN, id: ALPHA, url }));
      expect((data['items'] as Struct[]).map((item) => item['summary'])).toEqual(summaries);
      expect(data).toMatchObject({ totalitems: 2, totalpages: 2, pageindex: pageIndex, itemsperpage: 1 });
    });

    it('answers the legacy 500 for a numeric offset, which setIteratorProps applies to an undefined feed', async () => {
      await expect(on('findVersionHistory', { actor: ADMIN, id: ALPHA, url: { offset: 1 } })).rejects.toEqual(legacyError('server_error'));
    });
  });

  describe('findRelatedContent', () => {
    it.each(['*', 'all', ''])('answers one packaged set per related-content set of the subtype for the set id "%s"', async (setId) => {
      const data = wire('findRelatedContent', await on('findRelatedContent', { id: ALPHA, path: ['content', ALPHA, 'relatedcontent'], relatedContentSetId: setId }));
      expect(data['links']).toBeUndefined();
      expect(data).toMatchObject({ entityname: 'relatedcontentset' });
      const sets = data['items'] as Struct[];
      expect(sets.map((set) => [set['name'], set['relatedcontentsetid']])).toEqual([
        ['Gallery', GALLERY_SET],
        ['Default', DEFAULT_SET],
      ]);
      expect(sets.map((set) => (set['items'] as Struct[]).map((item) => item['title']))).toEqual([['Gamma'], ['Beta', 'Gamma']]);
    });

    it('fills a related item\'s file columns from the site\'s file pool', async () => {
      const [gallery] = itemsOf('findRelatedContent', await on('findRelatedContent', { id: ALPHA, url: { fields: 'title,fileid,fileext,filesize' } }));
      expect(gallery?.['items']).toEqual([expect.objectContaining({ title: 'Gamma', fileid: IMAGE, fileext: 'jpg', filesize: 10 })]);
    });

    it('applies the URL sort and reverse arguments', async () => {
      const [, sorted] = itemsOf('findRelatedContent', await on('findRelatedContent', { id: ALPHA, url: { sortby: 'menutitle', sortdirection: 'desc' } }));
      expect((sorted?.['items'] as Struct[]).map((item) => item['title'])).toEqual(['Gamma', 'Beta']);
      const reverse = itemsOf('findRelatedContent', await on('findRelatedContent', { id: GAMMA, url: { reverse: 'true' } }));
      expect(reverse.map((set) => (set['items'] as Struct[]).map((item) => item['title']))).toEqual([['Alpha'], ['Alpha']]);
    });

    it('merges the items of a site whose content pool spans tenants', async () => {
      await fx.handle.app.withMetadata((tx) =>
        tx.query(`UPDATE ${fx.handle.schema}.tenant_registry SET content_pool_ids = $1, content_pool_tenants = $2 WHERE tenant_id = $3`, [
          [SITE_ID, TENANT_UMBRELLA.siteId],
          [TENANT_A.tenantId, TENANT_UMBRELLA.tenantId],
          TENANT_A.tenantId,
        ]),
      );
      try {
        const sets = itemsOf('findRelatedContent', await on('findRelatedContent', { id: ALPHA }));
        expect(sets.map((set) => (set['items'] as Struct[]).map((item) => item['title']))).toEqual([['Gamma'], ['Beta', 'Gamma']]);
      } finally {
        await seedRegistry(fx.handle.app);
      }
    });

    it('fails closed for a set of another entity type, which reads that entity\'s table', async () => {
      await expect(on('findRelatedContent', { id: SPECIAL })).rejects.toEqual(unavailable('related-content-entity-type'));
      await expect(on('findRelatedContent', { id: SPECIAL, relatedContentSetId: USERS_SET, url: { relatedContentSetID: 'Members' } })).rejects.toEqual(
        unavailable('related-content-entity-type'),
      );
    });

    it('fails closed for a related item with a repeating display interval', async () => {
      await expect(on('findRelatedContent', { id: EPSILON })).rejects.toEqual(unavailable('related-content-intervals'));
    });

    it('defaults the set id to * without a path segment or param', async () => {
      const data = wire('findRelatedContent', await on('findRelatedContent', { id: ALPHA }));
      expect((data['items'] as Struct[]).map((set) => set['name'])).toEqual(['Gallery', 'Default']);
    });

    it('names a specific set by the requested id and filters only by the URL relatedContentSetID', async () => {
      const unfiltered = wire('findRelatedContent', await on('findRelatedContent', { id: ALPHA, relatedContentSetId: GALLERY_SET }));
      expect(unfiltered).toMatchObject({ name: GALLERY_SET });
      // One row per link: Gamma is linked in two sets.
      expect((unfiltered['items'] as Struct[]).map((item) => item['title']).sort()).toEqual(['Beta', 'Gamma', 'Gamma']);
      const filteredCall = { id: ALPHA, relatedContentSetId: GALLERY_SET, url: { relatedContentSetID: GALLERY_SET } };
      const filtered = wire('findRelatedContent', await on('findRelatedContent', filteredCall));
      expect((filtered['items'] as Struct[]).map((item) => item['title'])).toEqual(['Gamma']);
      const named = wire('findRelatedContent', await on('findRelatedContent', { id: ALPHA, relatedContentSetId: 'Gallery', url: { name: 'Gallery' } }));
      expect(named).toMatchObject({ name: 'Gallery' });
      expect((named['items'] as Struct[]).map((item) => item['title'])).toEqual(['Gamma']);
    });

    it('answers empty sets for an unknown content id', async () => {
      const data = wire('findRelatedContent', await on('findRelatedContent', { id: cfId('X', 9) }));
      expect((data['items'] as Struct[]).map((set) => (set['items'] as Struct[]).length)).toEqual([0, 0]);
    });
  });

  describe('findCalendarItems', () => {
    it.each([
      ['calendarid', {}],
      ['calendarid', { calendarid: '' }],
    ])('asks for the missing %s', async (name, url) => {
      const result = await on('findCalendarItems', { url });
      expect(result.serializerEntity).toBeUndefined();
      expect(body('findCalendarItems', result)['data']).toBe(`Please provide a <strong>${name}</strong>.`);
    });

    it('lists the live children of the calendar in the current month, by displaystart, with url and allday', async () => {
      const result = await on('findCalendarItems', { url: { calendarid: CALENDAR } });
      expect(result.serializerEntity).toBe('content');
      const rows = wire('findCalendarItems', result) as unknown as Struct[];
      expect(rows.map((row) => [row['contentid'], row['url'], row['allday']])).toEqual([
        // Unhinted simple values serialize as strings.
        [LAUNCH, 'http://localhost/events/launch/', '1'],
        [TALK, 'http://localhost/events/talk/', '0'],
      ]);
      expect(Object.keys(rows[0] ?? {})).toEqual([...Object.keys(rows[0] ?? {})].sort());
    });

    // An item without a displaystop stays in every later window.
    it.each([
      ['start and end', { start: '2026-08-01', end: '2026-08-31' }, ['Talk', 'Later']],
      ['an end before the start, widened to the end of its month', { start: '2026-06-15', end: '2026-06-01' }, ['Talk']],
      ['an end that is not a date', { start: '2026-07-01', end: 'soon' }, ['Talk']],
      ['the event year and month', { year: 2026, month: 8 }, ['Talk', 'Later']],
    ])('takes the window from %s', async (_label, url, titles) => {
      expect(await calendarTitles({ url: { calendarid: CALENDAR, ...url } })).toEqual(titles);
    });

    it('returns fullcalendar events as unenveloped JSON', async () => {
      const result = await on('findCalendarItems', { url: { calendarid: CALENDAR, format: 'fullcalendar' } });
      expect(result.data).toBeUndefined();
      // Legacy sends JSON-text results as is (jsonApiUtility.cfc:891-897).
      assertResponseMatchesOpenApi(OPENAPI, { method: 'GET', path: `/_api/json/v1/${SITE_ID}`, status: 200, contentType: 'application/json; charset=utf-8', body: result.rawJson });
      const events = JSON.parse(result.rawJson ?? '') as Struct[];
      expect(events.map((event) => Object.keys(event))).toEqual([
        ['allday', 'end', 'id', 'start', 'title', 'url'],
        ['allday', 'end', 'id', 'start', 'title', 'url'],
      ]);
      expect(events.map((event) => [event['id'], event['title'], event['url'], event['allday']])).toEqual([
        [LAUNCH, 'Launch', 'http://localhost/events/launch/', true],
        [TALK, 'Talk', 'http://localhost/events/talk/', false],
      ]);
    });

    it('answers the empty five-column query for ids that name no calendar, and the legacy 500 in fullcalendar format', async () => {
      expect(wire('findCalendarItems', await on('findCalendarItems', { url: { calendarid: `${ALPHA},${cfId('X', 3)}` } }))).toEqual([]);
      await expect(on('findCalendarItems', { url: { calendarid: ALPHA, format: 'fullcalendar' } })).rejects.toEqual(legacyError('server_error'));
    });

    it('asks for a siteid the call does not carry', async () => {
      expect(body('findCalendarItems', await on('findCalendarItems', { siteId: '', url: { calendarid: CALENDAR } }))['data']).toBe(
        'Please provide a <strong>siteid</strong>.',
      );
    });

    it.each([
      ['a category id', { categoryid: cfId('C', 9) }],
      ['an encoded tag', { tag: 'launch%20day' }],
    ])('filters by %s', async (_label, url) => {
      expect(wire('findCalendarItems', await on('findCalendarItems', { url: { calendarid: CALENDAR, ...url } }))).toEqual([]);
    });

    it('ignores a category id that is not a CF UUID', async () => {
      expect(await calendarTitles({ url: { calendarid: CALENDAR, categoryid: 'news' } })).toEqual(['Launch', 'Talk']);
    });

    it.each([
      ['lists a restricted calendar without the extranet setting', ANONYMOUS, {}, ['Meeting']],
      ['filters a restricted calendar by permission under the extranet setting', ANONYMOUS, { extranet: 1 }, []],
      ['lists a restricted calendar to a user it allows', ADMIN, { extranet: 1 }, ['Meeting']],
    ])('%s', async (_label, actor, site, titles) => {
      expect(await calendarTitles({ actor, site, url: { calendarid: PRIVATE } })).toEqual(titles);
    });

    it('takes the permission filter from the last listed id', async () => {
      expect(await calendarTitles({ site: { extranet: 1 }, url: { calendarid: `${PRIVATE},${cfId('X', 4)}` } })).toEqual(['Meeting']);
    });

    it('fails closed for scheduled calendar items, which contentIntervalManager expands', async () => {
      await expect(on('findCalendarItems', { url: { calendarid: SCHEDULED } })).rejects.toEqual(unavailable('feed-content-unsupported'));
    });

    it('fails closed for returnFormat=iterator', async () => {
      await expect(on('findCalendarItems', { url: { calendarid: CALENDAR, returnFormat: 'iterator' } })).rejects.toEqual(unavailable('calendar-iterator'));
      await expect(on('findCalendarItems', { url: { calendarid: CALENDAR, returnFormat: 'iterator', format: 'fullcalendar' } })).rejects.toEqual(
        legacyError('server_error'),
      );
    });
  });

  describe('getURLForImage', () => {
    it.each([
      ['the small rendition by default, complete and protocol-relative', { fileid: IMAGE }, `//localhost/sites/${POOL}/cache/file/${IMAGE}_small.jpg`],
      ['a named size', { fileid: IMAGE, size: 'medium' }, `//localhost/sites/${POOL}/cache/file/${IMAGE}_medium.jpg`],
      ['a relative URL', { fileid: IMAGE, complete: 'false' }, `/sites/${POOL}/cache/file/${IMAGE}_small.jpg`],
      ['the render route when not direct', { fileid: IMAGE, direct: 'false' }, `//localhost/index.cfm/_api/render/small/?fileID=${IMAGE}&fileEXT=jpg`],
      ['the given extension without a read', { fileid: cfId('X', 5), fileext: 'png' }, `//localhost/sites/${POOL}/cache/file/${cfId('X', 5)}_small.png`],
      ['nothing for a non-image', { fileid: BROCHURE }, ''],
      ['nothing for an unknown file', { fileid: cfId('X', 6) }, ''],
      ['nothing without a file or placeholder', {}, ''],
      ['the protocol when asked', { fileid: IMAGE, useProtocol: 'true' }, `http://localhost/sites/${POOL}/cache/file/${IMAGE}_small.jpg`],
    ])('answers %s', async (_label, url, expected) => {
      expect(wire('getURLForImage', await on('getURLForImage', { url }))).toEqual({ url: expected });
    });

    it('answers the legacy 500 for a flag CFML cannot read as a boolean', async () => {
      await expect(on('getURLForImage', { url: { fileid: IMAGE, complete: 'maybe' } })).rejects.toEqual(legacyError('server_error'));
    });
  });

  it('submitForm fails as the undefined legacy method and writes nothing', async () => {
    const before = await fx.rows('content', 'true');
    await expect(on('submitForm', { actor: ADMIN, url: { title: 'Posted' } })).rejects.toMatchObject({ name: 'UndefinedLegacyMethodError' });
    expect(await fx.rows('content', 'true')).toEqual(before);
  });
});
