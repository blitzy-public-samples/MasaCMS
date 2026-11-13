/** Approval request primitives shared by content saves and status-modal actions: request loads, the approval requirement, request and action writes, and the action mail decision. */
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { ContentRepository } from '../repo/repository.js';
import type { ApprovalActionRow, ApprovalRequestRow } from '../repo/tables.js';
import { writeContextFor, type Actor, type SiteContentSettings } from './context.js';

/** Token role of a super user (`session.mura.memberships` holding `S2`). */
const S2_ROLE = 's2';
/** Token role of a member of the site's private-pool `Admin` group. */
const SITE_ADMIN_ROLE = 'site-admin';

/** approvalRequestBean values as CFML holds them: NULL columns read as ''. */
export interface ApprovalRequestValues {
  requestid: string;
  contenthistid: string;
  chainid: string;
  siteid: string;
  userid: string;
  groupid: string;
  status: string;
  /** The stored creation time; null on a new request, whose insert stamps it. */
  created: Date | null;
}

/** An approval request as `loadBy` leaves the bean. */
export interface LoadedApprovalRequest {
  isNew: boolean;
  values: ApprovalRequestValues;
}

/** What approvalRequest.loadBy is called with: the request id, or a version's request (contentBean.getApprovalRequest). */
export type ApprovalRequestKey = { requestId: string } | { contentHistId: string; chainId: string; siteId: string };

/** The crumb columns the approval walk reads (contentGateway crumbs join `tapprovalassignments`). */
export interface ApprovalCrumb {
  chainid: string | null;
  exemptid: string | null;
}

/** The actor's member group ids (`session.mura.membershipids`), as `loadMemberships` returns them. */
export interface ApprovalMemberships {
  groupIds: readonly string[];
}

/** Whether a save needs approval, and the chain of the crumb that requires it ('' when none does). */
export interface ApprovalRequirement {
  required: boolean;
  chainId: string;
}

/** One approvalActionBean save: the action of a request's group. */
export interface ApprovalActionWrite {
  requestId: string;
  groupId: string;
  chainId: string;
  actionType: string;
  comments: string;
  userId: string;
}

/** The status of approval requests whose actions are still open. */
export const PENDING_STATUS = 'Pending';

const NOT_REQUIRED: ApprovalRequirement = Object.freeze({ required: false, chainId: '' });

/**
 * ACF's error for an unscoped variable no scope defines. Masa disables implicit scope search
 * (applicationSettings.cfm:193), so `sendActionMessage` raises it for `approvalHistory` whenever a script is set.
 * Legacy has committed the writes made before it; a caller reproducing that commits them before rethrowing.
 */
export class UndefinedLegacyVariableError extends Error {
  override readonly name: string = 'UndefinedLegacyVariableError';

  constructor(readonly variable: string) {
    super(`Variable ${variable} is undefined.`);
  }
}

function valuesOf(row: ApprovalRequestRow): ApprovalRequestValues {
  return {
    requestid: row.requestid,
    contenthistid: row.contenthistid ?? '',
    chainid: row.chainid ?? '',
    siteid: row.siteid ?? '',
    userid: row.userid ?? '',
    groupid: row.groupid ?? '',
    status: row.status ?? '',
    created: row.created,
  };
}

/** The elements of a CF list (`ListToArray`): comma-separated, empty elements skipped. */
function cfListItems(value: string | null): string[] {
  return (value ?? '').split(',').filter((item) => item !== '');
}

/** CF `eq` on strings: case-insensitive. */
function cfSame(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** approvalRequest.loadBy: the stored request for `key`, or a new bean holding the key and the ORM defaults. */
export async function loadRequest(tx: TenantTx, repository: ContentRepository, key: ApprovalRequestKey): Promise<LoadedApprovalRequest> {
  const row = 'requestId' in key ? await repository.approvals.findRequest(tx, key) : await repository.approvals.requestFor(tx, key);
  if (row !== null) {
    return { isNew: false, values: valuesOf(row) };
  }
  const defaults: ApprovalRequestValues = {
    requestid: cfUuid(),
    contenthistid: '',
    chainid: '',
    siteid: '',
    userid: '',
    groupid: '',
    status: PENDING_STATUS,
    created: null,
  };
  const values =
    'requestId' in key
      ? { ...defaults, requestid: key.requestId }
      : { ...defaults, contenthistid: key.contentHistId, chainid: key.chainId, siteid: key.siteId };
  return { isNew: true, values };
}

/**
 * contentBean.requiresApproval over `crumbs` (node first): the first crumb whose assigned chain exists requires
 * approval, unless exemptions apply to an S2 or site-admin actor or the actor is in one of the crumb's exempt groups.
 */
export async function requiresApproval(
  tx: TenantTx,
  repository: ContentRepository,
  actor: Actor,
  crumbs: readonly ApprovalCrumb[],
  memberships: ApprovalMemberships,
  applyExemptions = true,
): Promise<ApprovalRequirement> {
  if (applyExemptions && (actor.s2 || actor.roles.includes(S2_ROLE) || actor.roles.includes(SITE_ADMIN_ROLE))) {
    return NOT_REQUIRED;
  }
  for (const crumb of crumbs) {
    const chainId = crumb.chainid ?? '';
    if (chainId === '' || (await repository.approvals.findChain(tx, { chainId })) === null) {
      continue;
    }
    // listFind: exact, case-sensitive match against the member group ids.
    if (applyExemptions && cfListItems(crumb.exemptid).some((groupId) => memberships.groupIds.includes(groupId))) {
      return NOT_REQUIRED;
    }
    return { required: true, chainId };
  }
  return NOT_REQUIRED;
}

/** The script setting sendActionMessage reads for an action type (CF `==`, case-insensitive); null for any other. */
function actionScript(kind: string, site: SiteContentSettings): string | null {
  switch (kind.toLowerCase()) {
    case 'approved':
      return site.contentApprovalScript;
    case 'rejected':
      return site.contentRejectionScript;
    case 'canceled':
      return site.contentCanceledScript;
    case 'pending':
      return site.contentPendingScript;
    default:
      return null;
  }
}

/**
 * approvalRequestBean.sendActionMessage for `kind` (`Approved`, `Rejected`, `Canceled` or `Pending`) in the content's
 * site: null, because without a script legacy sends nothing, and with one it fails before reaching the mailer.
 * @throws UndefinedLegacyVariableError when the kind's script is set.
 */
export function approvalNotice(kind: string, site: SiteContentSettings): null {
  const script = actionScript(kind, site);
  if (script === null || script === '') {
    return null;
  }
  // The replacement list reads the never-defined `approvalHistory` (approvalRequestBean.cfc:194); reproduced, not fixed.
  throw new UndefinedLegacyVariableError('APPROVALHISTORY');
}

/** approvalActionBean `loadBy(requestID, groupID)` then save: overwrites the group's action of the request, else inserts one. */
export async function writeAction(
  tx: TenantTx,
  repository: ContentRepository,
  action: ApprovalActionWrite,
  ctx?: WriteContext,
): Promise<ApprovalActionRow> {
  const changes = { comments: action.comments, actiontype: action.actionType, userid: action.userId, chainid: action.chainId };
  const existing = await repository.approvals.actionFor(tx, { requestId: action.requestId, groupId: action.groupId });
  if (existing === null) {
    // The ORM insert binds every column, so the unset site and parent are stored NULL rather than the column defaults.
    return repository.approvals.insertAction(tx, { requestid: action.requestId, groupid: action.groupId, siteid: '', parentid: '', ...changes }, ctx);
  }
  const updated = await repository.approvals.updateAction(tx, existing.actiontid, changes, ctx);
  if (updated !== null) {
    return updated;
  }
  // The ORM save inserts the loaded bean when its row no longer exists.
  const { tenant_id: _tenant, ...loaded } = existing;
  return repository.approvals.insertAction(tx, { ...loaded, ...changes, requestid: loaded.requestid ?? action.requestId }, ctx);
}

/** The request columns an ORM save writes. */
function requestColumns(values: ApprovalRequestValues): Omit<ApprovalRequestValues, 'requestid' | 'created'> & { created?: Date } {
  const { requestid: _id, created, ...columns } = values;
  return created === null ? columns : { ...columns, created };
}

/**
 * approvalRequestBean.save: a request without a group starts at the chain's first membership (deciding the `Pending`
 * mail), then the row is updated when its id is stored, else inserted with `created` stamped now.
 */
export async function saveRequest(
  tx: TenantTx,
  repository: ContentRepository,
  request: ApprovalRequestValues,
  actor: Actor,
  site: SiteContentSettings,
): Promise<ApprovalRequestValues> {
  let values = request;
  if (values.groupid === '') {
    const [first] = await repository.approvals.chainMemberships(tx, { chainId: values.chainid });
    if (first !== undefined) {
      values = { ...values, groupid: first.groupid ?? '' };
      approvalNotice(PENDING_STATUS, site);
    }
  }
  const ctx = writeContextFor(actor);
  const columns = requestColumns(values);
  const stored = (await repository.approvals.findRequest(tx, { requestId: values.requestid })) !== null;
  const updated = stored ? await repository.approvals.updateRequest(tx, values.requestid, columns, ctx) : null;
  return valuesOf(updated ?? (await repository.approvals.insertRequest(tx, { ...columns, requestid: values.requestid }, ctx)));
}

/** approvalRequestBean.cancel: a `Pending` request gets a `Cancelation` action of its group and status `Canceled`; others are returned unchanged. */
export async function cancelRequest(
  tx: TenantTx,
  repository: ContentRepository,
  request: ApprovalRequestValues,
  comments: string,
  actor: Actor,
  site: SiteContentSettings,
): Promise<ApprovalRequestValues> {
  if (!cfSame(request.status, PENDING_STATUS)) {
    return request;
  }
  await writeAction(
    tx,
    repository,
    { requestId: request.requestid, groupId: request.groupid, chainId: request.chainid, actionType: 'Cancelation', comments, userId: actor.userId },
    writeContextFor(actor),
  );
  const saved = await saveRequest(tx, repository, { ...request, status: 'Canceled' }, actor, site);
  approvalNotice('Canceled', site);
  return saved;
}
