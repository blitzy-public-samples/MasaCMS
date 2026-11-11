// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import { defineMapping } from '@opt2/platform/migration-kit';
import { SURVEY_REMINDER } from '../../repo/tables.js';

/** `synthetic.survey_reminder` ↔ `surveys.survey_reminder`; a reminder takes its parent survey's tenant, and its ordinal exists only as the `task_name` suffix. */
export const surveyReminderMapping = defineMapping({
  legacyTable: 'synthetic.survey_reminder',
  // Schema-qualified as defineMapping requires; the migration handlers strip `surveys.` to find SURVEY_REMINDER.table.
  targetTable: `surveys.${SURVEY_REMINDER.table}`,
  unit: SURVEY_REMINDER.unit,
  columns: [
    { legacy: 'reminder_id', target: 'reminder_id', type: 's' },
    { legacy: 'survey_id', target: 'survey_id', type: 's' },
    { legacy: 'offset_minutes', target: 'offset_minutes', type: 'i' },
    { legacy: 'remind_at', target: 'remind_at', type: 't' },
    { legacy: 'task_name', target: 'task_name', type: 's' },
    { legacy: 'task_token_hash', target: 'task_token_hash', type: 's' },
    { legacy: 'sent_at', target: 'sent_at', type: 't' },
  ],
  key: ['reminder_id'],
  tenant: { kind: 'parent', parentLegacyTable: 'synthetic.survey', columns: { survey_id: 'survey_id' } },
});
