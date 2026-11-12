/** The stub mappings against table ownership: no legacy table, target or unit belongs to the stub, and none is mapped. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffCoverage, mappingCoverage } from '@opt2/platform/migration-kit';
import { mappings } from '../../src/migration/mappings/index.js';

const OWNER = 'stub';
const UNIT_PREFIX = `${OWNER}.`;

interface OwnershipTarget {
  unit: string;
  owner?: string;
  rowPredicate?: string | null;
  ownedColumns?: string[];
}

interface OwnershipTable {
  table: string;
  owner: string;
  split?: { by: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: ReadonlySet<string> = new Set(
  OWNERSHIP.units.filter((unit) => unit.owner === OWNER || unit.unit.startsWith(UNIT_PREFIX)).map((unit) => unit.unit),
);

/** `<table>`, or `<table>{<by>=<value>}` for a split table, the value taken from the target's row predicate. */
function coverageKeyOf(table: OwnershipTable, target: OwnershipTarget): string {
  if (table.split === undefined) return table.table;
  const value = /=\s*'?([^']+?)'?$/.exec(target.rowPredicate ?? '')?.[1];
  if (value === undefined) throw new Error(`${table.table}: split target ${target.unit} has no row predicate value`);
  return `${table.table}{${table.split.by}=${value}}`;
}

const OWNED_TARGETS = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? [])
    .filter((target) => target.owner === OWNER || target.unit.startsWith(UNIT_PREFIX) || OWNED_UNITS.has(target.unit))
    .map((target) => ({ table, target, coverageKey: coverageKeyOf(table, target) })),
);

describe('stub table ownership', () => {
  it('assigns no unit to stub', () => {
    expect([...OWNED_UNITS]).toStrictEqual([]);
  });

  it('assigns no legacy table or target to stub', () => {
    expect(OWNERSHIP.tables.filter((table) => table.owner === OWNER).map((table) => table.table)).toStrictEqual([]);
    expect(OWNED_TARGETS.map(({ table, target }) => `${table.table} -> ${target.unit}`)).toStrictEqual([]);
  });
});

describe('stub mapping coverage', () => {
  it('has no mappings', () => {
    expect(mappings).toHaveLength(0);
    expect(mappingCoverage(mappings)).toStrictEqual({});
  });

  it('maps exactly the legacy columns table ownership assigns to stub', () => {
    const actual = mappingCoverage(mappings);
    const expected = Object.fromEntries(
      OWNED_TARGETS.map(({ target, coverageKey }) => [coverageKey, target.ownedColumns ?? actual[coverageKey] ?? []]),
    );
    const diff = diffCoverage(expected, actual);

    expect(expected).toStrictEqual({});
    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });
});
