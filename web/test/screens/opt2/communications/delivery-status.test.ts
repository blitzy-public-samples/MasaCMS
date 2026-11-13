// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import {
  deliveryStatusBody,
  deliveryStatusScreen,
  loadDeliveryStatus,
} from '@/screens/opt2/communications/delivery-status';
import { COMMUNICATIONS_IDS, messageDetail } from '../../../fixtures/opt2/communications';
import { useTestEnv } from '../../../helpers/env';
import { routeKey } from '../../../helpers/fake-gateway';
import { NOT_FOUND_ANSWER, bodyModel, communicationsCalls, screenContext, senderRequest } from './context';

const DELIVERED_ID = COMMUNICATIONS_IDS.messages.delivered;
const FAILED_ID = COMMUNICATIONS_IDS.messages.failed;
const FAILED_ROUTE = routeKey('GET', 'communications', `/v1/messages/${FAILED_ID}`);

const NOT_FOUND_ALERT = [{ text: 'Not Found', className: 'alert alert-error' }];

const ABSENT_IDS = [{ rc: {} }, { rc: { messageId: '' } }];

const failedDetail = {
  ...messageDetail,
  message_id: FAILED_ID,
  to_address: 'casey.lee@seed.opt2.test',
  subject: 'Welcome to <Tenant A>, Casey',
  state: 'failed' as const,
  sent_at: '',
  history: [
    { ...messageDetail.history[0]!, message_id: FAILED_ID },
    {
      status_id: 'C0330003-0000-0000-0000000000000007',
      message_id: FAILED_ID,
      status: 'failed' as const,
      detail: 'smtp-error',
      mailpit_id: '',
      recorded_at: '2026-06-30T08:10:01',
    },
  ],
};

describe('communications delivery-status screen', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('renders the message and its delivery history in service order', async () => {
    const ctx = screenContext(senderRequest({ rc: { messageId: DELIVERED_ID } }));
    const view = await deliveryStatusScreen.render(ctx, await deliveryStatusScreen.load(ctx));

    expect(view.opt2Module).toBe('communications');
    expect(bodyModel(view.body)).toMatchSnapshot();
    expect(communicationsCalls(ctx.gateway)).toEqual([
      { service: 'communications', method: 'GET', path: `/v1/messages/${DELIVERED_ID}` },
    ]);
  });

  it('shows a failed send with its failure detail, encoding service text', async () => {
    const ctx = screenContext(senderRequest({ rc: { messageId: FAILED_ID } }), {
      [FAILED_ROUTE]: { status: 200, body: { data: failedDetail } },
    });
    const body = deliveryStatusBody(ctx, await loadDeliveryStatus(ctx));
    const [summary, history] = bodyModel(body).tables;

    expect(summary?.rows).toEqual([
      [failedDetail.to_address, failedDetail.from_address, failedDetail.subject, 'Failed', failedDetail.created, ''],
    ]);
    expect(history?.rows).toEqual([
      ['Queued', '', '', '2026-06-29T09:00:00'],
      ['Failed', 'smtp-error', '', '2026-06-30T08:10:01'],
    ]);
    expect(toString(body)).toContain('Welcome to &lt;Tenant A&gt;, Casey');
  });

  it('shows the empty-history message for a message without status rows', async () => {
    const ctx = screenContext(senderRequest({ rc: { messageId: FAILED_ID } }), {
      [FAILED_ROUTE]: { status: 200, body: { data: { ...failedDetail, history: [] } } },
    });

    expect(toString(deliveryStatusBody(ctx, await loadDeliveryStatus(ctx)))).toContain(
      '<div class="help-block-empty">There is no delivery history.</div>',
    );
  });

  it.each(ABSENT_IDS)('answers Not Found without a service call for rc $rc', async ({ rc }) => {
    const ctx = screenContext(senderRequest({ rc }));
    const model = bodyModel(deliveryStatusBody(ctx, await loadDeliveryStatus(ctx)));

    expect(model.alerts).toEqual(NOT_FOUND_ALERT);
    expect(model.tables).toEqual([]);
    expect(communicationsCalls(ctx.gateway)).toEqual([]);
  });

  it('answers Not Found for a message the service does not find for the site', async () => {
    const ctx = screenContext(senderRequest({ rc: { messageId: FAILED_ID } }), { [FAILED_ROUTE]: NOT_FOUND_ANSWER });
    const model = bodyModel(deliveryStatusBody(ctx, await loadDeliveryStatus(ctx)));

    expect(model.alerts).toEqual(NOT_FOUND_ALERT);
    expect(model.headings).toEqual(['Delivery Status']);
    expect(communicationsCalls(ctx.gateway)).toEqual([
      { service: 'communications', method: 'GET', path: `/v1/messages/${FAILED_ID}` },
    ]);
  });

  it('encodes the requested id into the service path', async () => {
    const ctx = screenContext(senderRequest({ rc: { messageId: '../templates?x=1' } }));
    await loadDeliveryStatus(ctx);

    expect(communicationsCalls(ctx.gateway)[0]?.path).toBe('/v1/messages/..%2Ftemplates%3Fx%3D1');
  });

  it.each([
    { status: 401, error: GatewayDenialError },
    { status: 403, error: GatewayDenialError },
    { status: 503, error: GatewayUnavailableError },
    { status: 400, error: Error },
  ])('fails the load on a $status answer', async ({ status, error }) => {
    const ctx = screenContext(senderRequest({ rc: { messageId: FAILED_ID } }), { [FAILED_ROUTE]: { status } });

    await expect(loadDeliveryStatus(ctx)).rejects.toBeInstanceOf(error);
  });
});
