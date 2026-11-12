// Session resolution: REST credentials, target- and legacy-primary mapping, adoption, switch back and jar absorption.
import { describe, expect, it } from 'vitest';
import { parseCookieHeader, parseSetCookie, setCookieLegacy } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import type { BridgeClient, BridgeResult, LegacyCookies } from '../../src/session/bridge-client.js';
import type {
  AdoptInput,
  AdoptedSession,
  IdentityClient,
  LegacyDescribe,
  RestAuthInput,
  RestAuthOutcome,
} from '../../src/session/identity-client.js';
import type { JarCookies, JarRow, JarUpsert, LegacyJar, LockedJar } from '../../src/session/jar.js';
import {
  createSessionResolver,
  sessionIdFromTargetCookies,
  type SessionRequestInput,
  type SessionResolution,
} from '../../src/session/resolve.js';
import type { SessionStateCheck, SessionStateChecker } from '../../src/session/state-check.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12));
const ADOPTED_ID = 'identity-session-adopted';
const ADOPTED_EPOCH = 7;
const TARGET_ISSUED: Readonly<Record<string, string>> = {
  JSESSIONID: ADOPTED_ID,
  CFID: 'T-CFID',
  CFTOKEN: 'T-CFTOKEN',
};
const LEGACY_CFID = setCookieLegacy(
  { name: 'CFID', value: 'L-CFID', domain: 'example.com', expires: 'never' },
  {},
  NOW,
);

type ActiveStates = Record<string, { state: 'active' | 'ended'; epoch: number }>;

/** T1, the identity session of the target-primary jar a switch back restores, still active. */
const T1_ACTIVE: ActiveStates = { T1: { state: 'active', epoch: 4 } };

interface Fakes {
  states?: ActiveStates;
  describe?: (cookies: LegacyCookies) => BridgeResult<LegacyDescribe>;
  adopt?: (input: AdoptInput) => AdoptedSession;
  authenticate?: (input: RestAuthInput) => RestAuthOutcome;
  rows?: JarRow[];
  /** Runs as a lock is granted, as the section that held it first would have changed the jar. */
  onLock?: (key: string, rows: Map<string, JarRow>) => void;
}

function describeBody(sessionId: string): LegacyDescribe {
  return {
    sessionId,
    isLoggedIn: true,
    user: {
      userID: 'U1',
      username: 'admin',
      siteID: 'default',
      subtype: 'Default',
      password: '',
      fname: '',
      lname: '',
      email: '',
      remoteID: '',
      company: '',
      lastlogin: '',
      passwordCreated: '',
    },
    memberships: 'Admin;default;0',
    membershipIds: 'G1,U1',
    csrfSecretKey: 'SECRET',
    usedTokens: [],
    siteId: 'default',
    serverTime: '2026-06-30T12:00:00.000',
  };
}

function jarRow(sessionId: string, fields: Partial<JarRow> = {}): JarRow {
  return {
    sessionId,
    legacySessionId: 'LEG-1',
    cookies: {},
    mode: 'target-primary',
    hydratedEpoch: null,
    updatedAt: NOW,
    ...fields,
  };
}

function cookie(name: string, value: string, attributes = 'path=/;HttpOnly;'): JarCookies {
  return { [name]: { name, value, attributes } };
}

/** A resolver over in-memory identity, bridge, jar and state fakes that record every call in order. */
function setup(fakes: Fakes = {}) {
  const calls: string[] = [];
  const described: Array<{ cookies: LegacyCookies; userAgent: string | undefined }> = [];
  const adopted: AdoptInput[] = [];
  const authenticated: RestAuthInput[] = [];
  const rebinds: Array<{ input: JarUpsert; previousSessionId: string | undefined }> = [];
  const rows = new Map((fakes.rows ?? []).map((row) => [row.sessionId, row]));

  const identity = {
    authenticate(input: RestAuthInput): Promise<RestAuthOutcome> {
      calls.push('authenticate');
      authenticated.push(input);
      return Promise.resolve(fakes.authenticate?.(input) ?? { outcome: 'anonymous', sessionId: null });
    },
    adopt(input: AdoptInput): Promise<AdoptedSession> {
      calls.push('adopt');
      adopted.push(input);
      return Promise.resolve(
        fakes.adopt?.(input) ?? {
          sessionId: ADOPTED_ID,
          epoch: ADOPTED_EPOCH,
          setCookie: Object.entries(TARGET_ISSUED).map(([name, value]) => setCookieLegacy({ name, value })),
        },
      );
    },
  } as unknown as IdentityClient;

  const bridge = {
    describe(cookies: LegacyCookies, call?: { userAgent?: string }): Promise<BridgeResult<LegacyDescribe>> {
      calls.push('describe');
      described.push({ cookies, userAgent: call?.userAgent });
      return Promise.resolve(fakes.describe?.(cookies) ?? { body: describeBody('LEG-1'), setCookies: [] });
    },
  } as unknown as BridgeClient;

  /** Stores `input` the way the jar's merge upsert does. */
  const store = (input: JarUpsert): JarRow => {
    const row = { ...input, cookies: { ...rows.get(input.sessionId)?.cookies, ...input.cookies }, updatedAt: NOW };
    rows.set(input.sessionId, row);
    return row;
  };
  /** Jar statements logged as `<prefix>.*`: `jar` at top level, `locked` inside a locked section. */
  const statements = (prefix: string): LockedJar => ({
    lockNative(legacySessionId) {
      calls.push(`lock.native:${legacySessionId}`);
      fakes.onLock?.(`lock.native:${legacySessionId}`, rows);
      return Promise.resolve();
    },
    get(sessionId) {
      calls.push(`${prefix}.get`);
      return Promise.resolve(rows.get(sessionId));
    },
    findByLegacySessionId(legacySessionId) {
      calls.push(`${prefix}.find`);
      return Promise.resolve([...rows.values()].find((row) => row.legacySessionId === legacySessionId));
    },
    upsert(input: JarUpsert) {
      calls.push(`${prefix}.upsert`);
      return Promise.resolve(store(input));
    },
    setHydratedEpoch() {
      return Promise.resolve(true);
    },
    drop(sessionId) {
      calls.push(`${prefix}.drop`);
      return Promise.resolve(rows.delete(sessionId));
    },
    rebind(input, previousSessionId) {
      calls.push(`${prefix}.rebind`);
      rebinds.push({ input, previousSessionId });
      for (const row of [...rows.values()]) {
        const replaced =
          row.sessionId === previousSessionId ||
          (input.legacySessionId !== null && row.legacySessionId === input.legacySessionId);
        if (row.sessionId !== input.sessionId && replaced) rows.delete(row.sessionId);
      }
      return Promise.resolve(store(input));
    },
  });
  const locked = statements('locked');
  /** Sections queued per lock key, so a section starts only after the previous one on its key settled. */
  const sections = new Map<string, Promise<unknown>>();
  function serialized<T>(key: string, fn: (statements: LockedJar) => Promise<T>): Promise<T> {
    calls.push(key);
    const run = (sections.get(key) ?? Promise.resolve()).then(() => {
      fakes.onLock?.(key, rows);
      return fn(locked);
    });
    sections.set(key, run.catch(() => undefined));
    return run;
  }
  const jar: LegacyJar = {
    ...statements('jar'),
    withSessionLock: (sessionId, fn) => serialized(`lock.session:${sessionId}`, fn),
    withNativeLock: (legacySessionId, fn) => serialized(`lock.native:${legacySessionId}`, fn),
    markIdentityEndPending: () => Promise.reject(new Error('resolution never marks a pending identity end')),
  };

  const state: SessionStateChecker = {
    check(sessionId): Promise<SessionStateCheck> {
      calls.push(`check:${sessionId}`);
      const known = fakes.states?.[sessionId] ?? { state: 'ended', epoch: 0 };
      return Promise.resolve({ ...known, userId: 'U1', siteId: 'default', epochChanged: false });
    },
    forget() {},
  };

  return {
    resolver: createSessionResolver({ identity, bridge, jar, state }),
    calls,
    described,
    adopted,
    authenticated,
    rebinds,
    rows,
  };
}

/** Calls of a switch back of T1's jar: its state, its locked re-read, the describe, its legacy session's lock and the rebind. */
const SWITCH_BACK = [
  'jar.get',
  'check:T1',
  'lock.session:T1',
  'locked.get',
  'describe',
  'lock.native:LEG-1',
  'locked.find',
  'adopt',
  'locked.rebind',
];

function request(cookieHeader?: string, fields: Partial<SessionRequestInput> = {}): SessionRequestInput {
  const headers: SessionRequestInput['headers'] = { 'user-agent': 'Mozilla/5.0', authorization: 'Basic dXNlcjpwYXNz' };
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  return { path: '/admin/', httpMethod: 'GET', headers, query: {}, params: {}, ...fields };
}

function asSession(resolution: SessionResolution) {
  if (resolution.kind !== 'session') throw new Error(`expected a session, got ${resolution.kind}`);
  return resolution;
}

/** The Set-Cookie value of `name` among `setCookies`. */
function setCookieOf(setCookies: string[], name: string): string | undefined {
  return setCookies.find((value) => parseSetCookie(value).name === name);
}

describe('sessionIdFromTargetCookies', () => {
  it.each([
    ['JSESSIONID=ABC; CFID=1', 'ABC'],
    ['jsessionid=abc', 'abc'],
    ['CFID=1; CFTOKEN=2', undefined],
    ['JSESSIONID=', undefined],
    ['JSESSIONID=0A1B2C3D4E5F60718293A4B5C6D7E8F9; CFID=1', '0A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9'],
  ])('reads the identity session id from %j', (header, expected) => {
    expect(sessionIdFromTargetCookies(parseCookieHeader(header))).toBe(expected);
  });
});

describe('sessionless REST', () => {
  it('returns identity legacy answer verbatim and reads neither cookies nor the jar', async () => {
    const answer = { status: 401, headers: { 'WWW-Authenticate': 'Basic' }, body: '{"error":{}}' };
    const s = setup({ authenticate: () => ({ outcome: 'denied', sessionId: null, legacyResponse: answer }) });
    const resolution = await s.resolver.resolveSession(
      request('JSESSIONID=T1', {
        path: '/_api/rest/v1/default/content',
        query: { a: 'b' },
        params: { a: 'b', c: 'd' },
      }),
      { family: 'rest', mode: 'target-primary', siteId: 'default' },
    );
    expect(resolution).toEqual({ kind: 'response', ...answer });
    expect(s.authenticated).toEqual([
      {
        method: 'GET',
        path: '/_api/rest/v1/default/content',
        siteId: 'default',
        headers: { 'user-agent': 'Mozilla/5.0', authorization: 'Basic dXNlcjpwYXNz', cookie: 'JSESSIONID=T1' },
        query: { a: 'b' },
        form: { a: 'b', c: 'd' },
      },
    ]);
    expect(s.calls).toEqual(['authenticate']);
  });

  it.each(['session', 'authenticated'] as const)('a %s outcome acts in that session at its epoch', async (outcome) => {
    const s = setup({
      authenticate: () => ({ outcome, sessionId: 'R1' }),
      states: { R1: { state: 'active', epoch: 3 } },
    });
    const resolution = await s.resolver.resolveSession(request(), { family: 'rest', mode: 'legacy-primary' });
    expect(resolution).toEqual({
      kind: 'session',
      sessionId: 'R1',
      epoch: 3,
      mode: 'legacy-primary',
      legacyCookies: {},
      setCookies: [],
    });
    expect(s.authenticated[0]?.siteId).toBe('default');
  });

  it('an anonymous outcome or an ended session is no session', async () => {
    expect(await setup().resolver.resolveSession(request(), { family: 'rest', mode: 'target-primary' })).toEqual({
      kind: 'none',
      setCookies: [],
    });
    const ended = setup({ authenticate: () => ({ outcome: 'session', sessionId: 'R2' }) });
    expect((await ended.resolver.resolveSession(request(), { family: 'rest', mode: 'target-primary' })).kind).toBe(
      'none',
    );
  });

  it('an answer without its legacy response is identity unavailable', async () => {
    const s = setup({ authenticate: () => ({ outcome: 'answered', sessionId: null }) });
    await expect(
      s.resolver.resolveSession(request(), { family: 'rest', mode: 'target-primary' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});

describe('target-primary target-bound requests', () => {
  it('identity-issued cookies resolve the session and its jar without a describe', async () => {
    const s = setup({
      states: { T1: { state: 'active', epoch: 5 } },
      rows: [jarRow('T1', { cookies: cookie('CFID', 'L-CFID'), hydratedEpoch: 5 })],
    });
    const resolution = asSession(
      await s.resolver.resolveSession(request('JSESSIONID=T1'), { family: 'admin', mode: 'target-primary' }),
    );
    expect(resolution).toMatchObject({ sessionId: 'T1', epoch: 5, mode: 'target-primary', setCookies: [] });
    expect(resolution.legacyCookies.CFID?.value).toBe('L-CFID');
    expect(s.calls).toEqual(['check:T1', 'jar.get']);
  });

  it('adopts a live legacy session and re-emits target cookies under legacy names and attributes', async () => {
    const s = setup({ describe: () => ({ body: describeBody('LEG-9'), setCookies: [LEGACY_CFID] }) });
    const resolution = asSession(
      await s.resolver.resolveSession(request('CFID=L-CFID; CFTOKEN=L-CFTOKEN; JSESSIONID=L-J; MXP=1'), {
        family: 'admin',
        mode: 'target-primary',
        siteId: 'tenant-a',
      }),
    );
    expect(s.calls).toEqual(['check:L-J', 'describe', 'jar.find', 'adopt', 'jar.rebind']);
    expect(s.described[0]?.userAgent).toBe('Mozilla/5.0');
    expect(Object.keys(s.described[0]?.cookies ?? {}).sort()).toEqual(['CFID', 'CFTOKEN', 'JSESSIONID']);
    expect(s.adopted[0]).toEqual({ describe: describeBody('LEG-9'), siteId: 'tenant-a' });
    expect(s.rows.get(ADOPTED_ID)).toMatchObject({
      legacySessionId: 'LEG-9',
      mode: 'target-primary',
      hydratedEpoch: ADOPTED_EPOCH,
    });
    expect(s.rows.get(ADOPTED_ID)?.cookies.CFID).toEqual({
      name: 'CFID',
      value: 'L-CFID',
      attributes: LEGACY_CFID.slice(LEGACY_CFID.indexOf(';') + 1),
    });
    expect(resolution).toMatchObject({ sessionId: ADOPTED_ID, epoch: ADOPTED_EPOCH });
    expect(setCookieOf(resolution.setCookies, 'CFID')).toBe(LEGACY_CFID.replace('L-CFID', 'T-CFID'));
    expect(parseSetCookie(setCookieOf(resolution.setCookies, 'JSESSIONID') ?? '').value).toBe(ADOPTED_ID);
    expect(resolution.setCookies.join('\n')).not.toMatch(/L-CFID|L-CFTOKEN|L-J/);
  });

  it('emits an identity cookie legacy never set in identity form', async () => {
    const s = setup();
    const resolution = asSession(
      await s.resolver.resolveSession(request('CFID=L-CFID; CFTOKEN=L-CFTOKEN'), {
        family: 'api',
        mode: 'target-primary',
      }),
    );
    expect(setCookieOf(resolution.setCookies, 'JSESSIONID')).toBe(
      setCookieLegacy({ name: 'JSESSIONID', value: ADOPTED_ID }),
    );
  });

  /** ColdFusion's describe answer when the cookies attach no session: new session cookies and a non-session one. */
  const opened = [
    setCookieLegacy({ name: 'CFID', value: 'N-CFID', expires: 'never' }, {}, NOW),
    setCookieLegacy({ name: 'CFTOKEN', value: 'N-CFTOKEN', expires: 'never' }, {}, NOW),
    'MXP_TRACKINGID=TRACK-1;expires=Tue, 30-Jun-2076 12:00:00 GMT;path=/;',
  ];
  const tail = (setCookie: string | undefined = '') => setCookie.slice(setCookie.indexOf(';') + 1);

  it.each<[string, string, JarCookies, string[], string | undefined]>([
    ['no session cookies', 'MXP=1', {}, [], undefined],
    ['a stale JSESSIONID', 'JSESSIONID=STALE; MXP=1', cookie('JSESSIONID', 'STALE'), ['check:STALE'], undefined],
    [
      'a stale CFID and CFTOKEN',
      'CFID=S-CFID; CFTOKEN=S-CFTOKEN',
      { ...cookie('CFID', 'S-CFID'), ...cookie('CFTOKEN', 'S-CFTOKEN') },
      [],
      'tenant-a',
    ],
  ])('adopts the session ColdFusion opens for a request with %s', async (_label, header, sent, checks, siteId) => {
    const s = setup({ describe: () => ({ body: describeBody('NEW'), setCookies: opened }) });
    const resolution = asSession(
      await s.resolver.resolveSession(request(header), { family: 'admin', mode: 'target-primary', siteId }),
    );

    expect(resolution).toMatchObject({ sessionId: ADOPTED_ID, epoch: ADOPTED_EPOCH, mode: 'target-primary' });
    expect(s.calls).toEqual([...checks, 'describe', 'jar.find', 'adopt', 'jar.rebind']);
    expect(s.described).toEqual([{ cookies: sent, userAgent: 'Mozilla/5.0' }]);
    expect(s.adopted).toEqual([{ describe: describeBody('NEW'), siteId: siteId ?? 'default' }]);
    const row = s.rows.get(ADOPTED_ID);
    expect(row).toMatchObject({ legacySessionId: 'NEW', mode: 'target-primary', hydratedEpoch: ADOPTED_EPOCH });
    expect(row?.cookies).toEqual({
      ...sent,
      ...cookie('CFID', 'N-CFID', tail(opened[0])),
      ...cookie('CFTOKEN', 'N-CFTOKEN', tail(opened[1])),
    });
    expect(resolution.legacyCookies).toEqual(row?.cookies);
    expect([...resolution.setCookies].sort()).toEqual(
      [
        opened[0]?.replace('N-CFID', 'T-CFID'),
        opened[1]?.replace('N-CFTOKEN', 'T-CFTOKEN'),
        setCookieLegacy({ name: 'JSESSIONID', value: ADOPTED_ID }),
      ].sort(),
    );
    expect(resolution.setCookies.join('\n')).not.toMatch(/N-CFID|N-CFTOKEN|S-CF|STALE|MXP_TRACKINGID/);
  });
});

describe('legacy-primary target-bound requests', () => {
  it('describes, adopts and records the jar, passing ColdFusion Set-Cookie through unchanged', async () => {
    const created = [
      setCookieLegacy({ name: 'CFID', value: 'N-CFID' }),
      setCookieLegacy({ name: 'CFTOKEN', value: 'N-CFTOKEN' }),
      'MXP=1;path=/;',
    ];
    const s = setup({ describe: () => ({ body: describeBody('LEG-N'), setCookies: created }) });
    const resolution = asSession(
      await s.resolver.resolveSession(request(), { family: 'admin', mode: 'legacy-primary' }),
    );
    expect(s.calls).toEqual(['describe', 'jar.find', 'adopt', 'jar.rebind']);
    expect(resolution.setCookies).toEqual(created);
    expect(resolution.legacyCookies).toEqual({});
    expect(s.rows.get(ADOPTED_ID)).toMatchObject({
      legacySessionId: 'LEG-N',
      mode: 'legacy-primary',
      hydratedEpoch: null,
    });
    expect(s.rows.get(ADOPTED_ID)?.cookies.CFID?.value).toBe('N-CFID');
  });

  it('switching back re-emits the jar legacy cookies and records the mode', async () => {
    const legacyCookies = {
      ...cookie('CFID', 'L-CFID', 'domain=example.com;path=/;HttpOnly;'),
      ...cookie('JSESSIONID', 'L-J'),
    };
    const s = setup({
      adopt: () => ({ sessionId: 'T1', epoch: 9, setCookie: [] }),
      states: T1_ACTIVE,
      rows: [jarRow('T1', { cookies: legacyCookies, hydratedEpoch: 4 })],
    });
    const resolution = asSession(
      await s.resolver.resolveSession(request('JSESSIONID=T1; CFID=T-CFID'), {
        family: 'admin',
        mode: 'legacy-primary',
      }),
    );
    expect(s.described[0]?.cookies).toEqual(legacyCookies);
    expect(resolution.setCookies).toEqual([
      'CFID=L-CFID;domain=example.com;path=/;HttpOnly;',
      'JSESSIONID=L-J;path=/;HttpOnly;',
    ]);
    expect(resolution.legacyCookies).toEqual(legacyCookies);
    expect(s.rows.get('T1')).toMatchObject({ mode: 'legacy-primary', hydratedEpoch: null });
  });

  it('switching back rebinds the mapping identity superseded from the previous session in one write', async () => {
    const s = setup({
      adopt: () => ({ sessionId: 'S-NEW', epoch: 1, setCookie: [] }),
      states: T1_ACTIVE,
      rows: [jarRow('T1', { cookies: cookie('JSESSIONID', 'L-J'), hydratedEpoch: 4 })],
    });
    const resolution = asSession(
      await s.resolver.resolveSession(request('JSESSIONID=T1'), { family: 'admin', mode: 'legacy-primary' }),
    );
    expect(resolution.sessionId).toBe('S-NEW');
    expect(s.calls).toEqual(SWITCH_BACK);
    expect(s.rebinds).toEqual([
      {
        input: {
          sessionId: 'S-NEW',
          legacySessionId: 'LEG-1',
          cookies: cookie('JSESSIONID', 'L-J'),
          mode: 'legacy-primary',
          hydratedEpoch: null,
        },
        previousSessionId: 'T1',
      },
    ]);
    expect(s.rows.has('T1')).toBe(false);
    expect(s.rows.get('S-NEW')?.cookies.JSESSIONID?.value).toBe('L-J');
  });
});

describe('resolveLegacyBound', () => {
  it('target-primary uses the mapped jar without a describe', async () => {
    const s = setup({ states: { T1: { state: 'active', epoch: 2 } }, rows: [jarRow('T1', { hydratedEpoch: 2 })] });
    const resolution = await s.resolver.resolveLegacyBound(request('JSESSIONID=T1'), {
      mode: 'target-primary',
      adopt: true,
    });
    expect(resolution).toMatchObject({ kind: 'session', sessionId: 'T1', epoch: 2 });
    expect(s.calls).toEqual(['check:T1', 'jar.get']);
  });

  it('target-primary adopts an unmapped legacy session only when adopt is true', async () => {
    const s = setup();
    expect(
      (await s.resolver.resolveLegacyBound(request('JSESSIONID=L-J'), { mode: 'target-primary', adopt: false })).kind,
    ).toBe('none');
    expect(s.calls).toEqual(['check:L-J']);
    const resolution = await s.resolver.resolveLegacyBound(request('JSESSIONID=L-J'), {
      mode: 'target-primary',
      adopt: true,
    });
    expect(resolution).toMatchObject({ kind: 'session', sessionId: ADOPTED_ID });
    expect(s.calls.slice(1)).toEqual(['check:L-J', 'describe', 'jar.find', 'adopt', 'jar.rebind']);
  });

  it('legacy-primary without legacy cookies has no session', async () => {
    const s = setup();
    expect(await s.resolver.resolveLegacyBound(request(), { mode: 'legacy-primary', adopt: true })).toEqual({
      kind: 'none',
      setCookies: [],
    });
    expect(s.calls).toEqual([]);
  });

  it('legacy-primary finds the session mapped to the described legacy session', async () => {
    const s = setup({
      states: { M1: { state: 'active', epoch: 6 } },
      rows: [jarRow('M1', { mode: 'legacy-primary' })],
    });
    const resolution = await s.resolver.resolveLegacyBound(request('JSESSIONID=L-J'), {
      mode: 'legacy-primary',
      adopt: false,
    });
    expect(resolution).toMatchObject({
      kind: 'session',
      sessionId: 'M1',
      epoch: 6,
      mode: 'legacy-primary',
      legacyCookies: {},
      setCookies: [],
    });
    expect(s.calls).toEqual(['jar.get', 'describe', 'jar.find', 'check:M1']);
  });

  it.each([
    [false, 'none'],
    [true, 'session'],
  ] as const)('legacy-primary with adopt %s answers %s for an unmapped session', async (adopt, kind) => {
    const s = setup();
    const resolution = await s.resolver.resolveLegacyBound(request('JSESSIONID=L-J'), {
      mode: 'legacy-primary',
      adopt,
    });
    expect(resolution.kind).toBe(kind);
    expect(s.adopted).toHaveLength(adopt ? 1 : 0);
    if (adopt) {
      expect(s.rows.get(ADOPTED_ID)).toMatchObject({ mode: 'legacy-primary', hydratedEpoch: null });
      expect(resolution).toMatchObject({ legacyCookies: {}, setCookies: [] });
    }
  });
});

describe('sessions whose jar is marked pending-end', () => {
  const MARKED: Partial<JarRow> = { identityEndPendingAt: NOW };

  it.each<[string, (s: ReturnType<typeof setup>) => Promise<SessionResolution>, JarRow, string[]]>([
    [
      'a target-primary target-bound request',
      (s) => s.resolver.resolveSession(request('JSESSIONID=T1'), { family: 'admin', mode: 'target-primary' }),
      jarRow('T1', MARKED),
      ['check:T1', 'jar.get'],
    ],
    [
      'a target-primary legacy-bound request',
      (s) => s.resolver.resolveLegacyBound(request('JSESSIONID=T1'), { mode: 'target-primary', adopt: true }),
      jarRow('T1', MARKED),
      ['check:T1', 'jar.get'],
    ],
    [
      'a legacy-primary legacy-bound request',
      (s) => s.resolver.resolveLegacyBound(request('JSESSIONID=L-J'), { mode: 'legacy-primary', adopt: false }),
      jarRow('T1', { ...MARKED, mode: 'legacy-primary' }),
      ['jar.get', 'describe', 'jar.find', 'check:T1'],
    ],
  ])('flag %s from the jar row already read', async (_label, resolve, row, calls) => {
    const s = setup({ states: T1_ACTIVE, rows: [row] });
    expect(await resolve(s)).toMatchObject({ kind: 'session', sessionId: 'T1', epoch: 4, identityEndPending: true });
    expect(s.calls).toEqual(calls);
  });
});

describe('legacy-bound requests right after a switch back to legacy-primary', () => {
  const JAR_COOKIES: JarCookies = {
    ...cookie('CFID', 'L-CFID', 'domain=example.com;path=/;HttpOnly;'),
    ...cookie('CFTOKEN', 'L-CFTOKEN'),
    ...cookie('JSESSIONID', 'L-J'),
  };
  const JAR_SET_COOKIES = [
    'CFID=L-CFID;domain=example.com;path=/;HttpOnly;',
    'CFTOKEN=L-CFTOKEN;path=/;HttpOnly;',
    'JSESSIONID=L-J;path=/;HttpOnly;',
  ];
  const TARGET_COOKIE_HEADER = 'JSESSIONID=T1; CFID=T-CFID; CFTOKEN=T-CFTOKEN';

  /** A resolver holding T1's target-primary jar, where identity re-adopts the legacy session as `adoptedId`. */
  function reversed(adoptedId: string) {
    return setup({
      adopt: () => ({ sessionId: adoptedId, epoch: 9, setCookie: [] }),
      states: T1_ACTIVE,
      rows: [jarRow('T1', { cookies: JAR_COOKIES, hydratedEpoch: 4 })],
    });
  }

  it.each([
    [false, 'T1'],
    [true, 'T1'],
    [false, 'S-NEW'],
    [true, 'S-NEW'],
  ] as const)(
    'with adopt %s restores the jar as %s on the first request and forwards its legacy cookies',
    async (adopt, adoptedId) => {
      const s = reversed(adoptedId);
      const resolution = asSession(
        await s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), { mode: 'legacy-primary', adopt }),
      );
      expect(resolution).toEqual({
        kind: 'session',
        sessionId: adoptedId,
        epoch: 9,
        mode: 'legacy-primary',
        legacyCookies: JAR_COOKIES,
        setCookies: JAR_SET_COOKIES,
      });
      expect(s.calls).toEqual(SWITCH_BACK);
      expect(s.described.map((call) => call.cookies)).toEqual([JAR_COOKIES]);
      expect(s.rebinds.map((call) => call.previousSessionId)).toEqual(['T1']);
      expect(s.rows.get(adoptedId)).toMatchObject({ legacySessionId: 'LEG-1', mode: 'legacy-primary' });
      expect(s.rows.has('T1')).toBe(adoptedId === 'T1');
    },
  );

  it('answers every later resolution of the same request with the restored session', async () => {
    const s = reversed('S-NEW');
    const req = request(TARGET_COOKIE_HEADER);
    const [first, concurrent] = await Promise.all([
      s.resolver.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: false }),
      s.resolver.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: true }),
    ]);
    const again = await s.resolver.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: true });
    const targetBound = await s.resolver.resolveSession(req, { family: 'admin', mode: 'legacy-primary' });

    expect(asSession(first)).toMatchObject({ sessionId: 'S-NEW', legacyCookies: JAR_COOKIES });
    for (const later of [concurrent, again, targetBound]) expect(later).toBe(first);
    expect(s.calls.filter((call) => call === 'describe' || call === 'adopt')).toEqual(['describe', 'adopt']);
  });

  it('switches back again on the next resolution when the first switch back failed', async () => {
    let failures = 1;
    const s = setup({
      adopt: () => ({ sessionId: 'T1', epoch: 9, setCookie: [] }),
      describe: () => {
        if (failures-- > 0) throw new ServiceUnavailableError('legacy-bridge', new Error('refused'));
        return { body: describeBody('LEG-1'), setCookies: [] };
      },
      states: T1_ACTIVE,
      rows: [jarRow('T1', { cookies: JAR_COOKIES, hydratedEpoch: 4 })],
    });
    const req = request(TARGET_COOKIE_HEADER);
    await expect(s.resolver.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: false })).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(s.resolver.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: false })).resolves.toMatchObject({
      kind: 'session',
      sessionId: 'T1',
      setCookies: JAR_SET_COOKIES,
    });
    expect(s.calls.filter((call) => call === 'describe')).toHaveLength(2);
  });

  it('ends two concurrent switch backs of one jar in the same restored session, one after the other', async () => {
    const s = reversed('S-NEW');
    const [first, second] = await Promise.all([
      s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), { mode: 'legacy-primary', adopt: false }),
      s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), { mode: 'legacy-primary', adopt: false }),
    ]);

    for (const resolution of [first, second]) {
      expect(resolution).toEqual({
        kind: 'session',
        sessionId: 'S-NEW',
        epoch: 9,
        mode: 'legacy-primary',
        legacyCookies: JAR_COOKIES,
        setCookies: JAR_SET_COOKIES,
      });
    }
    const section = SWITCH_BACK.slice(3);
    expect(s.calls.filter((call) => call.startsWith('lock.session:'))).toEqual(['lock.session:T1', 'lock.session:T1']);
    expect(s.calls.filter((call) => section.includes(call))).toEqual([...section, ...section]);
    expect(s.described.map((call) => call.cookies)).toEqual([JAR_COOKIES, JAR_COOKIES]);
    expect(s.rebinds.map((call) => call.previousSessionId)).toEqual(['T1', 'T1']);
    expect([...s.rows.keys()]).toEqual(['S-NEW']);
  });

  it('never hands back the legacy session of an ended target session, whose jar records the legacy end still owed', async () => {
    const s = setup({ rows: [jarRow('T1', { cookies: JAR_COOKIES, hydratedEpoch: 4 })] });
    const resolution = await s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), {
      mode: 'legacy-primary',
      adopt: false,
    });
    expect(resolution).toEqual({ kind: 'none', setCookies: [] });
    expect(s.calls.slice(0, 2)).toEqual(['jar.get', 'check:T1']);
    expect(s.calls).not.toContain('lock.session:T1');
    expect(s.described.map((call) => call.cookies)).not.toContainEqual(JAR_COOKIES);
    expect(s.rebinds).toEqual([]);
    expect(s.rows.get('T1')).toMatchObject({ cookies: JAR_COOKIES, mode: 'target-primary' });
  });

  it('resolves a target jar marked pending-end to its own flagged session without switching back', async () => {
    const marked = jarRow('T1', { cookies: JAR_COOKIES, hydratedEpoch: 4, identityEndPendingAt: NOW });
    const s = setup({ states: T1_ACTIVE, rows: [marked] });
    const resolution = await s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), {
      mode: 'legacy-primary',
      adopt: true,
    });
    expect(resolution).toEqual({
      kind: 'session',
      sessionId: 'T1',
      epoch: 4,
      mode: 'legacy-primary',
      legacyCookies: {},
      setCookies: [],
      identityEndPending: true,
    });
    expect(s.calls).toEqual(['jar.get', 'check:T1']);
    expect(s.rows.get('T1')).toEqual(marked);
  });

  it('restores nothing when another target-primary jar changed the legacy session its cookies named', async () => {
    const answers = ['LEG-1', 'LEG-2', 'LEG-3'];
    const s = setup({
      describe: () => ({ body: describeBody(answers.shift() ?? 'LEG-9'), setCookies: [] }),
      states: T1_ACTIVE,
      rows: [
        jarRow('T1', { legacySessionId: null, cookies: JAR_COOKIES, hydratedEpoch: 4 }),
        jarRow('T2', { legacySessionId: 'LEG-1' }),
      ],
    });
    const resolution = await s.resolver.resolveLegacyBound(request(TARGET_COOKIE_HEADER), {
      mode: 'legacy-primary',
      adopt: false,
    });

    expect(resolution).toEqual({ kind: 'none', setCookies: [] });
    expect(s.calls.slice(0, 8)).toEqual([
      'jar.get',
      'check:T1',
      'lock.session:T1',
      'locked.get',
      'describe',
      'lock.native:LEG-1',
      'locked.find',
      'describe',
    ]);
    expect(s.adopted).toEqual([]);
    expect(s.rebinds).toEqual([]);
    expect([...s.rows.keys()]).toEqual(['T1', 'T2']);
  });

});

describe('adoption of a legacy session another jar holds', () => {
  const LEGACY_REQUEST = 'CFID=L-CFID';

  it.each<[string, JarRow['mode'], string[]]>([
    [
      'describes it again under its lock when a target-primary jar holds it',
      'target-primary',
      ['describe', 'jar.find', 'lock.native:LEG-1', 'describe', 'adopt', 'locked.rebind'],
    ],
    [
      'adopts at once when a legacy-primary jar holds it',
      'legacy-primary',
      ['describe', 'jar.find', 'adopt', 'jar.rebind'],
    ],
  ])('%s', async (_label, mode, calls) => {
    let describes = 0;
    const s = setup({
      describe: () => ({
        body: { ...describeBody('LEG-1'), memberships: `describe-${String(++describes)}` },
        setCookies: [],
      }),
      rows: [jarRow('HOLDER', { mode, legacySessionId: 'LEG-1' })],
    });
    const resolution = await s.resolver.resolveSession(request(LEGACY_REQUEST), {
      family: 'admin',
      mode: 'legacy-primary',
    });

    expect(resolution).toMatchObject({ kind: 'session', sessionId: ADOPTED_ID, mode: 'legacy-primary' });
    expect(s.calls).toEqual(calls);
    expect(s.described.map((call) => call.cookies)).toEqual(s.described.map(() => cookie('CFID', 'L-CFID')));
    expect(s.adopted.map((input) => input.describe.memberships)).toEqual([`describe-${String(describes)}`]);
    expect([...s.rows.keys()]).toEqual([ADOPTED_ID]);
  });

  const legacySet = [setCookieLegacy({ name: 'CFID', value: 'N-CFID' }), 'MXP=1;path=/;'];
  it.each<[string, (s: ReturnType<typeof setup>) => Promise<SessionResolution>, string[], string[]]>([
    [
      'a target-primary adoption',
      (s) => s.resolver.resolveSession(request('JSESSIONID=L-J'), { family: 'admin', mode: 'target-primary' }),
      ['check:L-J', 'describe', 'jar.find', 'lock.native:LEG-1', 'describe'],
      [],
    ],
    [
      'a legacy-primary target-bound adoption',
      (s) => s.resolver.resolveSession(request(LEGACY_REQUEST), { family: 'admin', mode: 'legacy-primary' }),
      ['describe', 'jar.find', 'lock.native:LEG-1', 'describe'],
      [],
    ],
    [
      'a legacy-primary legacy-bound adoption',
      (s) => s.resolver.resolveLegacyBound(request(LEGACY_REQUEST), { mode: 'legacy-primary', adopt: true }),
      ['describe', 'jar.find', 'check:HOLDER', 'jar.find', 'lock.native:LEG-1', 'describe'],
      [],
    ],
    [
      'an adoption of the session a legacy response created',
      (s) => s.resolver.adoptAfterLegacy(request(), { mode: 'target-primary', setCookies: legacySet }),
      ['describe', 'jar.find', 'lock.native:LEG-1', 'describe'],
      ['MXP=1;path=/;'],
    ],
  ])('answers none for %s whose second describe names another legacy session', async (_l, resolve, calls, set) => {
    const answers = ['LEG-1', 'LEG-2'];
    const holder = jarRow('HOLDER', { legacySessionId: 'LEG-1' });
    const s = setup({
      describe: () => ({ body: describeBody(answers.shift() ?? 'LEG-9'), setCookies: [] }),
      rows: [holder],
    });

    await expect(resolve(s)).resolves.toEqual({ kind: 'none', setCookies: set });
    expect(s.calls).toEqual(calls);
    expect(s.adopted).toEqual([]);
    expect(s.rebinds).toEqual([]);
    expect([...s.rows.values()]).toEqual([holder]);
  });
});

describe('adoptAfterLegacy', () => {
  const legacySet = [
    setCookieLegacy({ name: 'CFID', value: 'N-CFID', domain: 'example.com' }),
    setCookieLegacy({ name: 'CFTOKEN', value: 'N-CFTOKEN' }),
    'MXP=1;path=/;',
  ];
  const TARGET_REQUEST = 'JSESSIONID=T1; CFID=T-CFID; CFTOKEN=T-CFTOKEN';
  /** `legacySet` as the browser receives it on a T1 request: identity's values under legacy's attributes. */
  const targetSet = [
    legacySet[0]?.replace('N-CFID', 'T-CFID'),
    legacySet[1]?.replace('N-CFTOKEN', 'T-CFTOKEN'),
    'MXP=1;path=/;',
  ];
  /** Calls of an absorb into T1's jar holding `legacySessionId`: its locked re-reads around that session's lock. */
  const absorbCalls = (legacySessionId: string) => [
    'check:T1',
    'jar.get',
    'lock.session:T1',
    'locked.get',
    `lock.native:${legacySessionId}`,
    'locked.get',
    'locked.upsert',
  ];

  it('legacy-primary leaves the legacy Set-Cookie values unchanged', async () => {
    const s = setup();
    expect(
      await s.resolver.adoptAfterLegacy(request('CFID=1'), { mode: 'legacy-primary', setCookies: legacySet }),
    ).toEqual({
      kind: 'none',
      setCookies: legacySet,
    });
    expect(s.calls).toEqual([]);
  });

  it('absorbs replaced legacy cookies into the session jar and re-emits the target values', async () => {
    const s = setup({
      states: { T1: { state: 'active', epoch: 3 } },
      rows: [jarRow('T1', { cookies: cookie('CFID', 'OLD-CFID'), hydratedEpoch: 3 })],
    });
    const resolution = await s.resolver.adoptAfterLegacy(request(TARGET_REQUEST), {
      mode: 'target-primary',
      setCookies: legacySet,
    });
    expect(resolution.kind === 'response' ? [] : resolution.setCookies).toEqual(targetSet);
    expect(s.calls).toEqual(absorbCalls('LEG-1'));
    expect(s.rows.get('T1')).toMatchObject({ legacySessionId: null, hydratedEpoch: null });
    expect(s.rows.get('T1')?.cookies.CFID?.value).toBe('N-CFID');
    expect(s.rows.get('T1')?.cookies.CFTOKEN?.value).toBe('N-CFTOKEN');
  });

  it('keeps the hydration state when legacy re-sets the same values', async () => {
    const s = setup({
      states: { T1: { state: 'active', epoch: 3 } },
      rows: [jarRow('T1', { cookies: cookie('CFID', 'N-CFID'), hydratedEpoch: 3 })],
    });
    await s.resolver.adoptAfterLegacy(request('JSESSIONID=T1; CFID=T-CFID'), {
      mode: 'target-primary',
      setCookies: legacySet,
    });
    expect(s.calls).toEqual(absorbCalls('LEG-1'));
    expect(s.rows.get('T1')).toMatchObject({ legacySessionId: 'LEG-1', hydratedEpoch: 3 });
  });

  it.each<[string, string, (rows: Map<string, JarRow>) => void, string[], JarRow[]]>([
    [
      'dropped',
      'lock.session:T1',
      (rows) => rows.delete('T1'),
      ['check:T1', 'jar.get', 'lock.session:T1', 'locked.get'],
      [],
    ],
    [
      'rebound to another session',
      'lock.native:LEG-1',
      (rows) => {
        rows.delete('T1');
        rows.set('T2', jarRow('T2'));
      },
      absorbCalls('LEG-1').slice(0, -1),
      [jarRow('T2')],
    ],
  ])('writes no jar when it was %s after the request read it', async (_label, lockKey, change, calls, after) => {
    const s = setup({
      states: { T1: { state: 'active', epoch: 3 } },
      rows: [jarRow('T1', { cookies: cookie('CFID', 'OLD-CFID'), hydratedEpoch: 3 })],
      onLock: (key, rows) => {
        if (key === lockKey) change(rows);
      },
    });
    const resolution = await s.resolver.adoptAfterLegacy(request(TARGET_REQUEST), {
      mode: 'target-primary',
      setCookies: legacySet,
    });

    expect(resolution).toEqual({
      kind: 'session',
      sessionId: 'T1',
      epoch: 3,
      mode: 'target-primary',
      legacyCookies: {},
      setCookies: targetSet,
    });
    expect(s.calls).toEqual(calls);
    expect([...s.rows.values()]).toEqual(after);
  });

  it.each<[string, string, Partial<JarRow>]>([
    ['keeps', 'N-CFID', { legacySessionId: 'LEG-2', hydratedEpoch: 5 }],
    ['clears', 'OLD-CFID', { legacySessionId: null, hydratedEpoch: null }],
  ])('%s the hydration state as the jar re-read under its lock says', async (_label, rereadCfid, expected) => {
    // The first read says the opposite: N-CFID would keep LEG-1 at epoch 3, OLD-CFID would clear it.
    const firstCfid = rereadCfid === 'N-CFID' ? 'OLD-CFID' : 'N-CFID';
    const reread = jarRow('T1', { legacySessionId: 'LEG-2', cookies: cookie('CFID', rereadCfid), hydratedEpoch: 5 });
    const s = setup({
      states: { T1: { state: 'active', epoch: 3 } },
      rows: [jarRow('T1', { cookies: cookie('CFID', firstCfid), hydratedEpoch: 3 })],
      onLock: (key, rows) => {
        if (key === 'lock.session:T1') rows.set('T1', reread);
      },
    });
    const resolution = asSession(
      await s.resolver.adoptAfterLegacy(request(TARGET_REQUEST), { mode: 'target-primary', setCookies: legacySet }),
    );

    expect(s.calls).toEqual(absorbCalls('LEG-2'));
    expect(s.rows.get('T1')).toMatchObject(expected);
    expect(resolution.legacyCookies).toEqual(s.rows.get('T1')?.cookies);
    expect(resolution.setCookies).toEqual(targetSet);
  });

  it('writes the first jar of a session that had none', async () => {
    const s = setup({ states: { T1: { state: 'active', epoch: 3 } } });
    const resolution = asSession(
      await s.resolver.adoptAfterLegacy(request(TARGET_REQUEST), { mode: 'target-primary', setCookies: legacySet }),
    );

    expect(s.calls).toEqual(['check:T1', 'jar.get', 'lock.session:T1', 'locked.get', 'locked.upsert']);
    expect(s.rows.get('T1')).toMatchObject({ legacySessionId: null, mode: 'target-primary', hydratedEpoch: null });
    expect(Object.values(s.rows.get('T1')?.cookies ?? {}).map((jarCookie) => jarCookie.value)).toEqual([
      'N-CFID',
      'N-CFTOKEN',
    ]);
    expect(resolution).toMatchObject({ sessionId: 'T1', epoch: 3, setCookies: targetSet });
    expect(resolution.legacyCookies).toEqual(s.rows.get('T1')?.cookies);
  });

  it('adopts the session legacy created when no target session existed', async () => {
    const s = setup();
    const resolution = asSession(
      await s.resolver.adoptAfterLegacy(request(), { mode: 'target-primary', setCookies: legacySet }),
    );
    expect(s.calls).toEqual(['describe', 'jar.find', 'adopt', 'jar.rebind']);
    expect(s.described[0]?.cookies).toMatchObject({ CFID: { value: 'N-CFID' }, CFTOKEN: { value: 'N-CFTOKEN' } });
    expect(resolution.setCookies).toEqual(
      expect.arrayContaining([legacySet[0]?.replace('N-CFID', 'T-CFID'), 'MXP=1;path=/;']),
    );
    expect(resolution.setCookies.join('\n')).not.toMatch(/N-CFID|N-CFTOKEN/);
    expect(s.rows.get(ADOPTED_ID)).toMatchObject({ mode: 'target-primary', hydratedEpoch: ADOPTED_EPOCH });
  });

  it('passes only deletions and other cookies when the legacy session is not live', async () => {
    const deletion = 'CFID=;expires=Thu, 01-Jan-1970 00:00:00 GMT;path=/;';
    const s = setup();
    expect(
      await s.resolver.adoptAfterLegacy(request(), { mode: 'target-primary', setCookies: [deletion, 'MXP=1;'] }),
    ).toEqual({
      kind: 'none',
      setCookies: [deletion, 'MXP=1;'],
    });
    expect(s.calls).toEqual([]);
  });

  it('passes Set-Cookie values unchanged when legacy set no session cookie', async () => {
    const s = setup({ states: { T1: { state: 'active', epoch: 3 } } });
    const resolution = await s.resolver.adoptAfterLegacy(request('JSESSIONID=T1'), {
      mode: 'target-primary',
      setCookies: ['MXP=1;'],
    });
    expect(resolution).toMatchObject({ kind: 'session', sessionId: 'T1', setCookies: ['MXP=1;'] });
    expect(
      await setup().resolver.adoptAfterLegacy(request(), { mode: 'target-primary', setCookies: ['MXP=1;'] }),
    ).toEqual({
      kind: 'none',
      setCookies: ['MXP=1;'],
    });
  });
});
