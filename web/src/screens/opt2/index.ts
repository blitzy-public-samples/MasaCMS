// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../registry';
import { communicationsActions, communicationsScreens } from './communications';
import { esignatureActions, esignatureScreens } from './e-signature';
import { financeActions, financeScreens } from './finance';
import { reportingActions, reportingScreens } from './reporting';
import { surveysActions, surveysScreens } from './surveys';
import { timesheetsActions, timesheetsScreens } from './timesheets';

/** Every synthetic-module screen, module by module in the OPT-2 nav's order. */
export const opt2Screens: readonly Opt2ScreenDefinition[] = Object.freeze([
  ...timesheetsScreens,
  ...financeScreens,
  ...esignatureScreens,
  ...reportingScreens,
  ...surveysScreens,
  ...communicationsScreens,
]);

/** Every synthetic-module post action, in the same module order. */
export const opt2Actions: readonly Opt2ActionDefinition[] = Object.freeze([
  ...timesheetsActions,
  ...financeActions,
  ...esignatureActions,
  ...reportingActions,
  ...surveysActions,
  ...communicationsActions,
]);
