// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { okBody } from '@/lib/gateway-client';
import { html, type SafeHtml } from '@/lib/html';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { alertBox, block, gridTable, opt2View } from '../shared';
import { MODULE, SENDER_GATE, SENDER_ROLES, SERVICE, moduleHeader, stateLabel, type MessageDetail } from './common';

/** The requested message with its delivery history, or none when the site has no such message. */
export interface DeliveryStatusData {
  readonly message?: MessageDetail;
}

/** Alert of a request naming no message of the site, worded as the service's `notFound` envelope. */
const NOT_FOUND = 'Not Found';

/** The message named by `messageId` (`getMessage`); none for an absent id or the service's 404. */
export async function loadDeliveryStatus(ctx: ScreenContext): Promise<DeliveryStatusData> {
  const messageId = ctx.req.rc['messageId'] ?? '';
  if (messageId === '') return {};
  const response = await ctx.gateway.communications.call('get', '/v1/messages/{messageId}', { params: { messageId } });
  if (response.status === 404) return {};
  return { message: okBody(response, SERVICE, 'getMessage').data };
}

/** The message's addressing and state, then its delivery-status history in service order. */
export function deliveryStatusBody(ctx: ScreenContext, data: DeliveryStatusData): SafeHtml {
  const header = moduleHeader(ctx, 'Delivery Status');
  const { message } = data;
  if (message === undefined) return html`${header}${alertBox(NOT_FOUND)}`;
  const { to_address, from_address, subject, state, created, sent_at } = message;
  const summary = gridTable(
    ['To', 'From', 'Subject', 'State', 'Created', 'Sent'],
    [[to_address, from_address, subject, stateLabel(state), created, sent_at]],
    '',
  );
  const history = gridTable(
    ['Status', 'Detail', 'Mailpit ID', 'Recorded'],
    message.history.map((entry) => [stateLabel(entry.status), entry.detail, entry.mailpit_id, entry.recorded_at]),
    'There is no delivery history.',
  );
  return html`${header}${block(summary)}${block(html`<h2>History</h2>${history}`)}`;
}

export const deliveryStatusScreen: Opt2ScreenDefinition<DeliveryStatusData> = Object.freeze({
  module: MODULE,
  screen: 'delivery-status',
  roles: SENDER_ROLES,
  service: SERVICE,
  gate: SENDER_GATE,
  load: loadDeliveryStatus,
  render: (ctx: ScreenContext, data: DeliveryStatusData) => opt2View(MODULE, deliveryStatusBody(ctx, data)),
});
