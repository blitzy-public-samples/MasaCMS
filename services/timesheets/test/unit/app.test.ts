// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of timesheets: what a build failing after `createService` closes, and the log record of a cleanup step that fails. */
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { createPublisher, registerConsumers } from '@opt2/platform/events';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { createService } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createCapturingPublisher, testVerifier } from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { TEST_CLOCK, createRecordingDb, testEnv } from '../helpers/app.js';

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  return { ...actual, createPublisher: vi.fn(actual.createPublisher), registerConsumers: vi.fn(actual.registerConsumers) };
});

const actual = await vi.importActual<typeof import('@opt2/platform/service-kit')>('@opt2/platform/service-kit');
const FRAMES: unknown = expect.stringMatching(/^Error: \[REDACTED\]\n\s+at \S/);

/** A logger that keeps its lines in `lines`. */
function capturingLogger(lines: string[]): ReturnType<typeof createLogger> {
  return createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
}

describe('timesheets buildApp that fails after createService', () => {
  it.each<[string, boolean]>([
    ['closes the publisher and the pool it opened, and the service client', false],
    ['leaves the injected publisher and pool open, and closes the service client', true],
  ])('%s', async (_case, injected) => {
    const recording = createRecordingDb();
    const endPool = vi.fn(() => recording.end());
    const pool: TenantDb = {
      schema: recording.schema,
      withTenant: (tenantId, fn) => recording.withTenant(tenantId, fn),
      withMetadata: (fn, options) => recording.withMetadata(fn, options),
      end: endPool,
    };
    const publisher = createCapturingPublisher();
    const closePublisher = vi.spyOn(publisher, 'close');
    let closeClient: MockInstance | undefined;
    vi.mocked(createService).mockImplementationOnce(async (options) => {
      const app = await actual.createService({ ...options, schema: undefined, pool, logger: capturingLogger([]) });
      closeClient = vi.spyOn(app.opt2.client, 'close');
      return app;
    });
    if (!injected) vi.mocked(createPublisher).mockReturnValueOnce(publisher);
    vi.mocked(registerConsumers).mockImplementationOnce(() => {
      throw new Error('consumer registration failed');
    });

    await expect(
      buildApp({
        env: await testEnv(),
        clock: TEST_CLOCK,
        verifierOverride: testVerifier(),
        ...(injected ? { db: pool, publisher } : {}),
      }),
    ).rejects.toThrow('consumer registration failed');
    expect({ publisher: closePublisher.mock.calls.length, pool: endPool.mock.calls.length, client: closeClient?.mock.calls.length }).toStrictEqual({
      publisher: injected ? 0 : 1,
      pool: injected ? 0 : 1,
      client: 1,
    });
  });

  it.each<[string, unknown, Record<string, unknown>]>([
    ['an Error whose message holds row values', new Error('duplicate key (email)=(row@example.com)'), { type: 'Error', message: REDACTED, stack: FRAMES }],
    ['a rejected string', 'password=row@example.com', { type: 'string', message: REDACTED }],
    ['a rejected object with a system error code', { code: 'ECONNRESET', syscall: 'read', detail: 'row@example.com' }, { type: 'object', message: 'read ECONNRESET' }],
  ])('logs %s from the service client close as a serialized error record', async (_case, rejection, record) => {
    const lines: string[] = [];
    const logger = capturingLogger(lines);
    const logError = vi.spyOn(logger, 'error');
    vi.mocked(createService).mockImplementationOnce(async (options) => {
      // Opens no database, so buildApp fails at its database check.
      const app = await actual.createService({ ...options, schema: undefined, pool: undefined, logger });
      vi.spyOn(app.opt2.client, 'close').mockRejectedValueOnce(rejection);
      return app;
    });

    await expect(
      buildApp({ env: await testEnv(), clock: TEST_CLOCK, verifierOverride: testVerifier(), publisher: createCapturingPublisher() }),
    ).rejects.toThrow('timesheets requires a database');
    expect(logError.mock.calls).toStrictEqual([[{ error: record }, 'start-up cleanup failed']]);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.message === 'start-up cleanup failed');
    expect(logged).toEqual([expect.objectContaining({ severity: 'ERROR', error: record })]);
    expect(logged.map((line) => validateLogRecord(line).errors)).toEqual([[]]);
    expect(lines.join('\n')).not.toContain('row@example.com');
  });
});
