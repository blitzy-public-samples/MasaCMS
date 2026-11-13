/** In-memory doubles of people's search collaborators: identity answering one user token, and the repository's ordered person pages. */
import { registeredTenants, registryEntryForTenant, tenantIdForSite, type TenantDb, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type {
  AccountCountRequest,
  AccountView,
  AccountWhere,
  IdentityClient,
  UsernameCandidateRequest,
  UsernameCandidates,
} from '../../src/legacy/identity-client.js';
import type { PersonOrderScope, PersonSortKey } from '../../src/repo/repository.js';
import type { PersonRow } from '../../src/repo/tables.js';

/** The identity calls people's search reads make. */
export type IdentityReads = Pick<IdentityClient, 'readAccounts' | 'readAccountsAllSites' | 'lookupMemberships' | 'countAccounts' | 'usernameCandidates'>;

/** One recorded identity call: the operation and how many user ids it carried. */
export interface IdentityCall {
  op: keyof IdentityReads;
  ids: number;
}

/** The token identity reads for: its tenant and S2 claim, and the registry it resolves pools from. */
export interface IdentityToken {
  db: TenantDb;
  tid: string;
  s2: boolean;
}

/** A char(35) id as identity compares it: case-insensitive, trailing spaces ignored. */
export function charKey(id: string): string {
  return id.replace(/ +$/, '').toUpperCase();
}

/** ASCII letters lower-cased, every other unit kept, as `COLLATE "C"` folds case. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** PostgreSQL `value COLLATE "C" ILIKE pattern ESCAPE ''`: `%` any run, `_` one character, every other character literal. */
export function ilikeC(pattern: string): (value: string) => boolean {
  const source = [...asciiLower(pattern)]
    .map((char) => (char === '%' ? '[\\s\\S]*' : char === '_' ? '[\\s\\S]' : char.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`, 'u');
  return (value) => regex.test(asciiLower(value));
}

const COLLATOR = new Intl.Collator('en-US', { sensitivity: 'accent' });

/** SQL Server's order of two person values: NULLs lowest, text case-insensitively with trailing spaces ignored. */
function compareValue(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return COLLATOR.compare(String(a).replace(/ +$/, ''), String(b).replace(/ +$/, ''));
}

/** The persons of `rows` in `scope`, in `pagePersonsInOrder` order: `orderBy`, then userid. */
export function personsInOrder(rows: readonly PersonRow[], scope: PersonOrderScope, orderBy: readonly PersonSortKey[]): PersonRow[] {
  const like = scope.nameLike === undefined ? undefined : ilikeC(scope.nameLike.pattern);
  const named = new Set((scope.nameLike?.orUserIds ?? []).map(charKey));
  const value = (row: PersonRow, column: string): unknown => (row as unknown as Record<string, unknown>)[column];
  return rows
    .filter((row) => scope.siteIds === undefined || scope.siteIds.some((siteId) => charKey(siteId) === charKey(row.siteid ?? '')))
    .filter(
      (row) =>
        like === undefined ||
        named.has(charKey(row.userid)) ||
        [row.lname, row.fname, row.company, row.email, row.jobtitle].some((text) => text !== null && like(text)),
    )
    .sort((a, b) => {
      for (const { column, descending } of orderBy) {
        const order = compareValue(value(a, column), value(b, column));
        if (order !== 0) return descending ? -order : order;
      }
      return compareValue(a.userid, b.userid);
    });
}

/** The pool site and tenant of `entry`'s public or private user pool, an empty pool id read as the site's own. */
function listedPool(entry: TenantRegistryEntry, publicPool: boolean): { siteId: string; tenant: string } {
  const poolId = publicPool ? entry.publicUserPoolId : entry.privateUserPoolId;
  const siteId = poolId === null || poolId === '' ? entry.siteId : poolId;
  return { siteId, tenant: (publicPool ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId) };
}

/** The tenant storing an account: its pool site's. */
function tenantOf(view: AccountView): string | undefined {
  return view.siteId === '' ? undefined : tenantIdForSite(view.siteId);
}

/** Whether identity lists `view` under `where`: active Type=2 accounts only, a NULL column matching no given value. */
export function accountListed(view: AccountView, where: AccountWhere | undefined, memberships: ReadonlyMap<string, readonly string[]>): boolean {
  if (view.type !== 2) return false;
  if (where === undefined) return true;
  const equal = (value: number | null, expected: number | undefined): boolean => expected === undefined || (value !== null && value === expected);
  return (
    equal(view.isPublic, where.isPublic) &&
    equal(view.s2, where.s2) &&
    equal(view.inactive, where.inActive) &&
    (where.excludeS2Users !== true || (view.s2 !== null && view.s2 !== 1)) &&
    (where.siteIds === undefined || where.siteIds.some((siteId) => charKey(siteId) === charKey(view.siteId))) &&
    (where.unassigned !== true || (memberships.get(charKey(view.userId)) ?? []).length === 0)
  );
}

/** Identity's reads over `accounts` and `memberships`, both keyed by `charKey`, for one token; every call is recorded in `calls`. */
export class IdentityDouble implements IdentityReads {
  constructor(
    readonly accounts: Map<string, AccountView>,
    readonly memberships: Map<string, string[]>,
    readonly token: IdentityToken,
    readonly calls: IdentityCall[] = [],
  ) {}

  /** The same rows and call record, read for another token. */
  withToken(token: IdentityToken): IdentityDouble {
    return new IdentityDouble(this.accounts, this.memberships, token, this.calls);
  }

  /** How many calls of `op` were made. */
  count(op: keyof IdentityReads): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  /** How many user ids the calls of `op` carried together. */
  ids(op: keyof IdentityReads): number {
    return this.calls.filter((call) => call.op === op).reduce((sum, call) => sum + call.ids, 0);
  }

  async readAccounts(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>> {
    this.calls.push({ op: 'readAccounts', ids: userIds.length });
    const entry = await registryEntryForTenant(this.token.db, this.token.tid);
    const tenants = entry === null ? [] : [listedPool(entry, false).tenant, listedPool(entry, true).tenant];
    return this.lookup(userIds, where, tenants);
  }

  async readAccountsAllSites(userIds: readonly string[], where?: AccountWhere): Promise<Map<string, AccountView>> {
    this.calls.push({ op: 'readAccountsAllSites', ids: userIds.length });
    return this.lookup(userIds, where, await this.allSiteTenants(true));
  }

  async lookupMemberships(userIds: readonly string[]): Promise<Map<string, string[]>> {
    this.calls.push({ op: 'lookupMemberships', ids: userIds.length });
    return new Map(userIds.map((userId) => [userId, [...(this.memberships.get(charKey(userId)) ?? [])]]));
  }

  async countAccounts(request: AccountCountRequest): Promise<number> {
    this.calls.push({ op: 'countAccounts', ids: 0 });
    let scoped: (view: AccountView) => boolean;
    if (request.scope === 'all-sites') {
      const tenants = await this.allSiteTenants(false);
      scoped = (view) => tenants.includes(tenantOf(view) ?? '');
    } else {
      const entry = await registryEntryForTenant(this.token.db, this.token.tid);
      if (entry === null) return 0;
      if (request.scope === 'tenant') {
        const pools = [listedPool(entry, false).tenant, listedPool(entry, true).tenant];
        if (!pools.includes(entry.tenantId)) return 0;
        scoped = (view) => tenantOf(view) === entry.tenantId;
      } else {
        const pool = listedPool(entry, request.publicPool === true);
        scoped = (view) => tenantOf(view) === pool.tenant && charKey(view.siteId) === charKey(pool.siteId);
      }
    }
    return [...this.accounts.values()].filter((view) => scoped(view) && this.matches(view, request.where)).length;
  }

  async usernameCandidates(request: UsernameCandidateRequest): Promise<UsernameCandidates> {
    this.calls.push({ op: 'usernameCandidates', ids: 0 });
    const entry = await registryEntryForTenant(this.token.db, this.token.tid);
    if (entry === null) return { items: [], complete: true };
    const pool = listedPool(entry, request.publicPool);
    const like = ilikeC(request.pattern);
    const found = [...this.accounts.values()]
      .filter((view) => tenantOf(view) === pool.tenant && charKey(view.siteId) === charKey(pool.siteId) && this.matches(view, request.where))
      .filter((view): view is AccountView & { username: string } => view.username !== null && like(view.username))
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    return { items: found.slice(0, request.limit).map((view) => ({ userId: view.userId, username: view.username })), complete: found.length <= request.limit };
  }

  /** Whether identity lists `view` under `where`. */
  private matches(view: AccountView, where: AccountWhere | undefined): boolean {
    return accountListed(view, where, this.memberships);
  }

  /** The accounts among `userIds` stored in `tenants` that `where` matches, in request order, keyed by identity's spelling of the id. */
  private lookup(userIds: readonly string[], where: AccountWhere | undefined, tenants: readonly string[]): Map<string, AccountView> {
    const found = new Map<string, AccountView>();
    for (const userId of userIds) {
      const view = this.accounts.get(charKey(userId));
      if (view !== undefined && tenants.includes(tenantOf(view) ?? '') && this.matches(view, where)) found.set(view.userId, view);
    }
    return found;
  }

  /** Every registered tenant, with `withPools` also their pools' tenants: what the all-sites count and lookup read. */
  private async allSiteTenants(withPools: boolean): Promise<string[]> {
    if (!this.token.s2) throw new Error('identity answers 403 to an all-sites read for a token without S2');
    const tenants: string[] = [];
    for (const { tenantId } of await registeredTenants(this.token.db)) {
      const entry = withPools ? await registryEntryForTenant(this.token.db, tenantId) : null;
      tenants.push(tenantId, ...(entry === null ? [] : [listedPool(entry, false).tenant, listedPool(entry, true).tenant]));
    }
    return [...new Set(tenants)];
  }
}
