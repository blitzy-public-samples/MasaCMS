// Unit tests for the `projectionAwait` route over a fake projector, and over a real awaiter reading an HTTP owner: both request forms, the default budget, contract shape, the legacy 400 and 503, and auth denials.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import {
  ServiceUnavailableError,
  createService,
  createServiceClient,
  loadEnv,
  type FastifyInstance,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testInvocationMinter, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { createOwnersClient, type UnitCatalog } from '../../src/owners/index.js';
import { createAwaiter, type AwaiterDeps } from '../../src/reverse/await.js';
import { ProjectionTimeoutError, type AwaitProjectionRequest, type AwaitProjectionResult } from '../../src/reverse/index.js';
import { PROJECTION_ROUTES, registerProjectionRoutes, type ProjectionRouteDeps } from '../../src/routes/projection.js';

type Operation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const PATH = '/internal/v1/projection/await';
// Distinct from the contract's 5000 default, so the test shows the configured value is the one applied.
const DEFAULT_TIMEOUT_MS = 4321;

const awaitProjection = vi.fn<(req: AwaitProjectionRequest) => Promise<AwaitProjectionResult>>();
let app: FastifyInstance;

/** The migration service with only `projectionAwait` registered over `projector`. */
async function projectionApp(projector: ProjectionRouteDeps['projector']): Promise<FastifyInstance> {
  const service = await createService({
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
  registerProjectionRoutes(service, { projector, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
  await service.ready();
  return service;
}

beforeAll(async () => {
  app = await projectionApp({ awaitProjection });
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

/** Injects a POST into `target`, with `payload` as a JSON body unless undefined, and checks the answer against the contract. */
async function post(payload: unknown, headers: Record<string, string>, target: FastifyInstance = app) {
  const body = payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'content-type': 'application/json' } };
  const res = await target.inject({ method: 'POST', url: PATH, headers, ...body });
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

describe('answers over a real awaiter whose owner fails its position read', () => {
  const seen: { method?: string; url?: string; invocation: boolean }[] = [];
  let ownerStatus = 503;
  let owner: Server;
  let client: ServiceClient;
  let realApp: FastifyInstance;

  // An owners request fails at its first read, so no other port of the awaiter is reached.
  const unreached = (): Promise<never> => Promise.reject(new Error('unreached awaiter port'));
  const UNREACHED_CATALOG = new Proxy({} as UnitCatalog, {
    get(_target, member) {
      throw new Error(`catalog.${String(member)} was read`);
    },
  });

  beforeAll(async () => {
    owner = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, invocation: req.headers[INVOCATION_HEADER] !== undefined });
      res.writeHead(ownerStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'owner stub failure' }));
    });
    await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve));
    client = createServiceClient({
      serviceUrls: { people: `http://127.0.0.1:${String((owner.address() as AddressInfo).port)}` },
      self: 'migration',
      credentials: testInvocationMinter({ caller: 'migration' }),
    });
    const deps: AwaiterDeps = {
      legacy: { live: unreached },
      owners: createOwnersClient({ client, catalog: UNREACHED_CATALOG }),
      authority: unreached,
      catalog: UNREACHED_CATALOG,
      tenants: unreached,
      clock: { now: () => new Date() },
      defaults: { timeoutMs: DEFAULT_TIMEOUT_MS, pollIntervalMs: 250 },
    };
    realApp = await projectionApp(createAwaiter(deps));
  });

  afterAll(async () => {
    await realApp?.opt2.shutdown();
    await client?.close();
    owner.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      owner.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('answers an owner answering 503 with the legacy 503', async () => {
    ownerStatus = 503;

    const res = await post({ owners: ['people'] }, await headersFor('gateway'), realApp);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(seen).toEqual([{ method: 'GET', url: '/internal/v1/migration/position', invocation: true }]);
  });

  it('propagates an owner answering 500 as a server error', async () => {
    ownerStatus = 500;

    // The contract declares no 500, as for every operation, so the answer is injected without the contract check.
    const res = await realApp.inject({ method: 'POST', url: PATH, headers: await headersFor('gateway'), payload: { owners: ['people'] } });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'server_error' } });
    expect(seen).toHaveLength(1);
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
