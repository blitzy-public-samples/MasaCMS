// CSRF continuity for legacy-bound requests: token extraction, identity claims before legacy and settlement after it.
import { cfDateTimeFormat, routeKeyForRequest, type RouteKeyResult, type VariantDeclaration } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadInventoryFacts, loadVariants } from '../../src/cutover/loader.js';
import { resolveGatewayPaths } from '../../src/cutover/paths.js';
import type { CsrfValidation, RouteFacts } from '../../src/cutover/types.js';
import type { BridgeClient, LegacyCookies, LegacyDescribe, LegacyUsedToken } from '../../src/session/bridge-client.js';
import {
  createCsrfContinuity,
  csrfTokenFromRequest,
  type CsrfContinuity,
  type CsrfContinuityOptions,
  type CsrfHandle,
} from '../../src/session/csrf.js';
import type { ClaimResult, IdentityClient } from '../../src/session/identity-client.js';
import type { JarCookie, JarCookies, JarRow, JarUpsert, LegacyJar } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import {
  createSessionResolver,
  type SessionRequestInput,
  type SessionResolution,
} from '../../src/session/resolve.js';

const NOW = new Date(2026, 5, 30, 12, 34, 56, 789);
const WIRE_NOW = '2026-06-30 12:34:56.789';
const STARTED = new Date(2026, 5, 30, 12, 34, 50, 7);
const WIRE_STARTED = '2026-06-30 12:34:50.007';
const WIRE_MASK = 'yyyy-MM-dd HH:nn:ss.lll';
const WIRE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const HOUR_MS = 3_600_000;
const SESSION_ID = 'identity-session-0001';
const LEGACY_SESSION_ID = 'OPT2TEST_1001_12345678';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';
const ROUTE = 'admin:carch.update';
const CONTEXT = 'content-0001';
const TOKEN = 'A'.repeat(32);
const SECOND = 'c'.repeat(32);
const THIRD = 'E'.repeat(32);
const HEADER_VALUE = 'D'.repeat(32);
const EXPIRES = '260630153456789';
const HEADER_EXPIRES = '260630153456790';
const SET_COOKIES = ['JSESSIONID=identity-session-0001;path=/;HttpOnly'];

const liveCookie = (name: string, value: string): JarCookie => ({ name, value, attributes: 'path=/;HttpOnly' });
const expiringCookie = (name: string, value: string, offsetMs: number): JarCookie => ({
  name,
  value,
  attributes: `path=/;expires=${new Date(NOW.getTime() + offsetMs).toUTCString()};HttpOnly`,
});
const LIVE: JarCookies = { CFID: liveCookie('CFID', '1001'), CFTOKEN: liveCookie('CFTOKEN', '12345678') };
const CALL = { legacySessionId: LEGACY_SESSION_ID, userAgent: USER_AGENT };

const SESSION: SessionResolution = {
  kind: 'session',
  sessionId: SESSION_ID,
  epoch: 3,
  mode: 'target-primary',
  legacyCookies: LIVE,
  setCookies: SET_COOKIES,
};

function jarRow(overrides: Partial<JarRow> = {}): JarRow {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: LIVE,
    mode: 'target-primary',
    hydratedEpoch: 3,
    updatedAt: NOW,
    ...overrides,
  };
}

function routeFacts(csrfValidation: CsrfValidation, csrfContext?: string): RouteFacts {
  const facts: RouteFacts = { route: ROUTE, csrfValidation, writeSet: ['content'], keyScope: [], sessionEffects: ['none'] };
  if (csrfContext !== undefined) facts.csrfContext = csrfContext;
  return facts;
}

function request(overrides: Partial<SessionRequestInput> = {}): SessionRequestInput {
  return {
    path: '/admin/',
    httpMethod: 'POST',
    headers: { 'user-agent': USER_AGENT },
    query: { muraAction: 'cArch.update' },
    params: { muraAction: 'cArch.update', csrf_token: TOKEN, csrf_token_expires: EXPIRES },
    ...overrides,
  };
}

function computedKey(key: string, family: RouteKeyResult['family'], extra: Partial<RouteKeyResult> = {}): RouteKeyResult {
  return { key, baseKey: key, family, httpMethod: 'POST', params: {}, ...extra };
}

function handleOf(overrides: Partial<CsrfHandle> = {}): CsrfHandle {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    legacyCookies: LIVE,
    claimedTokens: [],
    since: WIRE_NOW,
    userAgent: USER_AGENT,
    setCookies: [],
    ...overrides,
  };
}

type Call = [op: string, ...args: unknown[]];

/** Fake identity, bridge, session resolver, jar, facts and clock sharing one ordered call log. */
interface Harness {
  calls: Call[];
  now: Date;
  resolution: SessionResolution;
  rows: Map<string, JarRow>;
  routes: Map<string, RouteFacts>;
  claimState: ClaimResult['state'];
  ledger: LegacyUsedToken[];
  continuity: CsrfContinuity;
  ops(): string[];
}

function harness(withClock = true, overrides: Partial<CsrfContinuityOptions> = {}): Harness {
  const h: Harness = {
    calls: [],
    now: NOW,
    resolution: SESSION,
    rows: new Map([[SESSION_ID, jarRow()]]),
    routes: new Map([[ROUTE, routeFacts('validates', CONTEXT)]]),
    claimState: 'pending-legacy',
    ledger: [],
    continuity: undefined as unknown as CsrfContinuity,
    ops: () => h.calls.map(([op]) => op),
  };
  const options: CsrfContinuityOptions = {
    identity: {
      claim(input) {
        h.calls.push(['identity.claim', input]);
        return Promise.resolve({ state: h.claimState });
      },
      settle(input) {
        h.calls.push(['identity.settle', input]);
        return Promise.resolve({ used: input.consumed.length, released: input.released.length });
      },
    },
    bridge: {
      markUsed(cookies, tokens, call) {
        h.calls.push(['bridge.markUsed', cookies, tokens, call]);
        return Promise.resolve({ body: { applied: tokens.length, serverTime: WIRE_NOW }, setCookies: [] });
      },
      usedSince(cookies, since, call) {
        h.calls.push(['bridge.usedSince', cookies, since, call]);
        return Promise.resolve({ body: { tokens: [...h.ledger], serverTime: WIRE_NOW }, setCookies: [] });
      },
    },
    sessions: {
      resolveLegacyBound(req, opts) {
        h.calls.push(['sessions.resolveLegacyBound', req, opts]);
        return Promise.resolve(h.resolution);
      },
    },
    jar: {
      get(sessionId) {
        h.calls.push(['jar.get', sessionId]);
        return Promise.resolve(h.rows.get(sessionId));
      },
    },
    facts: {
      get(routeKey) {
        h.calls.push(['facts.get', routeKey]);
        return h.routes.get(routeKey);
      },
      routes: () => [...h.routes.keys()],
    },
  };
  if (withClock) options.clock = { now: () => h.now };
  h.continuity = createCsrfContinuity({ ...options, ...overrides });
  return h;
}

/** Arguments of the only call named `op`. */
function onlyCall(h: Harness, op: string): unknown[] {
  const matching = h.calls.filter(([name]) => name === op);
  expect(matching).toHaveLength(1);
  return matching.flatMap(([, ...args]) => args);
}

describe('csrfTokenFromRequest', () => {
  interface TokenCase {
    name: string;
    family: string;
    headers: SessionRequestInput['headers'];
    params: Record<string, unknown>;
    expected: string | undefined;
  }

  it.each<TokenCase>([
    {
      name: 'the api family takes the X-csrf_token header over the merged param',
      family: 'api',
      headers: { 'x-csrf_token': HEADER_VALUE },
      params: { csrf_token: TOKEN },
      expected: HEADER_VALUE,
    },
    {
      name: 'the api family treats a present empty header as no token, hiding the param',
      family: 'api',
      headers: { 'x-csrf_token': '' },
      params: { csrf_token: TOKEN },
      expected: undefined,
    },
    {
      name: 'the api family falls back to the param when the header is absent',
      family: 'api',
      headers: {},
      params: { csrf_token: TOKEN },
      expected: TOKEN,
    },
    {
      name: 'the api family joins a repeated header as Node joins it',
      family: 'api',
      headers: { 'x-csrf_token': [TOKEN, SECOND] },
      params: {},
      expected: `${TOKEN}, ${SECOND}`,
    },
    {
      name: 'other families ignore the header and read the param',
      family: 'admin',
      headers: { 'x-csrf_token': HEADER_VALUE },
      params: { csrf_token: TOKEN },
      expected: TOKEN,
    },
    {
      name: 'other families carry no token from the header alone',
      family: 'admin',
      headers: { 'x-csrf_token': HEADER_VALUE },
      params: {},
      expected: undefined,
    },
    {
      name: 'param names match case-insensitively and the last spelling wins',
      family: 'admin',
      headers: {},
      params: { CSRF_TOKEN: TOKEN, Csrf_Token: SECOND },
      expected: SECOND,
    },
    {
      name: 'a numeric param reads as its string',
      family: 'page',
      headers: {},
      params: { csrf_token: 12345 },
      expected: '12345',
    },
    {
      name: 'a boolean param reads as its string',
      family: 'page',
      headers: {},
      params: { csrf_token: true },
      expected: 'true',
    },
    {
      name: 'a non-simple param is no token',
      family: 'admin',
      headers: {},
      params: { csrf_token: [TOKEN] },
      expected: undefined,
    },
    {
      name: 'an empty param is no token',
      family: 'admin',
      headers: {},
      params: { csrf_token: '' },
      expected: undefined,
    },
  ])('$name', ({ family, headers, params, expected }) => {
    expect(csrfTokenFromRequest(request({ headers, params }), family)).toBe(expected);
  });
});

describe('createCsrfContinuity beforeLegacy', () => {
  it.each<SessionMode>(['target-primary', 'legacy-primary'])(
    'claims a validating route token pending-legacy with its expiry and context, then hands back the session (%s)',
    async (mode) => {
      const h = harness();
      const req = request();
      const handle = await h.continuity.beforeLegacy(req, ' Admin:cArch.Update ', mode);

      expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get', 'identity.claim']);
      expect(onlyCall(h, 'facts.get')).toEqual([ROUTE]);
      const [resolvedRequest, resolveOptions] = onlyCall(h, 'sessions.resolveLegacyBound');
      expect(resolvedRequest).toBe(req);
      expect(resolveOptions).toStrictEqual({ mode, adopt: true, siteId: undefined });
      expect(onlyCall(h, 'jar.get')).toEqual([SESSION_ID]);
      expect(onlyCall(h, 'identity.claim')).toStrictEqual([
        { sessionId: SESSION_ID, token: TOKEN, expires: EXPIRES, context: CONTEXT },
      ]);
      expect(handle).toStrictEqual({
        sessionId: SESSION_ID,
        legacySessionId: LEGACY_SESSION_ID,
        legacyCookies: LIVE,
        claimedTokens: [TOKEN],
        since: WIRE_NOW,
        userAgent: USER_AGENT,
        setCookies: SET_COOKIES,
      });
    },
  );

  interface FieldCase {
    name: string;
    route: string;
    headers: SessionRequestInput['headers'];
    params: Record<string, unknown>;
    token: string;
    expires: string;
  }

  it.each<FieldCase>([
    {
      name: 'an api route claims the header token and header expiry',
      route: 'api:content.save',
      headers: { 'x-csrf_token': HEADER_VALUE, 'x-csrf_token_expires': HEADER_EXPIRES },
      params: { csrf_token: TOKEN, csrf_token_expires: EXPIRES },
      token: HEADER_VALUE,
      expires: HEADER_EXPIRES,
    },
    {
      name: 'an api route falls back to the param expiry when only the token header is sent',
      route: 'api:content.save',
      headers: { 'x-csrf_token': HEADER_VALUE },
      params: { csrf_token_expires: EXPIRES },
      token: HEADER_VALUE,
      expires: EXPIRES,
    },
    {
      name: 'an admin route claims the form fields and ignores the headers',
      route: 'admin:carch.update',
      headers: { 'x-csrf_token': HEADER_VALUE, 'x-csrf_token_expires': HEADER_EXPIRES },
      params: { csrf_token: TOKEN, csrf_token_expires: EXPIRES },
      token: TOKEN,
      expires: EXPIRES,
    },
    {
      name: 'a key without a family prefix reads the form fields only',
      route: 'carch.update',
      headers: { 'x-csrf_token': HEADER_VALUE },
      params: { csrf_token: TOKEN },
      token: TOKEN,
      expires: '',
    },
  ])('$name', async ({ route, headers, params, token, expires }) => {
    const h = harness();
    h.routes.set(route, routeFacts('validates', CONTEXT));
    const handle = await h.continuity.beforeLegacy(request({ headers, params }), route, 'target-primary');

    expect(onlyCall(h, 'identity.claim')).toStrictEqual([{ sessionId: SESSION_ID, token, expires, context: CONTEXT }]);
    expect(handle?.claimedTokens).toEqual([token]);
  });

  it('claims with an empty expiry and context when the request has no expiry and the route records no context', async () => {
    const h = harness();
    h.routes.set(ROUTE, routeFacts('validates'));
    await h.continuity.beforeLegacy(request({ params: { csrf_token: TOKEN } }), ROUTE, 'target-primary');

    expect(onlyCall(h, 'identity.claim')).toStrictEqual([{ sessionId: SESSION_ID, token: TOKEN, expires: '', context: '' }]);
  });

  it('treats a route the inventory does not list as validating, adopting and claiming', async () => {
    const h = harness();
    h.routes.clear();
    const handle = await h.continuity.beforeLegacy(request(), ROUTE, 'legacy-primary');

    expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toStrictEqual({
      mode: 'legacy-primary',
      adopt: true,
      siteId: undefined,
    });
    expect(onlyCall(h, 'identity.claim')).toStrictEqual([
      { sessionId: SESSION_ID, token: TOKEN, expires: EXPIRES, context: '' },
    ]);
    expect(handle?.claimedTokens).toEqual([TOKEN]);
  });

  it.each<CsrfValidation>(['bypassed', 'none'])(
    'takes no claim and adopts nothing on a %s branch, still handing back the session',
    async (validation) => {
      const h = harness();
      h.routes.set(ROUTE, routeFacts(validation, CONTEXT));
      const handle = await h.continuity.beforeLegacy(request(), ROUTE, 'legacy-primary');

      expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get']);
      expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toStrictEqual({
        mode: 'legacy-primary',
        adopt: false,
        siteId: undefined,
      });
      expect(handle).toStrictEqual(handleOf({ setCookies: SET_COOKIES }));
    },
  );

  it('resolves a target-primary request without a token without adopting or claiming', async () => {
    const h = harness();
    const handle = await h.continuity.beforeLegacy(request({ params: {} }), ROUTE, 'target-primary');

    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get']);
    expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toStrictEqual({
      mode: 'target-primary',
      adopt: false,
      siteId: undefined,
    });
    expect(handle).toStrictEqual(handleOf({ setCookies: SET_COOKIES }));
  });

  it.each<[string, Record<string, unknown>]>([
    ['no token', {}],
    ['an empty token', { csrf_token: '' }],
  ])('returns no handle in legacy-primary mode for a request carrying %s, calling nothing', async (_name, params) => {
    const h = harness();

    await expect(h.continuity.beforeLegacy(request({ params }), ROUTE, 'legacy-primary')).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it.each<[string, string | RouteKeyResult]>([
    ['a rest route key', 'Rest:/_api/rest/v1/default/content'],
    ['a computed rest key', computedKey('rest:/_api/rest/v1/default/content', 'rest', { siteId: 'default' })],
    [
      'a reload key whose served route is rest',
      computedKey('reload:application', 'reload', { afterReload: computedKey('rest:/_api/rest/v1/default/content', 'rest') }),
    ],
  ])('returns no handle for %s without resolving or claiming', async (_name, route) => {
    const h = harness();

    await expect(h.continuity.beforeLegacy(request(), route, 'target-primary')).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it.each<SessionResolution>([
    { kind: 'none', setCookies: [] },
    { kind: 'response', status: 401, headers: { 'content-type': 'application/json' }, body: '{}' },
  ])('returns no handle and claims nothing when resolution yields $kind', async (resolution) => {
    const h = harness();
    h.resolution = resolution;

    await expect(h.continuity.beforeLegacy(request(), ROUTE, 'target-primary')).resolves.toBeUndefined();
    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound']);
  });

  it.each<[string, JarRow | undefined]>([
    ['the session has no jar', undefined],
    ['the jar names no legacy session id', jarRow({ legacySessionId: null })],
    [
      'every jar cookie is deleted or expired at the clock time',
      jarRow({ cookies: { JSESSIONID: liveCookie('JSESSIONID', ''), CFID: expiringCookie('CFID', '1001', -HOUR_MS) } }),
    ],
  ])('returns no handle and claims nothing when %s', async (_name, row) => {
    const h = harness();
    h.rows = new Map(row === undefined ? [] : [[SESSION_ID, row]]);

    await expect(h.continuity.beforeLegacy(request(), ROUTE, 'target-primary')).resolves.toBeUndefined();
    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get']);
  });

  it('puts a token identity already holds as used into the live legacy ledger instead of claiming it', async () => {
    const h = harness();
    const liveToken = expiringCookie('CFTOKEN', '12345678', HOUR_MS);
    h.rows.set(
      SESSION_ID,
      jarRow({
        cookies: {
          CFID: expiringCookie('CFID', '1001', -HOUR_MS),
          CFTOKEN: liveToken,
          JSESSIONID: liveCookie('JSESSIONID', ''),
        },
      }),
    );
    h.claimState = 'used';
    const handle = await h.continuity.beforeLegacy(request(), ROUTE, 'target-primary');

    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get', 'identity.claim', 'bridge.markUsed']);
    expect(onlyCall(h, 'bridge.markUsed')).toStrictEqual([
      { CFTOKEN: liveToken },
      [{ token: TOKEN, usedAt: WIRE_NOW }],
      { legacySessionId: LEGACY_SESSION_ID, userAgent: USER_AGENT },
    ]);
    expect(handle).toStrictEqual(handleOf({ legacyCookies: { CFTOKEN: liveToken }, setCookies: SET_COOKIES }));
  });

  it('forwards an absent User-Agent as undefined to the bridge and the handle', async () => {
    const h = harness();
    h.claimState = 'used';
    const handle = await h.continuity.beforeLegacy(request({ headers: {} }), ROUTE, 'target-primary');

    expect(onlyCall(h, 'bridge.markUsed')[2]).toStrictEqual({ legacySessionId: LEGACY_SESSION_ID, userAgent: undefined });
    expect(handle?.userAgent).toBeUndefined();
  });

  it('judges a computed key by its normalised key, family and site', async () => {
    const h = harness();
    const handle = await h.continuity.beforeLegacy(
      request(),
      computedKey('Admin:cArch.Update', 'admin', { siteId: 'tenant-a' }),
      'target-primary',
    );

    expect(onlyCall(h, 'facts.get')).toEqual([ROUTE]);
    expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toStrictEqual({
      mode: 'target-primary',
      adopt: true,
      siteId: 'tenant-a',
    });
    expect(handle?.claimedTokens).toEqual([TOKEN]);
  });

  it.each<[string, string | undefined, string]>([
    ['inherits the reload site when the served route names none', undefined, 'tenant-a'],
    ['keeps the served route site over the reload site', 'tenant-b', 'tenant-b'],
  ])('judges a reload key by its afterReload route and %s', async (_name, servedSite, expectedSite) => {
    const h = harness();
    h.routes.set('api:content.save', routeFacts('validates', CONTEXT));
    const served = computedKey('API:content.save', 'api', servedSite === undefined ? {} : { siteId: servedSite });
    const route = computedKey('reload:application', 'reload', { siteId: 'tenant-a', afterReload: served });
    const req = request({ headers: { 'x-csrf_token': HEADER_VALUE }, params: { csrf_token: TOKEN } });
    const handle = await h.continuity.beforeLegacy(req, route, 'target-primary');

    expect(onlyCall(h, 'facts.get')).toEqual(['api:content.save']);
    expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toStrictEqual({
      mode: 'target-primary',
      adopt: true,
      siteId: expectedSite,
    });
    expect(onlyCall(h, 'identity.claim')).toStrictEqual([
      { sessionId: SESSION_ID, token: HEADER_VALUE, expires: '', context: CONTEXT },
    ]);
    expect(handle?.claimedTokens).toEqual([HEADER_VALUE]);
  });

  it('claims in the session a switch back restored when the dispatcher already resolved the same request', async () => {
    const rows = new Map<string, JarRow>([['T1', jarRow({ sessionId: 'T1', legacySessionId: LEGACY_SESSION_ID })]]);
    const restoredOps: string[] = [];
    const statements = {
      get: (sessionId: string) => Promise.resolve(rows.get(sessionId)),
      findByLegacySessionId: (id: string) => Promise.resolve([...rows.values()].find((r) => r.legacySessionId === id)),
      lockNative(legacySessionId: string) {
        restoredOps.push(`jar.lockNative:${legacySessionId}`);
        return Promise.resolve();
      },
      rebind(input: JarUpsert, previousSessionId?: string) {
        restoredOps.push('jar.rebind');
        if (previousSessionId !== undefined && previousSessionId !== input.sessionId) rows.delete(previousSessionId);
        const row: JarRow = { ...input, updatedAt: NOW };
        rows.set(input.sessionId, row);
        return Promise.resolve(row);
      },
    };
    const jar = {
      ...statements,
      withSessionLock<T>(sessionId: string, fn: (locked: typeof statements) => Promise<T>): Promise<T> {
        restoredOps.push(`jar.withSessionLock:${sessionId}`);
        return fn(statements);
      },
    } as unknown as LegacyJar;
    const sessions = createSessionResolver({
      identity: {
        adopt() {
          restoredOps.push('identity.adopt');
          return Promise.resolve({ sessionId: SESSION_ID, epoch: 4, setCookie: [] });
        },
      } as unknown as IdentityClient,
      bridge: {
        describe(cookies: LegacyCookies) {
          restoredOps.push(`bridge.describe:${Object.values(cookies).map((c) => (c as JarCookie).value).join(',')}`);
          const body: LegacyDescribe = {
            sessionId: LEGACY_SESSION_ID,
            isLoggedIn: true,
            user: {
              userID: 'USER-0001',
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
            memberships: '',
            membershipIds: '',
            csrfSecretKey: 'SECRET',
            usedTokens: [],
            siteId: 'default',
            serverTime: WIRE_NOW,
          };
          return Promise.resolve({ body, setCookies: [] });
        },
      } as unknown as BridgeClient,
      jar,
      state: {
        check: () => Promise.resolve({ state: 'ended', epoch: 0, userId: '', siteId: '', epochChanged: false }),
        forget() {},
      },
    });
    const h = harness(true, { sessions, jar });
    const cookie = 'JSESSIONID=T1; CFID=T-CFID; CFTOKEN=T-CFTOKEN';
    const req = request({ headers: { 'user-agent': USER_AGENT, cookie } });

    const dispatched = await sessions.resolveLegacyBound(req, { mode: 'legacy-primary', adopt: false });
    const handle = await h.continuity.beforeLegacy(req, ROUTE, 'legacy-primary');

    expect(dispatched).toMatchObject({ kind: 'session', sessionId: SESSION_ID, legacyCookies: LIVE });
    expect(restoredOps).toEqual([
      'jar.withSessionLock:T1',
      'bridge.describe:1001,12345678',
      `jar.lockNative:${LEGACY_SESSION_ID}`,
      'identity.adopt',
      'jar.rebind',
    ]);
    expect(onlyCall(h, 'identity.claim')).toStrictEqual([
      { sessionId: SESSION_ID, token: TOKEN, expires: EXPIRES, context: CONTEXT },
    ]);
    expect(handle).toMatchObject({ sessionId: SESSION_ID, legacySessionId: LEGACY_SESSION_ID, legacyCookies: LIVE });
    expect(rows.has('T1')).toBe(false);
  });

  it('stamps since with the system clock when no clock is given', async () => {
    const h = harness(false);
    const before = cfDateTimeFormat(new Date(), WIRE_MASK);
    const handle = await h.continuity.beforeLegacy(request(), ROUTE, 'target-primary');
    const after = cfDateTimeFormat(new Date(), WIRE_MASK);
    const since = handle?.since ?? '';

    expect(since).toMatch(WIRE_TIME);
    expect(since >= before && since <= after).toBe(true);
  });
});

describe('createCsrfContinuity afterLegacy', () => {
  interface SettleCase {
    name: string;
    claimed: string[];
    ledger: string[];
    consumed: string[];
    released: string[];
  }

  it.each<SettleCase>([
    {
      name: 'marks consumed tokens used and releases claims legacy left, matching ledger keys case-insensitively',
      claimed: [TOKEN, SECOND],
      ledger: [TOKEN.toLowerCase(), THIRD],
      consumed: [TOKEN.toLowerCase(), THIRD],
      released: [SECOND],
    },
    {
      name: 'releases every claim when legacy consumed none',
      claimed: [TOKEN],
      ledger: [],
      consumed: [],
      released: [TOKEN],
    },
    {
      name: 'marks consumed tokens used when nothing was claimed',
      claimed: [],
      ledger: [TOKEN],
      consumed: [TOKEN],
      released: [],
    },
  ])('$name', async ({ claimed, ledger, consumed, released }) => {
    const h = harness();
    h.ledger = ledger.map((token) => ({ token, usedAt: WIRE_NOW }));
    await h.continuity.afterLegacy(handleOf({ claimedTokens: claimed }));

    expect(h.ops()).toEqual(['bridge.usedSince', 'identity.settle']);
    expect(onlyCall(h, 'bridge.usedSince')).toStrictEqual([LIVE, WIRE_NOW, CALL]);
    expect(onlyCall(h, 'identity.settle')).toStrictEqual([{ sessionId: SESSION_ID, consumed, released }]);
  });

  it('reads the ledger from startedAt when it is given', async () => {
    const h = harness();
    h.ledger = [{ token: TOKEN, usedAt: WIRE_NOW }];
    await h.continuity.afterLegacy(handleOf({ claimedTokens: [TOKEN] }), STARTED);

    expect(onlyCall(h, 'bridge.usedSince')).toStrictEqual([LIVE, WIRE_STARTED, CALL]);
    expect(onlyCall(h, 'identity.settle')).toStrictEqual([{ sessionId: SESSION_ID, consumed: [TOKEN], released: [] }]);
  });

  it('skips identity when legacy consumed nothing and nothing was claimed', async () => {
    const h = harness();
    await h.continuity.afterLegacy(handleOf());

    expect(h.ops()).toEqual(['bridge.usedSince']);
  });

  it('does nothing without a handle', async () => {
    const h = harness();

    await expect(h.continuity.afterLegacy(undefined)).resolves.toBeUndefined();
    await expect(h.continuity.afterLegacy(undefined, STARTED)).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('settles the claim beforeLegacy took once legacy consumes its token', async () => {
    const h = harness();
    const handle = await h.continuity.beforeLegacy(request(), ROUTE, 'target-primary');
    h.ledger = [{ token: TOKEN.toLowerCase(), usedAt: WIRE_NOW }];
    await h.continuity.afterLegacy(handle);

    expect(h.ops()).toEqual([
      'facts.get',
      'sessions.resolveLegacyBound',
      'jar.get',
      'identity.claim',
      'bridge.usedSince',
      'identity.settle',
    ]);
    expect(onlyCall(h, 'identity.settle')).toStrictEqual([
      { sessionId: SESSION_ID, consumed: [TOKEN.toLowerCase()], released: [] },
    ]);
  });
});

describe('createCsrfContinuity on the committed inventory facts', () => {
  const committed = resolveGatewayPaths({});
  let committedRoutes: Map<string, RouteFacts>;
  let variants: readonly VariantDeclaration[];

  beforeAll(async () => {
    const [facts, variantsFile] = await Promise.all([loadInventoryFacts(committed), loadVariants(committed)]);
    committedRoutes = new Map(facts.routes().map((route) => [route, facts.get(route) as RouteFacts]));
    variants = variantsFile.variants;
  });

  interface LegacyCall {
    method: string;
    path: string;
    query: Record<string, string>;
    form: Record<string, string>;
    headers: Record<string, string>;
  }

  /** A harness over the committed facts, and the request with the route key the gateway computes for it. */
  function committedCall(call: LegacyCall): { h: Harness; req: SessionRequestInput; route: RouteKeyResult } {
    const h = harness();
    h.routes = committedRoutes;
    const headers = { 'user-agent': USER_AGENT, ...call.headers };
    const route = routeKeyForRequest({ method: call.method, path: call.path, query: call.query, form: call.form, headers }, { variants });
    const req = request({ path: call.path, httpMethod: call.method, headers, query: call.query, params: { ...call.query, ...call.form } });
    return { h, req, route };
  }

  const JSON_SAVE: LegacyCall = {
    method: 'POST',
    path: '/_api/json/v1/default/content/',
    query: {},
    form: { title: 'Home' },
    headers: { 'x-csrf_token': HEADER_VALUE, 'x-csrf_token_expires': HEADER_EXPIRES },
  };
  const PUBLIC_LOGIN: LegacyCall = {
    method: 'POST',
    path: '/',
    query: {},
    form: { doaction: 'login', username: 'qa_editor', csrf_token: TOKEN, csrf_token_expires: EXPIRES },
    headers: {},
  };

  interface ValidatingCase {
    name: string;
    call: LegacyCall;
    key: string;
    token: string;
    expires: string;
    context: string;
  }

  const VALIDATING: ValidatingCase[] = [
    { name: 'a JSON API save', call: JSON_SAVE, key: 'api:content.save', token: HEADER_VALUE, expires: HEADER_EXPIRES, context: 'arguments.id' },
    { name: 'a public login form post', call: PUBLIC_LOGIN, key: 'page:login', token: TOKEN, expires: EXPIRES, context: 'login' },
  ];

  it.each(VALIDATING.flatMap((c) => [true, false].map((consumed) => ({ ...c, consumed }))))(
    'claims the token of $name pending-legacy and settles it (consumed by legacy: $consumed)',
    async ({ call, key, token, expires, context, consumed }) => {
      const { h, req, route } = committedCall(call);
      expect(route.key).toBe(key);
      const handle = await h.continuity.beforeLegacy(req, route, 'target-primary');

      expect(onlyCall(h, 'identity.claim')).toStrictEqual([{ sessionId: SESSION_ID, token, expires, context }]);
      expect(handle?.claimedTokens).toEqual([token]);

      h.ledger = consumed ? [{ token, usedAt: WIRE_NOW }] : [];
      await h.continuity.afterLegacy(handle);
      expect(onlyCall(h, 'identity.settle')).toStrictEqual([
        { sessionId: SESSION_ID, consumed: consumed ? [token] : [], released: consumed ? [] : [token] },
      ]);
    },
  );

  it.each(VALIDATING)('puts the token of $name that identity already holds as used into the legacy ledger before forwarding', async ({ call, token }) => {
    const { h, req, route } = committedCall(call);
    h.claimState = 'used';
    const handle = await h.continuity.beforeLegacy(req, route, 'target-primary');

    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get', 'identity.claim', 'bridge.markUsed']);
    expect(onlyCall(h, 'bridge.markUsed')).toStrictEqual([LIVE, [{ token, usedAt: WIRE_NOW }], CALL]);
    expect(handle?.claimedTokens).toEqual([]);

    await h.continuity.afterLegacy(handle);
    expect(h.ops().slice(-1)).toEqual(['bridge.usedSince']);
  });

  it.each<{ name: string; call: LegacyCall; key: string }>([
    {
      name: 'a JSON API read carrying X-csrf_token',
      call: {
        method: 'GET',
        path: '/_api/json/v1/default/content/00000000000000000000000000000000001',
        query: {},
        form: {},
        headers: { 'x-csrf_token': HEADER_VALUE, 'x-csrf_token_expires': HEADER_EXPIRES },
      },
      key: 'api:content.findone',
    },
    {
      name: 'the approvalaction bypass',
      call: {
        method: 'POST',
        path: '/admin/',
        query: { muraAction: 'cArch.approvalaction' },
        form: { csrf_token: TOKEN, csrf_token_expires: EXPIRES },
        headers: {},
      },
      key: 'admin:carch.approvalaction',
    },
  ])('takes no claim for $name, leaving the token usable', async ({ call, key }) => {
    const { h, req, route } = committedCall(call);
    expect(route.key).toBe(key);
    const handle = await h.continuity.beforeLegacy(req, route, 'target-primary');

    expect(h.ops()).toEqual(['facts.get', 'sessions.resolveLegacyBound', 'jar.get']);
    expect(onlyCall(h, 'sessions.resolveLegacyBound')[1]).toMatchObject({ adopt: false });
    expect(handle?.claimedTokens).toEqual([]);
  });
});
