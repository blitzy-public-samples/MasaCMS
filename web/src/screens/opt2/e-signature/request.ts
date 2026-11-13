// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import { block, canUse, controlGroup, gridTable, opt2View, pageHeader, postForm, textInput } from '../shared';
import {
  ESIGNATURE,
  MISSING_ID,
  REQUEST_SCREEN,
  SIGN_ACTION,
  SIGNER_ROLES,
  actionUrl,
  readOf,
  requestIdOf,
  requestLinks,
  type ESignatureSchemas,
  type Read,
} from './common';

type SignatureRequestDetail = ESignatureSchemas['SignatureRequestDetail'];

/** A request with its signature. */
export type RequestData = Read<SignatureRequestDetail>;

/** Extras of a re-rendered request: the service's alert and the posted typed name. */
export interface RequestBodyOptions {
  readonly alert?: SafeHtml;
  readonly typedName?: string;
}

const TITLE = 'Signature Request';
const SUMMARY_HEADERS: readonly string[] = ['Document', 'State', 'Signer', 'Created', 'Created By', 'Document SHA-256'];
const SIGNATURE_HEADERS: readonly string[] = ['Typed Name', 'Signed By', 'Signed At'];

/** Whether the request takes the typed-name form: still PENDING and the token holds the signer role. */
function signable(ctx: ScreenContext, detail: SignatureRequestDetail): boolean {
  return detail.state === 'PENDING' && canUse(ctx.req, SIGNER_ROLES);
}

/**
 * Request `rc.id` with its signature, with the sign form's CSRF pair issued when it is signable.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadRequest(ctx: ScreenContext): Promise<RequestData> {
  const id = requestIdOf(ctx.req.rc);
  if (id === '') return MISSING_ID;
  const response = await ctx.gateway.eSignature.call('get', '/v1/esignature/requests/{id}', { params: { id } });
  const read = readOf(response, 'getSignatureRequest');
  // The sign form carries the pair of the request id, the context its sign write belongs to.
  if (read.body !== undefined && signable(ctx, read.body)) await ctx.csrf.prefetch([id]);
  return read;
}

/** The typed-name form, posted to the sign action with the request's CSRF pair. */
function signForm(ctx: ScreenContext, id: string, typedName: string): SafeHtml {
  const field = controlGroup('Typed Name', textInput('typedName', typedName, { maxlength: 255, required: true }));
  return postForm(actionUrl(ctx, SIGN_ACTION, { id }), field, 'Sign', { hidden: ctx.csrf.render(id, 'form') });
}

/** The signature row of a SIGNED request; nothing while it is PENDING. */
function signatureTable(signature: SignatureRequestDetail['signature']): SafeHtml | null {
  if (signature === null) return null;
  return gridTable(SIGNATURE_HEADERS, [[signature.typed_name, signature.signer_user_id, signature.signed_at]], '');
}

/** The request body: header, any alert, the request, its signature and, when signable, the typed-name form. */
export function requestBody(ctx: ScreenContext, data: RequestData, opts: RequestBodyOptions = {}): SafeHtml {
  const alert = opts.alert ?? data.alert;
  if (data.body === undefined) return html`${pageHeader(TITLE, requestLinks(ctx, undefined, REQUEST_SCREEN))}${alert}`;
  const detail = data.body;
  const id = requestIdOf(ctx.req.rc);
  const summary = gridTable(
    SUMMARY_HEADERS,
    [[detail.document_name, detail.state, detail.signer_user_id, detail.created, detail.createdbyid, detail.document_sha256]],
    '',
  );
  const form = signable(ctx, detail) ? signForm(ctx, id, opts.typedName ?? '') : null;
  return html`${pageHeader(TITLE, requestLinks(ctx, id, REQUEST_SCREEN))}${alert}${block(
    html`${summary}${signatureTable(detail.signature)}${form}`,
  )}`;
}

/** `/opt2/admin/e-signature/request`: the signing request with typed name. */
export function renderRequest(ctx: ScreenContext, data: RequestData): ShellView {
  return opt2View(ESIGNATURE, requestBody(ctx, data));
}
