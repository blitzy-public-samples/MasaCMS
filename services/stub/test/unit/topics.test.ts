/** Topic, subscription and payload-schema constants of the stub. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  dlqTopicName,
  parseTopic,
  subscriptionName,
  topicName,
  topicSchemaRelativePath,
  validateEnvelope,
} from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC as PLATFORM_SITE_CHANGED_TOPIC, tenantIdForSite } from '@opt2/platform/tenancy';
import type { StubNoteCreatedV1Payload } from '../../src/generated/events/stub.note.created.v1.js';
import {
  NOTE_CREATED_DLQ,
  NOTE_CREATED_SCHEMA_URL,
  NOTE_CREATED_SUBSCRIPTION,
  NOTE_CREATED_TOPIC,
  SITE_CHANGED_SCHEMA_URL,
  SITE_CHANGED_SUBSCRIPTION,
  SITE_CHANGED_TOPIC,
  noteCreatedSchema,
  noteCreatedValidator,
  siteChangedSchema,
} from '../../src/events/topics.js';

const NOTE_CONTRACT_URL = new URL('../../contracts/events/stub.note.created.v1.json', import.meta.url);
const SITE_CONTRACT_URL = new URL(
  '../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json',
  import.meta.url,
);

function notePayload(): StubNoteCreatedV1Payload {
  return {
    noteId: 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90',
    title: 'First note',
    body: '',
    created: '2026-11-10 08:57:16.524',
    rowVersion: 1,
  };
}

function payloadErrors(payload: unknown): string[] {
  const result = noteCreatedValidator.validatePayload(payload);
  return result.ok ? [] : result.errors;
}

describe('stub topic names', () => {
  it.each([
    {
      name: 'NOTE_CREATED_TOPIC',
      actual: NOTE_CREATED_TOPIC,
      built: topicName('stub', 'note', 'created', 1),
      literal: 'stub.note.created.v1',
    },
    {
      name: 'NOTE_CREATED_SUBSCRIPTION',
      actual: NOTE_CREATED_SUBSCRIPTION,
      built: subscriptionName('stub', 'stub.note.created.v1'),
      literal: 'stub.stub.note.created.v1',
    },
    {
      name: 'NOTE_CREATED_DLQ',
      actual: NOTE_CREATED_DLQ,
      built: dlqTopicName('stub.stub.note.created.v1'),
      literal: 'stub.stub.note.created.v1.dlq',
    },
    {
      name: 'SITE_CHANGED_TOPIC',
      actual: SITE_CHANGED_TOPIC,
      built: topicName('programs-sites', 'site', 'changed', 1),
      literal: 'programs-sites.site.changed.v1',
    },
    {
      name: 'SITE_CHANGED_SUBSCRIPTION',
      actual: SITE_CHANGED_SUBSCRIPTION,
      built: subscriptionName('stub', 'programs-sites.site.changed.v1'),
      literal: 'stub.programs-sites.site.changed.v1',
    },
  ])('$name is the platform-built $literal', ({ actual, built, literal }) => {
    expect(built).toBe(literal);
    expect(actual).toBe(literal);
  });

  it('re-exports the platform site registry topic', () => {
    expect(SITE_CHANGED_TOPIC).toBe(PLATFORM_SITE_CHANGED_TOPIC);
  });
});

describe('stub topic schemas', () => {
  it.each([
    { name: 'noteCreatedSchema', topic: NOTE_CREATED_TOPIC, url: NOTE_CREATED_SCHEMA_URL, schema: noteCreatedSchema, contract: NOTE_CONTRACT_URL },
    { name: 'siteChangedSchema', topic: SITE_CHANGED_TOPIC, url: SITE_CHANGED_SCHEMA_URL, schema: siteChangedSchema, contract: SITE_CONTRACT_URL },
  ])('$name is the parsed producer contract of $topic', ({ topic, url, schema, contract }) => {
    expect(url.href).toBe(contract.href);
    expect(url.pathname.endsWith(`/${topicSchemaRelativePath(topic)}`)).toBe(true);
    expect(existsSync(url)).toBe(true);
    expect(schema).toEqual(JSON.parse(readFileSync(contract, 'utf8')));
  });
});

describe('noteCreatedValidator', () => {
  it('declares the state kind and the contract $id', () => {
    expect(noteCreatedValidator.meta).toEqual({ kind: 'state' });
    expect(noteCreatedValidator.schemaId).toBe('urn:opt2:stub:event:stub.note.created.v1');
  });

  it('accepts a payload that follows the contract', () => {
    const payload = notePayload();
    expect(noteCreatedValidator.validatePayload(payload)).toEqual({ ok: true, value: payload });
  });

  it.each(['noteId', 'title', 'body', 'created', 'rowVersion'] as const)('rejects a payload without %s', (field) => {
    const payload: Record<string, unknown> = { ...notePayload() };
    delete payload[field];
    expect(payloadErrors(payload)).toEqual([`/ must have required property '${field}'`]);
  });

  it.each([
    { label: 'a lowercase noteId', field: 'noteId', value: 'a1b2c3d4-e5f6-0718-293a4b5c6d7e8f90', error: '/noteId must match pattern' },
    { label: 'an RFC 4122 noteId', field: 'noteId', value: '0f9c3a52-8d4e-4b6a-9e21-5c7d3b1a8f60', error: '/noteId must match pattern' },
    { label: 'an ISO 8601 created', field: 'created', value: '2026-11-10T08:57:16.524Z', error: '/created must match pattern' },
    { label: 'an empty title', field: 'title', value: '', error: '/title must NOT have fewer than 1 characters' },
    { label: 'rowVersion 0', field: 'rowVersion', value: 0, error: '/rowVersion must be >= 1' },
    { label: 'an unknown property', field: 'extra', value: true, error: '/ must NOT have additional properties (extra)' },
  ])('rejects a payload with $label', ({ field, value, error }) => {
    const errors = payloadErrors({ ...notePayload(), [field]: value });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(error);
  });

  it('accepts the payload of a valid note envelope on the note topic', () => {
    const payload = notePayload();
    const envelope = buildEnvelope({
      topic: NOTE_CREATED_TOPIC,
      aggregateType: parseTopic(NOTE_CREATED_TOPIC).entity,
      aggregateId: payload.noteId,
      aggregateVersion: payload.rowVersion,
      payload,
      tenantId: tenantIdForSite('default'),
    });
    expect(envelope).toMatchObject({ eventType: 'stub.note.created', schemaVersion: '1.0.0', producer: 'stub' });
    expect(validateEnvelope(envelope).ok).toBe(true);
    expect(noteCreatedValidator.validatePayload(envelope.payload).ok).toBe(true);
  });
});
