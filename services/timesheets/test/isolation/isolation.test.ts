// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the timesheets schema, its sheet routes and its person-archive fan-out against PostgreSQL. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, INBOX_TABLE, dlqTopicName } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  asOf,
  defineIsolationSuite,
  expectPlatformTables,
  isAck,
  pushTo,
  testEnvelope,
  withoutTenant,
  type InjectResponse,
  type PlatformTableGroup,
  type TenantFixture,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { PERSON_ARCHIVED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { PERSON_ARCHIVED_TOPIC } from '../../src/events/person-archived.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { APPROVAL_ACTION, BLACKOUT, TIMESHEET, TIMESHEET_DAY, tables } from '../../src/repo/tables.js';
import { BUSINESS_DATE, TEST_CLOCK, buildTestApp, createTimesheetsSchema, describeWithPg, headersFor, type TestApp } from '../helpers/app.js';
import {
  EFFECTIVE_FROM,
  SHARED_PERSON_ID,
  TENANT_SEEDS,
  approvalActionRow,
  blackoutRow,
  dayRow,
  seedSheet,
  timesheetRow,
  type TenantSeed,
} from '../helpers/days.js';

type Row = Record<string, unknown>;

// Timesheets has no scheduled_task_queue, so the tasks group is not expected.
const PLATFORM_GROUPS: readonly PlatformTableGroup[] = ['tenancy', 'migrationKit', 'events', 'outbox'];
const SEEDS: readonly TenantSeed[] = [TENANT_SEEDS.a, TENANT_SEEDS.b, TENANT_SEEDS.umbrella];
const V1_SHEETS = '/v1/timesheets/sheets';
const FIXTURE_SHEETS = '/legacy-fixtures/cfml/api.cfm/timesheets/sheets';
// Lists every sheet of the tenant on both the /v1 and the fixture route.
const READER = 'timesheets.primary-approver';
const NOT_FOUND_BODY = { apiversion: 'v1', method: 'timesheets.sheets', error: { code: 'invalid_request', message: 'Not Found' } };
const ARCHIVE_EFFECTIVE_FROM = `${EFFECTIVE_FROM} 00:00:00.000`;
const ARCHIVED_AT = `${BUSINESS_DATE} 12:00:00.000`;

let handle: ThrowawaySchema | undefined;
let repository: TimesheetsRepository | undefined;
let service: TestApp<TenantDb> | undefined;

/** What the outer beforeAll built; throws when building it failed. */
function built(): { handle: ThrowawaySchema; repository: TimesheetsRepository; service: TestApp<TenantDb> } {
  if (handle === undefined || repository === undefined || service === undefined) {
    throw new Error('The throwaway timesheets schema or app was not built; see the beforeAll failure');
  }
  return { handle, repository, service };
}

/** `"<throwaway schema>"."<table>"`. */
function qualified(table: string): string {
  return `"${built().handle.schema}"."${table}"`;
}

/** A fresh row of the unit table `table` for `tenant`, of a person no seed set uses, so archives of the shared person never touch it. */
function rowFor(table: string, tenant: TenantFixture): Row {
  const sheet = timesheetRow({ tenant });
  const day = dayRow(sheet, { workDate: EFFECTIVE_FROM, state: 'SUBMITTED' });
  switch (table) {
    case TIMESHEET.table:
      return sheet;
    case TIMESHEET_DAY.table:
      return day;
    case APPROVAL_ACTION.table:
      return approvalActionRow(day, { action: 'submit', role: 'timesheets.employee', from: 'DRAFT', to: 'SUBMITTED', actor: sheet.person_id });
    case BLACKOUT.table:
      return blackoutRow(day, { archiveId: cfUuid(), personId: sheet.person_id });
    default:
      throw new TypeError(`timesheets has no unit table ${table}`);
  }
}

/** Writes a fresh row of `table` for `tenant` through the timesheets repository, so its unit gate and changelog hooks run. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  await built().repository.insert(tx, table, rowFor(table, tenant));
}

/** Every row of `table` visible in `tx`; RLS is the only filter. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** Sorted values of the single column `column` of `sql`, run under `tenant`'s RLS. */
async function columnIn(tenant: TenantFixture, column: string, sql: string, values: unknown[] = []): Promise<string[]> {
  const { rows } = await withTenant(built().handle.app, tenant.tenantId, (tx) => tx.query<Row>(sql, values));
  return rows.map((row) => String(row[column])).sort();
}

/** Row count of `sql`, run under `tenant`'s RLS. */
async function countIn(tenant: TenantFixture, sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await withTenant(built().handle.app, tenant.tenantId, (tx) => tx.query<{ n: number }>(sql, values));
  return rows[0]?.n ?? 0;
}

describeWithPg('timesheets tenant isolation', () => {
  beforeAll(async () => {
    handle = await createTimesheetsSchema();
    const repo = createTimesheetsRepository({ clock: TEST_CLOCK, schema: handle.schema });
    repository = repo;
    for (const { tenant, sheet } of SEEDS) {
      await withTenant(handle.app, tenant.tenantId, async (tx) => {
        await repo.insert(tx, TIMESHEET.table, sheet.sheet);
        for (const day of sheet.days) await repo.insert(tx, TIMESHEET_DAY.table, day);
      });
    }
    service = await buildTestApp({ db: handle.app });
  });

  afterAll(async () => {
    try {
      await service?.app.close();
    } finally {
      // drop() ends every pool the schema opened, then removes the schema and its roles.
      await handle?.drop();
    }
  });

  it('platform tables present with expected tenancy', async () => {
    await expectPlatformTables(built().handle, { groups: PLATFORM_GROUPS });
  });

  // The shared suite also asserts the catalog: forced RLS with USING and WITH CHECK on every tenant table, inbox, outbox and
  // changelog included, and no schema role that is or inherits SUPERUSER or BYPASSRLS.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => handle,
      name: 'timesheets unit tables',
      tables: tables.map(({ table }) => table),
      writeAs,
      readAs,
      rowFor,
    },
  );

  describe('sheet routes, tenant from the token only', () => {
    /** Sheet and day ids stored under `tenant`, read under its RLS. */
    async function storedIds(tenant: TenantFixture): Promise<{ sheets: string[]; days: string[] }> {
      return {
        sheets: await columnIn(tenant, 'timesheet_id', `SELECT timesheet_id FROM ${qualified(TIMESHEET.table)}`),
        days: await columnIn(tenant, 'day_id', `SELECT day_id FROM ${qualified(TIMESHEET_DAY.table)}`),
      };
    }

    /** GETs `path` with `query` as a primary approver of `tenant`'s site. */
    async function get(path: string, tenant: TenantFixture, query: Record<string, string>): Promise<InjectResponse> {
      const headers = await headersFor(READER, { site: tenant.siteId });
      return built().service.app.inject({ method: 'GET', url: `${path}?${new URLSearchParams(query).toString()}`, headers });
    }

    /** The whole sheet list of `tenant`'s site on `path`. */
    function list(path: string, tenant: TenantFixture, siteid = tenant.siteId): Promise<InjectResponse> {
      return get(path, tenant, { siteid, asOf: BUSINESS_DATE, itemsPerPage: '1000' });
    }

    function v1Ids(res: InjectResponse): string[] {
      return res.json<{ items: Array<{ timesheetId: string }> }>().items.map((item) => item.timesheetId).sort();
    }

    function fixtureIds(res: InjectResponse): string[] {
      return res.json<{ data: { items: Array<{ timesheet_id: string }> } }>().data.items.map((item) => item.timesheet_id).sort();
    }

    /** Ids stored under `tenant` that occur in `body`. */
    async function leakedFrom(tenant: TenantFixture, body: string): Promise<string[]> {
      const { sheets, days } = await storedIds(tenant);
      return [...sheets, ...days].filter((id) => body.includes(id));
    }

    it('a tenant-a token lists every tenant-a sheet', async () => {
      const own = await storedIds(TENANT_A);
      const v1 = await list(V1_SHEETS, TENANT_A);
      const fixture = await list(FIXTURE_SHEETS, TENANT_A);

      expect(own.sheets).toContain(TENANT_SEEDS.a.sheet.sheet.timesheet_id);
      expect([v1.statusCode, fixture.statusCode]).toEqual([200, 200]);
      expect(v1Ids(v1)).toEqual(own.sheets);
      expect(fixtureIds(fixture)).toEqual(own.sheets);
    });

    it('tenant-b token never sees tenant-a sheets', async () => {
      const own = await storedIds(TENANT_B);
      const v1 = await list(V1_SHEETS, TENANT_B);
      const fixture = await list(FIXTURE_SHEETS, TENANT_B);

      expect(own.sheets).toContain(TENANT_SEEDS.b.sheet.sheet.timesheet_id);
      expect([v1.statusCode, fixture.statusCode]).toEqual([200, 200]);
      expect(v1Ids(v1)).toEqual(own.sheets);
      expect(v1.json<{ total: number }>().total).toBe(own.sheets.length);
      expect(fixtureIds(fixture)).toEqual(own.sheets);
      expect(await leakedFrom(TENANT_A, v1.body), 'tenant-a ids in the /v1 list').toEqual([]);
      expect(await leakedFrom(TENANT_A, fixture.body), 'tenant-a ids in the fixture list').toEqual([]);
    });

    it('tenant-b token cannot read a tenant-a sheet by id', async () => {
      const foreign = await get(`${V1_SHEETS}/${TENANT_SEEDS.a.sheet.sheet.timesheet_id}`, TENANT_B, { asOf: BUSINESS_DATE });
      const missing = await get(`${V1_SHEETS}/${cfUuid()}`, TENANT_B, { asOf: BUSINESS_DATE });

      expect([foreign.statusCode, foreign.json()]).toEqual([404, NOT_FOUND_BODY]);
      expect([missing.statusCode, missing.json()]).toEqual([404, NOT_FOUND_BODY]);
      expect(await leakedFrom(TENANT_A, foreign.body)).toEqual([]);
    });

    it.each([V1_SHEETS, FIXTURE_SHEETS])('siteid different from the token site answers 403 on %s', async (path) => {
      const res = await list(path, TENANT_B, TENANT_A.siteId);

      expect(res.statusCode).toBe(403);
      expect(res.json()).not.toHaveProperty('data');
      expect(await leakedFrom(TENANT_A, res.body)).toEqual([]);
    });
  });

  describe('people.person.archived.v1 fan-out', () => {
    /** An archive of `personId` by `origin`'s site, published under `origin`'s tenant. */
    function archiveFrom(origin: TenantFixture, personId: string) {
      return testEnvelope({
        topic: PERSON_ARCHIVED_TOPIC,
        tenantId: origin.tenantId,
        aggregateId: personId,
        aggregateVersion: 1,
        payload: {
          personId,
          archiveId: cfUuid(),
          siteId: origin.siteId,
          effectiveFrom: ARCHIVE_EFFECTIVE_FROM,
          archivedAt: ARCHIVED_AT,
        },
      });
    }

    function push(envelope: TenantlessEnvelope): Promise<InjectResponse> {
      return pushTo(built().service.app, PERSON_ARCHIVED_SUBSCRIPTION, envelope);
    }

    function receipts(tenant: TenantFixture, eventId: string): Promise<number> {
      return countIn(tenant, `SELECT count(*)::int AS n FROM ${qualified(INBOX_TABLE)} WHERE event_id = $1`, [eventId]);
    }

    /** Day ids of `personId`'s blackouts in `tenant`. */
    function blackedOutDays(tenant: TenantFixture, personId: string): Promise<string[]> {
      return columnIn(tenant, 'day_id', `SELECT day_id FROM ${qualified(BLACKOUT.table)} WHERE person_id = $1`, [personId]);
    }

    /** Seeds a fresh person's sheet, shaped like the tenant seed sets, in every seeded tenant; returns the person and each tenant's sorted open-day ids. */
    async function seedFreshPerson(): Promise<{ personId: string; tenants: Array<{ tenant: TenantFixture; openDays: string[] }> }> {
      const personId = cfUuid();
      const tenants: Array<{ tenant: TenantFixture; openDays: string[] }> = [];
      for (const { tenant } of SEEDS) {
        const { sheet, days } = seedSheet(tenant, {
          personId,
          states: ['DRAFT', 'DRAFT', 'SUBMITTED', 'RETURNED'],
          workDates: ['2026-06-12', EFFECTIVE_FROM, '2026-06-16', '2026-06-17'],
        });
        await withTenant(built().handle.app, tenant.tenantId, async (tx) => {
          await built().repository.insert(tx, TIMESHEET.table, sheet);
          for (const day of days) await built().repository.insert(tx, TIMESHEET_DAY.table, day);
        });
        const openDays = days.filter((day) => asOf(day.work_date) >= EFFECTIVE_FROM).map((day) => day.day_id).sort();
        tenants.push({ tenant, openDays });
      }
      return { personId, tenants };
    }

    /** Inbox and blackout row counts of every seeded tenant, keyed by tenant. */
    async function rowCounts(): Promise<Record<string, { inbox: number; blackout: number }>> {
      const counts: Record<string, { inbox: number; blackout: number }> = {};
      for (const { tenant } of SEEDS) {
        counts[tenant.key] = {
          inbox: await countIn(tenant, `SELECT count(*)::int AS n FROM ${qualified(INBOX_TABLE)}`),
          blackout: await countIn(tenant, `SELECT count(*)::int AS n FROM ${qualified(BLACKOUT.table)}`),
        };
      }
      return counts;
    }

    it('umbrella archive fans out to umbrella and tenant-a only', async () => {
      const { personId, tenants } = await seedFreshPerson();
      const envelope = archiveFrom(TENANT_UMBRELLA, personId);

      const res = await push(envelope);

      expect(isAck(res), `push answered ${String(res.statusCode)}`).toBe(true);
      for (const { tenant, openDays } of tenants) {
        const reached = tenant !== TENANT_B;
        expect(await receipts(tenant, envelope.eventId), `receipts in tenant ${tenant.key}`).toBe(reached ? 1 : 0);
        expect(await blackedOutDays(tenant, personId), `blacked-out days in tenant ${tenant.key}`).toEqual(reached ? openDays : []);
      }
    });

    it('tenant-b archive reaches only tenant-b', async () => {
      const { personId, tenants } = await seedFreshPerson();
      const before = await rowCounts();
      const envelope = archiveFrom(TENANT_B, personId);

      const res = await push(envelope);
      const after = await rowCounts();

      expect(isAck(res), `push answered ${String(res.statusCode)}`).toBe(true);
      for (const { tenant, openDays } of tenants) {
        const reached = tenant === TENANT_B;
        expect(await receipts(tenant, envelope.eventId), `receipts in tenant ${tenant.key}`).toBe(reached ? 1 : 0);
        expect(await blackedOutDays(tenant, personId), `blacked-out days in tenant ${tenant.key}`).toEqual(reached ? openDays : []);
      }
      expect({ A: after.A, umbrella: after.umbrella }).toEqual({ A: before.A, umbrella: before.umbrella });
    });

    it('tenant-less archive event is dead-lettered and writes nothing', async () => {
      const { publisher } = built().service;
      const before = await rowCounts();
      const earlier = publisher.raw.length;

      const res = await push(withoutTenant(archiveFrom(TENANT_UMBRELLA, SHARED_PERSON_ID)));

      expect(isAck(res), `push answered ${String(res.statusCode)}`).toBe(true);
      expect(publisher.raw.slice(earlier).map(({ topic, message }) => ({ topic, reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE] }))).toEqual([
        { topic: dlqTopicName(PERSON_ARCHIVED_SUBSCRIPTION), reason: 'missing-tenant' },
      ]);
      expect(await rowCounts()).toEqual(before);
    });
  });
});
