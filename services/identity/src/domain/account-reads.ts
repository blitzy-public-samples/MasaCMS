/** Owner reads of identity's account, membership, strike and pool-group rows for people: `getAccount`, `lookupAccounts`, `lookupAccountsAllSites`, `countAccounts`, `lookupUsernameCandidates`, `lookupMemberships`, `loadLoginBlock` and `listSiteGroups`. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { localTimestamp } from '@opt2/platform/outbox';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import { registeredTenants, registryEntryForTenant, tenantIdForSite, type TenantDb, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { charKey, type AccountFilter, type AccountRecordRow, type IdentityRepository, type PoolGroupRow } from '../repo/repository.js';
import {
  DEFAULT_STRIKE_SETTINGS,
  blockedUntil,
  clearStrikes,
  isBlocked,
  loadStrikes,
  type StrikeOptions,
  type StrikeSettings,
} from './strikes.js';

/** The contract's identity columns of one `Type=2` user. */
export type AccountRecord = components['schemas']['AccountRecord'];

/** The contract's account predicates of a lookup, count or candidate read. */
export type AccountWhere = components['schemas']['AccountWhere'];

/** The contract's `countAccounts` request. */
export type AccountCountRequest = components['schemas']['AccountCountRequest'];

/** The contract's `lookupUsernameCandidates` request. */
export type UsernameCandidateRequest = components['schemas']['UsernameCandidateRequest'];

/** The contract's `lookupUsernameCandidates` answer. */
export type UsernameCandidateList = components['schemas']['UsernameCandidateList'];

/** The contract's row of one pool group. */
export type SiteGroup = components['schemas']['SiteGroup'];

/** The contract's stored membership group ids of one user. */
export type MembershipListItem = components['schemas']['MembershipListItem'];

/** The contract's login block of one account. */
export type LoginBlock = components['schemas']['LoginBlock'];

/** `loadLoginBlock`'s request body with the request id its strike writes record. */
export type LoginBlockInput = components['schemas']['LoginBlockRequest'] & { requestId?: string };

/** Pool visibility of `listSiteGroups`: 0 private (system groups), 1 public (member groups). */
export type PoolVisibility = 0 | 1;

/** Longest a read of a user waits while an open account operation keeps that user closed. */
export const CLOSED_USER_WAIT_MS = 10_000;

const POLL_START_MS = 50;
const POLL_MAX_MS = 500;

/** Dependencies of `createAccountReads`; the waits default to 10 s closed-user and 30 s gate, `strikes` to Masa's limits, `clock` to the system clock. */
export interface AccountReadsDeps {
  repo: IdentityRepository;
  closedUserWaitMs?: number;
  gateWaitMs?: number;
  strikes?: StrikeSettings;
  clock?: Clock;
}

/** Owner reads for people; tenants come only from `claims.tid` and the registry, never from the caller. */
export interface AccountReads {
  /** `getAccount`: the user's account record; null for a missing user, a group or a `pending` account. */
  getAccount(db: TenantDb, claims: UserClaims, userId: string): Promise<AccountRecord | null>;
  /** `lookupAccounts`: the records `getAccount` finds among `userIds` that `where` matches, in request order. */
  lookupAccounts(db: TenantDb, claims: UserClaims, userIds: readonly string[], where?: AccountWhere): Promise<AccountRecord[]>;
  /** `lookupAccountsAllSites`: `lookupAccounts` over every registered site's tenant and user pools; the route admits S2 callers only. */
  lookupAccountsAllSites(db: TenantDb, userIds: readonly string[], where?: AccountWhere): Promise<AccountRecord[]>;
  /** `countAccounts`: how many active accounts of the request's scope `where` matches; the route admits `all-sites` for S2 callers only. */
  countAccounts(db: TenantDb, claims: UserClaims, request: AccountCountRequest): Promise<number>;
  /** `lookupUsernameCandidates`: the first `limit` pool accounts by user id whose UserName matches the pattern, and whether that was all; waits while a read candidate is closed. */
  lookupUsernameCandidates(db: TenantDb, claims: UserClaims, request: UsernameCandidateRequest): Promise<UsernameCandidateList>;
  /** `lookupMemberships`: each listed user's stored membership group ids from every registered tenant, one item per id in request order. */
  lookupMemberships(db: TenantDb, userIds: readonly string[]): Promise<MembershipListItem[]>;
  /** `loadLoginBlock`: the strike block of the `getAccount` user's stored user name, cleared on `removeBlock`; null when `getAccount` finds none. */
  loadLoginBlock(db: TenantDb, claims: UserClaims, userId: string, input: LoginBlockInput): Promise<LoginBlock | null>;
  /** `listSiteGroups`: the groups of the site's private or public user pool, as `getPrivateGroups`/`getPublicGroups` list them. */
  listSiteGroups(db: TenantDb, claims: UserClaims, isPublic: PoolVisibility): Promise<SiteGroup[]>;
}

/** A `timestamp without time zone` value as the contract's `LocalTimestamp`. */
function timestamp(value: Date | null): string | null {
  return value === null ? null : localTimestamp(value).replace(' ', 'T');
}

function accountRecord(row: AccountRecordRow): AccountRecord {
  return {
    UserID: row.userid,
    // A NULL SiteID reads as '' from the legacy query, as userDAO.read hands it to the bean.
    SiteID: row.siteid ?? '',
    UserName: row.username,
    Type: 2,
    Admin: row.admin,
    S2: row.s2,
    Perm: row.perm,
    InActive: row.inactive,
    isPublic: row.ispublic,
    remoteID: row.remoteid,
    PasswordCreated: timestamp(row.passwordcreated),
    LastLogin: timestamp(row.lastlogin),
    tablist: row.tablist,
  };
}

function siteGroup(row: PoolGroupRow): SiteGroup {
  return { UserID: row.userid, GroupName: row.groupname, SiteID: row.siteid, isPublic: row.ispublic, Perm: row.perm };
}

/** The pool site id and tenant of `entry`'s private (0) or public (1) user pool; null when unregistered. */
function userPool(entry: TenantRegistryEntry, isPublic: PoolVisibility): { siteId: string; tenant: string } | null {
  const siteId = isPublic === 1 ? entry.publicUserPoolId : entry.privateUserPoolId;
  const tenant = isPublic === 1 ? entry.publicUserPoolTenant : entry.privateUserPoolTenant;
  return siteId === null || tenant === null ? null : { siteId, tenant };
}

/** The pool people's user list reads: the site's public or private pool site, an empty id read as the site's own, in the tenant the registry gives it. */
function listedPool(entry: TenantRegistryEntry, publicPool: boolean): { siteId: string; tenant: string } {
  const poolId = publicPool ? entry.publicUserPoolId : entry.privateUserPoolId;
  const siteId = poolId === null || poolId === '' ? entry.siteId : poolId;
  return { siteId, tenant: (publicPool ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId) };
}

/** One tenant `countAccounts` counts in, limited to a pool site when one is named. */
interface CountScope {
  tenant: string;
  siteId: string | null;
}

/** An active account row with the tenant that stores it. */
interface StoredAccount {
  tenant: string;
  row: AccountRecordRow;
}

/** The tenants of the site's private and public user pools, without repeats; none for an unregistered site. */
function userPoolTenants(entry: TenantRegistryEntry | null): string[] {
  if (entry === null) return [];
  const tenants = [entry.privateUserPoolTenant, entry.publicUserPoolTenant].filter((tenant): tenant is string => tenant !== null);
  return [...new Set(tenants)];
}

/** Builds the account reads over the injected repository. */
export function createAccountReads(deps: AccountReadsDeps): AccountReads {
  const { repo, closedUserWaitMs = CLOSED_USER_WAIT_MS, strikes = DEFAULT_STRIKE_SETTINGS, clock = systemClock } = deps;
  const gateBudget = { budgetMs: deps.gateWaitMs };

  /** Repeats `read` until it names no closed user, or throws the legacy 503 once the closed-user wait runs out. */
  async function untilOpen<T>(read: () => Promise<{ value: T; closed: readonly string[] }>): Promise<T> {
    const deadline = Date.now() + closedUserWaitMs;
    for (let delay = POLL_START_MS; ; delay = Math.min(delay * 2, POLL_MAX_MS)) {
      const { value, closed } = await read();
      if (closed.length === 0) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LegacyServiceUnavailableError(`Account operation open for ${closed.join(', ')}; the read waited out its budget`, 'auto', 'user-closed');
      }
      await sleep(Math.min(delay, remaining));
    }
  }

  /** The repository filter of `where` per statement tenant; `unassigned` first reads the registered tenants' rows of members stored elsewhere, among `userIds` unless null. */
  async function filterOf(db: TenantDb, where: AccountWhere | undefined, userIds: readonly string[] | null): Promise<(tenant: string) => AccountFilter | undefined> {
    if (where === undefined) return () => undefined;
    const { unassigned, ...predicates } = where;
    if (unassigned !== true) return () => predicates;
    const registered = (await registeredTenants(db)).map((entry) => entry.tenantId);
    const assignedElsewhere: string[] = [];
    for (const tenant of registered) {
      assignedElsewhere.push(...(await withGatedTenant(db, tenant, (tx) => repo.foreignMemberIds(tx, userIds), gateBudget)));
    }
    return (tenant) => ({ ...predicates, unassigned: { ownMemberships: registered.includes(tenant), assignedElsewhere } });
  }

  /** The active accounts among `userIds` stored in `tenants` that `where` matches, by user id key, re-read until no listed user is closed or the wait runs out (503). */
  function storedAccounts(db: TenantDb, tenants: readonly string[], userIds: readonly string[], where?: AccountWhere): Promise<Map<string, StoredAccount>> {
    return untilOpen(async () => {
      const filterFor = await filterOf(db, where, userIds);
      const found = new Map<string, StoredAccount>();
      const closed: string[] = [];
      for (const tenant of tenants) {
        for (const row of await withGatedTenant(db, tenant, (tx) => repo.readAccountRecords(tx, userIds, filterFor(tenant)), gateBudget)) {
          if (row.closed) closed.push(row.userid);
          else if (row.opt2_state === 'active') found.set(charKey(row.userid), { tenant, row });
        }
      }
      return { value: found, closed };
    });
  }

  /** The records of the active accounts among `userIds` stored in `tenants` that `where` matches, in request order. */
  async function readAccountsIn(db: TenantDb, tenants: readonly string[], userIds: readonly string[], where?: AccountWhere): Promise<AccountRecord[]> {
    const found = await storedAccounts(db, tenants, userIds, where);
    return userIds.flatMap((userId) => {
      const stored = found.get(charKey(userId));
      return stored === undefined ? [] : [accountRecord(stored.row)];
    });
  }

  /** The tenants of the token site's user pools. */
  async function tokenPoolTenants(db: TenantDb, claims: UserClaims): Promise<string[]> {
    return userPoolTenants(await registryEntryForTenant(db, claims.tid));
  }

  /** The active accounts among `userIds` in the token site's user pools that `where` matches, in request order. */
  async function readAccounts(db: TenantDb, claims: UserClaims, userIds: readonly string[], where?: AccountWhere): Promise<AccountRecord[]> {
    return readAccountsIn(db, await tokenPoolTenants(db, claims), userIds, where);
  }

  async function lookupAccountsAllSites(db: TenantDb, userIds: readonly string[], where?: AccountWhere): Promise<AccountRecord[]> {
    const tenants: string[] = [];
    for (const { tenantId } of await registeredTenants(db)) {
      tenants.push(tenantId, ...userPoolTenants(await registryEntryForTenant(db, tenantId)));
    }
    return readAccountsIn(db, [...new Set(tenants)], userIds, where);
  }

  /** The tenants a count of `scope` reads: the token site's listed pool, the token tenant when `lookupAccounts` reads it, or every registered tenant. */
  async function countScopes(db: TenantDb, claims: UserClaims, { scope, publicPool }: AccountCountRequest): Promise<CountScope[]> {
    if (scope === 'all-sites') return (await registeredTenants(db)).map(({ tenantId }) => ({ tenant: tenantId, siteId: null }));
    const entry = await registryEntryForTenant(db, claims.tid);
    if (entry === null) return [];
    if (scope === 'tenant') return userPoolTenants(entry).includes(entry.tenantId) ? [{ tenant: entry.tenantId, siteId: null }] : [];
    const pool = listedPool(entry, publicPool === true);
    return [{ tenant: pool.tenant, siteId: pool.siteId }];
  }

  async function countAccounts(db: TenantDb, claims: UserClaims, request: AccountCountRequest): Promise<number> {
    const scopes = await countScopes(db, claims, request);
    return untilOpen(async () => {
      const filterFor = await filterOf(db, request.where, null);
      let count = 0;
      const closed: string[] = [];
      for (const { tenant, siteId } of scopes) {
        const counted = await withGatedTenant(db, tenant, (tx) => repo.countListedAccounts(tx, { siteId, filter: filterFor(tenant) }), gateBudget);
        count += counted.count;
        closed.push(...counted.closed);
      }
      return { value: count, closed };
    });
  }

  async function lookupUsernameCandidates(db: TenantDb, claims: UserClaims, request: UsernameCandidateRequest): Promise<UsernameCandidateList> {
    const entry = await registryEntryForTenant(db, claims.tid);
    if (entry === null) return { items: [], complete: true };
    const { siteId, tenant } = listedPool(entry, request.publicPool);
    const rows = await untilOpen(async () => {
      const query = { siteId, pattern: request.pattern, filter: (await filterOf(db, request.where, null))(tenant), limit: request.limit + 1 };
      const read = await withGatedTenant(db, tenant, (tx) => repo.readUsernameCandidates(tx, query), gateBudget);
      return { value: read, closed: read.filter((row) => row.closed).map((row) => row.userid) };
    });
    return { items: rows.slice(0, request.limit).map((row) => ({ userId: row.userid, username: row.username })), complete: rows.length <= request.limit };
  }

  async function lookupMemberships(db: TenantDb, userIds: readonly string[]): Promise<MembershipListItem[]> {
    const tenants = (await registeredTenants(db)).map((entry) => entry.tenantId);
    const held = await untilOpen(async () => {
      // Per user id key, the group ids by group id key in first-read order.
      const groups = new Map<string, Map<string, string>>();
      const closed: string[] = [];
      for (const tenant of tenants) {
        const records = await withGatedTenant(db, tenant, (tx) => repo.readMembershipRecords(tx, userIds), gateBudget);
        closed.push(...records.closed);
        for (const { userid, groupid } of records.rows) {
          const ids = groups.get(charKey(userid)) ?? new Map<string, string>();
          if (!ids.has(charKey(groupid))) ids.set(charKey(groupid), groupid);
          groups.set(charKey(userid), ids);
        }
      }
      return { value: groups, closed };
    });
    return userIds.map((userId) => ({ userId, groupIds: [...(held.get(charKey(userId))?.values() ?? [])] }));
  }

  async function loadLoginBlock(db: TenantDb, claims: UserClaims, userId: string, input: LoginBlockInput): Promise<LoginBlock | null> {
    const stored = (await storedAccounts(db, await tokenPoolTenants(db, claims), [userId])).get(charKey(userId));
    if (stored === undefined) return null;
    // Legacy loads strikes only for a non-empty `userBean.getUsername()`, which reads a NULL user name as ''.
    const username = stored.row.username ?? '';
    if (username === '') return { blockedUntil: null };
    const options: StrikeOptions = { settings: strikes, clock, ctx: { actorUserId: claims.sub, requestId: input.requestId } };
    return withGatedTenant(
      db,
      stored.tenant,
      async (tx) => {
        const loaded = await loadStrikes(repo, tx, username, options);
        const state = input.removeBlock ? await clearStrikes(repo, tx, loaded, options) : loaded;
        return { blockedUntil: isBlocked(state, strikes) ? timestamp(blockedUntil(state, strikes, clock)) : null };
      },
      gateBudget,
    );
  }

  async function getAccount(db: TenantDb, claims: UserClaims, userId: string): Promise<AccountRecord | null> {
    return (await readAccounts(db, claims, [userId]))[0] ?? null;
  }

  async function listSiteGroups(db: TenantDb, claims: UserClaims, isPublic: PoolVisibility): Promise<SiteGroup[]> {
    const entry = await registryEntryForTenant(db, claims.tid);
    const pool = entry === null ? null : userPool(entry, isPublic);
    if (entry === null || pool === null) return [];
    // Legacy inner-joins the pool site's own settings row on that pool id, so a pool site pooling elsewhere lists nothing.
    const poolEntry = pool.tenant === entry.tenantId ? entry : await registryEntryForTenant(db, pool.tenant);
    const own = poolEntry === null ? null : userPool(poolEntry, isPublic);
    if (own === null || own.siteId.toLowerCase() !== pool.siteId.toLowerCase()) return [];
    const rows = await withGatedTenant(db, pool.tenant, (tx) => repo.listPoolGroups(tx, pool.siteId, isPublic), gateBudget);
    return rows.map(siteGroup);
  }

  return Object.freeze({
    getAccount,
    lookupAccounts: readAccounts,
    lookupAccountsAllSites,
    countAccounts,
    lookupUsernameCandidates,
    lookupMemberships,
    loadLoginBlock,
    listSiteGroups,
  });
}
