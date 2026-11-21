// Legacy keys a tuserstrikes row by username alone and gives it the tenant of the tusers rows of that UserName (tuserstrikesMapping):
// the one tenant they share, else the umbrella. An applied account change that adds or removes such a row moves the strike there.
import { DEFAULT_UMBRELLA_SITE_ID, type AppliedChange, type WriteContext } from '@opt2/platform/migration-kit';
import { registeredTenants, tenantIdForSite, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import type { IdentityRepository } from '../repo/repository.js';
import { GROUP_ACCOUNT, USER_ACCOUNT, USER_STRIKE, type UserStrikeRow } from '../repo/tables.js';

/** The database and repository strike re-homing reads and writes through. */
export interface StrikeTenancyDeps {
  db: TenantDb;
  repository: IdentityRepository;
}

/** Account columns whose change can add a row to, or remove it from, the parents of a strike. */
const PARENT_COLUMNS = ['username', 'siteid', 'opt2_state'] as const;

interface HeldStrike {
  tenantId: string;
  row: UserStrikeRow;
}

/** Usernames whose strike parents `change` may alter: both images' names, unless an update leaves every parent column as it was. */
function usernamesOf(change: AppliedChange): string[] {
  const { before, after } = change;
  if (change.op === 'update' && PARENT_COLUMNS.every((column) => before?.[column] === after?.[column])) return [];
  return [...new Set([before?.username, after?.username].filter((name): name is string => typeof name === 'string'))];
}

/** Runs `fn` in the apply transaction for its own tenant, otherwise in a transaction of `tenantId`. */
function inTenant<T>(deps: StrikeTenancyDeps, tx: TenantTx, tenantId: string, fn: (scoped: TenantTx) => Promise<T>): Promise<T> {
  return tenantId === tx.tenantId ? fn(tx) : withTenant(deps.db, tenantId, fn);
}

/** The most recently attempted of `strikes`; a NULL attempt sorts lowest, as SQL Server sorts it. */
function latest(strikes: readonly HeldStrike[]): UserStrikeRow {
  const time = ({ row }: HeldStrike): number => row.lastattempt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return strikes.reduce((best, held) => (time(held) > time(best) ? held : best)).row;
}

/**
 * Moves the strike of `username` to the tenant legacy gives it. A copy is durable before any other tenant loses its row: one
 * committed elsewhere before the apply deletes its own, or one written by the apply before commit callbacks delete the others.
 */
async function rehomeStrike(deps: StrikeTenancyDeps, tx: TenantTx, username: string, write: WriteContext): Promise<void> {
  const { repository } = deps;
  const umbrella = tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID);
  const tenants = [...new Set([tx.tenantId, umbrella, ...(await registeredTenants(tx)).map(({ tenantId }) => tenantId)])];
  const held: HeldStrike[] = [];
  for (const tenantId of tenants) {
    const row = await inTenant(deps, tx, tenantId, (scoped) => repository.lockStrikeRow(scoped, username, write));
    if (row !== null) held.push({ tenantId, row });
  }
  if (held.length === 0) return;
  const parents: string[] = [];
  for (const tenantId of tenants) {
    if (await inTenant(deps, tx, tenantId, (scoped) => repository.hasUsernameOwner(scoped, username, write))) parents.push(tenantId);
  }
  const home = parents.length === 1 ? (parents[0] as string) : umbrella;
  const strays = held.filter(({ tenantId }) => tenantId !== home);
  if (strays.length === 0) return;
  if (!held.some(({ tenantId }) => tenantId === home)) {
    const { username: name, strikes, lastattempt } = latest(strays);
    await inTenant(deps, tx, home, (scoped) => repository.base.insert(scoped, USER_STRIKE.table, { username: name, strikes, lastattempt }, write));
  }
  for (const { tenantId, row } of strays) {
    const remove = async (scoped: TenantTx): Promise<void> => {
      await repository.base.delete(scoped, USER_STRIKE.table, { username: row.username }, write);
    };
    if (tenantId === tx.tenantId) await remove(tx);
    else if (home === tx.tenantId) tx.onCommit(() => withTenant(deps.db, tenantId, remove));
    else await withTenant(deps.db, tenantId, remove);
  }
}

/** Re-homes, in the apply's write context, each strike whose parent accounts or groups the applied `change` altered. */
export async function rehomeStrikes(deps: StrikeTenancyDeps, tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
  if (change.unit !== USER_ACCOUNT.unit && change.unit !== GROUP_ACCOUNT.unit) return;
  for (const username of usernamesOf(change)) await rehomeStrike(deps, tx, username, write);
}
