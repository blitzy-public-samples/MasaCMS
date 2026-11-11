// Unit tests for the file-store manifest diff the change feed uses: key order and snapshot-to-snapshot classification.
import { createHash } from 'node:crypto';

import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import { describe, expect, it, vi } from 'vitest';

import {
  compareManifestKeys,
  diffSnapshotManifests,
  streamManifestDiff,
  type DiffManifestOptions,
  type ManifestDifference,
} from '../../src/files/feed.js';
import { streamManifest, type ManifestEntry, type ManifestKey } from '../../src/files/manifest.js';
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

/** Async iterable over `entries` that records how far it was read and whether it was closed. */
function sourceOf(entries: readonly ManifestEntry[], failure?: Error) {
  const state = { read: 0, closed: false };
  async function* iterate(): AsyncGenerator<ManifestEntry, void, undefined> {
    try {
      for (const found of entries) {
        await Promise.resolve();
        state.read += 1;
        yield found;
      }
      if (failure !== undefined) throw failure;
    } finally {
      state.closed = true;
    }
  }
  return { entries: iterate(), state };
}

/** Reader over in-memory manifests keyed by snapshot sequence. */
function readerOf(manifests: Record<number, ManifestEntry[]>) {
  return vi.fn((snapshotSeq: number) => sourceOf(manifests[snapshotSeq] ?? []).entries);
}

/** Migration pool that fails every use, for diffs whose manifests come from `opts.read`. */
const unusedDb = {
  schema: 'migration',
  withTenant: () => Promise.reject(new Error('the manifest diff never runs in a tenant transaction')),
  withMetadata: () => Promise.reject(new Error('the migration database must not be read when opts.read is given')),
  end: () => Promise.resolve(),
} as unknown as TenantDb;

/** Migration pool answering manifest page reads with each snapshot's `migration.file_manifest` rows, as `pg` returns them. */
function manifestDb(manifests: Record<number, ManifestEntry[]>) {
  const queries: { sql: string; values: unknown[]; returned: number }[] = [];
  const tx = {
    schema: 'migration',
    kind: 'metadata',
    query: (sql: string, values: unknown[]) => {
      const after = sql.includes(') > ($2, $3)') ? k(values[1] as string, values[2] as string) : undefined;
      const limit = values[after === undefined ? 1 : 3] as number;
      const rows = (manifests[values[0] as number] ?? [])
        .toSorted(compareManifestKeys)
        .filter((found) => after === undefined || compareManifestKeys(found, after) > 0)
        .slice(0, limit)
        .map((found) => ({
          site_id: found.siteId,
          path: found.path,
          file_id: found.fileId,
          variant: found.variant,
          ext: found.ext,
          size: String(found.size),
          sha256: found.sha256,
          orphan: found.orphan,
        }));
      queries.push({ sql, values, returned: rows.length });
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

  it.each<[string, ManifestEntry[], ManifestEntry[], string]>([
    [
      'the earlier manifest lists a key before its predecessor',
      [entry(4, 'default', `${FID_A}.jpg`), entry(4, 'tenant-a', `${FID_D}.png`), entry(4, 'default', `${FID_B}.pdf`)],
      [entry(5, 'default', `${FID_A}.jpg`), entry(5, 'tenant-b', `${FID_E}.png`)],
      `manifest of snapshot 4 is not in key order: "default/cache/file/${FID_B}.pdf" of site "default" follows ` +
        `"tenant-a/cache/file/${FID_D}.png" of site "tenant-a"`,
    ],
    [
      'the later manifest sorts site ids case-insensitively',
      [],
      [entry(5, 'default', `${FID_A}.jpg`), entry(5, 'Default', `${FID_C}.png`)],
      `manifest of snapshot 5 is not in key order: "Default/cache/file/${FID_C}.png" of site "Default" follows ` +
        `"default/cache/file/${FID_A}.jpg" of site "default"`,
    ],
    [
      'a manifest repeats a key',
      [entry(4, 'default', `${FID_A}.jpg`)],
      [entry(5, 'default', `${FID_A}.jpg`), entry(5, 'default', `${FID_A}.jpg`, { size: 1 })],
      `manifest of snapshot 5 is not in key order: "default/cache/file/${FID_A}.jpg" of site "default" follows ` +
        `"default/cache/file/${FID_A}.jpg" of site "default"`,
    ],
  ])('rejects instead of re-sorting when %s, and closes both readers', async (_case, before, after, message) => {
    const sources = { 4: sourceOf(before), 5: sourceOf(after) };

    const diff = diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: (snapshotSeq) => sources[snapshotSeq as 4 | 5].entries });

    await expect(diff).rejects.toThrow(new Error(message));
    expect([sources[4].state.closed, sources[5].state.closed]).toEqual([true, true]);
  });

  it('counts an object with equal sha256, size and orphan flag as unchanged although its snapshot differs', async () => {
    const kept = [entry(4, 'default', `${FID_A}.jpg`, { size: 0 }), entry(4, 'default', `${FID_B}.pdf`, { orphan: true })];
    const again = kept.map((found) => ({ ...found, snapshotSeq: 9 }));

    const diff = await diffSnapshotManifests({ db: unusedDb }, 4, 9, { read: readerOf({ 4: kept, 9: again }) });

    expect(diff).toEqual({ from: 4, to: 9, added: [], changed: [], removed: [], unchanged: 2, toTransfer: [] });
  });

  it.each<[string, ManifestEntry[], ManifestEntry[]]>([
    ['both manifests are empty', [], []],
    ['the earlier manifest is empty', [], [entry(5, 'default', `${FID_A}.jpg`), entry(5, 'tenant-a', `${FID_D}.png`)]],
    ['the later manifest is empty', [entry(4, 'default', `${FID_A}.jpg`), entry(4, 'tenant-a', `${FID_D}.png`)], []],
  ])('adds every later object and removes every earlier one when %s', async (_case, before, after) => {
    const diff = await diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: readerOf({ 4: before, 5: after }) });

    expect(diff).toEqual({ from: 4, to: 5, added: after, changed: [], removed: before, unchanged: 0, toTransfer: after.map(keyOf) });
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
    expect(queries.map((query) => query.values)).toEqual([
      [4, 1000],
      [5, 1000],
    ]);
    for (const query of queries) expect(query.sql).toMatch(/FROM migration\.file_manifest WHERE snapshot_seq = \$1/);
  });

  it.each([1, 2, 3, 7])('gives the same diff when both manifests are read in keyset pages of %i entries', async (pageRows) => {
    const names = (fileIds: string[]) => fileIds.flatMap((id) => [`${id}.jpg`, `${id}_small.jpg`]);
    const before = [
      ...names([FID_A, FID_B, FID_C]).map((name) => entry(4, 'default', name)),
      ...names([FID_D]).map((name) => entry(4, 'tenant-a', name)),
    ];
    const after = [
      entry(5, 'Default', `${FID_E}.png`),
      ...names([FID_A, FID_C]).map((name) => entry(5, 'default', name, name.startsWith(FID_C) ? { size: 7 } : {})),
      ...names([FID_D, FID_E]).map((name) => entry(5, 'tenant-a', name)),
    ];
    const { db, queries } = manifestDb({ 4: before, 5: after });
    const expected = await diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: readerOf({ 4: before, 5: after }) });

    const diff = await diffSnapshotManifests({ db }, 4, 5, { read: (snapshotSeq) => streamManifest({ db }, snapshotSeq, { pageRows }) });

    expect(diff).toEqual(expected);
    expect(diff).toMatchObject({ unchanged: 4, removed: before.slice(2, 4), toTransfer: after.filter((_found, index) => [0, 3, 4, 7, 8].includes(index)).map(keyOf) });
    expect(Math.max(...queries.map((query) => query.returned))).toBeLessThanOrEqual(pageRows);
    expect(queries.filter((query) => query.values[0] === 4)).toHaveLength(Math.floor(before.length / pageRows) + 1);
    expect(queries.filter((query) => query.values[0] === 5)).toHaveLength(Math.floor(after.length / pageRows) + 1);
  });

  it('rejects with the reader error when a manifest cannot be read, and closes the other reader', async () => {
    const failure = new Error('snapshot 5 has no manifest');
    const sources = { 4: sourceOf([entry(4, 'default', `${FID_A}.jpg`), entry(4, 'default', `${FID_B}.pdf`)]), 5: sourceOf([], failure) };

    const diff = diffSnapshotManifests({ db: unusedDb }, 4, 5, { read: (snapshotSeq) => sources[snapshotSeq as 4 | 5].entries });

    await expect(diff).rejects.toBe(failure);
    expect(sources[4].state).toEqual({ read: 1, closed: true });
  });
});

describe('streamManifestDiff', () => {
  it('yields one difference per key in key order, unchanged keys included', async () => {
    const kept = [entry(4, 'default', `${FID_A}.jpg`), entry(5, 'default', `${FID_A}.jpg`)] as const;
    const edited = [entry(4, 'default', `${FID_B}.pdf`), entry(5, 'default', `${FID_B}.pdf`, { sha256: sha('edited') })] as const;
    const removed = entry(4, 'default', `${FID_C}.png`);
    const added = entry(5, 'tenant-a', `${FID_D}.png`);

    const differences: ManifestDifference[] = [];
    for await (const difference of streamManifestDiff(sourceOf([kept[0], edited[0], removed]).entries, sourceOf([kept[1], edited[1], added]).entries)) {
      differences.push(difference);
    }

    expect(differences).toEqual([
      { kind: 'unchanged', before: kept[0], after: kept[1] },
      { kind: 'changed', before: edited[0], after: edited[1] },
      { kind: 'removed', before: removed },
      { kind: 'added', after: added },
    ]);
  });

  it('reads one entry ahead on each side and closes both manifests when the consumer stops early', async () => {
    const from = sourceOf([FID_A, FID_B, FID_C].map((id) => entry(4, 'default', `${id}.jpg`)));
    const to = sourceOf([FID_B, FID_C, FID_D].map((id) => entry(5, 'default', `${id}.jpg`)));

    const first: ManifestDifference[] = [];
    for await (const difference of streamManifestDiff(from.entries, to.entries)) {
      first.push(difference);
      break;
    }

    expect(first).toMatchObject([{ kind: 'removed', before: { path: `default/cache/file/${FID_A}.jpg` } }]);
    expect([from.state, to.state]).toEqual([
      { read: 1, closed: true },
      { read: 1, closed: true },
    ]);
  });
});
