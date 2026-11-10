// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineTransitions } from '@opt2/platform/state-machine';

/** Context the lifecycle guards test for one timesheet day. */
export interface TimesheetGuardContext {
  blackout: boolean;
}

/** Timesheet day lifecycle: the single definition the runner, the generated table and the fixture loader share. */
export const timesheetsLifecycle = defineTransitions({
  service: 'timesheets',
  states: ['DRAFT', 'SUBMITTED', 'RESUBMITTED', 'PRIMARY_APPROVED', 'APPROVED', 'RETURNED'],
  actions: ['submit', 'primary-approve', 'secondary-approve', 'return', 'resubmit'],
  roles: ['timesheets.employee', 'timesheets.primary-approver', 'timesheets.secondary-approver'],
  terminal: ['APPROVED'],
  guards: [{ name: 'blackout', applies: (ctx: TimesheetGuardContext) => ctx.blackout }],
  rows: [
    { from: ['DRAFT'], action: 'submit', roles: ['timesheets.employee'], to: 'SUBMITTED' },
    {
      from: ['SUBMITTED', 'RESUBMITTED'],
      action: 'primary-approve',
      roles: ['timesheets.primary-approver'],
      to: 'PRIMARY_APPROVED',
    },
    {
      from: ['PRIMARY_APPROVED'],
      action: 'secondary-approve',
      roles: ['timesheets.secondary-approver'],
      to: 'APPROVED',
    },
    { from: ['SUBMITTED', 'RESUBMITTED'], action: 'return', roles: ['timesheets.primary-approver'], to: 'RETURNED' },
    { from: ['PRIMARY_APPROVED'], action: 'return', roles: ['timesheets.secondary-approver'], to: 'RETURNED' },
    { from: ['RETURNED'], action: 'resubmit', roles: ['timesheets.employee'], to: 'RESUBMITTED' },
  ],
});

/** A timesheet day state. */
export type TimesheetState = (typeof timesheetsLifecycle.states)[number];

/** A timesheet day action, as the `days/{id}/{action}` route segment names it. */
export type TimesheetAction = (typeof timesheetsLifecycle.actions)[number];

/** A role that may act on the timesheet day lifecycle. */
export type TimesheetRole = (typeof timesheetsLifecycle.roles)[number];

/** Timesheet day states in definition order. */
export const TIMESHEET_STATES: readonly TimesheetState[] = timesheetsLifecycle.states;

/** Timesheet day actions in definition order. */
export const TIMESHEET_ACTIONS: readonly TimesheetAction[] = timesheetsLifecycle.actions;

/** Timesheet day lifecycle roles in definition order. */
export const TIMESHEET_ROLES: readonly TimesheetRole[] = timesheetsLifecycle.roles;
