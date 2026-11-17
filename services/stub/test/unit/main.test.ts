// Tests the stub entry's start-up order, bind and failure handling with tracing, the kit, the app and logging mocked.
import type { StartupFailureOptions } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggingModule = typeof import('@opt2/platform/logging');
type ServiceKitModule = typeof import('@opt2/platform/service-kit');
type LogLine = Record<string, unknown>;
/** The start-up step a run fails at. */
type Stage = 'tracing' | 'env' | 'build' | 'listen';
/** What a run's failure handling rejects with: the start-up line's write, the tracing shutdown or the built app's shutdown. */
interface Faults {
  logStartupFailure?: unknown;
  shutdownTracing?: unknown;
  appShutdown?: unknown;
}

const ENV = Object.freeze({ PORT: 8199 });
const SCHEMA = Object.freeze({ sentinel: 'stubEnvSchema' });
const OPTIONS = { service: 'stub', version: '1.0.0' } as const;
const MOCKED = ['@opt2/platform/tracing', '@opt2/platform/service-kit', '../../src/app.js', '@opt2/platform/logging'] as const;
const SECRET = 's3cr3t-stub-password';

let real: LoggingModule;
let EnvValidationError: ServiceKitModule['EnvValidationError'];
let savedExitCode: typeof process.exitCode;

/** Resolves on the next macrotask, so an awaited step yields to the event loop. */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Imports the entry once with every dependency mocked, failing at `stage` with `thrown` and its failure handling as `faults` say;
 * returns the fakes, events, captured lines and, when the entry's evaluation rejected, its reason.
 */
async function runMain(stage?: Stage, thrown?: unknown, faults: Faults = {}) {
  const events: string[] = [];
  const lines: LogLine[] = [];
  const destination: NonNullable<StartupFailureOptions['destination']> = {
    write: (line: string) => {
      const record = JSON.parse(line) as LogLine;
      events.push(`line:${String(record.message)}`);
      lines.push(record);
    },
  };
  const startTracing = vi.fn(async (_options: { serviceName: string; version: string }) => {
    events.push('tracing:start');
    await nextTick();
    if (stage === 'tracing') throw thrown;
    events.push('tracing:done');
  });
  const shutdownTracing = vi.fn(async () => {
    events.push('tracing:shutdown:start');
    await nextTick();
    if (faults.shutdownTracing !== undefined) throw faults.shutdownTracing;
    events.push('tracing:shutdown:done');
  });
  const loadEnv = vi.fn((_schema: unknown) => {
    if (stage === 'env') throw thrown;
    return ENV;
  });
  const listen = vi.fn(async (_options: { port: number; host: string }) => {
    if (stage === 'listen') throw thrown;
    return 'http://0.0.0.0:8199';
  });
  const logError = vi.fn((_record: unknown, message: string) => {
    events.push(`log:${message}`);
  });
  const shutdown = vi.fn(async () => {
    events.push('shutdown:start');
    await nextTick();
    if (faults.appShutdown !== undefined) throw faults.appShutdown;
    events.push('shutdown:done');
  });
  const buildApp = vi.fn(async (_options: { env: unknown }) => {
    if (stage === 'build') throw thrown;
    return { listen, log: { error: logError }, opt2: { shutdown } };
  });
  const logStartupFailure = vi.fn(async (err: unknown, options: StartupFailureOptions) => {
    if (faults.logStartupFailure !== undefined && options.message === undefined) throw faults.logStartupFailure;
    await real.logStartupFailure(err, { ...options, destination });
  });

  vi.resetModules();
  vi.doMock('@opt2/platform/tracing', () => ({ startTracing, shutdownTracing }));
  vi.doMock('@opt2/platform/service-kit', () => {
    events.push('service-kit');
    return { loadEnv };
  });
  vi.doMock('../../src/app.js', () => {
    events.push('app');
    return { buildApp, stubEnvSchema: SCHEMA };
  });
  vi.doMock('@opt2/platform/logging', () => {
    events.push('logging');
    return { logStartupFailure, serializeError: real.serializeError };
  });
  const rejection = await import('../../src/main.js').then(
    () => undefined,
    (reason: unknown) => ({ reason }),
  );
  return { events, lines, rejection, startTracing, shutdownTracing, loadEnv, buildApp, listen, logError, shutdown, logStartupFailure };
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

describe('stub main', () => {
  it('starts tracing before loading the kit and the app, then binds env.PORT on all interfaces', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = await runMain();

    expect(run.startTracing).toHaveBeenCalledTimes(1);
    expect(run.startTracing).toHaveBeenCalledWith({ serviceName: 'stub', version: '1.0.0' });
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app']);
    expect(run.loadEnv).toHaveBeenCalledTimes(1);
    expect(run.loadEnv.mock.calls[0]?.[0]).toBe(SCHEMA);
    expect(run.buildApp).toHaveBeenCalledTimes(1);
    expect(run.buildApp.mock.calls[0]?.[0]).toStrictEqual({ env: ENV });
    expect(run.buildApp.mock.calls[0]?.[0].env).toBe(ENV);
    expect(run.listen).toHaveBeenCalledTimes(1);
    expect(run.listen).toHaveBeenCalledWith({ port: 8199, host: '0.0.0.0' });
    expect(process.exitCode).toBe(savedExitCode);
    expect(run.rejection).toBeUndefined();
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.logError).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each<[string, Exclude<Stage, 'listen'>, () => unknown, string[], string, string]>([
    ['startTracing rejects', 'tracing', () => new Error('exporter failed'), ['tracing:start', 'logging'], 'Error', '[REDACTED]'],
    [
      'loadEnv throws EnvValidationError',
      'env',
      () => new EnvValidationError(['OPT2_TOKEN_ISSUER: is required'], 'stub'),
      ['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging'],
      'EnvValidationError',
      'stub: invalid environment (OPT2_TOKEN_ISSUER: is required)',
    ],
    [
      'buildApp rejects with ECONNREFUSED',
      'build',
      () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 }),
      ['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging'],
      'Error',
      'connect ECONNREFUSED',
    ],
  ])('writes one log-record.v1 ERROR line, then stops tracing, and sets exit code 1 when %s', async (_label, stage, make, events, type, message) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = make();

    const run = await runMain(stage, thrown);

    expect(process.exitCode).toBe(1);
    expect(run.rejection).toBeUndefined();
    expect(run.events).toStrictEqual([...events, 'line:start-up failed', 'tracing:shutdown:start', 'tracing:shutdown:done']);
    expect(run.logStartupFailure).toHaveBeenCalledTimes(1);
    expect(run.logStartupFailure.mock.calls[0]?.[0]).toBe(thrown);
    expect(run.logStartupFailure.mock.calls[0]?.[1]).toStrictEqual(OPTIONS);
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(run.lines).toHaveLength(1);
    const line = run.lines[0] as LogLine;
    expect(real.validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({ ...OPTIONS, severity: 'ERROR', message: 'start-up failed', error: { type, message } });
    expect(run.buildApp).toHaveBeenCalledTimes(stage === 'build' ? 1 : 0);
    expect(run.listen).not.toHaveBeenCalled();
    expect(run.logError).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still stops tracing when the start-up line cannot be written, and rejects with that failure', async () => {
    const writeFailure = new Error('stdout closed');

    const run = await runMain('env', new Error('env failed'), { logStartupFailure: writeFailure });

    expect(process.exitCode).toBe(1);
    expect(run.rejection?.reason).toBe(writeFailure);
    expect(run.events).toStrictEqual([
      'tracing:start',
      'tracing:done',
      'service-kit',
      'app',
      'logging',
      'tracing:shutdown:start',
      'tracing:shutdown:done',
    ]);
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(run.lines).toHaveLength(0);
  });

  it('writes a tracing shutdown that rejects as a second, shutdown failed line', async () => {
    const tracingFailure = new Error(`exporter flush to http://otel:${SECRET}@127.0.0.1:4318 failed`);

    const run = await runMain('build', new Error('build failed'), { shutdownTracing: tracingFailure });

    expect(process.exitCode).toBe(1);
    expect(run.rejection).toBeUndefined();
    expect(run.events.slice(-3)).toStrictEqual(['line:start-up failed', 'tracing:shutdown:start', 'line:shutdown failed']);
    expect(run.logStartupFailure.mock.calls[1]).toStrictEqual([tracingFailure, { ...OPTIONS, message: 'shutdown failed' }]);
    expect(run.lines.map((line) => line.message)).toStrictEqual(['start-up failed', 'shutdown failed']);
    expect(run.lines.map((line) => real.validateLogRecord(line))).toStrictEqual([
      { valid: true, errors: [] },
      { valid: true, errors: [] },
    ]);
    expect(run.lines[1]).toMatchObject({ ...OPTIONS, severity: 'ERROR', error: { type: 'Error', message: real.serializeError(tracingFailure).message } });
    expect(JSON.stringify(run.lines)).not.toContain(SECRET);
  });

  it.each<[string, unknown, string[]]>([
    ['its shutdown resolves', undefined, ['log:start-up failed', 'shutdown:start', 'shutdown:done']],
    ['its shutdown rejects', new Error(`pool end failed for postgres://stub_app:${SECRET}@127.0.0.1/stub`), ['log:start-up failed', 'shutdown:start', 'log:shutdown failed']],
  ])('logs a serialized error through the built app and awaits its shutdown when listen rejects and %s', async (_label, appShutdown, tail) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = Object.assign(new Error(`listen EADDRINUSE: address already in use 0.0.0.0:8199 (PG_PASSWORD=${SECRET})`), {
      code: 'EADDRINUSE',
      syscall: 'listen',
    });

    const run = await runMain('listen', thrown, { appShutdown });

    expect(process.exitCode).toBe(1);
    expect(run.rejection).toBeUndefined();
    const logged = [[{ error: real.serializeError(thrown) }, 'start-up failed']];
    if (appShutdown !== undefined) logged.push([{ error: real.serializeError(appShutdown) }, 'shutdown failed']);
    expect(run.logError.mock.calls).toStrictEqual(logged);
    for (const [record] of run.logError.mock.calls) {
      expect((record as { error: unknown }).error).not.toBeInstanceOf(Error);
      expect(JSON.stringify(record)).not.toContain(SECRET);
    }
    expect(run.logError.mock.calls[0]?.[0]).toMatchObject({ error: { type: 'Error', message: 'listen EADDRINUSE' } });
    expect(run.shutdown).toHaveBeenCalledTimes(1);
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging', ...tail]);
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(run.lines).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
