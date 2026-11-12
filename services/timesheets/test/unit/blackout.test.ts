// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Archive blackouts as usp_apply_blackout applies them: open-day selection, inserted count, repeat, row values, gates and tenant isolation. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  closeGates,
  ensureUnitGates,
  openGates,
  withGatedTenant,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, businessClock, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { applyBlackout, type BlackoutInput } from '../../src/domain/blackout.js';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type BlackoutRow, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const EFFECTIVE_FROM = new Date(2026, 5, 1);
const SHORT_BUDGET = { budgetMs: 300 };
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

type New<R> = Omit<R, 'tenant_id'>;

function sheet(personId: string, legacyProgramId = 1): New<TimesheetRow> {
  return {
    timesheet_id: cfUuid(),
    person_id: personId,
    siteid: 'tenant-a',
    period_start: new Date(2026, 4, 25),
    period_end: new Date(2026, 5, 7),
    due_date: new Date(2026, 5, 10),
    created: NOW,
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: legacyProgramId,
  };
}

function day(timesheetId: string, workDate: Date, state = 'DRAFT', legacyProgramId = 1): New<TimesheetDayRow> {
  return {
    day_id: cfUuid(),
    timesheet_id: timesheetId,
    work_date: workDate,
    hours: '7.5000',
    state,
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: legacyProgramId,
  };
}

function input(personId: string, archiveId = cfUuid()): BlackoutInput {
  return { personId, effectiveFrom: EFFECTIVE_FROM, archiveId, now: NOW };
}

/** `tx` appending the text of each statement it runs to `seen`. */
function recording(tx: TenantTx, seen: string[]): TenantTx {
  const query = ((text, values) => {
    seen.push(typeof text === 'string' ? text : text.text);
    return tx.query(text, values);
  }) as TenantTx['query'];
  return { ...tx, query };
}

describe('applyBlackout over a stub repository', () => {
  it('inserts one blackout per open day in the repository order in one batch and returns the count inserted', async () => {
    const tx = { kind: 'tenant', tenantId: TENANT_A.tenantId } as unknown as TenantTx;
    const personId = cfUuid();
    const days = [
      { ...day(cfUuid(), EFFECTIVE_FROM, 'DRAFT', 2), tenant_id: TENANT_A.tenantId },
      { ...day(cfUuid(), new Date(2026, 5, 2), 'RETURNED', 1), tenant_id: TENANT_A.tenantId },
    ];
    const openDaysOfPerson = vi.fn(async () => days);
    // One day gets a blackout from a concurrent archive between the read and the insert.
    const insertBlackoutsIfAbsent = vi.fn(async (_tx: TenantTx, rows: readonly New<BlackoutRow>[]) => rows.length - 1);
    const repo = { openDaysOfPerson, insertBlackoutsIfAbsent } as unknown as TimesheetsRepository;
    const given = input(personId);

    await expect(applyBlackout(tx, repo, given)).resolves.toBe(1);
    expect(openDaysOfPerson).toHaveBeenCalledExactlyOnceWith(tx, { personId, effectiveFrom: EFFECTIVE_FROM });
    expect(insertBlackoutsIfAbsent).toHaveBeenCalledExactlyOnceWith(
      tx,
      days.map((d) => ({
        blackout_id: expect.stringMatching(CF_UUID),
        day_id: d.day_id,
        person_id: personId,
        archive_id: given.archiveId,
        reason: 'person-archived',
        created: NOW,
        legacy_program_id: d.legacy_program_id,
      })),
    );
  });

  it('returns 0 for a person without open days', async () => {
    const tx = {} as TenantTx;
    const insertBlackoutsIfAbsent = vi.fn(async () => 0);
    const repo = { openDaysOfPerson: async () => [], insertBlackoutsIfAbsent } as unknown as TimesheetsRepository;
    await expect(applyBlackout(tx, repo, input(cfUuid()))).resolves.toBe(0);
    expect(insertBlackoutsIfAbsent).toHaveBeenCalledExactlyOnceWith(tx, []);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('applyBlackout against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let personId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'timesheets',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, TIMESHEETS_UNITS);
    repository = createTimesheetsRepository({ clock: businessClock(), schema: handle.schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    personId = cfUuid();
  });

  /** Moves every timesheets gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'blackout-test', allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'blackout-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenantId = TENANT_A.tenantId): Promise<T> {
    return handle.app.withTenant(tenantId, fn);
  }

  async function seed(timesheet: New<TimesheetRow>, days: New<TimesheetDayRow>[], tenantId = TENANT_A.tenantId): Promise<void> {
    await inTenant(async (tx) => {
      await repository.insert(tx, 'timesheet', timesheet);
      for (const row of days) await repository.insert(tx, 'timesheet_day', row);
    }, tenantId);
  }

  function blackouts(days: New<TimesheetDayRow>[], tenantId = TENANT_A.tenantId): Promise<BlackoutRow[]> {
    return inTenant((tx) => repository.blackoutsOfDays(tx, days.map((d) => d.day_id)), tenantId);
  }

  it('blacks out each non-approved day on or after effectiveFrom that has none and returns the count', async () => {
    const own = sheet(personId);
    const other = sheet(cfUuid());
    const before = day(own.timesheet_id, new Date(2026, 4, 31, 23, 59, 59, 997));
    const onBoundary = day(own.timesheet_id, EFFECTIVE_FROM);
    const submitted = day(own.timesheet_id, new Date(2026, 5, 2), 'SUBMITTED');
    const returned = day(own.timesheet_id, new Date(2026, 5, 3), 'RETURNED', 2);
    const approved = day(own.timesheet_id, new Date(2026, 5, 4), 'APPROVED');
    const blackedOut = day(own.timesheet_id, new Date(2026, 5, 5));
    const otherPerson = day(other.timesheet_id, new Date(2026, 5, 2));
    await seed(own, [before, onBoundary, submitted, returned, approved, blackedOut]);
    await seed(other, [otherPerson]);
    const earlierArchive = cfUuid();
    await inTenant((tx) => applyBlackout(tx, repository, { ...input(personId, earlierArchive), effectiveFrom: blackedOut.work_date }));

    const given = input(personId);
    await expect(inTenant((tx) => applyBlackout(tx, repository, given))).resolves.toBe(3);

    const expected = (d: New<TimesheetDayRow>, archiveId: string): BlackoutRow => ({
      tenant_id: TENANT_A.tenantId,
      blackout_id: expect.stringMatching(CF_UUID),
      day_id: d.day_id,
      person_id: personId,
      archive_id: archiveId,
      reason: 'person-archived',
      created: NOW,
      legacy_program_id: d.legacy_program_id,
    });
    const rows = await blackouts([before, onBoundary, submitted, returned, approved, blackedOut, otherPerson]);
    expect(rows).toEqual(
      [
        expected(onBoundary, given.archiveId as string),
        expected(submitted, given.archiveId as string),
        expected(returned, given.archiveId as string),
        expected(blackedOut, earlierArchive),
      ].sort((a, b) => (a.day_id < b.day_id ? -1 : 1)),
    );
  });

  it('inserts nothing and writes no changelog row when applied again', async () => {
    const own = sheet(personId);
    const days = [day(own.timesheet_id, EFFECTIVE_FROM), day(own.timesheet_id, new Date(2026, 5, 2), 'PRIMARY_APPROVED')];
    await seed(own, days);
    await expect(inTenant((tx) => applyBlackout(tx, repository, input(personId)))).resolves.toBe(2);

    await inTenant(async (tx) => {
      await expect(applyBlackout(tx, repository, input(personId))).resolves.toBe(0);
      const { rows } = await tx.query(`SELECT 1 FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id()`);
      expect(rows).toEqual([]);
    });
    expect(await blackouts(days)).toHaveLength(2);
  });

  it('blacks out any number of open days with the same statements: one blackout insert and one changelog insert', async () => {
    async function statementsOf(openDays: number): Promise<string[]> {
      const person = cfUuid();
      const own = sheet(person);
      const days = Array.from({ length: openDays + 1 }, (_, i) => day(own.timesheet_id, new Date(2026, 5, 1 + i)));
      await seed(own, days);
      await inTenant((tx) => applyBlackout(tx, repository, { ...input(person), effectiveFrom: (days[openDays] as New<TimesheetDayRow>).work_date }));
      const seen: string[] = [];
      await inTenant(async (tx) => {
        await expect(applyBlackout(recording(tx, seen), repository, input(person))).resolves.toBe(openDays);
        const { rows } = await tx.query(`SELECT op, "table" FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`);
        expect(rows).toEqual(Array.from({ length: openDays }, () => ({ op: 'insert', table: 'blackout' })));
      });
      return seen;
    }

    const few = await statementsOf(2);
    const many = await statementsOf(8);
    expect(many).toHaveLength(few.length);
    expect(many.filter((text) => text.startsWith('INSERT INTO'))).toEqual([
      expect.stringContaining(`."blackout"`),
      expect.stringContaining(`."changelog"`),
    ]);
  });

  it('returns 0 without taking the blackout gate for a person without open days', async () => {
    await closeGates(handle.app, { units: ['timesheets.blackout'], holderId: 'blackout-test' });
    await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => applyBlackout(tx, repository, input(personId)), SHORT_BUDGET)).resolves.toBe(0);
  });

  it('leaves the same person days of another tenant untouched', async () => {
    const inA = sheet(personId);
    const inB = sheet(personId, 2);
    const dayA = day(inA.timesheet_id, EFFECTIVE_FROM);
    const dayB = day(inB.timesheet_id, EFFECTIVE_FROM, 'DRAFT', 2);
    await seed(inA, [dayA]);
    await seed(inB, [dayB], TENANT_B.tenantId);

    await expect(inTenant((tx) => applyBlackout(tx, repository, input(personId)))).resolves.toBe(1);
    expect(await blackouts([dayB], TENANT_B.tenantId)).toEqual([]);
    expect(await blackouts([dayA])).toHaveLength(1);
  });

  it.each<[string, () => Promise<void>, new (...args: never[]) => Error]>([
    ['closed', () => closeGates(handle.app, { units: ['timesheets.blackout'], holderId: 'blackout-test' }).then(() => undefined), GateClosedError],
    ['legacy-authoritative', () => setGates('legacy'), UnitNotAuthoritativeError],
  ])('rejects with the gate error while the blackout unit is %s and inserts nothing', async (_name, gate, expected) => {
    const own = sheet(personId);
    const open = day(own.timesheet_id, EFFECTIVE_FROM);
    await seed(own, [open]);
    await gate();

    await expect(withGatedTenant(handle.app, TENANT_A.tenantId, (tx) => applyBlackout(tx, repository, input(personId)), SHORT_BUDGET)).rejects.toBeInstanceOf(
      expected,
    );
    await setGates('open');
    expect(await blackouts([open])).toEqual([]);
  });
});
