// Legacy's user delete keeps the user's addresses, interests and favorites, but rows of a deleted owner have no owner
// Type, so they leave every unit (opt2/table-ownership.json "owner Type = 2"), as a backfill of legacy would drop them.
import type { AppliedChange, WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { PeopleRepository } from '../repo/repository.js';
import { PERSON } from '../repo/tables.js';

/** Deletes, in the apply transaction, the split rows of a person a migration apply deleted. */
export async function dropOwnerlessRows(repository: PeopleRepository, tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
  if (change.unit !== PERSON.unit || change.op !== 'delete') return;
  const userId = change.before?.userid;
  if (typeof userId !== 'string') throw new Error(`Applied delete on ${change.unit} carries no userid`);
  await repository.deleteOwnerlessRows(tx, userId, write);
}
