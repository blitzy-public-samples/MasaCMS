// Tests the route key on the url and form scopes as legacy's start-up script protection leaves them.
import { describe, expect, it } from 'vitest';
import {
  routeKeyForRequest,
  scannedRouteKey,
  type RouteKeyRequest,
  type ScannedRouteKey,
  type ScannedRouteKeyRequest,
} from '../../src/legacy-compat/index.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

/** A request as sent: target, and an optional POST body with its content type. */
interface Sent {
  url: string;
  contentType?: string;
  body?: string;
}

/** Url or form fields as the gateway parses them: a repeated name maps to its values in order. */
function fieldsOf(search: string): Record<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    const previous = fields.get(name);
    fields.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(fields);
}

/** The route-key request of `sent` with its target, a POST when it has a body. */
function requestOf({ url, contentType, body }: Sent): ScannedRouteKeyRequest {
  const at = url.indexOf('?');
  const request: ScannedRouteKeyRequest = {
    url,
    method: body === undefined ? 'GET' : 'POST',
    path: at === -1 ? url : url.slice(0, at),
    query: fieldsOf(at === -1 ? '' : url.slice(at + 1)),
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  };
  if (body !== undefined && contentType === JSON_TYPE) request.jsonBody = JSON.parse(body);
  else if (body !== undefined) request.form = fieldsOf(body);
  return request;
}

const keyOf = (sent: Sent): ScannedRouteKey => scannedRouteKey(requestOf(sent));

/** The key, reload target, params and url scope a scanned key reports. */
function keyed({ result, urlScope, scanFailed }: ScannedRouteKey) {
  return { key: result.key, afterReload: result.afterReload?.key, siteId: result.siteId, params: { ...result.params }, urlScope: { ...urlScope }, scanFailed };
}

const form = (body: string): Omit<Sent, 'url'> => ({ contentType: URLENCODED, body });

describe('scannedRouteKey', () => {
  it.each<[string, Sent, Sent, string]>([
    ['a padded url method', { url: '/_api/json/v1/tenant-a/?method=%20generateCSRFTokens%20' }, { url: '/_api/json/v1/tenant-a/?method=generateCSRFTokens' }, 'api:generatecsrftokens'],
    ['a url method holding a NUL', { url: '/_api/json/v1/tenant-a/?method=generate%00CSRFTokens' }, { url: '/_api/json/v1/tenant-a/?method=generateCSRFTokens' }, 'api:generatecsrftokens'],
    ['an amp;-prefixed url method', { url: '/_api/json/v1/tenant-a/?amp;method=generateCSRFTokens' }, { url: '/_api/json/v1/tenant-a/?method=generateCSRFTokens' }, 'api:generatecsrftokens'],
    ['a padded entity method', { url: '/_api/json/v1/tenant-a/content/?method=%20findOne%20' }, { url: '/_api/json/v1/tenant-a/content/?method=findOne' }, 'api:.findone'],
    ['a padded admin action', { url: '/admin/?muraAction=%20cUsers.list' }, { url: '/admin/?muraAction=cUsers.list' }, 'admin:cusers.list'],
    [
      'a script-bearing admin action',
      { url: '/admin/?muraAction=cUsers.list%3Cscript%3Ex%3C/script%3E' },
      { url: '/admin/?muraAction=cUsers.list[INVALID]' },
      'admin:cusers.list[invalid]',
    ],
    ['a hyphenated admin action name', { url: '/admin/?mura-action=cUsers.list' }, { url: '/admin/?mura-action=cUsers.list&muraaction=cUsers.list' }, 'admin:cusers.list'],
    ['a padded posted admin action', { url: '/admin/index.cfm', ...form('muraAction=+cUsers.list+') }, { url: '/admin/index.cfm', ...form('muraAction=cUsers.list') }, 'admin:cusers.list'],
    ['a posted admin action holding a NUL', { url: '/admin/index.cfm', ...form('muraAction=cUsers.list%00') }, { url: '/admin/index.cfm', ...form('muraAction=cUsers.list') }, 'admin:cusers.list'],
    [
      'an amp;-prefixed posted method',
      { url: '/_api/json/v1/tenant-a/', ...form('amp;method=generateCSRFTokens') },
      { url: '/_api/json/v1/tenant-a/', ...form('method=generateCSRFTokens') },
      'api:generatecsrftokens',
    ],
    ['case-variant fuseactions, joined before the copy', { url: '/admin/?fuseaction=%20cUsers&FUSEACTION=list%20' }, { url: '/admin/?fuseaction=cUsers%2Clist' }, 'admin:cusers,list.default'],
    ['case-variant posted methods, joined', { url: '/_api/json/v1/tenant-a/', ...form('Method=generate&method=CSRFTokens') }, { url: '/_api/json/v1/tenant-a/', ...form('Method=generate%2CCSRFTokens') }, 'api:entity.save'],
    [
      'a padded and script-bearing posted REST field',
      { url: '/_api/rest/v1/tenant-a/variationtargeting?siteid=%20tenant-a%20', ...form('title=+t%3Cscript%3Ex%3C%2Fscript%3E+') },
      { url: '/_api/rest/v1/tenant-a/variationtargeting?siteid=tenant-a', ...form('title=t[INVALID]') },
      'rest:variationtargeting.save',
    ],
  ])('keys %s as its scanned equivalent', (_label, sent, equivalent, key) => {
    const outcome = keyed(keyOf(sent));
    expect(outcome.key).toBe(key);
    expect(outcome).toEqual(keyed(keyOf(equivalent)));
  });

  it.each<[string, Sent, string, string | undefined, boolean]>([
    ['a JSON body, as sent', { url: '/_api/json/v1/tenant-a/', contentType: JSON_TYPE, body: '{"method":" generateCSRFTokens ","x":null}' }, 'api:entity.save', undefined, false],
    ['a url scan fault, on its name and NUL fixes', { url: '/_api/json/v1/tenant-a/?amp;method=generate%00CSRFTokens&x=null' }, 'api:generatecsrftokens', undefined, true],
    ['a url scan fault, untrimmed', { url: '/_api/json/v1/tenant-a/?method=%20generateCSRFTokens&x=null' }, 'api:entity.findquery', undefined, true],
    ['a url name the scan empties', { url: '/_api/rest/v1/tenant-a/content?amp;-=1' }, 'rest:content.findquery', undefined, true],
    ['a JSON null joined with a case variant, which no longer reads as JSON', { url: '/_api/rest/v1/tenant-a/content?x=1&X=null' }, 'rest:content.findquery', undefined, false],
    ['an admin form scan fault, halted', { url: '/admin/index.cfm', ...form('muraAction=+cUsers.list&x=null') }, 'admin: cusers.list{scriptprotect=fault}', undefined, true],
    ['a REST form scan fault', { url: '/_api/rest/v1/tenant-a/variationtargeting', ...form('title=t&x=%5Bnull%5D') }, 'rest:variationtargeting.save', undefined, true],
    ['an admin url scan fault, with the form as posted, halted', { url: '/admin/?x=null', ...form('muraAction=+cUsers.list') }, 'admin: cusers.list{scriptprotect=fault}', undefined, true],
    ['a reload key the scan renames, without a reload', { url: '/admin/?muraAction=cUsers.list&amp;appreload' }, 'admin:cusers.list', undefined, false],
    ['a reload key the scan strips, without a reload', { url: '/admin/?muraAction=cUsers.list&app-reload' }, 'admin:cusers.list', undefined, false],
    ['a reload, then its scanned action', { url: '/admin/?appreload&muraAction=%20cUsers.list' }, 'reload:application', 'admin:cusers.list', false],
    ['a reload whose padded processAsyncObject the scan trims', { url: '/?appreload&method=processAsyncObject%20' }, 'reload:application', 'page:render', false],
    ['an amp;-prefixed fuseaction, which sets no action', { url: '/admin/?amp;fuseaction=cUsers.list' }, 'admin:home.redirect', undefined, false],
    ['a hyphenated fuseaction, which sets no action', { url: '/admin/?fuse-action=cUsers.list' }, 'admin:home.redirect', undefined, false],
    ['a fuseaction an amp;-prefixed action replaces', { url: '/admin/?fuseaction=cUsers.list&amp;muraAction=cArch.list' }, 'admin:carch.list', undefined, false],
    ['a padded fuseaction over an action', { url: '/admin/?fuseaction=%20cUsers.list&muraAction=cArch.list' }, 'admin:cusers.list', undefined, false],
    ['a padded posted fuseaction', { url: '/admin/index.cfm', ...form('fuseaction=+cUsers.list+') }, 'admin:cusers.list', undefined, false],
  ])('keys %s as legacy serves it', (_label, sent, key, afterReload, scanFailed) => {
    const outcome = keyOf(sent);
    expect({ key: outcome.result.key, afterReload: outcome.result.afterReload?.key, scanFailed: outcome.scanFailed }).toEqual({ key, afterReload, scanFailed });
  });

  // Halted cases varied between identical requests on the oracle; the rest are deterministic or reach no legacy scan.
  it.each<[string, Sent, string, string | undefined]>([
    ['an admin scan fault', { url: '/admin/?muraAction=cLogin.main&returnURL=zz%3Cscript%3E&q=null' }, 'admin:clogin.main{scriptprotect=fault}', 'admin:clogin.main'],
    ['url names stripped onto one', { url: '/_api/json/v1/tenant-a/?method=findOne&entityname=user&a-b=one&a.b=two' }, 'api:user.findone{scriptprotect=fault}', 'api:user.findone'],
    ['url names renamed onto one', { url: '/?amp%3Bxy=one&xyamp%3B=two' }, 'page:render{scriptprotect=fault}', 'page:render'],
    ['posted names stripped onto one', { url: '/legacy-fixtures/cfml/api.cfm/people/persons', ...form('a-b=one&a.b=two') }, 'fixture:people/persons@post{scriptprotect=fault}', 'fixture:people/persons@post'],
    ['an array nested past the depth the stack decides', { url: `/?q=${'%5B'.repeat(600)}${'%5D'.repeat(600)}` }, 'page:render{scriptprotect=fault}', 'page:render'],
    ['a root-served scan fault, which always answers the error page', { url: '/_api/json/v1/tenant-a/?method=findOne&x=null' }, 'api:.findone', undefined],
    ['names stripped onto one with equal values', { url: '/?a-b=x&a.b=x' }, 'page:render', undefined],
    ['a stripped name over a plain one', { url: '/?foo=x&f-oo=%3Cscript%3Ey%3C/script%3E' }, 'page:render', undefined],
    ['a reload, which legacy always serves', { url: '/admin/?appreload&x=null&a-b=1&a.b=2' }, 'reload:application', undefined],
    ['a target-only path', { url: '/opt2/stub/x?a-b=1&a.b=2' }, 'opt2:/opt2/stub/x', undefined],
    ['a static file', { url: '/admin/assets/x.js?a-b=1&a.b=2' }, 'static:/admin/assets/x.js', undefined],
    ['the bridge, which the edge never reaches', { url: '/gateway/legacy-bridge/cfml/session.cfm?a-b=1&a.b=2' }, 'bridge:/gateway/legacy-bridge/cfml/session.cfm', undefined],
    ['the site monitor, which reads no request value', { url: '/_api/sitemonitor/?a-b=1&a.b=2' }, 'sitemonitor:run', undefined],
  ])('halts %s as its served outcome requires', (_label, sent, key, unhalted) => {
    const outcome = keyOf(sent);
    expect({ key: outcome.result.key, variant: outcome.result.variant, unhalted: outcome.unhalted?.key }).toEqual({
      key,
      variant: unhalted === undefined ? undefined : 'scriptprotect=fault',
      unhalted,
    });
  });

  it('halts in place of a declared variant, keeping it on the unhalted key', () => {
    const variants = [{ route: 'admin:cusers.update', variant: 'type=2,action=Update', when: [{ param: 'type', equals: '2' }, { param: 'action', equals: 'Update' }] }];
    const sent = requestOf({ url: '/admin/?muraAction=cUsers.update', ...form('type=2&action=Update&a-b=one&a.b=two') });
    const outcome = scannedRouteKey(sent, { variants });
    expect([outcome.result.key, outcome.unhalted?.key]).toEqual(['admin:cusers.update{scriptprotect=fault}', 'admin:cusers.update{type=2,action=update}']);
    expect(scannedRouteKey(requestOf({ url: '/admin/?muraAction=cUsers.update', ...form('type=2&action=Update&ab=one') }), { variants }).result.key).toBe(
      'admin:cusers.update{type=2,action=update}',
    );
  });

  it('halts a text field and a file field stripped onto one name, as they share the form scope', () => {
    const sent: RouteKeyRequest = {
      method: 'POST',
      path: '/_api/json/v1/tenant-a/',
      query: {},
      form: { method: 'save', entityname: 'content', 'a-b': 'one' },
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
      multipartFileNames: [{ field: 'a.b', filename: 'a.png' }],
    };
    expect(scannedRouteKey(sent).result.key).toBe('api:content.save{scriptprotect=fault}');
  });

  it('reports the scanned url scope and keys a fault-free request with the key it was sent under', () => {
    const outcome = keyOf({ url: '/_api/rest/v1/tenant-a/content?access_token=%20T%20&amp;client_id=C&x=%3Cscript%3Ex%3C/script%3Ey' });
    expect({ ...outcome.urlScope }).toEqual({ access_token: 'T', x: '[INVALID]y', client_id: 'C' });
    const plain = { method: 'GET', path: '/_api/rest/v1/tenant-a/content', query: { access_token: 'T', client_id: 'C', x: 'y' }, headers: {} };
    expect(keyOf({ url: '/_api/rest/v1/tenant-a/content?access_token=T&client_id=C&x=y' }).result).toEqual(routeKeyForRequest(plain));
  });

  it.each<[string, string | undefined, string]>([
    ['in the order its target sent them', '/_api/json/v1/tenant-a/?q=1&Q=2&q=3', '1,2,3'],
    ['in field order without its target', undefined, '1,3,2'],
  ])('joins url values of names differing only in case %s', (_label, url, joined) => {
    const sent: ScannedRouteKeyRequest = { method: 'GET', path: '/_api/json/v1/tenant-a/', query: { q: ['1', '3'], Q: '2' }, headers: {} };
    expect({ ...scannedRouteKey(url === undefined ? sent : { ...sent, url }).urlScope }).toEqual({ q: joined });
  });

  it.each<[string, string, boolean]>([
    ['a file field name the scan empties', 'amp;-', true],
    ['a file field name the scan keeps', 'up', false],
  ])('fails the scan on %s', (_label, field, scanFailed) => {
    const sent: RouteKeyRequest = {
      method: 'POST',
      path: '/_api/rest/v1/tenant-a/content',
      query: {},
      form: { title: 't' },
      headers: { 'content-type': 'multipart/form-data; boundary=b' },
      multipartFileNames: [{ field, filename: 'a.png' }],
    };
    expect(scannedRouteKey(sent).scanFailed).toBe(scanFailed);
  });

  it.each<[string, string[], string | undefined]>([
    ['a JSON type, which leaves the form unread', [JSON_TYPE, 'text/plain'], undefined],
    ['another type', ['text/plain', JSON_TYPE], 'x'],
  ])('reads the content type under any spelling, repeated values joined: %s', (_label, contentType, title) => {
    const sent: RouteKeyRequest = { method: 'POST', path: '/_api/json/v1/tenant-a/', query: {}, form: { title: 'x' }, headers: { Other: undefined, 'Content-Type': contentType } };
    expect(scannedRouteKey(sent).result.params.title).toBe(title);
  });
});
