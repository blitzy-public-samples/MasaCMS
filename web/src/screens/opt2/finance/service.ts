// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles } from '@opt2/platform/auth';
import type { components } from '@/generated/clients/finance';
import { assertNotDenied, type GatewayResponse, type WebServiceName } from '@/lib/gateway-client';
import type { SafeHtml } from '@/lib/html';
import type { Opt2Module, ScreenContext } from '../../registry';
import { alertBox, errorMessage, opt2ActionUrl, opt2Gate, opt2ScreenUrl, type Opt2Params } from '../shared';

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

/** A lifecycle action without fields, the role whose holders see its button, and the button label. */
export interface Transition {
  readonly action: Exclude<Schemas['TransitionAction'], 'edit'>;
  readonly label: string;
  readonly role: typeof PREPARER | typeof APPROVER;
}

/** The detail screen's transition buttons; the finance service decides whether each applies to the record. */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  { action: 'submit', label: 'Submit', role: PREPARER },
  { action: 'resubmit', label: 'Resubmit', role: PREPARER },
  { action: 'approve', label: 'Approve', role: APPROVER },
  { action: 'reject', label: 'Reject', role: APPROVER },
]);

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
