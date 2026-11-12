// Unit tests for the reconciliation core: row and object comparisons, capped difference lists and value rendering.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { compareEncodings, decodeRow, encodeKey, encodeRow, legacyRowHash, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { describe, expect, it } from 'vitest';

import { DiffOrderError, type RowSource } from '../../src/diff/index.js';
import type { CanonicalRow } from '../../src/extract/index.js';
import {
  compareObjects,
  compareRows,
  isZeroDifference,
  mergeDifferences,
  renderValue,
  type Difference,
  type ObjectComparison,
  type ObjectEntry,
  type RowComparison,
} from '../../src/reconcile/compare.js';

const TABLE = 'dbo.tcontentcategories';
const KEY = ['CategoryID', 'SiteID'];
const COLUMNS: CanonicalColumn[] = [
  { name: 'CategoryID', type: 's' },
  { name: 'SiteID', type: 's' },
  { name: 'Name', type: 's' },
  { name: 'SortOrder', type: 'i' },
  { name: 'Weight', type: 'd', scale: 2 },
  { name: 'LastUpdate', type: 't' },
  { name: 'Thumbnail', type: 'b' },
];

const KEYLESS_TABLE = 'dbo.tmailinglistmembers';
const KEYLESS_COLUMNS: CanonicalColumn[] = [
  { name: 'MLID', type: 's' },
  { name: 'SiteID', type: 's' },
  { name: 'Email', type: 's' },
  { name: 'isVerified', type: 'i' },
];

type Values = Record<string, unknown>;
type Source = (rows: readonly CanonicalRow[]) => RowSource<CanonicalRow>;

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const joined = (rows: readonly CanonicalRow[]): string => rows.map((row) => row.encoding).join('');

function category(id: string, overrides: Values = {}): Values {
  return {
    CategoryID: id,
    SiteID: 'default',
    Name: `Category ${id}`,
    SortOrder: 1,
    Weight: '1.5',
    LastUpdate: '2026-01-02T03:04:05.000',
    Thumbnail: Buffer.from([0xab, 0x01]),
    ...overrides,
  };
}

function keyedRow(values: Values): CanonicalRow {
  const encoding = encodeRow(COLUMNS, values);
  return {
    table: TABLE,
    key: encodeKey(COLUMNS, KEY, values),
    keyValues: KEY.map((name) => values[name] as string),
    encoding,
    row: decodeRow(COLUMNS, encoding),
  };
}

function member(email: string): CanonicalRow {
  const encoding = encodeRow(KEYLESS_COLUMNS, { MLID: 'ML01', SiteID: 'default', Email: email, isVerified: 1 });
  return { table: KEYLESS_TABLE, key: encoding, keyValues: [], encoding, row: decodeRow(KEYLESS_COLUMNS, encoding) };
}

const byEncoding = (rows: readonly CanonicalRow[]): CanonicalRow[] => [...rows].sort((a, b) => compareEncodings(a.encoding, b.encoding));

async function* streamOf(rows: readonly CanonicalRow[]): AsyncGenerator<CanonicalRow, void, undefined> {
  for (const row of rows) {
    await Promise.resolve();
    yield row;
  }
}

const arrayOf: Source = (rows) => [...rows];

const C001 = keyedRow(category('C001'));
const C002 = keyedRow(category('C002'));
const C003 = keyedRow(category('C003'));
const ALL = [C001, C002, C003];

const A = member('a@example.com');
const B = member('b@example.com');

describe('compareRows on keyed tables', () => {
  it.each<{ name: string; legacySource: Source; targetSource: Source }>([
    { name: 'arrays', legacySource: arrayOf, targetSource: arrayOf },
    { name: 'async iterables', legacySource: streamOf, targetSource: streamOf },
    { name: 'an array and an async iterable', legacySource: arrayOf, targetSource: streamOf },
  ])('measures identical rows from $name as equal', async ({ legacySource, targetSource }) => {
    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: legacySource(ALL), target: targetSource(ALL.map((row) => ({ ...row }))) });

    expect(result).toEqual({
      legacyCount: 3,
      targetCount: 3,
      legacySha256: sha(joined(ALL)),
      targetSha256: sha(joined(ALL)),
      differences: [],
      differenceCount: 0,
    });
    expect(isZeroDifference(result)).toBe(true);
  });

  it('measures empty sides as equal', async () => {
    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: [], target: [] });

    expect(result).toEqual({ legacyCount: 0, targetCount: 0, legacySha256: sha(''), targetSha256: sha(''), differences: [], differenceCount: 0 });
  });

  it.each<[string, unknown, unknown, string | null, string | null]>([
    ['Name', 'Old name', 'New name', 'Old name', 'New name'],
    ['SortOrder', 1, null, '1', null],
    ['Weight', '1.5', '2', '1.50', '2.00'],
    ['LastUpdate', '2026-01-02T03:04:05.000', '2026-01-02T03:04:06.000', '2026-01-02T03:04:05.000', '2026-01-02T03:04:06.000'],
    ['Thumbnail', Buffer.from([0xab]), Buffer.from([0xcd, 0xef]), 'ab', 'cdef'],
  ])('reports a changed %s with both canonical values', async (column, before, after, legacy, target) => {
    const was = keyedRow(category('C002', { [column]: before }));
    const now = keyedRow(category('C002', { [column]: after }));

    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: [C001, was, C003], target: [C001, now, C003] });

    expect(result.differences).toEqual([{ kind: 'changed', key: was.key, column, legacy, target }]);
    expect(result.differenceCount).toBe(1);
    expect([result.legacyCount, result.targetCount]).toEqual([3, 3]);
    expect(result.legacySha256).toBe(sha(joined([C001, was, C003])));
    expect(result.targetSha256).toBe(sha(joined([C001, now, C003])));
    expect(isZeroDifference(result)).toBe(false);
  });

  it('lists every changed column of a row in catalog order', async () => {
    const now = keyedRow(category('C001', { Thumbnail: Buffer.from([0x02]), Name: 'Renamed' }));

    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: [C001], target: [now] });

    expect(result.differences).toEqual([
      { kind: 'changed', key: C001.key, column: 'Name', legacy: 'Category C001', target: 'Renamed' },
      { kind: 'changed', key: C001.key, column: 'Thumbnail', legacy: 'ab01', target: '02' },
    ]);
    expect(result.differenceCount).toBe(2);
  });

  it('renders a changed value over 1,024 characters by its SHA-256', async () => {
    const long = 'x'.repeat(2000);
    const was = keyedRow(category('C001', { Name: long }));

    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: [was], target: [C001] });

    expect(result.differences).toEqual([
      { kind: 'changed', key: C001.key, column: 'Name', legacy: `sha256:${sha(long)} (2000 chars)`, target: 'Category C001' },
    ]);
  });

  it.each([
    { kind: 'missing-in-target', legacy: ALL, target: [C001, C003], values: { legacy: C002.encoding, target: null }, counts: [3, 2] },
    { kind: 'extra-in-target', legacy: [C001, C003], target: ALL, values: { legacy: null, target: C002.encoding }, counts: [2, 3] },
  ])('reports a row only one side has as $kind', async ({ kind, legacy, target, values, counts }) => {
    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy, target });

    expect(result.differences).toEqual([{ kind, key: C002.key, column: null, ...values }]);
    expect(result.differenceCount).toBe(1);
    expect([result.legacyCount, result.targetCount]).toEqual(counts);
    expect(result.legacySha256).not.toBe(result.targetSha256);
  });

  it('renders a whole row over 1,024 characters by its SHA-256', async () => {
    const wide = keyedRow(category('C002', { Name: 'z'.repeat(1100) }));

    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: [C001, wide], target: [C001] });

    expect(result.differences).toEqual([
      { kind: 'missing-in-target', key: wide.key, column: null, legacy: `sha256:${sha(wide.encoding)} (${String(wide.encoding.length)} chars)`, target: null },
    ]);
  });

  it.each([
    { label: 'the default limit', limit: undefined, kept: 100 },
    { label: 'limit 5', limit: 5, kept: 5 },
  ])('keeps $kept of 150 differences under $label and counts all', async ({ limit, kept }) => {
    const rows = Array.from({ length: 150 }, (_, index) => keyedRow(category(`R${String(index).padStart(3, '0')}`)));

    const result = await compareRows({ keyed: true, columns: COLUMNS, legacy: rows, target: [], limit });

    expect(result.differences.map((difference) => difference.key)).toEqual(rows.slice(0, kept).map((row) => row.key));
    expect(result.differenceCount).toBe(150);
    expect([result.legacyCount, result.targetCount]).toEqual([150, 0]);
  });

  it.each([
    { name: 'legacy keys out of order', legacy: [C002, C001], target: ALL, side: 'before' },
    { name: 'a repeated target key', legacy: ALL, target: [C001, C001], side: 'after' },
  ])('rejects $name with DiffOrderError', async ({ legacy, target, side }) => {
    const error: unknown = await compareRows({ keyed: true, columns: COLUMNS, legacy: streamOf(legacy), target }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DiffOrderError);
    expect(error).toMatchObject({ code: 'diffOrder', side });
  });
});

describe('compareRows on keyless tables', () => {
  it('measures identical multisets as equal', async () => {
    const rows = byEncoding([B, A, A]);

    const result = await compareRows({ keyed: false, columns: KEYLESS_COLUMNS, legacy: streamOf(rows), target: [...rows] });

    expect(result).toEqual({
      legacyCount: 3,
      targetCount: 3,
      legacySha256: sha(joined(rows)),
      targetSha256: sha(joined(rows)),
      differences: [],
      differenceCount: 0,
    });
  });

  it.each([
    {
      name: 'a duplicate only legacy has',
      legacy: [A, A, B],
      target: [A, B],
      expected: { kind: 'missing-in-target', row: A, legacy: A.encoding, target: null, occurrences: 1 },
      counts: [3, 2],
    },
    {
      name: 'rows only target has',
      legacy: [A],
      target: [A, B, B],
      expected: { kind: 'extra-in-target', row: B, legacy: null, target: B.encoding, occurrences: 2 },
      counts: [1, 3],
    },
  ])('reports $name by row hash with occurrences', async ({ legacy, target, expected, counts }) => {
    const legacyRows = byEncoding(legacy);
    const targetRows = byEncoding(target);
    const { row, ...difference } = expected;

    const result = await compareRows({ keyed: false, columns: KEYLESS_COLUMNS, legacy: legacyRows, target: streamOf(targetRows) });

    expect(result.differences).toEqual([{ ...difference, key: legacyRowHash(KEYLESS_COLUMNS, row.row), column: null }]);
    expect(result.differences[0]?.key).toBe(sha(row.encoding));
    expect(result.differenceCount).toBe(1);
    expect([result.legacyCount, result.targetCount]).toEqual(counts);
    expect(result.legacySha256).toBe(sha(joined(legacyRows)));
    expect(result.targetSha256).toBe(sha(joined(targetRows)));
    expect(result.legacySha256).not.toBe(result.targetSha256);
    expect(isZeroDifference(result)).toBe(false);
  });

  it('rejects rows out of encoding order with DiffOrderError', async () => {
    const error: unknown = await compareRows({ keyed: false, columns: KEYLESS_COLUMNS, legacy: byEncoding([A, B]), target: [B, A] }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DiffOrderError);
    expect(error).toMatchObject({ code: 'diffOrder', side: 'after' });
  });
});

describe('compareObjects', () => {
  const [LOW, HIGH] = [sha('object one'), sha('object two')].sort() as [string, string];
  const FILE = 'tenant-a/A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6.jpg';
  const object = (key: string, size: number, sha256: string): ObjectEntry => ({ key, size, sha256 });

  it('finds equal manifests equal whatever their order', () => {
    const legacy = [object(FILE, 10, LOW), object('tenant-a/F2.png', 20, HIGH)];

    expect(compareObjects(legacy, [...legacy].reverse())).toEqual({ legacyObjects: 2, targetObjects: 2, differences: [], differenceCount: 0 });
  });

  it.each<{ name: string; legacy: ObjectEntry[]; target: ObjectEntry[]; expected: Difference[] }>([
    {
      name: 'an object missing in target',
      legacy: [object(FILE, 10, LOW)],
      target: [],
      expected: [{ kind: 'object-missing-in-target', key: FILE, column: null, legacy: LOW, target: null }],
    },
    {
      name: 'an object extra in target',
      legacy: [],
      target: [object(FILE, 10, LOW)],
      expected: [{ kind: 'object-extra-in-target', key: FILE, column: null, legacy: null, target: LOW }],
    },
    {
      name: 'a size mismatch',
      legacy: [object(FILE, 10, LOW)],
      target: [object(FILE, 11, LOW)],
      expected: [{ kind: 'object-mismatch', key: FILE, column: 'size', legacy: '10', target: '11' }],
    },
    {
      name: 'a SHA-256 mismatch',
      legacy: [object(FILE, 10, LOW)],
      target: [object(FILE, 10, HIGH)],
      expected: [{ kind: 'object-mismatch', key: FILE, column: 'sha256', legacy: LOW, target: HIGH }],
    },
    {
      name: 'a size and SHA-256 mismatch',
      legacy: [object(FILE, 10, LOW)],
      target: [object(FILE, 11, HIGH)],
      expected: [
        { kind: 'object-mismatch', key: FILE, column: 'size', legacy: '10', target: '11' },
        { kind: 'object-mismatch', key: FILE, column: 'sha256', legacy: LOW, target: HIGH },
      ],
    },
    {
      name: 'duplicated legacy objects',
      legacy: [object(FILE, 20, HIGH), object(FILE, 10, LOW), object(FILE, 10, LOW), object(FILE, 10, LOW)],
      target: [object(FILE, 10, LOW)],
      expected: [
        { kind: 'object-missing-in-target', key: FILE, column: null, legacy: LOW, target: null, occurrences: 2 },
        { kind: 'object-missing-in-target', key: FILE, column: null, legacy: HIGH, target: null, occurrences: 1 },
      ],
    },
    {
      name: 'a duplicated target object',
      legacy: [object(FILE, 10, LOW)],
      target: [object(FILE, 10, LOW), object(FILE, 10, LOW)],
      expected: [{ kind: 'object-extra-in-target', key: FILE, column: null, legacy: null, target: LOW, occurrences: 1 }],
    },
    {
      name: 'a mismatch between unmatched duplicates',
      legacy: [object(FILE, 10, LOW), object(FILE, 10, LOW)],
      target: [object(FILE, 11, LOW), object(FILE, 10, LOW)],
      expected: [{ kind: 'object-mismatch', key: FILE, column: 'size', legacy: '10', target: '11' }],
    },
  ])('reports $name', ({ legacy, target, expected }) => {
    const result = compareObjects(legacy, target);

    expect(result.differences).toEqual(expected);
    expect(result.differenceCount).toBe(expected.length);
    expect([result.legacyObjects, result.targetObjects]).toEqual([legacy.length, target.length]);
  });

  it('orders differences by key and keeps the first limit', () => {
    const keys = ['tenant-a/F4.jpg', 'tenant-a/F1.jpg', 'tenant-a/F3.jpg', 'tenant-a/F0.jpg', 'tenant-a/F2.jpg'];

    const result = compareObjects(keys.map((key) => object(key, 10, LOW)), [], 2);

    expect(result.differences.map((difference) => difference.key)).toEqual(['tenant-a/F0.jpg', 'tenant-a/F1.jpg']);
    expect(result.differenceCount).toBe(5);
    expect(result.legacyObjects).toBe(5);
  });
});

describe('mergeDifferences', () => {
  const difference = (key: string): Difference => ({ kind: 'changed', key, column: 'Name', legacy: 'a', target: 'b' });
  const first = { differences: [difference('k1'), difference('k2')], differenceCount: 2 };
  const capped = { differences: [difference('k3')], differenceCount: 40 };

  it.each([
    { limit: 2, keys: ['k1', 'k2'] },
    { limit: 100, keys: ['k1', 'k2', 'k3'] },
  ])('keeps the first $limit entries in order and sums the totals', ({ limit, keys }) => {
    const merged = mergeDifferences(limit, first, capped);

    expect(merged.differences.map((entry) => entry.key)).toEqual(keys);
    expect(merged.differenceCount).toBe(42);
  });

  it('merges no parts into an empty list', () => {
    expect(mergeDifferences(100)).toEqual({ differences: [], differenceCount: 0 });
  });
});

describe('isZeroDifference', () => {
  const ROWS: RowComparison = { legacyCount: 2, targetCount: 2, legacySha256: sha('rows'), targetSha256: sha('rows'), differences: [], differenceCount: 0 };
  const OBJECTS: ObjectComparison = { legacyObjects: 1, targetObjects: 1, differences: [], differenceCount: 0 };

  it.each<{ name: string; rows: RowComparison; objects?: ObjectComparison | null; expected: boolean }>([
    { name: 'equal rows', rows: ROWS, expected: true },
    { name: 'equal rows and null objects', rows: ROWS, objects: null, expected: true },
    { name: 'equal rows and objects', rows: ROWS, objects: OBJECTS, expected: true },
    { name: 'differing row counts', rows: { ...ROWS, targetCount: 3 }, expected: false },
    { name: 'differing checksums', rows: { ...ROWS, targetSha256: sha('other') }, expected: false },
    { name: 'a row difference', rows: { ...ROWS, differenceCount: 1 }, objects: OBJECTS, expected: false },
    { name: 'an object difference', rows: ROWS, objects: { ...OBJECTS, differenceCount: 1 }, expected: false },
    { name: 'differing object counts', rows: ROWS, objects: { ...OBJECTS, targetObjects: 2 }, expected: false },
  ])('is $expected for $name', ({ rows, objects, expected }) => {
    expect(isZeroDifference(rows, objects)).toBe(expected);
  });
});

describe('renderValue', () => {
  it.each<[string, string | null, string | null]>([
    ['null', null, null],
    ['short text', 'abc', 'abc'],
    ['1,024 characters', 'y'.repeat(1024), 'y'.repeat(1024)],
    ['1,025 characters', 'y'.repeat(1025), `sha256:${sha('y'.repeat(1025))} (1025 chars)`],
    ['1,025 multi-byte characters', 'é'.repeat(1025), `sha256:${sha('é'.repeat(1025))} (1025 chars)`],
  ])('renders %s', (_name, value, expected) => {
    expect(renderValue(value)).toBe(expected);
  });
});
