// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../../registry';
import { surveysListScreen } from './list';
import { responsesScreen } from './responses';
import { scheduleAction, scheduleScreen } from './schedule';
import { bulkTargetAction, targetsScreen } from './targets';

/** Surveys screens: survey list, schedule (launch and reminders), bulk targeting and responses. */
export const surveysScreens: readonly Opt2ScreenDefinition[] = Object.freeze([
  surveysListScreen,
  scheduleScreen,
  targetsScreen,
  responsesScreen,
]);

/** Surveys post actions: schedule and bulk targeting. */
export const surveysActions: readonly Opt2ActionDefinition[] = Object.freeze([scheduleAction, bulkTargetAction]);
