// Unit tests for the unit catalog's site-column lookup over the committed ownership file.
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
      'synthetic.export_definition': 'siteID',
      'synthetic.export_job': 'siteID',
      'synthetic.message': 'siteID',
      'synthetic.message_template': 'siteID',
      'synthetic.person_archive': 'siteID',
      'synthetic.signature_request': 'siteID',
      'synthetic.survey': 'siteID',
      'synthetic.survey_response': 'siteID',
    });
  });

  it.each([
    ['a dbo-qualified name in another case', 'dbo.TOAUTHCLIENTS', 'siteid'],
    ['a site column inside the key', 'tpermissions', null],
    ['the site table itself', 'tsettings', null],
    ['a split table resolved by siteID', 'ttrash', null],
    ['a pool table', 'tcontent', null],
    ['a table whose tenant comes from its parent', 'toauthtokens', null],
    ['a folded program table with a site column', 'Program_1.finance_record', null],
  ])('answers %s', (_label, table, expected) => {
    expect(catalog.siteColumnOf(table)).toBe(expected);
  });

  it('rejects a table the ownership file does not list', () => {
    expect(() => catalog.siteColumnOf('tnosuchtable')).toThrow(UnknownLegacyTableError);
  });
});
