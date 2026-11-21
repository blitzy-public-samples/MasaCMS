// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../../registry';
import { downloadAction, queueAction } from './actions';
import { exportsScreen } from './exports';

/** The reporting screens: the export job list. */
export const reportingScreens: readonly Opt2ScreenDefinition[] = Object.freeze([exportsScreen]);

/** The reporting post actions: queue an export, and hand off a done job's signed download. */
export const reportingActions: readonly Opt2ActionDefinition[] = Object.freeze([queueAction, downloadAction]);
