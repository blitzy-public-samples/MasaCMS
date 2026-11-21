// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/e-signature';
import { okBody, type GatewayResponse } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Rc, ScreenContext } from '../../registry';
import {
  alertBox,
  errorMessage,
  invalidParametersAlert,
  isMalformedId,
  opt2ActionUrl,
  opt2Label,
  opt2ScreenUrl,
  stateBadgeOf,
  type HeaderLink,
  type Label,
  type Opt2Params,
  type StateDisplay,
} from '../shared';

export type ESignatureSchemas = components['schemas'];

export type RequestState = ESignatureSchemas['RequestState'];

/** The module slug, which is also the owning service's name. */
export const ESIGNATURE = 'e-signature';

export const REQUESTS_SCREEN = 'requests';
export const REQUEST_SCREEN = 'request';
export const AUDIT_SCREEN = 'audit';
export const VERIFY_SCREEN = 'verify';
export const SIGN_ACTION = 'sign';
export const VERIFY_ACTION = 'verify';

/** Roles the contract requires to list and to sign requests. */
export const SIGNER_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner]);

/** Roles the contract requires to read a request, its audit chain and its verification; which requests is the service's answer. */
export const READER_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

/** A read's 2xx body, or the alert its refusal renders in place of the screen content. */
export type Read<T> =
  | { readonly body: T; readonly alert?: undefined }
  | { readonly body?: undefined; readonly alert: SafeHtml };

/** The read of a screen reached without a request id or with a malformed one, worded as the service answers it. */
export const MISSING_ID: Read<never> = Object.freeze({ alert: invalidParametersAlert() });

/** Whether request id `id` is one the screens ask e-signature about: present and well formed. */
export function isRequestId(id: string): boolean {
  return id !== '' && !isMalformedId(id);
}

/** `rc.id`, the request a screen or action is about; '' when absent. */
export function requestIdOf(rc: Rc): string {
  return rc.id ?? '';
}

/** `rc.pageIndex` when it is a whole number from 1, else the first page. */
export function pageIndexOf(rc: Rc): number {
  const requested = Number(rc.pageIndex);
  return Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
}

/** `params` after the session site, which the gateway mints the user token for, for links, forms and redirects. */
export function siteParams(ctx: ScreenContext, params: Opt2Params = {}): Opt2Params {
  return { siteid: ctx.req.session.siteid, ...params };
}

/** URL of the e-signature screen `screen` on the session site. */
export function screenUrl(ctx: ScreenContext, screen: string, params: Opt2Params = {}): string {
  return opt2ScreenUrl(ESIGNATURE, screen, siteParams(ctx, params));
}

/** URL of the e-signature post action `action` on the session site. */
export function actionUrl(ctx: ScreenContext, action: string, params: Opt2Params = {}): string {
  return opt2ActionUrl(ESIGNATURE, action, siteParams(ctx, params));
}

/** Label and badge tone of each request state. */
const REQUEST_STATES: Readonly<Record<RequestState, StateDisplay>> = Object.freeze({
  PENDING: { label: (ctx) => opt2Label(ctx, 'Pending'), tone: 'info' },
  SIGNED: { label: () => 'Signed', tone: 'success' },
});

/** Badge of request state `state` in the session locale of `ctx`. */
export function requestStateBadge(ctx: ScreenContext, state: RequestState): SafeHtml {
  return stateBadgeOf(ctx, REQUEST_STATES, state);
}

/** Link to `href` with `text`, encoded unless it is a bundle label. */
export function link(href: string, text: Label): SafeHtml {
  return html`<a${attr('href', href)}>${text}</a>`;
}

/** The screens of one request, in header-link order. */
export const REQUEST_PAGES = [
  { screen: REQUEST_SCREEN, label: 'Signature Request' },
  { screen: AUDIT_SCREEN, label: 'Audit Chain' },
  { screen: VERIFY_SCREEN, label: 'Verify' },
] as const;

/** Header links: the request list, then the other screens of request `id` when it was read. */
export function requestLinks(ctx: ScreenContext, id: string | undefined, current: string): HeaderLink[] {
  const list: HeaderLink = { label: 'Signature Requests', href: screenUrl(ctx, REQUESTS_SCREEN) };
  if (id === undefined) return [list];
  const others = REQUEST_PAGES.filter((page) => page.screen !== current);
  return [list, ...others.map((page) => ({ label: page.label, href: screenUrl(ctx, page.screen, { id }) }))];
}

/**
 * The 2xx body of `operation`, or the envelope error as an alert when e-signature answers 400 or 404.
 * @throws GatewayDenialError For 401 or 403; any other status throws `Error`.
 */
export function readOf<T>(
  response: { readonly ok: true; readonly body: T } | (GatewayResponse & { readonly ok: false }),
  operation: string,
): Read<T> {
  if (!response.ok && (response.status === 400 || response.status === 404)) {
    return { alert: alertBox(errorMessage(response)) };
  }
  return { body: okBody(response, ESIGNATURE, operation) };
}
