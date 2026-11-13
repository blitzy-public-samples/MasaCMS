// Unit tests for the write-window routes over a fake window service: declarations against the contract, each declared answer,
// the verb routes reaching their own handlers with the bare id, and auth.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, findOperation, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { components } from '../../src/generated/openapi.js';
import { UnknownUnitError } from '../../src/owners/index.js';
import { WINDOW_ROUTES, registerWindowRoutes, type WindowRouteDeps } from '../../src/routes/windows.js';
import { WindowNotFoundError, WindowRefusedError, WindowStateError } from '../../src/windows/index.js';

type Schemas = components['schemas'];
type Operation = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};

const ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const OPEN_URL = '/internal/v1/windows';
const GET_URL = `/internal/v1/windows/${ID}`;
const COMPLETE_URL = `/internal/v1/windows/${ID}:complete`;
const RESOLVE_URL = `/internal/v1/windows/${ID}:resolve`;

const OPEN_BODY: Schemas['WindowOpenRequest'] = {
  routeKey: 'admin:cusers.update{type=2,action=delete}',
  units: ['people.person', 'identity.user_account'],
  scope: { keys: { userid: 'A1B2C3D4-E5F6-4789-ABCDEF0123456789' } },
  requestId: 'req-1',
};

const WINDOW: Schemas['WriteWindow'] = {
  windowId: ID,
  routeKey: OPEN_BODY.routeKey,
  units: ['identity.user_account', 'people.person'],
  scope: OPEN_BODY.scope,
  state: 'closed',
  phase: 'importing',
  phases: [
    { phase: 'quiet', at: '2026-06-30T12:00:00.000Z' },
    { phase: 'executing', at: '2026-06-30T12:00:01.000Z' },
    { phase: 'importing', at: '2026-06-30T12:00:02.000Z' },
    { phase: 'closed', at: '2026-06-30T12:00:03.000Z' },
  ],
  rowsImported: 2,
  outcome: 'resolved',
};

const windows = {
  open: vi.fn<WindowRouteDeps['windows']['open']>(),
  complete: vi.fn<WindowRouteDeps['windows']['complete']>(),
  get: vi.fn<WindowRouteDeps['windows']['get']>(),
  resolve: vi.fn<WindowRouteDeps['windows']['resolve']>(),
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
  registerWindowRoutes(app, { windows });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  windows.open.mockReset().mockResolvedValue({ windowId: ID, state: 'open', phase: 'executing' });
  windows.complete.mockReset().mockResolvedValue({ state: 'closed' });
  windows.get.mockReset().mockResolvedValue(WINDOW);
  windows.resolve.mockReset().mockResolvedValue(WINDOW);
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

const asGateway = () => headersFor('gateway');
const asOperator = () => headersFor('operator');
const serviceCalls = () => windows.open.mock.calls.length + windows.complete.mock.calls.length + windows.get.mock.calls.length + windows.resolve.mock.calls.length;

describe('route declaration', () => {
  const contractWindowOperations = Object.entries(OPENAPI.paths)
    .filter(([path]) => path.startsWith('/internal/v1/windows'))
    .flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((verb) => {
        const operation = item[verb];
        return operation === undefined ? [] : [{ operationId: String(operation.operationId), method: verb.toUpperCase(), path }];
      }),
    );

  it("exports exactly the contract's window operations with their operation id, method and path", () => {
    const byId = (a: { operationId: string }, b: { operationId: string }) => a.operationId.localeCompare(b.operationId);
    expect(WINDOW_ROUTES.map(({ operationId, method, path }) => ({ operationId, method, path })).sort(byId)).toEqual(contractWindowOperations.sort(byId));
  });

  it('registers exactly these operations, each with the contract transport, roles and site check', () => {
    const registered = collectRouteMatrix(app).routes.filter((route) => route.url !== '/healthz');
    expect(registered.map(({ method, url }) => `${method} ${url}`).sort()).toEqual(WINDOW_ROUTES.map(({ method, url }) => `${method} ${url}`).sort());
    for (const { operationId, method, path, url } of WINDOW_ROUTES) {
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

describe('windowOpen', () => {
  it('opens the window with the validated body and answers 201', async () => {
    const res = await call('POST', OPEN_URL, await asGateway(), OPEN_BODY);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ windowId: ID, state: 'open', phase: 'executing' });
    expect(windows.open).toHaveBeenCalledExactlyOnceWith(OPEN_BODY);
  });

  it.each([
    ['no request id', { ...OPEN_BODY, requestId: undefined }],
    ['an empty route key', { ...OPEN_BODY, routeKey: '' }],
    ['no units', { ...OPEN_BODY, units: [] }],
    ['a repeated unit', { ...OPEN_BODY, units: ['people.person', 'people.person'] }],
    ['a unit that is not <schema>.<table>', { ...OPEN_BODY, units: ['People.Person'] }],
    ['a table scope that is false', { ...OPEN_BODY, scope: { table: false } }],
    ['an empty key scope', { ...OPEN_BODY, scope: { keys: {} } }],
    ['both scope forms', { ...OPEN_BODY, scope: { table: true, keys: { siteid: 'tenant-a' } } }],
    ['an undeclared key', { ...OPEN_BODY, kind: 'startup' }],
  ])('answers %s with the legacy 400 without opening', async (_label, body) => {
    const res = await call('POST', OPEN_URL, await asGateway(), body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(windows.open).not.toHaveBeenCalled();
  });

  it('answers a unit the ownership file does not name with the legacy 400', async () => {
    windows.open.mockRejectedValueOnce(new UnknownUnitError('people.unknown_table'));

    const res = await call('POST', OPEN_URL, await asGateway(), { ...OPEN_BODY, units: ['people.unknown_table'] });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  it('answers a refused open with the legacy server_error 503', async () => {
    windows.open.mockRejectedValueOnce(new WindowRefusedError(ID, 'lease-unavailable', new Error('units held by a transition')));

    const res = await call('POST', OPEN_URL, await asGateway(), OPEN_BODY);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } });
  });

});

describe('other failures', () => {
  it.each([
    ['open', 'POST', OPEN_URL, OPEN_BODY, new Error('connection terminated')],
    ['get', 'GET', GET_URL, undefined, new Error('connection terminated')],
    ['complete', 'POST', COMPLETE_URL, { forwarded: true }, new WindowStateError(ID, 'opening', 'complete')],
    ['resolve', 'POST', RESOLVE_URL, undefined, new Error('connection terminated')],
  ] as const)('propagate from %s as a server error', async (operation, method, url, payload, error) => {
    windows[operation].mockRejectedValueOnce(error);

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await app.inject({ method, url, headers: await asOperator(), ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
  });
});

describe('windowGet', () => {
  it('answers the window', async () => {
    const res = await call('GET', GET_URL, await asOperator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(WINDOW);
    expect(windows.get).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('answers an id that names no window with the legacy 404', async () => {
    windows.get.mockRejectedValueOnce(new WindowNotFoundError(ID));

    const res = await call('GET', GET_URL, await asGateway());

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { message: `No write window ${ID}`, code: 'invalid_request' } });
  });
});

describe('windowComplete', () => {
  it.each([
    [{ forwarded: true, legacyStatus: 302 }, 'closed'],
    [{ forwarded: false }, 'closed'],
    [{ forwarded: true, legacyStatus: 200 }, 'import-pending'],
  ] as const)('passes %j to the service and answers its state', async (body, state) => {
    windows.complete.mockResolvedValueOnce({ state });

    const res = await call('POST', COMPLETE_URL, await asGateway(), body);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state });
    expect(windows.complete).toHaveBeenCalledExactlyOnceWith(ID, body);
  });

  it('answers an id that names no window with `unknown`', async () => {
    windows.complete.mockRejectedValueOnce(new WindowNotFoundError(ID));

    const res = await call('POST', COMPLETE_URL, await asGateway(), { forwarded: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'unknown' });
  });

  it.each([
    ['no forwarded flag', {}],
    ['a legacy status outside 100-599', { forwarded: true, legacyStatus: 600 }],
    ['a fractional legacy status', { forwarded: true, legacyStatus: 200.5 }],
    ['an undeclared key', { forwarded: true, units: ['people.person'] }],
  ])('answers %s with the legacy 400 without completing', async (_label, body) => {
    const res = await call('POST', COMPLETE_URL, await asGateway(), body);

    expect(res.statusCode).toBe(400);
    expect(windows.complete).not.toHaveBeenCalled();
  });
});

describe('windowResolve', () => {
  it('resolves the window as the verified operator and answers it', async () => {
    const res = await call('POST', RESOLVE_URL, await asOperator());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(WINDOW);
    expect(windows.resolve).toHaveBeenCalledExactlyOnceWith(ID, { actor: 'operator' });
  });

  it.each([
    [404, new WindowNotFoundError(ID), `No write window ${ID}`],
    [409, new WindowStateError(ID, 'open', 'resolve'), `Write window ${ID} is open; cannot resolve`],
  ])('answers %i with the legacy error envelope', async (status, error, message) => {
    windows.resolve.mockRejectedValueOnce(error);

    const res = await call('POST', RESOLVE_URL, await asOperator());

    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ apiversion: 'v1', method: 'invalid', error: { message, code: 'invalid_request' } });
  });
});

describe('window ids in the path', () => {
  it('routes `:complete` and `:resolve` to their own handlers with the bare id', async () => {
    await call('POST', COMPLETE_URL, await asOperator(), { forwarded: false });
    await call('POST', RESOLVE_URL, await asOperator());

    expect(windows.complete.mock.calls).toEqual([[ID, { forwarded: false }]]);
    expect(windows.resolve.mock.calls).toEqual([[ID, { actor: 'operator' }]]);
    expect(windows.get).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', `/internal/v1/windows/${ID.toLowerCase()}`, undefined, 404],
    ['GET', `/internal/v1/windows/${ID}:complete`, undefined, 404],
    ['POST', '/internal/v1/windows/not-a-window:resolve', undefined, 404],
    ['POST', '/internal/v1/windows/not-a-window:complete', { forwarded: true }, 200],
  ] as const)('treats %s %s, which is no CF UUID, as naming no window without a service call', async (method, url, payload, status) => {
    const res = await call(method, url, await asOperator(), payload);

    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.json()).toEqual({ state: 'unknown' });
    expect(serviceCalls()).toBe(0);
  });
});

describe('auth', () => {
  const probes = [
    ['POST', OPEN_URL, OPEN_BODY, 201, ['gateway', 'operator']],
    ['GET', GET_URL, undefined, 200, ['gateway', 'operator']],
    ['POST', COMPLETE_URL, { forwarded: true }, 200, ['gateway', 'operator']],
    ['POST', RESOLVE_URL, undefined, 200, ['operator']],
  ] as const;

  it.each(probes)('%s %s admits only its listed workloads', async (method, url, payload, status, admitted) => {
    for (const caller of ['gateway', 'operator', 'migration', 'programs-sites', 'people']) {
      const res = await call(method, url, await headersFor(caller), payload);
      expect({ caller, status: res.statusCode }).toEqual({ caller, status: (admitted as readonly string[]).includes(caller) ? status : 403 });
    }
    expect(serviceCalls()).toBe(admitted.length);
  });

  it.each(probes)('%s %s refuses anonymous requests and user tokens without an invocation credential', async (method, url, payload) => {
    expect((await call(method, url, await headersFor(null), payload)).statusCode).toBe(401);
    expect((await call(method, url, await headersFor(null, true), payload)).statusCode).toBe(401);
    expect(serviceCalls()).toBe(0);
  });
});
