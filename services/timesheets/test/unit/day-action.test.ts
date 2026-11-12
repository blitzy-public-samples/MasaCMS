// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** performDayAction against a throwaway `timesheets` schema: the audited writes of a legal action, every generated table row, locking and gates. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GateClosedError, closeGates, ensureUnitGates, openGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { cfUuid, isCfUuid } from '@opt2/platform/legacy-compat';
import { TransitionRejectedError, type TransitionTableRow } from '@opt2/platform/state-machine';
import { tenantIdForSite, type TenantTx } from '@opt2/platform/tenancy';
import { businessClock, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { performDayAction, type DayActionInput } from '../../src/domain/day-action.js';
import type { TimesheetAction } from '../../src/domain/lifecycle.transitions.js';
import { createTimesheetsRepository, type DayWithBlackout, type TimesheetsRepository } from '../../src/repo/repository.js';
import { TIMESHEETS_UNITS, type ApprovalActionRow, type TimesheetDayRow, type TimesheetRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const SEEDED = new Date(2026, 5, 1, 9, 0, 0, 0);
const ACTOR = cfUuid();
const PERSON = cfUuid();
const SHORT_BUDGET = { budgetMs: 300 };
const table = JSON.parse(readFileSync(new URL('../generated/transition-table.json', import.meta.url), 'utf8')) as TransitionTableRow[];

type New<R> = Omit<R, 'tenant_id'>;

/** A submit of `dayId` by an employee at `NOW`, with `overrides`. */
function request(dayId: string, overrides: Partial<DayActionInput> = {}): DayActionInput {
  return { dayId, action: 'submit', roles: ['timesheets.employee'], actorUserId: ACTOR, comment: 'checked', now: NOW, ...overrides };
}

describe('performDayAction without a database', () => {
  it('fails without an audit row when the locked day cannot be updated', async () => {
    const found: DayWithBlackout = {
      day: { tenant_id: 't', day_id: cfUuid(), timesheet_id: cfUuid(), work_date: SEEDED, hours: '8.0000', state: 'DRAFT', lastupdate: null, lastupdatebyid: null, legacy_program_id: 1 },
      sheet: { timesheet_id: cfUuid(), person_id: PERSON, siteid: 'tenant-a' },
      blackout: false,
    };
    const audits: unknown[] = [];
    const repo = {
      dayWithBlackout: () => Promise.resolve(found),
      updateDayState: () => Promise.resolve(null),
      insertApprovalAction: (_tx: TenantTx, row: unknown) => Promise.resolve(audits.push(row)),
    } as unknown as TimesheetsRepository;
    await expect(performDayAction({} as TenantTx, repo, request(found.day.day_id))).rejects.toThrow(/disappeared under its row lock/);
    expect(audits).toEqual([]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('performDayAction against PostgreSQL', () => {
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
    await setGates(TIMESHEETS_UNITS, 'open');
    tenants += 1;
    tenantId = tenantIdForSite(`timesheets-day-action-${tenants}`);
  });

  /** Moves the gates of `units` to `state` through the holder compare-and-set. */
  async function setGates(units: readonly string[], state: 'open' | 'closed'): Promise<void> {
    await closeGates(handle.app, { units, holderId: 'day-action-test', allowLegacy: true });
    if (state === 'open') await openGates(handle.app, { units, holderId: 'day-action-test', state });
  }

  function act(input: DayActionInput, opts = {}) {
    return withGatedTenant(handle.app, tenantId, (tx) => performDayAction(tx, repository, input), opts);
  }

  /** Seeds one sheet with one day in `state`, blacked out when `blackout`, under program `programId`. */
  async function seedDay(state: string, { blackout = false, programId = 1 } = {}): Promise<New<TimesheetDayRow>> {
    const sheet: New<TimesheetRow> = {
      timesheet_id: cfUuid(),
      person_id: PERSON,
      siteid: 'tenant-a',
      period_start: new Date(2026, 5, 1),
      period_end: new Date(2026, 5, 7),
      due_date: new Date(2026, 5, 10),
      created: SEEDED,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: programId,
    };
    const day: New<TimesheetDayRow> = {
      day_id: cfUuid(),
      timesheet_id: sheet.timesheet_id,
      work_date: new Date(2026, 5, 1),
      hours: '7.5000',
      state,
      lastupdate: null,
      lastupdatebyid: null,
      legacy_program_id: programId,
    };
    await handle.app.withTenant(tenantId, async (tx) => {
      await repository.insert(tx, 'timesheet', sheet);
      await repository.insert(tx, 'timesheet_day', day);
      if (blackout) {
        const row = { blackout_id: cfUuid(), day_id: day.day_id, person_id: PERSON, archive_id: null, reason: 'person-archived', created: SEEDED, legacy_program_id: programId };
        await repository.insert(tx, 'blackout', row);
      }
    });
    return day;
  }

  /** The day's stored lifecycle columns, its audit rows and the tenant's changelog row count. */
  function stored(dayId: string) {
    return handle.app.withTenant(tenantId, async (tx) => ({
      day: (await tx.query(`SELECT state, lastupdate, lastupdatebyid FROM ${handle.schema}.timesheet_day WHERE day_id = $1`, [dayId])).rows[0],
      actions: (await tx.query<ApprovalActionRow>(`SELECT * FROM ${handle.schema}.approval_action WHERE day_id = $1`, [dayId])).rows,
      changes: Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM ${handle.schema}.changelog`)).rows[0]?.n),
    }));
  }

  it('writes the day state and one audit row of the acting role, states and program id, each with its changelog row', async () => {
    const day = await seedDay('DRAFT', { programId: 2 });
    const before = await stored(day.day_id);
    const result = await act(request(day.day_id));
    expect(result).toMatchObject({
      outcome: 'legal',
      to: 'SUBMITTED',
      day: { day_id: day.day_id, state: 'SUBMITTED', lastupdate: NOW, lastupdatebyid: ACTOR, hours: '7.5000', legacy_program_id: 2 },
      approvalAction: {
        tenant_id: tenantId,
        day_id: day.day_id,
        action: 'submit',
        role: 'timesheets.employee',
        from_state: 'DRAFT',
        to_state: 'SUBMITTED',
        actor_user_id: ACTOR,
        comment: 'checked',
        created: NOW,
        legacy_program_id: 2,
      },
    });
    const after = await stored(day.day_id);
    expect(after.actions).toHaveLength(1);
    expect(isCfUuid(after.actions[0]?.action_id ?? '')).toBe(true);
    expect(after.changes - before.changes).toBe(2);
  });

  it.each<[string | null, string | null]>([
    ['', null],
    [null, null],
    [' ', ' '],
  ])('stores comment %j as %j', async (comment, expected) => {
    const day = await seedDay('DRAFT');
    await act(request(day.day_id, { comment }));
    expect((await stored(day.day_id)).actions.map((row) => row.comment)).toEqual([expected]);
  });

  it('records the definition role a caller holding several roles acts with', async () => {
    const day = await seedDay('PRIMARY_APPROVED');
    const roles = ['member', 'timesheets.primary-approver', 'timesheets.secondary-approver'];
    await expect(act(request(day.day_id, { action: 'return', roles }))).resolves.toMatchObject({
      to: 'RETURNED',
      approvalAction: { role: 'timesheets.secondary-approver' },
    });
  });

  it('answers not-found for an unknown day without writing', async () => {
    const before = await stored(cfUuid());
    await expect(act(request(cfUuid()))).resolves.toEqual({ outcome: 'not-found' });
    expect((await stored(cfUuid())).changes).toBe(before.changes);
  });

  it(`gives every one of the ${table.length} generated table rows its outcome and writes only for legal rows`, async () => {
    for (const row of table) {
      const day = await seedDay(row.from, { blackout: row.guard === 'blackout' });
      const before = await stored(day.day_id);
      const run = act(request(day.day_id, { action: row.action as TimesheetAction, roles: [row.role] }));
      if (row.expectedStatus === 200) {
        await expect(run).resolves.toMatchObject({ outcome: 'legal', to: row.to, approvalAction: { role: row.role } });
        continue;
      }
      const err = await run.then(() => undefined, (error: unknown) => error);
      expect(err, `${row.guard ?? '-'} ${row.from} ${row.action} ${row.role}`).toBeInstanceOf(TransitionRejectedError);
      expect(err).toMatchObject({ statusCode: row.expectedStatus, code: row.errorCode });
      expect(await stored(day.day_id)).toEqual(before);
    }
  });

  it('serialises concurrent actions on one day: one applies, the other meets the new state', async () => {
    const day = await seedDay('DRAFT');
    const runs = await Promise.allSettled([act(request(day.day_id)), act(request(day.day_id))]);
    expect(runs.map((run) => run.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(runs.find((run) => run.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'illegalTransition' } });
    expect((await stored(day.day_id)).actions).toHaveLength(1);
  });

  it.each(['timesheets.timesheet_day', 'timesheets.approval_action'])('rejects with GateClosedError and writes nothing while %s is closed', async (unit) => {
    const day = await seedDay('DRAFT');
    const before = await stored(day.day_id);
    await setGates([unit], 'closed');
    await expect(act(request(day.day_id), SHORT_BUDGET)).rejects.toBeInstanceOf(GateClosedError);
    await setGates([unit], 'open');
    expect(await stored(day.day_id)).toEqual(before);
  });
});
