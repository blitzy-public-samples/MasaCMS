// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import { LEGACY_ADMIN_SENTINEL_ID, isCfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import { attr, html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  canUse,
  controlGroup,
  focusesFirst,
  formActions,
  gridTable,
  hiddenField,
  opt2Gate,
  opt2Label,
  opt2ScreenUrl,
  opt2View,
  pageHeader,
  pagination,
  postForm,
  readPage,
  refusedFields,
  textInput,
  type FieldRule,
  type GridCell,
  type Label,
  type Opt2Refusal,
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
  readOf,
  requestStateBadge,
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

const DOCUMENT_NAME_MAX_LENGTH = 255;
const BASE64_CHAR = /^[A-Za-z0-9+/]$/;

/** Whether e-signature's ColdFusion decoder may decode `text` to a byte; skipping any whitespace errs to accept. */
function mayDecodeBase64(text: string): boolean {
  let data = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === '=' || char.charCodeAt(0) <= 0x20 || /\s/.test(char)) continue;
    if (!BASE64_CHAR.test(char)) return false;
    data += 1;
    // Text ending on a data character must end on a whole 4-character group.
    if (i === text.length - 1 && data % 4 !== 0) return false;
  }
  return data >= 2;
}

/** Whether `id`, surrounding spaces aside, can be a Masa UserID: a ColdFusion UUID or the legacy sentinel `LEGACY_ADMIN_SENTINEL_ID`. */
function mayBeUserId(id: string): boolean {
  const trimmed = javaTrim(id);
  return isCfUuid(trimmed) || trimmed === LEGACY_ADMIN_SENTINEL_ID;
}

/** One control per posted `CreateRequestInput` property, in contract order, each required, with its rule and hint. */
const CREATE_CONTROLS: ReadonlyArray<{
  readonly name: CreateRequestField;
  readonly label: string;
  readonly maxlength?: number;
  readonly refuses: FieldRule;
  readonly hint?: string;
}> = Object.freeze([
  {
    name: 'documentName',
    label: 'Document Name',
    maxlength: DOCUMENT_NAME_MAX_LENGTH,
    refuses: (value) => {
      if (value === '') return 'Enter a document name.';
      return value.length > DOCUMENT_NAME_MAX_LENGTH ? `Enter at most ${DOCUMENT_NAME_MAX_LENGTH} characters.` : undefined;
    },
  },
  {
    name: 'documentBase64',
    label: 'Document (Base64)',
    refuses: (value) => (mayDecodeBase64(value) ? undefined : 'Enter Base64 text that decodes to at least one byte.'),
  },
  {
    name: 'signerUserId',
    label: 'Signer User ID',
    refuses: (value) => {
      if (value === '') return "Enter the signer's UserID.";
      return mayBeUserId(value) ? undefined : 'Enter a UserID of 35 characters: 8-4-4-16 hexadecimal digits.';
    },
    hint: "The UserID of a user of this site's user pool.",
  },
]);

/** e-signature's create rules, by posted property. */
const CREATE_RULES: Readonly<Record<string, FieldRule>> = Object.freeze(
  Object.fromEntries(CREATE_CONTROLS.map(({ name, refuses }) => [name, refuses])),
);

/** The posted `CreateRequestInput` properties, in contract order. */
export const CREATE_REQUEST_FIELDS: readonly CreateRequestField[] = Object.freeze(
  CREATE_CONTROLS.map(({ name }) => name),
);

// The legacy create validates its CSRF pair under the route id, which the request list leaves empty; v1 consumes the
// same pair.
const CREATE_CSRF_CONTEXT = '';

/** Roles e-signature lets open every request of the site, not only the reader's own. */
const AUDITOR_ROLES: readonly Role[] = Object.freeze([Roles.esignatureAuditor]);

const SIGNER_ONLY_NOTE = 'Only requests for which you are the signer can be opened.';

/** One page of the tenant's signature requests; `null` for a reader without the signer role, which the list refuses. */
export type RequestsData = Read<ESignatureSchemas['SignatureRequestList']> | null;

/** Extras of a re-rendered request list: the create action's alert and refusal, and the posted new-request values. */
export interface RequestsBodyOptions {
  readonly alert?: SafeHtml;
  readonly refusal?: Opt2Refusal;
  readonly values?: CreateRequestValues;
}

/** Column headers of the request list, catalogued labels in the session locale. */
function headers(ctx: ScreenContext): Label[] {
  return ['Document', opt2Label(ctx, 'State'), 'Signer', opt2Label(ctx, 'Created'), opt2Label(ctx, 'Actions')];
}

/**
 * The `rc.pageIndex` page of the tenant's signature requests for a signer, page 1 when it is past the last, with the
 * new-request form's CSRF pair for a creator; nothing is asked for any other reader.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadRequests(ctx: ScreenContext): Promise<RequestsData> {
  if (!canUse(ctx.req, LIST_ROLES)) return null;
  const [{ answer: response }] = await Promise.all([
    readPage(
      pageIndexOf(ctx.req.rc),
      (pageIndex) => ctx.gateway.eSignature.call('get', '/v1/esignature/requests', { query: { pageIndex } }),
      (answer) => (answer.ok ? answer.body.totalpages : undefined),
    ),
    canUse(ctx.req, CREATE_ROLES) ? ctx.csrf.prefetch([CREATE_CSRF_CONTEXT]) : undefined,
  ]);
  return readOf(response, 'listSignatureRequests');
}

/** Whether the reader may open `request`: an auditor, or its signer, whose id e-signature compares case-insensitively. */
function opens(ctx: ScreenContext, request: SignatureRequest): boolean {
  const userId = ctx.req.user?.sub;
  return (
    canUse(ctx.req, AUDITOR_ROLES) ||
    (userId !== undefined && userId.toUpperCase() === request.signer_user_id.toUpperCase())
  );
}

/** The grid row of `request`; its document, audit chain and verification are linked only when the reader opens it. */
function requestRow(ctx: ScreenContext, request: SignatureRequest): GridCell[] {
  const params = { id: request.request_id };
  const openable = opens(ctx, request);
  // Values stay as the contract returns them, dates included, as on every OPT-2 screen.
  return [
    openable ? link(screenUrl(ctx, REQUEST_SCREEN, params), request.document_name) : request.document_name,
    requestStateBadge(ctx, request.state),
    request.signer_user_id,
    request.created,
    openable
      ? html`${link(screenUrl(ctx, AUDIT_SCREEN, params), 'Audit Chain')} ${link(screenUrl(ctx, VERIFY_SCREEN, params), 'Verify')}`
      : null,
  ];
}

/** GET form opening the request whose id is entered on the screen of the button pressed, on the session site. */
function lookupForm(ctx: ScreenContext): SafeHtml {
  const field = controlGroup('Request ID', textInput('id', '', { required: true, id: 'requestId', label: 'Request ID' }));
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

/** The new-request form, posted with its CSRF pair and holding `values`, after a refused create's alert, marked. */
function createForm(ctx: ScreenContext, values: CreateRequestValues, opts: RequestsBodyOptions): SafeHtml {
  const errors = refusedFields(CREATE_RULES, values, opts.refusal);
  const focusFirst = focusesFirst(opts.refusal, errors);
  const fields = CREATE_CONTROLS.map(({ name, label, maxlength, hint }, index) =>
    controlGroup(
      label,
      textInput(name, values[name] ?? '', {
        maxlength,
        required: true,
        label,
        error: errors[name],
        hint,
        focus: focusFirst && index === 0,
      }),
    ),
  );
  const form = postForm(actionUrl(ctx, CREATE_REQUEST_ACTION), html`${fields}`, 'Create', {
    hidden: ctx.csrf.render(CREATE_CSRF_CONTEXT),
  });
  return block(html`<h2>New Signature Request</h2>${opts.alert}${form}`);
}

/**
 * The landing body: header, for a non-auditor a note on which requests open, the requests with their paging and, for
 * a creator, `alert` and the new-request form (else `alert` follows the header); the service's alert in their place;
 * or the lookup form for a reader without signer.
 */
export function requestsBody(ctx: ScreenContext, data: RequestsData, opts: RequestsBodyOptions = {}): SafeHtml {
  const header = pageHeader('Signature Requests');
  if (data === null) return html`${header}${opts.alert}${block(lookupForm(ctx))}`;
  if (data.body === undefined) return html`${header}${opts.alert}${data.alert}`;
  // The contract's paged-list base types `items` as unknown[], which this list's schema narrows.
  const requests: readonly SignatureRequest[] = data.body.items;
  const rows = requests.map((request) => requestRow(ctx, request));
  const note = canUse(ctx.req, AUDITOR_ROLES) ? null : html`<p class="help-block">${SIGNER_ONLY_NOTE}</p>`;
  const list = block(
    html`${note}${gridTable(headers(ctx), rows, 'There are no signature requests.', {
      columnClasses: [undefined, undefined, 'hidden-xs', 'hidden-xs hidden-sm'],
    })}${pagination(ctx, {
      page: data.body.pageindex,
      totalRecords: data.body.totalitems,
      recordsPerPage: data.body.itemsperpage,
      href: (pageIndex) => screenUrl(ctx, REQUESTS_SCREEN, { pageIndex }),
    })}`,
  );
  if (!canUse(ctx.req, CREATE_ROLES)) return html`${header}${opts.alert}${list}`;
  return html`${header}${list}${createForm(ctx, opts.values ?? {}, opts)}`;
}

/** `/opt2/admin/e-signature/requests`: the OPT-2 nav entry; the request list for signers, the lookup for auditors. */
export function renderRequests(ctx: ScreenContext, data: RequestsData): ShellView {
  return opt2View(ESIGNATURE, requestsBody(ctx, data), REQUESTS_SCREEN);
}

/**
 * Reads the requests and renders the landing with `alert` before the new-request form holding `values`, as a
 * rejected create re-renders it.
 * @throws GatewayUnavailableError When e-signature or identity is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function renderRequestsView(
  ctx: ScreenContext,
  alert?: SafeHtml,
  values?: CreateRequestValues,
  refusal?: Opt2Refusal,
): Promise<ShellView> {
  return opt2View(ESIGNATURE, requestsBody(ctx, await loadRequests(ctx), { alert, values, refusal }), REQUESTS_SCREEN);
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
