// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Composition root of finance: the log record of a start-up cleanup step that fails. */
import { describe, expect, it, vi } from 'vitest';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import { createService } from '@opt2/platform/service-kit';
import { createCapturingPublisher, testVerifier } from '@opt2/platform/testing';
import { buildApp } from '../../src/app.js';
import { TEST_CLOCK, testEnv } from '../helpers/app.js';

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

const actual = await vi.importActual<typeof import('@opt2/platform/service-kit')>('@opt2/platform/service-kit');
const FRAMES = expect.stringMatching(/^Error: \[REDACTED\]\n\s+at \S/);

describe('finance buildApp cleanup that fails', () => {
  it.each<[string, unknown, Record<string, unknown>]>([
    ['an Error whose message holds row values', new Error('duplicate key (email)=(row@example.com)'), { type: 'Error', message: REDACTED, stack: FRAMES }],
    ['a rejected string', 'password=row@example.com', { type: 'string', message: REDACTED }],
    ['a rejected object with a system error code', { code: 'ECONNRESET', syscall: 'read', detail: 'row@example.com' }, { type: 'object', message: 'read ECONNRESET' }],
  ])('logs %s from the service client close as a serialized error record', async (_case, rejection, record) => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
    const logError = vi.spyOn(logger, 'error');
    vi.mocked(createService).mockImplementationOnce(async (options) => {
      // Opens no database, so buildApp fails at its database check.
      const app = await actual.createService({ ...options, schema: undefined, pool: undefined, logger });
      vi.spyOn(app.opt2.client, 'close').mockRejectedValueOnce(rejection);
      return app;
    });

    await expect(
      buildApp({ env: await testEnv(), clock: TEST_CLOCK, verifierOverride: testVerifier(), publisher: createCapturingPublisher() }),
    ).rejects.toThrow('finance requires a database');
    expect(logError.mock.calls).toStrictEqual([[{ error: record }, 'start-up cleanup failed']]);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.message === 'start-up cleanup failed');
    expect(logged).toEqual([expect.objectContaining({ severity: 'ERROR', error: record })]);
    expect(logged.map((line) => validateLogRecord(line).errors)).toEqual([[]]);
    expect(lines.join('\n')).not.toContain('row@example.com');
  });
});
