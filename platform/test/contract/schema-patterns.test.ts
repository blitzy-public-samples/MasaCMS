import { readFileSync } from 'node:fs';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateLogRecord } from '../../src/logging/validate.js';

const envelopeSchema = JSON.parse(
  readFileSync(new URL('../../contracts/event-envelope.v1.json', import.meta.url), 'utf8'),
) as AnySchemaObject;

const logSchema = JSON.parse(
  readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
) as AnySchemaObject;

const validateEnvelope = new Ajv2020({ allErrors: true, strict: true }).compile(envelopeSchema);
const validateLog = new Ajv2020({ allErrors: true, strict: true }).compile(logSchema);

const TIMESTAMP_PATTERN = logSchema.properties.timestamp.pattern as string;
const TRACEPARENT_PATTERN = envelopeSchema.properties.traceparent.pattern as string;

const ENVELOPE: Readonly<Record<string, unknown>> = {
  eventId: '3f1e2d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f',
  eventType: 'people.person.archived',
  schemaVersion: '1.0.0',
  tenantId: '9b2a6c1e-3f4d-5a6b-8c7d-1e2f3a4b5c6d',
  occurredAt: '2026-11-10T08:57:16.524Z',
  producer: 'people',
  aggregateType: 'person',
  aggregateId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6',
  aggregateVersion: 1,
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  correlationId: 'req-1',
  payload: { personId: 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', siteId: 'tenant-a', effectiveFrom: '2026-11-10' },
};

const LOG_RECORD: Readonly<Record<string, unknown>> = {
  timestamp: '2026-11-10T08:57:16.524Z',
  severity: 'INFO',
  message: 'request completed',
  service: 'people',
  version: '1.0.0',
  env: 'local',
};

/** Ajv errors for `value` as "<instancePath> <message>" strings; empty when valid. */
function errorsOf(validate: ValidateFunction, value: unknown): string[] {
  return validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

const TIMESTAMP_TARGETS = [
  {
    target: 'event-envelope.v1 occurredAt',
    field: 'occurredAt',
    verdicts: (value: string): string[][] => [errorsOf(validateEnvelope, { ...ENVELOPE, occurredAt: value })],
  },
  {
    target: 'log-record.v1 timestamp',
    field: 'timestamp',
    verdicts: (value: string): string[][] => {
      const record = { ...LOG_RECORD, timestamp: value };
      return [errorsOf(validateLog, record), validateLogRecord(record).errors];
    },
  },
] as const;

const VALID_TIMESTAMPS: readonly (readonly [string, string])[] = [
  ['Feb 29 of a leap year', '2024-02-29T12:00:00Z'],
  ['Feb 29 of a year divisible by 400', '2000-02-29T00:00:00Z'],
  ['Feb 28 of a common year', '2026-02-28T00:00:00Z'],
  ['Jan 31', '2026-01-31T00:00:00Z'],
  ['Dec 31', '2026-12-31T00:00:00Z'],
  ['Apr 30', '2026-04-30T00:00:00Z'],
  ['the last second of a day', '2026-11-10T23:59:59Z'],
  ['offset +23:59', '2026-11-10T08:57:16+23:59'],
  ['offset -00:00', '2026-11-10T08:57:16-00:00'],
  ['offset +05:30', '2026-11-10T14:27:16+05:30'],
  ['nine fraction digits', '2026-11-10T08:57:16.123456789Z'],
  ['Date#toISOString output', new Date(Date.UTC(2026, 10, 10, 8, 57, 16, 524)).toISOString()],
];

const INVALID_TIMESTAMPS: readonly (readonly [string, string])[] = [
  ['an out-of-range date, time and offset', '2026-99-99T99:99:99+99:99'],
  ['month 00', '2026-00-10T08:57:16Z'],
  ['month 13', '2026-13-10T08:57:16Z'],
  ['day 00', '2026-11-00T08:57:16Z'],
  ['day 32', '2026-01-32T08:57:16Z'],
  ['Apr 31', '2026-04-31T08:57:16Z'],
  ['Feb 30', '2024-02-30T08:57:16Z'],
  ['Feb 29 of a common year', '2026-02-29T08:57:16Z'],
  ['Feb 29 of a century not divisible by 400', '1900-02-29T08:57:16Z'],
  ['hour 24', '2026-11-10T24:00:00Z'],
  ['minute 60', '2026-11-10T08:60:16Z'],
  ['second 60', '2016-12-31T23:59:60Z'],
  ['offset hour 24', '2026-11-10T08:57:16+24:00'],
  ['offset minute 60', '2026-11-10T08:57:16+05:60'],
];

const VALID_TRACEPARENTS: readonly (readonly [string, string])[] = [
  ['the W3C sample', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
  ['a trace id with leading zeros', '00-00000000000000000000000000000001-00f067aa0ba902b7-01'],
  ['a parent id with leading zeros', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000001-01'],
];

const INVALID_TRACEPARENTS: readonly (readonly [string, string])[] = [
  ['an all-zero trace id', '00-00000000000000000000000000000000-00f067aa0ba902b7-01'],
  ['an all-zero parent id', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'],
  ['all-zero trace and parent ids', '00-00000000000000000000000000000000-0000000000000000-01'],
];

describe('shared timestamp pattern', () => {
  it('is the same string in event-envelope.v1 and log-record.v1', () => {
    expect(envelopeSchema.$defs.rfc3339DateTime.pattern).toBe(TIMESTAMP_PATTERN);
  });
});

describe.each(TIMESTAMP_TARGETS)('$target', ({ field, verdicts }) => {
  it.each(VALID_TIMESTAMPS)('accepts %s', (_label, value) => {
    for (const errors of verdicts(value)) {
      expect(errors).toEqual([]);
    }
  });

  it.each(INVALID_TIMESTAMPS)('rejects %s with a pattern error', (_label, value) => {
    for (const errors of verdicts(value)) {
      expect(errors).toEqual([`/${field} must match pattern "${TIMESTAMP_PATTERN}"`]);
    }
  });
});

describe('event-envelope.v1 traceparent', () => {
  it.each(VALID_TRACEPARENTS)('accepts %s', (_label, traceparent) => {
    expect(errorsOf(validateEnvelope, { ...ENVELOPE, traceparent })).toEqual([]);
  });

  it.each(INVALID_TRACEPARENTS)('rejects %s with a pattern error', (_label, traceparent) => {
    expect(errorsOf(validateEnvelope, { ...ENVELOPE, traceparent })).toEqual([
      `/traceparent must match pattern "${TRACEPARENT_PATTERN}"`,
    ]);
  });
});
