/** Legacy wire contract of the JSON API front controller: site resolution, route keys, envelope, headers, registration and error map. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  WWW_AUTHENTICATE,
  etag,
  routeKeyForRequest,
  type LegacyApiErrorType,
  type RouteKeyOptions,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { contentEntities, isContentEntity } from '../../src/legacy/jsonapi-entities.js';
import {
  jsonApiSiteOf,
  resolveJsonApiCall,
  type JsonApiRequestFacts,
  type JsonApiResolveOptions,
  type JsonApiTarget,
} from '../../src/routes/jsonapi.js';
import { buildTestApp, createRecordingDb, type RecordingDb, type Responder, type TestApp } from '../helpers/app.js';
import { IDS, seedRecordingDb, tenantASeed } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const SITE = TENANT_A.siteId;
const API = `/_api/json/v1/${SITE}`;
const PAGE_ONE = IDS.content.pageOne;
/** The entity path of the seeded, published page one, after the site segment. */
const PAGE_ONE_PATH = `/content/${PAGE_ONE}`;
const FORM = 'application/x-www-form-urlencoded';

const REGISTERED: ReadonlySet<string> = new Set([TENANT_A, TENANT_B, TENANT_UMBRELLA].map((tenant) => tenant.siteId));

/** settingsManager.siteExists over the fixture registry, case-insensitive as the route's registry lookup. */
function siteExists(siteId: string): boolean {
  return REGISTERED.has(siteId.toLowerCase());
}

const RESOLVE: JsonApiResolveOptions = { siteExists, appReloadKey: 'appreload', context: '', variations: false };
const ROUTE_KEY_OPTIONS: RouteKeyOptions = { siteExists, appReloadKey: 'appreload', context: '', variationsEnabled: false };

/** contentDAO's active-version read, by contentid list or filename; seedRecordingDb alone answers it with approval-request rows. */
const ACTIVE_READ = /^SELECT tcontent\.active\b.* FROM "content"\."content" tcontent LEFT JOIN /;
const TENANT_A_CONTENT: readonly Struct[] = tenantASeed()
  .rows.filter(({ table }) => table.table === 'content')
  .map(({ row }) => row);
/** The file and approval columns of the read's outer joins, empty for every seeded page. */
const NO_JOINED_ROW: Readonly<Struct> = Object.freeze({
  filesize: null,
  contenttype: null,
  contentsubtype: null,
  fileext: null,
  assocfilename: null,
  approvalstatus: null,
  requestid: null,
  approvalgroupid: null,
});

const activeContent: Responder = (params, sql, { tenantId }) => {
  if (tenantId?.toLowerCase() !== TENANT_A.tenantId) return [];
  const [key] = params;
  const wanted = (Array.isArray(key) ? key : [key]).map((value) => String(value).toLowerCase());
  const column = /tcontent\.contentid = ANY\(/.test(sql) ? 'contentid' : 'filename';
  return TENANT_A_CONTENT.filter((row) => row.active === 1 && wanted.includes(String(row[column] ?? '').toLowerCase())).map(
    (row) => ({ ...row, ...NO_JOINED_ROW }),
  );
};

/** strategies-content over a recording database holding the content seed; `prepare` adds responders before the build. */
async function contentApi(
  env: Readonly<Record<string, string>> = {},
  prepare?: (db: RecordingDb) => Promise<void>,
): Promise<TestApp> {
  const db = createRecordingDb();
  seedRecordingDb(db);
  db.respond(ACTIVE_READ, activeContent);
  await prepare?.(db);
  return buildTestApp({ db, env });
}

/** One injected request: the gateway's relay headers of `subject` (anonymous by default) plus `headers`. */
interface ApiCall {
  method?: HttpMethod;
  url: string;
  subject?: ContentSubject;
  headers?: Readonly<Record<string, string>>;
  payload?: string;
}

async function send(api: TestApp, request: ApiCall) {
  const headers = { ...(await contentHeaders(request.subject ?? 'anonymous')), ...request.headers };
  return api.app.inject({ method: request.method ?? 'GET', url: request.url, headers, payload: request.payload });
}

function bodyOf(res: { body: string }): Struct {
  return JSON.parse(res.body) as Struct;
}

function dataOf(res: { body: string }): Struct {
  return bodyOf(res).data as Struct;
}

/** The `error` struct the catch block of `type` serializes. */
function errorBody(type: LegacyApiErrorType): { message: string; code: string } {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return { message, code };
}

function formBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

let api: TestApp;
let variationsApi: TestApp;

beforeAll(async () => {
  [api, variationsApi] = await Promise.all([contentApi(), contentApi({ MURA_VARIATIONS: 'true' })]);
});

afterAll(async () => {
  await Promise.all([api?.close(), variationsApi?.close()]);
});

describe('site resolution and route keys', () => {
  const FAMILY = ['_api', 'json', 'v1'];

  it.each<[string, readonly string[], Struct, Struct, string]>([
    ['path segment 4', [...FAMILY, SITE, 'content'], {}, {}, SITE],
    ['path segment 4 over the form and url siteid', [...FAMILY, SITE], { siteid: TENANT_B.siteId }, { siteid: TENANT_UMBRELLA.siteId }, SITE],
    ['the form siteid over the url siteid without a segment 4', FAMILY, { siteid: TENANT_B.siteId }, { siteid: SITE }, TENANT_B.siteId],
    ['the url siteid, its name in any case', FAMILY, {}, { SiteID: TENANT_B.siteId }, TENANT_B.siteId],
    ['default for an unregistered segment 4, whatever the form names', [...FAMILY, 'nosuch'], { siteid: TENANT_B.siteId }, {}, 'default'],
    ['default without any site', FAMILY, {}, {}, 'default'],
  ])('jsonApiSiteOf takes %s', (_label, segments, form, url, expected) => {
    expect(jsonApiSiteOf(segments, form, url, siteExists)).toBe(expected);
  });

  it.each([
    ['a path site', `/_api/json/v1/${TENANT_B.siteId}/content`],
    ['a registered siteid parameter', `${API}/content?siteid=${TENANT_B.siteId}`],
  ])('refuses %s other than the token site with the legacy 403 before any domain read', async (_label, url) => {
    api.db.clear();
    api.client.clear();
    const res = await send(api, { url, subject: 'site-admin' });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res)).toEqual({ apiversion: 'v1', method: 'invalid', error: errorBody('authorization') });
    expect(api.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
    expect(api.client.requests).toEqual([]);
  });

  interface KeyCase {
    name: string;
    method: HttpMethod;
    url: string;
    /** Posted form fields, or the JSON body when `json`. */
    body?: Readonly<Record<string, string>>;
    json?: boolean;
    headers?: Readonly<Record<string, string>>;
    key: string;
    target: JsonApiTarget['kind'];
  }

  const KEY_CASES: readonly KeyCase[] = [
    { name: 'a generic save of content', method: 'POST', url: `${API}/?method=save&entityname=content`, body: { title: 'Saved' }, key: 'api:content.save', target: 'entity' },
    { name: 'the same save of user, which keeps its entity', method: 'POST', url: `${API}/?method=save&entityname=user`, body: { fname: 'Ada' }, key: 'api:user.save', target: 'foreign' },
    { name: 'a dotted content.findOne', method: 'GET', url: `${API}/?method=content.findOne`, key: 'api:content.findone', target: 'entity' },
    {
      name: 'a JSON body method over the query method',
      method: 'POST',
      url: `${API}/?method=getSerializer`,
      body: { method: 'findCrumbArray', entityname: 'content', id: PAGE_ONE },
      json: true,
      key: 'api:findcrumbarray',
      target: 'method',
    },
    {
      name: 'a JSON body non-public method over a public query method',
      method: 'POST',
      url: `${API}/?method=findCrumbArray&entityname=content&id=${PAGE_ONE}`,
      body: { method: 'getSerializer' },
      json: true,
      key: 'api:!invalidmethodcall',
      target: 'error',
    },
    { name: 'GET of a content id path', method: 'GET', url: `${API}${PAGE_ONE_PATH}`, key: 'api:content.findone', target: 'entity' },
    { name: 'PUT of a content id path', method: 'PUT', url: `${API}${PAGE_ONE_PATH}`, key: 'api:content.save', target: 'entity' },
    { name: 'DELETE of a content id path', method: 'DELETE', url: `${API}${PAGE_ONE_PATH}`, key: 'api:content.delete', target: 'entity' },
    {
      name: 'a POST that X-HTTP-Method-Override turns into DELETE',
      method: 'POST',
      url: `${API}${PAGE_ONE_PATH}`,
      headers: { 'X-HTTP-Method-Override': 'DELETE' },
      key: 'api:content.delete',
      target: 'entity',
    },
    { name: 'the crumbs path', method: 'GET', url: `${API}${PAGE_ONE_PATH}/crumbs`, key: 'api:content.findcrumbarray', target: 'method' },
    { name: 'the REST family', method: 'GET', url: `/_api/rest/v1/${SITE}${PAGE_ONE_PATH}`, key: 'rest:content.findone', target: 'entity' },
  ];

  function queryOf(url: string): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
  }

  function headersOf(c: KeyCase): Record<string, string> {
    const contentType: Record<string, string> = c.body === undefined ? {} : { 'content-type': c.json === true ? 'application/json' : FORM };
    return { ...contentType, ...c.headers };
  }

  function factsOf(c: KeyCase): JsonApiRequestFacts {
    return { method: c.method, url: c.url, query: queryOf(c.url), body: c.body, headers: headersOf(c) };
  }

  function routeKeyRequestOf(c: KeyCase): RouteKeyRequest {
    const json = c.json === true;
    return {
      method: c.method,
      path: c.url.split('?')[0] ?? '',
      query: queryOf(c.url),
      form: json ? {} : { ...c.body },
      ...(json ? { jsonBody: c.body } : {}),
      headers: headersOf(c),
    };
  }

  it.each(KEY_CASES)('resolves $name to the shared route key $key', (c) => {
    const resolved = resolveJsonApiCall(factsOf(c), RESOLVE);
    expect(resolved.key.key).toBe(routeKeyForRequest(routeKeyRequestOf(c), ROUTE_KEY_OPTIONS).key);
    expect(resolved.key.key).toBe(c.key);
    expect(resolved.target.kind).toBe(c.target);
    expect(resolved.apiSiteId).toBe(SITE);
  });

  it.each([
    ['json', false],
    ['ajax', false],
    ['rest', true],
  ] as const)('resolves the %s family, only REST running sessionless', (mode, restMode) => {
    const url = `/_api/${mode}/v1/${SITE}${PAGE_ONE_PATH}`;
    const resolved = resolveJsonApiCall({ method: 'GET', url, query: {}, body: undefined, headers: {} }, RESOLVE);
    expect(resolved.mode).toBe(mode);
    expect(resolved.family).toBe(`/_api/${mode}/v1`);
    expect(resolved.methodCtx.restMode).toBe(restMode);
  });
});

describe('envelope and headers', () => {
  const FIND_ONE_URL = `${API}${PAGE_ONE_PATH}`;

  it('answers an anonymous findOne of a published page in the ACF-ordered {apiversion, data, method} envelope, data keys lower-case', async () => {
    const res = await send(api, { url: FIND_ONE_URL });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(Object.keys(body)).toEqual(['apiversion', 'data', 'method']);
    expect(body).toMatchObject({ apiversion: 'v1', method: 'findOne' });
    const data = body.data as Struct;
    expect(data).toMatchObject({ contentid: PAGE_ONE, title: 'Page One', siteid: SITE, entityname: 'content' });
    expect(Object.keys(data).filter((key) => key !== key.toLowerCase())).toEqual([]);
  });

  it('drops params under configBean suppressAPIParams, which defaults to true and no request parameter switches off', async () => {
    const res = await send(api, { url: `${FIND_ONE_URL}?suppressAPIParams=false` });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).not.toHaveProperty('params');
  });

  it.each([
    ['false', true],
    ['0', true],
    ['true', false],
    ['not-a-boolean', false],
  ])('flattens data into the response for useDataNamespace=%s: %s', async (value, flattened) => {
    const body = bodyOf(await send(api, { url: `${FIND_ONE_URL}?useDataNamespace=${value}` }));
    expect(body).toMatchObject({ apiversion: 'v1', method: 'findOne' });
    if (flattened) {
      expect(body).not.toHaveProperty('data');
      expect(body.contentid).toBe(PAGE_ONE);
    } else {
      expect((body.data as Struct).contentid).toBe(PAGE_ONE);
    }
  });

  it.each([
    ['a served findOne', FIND_ONE_URL, 200],
    ['an error answer', '/_api/json/v1', 400],
  ])('sends %s with the legacy content type, the ETag of its exact body and the Generator and HSTS headers', async (_label, url, status) => {
    const res = await send(api, { url });
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.headers.etag).toBe(etag(res.body));
    expect(res.headers.etag).toMatch(/^[0-9A-F]+$/);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.headers['strict-transport-security']).toBe('max-age=1200');
  });

  it.each([
    ['https://tenant-a.opt2.test', true],
    ['https://www.tenant-a.opt2.test', true],
    ['https://tenant-b.opt2.test', true],
    ['https://nottenant-a.opt2.test', false],
    ['https://example.test', false],
  ])('echoes Origin %s only when its host is, or is under, a registered site domain: %s', async (origin, echoed) => {
    const res = await send(api, { url: FIND_ONE_URL, headers: { origin } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(echoed ? origin : undefined);
    expect(res.headers['access-control-allow-credentials']).toBe(echoed ? 'true' : undefined);
  });

  it('echoes an allowed Origin on a site-binding denial too', async () => {
    const origin = 'https://tenant-a.opt2.test';
    const res = await send(api, { url: `/_api/json/v1/${TENANT_B.siteId}/content`, subject: 'site-admin', headers: { origin } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('answers the same findOne data on the json, ajax and REST families for one signed-in user, REST links on its own endpoint', async () => {
    const data: Record<string, Struct> = {};
    for (const family of ['json', 'ajax', 'rest']) {
      const res = await send(api, { url: `/_api/${family}/v1/${SITE}${PAGE_ONE_PATH}`, subject: 's2' });
      expect(res.statusCode).toBe(200);
      data[family] = dataOf(res);
    }
    expect(data.json).toMatchObject({ contentid: PAGE_ONE, title: 'Page One' });
    expect(data.ajax).toEqual(data.json);
    expect(JSON.parse(JSON.stringify(data.rest).replaceAll('/_api/rest/v1/', '/_api/json/v1/'))).toEqual(data.json);
  });
});

describe('entity registration and the legacy error map', () => {
  const VARIATION_PROPERTIES = `${API}/variationTargeting/properties`;

  it('registers variationTargeting only with configBean variations on, its bean known either way', () => {
    const names = (variations: boolean): string[] => contentEntities({ variations }).map((entity) => entity.name);
    expect(names(false)).not.toContain('variationTargeting');
    expect(names(true).at(-1)).toBe('variationTargeting');
    expect(names(true).slice(0, -1)).toEqual(names(false));
    expect(isContentEntity('variationTargeting')).toBe(true);
  });

  it('refuses variationTargeting, unregistered while variations is off, with the authorization error', async () => {
    const res = await send(api, { url: VARIATION_PROPERTIES, subject: 's2' });
    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.authorization.status);
    expect(bodyOf(res)).toMatchObject({ method: 'findProperties', error: errorBody('authorization') });
  });

  it('serves variationTargeting when MURA_VARIATIONS=true', async () => {
    const res = await send(variationsApi, { url: VARIATION_PROPERTIES, subject: 's2' });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ method: 'findProperties', data: { displayname: 'variationTargeting' } });
  });

  interface ErrorCase {
    name: string;
    type: LegacyApiErrorType;
    /** When legacy's request.mura404 overrides the map's status. */
    status?: number;
    wwwAuthenticate?: string;
    request: ApiCall;
  }

  const ERROR_CASES: readonly ErrorCase[] = [
    { name: 'a call without a site segment', type: 'invalidParameters', request: { url: '/_api/json/v1' } },
    { name: 'an unregistered site, which falls back to default', type: 'invalidParameters', request: { url: '/_api/json/v1/nosuch/content' } },
    { name: 'a defined but non-public method', type: 'invalidMethodCall', request: { url: `${API}/?method=getSerializer` } },
    {
      name: 'a body shorter than its Content-Length',
      type: 'badRequest',
      request: { method: 'POST', url: `${API}/content`, headers: { 'content-type': FORM, 'content-length': '50' }, payload: 'a=1' },
    },
    {
      name: 'a REST call with an unverifiable Bearer token',
      type: 'invalidAccessToken',
      wwwAuthenticate: WWW_AUTHENTICATE.bearerInvalidAccessToken,
      request: { url: `/_api/rest/v1/${SITE}${PAGE_ONE_PATH}`, headers: { authorization: 'Bearer not-a-verifiable-token' } },
    },
    {
      name: 'a REST call without credentials',
      type: 'authorization',
      wwwAuthenticate: WWW_AUTHENTICATE.basic,
      request: { url: `/_api/rest/v1/${SITE}${PAGE_ONE_PATH}` },
    },
    { name: 'an unknown _path, under request.mura404', type: 'invalidMethodCall', status: 404, request: { url: `${API}/content/_path/no/such/page` } },
    // Only a path pair that sanitises to `method` makes the entity route invoke it; `?method=submitForm` keys to `entity.findall`.
    {
      name: 'the entity route invoking submitForm, which publicMethods lists but no function declares',
      type: 'server_error',
      request: { url: `${API}/login/m!ethod/submitForm?method=zz` },
    },
  ];

  it.each(ERROR_CASES)('answers $name with the $type row, writing nothing', async ({ type, status, wwwAuthenticate, request }) => {
    api.db.clear();
    const res = await send(api, request);
    expect(res.statusCode).toBe(status ?? LEGACY_ERROR_MAP[type].status);
    const body = bodyOf(res);
    expect(body.apiversion).toBe('v1');
    expect(body.error).toEqual(errorBody(type));
    expect(res.headers['www-authenticate']).toBe(wwwAuthenticate);
    expect(api.db.writes()).toEqual([]);
  });

  it('answers a content save whose validation fails with 403 and its data.errors, writing nothing', async () => {
    api.db.clear();
    const res = await send(api, {
      method: 'POST',
      url: `${API}/content`,
      subject: 's2',
      headers: { 'content-type': FORM },
      payload: formBody({
        parentid: IDS.content.root,
        type: 'Page',
        title: 'Bad',
        template: 'x/y.cfm',
        csrf_token: 'form-csrf-token',
        csrf_token_expires: 'form-csrf-expiry',
      }),
    });
    expect(res.statusCode).toBe(403);
    const body = bodyOf(res);
    expect(body.method).toBe('save');
    expect((body.data as Struct).errors).toEqual({ template: 'invalid template' });
    expect(api.db.writes()).toEqual([]);
  });
});

describe('the ignored JSONApi site flag', () => {
  let flagged: TestApp;

  beforeAll(async () => {
    // The site projection models no JSON API flag, so the legacy tsettings.JSONApi column (dbUpdates/6.2.cfm:6, default 0)
    // is added to the registry rows to show the route serves the site without reading it.
    flagged = await contentApi({}, async (db) => {
      const { rows } = await db.withMetadata((tx) => tx.query(`SELECT * FROM ${db.schema}.tenant_registry ORDER BY site_id`));
      db.respond(/ FROM \S*tenant_registry ORDER BY site_id$/, () => rows.map((row) => ({ ...row, jsonapi: 0 })));
    });
  });

  afterAll(async () => {
    await flagged?.close();
  });

  it('still serves a site whose record carries JSONApi=0, since processRequest hard-codes apiEnabled=true', async () => {
    const res = await send(flagged, { url: `${API}${PAGE_ONE_PATH}` });
    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    expect(body).not.toHaveProperty('error');
    expect((body.data as Struct).contentid).toBe(PAGE_ONE);
  });
});
