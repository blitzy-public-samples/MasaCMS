// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Check order of the e-signature fixture routes through `app.inject`, against legacy-fixtures/cfml api.cfm, lib/auth.cfc, lib/envelope.cfc and modules/esignature.cfc. */
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { canonicalAt, hashToHex, nextEntry, type ChainEntry } from '../../src/domain/hash-chain.js';
import { FIXTURE_CHECK_ORDER, validateCreateInput, validateSignInput, validateSuppliedChain, type FixtureCheckStep } from '../../src/legacy/checks.js';
import { FIXTURE_ERROR_MAP, type FixtureErrorType } from '../../src/legacy/envelope.js';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { CSRF_HEADERS, TEST_CLOCK, buildTestApp, type TestApp } from '../helpers/app.js';
import { AUDITOR_USER_ID, OTHER_USER_ID, SIGNER_USER_ID, headersFor, userHeaders } from '../helpers/tokens.js';
import { CHAIN_VECTORS, chainEntries } from '../helpers/vectors.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;

/** A response with the writes its request committed. */
interface Sent {
  res: Injected;
  writes: readonly unknown[];
}

const REQUESTS = `${FIXTURE_PREFIX}/requests`;
// auth.cfc init() role group names.
const SIGNER = 'esignature.signer';
const AUDITOR = 'esignature.auditor';
const SYSTEM_USER = 'system-user';
const MEMBER = 'member';
const UNKNOWN_SITE = 'unknown-site';
/** A well-formed CF UUID no tenant holds. */
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const MALFORMED_ID = 'not-a-cf-uuid';
const [REQUEST_UNIT] = UNITS;
const DOCUMENT = Buffer.from('%PDF-1.7 synthetic check-order contract');
const DOCUMENT_SHA256 = createHash('sha256').update(DOCUMENT).digest('hex');
const CREATED = new Date(TEST_CLOCK.now().getTime() - 3_600_000);
/** The request every chain vector belongs to; it is seeded SIGNED with that chain. */
const SIGNED_ID = chainEntries()[0]?.request_id ?? '';
const VALID_CREATE = { documentName: 'contract.pdf', documentBase64: DOCUMENT.toString('base64'), signerUserId: SIGNER_USER_ID } as const;

/** What a failure injection changes in one sign; `session` is the caller: a user token, identity's anonymous token, or no user token. */
interface Probe {
  method: string;
  /** Path segments after the action; two more leave api.cfm's five-segment grammar. */
  extra: string;
  site: string;
  siteid?: string;
  session: 'user' | 'anonymous' | 'none';
  sub: string;
  roles: readonly string[];
  known: boolean;
  state: 'PENDING' | 'SIGNED';
  typedName: string;
}

/** The request's signer signing the PENDING request of tenant-a with a typed name: it passes every check. */
const BASELINE: Readonly<Probe> = Object.freeze({
  method: 'POST',
  extra: '',
  site: TENANT_A.siteId,
  session: 'user',
  sub: SIGNER_USER_ID,
  roles: [SYSTEM_USER, SIGNER],
  known: true,
  state: 'PENDING',
  typedName: 'Golden Signer',
});

// Each injection changes fields no other one changes, so any two compose by spreading.
const FAILURES: Readonly<Record<FixtureCheckStep, Partial<Probe>>> = Object.freeze({
  path: { extra: '/extra/segment' },
  // The gateway mints the token for the requested site, so the token and siteid name the same unknown site.
  site: { site: UNKNOWN_SITE, siteid: UNKNOWN_SITE },
  login: { session: 'anonymous' },
  role: { roles: [SYSTEM_USER] },
  existence: { known: false },
  validation: { typedName: ' \u00a0\u200b ' },
  state: { state: 'SIGNED' },
});

/** The error-map row and message the fixture answers a failed step with; a path outside the grammar has no fixture envelope. */
const ANSWERS: Readonly<Record<Exclude<FixtureCheckStep, 'path'>, { type: FixtureErrorType; message?: string }>> = Object.freeze({
  site: { type: 'invalidParameters' },
  login: { type: 'authorization' },
  role: { type: 'forbidden' },
  existence: { type: 'notFound' },
  validation: { type: 'invalidParameters' },
  // esignature.cfc signRequest raises conflict with this message when the guarded UPDATE finds no PENDING row.
  state: { type: 'conflict', message: 'already-signed' },
});

let t: TestApp;
let pendingId: string;

/** Seeds a PENDING request of SIGNER with its `created` entry, and SIGNED_ID with its signature and the vector chain, all in tenant-a. */
function seedRequests(app: TestApp): string {
  const id = cfUuid();
  const request = {
    tenant_id: TENANT_A.tenantId,
    siteid: TENANT_A.siteId,
    document_name: 'contract.pdf',
    document_sha256: DOCUMENT_SHA256,
    document: DOCUMENT,
    signer_user_id: SIGNER_USER_ID,
    created: CREATED,
    createdbyid: SIGNER_USER_ID,
  };
  app.db.seed('signature_request', [
    { ...request, request_id: id, state: 'PENDING' },
    { ...request, request_id: SIGNED_ID, state: 'SIGNED' },
  ]);
  const created = nextEntry(null, { requestId: id, action: 'created', actorUserId: SIGNER_USER_ID, detail: DOCUMENT_SHA256, at: CREATED });
  app.db.seed('audit_entry', [
    {
      tenant_id: TENANT_A.tenantId,
      entry_id: cfUuid(),
      request_id: id,
      seq: created.seq,
      action: 'created',
      actor_user_id: SIGNER_USER_ID,
      detail: DOCUMENT_SHA256,
      at: created.at,
      prev_hash: created.prev_hash,
      entry_hash: created.entry_hash,
    },
    ...chainEntries().map((entry) => ({ ...entry, at: entry.at as Date, tenant_id: TENANT_A.tenantId })),
  ]);
  app.db.seed('signature', [
    { tenant_id: TENANT_A.tenantId, signature_id: cfUuid(), request_id: SIGNED_ID, typed_name: 'Golden Signer', signer_user_id: SIGNER_USER_ID, signed_at: CREATED },
  ]);
  app.db.clear();
  return id;
}

beforeEach(async () => {
  t = await buildTestApp();
  pendingId = seedRequests(t);
  t.csrf.answer(true);
});

afterEach(async () => {
  await t.app.close();
});

/** Headers of `probe`'s caller; the anonymous session is identity's token for a session without a login. */
async function callerHeaders(probe: Pick<Probe, 'session' | 'sub' | 'site' | 'roles'>): Promise<Record<string, string>> {
  const headers = await userHeaders({ sub: probe.session === 'anonymous' ? '' : probe.sub, site: probe.site, roles: probe.roles });
  if (probe.session === 'none') delete headers.authorization;
  return headers;
}

/** The query string carrying `siteid`, or '' without one. */
function siteQuery(siteid: string | undefined): string {
  return siteid === undefined ? '' : `?siteid=${encodeURIComponent(siteid)}`;
}

/** Sends the baseline sign with `overrides` applied and returns the response with the writes it committed. */
async function sign(overrides: Partial<Probe> = {}): Promise<Sent> {
  const probe: Probe = { ...BASELINE, ...overrides };
  const id = probe.known ? (probe.state === 'SIGNED' ? SIGNED_ID : pendingId) : MISSING_ID;
  const res = await t.app.inject({
    method: probe.method as 'POST',
    url: `${REQUESTS}/${id}/sign${probe.extra}${siteQuery(probe.siteid)}`,
    headers: { ...(await callerHeaders(probe)), ...CSRF_HEADERS, 'content-type': 'application/json' },
    payload: { typedName: probe.typedName },
  });
  return { res, writes: t.db.writes() };
}

/** Sends `method` to `path` under REQUESTS as `caller`, with the CSRF pair and `body` for a POST. */
async function send(
  method: 'GET' | 'POST',
  path: string,
  caller: Partial<Pick<Probe, 'session' | 'sub' | 'site' | 'roles'>>,
  body?: Readonly<Record<string, unknown>>,
): Promise<Sent> {
  const headers = await callerHeaders({ ...BASELINE, ...caller });
  const res = await t.app.inject({
    method,
    url: `${REQUESTS}${path}`,
    headers: method === 'POST' ? { ...headers, ...CSRF_HEADERS, 'content-type': 'application/json' } : headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  return { res, writes: t.db.writes() };
}

/** The envelope.cfc `fail` body of `type` for `method`; an empty message answers the type's default. */
function failBody(type: FixtureErrorType, method: string, message?: string): Record<string, unknown> {
  const { code, message: fallback } = FIXTURE_ERROR_MAP[type];
  return { apiversion: 'v1', method, error: { code, message: message ?? fallback } };
}

/** Asserts the fixture answered `type` (with `message`, if given) for `method` and committed nothing. */
function expectFailure(sent: Sent, type: FixtureErrorType, method: string, message?: string): void {
  expect([sent.res.statusCode, sent.res.json()]).toStrictEqual([FIXTURE_ERROR_MAP[type].status, failBody(type, method, message)]);
  expect(sent.writes).toStrictEqual([]);
}

/** Asserts the answer of the earliest failed `step` of a sign. */
function expectStepAnswer(step: FixtureCheckStep, sent: Sent): void {
  if (step === 'path') {
    // No route serves a path outside the grammar, and no cut-over entry sends one to e-signature, so service-kit's 404 answers it.
    expect(sent.res.statusCode).toBe(404);
    expect(sent.writes).toStrictEqual([]);
    return;
  }
  const { type, message } = ANSWERS[step];
  expectFailure(sent, type, 'esignature.requests.sign', message);
}

describe('e-signature fixture check order', () => {
  it('orders the checks as api.cfm path and site, then auth.cfc login and role, then esignature.cfc existence, validation and state', () => {
    expect(FIXTURE_CHECK_ORDER).toEqual(['path', 'site', 'login', 'role', 'existence', 'validation', 'state']);
  });

  it('answers the baseline sign 200 with the SIGNED request, so each injection fails one check only', async () => {
    const { res, writes } = await sign();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ apiversion: 'v1', method: 'esignature.requests.sign', data: { request_id: pendingId, state: 'SIGNED' } });
    expect(writes).not.toHaveLength(0);
    expect(t.db.rows('signature', TENANT_A.tenantId).map((row) => [row.request_id.trim(), row.typed_name])).toContainEqual([pendingId, BASELINE.typedName]);
  });

  it.each(FIXTURE_CHECK_ORDER)('answers a failed %s check alone with its fixture error, writing nothing', async (step) => {
    expectStepAnswer(step, await sign(FAILURES[step]));
  });

  const pairs = FIXTURE_CHECK_ORDER.flatMap((earlier, i) => FIXTURE_CHECK_ORDER.slice(i + 1).map((later) => [earlier, later] as const));

  it.each(pairs)('answers the %s failure when the later %s check fails too', async (earlier, later) => {
    expectStepAnswer(earlier, await sign({ ...FAILURES[earlier], ...FAILURES[later] }));
  });

  it('answers a caller with only the gateway invocation credential 401, as requireLogin answers a session without a login', async () => {
    expectFailure(await sign({ session: 'none', siteid: TENANT_A.siteId }), 'authorization', 'esignature.requests.sign');
  });

  it('answers a caller presenting no credential at all 401 on a chain read', async () => {
    const res = await t.app.inject({ method: 'GET', url: `${REQUESTS}/${SIGNED_ID}/audit${siteQuery(TENANT_A.siteId)}`, headers: await headersFor('anonymous') });

    expectFailure({ res, writes: t.db.writes() }, 'authorization', 'esignature.requests.audit');
  });

  it('resolves siteid ignoring case to the registered site id, as the baseline resolves an omitted one to the token site', async () => {
    const explicit = await sign({ siteid: TENANT_A.siteId.toUpperCase() });

    expect(explicit.res.statusCode).toBe(200);
    expect(explicit.res.json()).toMatchObject({ data: { request_id: pendingId, siteid: TENANT_A.siteId } });
  });

  it('answers 404 for a resource esignature.cfc does not dispatch, writing nothing', async () => {
    const res = await t.app.inject({ method: 'GET', url: `${FIXTURE_PREFIX}/nosuch`, headers: await callerHeaders(BASELINE) });

    expect(res.statusCode).toBe(404);
    expect(t.db.writes()).toStrictEqual([]);
  });

  it('answers a well-formed unknown id and a malformed one alike with notFound, as requestRows finds neither', async () => {
    expect(isCfUuid(MISSING_ID)).toBe(true);
    expect(isCfUuid(MALFORMED_ID)).toBe(false);
    for (const id of [MISSING_ID, MALFORMED_ID]) {
      expectFailure(await send('POST', `/${id}/sign`, {}, { typedName: BASELINE.typedName }), 'notFound', 'esignature.requests.sign');
    }
  });
});

describe('esignature.cfc dispatch on the effective method, between the site check and login', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType]>([
    ['alone', {}, 'notFound'],
    ['after an unknown site', FAILURES.site, 'invalidParameters'],
    ['before a caller without a login', FAILURES.login, 'notFound'],
    ['before a role-less caller', FAILURES.role, 'notFound'],
    ['before a missing request', FAILURES.existence, 'notFound'],
  ])('answers a GET of the sign route %s with the earlier failure', async (_case, overrides, type) => {
    expectFailure(await sign({ ...overrides, method: 'GET' }), type, 'esignature.requests.sign');
  });

  it('dispatches on X-HTTP-Method-Override, so a POST overridden to PUT answers notFound', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `${REQUESTS}/${pendingId}/sign`,
      headers: { ...(await callerHeaders(BASELINE)), ...CSRF_HEADERS, 'content-type': 'application/json', 'x-http-method-override': 'PUT' },
      payload: { typedName: BASELINE.typedName },
    });

    expectFailure({ res, writes: t.db.writes() }, 'notFound', 'esignature.requests.sign');
  });
});

describe('the role groups of auth.cfc requireAny and authorizeChainReader', () => {
  it.each<[string, string, readonly string[]]>([
    ['a member', MEMBER, [MEMBER]],
    ['a system user', SYSTEM_USER, [SYSTEM_USER]],
    ['an auditor', AUDITOR_USER_ID, [SYSTEM_USER, AUDITOR]],
  ])('answers %s signing forbidden before the request is read', async (_case, sub, roles) => {
    expectFailure(await sign({ sub, roles, known: false }), 'forbidden', 'esignature.requests.sign');
  });

  it.each<[string, readonly string[]]>([
    ['a member', [MEMBER]],
    ['a system user', [SYSTEM_USER]],
  ])('answers %s reading or verifying a chain forbidden before the request is read', async (_case, roles) => {
    for (const action of ['audit', 'verify']) {
      expectFailure(await send('GET', `/${MISSING_ID}/${action}`, { roles }), 'forbidden', `esignature.requests.${action}`);
    }
  });

  it.each<[string, readonly string[], string]>([
    ['the auditor', [SYSTEM_USER, AUDITOR], AUDITOR_USER_ID],
    ['its signer', [SYSTEM_USER, SIGNER], SIGNER_USER_ID],
  ])('lets %s read the chain of a request', async (_case, roles, sub) => {
    const { res } = await send('GET', `/${SIGNED_ID}/audit`, { roles, sub });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'esignature.requests.audit', data: { totalitems: CHAIN_VECTORS.length } });
  });

  it('answers a signer of another request forbidden only once the request exists', async () => {
    const caller = { sub: OTHER_USER_ID };

    expectFailure(await send('GET', `/${SIGNED_ID}/audit`, caller), 'forbidden', 'esignature.requests.audit');
    expectFailure(await send('GET', `/${MISSING_ID}/audit`, caller), 'notFound', 'esignature.requests.audit');
  });
});

describe('the signer check of esignature.cfc signRequest, between existence and validation', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType, string?]>([
    ['alone', {}, 'forbidden'],
    ['after a missing request', FAILURES.existence, 'notFound'],
    ['before a blank typed name', FAILURES.validation, 'forbidden'],
    ['before a SIGNED request', FAILURES.state, 'forbidden'],
  ])('answers another user signing %s with the earlier failure', async (_case, overrides, type, message) => {
    expectFailure(await sign({ ...overrides, sub: OTHER_USER_ID }), type, 'esignature.requests.sign', message);
  });
});

describe('the requireCsrf check of auth.cfc, between the role check and the request checks', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType, boolean]>([
    ['alone', {}, 'invalidTokens', true],
    ['after an unknown site', FAILURES.site, 'invalidParameters', false],
    ['after a caller without a login', FAILURES.login, 'authorization', false],
    ['after a role-less caller', FAILURES.role, 'forbidden', false],
    ['before a missing request', FAILURES.existence, 'invalidTokens', true],
    ['before a blank typed name', FAILURES.validation, 'invalidTokens', true],
    ['before a SIGNED request', FAILURES.state, 'invalidTokens', true],
  ])('answers a rejected token %s with the earlier failure', async (_case, overrides, type, consulted) => {
    t.csrf.answer(false);

    expectFailure(await sign(overrides), type, 'esignature.requests.sign');
    expect(t.csrf.calls).toHaveLength(consulted ? 1 : 0);
  });

  it('checks no token on the chain reads, which are GETs', async () => {
    t.csrf.answer(false);
    const { res } = await send('GET', `/${SIGNED_ID}/verify`, {});

    expect(res.statusCode).toBe(200);
    expect(t.csrf.calls).toHaveLength(0);
  });
});

/** The vector chain as the audit route lists it and a caller posts it back: `at` as the hashed text, hashes as lowercase hex, NULL as ''. */
function suppliedChain(entries: readonly ChainEntry[] = chainEntries()): Record<string, unknown>[] {
  return entries.map((entry) => ({
    entry_id: entry.entry_id,
    request_id: entry.request_id,
    seq: entry.seq,
    action: entry.action,
    actor_user_id: entry.actor_user_id ?? '',
    detail: entry.detail ?? '',
    at: canonicalAt(entry.at),
    prev_hash: hashToHex(entry.prev_hash),
    entry_hash: hashToHex(entry.entry_hash),
  }));
}

/** suppliedChain() with `patch` applied to its first entry. */
function withFirstEntry(patch: (entry: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown>[] {
  const [first, ...rest] = suppliedChain();
  return [patch(first ?? {}), ...rest];
}

describe('validation answers of esignature.cfc', () => {
  it.each([
    ['empty', ''],
    ['separators, format and control characters only', ' \u00a0\u2028\u200b\t'],
    ['256 characters', 'x'.repeat(256)],
  ])('answers a typed name of %s invalidParameters on a PENDING request', async (_case, typedName) => {
    expectFailure(await sign({ typedName }), 'invalidParameters', 'esignature.requests.sign');
  });

  it('accepts a 255-character typed name, stored as sent', async () => {
    const typedName = ` ${'y'.repeat(254)}`;
    const { res } = await sign({ typedName });

    expect(res.statusCode).toBe(200);
    expect(t.db.rows('signature', TENANT_A.tenantId).map((row) => row.typed_name)).toContain(typedName);
  });

  it.each<[string, Readonly<Record<string, unknown>>]>([
    ['without documentName', { documentBase64: VALID_CREATE.documentBase64, signerUserId: SIGNER_USER_ID }],
    ['with an empty documentName', { ...VALID_CREATE, documentName: '' }],
    ['with a 256-character documentName', { ...VALID_CREATE, documentName: 'd'.repeat(256) }],
    ['without documentBase64', { documentName: VALID_CREATE.documentName, signerUserId: SIGNER_USER_ID }],
    ['with base64 that decodes to no byte', { ...VALID_CREATE, documentBase64: '====' }],
    ['with text that is not base64', { ...VALID_CREATE, documentBase64: '-_8=' }],
    ['without signerUserId', { documentName: VALID_CREATE.documentName, documentBase64: VALID_CREATE.documentBase64 }],
    ['for a signer outside the user pools', { ...VALID_CREATE, signerUserId: MISSING_ID }],
  ])('answers a create %s invalidParameters, writing nothing', async (_case, body) => {
    expectFailure(await send('POST', '', {}, body), 'invalidParameters', 'esignature.requests');
  });

  it('answers a role-less create with invalid fields forbidden, before validation', async () => {
    expectFailure(await send('POST', '', { roles: [SYSTEM_USER] }, { documentName: '' }), 'forbidden', 'esignature.requests');
  });

  it('creates a PENDING request from valid fields', async () => {
    const { res, writes } = await send('POST', '', {}, VALID_CREATE);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'esignature.requests', data: { state: 'PENDING', document_sha256: DOCUMENT_SHA256 } });
    expect(writes).not.toHaveLength(0);
  });

  it('verifies the supplied vector chain, posted as JSON text, against the stored request', async () => {
    const { res } = await send('POST', `/${SIGNED_ID}/verify`, { roles: [SYSTEM_USER, AUDITOR], sub: AUDITOR_USER_ID }, { entries: JSON.stringify(suppliedChain()) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'esignature.requests.verify', data: { valid: true, entries: CHAIN_VECTORS.length, brokenat: 0 } });
  });

  it.each<[string, unknown]>([
    ['without entries', undefined],
    ['as text that is not JSON', 'not json'],
    ['as an object', { seq: 1 }],
    ['with an entry missing entry_hash', withFirstEntry(({ entry_hash: _dropped, ...entry }) => entry)],
    ['with a 63-digit prev_hash', withFirstEntry((entry) => ({ ...entry, prev_hash: '0'.repeat(63) }))],
    ['with a non-hex entry_hash', withFirstEntry((entry) => ({ ...entry, entry_hash: 'g'.repeat(64) }))],
    ['with a zero-padded seq', withFirstEntry((entry) => ({ ...entry, seq: '01' }))],
    ['with at lacking milliseconds', withFirstEntry((entry) => ({ ...entry, at: '2026-06-30T00:00:00' }))],
  ])('answers a supplied chain %s invalidParameters', async (_case, entries) => {
    const body = entries === undefined ? {} : { entries };

    expectFailure(await send('POST', `/${SIGNED_ID}/verify`, {}, body), 'invalidParameters', 'esignature.requests.verify');
  });

  it('answers a malformed chain for a missing request notFound, as authorizeChainReader loads it first', async () => {
    expectFailure(await send('POST', `/${MISSING_ID}/verify`, {}, { entries: 'not json' }), 'notFound', 'esignature.requests.verify');
  });
});

describe('the state check of esignature.cfc signRequest', () => {
  it('answers a second signature of a request conflict already-signed, after the first succeeded', async () => {
    expect((await sign()).res.statusCode).toBe(200);
    t.db.clear();

    expectFailure(await sign(), 'conflict', 'esignature.requests.sign', 'already-signed');
  });
});

describe('tenant scoping of the fixture checks', () => {
  const tenantB = { site: TENANT_B.siteId, roles: [SYSTEM_USER, SIGNER, AUDITOR] };

  it.each(['audit', 'verify'])('answers a tenant-b reader of a tenant-a request %s notFound, never its data', async (action) => {
    const sent = await send('GET', `/${SIGNED_ID}/${action}`, tenantB);

    expectFailure(sent, 'notFound', `esignature.requests.${action}`);
    expect(sent.res.body).not.toContain(SIGNED_ID);
  });

  it('answers a tenant-b signer signing a tenant-a request notFound', async () => {
    expectFailure(await sign(tenantB), 'notFound', 'esignature.requests.sign');
  });

  it('answers the other-tenant subject forbidden at the role check, before any request is read', async () => {
    const res = await t.app.inject({ method: 'GET', url: `${REQUESTS}/${SIGNED_ID}/audit`, headers: await headersFor('other-tenant') });

    expectFailure({ res, writes: t.db.writes() }, 'forbidden', 'esignature.requests.audit');
  });

  it('answers a tenant-b token naming siteid tenant-a forbidden, as its login holds no tenant-a role group', async () => {
    expectFailure(await send('GET', `/${SIGNED_ID}/audit${siteQuery(TENANT_A.siteId)}`, tenantB), 'forbidden', 'esignature.requests.audit');
  });
});

/** Runs `run` with only Date faked, moving it on a second every 25 ms, so a gate wait passes its real 30 s budget in under a second. */
async function pastGateBudget(run: () => Promise<Sent>): Promise<Sent & { waitedMs: number }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const started = Date.now();
    let settled = false;
    const pending = run().finally(() => {
      settled = true;
    });
    while (!settled) {
      await sleep(25);
      vi.setSystemTime(Date.now() + 1_000);
    }
    const sent = await pending;
    return { ...sent, waitedMs: Date.now() - started };
  } finally {
    vi.useRealTimers();
  }
}

/** Asserts the legacy 503 of an unavailable unit, as service-kit renders apiUnavailableResponse, and that nothing was written. */
function expectUnavailable(sent: Sent): void {
  expect(sent.res.statusCode).toBe(503);
  expect(sent.res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
  expect(sent.writes).toStrictEqual([]);
}

describe('unit gates of esignature.signature_request', () => {
  it('holds a valid sign on a closed gate for the gate budget, then answers the legacy 503', async () => {
    t.db.setGate(REQUEST_UNIT, 'closed');
    const sent = await pastGateBudget(() => sign());

    expectUnavailable(sent);
    expect(sent.waitedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
    expect(t.db.rows('signature_request', TENANT_A.tenantId).find((row) => row.request_id === pendingId)?.state).toBe('PENDING');
  });

  it('refuses a sign at once while the unit is legacy-authoritative', async () => {
    t.db.setGate(REQUEST_UNIT, 'legacy');

    expectUnavailable(await sign());
  });

  it('answers the earlier fixture failure before the gate is consulted', async () => {
    t.db.setGate(REQUEST_UNIT, 'legacy');

    expectFailure(await sign(FAILURES.role), 'forbidden', 'esignature.requests.sign');
  });

  it('serves chain reads on a closed gate while its window is quiet', async () => {
    t.db.setGate(REQUEST_UNIT, 'closed', 'quiet');
    const { res } = await send('GET', `/${SIGNED_ID}/audit`, {});

    expect(res.statusCode).toBe(200);
  });

  it.each(['executing', 'importing', 'import-pending'] as const)('holds a chain read during the %s phase, then answers the legacy 503', async (phase) => {
    t.db.setGate(REQUEST_UNIT, 'closed', phase);
    const sent = await pastGateBudget(() => send('GET', `/${SIGNED_ID}/audit`, {}));

    expectUnavailable(sent);
    expect(sent.waitedMs).toBeGreaterThanOrEqual(GATE_WAIT_MS);
  });
});

describe('the validators the fixture routes run', () => {
  it('reads the vector chain posted back as JSON text as the chain keys in text form, in array order', () => {
    const expected = CHAIN_VECTORS.map((vector) => ({
      seq: String(vector.input.seq),
      action: vector.input.action,
      actor_user_id: vector.input.actorUserId ?? '',
      detail: vector.input.detail ?? '',
      at: vector.canonical.slice(vector.canonical.lastIndexOf('|') + 1),
      prev_hash: vector.prevHex,
      entry_hash: vector.entryHex,
    }));

    expect(validateSuppliedChain({ entries: JSON.stringify(suppliedChain()) })).toEqual({ ok: true, value: expected });
    expect(validateSuppliedChain({ entries: suppliedChain() })).toEqual({ ok: true, value: expected });
  });

  it('decodes the create document and keeps documentName and signerUserId as sent', () => {
    const name = '  contract.pdf ';

    expect(validateCreateInput({ ...VALID_CREATE, documentName: name })).toEqual({
      ok: true,
      value: { documentName: name, document: DOCUMENT, signerUserId: SIGNER_USER_ID },
    });
  });

  it('passes the path id and a blank typed name through, leaving the typed-name rule to signRequest after existence', () => {
    expect(validateSignInput(MISSING_ID, { typedName: '   ' })).toEqual({ ok: true, value: { requestId: MISSING_ID, typedName: '   ' } });
  });
});
