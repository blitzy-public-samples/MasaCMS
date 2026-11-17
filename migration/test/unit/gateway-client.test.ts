// Unit tests for the gateway cut-over client, using recording service clients whose answers are checked against the gateway contract.
import { readFileSync } from 'node:fs';

import { rolesForService } from '@opt2/platform/auth';
import { ServiceUnavailableError, fixedClock, type Clock, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { assertResponseMatchesOpenApi, findOperation } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  GATEWAY_SERVICE,
  GatewayCallError,
  GatewayWaitTimeoutError,
  createGatewayClient,
  type CutoverStatus,
  type CutoverStatusV2,
  type InflightClearRequest,
} from '../../src/cutover/gateway-client.js';

const CONTRACT = parse(readFileSync(new URL('../../../gateway/contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const STATUS_V1_PATH = '/internal/v1/cutover/status';
const STATUS_V2_PATH = '/internal/v2/cutover/status';
const ROUTE_A = 'admin:cusers.update{type=2,action=add}';
const ROUTE_B = 'fixture:people/persons/{id}/archive@post';
const OTHER_ROUTE = 'api:json.content.save';
const TS = '2026-06-30T12:00:00.000Z';

interface Recorded {
  caller: string;
  req: ServiceRequest;
}

type Responder = (req: ServiceRequest) => ServiceResponse | Promise<ServiceResponse>;

function json(status: number, body: unknown): ServiceResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

/** A recording service client; `undeclared` names the paths it answers outside the contract, as an older gateway or a failing one does. */
function fakeClient(caller: string, calls: Recorded[], respond: Responder, undeclared: ReadonlySet<string>): ServiceClient {
  return {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push({ caller, req });
      const response = await respond(req);
      // Every other fake answer must itself be a contract-valid gateway response.
      if (!undeclared.has(req.path)) {
        assertResponseMatchesOpenApi(CONTRACT, {
          method: req.method,
          path: req.path,
          status: response.status,
          contentType: 'application/json',
          body: response.body,
        });
      }
      return response as ServiceResponse<T>;
    },
    close: async () => undefined,
  };
}

function statusBody(overrides: Partial<CutoverStatus> = {}): CutoverStatus {
  return {
    tableVersion: 'v0001',
    previous: null,
    epoch: 3,
    groupAuthority: { 'grp:people.person': 'legacy' },
    frozen: [],
    instances: [
      { instanceId: 'gw-1', seenEpoch: 3, heartbeatAt: TS, live: true },
      { instanceId: 'gw-2', seenEpoch: 3, heartbeatAt: TS, live: true },
    ],
    acknowledgedEpoch: 3,
    inflight: [],
    sessionMode: 'legacy-primary',
    ...overrides,
  };
}

function statusV2Body(overrides: Partial<CutoverStatusV2> = {}): CutoverStatusV2 {
  return { ...statusBody(), inflight: [], ...overrides };
}

/** Clock advanced only by the fake sleep. */
function steppingClock(): { clock: Clock; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let now = Date.parse(TS);
  const slept: number[] = [];
  return {
    clock: { now: () => new Date(now) },
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

interface SetupOptions {
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  undeclared?: ReadonlySet<string>;
}

function setup(respond: Responder, { undeclared = new Set<string>(), ...clockAndSleep }: SetupOptions = {}) {
  const calls: Recorded[] = [];
  const gateway = createGatewayClient({
    migrationClient: fakeClient('migration', calls, respond, undeclared),
    operatorClient: fakeClient('operator', calls, respond, undeclared),
    ...clockAndSleep,
  });
  return { gateway, calls };
}

/** Asserts each call reached the operation and caller the contract requires. */
function expectContractCalls(calls: Recorded[], expected: { caller: string; operationId: string }[]): void {
  expect(calls.map((c) => c.caller)).toEqual(expected.map((e) => e.caller));
  calls.forEach(({ caller, req }, index) => {
    const { operation } = findOperation(CONTRACT, req.method, req.path);
    expect(operation.operationId).toBe(expected[index]?.operationId);
    const requires = operation['x-opt2-requires'] as string[];
    expect(rolesForService(caller).some((role) => requires.includes(role))).toBe(true);
    expect(req.service).toBe(GATEWAY_SERVICE);
    expect(req.userToken).toBeNull();
  });
}

describe('gateway client calls', () => {
  it('routes status and clearOrphans through the migration caller and the rest through the operator caller', async () => {
    const { gateway, calls } = setup((req) => {
      if (req.path === '/internal/v1/cutover/activate') return json(200, { tableVersion: 'v0002', epoch: 4 });
      if (req.path === '/internal/v1/inflight:clear-orphans') return json(200, { cleared: 2 });
      return json(200, statusBody({ epoch: 5, frozen: req.path.endsWith('/freeze') ? [ROUTE_A, ROUTE_B] : [] }));
    });
    const clear: InflightClearRequest = {
      side: 'legacy',
      evidence: { kind: 'legacy-restart', holderId: 'transition-1', at: TS },
      instanceIds: ['gw-9'],
    };

    expect((await gateway.status()).epoch).toBe(5);
    expect(await gateway.activate('v0002')).toEqual({ tableVersion: 'v0002', epoch: 4 });
    expect((await gateway.freeze([ROUTE_A, ROUTE_B])).frozen).toEqual([ROUTE_A, ROUTE_B]);
    expect((await gateway.unfreeze([ROUTE_A])).epoch).toBe(5);
    expect(await gateway.clearOrphans(clear)).toEqual({ cleared: 2 });

    expectContractCalls(calls, [
      { caller: 'migration', operationId: 'cutoverStatus' },
      { caller: 'operator', operationId: 'cutoverActivate' },
      { caller: 'operator', operationId: 'cutoverFreeze' },
      { caller: 'operator', operationId: 'cutoverUnfreeze' },
      { caller: 'migration', operationId: 'inflightClearOrphans' },
    ]);
    expect(calls.map((c) => [c.req.method, c.req.path, c.req.json])).toEqual([
      ['GET', '/internal/v1/cutover/status', undefined],
      ['POST', '/internal/v1/cutover/activate', { tableVersion: 'v0002' }],
      ['POST', '/internal/v1/cutover/freeze', { routes: [ROUTE_A, ROUTE_B] }],
      ['POST', '/internal/v1/cutover/unfreeze', { routes: [ROUTE_A] }],
      ['POST', '/internal/v1/inflight:clear-orphans', clear],
    ]);
  });

  it.each([
    { status: 400, body: { findings: [{ rule: 'unknown-version', message: 'No version file v0009' }] } },
    { status: 409, body: { findings: [{ rule: 'previous-mismatch', message: 'previous v0001 is not active' }] } },
    { status: 403, body: { apiversion: 'v1', method: 'cutoverActivate', error: { code: 'forbidden', message: 'Forbidden' } } },
  ])('surfaces a $status activation answer as GatewayCallError with the body unchanged', async ({ status, body }) => {
    const { gateway } = setup(() => json(status, body));
    const error = await gateway.activate('v0009').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayCallError);
    expect(error).toMatchObject({ operation: 'cutoverActivate', status, body });
  });

  it.each([
    { label: 'the timeoutMs it is given', options: { timeoutMs: 1_250 }, timeoutMs: 1_250 },
    { label: "the service client's timeout without one", options: undefined, timeoutMs: undefined },
  ])('bounds a status call by $label', async ({ options, timeoutMs }) => {
    const { gateway, calls } = setup(() => json(200, statusBody()));
    await gateway.status(options);
    expect(calls.map((c) => c.req.timeoutMs)).toEqual([timeoutMs]);
  });

  it('propagates transport failures unchanged', async () => {
    const unavailable = new ServiceUnavailableError('gateway', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    const { gateway } = setup(() => {
      throw unavailable;
    });
    await expect(gateway.status()).rejects.toBe(unavailable);
  });
});

describe('awaitEpoch', () => {
  it('resolves with the first status in which every live instance has seen the epoch, ignoring dead ones', async () => {
    const statuses = [
      statusBody({ epoch: 4, instances: [{ instanceId: 'gw-1', seenEpoch: 3, heartbeatAt: TS, live: true }] }),
      statusBody({
        epoch: 4,
        instances: [
          { instanceId: 'gw-1', seenEpoch: 4, heartbeatAt: TS, live: true },
          { instanceId: 'gw-dead', seenEpoch: 1, heartbeatAt: TS, live: false },
        ],
      }),
    ];
    const timing = steppingClock();
    const { gateway, calls } = setup(() => json(200, statuses.shift()), timing);
    const reached = await gateway.awaitEpoch(4, { timeoutMs: 1000, intervalMs: 100 });
    expect(reached.instances[0]?.seenEpoch).toBe(4);
    expect(calls).toHaveLength(2);
    expect(timing.slept).toEqual([100]);
  });

  it('times out naming only the lagging live instances', async () => {
    const lagging = statusBody({
      epoch: 6,
      instances: [
        { instanceId: 'gw-1', seenEpoch: 6, heartbeatAt: TS, live: true },
        { instanceId: 'gw-2', seenEpoch: 5, heartbeatAt: TS, live: true },
        { instanceId: 'gw-dead', seenEpoch: 2, heartbeatAt: TS, live: false },
      ],
    });
    const timing = steppingClock();
    const { gateway, calls } = setup(() => json(200, lagging), timing);
    const error = await gateway.awaitEpoch(6, { timeoutMs: 250, intervalMs: 100 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayWaitTimeoutError);
    expect(error).toMatchObject({ kind: 'epoch', epoch: 6, lagging: [{ instanceId: 'gw-2', seenEpoch: 5 }] });
    expect((error as Error).message).toContain('gw-2');
    expect(calls).toHaveLength(4);
    expect(timing.slept).toEqual([100, 100, 100]);
  });

  it('waits with the system clock and timer by default', async () => {
    const statuses = [statusBody({ epoch: 8 }), statusBody({ epoch: 8, instances: [{ instanceId: 'gw-1', seenEpoch: 8, heartbeatAt: TS, live: true }] })];
    const { gateway, calls } = setup(() => json(200, statuses.shift()));
    const started = Date.now();
    await gateway.awaitEpoch(8, { timeoutMs: 5000, intervalMs: 20 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(calls).toHaveLength(2);
  });

  it('polls once and times out at once with a fixed clock and a zero budget', async () => {
    const { gateway, calls } = setup(() => json(200, statusBody({ epoch: 7 })), {
      clock: fixedClock(TS),
      sleep: () => Promise.reject(new Error('must not sleep')),
    });
    await expect(gateway.awaitEpoch(7, { timeoutMs: 0, intervalMs: 50 })).rejects.toBeInstanceOf(GatewayWaitTimeoutError);
    expect(calls).toHaveLength(1);
  });
});

describe('awaitInflightDrained', () => {
  const instances: CutoverStatus['instances'] = [
    { instanceId: 'gw-1', seenEpoch: 3, heartbeatAt: TS, live: true },
    { instanceId: 'gw-dead', seenEpoch: 3, heartbeatAt: TS, live: false },
  ];
  const orphanRow = { instanceId: 'gw-dead', route: ROUTE_A, side: 'legacy', count: 1, oldestStartedAt: TS, orphaned: true } as const;
  const vanishedRow = { instanceId: 'gw-gone', route: ROUTE_B, side: 'target', count: 2, oldestStartedAt: TS, orphaned: true } as const;
  const liveRow = { instanceId: 'gw-1', route: ROUTE_B, side: 'target', count: 1, oldestStartedAt: TS, orphaned: false } as const;
  const abandonedRow = { ...liveRow, orphaned: true } as const;
  const unrelatedLiveRow = { instanceId: 'gw-1', route: OTHER_ROUTE, side: 'legacy', count: 3, oldestStartedAt: TS, orphaned: false } as const;

  it("returns a live instance's abandoned rows as orphans at once, without waiting for them", async () => {
    const { gateway, calls } = setup(() => json(200, statusV2Body({ instances, inflight: [abandonedRow, unrelatedLiveRow] })), steppingClock());
    expect(await gateway.awaitInflightDrained([ROUTE_B], { timeoutMs: 1000, intervalMs: 200 })).toEqual({ orphans: [abandonedRow] });
    expectContractCalls(calls, [{ caller: 'migration', operationId: 'cutoverStatusV2' }]);
  });

  it('returns rows of dead or unlisted instances as orphans once live rows on the routes have drained', async () => {
    const statuses = [
      statusV2Body({ instances, inflight: [orphanRow, liveRow, unrelatedLiveRow] }),
      statusV2Body({ instances, inflight: [orphanRow, vanishedRow, unrelatedLiveRow] }),
    ];
    const timing = steppingClock();
    const { gateway, calls } = setup(() => json(200, statuses.shift()), timing);
    const result = await gateway.awaitInflightDrained([ROUTE_A, ROUTE_B], { timeoutMs: 1000, intervalMs: 200 });
    expect(result).toEqual({ orphans: [orphanRow, vanishedRow] });
    expect(calls).toHaveLength(2);
    expect(timing.slept).toEqual([200]);
  });

  it('resolves with no orphans when nothing is in flight on the routes', async () => {
    const { gateway } = setup(() => json(200, statusV2Body({ instances, inflight: [unrelatedLiveRow] })), steppingClock());
    expect(await gateway.awaitInflightDrained([ROUTE_A], { timeoutMs: 0, intervalMs: 10 })).toEqual({ orphans: [] });
  });

  it('times out naming the live rows still present', async () => {
    const { gateway } = setup(() => json(200, statusV2Body({ instances, inflight: [orphanRow, liveRow] })), steppingClock());
    const error = await gateway.awaitInflightDrained([ROUTE_A, ROUTE_B], { timeoutMs: 300, intervalMs: 100 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayWaitTimeoutError);
    expect(error).toMatchObject({ kind: 'inflight', pending: [liveRow] });
    expect((error as Error).message).toContain(ROUTE_B);
  });

  it("drains against a gateway without cutoverStatusV2, the rows of instances not live its orphans and a live instance's rows awaited", async () => {
    const v1Rows = (rows: readonly (typeof orphanRow | typeof liveRow)[]): CutoverStatus['inflight'] =>
      rows.map(({ orphaned: _orphaned, ...row }) => row);
    const statuses = [statusBody({ instances, inflight: v1Rows([orphanRow, liveRow]) }), statusBody({ instances, inflight: v1Rows([orphanRow]) })];
    const timing = steppingClock();
    const redirect: ServiceResponse = { status: 301, headers: { location: `${STATUS_V2_PATH}/` }, body: '' };
    const { gateway, calls } = setup((req) => (req.path === STATUS_V2_PATH ? redirect : json(200, statuses.shift())), {
      ...timing,
      undeclared: new Set([STATUS_V2_PATH]),
    });

    const result = await gateway.awaitInflightDrained([ROUTE_A, ROUTE_B], { timeoutMs: 30_000, intervalMs: 1000 });

    expect(result).toEqual({ orphans: [orphanRow] });
    expect(timing.slept).toEqual([1000]);
    expect(calls.map((c) => c.req.path)).toEqual([STATUS_V2_PATH, STATUS_V1_PATH, STATUS_V2_PATH, STATUS_V1_PATH]);
  });
});

describe('inflightStatus', () => {
  const instances: CutoverStatus['instances'] = [
    { instanceId: 'gw-live', seenEpoch: 3, heartbeatAt: TS, live: true },
    { instanceId: 'gw-dead', seenEpoch: 3, heartbeatAt: TS, live: false },
  ];
  const group = { route: ROUTE_B, side: 'target', count: 1, oldestStartedAt: TS } as const;

  it("reads cutoverStatusV2, which reports a live instance's abandoned rows orphaned", async () => {
    const inflight = [
      { ...group, instanceId: 'gw-live', orphaned: false },
      { ...group, instanceId: 'gw-live', orphaned: true },
    ];
    const { gateway, calls } = setup(() => json(200, statusV2Body({ instances, inflight })));

    expect(await gateway.inflightStatus()).toEqual({ instances, inflight });
    expectContractCalls(calls, [{ caller: 'migration', operationId: 'cutoverStatusV2' }]);
  });

  // An older gateway forwards the unknown path to legacy, which redirects it to a trailing slash or answers 404.
  it.each([
    { label: '404', answer: json(404, '<html>Not Found</html>') },
    { label: "legacy's 301", answer: { status: 301, headers: { location: `${STATUS_V2_PATH}/` }, body: '' } },
  ])('reads cutoverStatus from a gateway that answers cutoverStatusV2 with $label, orphaning exactly the rows of instances not live', async ({ answer }) => {
    const inflight = [
      { ...group, instanceId: 'gw-dead' },
      { ...group, instanceId: 'gw-gone' },
      { ...group, instanceId: 'gw-live' },
    ];
    const { gateway, calls } = setup((req) => (req.path === STATUS_V2_PATH ? answer : json(200, statusBody({ instances, inflight }))), {
      undeclared: new Set([STATUS_V2_PATH]),
    });

    expect(await gateway.inflightStatus()).toEqual({
      instances,
      inflight: inflight.map((row) => ({ ...row, orphaned: row.instanceId !== 'gw-live' })),
    });
    expect(calls.map((c) => [c.caller, c.req.method, c.req.path])).toEqual([
      ['migration', 'GET', STATUS_V2_PATH],
      ['migration', 'GET', STATUS_V1_PATH],
    ]);
  });

  it.each([
    {
      label: 'a refusal other than 404',
      respond: (): ServiceResponse => json(403, { apiversion: 'v1', method: 'cutoverStatusV2', error: { code: 'forbidden', message: 'Forbidden' } }),
      expected: (error: unknown) => expect(error).toMatchObject({ name: 'GatewayCallError', operation: 'cutoverStatusV2', status: 403 }),
    },
    {
      label: 'a server error',
      respond: (): ServiceResponse => json(500, { apiversion: 'v1', method: 'cutoverStatusV2', error: { code: 'server_error', message: 'Unhandled Exception' } }),
      expected: (error: unknown) => expect(error).toMatchObject({ name: 'GatewayCallError', operation: 'cutoverStatusV2', status: 500 }),
    },
    {
      label: 'a transport failure',
      respond: (): ServiceResponse => {
        throw new ServiceUnavailableError('gateway', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      },
      expected: (error: unknown) => expect(error).toBeInstanceOf(ServiceUnavailableError),
    },
  ])('propagates $label of cutoverStatusV2 without reading cutoverStatus', async ({ respond, expected }) => {
    const { gateway, calls } = setup(respond, { undeclared: new Set([STATUS_V2_PATH]) });

    expected(await gateway.inflightStatus().catch((error: unknown) => error));
    expect(calls.map((c) => c.req.path)).toEqual([STATUS_V2_PATH]);
  });
});
