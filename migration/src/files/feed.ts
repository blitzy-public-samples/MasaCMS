// Diff of two snapshots' file-store manifests: the objects the change feed must transfer.
import { Buffer } from 'node:buffer';

import { streamManifest, type FilesContext, type ManifestEntry, type ManifestKey } from './manifest.js';

/** Options of diffSnapshotManifests; `read` replaces streamManifest for a snapshot and must yield in compareManifestKeys order. */
export interface DiffManifestOptions {
  read?: (snapshotSeq: number) => AsyncIterable<ManifestEntry>;
}

/** One key of a manifest diff; `unchanged` keys have equal sha256, size and orphan flag. */
export type ManifestDifference =
  | { kind: 'added'; after: ManifestEntry }
  | { kind: 'removed'; before: ManifestEntry }
  | { kind: 'changed'; before: ManifestEntry; after: ManifestEntry }
  | { kind: 'unchanged'; before: ManifestEntry; after: ManifestEntry };

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

/** Yields `entries`, throwing as soon as a key does not follow its predecessor in compareManifestKeys order. */
async function* inKeyOrder(entries: AsyncIterable<ManifestEntry>): AsyncGenerator<ManifestEntry, void, undefined> {
  let previous: ManifestEntry | undefined;
  for await (const entry of entries) {
    if (previous !== undefined && compareManifestKeys(previous, entry) >= 0) {
      throw new Error(
        `manifest of snapshot ${String(entry.snapshotSeq)} is not in key order: ${JSON.stringify(entry.path)} of site ` +
          `${JSON.stringify(entry.siteId)} follows ${JSON.stringify(previous.path)} of site ${JSON.stringify(previous.siteId)}`,
      );
    }
    previous = entry;
    yield entry;
  }
}

/** Next value of `iterator`, or undefined once it is done. */
async function pull(iterator: AsyncIterator<ManifestEntry, void>): Promise<ManifestEntry | undefined> {
  const next = await iterator.next();
  return next.done ? undefined : next.value;
}

/**
 * Merges two manifests in compareManifestKeys order, holding one entry of each, and yields one difference per key.
 * @throws Error when either manifest is out of key order or repeats a key.
 */
export async function* streamManifestDiff(
  from: AsyncIterable<ManifestEntry>,
  to: AsyncIterable<ManifestEntry>,
): AsyncGenerator<ManifestDifference, void, undefined> {
  const before = inKeyOrder(from);
  const after = inKeyOrder(to);
  try {
    let old = await pull(before);
    let current = await pull(after);
    while (old !== undefined && current !== undefined) {
      const order = compareManifestKeys(old, current);
      if (order < 0) {
        yield { kind: 'removed', before: old };
        old = await pull(before);
      } else if (order > 0) {
        yield { kind: 'added', after: current };
        current = await pull(after);
      } else {
        yield { kind: differs(old, current) ? 'changed' : 'unchanged', before: old, after: current };
        old = await pull(before);
        current = await pull(after);
      }
    }
    for (; old !== undefined; old = await pull(before)) yield { kind: 'removed', before: old };
    for (; current !== undefined; current = await pull(after)) yield { kind: 'added', after: current };
  } finally {
    await Promise.all([before.return(), after.return()]);
  }
}

/**
 * Merges the manifests of snapshots `n` and `n1` by key, streaming both; a key in both is `changed` when its sha256,
 * size or orphan flag differs.
 * @throws Error when a manifest is not in compareManifestKeys order.
 */
export async function diffSnapshotManifests(
  ctx: Pick<FilesContext, 'db'>,
  n: number,
  n1: number,
  opts: DiffManifestOptions = {},
): Promise<ManifestDiff> {
  const read = opts.read ?? ((snapshotSeq: number) => streamManifest(ctx, snapshotSeq));
  const diff: ManifestDiff = { from: n, to: n1, added: [], changed: [], removed: [], unchanged: 0, toTransfer: [] };
  for await (const difference of streamManifestDiff(read(n), read(n1))) {
    switch (difference.kind) {
      case 'added':
        diff.added.push(difference.after);
        diff.toTransfer.push(keyOf(difference.after));
        break;
      case 'removed':
        diff.removed.push(difference.before);
        break;
      case 'changed':
        diff.changed.push({ before: difference.before, after: difference.after });
        diff.toTransfer.push(keyOf(difference.after));
        break;
      case 'unchanged':
        diff.unchanged += 1;
        break;
    }
  }
  return diff;
}
