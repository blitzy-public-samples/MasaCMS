/** Captures what the request loggers of a built app write and the arguments their `error` calls receive. */
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { REDACTED, createLogger, validateLogRecord } from '@opt2/platform/logging';
import type { FastifyInstance } from '@opt2/platform/service-kit';

/** The captured log-record.v1 lines and `error` call arguments. */
export interface RequestLogCapture {
  readonly lines: string[];
  errorCalls(): unknown[][];
}

/**
 * Makes every later request logger of `app` a child of a logger built as createService builds the app's own, writing to
 * `lines`; Fastify derives each request logger from `app.log`, which the app no longer lets a caller replace once ready.
 */
export function captureRequestLogs(app: FastifyInstance): RequestLogCapture {
  const lines: string[] = [];
  const errorSpies: Array<{ mock: { calls: unknown[][] } }> = [];
  const { name, version, env } = app.opt2;
  const root = createLogger({
    service: name,
    version,
    env: env.OPT2_ENV,
    level: env.LOG_LEVEL,
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    destination: { write: (line: string) => void lines.push(line) },
  }) as unknown as FastifyInstance['log'];
  vi.spyOn(app.log, 'child').mockImplementation((bindings, options) => {
    const logger = root.child(bindings, options);
    errorSpies.push(vi.spyOn(logger, 'error'));
    return logger;
  });
  return { lines, errorCalls: () => errorSpies.flatMap((spy) => spy.mock.calls) };
}

/** Message of the unexpected failures below: an address, an email and a credential. */
const PROBE_MESSAGE = 'connection to 10.0.0.7 refused for jane.doe@example.test with password=Hunter2-probe';

/** Parts of PROBE_MESSAGE no log argument or line may carry. */
const PROBE_TEXTS: readonly string[] = [PROBE_MESSAGE, '10.0.0.7', 'jane.doe@example.test', 'password=', 'Hunter2-probe'];

/** Unexpected failures of a database read, with the safe message their serialized record keeps. */
export const UNEXPECTED_DB_FAILURES: ReadonlyArray<readonly [string, Error, string]> = [
  ['an error whose message carries credentials', new Error(PROBE_MESSAGE), REDACTED],
  ['a PostgreSQL error, kept as its SQLSTATE', Object.assign(new Error(PROBE_MESSAGE), { code: '42P01', severity: 'ERROR' }), 'PostgreSQL error 42P01'],
];

/**
 * Asserts that `message` was logged once, handed to the logger as the serialized record of an `Error` with `safeMessage`
 * alone, and written as a valid log-record.v1 ERROR line; no probe text reaches an argument or a line.
 */
export function expectSerializedErrorLog(capture: RequestLogCapture, message: string, safeMessage: string): void {
  const record = { type: 'Error', message: safeMessage, stack: expect.stringMatching(/^Error: .+(?:\n {4}at \S.*)+$/) };
  expect(capture.errorCalls().filter(([, text]) => text === message)).toStrictEqual([[{ error: record }, message]]);
  const lines = capture.lines.map((text) => JSON.parse(text) as Record<string, unknown>).filter((line) => line.message === message);
  expect(lines).toStrictEqual([expect.objectContaining({ severity: 'ERROR', message, error: record })]);
  expect((lines[0]?.error as { stack: string }).stack.split('\n')[0]).toBe(`Error: ${safeMessage}`);
  expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
  for (const text of PROBE_TEXTS) {
    expect(inspect(capture.errorCalls(), { depth: null })).not.toContain(text);
    expect(capture.lines.join('\n')).not.toContain(text);
  }
}
