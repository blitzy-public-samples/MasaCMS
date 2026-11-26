import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ajv2020, type AnySchemaObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ENVELOPE_ATTRIBUTE_KEYS,
  ENVELOPE_SCHEMA_ID,
  EnvelopeTenantError,
  buildEnvelope,
  decodeEnvelopeData,
  encodeEnvelope,
  envelopeAttributes,
  envelopeSchema,
  eventTypeOf,
  schemaVersionOf,
  validateEnvelope,
  type EventEnvelope,
} from '../../src/events/index.js';
import { cfUuid } from '../../src/legacy-compat/index.js';
import { tenantDbFromPool, type Pool } from '../../src/tenancy/index.js';
import { TENANT_A, testEnvelope } from '../../src/testing/index.js';

const TOPIC = 'stub.note.created.v1';

const REQUIRED_FIELDS = [
  'eventId',
  'eventType',
  'schemaVersion',
  'tenantId',
  'occurredAt',
  'producer',
  'aggregateType',
  'aggregateId',
  'aggregateVersion',
  'traceparent',
  'correlationId',
  'payload',
] as const;

const OPTIONAL_FIELDS = ['tracestate', 'causationId'] as const;

const ATTRIBUTE_FIELDS = ['eventId', 'eventType', 'schemaVersion', 'tenantId', 'aggregateVersion', 'traceparent'];

const RFC4122_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

interface Statement {
  text: string;
  values: unknown[] | undefined;
}

let schema: AnySchemaObject;
let validate: ValidateFunction;

/** A draft 2020-12 Ajv configured like the platform's shared instance: strict, its formats and its x-opt2 keywords. */
function freshAjv(contract: AnySchemaObject): Ajv2020 {
  const uuid = new RegExp(contract.$defs.rfc4122Uuid.pattern as string, 'iu');
  const dateTime = new RegExp(contract.$defs.rfc3339DateTime.pattern as string, 'u');
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    formats: { uuid, 'date-time': (value: string) => dateTime.test(value) && Number.isFinite(Date.parse(value)) },
  });
  ajv.addKeyword({ keyword: 'x-opt2-kind', metaSchema: { enum: ['state', 'process'] } });
  ajv.addKeyword({ keyword: 'x-opt2-tenant-fanout', metaSchema: { enum: ['userPool'] } });
  ajv.addKeyword({ keyword: 'x-opt2-supersedes', metaSchema: { type: 'boolean' } });
  return ajv;
}

/** A pg pool stand-in whose statements all succeed, recording each one into `statements`. */
function recordingPool(statements: Statement[]): Pool {
  const client = {
    query: (text: string, values?: unknown[]) => {
      statements.push({ text, values });
      return Promise.resolve({ command: text.split(' ')[0], rows: [], rowCount: 0 });
    },
    release: (): void => undefined,
  };
  return { connect: () => Promise.resolve(client), on: () => undefined, end: () => Promise.resolve() } as unknown as Pool;
}

/** A stub note envelope from testEnvelope; `optional` adds tracestate and causationId. */
function noteEnvelope(optional: boolean): EventEnvelope {
  const noteId = cfUuid();
  const envelope = testEnvelope({
    topic: TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: noteId,
    aggregateVersion: 2,
    payload: { noteId, title: 'Note', body: 'hello', created: '2026-06-30 09:15:00.250', rowVersion: 2 },
    ...(optional ? { causationId: randomUUID() } : {}),
  });
  return optional ? { ...envelope, tracestate: 'opt2=1' } : envelope;
}

/** A copy of `sample` without `fields`. */
function without(sample: object, ...fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(sample).filter(([key]) => !fields.includes(key)));
}

/** The verdicts of the fresh compile and of validateEnvelope, in that order. */
function verdicts(sample: unknown): [boolean, boolean] {
  return [validate(sample), validateEnvelope(sample).ok];
}

const FULL = noteEnvelope(true);
const PLAIN = noteEnvelope(false);

const ACCEPTED: readonly (readonly [string, unknown])[] = [
  ['a testEnvelope envelope', PLAIN],
  ['an envelope with tracestate and causationId', FULL],
  ['an envelope without tracestate and causationId', without(FULL, ...OPTIONAL_FIELDS)],
  ['a null causationId', { ...FULL, causationId: null }],
  ['an occurredAt with a numeric offset', { ...FULL, occurredAt: '2026-06-30T09:15:00.250+02:00' }],
];

/** Rejected samples with the one schema location each must fail. */
const REJECTED: readonly (readonly [string, unknown, string])[] = [
  ['an extra top-level field', { ...FULL, extra: true }, '#/additionalProperties'],
  ['a 35-character CF UUID as eventId', { ...FULL, eventId: cfUuid() }, '#/$defs/rfc4122Uuid/pattern'],
  ['a 35-character CF UUID as tenantId', { ...FULL, tenantId: cfUuid() }, '#/$defs/rfc4122Uuid/pattern'],
  ['a non-hex uuid as eventId', { ...FULL, eventId: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz' }, '#/$defs/rfc4122Uuid/pattern'],
  ['a fractional aggregateVersion', { ...FULL, aggregateVersion: 1.5 }, '#/properties/aggregateVersion/type'],
  ['a string aggregateVersion', { ...FULL, aggregateVersion: '1' }, '#/properties/aggregateVersion/type'],
  ['an occurredAt that is not a date', { ...FULL, occurredAt: 'not-a-date' }, '#/$defs/rfc3339DateTime/pattern'],
];

beforeAll(async () => {
  schema = JSON.parse(
    await readFile(new URL('../../contracts/event-envelope.v1.json', import.meta.url), 'utf8'),
  ) as AnySchemaObject;
  validate = freshAjv(schema).compile(schema);
});

describe('event-envelope.v1 schema', () => {
  it('compiles in strict mode on an Ajv configured like the platform', () => {
    expect(() => freshAjv(schema).compile(schema)).not.toThrow();
  });

  it('declares the $id the platform validator registers', () => {
    expect(schema.$id).toBe('urn:opt2:platform:event-envelope:v1');
    expect(schema.$id).toBe(ENVELOPE_SCHEMA_ID);
  });

  it('is the contract envelopeSchema() serves', () => {
    expect(envelopeSchema()).toEqual(schema);
  });

  it('declares every envelope field, requires all but tracestate and causationId, and allows no others', () => {
    expect(new Set(Object.keys(schema.properties as object))).toEqual(new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]));
    expect(schema.required).toHaveLength(REQUIRED_FIELDS.length);
    expect(new Set(schema.required as string[])).toEqual(new Set(REQUIRED_FIELDS));
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('envelope samples', () => {
  it.each(ACCEPTED)('accepts %s', (_label, sample) => {
    expect(verdicts(sample)).toEqual([true, true]);
  });

  it.each(REJECTED)('rejects %s', (_label, sample, schemaPath) => {
    expect(verdicts(sample)).toEqual([false, false]);
    expect(validateEnvelope(sample)).toMatchObject({ schemaPaths: [schemaPath] });
  });

  it.each(REQUIRED_FIELDS)('rejects an envelope without %s', (field) => {
    const sample = without(FULL, field);
    expect(verdicts(sample)).toEqual([false, false]);
    expect(validateEnvelope(sample)).toMatchObject({ schemaPaths: ['#/required'] });
  });

  it('answers validateEnvelope with the value or with errors and schema paths', () => {
    expect(validateEnvelope(FULL)).toEqual({ ok: true, value: FULL });
    expect(validateEnvelope({ ...FULL, extra: true })).toEqual({
      ok: false,
      errors: ['/ must NOT have additional properties (extra)'],
      schemaPaths: ['#/additionalProperties'],
    });
  });
});

describe('producer output', () => {
  it('validates an envelope built in a tenant transaction, carrying that transaction tenant', async () => {
    const statements: Statement[] = [];
    const db = tenantDbFromPool(recordingPool(statements), { schema: 'contract_env' });
    const noteId = cfUuid();
    const envelope = await db.withTenant(TENANT_A.tenantId, () =>
      Promise.resolve(
        buildEnvelope({ topic: TOPIC, aggregateType: 'note', aggregateId: noteId, aggregateVersion: 1, payload: { noteId } }),
      ),
    );
    await db.end();

    expect(statements.slice(0, 2)).toEqual([
      { text: 'BEGIN', values: undefined },
      { text: "SELECT set_config('app.tenant_id', $1, true)", values: [TENANT_A.tenantId] },
    ]);
    expect(validate(envelope)).toBe(true);
    expect(envelope).toMatchObject({
      tenantId: TENANT_A.tenantId,
      eventType: eventTypeOf(TOPIC),
      schemaVersion: schemaVersionOf(TOPIC),
      producer: 'stub',
      aggregateId: noteId,
    });
    expect(envelope.schemaVersion).toBe('1.0.0');
    expect(envelope.eventId).toMatch(RFC4122_V4);
    expect(envelope.traceparent).toMatch(TRACEPARENT);
  });

  it('refuses to build an envelope outside a tenant transaction', () => {
    expect(() =>
      buildEnvelope({ topic: TOPIC, aggregateType: 'note', aggregateId: cfUuid(), aggregateVersion: 1, payload: {} }),
    ).toThrow(EnvelopeTenantError);
  });

  it('mirrors exactly the six attribute fields as strings', () => {
    const attributes = envelopeAttributes(PLAIN);
    expect(new Set(ENVELOPE_ATTRIBUTE_KEYS)).toEqual(new Set(ATTRIBUTE_FIELDS));
    expect(Object.keys(attributes)).toEqual([...ENVELOPE_ATTRIBUTE_KEYS]);
    expect(Object.values(attributes).every((value) => typeof value === 'string')).toBe(true);
    expect(attributes.aggregateVersion).toBe(String(PLAIN.aggregateVersion));
  });

  it('round-trips through the message encoding unchanged', () => {
    expect(decodeEnvelopeData(encodeEnvelope(FULL))).toEqual(FULL);
  });
});
