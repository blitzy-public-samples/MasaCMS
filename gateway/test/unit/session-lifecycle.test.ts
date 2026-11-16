// Session lifecycle across the seam: user tokens, state checks, hydration and logout over the memory jar and the legacy double.
import { Buffer } from 'node:buffer';
import { LegacyServiceUnavailableError, parseCookieHeader } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { mintUserToken } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InventoryFacts, RouteFacts } from '../../src/cutover/types.js';
import {
  createBridgeClient,
  type BridgeClient,
  type LegacyDescribe,
  type LegacyDescribeUser,
} from '../../src/session/bridge-client.js';
import { HYDRATION_OWNERS, createHydrator, type HydrationBarrier, type Hydrator } from '../../src/session/hydration.js';
import type {
  AdoptedSession,
  IdentityClient,
  SessionSnapshot,
  SessionState,
  TokenRequest,
  UserTokenResponse,
} from '../../src/session/identity-client.js';
import {
  createInvalidation,
  isLegacyLogout,
  isTargetLogout,
  legacySessionEffect,
  type Invalidation,
  type LegacySessionChange,
} from '../../src/session/invalidation.js';
import { absorbLegacySetCookies, createLegacyJar, type JarCookies, type LegacyJar } from '../../src/session/jar.js';
import type { SessionMode } from '../../src/session/mode.js';
import {
  STATE_CHECK_INTERVAL_MS,
  STATE_MEMO_RETENTION_MS,
  createSessionStateChecker,
  type SessionStateChecker,
} from '../../src/session/state-check.js';
import { DEFAULT_SITE_ID, TOKEN_REUSE_MARGIN_MS, createTokenCache, type TokenCache } from '../../src/session/token-cache.js';
import { TEST_BRIDGE_KEY, TEST_CLOCK } from '../helpers/env.js';
import { createInProcessLegacyOrigin, parseWireTime, type InProcessLegacyOrigin } from '../helpers/legacy-origin.js';
import { createMemoryGatewayDb, type LegacyJarRow, type MemoryGatewayDb } from '../helpers/memory-store.js';

const SESSION = 's1';
const OTHER_SESSION = 's2';
const LEGACY_SESSION_ID = 'OPT2LIFE_1001_12345678';
const USER_ID = 'USER-0001';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';
const TOKEN_LIFETIME_SECONDS = 300;
const ROLES = ['S2IsPrivate;default', 'S2'];
const MEMBERSHIP_IDS = 'GROUP-1,USER-0001';
const CSRF_SECRET = 'CSRF-SECRET-LIFECYCLE';
const USED_TOKEN = 'C'.repeat(32);
/** Hydration time of the used-token entries: the manual clock's start as a bridge wire time. */
const WIRE_START = '2026-06-30 12:00:00.000';

const USER: LegacyDescribeUser = {
  userID: USER_ID,
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
};

const JAR_COOKIES: JarCookies = {
  CFID: { name: 'CFID', value: '1001', attributes: 'path=/;HttpOnly' },
  CFTOKEN: { name: 'CFTOKEN', value: '12345678', attributes: 'path=/;HttpOnly' },
};

/** Set-Cookie values the stub bridge answers `op=hydrate` with: two session cookies and one other. */
const HYDRATE_SET_COOKIES = ['CFID=2002;path=/;HttpOnly', 'CFTOKEN=22222222;path=/;HttpOnly', 'OTHER=1;path=/'];

type Call = [op: string, ...args: unknown[]];

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A clock the test moves forward. */
interface ManualClock extends Clock {
  advance(ms: number): void;
}

function manualClock(start: Date = TEST_CLOCK.now()): ManualClock {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
  };
}

function active(epoch: number): SessionState {
  return { state: 'active', epoch, userId: USER_ID, siteId: 'default' };
}

function snapshotAt(epoch: number): SessionSnapshot {
  return {
    sessionId: SESSION,
    epoch,
    loginSnapshot: { user: { ...USER, membershipIds: MEMBERSHIP_IDS }, roles: [...ROLES] },
    csrfSecretKey: CSRF_SECRET,
    usedTokens: [USED_TOKEN],
  };
}

function describeOf(sessionId: string): LegacyDescribe {
  return {
    sessionId,
    isLoggedIn: true,
    user: USER,
    memberships: ROLES.join(','),
    membershipIds: MEMBERSHIP_IDS,
    csrfSecretKey: CSRF_SECRET,
    usedTokens: [],
    siteId: 'default',
    serverTime: WIRE_START,
  };
}

/** The claims of a compact JWT, read without verification. */
function claimsOf(token: string): UserTokenResponse['claims'] {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UserTokenResponse['claims'];
}

/** Identity stand-in: tokens signed by the platform test key, programmed states, snapshots and adoptions. */
interface IdentityStub {
  client: IdentityClient;
  mints: TokenRequest[];
  /** Tokens in minting order. */
  tokens: string[];
  states: Map<string, SessionState>;
  /** Held state reads wait for it; a set `stateFailure` then rejects them. */
  stateGate?: Promise<void>;
  stateFailure?: Error;
  snapshots: Map<string, SessionSnapshot>;
  adopted: AdoptedSession;
}

function identityStub(clock: Clock, record: (op: string, ...args: unknown[]) => void): IdentityStub {
  const unexpected = (op: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity.${op} call`));
  const stub: IdentityStub = {
    mints: [],
    tokens: [],
    states: new Map(),
    snapshots: new Map(),
    adopted: { sessionId: SESSION, epoch: 5, setCookie: [] },
    client: {
      async mintToken(request) {
        record('identity.mintToken', request);
        stub.mints.push(request);
        const iat = Math.floor(clock.now().getTime() / 1000);
        const exp = iat + TOKEN_LIFETIME_SECONDS;
        const epoch = stub.states.get(request.sessionId)?.epoch ?? 1;
        const token = await mintUserToken({
          sub: USER_ID,
          sid: request.sessionId,
          site: request.siteId,
          roles: ['s2'],
          epoch,
          iat,
          exp,
        });
        stub.tokens.push(token);
        return { token, expiresAt: exp, epoch, claims: claimsOf(token) };
      },
      async state(sessionId) {
        record('identity.state', sessionId);
        await stub.stateGate;
        if (stub.stateFailure !== undefined) throw stub.stateFailure;
        return stub.states.get(sessionId) ?? { state: 'ended', epoch: 0, userId: '', siteId: '' };
      },
      snapshot(sessionId) {
        record('identity.snapshot', sessionId);
        return Promise.resolve(stub.snapshots.get(sessionId));
      },
      adopt(input) {
        record('identity.adopt', input);
        return Promise.resolve(stub.adopted);
      },
      end(sessionId, reason) {
        record('identity.end', sessionId, reason);
        const epoch = (stub.states.get(sessionId)?.epoch ?? 0) + 1;
        stub.states.set(sessionId, { state: 'ended', epoch, userId: USER_ID, siteId: 'default' });
        return Promise.resolve({ ended: true, epoch });
      },
      authenticate: unexpected('authenticate'),
      adminSite: unexpected('adminSite'),
      claim: unexpected('claim'),
      settle: unexpected('settle'),
    },
  };
  return stub;
}

/** Stub identity, bridge and barrier with one ordered call log, over the memory jar and real per-instance caches. */
interface Seam {
  calls: Call[];
  clock: ManualClock;
  identity: IdentityStub;
  db: MemoryGatewayDb;
  jar: LegacyJar;
  bridge: Pick<BridgeClient, 'describe' | 'hydrate' | 'end'>;
  /** Rejects every barrier wait with `refusal` when set. */
  barrier: HydrationBarrier & { refusal?: unknown };
  tokenCache: TokenCache;
  stateCheck: SessionStateChecker;
  /** Runs after each call is logged, before it answers. */
  onCall?: (op: string) => void;
  ops(): string[];
  hydrator(): Hydrator;
  invalidation(): Invalidation;
}

function createSeam(jars: Partial<LegacyJarRow>[] = []): Seam {
  const calls: Call[] = [];
  const clock = manualClock();
  const db = createMemoryGatewayDb({ jars });
  const record = (op: string, ...args: unknown[]): void => {
    calls.push([op, ...args]);
    seam.onCall?.(op);
  };
  const identity = identityStub(clock, record);
  const tokenCache = createTokenCache({ identity: identity.client, clock });
  const seam: Seam = {
    calls,
    clock,
    identity,
    db,
    jar: createLegacyJar(db),
    bridge: {
      describe(cookies, call) {
        record('bridge.describe', cookies, call);
        return Promise.resolve({ body: describeOf(LEGACY_SESSION_ID), setCookies: [] });
      },
      hydrate(cookies, body, call) {
        record('bridge.hydrate', cookies, body, call);
        return Promise.resolve({
          body: { sessionId: LEGACY_SESSION_ID, hydrated: true, serverTime: WIRE_START },
          setCookies: HYDRATE_SET_COOKIES,
        });
      },
      end(cookies, call) {
        record('bridge.end', cookies, call);
        return Promise.resolve({ body: { ended: true, serverTime: WIRE_START }, setCookies: [] });
      },
    },
    barrier: {
      async awaitOwners(owners) {
        record('barrier.awaitOwners', owners);
        if (seam.barrier.refusal !== undefined) throw seam.barrier.refusal;
      },
    },
    tokenCache,
    stateCheck: createSessionStateChecker({ identity: identity.client, clock, tokenCache }),
    ops: () => calls.map(([op]) => op),
    hydrator: () =>
      createHydrator({ identity: identity.client, bridge: seam.bridge, jar: seam.jar, barrier: seam.barrier, clock }),
    invalidation: () =>
      createInvalidation({
        identity: identity.client,
        bridge: seam.bridge,
        jar: seam.jar,
        tokenCache: seam.tokenCache,
        state: seam.stateCheck,
      }),
  };
  identity.states.set(SESSION, active(1));
  identity.states.set(OTHER_SESSION, active(1));
  identity.snapshots.set(SESSION, snapshotAt(3));
  return seam;
}

/** A jar of `s1` attached to the legacy session {@link LEGACY_SESSION_ID}. */
function jarOf(mode: SessionMode, hydratedEpoch: string | null): Partial<LegacyJarRow> {
  return {
    session_id: SESSION,
    legacy_session_id: LEGACY_SESSION_ID,
    cookies: JAR_COOKIES,
    mode,
    hydrated_epoch: hydratedEpoch,
  };
}

function callsOf(seam: Seam, op: string): Call[] {
  return seam.calls.filter(([name]) => name === op);
}

const doubles: InProcessLegacyOrigin[] = [];

/** The legacy origin double on `clock`, with a signed bridge client that reaches it in process. */
function legacyBridge(clock: Clock): { legacy: InProcessLegacyOrigin; bridge: BridgeClient } {
  const legacy = createInProcessLegacyOrigin({ clock });
  doubles.push(legacy);
  const bridge = createBridgeClient({ legacyOrigin: legacy.url, hmacKey: TEST_BRIDGE_KEY, clock, fetch: legacy.fetch });
  return { legacy, bridge };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(doubles.splice(0).map((double) => double.close()));
});

describe('token cache', () => {
  it('mints one token per session and site, and serves repeats from the cache', async () => {
    const { identity, tokenCache } = createSeam();

    const first = await tokenCache.get(SESSION, 'tenant-a', 1);
    await expect(tokenCache.get(SESSION, 'tenant-a', 1)).resolves.toBe(first);
    expect(identity.mints).toEqual([{ sessionId: SESSION, siteId: 'tenant-a' }]);
    expect(first.token).toBe(identity.tokens[0]);
    expect(first.claims).toStrictEqual(claimsOf(first.token));
    expect(first.claims).toMatchObject({ sid: SESSION, site: 'tenant-a', sub: USER_ID });

    await tokenCache.get(SESSION, 'tenant-b', 1);
    expect(identity.mints).toEqual([
      { sessionId: SESSION, siteId: 'tenant-a' },
      { sessionId: SESSION, siteId: 'tenant-b' },
    ]);
  });

  it.each<[string, string | undefined]>([
    ['absent', undefined],
    ['empty', ''],
  ])('mints for the default site when the site is %s, sharing its cache entry', async (_label, siteId) => {
    const { identity, tokenCache } = createSeam();

    const token = await tokenCache.get(SESSION, siteId, 1);
    await expect(tokenCache.get(SESSION, DEFAULT_SITE_ID, 1)).resolves.toBe(token);
    expect(DEFAULT_SITE_ID).toBe('default');
    expect(identity.mints).toEqual([{ sessionId: SESSION, siteId: 'default' }]);
  });

  it('mints again once the cached token is within the reuse margin of its exp', async () => {
    const { clock, identity, tokenCache } = createSeam();
    await tokenCache.get(SESSION, 'tenant-a', 1);

    clock.advance(TOKEN_LIFETIME_SECONDS * 1000 - TOKEN_REUSE_MARGIN_MS - 1);
    await tokenCache.get(SESSION, 'tenant-a', 1);
    expect(identity.mints).toHaveLength(1);

    clock.advance(1);
    const renewed = await tokenCache.get(SESSION, 'tenant-a', 1);
    expect(identity.mints).toHaveLength(2);
    expect(renewed.token).toBe(identity.tokens[1]);
    expect(renewed.token).not.toBe(identity.tokens[0]);
  });

  it('mints again for a new session epoch', async () => {
    const { identity, tokenCache } = createSeam();
    await tokenCache.get(SESSION, 'tenant-a', 1);
    await tokenCache.get(SESSION, 'tenant-a', 2);
    expect(identity.mints).toEqual([
      { sessionId: SESSION, siteId: 'tenant-a' },
      { sessionId: SESSION, siteId: 'tenant-a' },
    ]);
  });

  it('drop forgets every site of that session and no other session', async () => {
    const { identity, tokenCache } = createSeam();
    const sites: Array<[string, string]> = [
      [SESSION, 'tenant-a'],
      [SESSION, 'tenant-b'],
      [OTHER_SESSION, 'tenant-a'],
    ];
    for (const [sessionId, siteId] of sites) await tokenCache.get(sessionId, siteId, 1);

    tokenCache.drop(SESSION);
    for (const [sessionId, siteId] of sites) await tokenCache.get(sessionId, siteId, 1);

    expect(identity.mints.slice(3)).toEqual([
      { sessionId: SESSION, siteId: 'tenant-a' },
      { sessionId: SESSION, siteId: 'tenant-b' },
    ]);
  });
});

describe('session state check', () => {
  it('reads identity at most once per second per session', async () => {
    const seam = createSeam();

    const first = await seam.stateCheck.check(SESSION);
    seam.clock.advance(STATE_CHECK_INTERVAL_MS - 1);
    await expect(seam.stateCheck.check(SESSION)).resolves.toEqual(first);
    expect(first).toEqual({ ...active(1), epochChanged: false });
    expect(callsOf(seam, 'identity.state')).toHaveLength(1);

    seam.clock.advance(1);
    await seam.stateCheck.check(SESSION);
    expect(STATE_CHECK_INTERVAL_MS).toBe(1000);
    expect(callsOf(seam, 'identity.state')).toHaveLength(2);
  });

  it('keeps a separate interval for each session', async () => {
    const seam = createSeam();
    await seam.stateCheck.check(SESSION);
    await seam.stateCheck.check(OTHER_SESSION);
    await seam.stateCheck.check(SESSION);
    expect(callsOf(seam, 'identity.state')).toEqual([
      ['identity.state', SESSION],
      ['identity.state', OTHER_SESSION],
    ]);
  });

  it('reports an epoch change and drops the session tokens', async () => {
    const seam = createSeam();
    const drop = vi.spyOn(seam.tokenCache, 'drop');
    await seam.tokenCache.get(SESSION, 'tenant-a', 1);
    await seam.stateCheck.check(SESSION);
    expect(drop).not.toHaveBeenCalled();

    seam.identity.states.set(SESSION, active(2));
    seam.clock.advance(STATE_CHECK_INTERVAL_MS);
    await expect(seam.stateCheck.check(SESSION)).resolves.toEqual({
      ...active(2),
      epochChanged: true,
      previousEpoch: 1,
    });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(SESSION);

    await seam.tokenCache.get(SESSION, 'tenant-a', 2);
    expect(seam.identity.mints).toHaveLength(2);
  });

  it('reports a session identity has ended', async () => {
    const seam = createSeam();
    await seam.stateCheck.check(SESSION);
    seam.identity.states.set(SESSION, { state: 'ended', epoch: 2, userId: USER_ID, siteId: 'default' });
    seam.clock.advance(STATE_CHECK_INTERVAL_MS);
    await expect(seam.stateCheck.check(SESSION)).resolves.toMatchObject({
      state: 'ended',
      epochChanged: true,
      previousEpoch: 1,
    });
  });

  it('forget clears the observed state, so the next check reads identity afresh', async () => {
    const seam = createSeam();
    const drop = vi.spyOn(seam.tokenCache, 'drop');
    await seam.stateCheck.check(SESSION);

    seam.stateCheck.forget(SESSION);
    seam.identity.states.set(SESSION, active(2));
    await expect(seam.stateCheck.check(SESSION)).resolves.toEqual({ ...active(2), epochChanged: false });
    expect(callsOf(seam, 'identity.state')).toHaveLength(2);
    expect(drop).not.toHaveBeenCalled();
  });

  it('shares one identity read between concurrent checks of a session', async () => {
    const seam = createSeam();
    const [a, b] = await Promise.all([seam.stateCheck.check(SESSION), seam.stateCheck.check(SESSION)]);
    expect(b).toEqual(a);
    expect(callsOf(seam, 'identity.state')).toHaveLength(1);
  });

  it.each<[string, Error | undefined]>([
    ['answers', undefined],
    ['fails', new Error('identity unavailable')],
  ])('keeps a read that %s after forget out of the memo', async (_label, failure) => {
    const seam = createSeam();
    const gate = deferred();
    seam.identity.stateGate = gate.promise;
    seam.identity.stateFailure = failure;

    const inFlight = seam.stateCheck.check(SESSION);
    seam.stateCheck.forget(SESSION);
    gate.resolve();
    if (failure === undefined) await expect(inFlight).resolves.toEqual({ ...active(1), epochChanged: false });
    else await expect(inFlight).rejects.toBe(failure);

    seam.identity.stateFailure = undefined;
    await seam.stateCheck.check(SESSION);
    expect(callsOf(seam, 'identity.state')).toHaveLength(2);
  });

  it('forgets a session left unchecked for the memo retention, so its next epoch counts as first seen', async () => {
    const seam = createSeam();
    const drop = vi.spyOn(seam.tokenCache, 'drop');
    await seam.stateCheck.check(SESSION);

    seam.clock.advance(STATE_MEMO_RETENTION_MS);
    seam.identity.states.set(SESSION, active(2));
    await expect(seam.stateCheck.check(SESSION)).resolves.toEqual({ ...active(2), epochChanged: false });
    expect(drop).not.toHaveBeenCalled();
  });
});

describe('hydration', () => {
  it('awaits the identity and people barrier, reads the snapshot, then hydrates and records the legacy cookies', async () => {
    const seam = createSeam();

    const row = await seam.hydrator().ensureHydrated(SESSION, 3, { userAgent: USER_AGENT });

    expect(seam.ops()).toEqual(['barrier.awaitOwners', 'identity.snapshot', 'bridge.hydrate']);
    expect(HYDRATION_OWNERS).toEqual(['identity', 'people']);
    expect(seam.calls[0]).toEqual(['barrier.awaitOwners', [...HYDRATION_OWNERS]]);
    expect(seam.calls[1]).toEqual(['identity.snapshot', SESSION]);
    expect(seam.calls[2]).toEqual([
      'bridge.hydrate',
      {},
      {
        snapshot: { user: USER, memberships: ROLES.join(','), membershipIds: MEMBERSHIP_IDS },
        csrfSecretKey: CSRF_SECRET,
        usedTokens: [{ token: USED_TOKEN, usedAt: WIRE_START }],
      },
      { userAgent: USER_AGENT, legacySessionId: undefined },
    ]);

    const absorbed = absorbLegacySetCookies(HYDRATE_SET_COOKIES).sessionCookies;
    expect(row).toMatchObject({ legacySessionId: LEGACY_SESSION_ID, cookies: absorbed, hydratedEpoch: 3 });
    expect(seam.db.tables.legacy_jar).toEqual([
      expect.objectContaining({
        session_id: SESSION,
        legacy_session_id: LEGACY_SESSION_ID,
        cookies: absorbed,
        mode: 'target-primary',
        hydrated_epoch: '3',
      }),
    ]);
  });

  it('only probes legacy on a repeat at the same epoch, and hydrates again at a new epoch', async () => {
    const seam = createSeam();
    const hydrator = seam.hydrator();
    await hydrator.ensureHydrated(SESSION, 3);

    seam.calls.length = 0;
    await expect(hydrator.ensureHydrated(SESSION, 3)).resolves.toMatchObject({ hydratedEpoch: 3 });
    expect(seam.ops()).toEqual(['bridge.describe']);

    seam.calls.length = 0;
    seam.identity.snapshots.set(SESSION, snapshotAt(4));
    await expect(hydrator.ensureHydrated(SESSION, 4)).resolves.toMatchObject({ hydratedEpoch: 4 });
    expect(seam.ops()).toEqual(['barrier.awaitOwners', 'bridge.describe', 'identity.snapshot', 'bridge.hydrate']);
    expect(seam.db.tables.legacy_jar[0]?.hydrated_epoch).toBe('4');
  });

  it('propagates a barrier rejection without reading identity or calling the bridge', async () => {
    const seam = createSeam();
    const refusal = new LegacyServiceUnavailableError();
    seam.barrier.refusal = refusal;

    await expect(seam.hydrator().ensureHydrated(SESSION, 3)).rejects.toBe(refusal);
    expect(seam.ops()).toEqual(['barrier.awaitOwners']);
    expect(seam.db.tables.legacy_jar).toEqual([]);
  });

  it('installs the snapshot in the legacy double with op=hydrate alone and no login', async () => {
    const seam = createSeam();
    const { legacy, bridge } = legacyBridge(seam.clock);
    const hydrator = createHydrator({
      identity: seam.identity.client,
      bridge,
      jar: seam.jar,
      barrier: seam.barrier,
      clock: seam.clock,
    });

    const row = await hydrator.ensureHydrated(SESSION, 3, { userAgent: USER_AGENT });

    expect(legacy.bridgeCalls.map(({ op, status }) => ({ op, status }))).toEqual([{ op: 'hydrate', status: 200 }]);
    expect(legacy.requests).toHaveLength(1);
    const legacySessionId = row?.legacySessionId ?? '';
    const session = legacy.sessions.get(legacySessionId);
    expect(session).toMatchObject({
      isLoggedIn: true,
      hydrations: 1,
      memberships: ROLES.join(','),
      membershipIds: MEMBERSHIP_IDS,
      csrfSecretKey: CSRF_SECRET,
    });
    // The login time is the snapshot's: hydration never runs the LastLogin update.
    expect(session?.user).toMatchObject({ userID: USER_ID, lastlogin: parseWireTime(USER.lastlogin) });
    expect(legacy.usedTokens(legacySessionId).map(({ token }) => token)).toEqual([USED_TOKEN]);
    expect(row).toMatchObject({
      mode: 'target-primary',
      hydratedEpoch: 3,
      cookies: { JSESSIONID: expect.objectContaining({ value: session?.jsessionid }) },
    });

    await hydrator.ensureHydrated(SESSION, 3, { userAgent: USER_AGENT });
    expect(legacy.bridgeCalls.map(({ op }) => op)).toEqual(['hydrate', 'describe']);
    expect(session?.hydrations).toBe(1);
  });
});

describe('invalidation', () => {
  /** Mints a token and records a state for `s1`, then clears the call log. */
  async function primeCaches(seam: Seam): Promise<void> {
    await seam.tokenCache.get(SESSION, 'tenant-a', 1);
    await seam.stateCheck.check(SESSION);
    seam.calls.length = 0;
  }

  /** Asserts the next token and state of `s1` come from identity afresh. */
  async function expectCachesDropped(seam: Seam): Promise<void> {
    seam.calls.length = 0;
    await seam.tokenCache.get(SESSION, 'tenant-a', 1);
    await seam.stateCheck.check(SESSION);
    expect(seam.ops()).toEqual(['identity.mintToken', 'identity.state']);
  }

  it('after a target logout ends the legacy session, then drops the jar and the cached tokens', async () => {
    const seam = createSeam([jarOf('target-primary', '3')]);
    await primeCaches(seam);
    const rowsAtEnd: number[] = [];
    seam.onCall = (op) => {
      if (op === 'bridge.end') rowsAtEnd.push(seam.db.tables.legacy_jar.length);
    };

    await seam.invalidation().afterTargetLogout(SESSION, { userAgent: USER_AGENT });

    expect(seam.calls).toEqual([
      ['bridge.end', JAR_COOKIES, { userAgent: USER_AGENT, legacySessionId: LEGACY_SESSION_ID }],
    ]);
    expect(rowsAtEnd).toEqual([1]);
    expect(seam.db.tables.legacy_jar).toEqual([]);
    await expectCachesDropped(seam);
  });

  it('after a target logout ends the hydrated session in the legacy double with op=end', async () => {
    const seam = createSeam();
    const { legacy, bridge } = legacyBridge(seam.clock);
    const hydrator = createHydrator({
      identity: seam.identity.client,
      bridge,
      jar: seam.jar,
      barrier: seam.barrier,
      clock: seam.clock,
    });
    const row = await hydrator.ensureHydrated(SESSION, 3);
    const invalidation = createInvalidation({
      identity: seam.identity.client,
      bridge,
      jar: seam.jar,
      tokenCache: seam.tokenCache,
      state: seam.stateCheck,
    });

    await invalidation.afterTargetLogout(SESSION);

    const end = legacy.bridgeCalls.at(-1);
    expect(legacy.bridgeCalls.map(({ op }) => op)).toEqual(['hydrate', 'end']);
    expect(end).toMatchObject({ status: 200, legacySessionId: row?.legacySessionId });
    expect(end?.payload?.sid).toBe(row?.legacySessionId);
    const sent = Object.fromEntries(parseCookieHeader(String(end?.request.headers.cookie)));
    // parseCookieHeader keys pairs by lower-cased name.
    const jarValues = Object.fromEntries(
      Object.values(row?.cookies ?? {}).map(({ name, value }) => [name.toLowerCase(), value]),
    );
    expect(sent).toEqual(jarValues);
    expect(legacy.sessions.get(row?.legacySessionId ?? '')).toMatchObject({ ended: true, isLoggedIn: false });
    expect(seam.db.tables.legacy_jar).toEqual([]);
    expect(callsOf(seam, 'identity.end')).toEqual([]);
  });

  it('after a legacy logout ends the identity session and drops the jar and the cached tokens', async () => {
    const seam = createSeam([jarOf('legacy-primary', null)]);
    await primeCaches(seam);

    await seam.invalidation().afterLegacyLogout(SESSION);

    expect(seam.calls).toEqual([['identity.end', SESSION, 'legacy-logout']]);
    expect(seam.db.tables.legacy_jar).toEqual([]);
    await expectCachesDropped(seam);
  });

  it.each<[SessionMode, string | null, string | null]>([
    ['target-primary', '3', '5'],
    ['legacy-primary', null, null],
  ])(
    'after a legacy login in %s mode describes, then adopts, then sets the jar hydrated epoch from %s to %s',
    async (mode, seeded, recorded) => {
      const seam = createSeam([jarOf(mode, seeded)]);
      await primeCaches(seam);
      const epochsAtAdopt: Array<string | null | undefined> = [];
      seam.onCall = (op) => {
        if (op === 'identity.adopt') epochsAtAdopt.push(seam.db.tables.legacy_jar[0]?.hydrated_epoch);
      };

      const adopted = await seam.invalidation().afterLegacyLogin(SESSION, mode, { userAgent: USER_AGENT });

      expect(adopted).toEqual(seam.identity.adopted);
      expect(seam.calls).toEqual([
        ['bridge.describe', JAR_COOKIES, { userAgent: USER_AGENT }],
        ['identity.adopt', { describe: describeOf(LEGACY_SESSION_ID), siteId: 'default' }],
      ]);
      expect(epochsAtAdopt).toEqual([seeded]);
      expect(seam.db.tables.legacy_jar).toEqual([
        expect.objectContaining({ session_id: SESSION, legacy_session_id: LEGACY_SESSION_ID, mode, hydrated_epoch: recorded }),
      ]);
      await expectCachesDropped(seam);
    },
  );
});

describe('session-effect predicates', () => {
  const pageLogin: RouteFacts = {
    route: 'page:login',
    csrfValidation: 'none',
    writeSet: ['identity.login_state'],
    keyScope: ['userid'],
    sessionEffects: ['login'],
  };
  const facts: InventoryFacts = {
    get: (routeKey) => (routeKey === pageLogin.route ? pageLogin : undefined),
    routes: () => [pageLogin.route],
  };

  it.each<[string, SessionMode, boolean, boolean, LegacySessionChange | undefined]>([
    ['admin:clogin.logout', 'legacy-primary', true, true, 'logout'],
    ['admin:clogin.logout', 'target-primary', false, true, undefined],
    ['page:logout', 'target-primary', true, false, 'logout'],
    ['page:login,logout', 'legacy-primary', true, false, 'logout'],
    ['page:login', 'legacy-primary', false, false, 'login'],
    ['page:render', 'legacy-primary', false, false, undefined],
  ])('%s in %s mode', (routeKey, mode, legacyLogout, targetLogout, effect) => {
    expect(isLegacyLogout(routeKey, mode)).toBe(legacyLogout);
    expect(isTargetLogout(routeKey)).toBe(targetLogout);
    expect(legacySessionEffect(routeKey, mode, facts)).toBe(effect);
  });
});
