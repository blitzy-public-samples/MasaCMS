/** Admin permission routes of the `cperm` screens: `getContentPermissions`, `getModulePermissions` and `updateModulePermissions` [legacy: admin/core/controllers/cperm.cfc:78-160]. */
import { AuthDenial, Roles, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import { cfEq } from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  groupListForSite,
  groupPermVerdict,
  permissionsForContent,
  permittedGroups,
  updateModulePermissions,
  type PermissionDeps,
  type SiteGroupLists,
} from '../domain/permissions.js';
import type { components } from '../generated/openapi.js';
import { validateCsrfForRoute, type CsrfRouteDeps } from './internal-csrf.js';

// cperm.update is not served here: it also saves the node's approval-chain assignment, which strategies-content owns, so
// that spanning action stays on legacy (decision list) and its tpermissions writes reach identity through write windows.

type Schemas = components['schemas'];

/** The permission and CSRF operations the routes delegate to. */
export type AdminPermissionRouteDeps = { permissions: PermissionDeps; csrf: CsrfRouteDeps['csrf'] };

type GroupRow = SiteGroupLists['privateGroups'][number];

interface ContentParams {
  contentId: string;
}

interface ModuleParams {
  moduleId: string;
}

// The cPerm before() gate admits members of the site's private-pool Admin group and S2 users [legacy: admin/core/controllers/cperm.cfc:79-81].
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([Roles.s2, Roles.siteAdmin]) });

const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const HOME_CONTENT = '00000000000000000000000000000000001';

/** `updatemodule` redirects in legacy test order, each to `action` with `siteid` and then `extra` appended. */
const MODULE_REDIRECTS: ReadonlyArray<readonly [moduleId: string, action: string, extra: Readonly<Record<string, string>>]> = [
  ['00000000000000000000000000000000004', 'cUsers.list', {}],
  ['00000000000000000000000000000000005', 'cEmail.list', {}],
  ['00000000000000000000000000000000007', 'cForm.list', {}],
  ['00000000000000000000000000000000008', 'cUsers.list', {}],
  ['00000000000000000000000000000000009', 'cMailingList.list', {}],
  [SITE_MANAGER_MODULE, 'cArch.list', { topid: HOME_CONTENT, moduleid: SITE_MANAGER_MODULE }],
  ['00000000000000000000000000000000010', 'cCategory.list', {}],
  ['00000000000000000000000000000000011', 'cFeed.list', {}],
  ['00000000000000000000000000000000014', 'cChangesets.list', {}],
  ['00000000000000000000000000000000015', 'cComments.default', {}],
  ['00000000000000000000000000000000016', 'cArch.list', { activeTab: '2' }],
];

/** The redirect `updatemodule` answers for `rc.moduleid`: the first CFML `==` match, else the plugin list [legacy: admin/core/controllers/cperm.cfc:123-159]. */
function moduleRedirect(moduleId: string, siteId: string): Schemas['AdminRedirect'] {
  const match = MODULE_REDIRECTS.find(([id]) => cfEq(moduleId, id));
  if (match === undefined) return { action: 'cPlugins.list', params: { siteid: siteId } };
  const [, action, extra] = match;
  return { action, params: { siteid: siteId, ...extra } };
}

/** The verified user claims; both roles are user roles, so their absence is a missing credential. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** The merged url and form value `rc[name]` holds, the name matched ignoring case. */
function rcValue(request: FastifyRequest, name: string): unknown {
  const params = legacyParamsOf(request);
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : params[key];
}

/** `rc.siteid`: the supplied `siteid` as spelled, or the token's site when absent or empty [legacy: admin/Application.cfc:401-412]. */
function rcSiteId(request: FastifyRequest, user: UserClaims): string {
  const supplied = rcValue(request, 'siteid');
  return typeof supplied === 'string' && supplied !== '' ? supplied : user.site;
}

/** `rc.groupid` as the list loop reads it: a comma list or its items, `''` when absent [legacy: core/mura/permission.cfc:652]. */
function rcGroupIds(request: FastifyRequest): string | string[] {
  const value = rcValue(request, 'groupid');
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value : '';
}

/** SQL Server equality of two `char(35)` ids: case-insensitive, trailing spaces ignored. */
function sameId(a: string, b: string): boolean {
  return a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** A query row's group name as CFML renders it, NULL as `''`. */
function groupNameOf(group: GroupRow): string {
  return group.groupname ?? '';
}

/** Registers the `cperm` main and module reads and the module grant save; the auth hooks answer a `siteid` other than the token's site with 403. */
export async function registerAdminPermissionRoutes(app: FastifyInstance, deps: AdminPermissionRouteDeps): Promise<void> {
  const { permissions } = deps;
  const csrfDeps: CsrfRouteDeps = { csrf: deps.csrf };

  // [legacy: admin/core/controllers/cperm.cfc:110-112, admin/core/views/cperm/main.cfm:77-78,141,166,182]
  app.get<{ Params: ContentParams; Reply: Schemas['ContentPermissions'] }>(
    '/v1/permissions/content/:contentId',
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const { contentId } = request.params;
      const node = { siteId: user.site, contentId };
      const [lists, rows] = await Promise.all([groupListForSite(permissions, user.site), permissionsForContent(permissions, node)]);
      const verdicts = (groups: readonly GroupRow[]): Schemas['ContentGroupVerdict'][] =>
        groups.map((group) => ({ groupId: group.userid, groupName: groupNameOf(group), perm: groupPermVerdict(rows, group.userid) }));
      return { contentId, siteId: rcSiteId(request, user), groups: verdicts(lists.privateGroups), publicGroups: verdicts(lists.publicGroups) };
    },
  );

  // [legacy: admin/core/controllers/cperm.cfc:114-117, admin/core/views/cperm/module.cfm:77,103,113,126]
  app.get<{ Params: ModuleParams; Reply: Schemas['ModulePermissions'] }>(
    '/v1/permissions/modules/:moduleId',
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const { moduleId } = request.params;
      const [lists, rows] = await Promise.all([
        groupListForSite(permissions, user.site),
        permittedGroups(permissions, { siteId: user.site, contentId: moduleId }),
      ]);
      const grants = (groups: readonly GroupRow[]): Schemas['ModuleGroupGrant'][] =>
        groups.map((group) => ({
          groupId: group.userid,
          groupName: groupNameOf(group),
          granted: rows.some((row) => sameId(row.groupid, group.userid)),
        }));
      return { moduleId, siteId: rcSiteId(request, user), privateGroups: grants(lists.privateGroups), publicGroups: grants(lists.publicGroups) };
    },
  );

  // [legacy: admin/core/controllers/cperm.cfc:119-160, core/mura/permission.cfc:643-669]
  app.put<{ Params: ModuleParams; Reply: Schemas['ModulePermissionsResult'] }>(
    '/v1/permissions/modules/:moduleId',
    { config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const user = userOf(request.opt2Auth);
      const { moduleId } = request.params;
      // The form's hidden `moduleid` is rc.moduleid, the CSRF context and redirect key; the path is the URL's contentid, the node written.
      const posted = rcValue(request, 'moduleid');
      const rcModuleId = typeof posted === 'string' ? posted : moduleId;
      const written = await validateCsrfForRoute(csrfDeps, request, rcModuleId);
      if (written) {
        await updateModulePermissions(permissions, { siteId: user.site, moduleId, groupIds: rcGroupIds(request) });
      }
      return { written, redirect: moduleRedirect(rcModuleId, rcSiteId(request, user)) };
    },
  );
}
