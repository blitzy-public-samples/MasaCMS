/** CSRF arbitration between legacy and target requests: the legacy token formula, single use across sides, the pending-legacy wait, the legacy ledger relay and the arbitration routes. */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyServiceUnavailableError, apiUnavailableResponse, cfHash, generateCsrfToken } from '@opt2/platform/legacy-compat';
import type { Clock, CsrfConsumeRequest, CsrfConsumeResponse, ServiceResponse } from '@opt2/platform/service-kit';
import { withTenant, type QueryResultRow } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock, mintUserToken } from '@opt2/platform/testing';
import {
  CSRF_USED_TTL_HOURS,
  PENDING_LEGACY_WAIT_MS,
  claimForLegacy,
  consumeToken,
  importUsedTokens,
  issueTokens,
  settleLegacy,
  usedTokensFor,
  type CsrfDeps,
} from '../../src/domain/csrf.js';
import { applyLogin, ensureSession } from '../../src/domain/sessions.js';
import { createBridgeRelay } from '../../src/legacy/bridge-relay.js';
import type { IdentityRepository } from '../../src/repo/repository.js';
import { CSRF_CLAIM, type SessionRow } from '../../src/repo/tables.js';
import { buildTestApp, createClientRecorder, headersFor, type ClientRecorder, type TestApp } from '../helpers/app.js';
import { createMemoryIdentityRepo, createRecordingDb, type MemoryIdentityRepo, type RecordingDb } from '../helpers/memory-repo.js';
import { ADMIN_S2, loginSnapshotFixture, sessionRow } from '../helpers/rows.js';

const SESSION_ID = 'S-1';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const HOUR_MS = 3_600_000;
const LOGIN = 'login';
const MARK_USED = '/internal/v1/legacy-sessions/{sid}:mark-used';
const REGISTRY_READ = /FROM identity\.tenant_registry\b/;
const REGISTRY_ROWS = [{ site_id: TENANT_A.siteId, tenant_id: TENANT_A.tenantId }];

/** A CSRF arbitration fixture: deps over the memory repository, its stores, the recorded gateway calls and the session secret. */
interface Seeded {
  deps: CsrfDeps;
  db: RecordingDb;
  repo: MemoryIdentityRepo;
  client: ClientRecorder;
  secret: string;
}

/** Logs ADMIN_S2 into session S-1 of tenant-a over the memory repository and returns its CSRF deps, stores and secret. */
async function seedSession(): Promise<Seeded> {
  const db = createRecordingDb();
  db.respond(REGISTRY_READ, REGISTRY_ROWS);
  const repo = createMemoryIdentityRepo({ sessions: [sessionRow({ session_id: SESSION_ID })] }, { clock: CLOCK });
  const login = await applyLogin(
    { db, repo, clock: CLOCK },
    { sessionId: SESSION_ID, snapshot: loginSnapshotFixture({ actor: ADMIN_S2 }), mode: 'target-primary', siteId: TENANT_A.siteId },
  );
  expect(login.tenantId).toBe(TENANT_A.tenantId);
  const client = createClientRecorder();
  return { deps: { db, repo, bridge: createBridgeRelay(client), clock: CLOCK }, db, repo, client, secret: login.csrfSecret };
}

/** A consume request of session S-1 carrying the token issued for `context` under `secret` at `clock`. */
function consumeRequest(secret: string, context = LOGIN, clock: Clock = CLOCK): CsrfConsumeRequest {
  return { sessionId: SESSION_ID, ...issueTokens({ csrfSecret: secret }, { context, clock }), context };
}

/** `[token, state]` of every tenant-a claim the memory repository holds. */
function claimStates(repo: MemoryIdentityRepo): [string, string][] {
  return repo.rows(CSRF_CLAIM.table, TENANT_A.tenantId).map((row) => [row.token, row.state]);
}

/** Mark-used relays the gateway received. */
function relays(client: ClientRecorder) {
  return client.requestsTo('gateway', MARK_USED);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('legacy token formula', () => {
  it('issues the legacy hash of context, session secret and expiry, expiring 3 h after issue', async () => {
    const { secret } = await seedSession();
    const issued = issueTokens({ csrfSecret: secret }, { context: LOGIN, clock: CLOCK });

    expect(secret).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/);
    // ACF 2023 hash() defaults to SHA-256, and `now + timespan` drops the milliseconds dateAdd('l') adds back, so they
    // count once: the live oracle issues 64-hex tokens expiring exactly now + 3 h.
    expect(issued.expires).toBe('260630150000123');
    expect(issued.token).toBe(createHash('sha256').update(LOGIN + secret + issued.expires, 'utf8').digest('hex').toUpperCase());
    expect(issued.token).toBe(cfHash(LOGIN + secret + issued.expires));
    expect(issued).toEqual(generateCsrfToken({ context: LOGIN, secret, now: NOW }));
  });

  it('consumes a token once for its context, then refuses it', async () => {
    const { deps, repo, secret } = await seedSession();
    const request = consumeRequest(secret);

    expect(await consumeToken(deps, request)).toEqual({ valid: true });
    expect(await consumeToken(deps, request)).toEqual({ valid: false });
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
  });

  const REJECTED: ReadonlyArray<[string, (seeded: Seeded) => Promise<readonly [CsrfDeps, CsrfConsumeRequest]>]> = [
    ['an empty token', async ({ deps, secret }) => [deps, { ...consumeRequest(secret), token: '' }]],
    ['a token of another context', async ({ deps, secret }) => [deps, { ...consumeRequest(secret), context: 'cusers.update' }]],
    ['an expiry no later than now', async ({ deps, secret }) => [{ ...deps, clock: fixedClock(NOW.getTime() + 3 * HOUR_MS) }, consumeRequest(secret)]],
    [
      "a token of another session's secret",
      async ({ deps }) => {
        const other = await ensureSession(deps, { sessionId: 'S-2', mode: 'target-primary' });
        return [deps, consumeRequest(other.csrfSecret)];
      },
    ],
  ];

  it.each(REJECTED)('refuses %s without taking a claim or relaying', async (_label, build) => {
    const seeded = await seedSession();
    const [deps, request] = await build(seeded);

    expect(await consumeToken(deps, request)).toEqual({ valid: false });
    expect(claimStates(seeded.repo)).toEqual([]);
    expect(seeded.client.requests).toEqual([]);
  });

  it('accepts a token up to the millisecond before it expires', async () => {
    const { deps, secret } = await seedSession();

    expect(await consumeToken({ ...deps, clock: fixedClock(NOW.getTime() + 3 * HOUR_MS - 1) }, consumeRequest(secret))).toEqual({ valid: true });
  });

  it('accepts a lower-cased copy of a valid token and then refuses the original', async () => {
    const { deps, repo, secret } = await seedSession();
    const request = consumeRequest(secret);

    expect(await consumeToken(deps, { ...request, token: request.token.toLowerCase() })).toEqual({ valid: true });
    expect(await consumeToken(deps, request)).toEqual({ valid: false });
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
  });

  it('keeps a used token 3 h and purges it at the first validation after that', async () => {
    expect(CSRF_USED_TTL_HOURS).toBe(3);
    const { deps, repo, secret } = await seedSession();
    const first = consumeRequest(secret);
    await consumeToken(deps, first);

    const atLimit = fixedClock(NOW.getTime() + CSRF_USED_TTL_HOURS * HOUR_MS);
    const second = consumeRequest(secret, LOGIN, atLimit);
    expect(await consumeToken({ ...deps, clock: atLimit }, second)).toEqual({ valid: true });
    expect(claimStates(repo).map(([token]) => token).sort()).toEqual([first.token, second.token].sort());

    const past = fixedClock(atLimit.now().getTime() + 1);
    const third = consumeRequest(secret, LOGIN, past);
    expect(await consumeToken({ ...deps, clock: past }, third)).toEqual({ valid: true });
    expect(claimStates(repo).map(([token]) => token).sort()).toEqual([second.token, third.token].sort());
  });
});

/** A consume started now, whose answer reads undefined until it settles. */
function pendingConsume(deps: CsrfDeps, request: CsrfConsumeRequest): { promise: Promise<CsrfConsumeResponse>; answer: () => CsrfConsumeResponse | undefined } {
  let answer: CsrfConsumeResponse | undefined;
  const promise = consumeToken(deps, request).then((result) => (answer = result));
  return { promise, answer: () => answer };
}

/** The legacy used-token ledger view of session S-1 at NOW. */
function legacyLedger({ db, repo }: Seeded) {
  return withTenant(db, TENANT_A.tenantId, (tx) => usedTokensFor(repo, tx, SESSION_ID, NOW));
}

describe('single use across legacy and target requests', () => {
  it('lets exactly one of two concurrent target submissions consume a token', async () => {
    const { deps, repo, client, secret } = await seedSession();
    const inserts: string[] = [];
    const racing: IdentityRepository = {
      ...repo,
      async insertCsrfClaim(tx, claim, ctx) {
        const row = await repo.insertCsrfClaim(tx, claim, ctx);
        inserts.push(row === null ? 'conflict' : 'inserted');
        return row;
      },
    };
    const request = consumeRequest(secret);

    const results = await Promise.all([consumeToken({ ...deps, repo: racing }, request), consumeToken({ ...deps, repo: racing }, request)]);

    expect(results.filter((result) => result.valid)).toHaveLength(1);
    expect(inserts.sort()).toEqual(['conflict', 'inserted']);
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
    expect(relays(client)).toHaveLength(1);
  });

  it('holds a target consume behind a pending legacy claim and refuses it once legacy consumes the token', async () => {
    const { deps, repo, client, secret } = await seedSession();
    const request = consumeRequest(secret);
    expect(await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token })).toEqual({ state: 'pending-legacy' });
    expect(claimStates(repo)).toEqual([[request.token, 'pending-legacy']]);
    vi.useFakeTimers();

    const consume = pendingConsume(deps, request);
    await vi.advanceTimersByTimeAsync(PENDING_LEGACY_WAIT_MS / 2);
    expect(consume.answer()).toBeUndefined();

    expect(await settleLegacy(deps, { sessionId: SESSION_ID, consumed: [request.token], released: [] })).toEqual({ used: 1, released: 0 });
    await vi.advanceTimersByTimeAsync(PENDING_LEGACY_WAIT_MS / 10);

    expect(consume.answer()).toEqual({ valid: false });
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
    expect(relays(client)).toEqual([]);
  });

  it('lets a waiting target consume take a token legacy carried without consuming it', async () => {
    const { deps, repo, client, secret } = await seedSession();
    const request = consumeRequest(secret);
    await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token });
    vi.useFakeTimers();

    const consume = pendingConsume(deps, request);
    await vi.advanceTimersByTimeAsync(PENDING_LEGACY_WAIT_MS / 2);
    expect(consume.answer()).toBeUndefined();

    expect(await settleLegacy(deps, { sessionId: SESSION_ID, consumed: [], released: [request.token] })).toEqual({ used: 0, released: 1 });
    await vi.advanceTimersByTimeAsync(PENDING_LEGACY_WAIT_MS / 10);

    expect(consume.answer()).toEqual({ valid: true });
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
    expect(relays(client)).toHaveLength(1);
  });

  it('answers a consume held by an unsettled legacy claim invalid only once the 5 s wait runs out', async () => {
    expect(PENDING_LEGACY_WAIT_MS).toBe(5_000);
    const { deps, repo, client, secret } = await seedSession();
    const request = consumeRequest(secret);
    await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token });
    vi.useFakeTimers();

    const consume = pendingConsume(deps, request);
    await vi.advanceTimersByTimeAsync(PENDING_LEGACY_WAIT_MS - 1);
    expect(consume.answer()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(consume.answer()).toEqual({ valid: false });
    expect(claimStates(repo)).toEqual([[request.token, 'pending-legacy']]);
    expect(relays(client)).toEqual([]);
  });

  it('leaves a token usable when a legacy request carried it without validating it', async () => {
    const seeded = await seedSession();
    const { deps, secret } = seeded;
    const request = consumeRequest(secret);
    await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token });

    expect(await settleLegacy(deps, { sessionId: SESSION_ID, consumed: [], released: [request.token] })).toEqual({ used: 0, released: 1 });
    expect(await legacyLedger(seeded)).toEqual([]);
    expect(await consumeToken(deps, request)).toEqual({ valid: true });
    expect(await legacyLedger(seeded)).toEqual([{ token: request.token, usedAt: NOW }]);
  });

  // gateway/test/unit/csrf-continuity.test.ts drives the bypass selector; a bypassed request reaches identity with no claim or settle.
  it.each<[string, (seeded: Seeded, request: CsrfConsumeRequest) => Promise<void>]>([
    [
      'target',
      async ({ deps, repo, client }, request) => {
        expect(await consumeToken(deps, request)).toEqual({ valid: true });
        expect(claimStates(repo)).toEqual([[request.token, 'used']]);
        expect(relays(client)).toHaveLength(1);
        expect(await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token })).toEqual({ state: 'used' });
      },
    ],
    [
      'legacy',
      async (seeded, request) => {
        const { deps, client } = seeded;
        expect(await claimForLegacy(deps, { sessionId: SESSION_ID, token: request.token })).toEqual({ state: 'pending-legacy' });
        expect(await settleLegacy(deps, { sessionId: SESSION_ID, consumed: [request.token], released: [] })).toEqual({ used: 1, released: 0 });
        expect(await legacyLedger(seeded)).toEqual([{ token: request.token, usedAt: NOW }]);
        expect(await consumeToken(deps, request)).toEqual({ valid: false });
        expect(relays(client)).toEqual([]);
      },
    ],
  ])('keeps the token of an approvalaction bypass, which identity never sees, usable once on the %s side', async (_side, nextUse) => {
    const seeded = await seedSession();
    const request = consumeRequest(seeded.secret, 'approvalaction');

    expect(claimStates(seeded.repo)).toEqual([]);
    expect(await legacyLedger(seeded)).toEqual([]);
    await nextUse(seeded, request);
  });

  it('refuses tokens an adopted legacy session had already used', async () => {
    const { deps, db, repo, secret } = await seedSession();
    const first = consumeRequest(secret, 'cusers.update');
    const second = consumeRequest(secret, 'cperm.update');

    const imported = await withTenant(db, TENANT_A.tenantId, (tx) =>
      importUsedTokens(repo, tx, SESSION_ID, [
        { token: first.token, usedAt: NOW },
        { token: second.token.toLowerCase(), usedAt: NOW },
      ]),
    );

    expect(imported).toBe(2);
    expect(claimStates(repo).sort()).toEqual(
      [
        [first.token, 'used'],
        [second.token, 'used'],
      ].sort(),
    );
    expect(await consumeToken(deps, first)).toEqual({ valid: false });
    expect(await consumeToken(deps, second)).toEqual({ valid: false });
    expect(await consumeToken(deps, consumeRequest(secret, 'csettings.update'))).toEqual({ valid: true });
  });
});

describe('relay of consumed tokens to the legacy ledger', () => {
  it('marks a consumed token used in the legacy session before answering', async () => {
    const { deps, client, secret } = await seedSession();
    let relayed = false;
    client.on('gateway', 'POST', MARK_USED, (): ServiceResponse => {
      relayed = true;
      return { status: 204, headers: {}, body: undefined };
    });
    const request = consumeRequest(secret);

    const outcome = await consumeToken(deps, request).then((result) => ({ result, relayedFirst: relayed }));

    expect(outcome).toEqual({ result: { valid: true }, relayedFirst: true });
    expect(client.requests).toEqual([
      {
        service: 'gateway',
        method: 'POST',
        path: '/internal/v1/legacy-sessions/S-1:mark-used',
        json: { tokens: [{ token: request.token, usedAt: '2026-06-30T12:00:00' }] },
      },
    ]);
  });

  it('relays nothing for a refused consume', async () => {
    const { deps, client, secret } = await seedSession();
    const request = consumeRequest(secret);
    await consumeToken(deps, request);
    client.clear();

    expect(await consumeToken(deps, request)).toEqual({ valid: false });
    expect(await consumeToken(deps, { ...request, context: 'cusers.update' })).toEqual({ valid: false });
    expect(client.requests).toEqual([]);
  });

  it('fails the consume closed when the relay is unavailable and keeps the token used', async () => {
    const { deps, repo, client, secret } = await seedSession();
    const request = consumeRequest(secret);
    client.failNext('gateway', MARK_USED);

    const failed = consumeToken(deps, request);

    await expect(failed).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(failed).rejects.toMatchObject({ name: 'ServiceUnavailableError', service: 'gateway' });
    expect(claimStates(repo)).toEqual([[request.token, 'used']]);
    expect(await consumeToken(deps, request)).toEqual({ valid: false });
  });
});

const CONSUME = '/internal/v1/csrf/consume';
const CLAIMS = '/internal/v1/csrf/claims';
const SETTLE = '/internal/v1/csrf/claims:settle';
const SESSION_READ = /^SELECT \* FROM "identity"\."session" WHERE "?tenant_id"? = \$1 AND "?session_id"? = \$2\b/;
const CLAIM_INSERT = /^INSERT INTO "identity"\."csrf_claim" \(([^)]+)\) VALUES/;
const CLAIM_READ = /^SELECT (?:\*|state) FROM "identity"\."csrf_claim" WHERE "?tenant_id"? = \$1 AND "?session_id"? = \$2 AND "?token"? = \$3\b/;
const CLAIM_UPDATE = /^UPDATE "identity"\."csrf_claim" SET "state" = \$1, "used_at" = \$2 WHERE "tenant_id" = \$3 AND "session_id" = \$4 AND "token" = \$5\b/;
const CLAIM_DELETE = /^DELETE FROM "identity"\."csrf_claim" WHERE "tenant_id" = \$1 AND "session_id" = \$2 AND "token" = \$3\b/;

/** Serves the route app's session and `identity.csrf_claim` SQL on its recording database; a repeated claim key raises PostgreSQL's unique violation. */
function serveSessionLedger(db: RecordingDb, session: SessionRow): void {
  const claims = new Map<string, QueryResultRow>();
  const keyOf = (tenantId: unknown, sessionId: unknown, token: unknown): string => JSON.stringify([tenantId, sessionId, token]);
  db.respond(REGISTRY_READ, REGISTRY_ROWS);
  db.respond(SESSION_READ, (_sql, values) => (values[0] === session.tenant_id && values[1] === session.session_id ? [session] : []));
  db.respond(CLAIM_INSERT, (sql, values) => {
    const columns = (CLAIM_INSERT.exec(sql)?.[1] ?? '').split(',').map((column) => column.trim().replaceAll('"', ''));
    const row: QueryResultRow = Object.fromEntries(columns.map((column, i) => [column, values[i]]));
    const key = keyOf(row.tenant_id, row.session_id, row.token);
    if (claims.has(key)) throw Object.assign(new Error('duplicate key value violates unique constraint "csrf_claim_pkey"'), { code: '23505' });
    claims.set(key, row);
    return [{ ...row }];
  });
  db.respond(CLAIM_READ, (_sql, values) => {
    const row = claims.get(keyOf(values[0], values[1], values[2]));
    return row === undefined ? [] : [{ ...row }];
  });
  db.respond(CLAIM_UPDATE, (_sql, values) => {
    const row = claims.get(keyOf(values[2], values[3], values[4]));
    if (row === undefined) return [];
    Object.assign(row, { state: values[0], used_at: values[1] });
    return [{ ...row }];
  });
  db.respond(CLAIM_DELETE, (_sql, values) => {
    const key = keyOf(values[0], values[1], values[2]);
    const row = claims.get(key);
    claims.delete(key);
    return row === undefined ? [] : [row];
  });
}

describe('arbitration routes', () => {
  const session = sessionRow({
    session_id: SESSION_ID,
    user_id: ADMIN_S2.account.userid,
    login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: ADMIN_S2 })),
  });
  let t: TestApp;

  /** Headers of service `caller` relaying the verified user token of session S-1. */
  async function relayedBy(caller: string): Promise<Record<string, string>> {
    const userToken = await mintUserToken({ sub: ADMIN_S2.account.userid, sid: SESSION_ID, site: TENANT_A.siteId, roles: ['system-user', 's2'], s2: true });
    return { ...(await headersFor(`service:${caller}`)), authorization: `Bearer ${userToken}` };
  }

  /** The token request of session S-1 for `context` at the app's clock. */
  function tokenBody(context = LOGIN): CsrfConsumeRequest {
    return consumeRequest(session.csrf_secret, context, t.clock);
  }

  function post(url: string, headers: Record<string, string>, payload: object) {
    return t.app.inject({ method: 'POST', url, headers, payload });
  }

  beforeAll(async () => {
    t = await buildTestApp();
    await t.app.ready();
  });

  afterAll(async () => {
    await t?.app.close();
  });

  beforeEach(() => {
    t.db.clear();
    t.client.clear();
    serveSessionLedger(t.db, session);
  });

  it.each(['people', 'programs-sites', 'strategies-content'])('consumes a token once for service:%s', async (caller) => {
    const body = tokenBody();
    const headers = await relayedBy(caller);

    const first = await post(CONSUME, headers, body);
    const second = await post(CONSUME, headers, body);

    expect([first.statusCode, first.json()]).toEqual([200, { valid: true }]);
    expect([second.statusCode, second.json()]).toEqual([200, { valid: false }]);
    expect(t.client.markedUsed).toEqual([{ sid: SESSION_ID, tokens: [{ token: body.token, usedAt: '2026-06-30T12:00:00' }] }]);
  });

  it('claims tokens for the gateway and settles what legacy consumed and released', async () => {
    const gateway = await relayedBy('gateway');
    const consumed = tokenBody('cusers.update');
    const released = tokenBody('cperm.update');
    for (const claim of [consumed, released]) {
      const res = await post(CLAIMS, gateway, claim);
      expect([res.statusCode, res.json()]).toEqual([200, { state: 'pending-legacy' }]);
    }

    const settled = await post(SETTLE, gateway, { sessionId: SESSION_ID, consumed: [consumed.token], released: [released.token] });

    expect([settled.statusCode, settled.json()]).toEqual([200, { used: 1, released: 1 }]);
    expect((await post(CLAIMS, gateway, consumed)).json()).toEqual({ state: 'used' });
    const people = await relayedBy('people');
    expect((await post(CONSUME, people, consumed)).json()).toEqual({ valid: false });
    expect((await post(CONSUME, people, released)).json()).toEqual({ valid: true });
  });

  it.each([
    [CONSUME, 'e-signature'],
    [CLAIMS, 'finance'],
    [SETTLE, 'finance'],
  ])('refuses %s to service:%s before any handler runs', async (url, caller) => {
    const body = url === SETTLE ? { sessionId: SESSION_ID, consumed: [], released: [] } : tokenBody();

    const res = await post(url, await relayedBy(caller), body);

    expect(res.statusCode).toBe(403);
    expect(t.db.statements()).toEqual([]);
    expect(t.client.requests).toEqual([]);
  });

  it('answers the legacy 503 when the legacy ledger relay is unavailable', async () => {
    t.client.failNext('gateway', MARK_USED);

    const res = await post(CONSUME, await relayedBy('people'), tokenBody());

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailableResponse().body);
  });
});
