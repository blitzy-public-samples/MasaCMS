// The web process in place of `next start`, over an injected Next factory: listening after boot, request lines,
// handler failures, start-up failures and the graceful shutdown.
import { Console } from 'node:console';
import { EventEmitter, once } from 'node:events';
import { Server, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDACTED, validateLogRecord, type Logger } from '@opt2/platform/logging';
import { logRequest, markPipelineRequest, setWebLoggerForTests } from '@/lib/telemetry';
import { createProcessLogger } from '@/server/logger';
import { claimRequestLine, currentRequestScope, signalBooted } from '@/server/shared';
import { parseServerArgs, runWebServer, startWebServer, type CreateNext, type NextApp } from '@/server/start';
import { captureLines, type LogLine } from '../helpers/log-lines';

const WEB_DIR = path.resolve(import.meta.dirname, '../..');

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Signals `arrived` and `answered` for the requests whose client disconnects mid-flight. */
const inFlight = new EventEmitter();

/** Answers as Next would for the paths the tests request; the admin paths stand in for pipeline requests. */
const handler: Handler = async (req, res) => {
  switch (req.url) {
    case '/healthz':
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"ok"}');
      return;
    case '/admin/clogin/main': {
      const scope = currentRequestScope();
      if (scope !== undefined) claimRequestLine(scope);
      res.statusCode = 403;
      res.end();
      return;
    }
    case '/admin/after':
    case '/admin/before': {
      // The pipeline takes the request before or after its client disconnects, then answers a denial.
      const closed = new Promise((resolve) => res.once('close', resolve));
      if (req.url === '/admin/after') markPipelineRequest();
      inFlight.emit('arrived');
      await closed;
      if (req.url === '/admin/before') markPipelineRequest();
      logRequest({
        route: 'page:clogin.main',
        httpMethod: 'GET',
        statusCode: 302,
        latencyMs: 600,
        requestId: 'abort-1',
        denial: 'people answered 403',
      });
      inFlight.emit('answered');
      return;
    }
    case '/boom':
      throw new Error('handler failed');
    case '/partial':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      throw new Error('stream failed');
    default:
      res.statusCode = 404;
      res.end();
  }
};

/** A Next factory whose app runs `handler`; `prepare` signals boot as the start-up hook does, unless told not to. */
function fakeNext(options: { boot?: boolean; prepareError?: Error } = {}): { createNext: CreateNext; app: NextApp } {
  const app: NextApp = {
    prepare: vi.fn(async () => {
      if (options.prepareError !== undefined) throw options.prepareError;
      if (options.boot !== false) signalBooted();
    }),
    getRequestHandler: () => handler,
    close: vi.fn(async () => undefined),
  };
  return { createNext: vi.fn(() => app), app };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Base URL of a listening server. */
const urlOf = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** Whether `promise` settled within a macrotask. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

/** Starts the web server on a free loopback port with a fake Next; returns it with its log lines and hooks. */
async function started(next = fakeNext()): Promise<{
  server: Server;
  lines: LogLine[];
  signals: EventEmitter;
  exit: ReturnType<typeof vi.fn>;
  flushSpans: ReturnType<typeof vi.fn>;
  logger: Logger;
}> {
  const { lines, destination } = captureLines();
  const logger = createProcessLogger({ OPT2_ENV: 'local' }, destination);
  const signals = new EventEmitter();
  const exit = vi.fn();
  const flushSpans = vi.fn(async () => undefined);
  const server = await startWebServer({
    argv: ['--hostname', '127.0.0.1'],
    env: { PORT: '0' },
    logger,
    createNext: next.createNext,
    flushSpans,
    exit,
    signals,
  });
  servers.push(server);
  return { server, lines, signals, exit, flushSpans, logger };
}

describe('parseServerArgs', () => {
  it.each<[string[], string | undefined]>([
    [[], undefined],
    [['--hostname', '127.0.0.1'], '127.0.0.1'],
    [['--hostname=0.0.0.0'], '0.0.0.0'],
  ])('reads the host of %j', (argv, hostname) => {
    expect(parseServerArgs(argv)).toEqual({ hostname });
  });

  it.each([[['--port', '8101']], [['extra']]])('refuses %j', (argv) => {
    expect(() => parseServerArgs(argv)).toThrow(TypeError);
  });
});

describe('startWebServer', () => {
  it('prepares Next in production mode and listens only once boot has signalled', async () => {
    const next = fakeNext({ boot: false });
    const { destination } = captureLines();
    const starting = startWebServer({
      argv: ['--hostname', '127.0.0.1'],
      env: { PORT: '0' },
      logger: createProcessLogger({ OPT2_ENV: 'local' }, destination),
      createNext: next.createNext,
      signals: new EventEmitter(),
    });

    await vi.waitFor(() => expect(next.app.prepare).toHaveBeenCalled());
    expect(await settled(starting)).toBe(false);
    signalBooted();
    const server = await starting;
    servers.push(server);

    expect(server.listening).toBe(true);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    expect(next.createNext).toHaveBeenCalledExactlyOnceWith({ dev: false, dir: WEB_DIR, hostname: '127.0.0.1', port: 0 });
  });

  it('writes one request line for each request the app did not log, and none for those it did', async () => {
    const { server, lines } = await started();

    const healthz = await fetch(`${urlOf(server)}/healthz`, { headers: { 'x-request-id': 'probe-1' } });
    const missing = await fetch(`${urlOf(server)}/_next/static/none.js`);
    const admin = await fetch(`${urlOf(server)}/admin/clogin/main`);

    expect([healthz.status, missing.status, admin.status]).toEqual([200, 404, 403]);
    expect(await healthz.json()).toEqual({ status: 'ok' });
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    for (const line of lines) expect(validateLogRecord(line).errors).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        severity: 'INFO',
        message: 'request',
        route: '/healthz',
        statusCode: 200,
        requestId: 'probe-1',
      }),
      expect.objectContaining({ severity: 'INFO', message: 'request', route: '/_next/*', statusCode: 404 }),
    ]);
  });

  it.each<[string, LogLine]>([
    [
      'after',
      { severity: 'WARNING', message: 'request denied: people answered 403', route: 'page:clogin.main', statusCode: 302 },
    ],
    ['before', { severity: 'INFO', message: 'request aborted', route: '(unmatched)' }],
  ])('writes one line for a pipeline request whose client disconnects %s the pipeline takes it', async (when, line) => {
    const { server, lines, logger } = await started();
    const restoreLogger = setWebLoggerForTests(logger);
    try {
      const arrived = once(inFlight, 'arrived');
      const answered = once(inFlight, 'answered');
      const client = new AbortController();
      const response = fetch(`${urlOf(server)}/admin/${when}`, {
        headers: { 'x-request-id': 'abort-1' },
        signal: client.signal,
      });
      await arrived;
      client.abort();
      await expect(response).rejects.toThrow();
      await answered;
    } finally {
      restoreLogger();
    }

    expect(lines).toEqual([expect.objectContaining({ ...line, requestId: 'abort-1' })]);
    expect(validateLogRecord(lines[0]).errors).toEqual([]);
    if (when === 'before') expect(lines[0]).not.toHaveProperty('statusCode');
  });

  it('keeps its requests out of an emit wrapper installed after it started, as HTTP instrumentation is', async () => {
    const { server } = await started();
    const original = Server.prototype.emit;
    const wrapped = vi.fn(function (this: Server, ...args: unknown[]) {
      return Reflect.apply(original, this, args) as boolean;
    });
    Server.prototype.emit = wrapped as unknown as Server['emit'];
    try {
      expect((await fetch(`${urlOf(server)}/healthz`)).status).toBe(200);
    } finally {
      Server.prototype.emit = original;
    }

    expect(wrapped.mock.calls.filter(([event]) => event === 'request')).toEqual([]);
  });

  it("answers a handler failure as next start does, logging it and the request", async () => {
    const { server, lines } = await started();

    const response = await fetch(`${urlOf(server)}/boom`);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(lines).toEqual([
      expect.objectContaining({
        severity: 'ERROR',
        message: 'request handling failed',
        error: expect.objectContaining({ type: 'Error', message: REDACTED }),
      }),
      expect.objectContaining({ message: 'request', route: '(unmatched)', statusCode: 500 }),
    ]);
  });

  it('ends a response whose headers were sent when its handler fails', async () => {
    const { server, lines } = await started();

    const response = await fetch(`${urlOf(server)}/partial`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('partial');
    await vi.waitFor(() => expect(lines).toHaveLength(2));
    expect(lines.map(({ severity, message }) => [severity, message])).toEqual([
      ['ERROR', 'request handling failed'],
      ['INFO', 'request'],
    ]);
  });

  it('rejects when the port is taken, listening on nothing', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    servers.push(blocker);
    const { destination } = captureLines();

    await expect(
      startWebServer({
        argv: ['--hostname', '127.0.0.1'],
        env: { PORT: String((blocker.address() as AddressInfo).port) },
        logger: createProcessLogger({ OPT2_ENV: 'local' }, destination),
        createNext: fakeNext().createNext,
        signals: new EventEmitter(),
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ])('on %s drains the server, closes Next, exports spans and exits %i once', async (signal, code) => {
    const next = fakeNext();
    const { server, signals, exit, flushSpans } = await started(next);
    await fetch(`${urlOf(server)}/healthz`);

    signals.emit(signal);
    signals.emit(signal);

    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
    expect(server.listening).toBe(false);
    expect(next.app.close).toHaveBeenCalledOnce();
    expect(flushSpans).toHaveBeenCalledOnce();
  });

  it('logs a failed shutdown step and still exits', async () => {
    const next = fakeNext();
    const { signals, exit, lines, flushSpans } = await started(next);
    vi.mocked(next.app.close).mockRejectedValueOnce(new Error('close failed'));

    signals.emit('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(143));
    expect(flushSpans).toHaveBeenCalledOnce();
    expect(lines).toEqual([expect.objectContaining({ severity: 'ERROR', message: 'shutdown failed' })]);
  });
});

describe('runWebServer', () => {
  /** A console target and warning emitter whose output must stay empty once routed. */
  function processSinks(): { console: Console; warnings: EventEmitter; raw: string[] } {
    const raw: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        raw.push(chunk.toString());
        done();
      },
    });
    return { console: new Console({ stdout: sink, stderr: sink }), warnings: new EventEmitter(), raw };
  }

  it('defaults NODE_ENV to production, routes console and warnings, and serves', async () => {
    const { lines, destination } = captureLines();
    const sinks = processSinks();
    const signals = new EventEmitter();
    const exit = vi.fn();
    const env: Record<string, string | undefined> = { PORT: '0', OPT2_ENV: 'local' };
    const next = fakeNext();

    await runWebServer({
      argv: ['--hostname', '127.0.0.1'],
      env,
      destination,
      ...sinks,
      loadNext: async () => next.createNext,
      exit,
      signals,
    });
    sinks.console.log(' ✓ Running next.config.ts took 3ms');
    sinks.warnings.emit('warning', Object.assign(new Error('deprecated'), { name: 'DeprecationWarning' }));
    signals.emit('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(143));
    expect(env.NODE_ENV).toBe('production');
    expect(sinks.raw).toEqual([]);
    expect(lines.map(({ severity, message }) => [severity, message])).toEqual([
      ['INFO', '✓ Running next.config.ts took 3ms'],
      ['WARNING', 'DeprecationWarning: deprecated'],
    ]);
  });

  it('keeps a NODE_ENV already set', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const env: Record<string, string | undefined> = { PORT: '0', NODE_ENV: 'test' };

    await runWebServer({
      argv: ['--hostname', '127.0.0.1'],
      env,
      destination: captureLines().destination,
      ...processSinks(),
      loadNext: async () => fakeNext().createNext,
      exit,
      signals,
    });
    signals.emit('SIGINT');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(130));
    expect(env.NODE_ENV).toBe('test');
  });

  it.each<[string, Partial<Parameters<typeof runWebServer>[0]>, string]>([
    [
      'a missing build',
      { loadNext: async () => fakeNext({ prepareError: new Error('Could not find a production build') }).createNext },
      'Error',
    ],
    ['an unknown argument', { argv: ['--port', '8101'], loadNext: async () => fakeNext().createNext }, 'TypeError'],
    ['an unloadable Next', { loadNext: () => Promise.reject(new Error('Cannot find package next')) }, 'Error'],
  ])('exits 1 with one start-up line for %s', async (_case, overrides, type) => {
    const { lines, destination } = captureLines();
    const exit = vi.fn();

    await runWebServer({
      argv: [],
      env: { PORT: '0' },
      destination,
      ...processSinks(),
      exit,
      signals: new EventEmitter(),
      ...overrides,
    });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0]).errors).toEqual([]);
    expect(lines[0]).toMatchObject({ severity: 'ERROR', message: 'start-up failed', service: 'web', error: { type } });
  });
});
