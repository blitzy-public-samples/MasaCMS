// Unit tests for the file-store manifest diff the change feed uses: key order and snapshot-to-snapshot classification.
import { createHash } from 'node:crypto';

import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { describe, expect, it, vi } from 'vitest';

import { compareManifestKeys, diffSnapshotManifests, type DiffManifestOptions } from '../../src/files/feed.js';
import type { ManifestEntry, ManifestKey } from '../../src/files/manifest.js';
import type { StoredVariant } from '../../src/files/names.js';

const FID_A = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_B = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_C = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_D = 'D1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FID_E = 'E1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Manifest entry of `<siteId>/cache/file/<name>` in snapshot `snapshotSeq`; `changes` overrides the compared fields. */
function entry(
  snapshotSeq: number,
  siteId: string,
  name: string,
  changes: Partial<Pick<ManifestEntry, 'size' | 'sha256' | 'orphan'>> = {},
): ManifestEntry {
  const dot = name.lastIndexOf('.');
  return {
    snapshotSeq,
    siteId,
    path: `${siteId}/cache/file/${name}`,
    name,
    fileId: name.slice(0, 35),
    variant: name.slice(35, dot) as StoredVariant,
    ext: name.slice(dot + 1),
    size: 100,
    sha256: sha(name),
    orphan: false,
    ...changes,
  };
}

const k = (siteId: string, path: string): ManifestKey => ({ siteId, path });

const keyOf = ({ siteId, path }: ManifestEntry): ManifestKey => k(siteId, path);

/** Reader over in-memory manifests keyed by snapshot sequence. */
function readerOf(manifests: Record<number, ManifestEntry[]>) {
  return vi.fn((snapshotSeq: number) => Promise.resolve(manifests[snapshotSeq] ?? []));
}

/** Migration pool that fails every use, for diffs whose manifests come from `opts.read`. */
const unusedDb = {
  schema: 'migration',
  withTenant: () => Promise.reject(new Error('the manifest diff never runs in a tenant transaction')),
  withMetadata: () => Promise.reject(new Error('the migration database must not be read when opts.read is given')),
  end: () => Promise.resolve(),
} as unknown as TenantDb;

/** Migration pool answering readManifest with each snapshot's `migration.file_manifest` rows, as `pg` returns them. */
function manifestDb(manifests: Record<number, ManifestEntry[]>) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = {
    schema: 'migration',
    kind: 'metadata',
    query: (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      const rows = (manifests[values[0] as number] ?? []).map((found) => ({
        site_id: found.siteId,
        path: found.path,
        file_id: found.fileId,
        variant: found.variant,
        ext: found.ext,
        size: String(found.size),
        sha256: found.sha256,
        orphan: found.orphan,
      }));
      return Promise.resolve({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
    },
  } as unknown as MetadataTx;
  const db = {
    schema: 'migration',
    withTenant: () => Promise.reject(new Error('the manifest diff never runs in a tenant transaction')),
    withMetadata: <T>(fn: (metadata: MetadataTx) => Promise<T>): Promise<T> => fn(tx),
    end: () => Promise.resolve(),
  } as unknown as TenantDb;
  return { db, queries };
}

describe('compareManifestKeys', () => {
  it.each<[string, ManifestKey, ManifestKey]>([
    ['the site id before the path', k('a', 'a/cache/file/z.jpg'), k('a-b', 'a-b/cache/file/a.jpg')],
    ['the path within one site', k('default', `default/cache/file/${FID_A}.jpg`), k('default', `default/cache/file/${FID_A}_small.jpg`)],
    ['bytes, so upper case before lower case', k('Default', 'Default/cache/file/x.jpg'), k('default', 'default/cache/file/x.jpg')],
    ['bytes, so a prefix before its extensions', k('tenant', 'tenant/cache/file/x.jpg'), k('tenant-a', 'tenant-a/cache/file/x.jpg')],
    ['UTF-8 bytes, so U+FF5E before U+1F600 unlike UTF-16 code units', k('s', 's/cache/file/\uFF5E'), k('s', 's/cache/file/\u{1F600}')],
  ])('orders by %s', (_rule, first, second) => {
    expect(compareManifestKeys(first, second)).toBeLessThan(0);
    expect(compareManifestKeys(second, first)).toBeGreaterThan(0);
  });

  it('ties keys with equal site id and path whatever the other entry fields hold', () => {
    const before = entry(4, 'default', `${FID_A}.jpg`);
    const after = entry(5, 'default', `${FID_A}.jpg`, { size: 7, sha256: sha('other'), orphan: true });

    expect(compareManifestKeys(before, after)).toBe(0);
    expect(compareManifestKeys(after, before)).toBe(0);
    expect(compareManifestKeys(k('default', 'default/cache/file/x'), k('default', 'default/cache/file/x'))).toBe(0);
  });

  it('sorts keys as PostgreSQL orders site_id then path under COLLATE "C"', () => {
    const keys = [
      k('tenant-a', `tenant-a/cache/file/${FID_D}.png`),
      k('default', `default/cache/file/${FID_A}_small.jpg`),
      k('a-b', 'a-b/cache/file/a.jpg'),
      k('Default', `Default/cache/file/${FID_B}.pdf`),
      k('default', `default/cache/file/${FID_A}.jpg`),
      k('a', 'a/cache/file/z.jpg'),
    ];

    expect(keys.toSorted(compareManifestKeys).map((found) => found.path)).toEqual([
      `Default/cache/file/${FID_B}.pdf`,
      'a/cache/file/z.jpg',
      'a-b/cache/file/a.jpg',
      `default/cache/file/${FID_A}.jpg`,
      `default/cache/file/${FID_A}_small.jpg`,
      `tenant-a/cache/file/${FID_D}.png`,
    ]);
  });
});

describe('diffSnapshotManifests', () => {
  it('classifies added, removed, changed and unchanged objects and lists the keys to transfer in snapshot-to order', async () => {
    const keptBefore = entry(4, 'default', `${FID_A}.jpg`);
    const rehashedBefore = entry(4, 'default', `${FID_A}_small.jpg`);
    const resizedBefore = entry(4, 'default', `${FID_B}.pdf`);
    const adoptedBefore = entry(4, 'default', `${FID_C}.png`, { orphan: true });
    const deleted = entry(4, 'tenant-a', `${FID_D}.png`);
    const keptAfter = entry(5, 'default', `${FID_A}.jpg`);
    const rendition = entry(5, 'default', `${FID_A}_medium.jpg`);
    const rehashedAfter = entry(5, 'default', `${FID_A}_small.jpg`, { sha256: sha('re-uploaded') });
    const resizedAfter = entry(5, 'default', `${FID_B}.pdf`, { size: 101 });
    const adoptedAfter = entry(5, 'default', `${FID_C}.png`);
    const uploaded = entry(5, 'tenant-b', `${FID_E}.png`);
    const read = readerOf({
      4: [keptBefore, rehashedBefore, resizedBefore, adoptedBefore, deleted],
      5: [keptAfter, rendition, rehashedAfter, resizedAfter, adoptedAfter, uploaded],
    });

    const diff = await diffSnapshotManifests({ db: unusedDb }, 4, 5, { read });

    expect(diff).toEqual({
      from: 4,
      to: 5,
      added: [rendition, uploaded],
      changed: [
        { before: rehashedBefore, after: rehashedAfter },
        { before: resizedBefore, after: resizedAfter },
        { before: adoptedBefore, after: adoptedAfter },
      ],
      removed: [deleted],
      unchanged: 1,
      toTransfer: [rendition, rehashedAfter, resizedAfter, adoptedAfter, uploaded].map(keyOf),
    });
    expect(read.mock.calls).toEqual([[4], [5]]);
  });

  it('gives the same diff whatever order the reader returns, and leaves the read arrays as read', async () => {
    const before = [entry(4, 'tenant-a', `${FID_D}.png`), entry(4, 'default', `${FID_B}.pdf`), entry(4, 'default', `${FID_A}.jpg`)];
    const after = [
      entry(5, 'tenant-b', `${FID_E}.png`),
      entry(5, 'default', `${FID_B}.pdf`, { sha256: sha('edited') }),
      entry(5, 'default', `${FID_A}.jpg`),
      entry(5, 'Default', `${FID_C}.png`),
    ];
    const readOrder = { before: [...before], after: [...after] };

    const shuffled = await diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: readerOf({ 4: before, 5: after }) });
    const sorted = await diffSnapshotManifests({ db: unusedDb }, 4, 5, {
      read: readerOf({ 4: before.toSorted(compareManifestKeys), 5: after.toSorted(compareManifestKeys) }),
    });

    expect(shuffled).toEqual(sorted);
    expect(shuffled.toTransfer).toEqual([
      k('Default', `Default/cache/file/${FID_C}.png`),
      k('default', `default/cache/file/${FID_B}.pdf`),
      k('tenant-b', `tenant-b/cache/file/${FID_E}.png`),
    ]);
    expect(shuffled.removed).toEqual([before[0]]);
    expect(shuffled.unchanged).toBe(1);
    expect(before).toEqual(readOrder.before);
    expect(after).toEqual(readOrder.after);
  });

  it('counts an object with equal sha256, size and orphan flag as unchanged although its snapshot differs', async () => {
    const kept = [entry(4, 'default', `${FID_A}.jpg`, { size: 0 }), entry(4, 'default', `${FID_B}.pdf`, { orphan: true })];
    const again = kept.map((found) => ({ ...found, snapshotSeq: 9 }));

    const diff = await diffSnapshotManifests({ db: unusedDb }, 4, 9, { read: readerOf({ 4: kept, 9: again }) });

    expect(diff).toEqual({ from: 4, to: 9, added: [], changed: [], removed: [], unchanged: 2, toTransfer: [] });
  });

  it.each<[string, ManifestEntry[], ManifestEntry[], ManifestEntry[], ManifestEntry[]]>([
    ['both manifests are empty', [], [], [], []],
    [
      'the earlier manifest is empty',
      [],
      [entry(5, 'tenant-a', `${FID_D}.png`), entry(5, 'default', `${FID_A}.jpg`)],
      [entry(5, 'default', `${FID_A}.jpg`), entry(5, 'tenant-a', `${FID_D}.png`)],
      [],
    ],
    [
      'the later manifest is empty',
      [entry(4, 'tenant-a', `${FID_D}.png`), entry(4, 'default', `${FID_A}.jpg`)],
      [],
      [],
      [entry(4, 'default', `${FID_A}.jpg`), entry(4, 'tenant-a', `${FID_D}.png`)],
    ],
  ])('adds every later object and removes every earlier one when %s', async (_case, before, after, added, removed) => {
    const diff = await diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: readerOf({ 4: before, 5: after }) });

    expect(diff).toEqual({ from: 4, to: 5, added, changed: [], removed, unchanged: 0, toTransfer: added.map(keyOf) });
  });

  it.each<[string, [] | [DiffManifestOptions]]>([
    ['omitted', []],
    ['an object without read', [{}]],
  ])('reads both manifests from migration.file_manifest when opts is %s', async (_case, opts) => {
    const before = [entry(4, 'default', `${FID_A}.jpg`, { size: 3_000_000_000 }), entry(4, 'default', `${FID_B}.pdf`)];
    const after = [entry(5, 'default', `${FID_A}.jpg`, { size: 3_000_000_000 }), entry(5, 'default', `${FID_C}.png`, { orphan: true })];
    const { db, queries } = manifestDb({ 4: before, 5: after });

    const diff = await diffSnapshotManifests({ db }, 4, 5, ...opts);

    expect(diff).toEqual({
      from: 4,
      to: 5,
      added: [after[1]],
      changed: [],
      removed: [before[1]],
      unchanged: 1,
      toTransfer: [k('default', `default/cache/file/${FID_C}.png`)],
    });
    expect(queries.map((query) => query.values)).toEqual([[4], [5]]);
    for (const query of queries) expect(query.sql).toMatch(/FROM migration\.file_manifest WHERE snapshot_seq = \$1/);
  });

  it('rejects with the reader error when a manifest cannot be read', async () => {
    const failure = new Error('snapshot 5 has no manifest');
    const read = vi.fn((snapshotSeq: number) => (snapshotSeq === 5 ? Promise.reject(failure) : Promise.resolve([])));

    await expect(diffSnapshotManifests({ db: unusedDb }, 4, 5, { read })).rejects.toBe(failure);
  });
});
