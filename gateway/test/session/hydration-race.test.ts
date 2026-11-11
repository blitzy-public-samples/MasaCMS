// Hydration, logout and the jar lock across gateway instances, against a PostgreSQL gateway.legacy_jar.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMetadata } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import type {
  BridgeCallOptions,
  BridgeClient,
  BridgeResult,
  HydrateResult,
  LegacyCookies,
  LegacyDescribe,
} from '../../src/session/bridge-client.js';
import { createHydrator, type Hydrator, type HydratorOptions } from '../../src/session/hydration.js';
import type { AdoptedSession, IdentityClient, SessionSnapshot } from '../../src/session/identity-client.js';
import { createInvalidation, type InvalidationOptions } from '../../src/session/invalidation.js';
import { createLegacyJar, type JarCookies, type JarUpsert, type LegacyJar } from '../../src/session/jar.js';
import { createSessionResolver } from '../../src/session/resolve.js';
import type { SessionStateChecker } from '../../src/session/state-check.js';

const SESSION_ID = 'identity-session-race';
const EPOCH = 3;
const NATIVE_ID = 'OPT2RACE_NATIVE';
const NATIVE_COOKIES: JarCookies = { CFID: { name: 'CFID', value: 'native', attributes: 'path=/;HttpOnly;' } };

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** `op=describe` of a logged-in ColdFusion session. */
function describeBody(sessionId: string): LegacyDescribe {
  return {
    sessionId,
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
    memberships: 'Admin;default;0',
    membershipIds: '',
    csrfSecretKey: 'CSRF-SECRET-RACE',
    usedTokens: [],
    siteId: 'default',
    serverTime: '',
  };
}

/** A target-primary jar of `sessionId` holding the native session. */
const nativeJar = (sessionId: string): JarUpsert => ({
  sessionId,
  legacySessionId: NATIVE_ID,
  cookies: NATIVE_COOKIES,
  mode: 'target-primary',
  hydratedEpoch: 1,
});

const live = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** A ColdFusion double: sessions keyed by CFID, created by describe or hydrate when the cookies attach none. */
class LegacyDouble {
  readonly sessions = new Map<string, { sessionId: string; loggedIn: boolean }>();
  readonly calls: string[] = [];
  /** Held open by a test to keep a hydration inside `op=hydrate`. */
  hydrateGate: Promise<void> = Promise.resolve();
  /** Resolves once `op=hydrate` has been entered. */
  hydrating: Promise<void>;
  private enteredHydrate!: () => void;
  private next = 1000;

  constructor() {
    this.hydrating = new Promise((resolve) => {
      this.enteredHydrate = resolve;
    });
  }

  private cfid(cookies: LegacyCookies): string | undefined {
    const value = cookies.CFID;
    return typeof value === 'string' ? value : value?.value;
  }

  /** The session the cookies attach, or a new one whose cookies ColdFusion sets. */
  private attach(cookies: LegacyCookies): { cfid: string; setCookies: string[] } {
    const cfid = this.cfid(cookies);
    if (cfid !== undefined && this.sessions.has(cfid)) return { cfid, setCookies: [] };
    const created = String((this.next += 1));
    this.sessions.set(created, { sessionId: `OPT2RACE_${created}`, loggedIn: false });
    return { cfid: created, setCookies: [`CFID=${created};path=/;HttpOnly;`, `CFTOKEN=T${created};path=/;HttpOnly;`] };
  }

  readonly bridge: Pick<BridgeClient, 'describe' | 'hydrate' | 'end'> = {
    describe: (cookies) => {
      this.calls.push('describe');
      const { cfid, setCookies } = this.attach(cookies);
      const session = this.sessions.get(cfid) as { sessionId: string; loggedIn: boolean };
      const body = { sessionId: session.sessionId, isLoggedIn: session.loggedIn } as LegacyDescribe;
      return Promise.resolve({ body, setCookies });
    },
    hydrate: async (cookies, _body, call?: BridgeCallOptions): Promise<BridgeResult<HydrateResult>> => {
      this.calls.push('hydrate');
      this.enteredHydrate();
      await this.hydrateGate;
      const { cfid, setCookies } = this.attach(cookies);
      const session = this.sessions.get(cfid) as { sessionId: string; loggedIn: boolean };
      if (this.cfid(cookies) !== undefined && call?.legacySessionId !== session.sessionId) {
        throw new Error('409 sessionMismatch');
      }
      session.loggedIn = true;
      return { body: { sessionId: session.sessionId, hydrated: true, serverTime: '' }, setCookies };
    },
    end: (cookies, call) => {
      this.calls.push('end');
      const cfid = this.cfid(cookies);
      if (cfid === undefined || this.sessions.get(cfid)?.sessionId !== call.legacySessionId) {
        return Promise.reject(new Error('409 sessionMismatch'));
      }
      this.sessions.delete(cfid);
      return Promise.resolve({ body: { ended: true, serverTime: '' }, setCookies: [] });
    },
  };
}

/** Identity double: one session whose snapshot reads as missing once it has ended. */
function identityDouble() {
  const state = { ended: false };
  const snapshot: SessionSnapshot = {
    sessionId: SESSION_ID,
    epoch: EPOCH,
    loginSnapshot: { user: { userID: 'USER-0001', username: 'admin', isLoggedIn: true }, roles: ['Admin;default;0'] },
    csrfSecretKey: 'CSRF-SECRET-RACE',
    usedTokens: [],
  };
  return {
    state,
    client: {
      snapshot: () => Promise.resolve(state.ended ? undefined : snapshot),
      adopt: () => Promise.reject(new Error('no adoption in these cases')),
      end: () => Promise.resolve({ ended: true as const, epoch: EPOCH + 1 }),
    } satisfies HydratorOptions['identity'] & InvalidationOptions['identity'],
  };
}

describe.skipIf(!live)('hydration and logout across instances over one PostgreSQL jar', () => {
  let handle: ThrowawaySchema | undefined;
  let jar: LegacyJar;
  let clearJars: () => Promise<unknown>;

  beforeAll(async () => {
    const created = await createThrowawaySchema({
      service: 'gateway',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    handle = created;
    jar = createLegacyJar(created.app);
    clearJars = () => withMetadata(created.app, (tx) => tx.query(`DELETE FROM ${created.schema}.legacy_jar`));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await clearJars();
  });

  /** A gateway instance's hydrator: its own in-process state over the shared jar, legacy and identity. */
  function instance(legacy: LegacyDouble, identity: ReturnType<typeof identityDouble>): Hydrator {
    const barrier = { awaitOwners: () => Promise.resolve() };
    return createHydrator({ identity: identity.client, bridge: legacy.bridge, jar, barrier });
  }

  it('lets exactly one of two instances hydrate a session that has no jar yet', async () => {
    const legacy = new LegacyDouble();
    legacy.hydrateGate = new Promise((resolve) => setTimeout(resolve, 150));
    const identity = identityDouble();

    const [first, second] = await Promise.all([
      instance(legacy, identity).ensureHydrated(SESSION_ID, EPOCH),
      instance(legacy, identity).ensureHydrated(SESSION_ID, EPOCH),
    ]);

    expect(legacy.calls.filter((call) => call === 'hydrate')).toHaveLength(1);
    expect(legacy.sessions.size).toBe(1);
    expect(first).toMatchObject({ hydratedEpoch: EPOCH, mode: 'target-primary' });
    expect(second).toEqual(first);
    await expect(jar.get(SESSION_ID)).resolves.toEqual(first);
  });

  it('ends the legacy session and leaves no jar when a target logout arrives during a hydration', async () => {
    const legacy = new LegacyDouble();
    let release!: () => void;
    legacy.hydrateGate = new Promise((resolve) => {
      release = resolve;
    });
    const identity = identityDouble();
    const invalidation = createInvalidation({
      identity: identity.client,
      bridge: legacy.bridge,
      jar,
      tokenCache: { drop() {} },
      state: { forget() {} },
    });

    const hydration = instance(legacy, identity).ensureHydrated(SESSION_ID, EPOCH);
    await legacy.hydrating;
    identity.state.ended = true;
    const logout = invalidation.afterTargetLogout(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(legacy.calls).not.toContain('end');

    release();
    await expect(hydration).resolves.toMatchObject({ hydratedEpoch: EPOCH });
    await logout;

    expect(legacy.calls).toEqual(['hydrate', 'end']);
    expect(legacy.sessions.size).toBe(0);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(instance(legacy, identity).ensureHydrated(SESSION_ID, EPOCH)).resolves.toBeUndefined();
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
  });

  it('holds an adoption of a native session until its target-primary holder hydrated it, then describes', async () => {
    await jar.upsert(nativeJar('T-holder'));
    const entered = deferred();
    const release = deferred();
    const ops: string[] = [];
    const bridge = {
      describe: () => {
        ops.push('describe');
        return Promise.resolve({ body: describeBody(NATIVE_ID), setCookies: [] });
      },
      hydrate: async () => {
        ops.push('hydrate');
        entered.resolve();
        await release.promise;
        return { body: { sessionId: NATIVE_ID, hydrated: true, serverTime: '' }, setCookies: [] };
      },
    } as unknown as BridgeClient;
    const adopted: AdoptedSession = { sessionId: 'L-adopted', epoch: 1, setCookie: [] };
    const identity = {
      snapshot: () =>
        Promise.resolve({
          sessionId: 'T-holder',
          epoch: 2,
          loginSnapshot: { user: { userID: 'USER-0001' }, roles: ['Admin;default;0'] },
          csrfSecretKey: 'CSRF-SECRET-RACE',
          usedTokens: [],
        }),
      adopt: () => {
        ops.push('adopt');
        return Promise.resolve(adopted);
      },
    } as unknown as IdentityClient;
    const state: SessionStateChecker = {
      check: () => Promise.resolve({ state: 'ended', epoch: 0, userId: '', siteId: '', epochChanged: false }),
      forget() {},
    };
    const hydration = createHydrator({ identity, bridge, jar, barrier: { awaitOwners: () => Promise.resolve() } })
      .ensureHydrated('T-holder', 2);
    await entered.promise;

    let settled = false;
    const adoption = createSessionResolver({ identity, bridge, jar, state })
      .resolveSession(
        { path: '/admin/', httpMethod: 'GET', headers: { cookie: 'CFID=native' }, query: {}, params: {} },
        { family: 'admin', mode: 'legacy-primary' },
      )
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    expect(ops).toEqual(['describe', 'hydrate', 'describe']);

    release.resolve();
    await expect(hydration).resolves.toMatchObject({
      sessionId: 'T-holder',
      legacySessionId: NATIVE_ID,
      hydratedEpoch: 2,
    });
    await expect(adoption).resolves.toMatchObject({ kind: 'session', sessionId: 'L-adopted', mode: 'legacy-primary' });
    expect(ops).toEqual(['describe', 'hydrate', 'describe', 'describe', 'adopt']);
    await expect(jar.get('T-holder')).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId(NATIVE_ID)).resolves.toMatchObject({
      sessionId: 'L-adopted',
      mode: 'legacy-primary',
    });
  });

  it('lets a legacy login rebinding its session and a concurrent reversal of that session both commit', async () => {
    await jar.upsert(nativeJar('Z-old'));
    const insideAdopt = deferred();
    const finishAdopt = deferred();
    const invalidation = createInvalidation({
      identity: {
        adopt: async () => {
          insideAdopt.resolve();
          await finishAdopt.promise;
          return { sessionId: 'A-new', epoch: 2, setCookie: [] };
        },
        end: () => Promise.reject(new Error('no logout here')),
      },
      bridge: {
        describe: () => Promise.resolve({ body: describeBody(NATIVE_ID), setCookies: [] }),
        end: () => Promise.reject(new Error('no logout here')),
      },
      jar,
      tokenCache: { drop() {} },
      state: { forget() {} },
    });
    const settle = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

    const login = settle(invalidation.afterLegacyLogin('Z-old', 'target-primary'));
    await insideAdopt.promise;
    const reversed = { ...nativeJar('A-new'), mode: 'legacy-primary' as const, hydratedEpoch: null };
    const reversal = settle(jar.rebind(reversed, 'Z-old'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishAdopt.resolve();

    const [loggedIn, reversedRow] = await Promise.all([login, reversal]);
    expect(loggedIn).toEqual({ value: { sessionId: 'A-new', epoch: 2, setCookie: [] } });
    expect(reversedRow).toMatchObject({ value: { sessionId: 'A-new', mode: 'legacy-primary' } });
    await expect(jar.get('Z-old')).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId(NATIVE_ID)).resolves.toMatchObject({
      sessionId: 'A-new',
      mode: 'legacy-primary',
    });
  });

  it('leaves no jar when a target logout commits between the jar read and the absorb of a legacy response', async () => {
    await jar.upsert(nativeJar(SESSION_ID));
    const legacy = new LegacyDouble();
    legacy.sessions.set('native', { sessionId: NATIVE_ID, loggedIn: true });
    const identity = identityDouble();
    const invalidation = createInvalidation({
      identity: identity.client,
      bridge: legacy.bridge,
      jar,
      tokenCache: { drop() {} },
      state: { forget() {} },
    });
    // Another instance's logout commits right after the request read the jar.
    const racing: LegacyJar = {
      ...jar,
      get: async (sessionId) => {
        const row = await jar.get(sessionId);
        await invalidation.afterTargetLogout(sessionId);
        return row;
      },
    };
    const state: SessionStateChecker = {
      check: () =>
        Promise.resolve({ state: 'active', epoch: EPOCH, userId: 'USER-0001', siteId: 'default', epochChanged: false }),
      forget() {},
    };
    const resolver = createSessionResolver({
      identity: identity.client as unknown as IdentityClient,
      bridge: legacy.bridge as BridgeClient,
      jar: racing,
      state,
    });

    // Legacy re-set the jar's own CFID, so a stale write would also claim the ended native session.
    const resolution = await resolver.adoptAfterLegacy(
      {
        path: '/admin/',
        httpMethod: 'GET',
        headers: { cookie: `JSESSIONID=${SESSION_ID}; CFID=T-CFID` },
        query: {},
        params: {},
      },
      { mode: 'target-primary', setCookies: ['CFID=native;path=/;HttpOnly;', 'MXP=1;path=/;'] },
    );

    expect(resolution).toEqual({
      kind: 'session',
      sessionId: SESSION_ID,
      epoch: EPOCH,
      mode: 'target-primary',
      legacyCookies: {},
      setCookies: ['CFID=T-CFID;path=/;HttpOnly;', 'MXP=1;path=/;'],
    });
    expect(legacy.calls).toEqual(['end']);
    expect(legacy.sessions.size).toBe(0);
    await expect(jar.get(SESSION_ID)).resolves.toBeUndefined();
    await expect(jar.findByLegacySessionId(NATIVE_ID)).resolves.toBeUndefined();
  });
});
