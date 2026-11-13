// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The person-archived consumer against a throwaway `timesheets` schema: person and site bound to the envelope tenant across the user-pool fan-out, and dead letters that write no blackout or receipt, directly and through the push route. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeadLetterError, consumeEnvelope, registerConsumers, type DestinationResult, type EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  businessClock,
  createCapturingPublisher,
  createThrowawaySchema,
  pgAvailable,
  pushTo,
  seedRegistry,
  testEnvelope,
  testVerifier,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PERSON_ARCHIVED_SUBSCRIPTION, createConsumers } from '../../src/events/consumers.js';
import { PERSON_ARCHIVED_TOPIC, createPersonArchivedConsumer } from '../../src/events/person-archived.js';
import type { PersonArchivedPayload } from '../../src/generated/events/people.person.archived.v1.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS } from '../../src/repo/tables.js';

const LOGGER = createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', level: 'silent' });
const UNREGISTERED_TENANT = tenantIdForSite('timesheets-unregistered-site');
const HOLDER = 'person-archived-tenant-test';

let fixtureIds = 0;

/** The next 35-character CF UUID of a fixed sequence. */
function nextId(): string {
  fixtureIds += 1;
  return `C0000000-0000-0000-${String(fixtureIds).padStart(16, '0')}`;
}

/** How a delivery departs from the archive people would publish for the seeded person. */
interface Delivery {
  tenant: string;
  siteId: string;
  /** The envelope aggregate names another person than the payload. */
  otherAggregate?: boolean;
  aggregateType?: string;
}

type Expected = ReadonlyArray<[TenantFixture, DestinationResult]>;

const available = await pgAvailable();

describe.skipIf(!available)('person-archived consumer tenant binding', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let messages = 0;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'timesheets', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: HOLDER, allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: HOLDER, state: 'open' });
    await seedRegistry(handle.app);
    repository = createTimesheetsRepository({ clock: businessClock(), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** One open day of `personId` on or after the archive date in every seeded tenant; returns the day id per tenant. */
  async function seedOpenDays(personId: string): Promise<Map<string, string>> {
    const dayIds = new Map<string, string>();
    for (const tenant of TENANT_LIST) {
      const timesheetId = nextId();
      const dayId = nextId();
      await handle.app.withTenant(tenant.tenantId, async (tx) => {
        await repository.insert(tx, 'timesheet', {
          timesheet_id: timesheetId,
          person_id: personId,
          siteid: tenant.siteId,
          period_start: new Date(2026, 4, 25),
          period_end: new Date(2026, 5, 7),
          due_date: new Date(2026, 5, 10),
          created: new Date(2026, 4, 25, 9),
          lastupdate: null,
          lastupdatebyid: null,
          legacy_program_id: 1,
        });
        await repository.insert(tx, 'timesheet_day', {
          day_id: dayId,
          timesheet_id: timesheetId,
          work_date: new Date(2026, 5, 2),
          hours: '7.5000',
          state: 'DRAFT',
          lastupdate: null,
          lastupdatebyid: null,
          legacy_program_id: 1,
        });
      });
      dayIds.set(tenant.tenantId, dayId);
    }
    return dayIds;
  }

  function archive(personId: string, { tenant, siteId, otherAggregate = false, aggregateType }: Delivery): EventEnvelope<PersonArchivedPayload> {
    return testEnvelope({
      topic: PERSON_ARCHIVED_TOPIC,
      tenantId: tenant,
      aggregateId: otherAggregate ? nextId() : personId,
      ...(aggregateType === undefined ? {} : { aggregateType }),
      payload: { personId, siteId, effectiveFrom: '2026-06-01 00:00:00.000', archiveId: nextId(), archivedAt: '2026-06-30 12:00:00.000' },
    });
  }

  function consume(envelope: EventEnvelope<PersonArchivedPayload>) {
    messages += 1;
    return consumeEnvelope(handle.app, createPersonArchivedConsumer({ repository }), envelope, {
      subscription: PERSON_ARCHIVED_SUBSCRIPTION,
      messageId: String(messages),
      logger: LOGGER,
    });
  }

  /** Blackout rows on the seeded day of each tenant, in TENANT_LIST order. */
  function blackoutCounts(dayIds: ReadonlyMap<string, string>): Promise<number[]> {
    return Promise.all(
      TENANT_LIST.map((tenant) =>
        handle.app.withTenant(tenant.tenantId, async (tx) => (await repository.blackoutsOfDays(tx, [dayIds.get(tenant.tenantId) ?? ''])).length),
      ),
    );
  }

  /** Inbox receipts of `eventId` in each seeded tenant and the unregistered one, in TENANT_LIST order. */
  function receiptCounts(eventId: string): Promise<number[]> {
    return Promise.all(
      [...TENANT_LIST.map((tenant) => tenant.tenantId), UNREGISTERED_TENANT].map((tenantId) =>
        handle.app.withTenant(tenantId, async (tx) => {
          const { rows } = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.inbox WHERE event_id = $1`, [eventId]);
          return Number(rows[0]?.n);
        }),
      ),
    );
  }

  /** 1 for each tenant of `applied` and 0 for the others, in TENANT_LIST order. */
  function onlyIn(applied: readonly TenantFixture[]): number[] {
    return TENANT_LIST.map((tenant) => (applied.includes(tenant) ? 1 : 0));
  }

  const umbrellaFanout: Expected = [
    [TENANT_A, 'applied'],
    [TENANT_UMBRELLA, 'applied'],
  ];

  it.each<[string, Delivery, Expected]>([
    ['an umbrella archive as stored', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId }, umbrellaFanout],
    ['an umbrella archive with the site in another letter case', { tenant: TENANT_UMBRELLA.tenantId, siteId: 'UMBRELLA' }, umbrellaFanout],
    ['an umbrella archive with trailing spaces on the site', { tenant: TENANT_UMBRELLA.tenantId, siteId: `${TENANT_UMBRELLA.siteId}  ` }, umbrellaFanout],
    ['an umbrella archive under an upper-case envelope tenant', { tenant: TENANT_UMBRELLA.tenantId.toUpperCase(), siteId: TENANT_UMBRELLA.siteId }, umbrellaFanout],
    ['a tenant-a private-pool archive', { tenant: TENANT_A.tenantId, siteId: TENANT_A.siteId }, [[TENANT_A, 'applied']]],
    ['a self-pooled tenant-b archive', { tenant: TENANT_B.tenantId, siteId: TENANT_B.siteId }, [[TENANT_B, 'applied']]],
  ])('applies %s in the envelope tenant and its user-pool members only', async (_case, delivery, expected) => {
    const personId = nextId();
    const dayIds = await seedOpenDays(personId);
    const envelope = archive(personId, delivery);

    const outcome = await consume(envelope);

    expect(outcome.destinations).toStrictEqual(expected.map(([tenant, result]) => ({ tenantId: tenant.tenantId, result })));
    const applied = expected.map(([tenant]) => tenant);
    expect(await blackoutCounts(dayIds)).toStrictEqual(onlyIn(applied));
    expect(await receiptCounts(envelope.eventId)).toStrictEqual([...onlyIn(applied), 0]);
  });

  it('answers a repeated delivery of a fanned-out archive as a duplicate in every destination, adding nothing', async () => {
    const personId = nextId();
    const dayIds = await seedOpenDays(personId);
    const envelope = archive(personId, { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId });
    await consume(envelope);

    const repeat = await consume(envelope);

    expect(repeat.destinations).toStrictEqual([
      { tenantId: TENANT_A.tenantId, result: 'duplicate' },
      { tenantId: TENANT_UMBRELLA.tenantId, result: 'duplicate' },
    ]);
    expect(await blackoutCounts(dayIds)).toStrictEqual(onlyIn([TENANT_A, TENANT_UMBRELLA]));
    expect(await receiptCounts(envelope.eventId)).toStrictEqual([...onlyIn([TENANT_A, TENANT_UMBRELLA]), 0]);
  });

  it.each<[string, 'tenant-mismatch' | 'invalid-tenant', Delivery]>([
    ['the tenant-a site under the umbrella envelope', 'tenant-mismatch', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_A.siteId }],
    ['the umbrella site under the tenant-b envelope', 'tenant-mismatch', { tenant: TENANT_B.tenantId, siteId: TENANT_UMBRELLA.siteId }],
    ['an unregistered site under the umbrella envelope', 'tenant-mismatch', { tenant: TENANT_UMBRELLA.tenantId, siteId: 'timesheets-unregistered-site' }],
    ['the umbrella site with a leading space', 'tenant-mismatch', { tenant: TENANT_UMBRELLA.tenantId, siteId: ` ${TENANT_UMBRELLA.siteId}` }],
    ['an aggregate id other than the person', 'tenant-mismatch', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, otherAggregate: true }],
    ['an aggregate type other than person', 'tenant-mismatch', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, aggregateType: 'group' }],
    ['an unregistered envelope tenant', 'invalid-tenant', { tenant: UNREGISTERED_TENANT, siteId: TENANT_UMBRELLA.siteId }],
  ])('dead-letters %s as %s before any destination writes a blackout or receipt', async (_case, reason, delivery) => {
    const personId = nextId();
    const dayIds = await seedOpenDays(personId);
    const envelope = archive(personId, delivery);

    const failure = await consume(envelope).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DeadLetterError);
    expect(failure).toMatchObject({ reason });
    expect(await blackoutCounts(dayIds)).toStrictEqual([0, 0, 0]);
    expect(await receiptCounts(envelope.eventId)).toStrictEqual([0, 0, 0, 0]);
  });

  describe('through the push route', () => {
    const publisher = createCapturingPublisher();
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await createService({
        name: 'timesheets',
        version: '1.0.0',
        env: loadEnv(undefined, {
          PORT: '8118',
          OPT2_SERVICE_NAME: 'timesheets',
          OPT2_ENV: 'local',
          OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
          OPT2_TOKEN_ISSUER: 'opt2-local-identity',
          OPT2_TOKEN_AUDIENCE: 'opt2-local',
          TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        verifierOverride: testVerifier('timesheets'),
        pool: handle.app,
        logger: createLogger({ service: 'timesheets', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      });
      registerConsumers(app, { service: 'timesheets', consumers: createConsumers({ repository }), publisher });
      await app.ready();
    });

    afterAll(async () => {
      await app?.opt2.shutdown();
    });

    beforeEach(() => {
      publisher.clear();
    });

    it.each<[string, Delivery, 'tenant-mismatch' | null, readonly TenantFixture[]]>([
      ['a fanned-out umbrella archive is applied', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId }, null, [TENANT_A, TENANT_UMBRELLA]],
      ['a tenant-a site under the umbrella envelope is dead-lettered', { tenant: TENANT_UMBRELLA.tenantId, siteId: TENANT_A.siteId }, 'tenant-mismatch', []],
      ['the umbrella site under the tenant-b envelope is dead-lettered', { tenant: TENANT_B.tenantId, siteId: TENANT_UMBRELLA.siteId }, 'tenant-mismatch', []],
    ])('acks with 204: %s', async (_case, delivery, reason, applied) => {
      const personId = nextId();
      const dayIds = await seedOpenDays(personId);
      const envelope = archive(personId, delivery);

      const response = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

      expect(response.statusCode).toBe(204);
      expect(publisher.deadLetters(PERSON_ARCHIVED_SUBSCRIPTION).map((letter) => letter.reason)).toStrictEqual(reason === null ? [] : [reason]);
      expect(await blackoutCounts(dayIds)).toStrictEqual(onlyIn(applied));
      expect(await receiptCounts(envelope.eventId)).toStrictEqual([...onlyIn(applied), 0]);
    });
  });
});
