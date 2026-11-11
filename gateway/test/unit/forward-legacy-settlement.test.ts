// Tests when the legacy forwarder settles an exchange, what its response and shutdown wait for, and how it logs failures.
import { Buffer } from 'node:buffer';
import { createServer, request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import replyFrom from '@fastify/reply-from';
import { serializeError } from '@opt2/platform/logging';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forwardToLegacy,
  type BufferedLegacyResponse,
  type LegacyBeforeSend,
  type LegacyForwardContext,
  type LegacySettlement,
} from '../../src/dispatcher/forward-legacy.js';
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
type GatewayOptions = Pick<LegacyForwardContext, 'mode' | 'beforeSend' | 'onBuffered' | 'onSettled'> & { origin?: string };

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
  await app.register(replyFrom);
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => {
    done(null, payload);
  });
  const { origin, ...ctx } = options;
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
  let finish: (complete: boolean) => void = () => undefined;
  const outcome = new Promise<ClientOutcome>((resolve) => {
    let done = false;
    finish = (complete) => {
      if (done) return;
      done = true;
      options.atEnd?.();
      resolve({ status, body: Buffer.concat(chunks), complete });
    };
  });
  const headers = options.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' };
  // Host, port and path given apart, so WHATWG URL parsing never folds the path's dot segments.
  const target = { host: '127.0.0.1', port: gateway.port, path, method: options.method ?? 'GET', agent: false, headers };
  const req = httpRequest(target, (res) => {
    status = res.statusCode;
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
    { name: 'reply-from rejects the path', target: 'legacy', path: '/admin/%2e%2e/index.cfm' },
  ] as const)('$name: settles not-sent once, and the 503 follows the settlement', async ({ target, path }) => {
    let committed = false;
    const onSettled = vi.fn<OnSettled>(async () => {
      await delay(SETTLE_DELAY_MS);
      committed = true;
    });
    const gateway = await startGateway({ mode: 'buffer', onSettled, origin: target === 'refusing' ? refusedOrigin : legacy.url });

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
    { callback: 'beforeSend', mode: 'stream' },
    { callback: 'beforeSend', mode: 'buffer' },
    { callback: 'onSettled', mode: 'stream' },
    { callback: 'onSettled', mode: 'buffer' },
  ] as const)('$callback rejecting in $mode mode: logged without its message, response still delivered', async ({ callback, mode }) => {
    const failure = bridgeParseError();
    expect(failure.message).toContain(SECRET);
    legacy.setHandler((_req, res) => sendBytes(res, 200, LEGACY_BODY, { 'content-type': 'text/plain' }));
    const rejecting = (): Promise<never> => Promise.reject(failure);
    const onSettled = vi.fn<OnSettled>(callback === 'onSettled' ? rejecting : () => Promise.resolve());
    const beforeSend = callback === 'beforeSend' ? vi.fn<LegacyBeforeSend>(rejecting) : undefined;
    const gateway = await startGateway({ mode, onSettled, beforeSend });

    const outcome = await send(gateway, WRITE_PATH).outcome;

    expect(outcome).toMatchObject({ status: 200, complete: true });
    expect(outcome.body.toString()).toBe(LEGACY_BODY);
    expect(onSettled.mock.calls).toEqual([['completed']]);
    expect(gateway.logArguments()).toContain(failure.name);
    expect(gateway.logArguments()).not.toContain(SECRET);
    expect(gateway.logText()).not.toContain(SECRET);
    const failures = gateway.logs().filter((record) => (record.error as { type?: unknown } | undefined)?.type === failure.name);
    expect(failures.map((record) => [record.level, record.error])).toEqual([[ERROR_LEVEL, serializeError(failure)]]);
    expectSerializedErrors(gateway.logs());
  });
});

describe('forwardToLegacy when legacy answers a status Fastify rejects', () => {
  it.each(['stream', 'buffer'] as const)('%s mode: answers the 503, drains legacy and settles completed once', async (mode) => {
    legacy.setHandler((_req, res) => sendBytes(res, 600, LEGACY_BODY, { 'content-type': 'text/plain' }));
    const onSettled = vi.fn<OnSettled>(() => Promise.resolve());
    const onBuffered = vi.fn<OnBuffered>(() => Promise.resolve());
    const gateway = await startGateway({ mode, onSettled, onBuffered });

    const outcome = await send(gateway, WRITE_PATH).outcome;
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());

    expect(outcome).toMatchObject({ status: 503, complete: true });
    expect(onSettled.mock.calls).toEqual([['completed']]);
    expect(onBuffered).not.toHaveBeenCalled();
    expect(gateway.logs().filter((record) => record.level >= ERROR_LEVEL)).toEqual([]);
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
