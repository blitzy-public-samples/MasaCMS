/** Node, module, restriction and category verdicts of permission.cfc, and the JSON API content AllowAction, over identity-fed projections. */
import { Roles, isCoreModuleId, moduleRole } from '@opt2/platform/auth';
import { registryEntryForTenant, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { SITE_TREE_MODULE_ID, type Crumb } from '../repo/content-queries.js';
import type { GroupProjectionRow, PermissionProjectionRow } from '../repo/tables.js';
import type { Actor, DomainDeps } from './context.js';
import { UnregisteredTenantError, withPoolTenant, type PoolScope } from './pools.js';

/** A permission.cfc node verdict: a grant type, or `none`. */
export type NodeVerdict = 'editor' | 'author' | 'read' | 'deny' | 'none';

/** The crumb fields the verdicts read, keyed as contentGateway.buildCrumblist keys the crumb struct. */
export type CrumbNode = Pick<Crumb, 'contentid' | 'siteid' | 'restricted' | 'restrictgroups'>;

/** The actor's `session.mura.memberships` list items and `session.mura.membershipids`. */
export interface UserMemberships {
  /** Items of the CF list of `<groupname>;<group siteid>;<isPublic>` entries, matched case-sensitively as `listFind` matches. */
  names: readonly string[];
  groupIds: readonly string[];
}

/** permission.cfc setRestriction's struct, keyed as legacy keys it; legacy's 1/0 flags are booleans. */
export interface Restriction {
  allow: boolean;
  restrict: boolean;
  loggedIn: boolean;
  perm: Exclude<NodeVerdict, 'deny'>;
  restrictGroups: string;
  hasModuleAccess: boolean;
  /** Site of the first restricted crumb; set only when a crumb is restricted. */
  siteid?: string;
}

/** A site's user pool site ids (settingsBean getPublicUserPoolID and getPrivateUserPoolID). */
export interface SitePools {
  publicUserPoolId: string;
  privateUserPoolId: string;
}

/** What the verdicts read through: tenant transactions and the projection and crumb reads of the repository. */
export type PermissionDeps = Pick<DomainDeps, 'db' | 'repository'>;

/** The content bean JSON API `AllowAction` judges. */
export interface ContentActionInput {
  /** Bean type, after the JSON API's Form, Component or Variation override from the request `type`. */
  type: string;
  contentId: string;
  siteId: string;
  parentId: string;
  /** `loadBy(contentID, siteID).getIsNew()` when the caller already loaded it; otherwise read from the item's crumb walk. */
  isNew?: boolean;
}

/** Whether the save may proceed, and whether it must be saved unapproved (`setApproved(0)` for authors). */
export interface ContentActionVerdict {
  allowed: boolean;
  forceUnapproved: boolean;
}

const COMPONENT_MODULE_ID = '00000000000000000000000000000000003';
const FORM_MODULE_ID = '00000000000000000000000000000000004';
const VARIATION_MODULE_ID = '00000000000000000000000000000000099';

/** getPerm's grant types in precedence order. */
const GRANT_TYPES = ['editor', 'author', 'read', 'deny'] as const;

/** The pools whose tenants hold the user, group and membership projections. */
const USER_POOLS: readonly PoolScope[] = ['publicUser', 'privateUser'];

const NO_MEMBERSHIPS: UserMemberships = Object.freeze({ names: Object.freeze([]), groupIds: Object.freeze([]) });

interface NodeRef {
  contentId: string;
  siteId: string;
}

/** Everything one verdict walk reads; `pools` is null when no membership string can match, so nothing else was read. */
interface VerdictSource {
  memberships: UserMemberships;
  pools: SitePools | null;
  rows: readonly PermissionProjectionRow[];
  groups: ReadonlyMap<string, GroupProjectionRow>;
}

/** Items of a CF comma list: empty items dropped, nothing trimmed. */
function cfListItems(value: string): string[] {
  return value.split(',').filter((item) => item !== '');
}

/** CF `listFind`: whether `value` is one item of the list, compared case-sensitively. */
function listFind(items: readonly string[], value: string): boolean {
  return items.includes(value);
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** `listFind(session.mura.memberships, 'S2')`: the token's super-user flag. */
function isS2(actor: Actor): boolean {
  return actor.s2 || actor.roles.includes(Roles.s2);
}

// identity mints `site-admin` for `Admin;<privateUserPoolID>;0` of the token's site only, so the role answers for that site alone.
/** Whether the token's `site-admin` role is the `Admin` membership of `siteId`'s private pool. */
function siteAdminRole(actor: Actor, siteId: string): boolean {
  return actor.roles.includes(Roles.siteAdmin) && siteId.toLowerCase() === actor.siteId.toLowerCase();
}

/** The S2 or site Admin shortcut that needs no projection read. */
function privileged(actor: Actor, siteId: string): boolean {
  return isS2(actor) || siteAdminRole(actor, siteId);
}

/** `listFind(memberships, 'Admin;<privateUserPoolID>;0')` against the projected memberships. */
function adminMember(memberships: UserMemberships, pools: SitePools): boolean {
  return listFind(memberships.names, `Admin;${pools.privateUserPoolId};0`);
}

/** A restrict-group item matched as setRestriction and getCategoryPerm match it: by name in the site's pools, or by group id. */
function memberOfGroup(memberships: UserMemberships, pools: SitePools | null, group: string): boolean {
  const byName =
    pools !== null &&
    (listFind(memberships.names, `${group};${pools.publicUserPoolId};1`) ||
      listFind(memberships.names, `${group};${pools.privateUserPoolId};0`));
  return byName || listFind(memberships.groupIds, group);
}

/** CF boolean of the group's `isPublic` column. */
function isPublicGroup(group: GroupProjectionRow): boolean {
  return group.is_public !== null && group.is_public !== 0;
}

/** A legacy id or grant type as SQL Server's case-insensitive, trailing-space-insensitive `=` compares it. */
function ciKey(value: string): string {
  return value.replace(/ +$/u, '').toLowerCase();
}

function nodeOf(crumb: CrumbNode): NodeRef {
  return { contentId: crumb.contentid ?? '', siteId: crumb.siteid ?? '' };
}

/** Runs `fn` once in each distinct tenant of the token's public and private user pools, public first. */
async function inUserPools<T>(deps: PermissionDeps, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T[]> {
  const seen = new Set<string>();
  const results: T[] = [];
  for (const kind of USER_POOLS) {
    const result = await withPoolTenant(deps.db, tenantId, kind, async (tx, poolTenantId) => {
      if (seen.has(poolTenantId)) {
        return null;
      }
      seen.add(poolTenantId);
      return { value: await fn(tx) };
    });
    if (result !== null) {
      results.push(result.value);
    }
  }
  return results;
}

/** The projected groups among `groupIds` in the user pool tenants, keyed by `ciKey` of the group id, a live row winning over a tombstone. */
async function projectedGroups(deps: PermissionDeps, tenantId: string, groupIds: readonly string[]): Promise<Map<string, GroupProjectionRow>> {
  const groups = new Map<string, GroupProjectionRow>();
  for (const rows of await inUserPools(deps, tenantId, (tx) => deps.repository.projections.groupNames(tx, groupIds))) {
    for (const row of rows) {
      const key = ciKey(row.group_id);
      const held = groups.get(key);
      if (held === undefined || (held.deleted && !row.deleted)) {
        groups.set(key, row);
      }
    }
  }
  return groups;
}

/** The user pool site ids of the token's site, from its `content.tenant_registry` entry. */
export async function sitePools(deps: PermissionDeps, actor: Actor): Promise<SitePools> {
  const entry = await registryEntryForTenant(deps.db, actor.tenantId);
  if (entry === null) {
    throw new UnregisteredTenantError(actor.tenantId);
  }
  // settingsBean defaults an empty pool id to the site's own id.
  return {
    publicUserPoolId: entry.publicUserPoolId ?? entry.siteId,
    privateUserPoolId: entry.privateUserPoolId ?? entry.siteId,
  };
}

/**
 * The actor's memberships as loginByQuery lists them, read from `content.membership_projection` and `content.group_projection`
 * in the token's public and private user pool tenants; empty for an anonymous actor.
 */
export async function loadMemberships(deps: PermissionDeps, actor: Actor): Promise<UserMemberships> {
  if (!actor.isLoggedIn || actor.userId === '') {
    return NO_MEMBERSHIPS;
  }
  const memberOf = distinct(
    (await inUserPools(deps, actor.tenantId, (tx) => deps.repository.projections.groupsOfUser(tx, actor.userId))).flat(),
  );
  if (memberOf.length === 0) {
    return NO_MEMBERSHIPS;
  }
  const groups = await projectedGroups(deps, actor.tenantId, memberOf);
  const entries: string[] = [];
  const groupIds: string[] = [];
  for (const groupId of memberOf) {
    const group = groups.get(ciKey(groupId));
    // A tombstone is a deleted group, whose tusersmemb rows userDAO.deleteGroupMemberships removed with it.
    if (group?.deleted === true) {
      continue;
    }
    groupIds.push(groupId);
    // loginByQuery inner-joins tusers, so only a projected group contributes a name entry.
    if (group !== undefined) {
      entries.push(`${group.group_name ?? ''};${group.site_id ?? ''};${group.is_public ?? ''}`);
    }
  }
  // The entries form one CF list, so a group name holding a comma splits into several items, as it does in the session list.
  return { names: cfListItems(entries.join(',')), groupIds };
}

/** Reads the permission rows of `nodes` in the token tenant and the groups they name, unless no membership string can match. */
async function loadVerdictSource(
  deps: PermissionDeps,
  actor: Actor,
  nodes: readonly NodeRef[],
  memberships: UserMemberships | undefined,
): Promise<VerdictSource> {
  const held = memberships ?? (await loadMemberships(deps, actor));
  if (held.names.length === 0) {
    return { memberships: held, pools: null, rows: [], groups: new Map() };
  }
  // Crumbs are read in the token tenant, whose content belongs to the token's site, so that site's pools apply.
  const pools = await sitePools(deps, actor);
  const bySite = new Map<string, string[]>();
  for (const node of nodes) {
    bySite.set(node.siteId, [...(bySite.get(node.siteId) ?? []), node.contentId]);
  }
  const rows = await withTenant(deps.db, actor.tenantId, async (tx) => {
    const found: PermissionProjectionRow[] = [];
    for (const [siteId, contentIds] of bySite) {
      found.push(...(await deps.repository.projections.permissionsForNodes(tx, { siteId, contentIds })));
    }
    return found;
  });
  const groupIds = distinct(rows.map((row) => row.group_id));
  const groups = groupIds.length === 0 ? new Map<string, GroupProjectionRow>() : await projectedGroups(deps, actor.tenantId, groupIds);
  return { memberships: held, pools, rows, groups };
}

/** getPermVerdict: some `type` grant on the node names a group the actor holds by name in the site's matching pool. */
function granted(source: VerdictSource, node: NodeRef, type: string): boolean {
  const { pools, memberships, groups } = source;
  if (pools === null) {
    return false;
  }
  const contentKey = ciKey(node.contentId);
  const siteKey = ciKey(node.siteId);
  return source.rows.some((row) => {
    if (ciKey(row.content_id) !== contentKey || ciKey(row.site_id) !== siteKey || ciKey(row.type) !== type) {
      return false;
    }
    const group = groups.get(ciKey(row.group_id));
    if (group === undefined || group.deleted) {
      return false;
    }
    const name = group.group_name ?? '';
    return isPublicGroup(group)
      ? listFind(memberships.names, `${name};${pools.publicUserPoolId};1`)
      : listFind(memberships.names, `${name};${pools.privateUserPoolId};0`);
  });
}

/** getPerm over a loaded source: the S2 or Admin shortcut, else the first granted type in precedence order, else `none`. */
function verdictOf(actor: Actor, source: VerdictSource, node: NodeRef): NodeVerdict {
  if (privileged(actor, node.siteId) || (source.pools !== null && adminMember(source.memberships, source.pools))) {
    return 'editor';
  }
  return GRANT_TYPES.find((type) => granted(source, node, type)) ?? 'none';
}

/** getPerm and getPermPublic, which legacy implements identically. */
async function permOf(deps: PermissionDeps, actor: Actor, node: NodeRef, memberships: UserMemberships | undefined): Promise<NodeVerdict> {
  if (privileged(actor, node.siteId)) {
    return 'editor';
  }
  return verdictOf(actor, await loadVerdictSource(deps, actor, [node], memberships), node);
}

/** The crumb walk of getNodePerm and getNodePermPublic: the first verdict that is not `none`; '' for no crumbs. */
async function walkCrumbs(
  deps: PermissionDeps,
  actor: Actor,
  crumbs: readonly CrumbNode[],
  memberships: UserMemberships | undefined,
): Promise<NodeVerdict | ''> {
  const nodes = crumbs.map(nodeOf);
  const [first] = nodes;
  if (first === undefined) {
    return '';
  }
  if (privileged(actor, first.siteId)) {
    return 'editor';
  }
  const source = await loadVerdictSource(deps, actor, nodes, memberships);
  let verdict: NodeVerdict = 'none';
  for (const node of nodes) {
    verdict = verdictOf(actor, source, node);
    if (verdict !== 'none') {
      break;
    }
  }
  return verdict;
}

/** getPerm [permission.cfc:220-241]: the actor's verdict on one node of `siteId`. */
export function getPerm(
  deps: PermissionDeps,
  actor: Actor,
  contentId: string,
  siteId: string,
  memberships?: UserMemberships,
): Promise<NodeVerdict> {
  return permOf(deps, actor, { contentId, siteId }, memberships);
}

/** getPermPublic [permission.cfc:243-264]: the same verdict as getPerm. */
export function getPermPublic(
  deps: PermissionDeps,
  actor: Actor,
  contentId: string,
  siteId: string,
  memberships?: UserMemberships,
): Promise<NodeVerdict> {
  return permOf(deps, actor, { contentId, siteId }, memberships);
}

/** getNodePerm [permission.cfc:266-282]: the first non-`none` verdict over crumbs ordered node to root; `deny` and no crumbs give `none`. */
export async function getNodePerm(
  deps: PermissionDeps,
  actor: Actor,
  crumbs: readonly CrumbNode[],
  memberships?: UserMemberships,
): Promise<Exclude<NodeVerdict, 'deny'>> {
  const verdict = await walkCrumbs(deps, actor, crumbs, memberships);
  return verdict === 'deny' || verdict === '' ? 'none' : verdict;
}

/** getNodePermPublic [permission.cfc:284-300]: as getNodePerm, but only `deny` becomes `none`, so no crumbs give ''. */
export async function getNodePermPublic(
  deps: PermissionDeps,
  actor: Actor,
  crumbs: readonly CrumbNode[],
  memberships?: UserMemberships,
): Promise<Exclude<NodeVerdict, 'deny'> | ''> {
  const verdict = await walkCrumbs(deps, actor, crumbs, memberships);
  return verdict === 'deny' ? 'none' : verdict;
}

/** getModulePerm [permission.cfc:302-349]: S2, site Admin or the token's `m:<nnn>` module role; plugin modules map to no role. */
export function getModulePerm(actor: Actor, moduleId: string): boolean {
  return (
    isS2(actor) ||
    actor.roles.includes(Roles.siteAdmin) ||
    (isCoreModuleId(moduleId) && actor.roles.includes(moduleRole(moduleId)))
  );
}

/**
 * setRestriction [permission.cfc:364-445]: the restricted-crumb walk, the S2 shortcut, the module-access verdict and the
 * restrict-group membership check; `hasModuleAccess` defaults to the actor's Site Manager module permission.
 */
export async function setRestriction(
  deps: PermissionDeps,
  actor: Actor,
  crumbs: readonly CrumbNode[],
  hasModuleAccess?: boolean,
): Promise<Restriction> {
  const r: Restriction = {
    allow: true,
    restrict: false,
    loggedIn: actor.isLoggedIn,
    perm: 'read',
    restrictGroups: '',
    hasModuleAccess: false,
  };
  if (crumbs.length === 0) {
    return { ...r, allow: false, perm: 'none' };
  }
  r.hasModuleAccess = hasModuleAccess ?? getModulePerm(actor, SITE_TREE_MODULE_ID);

  const restricted = crumbs.find((crumb) => crumb.restricted === 1);
  if (restricted !== undefined) {
    r.restrict = true;
    r.allow = false;
    r.perm = 'none';
    r.restrictGroups = restricted.restrictgroups ?? '';
    r.siteid = restricted.siteid ?? '';
  }

  let memberships: UserMemberships | undefined;
  if (actor.isLoggedIn) {
    if (isS2(actor)) {
      r.allow = true;
      r.perm = 'editor';
      return r;
    }
    if (r.hasModuleAccess) {
      // A site Admin's walk ends at the first crumb as `editor` and returns below, so it needs no memberships.
      if (!privileged(actor, crumbs[0]?.siteid ?? '')) {
        memberships = await loadMemberships(deps, actor);
      }
      const verdict = await walkCrumbs(deps, actor, crumbs, memberships);
      r.perm = verdict === 'deny' || verdict === '' ? 'none' : verdict;
      if (r.perm !== 'none' || r.restrictGroups === '') {
        r.allow = true;
        return r;
      }
    }
  }

  if (r.restrict && r.loggedIn) {
    if (r.restrictGroups === '') {
      r.allow = true;
      r.perm = 'read';
    } else {
      const held = memberships ?? (await loadMemberships(deps, actor));
      const pools = held.names.length > 0 ? await sitePools(deps, actor) : null;
      if (cfListItems(r.restrictGroups).some((group) => memberOfGroup(held, pools, group))) {
        r.allow = true;
        r.perm = 'read';
      }
    }
  }
  return r;
}

/** getCategoryPerm [permission.cfc:447-476]: an empty group list, S2 or site Admin allow; else a listed group held by name or id. */
export function getCategoryPerm(
  actor: Actor,
  memberships: UserMemberships,
  restrictGroups: string,
  siteId: string,
  pools: SitePools,
): boolean {
  if (restrictGroups === '') {
    return true;
  }
  if (privileged(actor, siteId) || adminMember(memberships, pools)) {
    return true;
  }
  return cfListItems(restrictGroups).some((group) => memberOfGroup(memberships, pools, group));
}

/** The module whose permission JSON API AllowAction checks for a content type (a CFML `switch`, case-insensitive). */
function moduleForType(type: string): string {
  switch (type.toLowerCase()) {
    case 'form':
      return FORM_MODULE_ID;
    case 'component':
      return COMPONENT_MODULE_ID;
    case 'variation':
      return VARIATION_MODULE_ID;
    default:
      return SITE_TREE_MODULE_ID;
  }
}

/**
 * JSON API AllowAction for `content` [jsonApiUtility.cfc:1740-1790]: the type's module permission, then the node verdict of
 * the stored item's crumbs, or of its parent's for a new item; `author` or `editor` allow, and `author` saves unapproved.
 */
export async function allowContentAction(deps: PermissionDeps, actor: Actor, input: ContentActionInput): Promise<ContentActionVerdict> {
  if (!getModulePerm(actor, moduleForType(input.type))) {
    return { allowed: false, forceUnapproved: false };
  }
  const crumbs = await withTenant(deps.db, actor.tenantId, async (tx) => {
    if (input.isNew !== true) {
      // The crumb walk starts at the item's active version, so no crumbs means loadBy finds no stored item (getIsNew()).
      const own = await deps.repository.content.crumbPath(tx, { contentId: input.contentId, siteId: input.siteId });
      if (own.length > 0 || input.isNew === false) {
        return own;
      }
    }
    return input.parentId === '' ? null : deps.repository.content.crumbPath(tx, { contentId: input.parentId, siteId: input.siteId });
  });
  const perm = crumbs === null ? 'none' : await getNodePerm(deps, actor, crumbs);
  return { allowed: perm === 'author' || perm === 'editor', forceUnapproved: perm === 'author' };
}
