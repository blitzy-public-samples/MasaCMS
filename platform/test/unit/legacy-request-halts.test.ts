// Tests the halts the request alone decides beyond unstorable text: a Site Manager list of an unregistered site and a login redirect Node cannot send.
import { describe, expect, it } from 'vitest';
import {
  NUL_TEXT_HALT_VARIANT,
  RAW_LOCATION_HALT_VARIANT,
  SHARED_ID_SORT_CONDITIONS,
  UNREGISTERED_SITE_HALT_VARIANT,
  haltedRouteKey,
  textHaltedRouteKey,
  type RouteKeyOptions,
  type ScannedRouteKeyRequest,
} from '../../src/legacy-compat/index.js';

const URLENCODED = 'application/x-www-form-urlencoded';
const ADMIN = '/admin/index.cfm';
const LIST = 'admin:carch.list';
const LOGIN = 'admin:clogin.login';
const REGISTERED = new Set(['default', 'tenant-a']);
/** The gateway's registry over two sites, matched without case, and the variants of both keys the cut-over table declares. */
const OPTIONS: RouteKeyOptions = {
  siteExists: (siteId) => REGISTERED.has(siteId.toLowerCase()),
  variants: [
    { route: LIST, variant: 'sharedid', when: SHARED_ID_SORT_CONDITIONS },
    { route: LOGIN, variant: 'status=sendlogin', when: [{ param: 'status', equals: 'sendLogin' }] },
  ],
};

/** A POST of url-encoded `form` to `url`, keyed as the gateway keys it. */
function post(url: string, form: Record<string, string> = {}): ScannedRouteKeyRequest {
  const at = url.indexOf('?');
  return {
    url,
    method: 'POST',
    path: at === -1 ? url : url.slice(0, at),
    query: Object.fromEntries(new URLSearchParams(at === -1 ? '' : url.slice(at + 1))),
    form,
    headers: { 'content-type': URLENCODED },
  };
}

/** A login form whose `name` holds `value`, with the credentials clogin reads. */
function login(name: string, value: string): ScannedRouteKeyRequest {
  return post(`${ADMIN}?muraAction=cLogin.login`, { username: 'admin', password: 'x', isAdminLogin: 'true', [name]: value });
}

describe('haltedRouteKey', () => {
  it.each<[string, ScannedRouteKeyRequest, string]>([
    ['a url siteid no site registers', post(`${ADMIN}?muraAction=cArch.list&siteid=nosuchsite`), UNREGISTERED_SITE_HALT_VARIANT],
    ['a path-pair siteid no site registers', post(`${ADMIN}/carch/list/siteid/nosuchsite`), UNREGISTERED_SITE_HALT_VARIANT],
    ['a form siteid replacing a registered url one', post(`${ADMIN}?muraAction=cArch.list&siteid=default`, { siteid: 'nosuchsite' }), UNREGISTERED_SITE_HALT_VARIANT],
    ['a path-pair siteid with a trailing space, which no scan trims', post(`${ADMIN}/carch/list/siteid/default%20`), UNREGISTERED_SITE_HALT_VARIANT],
    ['a DEL in returnUrl', login('returnUrl', './?x=\u007f'), RAW_LOCATION_HALT_VARIANT],
    ['U+0100, whose low byte is NUL, in linkServID', login('linkServID', 'a\u0100b'), RAW_LOCATION_HALT_VARIANT],
    ['U+017F, whose low byte is DEL, in contentid', login('contentid', 'a\u017fb'), RAW_LOCATION_HALT_VARIANT],
    ['an astral character, whose low surrogate has a NUL low byte, in rememberMe', login('rememberMe', '\u{1f600}'), RAW_LOCATION_HALT_VARIANT],
    ['U+011B, whose low byte is ESC, in a returnUrl url value', post(`${ADMIN}?muraAction=cLogin.login&returnUrl=%C4%9B`, { username: 'a', password: 'b' }), RAW_LOCATION_HALT_VARIANT],
  ])('halts %s under its variant, keeping the listed key as unhalted', (_label, sent, variant) => {
    const { result, unhalted } = haltedRouteKey(sent, OPTIONS);
    const base = textHaltedRouteKey(sent, OPTIONS).result;

    expect([result.key, result.variant, unhalted?.key]).toStrictEqual([`${base.key}{${variant}}`, variant, base.key]);
    expect(result.params).toStrictEqual(base.params);
  });

  it.each<[string, ScannedRouteKeyRequest, RouteKeyOptions, string]>([
    ['a registered siteid', post(`${ADMIN}?muraAction=cArch.list&siteid=tenant-a`), OPTIONS, LIST],
    ['a registered siteid in another case', post(`${ADMIN}?muraAction=cArch.list&siteid=TENANT-A`), OPTIONS, LIST],
    ['a url siteid with a trailing space, which the scan trims', post(`${ADMIN}?muraAction=cArch.list&siteid=default%20`), OPTIONS, LIST],
    ["an empty siteid, which takes the session's site", post(`${ADMIN}?muraAction=cArch.list&siteid=`), OPTIONS, LIST],
    ['no siteid', post(`${ADMIN}?muraAction=cArch.list`), OPTIONS, LIST],
    ['a registered form siteid replacing an unregistered url one', post(`${ADMIN}?muraAction=cArch.list&siteid=nosuchsite`, { siteid: 'default' }), OPTIONS, LIST],
    ['an unregistered siteid without a site registry', post(`${ADMIN}?muraAction=cArch.list&siteid=nosuchsite`), {}, LIST],
    ['another action of an unregistered site', post(`${ADMIN}?muraAction=cArch.edit&siteid=nosuchsite`), OPTIONS, 'admin:carch.edit'],
    ['a shared-id sort of an unregistered site, already its legacy variant', post(`${ADMIN}?muraAction=cArch.list&siteid=nosuchsite`, { orderperm: 'editor', topid: '' }), OPTIONS, `${LIST}{sharedid}`],
    ['a path-pair NUL, already halted as text', post(`${ADMIN}/carch/list/siteid/no%00site`), OPTIONS, `${LIST}{${NUL_TEXT_HALT_VARIANT}}`],
    ['a plain login', login('returnUrl', './?muraAction=cArch.list'), OPTIONS, LOGIN],
    ['a C0 control in returnUrl, which ACF escapes', login('returnUrl', 'a\u0001b'), OPTIONS, LOGIN],
    ['U+0109, whose TAB byte Node sends', login('contentid', 'a\u0109b'), OPTIONS, LOGIN],
    ['U+010A, whose LF byte legacy sends as a space', login('linkServID', 'a\u010ab'), OPTIONS, LOGIN],
    ['a DEL in a value no redirect carries', login('username', 'a\u007fb'), OPTIONS, LOGIN],
    [
      'a DEL in a send-login request, already its legacy variant',
      post(`${ADMIN}?muraAction=cLogin.login`, { status: 'sendLogin', email: 'a@example.org', returnUrl: '\u007f' }),
      OPTIONS,
      `${LOGIN}{status=sendlogin}`,
    ],
    ['a DEL in another action', post(`${ADMIN}?muraAction=cLogin.main&returnUrl=%7F`), OPTIONS, 'admin:clogin.main'],
  ])('keys %s as textHaltedRouteKey does', (_label, sent, options, key) => {
    const keyed = haltedRouteKey(sent, options);

    expect(keyed).toStrictEqual(textHaltedRouteKey(sent, options));
    expect(keyed.result.key).toBe(key);
  });

  it('never halts a reload, which legacy always serves', () => {
    const sent = post(`${ADMIN}?muraAction=cArch.list&siteid=nosuchsite&appreload`);
    const keyed = haltedRouteKey(sent, OPTIONS);

    expect([keyed.result.key, keyed.result.afterReload?.key, keyed.unhalted]).toStrictEqual(['reload:application', LIST, undefined]);
  });
});
