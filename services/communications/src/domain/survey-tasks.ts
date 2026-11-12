// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Pure seam 2 task plan: the launch and reminder tasks of one `surveys.survey.scheduled.v1` schedule version, named as the fixture's ACF tasks. */
import { strictLocalInstant } from '@opt2/platform/legacy-compat';
import { QUEUES, assertTaskName, targetUrl } from '@opt2/platform/tasks';
import type { components as SurveysComponents } from '../generated/clients/surveys.js';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';
import type { components } from '../generated/openapi.js';
import type { SCHEDULED_TASK_KINDS, ScheduledTaskQueue } from '../repo/tables.js';

/** Kind of a survey task, as `scheduled_task.kind`. */
export type SurveyTaskKind = (typeof SCHEDULED_TASK_KINDS)[number];

/** Body payload of a `surveys-launch` task: surveys' contract `LaunchPayload`. */
export type LaunchTaskPayload = SurveysComponents['schemas']['LaunchPayload'];

/** Body payload of a `communications-reminders` task: the contract's `ReminderTaskPayload`. */
export type ReminderTaskPayload = components['schemas']['ReminderTaskPayload'];

/** Queue of each survey task kind. */
export const SURVEY_TASK_QUEUES = Object.freeze({
  'survey-launch': 'surveys-launch',
  'survey-reminder': 'communications-reminders',
} as const satisfies Record<SurveyTaskKind, ScheduledTaskQueue>);

// A reminder's route names its scheduled-task row, whose id exists only once the row is stored,
// so the plan carries no URL and `taskTarget` builds it from the planned task or the row.
/** One task of a schedule version; the plan carries no tenant, which callers take from the verified envelope or the adoption rule. */
export interface PlannedSurveyTask {
  kind: SurveyTaskKind;
  queue: ScheduledTaskQueue;
  /** Fixture ACF task name, stored as `scheduled_task.task_name`. */
  legacyTaskName: string;
  /** Queue task name: the legacy name suffixed with the schedule version. */
  portName: string;
  scheduleTime: Date;
  deadlineS: number;
  surveyId: string;
  siteId: string;
  scheduleVersion: number;
  /** Reminder ordinal; absent for the launch. */
  n?: number;
}

/** What a task's target depends on; `scheduledTaskId` is required for reminders, whose route names their row. */
export interface SurveyTaskTargetRef {
  queue: ScheduledTaskQueue;
  surveyId: string;
  scheduledTaskId?: string;
}

/** A task's absolute URL, and the URL's path as `scheduled_task.target_route` stores it. */
export interface SurveyTaskTarget {
  url: string;
  route: string;
}

/** Fields a task payload is built from, taken from a planned task or a stored row. */
export interface SurveyTaskPayloadSource {
  kind: SurveyTaskKind;
  surveyId: string;
  siteId: string;
  scheduleVersion: number;
  /** Reminder ordinal; absent or null for the launch, as `scheduled_task.reminder_n`. */
  n?: number | null;
}

/** Survey, kind and reminder ordinal of a fixture ACF task name. */
export interface LegacyTaskNameParts {
  surveyId: string;
  kind: SurveyTaskKind;
  /** Reminder ordinal; absent for the launch. */
  n?: number;
}

const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
const LEGACY_TASK_NAME =
  /^opt2-survey-(?<surveyId>[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16})-(?:launch|reminder-(?<n>[1-9][0-9]*))$/;
const MS_PER_MINUTE = 60_000;

/** Queue task name of a legacy task name in a schedule version; throws `InvalidTaskNameError` outside `TASK_NAME_PATTERN`. */
export function portTaskName(taskName: string, scheduleVersion: number): string {
  // Cloud Tasks keeps deleted names as tombstones, so every schedule version needs names of its own.
  const name = `${taskName}-v${String(scheduleVersion)}`;
  assertTaskName(name);
  return name;
}

/**
 * Parses `yyyy-MM-ddTHH:mm:ss.SSS` as wall-clock time in the process `TZ`, a repeated time taking its later offset as the legacy
 * calendar resolves it; throws `RangeError` for any other text or a time that does not exist there.
 */
export function parseLocalTimestamp(text: string): Date {
  const match = LOCAL_TIMESTAMP.exec(text);
  if (match === null) throw new RangeError(`Invalid local timestamp ${JSON.stringify(text)}: expected yyyy-MM-ddTHH:mm:ss.SSS`);
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(Number) as [number, number, number, number, number, number, number];
  const instant = strictLocalInstant({ year, month, day, hour, minute, second, ms });
  if (instant === undefined) {
    throw new RangeError(`Invalid local timestamp ${JSON.stringify(text)}: no such local time`);
  }
  return new Date(instant);
}

/** The instant the legacy scheduler runs a task starting at the local wall time of `at`; a repeated time takes its later offset. */
export function legacyRunTime(at: Date): Date {
  const instant = strictLocalInstant({
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
    hour: at.getHours(),
    minute: at.getMinutes(),
    second: at.getSeconds(),
    ms: at.getMilliseconds(),
  });
  return instant === undefined ? at : new Date(instant);
}

/** One planned task; a run time before `now` is moved to `now`, so it is scheduled immediately. */
function plannedTask(
  payload: SurveyScheduledPayload,
  kind: SurveyTaskKind,
  legacyTaskName: string,
  runAt: Date,
  now: Date,
  n?: number,
): PlannedSurveyTask {
  const queue = SURVEY_TASK_QUEUES[kind];
  return {
    kind,
    queue,
    legacyTaskName,
    portName: portTaskName(legacyTaskName, payload.scheduleVersion),
    scheduleTime: new Date(Math.max(runAt.getTime(), now.getTime())),
    deadlineS: QUEUES[queue].deadlineS,
    surveyId: payload.surveyId,
    siteId: payload.siteId,
    scheduleVersion: payload.scheduleVersion,
    ...(n === undefined ? {} : { n }),
  };
}

/** Plans the launch task, then one task per reminder in payload order, each reminder `offsetMinutes` after `launchAt`. */
export function planSurveyTasks(payload: SurveyScheduledPayload, opts: { now: Date }): PlannedSurveyTask[] {
  const launchAt = parseLocalTimestamp(payload.launchAt);
  return [
    plannedTask(payload, 'survey-launch', payload.launchTaskName, launchAt, opts.now),
    // The fixture's cfschedule start is the local wall time of dateAdd("n", offsetMinutes, launchAt).
    ...payload.reminders.map((reminder) =>
      plannedTask(
        payload,
        'survey-reminder',
        reminder.taskName,
        legacyRunTime(new Date(launchAt.getTime() + reminder.offsetMinutes * MS_PER_MINUTE)),
        opts.now,
        reminder.n,
      ),
    ),
  ];
}

/** URL and route of a task from the platform queue registry; throws `UnknownTaskTargetError`, or `TypeError` for a reminder without its row id. */
export function taskTarget(ref: SurveyTaskTargetRef, serviceUrls: Record<string, string>): SurveyTaskTarget {
  const params: Record<string, string> = { surveyId: ref.surveyId };
  if (ref.scheduledTaskId !== undefined) params.scheduledTaskId = ref.scheduledTaskId;
  const url = targetUrl(QUEUES[ref.queue], serviceUrls, params);
  return { url, route: new URL(url).pathname };
}

/** Task body payload: `LaunchTaskPayload` for a launch, `ReminderTaskPayload` for a reminder; throws `RangeError` for a reminder without its ordinal. */
export function taskPayload(task: SurveyTaskPayloadSource, scheduledTaskId: string): LaunchTaskPayload | ReminderTaskPayload {
  if (task.kind === 'survey-launch') {
    return { surveyId: task.surveyId, siteId: task.siteId, scheduleVersion: task.scheduleVersion };
  }
  if (task.n === undefined || task.n === null) {
    throw new RangeError(`Reminder task ${scheduledTaskId} of survey ${task.surveyId} has no ordinal`);
  }
  return { scheduledTaskId, surveyId: task.surveyId, n: task.n, scheduleVersion: task.scheduleVersion };
}

/** Parses `opt2-survey-<surveyId>-launch` or `opt2-survey-<surveyId>-reminder-<n>` with a CF UUID survey id; null for any other name. */
export function kindOfLegacyTaskName(name: string): LegacyTaskNameParts | null {
  const groups = LEGACY_TASK_NAME.exec(name)?.groups;
  const surveyId = groups?.surveyId;
  if (surveyId === undefined) return null;
  const ordinal = groups?.n;
  if (ordinal === undefined) return { surveyId, kind: 'survey-launch' };
  const n = Number(ordinal);
  return Number.isSafeInteger(n) ? { surveyId, kind: 'survey-reminder', n } : null;
}
