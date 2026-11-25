/** Contract suite of the events people produces: `people.person.changed.v1` and `people.person.archived.v1`. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileTopicSchema, eventTypeOf, schemaVersionOf, topicMeta, type EventEnvelope } from '@opt2/platform/events';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  testEnvelope,
  withoutTenant,
} from '@opt2/platform/testing';
import { personArchivedPayload, personChangedPayload } from '../../src/events/publish.js';
import {
  PEOPLE_TOPICS,
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  peoplePayloadValidators,
  personArchivedSchema,
  personChangedSchema,
} from '../../src/events/topics.js';
import { PERSON_COLUMNS, type PersonRow } from '../../src/repo/tables.js';
import { ARCHIVED, CHANGED, SCHEMAS, expectWireForm, type Schema } from '../helpers/event-contract.js';
import { ARCHIVE_PERSON, SITE_ADMIN_A_PERSON, SYSTEM_USER_A_PERSON, personArchiveRow, personRow } from '../helpers/fixtures.js';

const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };

/** Payload keys that carry no person column. */
const NON_COLUMN_KEYS: ReadonlySet<string> = new Set(['userId', 'siteId', 'deleted']);
/** What identity's `identity.person_contact` consumer reads from `people.person.changed.v1`. */
const PERSON_CONTACT_FIELDS = ['userId', 'siteId', 'email', 'fname', 'lname', 'company', 'subType', 'deleted'];
const ARCHIVE_KEYS = ['personId', 'archiveId', 'siteId', 'effectiveFrom', 'archivedAt'];

/** A person whose every people-owned column is null. */
const NULL_PERSON: PersonRow = personRow(Object.fromEntries(PERSON_COLUMNS.map((column) => [column, null])) as Partial<PersonRow>);
/** A person whose every people-owned column holds a value. */
const FULL_PERSON: PersonRow = personRow({
  groupname: 'Legacy Group Name',
  company: 'OPT-2 Test Company',
  jobtitle: 'Analyst',
  mobilephone: '555-0100',
  website: 'https://tenant-a.opt2.test',
  ext: 42,
  contactform: 'phone',
  lastupdatebyid: SITE_ADMIN_A_PERSON.userid,
  subscribe: 1,
  notes: 'Notes',
  description: 'Description',
  interests: 'Interests',
  keepprivate: 1,
  photofileid: SYSTEM_USER_A_PERSON.userid,
  imname: 'opt2.im',
  imservice: 'IRC',
  tags: 'alpha,beta',
});

const PERSON_CASES = [
  { name: 'a saved person', row: personRow(), deleted: false },
  { name: 'a deleted person', row: personRow(), deleted: true },
  { name: 'a person whose every nullable column is null', row: NULL_PERSON, deleted: false },
  { name: 'a person whose every column holds a value', row: FULL_PERSON, deleted: false },
];

/** `people.person.changed.v1` of `row` in tenant-a's envelope. */
function changedEnvelope(row: PersonRow, deleted = false): EventEnvelope {
  const payload = personChangedPayload(row, { deleted });
  return testEnvelope({
    topic: PERSON_CHANGED_TOPIC,
    tenantId: TENANT_A.tenantId,
    aggregateId: row.userid,
    aggregateVersion: Number(row.row_version),
    payload,
    aggregateType: 'person',
  });
}

/** The archive of the pooled person, in the umbrella tenant that stores them. */
const POOLED_ARCHIVE = personArchiveRow({ person_id: ARCHIVE_PERSON.userid, siteid: TENANT_UMBRELLA.siteId });

/** `people.person.archived.v1` of `POOLED_ARCHIVE`, with `payload` in place of its built payload when given. */
function archivedEnvelope(payload: unknown = personArchivedPayload(POOLED_ARCHIVE)): EventEnvelope {
  return testEnvelope({
    topic: PERSON_ARCHIVED_TOPIC,
    tenantId: TENANT_UMBRELLA.tenantId,
    aggregateId: POOLED_ARCHIVE.person_id,
    payload,
    aggregateType: 'person',
  });
}

describe('schema declarations', () => {
  it.each(Object.entries(SCHEMAS))('%s compiles and records the pinned source SHA', (_topic, schema) => {
    expect(() => compileTopicSchema(schema)).not.toThrow();
    expect(schema.$comment).toBe(`source-sha: ${PIN.sha}`);
  });

  it('people.person.changed.v1 is a state topic without tenant fan-out', () => {
    expect(topicMeta(CHANGED)).toStrictEqual({ kind: 'state' });
    expect(CHANGED['x-opt2-kind']).toBe('state');
    expect(CHANGED).not.toHaveProperty(['x-opt2-tenant-fanout']);
  });

  it('people.person.archived.v1 is a process topic fanned out over user pools', () => {
    expect(topicMeta(ARCHIVED)).toStrictEqual({ kind: 'process', fanout: 'userPool' });
    expect(ARCHIVED['x-opt2-kind']).toBe('process');
    expect(ARCHIVED['x-opt2-tenant-fanout']).toBe('userPool');
  });

  it('the schemas topics.ts loads are the contract files', () => {
    expect(personChangedSchema).toStrictEqual(CHANGED);
    expect(personArchivedSchema).toStrictEqual(ARCHIVED);
  });

  it('registers one runtime payload validator per produced topic, each compiled from its contract', () => {
    expect([...PEOPLE_TOPICS].sort()).toEqual(['people.person.archived.v1', 'people.person.changed.v1']);
    expect(Object.keys(peoplePayloadValidators).sort()).toEqual([...PEOPLE_TOPICS].sort());
    for (const topic of PEOPLE_TOPICS) {
      expect(peoplePayloadValidators[topic]?.schemaId).toBe(SCHEMAS[topic].$id);
      expect(peoplePayloadValidators[topic]?.meta).toStrictEqual(topicMeta(SCHEMAS[topic]));
    }
  });
});

describe('people.person.changed.v1 payloads personChangedPayload builds', () => {
  const validator = compileTopicSchema(CHANGED);

  it.each(PERSON_CASES)('$name passes the payload schema and the envelope contract', ({ row, deleted }) => {
    const envelope = changedEnvelope(row, deleted);
    const result = validator.validatePayload(envelope.payload);

    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(assertEventMatches(undefined, CHANGED, envelope)).toBe(envelope);
    expect(envelope).toMatchObject({
      eventType: eventTypeOf(PERSON_CHANGED_TOPIC),
      schemaVersion: schemaVersionOf(PERSON_CHANGED_TOPIC),
      producer: 'people',
      aggregateType: 'person',
      aggregateId: row.userid,
      payload: { userId: row.userid, siteId: row.siteid, deleted },
    });
  });

  it.each(PERSON_CASES)("$name carries identity's contact fields as own properties, null included", ({ row, deleted }) => {
    const payload = personChangedPayload(row, { deleted });
    for (const field of ['email', 'fname', 'lname'] as const) {
      expect(Object.hasOwn(payload, field), field).toBe(true);
      expect(payload[field]).toBe(row[field]);
    }
  });

  it("provides every field identity's person-contact consumer reads, as a state topic", () => {
    expect(() => assertProducerConsumerCompatible(CHANGED, { required: PERSON_CONTACT_FIELDS, kind: 'state' })).not.toThrow();
  });

  it('maps the 24 people-owned person columns one to one, beside userId, siteId and deleted', () => {
    const keys = Object.keys(personChangedPayload(FULL_PERSON, { deleted: false }));
    const columns = keys.filter((key) => !NON_COLUMN_KEYS.has(key)).map((key) => key.toLowerCase());

    expect(PERSON_COLUMNS).toHaveLength(24);
    expect(columns.sort()).toEqual([...PERSON_COLUMNS].sort());
    expect(keys.filter((key) => NON_COLUMN_KEYS.has(key)).sort()).toEqual([...NON_COLUMN_KEYS].sort());
    expect(Object.keys(CHANGED.properties as Schema).sort()).toEqual([...keys].sort());
  });

  it('publishes with the mirrored attributes, ordered by the person id', async () => {
    await expectWireForm(PERSON_CHANGED_TOPIC, changedEnvelope(FULL_PERSON));
  });
});

describe('people.person.archived.v1 payloads personArchivedPayload builds', () => {
  const payload = personArchivedPayload(POOLED_ARCHIVE);

  it('a pooled person archive passes the contract in the umbrella tenant', () => {
    const envelope = archivedEnvelope(payload);

    expect(assertEventMatches(undefined, ARCHIVED, envelope)).toBe(envelope);
    expect(envelope).toMatchObject({
      eventType: eventTypeOf(PERSON_ARCHIVED_TOPIC),
      schemaVersion: schemaVersionOf(PERSON_ARCHIVED_TOPIC),
      tenantId: TENANT_UMBRELLA.tenantId,
      producer: 'people',
      aggregateType: 'person',
      aggregateId: ARCHIVE_PERSON.userid,
    });
    expect(payload).toMatchObject({ personId: ARCHIVE_PERSON.userid, archiveId: POOLED_ARCHIVE.archive_id, siteId: TENANT_UMBRELLA.siteId });
  });

  it('carries exactly the archive fields and names no destination tenant', () => {
    expect(Object.keys(payload).sort()).toEqual([...ARCHIVE_KEYS].sort());
    expect(Object.keys(ARCHIVED.properties as Schema).sort()).toEqual([...ARCHIVE_KEYS].sort());
    expect(Object.keys(payload).filter((key) => /tenant/i.test(key))).toEqual([]);
    expect(Object.values(payload)).not.toContain(TENANT_A.tenantId);
    expect(Object.values(payload)).not.toContain(TENANT_UMBRELLA.tenantId);
  });

  it('publishes with the mirrored attributes, ordered by the person id', async () => {
    await expectWireForm(PERSON_ARCHIVED_TOPIC, archivedEnvelope(payload));
  });
});

describe('contract violations', () => {
  const changed = changedEnvelope(FULL_PERSON);
  const { email: _email, ...withoutEmail } = personChangedPayload(FULL_PERSON, { deleted: false });

  it.each([
    { name: 'a person envelope without tenantId', schema: CHANGED, envelope: withoutTenant(changed) },
    { name: 'an archive envelope without tenantId', schema: ARCHIVED, envelope: withoutTenant(archivedEnvelope()) },
    { name: 'a person payload with an extra key', schema: CHANGED, envelope: { ...changed, payload: { ...changed.payload as object, Email: 'x@opt2.test' } } },
    { name: 'a person payload without email', schema: CHANGED, envelope: { ...changed, payload: withoutEmail } },
    {
      name: 'an archive payload naming a destination tenant',
      schema: ARCHIVED,
      envelope: archivedEnvelope({ ...personArchivedPayload(POOLED_ARCHIVE), tenantId: TENANT_A.tenantId }),
    },
    { name: 'an archive payload with a null effectiveFrom', schema: ARCHIVED, envelope: archivedEnvelope({ ...personArchivedPayload(POOLED_ARCHIVE), effectiveFrom: null }) },
  ])('$name is rejected', ({ schema, envelope }) => {
    expect(() => assertEventMatches(undefined, schema, envelope)).toThrow(ContractAssertionError);
  });
});
