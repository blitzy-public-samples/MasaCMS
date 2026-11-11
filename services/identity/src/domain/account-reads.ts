/** Owner reads of identity's account and pool-group rows for people: `getAccount`, `lookupAccounts` and `listSiteGroups`. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { localTimestamp } from '@opt2/platform/outbox';
import { registryEntryForTenant, type TenantDb, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import type { AccountRecordRow, IdentityRepository, PoolGroupRow } from '../repo/repository.js';

/** The contract's identity columns of one `Type=2` user. */
export type AccountRecord = components['schemas']['AccountRecord'];

/** The contract's row of one pool group. */
export type SiteGroup = components['schemas']['SiteGroup'];

/** Pool visibility of `listSiteGroups`: 0 private (system groups), 1 public (member groups). */
export type PoolVisibility = 0 | 1;

/** Longest a read of a user waits while an open account operation keeps that user closed. */
export const CLOSED_USER_WAIT_MS = 10_000;

const POLL_START_MS = 50;
const POLL_MAX_MS = 500;

/** Dependencies of `createAccountReads`; the wait budgets default to the 10 s closed-user and 30 s gate waits. */
export interface AccountReadsDeps {
  repo: IdentityRepository;
  closedUserWaitMs?: number;
  gateWaitMs?: number;
}

/** Reads of the token site's user pools; the tenant comes only from `claims.tid` and the registry. */
export interface AccountReads {
  /** `getAccount`: the user's account record; null for a missing user, a group or a `pending` account. */
  getAccount(db: TenantDb, claims: UserClaims, userId: string): Promise<AccountRecord | null>;
  /** `lookupAccounts`: the records `getAccount` finds among `userIds`, in request order. */
  lookupAccounts(db: TenantDb, claims: UserClaims, userIds: readonly string[]): Promise<AccountRecord[]>;
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

/** The tenants of the site's private and public user pools, without repeats; none for an unregistered site. */
function userPoolTenants(entry: TenantRegistryEntry | null): string[] {
  if (entry === null) return [];
  const tenants = [entry.privateUserPoolTenant, entry.publicUserPoolTenant].filter((tenant): tenant is string => tenant !== null);
  return [...new Set(tenants)];
}

/** Builds the account reads over the injected repository. */
export function createAccountReads(deps: AccountReadsDeps): AccountReads {
  const { repo, closedUserWaitMs = CLOSED_USER_WAIT_MS } = deps;
  const gateBudget = { budgetMs: deps.gateWaitMs };

  /** The active accounts among `userIds` in the site's user pools, re-read until no listed user is closed or the wait runs out (503). */
  async function readAccounts(db: TenantDb, claims: UserClaims, userIds: readonly string[]): Promise<AccountRecord[]> {
    const tenants = userPoolTenants(await registryEntryForTenant(db, claims.tid));
    const deadline = Date.now() + closedUserWaitMs;
    for (let delay = POLL_START_MS; ; delay = Math.min(delay * 2, POLL_MAX_MS)) {
      const rows: AccountRecordRow[] = [];
      for (const tenant of tenants) {
        rows.push(...(await withGatedTenant(db, tenant, (tx) => repo.readAccountRecords(tx, userIds), gateBudget)));
      }
      const closed = rows.filter((row) => row.closed).map((row) => row.userid);
      if (closed.length === 0) {
        const found = new Map(rows.filter((row) => row.opt2_state === 'active').map((row) => [row.userid, accountRecord(row)]));
        return userIds.flatMap((userId) => found.get(userId) ?? []);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LegacyServiceUnavailableError(`Account operation open for ${closed.join(', ')}; the read waited out its budget`, 'auto', 'user-closed');
      }
      await sleep(Math.min(delay, remaining));
    }
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

  return Object.freeze({ getAccount, lookupAccounts: readAccounts, listSiteGroups });
}
