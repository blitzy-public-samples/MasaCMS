// Hydration of a session's legacy ColdFusion session from identity's login snapshot.
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { fixedClock } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';
import type { BridgeResult, HydrateBody, HydrateResult } from '../../src/session/bridge-client.js';
import { HYDRATION_OWNERS, createHydrator, type HydratorOptions } from '../../src/session/hydration.js';
import type { SessionSnapshot } from '../../src/session/identity-client.js';
import type { JarCookie, JarCookies, JarRow } from '../../src/session/jar.js';

const NOW = new Date(2026, 5, 30, 12, 34, 56, 789);
const WIRE_NOW = '2026-06-30 12:34:56.789';
const WIRE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const SESSION_ID = 'identity-session-0001';
const LEGACY_SESSION_ID = 'OPT2TEST_1001_12345678';
const NEW_LEGACY_SESSION_ID = 'OPT2TEST_2002_87654321';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';
const TOKEN_A = 'A'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

const USER: Readonly<Record<string, unknown>> = {
  UserID: 'USER-0001',
  USERNAME: 'admin',
  siteid: 'default',
  password: 'stored-hash',
  fname: 'Admin',
  lname: 'User',
  email: 'admin@example.com',
  remoteID: '',
  company: 'Masa',
  lastlogin: '2026-06-30 11:00:00',
  passwordCreated: '2026-01-01 00:00:00',
  membershipIds: 'GROUP-1,USER-0001',
  groupID: 'GROUP-9',
  isLoggedIn: true,
};

const liveCookie = (name: string, value: string): JarCookie => ({ name, value, attributes: 'path=/;HttpOnly' });
const LIVE: JarCookies = { CFID: liveCookie('CFID', '1001'), CFTOKEN: liveCookie('CFTOKEN', '12345678') };
const DELETED: JarCookies = {
  JSESSIONID: liveCookie('JSESSIONID', ''),
  CFID: { name: 'CFID', value: '1001', attributes: 'path=/;expires=Thu, 01-Jan-1970 00:00:00 GMT' },
};

function jarRow(overrides: Partial<JarRow> = {}): JarRow {
  return {
    sessionId: SESSION_ID,
    legacySessionId: LEGACY_SESSION_ID,
    cookies: LIVE,
    mode: 'target-primary',
    hydratedEpoch: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function snapshotAt(epoch: number, user: Readonly<Record<string, unknown>> = USER): SessionSnapshot {
  return {
    sessionId: SESSION_ID,
    epoch,
    loginSnapshot: { user: { ...user }, roles: ['S2IsPrivate;default', 'S2', 'Admin;default;0'] },
    csrfSecretKey: 'CSRF-SECRET-0001',
    usedTokens: [TOKEN_A, TOKEN_B],
  };
}

type Call = [op: string, ...args: unknown[]];

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Stub identity, bridge, barrier and jar sharing one ordered call log. */
interface Harness {
  calls: Call[];
  rows: Map<string, JarRow>;
  /** Answers of successive snapshot reads; the last one repeats. */
  snapshots: Array<SessionSnapshot | undefined>;
  /** Waits of successive barrier calls; calls past the list pass at once. */
  gates: Array<Promise<void>>;
  answer: BridgeResult<HydrateResult>;
  options: HydratorOptions;
  ops(): string[];
}

function harness(row?: JarRow): Harness {
  const h: Harness = {
    calls: [],
    rows: new Map(row === undefined ? [] : [[row.sessionId, row]]),
    snapshots: [snapshotAt(3)],
    gates: [],
    answer: {
      body: { sessionId: LEGACY_SESSION_ID, hydrated: true, serverTime: WIRE_NOW },
      setCookies: ['JSESSIONID=node02new;path=/;HttpOnly', 'OTHER=1;path=/'],
    },
    options: undefined as unknown as HydratorOptions,
    ops: () => h.calls.map(([op]) => op),
  };
  h.options = {
    barrier: {
      async awaitOwners(owners) {
        h.calls.push(['barrier', owners]);
        await h.gates.shift();
      },
    },
    identity: {
      snapshot(sessionId) {
        h.calls.push(['identity.snapshot', sessionId]);
        return Promise.resolve(h.snapshots.length > 1 ? h.snapshots.shift() : h.snapshots[0]);
      },
    },
    bridge: {
      hydrate(cookies, body, call) {
        h.calls.push(['bridge.hydrate', cookies, body, call]);
        return Promise.resolve(h.answer);
      },
    },
    jar: {
      get(sessionId) {
        h.calls.push(['jar.get', sessionId]);
        return Promise.resolve(h.rows.get(sessionId));
      },
      upsert(input) {
        h.calls.push(['jar.upsert', input]);
        const stored = h.rows.get(input.sessionId);
        const next: JarRow = { ...input, cookies: { ...stored?.cookies, ...input.cookies }, updatedAt: NOW };
        h.rows.set(input.sessionId, next);
        return Promise.resolve(next);
      },
    },
    clock: fixedClock(NOW),
  };
  return h;
}

/** Arguments of the only call named `op`. */
function onlyCall(h: Harness, op: string): unknown[] {
  const matching = h.calls.filter(([name]) => name === op);
  expect(matching).toHaveLength(1);
  return (matching[0] as Call).slice(1);
}

describe('createHydrator', () => {
  it('awaits the identity and people barrier, reads the snapshot, hydrates and records the installed epoch', async () => {
    const h = harness(jarRow({ cookies: { ...LIVE, JSESSIONID: liveCookie('JSESSIONID', '') } }));
    const row = await createHydrator(h.options).ensureHydrated(SESSION_ID, 3, { userAgent: USER_AGENT });

    expect(HYDRATION_OWNERS).toEqual(['identity', 'people']);
    expect(h.ops()).toEqual(['jar.get', 'barrier', 'identity.snapshot', 'jar.get', 'bridge.hydrate', 'jar.upsert']);
    expect(h.calls[1]).toEqual(['barrier', ['identity', 'people']]);
    const [cookies, body, call] = onlyCall(h, 'bridge.hydrate');
    expect(cookies).toEqual(LIVE);
    expect(call).toEqual({ userAgent: USER_AGENT, legacySessionId: LEGACY_SESSION_ID });
    expect(body).toStrictEqual({
      snapshot: {
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
        memberships: 'S2IsPrivate;default,S2,Admin;default;0',
        membershipIds: 'GROUP-1,USER-0001',
      },
      csrfSecretKey: 'CSRF-SECRET-0001',
      usedTokens: [
        { token: TOKEN_A, usedAt: WIRE_NOW },
        { token: TOKEN_B, usedAt: WIRE_NOW },
      ],
    });
    expect(onlyCall(h, 'jar.upsert')).toEqual([
      {
        sessionId: SESSION_ID,
        legacySessionId: LEGACY_SESSION_ID,
        cookies: { JSESSIONID: { name: 'JSESSIONID', value: 'node02new', attributes: 'path=/;HttpOnly' } },
        mode: 'target-primary',
        hydratedEpoch: 3,
      },
    ]);
    expect(row).toEqual({
      ...jarRow({ hydratedEpoch: 3 }),
      cookies: { ...LIVE, JSESSIONID: { name: 'JSESSIONID', value: 'node02new', attributes: 'path=/;HttpOnly' } },
    });
  });

  it('makes no call beyond the jar read on a repeat at the same epoch and re-hydrates at a new epoch', async () => {
    const h = harness(jarRow());
    h.snapshots = [snapshotAt(3), snapshotAt(4)];
    const hydrator = createHydrator(h.options);
    await hydrator.ensureHydrated(SESSION_ID, 3);

    h.calls.length = 0;
    const repeated = await hydrator.ensureHydrated(SESSION_ID, 3);
    expect(h.ops()).toEqual(['jar.get']);
    expect(repeated?.hydratedEpoch).toBe(3);

    h.calls.length = 0;
    const rehydrated = await hydrator.ensureHydrated(SESSION_ID, 4);
    expect(h.ops()).toEqual(['jar.get', 'barrier', 'identity.snapshot', 'jar.get', 'bridge.hydrate', 'jar.upsert']);
    expect(rehydrated?.hydratedEpoch).toBe(4);
  });

  it.each<[string, number]>([
    ['the same epoch', 3],
    ['an older epoch', 2],
  ])('returns a target-primary row hydrated at %s without hydrating', async (_label, epoch) => {
    const stored = jarRow({ hydratedEpoch: 3 });
    const h = harness(stored);
    await expect(createHydrator(h.options).ensureHydrated(SESSION_ID, epoch)).resolves.toBe(stored);
    expect(h.ops()).toEqual(['jar.get']);
  });

  it.each<[string, JarRow | undefined]>([
    ['absent', undefined],
    ['in legacy-primary mode', jarRow({ mode: 'legacy-primary', hydratedEpoch: 5 })],
    ['never hydrated', jarRow({ hydratedEpoch: null })],
    ['hydrated at an older epoch', jarRow({ hydratedEpoch: 2 })],
  ])('hydrates when the jar row is %s', async (_label, row) => {
    const h = harness(row);
    const hydrated = await createHydrator(h.options).ensureHydrated(SESSION_ID, 3);
    expect(onlyCall(h, 'bridge.hydrate')).toHaveLength(3);
    expect(hydrated).toMatchObject({ mode: 'target-primary', hydratedEpoch: 3 });
  });

  it('records the epoch identity installed rather than the one the caller asked for', async () => {
    const h = harness(jarRow());
    h.snapshots = [snapshotAt(7)];
    await expect(createHydrator(h.options).ensureHydrated(SESSION_ID, 3)).resolves.toMatchObject({ hydratedEpoch: 7 });
  });

  it('propagates a barrier rejection without reading identity or calling the bridge, then hydrates on retry', async () => {
    const h = harness(jarRow());
    const refusal = new LegacyServiceUnavailableError();
    const gate = deferred();
    h.gates = [gate.promise];
    const hydrator = createHydrator(h.options);

    const refused = hydrator.ensureHydrated(SESSION_ID, 3);
    gate.reject(refusal);
    await expect(refused).rejects.toBe(refusal);
    expect(h.ops()).toEqual(['jar.get', 'barrier']);

    await expect(hydrator.ensureHydrated(SESSION_ID, 3)).resolves.toMatchObject({ hydratedEpoch: 3 });
    expect(h.ops().filter((op) => op === 'bridge.hydrate')).toHaveLength(1);
  });

  it('returns undefined without calling the bridge when identity reports the session missing or ended', async () => {
    const h = harness(jarRow());
    h.snapshots = [undefined];
    await expect(createHydrator(h.options).ensureHydrated(SESSION_ID, 3)).resolves.toBeUndefined();
    expect(h.ops()).toEqual(['jar.get', 'barrier', 'identity.snapshot']);
  });

  it.each<[string, JarRow | undefined, string, JarCookies, string | undefined, string | null]>([
    ['no jar row', undefined, NEW_LEGACY_SESSION_ID, {}, undefined, NEW_LEGACY_SESSION_ID],
    ['no jar row and no answered id', undefined, '', {}, undefined, null],
    ['a jar without a legacy session id', jarRow({ legacySessionId: null }), NEW_LEGACY_SESSION_ID, {}, undefined, NEW_LEGACY_SESSION_ID],
    ['a jar holding only deleted cookies', jarRow({ cookies: DELETED }), '', {}, undefined, LEGACY_SESSION_ID],
    ['a jar with live cookies', jarRow(), '', LIVE, LEGACY_SESSION_ID, LEGACY_SESSION_ID],
  ])(
    'with %s sends the live cookies of a known session and stores the answered or kept legacy id',
    async (_label, row, answered, sentCookies, sentSid, storedSid) => {
      const h = harness(row);
      h.answer = { body: { sessionId: answered, hydrated: true, serverTime: WIRE_NOW }, setCookies: [] };
      await createHydrator(h.options).ensureHydrated(SESSION_ID, 3);

      const [cookies, , call] = onlyCall(h, 'bridge.hydrate');
      expect(cookies).toStrictEqual(sentCookies);
      expect(call).toStrictEqual({ legacySessionId: sentSid });
      expect(onlyCall(h, 'jar.upsert')).toEqual([expect.objectContaining({ legacySessionId: storedSid, cookies: {} })]);
    },
  );

  it.each<[string, unknown, string]>([
    ['absent', undefined, 'Default'],
    ['a string', 'Admin', 'Admin'],
    ['a number', 7, '7'],
    ['a boolean', false, 'false'],
    ['an array', ['Admin'], 'Default'],
    ['null', null, 'Default'],
  ])('sends a snapshot subtype that is %s as describe text', async (_label, subtype, expected) => {
    const h = harness();
    h.snapshots = [snapshotAt(3, subtype === undefined ? USER : { ...USER, SubType: subtype })];
    await createHydrator(h.options).ensureHydrated(SESSION_ID, 3);
    const [, body] = onlyCall(h, 'bridge.hydrate');
    expect(body).toMatchObject({ snapshot: { user: { subtype: expected } } });
  });

  it('shares one hydration between concurrent calls for a session', async () => {
    const h = harness(jarRow());
    const gate = deferred();
    h.gates = [gate.promise];
    const hydrator = createHydrator(h.options);

    const first = hydrator.ensureHydrated(SESSION_ID, 3);
    const second = hydrator.ensureHydrated(SESSION_ID, 3);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(b).toBe(a);
    expect(h.ops().filter((op) => op === 'barrier' || op === 'bridge.hydrate')).toEqual(['barrier', 'bridge.hydrate']);
  });

  it('hydrates again for a caller whose joined hydration installed an older epoch', async () => {
    const h = harness(jarRow());
    const gate = deferred();
    h.gates = [gate.promise];
    h.snapshots = [snapshotAt(1), snapshotAt(2)];
    const hydrator = createHydrator(h.options);

    const older = hydrator.ensureHydrated(SESSION_ID, 1);
    const newer = hydrator.ensureHydrated(SESSION_ID, 2);
    gate.resolve();

    await expect(older).resolves.toMatchObject({ hydratedEpoch: 1 });
    await expect(newer).resolves.toMatchObject({ hydratedEpoch: 2 });
    expect(h.ops().filter((op) => op === 'bridge.hydrate')).toHaveLength(2);
  });

  it('answers every joined caller undefined, with one identity read, when the session is missing', async () => {
    const h = harness(jarRow());
    const gate = deferred();
    h.gates = [gate.promise];
    h.snapshots = [undefined];
    const hydrator = createHydrator(h.options);

    const calls = [hydrator.ensureHydrated(SESSION_ID, 3), hydrator.ensureHydrated(SESSION_ID, 3)];
    gate.resolve();

    await expect(Promise.all(calls)).resolves.toEqual([undefined, undefined]);
    expect(h.ops().filter((op) => op === 'identity.snapshot')).toHaveLength(1);
  });

  it('rejects every joined caller when the shared hydration fails', async () => {
    const h = harness(jarRow());
    const gate = deferred();
    h.gates = [gate.promise];
    const hydrator = createHydrator(h.options);
    const refusal = new LegacyServiceUnavailableError();

    const calls = [hydrator.ensureHydrated(SESSION_ID, 3), hydrator.ensureHydrated(SESSION_ID, 3)];
    gate.reject(refusal);

    await expect(Promise.allSettled(calls)).resolves.toEqual([
      { status: 'rejected', reason: refusal },
      { status: 'rejected', reason: refusal },
    ]);
    expect(h.ops()).not.toContain('bridge.hydrate');
  });

  it('stamps used tokens with the system clock when no clock is given', async () => {
    const h = harness(jarRow());
    await createHydrator({ ...h.options, clock: undefined }).ensureHydrated(SESSION_ID, 3);
    const { usedTokens } = onlyCall(h, 'bridge.hydrate')[1] as HydrateBody;
    expect(usedTokens.map((entry) => entry.token)).toEqual([TOKEN_A, TOKEN_B]);
    for (const { usedAt } of usedTokens) expect(usedAt).toMatch(WIRE_TIME);
  });
});
