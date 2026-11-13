// Tests of web's request log line (log-record.v1) and request spans, over an in-memory span exporter.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The platform's log-record.v1 validator and activeSpanIds stand in for ajv/dist/2020 and @opentelemetry/api:
// web resolves only eslint's ajv 6, which has no draft 2020-12, and does not depend on the OTel API.
import { REDACTED, SEVERITY_BY_LEVEL, serializeError, validateLogRecord } from '@opt2/platform/logging';
import { TENANT_A } from '@opt2/platform/testing';
import {
  SpanKind,
  SpanStatusCode,
  activeSpanIds,
  flushTracing,
  shutdownTracing,
  startTracing,
  type MemorySpanExporter,
  type ReadableSpan,
  type StartTracingOptions,
} from '@opt2/platform/tracing';
import {
  WEB_VERSION,
  createWebLogger,
  ensureTracing,
  logRequest,
  setWebLoggerForTests,
  webLogger,
  withRequestSpan,
  type RequestLogFields,
} from '@/lib/telemetry';
import { useTestEnv } from '../helpers/env';

const tracing = vi.hoisted(() => ({ exporter: undefined as MemorySpanExporter | undefined }));

// Pass-through that swaps the OTLP exporter for an in-memory one, so no span leaves the process.
vi.mock('@opt2/platform/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tracing')>();
  const exporter = new actual.MemorySpanExporter();
  tracing.exporter = exporter;
  return {
    ...actual,
    startTracing: vi.fn((options: StartTracingOptions) => actual.startTracing({ ...options, exporter })),
  };
});

type LogLine = Record<string, unknown>;

const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;
const TRACESTATE = 'congo=t61rcWkgMzE';
const CLOUD_PROJECT = 'opt2-web-test';

const REQUEST = {
  route: 'admin:cusers.list',
  httpMethod: 'GET',
  statusCode: 200,
  latencyMs: 12,
  requestId: 'req-1',
  userId: 'U1',
  tenantId: TENANT_A.tenantId,
} satisfies RequestLogFields;

const MODES = [
  { env: 'local', overrides: {}, level: 'info', cloudTrace: {} },
  {
    env: 'cloud',
    overrides: {
      OPT2_ENV: 'cloud',
      GOOGLE_CLOUD_PROJECT: CLOUD_PROJECT,
      OPT2_TASKS_ADAPTER: 'cloud',
      OPT2_STORAGE_ADAPTER: 'cloud',
      LOG_LEVEL: 'debug',
    },
    level: 'debug',
    cloudTrace: {
      'logging.googleapis.com/trace': `projects/${CLOUD_PROJECT}/traces/${INBOUND_TRACE_ID}`,
      'logging.googleapis.com/trace_sampled': true,
    },
  },
] as const;

const cleanups: (() => void)[] = [];

/** Registers `restore` to run, newest first, after the current test. */
function onCleanup(restore: () => void): void {
  cleanups.push(restore);
}

/** Installs the web environment with `overrides` and no OTLP endpoint. */
function installEnv(overrides: Partial<Record<string, string>> = {}): void {
  onCleanup(useTestEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined, ...overrides }));
}

/** Installs a web logger built from the current environment; returns the parsed lines it writes. */
function captureLines(): LogLine[] {
  const lines: LogLine[] = [];
  const write = (chunk: string): void => {
    for (const text of chunk.split('\n')) if (text !== '') lines.push(JSON.parse(text) as LogLine);
  };
  onCleanup(setWebLoggerForTests(createWebLogger({ write })));
  return lines;
}

/** Ended spans named `name`, after flushing the batch processor. */
async function finishedSpans(name: string): Promise<ReadableSpan[]> {
  await flushTracing();
  return (tracing.exporter?.getFinishedSpans() ?? []).filter((span) => span.name === name);
}

beforeEach(() => {
  installEnv();
});

afterEach(() => {
  for (let restore = cleanups.pop(); restore !== undefined; restore = cleanups.pop()) restore();
});

afterAll(async () => {
  await shutdownTracing();
});

describe('logRequest', () => {
  it.each(MODES)('writes one log-record.v1 line echoing the request ($env)', ({ env, overrides, level }) => {
    installEnv(overrides);
    const lines = captureLines();

    logRequest(REQUEST);

    expect(webLogger().level).toBe(level);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(validateLogRecord(line).errors).toEqual([]);
    expect(line).toMatchObject({
      ...REQUEST,
      severity: SEVERITY_BY_LEVEL.info,
      message: 'request',
      service: 'web',
      version: WEB_VERSION,
      env,
    });
    expect(line).not.toHaveProperty('error');
  });

  it('writes a thrown error serialized at error severity', () => {
    const lines = captureLines();
    const failure = new Error('boom');

    logRequest({ ...REQUEST, statusCode: 500, error: failure });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(validateLogRecord(line).errors).toEqual([]);
    expect(line).toMatchObject({ ...REQUEST, statusCode: 500, severity: SEVERITY_BY_LEVEL.error, message: 'request' });
    expect(line?.error).toEqual(serializeError(failure));
    expect(line?.error).toMatchObject({ type: 'Error', message: REDACTED, stack: expect.any(String) });
  });
});

describe('webLogger', () => {
  it('memoises one logger until reset', () => {
    onCleanup(setWebLoggerForTests(undefined));
    const first = webLogger();

    expect(webLogger()).toBe(first);

    onCleanup(setWebLoggerForTests(undefined));
    expect(webLogger()).not.toBe(first);
  });
});

describe('ensureTracing', () => {
  it('starts the SDK once for web', async () => {
    await Promise.all([ensureTracing(), ensureTracing()]);
    await ensureTracing();

    expect(vi.mocked(startTracing)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startTracing)).toHaveBeenCalledWith({ serviceName: 'web', version: WEB_VERSION, endpoint: undefined });
  });
});

describe('withRequestSpan', () => {
  beforeEach(async () => {
    await ensureTracing();
    await flushTracing();
    tracing.exporter?.reset();
  });

  it.each<[string, HeadersInit]>([
    ['a record', { Traceparent: TRACEPARENT, Tracestate: TRACESTATE }],
    ['entries', [['traceparent', TRACEPARENT], ['tracestate', TRACESTATE]]],
    ['Headers', new Headers({ traceparent: TRACEPARENT, tracestate: TRACESTATE })],
  ])('runs fn in a server span continuing the inbound trace from %s', async (_shape, headers) => {
    let inside: ReturnType<typeof activeSpanIds>;

    const result = await withRequestSpan('GET /admin', headers, async () => {
      inside = activeSpanIds();
      return 'rendered';
    });

    expect(result).toBe('rendered');
    expect(inside).toMatchObject({ traceId: INBOUND_TRACE_ID, traceSampled: true });
    const spans = await finishedSpans('GET /admin');
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.spanContext()).toMatchObject({ traceId: INBOUND_TRACE_ID, spanId: inside?.spanId });
    expect(span?.spanContext().traceState?.serialize()).toBe(TRACESTATE);
    expect(span?.parentSpanContext?.spanId).toBe(INBOUND_SPAN_ID);
  });

  it('propagates a rejection and still ends the span', async () => {
    const failure = new Error('boom');

    await expect(withRequestSpan('POST /admin', { traceparent: TRACEPARENT }, () => Promise.reject(failure))).rejects.toBe(
      failure,
    );

    const spans = await finishedSpans('POST /admin');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.ended).toBe(true);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it.each(MODES)('logs the inbound trace inside the span ($env)', async ({ overrides, cloudTrace }) => {
    installEnv(overrides);
    const lines = captureLines();

    const inside = await withRequestSpan('GET /admin', { traceparent: TRACEPARENT }, async () => {
      logRequest(REQUEST);
      return activeSpanIds();
    });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(validateLogRecord(line).errors).toEqual([]);
    expect(line).toMatchObject({
      ...REQUEST,
      traceId: INBOUND_TRACE_ID,
      spanId: inside?.spanId,
      traceSampled: true,
      ...cloudTrace,
    });
  });
});
