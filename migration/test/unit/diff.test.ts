// Unit tests for the change-feed diffs: keyed merge-join, keyless multiset and file-store manifest.
import { createHash } from 'node:crypto';

import { canonicalTypeForSqlServer, compareEncodings, decodeRow, encodeKey, encodeRow } from '@opt2/platform/migration-kit';
import type { CanonicalColumn } from '@opt2/platform/migration-kit';
import { describe, expect, it, vi } from 'vitest';

import { DiffOrderError, diffKeyedStreams, diffManifests, diffMultisetStreams } from '../../src/diff/index.js';
import type { DiffSide, KeyedChange, KeyedDiffOptions, ManifestChange, MultisetChange, RowSource } from '../../src/diff/index.js';
import { compareCanonicalRows } from '../../src/extract/index.js';
import type { CanonicalRow } from '../../src/extract/index.js';
import { compareManifestKeys, diffSnapshotManifests, parseStoredName, storePath } from '../../src/files/index.js';
import type { FilesContext, ManifestEntry, ManifestKey } from '../../src/files/index.js';
import { FILE_LISTINGS, FIXTURE_FILES, TABLES, fixtureId, imageSizeRow, mailingListMemberRow, userRow } from '../helpers/fixtures.js';
import type { FixtureFile, FixtureTable, FixtureTableName } from '../helpers/fixtures.js';

type Values = Readonly<Record<string, unknown>>;

/** Canonical shape of a fixture table: qualified name, encoded columns in catalog order and primary key. */
interface TableShape {
  qualified: string;
  columns: CanonicalColumn[];
  key: readonly string[];
}

function shapeOf(name: FixtureTableName): TableShape {
  const table: FixtureTable = TABLES[name];
  return {
    qualified: table.qualified,
    columns: table.columns.map((column) => ({ name: column.name, ...canonicalTypeForSqlServer(column.type) })),
    key: table.options.primaryKey ?? [],
  };
}

const IMAGE_SIZES = shapeOf('timagesizes');
const USERS = shapeOf('tusers');
const MEMBERS = shapeOf('tmailinglistmembers');

/** A keyed row as the extractor yields it: canonical value text, encoded key and typed key values. */
function keyedRow(shape: TableShape, values: Values): CanonicalRow {
  const encoding = encodeRow(shape.columns, values);
  const row = decodeRow(shape.columns, encoding);
  return { table: shape.qualified, key: encodeKey(shape.columns, shape.key, row), keyValues: shape.key.map((name) => values[name] as string), encoding, row };
}

/** A keyless row as the extractor yields it: the whole-row encoding is its key and it has no key values. */
function keylessRow(shape: TableShape, values: Values): CanonicalRow {
  const encoding = encodeRow(shape.columns, values);
  return { table: shape.qualified, key: encoding, keyValues: [], encoding, row: decodeRow(shape.columns, encoding) };
}

const sizeId = (n: number): string => `00000000-0000-0000-${String(n).padStart(16, '0')}`;
const userId = (n: number): string => `10000000-0000-0000-${String(n).padStart(16, '0')}`;

/** `timagesizes` row `n`; ids order as `n` does. */
function imageSize(n: number, overrides: Values = {}): CanonicalRow {
  return keyedRow(IMAGE_SIZES, imageSizeRow({ sizeID: sizeId(n), name: `size-${String(n)}`, ...overrides }));
}

/** `tusers` system user `n` with `changes` applied after userRow derives Email and Password from UserName. */
function user(n: number, changes: Values = {}): CanonicalRow {
  return keyedRow(USERS, { ...userRow({ UserID: userId(n), UserName: `user${String(n)}` }), ...changes });
}

const sizeKey = (n: number): string => imageSize(n).key;

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** The rejection of `run`; fails the test when it resolves. */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

function asyncOf<T>(items: readonly T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) {
      await Promise.resolve();
      yield item;
    }
  })();
}

/** Async input over `items` that records whether the diff closed it through `return`. */
function tracked<T>(items: readonly T[]): { source: AsyncIterable<T>; state: { closed: boolean } } {
  const state = { closed: false };
  let index = 0;
  const iterator: AsyncIterator<T> = {
    async next() {
      await Promise.resolve();
      if (index >= items.length) return { done: true, value: undefined };
      index += 1;
      return { done: false, value: items[index - 1] as T };
    },
    async return() {
      await Promise.resolve();
      state.closed = true;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, state };
}

type Summary = { op: KeyedChange['op']; key: string; columns?: string[] };

function summarise(changes: readonly KeyedChange[]): Summary[] {
  return changes.map((change) => (change.op === 'update' ? { op: change.op, key: change.key, columns: change.columns } : { op: change.op, key: change.key }));
}

type Expected = [op: KeyedChange['op'], n: number, columns?: string[]];

function expectedOf(ops: readonly Expected[]): Summary[] {
  return ops.map(([op, n, columns]) => (columns === undefined ? { op, key: sizeKey(n) } : { op, key: sizeKey(n), columns }));
}

const keyed = (before: RowSource<CanonicalRow>, after: RowSource<CanonicalRow>): Promise<KeyedChange[]> =>
  collect(diffKeyedStreams(before, after, { columns: IMAGE_SIZES.columns }));

const INTERLEAVED_BEFORE = (): CanonicalRow[] => [imageSize(1), imageSize(2), imageSize(4), imageSize(5)];
const INTERLEAVED_AFTER = (): CanonicalRow[] => [imageSize(2, { width: '300' }), imageSize(3), imageSize(4), imageSize(6)];
const INTERLEAVED_CHANGES: Expected[] = [['delete', 1], ['update', 2, ['width']], ['insert', 3], ['delete', 5], ['insert', 6]];

describe('diffKeyedStreams', () => {
  it.each<[string, CanonicalRow[], CanonicalRow[], Expected[]]>([
    ['inserts every row when before is empty', [], [imageSize(1), imageSize(2), imageSize(3)], [['insert', 1], ['insert', 2], ['insert', 3]]],
    ['deletes every row when after is empty', [imageSize(1), imageSize(2), imageSize(3)], [], [['delete', 1], ['delete', 2], ['delete', 3]]],
    ['finds nothing between equal rows', [imageSize(1), imageSize(2)], [imageSize(1), imageSize(2)], []],
    ['updates one row naming its one changed column', [imageSize(1)], [imageSize(1, { height: '200' })], [['update', 1, ['height']]]],
    ['lists several changed columns in catalog order', [imageSize(1)], [imageSize(1, { width: '50', name: 'banner' })], [['update', 1, ['name', 'width']]]],
    ['merges interleaved keys into deletes, updates and inserts in key order', INTERLEAVED_BEFORE(), INTERLEAVED_AFTER(), INTERLEAVED_CHANGES],
  ])('%s', async (_case, before, after, expected) => {
    expect(summarise(await keyed(before, after))).toEqual(expectedOf(expected));
  });

  it('carries the before and after rows of every change and yields them in compareCanonicalRows order', async () => {
    const before = INTERLEAVED_BEFORE();
    const after = INTERLEAVED_AFTER();

    const changes = await keyed(before, after);

    expect(changes[0]).toEqual({ op: 'delete', key: before[0]?.key, before: before[0] });
    expect(changes[1]).toEqual({ op: 'update', key: before[1]?.key, before: before[1], after: after[0], columns: ['width'] });
    expect(changes[2]).toEqual({ op: 'insert', key: after[1]?.key, after: after[1] });
    const rows = changes.map((change) => (change.op === 'insert' ? change.after : change.before));
    expect(rows).toEqual(rows.toSorted(compareCanonicalRows));
  });

  type Source = (rows: CanonicalRow[]) => RowSource<CanonicalRow>;
  const SOURCES: Array<[string, Source]> = [
    ['an array', (rows) => rows],
    [
      'a sync generator',
      (rows) =>
        (function* () {
          yield* rows;
        })(),
    ],
    ['an async generator', (rows) => asyncOf(rows)],
  ];
  const SOURCE_PAIRS: Array<[string, string, Source, Source]> = SOURCES.flatMap(([beforeKind, toBefore]) =>
    SOURCES.map(([afterKind, toAfter]): [string, string, Source, Source] => [beforeKind, afterKind, toBefore, toAfter]),
  );

  it.each(SOURCE_PAIRS)(
    'diffs %s before against %s after',
    async (_beforeKind, _afterKind, toBefore, toAfter) => {
      expect(summarise(await keyed(toBefore(INTERLEAVED_BEFORE()), toAfter(INTERLEAVED_AFTER())))).toEqual(expectedOf(INTERLEAVED_CHANGES));
    },
  );

  const PERSON_COLUMNS = ['Fname', 'Lname', 'Email', 'Company', 'JobTitle'];

  it.each<[string, Values, KeyedDiffOptions['writableColumns'], string[] | null]>([
    ['drops an update whose only change is outside the writable columns', { UserName: 'renamed' }, PERSON_COLUMNS, null],
    ['lists only the writable columns of a mixed change', { UserName: 'renamed', Lname: 'Changed' }, PERSON_COLUMNS, ['Lname']],
    ['keeps catalog order among the writable columns', { Lname: 'Changed', Fname: 'Renamed', Password: 'new-hash' }, PERSON_COLUMNS, ['Fname', 'Lname']],
    ['matches writable column names case-insensitively', { Fname: 'Renamed', S2: 1 }, ['fname', 'LNAME'], ['Fname']],
    ['accepts the writable columns as a Set', { Email: 'new@example.test', Admin: 1 }, new Set(['Email']), ['Email']],
    ['suppresses every update when no column is writable', { Fname: 'Renamed' }, [], null],
    ['scopes nothing without writable columns', { UserName: 'renamed', Lname: 'Changed' }, undefined, ['Lname', 'UserName']],
  ])('%s', async (_case, change, writableColumns, expected) => {
    const before = user(1);
    const after = user(1, change);

    const changes = await collect(diffKeyedStreams([before], [after], { columns: USERS.columns, writableColumns }));

    expect(changes).toEqual(expected === null ? [] : [{ op: 'update', key: before.key, before, after, columns: expected }]);
  });

  it('keeps inserts and deletes whole whatever the writable columns', async () => {
    const removed = user(1);
    const added = user(2);

    const changes = await collect(diffKeyedStreams([removed], [added], { columns: USERS.columns, writableColumns: ['Fname'] }));

    expect(changes).toEqual([
      { op: 'delete', key: removed.key, before: removed },
      { op: 'insert', key: added.key, after: added },
    ]);
  });

  it.each<[string, number[], number[], DiffSide, number, number, 'follows' | 'repeats']>([
    ['before keys descend', [2, 1], [3], 'before', 2, 1, 'follows'],
    ['after keys descend', [1], [3, 2], 'after', 3, 2, 'follows'],
    ['before repeats a key', [1, 1], [], 'before', 1, 1, 'repeats'],
    ['after repeats a key', [], [4, 4], 'after', 4, 4, 'repeats'],
  ])('throws DiffOrderError when %s', async (_case, before, after, side, previous, current, verb) => {
    const error = await failure(keyed(before.map((n) => imageSize(n)), after.map((n) => imageSize(n))));

    expect(error).toBeInstanceOf(DiffOrderError);
    expect(error).toMatchObject({ name: 'DiffOrderError', code: 'diffOrder', side, previous: sizeKey(previous), current: sizeKey(current) });
    expect(error.message).toBe(`${side} input is out of order: ${sizeKey(current)} ${verb} ${sizeKey(previous)}`);
  });

  it('clips long keys in the message and keeps them whole on the error', async () => {
    const high = imageSize(0, { sizeID: 'Z'.repeat(300) });
    const low = imageSize(0, { sizeID: 'A'.repeat(300) });

    const error = await failure(keyed([high, low], []));

    expect(error).toMatchObject({ side: 'before', previous: high.key, current: low.key });
    expect(error.message).toBe(`before input is out of order: ${low.key.slice(0, 120)}… follows ${high.key.slice(0, 120)}…`);
  });
});

const EMAILS = { A: 'a@example.test', B: 'b@example.test', C: 'c@example.test' } as const;
type Label = keyof typeof EMAILS;

const member = (label: Label): CanonicalRow => keylessRow(MEMBERS, mailingListMemberRow({ Email: EMAILS[label] }));
const byEncoding = (a: { encoding: string }, b: { encoding: string }): number => compareEncodings(a.encoding, b.encoding);

/** Members named by `labels`, in encoding order unless `sort` is false. */
function members(labels: string, sort = true): CanonicalRow[] {
  const rows = Array.from(labels, (label) => member(label as Label));
  return sort ? rows.toSorted(byEncoding) : rows;
}

type Counts = Pick<MultisetChange, 'added' | 'removed'>;

describe('diffMultisetStreams', () => {
  it.each<[string, string, string, Partial<Record<Label, Counts>>]>([
    [
      'counts removed and added occurrences per distinct row',
      'AAB',
      'ABBC',
      { A: { added: 0, removed: 1 }, B: { added: 1, removed: 0 }, C: { added: 1, removed: 0 } },
    ],
    ['adds every occurrence when before is empty', '', 'AAB', { A: { added: 2, removed: 0 }, B: { added: 1, removed: 0 } }],
    ['removes every occurrence when after is empty', 'ABB', '', { A: { added: 0, removed: 1 }, B: { added: 0, removed: 2 } }],
    ['removes a row present only before', 'ABCC', 'BCC', { A: { added: 0, removed: 1 } }],
    ['adds a row present only after', 'BCC', 'ABCC', { A: { added: 1, removed: 0 } }],
    ['finds nothing between equal multisets', 'AABC', 'AABC', {}],
  ])('%s', async (_case, before, after, expected) => {
    const changes = await collect(diffMultisetStreams(members(before), members(after)));

    expect(changes.map(({ encoding, added, removed }) => ({ encoding, added, removed }))).toEqual(
      Object.entries(expected)
        .map(([label, counts]) => ({ encoding: member(label as Label).encoding, ...counts }))
        .toSorted(byEncoding),
    );
  });

  it('carries an after occurrence for additions and a before occurrence for removals', async () => {
    const before = members('AAB');
    const after = members('ABBC');

    const changes = await collect(diffMultisetStreams(before, asyncOf(after)));
    const rowOf = (label: Label): CanonicalRow | undefined => changes.find((change) => change.encoding === member(label).encoding)?.row;

    expect(rowOf('A')).toBe(before.find((row) => row.encoding === member('A').encoding));
    expect(rowOf('B')).toBe(after.find((row) => row.encoding === member('B').encoding));
    expect(rowOf('C')).toBe(after.find((row) => row.encoding === member('C').encoding));
  });

  it.each<[DiffSide, string, string]>([
    ['before', 'BA', ''],
    ['after', 'A', 'CB'],
  ])('throws DiffOrderError when the %s input is not in encoding order', async (side, before, after) => {
    const [first, second] = side === 'before' ? before : after;

    const error = await failure(collect(diffMultisetStreams(members(before, false), members(after, false))));

    expect(error).toBeInstanceOf(DiffOrderError);
    expect(error).toMatchObject({ code: 'diffOrder', side });
    const { previous, current } = error as DiffOrderError;
    expect(previous.length).toBeLessThanOrEqual(120);
    expect(member(first as Label).encoding.startsWith(previous.replace(/…$/, ''))).toBe(true);
    expect(member(second as Label).encoding.startsWith(current.replace(/…$/, ''))).toBe(true);
  });
});

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Manifest entry of stored name `name` under `siteId` in snapshot `snapshotSeq`. */
function manifestEntry(
  snapshotSeq: number,
  siteId: string,
  name: string,
  fields: Partial<Pick<ManifestEntry, 'size' | 'sha256' | 'orphan'>> = {},
): ManifestEntry {
  const parsed = parseStoredName(name);
  if (parsed === null) throw new Error(`${name} is not a stored name`);
  return { snapshotSeq, siteId, path: storePath(siteId, name), name, ...parsed, size: 64, sha256: sha(name), orphan: false, ...fields };
}

const FILE_ONE = 'F0000000-0000-0000-0000000000000001.pdf';
const FILE_TWO = 'F0000000-0000-0000-0000000000000002.pdf';

type ChangeSummary = [kind: ManifestChange['kind'], siteId: string, name: string];

const summariseManifest = (changes: readonly ManifestChange[]): ChangeSummary[] =>
  changes.map((change) => [change.kind, change.siteId, change.path.slice(change.path.lastIndexOf('/') + 1)]);

const keyOf = ({ siteId, path }: ManifestKey): ManifestKey => ({ siteId, path });

describe('diffManifests', () => {
  it.each<[string, ManifestEntry[], ManifestEntry[], ChangeSummary[]]>([
    ['adds an object only after', [], [manifestEntry(2, 'default', FILE_ONE)], [['added', 'default', FILE_ONE]]],
    ['removes an object only before', [manifestEntry(1, 'default', FILE_ONE)], [], [['removed', 'default', FILE_ONE]]],
    ['changes an object whose sha256 differs', [manifestEntry(1, 'default', FILE_ONE)], [manifestEntry(2, 'default', FILE_ONE, { sha256: sha('new') })], [['changed', 'default', FILE_ONE]]],
    ['changes an object whose size differs', [manifestEntry(1, 'default', FILE_ONE)], [manifestEntry(2, 'default', FILE_ONE, { size: 65 })], [['changed', 'default', FILE_ONE]]],
    ['leaves an object with equal sha256 and size unchanged whatever its orphan flag', [manifestEntry(1, 'default', FILE_ONE)], [manifestEntry(2, 'default', FILE_ONE, { orphan: true })], []],
    [
      'merges keys across sites in key order',
      [manifestEntry(1, 'default', FILE_ONE), manifestEntry(1, 'default', FILE_TWO), manifestEntry(1, 'tenant-b', FILE_ONE)],
      [manifestEntry(2, 'default', FILE_TWO, { size: 1 }), manifestEntry(2, 'tenant-a', FILE_ONE), manifestEntry(2, 'tenant-b', FILE_ONE)],
      [
        ['removed', 'default', FILE_ONE],
        ['changed', 'default', FILE_TWO],
        ['added', 'tenant-a', FILE_ONE],
      ],
    ],
  ])('%s', async (_case, before, after, expected) => {
    expect(summariseManifest(await collect(diffManifests(before, after)))).toEqual(expected);
  });

  it('carries both entries of a changed object', async () => {
    const before = manifestEntry(1, 'default', FILE_ONE);
    const after = manifestEntry(2, 'default', FILE_ONE, { sha256: sha('new') });

    expect(await collect(diffManifests([before], asyncOf([after])))).toEqual([
      { kind: 'changed', siteId: 'default', path: before.path, before, after },
    ]);
  });

  it('orders site ids by UTF-8 bytes, so a byte-sorted manifest is accepted and a UTF-16-sorted one is not', async () => {
    const fullwidth = manifestEntry(2, 'site\uFF5E', FILE_ONE);
    const emoji = manifestEntry(2, 'site\u{1F600}', FILE_ONE);
    expect(emoji.siteId < fullwidth.siteId).toBe(true);
    expect(compareManifestKeys(fullwidth, emoji)).toBeLessThan(0);

    const added = await collect(diffManifests([], [fullwidth, emoji]));
    const error = await failure(collect(diffManifests([], [emoji, fullwidth])));

    expect(added.map((change) => change.siteId)).toEqual([fullwidth.siteId, emoji.siteId]);
    expect(error).toBeInstanceOf(DiffOrderError);
    expect(error).toMatchObject({
      code: 'diffOrder',
      side: 'after',
      previous: `${emoji.siteId}/${emoji.path}`,
      current: `${fullwidth.siteId}/${fullwidth.path}`,
    });
  });

  it('throws DiffOrderError when a manifest repeats a key', async () => {
    const entry = manifestEntry(1, 'default', FILE_ONE);

    const error = await failure(collect(diffManifests([entry, { ...entry, size: 1 }], [])));

    expect(error).toMatchObject({ code: 'diffOrder', side: 'before', previous: `default/${entry.path}`, current: `default/${entry.path}` });
    expect(error.message).toContain('repeats');
  });
});

describe('diff inputs', () => {
  type Started = { changes: AsyncIterable<unknown>; states: [{ closed: boolean }, { closed: boolean }] };

  function start<T>(diff: (before: AsyncIterable<T>, after: AsyncIterable<T>) => AsyncIterable<unknown>, before: T[], after: T[]): Started {
    const left = tracked(before);
    const right = tracked(after);
    return { changes: diff(left.source, right.source), states: [left.state, right.state] };
  }

  const keyedDiff = (before: AsyncIterable<CanonicalRow>, after: AsyncIterable<CanonicalRow>) => diffKeyedStreams(before, after, { columns: IMAGE_SIZES.columns });
  const one = manifestEntry(1, 'default', FILE_ONE);
  const two = manifestEntry(1, 'default', FILE_TWO);

  const CASES: Array<[string, (unordered: boolean) => Started]> = [
    ['the keyed diff', (unordered) => start(keyedDiff, unordered ? [imageSize(2), imageSize(1)] : [imageSize(1), imageSize(2)], [imageSize(3)])],
    ['the multiset diff', (unordered) => start(diffMultisetStreams, members('BA', !unordered), members('C'))],
    ['the manifest diff', (unordered) => start(diffManifests, unordered ? [two, one] : [one, two], [manifestEntry(2, 'tenant-b', FILE_ONE)])],
  ];

  it.each(CASES)('%s closes both inputs when the consumer stops after the first change', async (_diff, begin) => {
    const { changes, states } = begin(false);

    for await (const change of changes) {
      expect(change).toBeDefined();
      break;
    }

    expect(states.map((state) => state.closed)).toEqual([true, true]);
  });

  it.each(CASES)('%s closes both inputs when an input is out of order', async (_diff, begin) => {
    const { changes, states } = begin(true);

    expect(await failure(collect(changes))).toBeInstanceOf(DiffOrderError);
    expect(states.map((state) => state.closed)).toEqual([true, true]);
  });
});

/** Snapshot `snapshotSeq`'s manifest of the fixture files as `files.cfm?op=list` lists them, in key order. */
function listedManifest(snapshotSeq: number, files: readonly FixtureFile[]): ManifestEntry[] {
  return files
    .flatMap((file) =>
      FILE_LISTINGS[file.siteId].files
        .filter((listed) => listed.fileId === file.fileId)
        .map((listed) => manifestEntry(snapshotSeq, file.siteId, listed.name, { size: listed.size, sha256: listed.sha256, orphan: !file.catalogued })),
    )
    .toSorted(compareManifestKeys);
}

describe('diffSnapshotManifests', () => {
  const { image, pdf, video, orphan } = FIXTURE_FILES;
  const rerendered = storePath(image.siteId, `${image.fileId}_medium.${image.ext}`);
  const resizedThumbnail = storePath(video.siteId, `${video.fileId}_small.jpg`);
  const banner = fixtureId('tfiles:tenant-b/banner.png');

  const before = listedManifest(1, [image, pdf, video, orphan]);
  const after = [
    ...listedManifest(2, [image, video, orphan]).map((entry) => {
      if (entry.path === rerendered) return { ...entry, sha256: sha('re-rendered medium') };
      if (entry.path === resizedThumbnail) return { ...entry, size: entry.size + 10 };
      return entry;
    }),
    ...['', '_source', '_small', '_medium'].map((variant) => manifestEntry(2, 'tenant-b', `${banner}${variant}.png`)),
  ].toSorted(compareManifestKeys);

  const changedPaths = new Set([rerendered, resizedThumbnail]);
  const withMetadata = vi.fn(() => Promise.reject(new Error('the migration database is not read when opts.read is given')));
  const ctx = { db: { withMetadata } } as unknown as Pick<FilesContext, 'db'>;

  it('classifies image renditions, flv thumbnails, removed and new objects of two fixture manifests', async () => {
    const read = vi.fn((snapshotSeq: number) => asyncOf(snapshotSeq === 1 ? before : after));

    const diff = await diffSnapshotManifests(ctx, 1, 2, { read });

    expect(before).toHaveLength(9);
    expect([diff.added.length, diff.changed.length, diff.removed.length, diff.toTransfer.length]).toEqual([4, 2, 1, 6]);
    expect(read.mock.calls).toEqual([[1], [2]]);
    expect(withMetadata).not.toHaveBeenCalled();
    expect(diff).toEqual({
      from: 1,
      to: 2,
      added: after.filter((entry) => entry.fileId === banner),
      changed: after
        .filter((entry) => changedPaths.has(entry.path))
        .map((entry) => ({ before: before.find((old) => old.path === entry.path), after: entry })),
      removed: before.filter((entry) => entry.fileId === pdf.fileId),
      unchanged: 6,
      toTransfer: after.filter((entry) => entry.fileId === banner || changedPaths.has(entry.path)).map(keyOf),
    });
  });

  it('agrees with diffManifests on the same fixture manifests', async () => {
    const diff = await diffSnapshotManifests(ctx, 1, 2, { read: (snapshotSeq) => asyncOf(snapshotSeq === 1 ? before : after) });
    const changes = await collect(diffManifests(before, after));

    expect(changes.flatMap((change) => (change.kind === 'added' ? [change.after] : []))).toEqual(diff.added);
    expect(changes.flatMap((change) => (change.kind === 'removed' ? [change.before] : []))).toEqual(diff.removed);
    expect(changes.flatMap((change) => (change.kind === 'changed' ? [{ before: change.before, after: change.after }] : []))).toEqual(diff.changed);
  });
});
