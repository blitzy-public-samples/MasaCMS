import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles, loadLocalSigningKeys, verifyLocalServiceToken } from '@opt2/platform/auth';

import { UsageError, runCli } from '../../src/lib/cli.js';
import type { HarnessInvoker } from '../../src/lib/invocation.js';
import type { EnvLike } from '../../src/lib/paths.js';
import {
  CutoverRejected,
  CutoverRequestFailed,
  CutoverRequestTimeout,
  CutoverVisibilityTimeout,
  DEFAULT_POLL_MS,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  GatewayUnreachable,
  MAX_TIMEOUT_MS,
  activateVersion,
  cutoverStatus,
  main,
  type ActivateOptions,
  type CutoverClientOptions,
  type CutoverFinding,
  type CutoverInstanceView,
  type CutoverStatusView,
  type FetchLike,
} from '../../src/repro/cutover.js';
import { ensureLocalSecrets } from '../../src/repro/secrets.js';

const COMMAND = 'repro:cutover';
const USAGE = 'usage: tsx src/repro/cutover.ts (activate <vNNNN> [--timeout-s <n>] | status) [--gateway-url <url>]';
const GATEWAY_URL = 'http://gateway.test';
const STATUS_PATH = '/internal/v1/cutover/status';
const ACTIVATE_PATH = '/internal/v1/cutover/activate';
const OPERATOR_CREDENTIAL = 'Bearer operator-credential';
const HEARTBEAT_AT = '2026-06-30T08:00:00.000Z';
/** Simulated duration of every gateway request on the fake clock. */
const LATENCY_MS = 5;
/** Header names that would carry a caller-supplied conclusion instead of a credential. */
const CONCLUSION_HEADER = /role|user|tenant|site/i;
const STATUS_REQUEST = `GET ${GATEWAY_URL}${STATUS_PATH}`;
const ACTIVATE_REQUEST = `POST ${GATEWAY_URL}${ACTIVATE_PATH}`;
/** Real-time bound of the tests whose gateway stalls. */
const STALL_TIMEOUT_MS = 50;
const INVALID_TIMEOUTS = [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 2 ** 31];
/** A `--timeout-s` value whose number overflows to Infinity. */
const NINES = '9'.repeat(400);

interface Step {
  method: 'GET' | 'POST';
  path: string;
  status?: number;
  body?: unknown;
  /** Rejects the request with this reason instead of answering it. */
  reject?: unknown;
  /** Never answers (`response`), or answers 200 with a body stream that never closes (`body`); either ignores the abort signal. */
  stall?: 'response' | 'body';
  /** Answers every request after the script ends as well. */
  repeat?: boolean;
}

interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

/** Fetch serving `script` in order with real `Response` objects, recording each request and each cancelled stalled body. */
function fakeGateway(
  script: readonly Step[],
  onRequest: () => void = () => undefined,
): { fetch: FetchLike; calls: RecordedCall[]; cancelled: string[] } {
  const calls: RecordedCall[] = [];
  const cancelled: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url: input,
      path: url.pathname,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init.signal,
    });
    onRequest();
    const last = script.at(-1);
    const step = calls.length <= script.length ? script[calls.length - 1] : last?.repeat === true ? last : undefined;
    if (step === undefined) throw new Error(`unscripted request ${method} ${input}`);
    if (step.method !== method || step.path !== url.pathname) {
      throw new Error(`expected ${step.method} ${step.path}, got ${method} ${url.pathname}`);
    }
    if ('reject' in step) throw step.reject;
    if (step.stall === 'response') return new Promise<Response>(() => undefined);
    if (step.stall === 'body') {
      const stalled = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new TextEncoder().encode('{"tableVersion":')),
        cancel: () => {
          cancelled.push(`${method} ${url.pathname}`);
        },
      });
      return new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const text = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
    return new Response(text, { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls, cancelled };
}

function instance(instanceId: string, seenEpoch: number, live = true): CutoverInstanceView {
  return { instanceId, seenEpoch, heartbeatAt: HEARTBEAT_AT, live };
}

/** A complete `CutoverStatus` body as the gateway reports it. */
function statusBody(tableVersion: string | null, epoch: number, instances: CutoverInstanceView[]): CutoverStatusView {
  const seen = instances.filter((entry) => entry.live).map((entry) => entry.seenEpoch);
  return {
    tableVersion,
    previous: null,
    epoch,
    groupAuthority: { 'people-roster': 'legacy' },
    frozen: [],
    instances,
    acknowledgedEpoch: seen.length === 0 ? null : Math.min(...seen),
    inflight: [],
    sessionMode: 'legacy-primary',
  };
}

function statusStep(body: unknown, extra: Partial<Step> = {}): Step {
  return { method: 'GET', path: STATUS_PATH, body, ...extra };
}

function activateStep(status: number, body: unknown): Step {
  return { method: 'POST', path: ACTIVATE_PATH, status, body };
}

function stalledStatus(stall: NonNullable<Step['stall']>): Step {
  return { method: 'GET', path: STATUS_PATH, stall };
}

function stalledActivation(stall: NonNullable<Step['stall']>): Step {
  return { method: 'POST', path: ACTIVATE_PATH, stall };
}

/** Client options over a fake gateway, a fake operator invoker and a fake clock that advances only on requests and sleeps. */
function clientFor(script: readonly Step[], opts: { latencyMs?: number; options?: Partial<ActivateOptions> } = {}) {
  let clock = 1_000;
  const latencyMs = opts.latencyMs ?? LATENCY_MS;
  const gateway = fakeGateway(script, () => {
    clock += latencyMs;
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const headersFor = vi.fn(async (_target: { callee: string; url: string }) => ({
    'X-Serverless-Authorization': OPERATOR_CREDENTIAL,
  }));
  const invoker: HarnessInvoker = { headersFor };
  const options: ActivateOptions = {
    gatewayUrl: GATEWAY_URL,
    env: {},
    invoker,
    fetch: gateway.fetch,
    sleep,
    now: () => clock,
    ...opts.options,
  };
  return { options, calls: gateway.calls, cancelled: gateway.cancelled, sleep, headersFor };
}

function routes(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

function sleeps(sleep: ReturnType<typeof clientFor>['sleep']): number[] {
  return sleep.mock.calls.map(([ms]) => ms);
}

async function rejectionOf<T>(promise: Promise<unknown>, type: abstract new (...args: never[]) => T): Promise<T> {
  const reason = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(reason).toBeInstanceOf(type);
  return reason as T;
}

const FINDINGS: CutoverFinding[] = [
  { rule: 'previous-mismatch', message: 'previous v0001 is not the active version v0003' },
  { rule: 'write-group-authority', message: 'write entry is target while its group is legacy', route: 'admin:cusers.update', group: 'people-roster' },
];

/** v0001 active at epoch 3, then v0002 committed at epoch 4. */
const COMMIT_V0002: readonly Step[] = [
  statusStep(statusBody('v0001', 3, [instance('gw-a', 3), instance('gw-b', 3)])),
  activateStep(200, { tableVersion: 'v0002', epoch: 4 }),
];

describe('activateVersion', () => {
  it('commits the version and polls until every live instance reports the new epoch', async () => {
    const stale = instance('gw-c', 2, false);
    const { options, calls, sleep } = clientFor([
      ...COMMIT_V0002,
      statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 3), stale])),
      statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 4), stale])),
    ]);

    const result = await activateVersion('v0002', { ...options, pollMs: 100 });

    // Measured from the commit: two status reads and one poll interval.
    expect(result).toEqual({ tableVersion: 'v0002', epoch: 4, alreadyActive: false, visibleAfterMs: 2 * LATENCY_MS + 100 });
    expect(sleeps(sleep)).toEqual([100]);
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`, `POST ${ACTIVATE_PATH}`, `GET ${STATUS_PATH}`, `GET ${STATUS_PATH}`]);
    expect(calls[1]?.body).toEqual({ tableVersion: 'v0002' });
  });

  it('sends only the operator invocation credential beside the JSON headers', async () => {
    const { options, calls, headersFor } = clientFor([
      ...COMMIT_V0002,
      statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 4)])),
    ]);

    await activateVersion('v0002', options);

    const invocation = { [INVOCATION_HEADER]: OPERATOR_CREDENTIAL };
    expect(calls.map((call) => call.headers)).toEqual([
      { accept: 'application/json', ...invocation },
      { accept: 'application/json', 'content-type': 'application/json', ...invocation },
      { accept: 'application/json', ...invocation },
    ]);
    const names = calls.flatMap((call) => Object.keys(call.headers));
    expect(names).not.toContain('authorization');
    expect(names.filter((name) => name.startsWith('x-opt2-') || CONCLUSION_HEADER.test(name))).toEqual([]);
    expect(headersFor.mock.calls.map(([target]) => target)).toEqual(
      calls.map((call) => ({ callee: 'gateway', url: call.url })),
    );
  });

  it.each([
    { label: 'an empty body', body: '' },
    { label: 'a body without an epoch', body: { tableVersion: 'v0002' } },
    { label: 'a body that is not JSON', body: 'activated' },
  ])('reads the committed epoch from the status after a 2xx with $label', async ({ body }) => {
    const { options, calls } = clientFor([
      statusStep(statusBody('v0001', 8, [instance('gw-a', 8)])),
      activateStep(200, body),
      statusStep(statusBody('v0002', 9, [instance('gw-a', 8)])),
      statusStep(statusBody('v0002', 9, [instance('gw-a', 9)])),
    ]);

    const result = await activateVersion('v0002', options);

    expect(result).toMatchObject({ epoch: 9, alreadyActive: false });
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`, `POST ${ACTIVATE_PATH}`, `GET ${STATUS_PATH}`, `GET ${STATUS_PATH}`]);
  });

  it('returns without posting when the version is already active and visible', async () => {
    const { options, calls, sleep } = clientFor([statusStep(statusBody('v0002', 7, [instance('gw-a', 7), instance('gw-b', 7)]))]);

    expect(await activateVersion('v0002', options)).toEqual({
      tableVersion: 'v0002',
      epoch: 7,
      alreadyActive: true,
      visibleAfterMs: 0,
    });
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for a lagging instance without posting when the version is already active', async () => {
    const { options, calls, sleep } = clientFor([
      statusStep(statusBody('v0002', 7, [instance('gw-a', 7), instance('gw-b', 6)])),
      statusStep(statusBody('v0002', 7, [instance('gw-a', 7), instance('gw-b', 7)])),
    ]);

    const result = await activateVersion('v0002', options);

    expect(result).toEqual({ tableVersion: 'v0002', epoch: 7, alreadyActive: true, visibleAfterMs: DEFAULT_POLL_MS + LATENCY_MS });
    expect(sleeps(sleep)).toEqual([DEFAULT_POLL_MS]);
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`, `GET ${STATUS_PATH}`]);
  });

  it.each([400, 409, 422])('throws CutoverRejected with the findings of a %i answer and never polls', async (status) => {
    const { options, calls, sleep } = clientFor([COMMIT_V0002[0] as Step, activateStep(status, { findings: FINDINGS })]);

    const error = await rejectionOf(activateVersion('v0002', options), CutoverRejected);

    expect(error).toMatchObject({ name: 'CutoverRejected', tableVersion: 'v0002', status, findings: FINDINGS });
    expect(error.message).toBe(
      `gateway refused v0002 with ${status}: previous-mismatch: previous v0001 is not the active version v0003; ` +
        'write-group-authority: write entry is target while its group is legacy',
    );
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`, `POST ${ACTIVATE_PATH}`]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws CutoverRejected without findings for a 409 that carries none', async () => {
    const { options } = clientFor([COMMIT_V0002[0] as Step, activateStep(409, { error: 'conflict' })]);

    const error = await rejectionOf(activateVersion('v0002', options), CutoverRejected);

    expect(error.findings).toEqual([]);
    expect(error.message).toBe('gateway refused v0002 with 409: no findings');
  });

  it.each([
    { status: 403, body: { error: 'forbidden' }, text: '{"error":"forbidden"}' },
    { status: 500, body: { findings: FINDINGS }, text: JSON.stringify({ findings: FINDINGS }) },
    { status: 503, body: '', text: '(empty body)' },
  ])('throws CutoverRequestFailed for a $status activation answer', async ({ status, body, text }) => {
    const { options, sleep } = clientFor([COMMIT_V0002[0] as Step, activateStep(status, body)]);

    const error = await rejectionOf(activateVersion('v0002', options), CutoverRequestFailed);

    expect(error).toMatchObject({ name: 'CutoverRequestFailed', status, body: typeof body === 'string' ? body : text });
    expect(error.message).toBe(`POST ${GATEWAY_URL}${ACTIVATE_PATH} answered ${status}: ${text}`);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'an instance stays behind the epoch',
      active: 'v0002',
      epoch: 4,
      reported: [instance('gw-a', 4), instance('gw-b', 3)],
      lagging: [{ instanceId: 'gw-b', seenEpoch: 3, heartbeatAt: HEARTBEAT_AT }],
      tail: 'active version v0002, lagging instances: gw-b at epoch 3',
    },
    {
      label: 'another version becomes active',
      active: 'v0003',
      epoch: 5,
      reported: [instance('gw-a', 5), instance('gw-b', 5)],
      lagging: [],
      tail: 'active version v0003, lagging instances: none',
    },
  ])('throws CutoverVisibilityTimeout when $label, never sleeping past the bound', async ({ active, epoch, reported, lagging, tail }) => {
    const { options, sleep } = clientFor([...COMMIT_V0002, statusStep(statusBody(active, epoch, reported), { repeat: true })]);

    const error = await rejectionOf(activateVersion('v0002', { ...options, timeoutMs: 1_000, pollMs: 300 }), CutoverVisibilityTimeout);

    expect(error).toMatchObject({ tableVersion: 'v0002', epoch: 4, activeVersion: active, lagging, timeoutMs: 1_000 });
    expect(error.message).toBe(`v0002 at epoch 4 not visible after 1000 ms: ${tail}`);
    // The bound starts before the first request and each request costs one latency; the last sleep is cut to what remains.
    expect(sleeps(sleep)).toEqual([300, 300, 300, 1_000 - 6 * LATENCY_MS - 900]);
  });

  it('bounds the wait by 30 s polled every 250 ms by default', async () => {
    const { options, sleep } = clientFor(
      [...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 3)]), { repeat: true })],
      { latencyMs: 0 },
    );

    const error = await rejectionOf(activateVersion('v0002', options), CutoverVisibilityTimeout);

    expect(DEFAULT_VISIBILITY_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_POLL_MS).toBe(250);
    expect(error.timeoutMs).toBe(DEFAULT_VISIBILITY_TIMEOUT_MS);
    const slept = sleeps(sleep);
    expect(slept).toHaveLength(DEFAULT_VISIBILITY_TIMEOUT_MS / DEFAULT_POLL_MS);
    expect(slept.every((ms) => ms === DEFAULT_POLL_MS)).toBe(true);
  });

  it.each([
    { label: 'the initial status answer', script: [stalledStatus('response')], request: STATUS_REQUEST, cancelled: [] },
    {
      label: 'the initial status body',
      script: [stalledStatus('body')],
      request: STATUS_REQUEST,
      cancelled: [`GET ${STATUS_PATH}`],
    },
    { label: 'the activation answer', script: [COMMIT_V0002[0] as Step, stalledActivation('response')], request: ACTIVATE_REQUEST, cancelled: [] },
    {
      label: 'the activation body',
      script: [COMMIT_V0002[0] as Step, stalledActivation('body')],
      request: ACTIVATE_REQUEST,
      cancelled: [`POST ${ACTIVATE_PATH}`],
    },
    {
      label: 'the epoch read after a 2xx without one',
      script: [COMMIT_V0002[0] as Step, activateStep(200, ''), stalledStatus('response')],
      request: STATUS_REQUEST,
      cancelled: [],
    },
    {
      label: 'the first status read after the commit',
      script: [...COMMIT_V0002, stalledStatus('response')],
      request: STATUS_REQUEST,
      cancelled: [],
    },
  ])('throws CutoverRequestTimeout when the bound cuts $label, aborting its signal', async ({ script, request, cancelled }) => {
    const { options, calls, sleep, ...gateway } = clientFor(script);

    const error = await rejectionOf(activateVersion('v0002', { ...options, timeoutMs: STALL_TIMEOUT_MS }), CutoverRequestTimeout);

    expect(error).toMatchObject({ name: 'CutoverRequestTimeout', request, timeoutMs: STALL_TIMEOUT_MS });
    expect(error.message).toBe(`${request} did not complete within ${STALL_TIMEOUT_MS} ms`);
    expect(calls).toHaveLength(script.length);
    expect(calls.every((call) => call.signal instanceof AbortSignal && call.signal.aborted)).toBe(true);
    expect(gateway.cancelled).toEqual(cancelled);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'a poll answer after the commit',
      script: [...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 3)])), stalledStatus('response')],
      epoch: 4,
      lagging: [{ instanceId: 'gw-b', seenEpoch: 3, heartbeatAt: HEARTBEAT_AT }],
    },
    {
      label: 'a poll body after the commit',
      script: [...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 3), instance('gw-b', 4)])), stalledStatus('body')],
      epoch: 4,
      lagging: [{ instanceId: 'gw-a', seenEpoch: 3, heartbeatAt: HEARTBEAT_AT }],
    },
    {
      label: 'a poll while the already active version catches up',
      script: [statusStep(statusBody('v0002', 7, [instance('gw-a', 7), instance('gw-b', 6)])), stalledStatus('response')],
      epoch: 7,
      lagging: [{ instanceId: 'gw-b', seenEpoch: 6, heartbeatAt: HEARTBEAT_AT }],
    },
    {
      label: 'a poll interval that outlasts it, sending no further request',
      script: [...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 3)]))],
      epoch: 4,
      lagging: [{ instanceId: 'gw-b', seenEpoch: 3, heartbeatAt: HEARTBEAT_AT }],
      sleep: () => delay(2 * STALL_TIMEOUT_MS),
    },
  ])('throws CutoverVisibilityTimeout from the last status when the bound cuts $label', async ({ script, epoch, lagging, sleep }) => {
    const { options, calls } = clientFor(script, { latencyMs: 0, options: sleep === undefined ? {} : { sleep } });

    const error = await rejectionOf(activateVersion('v0002', { ...options, timeoutMs: STALL_TIMEOUT_MS, pollMs: 1 }), CutoverVisibilityTimeout);

    expect(error).toMatchObject({ tableVersion: 'v0002', epoch, activeVersion: 'v0002', lagging, timeoutMs: STALL_TIMEOUT_MS });
    expect(error.cause).toBeInstanceOf(CutoverRequestTimeout);
    expect(error.cause).toMatchObject({ request: STATUS_REQUEST, timeoutMs: STALL_TIMEOUT_MS });
    expect(calls).toHaveLength(script.length);
  });

  it('clears the bound once the version is visible, leaving every request signal unaborted', async () => {
    const { options, calls } = clientFor([...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 4)]))]);

    await activateVersion('v0002', { ...options, timeoutMs: STALL_TIMEOUT_MS });
    await delay(2 * STALL_TIMEOUT_MS);

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.signal instanceof AbortSignal && !call.signal.aborted)).toBe(true);
  });

  it.each(INVALID_TIMEOUTS)('throws RangeError for a timeoutMs of %d before any request', async (timeoutMs) => {
    const { options, calls, headersFor } = clientFor([]);

    const error = await rejectionOf(activateVersion('v0002', { ...options, timeoutMs }), RangeError);

    expect(error.message).toBe(`timeoutMs must be a positive number of at most ${MAX_TIMEOUT_MS}, got ${timeoutMs}`);
    expect(calls).toEqual([]);
    expect(headersFor).not.toHaveBeenCalled();
  });

  it.each(['v12', '0002', 'v00021', 'V0002', 'v0002 ', ''])(
    'rejects table version %j before contacting the gateway',
    async (version) => {
      const { options, calls, headersFor } = clientFor([]);

      const error = await rejectionOf(activateVersion(version, options), UsageError);

      expect(error.message).toBe(`table version must match ^v\\d{4}$, got '${version}'`);
      expect(error.usage).toBe(USAGE);
      expect(calls).toEqual([]);
      expect(headersFor).not.toHaveBeenCalled();
    },
  );
});

describe('cutoverStatus', () => {
  it('returns the reported status with every field kept as received', async () => {
    const body = {
      ...statusBody('v0002', 4, [{ ...instance('gw-a', 4), region: 'local' }]),
      frozen: ['admin:cusers.update'],
      inflight: [{ instanceId: 'gw-a', route: 'admin:cusers.update', side: 'legacy', count: 1, oldestStartedAt: HEARTBEAT_AT }],
    };
    const { options, calls } = clientFor([statusStep(body)]);

    expect(await cutoverStatus(options)).toEqual(body);
    expect(routes(calls)).toEqual([`GET ${STATUS_PATH}`]);
    expect(calls[0]?.headers).toEqual({ accept: 'application/json', [INVOCATION_HEADER]: OPERATOR_CREDENTIAL });
  });

  it('throws CutoverRequestFailed carrying the status and body of a non-2xx answer', async () => {
    const { options } = clientFor([statusStep({ error: 'unauthorized' }, { status: 401 })]);

    const error = await rejectionOf(cutoverStatus(options), CutoverRequestFailed);

    expect(error).toMatchObject({ status: 401, body: '{"error":"unauthorized"}' });
    expect(error.message).toBe(`GET ${GATEWAY_URL}${STATUS_PATH} answered 401: {"error":"unauthorized"}`);
  });

  it.each([
    { label: 'not JSON', body: '<html>gateway</html>' },
    { label: 'missing instances', body: { tableVersion: 'v0002', epoch: 4 } },
    { label: 'a negative epoch', body: statusBody('v0002', -1, []) },
    { label: 'an instance without a heartbeat', body: { tableVersion: null, epoch: 0, instances: [{ instanceId: 'gw-a', seenEpoch: 0, live: true }] } },
  ])('throws CutoverRequestFailed for a 200 whose body is $label', async ({ body }) => {
    const { options } = clientFor([statusStep(body)]);

    const error = await rejectionOf(cutoverStatus(options), CutoverRequestFailed);

    expect(error.status).toBe(200);
    expect(error.message).toContain(`GET ${GATEWAY_URL}${STATUS_PATH} answered 200 with a body that is not CutoverStatus (`);
  });

  it.each([
    { label: 'a refused connection', reason: () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), { code: 'ECONNREFUSED' }) },
    {
      label: 'a fetch failure caused by a refused connection',
      reason: () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
    },
    {
      label: 'a fetch failure caused by refused connections to several addresses',
      reason: () =>
        new TypeError('fetch failed', {
          cause: new AggregateError([
            Object.assign(new Error('connect ECONNREFUSED ::1:8100'), { code: 'ECONNREFUSED' }),
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), { code: 'ECONNREFUSED' }),
          ]),
        }),
    },
  ])('throws GatewayUnreachable for $label', async ({ reason }) => {
    const cause = reason();
    const { options } = clientFor([statusStep(undefined, { reject: cause })]);

    const error = await rejectionOf(cutoverStatus(options), GatewayUnreachable);

    expect(error).toMatchObject({ name: 'GatewayUnreachable', url: GATEWAY_URL, cause });
    expect(error.message).toContain(`gateway at ${GATEWAY_URL} refused the connection`);
  });

  it('rethrows any other fetch failure unchanged', async () => {
    const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    const { options } = clientFor([statusStep(undefined, { reject: cause })]);

    await expect(cutoverStatus(options)).rejects.toBe(cause);
  });

  it.each([
    { label: 'the status answer', script: [stalledStatus('response')], stalledInvoker: false, request: STATUS_REQUEST, cancelled: [] },
    {
      label: 'the status body',
      script: [stalledStatus('body')],
      stalledInvoker: false,
      request: STATUS_REQUEST,
      cancelled: [`GET ${STATUS_PATH}`],
    },
    { label: 'the operator credential', script: [], stalledInvoker: true, request: 'operator credential', cancelled: [] },
  ])('throws CutoverRequestTimeout when $label never completes', async ({ script, stalledInvoker, request, cancelled }) => {
    const invoker: HarnessInvoker = { headersFor: () => new Promise(() => undefined) };
    const { options, calls, ...gateway } = clientFor(script, { options: stalledInvoker ? { invoker } : {} });

    const error = await rejectionOf(cutoverStatus({ ...options, timeoutMs: STALL_TIMEOUT_MS }), CutoverRequestTimeout);

    expect(error).toMatchObject({ name: 'CutoverRequestTimeout', request, timeoutMs: STALL_TIMEOUT_MS });
    expect(calls).toHaveLength(script.length);
    expect(calls.every((call) => call.signal instanceof AbortSignal && call.signal.aborted)).toBe(true);
    expect(gateway.cancelled).toEqual(cancelled);
  });

  it.each(INVALID_TIMEOUTS)('throws RangeError for a timeoutMs of %d before any request', async (timeoutMs) => {
    const { options, calls, headersFor } = clientFor([]);

    const error = await rejectionOf(cutoverStatus({ ...options, timeoutMs }), RangeError);

    expect(error.message).toBe(`timeoutMs must be a positive number of at most ${MAX_TIMEOUT_MS}, got ${timeoutMs}`);
    expect(calls).toEqual([]);
    expect(headersFor).not.toHaveBeenCalled();
  });

  it('accepts the largest bound a Node timer honours', async () => {
    const body = statusBody('v0002', 4, [instance('gw-a', 4)]);
    const { options } = clientFor([statusStep(body)]);

    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    expect(await cutoverStatus({ ...options, timeoutMs: MAX_TIMEOUT_MS })).toEqual(body);
  });
});

describe('gateway URL', () => {
  it.each([
    { label: 'the gatewayUrl option over OPT2_GATEWAY_URL', gatewayUrl: 'http://option.test/', env: { OPT2_GATEWAY_URL: 'http://env.test' }, base: 'http://option.test' },
    { label: 'OPT2_GATEWAY_URL without an option', gatewayUrl: undefined, env: { OPT2_GATEWAY_URL: 'http://env.test//' }, base: 'http://env.test' },
    { label: 'OPT2_GATEWAY_URL when the option is empty', gatewayUrl: '', env: { OPT2_GATEWAY_URL: 'http://env.test' }, base: 'http://env.test' },
    { label: 'the fixed local gateway port otherwise', gatewayUrl: undefined, env: { OPT2_GATEWAY_URL: '' }, base: 'http://127.0.0.1:8100' },
  ])('addresses $label', async ({ gatewayUrl, env, base }) => {
    const { options, calls, headersFor } = clientFor([statusStep(statusBody('v0001', 1, []))], { options: { gatewayUrl, env } });

    await cutoverStatus(options);

    expect(calls.map((call) => call.url)).toEqual([`${base}${STATUS_PATH}`]);
    expect(headersFor).toHaveBeenCalledWith({ callee: 'gateway', url: `${base}${STATUS_PATH}` });
  });
});

describe('default operator invoker', () => {
  let state: string;

  beforeEach(async () => {
    state = await mkdtemp(path.join(os.tmpdir(), 'opt2-cutover-'));
  });

  afterEach(async () => {
    await rm(state, { recursive: true, force: true });
  });

  it('signs a local operator service token for the gateway with the generated key pair', async () => {
    const env: EnvLike = { OPT2_STATE_DIR: state };
    ensureLocalSecrets({ env });
    const { fetch, calls } = fakeGateway([statusStep(statusBody('v0001', 1, []))]);

    await cutoverStatus({ gatewayUrl: GATEWAY_URL, env, fetch });

    const header = calls[0]?.headers[INVOCATION_HEADER] ?? '';
    expect(header).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(calls[0]?.headers).not.toHaveProperty('authorization');
    const { publicKey } = await loadLocalSigningKeys(state);
    const identity = await verifyLocalServiceToken(header.slice('Bearer '.length), { publicKey, audience: 'gateway' });
    expect(identity.name).toBe('operator');
    expect(identity.roles).toContain(Roles.platformOperator);
  });

  it('sends no request when the local key pair is missing', async () => {
    const { fetch, calls } = fakeGateway([]);

    await expect(cutoverStatus({ gatewayUrl: GATEWAY_URL, env: { OPT2_STATE_DIR: state }, fetch })).rejects.toThrow(/Local secrets missing/);
    expect(calls).toEqual([]);
  });
});

describe('repro:cutover CLI', () => {
  async function runCutoverCli(argv: string[], opts: CutoverClientOptions): Promise<{ code: number; line: Record<string, unknown> }> {
    const chunks: string[] = [];
    const exit = vi.fn();
    const code = await runCli((args) => main(args, opts), {
      argv,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit,
      command: COMMAND,
    });
    expect(exit).toHaveBeenCalledWith(code);
    return { code, line: JSON.parse(chunks.join('')) as Record<string, unknown> };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([{ argv: ['activate', 'v0002'] }, { argv: ['activate', 'v0002', '--timeout-s', '2147483.647'] }])(
    'activate prints the activation result and exits 0 for $argv',
    async ({ argv }) => {
      const { options } = clientFor([...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 4)]))]);

      const { code, line } = await runCutoverCli(argv, options);

      expect(code).toBe(0);
      expect(line).toEqual({
        command: COMMAND,
        ok: true,
        code: 0,
        tableVersion: 'v0002',
        epoch: 4,
        alreadyActive: false,
        visibleAfterMs: LATENCY_MS,
      });
    },
  );

  it('status prints the cut-over status and exits 0', async () => {
    const body = statusBody('v0002', 4, [instance('gw-a', 4)]);
    const { options } = clientFor([statusStep(body)]);

    const { code, line } = await runCutoverCli(['status'], options);

    expect(code).toBe(0);
    expect(line).toEqual({ command: COMMAND, ok: true, code: 0, ...body });
  });

  it('sends requests to the --gateway-url flag over the configured URL', async () => {
    const { options, calls } = clientFor([statusStep(statusBody('v0001', 1, []))]);

    const { code } = await runCutoverCli(['status', '--gateway-url', 'http://flag.test/'], options);

    expect(code).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([`http://flag.test${STATUS_PATH}`]);
  });

  it.each([
    { argv: [], message: 'expected `activate <vNNNN>` or `status`' },
    { argv: ['status', 'v0002'], message: 'expected `activate <vNNNN>` or `status`' },
    { argv: ['activate'], message: 'expected `activate <vNNNN>` or `status`' },
    { argv: ['activate', 'v0002', 'v0003'], message: 'expected `activate <vNNNN>` or `status`' },
    { argv: ['deploy', 'v0002'], message: 'expected `activate <vNNNN>` or `status`' },
    { argv: ['status', '--timeout-s', '5'], message: '--timeout-s applies to activate only' },
    { argv: ['activate', 'v0002', '--timeout-s', '0'], message: "--timeout-s must be a positive number of seconds, got '0'" },
    { argv: ['activate', 'v0002', '--timeout-s', 'abc'], message: "--timeout-s must be a positive number of seconds, got 'abc'" },
    { argv: ['activate', 'v0002', '--timeout-s=-1'], message: "--timeout-s must be a positive number of seconds, got '-1'" },
    {
      argv: ['activate', 'v0002', '--timeout-s', NINES],
      message: `--timeout-s must be at most 2147483.647 seconds, got '${NINES}'`,
    },
    { argv: ['activate', 'v0002', '--timeout-s', '2147484'], message: "--timeout-s must be at most 2147483.647 seconds, got '2147484'" },
    { argv: ['status', '--gateway-url='], message: '--gateway-url must not be empty' },
    { argv: ['activate', 'v2'], message: "table version must match ^v\\d{4}$, got 'v2'" },
  ])('exits 2 with the usage text for $argv', async ({ argv, message }) => {
    const { options, calls } = clientFor([]);

    const { code, line } = await runCutoverCli(argv, options);

    expect(code).toBe(2);
    expect(line).toEqual({ command: COMMAND, ok: false, code: 2, error: { type: 'UsageError', message }, usage: USAGE });
    expect(calls).toEqual([]);
  });

  it('exits 2 for an unknown flag', async () => {
    const { options, calls } = clientFor([]);

    const { code, line } = await runCutoverCli(['status', '--verbose'], options);

    expect(code).toBe(2);
    expect(line).toMatchObject({ ok: false, code: 2, error: { type: 'UsageError' }, usage: USAGE });
    expect(calls).toEqual([]);
  });

  it.each([{ argv: ['--help'] }, { argv: ['status', '--help'] }, { argv: ['activate', 'v0002', '--help'] }])(
    'prints the help text and exits 0 without a request for $argv',
    async ({ argv }) => {
      const { options, calls, headersFor } = clientFor([]);
      const chunks: string[] = [];
      const exit = vi.fn();

      const code = await runCli((args) => main(args, options), {
        argv,
        stdout: { write: (chunk: string) => chunks.push(chunk) },
        exit,
        command: COMMAND,
      });

      const text = chunks.join('');
      expect(code).toBe(0);
      expect(exit).toHaveBeenCalledWith(0);
      expect(text.startsWith(`${USAGE}\n`)).toBe(true);
      expect(text).toContain('OPT2_GATEWAY_URL');
      expect(text).toContain('repro:secrets');
      expect(text).not.toMatch(/^\{/m);
      expect(calls).toEqual([]);
      expect(headersFor).not.toHaveBeenCalled();
    },
  );

  it('activate exits 1 with the findings when the gateway refuses the version', async () => {
    const { options } = clientFor([COMMIT_V0002[0] as Step, activateStep(422, { findings: FINDINGS })]);

    const { code, line } = await runCutoverCli(['activate', 'v0002'], options);

    expect(code).toBe(1);
    expect(line).toMatchObject({
      command: COMMAND,
      ok: false,
      code: 1,
      tableVersion: 'v0002',
      status: 422,
      findings: FINDINGS,
      error: { type: 'CutoverRejected' },
    });
  });

  it('activate exits 1 with the lagging instances when the version is not visible within --timeout-s', async () => {
    const { options, sleep } = clientFor(
      [...COMMIT_V0002, statusStep(statusBody('v0002', 4, [instance('gw-a', 4), instance('gw-b', 3)]), { repeat: true })],
      { latencyMs: 0 },
    );

    const { code, line } = await runCutoverCli(['activate', 'v0002', '--timeout-s', '0.5'], options);

    expect(code).toBe(1);
    expect(line).toMatchObject({
      ok: false,
      code: 1,
      tableVersion: 'v0002',
      epoch: 4,
      activeVersion: 'v0002',
      lagging: [{ instanceId: 'gw-b', seenEpoch: 3, heartbeatAt: HEARTBEAT_AT }],
      timeoutMs: 500,
      error: { type: 'CutoverVisibilityTimeout' },
    });
    expect(sleeps(sleep)).toEqual([DEFAULT_POLL_MS, DEFAULT_POLL_MS]);
  });

  it('activate exits 1 naming the stalled request when the gateway does not answer within --timeout-s', async () => {
    const { options } = clientFor([COMMIT_V0002[0] as Step, stalledActivation('response')]);

    const { code, line } = await runCutoverCli(['activate', 'v0002', '--timeout-s', '0.05'], options);

    expect(code).toBe(1);
    expect(line).toEqual({
      command: COMMAND,
      ok: false,
      code: 1,
      tableVersion: 'v0002',
      request: ACTIVATE_REQUEST,
      timeoutMs: STALL_TIMEOUT_MS,
      error: { type: 'CutoverRequestTimeout', message: `${ACTIVATE_REQUEST} did not complete within ${STALL_TIMEOUT_MS} ms` },
    });
  });

  it('status exits 1 naming the stalled request once the default 30 s bound passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { options } = clientFor([stalledStatus('response')]);
      let settled = false;
      const pending = runCutoverCli(['status'], options).finally(() => (settled = true));

      await vi.advanceTimersByTimeAsync(DEFAULT_VISIBILITY_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const { code, line } = await pending;

      expect(code).toBe(1);
      expect(line).toEqual({
        command: COMMAND,
        ok: false,
        code: 1,
        request: STATUS_REQUEST,
        timeoutMs: DEFAULT_VISIBILITY_TIMEOUT_MS,
        error: { type: 'CutoverRequestTimeout', message: `${STATUS_REQUEST} did not complete within ${DEFAULT_VISIBILITY_TIMEOUT_MS} ms` },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits 1 naming any other gateway failure', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { options } = clientFor([statusStep('', { status: 502 })]);

    const { code, line } = await runCutoverCli(['status'], options);

    expect(code).toBe(1);
    expect(line).toMatchObject({ command: COMMAND, ok: false, code: 1, error: { type: 'CutoverRequestFailed' } });
  });
});
