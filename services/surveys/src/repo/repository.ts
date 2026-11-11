// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only write path of schema `surveys`: the platform repository plus the row writes the fixture `surveys.cfc` performs. */
import { RepositoryError, createRepository, qualified, type Repository, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  OWNED_TABLES,
  SURVEY,
  SURVEY_REMINDER,
  SURVEY_RESPONSE,
  SURVEY_SCHEDULE,
  SURVEY_TARGET,
  type SurveyReminderRow,
  type SurveyResponseRow,
  type SurveyRow,
  type SurveyScheduleRow,
  type SurveyStatus,
  type SurveyTargetRow,
} from './tables.js';

/** Service name the surveys write positions carry. */
export const OWNER = 'surveys';

/** Schema the surveys service owns. */
export const SCHEMA = 'surveys';

const TASK_PREFIX = 'opt2-survey-';

/** Fixture name of a survey's launch task: `opt2-survey-<surveyId>-launch`. */
export function launchTaskName(surveyId: string): string {
  return `${TASK_PREFIX}${surveyId}-launch`;
}

/** Fixture name of a survey's 1-based reminder `n`: `opt2-survey-<surveyId>-reminder-<n>`. */
export function reminderTaskName(surveyId: string, n: number): string {
  return `${TASK_PREFIX}${surveyId}-reminder-${n}`;
}

/** Columns of a new survey that the caller supplies; `siteId` and `createdById` are the token's `site` and `sub`. */
export interface NewSurvey {
  siteId: string;
  title: string;
  createdById: string;
}

/** Optional columns written with a status; `launchedAt` applies to `LAUNCHED` and defaults to the repository clock. */
export interface SurveyStatusExtra {
  launchedAt?: Date;
}

/** Launch time and task-token hash of a (re)schedule. */
export interface ScheduleInput {
  launchAt: Date;
  taskTokenHash: string;
}

/** One reminder of a schedule, in reminder order; its ordinal `n` is its 1-based position. */
export interface ReminderInput {
  offsetMinutes: number;
  remindAt: Date;
  taskTokenHash: string;
}

/** One bulk target; a null `groupName` targets the whole site. */
export interface TargetPair {
  siteId: string;
  groupName: string | null;
}

/** Outcome of `usp_survey_bulk_target`: rows added, and the survey's target count afterwards. */
export interface TargetInsertResult {
  inserted: number;
  total: number;
}

/** A response to store under the survey's site; `answers` is stored exactly as received. */
export interface NewResponse {
  survey: Pick<SurveyRow, 'survey_id' | 'siteid'>;
  respondentSiteId: string;
  respondentUserId: string;
  answers: string;
}

/** The platform repository of schema `surveys` plus the fixture's writes; every helper takes the caller's open tenant transaction. */
export interface SurveysRepository extends Repository {
  /** Inserts a `DRAFT` survey created now. */
  insertSurvey(tx: TenantTx, input: NewSurvey, ctx?: WriteContext): Promise<SurveyRow>;
  /** Sets `status`; `LAUNCHED` also stamps `launched_at` and writes only while it is null. Null when the survey is absent. */
  setSurveyStatus(
    tx: TenantTx,
    surveyId: string,
    status: SurveyStatus,
    extra?: SurveyStatusExtra,
    ctx?: WriteContext,
  ): Promise<SurveyRow | null>;
  /** Inserts the survey's schedule at version 1, or bumps `schedule_version` and `row_version` of the stored one. */
  upsertSchedule(tx: TenantTx, surveyId: string, input: ScheduleInput, ctx?: WriteContext): Promise<SurveyScheduleRow>;
  /** Deletes the survey's reminders, then inserts `reminders` numbered from 1; returns the new rows in order. */
  replaceReminders(tx: TenantTx, surveyId: string, reminders: readonly ReminderInput[], ctx?: WriteContext): Promise<SurveyReminderRow[]>;
  /** Adds the distinct `pairs` the survey does not target yet, as `usp_survey_bulk_target` does. */
  insertTargets(tx: TenantTx, surveyId: string, pairs: readonly TargetPair[], ctx?: WriteContext): Promise<TargetInsertResult>;
  /** Inserts a response created now. */
  insertResponse(tx: TenantTx, input: NewResponse, ctx?: WriteContext): Promise<SurveyResponseRow>;
  /** Stamps `sent_at` of reminder `n` while it is null; returns the reminder, or null when the survey has no reminder `n`. */
  markReminderSent(tx: TenantTx, surveyId: string, n: number, at?: Date, ctx?: WriteContext): Promise<SurveyReminderRow | null>;
}

/** Settings of `createSurveysRepository`; `schema` differs from `surveys` only for throwaway test schemas. */
export interface SurveysRepositoryOptions {
  clock: Clock;
  schema?: string;
}

/** SQL Server's default collation compares text case-insensitively and ignores trailing spaces. */
function collated(value: string): string {
  return value.replace(/ +$/, '').toLowerCase();
}

/** Comparison key of a target; a NULL group matches only another NULL group. */
function targetKey(siteId: string, groupName: string | null): string {
  return JSON.stringify([collated(siteId), groupName === null ? null : collated(groupName)]);
}

/** Builds the surveys repository over the platform repository of `OWNED_TABLES`. */
export function createSurveysRepository({ clock, schema = SCHEMA }: SurveysRepositoryOptions): SurveysRepository {
  const base = createRepository({ owner: OWNER, schema, tables: OWNED_TABLES, clock });
  const lockSurveySql = `SELECT * FROM ${qualified(schema, SURVEY.table)} WHERE survey_id = $1 FOR UPDATE`;
  const scheduleSql = `SELECT * FROM ${qualified(schema, SURVEY_SCHEDULE.table)} WHERE survey_id = $1`;
  const reminderTable = qualified(schema, SURVEY_REMINDER.table);
  const remindersSql = `SELECT reminder_id FROM ${reminderTable} WHERE survey_id = $1 ORDER BY length(task_name), task_name, reminder_id`;
  const reminderByTaskSql = `SELECT * FROM ${reminderTable} WHERE survey_id = $1 AND task_name = $2`;
  const targetsSql = `SELECT siteid, group_name FROM ${qualified(schema, SURVEY_TARGET.table)} WHERE survey_id = $1`;

  /** Locks the survey row before any child row, the order the fixture locks them in; null when absent. */
  function lockSurvey(tx: TenantTx, surveyId: string): Promise<SurveyRow | null> {
    return base.read(tx, SURVEY.unit, async () => (await tx.query<SurveyRow>(lockSurveySql, [surveyId])).rows[0] ?? null);
  }

  /** Locks the survey row that a child row of `table` belongs to; throws RepositoryError when it is absent. */
  async function lockParent(tx: TenantTx, surveyId: string, table: string): Promise<SurveyRow> {
    const survey = await lockSurvey(tx, surveyId);
    if (survey === null) {
      throw new RepositoryError(`survey ${surveyId} does not exist`, table);
    }
    return survey;
  }

  function insertSurvey(tx: TenantTx, { siteId, title, createdById }: NewSurvey, ctx: WriteContext = {}): Promise<SurveyRow> {
    const row: Omit<SurveyRow, 'tenant_id' | 'lastupdate' | 'lastupdatebyid' | 'launched_at'> = {
      survey_id: cfUuid(),
      siteid: siteId,
      title,
      status: 'DRAFT',
      created: clock.now(),
      createdbyid: createdById,
    };
    return base.insert<SurveyRow>(tx, SURVEY.table, row, ctx);
  }

  async function setSurveyStatus(
    tx: TenantTx,
    surveyId: string,
    status: SurveyStatus,
    extra: SurveyStatusExtra = {},
    ctx: WriteContext = {},
  ): Promise<SurveyRow | null> {
    const survey = await lockSurvey(tx, surveyId);
    if (survey === null) {
      return null;
    }
    const patch: Partial<SurveyRow> = {};
    if (status === 'LAUNCHED') {
      // The fixture's launch update matches only `launched_at IS NULL`, so a repeat launch writes nothing.
      if (survey.launched_at !== null) {
        return survey;
      }
      patch.launched_at = extra.launchedAt ?? clock.now();
    }
    if (survey.status !== status) {
      patch.status = status;
    }
    if (Object.keys(patch).length === 0) {
      return survey;
    }
    return base.update<SurveyRow>(tx, SURVEY.table, { survey_id: survey.survey_id }, patch, ctx);
  }

  async function upsertSchedule(
    tx: TenantTx,
    surveyId: string,
    { launchAt, taskTokenHash }: ScheduleInput,
    ctx: WriteContext = {},
  ): Promise<SurveyScheduleRow> {
    const survey = await lockParent(tx, surveyId, SURVEY_SCHEDULE.table);
    const current = await base.read(
      tx,
      SURVEY_SCHEDULE.unit,
      async () => (await tx.query<SurveyScheduleRow>(scheduleSql, [survey.survey_id])).rows[0] ?? null,
    );
    const row = {
      schedule_id: current?.schedule_id ?? cfUuid(),
      survey_id: survey.survey_id,
      launch_at: launchAt,
      schedule_version: (current?.schedule_version ?? 0) + 1,
      task_name: launchTaskName(survey.survey_id),
      task_token_hash: taskTokenHash,
      // `created` is the first schedule's time; a reschedule keeps it, as the fixture's update does.
      ...(current === null ? { created: clock.now() } : {}),
      // int8 arrives as a decimal string; the new value is the scheduled event's aggregate version.
      row_version: Number(current?.row_version ?? 0) + 1,
    } satisfies Partial<Record<keyof SurveyScheduleRow, unknown>>;
    return base.upsert<SurveyScheduleRow>(tx, SURVEY_SCHEDULE.table, row, ctx);
  }

  async function replaceReminders(
    tx: TenantTx,
    surveyId: string,
    reminders: readonly ReminderInput[],
    ctx: WriteContext = {},
  ): Promise<SurveyReminderRow[]> {
    const survey = await lockParent(tx, surveyId, SURVEY_REMINDER.table);
    const existing = await base.read(
      tx,
      SURVEY_REMINDER.unit,
      async () => (await tx.query<Pick<SurveyReminderRow, 'reminder_id'>>(remindersSql, [survey.survey_id])).rows,
    );
    for (const { reminder_id } of existing) {
      await base.delete(tx, SURVEY_REMINDER.table, { reminder_id }, ctx);
    }
    const stored: SurveyReminderRow[] = [];
    for (const [index, reminder] of reminders.entries()) {
      const row: Omit<SurveyReminderRow, 'tenant_id'> = {
        reminder_id: cfUuid(),
        survey_id: survey.survey_id,
        offset_minutes: reminder.offsetMinutes,
        remind_at: reminder.remindAt,
        task_name: reminderTaskName(survey.survey_id, index + 1),
        task_token_hash: reminder.taskTokenHash,
        sent_at: null,
      };
      stored.push(await base.insert<SurveyReminderRow>(tx, SURVEY_REMINDER.table, row, ctx));
    }
    return stored;
  }

  async function insertTargets(
    tx: TenantTx,
    surveyId: string,
    pairs: readonly TargetPair[],
    ctx: WriteContext = {},
  ): Promise<TargetInsertResult> {
    const survey = await lockParent(tx, surveyId, SURVEY_TARGET.table);
    const existing = await base.read(
      tx,
      SURVEY_TARGET.unit,
      async () => (await tx.query<Pick<SurveyTargetRow, 'siteid' | 'group_name'>>(targetsSql, [survey.survey_id])).rows,
    );
    const targeted = new Set(existing.map((target) => targetKey(target.siteid, target.group_name)));
    const created = clock.now();
    let inserted = 0;
    for (const { siteId, groupName } of pairs) {
      const key = targetKey(siteId, groupName);
      if (targeted.has(key)) {
        continue;
      }
      targeted.add(key);
      const row: Omit<SurveyTargetRow, 'tenant_id'> = {
        target_id: cfUuid(),
        survey_id: survey.survey_id,
        siteid: siteId,
        group_name: groupName,
        created,
      };
      await base.insert(tx, SURVEY_TARGET.table, row, ctx);
      inserted += 1;
    }
    return { inserted, total: existing.length + inserted };
  }

  function insertResponse(
    tx: TenantTx,
    { survey, respondentSiteId, respondentUserId, answers }: NewResponse,
    ctx: WriteContext = {},
  ): Promise<SurveyResponseRow> {
    const row: Omit<SurveyResponseRow, 'tenant_id'> = {
      response_id: cfUuid(),
      survey_id: survey.survey_id,
      siteid: survey.siteid,
      respondentsiteid: respondentSiteId,
      respondent_user_id: respondentUserId,
      answers,
      created: clock.now(),
    };
    return base.insert<SurveyResponseRow>(tx, SURVEY_RESPONSE.table, row, ctx);
  }

  async function markReminderSent(
    tx: TenantTx,
    surveyId: string,
    n: number,
    at: Date = clock.now(),
    ctx: WriteContext = {},
  ): Promise<SurveyReminderRow | null> {
    const survey = await lockSurvey(tx, surveyId);
    if (survey === null) {
      return null;
    }
    const reminder = await base.read(
      tx,
      SURVEY_REMINDER.unit,
      async () =>
        (await tx.query<SurveyReminderRow>(reminderByTaskSql, [survey.survey_id, reminderTaskName(survey.survey_id, n)])).rows[0] ?? null,
    );
    if (reminder === null || reminder.sent_at !== null) {
      return reminder;
    }
    return base.update<SurveyReminderRow>(tx, SURVEY_REMINDER.table, { reminder_id: reminder.reminder_id }, { sent_at: at }, ctx);
  }

  return Object.freeze({
    ...base,
    insertSurvey,
    setSurveyStatus,
    upsertSchedule,
    replaceReminders,
    insertTargets,
    insertResponse,
    markReminderSent,
  });
}
