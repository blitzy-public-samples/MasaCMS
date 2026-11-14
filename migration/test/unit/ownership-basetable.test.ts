// Checks the class-extension and trash baseTable owners of the committed ownership file against the file itself.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

interface OwnershipTable {
  table: string;
  owner: string;
  split?: { baseTableOwners?: Record<string, string>; classMap?: { classes: string[]; owners?: Record<string, string> }[] };
  targets: { unit: string; owner: string; rowPredicate: string | null }[];
}

const config = loadConfig();
const doc = JSON.parse(readFileSync(config.paths.tableOwnership, 'utf8')) as { tables: OwnershipTable[] };
const tables = new Map(doc.tables.map((table) => [table.table, table]));
const dataOwners = new Set<string>(config.dataOwners);

// User and both Address spellings go to people; every other data-owner table to its owner, Program_N as Program_1/2.
const expected: Record<string, string> = { tusers: 'people', tusersaddresses: 'people', tuseraddresses: 'people' };
for (const { table, owner } of doc.tables) {
  if (!dataOwners.has(owner)) continue;
  const names = table.startsWith('Program_N.') ? [1, 2].map((n) => table.replace('Program_N.', `Program_${n}.`)) : [table];
  for (const name of names) expected[name] = owner;
}
const resolvedOwners = [...new Set(Object.values(expected))].sort();

function tableOf(name: string): OwnershipTable {
  const table = tables.get(name);
  if (table === undefined) throw new Error(`${name} is not in ${config.paths.tableOwnership}`);
  return table;
}

describe('baseTable owners in opt2/table-ownership.json', () => {
  it.each(['tclassextend', 'tclassextendsets', 'tclassextendattributes', 'tclassextendrcsets', 'tclassextenddata'])(
    '%s maps every resolvable baseTable and has one target per owner over exactly its keys',
    (name) => {
      const table = tableOf(name);
      expect(table.split?.baseTableOwners).toEqual(expected);
      expect(table.targets.map((target) => target.owner).sort()).toEqual(resolvedOwners);
      for (const target of table.targets) {
        const literals = [...new Set([...(target.rowPredicate ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]))].sort();
        const keys = Object.keys(expected).filter((key) => expected[key] === target.owner).sort();
        expect(literals, target.unit).toEqual(keys);
      }
    },
  );

  it('gives ttrash extendObject rows the same owners, each with one classMap target', () => {
    const trash = tableOf('ttrash');
    expect(trash.split?.classMap?.find((entry) => entry.classes.includes('extendObject'))?.owners).toEqual(expected);
    const counts = resolvedOwners.map((owner) => trash.targets.filter((t) => t.rowPredicate === `classMap owner = ${owner}`).length);
    expect(counts).toEqual(resolvedOwners.map(() => 1));
  });
});
