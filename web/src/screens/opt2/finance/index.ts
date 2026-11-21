// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { FINANCE_ACTIONS } from './actions';
import { loadRecord, renderRecordView, type RecordData } from './record';
import { recordsScreen } from './records';
import { FINANCE_MODULE, FINANCE_SERVICE, READERS, READER_GATE, requestedId } from './service';

const ACCESS = Object.freeze({
  module: FINANCE_MODULE,
  roles: READERS,
  service: FINANCE_SERVICE,
  gate: READER_GATE,
});

const recordScreen: Opt2ScreenDefinition<RecordData> = Object.freeze({
  ...ACCESS,
  screen: 'record',
  load: (ctx: ScreenContext) => loadRecord(ctx, requestedId(ctx)),
  render: renderRecordView,
});

/** The finance screens: the record list (the OPT-2 nav's Finance entry) and the record detail. */
export const financeScreens: readonly Opt2ScreenDefinition[] = Object.freeze([recordsScreen, recordScreen]);

/** The finance post actions: the lifecycle buttons, edit, attachment upload and signed download. */
export const financeActions: readonly Opt2ActionDefinition[] = FINANCE_ACTIONS;
