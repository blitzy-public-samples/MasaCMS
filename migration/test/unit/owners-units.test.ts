// Unit tests for the unit catalog's site-column and object-column lookups over the committed ownership file.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { UnknownLegacyTableError, loadUnitCatalog } from '../../src/owners/index.js';

const config = loadConfig();
const catalog = loadUnitCatalog(config.paths.tableOwnership);
const tables = (JSON.parse(readFileSync(config.paths.tableOwnership, 'utf8')) as { tables: { table: string }[] }).tables.map((entry) => entry.table);

describe('UnitCatalog.siteColumnOf', () => {
  it('names the site column of exactly the siteID-resolved, unsplit tables whose key leaves the site out', () => {
    const sited = Object.fromEntries(tables.flatMap((table) => {
      const column = catalog.siteColumnOf(table);
      return column === null ? [] : [[table, column]];
    }));

    expect(sited).toEqual({
      toauthclients: 'siteid',
      tcontentrelated: 'siteID',
      tcontenttags: 'siteID',
      'synthetic.person_archive': 'siteID',
    });
  });

  it.each([
    ['a dbo-qualified name in another case', 'dbo.TOAUTHCLIENTS', 'siteid'],
    ['a site column inside the key', 'tpermissions', null],
    ['the site table itself', 'tsettings', null],
    ['a split table resolved by siteID', 'ttrash', null],
    ['a pool table', 'tcontent', null],
    ['a table whose tenant comes from its parent', 'toauthtokens', null],
  ])('answers %s', (_label, table, expected) => {
    expect(catalog.siteColumnOf(table)).toBe(expected);
  });

  it('rejects a table the ownership file does not list', () => {
    expect(() => catalog.siteColumnOf('tnosuchtable')).toThrow(UnknownLegacyTableError);
  });
});

describe('LegacyTableTarget.objectColumns', () => {
  const targets = tables.flatMap((table) => catalog.unitsForLegacyTable(table));

  it('maps no committed target to an object bucket', () => {
    const backed = Object.fromEntries(targets.flatMap((target) => (Object.keys(target.objectColumns).length === 0 ? [] : [[target.unit, target.objectColumns]])));

    expect(targets.length).toBeGreaterThan(0);
    expect(backed).toEqual({});
  });

  it.each([
    ['a synthetic table', 'synthetic.person_archive', 'people.person_archive'],
    ['a table without object columns', 'tcontent', 'content.content'],
  ])('freezes the object columns of %s', (_label, table, unit) => {
    const target = catalog.unitsForLegacyTable(table).find((candidate) => candidate.unit === unit);

    expect(target).toBeDefined();
    expect(Object.isFrozen(target?.objectColumns)).toBe(true);
  });
});
