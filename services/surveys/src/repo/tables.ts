// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Owned tables of schema `surveys`, one per fixture table `synthetic.survey*`, as the platform repository declares them. */
import type { CanonicalColumn, TableDefinition } from '@opt2/platform/migration-kit';

/** Units of write authority of schema `surveys`, in declaration order. */
export const UNITS = [
  'surveys.survey',
  'surveys.survey_schedule',
  'surveys.survey_reminder',
  'surveys.survey_target',
  'surveys.survey_response',
] as const;

/** One surveys unit id. */
export type SurveyUnit = (typeof UNITS)[number];

/** Values of `survey.status`; a new survey is `DRAFT`. */
export const SURVEY_STATUSES = ['DRAFT', 'SCHEDULED', 'LAUNCHED', 'CLOSED'] as const;

/** One survey status. */
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

/** A surveys table definition: always keyed and always gated by its own unit. */
export interface SurveyTableDefinition extends TableDefinition {
  key: string[];
  unit: SurveyUnit;
}

const TENANT_ID: CanonicalColumn = { name: 'tenant_id', type: 's' };

/** `surveys.survey`, from `synthetic.survey`. */
export const SURVEY: SurveyTableDefinition = {
  table: 'survey',
  columns: [
    TENANT_ID,
    { name: 'survey_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'title', type: 's' },
    { name: 'status', type: 's' },
    { name: 'created', type: 't' },
    { name: 'createdbyid', type: 's' },
    { name: 'lastupdate', type: 't' },
    { name: 'lastupdatebyid', type: 's' },
    { name: 'launched_at', type: 't' },
  ],
  key: ['survey_id'],
  unit: 'surveys.survey',
};

/** `surveys.survey_schedule`, from `synthetic.survey_schedule`, plus the target-only `row_version`. */
export const SURVEY_SCHEDULE: SurveyTableDefinition = {
  table: 'survey_schedule',
  columns: [
    TENANT_ID,
    { name: 'schedule_id', type: 's' },
    { name: 'survey_id', type: 's' },
    { name: 'launch_at', type: 't' },
    { name: 'schedule_version', type: 'i' },
    { name: 'task_name', type: 's' },
    { name: 'task_token_hash', type: 's' },
    { name: 'created', type: 't' },
    { name: 'row_version', type: 'i' },
  ],
  key: ['schedule_id'],
  unit: 'surveys.survey_schedule',
};

/** `surveys.survey_reminder`, from `synthetic.survey_reminder`. */
export const SURVEY_REMINDER: SurveyTableDefinition = {
  table: 'survey_reminder',
  columns: [
    TENANT_ID,
    { name: 'reminder_id', type: 's' },
    { name: 'survey_id', type: 's' },
    { name: 'offset_minutes', type: 'i' },
    { name: 'remind_at', type: 't' },
    { name: 'task_name', type: 's' },
    { name: 'task_token_hash', type: 's' },
    { name: 'sent_at', type: 't' },
  ],
  key: ['reminder_id'],
  unit: 'surveys.survey_reminder',
};

/** `surveys.survey_target`, from `synthetic.survey_target`. */
export const SURVEY_TARGET: SurveyTableDefinition = {
  table: 'survey_target',
  columns: [
    TENANT_ID,
    { name: 'target_id', type: 's' },
    { name: 'survey_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'group_name', type: 's' },
    { name: 'created', type: 't' },
  ],
  key: ['target_id'],
  unit: 'surveys.survey_target',
};

/** `surveys.survey_response`, from `synthetic.survey_response`; `answers` is byte-exact text. */
export const SURVEY_RESPONSE: SurveyTableDefinition = {
  table: 'survey_response',
  columns: [
    TENANT_ID,
    { name: 'response_id', type: 's' },
    { name: 'survey_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'respondentsiteid', type: 's' },
    { name: 'respondent_user_id', type: 's' },
    { name: 'answers', type: 's' },
    { name: 'created', type: 't' },
  ],
  key: ['response_id'],
  unit: 'surveys.survey_response',
};

/** Every owned table, in `UNITS` order; the `tables` of the surveys repository. */
export const OWNED_TABLES: readonly SurveyTableDefinition[] = [SURVEY, SURVEY_SCHEDULE, SURVEY_REMINDER, SURVEY_TARGET, SURVEY_RESPONSE];

/** Columns per table that exist only in the target and are never mapped to or from legacy. */
export const TARGET_ONLY_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  survey_schedule: ['row_version'],
};

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** A `surveys.survey` row as pg returns it. */
export type SurveyRow = {
  tenant_id: string;
  survey_id: string;
  siteid: string;
  title: string;
  status: SurveyStatus;
  created: Date;
  createdbyid: string;
  lastupdate: Date | null;
  lastupdatebyid: string | null;
  launched_at: Date | null;
};

/** A `surveys.survey_schedule` row as pg returns it. */
export type SurveyScheduleRow = {
  tenant_id: string;
  schedule_id: string;
  survey_id: string;
  launch_at: Date;
  schedule_version: number;
  task_name: string;
  task_token_hash: string;
  created: Date;
  /** int8, which pg returns as a decimal string. */
  row_version: string;
};

/** A `surveys.survey_reminder` row as pg returns it. */
export type SurveyReminderRow = {
  tenant_id: string;
  reminder_id: string;
  survey_id: string;
  offset_minutes: number;
  remind_at: Date;
  task_name: string;
  task_token_hash: string;
  sent_at: Date | null;
};

/** A `surveys.survey_target` row as pg returns it. */
export type SurveyTargetRow = {
  tenant_id: string;
  target_id: string;
  survey_id: string;
  siteid: string;
  group_name: string | null;
  created: Date;
};

/** A `surveys.survey_response` row as pg returns it. */
export type SurveyResponseRow = {
  tenant_id: string;
  response_id: string;
  survey_id: string;
  siteid: string;
  respondentsiteid: string;
  respondent_user_id: string;
  answers: string;
  created: Date;
};
