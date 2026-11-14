// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type DeadLetterReason, type EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, openGates } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  deliverDuplicate,
  deliverOutOfOrder,
  isAck,
  pushTo,
  testEnvelope,
  userPoolFanoutExpectation,
  withoutTenant,
  type CapturingPublisher,
  type TenantFixture,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PERSON_ARCHIVED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { PERSON_ARCHIVED_TOPIC } from '../../src/events/person-archived.js';
import type { PersonArchivedPayload } from '../../src/generated/events/people.person.archived.v1.js';
import { BLACKOUT, TIMESHEET, TIMESHEET_DAY, type BlackoutRow, type TimesheetDayRow } from '../../src/repo/tables.js';
import { buildTestApp, createTimesheetsSchema, describeWithPg, type TestApp } from '../helpers/app.js';
import { EFFECTIVE_FROM, SHARED_PERSON_ID, TENANT_SEEDS, seedSheet, type SeededSheet, type TenantSeed } from '../helpers/days.js';

type ArchiveEnvelope = EventEnvelope<PersonArchivedPayload>;

type BlackoutView = {
  blackout_id: string;
  day_id: string;
  person_id: string;
  archive_id: string;
  reason: string;
  created: string;
  legacy_program_id: number;
};

type ChangeView = { op: string; origin: string; key: string };

type TableColumns = { readonly table: string; readonly columns: readonly { readonly name: string }[] };

const DLQ_TOPIC = 'timesheets.people.person.archived.v1.dlq';
const ARCHIVED_AT = '2026-06-30 12:00:00.000';
const LOCAL_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.MS';
const PERSON_ARCHIVED_REASON = 'person-archived';
const GATE_HOLDER = 'person-archived-gate-test';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

// Rewritten to the throwaway schema with the migrations; a fault row survives the rollback of the insert it fails.
const FAULT_SQL = `
CREATE TABLE timesheets.blackout_fault (tenant_id uuid PRIMARY KEY);
CREATE FUNCTION timesheets.blackout_fault_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM timesheets.blackout_fault f WHERE f.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'injected blackout insert failure for tenant %', NEW.tenant_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER blackout_fault BEFORE INSERT ON timesheets.blackout FOR EACH ROW EXECUTE FUNCTION timesheets.blackout_fault_check();
`;

/** A person.archived envelope of `personId` from `site`'s user pool, effective from local midnight of `effectiveFrom`. */
function archiveEnvelope(site: TenantFixture, personId: string, effectiveFrom = EFFECTIVE_FROM): ArchiveEnvelope {
  return testEnvelope({
    topic: PERSON_ARCHIVED_TOPIC,
    tenantId: site.tenantId,
    aggregateId: personId,
    payload: {
      personId,
      archiveId: cfUuid(),
      siteId: site.siteId,
      effectiveFrom: `${effectiveFrom} 00:00:00.000`,
      archivedAt: ARCHIVED_AT,
    },
  });
}

/** Day ids of `days` in the byte order the blackout readers return them in. */
function dayIds(days: readonly TimesheetDayRow[]): string[] {
  return days.map((day) => day.day_id).sort();
}

/** Day ids of `seed`'s open days from {@link EFFECTIVE_FROM}. */
function openDayIds(seed: TenantSeed): string[] {
  return dayIds(seed.open);
}

describeWithPg('timesheets person.archived consumer', () => {
  let handle: ThrowawaySchema;
  let publisher: CapturingPublisher;
  let app: TestApp['app'];

  const table = (name: string): string => `${handle.schema}.${name}`;

  /** Inserts `rows` of `def` as stored rows, bypassing the repository so seeding writes no changelog. */
  async function insertRows(tx: TenantTx, def: TableColumns, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    if (rows.length === 0) return;
    const names = def.columns.map((column) => column.name);
    const tuples = rows.map((_, row) => `(${names.map((_, column) => `$${String(row * names.length + column + 1)}`).join(', ')})`);
    await tx.query(
      `INSERT INTO ${table(def.table)} (${names.map((name) => `"${name}"`).join(', ')}) VALUES ${tuples.join(', ')}`,
      rows.flatMap((row) => names.map((name) => row[name])),
    );
  }

  /** Stores `seeded`'s sheet, days and blackouts under its tenant. */
  async function storeSheet(seeded: SeededSheet): Promise<void> {
    await handle.app.withTenant(seeded.sheet.tenant_id, async (tx) => {
      await insertRows(tx, TIMESHEET, [seeded.sheet]);
      await insertRows(tx, TIMESHEET_DAY, seeded.days);
      await insertRows(tx, BLACKOUT, seeded.blackouts);
    });
  }

  /** Blackouts of `personId` in `tenant` by day id, `created` as local `timestamp(3)` text. */
  async function blackoutsOf(tenant: TenantFixture, personId: string): Promise<BlackoutView[]> {
    const { rows } = await handle.app.withTenant(tenant.tenantId, (tx) =>
      tx.query<BlackoutView>(
        'SELECT blackout_id, day_id, person_id, archive_id, reason, to_char(created, $2) AS created, legacy_program_id' +
          ` FROM ${table('blackout')} WHERE person_id = $1 ORDER BY day_id COLLATE "C"`,
        [personId, LOCAL_TIMESTAMP_FORMAT],
      ),
    );
    return rows;
  }

  /** Statuses of `tenant`'s inbox receipts for `eventId`. */
  async function receipts(tenant: TenantFixture, eventId: string): Promise<string[]> {
    const { rows } = await handle.app.withTenant(tenant.tenantId, (tx) =>
      tx.query<{ status: string }>(`SELECT status FROM ${table('inbox')} WHERE event_id = $1`, [eventId]),
    );
    return rows.map((row) => row.status);
  }

  /** `tenant`'s changelog rows of table `blackout`, in sequence order. */
  async function blackoutChanges(tenant: TenantFixture): Promise<ChangeView[]> {
    const { rows } = await handle.app.withTenant(tenant.tenantId, (tx) =>
      tx.query<ChangeView>(`SELECT op, origin, key FROM ${table('changelog')} WHERE "table" = $1 ORDER BY seq`, [BLACKOUT.table]),
    );
    return rows;
  }

  /** Makes every later blackout insert of `tenant` raise until the next reset. */
  async function failBlackoutsOf(tenant: TenantFixture): Promise<void> {
    await handle.adminPool.query(`INSERT INTO ${table('blackout_fault')} (tenant_id) VALUES ($1)`, [tenant.tenantId]);
  }

  /** Dead letters as topic, `reason` attribute and the event id inside the forwarded message bytes. */
  function deadLetters(): Array<{ topic: string; reason: string | undefined; eventId: unknown }> {
    return publisher.raw.map(({ topic, message }) => ({
      topic,
      reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE],
      eventId: (JSON.parse(message.data.toString('utf8')) as { eventId?: unknown }).eventId,
    }));
  }

  beforeAll(async () => {
    handle = await createTimesheetsSchema({ extraSql: [FAULT_SQL] });
    for (const seed of Object.values(TENANT_SEEDS)) await storeSheet(seed.sheet);
    publisher = createCapturingPublisher();
    ({ app } = await buildTestApp({ db: handle.app, publisher }));
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await handle?.drop();
    }
  });

  beforeEach(async () => {
    publisher.clear();
    await openGates(handle.app, { units: [BLACKOUT.unit], holderId: GATE_HOLDER });
    await handle.adminPool.query(
      `TRUNCATE ${['blackout', 'inbox', 'changelog', 'consumer_aggregate_version', 'blackout_fault'].map(table).join(', ')}`,
    );
  });

  it('applies an umbrella archive delivered three times once in umbrella and in tenant-a, whose public user pool it is', async () => {
    const envelope = archiveEnvelope(TENANT_UMBRELLA, SHARED_PERSON_ID);

    const responses = await deliverDuplicate(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope, 3);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204, 204]);
    for (const seed of [TENANT_SEEDS.a, TENANT_SEEDS.umbrella]) {
      const rows = await blackoutsOf(seed.tenant, SHARED_PERSON_ID);
      expect(rows.map((row) => row.day_id)).toStrictEqual(openDayIds(seed));
      expect(rows.map((row) => row.archive_id)).toStrictEqual(seed.open.map(() => envelope.payload.archiveId));
      expect(await receipts(seed.tenant, envelope.eventId)).toStrictEqual(['applied']);
    }
    expect(publisher.published).toStrictEqual([]);
    expect(publisher.raw).toStrictEqual([]);
  });

  it("fans out only to the tenants the registry pools to the envelope tenant, leaving tenant-b's days of the same person untouched", async () => {
    const envelope = archiveEnvelope(TENANT_UMBRELLA, SHARED_PERSON_ID);

    const res = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    const reached: string[] = [];
    for (const tenant of TENANT_LIST) {
      if ((await receipts(tenant, envelope.eventId)).length > 0) reached.push(tenant.tenantId);
    }
    expect(new Set(reached)).toStrictEqual(userPoolFanoutExpectation(TENANT_UMBRELLA));
    expect(reached).not.toContain(TENANT_B.tenantId);
    expect(await blackoutsOf(TENANT_B, SHARED_PERSON_ID)).toStrictEqual([]);
    expect(await blackoutChanges(TENANT_B)).toStrictEqual([]);
  });

  it('redelivers a fan-out interrupted at its second destination whole, adding nothing where it had already committed', async () => {
    const envelope = archiveEnvelope(TENANT_UMBRELLA, SHARED_PERSON_ID);
    // Fan-out destinations are applied before the envelope tenant, so tenant-a commits before umbrella fails.
    await failBlackoutsOf(TENANT_UMBRELLA);

    const interrupted = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(isAck(interrupted)).toBe(false);
    const committed = await blackoutsOf(TENANT_A, SHARED_PERSON_ID);
    expect(committed.map((row) => row.day_id)).toStrictEqual(openDayIds(TENANT_SEEDS.a));
    expect(await receipts(TENANT_A, envelope.eventId)).toStrictEqual(['applied']);
    expect(await blackoutsOf(TENANT_UMBRELLA, SHARED_PERSON_ID)).toStrictEqual([]);
    expect(await receipts(TENANT_UMBRELLA, envelope.eventId)).toStrictEqual([]);

    await handle.adminPool.query(`DELETE FROM ${table('blackout_fault')}`);
    const redelivered = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(redelivered.statusCode).toBe(204);
    expect(await blackoutsOf(TENANT_A, SHARED_PERSON_ID)).toStrictEqual(committed);
    expect(await blackoutChanges(TENANT_A)).toHaveLength(committed.length);
    expect((await blackoutsOf(TENANT_UMBRELLA, SHARED_PERSON_ID)).map((row) => row.day_id)).toStrictEqual(openDayIds(TENANT_SEEDS.umbrella));
    for (const tenant of [TENANT_A, TENANT_UMBRELLA]) {
      expect(await receipts(tenant, envelope.eventId)).toStrictEqual(['applied']);
    }
    expect(publisher.raw).toStrictEqual([]);
  });

  it('applies the archives of two persons delivered in reverse order, each once', async () => {
    const sheets = [0, 1].map(() =>
      seedSheet(TENANT_B, { personId: cfUuid(), states: ['DRAFT', 'SUBMITTED'], workDates: [EFFECTIVE_FROM, '2026-06-16'] }),
    );
    for (const sheet of sheets) await storeSheet(sheet);
    const envelopes = sheets.map(({ sheet }) => archiveEnvelope(TENANT_B, sheet.person_id));

    const responses = await deliverOutOfOrder(app, PERSON_ARCHIVED_SUBSCRIPTION, envelopes, [1, 0]);

    expect(responses.map((res) => res.statusCode)).toStrictEqual([204, 204]);
    for (const [index, { sheet, days }] of sheets.entries()) {
      const envelope = envelopes[index] as ArchiveEnvelope;
      const rows = await blackoutsOf(TENANT_B, sheet.person_id);
      expect(rows.map((row) => [row.day_id, row.archive_id])).toStrictEqual(dayIds(days).map((dayId) => [dayId, envelope.payload.archiveId]));
      expect(await receipts(TENANT_B, envelope.eventId)).toStrictEqual(['applied']);
    }
  });

  it.each<{ name: string; reason: DeadLetterReason; send: (envelope: ArchiveEnvelope) => TenantlessEnvelope }>([
    {
      name: 'dead-letters an archive without a tenant as missing-tenant',
      reason: 'missing-tenant',
      send: (envelope) => withoutTenant(envelope),
    },
    {
      name: 'dead-letters an archive whose payload lacks effectiveFrom as schema-invalid',
      reason: 'schema-invalid',
      send: ({ payload: { effectiveFrom: _omitted, ...payload }, ...envelope }) => ({ ...envelope, payload }),
    },
    {
      name: 'dead-letters an archive whose payload names a destination site as schema-invalid',
      reason: 'schema-invalid',
      send: (envelope) => ({ ...envelope, payload: { ...envelope.payload, destinationSiteId: TENANT_B.siteId } }),
    },
  ])('$name and acks it, writing no blackout or receipt', async ({ reason, send }) => {
    const envelope = archiveEnvelope(TENANT_UMBRELLA, SHARED_PERSON_ID);

    const res = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, send(envelope));

    expect(res.statusCode).toBe(204);
    expect(dlqTopicName(PERSON_ARCHIVED_SUBSCRIPTION)).toBe(DLQ_TOPIC);
    expect(deadLetters()).toStrictEqual([{ topic: DLQ_TOPIC, reason, eventId: envelope.eventId }]);
    expect(publisher.published).toStrictEqual([]);
    for (const tenant of TENANT_LIST) {
      expect(await blackoutsOf(tenant, SHARED_PERSON_ID)).toStrictEqual([]);
      expect(await receipts(tenant, envelope.eventId)).toStrictEqual([]);
    }
  });

  it('nacks an archive while the blackout gate is closed and applies its redelivery once the gate reopens', async () => {
    const envelope = archiveEnvelope(TENANT_UMBRELLA, SHARED_PERSON_ID);
    await closeGates(handle.app, { units: [BLACKOUT.unit], holderId: GATE_HOLDER });

    const blocked = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(blocked.statusCode).toBe(503);
    for (const tenant of TENANT_LIST) {
      expect(await blackoutsOf(tenant, SHARED_PERSON_ID)).toStrictEqual([]);
      expect(await receipts(tenant, envelope.eventId)).toStrictEqual([]);
    }

    await openGates(handle.app, { units: [BLACKOUT.unit], holderId: GATE_HOLDER });
    const redelivered = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(redelivered.statusCode).toBe(204);
    for (const seed of [TENANT_SEEDS.a, TENANT_SEEDS.umbrella]) {
      expect((await blackoutsOf(seed.tenant, SHARED_PERSON_ID)).map((row) => row.day_id)).toStrictEqual(openDayIds(seed));
      expect(await receipts(seed.tenant, envelope.eventId)).toStrictEqual(['applied']);
    }
  });

  it("blacks out only the archived person's unapproved days from the effective date, keeping a day's earlier blackout", async () => {
    const personId = cfUuid();
    const archived = seedSheet(TENANT_A, {
      personId,
      states: ['DRAFT', 'DRAFT', 'SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'RETURNED', 'APPROVED', 'DRAFT'],
      workDates: ['2026-06-12', EFFECTIVE_FROM, '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21'],
      blackoutDays: [7],
    });
    const other = seedSheet(TENANT_A, { personId: cfUuid(), states: ['DRAFT', 'SUBMITTED'], workDates: [EFFECTIVE_FROM, '2026-06-16'] });
    await storeSheet(archived);
    await storeSheet(other);
    const [earlier] = archived.blackouts as [BlackoutRow];
    const open = [...archived.days.slice(1, 6)].sort((x, y) => (x.day_id < y.day_id ? -1 : 1));
    const envelope = archiveEnvelope(TENANT_A, personId);

    const res = await pushTo(app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    const rows = await blackoutsOf(TENANT_A, personId);
    const kept = rows.filter((row) => row.day_id === earlier.day_id);
    const added = rows.filter((row) => row.day_id !== earlier.day_id);
    expect(kept.map((row) => [row.blackout_id, row.archive_id])).toStrictEqual([[earlier.blackout_id, earlier.archive_id]]);
    expect(added.map(({ blackout_id: _id, ...row }) => row)).toStrictEqual(
      open.map((day) => ({
        day_id: day.day_id,
        person_id: personId,
        archive_id: envelope.payload.archiveId,
        reason: PERSON_ARCHIVED_REASON,
        created: ARCHIVED_AT,
        legacy_program_id: day.legacy_program_id,
      })),
    );
    expect(added.every((row) => CF_UUID.test(row.blackout_id))).toBe(true);
    expect(await blackoutsOf(TENANT_A, other.sheet.person_id)).toStrictEqual([]);
    expect(await blackoutsOf(TENANT_A, SHARED_PERSON_ID)).toStrictEqual([]);
    const changes = await blackoutChanges(TENANT_A);
    expect(changes.map(({ op, origin }) => [op, origin])).toStrictEqual(added.map(() => ['insert', 'target']));
    expect(added.every((row) => changes.some((change) => change.key.includes(row.blackout_id)))).toBe(true);
    expect(await receipts(TENANT_A, envelope.eventId)).toStrictEqual(['applied']);
  });
});
