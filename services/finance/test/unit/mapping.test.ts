// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The finance mappings against table ownership and the finance tables: column coverage, units, keys, Program_<id> tenancy and byte-exact round trips. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  LEGACY_PROGRAM_ID_COLUMN,
  MappingError,
  diffCoverage,
  encodeRow,
  mappingCoverage,
  resolveTenant,
  type CanonicalColumn,
  type CanonicalValue,
  type Mapping,
  type TenantLookups,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import {
  financeAttachmentMapping,
  financeRecordMapping,
  financeRecordVersionMapping,
  financeRollupMapping,
  mappings,
  units,
} from '../../src/migration/mappings/index.js';
import { ATTACHMENT_CONTENT_FIELD, FINANCE_ROLLUP, OWNED_TABLES, OWNER, UNITS } from '../../src/repo/tables.js';

const PROGRAM_ID = 1;
const LOOKUPS: TenantLookups = {
  umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
  programSiteId: (programId) => (programId === PROGRAM_ID ? TENANT_A.siteId : null),
};
/** Target columns the finance tables add to the mapped ones: the tenant, the attachment object key and the row version. */
const TARGET_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'object_key', 'row_version']);
/** Columns the fixture DDL declares NULL; every other sample value is non-null. */
const NULLABLE: Readonly<Record<string, readonly string[]>> = { finance_record: ['lastUpdate', 'lastUpdateByID'] };

interface OwnershipTarget {
  unit: string;
  keyColumns: string[];
  ownedColumns: string[];
  objectColumns?: Record<string, string>;
}

interface OwnershipTable {
  table: string;
  programFold?: boolean;
  tenantResolution: string | null;
  rowIdentity: 'key' | 'multiset';
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

/** A finance target of table ownership with the bare table name its folded mapping declares. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
  legacyTable: string;
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? [])
    .filter((target) => OWNED_UNITS.has(target.unit))
    .map((target) => ({ table, target, legacyTable: table.programFold === true ? (table.table.split('.').at(-1) ?? '') : table.table })),
);

/** The one mapping of the target's legacy table onto its unit. */
function mappingFor({ legacyTable, target }: OwnedTarget): Mapping {
  const found = mappings.filter((mapping) => mapping.legacyTable === legacyTable && mapping.unit === target.unit);
  const [mapping] = found;
  if (found.length !== 1 || mapping === undefined) throw new Error(`${String(found.length)} mappings of ${legacyTable} onto ${target.unit}`);
  return mapping;
}

/** A driver-shaped legacy value for `column`, distinct per column position. */
function sampleValue(column: CanonicalColumn, position: number): unknown {
  switch (column.type) {
    case 's':
      return `${column.name}:\r\n${String(position)} `;
    case 'i':
      return position + 1;
    case 'd':
      return `-${String(position)}.0125`;
    case 't':
      return new Date(2026, 5, 30, 12, 0, position, 3);
    default:
      throw new Error(`no finance column has canonical type ${column.type}`);
  }
}

/** A sample legacy row of `mapping`, its nullable columns NULL. */
function sampleRow(mapping: Mapping): Record<string, unknown> {
  const nullable = new Set(NULLABLE[mapping.legacyTable] ?? []);
  return Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, nullable.has(column.name) ? null : sampleValue(column, position)]),
  );
}

/** The canonical encoding of a sample row and the owned values `decodeLegacy` reads from it. */
function decodedSample(mapping: Mapping): { row: Record<string, unknown>; encoding: string; decoded: Record<string, CanonicalValue> } {
  const row = sampleRow(mapping);
  const encoding = encodeRow(mapping.legacyColumns, row);
  return { row, encoding, decoded: mapping.decodeLegacy(mapping.legacyColumns, encoding) };
}

describe('finance mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to finance, besides its object columns', () => {
    const expected = Object.fromEntries(
      OWNED_TARGETS.map(({ legacyTable, target }) => [
        legacyTable,
        target.ownedColumns.filter((column) => !Object.hasOwn(target.objectColumns ?? {}, column)),
      ]),
    );
    const diff = diffCoverage(expected, mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('names one object column, the attachment content that toTarget carries', () => {
    const objectColumns = OWNED_TARGETS.flatMap(({ legacyTable, target }) =>
      Object.entries(target.objectColumns ?? {}).map(([column, bucket]) => [legacyTable, column, bucket]),
    );

    expect(objectColumns).toStrictEqual([['finance_attachment', ATTACHMENT_CONTENT_FIELD, 'finance-attachments']]);
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.legacyTable, entry.target.unit, entry] as const))(
    'maps %s onto %s with its key, folded under its Program_<id> tenant',
    (_legacyTable, unit, entry) => {
      const mapping = mappingFor(entry);

      expect(mapping.targetTable).toBe(unit);
      expect(mapping.key).toStrictEqual(entry.target.keyColumns);
      expect(mapping.keyless).toBe(entry.table.rowIdentity === 'multiset');
      expect([entry.table.programFold, mapping.fold]).toStrictEqual([true, 'Program']);
      expect([entry.table.tenantResolution, mapping.tenant]).toStrictEqual(['program_site', { kind: 'program' }]);
    },
  );

  it('declares one mapping per finance unit in UNITS order and exposes UNITS as its units', () => {
    expect(mappings.map((mapping) => mapping.unit)).toStrictEqual([...UNITS]);
    expect([...OWNED_UNITS].sort()).toStrictEqual([...UNITS].sort());
    expect(units).toBe(UNITS);
    expect(Object.isFrozen(mappings)).toBe(true);
  });

  it('lists the named mappings in the barrel, record before its children', () => {
    const named = [financeRecordMapping, financeRecordVersionMapping, financeAttachmentMapping, financeRollupMapping];

    expect(mappings.map((mapping) => named.indexOf(mapping))).toStrictEqual([0, 1, 2, 3]);
  });

  it.each(mappings.map((mapping) => [mapping.unit, mapping] as const))(
    'targets the %s columns of its finance table besides tenant_id, object_key and row_version',
    (unit, mapping) => {
      const table = OWNED_TABLES.find((definition) => definition.unit === unit);

      expect(mapping.targetColumns).toStrictEqual(table?.columns.filter((column) => !TARGET_MANAGED.has(column.name)));
    },
  );

  it('keys rollups on the fixture (period, state): the finance.rollup key without the fold column', () => {
    expect(financeRollupMapping.key).toStrictEqual(['period', 'state']);
    expect(FINANCE_ROLLUP.key).toStrictEqual([LEGACY_PROGRAM_ID_COLUMN, 'period', 'state']);
  });
});

describe('row round trips', () => {
  it.each(mappings.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'keeps a sample Program_1.%s row byte-exact through its target row, under the tenant of the program site',
    (_legacyTable, mapping) => {
      const { row, encoding, decoded } = decodedSample(mapping);
      const target = mapping.toTarget(decoded, { legacyProgramId: PROGRAM_ID });

      expect(mapping.acceptsRow(row)).toBe(true);
      expect(target[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(PROGRAM_ID));
      expect(mapping.encodeLegacy(target)).toBe(encoding);
      expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS, { legacyProgramId: PROGRAM_ID })).toStrictEqual({
        tenantId: tenantIdForSite(TENANT_A.siteId),
        siteId: TENANT_A.siteId,
        orphan: false,
      });
    },
  );

  it('keeps the NULL lastUpdate and lastUpdateByID of a never-edited record NULL', () => {
    const target = financeRecordMapping.toTarget(decodedSample(financeRecordMapping).decoded, { legacyProgramId: PROGRAM_ID });

    expect([target.lastupdate, target.lastupdatebyid]).toStrictEqual([null, null]);
  });

  it.each(mappings.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'refuses a folded %s row without its legacyProgramId',
    (_legacyTable, mapping) => {
      expect(() => mapping.toTarget(decodedSample(mapping).decoded)).toThrow(MappingError);
    },
  );
});

describe('finance attachment content', () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x0d]);
  const { decoded } = decodedSample(financeAttachmentMapping);
  const columnsOnly = financeAttachmentMapping.toTarget(decoded, { legacyProgramId: PROGRAM_ID });

  it('keeps content out of the row encoding and the target row of a row without it', () => {
    expect(financeAttachmentMapping.legacyColumns.map((column) => column.name)).not.toContain(ATTACHMENT_CONTENT_FIELD);
    expect(Object.keys(columnsOnly)).not.toContain(ATTACHMENT_CONTENT_FIELD);
    expect(Object.isFrozen(financeAttachmentMapping)).toBe(true);
  });

  it.each([['content'], ['CONTENT'], ['Content']])('carries the legacy bytes of a %s column under content', (name) => {
    const target = financeAttachmentMapping.toTarget({ ...decoded, [name]: bytes }, { legacyProgramId: PROGRAM_ID });

    expect(target).toStrictEqual({ ...columnsOnly, [ATTACHMENT_CONTENT_FIELD]: bytes });
    expect(target[ATTACHMENT_CONTENT_FIELD]).toBe(bytes);
  });
});
