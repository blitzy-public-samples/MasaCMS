// Session cookie jar flow through the legacy-compat barrel; per-function cases for cookies.ts are in cookies.test.ts.
import { describe, expect, it } from 'vitest';
import {
  LEGACY_SESSION_COOKIE_NAMES,
  parseCookieHeader,
  parseSetCookie,
  sessionCookieStrings,
  type LegacyCookieConfig,
  type ParsedSetCookie,
} from '../../src/legacy-compat/index.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12, 0, 0));
const CONFIG: LegacyCookieConfig = {
  sessionCookiesExpires: '1',
  secureCookies: true,
  cookieDomain: 'example.com',
  cookiePath: '/site',
};
const ATTRIBUTES: ParsedSetCookie['attributes'] = [
  ['expires', 'Wed, 01-Jul-2026 12:00:00 GMT'],
  ['domain', 'example.com'],
  ['path', '/site'],
  ['secure', true],
  ['HttpOnly', true],
];

describe('legacy session cookie jar', () => {
  const setCookies = sessionCookieStrings({ CFID: '1', CFTOKEN: '2', jsessionid: '3' }, CONFIG, NOW);

  it('absorbs each session Set-Cookie with its name, value and legacy attributes', () => {
    expect(setCookies.map(parseSetCookie)).toEqual(
      LEGACY_SESSION_COOKIE_NAMES.map((name, i) => ({
        name,
        value: String(i + 1),
        attributes: ATTRIBUTES,
        raw: setCookies[i],
      })),
    );
  });

  it('replays the absorbed cookies as a Cookie header that parses back to the session tokens', () => {
    const header = setCookies
      .map(parseSetCookie)
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    const jar = parseCookieHeader(header);
    expect(jar.size).toBe(LEGACY_SESSION_COOKIE_NAMES.length);
    expect(LEGACY_SESSION_COOKIE_NAMES.map((name) => jar.get(name))).toEqual(['1', '2', '3']);
  });
});
