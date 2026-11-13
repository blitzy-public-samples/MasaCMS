// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { multipartRelay } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { Opt2ActionDefinition, ScreenContext, SubmitResult } from '../../registry';
import { submitToService, type Opt2Back, type Opt2Write } from '../shared';
import { loadRecord, renderRecord, type EditValues } from './record';
import {
  FINANCE_MODULE,
  FINANCE_SERVICE,
  READERS,
  READER_GATE,
  TRANSITIONS,
  UPLOADERS,
  UPLOADER_GATE,
  requestedId,
  sessionSite,
  type Transition,
} from './service';

/** The detail screen of `id`, which a write redirects to or re-renders with finance's alert. */
const detailOf = (ctx: ScreenContext, id: string): Opt2Back => ({
  module: FINANCE_MODULE,
  screen: 'record',
  params: { siteid: sessionSite(ctx), id },
});

/** Re-renders the detail of `id` around a refused write's alert, with the posted edit fields when given. */
const rerenderDetail =
  (ctx: ScreenContext, id: string, edit?: EditValues) =>
  async (alert: SafeHtml): Promise<SafeHtml> =>
    renderRecord(ctx, await loadRecord(ctx, id), { alert, edit });

/** The finance call of one submit; `submitToService` hands it the posted CSRF pair as headers. */
const financeWrite = (call: Opt2Write['call']): Opt2Write => ({ service: FINANCE_SERVICE, call });

/** Posts lifecycle `action` for `rc.id`; finance decides by the record's state and the user's roles. */
function submitTransition(action: Transition['action']): (ctx: ScreenContext) => Promise<SubmitResult> {
  return (ctx) => {
    const id = requestedId(ctx);
    const write = financeWrite((gateway, headers) =>
      gateway.finance.call('post', '/v1/finance/records/{id}/transitions/{action}', { params: { id, action }, headers }),
    );
    return submitToService(ctx, write, detailOf(ctx, id), rerenderDetail(ctx, id));
  };
}

/** Posts `edit` for `rc.id` with the posted title, amount and period as typed; finance validates them. */
export async function submitEdit(ctx: ScreenContext): Promise<SubmitResult> {
  const id = requestedId(ctx);
  const { rc } = ctx.req;
  const edit: EditValues = { title: rc.title ?? '', amount: rc.amount ?? '', period: rc.period ?? '' };
  const write = financeWrite((gateway, headers) =>
    gateway.finance.call('post', '/v1/finance/records/{id}/transitions/{action}', {
      params: { id, action: 'edit' },
      json: edit,
      headers,
    }),
  );
  return submitToService(ctx, write, detailOf(ctx, id), rerenderDetail(ctx, id, edit));
}

/** Relays the posted body unchanged as an attachment of `rc.id`; finance answers a body without a file part. */
export async function submitUpload(ctx: ScreenContext): Promise<SubmitResult> {
  const id = requestedId(ctx);
  const relay = ctx.body === undefined ? undefined : multipartRelay(ctx.body);
  const write = financeWrite((gateway, headers) =>
    gateway.finance.call('post', '/v1/finance/records/{id}/attachments', {
      params: { id },
      body: relay?.body,
      headers: { ...headers, ...relay?.headers },
    }),
  );
  return submitToService(ctx, write, detailOf(ctx, id), rerenderDetail(ctx, id));
}

/**
 * Sends the browser to a fresh signed URL of attachment `rc.aid` of `rc.id`, never reading the bytes itself; finance's
 * 400 or 404 re-renders the detail with its alert.
 */
export async function submitDownload(ctx: ScreenContext): Promise<SubmitResult> {
  const id = requestedId(ctx);
  const aid = ctx.req.rc.aid ?? '';
  let signedUrl: string | undefined;
  const result = await submitToService(
    ctx,
    // Issuing the URL is a read, so the posted CSRF pair is not sent.
    financeWrite(async (gateway) => {
      const response = await gateway.finance.call('get', '/v1/finance/records/{id}/attachments/{aid}/download-url', {
        params: { id, aid },
      });
      if (response.ok) signedUrl = response.body.data.url;
      return response;
    }),
    detailOf(ctx, id),
    rerenderDetail(ctx, id),
  );
  // submitToService answers every refusal itself; a success returns to the detail, which the signed URL replaces.
  return signedUrl === undefined ? result : { kind: 'location', location: signedUrl };
}

const READER_ACTION = Object.freeze({ module: FINANCE_MODULE, roles: READERS, service: FINANCE_SERVICE, gate: READER_GATE });

/** Every finance post action: the four lifecycle buttons, edit, upload and the signed download. */
export const FINANCE_ACTIONS: readonly Opt2ActionDefinition[] = Object.freeze([
  ...TRANSITIONS.map(({ action }): Opt2ActionDefinition =>
    Object.freeze({ ...READER_ACTION, action, submit: submitTransition(action) }),
  ),
  Object.freeze({ ...READER_ACTION, action: 'edit', submit: submitEdit }),
  Object.freeze({
    module: FINANCE_MODULE,
    roles: UPLOADERS,
    service: FINANCE_SERVICE,
    gate: UPLOADER_GATE,
    action: 'upload',
    submit: submitUpload,
  }),
  Object.freeze({ ...READER_ACTION, action: 'download', submit: submitDownload }),
]);
