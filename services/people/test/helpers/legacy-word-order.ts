/** The SQL Server-captured word-sort fixture shared by the offline and PostgreSQL legacy word-order suites. */
import { readFileSync } from 'node:fs';

export type Name = string | null;

export interface LegacyWordOrderFixture {
  specials: [number, number][];
  ignorables: [number, number][];
  corpus: string[];
  ranks: number[];
  names: [Name, Name][];
  nameRanks: number[];
}

export const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy-word-order.json', import.meta.url), 'utf8')) as LegacyWordOrderFixture;
const RANK = new Map(FIXTURE.corpus.map((value, index) => [value, FIXTURE.ranks[index] as number]));

/** The code points of `s`, so a failure names invisible characters. */
export function codes(s: Name): string {
  if (s === null) return 'NULL';
  return [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

/** The SQL Server rank of a corpus value. */
export function rank(value: string): number {
  const found = RANK.get(value);
  if (found === undefined) throw new Error(`${codes(value)} is not in the fixture corpus`);
  return found;
}

/** The SQL Server rank of a fixture names pair. */
export function nameRank(name: readonly [Name, Name]): number {
  const at = FIXTURE.names.findIndex(([lname, fname]) => lname === name[0] && fname === name[1]);
  if (at < 0) throw new Error(`${name.map(codes).join(' / ')} is not in the fixture names`);
  return FIXTURE.nameRanks[at] as number;
}
