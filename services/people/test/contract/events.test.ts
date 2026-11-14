/** Contract suite of the events people produces: `people.person.changed.v1` and `people.person.archived.v1`. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_ATTRIBUTE_KEYS,
  compileTopicSchema,
  createPublisher,
  decodeEnvelopeData,
  envelopeAttributes,
  eventTypeOf,
  readTopicSchema,
  schemaVersionOf,
  topicMeta,
  type EventEnvelope,
  type PublisherOptions,
  type RawMessage,
} from '@opt2/platform/events';
import {
  ContractAssertionError,
  TENANT_A,
  TENANT_UMBRELLA,
  assertEventMatches,
  assertProducerConsumerCompatible,
  testEnvelope,
  withoutTenant,
  type PublishedEvent,
} from '@opt2/platform/testing';
import { personArchivedPayload, personChangedPayload } from '../../src/events/publish.js';
import {
  PEOPLE_TOPICS,
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  peoplePayloadValidators,
  personArchivedSchema,
  personChangedSchema,
  type PeopleTopic,
} from '../../src/events/topics.js';
import { PERSON_COLUMNS, type PersonRow } from '../../src/repo/tables.js';
import { PG_AVAILABLE, userHeaders, withPgApp, type PgTestApp } from '../helpers/app.js';
import {
  ARCHIVE_EFFECTIVE_FROM,
  ARCHIVE_PERSON,
  DEFAULT_PEOPLE_SEED,
  MODULE_008_ONLY_PERSON,
  SITE_ADMIN_A,
  SITE_ADMIN_A_PERSON,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountsForSeed,
  personArchiveRow,
  personRow,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';

type Schema = Record<string, unknown>;

const PIN = JSON.parse(readFileSync(new URL('../../../../opt2/source-pin.json', import.meta.url), 'utf8')) as { sha: string };
const CHANGED: Schema = readTopicSchema(new URL('../../contracts/events/people.person.changed.v1.json', import.meta.url));
const ARCHIVED: Schema = readTopicSchema(new URL('../../contracts/events/people.person.archived.v1.json', import.meta.url));
const SCHEMAS: Readonly<Record<PeopleTopic, Schema>> = { [PERSON_CHANGED_TOPIC]: CHANGED, [PERSON_ARCHIVED_TOPIC]: ARCHIVED };

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

// The capturing publisher keeps outbox publishes as envelopes only, so the Pub/Sub message is taken from the platform publisher.
/** Publishes `envelope` through the platform publisher with people's payload validators and returns the message handed to Pub/Sub. */
async function wireMessage(topic: string, envelope: EventEnvelope): Promise<RawMessage> {
  const sent: RawMessage[] = [];
  const client = {
    topic: () => ({
      publishMessage: (message: RawMessage) => Promise.resolve(String(sent.push(message))),
      resumePublishing: () => undefined,
      flush: () => Promise.resolve(),
    }),
    close: () => Promise.resolve(),
  };
  const publisher = createPublisher({
    projectId: 'opt2-people-contract',
    pubsub: client as unknown as NonNullable<PublisherOptions['pubsub']>,
    payloadValidators: new Map(Object.entries(peoplePayloadValidators)),
  });
  await publisher.publish(topic, envelope);
  await publisher.close();
  const [message, ...rest] = sent;
  expect(rest).toEqual([]);
  if (message === undefined) throw new Error(`Nothing was published for ${topic}`);
  return message;
}

/** Asserts the Pub/Sub form of `envelope`: mirrored attributes, ordering by aggregate and the envelope as data. */
async function expectWireForm(topic: string, envelope: EventEnvelope): Promise<void> {
  const attributes = envelopeAttributes(envelope);
  expect(Object.keys(attributes).sort()).toEqual([...ENVELOPE_ATTRIBUTE_KEYS].sort());
  expect(attributes).toStrictEqual({
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    schemaVersion: envelope.schemaVersion,
    tenantId: envelope.tenantId,
    aggregateVersion: String(envelope.aggregateVersion),
    traceparent: envelope.traceparent,
  });
  const message = await wireMessage(topic, envelope);
  expect(message.attributes).toStrictEqual(attributes);
  expect(message.orderingKey).toBe(envelope.aggregateId);
  expect(decodeEnvelopeData(message.data)).toStrictEqual(envelope);
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

  it('provides what the timesheets blackout consumer reads, as a user-pool fan-out process topic', () => {
    expect(() =>
      assertProducerConsumerCompatible(ARCHIVED, { required: ['personId', 'siteId', 'effectiveFrom'], kind: 'process', fanout: 'userPool' }),
    ).not.toThrow();
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

const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const;
const ARCHIVE_URL = `/legacy-fixtures/cfml/api.cfm/people/persons/${ARCHIVE_PERSON.userid}/archive`;
/** Expiry of every posted CSRF pair: an hour after business noon, `yyMMddHHnnsslll`. */
const CSRF_EXPIRES = '260630130000000';
const ROSTER_TARGET = MODULE_008_ONLY_PERSON;

let csrfSequence = 0;

/** A fresh CSRF pair; the identity double consumes each token once. */
function csrfFields(): Record<string, string> {
  csrfSequence += 1;
  return { csrf_token: `CONTRACT-TOKEN-${String(csrfSequence)}`, csrf_token_expires: CSRF_EXPIRES };
}

/** The people app over the fixed people seed, with identity holding each seeded person's account. */
async function seeded(ctx: PgTestApp): Promise<PgTestApp> {
  await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
  ctx.identity.seedAccounts(...accountsForSeed(DEFAULT_PEOPLE_SEED));
  return ctx;
}

/** Posts `fields` as `actor` and returns what the outbox published while the request ran; the request must answer 200. */
async function publishedBy(ctx: PgTestApp, actor: TestActor, url: string, fields: Record<string, string>): Promise<PublishedEvent[]> {
  ctx.publisher.clear();
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    headers: { ...(await userHeaders(actor)), ...FORM },
    payload: new URLSearchParams({ ...fields, ...csrfFields() }).toString(),
  });
  expect(res.statusCode, res.body.slice(0, 500)).toBe(200);
  return [...ctx.publisher.published];
}

/** The roster edit of `ROSTER_TARGET` renaming them to `lname`, as the Edit User form posts it. */
function rosterEdit(lname: string): Record<string, string> {
  return {
    userid: ROSTER_TARGET.userid,
    siteid: TENANT_A.siteId,
    type: '2',
    action: 'Update',
    fname: ROSTER_TARGET.fname ?? '',
    lname,
    email: ROSTER_TARGET.email ?? '',
    username: (ROSTER_TARGET.email ?? '').split('@')[0] ?? '',
    ispublic: '0',
  };
}

/** Asserts the single envelope of `topic` a request published for `userId` in `tenantId`, and returns it. */
async function onlyPersonEnvelope(published: readonly PublishedEvent[], topic: PeopleTopic, tenantId: string, userId: string): Promise<EventEnvelope> {
  expect(published.map((event) => event.topic)).toEqual([topic]);
  const [{ envelope }] = published as [PublishedEvent];
  expect(assertEventMatches(undefined, SCHEMAS[topic], envelope)).toBe(envelope);
  expect(envelope).toMatchObject({ producer: 'people', aggregateType: 'person', aggregateId: userId, tenantId });
  await expectWireForm(topic, envelope);
  return envelope;
}

// Gated on PG_AVAILABLE, resolved at import: platform pgAvailable() is async and throws when a PG_* variable is unset.
describe.skipIf(!PG_AVAILABLE)('published envelopes', () => {
  it('consecutive roster saves of one person publish people.person.changed.v1 at consecutive versions', async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const first = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, '/v1/users:update', rosterEdit('Saved')),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        ROSTER_TARGET.userid,
      );
      const second = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, '/v1/users:update', rosterEdit('Saved Again')),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        ROSTER_TARGET.userid,
      );

      expect(first.payload).toMatchObject({ userId: ROSTER_TARGET.userid, siteId: TENANT_A.siteId, lname: 'Saved', deleted: false });
      expect(second.payload).toMatchObject({ lname: 'Saved Again', deleted: false });
      expect(second.aggregateVersion).toBe(first.aggregateVersion + 1);
    });
  });

  it("a profile update publishes the session user's people.person.changed.v1", async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const fields = {
        siteid: TENANT_A.siteId,
        fname: SYSTEM_USER_A_PERSON.fname ?? '',
        lname: 'Profiled',
        email: SYSTEM_USER_A_PERSON.email ?? '',
        jobtitle: 'Lead Analyst',
      };
      const envelope = await onlyPersonEnvelope(
        await publishedBy(ctx, SYSTEM_USER_A, '/v1/profile:update', fields),
        PERSON_CHANGED_TOPIC,
        TENANT_A.tenantId,
        SYSTEM_USER_A_PERSON.userid,
      );

      expect(envelope.payload).toMatchObject({ userId: SYSTEM_USER_A_PERSON.userid, lname: 'Profiled', jobTitle: 'Lead Analyst', deleted: false });
    });
  });

  it('archiving a pooled person publishes one people.person.archived.v1 in the umbrella tenant and no person change', async () => {
    await withPgApp(async (app) => {
      const ctx = await seeded(app);
      const envelope = await onlyPersonEnvelope(
        await publishedBy(ctx, SITE_ADMIN_A, ARCHIVE_URL, { effectiveFrom: ARCHIVE_EFFECTIVE_FROM }),
        PERSON_ARCHIVED_TOPIC,
        TENANT_UMBRELLA.tenantId,
        ARCHIVE_PERSON.userid,
      );

      expect(envelope.payload).toMatchObject({
        personId: ARCHIVE_PERSON.userid,
        siteId: TENANT_UMBRELLA.siteId,
        effectiveFrom: `${ARCHIVE_EFFECTIVE_FROM} 00:00:00.000`,
      });
    });
  });
});
