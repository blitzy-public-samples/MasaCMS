// Unit tests for the partition of live legacy tables into migratable logical tables and skipped ones, over a fake unit catalog.
import { describe, expect, it } from 'vitest';

import { parseQualifiedName, type LegacyTableRef } from '../../../src/extract/catalog.js';
import { DYNAMIC_TABLE_PATTERN, migratableTables, partitionLegacyTables } from '../../../src/extract/tables.js';
import {
  UnitCatalogError,
  UnknownLegacyTableError,
  type DataOwner,
  type LegacyTableOwner,
  type UnitCatalog,
} from '../../../src/owners/units.js';

/** One ownership entry of the fake catalog; `migratable` defaults to having owners. */
interface FakeTable {
  readonly owner: LegacyTableOwner;
  readonly owners?: readonly DataOwner[];
  readonly keyColumns?: readonly string[];
  readonly migratable?: boolean;
}

const PROGRAM_TABLE = /^Program_(\d+)\.(.+)$/i;

/** Entries shaped as `opt2/table-ownership.json` records them; `fb_contactus` is made migratable on purpose. */
const TABLES: Readonly<Record<string, FakeTable>> = {
  tusers: { owner: 'split', owners: ['identity', 'people'], keyColumns: ['UserID'] },
  tcontent: { owner: 'strategies-content', owners: ['strategies-content'], keyColumns: ['tcontent_ID'] },
  temailstats: { owner: 'communications', owners: ['communications'], keyColumns: [] },
  'Program_N.timesheet': { owner: 'timesheets', owners: ['timesheets'], keyColumns: ['timesheet_id'] },
  'synthetic.timesheet_transition': { owner: 'timesheets' },
  tplugins: { owner: 'decision-list' },
  tcontenteventreminders: { owner: 'decision-list' },
  tglobals: { owner: 'retired' },
  fb_contactus: { owner: 'strategies-content', owners: ['strategies-content'], keyColumns: ['id'] },
};

function unused(method: string): () => never {
  return () => {
    throw new Error(`fake catalog: ${method} is not used by the partition`);
  };
}

/** Catalog over `tables`; a name in `failures` throws its error from every lookup. */
function fakeCatalog(tables: Readonly<Record<string, FakeTable>> = TABLES, failures: Readonly<Record<string, Error>> = {}): UnitCatalog {
  const entry = (table: string): FakeTable => {
    const failure = failures[table];
    if (failure !== undefined) throw failure;
    const found = tables[table];
    if (found === undefined) throw new UnknownLegacyTableError(table);
    return found;
  };
  const isMigratable = (table: string): boolean => {
    const found = entry(table);
    return found.migratable ?? (found.owners ?? []).length > 0;
  };
  return {
    units: unused('units'),
    unit: unused('unit'),
    ownerOf: unused('ownerOf'),
    unitsOfOwner: unused('unitsOfOwner'),
    legacyTablesOf: unused('legacyTablesOf'),
    unitsForLegacyTable: unused('unitsForLegacyTable'),
    siteColumnOf: unused('siteColumnOf'),
    foldProgramTable: (table) => {
      const match = PROGRAM_TABLE.exec(table);
      const generic = match?.[2] === undefined ? undefined : `Program_N.${match[2]}`;
      if (generic === undefined || !(generic in tables)) return { legacyTable: table, programId: null };
      return { legacyTable: generic, programId: Number(match?.[1]) };
    },
    legacyTableOwner: (table) => entry(table).owner,
    isMigratable,
    isSplit: (table) => entry(table).owner === 'split',
    ownersForLegacyTable: (table) => entry(table).owners ?? [],
    keyColumnsOf: (table) => {
      if (!isMigratable(table)) throw new UnitCatalogError(`legacy table ${table} is not migratable`);
      return entry(table).keyColumns ?? [];
    },
  };
}

function ref(qualified: string): LegacyTableRef {
  return { ...parseQualifiedName(qualified), qualified };
}

const refs = (...names: string[]): LegacyTableRef[] => names.map(ref);

describe('DYNAMIC_TABLE_PATTERN', () => {
  it.each<[string, boolean]>([
    ['fb_contactus', true],
    ['FB_ContactUs', true],
    ['fb_', true],
    ['tfb_contactus', false],
    ['fbcontactus', false],
    ['tcontent', false],
  ])('matches %s: %s', (table, expected) => {
    expect(DYNAMIC_TABLE_PATTERN.test(table)).toBe(expected);
  });
});

describe('partitionLegacyTables', () => {
  it.each<[string, string, LegacyTableOwner | 'unassigned']>([
    ['decision-list table', 'tplugins', 'decision-list'],
    ['decision-list table', 'tcontenteventreminders', 'decision-list'],
    ['live form-builder table the catalog calls migratable', 'fb_contactus', 'decision-list'],
    ['form-builder table in upper case the catalog does not know', 'FB_Survey', 'decision-list'],
    ['retired table', 'tglobals', 'retired'],
    ['fixture table the catalog marks unmigrated', 'synthetic.timesheet_transition', 'timesheets'],
    ['table without an ownership entry', 'tnotinfile', 'unassigned'],
    ['program table without a folded entry', 'Program_3.unregistered', 'unassigned'],
  ])('skips a %s (%s) under owner %s', (_label, table, owner) => {
    const partition = partitionLegacyTables(fakeCatalog(), refs(table, 'tcontent'));

    expect(partition.skipped).toEqual([{ name: table, owner, physical: [ref(table)] }]);
    expect(partition.migratable.map((migratable) => migratable.name)).toEqual(['tcontent']);
  });

  it.each<[string, Error]>([
    ['UnitCatalogError', new UnitCatalogError('ownership file is malformed')],
    ['TypeError', new TypeError('lookup failed')],
  ])('propagates a %s from the catalog', (_label, failure) => {
    const catalog = fakeCatalog(TABLES, { tcontent: failure });

    expect(() => partitionLegacyTables(catalog, refs('tcontent'))).toThrow(failure);
  });

  it('folds Program_<id> parts fed out of order into one table ordered by program id', () => {
    const live = refs('Program_2.timesheet', 'tcontent', 'Program_1.timesheet');

    const { migratable, skipped } = partitionLegacyTables(fakeCatalog(), live);

    expect(skipped).toEqual([]);
    expect(migratable).toStrictEqual([
      {
        name: 'Program_N.timesheet',
        owner: 'timesheets',
        owners: ['timesheets'],
        physical: [
          { ref: ref('Program_1.timesheet'), programId: 1 },
          { ref: ref('Program_2.timesheet'), programId: 2 },
        ],
        folded: true,
        keyColumns: ['timesheet_id'],
      },
      {
        name: 'tcontent',
        owner: 'strategies-content',
        owners: ['strategies-content'],
        physical: [{ ref: ref('tcontent') }],
        folded: false,
        keyColumns: ['tcontent_ID'],
      },
    ]);
  });

  it.each<[string, DataOwner | 'split', readonly DataOwner[], readonly string[]]>([
    ['tusers', 'split', ['identity', 'people'], ['UserID']],
    ['tcontent', 'strategies-content', ['strategies-content'], ['tcontent_ID']],
    ['temailstats', 'communications', ['communications'], []],
  ])('gives %s owner %s, its owners and its key columns', (table, owner, owners, keyColumns) => {
    const [migratable] = partitionLegacyTables(fakeCatalog(), refs(table)).migratable;

    expect(migratable).toMatchObject({ name: table, owner, owners, keyColumns, folded: false });
  });

  it('throws UnitCatalogError for a migratable table without owners', () => {
    const catalog = fakeCatalog({ tcontent: { owner: 'strategies-content', owners: [], migratable: true } });

    expect(() => partitionLegacyTables(catalog, refs('tcontent'))).toThrow(UnitCatalogError);
    expect(() => partitionLegacyTables(catalog, refs('tcontent'))).toThrow('legacy table tcontent is migratable but has no owner');
  });

  it('sorts both sides by name in code-unit order', () => {
    const live = refs(
      'tusers',
      'tplugins',
      'temailstats',
      'tglobals',
      'tcontent',
      'synthetic.timesheet_transition',
      'Program_1.timesheet',
      'fb_contactus',
      'Program_3.unregistered',
    );

    const { migratable, skipped } = partitionLegacyTables(fakeCatalog(), live);

    expect(migratable.map((table) => table.name)).toEqual(['Program_N.timesheet', 'tcontent', 'temailstats', 'tusers']);
    expect(skipped.map((table) => table.name)).toEqual([
      'Program_3.unregistered',
      'fb_contactus',
      'synthetic.timesheet_transition',
      'tglobals',
      'tplugins',
    ]);
  });

  it('returns empty sides for no live tables', () => {
    expect(partitionLegacyTables(fakeCatalog(), [])).toEqual({ migratable: [], skipped: [] });
  });

  it('freezes the partition, its tables and their physical parts', () => {
    const partition = partitionLegacyTables(fakeCatalog(), refs('Program_1.timesheet', 'tusers', 'tglobals'));
    const migratable = partition.migratable;
    const skipped = partition.skipped;

    expect([partition, migratable, skipped].every(Object.isFrozen)).toBe(true);
    expect(migratable.every((table) => Object.isFrozen(table) && Object.isFrozen(table.physical))).toBe(true);
    expect(migratable.flatMap((table) => table.physical).every(Object.isFrozen)).toBe(true);
    expect(skipped.every((table) => Object.isFrozen(table) && Object.isFrozen(table.physical))).toBe(true);
  });
});

describe('migratableTables', () => {
  it('returns the migratable side of the partition', () => {
    const live = refs('tusers', 'tplugins', 'Program_2.timesheet', 'Program_1.timesheet', 'tglobals');

    expect(migratableTables(fakeCatalog(), live)).toEqual(partitionLegacyTables(fakeCatalog(), live).migratable);
  });
});
