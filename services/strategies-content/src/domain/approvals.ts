/** Approval chains (cchain, approvalChainBean), their content assignments and pending requests, and the status-modal actions (carch.approvalaction). */
import { cfEq, cfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { contentUrl } from '../legacy/content-urls.js';
import { rowsById, type ContentVersionRow, type Crumb } from '../repo/content-queries.js';
import type { ContentRepository } from '../repo/repository.js';
import type {
  ApprovalAssignmentRow,
  ApprovalChainRow,
  ApprovalMembershipRow,
  ApprovalRequestRow,
  ChangesetRow,
  ContentRow,
  GroupProjectionRow,
} from '../repo/tables.js';
import {
  PENDING_STATUS,
  UndefinedLegacyVariableError,
  approvalNotice,
  cancelRequest,
  loadRequest,
  saveRequest,
  writeAction,
  type ApprovalRequestValues,
} from './approval-requests.js';
import { approveVersion, deleteVersionInTransaction, type ContentDeps, type ContentSaveSite } from './content.js';
import { writeContextFor, type Actor, type DomainDeps, type DomainResult, type LegacyErrors, type MailNotice } from './context.js';
import { sitePools } from './permissions.js';
import { withPoolTenant, type PoolScope } from './pools.js';

export * from './approval-requests.js';

/**
 * Legacy filters available groups on `tusers.inactive = 0` (approvalChainBean.cfc:26); identity's `group.changed`
 * payload carries no inactive flag, so `content.group_projection` cannot apply it and inactive groups are listed.
 */
export const APPROVAL_GROUP_FILTER_UNCHECKED = ['inactive'] as const;

const S2_ROLE = 's2';
const SITE_ADMIN_ROLE = 'site-admin';
const APPROVED_STATUS = 'Approved';
const REJECTED_STATUS = 'Rejected';
/** ORM `char(35)` ids and the `site` relation's `varchar(25)` (bean.cfc setPropAsIDColumn). */
const ID_LENGTH = 35;
const SITE_ID_LENGTH = 25;
const CHAIN_NAME_LENGTH = 100;
/** `left(fname & " " & lname, 50)`, the ORM `lastupdateby` stamp. */
const AUDIT_NAME_LENGTH = 50;
/** The pools whose tenants hold the group projection. */
const USER_POOLS: readonly PoolScope[] = ['publicUser', 'privateUser'];

/** approvalChainBean values as CFML holds them: NULL columns read as ''. */
export interface ApprovalChainValues {
  chainid: string;
  siteid: string;
  name: string;
  description: string;
  created: Date | null;
  lastupdate: Date | null;
  lastupdateby: string;
  lastupdatebyid: string;
}

/** One approving group of a chain; `groupname` is '' when the group is not projected or was deleted (`getGroup()` of a missing user). */
export interface ApprovalChainMembership {
  membershipid: string;
  groupid: string;
  orderno: number | null;
  groupname: string;
}

/** An approval chain as `loadBy(chainID)` leaves the bean, with its memberships in chain order (`orderby="orderno asc"`). */
export interface ApprovalChainBean {
  isNew: boolean;
  values: ApprovalChainValues;
  memberships: ApprovalChainMembership[];
}

/** A group `getAvailableGroupsIterator` lists. */
export interface AvailableGroup {
  groupid: string;
  groupname: string;
  siteid: string;
  ispublic: number | null;
}

/** cchain.save's `rc` as `approvalChain.loadBy(chainID).set(rc)` reads it. */
export interface ChainSaveInput {
  chainId: string;
  siteId: string;
  name: string;
  description: string;
  /** The posted `groupID` CF list; undefined when the request carries none (`valueExists('groupID')` false). */
  groupId?: string;
}

/** A version awaiting a membership's approval (approvalChainMembershipBean.getPendingContentIterator); NULL text reads as ''. */
export interface PendingApprovalItem {
  requestid: string;
  /** `tapprovalrequests.created`, the list order. */
  created: Date | null;
  contentid: string;
  contenthistid: string;
  siteid: string;
  moduleid: string;
  parentid: string;
  title: string;
  menutitle: string;
  summary: string;
  type: string;
  subtype: string;
  filename: string;
  fileid: string;
  changesetid: string;
  lastupdate: Date | null;
  lastupdateby: string;
  lastupdatebyid: string;
  changesetname: string;
  changesetpublishdate: Date | null;
  /** `getCrumbArray()`: the crumbs of the version's stored path, the node first. */
  crumbs: Crumb[];
}

/** cchain.pending's data: the chain and, per membership in chain order, its pending versions. */
export interface PendingApprovals {
  chain: ApprovalChainBean;
  groups: Array<{ membership: ApprovalChainMembership; items: PendingApprovalItem[] }>;
}

/** approvalChainAssignmentBean values; NULL columns read as ''. */
export interface ApprovalAssignmentValues {
  assignmentid: string;
  contentid: string;
  siteid: string;
  chainid: string;
  exemptid: string;
}

/** A chain assignment as `loadBy(siteID, contentID)` leaves the bean. */
export interface ApprovalAssignmentBean {
  isNew: boolean;
  values: ApprovalAssignmentValues;
}

/** The status-modal post: the request, the button pressed and the comment. */
export interface ApprovalActionInput {
  requestId: string;
  /** `approve`, `cancel`, or anything else for a rejection (CF `eq`). */
  action: string;
  comment: string;
}

/** approvalaction.cfm's JSON: the request's version after the action and the preview link of the item's active version. */
export interface ApprovalActionData {
  contenthistid: string;
  previewurl: string;
}

/** One beanValidator rule of an ORM property, keyed as bean.getValidations keys it. */
interface OrmRule {
  key: string;
  value: string;
  required?: boolean;
  maxLength: number;
}

/** The transaction and collaborators of one status-modal action. */
interface ActionScope {
  tx: TenantTx;
  deps: ContentDeps;
  actor: Actor;
  site: ContentSaveSite;
  notices: MailNotice[];
}

/** Carries an error legacy raises once the writes before it are committed. */
class ErrorAfterWrites extends Error {
  override readonly name: string = 'ErrorAfterWrites';

  constructor(readonly error: Error) {
    super(error.message);
  }
}

/** An id as SQL Server's case-insensitive, trailing-space-insensitive `=` compares it. */
function idKey(value: string): string {
  return value.replace(/ +$/u, '').toLowerCase();
}

/** The ORM `lastupdateby` and `lastupdatebyid` stamps of `actor`: '' when not logged in. */
function auditOf(actor: Actor): Pick<ApprovalChainValues, 'lastupdateby' | 'lastupdatebyid'> {
  return actor.isLoggedIn
    ? { lastupdateby: actor.fullName.slice(0, AUDIT_NAME_LENGTH), lastupdatebyid: actor.userId }
    : { lastupdateby: '', lastupdatebyid: '' };
}

/** beanValidator over `rules` in ACF key order: required fails when empty, a non-empty value fails beyond its length. */
function ormErrors(rules: readonly OrmRule[]): LegacyErrors {
  const errors: LegacyErrors = {};
  for (const rule of rules) {
    const fails = rule.value === '' ? rule.required === true : rule.value.length > rule.maxLength;
    if (fails) {
      errors[rule.key] = `The property named '${rule.key}' is not valid`;
    }
  }
  return errors;
}

function chainValuesOf(row: ApprovalChainRow): ApprovalChainValues {
  return {
    chainid: row.chainid,
    siteid: row.siteid ?? '',
    name: row.name ?? '',
    description: row.description ?? '',
    created: row.created,
    lastupdate: row.lastupdate,
    lastupdateby: row.lastupdateby ?? '',
    lastupdatebyid: row.lastupdatebyid ?? '',
  };
}

/** A new approvalChainBean after `loadBy(chainID)` found no row: ORM init stamps `created`, `lastupdate` and the audit name. */
function newChainValues(actor: Actor, now: Date, chainId: string): ApprovalChainValues {
  return { chainid: chainId, siteid: '', name: '', description: '', created: now, lastupdate: now, ...auditOf(actor) };
}

/** approvalChainBean.validate (ACF error order chainID, siteID, name). */
function validateChain(values: ApprovalChainValues): LegacyErrors {
  return ormErrors([
    { key: 'chainID', value: values.chainid, required: true, maxLength: ID_LENGTH },
    { key: 'siteID', value: values.siteid, maxLength: SITE_ID_LENGTH },
    { key: 'name', value: values.name, maxLength: CHAIN_NAME_LENGTH },
  ]);
}

function assignmentValuesOf(row: ApprovalAssignmentRow): ApprovalAssignmentValues {
  return {
    assignmentid: row.assignmentid,
    contentid: row.contentid ?? '',
    siteid: row.siteid ?? '',
    chainid: row.chainid ?? '',
    exemptid: row.exemptid ?? '',
  };
}

/** approvalChainAssignmentBean.validate (ACF error order contentID, chainID, assignmentID, siteID). */
function validateAssignment(values: ApprovalAssignmentValues): LegacyErrors {
  return ormErrors([
    { key: 'contentID', value: values.contentid, maxLength: ID_LENGTH },
    { key: 'chainID', value: values.chainid, maxLength: ID_LENGTH },
    { key: 'assignmentID', value: values.assignmentid, required: true, maxLength: ID_LENGTH },
    { key: 'siteID', value: values.siteid, maxLength: SITE_ID_LENGTH },
  ]);
}

/** The projected groups among `groupIds` in the token's user pool tenants, keyed by `idKey`, a live row winning over a tombstone. */
async function projectedGroups(deps: DomainDeps, actor: Actor, groupIds: readonly string[]): Promise<Map<string, GroupProjectionRow>> {
  const groups = new Map<string, GroupProjectionRow>();
  if (groupIds.length === 0) {
    return groups;
  }
  const seen = new Set<string>();
  for (const kind of USER_POOLS) {
    await withPoolTenant(deps.db, actor.tenantId, kind, async (tx, poolTenantId) => {
      if (seen.has(poolTenantId)) {
        return;
      }
      seen.add(poolTenantId);
      for (const row of await deps.repository.projections.groupNames(tx, groupIds)) {
        const key = idKey(row.group_id);
        const held = groups.get(key);
        if (held === undefined || (held.deleted && !row.deleted)) {
          groups.set(key, row);
        }
      }
    });
  }
  return groups;
}

/** The memberships with their projected group names. */
async function namedMemberships(deps: DomainDeps, actor: Actor, rows: readonly ApprovalMembershipRow[]): Promise<ApprovalChainMembership[]> {
  const groups = await projectedGroups(
    deps,
    actor,
    rows.flatMap((row) => (row.groupid === null ? [] : [row.groupid])),
  );
  return rows.map((row) => {
    const group = row.groupid === null ? undefined : groups.get(idKey(row.groupid));
    return {
      membershipid: row.membershipid,
      groupid: row.groupid ?? '',
      orderno: row.orderno,
      groupname: group === undefined || group.deleted ? '' : (group.group_name ?? ''),
    };
  });
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SQL Server `order by groupname`: NULL first, then case-insensitive; the group id breaks ties. */
function byGroupName(a: GroupProjectionRow, b: GroupProjectionRow): number {
  if (a.group_name === null || b.group_name === null) {
    if (a.group_name !== b.group_name) {
      return a.group_name === null ? -1 : 1;
    }
  } else {
    const order = compareText(a.group_name.toLowerCase(), b.group_name.toLowerCase());
    if (order !== 0) {
      return order;
    }
  }
  return compareText(idKey(a.group_id), idKey(b.group_id));
}

/** The content columns a pending item reads from the version. */
type PendingVersion = Pick<
  ContentRow,
  | 'contentid'
  | 'contenthistid'
  | 'siteid'
  | 'moduleid'
  | 'parentid'
  | 'title'
  | 'menutitle'
  | 'summary'
  | 'type'
  | 'subtype'
  | 'filename'
  | 'fileid'
  | 'changesetid'
  | 'lastupdate'
  | 'lastupdateby'
  | 'lastupdatebyid'
>;

function pendingItemOf(request: ApprovalRequestRow, version: PendingVersion, changeset: ChangesetRow | null, crumbs: Crumb[]): PendingApprovalItem {
  return {
    requestid: request.requestid,
    created: request.created,
    contentid: version.contentid ?? '',
    contenthistid: version.contenthistid ?? '',
    siteid: version.siteid ?? '',
    moduleid: version.moduleid ?? '',
    parentid: version.parentid ?? '',
    title: version.title ?? '',
    menutitle: version.menutitle ?? '',
    summary: version.summary ?? '',
    type: version.type ?? '',
    subtype: version.subtype ?? '',
    filename: version.filename ?? '',
    fileid: version.fileid ?? '',
    changesetid: version.changesetid ?? '',
    lastupdate: version.lastupdate,
    lastupdateby: version.lastupdateby ?? '',
    lastupdatebyid: version.lastupdatebyid ?? '',
    changesetname: changeset?.name ?? '',
    changesetpublishdate: changeset?.publishdate ?? null,
    crumbs,
  };
}

/**
 * contentManager.getCrumbList(contentID, siteID, path) of each version, keyed as `versions` is: one read per site for
 * the stored paths, and the parent walk for a version without one.
 */
async function versionCrumbs(tx: TenantTx, repo: ContentRepository, versions: ReadonlyMap<string, ContentVersionRow>): Promise<Map<string, Crumb[]>> {
  const pathsBySite = new Map<string, string[]>();
  for (const version of versions.values()) {
    const path = version.path ?? '';
    if (path === '') continue;
    const paths = pathsBySite.get(version.siteid ?? '');
    if (paths === undefined) pathsBySite.set(version.siteid ?? '', [path]);
    else paths.push(path);
  }
  const bySite = new Map<string, Map<string, Crumb[]>>();
  for (const [siteId, paths] of pathsBySite) {
    bySite.set(siteId, await repo.content.crumbPathsIn(tx, { siteId, paths }));
  }
  const crumbs = new Map<string, Crumb[]>();
  for (const [key, version] of versions) {
    const siteId = version.siteid ?? '';
    const path = version.path ?? '';
    crumbs.set(
      key,
      path === '' ? await repo.content.crumbPath(tx, { contentId: version.contentid ?? '', siteId, path }) : (bySite.get(siteId)?.get(path) ?? []),
    );
  }
  return crumbs;
}

// ---- chain administration (cchain) ----

/** cchain.cfc `before()`: members of the site's private-pool `Admin` group (`site-admin`) and super users pass; others are secured. */
export function chainAccess(actor: Actor): boolean {
  return actor.s2 || actor.roles.includes(S2_ROLE) || actor.roles.includes(SITE_ADMIN_ROLE);
}

/** approvalChainManager.getChainFeed(siteID).setSortBy('name'): the site's chains by name. */
export async function listChains(deps: DomainDeps, actor: Actor, siteId: string): Promise<ApprovalChainValues[]> {
  const rows = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.approvals.listChains(tx, { siteId }));
  return rows.map(chainValuesOf);
}

/** approvalChain.loadBy(chainID): the stored chain or a new bean of that id, with its named memberships. */
export async function readChain(deps: DomainDeps, actor: Actor, chainId: string): Promise<ApprovalChainBean> {
  const { stored, memberships } = await withTenant(deps.db, actor.tenantId, async (tx) => ({
    stored: await deps.repository.approvals.findChain(tx, { chainId }),
    memberships: await deps.repository.approvals.chainMemberships(tx, { chainId }),
  }));
  return {
    isNew: stored === null,
    values: stored === null ? newChainValues(actor, deps.clock.now(), chainId) : chainValuesOf(stored),
    memberships: await namedMemberships(deps, actor, memberships),
  };
}

/**
 * approvalChainBean.getAvailableGroupsIterator: the live public groups of the site's public user pool and private groups
 * of its private pool, outside the chain, by name. The pools are always the token site's: for a chain with no stored
 * site legacy reads the `default` site's pools, another tenant's groups, which the token does not grant.
 */
export async function availableGroups(deps: DomainDeps, actor: Actor, chainId: string): Promise<AvailableGroup[]> {
  const memberships = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.approvals.chainMemberships(tx, { chainId }));
  // `userID not in (select groupID …)` is unknown for every group once one membership's groupID is NULL.
  if (memberships.some((membership) => membership.groupid === null)) {
    return [];
  }
  const inChain = new Set(memberships.map((membership) => idKey(membership.groupid ?? '')));
  const pools = await sitePools(deps, actor);
  const groups = [
    ...(await withPoolTenant(deps.db, actor.tenantId, 'publicUser', (tx) =>
      deps.repository.projections.poolGroups(tx, { siteId: pools.publicUserPoolId, isPublic: 1 }),
    )),
    ...(await withPoolTenant(deps.db, actor.tenantId, 'privateUser', (tx) =>
      deps.repository.projections.poolGroups(tx, { siteId: pools.privateUserPoolId, isPublic: 0 }),
    )),
  ];
  return groups
    .filter((group) => !inChain.has(idKey(group.group_id)))
    .sort(byGroupName)
    .map((group) => ({ groupid: group.group_id, groupname: group.group_name ?? '', siteid: group.site_id ?? '', ispublic: group.is_public }));
}

/**
 * approvalChain.loadBy(chainID).set(rc).save(): memberships from a posted `groupID` list first (an invalid chain still
 * changes them), then the chain row unless validation fails; returns the bean values and errors.
 */
export async function saveChain(deps: DomainDeps, actor: Actor, input: ChainSaveInput): Promise<DomainResult<ApprovalChainValues>> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const repo = deps.repository;
    const write = writeContextFor(actor);
    const now = deps.clock.now();
    const stored = await repo.approvals.findChain(tx, { chainId: input.chainId });
    const values: ApprovalChainValues = {
      ...(stored === null ? newChainValues(actor, now, input.chainId) : chainValuesOf(stored)),
      chainid: input.chainId,
      siteid: input.siteId,
      name: input.name,
      description: input.description,
      lastupdate: now,
      ...auditOf(actor),
    };
    // A chain id beyond the membership's char(35) fails each membership's validation, so legacy writes none.
    if (input.groupId !== undefined && input.chainId.length <= ID_LENGTH) {
      await repo.approvals.replaceChainMemberships(tx, input.chainId, input.groupId.split(','), write);
    }
    const errors = validateChain(values);
    if (Object.keys(errors).length > 0) {
      return { value: values, errors, notices: [] };
    }
    const columns = {
      siteid: values.siteid,
      name: values.name,
      description: values.description,
      created: values.created,
      lastupdateby: values.lastupdateby,
      lastupdatebyid: values.lastupdatebyid,
    };
    const saved =
      (await repo.approvals.updateChain(tx, values.chainid, columns, write)) ??
      (await repo.approvals.insertChain(tx, { ...columns, chainid: values.chainid }, write));
    return { value: chainValuesOf(saved), errors: {}, notices: [] };
  });
}

/** approvalChain.loadBy(chainID).delete(): memberships, requests and their actions (cascade="delete"), then the chain; no trash row. */
export async function deleteChain(deps: DomainDeps, actor: Actor, chainId: string): Promise<ApprovalChainValues | null> {
  const removed = await withGatedTenant(deps.db, actor.tenantId, (tx) => deps.repository.approvals.deleteChain(tx, { chainId }, writeContextFor(actor)));
  return removed === null ? null : chainValuesOf(removed);
}

/**
 * cchain.pending: the chain and each membership's pending versions, oldest request first, with their change set and
 * crumbs; every membership's requests, versions and change sets are read at once.
 */
export async function pendingApprovals(deps: DomainDeps, actor: Actor, chainId: string): Promise<PendingApprovals> {
  const chain = await readChain(deps, actor, chainId);
  const repo = deps.repository;
  // `tapprovalrequests.groupid = NULL` matches no request.
  const groupIds = [...new Set(chain.memberships.flatMap((membership) => (membership.groupid === '' ? [] : [membership.groupid])))];
  const groups = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const requests =
      groupIds.length === 0 ? [] : await repo.approvals.requestsByStatus(tx, { status: PENDING_STATUS, chainId: chain.values.chainid, groupIds });
    const versions = await repo.content.readVersionsIn(tx, { contentHistIds: requests.map((request) => request.contenthistid ?? '') });
    const changesets = await repo.changesets.findChangesetsIn(
      tx,
      [...versions.values()].flatMap((version) => (version.changesetid === null || version.changesetid === '' ? [] : [version.changesetid])),
    );
    const crumbs = await versionCrumbs(tx, repo, versions);
    const requestsOf = rowsById(requests, (request) => request.groupid);
    return chain.memberships.map((membership) => ({
      membership,
      items: (membership.groupid === '' ? [] : requestsOf([membership.groupid])).flatMap((request) => {
        const key = request.contenthistid ?? '';
        const version = versions.get(key);
        return version === undefined
          ? []
          : [pendingItemOf(request, version, changesets.get(version.changesetid ?? '') ?? null, crumbs.get(key) ?? [])];
      }),
    }));
  });
  return { chain, groups };
}

// ---- chain assignments (tapprovalassignments) ----

/** approvalChainAssignment.loadBy(siteID, contentID): the node's assignment, or a new bean holding the key. */
export async function readAssignment(deps: DomainDeps, actor: Actor, key: { siteId: string; contentId: string }): Promise<ApprovalAssignmentBean> {
  const row = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.approvals.assignmentFor(tx, key));
  return row === null
    ? { isNew: true, values: { assignmentid: cfUuid(), contentid: key.contentId, siteid: key.siteId, chainid: '', exemptid: '' } }
    : { isNew: false, values: assignmentValuesOf(row) };
}

/** approvalChainAssignment.loadBy(siteID, contentID).setChainID().setExemptID().save(): stored unless the ORM validation fails. */
export async function saveAssignment(
  deps: DomainDeps,
  actor: Actor,
  input: { siteId: string; contentId: string; chainId: string; exemptId: string },
): Promise<DomainResult<ApprovalAssignmentValues>> {
  return withGatedTenant(deps.db, actor.tenantId, async (tx) => {
    const repo = deps.repository;
    const row = await repo.approvals.assignmentFor(tx, { siteId: input.siteId, contentId: input.contentId });
    const loaded: ApprovalAssignmentValues =
      row === null ? { assignmentid: cfUuid(), contentid: input.contentId, siteid: input.siteId, chainid: '', exemptid: '' } : assignmentValuesOf(row);
    const values: ApprovalAssignmentValues = { ...loaded, chainid: input.chainId, exemptid: input.exemptId };
    const errors = validateAssignment(values);
    if (Object.keys(errors).length > 0) {
      return { value: values, errors, notices: [] };
    }
    const saved = await repo.approvals.upsertAssignment(tx, values, writeContextFor(actor));
    return { value: assignmentValuesOf(saved), errors: {}, notices: [] };
  });
}

/** approvalChainAssignment.delete: removes the assignment; null when none has the id. */
export async function deleteAssignment(deps: DomainDeps, actor: Actor, assignmentId: string): Promise<ApprovalAssignmentValues | null> {
  const removed = await withGatedTenant(deps.db, actor.tenantId, (tx) =>
    deps.repository.approvals.deleteAssignment(tx, { assignmentId }, writeContextFor(actor)),
  );
  return removed === null ? null : assignmentValuesOf(removed);
}

// ---- status-modal actions (carch.approvalaction) ----

/** Activates the request's version unless it is in a change set and re-points the request; `deleteSource` removes the inactive source. */
async function activateVersion(scope: ActionScope, request: ApprovalRequestValues, deleteSource: boolean): Promise<ApprovalRequestValues> {
  const { tx, deps, actor, site } = scope;
  const repo = deps.repository;
  const sourceId = request.contenthistid;
  const [version] = await repo.content.readVersion(tx, { contentHistId: sourceId });
  if ((version?.changesetid ?? '') !== '') {
    return request;
  }
  const result = await approveVersion(tx, deps, actor, site, sourceId, { approvingChainRequest: true });
  scope.notices.push(...result.notices);
  if (result.afterCommitError !== undefined) {
    throw new ErrorAfterWrites(result.afterCommitError);
  }
  const saved = await saveRequest(tx, repo, { ...request, contenthistid: result.bean.contentHistId() }, actor, site);
  if (deleteSource) {
    const [source] = await repo.content.readVersion(tx, { contentHistId: sourceId });
    if (source !== undefined && source.active === 0) {
      await deleteVersionInTransaction(tx, deps, actor, site, { contentHistId: sourceId, siteId: source.siteid ?? '' });
    }
  }
  return saved;
}

/**
 * approvalRequestBean.approve: records the group's `Approval`, then moves to the next group or, at the last (or with no
 * groups), becomes `Approved` and activates the version.
 * @throws UndefinedLegacyVariableError `CONTENT` for a non-pending request or one whose group left the chain, where
 * legacy's `sendActionMessage(content, …)` reads a variable no branch defined.
 */
async function approve(scope: ActionScope, request: ApprovalRequestValues, comments: string): Promise<ApprovalRequestValues> {
  const { tx, deps, actor, site } = scope;
  const repo = deps.repository;
  if (!cfEq(request.status, PENDING_STATUS)) {
    throw new UndefinedLegacyVariableError('CONTENT');
  }
  await writeAction(
    tx,
    repo,
    { requestId: request.requestid, groupId: request.groupid, chainId: request.chainid, actionType: 'Approval', comments, userId: actor.userId },
    writeContextFor(actor),
  );
  const memberships = await repo.approvals.chainMemberships(tx, { chainId: request.chainid });
  let saved: ApprovalRequestValues;
  if (memberships.length === 0) {
    saved = await saveRequest(tx, repo, { ...request, status: APPROVED_STATUS }, actor, site);
    saved = await activateVersion(scope, saved, false);
  } else {
    const at = memberships.findIndex((membership) => cfEq(membership.groupid ?? '', request.groupid));
    if (at === -1) {
      throw new UndefinedLegacyVariableError('CONTENT');
    }
    const next = memberships[at + 1];
    if (next !== undefined) {
      saved = await saveRequest(tx, repo, { ...request, groupid: next.groupid ?? '' }, actor, site);
    } else {
      saved = await saveRequest(tx, repo, { ...request, status: APPROVED_STATUS }, actor, site);
      saved = await activateVersion(scope, saved, true);
    }
  }
  approvalNotice(saved.status, site);
  return saved;
}

/** approvalRequestBean.reject: a `Pending` request records its group's `Rejection` and becomes `Rejected`; others are returned unchanged. */
async function reject(scope: ActionScope, request: ApprovalRequestValues, comments: string): Promise<ApprovalRequestValues> {
  const { tx, deps, actor, site } = scope;
  if (!cfEq(request.status, PENDING_STATUS)) {
    return request;
  }
  await writeAction(
    tx,
    deps.repository,
    { requestId: request.requestid, groupId: request.groupid, chainId: request.chainid, actionType: 'Rejection', comments, userId: actor.userId },
    writeContextFor(actor),
  );
  const saved = await saveRequest(tx, deps.repository, { ...request, status: REJECTED_STATUS }, actor, site);
  approvalNotice(saved.status, site);
  return saved;
}

/** approvalaction.cfm's data: the request's version, then the item's active version by content id for the preview link. */
async function actionData(scope: ActionScope, request: ApprovalRequestValues): Promise<ApprovalActionData> {
  const { tx, deps, site } = scope;
  const [version] = await deps.repository.content.readVersion(tx, { contentHistId: request.contenthistid });
  const [active] =
    version === undefined ? [] : await deps.repository.content.readActive(tx, { contentId: version.contentid ?? '', siteId: version.siteid ?? '' });
  return {
    contenthistid: request.contenthistid,
    previewurl: contentUrl(site.urls, { filename: active?.filename ?? null }, { querystring: `previewid=${request.contenthistid}` }),
  };
}

/** The error legacy raises after committing the writes before it, or undefined for any other error. */
function raisedAfterWrites(err: unknown): Error | undefined {
  if (err instanceof ErrorAfterWrites) {
    return err.error;
  }
  return err instanceof UndefinedLegacyVariableError ? err : undefined;
}

/**
 * carch.approvalaction (approvalaction.cfm:1-15): approve, cancel or else reject the request in one gated transaction
 * and return the modal's JSON data; an error legacy raises after its writes is thrown once they are committed.
 * The view's `true or validateCSRFTokens(…)` guard checks no token: that pre-existing weakness is reproduced, not fixed.
 */
export async function approvalAction(
  deps: ContentDeps,
  actor: Actor,
  site: ContentSaveSite,
  input: ApprovalActionInput,
): Promise<DomainResult<ApprovalActionData>> {
  const outcome = await withGatedTenant(deps.db, actor.tenantId, async (tx): Promise<{ data: ApprovalActionData; notices: MailNotice[] } | { error: Error }> => {
    const scope: ActionScope = { tx, deps, actor, site, notices: [] };
    const { values } = await loadRequest(tx, deps.repository, { requestId: input.requestId });
    let request: ApprovalRequestValues;
    try {
      if (cfEq(input.action, 'approve')) {
        request = await approve(scope, values, input.comment);
      } else if (cfEq(input.action, 'cancel')) {
        request = await cancelRequest(tx, deps.repository, values, input.comment, actor, site);
      } else {
        request = await reject(scope, values, input.comment);
      }
    } catch (err) {
      const raised = raisedAfterWrites(err);
      if (raised === undefined) {
        throw err;
      }
      return { error: raised };
    }
    return { data: await actionData(scope, request), notices: scope.notices };
  });
  if ('error' in outcome) {
    throw outcome.error;
  }
  return { value: outcome.data, errors: {}, notices: outcome.notices };
}
