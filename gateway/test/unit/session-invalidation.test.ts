// Logout and legacy-login session effects across the seam, and the route-key predicates that select them.
import { normaliseRouteKey, routeKeyForRequest, type RouteKeyRequest } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import type { InventoryFacts, RouteFacts, SessionEffect } from '../../src/cutover/types.js';
import type { LegacyDescribe } from '../../src/session/bridge-client.js';
import type { AdoptedSession } from '../../src/session/identity-client.js';
import {
  IDENTITY_LOGOUT_ROUTE_KEYS,
  createInvalidation,
  isLegacyLogout,
  isLogoutRouteKey,
  isTargetLogout,
  legacySessionEffect,
  type InvalidationOptions,
  type LegacyLoginFacts,
} from '../../src/session/invalidation.js';
import type { JarCookie, JarCookies, JarRow, JarUpsert, LockedJar } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';

const NOW = new Date(Date.UTC(2026, 5, 30, 12));
const SESSION_ID = 'identity-session-0001';
const NEW_SESSION_ID = 'identity-session-0002';
const LEGACY_SESSION_ID = 'OPT2TEST_1001_12345678';
const NEW_LEGACY_SESSION_ID = 'OPT2TEST_2002_87654321';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';

const cookie = (name: string, value: string): JarCookie => ({ name, value, attributes: 'path=/;HttpOnly' });
const JAR_LIVE: JarCookies = { CFID: cookie('CFID', '1001'), CFTOKEN: cookie('CFTOKEN', '12345678') };
const BROWSER_LIVE: JarCookies = { CFID: cookie('CFID', '3003'), CFTOKEN: cookie('CFTOKEN', '33333333') };
const EXPIRED: JarCookies = {
  JSESSIONID: { name: 'JSESSIONID', value: 'node01old', attributes: 'path=/;expires=Thu, 01-Jan-1970 00:00:00 GMT' },
};
const DELETED: JarCookies = { ...EXPIRED, CFID: cookie('CFID', ''), CFTOKEN: cookie('CFTOKEN', '') };

function jarRow(overrides: Partial<JarRow> = {}): JarRow {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: { ...JAR_LIVE, ...EXPIRED },
    mode: 'target-primary',
    hydratedEpoch: 4,
    updatedAt: NOW,
    ...overrides,
  };
}

function described(overrides: Partial<LegacyDescribe> = {}): LegacyDescribe {
  return {
    sessionId: LEGACY_SESSION_ID,
    isLoggedIn: true,
    user: {
      userID: 'USER-0001',
      username: 'admin',
      siteID: 'default',
      subtype: 'Default',
      password: 'stored-hash',
      fname: 'Admin',
      lname: 'User',
      email: 'admin@example.com',
      remoteID: '',
      company: 'Masa',
      lastlogin: '2026-06-30 11:00:00',
      passwordCreated: '2026-01-01 00:00:00',
    },
    memberships: 'S2IsPrivate;default,S2',
    membershipIds: 'GROUP-1,USER-0001',
    csrfSecretKey: 'CSRF-SECRET-0001',
    usedTokens: [],
    siteId: 'tenant-a',
    serverTime: '2026-06-30 12:00:00.000',
    ...overrides,
  };
}

type Call = [op: string, ...args: unknown[]];

/** Stub identity, bridge, jar, token cache and state checker sharing one ordered call log. */
interface Harness {
  calls: Call[];
  rows: Map<string, JarRow>;
  /** Answer of every `op=describe` once `describes` is empty. */
  describe: LegacyDescribe;
  /** Answers of the next `op=describe` calls, in order. */
  describes: LegacyDescribe[];
  adopted: AdoptedSession;
  /** Runs when a locked section has taken a legacy session's lock. */
  onNative?: () => void;
  options: InvalidationOptions;
}

function harness(row?: JarRow): Harness {
  const h: Harness = {
    calls: [],
    rows: new Map(row === undefined ? [] : [[row.sessionId, row]]),
    describe: described(),
    describes: [],
    adopted: { sessionId: SESSION_ID, epoch: 6, setCookie: [] },
    options: undefined as unknown as InvalidationOptions,
  };
  const record = (op: string, ...args: unknown[]): void => {
    h.calls.push([op, ...args]);
  };
  const store = (input: JarUpsert): JarRow => {
    const next: JarRow = { ...input, updatedAt: NOW };
    h.rows.set(input.sessionId, next);
    return next;
  };
  /** The jar statements a locked section runs, logged as `locked.*`. */
  const locked: LockedJar = {
    lockNative(legacySessionId) {
      record('locked.lockNative', legacySessionId);
      h.onNative?.();
      return Promise.resolve();
    },
    get(sessionId) {
      record('locked.get', sessionId);
      return Promise.resolve(h.rows.get(sessionId));
    },
    findByLegacySessionId(legacySessionId) {
      record('locked.findByLegacySessionId', legacySessionId);
      return Promise.resolve([...h.rows.values()].find((row) => row.legacySessionId === legacySessionId));
    },
    upsert(input) {
      record('locked.upsert', input);
      return Promise.resolve(store(input));
    },
    setHydratedEpoch(sessionId, epoch) {
      record('locked.setHydratedEpoch', sessionId, epoch);
      return Promise.resolve(h.rows.has(sessionId));
    },
    drop(sessionId) {
      record('locked.drop', sessionId);
      return Promise.resolve(h.rows.delete(sessionId));
    },
    rebind(input, previousSessionId) {
      record('locked.rebind', input, previousSessionId);
      for (const row of [...h.rows.values()]) {
        const replaced =
          row.sessionId === previousSessionId ||
          (input.legacySessionId !== null && row.legacySessionId === input.legacySessionId);
        if (row.sessionId !== input.sessionId && replaced) h.rows.delete(row.sessionId);
      }
      return Promise.resolve(store(input));
    },
  };
  h.options = {
    identity: {
      adopt(input) {
        record('identity.adopt', input);
        return Promise.resolve(h.adopted);
      },
      end(sessionId, reason) {
        record('identity.end', sessionId, reason);
        return Promise.resolve({ ended: true, epoch: 9 });
      },
    },
    bridge: {
      describe(cookies, call) {
        record('bridge.describe', cookies, call);
        return Promise.resolve({ body: h.describes.shift() ?? h.describe, setCookies: [] });
      },
      end(cookies, call) {
        record('bridge.end', cookies, call);
        return Promise.resolve({ body: { ended: true, serverTime: '2026-06-30 12:00:00.000' }, setCookies: [] });
      },
    },
    jar: {
      async withSessionLock<T>(sessionId: string, fn: (locked: LockedJar) => Promise<T>): Promise<T> {
        record('jar.lock', sessionId);
        try {
          const result = await fn(locked);
          record('jar.commit', sessionId);
          return result;
        } catch (err) {
          record('jar.rollback', sessionId);
          throw err;
        }
      },
      drop(sessionId) {
        record('jar.drop', sessionId);
        return Promise.resolve(h.rows.delete(sessionId));
      },
    },
    tokenCache: {
      drop(sessionId) {
        record('tokenCache.drop', sessionId);
      },
    },
    state: {
      forget(sessionId) {
        record('state.forget', sessionId);
      },
    },
  };
  return h;
}

function factsOf(entries: Record<string, SessionEffect[]>): InventoryFacts {
  const byRoute = new Map<string, RouteFacts>(
    Object.entries(entries).map(([route, sessionEffects]) => [
      normaliseRouteKey(route),
      { route, csrfValidation: 'none', writeSet: [], keyScope: [], sessionEffects },
    ]),
  );
  return { get: (key) => byRoute.get(normaliseRouteKey(key)), routes: () => [...byRoute.keys()] };
}

const FACTS = factsOf({
  'admin:clogin.login': ['login'],
  'admin:clogin.logout': ['logout'],
  'api:save': ['relogin'],
  'admin:cusers.update': ['none'],
  'page:login': ['login'],
  'page:saverate': ['none'],
  'rest:login': ['login'],
});

const FORGET_SESSION: Call[] = [
  ['tokenCache.drop', SESSION_ID],
  ['state.forget', SESSION_ID],
];

describe('logout route-key predicates', () => {
  it('names the admin logout action and the JSON API logout method as identity logouts', () => {
    expect(IDENTITY_LOGOUT_ROUTE_KEYS).toEqual(['admin:clogin.logout', 'api:logout']);
    expect(Object.isFrozen(IDENTITY_LOGOUT_ROUTE_KEYS)).toBe(true);
  });

  it.each<[string, boolean, boolean, boolean, boolean]>([
    ['admin:clogin.logout', true, true, false, true],
    [' ADMIN:cLogin.Logout ', true, true, false, true],
    ['admin:clogin.logout{compact}', true, true, false, true],
    ['api:logout', true, true, false, true],
    ['page:logout', true, true, true, false],
    ['page:login,logout', true, true, true, false],
    ['page:logout+saveform', true, true, true, false],
    ['page:saverate', false, false, false, false],
    ['page:render', false, false, false, false],
    ['page:saveform', false, false, false, false],
    ['admin:clogin.login', false, false, false, false],
    ['rest:logout', false, false, false, false],
  ])('%s: logout %s, legacy logout %s legacy-primary and %s target-primary, target logout %s', (key, logout, legacyPrimary, targetPrimary, target) => {
    expect(isLogoutRouteKey(key)).toBe(logout);
    expect(isLegacyLogout(key, 'legacy-primary')).toBe(legacyPrimary);
    expect(isLegacyLogout(key, 'target-primary')).toBe(targetPrimary);
    expect(isTargetLogout(key)).toBe(target);
  });
});

describe('legacySessionEffect', () => {
  it.each<[string, string, SessionMode, 'login' | 'logout' | undefined]>([
    ['the admin logout in legacy-primary mode', 'admin:clogin.logout', 'legacy-primary', 'logout'],
    ['the admin logout in target-primary mode', 'admin:clogin.logout', 'target-primary', undefined],
    ['the JSON API logout in legacy-primary mode', 'api:logout', 'legacy-primary', 'logout'],
    ['a page logout in target-primary mode', 'page:logout', 'target-primary', 'logout'],
    ['a page logout listed after a login doaction', 'page:login,logout', 'legacy-primary', 'logout'],
    ['a recorded login', 'admin:clogin.login', 'legacy-primary', 'login'],
    ['a recorded re-login', 'API:save', 'target-primary', 'login'],
    ['an unlisted page key with a login doaction', 'page:saverate,login', 'target-primary', 'login'],
    ['an unlisted page key without one', 'page:saverate,comment+saveform', 'legacy-primary', undefined],
    ['a plain page render', 'page:render', 'legacy-primary', undefined],
    ['a sessionless REST login', 'rest:login', 'legacy-primary', undefined],
    ['a write recording no session effect', 'admin:cusers.update', 'legacy-primary', undefined],
    ['a route without facts', 'admin:carch.update', 'target-primary', undefined],
  ])('is %s for %s', (_label, key, mode, expected) => {
    expect(legacySessionEffect(key, mode, FACTS)).toBe(expected);
  });

  it.each<[string, RouteKeyRequest, 'login' | 'logout']>([
    [
      'a reload of the admin login takes the login',
      { method: 'POST', path: '/admin/', query: { muraAction: 'cLogin.login', appreload: '' }, headers: {} },
      'login',
    ],
    [
      'a reload of a page logout takes the logout',
      { method: 'GET', path: '/', query: { doaction: 'logout', appreload: '' }, headers: {} },
      'logout',
    ],
    [
      'a routed page logout takes its own key',
      { method: 'GET', path: '/', query: { doaction: 'logout' }, headers: {} },
      'logout',
    ],
  ])('reads a route-key result: %s', (_label, request, expected) => {
    expect(legacySessionEffect(routeKeyForRequest(request), 'legacy-primary', FACTS)).toBe(expected);
  });
});

describe('afterTargetLogout', () => {
  const LOCK: Call = ['jar.lock', SESSION_ID];
  const COMMIT: Call = ['jar.commit', SESSION_ID];
  /** The jar read, its recorded legacy session's lock, and the jar read again under both locks. */
  const LOCKED_READ: Call[] = [
    ['locked.get', SESSION_ID],
    ['locked.lockNative', LEGACY_SESSION_ID],
    ['locked.get', SESSION_ID],
  ];

  it('drops tokens and state, then ends the attached legacy session and drops the jar under its lock', async () => {
    const h = harness(jarRow());
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID, { userAgent: USER_AGENT });
    expect(h.calls).toEqual([
      ...FORGET_SESSION,
      LOCK,
      ...LOCKED_READ,
      ['locked.lockNative', LEGACY_SESSION_ID],
      ['bridge.end', JAR_LIVE, { userAgent: USER_AGENT, legacySessionId: LEGACY_SESSION_ID }],
      ['locked.drop', SESSION_ID],
      COMMIT,
    ]);
    expect(h.rows.size).toBe(0);
  });

  it('learns the legacy session id from describe when the jar never recorded it', async () => {
    const h = harness(jarRow({ legacySessionId: null }));
    h.describe = described({ sessionId: NEW_LEGACY_SESSION_ID });
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([
      ...FORGET_SESSION,
      LOCK,
      ['locked.get', SESSION_ID],
      ['bridge.describe', JAR_LIVE, { userAgent: undefined }],
      ['locked.lockNative', NEW_LEGACY_SESSION_ID],
      ['bridge.end', JAR_LIVE, { userAgent: undefined, legacySessionId: NEW_LEGACY_SESSION_ID }],
      ['locked.drop', SESSION_ID],
      COMMIT,
    ]);
  });

  it('drops a jar holding only deleted cookies without calling the bridge', async () => {
    const h = harness(jarRow({ cookies: DELETED }));
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([...FORGET_SESSION, LOCK, ...LOCKED_READ, ['locked.drop', SESSION_ID], COMMIT]);
  });

  it('leaves the legacy session to the jar a rebind moved it to while the logout waited for its lock', async () => {
    const h = harness(jarRow());
    const moved = jarRow({ sessionId: NEW_SESSION_ID, mode: 'legacy-primary' });
    h.onNative = () => {
      h.rows.delete(SESSION_ID);
      h.rows.set(NEW_SESSION_ID, moved);
    };
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([...FORGET_SESSION, LOCK, ...LOCKED_READ, COMMIT]);
    expect([...h.rows.values()]).toEqual([moved]);
  });

  it('only forgets tokens and state when the session has no jar', async () => {
    const h = harness();
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([...FORGET_SESSION, LOCK, ['locked.get', SESSION_ID], COMMIT]);
  });

  it('propagates a failed legacy end out of the locked section without dropping the jar', async () => {
    const h = harness(jarRow());
    const refusal = new Error('legacy-bridge unavailable');
    h.options.bridge.end = () => Promise.reject(refusal);
    await expect(createInvalidation(h.options).afterTargetLogout(SESSION_ID)).rejects.toBe(refusal);
    expect(h.calls.slice(-1)).toEqual([['jar.rollback', SESSION_ID]]);
    expect(h.calls.map(([op]) => op)).not.toContain('locked.drop');
  });
});

describe('afterLegacyLogout', () => {
  it.each<SessionMode>(['legacy-primary', 'target-primary'])(
    'ends the identity session as a legacy logout and drops a %s jar',
    async (mode) => {
      const h = harness(jarRow({ mode }));
      await createInvalidation(h.options).afterLegacyLogout(SESSION_ID);
      expect(h.calls).toEqual([
        ...FORGET_SESSION,
        ['identity.end', SESSION_ID, 'legacy-logout'],
        ['jar.drop', SESSION_ID],
      ]);
      expect(h.rows.size).toBe(0);
    },
  );
});

describe('afterLegacyLogin', () => {
  it('adopts a legacy-primary login from the browser cookies and maps the new identity session', async () => {
    const h = harness();
    h.adopted = { sessionId: NEW_SESSION_ID, epoch: 1, setCookie: ['CFID=3003;path=/;HttpOnly'] };
    const legacy: LegacyLoginFacts = { cookies: { ...BROWSER_LIVE, ...EXPIRED }, siteId: 'tenant-b', userAgent: USER_AGENT };

    await expect(createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', legacy)).resolves.toBe(
      h.adopted,
    );
    expect(h.calls).toEqual([
      ['jar.lock', SESSION_ID],
      ['locked.get', SESSION_ID],
      ['bridge.describe', BROWSER_LIVE, { userAgent: USER_AGENT }],
      ['locked.lockNative', LEGACY_SESSION_ID],
      ['locked.findByLegacySessionId', LEGACY_SESSION_ID],
      ['identity.adopt', { describe: h.describe, siteId: 'tenant-b' }],
      [
        'locked.rebind',
        {
          sessionId: NEW_SESSION_ID,
          legacySessionId: LEGACY_SESSION_ID,
          cookies: BROWSER_LIVE,
          mode: 'legacy-primary',
          hydratedEpoch: null,
        },
        SESSION_ID,
      ],
      ['jar.commit', SESSION_ID],
      ...FORGET_SESSION,
      ['tokenCache.drop', NEW_SESSION_ID],
      ['state.forget', NEW_SESSION_ID],
    ]);
  });

  it('records a target-primary re-login that keeps both session ids as hydrated at the adopted epoch', async () => {
    const h = harness(jarRow());
    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'target-primary', { cookies: BROWSER_LIVE });
    expect(h.calls).toEqual([
      ['jar.lock', SESSION_ID],
      ['locked.get', SESSION_ID],
      ['bridge.describe', JAR_LIVE, { userAgent: undefined }],
      ['locked.lockNative', LEGACY_SESSION_ID],
      ['locked.findByLegacySessionId', LEGACY_SESSION_ID],
      ['identity.adopt', { describe: h.describe, siteId: 'tenant-a' }],
      ['locked.setHydratedEpoch', SESSION_ID, 6],
      ['jar.commit', SESSION_ID],
      ...FORGET_SESSION,
    ]);
  });

  it('writes no jar for a legacy-primary login that keeps both session ids', async () => {
    const h = harness(jarRow({ mode: 'legacy-primary', hydratedEpoch: null }));
    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', { cookies: JAR_LIVE });
    expect(h.calls.map(([op]) => op)).toEqual([
      'jar.lock',
      'locked.get',
      'bridge.describe',
      'locked.lockNative',
      'locked.findByLegacySessionId',
      'identity.adopt',
      'jar.commit',
      'tokenCache.drop',
      'state.forget',
    ]);
  });

  it.each<[string, SessionMode, string, string, number | null]>([
    ['a new legacy session id in target-primary mode', 'target-primary', SESSION_ID, NEW_LEGACY_SESSION_ID, 6],
    ['a new identity session in target-primary mode', 'target-primary', NEW_SESSION_ID, LEGACY_SESSION_ID, 6],
    ['a new legacy session id in legacy-primary mode', 'legacy-primary', SESSION_ID, NEW_LEGACY_SESSION_ID, null],
    ['a new identity session in legacy-primary mode', 'legacy-primary', NEW_SESSION_ID, LEGACY_SESSION_ID, null],
  ])('rebinds the jar in one locked write for %s', async (_label, mode, adoptedId, legacyId, hydratedEpoch) => {
    const h = harness(jarRow({ mode }));
    h.rows.set('stale-holder', jarRow({ sessionId: 'stale-holder', legacySessionId: legacyId }));
    h.adopted = { sessionId: adoptedId, epoch: 6, setCookie: [] };
    h.describe = described({ sessionId: legacyId });

    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, mode);
    const reads = ['locked.get', 'locked.findByLegacySessionId', 'locked.lockNative'];
    const writes = h.calls.filter(([op]) => op.startsWith('jar.') || (op.startsWith('locked.') && !reads.includes(op)));
    expect(writes).toEqual([
      ['jar.lock', SESSION_ID],
      [
        'locked.rebind',
        { sessionId: adoptedId, legacySessionId: legacyId, cookies: JAR_LIVE, mode, hydratedEpoch },
        SESSION_ID,
      ],
      ['jar.commit', SESSION_ID],
    ]);
    expect([...h.rows.keys()]).toEqual([adoptedId]);
    expect(h.rows.get(adoptedId)).toMatchObject({ legacySessionId: legacyId, mode });
  });

  it('describes again under the lock of a legacy session another target-primary jar holds', async () => {
    const h = harness();
    h.rows.set('holder', jarRow({ sessionId: 'holder' }));
    h.adopted = { sessionId: NEW_SESSION_ID, epoch: 1, setCookie: [] };
    const fresh = described({ memberships: 'Admin;default;0,S2' });
    h.describes = [described(), fresh];

    await expect(
      createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', { cookies: BROWSER_LIVE }),
    ).resolves.toBe(h.adopted);
    expect(h.calls.slice(0, 8)).toEqual([
      ['jar.lock', SESSION_ID],
      ['locked.get', SESSION_ID],
      ['bridge.describe', BROWSER_LIVE, { userAgent: undefined }],
      ['locked.lockNative', LEGACY_SESSION_ID],
      ['locked.findByLegacySessionId', LEGACY_SESSION_ID],
      ['bridge.describe', BROWSER_LIVE, { userAgent: undefined }],
      ['identity.adopt', { describe: fresh, siteId: 'tenant-a' }],
      [
        'locked.rebind',
        {
          sessionId: NEW_SESSION_ID,
          legacySessionId: LEGACY_SESSION_ID,
          cookies: BROWSER_LIVE,
          mode: 'legacy-primary',
          hydratedEpoch: null,
        },
        SESSION_ID,
      ],
    ]);
    expect([...h.rows.keys()]).toEqual([NEW_SESSION_ID]);
  });

  it('adopts nothing when that second describe names another legacy session', async () => {
    const h = harness();
    const holder = jarRow({ sessionId: 'holder' });
    h.rows.set('holder', holder);
    h.describes = [described(), described({ sessionId: NEW_LEGACY_SESSION_ID })];

    await expect(
      createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', { cookies: BROWSER_LIVE }),
    ).resolves.toBeUndefined();
    expect(h.calls.map(([op]) => op)).toEqual([
      'jar.lock',
      'locked.get',
      'bridge.describe',
      'locked.lockNative',
      'locked.findByLegacySessionId',
      'bridge.describe',
      'jar.commit',
    ]);
    expect([...h.rows.values()]).toEqual([holder]);
  });

  it('rebinds rather than records a re-login whose legacy session a rebind moved away while it waited', async () => {
    const h = harness(jarRow());
    h.onNative = () => {
      h.rows.delete(SESSION_ID);
      h.rows.set('moved', jarRow({ sessionId: 'moved', mode: 'legacy-primary' }));
    };
    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'target-primary');
    expect(h.calls.filter(([op]) => op === 'bridge.describe')).toHaveLength(1);
    expect(h.calls.find(([op]) => op === 'locked.rebind')).toEqual([
      'locked.rebind',
      {
        sessionId: SESSION_ID,
        legacySessionId: LEGACY_SESSION_ID,
        cookies: JAR_LIVE,
        mode: 'target-primary',
        hydratedEpoch: 6,
      },
      SESSION_ID,
    ]);
    expect(h.calls.map(([op]) => op)).not.toContain('locked.setHydratedEpoch');
    expect([...h.rows.keys()]).toEqual([SESSION_ID]);
  });

  it('describes the jar cookies in legacy-primary mode when the request carries none', async () => {
    const h = harness(jarRow({ mode: 'legacy-primary' }));
    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', { userAgent: USER_AGENT });
    expect(h.calls[2]).toEqual(['bridge.describe', JAR_LIVE, { userAgent: USER_AGENT }]);
  });

  it.each<[string, SessionMode, JarRow | undefined, LegacyLoginFacts | undefined]>([
    ['target-primary without a jar', 'target-primary', undefined, { cookies: BROWSER_LIVE }],
    ['target-primary with only deleted jar cookies', 'target-primary', jarRow({ cookies: DELETED }), { cookies: BROWSER_LIVE }],
    ['legacy-primary without cookies or a jar', 'legacy-primary', undefined, undefined],
    ['legacy-primary with only deleted cookies', 'legacy-primary', undefined, { cookies: DELETED }],
  ])('adopts nothing and answers undefined in %s', async (_label, mode, row, legacy) => {
    const h = harness(row);
    await expect(createInvalidation(h.options).afterLegacyLogin(SESSION_ID, mode, legacy)).resolves.toBeUndefined();
    expect(h.calls).toEqual([
      ['jar.lock', SESSION_ID],
      ['locked.get', SESSION_ID],
      ['jar.commit', SESSION_ID],
    ]);
  });

  it.each<[string, string | undefined, string, string]>([
    ['the requested site', 'tenant-b', 'tenant-a', 'tenant-b'],
    ["the legacy session's site when none is requested", '', 'tenant-a', 'tenant-a'],
    ['default when neither names one', undefined, '', 'default'],
  ])('adopts into %s', async (_label, requested, sessionSite, expected) => {
    const h = harness();
    h.describe = described({ siteId: sessionSite });
    await createInvalidation(h.options).afterLegacyLogin(SESSION_ID, 'legacy-primary', {
      cookies: BROWSER_LIVE,
      siteId: requested,
    });
    expect(h.calls.find(([op]) => op === 'identity.adopt')).toEqual(['identity.adopt', { describe: h.describe, siteId: expected }]);
  });
});
