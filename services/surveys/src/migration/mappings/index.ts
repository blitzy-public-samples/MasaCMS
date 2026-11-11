// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Mapping } from '@opt2/platform/migration-kit';
import { surveyMapping } from './survey.js';
import { surveyScheduleMapping } from './survey-schedule.js';
import { surveyReminderMapping } from './survey-reminder.js';
import { surveyTargetMapping } from './survey-target.js';
import { surveyResponseMapping } from './survey-response.js';

export { surveyMapping } from './survey.js';
export { surveyScheduleMapping } from './survey-schedule.js';
export { surveyReminderMapping } from './survey-reminder.js';
export { surveyTargetMapping } from './survey-target.js';
export { surveyResponseMapping } from './survey-response.js';

/** The surveys mappings, parent before children, one per unit in `UNITS` order. */
export const MAPPINGS: readonly Mapping[] = Object.freeze([
  surveyMapping,
  surveyScheduleMapping,
  surveyReminderMapping,
  surveyTargetMapping,
  surveyResponseMapping,
]);
