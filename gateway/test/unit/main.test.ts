// Tests the gateway entry's start-up order, bind and failure handling with tracing, the kit, the app and logging mocked.
import type { StartupFailureOptions } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggingModule = typeof import('@opt2/platform/logging');
type ServiceKitModule = typeof import('@opt2/platform/service-kit');
type LogLine = Record<string, unknown>;
/** The start-up step a run fails at. */
type Stage = 'tracing' | 'env' | 'build' | 'listen';

const ENV = Object.freeze({ PORT: 8123 });
const SCHEMA = Object.freeze({ sentinel: 'gatewayEnvSchema' });
const OPTIONS = { service: 'gateway', version: '1.0.0' } as const;
const MOCKED = ['@opt2/platform/tracing', '@opt2/platform/service-kit', '../../src/app.js', '@opt2/platform/logging'] as const;

let real: LoggingModule;
let EnvValidationError: ServiceKitModule['EnvValidationError'];
let savedExitCode: typeof process.exitCode;

/** Resolves on the next macrotask, so an awaited step yields to the event loop. */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Imports the entry once with every dependency mocked, failing at `stage` with `thrown`; returns the fakes, events and captured lines. */
async function runMain(stage?: Stage, thrown?: unknown) {
  const events: string[] = [];
  const lines: LogLine[] = [];
  const destination: NonNullable<StartupFailureOptions['destination']> = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  const startTracing = vi.fn(async (_options: { serviceName: string; version: string }) => {
    events.push('tracing:start');
    await nextTick();
    if (stage === 'tracing') throw thrown;
    events.push('tracing:done');
  });
  const loadEnv = vi.fn((_schema: unknown) => {
    if (stage === 'env') throw thrown;
    return ENV;
  });
  const listen = vi.fn(async (_options: { port: number; host: string }) => {
    if (stage === 'listen') throw thrown;
    return 'http://0.0.0.0:8123';
  });
  const logError = vi.fn((_err: unknown, _message: string) => undefined);
  const shutdown = vi.fn(async () => {
    events.push('shutdown:start');
    await nextTick();
    events.push('shutdown:done');
  });
  const buildApp = vi.fn(async (_options: { env: unknown }) => {
    if (stage === 'build') throw thrown;
    return { listen, log: { error: logError }, opt2: { shutdown } };
  });
  const logStartupFailure = vi.fn((err: unknown, options: StartupFailureOptions) =>
    real.logStartupFailure(err, { ...options, destination }),
  );

  vi.resetModules();
  vi.doMock('@opt2/platform/tracing', () => ({ startTracing }));
  vi.doMock('@opt2/platform/service-kit', () => {
    events.push('service-kit');
    return { loadEnv };
  });
  vi.doMock('../../src/app.js', () => {
    events.push('app');
    return { buildApp, gatewayEnvSchema: SCHEMA };
  });
  vi.doMock('@opt2/platform/logging', () => {
    events.push('logging');
    return { logStartupFailure };
  });
  await import('../../src/main.js');
  return { events, lines, startTracing, loadEnv, buildApp, listen, logError, shutdown, logStartupFailure };
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

describe('gateway main', () => {
  it('starts tracing before loading the kit and the app, then binds env.PORT on all interfaces', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = await runMain();

    expect(run.startTracing).toHaveBeenCalledTimes(1);
    expect(run.startTracing).toHaveBeenCalledWith({ serviceName: 'gateway', version: '1.0.0' });
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app']);
    expect(run.loadEnv).toHaveBeenCalledTimes(1);
    expect(run.loadEnv.mock.calls[0]?.[0]).toBe(SCHEMA);
    expect(run.buildApp).toHaveBeenCalledTimes(1);
    expect(run.buildApp.mock.calls[0]?.[0]).toStrictEqual({ env: ENV });
    expect(run.buildApp.mock.calls[0]?.[0].env).toBe(ENV);
    expect(run.listen).toHaveBeenCalledTimes(1);
    expect(run.listen).toHaveBeenCalledWith({ port: 8123, host: '0.0.0.0' });
    expect(process.exitCode).toBe(savedExitCode);
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.logError).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each<[string, Exclude<Stage, 'listen'>, () => unknown, string[], string, string]>([
    ['startTracing rejects', 'tracing', () => new Error('exporter failed'), ['tracing:start', 'logging'], 'Error', '[REDACTED]'],
    [
      'loadEnv throws EnvValidationError',
      'env',
      () => new EnvValidationError(['OPT2_BRIDGE_HMAC_KEY: is required'], 'gateway'),
      ['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging'],
      'EnvValidationError',
      'gateway: invalid environment (OPT2_BRIDGE_HMAC_KEY)',
    ],
    [
      'buildApp rejects with ENOENT',
      'build',
      () => Object.assign(new Error("ENOENT: no such file or directory, open '/x/cutover-table.schema.json'"), { code: 'ENOENT', syscall: 'open', errno: -2 }),
      ['tracing:start', 'tracing:done', 'service-kit', 'app', 'logging'],
      'Error',
      'open ENOENT',
    ],
  ])('writes one log-record.v1 ERROR line and sets exit code 1 when %s', async (_label, stage, make, events, type, message) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = make();

    const run = await runMain(stage, thrown);

    expect(process.exitCode).toBe(1);
    expect(run.events).toStrictEqual(events);
    expect(run.logStartupFailure).toHaveBeenCalledTimes(1);
    expect(run.logStartupFailure.mock.calls[0]?.[0]).toBe(thrown);
    expect(run.logStartupFailure.mock.calls[0]?.[1]).toStrictEqual(OPTIONS);
    expect(run.lines).toHaveLength(1);
    const line = run.lines[0] as LogLine;
    expect(real.validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({ ...OPTIONS, severity: 'ERROR', message: 'start-up failed', error: { type, message } });
    expect(run.buildApp).toHaveBeenCalledTimes(stage === 'build' ? 1 : 0);
    expect(run.listen).not.toHaveBeenCalled();
    expect(run.shutdown).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs through the built app and awaits its shutdown when listen rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrown = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:8123'), { code: 'EADDRINUSE', syscall: 'listen' });

    const run = await runMain('listen', thrown);

    expect(process.exitCode).toBe(1);
    expect(run.logError).toHaveBeenCalledTimes(1);
    expect(run.logError.mock.calls[0]?.[0]).toBe(thrown);
    expect(run.logError.mock.calls[0]?.[1]).toBe('start-up failed');
    expect(run.shutdown).toHaveBeenCalledTimes(1);
    expect(run.events).toStrictEqual(['tracing:start', 'tracing:done', 'service-kit', 'app', 'shutdown:start', 'shutdown:done']);
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.lines).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
