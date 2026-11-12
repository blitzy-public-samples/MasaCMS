/** Identity's `people.person.changed.v1` consumer over a fake repository: its declarations, the producer's schema, and the person-contact upsert or delete. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { compileTopicSchema, subscriptionName, topicMeta, type ConsumeContext, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, testEnvelope } from '@opt2/platform/testing';
import {
  PERSON_CHANGED_TOPIC,
  PERSON_CONTACT_SUBSCRIPTION,
  personChangedSchema,
  personContactConsumer,
  personContactRegistration,
  type PersonChangedPayload,
} from '../../src/events/person-contact.js';
import type { IdentityRepository, PersonContactInput } from '../../src/repo/repository.js';
import { PERSON_CONTACT } from '../../src/repo/tables.js';

const USER_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const LOGGER = createLogger({ service: 'identity', version: '1.0.0', env: 'local', level: 'silent' });
const PRODUCER_SCHEMA = JSON.parse(
  readFileSync(new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

type RepositoryCall =
  | { method: 'upsertPersonContact'; tx: TenantTx; row: PersonContactInput }
  | { method: 'delete'; tx: TenantTx; table: string; key: Record<string, unknown> };

/** The two person-contact writes of the identity repository, logging each call in order. */
function fakeRepository(): { repository: IdentityRepository; calls: RepositoryCall[] } {
  const calls: RepositoryCall[] = [];
  const writes: Pick<IdentityRepository, 'upsertPersonContact' | 'delete'> = {
    upsertPersonContact(tx, row) {
      calls.push({ method: 'upsertPersonContact', tx, row });
      return Promise.resolve({ ...row, tenant_id: tx.tenantId, aggregate_version: String(row.aggregate_version), updated_at: new Date(0) });
    },
    delete(tx, table, key) {
      calls.push({ method: 'delete', tx, table, key });
      return Promise.resolve(null);
    },
  };
  return { repository: writes as IdentityRepository, calls };
}

/** An open tenant transaction whose raw `query` the consumer must leave unused. */
function tenantTx(): { tx: TenantTx; query: Mock } {
  const query = vi.fn();
  return { tx: { kind: 'tenant', tenantId: TENANT_A.tenantId, schema: 'identity', query, onCommit: vi.fn() }, query };
}

function person(overrides: Partial<PersonChangedPayload> = {}): PersonChangedPayload {
  return {
    userId: USER_ID,
    siteId: TENANT_A.siteId,
    deleted: false,
    groupName: null,
    fname: 'Ada',
    lname: 'Lovelace',
    email: 'Ada.Lovelace@Example.test',
    company: 'Analytical Engines',
    jobTitle: 'Analyst',
    mobilePhone: null,
    website: null,
    subType: 'Default',
    ext: null,
    contactForm: null,
    subscribe: 1,
    notes: null,
    description: null,
    interests: null,
    keepPrivate: 0,
    photoFileId: null,
    imName: null,
    imService: null,
    tags: null,
    created: '2026-06-30 11:59:00.000',
    lastUpdate: '2026-06-30 12:00:00.000',
    lastUpdateBy: 'Admin User',
    lastUpdateById: 'A0000000-0000-0000-0000000000000001',
    ...overrides,
  };
}

function personEnvelope(payload: PersonChangedPayload, aggregateVersion = 1): EventEnvelope<PersonChangedPayload> {
  return testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: payload.userId, aggregateVersion, payload });
}

function consumeContext(): ConsumeContext {
  return { subscription: PERSON_CONTACT_SUBSCRIPTION, messageId: '1', destinationTenantId: TENANT_A.tenantId, isFanout: false, logger: LOGGER };
}

describe('person-contact consumer declarations', () => {
  it('subscribes identity to the person topic as identity.people.person.changed.v1', () => {
    expect(PERSON_CHANGED_TOPIC).toBe('people.person.changed.v1');
    expect(PERSON_CONTACT_SUBSCRIPTION).toBe('identity.people.person.changed.v1');
    expect(PERSON_CONTACT_SUBSCRIPTION).toBe(subscriptionName('identity', PERSON_CHANGED_TOPIC));
  });

  it('reads the payload schema from the people contract unchanged', () => {
    expect(personChangedSchema).toEqual(PRODUCER_SCHEMA);
    expect(personChangedSchema.$id).toBe('urn:opt2:people:event:people.person.changed.v1');
  });

  it('consumes the topic as a state topic without fan-out, supersedes or a tenant check override, as its schema declares', () => {
    const consumer = personContactConsumer(fakeRepository().repository);

    expect(Object.keys(consumer).sort()).toEqual(['apply', 'kind', 'topic']);
    expect(consumer).toMatchObject({ topic: PERSON_CHANGED_TOPIC, kind: 'state' });
    expect({ kind: consumer.kind, fanout: consumer.fanout, supersedes: consumer.supersedes }).toEqual(topicMeta(personChangedSchema));
  });

  it('accepts the full-state person payload the tests deliver', () => {
    const validator = compileTopicSchema<PersonChangedPayload>(personChangedSchema);

    expect(validator.validatePayload(person())).toEqual({ ok: true, value: person() });
    expect(validator.validatePayload(person({ deleted: true, email: null, fname: null, lname: null })).ok).toBe(true);
  });
});

describe('personContactConsumer', () => {
  it('upserts the contact columns of a live person with the envelope version, in the delivery transaction', async () => {
    const { repository, calls } = fakeRepository();
    const { tx, query } = tenantTx();

    await personContactConsumer(repository).apply(tx, personEnvelope(person(), 7), consumeContext());

    expect(calls).toEqual([
      {
        method: 'upsertPersonContact',
        tx,
        row: {
          user_id: USER_ID,
          site_id: TENANT_A.siteId,
          email: 'Ada.Lovelace@Example.test',
          fname: 'Ada',
          lname: 'Lovelace',
          company: 'Analytical Engines',
          subtype: 'Default',
          aggregate_version: 7,
        },
      },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('stores contact values verbatim, padding, case and NULLs included', async () => {
    const { repository, calls } = fakeRepository();
    const payload = person({ email: ' ADA@example.TEST ', fname: 'Ada ', lname: null, company: null, subType: null });

    await personContactConsumer(repository).apply(tenantTx().tx, personEnvelope(payload, 2), consumeContext());

    expect(calls).toMatchObject([
      { method: 'upsertPersonContact', row: { email: ' ADA@example.TEST ', fname: 'Ada ', lname: null, company: null, subtype: null, aggregate_version: 2 } },
    ]);
  });

  it('deletes the contact of a deleted person by user id and upserts nothing', async () => {
    const { repository, calls } = fakeRepository();
    const { tx, query } = tenantTx();

    await personContactConsumer(repository).apply(tx, personEnvelope(person({ deleted: true }), 3), consumeContext());

    expect(calls).toEqual([{ method: 'delete', tx, table: PERSON_CONTACT.table, key: { user_id: USER_ID } }]);
    expect(PERSON_CONTACT.table).toBe('person_contact');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('personContactRegistration', () => {
  it('pairs the consumer with the people payload schema for registerConsumers', () => {
    const registration = personContactRegistration(fakeRepository().repository);

    expect(Object.keys(registration).sort()).toEqual(['consumer', 'payloadSchema']);
    expect(registration.payloadSchema).toBe(personChangedSchema);
    expect(registration.consumer).toMatchObject({ topic: PERSON_CHANGED_TOPIC, kind: 'state' });
  });

  it('binds the consumer to the given repository', async () => {
    const { repository, calls } = fakeRepository();
    const { consumer } = personContactRegistration(repository);

    await consumer.apply(tenantTx().tx, personEnvelope(person(), 1), consumeContext());

    expect(calls.map(({ method }) => method)).toEqual(['upsertPersonContact']);
  });
});
