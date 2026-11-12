/** The programs-sites ttrash share against table ownership, and its place in the mapping barrel. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeRow } from '@opt2/platform/migration-kit';
import { mappings, ttrashMapping, units } from '../../src/migration/mappings/index.js';
import { TRASH } from '../../src/repo/tables.js';

interface ClassMapEntry {
  classes: string[];
  owner?: string;
  ownerBy?: string;
  owners?: Record<string, string>;
}

interface Ownership {
  tables: {
    table: string;
    columns: string[];
    split?: { by: string; classMap: ClassMapEntry[] };
    targets?: { unit: string; owner: string; keyColumns: string[]; ownedColumns: string[]; rowPredicate: string }[];
  }[];
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const TTRASH = OWNERSHIP.tables.find((table) => table.table === 'ttrash');
const TARGET = TTRASH?.targets?.find((target) => target.unit === TRASH.unit);

const ROW = {
  objectID: 'A0B1C2D3-E4F5-A6B7-C8D9E0F1A2B3C4D5E',
  parentID: '00000000000000000000000000000000001',
  siteID: 'tenant-a',
  objectLabel: 'Site: options\r\n ',
  objectClass: 'extendObject',
  objectType: 'Site',
  objectSubType: 'Default',
  objectstring: '<wddxPacket version="1.0"><header/><data><struct/></data></wddxPacket>',
  deletedDate: new Date(2026, 5, 30, 12, 0, 0, 3),
  deletedBy: '',
  deleteid: null,
  orderno: 4,
};

describe('ttrash programs-sites share', () => {
  it('is assigned to programs-sites by table ownership through site extend objects', () => {
    expect(TARGET).toMatchObject({ owner: 'programs-sites', rowPredicate: 'classMap owner = programs-sites' });
    const extendObject = TTRASH?.split?.classMap.find((entry) => entry.classes.includes('extendObject'));
    expect(extendObject).toMatchObject({ ownerBy: 'baseTable' });
    expect(extendObject?.owners?.['tsettings']).toBe('programs-sites');
  });

  it('maps every owned column in catalog order, keyed by objectID, with the tenant of the row site', () => {
    expect(ttrashMapping.legacyColumns.map((column) => column.name)).toStrictEqual(TTRASH?.columns);
    expect([...ttrashMapping.legacyColumns.map((column) => column.name)].sort()).toStrictEqual([...(TARGET?.ownedColumns ?? [])].sort());
    expect(ttrashMapping.key).toStrictEqual(TARGET?.keyColumns);
    expect(ttrashMapping).toMatchObject({ legacyTable: 'ttrash', targetTable: TRASH.unit, unit: TRASH.unit });
    expect(ttrashMapping.tenant).toStrictEqual({ kind: 'site', column: 'siteID' });
  });

  it.each([
    [true, 'programs-sites'],
    [false, 'strategies-content'],
    [false, 'people'],
    [false, null],
  ])('answers %s for an apply row whose class-map owner is %s', (accepted, discriminator) => {
    expect(ttrashMapping.acceptsRow(ROW, discriminator)).toBe(accepted);
  });

  it('keeps an applied row byte-exact through the target table', () => {
    const encoding = encodeRow(ttrashMapping.legacyColumns, ROW);
    const target = ttrashMapping.toTarget(ttrashMapping.decodeLegacy(ttrashMapping.legacyColumns, encoding));
    expect(ttrashMapping.encodeLegacy(target)).toBe(encoding);
  });

  it('is the last barrel mapping, one per unit in UNITS order', () => {
    expect(mappings.at(-1)).toBe(ttrashMapping);
    expect(mappings.map((mapping) => mapping.unit)).toStrictEqual([...units]);
  });
});
