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
});
