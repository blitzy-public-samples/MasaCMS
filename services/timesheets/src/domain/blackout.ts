// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { OpenDaysQuery, TimesheetsRepository } from '../repo/repository.js';
import type { BlackoutRow, TimesheetDayRow } from '../repo/tables.js';

/** Reason `usp_apply_blackout` stores through the fixture column default. */
const PERSON_ARCHIVED_REASON = 'person-archived';

/** The archived person, the first blacked-out work date, the archive and the caller's local `timestamp(3)` write time. */
export interface BlackoutInput {
  personId: BlackoutRow['person_id'];
  effectiveFrom: OpenDaysQuery['effectiveFrom'];
  archiveId: BlackoutRow['archive_id'];
  now: BlackoutRow['created'];
}

/** The person's days in the transaction tenant that `usp_apply_blackout` blacks out, row-locked, by day id. */
export function openDaysForBlackout(tx: TenantTx, repo: TimesheetsRepository, query: OpenDaysQuery): Promise<TimesheetDayRow[]> {
  return repo.openDaysOfPerson(tx, query);
}

/** Mirrors `usp_apply_blackout` in the transaction tenant; returns the number of blackout rows inserted. */
export async function applyBlackout(tx: TenantTx, repo: TimesheetsRepository, input: BlackoutInput): Promise<number> {
  const days = await openDaysForBlackout(tx, repo, { personId: input.personId, effectiveFrom: input.effectiveFrom });
  let inserted = 0;
  // One statement at a time: the transaction holds a single connection, and the procedure inserts in @days key order.
  for (const day of days) {
    const created = await repo.insertBlackoutIfAbsent(tx, {
      blackout_id: cfUuid(),
      day_id: day.day_id,
      person_id: input.personId,
      archive_id: input.archiveId,
      reason: PERSON_ARCHIVED_REASON,
      created: input.now,
      legacy_program_id: day.legacy_program_id,
    });
    if (created) inserted += 1;
  }
  return inserted;
}
