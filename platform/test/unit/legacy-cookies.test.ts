// Session cookie jar flow through the legacy-compat barrel; per-function cases for cookies.ts are in cookies.test.ts.
import { describe, expect, it } from 'vitest';
import {
  LEGACY_SESSION_COOKIE_NAMES,
  jsessionidForSessionId,
  parseCookieHeader,
  parseSetCookie,
  sessionCookieStrings,
  sessionIdForJsessionid,
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

describe('JSESSIONID of a session id', () => {
  it.each([
    ['a CF-format id', '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', '0A1B2C3D4E5F60718293A4B5C6D7E8F9'],
    ['a lower-case CF-format id, case kept', '0a1b2c3d-4e5f-6071-8293a4b5c6d7e8f9', '0a1b2c3d4e5f60718293a4b5c6d7e8f9'],
    ['an adopted legacy session id', 'masacms_1000_00000001', 'masacms_1000_00000001'],
    ['a legacy id with a node suffix', 'masacms_1000_00000001.node-1', 'masacms_1000_00000001.node-1'],
    ['an RFC 4122 UUID', '0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9', '0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9'],
    ['31 hex characters', '0A1B2C3D4E5F60718293A4B5C6D7E8F', '0A1B2C3D4E5F60718293A4B5C6D7E8F'],
    ['33 hex characters', '0A1B2C3D4E5F60718293A4B5C6D7E8F90', '0A1B2C3D4E5F60718293A4B5C6D7E8F90'],
    ['32 characters with a non-hex one', '0A1B2C3D4E5F60718293A4B5C6D7E8FG', '0A1B2C3D4E5F60718293A4B5C6D7E8FG'],
    ['an empty value', '', ''],
  ])('maps %s to its JSESSIONID and back', (_label, sessionId, jsessionid) => {
    expect(jsessionidForSessionId(sessionId)).toBe(jsessionid);
    expect(sessionIdForJsessionid(jsessionid)).toBe(sessionId);
  });
});
