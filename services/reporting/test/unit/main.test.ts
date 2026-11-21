// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The reporting entry's start-up failure handling, with tracing, the kit and the app mocked and the real logging serializers. */
import type { StartupFailureOptions } from '@opt2/platform/logging';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type LoggingModule = typeof import('@opt2/platform/logging');
type LogLine = Record<string, unknown>;

const OPTIONS = { service: 'reporting', version: '1.0.0' } as const;
const SCHEMA = Object.freeze({ sentinel: 'reportingEnvSchema' });
const MOCKED = ['@opt2/platform/tracing', '@opt2/platform/service-kit', '../../src/app.js', '@opt2/platform/logging'] as const;
// Stands for a credential an error text may carry; never a real one.
const SECRET = ['row', 'secret', 'value'].join('-');

let real: LoggingModule;
let savedExitCode: typeof process.exitCode;

/** Faults a run injects besides the start-up failure itself. */
interface Faults {
  shutdownTracing?: Error | undefined;
  appShutdown?: Error | undefined;
}

/** Imports the entry once with `loadEnv` throwing `thrown` (stage `env`) or `listen` rejecting with it (stage `listen`). */
async function runMain(stage: 'env' | 'listen', thrown: Error, faults: Faults = {}) {
  const events: string[] = [];
  const lines: LogLine[] = [];
  const destination: NonNullable<StartupFailureOptions['destination']> = {
    write: (line: string) => {
      const record = JSON.parse(line) as LogLine;
      events.push(`line:${String(record.message)}`);
      lines.push(record);
    },
  };
  const shutdownTracing = vi.fn((): Promise<void> => {
    events.push('tracing:shutdown');
    return faults.shutdownTracing === undefined ? Promise.resolve() : Promise.reject(faults.shutdownTracing);
  });
  const logError = vi.fn((_record: unknown, message: string) => void events.push(`log:${message}`));
  const shutdown = vi.fn((): Promise<void> => {
    events.push('shutdown');
    return faults.appShutdown === undefined ? Promise.resolve() : Promise.reject(faults.appShutdown);
  });
  const listen = vi.fn((): Promise<string> => Promise.reject(thrown));
  const loadEnv = vi.fn(() => {
    if (stage === 'env') throw thrown;
    return { PORT: 8116 };
  });
  const buildApp = vi.fn(() => Promise.resolve({ listen, log: { error: logError }, opt2: { shutdown } }));
  const logStartupFailure = vi.fn((err: unknown, options: StartupFailureOptions) => real.logStartupFailure(err, { ...options, destination }));

  vi.resetModules();
  vi.doMock('@opt2/platform/tracing', () => ({ startTracing: vi.fn(() => Promise.resolve()), shutdownTracing }));
  vi.doMock('@opt2/platform/service-kit', () => ({ loadEnv }));
  vi.doMock('../../src/app.js', () => ({ buildApp, reportingEnvSchema: SCHEMA }));
  vi.doMock('@opt2/platform/logging', () => ({ logStartupFailure, serializeError: real.serializeError }));
  await import('../../src/main.js');
  return { events, lines, loadEnv, logError, shutdown, shutdownTracing, logStartupFailure };
}

beforeAll(async () => {
  real = await vi.importActual<LoggingModule>('@opt2/platform/logging');
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

describe('reporting main', () => {
  it.each<[string, Error | undefined, string[]]>([
    ['tracing stops', undefined, ['line:start-up failed', 'tracing:shutdown']],
    ['a tracing shutdown that rejects is a second line', new Error(`flush to http://otel:${SECRET}@127.0.0.1:4318 failed`), ['line:start-up failed', 'tracing:shutdown', 'line:shutdown failed']],
  ])('before the app is built, writes the start-up line, then %s, with exit code 1', async (_case, tracingFault, events) => {
    const { EnvValidationError } = await vi.importActual<typeof import('@opt2/platform/service-kit')>('@opt2/platform/service-kit');
    const thrown = new EnvValidationError(['OPT2_SERVICE_NAME: must be reporting'], 'finance');

    const run = await runMain('env', thrown, { shutdownTracing: tracingFault });

    expect(process.exitCode).toBe(1);
    expect(run.loadEnv.mock.calls[0]).toStrictEqual([SCHEMA]);
    expect(run.events).toStrictEqual(events);
    expect(run.lines[0]).toMatchObject({ ...OPTIONS, severity: 'ERROR', error: { type: 'EnvValidationError', message: 'finance: invalid environment (OPT2_SERVICE_NAME: must be reporting)' } });
    expect(run.lines.map((line) => real.validateLogRecord(line).errors)).toStrictEqual(run.lines.map(() => []));
    expect(JSON.stringify(run.lines)).not.toContain(SECRET);
    expect(run.logError).not.toHaveBeenCalled();
  });

  it.each<[string, Error | undefined, string[]]>([
    ['its shutdown resolves', undefined, ['log:start-up failed', 'shutdown']],
    ['its shutdown rejects', new Error(`pool end failed for postgres://reporting_app:${SECRET}@127.0.0.1/reporting`), ['log:start-up failed', 'shutdown', 'log:shutdown failed']],
  ])('once the app is built, logs serialized errors through it and awaits its shutdown when listen rejects and %s', async (_case, appFault, events) => {
    const thrown = Object.assign(new Error(`listen EADDRINUSE: address already in use 0.0.0.0:8116 (${SECRET})`), { code: 'EADDRINUSE', syscall: 'listen' });

    const run = await runMain('listen', thrown, { appShutdown: appFault });

    expect(process.exitCode).toBe(1);
    expect(run.events).toStrictEqual(events);
    const logged: [unknown, string][] = [[{ error: real.serializeError(thrown) }, 'start-up failed']];
    if (appFault !== undefined) logged.push([{ error: real.serializeError(appFault) }, 'shutdown failed']);
    expect(run.logError.mock.calls).toStrictEqual(logged);
    expect(run.logError.mock.calls[0]?.[0]).toMatchObject({ error: { type: 'Error', message: 'listen EADDRINUSE' } });
    expect(JSON.stringify(run.logError.mock.calls)).not.toContain(SECRET);
    expect(run.logStartupFailure).not.toHaveBeenCalled();
    expect(run.shutdownTracing).not.toHaveBeenCalled();
  });
});
