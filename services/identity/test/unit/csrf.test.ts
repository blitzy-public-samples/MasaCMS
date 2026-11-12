/** CSRF issue, consume, legacy claims and settlement against a throwaway `identity` schema: single use across sides, the pending-legacy wait, the legacy relay and the 3 h purge. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateCsrfToken } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, fixedClock, type Clock } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, tenantIdForSite, withMetadata, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  CSRF_USED_TTL_HOURS,
  PENDING_LEGACY_WAIT_MS,
  claimForLegacy,
  clearClaims,
  consumeToken,
  importUsedTokens,
  issueTokens,
  locateSession,
  settleLegacy,
  usedTokensFor,
  type CsrfDeps,
} from '../../src/domain/csrf.js';
import { ANONYMOUS_LOGIN_SNAPSHOT, applyLogin, endSession, type SessionDeps } from '../../src/domain/sessions.js';
import type { BridgeRelay, LegacyUsedToken } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import type { CsrfClaimRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const HOUR_MS = 3_600_000;
const SECRET = 'K0000000-0000-0000-0000000000000001';
const CONTEXT = 'cusers.update';
const TENANT_A = tenantIdForSite('tenant-a');
const USER = 'U0000000-0000-0000-0000000000000001';

/** Session effects that replace the session's CSRF secret. */
const SECRET_CHANGES: [string, (deps: SessionDeps, sessionId: string) => Promise<unknown>][] = [
  [
    'a login',
    (deps, sessionId) => applyLogin(deps, { sessionId, snapshot: { ...ANONYMOUS_LOGIN_SNAPSHOT, userid: USER }, mode: 'target-primary', siteId: 'tenant-a' }),
  ],
  ['a logout', (deps, sessionId) => endSession(deps, sessionId)],
];

describe('csrf token issue', () => {
  it('issues the platform formula token under the session secret', () => {
    const clock = fixedClock(NOW);
    expect(issueTokens({ csrfSecret: SECRET }, { context: 'login', clock })).toEqual(generateCsrfToken({ context: 'login', secret: SECRET, now: NOW }));
    expect(issueTokens({ csrfSecret: SECRET }, { clock })).toEqual(generateCsrfToken({ context: '', secret: SECRET, now: NOW }));
  });

  it('keeps used tokens 3 h and waits 5 s on a pending legacy claim', () => {
    expect(CSRF_USED_TTL_HOURS).toBe(3);
    expect(PENDING_LEGACY_WAIT_MS).toBe(5_000);
  });
});

/** A relay that records each mark-used call, or fails as an unavailable gateway. */
function recordingRelay(fail = false): BridgeRelay & { calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] } {
  const calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] = [];
  return {
    calls,
    async markUsed(sessionId, tokens) {
      if (fail) throw new ServiceUnavailableError('gateway', Object.assign(new Error('gateway answered HTTP 503'), { code: 'HTTP_503' }));
      calls.push({ sessionId, tokens });
      return { applied: true };
    },
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('csrf arbitration against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let now: Date;
  let sessionSeq = 0;
  const clock: Clock = { now: () => new Date(now.getTime()) };

  function inTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(handle.app, tenantId, fn);
  }

  function depsFor(bridge: BridgeRelay = recordingRelay(), sleep?: (ms: number) => Promise<void>): CsrfDeps {
    return { db: handle.app, repo, bridge, clock, ...(sleep === undefined ? {} : { sleep }) };
  }

  /** Inserts an active session with the test secret in `tenantId` and returns its id. */
  async function newSession(tenantId = SYSTEM_TENANT_ID, state: 'active' | 'ended' = 'active'): Promise<string> {
    sessionSeq += 1;
    const sessionId = `S-${sessionSeq}`;
    await inTenant(tenantId, (tx) => repo.insertSession(tx, { session_id: sessionId, csrf_secret: SECRET, mode: 'target-primary', state }));
    return sessionId;
  }

  function sessionDeps(): SessionDeps {
    return { db: handle.app, repo, clock };
  }

  function claims(sessionId: string, tenantId = SYSTEM_TENANT_ID): Promise<CsrfClaimRow[]> {
    return inTenant(tenantId, (tx) => repo.listCsrfClaims(tx, sessionId));
  }

  function consumeRequest(sessionId: string): { sessionId: string; token: string; expires: string; context: string } {
    const { token, expires } = issueTokens({ csrfSecret: SECRET }, { context: CONTEXT, clock });
    return { sessionId, token, expires, context: CONTEXT };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)`, [
        'tenant-a',
        TENANT_A,
        NOW,
      ]),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    now = NOW;
  });

  it('consumes a token once, marking it used in the legacy ledger before answering', async () => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);

    let markedFirst = false;
    const first = await consumeToken(depsFor(relay), request).then((result) => {
      markedFirst = relay.calls.length === 1;
      return result;
    });

    expect(first).toEqual({ valid: true });
    expect(markedFirst).toBe(true);
    expect(relay.calls).toEqual([{ sessionId, tokens: [{ token: request.token, usedAt: NOW }] }]);
    expect(await claims(sessionId)).toMatchObject([{ token: request.token.toUpperCase(), state: 'used', used_at: NOW }]);
    expect(await consumeToken(depsFor(relay), request)).toEqual({ valid: false });
    expect(await consumeToken(depsFor(relay), { ...request, token: request.token.toLowerCase() })).toEqual({ valid: false });
    expect(relay.calls).toHaveLength(1);
  });

  it('accepts a lower-cased copy of a valid token and relays it as submitted', async () => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);

    expect(await consumeToken(depsFor(relay), { ...request, token: request.token.toLowerCase() })).toEqual({ valid: true });
    expect(relay.calls[0]?.tokens).toEqual([{ token: request.token.toLowerCase(), usedAt: NOW }]);
  });

  it.each([
    ['a wrong context', (r: ReturnType<typeof consumeRequest>) => ({ ...r, context: 'cusers.delete' })],
    ['an empty token', (r: ReturnType<typeof consumeRequest>) => ({ ...r, token: '' })],
    ['another secret', (r: ReturnType<typeof consumeRequest>) => ({ ...r, token: generateCsrfToken({ context: CONTEXT, secret: 'OTHER', now: NOW }).token })],
  ])('rejects %s without taking a claim or relaying', async (_label, alter) => {
    const relay = recordingRelay();
    const sessionId = await newSession();

    expect(await consumeToken(depsFor(relay), alter(consumeRequest(sessionId)))).toEqual({ valid: false });
    expect(await claims(sessionId)).toEqual([]);
    expect(relay.calls).toEqual([]);
  });

  it('rejects an expired token, an ended session and an unknown session', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    now = new Date(NOW.getTime() + CSRF_USED_TTL_HOURS * HOUR_MS + 1);
    expect(await consumeToken(depsFor(), request)).toEqual({ valid: false });

    now = NOW;
    const ended = await newSession(SYSTEM_TENANT_ID, 'ended');
    expect(await consumeToken(depsFor(), { ...request, sessionId: ended })).toEqual({ valid: false });
    expect(await consumeToken(depsFor(), { ...request, sessionId: 'S-unknown' })).toEqual({ valid: false });
    expect(await claims(sessionId)).toEqual([]);
  });

  it('locates sessions in the system tenant and in registered tenants', async () => {
    const anonymous = await newSession();
    const member = await newSession(TENANT_A);

    expect((await locateSession(depsFor(), anonymous))?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(await locateSession(depsFor(), member)).toMatchObject({ tenantId: TENANT_A, row: { session_id: member, csrf_secret: SECRET } });
    expect(await locateSession(depsFor(), 'S-unknown')).toBeUndefined();
    expect(await consumeToken(depsFor(), consumeRequest(member))).toEqual({ valid: true });
    expect(await claims(member, TENANT_A)).toHaveLength(1);
  });

  it('lets exactly one of several concurrent target submissions consume a token', async () => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);

    const results = await Promise.all(Array.from({ length: 4 }, () => consumeToken(depsFor(relay), request)));

    expect(results.filter((result) => result.valid)).toHaveLength(1);
    expect(relay.calls).toHaveLength(1);
  });

  it('holds a target consume on a pending legacy claim until legacy consumes the token', async () => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    expect(await claimForLegacy(depsFor(), { sessionId, token: request.token })).toEqual({ state: 'pending-legacy' });
    expect(await claimForLegacy(depsFor(), { sessionId, token: request.token })).toEqual({ state: 'pending-legacy' });

    const slept: number[] = [];
    const settleDuringWait = async (ms: number): Promise<void> => {
      slept.push(ms);
      if (slept.length === 2) {
        expect(await settleLegacy(depsFor(), { sessionId, consumed: [request.token], released: [] })).toEqual({ used: 1, released: 0 });
      }
    };

    expect(await consumeToken(depsFor(relay, settleDuringWait), request)).toEqual({ valid: false });
    expect(slept).toEqual([100, 100]);
    expect(await claims(sessionId)).toMatchObject([{ state: 'used' }]);
    expect(relay.calls).toEqual([]);
    expect(await claimForLegacy(depsFor(), { sessionId, token: request.token })).toEqual({ state: 'used' });
  });

  it('lets a waiting target consume take a token legacy released', async () => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    await claimForLegacy(depsFor(), { sessionId, token: request.token });

    const releaseDuringWait = async (): Promise<void> => {
      expect(await settleLegacy(depsFor(), { sessionId, consumed: [], released: [request.token.toLowerCase()] })).toEqual({ used: 0, released: 1 });
    };

    expect(await consumeToken(depsFor(relay, releaseDuringWait), request)).toEqual({ valid: true });
    expect(relay.calls).toHaveLength(1);
    expect(await claims(sessionId)).toMatchObject([{ state: 'used' }]);
  });

  it.each(SECRET_CHANGES)('rejects a token of the old secret when %s commits after the consume found the session', async (_label, change) => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    let changed = false;
    const racing: IdentityRepository = {
      ...repo,
      async findSession(tx, id) {
        const row = await repo.findSession(tx, id);
        if (!changed && row !== null) {
          changed = true;
          await change(sessionDeps(), id);
        }
        return row;
      },
    };

    expect(await consumeToken({ ...depsFor(relay), repo: racing }, request)).toEqual({ valid: false });
    expect(changed).toBe(true);
    expect(await claims(sessionId)).toEqual([]);
    expect(relay.calls).toEqual([]);
  });

  it.each(SECRET_CHANGES)('answers invalid when %s commits while the consume waits on a pending legacy claim', async (_label, change) => {
    const relay = recordingRelay();
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    await claimForLegacy(depsFor(), { sessionId, token: request.token });

    const slept: number[] = [];
    const changeDuringWait = async (ms: number): Promise<void> => {
      slept.push(ms);
      // The change also drops the pending claim, which leaves the token unclaimed.
      if (slept.length === 1) await change(sessionDeps(), sessionId);
    };

    expect(await consumeToken(depsFor(relay, changeDuringWait), request)).toEqual({ valid: false });
    expect(slept).toEqual([100]);
    expect(await claims(sessionId)).toEqual([]);
    expect(relay.calls).toEqual([]);
  });

  it('answers invalid once the pending legacy wait runs out', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    await claimForLegacy(depsFor(), { sessionId, token: request.token });

    const slept: number[] = [];
    const record = async (ms: number): Promise<void> => {
      slept.push(ms);
    };

    expect(await consumeToken(depsFor(recordingRelay(), record), request)).toEqual({ valid: false });
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(PENDING_LEGACY_WAIT_MS);
    expect(await claims(sessionId)).toMatchObject([{ state: 'pending-legacy' }]);
  });

  it('waits on the timer by default', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    await claimForLegacy(depsFor(), { sessionId, token: request.token });

    const consumed = consumeToken(depsFor(), request);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settleLegacy(depsFor(), { sessionId, consumed: [], released: [request.token] });

    expect(await consumed).toEqual({ valid: true });
  });

  it('leaves a token usable on both sides when legacy carried it without validating', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    await claimForLegacy(depsFor(), { sessionId, token: request.token });

    expect(await settleLegacy(depsFor(), { sessionId, consumed: [], released: [request.token] })).toEqual({ used: 0, released: 1 });
    expect(await inTenant(SYSTEM_TENANT_ID, (tx) => usedTokensFor(repo, tx, sessionId, NOW))).toEqual([]);
    expect(await consumeToken(depsFor(), request)).toEqual({ valid: true });
  });

  it('records consumed tokens without claims, never releases used ones, and ignores unknown sessions', async () => {
    const sessionId = await newSession();

    expect(await settleLegacy(depsFor(), { sessionId, consumed: ['aa', 'AA', 'bb'], released: ['bb', 'cc'] })).toEqual({ used: 2, released: 0 });
    expect((await claims(sessionId)).map((row) => [row.token, row.state])).toEqual([
      ['AA', 'used'],
      ['BB', 'used'],
    ]);
    expect(await settleLegacy(depsFor(), { sessionId, consumed: ['aa'], released: ['bb'] })).toEqual({ used: 0, released: 0 });
    expect(await claims(sessionId)).toHaveLength(2);
    expect(await settleLegacy(depsFor(), { sessionId: 'S-unknown', consumed: ['aa'], released: [] })).toEqual({ used: 0, released: 0 });
    expect(await claimForLegacy(depsFor(), { sessionId: 'S-unknown', token: 'aa' })).toEqual({ state: 'pending-legacy' });
  });

  it('settles crossed claims of concurrent legacy requests without deadlock or a released used token', async () => {
    const sessionId = await newSession(TENANT_A);
    await claimForLegacy(depsFor(), { sessionId, token: 'abc' });
    await claimForLegacy(depsFor(), { sessionId, token: 'def' });

    const results = await Promise.all([
      settleLegacy(depsFor(), { sessionId, consumed: ['ABC'], released: ['def'] }),
      settleLegacy(depsFor(), { sessionId, consumed: ['def'], released: ['abc'] }),
    ]);

    expect(results.reduce((sum, result) => sum + result.used, 0)).toBe(2);
    expect((await claims(sessionId, TENANT_A)).map((row) => [row.token, row.state]).sort()).toEqual([
      ['ABC', 'used'],
      ['DEF', 'used'],
    ]);
  });

  it('keeps the token consumed and fails closed when the legacy relay is unavailable', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);

    await expect(consumeToken(depsFor(recordingRelay(true)), request)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(await claims(sessionId)).toMatchObject([{ state: 'used' }]);
    expect(await consumeToken(depsFor(), request)).toEqual({ valid: false });
  });

  it('imports, lists and clears used tokens, and purges entries used over 3 h before a validation', async () => {
    const sessionId = await newSession();
    const request = consumeRequest(sessionId);
    const stale = new Date(NOW.getTime() - CSRF_USED_TTL_HOURS * HOUR_MS - 1);
    await claimForLegacy(depsFor(), { sessionId, token: 'zz' });

    const imported = await inTenant(SYSTEM_TENANT_ID, (tx) =>
      importUsedTokens(repo, tx, sessionId, [
        { token: request.token, usedAt: NOW },
        { token: request.token.toLowerCase(), usedAt: stale },
        { token: 'old', usedAt: stale },
        { token: 'ZZ', usedAt: NOW },
      ]),
    );
    expect(imported).toBe(3);
    expect(await inTenant(SYSTEM_TENANT_ID, (tx) => importUsedTokens(repo, tx, sessionId, [{ token: request.token, usedAt: NOW }]))).toBe(0);
    expect(await inTenant(SYSTEM_TENANT_ID, (tx) => usedTokensFor(repo, tx, sessionId, NOW))).toEqual([
      { token: 'ZZ', usedAt: NOW },
      { token: request.token.toUpperCase(), usedAt: NOW },
    ].sort((a, b) => (a.token < b.token ? -1 : 1)));

    expect(await consumeToken(depsFor(), request)).toEqual({ valid: false });
    expect((await claims(sessionId)).map((row) => row.token)).not.toContain('OLD');

    now = new Date(NOW.getTime() + CSRF_USED_TTL_HOURS * HOUR_MS + 1);
    const later = consumeRequest(sessionId);
    expect(await consumeToken(depsFor(), later)).toEqual({ valid: true });
    expect((await claims(sessionId)).map((row) => row.token)).toEqual([later.token.toUpperCase()]);
    expect(await inTenant(SYSTEM_TENANT_ID, (tx) => clearClaims(repo, tx, sessionId))).toBe(1);
    expect(await claims(sessionId)).toEqual([]);
  });
});
