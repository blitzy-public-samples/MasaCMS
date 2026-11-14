/** Identity's push consumers against a throwaway `identity` schema: the person-contact projection and the tenant registry, through the platform push route. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { subscriptionName, type DeadLetterReason, type EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { SITE_CHANGED_TOPIC, tenantIdForSite, type QueryResultRow, type SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  versionedSequence,
  withoutTenant,
  type CapturedDeadLetter,
  type CapturingPublisher,
  type PushOptions,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { buildTestApp, type TestApp } from '../helpers/app.js';

type ContactRow = {
  user_id: string;
  site_id: string | null;
  email: string | null;
  fname: string | null;
  lname: string | null;
  company: string | null;
  subtype: string | null;
  aggregate_version: string;
};

type RegistryRow = {
  site_id: string;
  tenant_id: string;
  public_user_pool_id: string | null;
  private_user_pool_id: string | null;
  category_pool_id: string | null;
  file_pool_id: string | null;
  display_pool_id: string | null;
  content_pool_ids: string[] | null;
  public_user_pool_tenant: string | null;
  private_user_pool_tenant: string | null;
  category_pool_tenant: string | null;
  file_pool_tenant: string | null;
  display_pool_tenant: string | null;
  content_pool_tenants: string[] | null;
  domains: string[] | null;
  aggregate_version: string;
  updated_at: Date;
};

/** What one delivery left behind across the probed tenants. */
type Traces = { inbox: number; versions: number; contacts: number };

/** A delivery to dead-letter and the push options it is sent with. */
type DeadLetterCase = { envelope: TenantlessEnvelope; options?: PushOptions };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const SITE_SUBSCRIPTION = subscriptionName('identity', SITE_CHANGED_TOPIC);
const PERSON_DLQ_TOPIC = `${PERSON_CONTACT_SUBSCRIPTION}.dlq`;
const UNREGISTERED_TENANT = tenantIdForSite('no-such-site');
const PROBED_TENANTS = [...TENANT_LIST.map((fixture) => fixture.tenantId), UNREGISTERED_TENANT];

// An unset PG_HOST skips the suite without probing the server.
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

/** A full-state person payload of `userId` in tenant-a, as people publishes it. */
function personPayload(userId: string, overrides: Partial<PersonChangedPayload> = {}): PersonChangedPayload {
  return {
    userId,
    siteId: TENANT_A.siteId,
    deleted: false,
    groupName: null,
    fname: 'Grace',
    lname: 'Hopper',
    email: 'grace.hopper@example.test',
    company: 'Navy Computing',
    jobTitle: 'Rear Admiral',
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

/** The person envelope of `payload` at `aggregateVersion` in `tenantId` (tenant-a by default). */
function personEnvelope(payload: PersonChangedPayload, aggregateVersion = 1, tenantId = TENANT_A.tenantId): EventEnvelope<PersonChangedPayload> {
  return testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId, aggregateId: payload.userId, aggregateVersion, payload });
}

/** The `person_contact` columns a stored `payload` at `aggregateVersion` must hold. */
function contactOf(payload: PersonChangedPayload, aggregateVersion: number): ContactRow {
  return {
    user_id: payload.userId,
    site_id: payload.siteId,
    email: payload.email,
    fname: payload.fname,
    lname: payload.lname,
    company: payload.company,
    subtype: payload.subType,
    aggregate_version: String(aggregateVersion),
  };
}

/** A site payload of `siteId` whose pools default to the site itself. */
function sitePayload(siteId: string, overrides: Partial<SiteChangedPayload> = {}): SiteChangedPayload {
  return {
    siteId,
    publicUserPoolId: siteId,
    privateUserPoolId: siteId,
    categoryPoolId: siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId],
    domains: [`${siteId}.opt2.test`],
    ...overrides,
  };
}

/** The site envelope of `payload` at `aggregateVersion`, in the tenant of its site. */
function siteEnvelope(payload: SiteChangedPayload, aggregateVersion = 1): EventEnvelope<SiteChangedPayload> {
  return testEnvelope({ topic: SITE_CHANGED_TOPIC, tenantId: tenantIdForSite(payload.siteId), aggregateId: payload.siteId, aggregateVersion, payload });
}

describe.skipIf(!available)('identity event consumers', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let publisher!: CapturingPublisher;

  /** `<throwaway schema>.<name>`. */
  const table = (name: string): string => `${schema.schema}.${name}`;

  /** Rows of `sql` read through the admin pool under the row-level security of `tenantId`. */
  async function tenantRows<R extends QueryResultRow>(tenantId: string, sql: string, params: unknown[] = []): Promise<R[]> {
    const client = await schema.adminPool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return (await client.query<R>(sql, params)).rows;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  /** Inbox statuses of `eventId` in `tenantId`. */
  function inboxRows(tenantId: string, eventId: string): Promise<Array<{ status: string }>> {
    return tenantRows(tenantId, `SELECT status FROM ${table('inbox')} WHERE event_id = $1`, [eventId]);
  }

  /** The `person_contact` rows of `userId` in `tenantId`. */
  function contactRows(tenantId: string, userId: string): Promise<ContactRow[]> {
    return tenantRows(
      tenantId,
      `SELECT user_id, site_id, email, fname, lname, company, subtype, aggregate_version::text AS aggregate_version
         FROM ${table('person_contact')} WHERE user_id = $1`,
      [userId],
    );
  }

  /** The last applied version of person `aggregateId` on the person subscription in `tenantId`, or undefined without progress. */
  async function lastVersion(tenantId: string, aggregateId: string): Promise<string | null | undefined> {
    const rows = await tenantRows<{ last_version: string | null }>(
      tenantId,
      `SELECT last_version::text AS last_version FROM ${table('consumer_aggregate_version')}
        WHERE subscription = $1 AND aggregate_type = 'person' AND aggregate_id = $2`,
      [PERSON_CONTACT_SUBSCRIPTION, aggregateId],
    );
    return rows[0]?.last_version;
  }

  /** Inbox, version and contact rows that `envelope` left in every probed tenant. */
  async function traces(envelope: TenantlessEnvelope): Promise<Traces> {
    const counted: Traces = { inbox: 0, versions: 0, contacts: 0 };
    for (const tenantId of PROBED_TENANTS) {
      const [row] = await tenantRows<{ inbox: number; versions: number; contacts: number }>(
        tenantId,
        `SELECT (SELECT count(*)::int FROM ${table('inbox')} WHERE event_id = $1) AS inbox,
                (SELECT count(*)::int FROM ${table('consumer_aggregate_version')} WHERE aggregate_id = $2) AS versions,
                (SELECT count(*)::int FROM ${table('person_contact')} WHERE user_id = $3) AS contacts`,
        [envelope.eventId, envelope.aggregateId, envelope.aggregateId],
      );
      counted.inbox += row?.inbox ?? 0;
      counted.versions += row?.versions ?? 0;
      counted.contacts += row?.contacts ?? 0;
    }
    return counted;
  }

  /** Dead letters published on the person subscription's `.dlq` topic. */
  function dlqMessages(): CapturedDeadLetter[] {
    return publisher.deadLetters(PERSON_CONTACT_SUBSCRIPTION);
  }

  /** The `tenant_registry` rows of `siteId`; the registry holds tenant metadata, so it has no row-level security. */
  async function registryRows(siteId: string): Promise<RegistryRow[]> {
    return (await schema.adminPool.query<RegistryRow>(`SELECT * FROM ${table('tenant_registry')} WHERE site_id = $1`, [siteId])).rows;
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app, publisher } = await buildTestApp({ db: schema.app }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  beforeEach(() => {
    publisher.clear();
  });

  describe(`${PERSON_CHANGED_TOPIC} on ${PERSON_CONTACT_SUBSCRIPTION}`, () => {
    it('applies a delivery repeated three times once: one contact row, one inbox receipt and version 1', async () => {
      const payload = personPayload(cfUuid());
      const envelope = personEnvelope(payload, 1);

      const responses = await deliverDuplicate(app, PERSON_CONTACT_SUBSCRIPTION, envelope, 3);

      expect(responses.map((res) => res.statusCode)).toEqual([204, 204, 204]);
      expect(await contactRows(TENANT_A.tenantId, payload.userId)).toEqual([contactOf(payload, 1)]);
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual([{ status: 'applied' }]);
      expect(await lastVersion(TENANT_A.tenantId, payload.userId)).toBe('1');
      expect(dlqMessages()).toEqual([]);
    });

    it('reaches the in-order final state from versions delivered 3, 1, 2, acking the older ones as stale', async () => {
      const userId = cfUuid();
      const base = personEnvelope(personPayload(userId), 1);
      const envelopes = versionedSequence(base, [1, 2, 3], (version) => personPayload(userId, { email: `v${String(version)}.hopper@example.test` }));
      const [v1, v2, v3] = envelopes as [EventEnvelope<PersonChangedPayload>, EventEnvelope<PersonChangedPayload>, EventEnvelope<PersonChangedPayload>];

      const responses = await deliverOutOfOrder(app, PERSON_CONTACT_SUBSCRIPTION, envelopes, [2, 0, 1]);

      expect(responses.map(isAck)).toEqual([true, true, true]);
      expect(await contactRows(TENANT_A.tenantId, userId)).toEqual([contactOf(v3.payload, 3)]);
      expect(await lastVersion(TENANT_A.tenantId, userId)).toBe('3');
      expect(await inboxRows(TENANT_A.tenantId, v3.eventId)).toEqual([{ status: 'applied' }]);
      expect(await inboxRows(TENANT_A.tenantId, v1.eventId)).toEqual([{ status: 'stale' }]);
      expect(await inboxRows(TENANT_A.tenantId, v2.eventId)).toEqual([{ status: 'stale' }]);
    });

    it('applies a later full state across a version gap', async () => {
      const userId = cfUuid();
      const base = personEnvelope(personPayload(userId), 1);
      const [v1, v4] = versionedSequence(base, [1, 4], (version) =>
        personPayload(userId, { fname: `Grace ${String(version)}`, company: version === 4 ? null : 'Navy Computing' }),
      ) as [EventEnvelope<PersonChangedPayload>, EventEnvelope<PersonChangedPayload>];

      expect((await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, v1)).statusCode).toBe(204);
      const res = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, v4);

      expect(res.statusCode).toBe(204);
      expect(await contactRows(TENANT_A.tenantId, userId)).toEqual([contactOf(v4.payload, 4)]);
      expect(await lastVersion(TENANT_A.tenantId, userId)).toBe('4');
      expect(await inboxRows(TENANT_A.tenantId, v4.eventId)).toEqual([{ status: 'applied' }]);
    });

    it('removes the contact of a person whose later state is deleted', async () => {
      const userId = cfUuid();
      const base = personEnvelope(personPayload(userId), 1);
      const [created, deleted] = versionedSequence(base, [1, 2], (version) => personPayload(userId, { deleted: version === 2 })) as [
        EventEnvelope<PersonChangedPayload>,
        EventEnvelope<PersonChangedPayload>,
      ];

      expect((await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, created)).statusCode).toBe(204);
      expect(await contactRows(TENANT_A.tenantId, userId)).toHaveLength(1);
      const res = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, deleted);

      expect(res.statusCode).toBe(204);
      expect(await contactRows(TENANT_A.tenantId, userId)).toEqual([]);
      expect(await lastVersion(TENANT_A.tenantId, userId)).toBe('2');
      expect(await inboxRows(TENANT_A.tenantId, deleted.eventId)).toEqual([{ status: 'applied' }]);
    });

    it('stores a pooled person of the umbrella site in the umbrella tenant only', async () => {
      const payload = personPayload(cfUuid(), { siteId: TENANT_UMBRELLA.siteId });
      const envelope = personEnvelope(payload, 1, TENANT_UMBRELLA.tenantId);

      const res = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, envelope);

      expect(res.statusCode).toBe(204);
      expect(await contactRows(TENANT_UMBRELLA.tenantId, payload.userId)).toEqual([contactOf(payload, 1)]);
      expect(await inboxRows(TENANT_UMBRELLA.tenantId, envelope.eventId)).toEqual([{ status: 'applied' }]);
      for (const member of [TENANT_A, TENANT_B]) {
        expect(await contactRows(member.tenantId, payload.userId)).toEqual([]);
        expect(await inboxRows(member.tenantId, envelope.eventId)).toEqual([]);
      }
    });

    it.each<[string, DeadLetterReason, () => DeadLetterCase]>([
      ['an envelope without a tenant', 'missing-tenant', () => ({ envelope: withoutTenant(personEnvelope(personPayload(cfUuid()))) })],
      ['an envelope of an unregistered tenant', 'invalid-tenant', () => ({ envelope: personEnvelope(personPayload(cfUuid()), 1, UNREGISTERED_TENANT) })],
      [
        'a payload missing a required field',
        'schema-invalid',
        () => {
          const { email: _omitted, ...payload } = personPayload(cfUuid());
          return { envelope: testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: payload.userId, payload }) };
        },
      ],
      [
        'a payload field of the wrong type',
        'schema-invalid',
        () => {
          const payload = { ...personPayload(cfUuid()), deleted: 'no' };
          return { envelope: testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: payload.userId, payload }) };
        },
      ],
      [
        'a tenantId attribute that differs from the envelope tenant',
        'tenant-mismatch',
        () => ({ envelope: personEnvelope(personPayload(cfUuid())), options: { attributes: { tenantId: TENANT_B.tenantId } } }),
      ],
      [
        'a person whose site the registry gives another tenant',
        'tenant-mismatch',
        () => ({ envelope: personEnvelope(personPayload(cfUuid()), 1, TENANT_B.tenantId) }),
      ],
      [
        'a payload user other than the envelope aggregate',
        'tenant-mismatch',
        () => ({ envelope: { ...personEnvelope(personPayload(cfUuid())), aggregateId: cfUuid() } }),
      ],
    ])('dead-letters %s as %s, acks it and applies nothing', async (_case, reason, build) => {
      const { envelope, options } = build();

      const res = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, envelope, options);

      expect(res.statusCode).toBe(204);
      const letters = dlqMessages();
      expect(letters).toHaveLength(1);
      const [letter] = letters as [CapturedDeadLetter];
      expect(letter).toMatchObject({ topic: PERSON_DLQ_TOPIC, reason });
      expect(letter.message.attributes).toMatchObject({ reason, eventId: envelope.eventId });
      expect(JSON.parse(letter.message.data.toString('utf8'))).toEqual(envelope);
      expect(await traces(envelope)).toEqual({ inbox: 0, versions: 0, contacts: 0 });
    });

    it('nacks a delivery whose apply fails, rolling back its receipt, and applies its redelivery once', async () => {
      const payload = personPayload(cfUuid());
      const envelope = personEnvelope(payload, 1);
      const personContact = table('person_contact');
      const appRole = `"${schema.roles.app}"`;

      // buildApp creates the consumer's repository internally, so the failure is injected through the app role's privileges.
      await schema.adminPool.query(`REVOKE INSERT, UPDATE ON ${personContact} FROM ${appRole}`);
      const nacked = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, envelope).finally(() =>
        schema.adminPool.query(`GRANT INSERT, UPDATE ON ${personContact} TO ${appRole}`),
      );

      expect(isAck(nacked)).toBe(false);
      expect(nacked.statusCode).toBe(500);
      expect(await traces(envelope)).toEqual({ inbox: 0, versions: 0, contacts: 0 });
      expect(dlqMessages()).toEqual([]);

      const redelivered = await pushTo(app, PERSON_CONTACT_SUBSCRIPTION, envelope);

      expect(redelivered.statusCode).toBe(204);
      expect(await inboxRows(TENANT_A.tenantId, envelope.eventId)).toEqual([{ status: 'applied' }]);
      expect(await contactRows(TENANT_A.tenantId, payload.userId)).toEqual([contactOf(payload, 1)]);
      expect(await lastVersion(TENANT_A.tenantId, payload.userId)).toBe('1');
      expect(dlqMessages()).toEqual([]);
    });
  });

  describe(`${SITE_CHANGED_TOPIC} on ${SITE_SUBSCRIPTION}`, () => {
    it('registers a new site with its raw pool ids and the pool tenants they resolve to', async () => {
      const siteId = 'tenant-c';
      const tenantId = tenantIdForSite(siteId);
      const payload = sitePayload(siteId, {
        publicUserPoolId: TENANT_UMBRELLA.siteId,
        categoryPoolId: TENANT_UMBRELLA.siteId,
        displayPoolId: TENANT_UMBRELLA.siteId,
        contentPoolIds: [siteId, TENANT_UMBRELLA.siteId],
      });
      const envelope = siteEnvelope(payload, 1);

      const res = await pushTo(app, SITE_SUBSCRIPTION, envelope);

      expect(res.statusCode).toBe(204);
      expect(await registryRows(siteId)).toEqual([
        {
          site_id: siteId,
          tenant_id: tenantId,
          public_user_pool_id: TENANT_UMBRELLA.siteId,
          private_user_pool_id: siteId,
          category_pool_id: TENANT_UMBRELLA.siteId,
          file_pool_id: siteId,
          display_pool_id: TENANT_UMBRELLA.siteId,
          content_pool_ids: [siteId, TENANT_UMBRELLA.siteId],
          public_user_pool_tenant: TENANT_UMBRELLA.tenantId,
          private_user_pool_tenant: tenantId,
          category_pool_tenant: TENANT_UMBRELLA.tenantId,
          file_pool_tenant: tenantId,
          display_pool_tenant: TENANT_UMBRELLA.tenantId,
          content_pool_tenants: [tenantId, TENANT_UMBRELLA.tenantId],
          domains: [`${siteId}.opt2.test`],
          aggregate_version: '1',
          updated_at: expect.any(Date),
        },
      ]);
      expect(await inboxRows(tenantId, envelope.eventId)).toEqual([{ status: 'applied' }]);
    });

    it('updates a registered site in place from a later version and leaves it unchanged by a stale one', async () => {
      const siteId = 'tenant-d';
      const tenantId = tenantIdForSite(siteId);
      const pools: Readonly<Record<number, Partial<SiteChangedPayload>>> = {
        1: {},
        2: { publicUserPoolId: TENANT_UMBRELLA.siteId, privateUserPoolId: TENANT_UMBRELLA.siteId, domains: ['d2.opt2.test'] },
        3: { filePoolId: TENANT_A.siteId, domains: ['d3.opt2.test'] },
      };
      const [v1, v3, stale] = versionedSequence(siteEnvelope(sitePayload(siteId), 1), [1, 3, 2], (version) =>
        sitePayload(siteId, pools[version]),
      ) as [EventEnvelope<SiteChangedPayload>, EventEnvelope<SiteChangedPayload>, EventEnvelope<SiteChangedPayload>];

      expect((await pushTo(app, SITE_SUBSCRIPTION, v1)).statusCode).toBe(204);
      expect(await registryRows(siteId)).toMatchObject([{ public_user_pool_tenant: tenantId, aggregate_version: '1' }]);

      expect((await pushTo(app, SITE_SUBSCRIPTION, v3)).statusCode).toBe(204);
      const updated = await registryRows(siteId);
      expect(updated).toMatchObject([
        {
          tenant_id: tenantId,
          public_user_pool_tenant: tenantId,
          file_pool_id: TENANT_A.siteId,
          file_pool_tenant: TENANT_A.tenantId,
          domains: ['d3.opt2.test'],
          aggregate_version: '3',
        },
      ]);

      const res = await pushTo(app, SITE_SUBSCRIPTION, stale);

      expect(res.statusCode).toBe(204);
      expect(await registryRows(siteId)).toEqual(updated);
      expect(await inboxRows(tenantId, stale.eventId)).toEqual([{ status: 'stale' }]);
    });
  });
});
