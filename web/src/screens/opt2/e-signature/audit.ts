// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import { Roles, type Role } from '@opt2/platform/auth';
import { html, type SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2ScreenDefinition, ScreenContext } from '../../registry';
import { block, gridTable, opt2Gate, opt2View, pageHeader, type GridCell } from '../shared';
import {
  AUDIT_SCREEN,
  ESIGNATURE,
  MISSING_ID,
  pageIndexOf,
  pagination,
  readOf,
  requestIdOf,
  requestLinks,
  type ESignatureSchemas,
  type Read,
} from './common';

type AuditEntry = ESignatureSchemas['AuditEntry'];

/** One page of a request's audit chain. */
export type AuditData = Read<ESignatureSchemas['AuditChain']>;

/** Roles the contract requires to read a request's audit chain (`getAuditChain`). */
export const AUDIT_ROLES: readonly Role[] = Object.freeze([Roles.esignatureSigner, Roles.esignatureAuditor]);

const TITLE = 'Audit Chain';
const HEADERS: readonly string[] = ['Sequence', 'Action', 'Actor', 'Detail', 'At', 'Previous Hash', 'Hash'];
const DETAIL_COLUMN = 3;
const EMPTY_MESSAGE = 'There are no audit entries for this request.';

/**
 * The `rc.pageIndex` page of request `rc.id`'s audit entries in `seq` order.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401 or 403.
 */
export async function loadAudit(ctx: ScreenContext): Promise<AuditData> {
  const { rc } = ctx.req;
  const id = requestIdOf(rc);
  if (id === '') return MISSING_ID;
  const response = await ctx.gateway.eSignature.call('get', '/v1/esignature/requests/{id}/audit', {
    params: { id },
    query: { pageIndex: pageIndexOf(rc) },
  });
  return readOf(response, 'getAuditChain');
}

/** A hash as the service returned it, in a code span. */
function hashCell(hex: string): SafeHtml {
  return html`<code>${hex}</code>`;
}

// `at` is shown as the hashed text, not through the short admin date mask, which drops seconds and milliseconds.
/** The grid row of `entry`, every field as the service hashed or stored it. */
function entryRow(entry: AuditEntry): GridCell[] {
  return [
    entry.seq,
    entry.action,
    entry.actor_user_id,
    entry.detail,
    entry.at,
    hashCell(entry.prev_hash),
    hashCell(entry.entry_hash),
  ];
}

/** The audit chain body: header, then the entries and their paging, or the service's alert. */
export function auditBody(ctx: ScreenContext, data: AuditData): SafeHtml {
  if (data.body === undefined) return html`${pageHeader(TITLE, requestLinks(ctx, undefined, AUDIT_SCREEN))}${data.alert}`;
  const id = requestIdOf(ctx.req.rc);
  // The contract's paged-list base types `items` as unknown[], which the chain's schema narrows.
  const items: readonly AuditEntry[] = data.body.items;
  const entries = gridTable(HEADERS, items.map(entryRow), EMPTY_MESSAGE, { varWidthColumn: DETAIL_COLUMN });
  // Header links are the module's request links, which carry the session site the gateway mints the token for.
  return html`${pageHeader(TITLE, requestLinks(ctx, id, AUDIT_SCREEN))}${block(
    html`${entries}${pagination(ctx, AUDIT_SCREEN, data.body, { id })}`,
  )}`;
}

/** `/opt2/admin/e-signature/audit`: a request's hash-chained audit trail. */
export function renderAudit(ctx: ScreenContext, data: AuditData): ShellView {
  return opt2View(ESIGNATURE, auditBody(ctx, data));
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
