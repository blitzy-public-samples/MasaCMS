// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { BUSINESS_DATE, asOf } from '@opt2/platform/testing';
import {
  deriveSheetStatus,
  type SheetStatus,
  type SheetStatusDay,
  type SheetStatusOptions,
  type SheetStatusResult,
} from '../../src/domain/sheet-status.js';
import { TIMESHEET_STATES, type TimesheetState } from '../../src/domain/lifecycle.transitions.js';

const FC_PARAMS = { seed: 20260601, numRuns: 200 } as const;

const day = (state: TimesheetState, blackout = false): SheetStatusDay => ({ state, blackout });

/** Local wall-clock `Date` of a `yyyy-mm-dd` date and time, as pg returns a `timestamp without time zone`. */
const localDate = (date: string, time = '00:00:00.000'): Date => new Date(`${asOf(date)}T${time}`);

const opts = (dueDate: string | Date, asOfValue: string = BUSINESS_DATE): SheetStatusOptions => ({
  dueDate: typeof dueDate === 'string' ? localDate(dueDate) : dueDate,
  asOf: asOf(asOfValue),
});

/** Direct transcription of `tvf_timesheet_status`: aggregates over the joined days, then its CASE expressions. */
function tvfStatus(days: readonly SheetStatusDay[], options: SheetStatusOptions): SheetStatusResult {
  const open = days.filter((d) => !d.blackout);
  const count = (states: readonly TimesheetState[]): number => open.filter((d) => states.includes(d.state)).length;
  const n = open.length;
  const returned = count(['RETURNED']);
  const approved = count(['APPROVED']);
  const submittedOrLater = count(['SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'APPROVED']);
  const draft = count(['DRAFT']);
  let status: SheetStatus;
  if (n === 0) status = 'DRAFT';
  else if (returned > 0) status = 'RETURNED';
  else if (approved === n) status = 'APPROVED';
  else if (approved > 0) status = 'PARTIALLY_APPROVED';
  else if (submittedOrLater === n) status = 'SUBMITTED';
  else status = 'DRAFT';
  // @asOf is bound as a cf_sql_date, so the datetime comparison is against local midnight of asOf.
  const asOfMidnight = new Date(`${options.asOf}T00:00:00.000`);
  return {
    status,
    overdue: options.dueDate.getTime() < asOfMidnight.getTime() && draft > 0,
    dayCount: days.length,
    blackoutCount: days.length - n,
    approvedCount: approved,
  };
}

const dayArb = fc.record({ state: fc.constantFrom(...TIMESHEET_STATES), blackout: fc.boolean() });
const daysArb = fc.array(dayArb, { maxLength: 14 });
const asOfArb = fc.constantFrom('2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02');
const dueDateArb = fc.oneof(
  fc.constantFrom('2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01').map((date) => localDate(date)),
  fc
    .record({ offset: fc.integer({ min: -2, max: 2 }), ms: fc.integer({ min: 0, max: 86_399_999 }) })
    .map(({ offset, ms }) => new Date(2026, 5, 30 + offset, 0, 0, 0, ms)),
);

afterEach(() => {
  vi.useRealTimers();
});

describe('deriveSheetStatus precedence over non-blackout days', () => {
  it.each<[string, SheetStatusDay[], SheetStatus, number]>([
    [
      'returns RETURNED when any day is returned, whatever the other days are',
      [day('APPROVED'), day('PRIMARY_APPROVED'), day('SUBMITTED'), day('DRAFT'), day('RETURNED')],
      'RETURNED',
      1,
    ],
    ['returns APPROVED when every day is approved', [day('APPROVED'), day('APPROVED'), day('APPROVED')], 'APPROVED', 3],
    ['returns PARTIALLY_APPROVED when some days are approved and the others draft', [day('APPROVED'), day('DRAFT')], 'PARTIALLY_APPROVED', 1],
    [
      'returns PARTIALLY_APPROVED when some days are approved and the others submitted',
      [day('APPROVED'), day('SUBMITTED'), day('RESUBMITTED')],
      'PARTIALLY_APPROVED',
      1,
    ],
    [
      'returns SUBMITTED when every day is submitted, resubmitted or primary-approved',
      [day('SUBMITTED'), day('RESUBMITTED'), day('PRIMARY_APPROVED')],
      'SUBMITTED',
      0,
    ],
    ['returns DRAFT when a draft day remains and none is approved or returned', [day('DRAFT'), day('SUBMITTED'), day('PRIMARY_APPROVED')], 'DRAFT', 0],
  ])('%s', (_title, days, status, approvedCount) => {
    expect(deriveSheetStatus(days, opts(BUSINESS_DATE))).toEqual({
      status,
      overdue: false,
      dayCount: days.length,
      blackoutCount: 0,
      approvedCount,
    });
  });
});

describe('deriveSheetStatus blackout handling', () => {
  it('ignores a blacked-out draft day for the status and counts it as a blackout', () => {
    expect(deriveSheetStatus([day('APPROVED'), day('DRAFT', true)], opts(BUSINESS_DATE))).toEqual({
      status: 'APPROVED',
      overdue: false,
      dayCount: 2,
      blackoutCount: 1,
      approvedCount: 1,
    });
  });

  it('does not return RETURNED for a blacked-out returned day', () => {
    expect(deriveSheetStatus([day('SUBMITTED'), day('RETURNED', true)], opts(BUSINESS_DATE)).status).toBe('SUBMITTED');
  });

  it('does not count a blacked-out approved day as approved', () => {
    expect(deriveSheetStatus([day('SUBMITTED'), day('APPROVED', true)], opts(BUSINESS_DATE))).toMatchObject({
      status: 'SUBMITTED',
      approvedCount: 0,
      blackoutCount: 1,
    });
  });

  it('is not overdue for a past-due sheet whose only draft day is blacked out', () => {
    expect(deriveSheetStatus([day('SUBMITTED'), day('DRAFT', true)], opts('2026-06-29'))).toMatchObject({
      status: 'SUBMITTED',
      overdue: false,
    });
  });

  it('returns DRAFT, not overdue, for a past-due sheet whose days are all blacked out', () => {
    const days = [day('DRAFT', true), day('APPROVED', true), day('RETURNED', true)];
    expect(deriveSheetStatus(days, opts('2026-06-29'))).toEqual({
      status: 'DRAFT',
      overdue: false,
      dayCount: 3,
      blackoutCount: 3,
      approvedCount: 0,
    });
  });

  it('returns DRAFT, not overdue, with zero counts for a past-due sheet without days', () => {
    expect(deriveSheetStatus([], opts('2026-06-29'))).toEqual({
      status: 'DRAFT',
      overdue: false,
      dayCount: 0,
      blackoutCount: 0,
      approvedCount: 0,
    });
  });
});

describe('deriveSheetStatus overdue rule', () => {
  it('is overdue when the due date precedes asOf and a draft day remains', () => {
    expect(deriveSheetStatus([day('DRAFT')], opts('2026-06-29')).overdue).toBe(true);
  });

  it('is overdue for a partially approved or returned sheet that still has a draft day', () => {
    expect(deriveSheetStatus([day('APPROVED'), day('DRAFT')], opts('2026-06-29'))).toMatchObject({
      status: 'PARTIALLY_APPROVED',
      overdue: true,
    });
    expect(deriveSheetStatus([day('RETURNED'), day('DRAFT')], opts('2026-06-29'))).toMatchObject({
      status: 'RETURNED',
      overdue: true,
    });
  });

  it('is not overdue when the due date precedes asOf but no day is draft', () => {
    expect(deriveSheetStatus([day('SUBMITTED'), day('SUBMITTED')], opts('2026-06-29')).overdue).toBe(false);
  });

  it('is not overdue when the due date follows asOf', () => {
    expect(deriveSheetStatus([day('DRAFT')], opts('2026-07-01')).overdue).toBe(false);
  });

  it('is not overdue when the due date equals asOf', () => {
    expect(deriveSheetStatus([day('DRAFT')], opts(BUSINESS_DATE, BUSINESS_DATE)).overdue).toBe(false);
  });

  it('compares a due date with a time of day against midnight of asOf', () => {
    expect(deriveSheetStatus([day('DRAFT')], opts(localDate('2026-06-29', '23:59:59.997'))).overdue).toBe(true);
    expect(deriveSheetStatus([day('DRAFT')], opts(localDate(BUSINESS_DATE, '17:30:00.000'))).overdue).toBe(false);
  });
});

describe('deriveSheetStatus properties', () => {
  it('equals the transcription of tvf_timesheet_status for any days, due date and asOf', () => {
    fc.assert(
      fc.property(daysArb, dueDateArb, asOfArb, (days, dueDate, asOfValue) => {
        const options = opts(dueDate, asOfValue);
        expect(deriveSheetStatus(days, options)).toEqual(tvfStatus(days, options));
      }),
      FC_PARAMS,
    );
  });

  it('returns the same result whatever the system clock reads', () => {
    fc.assert(
      fc.property(
        daysArb,
        dueDateArb,
        asOfArb,
        fc.array(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }), { minLength: 1, maxLength: 3 }),
        (days, dueDate, asOfValue, instants) => {
          const options = opts(dueDate, asOfValue);
          const expected = deriveSheetStatus(days, options);
          vi.useFakeTimers();
          try {
            for (const instant of instants) {
              vi.setSystemTime(instant);
              expect(deriveSheetStatus(days, options)).toEqual(expected);
            }
          } finally {
            vi.useRealTimers();
          }
        },
      ),
      FC_PARAMS,
    );
  });

  it('returns the same result for any order of the days', () => {
    const daysAndPermutation = daysArb.chain((days) =>
      fc.tuple(fc.constant(days), fc.shuffledSubarray(days, { minLength: days.length, maxLength: days.length })),
    );
    fc.assert(
      fc.property(daysAndPermutation, dueDateArb, asOfArb, ([days, shuffled], dueDate, asOfValue) => {
        const options = opts(dueDate, asOfValue);
        const expected = deriveSheetStatus(days, options);
        expect(deriveSheetStatus([...days].reverse(), options)).toEqual(expected);
        expect(deriveSheetStatus(shuffled, options)).toEqual(expected);
      }),
      FC_PARAMS,
    );
  });
});
