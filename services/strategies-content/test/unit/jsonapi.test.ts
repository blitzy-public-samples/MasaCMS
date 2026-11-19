/** Legacy wire contract of the JSON API front controller: site resolution, route keys, envelope, headers, registration and error map. */
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, mintUserToken } from '@opt2/platform/testing';
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
import { SUBJECT_USER_IDS, contentHeaders, type ContentSubject } from '../helpers/tokens.js';

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
    ['a registered siteid parameter beside an unknown path site', `/_api/json/v1/nosuchsite/content?siteid=${TENANT_B.siteId}`],
    ['a path site behind /index.cfm', `/index.cfm/_api/json/v1/${TENANT_B.siteId}/content`],
  ])('refuses %s other than the token site with the legacy 403 before any domain read', async (_label, url) => {
    api.db.clear();
    api.client.clear();
    const res = await send(api, { url, subject: 'site-admin' });
    expect(res.statusCode).toBe(403);
    expect(bodyOf(res)).toEqual({ apiversion: 'v1', method: 'invalid', error: errorBody('authorization') });
    expect(api.db.statements.filter((statement) => statement.tenantId !== null)).toEqual([]);
    expect(api.client.requests).toEqual([]);
  });

  /** Callers of an unknown site: identity's roleless token of that site, an anonymous session's, another site's, or none. */
  const UNKNOWN_SITE_CALLERS: ReadonlyArray<{ who: string; subject: ContentSubject; sub?: string }> = [
    { who: 'a roleless token of that site', subject: 'anonymous', sub: SUBJECT_USER_IDS['system-user'] },
    { who: 'an anonymous session token of that site', subject: 'anonymous', sub: '' },
    { who: 'a tenant-a site-admin token', subject: 'site-admin' },
    { who: 'no user token', subject: 'anonymous' },
  ];

  it.each(
    (
      [
        ['/_api/json/v1/nosuchsite/content', 'invalid'],
        ['/_api/ajax/v1/nosuchsite/content', 'invalid'],
        ['/index.cfm/_api/json/v1/nosuchsite/content', 'invalid'],
        ['/_api/json/v1/?siteid=nosuchsite&method=findOne&entityname=content', 'findOne'],
      ] as const
    ).flatMap(([url, method]) => UNKNOWN_SITE_CALLERS.map((caller) => ({ url, method, ...caller }))),
  )("answers $url × $who with legacy's 400 invalidParameters before any domain read", async ({ url, method, subject, sub }) => {
    api.db.clear();
    api.client.clear();
    const headers: Readonly<Record<string, string>> = sub === undefined ? {} : { authorization: `Bearer ${await mintUserToken({ sub, site: 'nosuchsite', roles: [] })}` };
    const res = await send(api, { url, subject, headers });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect(res.body).toBe(`{"apiversion":"v1","method":"${method}","error":{"message":"Invalid parameters","code":"invalid_request"}}`);
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
    { name: 'a generic save of content', method: 'POST', url: `${API}/?method=save&entityname=content`, body: { title: 'Saved' }, key: 'api:content.save', target: 'refused' },
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
    { name: 'PUT of a content id path', method: 'PUT', url: `${API}${PAGE_ONE_PATH}`, key: 'api:content.save', target: 'refused' },
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

describe('the families behind /index.cfm', () => {
  const ABSENT_TARGETING = 'AAAAAAAA-AAAA-AAAA-AAAAAAAAAAAAAAAA';
  const TARGETING_SAVE = { method: 'POST', headers: { 'content-type': FORM }, payload: formBody({ contentid: PAGE_ONE, initjs: 'x' }) } as const;
  const INVALID_TOKENS = '{"apiversion":"v1","method":"save","error":{"message":"Invalid CSRF tokens","code":"invalid_request"}}';

  /** A request on its bare path, and the Masa 7.6.1 oracle's answer to it where the request alone decides that answer. */
  interface SpellingCase {
    name: string;
    variations?: true;
    request: ApiCall;
    legacy?: { status: number; body: string; wwwAuthenticate?: string };
  }

  const CASES: readonly SpellingCase[] = [
    { name: 'a variationTargeting save without CSRF tokens', variations: true, request: { url: `${API}/variationTargeting`, ...TARGETING_SAVE }, legacy: { status: 400, body: INVALID_TOKENS } },
    { name: 'a lower-case variationtargeting/ save', variations: true, request: { url: `${API}/variationtargeting/`, ...TARGETING_SAVE }, legacy: { status: 400, body: INVALID_TOKENS } },
    { name: 'an ajax variationTargeting save', variations: true, request: { url: `/_api/ajax/v1/${SITE}/variationTargeting`, ...TARGETING_SAVE }, legacy: { status: 400, body: INVALID_TOKENS } },
    { name: 'a variationTargeting save while variations is off', request: { url: `${API}/variationTargeting`, ...TARGETING_SAVE } },
    {
      name: 'a variationTargeting delete of an absent id',
      variations: true,
      request: { method: 'DELETE', url: `${API}/variationTargeting/${ABSENT_TARGETING}` },
      legacy: { status: 200, body: '{"apiversion":"v1","data":"","method":"delete"}' },
    },
    { name: 'an anonymous content findOne', request: { url: `${API}${PAGE_ONE_PATH}` } },
    { name: 'an ajax content findOne', request: { url: `/_api/ajax/v1/${SITE}${PAGE_ONE_PATH}` } },
    { name: 'a findOne under an allowed Origin', request: { url: `${API}${PAGE_ONE_PATH}`, headers: { origin: 'https://tenant-a.opt2.test' } } },
    { name: 'a signed-in REST findOne', request: { url: `/_api/rest/v1/${SITE}${PAGE_ONE_PATH}`, subject: 's2' } },
    {
      name: 'a REST call without credentials',
      request: { url: `/_api/rest/v1/${SITE}${PAGE_ONE_PATH}` },
      legacy: {
        status: 401,
        body: '{"apiversion":"v1","method":"invalid","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}',
        wwwAuthenticate: WWW_AUTHENTICATE.basic,
      },
    },
    {
      name: 'a call without a site segment',
      request: { url: '/_api/json/v1' },
      legacy: { status: 400, body: '{"apiversion":"v1","method":"invalid","error":{"message":"Invalid parameters","code":"invalid_request"}}' },
    },
    { name: 'a path site other than the token site', request: { url: `/_api/json/v1/${TENANT_B.siteId}/content`, subject: 'site-admin' } },
  ];

  // The container maps only a lower-case `/index.cfm`, so under `/INDEX.CFM` legacy keeps REST session-managed (applicationSettings.cfm:179).
  /** Respellings of a bare path: name, rewrite, and whether a REST call answers it as on the bare path. */
  const SPELLINGS: ReadonlyArray<readonly [string, (bare: string) => string, boolean]> = [
    ['/index.cfm', (bare) => `/index.cfm${bare}`, true],
    ['/INDEX.CFM', (bare) => `/INDEX.CFM${bare}`, false],
    ['/index.cfm and an upper-case lead', (bare) => `/index.cfm${bare.replace(/^\/_api\/(\w+)\/v1/, (_lead, family: string) => `/_API/${family.toUpperCase()}/V1`)}`, true],
  ];

  /** What the two spellings must share: status, body and the legacy headers. */
  function answerOf(res: Awaited<ReturnType<typeof send>>): Struct {
    const { etag: tag, 'content-type': type, 'www-authenticate': challenge, 'access-control-allow-origin': origin } = res.headers;
    return { status: res.statusCode, body: res.body, type, tag, challenge, origin };
  }

  it.each(
    CASES.flatMap((c) =>
      SPELLINGS.filter(([, , rest]) => rest || !c.request.url.startsWith('/_api/rest/')).map(([spelling, respell]) => ({ ...c, spelling, respell })),
    ),
  )('answers $name behind $spelling as on the bare path', async ({ variations, request, legacy, respell }) => {
    const target = variations === true ? variationsApi : api;
    const bare = answerOf(await send(target, request));
    expect(answerOf(await send(target, { ...request, url: respell(request.url) }))).toEqual(bare);
    if (legacy !== undefined) {
      expect(bare).toMatchObject({ status: legacy.status, body: legacy.body, type: LEGACY_JSON_CONTENT_TYPE, challenge: legacy.wwwAuthenticate });
    }
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

  it('refuses a variationTargeting read, unregistered while variations is off, with the authorization error', async () => {
    const res = await send(api, { url: `${API}/variationTargeting`, subject: 's2' });
    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.authorization.status);
    expect(bodyOf(res)).toMatchObject({ method: 'findAll', error: errorBody('authorization') });
  });

  it.each<[string, () => TestApp]>([
    ['off', () => api],
    ['on (MURA_VARIATIONS=true)', () => variationsApi],
  ])('serves variationTargeting findProperties with variations %s', async (_label, app) => {
    const res = await send(app(), { url: VARIATION_PROPERTIES, subject: 's2' });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ method: 'findProperties', data: { displayname: 'variationTargeting' } });
  });

  interface ErrorCase {
    name: string;
    type: LegacyApiErrorType;
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
    // Only a path pair that sanitises to `method` makes the entity route invoke it; `?method=submitForm` keys to `entity.findall`.
    {
      name: 'the entity route invoking submitForm, which publicMethods lists but no function declares',
      type: 'server_error',
      request: { url: `${API}/login/m!ethod/submitForm?method=zz` },
    },
  ];

  it.each(ERROR_CASES)('answers $name with the $type row, writing nothing', async ({ type, wwwAuthenticate, request }) => {
    api.db.clear();
    const res = await send(api, request);
    expect(res.statusCode).toBe(LEGACY_ERROR_MAP[type].status);
    const body = bodyOf(res);
    expect(body.apiversion).toBe('v1');
    expect(body.error).toEqual(errorBody(type));
    expect(res.headers['www-authenticate']).toBe(wwwAuthenticate);
    expect(api.db.writes()).toEqual([]);
  });

  // ACF's `file` scope makes `file` a defined, non-public method. A path names it only after a site id that is a
  // variable name (`umbrella`, `default`), or as the first segment.
  const POOL_API = `/_api/json/v1/${TENANT_UMBRELLA.siteId}`;
  it.each(
    (
      [
        ['GET', `${POOL_API}/file`, TENANT_UMBRELLA.siteId, 'file'],
        ['GET', `${POOL_API}/file/properties`, TENANT_UMBRELLA.siteId, 'file'],
        ['GET', `${POOL_API}/file/abc`, TENANT_UMBRELLA.siteId, 'file'],
        ['GET', `${POOL_API}/File/properties`, TENANT_UMBRELLA.siteId, 'File'],
        ['POST', `${POOL_API}/file`, TENANT_UMBRELLA.siteId, 'file'],
        ['GET', `${API}/?method=file`, SITE, 'file'],
        ['GET', '/_api/json/v1/file', 'default', 'file'],
      ] as const
    ).flatMap(([method, url, site, reported]) => (['anonymous', 's2'] as const).map((subject) => [method, url, subject, site, reported] as const)),
  )('answers %s %s as %s with the legacy invalid method call body, writing nothing', async (method, url, subject, site, reported) => {
    api.db.clear();
    const res = await send(api, { method, url, headers: await contentHeaders(subject, { site }) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe(JSON.stringify({ apiversion: 'v1', method: reported, error: errorBody('invalidMethodCall') }));
    expect(api.db.writes()).toEqual([]);
  });

  it('serves the file entity at file/properties after a site id that is no variable name, skipping the direct method', async () => {
    const res = await send(api, { url: `${API}/file/properties` });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ method: 'findProperties', data: { displayname: 'file' } });
  });

  it('answers an unknown _path, whose 404 page data only the CFML theme renderer prints, with the legacy-shaped 503, writing nothing', async () => {
    api.db.clear();
    const res = await send(api, { url: `${API}/content/_path/no/such/page` });
    expect(res.statusCode).toBe(503);
    const body = bodyOf(res);
    expect(body.apiversion).toBe('v1');
    expect(body.error).toEqual(errorBody('server_error'));
    expect(api.db.writes()).toEqual([]);
  });

  // The content and contentnav saves write the decision-list table tcontenteventreminders, so they stay on legacy.
  it.each([
    ['POST', `${API}/content`],
    ['POST', `${API}/contentnav`],
    ['PUT', `${API}${PAGE_ONE_PATH}`],
    ['POST', `/_api/rest/v1/${SITE}/content`],
    ['POST', `/_api/rest/v1/${SITE}/contentnav`],
  ] as const)('answers the withheld save %s %s with the legacy 503 before any CSRF consume or write', async (method, url) => {
    api.db.clear();
    api.client.clear();
    const payload = formBody({ parentid: IDS.content.root, type: 'Page', title: 'Withheld', csrf_token: 'form-csrf-token', csrf_token_expires: 'form-csrf-expiry' });
    const res = await send(api, { method, url, subject: 's2', headers: { 'content-type': FORM }, payload });
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res).error).toEqual(errorBody('server_error'));
    expect(api.client.csrfConsumes).toEqual([]);
    expect(api.db.writes()).toEqual([]);
  });
});

describe('the catch (Any e) exception log', () => {
  /** The `log.error` arguments of the request loggers created while `fn` runs. */
  async function errorLogsOf(fn: () => Promise<unknown>): Promise<unknown[][]> {
    const log = api.app.log;
    const child = log.child.bind(log);
    const calls: unknown[][] = [];
    const factory = vi.spyOn(log, 'child').mockImplementation((...args: Parameters<typeof log.child>) => {
      const logger = child(...args);
      vi.spyOn(logger, 'error').mockImplementation((...logged: unknown[]) => void calls.push(logged));
      return logger;
    });
    try {
      await fn();
    } finally {
      factory.mockRestore();
    }
    return calls;
  }

  it.each([
    ['a handler raising server_error', { url: `${API}/?method=findCrumbArray&entityname=content` }, 500, true],
    ['an entity delete without an id', { method: 'DELETE', url: `${API}/content` }, 500, true],
    ['a route key resolving to server_error', { url: `${API}/login/m!ethod/submitForm?method=zz` }, 500, true],
    ['a denial', { url: '/_api/json/v1' }, 400, false],
  ] satisfies Array<[string, ApiCall, number, boolean]>)('logs %s at error severity only for a server_error', async (_label, request, status, logged) => {
    let statusCode = 0;
    const calls = await errorLogsOf(async () => {
      statusCode = (await send(api, request)).statusCode;
    });
    expect(statusCode).toBe(status);
    expect(calls).toEqual(logged ? [[{ error: expect.objectContaining({ type: expect.any(String), message: expect.any(String), stack: expect.any(String) }) }, 'unhandled JSON API error']] : []);
  });
});

describe('the default site URLs of blank rows', () => {
  const BLANK_PAGE = `${API}/content?pageIndex=0&itemsPerPage=1&fields=url,assocurl`;
  let withDefault: TestApp;

  beforeAll(async () => {
    // A `default` site beside the fixture tenants, whose settings settingsManager.getSite('') answers.
    withDefault = await contentApi({}, async (db) => {
      const { rows } = await db.withMetadata((tx) => tx.query<Struct>(`SELECT * FROM ${db.schema}.tenant_registry WHERE NOT deleted ORDER BY site_id`));
      const tenantB = rows.find((row) => row['site_id'] === TENANT_B.siteId);
      const defaultRow = { ...tenantB, site_id: 'default', tenant_id: '6f0c3d2e-5b1a-5c4d-9e8f-7a6b5c4d3e2f', domains: ['default.opt2.test'] };
      db.respond(/ FROM \S*tenant_registry WHERE NOT deleted ORDER BY site_id$/, () => [defaultRow, ...rows]);
    });
  });

  afterAll(async () => {
    await withDefault?.close();
  });

  it('builds them from the registered default site in the request\'s registry snapshot', async () => {
    const res = await send(withDefault, { url: BLANK_PAGE });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res).items).toEqual([expect.objectContaining({ url: 'http://default.opt2.test/', assocurl: 'http://default.opt2.test/', siteid: '' })]);
  });

  it('fails closed when no default site is registered', async () => {
    expect((await send(api, { url: BLANK_PAGE })).statusCode).toBe(503);
  });
});

describe('JSON API unhandled-exception log', () => {
  const PROBE = 'connection to 10.0.0.7 refused for jane.doe@example.test with password=Hunter2-probe';
  const MESSAGE = 'unhandled JSON API error';
  let failure: Error = new Error(PROBE);
  let failing: TestApp;

  beforeAll(async () => {
    failing = await contentApi({}, async (db) => {
      db.respond(ACTIVE_READ, () => {
        throw failure;
      });
    });
  });

  afterAll(async () => {
    await failing?.close();
  });

  /** Makes every later request logger of the app a child of a logger built as createService builds the app's own; returns its lines and `error` calls. */
  function captureRequestLogs(): { lines: string[]; errorCalls: () => unknown[][] } {
    const lines: string[] = [];
    const errorSpies: Array<{ mock: { calls: unknown[][] } }> = [];
    const { name, version, env } = failing.app.opt2;
    const root = createLogger({
      service: name,
      version,
      env: env.OPT2_ENV,
      level: env.LOG_LEVEL,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
      destination: { write: (line: string) => void lines.push(line) },
    }) as unknown as TestApp['app']['log'];
    // Fastify derives each request logger from app.log, which a ready app no longer lets a caller replace.
    vi.spyOn(failing.app.log, 'child').mockImplementation((bindings, options) => {
      const logger = root.child(bindings, options);
      errorSpies.push(vi.spyOn(logger, 'error'));
      return logger;
    });
    return { lines, errorCalls: () => errorSpies.flatMap((spy) => spy.mock.calls) };
  }

  it.each<[string, Error, string]>([
    ['an error whose message carries credentials', new Error(PROBE), REDACTED],
    ['a PostgreSQL error, kept as its SQLSTATE', Object.assign(new Error(PROBE), { code: '42P01', severity: 'ERROR' }), 'PostgreSQL error 42P01'],
  ])('answers server_error for %s, logging only its serialized record', async (_label, thrown, safeMessage) => {
    failure = thrown;
    const logs = captureRequestLogs();
    failing.db.clear();

    const res = await send(failing, { url: `${API}${PAGE_ONE_PATH}`, headers: { 'x-request-id': 'jsonapi-log-probe' } });

    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.server_error.status);
    expect(bodyOf(res)).toStrictEqual({ apiversion: 'v1', method: 'findOne', error: errorBody('server_error') });
    expect(failing.db.writes()).toEqual([]);
    const record = { type: 'Error', message: safeMessage, stack: expect.stringMatching(/^Error: .+(?:\n {4}at \S.*)+$/) };
    expect(logs.errorCalls().filter(([, text]) => text === MESSAGE)).toStrictEqual([[{ error: record }, MESSAGE]]);
    const lines = logs.lines.map((text) => JSON.parse(text) as Struct).filter((line) => line.message === MESSAGE);
    expect(lines).toStrictEqual([expect.objectContaining({ severity: 'ERROR', requestId: 'jsonapi-log-probe', error: record })]);
    expect((lines[0]?.error as { stack: string }).stack.split('\n')[0]).toBe(`Error: ${safeMessage}`);
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    for (const text of [PROBE, '10.0.0.7', 'jane.doe@example.test', 'password=', 'Hunter2-probe']) {
      expect(inspect(logs.errorCalls(), { depth: null })).not.toContain(text);
      expect(logs.lines.join('\n')).not.toContain(text);
    }
  });
});

describe.each(['variationTargeting', 'variationTargetings'])('variationTargeting registration by findProperties while variations is off, on /%s', (segment) => {
  const ENTITY = `${API}/${segment}`;
  const ABSENT_ID = '11111111-2222-3333-4444555566667777';
  const PERMISSIONS = `${ENTITY}/${ABSENT_ID}/permissions`;
  const READS = [`${ENTITY}/new`, ENTITY, `${ENTITY}/${ABSENT_ID}`, `/_api/rest/v1/${SITE}/${segment}/new`];
  const OTHER_SITE_NEW = `/_api/json/v1/${TENANT_B.siteId}/${segment}/new`;
  /** findAll's count of the site's targeting rows, which the seed holds none of. */
  const TARGETING_COUNT = /^SELECT \(SELECT count\(\*\)::integer FROM "content"\."variation_targeting"/;

  it.each<[string, ApiCall, number]>([
    ['the properties path', { url: `${ENTITY}/properties` }, 200],
    ['an unknown property, which answers server_error', { url: `${ENTITY}/properties?properties=contentid` }, 500],
    // A public method gets `entityname` as sent; only path resolution folds a plural (jsonApiUtility.cfc:869-899, 971-985).
    ['the direct method', { url: `${API}/?method=findProperties&entityname=variationTargeting` }, 200],
    ['the REST family', { url: `/_api/rest/v1/${SITE}/${segment}/properties`, subject: 's2' }, 200],
  ])('serves the site reads of every family after %s, for the life of a new app', async (_label, trigger, status) => {
    const fresh = await contentApi({}, (db) => {
      db.respond(TARGETING_COUNT, [{ n: 0 }]);
      return Promise.resolve();
    });
    try {
      expect(dataOf(await send(fresh, { url: PERMISSIONS, subject: 's2' }))).toEqual({ read: false, delete: true, save: true });
      for (const url of READS) expect((await send(fresh, { url, subject: 's2' })).statusCode).toBe(401);

      expect((await send(fresh, trigger)).statusCode).toBe(status);

      expect(dataOf(await send(fresh, { url: PERMISSIONS, subject: 's2' }))).toEqual({ read: true, delete: true, save: true });
      expect(dataOf(await send(fresh, { url: PERMISSIONS }))).toEqual({ read: false, delete: false, save: false });
      for (const url of READS) {
        expect((await send(fresh, { url, subject: 's2' })).statusCode).toBe(200);
        expect((await send(fresh, { url })).statusCode).toBe(401);
      }
      // Each site's API instance holds its own registration.
      expect((await send(fresh, { url: OTHER_SITE_NEW, subject: 'other-tenant' })).statusCode).toBe(401);
      expect((await send(fresh, { url: `/_api/json/v1/${TENANT_B.siteId}/${segment}/properties` })).statusCode).toBe(200);
      expect((await send(fresh, { url: OTHER_SITE_NEW, subject: 'other-tenant' })).statusCode).toBe(200);
    } finally {
      await fresh.close();
    }
  });
});

describe.each(['variationtargeting', 'variationtargetings'])('variationTargeting writes while variations is off, on /%s', (segment) => {
  const ENTITY = `${API}/${segment}/`;
  const ABSENT_ID = '11111111-2222-3333-4444555566667777';
  const TARGETING_WRITE = /"content"\."variation_targeting"/;

  it.each<[string, ApiCall]>([
    ['form POST', { method: 'POST', url: ENTITY, headers: { 'content-type': FORM }, payload: formBody({ contentid: 'X', initjs: 'a' }) }],
    ['POST of a malformed JSON body', { method: 'POST', url: ENTITY, headers: { 'content-type': 'application/json' }, payload: '{bad' }],
    ['POST with an empty method param', { method: 'POST', url: `${ENTITY}?method=`, headers: { 'content-type': FORM }, payload: formBody({ initjs: 'a' }) }],
    ['POST of a 12 MB body', { method: 'POST', url: ENTITY, headers: { 'content-type': FORM }, payload: formBody({ initjs: 'x'.repeat(12 * 1024 * 1024) }) }],
  ])('answers an anonymous %s with Invalid CSRF tokens, writing nothing', async (_label, request) => {
    api.db.clear();
    const res = await send(api, request);
    expect(res.statusCode).toBe(LEGACY_ERROR_MAP.invalidTokens.status);
    expect(bodyOf(res)).toEqual({ apiversion: 'v1', method: 'save', error: errorBody('invalidTokens') });
    expect(api.db.writes()).toEqual([]);
  });

  it('answers an anonymous X-HTTP-Method-Override delete of an absent row with empty data', async () => {
    api.db.clear();
    const res = await send(api, { method: 'POST', url: `${ENTITY}${ABSENT_ID}`, headers: { 'X-HTTP-Method-Override': 'delete' } });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toEqual({ apiversion: 'v1', data: '', method: 'delete' });
    expect(api.db.writes()).toEqual([]);
  });

  it('saves for an s2 admin with valid CSRF tokens', async () => {
    api.db.clear();
    const res = await send(api, {
      method: 'POST',
      url: ENTITY,
      subject: 's2',
      headers: { 'content-type': FORM },
      payload: formBody({ contentid: PAGE_ONE, targetingjs: '[1]', csrf_token: 'form-csrf-token', csrf_token_expires: 'form-csrf-expiry' }),
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ method: 'save', data: { contentid: PAGE_ONE, targetingjs: '[1]', isnew: 0, errors: {} } });
    expect(api.db.writes().filter((statement) => TARGETING_WRITE.test(statement.sql)).map((statement) => statement.sql.split(' ')[0])).toEqual(['INSERT']);
  });

  it.each<[string, string, Readonly<Record<string, string>>, Struct]>([
    ['form values holding a NUL', '', { initjs: 'a\u0000b', targetingjs: 'c\u0000' }, { initjs: 'ab', targetingjs: 'c' }],
    ['a url value holding a NUL', '?initjs=a%00b', { targetingjs: 'c\u0000' }, { initjs: 'ab', targetingjs: 'c' }],
    ['a form value that is only a NUL', '', { initjs: '\u0000', targetingjs: 'x' }, { initjs: '', targetingjs: 'x' }],
    ['a form name holding a NUL', '', { 'init\u0000js': 'a', targetingjs: 'c' }, { initjs: 'a', targetingjs: 'c' }],
    ['a url name holding a NUL', '?init%00js=a', { targetingjs: 'c' }, { initjs: 'a', targetingjs: 'c' }],
  ])('saves %s for an s2 admin with the NUL removed, as legacy start-up leaves them', async (_label, query, fields, saved) => {
    api.db.clear();
    const res = await send(api, {
      method: 'POST',
      url: `${ENTITY}${query}`,
      subject: 's2',
      headers: { 'content-type': FORM },
      payload: formBody({ contentid: PAGE_ONE, ...fields, csrf_token: 'form-csrf-token', csrf_token_expires: 'form-csrf-expiry' }),
    });
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ method: 'save', data: { contentid: PAGE_ONE, ...saved, isnew: 0, errors: {} } });
    const inserts = api.db.writes().filter((statement) => TARGETING_WRITE.test(statement.sql) && statement.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(1);
    // Legacy stores an empty script as NULL.
    for (const value of Object.values(saved)) expect(inserts[0]?.params).toContainEqual(value === '' ? null : value);
    expect(inserts[0]?.params).not.toContain('');
    expect(JSON.stringify(inserts[0]?.params)).not.toContain('\\u0000');
  });

  it('answers a REST save holding a form NUL as the same save without it, as legacy does', async () => {
    const save = async (initjs: string) => {
      api.db.clear();
      const res = await send(api, {
        method: 'POST',
        url: `/_api/rest/v1/${SITE}/${segment}/`,
        subject: 's2',
        headers: { 'content-type': FORM },
        payload: formBody({ contentid: PAGE_ONE, initjs, targetingjs: 'c' }),
      });
      return { status: res.statusCode, body: res.body.replace(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}/g, '<id>'), writes: api.db.writes().length };
    };
    expect(await save('a\u0000b')).toEqual(await save('ab'));
  });

  it('answers a save PostgreSQL refuses as unstorable text with the invalidParameters row', async () => {
    // The refusal node-postgres raises for a NUL (SQLSTATE 22021).
    const unstorable = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021', severity: 'ERROR' });
    const refusing = await contentApi({}, (db) => {
      db.respond(/^INSERT INTO "content"\."variation_targeting"/, () => {
        throw unstorable;
      });
      return Promise.resolve();
    });
    try {
      const res = await send(refusing, {
        method: 'POST',
        url: ENTITY,
        subject: 's2',
        headers: { 'content-type': 'application/json', 'x-csrf_token': 'json-csrf-token', 'x-csrf_token_expires': 'json-csrf-expiry' },
        payload: JSON.stringify({ contentid: PAGE_ONE, initjs: 'a\u0000b' }),
      });
      expect(res.statusCode).toBe(LEGACY_ERROR_MAP.invalidParameters.status);
      expect(bodyOf(res)).toEqual({ apiversion: 'v1', method: 'save', error: errorBody('invalidParameters') });
      expect(refusing.db.statements.filter((statement) => /^INSERT INTO "content"\."variation_targeting"/.test(statement.sql))).toHaveLength(1);
    } finally {
      await refusing.close();
    }
  });
});

describe('path NULs no param takes', () => {
  const CATEGORY = IDS.categories.pooledParent;
  const CSRF_HEADERS = { 'x-csrf_token': 'json-csrf-token', 'x-csrf_token_expires': 'json-csrf-expiry' };
  /** A CF UUID in either case, as new ids are minted, or a request's own UUID. */
  const VOLATILE_ID = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-(?:[0-9A-F]{16}|[0-9A-F]{4}-[0-9A-F]{12})/gi;

  /** The answer and recorded writes of `request` for an s2 admin, ids as placeholders, and whether any statement binds a NUL. */
  async function served(request: ApiCall) {
    api.db.clear();
    const res = await send(api, { ...request, subject: 's2', headers: { ...CSRF_HEADERS, ...request.headers } });
    const text = ({ sql, params }: { sql: string; params: unknown }): string => JSON.stringify({ sql, params });
    return {
      status: res.statusCode,
      body: res.body.replace(VOLATILE_ID, '<id>'),
      writes: api.db.writes().map((statement) => text(statement).replace(VOLATILE_ID, '<id>')),
      bindsNul: api.db.statements.some((statement) => text(statement).includes('\\u0000')),
    };
  }

  it.each<[string, HttpMethod, string, string | undefined]>([
    ['segments after a 35-character id, which processRequest never reads', 'DELETE', `/category/${CATEGORY}/x/y`, undefined],
    ['a segment after a remote function', 'POST', '/comment/flag/x', ''],
  ])('answers a request whose NUL sits in %s as the request without it, binding no NUL', async (_label, method, path, payload) => {
    const headers: Record<string, string> = payload === undefined ? {} : { 'content-type': FORM };
    const withNul = await served({ method, url: `${API}${path}%00`, headers, payload });
    expect(withNul.bindsNul).toBe(false);
    expect(withNul).toStrictEqual(await served({ method, url: `${API}${path}`, headers, payload }));
  });

  it('answers a save whose path-pair name holds a NUL as the save of the name parseParamsFromPath strips it to', async () => {
    const request = (name: string): ApiCall => ({ method: 'POST', url: `${API}/save/entityname/category/${name}/f7`, headers: { 'content-type': FORM }, payload: '' });
    const withNul = await served(request('na%00me'));
    expect(withNul.bindsNul).toBe(false);
    expect(withNul).toStrictEqual(await served(request('name')));
  });
});

describe('the ignored JSONApi site flag', () => {
  let flagged: TestApp;

  beforeAll(async () => {
    // The site projection models no JSON API flag, so the legacy tsettings.JSONApi column (dbUpdates/6.2.cfm:6, default 0)
    // is added to the registry rows to show the route serves the site without reading it.
    flagged = await contentApi({}, async (db) => {
      const { rows } = await db.withMetadata((tx) => tx.query(`SELECT * FROM ${db.schema}.tenant_registry ORDER BY site_id`));
      db.respond(/ FROM \S*tenant_registry WHERE NOT deleted ORDER BY site_id$/, () => rows.map((row) => ({ ...row, jsonapi: 0 })));
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

describe('site custom image sizes', () => {
  const IMAGE_FILE = 'A3000000-0000-0000-0000000000000099';
  const SIZES_ROUTE = '/internal/v1/sites/{siteId}/image-sizes';
  const CAROUSEL = { sizeID: 'C63AB001-1111-2222-3333444455556666', siteID: SITE, name: 'carouselimage', height: '400', width: '1200', isNew: 0 };
  let imaged: TestApp;

  beforeAll(async () => {
    // Every published page as one with an uploaded PNG.
    imaged = await contentApi({}, async (db) => {
      db.respond(ACTIVE_READ, (params, sql, tx) => activeContent(params, sql, tx).map((row) => ({ ...row, fileid: IMAGE_FILE, fileext: 'png' })));
    });
    imaged.client.on('programs-sites', 'GET', SIZES_ROUTE, () => ({ status: 200, headers: {}, body: [CAROUSEL] }));
  });

  afterAll(async () => {
    await imaged?.close();
  });

  function sizeCalls(app: TestApp) {
    return app.client.requests.filter((req) => req.service === 'programs-sites');
  }

  /** The renditions of `images` plus `carouselimage`, which names its rendition as `small` does. */
  function expectCarousel(images: Struct): void {
    expect(Object.keys(images).sort()).toEqual(['carouselimage', 'large', 'medium', 'small', 'source']);
    expect(images.carouselimage).toBe(String(images.small).replace('small', 'carouselimage'));
    expect(images.carouselimage).toContain(IMAGE_FILE);
  }

  it('lists the site custom sizes beside the renditions, read from programs-sites as this service', async () => {
    imaged.client.clear();
    const res = await send(imaged, { url: `${API}${PAGE_ONE_PATH}?fields=images,title` });
    expect(res.statusCode).toBe(200);
    expectCarousel(dataOf(res).images as Struct);
    expect(sizeCalls(imaged)).toEqual([expect.objectContaining({ method: 'GET', path: `/internal/v1/sites/${SITE}/image-sizes`, userToken: null })]);
  });

  it('reads the sizes once for every image entity of a request', async () => {
    imaged.client.clear();
    const res = await send(imaged, { url: `${API}${PAGE_ONE_PATH}?expand=parent` });
    expect(res.statusCode).toBe(200);
    const data = dataOf(res);
    expect((data.parent as Struct).contentid).toBe(IDS.content.section);
    for (const entity of [data, data.parent as Struct]) expectCarousel(entity.images as Struct);
    expect(sizeCalls(imaged)).toHaveLength(1);
  });

  it('makes no programs-sites call for a request that serializes no image', async () => {
    api.client.clear();
    const res = await send(api, { url: `${API}${PAGE_ONE_PATH}` });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res).images).toEqual({});
    expect(sizeCalls(api)).toEqual([]);
  });

  it('answers the legacy 503 when programs-sites is unavailable', async () => {
    imaged.client.failNext('programs-sites');
    const res = await send(imaged, { url: `${API}${PAGE_ONE_PATH}` });
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
  });
});
