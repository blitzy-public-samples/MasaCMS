// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { ScreenContext } from '../../registry';
import {
  block,
  canUse,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  textInput,
  type GridCell,
} from '../shared';
import {
  AUDIT_SCREEN,
  ESIGNATURE,
  REQUEST_PAGES,
  REQUEST_SCREEN,
  REQUESTS_SCREEN,
  SIGNER_ROLES,
  VERIFY_SCREEN,
  link,
  pageIndexOf,
  pagination,
  readOf,
  screenUrl,
  type ESignatureSchemas,
  type Read,
} from './common';

type SignatureRequest = ESignatureSchemas['SignatureRequest'];

/** One page of the tenant's signature requests; `null` for a reader without the signer role, which the list refuses. */
export type RequestsData = Read<ESignatureSchemas['SignatureRequestList']> | null;

const HEADERS: readonly string[] = ['Document', 'State', 'Signer', 'Created', 'Actions'];

/**
 * The `rc.pageIndex` page of the tenant's signature requests for a signer; nothing is asked for any other reader.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadRequests(ctx: ScreenContext): Promise<RequestsData> {
  if (!canUse(ctx.req, SIGNER_ROLES)) return null;
  const response = await ctx.gateway.eSignature.call('get', '/v1/esignature/requests', {
    query: { pageIndex: pageIndexOf(ctx.req.rc) },
  });
  return readOf(response, 'listSignatureRequests');
}

/** The grid row of `request`: its document linking to the request, then links to its audit chain and verification. */
function requestRow(ctx: ScreenContext, request: SignatureRequest): GridCell[] {
  const params = { id: request.request_id };
  return [
    link(screenUrl(ctx, REQUEST_SCREEN, params), request.document_name),
    request.state,
    request.signer_user_id,
    request.created,
    html`${link(screenUrl(ctx, AUDIT_SCREEN, params), 'Audit Chain')} ${link(screenUrl(ctx, VERIFY_SCREEN, params), 'Verify')}`,
  ];
}

/** GET form opening the request whose id is entered on the screen of the button pressed, on the session site. */
function lookupForm(ctx: ScreenContext): SafeHtml {
  const field = controlGroup('Request ID', textInput('id', '', { required: true, id: 'requestId' }));
  const buttons = REQUEST_PAGES.map(({ screen, label }, index) => ({
    label,
    primary: index === 0,
    formAction: opt2ScreenUrl(ESIGNATURE, screen),
  }));
  return html`<form method="get"${attr('action', opt2ScreenUrl(ESIGNATURE, REQUEST_SCREEN))}>${field}${formActions(
    buttons,
    hiddenField('siteid', ctx.req.session.siteid),
  )}</form>`;
}

/** The landing body: header, then the requests and their paging, the service's alert, or the request lookup form. */
export function requestsBody(ctx: ScreenContext, data: RequestsData): SafeHtml {
  const header = pageHeader('Signature Requests');
  if (data === null) return html`${header}${block(lookupForm(ctx))}`;
  if (data.body === undefined) return html`${header}${data.alert}`;
  // The contract's paged-list base types `items` as unknown[], which this list's schema narrows.
  const requests: readonly SignatureRequest[] = data.body.items;
  const rows = requests.map((request) => requestRow(ctx, request));
  return html`${header}${block(
    html`${gridTable(HEADERS, rows, 'There are no signature requests.')}${pagination(ctx, REQUESTS_SCREEN, data.body)}`,
  )}`;
}

/** `/opt2/admin/e-signature/requests`: the OPT-2 nav entry; the request list for signers, the lookup for auditors. */
export function renderRequests(ctx: ScreenContext, data: RequestsData): ShellView {
  return opt2View(ESIGNATURE, requestsBody(ctx, data));
}
