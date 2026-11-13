/**
 * Admin group routes of the cUsers group actions: group list, Edit Group read and save, members, member add and remove, the
 * members CSV and a user's memberships [legacy: admin/core/controllers/cusers.cfc:90-353,473-496].
 */
import { AuthDenial, Roles, moduleRole, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LegacyApiError,
  cfDateTimeFormat,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  isCfUuid,
  legacyQuery,
  legacyUsersCsv,
} from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { registeredTenants, registryEntryForTenant, tenantForRegisteredSite, withTenant, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import {
  addToGroup,
  createGroup,
  findGroupForSite,
  groupSaveInputFrom,
  listGroupMembers,
  listGroups,
  newGroupRecord,
  removeFromGroup,
  updateGroup,
  type GroupActor,
  type GroupDeps,
  type GroupListRow,
  type GroupMemberRow,
  type GroupRecord,
  type GroupSaveInput,
  type GroupSaveResult,
} from '../domain/groups.js';
import { locateSession, type SessionDeps } from '../domain/sessions.js';
import type { components } from '../generated/openapi.js';
import { validateCsrfForRoute, type CsrfRouteDeps } from './internal-csrf.js';

// Group deletes, and saves that set or remove a photo or carry extended attributes, also write strategies-content units, so
// they stay on legacy (withheld) and have no route here; the FW/1 redirects after each action are web's.

type Schemas = components['schemas'];
type Rc = Record<string, unknown>;

/** The group, session and CSRF operations the routes delegate to; `groups.db` also reads the site registry. */
export type AdminGroupRouteDeps = { groups: GroupDeps; sessions: SessionDeps; csrf: CsrfRouteDeps['csrf'] };

interface GroupParams {
  groupId: string;
}

interface MemberParams {
  groupId: string;
  userId: string;
}

interface UserParams {
  userId: string;
}

/** The verified caller and the two cUsers `before()` flags its login-time roles give. */
interface CusersCaller {
  user: UserClaims;
  /** `rc.isAdmin`: S2, or a member of the site's private-pool Admin group. */
  isAdmin: boolean;
  isS2: boolean;
}

/** The login snapshot values a group write's audit columns read. */
interface SnapshotNames {
  fname: string | null;
  lname: string | null;
  roleList: string;
}

const USERS_MODULE_ROLE = moduleRole('00000000000000000000000000000000008');
const SITE_MANAGER_MODULE_ROLE = moduleRole('00000000000000000000000000000000000');

// The hooks admit any of the three roles; `cusersCaller` then requires the Site Manager grant beside a lone Users grant.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.s2, Roles.siteAdmin, USERS_MODULE_ROLE]),
});

const CF_UUID = {
  type: 'string',
  minLength: 35,
  maxLength: 35,
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$',
} as const;

const GROUP_PARAMS = { type: 'object', required: ['groupId'], properties: { groupId: CF_UUID } } as const;
const MEMBER_PARAMS = { type: 'object', required: ['groupId', 'userId'], properties: { groupId: CF_UUID, userId: CF_UUID } } as const;
const USER_PARAMS = { type: 'object', required: ['userId'], properties: { userId: CF_UUID } } as const;

/** The `before()` param defaults a save reads; `userBean.set(rc)` copies each onto the bean [legacy: admin/core/controllers/cusers.cfc:126-160]. */
const SAVE_DEFAULTS: ReadonlyArray<readonly [name: string, value: string]> = [
  ['categoryid', ''],
  ['ContactForm', '0'],
  ['isPublic', '1'],
  ['email', ''],
  ['jobtitle', ''],
  ['groupname', ''],
  ['fname', ''],
  ['lname', ''],
  ['city', ''],
  ['state', ''],
  ['zip', ''],
  ['fax', ''],
  ['perm', '0'],
  ['groupid', ''],
  ['InActive', '0'],
];

/** Fields `update()` removes when a non-superuser saves an S2 record [legacy: admin/core/controllers/cusers.cfc:300-307]. */
const S2_RECORD_FIELDS = ['username', 'password', 'password2', 'passwordNoCache', 'email', 'inactive', 'isPublic'] as const;

// `tusers.userID AS groupID` aliases the member's own id, then userDAO's fieldList follows [legacy: core/mura/user/userDAO.cfc:78,652].
/** The columns of `readGroupMemberships`, as its query selects them. */
const MEMBER_COLUMNS = [
  'groupID', 'userID', 'GroupName', 'Fname', 'Lname', 'UserName', 'PasswordCreated', 'Email', 'Company', 'JobTitle', 'MobilePhone',
  'Website', 'Type', 'subType', 'ContactForm', 'S2', 'LastLogin', 'LastUpdate', 'LastUpdateBy', 'LastUpdateByID', 'Perm', 'InActive',
  'IsPublic', 'SiteID', 'Subscribe', 'Notes', 'description', 'Interests', 'keepPrivate', 'PhotoFileID', 'IMName', 'IMService',
  'Created', 'RemoteID', 'Tags', 'tablist', 'photoFileExt',
] as const;

type MemberValue = string | number | null;

/** ACF 2023's `columnList` of that query: upper-cased and sorted, the order the users CSV writes its columns in. */
const MEMBER_CSV_COLUMNS: readonly string[] = MEMBER_COLUMNS.map((column) => column.toUpperCase()).sort();

/** The cUsers `before()` access gate: S2, site admin, or both the Users and Site Manager module grants [legacy: admin/core/controllers/cusers.cfc:95,110-123]. */
function cusersCaller(auth: Opt2AuthContext): CusersCaller {
  const { user } = auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  const holds = (role: string): boolean => user.roles.includes(role);
  const isS2 = holds(Roles.s2);
  const isAdmin = isS2 || holds(Roles.siteAdmin);
  if (!isAdmin && !(holds(USERS_MODULE_ROLE) && holds(SITE_MANAGER_MODULE_ROLE))) throw AuthDenial.forbidden();
  return { user, isAdmin, isS2 };
}

/** The key of `rc` named `name` ignoring case, as a CFML scope matches it. */
function rcKey(rc: Rc, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(rc).find((key) => key.toLowerCase() === wanted);
}

function rcValue(rc: Rc, name: string): unknown {
  const key = rcKey(rc, name);
  return key === undefined ? undefined : rc[key];
}

function rcSet(rc: Rc, name: string, value: unknown): void {
  const key = rcKey(rc, name);
  if (key !== undefined) delete rc[key];
  rc[name] = value;
}

function rcDelete(rc: Rc, name: string): void {
  const key = rcKey(rc, name);
  if (key !== undefined) delete rc[key];
}

/** `rc.siteid`: the supplied value as spelled, or the token's site when absent or empty [legacy: admin/core/controllers/cusers.cfc:91-93]. */
function rcSiteId(rc: Rc, user: UserClaims): string {
  const supplied = rcValue(rc, 'siteid');
  return typeof supplied === 'string' && supplied !== '' ? supplied : user.site;
}

/** `rc.ispublic` after `before()` scrubs it: kept for an admin when CFML reads it as a boolean, else 1 [legacy: admin/core/controllers/cusers.cfc:163]. */
function scrubbedIsPublic(value: unknown, isAdmin: boolean): unknown {
  return isAdmin && cfIsBoolean(value) ? value : 1;
}

/** A scrubbed `ispublic` as the numeric argument `getUserGroups` declares. */
function poolFlag(value: unknown): number {
  if (cfIsNumeric(value)) return cfToNumber(value);
  return cfToBoolean(value) ? 1 : 0;
}

/** Whether the save names a photo or extended attributes, the variants that stay on legacy. */
function isWithheldSave(rc: Rc): boolean {
  const filled = (name: string): boolean => {
    const value = rcValue(rc, name);
    return value !== undefined && value !== null && String(value) !== '';
  };
  const removePhoto = rcValue(rc, 'removePhotoFile');
  return filled('newFile') || filled('extendSetID') || (cfIsBoolean(removePhoto) && cfToBoolean(removePhoto));
}

/** The acting session user, from its login snapshot; a session that is gone or signed out has no actor. */
async function actorOf(sessions: SessionDeps, user: UserClaims): Promise<GroupActor> {
  const row = user.sid === '' ? undefined : (await locateSession(sessions, user.sid))?.row;
  if (row === undefined || row.state !== 'active' || row.user_id === null || row.login_snapshot === null) {
    throw AuthDenial.unauthenticated('invalid-credential');
  }
  const snapshot = JSON.parse(row.login_snapshot) as SnapshotNames;
  // isSuperUser() reads the login-time role list, which lists S2 as its own item.
  return { userId: user.sub, fname: snapshot.fname, lname: snapshot.lname, isSuperUser: cfListToArray(snapshot.roleList).includes('S2') };
}

/** Whether `userId` is a CF UUID naming a stored S2 group, which `userBean.loadBy` reads by id [legacy: admin/core/controllers/cusers.cfc:298-300]. */
async function isS2Record(groups: GroupDeps, userId: string, siteId: string): Promise<boolean> {
  if (!isCfUuid(userId)) return false;
  const located = await findGroupForSite(groups, { groupId: userId, siteId });
  return located !== null && (located.group.s2 ?? 0) !== 0;
}

/**
 * The save input of `rc` as `before()` and `update()` leave it: defaults, `siteid`, `userid`, the scrubbed `ispublic`, and `s2`
 * and the S2-record fields removed for a non-superuser [legacy: admin/core/controllers/cusers.cfc:91-169,294-314].
 * @throws LegacyApiError `invalidParameters` for a field that is not a simple value.
 */
async function saveInputOf(deps: AdminGroupRouteDeps, rc: Rc, caller: CusersCaller, actor: GroupActor, userId: string): Promise<GroupSaveInput> {
  for (const [name, value] of SAVE_DEFAULTS) if (rcKey(rc, name) === undefined) rc[name] = value;
  const siteId = rcSiteId(rc, caller.user);
  rcSet(rc, 'siteid', siteId);
  rcSet(rc, 'userid', userId);
  rcSet(rc, 'isPublic', scrubbedIsPublic(rcValue(rc, 'ispublic'), caller.isAdmin));
  if (!actor.isSuperUser) {
    rcDelete(rc, 's2');
    if (await isS2Record(deps.groups, userId, siteId)) for (const field of S2_RECORD_FIELDS) rcDelete(rc, field);
  }
  try {
    return groupSaveInputFrom(rc);
  } catch (err) {
    if (err instanceof TypeError) throw new LegacyApiError('invalidParameters');
    throw err;
  }
}

/**
 * `update()` of one `type=1` action: the CSRF check under `rc.userid`, then the save [legacy: admin/core/controllers/cusers.cfc:316-331].
 * @throws LegacyApiError `invalidParameters` for a photo or extended-attribute save, `server_error` for a missing or invalid token.
 */
async function saveGroup(
  deps: AdminGroupRouteDeps,
  request: FastifyRequest,
  caller: CusersCaller,
  userId: string,
  save: (groups: GroupDeps, actor: GroupActor, input: GroupSaveInput) => Promise<GroupSaveResult>,
): Promise<Schemas['GroupWriteResult']> {
  const rc = legacyParamsOf(request);
  // The gateway routes these variants to legacy; the contract's GroupInput refuses them as invalid parameters (400).
  if (isWithheldSave(rc)) throw new LegacyApiError('invalidParameters');
  const actor = await actorOf(deps.sessions, caller.user);
  const input = await saveInputOf(deps, rc, caller, actor, userId);
  // Without a valid token legacy runs no save and then fails reading the unset `rc.userBean`.
  if (!(await validateCsrfForRoute({ csrf: deps.csrf }, request, userId))) throw new LegacyApiError('server_error');
  const result = await save(deps.groups, actor, input);
  return { written: result.written, group: groupAccount(result.group), errors: result.errors };
}

/** A `timestamp without time zone` value as the contract's `LocalTimestamp`. */
function localTimestamp(value: Date | null): string | null {
  return value === null ? null : cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(' ', 'T');
}

/** A group record in `tusers` bootstrap casing; the stored password hash is never sent. */
function groupAccount(group: GroupRecord): Schemas['GroupAccount'] {
  return {
    UserID: group.userid,
    GroupName: group.groupname,
    Fname: group.fname,
    Lname: group.lname,
    UserName: group.username,
    Password: null,
    PasswordCreated: localTimestamp(group.passwordcreated),
    Email: group.email,
    Company: group.company,
    JobTitle: group.jobtitle,
    mobilePhone: group.mobilephone,
    Website: group.website,
    Type: 1,
    subType: group.subtype,
    Ext: group.ext,
    ContactForm: group.contactform,
    Admin: group.admin,
    S2: group.s2,
    LastLogin: localTimestamp(group.lastlogin),
    LastUpdate: localTimestamp(group.lastupdate),
    LastUpdateBy: group.lastupdateby,
    LastUpdateByID: group.lastupdatebyid,
    Perm: group.perm,
    InActive: group.inactive,
    isPublic: group.ispublic,
    // A NULL SiteID reads as '' from the legacy query.
    SiteID: group.siteid ?? '',
    Subscribe: group.subscribe,
    notes: group.notes,
    description: group.description,
    interests: group.interests,
    keepPrivate: group.keepprivate,
    photoFileID: group.photofileid,
    IMName: group.imname,
    IMService: group.imservice,
    created: localTimestamp(group.created),
    remoteID: group.remoteid,
    tags: group.tags,
    tablist: group.tablist,
  };
}

/** One `getUserGroups` row [legacy: core/mura/user/userGateway.cfc:99-100]. */
function groupListItem(row: GroupListRow): Schemas['GroupListItem'] {
  return {
    UserID: row.userid,
    Email: row.email,
    GroupName: row.groupname,
    Type: 1,
    LastLogin: localTimestamp(row.lastlogin),
    LastUpdate: localTimestamp(row.lastupdate),
    LastUpdateBy: row.lastupdateby,
    LastUpdateByID: row.lastupdatebyid,
    Counter: row.counter,
    Perm: row.perm,
    isPublic: row.ispublic,
  };
}

// Identity holds the account columns and the contact names and email; the person columns people owns, and the photo
// extension from strategies-content's tfiles, read as NULL.
/** One `readGroupMemberships` row of a member, every column present in query order. */
function memberRow(member: GroupMemberRow): Schemas['GroupMember'] {
  const columns: Record<string, MemberValue> = Object.fromEntries(MEMBER_COLUMNS.map((column) => [column, null]));
  return {
    ...columns,
    groupID: member.userid,
    userID: member.userid,
    Fname: member.fname,
    Lname: member.lname,
    UserName: member.username,
    Email: member.email,
    Company: member.company,
    Type: member.type,
    S2: member.s2,
    InActive: member.inactive,
    IsPublic: member.ispublic,
    SiteID: member.siteid,
  };
}

/** A group's members, S2 members only for an S2 caller, as `readGroupMemberships` filters them [legacy: core/mura/user/userDAO.cfc:656]. */
async function memberRows(deps: AdminGroupRouteDeps, caller: CusersCaller, groupId: string): Promise<Schemas['GroupMember'][]> {
  return (await listGroupMembers(deps.groups, groupId, { includeS2: caller.isS2 })).map(memberRow);
}

/** The registry entry of a registered legacy site id; null when unregistered. */
async function siteEntry(groups: GroupDeps, siteId: string): Promise<TenantRegistryEntry | null> {
  const tenantId = await tenantForRegisteredSite(groups.db, siteId);
  return tenantId === null ? null : registryEntryForTenant(groups.db, tenantId);
}

/** The private (0) or public (1) user pool of `entry` and its tenant; null when unset. */
function userPool(entry: TenantRegistryEntry, isPublic: 0 | 1): { siteId: string; tenantId: string } | null {
  const siteId = isPublic === 1 ? entry.publicUserPoolId : entry.privateUserPoolId;
  const tenantId = isPublic === 1 ? entry.publicUserPoolTenant : entry.privateUserPoolTenant;
  return siteId === null || siteId === '' || tenantId === null ? null : { siteId, tenantId };
}

/**
 * `getPrivateGroups` (0) or `getPublicGroups` (1) of a site, by `Perm` descending, then name; legacy inner-joins the pool
 * site's own settings on that pool id, so a pool site that pools elsewhere lists nothing [legacy: core/mura/user/userGateway.cfc:594-622].
 */
async function poolGroups(groups: GroupDeps, entry: TenantRegistryEntry | null, isPublic: 0 | 1): Promise<Schemas['GroupSummary'][]> {
  const pool = entry === null ? null : userPool(entry, isPublic);
  if (entry === null || pool === null) return [];
  const poolEntry = pool.tenantId === entry.tenantId ? entry : await registryEntryForTenant(groups.db, pool.tenantId);
  const own = poolEntry === null ? null : userPool(poolEntry, isPublic);
  if (own === null || own.siteId.toLowerCase() !== pool.siteId.toLowerCase()) return [];
  const rows = await withTenant(groups.db, pool.tenantId, (tx) => groups.repo.listPoolGroups(tx, pool.siteId, isPublic));
  return rows.map((row) => ({ UserID: row.userid, GroupName: row.groupname }));
}

/** SQL Server equality key of a `char(35)` id: case-insensitive, trailing spaces ignored. */
function idKey(id: string): string {
  return id.replace(/ +$/, '').toLowerCase();
}

/** The listing order of `order by tusers.groupname`: NULL names first, then names ignoring case, ties by id. */
function byGroupName(a: { userid: string; groupname: string | null }, b: { userid: string; groupname: string | null }): number {
  const left = a.groupname?.toLowerCase() ?? null;
  const right = b.groupname?.toLowerCase() ?? null;
  if (left !== right) {
    if (left === null) return -1;
    if (right === null) return 1;
    return left < right ? -1 : 1;
  }
  const leftId = idKey(a.userid);
  const rightId = idKey(b.userid);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/**
 * `readMembershipIDs`: the stored groups `userId` belongs to, by group name; the membership rows live in the member's tenant and
 * the groups in their pools' tenants, so every registered tenant is read [legacy: core/mura/user/userDAO.cfc:632-644].
 */
async function membershipIds(groups: GroupDeps, userId: string): Promise<string[]> {
  const tenants = (await registeredTenants(groups.db)).map((entry) => entry.tenantId);
  const held = new Map<string, string>();
  for (const tenantId of tenants) {
    for (const groupId of await withTenant(groups.db, tenantId, (tx) => groups.repo.membershipGroupIds(tx, userId))) held.set(idKey(groupId), groupId);
  }
  if (held.size === 0) return [];
  const ids = [...held.values()];
  const found = new Map<string, { userid: string; groupname: string | null }>();
  for (const tenantId of tenants) {
    for (const group of await withTenant(groups.db, tenantId, (tx) => groups.repo.findGroupsByIds(tx, ids))) found.set(idKey(group.userid), group);
  }
  return [...found.values()].sort(byGroupName).map((group) => group.userid);
}

/** Registers the cUsers group reads and writes; the auth hooks answer a `siteid` other than the token's site with 403. */
export async function registerAdminGroupRoutes(app: FastifyInstance, deps: AdminGroupRouteDeps): Promise<void> {
  const { groups } = deps;
  const csrfDeps: CsrfRouteDeps = { csrf: deps.csrf };

  // `cUsers.list` [legacy: admin/core/controllers/cusers.cfc:178-183, core/mura/user/userGateway.cfc:93-120]
  app.get<{ Reply: Schemas['GroupList'] }>('/v1/groups', { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const caller = cusersCaller(request.opt2Auth);
    const rc = legacyParamsOf(request);
    const isPublic = poolFlag(scrubbedIsPublic(rcValue(rc, 'ispublic'), caller.isAdmin));
    const rows = await listGroups(groups, { siteId: rcSiteId(rc, caller.user), isPublic });
    return { items: rows.map(groupListItem) };
  });

  // `cUsers.update` with `type=1` and `action=Add` [legacy: admin/core/controllers/cusers.cfc:324-328]
  app.post<{ Reply: Schemas['GroupWriteResult'] }>('/v1/groups', { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const caller = cusersCaller(request.opt2Auth);
    const posted = rcValue(legacyParamsOf(request), 'userid');
    // The form posts the id its new bean generated, which is also the token's context.
    if (typeof posted !== 'string' || !isCfUuid(posted)) throw new LegacyApiError('invalidParameters');
    return saveGroup(deps, request, caller, posted, createGroup);
  });

  // `cUsers.editGroup`: an unknown id reads as a new bean, whose id `getUserID()` generates [legacy: admin/core/controllers/cusers.cfc:219-230].
  app.get<{ Params: GroupParams; Reply: Schemas['GroupDetail'] }>(
    '/v1/groups/:groupId',
    { schema: { params: GROUP_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const caller = cusersCaller(request.opt2Auth);
      const located = await findGroupForSite(groups, { groupId: request.params.groupId, siteId: rcSiteId(legacyParamsOf(request), caller.user) });
      if (located === null) return { group: groupAccount(newGroupRecord(groups.clock)), isNew: true };
      return { group: groupAccount(located.group), isNew: false };
    },
  );

  // `cUsers.update` with `type=1` and `action=Update` [legacy: admin/core/controllers/cusers.cfc:318-320]
  app.put<{ Params: GroupParams; Reply: Schemas['GroupWriteResult'] }>(
    '/v1/groups/:groupId',
    { schema: { params: GROUP_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => saveGroup(deps, request, cusersCaller(request.opt2Auth), request.params.groupId, updateGroup),
  );

  // `cUsers.editGroupMembers` [legacy: admin/core/controllers/cusers.cfc:234,263-265]
  app.get<{ Params: GroupParams; Reply: Schemas['GroupMembers'] }>(
    '/v1/groups/:groupId/members',
    { schema: { params: GROUP_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const caller = cusersCaller(request.opt2Auth);
      return { items: await memberRows(deps, caller, request.params.groupId) };
    },
  );

  // `cUsers.downloadGroupMembers` then `cUsers.download` [legacy: admin/core/controllers/cusers.cfc:267-270,460-496]
  app.get<{ Params: GroupParams }>(
    '/v1/groups/:groupId/members.csv',
    { schema: { params: GROUP_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request, reply) => {
      const caller = cusersCaller(request.opt2Auth);
      const csv = legacyUsersCsv(legacyQuery([...MEMBER_CSV_COLUMNS], await memberRows(deps, caller, request.params.groupId)));
      return reply.headers(csv.headers).send(csv.body);
    },
  );

  // `cUsers.addToGroup` [legacy: admin/core/controllers/cusers.cfc:272-277]
  app.post<{ Params: MemberParams; Reply: Schemas['WriteResult'] }>(
    '/v1/groups/:groupId/members/:userId',
    { schema: { params: MEMBER_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      cusersCaller(request.opt2Auth);
      const { groupId, userId } = request.params;
      if (!(await validateCsrfForRoute(csrfDeps, request, `${userId}${groupId}addtogroup`))) return { written: false };
      return { written: await addToGroup(groups, { userId, groupId }) };
    },
  );

  // `cUsers.removeFromGroup` checks no CSRF token, as legacy checks none [legacy: admin/core/controllers/cusers.cfc:279-282].
  app.delete<{ Params: MemberParams; Reply: Schemas['WriteResult'] }>(
    '/v1/groups/:groupId/members/:userId',
    { schema: { params: MEMBER_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      cusersCaller(request.opt2Auth);
      const { groupId, userId } = request.params;
      return { written: await removeFromGroup(groups, { userId, groupId }) };
    },
  );

  // The Group Memberships tab of `cUsers.editUser` [legacy: admin/core/controllers/cusers.cfc:243-261, core/mura/user/userDAO.cfc:632-644].
  app.get<{ Params: UserParams; Reply: Schemas['UserMemberships'] }>(
    '/v1/users/:userId/memberships',
    { schema: { params: USER_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => {
      const caller = cusersCaller(request.opt2Auth);
      const entry = await siteEntry(groups, rcSiteId(legacyParamsOf(request), caller.user));
      return {
        privateGroups: await poolGroups(groups, entry, 0),
        publicGroups: await poolGroups(groups, entry, 1),
        groupIds: await membershipIds(groups, request.params.userId),
      };
    },
  );
}
