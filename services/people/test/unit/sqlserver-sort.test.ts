/** sqlServerSortOrder against orders SQL Server 2022 returned for `select * … order by isPrimary desc` over rows read in addressID order. */
import { describe, expect, it } from 'vitest';
import { sqlServerSortOrder } from '../../src/repo/sqlserver-sort.js';

/** Rows of `isPrimary` values in input order, one character each, `N` for NULL. */
function rowsOf(values: string): { index: number; isprimary: number | null }[] {
  return [...values].map((value, index) => ({ index, isprimary: value === 'N' ? null : Number(value) }));
}

describe('sqlServerSortOrder', () => {
  // Each expected order was read back from SQL Server 2022 (tempdb copy of tuseraddresses, clustered on addressID).
  it.each([
    ['one run keeps its input order', '000', [0, 1, 2]],
    ['equal keys keep their input order', '11', [0, 1]],
    ['one primary rotates the rows after it to the front', '0010', [2, 3, 0, 1]],
    ['one primary second of four', '0100', [1, 2, 3, 0]],
    ['one primary second of three', '010', [1, 2, 0]],
    ['one primary sixth of twenty', '00000100000000000000', [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 0, 1, 2, 3, 4]],
    ['a merge keeps taking from its side through ties', '1010', [0, 2, 3, 1]],
    ['runs of equal bit length start on the left', '10111', [0, 2, 3, 4, 1]],
    ['a right run of more bits starts the merge', '101111', [2, 3, 4, 5, 0, 1]],
    ['a right run of four after one of three starts the merge', '1101111', [3, 4, 5, 6, 0, 1, 2]],
    ['runs of three and three start on the left', '110111', [0, 1, 3, 4, 5, 2]],
    ['three key values', '1210', [1, 2, 0, 3]],
    ['NULL sorts last', 'N1', [1, 0]],
    ['NULL keys keep their input order', 'NN', [0, 1]],
  ])('%s (%s)', (_label, values, expected) => {
    const sorted = sqlServerSortOrder(rowsOf(values), (a, b) => (b.isprimary ?? -1) - (a.isprimary ?? -1));
    expect(sorted.map((row) => row.index)).toEqual(expected);
  });

  it('returns no rows for none', () => {
    expect(sqlServerSortOrder([], () => 0)).toEqual([]);
  });
});
