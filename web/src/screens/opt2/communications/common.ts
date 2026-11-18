// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/communications';
import type { WebServiceName } from '@/lib/gateway-client';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext } from '../../registry';
import {
  opt2ActionUrl,
  opt2Gate,
  opt2Label,
  opt2ScreenUrl,
  pageHeader,
  stateBadgeOf,
  type Label,
  type Opt2Params,
  type StateDisplay,
} from '../shared';

type Schemas = components['schemas'];

export type MessageTemplate = Schemas['MessageTemplate'];
export type Message = Schemas['Message'];
export type MessageDetail = Schemas['MessageDetail'];
export type MessageState = Schemas['MessageState'];

/** Paging fields of a templates or messages page. */
export type ListPage = Pick<Schemas['FixtureList'], 'pageindex' | 'totalpages' | 'totalitems' | 'itemsperpage'>;

export const MODULE = 'communications' satisfies Opt2Module;

export const SERVICE: WebServiceName = 'communications';

/** Role every communications `/v1/` route requires. */
export const SENDER_ROLES: readonly Role[] = Object.freeze([Roles.communicationsSender]);

export const SENDER_GATE = opt2Gate(SENDER_ROLES);

/** CSRF context of the template and message collections, as the fixture validates their writes. */
export const CSRF_CONTEXT = '';

/** Label and badge tone of each delivery state; delivered and failed have no admin-bundle key. */
const MESSAGE_STATES: Readonly<Record<MessageState, StateDisplay>> = Object.freeze({
  queued: { label: (ctx) => opt2Label(ctx, 'Queued'), tone: 'info' },
  sent: { label: (ctx) => opt2Label(ctx, 'Sent'), tone: 'info' },
  delivered: { label: () => 'Delivered', tone: 'success' },
  failed: { label: () => 'Failed', tone: 'important' },
});

/** Badge of a delivery state in the session locale of `ctx`. */
export function messageStateBadge(ctx: ScreenContext, state: MessageState): SafeHtml {
  return stateBadgeOf(ctx, MESSAGE_STATES, state);
}

/** URL of a communications screen on the session site. */
export function screenUrl(ctx: ScreenContext, screen: string, params: Opt2Params = {}): string {
  return opt2ScreenUrl(MODULE, screen, { siteid: ctx.req.session.siteid, ...params });
}

/** URL of a communications post action on the session site. */
export function actionUrl(ctx: ScreenContext, action: string): string {
  return opt2ActionUrl(MODULE, action, { siteid: ctx.req.session.siteid });
}

/** Module header titled `title`, linking the Templates and Sends screens with the `current` one marked active. */
export function moduleHeader(ctx: ScreenContext, title: string, current?: 'templates' | 'sends'): SafeHtml {
  return pageHeader(title, [
    { label: 'Templates', href: screenUrl(ctx, 'templates'), active: current === 'templates' },
    { label: 'Sends', href: screenUrl(ctx, 'sends'), active: current === 'sends' },
  ]);
}

/** A `btn` link. */
export function buttonLink(label: Label, href: string): SafeHtml {
  return html`<a class="btn"${attr('href', href)}>${label}</a>`;
}

/** The requested `pageIndex` when it is a positive integer; otherwise none, which the service reads as page 1. */
export function requestedPage(ctx: ScreenContext): number | undefined {
  const value = ctx.req.rc['pageIndex'];
  return value !== undefined && /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : undefined;
}

/** The posted value of each of `names`, `''` when absent. */
export function postedFields<K extends string>(ctx: ScreenContext, names: readonly K[]): Record<K, string> {
  const fields = {} as Record<K, string>;
  for (const name of names) fields[name] = ctx.req.rc[name] ?? '';
  return fields;
}
