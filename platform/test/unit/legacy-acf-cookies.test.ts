// Tests of the ACF 2023 `expires="never"` cookie formats: cookie-scope struct assignments and <cfcookie>.
import { describe, expect, it } from 'vitest';
import { cfcookieNeverCookie, cookieScopeNeverCookie } from '../../src/legacy-compat/acf-cookies.js';

type Writer = typeof cookieScopeNeverCookie;

// Oracle: Set-Cookie headers ACF 2023.0.26 wrote on this host (TZ=UTC) for `param name="cookie.rb" default={…}`,
// `cookie.rb={…}` and `<cfcookie attributeCollection={…, expires="never", httpOnly=false, preserveCase=true}>`.
// Expires is now + 946080000 s; the cookie scope prints its hour 01-12 without AM/PM, <cfcookie> 00-23.
describe('expires="never" cookies', () => {
  it.each<[label: string, write: Writer, name: string, value: string, secure: boolean, now: string, expected: string]>([
    [
      'a cookie-scope default',
      cookieScopeNeverCookie,
      'rb',
      '',
      false,
      '2026-11-16T20:57:22.987Z',
      'rb=; Max-Age=946080000; Expires=Wed, 08-Nov-2056 08:57:22 GMT; Path=/; HttpOnly; SameSite=Lax',
    ],
    [
      'a secure cookie-scope assignment',
      cookieScopeNeverCookie,
      'RB',
      'pt%5FBR',
      true,
      '2026-11-16T20:57:22Z',
      'RB=pt%5FBR; Max-Age=946080000; Expires=Wed, 08-Nov-2056 08:57:22 GMT; Path=/; Secure; HttpOnly; SameSite=Lax',
    ],
    [
      'a cookie-scope assignment in the midnight hour',
      cookieScopeNeverCookie,
      'RB',
      'de',
      false,
      '2026-11-16T00:04:04Z',
      'RB=de; Max-Age=946080000; Expires=Wed, 08-Nov-2056 12:04:04 GMT; Path=/; HttpOnly; SameSite=Lax',
    ],
    [
      'a cookie-scope assignment in the noon hour',
      cookieScopeNeverCookie,
      'RB',
      'de',
      false,
      '2026-11-16T12:04:04Z',
      'RB=de; Max-Age=946080000; Expires=Wed, 08-Nov-2056 12:04:04 GMT; Path=/; HttpOnly; SameSite=Lax',
    ],
    [
      'a cookie-scope assignment in the morning',
      cookieScopeNeverCookie,
      'RB',
      'de',
      false,
      '2026-11-16T09:30:00Z',
      'RB=de; Max-Age=946080000; Expires=Wed, 08-Nov-2056 09:30:00 GMT; Path=/; HttpOnly; SameSite=Lax',
    ],
    [
      'a cfcookie',
      cfcookieNeverCookie,
      'ADMINSIDEBAR',
      'off',
      false,
      '2026-11-16T20:57:23.501Z',
      'ADMINSIDEBAR=off; path=/; Max-Age=946080000; Expires=Wed, 08-Nov-2056 20:57:23 GMT',
    ],
    [
      'a secure cfcookie',
      cfcookieNeverCookie,
      'ADMINCONTROLWIDTH',
      '300',
      true,
      '2026-11-16T20:57:23Z',
      'ADMINCONTROLWIDTH=300; path=/; secure; Max-Age=946080000; Expires=Wed, 08-Nov-2056 20:57:23 GMT',
    ],
    [
      'a cfcookie in the midnight hour',
      cfcookieNeverCookie,
      'ADMINSIDEBAR',
      'off',
      false,
      '2026-11-16T00:04:04Z',
      'ADMINSIDEBAR=off; path=/; Max-Age=946080000; Expires=Wed, 08-Nov-2056 00:04:04 GMT',
    ],
  ])('writes %s as ACF does', (_label, write, name, value, secure, now, expected) => {
    expect(write(name, value, secure, new Date(now))).toBe(expected);
  });

  // Oracle: utility.setCookie's <cfcookie httpOnly=true> of the request start, and <cfcookie preserveCase=true> with
  // secure, domain and httpOnly combined, as ACF 2023 wrote them on this host.
  it.each<[label: string, name: string, value: string, secure: boolean, httpOnly: boolean, domain: string, now: string, expected: string]>([
    [
      'an HttpOnly cfcookie',
      'MXP_TRACKINGID',
      '3AA8C316%2DBB6C%2D6E65%2D2BD4F00C816B4752',
      false,
      true,
      '',
      '2026-11-18T01:27:26.402Z',
      'MXP_TRACKINGID=3AA8C316%2DBB6C%2D6E65%2D2BD4F00C816B4752; path=/; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 01:27:26 GMT',
    ],
    [
      'an HttpOnly cfcookie in the midnight hour',
      'mobileFormat',
      'false',
      false,
      true,
      '',
      '2026-11-18T00:30:21Z',
      'mobileFormat=false; path=/; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 00:30:21 GMT',
    ],
    [
      'a secure HttpOnly cfcookie',
      'mobileFormat',
      'true',
      true,
      true,
      '',
      '2026-11-18T13:00:00Z',
      'mobileFormat=true; path=/; secure; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 13:00:00 GMT',
    ],
    [
      'a secure HttpOnly cfcookie with a domain',
      'ProbeA',
      'a%2D1',
      true,
      true,
      '.localhost',
      '2026-11-18T02:36:29Z',
      'ProbeA=a%2D1; path=/; domain=.localhost; secure; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 02:36:29 GMT',
    ],
    [
      'an HttpOnly cfcookie with a domain',
      'ProbeB',
      'b%2D1',
      false,
      true,
      '.localhost',
      '2026-11-18T02:36:29Z',
      'ProbeB=b%2D1; path=/; domain=.localhost; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 02:36:29 GMT',
    ],
    [
      'a secure HttpOnly cfcookie with a blank domain',
      'ProbeC',
      'c%2D1',
      true,
      true,
      '',
      '2026-11-18T02:36:29Z',
      'ProbeC=c%2D1; path=/; secure; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 02:36:29 GMT',
    ],
    [
      'a secure cfcookie with a domain',
      'ProbeD',
      'd%2D1',
      true,
      false,
      '.localhost',
      '2026-11-18T02:36:29Z',
      'ProbeD=d%2D1; path=/; domain=.localhost; secure; Max-Age=946080000; Expires=Fri, 10-Nov-2056 02:36:29 GMT',
    ],
    [
      'an HttpOnly cfcookie with a domain without a leading dot',
      'ProbeB',
      'b%2D1',
      false,
      true,
      'localhost',
      '2026-11-18T02:36:29Z',
      'ProbeB=b%2D1; path=/; domain=localhost; HttpOnly; Max-Age=946080000; Expires=Fri, 10-Nov-2056 02:36:29 GMT',
    ],
  ])('writes %s as ACF does', (_label, name, value, secure, httpOnly, domain, now, expected) => {
    expect(cfcookieNeverCookie(name, value, secure, new Date(now), httpOnly, domain)).toBe(expected);
  });
});
