import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLogger,
  REDACTED,
  serializeError,
  SEVERITY_BY_LEVEL,
  validateLogRecord,
  type CreateLoggerOptions,
  type LogErrorRecord,
  type Logger,
} from '../../src/logging/index.js';
import { baseEnvSchema, createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { testVerifier, writeTestSecrets } from '../../src/testing/index.js';
import {
  activeSpanIds,
  MemorySpanExporter,
  shutdownTracing,
  SpanKind,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';

type LogLine = Record<string, unknown>;
type Level = keyof typeof SEVERITY_BY_LEVEL;
type SpanIds = NonNullable<ReturnType<typeof activeSpanIds>>;

const schema = JSON.parse(
  readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
) as AnySchemaObject;

// Built as validate.ts builds its validator: the contract uses no `format` keyword, so no formats are registered.
const reference = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const BASE = { service: 'platform-contract', version: '0.0.0', env: 'local' } as const;
const PROJECT = 'opt2-plan';
const PINO_DEFAULT_KEYS = ['level', 'time', 'pid', 'hostname', 'msg', 'req', 'res', 'reqId'] as const;
const BASE_LINE_KEYS = ['env', 'message', 'requestId', 'service', 'severity', 'timestamp', 'version'];

const MINIMAL: Readonly<LogLine> = {
  timestamp: '2026-06-30T12:00:00.000Z',
  severity: 'INFO',
  message: 'hello',
  service: 'people',
  version: '1.0.0',
  env: 'local',
};

/** Creates a logger writing to memory; `lines()` parses every line written so far. */
function captureLogger(options: Partial<CreateLoggerOptions> = {}): { logger: Logger; lines(): LogLine[] } {
  const chunks: string[] = [];
  const destination: NonNullable<CreateLoggerOptions['destination']> = {
    write: (chunk: string) => void chunks.push(chunk),
  };
  return {
    logger: createLogger({ ...BASE, destination, ...options }),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogLine),
  };
}

/** Asserts that `line` satisfies log-record.v1 under the independent compile and under validateLogRecord. */
function expectConforming(line: unknown): void {
  expect(reference(line), JSON.stringify(reference.errors)).toBe(true);
  expect(validateLogRecord(line)).toStrictEqual({ valid: true, errors: [] });
}

/** Asserts that both validators reject `record`; returns validateLogRecord's errors. */
function expectRejected(record: unknown): string[] {
  expect(reference(record)).toBe(false);
  const result = validateLogRecord(record);
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors).toHaveLength(reference.errors?.length ?? 0);
  return result.errors;
}

/** Returns the only captured line after asserting it conforms. */
function onlyLine(lines: LogLine[]): LogLine {
  expect(lines).toHaveLength(1);
  const line = lines[0] as LogLine;
  expectConforming(line);
  return line;
}

/** Runs `log` inside a new active span and returns that span's ids. */
async function inSpan(log: () => void): Promise<SpanIds> {
  const ids = await startSpan('log.test', SpanKind.INTERNAL, () => {
    log();
    return activeSpanIds();
  });
  if (ids === undefined) throw new Error('startSpan ran without a valid active span');
  return ids;
}

describe('log-record.v1 contract', () => {
  // Required fields and per-field constraints are covered by log-record-validator.test.ts.
  it('compiles under Ajv strict mode with the v1 $id', () => {
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
    expect(schema.$id).toBe('urn:opt2:platform:log-record:v1');
  });

  it.each(Object.entries(SEVERITY_BY_LEVEL))(
    'accepts the severity of pino level %s (%s) but not the level label',
    (label, severity) => {
      expectConforming({ ...MINIMAL, severity });
      expect(expectRejected({ ...MINIMAL, severity: label })).toContain(
        '/severity must be equal to one of the allowed values',
      );
    },
  );

  it.each(PINO_DEFAULT_KEYS)('rejects the pino default key %s', (key) => {
    expect(expectRejected({ ...MINIMAL, [key]: 1 })).toContain(`/ must NOT have additional properties (${key})`);
  });
});

describe('createLogger output', () => {
  beforeAll(async () => {
    await startTracing({ serviceName: 'platform-contract-logging', version: '0.0.0', exporter: new MemorySpanExporter() });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each(Object.entries(SEVERITY_BY_LEVEL))(
    'writes level %s as severity %s with only base and merge fields outside a span',
    (level, severity) => {
      const { logger, lines } = captureLogger({ level });
      logger[level as Level]({ requestId: 'r1' }, 'hello');
      const line = onlyLine(lines());
      expect(Object.keys(line).sort()).toEqual(BASE_LINE_KEYS);
      expect(line).toMatchObject({ ...BASE, severity, message: 'hello', requestId: 'r1' });
    },
  );

  it.each<[string, Partial<CreateLoggerOptions>, (ids: SpanIds) => LogLine]>([
    ['local', {}, () => ({})],
    [
      'cloud',
      { env: 'cloud', googleCloudProject: PROJECT },
      (ids) => ({
        'logging.googleapis.com/trace': `projects/${PROJECT}/traces/${ids.traceId}`,
        'logging.googleapis.com/spanId': ids.spanId,
        'logging.googleapis.com/trace_sampled': ids.traceSampled,
      }),
    ],
  ])('writes the active span ids in %s env, with Cloud Logging trace keys only in cloud', async (env, options, cloudKeys) => {
    const { logger, lines } = captureLogger(options);
    const ids = await inSpan(() => logger.info('in span'));
    const line = onlyLine(lines());
    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(line).toMatchObject({ env, traceId: ids.traceId, spanId: ids.spanId, traceSampled: ids.traceSampled });
    expect(line.traceSampled).toEqual(expect.any(Boolean));
    const written = Object.fromEntries(Object.entries(line).filter(([key]) => key.startsWith('logging.googleapis.com/')));
    expect(written).toStrictEqual(cloudKeys(ids));
  });

  // The logger writes an error's safe message, never its raw text, so `boom` must not reach the line.
  it.each<[string, Error | LogErrorRecord]>([
    ['an Error', new TypeError('boom')],
    ['a serialized error', serializeError(new TypeError('boom'))],
  ])('writes %s as the contract error record', (_label, error) => {
    const { logger, lines } = captureLogger();
    logger.error({ error }, 'failed');
    const line = onlyLine(lines());
    expect(line).toMatchObject({
      severity: 'ERROR',
      message: 'failed',
      error: { type: 'TypeError', message: REDACTED, stack: expect.stringMatching(/^TypeError: \[REDACTED\]\n\s+at /) },
    });
    expect(JSON.stringify(line)).not.toContain('boom');
  });
});

describe('createService log lines', () => {
  let stateDir: string | undefined;
  let app: FastifyInstance | undefined;
  let lines: () => LogLine[] = () => [];

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'opt2-contract-'));
    await writeTestSecrets(stateDir);
    const env = loadEnv(baseEnvSchema, {
      PORT: '8199',
      OPT2_SERVICE_NAME: BASE.service,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    });
    const captured = captureLogger();
    lines = captured.lines;
    app = await createService({
      name: BASE.service,
      version: BASE.version,
      env,
      verifierOverride: testVerifier(),
      logger: captured.logger,
    });
    app.get('/contract/log', { config: { opt2: { public: true } } }, async () => ({ ok: true }));
  });

  afterAll(async () => {
    await app?.close();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  it('writes one conforming request line per request and no Fastify request or reply keys', async () => {
    const res = await app?.inject({ method: 'GET', url: '/contract/log', headers: { 'x-request-id': 'contract-req-1' } });
    expect(res?.statusCode).toBe(200);
    const captured = lines();
    for (const line of captured) {
      expectConforming(line);
      for (const key of PINO_DEFAULT_KEYS) expect(line).not.toHaveProperty(key);
    }
    const requestLines = captured.filter((line) => 'route' in line);
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({
      route: '/contract/log',
      httpMethod: 'GET',
      statusCode: 200,
      requestId: 'contract-req-1',
      latencyMs: expect.any(Number),
    });
  });
});
