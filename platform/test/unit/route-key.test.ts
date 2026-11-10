import { describe, expect, it } from 'vitest';
import {
  IMAGE_UPLOAD_CONDITION,
  PHOTO_CONDITION,
  ROUTE_FAMILIES,
  SAVEFORM_CONDITION,
  type RouteEntryPoint,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type RouteKeyResult,
  type VariantCondition,
  type VariantDeclaration,
  matchRouteKey,
  normaliseRouteKey,
  routeKeyForEntryPoint,
  routeKeyForRequest,
} from '../../src/legacy-compat/route-key.js';

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
    '/index.cfm/gateway/legacy-bridge/session.cfm',
    '/index.cfm/admin/',
    '/index.cfm/core/mura/remote.cfc',
    '/index.cfm/about/style.css',
  ])('serves %s through the front controller as a page', (url) => {
    expect(keyOf('GET', url)).toBe('page:render');
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
    expect(result.params).toMatchObject({ a: 'query', b: 'form', c: 'body', d: '4', e: '', entityname: 'content' });
    expect(result.params).not.toHaveProperty('f');
    expect(result.params).not.toHaveProperty('g');
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

  it.each([
    [{}, '?appreload', 'api:content.findall'],
    [{}, '?appreload&title=Home', 'api:content.findquery'],
    [{ appReloadKey: 'Reload' }, '?reload', 'api:content.findall'],
    [{ appReloadKey: 'Reload' }, '?appreload', 'api:content.findquery'],
  ])('with options %j removes only the reload key from the query %s', (opts, search, key) => {
    expect(keyOf('GET', `${API}/content/${search}`, {}, opts)).toBe(key);
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
    [{}, `${API}/variationTargetings`, 'api:variationtargetings.findall'],
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

  it('merges a fixture JSON body over query and form params', () => {
    const result = resultOf('POST', '/legacy-fixtures/cfml/api.cfm/finance/invoices?q=1&amount=1', {
      form: { note: 'form' },
      jsonBody: { amount: 5 },
    });
    expect(result.params).toMatchObject({ q: '1', note: 'form', amount: '5' });
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

  it('compares parameter values with CFML equality', () => {
    expect(usersUpdate({ type: '2.0', action: 'ADD' }).key).toBe('admin:cusers.update{type=2,action=add}');
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

  it.each<[VariantCondition, Record<string, string>, boolean]>([
    [{ param: 'action', in: ['Update', 'Delete'] }, { action: 'delete' }, true],
    [{ param: 'action', in: ['Update', 'Delete'] }, { action: 'Add' }, false],
    [{ param: 'action', in: ['Update', 'Delete'] }, {}, false],
    [{ param: 'action', equals: 'Add' }, {}, false],
    [{ param: 'siteid', truthy: true }, {}, false],
    [{ not: { param: 'siteid', nonEmpty: true } }, {}, true],
    [{ not: { param: 'siteid', nonEmpty: true } }, { siteid: 'default' }, false],
    [{ anyOf: [{ param: 'a', equals: '1' }, { param: 'b', equals: '1' }] }, { b: '1' }, true],
  ])('evaluates %j over %j as %s', (condition, form, holds) => {
    const declarations = [{ route: 'admin:csettings.updatesite', variant: 'v', when: [condition] }];
    const result = resultOf('POST', '/admin/?muraAction=cSettings.updateSite', { form }, { variants: declarations });
    expect(result.variant).toBe(holds ? 'v' : undefined);
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
  ])('keys $name like the equivalent request', ({ entry, req, opts, key }) => {
    expect(routeKeyForEntryPoint(entry, opts).key).toBe(key);
    expect(routeKeyForRequest(req, opts).key).toBe(key);
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
