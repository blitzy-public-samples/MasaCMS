// Logout and legacy-login session effects across the seam, and the route-key predicates that select them.
import { normaliseRouteKey, routeKeyForRequest, type RouteKeyRequest } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import type { InventoryFacts, RouteFacts, SessionEffect } from '../../src/cutover/types.js';
import type { LegacyDescribe } from '../../src/session/bridge-client.js';
import type { AdoptedSession, SessionSnapshot } from '../../src/session/identity-client.js';
import {
  IDENTITY_LOGOUT_ROUTE_KEYS,
  createInvalidation,
  isLogoutRouteKey,
  isTargetLogout,
  legacySessionEffect,
  type Invalidation,
  type InvalidationOptions,
  type LegacyHeldSession,
  type LegacyLoginFacts,
  type LegacyLogoutFacts,
  type LegacyLogoutOutcome,
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

/** Identity's snapshot of the session under CSRF secret `csrfSecretKey`. */
function snapshotOf(csrfSecretKey: string): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    epoch: 4,
    loginSnapshot: { user: { userID: 'USER-0001', username: 'admin' }, roles: ['S2IsPrivate;default', 'S2'] },
    csrfSecretKey,
    usedTokens: [],
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
  /** `Set-Cookie` values ColdFusion sends with every `op=describe`. */
  describeSetCookies: string[];
  /** Refuses every `op=describe` once set. */
  describeError?: Error;
  /** Identity's snapshot of the session; undefined reads as ended. */
  snapshot: SessionSnapshot | undefined;
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
    describeSetCookies: [],
    snapshot: snapshotOf(described().csrfSecretKey),
    adopted: { sessionId: SESSION_ID, epoch: 6, setCookie: [] },
    options: undefined as unknown as InvalidationOptions,
  };
  const record = (op: string, ...args: unknown[]): void => {
    h.calls.push([op, ...args]);
  };
  const store = (input: JarUpsert): JarRow => {
    // As the jar's upsert does, a stored row's pending-end mark stays.
    const pending = h.rows.get(input.sessionId)?.identityEndPendingAt;
    const next: JarRow = { ...input, updatedAt: NOW, ...(pending === undefined ? {} : { identityEndPendingAt: pending }) };
    h.rows.set(input.sessionId, next);
    return next;
  };
  const clearMark = (sessionId: string, updatedAt?: Date): Promise<void> => {
    const row = h.rows.get(sessionId);
    // As the jar does, a row changed since the version read keeps its mark.
    const current = updatedAt === undefined || row?.updatedAt.getTime() === updatedAt.getTime();
    if (row?.identityEndPendingAt !== undefined && current) {
      const { identityEndPendingAt: _cleared, ...kept } = row;
      const empty = kept.legacySessionId === null && Object.keys(kept.cookies).length === 0 && kept.hydratedEpoch === null;
      if (empty) h.rows.delete(sessionId);
      else h.rows.set(sessionId, kept);
    }
    return Promise.resolve();
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
    clearIdentityEndPending(sessionId, updatedAt) {
      record('locked.clearIdentityEndPending', sessionId, updatedAt);
      return clearMark(sessionId, updatedAt);
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
      snapshot(sessionId) {
        record('identity.snapshot', sessionId);
        return Promise.resolve(h.snapshot);
      },
    },
    bridge: {
      describe(cookies, call) {
        record('bridge.describe', cookies, call);
        if (h.describeError !== undefined) return Promise.reject(h.describeError);
        return Promise.resolve({ body: h.describes.shift() ?? h.describe, setCookies: h.describeSetCookies });
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
      get(sessionId) {
        record('jar.get', sessionId);
        return Promise.resolve(h.rows.get(sessionId));
      },
      drop(sessionId) {
        record('jar.drop', sessionId);
        return Promise.resolve(h.rows.delete(sessionId));
      },
      markIdentityEndPending(sessionId, mode) {
        record('jar.markIdentityEndPending', sessionId, mode);
        const row = h.rows.get(sessionId);
        const empty: JarRow = { sessionId, legacySessionId: null, cookies: {}, mode, hydratedEpoch: null, updatedAt: NOW };
        h.rows.set(sessionId, { identityEndPendingAt: NOW, ...(row ?? empty) });
        return Promise.resolve();
      },
      clearIdentityEndPending(sessionId, updatedAt) {
        record('jar.clearIdentityEndPending', sessionId, updatedAt);
        return clearMark(sessionId, updatedAt);
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

  it.each<[string, boolean, boolean]>([
    ['admin:clogin.logout', true, true],
    [' ADMIN:cLogin.Logout ', true, true],
    ['admin:clogin.logout{compact}', true, true],
    ['api:logout', true, true],
    ['page:logout', true, false],
    ['page:login,logout', true, false],
    ['page:logout+saveform', true, false],
    ['page:saverate', false, false],
    ['page:render', false, false],
    ['page:saveform', false, false],
    ['admin:clogin.login', false, false],
    ['rest:logout', false, false],
  ])('%s: logout %s, target logout %s', (key, logout, target) => {
    expect(isLogoutRouteKey(key)).toBe(logout);
    expect(isTargetLogout(key)).toBe(target);
  });
});

describe('legacySessionEffect', () => {
  it.each<[string, string, 'login' | 'logout' | undefined]>([
    ['the admin logout', 'admin:clogin.logout', 'logout'],
    ['the JSON API logout', 'api:logout', 'logout'],
    ['a page logout', 'page:logout', 'logout'],
    ['a page logout listed after a login doaction', 'page:login,logout', 'logout'],
    ['a recorded login', 'admin:clogin.login', 'login'],
    ['a recorded re-login', 'API:save', 'login'],
    ['an unlisted page key with a login doaction', 'page:saverate,login', 'login'],
    ['an unlisted page key without one', 'page:saverate,comment+saveform', undefined],
    ['a plain page render', 'page:render', undefined],
    ['a sessionless REST login', 'rest:login', undefined],
    ['a write recording no session effect', 'admin:cusers.update', undefined],
    ['a route without facts', 'admin:carch.update', undefined],
  ])('is %s for %s', (_label, key, expected) => {
    expect(legacySessionEffect(key, FACTS)).toBe(expected);
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
    expect(legacySessionEffect(routeKeyForRequest(request), FACTS)).toBe(expected);
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
  /** Identity's answer for the session the logout ended. */
  const ENDED_CHECK: Call = ['identity.snapshot', SESSION_ID];

  /** A harness whose identity session has ended, as every caller sees before a target logout's follow-up. */
  function ended(row?: JarRow): Harness {
    const h = harness(row);
    h.snapshot = undefined;
    return h;
  }

  it('drops tokens and state, then ends the attached legacy session and drops the jar under its lock', async () => {
    const h = ended(jarRow());
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID, { userAgent: USER_AGENT });
    expect(h.calls).toEqual([
      ...FORGET_SESSION,
      LOCK,
      ...LOCKED_READ,
      ENDED_CHECK,
      ['locked.lockNative', LEGACY_SESSION_ID],
      ['bridge.end', JAR_LIVE, { userAgent: USER_AGENT, legacySessionId: LEGACY_SESSION_ID }],
      ['locked.drop', SESSION_ID],
      COMMIT,
    ]);
    expect(h.rows.size).toBe(0);
  });

  it('learns the legacy session id from describe when the jar never recorded it', async () => {
    const h = ended(jarRow({ legacySessionId: null }));
    h.describe = described({ sessionId: NEW_LEGACY_SESSION_ID });
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([
      ...FORGET_SESSION,
      LOCK,
      ['locked.get', SESSION_ID],
      ENDED_CHECK,
      ['bridge.describe', JAR_LIVE, { userAgent: undefined }],
      ['locked.lockNative', NEW_LEGACY_SESSION_ID],
      ['bridge.end', JAR_LIVE, { userAgent: undefined, legacySessionId: NEW_LEGACY_SESSION_ID }],
      ['locked.drop', SESSION_ID],
      COMMIT,
    ]);
  });

  it('drops a jar holding only deleted cookies without calling the bridge', async () => {
    const h = ended(jarRow({ cookies: DELETED }));
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([...FORGET_SESSION, LOCK, ...LOCKED_READ, ENDED_CHECK, ['locked.drop', SESSION_ID], COMMIT]);
  });

  it.each<[string, SessionMode, Call[]]>([
    [
      'keeps the jar and its legacy session and forgets tokens and state again for a target-primary session a legacy logout re-adopted',
      'target-primary',
      [...FORGET_SESSION, LOCK, ...LOCKED_READ, ENDED_CHECK, COMMIT, ...FORGET_SESSION],
    ],
    [
      'ends the legacy session of a legacy-primary jar without asking identity',
      'legacy-primary',
      [
        ...FORGET_SESSION,
        LOCK,
        ...LOCKED_READ,
        ['locked.lockNative', LEGACY_SESSION_ID],
        ['bridge.end', JAR_LIVE, { userAgent: undefined, legacySessionId: LEGACY_SESSION_ID }],
        ['locked.drop', SESSION_ID],
        COMMIT,
      ],
    ],
  ])('while identity reports the session active again, %s', async (_label, mode, calls) => {
    const h = harness(jarRow({ mode }));
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual(calls);
    expect(h.rows.get(SESSION_ID)).toEqual(mode === 'target-primary' ? jarRow({ mode }) : undefined);
  });

  it('leaves the legacy session to the jar a rebind moved it to while the logout waited for its lock', async () => {
    const h = ended(jarRow());
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
    const h = ended();
    await createInvalidation(h.options).afterTargetLogout(SESSION_ID);
    expect(h.calls).toEqual([...FORGET_SESSION, LOCK, ['locked.get', SESSION_ID], COMMIT]);
  });

  it('propagates a failed legacy end out of the locked section without dropping the jar', async () => {
    const h = ended(jarRow());
    const refusal = new Error('legacy-bridge unavailable');
    h.options.bridge.end = () => Promise.reject(refusal);
    await expect(createInvalidation(h.options).afterTargetLogout(SESSION_ID)).rejects.toBe(refusal);
    expect(h.calls.slice(-1)).toEqual([['jar.rollback', SESSION_ID]]);
    expect(h.calls.map(([op]) => op)).not.toContain('locked.drop');
  });
});

describe('beforeLegacyLogout', () => {
  it.each<[string, JarRow | undefined, SessionMode, Partial<JarRow>]>([
    ['a target-primary jar', jarRow(), 'target-primary', { legacySessionId: LEGACY_SESSION_ID, cookies: jarRow().cookies }],
    ['an empty legacy-primary jar for a session without one', undefined, 'legacy-primary', { legacySessionId: null, cookies: {} }],
  ])('forgets tokens and state and marks the end pending in %s, asking identity nothing', async (_label, row, mode, kept) => {
    const h = harness(row);
    await createInvalidation(h.options).beforeLegacyLogout(SESSION_ID, mode);
    expect(h.calls).toEqual([...FORGET_SESSION, ['jar.markIdentityEndPending', SESSION_ID, mode]]);
    expect(h.rows.get(SESSION_ID)).toMatchObject({ ...kept, mode, identityEndPendingAt: NOW });
  });

  it('rejects without a mark when the mark cannot be written', async () => {
    const h = harness(jarRow());
    const refusal = new Error('gateway database unavailable');
    h.options.jar.markIdentityEndPending = () => Promise.reject(refusal);
    await expect(createInvalidation(h.options).beforeLegacyLogout(SESSION_ID, 'target-primary')).rejects.toBe(refusal);
    expect(h.calls.map(([op]) => op)).not.toContain('identity.end');
    expect(h.rows.get(SESSION_ID)).toEqual(jarRow());
  });
});

describe('afterTargetLogin', () => {
  it('only forgets tokens and state, touching neither the jar, the bridge nor identity', () => {
    const h = harness(jarRow());
    createInvalidation(h.options).afterTargetLogin(SESSION_ID);
    expect(h.calls).toEqual(FORGET_SESSION);
    expect(h.rows.get(SESSION_ID)).toEqual(jarRow());
  });
});

const marked = (overrides: Partial<JarRow> = {}): JarRow => ({ ...jarRow(overrides), identityEndPendingAt: NOW });
const ENDED: Call[] = [...FORGET_SESSION, ['identity.end', SESSION_ID, 'legacy-logout'], ['jar.drop', SESSION_ID]];
/** A target-primary session's identity end, under its jar's and its legacy session's locks. */
const ENDED_LOCKED: Call[] = [
  ...FORGET_SESSION,
  ['jar.lock', SESSION_ID],
  ['locked.get', SESSION_ID],
  ['locked.lockNative', LEGACY_SESSION_ID],
  ['locked.get', SESSION_ID],
  ['identity.end', SESSION_ID, 'legacy-logout'],
];
/** The re-adoption's describe of the jar's live legacy cookies. */
const READOPT_DESCRIBE: Call = ['bridge.describe', JAR_LIVE, { userAgent: USER_AGENT }];
/** The logged-out legacy session as legacy describes it after the logout. */
const LOGGED_OUT = described({ isLoggedIn: false });
/** The re-adoption of {@link LOGGED_OUT} into identity, at its `session.siteid`. */
const READOPT_ADOPT: Call = ['identity.adopt', { describe: LOGGED_OUT, siteId: 'tenant-a' }];
/** The jar kept for the re-adopted session: mark cleared at the version read, hydrated at the adopted epoch. */
const READOPTED: Call[] = [
  ['locked.clearIdentityEndPending', SESSION_ID, NOW],
  [
    'locked.upsert',
    { sessionId: SESSION_ID, legacySessionId: LEGACY_SESSION_ID, cookies: jarRow().cookies, mode: 'target-primary', hydratedEpoch: 6 },
  ],
  ['jar.commit', SESSION_ID],
  ...FORGET_SESSION,
];
/** The jar dropped with its mark when no re-adoption is possible. */
const DROPPED_LOCKED: Call[] = [['locked.drop', SESSION_ID], ['jar.commit', SESSION_ID], ...FORGET_SESSION];
/** Legacy's default request timeout, 1000 s. */
const REQUEST_TIMEOUT_MS = 1_000_000;
/** A later logout's mark: it keeps the first mark's time and stamps only `updatedAt`. */
const REMARKED_AT = new Date(NOW.getTime() + 1);

describe.each<[string, (invalidation: Invalidation) => Promise<unknown>, Call[]]>([
  [
    'afterLegacyLogout without live legacy cookies',
    (invalidation) => invalidation.afterLegacyLogout(SESSION_ID, { cookies: DELETED, mode: 'legacy-primary' }),
    [['jar.get', SESSION_ID]],
  ],
  [
    'completePending of a legacy-primary jar without live legacy cookies',
    (invalidation) => invalidation.completePending(SESSION_ID, { cookies: DELETED }),
    [['jar.get', SESSION_ID]],
  ],
])('%s', (_label, run, read) => {
  it('forgets tokens and state, ends the identity session as a legacy logout and drops the marked jar', async () => {
    const h = harness(marked({ mode: 'legacy-primary' }));
    await run(createInvalidation(h.options));
    expect(h.calls).toEqual([...read, ...ENDED]);
    expect(h.rows.size).toBe(0);
  });

  it('rejects and keeps the marked jar untouched when identity cannot end the session', async () => {
    const h = harness(marked({ mode: 'legacy-primary' }));
    const refusal = new Error('identity unavailable');
    h.options.identity.end = () => Promise.reject(refusal);
    await expect(run(createInvalidation(h.options))).rejects.toBe(refusal);
    expect(h.calls).toEqual([...read, ...FORGET_SESSION]);
    expect(h.rows.get(SESSION_ID)).toEqual(marked({ mode: 'legacy-primary' }));
  });
});

describe('afterLegacyLogout judged by the login legacy holds', () => {
  const HELD: LegacyLogoutFacts = { cookies: { ...BROWSER_LIVE, ...EXPIRED }, userAgent: USER_AGENT, mode: 'target-primary' };
  const EVIDENCE: Call[] = [
    ['jar.get', SESSION_ID],
    ['bridge.describe', BROWSER_LIVE, { userAgent: USER_AGENT }],
    ['identity.snapshot', SESSION_ID],
  ];

  it('only clears the mark at the version read, keeping the identity session and its jar, when legacy holds the login under identity secret', async () => {
    const h = harness(marked());
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls).toEqual([...EVIDENCE, ['jar.clearIdentityEndPending', SESSION_ID, NOW]]);
    expect(h.rows.get(SESSION_ID)).toEqual(jarRow());
  });

  it('clears nothing when legacy keeps the login of a session a reader already unmarked', async () => {
    const h = harness(jarRow());
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls).toEqual(EVIDENCE);
    expect(h.rows.get(SESSION_ID)).toEqual(jarRow());
  });

  it('ends the identity session, then re-adopts the logged-out legacy session under its id and keeps the jar unmarked', async () => {
    const h = harness(marked());
    h.describe = LOGGED_OUT;
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls).toEqual([...EVIDENCE, ...ENDED_LOCKED, READOPT_DESCRIBE, READOPT_ADOPT, ...READOPTED]);
    expect(h.rows.get(SESSION_ID)).toEqual(jarRow({ hydratedEpoch: 6 }));
  });

  /** Fails the re-adoption's describe, the second of the after-step. */
  const failSecondDescribe = (h: Harness): void => {
    h.describe = LOGGED_OUT;
    const describeLegacy = h.options.bridge.describe;
    let described = 0;
    h.options.bridge.describe = (cookies, call) =>
      (described += 1) === 1 ? describeLegacy(cookies, call) : Promise.reject(new TypeError('fetch failed'));
  };

  it.each<{ name: string; row?: JarRow; arrange: (h: Harness) => void; readopt: Call[]; warned?: boolean }>([
    {
      name: 'legacy logged in again under a fresh CSRF secret',
      arrange: (h) => (h.describe = described({ csrfSecretKey: 'CSRF-SECRET-0002' })),
      readopt: [READOPT_DESCRIBE],
    },
    { name: 'identity reports the session ended while legacy keeps its login', arrange: (h) => (h.snapshot = undefined), readopt: [READOPT_DESCRIBE] },
    {
      name: 'ColdFusion replaced the legacy session of the jar',
      arrange: (h) => {
        h.describe = LOGGED_OUT;
        h.describeSetCookies = ['CFID=9009;path=/;HttpOnly'];
      },
      readopt: [READOPT_DESCRIBE],
    },
    {
      name: 'the cookies of the jar attach another legacy session',
      arrange: (h) => (h.describe = described({ isLoggedIn: false, sessionId: NEW_LEGACY_SESSION_ID })),
      readopt: [READOPT_DESCRIBE],
    },
    {
      name: 'identity adopts the legacy session as another session',
      arrange: (h) => {
        h.describe = LOGGED_OUT;
        h.adopted = { sessionId: NEW_SESSION_ID, epoch: 6, setCookie: [] };
      },
      readopt: [READOPT_DESCRIBE, READOPT_ADOPT],
    },
    { name: 'the jar holds no live legacy cookies', row: marked({ cookies: DELETED }), arrange: (h) => (h.describe = LOGGED_OUT), readopt: [] },
    { name: 'legacy cannot be described again', arrange: failSecondDescribe, readopt: [], warned: true },
    {
      name: 'identity cannot adopt the legacy session',
      arrange: (h) => {
        h.describe = LOGGED_OUT;
        h.options.identity.adopt = () => Promise.reject(new TypeError('fetch failed'));
      },
      readopt: [READOPT_DESCRIBE],
      warned: true,
    },
  ])('ends the identity session and drops the jar when $name', async ({ row, arrange, readopt, warned }) => {
    const h = harness(row ?? marked());
    arrange(h);
    const warnings: Array<[object, string]> = [];
    h.options.logger = { warn: (obj, msg) => warnings.push([obj, msg]) };
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls).toEqual([...EVIDENCE, ...ENDED_LOCKED, ...readopt, ...DROPPED_LOCKED]);
    expect(h.rows.size).toBe(0);
    expect(warnings).toEqual(
      warned === true
        ? [[{ error: expect.objectContaining({ type: 'TypeError' }) }, 'legacy session not re-adopted after logout; its jar is dropped']]
        : [],
    );
  });

  it('re-adopts nothing in legacy-primary mode, where the browser holds the legacy cookies themselves', async () => {
    const h = harness(marked({ mode: 'legacy-primary' }));
    h.describe = LOGGED_OUT;
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, { ...HELD, mode: 'legacy-primary' });
    expect(h.calls).toEqual([...EVIDENCE, ...ENDED]);
    expect(h.rows.size).toBe(0);
  });

  it('rejects out of the jar lock and keeps the marked jar when identity cannot end a target-primary session', async () => {
    const h = harness(marked());
    h.describe = LOGGED_OUT;
    const refusal = new Error('identity unavailable');
    h.options.identity.end = () => Promise.reject(refusal);
    await expect(createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD)).rejects.toBe(refusal);
    expect(h.calls).toEqual([...EVIDENCE, ...ENDED_LOCKED.slice(0, -1), ['jar.rollback', SESSION_ID]]);
    expect(h.rows.get(SESSION_ID)).toEqual(marked());
  });

  it.each<[string, (options: InvalidationOptions, refusal: Error) => void]>([
    ['legacy cannot be described', (options, refusal) => (options.bridge.describe = () => Promise.reject(refusal))],
    ['identity cannot report its snapshot', (options, refusal) => (options.identity.snapshot = () => Promise.reject(refusal))],
  ])('logs and keeps the session and its mark, ending nothing, when %s', async (_label, refuse) => {
    const h = harness(marked());
    const refusal = new TypeError('fetch failed');
    refuse(h.options, refusal);
    const warnings: Array<[object, string]> = [];
    h.options.logger = { warn: (obj, msg) => warnings.push([obj, msg]) };
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls.slice(-1)).toEqual([['jar.markIdentityEndPending', SESSION_ID, 'target-primary']]);
    expect(h.calls.map(([op]) => op)).not.toContain('identity.end');
    expect(warnings).toEqual([
      [{ error: expect.objectContaining({ type: 'TypeError' }) }, 'legacy logout outcome unknown; the identity session stays pending'],
    ]);
    expect(h.rows.get(SESSION_ID)).toEqual(marked());
  });

  it('marks the session again when a reader cleared the mark before the outcome proved unknown', async () => {
    const h = harness(jarRow());
    h.describeError = new TypeError('fetch failed');
    await createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD);
    expect(h.calls).toEqual([...EVIDENCE, ['jar.markIdentityEndPending', SESSION_ID, 'target-primary']]);
    expect(h.rows.get(SESSION_ID)).toEqual(marked());
  });

  it('rejects without ending the identity session when the mark cannot be cleared', async () => {
    const h = harness(marked());
    const refusal = new Error('gateway database unavailable');
    h.options.jar.clearIdentityEndPending = () => Promise.reject(refusal);
    await expect(createInvalidation(h.options).afterLegacyLogout(SESSION_ID, HELD)).rejects.toBe(refusal);
    expect(h.calls).toEqual(EVIDENCE);
    expect(h.rows.get(SESSION_ID)).toEqual(marked());
  });
});

describe('completePending judged by the login legacy holds', () => {
  const HELD: LegacyHeldSession = { cookies: { ...BROWSER_LIVE, ...EXPIRED }, userAgent: USER_AGENT };
  const EVIDENCE: Call[] = [
    ['jar.get', SESSION_ID],
    ['bridge.describe', JAR_LIVE, { userAgent: USER_AGENT }],
    ['identity.snapshot', SESSION_ID],
  ];

  const CLEARED: Call[] = [['jar.clearIdentityEndPending', SESSION_ID, NOW]];

  it.each<{
    name: string;
    legacy: Partial<LegacyDescribe> | Error;
    initial?: Partial<JarRow>;
    elapsedMs: number;
    timeoutMs?: number;
    adopted?: AdoptedSession;
    outcome: LegacyLogoutOutcome;
    after: Call[];
    row: JarRow | undefined;
  }>([
    {
      name: 'ends a session legacy logged out and re-adopts it under its id, so it goes on as kept',
      legacy: { isLoggedIn: false },
      elapsedMs: 0,
      outcome: 'kept',
      after: [...ENDED_LOCKED, READOPT_DESCRIBE, READOPT_ADOPT, ...READOPTED],
      row: jarRow({ hydratedEpoch: 6 }),
    },
    {
      name: 'ends a session legacy logged out and drops its jar when identity adopts the legacy session as another',
      legacy: { isLoggedIn: false },
      elapsedMs: 0,
      adopted: { sessionId: NEW_SESSION_ID, epoch: 6, setCookie: [] },
      outcome: 'logged-out',
      after: [...ENDED_LOCKED, READOPT_DESCRIBE, READOPT_ADOPT, ...DROPPED_LOCKED],
      row: undefined,
    },
    {
      name: 'keeps a session legacy kept logged in, with its fresh mark',
      legacy: {},
      elapsedMs: REQUEST_TIMEOUT_MS - 1,
      outcome: 'kept',
      after: [],
      row: marked(),
    },
    {
      name: 'keeps a session legacy kept logged in and clears its mark once older than the default request timeout',
      legacy: {},
      elapsedMs: REQUEST_TIMEOUT_MS,
      outcome: 'kept',
      after: CLEARED,
      row: jarRow(),
    },
    {
      name: 'keeps the first mark of a kept session while its latest re-mark is younger than the request timeout',
      legacy: {},
      initial: { updatedAt: REMARKED_AT },
      elapsedMs: REQUEST_TIMEOUT_MS,
      outcome: 'kept',
      after: [],
      row: marked({ updatedAt: REMARKED_AT }),
    },
    {
      name: 'clears the mark of a kept session once older than a configured request timeout',
      legacy: {},
      elapsedMs: 60_000,
      timeoutMs: 60_000,
      outcome: 'kept',
      after: CLEARED,
      row: jarRow(),
    },
    {
      name: 'keeps the mark and ends nothing while legacy cannot be described',
      legacy: new TypeError('fetch failed'),
      elapsedMs: REQUEST_TIMEOUT_MS,
      outcome: 'unknown',
      after: [],
      row: marked(),
    },
  ])('$name', async ({ legacy, initial, elapsedMs, timeoutMs, adopted, outcome, after, row }) => {
    const h = harness(marked(initial));
    if (legacy instanceof Error) h.describeError = legacy;
    else h.describe = described(legacy);
    if (adopted !== undefined) h.adopted = adopted;
    h.options.clock = { now: () => new Date(NOW.getTime() + elapsedMs) };
    if (timeoutMs !== undefined) h.options.requestTimeoutMs = timeoutMs;
    await expect(createInvalidation(h.options).completePending(SESSION_ID, HELD)).resolves.toBe(outcome);
    expect(h.calls).toEqual([...EVIDENCE, ...after]);
    expect(h.rows.get(SESSION_ID)).toEqual(row);
  });

  it.each<[SessionMode, JarCookies]>([
    ['target-primary', JAR_LIVE],
    ['legacy-primary', BROWSER_LIVE],
  ])('describes a %s session by the live cookies legacy holds for it', async (mode, cookies) => {
    const h = harness(marked({ mode }));
    await createInvalidation(h.options).completePending(SESSION_ID, HELD);
    expect(h.calls[1]).toEqual(['bridge.describe', cookies, { userAgent: USER_AGENT }]);
  });
});

describe('a kept logout judged while a later logout of the session marks it again', () => {
  const HELD: LegacyHeldSession = { cookies: BROWSER_LIVE, userAgent: USER_AGENT };

  it.each<[string, (invalidation: Invalidation) => Promise<unknown>]>([
    ['the after-step', (invalidation) => invalidation.afterLegacyLogout(SESSION_ID, { ...HELD, mode: 'target-primary' })],
    ['a reader', (invalidation) => invalidation.completePending(SESSION_ID, HELD)],
  ])('leaves the later mark standing when %s clears at the version it read', async (_label, run) => {
    const h = harness(marked());
    h.options.clock = { now: () => new Date(NOW.getTime() + REQUEST_TIMEOUT_MS) };
    const describeLegacy = h.options.bridge.describe;
    h.options.bridge.describe = (cookies, call) => {
      const row = h.rows.get(SESSION_ID);
      if (row !== undefined) h.rows.set(SESSION_ID, { ...row, updatedAt: REMARKED_AT });
      return describeLegacy(cookies, call);
    };
    await run(createInvalidation(h.options));
    expect(h.calls.filter(([op]) => op.startsWith('jar.') || op === 'identity.end')).toEqual([
      ['jar.get', SESSION_ID],
      ['jar.clearIdentityEndPending', SESSION_ID, NOW],
    ]);
    expect(h.rows.get(SESSION_ID)).toEqual(marked({ updatedAt: REMARKED_AT }));
  });
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
