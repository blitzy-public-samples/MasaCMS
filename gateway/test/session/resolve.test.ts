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
import type { JarCookies, JarRow, JarUpsert, LegacyJar } from '../../src/session/jar.js';
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

interface Fakes {
  states?: ActiveStates;
  describe?: (cookies: LegacyCookies) => BridgeResult<LegacyDescribe>;
  adopt?: (input: AdoptInput) => AdoptedSession;
  authenticate?: (input: RestAuthInput) => RestAuthOutcome;
  rows?: JarRow[];
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

  const jar: LegacyJar = {
    get(sessionId) {
      calls.push('jar.get');
      return Promise.resolve(rows.get(sessionId));
    },
    findByLegacySessionId(legacySessionId) {
      calls.push('jar.find');
      return Promise.resolve([...rows.values()].find((row) => row.legacySessionId === legacySessionId));
    },
    upsert(input: JarUpsert) {
      calls.push('jar.upsert');
      const row = { ...input, cookies: { ...rows.get(input.sessionId)?.cookies, ...input.cookies }, updatedAt: NOW };
      rows.set(input.sessionId, row);
      return Promise.resolve(row);
    },
    setHydratedEpoch() {
      return Promise.resolve(true);
    },
    drop(sessionId) {
      calls.push('jar.drop');
      return Promise.resolve(rows.delete(sessionId));
    },
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
    rows,
  };
}

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
    expect(s.calls).toEqual(['check:L-J', 'describe', 'adopt', 'jar.upsert']);
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

  it('does not adopt a session ColdFusion created while describing', async () => {
    const s = setup({
      describe: () => ({
        body: describeBody('NEW'),
        setCookies: [setCookieLegacy({ name: 'JSESSIONID', value: 'NEW-J' })],
      }),
    });
    expect(
      await s.resolver.resolveSession(request('JSESSIONID=STALE'), { family: 'api', mode: 'target-primary' }),
    ).toEqual({
      kind: 'none',
      setCookies: [],
    });
    expect(s.calls).toEqual(['check:STALE', 'describe']);
  });

  it('a request without session cookies has no session and calls nobody', async () => {
    const s = setup();
    expect(await s.resolver.resolveSession(request('MXP=1'), { family: 'admin', mode: 'target-primary' })).toEqual({
      kind: 'none',
      setCookies: [],
    });
    expect(s.calls).toEqual([]);
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
    expect(s.calls).toEqual(['describe', 'adopt', 'jar.upsert']);
    expect(resolution.setCookies).toEqual(created);
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
    expect(s.rows.get('T1')).toMatchObject({ mode: 'legacy-primary', hydratedEpoch: null });
  });

  it('switching back drops the mapping identity superseded', async () => {
    const s = setup({
      adopt: () => ({ sessionId: 'S-NEW', epoch: 1, setCookie: [] }),
      rows: [jarRow('T1', { cookies: cookie('JSESSIONID', 'L-J'), hydratedEpoch: 4 })],
    });
    const resolution = asSession(
      await s.resolver.resolveSession(request('JSESSIONID=T1'), { family: 'admin', mode: 'legacy-primary' }),
    );
    expect(resolution.sessionId).toBe('S-NEW');
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
    expect(s.calls.slice(1)).toEqual(['check:L-J', 'describe', 'adopt', 'jar.upsert']);
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
      setCookies: [],
    });
    expect(s.calls).toEqual(['describe', 'jar.find', 'check:M1']);
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
    if (adopt) expect(s.rows.get(ADOPTED_ID)).toMatchObject({ mode: 'legacy-primary', hydratedEpoch: null });
  });
});

describe('adoptAfterLegacy', () => {
  const legacySet = [
    setCookieLegacy({ name: 'CFID', value: 'N-CFID', domain: 'example.com' }),
    setCookieLegacy({ name: 'CFTOKEN', value: 'N-CFTOKEN' }),
    'MXP=1;path=/;',
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
    const resolution = await s.resolver.adoptAfterLegacy(request('JSESSIONID=T1; CFID=T-CFID; CFTOKEN=T-CFTOKEN'), {
      mode: 'target-primary',
      setCookies: legacySet,
    });
    expect(resolution.kind === 'response' ? [] : resolution.setCookies).toEqual([
      legacySet[0]?.replace('N-CFID', 'T-CFID'),
      legacySet[1]?.replace('N-CFTOKEN', 'T-CFTOKEN'),
      'MXP=1;path=/;',
    ]);
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
    expect(s.rows.get('T1')).toMatchObject({ legacySessionId: 'LEG-1', hydratedEpoch: 3 });
  });

  it('adopts the session legacy created when no target session existed', async () => {
    const s = setup();
    const resolution = asSession(
      await s.resolver.adoptAfterLegacy(request(), { mode: 'target-primary', setCookies: legacySet }),
    );
    expect(s.calls).toEqual(['describe', 'adopt', 'jar.upsert']);
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
