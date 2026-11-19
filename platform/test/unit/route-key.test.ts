import { describe, expect, it } from 'vitest';
import {
  IMAGE_UPLOAD_CONDITION,
  PHOTO_CONDITION,
  REST_CONSUMED_PARAMS_HEADER,
  ROUTE_FAMILIES,
  SAVEFORM_CONDITION,
  SESSION_MANAGED_CONDITION,
  SHARED_ID_SORT_CONDITIONS,
  STARTUP_SITE_CONDITION,
  SYNTHETIC_V1_PREFIXES,
  type RouteEntryPoint,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type RouteKeyResult,
  type VariantCondition,
  type VariantDeclaration,
  apiRequestPath,
  entityRemoteFunctionsFromKeys,
  fixtureDispatchPath,
  isLegacySessionManaged,
  listHasSqlKey,
  matchRouteKey,
  normaliseRouteKey,
  routeKeyForEntryPoint,
  routeKeyForRequest,
} from '../../src/legacy-compat/route-key.js';
import { scannedRouteKey } from '../../src/legacy-compat/scanned-route-key.js';
import { routeKeyCaseOptions, routeKeyConflictCases } from '../../src/testing/route-key-cases.js';

const UUID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const RFC_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const API = '/_api/json/v1/default';
const ONLY_DEFAULT: RouteKeyOptions = { siteExists: (siteId) => siteId === 'default' };
const JSON_TYPE = { 'Content-Type': 'application/json' };

function request(method: string, url: string, extra: Partial<RouteKeyRequest> = {}): RouteKeyRequest {
  const [path = '', search = ''] = url.split('?');
  return { method, path, query: Object.fromEntries(new URLSearchParams(search)), headers: {}, ...extra };
}

function resultOf(
  method: string,
  url: string,
  extra: Partial<RouteKeyRequest> = {},
  opts: RouteKeyOptions = {},
): RouteKeyResult {
  return routeKeyForRequest(request(method, url, extra), opts);
}

function keyOf(method: string, url: string, extra: Partial<RouteKeyRequest> = {}, opts: RouteKeyOptions = {}): string {
  return resultOf(method, url, extra, opts).key;
}

function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

describe('routeKeyConflictCases', () => {
  it.each(routeKeyConflictCases)('$name', ({ request: req, expectedKey }) => {
    expect(routeKeyForRequest(req, routeKeyCaseOptions).key).toBe(expectedKey);
  });
});

describe('path normalisation', () => {
  it.each([
    ['strips /index.cfm before an API path', '/index.cfm/_api/json/v1/default/content/', 'api:content.findall'],
    ['keys the bare front controller as a page render', '/index.cfm', 'page:render'],
    ['strips index.cfm from the admin path', '/admin/index.cfm?muraAction=cUsers.list', 'admin:cusers.list'],
    ['reads the admin action from segments after index.cfm', '/admin/index.cfm/cUsers/list', 'admin:cusers.list'],
    ['folds /tasks/feed onto the feed key', '/tasks/feed/?feedid=F1', 'feed:v1'],
    ['folds /tasks/render onto the render key', '/tasks/render/small/?fileid=F1', 'render:small'],
    ['percent-decodes the path', `${API}/%75sers`, 'api:user.findall'],
    ['keeps a malformed escape as sent', '/assets/a%ZZ.css', 'static:/assets/a%zz.css'],
    ['adds a missing leading slash', 'about/', 'page:render'],
  ])('%s', (_label, url, key) => {
    expect(keyOf('GET', url)).toBe(key);
  });

  it.each([
    ['/index.cfm/_api/json/v1/default/content/', '/_api/json/v1/default/content/'],
    ['/tasks/feed/?feedid=F1', '/_api/feed/v1/?feedid=F1'],
    ['/tasks/render/medium/?fileid=F1', '/_api/render/medium/?fileid=F1'],
  ])('keys %s like %s', (folded, canonical) => {
    expect(keyOf('GET', folded)).toBe(keyOf('GET', canonical));
  });

  it.each([
    ['/masa/admin/?muraAction=cUsers.list', '/masa/', 'admin:cusers.list'],
    ['/masa', '/masa/', 'page:render'],
    ['/MASA/admin/', '/masa', 'admin:home.redirect'],
    ['/masafoo/a.css', '/masa', 'static:/masafoo/a.css'],
    ['/admin/?muraAction=cUsers.list', '/', 'admin:cusers.list'],
  ])('removes the context from %s under context %s', (url, context, key) => {
    expect(keyOf('GET', url, {}, { context })).toBe(key);
  });

  it.each([
    '/index.cfm/opt2/stub/items',
    '/index.cfm/v1/messages',
    '/index.cfm/gateway/legacy-bridge/session.cfm',
    '/index.cfm/admin/',
    '/index.cfm/core/mura/remote.cfc',
    '/index.cfm/about/style.css',
  ])('serves %s through the front controller as a page', (url) => {
    expect(keyOf('GET', url)).toBe('page:render');
  });
});

describe('path decoding', () => {
  // The root front controller urlDecodes the container-decoded path again.
  it.each([
    ['splits an API path on a double-encoded slash', `${API}/content%252Fnew`, 'api:content.findnew'],
    ['decodes twice behind index.cfm', `/index.cfm${API}/content%252Fnew`, 'api:content.findnew'],
    ['decodes no third time', `${API}/user/%252531`, 'api:!invalidmethodcall'],
    ['routes a double-encoded _api page path to the API', '/%255Fapi/json/v1/default/content/new', 'api:content.findnew'],
    ['routes a double-encoded _api after index.cfm to the API', '/index.cfm/%255Fapi/json/v1/default/content', 'api:content.findall'],
    ['turns + into a space', `${API}/user/1+`, 'api:user.findall'],
    ['turns an encoded + into a space', `${API}/user/1%2B`, 'api:user.findall'],
    ['keeps the + of a double-encoded %2B', `${API}/user/1%252B`, 'api:!invalidmethodcall'],
    ['decodes a double-encoded digit', `${API}/user/%2531`, 'api:user.findall'],
    ['decodes a double-encoded tab', `${API}/user/%25091`, 'api:user.findall'],
    ['decodes a double-encoded comma', `${API}/content/1%252C2`, 'api:content.findmany'],
    ['decodes lower-case hex', `${API}/content/1%252c2`, 'api:content.findmany'],
    ['keeps a malformed second escape and decodes the rest', `${API}/content/1%252C2%25zz`, 'api:content.findmany'],
    ['keeps the two characters after a lone percent', `${API}/content/1%25%252C2`, 'api:content.findone'],
    ['keeps a short escape before a valid one', `${API}/content/1%252%252C2`, 'api:content.findone'],
    ['keeps a trailing lone percent', `${API}/user/1%25`, 'api:!invalidmethodcall'],
    ['leaves %u escapes', `${API}/content/1%25u002C2`, 'api:content.findone'],
    ['gives a path the container rejects no second decode', `${API}/content/1%252C2%zz`, 'api:content.findone'],
  ])('%s', (_label, url, key) => {
    expect(keyOf('GET', url, {}, ONLY_DEFAULT)).toBe(key);
  });

  it('reads the site id and params from the double-decoded path', () => {
    const site = resultOf('GET', '/_api/json/v1/%2564efault/content/new', {}, ONLY_DEFAULT);
    const spaced = resultOf('GET', '/_api/json/v1/de+fault/content/new', {}, ONLY_DEFAULT);
    expect([site.key, site.siteId]).toEqual(['api:content.findnew', 'default']);
    expect([spaced.key, spaced.params.siteid]).toEqual(['api:!invalidparameters', 'de fault']);
  });

  // Admin reads cgi.path_info as the container decoded it.
  it.each([
    ['keeps + in an admin action', '/admin/index.cfm/cu+sers/list', 'admin:cu+sers.list'],
    ['decodes an admin action once', '/admin/index.cfm/cusers%252Flist', 'admin:cusers%2flist.default'],
    ['splits an admin path on an encoded slash', '/admin/index.cfm/cu+sers%2Flist', 'admin:cu+sers.list'],
    ['replaces an invalid UTF-8 byte with U+FFFD', '/admin/index.cfm/cu%FFsers/list', 'admin:cu\uFFFDsers.list'],
    ['replaces a truncated UTF-8 sequence with U+FFFD', '/admin/index.cfm/cu%C3sers/list', 'admin:cu\uFFFDsers.list'],
    ['decodes a UTF-8 sequence', '/admin/index.cfm/cu%C3%A9sers/list', 'admin:cu\u00E9sers.list'],
  ])('%s', (_label, url, key) => {
    expect(keyOf('GET', url)).toBe(key);
  });
});

describe('X-HTTP-Method-Override', () => {
  it('replaces the request method for an API operation', () => {
    const result = resultOf('POST', `${API}/content/${UUID}`, { headers: { 'x-http-method-override': 'delete' } });
    expect(result.key).toBe('api:content.delete');
    expect(result.httpMethod).toBe('DELETE');
  });

  it('reads an array header value', () => {
    const result = resultOf('POST', `${API}/content/`, { headers: { 'X-HTTP-Method-Override': ['PUT'] } });
    expect(result.key).toBe('api:content.save');
    expect(result.httpMethod).toBe('PUT');
  });

  it('keys a fixture route by the overriding method', () => {
    const headers = { 'X-HTTP-Method-Override': 'PATCH' };
    expect(keyOf('POST', '/legacy-fixtures/cfml/api.cfm/finance/invoices', { headers })).toBe(
      'fixture:finance/invoices@patch',
    );
  });

  it('upper-cases the request method when no override is sent', () => {
    expect(resultOf('get', `${API}/content/`).httpMethod).toBe('GET');
  });

  const FIXTURE = '/legacy-fixtures/cfml/api.cfm/timesheets';
  const SUBMIT_KEY = 'fixture:timesheets/days/{id}/submit';
  it.each<{ name: string; method: string; url: string; override: string | string[]; key: string; httpMethod: string }>([
    { name: 'an empty fixture override as absent', method: 'POST', url: `${FIXTURE}/days/42/submit`, override: '', key: `${SUBMIT_KEY}@post`, httpMethod: 'POST' },
    { name: 'an empty array fixture override as absent', method: 'POST', url: `${FIXTURE}/days/42/submit`, override: [''], key: `${SUBMIT_KEY}@post`, httpMethod: 'POST' },
    { name: 'an empty override on a fixture read as absent', method: 'GET', url: `${FIXTURE}/sheets`, override: '', key: 'fixture:timesheets/sheets@get', httpMethod: 'GET' },
    { name: 'an empty override on an unrouted fixture path as absent', method: 'POST', url: FIXTURE, override: '', key: 'fixture:!notfound@post', httpMethod: 'POST' },
    { name: 'a lower-case fixture override upper-cased', method: 'POST', url: `${FIXTURE}/days/42/submit`, override: 'get', key: `${SUBMIT_KEY}@get`, httpMethod: 'GET' },
    { name: 'a whitespace fixture override untrimmed, as api.cfm reads it', method: 'POST', url: `${FIXTURE}/days/42/submit`, override: ' ', key: `${SUBMIT_KEY}@ `, httpMethod: ' ' },
    { name: 'an empty API override as present, which runs no operation', method: 'POST', url: `${API}/content/`, override: '', key: 'api:content.http-', httpMethod: '' },
  ])('reads $name', ({ method, url, override, key, httpMethod }) => {
    const result = resultOf(method, url, { headers: { 'X-HTTP-Method-Override': override } });
    expect(result.key).toBe(key);
    expect(result.httpMethod).toBe(httpMethod);
  });
});

describe('JSON API parameter merge', () => {
  const sources = { query: { method: 'login' }, form: { method: 'logout' }, jsonBody: { method: 'findCurrentUser' } };

  it.each([
    ['application/json', 'api:findcurrentuser'],
    ['Application/JSON; charset=UTF-8', 'api:findcurrentuser'],
    ['text/plain', 'api:logout'],
    [undefined, 'api:logout'],
  ])('with Content-Type %s takes the method from the last applicable source', (contentType, key) => {
    expect(keyOf('POST', `${API}/`, { ...sources, headers: { 'Content-Type': contentType } })).toBe(key);
  });

  it('uses the query method when no later source sets one', () => {
    expect(keyOf('GET', `${API}/?method=login`)).toBe('api:login');
  });

  it('ignores the JSON content type when the request had no body', () => {
    expect(keyOf('POST', `${API}/`, { query: sources.query, form: sources.form, headers: JSON_TYPE })).toBe('api:logout');
  });

  it('returns simple merged params with lower-cased keys, later sources overwriting earlier ones', () => {
    const result = resultOf('POST', `${API}/content/`, {
      query: { A: 'query', B: 'query' },
      form: { b: 'form', C: 'form' },
      jsonBody: { c: 'body', d: 4, e: null, f: { x: 1 }, g: [1] },
      headers: JSON_TYPE,
    });
    expect(result.key).toBe('api:content.save');
    expect(result.params).toMatchObject({ a: 'query', b: 'form', c: 'body', d: '4', entityname: 'content' });
    expect(result.params).not.toHaveProperty('e');
    expect(result.params).not.toHaveProperty('f');
    expect(result.params).not.toHaveProperty('g');
  });

  // Oracle: a JSON null is undefined to isDefined, param and structKeyExists, so each answers as if the key was never sent.
  it.each<[string, string, Record<string, unknown>, string]>([
    ['a null siteid the site checks skip', `${API}/content`, { siteid: null }, 'api:content.save'],
    ['an empty siteid', `${API}/content`, { siteid: '' }, 'api:!invalidparameters'],
    ['a null muraPointInTime', `${API}/content`, { muraPointInTime: null }, 'api:content.save'],
    ['a null method, which leaves the path method', `${API}/findCrumbArray`, { method: null, entityname: 'content' }, 'api:findcrumbarray'],
    ['a null siteid of a direct method, defaulted to the API site', `${API}/`, { method: 'findOne', entityname: 'content', siteid: null }, 'api:content.findone'],
    ['an empty siteid of a direct method', `${API}/`, { method: 'findOne', entityname: 'content', siteid: '' }, 'api:!invalidparameters'],
  ])('reads %s as legacy does', (_label, url, jsonBody, key) => {
    expect(keyOf('POST', url, { jsonBody, headers: JSON_TYPE }, ONLY_DEFAULT)).toBe(key);
  });

  it('lets a JSON null replace a url value with an undefined key', () => {
    const result = resultOf('POST', `${API}/?siteid=default&id=7`, { jsonBody: { method: 'findOne', entityname: 'content', id: null }, headers: JSON_TYPE }, ONLY_DEFAULT);
    expect(result.key).toBe('api:content.findone');
    expect(result.params).not.toHaveProperty('id');
    expect(result.params).toMatchObject({ siteid: 'default' });
  });

  it('joins repeated query values with commas', () => {
    expect(resultOf('GET', `${API}/content/`, { query: { tag: ['a', 'b'] } }).params.tag).toBe('a,b');
  });

  it('answers server_error for a JSON body that is not an object', () => {
    expect(keyOf('POST', `${API}/`, { jsonBody: [1, 2], headers: JSON_TYPE })).toBe('api:!server_error');
  });

  it('answers server_error when a complex body value is read as the method', () => {
    expect(keyOf('POST', `${API}/content/`, { jsonBody: { method: { name: 'save' } }, headers: JSON_TYPE })).toBe(
      'api:!server_error',
    );
  });

  it('answers server_error for muraPointInTime', () => {
    expect(keyOf('GET', `${API}/content/?muraPointInTime=2024-01-01`)).toBe('api:!server_error');
  });

  it.each<[RouteKeyOptions, string, string, string | undefined]>([
    [{}, '?appreload', 'reload:application', 'api:content.findall'],
    [{}, '?appreload&title=Home', 'reload:application', 'api:content.findquery'],
    [{ appReloadKey: 'Reload' }, '?reload', 'reload:application', 'api:content.findall'],
    [{ appReloadKey: 'Reload' }, '?appreload', 'api:content.findquery', undefined],
  ])('with options %j removes only the reload key from the query %s', (opts, search, key, afterReload) => {
    const result = resultOf('GET', `${API}/content/${search}`, {}, opts);
    expect(result.key).toBe(key);
    expect(result.afterReload?.key).toBe(afterReload);
  });

  it('copies X-csrf_token headers into JSON API params but not into REST params', () => {
    const headers = { 'X-csrf_token': 'T1', 'X-csrf_token_expires': 'E1' };
    expect(resultOf('GET', `${API}/?method=login`, { headers }).params).toMatchObject({
      csrf_token: 'T1',
      csrf_token_expires: 'E1',
    });
    expect(resultOf('GET', '/_api/rest/v1/default/?method=login', { headers }).params).not.toHaveProperty('csrf_token');
  });
});

describe('JSON API method resolution', () => {
  it.each<{ name: string; url: string; opts?: RouteKeyOptions; key: string }>([
    { name: 'the merged method parameter', url: `${API}/?method=login`, key: 'api:login' },
    { name: 'the segment after the site id', url: `${API}/login`, key: 'api:login' },
    { name: 'the first segment', url: '/_api/json/v1/login', opts: ONLY_DEFAULT, key: 'api:login' },
    { name: 'the segment after a site id that is not a variable name', url: '/_api/json/v1/tenant-a/login', key: 'api:login' },
    { name: 'path params after a direct method', url: `${API}/findOne/entityname/user/id/${UUID}`, key: 'api:user.findone' },
    {
      name: 'path params after an entity-route method',
      url: '/_api/json/v1/tenant-a/findOne/entityname/content',
      key: 'api:content.findone',
    },
    { name: 'a defined but non-public method', url: `${API}/?method=getSerializer`, key: 'api:!invalidmethodcall' },
    { name: 'an entity-route local', url: '/_api/json/v1/tenant-a/siteManager', key: 'api:!invalidmethodcall' },
    { name: 'a non-public entity-route method', url: '/_api/json/v1/tenant-a/getSerializer', key: 'api:!invalidmethodcall' },
    { name: 'a method named in path params', url: `${API}/login/method/logout`, key: 'api:!invalidmethodcall' },
    {
      name: 'a direct method a sanitised path name overwrites',
      url: `${API}/login/m!ethod/findAll?entityname=content`,
      key: 'api:content.findall',
    },
    {
      name: 'an entity-route method a sanitised path name overwrites',
      url: `${API}/login/m!ethod/findAll?method=zz&entityname=content`,
      key: 'api:content.findall',
    },
    { name: 'a sanitised path name overwriting with save', url: `${API}/login/m!ethod/save?entityname=user`, key: 'api:user.save' },
    {
      name: 'a sanitised path name overwriting with a non-public method',
      url: `${API}/login/m!ethod/getSerializer`,
      key: 'api:!invalidmethodcall',
    },
    { name: 'a sanitised path name without a value', url: `${API}/login/m!ethod`, key: 'api:!invalidmethodcall' },
    {
      name: 'a public method without a function, falling through to the entity route',
      url: `${API}/content/x/m!ethod/submitForm?method=login`,
      key: 'api:content.findone',
    },
    {
      name: 'a sanitised path name overwriting with a generic method',
      url: `${API}/content/x/m!ethod/findAll?method=login`,
      key: 'api:.findall',
    },
    {
      name: 'an entity-route invoke of a public method without a function',
      url: `${API}/login/m!ethod/submitForm?method=zz`,
      key: 'api:!server_error',
    },
    { name: 'an undefined method name', url: `${API}/?method=noSuchMethod`, key: 'api:entity.findquery' },
    { name: 'neither a method nor an entity', url: `${API}/`, key: 'api:entity.findall' },
    {
      name: 'a plugin-registered method',
      url: `${API}/?method=pluginHello`,
      opts: { registeredMethods: ['pluginHello'] },
      key: 'api:pluginhello',
    },
    { name: 'the ajax endpoint', url: '/_api/ajax/v1/default/content/', key: 'api:content.findall' },
    { name: 'a generic method without an entity', url: `${API}/?method=findAll`, key: 'api:.findall' },
    { name: 'the file scope after a pool site id', url: `/_api/json/v1/umbrella/file/${UUID}`, key: 'api:!invalidmethodcall' },
    { name: 'the file scope before new', url: `${API}/file/new`, key: 'api:!invalidmethodcall' },
    { name: 'the file scope in another case', url: `${API}/File`, key: 'api:!invalidmethodcall' },
    { name: 'the file scope as the first segment', url: '/_api/json/v1/file', opts: ONLY_DEFAULT, key: 'api:!invalidmethodcall' },
    { name: 'the file scope as the method parameter', url: `${API}/?method=file`, key: 'api:!invalidmethodcall' },
    { name: 'the file segment the entity route keeps as its entity', url: `${API}/file?method=zz`, key: 'api:file.findquery' },
    { name: 'the file entity after a site id that is not a variable name', url: '/_api/json/v1/tenant-a/file/new', key: 'api:file.findnew' },
    { name: 'the http built-in after a site id that is not a variable name', url: '/_api/json/v1/tenant-a/http', key: 'api:!invalidmethodcall' },
    { name: 'the http built-in after the site id', url: `${API}/http`, key: 'api:!invalidmethodcall' },
    { name: 'the http built-in on the entity route', url: `${API}/http?method=zz`, key: 'api:!invalidmethodcall' },
    { name: 'findNew of the file entity by parameters', url: `${API}/?method=findNew&entityname=file`, key: 'api:file.findnew' },
    { name: 'the plural file entity path', url: `${API}/files/new`, key: 'api:file.findnew' },
  ])('resolves $name to $key', ({ url, opts, key }) => {
    expect(keyOf('GET', url, {}, opts)).toBe(key);
  });

  it.each(['save', 'delete', 'findOne', 'findMany', 'validate'])(
    'keeps the entity in the generic %s key, so user and content differ',
    (method) => {
      const user = keyOf('POST', `${API}/?method=${method}&entityname=user`);
      const content = keyOf('POST', `${API}/?method=${method}&entityname=content`);
      expect(user).toBe(`api:user.${method.toLowerCase()}`);
      expect(content).toBe(`api:content.${method.toLowerCase()}`);
      expect(user).not.toBe(content);
    },
  );

  it('defines Origin locals only when an Origin header is sent', () => {
    expect(keyOf('GET', `${API}/?method=origin`, { headers: { Origin: 'https://example.test' } })).toBe(
      'api:!invalidmethodcall',
    );
    expect(keyOf('GET', `${API}/?method=origin`)).toBe('api:entity.findquery');
  });

  // ACF's `file` scope makes the name a defined, non-public method ahead of the `file` entity.
  it.each<[string, string, string]>([
    ['GET', `${API}/file`, 'api:!invalidmethodcall'],
    ['GET', `${API}/file/properties`, 'api:!invalidmethodcall'],
    ['GET', `${API}/file/abc`, 'api:!invalidmethodcall'],
    ['GET', `${API}/FILE/new`, 'api:!invalidmethodcall'],
    ['GET', `${API}/?method=file`, 'api:!invalidmethodcall'],
    ['GET', '/_api/json/v1/file', 'api:!invalidmethodcall'],
    ['POST', `${API}/file/`, 'api:!invalidmethodcall'],
    ['GET', `${API}/?method=findProperties&entityname=file`, 'api:file.findproperties'],
    ['GET', `${API}/files/new`, 'api:file.findnew'],
    ['POST', `${API}/?method=save&entityname=file`, 'api:file.save'],
  ])('keys %s %s as %s', (method, url, key) => {
    expect(keyOf(method, url, {}, ONLY_DEFAULT)).toBe(key);
  });

  it.each<[string, string]>([
    ['/_api/json/v1/tenant-a/file/properties', 'api:file.findproperties'],
    ['/_api/json/v1/tenant-a/file', 'api:file.findall'],
    ['/_api/json/v1/tenant-a/?method=file', 'api:!invalidmethodcall'],
  ])('keys %s as %s: a site id that is no variable name skips the direct method, and the entity route skips file', (url, key) => {
    expect(keyOf('GET', url, {}, { siteExists: (siteId) => siteId === 'tenant-a' })).toBe(key);
  });

  it.each<{ name: string; method: string; url: string; form?: Record<string, string>; key: string }>([
    { name: 'an unknown path site', method: 'GET', url: '/_api/json/v1/nosuch/content', key: 'api:!invalidparameters' },
    { name: 'an unknown url siteid', method: 'GET', url: `${API}/content?siteid=nosuch`, key: 'api:!invalidparameters' },
    {
      name: 'an unknown form siteid',
      method: 'POST',
      url: `${API}/content/`,
      form: { siteid: 'nosuch' },
      key: 'api:!invalidparameters',
    },
    {
      name: 'an unknown siteid with a direct method',
      method: 'GET',
      url: `${API}/?method=login&siteid=nosuch`,
      key: 'api:!invalidparameters',
    },
    {
      name: 'an unknown form siteid that path pairs overwrite before the entity route',
      method: 'POST',
      url: `${API}/content/x/m!ethod/submitForm/siteid/default?method=login`,
      form: { siteid: 'nosuch' },
      key: 'api:!invalidparameters',
    },
    { name: 'no site segment', method: 'GET', url: '/_api/json/v1', key: 'api:!invalidparameters' },
  ])('answers invalidparameters for $name', ({ method, url, form, key }) => {
    expect(keyOf(method, url, form === undefined ? {} : { form }, ONLY_DEFAULT)).toBe(key);
  });

  it.each<{ url: string; form?: Record<string, string>; siteId: string }>([
    { url: '/_api/json/v1/nosuch/content', siteId: 'default' },
    { url: '/_api/json/v1/?method=login&siteid=tenant-c', siteId: 'tenant-c' },
    { url: '/_api/json/v1/?method=login&siteid=tenant-c', form: { siteid: 'tenant-b' }, siteId: 'tenant-b' },
    { url: '/_api/json/v1/?method=login', siteId: 'default' },
  ])('reports site $siteId for $url', ({ url, form, siteId }) => {
    const opts = { siteExists: (s: string) => s !== 'nosuch' };
    expect(resultOf('POST', url, form === undefined ? {} : { form }, opts).siteId).toBe(siteId);
  });

  it('propagates a failing site registry instead of keying it as a legacy error', () => {
    const siteExists = (siteId: string): boolean => {
      if (siteId === 'unreachable') throw new Error('site registry unavailable');
      return true;
    };
    expect(() => keyOf('GET', `${API}/content?siteid=unreachable`, {}, { siteExists })).toThrow('site registry unavailable');
  });
});

describe('dotted entity.method', () => {
  it('answers invalidmethodcall for user.save posted to the content path, rewriting the entity as legacy does', () => {
    const result = resultOf('POST', `${API}/content/`, { form: { method: 'user.save' } });
    expect(result.key).toBe('api:!invalidmethodcall');
    expect(result.params).toMatchObject({ entityname: 'user', method: 'save' });
  });

  it('resolves a dotted remote function on the named entity', () => {
    const opts = { entityRemoteFunctions: { content: ['myRemote'] } };
    expect(keyOf('GET', `${API}/?method=content.myRemote`, {}, opts)).toBe('api:content.~myremote');
  });
});

describe('JSON API entity operations', () => {
  it.each([
    ['GET', `${API}/content/`, 'api:content.findall'],
    ['GET', `${API}/content/?title=Home`, 'api:content.findquery'],
    ['GET', `${API}/content/${UUID}`, 'api:content.findone'],
    ['GET', `${API}/content/${UUID}/permissions`, 'api:content.findpermissions'],
    ['GET', `${API}/user/${UUID}/permissions`, 'api:user.findpermissions'],
    ['GET', `${API}/content/${UUID}/relatedcontent`, 'api:content.findrelatedcontent'],
    ['GET', `${API}/content/${UUID}/relatedcontent/sort`, 'api:content.findrelatedcontent'],
    ['GET', `${API}/content/${UUID}/history`, 'api:content.findversionhistory'],
    ['GET', `${API}/content/${UUID}/crumbs`, 'api:content.findcrumbarray'],
    ['GET', `${API}/category/${UUID}/crumbs`, 'api:category.findcrumbarray'],
    ['GET', `${API}/comment/${UUID}/crumbs`, 'api:comment.findcrumbarray'],
    ['GET', `${API}/user/${UUID}/crumbs`, 'api:user.findone'],
    ['GET', `${API}/user/${UUID}/a/b`, 'api:user.findone'],
    ['POST', `${API}/user/${UUID}/a/b`, 'api:user.save'],
    ['DELETE', `${API}/content/${UUID}`, 'api:content.delete'],
    ['POST', `${API}/content/`, 'api:content.save'],
    ['PUT', `${API}/content/`, 'api:content.save'],
    ['PATCH', `${API}/content/`, 'api:content.http-patch'],
    ['GET', `${API}/content/new`, 'api:content.findnew'],
    ['GET', `${API}/user/properties`, 'api:user.findproperties'],
    ['GET', `${API}/group/permissions`, 'api:group.findpermissions'],
    ['GET', `${API}/user/New`, 'api:!invalidmethodcall'],
    ['GET', `${API}/user/01`, 'api:user.findall'],
    ['GET', `${API}/user/2`, 'api:!invalidmethodcall'],
    ['GET', `${API}/user/1.`, 'api:!invalidmethodcall'],
    ['GET', `${API}/user/1.0`, 'api:user.findall'],
    ['GET', `${API}/user/1e0`, 'api:user.findall'],
    ['GET', `${API}/user/2.`, 'api:!invalidmethodcall'],
    ['GET', `${API}/content/?id=new`, 'api:content.findnew'],
    ['GET', `${API}/content/?id=properties`, 'api:content.findproperties'],
    ['GET', `${API}/content/?id=permissions`, 'api:content.findpermissions'],
    ['GET', `${API}/content/?id=a,b`, 'api:content.findmany'],
    ['GET', `${API}/content/?id=${UUID}`, 'api:content.findone'],
    ['GET', `${API}/content/?id=00000000000000000000000000000000001`, 'api:content.findone'],
    ['GET', `${API}/content/?id=1`, 'api:content.findone'],
    ['GET', `${API}/content/?id=about`, 'api:content.findone'],
    ['GET', `${API}/content/?contenthistid=H1`, 'api:content.findone'],
    ['GET', `${API}/user/?userid=U1`, 'api:user.findone'],
    ['POST', `${API}/user/?userid=U1`, 'api:user.save'],
    ['GET', `${API}/site`, 'api:site.findone'],
    ['POST', `${API}/site`, 'api:site.save'],
    ['POST', `${API}/site/default`, 'api:site.findone'],
    ['GET', `${API}/users`, 'api:user.findall'],
    ['GET', `${API}/groups`, 'api:group.findall'],
    ['GET', `${API}/contentnav`, 'api:content.findall'],
    ['GET', `${API}/contentnavs`, 'api:content.findall'],
    ['GET', `${API}/widgets`, 'api:widgets.findall'],
    ['GET', `${API}/9lives`, 'api:!invalidentitycall'],
    ['GET', `${API}/user/username/admin`, 'api:user.findall'],
    ['GET', `${API}/user/entityname/group`, 'api:group.findall'],
    ['GET', `${API}/content/_path/about/us`, 'api:content.findone'],
  ])('keys %s %s to %s', (method, url, key) => {
    expect(keyOf(method, url)).toBe(key);
  });

  it.each([
    [`${API}/content/_path/about/us`, { render: 'true', variation: 'false', id: 'about/us' }],
    [`${API}/content/_variation/promo`, { render: 'true', variation: 'true', id: 'promo' }],
    [`${API}/content/about`, { id: 'about/about' }],
    [`${API}/content/?contenthistid=H1`, { id: 'H1' }],
    [`${API}/user/?userid=U1`, { id: 'U1', type: '2' }],
    [`${API}/user/username/admin`, { username: 'admin', type: '2' }],
    [`${API}/groups`, { entityname: 'group', type: '1' }],
    [`${API}/contentnav`, { entityname: 'content', entityconfigname: 'contentnav' }],
  ])('derives the params of %s as legacy does', (url, params) => {
    expect(resultOf('GET', url).params).toMatchObject(params);
  });

  it.each<[RouteKeyOptions, string, string]>([
    [{ entityRemoteFunctions: { user: ['sendLogin'] } }, `${API}/user/${UUID}/sendLogin`, 'api:user.~sendlogin'],
    [{ entityRelationships: { content: ['kids'] } }, `${API}/content/${UUID}/kids`, 'api:content.~kids'],
    [{ entityRemoteFunctions: { user: ['sendLogin'] } }, `${API}/user/sendLogin`, 'api:user.~sendlogin'],
    [{ entityRemoteFunctions: { user: ['sendLogin'] } }, `${API}/user/?id=sendLogin`, 'api:user.~sendlogin'],
    [{ variationsEnabled: true }, `${API}/variationTargetings`, 'api:variationtargeting.findall'],
    [{}, `${API}/variationTargetings`, 'api:variationtargeting.findall'],
    [{ knownEntities: ['widget'] }, `${API}/widgets`, 'api:widget.findall'],
    [
      { knownEntities: ['widget'], entityPrimaryKeys: { widget: 'widgetId' } },
      `${API}/widget?widgetid=W1`,
      'api:widget.findone',
    ],
    [{ knownEntities: ['widget'] }, `${API}/widget?widgetid=W1`, 'api:widget.findquery'],
  ])('with registries %j keys %s to %s', (opts, url, key) => {
    expect(keyOf('GET', url, {}, opts)).toBe(key);
  });
});

describe('REST credentials', () => {
  it.each([
    ['/_api/rest/v1/default/content/', 'rest:content.findall'],
    ['/_api/rest/v1/default/oauth', 'rest:oauth'],
    ['/_api/rest/v1/default/oauth2', 'rest:oauth2'],
    ['/_api/rest/v1/oauth/token', 'rest:oauth'],
    ['/_api/rest/v1/default/oauth2/authorize', 'rest:oauth2'],
    ['/_api/rest/v1/default/oauth/tokeninfo?access_token=T1&client_id=C1', 'rest:tokeninfo'],
    ['/_api/rest/v1/oauth/tokeninfo?access_token=T1&client_id=C1', 'rest:tokeninfo'],
    ['/_api/rest/v1/default/oauth/tokeninfo?access_token=T1', 'rest:!invalidmethodcall'],
  ])('keys %s to %s', (url, key) => {
    expect(keyOf('GET', url)).toBe(key);
  });

  it('drops a URL access_token, so the query no longer counts towards findQuery', () => {
    const result = resultOf('GET', '/_api/rest/v1/default/content?access_token=T1');
    expect(result.key).toBe('rest:content.findall');
    expect(result.params).not.toHaveProperty('access_token');
  });

  it('defines the token locals only when an Authorization header is sent', () => {
    const url = '/_api/rest/v1/default/?method=tokentype';
    expect(keyOf('GET', url, { headers: { Authorization: 'Bearer T1' } })).toBe('rest:!invalidmethodcall');
    expect(keyOf('GET', url)).toBe('rest:entity.findquery');
  });

  it('defines isBasicAuth in REST mode only', () => {
    expect(keyOf('GET', '/_api/rest/v1/default/?method=isBasicAuth')).toBe('rest:!invalidmethodcall');
    expect(keyOf('GET', `${API}/?method=isBasicAuth`)).toBe('api:entity.findquery');
  });

  it('lets direct Basic credentials skip the OAuth endpoints', () => {
    const result = resultOf('GET', '/_api/rest/v1/default/oauth', { headers: { Authorization: basicAuth('admin', 'pw') } });
    expect(result.key).toBe('rest:oauth.findall');
    expect(result.params).not.toHaveProperty('client_id');
    expect(result.params).not.toHaveProperty('client_secret');
  });

  it('keeps Basic client credentials with a uuid client id for the OAuth endpoint', () => {
    const result = resultOf('GET', '/_api/rest/v1/default/oauth', { headers: { Authorization: basicAuth(UUID, 'pw') } });
    expect(result.key).toBe('rest:oauth');
    expect(result.params).toMatchObject({ client_id: UUID, client_secret: 'pw' });
  });

  it('reads client credentials from X- headers', () => {
    const headers = { 'X-client-id': 'C1', 'X-client_secret': 'S1' };
    const result = resultOf('GET', '/_api/rest/v1/default/oauth', { headers });
    expect(result.key).toBe('rest:oauth');
    expect(result.params).toMatchObject({ client_id: 'C1', client_secret: 'S1' });
  });

  it('resolves past the OAuth endpoints when an access token header is sent', () => {
    expect(keyOf('GET', '/_api/rest/v1/default/oauth', { headers: { 'X-access-token': 'T1' } })).toBe(
      'rest:oauth.findall',
    );
  });

  it('ignores an Authorization scheme other than Basic and Bearer', () => {
    expect(keyOf('GET', '/_api/rest/v1/default/oauth', { headers: { Authorization: 'Digest abc' } })).toBe('rest:oauth');
  });
});

describe('consumed REST credentials', () => {
  it.each<[string, string, string | string[] | undefined, string, Record<string, string>, string[]]>([
    ['client credentials from params, the URL still counting towards findQuery', '/_api/rest/v1/default/group?client_id=C1', 'client_id,client_secret', 'rest:group.findquery', {}, ['client_id']],
    ['names in any case, spaced and repeated', '/_api/rest/v1/default/group?client_id=C1&Client_Secret=S1&x=1', ['CLIENT_ID', ' client_secret '], 'rest:group.findquery', { x: '1' }, ['client_id', 'client_secret']],
    ['a refresh token', '/_api/rest/v1/default/group?refresh_token=R1&x=1', 'refresh_token', 'rest:group.findquery', { x: '1' }, ['refresh_token']],
    ['an access token the credential block already deleted', '/_api/rest/v1/default/group?access_token=T1', 'access_token', 'rest:group.findall', {}, ['access_token']],
    ['nothing for names that are not credentials', '/_api/rest/v1/default/group?client_id=C1', 'method,siteid,entityname,x', 'rest:group.findquery', { client_id: 'C1' }, []],
    ['nothing without the header', '/_api/rest/v1/default/group?client_id=C1', undefined, 'rest:group.findquery', { client_id: 'C1' }, []],
  ])('removes %s', (_label, url, consumed, key, kept, removed) => {
    const headers = consumed === undefined ? {} : { [REST_CONSUMED_PARAMS_HEADER]: consumed };
    const result = resultOf('GET', url, { headers });
    expect(result.key).toBe(key);
    expect(result.params).toMatchObject(kept);
    for (const name of removed) expect(result.params).not.toHaveProperty(name);
    expect(result.params).toMatchObject({ entityname: 'group', siteid: 'default' });
  });

  it('removes them from form and JSON body params too', () => {
    const form = resultOf('POST', '/_api/rest/v1/default/group', {
      form: { client_id: 'C1', groupname: 'G' },
      headers: { 'x-opt2-consumed-params': 'client_id' },
    });
    const json = resultOf('POST', '/_api/rest/v1/default/group', {
      jsonBody: { client_secret: 'S1', groupname: 'G' },
      headers: { ...JSON_TYPE, 'x-opt2-consumed-params': 'client_secret' },
    });
    for (const result of [form, json]) {
      expect(result.key).toBe('rest:group.save');
      expect(result.params).toMatchObject({ groupname: 'G' });
      expect(result.params).not.toHaveProperty('client_id');
      expect(result.params).not.toHaveProperty('client_secret');
    }
  });

  it('cannot steer method, entity or site resolution', () => {
    const url = '/_api/rest/v1/default/?method=findAll&entityname=group&siteid=default';
    const steered = resultOf('GET', url, { headers: { [REST_CONSUMED_PARAMS_HEADER]: 'method,entityname,siteid' } });
    expect(steered).toEqual(resultOf('GET', url));
    expect(steered.params).toMatchObject({ method: 'findAll', entityname: 'group', siteid: 'default' });
  });

  it.each([
    ['an OAuth endpoint the credential block answers', 'GET', '/_api/rest/v1/default/oauth?client_id=C1', 'rest:oauth'],
    ['the JSON API family', 'GET', `${API}/group?client_id=C1`, 'api:group.findquery'],
  ])('leaves params alone on %s', (_label, method, url, key) => {
    const result = resultOf(method, url, { headers: { [REST_CONSUMED_PARAMS_HEADER]: 'client_id' } });
    expect(result.key).toBe(key);
    expect(result.params).toMatchObject({ client_id: 'C1' });
  });
});

describe('other /_api families', () => {
  it.each<{ url: string; opts?: RouteKeyOptions; key: string }>([
    { url: '/_api/feed/v1/?feedid=F1&siteid=default', key: 'feed:v1' },
    { url: '/tasks/feed/?feedid=F1', key: 'feed:v1' },
    { url: '/_api/feed/v1/', key: 'apiother:/_api/feed/v1/' },
    { url: '/_api/resource/variation?siteid=default', opts: { variationsEnabled: true }, key: 'variation:js' },
    { url: '/_api/resource/variation?siteid=default', key: 'apiother:/_api/resource/variation' },
    { url: '/_api/email/trackopen?emailid=E1', key: 'trackopen:open' },
    { url: '/_api/render/small/?fileid=F1', key: 'render:small' },
    { url: '/_api/render/medium/?fileid=F1', key: 'render:medium' },
    { url: '/_api/render/file/?fileid=F1', key: 'render:file' },
    { url: '/_api/render/file/?fileid=F1&size=Small', key: 'render:small' },
    { url: '/_api/render/?fileid=F1&size=small', key: 'render:!server_error' },
    { url: '/tasks/render/file/?fileid=F1', key: 'render:file' },
    { url: '/_api/render/small/', key: 'apiother:/_api/render/small/' },
    { url: '/_api/sitemonitor', key: 'sitemonitor:run' },
    { url: '/_API/SiteMonitor/?ping=1', key: 'sitemonitor:run' },
    { url: '/tasks/widgets/rss', key: 'widgets:redirect' },
    { url: '/_api/asset/upload', key: 'asset:upload' },
    { url: '/_api/asset/image/logo.png', key: 'asset:render' },
    { url: '/_api/asset/file?action=Upload', key: 'asset:upload' },
    { url: '/_api/asset/?action=upload', key: 'asset:!server_error' },
    { url: '/_api/other/thing', key: 'apiother:/_api/other/thing' },
    { url: '/tasks/unknown', key: 'apiother:/tasks/unknown' },
  ])('keys $url to $key', ({ url, opts, key }) => {
    const result = resultOf('GET', url, {}, opts);
    expect(result.key).toBe(key);
    expect(ROUTE_FAMILIES).toContain(result.family);
    expect(key.startsWith(`${result.family}:`)).toBe(true);
  });

  it('reports the feed site from the query', () => {
    expect(resultOf('GET', '/_api/feed/v1/?feedid=F1&siteid=tenant-a').siteId).toBe('tenant-a');
  });
});

describe('admin actions', () => {
  it.each<{ name: string; url: string; form?: Record<string, string>; opts?: RouteKeyOptions; key: string }>([
    { name: 'a request without an action', url: '/admin/', key: 'admin:home.redirect' },
    { name: 'the admin dir without a slash', url: '/admin', key: 'admin:home.redirect' },
    { name: 'the admin index.cfm', url: '/admin/index.cfm', key: 'admin:home.redirect' },
    { name: 'a URL muraAction', url: '/admin/?muraAction=cUsers.list', key: 'admin:cusers.list' },
    {
      name: 'a URL fuseaction over a URL muraAction',
      url: '/admin/?fuseaction=cSettings.list&muraAction=cUsers.list',
      key: 'admin:csettings.list',
    },
    {
      name: 'a form fuseaction over a URL muraAction',
      url: '/admin/?muraAction=cUsers.list',
      form: { fuseaction: 'cSettings.list' },
      key: 'admin:csettings.list',
    },
    {
      name: 'a form muraAction over a URL fuseaction',
      url: '/admin/?fuseaction=cSettings.list',
      form: { muraAction: 'cUsers.list' },
      key: 'admin:cusers.list',
    },
    {
      name: 'a URL action over the path action',
      url: '/admin/index.cfm/cArch/list?muraAction=cUsers.list',
      key: 'admin:cusers.list',
    },
    { name: 'a path action with a trailing slash', url: '/admin/index.cfm/cUsers/list/', key: 'admin:cusers.list' },
    { name: 'the core subsystem', url: '/admin/?muraAction=core:cUsers.list', key: 'admin:cusers.list' },
    { name: 'another subsystem', url: '/admin/?muraAction=pluginX:Main.Go', key: 'admin:pluginx:main.go' },
    { name: 'a section without an item', url: '/admin/?muraAction=cUsers', key: 'admin:cusers.default' },
    { name: 'an item without a section', url: '/admin/?muraAction=.list', key: 'admin:main.list' },
    { name: 'an empty action', url: '/admin/?muraAction=', key: 'admin:main.default' },
    { name: 'a subsystem without an action', url: '/admin/?muraAction=sub:', key: 'admin:sub:main.default' },
    { name: 'more than two action parts', url: '/admin/?muraAction=a.b.c', key: 'admin:a.c' },
    { name: 'an action containing a slash', url: '/admin/?muraAction=cUsers/list', key: 'admin:!actioncontainsslash' },
    {
      name: 'a configured admin dir',
      url: '/manage/?muraAction=cUsers.list',
      opts: { adminDir: '/manage' },
      key: 'admin:cusers.list',
    },
    {
      name: 'the default dir under another admin dir',
      url: '/admin/?muraAction=cUsers.list',
      opts: { adminDir: '/manage' },
      key: 'page:render',
    },
    {
      name: 'an empty admin dir as the default',
      url: '/admin/?muraAction=cUsers.list',
      opts: { adminDir: '' },
      key: 'admin:cusers.list',
    },
    { name: 'an admin asset', url: '/admin/assets/js/admin.js', key: 'static:/admin/assets/js/admin.js' },
    { name: 'an admin template', url: '/admin/custom.cfm', key: 'cfm:/admin/custom.cfm' },
  ])('keys $name as $key', ({ url, form, opts, key }) => {
    expect(keyOf(form === undefined ? 'GET' : 'POST', url, form === undefined ? {} : { form }, opts)).toBe(key);
  });

  it('reads path pairs as params and lets URL and form values overwrite them', () => {
    const url = '/admin/index.cfm/cUsers/editUser/userID/PATH/siteid/default/flag';
    const fromPath = resultOf('GET', url);
    expect(fromPath.key).toBe('admin:cusers.edituser');
    expect(fromPath.params).toMatchObject({ userid: 'PATH', siteid: 'default', flag: '' });
    expect(fromPath.siteId).toBe('default');
    const overwritten = resultOf('POST', `${url}?userid=URL&siteid=tenant-a`, { form: { userid: 'FORM' } });
    expect(overwritten.params).toMatchObject({ userid: 'FORM', siteid: 'tenant-a' });
    expect(overwritten.siteId).toBe('tenant-a');
  });
});

describe('remote CFC proxies, fixtures and path families', () => {
  it.each<{ method: string; url: string; extra?: Partial<RouteKeyRequest>; key: string }>([
    {
      method: 'POST',
      url: '/core/mura/remote.cfc?method=other',
      extra: { form: { method: 'doThing' } },
      key: 'cfc:/core/mura/remote.cfc?method=other',
    },
    {
      method: 'POST',
      url: '/core/mura/remote.cfc',
      extra: { form: { method: 'doThing' } },
      key: 'cfc:/core/mura/remote.cfc?method=dothing',
    },
    { method: 'GET', url: '/core/mura/remote.cfc?method=doThing', key: 'cfc:/core/mura/remote.cfc?method=dothing' },
    { method: 'GET', url: '/core/mura/remote.cfc', key: 'cfc:/core/mura/remote.cfc' },
    { method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/finance/invoices', key: 'fixture:finance/invoices@get' },
    {
      method: 'POST',
      url: '/legacy-fixtures/cfml/api.cfm/finance/invoices/42/submit',
      key: 'fixture:finance/invoices/{id}/submit@post',
    },
    {
      method: 'PUT',
      url: `/legacy-fixtures/cfml/api.cfm/esign/envelopes/${UUID}/signers/${RFC_UUID}`,
      key: 'fixture:esign/envelopes/{id}/signers/{id}@put',
    },
    { method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/finance', key: 'fixture:!notfound@get' },
    { method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/', key: 'fixture:!notfound@get' },
    { method: 'GET', url: '/legacy-fixtures/cfml/seed.cfm', key: 'cfm:/legacy-fixtures/cfml/seed.cfm' },
    { method: 'GET', url: '/core/assets/css/Admin.CSS', key: 'static:/core/assets/css/admin.css' },
    { method: 'GET', url: '/opt2/stub/items', key: 'opt2:/opt2/stub/items' },
    { method: 'GET', url: '/gateway/legacy-bridge/session.cfm', key: 'bridge:/gateway/legacy-bridge/session.cfm' },
  ])('keys $method $url to $key', ({ method, url, extra, key }) => {
    const result = resultOf(method, url, extra);
    expect(result.key).toBe(key);
    expect(ROUTE_FAMILIES).toContain(result.family);
  });

  it.each(Object.entries(SYNTHETIC_V1_PREFIXES).flatMap(([service, prefixes]) => prefixes.map((prefix) => [service, prefix])))(
    "keys %s's own %s namespace in the opt2 family, in any case and below it",
    (_service, prefix) => {
      for (const url of [prefix, `${prefix}/`, `${prefix.toUpperCase()}/A/B?siteid=tenant-a`]) {
        const result = resultOf('POST', url);
        expect(result.key, url).toBe(`opt2:${(url.split('?')[0] ?? '').toLowerCase()}`);
        expect(result.family).toBe('opt2');
      }
    },
  );

  it.each([
    ['a synthetic prefix with a suffix', '/v1/messagesx'],
    ['a file under a synthetic prefix name', '/v1/finance.json'],
    ['a migrated service /v1/ path', '/v1/users/x'],
    ['an unknown /v1/ path', '/v1/other/x'],
    ['the bare /v1/ path', '/v1/'],
    ['a synthetic name outside /v1/', '/v2/finance/records'],
  ])('keeps %s (%s) out of the opt2 family', (_label, url) => {
    expect(resultOf('GET', url).family).not.toBe('opt2');
  });

  it.each<{ name: string; url: string; form?: Record<string, string>; query?: Record<string, string[]>; siteId: string | undefined }>([
    { name: 'a synthetic /v1/ query siteid', url: '/v1/timesheets/sheets?siteid=tenant-a', siteId: 'tenant-a' },
    { name: 'a synthetic /v1/ form siteid over the query one', url: '/v1/messages?siteid=tenant-a', form: { siteid: 'tenant-b' }, siteId: 'tenant-b' },
    { name: 'a query siteid', url: '/opt2/admin/reporting/exports?siteid=tenant-a', siteId: 'tenant-a' },
    { name: 'any spelling of the name, value as sent', url: '/opt2/admin/reporting/exports?SiteID=Tenant-A', siteId: 'Tenant-A' },
    {
      name: 'a form siteid over the query one',
      url: '/opt2/admin-actions/reporting/create?siteid=tenant-a',
      form: { SITEID: 'tenant-b' },
      siteId: 'tenant-b',
    },
    {
      name: 'repeated query values, comma-joined',
      url: '/opt2/stub/notes',
      query: { siteid: ['tenant-a', 'tenant-b'] },
      siteId: 'tenant-a,tenant-b',
    },
    { name: 'an empty siteid', url: '/opt2/admin/reporting/exports?siteid=', siteId: '' },
    { name: 'no siteid', url: '/opt2/admin/reporting/exports?page=2', siteId: undefined },
  ])('reads the OPT-2 request site from $name, leaving the key unchanged', ({ url, form, query, siteId }) => {
    const extra: Partial<RouteKeyRequest> = {};
    if (form !== undefined) extra.form = form;
    if (query !== undefined) extra.query = query;
    const result = resultOf(form === undefined ? 'GET' : 'POST', url, extra);
    expect(result.key).toBe(`opt2:${(url.split('?')[0] ?? '').toLowerCase()}`);
    expect(result.siteId).toBe(siteId);
    expect(Object.hasOwn(result, 'siteId')).toBe(siteId !== undefined);
  });

  it.each<{ name: string; url: string; form?: Record<string, string>; siteId: string | undefined }>([
    { name: 'a form siteid', url: '/core/modules/v1/comments/ajax/commentsProxy.cfc', form: { method: 'get', SiteID: 'tenant-a' }, siteId: 'tenant-a' },
    {
      name: 'a url siteid over the form one',
      url: '/core/modules/v1/comments/ajax/commentsProxy.cfc?siteid=tenant-a',
      form: { method: 'get', siteid: 'tenant-b' },
      siteId: 'tenant-a',
    },
    { name: 'no siteid', url: '/core/modules/v1/comments/ajax/commentsProxy.cfc?method=get', siteId: undefined },
  ])('reads a remote CFC call site from $name, as ColdFusion binds the argument', ({ url, form, siteId }) => {
    const result = resultOf(form === undefined ? 'GET' : 'POST', url, form === undefined ? {} : { form });
    expect(result.key).toBe('cfc:/core/modules/v1/comments/ajax/commentsproxy.cfc?method=get');
    expect(result.siteId).toBe(siteId);
    expect(Object.hasOwn(result, 'siteId')).toBe(siteId !== undefined);
  });

  const RATER = '/core/modules/v1/rater/ajax/saveRate.cfm';
  const FAVORITES = '/core/modules/v1/favorites/ajax';
  it.each<{ name: string; url: string; form?: Record<string, string>; siteId: string | undefined }>([
    { name: 'the rater form siteID', url: RATER, form: { SiteID: 'tenant-a', rate: '5' }, siteId: 'tenant-a' },
    { name: 'the rater form siteID over the query one', url: `${RATER}?siteid=default`, form: { siteID: 'tenant-a' }, siteId: 'tenant-a' },
    { name: 'no rater form siteID, ignoring the query one', url: `${RATER}?siteid=tenant-a`, form: { rate: '5' }, siteId: undefined },
    { name: 'the rater path in any case', url: '/CORE/modules/v1/rater/ajax/SAVERATE.cfm', form: { siteid: 'tenant-a' }, siteId: 'tenant-a' },
    { name: 'the favorite query siteID', url: `${FAVORITES}/saveFavorite.cfm?siteID=tenant-a&userID=U`, siteId: 'tenant-a' },
    {
      name: 'the favorite query siteID over the form one',
      url: `${FAVORITES}/saveFavorite.cfm?siteid=tenant-a`,
      form: { siteid: 'tenant-b' },
      siteId: 'tenant-a',
    },
    { name: 'no favorite query siteID, ignoring the form one', url: `${FAVORITES}/saveFavorite.cfm`, form: { siteid: 'tenant-b' }, siteId: undefined },
    { name: 'the RSS favorite query siteID', url: `${FAVORITES}/deleteRSSFavorite.cfm?userID=U&siteID=tenant-b`, siteId: 'tenant-b' },
    { name: 'a favorite delete, which binds no site', url: `${FAVORITES}/deleteFavorite.cfm?favoriteID=F&siteid=tenant-a`, siteId: undefined },
    { name: 'a template that binds no listed site', url: '/admin/custom.cfm?siteid=tenant-a', siteId: undefined },
  ])('reads a template site from $name, leaving the key unchanged', ({ url, form, siteId }) => {
    const result = resultOf(form === undefined ? 'GET' : 'POST', url, form === undefined ? {} : { form });
    expect(result.key).toBe(`cfm:${(url.split('?')[0] ?? '').toLowerCase()}`);
    expect(result.siteId).toBe(siteId);
    expect(Object.hasOwn(result, 'siteId')).toBe(siteId !== undefined);
  });

  it('merges a fixture JSON body over query and form params', () => {
    const result = resultOf('POST', '/legacy-fixtures/cfml/api.cfm/finance/invoices?q=1&amount=1', {
      form: { note: 'form' },
      jsonBody: { amount: 5 },
    });
    expect(result.params).toMatchObject({ q: '1', note: 'form', amount: '5' });
  });

  const FIXTURE_RECORDS = '/legacy-fixtures/cfml/api.cfm/finance/records';
  it.each<{ name: string; method: string; url: string; extra: Partial<RouteKeyRequest>; key: string }>([
    { name: 'a JSON null on a collection POST', method: 'POST', url: '/legacy-fixtures/cfml/api.cfm/surveys/surveys', extra: { jsonBody: null, headers: JSON_TYPE }, key: 'fixture:!server_error@post' },
    { name: 'a JSON null on a GET', method: 'GET', url: `${FIXTURE_RECORDS}/${UUID}`, extra: { jsonBody: null, headers: JSON_TYPE }, key: 'fixture:!server_error@get' },
    { name: 'a JSON null on an unrouted path', method: 'POST', url: '/legacy-fixtures/cfml/api.cfm/finance', extra: { jsonBody: null, headers: JSON_TYPE }, key: 'fixture:!server_error@post' },
    { name: 'a JSON null on the bare script', method: 'GET', url: '/legacy-fixtures/cfml/api.cfm', extra: { jsonBody: null, headers: JSON_TYPE }, key: 'fixture:!server_error@get' },
    {
      name: 'a JSON null under a parameterised, mixed-case JSON type and an override',
      method: 'POST',
      url: FIXTURE_RECORDS,
      extra: { jsonBody: null, headers: { 'content-type': 'Application/JSON; charset=UTF-8', 'X-HTTP-Method-Override': 'put' } },
      key: 'fixture:!server_error@put',
    },
    { name: 'a JSON object', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: { title: 'T' }, headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
    { name: 'a JSON array', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: [1, 2], headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
    { name: 'a JSON string', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: 'null', headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
    { name: 'a JSON number', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: 0, headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
    { name: 'a JSON false', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: false, headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
    { name: 'a JSON array on an unrouted path', method: 'POST', url: '/legacy-fixtures/cfml/api.cfm/finance', extra: { jsonBody: [], headers: JSON_TYPE }, key: 'fixture:!notfound@post' },
    { name: 'a null body under a text type', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: null, headers: { 'Content-Type': 'text/plain' } }, key: 'fixture:finance/records@post' },
    { name: 'a null body under a type shorter than the JSON prefix', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: null, headers: { 'Content-Type': 'application/jso' } }, key: 'fixture:finance/records@post' },
    { name: 'a null body without a type', method: 'POST', url: FIXTURE_RECORDS, extra: { jsonBody: null }, key: 'fixture:finance/records@post' },
    { name: 'a JSON type without a parsed body', method: 'POST', url: FIXTURE_RECORDS, extra: { headers: JSON_TYPE }, key: 'fixture:finance/records@post' },
  ])('keys a fixture request with $name as api.cfm merges its body', ({ method, url, extra, key }) => {
    const result = resultOf(method, url, extra);
    expect([result.family, result.key]).toEqual(['fixture', key]);
  });

  const ARCHIVE = `/legacy-fixtures/cfml/api.cfm/people/persons/${UUID}/archive`;
  it.each<{ name: string; url: string; extra?: Partial<RouteKeyRequest>; siteId: string | undefined; key?: string }>([
    { name: 'a query siteid', url: `${ARCHIVE}?siteid=tenant-a`, siteId: 'tenant-a' },
    { name: 'a form siteid over the query one', url: `${ARCHIVE}?siteid=tenant-b`, extra: { form: { SiteID: 'tenant-a' } }, siteId: 'tenant-a' },
    {
      name: 'a JSON body siteid over the form one',
      url: ARCHIVE,
      extra: { form: { siteid: 'tenant-b' }, jsonBody: { siteid: 'tenant-a' }, headers: JSON_TYPE },
      siteId: 'tenant-a',
    },
    { name: 'a numeric JSON siteid, as its string', url: ARCHIVE, extra: { jsonBody: { siteid: 7 }, headers: JSON_TYPE }, siteId: '7' },
    {
      name: 'a complex JSON siteid over the query one, as no site',
      url: `${ARCHIVE}?siteid=tenant-b`,
      extra: { jsonBody: { siteid: { id: 'tenant-a' } }, headers: JSON_TYPE },
      siteId: undefined,
    },
    { name: 'an empty siteid', url: `${ARCHIVE}?siteid=`, siteId: '' },
    { name: 'no siteid', url: ARCHIVE, siteId: undefined },
    { name: 'an unrouted fixture path', url: '/legacy-fixtures/cfml/api.cfm/people?siteid=tenant-a', siteId: 'tenant-a', key: 'fixture:!notfound@post' },
  ])('reads the fixture request site from $name, leaving the key unchanged', ({ url, extra, siteId, key }) => {
    const result = resultOf('POST', url, extra);
    expect(result.key).toBe(key ?? 'fixture:people/persons/{id}/archive@post');
    expect(result.siteId).toBe(siteId);
    expect(Object.hasOwn(result, 'siteId')).toBe(siteId !== undefined);
  });

  const RECORDS = '/legacy-fixtures/cfml/api.cfm/finance/records';
  const RECORDS_KEY = 'fixture:finance/records@get';
  const ID_KEY = 'fixture:finance/records/{id}@get';
  // The container answers these paths itself, before api.cfm runs; keyed as the template, never as a fixture folder file.
  const API_CFM_KEY = 'cfm:/legacy-fixtures/cfml/api.cfm';
  it.each<[string, string, string, string | undefined, RouteKeyOptions?]>([
    ['the canonical spelling', RECORDS, RECORDS_KEY, RECORDS],
    ['a doubled slash before the directory', '//legacy-fixtures/cfml/api.cfm/finance/records', RECORDS_KEY, RECORDS],
    ['a doubled slash between directories', '/legacy-fixtures//cfml/api.cfm/finance/records', RECORDS_KEY, RECORDS],
    ['doubled slashes in path_info', '/legacy-fixtures/cfml/api.cfm//finance//records', RECORDS_KEY, RECORDS],
    ['an upper-case module and resource, which api.cfm lower-cases', '/legacy-fixtures/cfml/api.cfm/FINANCE/RECORDS', RECORDS_KEY, RECORDS],
    ['an encoded slash in path_info, which splits it', '/legacy-fixtures/cfml/api.cfm/finance%2Frecords', RECORDS_KEY, RECORDS],
    ['an encoded script name', '/legacy-fixtures/cfml/%61pi.cfm/finance/records', RECORDS_KEY, RECORDS],
    ['a directory path parameter', '/legacy-fixtures;x=1/cfml/api.cfm/finance/records', RECORDS_KEY, RECORDS],
    ['a doubled slash after the context', '/masa//legacy-fixtures/cfml/api.cfm/FINANCE/records', RECORDS_KEY, RECORDS, { context: '/masa' }],
    ['a path_info path parameter, which api.cfm reads as part of the module', '/legacy-fixtures/cfml/api.cfm/finance;x=1/records', 'fixture:finance;x=1/records@get', '/legacy-fixtures/cfml/api.cfm/finance%3Bx%3D1/records'],
    ['index.cfm as path_info, which api.cfm reads as the resource', '/legacy-fixtures/cfml/api.cfm/finance/index.cfm/records', 'fixture:finance/index.cfm/{id}@get', '/legacy-fixtures/cfml/api.cfm/finance/index.cfm/records'],
    ['the bare script, which api.cfm serves with no path_info', '/legacy-fixtures/cfml/api.cfm', 'fixture:!notfound@get', '/legacy-fixtures/cfml/api.cfm/'],
    ['a `..` closing the last item', `${RECORDS}/x..`, ID_KEY, `${RECORDS}/x..`],
    ['a `..` closing an id before an action', `${RECORDS}/x../versions`, 'fixture:finance/records/{id}/versions@get', `${RECORDS}/x../versions`],
    ['an encoded backslash inside an id', `${RECORDS}/a%5C..%5Cb`, ID_KEY, `${RECORDS}/a%5C..%5Cb`],
    ['an encoded slash before a dot-led item, which the container leaves encoded', `${RECORDS}/x%2F.y`, 'fixture:finance/records/{id}/.y@get', `${RECORDS}/x/.y`],
    ['an encoded slash before a sensitive file name', `${RECORDS}/x%2Fweb.config`, 'fixture:finance/records/{id}/web.config@get', `${RECORDS}/x/web.config`],
    ['a path parameter hiding a dot', `${RECORDS}/;.y`, ID_KEY, `${RECORDS}/%3B.y`],
    ['an Axis suffix followed by more', `${RECORDS}/x.jwsx`, ID_KEY, `${RECORDS}/x.jwsx`],
    ['an encoded semicolon, which the container keeps', `${RECORDS}/x.jws%3Ba`, ID_KEY, `${RECORDS}/x.jws%3Ba`],
    ['a script path parameter, which names no script', '/legacy-fixtures/cfml/api.cfm;x=1/finance/records', 'page:render', undefined],
    ['an encoded slash between directories, which separates nothing', '/legacy-fixtures%2Fcfml/api.cfm/finance/records', 'page:render', undefined],
    ['a dot-dot segment, which the container refuses', '/legacy-fixtures/cfml/api.cfm/finance/../finance/records', 'page:render', undefined],
    ['an encoded dot-dot segment', '/legacy-fixtures/cfml/api.cfm/finance/%2e%2E/finance/records', 'page:render', undefined],
    ['a dot-dot directory segment', '/legacy-fixtures/../legacy-fixtures/cfml/api.cfm/finance/records', 'page:render', undefined],
    ['a dot directory segment', '/legacy-fixtures/cfml/./api.cfm/finance/records', 'page:render', undefined],
    ['an encoded dot directory segment', '/legacy-fixtures/%2E/cfml/api.cfm/finance/records', 'page:render', undefined],
    ['an encoded dot id', `${RECORDS}/%2e`, 'page:render', undefined],
    ['a dot-led id', `${RECORDS}/.x`, API_CFM_KEY, undefined],
    ['a path parameter segment before a dot-led one', `${RECORDS}/a;b/.y`, API_CFM_KEY, undefined],
    ['an encoded-backslash traversal id', `${RECORDS}/..%5C..%5Cweb.config`, API_CFM_KEY, undefined],
    ['an encoded-backslash traversal id before an action', `${RECORDS}/..%5C..%5Cweb.config/versions`, 'page:render', undefined],
    ['an encoded-backslash traversal survey id', '/legacy-fixtures/cfml/api.cfm/surveys/surveys/..%5C..%5Cweb.config/responses', 'page:render', undefined],
    ['an encoded-backslash traversal request id', '/legacy-fixtures/cfml/api.cfm/esignature/requests/..%5C..%5Cweb.config/audit', 'page:render', undefined],
    ['a sensitive file name in mixed case', `${RECORDS}/Web.Config`, API_CFM_KEY, undefined],
    ['a sensitive file name before an action', `${RECORDS}/x/Package-Lock.json/versions`, 'page:render', undefined],
    ['an Axis suffix in upper case', `${RECORDS}/x.JWS`, API_CFM_KEY, undefined],
    ['an Axis suffix before a path parameter', `${RECORDS}/x.jws;a`, API_CFM_KEY, undefined],
    ['a flash remoting suffix', `${RECORDS}/x.cfswf`, API_CFM_KEY, undefined],
    ['backslash separators, which the container rejects', '/legacy-fixtures\\cfml\\api.cfm/finance/records', 'page:render', undefined],
    ['a backslash in an id', `${RECORDS}/a\\b`, 'page:render', undefined],
    ['an encoded slash before a dot-dot item', '/legacy-fixtures/cfml/api.cfm/finance/records%2F..', 'page:render', undefined],
    ['a malformed escape in path_info, which the container rejects', '/legacy-fixtures/cfml/api.cfm/finance/r%zz', 'page:render', undefined],
    ['an upper-case directory', '/LEGACY-FIXTURES/cfml/api.cfm/finance/records', 'page:render', undefined],
    ['an upper-case script', '/legacy-fixtures/cfml/API.CFM/finance/records', 'page:render', undefined],
    ['an upper-case bare script', '/legacy-fixtures/cfml/API.CFM', 'cfm:/legacy-fixtures/cfml/api.cfm', undefined],
    ['index.cfm before api.cfm, which no fixture script serves', '/legacy-fixtures/cfml/index.cfm/api.cfm/finance/records', 'page:render', undefined],
  ])('keys and dispatches a fixture path with %s as legacy serves it', (_label, url, key, dispatched, opts) => {
    expect(keyOf('GET', url, {}, opts)).toBe(key);
    expect(fixtureDispatchPath(url, opts)).toBe(dispatched);
  });
});

describe('fixtureDispatchPath', () => {
  const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
  it.each<[string, string, string | undefined, RouteKeyOptions?]>([
    ['drops doubled and trailing slashes', '/legacy-fixtures//cfml/api.cfm//finance//records/', `${FIXTURE}/finance/records`],
    ['lower-cases module, resource and action, keeping the id', `${FIXTURE}/FINANCE/Records/Ab-1/SUBMIT`, `${FIXTURE}/finance/records/Ab-1/submit`],
    ['keeps a CF UUID tail', `${FIXTURE}/finance/records/R1/attachments/${UUID}`, `${FIXTURE}/finance/records/R1/attachments/${UUID}`],
    ['lower-cases any other tail', `${FIXTURE}/Surveys/Surveys/S1/Targets/BULK`, `${FIXTURE}/surveys/surveys/S1/targets/bulk`],
    ['re-encodes each decoded item', `${FIXTURE}/finance/records/a%20b%3F%23+`, `${FIXTURE}/finance/records/a%20b%3F%23%2B`],
    ['removes the context', `/masa${FIXTURE}/FINANCE/records`, `${FIXTURE}/finance/records`, { context: '/masa' }],
    ['removes the context case-insensitively', `/MASA${FIXTURE}/finance/records`, `${FIXTURE}/finance/records`, { context: 'masa/' }],
    ['answers no path for a context the path lacks', `/other${FIXTURE}/finance/records`, undefined, { context: '/masa' }],
    ['answers no path behind the root front controller', `/index.cfm${FIXTURE}/finance/records`, undefined],
  ])('%s', (_label, path, expected, opts) => {
    expect(fixtureDispatchPath(path, opts)).toBe(expected);
    expect(resultOf('GET', path, {}, opts).family === 'fixture').toBe(expected !== undefined);
  });
});

describe('legacy bridge spellings', () => {
  const BRIDGE_ROUTE = 'bridge:/gateway/legacy-bridge/**';

  it.each<[string, string, RouteKeyOptions?]>([
    ['/gateway//legacy-bridge/cfml/session.cfm?op=describe', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['//gateway/legacy-bridge/cfml/session.cfm?op=describe', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/legacy-bridge;x/cfml/session.cfm?op=describe', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway///legacy-bridge//cfml//jobs.cfm?job=getCursor', 'bridge:/gateway/legacy-bridge/cfml/jobs.cfm'],
    ['/gateway/legacy-bridge', 'bridge:/gateway/legacy-bridge'],
    ['/gateway//legacy-bridge', 'bridge:/gateway/legacy-bridge'],
    ['/gateway/legacy-bridge;jsessionid=1', 'bridge:/gateway/legacy-bridge'],
    ['/gateway;a/legacy-bridge/', 'bridge:/gateway/legacy-bridge/'],
    ['/gateway/;/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/./legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/%2E/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/x/../legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/x/..;y/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/opt2/../gateway/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/_api/../gateway/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/index.cfm/../gateway/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway\\legacy-bridge\\cfml\\session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/gateway/legacy-bridge/cfml/..', 'bridge:/gateway/legacy-bridge/cfml/..'],
    ['/gateway/legacy-bridge/cfml//session.cfm', 'bridge:/gateway/legacy-bridge/cfml//session.cfm'],
    ['/GATEWAY//Legacy-Bridge/CFML/Session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['/Gateway/Legacy-Bridge', 'bridge:/gateway/legacy-bridge'],
    ['/gateway//legacy-bridge/cfml/session.cfm?appreload', 'bridge:/gateway/legacy-bridge/cfml/session.cfm'],
    ['//masa/gateway/legacy-bridge/cfml/session.cfm', 'bridge:/gateway/legacy-bridge/cfml/session.cfm', { context: '/masa' }],
  ])('keys %s as %s, under the bridge entry', (url, key, opts) => {
    const result = resultOf('GET', url, {}, opts);
    expect([result.family, result.key]).toEqual(['bridge', key]);
    expect(matchRouteKey(result, [BRIDGE_ROUTE])).toBe(BRIDGE_ROUTE);
  });

  it.each([
    '/gateway/legacy-bridgex/cfml/session.cfm',
    '/gateway//legacy-bridgex/',
    '/gateway/other',
    '/legacy-bridge/cfml/session.cfm',
    '/x/gateway/legacy-bridge/cfml/session.cfm',
    '/gateway/x/../other/legacy-bridge/',
    '/index.cfm/gateway/legacy-bridge/cfml/session.cfm',
    '//index.cfm/gateway//legacy-bridge/cfml/session.cfm',
    '/./index.cfm/gateway/legacy-bridge/cfml/session.cfm',
    '/index.cfm;x/gateway/legacy-bridge/cfml/session.cfm',
  ])('keys %s outside the bridge', (url) => {
    const result = resultOf('GET', url);
    expect(result.family).not.toBe('bridge');
    expect(matchRouteKey(result, [BRIDGE_ROUTE])).toBeUndefined();
  });
});

describe('OPT-2 folder spellings', () => {
  const RUNNER = 'cfm:/harness/legacy-baseline/cfml/run.cfm';
  const ROLE_MAP = 'static:/services/identity/config/role-map.json';

  it.each<[string, string, string]>([
    ['path info after a template', '/harness/legacy-baseline/cfml/run.cfm/x?info=1', RUNNER],
    ['a slash after a template', '/harness/legacy-baseline/cfml/run.cfm/', RUNNER],
    ['a file name as path info', '/harness/legacy-baseline/cfml/run.cfm/x.json', RUNNER],
    ['a template path parameter', '/harness/legacy-baseline/cfml/run.cfm;x?info=1', RUNNER],
    ['a directory path parameter', '/harness;x/legacy-baseline/cfml/run.cfm', RUNNER],
    ['dot-dot and doubled slashes', '/x/..//harness/legacy-baseline/cfml/run.cfm', RUNNER],
    ['backslash separators', '/harness\\legacy-baseline\\cfml\\run.cfm', RUNNER],
    ['a component path parameter', '/harness/legacy-baseline/cfml/Application.cfc;x', 'cfc:/harness/legacy-baseline/cfml/application.cfc'],
    ['a static file path parameter', '/services/identity/config/role-map.json;x', ROLE_MAP],
    ['a doubled leading slash', '//services/identity/config/role-map.json', ROLE_MAP],
    ['a doaction on a static file', '/services/identity/config/role-map.json?doaction=login', ROLE_MAP],
    ['a saveform on a static file', '/services/identity/config/role-map.json?saveform=1', ROLE_MAP],
    ['a workflow file path parameter', '/.github/workflows/services.yml;x', 'static:/.github/workflows/services.yml'],
    ['a doaction on a fixture SQL file', '/legacy-fixtures/sql/000_schemas.sql?doaction=login', 'static:/legacy-fixtures/sql/000_schemas.sql'],
    ['a fixture folder file', '/legacy-fixtures/README.md', 'static:/legacy-fixtures/readme.md'],
    ['a file name as a fixture template path info', '/legacy-fixtures/cfml/seed.cfm/x.js', 'cfm:/legacy-fixtures/cfml/seed.cfm'],
    ['a file name as a fixture component path info', '/legacy-fixtures/cfml/modules/finance.cfc/x.js', 'cfc:/legacy-fixtures/cfml/modules/finance.cfc'],
    ['a fixture front controller path the container answers, naming a file', '/legacy-fixtures/cfml/api.cfm/finance/records/..%5C..%5Cweb.config', 'cfm:/legacy-fixtures/cfml/api.cfm'],
    ['a namespace file behind a doubled slash', '//opt2/source-pin.json', 'opt2:/opt2/source-pin.json'],
    ['a namespace file behind a path parameter', '/opt2;x/source-pin.json', 'opt2:/opt2/source-pin.json'],
  ])('keys %s on the file the container serves', (_label, url, key) => {
    expect(keyOf('GET', url)).toBe(key);
  });

  it.each<[string, string, string, RouteKeyOptions?]>([
    ['a namespace path as sent', '/opt2/stub//notes', 'opt2:/opt2/stub//notes'],
    ['a namespace file without the namespaces', '//opt2/source-pin.json', 'static:/opt2/source-pin.json', { opt2Namespaces: false }],
    ['a fixture template with path info', '/legacy-fixtures/cfml/seed.cfm/x', 'page:render'],
    ['a folder directory', '/harness/', 'page:render'],
    ['an upper-case folder, which the container does not find', '/HARNESS/legacy-baseline/cfml/run.cfm/x', 'page:render'],
    ['a legacy template with path info', '/core/tests/runner.cfm/x', 'page:render'],
    ['a doaction on a file outside the workflows folder', '/.github/ISSUE_TEMPLATE/bug.md?doaction=login', 'page:login'],
  ])('keys %s by the other rules', (_label, url, key, opts) => {
    expect(keyOf('GET', url, {}, opts)).toBe(key);
  });
});

describe('public pages', () => {
  it.each<{ name: string; url: string; form?: Record<string, string>; query?: Record<string, string | string[]>; key: string }>([
    { name: 'a plain render', url: '/', key: 'page:render' },
    { name: 'a nested page', url: '/about/', key: 'page:render' },
    { name: 'one doaction, lower-cased', url: '/about/?doaction=Login', key: 'page:login' },
    { name: 'doactions in order without empty items', url: '/?doaction=logout,,Login', key: 'page:logout,login' },
    { name: 'repeated doaction values', url: '/', query: { doaction: ['login', 'logout'] }, key: 'page:login,logout' },
    { name: 'a saveform', url: '/?saveform=1', key: 'page:saveform' },
    { name: 'a doaction with a saveform', url: '/?doaction=login&saveform=x', key: 'page:login+saveform' },
    { name: 'an empty saveform', url: '/?saveform=', key: 'page:render' },
    { name: 'a URL doaction over a form doaction', url: '/?doaction=login', form: { doaction: 'logout' }, key: 'page:login' },
    { name: 'a form doaction', url: '/', form: { doaction: 'logout' }, key: 'page:logout' },
    { name: 'a form saveform', url: '/contact/', form: { saveform: 'true' }, key: 'page:saveform' },
    { name: 'a file path carrying a doaction', url: '/files/report.pdf?doaction=login', key: 'page:login' },
    { name: 'the front controller with a doaction', url: '/index.cfm?doaction=login', key: 'page:login' },
  ])('keys $name as $key', ({ url, form, query, key }) => {
    const extra: Partial<RouteKeyRequest> = {};
    if (form !== undefined) extra.form = form;
    if (query !== undefined) extra.query = query;
    expect(keyOf(form === undefined ? 'GET' : 'POST', url, extra)).toBe(key);
  });
});

describe('application reload', () => {
  const RELOAD = { key: 'reload:application', baseKey: 'reload:application', family: 'reload' };

  it.each<{ name: string; method?: string; url: string; form?: Record<string, string>; afterReload: string }>([
    { name: 'a public page', url: '/?appreload', afterReload: 'page:render' },
    { name: 'the Global Config action', url: '/admin/?appreload&reload=appreload', afterReload: 'admin:home.redirect' },
    { name: 'an upper-case key on the front controller', url: '/index.cfm?APPRELOAD', afterReload: 'page:render' },
    { name: 'a key with a value', url: '/about/?appreload=1&doaction=login', afterReload: 'page:login' },
    { name: 'a static file', url: '/assets/site.css?appreload', afterReload: 'static:/assets/site.css' },
    { name: 'a template', url: '/admin/custom.cfm?appreload', afterReload: 'cfm:/admin/custom.cfm' },
    {
      name: 'a remote CFC call',
      url: '/core/mura/remote.cfc?appreload&method=doThing',
      afterReload: 'cfc:/core/mura/remote.cfc?method=dothing',
    },
    { name: 'another /_api family', url: '/_api/other/thing?appreload', afterReload: 'apiother:/_api/other/thing' },
    {
      name: 'a processAsyncObject path method',
      url: `${API}/processAsyncObject?appreload`,
      afterReload: 'api:processasyncobject',
    },
    {
      name: 'a processAsyncObject form method',
      method: 'POST',
      url: `${API}/?appreload`,
      form: { method: 'processAsyncObject' },
      afterReload: 'api:processasyncobject',
    },
  ])('keys $name as the reload entry', ({ method, url, form, afterReload }) => {
    const result = resultOf(method ?? 'GET', url, form === undefined ? {} : { form });
    expect(result).toMatchObject(RELOAD);
    expect(result.afterReload?.key).toBe(afterReload);
    expect(ROUTE_FAMILIES).toContain(result.family);
  });

  it.each<{ name: string; method?: string; url: string; extra?: Partial<RouteKeyRequest>; opts?: RouteKeyOptions; key: string }>([
    { name: 'a reload key in the form only', method: 'POST', url: '/', extra: { form: { appreload: '' } }, key: 'page:render' },
    {
      name: 'a reload key in the JSON body only',
      method: 'POST',
      url: `${API}/content/`,
      extra: { jsonBody: { appreload: '' }, headers: JSON_TYPE },
      key: 'api:content.save',
    },
    { name: 'an OPT-2 path', url: '/opt2/stub/x?appreload', key: 'opt2:/opt2/stub/x' },
    { name: "a synthetic service's /v1/ path", url: '/v1/surveys/x?appreload', key: 'opt2:/v1/surveys/x' },
    {
      name: 'a bridge path',
      url: '/gateway/legacy-bridge/cfml/session.cfm?appreload',
      key: 'bridge:/gateway/legacy-bridge/cfml/session.cfm',
    },
    { name: 'a fixture route', url: '/legacy-fixtures/cfml/api.cfm/people/persons?appreload', key: 'fixture:people/persons@get' },
    { name: 'the default key under a configured one', url: '/?appreload', opts: { appReloadKey: 'S3cretKey' }, key: 'page:render' },
    { name: 'an empty configured key', url: '/?appreload', opts: { appReloadKey: '' }, key: 'page:render' },
  ])('keeps $name as $key', ({ method, url, extra, opts, key }) => {
    const result = resultOf(method ?? 'GET', url, extra, opts);
    expect(result.key).toBe(key);
    expect(result).not.toHaveProperty('afterReload');
  });

  it.each(['processAsyncObject', 'PROCESSASYNCOBJECT'])('keeps a URL method=%s call, dropping the key from its params', (method) => {
    const result = resultOf('GET', `${API}/?method=${method}&appreload`);
    expect(result.key).toBe('api:processasyncobject');
    expect(result).not.toHaveProperty('afterReload');
    expect(result.params).not.toHaveProperty('appreload');
  });

  it.each(['/?S3cretKey&doaction=login', '/admin/?S3cretKey&reload=S3cretKey', `${API}/content/?s3cretkey&title=Home`])(
    'omits a configured reload key from the reload result of %s',
    (url) => {
      const result = resultOf('GET', url, {}, { appReloadKey: 'S3cretKey' });
      const ordinary = Object.keys(result.afterReload?.params ?? {});
      expect(result).toMatchObject(RELOAD);
      expect(result.params).not.toHaveProperty('s3cretkey');
      expect(Object.keys(result.params)).toEqual(ordinary.filter((name) => name !== 's3cretkey'));
    },
  );

  it('carries the ordinary result unchanged as afterReload, with its site', () => {
    const url = '/admin/?appreload&muraAction=cArch.list&siteid=tenant-a';
    const result = resultOf('GET', url);
    expect(result.afterReload).toStrictEqual(resultOf('GET', url, {}, { appReloadKey: 'otherkey' }));
    expect(result.afterReload?.key).toBe('admin:carch.list');
    expect(result.siteId).toBe('tenant-a');
  });

  it('appends a variant declared on the reload key', () => {
    const variants: VariantDeclaration[] = [
      { route: 'reload:application', variant: 'admin', when: [{ param: 'reload', nonEmpty: true }] },
    ];
    expect(keyOf('GET', '/admin/?appreload&reload=appreload', {}, { variants })).toBe('reload:application{admin}');
    expect(keyOf('GET', '/?appreload', {}, { variants })).toBe('reload:application');
  });

  it.each([
    '/?appreload',
    '/admin/?appreload&reload=appreload',
    `${API}/content/?appreload`,
    '/assets/site.css?appreload',
    '/admin/custom.cfm?appreload',
    '/_api/other/thing?appreload',
  ])('matches %s to the reload entry only', (url) => {
    const carried = ['page:render', 'admin:home.redirect', 'api:content.findall', 'static:/**', 'cfm:/**', 'apiother:/**'];
    const result = resultOf('GET', url);
    expect(matchRouteKey(result, carried)).toBeUndefined();
    expect(matchRouteKey(result, [...carried, 'reload:application'])).toBe('reload:application');
  });
});

describe('OPT-2 namespaces keyed as legacy serves them', () => {
  it.each([
    { url: '/opt2/stub/x', legacyUrl: '/about/x', key: 'page:render' },
    { url: '/opt2/admin/reporting/exports', legacyUrl: '/about/reporting/exports', key: 'page:render' },
    { url: '/v1/surveys/x', legacyUrl: '/about/x', key: 'page:render' },
    { url: '/v1/timesheets/sheets?appreload', legacyUrl: '/about/sheets?appreload', key: 'reload:application' },
    { url: '/opt2/x?doaction=login', legacyUrl: '/about/x?doaction=login', key: 'page:login' },
  ])('keys $url as $key like $legacyUrl without the namespaces, and in the opt2 family with them', ({ url, legacyUrl, key }) => {
    const served = resultOf('GET', url, {}, { opt2Namespaces: false });
    expect(served.key).toBe(key);
    expect(served).toStrictEqual(resultOf('GET', legacyUrl));
    expect(scannedRouteKey({ ...request('GET', url), url }, { opt2Namespaces: false }).result).toStrictEqual(served);
    expect(resultOf('GET', url)).toMatchObject({ key: `opt2:${url.split('?')[0] ?? ''}`, family: 'opt2' });
  });
});

describe('variants', () => {
  const VARIANTS: readonly VariantDeclaration[] = [
    { route: 'admin:cUsers.update', variant: 'photo', when: [PHOTO_CONDITION] },
    { route: 'admin:cUsers.update', variant: 'type=1', when: [{ param: 'type', equals: '1' }] },
    {
      route: 'admin:cUsers.update',
      variant: 'type=2,action=Add',
      when: [
        { param: 'type', equals: '2' },
        { param: 'action', equals: 'Add' },
      ],
    },
    { route: 'admin:cUsers.update', variant: 'type=2', when: [{ param: 'type', equals: '2' }] },
    { route: 'admin:cArch.update', variant: 'upload=image', when: [IMAGE_UPLOAD_CONDITION] },
    { route: 'api:processAsyncObject', variant: 'saveform', when: [SAVEFORM_CONDITION] },
    { route: 'api:file.save', variant: 'upload=image', when: [IMAGE_UPLOAD_CONDITION] },
  ];
  const opts: RouteKeyOptions = { variants: VARIANTS };
  const usersUpdate = (form: Record<string, string>, extra: Partial<RouteKeyRequest> = {}): RouteKeyResult =>
    resultOf('POST', '/admin/?muraAction=cUsers.update', { form, ...extra }, opts);

  it('appends the matched variant to the base key', () => {
    const result = usersUpdate({ type: '2', action: 'Add' });
    expect(result).toMatchObject({
      key: 'admin:cusers.update{type=2,action=add}',
      baseKey: 'admin:cusers.update',
      variant: 'type=2,action=add',
      family: 'admin',
    });
  });

  it.each<[Record<string, string>, string]>([
    [{ type: '2.0', action: 'ADD' }, 'admin:cusers.update{type=2,action=add}'],
    [{ type: '1' }, 'admin:cusers.update{type=1}'],
    [{ type: ' 1' }, 'admin:cusers.update{type=1}'],
    [{ type: '01' }, 'admin:cusers.update{type=1}'],
    [{ type: '1e0' }, 'admin:cusers.update{type=1}'],
    [{ type: '1.' }, 'admin:cusers.update'],
    [{ type: '1. ' }, 'admin:cusers.update'],
    [{ type: '2.', action: 'Add' }, 'admin:cusers.update'],
  ])('compares parameter values %j with CFML equality, keying %s', (form, key) => {
    expect(usersUpdate(form).key).toBe(key);
  });

  it('lets a more specific declaration listed first win over a broader one', () => {
    expect(usersUpdate({ type: '2', action: 'Add' }).variant).toBe('type=2,action=add');
    expect(usersUpdate({ type: '2', action: 'Delete' }).variant).toBe('type=2');
    expect(usersUpdate({ type: '1' }).variant).toBe('type=1');
  });

  it('prefers the photo variant declared ahead of the type variants', () => {
    expect(usersUpdate({ type: '2', action: 'Add', removePhotoFile: 'true' }).key).toBe('admin:cusers.update{photo}');
    expect(
      usersUpdate({ type: '2', action: 'Add' }, { multipartFileNames: [{ field: 'NewFile', filename: 'me.png' }] }).key,
    ).toBe('admin:cusers.update{photo}');
  });

  it('keeps the base key when no declaration holds', () => {
    const result = usersUpdate({ type: '3' });
    expect(result.key).toBe('admin:cusers.update');
    expect(result.variant).toBeUndefined();
  });

  it.each<[string, Record<string, string>, Array<{ field: string; filename: string }>, boolean]>([
    ['a non-empty newFile value', { newFile: 'me.png' }, [], true],
    ['a newFile upload', {}, [{ field: 'newfile', filename: 'me.png' }], true],
    ['an empty newFile upload', {}, [{ field: 'newFile', filename: '' }], false],
    ['an empty newFile value', { newFile: '' }, [], false],
    ['removePhotoFile=true', { removePhotoFile: 'true' }, [], true],
    ['removePhotoFile=yes', { removePhotoFile: 'yes' }, [], true],
    ['removePhotoFile=1', { removePhotoFile: '1' }, [], true],
    ['removePhotoFile=false', { removePhotoFile: 'false' }, [], false],
    ['removePhotoFile=maybe', { removePhotoFile: 'maybe' }, [], false],
    ['neither field', {}, [], false],
  ])('decides {photo} on ceditprofile.update for %s', (_label, form, multipartFileNames, photo) => {
    const declarations = [{ route: 'admin:ceditprofile.update', variant: 'photo', when: [PHOTO_CONDITION] }];
    const result = resultOf(
      'POST',
      '/admin/?muraAction=cEditProfile.update',
      { form, multipartFileNames },
      { variants: declarations },
    );
    expect(result.key).toBe(photo ? 'admin:ceditprofile.update{photo}' : 'admin:ceditprofile.update');
  });

  it.each([
    ['a.png', true],
    ['b.GIF', true],
    ['c.jpg', true],
    ['d.jpeg', true],
    ['e.flv', true],
    ['f.pdf', false],
    ['g.webp', false],
    ['png', false],
  ])('decides {upload=image} on carch.update for %s', (filename, image) => {
    const result = resultOf(
      'POST',
      '/admin/?muraAction=cArch.update',
      { multipartFileNames: [{ field: 'newfile', filename }] },
      opts,
    );
    expect(result.key).toBe(image ? 'admin:carch.update{upload=image}' : 'admin:carch.update');
  });

  it('decides {upload=image} on the JSON API file save', () => {
    const files = [{ field: 'file', filename: 'photo.jpeg' }];
    expect(
      keyOf('POST', `${API}/?method=save&entityname=file`, { multipartFileNames: files }, opts),
    ).toBe('api:file.save{upload=image}');
  });

  it('decides processAsyncObject{saveform} from a form submission', () => {
    const url = `${API}/?method=processAsyncObject`;
    expect(keyOf('POST', url, { form: { saveform: 'true' } }, opts)).toBe('api:processasyncobject{saveform}');
    expect(keyOf('POST', url, {}, opts)).toBe('api:processasyncobject');
  });

  const SESSION: readonly VariantDeclaration[] = [
    { route: 'rest:variationtargeting.save', variant: 'session', when: [SESSION_MANAGED_CONDITION] },
  ];

  // path_info keeps an index.cfm spelling the container does not map, and a second encoding (applicationSettings.cfm:179).
  it.each<[string, string, boolean]>([
    ['an upper-case index.cfm', '/INDEX.CFM/_api/rest/v1/default/variationTargeting', true],
    ['a title-case index.cfm', '/Index.cfm/_api/rest/v1/default/variationTargeting', true],
    ['an upper-case extension', '/index.CFM/_api/rest/v1/default/variationTargeting', true],
    ['an upper-case index.cfm and API path', '/INDEX.CFM/_API/REST/v1/default/variationTargeting', true],
    ['a double-encoded _api segment', '/%255Fapi/rest/v1/default/variationTargeting', true],
    ['index.cfm and a double-encoded _api segment', '/index.cfm/%255Fapi/rest/v1/default/variationTargeting', true],
    ['the lower-case index.cfm', '/index.cfm/_api/rest/v1/default/variationTargeting', false],
    ['the bare path', '/_api/rest/v1/default/variationTargeting', false],
    ['an upper-case API path', '/_API/REST/v1/default/variationTargeting', false],
    ['an encoded _api segment', '/%5Fapi/rest/v1/default/variationTargeting', false],
    ['index.cfm and an upper-case API path', '/index.cfm/_API/REST/v1/default/variationTargeting', false],
  ])('decides {session} on a REST save behind %s', (_label, path, session) => {
    const result = resultOf('POST', path, {}, { variants: SESSION });
    expect(result.baseKey).toBe('rest:variationtargeting.save');
    expect(result.key).toBe(session ? 'rest:variationtargeting.save{session}' : 'rest:variationtargeting.save');
  });

  it.each([
    ['/masa/INDEX.CFM/_api/rest/v1/default/variationTargeting', 'session'],
    ['/masa/index.cfm/_api/rest/v1/default/variationTargeting', undefined],
    ['/masa/_api/rest/v1/default/variationTargeting', undefined],
  ])('reads the path_info of %s after the context', (path, variant) => {
    expect(resultOf('POST', path, {}, { variants: SESSION, context: '/masa' }).variant).toBe(variant);
  });

  const STARTUP_SITE: readonly VariantDeclaration[] = [
    ...SESSION,
    { route: 'rest:variationtargeting.save', variant: 'siteid', when: [STARTUP_SITE_CONDITION] },
  ];

  // mura.event init appends the form scope, then the url scope without overwriting (event.cfc:86-89); a JSON body is neither.
  it.each<[string, string, Partial<RouteKeyRequest>, string | undefined]>([
    ['a form siteid', '', { form: { siteid: 'default' } }, 'siteid'],
    ['a url siteid', '?siteid=default', {}, 'siteid'],
    ['a url siteid in another case', '?SiteID=default', {}, 'siteid'],
    ['an empty form siteid over a url one', '?siteid=default', { form: { siteid: '' } }, undefined],
    ['an empty url siteid', '?siteid=', {}, undefined],
    ['a JSON body siteid', '', { jsonBody: { siteid: 'default' }, headers: JSON_TYPE }, undefined],
    ['no siteid', '', { form: { title: 'x' } }, undefined],
  ])('decides {siteid} on a REST save carrying %s', (_label, search, extra, variant) => {
    const result = resultOf('POST', `/_api/rest/v1/default/variationTargeting${search}`, extra, { variants: STARTUP_SITE });
    expect(result.baseKey).toBe('rest:variationtargeting.save');
    expect(result.variant).toBe(variant);
  });

  it('lets an earlier {session} declaration win over {siteid}', () => {
    const extra = { form: { siteid: 'default' } };
    expect(keyOf('POST', '/INDEX.CFM/_api/rest/v1/default/variationTargeting', extra, { variants: STARTUP_SITE })).toBe(
      'rest:variationtargeting.save{session}',
    );
  });

  it('holds sessionManaged on every family but REST, and negates it under not', () => {
    const variants: VariantDeclaration[] = [
      { route: 'api:variationtargeting.save', variant: 'sessionless', when: [{ not: SESSION_MANAGED_CONDITION }] },
      { route: 'admin:cusers.update', variant: 'session', when: [SESSION_MANAGED_CONDITION] },
    ];
    expect(keyOf('POST', '/INDEX.CFM/_api/json/v1/default/variationTargeting', {}, { variants })).toBe(
      'api:variationtargeting.save',
    );
    expect(keyOf('POST', '/admin/?muraAction=cUsers.update', {}, { variants })).toBe('admin:cusers.update{session}');
  });

  it.each<[VariantCondition, Record<string, string>, boolean]>([
    [{ param: 'action', in: ['Update', 'Delete'] }, { action: 'delete' }, true],
    [{ param: 'action', in: ['Update', 'Delete'] }, { action: 'Add' }, false],
    [{ param: 'action', in: ['Update', 'Delete'] }, {}, false],
    [{ param: 'action', equals: 'Add' }, {}, false],
    [{ param: 'siteid', truthy: true }, {}, false],
    [{ not: { param: 'siteid', nonEmpty: true } }, {}, true],
    [{ not: { param: 'siteid', nonEmpty: true } }, { siteid: 'default' }, false],
    [{ anyOf: [{ param: 'a', equals: '1' }, { param: 'b', equals: '1' }] }, { b: '1' }, true],
    [{ param: 'type', equals: '1.' }, { type: '1.' }, true],
    [{ param: 'type', equals: '1.' }, { type: '1' }, false],
    [{ param: 'type', in: ['1', '2'] }, { type: '2.' }, false],
    [{ param: 'type', in: ['1', '2'] }, { type: ' 2' }, true],
  ])('evaluates %j over %j as %s', (condition, form, holds) => {
    const declarations = [{ route: 'admin:csettings.updatesite', variant: 'v', when: [condition] }];
    const result = resultOf('POST', '/admin/?muraAction=cSettings.updateSite', { form }, { variants: declarations });
    expect(result.variant).toBe(holds ? 'v' : undefined);
  });

  const HOME = '00000000000000000000000000000000001';
  const SHARED_SORT: readonly VariantDeclaration[] = [
    { route: 'admin:carch.list', variant: 'sharedid', when: SHARED_ID_SORT_CONDITIONS },
  ];

  // rc.orderid joins repeated fields with `,`; listLen skips empty items and SQL Server's `=` ignores case and trailing spaces.
  it.each<[string, string, Record<string, string>, boolean]>([
    ['a home topid', `&topid=${HOME}`, { orderperm: 'editor' }, true],
    ['a module-root topid with trailing spaces', '&topid=00000000000000000000000000000000003%20%20', { orderperm: 'editor' }, true],
    ['the scaffolding module topid', '&topid=00000000000000000000000000000000016', { orderperm: 'Author' }, true],
    ['an orderid list holding a shared id', '&topid=F1', { orderperm: 'editor', orderid: `C1,,${HOME} ,C2` }, true],
    ['a shared id among list items in another case', '&topid=F1', { orderperm: 'EDITOR', orderid: 'c1,00000000000000000000000000000000099' }, true],
    ['an empty topid', '&topid=', { orderperm: 'editor', orderid: 'C1' }, true],
    ['no topid', '', { orderperm: 'editor' }, true],
    ['a folder topid and folder orderids', '&topid=F1', { orderperm: 'editor', orderid: 'C1,C2' }, false],
    ['a shared id with a leading space', '&topid=F1', { orderperm: 'editor', orderid: ` ${HOME}` }, false],
    ['a shared id with a trailing tab', '&topid=F1', { orderperm: 'editor', orderid: `${HOME}\t` }, false],
    ['a shared id inside one item', '&topid=F1', { orderperm: 'editor', orderid: `${HOME}0` }, false],
    ['a home topid without orderperm', `&topid=${HOME}`, { orderid: 'C1' }, false],
    ['a home topid under a read orderperm', `&topid=${HOME}`, { orderperm: 'read' }, false],
    ['a home topid under a padded orderperm', `&topid=${HOME}`, { orderperm: 'editor ' }, false],
  ])('decides {sharedid} on a carch.list sort with %s', (_label, search, form, sharedId) => {
    const result = resultOf('POST', `/admin/?muraAction=cArch.list&siteid=tenant-a${search}`, { form }, { variants: SHARED_SORT });
    expect(result.key).toBe(sharedId ? 'admin:carch.list{sharedid}' : 'admin:carch.list');
  });

  it.each<[string, string, boolean]>([
    ['a sole matching item', HOME, true],
    ['a matching item among empty ones', `,C1,,${HOME},`, true],
    ['an item in another case', 'c1,00000000000000000000000000000000ABC', true],
    ['an item with trailing spaces', `${HOME}  `, true],
    ['an item with a leading space', ` ${HOME}`, false],
    ['an item with a trailing tab', `${HOME}\t`, false],
    ['a longer item', `${HOME}0`, false],
    ['an empty list', '', false],
    ['a list of delimiters', ',,', false],
  ])('listHasSqlKey over %s', (_label, list, found) => {
    expect(listHasSqlKey(list, [HOME, '00000000000000000000000000000000abc'])).toBe(found);
  });

  it('reads topid as the merged rc reads it, a form value overwriting the url one', () => {
    const url = `/admin/?muraAction=cArch.list&siteid=tenant-a&topid=${HOME}`;
    expect(keyOf('POST', url, { form: { orderperm: 'editor', topid: 'F1' } }, { variants: SHARED_SORT })).toBe('admin:carch.list');
    expect(keyOf('POST', '/admin/?muraAction=cArch.list&topid=F1', { form: { orderperm: 'editor', topid: HOME } }, { variants: SHARED_SORT })).toBe(
      'admin:carch.list{sharedid}',
    );
  });
});

describe('matchRouteKey', () => {
  const admin = (form: Record<string, string> = {}): RouteKeyResult =>
    resultOf('POST', '/admin/?muraAction=cUsers.update', { form }, {
      variants: [{ route: 'admin:cusers.update', variant: 'type=1', when: [{ param: 'type', equals: '1' }] }],
    });

  it('returns the authored route that equals the key after normalisation', () => {
    expect(matchRouteKey(admin(), ['admin:cusers.edit', ' Admin:cUsers.Update '])).toBe(' Admin:cUsers.Update ');
  });

  it('returns undefined, meaning legacy, when nothing matches', () => {
    expect(matchRouteKey(admin(), ['admin:cusers.edit'])).toBeUndefined();
  });

  it('never falls back from a variant key to its base', () => {
    const result = admin({ type: '1' });
    expect(matchRouteKey(result, ['admin:cusers.update'])).toBeUndefined();
    expect(matchRouteKey(result, ['admin:cusers.update', 'admin:cusers.update{type=1}'])).toBe('admin:cusers.update{type=1}');
  });

  it('never matches a base key to a variant route', () => {
    expect(matchRouteKey(admin(), ['admin:cusers.update{type=1}'])).toBeUndefined();
  });

  it('matches the longest /** prefix of the path family', () => {
    const result = resultOf('GET', '/opt2/stub/items/1');
    const routes = new Set(['opt2:/opt2/**', 'opt2:/opt2/stub/**', 'opt2:/opt2/st/**']);
    expect(matchRouteKey(result, routes)).toBe('opt2:/opt2/stub/**');
  });

  it('matches a /** prefix at a segment boundary only', () => {
    expect(matchRouteKey(resultOf('GET', '/opt2/stub'), ['opt2:/opt2/stub/**'])).toBe('opt2:/opt2/stub/**');
    expect(matchRouteKey(resultOf('GET', '/opt2/stubby'), ['opt2:/opt2/stub/**'])).toBeUndefined();
  });

  it('prefers an exact route over a glob', () => {
    expect(matchRouteKey(resultOf('GET', '/opt2/stub/items'), ['opt2:/opt2/**', 'opt2:/opt2/stub/items'])).toBe(
      'opt2:/opt2/stub/items',
    );
  });

  it.each([
    ['/gateway/legacy-bridge/session.cfm', 'bridge:/gateway/legacy-bridge/**'],
    ['/core/assets/css/admin.css', 'static:/core/assets/**'],
    ['/legacy-fixtures/cfml/seed.cfm', 'cfm:/legacy-fixtures/**'],
    ['/harness/legacy-baseline/cfml/Application.cfc?method=x', 'cfc:/harness/**'],
    ['/_api/other/thing', 'apiother:/_api/**'],
  ])('globs %s under %s', (url, route) => {
    expect(matchRouteKey(resultOf('GET', url), [route])).toBe(route);
  });

  it('does not glob families keyed by action or method', () => {
    expect(matchRouteKey(resultOf('GET', '/about/'), ['page:**', 'page:/**'])).toBeUndefined();
    expect(matchRouteKey(resultOf('GET', `${API}/content/`), ['api:**'])).toBeUndefined();
  });

  it('does not glob across families', () => {
    expect(matchRouteKey(resultOf('GET', '/opt2/stub/items'), ['static:/opt2/**'])).toBeUndefined();
  });

  it('does not glob a path-family key that carries a variant', () => {
    const declarations: VariantDeclaration[] = [
      { route: 'cfm:/legacy-fixtures/cfml/seed.cfm', variant: 'run', when: [{ param: 'run', nonEmpty: true }] },
    ];
    const result = resultOf('GET', '/legacy-fixtures/cfml/seed.cfm?run=1', {}, { variants: declarations });
    expect(result.key).toBe('cfm:/legacy-fixtures/cfml/seed.cfm{run}');
    expect(matchRouteKey(result, ['cfm:/legacy-fixtures/**'])).toBeUndefined();
  });
});

describe('routeKeyForEntryPoint', () => {
  const variants: readonly VariantDeclaration[] = [
    {
      route: 'admin:cusers.update',
      variant: 'type=2,action=Add',
      when: [
        { param: 'type', equals: '2' },
        { param: 'action', equals: 'Add' },
      ],
    },
    { route: 'api:file.save', variant: 'upload=image', when: [IMAGE_UPLOAD_CONDITION] },
    { route: 'rest:variationtargeting.save', variant: 'session', when: [SESSION_MANAGED_CONDITION] },
  ];

  it.each<{ name: string; entry: RouteEntryPoint; req: RouteKeyRequest; opts?: RouteKeyOptions; key: string }>([
    {
      name: 'an admin action',
      entry: { kind: 'admin', action: 'cUsers.list' },
      req: request('GET', '/admin/index.cfm?muraAction=cUsers.list'),
      key: 'admin:cusers.list',
    },
    {
      name: 'an admin action under a configured admin dir',
      entry: { kind: 'admin', action: 'cUsers.list' },
      req: request('GET', '/manage/?muraAction=cUsers.list'),
      opts: { adminDir: '/manage/' },
      key: 'admin:cusers.list',
    },
    {
      name: 'an admin action under an empty admin dir',
      entry: { kind: 'admin', action: 'cUsers.list' },
      req: request('GET', '/admin/?muraAction=cUsers.list'),
      opts: { adminDir: '' },
      key: 'admin:cusers.list',
    },
    {
      name: 'an admin variant',
      entry: { kind: 'admin', action: 'cUsers.update', params: { type: '2', action: 'Add' } },
      req: request('POST', '/admin/?muraAction=cUsers.update', { form: { type: '2', action: 'Add' } }),
      opts: { variants },
      key: 'admin:cusers.update{type=2,action=add}',
    },
    {
      name: 'a generic API method on an entity',
      entry: { kind: 'api', method: 'save', entity: 'user' },
      req: request('POST', `${API}/`, { form: { method: 'save', entityname: 'user' } }),
      key: 'api:user.save',
    },
    {
      name: 'a non-generic API method',
      entry: { kind: 'api', method: 'login', entity: 'user' },
      req: request('POST', `${API}/login`),
      key: 'api:login',
    },
    {
      name: 'a REST method',
      entry: { kind: 'api', family: 'rest', method: 'login' },
      req: request('GET', '/_api/rest/v1/default/?method=login'),
      key: 'rest:login',
    },
    {
      name: 'an API upload variant',
      entry: { kind: 'api', method: 'save', entity: 'file', multipartFileNames: [{ field: 'file', filename: 'a.png' }] },
      req: request('POST', `${API}/`, {
        form: { method: 'save', entityname: 'file' },
        multipartFileNames: [{ field: 'file', filename: 'a.png' }],
      }),
      opts: { variants },
      key: 'api:file.save{upload=image}',
    },
    {
      name: 'a REST save behind another index.cfm spelling',
      entry: { kind: 'api', family: 'rest', method: 'save', entity: 'variationTargeting', frontController: 'INDEX.CFM' },
      req: request('POST', '/INDEX.CFM/_api/rest/v1/default/variationTargeting'),
      opts: { variants },
      key: 'rest:variationtargeting.save{session}',
    },
    {
      name: 'a REST save on the bare path',
      entry: { kind: 'api', family: 'rest', method: 'save', entity: 'variationTargeting' },
      req: request('POST', '/_api/rest/v1/default/variationTargeting'),
      opts: { variants },
      key: 'rest:variationtargeting.save',
    },
    {
      name: 'a page with doactions and a saveform',
      entry: { kind: 'page', doaction: ['Login'], saveform: true },
      req: request('POST', '/index.cfm?doaction=login', { form: { saveform: 'x' } }),
      key: 'page:login+saveform',
    },
    { name: 'a plain page', entry: { kind: 'page' }, req: request('GET', '/about/'), key: 'page:render' },
    {
      name: 'a remote CFC method',
      entry: { kind: 'cfc', path: '/core/mura/remote.cfc', method: 'doThing' },
      req: request('GET', '/core/mura/remote.cfc?method=doThing'),
      key: 'cfc:/core/mura/remote.cfc?method=dothing',
    },
    {
      name: 'a fixture route',
      entry: { kind: 'fixture', httpMethod: 'POST', path: '/legacy-fixtures/cfml/api.cfm/finance/invoices/7/submit' },
      req: request('POST', '/legacy-fixtures/cfml/api.cfm/finance/invoices/9/submit'),
      key: 'fixture:finance/invoices/{id}/submit@post',
    },
    {
      name: 'a path with a query',
      entry: { kind: 'path', path: '/_api/render/small/', query: { fileid: 'F1' } },
      req: request('GET', '/tasks/render/small/?fileid=F2'),
      key: 'render:small',
    },
    {
      name: 'a bare path',
      entry: { kind: 'path', path: '/_api/sitemonitor' },
      req: request('GET', '/_api/sitemonitor'),
      key: 'sitemonitor:run',
    },
    { name: 'an application reload', entry: { kind: 'reload' }, req: request('GET', '/?appreload'), key: 'reload:application' },
    {
      name: 'the Global Config reload',
      entry: { kind: 'reload', admin: true },
      req: request('GET', '/admin/?appreload&reload=appreload'),
      key: 'reload:application',
    },
    {
      name: 'a reload under a configured key',
      entry: { kind: 'reload' },
      req: request('GET', '/?S3cretKey'),
      opts: { appReloadKey: 'S3cretKey' },
      key: 'reload:application',
    },
    {
      name: 'the Global Config reload under a configured key and admin dir',
      entry: { kind: 'reload', admin: true },
      req: request('GET', '/manage/?S3cretKey&reload=s3cretkey'),
      opts: { appReloadKey: 'S3cretKey', adminDir: '/manage' },
      key: 'reload:application',
    },
  ])('keys $name like the equivalent request', ({ entry, req, opts, key }) => {
    expect(routeKeyForEntryPoint(entry, opts).key).toBe(key);
    expect(routeKeyForRequest(req, opts).key).toBe(key);
    expect(routeKeyForEntryPoint(entry, opts).afterReload?.key).toBe(routeKeyForRequest(req, opts).afterReload?.key);
  });

  it('places an API entry point on its site', () => {
    const result = routeKeyForEntryPoint({ kind: 'api', method: 'findOne', entity: 'content', siteId: 'tenant-a' });
    expect(result.key).toBe('api:content.findone');
    expect(result.siteId).toBe('tenant-a');
  });

  it('passes entry point headers to the request', () => {
    const entry: RouteEntryPoint = { kind: 'api', method: 'origin', headers: { Origin: 'https://example.test' } };
    expect(routeKeyForEntryPoint(entry).key).toBe('api:!invalidmethodcall');
  });

  it('uses the method of a path entry point', () => {
    const result = routeKeyForEntryPoint({ kind: 'path', httpMethod: 'POST', path: '/opt2/stub/items', params: { a: '1' } });
    expect(result).toMatchObject({ key: 'opt2:/opt2/stub/items', httpMethod: 'POST', params: { a: '1' } });
  });
});

describe('normaliseRouteKey', () => {
  it('trims and lower-cases an authored key', () => {
    expect(normaliseRouteKey('  Admin:cUsers.Update{Type=2,Action=Add}\n')).toBe('admin:cusers.update{type=2,action=add}');
  });
});

describe('entityRemoteFunctionsFromKeys', () => {
  it.each<[string, string[], Record<string, string[]>]>([
    ['nothing from no keys', [], {}],
    ['one entry for both families', ['rest:comment.~flag', 'api:comment.~flag'], { comment: ['flag'] }],
    [
      'distinct names per entity, entities and names sorted',
      ['api:user.~pollstate', 'api:comment.~flag', 'rest:comment.~delete', 'api:comment.~flag'],
      { comment: ['delete', 'flag'], user: ['pollstate'] },
    ],
    [
      'normalised keys',
      ['  API:User.~PollState\n', 'rest:FileBrowser.~CKEditor_Quick_Upload'],
      { filebrowser: ['ckeditor_quick_upload'], user: ['pollstate'] },
    ],
    [
      'nothing from other keys',
      [
        'api:comment.save',
        'api:comment.findone',
        'api:!invalidmethodcall',
        'api:pollstate',
        'api:comment.~flag{x}',
        'feed:comment.~flag',
        'admin:ccomments.markasspam',
        'cfc:/core/mura/remote.cfc?method=dothing',
      ],
      {},
    ],
  ])('derives %s', (_label, keys, expected) => {
    const derived = entityRemoteFunctionsFromKeys(keys);
    expect(derived).toStrictEqual(expected);
    expect(Object.keys(derived)).toEqual(Object.keys(expected));
    expect(Object.isFrozen(derived)).toBe(true);
  });

  it.each([
    [`${API}/?method=comment.flag`, 'api:!invalidmethodcall', 'api:comment.~flag'],
    ['/_api/rest/v1/default/?method=comment.markAsSpam', 'rest:!invalidmethodcall', 'rest:comment.~markasspam'],
  ])('lets routeKeyForRequest key POST %s, otherwise %s, as %s', (url, unregistered, key) => {
    const entityRemoteFunctions = entityRemoteFunctionsFromKeys(['rest:comment.~flag', 'api:comment.~markasspam']);
    expect(keyOf('POST', url)).toBe(unregistered);
    expect(keyOf('POST', url, {}, { entityRemoteFunctions })).toBe(key);
  });
});

describe('isLegacySessionManaged', () => {
  it.each<[string, RouteKeyOptions, boolean]>([
    ['/_api/rest/v1/default/content/', {}, false],
    ['/_API/Rest/v1/default/', {}, false],
    ['/index.cfm/_api/rest/v1/default/', {}, false],
    ['/%5Fapi/rest/v1/default/', {}, false],
    ['/ctx/_api/rest/v1/default/', { context: '/ctx' }, false],
    ['/_api/rest', {}, true],
    ['/_api/json/v1/default/content/', {}, true],
    ['/admin/', {}, true],
    ['/core/modules/v1/rater/ajax/saveRate.cfm', {}, true],
    ['/ctx/_api/rest/v1/default/', {}, true],
  ])('reads %s with %j as session-managed: %s', (path, opts, expected) => {
    expect(isLegacySessionManaged(path, opts)).toBe(expected);
  });
});

describe('apiRequestPath', () => {
  it.each<[string, string, RouteKeyOptions?]>([
    ['/index.cfm/_api/rest/v1/default/oauth', '/_api/rest/v1/default/oauth'],
    ['/_api/rest/v1/default/oauth', '/_api/rest/v1/default/oauth'],
    ['/index.cfm/_api/rest/v1/default/oauth/', '/_api/rest/v1/default/oauth/'],
    ['/index.cfm/_api/rest/v1/default/o%61uth2', '/_api/rest/v1/default/oauth2'],
    ['/ctx/index.cfm/_api/rest/v1/default/oauth', '/_api/rest/v1/default/oauth', { context: '/ctx' }],
  ])('reads %s as %s', (path, expected, opts) => {
    expect(apiRequestPath(path, opts)).toBe(expected);
  });

  it.each([
    ['/_api/rest/v1/default/oauth', 'rest:oauth'],
    ['/_api/rest/v1/default/oauth2', 'rest:oauth2'],
    ['/_api/rest/v1/default/oauth/', 'rest:oauth'],
    ['/_api/rest/v1/default/o%61uth2', 'rest:oauth2'],
    ['/_api/rest/v1/default/oauth/tokeninfo?access_token=T1&client_id=C1', 'rest:tokeninfo'],
  ])('keys %s to %s behind /index.cfm too, reading the same path', (url, key) => {
    const [path = ''] = url.split('?');
    expect([keyOf('POST', url), keyOf('POST', `/index.cfm${url}`)]).toEqual([key, key]);
    expect(apiRequestPath(`/index.cfm${path}`)).toBe(apiRequestPath(path));
  });
});
