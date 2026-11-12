/** The single data-access path of schema `identity`: the platform repository plus typed account, group, membership, permission, auth-record, session, CSRF, account-operation and projection helpers. */
import {
  RepositoryError,
  createRepository,
  qualified,
  type Repository,
  type RepositoryRow,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import type { QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  ACCOUNT_OPERATION,
  AGGREGATE_VERSION,
  CREDENTIAL,
  CSRF_CLAIM,
  GROUP_ACCOUNT,
  GROUP_ADDRESS,
  GROUP_EXTEND_DATA,
  GROUP_FAVORITE,
  GROUP_INTEREST,
  GROUP_TAG,
  LOGIN_STATE,
  MEMBERSHIP,
  OAUTH_CLIENT,
  OAUTH_TOKEN,
  OWNED_TABLES,
  PERMISSION,
  PERSON_CONTACT,
  REDIRECT,
  REMOTE_SESSION,
  SESSION,
  USER_ACCOUNT,
  USER_DEVICE,
  USER_STRIKE,
  type AccountOperationKind,
  type AccountOperationRow,
  type AccountOperationState,
  type AccountState,
  type CredentialRow,
  type CsrfClaimRow,
  type CsrfClaimState,
  type GroupAccountRow,
  type GroupAddressRow,
  type GroupExtendDataRow,
  type GroupTagRow,
  type LoginStateRow,
  type OAuthClientRow,
  type OAuthTokenRow,
  type PermissionRow,
  type PersonContactRow,
  type RedirectRow,
  type RemoteSessionRow,
  type SessionRow,
  type UserAccountRow,
  type UserDeviceRow,
  type UserStrikeRow,
} from './tables.js';

/** Service name the identity write positions carry. */
export const OWNER = 'identity' as const;

/** Schema the identity service owns. */
export const SCHEMA = 'identity' as const;

const UNIQUE_VIOLATION = '23505';
const ONE_MINUTE_MS = 60_000;
/** Width of the legacy `char(35)` id columns. */
const ID_WIDTH = 35;
const OPEN_OPERATION_STATES: readonly AccountOperationState[] = ['prepared', 'committed'];

/** DAO `cfqueryparam null="#value eq ''#"`: an empty string is stored as NULL [legacy: core/mura/user/userDAO.cfc:304-343]. */
function daoNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** beanORM `addQueryParam`: a non-key value that is empty or the text `null` (any case) is stored as NULL [legacy: core/mura/bean/beanORM.cfc:338-341]. */
function ormRow<R extends RepositoryRow>(row: R, table: { key: readonly string[] | null }): R {
  const stored: RepositoryRow = {};
  for (const [column, value] of Object.entries(row)) {
    const empty = typeof value === 'string' && (value === '' || value.toLowerCase() === 'null');
    stored[column] = empty && !(table.key ?? []).includes(column) ? null : value;
  }
  return stored as R;
}

/** CFML `trim`, which is Java `String.trim`: strips every code unit up to U+0020 at both ends. */
function cfTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
  return value.slice(start, end);
}

/** The SQL Server `char` equality form of a key, as legacy_char_ci compares it: trailing spaces stripped, A-Z and À-Þ case folded. */
export function charKey(value: string): string {
  return value.replace(/ +$/, '').replace(/[A-Z\u00C0-\u00DE]/g, (c) => c.toLowerCase());
}

/** A posted id the legacy `char(35)` column can hold; legacy swallows the insert error of any other [legacy: core/mura/user/userDAO.cfc:561-581]. */
function storableId(value: string): boolean {
  return value !== '' && value.length <= ID_WIDTH;
}

/** CFML boolean of a numeric flag; NULL reads as false. */
function flag(value: number | boolean | null): boolean {
  return value === true || (typeof value === 'number' && value !== 0);
}

/** `at` one calendar day earlier on the local wall clock, as CFML `dateAdd('d', -1, at)`. */
function dayBefore(at: Date): Date {
  const day = new Date(at.getTime());
  day.setDate(day.getDate() - 1);
  return day;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** The parsed `session.admin_state` JSON text; `{}` for NULL. */
function storedAdminState(text: string | null): SessionAdminState {
  return text === null ? {} : (JSON.parse(text) as SessionAdminState);
}

/** The acting user of a group save, as the session's `session.mura` values give it. */
export interface AuditActor {
  userId: string;
  fname?: string | null;
  lname?: string | null;
  /** True when the names come from the acting session's login snapshot. */
  fromSnapshot: boolean;
}

/** First and last name of a row or contact. */
export interface AuditNames {
  fname: string | null;
  lname: string | null;
}

/**
 * `LastUpdateBy` and `LastUpdateByID` of a saved row [legacy: core/mura/user/userManager.cfc:834-845].
 * An actor without a snapshot is named by `contact`, its `identity.person_contact` row; no actor names the row itself.
 */
export function lastUpdateInfo(
  actor: AuditActor | null,
  row: AuditNames & { userid: string },
  contact?: AuditNames | null,
): { lastupdateby: string; lastupdatebyid: string } {
  // CFML left(..., 50) counts UTF-16 code units, as slice does; two empty names leave the stored single space.
  const label = (names: { fname?: string | null; lname?: string | null }): string => `${names.fname ?? ''} ${names.lname ?? ''}`.slice(0, 50);
  if (actor === null) {
    return { lastupdateby: label(row), lastupdatebyid: row.userid };
  }
  return { lastupdateby: label(actor.fromSnapshot ? actor : (contact ?? actor)), lastupdatebyid: actor.userId };
}

/** A Type=2 account to insert; `admin` is NULL and `opt2_state` `active` unless given. */
export type AccountInput = Omit<UserAccountRow, 'tenant_id' | 'admin' | 'opt2_state'> & { admin?: number | null; opt2_state?: AccountState };

/** The account columns `userDAO.update` sets [legacy: core/mura/user/userDAO.cfc:411-455]; `perm` and `admin` stay as stored. */
export type AccountUpdate = Pick<UserAccountRow, 'username' | 'type' | 's2' | 'inactive' | 'ispublic' | 'siteid' | 'remoteid' | 'tablist'>;

/** A stored credential: the already-computed `Password` value and its `PasswordCreated`. */
export type CredentialValues = Pick<CredentialRow, 'password' | 'passwordcreated'>;

/** Group columns a save supplies; the service sets the timestamps, audit columns and `row_version`. */
type GroupColumns = Omit<
  GroupAccountRow,
  'tenant_id' | 'userid' | 'passwordcreated' | 'lastlogin' | 'lastupdate' | 'lastupdateby' | 'lastupdatebyid' | 'created' | 'ext' | 'admin' | 'row_version'
>;

/** A Type=1 group to insert; without `userid` it gets a new CF UUID. `password` is the stored value. */
export type GroupInput = GroupColumns & { userid?: string };

/** A group's new values; `perm` is never updated and an empty `password` leaves the stored one. */
export type GroupUpdate = Omit<GroupColumns, 'perm'>;

/** A group address to insert; without `addressid` it gets a new CF UUID. */
export type GroupAddressInput = Partial<Omit<GroupAddressRow, 'tenant_id' | 'userid'>> & { userid: string };

/** The address columns `userDAO.updateAddress` sets [legacy: core/mura/user/userDAO.cfc:749-774]. */
export type GroupAddressUpdate = Partial<Omit<GroupAddressRow, 'tenant_id' | 'addressid' | 'userid' | 'isprimary'>> & { userid: string };

/** Stored value columns of one group extended attribute. */
export type GroupExtendValues = Omit<GroupExtendDataRow, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;

/** One attribute of a group extend save: its rows are deleted, then `values` is inserted unless null. */
export interface GroupExtendDataReplacement {
  attributeId: number;
  values: GroupExtendValues | null;
}

/** A group the user belongs to, as the login role list reads it [legacy: core/mura/user/userUtility.cfc:315-322]. */
export interface GroupMembership {
  userId: string;
  groupName: string | null;
  siteId: string | null;
  isPublic: number | null;
}

/** A member of a group: a Type=2 account named by its person contact, or a Type=1 group by its own columns. */
export interface GroupMemberRow {
  userid: string;
  type: number | null;
  username: string | null;
  siteid: string | null;
  ispublic: number | null;
  s2: number | null;
  inactive: number | null;
  fname: string | null;
  lname: string | null;
  email: string | null;
  company: string | null;
}

/** One node permission grant. */
export interface PermissionGrant {
  groupId: string;
  type: string;
}

/** One module grant of a group. */
export interface ModuleGrant {
  contentId: string;
  groupId: string;
}

/** Values `setStrike` stores. */
export type StrikeValues = Pick<UserStrikeRow, 'strikes' | 'lastattempt'>;

/** A session to insert; timestamps default to now and `epoch` to 0. */
export type SessionInsert = Pick<SessionRow, 'session_id' | 'csrf_secret' | 'mode' | 'state'> &
  Partial<Pick<SessionRow, 'user_id' | 'site_id' | 'login_snapshot' | 'jar_ref' | 'ended_at' | 'admin_state'>> & { epoch?: number | string };

/** Session columns `updateSession` may set; `updated_at` is always now. */
export type SessionPatch = Partial<
  Pick<SessionRow, 'user_id' | 'site_id' | 'login_snapshot' | 'csrf_secret' | 'mode' | 'state' | 'jar_ref' | 'ended_at' | 'admin_state'>
> & {
  epoch?: number | string;
};

/** Admin session-scope values by their legacy `session` names, as `session.admin_state` holds them. */
export type SessionAdminState = Record<string, unknown>;

/** A remote session to store. */
export type RemoteSessionInput = Omit<RemoteSessionRow, 'tenant_id'>;

/** A device to store. */
export type DeviceInput = Omit<UserDeviceRow, 'tenant_id'>;

/** `userDevice.loadBy` arguments [legacy: core/mura/login/loginManager.cfc:308-316]. */
export interface DeviceLookup {
  userId: string;
  deviceId: string;
  siteId?: string;
}

/** A redirect to insert under a new id, created now. */
export type RedirectInput = Pick<RedirectRow, 'userid' | 'siteid' | 'url'>;

/** Every non-key column of an OAuth client, as the ORM save writes them. */
export type OAuthClientValues = Omit<OAuthClientRow, 'tenant_id' | 'clientid'>;

/** An OAuth client to insert; without `clientid` it gets a new CF UUID. */
export type OAuthClientInput = OAuthClientValues & { clientid?: string };

/** An OAuth token to insert, its value and expiry computed by the caller [legacy: core/mura/client/api/oauth/oauthTokenBean.cfc:10-24]. */
export type OAuthTokenInput = Omit<OAuthTokenRow, 'tenant_id'>;

/** Arguments of `findReusableToken` [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:31-41]. */
export interface ReusableTokenLookup {
  clientId: string;
  grantType: string;
  userId: string;
  now: Date;
}

/** Arguments of `purgeExpiredTokens` [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:55-67]. */
export interface ExpiredTokenPurge {
  clientId: string;
  grantType: string;
  now: Date;
}

/** A CSRF claim to insert; `claimedAt` defaults to now, and `usedAt` to now for a `used` claim. */
export interface CsrfClaimInput {
  sessionId: string;
  token: string;
  state: CsrfClaimState;
  requestId?: string | null;
  claimedAt?: Date;
  usedAt?: Date | null;
}

/** Filters of `listCsrfClaims`; `since` keeps claims used or claimed at or after it. */
export interface CsrfClaimFilter {
  state?: CsrfClaimState;
  since?: Date;
}

/** Scope of `purgeCsrfClaims`; a claim's age is its use time, else its claim time [legacy: core/mura/user/sessionUserFacade.cfc:211-215]. */
export interface CsrfClaimPurge {
  olderThan?: Date;
  sessionId?: string;
}

/** An account operation to record; without `operation_id` it gets a new CF UUID. */
export type AccountOperationInput = { user_id: string; kind: AccountOperationKind; state: AccountOperationState } & Partial<
  Pick<AccountOperationRow, 'operation_id' | 'username' | 'pending_change' | 'before_values' | 'commit_xid'>
>;

/** Columns a state change of an account operation may also set. */
export type AccountOperationPatch = Partial<Pick<AccountOperationRow, 'pending_change' | 'before_values' | 'commit_xid'>>;

/** Lookup of an open operation by user id, by username (case-insensitive), or either. */
export type OpenOperationLookup = { userId: string; username?: string | null } | { userId?: string | null; username: string };

/** A Type=2 account with its `passwordcreated` and `lastlogin`; `closed` while an account operation on the user is open. */
export type AccountRecordRow = Omit<UserAccountRow, 'tenant_id'> &
  Pick<CredentialRow, 'passwordcreated'> &
  Pick<LoginStateRow, 'lastlogin'> & { closed: boolean };

/** One group of a user pool as `getPrivateGroups`/`getPublicGroups` list it. */
export type PoolGroupRow = Pick<GroupAccountRow, 'userid' | 'groupname' | 'perm'> & { siteid: string; ispublic: 0 | 1 };

/** A person-contact projection row to store; `updated_at` defaults to now. */
export type PersonContactInput = Omit<PersonContactRow, 'tenant_id' | 'aggregate_version' | 'updated_at'> & {
  aggregate_version: number | string;
  updated_at?: Date;
};

/** The platform repository of schema `identity` plus typed helpers; every helper runs in the caller's open tenant transaction. */
export interface IdentityRepository extends Repository {
  /** The underlying platform repository, as `registerMigrationHandlers` takes it. */
  readonly base: Repository;

  /** Active Type=2 accounts whose username matches `trim(username)` case-insensitively, ignoring trailing spaces, by userid [legacy: core/mura/user/userUtility.cfc:133-138]. */
  findAccountsByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow[]>;
  /** The first of `findAccountsByUsername`; null when none. */
  findAccountByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow | null>;
  /** The account `userId`; a `pending` account only with `includePending`. A migration apply's `ctx` reads without the window-phase wait. */
  findAccountById(tx: TenantTx, userId: string, opts?: { includePending?: boolean }, ctx?: WriteContext): Promise<UserAccountRow | null>;
  /** The Type=2 accounts among `userIds`, pending ones included, with their credential and login-state columns, by userid, in one statement. */
  readAccountRecords(tx: TenantTx, userIds: readonly string[]): Promise<AccountRecordRow[]>;
  /** Whether another Type=2 account, pending ones included, holds `trim(username)` [legacy: core/mura/user/userBean.cfc:411-424]. */
  isUsernameTaken(tx: TenantTx, username: string, exceptUserId: string): Promise<boolean>;
  /** Inserts an account with the DAO NULL rules. */
  insertAccount(tx: TenantTx, row: AccountInput, ctx?: WriteContext): Promise<UserAccountRow>;
  /** Sets the `userDAO.update` account columns; null when absent. */
  updateAccount(tx: TenantTx, userId: string, values: AccountUpdate, ctx?: WriteContext): Promise<UserAccountRow | null>;
  /** Sets `opt2_state`; null when absent. */
  setAccountState(tx: TenantTx, userId: string, state: AccountState, ctx?: WriteContext): Promise<UserAccountRow | null>;
  /** Deletes the account, credential and login-state rows of `userId`; false when no account row existed. */
  deleteAccount(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<boolean>;
  /** The credential of `userId`; null when absent. */
  readCredential(tx: TenantTx, userId: string): Promise<CredentialRow | null>;
  /** Stores the credential of `userId`, an empty password as NULL. */
  writeCredential(tx: TenantTx, userId: string, values: CredentialValues, ctx?: WriteContext): Promise<CredentialRow>;
  /** Sets `lastlogin = at` for a real login [legacy: core/mura/user/userUtility.cfc:367-370]. */
  touchLastLogin(tx: TenantTx, userId: string, at: Date, ctx?: WriteContext): Promise<LoginStateRow>;
  /** Inserts the login state of a new account with `lastlogin` NULL. */
  insertLoginState(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<LoginStateRow>;

  /** The group `groupId`; null when absent. */
  findGroup(tx: TenantTx, groupId: string): Promise<GroupAccountRow | null>;
  /** The groups of `groupIds` stored in this tenant, by userid. */
  findGroupsByIds(tx: TenantTx, groupIds: readonly string[]): Promise<GroupAccountRow[]>;
  /** The first Type=1 group of `siteId` named `name` case-insensitively, optionally of one visibility [legacy: core/mura/user/userDAO.cfc:176-216]. */
  findGroupByName(tx: TenantTx, name: string, opts: { siteId: string; isPublic?: boolean }): Promise<GroupAccountRow | null>;
  /** Type=1 groups of `poolSiteId` with that visibility, by name then userid [legacy: core/mura/permission.cfc:600-621]. */
  listGroups(tx: TenantTx, poolSiteId: string, isPublic: boolean | number, opts?: { excludeAdmin?: boolean }): Promise<GroupAccountRow[]>;
  /** Type=1 groups of `poolSiteId` with `ispublic` = `isPublic`, by Perm descending, then name [legacy: core/mura/user/userGateway.cfc:594-622]. */
  listPoolGroups(tx: TenantTx, poolSiteId: string, isPublic: 0 | 1): Promise<PoolGroupRow[]>;
  /** Inserts a group as `userDAO.create` does [legacy: core/mura/user/userDAO.cfc:300-346]. */
  insertGroup(tx: TenantTx, input: GroupInput, actor: AuditActor | null, ctx?: WriteContext): Promise<GroupAccountRow>;
  /** Updates a group as `userDAO.update` does and adds 1 to `row_version` [legacy: core/mura/user/userDAO.cfc:404-456]; null when absent. */
  updateGroup(tx: TenantTx, groupId: string, input: GroupUpdate, actor: AuditActor | null, ctx?: WriteContext): Promise<GroupAccountRow | null>;
  /** Deletes the `group_account` row only; null when absent. */
  deleteGroupRow(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<GroupAccountRow | null>;

  /** Inserts a group address as `createAddress` does, named `Primary` and primary by default [legacy: core/mura/user/userDAO.cfc:776-808]. */
  insertGroupAddress(tx: TenantTx, row: GroupAddressInput, ctx?: WriteContext): Promise<GroupAddressRow>;
  /** Updates a group address as `updateAddress` does; null when absent. */
  updateGroupAddress(tx: TenantTx, addressId: string, values: GroupAddressUpdate, ctx?: WriteContext): Promise<GroupAddressRow | null>;
  /** Makes `addressId` the group's only primary address [legacy: core/mura/user/userDAO.cfc:849-860]. */
  setPrimaryGroupAddress(tx: TenantTx, groupId: string, addressId: string, ctx?: WriteContext): Promise<void>;
  /** The group's addresses, primary first. */
  listGroupAddresses(tx: TenantTx, groupId: string): Promise<GroupAddressRow[]>;
  /** Deletes the group's addresses and their extended data; returns the number of addresses. */
  deleteGroupAddresses(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<number>;
  /** Deletes the group's interests (only `onlyCategoryIds` when given), then inserts each new non-empty id [legacy: core/mura/user/userDAO.cfc:583-616]. */
  replaceGroupInterests(
    tx: TenantTx,
    input: { groupId: string; categoryIds: readonly string[]; onlyCategoryIds?: readonly string[] },
    ctx?: WriteContext,
  ): Promise<void>;
  /** The group's interest category ids, by category id [legacy: core/mura/user/userDAO.cfc:674-682]. */
  groupInterestIds(tx: TenantTx, groupId: string): Promise<string[]>;
  /** Deletes the group's tags, then inserts each trimmed, non-empty item of the comma list `tags` [legacy: core/mura/user/userDAO.cfc:895-922]. */
  replaceGroupTags(tx: TenantTx, input: { groupId: string; siteId: string; tags: string | null }, ctx?: WriteContext): Promise<GroupTagRow[]>;
  /** Deletes every tag of the group; returns the number deleted. */
  deleteGroupTags(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<number>;
  /** Deletes every favorite of the group; returns the number deleted. */
  deleteGroupFavorites(tx: TenantTx, groupId: string, ctx?: WriteContext): Promise<number>;
  /** Per attribute, deletes the group's stored values, then inserts the new ones; returns the inserted rows. */
  replaceGroupExtendData(
    tx: TenantTx,
    input: { groupId: string; rows: readonly GroupExtendDataReplacement[] },
    ctx?: WriteContext,
  ): Promise<GroupExtendDataRow[]>;
  /** Deletes every extended value of the group `baseId`; returns the number deleted. */
  deleteGroupExtendData(tx: TenantTx, baseId: string, ctx?: WriteContext): Promise<number>;

  /** The groups of this tenant `userId` belongs to, by group userid. */
  membershipsOf(tx: TenantTx, userId: string): Promise<GroupMembership[]>;
  /** Every group id `userId` belongs to, groups stored in other tenants included, by group id. A migration apply's `ctx` reads without the window-phase wait. */
  membershipGroupIds(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<string[]>;
  /** Deletes the user's memberships (only `onlyGroupIds` when given), then inserts each new non-empty id [legacy: core/mura/user/userDAO.cfc:502-515,561-581]. */
  replaceMemberships(
    tx: TenantTx,
    input: { userId: string; groupIds: readonly string[]; onlyGroupIds?: readonly string[] },
    ctx?: WriteContext,
  ): Promise<{ removed: string[]; added: string[] }>;
  /** For a public non-S2 owner, deletes memberships outside the public groups of `siteId`; returns their group ids [legacy: core/mura/user/userDAO.cfc:873-893]. */
  clearBadMemberships(
    tx: TenantTx,
    input: { userId: string; siteId: string; s2: number | boolean | null; ispublic: number | boolean | null },
    ctx?: WriteContext,
  ): Promise<string[]>;
  /** Adds `userId` to `groupId` unless it is a member; false when nothing was inserted [legacy: core/mura/user/userDAO.cfc:545-559]. */
  addMembership(tx: TenantTx, userId: string, groupId: string, ctx?: WriteContext): Promise<boolean>;
  /** Removes `userId` from `groupId`; false when it was no member [legacy: core/mura/user/userDAO.cfc:535-543]. */
  removeMembership(tx: TenantTx, userId: string, groupId: string, ctx?: WriteContext): Promise<boolean>;
  /** Members of `groupId` in this tenant, S2 members only with `includeS2`, by last name then userid [legacy: core/mura/user/userDAO.cfc:646-660]. */
  membersOf(tx: TenantTx, groupId: string, opts?: { includeS2?: boolean }): Promise<GroupMemberRow[]>;

  /** The permissions of a node, optionally of one type [legacy: core/mura/permission.cfc:203-218,623-630]. */
  permissionsFor(tx: TenantTx, input: { contentId: string; siteId: string; type?: string }): Promise<PermissionRow[]>;
  /** Every permission row of `groupId` in `siteId`, by content id then type. A migration apply's `ctx` reads without the window-phase wait. */
  groupPermissions(tx: TenantTx, groupId: string, siteId: string, ctx?: WriteContext): Promise<PermissionRow[]>;
  /** Replaces every permission of a node with `grants`, inserted in order [legacy: core/mura/permission.cfc:518-547]. */
  replaceNodePermissions(
    tx: TenantTx,
    input: { contentId: string; siteId: string; grants: readonly PermissionGrant[] },
    ctx?: WriteContext,
  ): Promise<PermissionRow[]>;
  /** Replaces every permission of a module with `module` grants of `groupIds`, duplicates not removed [legacy: core/mura/permission.cfc:643-663]. */
  replaceModulePermissions(
    tx: TenantTx,
    input: { moduleId: string; siteId: string; groupIds: readonly string[] },
    ctx?: WriteContext,
  ): Promise<PermissionRow[]>;
  /** The `module` grants of `groupIds` in `siteId`, by module then group. */
  moduleGrants(tx: TenantTx, groupIds: readonly string[], siteId: string): Promise<ModuleGrant[]>;

  /** The strike row of `username`, matched as SQL Server does; null when absent. */
  readStrike(tx: TenantTx, username: string): Promise<UserStrikeRow | null>;
  /** The strike row of `username`, inserted with 0 strikes a minute before `at` when absent [legacy: core/mura/user/userstrikes.cfc:20-41]. */
  ensureStrike(tx: TenantTx, username: string, at: Date, ctx?: WriteContext): Promise<UserStrikeRow>;
  /** Stores strikes and last attempt for a load reset or clear [legacy: core/mura/user/userstrikes.cfc:43-61,113-118]; null when absent. */
  setStrike(tx: TenantTx, username: string, values: StrikeValues, ctx?: WriteContext): Promise<UserStrikeRow | null>;
  /** Adds one strike with `lastattempt = at` [legacy: core/mura/user/userstrikes.cfc:90-99]; null when absent. */
  addStrike(tx: TenantTx, username: string, at: Date, ctx?: WriteContext): Promise<UserStrikeRow | null>;

  /** The session `sessionId` of this tenant; null when absent. */
  findSession(tx: TenantTx, sessionId: string): Promise<SessionRow | null>;
  /** Inserts a session. */
  insertSession(tx: TenantTx, row: SessionInsert, ctx?: WriteContext): Promise<SessionRow>;
  /** Sets `patch` and `updated_at`; null when absent. */
  updateSession(tx: TenantTx, sessionId: string, patch: SessionPatch, ctx?: WriteContext): Promise<SessionRow | null>;
  /** Deletes the session of this tenant; false when absent. */
  deleteSession(tx: TenantTx, sessionId: string, ctx?: WriteContext): Promise<boolean>;
  /** The admin state the session stored, `{}` when none; null when the session is absent. */
  readSessionAdminState(tx: TenantTx, sessionId: string): Promise<SessionAdminState | null>;
  /** Locks the session and lays the top-level `values` over its stored admin state; returns the result, null when the session is absent. */
  mergeSessionAdminState(tx: TenantTx, sessionId: string, values: Readonly<SessionAdminState>, ctx?: WriteContext): Promise<SessionAdminState | null>;

  /** The remote session of `userId`; null when absent. */
  findRemoteSession(tx: TenantTx, userId: string): Promise<RemoteSessionRow | null>;
  /** The first remote session with `authToken`; null when none. */
  findRemoteSessionByToken(tx: TenantTx, authToken: string): Promise<RemoteSessionRow | null>;
  /** Inserts or replaces the remote session of `row.userid`. */
  saveRemoteSession(tx: TenantTx, row: RemoteSessionInput, ctx?: WriteContext): Promise<RemoteSessionRow>;
  /** Deletes the remote session of `userId`; false when absent. */
  deleteRemoteSession(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<boolean>;

  /** The device matching every given lookup value; null when none. */
  findDevice(tx: TenantTx, lookup: DeviceLookup): Promise<UserDeviceRow | null>;
  /** Inserts or replaces the device `row.deviceid` with the ORM NULL rule. */
  saveDevice(tx: TenantTx, row: DeviceInput, ctx?: WriteContext): Promise<UserDeviceRow>;

  /** The redirect `redirectId`; null when absent. */
  findRedirect(tx: TenantTx, redirectId: string): Promise<RedirectRow | null>;
  /** Deletes every stored redirect of `userId` [legacy: core/mura/user/userUtility.cfc:899-915]; returns the number deleted. */
  removePrevRedirects(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<number>;
  /** Inserts a redirect under a new CF UUID, created now. */
  insertRedirect(tx: TenantTx, row: RedirectInput, ctx?: WriteContext): Promise<RedirectRow>;

  /** The OAuth clients of `siteId`, by clientid. */
  listOAuthClients(tx: TenantTx, siteId: string): Promise<OAuthClientRow[]>;
  /** The OAuth client `clientId`; null when absent. */
  findOAuthClient(tx: TenantTx, clientId: string): Promise<OAuthClientRow | null>;
  /** Inserts an OAuth client with the ORM NULL rule. */
  insertOAuthClient(tx: TenantTx, row: OAuthClientInput, ctx?: WriteContext): Promise<OAuthClientRow>;
  /** Writes every column of the OAuth client with the ORM NULL rule; null when absent. */
  updateOAuthClient(tx: TenantTx, clientId: string, values: OAuthClientValues, ctx?: WriteContext): Promise<OAuthClientRow | null>;
  /** Deletes the client's tokens, then the client [legacy: core/mura/client/api/oauth/oauthClientBean.cfc:6]; false when absent. */
  deleteOAuthClient(tx: TenantTx, clientId: string, ctx?: WriteContext): Promise<boolean>;
  /** The token `token`; null when absent. */
  findToken(tx: TenantTx, token: string): Promise<OAuthTokenRow | null>;
  /** The first token with access code `code`; null when none. */
  findTokenByAccessCode(tx: TenantTx, code: string): Promise<OAuthTokenRow | null>;
  /** Inserts a token with the ORM NULL rule. */
  insertToken(tx: TenantTx, row: OAuthTokenInput, ctx?: WriteContext): Promise<OAuthTokenRow>;
  /** Deletes the token `token`; false when absent. */
  deleteToken(tx: TenantTx, token: string, ctx?: WriteContext): Promise<boolean>;
  /** Deletes the tokens of `userId`, only those in `tokens` when given [legacy: core/mura/user/userDAO.cfc:365-372,478-488]; returns the number deleted. */
  deleteTokensByUser(tx: TenantTx, userId: string, tokens?: readonly string[], ctx?: WriteContext): Promise<number>;
  /** The first unexpired token of the client, grant type and user by token; a user-less token never matches. */
  findReusableToken(tx: TenantTx, lookup: ReusableTokenLookup): Promise<OAuthTokenRow | null>;
  /** Deletes the client's tokens of the grant type that expired over a day before `now`; returns the number deleted. */
  purgeExpiredTokens(tx: TenantTx, purge: ExpiredTokenPurge, ctx?: WriteContext): Promise<number>;

  /** Inserts a claim; null when `(session_id, token)` is already claimed, leaving the transaction usable. */
  insertCsrfClaim(tx: TenantTx, claim: CsrfClaimInput, ctx?: WriteContext): Promise<CsrfClaimRow | null>;
  /** The claim of `token` in the session; null when absent. */
  findCsrfClaim(tx: TenantTx, sessionId: string, token: string): Promise<CsrfClaimRow | null>;
  /** The session's claims, by claim time then token. */
  listCsrfClaims(tx: TenantTx, sessionId: string, filter?: CsrfClaimFilter): Promise<CsrfClaimRow[]>;
  /** Moves a claim from `from` to `to` (a `used` claim gets `usedAt`, default now); false when absent or in another state. */
  setCsrfClaimState(
    tx: TenantTx,
    sessionId: string,
    token: string,
    from: CsrfClaimState,
    to: CsrfClaimState,
    opts?: { usedAt?: Date },
    ctx?: WriteContext,
  ): Promise<boolean>;
  /** Deletes a claim; false when absent. */
  deleteCsrfClaim(tx: TenantTx, sessionId: string, token: string, ctx?: WriteContext): Promise<boolean>;
  /** Deletes the claims in scope; returns the number deleted. */
  purgeCsrfClaims(tx: TenantTx, purge: CsrfClaimPurge, ctx?: WriteContext): Promise<number>;

  /** Records an account operation; a second open operation of the user or username raises the unique violation. */
  insertAccountOperation(tx: TenantTx, row: AccountOperationInput, ctx?: WriteContext): Promise<AccountOperationRow>;
  /** The operation `operationId`; null when absent. */
  findAccountOperation(tx: TenantTx, operationId: string): Promise<AccountOperationRow | null>;
  /** The oldest open operation of the user or the username; null when none. */
  findOpenAccountOperation(tx: TenantTx, lookup: OpenOperationLookup): Promise<AccountOperationRow | null>;
  /** Moves the operation to `to` when its state is one of `fromStates`, setting `patch`; false otherwise. */
  setAccountOperationState(
    tx: TenantTx,
    operationId: string,
    fromStates: readonly AccountOperationState[],
    to: AccountOperationState,
    patch?: AccountOperationPatch,
    ctx?: WriteContext,
  ): Promise<boolean>;

  /** Inserts or replaces the contact of `row.user_id`. */
  upsertPersonContact(tx: TenantTx, row: PersonContactInput, ctx?: WriteContext): Promise<PersonContactRow>;
  /** The contact of `userId`; null when absent. */
  findPersonContact(tx: TenantTx, userId: string): Promise<PersonContactRow | null>;
  /** Contacts whose email matches case-insensitively, by user id. */
  findContactsByEmail(tx: TenantTx, email: string): Promise<PersonContactRow[]>;
  /** Adds 1 to the aggregate's event sequence, starting at 1, and returns it. */
  nextAggregateVersion(tx: TenantTx, aggregateType: string, aggregateId: string, ctx?: WriteContext): Promise<number>;
}

/** Settings of `createIdentityRepository`; `schema` differs from `identity` only for throwaway test schemas. */
export interface IdentityRepositoryOptions {
  clock?: Clock;
  schema?: string;
}


async function select<R extends QueryResultRow>(tx: TenantTx, sql: string, params: readonly unknown[]): Promise<R[]> {
  return (await tx.query<R>(sql, [...params])).rows;
}

/** Runs `insert` in savepoint `savepoint`; on a unique violation rolls back to it and returns null, so the transaction stays usable. */
async function insertIfAbsent<R>(tx: TenantTx, savepoint: string, insert: () => Promise<R>): Promise<R | null> {
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    const row = await insert();
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return row;
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }
    await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return null;
  }
}

/** Builds the identity repository over the platform repository of `OWNED_TABLES`. */
export function createIdentityRepository({ clock = systemClock, schema = SCHEMA }: IdentityRepositoryOptions = {}): IdentityRepository {
  const base = createRepository({ owner: OWNER, schema, tables: OWNED_TABLES, clock });
  const name = (table: { table: string }): string => qualified(schema, table.table);
  const userAccount = name(USER_ACCOUNT);
  const credential = name(CREDENTIAL);
  const loginState = name(LOGIN_STATE);
  const groupAccount = name(GROUP_ACCOUNT);
  const membership = name(MEMBERSHIP);
  const permission = name(PERMISSION);
  const address = name(GROUP_ADDRESS);
  const interest = name(GROUP_INTEREST);
  const tag = name(GROUP_TAG);
  const favorite = name(GROUP_FAVORITE);
  const extendData = name(GROUP_EXTEND_DATA);
  const strike = name(USER_STRIKE);
  const remoteSession = name(REMOTE_SESSION);
  const device = name(USER_DEVICE);
  const redirect = name(REDIRECT);
  const oauthClient = name(OAUTH_CLIENT);
  const oauthToken = name(OAUTH_TOKEN);
  const session = name(SESSION);
  const csrfClaim = name(CSRF_CLAIM);
  const accountOperation = name(ACCOUNT_OPERATION);
  const personContact = name(PERSON_CONTACT);
  const aggregateVersion = name(AGGREGATE_VERSION);
  const legacyCi = qualified(schema, 'legacy_ci');

  // SQL Server's nvarchar equality: bpchar ignores trailing spaces and legacy_ci compares the rest. Unlike lower() and rtrim(),
  // the comparison is leakproof, so its expression index applies under forced RLS.
  const activeAccountsSql =
    `SELECT * FROM ${userAccount} WHERE tenant_id = $1 AND type = 2 AND inactive = 0 AND opt2_state = 'active'` +
    ` AND (username::bpchar COLLATE ${legacyCi}) = $2::bpchar AND ($3::text IS NULL OR siteid = $3) ORDER BY userid`;
  const accountByIdSql = `SELECT * FROM ${userAccount} WHERE "tenant_id" = $1 AND "userid" = $2`;
  const usernameHolderSql =
    `SELECT userid FROM ${userAccount} WHERE tenant_id = $1 AND type = 2` +
    ` AND (username::bpchar COLLATE ${legacyCi}) = $2::bpchar AND userid <> $3 LIMIT 1`;
  // One statement, so the open-operation flag and the column values come from the same snapshot.
  const accountRecordsSql =
    'SELECT u.userid, u.username, u.type, u.admin, u.s2, u.perm, u.inactive, u.ispublic, u.siteid, u.remoteid, u.tablist, u.opt2_state,' +
    ' c.passwordcreated, l.lastlogin,' +
    ` EXISTS (SELECT 1 FROM ${accountOperation} o WHERE o.tenant_id = u.tenant_id AND o.user_id = u.userid AND o.state = ANY($3::text[])) AS closed` +
    ` FROM ${userAccount} u LEFT JOIN ${credential} c ON c.tenant_id = u.tenant_id AND c.userid = u.userid` +
    ` LEFT JOIN ${loginState} l ON l.tenant_id = u.tenant_id AND l.userid = u.userid` +
    ' WHERE u.tenant_id = $1 AND u.type = 2 AND u.userid = ANY($2::bpchar[]) ORDER BY u.userid';
  const groupsByIdsSql = `SELECT * FROM ${groupAccount} WHERE tenant_id = $1 AND userid = ANY($2::bpchar[]) ORDER BY userid`;
  const groupByNameSql =
    `SELECT * FROM ${groupAccount} WHERE tenant_id = $1 AND type = 1 AND (groupname::bpchar COLLATE ${legacyCi}) = $2::bpchar` +
    ' AND siteid = $3 AND ($4::integer IS NULL OR ispublic = $4) ORDER BY userid LIMIT 1';
  // A NULL groupname fails `<> 'Admin'` in SQL Server too, so it is excluded with the Admin groups.
  const listGroupsSql =
    `SELECT * FROM ${groupAccount} WHERE tenant_id = $1 AND type = 1 AND ispublic = $2 AND siteid = $3` +
    " AND (NOT $4::boolean OR lower(rtrim(groupname)) <> 'admin') ORDER BY lower(groupname) ASC NULLS FIRST, userid";
  // SQL Server sorts NULL lowest: last under Perm DESC, first under GroupName ASC.
  const poolGroupsSql =
    `SELECT userid, groupname, siteid, ispublic, perm FROM ${groupAccount} WHERE tenant_id = $1 AND type = 1 AND ispublic = $2 AND siteid = $3` +
    ' ORDER BY perm DESC NULLS LAST, lower(groupname) ASC NULLS FIRST, userid';
  const lockGroupSql = `SELECT * FROM ${groupAccount} WHERE tenant_id = $1 AND userid = $2 FOR UPDATE`;
  const addressesSql = `SELECT * FROM ${address} WHERE tenant_id = $1 AND userid = $2 ORDER BY isprimary DESC NULLS LAST, addressid`;
  const lockAddressIdsSql = `SELECT addressid FROM ${address} WHERE tenant_id = $1 AND userid = $2 ORDER BY addressid FOR UPDATE`;
  const lockOtherPrimariesSql =
    `SELECT addressid FROM ${address} WHERE tenant_id = $1 AND userid = $2 AND addressid <> $3` +
    ' AND isprimary IS DISTINCT FROM 0 ORDER BY addressid FOR UPDATE';
  const lockAddressSql = `SELECT isprimary FROM ${address} WHERE tenant_id = $1 AND addressid = $2 FOR UPDATE`;
  const lockInterestsSql =
    `SELECT categoryid FROM ${interest} WHERE tenant_id = $1 AND userid = $2` +
    ' AND ($3::bpchar[] IS NULL OR categoryid = ANY($3::bpchar[])) ORDER BY categoryid FOR UPDATE';
  const interestIdsSql = `SELECT categoryid FROM ${interest} WHERE tenant_id = $1 AND userid = $2`;
  // The clustered (userID, categoryID) key orders legacy's unordered read.
  const orderedInterestIdsSql = `${interestIdsSql} ORDER BY categoryid`;
  const lockTagsSql = `SELECT tagid FROM ${tag} WHERE tenant_id = $1 AND userid = $2 ORDER BY tagid FOR UPDATE`;
  const lockFavoritesSql = `SELECT favoriteid FROM ${favorite} WHERE tenant_id = $1 AND userid = $2 ORDER BY favoriteid FOR UPDATE`;
  const lockExtendByBaseSql = `SELECT dataid FROM ${extendData} WHERE tenant_id = $1 AND baseid = $2 ORDER BY dataid FOR UPDATE`;
  const lockExtendByAttributeSql =
    `SELECT dataid FROM ${extendData} WHERE tenant_id = $1 AND baseid = $2 AND attributeid = $3 ORDER BY dataid FOR UPDATE`;
  const nextIdSql = 'SELECT nextval(pg_get_serial_sequence($1, $2)::regclass)::text AS id';
  const membershipsSql =
    `SELECT g.userid, g.groupname, g.siteid, g.ispublic FROM ${membership} m` +
    ` JOIN ${groupAccount} g ON g.tenant_id = m.tenant_id AND g.userid = m.groupid` +
    ' WHERE m.tenant_id = $1 AND m.userid = $2 ORDER BY g.userid';
  const membershipIdsSql = `SELECT groupid FROM ${membership} WHERE tenant_id = $1 AND userid = $2 ORDER BY groupid`;
  const lockMembershipsSql =
    `SELECT groupid FROM ${membership} WHERE tenant_id = $1 AND userid = $2` +
    ' AND ($3::bpchar[] IS NULL OR groupid = ANY($3::bpchar[])) ORDER BY groupid FOR UPDATE';
  const lockBadMembershipsSql =
    `SELECT m.groupid FROM ${membership} m WHERE m.tenant_id = $1 AND m.userid = $2 AND m.groupid NOT IN` +
    ` (SELECT g.userid FROM ${groupAccount} g WHERE g.tenant_id = $1 AND g.siteid = $3 AND g.type = 1 AND g.ispublic = 1)` +
    ' ORDER BY m.groupid FOR UPDATE OF m';
  // Legacy joins members of any Type and orders by their lname, which SQL Server sorts NULLs first.
  const membersSql = (includeS2: boolean): string =>
    'SELECT * FROM (' +
    'SELECT u.userid, u.type, u.username, u.siteid, u.ispublic, u.s2, u.inactive, c.fname, c.lname, c.email, c.company' +
    ` FROM ${membership} m JOIN ${userAccount} u ON u.tenant_id = m.tenant_id AND u.userid = m.userid` +
    ` LEFT JOIN ${personContact} c ON c.tenant_id = u.tenant_id AND c.user_id = u.userid` +
    ` WHERE m.tenant_id = $1 AND m.groupid = $2 AND u.opt2_state = 'active'${includeS2 ? '' : ' AND u.s2 = 0'}` +
    ' UNION ALL ' +
    'SELECT g.userid, g.type, g.username, g.siteid, g.ispublic, g.s2, g.inactive, g.fname, g.lname, g.email, g.company' +
    ` FROM ${membership} m JOIN ${groupAccount} g ON g.tenant_id = m.tenant_id AND g.userid = m.userid` +
    ` WHERE m.tenant_id = $1 AND m.groupid = $2${includeS2 ? '' : ' AND g.s2 = 0'}` +
    ') members ORDER BY lower(lname) ASC NULLS FIRST, userid';
  const permissionsSql =
    `SELECT * FROM ${permission} WHERE tenant_id = $1 AND contentid = $2 AND siteid = $3 AND ($4::text IS NULL OR type = $4)` +
    ' ORDER BY contentid, groupid, siteid, type';
  const lockPermissionsSql =
    `SELECT contentid, groupid, siteid, type FROM ${permission} WHERE tenant_id = $1 AND contentid = $2 AND siteid = $3` +
    ' ORDER BY groupid, type FOR UPDATE';
  const groupPermissionsSql =
    `SELECT * FROM ${permission} WHERE tenant_id = $1 AND groupid = $2::bpchar AND siteid = $3 ORDER BY contentid, type`;
  // A bpchar[] keeps groupid uncast, so the groupid index applies.
  const moduleGrantsSql =
    `SELECT contentid, groupid FROM ${permission} WHERE tenant_id = $1 AND type = 'module' AND siteid = $2` +
    ' AND groupid = ANY($3::bpchar[]) ORDER BY contentid, groupid';
  const strikeSql = `SELECT * FROM ${strike} WHERE tenant_id = $1 AND (username::bpchar COLLATE ${legacyCi}) = $2::bpchar ORDER BY username LIMIT 1`;
  const lockStrikeSql = `${strikeSql} FOR UPDATE`;
  const remoteSessionByTokenSql = `SELECT * FROM ${remoteSession} WHERE tenant_id = $1 AND authtoken = $2 ORDER BY userid LIMIT 1`;
  const deviceSql =
    `SELECT * FROM ${device} WHERE tenant_id = $1 AND deviceid = $2 AND userid = $3 AND ($4::text IS NULL OR siteid = $4)` +
    ' ORDER BY deviceid LIMIT 1';
  const lockRedirectsSql = `SELECT redirectid FROM ${redirect} WHERE tenant_id = $1 AND userid = $2 ORDER BY redirectid FOR UPDATE`;
  const clientsSql = `SELECT * FROM ${oauthClient} WHERE tenant_id = $1 AND siteid = $2 ORDER BY clientid`;
  const lockClientTokensSql = `SELECT token FROM ${oauthToken} WHERE tenant_id = $1 AND clientid = $2 ORDER BY token FOR UPDATE`;
  const tokenByAccessCodeSql = `SELECT * FROM ${oauthToken} WHERE tenant_id = $1 AND accesscode = $2 ORDER BY token LIMIT 1`;
  const lockUserTokensSql =
    `SELECT token FROM ${oauthToken} WHERE tenant_id = $1 AND userid = $2` +
    ' AND ($3::bpchar[] IS NULL OR token = ANY($3::bpchar[])) ORDER BY token FOR UPDATE';
  const reusableTokenSql =
    `SELECT * FROM ${oauthToken} WHERE tenant_id = $1 AND clientid = $2 AND granttype = $3 AND userid = $4 AND expires > $5` +
    ' ORDER BY token LIMIT 1';
  const lockExpiredTokensSql =
    `SELECT token FROM ${oauthToken} WHERE tenant_id = $1 AND clientid = $2 AND granttype = $3 AND expires < $4` +
    ' ORDER BY token FOR UPDATE';
  const lockSessionAdminStateSql = `SELECT admin_state FROM ${session} WHERE tenant_id = $1 AND session_id = $2 FOR UPDATE`;
  const claimsSql =
    `SELECT * FROM ${csrfClaim} WHERE tenant_id = $1 AND session_id = $2 AND ($3::text IS NULL OR state = $3)` +
    ' AND ($4::timestamp IS NULL OR coalesce(used_at, claimed_at) >= $4) ORDER BY claimed_at, token';
  const lockClaimSql = `SELECT state FROM ${csrfClaim} WHERE tenant_id = $1 AND session_id = $2 AND token = $3 FOR UPDATE`;
  const lockStaleClaimsSql =
    `SELECT session_id, token FROM ${csrfClaim} WHERE tenant_id = $1 AND ($2::text IS NULL OR session_id = $2)` +
    ' AND ($3::timestamp IS NULL OR coalesce(used_at, claimed_at) < $3) ORDER BY session_id, token FOR UPDATE';
  const openOperationSql =
    `SELECT * FROM ${accountOperation} WHERE tenant_id = $1 AND state = ANY($2::text[])` +
    ` AND (($3::text IS NOT NULL AND user_id = $3) OR ($4::text IS NOT NULL AND (username::bpchar COLLATE ${legacyCi}) = $4::bpchar))` +
    ' ORDER BY created_at, operation_id LIMIT 1';
  const lockOperationSql = `SELECT state FROM ${accountOperation} WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE`;
  const contactsByEmailSql = `SELECT * FROM ${personContact} WHERE tenant_id = $1 AND lower(email) = lower($2) ORDER BY user_id`;
  const lockAggregateSql =
    `SELECT row_version FROM ${aggregateVersion} WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3 FOR UPDATE`;

  /** Selects rows of unit tables once no window phase blocks reading `units`. */
  function readUnits<R extends QueryResultRow>(tx: TenantTx, units: string | readonly string[], sql: string, params: readonly unknown[]): Promise<R[]> {
    return base.read(tx, units, () => select<R>(tx, sql, params));
  }

  /**
   * Selects rows of unit tables as readUnits does, except inside a migration apply: its writes take no gate, so the window
   * import it performs would hold the read in the import phase until the apply itself timed out.
   */
  function readAsWriter<R extends QueryResultRow>(
    tx: TenantTx,
    units: string | readonly string[],
    sql: string,
    params: readonly unknown[],
    ctx: WriteContext | undefined,
  ): Promise<R[]> {
    return ctx?.authority === undefined ? readUnits<R>(tx, units, sql, params) : select<R>(tx, sql, params);
  }

  /** Deletes the rows of `table` whose keys `keys` lists, each through the platform write; returns how many existed. */
  async function deleteKeys(tx: TenantTx, table: string, keys: readonly RepositoryRow[], ctx: WriteContext): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if ((await base.delete(tx, table, key, ctx)) !== null) deleted += 1;
    }
    return deleted;
  }

  /** The next target id of an integer key: the negative, descending sequence 0005_child_id_sequences.sql owns by the column, so it never meets legacy or people ids. */
  async function nextId(tx: TenantTx, table: { table: string }, column: string): Promise<number> {
    const id = (await select<{ id: string | null }>(tx, nextIdSql, [name(table), column]))[0]?.id ?? null;
    if (id === null) {
      throw new RepositoryError(`column ${column} has no id sequence`, table.table);
    }
    return Number(id);
  }

  async function findAccountsByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow[]> {
    return readUnits<UserAccountRow>(tx, USER_ACCOUNT.unit, activeAccountsSql, [tx.tenantId, cfTrim(username), poolSiteId ?? null]);
  }

  async function findAccountByUsername(tx: TenantTx, username: string, poolSiteId?: string): Promise<UserAccountRow | null> {
    return (await findAccountsByUsername(tx, username, poolSiteId))[0] ?? null;
  }

  async function findAccountById(
    tx: TenantTx,
    userId: string,
    opts: { includePending?: boolean } = {},
    ctx?: WriteContext,
  ): Promise<UserAccountRow | null> {
    const row =
      ctx?.authority === undefined
        ? await base.findByKey<UserAccountRow>(tx, USER_ACCOUNT.table, { userid: userId })
        : ((await select<UserAccountRow>(tx, accountByIdSql, [tx.tenantId, userId]))[0] ?? null);
    return row !== null && (row.opt2_state === 'active' || opts.includePending === true) ? row : null;
  }

  function readAccountRecords(tx: TenantTx, userIds: readonly string[]): Promise<AccountRecordRow[]> {
    const units = [USER_ACCOUNT.unit, CREDENTIAL.unit, LOGIN_STATE.unit];
    return readUnits<AccountRecordRow>(tx, units, accountRecordsSql, [tx.tenantId, [...userIds], [...OPEN_OPERATION_STATES]]);
  }

  async function isUsernameTaken(tx: TenantTx, username: string, exceptUserId: string): Promise<boolean> {
    const holders = await readUnits(tx, USER_ACCOUNT.unit, usernameHolderSql, [tx.tenantId, cfTrim(username), cfTrim(exceptUserId)]);
    return holders.length > 0;
  }

  function insertAccount(tx: TenantTx, row: AccountInput, ctx: WriteContext = {}): Promise<UserAccountRow> {
    const stored: Omit<UserAccountRow, 'tenant_id'> = {
      userid: row.userid,
      username: daoNull(row.username),
      type: row.type,
      admin: row.admin ?? null,
      s2: row.s2,
      perm: row.perm,
      inactive: row.inactive,
      ispublic: row.ispublic,
      siteid: daoNull(row.siteid),
      remoteid: daoNull(row.remoteid),
      tablist: daoNull(row.tablist),
      opt2_state: row.opt2_state ?? 'active',
    };
    return base.insert<UserAccountRow>(tx, USER_ACCOUNT.table, stored, ctx);
  }

  function updateAccount(tx: TenantTx, userId: string, values: AccountUpdate, ctx: WriteContext = {}): Promise<UserAccountRow | null> {
    const patch: AccountUpdate = {
      remoteid: daoNull(values.remoteid),
      s2: values.s2,
      type: values.type,
      inactive: values.inactive,
      username: daoNull(values.username),
      ispublic: values.ispublic,
      // userDAO.update writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
      siteid: cfTrim(values.siteid ?? ''),
      tablist: daoNull(values.tablist),
    };
    return base.update<UserAccountRow>(tx, USER_ACCOUNT.table, { userid: userId }, patch, ctx);
  }

  function setAccountState(tx: TenantTx, userId: string, state: AccountState, ctx: WriteContext = {}): Promise<UserAccountRow | null> {
    return base.update<UserAccountRow>(tx, USER_ACCOUNT.table, { userid: userId }, { opt2_state: state }, ctx);
  }

  async function deleteAccount(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<boolean> {
    const account = await base.delete(tx, USER_ACCOUNT.table, { userid: userId }, ctx);
    await base.delete(tx, CREDENTIAL.table, { userid: userId }, ctx);
    await base.delete(tx, LOGIN_STATE.table, { userid: userId }, ctx);
    return account !== null;
  }

  function readCredential(tx: TenantTx, userId: string): Promise<CredentialRow | null> {
    return base.findByKey<CredentialRow>(tx, CREDENTIAL.table, { userid: userId });
  }

  function writeCredential(tx: TenantTx, userId: string, values: CredentialValues, ctx: WriteContext = {}): Promise<CredentialRow> {
    const row: Omit<CredentialRow, 'tenant_id'> = { userid: userId, password: daoNull(values.password), passwordcreated: values.passwordcreated };
    return base.upsert<CredentialRow>(tx, CREDENTIAL.table, row, ctx);
  }

  function touchLastLogin(tx: TenantTx, userId: string, at: Date, ctx: WriteContext = {}): Promise<LoginStateRow> {
    return base.upsert<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId, lastlogin: at }, ctx);
  }

  function insertLoginState(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<LoginStateRow> {
    return base.insert<LoginStateRow>(tx, LOGIN_STATE.table, { userid: userId, lastlogin: null }, ctx);
  }


  function findGroup(tx: TenantTx, groupId: string): Promise<GroupAccountRow | null> {
    return base.findByKey<GroupAccountRow>(tx, GROUP_ACCOUNT.table, { userid: groupId });
  }

  async function findGroupsByIds(tx: TenantTx, groupIds: readonly string[]): Promise<GroupAccountRow[]> {
    if (groupIds.length === 0) return [];
    return readUnits<GroupAccountRow>(tx, GROUP_ACCOUNT.unit, groupsByIdsSql, [tx.tenantId, [...groupIds]]);
  }

  async function findGroupByName(tx: TenantTx, groupName: string, opts: { siteId: string; isPublic?: boolean }): Promise<GroupAccountRow | null> {
    const visibility = opts.isPublic === undefined ? null : opts.isPublic ? 1 : 0;
    const found = await readUnits<GroupAccountRow>(tx, GROUP_ACCOUNT.unit, groupByNameSql, [tx.tenantId, groupName, opts.siteId, visibility]);
    return found[0] ?? null;
  }

  function listGroups(
    tx: TenantTx,
    poolSiteId: string,
    isPublic: boolean | number,
    opts: { excludeAdmin?: boolean } = {},
  ): Promise<GroupAccountRow[]> {
    const params = [tx.tenantId, flag(isPublic) ? 1 : 0, poolSiteId, opts.excludeAdmin === true];
    return readUnits<GroupAccountRow>(tx, GROUP_ACCOUNT.unit, listGroupsSql, params);
  }

  function listPoolGroups(tx: TenantTx, poolSiteId: string, isPublic: 0 | 1): Promise<PoolGroupRow[]> {
    return readUnits<PoolGroupRow>(tx, GROUP_ACCOUNT.unit, poolGroupsSql, [tx.tenantId, isPublic, poolSiteId]);
  }

  /** The person contact naming an actor that has no login snapshot, read in this transaction's tenant. */
  async function actorContact(tx: TenantTx, actor: AuditActor | null): Promise<AuditNames | null> {
    return actor === null || actor.fromSnapshot ? null : findPersonContact(tx, actor.userId);
  }

  async function insertGroup(tx: TenantTx, input: GroupInput, actor: AuditActor | null, ctx: WriteContext = {}): Promise<GroupAccountRow> {
    const userid = input.userid === undefined || input.userid === '' ? cfUuid() : input.userid;
    const audit = lastUpdateInfo(actor, { userid, fname: input.fname, lname: input.lname }, await actorContact(tx, actor));
    const now = clock.now();
    const row: Omit<GroupAccountRow, 'tenant_id' | 'row_version'> & { row_version: number } = {
      userid,
      groupname: daoNull(input.groupname),
      fname: daoNull(input.fname),
      lname: daoNull(input.lname),
      username: daoNull(input.username),
      password: daoNull(input.password),
      passwordcreated: now,
      email: daoNull(input.email),
      company: daoNull(input.company),
      jobtitle: daoNull(input.jobtitle),
      mobilephone: daoNull(input.mobilephone),
      website: daoNull(input.website),
      type: input.type,
      subtype: daoNull(input.subtype),
      ext: null,
      contactform: daoNull(input.contactform),
      admin: null,
      s2: input.s2,
      lastlogin: null,
      lastupdate: now,
      lastupdateby: daoNull(audit.lastupdateby),
      lastupdatebyid: daoNull(audit.lastupdatebyid),
      perm: input.perm,
      inactive: input.inactive,
      ispublic: input.ispublic,
      siteid: daoNull(input.siteid),
      subscribe: input.subscribe,
      notes: daoNull(input.notes),
      description: daoNull(input.description),
      interests: daoNull(input.interests),
      keepprivate: input.keepprivate,
      photofileid: daoNull(input.photofileid),
      imname: daoNull(input.imname),
      imservice: daoNull(input.imservice),
      created: now,
      remoteid: daoNull(input.remoteid),
      tags: daoNull(input.tags),
      tablist: daoNull(input.tablist),
      row_version: 1,
    };
    return base.insert<GroupAccountRow>(tx, GROUP_ACCOUNT.table, row, ctx);
  }

  async function updateGroup(
    tx: TenantTx,
    groupId: string,
    input: GroupUpdate,
    actor: AuditActor | null,
    ctx: WriteContext = {},
  ): Promise<GroupAccountRow | null> {
    // Locked first, so concurrent saves never publish the same row_version.
    const current = (await readUnits<GroupAccountRow>(tx, GROUP_ACCOUNT.unit, lockGroupSql, [tx.tenantId, groupId]))[0];
    if (current === undefined) {
      return null;
    }
    const audit = lastUpdateInfo(actor, { userid: current.userid, fname: input.fname, lname: input.lname }, await actorContact(tx, actor));
    const now = clock.now();
    const password = input.password ?? '';
    const patch: RepositoryRow = {
      remoteid: daoNull(input.remoteid),
      fname: daoNull(input.fname),
      lname: daoNull(input.lname),
      groupname: daoNull(input.groupname),
      email: daoNull(input.email),
      ...(password === '' ? {} : { password, passwordcreated: now }),
      s2: input.s2,
      type: input.type,
      subtype: daoNull(input.subtype),
      contactform: daoNull(input.contactform),
      lastupdate: now,
      lastupdateby: daoNull(audit.lastupdateby),
      lastupdatebyid: daoNull(audit.lastupdatebyid),
      inactive: input.inactive,
      username: daoNull(input.username),
      ispublic: input.ispublic,
      company: daoNull(input.company),
      jobtitle: daoNull(input.jobtitle),
      website: daoNull(input.website),
      notes: daoNull(input.notes),
      subscribe: input.subscribe,
      // userDAO.update writes '#trim(siteID)#' as a literal, so an empty site id stays ''.
      siteid: cfTrim(input.siteid ?? ''),
      mobilephone: daoNull(input.mobilephone),
      description: daoNull(input.description),
      interests: daoNull(input.interests),
      photofileid: daoNull(input.photofileid),
      keepprivate: input.keepprivate,
      imname: daoNull(input.imname),
      imservice: daoNull(input.imservice),
      tags: daoNull(input.tags),
      tablist: daoNull(input.tablist),
      row_version: String(BigInt(current.row_version) + 1n),
    };
    return base.update<GroupAccountRow>(tx, GROUP_ACCOUNT.table, { userid: current.userid }, patch, ctx);
  }

  function deleteGroupRow(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<GroupAccountRow | null> {
    return base.delete<GroupAccountRow>(tx, GROUP_ACCOUNT.table, { userid: groupId }, ctx);
  }

  /** Throws unless `groupId` is a group of this tenant; a user's child rows belong to people. */
  async function requireGroup(tx: TenantTx, groupId: string, table: string): Promise<void> {
    if ((await findGroup(tx, groupId)) === null) {
      throw new RepositoryError(`owner ${groupId} is not a group of this tenant`, table);
    }
  }

  async function insertGroupAddress(tx: TenantTx, row: GroupAddressInput, ctx: WriteContext = {}): Promise<GroupAddressRow> {
    await requireGroup(tx, row.userid, GROUP_ADDRESS.table);
    const addressName = daoNull(row.addressname);
    const stored: Omit<GroupAddressRow, 'tenant_id'> = {
      addressid: row.addressid === undefined || row.addressid === '' ? cfUuid() : row.addressid,
      userid: row.userid,
      siteid: daoNull(row.siteid),
      addressname: addressName ?? 'Primary',
      address1: daoNull(row.address1),
      address2: daoNull(row.address2),
      city: daoNull(row.city),
      state: daoNull(row.state),
      zip: daoNull(row.zip),
      country: daoNull(row.country),
      phone: daoNull(row.phone),
      fax: daoNull(row.fax),
      isprimary: row.isprimary ?? 1,
      addressnotes: daoNull(row.addressnotes),
      addressurl: daoNull(row.addressurl),
      longitude: row.longitude ?? 0,
      latitude: row.latitude ?? 0,
      addressemail: daoNull(row.addressemail),
      hours: daoNull(row.hours),
    };
    return base.insert<GroupAddressRow>(tx, GROUP_ADDRESS.table, stored, ctx);
  }

  async function updateGroupAddress(
    tx: TenantTx,
    addressId: string,
    values: GroupAddressUpdate,
    ctx: WriteContext = {},
  ): Promise<GroupAddressRow | null> {
    await requireGroup(tx, values.userid, GROUP_ADDRESS.table);
    const patch: Omit<GroupAddressRow, 'tenant_id' | 'addressid' | 'isprimary'> = {
      phone: daoNull(values.phone),
      address1: daoNull(values.address1),
      address2: daoNull(values.address2),
      city: daoNull(values.city),
      state: daoNull(values.state),
      zip: daoNull(values.zip),
      fax: daoNull(values.fax),
      addressnotes: daoNull(values.addressnotes),
      siteid: cfTrim(values.siteid ?? ''),
      userid: daoNull(values.userid),
      addressname: daoNull(values.addressname),
      country: daoNull(values.country),
      addressurl: daoNull(values.addressurl),
      longitude: values.longitude ?? 0,
      latitude: values.latitude ?? 0,
      addressemail: daoNull(values.addressemail),
      hours: daoNull(values.hours),
    };
    return base.update<GroupAddressRow>(tx, GROUP_ADDRESS.table, { addressid: addressId }, patch, ctx);
  }

  async function setPrimaryGroupAddress(tx: TenantTx, groupId: string, addressId: string, ctx: WriteContext = {}): Promise<void> {
    await requireGroup(tx, groupId, GROUP_ADDRESS.table);
    // Rows already at the target value are skipped, so no changelog row records a no-op update.
    const others = await readUnits<{ addressid: string }>(tx, GROUP_ADDRESS.unit, lockOtherPrimariesSql, [tx.tenantId, groupId, addressId]);
    for (const { addressid } of others) {
      await base.update(tx, GROUP_ADDRESS.table, { addressid }, { isprimary: 0 }, ctx);
    }
    const target = (await select<{ isprimary: number | null }>(tx, lockAddressSql, [tx.tenantId, addressId]))[0];
    if (target !== undefined && target.isprimary !== 1) {
      await base.update(tx, GROUP_ADDRESS.table, { addressid: addressId }, { isprimary: 1 }, ctx);
    }
  }

  function listGroupAddresses(tx: TenantTx, groupId: string): Promise<GroupAddressRow[]> {
    return readUnits<GroupAddressRow>(tx, GROUP_ADDRESS.unit, addressesSql, [tx.tenantId, groupId]);
  }

  /** Deletes every extended value stored under `baseId`. */
  async function deleteExtendRows(tx: TenantTx, baseId: string, ctx: WriteContext): Promise<number> {
    const stale = await readUnits<{ dataid: number }>(tx, GROUP_EXTEND_DATA.unit, lockExtendByBaseSql, [tx.tenantId, baseId]);
    return deleteKeys(tx, GROUP_EXTEND_DATA.table, stale, ctx);
  }

  async function deleteGroupAddresses(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_ADDRESS.table);
    const stale = await readUnits<{ addressid: string }>(tx, GROUP_ADDRESS.unit, lockAddressIdsSql, [tx.tenantId, groupId]);
    for (const { addressid } of stale) {
      await base.delete(tx, GROUP_ADDRESS.table, { addressid }, ctx);
      await deleteExtendRows(tx, addressid, ctx);
    }
    return stale.length;
  }

  async function replaceGroupInterests(
    tx: TenantTx,
    input: { groupId: string; categoryIds: readonly string[]; onlyCategoryIds?: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<void> {
    await requireGroup(tx, input.groupId, GROUP_INTEREST.table);
    const only = input.onlyCategoryIds === undefined ? null : [...input.onlyCategoryIds];
    const stale = await readUnits<{ categoryid: string }>(tx, GROUP_INTEREST.unit, lockInterestsSql, [tx.tenantId, input.groupId, only]);
    await deleteKeys(tx, GROUP_INTEREST.table, stale.map(({ categoryid }) => ({ userid: input.groupId, categoryid })), ctx);
    const held = new Set((await select<{ categoryid: string }>(tx, interestIdsSql, [tx.tenantId, input.groupId])).map((row) => charKey(row.categoryid)));
    for (const categoryId of input.categoryIds) {
      if (!storableId(categoryId) || held.has(charKey(categoryId))) continue;
      await base.insert(tx, GROUP_INTEREST.table, { userid: input.groupId, categoryid: categoryId }, ctx);
      held.add(charKey(categoryId));
    }
  }

  async function groupInterestIds(tx: TenantTx, groupId: string): Promise<string[]> {
    const rows = await readUnits<{ categoryid: string }>(tx, GROUP_INTEREST.unit, orderedInterestIdsSql, [tx.tenantId, groupId]);
    return rows.map((row) => row.categoryid);
  }

  /** Deletes every tag stored for `groupId`. */
  async function deleteTagRows(tx: TenantTx, groupId: string, ctx: WriteContext): Promise<number> {
    const stale = await readUnits<{ tagid: number }>(tx, GROUP_TAG.unit, lockTagsSql, [tx.tenantId, groupId]);
    return deleteKeys(tx, GROUP_TAG.table, stale, ctx);
  }

  async function replaceGroupTags(
    tx: TenantTx,
    input: { groupId: string; siteId: string; tags: string | null },
    ctx: WriteContext = {},
  ): Promise<GroupTagRow[]> {
    await requireGroup(tx, input.groupId, GROUP_TAG.table);
    await deleteTagRows(tx, input.groupId, ctx);
    const created: GroupTagRow[] = [];
    for (const item of (input.tags ?? '').split(',')) {
      const value = cfTrim(item);
      if (value === '') continue;
      const row: Omit<GroupTagRow, 'tenant_id'> = { tagid: await nextId(tx, GROUP_TAG, 'tagid'), userid: input.groupId, siteid: input.siteId, tag: value };
      created.push(await base.insert<GroupTagRow>(tx, GROUP_TAG.table, row, ctx));
    }
    return created;
  }

  async function deleteGroupTags(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_TAG.table);
    return deleteTagRows(tx, groupId, ctx);
  }

  async function deleteGroupFavorites(tx: TenantTx, groupId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, groupId, GROUP_FAVORITE.table);
    const stale = await readUnits<{ favoriteid: string }>(tx, GROUP_FAVORITE.unit, lockFavoritesSql, [tx.tenantId, groupId]);
    return deleteKeys(tx, GROUP_FAVORITE.table, stale, ctx);
  }

  async function replaceGroupExtendData(
    tx: TenantTx,
    input: { groupId: string; rows: readonly GroupExtendDataReplacement[] },
    ctx: WriteContext = {},
  ): Promise<GroupExtendDataRow[]> {
    await requireGroup(tx, input.groupId, GROUP_EXTEND_DATA.table);
    const inserted: GroupExtendDataRow[] = [];
    for (const { attributeId, values } of input.rows) {
      const params = [tx.tenantId, input.groupId, attributeId];
      const stale = await readUnits<{ dataid: number }>(tx, GROUP_EXTEND_DATA.unit, lockExtendByAttributeSql, params);
      await deleteKeys(tx, GROUP_EXTEND_DATA.table, stale, ctx);
      if (values === null) continue;
      const row: Omit<GroupExtendDataRow, 'tenant_id'> = {
        dataid: await nextId(tx, GROUP_EXTEND_DATA, 'dataid'),
        baseid: input.groupId,
        attributeid: attributeId,
        ...values,
      };
      inserted.push(await base.insert<GroupExtendDataRow>(tx, GROUP_EXTEND_DATA.table, row, ctx));
    }
    return inserted;
  }

  async function deleteGroupExtendData(tx: TenantTx, baseId: string, ctx: WriteContext = {}): Promise<number> {
    await requireGroup(tx, baseId, GROUP_EXTEND_DATA.table);
    return deleteExtendRows(tx, baseId, ctx);
  }


  async function membershipsOf(tx: TenantTx, userId: string): Promise<GroupMembership[]> {
    const rows = await readUnits<Pick<GroupAccountRow, 'userid' | 'groupname' | 'siteid' | 'ispublic'>>(
      tx,
      [MEMBERSHIP.unit, GROUP_ACCOUNT.unit],
      membershipsSql,
      [tx.tenantId, userId],
    );
    return rows.map((row) => ({ userId: row.userid, groupName: row.groupname, siteId: row.siteid, isPublic: row.ispublic }));
  }

  async function membershipGroupIds(tx: TenantTx, userId: string, ctx?: WriteContext): Promise<string[]> {
    const rows = await readAsWriter<{ groupid: string }>(tx, MEMBERSHIP.unit, membershipIdsSql, [tx.tenantId, userId], ctx);
    return rows.map((row) => row.groupid);
  }

  /** Inserts each storable id of `groupIds` the user does not already hold; returns the inserted ids. */
  async function insertMemberships(tx: TenantTx, userId: string, groupIds: readonly string[], ctx: WriteContext): Promise<string[]> {
    const held = new Set((await membershipGroupIds(tx, userId)).map(charKey));
    const added: string[] = [];
    for (const groupId of groupIds) {
      if (!storableId(groupId) || held.has(charKey(groupId))) continue;
      await base.insert(tx, MEMBERSHIP.table, { userid: userId, groupid: groupId }, ctx);
      held.add(charKey(groupId));
      added.push(groupId);
    }
    return added;
  }

  async function replaceMemberships(
    tx: TenantTx,
    input: { userId: string; groupIds: readonly string[]; onlyGroupIds?: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<{ removed: string[]; added: string[] }> {
    const only = input.onlyGroupIds === undefined ? null : [...input.onlyGroupIds];
    const stale = await readUnits<{ groupid: string }>(tx, MEMBERSHIP.unit, lockMembershipsSql, [tx.tenantId, input.userId, only]);
    await deleteKeys(tx, MEMBERSHIP.table, stale.map(({ groupid }) => ({ userid: input.userId, groupid })), ctx);
    const added = await insertMemberships(tx, input.userId, input.groupIds, ctx);
    return { removed: stale.map((row) => row.groupid), added };
  }

  async function clearBadMemberships(
    tx: TenantTx,
    input: { userId: string; siteId: string; s2: number | boolean | null; ispublic: number | boolean | null },
    ctx: WriteContext = {},
  ): Promise<string[]> {
    if (flag(input.s2) || !flag(input.ispublic)) {
      return [];
    }
    const bad = await readUnits<{ groupid: string }>(tx, [MEMBERSHIP.unit, GROUP_ACCOUNT.unit], lockBadMembershipsSql, [
      tx.tenantId,
      input.userId,
      input.siteId,
    ]);
    await deleteKeys(tx, MEMBERSHIP.table, bad.map(({ groupid }) => ({ userid: input.userId, groupid })), ctx);
    return bad.map((row) => row.groupid);
  }

  async function addMembership(tx: TenantTx, userId: string, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await insertMemberships(tx, userId, [groupId], ctx)).length > 0;
  }

  async function removeMembership(tx: TenantTx, userId: string, groupId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, MEMBERSHIP.table, { userid: userId, groupid: groupId }, ctx)) !== null;
  }

  function membersOf(tx: TenantTx, groupId: string, opts: { includeS2?: boolean } = {}): Promise<GroupMemberRow[]> {
    const units = [MEMBERSHIP.unit, USER_ACCOUNT.unit, GROUP_ACCOUNT.unit];
    return readUnits<GroupMemberRow>(tx, units, membersSql(opts.includeS2 === true), [tx.tenantId, groupId]);
  }

  function permissionsFor(tx: TenantTx, input: { contentId: string; siteId: string; type?: string }): Promise<PermissionRow[]> {
    return readUnits<PermissionRow>(tx, PERMISSION.unit, permissionsSql, [tx.tenantId, input.contentId, input.siteId, input.type ?? null]);
  }

  function groupPermissions(tx: TenantTx, groupId: string, siteId: string, ctx?: WriteContext): Promise<PermissionRow[]> {
    return readAsWriter<PermissionRow>(tx, PERMISSION.unit, groupPermissionsSql, [tx.tenantId, groupId, siteId], ctx);
  }

  /** Locks and deletes every permission of the node or module `contentId` in `siteId`. */
  async function deletePermissions(tx: TenantTx, contentId: string, siteId: string, ctx: WriteContext): Promise<void> {
    const stale = await readUnits<Pick<PermissionRow, 'contentid' | 'groupid' | 'siteid' | 'type'>>(tx, PERMISSION.unit, lockPermissionsSql, [
      tx.tenantId,
      contentId,
      siteId,
    ]);
    await deleteKeys(tx, PERMISSION.table, stale, ctx);
  }

  async function replaceNodePermissions(
    tx: TenantTx,
    input: { contentId: string; siteId: string; grants: readonly PermissionGrant[] },
    ctx: WriteContext = {},
  ): Promise<PermissionRow[]> {
    await deletePermissions(tx, input.contentId, input.siteId, ctx);
    const inserted: PermissionRow[] = [];
    for (const grant of input.grants) {
      const row = { contentid: input.contentId, groupid: grant.groupId, siteid: input.siteId, type: grant.type };
      inserted.push(await base.insert<PermissionRow>(tx, PERMISSION.table, row, ctx));
    }
    return inserted;
  }

  async function replaceModulePermissions(
    tx: TenantTx,
    input: { moduleId: string; siteId: string; groupIds: readonly string[] },
    ctx: WriteContext = {},
  ): Promise<PermissionRow[]> {
    await deletePermissions(tx, input.moduleId, input.siteId, ctx);
    const inserted: PermissionRow[] = [];
    // A CFML list loop skips empty items; repeated ids are inserted again and fail on the key, as legacy's insert does.
    for (const groupId of input.groupIds.filter((id) => id !== '')) {
      const row = { contentid: input.moduleId, groupid: groupId, siteid: input.siteId, type: 'module' };
      inserted.push(await base.insert<PermissionRow>(tx, PERMISSION.table, row, ctx));
    }
    return inserted;
  }

  async function moduleGrants(tx: TenantTx, groupIds: readonly string[], siteId: string): Promise<ModuleGrant[]> {
    if (groupIds.length === 0) return [];
    const rows = await readUnits<Pick<PermissionRow, 'contentid' | 'groupid'>>(tx, PERMISSION.unit, moduleGrantsSql, [tx.tenantId, siteId, [...groupIds]]);
    return rows.map((row) => ({ contentId: row.contentid, groupId: row.groupid }));
  }

  async function readStrike(tx: TenantTx, username: string): Promise<UserStrikeRow | null> {
    return (await readUnits<UserStrikeRow>(tx, USER_STRIKE.unit, strikeSql, [tx.tenantId, username]))[0] ?? null;
  }

  async function ensureStrike(tx: TenantTx, username: string, at: Date, ctx: WriteContext = {}): Promise<UserStrikeRow> {
    const stored = await readStrike(tx, username);
    if (stored !== null) {
      return stored;
    }
    const row = { username, strikes: 0, lastattempt: new Date(at.getTime() - ONE_MINUTE_MS) };
    return base.insert<UserStrikeRow>(tx, USER_STRIKE.table, row, ctx);
  }

  /** The strike row of `username` locked for update; null when absent. */
  async function lockStrike(tx: TenantTx, username: string): Promise<UserStrikeRow | null> {
    return (await readUnits<UserStrikeRow>(tx, USER_STRIKE.unit, lockStrikeSql, [tx.tenantId, username]))[0] ?? null;
  }

  async function setStrike(tx: TenantTx, username: string, values: StrikeValues, ctx: WriteContext = {}): Promise<UserStrikeRow | null> {
    const stored = await lockStrike(tx, username);
    if (stored === null) {
      return null;
    }
    const patch = { strikes: values.strikes, lastattempt: values.lastattempt };
    return base.update<UserStrikeRow>(tx, USER_STRIKE.table, { username: stored.username }, patch, ctx);
  }

  async function addStrike(tx: TenantTx, username: string, at: Date, ctx: WriteContext = {}): Promise<UserStrikeRow | null> {
    const stored = await lockStrike(tx, username);
    if (stored === null) {
      return null;
    }
    // SQL `strikes + 1` leaves a NULL count NULL.
    const patch = { strikes: stored.strikes === null ? null : stored.strikes + 1, lastattempt: at };
    return base.update<UserStrikeRow>(tx, USER_STRIKE.table, { username: stored.username }, patch, ctx);
  }

  function findSession(tx: TenantTx, sessionId: string): Promise<SessionRow | null> {
    return base.findByKey<SessionRow>(tx, SESSION.table, { session_id: sessionId });
  }

  function insertSession(tx: TenantTx, row: SessionInsert, ctx: WriteContext = {}): Promise<SessionRow> {
    const now = clock.now();
    const stored: RepositoryRow = {
      user_id: null,
      site_id: null,
      login_snapshot: null,
      jar_ref: null,
      ended_at: null,
      admin_state: null,
      epoch: 0,
      ...row,
      created_at: now,
      updated_at: now,
    };
    return base.insert<SessionRow>(tx, SESSION.table, stored, ctx);
  }

  function updateSession(tx: TenantTx, sessionId: string, patch: SessionPatch, ctx: WriteContext = {}): Promise<SessionRow | null> {
    return base.update<SessionRow>(tx, SESSION.table, { session_id: sessionId }, { ...patch, updated_at: clock.now() }, ctx);
  }

  async function deleteSession(tx: TenantTx, sessionId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, SESSION.table, { session_id: sessionId }, ctx)) !== null;
  }

  async function readSessionAdminState(tx: TenantTx, sessionId: string): Promise<SessionAdminState | null> {
    const row = await findSession(tx, sessionId);
    return row === null ? null : storedAdminState(row.admin_state);
  }

  async function mergeSessionAdminState(
    tx: TenantTx,
    sessionId: string,
    values: Readonly<SessionAdminState>,
    ctx: WriteContext = {},
  ): Promise<SessionAdminState | null> {
    const current = (await select<Pick<SessionRow, 'admin_state'>>(tx, lockSessionAdminStateSql, [tx.tenantId, sessionId]))[0];
    if (current === undefined) {
      return null;
    }
    const merged = { ...storedAdminState(current.admin_state), ...values };
    await updateSession(tx, sessionId, { admin_state: JSON.stringify(merged) }, ctx);
    return merged;
  }

  function findRemoteSession(tx: TenantTx, userId: string): Promise<RemoteSessionRow | null> {
    return base.findByKey<RemoteSessionRow>(tx, REMOTE_SESSION.table, { userid: userId });
  }

  async function findRemoteSessionByToken(tx: TenantTx, authToken: string): Promise<RemoteSessionRow | null> {
    return (await readUnits<RemoteSessionRow>(tx, REMOTE_SESSION.unit, remoteSessionByTokenSql, [tx.tenantId, authToken]))[0] ?? null;
  }

  function saveRemoteSession(tx: TenantTx, row: RemoteSessionInput, ctx: WriteContext = {}): Promise<RemoteSessionRow> {
    return base.upsert<RemoteSessionRow>(tx, REMOTE_SESSION.table, row, ctx);
  }

  async function deleteRemoteSession(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, REMOTE_SESSION.table, { userid: userId }, ctx)) !== null;
  }

  async function findDevice(tx: TenantTx, lookup: DeviceLookup): Promise<UserDeviceRow | null> {
    const params = [tx.tenantId, lookup.deviceId, lookup.userId, lookup.siteId ?? null];
    return (await readUnits<UserDeviceRow>(tx, USER_DEVICE.unit, deviceSql, params))[0] ?? null;
  }

  function saveDevice(tx: TenantTx, row: DeviceInput, ctx: WriteContext = {}): Promise<UserDeviceRow> {
    return base.upsert<UserDeviceRow>(tx, USER_DEVICE.table, ormRow(row, USER_DEVICE), ctx);
  }

  function findRedirect(tx: TenantTx, redirectId: string): Promise<RedirectRow | null> {
    return base.findByKey<RedirectRow>(tx, REDIRECT.table, { redirectid: redirectId });
  }

  async function removePrevRedirects(tx: TenantTx, userId: string, ctx: WriteContext = {}): Promise<number> {
    const stale = await readUnits<{ redirectid: string }>(tx, REDIRECT.unit, lockRedirectsSql, [tx.tenantId, userId]);
    return deleteKeys(tx, REDIRECT.table, stale, ctx);
  }

  function insertRedirect(tx: TenantTx, row: RedirectInput, ctx: WriteContext = {}): Promise<RedirectRow> {
    const stored: Omit<RedirectRow, 'tenant_id'> = { redirectid: cfUuid(), url: row.url, created: clock.now(), userid: row.userid, siteid: row.siteid };
    return base.insert<RedirectRow>(tx, REDIRECT.table, ormRow(stored, REDIRECT), ctx);
  }


  function listOAuthClients(tx: TenantTx, siteId: string): Promise<OAuthClientRow[]> {
    return readUnits<OAuthClientRow>(tx, OAUTH_CLIENT.unit, clientsSql, [tx.tenantId, siteId]);
  }

  function findOAuthClient(tx: TenantTx, clientId: string): Promise<OAuthClientRow | null> {
    return base.findByKey<OAuthClientRow>(tx, OAUTH_CLIENT.table, { clientid: clientId });
  }

  function insertOAuthClient(tx: TenantTx, row: OAuthClientInput, ctx: WriteContext = {}): Promise<OAuthClientRow> {
    const stored = { ...row, clientid: row.clientid === undefined || row.clientid === '' ? cfUuid() : row.clientid };
    return base.insert<OAuthClientRow>(tx, OAUTH_CLIENT.table, ormRow(stored, OAUTH_CLIENT), ctx);
  }

  function updateOAuthClient(tx: TenantTx, clientId: string, values: OAuthClientValues, ctx: WriteContext = {}): Promise<OAuthClientRow | null> {
    return base.update<OAuthClientRow>(tx, OAUTH_CLIENT.table, { clientid: clientId }, ormRow(values, OAUTH_CLIENT), ctx);
  }

  async function deleteOAuthClient(tx: TenantTx, clientId: string, ctx: WriteContext = {}): Promise<boolean> {
    const tokens = await readUnits<{ token: string }>(tx, OAUTH_TOKEN.unit, lockClientTokensSql, [tx.tenantId, clientId]);
    await deleteKeys(tx, OAUTH_TOKEN.table, tokens, ctx);
    return (await base.delete(tx, OAUTH_CLIENT.table, { clientid: clientId }, ctx)) !== null;
  }

  function findToken(tx: TenantTx, token: string): Promise<OAuthTokenRow | null> {
    return base.findByKey<OAuthTokenRow>(tx, OAUTH_TOKEN.table, { token });
  }

  async function findTokenByAccessCode(tx: TenantTx, code: string): Promise<OAuthTokenRow | null> {
    return (await readUnits<OAuthTokenRow>(tx, OAUTH_TOKEN.unit, tokenByAccessCodeSql, [tx.tenantId, code]))[0] ?? null;
  }

  function insertToken(tx: TenantTx, row: OAuthTokenInput, ctx: WriteContext = {}): Promise<OAuthTokenRow> {
    return base.insert<OAuthTokenRow>(tx, OAUTH_TOKEN.table, ormRow(row, OAUTH_TOKEN), ctx);
  }

  async function deleteToken(tx: TenantTx, token: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, OAUTH_TOKEN.table, { token }, ctx)) !== null;
  }

  async function deleteTokensByUser(tx: TenantTx, userId: string, tokens?: readonly string[], ctx: WriteContext = {}): Promise<number> {
    const only = tokens === undefined ? null : [...tokens];
    const stale = await readUnits<{ token: string }>(tx, OAUTH_TOKEN.unit, lockUserTokensSql, [tx.tenantId, userId, only]);
    return deleteKeys(tx, OAUTH_TOKEN.table, stale, ctx);
  }

  async function findReusableToken(tx: TenantTx, lookup: ReusableTokenLookup): Promise<OAuthTokenRow | null> {
    // Plain equality, as the legacy feed compares: an empty userId never matches the NULL a user-less token stores.
    const params = [tx.tenantId, lookup.clientId, lookup.grantType, lookup.userId, lookup.now];
    return (await readUnits<OAuthTokenRow>(tx, OAUTH_TOKEN.unit, reusableTokenSql, params))[0] ?? null;
  }

  async function purgeExpiredTokens(tx: TenantTx, purge: ExpiredTokenPurge, ctx: WriteContext = {}): Promise<number> {
    const params = [tx.tenantId, purge.clientId, purge.grantType, dayBefore(purge.now)];
    const stale = await readUnits<{ token: string }>(tx, OAUTH_TOKEN.unit, lockExpiredTokensSql, params);
    return deleteKeys(tx, OAUTH_TOKEN.table, stale, ctx);
  }

  function insertCsrfClaim(tx: TenantTx, claim: CsrfClaimInput, ctx: WriteContext = {}): Promise<CsrfClaimRow | null> {
    const now = clock.now();
    const row: Omit<CsrfClaimRow, 'tenant_id'> = {
      session_id: claim.sessionId,
      token: claim.token,
      state: claim.state,
      request_id: claim.requestId ?? null,
      claimed_at: claim.claimedAt ?? now,
      used_at: claim.state === 'used' ? (claim.usedAt ?? now) : null,
    };
    // The primary key decides the single winner: a concurrent claim waits for it, then fails here and returns null.
    return insertIfAbsent(tx, 'opt2_csrf_claim', () => base.insert<CsrfClaimRow>(tx, CSRF_CLAIM.table, row, ctx));
  }

  function findCsrfClaim(tx: TenantTx, sessionId: string, token: string): Promise<CsrfClaimRow | null> {
    return base.findByKey<CsrfClaimRow>(tx, CSRF_CLAIM.table, { session_id: sessionId, token });
  }

  function listCsrfClaims(tx: TenantTx, sessionId: string, filter: CsrfClaimFilter = {}): Promise<CsrfClaimRow[]> {
    return select<CsrfClaimRow>(tx, claimsSql, [tx.tenantId, sessionId, filter.state ?? null, filter.since ?? null]);
  }

  async function setCsrfClaimState(
    tx: TenantTx,
    sessionId: string,
    token: string,
    from: CsrfClaimState,
    to: CsrfClaimState,
    opts: { usedAt?: Date } = {},
    ctx: WriteContext = {},
  ): Promise<boolean> {
    const current = (await select<{ state: CsrfClaimState }>(tx, lockClaimSql, [tx.tenantId, sessionId, token]))[0];
    if (current?.state !== from) {
      return false;
    }
    const patch = { state: to, used_at: to === 'used' ? (opts.usedAt ?? clock.now()) : null };
    await base.update(tx, CSRF_CLAIM.table, { session_id: sessionId, token }, patch, ctx);
    return true;
  }

  async function deleteCsrfClaim(tx: TenantTx, sessionId: string, token: string, ctx: WriteContext = {}): Promise<boolean> {
    return (await base.delete(tx, CSRF_CLAIM.table, { session_id: sessionId, token }, ctx)) !== null;
  }

  async function purgeCsrfClaims(tx: TenantTx, purge: CsrfClaimPurge, ctx: WriteContext = {}): Promise<number> {
    const stale = await select<{ session_id: string; token: string }>(tx, lockStaleClaimsSql, [
      tx.tenantId,
      purge.sessionId ?? null,
      purge.olderThan ?? null,
    ]);
    return deleteKeys(tx, CSRF_CLAIM.table, stale, ctx);
  }

  function insertAccountOperation(tx: TenantTx, row: AccountOperationInput, ctx: WriteContext = {}): Promise<AccountOperationRow> {
    const now = clock.now();
    const stored: Omit<AccountOperationRow, 'tenant_id'> = {
      operation_id: row.operation_id ?? cfUuid(),
      user_id: row.user_id,
      kind: row.kind,
      state: row.state,
      username: row.username ?? null,
      pending_change: row.pending_change ?? null,
      before_values: row.before_values ?? null,
      commit_xid: row.commit_xid ?? null,
      created_at: now,
      updated_at: now,
    };
    return base.insert<AccountOperationRow>(tx, ACCOUNT_OPERATION.table, stored, ctx);
  }

  function findAccountOperation(tx: TenantTx, operationId: string): Promise<AccountOperationRow | null> {
    return base.findByKey<AccountOperationRow>(tx, ACCOUNT_OPERATION.table, { operation_id: operationId });
  }

  async function findOpenAccountOperation(tx: TenantTx, lookup: OpenOperationLookup): Promise<AccountOperationRow | null> {
    const params = [tx.tenantId, [...OPEN_OPERATION_STATES], lookup.userId ?? null, lookup.username ?? null];
    return (await select<AccountOperationRow>(tx, openOperationSql, params))[0] ?? null;
  }

  async function setAccountOperationState(
    tx: TenantTx,
    operationId: string,
    fromStates: readonly AccountOperationState[],
    to: AccountOperationState,
    patch: AccountOperationPatch = {},
    ctx: WriteContext = {},
  ): Promise<boolean> {
    const current = (await select<{ state: AccountOperationState }>(tx, lockOperationSql, [tx.tenantId, operationId]))[0];
    if (current === undefined || !fromStates.includes(current.state)) {
      return false;
    }
    await base.update(tx, ACCOUNT_OPERATION.table, { operation_id: operationId }, { ...patch, state: to, updated_at: clock.now() }, ctx);
    return true;
  }

  function upsertPersonContact(tx: TenantTx, row: PersonContactInput, ctx: WriteContext = {}): Promise<PersonContactRow> {
    return base.upsert<PersonContactRow>(tx, PERSON_CONTACT.table, { ...row, updated_at: row.updated_at ?? clock.now() }, ctx);
  }

  function findPersonContact(tx: TenantTx, userId: string): Promise<PersonContactRow | null> {
    return base.findByKey<PersonContactRow>(tx, PERSON_CONTACT.table, { user_id: userId });
  }

  function findContactsByEmail(tx: TenantTx, email: string): Promise<PersonContactRow[]> {
    return select<PersonContactRow>(tx, contactsByEmailSql, [tx.tenantId, email]);
  }

  async function nextAggregateVersion(tx: TenantTx, aggregateType: string, aggregateId: string, ctx: WriteContext = {}): Promise<number> {
    const key = { aggregate_type: aggregateType, aggregate_id: aggregateId };
    const bump = async (): Promise<number | null> => {
      const current = (await select<{ row_version: string }>(tx, lockAggregateSql, [tx.tenantId, aggregateType, aggregateId]))[0];
      if (current === undefined) {
        return null;
      }
      const next = BigInt(current.row_version) + 1n;
      await base.update(tx, AGGREGATE_VERSION.table, key, { row_version: next.toString() }, ctx);
      return Number(next);
    };
    const bumped = await bump();
    if (bumped !== null) {
      return bumped;
    }
    const inserted = await insertIfAbsent(tx, 'opt2_aggregate_version', () =>
      base.insert(tx, AGGREGATE_VERSION.table, { ...key, row_version: 1 }, ctx),
    );
    if (inserted !== null) {
      return 1;
    }
    // A concurrent transaction inserted the first version; its row is now committed and is bumped instead.
    const retried = await bump();
    if (retried === null) {
      throw new RepositoryError(`aggregate ${aggregateType}/${aggregateId} vanished after a concurrent insert`, AGGREGATE_VERSION.table);
    }
    return retried;
  }

  return Object.freeze({
    ...base,
    base,
    findAccountsByUsername,
    findAccountByUsername,
    findAccountById,
    readAccountRecords,
    isUsernameTaken,
    insertAccount,
    updateAccount,
    setAccountState,
    deleteAccount,
    readCredential,
    writeCredential,
    touchLastLogin,
    insertLoginState,
    findGroup,
    findGroupsByIds,
    findGroupByName,
    listGroups,
    listPoolGroups,
    insertGroup,
    updateGroup,
    deleteGroupRow,
    insertGroupAddress,
    updateGroupAddress,
    setPrimaryGroupAddress,
    listGroupAddresses,
    deleteGroupAddresses,
    replaceGroupInterests,
    groupInterestIds,
    replaceGroupTags,
    deleteGroupTags,
    deleteGroupFavorites,
    replaceGroupExtendData,
    deleteGroupExtendData,
    membershipsOf,
    membershipGroupIds,
    replaceMemberships,
    clearBadMemberships,
    addMembership,
    removeMembership,
    membersOf,
    permissionsFor,
    groupPermissions,
    replaceNodePermissions,
    replaceModulePermissions,
    moduleGrants,
    readStrike,
    ensureStrike,
    setStrike,
    addStrike,
    findSession,
    insertSession,
    updateSession,
    deleteSession,
    readSessionAdminState,
    mergeSessionAdminState,
    findRemoteSession,
    findRemoteSessionByToken,
    saveRemoteSession,
    deleteRemoteSession,
    findDevice,
    saveDevice,
    findRedirect,
    removePrevRedirects,
    insertRedirect,
    listOAuthClients,
    findOAuthClient,
    insertOAuthClient,
    updateOAuthClient,
    deleteOAuthClient,
    findToken,
    findTokenByAccessCode,
    insertToken,
    deleteToken,
    deleteTokensByUser,
    findReusableToken,
    purgeExpiredTokens,
    insertCsrfClaim,
    findCsrfClaim,
    listCsrfClaims,
    setCsrfClaimState,
    deleteCsrfClaim,
    purgeCsrfClaims,
    insertAccountOperation,
    findAccountOperation,
    findOpenAccountOperation,
    setAccountOperationState,
    upsertPersonContact,
    findPersonContact,
    findContactsByEmail,
    nextAggregateVersion,
  });
}

