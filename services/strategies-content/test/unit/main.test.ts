// Tests the strategies-content entry's start-up order, bind and failure handling with tracing, the kit, the app and logging mocked.
import type { StartupFailureOptions } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggingModule = typeof import('@opt2/platform/logging');
type ServiceKitModule = typeof import('@opt2/platform/service-kit');
type LogLine = Record<string, unknown>;
/** The start-up step a run fails at. */
type Stage = 'tracing' | 'env' | 'build' | 'listen';
/** Failures a run's cleanup meets after the start-up failure. */
interface CleanupFailures {
  log?: unknown;
  tracing?: unknown;
  shutdown?: unknown;
}

const ENV = Object.freeze({ PORT: 8114 });
const SCHEMA = Object.freeze({ sentinel: 'contentEnvSchema' });
const OPTIONS = { service: 'strategies-content', version: '1.0.0' } as const;
const MOCKED = ['@opt2/platform/tracing', '@opt2/platform/service-kit', '../../src/app.js', '@opt2/platform/logging'] as const;
const STARTED = ['tracing:start', 'tracing:done', 'service-kit', 'app'] as const;

let real: LoggingModule;
let EnvValidationError: ServiceKitModule['EnvValidationError'];
let savedExitCode: typeof process.exitCode;

/** Resolves on the next macrotask, so an awaited step yields to the event loop. */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Imports the entry with every dependency mocked, failing at `stage` with `thrown`; returns the import's outcome, fakes, events and lines. */
async function runMain(stage?: Stage, thrown?: unknown, cleanup: CleanupFailures = {}) {
  const events: string[] = [];
  const lines: LogLine[] = [];
  const destination: NonNullable<StartupFailureOptions['destination']> = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  const startTracing = vi.fn<(options: { serviceName: string; version: string }) => Promise<void>>(async () => {
    events.push('tracing:start');
    await nextTick();
    if (stage === 'tracing') throw thrown;
    events.push('tracing:done');
  });
  const shutdownTracing = vi.fn(async () => {
    events.push('tracing:shutdown');
    await nextTick();
    if (cleanup.tracing !== undefined) throw cleanup.tracing;
  });
  const loadEnv = vi.fn<(schema: unknown) => typeof ENV>(() => {
    if (stage === 'env') throw thrown;
    return ENV;
  });
  const listen = vi.fn<(options: { port: number; host: string }) => Promise<string>>(async () => {
    if (stage === 'listen') throw thrown;
    return 'http://0.0.0.0:8114';
  });
  const logError = vi.fn<(record: unknown, message: string) => void>();
  const shutdown = vi.fn(async () => {
    events.push('shutdown');
    await nextTick();
    if (cleanup.shutdown !== undefined) throw cleanup.shutdown;
  });
  const app = { listen, log: { error: logError }, opt2: { shutdown } };
  const buildApp = vi.fn<(options: { env: unknown }) => Promise<typeof app>>(async () => {
    if (stage === 'build') throw thrown;
    return app;
  });
  const logStartupFailure = vi.fn(async (err: unknown, options: StartupFailureOptions) => {
    events.push(`log:${options.message ?? 'start-up failed'}`);
    if (cleanup.log !== undefined && options.message === undefined) throw cleanup.log;
    await real.logStartupFailure(err, { ...options, destination });
  });
  const serializeError = vi.fn((value: unknown) => real.serializeError(value));

  vi.resetModules();
  vi.doMock('@opt2/platform/tracing', () => ({ startTracing, shutdownTracing }));
  vi.doMock('@opt2/platform/service-kit', () => {
    events.push('service-kit');
    return { loadEnv };
  });
  vi.doMock('../../src/app.js', () => {
    events.push('app');
    return { buildApp, contentEnvSchema: SCHEMA };
  });
  vi.doMock('@opt2/platform/logging', () => {
    events.push('logging');
    return { logStartupFailure, serializeError };
  });
  const outcome = await import('../../src/main.js').then(
    () => ({ rejected: false as const }),
    (reason: unknown) => ({ rejected: true as const, reason }),
  );
  return { outcome, events, lines, startTracing, shutdownTracing, loadEnv, buildApp, listen, logError, shutdown, logStartupFailure, serializeError };
}

beforeAll(async () => {
  real = await vi.importActual<LoggingModule>('@opt2/platform/logging');
  ({ EnvValidationError } = await vi.importActual<ServiceKitModule>('@opt2/platform/service-kit'));
});

beforeEach(() => {
  savedExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = savedExitCode;
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('strategies-content main', () => {
  it('starts tracing before loading the kit and the app, loads the content schema and binds env.PORT on all interfaces', async () => {
    const run = await runMain();

    expect(run.outcome.rejected).toBe(false);
    expect(run.startTracing).toHaveBeenCalledWith({ serviceName: 'strategies-content', version: '1.0.0' });
    expect(run.events).toStrictEqual([...STARTED]);
    expect(run.loadEnv).toHaveBeenCalledTimes(1);
    expect(run.loadEnv.mock.calls[0]?.[0]).toBe(SCHEMA);
    expect(run.buildApp).toHaveBeenCalledTimes(1);
    expect(run.buildApp.mock.calls[0]?.[0].env).toBe(ENV);
    expect(run.listen).toHaveBeenCalledWith({ port: 8114, host: '0.0.0.0' });
    expect(process.exitCode).toBe(savedExitCode);
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(run.logStartupFailure).not.toHaveBeenCalled();
  });

  it.each<[string, Exclude<Stage, 'listen'>, () => unknown, readonly string[], Record<string, string>]>([
    ['startTracing rejects', 'tracing', () => new Error('exporter failed'), ['tracing:start'], { type: 'Error' }],
    [
      'loadEnv throws EnvValidationError',
      'env',
      () => new EnvValidationError(['OPT2_SERVICE_URLS.identity: is required'], 'strategies-content'),
      STARTED,
      { type: 'EnvValidationError', message: 'strategies-content: invalid environment (OPT2_SERVICE_URLS.identity: is required)' },
    ],
    ['buildApp rejects', 'build', () => new Error('password authentication failed for user "content_app"'), STARTED, { type: 'Error' }],
  ])('logs one log-record.v1 line, stops tracing and sets exit code 1 when %s', async (_label, stage, make, started, error) => {
    const thrown = make();

    const run = await runMain(stage, thrown);

    expect(run.outcome.rejected).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(run.events).toStrictEqual([...started, 'logging', 'log:start-up failed', 'tracing:shutdown']);
    expect(run.logStartupFailure).toHaveBeenCalledTimes(1);
    expect(run.logStartupFailure.mock.calls[0]?.[0]).toBe(thrown);
    expect(run.logStartupFailure.mock.calls[0]?.[1]).toStrictEqual(OPTIONS);
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(run.lines).toHaveLength(1);
    const line = run.lines[0] as LogLine;
    expect(real.validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({ ...OPTIONS, severity: 'ERROR', message: 'start-up failed', error });
    expect(run.listen).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
  });

  it('stops tracing even when writing the start-up line fails, and rejects with that failure', async () => {
    const logFailure = new Error('stdout closed');

    const run = await runMain('build', new Error('build failed'), { log: logFailure });

    expect(run.outcome).toStrictEqual({ rejected: true, reason: logFailure });
    expect(process.exitCode).toBe(1);
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(run.events.slice(-2)).toStrictEqual(['log:start-up failed', 'tracing:shutdown']);
  });

  it('logs a failed tracing shutdown as a second line and keeps exit code 1', async () => {
    const tracingFailure = new Error('export failed');

    const run = await runMain('env', new Error('env failed'), { tracing: tracingFailure });

    expect(run.outcome.rejected).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(run.logStartupFailure.mock.calls[1]?.[0]).toBe(tracingFailure);
    expect(run.logStartupFailure.mock.calls[1]?.[1]).toStrictEqual({ ...OPTIONS, message: 'shutdown failed' });
    expect(run.lines.map((line) => line.message)).toStrictEqual(['start-up failed', 'shutdown failed']);
  });

  it('logs the serialized error through the built app and awaits its shutdown when listen rejects', async () => {
    const thrown = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:8114'), { code: 'EADDRINUSE', syscall: 'listen' });

    const run = await runMain('listen', thrown);

    expect(run.outcome.rejected).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(run.serializeError).toHaveBeenCalledWith(thrown);
    expect(run.logError).toHaveBeenCalledTimes(1);
    expect(run.logError.mock.calls[0]).toStrictEqual([{ error: real.serializeError(thrown) }, 'start-up failed']);
    expect(run.shutdown).toHaveBeenCalledTimes(1);
    expect(run.events).toStrictEqual([...STARTED, 'logging', 'shutdown']);
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(run.logStartupFailure).not.toHaveBeenCalled();
  });

  it('logs a failed kit shutdown serialized through the built app and keeps exit code 1', async () => {
    const shutdownFailure = Object.assign(new Error('pool end failed'), { code: 'ECONNRESET' });

    const run = await runMain('listen', new Error('listen failed'), { shutdown: shutdownFailure });

    expect(run.outcome.rejected).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(run.logError.mock.calls[1]).toStrictEqual([{ error: real.serializeError(shutdownFailure) }, 'shutdown failed']);
  });
});
