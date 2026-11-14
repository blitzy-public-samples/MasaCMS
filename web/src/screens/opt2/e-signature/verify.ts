// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import { html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { alertBox, block, controlGroup, opt2Gate, opt2View, pageHeader, postForm, textarea } from '../shared';
import {
  ESIGNATURE,
  MISSING_ID,
  VERIFY_ACTION,
  VERIFY_SCREEN,
  actionUrl,
  readOf,
  requestIdOf,
  requestLinks,
  type ESignatureSchemas,
  type Read,
} from './common';

type VerifyResult = ESignatureSchemas['VerifyResult'];

/** The stored chain's verdict and the chain itself, which the copy form starts from. */
export type VerifyData = Read<{ readonly verdict: VerifyResult; readonly chain: ESignatureSchemas['AuditChain'] }>;

/** Extras of a re-rendered verify screen: the service's alert, the supplied copy's verdict and the posted copy. */
export interface VerifyBodyOptions {
  readonly alert?: SafeHtml;
  readonly copy?: VerifyResult;
  readonly entries?: string;
}

/** Roles the contract requires to verify a request's stored chain (`verifyChain`). */
export const VERIFY_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

/** Roles the contract requires to verify a supplied copy of a request's chain (`verifySuppliedChain`). */
export const VERIFY_SUPPLIED_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

const TITLE = 'Verify Audit Chain';
const COPY_ROWS = 12;

/**
 * The service's verdict on request `rc.id`'s stored chain, its audit entries and the copy form's CSRF pair.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadVerify(ctx: ScreenContext): Promise<VerifyData> {
  const id = requestIdOf(ctx.req.rc);
  if (id === '') return MISSING_ID;
  const facade = ctx.gateway.eSignature;
  const [verdict, chain] = await Promise.all([
    facade.call('get', '/v1/esignature/requests/{id}/verify', { params: { id } }),
    facade.call('get', '/v1/esignature/requests/{id}/audit', { params: { id } }),
    // The copy form carries the pair of the request id, the context its verify post belongs to.
    ctx.csrf.prefetch([id]),
  ]);
  const stored = readOf(verdict, 'verifyChain');
  if (stored.body === undefined) return stored;
  const entries = readOf(chain, 'getAuditChain');
  if (entries.body === undefined) return entries;
  return { body: { verdict: stored.body, chain: entries.body } };
}

/** `subject`'s verdict: an info alert when intact, else an error alert naming the first broken entry. */
function verdictAlert(subject: string, verdict: VerifyResult): SafeHtml {
  const count = `${verdict.entries} ${verdict.entries === 1 ? 'entry' : 'entries'}`;
  return verdict.valid
    ? alertBox(`${subject} is intact (${count}).`, 'info')
    : alertBox(`${subject} is broken at entry ${verdict.brokenat} (${count}).`, 'error');
}

/** The copy form: the chain as JSON text, posted to the verify action with the request's CSRF pair. */
function copyForm(ctx: ScreenContext, id: string, entries: string): SafeHtml {
  const field = controlGroup('Audit Chain Copy (JSON)', textarea('entries', entries, COPY_ROWS));
  return postForm(actionUrl(ctx, VERIFY_ACTION, { id }), field, 'Verify Copy', { hidden: ctx.csrf.render(id, 'form') });
}

/** The verify body: header, any alert, the stored chain's verdict, the copy's verdict, then the copy form. */
export function verifyBody(ctx: ScreenContext, data: VerifyData, opts: VerifyBodyOptions = {}): SafeHtml {
  const alert = opts.alert ?? data.alert;
  if (data.body === undefined) return html`${pageHeader(TITLE, requestLinks(ctx, undefined, VERIFY_SCREEN))}${alert}`;
  const id = requestIdOf(ctx.req.rc);
  const { verdict, chain } = data.body;
  const copy = opts.copy === undefined ? null : verdictAlert('The supplied copy', opts.copy);
  const entries = opts.entries ?? JSON.stringify(chain.items, null, 2);
  return html`${pageHeader(TITLE, requestLinks(ctx, id, VERIFY_SCREEN))}${alert}${block(
    html`${verdictAlert('The stored audit chain', verdict)}${copy}${copyForm(ctx, id, entries)}`,
  )}`;
}

/** `/opt2/admin/e-signature/verify`: the service's verification of the stored chain and of a supplied copy. */
export function renderVerify(ctx: ScreenContext, data: VerifyData): ShellView {
  return opt2View(ESIGNATURE, verifyBody(ctx, data));
}

// The copy form needs no role check of its own: verifySuppliedChain and getAuditChain require the gate's roles.
/** The chain verification screen, behind the deny-by-default gate of the contract's roles. */
export const verifyScreen: Opt2ScreenDefinition<VerifyData> = Object.freeze({
  module: ESIGNATURE,
  service: ESIGNATURE,
  screen: VERIFY_SCREEN,
  roles: VERIFY_ROLES,
  gate: opt2Gate(VERIFY_ROLES),
  load: loadVerify,
  render: renderVerify,
});
