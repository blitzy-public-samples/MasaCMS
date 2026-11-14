/** The `consumeCsrfToken`, `claimCsrfToken` and `settleCsrfClaims` routes and `validateCsrfForRoute` over a throwaway `identity` schema: contract shape, transport and role denials, body validation and single use across the routes. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix, serviceRole } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SYSTEM_TENANT_ID, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { issueTokens, type CsrfDeps } from '../../src/domain/csrf.js';
import type { BridgeRelay, LegacyUsedToken } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { registerCsrfRoutes, validateCsrfForRoute } from '../../src/routes/internal-csrf.js';

type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const CONTRACT_PATHS = ['/internal/v1/csrf/consume', '/internal/v1/csrf/claims', '/internal/v1/csrf/claims:settle'];
const CONSUME = '/internal/v1/csrf/consume';
const CLAIMS = '/internal/v1/csrf/claims';
const SETTLE = '/internal/v1/csrf/claims:settle';
// Harness route standing in for one of identity's own carried routes, which call validateCsrfForRoute in-process.
const CHECK_ROUTE = '/test/v1/csrf-check';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const SECRET = 'K0000000-0000-0000-0000000000000001';
const CONTEXT = 'cusers.update';
const JSON_BODY = { 'content-type': 'application/json' };
const CONSUME_CALLERS = [
  'people',
  'programs-sites',
  'strategies-content',
  'identity',
  'gateway',
  'communications',
  'e-signature',
  'finance',
  'reporting',
  'surveys',
  'timesheets',
];

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: async () => undefined,
};

/** A relay that records each mark-used call. */
function recordingRelay(): BridgeRelay & { calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] } {
  const calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] = [];
  return {
    calls,
    async markUsed(sessionId, tokens) {
      calls.push({ sessionId, tokens });
      return { applied: true };
    },
  };
}

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let sessionSeq = 0;
const relay = recordingRelay();

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-internal-csrf-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
  }
  app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  // An immediate sleep lets a consume held by a pending-legacy claim reach its 5 s limit without waiting.
  const csrf: CsrfDeps = { db: handle?.app ?? NO_DB, repo, bridge: relay, clock: CLOCK, sleep: async () => undefined };
  await registerCsrfRoutes(app, { csrf });
  app.post(CHECK_ROUTE, { config: { opt2: { transport: 'service', requires: [serviceRole('gateway')] } } }, async (request) => ({
    valid: await validateCsrfForRoute({ csrf }, request, CONTEXT),
  }));
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  relay.calls.length = 0;
});

/** Headers of a `caller` service call, relaying a user token of session `sid` unless `sid` is null. */
async function headersFor(caller: string | null, sid: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (sid !== null) {
    headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-editor', sid, site: 'tenant-a', roles: [Roles.systemUser] })}`;
  }
  if (caller !== null) {
    headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  }
  return headers;
}

/** Injects a POST and checks the answer against the contract. */
async function send(url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { ...headers, ...JSON_BODY },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** A token request of `sessionId` for `context`, issued under the test secret. */
function tokenBody(sessionId: string, context = CONTEXT): { sessionId: string; token: string; expires: string; context: string } {
  return { sessionId, ...issueTokens({ csrfSecret: SECRET }, { context, clock: CLOCK }), context };
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/csrf'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {}).map(([method, operation]) => ({
        method: method.toUpperCase(),
        url: (operation['x-opt2-fastify-path'] as string | undefined) ?? template,
        transport: operation['x-opt2-transport'],
        requires: operation['x-opt2-requires'],
      })),
    );
    expect(expected).toHaveLength(3);
    expect(declared).toHaveLength(3);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
  });
});

describe('auth denials', () => {
  it('refuse consumeCsrfToken to callers outside its admitted services and to calls without an invocation credential', async () => {
    const body = tokenBody('S-denied');
    for (const caller of ['stub', 'web', 'migration']) {
      expect((await send(CONSUME, await headersFor(caller, 'S-denied'), body)).statusCode).toBe(403);
    }
    expect((await send(CONSUME, await headersFor(null, 'S-denied'), body)).statusCode).toBe(401);
  });

  it.each(CONSUME_CALLERS)('answers %s consuming without a user token with 401 and for another session with 403', async (caller) => {
    const missing = await send(CONSUME, await headersFor(caller, null), tokenBody('S-mine'));
    const other = await send(CONSUME, await headersFor(caller, 'S-mine'), tokenBody('S-other'));

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
  });

  it.each([
    [CLAIMS, tokenBody('S-denied')],
    [SETTLE, { sessionId: 'S-denied', consumed: [], released: [] }],
  ])('refuse %s to callers other than the gateway', async (url, body) => {
    for (const caller of CONSUME_CALLERS.filter((name) => name !== 'gateway')) {
      expect((await send(url, await headersFor(caller, 'S-denied'), body)).statusCode).toBe(403);
    }
    expect((await send(url, await headersFor(null, 'S-denied'), body)).statusCode).toBe(401);
  });
});

describe('body validation', () => {
  const valid = tokenBody('S-body');

  it.each([
    [CONSUME, 'no body', undefined],
    [CONSUME, 'no context', { sessionId: valid.sessionId, token: valid.token, expires: valid.expires }],
    [CONSUME, 'an object token', { ...valid, token: { value: valid.token } }],
    [CLAIMS, 'no expires', { sessionId: valid.sessionId, token: valid.token, context: CONTEXT }],
    [CLAIMS, 'no sessionId', { token: valid.token, expires: valid.expires, context: CONTEXT }],
    [SETTLE, 'no released list', { sessionId: 'S-body', consumed: [] }],
    [SETTLE, 'a consumed object instead of a list', { sessionId: 'S-body', consumed: { token: 'T' }, released: [] }],
    [SETTLE, 'an object released item', { sessionId: 'S-body', consumed: [], released: [{ token: 'T' }] }],
  ])('answers %s with %s with the legacy 400', async (url, _label, payload) => {
    const res = await send(url, await headersFor('gateway', 'S-body'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });
});

describe('validateCsrfForRoute without a complete token', () => {
  it.each<[string, string | null, Record<string, string>]>([
    ['no user token', null, { [CSRF_HEADER_TOKEN]: 'T', [CSRF_HEADER_EXPIRES]: '260630150000123' }],
    ['no token', 'S-check', { [CSRF_HEADER_EXPIRES]: '260630150000123' }],
    ['no expiry', 'S-check', { [CSRF_HEADER_TOKEN]: 'T' }],
    ['an empty token', 'S-check', { [CSRF_HEADER_TOKEN]: '', [CSRF_HEADER_EXPIRES]: '260630150000123' }],
  ])('answers false for a request with %s, without consulting the ledger', async (_label, sid, csrfHeaders) => {
    const res = await app.inject({ method: 'POST', url: CHECK_ROUTE, headers: { ...(await headersFor('gateway', sid)), ...csrfHeaders } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });
});

describe.skipIf(!available)('single use against PostgreSQL', () => {
  /** Inserts an active anonymous session with the test secret and returns its id. */
  async function newSession(): Promise<string> {
    sessionSeq += 1;
    const sessionId = `S-route-${sessionSeq}`;
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    await withTenant(handle.app, SYSTEM_TENANT_ID, (tx) =>
      repo.insertSession(tx, { session_id: sessionId, csrf_secret: SECRET, mode: 'target-primary', state: 'active' }),
    );
    return sessionId;
  }

  it.each(CONSUME_CALLERS)('consumes a valid token once for %s, relaying it to the legacy ledger before answering', async (caller) => {
    const sessionId = await newSession();
    const body = tokenBody(sessionId);
    const headers = await headersFor(caller, sessionId);

    const first = await send(CONSUME, headers, body);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ valid: true });
    expect(relay.calls).toEqual([{ sessionId, tokens: [{ token: body.token, usedAt: NOW }] }]);
    expect((await send(CONSUME, headers, body)).json()).toEqual({ valid: false });
    expect(relay.calls).toHaveLength(1);
  });

  it('answers 200 with valid false for a token of another context and for an unknown session', async () => {
    const sessionId = await newSession();
    const otherContext = { ...tokenBody(sessionId, 'csettings.update'), context: CONTEXT };

    const wrong = await send(CONSUME, await headersFor('people', sessionId), otherContext);
    const unknown = await send(CONSUME, await headersFor('people', 'S-unknown'), tokenBody('S-unknown'));

    expect([wrong.statusCode, wrong.json()]).toEqual([200, { valid: false }]);
    expect([unknown.statusCode, unknown.json()]).toEqual([200, { valid: false }]);
    expect(relay.calls).toEqual([]);
  });

  it('holds a token claimed for legacy, frees it on release and reports it used after a consume', async () => {
    const sessionId = await newSession();
    const body = tokenBody(sessionId);
    const gateway = await headersFor('gateway', sessionId);

    expect((await send(CLAIMS, gateway, body)).json()).toEqual({ state: 'pending-legacy' });
    expect((await send(CONSUME, await headersFor('people', sessionId), body)).json()).toEqual({ valid: false });
    expect((await send(SETTLE, gateway, { sessionId, consumed: [], released: [body.token.toLowerCase()] })).json()).toEqual({ used: 0, released: 1 });
    expect((await send(CONSUME, await headersFor('people', sessionId), body)).json()).toEqual({ valid: true });
    expect((await send(CLAIMS, gateway, body)).json()).toEqual({ state: 'used' });
  });

  it('settles a token legacy consumed as used, so a later consume is refused', async () => {
    const sessionId = await newSession();
    const consumed = tokenBody(sessionId);
    const released = tokenBody(sessionId, 'cperm.update');
    const gateway = await headersFor('gateway', sessionId);
    await send(CLAIMS, gateway, consumed);
    await send(CLAIMS, gateway, released);

    const settled = await send(SETTLE, gateway, { sessionId, consumed: [consumed.token], released: [released.token] });

    expect(settled.statusCode).toBe(200);
    expect(settled.json()).toEqual({ used: 1, released: 1 });
    expect((await send(CONSUME, await headersFor('identity', sessionId), consumed)).json()).toEqual({ valid: false });
    expect((await send(CONSUME, await headersFor('identity', sessionId), released)).json()).toEqual({ valid: true });
  });

  it('leaves a session identity does not hold to legacy alone', async () => {
    const gateway = await headersFor('gateway', null);

    expect((await send(CLAIMS, gateway, tokenBody('S-legacy-only'))).json()).toEqual({ state: 'pending-legacy' });
    expect((await send(SETTLE, gateway, { sessionId: 'S-legacy-only', consumed: ['T1'], released: ['T2'] })).json()).toEqual({ used: 0, released: 0 });
  });

  it.each([
    ['the X-csrf_token headers', (body: { token: string; expires: string }) => ({ headers: { [CSRF_HEADER_TOKEN]: body.token, [CSRF_HEADER_EXPIRES]: body.expires }, query: '' })],
    ['the csrf_token url fields', (body: { token: string; expires: string }) => ({ headers: {}, query: `?${CSRF_FIELD_TOKEN}=${body.token}&${CSRF_FIELD_EXPIRES}=${body.expires}` })],
  ])('validates and consumes a token sent in %s for the caller session in-process', async (_label, place) => {
    const sessionId = await newSession();
    const { headers: csrfHeaders, query } = place(tokenBody(sessionId));
    const inject = async () =>
      app.inject({ method: 'POST', url: `${CHECK_ROUTE}${query}`, headers: { ...(await headersFor('gateway', sessionId)), ...csrfHeaders } });

    expect((await inject()).json()).toEqual({ valid: true });
    expect((await inject()).json()).toEqual({ valid: false });
    expect(relay.calls).toHaveLength(1);
  });
});
