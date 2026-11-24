// Tests when the legacy forwarder settles an exchange, what its response and shutdown wait for, how long it waits for legacy,
// where buffer mode holds a response, and how it logs failures.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readdir, readlink, rm, stat, type FileHandle } from 'node:fs/promises';
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import replyFrom, { type FastifyReplyFromOptions } from '@fastify/reply-from';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { Agent } from '@opt2/platform/service-kit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forwardToLegacy,
  type BufferedLegacyResponse,
  type LegacyBeforeSend,
  type LegacyForwardContext,
  type LegacySettlement,
} from '../../src/dispatcher/forward-legacy.js';
import { FORWARD_CONNECTIONS, replyFromOptions } from '../../src/dispatcher/response-head.js';
import { sendBytes, startHttpDouble, type DoubleHandler, type HttpDouble } from '../helpers/http-double.js';

/** How long the legacy stand-in runs a held write before answering, and again while streaming its answer. */
const HOLD_MS = 500;
/** How long a delayed `onSettled` takes to commit. */
const SETTLE_DELAY_MS = 300;
/** How long a test waits to show that something never happens. */
const QUIET_MS = 1_000;
const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const CHUNK_COUNT = 16;
const LEGACY_BODY = 'committed';
const WRITE_PATH = '/admin/index.cfm?muraAction=cArch.update';
const UNCERTAIN_MESSAGE = 'legacy exchange ended uncertainly; in-flight registration kept';
const SECRET = 's3cr3t-cfid';
/** pino's numeric levels. */
const WARN_LEVEL = 40;
const ERROR_LEVEL = 50;

type OnSettled = (outcome: LegacySettlement) => Promise<void>;
type OnBuffered = (res: BufferedLegacyResponse) => Promise<void>;

/** Context fields a test chooses, plus the legacy origin; the rest is fixed. */
type GatewayOptions = Pick<LegacyForwardContext, 'mode' | 'beforeSend' | 'onBuffered' | 'onSettled' | 'timeoutMs' | 'lenientHead'> & {
  origin?: string;
  /** Registers reply-from with the gateway's agent, which sends the raw request target, in place of reply-from's own. */
  gatewayAgent?: boolean;
};

interface LogRecord {
  level: number;
  msg?: string;
  error?: unknown;
}

interface Gateway {
  app: FastifyInstance;
  port: number;
  /** Every record the gateway logged, parsed. */
  logs(): LogRecord[];
  /** The gateway's raw log output. */
  logText(): string;
  /** The arguments of every warn-or-worse log call as passed, before the logger serialized them, inspected. */
  logArguments(): string;
}

interface ClientOutcome {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** True when the response arrived whole; false when the request or response was cut. */
  complete: boolean;
}

interface ClientOptions {
  method?: string;
  body?: Buffer;
  /** Runs synchronously when the response status arrives. */
  atResponse?: () => void;
  /** Runs synchronously when the response ends or the exchange fails. */
  atEnd?: () => void;
  /** Runs on each response chunk. */
  onData?: (req: ClientRequest) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** What the legacy stand-in observed of one held write. */
interface LegacyWatch {
  received: Deferred<undefined>;
  /** Resolves true when legacy's response finished, false when its connection was cut first. */
  finished: Deferred<boolean>;
  /** Set just before legacy ends its response. */
  ended: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function watchLegacy(): LegacyWatch {
  return { received: deferred<undefined>(), finished: deferred<boolean>(), ended: false };
}

/** Legacy stand-in for a held write: answers after HOLD_MS, streams its body for HOLD_MS more, then ends. */
function holdWrite(watch: LegacyWatch): DoubleHandler {
  return async (_req, res) => {
    res.once('close', () => watch.finished.resolve(res.writableFinished));
    watch.received.resolve(undefined);
    await delay(HOLD_MS);
    res.writeHead(200, { 'content-type': 'text/plain' });
    for (let sent = 0; sent < CHUNK_COUNT; sent += 1) {
      res.write(CHUNK);
      await delay(HOLD_MS / CHUNK_COUNT);
    }
    watch.ended = true;
    res.end();
  };
}

/** The error a bridge client's JSON.parse throws on a malformed answer that carries a session value. */
function bridgeParseError(): Error {
  try {
    JSON.parse(`CFID=${SECRET}`);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the malformed bridge answer parsed');
}

/** An origin whose port refuses connections. */
async function refusingOrigin(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return `http://127.0.0.1:${port}`;
}

/** Asserts every logged `error` is a serializeError record: string `type` and `message`, an optional string `stack`. */
function expectSerializedErrors(records: readonly LogRecord[]): void {
  for (const record of records) {
    if (record.error === undefined) continue;
    const { type, message, stack, ...rest } = record.error as Record<string, unknown>;
    expect(rest).toEqual({});
    expect(typeof type).toBe('string');
    expect(typeof message).toBe('string');
    expect(stack === undefined || typeof stack === 'string').toBe(true);
  }
}

let legacy: HttpDouble;
let refusedOrigin: string;
const gateways: FastifyInstance[] = [];

beforeAll(async () => {
  legacy = await startHttpDouble((_req, res) => sendBytes(res, 500, 'no handler'));
  refusedOrigin = await refusingOrigin();
});

beforeEach(() => {
  legacy.clearRequests();
});

afterEach(async () => {
  await Promise.all(
    gateways
      .splice(0)
      .filter((app) => app.server.listening)
      .map((app) => app.close()),
  );
});

afterAll(async () => {
  await legacy.close();
});

/** Starts a gateway whose every route forwards to legacy with `options`, logging every level into memory. */
async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const lines: string[] = [];
  const callArguments: string[] = [];
  const app = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
      hooks: {
        logMethod(args, method, level) {
          if (level >= WARN_LEVEL) callArguments.push(inspect(args, { depth: 4 }));
          method.apply(this, args);
        },
      },
    },
  });
  const { origin, gatewayAgent, ...ctx } = options;
  await app.register(replyFrom, gatewayAgent === true ? replyFromOptions() : {});
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => {
    done(null, payload);
  });
  app.all('/*', (request, reply) => {
    void forwardToLegacy(request, reply, {
      legacyOrigin: origin ?? legacy.url,
      headers: request.headers,
      sessionMode: 'legacy-primary',
      failContext: { surface: 'admin' },
      ...ctx,
    });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  gateways.push(app);
  return {
    app,
    port: (app.server.address() as AddressInfo).port,
    logs: () => lines.map((line) => JSON.parse(line) as LogRecord),
    logText: () => lines.join(''),
    logArguments: () => callArguments.join('\n'),
  };
}

/** Sends one request for raw `path` to the gateway on its own connection and reports what the client received. */
function send(gateway: Gateway, path: string, options: ClientOptions = {}): { req: ClientRequest; outcome: Promise<ClientOutcome> } {
  const chunks: Buffer[] = [];
  let status: number | undefined;
  let responseHeaders: IncomingHttpHeaders = {};
  let finish: (complete: boolean) => void = () => undefined;
  const outcome = new Promise<ClientOutcome>((resolve) => {
    let done = false;
    finish = (complete) => {
      if (done) return;
      done = true;
      options.atEnd?.();
      resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks), complete });
    };
  });
  const headers = options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' };
  // Host, port and path given apart, so WHATWG URL parsing never folds the path's dot segments.
  const target = { host: '127.0.0.1', port: gateway.port, path, method: options.method ?? 'GET', agent: false, headers };
  const req = httpRequest(target, (res) => {
    status = res.statusCode;
    responseHeaders = res.headers;
    options.atResponse?.();
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      options.onData?.(req);
    });
    res.once('end', () => finish(true));
    res.once('error', () => finish(false));
    res.once('close', () => finish(res.complete));
  });
  req.once('error', () => finish(false));
  req.end(options.body);
  return { req, outcome };
}

describe('forwardToLegacy after the client goes away', () => {
  it.each([
    { method: 'GET', mode: 'stream', abortOn: 'request-received' },
    { method: 'GET', mode: 'buffer', abortOn: 'request-received' },
    { method: 'POST', mode: 'stream', abortOn: 'request-received' },
    { method: 'POST', mode: 'buffer', abortOn: 'request-received' },
    { method: 'GET', mode: 'stream', abortOn: 'first-byte' },
    { method: 'POST', mode: 'stream', abortOn: 'first-byte' },
  ] as const)(
    '$method in $mode mode, client gone at $abortOn: settles completed once, only after legacy ended',
    async ({ method, mode, abortOn }) => {
      const watch = watchLegacy();
      legacy.setHandler(holdWrite(watch));
      const endedAtSettle: boolean[] = [];
      const onSettled = vi.fn<OnSettled>(() => {
        endedAtSettle.push(watch.ended);
        return Promise.resolve();
      });
      const gateway = await startGateway({ mode, onSettled });

      const client = send(gateway, WRITE_PATH, {
        method,
        body: method === 'POST' ? Buffer.from('title=held') : undefined,
        onData: abortOn === 'first-byte' ? (req) => req.destroy() : undefined,
      });
      if (abortOn === 'request-received') {
        await watch.received.promise;
        client.req.destroy();
      }

      expect((await client.outcome).complete).toBe(false);
      expect(onSettled).not.toHaveBeenCalled();
      expect(await watch.finished.promise).toBe(true);
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
      await delay(SETTLE_DELAY_MS);
      expect(onSettled.mock.calls).toEqual([['completed']]);
      expect(endedAtSettle).toEqual([true]);
      expect(legacy.requests).toHaveLength(1);
    },
  );
});

describe('forwardToLegacy after legacy resets the connection', () => {
  it.each([
    { mode: 'stream', reset: 'before-headers', status: 503, complete: true },
    { mode: 'buffer', reset: 'before-headers', status: 503, complete: true },
    { mode: 'stream', reset: 'mid-body', status: 200, complete: false },
    { mode: 'buffer', reset: 'mid-body', status: 503, complete: true },
  ] as const)(
    '$mode mode, reset $reset: never settles, warns that the registration is kept, client gets $status',
    async ({ mode, reset, status, complete }) => {
      legacy.setHandler(async (_req, res) => {
        if (reset === 'mid-body') {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(CHUNK.length * 2) });
          res.write(CHUNK);
          await delay(50);
        }
        res.socket?.destroy();
      });
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const onBuffered = vi.fn<OnBuffered>(() => Promise.resolve());
      const gateway = await startGateway({ mode, onSettled, onBuffered });

      const outcome = await send(gateway, WRITE_PATH).outcome;
      await delay(QUIET_MS);

      expect(outcome.status).toBe(status);
      expect(outcome.complete).toBe(complete);
      expect(onSettled).not.toHaveBeenCalled();
      expect(onBuffered).not.toHaveBeenCalled();
      const warnings = gateway.logs().filter((record) => record.msg === UNCERTAIN_MESSAGE);
      expect(warnings.map((record) => record.level)).toEqual([WARN_LEVEL]);
      expectSerializedErrors(gateway.logs());
      expect(legacy.requests).toHaveLength(1);
    },
  );
});

describe('forwardToLegacy when the request never reaches legacy', () => {
  it.each([
    { name: 'the connection is refused', target: 'refusing', path: WRITE_PATH },
    { name: 'reply-from rejects the origin', target: 'unparseable', path: WRITE_PATH },
    { name: 'undici refuses the request target', target: 'legacy', path: '*' },
  ] as const)('$name: settles not-sent once, and the 503 follows the settlement', async ({ target, path }) => {
    let committed = false;
    const onSettled = vi.fn<OnSettled>(async () => {
      await delay(SETTLE_DELAY_MS);
      committed = true;
    });
    const origins = { refusing: refusedOrigin, unparseable: 'http://127.0.0.1:65536', legacy: legacy.url };
    const gateway = await startGateway({ mode: 'buffer', onSettled, origin: origins[target], gatewayAgent: true });

    let committedAtResponse = false;
    const outcome = await send(gateway, path, {
      atResponse: () => {
        committedAtResponse = committed;
      },
    }).outcome;

    expect(outcome).toMatchObject({ status: 503, complete: true });
    expect(committedAtResponse).toBe(true);
    expect(onSettled.mock.calls).toEqual([['not-sent']]);
    expect(legacy.requests).toHaveLength(0);
  });

  it("a lenient forward past the agent's bound: settles not-sent, answers the 503 after it, and the next forward goes once one ends", async () => {
    const waiting: Socket[] = [];
    let connections = 0;
    let holding = true;
    const answer = (socket: Socket): void => void socket.end('HTTP/1.1 204 No Content\r\n\r\n');
    const server = createTcpServer((socket) => {
      connections += 1;
      socket.on('error', () => undefined);
      socket.once('data', () => (holding ? waiting.push(socket) : answer(socket)));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    let committed = false;
    const onSettled = vi.fn<OnSettled>(async (outcome) => {
      if (outcome !== 'not-sent') return;
      await delay(SETTLE_DELAY_MS);
      committed = true;
    });
    try {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const gateway = await startGateway({ mode: 'buffer', onSettled, origin, gatewayAgent: true, lenientHead: true });
      const held = Array.from({ length: FORWARD_CONNECTIONS }, () => send(gateway, WRITE_PATH).outcome);
      await vi.waitFor(() => expect(waiting).toHaveLength(FORWARD_CONNECTIONS));

      let committedAtResponse = false;
      const refused = await send(gateway, WRITE_PATH, {
        atResponse: () => {
          committedAtResponse = committed;
        },
      }).outcome;

      expect(refused).toMatchObject({ status: 503, complete: true });
      expect(refused.body.toString()).toBe(LEGACY_ERROR_PAGE_HTML);
      expect(committedAtResponse).toBe(true);
      expect(onSettled.mock.calls).toEqual([['not-sent']]);
      expect(connections).toBe(FORWARD_CONNECTIONS);
      holding = false;
      for (const socket of waiting) answer(socket);
      expect((await Promise.all(held)).map((outcome) => outcome.status)).toEqual(Array.from({ length: FORWARD_CONNECTIONS }, () => 204));
      await vi.waitFor(async () => expect((await send(gateway, WRITE_PATH).outcome).status).toBe(204));
      expect(onSettled.mock.calls.filter(([outcome]) => outcome === 'completed').length).toBeGreaterThan(FORWARD_CONNECTIONS);
    } finally {
      for (const socket of waiting) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('forwardToLegacy waits for a delayed settlement', () => {
  it.each(['stream', 'buffer'] as const)('%s mode: the client response ends only after onSettled resolved', async (mode) => {
    legacy.setHandler((_req, res) => sendBytes(res, 200, LEGACY_BODY, { 'content-type': 'text/plain' }));
    let committed = false;
    const onSettled = vi.fn<OnSettled>(async () => {
      await delay(SETTLE_DELAY_MS);
      committed = true;
    });
    const committedAtBuffered: boolean[] = [];
    const onBuffered = vi.fn<OnBuffered>(() => {
      committedAtBuffered.push(committed);
      return Promise.resolve();
    });
    const gateway = await startGateway({ mode, onSettled, onBuffered });

    let committedAtEnd = false;
    const outcome = await send(gateway, WRITE_PATH, {
      atEnd: () => {
        committedAtEnd = committed;
      },
    }).outcome;

    expect(outcome).toMatchObject({ status: 200, complete: true });
    expect(outcome.body.toString()).toBe(LEGACY_BODY);
    expect(committedAtEnd).toBe(true);
    expect(onSettled.mock.calls).toEqual([['completed']]);
    expect(committedAtBuffered).toEqual(mode === 'buffer' ? [true] : []);
  });

  it.each(['stream', 'buffer'] as const)('%s mode: app.close() started mid-request resolves only after onSettled resolved', async (mode) => {
    const watch = watchLegacy();
    legacy.setHandler(async (_req, res) => {
      watch.received.resolve(undefined);
      await delay(HOLD_MS);
      sendBytes(res, 200, LEGACY_BODY, { 'content-type': 'text/plain' });
    });
    let committed = false;
    const onSettled = vi.fn<OnSettled>(async () => {
      await delay(SETTLE_DELAY_MS);
      committed = true;
    });
    const gateway = await startGateway({ mode, onSettled });

    const client = send(gateway, WRITE_PATH);
    await watch.received.promise;
    let committedAtClose = false;
    const closing = gateway.app.close().then(() => {
      committedAtClose = committed;
    });
    const outcome = await client.outcome;
    await closing;

    expect(outcome).toMatchObject({ status: 200, complete: true });
    expect(outcome.body.toString()).toBe(LEGACY_BODY);
    expect(committedAtClose).toBe(true);
    expect(onSettled.mock.calls).toEqual([['completed']]);
  });
});

describe('forwardToLegacy logs a failed callback through serializeError', () => {
  it.each([
    { callback: 'beforeSend', mode: 'stream', status: 503 },
    { callback: 'beforeSend', mode: 'buffer', status: 503 },
    { callback: 'onSettled', mode: 'stream', status: 200 },
    { callback: 'onSettled', mode: 'buffer', status: 200 },
  ] as const)('$callback rejecting in $mode mode: logged without its message, client gets $status', async ({ callback, mode, status }) => {
    const failure = bridgeParseError();
    expect(failure.message).toContain(SECRET);
    legacy.setHandler((_req, res) => sendBytes(res, 200, LEGACY_BODY, { 'content-type': 'text/plain', 'set-cookie': 'CFID=1001;path=/;' }));
    const rejecting = (): Promise<never> => Promise.reject(failure);
    const onSettled = vi.fn<OnSettled>(callback === 'onSettled' ? rejecting : () => Promise.resolve());
    const beforeSend = callback === 'beforeSend' ? vi.fn<LegacyBeforeSend>(rejecting) : undefined;
    const onBuffered = vi.fn<OnBuffered>(() => Promise.resolve());
    const gateway = await startGateway({ mode, onSettled, beforeSend, onBuffered });

    const outcome = await send(gateway, WRITE_PATH).outcome;
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());

    expect(outcome).toMatchObject({ status, complete: true });
    expect(outcome.body.toString()).toBe(status === 200 ? LEGACY_BODY : LEGACY_ERROR_PAGE_HTML);
    expect(outcome.headers['set-cookie']).toEqual(status === 200 ? ['CFID=1001;path=/;'] : undefined);
    expect(onSettled.mock.calls).toEqual([['completed']]);
    // Legacy executed even when its response is withheld, so a buffered response is still reported.
    expect(onBuffered.mock.calls.map(([res]) => res.bytes)).toEqual(mode === 'buffer' ? [Buffer.byteLength(LEGACY_BODY)] : []);
    expect(gateway.logArguments()).toContain(failure.name);
    expect(gateway.logArguments()).not.toContain(SECRET);
    expect(gateway.logText()).not.toContain(SECRET);
    const failures = gateway.logs().filter((record) => (record.error as { type?: unknown } | undefined)?.type === failure.name);
    expect(failures.map((record) => [record.level, record.error])).toEqual([[ERROR_LEVEL, serializeError(failure)]]);
    expectSerializedErrors(gateway.logs());
  });
});

describe('forwardToLegacy when legacy answers a status Fastify rejects', () => {
  it.each(['stream', 'buffer'] as const)('%s mode: answers the 503, settles completed once, then buffer mode reports', async (mode) => {
    legacy.setHandler((_req, res) => sendBytes(res, 600, LEGACY_BODY, { 'content-type': 'text/plain' }));
    const events: string[] = [];
    const onSettled = vi.fn<OnSettled>(async () => {
      events.push('settled');
    });
    const onBuffered = vi.fn<OnBuffered>(async () => {
      events.push('buffered');
    });
    const gateway = await startGateway({ mode, onSettled, onBuffered });

    const outcome = await send(gateway, WRITE_PATH).outcome;
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    await delay(SETTLE_DELAY_MS);

    expect(outcome).toMatchObject({ status: 503, complete: true });
    expect(onSettled.mock.calls).toEqual([['completed']]);
    expect(onBuffered.mock.calls.map(([res]) => [res.statusCode, res.bytes])).toEqual(
      mode === 'buffer' ? [[600, Buffer.byteLength(LEGACY_BODY)]] : [],
    );
    expect(events).toEqual(mode === 'buffer' ? ['settled', 'buffered'] : ['settled']);
    expect(gateway.logs().filter((record) => record.level >= ERROR_LEVEL).map((record) => record.msg)).toEqual([
      'fail-closed: legacy unavailable',
    ]);
  });
});

describe('forwardToLegacy never retries', () => {
  it.each([{ settles: true }, { settles: false }])(
    'a GET legacy answers 503 reaches legacy once (onSettled given: $settles)',
    async ({ settles }) => {
      legacy.setHandler((_req, res) => sendBytes(res, 503, 'legacy busy', { 'content-type': 'text/plain', 'retry-after': '1' }));
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const gateway = await startGateway({ mode: 'stream', onSettled: settles ? onSettled : undefined });

      const outcome = await send(gateway, '/index.cfm/news/').outcome;
      await delay(SETTLE_DELAY_MS);

      expect(outcome).toMatchObject({ status: 503, complete: true });
      expect(outcome.body.toString()).toBe('legacy busy');
      expect(legacy.requests).toHaveLength(1);
      expect(onSettled.mock.calls).toEqual(settles ? [['completed']] : []);
    },
  );
});

/** Bound the stall cases give legacy in place of Masa's 7200 s. */
const STALL_BOUND_MS = 300;

/** An origin that accepts connections and reads requests, but never answers them. */
async function silentOrigin(): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

describe('forwardToLegacy bounds its wait for legacy', () => {
  it.each([
    { timeoutMs: undefined, bound: 7_200_000 },
    { timeoutMs: STALL_BOUND_MS, bound: STALL_BOUND_MS },
  ])('gives undici $bound ms headers and body timeouts when timeoutMs is $timeoutMs', async ({ timeoutMs, bound }) => {
    legacy.setHandler((_req, res) => sendBytes(res, 200, LEGACY_BODY, { 'content-type': 'text/plain' }));
    const seen: Array<[number | null | undefined, number | null | undefined]> = [];
    const agent = new Agent().compose((dispatch) => (opts, handler) => {
      seen.push([opts.headersTimeout, opts.bodyTimeout]);
      return dispatch(opts, handler);
    });
    const app = Fastify();
    gateways.push(app);
    await app.register(replyFrom, { undici: agent as FastifyReplyFromOptions['undici'], destroyAgent: true });
    app.get('/*', (request, reply) => {
      void forwardToLegacy(request, reply, {
        legacyOrigin: legacy.url,
        headers: request.headers,
        sessionMode: 'legacy-primary',
        mode: 'stream',
        failContext: { surface: 'admin' },
        timeoutMs,
      });
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });

    const response = await fetch(`${address}/admin/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LEGACY_BODY);
    expect(seen).toEqual([[bound, bound]]);
  });

  it.each([
    { mode: 'stream', stall: 'before-head', error: 'HeadersTimeoutError', status: 503, complete: true },
    { mode: 'buffer', stall: 'before-head', error: 'HeadersTimeoutError', status: 503, complete: true },
    { mode: 'stream', stall: 'mid-body', error: 'BodyTimeoutError', status: 200, complete: false },
    { mode: 'buffer', stall: 'mid-body', error: 'BodyTimeoutError', status: 503, complete: true },
  ] as const)(
    '$mode mode, legacy silent $stall: ends at timeoutMs unsettled and unbuffered, client gets $status',
    async ({ mode, stall, error, status, complete }) => {
      const silent = stall === 'before-head' ? await silentOrigin() : undefined;
      legacy.setHandler((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(CHUNK.length * 2) });
        res.write(CHUNK);
      });
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const onBuffered = vi.fn<OnBuffered>(() => Promise.resolve());
      try {
        const gateway = await startGateway({ mode, onSettled, onBuffered, timeoutMs: STALL_BOUND_MS, origin: silent?.url });

        const outcome = await send(gateway, WRITE_PATH).outcome;
        await delay(QUIET_MS);

        expect(outcome.status).toBe(status);
        expect(outcome.complete).toBe(complete);
        if (status === 503) expect(outcome.body.toString()).toBe(LEGACY_ERROR_PAGE_HTML);
        expect(onSettled).not.toHaveBeenCalled();
        expect(onBuffered).not.toHaveBeenCalled();
        const warnings = gateway.logs().filter((record) => record.msg === UNCERTAIN_MESSAGE);
        const ends = warnings.map((record) => [record.level, (record.error as { type?: unknown } | undefined)?.type]);
        expect(ends).toEqual([[WARN_LEVEL, error]]);
        expect(legacy.requests).toHaveLength(stall === 'mid-body' ? 1 : 0);
      } finally {
        await silent?.close();
      }
    },
  );
});

/** Body bytes buffer mode holds in memory before it moves a body to a file. */
const MEMORY_BYTES = 1024 * 1024;
/** A buffered response large enough to stream from its spool file in many chunks. */
const LARGE_BODY = randomBytes(6 * MEMORY_BYTES);
const SPOOL_FAILED_MESSAGE = 'legacy forward response spool failed';

/** A file the process holds open, by its path under the directory asked about; a removed one ends in ` (deleted)`. */
interface HeldFile {
  name: string;
  size: number;
  mode: number;
}

/** Every file the process holds open under `dir`, read from /proc. */
async function heldFilesUnder(dir: string): Promise<HeldFile[]> {
  const held: HeldFile[] = [];
  for (const fd of await readdir('/proc/self/fd')) {
    const link = `/proc/self/fd/${fd}`;
    const path = await readlink(link).catch(() => undefined);
    if (path === undefined || !path.startsWith(`${dir}/`)) continue;
    const stats = await stat(link).catch(() => undefined);
    if (stats !== undefined) held.push({ name: path.slice(dir.length + 1), size: stats.size, mode: stats.mode & 0o777 });
  }
  return held;
}

/** Legacy stand-in answering `status` with `body` in CHUNK-sized writes, with a length unless `chunked`. */
function sendBody(status: number, body: Buffer, chunked: boolean): DoubleHandler {
  return (_req, res) => {
    const length = chunked ? {} : { 'content-length': String(body.length) };
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'x-legacy': 'kept', ...length });
    for (let at = 0; at < body.length; at += CHUNK.length) res.write(body.subarray(at, at + CHUNK.length));
    res.end();
  };
}

describe('forwardToLegacy buffer mode holds the response in a removed request-owned file', () => {
  let spoolRoot: string;

  beforeEach(async () => {
    spoolRoot = await mkdtemp(join(tmpdir(), 'forward-legacy-spool-'));
    vi.stubEnv('TMPDIR', spoolRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(spoolRoot, { recursive: true, force: true });
  });

  it.each([
    { length: MEMORY_BYTES, chunked: false, inFile: false },
    { length: MEMORY_BYTES + 1, chunked: false, inFile: true },
    { length: LARGE_BODY.length, chunked: false, inFile: true },
    { length: LARGE_BODY.length, chunked: true, inFile: true },
  ])(
    '$length bytes, chunked $chunked: leaves byte-identical with legacy’s headers, held by a removed owner-only file: $inFile',
    async ({ length, chunked, inFile }) => {
      const body = LARGE_BODY.subarray(0, length);
      legacy.setHandler(sendBody(201, body, chunked));
      const held: Array<{ files: HeldFile[]; names: string[] }> = [];
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const onBuffered = vi.fn<OnBuffered>(async () => {
        held.push({ files: await heldFilesUnder(spoolRoot), names: await readdir(spoolRoot) });
      });
      const gateway = await startGateway({ mode: 'buffer', onSettled, onBuffered });

      const outcome = await send(gateway, WRITE_PATH).outcome;

      expect(outcome).toMatchObject({ status: 201, complete: true });
      expect(outcome.body.equals(body)).toBe(true);
      expect(outcome.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'x-legacy': 'kept' });
      expect(outcome.headers['content-length']).toBe(chunked ? undefined : String(length));
      expect(outcome.headers['transfer-encoding']).toBe(chunked ? 'chunked' : undefined);
      expect(onSettled.mock.calls).toEqual([['completed']]);
      expect(onBuffered.mock.calls.map(([res]) => [res.statusCode, res.bytes])).toEqual([[201, length]]);
      const file = { name: expect.stringMatching(/^opt2-legacy-response-[^/]+\/body \(deleted\)$/), size: length, mode: 0o600 };
      expect(held).toEqual([{ files: inFile ? [file] : [], names: [] }]);
      await vi.waitFor(async () => expect(await heldFilesUnder(spoolRoot)).toEqual([]));
      expect(await readdir(spoolRoot)).toEqual([]);
    },
  );

  it.each([
    { name: 'beforeSend rejects', reject: true, status: 503, complete: true, buffered: true, settled: true },
    { name: 'legacy resets mid-body', reset: true, status: 503, complete: true, buffered: false, settled: false },
    { name: 'the client goes while it is held', leave: 'held', status: undefined, complete: false, buffered: true, settled: true },
    { name: 'the client goes mid-send', leave: 'mid-send', status: 201, complete: false, buffered: true, settled: true },
    { name: 'the file cannot be created', spool: 'unopenable', status: 503, complete: true, buffered: true, settled: true },
    { name: 'the file cannot be written', spool: 'unwritable', status: 503, complete: true, buffered: true, settled: true },
  ] as const)(
    '$name: client gets $status, onBuffered only for a whole body, and no file is left',
    async (row) => {
      const { status, complete, buffered, settled } = row;
      const reset = 'reset' in row;
      const leave = 'leave' in row ? row.leave : undefined;
      const spool = 'spool' in row ? row.spool : undefined;
      legacy.setHandler(
        reset
          ? async (_req, res) => {
              res.writeHead(201, { 'content-type': 'application/octet-stream', 'content-length': String(LARGE_BODY.length) });
              res.write(LARGE_BODY.subarray(0, LARGE_BODY.length / 2));
              await delay(50);
              res.socket?.destroy();
            }
          : sendBody(201, LARGE_BODY, false),
      );
      if (spool === 'unopenable') vi.stubEnv('TMPDIR', join(spoolRoot, 'missing'));
      if (spool === 'unwritable') {
        const probe = await open(join(spoolRoot, 'probe'), 'w');
        await probe.close();
        await rm(join(spoolRoot, 'probe'));
        const failure = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'writeFile').mockRejectedValueOnce(failure);
      }
      const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
      const onBuffered = vi.fn<OnBuffered>(async () => {
        if (leave !== 'held') return;
        client.req.destroy();
        await delay(50);
      });
      const beforeSend = 'reject' in row ? vi.fn<LegacyBeforeSend>(() => Promise.reject(new Error('identity unavailable'))) : undefined;
      const gateway = await startGateway({ mode: 'buffer', onSettled, onBuffered, beforeSend });

      const client = send(gateway, WRITE_PATH, { onData: leave === 'mid-send' ? (req) => req.destroy() : undefined });
      const outcome = await client.outcome;
      await delay(SETTLE_DELAY_MS);

      expect(outcome.status).toBe(status);
      expect(outcome.complete).toBe(complete);
      if (status === 503) expect(outcome.body.toString()).toBe(LEGACY_ERROR_PAGE_HTML);
      expect(onSettled.mock.calls).toEqual(settled ? [['completed']] : []);
      expect(onBuffered.mock.calls.map(([res]) => [res.statusCode, res.bytes])).toEqual(buffered ? [[201, LARGE_BODY.length]] : []);
      const spoolFailures = gateway.logs().filter((record) => record.msg === SPOOL_FAILED_MESSAGE);
      expect(spoolFailures.map((record) => record.level)).toEqual(spool === undefined ? [] : [ERROR_LEVEL]);
      expectSerializedErrors(gateway.logs());
      await vi.waitFor(async () => expect(await heldFilesUnder(spoolRoot)).toEqual([]));
      expect(await readdir(spoolRoot)).toEqual([]);
      expect(legacy.requests).toHaveLength(1);
    },
  );

  it.each([
    { mode: 'buffer', length: CHUNK.length, ends: 'whole', buffered: true },
    { mode: 'buffer', length: LARGE_BODY.length, ends: 'whole', buffered: true },
    { mode: 'buffer', length: LARGE_BODY.length, ends: 'reset', buffered: false },
    { mode: 'buffer', length: LARGE_BODY.length, ends: 'stall', buffered: false },
    { mode: 'stream', length: LARGE_BODY.length, ends: 'whole', buffered: false },
  ] as const)(
    '$mode mode, client gone before legacy’s head, $length-byte body ends $ends: onBuffered after onSettled for a whole body',
    async ({ mode, length, ends, buffered }) => {
      const body = LARGE_BODY.subarray(0, length);
      const received = deferred<undefined>();
      legacy.setHandler(async (req, res) => {
        received.resolve(undefined);
        await delay(HOLD_MS);
        if (ends === 'whole') {
          await sendBody(201, body, false)(req, res);
          return;
        }
        res.writeHead(201, { 'content-type': 'application/octet-stream', 'content-length': String(length) });
        res.write(body.subarray(0, length / 2));
        if (ends === 'reset') {
          await delay(50);
          res.socket?.destroy();
        }
      });
      const events: string[] = [];
      const onSettled = vi.fn<OnSettled>(async () => {
        events.push('settled');
      });
      const onBuffered = vi.fn<OnBuffered>(async () => {
        events.push('buffered');
      });
      // Past legacy's HOLD_MS wait for its head, so only the stalled body times out.
      const gateway = await startGateway({ mode, onSettled, onBuffered, timeoutMs: 2 * HOLD_MS });

      const client = send(gateway, WRITE_PATH);
      await received.promise;
      client.req.destroy();
      expect((await client.outcome).complete).toBe(false);
      const uncertain = (): LogRecord[] => gateway.logs().filter((record) => record.msg === UNCERTAIN_MESSAGE);
      // undici's coarse timers may fire a stalled body's timeout up to a second late.
      await vi.waitFor(() => expect(ends === 'whole' ? onSettled.mock.calls : uncertain()).toHaveLength(1), { timeout: 4 * QUIET_MS });
      await delay(QUIET_MS);

      expect(events).toEqual(ends !== 'whole' ? [] : buffered ? ['settled', 'buffered'] : ['settled']);
      expect(onBuffered.mock.calls.map(([res]) => [res.statusCode, res.bytes, res.headers['x-legacy']])).toEqual(
        buffered ? [[201, length, 'kept']] : [],
      );
      expect(uncertain()).toHaveLength(ends === 'whole' ? 0 : 1);
      expect(await heldFilesUnder(spoolRoot)).toEqual([]);
      expect(await readdir(spoolRoot)).toEqual([]);
      expect(legacy.requests).toHaveLength(1);
    },
  );
});
