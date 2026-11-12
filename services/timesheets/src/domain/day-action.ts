// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** One lifecycle action on one timesheet day, as `[Program_N].usp_timesheet_day_action` applies it, decided by `timesheetsLifecycle`. */
import { applyTransition } from '@opt2/platform/state-machine';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { timesheetsLifecycle, type TimesheetAction, type TimesheetState } from './lifecycle.transitions.js';
import type { TimesheetsRepository } from '../repo/repository.js';
import type { ApprovalActionRow, TimesheetDayRow } from '../repo/tables.js';

/** A day action request; `roles` and `actorUserId` come from the verified token, `now` from the caller's injected clock. */
export interface DayActionInput {
  dayId: string;
  action: TimesheetAction;
  roles: readonly string[];
  actorUserId: string;
  /** Stored as NULL when null or empty, as timesheets.cfc binds it. */
  comment: string | null;
  now: ApprovalActionRow['created'];
}

/** `not-found` for a missing day; otherwise the updated day, its new `approval_action` row and the state it moved to. */
export type DayActionResult =
  | { outcome: 'not-found' }
  | { outcome: 'legal'; day: TimesheetDayRow; approvalAction: ApprovalActionRow; to: TimesheetState };

/**
 * Applies `input.action` to day `input.dayId` inside the caller's gated tenant transaction, mirroring `usp_timesheet_day_action`.
 * The fixture route's site-scoped existence and comment checks run before this call, as timesheets.cfc runs them before the procedure.
 * A rejected transition throws `TransitionRejectedError` before anything is written.
 */
export async function performDayAction(tx: TenantTx, repo: TimesheetsRepository, input: DayActionInput): Promise<DayActionResult> {
  // Locked before the blackout is read, as the procedure takes UPDLOCK on the day before its blackout key.
  const found = await repo.dayWithBlackout(tx, input.dayId, { forUpdate: true });
  if (found === null) return { outcome: 'not-found' };

  const ctx: WriteContext = { actorUserId: input.actorUserId };
  // The stored id, not the requested one, keys both writes, as the procedure's audit row does.
  const dayId = found.day.day_id;
  return applyTransition(
    timesheetsLifecycle,
    { state: found.day.state, action: input.action, roles: input.roles, guards: { blackout: found.blackout } },
    async ({ from, action, to, actingRole }): Promise<DayActionResult> => {
      const day = await repo.updateDayState(tx, { dayId, state: to, lastupdate: input.now, lastupdatebyid: input.actorUserId }, ctx);
      // Unreachable while the row lock above is held; fail fast rather than audit a day that was not updated.
      if (day === null) throw new Error(`Timesheet day ${dayId} disappeared under its row lock`);
      const approvalAction = await repo.insertApprovalAction(
        tx,
        {
          action_id: cfUuid(),
          day_id: dayId,
          action,
          role: actingRole,
          from_state: from,
          to_state: to,
          actor_user_id: input.actorUserId,
          comment: input.comment === '' ? null : input.comment,
          created: input.now,
          legacy_program_id: found.day.legacy_program_id,
        },
        ctx,
      );
      return { outcome: 'legal', day, approvalAction, to };
    },
  );
}
