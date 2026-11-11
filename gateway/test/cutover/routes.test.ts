// Internal cut-over routes: registration as the contract declares it, operator and migration access, findings and orphan clearing.
import { readFile } from 'node:fs/promises';
import { INVOCATION_HEADER, Roles, recordedRoutes, rolesForService } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, testVerifier } from '@opt2/platform/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { InflightClearInput, InflightStore } from '../../src/cutover/inflight.js';
import { registerCutoverRoutes } from '../../src/cutover/routes.js';
import { ActivationRejected, CutoverConflict, type CutoverState, type CutoverStatus } from '../../src/cutover/state.js';

const ROUTE = 'admin:cusers.update{type=1}';
const AT = '2026-06-30T12:00:00.000+00:00';

const STATUS: CutoverStatus = {
  tableVersion: 'v0001',
  previous: null,
  epoch: 3,
  groupAuthority: { 'g-identity-login': 'legacy' },
  frozen: [ROUTE],
  instances: [{ instanceId: 'gw-1', seenEpoch: 3, heartbeatAt: AT, live: true }],
  acknowledgedEpoch: 3,
  inflight: [{ instanceId: 'gw-dead', route: ROUTE, side: 'target', count: 1, oldestStartedAt: AT }],
  sessionMode: 'legacy-primary',
};

const LEGACY_RESTART = { kind: 'legacy-restart', holderId: 'window-1', at: AT } as const;
const GATES_CLOSED = { kind: 'gates-closed', holderId: 'transition-1', at: AT, units: ['identity.group_account'] } as const;

type Call = [op: string, ...args: unknown[]];

interface Behaviour {
  activate?: CutoverState['activate'];
  freeze?: CutoverState['freeze'];
  clearOrphans?: InflightStore['clearOrphans'];
}

const unexpected = (op: string) => (): never => {
  throw new Error(`unexpected ${op} call`);
};

const apps: FastifyInstance[] = [];
let contract: object;

beforeAll(async () => {
  contract = parse(await readFile(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

/** A gateway app carrying only the cut-over routes over a state and registry that record their calls. */
async function cutoverApp(behaviour: Behaviour = {}): Promise<{ app: FastifyInstance; calls: Call[] }> {
  const calls: Call[] = [];
  const state: CutoverState = {
    start: unexpected('start'),
    stop: unexpected('stop'),
    active: unexpected('active'),
    epoch: unexpected('epoch'),
    readEpochForWrite: unexpected('readEpochForWrite'),
    isFrozen: unexpected('isFrozen'),
    waitUnfrozen: unexpected('waitUnfrozen'),
    awaitVisible: unexpected('awaitVisible'),
    activate(input) {
      calls.push(['activate', input]);
      return (behaviour.activate ?? (() => Promise.resolve({ tableVersion: input.tableVersion, epoch: 4 })))(input);
    },
    freeze(routes, actor) {
      calls.push(['freeze', routes, actor]);
      return (behaviour.freeze ?? (() => Promise.resolve(STATUS)))(routes, actor);
    },
    unfreeze(routes, actor) {
      calls.push(['unfreeze', routes, actor]);
      return Promise.resolve({ ...STATUS, frozen: [] });
    },
    status() {
      calls.push(['status']);
      return Promise.resolve(STATUS);
    },
  };
  const inflight: InflightStore = {
    register: unexpected('register'),
    remove: unexpected('remove'),
    list: unexpected('list'),
    summary: unexpected('summary'),
    clearOrphans(input: InflightClearInput) {
      calls.push(['clearOrphans', input]);
      return (behaviour.clearOrphans ?? (() => Promise.resolve({ cleared: 0, rows: [] })))(input);
    },
  };
  const app = await createService({
    name: 'gateway',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8100',
      OPT2_SERVICE_NAME: 'gateway',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('gateway'),
    logger: createLogger({ service: 'gateway', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  await registerCutoverRoutes(app, { state, inflight });
  await app.ready();
  return { app, calls };
}

/** Invocation credential of `caller` addressed to the gateway. */
async function credentialOf(caller: string): Promise<Record<string, string>> {
  const token = await mintServiceToken({ caller, audience: 'gateway', roles: rolesForService(caller) });
  return { [INVOCATION_HEADER]: `Bearer ${token}` };
}

/** A site-admin user token, alone or beside the gateway's own invocation credential. */
async function userHeaders(withInvocation: boolean): Promise<Record<string, string>> {
  const token = await mintUserToken({ sub: 'test-site-admin', site: 'tenant-a', roles: [Roles.systemUser, Roles.siteAdmin] });
  return { authorization: `Bearer ${token}`, ...(withInvocation ? await credentialOf('gateway') : {}) };
}

interface Probe {
  method: 'GET' | 'POST';
  url: string;
  path: string;
  payload?: object;
}

const PROBES: Record<string, Probe> = {
  cutoverActivate: { method: 'POST', url: '/internal/v1/cutover/activate', path: '/internal/v1/cutover/activate', payload: { tableVersion: 'v0002' } },
  cutoverFreeze: { method: 'POST', url: '/internal/v1/cutover/freeze', path: '/internal/v1/cutover/freeze', payload: { routes: [ROUTE] } },
  cutoverUnfreeze: { method: 'POST', url: '/internal/v1/cutover/unfreeze', path: '/internal/v1/cutover/unfreeze', payload: { routes: [ROUTE] } },
  cutoverStatus: { method: 'GET', url: '/internal/v1/cutover/status', path: '/internal/v1/cutover/status' },
  inflightClearOrphans: {
    method: 'POST',
    url: '/internal/v1/inflight::clear-orphans',
    path: '/internal/v1/inflight:clear-orphans',
    payload: { side: 'legacy', evidence: LEGACY_RESTART },
  },
};

/** Injects `probe` with `headers` (the operator's credential by default) and an optional replacement body. */
async function call(
  app: FastifyInstance,
  probe: Probe,
  opts: { headers?: Record<string, string>; payload?: object } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({
    method: probe.method,
    url: probe.path,
    headers: opts.headers ?? (await credentialOf('operator')),
    ...(probe.method === 'POST' ? { payload: opts.payload ?? probe.payload } : {}),
  });
  const body: unknown = res.body === '' ? undefined : res.json();
  expect(() =>
    assertResponseMatchesOpenApi(contract, {
      method: probe.method,
      path: probe.path,
      status: res.statusCode,
      contentType: res.headers['content-type'],
      body,
    }),
  ).not.toThrow();
  return { status: res.statusCode, body };
}

describe('registerCutoverRoutes', () => {
  it('registers exactly the five contract operations with their declared roles and transport', async () => {
    const { app } = await cutoverApp();
    const paths = (contract as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths;
    const declared = Object.entries(PROBES).map(([operationId, probe]) => {
      const operation = paths[probe.path]?.[probe.method.toLowerCase()];
      expect(operation?.operationId).toBe(operationId);
      return {
        method: probe.method,
        url: probe.url,
        config: { transport: operation?.['x-opt2-transport'], requires: operation?.['x-opt2-requires'] },
      };
    });
    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/'))).toEqual(declared);
  });

  it('activates the requested version for the calling operator', async () => {
    const { app, calls } = await cutoverApp();
    const res = await call(app, PROBES.cutoverActivate!);
    expect(res).toEqual({ status: 200, body: { tableVersion: 'v0002', epoch: 4 } });
    expect(calls).toEqual([['activate', { tableVersion: 'v0002', actor: 'operator' }]]);
  });

  it.each<[string, Error, number]>([
    ['validation findings', new ActivationRejected([{ rule: 'legacy-served-never-target', route: ROUTE, message: 'legacy-served entry is target' }]), 400],
    ['an unknown version file', new ActivationRejected([{ rule: 'unknown-version', message: 'no version file v0002.json' }]), 400],
    ['a previous mismatch', new CutoverConflict([{ rule: 'previous-mismatch', message: 'previous v0001 of v0002 is not the active version null' }]), 409],
  ])('answers %s with the findings', async (_label, error, status) => {
    const { app } = await cutoverApp({ activate: () => Promise.reject(error) });
    const res = await call(app, PROBES.cutoverActivate!);
    expect(res).toEqual({ status, body: { findings: (error as ActivationRejected).findings } });
  });

  it('answers an unexpected activation failure with the legacy 500', async () => {
    const { app } = await cutoverApp({ activate: () => Promise.reject(new Error('database lost')) });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/cutover/activate',
      headers: await credentialOf('operator'),
      payload: { tableVersion: 'v0002' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
  });

  it.each<[string, Probe, object]>([
    ['a malformed table version', PROBES.cutoverActivate!, { tableVersion: 'v2' }],
    ['an activation without a version', PROBES.cutoverActivate!, {}],
    ['an empty route list', PROBES.cutoverFreeze!, { routes: [] }],
    ['a repeated route', PROBES.cutoverUnfreeze!, { routes: [ROUTE, ROUTE] }],
    ['a route without a family', PROBES.cutoverFreeze!, { routes: ['cusers.update'] }],
  ])('rejects %s with 400 before touching the state', async (_label, probe, payload) => {
    const { app, calls } = await cutoverApp();
    const res = await call(app, probe, { payload });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(calls).toEqual([]);
  });

  it('freezes and unfreezes routes and answers the status after the new epoch', async () => {
    const { app, calls } = await cutoverApp();
    expect(await call(app, PROBES.cutoverFreeze!)).toEqual({ status: 200, body: STATUS });
    expect(await call(app, PROBES.cutoverUnfreeze!)).toEqual({ status: 200, body: { ...STATUS, frozen: [] } });
    expect(calls).toEqual([
      ['freeze', [ROUTE], 'operator'],
      ['unfreeze', [ROUTE], 'operator'],
    ]);
  });

  it('answers an unknown route with its finding', async () => {
    const finding = { rule: 'unknown-route', route: 'api:nope', message: 'api:nope is not an entry of the active version v0001' };
    const { app } = await cutoverApp({ freeze: () => Promise.reject(new ActivationRejected([finding])) });
    expect(await call(app, PROBES.cutoverFreeze!, { payload: { routes: ['api:nope'] } })).toEqual({
      status: 400,
      body: { findings: [finding] },
    });
  });

  it.each(['operator', 'migration'])('reports the status to %s', async (caller) => {
    const { app, calls } = await cutoverApp();
    expect(await call(app, PROBES.cutoverStatus!, { headers: await credentialOf(caller) })).toEqual({ status: 200, body: STATUS });
    expect(calls).toEqual([['status']]);
  });

  it('registers no HEAD sibling of the status route', async () => {
    const { app } = await cutoverApp();
    const res = await app.inject({ method: 'HEAD', url: '/internal/v1/cutover/status', headers: await credentialOf('operator') });
    expect(res.statusCode).toBe(404);
  });

  it.each<[string, string, object]>([
    ['legacy-side rows on a legacy restart', 'operator', { side: 'legacy', evidence: LEGACY_RESTART }],
    ['target-side rows of named instances once gates closed', 'migration', { side: 'target', evidence: GATES_CLOSED, instanceIds: ['gw-dead'] }],
  ])('clears %s and answers the count', async (_label, caller, payload) => {
    const row = { instanceId: 'gw-dead', requestId: 'r-1', route: ROUTE, side: 'legacy' as const, windowId: null, startedAt: AT };
    const { app, calls } = await cutoverApp({ clearOrphans: () => Promise.resolve({ cleared: 1, rows: [row] }) });
    const res = await call(app, PROBES.inflightClearOrphans!, { headers: await credentialOf(caller), payload });
    expect(res).toEqual({ status: 200, body: { cleared: 1 } });
    expect(calls).toEqual([['clearOrphans', { instanceIds: undefined, ...payload }]]);
  });

  it.each<[string, object]>([
    ['gates-closed evidence for legacy-side rows', { side: 'legacy', evidence: GATES_CLOSED }],
    ['legacy-restart evidence for target-side rows', { side: 'target', evidence: { ...LEGACY_RESTART, units: ['people.person'] } }],
    ['gates-closed evidence without units', { side: 'target', evidence: { kind: 'gates-closed', holderId: 'transition-1', at: AT } }],
    ['evidence without a holder', { side: 'legacy', evidence: { kind: 'legacy-restart', holderId: '', at: AT } }],
    ['evidence time without an offset', { side: 'legacy', evidence: { ...LEGACY_RESTART, at: '2026-06-30T12:00:00' } }],
    ['a unit outside schema.table form', { side: 'target', evidence: { ...GATES_CLOSED, units: ['Identity'] } }],
  ])('rejects %s with 400 before clearing anything', async (_label, payload) => {
    const { app, calls } = await cutoverApp();
    const res = await call(app, PROBES.inflightClearOrphans!, { payload });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
    expect(calls).toEqual([]);
  });

  describe.each(Object.entries(PROBES))('access to %s', (operationId, probe) => {
    const migrationAllowed = operationId === 'cutoverStatus' || operationId === 'inflightClearOrphans';

    it.each<[string, () => Promise<Record<string, string>>, number]>([
      ['no credential', () => Promise.resolve({}), 401],
      ['a user token alone', () => userHeaders(false), 401],
      ['a user token beside the gateway credential', () => userHeaders(true), 403],
      ['the identity credential', () => credentialOf('identity'), 403],
    ])('denies %s without calling the state', async (_label, headers, status) => {
      const { app, calls } = await cutoverApp();
      const res = await call(app, probe, { headers: await headers() });
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
      expect(calls).toEqual([]);
    });

    it(`${migrationAllowed ? 'allows' : 'denies'} the migration credential`, async () => {
      const { app, calls } = await cutoverApp();
      const res = await call(app, probe, { headers: await credentialOf('migration') });
      expect(res.status).toBe(migrationAllowed ? 200 : 403);
      expect(calls).toHaveLength(migrationAllowed ? 1 : 0);
    });
  });
});
