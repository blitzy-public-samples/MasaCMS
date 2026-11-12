import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEGACY_SESSION_COOKIE_NAMES, WWW_AUTHENTICATE, cfUuid, parseSetCookie } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSessionCookieTracker,
  normaliseAuth,
  normaliseSetCookies,
  type AuthNormaliseState,
  type CookiePersistence,
  type NormalisedAuth,
} from '../../../src/golden/normalise/cookies.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseUrl } from '../../../src/golden/normalise/values.js';
import type { RecordedResponse } from '../../../src/golden/steps.js';
import type { HttpHop } from '../../../src/lib/http.js';

interface Flow {
  location: string;
  state: AuthNormaliseState;
  auth: NormalisedAuth;
}

const FIXTURE_URL = new URL('../../fixtures/http/set-cookie-login.txt', import.meta.url);
const SET_COOKIE_PREFIX = /^set-cookie:\s*/i;
const REFERENCE_DATE = new Date('2026-06-30T12:00:00Z');
const REFERENCE_DATE_HEADER = 'Tue, 30 Jun 2026 12:00:00 GMT';
const LEGACY_ORIGIN = 'http://127.0.0.1:8500';
const GATEWAY_ORIGIN = 'http://127.0.0.1:8100';
const HTML = 'text/html;charset=UTF-8';
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');

/** Set-Cookie lines of each blank-line-separated fixture block, without comment lines or a `Set-Cookie:` prefix. */
function readBlocks(): string[][] {
  const lines = readFileSync(fileURLToPath(FIXTURE_URL), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'));
  return lines
    .join('\n')
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim().replace(SET_COOKIE_PREFIX, ''))
        .filter((line) => line !== ''),
    )
    .filter((block) => block.length > 0);
}

let rules: NormaliseRules;
let login: string[];
let logout: string[];
let relogin: string[];

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  const blocks = readBlocks();
  expect(blocks).toHaveLength(3);
  [login, logout, relogin] = blocks as [string[], string[], string[]];
});

describe('normaliseSetCookies', () => {
  it('keeps the name, Path, Domain, HttpOnly, Secure, SameSite and persistence of the login cookies', () => {
    const token = rules.auth.cookies.value;
    const cookies = normaliseSetCookies(
      login,
      { hop: 0, referenceDate: REFERENCE_DATE, tracker: createSessionCookieTracker() },
      rules,
    );
    const plainSession = { value: token, path: '/', httpOnly: true, secure: false, persistence: 'session', hop: 0 };
    expect(cookies).toStrictEqual([
      { name: 'CFID', ...plainSession, rotation: 'first' },
      { name: 'CFTOKEN', ...plainSession, rotation: 'first' },
      {
        name: 'JSESSIONID',
        value: token,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        persistence: 'session',
        hop: 0,
        rotation: 'first',
      },
      {
        name: 'userid',
        value: token,
        path: '/',
        domain: '127.0.0.1',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        persistence: 'persistent',
        hop: 0,
      },
    ]);
  });

  it('keeps an empty logout value empty and classifies the epoch expiry as expired', () => {
    const cookies = normaliseSetCookies(
      logout,
      { hop: 0, referenceDate: REFERENCE_DATE, tracker: createSessionCookieTracker() },
      rules,
    );
    expect(cookies).toStrictEqual([
      { name: 'userid', value: '', path: '/', httpOnly: true, secure: false, persistence: 'expired', hop: 0 },
    ]);
  });

  it('agrees with parseSetCookie on every fixture cookie name and kept attribute', () => {
    const sessionNames = new Set<string>(LEGACY_SESSION_COOKIE_NAMES);
    for (const line of [...login, ...logout, ...relogin]) {
      const parsed = parseSetCookie(line);
      const attributes = new Map(parsed.attributes.map(([name, value]) => [name.toLowerCase(), value]));
      const [cookie] = normaliseSetCookies(
        [line],
        { hop: 0, referenceDate: REFERENCE_DATE, tracker: createSessionCookieTracker() },
        rules,
      );
      const domain = attributes.get('domain');
      expect(cookie?.name).toBe(parsed.name);
      expect(cookie?.path).toBe(attributes.get('path'));
      expect(cookie?.domain).toBe(typeof domain === 'string' ? domain.toLowerCase() : domain);
      expect(cookie?.httpOnly).toBe(attributes.has('httponly'));
      expect(cookie?.secure).toBe(attributes.has('secure'));
      expect(cookie?.sameSite).toBe(attributes.get('samesite'));
      expect(cookie !== undefined && 'rotation' in cookie).toBe(sessionNames.has(parsed.name));
    }
  });

  it('folds attribute names, lower-cases Domain, keeps a bare kept attribute as empty text and drops the rest', () => {
    const [cookie] = normaliseSetCookies(
      ['Pref=a; Path=/first; PATH=/admin; DOMAIN=Example.COM; httponly; SECURE; samesite; Priority=High; Partitioned'],
      { hop: 0, referenceDate: REFERENCE_DATE, tracker: createSessionCookieTracker() },
      rules,
    );
    expect(cookie).toStrictEqual({
      name: 'Pref',
      value: rules.auth.cookies.value,
      path: '/admin',
      domain: 'example.com',
      httpOnly: true,
      secure: true,
      sameSite: '',
      persistence: 'session',
      hop: 0,
    });
  });

  it.each<{ label: string; line: string; referenceDate: Date | undefined; expected: CookiePersistence }>([
    { label: 'no Max-Age or Expires', line: 'a=1; Path=/', referenceDate: REFERENCE_DATE, expected: 'session' },
    { label: 'a positive Max-Age', line: 'a=1; Max-Age=60', referenceDate: REFERENCE_DATE, expected: 'persistent' },
    { label: 'a zero Max-Age', line: 'a=1; Max-Age=0', referenceDate: REFERENCE_DATE, expected: 'expired' },
    { label: 'a negative Max-Age', line: 'a=1; Max-Age=-1', referenceDate: REFERENCE_DATE, expected: 'expired' },
    {
      label: 'a positive Max-Age over an earlier Expires',
      line: 'a=1; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=60',
      referenceDate: REFERENCE_DATE,
      expected: 'persistent',
    },
    {
      label: 'an unparseable Max-Age beside an earlier Expires',
      line: 'a=1; Max-Age=soon; Expires=Thu, 01-Jan-1970 00:00:00 GMT',
      referenceDate: REFERENCE_DATE,
      expected: 'expired',
    },
    { label: 'a bare Max-Age', line: 'a=1; Max-Age', referenceDate: REFERENCE_DATE, expected: 'session' },
    {
      label: 'an Expires after the reference date',
      line: 'a=1; Expires=Wed, 01-Jul-2026 12:00:00 GMT',
      referenceDate: REFERENCE_DATE,
      expected: 'persistent',
    },
    {
      label: 'an Expires before the reference date',
      line: 'a=1; expires=Mon, 29-Jun-2026 12:00:00 GMT',
      referenceDate: REFERENCE_DATE,
      expected: 'expired',
    },
    {
      label: 'an unparseable Expires',
      line: 'a=1; Expires=someday',
      referenceDate: REFERENCE_DATE,
      expected: 'session',
    },
    {
      label: 'an epoch Expires without a reference date',
      line: 'a=1; Expires=Thu, 01-Jan-1970 00:00:00 GMT',
      referenceDate: undefined,
      expected: 'expired',
    },
    {
      label: 'a 2026 Expires without a reference date',
      line: 'a=1; Expires=Mon, 29-Jun-2026 12:00:00 GMT',
      referenceDate: undefined,
      expected: 'persistent',
    },
  ])('classifies $label as $expected', ({ line, referenceDate, expected }) => {
    const tracker = createSessionCookieTracker();
    const [cookie] = normaliseSetCookies([line], { hop: 0, referenceDate, tracker }, rules);
    expect(cookie?.persistence).toBe(expected);
  });

  it.each<{ keep: string[]; from: string[]; line: string; httpOnly: boolean; secure: boolean }>([
    {
      keep: ['HttpOnly'],
      from: ['Expires'],
      line: 'a=1; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly; Max-Age=0',
      httpOnly: true,
      secure: false,
    },
    {
      keep: ['Secure'],
      from: ['Max-Age'],
      line: 'a=1; Path=/; Domain=example.com; SameSite=Lax; Secure; HttpOnly; Expires=Thu, 01-Jan-1970 00:00:00 GMT',
      httpOnly: false,
      secure: true,
    },
  ])(
    'keeps only the $keep attributes and reads persistence only from $from',
    ({ keep, from, line, httpOnly, secure }) => {
      const cookieRule = rules.auth.cookies;
      const narrowed: NormaliseRules = {
        ...rules,
        auth: {
          ...rules.auth,
          cookies: { ...cookieRule, keepAttributes: keep, persistence: { ...cookieRule.persistence, from } },
        },
      };
      const normalised = normaliseSetCookies(
        [line],
        { hop: 0, referenceDate: REFERENCE_DATE, tracker: createSessionCookieTracker() },
        narrowed,
      );
      expect(normalised).toStrictEqual([
        { name: 'a', value: cookieRule.value, httpOnly, secure, persistence: 'session', hop: 0 },
      ]);
    },
  );

  it('masks every non-empty value with the token placeholder and never emits a raw value', () => {
    expect(rules.auth.cookies.value).toBe('<token>');
    const tracker = createSessionCookieTracker();
    for (const block of [login, logout, relogin]) {
      const cookies = normaliseSetCookies(block, { hop: 0, referenceDate: REFERENCE_DATE, tracker }, rules);
      const output = JSON.stringify(cookies);
      for (const line of block) {
        const { name, value } = parseSetCookie(line);
        expect(cookies.find((cookie) => cookie.name === name)?.value).toBe(value === '' ? '' : '<token>');
        if (value !== '') expect(output).not.toContain(value);
      }
    }
  });

  it('classifies session cookie rotation across login, logout and a second login with one tracker', () => {
    const tracker = createSessionCookieTracker();
    const options = { hop: 0, referenceDate: REFERENCE_DATE, tracker };
    const first = normaliseSetCookies(login, options, rules);
    expect(first.map(({ name, rotation }) => [name, rotation])).toStrictEqual([
      ['CFID', 'first'],
      ['CFTOKEN', 'first'],
      ['JSESSIONID', 'first'],
      ['userid', undefined],
    ]);
    expect(first.find((cookie) => cookie.name === 'userid')).not.toHaveProperty('rotation');
    expect([...tracker.keys()]).toStrictEqual(['cfid', 'cftoken', 'jsessionid']);

    const afterLogin = new Map(tracker);
    const cleared = normaliseSetCookies(logout, options, rules);
    expect(cleared[0]).not.toHaveProperty('rotation');
    expect(tracker).toStrictEqual(afterLogin);

    const second = normaliseSetCookies(relogin, options, rules);
    expect(second.map(({ name, rotation }) => [name, rotation])).toStrictEqual([
      ['CFID', 'same'],
      ['CFTOKEN', 'same'],
      ['JSESSIONID', 'same'],
    ]);

    expect(normaliseSetCookies(['CFID=1002;path=/;HttpOnly;'], options, rules)[0]?.rotation).toBe('changed');
    expect(normaliseSetCookies(['cfid=1002;path=/;HttpOnly;'], options, rules)[0]?.rotation).toBe('same');

    const fresh = normaliseSetCookies(relogin, { ...options, tracker: createSessionCookieTracker() }, rules);
    expect(fresh.map(({ name, rotation }) => [name, rotation])).toStrictEqual([
      ['CFID', 'first'],
      ['CFTOKEN', 'first'],
      ['JSESSIONID', 'first'],
    ]);
  });

  it('records the hop on every cookie and sorts by hop, name and path in code-unit order', () => {
    const tracker = createSessionCookieTracker();
    const cookies = normaliseSetCookies(['b=2; Path=/z', 'B=1', 'a=1; Path=/', 'b=3'], { hop: 4, tracker }, rules);
    expect(cookies.map(({ name, path, hop }) => [name, path, hop])).toStrictEqual([
      ['B', undefined, 4],
      ['a', '/', 4],
      ['b', undefined, 4],
      ['b', '/z', 4],
    ]);
    const fixture = normaliseSetCookies(login, { hop: 2, referenceDate: REFERENCE_DATE, tracker }, rules);
    expect(fixture.map(({ hop }) => hop)).toStrictEqual([2, 2, 2, 2]);
  });
});

describe('normaliseAuth', () => {
  let legacy: Flow;
  let gateway: Flow;

  beforeAll(() => {
    [legacy, gateway] = [LEGACY_ORIGIN, GATEWAY_ORIGIN].map((origin, side): Flow => {
      const requested = `${origin}/admin/?muraAction=cArch.list&siteid=default`;
      const returnURL = encodeURIComponent(requested);
      const location = `${origin}/admin/?muraAction=cLogin.main&returnURL=${returnURL}&userid=${cfUuid()}`;
      const setCookie = login.map((line) => {
        const { name } = parseSetCookie(line);
        return side === 0 ? line : line.replace(`${name}=`, `${name}=replay-`);
      });
      const finalHeaders = {
        date: REFERENCE_DATE_HEADER,
        'content-type': HTML,
        'set-cookie': setCookie,
        'www-authenticate': WWW_AUTHENTICATE.bearerInvalidAccessToken,
      };
      const hops: HttpHop[] = [
        {
          method: 'GET',
          url: requested,
          status: 302,
          location,
          setCookie: [],
          requestHeaders: {},
          responseHeaders: { date: REFERENCE_DATE_HEADER, location },
        },
        { method: 'GET', url: location, status: 200, setCookie, requestHeaders: {}, responseHeaders: finalHeaders },
      ];
      const response: RecordedResponse = {
        status: 200,
        headers: finalHeaders,
        contentType: HTML,
        sha256: EMPTY_BODY_SHA256,
        hops,
        text: '',
      };
      const state: AuthNormaliseState = { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
      return { location, state, auth: normaliseAuth(response, state, rules) };
    }) as [Flow, Flow];
  });

  it('returns the final WWW-Authenticate value verbatim and the normalised Location of each redirect hop', () => {
    for (const flow of [legacy, gateway]) {
      expect(flow.auth.wwwAuthenticate).toStrictEqual([WWW_AUTHENTICATE.bearerInvalidAccessToken]);
      expect(flow.auth.redirectTargets).toStrictEqual([
        { status: 302, location: normaliseUrl(flow.location, createIdOrdinals(), rules) },
      ]);
      expect(flow.auth.redirectTargets[0]?.location).toBe(
        '<origin>/admin/?muraAction=clogin.main' +
          '&returnURL=http%3A%2F%2F<origin>%2Fadmin%2F%3FmuraAction%3DcArch.list%26siteid%3Ddefault&userid=<id:1>',
      );
    }
  });

  it('reads each hop cookie against the hop Date header and updates the side tracker', () => {
    const tracker = createSessionCookieTracker();
    expect(legacy.auth.cookies).toStrictEqual(
      normaliseSetCookies(login, { hop: 1, referenceDate: REFERENCE_DATE, tracker }, rules),
    );
    expect([...legacy.state.sessionCookies.keys()]).toStrictEqual(['cfid', 'cftoken', 'jsessionid']);
  });

  it('gives legacy and gateway flows with different ids and cookie values the same view', () => {
    expect(gateway.location).not.toBe(legacy.location);
    expect(gateway.state.sessionCookies).not.toStrictEqual(legacy.state.sessionCookies);
    expect(gateway.auth).toStrictEqual(legacy.auth);
  });

  it('classifies Expires against each hop Date header, or the 1971 reference when a hop has none', () => {
    const line = 'remember=1; Expires=Thu, 01-Jan-2026 00:00:00 GMT; Path=/';
    const hops: HttpHop[] = [
      {
        method: 'POST',
        url: `${LEGACY_ORIGIN}/admin/index.cfm`,
        status: 302,
        location: '/admin/',
        setCookie: [line],
        requestHeaders: {},
        responseHeaders: { date: REFERENCE_DATE_HEADER, location: '/admin/', 'set-cookie': [line] },
      },
      {
        method: 'GET',
        url: `${LEGACY_ORIGIN}/admin/`,
        status: 200,
        setCookie: [line],
        requestHeaders: {},
        responseHeaders: { 'set-cookie': [line] },
      },
    ];
    const response: RecordedResponse = {
      status: 200,
      headers: { 'set-cookie': [line] },
      contentType: HTML,
      sha256: EMPTY_BODY_SHA256,
      hops,
      text: '',
    };
    const state: AuthNormaliseState = { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
    const { cookies } = normaliseAuth(response, state, rules);
    expect(cookies.map(({ name, hop, persistence }) => [name, hop, persistence])).toStrictEqual([
      ['remember', 0, 'expired'],
      ['remember', 1, 'persistent'],
    ]);
  });

  it.each<{ status: number; redirects: boolean }>([
    { status: 301, redirects: true },
    { status: 302, redirects: true },
    { status: 303, redirects: true },
    { status: 307, redirects: true },
    { status: 200, redirects: false },
    { status: 201, redirects: false },
  ])(
    'reads the own Set-Cookie of a hopless $status response, and its Location only for a redirect status',
    ({ status, redirects }) => {
      const location = '/admin/?muraAction=cLogin.main';
      const response: RecordedResponse = {
        status,
        headers: { 'set-cookie': [...login], location },
        contentType: HTML,
        sha256: EMPTY_BODY_SHA256,
        hops: [],
        text: '',
      };
      const state: AuthNormaliseState = { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
      const auth = normaliseAuth(response, state, rules);
      expect(auth.cookies).toStrictEqual(
        normaliseSetCookies(login, { hop: 0, tracker: createSessionCookieTracker() }, rules),
      );
      expect(auth.redirectTargets).toStrictEqual(
        redirects ? [{ status, location: normaliseUrl(location, createIdOrdinals(), rules) }] : [],
      );
    },
  );

  it('keeps every WWW-Authenticate value of the final response in order', () => {
    const response: RecordedResponse = {
      status: 401,
      headers: { 'www-authenticate': [WWW_AUTHENTICATE.bearerInvalidAccessToken, WWW_AUTHENTICATE.bearer] },
      contentType: 'application/json',
      sha256: EMPTY_BODY_SHA256,
      hops: [],
      text: '',
    };
    const state: AuthNormaliseState = { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
    expect(normaliseAuth(response, state, rules).wwwAuthenticate).toStrictEqual([
      WWW_AUTHENTICATE.bearerInvalidAccessToken,
      WWW_AUTHENTICATE.bearer,
    ]);
  });

  it('returns no cookies, WWW-Authenticate values or redirect targets for a response without them', () => {
    const response: RecordedResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      contentType: 'application/json',
      sha256: EMPTY_BODY_SHA256,
      hops: [],
      text: '',
    };
    const state: AuthNormaliseState = { ids: createIdOrdinals(), sessionCookies: createSessionCookieTracker() };
    expect(normaliseAuth(response, state, rules)).toStrictEqual({
      cookies: [],
      wwwAuthenticate: [],
      redirectTargets: [],
    });
    expect(state.sessionCookies.size).toBe(0);
  });
});
