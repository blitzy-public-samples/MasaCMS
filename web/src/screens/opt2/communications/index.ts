// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../../registry';
import { deliveryStatusScreen } from './delivery-status';
import { sendAction, sendsScreen } from './sends';
import { saveTemplateAction, templatesScreen } from './templates';

/** Communications screens: templates, sends and delivery status. */
export const communicationsScreens: readonly Opt2ScreenDefinition[] = Object.freeze([
  templatesScreen,
  sendsScreen,
  deliveryStatusScreen,
]);

/** Communications post actions: store a template and send a message. */
export const communicationsActions: readonly Opt2ActionDefinition[] = Object.freeze([saveTemplateAction, sendAction]);
