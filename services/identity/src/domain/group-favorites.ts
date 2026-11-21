/** Owner read of identity's group favorites for people's favorites templates: `lookupGroupFavorites`. */
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { registeredTenants, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import type { IdentityRepository } from '../repo/repository.js';

/** The contract's item of one requested id that names a group favorite. */
export type GroupFavoriteListItem = components['schemas']['GroupFavoriteListItem'];

/** Dependencies of `createGroupFavoriteReads`; the gate wait defaults to 30 s. */
export interface GroupFavoriteReadsDeps {
  repo: Pick<IdentityRepository, 'matchGroupFavoriteIds'>;
  gateWaitMs?: number;
}

/** Group favorite reads for people; tenants come only from the registry, never from the caller. */
export interface GroupFavoriteReads {
  /** `lookupGroupFavorites`: the ids among `favoriteIds`, as sent and in request order, that name a group favorite of any registered tenant. */
  lookupGroupFavorites(db: TenantDb, favoriteIds: readonly string[]): Promise<GroupFavoriteListItem[]>;
}

/** Builds the group favorite reads over the injected repository. */
export function createGroupFavoriteReads(deps: GroupFavoriteReadsDeps): GroupFavoriteReads {
  const { repo } = deps;
  const gateBudget = { budgetMs: deps.gateWaitMs };

  async function lookupGroupFavorites(db: TenantDb, favoriteIds: readonly string[]): Promise<GroupFavoriteListItem[]> {
    const found = new Set<string>();
    for (const { tenantId } of await registeredTenants(db)) {
      for (const id of await withGatedTenant(db, tenantId, (tx) => repo.matchGroupFavoriteIds(tx, favoriteIds), gateBudget)) found.add(id);
    }
    return favoriteIds.filter((id) => found.has(id)).map((favoriteId) => ({ favoriteId }));
  }

  return Object.freeze({ lookupGroupFavorites });
}
