// Diff of two snapshots' file-store manifests: the objects the change feed must transfer.
import { Buffer } from 'node:buffer';

import { readManifest, type FilesContext, type ManifestEntry, type ManifestKey } from './manifest.js';

/** Options of diffSnapshotManifests; `read` replaces the readManifest call for a snapshot. */
export interface DiffManifestOptions {
  read?: (snapshotSeq: number) => Promise<ManifestEntry[]>;
}

/** Differences from snapshot `from` to snapshot `to`; every list follows compareManifestKeys order. */
export interface ManifestDiff {
  from: number;
  to: number;
  added: ManifestEntry[];
  changed: Array<{ before: ManifestEntry; after: ManifestEntry }>;
  removed: ManifestEntry[];
  unchanged: number;
  /** Keys of `added` and `changed[].after`, in `to` order, to be read from snapshot `to`. */
  toTransfer: ManifestKey[];
}

/** Orders keys by the UTF-8 bytes of `siteId`, then of `path`: PostgreSQL `COLLATE "C"`, as readManifest sorts. */
export function compareManifestKeys(a: ManifestKey, b: ManifestKey): number {
  return (
    Buffer.compare(Buffer.from(a.siteId, 'utf8'), Buffer.from(b.siteId, 'utf8')) ||
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'))
  );
}

// An orphan gaining or losing its `tfiles` row can change tenant prefix, so a flipped `orphan` is a change.
function differs(before: ManifestEntry, after: ManifestEntry): boolean {
  return before.sha256 !== after.sha256 || before.size !== after.size || before.orphan !== after.orphan;
}

function keyOf(entry: ManifestEntry): ManifestKey {
  return { siteId: entry.siteId, path: entry.path };
}

/**
 * Merges the manifests of snapshots `n` and `n1` by key; a key in both is `changed` when its sha256, size or orphan
 * flag differs. Both manifests are re-sorted, so the result does not depend on the reader's order.
 */
export async function diffSnapshotManifests(
  ctx: Pick<FilesContext, 'db'>,
  n: number,
  n1: number,
  opts: DiffManifestOptions = {},
): Promise<ManifestDiff> {
  const read = opts.read ?? ((snapshotSeq: number) => readManifest(ctx, snapshotSeq));
  const [fromEntries, toEntries] = await Promise.all([read(n), read(n1)]);
  const before = fromEntries.toSorted(compareManifestKeys);
  const after = toEntries.toSorted(compareManifestKeys);

  const diff: ManifestDiff = { from: n, to: n1, added: [], changed: [], removed: [], unchanged: 0, toTransfer: [] };
  let i = 0;
  let j = 0;
  let old = before[i];
  let current = after[j];
  while (old !== undefined && current !== undefined) {
    const order = compareManifestKeys(old, current);
    if (order < 0) {
      diff.removed.push(old);
      i += 1;
      old = before[i];
    } else if (order > 0) {
      diff.added.push(current);
      diff.toTransfer.push(keyOf(current));
      j += 1;
      current = after[j];
    } else {
      if (differs(old, current)) {
        diff.changed.push({ before: old, after: current });
        diff.toTransfer.push(keyOf(current));
      } else {
        diff.unchanged += 1;
      }
      i += 1;
      j += 1;
      old = before[i];
      current = after[j];
    }
  }
  for (const entry of before.slice(i)) diff.removed.push(entry);
  for (const entry of after.slice(j)) {
    diff.added.push(entry);
    diff.toTransfer.push(keyOf(entry));
  }
  return diff;
}
