// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { STATUS_CODES } from 'node:http';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
} from '@opt2/platform/legacy-compat';
import {
  GatewayDenialError,
  GatewayUnavailableError,
  isUnavailable,
  type GatewayClient,
  type GatewayResponse,
  type WebServiceName,
} from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext, SubmitResult } from '../../registry';
import { alertBox } from './markup';
import { opt2ScreenUrl, type Opt2Params } from './paths';
import { opt2View } from './view';

/** The screen a submit returns to: redirected to after the write, re-rendered when the service rejects it. */
export interface Opt2Back {
  module: Opt2Module;
  screen: string;
  params?: Opt2Params;
}

/** The one service write of a submit. */
export interface Opt2Write<T = unknown> {
  service: WebServiceName;
  /** Sends the write through `gateway`, with `csrfHeaders` among its request headers. */
  call(gateway: GatewayClient, csrfHeaders: Readonly<Record<string, string>>): Promise<GatewayResponse<T>>;
}

/** Envelope errors the screen shows as an alert: invalid input, forbidden, not found and an illegal transition. */
const ALERT_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409]);

/** The posted CSRF pair as the `X-csrf_token` request headers; `{}` when no token was posted. */
export function csrfHeadersFrom(form: Readonly<Record<string, unknown>>): Record<string, string> {
  const token = form[CSRF_FIELD_TOKEN];
  if (typeof token !== 'string' || token === '') return {};
  const expires = form[CSRF_FIELD_EXPIRES];
  return { [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: typeof expires === 'string' ? expires : '' };
}

/** The envelope's `error.message`, else its `error.code`, else the HTTP status text. */
export function errorMessage(res: GatewayResponse): string {
  const error = (res.body as { error?: { message?: unknown; code?: unknown } } | null | undefined)?.error;
  if (typeof error?.message === 'string') return error.message;
  if (typeof error?.code === 'string') return error.code;
  return STATUS_CODES[res.status] ?? String(res.status);
}

/**
 * Sends `write` with the posted CSRF pair, then redirects to `back` on 2xx, or re-renders `back` with the envelope
 * error in an alert on 400, 403, 404 or 409.
 * @param rerender Receives the alert and returns the screen body re-rendered with it and the posted values.
 * @throws GatewayUnavailableError When the service is unavailable; the handlers answer the legacy admin 503.
 * @throws GatewayDenialError On 401; the handlers answer the access gate's login redirect.
 * @throws Error On any other status.
 */
export async function submitToService(
  ctx: ScreenContext,
  write: Opt2Write,
  back: Opt2Back,
  rerender: (alert: SafeHtml) => SafeHtml | Promise<SafeHtml>,
): Promise<SubmitResult> {
  // Legacy validateCSRFTokens reads the pair from the merged event scope, so the token is taken from rc.
  const res = await write.call(ctx.gateway, csrfHeadersFrom(ctx.req.rc));
  if (isUnavailable(res)) throw new GatewayUnavailableError(write.service, res.status);
  if (res.status >= 200 && res.status < 300) {
    return { kind: 'location', location: opt2ScreenUrl(back.module, back.screen, back.params) };
  }
  // 401 refuses the user token, not the write, so it gets the access gate's login redirect, as on every admin screen.
  if (res.status === 401) throw new GatewayDenialError(write.service, `${write.service} write`, 401);
  if (!ALERT_STATUSES.has(res.status)) throw new Error(`${write.service} write failed with ${res.status}`);
  const body = await rerender(alertBox(errorMessage(res)));
  return { kind: 'render', view: opt2View(back.module, body) };
}
