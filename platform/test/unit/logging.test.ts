import { readFileSync } from 'node:fs';
import { fastify, LogController } from 'fastify';
import { pino, type DestinationStream, type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_FIELD_KEYS, LOG_FIELD_KEYS, TRACE_FIELD_KEYS } from '../../src/logging/fields.js';
import {
  createLogger,
  fastifyLoggerOptions,
  fastifySerializers,
  REDACTED,
  serializeError,
  SEVERITY_BY_LEVEL,
  validateLogRecord,
  type CreateLoggerOptions,
  type LogEnv,
  type LogFields,
  type Logger as RecordLogger,
} from '../../src/logging/index.js';
import {
  flushTracing,
  MemorySpanExporter,
  shutdownTracing,
  SpanKind,
  startSpan,
  startTracing,
  type ReadableSpan,
} from '../../src/tracing/index.js';

type LogLine = Record<string, unknown>;
type Level = keyof typeof SEVERITY_BY_LEVEL;

const TENANT_ID = 'edec963e-3516-5bb6-845d-d01a710e32a7';
const USER_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const EVENT_ID = '0b7f3c1e-2a4d-4e8a-9c3f-0d1e2f3a4b5c';

/** Creates a `trace`-level logger for service `unit` whose lines are parsed into `lines`. */
function captureRecords(options: Partial<CreateLoggerOptions> = {}): { logger: RecordLogger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const destination: DestinationStream = {
    write: (chunk: string) => {
      lines.push(JSON.parse(chunk) as LogLine);
    },
  };
  const logger = createLogger({ service: 'unit', version: '0.0.0', env: 'local', level: 'trace', destination, ...options });
  return { logger, lines };
}

/** Returns `line` after asserting it is a valid log-record.v1 record. */
function validRecord(line: LogLine | undefined): LogLine {
  expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
  return line as LogLine;
}

/** The six base fields of a line written by `captureRecords`. */
function baseRecord(severity: string, message: string, env: LogEnv = 'local'): LogLine {
  return { timestamp: expect.any(String), severity, message, service: 'unit', version: '0.0.0', env };
}

// Synthetic credentials assembled at run time, so no literal secret appears in source.
const SENTINEL = ['opt2', 'sentinel'].join('-');
const AUTHZ = `${SENTINEL}-authz`;
const CFID = `${SENTINEL}-cfid`;
const CFTOKEN = `${SENTINEL}-cftoken`;
const SET_COOKIE = `CFID=${SENTINEL}-setcookie; Path=/; HttpOnly`;
const REQUEST_HEADERS = { authorization: `Bearer ${AUTHZ}`, cookie: `CFID=${CFID}; CFTOKEN=${CFTOKEN}` };
const CREDENTIAL_HEADERS: [string, string][] = [...Object.entries(REQUEST_HEADERS), ['set-cookie', SET_COOKIE]];

/** Creates a `trace`-level logger for service `unit` that keeps each raw written chunk. */
function captureChunks(): { logger: RecordLogger; chunks: string[] } {
  const chunks: string[] = [];
  const destination: DestinationStream = {
    write: (chunk: string) => {
      chunks.push(chunk);
    },
  };
  return { logger: createLogger({ service: 'unit', version: '0.0.0', env: 'local', level: 'trace', destination }), chunks };
}

/** Returns the parsed lines after asserting each is valid and the raw output carries no sentinel. */
function credentialFreeRecords(chunks: string[]): LogLine[] {
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.join('')).not.toContain(SENTINEL);
  return chunks.map((chunk) => validRecord(JSON.parse(chunk) as LogLine));
}

function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { serializers: fastifySerializers },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

// These cases go through the published logging and tracing barrels; edge cases of each module are in
// logger.test.ts and test/contract/log-record-validator.test.ts.
describe('createLogger record shape', () => {
  it('maps pino levels to Cloud Logging severities', () => {
    expect(SEVERITY_BY_LEVEL).toStrictEqual({
      trace: 'DEBUG',
      debug: 'DEBUG',
      info: 'INFO',
      warn: 'WARNING',
      error: 'ERROR',
      fatal: 'CRITICAL',
    });
  });

  it.each(Object.entries(SEVERITY_BY_LEVEL))(
    '%s writes a valid record of exactly the base fields with severity %s',
    (level, severity) => {
      const { logger, lines } = captureRecords();
      logger[level as Level]('hello');
      expect(lines).toHaveLength(1);
      expect(validRecord(lines[0])).toStrictEqual(baseRecord(severity, 'hello'));
    },
  );

  it('writes merge fields and child bindings and drops keys outside LogFields', () => {
    const { logger, lines } = captureRecords();
    const bindings: LogFields = { tenantId: TENANT_ID, userId: USER_ID };
    const fields: LogFields = {
      requestId: 'req-1',
      eventId: EVENT_ID,
      route: '/_api/json/v1/default/content',
      httpMethod: 'GET',
      statusCode: 200,
      latencyMs: 4.5,
    };
    logger
      .child({ ...bindings, siteid: 'default' } as LogFields)
      .info({ ...fields, cookie: 'CFID=1', time: 1 } as LogFields, 'served');
    expect(lines).toHaveLength(1);
    expect(validRecord(lines[0])).toStrictEqual({ ...baseRecord('INFO', 'served'), ...bindings, ...fields });
  });

  it('serializes an Error to type, safe message and stack frames and logs that record as a valid error line', () => {
    const { logger, lines } = captureRecords();
    const error = new TypeError('x');
    const record = serializeError(error);
    expect(record).toStrictEqual({ type: 'TypeError', message: REDACTED, stack: error.stack?.replace('TypeError: x', `TypeError: ${REDACTED}`) });
    logger.error({ error: record }, 'failed');
    expect(lines).toHaveLength(1);
    expect(validRecord(lines[0])).toStrictEqual({ ...baseRecord('ERROR', 'failed'), error: record });
  });
});

describe('createLogger trace fields', () => {
  const exporter = new MemorySpanExporter();

  beforeAll(async () => {
    await startTracing({ serviceName: 'unit', version: '0.0.0', exporter });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each<[LogEnv, string | undefined]>([
    ['local', undefined],
    ['cloud', 'proj'],
  ])('in %s env carries the startSpan span ids inside the span and none outside it', async (env, googleCloudProject) => {
    exporter.reset();
    const { logger, lines } = captureRecords({ env, googleCloudProject });
    await startSpan('t', SpanKind.INTERNAL, () => logger.info('inside'));
    logger.info('outside');
    await flushTracing();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toStrictEqual(['t']);
    const { traceId, spanId } = (spans[0] as ReadableSpan).spanContext();
    const cloudKeys =
      googleCloudProject === undefined
        ? {}
        : {
            'logging.googleapis.com/trace': `projects/${googleCloudProject}/traces/${traceId}`,
            'logging.googleapis.com/spanId': spanId,
            'logging.googleapis.com/trace_sampled': true,
          };
    expect(lines.map((line) => validRecord(line))).toStrictEqual([
      { ...baseRecord('INFO', 'inside', env), traceId, spanId, traceSampled: true, ...cloudKeys },
      baseRecord('INFO', 'outside', env),
    ]);
  });
});

describe('fastifySerializers', () => {
  it.each(['req', 'res'] as const)('%s serializes a value to undefined', (key) => {
    expect(fastifySerializers[key]({ method: 'GET', url: '/', statusCode: 200 })).toBeUndefined();
  });

  it('drop req and res from pino output and keep other fields', () => {
    const { logger, lines } = capturingLogger();
    logger.info({ req: { url: '/' }, res: { statusCode: 200 }, route: '/' }, 'done');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: '/', msg: 'done' });
    expect(lines[0]).not.toHaveProperty('req');
    expect(lines[0]).not.toHaveProperty('res');
  });
});

describe('fastifyLoggerOptions', () => {
  it('passes the logger through with request logging disabled and the requestId label', () => {
    const logger = pino({ enabled: false });
    const options = fastifyLoggerOptions(logger);
    expect(Object.keys(options).toSorted()).toStrictEqual(['logController', 'loggerInstance']);
    expect(options.loggerInstance).toBe(logger);
    expect(options.logController).toBeInstanceOf(LogController);
    expect(options.logController.disableRequestLogging).toBe(true);
    expect(options.logController.requestIdLogLabel).toBe('requestId');
  });

  it('builds a Fastify server without deprecation warnings', async () => {
    const codes: unknown[] = [];
    const onWarning = (warning: Error & { code?: unknown }): void => {
      codes.push(warning.code);
    };
    process.on('warning', onWarning);
    const app = fastify(fastifyLoggerOptions(pino({ enabled: false })));
    try {
      await app.ready();
    } finally {
      process.off('warning', onWarning);
      await app.close();
    }
    expect(codes.filter((code) => code === 'FSTDEP023' || code === 'FSTDEP024')).toStrictEqual([]);
  });

  it('makes Fastify log route lines under requestId and no request lines', async () => {
    const { logger, lines } = capturingLogger();
    const app = fastify(fastifyLoggerOptions(logger));
    app.get('/ping', (request, reply) => {
      request.log.info('handled');
      return reply.send({ ok: true });
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/ping' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'handled' });
    expect(lines[0]).not.toHaveProperty('reqId');
    expect(typeof lines[0]?.requestId).toBe('string');
    expect(lines[0]?.requestId).not.toBe('');
  });
});

describe('createLogger credential headers', () => {
  it.each(CREDENTIAL_HEADERS)('keeps a %s header out of a merge object', (name, value) => {
    const { logger, chunks } = captureChunks();
    const headers = { [name]: value };
    logger.info(
      { req: { method: 'GET', url: '/', headers }, res: { statusCode: 200, headers }, headers, [name]: value, route: '/' } as LogFields,
      'served',
    );
    expect(credentialFreeRecords(chunks)).toStrictEqual([{ ...baseRecord('INFO', 'served'), route: '/' }]);
  });

  it.each(CREDENTIAL_HEADERS)('keeps a %s header out of child bindings', (name, value) => {
    const { logger, chunks } = captureChunks();
    const headers = { [name]: value };
    logger.child({ req: { headers }, res: { headers }, headers, [name]: value, requestId: 'req-1' } as LogFields).info('bound');
    expect(credentialFreeRecords(chunks)).toStrictEqual([{ ...baseRecord('INFO', 'bound'), requestId: 'req-1' }]);
  });

  it('keeps request and reply headers out of Fastify request logs', async () => {
    const { logger, chunks } = captureChunks();
    const app = fastify(fastifyLoggerOptions(logger));
    app.get('/served', (request, reply) => {
      reply.header('set-cookie', SET_COOKIE);
      request.log.info({ req: request, res: reply }, 'served');
      request.log.info({ headers: request.headers, replyHeaders: reply.getHeaders() }, 'headers');
      request.log.info(request.raw);
      request.log.child({ headers: request.headers }).info('child');
      return reply.send({ ok: true });
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/served', headers: REQUEST_HEADERS });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const lines = credentialFreeRecords(chunks);
    expect(lines.map((line) => line.message)).toStrictEqual(['served', 'headers', '', 'child']);
    for (const line of lines) {
      expect(Object.keys(line).toSorted()).toStrictEqual(['env', 'message', 'requestId', 'service', 'severity', 'timestamp', 'version']);
    }
  });

  it.each<[string, string]>([
    ['header lines', `upstream rejected Authorization: Bearer ${AUTHZ}\nCookie: CFID=${CFID}; CFTOKEN=${CFTOKEN}`],
    ['a credential URL', `GET https://u:${AUTHZ}@legacy.example.test/admin/?CFID=${CFID}&CFTOKEN=${CFTOKEN} failed`],
    ['a JSON header dump', JSON.stringify(REQUEST_HEADERS)],
    ['cookie pairs', `session lost: CFID=${CFID}; CFTOKEN=${CFTOKEN}`],
  ])('keeps credentials in a thrown error with %s out of the Fastify error log', async (_, text) => {
    const { logger, chunks } = captureChunks();
    const app = fastify(fastifyLoggerOptions(logger));
    app.setErrorHandler<Error>((err, request, reply) => {
      request.log.error({ req: request, res: reply, err }, err.message);
      return reply.code(500).send({ error: 'internal' });
    });
    app.get('/boom', () => {
      throw new Error(text);
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/boom', headers: REQUEST_HEADERS });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
    const [line, ...rest] = credentialFreeRecords(chunks);
    expect(rest).toStrictEqual([]);
    expect(line).toMatchObject({ severity: 'ERROR', error: { type: 'Error' } });
    expect(line?.message).toBe(REDACTED);
    expect((line?.error as { stack?: string }).stack).toMatch(/^Error: \[REDACTED\]\n {4}at \S/);
  });
});

describe('log field key lists', () => {
  it('with timestamp, severity and message, name each log-record.v1 property exactly once', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
    ) as { properties: Record<string, unknown> };
    const keys: string[] = ['timestamp', 'severity', 'message', ...BASE_FIELD_KEYS, ...LOG_FIELD_KEYS, ...TRACE_FIELD_KEYS];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toStrictEqual(Object.keys(schema.properties).toSorted());
  });

  it('bind service, version and env as the base fields', () => {
    expect(BASE_FIELD_KEYS).toStrictEqual(['service', 'version', 'env']);
  });
});

describe('validateLogRecord', () => {
  const VALID: LogLine = {
    timestamp: '2026-06-30T00:00:00.000Z',
    severity: 'INFO',
    message: 'x',
    service: 'unit',
    version: '0.0.0',
    env: 'local',
  };

  it('accepts a record of the base fields', () => {
    expect(validateLogRecord(VALID)).toStrictEqual({ valid: true, errors: [] });
  });

  it.each<[string, LogLine, string]>([
    ['missing the other base fields', { message: 'x' }, "/ must have required property 'timestamp'"],
    ['carrying a pino default key', { ...VALID, level: 30 }, '/ must NOT have additional properties (level)'],
  ])('rejects a record %s', (_, record, expected) => {
    const result = validateLogRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(expected);
  });
});
