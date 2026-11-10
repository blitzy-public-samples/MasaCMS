import { context, INVALID_SPAN_CONTEXT, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { fastify } from 'fastify';
import type { DestinationStream } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions } from '../../src/logging/fastify.js';
import type { LogErrorRecord, LogFields } from '../../src/logging/fields.js';
import {
  createLogger,
  serializeError,
  SEVERITY_BY_LEVEL,
  type CreateLoggerOptions,
  type Logger,
} from '../../src/logging/logger.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { MemorySpanExporter, shutdownTracing, startTracing } from '../../src/tracing/sdk.js';

type LogLine = Record<string, unknown>;
type Level = keyof typeof SEVERITY_BY_LEVEL;

const BASE = { service: 'logger-test', version: '1.2.3', env: 'local' } as const;
const PROJECT = 'opt2-logger-test';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const TENANT_ID = 'edec963e-3516-5bb6-845d-d01a710e32a7';
const CLOUD_TRACE_KEYS = [
  'logging.googleapis.com/trace',
  'logging.googleapis.com/spanId',
  'logging.googleapis.com/trace_sampled',
] as const;
const TRACE_KEYS = ['traceId', 'spanId', 'traceSampled', ...CLOUD_TRACE_KEYS] as const;
const PINO_DEFAULT_KEYS = ['level', 'time', 'pid', 'hostname', 'msg'] as const;

const LEVELS: [Level, string][] = [
  ['trace', 'DEBUG'],
  ['debug', 'DEBUG'],
  ['info', 'INFO'],
  ['warn', 'WARNING'],
  ['error', 'ERROR'],
  ['fatal', 'CRITICAL'],
];

/** Creates a logger at `trace` level whose lines are parsed into `lines`. */
function capture(options: Partial<CreateLoggerOptions> = {}): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  return { logger: createLogger({ ...BASE, level: 'trace', destination, ...options }), lines };
}

/** Returns the single captured line after asserting it is a valid log-record.v1. */
function single(lines: LogLine[]): LogLine {
  expect(lines).toHaveLength(1);
  const line = lines[0] as LogLine;
  expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
  return line;
}

/** Runs `fn` with a non-recording span of `spanContext` active. */
function withSpanContext<T>(spanContext: SpanContext, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), fn);
}

describe('createLogger levels', () => {
  it.each(LEVELS)('%s writes severity %s', (level, severity) => {
    const { logger, lines } = capture();
    logger[level]('hello');
    expect(single(lines)).toStrictEqual({ severity, timestamp: expect.any(String), ...BASE, message: 'hello' });
  });

  it('maps every pino level', () => {
    expect(SEVERITY_BY_LEVEL).toStrictEqual(Object.fromEntries(LEVELS));
  });

  it('omits pino default keys', () => {
    const { logger, lines } = capture();
    logger.info('parent');
    logger.child({ requestId: 'req-1' }).error(new Error('child'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const key of PINO_DEFAULT_KEYS) {
        expect(line).not.toHaveProperty(key);
      }
    }
  });

  it('stamps the ISO timestamp of the clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-10T08:57:16.524Z'));
      const { logger, lines } = capture();
      logger.info('tick');
      expect(single(lines).timestamp).toBe('2026-11-10T08:57:16.524Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats message arguments', () => {
    const { logger, lines } = capture();
    logger.info('archived %s of %d', 'person', 3);
    expect(single(lines).message).toBe('archived person of 3');
  });

  it('defaults to info on stdout', () => {
    const logger = createLogger(BASE);
    expect(logger.level).toBe('info');
    expect(logger.isLevelEnabled('info')).toBe(true);
    expect(logger.isLevelEnabled('debug')).toBe(false);
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.info('quiet');
    logger.warn('loud');
    expect(single(lines)).toMatchObject({ severity: 'WARNING', message: 'loud' });
  });
});

describe('createLogger fields', () => {
  it('keeps contract fields and drops other merge keys', () => {
    const { logger, lines } = capture();
    const fields: LogFields = {
      tenantId: TENANT_ID,
      userId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6',
      requestId: 'req-1',
      eventId: '0b7f3c1e-2a4d-4e8a-9c3f-0d1e2f3a4b5c',
      route: '/_api/json/v1/default/content',
      httpMethod: 'GET',
      statusCode: 200,
      latencyMs: 12.5,
    };
    const extra = { cookie: 'jar', foo: 'bar', message: 'shadowed', level: 50 };
    logger.info({ ...fields, ...extra } as LogFields, 'request completed');
    expect(single(lines)).toStrictEqual({
      severity: 'INFO',
      timestamp: expect.any(String),
      ...BASE,
      ...fields,
      message: 'request completed',
    });
  });

  it.each<[string, LogFields | Error | Record<string, unknown>, string]>([
    ['plain fields', { route: '/r' }, ''],
    ['an error field', { error: new TypeError('boom') }, 'boom'],
    ['an error record', { error: { type: 'Conflict', message: 'stale version' } }, 'stale version'],
    ['an err field', { err: new Error('bad gateway') }, 'bad gateway'],
    ['an Error', new RangeError('out of range'), 'out of range'],
  ])('fills a missing message from %s', (_, object, message) => {
    const { logger, lines } = capture();
    logger.info(object as LogFields);
    expect(single(lines).message).toBe(message);
  });

  it('keeps an explicit message beside an error', () => {
    const { logger, lines } = capture();
    logger.error(new Error('inner'), 'outer');
    expect(single(lines)).toMatchObject({ message: 'outer', error: { type: 'Error', message: 'inner' } });
  });
});

describe('createLogger errors', () => {
  it('serializes a logged Error', () => {
    const { logger, lines } = capture();
    const error = new TypeError('boom');
    logger.error(error);
    expect(single(lines)).toMatchObject({
      severity: 'ERROR',
      message: 'boom',
      error: { type: 'TypeError', message: 'boom', stack: error.stack },
    });
  });

  it('takes a Fastify err as error and drops req and res', () => {
    const { logger, lines } = capture();
    const err = new Error('handler failed');
    logger.error({ req: { method: 'GET', url: '/x' }, res: { statusCode: 500 }, err } as LogFields, 'request errored');
    const line = single(lines);
    expect(line).toStrictEqual({
      severity: 'ERROR',
      timestamp: expect.any(String),
      ...BASE,
      error: { type: 'Error', message: 'handler failed', stack: err.stack },
      message: 'request errored',
    });
  });

  it('prefers error over err', () => {
    const { logger, lines } = capture();
    logger.error({ err: new Error('err'), error: new SyntaxError('error') } as LogFields);
    expect(single(lines)).toMatchObject({ message: 'error', error: { type: 'SyntaxError', message: 'error' } });
  });

  it('logs Fastify request, reply and err as one contract line', async () => {
    const { logger, lines } = capture();
    const app = fastify(fastifyLoggerOptions(logger));
    app.setErrorHandler<Error>((err, request, reply) => {
      request.log.error({ req: request, res: reply, err }, err.message);
      return reply.code(500).send({ error: 'internal' });
    });
    app.get('/boom', () => {
      throw new Error('kaput');
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/boom' });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
    const line = single(lines);
    expect(line).toMatchObject({ severity: 'ERROR', message: 'kaput', error: { type: 'Error', message: 'kaput' } });
    expect(typeof line.requestId).toBe('string');
    expect(Object.keys(line).toSorted()).toStrictEqual(
      ['env', 'error', 'message', 'requestId', 'service', 'severity', 'timestamp', 'version'],
    );
  });
});

describe('serializeError', () => {
  class DomainError extends Error {}

  it.each<[string, Error, string]>([
    ['a built-in subclass', new TypeError('m'), 'TypeError'],
    ['a plain Error', new Error('m'), 'Error'],
    ['a subclass without a name', new DomainError('m'), 'DomainError'],
    ['a renamed Error', Object.assign(new Error('m'), { name: 'DatabaseError' }), 'DatabaseError'],
  ])('types %s', (_, error, type) => {
    expect(serializeError(error)).toStrictEqual({ type, message: 'm', stack: error.stack });
  });

  it('types an Error without a constructor as Error', () => {
    const error = new Error('m');
    Object.defineProperty(error, 'constructor', { value: undefined });
    expect(serializeError(error)).toMatchObject({ type: 'Error', message: 'm' });
  });

  it('omits a missing stack', () => {
    const error = new Error('m');
    delete error.stack;
    expect(serializeError(error)).toStrictEqual({ type: 'Error', message: 'm' });
  });

  it.each<[string, unknown, LogErrorRecord]>([
    ['with a stack', { type: 'T', message: 'm', stack: 's', code: 'E1' }, { type: 'T', message: 'm', stack: 's' }],
    ['without a stack', { type: 'T', message: 'm' }, { type: 'T', message: 'm' }],
    ['with a non-string stack', { type: 'T', message: 'm', stack: 42 }, { type: 'T', message: 'm' }],
  ])('copies an error record %s', (_, value, expected) => {
    expect(serializeError(value)).toStrictEqual(expected);
  });

  it.each<[string, unknown, LogErrorRecord]>([
    ['a string', 'boom', { type: 'string', message: 'boom' }],
    ['a number', 42, { type: 'number', message: '42' }],
    ['null', null, { type: 'object', message: 'null' }],
    ['undefined', undefined, { type: 'undefined', message: 'undefined' }],
  ])('describes %s by its typeof', (_, value, expected) => {
    expect(serializeError(value)).toStrictEqual(expected);
  });

  it('writes a thrown non-Error value as a valid record', () => {
    const { logger, lines } = capture();
    logger.warn({ error: 'not an error' as unknown as Error }, 'odd throw');
    expect(single(lines).error).toStrictEqual({ type: 'string', message: 'not an error' });
  });
});

describe('createLogger child', () => {
  it('binds only contract keys', () => {
    const { logger, lines } = capture();
    const bound = new Error('bound');
    const bindings = { tenantId: TENANT_ID, requestId: 'req-1', error: bound, traceId: TRACE_ID, foo: 'bar' };
    logger.child({ ...bindings, secret: 's' } as LogFields).info('child');
    expect(single(lines)).toStrictEqual({
      severity: 'INFO',
      timestamp: expect.any(String),
      ...BASE,
      tenantId: TENANT_ID,
      requestId: 'req-1',
      error: { type: 'Error', message: 'bound', stack: bound.stack },
      message: 'child',
    });
  });

  it('filters grandchild bindings and keeps inherited ones', () => {
    const { logger, lines } = capture();
    const child = logger.child({ tenantId: TENANT_ID, other: 1 } as LogFields);
    const grandchild = child.child({ eventId: 'evt-1', userId: undefined, nested: { a: 1 } } as LogFields);
    grandchild.info({ statusCode: 202 }, 'grandchild');
    expect(single(lines)).toStrictEqual({
      severity: 'INFO',
      timestamp: expect.any(String),
      ...BASE,
      tenantId: TENANT_ID,
      eventId: 'evt-1',
      statusCode: 202,
      message: 'grandchild',
    });
  });

  it('leaves the parent unbound', () => {
    const { logger, lines } = capture();
    logger.child({ tenantId: TENANT_ID });
    logger.info('parent');
    expect(single(lines)).not.toHaveProperty('tenantId');
  });
});

describe('createLogger cloud env', () => {
  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['empty', ''],
  ])('throws when googleCloudProject is %s', (_, googleCloudProject) => {
    expect(() => capture({ env: 'cloud', googleCloudProject })).toThrow(
      'createLogger: googleCloudProject is required when env is "cloud"',
    );
  });

  it('writes env cloud', () => {
    const { logger, lines } = capture({ env: 'cloud', googleCloudProject: PROJECT });
    logger.info('up');
    expect(single(lines)).toMatchObject({ env: 'cloud', message: 'up' });
  });
});

describe('createLogger trace fields', () => {
  const exporter = new MemorySpanExporter();

  beforeAll(async () => {
    await startTracing({ serviceName: 'logger-test', version: '1.2.3', exporter });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each<[string, Partial<CreateLoggerOptions>]>([
    ['local', {}],
    ['cloud', { env: 'cloud', googleCloudProject: PROJECT }],
  ])('omits trace fields without an active span in %s env', (_, options) => {
    const { logger, lines } = capture(options);
    logger.info('no span');
    const line = single(lines);
    for (const key of TRACE_KEYS) {
      expect(line).not.toHaveProperty(key);
    }
  });

  it('adds the active span ids without Cloud Logging keys in local env', () => {
    const { logger, lines } = capture({ googleCloudProject: PROJECT });
    const spanContext = trace.getTracer('logger-test').startActiveSpan('local', (span) => {
      logger.info('in span');
      span.end();
      return span.spanContext();
    });
    const line = single(lines);
    expect(line).toMatchObject({ traceId: spanContext.traceId, spanId: spanContext.spanId, traceSampled: true });
    for (const key of CLOUD_TRACE_KEYS) {
      expect(line).not.toHaveProperty(key);
    }
  });

  it('adds Cloud Logging trace keys in cloud env', () => {
    const { logger, lines } = capture({ env: 'cloud', googleCloudProject: PROJECT });
    const spanContext = trace.getTracer('logger-test').startActiveSpan('cloud', (span) => {
      logger.info('in span');
      span.end();
      return span.spanContext();
    });
    expect(single(lines)).toMatchObject({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceSampled: true,
      'logging.googleapis.com/trace': `projects/${PROJECT}/traces/${spanContext.traceId}`,
      'logging.googleapis.com/spanId': spanContext.spanId,
      'logging.googleapis.com/trace_sampled': true,
    });
  });

  it('marks an unsampled span', () => {
    const { logger, lines } = capture({ env: 'cloud', googleCloudProject: PROJECT });
    const unsampled: SpanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.NONE };
    withSpanContext(unsampled, () => logger.info('unsampled'));
    expect(single(lines)).toMatchObject({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceSampled: false,
      'logging.googleapis.com/trace': `projects/${PROJECT}/traces/${TRACE_ID}`,
      'logging.googleapis.com/spanId': SPAN_ID,
      'logging.googleapis.com/trace_sampled': false,
    });
  });

  it('omits trace fields for an invalid span context', () => {
    const { logger, lines } = capture({ env: 'cloud', googleCloudProject: PROJECT });
    withSpanContext(INVALID_SPAN_CONTEXT, () => logger.info('invalid'));
    const line = single(lines);
    for (const key of TRACE_KEYS) {
      expect(line).not.toHaveProperty(key);
    }
  });

  it('adds trace fields to child lines', () => {
    const { logger, lines } = capture();
    withSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }, () =>
      logger.child({ requestId: 'req-1' }).info('child in span'),
    );
    expect(single(lines)).toMatchObject({ requestId: 'req-1', traceId: TRACE_ID, spanId: SPAN_ID, traceSampled: true });
  });
});
