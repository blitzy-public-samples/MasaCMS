// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheets repository against a throwaway `timesheets` schema: audited helper writes, unit gates, fixture read order, RLS and day locking. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  UnitReadBlockedError,
  closeGates,
  ensureUnitGates,
  openGates,
  withGatedTenant,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { businessClock, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createTimesheetsRepository, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type ApprovalActionRow, type BlackoutRow, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const ACTOR = cfUuid();
const P1 = 'AAAAAAAA-0000-0000-0000000000000001';
const P2 = '00000000-0000-0000-0000000000000002';
const SHORT_BUDGET = { budgetMs: 300 };

type New<R> = Omit<R, 'tenant_id'>;

function sheet(overrides: Partial<TimesheetRow> = {}): New<TimesheetRow> {
  return {
    timesheet_id: cfUuid(),
    person_id: ACTOR,
    siteid: 'tenant-a',
    period_start: new Date(2026, 5, 1),
    period_end: new Date(2026, 5, 7),
    due_date: new Date(2026, 5, 10),
    created: NOW,
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: 1,
    ...overrides,
  };
}

function day(timesheetId: string, overrides: Partial<TimesheetDayRow> = {}): New<TimesheetDayRow> {
  return {
    day_id: cfUuid(),
    timesheet_id: timesheetId,
    work_date: new Date(2026, 5, 1),
    hours: '7.5000',
    state: 'DRAFT',
    lastupdate: null,
    lastupdatebyid: null,
    legacy_program_id: 1,
    ...overrides,
  };
}

function blackout(dayId: string, overrides: Partial<BlackoutRow> = {}): New<BlackoutRow> {
  return { blackout_id: cfUuid(), day_id: dayId, person_id: ACTOR, archive_id: null, reason: 'person-archived', created: NOW, legacy_program_id: 1, ...overrides };
}

function approval(dayId: string): New<ApprovalActionRow> {
  return {
    action_id: cfUuid(),
    day_id: dayId,
    action: 'submit',
    role: 'timesheets.employee',
    from_state: 'DRAFT',
    to_state: 'SUBMITTED',
    actor_user_id: ACTOR,
    comment: null,
    created: NOW,
    legacy_program_id: 1,
  };
}

/** A promise and the function that settles it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => (fire = resolve));
  return { promise, fire };
}

describe('timesheets repository identity', () => {
  it('extends the platform repository of the owned tables on schema timesheets', () => {
    const repository = createTimesheetsRepository();
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'timesheets', schema: 'timesheets' });
    expect(repository.units()).toEqual([...TIMESHEETS_UNITS]);
    expect(createTimesheetsRepository({ schema: 't_timesheets' }).schema).toBe('t_timesheets');
  });

  it('answers no day ids without a query', async () => {
    const tx = { query: () => Promise.reject(new Error('queried')) } as unknown as TenantTx;
    await expect(createTimesheetsRepository().blackoutsOfDays(tx, [])).resolves.toEqual([]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('timesheets repository against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: TimesheetsRepository;
  let tenants = 0;
  let tenantId: string;

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
    tenants += 1;
    tenantId = tenantIdForSite(`timesheets-repository-${tenants}`);
  });

  /** Moves every timesheets gate to `state` through the holder compare-and-set. */
  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'repository-test', allowLegacy: true });
    await openGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'repository-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  /** `op`, `table` and `columns` of the changelog rows the open transaction wrote. */
  async function written(tx: TenantTx): Promise<{ op: string; table: string; columns: string[] }[]> {
    const { rows } = await tx.query<{ op: string; table: string; columns: string[] }>(
      `SELECT op, "table", columns FROM ${handle.schema}.changelog WHERE xid = pg_current_xact_id() ORDER BY seq`,
    );
    return rows;
  }

  function count(sql: string): Promise<number> {
    return inTenant(async (tx) => Number((await tx.query<{ n: string }>(sql.replaceAll('<s>', handle.schema))).rows[0]?.n));
  }

  async function seed(timesheet: New<TimesheetRow>, days: New<TimesheetDayRow>[] = [], tenant = tenantId): Promise<void> {
    await inTenant(async (tx) => {
      await repository.insert(tx, 'timesheet', timesheet);
      for (const row of days) await repository.insert(tx, 'timesheet_day', row);
    }, tenant);
  }

  it('writes each helper row with exactly one changelog row of its changed columns', async () => {
    const s = sheet();
    const d = day(s.timesheet_id);
    await seed(s, [d]);
    await inTenant(async (tx) => {
      const updated = await repository.updateDayState(tx, { dayId: d.day_id, state: 'SUBMITTED', lastupdate: NOW, lastupdatebyid: ACTOR });
      expect(updated).toMatchObject({ day_id: d.day_id, state: 'SUBMITTED', lastupdatebyid: ACTOR, hours: '7.5000' });
      expect(await repository.insertApprovalAction(tx, approval(d.day_id))).toMatchObject({ tenant_id: tenantId, day_id: d.day_id });
      expect(await repository.insertBlackoutIfAbsent(tx, blackout(d.day_id))).toBe(true);
      expect(await written(tx)).toEqual([
        { op: 'update', table: 'timesheet_day', columns: ['state', 'lastupdate', 'lastupdatebyid'] },
        {
          op: 'insert',
          table: 'approval_action',
          columns: ['action_id', 'day_id', 'action', 'role', 'from_state', 'to_state', 'actor_user_id', 'comment', 'created', 'legacy_program_id'],
        },
        { op: 'insert', table: 'blackout', columns: ['blackout_id', 'day_id', 'person_id', 'archive_id', 'reason', 'created', 'legacy_program_id'] },
      ]);
    });
  });

  it('returns null for a state update of a missing day', async () => {
    const update = { dayId: cfUuid(), state: 'SUBMITTED', lastupdate: NOW, lastupdatebyid: ACTOR };
    await expect(inTenant((tx) => repository.updateDayState(tx, update))).resolves.toBeNull();
  });

  it('inserts one blackout per day and skips a repeat without a changelog row', async () => {
    const s = sheet();
    const d = day(s.timesheet_id);
    await seed(s, [d]);
    expect(await inTenant((tx) => repository.insertBlackoutIfAbsent(tx, blackout(d.day_id)))).toBe(true);
    await inTenant(async (tx) => {
      expect(await repository.insertBlackoutIfAbsent(tx, blackout(d.day_id))).toBe(false);
      expect(await written(tx)).toEqual([]);
    });
    expect(await count('SELECT count(*) AS n FROM <s>.blackout')).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM <s>.changelog WHERE "table" = 'blackout'`)).toBe(1);
  });

  describe('with every gate closed', () => {
    let dayId: string;

    beforeEach(async () => {
      const s = sheet();
      const d = day(s.timesheet_id);
      dayId = d.day_id;
      await seed(s, [d]);
      await inTenant((tx) => repository.insertBlackoutIfAbsent(tx, blackout(d.day_id)));
      await closeGates(handle.app, { units: TIMESHEETS_UNITS, holderId: 'repository-test' });
    });

    it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
      ['updateDayState', (tx) => repository.updateDayState(tx, { dayId, state: 'SUBMITTED', lastupdate: NOW, lastupdatebyid: ACTOR })],
      ['insertApprovalAction', (tx) => repository.insertApprovalAction(tx, approval(dayId))],
      ['insertBlackoutIfAbsent on a blacked-out day', (tx) => repository.insertBlackoutIfAbsent(tx, blackout(dayId))],
    ])('%s rejects with GateClosedError after the budget', async (_name, write) => {
      await expect(withGatedTenant(handle.app, tenantId, write, SHORT_BUDGET)).rejects.toBeInstanceOf(GateClosedError);
    });
  });

  it('rejects target writes while the unit is legacy-authoritative', async () => {
    await setGates('legacy');
    await expect(inTenant((tx) => repository.insertBlackoutIfAbsent(tx, blackout(cfUuid())))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
  });

  it('blocks reads of a unit whose window executes and leaves other units readable', async () => {
    const s = sheet();
    await seed(s, [day(s.timesheet_id)]);
    await closeGates(handle.app, { units: ['timesheets.timesheet_day'], holderId: 'repository-test', phase: 'executing' });
    await expect(withGatedTenant(handle.app, tenantId, (tx) => repository.daysOfSheet(tx, s.timesheet_id), SHORT_BUDGET)).rejects.toBeInstanceOf(
      UnitReadBlockedError,
    );
    await expect(withGatedTenant(handle.app, tenantId, (tx) => repository.getSheet(tx, s.timesheet_id), SHORT_BUDGET)).resolves.toMatchObject({
      timesheet_id: s.timesheet_id,
    });
  });

  describe('reads over a mixed dataset', () => {
    const s1 = sheet({ timesheet_id: 'BBBBBBBB-0000-0000-0000000000000001', person_id: P1, period_start: new Date(2026, 5, 8) });
    const s2 = sheet({ timesheet_id: 'CCCCCCCC-0000-0000-0000000000000001', person_id: P1 });
    const s3 = sheet({ timesheet_id: 'AAAAAAAA-0000-0000-0000000000000009', person_id: P2 });
    const s4 = sheet({ timesheet_id: '11111111-0000-0000-0000000000000009', person_id: P1 });
    const elsewhere = sheet({ siteid: 'tenant-x', person_id: P2, period_start: new Date(2026, 4, 1) });
    const first = day(s2.timesheet_id, { day_id: 'FFFFFFFF-0000-0000-0000000000000000' });
    const blackedOut = day(s2.timesheet_id, { day_id: 'AAAAAAAA-0000-0000-0000000000000000', work_date: new Date(2026, 5, 2) });
    const open = day(s2.timesheet_id, { day_id: 'BBBBBBBB-0000-0000-0000000000000000', work_date: new Date(2026, 5, 2) });
    const approved = day(s2.timesheet_id, { day_id: '00000000-0000-0000-0000000000000001', work_date: new Date(2026, 5, 3), state: 'APPROVED' });
    const before = day(s1.timesheet_id, { day_id: '00000000-0000-0000-0000000000000002', work_date: new Date(2026, 4, 31) });
    const submittedBlackedOut = day(s1.timesheet_id, { day_id: '00000000-0000-0000-0000000000000003', work_date: new Date(2026, 5, 9), state: 'SUBMITTED' });
    const returned = day(s1.timesheet_id, { day_id: '90000000-0000-0000-0000000000000003', work_date: new Date(2026, 5, 9), state: 'RETURNED' });
    const otherPerson = day(s3.timesheet_id, { day_id: '10000000-0000-0000-0000000000000003', work_date: new Date(2026, 5, 9) });

    beforeEach(async () => {
      await seed(s1, [before, submittedBlackedOut, returned]);
      await seed(s2, [open, blackedOut, first, approved]);
      await seed(s3, [otherPerson]);
      await seed(s4);
      await seed(elsewhere);
      await inTenant(async (tx) => {
        await repository.insertBlackoutIfAbsent(tx, blackout(submittedBlackedOut.day_id, { person_id: P1 }));
        await repository.insertBlackoutIfAbsent(tx, blackout(blackedOut.day_id, { person_id: P1 }));
      });
    });

    it('lists sheets by period start, person and sheet id, filtered by site and person', async () => {
      await inTenant(async (tx) => {
        const ids = async (filter: Parameters<TimesheetsRepository['listSheets']>[1]) =>
          (await repository.listSheets(tx, filter)).map((row) => row.timesheet_id);
        expect(await ids({ siteid: 'tenant-a' })).toEqual([s3, s4, s2, s1].map((row) => row.timesheet_id));
        expect(await ids({})).toEqual([elsewhere, s3, s4, s2, s1].map((row) => row.timesheet_id));
        expect(await ids({ siteid: 'tenant-a', personId: P2 })).toEqual([s3.timesheet_id]);
        expect(await repository.getSheet(tx, s1.timesheet_id)).toMatchObject({ timesheet_id: s1.timesheet_id, person_id: P1 });
        expect(await repository.getSheet(tx, cfUuid())).toBeNull();
      });
    });

    it('reads days by work date, then day id, and blackouts by day id', async () => {
      await inTenant(async (tx) => {
        const days = await repository.daysOfSheet(tx, s2.timesheet_id);
        expect(days.map((row) => row.day_id)).toEqual([first, blackedOut, open, approved].map((row) => row.day_id));
        expect(days[0]?.hours).toBe('7.5000');
        const blackouts = await repository.blackoutsOfDays(tx, [blackedOut.day_id, submittedBlackedOut.day_id, cfUuid()]);
        expect(blackouts.map((row) => row.day_id)).toEqual([submittedBlackedOut.day_id, blackedOut.day_id]);
      });
    });

    it('selects the open days usp_apply_blackout blacks out, by day id', async () => {
      const days = await inTenant((tx) => repository.openDaysOfPerson(tx, { personId: P1, effectiveFrom: new Date(2026, 5, 1) }));
      expect(days.map((row) => row.day_id)).toEqual([returned, open, first].map((row) => row.day_id));
    });

    it('reads a day with its sheet and blackout flag', async () => {
      await inTenant(async (tx) => {
        const found = await repository.dayWithBlackout(tx, blackedOut.day_id);
        expect(found).toEqual({
          day: { ...blackedOut, tenant_id: tenantId },
          sheet: { timesheet_id: s2.timesheet_id, person_id: P1, siteid: 'tenant-a' },
          blackout: true,
        });
        expect((await repository.dayWithBlackout(tx, open.day_id, { forUpdate: true }))?.blackout).toBe(false);
        expect(await repository.dayWithBlackout(tx, cfUuid())).toBeNull();
      });
    });

    it('shows another tenant none of these rows through any read', async () => {
      await inTenant(async (tx) => {
        expect(await repository.listSheets(tx, {})).toEqual([]);
        expect(await repository.getSheet(tx, s1.timesheet_id)).toBeNull();
        expect(await repository.daysOfSheet(tx, s2.timesheet_id)).toEqual([]);
        expect(await repository.dayWithBlackout(tx, blackedOut.day_id)).toBeNull();
        expect(await repository.blackoutsOfDays(tx, [blackedOut.day_id])).toEqual([]);
        expect(await repository.openDaysOfPerson(tx, { personId: P1, effectiveFrom: new Date(2000, 0, 1) })).toEqual([]);
      }, tenantIdForSite(`timesheets-repository-other-${tenants}`));
    });
  });

  it('makes a locked day action see a blackout committed by an archive that locked the day first', async () => {
    const s = sheet();
    const d = day(s.timesheet_id);
    await seed(s, [d]);
    const locked = signal();
    const release = signal();
    const archive = inTenant(async (tx) => {
      expect((await repository.openDaysOfPerson(tx, { personId: ACTOR, effectiveFrom: new Date(2026, 0, 1) })).map((row) => row.day_id)).toEqual([d.day_id]);
      locked.fire();
      await release.promise;
      await repository.insertBlackoutIfAbsent(tx, blackout(d.day_id));
    });
    await locked.promise;
    const action = inTenant((tx) => repository.dayWithBlackout(tx, d.day_id, { forUpdate: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    release.fire();
    await archive;
    expect((await action)?.blackout).toBe(true);
  });

  it('makes an archive skip a day that a locked action approved meanwhile', async () => {
    const s = sheet();
    const d = day(s.timesheet_id, { state: 'PRIMARY_APPROVED' });
    await seed(s, [d]);
    const locked = signal();
    const release = signal();
    const action = inTenant(async (tx) => {
      expect((await repository.dayWithBlackout(tx, d.day_id, { forUpdate: true }))?.blackout).toBe(false);
      locked.fire();
      await release.promise;
      await repository.updateDayState(tx, { dayId: d.day_id, state: 'APPROVED', lastupdate: NOW, lastupdatebyid: ACTOR });
    });
    await locked.promise;
    const archive = inTenant((tx) => repository.openDaysOfPerson(tx, { personId: ACTOR, effectiveFrom: new Date(2026, 0, 1) }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    release.fire();
    await action;
    expect(await archive).toEqual([]);
  });
});
