// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The fixture task list as surveys built it from every record at once, the reference the name-batched list is held to. */
import { fixtureListData, type FixtureListData, type FixtureParams } from '../../src/legacy/fixture-envelope.js';
import { FIXTURE_TASK_STATUS, toFixtureTask, type FixtureTaskItem, type ScheduledTaskRecord } from '../../src/legacy/tasks-view.js';

/** The survey's own schedule rows, which give each listed task its offset. */
export interface RecordedSchedule {
  /** Stored survey id, which task names and routes carry. */
  surveyId: string;
  /** The survey's `survey_schedule` row; null when it was never scheduled. */
  schedule: { readonly task_name: string } | null;
  /** The survey's `survey_reminder` rows. */
  reminders: readonly { readonly task_name: string; readonly offset_minutes: number }[];
}

/** Every listed record whose name the survey recorded, as fixture items by offset, then name by UTF-16 code unit. */
export function referenceFixtureTaskList(records: readonly ScheduledTaskRecord[], recorded: RecordedSchedule): FixtureTaskItem[] {
  const offsets = new Map<string, number>();
  if (recorded.schedule) offsets.set(recorded.schedule.task_name, 0);
  for (const reminder of recorded.reminders) offsets.set(reminder.task_name, reminder.offset_minutes);
  const items: FixtureTaskItem[] = [];
  for (const record of records) {
    if (FIXTURE_TASK_STATUS[record.status] === 'deleted') continue;
    if (record.kind === 'survey-reminder' && record.n === null) throw new RangeError(`Reminder task ${record.taskName} has no ordinal`);
    const name = `opt2-survey-${recorded.surveyId}-${record.kind === 'survey-launch' ? 'launch' : `reminder-${String(record.n)}`}`;
    const offsetMinutes = offsets.get(name);
    if (record.taskName !== name || offsetMinutes === undefined) continue;
    items.push(toFixtureTask(record, { surveyId: recorded.surveyId, offsetMinutes }));
  }
  return items.sort((a, b) => a.offsetminutes - b.offsetminutes || (a.taskname < b.taskname ? -1 : a.taskname > b.taskname ? 1 : 0));
}

/** The `data` of the fixture task list response the reference list gives for `params`, paged in memory. */
export function referenceFixtureTaskPage(
  records: readonly ScheduledTaskRecord[],
  recorded: RecordedSchedule,
  params: FixtureParams,
): FixtureListData {
  return fixtureListData(referenceFixtureTaskList(records, recorded), params);
}
