/** Merge diff of two snapshots' file-store manifests by `(siteId, path)` into added, removed and changed objects. */
import { compareManifestKeys } from '../files/index.js';
import type { ManifestEntry, ManifestKey } from '../files/index.js';

import { orderedReader } from './keyed.js';
import type { RowSource } from './keyed.js';

/** The manifest fields the diff reads: the object's key, size and SHA-256. */
export type ManifestDiffEntry = ManifestKey & Pick<ManifestEntry, 'size' | 'sha256'>;

/** One object difference between two manifests, labelled with the object's key. */
export type ManifestChange<T extends ManifestDiffEntry = ManifestEntry> =
  | { kind: 'added'; siteId: string; path: string; after: T }
  | { kind: 'removed'; siteId: string; path: string; before: T }
  | { kind: 'changed'; siteId: string; path: string; before: T; after: T };

function describe(entry: ManifestKey): string {
  return `${entry.siteId}/${entry.path}`;
}

function added<T extends ManifestDiffEntry>(after: T): ManifestChange<T> {
  return { kind: 'added', siteId: after.siteId, path: after.path, after };
}

function removed<T extends ManifestDiffEntry>(before: T): ManifestChange<T> {
  return { kind: 'removed', siteId: before.siteId, path: before.path, before };
}

/**
 * Merges two manifests, each in `compareManifestKeys` order with unique keys, into the changes that turn `before` into
 * `after`; an object in both is changed when its sha256 or size differs. Holds one entry per side and closes both
 * inputs when it ends, fails or is returned early.
 * @throws DiffOrderError when either input is out of key order or repeats a key.
 */
export async function* diffManifests<T extends ManifestDiffEntry = ManifestEntry>(
  before: RowSource<T>,
  after: RowSource<T>,
): AsyncGenerator<ManifestChange<T>> {
  const left = orderedReader<T>(before, { side: 'before', compare: compareManifestKeys, strict: true, describe });
  const right = orderedReader<T>(after, { side: 'after', compare: compareManifestKeys, strict: true, describe });
  try {
    let old = await left.next();
    let now = await right.next();
    while (old !== undefined && now !== undefined) {
      const order = compareManifestKeys(old, now);
      if (order < 0) {
        yield removed(old);
        old = await left.next();
      } else if (order > 0) {
        yield added(now);
        now = await right.next();
      } else {
        if (old.sha256 !== now.sha256 || old.size !== now.size) {
          yield { kind: 'changed', siteId: now.siteId, path: now.path, before: old, after: now };
        }
        old = await left.next();
        now = await right.next();
      }
    }
    for (; old !== undefined; old = await left.next()) yield removed(old);
    for (; now !== undefined; now = await right.next()) yield added(now);
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}
