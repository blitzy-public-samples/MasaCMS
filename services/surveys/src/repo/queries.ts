// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Gated reads of schema `surveys` with the fixture `surveys.cfc` filters, order and column selection; every helper takes the caller's open tenant transaction. */
import { createRepository, qualified, type Repository } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { isMatchableSurveyId } from './grants.js';
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

/** A survey with its schedule (null when never scheduled) and reminders in ordinal order, without its targets. */
export interface SurveySummary extends SurveyScheduling {
  survey: SurveyRow;
}

/** A survey with its schedule (null when never scheduled), reminders in ordinal order and targets by site, group and id. */
export interface SurveyDetail extends SurveySummary {
  targets: SurveyTargetView[];
}

/** Default page size of a survey's target list. */
export const TARGET_PAGE_DEFAULT = 100;

/** Largest page size of a survey's target list, and the batch size of a whole-list read. */
export const TARGET_PAGE_MAX = 1000;

/** A target's place in the target order: lower-cased site, whether it names a group, lower-cased group ('' for none) and id. */
export type TargetKey = [site: string, grouped: boolean, group: string, targetId: string];

/** A target page: at most `limit` targets after the target keyed `after`, from the first when absent. */
export interface TargetPageRequest {
  limit: number;
  after?: TargetKey | undefined;
}

/** One page of a survey's targets and the key of its last target, null when no target follows. */
export interface SurveyTargetPage {
  rows: SurveyTargetView[];
  next: TargetKey | null;
}

/** A reminder's offset and task name, its place in the fixture's task order. */
export type ReminderTaskKey = Pick<SurveyReminderRow, 'offset_minutes' | 'task_name'>;

/** A batch of a survey's reminder keys: at most `limit` after the offset and task name `after`, from the first when absent. */
export interface ReminderTaskKeyRequest {
  limit: number;
  after?: readonly [offsetMinutes: number, taskName: string] | undefined;
}

/** A target view with its sort key columns, as a page statement selects it. */
type KeyedTargetView = SurveyTargetView & { key_site: string; key_grouped: boolean; key_group: string };

// SQL Server's default collation compares text case-insensitively and ignores trailing spaces.
const SITE_MATCH = 'lower(rtrim(siteid)) = lower(rtrim($1))';
// SQL Server sorts text case-insensitively and NULL lowest; "C" keeps the lower-cased order the same on every server.
const TARGET_KEY_SITE = 'lower(siteid) COLLATE "C"';
const TARGET_KEY_GROUPED = '(group_name IS NOT NULL)';
const TARGET_KEY_GROUP = `coalesce(lower(group_name), '') COLLATE "C"`;
const TARGET_KEY = `${TARGET_KEY_SITE}, ${TARGET_KEY_GROUPED}, ${TARGET_KEY_GROUP}, target_id COLLATE "C"`;
const TARGET_ORDER = `ORDER BY ${TARGET_KEY}`;
const TARGET_PAGE_COLUMNS =
  `${TARGET_VIEW_COLUMNS.join(', ')}, ` +
  `${TARGET_KEY_SITE} AS key_site, ${TARGET_KEY_GROUPED} AS key_grouped, ${TARGET_KEY_GROUP} AS key_group`;
// The reminder ordinal exists only as the task_name suffix, so a shorter name has a lower ordinal.
const REMINDER_ORDER = 'ORDER BY length(task_name), task_name, reminder_id';
// The fixture task order: offset, then name by UTF-16 code unit, which "C" gives the ASCII task names.
const REMINDER_TASK_KEY = 'offset_minutes, task_name COLLATE "C"';

// survey_id is char(35), so the ids are bound as bpchar and the (tenant_id, survey_id) indexes stay usable.
const SURVEY_IDS_MATCH = 'survey_id = ANY($1::bpchar[])';

const DETAIL_UNITS: readonly string[] = [SURVEY.unit, SURVEY_SCHEDULE.unit, SURVEY_REMINDER.unit, SURVEY_TARGET.unit];
const SUMMARY_UNITS: readonly string[] = [SURVEY.unit, SURVEY_SCHEDULE.unit, SURVEY_REMINDER.unit];
const TARGET_LIST_UNITS: readonly string[] = [SURVEY.unit, SURVEY_TARGET.unit];
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
  readonly reminderTaskKeys: string;
  readonly reminderTaskKeysAfter: string;
  readonly targetPage: string;
  readonly targetPageAfter: string;
  readonly siteTargeted: string;
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
    reminderTaskKeys: `SELECT offset_minutes, task_name FROM ${reminder} WHERE survey_id = $1 ORDER BY ${REMINDER_TASK_KEY} LIMIT $2`,
    reminderTaskKeysAfter:
      `SELECT offset_minutes, task_name FROM ${reminder} WHERE survey_id = $1 ` +
      `AND (${REMINDER_TASK_KEY}) > ($3::integer, $4::text) ORDER BY ${REMINDER_TASK_KEY} LIMIT $2`,
    targetPage: `SELECT ${TARGET_PAGE_COLUMNS} FROM ${target} WHERE survey_id = $1 ${TARGET_ORDER} LIMIT $2`,
    targetPageAfter:
      `SELECT ${TARGET_PAGE_COLUMNS} FROM ${target} WHERE survey_id = $1 ` +
      `AND (${TARGET_KEY}) > ($3::text, $4::boolean, $5::text, $6::bpchar) ${TARGET_ORDER} LIMIT $2`,
    siteTargeted: `SELECT EXISTS (SELECT 1 FROM ${target} WHERE survey_id = $1 AND lower(rtrim(siteid)) = lower(rtrim($2))) AS targeted`,
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

/** The survey row with `surveyId`; null when the tenant has none, unqueried for an id no stored survey can have. */
export function findSurvey(tx: TenantTx, surveyId: string): Promise<SurveyRow | null> {
  const { repository } = readsFor(tx);
  if (!isMatchableSurveyId(surveyId)) {
    return repository.read(tx, SURVEY.unit, () => Promise.resolve(null));
  }
  return repository.findByKey<SurveyRow>(tx, SURVEY.table, { survey_id: surveyId });
}

/** The survey with its schedule and reminders in the fixture detail's columns and order, without targets; null when the tenant has no such survey. */
export function getSurveySummary(tx: TenantTx, surveyId: string): Promise<SurveySummary | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, SUMMARY_UNITS, async () => {
    const survey = await findSurvey(tx, surveyId);
    if (survey === null) {
      return null;
    }
    const id = [survey.survey_id];
    const schedule = (await tx.query<SurveyScheduleView>(reads.scheduleView, id)).rows[0] ?? null;
    const reminders = (await tx.query<SurveyReminderView>(reads.reminderViews, id)).rows;
    return { survey, schedule, reminders };
  });
}

/** The survey with its schedule, reminders and targets in the fixture detail's columns and order; null when the tenant has no such survey. */
export function getSurvey(tx: TenantTx, surveyId: string): Promise<SurveyDetail | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, DETAIL_UNITS, async () => {
    const summary = await getSurveySummary(tx, surveyId);
    if (summary === null) {
      return null;
    }
    return { ...summary, targets: await allTargets(tx, reads, summary.survey.survey_id) };
  });
}

/** Up to `limit` of the stored survey's targets after `after` in target order, read as `limit + 1` rows to learn whether more follow. */
async function targetPage(
  tx: TenantTx,
  reads: SchemaReads,
  surveyId: string,
  { limit, after }: TargetPageRequest,
): Promise<SurveyTargetPage> {
  const { rows } =
    after === undefined
      ? await tx.query<KeyedTargetView>(reads.targetPage, [surveyId, limit + 1])
      : await tx.query<KeyedTargetView>(reads.targetPageAfter, [surveyId, limit + 1, ...after]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map(({ key_site: _site, key_grouped: _grouped, key_group: _group, ...view }) => view),
    next: rows.length > limit && last !== undefined ? [last.key_site, last.key_grouped, last.key_group, last.target_id] : null,
  };
}

/** Every target of the stored survey in target order, read in pages of TARGET_PAGE_MAX. */
async function allTargets(tx: TenantTx, reads: SchemaReads, surveyId: string): Promise<SurveyTargetView[]> {
  const targets: SurveyTargetView[] = [];
  let after: TargetKey | undefined;
  do {
    const page = await targetPage(tx, reads, surveyId, { limit: TARGET_PAGE_MAX, after });
    targets.push(...page.rows);
    after = page.next ?? undefined;
  } while (after !== undefined);
  return targets;
}

/** One page of the survey's targets in target order, in the fixture detail's columns; null when the tenant has no such survey. */
export function listTargetPage(tx: TenantTx, surveyId: string, page: TargetPageRequest): Promise<SurveyTargetPage | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, TARGET_LIST_UNITS, async () => {
    const survey = await findSurvey(tx, surveyId);
    return survey === null ? null : targetPage(tx, reads, survey.survey_id, page);
  });
}

/** Whether the survey targets `siteId`, whole or by group, compared as SQL Server's collation compares sites. */
export function targetsSite(tx: TenantTx, surveyId: string, siteId: string): Promise<boolean> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    SURVEY_TARGET.unit,
    async () => (await tx.query<{ targeted: boolean }>(reads.siteTargeted, [surveyId, siteId])).rows[0]?.targeted === true,
  );
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

/** Up to `limit` of the stored survey's reminders by offset, then task name by code unit, after `after`; the keys only. */
export function listReminderTaskKeys(tx: TenantTx, surveyId: string, { limit, after }: ReminderTaskKeyRequest): Promise<ReminderTaskKey[]> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, SURVEY_REMINDER.unit, async () => {
    const { rows } =
      after === undefined
        ? await tx.query<ReminderTaskKey>(reads.reminderTaskKeys, [surveyId, limit])
        : await tx.query<ReminderTaskKey>(reads.reminderTaskKeysAfter, [surveyId, limit, ...after]);
    return rows;
  });
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
