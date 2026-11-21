import { context, INVALID_SPAN_CONTEXT, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';
import { fastify } from 'fastify';
import type { DestinationStream } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fastifyLoggerOptions } from '../../src/logging/fastify.js';
import type { LogEnv, LogErrorRecord, LogFields } from '../../src/logging/fields.js';
import {
  createLogger,
  serializeError,
  SEVERITY_BY_LEVEL,
  type CreateLoggerOptions,
  type Logger,
} from '../../src/logging/logger.js';
import { REDACTED } from '../../src/logging/redact.js';
import { isValidLogField, validateLogRecord } from '../../src/logging/validate.js';
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
// Assembled at run time, so no literal credential appears in source.
const SECRET = ['opt2', 'sentinel', 'secret'].join('-');
const ECHO = ['c10', 'sentinel'].join('-');
const PII_ERROR_TEXT = `Invalid CSRF token '${SECRET}' for patient Synthetic Ada Lovelace (phone +1-202-555-0147)`;

const LEVELS: [Level, string][] = [
  ['trace', 'DEBUG'],
  ['debug', 'DEBUG'],
  ['info', 'INFO'],
  ['warn', 'WARNING'],
  ['error', 'ERROR'],
  ['fatal', 'CRITICAL'],
];

/** Creates a logger at `trace` level whose lines are kept as written in `raw` and parsed into `lines`. */
function capture(options: Partial<CreateLoggerOptions> = {}): { logger: Logger; lines: LogLine[]; raw: string[] } {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const destination: DestinationStream = {
    write: (line: string) => {
      raw.push(line);
      lines.push(JSON.parse(line) as LogLine);
    },
  };
  return { logger: createLogger({ ...BASE, level: 'trace', destination, ...options }), lines, raw };
}

/** Returns the single captured line after asserting it is a valid log-record.v1. */
function single(lines: LogLine[]): LogLine {
  expect(lines).toHaveLength(1);
  const line = lines[0] as LogLine;
  expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
  return line;
}

/** `error.stack` with its message line replaced by `header`, as the logger writes it. */
function framesUnder(header: string, error: Error): string {
  const stack = error.stack ?? '';
  return `${header}${stack.slice(stack.indexOf('\n'))}`;
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
    ['an error field', { error: new TypeError('boom') }, REDACTED],
    ['an error record', { error: { type: 'Conflict', message: 'stale version' } }, REDACTED],
    ['an err field', { err: new Error('bad gateway') }, REDACTED],
    ['an Error', new RangeError('out of range'), REDACTED],
    ['an error with a Fastify code', { error: Object.assign(new Error('body/x must be string'), { code: 'FST_ERR_VALIDATION' }) }, 'FST_ERR_VALIDATION'],
  ])('fills a missing message from %s', (_, object, message) => {
    const { logger, lines } = capture();
    logger.info(object as LogFields);
    expect(single(lines).message).toBe(message);
  });

  it('keeps an explicit message beside an error', () => {
    const { logger, lines } = capture();
    logger.error(new Error('inner'), 'outer');
    expect(single(lines)).toMatchObject({ message: 'outer', error: { type: 'Error', message: REDACTED } });
  });

  it.each<[string, unknown]>([
    ['statusCode', 200.5],
    ['statusCode', 99],
    ['statusCode', 600],
    ['statusCode', '200'],
    ['latencyMs', -1],
    ['latencyMs', Number.NaN],
    ['latencyMs', Number.POSITIVE_INFINITY],
    ['traceId', 'bogus'],
    ['spanId', 'B7AD6B7169203331'],
    ['traceSampled', 'yes'],
    ['tenantId', 42],
    ['httpMethod', { verb: 'GET' }],
    ['logging.googleapis.com/trace', 'bogus'],
  ])('drops merge field %s %o that log-record.v1 rejects', (key, value) => {
    const { logger, lines } = capture();
    logger.info({ [key]: value, route: '/ok' } as LogFields, 'done');
    expect(single(lines)).toStrictEqual({ severity: 'INFO', timestamp: expect.any(String), ...BASE, route: '/ok', message: 'done' });
  });

  it.each<[string, unknown[], string]>([
    ['no arguments', [], ''],
    ['an undefined message', [undefined], ''],
    ['a null message', [null], 'null'],
    ['a number message', [42], '42'],
    ['fields with a number message', [{ route: '/r' }, 42], '42'],
    ['fields with a null message', [{ route: '/r' }, null], 'null'],
  ])('writes a string message for %s', (_, args, message) => {
    const { logger, lines } = capture();
    Reflect.apply(logger.info, logger, args);
    expect(single(lines).message).toBe(message);
  });
});

describe('createLogger errors', () => {
  it('serializes a logged Error', () => {
    const { logger, lines } = capture();
    const error = new TypeError('boom');
    logger.error(error);
    expect(single(lines)).toMatchObject({
      severity: 'ERROR',
      message: REDACTED,
      error: { type: 'TypeError', message: REDACTED, stack: framesUnder(`TypeError: ${REDACTED}`, error) },
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
      error: { type: 'Error', message: REDACTED, stack: framesUnder(`Error: ${REDACTED}`, err) },
      message: 'request errored',
    });
  });

  it('masks credentials in a logged Error, its stack and the default message', () => {
    const { logger, lines } = capture();
    const error = new Error(`upstream rejected Cookie: CFID=${SECRET}`);
    logger.error(error);
    const line = single(lines);
    expect(line).toMatchObject({ message: REDACTED, error: { type: 'Error', message: REDACTED } });
    expect((line.error as LogErrorRecord).stack).toBe(framesUnder(`Error: ${REDACTED}`, error));
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it.each<[string, (logger: Logger) => void, string]>([
    [
      'an explicit message beside err',
      (logger) => {
        const err = new Error(`Bearer ${SECRET}`);
        logger.error({ err } as LogFields, err.message);
      },
      REDACTED,
    ],
    ['an interpolated message', (logger) => logger.info('csrf_token=%s for %s', SECRET, 'bob@example.test'), 'csrf_token=[REDACTED] for [REDACTED]'],
    ['a default message from an error record', (logger) => logger.warn({ error: { type: 'Conflict', message: `token=${SECRET}` } }), REDACTED],
    ['a default message from err', (logger) => logger.error({ err: new Error(`password=${SECRET}`) } as LogFields), REDACTED],
    ['a thrown string', (logger) => logger.error({ error: `Bearer ${SECRET}` as unknown as Error }), REDACTED],
  ])('masks credentials in %s', (_, log, message) => {
    const { logger, lines } = capture();
    log(logger);
    expect(single(lines).message).toBe(message);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it.each<[string, string, (raw: string) => string, string]>([
    ['kept inside words', 'e', () => 'publish failed', 'publish failed'],
    ['kept inside a non-ASCII word', 'é', () => 'café ouvert', 'café ouvert'],
    ['masked as a word', 'failed', () => 'publish failed', `publish ${REDACTED}`],
    ['masked as the whole message', PII_ERROR_TEXT, (raw) => raw, REDACTED],
    ['masked after a prefix', PII_ERROR_TEXT, (raw) => `x: ${raw}`, `x: ${REDACTED}`],
  ])('replaces the raw message of err only where it stands alone: %s', (_, errorMessage, message, expected) => {
    const { logger, lines, raw } = capture();
    const err = new Error(errorMessage);
    logger.error({ err } as LogFields, message(err.message));
    expect(single(lines).message).toBe(expected);
    expect(raw.join('')).not.toContain(SECRET);
  });

  it.each<[string, (logger: Logger, err: Error) => void | Promise<void>, string]>([
    ['an Error', (logger, err) => logger.error(err), 'PostgreSQL error 42601'],
    ['err', (logger, err) => logger.error({ err } as LogFields), 'PostgreSQL error 42601'],
    ['error with its message', (logger, err) => logger.error({ error: err }, err.message), 'PostgreSQL error 42601'],
    [
      'err with an interpolated message',
      (logger, err) => logger.error({ err } as LogFields, 'failed: %s', err.message),
      'failed: PostgreSQL error 42601',
    ],
    [
      'err from a Fastify error handler',
      async (logger, err) => {
        const app = fastify(fastifyLoggerOptions(logger));
        app.setErrorHandler<Error>((thrown, request, reply) => {
          request.log.error({ req: request, res: reply, err: thrown }, thrown.message);
          return reply.code(500).send({ error: 'internal' });
        });
        app.get('/boom', () => {
          throw err;
        });
        try {
          await app.inject({ method: 'GET', url: '/boom' });
        } finally {
          await app.close();
        }
      },
      'PostgreSQL error 42601',
    ],
  ])('keeps only the SQLSTATE of a database error echoing its input when logging %s', async (_, log, message) => {
    const { logger, lines, raw } = capture();
    const err = Object.assign(new Error(`syntax error at or near "'${ECHO}'"`), { name: 'error', code: '42601', severity: 'ERROR' });
    await log(logger, err);
    expect(single(lines)).toMatchObject({
      message,
      error: { type: 'error', message: 'PostgreSQL error 42601', stack: framesUnder('error: PostgreSQL error 42601', err) },
    });
    expect(raw.join('')).not.toContain(ECHO);
  });

  it.each<[string, (logger: Logger) => void]>([
    ['a message', (logger) => logger.info('consumer "people.person.archived.v1" ready')],
    ['fields and an interpolated message', (logger) => logger.info({ route: '/r' }, 'consumer "%s" ready', 'people.person.archived.v1')],
  ])('keeps quoted text in %s logged without an error', (_, log) => {
    const { logger, lines } = capture();
    log(logger);
    expect(single(lines).message).toBe('consumer "people.person.archived.v1" ready');
  });

  it('masks credentials in contract text fields of merge objects and bindings', () => {
    const { logger, lines } = capture();
    logger
      .child({ userId: 'bob@example.test', requestId: `Bearer ${SECRET}` })
      .info({ tenantId: TENANT_ID, eventId: `token=${SECRET}`, route: `/login?CFTOKEN=${SECRET}`, httpMethod: 'GET' }, 'served');
    expect(single(lines)).toStrictEqual({
      severity: 'INFO',
      timestamp: expect.any(String),
      ...BASE,
      userId: '[REDACTED]',
      requestId: 'Bearer [REDACTED]',
      tenantId: TENANT_ID,
      eventId: 'token=[REDACTED]',
      route: '/login?CFTOKEN=[REDACTED]',
      httpMethod: 'GET',
      message: 'served',
    });
  });

  it('prefers error over err', () => {
    const { logger, lines } = capture();
    logger.error({ err: new Error('err'), error: new SyntaxError('error') } as LogFields);
    expect(single(lines)).toMatchObject({ message: REDACTED, error: { type: 'SyntaxError', message: REDACTED } });
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
    expect(line).toMatchObject({ severity: 'ERROR', message: REDACTED, error: { type: 'Error', message: REDACTED } });
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
    expect(serializeError(error)).toStrictEqual({ type, message: REDACTED, stack: framesUnder(`${type}: ${REDACTED}`, error) });
  });

  it('types an Error without a constructor as Error', () => {
    const error = new Error('m');
    Object.defineProperty(error, 'constructor', { value: undefined });
    expect(serializeError(error)).toMatchObject({ type: 'Error', message: REDACTED });
  });

  it('omits a missing stack', () => {
    const error = new Error('m');
    delete error.stack;
    expect(serializeError(error)).toStrictEqual({ type: 'Error', message: REDACTED });
  });

  it.each<[string, unknown, LogErrorRecord]>([
    ['with a stack', { type: 'T', message: 'm', stack: 's', code: 'E1' }, { type: 'T', message: REDACTED, stack: `T: ${REDACTED}` }],
    ['without a stack', { type: 'T', message: 'm' }, { type: 'T', message: REDACTED }],
    ['with a non-string stack', { type: 'T', message: 'm', stack: 42 }, { type: 'T', message: REDACTED }],
    ['with a safe message', { type: 'T', message: 'connect ECONNREFUSED' }, { type: 'T', message: 'connect ECONNREFUSED' }],
  ])('reduces an error record %s to its type, safe message and frames', (_, value, expected) => {
    expect(serializeError(value)).toStrictEqual(expected);
  });

  it.each<[string, unknown, LogErrorRecord]>([
    ['a string', 'boom', { type: 'string', message: REDACTED }],
    ['a number', 42, { type: 'number', message: REDACTED }],
    ['null', null, { type: 'object', message: REDACTED }],
    ['undefined', undefined, { type: 'undefined', message: REDACTED }],
  ])('describes %s by its typeof', (_, value, expected) => {
    expect(serializeError(value)).toStrictEqual(expected);
  });

  it.each<[string, unknown, LogErrorRecord]>([
    [
      'an Error',
      Object.assign(new Error(`GET https://bob:${SECRET}@api.example.test/x failed`), {
        stack: `Error: token=${SECRET}\n    at f (/repo/src/a.ts:1:2)`,
      }),
      { type: 'Error', message: REDACTED, stack: `Error: ${REDACTED}\n    at f (/repo/src/a.ts:1:2)` },
    ],
    [
      'an error record',
      { type: `Bearer ${SECRET}`, message: `password=${SECRET}`, stack: `cookie: ${SECRET}` },
      { type: 'Bearer [REDACTED]', message: REDACTED, stack: `Bearer [REDACTED]: ${REDACTED}` },
    ],
    ['a thrown string', `session=${SECRET}`, { type: 'string', message: REDACTED }],
  ])('masks credentials in %s and is idempotent on its record', (_, value, expected) => {
    const record = serializeError(value);
    expect(record).toStrictEqual(expected);
    expect(serializeError(record)).toStrictEqual(record);
  });

  it('writes a thrown non-Error value as a valid record', () => {
    const { logger, lines } = capture();
    logger.warn({ error: 'not an error' as unknown as Error }, 'odd throw');
    expect(single(lines).error).toStrictEqual({ type: 'string', message: REDACTED });
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
      error: { type: 'Error', message: REDACTED, stack: framesUnder(`Error: ${REDACTED}`, bound) },
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

  it.each<[string, unknown]>([
    ['statusCode', 200.5],
    ['latencyMs', -1],
    ['tenantId', 42],
    ['service', ''],
    ['version', 7],
    ['env', 'prod'],
  ])('drops binding %s %o that log-record.v1 rejects', (key, value) => {
    const { logger, lines } = capture();
    logger.child({ [key]: value, requestId: 'req-1' } as LogFields).info('child');
    expect(single(lines)).toStrictEqual({ severity: 'INFO', timestamp: expect.any(String), ...BASE, requestId: 'req-1', message: 'child' });
  });

  it('leaves the parent unbound', () => {
    const { logger, lines } = capture();
    logger.child({ tenantId: TENANT_ID });
    logger.info('parent');
    expect(single(lines)).not.toHaveProperty('tenantId');
  });
});

describe('createLogger base options', () => {
  it.each<[string, Partial<CreateLoggerOptions>, string]>([
    ['an empty service', { service: '' }, 'service'],
    ['a non-string service', { service: 42 as unknown as string }, 'service'],
    ['an empty version', { version: '' }, 'version'],
    ['an unknown env', { env: 'prod' as LogEnv }, 'env'],
  ])('throws a TypeError for %s', (_, options, name) => {
    const create = (): unknown => capture(options);
    expect(create).toThrow(TypeError);
    expect(create).toThrow(`createLogger: ${name} does not satisfy log-record.v1`);
  });
});

describe('isValidLogField', () => {
  it.each<[string, unknown, boolean]>([
    ['statusCode', 200, true],
    ['statusCode', 200.5, false],
    ['message', 'x', true],
    ['error', { type: 'Error', message: 'x', code: 'E1' }, false],
    ['unknown', 'x', false],
  ])('judges %s %o as %s', (key, value, valid) => {
    expect(isValidLogField(key, value)).toBe(valid);
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

  it('throws when googleCloudProject cannot form the Cloud Logging trace key', () => {
    const create = (): unknown => capture({ env: 'cloud', googleCloudProject: 'org/project' });
    expect(create).toThrow(TypeError);
    expect(create).toThrow('createLogger: googleCloudProject cannot form a log-record.v1 logging.googleapis.com/trace value');
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
