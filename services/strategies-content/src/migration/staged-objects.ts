/** Durable recovery of content-files publications. */
import { cfUuid, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { BucketName, ObjectHead } from '@opt2/platform/storage';
import { registeredTenants, type TenantTx } from '@opt2/platform/tenancy';
import {
  claimStagedObject,
  deleteStagedObject,
  insertStagedObject,
  listStaleStagedObjects,
  lockFileObjectKey,
  tryLockFileObjectKey,
  type StagedObjectCursor,
  type StagedObjectEntry,
} from '../repo/files.js';
import type { StoreObjectDeps } from './objects.js';

/** The bucket of legacy file-store objects, written only by strategies-content. */
export const CONTENT_FILES_BUCKET = 'content-files' satisfies BucketName;

export const STAGED_OBJECT_GRACE_MS = 60_000;
const RECOVERY_PAGE_SIZE = 100;

/** Key of the copy of the version an intent replaces; outside the object key grammar, so no route reads it. */
export function stagedBackupKey(entry: Pick<StagedObjectEntry, 'tenant_id' | 'stage_id'>): string {
  return `${entry.tenant_id.toLowerCase()}/.staged/${entry.stage_id}`;
}

/** An intent was settled before its publisher could claim it. */
export class StagedObjectMissingError extends Error {
  override readonly name = 'StagedObjectMissingError';
  constructor(stageId: string) {
    super(`Staged object ${stageId} is no longer available`);
  }
}

/** The manifest cannot attest to unsettled object bytes. */
export class StagedObjectsPendingError extends LegacyServiceUnavailableError {
  override readonly name = 'StagedObjectsPendingError';
  constructor() {
    super('Content object recovery is pending', 'auto', 'content-object-recovery-pending');
  }
}

/** Commits the intent before publication starts. */
export async function stageObject(deps: StoreObjectDeps, values: Omit<StagedObjectEntry, 'stage_id' | 'state'>): Promise<StagedObjectEntry> {
  const entry: StagedObjectEntry = { ...values, stage_id: cfUuid(), state: 'staged' };
  await deps.db.withTenant(entry.tenant_id, (tx) => insertStagedObject(tx, entry));
  return entry;
}

/** Whether `head` holds the bytes `value` records. */
function holds(head: ObjectHead | null, value: { sha256: string; size: number | string }): head is ObjectHead {
  return head !== null && head.sha256 === value.sha256 && head.size === Number(value.size);
}

/**
 * Settles an intent under its key lock without writing manifest rows: deletes bytes no committed row names and restores a
 * replaced version from its backup. False leaves the intent when the bytes match neither the row nor a backup of it.
 */
async function settleLocked(deps: StoreObjectDeps, tx: TenantTx, entry: StagedObjectEntry): Promise<boolean> {
  const backupKey = stagedBackupKey(entry);
  if (entry.state === 'committed') {
    await deps.storage.delete(CONTENT_FILES_BUCKET, backupKey);
  } else if (entry.kind === 'upload') {
    const row = await deps.repository.files.findFileObjectBySha(tx, entry.object_key);
    if (row === null) await deps.storage.delete(CONTENT_FILES_BUCKET, entry.object_key);
  } else {
    const row = await deps.repository.files.findFileObjectBySha(tx, entry.object_key);
    const head = await deps.storage.head(CONTENT_FILES_BUCKET, entry.object_key);
    const backup = await deps.storage.head(CONTENT_FILES_BUCKET, backupKey);
    if (row === null) {
      if (head !== null) await deps.storage.delete(CONTENT_FILES_BUCKET, entry.object_key);
    } else if (!holds(head, row)) {
      if (!holds(backup, row)) return false;
      const restored = await deps.storage.get(CONTENT_FILES_BUCKET, backupKey);
      await deps.storage.put(CONTENT_FILES_BUCKET, entry.object_key, restored, { contentType: backup.contentType });
    }
    if (backup !== null) await deps.storage.delete(CONTENT_FILES_BUCKET, backupKey);
  }
  await deleteStagedObject(tx, entry.stage_id);
  return true;
}

/** Settles one publisher's intent under the key lock, as its stored state records it. */
export async function settleStagedObject(deps: StoreObjectDeps, entry: StagedObjectEntry): Promise<void> {
  await deps.db.withTenant(entry.tenant_id, async (tx) => {
    await lockFileObjectKey(tx, entry.object_key);
    const claimed = await claimStagedObject(tx, entry.stage_id);
    if (claimed !== null) await settleLocked(deps, tx, claimed);
  });
}

/** Recovers stale intents without waiting for live publications; returns the number settled. */
export async function recoverStagedObjects(deps: StoreObjectDeps, tenantId: string, graceMs = STAGED_OBJECT_GRACE_MS): Promise<number> {
  let count = 0;
  let after: StagedObjectCursor | undefined;
  for (;;) {
    const page = await deps.db.withTenant(tenantId, async (tx) => {
      const entries = await listStaleStagedObjects(tx, graceMs, RECOVERY_PAGE_SIZE, after);
      let settled = 0;
      for (const entry of entries) {
        if (await tryLockFileObjectKey(tx, entry.object_key) && await settleLocked(deps, tx, entry)) settled += 1;
      }
      return { last: entries.at(-1), settled };
    });
    count += page.settled;
    if (page.last === undefined) return count;
    after = page.last;
  }
}

/** Recovers registered tenants before accepting requests. */
export async function recoverAllStagedObjects(deps: StoreObjectDeps): Promise<void> {
  for (const { tenantId } of await registeredTenants(deps.db)) await recoverStagedObjects(deps, tenantId);
}
