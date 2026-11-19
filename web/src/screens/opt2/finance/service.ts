// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/finance';
import { assertNotDenied, type GatewayResponse, type WebServiceName } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import financeTransitions from '../../../../../opt2/reports/state-machines/finance.json';
import type { Opt2Module, ScreenContext } from '../../registry';
import {
  alertBox,
  canUse,
  errorMessage,
  opt2ActionUrl,
  opt2Gate,
  opt2Label,
  opt2ScreenUrl,
  stateBadgeOf,
  type Label,
  type Opt2Params,
  type StateDisplay,
} from '../shared';

type Schemas = components['schemas'];

export type FinanceState = Schemas['FinanceState'];
export type FinanceRecord = Schemas['FinanceRecord'];
export type FinanceRecordDetail = Schemas['FinanceRecordDetail'];

export const FINANCE_MODULE: Opt2Module = 'finance';
export const FINANCE_SERVICE: WebServiceName = 'finance';

export const PREPARER = Roles.financePreparer;
export const APPROVER = Roles.financeApprover;

/** Roles finance requires to read records and to post a lifecycle action; which action applies is finance's answer. */
export const READERS = Object.freeze([PREPARER, APPROVER]);

/** Role finance requires to upload an attachment. */
export const UPLOADERS = Object.freeze([PREPARER]);

/** Deny-by-default gate of the screens, the lifecycle actions and the download, by the roles finance requires. */
export const READER_GATE = opt2Gate(READERS);

/** Deny-by-default gate of the upload, by the role finance requires. */
export const UPLOADER_GATE = opt2Gate(UPLOADERS);

/** Lifecycle states in the contract's order. */
export const FINANCE_STATES: readonly FinanceState[] = Object.freeze([
  'IN-PROGRESS',
  'SUBMITTED',
  'RE-SUBMITTED',
  'APPROVED',
  'REJECTED',
]);

/** Label and badge tone of each lifecycle state. */
export const FINANCE_STATE_DISPLAYS: Readonly<Record<FinanceState, StateDisplay>> = Object.freeze({
  'IN-PROGRESS': { label: () => 'In Progress', tone: 'inverse' },
  SUBMITTED: { label: () => 'Submitted', tone: 'info' },
  'RE-SUBMITTED': { label: () => 'Resubmitted', tone: 'info' },
  APPROVED: { label: (ctx) => opt2Label(ctx, 'Approved'), tone: 'success' },
  REJECTED: { label: (ctx) => opt2Label(ctx, 'Rejected'), tone: 'important' },
});

/** Badge of lifecycle state `state` in the session locale of `ctx`. */
export function financeStateBadge(ctx: ScreenContext, state: FinanceState): SafeHtml {
  return stateBadgeOf(ctx, FINANCE_STATE_DISPLAYS, state);
}

/** A lifecycle action without fields and its button label in `ctx`'s locale. */
export interface Transition {
  readonly action: Exclude<Schemas['TransitionAction'], 'edit'>;
  readonly label: (ctx: ScreenContext) => Label;
}

/** The detail screen's transition buttons, in button order. */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  { action: 'submit', label: (ctx) => opt2Label(ctx, 'Submit') },
  { action: 'resubmit', label: () => 'Resubmit' },
  { action: 'approve', label: (ctx) => opt2Label(ctx, 'Approve') },
  { action: 'reject', label: (ctx) => opt2Label(ctx, 'Reject') },
]);

/** The legal rows of finance's exported transition table, generated from its lifecycle definition. */
const LEGAL_TRANSITIONS = Object.freeze(financeTransitions.rows.filter(({ outcome }) => outcome === 'legal'));

/** Whether `action` is legal from `state` for a role the user of `ctx` holds. */
function isLegal(ctx: ScreenContext, state: FinanceState, action: Schemas['TransitionAction']): boolean {
  return LEGAL_TRANSITIONS.some((row) => row.from === state && row.action === action && canUse(ctx.req, [row.role]));
}

/** The buttons of the transitions legal from `state` for a role the user of `ctx` holds, in button order. */
export function legalTransitions(ctx: ScreenContext, state: FinanceState): Transition[] {
  return TRANSITIONS.filter(({ action }) => isLegal(ctx, state, action));
}

/** Whether the user of `ctx` may edit a record in `state`. */
export function canEdit(ctx: ScreenContext, state: FinanceState): boolean {
  return isLegal(ctx, state, 'edit');
}

/** A read's 2xx body, or the alert for an answer the screen shows: invalid input (400) or no such record (404). */
export type ReadResult<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly alert: SafeHtml };

/** A typed facade answer: the contract's success body when `ok`, otherwise the body as relayed. */
type FacadeAnswer<T> = (GatewayResponse<T> & { readonly ok: true }) | (GatewayResponse<unknown> & { readonly ok: false });

const SHOWN_READ_STATUSES: ReadonlySet<number> = new Set([400, 404]);

/** finance's 404 message, which the screens also show for a request naming no record. */
const NOT_FOUND = 'Not Found';

/**
 * The read result of `operation`'s answer.
 * @throws GatewayDenialError On 401 or 403; the handlers answer the access gate's redirect.
 * @throws Error On any other non-2xx status.
 */
export function readResult<T>(res: FacadeAnswer<T>, operation: string): ReadResult<T> {
  if (res.ok) return { ok: true, body: res.body };
  assertNotDenied(res, FINANCE_SERVICE, operation);
  if (!SHOWN_READ_STATUSES.has(res.status)) throw new Error(`${operation} answered HTTP ${res.status}`);
  return { ok: false, alert: alertBox(errorMessage(res)) };
}

/** The read result of a request naming no record, which the service is not asked about. */
export function noRecord<T>(): ReadResult<T> {
  return { ok: false, alert: alertBox(NOT_FOUND) };
}

/** `rc.id`, the record a detail screen or action names; `''` when absent. */
export function requestedId(ctx: ScreenContext): string {
  return ctx.req.rc.id ?? '';
}

/** Session site every finance link carries, so the gateway attaches the token of that site. */
export function sessionSite(ctx: ScreenContext): string {
  return ctx.req.session.siteid;
}

/** Record list URL for the session site. */
export function recordsUrl(ctx: ScreenContext, params: Opt2Params = {}): string {
  return opt2ScreenUrl(FINANCE_MODULE, 'records', { siteid: sessionSite(ctx), ...params });
}

/** Record detail URL of `id` for the session site. */
export function recordUrl(ctx: ScreenContext, id: string): string {
  return opt2ScreenUrl(FINANCE_MODULE, 'record', { siteid: sessionSite(ctx), id });
}

/** Finance post-action URL for the session site. */
export function financeActionUrl(ctx: ScreenContext, action: string, params: Opt2Params): string {
  return opt2ActionUrl(FINANCE_MODULE, action, { siteid: sessionSite(ctx), ...params });
}
