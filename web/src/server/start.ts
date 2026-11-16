// The web process in place of `next start`: Next.js behind the platform logger, listening only once boot succeeded,
// with one log line per request and one graceful shutdown.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Server, createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { logStartupFailure, serializeError, type Logger, type StartupFailureOptions } from '@opt2/platform/logging';
import { flushTracing } from '@opt2/platform/tracing';
import { createProcessLogger, flushLogger, routeConsole, routeWarnings } from './logger.ts';
import { logUnloggedRequest } from './request-log.ts';
import { WEB_VERSION, awaitBoot, installRequestScope, type RequestScope } from './shared.ts';

/** The web package directory, which holds the Next build. */
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Next opens each request's SERVER span itself. The platform's HTTP instrumentation wraps Server.prototype.emit once
// node:http loads after tracing starts, which would nest a second SERVER span around Next's, so the server keeps this.
const UNINSTRUMENTED_EMIT = Server.prototype.emit;

/** The parts of Next's custom server the web process uses. */
export interface NextApp {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close(): Promise<void>;
}

/** Next's custom-server factory, the default export of `next`. */
export type CreateNext = (options: { dev: false; dir: string; hostname?: string; port: number }) => NextApp;

/** Signals the shutdown handler listens for, with the exit code of each (`next start`'s). */
const SHUTDOWN_EXIT_CODES = { SIGTERM: 143, SIGINT: 130 } as const;

/** What {@link startWebServer} needs; the defaults are the process's own. */
export interface WebServerOptions {
  /** Arguments after the script: only `--hostname <host>`, absent meaning every interface. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  readonly createNext: CreateNext;
  readonly dir?: string;
  readonly flushSpans?: () => Promise<void>;
  readonly exit?: (code: number) => void;
  readonly signals?: Pick<NodeJS.EventEmitter, 'on'>;
}

/** The host `argv` names with `--hostname`; throws a TypeError for any other argument. */
export function parseServerArgs(argv: readonly string[]): { hostname?: string } {
  const { values } = parseArgs({ args: [...argv], options: { hostname: { type: 'string' } }, strict: true });
  return { hostname: values.hostname };
}

/** Starts listening on `port` and `hostname`; rejects with the listen error, such as EADDRINUSE. */
function listen(server: Server, port: number, hostname: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Runs each request in its own scope with its unlogged line, answering a handler failure as `next start` does. */
function requestListener(handle: ReturnType<NextApp['getRequestHandler']>, logger: Logger): RequestListener {
  const scopes = new AsyncLocalStorage<RequestScope>();
  installRequestScope(scopes);
  return (req, res) => {
    const scope: RequestScope = { pipeline: false, logged: false };
    scopes.run(scope, () => {
      logUnloggedRequest(req, res, scope, logger);
      handle(req, res).catch((error: unknown) => {
        logger.error({ error: serializeError(error) }, 'request handling failed');
        if (res.headersSent) {
          res.end();
          return;
        }
        res.statusCode = 500;
        res.end('Internal Server Error');
      });
    });
  };
}

/** Installs the one process shutdown: drain the server, close Next, export queued spans, flush the log, then exit. */
function installShutdown(server: Server, app: NextApp, options: WebServerOptions): void {
  const { logger, flushSpans = flushTracing, exit = (code) => process.exit(code), signals = process } = options;
  let stopping = false;
  const settle = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      logger.error({ error: serializeError(error) }, 'shutdown failed');
    }
  };
  const stop = async (signal: keyof typeof SHUTDOWN_EXIT_CODES): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // In-flight requests finish; close() also ends idle keep-alive connections.
    await settle(
      () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    );
    await settle(() => app.close());
    await settle(flushSpans);
    await flushLogger(logger);
    exit(SHUTDOWN_EXIT_CODES[signal]);
  };
  for (const signal of Object.keys(SHUTDOWN_EXIT_CODES) as (keyof typeof SHUTDOWN_EXIT_CODES)[]) {
    signals.on(signal, () => void stop(signal));
  }
}

/** Prepares Next, waits for the boot handshake, then listens on `PORT`; rejects on an argument, prepare or listen error. */
export async function startWebServer(options: WebServerOptions): Promise<Server> {
  const { hostname } = parseServerArgs(options.argv);
  // Boot has validated PORT before the handshake resolves; Next only stores it until then.
  const port = Number(options.env.PORT);
  const booted = awaitBoot();
  const app = options.createNext({ dev: false, dir: options.dir ?? WEB_DIR, hostname, port });
  await app.prepare();
  await booted;
  const server = createServer(requestListener(app.getRequestHandler(), options.logger));
  server.emit = UNINSTRUMENTED_EMIT;
  await listen(server, port, hostname);
  installShutdown(server, app, options);
  return server;
}

/** What {@link runWebServer} replaces in tests; the defaults are the process's own. */
export interface RunOptions {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly console?: Console;
  readonly warnings?: NodeJS.EventEmitter;
  readonly destination?: StartupFailureOptions['destination'];
  readonly loadNext?: () => Promise<CreateNext>;
  readonly exit?: (code: number) => void;
  readonly signals?: Pick<NodeJS.EventEmitter, 'on'>;
}

/** Loads Next's custom-server factory. */
async function importNext(): Promise<CreateNext> {
  const { default: next } = await import('next');
  return (options) => next(options);
}

/** Runs the web process with NODE_ENV defaulted and console and warnings logged; a start-up failure exits 1. */
export async function runWebServer(options: RunOptions = {}): Promise<void> {
  const { argv = process.argv.slice(2), env = process.env, destination, exit = (code) => process.exit(code) } = options;
  // As bin/next does, before Next loads.
  if (!env.NODE_ENV) env.NODE_ENV = 'production';
  const logger = createProcessLogger(env, destination);
  routeConsole(logger, options.console);
  routeWarnings(logger, options.warnings);
  try {
    const createNext = await (options.loadNext ?? importNext)();
    await startWebServer({ argv, env, logger, createNext, exit, signals: options.signals });
  } catch (error) {
    const source = env as NodeJS.ProcessEnv;
    await logStartupFailure(error, { service: 'web', version: WEB_VERSION, source, destination });
    await flushLogger(logger);
    exit(1);
  }
}
