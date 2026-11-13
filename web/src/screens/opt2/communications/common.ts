// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/communications';
import type { WebServiceName } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext } from '../../registry';
import { opt2ActionUrl, opt2Gate, opt2ScreenUrl, pageHeader, type Opt2Params } from '../shared';

type Schemas = components['schemas'];

export type MessageTemplate = Schemas['MessageTemplate'];
export type Message = Schemas['Message'];
export type MessageDetail = Schemas['MessageDetail'];
export type MessageState = Schemas['MessageState'];

/** Paging fields of a templates or messages page. */
export type ListPage = Pick<Schemas['FixtureList'], 'pageindex' | 'totalpages'>;

export const MODULE = 'communications' satisfies Opt2Module;

export const SERVICE: WebServiceName = 'communications';

/** Role every communications `/v1/` route requires. */
export const SENDER_ROLES: readonly Role[] = Object.freeze([Roles.communicationsSender]);

export const SENDER_GATE = opt2Gate(SENDER_ROLES);

/** CSRF context of the template and message collections, as the fixture validates their writes. */
export const CSRF_CONTEXT = '';

const STATE_LABELS: Readonly<Record<MessageState, string>> = Object.freeze({
  queued: 'Queued',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
});

/** Label of a delivery state. */
export function stateLabel(state: MessageState): string {
  return STATE_LABELS[state];
}

/** URL of a communications screen on the session site. */
export function screenUrl(ctx: ScreenContext, screen: string, params: Opt2Params = {}): string {
  return opt2ScreenUrl(MODULE, screen, { siteid: ctx.req.session.siteid, ...params });
}

/** URL of a communications post action on the session site. */
export function actionUrl(ctx: ScreenContext, action: string): string {
  return opt2ActionUrl(MODULE, action, { siteid: ctx.req.session.siteid });
}

/** Module header titled `title`, linking the Templates and Sends screens. */
export function moduleHeader(ctx: ScreenContext, title: string): SafeHtml {
  return pageHeader(title, [
    { label: 'Templates', href: screenUrl(ctx, 'templates') },
    { label: 'Sends', href: screenUrl(ctx, 'sends') },
  ]);
}

/** A `btn` link. */
export function buttonLink(label: string, href: string): SafeHtml {
  return html`<a class="btn"${attr('href', href)}>${label}</a>`;
}

/** The requested `pageIndex` when it is a positive integer; otherwise none, which the service reads as page 1. */
export function requestedPage(ctx: ScreenContext): number | undefined {
  const value = ctx.req.rc['pageIndex'];
  return value !== undefined && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : undefined;
}

/** Previous and Next links of a list `screen` with more than one page, else nothing. */
export function pager(ctx: ScreenContext, screen: string, page: ListPage): SafeHtml | null {
  if (page.totalpages <= 1) return null;
  const link = (label: string, pageIndex: number): SafeHtml => buttonLink(label, screenUrl(ctx, screen, { pageIndex }));
  const previous = page.pageindex > 1 ? link('Previous', page.pageindex - 1) : null;
  const next = page.pageindex < page.totalpages ? link('Next', page.pageindex + 1) : null;
  return html`<div class="nav-module-specific btn-group">${previous}${next}</div>`;
}

/** The posted value of each of `names`, `''` when absent. */
export function postedFields<K extends string>(ctx: ScreenContext, names: readonly K[]): Record<K, string> {
  const fields = {} as Record<K, string>;
  for (const name of names) fields[name] = ctx.req.rc[name] ?? '';
  return fields;
}
