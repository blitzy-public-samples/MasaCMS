// Unit tests for the legacy-bridge client, using an injected capturing fetch, or a local HTTP server for its default transport,
// in place of the CFML bridge pages.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { BRIDGE_ASSERTION_HEADER, MemoryNonceStore, verifyBridgeAssertion } from '@opt2/platform/legacy-compat';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_BATCH_TIMEOUT_MS,
  BRIDGE_CALL_TIMEOUT_MS,
  BRIDGE_JOBS,
  BridgeError,
  BridgeHashMismatchError,
  BridgeTimeoutError,
  bridgeClientFromEnv,
  createBridgeClient,
  UnsupportedFileStoreError,
  type BridgeClient,
  type BridgeRequestOptions,
  type ScheduledTaskDefinition,
} from '../../src/legacy/bridge.js';

const KEY = randomBytes(32).toString('hex');
const ORIGIN = 'http://127.0.0.1:20080';
const BRIDGE_PATH = '/gateway/legacy-bridge/cfml';
const USER_AGENT = 'opt2-legacy-bridge-bot';
const SERVER_TIME = '2026-06-30T12:00:00.000';
const THE_TIME = '2026-06-30 12:00:00.000';
const LAST_MONITORED = '2026-06-30 11:45:00.000';
const FILE_ID = '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F';
const FILE_NAME = `${FILE_ID}_small.jpg`;
const FILE_BYTES = Buffer.from('legacy file bytes \u0000\u00ff', 'utf8');
const FILE_SHA = createHash('sha256').update(FILE_BYTES).digest('hex');
const ASSERTION_SHAPE = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;
// The 10 s service-call timeout and the 600 s site-monitor run deadline.
const CALL_MS = 10_000;
const BATCH_MS = 600_000;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);

const NATIVE_TASK: ScheduledTaskDefinition = {
  task: '/index.cfm/_api/sitemonitor/',
  group: 'DEFAULT',
  url: 'http://127.0.0.1/index.cfm/_api/sitemonitor/',
  port: '20080',
  interval: '900',
  startDate: '06/30/2026',
  startTime: '00:15:00',
  requestTimeOut: '600',
  operation: '',
  paused: true,
};

/** One request the client handed to `fetch`. */
interface CapturedRequest {
  url: URL;
  init: RequestInit;
  headers: Record<string, string>;
}

/** JSON answer in the bridge's response content type. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Injected `fetch` that records each request and answers with `respond`, called afresh per request. */
function capturingFetch(respond: (request: CapturedRequest) => Response | Promise<Response> = () => jsonResponse({})) {
  const requests: CapturedRequest[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const request: CapturedRequest = {
      url: new URL(input instanceof Request ? input.url : input),
      init,
      headers: { ...(init.headers as Record<string, string>) },
    };
    requests.push(request);
    return respond(request);
  });
  return { fetch, requests };
}

/** The single request recorded by `fake`. */
function onlyRequest(fake: ReturnType<typeof capturingFetch>): CapturedRequest {
  expect(fake.requests).toHaveLength(1);
  const [request] = fake.requests;
  if (request === undefined) throw new Error('no request was captured');
  return request;
}

/** Injected `fetch` that never answers and rejects with the abort reason once the request's signal aborts. */
function hangingFetch() {
  return vi.fn<typeof globalThis.fetch>(
    (_input, init = {}) =>
      new Promise<Response>((_resolve, reject) => {
        const { signal } = init;
        if (signal === undefined || signal === null) throw new Error('no signal was sent');
        signal.addEventListener('abort', () => {
          reject(signal.reason);
        });
      }),
  );
}

/** Awaits a call that must fail and returns its rejection reason. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => {
      throw new Error('expected the bridge call to reject');
    },
    (reason: unknown) => reason,
  );
}

/** One client method with the exact request it must send and the JSON it answers with. */
interface CallCase {
  label: string;
  invoke: (client: BridgeClient, opts?: BridgeRequestOptions) => Promise<unknown>;
  method: 'GET' | 'POST';
  page: 'jobs' | 'scheduler' | 'site' | 'files';
  query: [string, string][];
  op: string;
  siteId: string;
  json?: unknown;
  answer: Record<string, unknown>;
  /** The operation's default bound. */
  timeoutMs: number;
}

const CALL_CASES: CallCase[] = [
  {
    label: 'jobsRun sendReminders',
    invoke: (client, opts) => client.jobsRun('sendReminders', { theTime: THE_TIME }, opts),
    method: 'POST',
    page: 'jobs',
    query: [
      ['job', 'sendReminders'],
      ['theTime', THE_TIME],
    ],
    op: 'jobs.sendReminders',
    siteId: '',
    answer: { job: 'sendReminders', completed: true, serverTime: SERVER_TIME },
    timeoutMs: BATCH_MS,
  },
  {
    label: 'jobsRun emailSend without params',
    invoke: (client, opts) => client.jobsRun('emailSend', undefined, opts),
    method: 'POST',
    page: 'jobs',
    query: [['job', 'emailSend']],
    op: 'jobs.emailSend',
    siteId: '',
    answer: { job: 'emailSend', completed: true, serverTime: SERVER_TIME },
    timeoutMs: BATCH_MS,
  },
  {
    label: 'jobsRun trackBounces for a site',
    invoke: (client, opts) => client.jobsRun('trackBounces', { siteId: 'tenant-a' }, opts),
    method: 'POST',
    page: 'jobs',
    query: [
      ['job', 'trackBounces'],
      ['siteid', 'tenant-a'],
    ],
    op: 'jobs.trackBounces',
    siteId: 'tenant-a',
    answer: { job: 'trackBounces', siteId: 'tenant-a', completed: true, serverTime: SERVER_TIME },
    timeoutMs: BATCH_MS,
  },
  {
    label: 'jobsRun purgeDisplayWindow',
    invoke: (client, opts) =>
      client.jobsRun('purgeDisplayWindow', { lastMonitored: LAST_MONITORED, theTime: THE_TIME }, opts),
    method: 'POST',
    page: 'jobs',
    query: [
      ['job', 'purgeDisplayWindow'],
      ['theTime', THE_TIME],
      ['lastMonitored', LAST_MONITORED],
    ],
    op: 'jobs.purgeDisplayWindow',
    siteId: '',
    answer: { job: 'purgeDisplayWindow', completed: true, serverTime: SERVER_TIME },
    timeoutMs: BATCH_MS,
  },
  {
    label: 'jobsRun setCursor',
    invoke: (client, opts) => client.jobsRun('setCursor', { value: THE_TIME }, opts),
    method: 'POST',
    page: 'jobs',
    query: [
      ['job', 'setCursor'],
      ['value', THE_TIME],
    ],
    op: 'jobs.setCursor',
    siteId: '',
    answer: { job: 'setCursor', completed: true, serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'getCursor',
    invoke: (client, opts) => client.getCursor(opts),
    method: 'GET',
    page: 'jobs',
    query: [['job', 'getCursor']],
    op: 'jobs.getCursor',
    siteId: '',
    answer: { job: 'getCursor', lastMonitored: null, serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'purgeCache',
    invoke: (client, opts) => client.purgeCache('tenant-b', opts),
    method: 'POST',
    page: 'jobs',
    query: [
      ['job', 'purgeCache'],
      ['siteid', 'tenant-b'],
    ],
    op: 'jobs.purgeCache',
    siteId: 'tenant-b',
    answer: { job: 'purgeCache', siteId: 'tenant-b', completed: true, serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerDescribe',
    invoke: (client, opts) => client.schedulerDescribe(opts),
    method: 'GET',
    page: 'scheduler',
    query: [['op', 'describe']],
    op: 'scheduler.describe',
    siteId: '',
    answer: { ping: false, siteMonitorTask: NATIVE_TASK.task, tasks: [NATIVE_TASK], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerRepoint with the captured definition',
    invoke: (client, opts) => client.schedulerRepoint(NATIVE_TASK, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'repoint']],
    op: 'scheduler.repoint',
    siteId: '',
    json: NATIVE_TASK,
    answer: { op: 'repoint', tasks: [NATIVE_TASK.task], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerRepoint without a definition',
    invoke: (client, opts) => client.schedulerRepoint(undefined, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'repoint']],
    op: 'scheduler.repoint',
    siteId: '',
    json: {},
    answer: { op: 'repoint', tasks: [NATIVE_TASK.task], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerPause by prefix',
    invoke: (client, opts) => client.schedulerPause({ prefix: 'opt2-survey-' }, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'pause']],
    op: 'scheduler.pause',
    siteId: '',
    json: { prefix: 'opt2-survey-' },
    answer: { op: 'pause', tasks: ['opt2-survey-1'], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerResume by name',
    invoke: (client, opts) => client.schedulerResume({ tasks: [NATIVE_TASK.task] }, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'resume']],
    op: 'scheduler.resume',
    siteId: '',
    json: { tasks: [NATIVE_TASK.task] },
    answer: { op: 'resume', tasks: [NATIVE_TASK.task], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerDelete by name and prefix',
    invoke: (client, opts) => client.schedulerDelete({ tasks: [NATIVE_TASK.task], prefix: 'opt2-survey-' }, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'delete']],
    op: 'scheduler.delete',
    siteId: '',
    json: { tasks: [NATIVE_TASK.task], prefix: 'opt2-survey-' },
    answer: { op: 'delete', tasks: [], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'schedulerRestore',
    invoke: (client, opts) => client.schedulerRestore({ tasks: [NATIVE_TASK], repoint: true, paused: true }, opts),
    method: 'POST',
    page: 'scheduler',
    query: [['op', 'restore']],
    op: 'scheduler.restore',
    siteId: '',
    json: { tasks: [NATIVE_TASK], repoint: true, paused: true },
    answer: { op: 'restore', tasks: [NATIVE_TASK.task], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'siteRefresh',
    invoke: (client, opts) => client.siteRefresh('tenant-a', opts),
    method: 'POST',
    page: 'site',
    query: [
      ['op', 'refresh'],
      ['siteid', 'tenant-a'],
    ],
    op: 'site.refresh',
    siteId: 'tenant-a',
    answer: { refreshed: true, siteExists: false, serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'filesList',
    invoke: (client, opts) => client.filesList('default', opts),
    method: 'GET',
    page: 'files',
    query: [
      ['op', 'list'],
      ['siteid', 'default'],
    ],
    op: 'files.list',
    siteId: 'default',
    answer: {
      fileStore: 'fileDir',
      files: [
        {
          name: FILE_NAME,
          fileId: FILE_ID,
          variant: '_small',
          ext: 'jpg',
          size: FILE_BYTES.length,
          sha256: FILE_SHA,
          lastModified: SERVER_TIME,
        },
      ],
      serverTime: SERVER_TIME,
    },
    timeoutMs: BATCH_MS,
  },
  {
    label: 'filesDelete by name',
    invoke: (client, opts) => client.filesDelete('default', { name: FILE_NAME }, opts),
    method: 'POST',
    page: 'files',
    query: [
      ['op', 'delete'],
      ['siteid', 'default'],
      ['name', FILE_NAME],
    ],
    op: 'files.delete',
    siteId: 'default',
    answer: { deleted: [FILE_NAME], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
  {
    label: 'filesDelete by file id',
    invoke: (client, opts) => client.filesDelete('default', { fileId: FILE_ID }, opts),
    method: 'POST',
    page: 'files',
    query: [
      ['op', 'delete'],
      ['siteid', 'default'],
      ['fileId', FILE_ID],
    ],
    op: 'files.delete',
    siteId: 'default',
    answer: { deleted: [], serverTime: SERVER_TIME },
    timeoutMs: CALL_MS,
  },
];

/** Verifies the request's assertion with a fresh nonce store and returns its payload. */
function verifiedAssertion(request: CapturedRequest, key = KEY) {
  const value = request.headers[BRIDGE_ASSERTION_HEADER];
  expect(value).toMatch(ASSERTION_SHAPE);
  const result = verifyBridgeAssertion(value ?? '', key, new MemoryNonceStore());
  if (!result.ok) throw new Error(`bridge assertion rejected: ${result.reason}`);
  return result.payload;
}

/** The request's headers other than the assertion, after checking the assertion has the `<b64>.<mac>` shape. */
function headersBesideAssertion(request: CapturedRequest): Record<string, string> {
  const { [BRIDGE_ASSERTION_HEADER]: assertion, ...rest } = request.headers;
  expect(assertion).toMatch(ASSERTION_SHAPE);
  return rest;
}

/** Asserts that the request's signal is live, then that aborting the caller's controller aborts it with the caller's reason. */
function expectCallerAbortReaches(request: CapturedRequest, controller: AbortController): void {
  const sent = request.init.signal;
  expect(sent).toBeInstanceOf(AbortSignal);
  expect(sent).not.toBe(controller.signal);
  expect(sent?.aborted).toBe(false);
  const reason = new Error('caller cancelled');
  controller.abort(reason);
  expect(sent?.aborted).toBe(true);
  expect(sent?.reason).toBe(reason);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bridge client requests', () => {
  it.each(CALL_CASES)(
    '$label sends $method to the $page page with its exact query, headers, body and a verifiable assertion',
    async ({ invoke, method, page, query, op, siteId, json, answer }) => {
      const fake = capturingFetch(() => jsonResponse(answer));
      const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });
      const controller = new AbortController();

      await expect(invoke(client, { signal: controller.signal })).resolves.toEqual(answer);

      const request = onlyRequest(fake);
      expect(`${request.url.origin}${request.url.pathname}`).toBe(`${ORIGIN}${BRIDGE_PATH}/${page}.cfm`);
      expect([...request.url.searchParams]).toEqual(query);
      expect(request.init).toMatchObject({ method, redirect: 'manual' });
      expect(request.init).not.toHaveProperty('duplex');
      expectCallerAbortReaches(request, controller);
      expect(headersBesideAssertion(request)).toEqual({
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      });
      if (json === undefined) {
        expect(request.init.body).toBeUndefined();
      } else {
        expect(typeof request.init.body).toBe('string');
        expect(JSON.parse(request.init.body as string)).toEqual(json);
      }
      const { exp, nonce, ...claims } = verifiedAssertion(request);
      expect(claims).toEqual({ aud: 'legacy-bridge', op, sid: '', sub: '', siteId });
      expect(Number.isInteger(exp)).toBe(true);
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(request.url.searchParams.get('siteid')).toBe(siteId === '' ? null : siteId);
    },
  );

  it.each(CALL_CASES)('$label sends its default bound of $timeoutMs ms as the signal when the caller passes no options', async ({ invoke, answer, timeoutMs }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = capturingFetch(() => jsonResponse(answer));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await expect(invoke(client)).resolves.toEqual(answer);

    expect(timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs);
    expect(onlyRequest(fake).init.signal).toBe(timeout.mock.results[0]?.value);
  });

  it.each(CALL_CASES)('$label bounds the call by a caller timeoutMs instead of its default', async ({ invoke, answer }) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = capturingFetch(() => jsonResponse(answer));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await expect(invoke(client, { timeoutMs: 1_234 })).resolves.toEqual(answer);

    expect(timeout).toHaveBeenCalledExactlyOnceWith(1_234);
  });

  it.each(BRIDGE_JOBS)('jobsRun %s signs the jobs.<job> op, names the job in the query and takes its default bound', async (job) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = capturingFetch(() => jsonResponse({ job, completed: true, serverTime: SERVER_TIME }));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await client.jobsRun(job);

    const request = onlyRequest(fake);
    expect(request.url.pathname).toBe(`${BRIDGE_PATH}/jobs.cfm`);
    expect([...request.url.searchParams]).toEqual([['job', job]]);
    expect(verifiedAssertion(request).op).toBe(`jobs.${job}`);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(job === 'setCursor' ? CALL_MS : BATCH_MS);
  });

  it('filesGet sends GET without Accept and returns the bytes with their verified SHA-256', async () => {
    const fake = capturingFetch(
      () =>
        new Response(FILE_BYTES, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Opt2-Sha256': FILE_SHA },
        }),
    );
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });
    const controller = new AbortController();

    const file = await client.filesGet('default', FILE_NAME, { signal: controller.signal });

    expect(file.bytes).toBeInstanceOf(Buffer);
    expect(file.bytes.equals(FILE_BYTES)).toBe(true);
    expect(file.sha256).toBe(FILE_SHA);
    const request = onlyRequest(fake);
    expect(`${request.url.origin}${request.url.pathname}`).toBe(`${ORIGIN}${BRIDGE_PATH}/files.cfm`);
    expect([...request.url.searchParams]).toEqual([
      ['op', 'get'],
      ['siteid', 'default'],
      ['name', FILE_NAME],
    ]);
    expect(request.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expectCallerAbortReaches(request, controller);
    expect(request.init.body).toBeUndefined();
    expect(headersBesideAssertion(request)).toEqual({ 'User-Agent': USER_AGENT });
    expect(verifiedAssertion(request)).toMatchObject({ op: 'files.get', siteId: 'default', sid: '', sub: '' });
  });

  it('filesGet accepts an uppercase X-Opt2-Sha256 and is bounded by the call timeout when the caller passes no options', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = capturingFetch(
      () => new Response(FILE_BYTES, { status: 200, headers: { 'X-Opt2-Sha256': FILE_SHA.toUpperCase() } }),
    );
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await expect(client.filesGet('default', FILE_NAME)).resolves.toEqual({ bytes: FILE_BYTES, sha256: FILE_SHA });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(CALL_MS);
    expect(onlyRequest(fake).init.signal).toBe(timeout.mock.results[0]?.value);
  });

  it('filesPut sends the raw bytes as octet-stream with X-Opt2-Sha256 and returns the bridge answer', async () => {
    const answer = {
      written: true,
      name: FILE_NAME,
      size: FILE_BYTES.length,
      sha256: FILE_SHA,
      serverTime: SERVER_TIME,
    };
    const fake = capturingFetch(() => jsonResponse(answer));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });
    const controller = new AbortController();

    await expect(client.filesPut('default', FILE_NAME, FILE_BYTES, FILE_SHA, { signal: controller.signal })).resolves.toEqual(answer);

    const request = onlyRequest(fake);
    expect(`${request.url.origin}${request.url.pathname}`).toBe(`${ORIGIN}${BRIDGE_PATH}/files.cfm`);
    expect([...request.url.searchParams]).toEqual([
      ['op', 'put'],
      ['siteid', 'default'],
      ['name', FILE_NAME],
    ]);
    expect(request.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(request.init).not.toHaveProperty('duplex');
    expectCallerAbortReaches(request, controller);
    expect(request.init.body).toBe(FILE_BYTES);
    expect(headersBesideAssertion(request)).toEqual({
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-Opt2-Sha256': FILE_SHA,
    });
    expect(verifiedAssertion(request)).toMatchObject({ op: 'files.put', siteId: 'default', sid: '', sub: '' });
  });

  it('filesPut sends a Uint8Array body unchanged, bounded by the call timeout when the caller passes no options', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const bytes = new Uint8Array(FILE_BYTES);
    const fake = capturingFetch(() => jsonResponse({ written: true }));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await client.filesPut('default', FILE_NAME, bytes, FILE_SHA);

    const request = onlyRequest(fake);
    expect(request.init.body).toBe(bytes);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(CALL_MS);
    expect(request.init.signal).toBe(timeout.mock.results[0]?.value);
  });

  it('filesPut streams an iterable body half-duplex with its size as Content-Length', async () => {
    const fake = capturingFetch(() => jsonResponse({ written: true }));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield FILE_BYTES.subarray(0, 4);
      yield FILE_BYTES.subarray(4);
    }
    const body = chunks();

    await client.filesPut('default', FILE_NAME, body, FILE_SHA, { size: FILE_BYTES.length });

    const request = onlyRequest(fake);
    expect(request.init.body).toBe(body);
    expect(request.init).toMatchObject({ method: 'POST', redirect: 'manual', duplex: 'half' });
    expect(headersBesideAssertion(request)).toEqual({
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-Opt2-Sha256': FILE_SHA,
      'Content-Length': String(FILE_BYTES.length),
    });
  });
});

describe('bridge client bounds', () => {
  it('bounds calls by the 10 s service-call timeout and batch work by the 600 s site-monitor deadline', () => {
    expect(BRIDGE_CALL_TIMEOUT_MS).toBe(CALL_MS);
    expect(BRIDGE_BATCH_TIMEOUT_MS).toBe(BATCH_MS);
  });

  it('rejects with BridgeTimeoutError, after one request, when no answer arrives within timeoutMs', async () => {
    const fetch = hangingFetch();
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch });
    const started = Date.now();

    const error = await rejectionOf(client.getCursor({ timeoutMs: 30 }));

    expect(error).toBeInstanceOf(BridgeTimeoutError);
    expect(error).toMatchObject({
      name: 'BridgeTimeoutError',
      op: 'jobs.getCursor',
      timeoutMs: 30,
      message: 'legacy bridge jobs.getCursor did not answer within 30 ms',
      cause: { name: 'TimeoutError' },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (client: BridgeClient) => Promise<unknown>, string, number]>([
    ['a step job', (client) => client.jobsRun('sendReminders'), 'jobs.sendReminders', BATCH_MS],
    ['setCursor', (client) => client.jobsRun('setCursor', { value: THE_TIME }), 'jobs.setCursor', CALL_MS],
    ['files.list', (client) => client.filesList('default'), 'files.list', BATCH_MS],
    ['site.refresh', (client) => client.siteRefresh('default'), 'site.refresh', CALL_MS],
  ])('stops a hung %s at its default bound and names that bound', async (_label, invoke, op, timeoutMs) => {
    // The requested bound is recorded while a short real timeout stands in for it.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: hangingFetch() });

    await expect(rejectionOf(invoke(client))).resolves.toMatchObject({ name: 'BridgeTimeoutError', op, timeoutMs });
  });

  it.each<[string, number]>([
    ['a 2xx answer body', 200],
    ['an error answer body', 500],
  ])('rejects with BridgeTimeoutError when %s stalls past the bound', async (_label, status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init = {}) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          signal.addEventListener('abort', () => {
            controller.error(signal.reason);
          });
        },
      });
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    });
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch });

    const error = await rejectionOf(client.purgeCache('default', { timeoutMs: 30 }));

    expect(error).toBeInstanceOf(BridgeTimeoutError);
    expect(error).toMatchObject({ op: 'jobs.purgeCache', timeoutMs: 30 });
  });

  it.each<{
    label: string;
    invoke: (client: BridgeClient) => Promise<unknown>;
    status: number;
    headers: Record<string, string>;
    bytes: Buffer;
    expected: Record<string, unknown>;
  }>([
    {
      label: 'a 500 answer',
      invoke: (client) => client.purgeCache('default', { timeoutMs: 30 }),
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      bytes: Buffer.from(JSON.stringify({ error: 'serverError', serverTime: SERVER_TIME })),
      expected: { name: 'BridgeError', op: 'jobs.purgeCache', status: 500, body: { error: 'serverError', serverTime: SERVER_TIME } },
    },
    {
      label: 'a 409 unsupportedFileStore answer',
      invoke: (client) => client.filesDelete('default', { fileId: FILE_ID }, { timeoutMs: 30 }),
      status: 409,
      headers: { 'Content-Type': 'application/json' },
      bytes: Buffer.from(JSON.stringify({ error: 'unsupportedFileStore', serverTime: SERVER_TIME })),
      expected: { name: 'UnsupportedFileStoreError', op: 'files.delete', status: 409 },
    },
    {
      label: 'files.get bytes that miss their hash',
      invoke: (client) => client.filesGet('default', FILE_NAME, { timeoutMs: 30 }),
      status: 200,
      headers: { 'X-Opt2-Sha256': '0'.repeat(64) },
      bytes: FILE_BYTES,
      expected: { name: 'BridgeHashMismatchError', op: 'files.get', status: 200, actual: FILE_SHA },
    },
  ])('propagates the BridgeError of $label whose body ends as the bound expires, not BridgeTimeoutError', async ({ invoke, status, headers, bytes, expected }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init = {}) => {
      const signal = init.signal as AbortSignal;
      // Every byte is delivered at once, but the body closes only when the bound fires.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          signal.addEventListener('abort', () => {
            controller.close();
          });
        },
      });
      return new Response(body, { status, headers });
    });
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch });

    const error = await rejectionOf(invoke(client));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).not.toBeInstanceOf(BridgeTimeoutError);
    expect(error).toMatchObject(expected);
  });

  it("propagates the caller's abort unchanged, not as a timeout", async () => {
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: hangingFetch() });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');

    const pending = rejectionOf(client.schedulerDescribe({ signal: controller.signal, timeoutMs: 5_000 }));
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });
});

describe('bridge client assertions and addressing', () => {
  it('signs every assertion to expire 60 seconds after the call', async () => {
    const now = new Date('2026-06-30T12:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const fake = capturingFetch();
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await client.getCursor();

    const value = onlyRequest(fake).headers[BRIDGE_ASSERTION_HEADER] ?? '';
    const result = verifyBridgeAssertion(value, KEY, new MemoryNonceStore(), now);
    expect(result).toMatchObject({ ok: true, payload: { exp: now.getTime() / 1000 + 60 } });
  });

  it('carries a fresh nonce on each call, so consecutive assertions both verify against one nonce store', async () => {
    const fake = capturingFetch();
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });
    const store = new MemoryNonceStore();

    await client.purgeCache('default');
    await client.purgeCache('default');

    expect(fake.requests).toHaveLength(2);
    const values = fake.requests.map((request) => request.headers[BRIDGE_ASSERTION_HEADER] ?? '');
    expect(new Set(values).size).toBe(2);
    expect(new Set(fake.requests.map((request) => verifiedAssertion(request).nonce)).size).toBe(2);
    expect(values.map((value) => verifyBridgeAssertion(value, KEY, store).ok)).toEqual([true, true]);
  });

  it('signs with its own key, so a verifier holding another key rejects the assertion', async () => {
    const fake = capturingFetch();
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    await client.schedulerDescribe();

    const value = onlyRequest(fake).headers[BRIDGE_ASSERTION_HEADER] ?? '';
    expect(verifyBridgeAssertion(value, `${KEY}-other`, new MemoryNonceStore())).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it.each([
    ['no trailing slash', ORIGIN],
    ['one trailing slash', `${ORIGIN}/`],
    ['several trailing slashes', `${ORIGIN}///`],
  ])('addresses the bridge page directly under an origin with %s', async (_label, origin) => {
    const fake = capturingFetch();
    const client = createBridgeClient({ origin, key: KEY, fetch: fake.fetch });

    await client.getCursor();

    expect(fake.fetch).toHaveBeenCalledWith(`${ORIGIN}${BRIDGE_PATH}/jobs.cfm?job=getCursor`, expect.any(Object));
  });

  it('keeps a path prefix of the origin in front of the bridge path', async () => {
    const fake = capturingFetch();
    const client = createBridgeClient({ origin: 'http://legacy.internal:8080/masa/', key: KEY, fetch: fake.fetch });

    await client.siteRefresh('default');

    expect(onlyRequest(fake).url.href).toBe(
      `http://legacy.internal:8080/masa${BRIDGE_PATH}/site.cfm?op=refresh&siteid=default`,
    );
  });

  it('rejects with RangeError and sends nothing when the key is empty', async () => {
    const fake = capturingFetch();
    const client = createBridgeClient({ origin: ORIGIN, key: '', fetch: fake.fetch });

    await expect(client.schedulerDescribe()).rejects.toThrow(RangeError);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('bridge client errors', () => {
  it.each([
    {
      label: 'a JSON error body',
      status: 400,
      text: JSON.stringify({ error: 'badRequest', message: 'missing tasks or prefix', serverTime: SERVER_TIME }),
      body: { error: 'badRequest', message: 'missing tasks or prefix', serverTime: SERVER_TIME },
    },
    { label: "the guard's bodiless 403", status: 403, text: '', body: '' },
    { label: "the guard's bodiless 404", status: 404, text: '', body: '' },
    { label: 'a non-JSON text body', status: 502, text: 'Bad Gateway', body: 'Bad Gateway' },
    {
      label: 'a 409 other than unsupportedFileStore',
      status: 409,
      text: JSON.stringify({ error: 'sessionMismatch', message: 'sid differs', serverTime: SERVER_TIME }),
      body: { error: 'sessionMismatch', message: 'sid differs', serverTime: SERVER_TIME },
    },
    { label: 'a 409 whose JSON body is null', status: 409, text: 'null', body: null },
    { label: 'an unfollowed redirect', status: 302, text: '', body: '' },
  ])('rejects with BridgeError carrying status, op and $label', async ({ status, text, body }) => {
    const fake = capturingFetch(() => new Response(text === '' ? null : text, { status }));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    const error = await rejectionOf(client.schedulerPause({ prefix: 'opt2-survey-' }));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).not.toBeInstanceOf(UnsupportedFileStoreError);
    expect(error).toMatchObject({
      name: 'BridgeError',
      status,
      op: 'scheduler.pause',
      message: `legacy bridge scheduler.pause failed with ${String(status)}`,
    });
    expect((error as BridgeError).body).toEqual(body);
  });

  it('rejects filesPut with BridgeError carrying the hashMismatch body', async () => {
    const body = { error: 'hashMismatch', message: 'body does not hash to X-Opt2-Sha256', serverTime: SERVER_TIME };
    const fake = capturingFetch(() => jsonResponse(body, 400));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    const error = await rejectionOf(client.filesPut('default', FILE_NAME, FILE_BYTES, '0'.repeat(64)));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ name: 'BridgeError', status: 400, op: 'files.put', body });
  });

  it.each([
    ['filesGet', 'files.get', (client: BridgeClient) => client.filesGet('default', FILE_NAME)],
    ['filesPut', 'files.put', (client: BridgeClient) => client.filesPut('default', FILE_NAME, FILE_BYTES, FILE_SHA)],
    ['filesDelete', 'files.delete', (client: BridgeClient) => client.filesDelete('default', { fileId: FILE_ID })],
  ])('rejects %s with UnsupportedFileStoreError on 409 unsupportedFileStore', async (_label, op, invoke) => {
    const body = { error: 'unsupportedFileStore', message: 'file store is s3', serverTime: SERVER_TIME };
    const fake = capturingFetch(() => jsonResponse(body, 409));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    const error = await rejectionOf(invoke(client));

    expect(error).toBeInstanceOf(UnsupportedFileStoreError);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      name: 'UnsupportedFileStoreError',
      status: 409,
      op,
      body,
      message: `legacy bridge ${op} failed with 409`,
    });
  });

  it.each([
    ['a different hash', '0'.repeat(64), '0'.repeat(64)],
    ['an uppercase different hash', 'A'.repeat(64), 'a'.repeat(64)],
    ['no X-Opt2-Sha256 header', undefined, ''],
  ])('rejects filesGet with BridgeHashMismatchError when the answer carries %s', async (_label, header, expected) => {
    const headers: Record<string, string> = header === undefined ? {} : { 'X-Opt2-Sha256': header };
    const fake = capturingFetch(() => new Response(FILE_BYTES, { status: 200, headers }));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    const error = await rejectionOf(client.filesGet('default', FILE_NAME));

    expect(error).toBeInstanceOf(BridgeHashMismatchError);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      name: 'BridgeHashMismatchError',
      status: 200,
      op: 'files.get',
      expected,
      actual: FILE_SHA,
      body: { expected, actual: FILE_SHA },
      message: 'legacy bridge files.get returned bytes that do not hash to X-Opt2-Sha256',
    });
  });

  it('maps a non-2xx filesGet answer to BridgeError before reading any bytes', async () => {
    const body = { error: 'notFound', message: 'no such file', serverTime: SERVER_TIME };
    const fake = capturingFetch(() => jsonResponse(body, 404));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch: fake.fetch });

    const error = await rejectionOf(client.filesGet('default', FILE_NAME));

    expect(error).toBeInstanceOf(BridgeError);
    expect(error).not.toBeInstanceOf(BridgeHashMismatchError);
    expect(error).toMatchObject({ name: 'BridgeError', status: 404, op: 'files.get', body });
  });

  it.each([
    ['a network failure', new TypeError('fetch failed')],
    ['an abort', new DOMException('This operation was aborted', 'AbortError')],
  ])('propagates %s from fetch unchanged', async (_label, failure) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(failure));
    const client = createBridgeClient({ origin: ORIGIN, key: KEY, fetch });

    await expect(rejectionOf(client.siteRefresh('default'))).resolves.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bridgeClientFromEnv', () => {
  it('builds a client addressing LEGACY_ORIGIN and signing with OPT2_BRIDGE_HMAC_KEY', async () => {
    const answer = { refreshed: true, siteExists: true, serverTime: SERVER_TIME };
    const fake = capturingFetch(() => jsonResponse(answer));
    const client = bridgeClientFromEnv({ LEGACY_ORIGIN: `${ORIGIN}/`, OPT2_BRIDGE_HMAC_KEY: KEY }, fake.fetch);

    await expect(client.siteRefresh('tenant-a')).resolves.toEqual(answer);

    const request = onlyRequest(fake);
    expect(request.url.href).toBe(`${ORIGIN}${BRIDGE_PATH}/site.cfm?op=refresh&siteid=tenant-a`);
    expect(request.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(headersBesideAssertion(request)).toEqual({ 'User-Agent': USER_AGENT, Accept: 'application/json' });
    expect(verifiedAssertion(request)).toMatchObject({ op: 'site.refresh', siteId: 'tenant-a' });
  });
});

describe('bridge client default transport', () => {
  interface Received {
    url: URL;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }
  const received: Received[] = [];
  const CURSOR_ANSWER = { job: 'getCursor', lastMonitored: null, serverTime: SERVER_TIME };
  let server: Server;
  let origin: string;

  // A bridge stand-in: scheduler.describe never answers, site.refresh stalls in its body, files.put echoes what it read.
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('error', () => undefined);
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://bridge.test');
        const body = Buffer.concat(chunks);
        received.push({ url, headers: req.headers, body });
        const call = `${url.pathname.slice(url.pathname.lastIndexOf('/') + 1)}?${url.searchParams.get('job') ?? url.searchParams.get('op') ?? ''}`;
        if (call === 'scheduler.cfm?describe') return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (call === 'site.cfm?refresh') {
          res.write('{"refreshed":');
          return;
        }
        const sha256 = createHash('sha256').update(body).digest('hex');
        res.end(JSON.stringify(call === 'files.cfm?put' ? { written: true, size: body.length, sha256 } : CURSOR_ANSWER));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received.length = 0;
  });

  async function* streamed(bytes: Buffer): AsyncGenerator<Uint8Array> {
    yield bytes.subarray(0, 3);
    yield bytes.subarray(3);
  }

  it.each<[string, () => BridgeClient]>([
    ['createBridgeClient', () => createBridgeClient({ origin, key: KEY })],
    ['bridgeClientFromEnv', () => bridgeClientFromEnv({ LEGACY_ORIGIN: origin, OPT2_BRIDGE_HMAC_KEY: KEY })],
  ])('%s without a fetch sends each call through the platform signal-bound fetch, never the global fetch', async (_label, build) => {
    const globalFetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('the global fetch was used')));
    vi.stubGlobal('fetch', globalFetch);

    await expect(build().getCursor()).resolves.toEqual(CURSOR_ANSWER);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    const assertion = String(received[0]?.headers[BRIDGE_ASSERTION_HEADER.toLowerCase()]);
    expect(verifyBridgeAssertion(assertion, KEY, new MemoryNonceStore())).toMatchObject({ ok: true, payload: { op: 'jobs.getCursor' } });
  });

  it('streams a filesPut body unchunked with its size as Content-Length', async () => {
    const client = createBridgeClient({ origin, key: KEY });

    await expect(client.filesPut('default', FILE_NAME, streamed(FILE_BYTES), FILE_SHA, { size: FILE_BYTES.length })).resolves.toEqual({
      written: true,
      size: FILE_BYTES.length,
      sha256: FILE_SHA,
    });

    const [put] = received;
    expect(put?.body.equals(FILE_BYTES)).toBe(true);
    expect(put?.headers).toMatchObject({ 'content-length': String(FILE_BYTES.length), 'x-opt2-sha256': FILE_SHA });
    expect(put?.headers['transfer-encoding']).toBeUndefined();
  });

  it('fails a streamed filesPut body shorter than its size without the bridge receiving a whole request', async () => {
    const client = createBridgeClient({ origin, key: KEY });

    const error = await rejectionOf(client.filesPut('default', FILE_NAME, streamed(FILE_BYTES), FILE_SHA, { size: FILE_BYTES.length + 1 }));

    expect(error).not.toBeInstanceOf(BridgeTimeoutError);
    expect((error as Error).cause).toMatchObject({ code: 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' });
    expect(received).toEqual([]);
  });

  it.each<[string, (client: BridgeClient) => Promise<unknown>, string]>([
    ['its headers', (client) => client.schedulerDescribe({ timeoutMs: 100 }), 'scheduler.describe'],
    ['the end of its body', (client) => client.siteRefresh('default', { timeoutMs: 100 }), 'site.refresh'],
  ])('cuts an answer stalled before %s at the bound as BridgeTimeoutError', async (_label, invoke, op) => {
    const started = Date.now();

    const error = await rejectionOf(invoke(createBridgeClient({ origin, key: KEY })));

    expect(error).toBeInstanceOf(BridgeTimeoutError);
    expect(error).toMatchObject({ op, timeoutMs: 100, cause: { name: 'TimeoutError' } });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(received).toHaveLength(1);
  });
});
