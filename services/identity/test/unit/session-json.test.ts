// Stored toauthtokens.data text: ACF serializeJSON(getSession()), its isJSON/deserializeJSON read-back and getTokenInfo.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACF_SESSION_JSON_LAYOUT,
  type AcfJsonLayout,
  type AcfStruct,
  type AcfValue,
  type LegacySessionData,
  parseLegacySessionJson,
  serializeLegacySessionJson,
  tokenInfoFromSessionJson,
} from '../../src/legacy/session-json.js';

const USER_ID = 'A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D';
const ADMIN_GROUP_ID = 'B2C3D4E5-F6A7-4B8C-9D0E1F2A3B4C5D6E';
const CSRF_SECRET = 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000';
const USED_TOKEN = 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD';
const PASSWORD_HASH = '$2a$10$synthetic.session.fixture';
const MEMBERSHIPS = 'Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a';

const CAPTURED_SESSION_JSON =
  '{"MURA":{"SUBTYPE":"Default","PASSWORDCREATED":"March, 02 2026 08:04:09",' +
  '"MEMBERSHIPIDS":"B2C3D4E5-F6A7-4B8C-9D0E1F2A3B4C5D6E","LNAME":"Admin","ISLOGGEDIN":true,"SITEID":"tenant-a",' +
  '"EMAIL":"site.admin@tenant-a.example.com",' +
  '"csrfusedtokens":{"AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD":"June, 30 2026 10:21:05"},' +
  '"FNAME":"Site","COMPANY":"Tenant A Programs","REMOTEID":"","PASSWORD":"$2a$10$synthetic.session.fixture",' +
  '"csrfsecretkey":"AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000","USERID":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D",' +
  '"USERNAME":"site_admin",' +
  '"MEMBERSHIPS":"Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate,site_admin;username;tenant-a",' +
  '"LASTLOGIN":"June, 29 2026 17:45:30"},' +
  '"blockLoginUntil":"","SITEID":"tenant-a","rememberMe":"0","loginAttempts":"0"}';

const PROBE_SESSION_JSON = readFileSync(new URL('../fixtures/legacy/oauth-token-data.json', import.meta.url), 'utf8');

const TOKEN_INFO_HIDDEN = new Set(['csrfsecretkey', 'csrfusedtokens', 'isloggedin', 'lastlogin', 'password']);

const SYSTEM_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'UTC';
});

afterAll(() => {
  if (SYSTEM_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = SYSTEM_TZ;
});

/** The session struct as setUserStruct leaves it, with the CFML source's key spelling and assignment order. */
function loginSnapshot(): AcfStruct {
  return {
    rememberMe: '0',
    loginAttempts: '0',
    blockLoginUntil: '',
    mura: {
      csrfsecretkey: CSRF_SECRET,
      csrfusedtokens: { [USED_TOKEN]: new Date(Date.UTC(2026, 5, 30, 10, 21, 5)) },
      isLoggedIn: true,
      userID: USER_ID,
      username: 'site_admin',
      siteID: 'tenant-a',
      subtype: 'Default',
      password: PASSWORD_HASH,
      fname: 'Site',
      lname: 'Admin',
      email: 'site.admin@tenant-a.example.com',
      remoteID: '',
      company: 'Tenant A Programs',
      lastlogin: new Date(Date.UTC(2026, 5, 29, 17, 45, 30)),
      passwordCreated: new Date(Date.UTC(2026, 2, 2, 8, 4, 9)),
      memberships: MEMBERSHIPS,
      membershipids: ADMIN_GROUP_ID,
    },
    siteID: 'tenant-a',
  };
}

/** Parses text the test knows holds a session struct. */
function parseStored(text: string): LegacySessionData {
  const data = parseLegacySessionJson(text);
  if (data === undefined) throw new Error('expected stored session text to parse as a struct');
  return data;
}

/** Key order of a JSON object member, read back with JSON.parse. */
function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>);
}

describe('ACF_SESSION_JSON_LAYOUT', () => {
  it('names the stored session keys and every mura key setUserStruct writes, once each', () => {
    expect(ACF_SESSION_JSON_LAYOUT.sessionKeys.map((k) => k.toLowerCase()).sort()).toEqual(
      ['blockloginuntil', 'loginattempts', 'mura', 'rememberme', 'siteid'],
    );
    expect(ACF_SESSION_JSON_LAYOUT.muraKeys.map((k) => k.toLowerCase()).sort()).toEqual(
      [
        'company', 'csrfsecretkey', 'csrfusedtokens', 'email', 'fname', 'isloggedin', 'lastlogin', 'lname',
        'memberships', 'membershipids', 'password', 'passwordcreated', 'remoteid', 'siteid', 'subtype', 'userid',
        'username',
      ].sort(),
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ACF_SESSION_JSON_LAYOUT)).toBe(true);
    expect(Object.isFrozen(ACF_SESSION_JSON_LAYOUT.sessionKeys)).toBe(true);
    expect(Object.isFrozen(ACF_SESSION_JSON_LAYOUT.muraKeys)).toBe(true);
  });
});

describe('serializeLegacySessionJson', () => {
  it('writes a login snapshot as the captured ACF text, in layout order and casing', () => {
    const text = serializeLegacySessionJson(loginSnapshot());

    expect(text).toBe(CAPTURED_SESSION_JSON);
    const parsed = JSON.parse(text) as { MURA: unknown };
    expect(keysOf(parsed)).toEqual(ACF_SESSION_JSON_LAYOUT.sessionKeys);
    expect(keysOf(parsed.MURA)).toEqual(ACF_SESSION_JSON_LAYOUT.muraKeys);
  });

  it.each([
    ['the captured login session', CAPTURED_SESSION_JSON],
    ['the ACF 2023 probe fixture', PROBE_SESSION_JSON],
  ])('reproduces %s byte for byte from its parsed session struct', (_name, stored) => {
    expect(serializeLegacySessionJson(parseStored(stored).session)).toBe(stored);
  });

  it('appends keys outside the layout uppercased, in snapshot order, after the layout keys', () => {
    const text = serializeLegacySessionJson({
      cfid: '1001',
      mura: { tablist: 'basic', userid: USER_ID, isloggedin: false },
      urltoken: 'CFID=1001&CFTOKEN=0',
      siteid: 'tenant-a',
    });

    expect(text).toBe(
      '{"MURA":{"ISLOGGEDIN":false,"USERID":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D","TABLIST":"basic"},' +
        '"SITEID":"tenant-a","CFID":"1001","URLTOKEN":"CFID=1001&CFTOKEN=0"}',
    );
  });

  it('keeps used-token keys as written and uses the layout text for csrfusedtokens', () => {
    const text = serializeLegacySessionJson({
      MURA: { CSRFUSEDTOKENS: { 'abc-lower': 'used', MiXeD: null }, CsrfSecretKey: CSRF_SECRET },
    });

    expect(text).toBe(
      '{"MURA":{"csrfusedtokens":{"abc-lower":"used","MiXeD":null},' +
        '"csrfsecretkey":"AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000"}}',
    );
  });

  it('writes nested structs with uppercased keys and arrays, null and booleans as JSON literals', () => {
    const text = serializeLegacySessionJson({
      siteArray: [{ siteid: 'tenant-a', ispublic: false }, ['x', null], []],
      mura: 'not a struct',
      flags: { remember: true, empty: {} },
    });

    expect(text).toBe(
      '{"MURA":"not a struct","SITEARRAY":[{"SITEID":"tenant-a","ISPUBLIC":false},["x",null],[]],' +
        '"FLAGS":{"REMEMBER":true,"EMPTY":{}}}',
    );
  });

  it('honours a caller-supplied layout', () => {
    const layout: AcfJsonLayout = { sessionKeys: ['loginAttempts', 'Mura'], muraKeys: ['userId'] };

    expect(serializeLegacySessionJson({ mura: { USERID: USER_ID, fname: 'Site' }, loginattempts: '2' }, layout)).toBe(
      '{"loginAttempts":"2","Mura":{"userId":"A1B2C3D4-E5F6-4A7B-8C9D0E1F2A3B4C5D","FNAME":"Site"}}',
    );
  });

  it('escapes quotes, backslashes and control characters, leaving slashes and non-ASCII raw', () => {
    const value = 'q"b\\s/\b\f\n\r\t\u0000\u001f\u007f \u00e9\u2028\u{1D11E}';

    expect(serializeLegacySessionJson({ note: value })).toBe(
      '{"NOTE":"q\\"b\\\\s/\\b\\f\\n\\r\\t\\u0000\\u001f\\u007f \u00e9\u2028\u{1D11E}"}',
    );
  });

  it.each<[number, string]>([
    [0, '0'],
    [-7, '-7'],
    [9_007_199_254_740_991, '9007199254740991'],
    [9_007_199_254_740_992, '9.007199254740992E15'],
    [0.25, '0.25'],
    [0.001, '0.001'],
    [1_234_567.5, '1234567.5'],
    [12_345_678.5, '1.23456785E7'],
    [-2.5e-4, '-2.5E-4'],
    [1e-7, '1.0E-7'],
    [1e20, '1.0E20'],
  ])('writes the number %d as %s', (value, expected) => {
    expect(serializeLegacySessionJson({ n: value })).toBe(`{"N":${expected}}`);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects the non-finite number %d', (value) => {
    expect(() => serializeLegacySessionJson({ n: value })).toThrow(RangeError);
  });

  it.each<[string, AcfStruct]>([
    ['session', { siteid: 'tenant-a', SITEID: 'tenant-b' }],
    ['mura', { mura: { userID: USER_ID, UserId: USER_ID } }],
  ])('rejects %s keys that differ only in case', (_level, snapshot) => {
    expect(() => serializeLegacySessionJson(snapshot)).toThrow(TypeError);
  });
});

describe('parseLegacySessionJson', () => {
  it('returns the whole session struct and its mura struct', () => {
    const data = parseStored(CAPTURED_SESSION_JSON);

    expect(data.session).toEqual(JSON.parse(CAPTURED_SESSION_JSON));
    expect(data.mura).toBe(data.session.MURA);
  });

  it.each(['userid', 'USERID', 'userID', 'UserId'])('reads the mura key %s case-insensitively', (key) => {
    const data = parseStored(CAPTURED_SESSION_JSON);

    expect(data.get(data.mura, key)).toBe(USER_ID);
  });

  it.each<[string, AcfValue]>([
    ['CSRFSECRETKEY', CSRF_SECRET],
    ['IsLoggedIn', true],
    ['lastLogin', 'June, 29 2026 17:45:30'],
    ['memberships', MEMBERSHIPS],
  ])('reads the mura key %s as stored', (key, expected) => {
    const data = parseStored(CAPTURED_SESSION_JSON);

    expect(data.get(data.mura, key)).toBe(expected);
  });

  it('reads session keys case-insensitively and answers undefined for absent keys and structs', () => {
    const data = parseStored(CAPTURED_SESSION_JSON);

    expect(data.get(data.session, 'mura')).toBe(data.mura);
    expect(data.get(data.session, 'siteid')).toBe('tenant-a');
    expect(data.get(data.session, 'BLOCKLOGINUNTIL')).toBe('');
    expect(data.get(data.session, 'cfid')).toBeUndefined();
    expect(data.get(undefined, 'userid')).toBeUndefined();
  });

  it('finds a lowercase mura key and leaves mura undefined when it is absent or not a struct', () => {
    expect(parseStored('{"mura":{"userid":"x"}}').mura).toEqual({ userid: 'x' });
    expect(parseStored('{"SITEID":"tenant-a"}').mura).toBeUndefined();
    expect(parseStored('{"MURA":"tenant-a"}').mura).toBeUndefined();
    expect(parseStored('{"MURA":["tenant-a"]}').mura).toBeUndefined();
  });

  it.each<[string, string | null | undefined]>([
    ['text that is not JSON', 'not json'],
    ['an empty string', ''],
    ['truncated JSON', CAPTURED_SESSION_JSON.slice(0, -1)],
    ['null', null],
    ['undefined', undefined],
    ['a JSON array', '[{"MURA":{}}]'],
    ['a JSON string', '"session"'],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
  ])('answers undefined for %s', (_name, text) => {
    expect(parseLegacySessionJson(text)).toBeUndefined();
  });

  it('returns fresh structs on every read and never alters the stored text', () => {
    const stored = CAPTURED_SESSION_JSON;
    const first = parseStored(stored);
    if (first.mura === undefined) throw new Error('expected a mura struct');
    first.mura.USERID = 'changed';
    first.session.SITEID = 'tenant-b';
    tokenInfoFromSessionJson(stored).USERNAME = 'changed';

    const second = parseStored(stored);
    expect(stored).toBe(CAPTURED_SESSION_JSON);
    expect(second.session).not.toBe(first.session);
    expect(second.get(second.mura, 'userid')).toBe(USER_ID);
    expect(serializeLegacySessionJson(second.session)).toBe(stored);
    expect(tokenInfoFromSessionJson(stored).USERNAME).toBe('site_admin');
  });
});

describe('tokenInfoFromSessionJson', () => {
  it('answers the stored mura struct without its secret and login-state keys', () => {
    const info = tokenInfoFromSessionJson(CAPTURED_SESSION_JSON);

    expect(info).toEqual({
      SUBTYPE: 'Default',
      PASSWORDCREATED: 'March, 02 2026 08:04:09',
      MEMBERSHIPIDS: ADMIN_GROUP_ID,
      LNAME: 'Admin',
      SITEID: 'tenant-a',
      EMAIL: 'site.admin@tenant-a.example.com',
      FNAME: 'Site',
      COMPANY: 'Tenant A Programs',
      REMOTEID: '',
      USERID: USER_ID,
      USERNAME: 'site_admin',
      MEMBERSHIPS: MEMBERSHIPS,
    });
    expect(Object.keys(info)).toEqual(
      ACF_SESSION_JSON_LAYOUT.muraKeys.filter((key) => !TOKEN_INFO_HIDDEN.has(key.toLowerCase())),
    );
  });

  it('drops the hidden keys whatever their case and keeps other members as stored', () => {
    const info = tokenInfoFromSessionJson(
      '{"mura":{"IsLoggedIn":true,"Password":"x","LastLogin":"","CSRFSecretKey":"k","CsrfUsedTokens":{},' +
        '"userid":"' + USER_ID + '","tablist":["basic"],"__proto__":{"polluted":true}}}',
    );

    expect(Object.keys(info)).toEqual(['userid', 'tablist', '__proto__']);
    expect(info.userid).toBe(USER_ID);
    expect(info.tablist).toEqual(['basic']);
    expect(Object.getPrototypeOf(info)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each<[string, string | null | undefined]>([
    ['JSON without a mura key', '{"SITEID":"tenant-a","rememberMe":"0","loginAttempts":"0"}'],
    ['a mura member that is not a struct', '{"MURA":"tenant-a"}'],
    ['text that is not JSON', 'not json'],
    ['an empty string', ''],
    ['null', null],
    ['a JSON array', '[]'],
  ])('answers {} for %s', (_name, text) => {
    expect(tokenInfoFromSessionJson(text)).toEqual({});
  });
});
