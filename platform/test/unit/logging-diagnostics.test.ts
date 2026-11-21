import { context, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import type { DestinationStream } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emitDiagnostic, getDiagnosticLogger, setDiagnosticLogger } from '../../src/logging/diagnostics.js';
import { createLogger, type Logger } from '../../src/logging/logger.js';
import { REDACTED } from '../../src/logging/redact.js';
import { safeErrorMessage } from '../../src/logging/safe-error.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { MemorySpanExporter, shutdownTracing, startTracing } from '../../src/tracing/sdk.js';

type LogLine = Record<string, unknown>;

const BASE = { service: 'diagnostics-test', version: '1.2.3', env: 'local' } as const;
const CODE = 'OPT2_TENANCY';
const PREFIX = 'Commit callback error handler failed: ';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['c10', 'sentinel', 'secret'].join('-');
const MAILBOX = ['c10', 'sentinel', 'mailbox'].join('-');
/** Error text with credentials, session material, an email address and line-forging control characters. */
const LEAKY_TEXT = [
  `connect postgres://svc:${SECRET}@db/x?sslpassword=${SECRET} refused`,
  `Cookie: CFID=${SECRET}`,
  `owner ${MAILBOX}@example.com\r\u001b[31mforged\u2028line\u0085end`,
].join('\n');
const RAW_CONTROL = /[\p{Cc}\u2028\u2029]/u;

/** A logger with a memory destination, which never registers itself, and the lines it wrote. */
function memoryLogger(): { logger: Logger; lines: LogLine[]; raw: string[] } {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      raw.push(line);
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  return { logger: createLogger({ ...BASE, destination }), lines, raw };
}

/** Runs `fn` with a non-recording span of `spanContext` active. */
function withSpanContext<T>(spanContext: SpanContext, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), fn);
}

/** PostgreSQL error whose message echoes the leaky text. */
function pgError(): Error {
  return Object.assign(new Error(LEAKY_TEXT), { name: 'error', code: '57P01', severity: 'FATAL' });
}

/** Asserts that no sentinel or raw control character of LEAKY_TEXT appears in `text`. */
function expectNoLeak(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(MAILBOX);
  expect(text).not.toContain('forged');
  expect(text).not.toMatch(RAW_CONTROL);
}

afterEach(() => {
  setDiagnosticLogger(undefined);
  vi.restoreAllMocks();
});

describe('emitDiagnostic with a registered logger', () => {
  beforeAll(async () => {
    await startTracing({ serviceName: 'diagnostics-test', version: '1.2.3', exporter: new MemorySpanExporter() });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each<[string, () => unknown, string, string | undefined]>([
    ['an Error', () => new Error(LEAKY_TEXT), REDACTED, 'Error: [REDACTED]\n    at '],
    ['a PostgreSQL error', pgError, 'PostgreSQL error 57P01', 'error: PostgreSQL error 57P01\n    at '],
    ['a thrown string', () => LEAKY_TEXT, REDACTED, undefined],
    ['a thrown undefined', () => undefined, REDACTED, undefined],
  ])('writes %s as one safe, trace-correlated WARNING line and no process warning', (_label, make, safeMessage, stackStart) => {
    const { logger, lines, raw } = memoryLogger();
    setDiagnosticLogger(logger);
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const err = make();

    withSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }, () => {
      emitDiagnostic(CODE, `${PREFIX}${safeErrorMessage(err)}`, err);
    });

    expect(emitWarning).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    const line = lines[0] as LogLine;
    expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
    expect(line).toMatchObject({
      ...BASE,
      severity: 'WARNING',
      message: `${CODE}: ${PREFIX}${safeMessage}`,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceSampled: true,
      error: { message: safeMessage },
    });
    const { stack } = line.error as { stack?: string };
    if (stackStart === undefined) {
      expect(stack).toBeUndefined();
    } else {
      expect(stack?.startsWith(stackStart)).toBe(true);
    }
    expectNoLeak(JSON.stringify(line));
    expect(raw.join('')).not.toContain(SECRET);
  });

  it.each<[string, string]>([
    ['a letter inside its words', 'e'],
    ['one of its words', 'failed'],
    ['its whole text', `${PREFIX}${REDACTED}`],
  ])('writes the message unchanged when the Error message is %s', (_label, errorMessage) => {
    const { logger, lines } = memoryLogger();
    setDiagnosticLogger(logger);

    emitDiagnostic(CODE, `${PREFIX}${REDACTED}`, new Error(errorMessage));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ message: `${CODE}: ${PREFIX}${REDACTED}`, error: { type: 'Error', message: REDACTED } });
  });

  it('falls back to the native warning when the logger throws', () => {
    const throwing: DestinationStream = {
      write: () => {
        throw new Error('sink down');
      },
    };
    setDiagnosticLogger(createLogger({ ...BASE, destination: throwing }));
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    expect(() => emitDiagnostic(CODE, `${PREFIX}${REDACTED}`, new Error(LEAKY_TEXT))).not.toThrow();

    expect(emitWarning).toHaveBeenCalledOnce();
    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(message).toBe(`${PREFIX}${REDACTED}`);
    expect(options?.code).toBe(CODE);
    expect(options?.detail).toMatch(/^Error: \[REDACTED\]\\n {4}at \S/);
  });
});

describe('emitDiagnostic without a registered logger', () => {
  it.each<[string, unknown, string | undefined]>([
    ['an Error', new Error(LEAKY_TEXT), String.raw`Error: [REDACTED]\n    at `],
    [
      'an Error whose frames hold control characters',
      Object.assign(new Error(LEAKY_TEXT), { stack: `Error: ${LEAKY_TEXT}\n    at f\u001b[31m (x\u2028y)\t` }),
      String.raw`Error: [REDACTED]\n    at f\u001b[31m (x\u2028y)\t`,
    ],
    ['a thrown string', LEAKY_TEXT, undefined],
  ])('emits %s as a single-line native OPT2_TENANCY warning', (_label, err, detail) => {
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    emitDiagnostic(CODE, `${PREFIX}\r\n${REDACTED}\u2028`, err);

    expect(emitWarning).toHaveBeenCalledOnce();
    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(message).toBe(String.raw`${PREFIX}\r\n${REDACTED}\u2028`);
    expect(options?.code).toBe(CODE);
    if (detail === undefined) {
      expect(options?.detail).toBeUndefined();
    } else {
      expect(options?.detail?.startsWith(detail)).toBe(true);
    }
    expectNoLeak(`${String(message)}${options?.detail ?? ''}`);
  });
});

describe('diagnostic logger registration', () => {
  it.each<[string, boolean, boolean, 'created' | 'previous' | 'none']>([
    ['a stdout logger with none registered', false, false, 'created'],
    ['a stdout logger beside a registered one', true, false, 'previous'],
    ['a destination logger with none registered', false, true, 'none'],
    ['a destination logger beside a registered one', true, true, 'previous'],
  ])('createLogger for %s leaves the expected diagnostic logger', (_label, registered, withDestination, expected) => {
    const previous = registered ? memoryLogger().logger : undefined;
    setDiagnosticLogger(previous);

    const created = createLogger(withDestination ? { ...BASE, destination: { write: () => undefined } } : BASE);

    const want = { created, previous, none: undefined }[expected];
    expect(getDiagnosticLogger()).toBe(want);
  });

  it('clears the registered logger', () => {
    setDiagnosticLogger(memoryLogger().logger);
    setDiagnosticLogger(undefined);
    expect(getDiagnosticLogger()).toBeUndefined();
  });
});
