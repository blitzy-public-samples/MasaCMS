// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import { html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import {
  block,
  detailList,
  opt2Gate,
  opt2Label,
  opt2View,
  pageHeader,
  pagination,
  readPage,
  valueRows,
  type ValueRow,
} from '../shared';
import {
  AUDIT_SCREEN,
  ESIGNATURE,
  MISSING_ID,
  isRequestId,
  pageIndexOf,
  readOf,
  requestIdOf,
  requestLinks,
  screenUrl,
  type ESignatureSchemas,
  type Read,
} from './common';

type AuditEntry = ESignatureSchemas['AuditEntry'];

/** One page of a request's audit chain. */
export type AuditData = Read<ESignatureSchemas['AuditChain']>;

/** Roles the contract requires to read a request's audit chain (`getAuditChain`). */
export const AUDIT_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

const TITLE = 'Audit Chain';
const EMPTY_MESSAGE = 'There are no audit entries for this request.';

/**
 * The `rc.pageIndex` page of request `rc.id`'s audit entries in `seq` order, page 1 when it is past the last; an empty
 * or malformed id asks nothing.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadAudit(ctx: ScreenContext): Promise<AuditData> {
  const { rc } = ctx.req;
  const id = requestIdOf(rc);
  if (!isRequestId(id)) return MISSING_ID;
  const { answer: response } = await readPage(
    pageIndexOf(rc),
    (pageIndex) =>
      ctx.gateway.eSignature.call('get', '/v1/esignature/requests/{id}/audit', {
        params: { id },
        query: { pageIndex },
      }),
    (answer) => (answer.ok ? answer.body.totalpages : undefined),
  );
  return readOf(response, 'getAuditChain');
}

/** A hash as the service returned it, in a code span. */
function hashCell(hex: string): SafeHtml {
  return html`<code>${hex}</code>`;
}

// `at` is shown as the hashed text, not through the short admin date mask, which drops seconds and milliseconds.
/** The labelled fields of `entry`, every field as the service hashed or stored it. */
function entryRows(ctx: ScreenContext, entry: AuditEntry): ValueRow[] {
  return [
    ['Sequence', entry.seq],
    [opt2Label(ctx, 'Action'), entry.action],
    ['Actor', entry.actor_user_id],
    ['Detail', entry.detail],
    ['At', entry.at],
    ['Previous Hash', hashCell(entry.prev_hash)],
    ['Hash', hashCell(entry.entry_hash)],
  ];
}

/** Each entry as read-only rows in the given order, a rule between each; a grid row would overflow on the hashes. */
function entryList(ctx: ScreenContext, items: readonly AuditEntry[]): SafeHtml {
  return detailList(items.map((entry) => valueRows(entryRows(ctx, entry))), EMPTY_MESSAGE);
}

/** The audit chain body: header, then the entries and their paging, or the service's alert. */
export function auditBody(ctx: ScreenContext, data: AuditData): SafeHtml {
  if (data.body === undefined) return html`${pageHeader(TITLE, requestLinks(ctx, undefined, AUDIT_SCREEN))}${data.alert}`;
  const id = requestIdOf(ctx.req.rc);
  // The contract's paged-list base types `items` as unknown[], which the chain's schema narrows.
  const items: readonly AuditEntry[] = data.body.items;
  const entries = entryList(ctx, items);
  // Header links are the module's request links, which carry the session site the gateway mints the token for.
  return html`${pageHeader(TITLE, requestLinks(ctx, id, AUDIT_SCREEN))}${block(
    html`${entries}${pagination(ctx, {
      page: data.body.pageindex,
      totalRecords: data.body.totalitems,
      recordsPerPage: data.body.itemsperpage,
      href: (pageIndex) => screenUrl(ctx, AUDIT_SCREEN, { id, pageIndex }),
    })}`,
  )}`;
}

/** `/opt2/admin/e-signature/audit`: a request's hash-chained audit trail. */
export function renderAudit(ctx: ScreenContext, data: AuditData): ShellView {
  return opt2View(ESIGNATURE, auditBody(ctx, data), AUDIT_SCREEN);
}

/** The audit chain screen, behind the deny-by-default gate of the contract's roles. */
export const auditScreen: Opt2ScreenDefinition<AuditData> = Object.freeze({
  module: ESIGNATURE,
  service: ESIGNATURE,
  screen: AUDIT_SCREEN,
  roles: AUDIT_ROLES,
  gate: opt2Gate(AUDIT_ROLES),
  load: loadAudit,
  render: renderAudit,
});
