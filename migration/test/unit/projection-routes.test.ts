// Unit tests for the `projectionAwait` route over a fake projector: both request forms, the default budget, contract shape, the legacy 400 and 503, and auth denials.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ServiceUnavailableError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { ProjectionTimeoutError, type AwaitProjectionRequest, type AwaitProjectionResult } from '../../src/reverse/index.js';
import { PROJECTION_ROUTES, registerProjectionRoutes } from '../../src/routes/projection.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const PATH = '/internal/v1/projection/await';
// Distinct from the contract's 5000 default, so the test shows the configured value is the one applied.
const DEFAULT_TIMEOUT_MS = 4321;

const awaitProjection = vi.fn<(req: AwaitProjectionRequest) => Promise<AwaitProjectionResult>>();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createService({
    name: 'migration',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8102',
      OPT2_SERVICE_NAME: 'migration',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('migration'),
    logger: createLogger({ service: 'migration', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerProjectionRoutes(app, { projector: { awaitProjection }, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  awaitProjection.mockReset();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects a POST, with `payload` as a JSON body unless undefined, and checks the answer against the contract. */
async function post(payload: unknown, headers: Record<string, string>) {
  const body = payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'content-type': 'application/json' } };
  const res = await app.inject({ method: 'POST', url: PATH, headers, ...body });
  assertResponseMatchesOpenApi(OPENAPI, { method: 'POST', path: PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe('route declaration', () => {
  it('matches the contract operation', () => {
    const operation = OPENAPI.paths[PATH]?.post ?? {};
    expect(PROJECTION_ROUTES).toEqual([{ operationId: operation.operationId, method: 'POST', path: PATH, url: PATH }]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url === PATH);
    expect(declared).toEqual([
      expect.objectContaining({ method: 'POST', url: PATH, transport: operation['x-opt2-transport'], requires: operation['x-opt2-requires'] }),
    ]);
  });
});

describe('answers', () => {
  it('awaits the given positions with the configured budget when the request names none', async () => {
    awaitProjection.mockResolvedValue({ positions: new Map([['people', '42'], ['identity', '17']]), waitedMs: 12 });

    const res = await post({ positions: { people: '42', identity: '0017' } }, await headersFor('gateway'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, positions: { people: '42', identity: '17' } });
    expect(awaitProjection).toHaveBeenCalledTimes(1);
    expect(awaitProjection).toHaveBeenCalledWith({ positions: new Map([['identity', '17'], ['people', '42']]), timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  it('awaits the owners form with the request budget and answers the positions read at call time', async () => {
    awaitProjection.mockResolvedValue({ positions: new Map([['strategies-content', '18446744073709551615']]), waitedMs: 0 });

    const res = await post({ owners: ['strategies-content'], timeoutMs: 1500 }, await headersFor('gateway'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, positions: { 'strategies-content': '18446744073709551615' } });
    expect(awaitProjection).toHaveBeenCalledWith({ owners: ['strategies-content'], timeoutMs: 1500 });
  });

  it('answers an owners request whose owners have nothing to await with no positions', async () => {
    awaitProjection.mockResolvedValue({ positions: new Map(), waitedMs: 0 });

    const res = await post({ owners: ['people', 'identity'], timeoutMs: 30000 }, await headersFor('gateway'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, positions: {} });
    expect(awaitProjection).toHaveBeenCalledWith({ owners: ['people', 'identity'], timeoutMs: 30000 });
  });

  it.each([
    ['a projection timeout', () => new ProjectionTimeoutError([{ owner: 'people', xid: '42', tenantsBehind: ['tenant-a'] }], 5000)],
    ['an unreachable owner', () => new ServiceUnavailableError('people', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))],
  ])('answers %s with the legacy 503', async (_label, failure) => {
    awaitProjection.mockRejectedValue(failure());

    const res = await post({ positions: { people: '42' } }, await headersFor('gateway'));

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
  });

  it('propagates any other failure as a server error', async () => {
    awaitProjection.mockRejectedValue(new Error('checkpoint table unreadable'));

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method: 'POST', url: PATH, headers: await headersFor('gateway'), payload: { positions: { people: '42' } } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('invalid requests', () => {
  it.each([
    ['no body', undefined],
    ['an empty object', {}],
    ['a non-object body', 'people=42'],
    ['empty positions', { positions: {} }],
    ['positions in header form', { positions: 'people=42' }],
    ['an unknown owner', { positions: { gateway: '42' } }],
    ['a non-decimal xid', { positions: { people: '4a' } }],
    ['a negative xid', { positions: { people: '-1' } }],
    ['a numeric xid', { positions: { people: 42 } }],
    ['an xid over 20 digits', { positions: { people: '123456789012345678901' } }],
    ['both forms at once', { positions: { people: '42' }, owners: ['people'] }],
    ['an extra property', { positions: { people: '42' }, siteid: 'default' }],
    ['no owners', { owners: [] }],
    ['repeated owners', { owners: ['people', 'people'] }],
    ['an unknown listed owner', { owners: ['people', 'legacy'] }],
    ['a zero budget', { owners: ['people'], timeoutMs: 0 }],
    ['a budget over 30 s', { owners: ['people'], timeoutMs: 30001 }],
    ['a fractional budget', { positions: { people: '42' }, timeoutMs: 1.5 }],
    ['a string budget', { positions: { people: '42' }, timeoutMs: '5000' }],
  ])('answers %s with the legacy 400 without awaiting', async (_label, body) => {
    const res = await post(body, await headersFor('gateway'));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(awaitProjection).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it.each(['migration', 'programs-sites', 'people', 'identity', 'operator'])('refuses %s with 403', async (caller) => {
    expect((await post({ positions: { people: '42' } }, await headersFor(caller))).statusCode).toBe(403);
    expect(awaitProjection).not.toHaveBeenCalled();
  });

  it('refuses anonymous calls and a user token without an invocation credential with 401', async () => {
    expect((await post({ positions: { people: '42' } }, await headersFor(null))).statusCode).toBe(401);
    expect((await post({ positions: { people: '42' } }, await headersFor(null, true))).statusCode).toBe(401);
    expect(awaitProjection).not.toHaveBeenCalled();
  });
});
