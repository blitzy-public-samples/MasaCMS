import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_SESSION_COOKIE_NAMES,
  deleteCookieLegacy,
  isLegacySessionCookie,
  parseCookieHeader,
  parseSetCookie,
  sessionCookieStrings,
  setCookieLegacy,
  type LegacyCookieConfig,
  type LegacyCookieOptions,
  type ParsedSetCookie,
} from '../../src/legacy-compat/cookies.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12, 0, 0));
const NOW_GMT = 'Tue, 30-Jun-2026 12:00:00 GMT';
const NEVER_GMT = 'Fri, 30-Jun-2056 12:00:00 GMT';
const WEEK_GMT = 'Tue, 07-Jul-2026 12:00:00 GMT';

const SYSTEM_TZ = process.env.TZ;

/** Runs `run` with the process time zone set to `zone`, restoring the original zone afterwards. */
function withZone<T>(zone: string, run: () => T): T {
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (SYSTEM_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = SYSTEM_TZ;
  }
}

describe('setCookieLegacy', () => {
  it('writes the legacy attribute order', () => {
    const header = setCookieLegacy({
      name: 'cfid',
      value: 'abc',
      expires: new Date(Date.UTC(2026, 5, 30, 12, 0, 0)),
      domain: 'example.com',
      path: '/',
      secure: true,
      httponly: true,
    });
    expect(header).toBe('CFID=abc;expires=Tue, 30-Jun-2026 12:00:00 GMT;domain=example.com;path=/;secure;HttpOnly;');
  });

  it.each<{ label: string; options: LegacyCookieOptions; expected: string }>([
    { label: 'a session cookie', options: { name: 'sid', value: 'v' }, expected: 'SID=v;path=/;HttpOnly;' },
    { label: 'the name case with maintainCase', options: { name: 'cfid', value: 'v', maintainCase: true }, expected: 'cfid=v;path=/;HttpOnly;' },
    { label: 'an upper-cased name without maintainCase', options: { name: 'MixedCase', value: 'v', maintainCase: false }, expected: 'MIXEDCASE=v;path=/;HttpOnly;' },
    { label: 'no HttpOnly for httponly false', options: { name: 'a', value: 'v', httponly: false }, expected: 'A=v;path=/;' },
    { label: 'no HttpOnly for httpOnly false', options: { name: 'a', value: 'v', httpOnly: false }, expected: 'A=v;path=/;' },
    { label: 'httpOnly over httponly', options: { name: 'a', value: 'v', httpOnly: false, httponly: true }, expected: 'A=v;path=/;' },
    { label: 'no path for an empty path', options: { name: 'a', value: 'v', path: '' }, expected: 'A=v;HttpOnly;' },
    { label: 'the given path', options: { name: 'a', value: 'v', path: '/admin' }, expected: 'A=v;path=/admin;HttpOnly;' },
    { label: 'no domain for an empty domain', options: { name: 'a', value: 'v', domain: '' }, expected: 'A=v;path=/;HttpOnly;' },
    { label: 'secure without a domain', options: { name: 'a', value: 'v', secure: true }, expected: 'A=v;path=/;secure;HttpOnly;' },
    { label: 'an empty value', options: { name: 'a', value: '' }, expected: 'A=;path=/;HttpOnly;' },
    { label: 'the value unencoded', options: { name: 'a', value: 'x y=z' }, expected: 'A=x y=z;path=/;HttpOnly;' },
  ])('writes $label', ({ options, expected }) => {
    expect(setCookieLegacy(options, {}, NOW)).toBe(expected);
  });

  it.each<{ label: string; options: LegacyCookieOptions; cfg: LegacyCookieConfig; expected: string }>([
    { label: 'secureCookies forces secure', options: { name: 'a', value: 'v' }, cfg: { secureCookies: true }, expected: 'A=v;path=/;secure;HttpOnly;' },
    { label: 'secureCookies false keeps secure', options: { name: 'a', value: 'v', secure: true }, cfg: { secureCookies: false }, expected: 'A=v;path=/;secure;HttpOnly;' },
    { label: 'cookieDomain replaces the domain and resets the path', options: { name: 'a', value: 'v', domain: 'example.com', path: '/admin' }, cfg: { cookieDomain: 'cfg.example' }, expected: 'A=v;domain=cfg.example;path=/;HttpOnly;' },
    { label: 'cookieDomain restores an empty path', options: { name: 'a', value: 'v', path: '' }, cfg: { cookieDomain: 'cfg.example' }, expected: 'A=v;domain=cfg.example;path=/;HttpOnly;' },
    { label: 'cookiePath applies with cookieDomain', options: { name: 'a', value: 'v', path: '/admin' }, cfg: { cookieDomain: 'cfg.example', cookiePath: '/site' }, expected: 'A=v;domain=cfg.example;path=/site;HttpOnly;' },
    { label: 'cookiePath is ignored without cookieDomain', options: { name: 'a', value: 'v', path: '/admin' }, cfg: { cookiePath: '/site' }, expected: 'A=v;path=/admin;HttpOnly;' },
    { label: 'an empty cookieDomain keeps the domain', options: { name: 'a', value: 'v', domain: 'example.com' }, cfg: { cookieDomain: '', cookiePath: '/site' }, expected: 'A=v;domain=example.com;path=/;HttpOnly;' },
  ])('$label', ({ options, cfg, expected }) => {
    expect(setCookieLegacy(options, cfg, NOW)).toBe(expected);
  });

  it.each<{ label: string; expires: LegacyCookieOptions['expires']; zone: string; now: Date; expected: string }>([
    { label: 'now', expires: 'now', zone: 'UTC', now: NOW, expected: 'Mon, 29-Jun-2026 12:00:00 GMT' },
    { label: 'NOW', expires: 'NOW', zone: 'America/New_York', now: NOW, expected: 'Mon, 29-Jun-2026 12:00:00 GMT' },
    { label: 'never', expires: 'never', zone: 'UTC', now: NOW, expected: NEVER_GMT },
    { label: 'Never', expires: 'Never', zone: 'Asia/Kolkata', now: NOW, expected: NEVER_GMT },
    { label: '7 days', expires: 7, zone: 'UTC', now: NOW, expected: WEEK_GMT },
    { label: "'7' days", expires: '7', zone: 'America/New_York', now: NOW, expected: WEEK_GMT },
    { label: "'-1' days", expires: '-1', zone: 'Asia/Kolkata', now: NOW, expected: 'Mon, 29-Jun-2026 12:00:00 GMT' },
    { label: '0 days', expires: 0, zone: 'UTC', now: NOW, expected: NOW_GMT },
    { label: "'0' days", expires: '0', zone: 'America/New_York', now: NOW, expected: NOW_GMT },
    { label: 'a Date', expires: new Date(Date.UTC(2026, 6, 1)), zone: 'Asia/Kolkata', now: NOW, expected: 'Wed, 01-Jul-2026 00:00:00 GMT' },
    { label: '1 day in UTC', expires: 1, zone: 'UTC', now: new Date('2026-03-07T17:00:00Z'), expected: 'Sun, 08-Mar-2026 17:00:00 GMT' },
    { label: '1 day across spring-forward', expires: 1, zone: 'America/New_York', now: new Date('2026-03-07T17:00:00Z'), expected: 'Sun, 08-Mar-2026 16:00:00 GMT' },
    { label: 'now across spring-forward', expires: 'now', zone: 'America/New_York', now: new Date('2026-03-09T16:00:00Z'), expected: 'Sun, 08-Mar-2026 16:00:00 GMT' },
    { label: "'1' day across fall-back", expires: '1', zone: 'America/New_York', now: new Date('2026-10-31T16:00:00Z'), expected: 'Sun, 01-Nov-2026 17:00:00 GMT' },
    { label: "' 1 ' days", expires: ' 1 ', zone: 'UTC', now: NOW, expected: 'Wed, 01-Jul-2026 12:00:00 GMT' },
    { label: "'\\t7\\n' days", expires: '\t7\n', zone: 'UTC', now: NOW, expected: WEEK_GMT },
    { label: "'1\\u0001' days", expires: '1\u0001', zone: 'UTC', now: NOW, expected: 'Wed, 01-Jul-2026 12:00:00 GMT' },
    { label: "' -1 ' days", expires: ' -1 ', zone: 'UTC', now: NOW, expected: 'Mon, 29-Jun-2026 12:00:00 GMT' },
    { label: "' 0 ' days", expires: ' 0 ', zone: 'UTC', now: NOW, expected: NOW_GMT },
    { label: "'\\u00002' days", expires: '\u00002', zone: 'UTC', now: NOW, expected: 'Thu, 02-Jul-2026 12:00:00 GMT' },
    { label: "'\\u000b2' days", expires: '\u000b2', zone: 'UTC', now: NOW, expected: 'Thu, 02-Jul-2026 12:00:00 GMT' },
    { label: "' 1e1 ' days", expires: ' 1e1 ', zone: 'UTC', now: NOW, expected: 'Fri, 10-Jul-2026 12:00:00 GMT' },
    { label: "'1.9' days", expires: '1.9', zone: 'UTC', now: NOW, expected: 'Wed, 01-Jul-2026 12:00:00 GMT' },
  ])('expires $label in $zone', ({ expires, zone, now, expected }) => {
    const header = withZone(zone, () => setCookieLegacy({ name: 'a', value: 'v', expires }, {}, now));
    expect(header).toBe(`A=v;expires=${expected};path=/;HttpOnly;`);
  });

  it.each([
    '', 'session', 'session only', 'abc', '\u00a01', '\ufeff2', ' now ', ' never ', '1e309', '-1e400', '1.8e308',
  ])('omits expires for %j', (expires) => {
    expect(setCookieLegacy({ name: 'a', value: 'v', expires }, {}, NOW)).toBe('A=v;path=/;HttpOnly;');
  });

  it.each([
    { expires: '1e10', value: '1.0E10' },
    { expires: '1e308', value: '1.0E308' },
    { expires: '1.7976931348623157e308', value: '1.7976931348623157E308' },
  ])('throws for a day count of $expires as legacy DateAdd does', ({ expires, value }) => {
    const write = (): string => setCookieLegacy({ name: 'a', value: 'v', expires }, {}, NOW);
    expect(write).toThrow(RangeError);
    expect(write).toThrow(`Cannot convert the value ${value} to an integer because it cannot fit inside an integer.`);
  });
});

describe('deleteCookieLegacy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<{ label: string; cfg: LegacyCookieConfig | undefined; expected: string }>([
    { label: 'without config', cfg: undefined, expected: `myCookie=;expires=${NOW_GMT};path=/;HttpOnly;` },
    { label: 'with config', cfg: { secureCookies: true, cookieDomain: 'cfg.example', cookiePath: '/site' }, expected: `myCookie=;expires=${NOW_GMT};domain=cfg.example;path=/site;secure;HttpOnly;` },
  ])('expires the cookie now $label', ({ cfg, expected }) => {
    expect(deleteCookieLegacy('myCookie', cfg, NOW)).toBe(expected);
  });

  it('defaults to the system clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(deleteCookieLegacy('a')).toBe(`a=;expires=${NOW_GMT};path=/;HttpOnly;`);
    expect(setCookieLegacy({ name: 'a', value: 'v', expires: 0 })).toBe(`A=v;expires=${NOW_GMT};path=/;HttpOnly;`);
  });
});

describe('sessionCookieStrings', () => {
  const tokens = { CFID: '1234', CFTOKEN: '5678', jsessionid: 'abcd' };

  it('expires all three in 30 years by default', () => {
    expect(withZone('America/New_York', () => sessionCookieStrings(tokens, {}, NOW))).toEqual([
      `CFID=1234;expires=${NEVER_GMT};path=/;HttpOnly;`,
      `CFTOKEN=5678;expires=${NEVER_GMT};path=/;HttpOnly;`,
      `JSESSIONID=abcd;expires=${NEVER_GMT};path=/;HttpOnly;`,
    ]);
  });

  it.each(['', 'session', 'SESSION', 'session only', 'Session Only'])('writes session cookies for %j', (sessionCookiesExpires) => {
    expect(sessionCookieStrings(tokens, { sessionCookiesExpires }, NOW)).toEqual([
      'CFID=1234;path=/;HttpOnly;',
      'CFTOKEN=5678;path=/;HttpOnly;',
      'JSESSIONID=abcd;path=/;HttpOnly;',
    ]);
  });

  it.each(['7', ' 7 '])('applies the day count %j and the cookie config', (sessionCookiesExpires) => {
    const cfg = { sessionCookiesExpires, secureCookies: true, cookieDomain: 'cfg.example', cookiePath: '/site' };
    expect(withZone('UTC', () => sessionCookieStrings(tokens, cfg, NOW))).toEqual([
      `CFID=1234;expires=${WEEK_GMT};domain=cfg.example;path=/site;secure;HttpOnly;`,
      `CFTOKEN=5678;expires=${WEEK_GMT};domain=cfg.example;path=/site;secure;HttpOnly;`,
      `JSESSIONID=abcd;expires=${WEEK_GMT};domain=cfg.example;path=/site;secure;HttpOnly;`,
    ]);
  });

  it.each<{ label: string; given: Parameters<typeof sessionCookieStrings>[0]; expected: string[] }>([
    { label: 'only JSESSIONID', given: { jsessionid: 'abcd' }, expected: ['JSESSIONID=abcd;path=/;HttpOnly;'] },
    { label: 'only CFID and CFTOKEN', given: { CFID: '1234', CFTOKEN: '5678' }, expected: ['CFID=1234;path=/;HttpOnly;', 'CFTOKEN=5678;path=/;HttpOnly;'] },
    { label: 'nothing', given: {}, expected: [] },
  ])('writes $label', ({ given, expected }) => {
    expect(sessionCookieStrings(given, { sessionCookiesExpires: '' }, NOW)).toEqual(expected);
  });

  it('rejects CFID without CFTOKEN', () => {
    const run = (): string[] => sessionCookieStrings({ CFID: '1234', jsessionid: 'abcd' }, {}, NOW);
    expect(run).toThrow(TypeError);
    expect(run).toThrow('CFTOKEN is required with CFID');
  });
});

describe('parseSetCookie', () => {
  it('round-trips a legacy Set-Cookie value', () => {
    const raw = setCookieLegacy({ name: 'cfid', value: 'abc', expires: NOW, domain: 'example.com', secure: true });
    expect(parseSetCookie(raw)).toEqual({
      name: 'CFID',
      value: 'abc',
      attributes: [['expires', NOW_GMT], ['domain', 'example.com'], ['path', '/'], ['secure', true], ['HttpOnly', true]],
      raw,
    });
  });

  it('round-trips every session cookie', () => {
    const parsed = sessionCookieStrings({ CFID: '1', CFTOKEN: '2', jsessionid: '3' }, { sessionCookiesExpires: '' }, NOW).map(parseSetCookie);
    expect(parsed.map(({ name, value }) => [name, value])).toEqual([['CFID', '1'], ['CFTOKEN', '2'], ['JSESSIONID', '3']]);
    expect(parsed.every(({ name }) => isLegacySessionCookie(name))).toBe(true);
  });

  it.each<{ header: string; expected: Omit<ParsedSetCookie, 'raw'> }>([
    { header: 'sid=x; Path=/; Secure; SameSite=Lax', expected: { name: 'sid', value: 'x', attributes: [['Path', '/'], ['Secure', true], ['SameSite', 'Lax']] } },
    { header: 'tok=a=b;path=/', expected: { name: 'tok', value: 'a=b', attributes: [['path', '/']] } },
    { header: ' sp = v ; Max-Age = 0 ', expected: { name: 'sp', value: 'v', attributes: [['Max-Age', '0']] } },
    { header: 'a=;;expires=;', expected: { name: 'a', value: '', attributes: [['expires', '']] } },
    { header: 'bare', expected: { name: '', value: 'bare', attributes: [] } },
    { header: '', expected: { name: '', value: '', attributes: [] } },
  ])('parses $header', ({ header, expected }) => {
    expect(parseSetCookie(header)).toEqual({ ...expected, raw: header });
  });
});

describe('parseCookieHeader', () => {
  it('keys by lower-cased name with case-insensitive lookup', () => {
    const cookies = parseCookieHeader('CFID=1234; CFTOKEN=5678; JSESSIONID=abcd');
    expect([...cookies]).toEqual([['cfid', '1234'], ['cftoken', '5678'], ['jsessionid', 'abcd']]);
    expect(cookies.get('CfId')).toBe('1234');
    expect(cookies.has('JSESSIONID')).toBe(true);
    expect(cookies.has('other')).toBe(false);
  });

  it('keeps the first duplicate in any case', () => {
    expect([...parseCookieHeader('cfid=first; CFID=second; CfId=third')]).toEqual([['cfid', 'first']]);
  });

  it.each<{ label: string; header: string | undefined; expected: Array<[string, string]> }>([
    { label: 'no header', header: undefined, expected: [] },
    { label: 'an empty header', header: '', expected: [] },
    { label: 'empty names', header: ' ; =orphan; ;', expected: [] },
    { label: 'raw values', header: 'flag; a=%20b; t=a=b;c = d ', expected: [['flag', ''], ['a', '%20b'], ['t', 'a=b'], ['c', 'd']] },
  ])('parses $label', ({ header, expected }) => {
    expect([...parseCookieHeader(header)]).toEqual(expected);
  });

  it('sets and deletes by any case', () => {
    const cookies = parseCookieHeader('CFID=1');
    cookies.set('NEW', 'v');
    expect(cookies.get('new')).toBe('v');
    expect(cookies.delete('Cfid')).toBe(true);
    expect([...cookies]).toEqual([['new', 'v']]);
  });
});

describe('isLegacySessionCookie', () => {
  it('lists CFID, CFTOKEN and JSESSIONID', () => {
    expect(LEGACY_SESSION_COOKIE_NAMES).toEqual(['CFID', 'CFTOKEN', 'JSESSIONID']);
  });

  it.each([
    { name: 'CFID', expected: true },
    { name: 'cftoken', expected: true },
    { name: 'JSessionId', expected: true },
    { name: 'CFIDX', expected: false },
    { name: 'SESSIONID', expected: false },
    { name: '', expected: false },
  ])('returns $expected for $name', ({ name, expected }) => {
    expect(isLegacySessionCookie(name)).toBe(expected);
  });
});
