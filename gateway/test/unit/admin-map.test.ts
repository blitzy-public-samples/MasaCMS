// Tests the admin response-mode lookup and the web request mapAdminToWeb builds for each mode.
import { Buffer } from 'node:buffer';
import { routeKeyForRequest, type RouteKeyResult, type VariantDeclaration } from '@opt2/platform/legacy-compat';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AdminMappingError,
  ORIGINAL_URL_HEADER,
  WEB_PREFIX_BY_MODE,
  mapAdminToWeb,
  type AdminRequestLike,
  type AdminWebTarget,
} from '../../src/admin/map.js';
import { createResponseModes, type AdminResponseMode, type ResponseModes } from '../../src/admin/response-modes.js';
import { loadInventoryFacts, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { InventoryFacts, RouteFacts } from '../../src/cutover/types.js';
import { bodyParamsFrom } from '../../src/dispatcher/body.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { cutoverTable, entry } from '../helpers/versions.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const BOUNDARY = 'opt2-admin-map';
const MULTIPART = `multipart/form-data; boundary=${BOUNDARY}`;
/** Credential values that must never reach a web request target. */
const SENTINEL = Object.freeze({
  password: 'SENTINEL-PASSWORD-7f3a',
  authcode: 'SENTINEL-AUTHCODE-91c2',
  token: 'SENTINEL-CSRF-TOKEN-5d0e',
  expires: 'SENTINEL-CSRF-EXPIRES-27b8',
});
/** The admin login form's fields, posted with the sentinel credentials. */
const LOGIN_FIELDS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['muraAction', 'cLogin.login'],
  ['username', 'admin'],
  ['password', SENTINEL.password],
  ['authcode', SENTINEL.authcode],
  ['csrf_token', SENTINEL.token],
  ['csrf_token_expires', SENTINEL.expires],
]);

type ModeFacts = Pick<RouteFacts, 'responseMode' | 'contentType'>;

/** Inventory facts of exactly `routes`, keyed as authored and looked up normalised, as the loader does. */
function factsOf(routes: Record<string, ModeFacts>): InventoryFacts {
  const byRoute = new Map<string, RouteFacts>(
    Object.entries(routes).map(([route, mode]) => [
      route.trim().toLowerCase(),
      { route, csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects: ['none'], ...mode },
    ]),
  );
  return { get: (key) => byRoute.get(key.trim().toLowerCase()), routes: () => Object.keys(routes) };
}

interface Sent {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer;
}

/** A request as the dispatcher receives it: the mapping's facts plus the headers the route key reads. */
type SentRequest = AdminRequestLike & { readonly headers: Readonly<Record<string, string | string[]>> };

function requestOf(url: string, { method = 'GET', headers = {} }: Sent = {}): SentRequest {
  return { url, method, headers };
}

/** Route key of `request` under the shared precedence, with the body's form fields. */
function keyOf(request: SentRequest, form: Readonly<Record<string, string>>, variants: readonly VariantDeclaration[] = []): RouteKeyResult {
  const queryAt = request.url.indexOf('?');
  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(queryAt === -1 ? '' : request.url.slice(queryAt + 1))) query[name] = value;
  return routeKeyForRequest(
    {
      method: request.method,
      path: queryAt === -1 ? request.url : request.url.slice(0, queryAt),
      query,
      form: { ...form },
      headers: { ...request.headers },
    },
    { variants },
  );
}

/** The dispatcher's path to the mapping: body fields read by `bodyParamsFrom`, then the route key, then the web target. */
function route(
  modes: ResponseModes,
  url: string,
  sent: Sent = {},
  variants: readonly VariantDeclaration[] = [],
): { result: RouteKeyResult; target: AdminWebTarget } {
  const request = requestOf(url, sent);
  const contentType = sent.headers?.['content-type'];
  const { form } = bodyParamsFrom(Array.isArray(contentType) ? contentType[0] : contentType, sent.body, request.method);
  const result = keyOf(request, form, variants);
  return { result, target: mapAdminToWeb({ result, request, modes }) };
}

function multipartBody(parts: Array<{ name: string; value: string; filename?: string }>): Buffer {
  const lines = parts.flatMap(({ name, value, filename }) => [
    `--${BOUNDARY}`,
    filename === undefined
      ? `Content-Disposition: form-data; name="${name}"`
      : `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream`,
    '',
    value,
  ]);
  return Buffer.from([...lines, `--${BOUNDARY}--`, ''].join('\r\n'));
}

/** The login form posted url-encoded, and as multipart with a file part. */
const LOGIN_URLENCODED = Buffer.from(new URLSearchParams(LOGIN_FIELDS.map(([name, value]): [string, string] => [name, value])).toString());
const LOGIN_MULTIPART = multipartBody([
  ...LOGIN_FIELDS.map(([name, value]) => ({ name, value })),
  { name: 'attachment', value: 'FILE-BYTES', filename: 'p.png' },
]);

const paths = resolveGatewayPaths({});
let facts: InventoryFacts;
let committed: ResponseModes;
let variants: readonly VariantDeclaration[];

beforeAll(async () => {
  const [loadedFacts, variantsFile] = await Promise.all([loadInventoryFacts(paths), loadVariants(paths)]);
  facts = loadedFacts;
  variants = variantsFile.variants;
  committed = createResponseModes(facts);
});

describe('createResponseModes', () => {
  const modes = createResponseModes(
    factsOf({
      'ADMIN:CUSERS.LIST': { responseMode: 'page', contentType: 'text/html' },
      'admin:cusers.update': { responseMode: 'redirect' },
      'admin:cusers.update{type=1}': { responseMode: 'json', contentType: 'application/json' },
      'admin:carch.edit': {},
      'fixture:communications/messages/{id}@get': { responseMode: 'json', contentType: 'application/json' },
      'api:content.findone': { responseMode: 'json', contentType: 'application/json' },
    }),
  );

  it('answers an admin key in any spelling with one frozen info', () => {
    const info = modes.modeFor(' Admin:CUsers.List ');
    expect(info).toStrictEqual({ responseMode: 'page', contentType: 'text/html' });
    expect(Object.isFrozen(info)).toBe(true);
    expect(modes.modeFor('admin:cusers.list')).toBe(info);
  });

  it('omits contentType where the facts record none', () => {
    const info = modes.modeFor('admin:cusers.update');
    expect(info).toStrictEqual({ responseMode: 'redirect' });
    expect(info).not.toHaveProperty('contentType');
  });

  it.each(['fixture:communications/messages/{id}@get', 'api:content.findone', 'admin:carch.edit', 'admin:carch.edit{notify}', 'admin:cfeed.list'])(
    'answers undefined for %s, which has no admin mode',
    (key) => {
      expect(modes.modeFor(key)).toBeUndefined();
    },
  );

  it.each<[string, AdminResponseMode | undefined]>([
    ['admin:cusers.update{type=1}', 'json'],
    ['ADMIN:CUSERS.UPDATE{TYPE=1}', 'json'],
    ['admin:cusers.update{type=2,action=add}', 'redirect'],
    ['admin:cusers.update{type=1', undefined],
    ['admin:cusers.update}', undefined],
  ])('resolves %s to %s, by its own variant mode before its base mode', (key, mode) => {
    expect(modes.modeFor(key)?.responseMode).toBe(mode);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(modes)).toBe(true);
  });
});

describe('createResponseModes over the committed inventory', () => {
  it('answers every admin route with its recorded mode and every other route with none', () => {
    const routes = facts.routes();
    expect(routes.some((key) => key.startsWith('admin:'))).toBe(true);
    for (const key of routes) {
      const recorded = facts.get(key);
      const expected =
        !key.startsWith('admin:') || recorded?.responseMode === undefined
          ? undefined
          : recorded.contentType === undefined
            ? { responseMode: recorded.responseMode }
            : { responseMode: recorded.responseMode, contentType: recorded.contentType };
      expect(committed.modeFor(key), key).toStrictEqual(expected);
    }
  });

  it.each<[string, AdminResponseMode, string | undefined]>([
    ['admin:cusers.list', 'page', 'text/html'],
    ['admin:cperm.main', 'page', 'text/html'],
    ['admin:carch.loaddiff', 'fragment', 'text/html'],
    ['admin:carch.loadsitemanager', 'json', 'application/json'],
    ['admin:carch.downloaddata', 'download', 'application/msexcel'],
    ['admin:cusers.download', 'download', 'text/csv'],
    ['admin:cusers.update{type=1}', 'redirect', undefined],
    ['admin:carch.updateobjectparams{approved=1}', 'json', 'text/html'],
  ])('records %s as %s, content type %s', (key, responseMode, contentType) => {
    expect(committed.modeFor(key)).toStrictEqual(contentType === undefined ? { responseMode } : { responseMode, contentType });
  });
});

describe('WEB_PREFIX_BY_MODE', () => {
  it('sends page to /admin, fragment, json and download to /admin-raw, and redirect to /admin-actions', () => {
    expect(WEB_PREFIX_BY_MODE).toStrictEqual({
      page: '/admin',
      fragment: '/admin-raw',
      json: '/admin-raw',
      download: '/admin-raw',
      redirect: '/admin-actions',
    });
    expect(Object.isFrozen(WEB_PREFIX_BY_MODE)).toBe(true);
  });
});

const BY_MODE: Array<[AdminResponseMode, string, string, string | undefined]> = [
  ['page', 'cusers.list', '/admin/cusers/list', 'text/html'],
  ['fragment', 'carch.loaddiff', '/admin-raw/carch/loaddiff', 'text/html'],
  ['json', 'carch.loadsitemanager', '/admin-raw/carch/loadsitemanager', 'application/json'],
  ['download', 'carch.downloaddata', '/admin-raw/carch/downloaddata', 'application/msexcel'],
  ['redirect', 'csettings.updatesite', '/admin-actions/csettings/updatesite', undefined],
];

/** The target a mode yields for `url`, as the web contract states it. */
function expectedTarget(
  responseMode: AdminResponseMode,
  path: string,
  method: string,
  url: string,
  contentType: string | undefined,
): AdminWebTarget {
  const forwardBody = responseMode !== 'page' || method === 'POST';
  const target: AdminWebTarget = { path, method, forwardBody, headers: { [ORIGINAL_URL_HEADER]: url }, responseMode };
  return contentType === undefined ? target : { ...target, contentType };
}

describe('mapAdminToWeb by response mode', () => {
  it.each(BY_MODE)('maps a %s GET of %s to %s with the query verbatim and the original URL', (mode, action, webPath, contentType) => {
    const query = `muraAction=${action}&siteid=default&q=a+b%2Fc%C3%A9&x=a%20b&x=%7E&flag&x=c`;
    const url = `/admin/?${query}`;
    const { target } = route(committed, url);
    expect(target).toStrictEqual(expectedTarget(mode, `${webPath}?${query}`, 'GET', url, contentType));
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.headers)).toBe(true);
  });

  it.each(BY_MODE)('adds no "?" to a %s request without a query (%s)', (mode, action, webPath, contentType) => {
    const url = `/admin/index.cfm/${action.replace('.', '/')}`;
    const { target } = route(committed, url);
    expect(target).toStrictEqual(expectedTarget(mode, webPath, 'GET', url, contentType));
  });

  it.each(BY_MODE)('maps a %s url-encoded POST of %s to %s as a POST with its body and the query alone', (mode, action, webPath, contentType) => {
    const url = `/admin/?muraAction=${action}`;
    const body = 'siteid=default&note=a+b%26c';
    const { target } = route(committed, url, { method: 'POST', headers: { 'content-type': URLENCODED }, body: Buffer.from(body) });
    expect(target).toStrictEqual(expectedTarget(mode, `${webPath}?muraAction=${action}`, 'POST', url, contentType));
  });

  it.each(BY_MODE.filter(([mode]) => mode !== 'page'))('keeps the method of a %s request as sent (%s)', (_mode, action) => {
    for (const method of ['PUT', 'DELETE', 'HEAD', 'post']) {
      expect(route(committed, `/admin/?muraAction=${action}`, { method }).target.method).toBe(method);
    }
  });

  it('maps FW/1 path info by its action and carries it only in the original URL', () => {
    const url = '/admin/index.cfm/cusers/list/siteid/default?compactDisplay=true';
    const { target } = route(committed, url);
    expect(target.path).toBe('/admin/cusers/list?compactDisplay=true');
    expect(target.headers).toStrictEqual({ [ORIGINAL_URL_HEADER]: url });
  });

  it('maps the action fuseaction selects over muraAction and keeps both in the query', () => {
    const url = '/admin/?fuseaction=cusers.list&muraAction=carch.loaddiff';
    const { result, target } = route(committed, url);
    expect(result.key).toBe('admin:cusers.list');
    expect(target.path).toBe('/admin/cusers/list?fuseaction=cusers.list&muraAction=carch.loaddiff');
    expect(target.responseMode).toBe('page');
  });

  it('takes circuit and action from the lower-cased base key, not the query spelling', () => {
    expect(route(committed, '/admin/?muraAction=cUsers.List').target.path).toBe('/admin/cusers/list?muraAction=cUsers.List');
  });

  it('maps the committed cUsers.download to its raw download handler, not a page', () => {
    const url = '/admin/?muraAction=cUsers.download&siteid=default&ispublic=0';
    const { result, target } = route(committed, url);
    expect(result.key).toBe('admin:cusers.download');
    expect(target).toStrictEqual(
      expectedTarget('download', '/admin-raw/cusers/download?muraAction=cUsers.download&siteid=default&ispublic=0', 'GET', url, 'text/csv'),
    );
  });

  it('maps a committed variant by its base action, without variant braces', () => {
    const url = '/admin/?muraAction=cusers.update';
    const { result, target } = route(
      committed,
      url,
      { method: 'POST', headers: { 'content-type': URLENCODED }, body: Buffer.from('type=1&groupname=Editors') },
      variants,
    );
    expect(result.key).toBe('admin:cusers.update{type=1}');
    expect(target).toStrictEqual(expectedTarget('redirect', '/admin-actions/cusers/update?muraAction=cusers.update', 'POST', url, undefined));
  });

  it("uses a variant's own mode before its base mode", () => {
    const modes = createResponseModes(
      factsOf({
        'admin:cusers.update': { responseMode: 'redirect' },
        'admin:cusers.update{type=1}': { responseMode: 'json', contentType: 'application/json' },
      }),
    );
    const sent: Sent = { method: 'POST', headers: { 'content-type': URLENCODED }, body: Buffer.from('type=1') };
    expect(route(modes, '/admin/?muraAction=cusers.update', sent, variants).target).toMatchObject({
      path: '/admin-raw/cusers/update?muraAction=cusers.update',
      method: 'POST',
      responseMode: 'json',
      contentType: 'application/json',
    });
    const other: Sent = { ...sent, body: Buffer.from('type=2&action=Add') };
    expect(route(modes, '/admin/?muraAction=cusers.update', other, variants).target.responseMode).toBe('redirect');
  });

  it('URI-component-encodes circuit and action', () => {
    const modes = createResponseModes(factsOf({ 'admin:c users.li?st#1': { responseMode: 'fragment', contentType: 'text/html' } }));
    expect(route(modes, '/admin/?muraAction=c%20users.li%3Fst%231').target.path).toBe('/admin-raw/c%20users/li%3Fst%231?muraAction=c%20users.li%3Fst%231');
  });

  it('sets only the original-URL header, whatever the request carries', () => {
    const url = '/admin/?muraAction=cusers.list';
    const headers = { [ORIGINAL_URL_HEADER.toLowerCase()]: '/forged', cookie: 'CFID=1', authorization: 'Bearer x' };
    expect(ORIGINAL_URL_HEADER).toBe('X-Opt2-Original-Url');
    expect(route(committed, url, { headers }).target.headers).toStrictEqual({ [ORIGINAL_URL_HEADER]: url });
  });
});

describe('mapAdminToWeb of the committed form-builder, Import Form and object-params actions', () => {
  const urlencoded = (body: string): Sent => ({ method: 'POST', headers: { 'content-type': URLENCODED }, body: Buffer.from(body) });

  // Requests as the template builder and front-end configurator scripts send them.
  it.each<[string, Sent, string, AdminResponseMode, string]>([
    ['/admin/?muraAction=cform.getdialog&i=42', urlencoded('dialog=dialog-confirm'), '/admin-raw/cform/getdialog', 'fragment', 'text/html'],
    ['/admin/?muraAction=cform.getfieldtemplate&i=42', urlencoded('fieldType=field-textfield&formid=F1'), '/admin-raw/cform/getfieldtemplate', 'fragment', 'text/html'],
    ['/admin/?muraAction=cForm.getForm&siteid=default&formid=F1', {}, '/admin-raw/cform/getform', 'json', 'application/json'],
    ['/admin/?muraAction=cform.getfield&i=42', urlencoded('fieldtype=field-textfield&formid=F1'), '/admin-raw/cform/getfield', 'json', 'application/json'],
    ['/admin/?muraAction=cForm.getFieldType&siteid=default&fieldtype=field-textfield', {}, '/admin-raw/cform/getfieldtype', 'json', 'application/json'],
    ['/admin/?muraAction=cform.getdataset&i=42', urlencoded('datasetID=&fieldID=D1'), '/admin-raw/cform/getdataset', 'json', 'application/json'],
    ['/admin/index.cfm?muraAction=cArch.updateObjectParams', urlencoded('contenthistid=H1&approved=0&preview=0'), '/admin-raw/carch/updateobjectparams', 'json', 'text/html'],
  ])('maps %s to its raw handler with the method, query and body as sent', (url, sent, webPath, mode, contentType) => {
    const query = url.slice(url.indexOf('?'));
    const { target } = route(committed, url, sent, variants);
    expect(target).toStrictEqual(expectedTarget(mode, `${webPath}${query}`, sent.method ?? 'GET', url, contentType));
  });

  it('forwards the native Import Form multipart POST to its post action with the zip and no fields in the query', () => {
    const url = '/admin/?muraAction=cForm.importform';
    const body = multipartBody([
      { name: 'csrf_token', value: 'A'.repeat(64) },
      { name: 'csrf_token_expires', value: '261112191044236' },
      { name: 'title', value: 'Imported Form' },
      { name: 'formzip', value: 'PK\u0003\u0004zip-bytes', filename: 'export.zip' },
    ]);
    const { result, target } = route(committed, url, { method: 'POST', headers: { 'content-type': MULTIPART }, body }, variants);
    expect(result.key).toBe('admin:cform.importform');
    expect(target).toStrictEqual(expectedTarget('redirect', '/admin-actions/cform/importform?muraAction=cForm.importform', 'POST', url, undefined));
  });

  it('sends the Import Form GET to the post action, which renders the form', () => {
    const url = '/admin/?muraAction=cForm.importform&siteid=default';
    expect(route(committed, url).target).toStrictEqual(
      expectedTarget('redirect', '/admin-actions/cform/importform?muraAction=cForm.importform&siteid=default', 'GET', url, undefined),
    );
  });
});

describe('mapAdminToWeb page-mode POST', () => {
  const listUrl = '/admin/?muraAction=cusers.list';
  const listPath = '/admin/cusers/list?muraAction=cusers.list';

  it.each<[string, Sent['headers'], Buffer]>([
    ['url-encoded', { 'content-type': URLENCODED }, Buffer.from('siteid=default&note=a+b%26c')],
    [
      'multipart',
      { 'content-type': MULTIPART },
      multipartBody([
        { name: 'siteid', value: 'default' },
        { name: 'newFile', value: 'BYTES', filename: 'p.png' },
      ]),
    ],
    ['JSON', { 'content-type': 'application/json' }, Buffer.from('{"siteid":"default"}')],
    ['text/plain', { 'content-type': 'text/plain' }, Buffer.from('siteid=default')],
    ['content-type-less', {}, Buffer.from('siteid=default')],
  ])('keeps a %s POST to a page as a POST with its body and the original query alone', (_label, headers, body) => {
    const { target } = route(committed, listUrl, { method: 'POST', headers, body });
    expect(target).toStrictEqual(expectedTarget('page', listPath, 'POST', listUrl, 'text/html'));
  });

  it.each([
    ['/admin/index.cfm/cusers/list', 'siteid=default', '/admin/cusers/list'],
    ['/admin/?', 'muraAction=cusers.list&siteid=default', '/admin/cusers/list?'],
    ['/admin/?muraAction=cusers.list&q=a%20b+c', 'siteid=default', '/admin/cusers/list?muraAction=cusers.list&q=a%20b+c'],
  ])('sends a page POST to %s with body %j to web path %s', (url, body, path) => {
    const { target } = route(committed, url, { method: 'POST', headers: { 'content-type': URLENCODED }, body: Buffer.from(body) });
    expect(target).toMatchObject({ path, method: 'POST', forwardBody: true });
  });

  it.each<[string, Sent['headers'], Buffer]>([
    ['url-encoded', { 'content-type': URLENCODED }, LOGIN_URLENCODED],
    ['multipart', { 'content-type': MULTIPART }, LOGIN_MULTIPART],
  ])('keeps the password, authcode and CSRF pair of a %s login out of the web path', (_label, headers, body) => {
    const { result, target } = route(committed, '/admin/index.cfm', { method: 'POST', headers, body });
    expect(result.key).toBe('admin:clogin.login');
    expect(target).toMatchObject({ path: '/admin/clogin/login', method: 'POST', forwardBody: true, responseMode: 'page' });
    for (const value of Object.values(SENTINEL)) expect(target.path).not.toContain(value);
  });

  it.each<[string, Record<string, string>, string, boolean]>([
    ['POST', {}, 'POST', true],
    ['post', {}, 'POST', true],
    ['POST', { 'x-http-method-override': 'PUT' }, 'POST', true],
    ['PUT', {}, 'GET', false],
    ['DELETE', {}, 'GET', false],
    ['GET', { 'x-http-method-override': 'POST' }, 'GET', false],
    ['HEAD', {}, 'HEAD', false],
  ])('maps a page request line %s with %j to web as %s, forwarding its body: %s', (method, extra, sentMethod, forwardBody) => {
    const sent: Sent = { method, headers: { 'content-type': URLENCODED, ...extra }, body: Buffer.from('siteid=default') };
    expect(route(committed, listUrl, sent).target).toMatchObject({ path: listPath, method: sentMethod, forwardBody });
  });
});

describe('mapAdminToWeb rejections', () => {
  it.each([
    ['a JSON API route', '/index.cfm/_api/json/v1/default/content/', 'api:content.findall', 'not a core admin action'],
    ['a subsystem action', '/admin/?muraAction=plugin:main.default', 'admin:plugin:main.default', 'not a core admin action'],
    ['an action containing a slash', '/admin/?muraAction=a/b', 'admin:!actioncontainsslash', 'not a core admin action'],
    ['an admin action without an inventoried mode', '/admin/?muraAction=cusers.nosuchaction', 'admin:cusers.nosuchaction', 'no inventoried response mode'],
  ])('rejects %s', (_label, url, key, reason) => {
    const map = (): AdminWebTarget => route(committed, url).target;
    expect(map).toThrow(AdminMappingError);
    expect(map).toThrow(`cannot map admin route ${key} to web: ${reason}`);
  });

  it('checks the action before the mode lookup', () => {
    const modes = createResponseModes(factsOf({ 'admin:plugin:main.default': { responseMode: 'page', contentType: 'text/html' } }));
    expect(modes.modeFor('admin:plugin:main.default')).toBeDefined();
    expect(() => route(modes, '/admin/?muraAction=plugin:main.default')).toThrow('not a core admin action');
  });

  it('names its error AdminMappingError', () => {
    const error = new AdminMappingError('admin:x.y', 'reason');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AdminMappingError');
    expect(error.message).toBe('cannot map admin route admin:x.y to web: reason');
  });
});

describe('admin request through the gateway to web', () => {
  const PERM_URL = '/admin/?muraAction=cPerm.main&siteid=tenant-a';
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  it.each<[string, Record<string, string>]>([
    ['without an original-URL header', {}],
    ['replacing a forged original-URL header', { [ORIGINAL_URL_HEADER]: '/evil' }],
  ])('sends a target page action to its web page handler with the browser URL, %s', async (_label, headers) => {
    gateway = await buildTestGateway({
      version: cutoverTable({
        tableVersion: 'v9001',
        entries: [entry({ route: 'admin:cperm.main', owningService: 'web', state: 'target', kind: 'read' })],
      }),
    });
    const res = await gateway.app.inject({ method: 'GET', url: PERM_URL, headers });
    expect(res.statusCode).toBe(200);
    expect(gateway.legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/'))).toHaveLength(0);
    const echoes = gateway.web.echoes();
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({ method: 'GET', url: '/admin/cperm/main?muraAction=cPerm.main&siteid=tenant-a', originalUrl: PERM_URL });
  });

  it.each<[string, string, Buffer]>([
    ['url-encoded', URLENCODED, LOGIN_URLENCODED],
    ['multipart', MULTIPART, LOGIN_MULTIPART],
  ])('forwards a %s page POST to web as a POST with its body bytes and content type, never its fields in the url', async (_label, contentType, payload) => {
    const url = '/admin/index.cfm?compactDisplay=false';
    gateway = await buildTestGateway({
      version: cutoverTable({
        tableVersion: 'v9001',
        entries: [entry({ route: 'admin:clogin.login', owningService: 'identity', state: 'target', kind: 'read' })],
      }),
    });
    const res = await gateway.app.inject({ method: 'POST', url, headers: { 'content-type': contentType }, payload });
    expect(res.statusCode).toBe(200);
    const echoes = gateway.web.echoes();
    expect(echoes).toHaveLength(1);
    const [echo] = echoes;
    expect(echo).toMatchObject({ method: 'POST', url: '/admin/clogin/login?compactDisplay=false', originalUrl: url, contentType });
    expect(Buffer.from(echo?.bodyBase64 ?? '', 'base64').equals(payload)).toBe(true);
    for (const [name] of LOGIN_FIELDS) expect(echo?.query).not.toHaveProperty(name);
    for (const value of Object.values(SENTINEL)) expect(echo?.url).not.toContain(value);
  });
});
