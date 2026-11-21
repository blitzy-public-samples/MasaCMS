// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Timesheet day lifecycle definition, its committed transition table and the fixture-oracle report. */
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  decide,
  generateTable,
  serializeTable,
  type TransitionGuard,
  type TransitionTableRow,
} from '@opt2/platform/state-machine';
import {
  TIMESHEET_ACTIONS,
  TIMESHEET_ROLES,
  TIMESHEET_STATES,
  timesheetsLifecycle,
  type TimesheetAction,
  type TimesheetGuardContext,
  type TimesheetRole,
  type TimesheetState,
} from '../../src/domain/lifecycle.transitions.js';

const STATES = ['DRAFT', 'SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'APPROVED', 'RETURNED'] as const;
const ACTIONS = ['submit', 'primary-approve', 'secondary-approve', 'return', 'resubmit'] as const;
const ROLES = ['timesheets.employee', 'timesheets.primary-approver', 'timesheets.secondary-approver'] as const;

// [from, action, role, to] of every legal day transition.
const LEGAL_MOVES = [
  ['DRAFT', 'submit', 'timesheets.employee', 'SUBMITTED'],
  ['SUBMITTED', 'primary-approve', 'timesheets.primary-approver', 'PRIMARY_APPROVED'],
  ['RESUBMITTED', 'primary-approve', 'timesheets.primary-approver', 'PRIMARY_APPROVED'],
  ['PRIMARY_APPROVED', 'secondary-approve', 'timesheets.secondary-approver', 'APPROVED'],
  ['SUBMITTED', 'return', 'timesheets.primary-approver', 'RETURNED'],
  ['RESUBMITTED', 'return', 'timesheets.primary-approver', 'RETURNED'],
  ['PRIMARY_APPROVED', 'return', 'timesheets.secondary-approver', 'RETURNED'],
  ['RETURNED', 'resubmit', 'timesheets.employee', 'RESUBMITTED'],
] as const;

// Report outcome and status of each generated HTTP status.
const REPORT_OUTCOMES = {
  200: { outcome: 'legal', status: '2xx' },
  403: { outcome: 'wrong-role', status: '403' },
  409: { outcome: 'illegal-state', status: '409' },
} as const;

/** One unguarded row of the fixture-oracle report. */
interface ReportRow {
  from: string;
  action: string;
  role: string;
  outcome: string;
  status: string;
  to: string | null;
  error?: string;
}

/** The fields of `opt2/reports/state-machines/timesheets.json` the lifecycle decides. */
interface TimesheetsReport {
  service: string;
  states: string[];
  actions: string[];
  roles: string[];
  terminal: string[];
  blackout: { outcome: string; status: string; error: string };
  rows: ReportRow[];
}

const committedTable = readFileSync(new URL('../generated/transition-table.json', import.meta.url), 'utf8');
const table = JSON.parse(committedTable) as TransitionTableRow[];
const unguarded = table.filter((row) => row.guard === null);
const blackoutRows = table.filter((row) => row.guard === 'blackout');
const report = JSON.parse(
  readFileSync(new URL('../../../../opt2/reports/state-machines/timesheets.json', import.meta.url), 'utf8'),
) as TimesheetsReport;

/** `from|action|role` key of a table or report row. */
function rowKey(row: { from: string; action: string; role: string }): string {
  return `${row.from}|${row.action}|${row.role}`;
}

/** Number of rows per `|`-joined value of the fields `key` picks. */
function countBy<T>(rows: readonly T[], key: (row: T) => readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row).map(String).join('|');
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** The lifecycle's blackout guard; throws when the definition lacks it. */
function blackoutGuard(): TransitionGuard<TimesheetGuardContext> {
  const guard = timesheetsLifecycle.guards?.find((candidate) => candidate.name === 'blackout');
  if (guard === undefined) throw new Error('timesheets lifecycle defines no blackout guard');
  return guard;
}

describe('timesheetsLifecycle', () => {
  it('declares the timesheets service with its states, actions and roles in order', () => {
    expect(timesheetsLifecycle.service).toBe('timesheets');
    expect(timesheetsLifecycle.states).toStrictEqual([...STATES]);
    expect(timesheetsLifecycle.actions).toStrictEqual([...ACTIONS]);
    expect(timesheetsLifecycle.roles).toStrictEqual([...ROLES]);
  });

  it('exports TIMESHEET_STATES, TIMESHEET_ACTIONS and TIMESHEET_ROLES as the definition lists', () => {
    expect(TIMESHEET_STATES).toBe(timesheetsLifecycle.states);
    expect(TIMESHEET_ACTIONS).toBe(timesheetsLifecycle.actions);
    expect(TIMESHEET_ROLES).toBe(timesheetsLifecycle.roles);
  });

  it('derives the state, action, role and guard context types from the definition', () => {
    expectTypeOf<TimesheetState>().toEqualTypeOf<(typeof STATES)[number]>();
    expectTypeOf<TimesheetAction>().toEqualTypeOf<(typeof ACTIONS)[number]>();
    expectTypeOf<TimesheetRole>().toEqualTypeOf<(typeof ROLES)[number]>();
    expectTypeOf<TimesheetGuardContext>().toEqualTypeOf<{ blackout: boolean }>();
  });

  it('makes APPROVED its only terminal state, with no row leaving it', () => {
    expect(timesheetsLifecycle.terminal).toStrictEqual(['APPROVED']);
    expect(timesheetsLifecycle.rows.filter((row) => row.from.includes('APPROVED'))).toStrictEqual([]);
  });

  it('defines blackout as its only guard', () => {
    expect(timesheetsLifecycle.guards?.map((guard) => guard.name)).toStrictEqual(['blackout']);
  });

  it.each([true, false])('applies the blackout guard exactly when blackout is %s', (blackout) => {
    expect(blackoutGuard().applies({ blackout })).toBe(blackout);
  });
});

describe('test/generated/transition-table.json', () => {
  it('equals serializeTable(generateTable(timesheetsLifecycle)) byte for byte', () => {
    expect(committedTable).toBe(serializeTable(generateTable(timesheetsLifecycle)));
  });

  it('holds one timesheets row per guard, state, action and role', () => {
    expect(table).toHaveLength(180);
    expect(new Set(table.map((row) => JSON.stringify([row.guard, rowKey(row)]))).size).toBe(table.length);
    expect(countBy(table, (row) => [row.service, row.guard, row.newVersion])).toStrictEqual({
      'timesheets|null|false': 90,
      'timesheets|blackout|false': 90,
    });
  });

  it('splits the unguarded rows into 8 legal, 16 wrong-role and 66 illegal-state rows', () => {
    expect(countBy(unguarded, (row) => [row.expectedStatus, row.errorCode])).toStrictEqual({
      '200|null': 8,
      '403|authorization': 16,
      '409|illegalTransition': 66,
    });
  });

  it('answers every blackout row 409 blackout without a new state', () => {
    expect(countBy(blackoutRows, (row) => [row.expectedStatus, row.errorCode, row.to])).toStrictEqual({
      '409|blackout|null': 90,
    });
  });

  it('lists exactly the legal day transitions as its 200 rows', () => {
    const legal = unguarded.filter((row) => row.expectedStatus === 200);
    expect(Object.fromEntries(legal.map((row) => [rowKey(row), row.to]))).toStrictEqual(
      Object.fromEntries(LEGAL_MOVES.map(([from, action, role, to]) => [rowKey({ from, action, role }), to])),
    );
  });

  it('rejects every action on an APPROVED day with 409 illegalTransition', () => {
    const fromApproved = unguarded.filter((row) => row.from === 'APPROVED');
    expect(countBy(fromApproved, (row) => [row.expectedStatus, row.errorCode])).toStrictEqual({
      '409|illegalTransition': ACTIONS.length * ROLES.length,
    });
  });

  it('agrees with decide() over the blackout guard context for every row', () => {
    const decided = table.map((row) => {
      const decision = decide(timesheetsLifecycle, {
        state: row.from,
        action: row.action,
        roles: [row.role],
        guards: { blackout: row.guard === 'blackout' },
      });
      return decision.outcome === 'ok'
        ? { status: 200, to: decision.to, errorCode: null }
        : { status: decision.status, to: null, errorCode: decision.error.code };
    });
    expect(decided).toStrictEqual(
      table.map((row) => ({ status: row.expectedStatus, to: row.to, errorCode: row.errorCode })),
    );
  });
});

describe('opt2/reports/state-machines/timesheets.json', () => {
  it('declares the lifecycle service, states, actions, roles and terminal states', () => {
    const { service, states, actions, roles, terminal } = report;
    expect({ service, states, actions, roles, terminal }).toStrictEqual({
      service: timesheetsLifecycle.service,
      states: [...timesheetsLifecycle.states],
      actions: [...timesheetsLifecycle.actions],
      roles: [...timesheetsLifecycle.roles],
      terminal: [...timesheetsLifecycle.terminal],
    });
  });

  it('carries the outcome of every unguarded table row, keyed by from, action and role', () => {
    expect(report.rows).toHaveLength(unguarded.length);
    expect(
      Object.fromEntries(
        report.rows.map((row) => [
          rowKey(row),
          { outcome: row.outcome, status: row.status, to: row.to, error: row.error ?? null },
        ]),
      ),
    ).toStrictEqual(
      Object.fromEntries(
        unguarded.map((row) => [
          rowKey(row),
          { ...REPORT_OUTCOMES[row.expectedStatus], to: row.to, error: row.errorCode },
        ]),
      ),
    );
  });

  it('states the blackout rule as the outcome of every blackout row', () => {
    const { outcome, status, error } = report.blackout;
    expect({ outcome, status, error }).toStrictEqual({ outcome: 'illegal-state', status: '409', error: 'blackout' });
    const outcomes = countBy(blackoutRows, (row) => {
      const generated = REPORT_OUTCOMES[row.expectedStatus];
      return [generated.outcome, generated.status, row.errorCode];
    });
    expect(outcomes).toStrictEqual({ [[outcome, status, error].join('|')]: blackoutRows.length });
  });
});
