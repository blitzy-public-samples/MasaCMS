// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The e-signature entry's start-up order, bind and failure handling, with tracing, the kit, the app and logging mocked. */
import type { StartupFailureOptions } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggingModule = typeof import('@opt2/platform/logging');
type ServiceKitModule = typeof import('@opt2/platform/service-kit');
type LogLine = Record<string, unknown>;
/** The start-up step a run fails at. */
type Stage = 'tracing' | 'env' | 'build' | 'listen';

/** Where a run fails: the start-up step and its error, and optionally the failure logging or a shutdown. */
interface Faults {
  stage?: Stage;
  thrown?: unknown;
  /** Rejection of the first logStartupFailure call. */
  logFailure?: Error;
  /** Rejection of shutdownTracing. */
  tracingShutdownFailure?: Error;
  /** Rejection of the built app's kit shutdown. */
  appShutdownFailure?: Error;
}

const ENV = Object.freeze({ PORT: 8120 });
const SCHEMA = Object.freeze({ sentinel: 'esignatureEnvSchema' });
const OPTIONS = { service: 'e-signature', version: '1.0.0' } as const;
const MOCKED = ['@opt2/platform/tracing', '@opt2/platform/service-kit', '../../src/app.js', '@opt2/platform/logging'] as const;
const TRACING_STOPPED = ['tracing:shutdown:start', 'tracing:shutdown:done'];
const ANY_STACK: unknown = expect.any(String);

let real: LoggingModule;
let EnvValidationError: ServiceKitModule['EnvValidationError'];
let savedExitCode: typeof process.exitCode;

/** Resolves on the next macrotask, so an awaited step yields to the event loop. */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Imports the entry once with every dependency mocked and `faults` injected; returns the fakes, events, captured lines and the import's rejection. */
async function runMain(faults: Faults = {}) {
  const { stage, thrown } = faults;
  const events: string[] = [];
  const lines: LogLine[] = [];
  const destination: NonNullable<StartupFailureOptions['destination']> = {
    write: (line: string) => {
      events.push('line');
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
    events.push('tracing:shutdown:start');
    await nextTick();
    if (faults.tracingShutdownFailure !== undefined) throw faults.tracingShutdownFailure;
    events.push('tracing:shutdown:done');
  });
  const loadEnv = vi.fn<(schema: unknown) => typeof ENV>(() => {
    if (stage === 'env') throw thrown;
    return ENV;
  });
  const listen = vi.fn<(options: { port: number; host: string }) => Promise<string>>(async () => {
    await nextTick();
    if (stage === 'listen') throw thrown;
    return 'http://0.0.0.0:8120';
  });
  const logError = vi.fn<(fields: unknown, message: string) => void>();
  const shutdown = vi.fn(async () => {
    events.push('shutdown:start');
    await nextTick();
    if (faults.appShutdownFailure !== undefined) throw faults.appShutdownFailure;
    events.push('shutdown:done');
  });
  const buildApp = vi.fn<(options: { env: unknown }) => Promise<unknown>>(async () => {
    await nextTick();
    if (stage === 'build') throw thrown;
    return { listen, log: { error: logError }, opt2: { shutdown } };
  });
  const logStartupFailure = vi.fn((err: unknown, options: StartupFailureOptions) => real.logStartupFailure(err, { ...options, destination }));
  if (faults.logFailure !== undefined) logStartupFailure.mockRejectedValueOnce(faults.logFailure);

  vi.resetModules();
  vi.doMock('@opt2/platform/tracing', () => ({ startTracing, shutdownTracing }));
  vi.doMock('@opt2/platform/service-kit', () => {
    events.push('service-kit');
    return { loadEnv };
  });
  vi.doMock('../../src/app.js', () => {
    events.push('app');
    return { buildApp, esignatureEnvSchema: SCHEMA };
  });
  vi.doMock('@opt2/platform/logging', () => {
    events.push('logging');
    return { logStartupFailure, serializeError: real.serializeError };
  });
  const rejection = await import('../../src/main.js').then(
    () => undefined,
    (err: unknown) => err,
  );
  return { events, lines, rejection, startTracing, shutdownTracing, loadEnv, buildApp, listen, logError, shutdown, logStartupFailure };
}

beforeAll(async () => {
  real = await vi.importActual<LoggingModule>('@opt2/platform/logging');
  ({ EnvValidationError } = await vi.importActual<ServiceKitModule>('@opt2/platform/service-kit'));
});

beforeEach(() => {
  savedExitCode = process.exitCode;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = savedExitCode;
  for (const path of MOCKED) vi.doUnmock(path);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('e-signature main', () => {
  it('starts tracing before loading the kit and the app, then binds env.PORT from esignatureEnvSchema on all interfaces', async () => {
    const run = await runMain();

    expect(run.rejection).toBeUndefined();
    expect(run.startTracing).toHaveBeenCalledWith({ serviceName: 'e-signature', version: '1.0.0' });
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app']);
    expect(run.loadEnv.mock.calls).toStrictEqual([[SCHEMA]]);
    expect(run.buildApp.mock.calls[0]?.[0].env).toBe(ENV);
    expect(run.listen.mock.calls).toStrictEqual([[{ port: 8120, host: '0.0.0.0' }]]);
    expect(process.exitCode).toBe(savedExitCode);
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(run.logError).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each<[string, Exclude<Stage, 'listen'>, () => unknown, string[], string, string]>([
    ['startTracing rejects', 'tracing', () => new Error('exporter failed'), ['tracing:start'], 'Error', '[REDACTED]'],
    [
      'loadEnv throws EnvValidationError',
      'env',
      () => new EnvValidationError(['OPT2_SERVICE_URLS.people: is required'], 'e-signature'),
      ['tracing:start', 'tracing:done', 'service-kit', 'app'],
      'EnvValidationError',
      'e-signature: invalid environment (OPT2_SERVICE_URLS.people: is required)',
    ],
    [
      'buildApp rejects with ECONNREFUSED',
      'build',
      () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED', syscall: 'connect', errno: -111 }),
      ['tracing:start', 'tracing:done', 'service-kit', 'app'],
      'Error',
      'connect ECONNREFUSED',
    ],
  ])('writes one ERROR line, then stops tracing, and sets exit code 1 when %s', async (_label, stage, make, started, type, message) => {
    const thrown = make();

    const run = await runMain({ stage, thrown });

    expect(run.rejection).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(run.events).toStrictEqual([...started, 'logging', 'line', ...TRACING_STOPPED]);
    expect(run.logStartupFailure.mock.calls).toStrictEqual([[thrown, OPTIONS]]);
    expect(run.lines).toHaveLength(1);
    expect(real.validateLogRecord(run.lines[0] as LogLine)).toStrictEqual({ valid: true, errors: [] });
    expect(run.lines[0]).toMatchObject({ ...OPTIONS, severity: 'ERROR', message: 'start-up failed', error: { type, message } });
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
    expect(run.listen).not.toHaveBeenCalled();
    expect(run.logError).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('stops tracing even when the start-up line cannot be written', async () => {
    const logFailure = new Error('stdout closed');

    const run = await runMain({ stage: 'build', thrown: new Error('build failed'), logFailure });

    expect(run.rejection).toBe(logFailure);
    expect(process.exitCode).toBe(1);
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging', ...TRACING_STOPPED]);
    expect(run.shutdownTracing).toHaveBeenCalledTimes(1);
  });

  it('logs a tracing shutdown failure as its own value-free line', async () => {
    const run = await runMain({ stage: 'env', thrown: new Error('env failed'), tracingShutdownFailure: new Error('export to row@example.com failed') });

    expect(run.rejection).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(run.logStartupFailure.mock.calls[1]?.[1]).toStrictEqual({ ...OPTIONS, message: 'shutdown failed' });
    expect(run.lines.map((line) => line.message)).toStrictEqual(['start-up failed', 'shutdown failed']);
    expect(run.lines.map((line) => real.validateLogRecord(line).errors)).toStrictEqual([[], []]);
    expect(JSON.stringify(run.lines)).not.toContain('row@example.com');
  });

  it.each<[string, Error | undefined, string[]]>([
    ['the kit shutdown resolves', undefined, ['start-up failed']],
    ['the kit shutdown rejects', new Error('pool end failed for row@example.com'), ['start-up failed', 'shutdown failed']],
  ])('logs a listen failure through the built app as a serialized error record and awaits its shutdown when %s', async (_label, appShutdownFailure, messages) => {
    const thrown = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:8120'), { code: 'EADDRINUSE', syscall: 'listen' });

    const run = await runMain({ stage: 'listen', thrown, appShutdownFailure });

    expect(run.rejection).toBeUndefined();
    expect(process.exitCode).toBe(1);
    const failures = [thrown, appShutdownFailure].slice(0, messages.length);
    expect(run.logError.mock.calls).toStrictEqual(failures.map((err, at) => [{ error: real.serializeError(err) }, messages[at]]));
    expect(run.logError.mock.calls[0]?.[0]).toStrictEqual({ error: { type: 'Error', message: 'listen EADDRINUSE', stack: ANY_STACK } });
    expect(JSON.stringify(run.logError.mock.calls)).not.toContain('row@example.com');
    expect(run.shutdown).toHaveBeenCalledTimes(1);
    expect(run.events).toStrictEqual([
      'tracing:start',
      'tracing:done',
      'service-kit',
      'app',
      'logging',
      'shutdown:start',
      ...(appShutdownFailure === undefined ? ['shutdown:done'] : []),
    ]);
    expect(run.shutdownTracing).not.toHaveBeenCalled();
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.lines).toHaveLength(0);
  });
});
