// Unit tests for the fault toggle routes over a registry double: contract shape, the registry calls, the legacy 400 and 404, and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { FaultParamsError, UnknownFaultError, type ActiveFault } from '../../src/faults/index.js';
import { FAULT_ROUTES, registerFaultRoutes } from '../../src/routes/faults.js';

type Operation = Record<string, unknown>;
type Method = 'PUT' | 'DELETE';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const FAULT_PATH = '/internal/v1/faults/{name}';
const NOW = '2026-06-30T12:00:00.000Z';
const DELAY = 'projector-delay';

/** Registry double: knows `projector-delay` only, applies its 3000 ms default and refuses a `delayMs` that is not a number. */
function registryDouble() {
  const armed = new Map<string, ActiveFault>();
  return {
    armed,
    set: vi.fn((name: string, params: unknown = {}): ActiveFault => {
      if (name !== DELAY) throw new UnknownFaultError(name);
      const delayMs = (params as { delayMs?: unknown }).delayMs ?? 3000;
      if (typeof delayMs !== 'number') throw new FaultParamsError(DELAY, ['delayMs: Invalid input: expected number']);
      const entry: ActiveFault = { name: DELAY, params: { delayMs }, since: NOW };
      armed.set(name, entry);
      return entry;
    }),
    clear: vi.fn((name: string): boolean => {
      if (name !== DELAY) throw new UnknownFaultError(name);
      return armed.delete(name);
    }),
  };
}

let faults = registryDouble();
// Delegates to the double of the current test, so each test starts with nothing armed.
const deps = {
  faults: {
    set: (name: string, params?: unknown) => faults.set(name, params),
    clear: (name: string) => faults.clear(name),
  },
};
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
  registerFaultRoutes(app, deps);
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  faults = registryDouble();
});

/** Invocation-credential headers of `caller`, optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2, Roles.platformOperator] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

const operator = () => headersFor('operator');

/** Injects a request for fault `name` and checks the answer against the contract operation. */
async function call(method: Method, name: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `/internal/v1/faults/${name}`,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: FAULT_PATH, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe('route declaration', () => {
  it('matches the contract operations, transport and roles', () => {
    const put = OPENAPI.paths[FAULT_PATH]?.put ?? {};
    const del = OPENAPI.paths[FAULT_PATH]?.delete ?? {};
    expect(FAULT_ROUTES).toEqual([
      { operationId: put.operationId, method: 'PUT', path: FAULT_PATH, url: '/internal/v1/faults/:name' },
      { operationId: del.operationId, method: 'DELETE', path: FAULT_PATH, url: '/internal/v1/faults/:name' },
    ]);
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/faults'));
    expect(declared).toHaveLength(2);
    expect(declared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'PUT', url: '/internal/v1/faults/:name', transport: put['x-opt2-transport'], requires: put['x-opt2-requires'] }),
        expect.objectContaining({ method: 'DELETE', url: '/internal/v1/faults/:name', transport: del['x-opt2-transport'], requires: del['x-opt2-requires'] }),
      ]),
    );
  });
});

describe('faultSet', () => {
  it.each([
    ['a 3000 ms delay', { delayMs: 3000 }, 3000],
    ['no parameters, so the registry applies its default', {}, 3000],
  ])('arms projector-delay with %s and answers 204 without a body', async (_label, params, delayMs) => {
    const res = await call('PUT', DELAY, await operator(), { params });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(faults.set).toHaveBeenCalledExactlyOnceWith(DELAY, params);
    expect(faults.armed.get(DELAY)?.params).toEqual({ delayMs });
  });

  it.each([
    ['no params', {}],
    ['params that are an array', { params: [3000] }],
    ['params that are a string', { params: 'delayMs=3000' }],
    ['null params', { params: null }],
    ['an extra top-level key', { params: {}, name: DELAY }],
    ['an array body', [{ params: {} }]],
    ['a body that is not JSON, which service-kit parses to no body', '{"params": {'],
  ])('answers a body with %s with the legacy 400 and arms nothing', async (_label, body) => {
    const res = await call('PUT', DELAY, await operator(), body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(faults.set).not.toHaveBeenCalled();
  });

  it('answers parameters the registry refuses with the legacy 400', async () => {
    const res = await call('PUT', DELAY, await operator(), { params: { delayMs: 'soon' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(faults.armed.size).toBe(0);
  });

  it('answers a name the registry does not know with the legacy 404 naming it', async () => {
    const res = await call('PUT', 'projector-stall', await operator(), { params: {} });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: expect.stringContaining('"projector-stall"') as unknown } });
    expect(faults.armed.size).toBe(0);
  });
});

describe('faultClear', () => {
  it('disarms an armed fault and answers 204 without a body', async () => {
    await call('PUT', DELAY, await operator(), { params: { delayMs: 3000 } });

    const res = await call('DELETE', DELAY, await operator());

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(faults.clear).toHaveReturnedWith(true);
    expect(faults.armed.size).toBe(0);
  });

  it('answers 204 for a known fault that is not armed', async () => {
    const res = await call('DELETE', DELAY, await operator());

    expect(res.statusCode).toBe(204);
    expect(faults.clear).toHaveReturnedWith(false);
  });

  it('answers a name the registry does not know with the legacy 404', async () => {
    const res = await call('DELETE', 'projector-stall', await operator());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });
});

describe('errors outside the contract', () => {
  it.each([
    ['PUT', { params: {} }],
    ['DELETE', undefined],
  ] as const)('%s propagates any other registry failure as a server error', async (method, payload) => {
    const failure = (): never => {
      throw new Error('registry unavailable');
    };
    faults.set.mockImplementationOnce(failure);
    faults.clear.mockImplementationOnce(failure);

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method, url: `/internal/v1/faults/${DELAY}`, headers: await operator(), ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('auth', () => {
  it.each([
    ['PUT', { params: { delayMs: 3000 } }],
    ['DELETE', undefined],
  ] as const)('%s admits the operator and refuses every other caller without reaching the registry', async (method, body) => {
    for (const caller of ['migration', 'gateway', 'programs-sites', 'people']) {
      expect((await call(method, DELAY, await headersFor(caller), body)).statusCode).toBe(403);
    }
    expect((await call(method, DELAY, await headersFor('gateway', true), body)).statusCode).toBe(403);
    expect((await call(method, DELAY, await headersFor(null), body)).statusCode).toBe(401);
    expect((await call(method, DELAY, await headersFor(null, true), body)).statusCode).toBe(401);
    expect(faults.set).not.toHaveBeenCalled();
    expect(faults.clear).not.toHaveBeenCalled();

    expect((await call(method, DELAY, await operator(), body)).statusCode).toBe(204);
  });
});
