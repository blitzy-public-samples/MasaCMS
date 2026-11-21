// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../../registry';
import { opt2Gate } from '../shared';
import { DAY_ACTION, SHEET_SCREEN, SHEETS_SCREEN, TIMESHEETS, TIMESHEETS_ROLES } from './common';
import { submitDayAction } from './day-action';
import { loadSheet, renderSheet, type SheetData } from './sheet';
import { loadSheets, renderSheets, type SheetsData } from './sheets';

const ACCESS = Object.freeze({
  module: TIMESHEETS,
  roles: TIMESHEETS_ROLES,
  service: TIMESHEETS,
  gate: opt2Gate(TIMESHEETS_ROLES),
});

const sheetsScreen: Opt2ScreenDefinition<SheetsData> = Object.freeze({
  ...ACCESS,
  screen: SHEETS_SCREEN,
  load: loadSheets,
  render: renderSheets,
});

const sheetScreen: Opt2ScreenDefinition<SheetData> = Object.freeze({
  ...ACCESS,
  screen: SHEET_SCREEN,
  load: loadSheet,
  render: renderSheet,
});

const dayActionDefinition: Opt2ActionDefinition = Object.freeze({
  ...ACCESS,
  action: DAY_ACTION,
  submit: submitDayAction,
});

/** The timesheets screens: the sheet list (the OPT-2 nav entry) and the sheet detail. */
export const timesheetsScreens: readonly Opt2ScreenDefinition[] = Object.freeze([sheetsScreen, sheetScreen]);

/** The timesheets post actions: the day lifecycle action. */
export const timesheetsActions: readonly Opt2ActionDefinition[] = Object.freeze([dayActionDefinition]);
