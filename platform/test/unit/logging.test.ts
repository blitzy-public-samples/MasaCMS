import { readFileSync } from 'node:fs';
import { fastify } from 'fastify';
import { pino, type DestinationStream, type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_FIELD_KEYS, LOG_FIELD_KEYS, TRACE_FIELD_KEYS } from '../../src/logging/fields.js';
import {
  createLogger,
  fastifyLoggerOptions,
  fastifySerializers,
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

  it('serializes an Error to type, message and stack and logs that record as a valid error line', () => {
    const { logger, lines } = captureRecords();
    const error = new TypeError('x');
    const record = serializeError(error);
    expect(record).toStrictEqual({ type: 'TypeError', message: 'x', stack: error.stack });
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
    expect(options).toStrictEqual({ loggerInstance: logger, disableRequestLogging: true, requestIdLogLabel: 'requestId' });
    expect(options.loggerInstance).toBe(logger);
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
