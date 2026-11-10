// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineTransitions, SAME_NEW_VERSION } from '@opt2/platform/state-machine';

/** Finance record lifecycle: the single definition the runner, the generated table and the fixture loader share. */
export const financeLifecycle = defineTransitions({
  service: 'finance',
  states: ['IN-PROGRESS', 'SUBMITTED', 'RE-SUBMITTED', 'APPROVED', 'REJECTED'],
  actions: ['submit', 'approve', 'reject', 'resubmit', 'edit'],
  roles: ['finance.preparer', 'finance.approver'],
  terminal: ['APPROVED'],
  rows: [
    { from: ['IN-PROGRESS'], action: 'submit', roles: ['finance.preparer'], to: 'SUBMITTED' },
    { from: ['SUBMITTED', 'RE-SUBMITTED'], action: 'approve', roles: ['finance.approver'], to: 'APPROVED' },
    { from: ['SUBMITTED', 'RE-SUBMITTED'], action: 'reject', roles: ['finance.approver'], to: 'REJECTED' },
    { from: ['REJECTED'], action: 'resubmit', roles: ['finance.preparer'], to: 'RE-SUBMITTED' },
    { from: ['IN-PROGRESS', 'REJECTED'], action: 'edit', roles: ['finance.preparer'], to: SAME_NEW_VERSION },
  ],
});

/** A finance record state. */
export type FinanceState = (typeof financeLifecycle.states)[number];

/** A finance lifecycle action, as the `{action}` route segment names it. */
export type FinanceAction = (typeof financeLifecycle.actions)[number];

/** A role that may act on the finance lifecycle. */
export type FinanceRole = (typeof financeLifecycle.roles)[number];

/** Finance states in definition order. */
export const FINANCE_STATES: readonly FinanceState[] = financeLifecycle.states;

/** Finance actions in definition order. */
export const FINANCE_ACTIONS: readonly FinanceAction[] = financeLifecycle.actions;

/** Finance lifecycle roles in definition order. */
export const FINANCE_ROLES: readonly FinanceRole[] = financeLifecycle.roles;
