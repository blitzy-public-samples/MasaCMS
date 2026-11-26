// Tests of the request start's MXP_TRACKINGID and mobileFormat cookies.
import { describe, expect, it } from 'vitest';
import {
  REQUEST_START_COOKIE_NAMES,
  cfUrlEncodedFormat,
  requestStartSetCookies,
  type RequestStartOptions,
  type RequestStartRequest,
} from '../../src/legacy-compat/index.js';

// Oracle: Set-Cookie headers Masa 7.6.1 on ACF 2023.0.26 sent this host (TZ=UTC) for GET / and the admin.
const NOW = new Date('2026-11-18T01:27:26.402Z');
const ID = '3AA8C316-BB6C-6E65-2BD4F00C816B4752';
const CURL = 'curl/8.14.1';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile';

const cookie = (pair: string, attributes = ''): string =>
  `${pair}; path=/; ${attributes}HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 01:27:26 GMT`;
const TRACK = cookie('MXP_TRACKINGID=3AA8C316%2DBB6C%2D6E65%2D2BD4F00C816B4752');
const DESKTOP = cookie('mobileFormat=false');

function startCookies(req: Partial<RequestStartRequest>, settings: Pick<RequestStartOptions, 'secure' | 'domain'> = {}): string[] {
  return requestStartSetCookies({ userAgent: CURL, sessionManaged: true, ...req }, { now: NOW, newId: () => ID, ...settings });
}

describe('requestStartSetCookies', () => {
  it.each<[label: string, cookieHeader: string | undefined, expected: string[]]>([
    ['a cookieless request', undefined, [TRACK, DESKTOP]],
    ['a request holding both cookies', 'CFID=1; MXP_TRACKINGID=X; mobileFormat=false', []],
    ['empty and other-case values, which still count', 'mxp_trackingid=; mobileformat=TRUE', []],
    ['a non-boolean mobileFormat cookie', 'MXP_TRACKINGID=X; mobileFormat=x', []],
    ['names without `=`, which the container drops', 'MXP_TRACKINGID; mobileFormat', [TRACK, DESKTOP]],
    ['spaces around `=`, which change the names', ' mobileFormat = true ;MXP_TRACKINGID = 2', [TRACK, DESKTOP]],
    ['a comma, which ends the pair', 'mobileFormat=true, MXP_TRACKINGID=1', [TRACK]],
    ['an unclosed quote, which drops the pair', 'mobileFormat="tr ue"; MXP_TRACKINGID="x', [TRACK]],
    ['version attributes beside the cookies', '$Version=1; mobileFormat=true; $Path=/; MXP_TRACKINGID=1', []],
    ['a value holding `=`', 'mobileFormat=a=b; MXP_TRACKINGID=1', []],
  ])('answers %s', (_label, cookieHeader, expected) => {
    expect(startCookies({ cookieHeader })).toEqual(expected);
  });

  it.each<[raw: string, encoded: string]>([
    ['originalURLToken=a%2Bb+c%41', 'a%2Bb%20cA'],
    ['originalURLToken=x-y.z_~', 'x%2Dy%2Ez%5F%7E'],
    ['originalURLToken=%E2%82%AC%zz%', '%E2%82%AC%25zz%25'],
    ['originalURLToken=%C3', '%EF%BF%BD'],
    ['originalURLToken=%2', '%252'],
    ['originalURLToken=%41%', 'A%25'],
    ['originalURLToken=a=b', 'a'],
    ['originalURLToken=a b', 'a'],
    ['originalURLToken=a,b', 'a'],
    ['originalURLToken="qv"', 'qv'],
    ['originalURLToken=1; originalURLToken=2', '1'],
    ['ORIGINALURLTOKEN=zz', 'zz'],
  ])('tracks %s as MXP_TRACKINGID=%s', (raw, encoded) => {
    expect(startCookies({ cookieHeader: `${raw}; mobileFormat=x` })).toEqual([cookie(`MXP_TRACKINGID=${encoded}`)]);
  });

  it.each<[userAgent: string | undefined, mobile: boolean]>([
    [CURL, false],
    [undefined, false],
    [IPHONE, true],
    ['Mozilla/5.0 (X11; IPHONE emulator)', true],
    ['Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36', true],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Mobile/15E148', false],
    ['Mozilla/5.0 (Linux; Android 14; Tablet) Mobile', false],
    ['Mozilla/5.0 (Android; Xoom) Mobile', false],
  ])('detects user agent %j as mobile: %s', (userAgent, mobile) => {
    expect(startCookies({ cookieHeader: 'MXP_TRACKINGID=X', userAgent })).toEqual([cookie(`mobileFormat=${mobile}`)]);
  });

  it.each<[label: string, req: Partial<RequestStartRequest>, expected: string[]]>([
    [
      'a boolean url value over the cookie',
      { cookieHeader: 'MXP_TRACKINGID=X; mobileFormat=false', query: { mobileFormat: 'yes' } },
      [cookie('mobileFormat=yes')],
    ],
    [
      'a boolean form value over the url value',
      { cookieHeader: 'MXP_TRACKINGID=X', query: { mobileFormat: 'false' }, form: { MOBILEFORMAT: 'true' } },
      [cookie('mobileFormat=true')],
    ],
    [
      'the url value after a non-boolean form value',
      { cookieHeader: 'MXP_TRACKINGID=X', query: { mobileFormat: 'no' }, form: { mobileFormat: 'maybe' } },
      [cookie('mobileFormat=no')],
    ],
    [
      'a multipart field part',
      {
        cookieHeader: 'MXP_TRACKINGID=X; mobileFormat=false',
        form: { mobileFormat: { type: 'field', fieldname: 'mobileFormat', value: '0' } },
      },
      [cookie('mobileFormat=0')],
    ],
    [
      'a numeric url value, URL-encoded',
      { cookieHeader: 'MXP_TRACKINGID=X; mobileFormat=false', query: { mobileFormat: '1.5' } },
      [cookie('mobileFormat=1%2E5')],
    ],
    [
      'repeated url values, which join into a non-boolean, without a cookie',
      { cookieHeader: 'MXP_TRACKINGID=X', userAgent: IPHONE, query: { mobileFormat: ['no', 'no'] } },
      [cookie('mobileFormat=true')],
    ],
    [
      'url names differing in case, which join into a non-boolean, beside a cookie',
      {
        cookieHeader: 'MXP_TRACKINGID=X; mobileFormat=true',
        query: { mobileFormat: 'true', MobileFormat: 'false' },
        url: '/?mobileFormat=true&MobileFormat=false',
      },
      [],
    ],
    [
      'an admin preview, which skips mobileFormat',
      { query: { MuraAdminPreview: '', mobileFormat: 'true' } },
      [TRACK],
    ],
  ])('sets mobileFormat from %s', (_label, req, expected) => {
    expect(startCookies(req)).toEqual(expected);
  });

  it('sets nothing on a request without session management', () => {
    expect(startCookies({ sessionManaged: false, query: { mobileFormat: 'true' } })).toEqual([]);
  });

  it.each<[label: string, settings: Pick<RequestStartOptions, 'secure' | 'domain'>, attributes: string]>([
    ['secure under secureCookies', { secure: true }, 'secure; '],
    ['with the cookieDomain', { domain: '.localhost' }, 'domain=.localhost; '],
    ['secure with the cookieDomain under both', { secure: true, domain: '.localhost' }, 'domain=.localhost; secure; '],
    ['with a cookieDomain lacking a leading dot as given', { domain: 'localhost' }, 'domain=localhost; '],
    ['without a domain under a blank cookieDomain', { secure: false, domain: '' }, ''],
  ])('marks both cookies %s', (_label, settings, attributes) => {
    expect(startCookies({ userAgent: IPHONE }, settings)).toEqual([
      cookie('MXP_TRACKINGID=3AA8C316%2DBB6C%2D6E65%2D2BD4F00C816B4752', attributes),
      cookie('mobileFormat=true', attributes),
    ]);
  });

  it('tracks a new session under a new CF UUID by default', () => {
    const [tracking] = requestStartSetCookies({ sessionManaged: true }, { now: NOW });
    expect(tracking).toMatch(/^MXP_TRACKINGID=[0-9A-F]{8}%2D[0-9A-F]{4}%2D[0-9A-F]{4}%2D[0-9A-F]{16}; path=\/; HttpOnly; /);
  });

  it('names the cookies it sets', () => {
    expect([...REQUEST_START_COOKIE_NAMES]).toEqual(['mxp_trackingid', 'mobileformat']);
  });
});

describe('cfUrlEncodedFormat', () => {
  it.each<[string, string]>([
    ['', ''],
    ['Az09', 'Az09'],
    ['a b-c_d.e~', 'a%20b%2Dc%5Fd%2Ee%7E'],
    ['€', '%E2%82%AC'],
    ['😀', '%F0%9F%98%80'],
    ['a\uD800b', 'a%3Fb'],
  ])('encodes %j as %s', (value, expected) => {
    expect(cfUrlEncodedFormat(value)).toBe(expected);
  });
});
