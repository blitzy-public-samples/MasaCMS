/** The `session.mura` role list, user struct and login snapshot `loginByQuery` builds, and the token roles a snapshot grants on a site. */
import { readFile } from 'node:fs/promises';
import { Roles, SYNTHETIC_ROLES, isCoreModuleId, moduleRole } from '@opt2/platform/auth';
import { cfDateTimeFormat, cfListAppend, cfListToArray, sqlServerDatetime } from '@opt2/platform/legacy-compat';
import type { TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { CredentialRow, LoginSnapshot, LoginStateRow, PersonContactRow, UserAccountRow } from '../repo/tables.js';

/** One row of `rsGetRoles`: a group the user belongs to [legacy: core/mura/user/userUtility.cfc:315-318]; NULL columns render as ''. */
export interface MembershipGroup {
  groupId: string;
  groupName: string | null;
  siteId: string | null;
  isPublic: number | null;
}

/** The account columns `loginByQuery` reads from the user's `tusers` row. */
export type RoleListAccount = Pick<UserAccountRow, 'userid' | 'username' | 'siteid' | 'ispublic' | 's2'>;

/** The rows a login reads: account, credential, login state before this login's update, person contact and memberships. */
export interface LoginRows {
  account: RoleListAccount & Pick<UserAccountRow, 'remoteid'>;
  credential: Pick<CredentialRow, 'password' | 'passwordcreated'> | null;
  loginState: Pick<LoginStateRow, 'lastlogin'> | null;
  contact: Pick<PersonContactRow, 'fname' | 'lname' | 'email' | 'company' | 'subtype'> | null;
  /** In the stable order the repository returns them; legacy reads them without ORDER BY. */
  groups: readonly MembershipGroup[];
}

/** The user fields `setUserStruct` copies into `session.mura`; timestamps are canonical text or ''. */
export interface LegacyUserFields {
  userID: string;
  username: string;
  siteID: string;
  subtype: string;
  password: string;
  fname: string;
  lname: string;
  email: string;
  remoteID: string;
  company: string;
  lastlogin: string;
  passwordCreated: string;
}

/** `session.mura` of a logged-in user [legacy: core/mura/user/userUtility.cfc:765-783]. */
export interface LegacyUserStruct extends LegacyUserFields {
  isLoggedIn: true;
  memberships: string;
  membershipids: string;
}

/** `session.mura` of a session without a user [legacy: core/mura/user/userUtility.cfc:784-801]. */
export interface AnonymousUserStruct extends LegacyUserFields {
  isLoggedIn: false;
  memberships: '';
  membershipids: '';
  showTrace: false;
}

/** The not-logged-in `session.mura` values. */
export const ANONYMOUS_USER_STRUCT: Readonly<AnonymousUserStruct> = Object.freeze({
  isLoggedIn: false,
  userID: '',
  siteID: '',
  subtype: 'Default',
  username: '',
  password: '',
  fname: '',
  lname: '',
  company: '',
  lastlogin: '',
  passwordCreated: '',
  email: '',
  remoteID: '',
  memberships: '',
  membershipids: '',
  showTrace: false,
});

/** One synthetic-role group of `config/role-map.json`. */
export interface RoleMapEntry {
  groupName: string;
  role: string;
}

/** `config/role-map.json`: private-pool group names that grant synthetic roles. */
export interface RoleMap {
  sourceSha: string;
  scope: 'privateUserPool';
  groups: readonly RoleMapEntry[];
}

/** One `tpermissions` module grant of the site, joined to its group's current name and visibility. */
export interface ModuleGroupGrant {
  moduleId: string;
  groupName: string | null;
  isPublic: number | null;
}

/** Inputs of `tokenRolesFor` that callers read from the database or config. */
export interface TokenRoleOptions {
  moduleGrants: readonly ModuleGroupGrant[];
  roleMap: RoleMap;
}

/** Token roles of a snapshot on one site; `roles` is empty without site access. */
export interface TokenRoles {
  roles: string[];
  hasSiteAccess: boolean;
}

/** The registry fields token roles read: the site id and its raw legacy user-pool site ids. */
export type TokenRoleSite = Pick<TenantRegistryEntry, 'siteId' | 'privateUserPoolId' | 'publicUserPoolId'>;

const ROLE_MAP_URL = new URL('../../config/role-map.json', import.meta.url);

let roleMapPromise: Promise<RoleMap> | undefined;

/** CFML boolean of a numeric query value; NULL reads as false, as the repository reads flags. */
function cfTruthy(value: number | null): boolean {
  return value !== null && value !== 0;
}

/** A query value as CFML renders it inside a string: NULL as '', numbers in decimal. */
function cfText(value: string | number | null): string {
  return value === null ? '' : String(value);
}

/** Canonical `t` text of a stored timestamp, as a SQL Server `datetime` holds it and the bridge formats it; null stays null. */
function timestampText(value: Date | null): string | null {
  if (value === null) return null;
  const stored = sqlServerDatetime(value);
  return `${cfDateTimeFormat(stored, 'yyyy-mm-dd')}T${cfDateTimeFormat(stored, 'HH:nn:ss.lll')}`;
}

/** Java `Character.toUpperCase`/`toLowerCase` of one UTF-16 unit; units whose JS mapping is not one unit stay as they are. */
function foldUnit(unit: string, fold: 'upper' | 'lower'): string {
  const mapped = fold === 'upper' ? unit.toUpperCase() : unit.toLowerCase();
  return mapped.length === 1 ? mapped : unit;
}

/** Java `String.equalsIgnoreCase`, which CFML `listFindNoCase` compares elements with. */
function equalsIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a.charAt(i);
    const y = b.charAt(i);
    if (x === y) continue;
    const upperX = foldUnit(x, 'upper');
    const upperY = foldUnit(y, 'upper');
    if (upperX !== upperY && foldUnit(upperX, 'lower') !== foldUnit(upperY, 'lower')) return false;
  }
  return true;
}

/** CFML `listFind` on a comma list (empty elements skipped); `ignoreCase` gives `listFindNoCase`. */
export function roleListHas(list: string, entry: string, opts: { ignoreCase?: boolean } = {}): boolean {
  const matches = opts.ignoreCase === true ? (item: string) => equalsIgnoreCase(item, entry) : (item: string) => item === entry;
  return cfListToArray(list).some(matches);
}

/** The `session.mura.memberships` list `loginByQuery` builds [legacy: core/mura/user/userUtility.cfc:320-336]. */
export function buildLegacyRoleList(account: RoleListAccount, groups: readonly MembershipGroup[]): string {
  let list = '';
  for (const group of groups) {
    list = cfListAppend(list, `${cfText(group.groupName)};${cfText(group.siteId)};${cfText(group.isPublic)}`);
  }
  const siteId = cfText(account.siteid);
  const pool = cfTruthy(account.ispublic) ? 'S2IsPublic' : 'S2IsPrivate';
  list = cfListAppend(cfListAppend(list, `${pool};${siteId}`), pool);
  if (cfTruthy(account.s2)) {
    list = cfListAppend(list, 'S2');
  }
  return cfListAppend(list, `${cfText(account.username)};username;${siteId}`);
}

/** `listAppend(valueList(rsGetRoles.userID), rsuser.userid)`: the group ids in role-list order, then the user's own id [legacy: core/mura/user/userUtility.cfc:380]. */
export function membershipIdsFor(groups: readonly MembershipGroup[], userId: string): string {
  return cfListAppend(groups.map((group) => group.groupId).join(','), userId);
}

/** The logged-in `session.mura` values `setUserStruct` sets from the login rows [legacy: core/mura/user/userUtility.cfc:765-783]. */
export function buildUserStruct(rows: LoginRows): LegacyUserStruct {
  const { account, credential, loginState, contact, groups } = rows;
  return {
    isLoggedIn: true,
    userID: account.userid,
    username: cfText(account.username),
    siteID: cfText(account.siteid),
    subtype: contact === null ? ANONYMOUS_USER_STRUCT.subtype : cfText(contact.subtype),
    password: cfText(credential?.password ?? null),
    fname: cfText(contact?.fname ?? null),
    lname: cfText(contact?.lname ?? null),
    email: cfText(contact?.email ?? null),
    remoteID: cfText(account.remoteid),
    company: cfText(contact?.company ?? null),
    lastlogin: timestampText(loginState?.lastlogin ?? null) ?? '',
    passwordCreated: timestampText(credential?.passwordcreated ?? null) ?? '',
    memberships: buildLegacyRoleList(account, groups),
    // A tusers row has no groupID column, so setUserStruct takes the computed id list.
    membershipids: membershipIdsFor(groups, account.userid),
  };
}

/** The stored snapshot of a user struct and its role list; '' timestamps become null. */
export function snapshotOfUserStruct(user: LegacyUserFields & Pick<LegacyUserStruct, 'memberships' | 'membershipids'>): LoginSnapshot {
  return {
    userid: user.userID,
    username: user.username,
    siteid: user.siteID,
    subtype: user.subtype,
    password: user.password,
    fname: user.fname,
    lname: user.lname,
    email: user.email,
    remoteid: user.remoteID,
    company: user.company,
    lastlogin: user.lastlogin === '' ? null : user.lastlogin,
    passwordcreated: user.passwordCreated === '' ? null : user.passwordCreated,
    roleList: user.memberships,
    membershipIds: user.membershipids,
  };
}

/** The `session.mura` user struct a stored snapshot hydrates; NULL fields read as ''. */
export function userStructOf(snapshot: LoginSnapshot): LegacyUserStruct {
  return {
    isLoggedIn: true,
    userID: snapshot.userid,
    username: cfText(snapshot.username),
    siteID: cfText(snapshot.siteid),
    subtype: cfText(snapshot.subtype),
    password: cfText(snapshot.password),
    fname: cfText(snapshot.fname),
    lname: cfText(snapshot.lname),
    email: cfText(snapshot.email),
    remoteID: cfText(snapshot.remoteid),
    company: cfText(snapshot.company),
    lastlogin: cfText(snapshot.lastlogin),
    passwordCreated: cfText(snapshot.passwordcreated),
    memberships: snapshot.roleList,
    membershipids: snapshot.membershipIds,
  };
}

/** The login-time snapshot of a login, rebuilt only at login, legacy-equivalent re-login and adoption; S2 and pool flags stay in its role list. */
export function buildLoginSnapshot(rows: LoginRows): LoginSnapshot {
  return snapshotOfUserStruct(buildUserStruct(rows));
}

/** Whether the snapshot's role list holds `S2`, as `permUtility.isS2` and `getModulePerm` test it. */
export function snapshotIsS2(snapshot: Pick<LoginSnapshot, 'roleList'>): boolean {
  return roleListHas(snapshot.roleList, 'S2');
}

/** Checks the parsed `role-map.json` shape; throws a `TypeError` naming the first problem. */
export function parseRoleMap(value: unknown): RoleMap {
  const map = value as Partial<RoleMap> | null;
  if (typeof map !== 'object' || map === null || typeof map.sourceSha !== 'string' || map.scope !== 'privateUserPool' || !Array.isArray(map.groups)) {
    throw new TypeError('role-map.json must be {sourceSha, scope: "privateUserPool", groups: [...]}');
  }
  for (const group of map.groups as unknown[]) {
    const entry = group as Partial<RoleMapEntry> | null;
    if (typeof entry?.groupName !== 'string' || entry.groupName === '' || typeof entry.role !== 'string' || !SYNTHETIC_ROLES.includes(entry.role)) {
      throw new TypeError(`role-map.json group ${JSON.stringify(group)} needs a groupName and a synthetic role`);
    }
  }
  return { sourceSha: map.sourceSha, scope: map.scope, groups: map.groups.map(({ groupName, role }) => ({ groupName, role })) };
}

/** The committed `config/role-map.json`, read and checked once per process. */
export function loadRoleMap(): Promise<RoleMap> {
  roleMapPromise ??= readFile(ROLE_MAP_URL, 'utf8').then((text) => parseRoleMap(JSON.parse(text)));
  return roleMapPromise;
}

/** Module roles whose site grant the role list satisfies, ascending [legacy: core/mura/permission.cfc:338-344]. */
function moduleRolesFor(list: string, grants: readonly ModuleGroupGrant[], privatePool: string, publicPool: string): string[] {
  const roles = new Set<string>();
  for (const grant of grants) {
    if (!isCoreModuleId(grant.moduleId)) continue;
    const member = cfTruthy(grant.isPublic) ? `${cfText(grant.groupName)};${publicPool};1` : `${cfText(grant.groupName)};${privatePool};0`;
    if (roleListHas(list, member)) roles.add(moduleRole(grant.moduleId));
  }
  return [...roles].sort();
}

/**
 * Token roles of a login snapshot on `site`, from its login-time role list and the registry's pools. Each test keeps the case rule
 * of the legacy check it replaces: exact for S2, Admin and module grants [legacy: core/mura/permission.cfc:312,340-342], no-case for
 * the pool markers and fixture role groups [legacy: core/mura/permission.cfc:676,689-691].
 */
export function tokenRolesFor(snapshot: Pick<LoginSnapshot, 'roleList'>, site: TokenRoleSite, opts: TokenRoleOptions): TokenRoles {
  const list = snapshot.roleList;
  // settingsBean defaults an empty pool id to the site's own id.
  const privatePool = site.privateUserPoolId ?? site.siteId;
  const publicPool = site.publicUserPoolId ?? site.siteId;
  const s2 = snapshotIsS2(snapshot);
  const privateMember = roleListHas(list, `S2IsPrivate;${privatePool}`, { ignoreCase: true });
  const publicMember = roleListHas(list, `S2IsPublic;${publicPool}`, { ignoreCase: true });
  const privateGroupSuffix = `;${privatePool};0`;
  const inPrivateGroup = cfListToArray(list).some((item) => item.endsWith(privateGroupSuffix));
  if (!(s2 || inPrivateGroup || privateMember || publicMember)) {
    return { roles: [], hasSiteAccess: false };
  }

  const roles: string[] = [];
  if (s2) roles.push(Roles.s2);
  if (roleListHas(list, `Admin;${privatePool};0`)) roles.push(Roles.siteAdmin);
  roles.push(...moduleRolesFor(list, opts.moduleGrants, privatePool, publicPool));
  if (privateMember) roles.push(Roles.systemUser);
  if (publicMember) roles.push(Roles.member);
  for (const { groupName, role } of opts.roleMap.groups) {
    if (roleListHas(list, `${groupName};${privatePool};0`, { ignoreCase: true })) roles.push(role);
  }
  return { roles: [...new Set(roles)], hasSiteAccess: true };
}
