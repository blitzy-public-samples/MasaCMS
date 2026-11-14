// Unit tests for the cut-over transition routes over a fake transition service: declarations against the contract, each
// declared answer, the background start, and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, findOperation, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { components } from '../../src/generated/openapi.js';
import { TRANSITION_ROUTES, registerTransitionRoutes, type TransitionRouteDeps } from '../../src/routes/transitions.js';
import { TransitionInProgressError, TransitionNotFoundError, TransitionPreconditionError } from '../../src/transition/index.js';

type Schemas = components['schemas'];
type Operation = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};

const ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const ACTIVE_ID = 'A1B2C3D4-E5F6-4789-ABCDEF0123456789';
const START_URL = '/internal/v1/transitions';
const GET_URL = `/internal/v1/transitions/${ID}`;

const STARTED: Schemas['Transition'] = {
  transitionId: ID,
  fromVersion: 'v0001',
  toVersion: 'v0002',
  state: 'running',
  step: 1,
  units: [],
  frozenRoutes: [],
  startedAt: '2026-06-30T12:00:00.000Z',
};

const COMPLETED: Schemas['Transition'] = {
  ...STARTED,
  state: 'completed',
  step: 8,
  units: ['people.person', 'identity.user_account'],
  frozenRoutes: ['cusers.update{type=2,action=Add}'],
  reconciliation: { report: 'opt2/reports/reconciliation/post-cutover.json', differences: 0 },
  finishedAt: '2026-06-30T12:05:00.000Z',
};

const transitions = {
  start: vi.fn<TransitionRouteDeps['transitions']['start']>(),
  get: vi.fn<TransitionRouteDeps['transitions']['get']>(),
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
  registerTransitionRoutes(app, { transitions });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  transitions.start.mockReset().mockResolvedValue(STARTED);
  transitions.get.mockReset().mockResolvedValue(COMPLETED);
});

/** Invocation-credential headers of `caller` (none for null), optionally with a user token. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-admin', site: 'default', roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}`;
  return headers;
}

/** Injects a request and checks the answer against the contract operation the path names. */
async function call(method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

const asOperator = () => headersFor('operator');
const serviceCalls = () => transitions.start.mock.calls.length + transitions.get.mock.calls.length;

describe('route declaration', () => {
  const contractOperations = Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith('/internal/v1/transitions'))
    .flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((verb) => {
        const operation = item[verb];
        return operation === undefined ? [] : [{ operationId: String(operation.operationId), method: verb.toUpperCase(), path }];
      }),
    );

  it("exports exactly the contract's transition operations with their operation id, method and path", () => {
    const byId = (a: { operationId: string }, b: { operationId: string }) => a.operationId.localeCompare(b.operationId);
    expect(TRANSITION_ROUTES.map(({ operationId, method, path }) => ({ operationId, method, path })).sort(byId)).toEqual(contractOperations.sort(byId));
  });

  it('registers exactly these operations, each with the contract transport, roles and site check', () => {
    const registered = collectRouteMatrix(app).routes.filter((route) => route.url !== '/healthz');
    expect(registered.map(({ method, url }) => `${method} ${url}`).sort()).toEqual(TRANSITION_ROUTES.map(({ method, url }) => `${method} ${url}`).sort());
    for (const { operationId, method, path, url } of TRANSITION_ROUTES) {
      const { operation } = findOperation(OPENAPI, method, path);
      const route = registered.find((candidate) => candidate.method === method && candidate.url === url);
      expect({ operationId, transport: route?.transport, requires: [...(route?.requires ?? [])].sort(), siteCheck: route?.siteCheck }).toEqual({
        operationId: operation.operationId,
        transport: operation['x-opt2-transport'],
        requires: [...(operation['x-opt2-requires'] as string[])].sort(),
        siteCheck: operation['x-opt2-site-check'] !== false,
      });
    }
  });
});

describe('transitionStart', () => {
  it('asks the service for the version as the verified operator and answers 202 with the running transition', async () => {
    const res = await call('POST', START_URL, await asOperator(), { toVersion: 'v0002' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(STARTED);
    expect(transitions.start).toHaveBeenCalledExactlyOnceWith({ to: 'v0002', requestedBy: 'operator' });
  });

  it.each([
    ['no body', undefined],
    ['no version', {}],
    ['the CLI flag name instead of the contract field', { to: 'v0002' }],
    ['a version without the v prefix', { toVersion: '0002' }],
    ['a version with three digits', { toVersion: 'v002' }],
    ['a version that is not a string', { toVersion: 2 }],
    ['an undeclared key', { toVersion: 'v0002', force: true }],
  ])('answers %s with the legacy 400 without starting', async (_label, body) => {
    const res = await call('POST', START_URL, await asOperator(), body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(transitions.start).not.toHaveBeenCalled();
  });

  it('answers a second start while another transition runs with the legacy 409 naming the active transition', async () => {
    transitions.start.mockRejectedValueOnce(new TransitionInProgressError(ACTIVE_ID));

    const res = await call('POST', START_URL, await asOperator(), { toVersion: 'v0003' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      apiversion: 'v1',
      method: 'invalid',
      error: { message: `Transition ${ACTIVE_ID} is still in progress`, code: 'invalid_request' },
    });
  });

  it.each([
    ['same-version', 'v0002 is already the active cut-over version'],
    ['previous-mismatch', 'v0003 follows v0002, but the active version is v0001'],
    ['opt2-sync-unavailable', 'The legacy database has no opt2_sync.projector_checkpoint, so people.person cannot become target-authoritative'],
  ] as const)('answers the %s precondition with the legacy 409 and its message', async (code, message) => {
    transitions.start.mockRejectedValueOnce(new TransitionPreconditionError(code, message));

    const res = await call('POST', START_URL, await asOperator(), { toVersion: 'v0003' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { message, code: 'invalid_request' } });
  });

  it('relays the legacy 400 the service raises for a version that has no file', async () => {
    transitions.start.mockRejectedValueOnce(new LegacyApiError('invalidParameters'));

    const res = await call('POST', START_URL, await asOperator(), { toVersion: 'v0009' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });
});

describe('transitionGet', () => {
  it('answers the transition', async () => {
    const res = await call('GET', GET_URL, await asOperator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(COMPLETED);
    expect(transitions.get).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('answers an id that names no transition with the legacy 404', async () => {
    transitions.get.mockRejectedValueOnce(new TransitionNotFoundError(ID));

    const res = await call('GET', GET_URL, await asOperator());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: `No transition ${ID}`, code: 'invalid_request' } });
  });

  it.each([ID.toLowerCase(), 'not-a-transition', `${ID}0`])('answers %s, which is no CF UUID, with the legacy 404 without a service call', async (id) => {
    const res = await call('GET', `/internal/v1/transitions/${id}`, await asOperator());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { message: `No transition ${id}`, code: 'invalid_request' } });
    expect(serviceCalls()).toBe(0);
  });
});

describe('other failures', () => {
  it.each([
    ['start', 'POST', START_URL, { toVersion: 'v0002' }],
    ['get', 'GET', GET_URL, undefined],
  ] as const)('propagate from %s as a server error', async (operation, method, url, payload) => {
    transitions[operation].mockRejectedValueOnce(new Error('connection terminated'));

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method, url, headers: await asOperator(), ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('auth', () => {
  const probes = [
    ['POST', START_URL, { toVersion: 'v0002' }, 202],
    ['GET', GET_URL, undefined, 200],
  ] as const;

  it.each(probes)('%s %s admits only the operator workload', async (method, url, payload, status) => {
    for (const caller of ['operator', 'gateway', 'migration', 'programs-sites', 'people']) {
      const res = await call(method, url, await headersFor(caller), payload);
      expect({ caller, status: res.statusCode }).toEqual({ caller, status: caller === 'operator' ? status : 403 });
    }
    expect(serviceCalls()).toBe(1);
  });

  it.each(probes)('%s %s refuses anonymous requests and user tokens without an invocation credential', async (method, url, payload) => {
    expect((await call(method, url, await headersFor(null), payload)).statusCode).toBe(401);
    expect((await call(method, url, await headersFor(null, true), payload)).statusCode).toBe(401);
    expect(serviceCalls()).toBe(0);
  });
});
