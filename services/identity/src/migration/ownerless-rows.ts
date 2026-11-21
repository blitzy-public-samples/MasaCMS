// Legacy's group delete keeps the group's addresses, interests and favorites, but rows of a deleted owner have no owner Type, so
// they leave every unit (opt2/table-ownership.json "owner Type = 1"), as a backfill of legacy would drop them.
import type { AppliedChange, WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { IdentityRepository } from '../repo/repository.js';
import { GROUP_ACCOUNT } from '../repo/tables.js';

/** Deletes, in the apply transaction, the split rows of a group a migration apply deleted. */
export async function dropOwnerlessRows(repository: IdentityRepository, tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
  if (change.unit !== GROUP_ACCOUNT.unit || change.op !== 'delete') return;
  const groupId = change.before?.userid;
  if (typeof groupId !== 'string') throw new Error(`Applied delete on ${change.unit} carries no userid`);
  await repository.deleteOwnerlessGroupRows(tx, groupId, write);
}
