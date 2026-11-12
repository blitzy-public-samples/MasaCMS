/** Content-node and module grants of `identity.permission` for the `cperm` screens and the reverse Users-module lookup, ported from Masa. */
import type { UserClaims } from '@opt2/platform/auth';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import {
  registryEntryForTenant,
  tenantForRegisteredSite,
  userPoolFanoutTenants,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';
import type { IdentityEvents } from '../events/publish.js';
import { charKey, type IdentityRepository } from '../repo/repository.js';
import type { GroupAccountRow, PermissionRow } from '../repo/tables.js';
import { moduleGrantHeld, modulePermByRole, type TokenRoleSite } from './roles.js';
import { moduleGrantsFor, signedInSnapshot } from './tokens.js';

// No node-permission save is built here. cperm.update [legacy: core/mura/permission.cfc:518-552] also saves the node's
// approval-chain assignment, which strategies-content owns, so that branch is withheld on the decision list and runs on
// legacy; its tpermissions writes reach identity.permission through write-window imports.

/** Node grant types in `getGroupPerm` precedence [legacy: core/mura/permission.cfc:135-156]. */
export const NODE_GRANT_TYPES = ['Editor', 'Author', 'Read', 'Deny'] as const;

/** One node grant type. */
export type NodeGrantType = (typeof NODE_GRANT_TYPES)[number];

/** A group's verdict on one node, as `getGroupPerm` returns it. */
export type PermissionVerdict = Lowercase<NodeGrantType> | 'none';

/** The repository helpers the permission operations use. */
export type PermissionRepository = Pick<IdentityRepository, 'listGroups' | 'permissionsFor' | 'groupPermissions' | 'replaceModulePermissions'>;

/** Dependencies of the permission operations; `gateWaitMs` defaults to the platform's 30 s gate wait. */
export interface PermissionDeps {
  db: TenantDb;
  repo: PermissionRepository;
  events: Pick<IdentityEvents, 'publishPermissionChanged'>;
  gateWaitMs?: number;
}

/** The system groups (`Admin` excluded) and member groups of a site's user pools, each by group name. */
export interface SiteGroupLists {
  privateGroups: GroupAccountRow[];
  publicGroups: GroupAccountRow[];
}

/** A content node or module of one site. */
export interface NodeRef {
  siteId: string;
  contentId: string;
}

/** The module grants to store: a comma list, or its items, of group ids. */
export interface ModulePermissionsInput {
  siteId: string;
  moduleId: string;
  groupIds: string | readonly string[];
}

/** The module's stored grants and every group whose `identity.permission.changed.v1` state was written. */
export interface ModulePermissionsResult {
  rows: PermissionRow[];
  changedGroupIds: string[];
}

/** Dependencies of {@link reversePermLookUp}. */
export interface ReversePermDeps {
  db: TenantDb;
  repo: Pick<IdentityRepository, 'findSession' | 'moduleGrants' | 'findGroupsByIds'>;
}

/** The registered sites other than `site` whose public or private user pool is `site`. */
interface PooledSites {
  publicPooled: TenantRegistryEntry[];
  privatePooled: TenantRegistryEntry[];
}

const USERS_MODULE = '00000000000000000000000000000000008';

function gateBudget(deps: PermissionDeps): { budgetMs: number | undefined } {
  return { budgetMs: deps.gateWaitMs };
}

/** Items of a CFML list loop over a comma list: empty items are skipped, the others kept as given. */
function listItems(value: string | readonly string[]): string[] {
  // A form posting one name several times reaches CFML as the comma-joined list.
  const list = typeof value === 'string' ? value : value.join(',');
  return list.split(',').filter((item) => item !== '');
}

/** The group ids of `rows` once each under `char(35)` equality, first spelling kept, in key order. */
function distinctGroupIds(rows: readonly Pick<PermissionRow, 'groupid'>[]): string[] {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const key = charKey(row.groupid);
    if (!ids.has(key)) ids.set(key, row.groupid);
  }
  return [...ids.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, groupId]) => groupId);
}

/** Runs `read` in the tenant of registered site `siteId`; an unregistered site has no rows. */
async function readInSite<R>(deps: PermissionDeps, siteId: string, read: (tx: TenantTx) => Promise<R[]>): Promise<R[]> {
  const tenant = await tenantForRegisteredSite(deps.db, siteId);
  return tenant === null ? [] : withGatedTenant(deps.db, tenant, read, gateBudget(deps));
}

/** Writes each group's full permission row set in `siteId` as `identity.permission.changed.v1`. */
async function publishGroupStates(deps: PermissionDeps, tx: TenantTx, siteId: string, groupIds: readonly string[]): Promise<void> {
  for (const groupId of groupIds) {
    const rows = await deps.repo.groupPermissions(tx, groupId, siteId);
    await deps.events.publishPermissionChanged(tx, { groupId, siteId, rows });
  }
}

/** The verdict of `groupId` among one node's rows, compared as SQL Server compares the columns [legacy: core/mura/permission.cfc:135-156]. */
export function groupPermVerdict(rows: readonly Pick<PermissionRow, 'groupid' | 'type'>[], groupId: string): PermissionVerdict {
  const group = charKey(groupId);
  const types = new Set(rows.filter((row) => charKey(row.groupid) === group).map((row) => charKey(row.type)));
  const granted = NODE_GRANT_TYPES.find((type) => types.has(charKey(type)));
  return granted === undefined ? 'none' : (granted.toLowerCase() as PermissionVerdict);
}

/** Replaces every grant of the module in the site with one `module` row per listed group, in one transaction [legacy: core/mura/permission.cfc:643-669]. */
export async function updateModulePermissions(deps: PermissionDeps, input: ModulePermissionsInput): Promise<ModulePermissionsResult> {
  const { siteId, moduleId } = input;
  const tenant = await tenantForRegisteredSite(deps.db, siteId);
  if (tenant === null) {
    throw new Error(`Site ${siteId} is not registered, so its module grants have no tenant`);
  }
  const groupIds = listItems(input.groupIds);
  return withGatedTenant(
    deps.db,
    tenant,
    async (tx) => {
      const { rows, removed } = await deps.repo.replaceModulePermissions(tx, { moduleId, siteId, groupIds });
      const changedGroupIds = distinctGroupIds([...rows, ...removed]);
      await publishGroupStates(deps, tx, siteId, changedGroupIds);
      return { rows, changedGroupIds };
    },
    gateBudget(deps),
  );
}

/** The site's private-pool groups other than `Admin` and its public-pool groups, read in each pool's tenant [legacy: core/mura/permission.cfc:600-621]. */
export async function groupListForSite(deps: PermissionDeps, siteId: string): Promise<SiteGroupLists> {
  const tenant = await tenantForRegisteredSite(deps.db, siteId);
  const entry = tenant === null ? null : await registryEntryForTenant(deps.db, tenant);
  if (entry === null) {
    return { privateGroups: [], publicGroups: [] };
  }
  const poolGroups = (poolSiteId: string | null, poolTenant: string | null, isPublic: 0 | 1): Promise<GroupAccountRow[]> =>
    poolSiteId === null || poolTenant === null
      ? Promise.resolve([])
      : withGatedTenant(deps.db, poolTenant, (tx) => deps.repo.listGroups(tx, poolSiteId, isPublic, { excludeAdmin: isPublic === 0 }), gateBudget(deps));
  return {
    privateGroups: await poolGroups(entry.privateUserPoolId, entry.privateUserPoolTenant, 0),
    publicGroups: await poolGroups(entry.publicUserPoolId, entry.publicUserPoolTenant, 1),
  };
}

/** The `module` rows of a module in the site [legacy: core/mura/permission.cfc:623-630]. */
export function permittedGroups(deps: PermissionDeps, node: NodeRef): Promise<PermissionRow[]> {
  return readInSite(deps, node.siteId, (tx) => deps.repo.permissionsFor(tx, { contentId: node.contentId, siteId: node.siteId, type: 'module' }));
}

/** Every stored row of a content node in the site, which `groupPermVerdict` reads for `cperm.main` [legacy: core/mura/permission.cfc:116-133]. */
export function permissionsForContent(deps: PermissionDeps, node: NodeRef): Promise<PermissionRow[]> {
  return readInSite(deps, node.siteId, (tx) => deps.repo.permissionsFor(tx, { contentId: node.contentId, siteId: node.siteId }));
}

/** The registered sites pooling their public or private users in the token's site, pool ids compared as SQL Server compares them [legacy: core/mura/user/userManager.cfc:1061-1065,1073-1077]. */
async function pooledSites(db: TenantDb, claims: Pick<UserClaims, 'tid' | 'site'>): Promise<PooledSites> {
  const site = charKey(claims.site);
  return db.withMetadata(async (tx) => {
    const pooled: PooledSites = { publicPooled: [], privatePooled: [] };
    for (const tenantId of await userPoolFanoutTenants(tx, claims.tid)) {
      // The site's own entry would only repeat the site's own check.
      const entry = tenantId === claims.tid ? null : await registryEntryForTenant(tx, tenantId);
      if (entry === null) continue;
      if (charKey(entry.publicUserPoolId ?? entry.siteId) === site) pooled.publicPooled.push(entry);
      if (charKey(entry.privateUserPoolId ?? entry.siteId) === site) pooled.privatePooled.push(entry);
    }
    return pooled;
  });
}

/** userManager `getReversePermLookUp` of the token's site for its session's login-time role list; false without a signed-in session [legacy: core/mura/user/userManager.cfc:1050-1086]. */
export async function reversePermLookUp(deps: ReversePermDeps, claims: Pick<UserClaims, 'sid' | 'tid' | 'site'>): Promise<boolean> {
  const { db, repo } = deps;
  const { snapshot } = await signedInSnapshot(db, repo, claims.sid);
  if (snapshot === undefined) return false;
  const own = await registryEntryForTenant(db, claims.tid);
  // An unregistered site has no pool ids and no grants, so its pools default to its own id.
  const ownSite: TokenRoleSite = own ?? { siteId: claims.site, privateUserPoolId: null, publicUserPoolId: null };
  if (modulePermByRole(snapshot, ownSite)) return true;
  const { publicPooled, privatePooled } = await pooledSites(db, claims);
  // S2 was ruled out above, so for every pooled site the role test is its private-pool Admin group alone.
  if ([...publicPooled, ...privatePooled].some((entry) => modulePermByRole(snapshot, entry))) return true;
  for (const entry of own === null ? publicPooled : [own, ...publicPooled]) {
    if (moduleGrantHeld(snapshot, entry, USERS_MODULE, await moduleGrantsFor(db, repo, snapshot, entry))) return true;
  }
  return false;
}
