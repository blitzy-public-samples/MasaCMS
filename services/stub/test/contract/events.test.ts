/** Event contracts of the stub: the note topic it produces and consumes, and the site registry topic it consumes. */
import { readFileSync } from 'node:fs';
import { compileTopicSchema, readTopicSchema, topicMeta } from '@opt2/platform/events';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  assertProducerConsumerCompatible,
  registryPayloads,
  testEnvelope,
  withoutTenant,
  type ConsumerExpectation,
  type ContractViolation,
  type JsonType,
} from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { newNote, noteCreatedPayload, type Note } from '../../src/domain/note.js';
import { NOTE_CREATED_TOPIC, noteCreatedSchema, siteChangedSchema } from '../../src/events/topics.js';
import { TEST_CLOCK } from '../helpers/app.js';

const pin = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as {
  sha: string;
};
const noteSchema = readTopicSchema(new URL('../../contracts/events/stub.note.created.v1.json', import.meta.url));
const producerSiteSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);
const note: Note = newNote({ title: 'Contract note', body: 'Body' }, TEST_CLOCK);

/** Every site registry field the stub's registry consumer reads, with the JSON type it relies on. */
const REGISTRY_FIELD_TYPES = {
  siteId: 'string',
  publicUserPoolId: 'string',
  privateUserPoolId: 'string',
  categoryPoolId: 'string',
  filePoolId: 'string',
  displayPoolId: 'string',
  contentPoolIds: 'array',
  domains: 'array',
} as const satisfies Record<string, JsonType>;

/** The element type the registry consumer reads from each list field. */
const REGISTRY_ITEM_TYPES = {
  contentPoolIds: 'string',
  domains: 'string',
} as const satisfies Record<string, JsonType>;

/** The note-created envelope of tenant-a for `payload`, keyed by the note. */
function noteEnvelope<P>(payload: P) {
  return testEnvelope({
    topic: 'stub.note.created.v1',
    tenantId: TENANT_A.tenantId,
    aggregateId: note.noteId,
    aggregateVersion: 1,
    payload,
  });
}

/** The findings of the ContractAssertionError `run` throws; fails the test when it throws nothing or something else. */
function violationsOf(run: () => unknown): ContractViolation[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractAssertionError);
    return (error as ContractAssertionError).errors;
  }
  throw new Error('expected a ContractAssertionError, but nothing was thrown');
}

describe('stub.note.created.v1 schema', () => {
  it('compiles with the platform topic validator and accepts a new note payload', () => {
    const validator = compileTopicSchema(noteSchema);

    expect(validator.schemaId).toBe(noteSchema.$id);
    expect(validator.validatePayload(noteCreatedPayload(note)).ok).toBe(true);
  });

  it('is a state topic without tenant fan-out', () => {
    const meta = topicMeta(noteSchema);

    expect(meta.kind).toBe('state');
    expect(meta.fanout).toBeUndefined();
  });

  it('records the pinned source SHA', () => {
    expect(noteSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('is the contract the service validates notes against', () => {
    expect(NOTE_CREATED_TOPIC).toBe('stub.note.created.v1');
    expect(noteCreatedSchema).toStrictEqual(noteSchema);
  });
});

describe('stub.note.created.v1 envelope', () => {
  const payload = noteCreatedPayload(note);
  const envelope = noteEnvelope(payload);

  it('accepts the envelope of a new note', () => {
    expect(() => assertEventMatches(undefined, noteSchema, envelope)).not.toThrow();
  });

  it('keys the aggregate by the note id and its row version', () => {
    expect(envelope.aggregateId).toBe(payload.noteId);
    expect(payload.rowVersion).toBe(1);
    expect(envelope.aggregateVersion).toBe(payload.rowVersion);
  });

  it('rejects an envelope without a tenant', () => {
    expect(() => assertEventMatches(undefined, noteSchema, withoutTenant(envelope))).toThrow(ContractAssertionError);
  });

  it('rejects a payload with an undeclared property', () => {
    const errors = violationsOf(() => assertEventMatches(undefined, noteSchema, noteEnvelope({ ...payload, extra: 'x' })));

    expect(errors).toContainEqual(
      expect.objectContaining({ instancePath: 'payload', message: expect.stringContaining('(extra)') }),
    );
  });
});

describe('programs-sites.site.changed.v1 consumer', () => {
  const expectation: ConsumerExpectation = {
    required: Object.keys(REGISTRY_FIELD_TYPES),
    types: REGISTRY_FIELD_TYPES,
    itemTypes: REGISTRY_ITEM_TYPES,
    samples: registryPayloads(),
    kind: 'state',
  };

  it('consumes the producer-owned contract', () => {
    expect(siteChangedSchema).toStrictEqual(producerSiteSchema);
  });

  it('records the pinned source SHA', () => {
    expect(producerSiteSchema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('supplies every registry field the consumer reads', () => {
    expect(() => assertProducerConsumerCompatible(siteChangedSchema, expectation)).not.toThrow();
  });

  it('carries the site tenant in the envelope of a registry payload', () => {
    const payload = registryPayloads().find((candidate) => candidate.siteId === TENANT_A.siteId);
    expect(payload).toBeDefined();
    const envelope = testEnvelope({
      topic: 'programs-sites.site.changed.v1',
      tenantId: TENANT_A.tenantId,
      aggregateId: TENANT_A.siteId,
      aggregateVersion: 1,
      payload,
    });

    const accepted = assertEventMatches(undefined, siteChangedSchema, envelope);

    expect(accepted.tenantId).toBe(TENANT_A.tenantId);
    expect(accepted.payload).toStrictEqual(payload);
  });
});
