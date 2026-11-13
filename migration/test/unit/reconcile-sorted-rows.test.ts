// Unit tests for the bounded external sort of unit rows: spill round trips, ordering, tenant grouping and cleanup.
import { Buffer } from 'node:buffer';
import { mkdtemp, readdir, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanonicalColumn, CanonicalValue } from '@opt2/platform/migration-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareCanonicalRows, type CanonicalRow } from '../../src/extract/index.js';
import { toUnitRow, unitRowSorter, type UnitTableShape } from '../../src/reconcile/legacy-side.js';
import { UnitRowSorter } from '../../src/reconcile/sorted-rows.js';

type Shape = Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns'>;
type Values = Record<string, CanonicalValue>;

const A = 'tenant-a';
const B = 'tenant-b';
const C = 'tenant-c';

const KEYED: Shape = {
  legacyTable: 'tcontent',
  keyed: true,
  keyColumns: ['id'],
  columns: [
    { name: 'id', type: 'i' },
    { name: 'title', type: 's' },
    { name: 'body', type: 's' },
    { name: 'image', type: 'b' },
  ],
};

const FOLDED: Shape = {
  legacyTable: 'Program_N.timesheet',
  keyed: true,
  keyColumns: ['timesheet_id', 'legacy_program_id'],
  columns: [
    { name: 'timesheet_id', type: 'i' },
    { name: 'status', type: 's' },
    { name: 'legacy_program_id', type: 'i' },
  ],
};

const KEYLESS: Shape = {
  legacyTable: 'tmailinglistmembers',
  keyed: false,
  keyColumns: [],
  columns: [
    { name: 'MLID', type: 's' },
    { name: 'Email', type: 's' },
  ],
};

const BINARY_KEY: Shape = {
  legacyTable: 'tfiles',
  keyed: true,
  keyColumns: ['hash'],
  columns: [
    { name: 'hash', type: 'b' },
    { name: 'name', type: 's' },
  ],
};

let spillDir: string;

beforeEach(async () => {
  spillDir = await mkdtemp(join(tmpdir(), 'opt2-sorted-rows-test-'));
});

afterEach(async () => {
  await rm(spillDir, { recursive: true, force: true });
});

/** Spill directories the sorters of a test left behind. */
const leftovers = (): Promise<string[]> => readdir(spillDir);

function content(id: number, title: string | null, body: string | null = 'x', image: Buffer | null = null): Values {
  return { id: String(id), title, body, image };
}

/** Rows in the reading order: tenant by code unit, then `compareCanonicalRows`. */
function expectedOrder(rows: readonly { tenantId: string; row: CanonicalRow }[]): { tenantId: string; row: CanonicalRow }[] {
  return [...rows].sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : compareCanonicalRows(a.row, b.row)));
}

async function sortedOf(shape: Shape, rows: readonly { tenantId: string; row: CanonicalRow }[], sortRunBytes?: number): Promise<UnitRowSorter> {
  const sorter = unitRowSorter(shape, { sortRunBytes, spillDir });
  for (const { tenantId, row } of rows) await sorter.add(tenantId, row);
  await sorter.sort();
  return sorter;
}

/** Every tenant's rows of `sorter`, read in tenant order. */
async function readAll(sorter: UnitRowSorter): Promise<{ tenantId: string; row: CanonicalRow }[]> {
  const read: { tenantId: string; row: CanonicalRow }[] = [];
  for (const tenantId of sorter.tenants()) for await (const row of sorter.rows(tenantId)) read.push({ tenantId, row });
  return read;
}

describe('UnitRowSorter', () => {
  const large = 'L'.repeat(10 * 1024 * 1024);
  it.each<[string, Shape, { tenantId: string; values: Values; legacyProgramId?: number }[]]>([
    ['null against empty text', KEYED, [{ tenantId: A, values: content(1, null, '') }, { tenantId: A, values: content(2, '', null) }]],
    ['binary values', KEYED, [{ tenantId: A, values: content(1, 't', 'x', Buffer.from([0, 255, 10, 58])) }, { tenantId: B, values: content(1, 't', null, Buffer.alloc(0)) }]],
    ['char padding', KEYED, [{ tenantId: A, values: content(1, 't   ', 'body  ') }, { tenantId: A, values: content(2, 't', 'body') }]],
    ['empty canonical rows', { ...KEYLESS, columns: [] }, [{ tenantId: A, values: {} }, { tenantId: A, values: {} }]],
    ['":" and control characters', KEYED, [{ tenantId: A, values: content(3, 'a:b\u0000c\n', '\u0001:\t\r') }, { tenantId: 'x\n"y', values: content(4, '\\"', ':') }]],
    [
      'folded rows with legacy_program_id',
      FOLDED,
      [
        { tenantId: A, values: { timesheet_id: '7', status: 'DRAFT', legacy_program_id: '2' }, legacyProgramId: 2 },
        { tenantId: A, values: { timesheet_id: '7', status: 'SUBMITTED', legacy_program_id: '1' }, legacyProgramId: 1 },
      ],
    ],
    [
      'keyless rows and their duplicates',
      KEYLESS,
      [
        { tenantId: A, values: { MLID: 'L', Email: 'b@example.com' } },
        { tenantId: A, values: { MLID: 'L', Email: 'a@example.com' } },
        { tenantId: A, values: { MLID: 'L', Email: 'b@example.com' } },
      ],
    ],
    ['binary keys', BINARY_KEY, [{ tenantId: A, values: { hash: Buffer.from('ff00', 'hex'), name: 'b' } }, { tenantId: A, values: { hash: Buffer.from('00ff', 'hex'), name: 'a' } }]],
    ['10 MB values', KEYED, [{ tenantId: A, values: content(2, large, large) }, { tenantId: A, values: content(1, 'small') }]],
  ])('rebuilds %s exactly, spilled or in memory', async (_case, shape, input) => {
    const rows = input.map(({ tenantId, values, legacyProgramId }) => ({ tenantId, row: toUnitRow(shape, values, legacyProgramId) }));
    const expected = expectedOrder(rows);

    for (const sortRunBytes of [1, undefined]) {
      const sorter = await sortedOf(shape, rows, sortRunBytes);
      if (sortRunBytes === 1) expect(await leftovers()).toHaveLength(1);
      expect(await readAll(sorter)).toEqual(expected);
    }
    expect(await leftovers()).toEqual([]);
  });

  it.each([
    // A run of one row allows two runs per merge: 60 -> 30 -> 15 -> 8 -> 4 -> 2.
    ['one-row runs two at a time', 60, 1, ['merge-56', 'merge-57']],
    // The odd run passes through each round untouched: 33 -> 17 -> 9 -> 5 -> 3 -> 2.
    ['an odd run left over', 33, 1, ['merge-30', 'run-32']],
    // Many rows per run allow the 16-run maximum: 800 rows in more than 16 runs merge once into 2.
    ['many-row runs sixteen at a time', 800, 1024, ['merge-0', 'merge-1']],
  ])('merges %s in the order an in-memory sort gives', async (_case, count, sortRunBytes, merged) => {
    const tenants = [C, A, B];
    const rows = Array.from({ length: count }, (_, index) => ({
      tenantId: tenants[index % 3] as string,
      row: toUnitRow(KEYED, content((index * 37) % 1000, `t${String(index % 10)}`)),
    }));

    const spilled = await sortedOf(KEYED, rows, sortRunBytes);
    const [dir] = await leftovers();
    expect((await readdir(join(spillDir, dir ?? ''))).sort()).toEqual(merged);

    const inMemory = await sortedOf(KEYED, rows);
    const read = await readAll(spilled);
    expect(read).toEqual(await readAll(inMemory));
    expect(read).toEqual(expectedOrder(rows));
    // Key values are canonical text, so '10' sorts before '9'.
    const ids = read.filter(({ tenantId }) => tenantId === A).map(({ row }) => String(row.row.id));
    expect(ids).toEqual([...ids].sort());
    expect(ids).not.toEqual([...ids].sort((a, b) => Number(a) - Number(b)));
    expect(await leftovers()).toEqual([]);
  });

  it.each([1, undefined])('groups rows by tenant and reads tenants in ascending order (sortRunBytes %s)', async (sortRunBytes) => {
    const rows = [
      { tenantId: B, row: toUnitRow(KEYED, content(2, 'b2')) },
      { tenantId: A, row: toUnitRow(KEYED, content(9, 'a9')) },
      { tenantId: C, row: toUnitRow(KEYED, content(1, 'c1')) },
      { tenantId: A, row: toUnitRow(KEYED, content(10, 'a10')) },
      { tenantId: B, row: toUnitRow(KEYED, content(1, 'b1')) },
    ];
    const sorter = await sortedOf(KEYED, rows, sortRunBytes);
    const titles = async (tenantId: string): Promise<unknown[]> => {
      const read: unknown[] = [];
      for await (const row of sorter.rows(tenantId)) read.push(row.row.title);
      return read;
    };

    expect(sorter.tenants()).toEqual([A, B, C]);
    expect([A, B, C, 'tenant-z'].map((tenantId) => sorter.count(tenantId))).toEqual([2, 2, 1, 0]);
    expect(await titles('tenant-0')).toEqual([]);
    expect(await titles(A)).toEqual(['a10', 'a9']);
    // Tenant B is passed over: its rows are skipped, and an earlier tenant can no longer be read.
    expect(await titles(C)).toEqual(['c1']);
    expect(await titles('tenant-z')).toEqual([]);
    await expect(titles(B)).rejects.toThrow(`tenant ${B} is read after tenant tenant-z`);
    expect(await leftovers()).toEqual([]);
  });

  it.each<[string, (sorter: UnitRowSorter) => Promise<void>]>([
    ['disposed before reading', async (sorter) => sorter.dispose()],
    [
      'returned after its first row',
      async (sorter) => {
        for await (const row of sorter.rows(A)) {
          expect(row.row.id).toBe('1');
          break;
        }
      },
    ],
    [
      'interrupted by an iteration error',
      async (sorter) => {
        const rows = sorter.rows(A);
        await rows.next();
        await expect(rows.throw(new Error('consumer failed'))).rejects.toThrow('consumer failed');
      },
    ],
  ])('removes the spill directory when %s', async (_case, stop) => {
    const rows = [1, 2, 3].map((id) => ({ tenantId: A, row: toUnitRow(KEYED, content(id, 't')) }));
    const sorter = await sortedOf(KEYED, rows, 1);
    expect(await leftovers()).toHaveLength(1);

    await stop(sorter);
    expect(await leftovers()).toEqual([]);
    await sorter.dispose();
    await sorter.dispose();

    expect(await leftovers()).toEqual([]);
    await expect(sorter.rows(A).next()).rejects.toThrow('rows cannot be read from a disposed sorter');
  });

  it('removes the spill directory when rebuilding a row fails', async () => {
    const sorter = new UnitRowSorter(KEYED, () => { throw new Error('row rebuild failed'); }, { sortRunBytes: 1, spillDir });
    for (const id of [1, 2]) await sorter.add(A, toUnitRow(KEYED, content(id, 't')));
    await sorter.sort();
    expect(await leftovers()).toHaveLength(1);

    await expect(sorter.rows(A).next()).rejects.toThrow('row rebuild failed');
    expect(await leftovers()).toEqual([]);
  });

  it('removes the spill directory and rethrows when a spill run cannot be read', async () => {
    const rows = [1, 2].map((id) => ({ tenantId: A, row: toUnitRow(KEYED, content(id, 'title')) }));
    const sorter = await sortedOf(KEYED, rows, 1);
    const [dir] = await leftovers();
    await truncate(join(spillDir, dir ?? '', 'run-1'), 3);

    await expect(sorter.rows(A).next()).rejects.toThrow('ends inside a record header');
    expect(await leftovers()).toEqual([]);
  });

  it.each([
    ['adds after sorting', async (sorter: UnitRowSorter) => sorter.add(A, toUnitRow(KEYED, content(1, 't'))), 'rows cannot be added to a sorted sorter'],
    ['sorts twice', async (sorter: UnitRowSorter) => sorter.sort(), 'a sorted sorter cannot be sorted'],
  ])('rejects a sorter that %s', async (_case, misuse, message) => {
    const sorter = await sortedOf(KEYED, []);
    await expect(misuse(sorter)).rejects.toThrow(message);
  });

  it('rejects reading before sorting', async () => {
    const sorter = unitRowSorter(KEYED, { spillDir });
    await expect(sorter.rows(A).next()).rejects.toThrow('rows cannot be read from an unsorted sorter');
  });

  it('rejects a shape whose key column is not among its columns', () => {
    const columns: CanonicalColumn[] = [{ name: 'title', type: 's' }];
    expect(() => new UnitRowSorter({ keyed: true, keyColumns: ['id'], columns }, () => toUnitRow(KEYED, content(1, 't')))).toThrow(
      'key column id is not among the columns of the shape',
    );
  });
});
