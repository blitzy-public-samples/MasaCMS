import { readFileSync } from 'node:fs';
import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateLogRecord } from '../../src/logging/validate.js';

const schema = JSON.parse(
  readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
) as AnySchemaObject;

const reference = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const REQUIRED_FIELDS = ['timestamp', 'severity', 'message', 'service', 'version', 'env'] as const;

const SEVERITIES = ['DEFAULT', 'DEBUG', 'INFO', 'NOTICE', 'WARNING', 'ERROR', 'CRITICAL', 'ALERT', 'EMERGENCY'];

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

const MINIMAL: Readonly<Record<string, unknown>> = {
  timestamp: '2026-11-10T08:57:16.524Z',
  severity: 'INFO',
  message: 'request completed',
  service: 'people',
  version: '1.0.0',
  env: 'local',
};

const FULL: Readonly<Record<string, unknown>> = {
  ...MINIMAL,
  severity: 'ERROR',
  env: 'cloud',
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  traceSampled: true,
  tenantId: 'edec963e-3516-5bb6-845d-d01a710e32a7',
  userId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6',
  requestId: 'req-1',
  eventId: '0b7f3c1e-2a4d-4e8a-9c3f-0d1e2f3a4b5c',
  route: '/_api/json/v1/default/content',
  httpMethod: 'GET',
  statusCode: 500,
  latencyMs: 12.5,
  error: { type: 'TypeError', message: 'boom', stack: 'TypeError: boom\n    at handler' },
  'logging.googleapis.com/trace': `projects/opt2-local/traces/${TRACE_ID}`,
  'logging.googleapis.com/spanId': SPAN_ID,
  'logging.googleapis.com/trace_sampled': true,
};

/** Returns MINIMAL without `field`. */
function without(field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(MINIMAL).filter(([key]) => key !== field));
}

const VALID_SAMPLES: readonly (readonly [string, unknown])[] = [
  ['the minimal record', MINIMAL],
  ['a record with every field', FULL],
  ['a timestamp with a numeric offset', { ...MINIMAL, timestamp: '2026-11-10T09:57:16+01:00' }],
  ['a timestamp with nanoseconds', { ...MINIMAL, timestamp: '2026-11-10T08:57:16.123456789Z' }],
  ['an empty message', { ...MINIMAL, message: '' }],
  ['an error without a stack', { ...MINIMAL, error: { type: 'Error', message: 'failed' } }],
  ['the lowest status code', { ...MINIMAL, statusCode: 100 }],
  ['the highest status code', { ...MINIMAL, statusCode: 599 }],
  ['zero latency', { ...MINIMAL, latencyMs: 0 }],
  ...SEVERITIES.map((severity) => [`severity ${severity}`, { ...MINIMAL, severity }] as const),
];

const INVALID_SAMPLES: readonly (readonly [string, unknown, string])[] = [
  ['an extra property', { ...MINIMAL, pid: 4242 }, '/ must NOT have additional properties (pid)'],
  ['a lower-case severity', { ...MINIMAL, severity: 'info' }, '/severity must be equal to one of the allowed values'],
  ['an unknown env', { ...MINIMAL, env: 'production' }, '/env must be equal to one of the allowed values'],
  ['a timestamp without a zone', { ...MINIMAL, timestamp: '2026-11-10T08:57:16' }, '/timestamp must match pattern'],
  ['an empty service', { ...MINIMAL, service: '' }, '/service must NOT have fewer than 1 characters'],
  ['an empty version', { ...MINIMAL, version: '' }, '/version must NOT have fewer than 1 characters'],
  ['an upper-case trace id', { ...MINIMAL, traceId: TRACE_ID.toUpperCase() }, '/traceId must match pattern'],
  ['a short span id', { ...MINIMAL, spanId: SPAN_ID.slice(1) }, '/spanId must match pattern'],
  ['a string traceSampled', { ...MINIMAL, traceSampled: 'true' }, '/traceSampled must be boolean'],
  ['a fractional status code', { ...MINIMAL, statusCode: 200.5 }, '/statusCode must be integer'],
  ['a status code below 100', { ...MINIMAL, statusCode: 99 }, '/statusCode must be >= 100'],
  ['a status code above 599', { ...MINIMAL, statusCode: 600 }, '/statusCode must be <= 599'],
  ['a negative latency', { ...MINIMAL, latencyMs: -1 }, '/latencyMs must be >= 0'],
  ['a numeric tenant id', { ...MINIMAL, tenantId: 7 }, '/tenantId must be string'],
  ['an error without a message', { ...MINIMAL, error: { type: 'Error' } }, "/error must have required property 'message'"],
  [
    'an error with an extra property',
    { ...MINIMAL, error: { type: 'Error', message: 'failed', code: 'E1' } },
    '/error must NOT have additional properties (code)',
  ],
  [
    'a Cloud Logging trace without a project',
    { ...MINIMAL, 'logging.googleapis.com/trace': TRACE_ID },
    '/logging.googleapis.com~1trace must match pattern',
  ],
  ['a null record', null, '/ must be object'],
  ['an array record', [MINIMAL], '/ must be object'],
  ['a string record', JSON.stringify(MINIMAL), '/ must be object'],
];

describe('log-record.v1 schema', () => {
  it('is a draft 2020-12 schema that compiles under Ajv strict mode', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(() => new Ajv2020({ strict: true }).compile(schema)).not.toThrow();
  });

  it('requires exactly the six base fields', () => {
    expect(schema.required).toEqual([...REQUIRED_FIELDS]);
  });
});

describe('validateLogRecord', () => {
  it.each(VALID_SAMPLES)('accepts %s with no errors, as the schema does', (_label, record) => {
    expect(reference(record)).toBe(true);
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
  });

  it.each(REQUIRED_FIELDS)('rejects a record missing %s at the root', (field) => {
    const record = without(field);
    expect(reference(record)).toBe(false);
    expect(validateLogRecord(record)).toEqual({
      valid: false,
      errors: [`/ must have required property '${field}'`],
    });
  });

  it.each(INVALID_SAMPLES)('rejects %s, as the schema does', (_label, record, expected) => {
    expect(reference(record)).toBe(false);
    const result = validateLogRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(reference.errors?.length ?? 0);
    expect(result.errors.some((error) => error.startsWith(expected))).toBe(true);
  });

  it('reports every violation as an "<instancePath> <message>" string', () => {
    const record = { severity: 'info', env: 'production', statusCode: 42, pid: 1 };
    expect(reference(record)).toBe(false);
    const { errors } = validateLogRecord(record);
    expect(errors).toHaveLength(reference.errors?.length ?? 0);
    for (const error of errors) {
      expect(error).toMatch(/^\/\S* \S/);
    }
    expect(errors).toEqual(
      expect.arrayContaining([
        "/ must have required property 'timestamp'",
        '/ must NOT have additional properties (pid)',
        '/severity must be equal to one of the allowed values',
        '/env must be equal to one of the allowed values',
        '/statusCode must be >= 100',
      ]),
    );
  });

  it('returns the same verdict when the cached validator is reused', () => {
    const record = { ...MINIMAL, pid: 1 };
    const first = validateLogRecord(record);
    const second = validateLogRecord(record);
    expect(first.valid).toBe(reference(record));
    expect(second).toEqual(first);
    expect(validateLogRecord(MINIMAL)).toEqual({ valid: reference(MINIMAL), errors: [] });
  });
});
