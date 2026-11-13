// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Role } from '@opt2/platform/auth';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  canUse,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  opt2Gate,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  postForm,
  textInput,
  type GridCell,
} from '../shared';
import {
  AUDIT_SCREEN,
  ESIGNATURE,
  READER_ROLES,
  REQUEST_PAGES,
  REQUEST_SCREEN,
  REQUESTS_SCREEN,
  SIGNER_ROLES,
  VERIFY_SCREEN,
  actionUrl,
  link,
  pageIndexOf,
  pagination,
  readOf,
  screenUrl,
  type ESignatureSchemas,
  type Read,
} from './common';

type SignatureRequest = ESignatureSchemas['SignatureRequest'];

/** Roles the contract's `listSignatureRequests` requires. */
export const LIST_ROLES: readonly Role[] = SIGNER_ROLES;

/** Roles the contract's `createSignatureRequest` requires. */
export const CREATE_ROLES: readonly Role[] = SIGNER_ROLES;

/** The post action the new-request form submits to. */
export const CREATE_REQUEST_ACTION = 'create-request';

/** A posted `CreateRequestInput` property; `siteid` is not a control, the action URL carries the session site. */
export type CreateRequestField = Exclude<keyof ESignatureSchemas['CreateRequestInput'], 'siteid'>;

/** New-request form values by property name, kept when a rejected create re-renders the form. */
export type CreateRequestValues = Readonly<Partial<Record<CreateRequestField, string>>>;

/** One control per posted `CreateRequestInput` property, in contract order; every one is required. */
const CREATE_CONTROLS: ReadonlyArray<{
  readonly name: CreateRequestField;
  readonly label: string;
  readonly maxlength?: number;
}> = Object.freeze([
  { name: 'documentName', label: 'Document Name', maxlength: 255 },
  { name: 'documentBase64', label: 'Document (Base64)' },
  { name: 'signerUserId', label: 'Signer User ID' },
]);

/** The posted `CreateRequestInput` properties, in contract order. */
export const CREATE_REQUEST_FIELDS: readonly CreateRequestField[] = Object.freeze(
  CREATE_CONTROLS.map(({ name }) => name),
);

// The legacy create validates its CSRF pair under the route id, which the request list leaves empty; v1 takes the
// same pair although its contract declares no CSRF header.
const CREATE_CSRF_CONTEXT = '';

/** One page of the tenant's signature requests; `null` for a reader without the signer role, which the list refuses. */
export type RequestsData = Read<ESignatureSchemas['SignatureRequestList']> | null;

/** Extras of a re-rendered request list: the create action's alert and the posted new-request values. */
export interface RequestsBodyOptions {
  readonly alert?: SafeHtml;
  readonly values?: CreateRequestValues;
}

const HEADERS: readonly string[] = ['Document', 'State', 'Signer', 'Created', 'Actions'];

/**
 * The `rc.pageIndex` page of the tenant's signature requests for a signer, with the new-request form's CSRF pair for a
 * creator; nothing is asked for any other reader.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadRequests(ctx: ScreenContext): Promise<RequestsData> {
  if (!canUse(ctx.req, LIST_ROLES)) return null;
  const [response] = await Promise.all([
    ctx.gateway.eSignature.call('get', '/v1/esignature/requests', {
      query: { pageIndex: pageIndexOf(ctx.req.rc) },
    }),
    canUse(ctx.req, CREATE_ROLES) ? ctx.csrf.prefetch([CREATE_CSRF_CONTEXT]) : undefined,
  ]);
  return readOf(response, 'listSignatureRequests');
}

/** The grid row of `request`: its document linking to the request, then links to its audit chain and verification. */
function requestRow(ctx: ScreenContext, request: SignatureRequest): GridCell[] {
  const params = { id: request.request_id };
  // Values stay as the contract returns them, dates included, as on every OPT-2 screen.
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

/** The new-request form, posted to the create action with its CSRF pair and holding `values`. */
function createForm(ctx: ScreenContext, values: CreateRequestValues): SafeHtml {
  const fields = CREATE_CONTROLS.map(({ name, label, maxlength }) =>
    controlGroup(label, textInput(name, values[name] ?? '', { maxlength, required: true })),
  );
  const form = postForm(actionUrl(ctx, CREATE_REQUEST_ACTION), html`${fields}`, 'Create', {
    hidden: ctx.csrf.render(CREATE_CSRF_CONTEXT),
  });
  return block(html`<h2>New Signature Request</h2>${form}`);
}

/**
 * The landing body: header and any alert, then the requests with their paging and, for a creator, the new-request
 * form; the service's alert in their place; or the request lookup form for a reader without the signer role.
 */
export function requestsBody(ctx: ScreenContext, data: RequestsData, opts: RequestsBodyOptions = {}): SafeHtml {
  const header = html`${pageHeader('Signature Requests')}${opts.alert}`;
  if (data === null) return html`${header}${block(lookupForm(ctx))}`;
  if (data.body === undefined) return html`${header}${data.alert}`;
  // The contract's paged-list base types `items` as unknown[], which this list's schema narrows.
  const requests: readonly SignatureRequest[] = data.body.items;
  const rows = requests.map((request) => requestRow(ctx, request));
  const list = block(
    html`${gridTable(HEADERS, rows, 'There are no signature requests.')}${pagination(ctx, REQUESTS_SCREEN, data.body)}`,
  );
  const form = canUse(ctx.req, CREATE_ROLES) ? createForm(ctx, opts.values ?? {}) : null;
  return html`${header}${list}${form}`;
}

/** `/opt2/admin/e-signature/requests`: the OPT-2 nav entry; the request list for signers, the lookup for auditors. */
export function renderRequests(ctx: ScreenContext, data: RequestsData): ShellView {
  return opt2View(ESIGNATURE, requestsBody(ctx, data));
}

/**
 * Reads the requests and renders the landing below `alert`, the new-request form holding `values`, as a rejected
 * create re-renders it.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function renderRequestsView(
  ctx: ScreenContext,
  alert?: SafeHtml,
  values?: CreateRequestValues,
): Promise<ShellView> {
  return opt2View(ESIGNATURE, requestsBody(ctx, await loadRequests(ctx), { alert, values }));
}

/**
 * The OPT-2 nav landing. Gated on the reader roles rather than {@link LIST_ROLES}: the nav shows it to auditors too,
 * who get the request lookup instead of the list.
 */
export const requestsScreen: Opt2ScreenDefinition<RequestsData> = Object.freeze({
  module: ESIGNATURE,
  screen: REQUESTS_SCREEN,
  roles: READER_ROLES,
  service: ESIGNATURE,
  gate: opt2Gate(READER_ROLES),
  load: loadRequests,
  render: renderRequests,
});
