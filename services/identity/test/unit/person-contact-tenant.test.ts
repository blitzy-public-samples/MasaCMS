/** Identity's person-contact consumer through the platform consumer against a throwaway `identity` schema: the stored person columns, site and aggregate binding to the envelope tenant, and dead letters that leave the projection and inbox unchanged. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeadLetterError, consumeEnvelope, type ConsumerDefinition, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { tenantIdForSite, withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, pgAvailable, seedRegistry, testEnvelope, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  PERSON_AGGREGATE_TYPE,
  PERSON_CHANGED_TOPIC,
  PERSON_CONTACT_SUBSCRIPTION,
  personContactConsumer,
  type PersonChangedPayload,
} from '../../src/events/person-contact.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import type { PersonContactRow } from '../../src/repo/tables.js';

const LOGGER = createLogger({ service: 'identity', version: '1.0.0', env: 'local', level: 'silent' });
const UNREGISTERED_TENANT = tenantIdForSite('identity-unregistered-site');

let fixtureIds = 0;

/** The next 35-character CF UUID of a fixed sequence; its leading hex letter makes the lower-case variant differ. */
function nextId(): string {
  fixtureIds += 1;
  return `C0000000-0000-0000-${String(fixtureIds).padStart(16, '0')}`;
}

/** How a mismatched delivery departs from the person event people would publish for the seeded contact. */
interface Mismatch {
  siteId?: string;
  /** The payload names another seeded person than the envelope aggregate. */
  otherUser?: boolean;
  aggregateType?: string;
}

function person(userId: string, overrides: Partial<PersonChangedPayload> = {}): PersonChangedPayload {
  return {
    userId,
    siteId: TENANT_A.siteId,
    deleted: false,
    groupName: null,
    fname: 'Ada',
    lname: 'Lovelace',
    email: 'ada@example.test',
    company: null,
    jobTitle: null,
    mobilePhone: null,
    website: null,
    subType: 'Default',
    ext: null,
    contactForm: null,
    subscribe: 0,
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

const available = await pgAvailable();

describe.skipIf(!available)('person-contact consumer tenant binding', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let consumer: ConsumerDefinition<PersonChangedPayload>;
  let messages = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ schema: handle.schema });
    consumer = personContactConsumer(repo);
    await seedRegistry(handle.app);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function personEvent(
    aggregateId: string,
    aggregateVersion: number,
    payload: PersonChangedPayload,
    { tenantId = TENANT_A.tenantId, aggregateType = PERSON_AGGREGATE_TYPE }: { tenantId?: string; aggregateType?: string } = {},
  ): EventEnvelope<PersonChangedPayload> {
    return testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId, aggregateId, aggregateType, aggregateVersion, payload });
  }

  function consume(envelope: EventEnvelope<PersonChangedPayload>) {
    messages += 1;
    return consumeEnvelope(handle.app, consumer, envelope, { subscription: PERSON_CONTACT_SUBSCRIPTION, messageId: String(messages), logger: LOGGER });
  }

  function contacts(tenantId: string, userIds: readonly string[]): Promise<Array<PersonContactRow | null>> {
    return withTenant(handle.app, tenantId, (tx) => Promise.all(userIds.map((userId) => repo.findPersonContact(tx, userId))));
  }

  async function receipts(tenantId: string, eventId: string): Promise<number> {
    return withTenant(handle.app, tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.inbox WHERE event_id = $1`, [eventId]);
      return Number(rows[0]?.n);
    });
  }

  it.each([
    ['ids and site as stored', false, TENANT_A.siteId],
    ['the user id and site in another letter case', true, 'TENANT-A'],
    ['the site with trailing spaces', false, `${TENANT_A.siteId}  `],
  ])('applies a person state and its deletion bound to the envelope tenant and aggregate: %s', async (_case, lowerCaseUser, siteId) => {
    const userId = nextId();
    const payloadUserId = lowerCaseUser ? userId.toLowerCase() : userId;

    const upsert = await consume(personEvent(userId, 1, person(payloadUserId, { siteId })));

    expect(upsert.destinations).toStrictEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
    expect(await contacts(TENANT_A.tenantId, [userId])).toMatchObject([{ user_id: payloadUserId, site_id: siteId, email: 'ada@example.test', aggregate_version: '1' }]);

    const deletion = await consume(personEvent(userId, 2, person(payloadUserId, { siteId, deleted: true })));

    expect(deletion.destinations).toStrictEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
    expect(await contacts(TENANT_A.tenantId, [userId])).toStrictEqual([null]);
  });

  it('stores every person column of a state, timestamps at their wall-clock time, and a later state replaces each one', async () => {
    const userId = nextId();
    const photoFileId = nextId();
    const full = person(userId, {
      groupName: 'Unused Group', company: 'Engines', jobTitle: 'Analyst', mobilePhone: '555-0100', website: 'https://ada.example.test', ext: 7,
      contactForm: 'yes', subscribe: 1, notes: 'Notes', description: 'Description', interests: 'Math', keepPrivate: 1, photoFileId,
      imName: 'ada', imService: 'AIM', tags: 'math', created: '2026-06-30 11:59:00.370', lastUpdate: '2026-06-30 12:00:01.005',
    });

    await consume(personEvent(userId, 1, full));

    expect(await contacts(TENANT_A.tenantId, [userId])).toMatchObject([
      {
        groupname: 'Unused Group', company: 'Engines', jobtitle: 'Analyst', mobilephone: '555-0100', website: 'https://ada.example.test', ext: 7,
        contactform: 'yes', subscribe: 1, notes: 'Notes', description: 'Description', interests: 'Math', keepprivate: 1, photofileid: photoFileId,
        imname: 'ada', imservice: 'AIM', tags: 'math', created: new Date(2026, 5, 30, 11, 59, 0, 370), lastupdate: new Date(2026, 5, 30, 12, 0, 1, 5),
        lastupdateby: 'Admin User', lastupdatebyid: 'A0000000-0000-0000-0000000000000001', aggregate_version: '1',
      },
    ]);

    const cleared = person(userId, { jobTitle: null, ext: null, subscribe: null, keepPrivate: null, photoFileId: null, created: null, lastUpdate: null, lastUpdateBy: null });
    await consume(personEvent(userId, 2, cleared));

    expect(await contacts(TENANT_A.tenantId, [userId])).toMatchObject([
      { company: null, jobtitle: null, ext: null, subscribe: null, keepprivate: null, photofileid: null, created: null, lastupdate: null, lastupdateby: null, aggregate_version: '2' },
    ]);
  });

  it.each(
    (
      [
        ['a site of another tenant', { siteId: TENANT_B.siteId }],
        ['an unregistered site', { siteId: 'identity-unregistered-site' }],
        ['the site with a leading space', { siteId: ` ${TENANT_A.siteId}` }],
        ['a user id other than the aggregate id', { otherUser: true }],
        ['an aggregate type other than person', { aggregateType: 'group' }],
      ] satisfies Array<[string, Mismatch]>
    ).flatMap(([label, mismatch]) => [false, true].map((deleted): [string, boolean, Mismatch] => [label, deleted, mismatch])),
  )('dead-letters %s (deleted: %s) as tenant-mismatch, leaving the contacts and inbox unchanged', async (_case, deleted, mismatch) => {
    const aggregateId = nextId();
    const otherUserId = nextId();
    await consume(personEvent(aggregateId, 1, person(aggregateId)));
    await consume(personEvent(otherUserId, 1, person(otherUserId)));
    const before = await contacts(TENANT_A.tenantId, [aggregateId, otherUserId]);
    const payload = person(mismatch.otherUser === true ? otherUserId : aggregateId, {
      siteId: mismatch.siteId ?? TENANT_A.siteId,
      email: 'mallory@example.test',
      deleted,
    });
    const envelope = personEvent(aggregateId, 2, payload, { aggregateType: mismatch.aggregateType ?? PERSON_AGGREGATE_TYPE });

    const failure = await consume(envelope).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason: 'tenant-mismatch' });
    expect(before.every((row) => row !== null)).toBe(true);
    expect(await contacts(TENANT_A.tenantId, [aggregateId, otherUserId])).toStrictEqual(before);
    expect(await contacts(TENANT_B.tenantId, [aggregateId, otherUserId])).toStrictEqual([null, null]);
    expect(await receipts(TENANT_A.tenantId, envelope.eventId)).toBe(0);
  });

  it.each([false, true])('dead-letters a person state (deleted: %s) for an unregistered envelope tenant as invalid-tenant, writing nothing', async (deleted) => {
    const userId = nextId();
    const envelope = personEvent(userId, 1, person(userId, { deleted }), { tenantId: UNREGISTERED_TENANT });

    const failure = await consume(envelope).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason: 'invalid-tenant' });
    expect(await contacts(UNREGISTERED_TENANT, [userId])).toStrictEqual([null]);
    expect(await contacts(TENANT_A.tenantId, [userId])).toStrictEqual([null]);
    expect(await receipts(UNREGISTERED_TENANT, envelope.eventId)).toBe(0);
  });
});
