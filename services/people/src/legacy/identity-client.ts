// People's only route to identity data: the roster write protocol's account operations and the identity reads people shows.
import { recordWritePositionsFrom, WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import {
  currentRequestContext,
  IDENTITY_SERVICE,
  recordWritePosition,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/identity.js';

type Schemas = components['schemas'];

/** Body of `prepareAccountOperation`: create or update, the pool site, the account columns and the memberships after the change. */
export type AccountPrepareRequest = Schemas['AccountPrepareRequest'];
/** Identity's record of one roster operation. */
export type AccountOperation = Schemas['AccountOperation'];
/** State of a roster operation at identity. */
export type AccountOperationState = Schemas['AccountOperationState'];
/** Identity's commit reply; `writePosition` is the xid8 of identity's commit transaction. */
export type CommitOutcome = Schemas['AccountCommitResult'];
/** Field name to legacy validation message, in identity's key order. */
export type LegacyErrors = Schemas['LegacyErrors'];
/** The site's system and member groups and the user's memberships, for the Group Memberships tab of `cusers.editUser`. */
export type UserMemberships = Schemas['UserMemberships'];

/** Prepare's answer: the prepared operation, or identity's legacy validation errors unchanged. */
export type PrepareOutcome = ({ ok: true } & AccountOperation) | { ok: false; errors: LegacyErrors };

/** The account, credential and login-state columns legacy `userDAO.read` selects with the person columns. */
export interface AccountView {
  userId: string;
  siteId: string;
  username: Schemas['NullableString'];
  s2: Schemas['NullableInteger'];
  isPublic: Schemas['NullableInteger'];
  inactive: Schemas['NullableInteger'];
  type: Schemas['NullableInteger'];
  perm: Schemas['NullableInteger'];
  admin: Schemas['NullableInteger'];
  remoteId: Schemas['NullableString'];
  lastLogin: Schemas['NullableTimestamp'];
  passwordCreated: Schemas['NullableTimestamp'];
  tablist: Schemas['NullableString'];
}

/** One group of a site's private or public user pool, as `getPrivateGroups`/`getPublicGroups` list it. */
export interface GroupSummary {
  groupId: string;
  groupName: Schemas['NullableString'];
  siteId: string;
  isPublic: Schemas['NullableInteger'];
  perm: Schemas['NullableInteger'];
}

/** One row of the `cusers.list` group list (`getUserGroups`). */
export interface UserGroupRow {
  userId: string;
  email: Schemas['NullableString'];
  groupName: Schemas['NullableString'];
  type: Schemas['NullableInteger'];
  lastLogin: Schemas['NullableTimestamp'];
  lastUpdate: Schemas['NullableTimestamp'];
  lastUpdateBy: Schemas['NullableString'];
  lastUpdateById: Schemas['NullableString'];
  counter: Schemas['NullableInteger'];
  perm: Schemas['NullableInteger'];
  isPublic: Schemas['NullableInteger'];
}

/** The logged-in session user legacy stamps into `LastUpdateBy`/`LastUpdateByID` and `ttrash.deletedBy`. */
export interface ActingUser {
  userId: string;
  fname: string;
  lname: string;
}

/** People's calls into identity. */
export interface IdentityClient {
  /** `prepareAccountOperation`: validates and records the account part and closes the user. */
  prepare(userId: string, operationId: string, change: AccountPrepareRequest): Promise<PrepareOutcome>;
  /** `commitAccountOperation`: applies the prepared change and records identity's write position. */
  commit(userId: string, operationId: string): Promise<CommitOutcome>;
  /** `abortAccountOperation`: discards a prepared change; an operation identity never prepared resolves too. */
  abort(userId: string, operationId: string): Promise<void>;
  /** `finishAccountOperation`: completes a committed operation and reopens the user. */
  finish(userId: string, operationId: string): Promise<void>;
  /** `revertAccountOperation`: restores the values recorded at prepare; an operation identity never prepared resolves too. */
  revert(userId: string, operationId: string): Promise<void>;
  /** `getAccountOperation`: the operation's state; undefined when identity never prepared it. */
  operationState(userId: string, operationId: string): Promise<AccountOperationState | undefined>;
  /** `getAccount`: the user's account columns; undefined for a missing user, a group or a `pending` account. */
  readAccount(userId: string): Promise<AccountView | undefined>;
  /** `lookupAccounts`: the account columns of many users in one call, keyed by user id; an empty list makes no call. */
  readAccounts(userIds: readonly string[]): Promise<Map<string, AccountView>>;
  /** `listUserMemberships`: the site's groups and the user's memberships; `siteId` defaults to the token's site. */
  userMemberships(userId: string, siteId?: string): Promise<UserMemberships>;
  /** Ids of the groups the user belongs to, in identity's `readMembershipIDs` order. */
  membershipGroupIds(userId: string): Promise<string[]>;
  /** `listSiteGroups`: the groups of the site's private (`isPublic` 0) or public (1) user pool, in identity's order. */
  siteGroups(siteId: string, isPublic: number): Promise<GroupSummary[]>;
  /** `listGroups`: the `cusers.list` group rows, by `Perm` descending, then group name. */
  userGroups(siteId: string, isPublic: number): Promise<UserGroupRow[]>;
  /** `getCurrentSession`: the forwarded token's login-time session user when it is `sessionId` and logged in. */
  actingUser(sessionId: string): Promise<ActingUser | undefined>;
}

/** Contract operation id, method and path template of one identity call. */
interface IdentityOperation {
  readonly operationId: keyof operations;
  readonly method: 'GET' | 'POST';
  readonly path: keyof paths;
}

const OPERATIONS_PATH = '/internal/v1/accounts/{userId}/operations/{operationId}';

const OPS = {
  operationState: { operationId: 'getAccountOperation', method: 'GET', path: OPERATIONS_PATH },
  prepare: { operationId: 'prepareAccountOperation', method: 'POST', path: `${OPERATIONS_PATH}:prepare` },
  commit: { operationId: 'commitAccountOperation', method: 'POST', path: `${OPERATIONS_PATH}:commit` },
  abort: { operationId: 'abortAccountOperation', method: 'POST', path: `${OPERATIONS_PATH}:abort` },
  finish: { operationId: 'finishAccountOperation', method: 'POST', path: `${OPERATIONS_PATH}:finish` },
  revert: { operationId: 'revertAccountOperation', method: 'POST', path: `${OPERATIONS_PATH}:revert` },
  readAccount: { operationId: 'getAccount', method: 'GET', path: '/internal/v1/accounts/{userId}' },
  readAccounts: { operationId: 'lookupAccounts', method: 'POST', path: '/internal/v1/accounts:lookup' },
  userMemberships: { operationId: 'listUserMemberships', method: 'GET', path: '/v1/users/{userId}/memberships' },
  siteGroups: { operationId: 'listSiteGroups', method: 'GET', path: '/internal/v1/groups' },
  userGroups: { operationId: 'listGroups', method: 'GET', path: '/v1/groups' },
  currentSession: { operationId: 'getCurrentSession', method: 'GET', path: '/v1/sessions/current' },
} as const satisfies Record<string, IdentityOperation>;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** The legacy-shaped 503 for an identity answer outside the operation's handled statuses. */
function unavailable(op: IdentityOperation, status: number): ServiceUnavailableError {
  const cause = Object.assign(new Error(`${IDENTITY_SERVICE} ${op.operationId} answered HTTP ${status}`), {
    code: `${op.operationId} HTTP_${status}`,
  });
  return new ServiceUnavailableError(IDENTITY_SERVICE, cause);
}

/** The body of a 200 answer; any other status is the legacy 503. */
function okBody<T>(op: IdentityOperation, response: ServiceResponse<T>): T {
  if (response.status !== HTTP_OK) throw unavailable(op, response.status);
  return response.body;
}

/** `path` with its `{userId}` and `{operationId}` segments filled; the `:verb` suffix stays literal. */
function fillPath(path: string, userId: string, operationId = ''): string {
  return path.replace('{userId}', encodeURIComponent(userId)).replace('{operationId}', encodeURIComponent(operationId));
}

// prepare's 400 is either the validation struct (all string values) or the error envelope of a malformed body.
function isLegacyErrors(body: unknown): body is LegacyErrors {
  return typeof body === 'object' && body !== null && Object.values(body).every((value) => typeof value === 'string');
}

/** Whether a step's 409 reports an operation identity never prepared, so there is nothing to undo. */
function neverPrepared(response: ServiceResponse<AccountOperation | undefined>): boolean {
  return response.status === HTTP_CONFLICT && response.body?.state === 'unknown';
}

/** Identity's account record as people's account view. */
function accountView(record: Schemas['AccountRecord']): AccountView {
  return {
    userId: record.UserID,
    siteId: record.SiteID,
    username: record.UserName,
    s2: record.S2,
    isPublic: record.isPublic,
    inactive: record.InActive,
    type: record.Type,
    perm: record.Perm,
    admin: record.Admin,
    remoteId: record.remoteID,
    lastLogin: record.LastLogin,
    passwordCreated: record.PasswordCreated,
    tablist: record.tablist,
  };
}

/** One `listSiteGroups` row as a group summary. */
function groupSummary(group: Schemas['SiteGroup']): GroupSummary {
  return { groupId: group.UserID, groupName: group.GroupName, siteId: group.SiteID, isPublic: group.isPublic, perm: group.Perm };
}

function userGroupRow(item: Schemas['GroupListItem']): UserGroupRow {
  // Absent optional columns are the NULLs legacy's query selects.
  return {
    userId: item.UserID,
    email: item.Email ?? null,
    groupName: item.GroupName,
    type: item.Type ?? null,
    lastLogin: item.LastLogin ?? null,
    lastUpdate: item.LastUpdate ?? null,
    lastUpdateBy: item.LastUpdateBy ?? null,
    lastUpdateById: item.LastUpdateByID ?? null,
    counter: item.Counter,
    perm: item.Perm,
    isPublic: item.isPublic,
  };
}

/** Creates people's identity client over its service client (or the CLI's). */
export function createIdentityClient(client: ServiceClient): IdentityClient {
  /** Sends one identity call and records the reply's write positions, whatever its status. */
  async function send<T>(
    op: IdentityOperation,
    path: string,
    extra: { json?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<ServiceResponse<T>> {
    const response = await client.request<T>({ service: IDENTITY_SERVICE, method: op.method, path, ...extra });
    // The CLI runs outside a request; there is then no response to carry the positions.
    if (currentRequestContext() !== undefined) recordWritePositionsFrom(response.headers[WRITE_POSITION_HEADER_LC]);
    return response;
  }

  async function step(
    op: IdentityOperation,
    userId: string,
    operationId: string,
    resolveNeverPrepared: boolean,
  ): Promise<void> {
    const response = await send<AccountOperation | undefined>(op, fillPath(op.path, userId, operationId));
    if (response.status === HTTP_OK || (resolveNeverPrepared && neverPrepared(response))) return;
    throw unavailable(op, response.status);
  }

  async function userMemberships(userId: string, siteId?: string): Promise<UserMemberships> {
    const op = OPS.userMemberships;
    return okBody(op, await send<UserMemberships>(op, fillPath(op.path, userId), { query: { siteid: siteId } }));
  }

  return {
    async prepare(userId, operationId, change) {
      const op = OPS.prepare;
      const response = await send<unknown>(op, fillPath(op.path, userId, operationId), { json: change });
      if (response.status === HTTP_OK) return { ok: true, ...(response.body as AccountOperation) };
      if (response.status === HTTP_BAD_REQUEST && isLegacyErrors(response.body)) {
        return { ok: false, errors: response.body };
      }
      throw unavailable(op, response.status);
    },

    async commit(userId, operationId) {
      const op = OPS.commit;
      const result = okBody(op, await send<CommitOutcome>(op, fillPath(op.path, userId, operationId)));
      if (currentRequestContext() !== undefined) recordWritePosition(IDENTITY_SERVICE, result.writePosition);
      return result;
    },

    abort: (userId, operationId) => step(OPS.abort, userId, operationId, true),

    finish: (userId, operationId) => step(OPS.finish, userId, operationId, false),

    revert: (userId, operationId) => step(OPS.revert, userId, operationId, true),

    async operationState(userId, operationId) {
      const op = OPS.operationState;
      const operation = okBody(op, await send<AccountOperation>(op, fillPath(op.path, userId, operationId)));
      // The contract has no not-found status: an operation identity never prepared reads as `unknown`.
      return operation.state === 'unknown' ? undefined : operation.state;
    },

    async readAccount(userId) {
      const op = OPS.readAccount;
      const response = await send<Schemas['AccountRecord']>(op, fillPath(op.path, userId));
      if (response.status === HTTP_NOT_FOUND) return undefined;
      return accountView(okBody(op, response));
    },

    async readAccounts(userIds) {
      const accounts = new Map<string, AccountView>();
      const lookup: Schemas['AccountLookupRequest'] = { userIds: [...new Set(userIds)] };
      if (lookup.userIds.length === 0) return accounts;
      const op = OPS.readAccounts;
      const { items } = okBody(op, await send<Schemas['AccountList']>(op, op.path, { json: lookup }));
      for (const record of items) accounts.set(record.UserID, accountView(record));
      return accounts;
    },

    userMemberships,

    async membershipGroupIds(userId) {
      return (await userMemberships(userId)).groupIds;
    },

    async siteGroups(siteId, isPublic) {
      const op = OPS.siteGroups;
      const query = { siteid: siteId, ispublic: String(isPublic) };
      return okBody(op, await send<Schemas['SiteGroupList']>(op, op.path, { query })).items.map(groupSummary);
    },

    async userGroups(siteId, isPublic) {
      const op = OPS.userGroups;
      const query = { siteid: siteId, ispublic: String(isPublic) };
      return okBody(op, await send<Schemas['GroupList']>(op, op.path, { query })).items.map(userGroupRow);
    },

    // getSessionSnapshot admits only service:gateway; getCurrentSession reads the same login-time user for the forwarded token.
    async actingUser(sessionId) {
      const op = OPS.currentSession;
      const current = okBody(op, await send<Schemas['CurrentSession']>(op, op.path));
      if (current.sessionId !== sessionId || !current.user.isLoggedIn) return undefined;
      return { userId: current.user.userID, fname: current.user.fname ?? '', lname: current.user.lname ?? '' };
    },
  };
}
