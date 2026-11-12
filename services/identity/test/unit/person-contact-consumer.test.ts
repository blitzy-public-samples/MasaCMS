/** Identity's `people.person.changed.v1` consumer over a fake repository: its declarations, the producer's schema, its tenant check, and the person-contact upsert or delete. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { compileTopicSchema, subscriptionName, topicMeta, type ConsumeContext, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, testEnvelope } from '@opt2/platform/testing';
import {
  PERSON_AGGREGATE_TYPE,
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

const REGISTERED_SITES: ReadonlyMap<string, string> = new Map([
  [TENANT_A.siteId, TENANT_A.tenantId],
  [TENANT_B.siteId, TENANT_B.tenantId],
]);

/** An open `tenantId` transaction whose `query` answers only the site and tenant registry reads, from REGISTERED_SITES. */
function registryTx(tenantId: string): { tx: TenantTx; query: Mock } {
  const query = vi.fn();
  query.mockImplementation((sql: string, params: readonly unknown[] = []) => {
    const [value] = params;
    const sites = [...REGISTERED_SITES];
    if (/WHERE lower\(site_id\) = lower\(\$1\)$/.test(sql)) {
      const found = sites.find(([site]) => site.toLowerCase() === String(value).toLowerCase());
      return Promise.resolve({ rows: found === undefined ? [] : [{ tenant_id: found[1] }] });
    }
    if (/WHERE tenant_id = \$1$/.test(sql)) {
      const found = sites.find(([, tenant]) => tenant === value);
      return Promise.resolve({ rows: found === undefined ? [] : [{ site_id: found[0], tenant_id: found[1], aggregate_version: '1' }] });
    }
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  });
  return { tx: { kind: 'tenant', tenantId, schema: 'identity', query, onCommit: vi.fn() }, query };
}

type TenantCheckCase = [label: string, payload: Partial<PersonChangedPayload>, aggregateType: string, tenantId: string, verdict: boolean | 'invalid-tenant'];

const TENANT_CHECK_CASES: TenantCheckCase[] = [
  ['the registered site and person aggregate of the destination', {}, PERSON_AGGREGATE_TYPE, TENANT_A.tenantId, true],
  ['the site and user id in another letter case', { siteId: 'TENANT-A', userId: USER_ID.toLowerCase() }, PERSON_AGGREGATE_TYPE, TENANT_A.tenantId, true],
  ['the site of another registered tenant', { siteId: TENANT_B.siteId }, PERSON_AGGREGATE_TYPE, TENANT_A.tenantId, false],
  ['an unregistered site', { siteId: 'identity-unregistered-site' }, PERSON_AGGREGATE_TYPE, TENANT_A.tenantId, false],
  ['a user id other than the aggregate id', { userId: 'B1B2C3D4-E5F6-0718-293A4B5C6D7E8F90' }, PERSON_AGGREGATE_TYPE, TENANT_A.tenantId, false],
  ['an aggregate type other than person', {}, 'group', TENANT_A.tenantId, false],
  ['an unregistered destination tenant', { siteId: TENANT_A.siteId }, PERSON_AGGREGATE_TYPE, tenantIdForSite('identity-unregistered-site'), 'invalid-tenant'],
];

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

  it('consumes the topic as a state topic without fan-out or supersedes, as its schema declares, under its own tenant check', () => {
    const consumer = personContactConsumer(fakeRepository().repository);

    expect(Object.keys(consumer).sort()).toEqual(['apply', 'checkTenant', 'kind', 'topic']);
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

describe('personContactConsumer checkTenant', () => {
  it.each(TENANT_CHECK_CASES.flatMap(([label, ...rest]) => [false, true].map((deleted): [string, boolean, ...typeof rest] => [label, deleted, ...rest])))(
    'judges %s (deleted: %s) from the registry alone',
    async (_case, deleted, overrides, aggregateType, tenantId, verdict) => {
      const { repository, calls } = fakeRepository();
      const { tx, query } = registryTx(tenantId);
      const envelope = testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId, aggregateId: USER_ID, aggregateType, payload: person({ ...overrides, deleted }) });

      expect(await personContactConsumer(repository).checkTenant?.(tx, envelope)).toBe(verdict);
      expect(calls).toEqual([]);
      expect(query).toHaveBeenCalled();
    },
  );
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
