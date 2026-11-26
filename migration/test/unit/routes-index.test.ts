// Unit tests for the migration route registry: its operations against the contract, their declarations on a composed app,
// each operation reaching the dependency `registerRoutes` binds it to, and deny-by-default for anonymous callers.
import { readFileSync } from 'node:fs';

import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { mintServiceToken, testVerifier } from '@opt2/platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { parse } from 'yaml';

import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import type { FaultRegistry } from '../../src/faults/index.js';
import { UnknownUnitError, type Unit } from '../../src/owners/index.js';
import { defaultBackgroundRecord, type BackgroundStateApi } from '../../src/quiesce/index.js';
import type { Projector } from '../../src/reverse/index.js';
import {
  AUTHORITY_ROUTES,
  BACKGROUND_ROUTES,
  FAULT_ROUTES,
  GATES_ROUTES,
  LEGACY_STEP_ROUTES,
  MIGRATION_ROUTES,
  PROBE_ROUTES,
  PROJECTION_ROUTES,
  SCHEDULER_ROUTES,
  TRANSITION_ROUTES,
  WINDOW_ROUTES,
  registerRoutes,
  type RouteDeps,
} from '../../src/routes/index.js';
import { defaultSiteMonitorRecord, type SchedulerService } from '../../src/scheduler/index.js';
import type { TransitionService } from '../../src/transition/index.js';
import type { WindowService } from '../../src/windows/index.js';

type Operation = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
};
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const CONTRACT = Object.entries(OPENAPI.paths).flatMap(([path, item]) =>
  HTTP_METHODS.flatMap((verb) => {
    const operation = item[verb];
    return operation === undefined ? [] : [{ operationId: String(operation.operationId), method: verb.toUpperCase(), path, operation }];
  }),
);

const CONFIG = loadConfig();
const NOW = new Date('2026-06-30T12:00:00.000Z');
const WINDOW_ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const TRANSITION_ID = '1A2B3C4D-5E6F-4A7B-8C9D0E1F2A3B4C5D';
const UNIT: Unit = { id: 'people.person', owner: 'people', schema: 'people', legacyTables: ['tusers'] };

// The fakes stand in for the services `server.ts` builds; each records the calls its route makes.
const windows = {
  open: vi.fn(() => Promise.resolve({ windowId: WINDOW_ID, state: 'executing' })),
  get: vi.fn(() => Promise.resolve({ windowId: WINDOW_ID, state: 'closed' })),
  complete: vi.fn(() => Promise.resolve({ state: 'closed' })),
  resolve: vi.fn(() => Promise.resolve({ windowId: WINDOW_ID, state: 'closed' })),
  runLegacyStep: vi.fn(() => Promise.resolve({ response: { job: 'emailSend', completed: true } })),
};
const projector = { awaitProjection: vi.fn(() => Promise.resolve({ positions: new Map([['people', '42']]) })) };
const transitions = {
  start: vi.fn(() => Promise.resolve({ transitionId: TRANSITION_ID, state: 'started' })),
  get: vi.fn(() => Promise.resolve({ transitionId: TRANSITION_ID, state: 'done' })),
};
const scheduler = {
  state: vi.fn(() =>
    Promise.resolve({
      stored: { sitemonitor: defaultSiteMonitorRecord(NOW), nativeTasks: null },
      live: { ping: false, siteMonitorTask: '/index.cfm/_api/sitemonitor/', tasks: [], serverTime: '2026-06-30 12:00:00' },
    }),
  ),
  importState: vi.fn(() => Promise.resolve({ imported: true })),
};
const background = {
  isSuspended: vi.fn(() => Promise.resolve(false)),
  get: vi.fn(() => Promise.resolve(defaultBackgroundRecord())),
  suspend: vi.fn((record: ReturnType<typeof defaultBackgroundRecord>) => Promise.resolve(record)),
  resume: vi.fn(() => Promise.resolve(defaultBackgroundRecord())),
};
const faults = { set: vi.fn(() => ({ name: 'projector-delay', params: { delayMs: 1 } })), clear: vi.fn(() => true) };

// The context ports the registry binds: authority reads the gateway status, gates read the lease table and the owner gate,
// and the orphan archive probe queries the live legacy database.
const gatewayStatus = vi.fn(() => Promise.resolve({ tableVersion: null, epoch: 1 }));
const legacyQuery = vi.fn((): Promise<{ recordset: { n: number }[] }> => Promise.resolve({ recordset: [] }));
const legacy = { live: () => Promise.resolve({ request: () => ({ input() { return this; }, query: legacyQuery }) }) };
const leaseQuery = vi.fn(() => Promise.resolve({ rows: [] }));
const ownerGate = vi.fn(() => Promise.resolve({ units: [{ unit: UNIT.id, state: 'open', holderId: null, phase: 'quiet' }] }));
const catalog = {
  units: vi.fn(() => [UNIT]),
  unit: vi.fn((id: string): Unit => {
    if (id !== UNIT.id) throw new UnknownUnitError(id);
    return UNIT;
  }),
};
const tx = { schema: 'migration', query: leaseQuery } as unknown as MetadataTx;
const db = { withMetadata: (fn: (t: MetadataTx) => Promise<unknown>) => fn(tx) } as unknown as TenantDb;
const ctx = { config: CONFIG, gateway: { status: gatewayStatus }, catalog, db, owners: { gate: ownerGate }, legacy } as unknown as MigrationContext;

const deps: RouteDeps = {
  ctx,
  windows: windows as unknown as WindowService,
  projector: projector as unknown as Projector,
  transitions: transitions as unknown as TransitionService,
  scheduler: scheduler as unknown as SchedulerService,
  background: background as unknown as BackgroundStateApi,
  faults: faults as unknown as FaultRegistry,
};

const ALL_MOCKS: readonly Mock[] = [
  ...Object.values(windows),
  projector.awaitProjection,
  ...Object.values(transitions),
  ...Object.values(scheduler),
  ...Object.values(background),
  ...Object.values(faults),
  gatewayStatus,
  leaseQuery,
  ownerGate,
  legacyQuery,
];

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
  registerRoutes(app, deps);
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
});

beforeEach(() => {
  for (const mock of ALL_MOCKS) mock.mockClear();
});

/** Invocation-credential headers of the local workload `caller`. */
async function as(caller: string): Promise<Record<string, string>> {
  return { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller, audience: 'migration' })}` };
}

describe('registered operations', () => {
  it('concatenates the registrar tables in registration order', () => {
    expect(MIGRATION_ROUTES).toEqual([
      ...WINDOW_ROUTES,
      ...PROBE_ROUTES,
      ...PROJECTION_ROUTES,
      ...AUTHORITY_ROUTES,
      ...LEGACY_STEP_ROUTES,
      ...GATES_ROUTES,
      ...TRANSITION_ROUTES,
      ...SCHEDULER_ROUTES,
      ...BACKGROUND_ROUTES,
      ...FAULT_ROUTES,
    ]);
    expect(Object.isFrozen(MIGRATION_ROUTES)).toBe(true);
  });

  it("equal the contract's operations together with service-kit's healthz, by operation id, method and path", () => {
    const registered = [{ operationId: 'healthz', method: 'GET', path: '/healthz' }, ...MIGRATION_ROUTES].map(
      ({ operationId, method, path }) => `${operationId} ${method} ${path}`,
    );
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.sort()).toEqual(CONTRACT.map(({ operationId, method, path }) => `${operationId} ${method} ${path}`).sort());
  });

  it('are declared on the composed app with the transport, roles and site check of their contract operation', () => {
    // `requires` is an any-of set, so its order is not compared.
    const declared = collectRouteMatrix(app).routes.map((route) => ({ ...route, ...(route.requires ? { requires: [...route.requires].sort() } : {}) }));
    const expected = [
      { method: 'GET', url: '/healthz', transport: 'service', public: true, invocationOptional: true, siteCheck: true },
      ...MIGRATION_ROUTES.map(({ method, path, url }) => {
        const operation = CONTRACT.find((entry) => entry.method === method && entry.path === path)?.operation ?? {};
        return {
          method,
          url,
          transport: operation['x-opt2-transport'],
          requires: [...(operation['x-opt2-requires'] as string[])].sort(),
          siteCheck: operation['x-opt2-site-check'] !== false,
        };
      }),
    ];
    const byRoute = (a: { method: string; url: string }, b: { method: string; url: string }) =>
      `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`, 'en');
    expect(declared.sort(byRoute)).toEqual(expected.sort(byRoute));
  });
});

/** One request per operation with the caller and body that reach its dependency. */
interface DispatchCase {
  operationId: string;
  method: Method;
  url: string;
  caller: string;
  payload?: Record<string, unknown>;
  status: number;
  reached: readonly Mock[];
}

const DISPATCH: readonly DispatchCase[] = [
  {
    operationId: 'windowOpen',
    method: 'POST',
    url: '/internal/v1/windows',
    caller: 'gateway',
    payload: { routeKey: 'cusers.update{type=2,action=Delete}', units: [UNIT.id], scope: { table: true }, requestId: 'req-1' },
    status: 201,
    reached: [windows.open],
  },
  { operationId: 'windowGet', method: 'GET', url: `/internal/v1/windows/${WINDOW_ID}`, caller: 'gateway', status: 200, reached: [windows.get] },
  {
    operationId: 'windowComplete',
    method: 'POST',
    url: `/internal/v1/windows/${WINDOW_ID}:complete`,
    caller: 'gateway',
    payload: { forwarded: true, legacyStatus: 200 },
    status: 200,
    reached: [windows.complete],
  },
  {
    operationId: 'windowResolve',
    method: 'POST',
    url: `/internal/v1/windows/${WINDOW_ID}:resolve`,
    caller: 'operator',
    status: 200,
    reached: [windows.resolve],
  },
  {
    operationId: 'orphanArchiveProbe',
    method: 'POST',
    url: '/internal/v1/probes/orphan-archive',
    caller: 'gateway',
    payload: { filenames: ['about/team'] },
    status: 200,
    reached: [legacyQuery],
  },
  {
    operationId: 'projectionAwait',
    method: 'POST',
    url: '/internal/v1/projection/await',
    caller: 'gateway',
    payload: { owners: ['people'] },
    status: 200,
    reached: [projector.awaitProjection],
  },
  {
    operationId: 'unitAuthority',
    method: 'GET',
    url: `/internal/v1/authority?units=${UNIT.id}`,
    caller: 'programs-sites',
    status: 200,
    reached: [gatewayStatus],
  },
  {
    operationId: 'legacyStepRun',
    method: 'POST',
    url: '/internal/v1/legacy-steps',
    caller: 'programs-sites',
    payload: { step: 'emailSend', theTime: '2026-06-30 12:00:00', lastMonitored: '2026-06-30 11:45:00', deadlineAt: '2026-06-30T12:10:00Z' },
    status: 200,
    reached: [windows.runLegacyStep],
  },
  {
    operationId: 'gatesList',
    method: 'GET',
    url: `/internal/v1/gates?units=${UNIT.id}`,
    caller: 'operator',
    status: 200,
    reached: [leaseQuery, ownerGate],
  },
  {
    operationId: 'transitionStart',
    method: 'POST',
    url: '/internal/v1/transitions',
    caller: 'operator',
    payload: { toVersion: 'v0002' },
    status: 202,
    reached: [transitions.start],
  },
  {
    operationId: 'transitionGet',
    method: 'GET',
    url: `/internal/v1/transitions/${TRANSITION_ID}`,
    caller: 'operator',
    status: 200,
    reached: [transitions.get],
  },
  {
    operationId: 'schedulerStateGet',
    method: 'GET',
    url: '/internal/v1/scheduler/state',
    caller: 'operator',
    status: 200,
    reached: [scheduler.state, background.get],
  },
  {
    operationId: 'schedulerStateImport',
    method: 'POST',
    url: '/internal/v1/scheduler/state:import',
    caller: 'operator',
    payload: { nativeTasks: [], ping: false },
    status: 200,
    reached: [scheduler.importState, scheduler.state, background.get],
  },
  {
    operationId: 'backgroundSuspend',
    method: 'POST',
    url: '/internal/v1/background:suspend',
    caller: 'operator',
    payload: { ...defaultBackgroundRecord(), suspended: true, since: NOW.toISOString(), reason: 'capture' },
    status: 200,
    reached: [background.suspend],
  },
  {
    operationId: 'backgroundResume',
    method: 'POST',
    url: '/internal/v1/background:resume',
    caller: 'operator',
    status: 200,
    reached: [background.get],
  },
  {
    operationId: 'faultSet',
    method: 'PUT',
    url: '/internal/v1/faults/projector-delay',
    caller: 'operator',
    payload: { params: {} },
    status: 204,
    reached: [faults.set],
  },
  { operationId: 'faultClear', method: 'DELETE', url: '/internal/v1/faults/projector-delay', caller: 'operator', status: 204, reached: [faults.clear] },
];

describe('dispatch', () => {
  it('has one case per registered operation', () => {
    expect(DISPATCH.map(({ operationId }) => operationId)).toEqual(MIGRATION_ROUTES.map(({ operationId }) => operationId));
  });

  it.each(DISPATCH)('$operationId reaches its bound dependency', async ({ method, url, caller, payload, status, reached }) => {
    const res = await app.inject({ method, url, headers: await as(caller), ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode, res.body).toBe(status);
    for (const mock of reached) expect(mock).toHaveBeenCalled();
    for (const mock of ALL_MOCKS.filter((candidate) => !reached.includes(candidate))) expect(mock).not.toHaveBeenCalled();
  });

  it('binds the projection await budget to the configured default', async () => {
    await app.inject({ method: 'POST', url: '/internal/v1/projection/await', headers: await as('gateway'), payload: { owners: ['people'] } });
    expect(projector.awaitProjection).toHaveBeenCalledWith({ owners: ['people'], timeoutMs: CONFIG.projection.defaultAwaitTimeoutMs });
  });

  it('binds the orphan archive probe to the live legacy database', async () => {
    legacyQuery.mockResolvedValueOnce({ recordset: [{ n: 1 }] });
    const res = await app.inject({ method: 'POST', url: '/internal/v1/probes/orphan-archive', headers: await as('gateway'), payload: { filenames: ['about'] } });
    expect(res.json()).toEqual({ orphan: true });
  });

  it("binds gate reads to the owners client's status operation", async () => {
    await app.inject({ method: 'GET', url: `/internal/v1/gates?units=${UNIT.id}`, headers: await as('operator') });
    expect(ownerGate).toHaveBeenCalledWith('people', { op: 'status', units: [UNIT.id] });
  });

  it.each(DISPATCH)('$operationId refuses an anonymous caller before any dependency runs', async ({ method, url, payload }) => {
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    expect(res.statusCode).toBe(401);
    for (const mock of ALL_MOCKS) expect(mock).not.toHaveBeenCalled();
  });
});
