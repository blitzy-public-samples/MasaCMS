// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey (re)scheduling as the fixture `surveys.cfc` schedule branch performs it, announced on `surveys.survey.scheduled.v1`. */
import { randomBytes } from 'node:crypto';
import { qualified, sha256Hex, withGatedTenant } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { LegacyApiError, cfDateAdd, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { writeSurveyScheduled } from '../events/survey-scheduled.js';
import type { SurveyScheduledPayload } from '../generated/events/surveys.survey.scheduled.v1.js';
import { FixtureApiError, parseCfInteger } from '../legacy/fixture-envelope.js';
import * as queries from '../repo/queries.js';
import type { ReminderInput, SurveysRepository } from '../repo/repository.js';
import { SURVEY, type SurveyRow } from '../repo/tables.js';
import { SURVEY_STATUS, requireSurvey, type DomainDeps, type SurveyStatus } from './surveys.js';

export { launchTaskName, reminderTaskName } from '../repo/repository.js';

/** Schedule parameters under the fixture's names, each the request value as received. */
export interface ScheduleInput {
  /** Local launch time as `yyyy-MM-ddTHH:mm:ss`. */
  launchAt?: unknown;
  /** Array of `{offsetMinutes}` in ordinal order, or its JSON text; absent or empty schedules no reminder. */
  reminders?: unknown;
}

/** The fixture's schedule response data: the survey detail after the write. */
export type ScheduleResult = queries.SurveyDetail;

const SCHEDULABLE: ReadonlySet<SurveyStatus> = new Set([SURVEY_STATUS.DRAFT, SURVEY_STATUS.SCHEDULED]);
const LAUNCH_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const LAUNCH_AT_MASK = "yyyy-mm-dd'T'HH:nn:ss";
const EVENT_LAUNCH_AT_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";
const ASCII_INTEGER = /^[+-]?[0-9]+$/;
// SQL Server datetime spans 1753-01-01 to 9999-12-31 23:59:59.997.
const MIN_YEAR = 1753;
const LATEST_REMINDER = new Date(9999, 11, 31, 23, 59, 59);
const TOKEN_BYTES = 32;
const DAY_MS = 86_400_000;

/** The fixture's rejection of a malformed schedule parameter. */
function invalidParameters(): LegacyApiError {
  return new LegacyApiError('invalidParameters');
}

/** Local zone offset at instant `t`, in ms east of UTC. */
const offsetAt = (t: number): number => -new Date(t).getTimezoneOffset() * 60_000;

/** Instant of a local wall time (fields read as UTC) as ACF's lenient GregorianCalendar parse resolves it; unlike JS Date, a repeated time takes its later offset. */
function legacyLocalInstant(wall: number): Date {
  const later = offsetAt(wall + DAY_MS);
  return new Date(offsetAt(wall - later) === later ? wall - later : wall - offsetAt(wall - DAY_MS));
}

/** The launch time the fixture accepts: exact local `yyyy-MM-ddTHH:mm:ss` text from 1753 on that does not roll over when parsed. */
function parseLaunchAt(value: unknown): Date {
  if (typeof value !== 'string' || !LAUNCH_AT_PATTERN.test(value) || Number(value.slice(0, 4)) < MIN_YEAR) {
    throw invalidParameters();
  }
  const field = (start: number, length = 2): number => Number(value.slice(start, start + length));
  const launchAt = legacyLocalInstant(Date.UTC(field(0, 4), field(5) - 1, field(8), field(11), field(14), field(17)));
  if (cfDateTimeFormat(launchAt, LAUNCH_AT_MASK) !== value) {
    throw invalidParameters();
  }
  return launchAt;
}

/** The reminder list as the fixture's arrayParam reads it: absent, null or '' is none, JSON text is parsed, anything else must be an array. */
function reminderList(value: unknown): unknown[] {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  let list: unknown = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      throw invalidParameters();
    }
  }
  if (!Array.isArray(list)) {
    throw invalidParameters();
  }
  return list;
}

/** The exact-key `offsetMinutes` of a reminder as text when it is a non-empty simple value (the fixture's allHaveValue); else undefined. */
function offsetText(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item) || !Object.hasOwn(item, 'offsetMinutes')) {
    return undefined;
  }
  const value: unknown = (item as Record<string, unknown>)['offsetMinutes'];
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined;
  }
  const text = String(value);
  return text === '' ? undefined : text;
}

/** Minutes of one offset as the fixture's isValid('integer'), `< 0` and int() treat its text. */
function offsetMinutes(text: string): number {
  const minutes = parseCfInteger(text);
  if (minutes === undefined) {
    throw invalidParameters();
  }
  if (!ASCII_INTEGER.test(text)) {
    // ACF compares non-ASCII digit text with 0 as a string, then its int() rejects it with an Expression error.
    if (text < '0') {
      throw invalidParameters();
    }
    throw new Error('A reminder offset holds non-ASCII digits');
  }
  if (minutes < 0) {
    throw invalidParameters();
  }
  return minutes;
}

/** The validated reminders of a schedule in ordinal order, each due `offsetMinutes` after `launchAt`. */
function reminderInputs(value: unknown, launchAt: Date, taskTokenHash: string): ReminderInput[] {
  const texts = reminderList(value).map(offsetText);
  if (!texts.every((text): text is string => text !== undefined)) {
    throw invalidParameters();
  }
  return texts.map((text) => {
    const minutes = offsetMinutes(text);
    const remindAt = cfDateAdd('n', minutes, launchAt);
    if (remindAt.getTime() > LATEST_REMINDER.getTime()) {
      throw invalidParameters();
    }
    return { offsetMinutes: minutes, remindAt, taskTokenHash };
  });
}

/** Locks the survey row, as the fixture's UPDLOCK read does and with the repository's own lock statement, and returns its status; null when gone. */
function lockedStatus(tx: TenantTx, repository: SurveysRepository, surveyId: string): Promise<SurveyStatus | null> {
  const sql = `SELECT * FROM ${qualified(repository.schema, SURVEY.table)} WHERE survey_id = $1 FOR UPDATE`;
  return repository.read(tx, SURVEY.unit, async () => (await tx.query<SurveyRow>(sql, [surveyId])).rows[0]?.status ?? null);
}

/**
 * Replaces the survey's schedule and reminders, marks it SCHEDULED and writes one `surveys.survey.scheduled.v1` outbox row in one
 * gated transaction; communications creates the tasks from the event. Returns the survey detail the fixture answers with.
 */
export function scheduleSurvey(
  { db, repository }: DomainDeps,
  { tenantId, surveyId, input }: { tenantId: string; surveyId: string; input: ScheduleInput },
): Promise<ScheduleResult> {
  return withGatedTenant(db, tenantId, async (tx) => {
    const survey = await requireSurvey(tx, surveyId);
    const launchAt = parseLaunchAt(input.launchAt);
    // Target tasks call surveys with the tasks-invoker credential, so this token is never presented; its hash fills the fixture column.
    const taskTokenHash = sha256Hex(randomBytes(TOKEN_BYTES).toString('hex'));
    const reminders = reminderInputs(input.reminders, launchAt, taskTokenHash);
    // A launched or closed survey keeps its state: rescheduling it would never launch again.
    const status = await lockedStatus(tx, repository, survey.survey_id);
    if (status === null || !SCHEDULABLE.has(status)) {
      throw new FixtureApiError('conflict');
    }

    const schedule = await repository.upsertSchedule(tx, survey.survey_id, { launchAt, taskTokenHash });
    const stored = await repository.replaceReminders(tx, survey.survey_id, reminders);
    await repository.setSurveyStatus(tx, survey.survey_id, SURVEY_STATUS.SCHEDULED);
    const detail = await queries.getSurvey(tx, survey.survey_id);
    if (detail === null) {
      throw new FixtureApiError('notFound');
    }

    const payload: SurveyScheduledPayload = {
      surveyId: survey.survey_id,
      siteId: survey.siteid,
      scheduleVersion: schedule.schedule_version,
      launchAt: cfDateTimeFormat(launchAt, EVENT_LAUNCH_AT_MASK),
      launchTaskName: schedule.task_name,
      reminders: stored.map((reminder, index) => ({
        n: index + 1,
        offsetMinutes: reminder.offset_minutes,
        taskName: reminder.task_name,
      })),
      targets: detail.targets.map((target) => ({ siteId: target.siteid, groupName: target.group_name })),
    };
    // int8 arrives as a decimal string; the new value is the event's aggregate version.
    await writeSurveyScheduled(tx, { surveyId: survey.survey_id, rowVersion: Number(schedule.row_version), payload });
    return detail;
  });
}
