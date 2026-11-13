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
/** Optional body of `commitAccountOperation`: the saving user's own session to log in again at finish. */
export type AccountCommitRequest = Schemas['AccountCommitRequest'];
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
/** Admin session-scope values of a session under their legacy `session` names, such as the advanced-search criteria. */
export type AdminSessionState = Schemas['AdminSessionState'];
/** One site of a session's site selector. */
export type SessionSite = Schemas['SessionSites']['sites'][number];
/** Account predicates identity applies to a lookup, count or candidate read; a NULL column matches no given value. */
export type AccountWhere = Schemas['AccountWhere'];
/** Body of `countAccounts`: the pool, tenant or all-sites scope and its account predicates. */
export type AccountCountRequest = Schemas['AccountCountRequest'];
/** Body of `lookupUsernameCandidates`: the pool, the `COLLATE "C" ILIKE` pattern, the account predicates and the most items. */
export type UsernameCandidateRequest = Schemas['UsernameCandidateRequest'];
/** The pool accounts whose UserName matched, by user id, and whether they were every match. */
export interface UsernameCandidates {
  items: { userId: string; username: string }[];
  complete: boolean;
}

/** Prepare's answer: the prepared operation, or identity's legacy validation errors unchanged. */
export type PrepareOutcome = ({ ok: true } & AccountOperation) | { ok: false; errors: LegacyErrors };

/** Options of one identity call; `timeoutMs` bounds it instead of the service client's timeout. */
export interface IdentityCallOptions {
  timeoutMs?: number;
}

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
  prepare(userId: string, operationId: string, change: AccountPrepareRequest, options?: IdentityCallOptions): Promise<PrepareOutcome>;
  /** `commitAccountOperation`: applies the prepared change and records identity's write position; `request` is sent only when given. */
  commit(userId: string, operationId: string, request?: AccountCommitRequest, options?: IdentityCallOptions): Promise<CommitOutcome>;
  /** `abortAccountOperation`: discards a prepared change; an operation identity never prepared resolves too. */
  abort(userId: string, operationId: string, options?: IdentityCallOptions): Promise<void>;
  /** `finishAccountOperation`: completes a committed operation and reopens the user. */
  finish(userId: string, operationId: string, options?: IdentityCallOptions): Promise<void>;
  /** `revertAccountOperation`: restores the values recorded at prepare; an operation identity never prepared resolves too. */
  revert(userId: string, operationId: string, options?: IdentityCallOptions): Promise<void>;
  /** `getAccountOperation`: the operation's state; undefined when identity never prepared it. */
  operationState(userId: string, operationId: string, options?: IdentityCallOptions): Promise<AccountOperationState | undefined>;
  /** `getAccount`: the user's account columns; undefined for a missing user, a group or a `pending` account. */
  readAccount(userId: string, options?: IdentityCallOptions): Promise<AccountView | undefined>;
  /** `lookupAccounts`: the account columns of the users `where` matches, keyed by user id, one call per 1000 ids; an empty list makes no call. */
  readAccounts(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>>;
  /** `lookupAccountsAllSites`: `readAccounts` over every registered site's user pools, which identity admits for an S2 token only. */
  readAccountsAllSites(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>>;
  /** `countAccounts`: how many accounts of the request's scope its `where` matches. */
  countAccounts(request: AccountCountRequest): Promise<number>;
  /** `lookupUsernameCandidates`: the first `limit` pool accounts by user id whose UserName matches the pattern, and whether that was all. */
  usernameCandidates(request: UsernameCandidateRequest): Promise<UsernameCandidates>;
  /** `lookupMemberships`: each user's stored membership group ids, keyed by requested id, one call per 1000 ids; an empty list makes no call. */
  lookupMemberships(userIds: readonly string[]): Promise<Map<string, string[]>>;
  /** `listUserMemberships`: the site's groups and the user's memberships; `siteId` defaults to the token's site. */
  userMemberships(userId: string, siteId?: string): Promise<UserMemberships>;
  /** Ids of the groups the user belongs to, in identity's `readMembershipIDs` order. */
  membershipGroupIds(userId: string, options?: IdentityCallOptions): Promise<string[]>;
  /** `listSiteGroups`: the groups of the site's private (`isPublic` 0) or public (1) user pool, in identity's order. */
  siteGroups(siteId: string, isPublic: number): Promise<GroupSummary[]>;
  /** `listGroups`: every `cusers.list` group row, by `Perm` descending, then group name, read page by page. */
  userGroups(siteId: string, isPublic: number): Promise<UserGroupRow[]>;
  /** `getCurrentSession`: the forwarded token's login-time session user when it is `sessionId` and logged in. */
  actingUser(sessionId: string): Promise<ActingUser | undefined>;
  /** `getAdminSessionState`: the admin session values of the forwarded token's session; `{}` when it stored none. */
  adminSessionState(): Promise<AdminSessionState>;
  /** `saveAdminSessionState`: stores each given key whole in the forwarded token's session and returns the merged values. */
  saveAdminSessionState(state: AdminSessionState): Promise<AdminSessionState>;
  /** `listCurrentSessionSites`: the sites of the forwarded token's site selector, in identity's order. */
  sessionSites(): Promise<SessionSite[]>;
  /** `loadLoginBlock`: loads the user's login block, clearing strikes first when requested. */
  loginBlock(userId: string, removeBlock: boolean): Promise<string | null>;
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
  readAccountsAllSites: { operationId: 'lookupAccountsAllSites', method: 'POST', path: '/internal/v1/accounts:lookup-all-sites' },
  countAccounts: { operationId: 'countAccounts', method: 'POST', path: '/internal/v1/accounts:count' },
  usernameCandidates: { operationId: 'lookupUsernameCandidates', method: 'POST', path: '/internal/v1/accounts:username-candidates' },
  lookupMemberships: { operationId: 'lookupMemberships', method: 'POST', path: '/internal/v1/accounts:memberships' },
  userMemberships: { operationId: 'listUserMemberships', method: 'GET', path: '/v1/users/{userId}/memberships' },
  siteGroups: { operationId: 'listSiteGroups', method: 'GET', path: '/internal/v1/groups' },
  userGroups: { operationId: 'listGroups', method: 'GET', path: '/v1/groups' },
  currentSession: { operationId: 'getCurrentSession', method: 'GET', path: '/v1/sessions/current' },
  adminState: { operationId: 'getAdminSessionState', method: 'GET', path: '/v1/sessions/current/admin-state' },
  saveAdminState: { operationId: 'saveAdminSessionState', method: 'POST', path: '/v1/sessions/current/admin-state' },
  sessionSites: { operationId: 'listCurrentSessionSites', method: 'GET', path: '/v1/sessions/current/sites' },
  loginBlock: { operationId: 'loadLoginBlock', method: 'POST', path: '/internal/v1/accounts/{userId}/login-block' },
} as const satisfies Record<string, IdentityOperation>;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** `maxItems` of identity's `MembershipLookupRequest` user ids; account lookups take the same chunks to keep request bodies bounded. */
const LOOKUP_MAX_IDS = 1000;

/** The distinct ids of `userIds` in first-seen order, split into lookup bodies of at most `LOOKUP_MAX_IDS`. */
function lookupChunks(userIds: readonly string[]): string[][] {
  const distinct = [...new Set(userIds)];
  const chunks: string[][] = [];
  for (let start = 0; start < distinct.length; start += LOOKUP_MAX_IDS) chunks.push(distinct.slice(start, start + LOOKUP_MAX_IDS));
  return chunks;
}

/** The legacy-shaped 503 for an identity answer outside the operation's handled statuses. */
function unavailable(op: IdentityOperation, status: number): ServiceUnavailableError {
  const cause = Object.assign(new Error(`${IDENTITY_SERVICE} ${op.operationId} answered HTTP ${status}`), {
    code: `HTTP_${String(status)}`,
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

/** The service-request fields of `options`: a call timeout only when one is given. */
function callBounds(options: IdentityCallOptions | undefined): { timeoutMs?: number } {
  return options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
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
    extra: { json?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number } = {},
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
    options: IdentityCallOptions | undefined,
  ): Promise<void> {
    const response = await send<AccountOperation | undefined>(op, fillPath(op.path, userId, operationId), callBounds(options));
    if (response.status === HTTP_OK || (resolveNeverPrepared && neverPrepared(response))) return;
    throw unavailable(op, response.status);
  }

  async function userMemberships(userId: string, siteId?: string, options?: IdentityCallOptions): Promise<UserMemberships> {
    const op = OPS.userMemberships;
    return okBody(op, await send<UserMemberships>(op, fillPath(op.path, userId), { query: { siteid: siteId }, ...callBounds(options) }));
  }

  /** The account views `op` (`lookupAccounts` or `lookupAccountsAllSites`) answers for `userIds` and `where`, one call per chunk. */
  async function lookupAccounts(op: IdentityOperation, userIds: readonly string[], where: AccountWhere | undefined): Promise<Map<string, AccountView>> {
    const accounts = new Map<string, AccountView>();
    for (const chunk of lookupChunks(userIds)) {
      const lookup: Schemas['AccountLookupRequest'] = where === undefined ? { userIds: chunk } : { userIds: chunk, where };
      const { items } = okBody(op, await send<Schemas['AccountList']>(op, op.path, { json: lookup }));
      for (const record of items) accounts.set(record.UserID, accountView(record));
    }
    return accounts;
  }

  return {
    async prepare(userId, operationId, change, options) {
      const op = OPS.prepare;
      const response = await send<unknown>(op, fillPath(op.path, userId, operationId), { json: change, ...callBounds(options) });
      if (response.status === HTTP_OK) return { ok: true, ...(response.body as AccountOperation) };
      if (response.status === HTTP_BAD_REQUEST && isLegacyErrors(response.body)) {
        return { ok: false, errors: response.body };
      }
      throw unavailable(op, response.status);
    },

    async commit(userId, operationId, request, options) {
      const op = OPS.commit;
      const body = request === undefined ? {} : { json: request };
      const result = okBody(op, await send<CommitOutcome>(op, fillPath(op.path, userId, operationId), { ...body, ...callBounds(options) }));
      if (currentRequestContext() !== undefined) recordWritePosition(IDENTITY_SERVICE, result.writePosition);
      return result;
    },

    abort: (userId, operationId, options) => step(OPS.abort, userId, operationId, true, options),

    finish: (userId, operationId, options) => step(OPS.finish, userId, operationId, false, options),

    revert: (userId, operationId, options) => step(OPS.revert, userId, operationId, true, options),

    async operationState(userId, operationId, options) {
      const op = OPS.operationState;
      const operation = okBody(op, await send<AccountOperation>(op, fillPath(op.path, userId, operationId), callBounds(options)));
      // The contract has no not-found status: an operation identity never prepared reads as `unknown`.
      return operation.state === 'unknown' ? undefined : operation.state;
    },

    async readAccount(userId, options) {
      const op = OPS.readAccount;
      const response = await send<Schemas['AccountRecord']>(op, fillPath(op.path, userId), callBounds(options));
      if (response.status === HTTP_NOT_FOUND) return undefined;
      return accountView(okBody(op, response));
    },

    readAccounts: (userIds, where) => lookupAccounts(OPS.readAccounts, userIds, where),

    readAccountsAllSites: (userIds, where) => lookupAccounts(OPS.readAccountsAllSites, userIds, where),

    async countAccounts(request) {
      const op = OPS.countAccounts;
      return okBody(op, await send<Schemas['AccountCount']>(op, op.path, { json: request })).count;
    },

    async usernameCandidates(request) {
      const op = OPS.usernameCandidates;
      const { items, complete } = okBody(op, await send<Schemas['UsernameCandidateList']>(op, op.path, { json: request }));
      return { items: items.map(({ userId, username }) => ({ userId, username })), complete };
    },

    async lookupMemberships(userIds) {
      const op = OPS.lookupMemberships;
      const memberships = new Map<string, string[]>();
      for (const chunk of lookupChunks(userIds)) {
        const lookup: Schemas['MembershipLookupRequest'] = { userIds: chunk };
        const { items } = okBody(op, await send<Schemas['MembershipList']>(op, op.path, { json: lookup }));
        for (const item of items) memberships.set(item.userId, item.groupIds);
      }
      return memberships;
    },

    userMemberships,

    async membershipGroupIds(userId, options) {
      return (await userMemberships(userId, undefined, options)).groupIds;
    },

    async siteGroups(siteId, isPublic) {
      const op = OPS.siteGroups;
      const query = { siteid: siteId, ispublic: String(isPublic) };
      return okBody(op, await send<Schemas['SiteGroupList']>(op, op.path, { query })).items.map(groupSummary);
    },

    async userGroups(siteId, isPublic) {
      const op = OPS.userGroups;
      const rows: UserGroupRow[] = [];
      // Every page in turn, each at identity's default size, until nextOffset ends the listing.
      for (let offset: number | null = 0; offset !== null; ) {
        const query: Record<string, string> = { siteid: siteId, ispublic: String(isPublic), offset: String(offset) };
        const page: Schemas['GroupList'] = okBody(op, await send<Schemas['GroupList']>(op, op.path, { query }));
        for (const item of page.items) rows.push(userGroupRow(item));
        offset = page.nextOffset;
      }
      return rows;
    },

    // getSessionSnapshot admits only service:gateway; getCurrentSession reads the same login-time user for the forwarded token.
    async actingUser(sessionId) {
      const op = OPS.currentSession;
      const current = okBody(op, await send<Schemas['CurrentSession']>(op, op.path));
      if (current.sessionId !== sessionId || !current.user.isLoggedIn) return undefined;
      return { userId: current.user.userID, fname: current.user.fname ?? '', lname: current.user.lname ?? '' };
    },

    async adminSessionState() {
      const op = OPS.adminState;
      return okBody(op, await send<AdminSessionState>(op, op.path));
    },

    async saveAdminSessionState(state) {
      const op = OPS.saveAdminState;
      return okBody(op, await send<AdminSessionState>(op, op.path, { json: state }));
    },

    async sessionSites() {
      const op = OPS.sessionSites;
      return okBody(op, await send<Schemas['SessionSites']>(op, op.path)).sites;
    },

    async loginBlock(userId, removeBlock) {
      const op = OPS.loginBlock;
      const body: Schemas['LoginBlockRequest'] = { removeBlock };
      const response = await send<Schemas['LoginBlock']>(op, fillPath(op.path, userId), { json: body });
      if (response.status === HTTP_NOT_FOUND) return null;
      return okBody(op, response).blockedUntil;
    },
  };
}
