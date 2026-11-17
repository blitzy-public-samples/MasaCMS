// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Views of a survey's launch and reminder tasks, mapped from communications' scheduled-task records. */
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import type { components } from '../generated/clients/communications.js';

/** One scheduled-task record of `GET /internal/v1/scheduled-tasks` in communications. */
export type ScheduledTaskRecord = components['schemas']['ScheduledTask'];

/** One task as the fixture's `GET surveys/surveys/{id}/tasks` lists it, keys in the fixture's order. */
export interface FixtureTaskItem {
  taskname: string;
  kind: 'launch' | 'reminder';
  route: string;
  offsetminutes: number;
}

/** One task as `GET /v1/surveys/{surveyId}/tasks` lists it (`ScheduledTaskView`). */
export interface ScheduledTaskViewItem {
  taskName: string;
  kind: 'launch' | 'reminder';
  scheduleTime: string;
  status: ScheduledTaskRecord['status'];
}

/** The fixture's ACF task state per communications status: a reschedule or cancellation deletes the ACF task, while run tasks stay listed. */
export const FIXTURE_TASK_STATUS: Readonly<Record<ScheduledTaskRecord['status'], 'listed' | 'deleted'>> = Object.freeze({
  scheduled: 'listed',
  done: 'listed',
  failed: 'listed',
  cancelled: 'deleted',
  superseded: 'deleted',
});

/** The survey's own task names with their offsets, which give each listed task its offset as the fixture's rows do. */
export interface FixtureTaskListOptions {
  /** Stored survey id, which task names and routes carry. */
  surveyId: string;
  /** Minutes from the launch of each task name the survey recorded: 0 for its launch, its own offset for each reminder. */
  offsets: ReadonlyMap<string, number>;
}

/** A task's place in the fixture's task order: its offset, then its name. */
export type FixtureTaskKey = readonly [offsetMinutes: number, taskName: string];

const TASK_PREFIX = 'opt2-survey-';
const CALLBACK_PATH = '/legacy-fixtures/cfml/api.cfm/surveys/surveys/';

/** Fixture task name of a record: `opt2-survey-<id>-launch` or `opt2-survey-<id>-reminder-<n>`. */
function fixtureTaskName(surveyId: string, record: ScheduledTaskRecord): string {
  if (record.kind === 'survey-launch') return `${TASK_PREFIX}${surveyId}-launch`;
  if (record.n === null) throw new RangeError(`Reminder task ${record.taskName} has no ordinal`);
  return `${TASK_PREFIX}${surveyId}-reminder-${record.n}`;
}

/** Maps one record to the fixture item, given the stored survey id and the task's offset from the launch time. */
export function toFixtureTask(
  record: ScheduledTaskRecord,
  opts: { surveyId: string; offsetMinutes: number },
): FixtureTaskItem {
  const launch = record.kind === 'survey-launch';
  // The fixture strips the origin and query from the ACF task URL, so no gateway origin reaches the route.
  return {
    taskname: fixtureTaskName(opts.surveyId, record),
    kind: launch ? 'launch' : 'reminder',
    route: `${CALLBACK_PATH}${esapiUrlEncode(opts.surveyId)}/${launch ? 'launch' : 'remind'}`,
    offsetminutes: opts.offsetMinutes,
  };
}

/** The fixture items of the listed records whose names the survey recorded, in the records' order. */
export function toFixtureTasks(records: readonly ScheduledTaskRecord[], opts: FixtureTaskListOptions): FixtureTaskItem[] {
  // Offsets come from the survey's own rows, as in the fixture; communications moves a past scheduleTime to now.
  const items: FixtureTaskItem[] = [];
  for (const record of records) {
    if (FIXTURE_TASK_STATUS[record.status] === 'deleted') continue;
    const name = fixtureTaskName(opts.surveyId, record);
    const offsetMinutes = opts.offsets.get(name);
    if (record.taskName !== name || offsetMinutes === undefined) continue;
    items.push(toFixtureTask(record, { surveyId: opts.surveyId, offsetMinutes }));
  }
  return items;
}

/** The fixture's task order of two keys: offset, then name. */
export function compareFixtureTaskKeys([offsetA, nameA]: FixtureTaskKey, [offsetB, nameB]: FixtureTaskKey): number {
  // CFML compare() orders names case-sensitively by UTF-16 code unit, as JS string comparison does.
  return offsetA - offsetB || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0);
}

/** The fixture's task order: offset, then name. */
export function compareFixtureTasks(a: FixtureTaskItem, b: FixtureTaskItem): number {
  return compareFixtureTaskKeys([a.offsetminutes, a.taskname], [b.offsetminutes, b.taskname]);
}

/** Maps one record to the `/v1/` task view; scheduleTime stays the zone-less local timestamp communications holds. */
export function toScheduledTaskView(record: ScheduledTaskRecord): ScheduledTaskViewItem {
  return {
    taskName: record.taskName,
    kind: record.kind === 'survey-launch' ? 'launch' : 'reminder',
    scheduleTime: record.scheduleTime,
    status: record.status,
  };
}
