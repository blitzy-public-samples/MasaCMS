/** The user prompt counts the full admin layout's header reads on every page (header.cfm 176-246). */
import { Roles, hasAnyRole, moduleRole, type UserClaims } from '@opt2/platform/auth';
import { cfDateAdd } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import { poolTenantFor, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import type { ContentRepository } from '../repo/repository.js';

/** The contract's header prompt counts. */
export type HeaderPrompts = components['schemas']['HeaderPrompts'];

/** The database, repository and clock the counts read. */
export interface HeaderPromptDeps {
  readonly db: TenantDb;
  readonly repository: ContentRepository;
  readonly clock: Clock;
}

const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const CHANGESETS_MODULE_ID = '00000000000000000000000000000000014';

/** sessionUserFacade `isAdminUser() or isSuperUser()`: S2, or the site's private-pool Admin group. */
function isAdminOrSuperUser(claims: UserClaims): boolean {
  return claims.s2 || hasAnyRole(claims.roles, [Roles.s2, Roles.siteAdmin]);
}

/** `session.mura.membershipids`: the user's projected groups, kept in the token site's private user pool tenant. */
async function membershipIds(deps: HeaderPromptDeps, claims: UserClaims): Promise<string[]> {
  const poolTenant = await withMetadata(deps.db, (tx) => poolTenantFor(tx, claims.tid, 'privateUser'));
  if (poolTenant === null) return [];
  return withTenant(deps.db, poolTenant, (tx) => deps.repository.projections.groupsOfUser(tx, claims.sub));
}

/** permUtility `getModulePerm` of both the Change Sets and the Site Manager module. */
function hasChangesetModules(claims: UserClaims): boolean {
  return (
    isAdminOrSuperUser(claims) ||
    [CHANGESETS_MODULE_ID, SITE_MANAGER_MODULE_ID].every((moduleId) => claims.roles.includes(moduleRole(moduleId)))
  );
}

/**
 * contentManager getMyDraftsCount (last three months), getMySubmissionsCount, getMyApprovalsCount and getMyExpiresCount
 * of the token's user and site, and hasPendingApprovals summed over the unpublished change sets (0 without both modules).
 */
export async function loadHeaderPrompts(deps: HeaderPromptDeps, claims: UserClaims): Promise<HeaderPrompts> {
  const { content, changesets } = deps.repository;
  const now = deps.clock.now();
  const siteId = claims.site;
  const userId = claims.sub;
  const groupIds = isAdminOrSuperUser(claims) ? null : await membershipIds(deps, claims);
  return withTenant(deps.db, claims.tid, async (tx) => ({
    drafts: await content.draftCount(tx, { siteId, userId, startDate: cfDateAdd('m', -3, now) }),
    submissions: await content.submissionsCount(tx, { siteId, userId }),
    approvals: await content.approvalsCount(tx, { siteId, groupIds }),
    expires: await content.expiringCount(tx, { siteId, userId, today: now }),
    pendingChangesets: hasChangesetModules(claims) ? await changesets.unpublishedPendingApprovals(tx, { siteId }) : 0,
  }));
}
