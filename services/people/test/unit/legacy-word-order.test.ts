/** SQL Server's word sort of nvarchar text, recorded in the fixture, against text-order.ts. */
import { describe, expect, it } from 'vitest';
import { LEGACY_IGNORABLE_RANGES, LEGACY_SPECIAL_RANKS, compareLegacyText } from '../../src/domain/text-order.js';
import { FIXTURE, codes, nameRank, rank, type Name } from '../helpers/legacy-word-order.js';

/** Indexes of `ranks` in SQL Server's order, equal ranks in fixture order. */
function sqlServerOrder(ranks: readonly number[]): number[] {
  return ranks.map((_, index) => index).sort((a, b) => (ranks[a] as number) - (ranks[b] as number) || a - b);
}
const ORDER = sqlServerOrder(FIXTURE.ranks);
/** How many later values in SQL Server's order each value is compared with. */
const WINDOW = 40;

/** SQL Server's ORDER BY lname, fname of two names pairs: NULLs lowest, each name by `compareLegacyText`. */
function compareNames(a: readonly [Name, Name], b: readonly [Name, Name]): number {
  for (const at of [0, 1] as const) {
    const [x, y] = [a[at], b[at]];
    const order = x === null || y === null ? Number(y === null) - Number(x === null) : compareLegacyText(x, y);
    if (order !== 0) return order;
  }
  return 0;
}

describe('compareLegacyText against SQL Server SQL_Latin1_General_CP1_CI_AS', () => {
  it('weighs exactly the specials SQL Server weighs last, at their ranks', () => {
    const key = ([codePoint, at]: readonly [number, number]): string => `${codePoint}:${at}`;
    expect([...LEGACY_SPECIAL_RANKS].map(key).sort()).toEqual(FIXTURE.specials.map(key).sort());
  });

  it('ignores exactly the code points SQL Server ignores', () => {
    expect(LEGACY_IGNORABLE_RANGES).toEqual(FIXTURE.ignorables);
  });

  it('orders the corpus as SQL Server ranks it: 0 for equal ranks, below 0 for a lower rank', () => {
    const wrong: string[] = [];
    ORDER.forEach((a, at) => {
      for (const b of ORDER.slice(at + 1, at + 1 + WINDOW)) {
        const [x, y] = [FIXTURE.corpus[a] as string, FIXTURE.corpus[b] as string];
        const equal = FIXTURE.ranks[a] === FIXTURE.ranks[b];
        const [forward, back] = [compareLegacyText(x, y), compareLegacyText(y, x)];
        if (equal ? forward !== 0 || back !== 0 : forward >= 0 || back <= 0) wrong.push(`${codes(x)} vs ${codes(y)}: ${forward}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it('orders the names pairs by last then first name as SQL Server ranks them', () => {
    const wrong: string[] = [];
    const order = sqlServerOrder(FIXTURE.nameRanks);
    order.forEach((a, at) => {
      for (const b of order.slice(at + 1, at + 1 + WINDOW)) {
        const [x, y] = [FIXTURE.names[a] as [Name, Name], FIXTURE.names[b] as [Name, Name]];
        const equal = FIXTURE.nameRanks[a] === FIXTURE.nameRanks[b];
        const [forward, back] = [compareNames(x, y), compareNames(y, x)];
        if (equal ? forward !== 0 || back !== 0 : forward >= 0 || back <= 0) wrong.push(`${x.map(codes).join(' / ')} vs ${y.map(codes).join(' / ')}: ${forward}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it.each<[string, string]>([
    ['Jos\u00E9-Perez', 'Jose\u0301-Perez'],
    ['\uFB01-a', 'fi-a'],
    ['\uFB02-a', 'fl-a'],
    ['\uFB00-a', 'ff-a'],
    ['\uFB03-a', 'ffi-a'],
    ['\uFB04-a', 'ffl-a'],
    ['\u0132-a', 'IJ-a'],
    ['\u01C6-a', 'd\u017E-a'],
    ['\u01C5-a', 'D\u017E-a'],
    ['\u01F1-a', 'DZ-a'],
    ['\uFF41-b', 'a-b'],
    ['\uFF2F\uFF07\uFF28\uFF41\uFF52\uFF41', "O'Hara"],
    ['\u00B2-b', '2-b'],
    ['x\u00B2-y', 'x2-y'],
    ['a\u0323\u0301b', 'a\u0301\u0323b'],
    ['a\u200D-b', 'a-b'],
    ['a-\u200Db', 'a-b'],
    ['a\uFEFF-b', 'a-b'],
    ['a\u2060-b', 'a-b'],
    ['a\u034F-b', 'a-b'],
    ['a\u0640-b', 'a-b'],
    ['a\u0218-b', 'a-b'],
    ['a-\u0219b', 'a-b'],
    ['a\u0349-b', 'a-b'],
    ["O\u200D'Hara", "O'Hara"],
    ['Herman\u2060-Romaguera', 'Herman-Romaguera'],
    ['\u2071-b', '-b'],
    ['a\u{1F600}-c', 'a-c'],
    ['a-\u{1D400}c', 'a-c'],
  ])('holds %j equal to %j as SQL Server does', (a, b) => {
    expect(rank(a)).toBe(rank(b));
    expect(compareLegacyText(a, b)).toBe(0);
    expect(compareLegacyText(b, a)).toBe(0);
  });

  it.each<[string, string]>([
    ['Hermann', 'Herman-Romaguera'],
    ['HermanRomaguera', 'Herman-Romaguera'],
    ['Herman Romaguera', 'Hermann'],
    ['OConnell', "O'Connell"],
    ["O'Connell", "O'Hara"],
    ['Ohara', "O'Hara"],
    ['Greenfelder', 'Green-Klocko'],
    ['Connelly', 'Conn-Prohaska'],
    ['coop', "co'op"],
    ["co'op", 'co-op'],
    ['co-op', 'coo-p'],
    ['co-op', 'CO-OP'],
    ['abc', '-abc'],
    ['-abc', 'abc-'],
    ['abc', 'abc '],
    ['abc-', 'abc -'],
    ['abc-', 'abc- '],
    ["' '", '-'],
    ['', ' '],
    ['a\uFF0Db', 'a-b'],
    ['a\u00ADb', 'a\u2010b'],
    ['ab', 'a\u0001b'],
    ['resume-', 'résumé'],
    ['f-ia', '\uFB01-a'],
    ['-\uFB01a', 'fi-a'],
    ['x-\u00B2y', 'x\u00B2-y'],
    ['Jos\u00E9Perez', 'Jose\u0301-Perez'],
    ['Jose-Perez', 'Jos\u00E9-Perez'],
  ])('orders %j against %j as SQL Server does', (a, b) => {
    expect(Math.sign(compareLegacyText(a, b))).toBe(Math.sign(rank(a) - rank(b)));
    expect(Math.sign(compareLegacyText(b, a))).toBe(Math.sign(rank(b) - rank(a)));
  });

  it.each<[[Name, Name], [Name, Name]]>([
    [['Jose\u0301-Perez', 'Ada'], ['Jos\u00E9-Perez', 'Zoe']],
    [['fi-a', 'Amy'], ['\uFB01-a', 'Zed']],
  ])('orders %j before %j by first name, the last names being equal', (first, second) => {
    expect(nameRank(first)).toBeLessThan(nameRank(second));
    expect(compareNames(first, second)).toBeLessThan(0);
    expect(compareNames(second, first)).toBeGreaterThan(0);
  });
});
