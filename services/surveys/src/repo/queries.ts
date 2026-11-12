// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Gated reads of schema `surveys` with the fixture `surveys.cfc` filters, order and column selection; every helper takes the caller's open tenant transaction. */
import { createRepository, qualified, type Repository } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { OWNER } from './repository.js';
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
  type SurveyTargetRow,
} from './tables.js';

/** The fixture list's site filter and its validated envelope.cfc page. */
export interface SurveyListFilters {
  siteId: string;
  pageIndex: number;
  itemsPerPage: number;
}

/** One page of surveys and the count of every survey the filter matches. */
export interface SurveyPage {
  rows: SurveyRow[];
  total: number;
}

/** One page of a survey's responses and the count of all its responses. */
export interface SurveyResponsePage {
  rows: SurveyResponseRow[];
  total: number;
}

const SCHEDULE_VIEW_COLUMNS = ['schedule_id', 'survey_id', 'launch_at', 'schedule_version', 'task_name', 'created'] as const;
const REMINDER_VIEW_COLUMNS = ['reminder_id', 'survey_id', 'offset_minutes', 'remind_at', 'task_name', 'sent_at'] as const;
const TARGET_VIEW_COLUMNS = ['target_id', 'survey_id', 'siteid', 'group_name', 'created'] as const;

/** A schedule as the fixture detail selects it, without the task-token hash or the target-only `row_version`. */
export type SurveyScheduleView = Pick<SurveyScheduleRow, (typeof SCHEDULE_VIEW_COLUMNS)[number]>;

/** A reminder as the fixture selects it, without the task-token hash. */
export type SurveyReminderView = Pick<SurveyReminderRow, (typeof REMINDER_VIEW_COLUMNS)[number]>;

/** A target as the fixture detail selects it. */
export type SurveyTargetView = Pick<SurveyTargetRow, (typeof TARGET_VIEW_COLUMNS)[number]>;

/** A survey's schedule (null when never scheduled) and its reminders in ordinal order. */
export interface SurveyScheduling {
  schedule: SurveyScheduleView | null;
  reminders: SurveyReminderView[];
}

/** A survey with its schedule (null when never scheduled), reminders in ordinal order and targets by site, group and id. */
export interface SurveyDetail {
  survey: SurveyRow;
  schedule: SurveyScheduleView | null;
  reminders: SurveyReminderView[];
  targets: SurveyTargetView[];
}

// SQL Server's default collation compares text case-insensitively and ignores trailing spaces.
const SITE_MATCH = 'lower(rtrim(siteid)) = lower(rtrim($1))';
// SQL Server sorts text case-insensitively and NULL lowest; "C" keeps the lower-cased order the same on every server.
const TARGET_ORDER = 'ORDER BY lower(siteid) COLLATE "C", lower(group_name) COLLATE "C" NULLS FIRST, target_id';
// The reminder ordinal exists only as the task_name suffix, so a shorter name has a lower ordinal.
const REMINDER_ORDER = 'ORDER BY length(task_name), task_name, reminder_id';

// survey_id is char(35), so the ids are bound as bpchar and the (tenant_id, survey_id) indexes stay usable.
const SURVEY_IDS_MATCH = 'survey_id = ANY($1::bpchar[])';

const DETAIL_UNITS: readonly string[] = [SURVEY.unit, SURVEY_SCHEDULE.unit, SURVEY_REMINDER.unit, SURVEY_TARGET.unit];
const SCHEDULING_UNITS: readonly string[] = [SURVEY_SCHEDULE.unit, SURVEY_REMINDER.unit];

interface SchemaReads {
  readonly repository: Repository;
  readonly countSurveys: string;
  readonly surveyPage: string;
  readonly schedule: string;
  readonly scheduleView: string;
  readonly scheduleViewsOf: string;
  readonly reminderViews: string;
  readonly reminderViewsOf: string;
  readonly targets: string;
  readonly targetViews: string;
  readonly countResponses: string;
  readonly responsePage: string;
}

const readsBySchema = new Map<string, SchemaReads>();

/** The read repository and statements of `schema`. */
function prepareReads(schema: string): SchemaReads {
  const survey = qualified(schema, SURVEY.table);
  const schedule = qualified(schema, SURVEY_SCHEDULE.table);
  const reminder = qualified(schema, SURVEY_REMINDER.table);
  const target = qualified(schema, SURVEY_TARGET.table);
  const response = qualified(schema, SURVEY_RESPONSE.table);
  return Object.freeze({
    repository: createRepository({ owner: OWNER, schema, tables: OWNED_TABLES }),
    countSurveys: `SELECT count(*)::integer AS total FROM ${survey} WHERE ${SITE_MATCH}`,
    surveyPage: `SELECT * FROM ${survey} WHERE ${SITE_MATCH} ORDER BY created, survey_id OFFSET $2 LIMIT $3`,
    schedule: `SELECT * FROM ${schedule} WHERE survey_id = $1`,
    scheduleView: `SELECT ${SCHEDULE_VIEW_COLUMNS.join(', ')} FROM ${schedule} WHERE survey_id = $1`,
    scheduleViewsOf: `SELECT ${SCHEDULE_VIEW_COLUMNS.join(', ')} FROM ${schedule} WHERE ${SURVEY_IDS_MATCH}`,
    reminderViews: `SELECT ${REMINDER_VIEW_COLUMNS.join(', ')} FROM ${reminder} WHERE survey_id = $1 ${REMINDER_ORDER}`,
    reminderViewsOf: `SELECT ${REMINDER_VIEW_COLUMNS.join(', ')} FROM ${reminder} WHERE ${SURVEY_IDS_MATCH} ${REMINDER_ORDER}`,
    targets: `SELECT * FROM ${target} WHERE survey_id = $1 ${TARGET_ORDER}`,
    targetViews: `SELECT ${TARGET_VIEW_COLUMNS.join(', ')} FROM ${target} WHERE survey_id = $1 ${TARGET_ORDER}`,
    countResponses: `SELECT count(*)::integer AS total FROM ${response} WHERE survey_id = $1`,
    responsePage: `SELECT * FROM ${response} WHERE survey_id = $1 ORDER BY created, response_id OFFSET $2 LIMIT $3`,
  });
}

/** The reads of the transaction's schema, which is `surveys` except in throwaway test schemas. */
function readsFor(tx: TenantTx): SchemaReads {
  let reads = readsBySchema.get(tx.schema);
  if (reads === undefined) {
    reads = prepareReads(tx.schema);
    readsBySchema.set(tx.schema, reads);
  }
  return reads;
}

/** One page of the site's surveys by creation time and id, with the matching total; the page is read only when it starts before the total. */
export function listSurveys(tx: TenantTx, filters: SurveyListFilters): Promise<SurveyPage> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, SURVEY.unit, async () => {
    const counted = await tx.query<{ total: number }>(reads.countSurveys, [filters.siteId]);
    const total = counted.rows[0]?.total ?? 0;
    const offset = (filters.pageIndex - 1) * filters.itemsPerPage;
    if (offset >= total) {
      return { rows: [], total };
    }
    const { rows } = await tx.query<SurveyRow>(reads.surveyPage, [filters.siteId, offset, filters.itemsPerPage]);
    return { rows, total };
  });
}

/** The survey row with `surveyId`; null when the tenant has none. */
export function findSurvey(tx: TenantTx, surveyId: string): Promise<SurveyRow | null> {
  return readsFor(tx).repository.findByKey<SurveyRow>(tx, SURVEY.table, { survey_id: surveyId });
}

/** The survey with its schedule, reminders and targets in the fixture detail's columns and order; null when the tenant has no such survey. */
export function getSurvey(tx: TenantTx, surveyId: string): Promise<SurveyDetail | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, DETAIL_UNITS, async () => {
    const survey = await findSurvey(tx, surveyId);
    if (survey === null) {
      return null;
    }
    const id = [survey.survey_id];
    const schedule = (await tx.query<SurveyScheduleView>(reads.scheduleView, id)).rows[0] ?? null;
    const reminders = (await tx.query<SurveyReminderView>(reads.reminderViews, id)).rows;
    const targets = (await tx.query<SurveyTargetView>(reads.targetViews, id)).rows;
    return { survey, schedule, reminders, targets };
  });
}

/** The survey's stored schedule row; null when it was never scheduled. */
export function getSchedule(tx: TenantTx, surveyId: string): Promise<SurveyScheduleRow | null> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    SURVEY_SCHEDULE.unit,
    async () => (await tx.query<SurveyScheduleRow>(reads.schedule, [surveyId])).rows[0] ?? null,
  );
}

/** The survey's reminders in ordinal order, in the fixture's columns. */
export function listReminders(tx: TenantTx, surveyId: string): Promise<SurveyReminderView[]> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    SURVEY_REMINDER.unit,
    async () => (await tx.query<SurveyReminderView>(reads.reminderViews, [surveyId])).rows,
  );
}

/** Each of `surveyIds` with its schedule (null when never scheduled) and ordinal-ordered reminders, read in two statements; no ids read nothing. */
export function listSchedulings(tx: TenantTx, surveyIds: readonly string[]): Promise<Map<string, SurveyScheduling>> {
  const byId = new Map<string, SurveyScheduling>(surveyIds.map((id) => [id, { schedule: null, reminders: [] }]));
  if (byId.size === 0) {
    return Promise.resolve(byId);
  }
  const reads = readsFor(tx);
  return reads.repository.read(tx, SCHEDULING_UNITS, async () => {
    const ids = [[...byId.keys()]];
    for (const schedule of (await tx.query<SurveyScheduleView>(reads.scheduleViewsOf, ids)).rows) {
      const scheduling = byId.get(schedule.survey_id);
      if (scheduling !== undefined) {
        scheduling.schedule = schedule;
      }
    }
    for (const reminder of (await tx.query<SurveyReminderView>(reads.reminderViewsOf, ids)).rows) {
      byId.get(reminder.survey_id)?.reminders.push(reminder);
    }
    return byId;
  });
}

/** The survey's stored target rows by site, group (a whole-site target first) and id. */
export function listTargets(tx: TenantTx, surveyId: string): Promise<SurveyTargetRow[]> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, SURVEY_TARGET.unit, async () => (await tx.query<SurveyTargetRow>(reads.targets, [surveyId])).rows);
}

/** One page of the survey's stored responses by creation time and id, `answers` exactly as stored, with their total. */
export function listResponses(
  tx: TenantTx,
  surveyId: string,
  page: { pageIndex: number; itemsPerPage: number },
): Promise<SurveyResponsePage> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, SURVEY_RESPONSE.unit, async () => {
    const counted = await tx.query<{ total: number }>(reads.countResponses, [surveyId]);
    const total = counted.rows[0]?.total ?? 0;
    const offset = (page.pageIndex - 1) * page.itemsPerPage;
    if (offset >= total) {
      return { rows: [], total };
    }
    const { rows } = await tx.query<SurveyResponseRow>(reads.responsePage, [surveyId, offset, page.itemsPerPage]);
    return { rows, total };
  });
}
