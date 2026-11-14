// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The finance mappings against table ownership and the finance tables: column coverage, units, keys, the Program_<id> fold and its tenancy, the split Masa shares, canonical value forms, byte-exact round trips and the program binding of applies. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  LEGACY_PROGRAM_ID_COLUMN,
  MappingError,
  decodeRow,
  diffCoverage,
  encodeRow,
  encodeValue,
  mappingCoverage,
  parseProgramTable,
  programTableName,
  resolveTenant,
  roundToSqlServerDatetime,
  type ApplyRequest,
  type ApplyResponse,
  type CanonicalColumn,
  type CanonicalValue,
  type Mapping,
  type TenantLookups,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, type TenantFixture } from '@opt2/platform/testing';
import {
  FINANCE_BASE_TABLES,
  PROGRAM_SITES,
  financeAttachmentMapping,
  financeRecordMapping,
  financeRecordVersionMapping,
  financeRollupMapping,
  mappings,
  tclassextendMapping,
  tclassextendattributesMapping,
  tclassextenddataMapping,
  tclassextendrcsetsMapping,
  tclassextendsetsMapping,
  ttrashMapping,
  units,
} from '../../src/migration/mappings/index.js';
import {
  ATTACHMENT_CONTENT_FIELD,
  EXTEND_SUBTYPE,
  FINANCE_RECORD,
  FINANCE_ROLLUP,
  OWNED_TABLES,
  OWNER,
  PROGRAM_BINDING,
  SCHEMA,
  UNITS,
} from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type RecordedWrite, type TestApp } from '../helpers/app.js';
import { PROGRAM_FOR_SITE, attachmentRow, recordRow } from '../helpers/records.js';

const PROGRAM_ID = 1;
/** Tenant lookups as `synthetic.program_site` answers them: program 1 is tenant-a, program 2 tenant-b. */
const LOOKUPS: TenantLookups = {
  umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
  programSiteId: (programId) => Object.keys(PROGRAM_FOR_SITE).find((site) => PROGRAM_FOR_SITE[site] === programId) ?? null,
};
/** The two fixture programs with the tenant each folds into. */
const PROGRAMS: readonly { program: number; tenant: TenantFixture }[] = [TENANT_A, TENANT_B].map((tenant) => ({
  program: programOf(tenant.siteId),
  tenant,
}));
/** Target columns the finance tables add to the mapped ones: the tenant, the attachment object key and the row version. */
const TARGET_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'object_key', 'row_version']);
/** Columns the fixture DDL declares NULL; every other sample value is non-null. */
const NULLABLE: Readonly<Record<string, readonly string[]>> = { finance_record: ['lastUpdate', 'lastUpdateByID'] };

interface OwnershipTarget {
  unit: string;
  rowPredicate: string | null;
  keyColumns: string[];
  ownedColumns: string[];
  objectColumns?: Record<string, string>;
}

interface OwnershipTable {
  table: string;
  programFold?: boolean;
  tenantResolution: string | null;
  rowIdentity: 'key' | 'multiset';
  split?: { by: string };
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
/** `synthetic.program_site` as `010_program_site.sql` seeds it, keyed by program id. */
const PROGRAM_SITE_ROWS = Object.fromEntries(
  [...readFileSync(new URL('../../../../legacy-fixtures/sql/010_program_site.sql', import.meta.url), 'utf8').matchAll(/\((\d+), N'([^']+)'\)/g)].map(
    (match) => [Number(match[1]), match[2]],
  ),
);
const OWNED_UNITS: ReadonlySet<string> = new Set(OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit));
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? [])
    .filter((target) => OWNED_UNITS.has(target.unit))
    .map((target) => ({ table, target, legacyTable: table.programFold === true ? (table.table.split('.').at(-1) ?? '') : table.table })),
);
/** Targets folded from the `Program_<id>` fixture schemas, and finance's shares of split Masa dbo tables. */
const FOLDED_TARGETS = OWNED_TARGETS.filter((entry) => entry.table.programFold === true);
const SHARED_TARGETS = OWNED_TARGETS.filter((entry) => entry.table.programFold !== true);
const FOLDED_MAPPINGS = mappings.filter((mapping) => mapping.fold === 'Program');
const SHARED_MAPPINGS = mappings.filter((mapping) => mapping.fold === undefined);
/** The finance shares of the class-extension tables, split by their subtype's baseTable. */
const EXTENSION_MAPPINGS = [tclassextendMapping, tclassextendsetsMapping, tclassextendattributesMapping, tclassextendrcsetsMapping, tclassextenddataMapping];

/** Values a split target's row predicate names: the list of `<column> in ('a', 'b')`, or the owner of `classMap owner = <owner>`. */
function predicateValues(predicate: string | null): string[] {
  const listed = /\bin \(([^)]*)\)$/.exec(predicate ?? '')?.[1];
  if (listed !== undefined) return listed.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
  const owner = /^classMap owner = (\S+)$/.exec(predicate ?? '')?.[1];
  if (owner === undefined) throw new Error(`row predicate ${JSON.stringify(predicate)} names no split values`);
  return [owner];
}

/** The key `mappingCoverage` files a target under: its legacy table, suffixed `{<by>=<values>}` when the table is split. */
function coverageKeyOf({ table, target, legacyTable }: OwnedTarget): string {
  return table.split === undefined ? legacyTable : `${legacyTable}{${table.split.by}=${predicateValues(target.rowPredicate).join(',')}}`;
}

/** The values a split mapping accepts, as a list. */
function splitValuesOf(mapping: Mapping): (string | number)[] {
  return mapping.split === undefined ? [] : [mapping.split.value].flat();
}

/** `Program_<id>` schema of a fixture site. */
function programOf(siteId: string): number {
  const program = PROGRAM_FOR_SITE[siteId];
  if (program === undefined) throw new Error(`site ${siteId} has no Program_<id> schema`);
  return program;
}

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
    case 'f':
      return position + 0.25;
    case 't':
      return new Date(2026, 5, 30, 12, 0, position, 3);
    default:
      throw new Error(`no finance column has canonical type ${column.type}`);
  }
}

/** A sample legacy row of `mapping`, its nullable columns NULL; a site-tenanted row is of site tenant-a and in finance's split share. */
function sampleRow(mapping: Mapping): Record<string, unknown> {
  const nullable = new Set(NULLABLE[mapping.legacyTable] ?? []);
  const row: Record<string, unknown> = Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, nullable.has(column.name) ? null : sampleValue(column, position)]),
  );
  if (mapping.tenant?.kind === 'site') row[mapping.tenant.column] = TENANT_A.siteId;
  if (mapping.split?.column !== undefined) row[mapping.split.column] = splitValuesOf(mapping)[0];
  return row;
}

/** The apply-row discriminator finance's share of a split table without a discriminator column carries. */
function discriminatorOf(mapping: Mapping): string | number | undefined {
  return mapping.split?.column === undefined ? splitValuesOf(mapping)[0] : undefined;
}

/** The canonical encoding of a sample row and the owned values `decodeLegacy` reads from it. */
function decodedSample(mapping: Mapping): { row: Record<string, unknown>; encoding: string; decoded: Record<string, CanonicalValue> } {
  const row = sampleRow(mapping);
  const encoding = encodeRow(mapping.legacyColumns, row);
  return { row, encoding, decoded: mapping.decodeLegacy(mapping.legacyColumns, encoding) };
}

/** A legacy row's encoding, its Program_1 target row, and the encoding of the legacy row that target maps back to. */
function roundTrip(mapping: Mapping, row: Readonly<Record<string, unknown>>): { encoding: string; target: Record<string, unknown>; back: string } {
  const encoding = encodeRow(mapping.legacyColumns, row);
  const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding), { legacyProgramId: PROGRAM_ID });
  return { encoding, target, back: encodeRow(mapping.legacyColumns, mapping.toLegacy(target)) };
}

describe('finance mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to finance, besides its object columns', () => {
    const expected = Object.fromEntries(
      OWNED_TARGETS.map((entry) => [
        coverageKeyOf(entry),
        entry.target.ownedColumns.filter((column) => !Object.hasOwn(entry.target.objectColumns ?? {}, column)),
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

  it.each(FOLDED_TARGETS.map((entry) => [entry.legacyTable, entry.target.unit, entry] as const))(
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

  it.each(SHARED_TARGETS.map((entry) => [entry.legacyTable, entry.target.unit, entry] as const))(
    'maps %s onto %s with its key and the row predicate split values, unfolded under its siteID tenant',
    (_legacyTable, unit, entry) => {
      const mapping = mappingFor(entry);

      expect(mapping.targetTable).toBe(unit);
      expect(mapping.key).toStrictEqual(entry.target.keyColumns);
      expect(mapping.keyless).toBe(false);
      expect(mapping.fold).toBeUndefined();
      expect(mapping.split?.by).toBe(entry.table.split?.by);
      expect(splitValuesOf(mapping)).toStrictEqual(predicateValues(entry.target.rowPredicate));
      expect(['siteID', 'siteID-or-umbrella']).toContain(entry.table.tenantResolution);
      expect(mapping.tenant).toStrictEqual({ kind: 'site', column: 'siteID' });
    },
  );

  it('declares one mapping per finance unit in UNITS order and exposes UNITS as its units', () => {
    expect(mappings.map((mapping) => mapping.unit)).toStrictEqual([...UNITS]);
    expect([...OWNED_UNITS].sort()).toStrictEqual([...UNITS].sort());
    expect(units).toBe(UNITS);
    expect(Object.isFrozen(mappings)).toBe(true);
  });

  it('lists the named mappings in the barrel, record before its children and each subtype before its sets', () => {
    const named = [
      financeRecordMapping,
      financeRecordVersionMapping,
      financeAttachmentMapping,
      financeRollupMapping,
      tclassextendMapping,
      tclassextendsetsMapping,
      tclassextendattributesMapping,
      tclassextendrcsetsMapping,
      tclassextenddataMapping,
      ttrashMapping,
    ];

    expect(mappings.map((mapping) => named.indexOf(mapping))).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
  it.each(FOLDED_MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
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

  it.each(SHARED_MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'keeps a sample finance-share %s row byte-exact through its target row, unfolded under the tenant of its siteID',
    (_legacyTable, mapping) => {
      const { row, encoding, decoded } = decodedSample(mapping);
      const target = mapping.toTarget(decoded);

      expect(mapping.acceptsRow(row, discriminatorOf(mapping))).toBe(true);
      expect(target).not.toHaveProperty(LEGACY_PROGRAM_ID_COLUMN);
      expect(mapping.encodeLegacy(target)).toBe(encoding);
      expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS)).toStrictEqual({
        tenantId: tenantIdForSite(TENANT_A.siteId),
        siteId: TENANT_A.siteId,
        orphan: false,
      });
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, { ...row, siteID: null }, LOOKUPS)).toStrictEqual({
        tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
        siteId: DEFAULT_UMBRELLA_SITE_ID,
        orphan: true,
      });
    },
  );

  it('keeps the NULL lastUpdate and lastUpdateByID of a never-edited record NULL', () => {
    const target = financeRecordMapping.toTarget(decodedSample(financeRecordMapping).decoded, { legacyProgramId: PROGRAM_ID });

    expect([target.lastupdate, target.lastupdatebyid]).toStrictEqual([null, null]);
  });

  it.each(FOLDED_MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'refuses a folded %s row without its legacyProgramId',
    (_legacyTable, mapping) => {
      expect(() => mapping.toTarget(decodedSample(mapping).decoded)).toThrow(MappingError);
    },
  );

  it.each(mappings.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'decodes a sample %s encoding back to the canonical row it encodes',
    (_legacyTable, mapping) => {
      const { encoding, decoded } = decodedSample(mapping);

      expect(decodeRow(mapping.legacyColumns, encoding)).toStrictEqual(decoded);
      expect(encodeRow(mapping.legacyColumns, decoded)).toBe(encoding);
    },
  );
});

describe('Program_<id> fold', () => {
  it('maps each fixture program to the site synthetic.program_site seeds', () => {
    expect(PROGRAM_SITES).toEqual({ 1: 'tenant-a', 2: 'tenant-b' });
    expect(PROGRAM_SITE_ROWS).toEqual(PROGRAM_SITES);
    for (const { program, tenant } of PROGRAMS) expect(PROGRAM_SITES[program]).toBe(tenant.siteId);
  });

  it.each(
    FOLDED_MAPPINGS.flatMap((mapping) =>
      PROGRAMS.map(({ program, tenant }) => ({ name: programTableName(program, mapping.legacyTable), program, site: tenant.siteId, mapping })),
    ),
  )('folds $name into its unit with legacy_program_id $program under $site', ({ name, program, site, mapping }) => {
    const { row, encoding, decoded } = decodedSample(mapping);
    const target = mapping.toTarget(decoded, { legacyProgramId: program });

    expect(name).toBe(`Program_${String(program)}.${mapping.legacyTable}`);
    expect(mapping.targetTable).toBe(mapping.unit);
    expect(parseProgramTable(name)).toStrictEqual({ programId: program, table: mapping.legacyTable });
    expect(parseProgramTable(`[Program_${String(program)}].[${mapping.legacyTable}]`)).toStrictEqual({ programId: program, table: mapping.legacyTable });
    expect(target[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(program));
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, LOOKUPS, { legacyProgramId: program })).toStrictEqual({
      tenantId: tenantIdForSite(site),
      siteId: site,
      orphan: false,
    });
  });

  it('takes the tenant of a Program_2 record from its schema, never from its siteID column', () => {
    const claimsTenantA = { ...sampleRow(financeRecordMapping), siteID: TENANT_A.siteId };
    const source = financeRecordMapping.tenant ?? { kind: 'umbrella' };

    expect(resolveTenant(source, claimsTenantA, LOOKUPS, { legacyProgramId: programOf(TENANT_B.siteId) })).toStrictEqual({
      tenantId: tenantIdForSite(TENANT_B.siteId),
      siteId: TENANT_B.siteId,
      orphan: false,
    });
    expect(resolveTenant(source, claimsTenantA, LOOKUPS)).toStrictEqual({
      tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
      siteId: DEFAULT_UMBRELLA_SITE_ID,
      orphan: true,
    });
  });
});

describe('finance shares of split Masa tables', () => {
  /** Whether `mapping` takes a sample row whose split value is `value`: its own split column, else the apply-row discriminator. */
  function accepts(mapping: Mapping, value: string | undefined): boolean {
    const column = mapping.split?.column;
    return column === undefined ? mapping.acceptsRow(sampleRow(mapping), value) : mapping.acceptsRow({ ...sampleRow(mapping), [column]: value ?? null });
  }

  it('lists the base tables of every finance extension row predicate, in its order', () => {
    const extensionTargets = SHARED_TARGETS.filter((entry) => entry.table.split?.by === 'baseTable');

    expect(extensionTargets.map((entry) => entry.target.unit).sort()).toStrictEqual(EXTENSION_MAPPINGS.map((mapping) => mapping.unit).sort());
    for (const { target } of extensionTargets) expect(FINANCE_BASE_TABLES).toStrictEqual(predicateValues(target.rowPredicate));
  });

  it.each(
    EXTENSION_MAPPINGS.flatMap((mapping) =>
      FINANCE_BASE_TABLES.flatMap((baseTable) => [baseTable, baseTable.toUpperCase()].map((value) => ({ table: mapping.legacyTable, value, mapping }))),
    ),
  )('takes a $table row of base table $value', ({ mapping, value }) => {
    expect(accepts(mapping, value)).toBe(true);
  });

  /** Base tables finance never takes: another owner's tables, the subtype editor's Custom type, and none. */
  const FOREIGN_BASE_TABLES = [
    { shown: "'tcontent'", value: 'tcontent' },
    { shown: "'temails'", value: 'temails' },
    { shown: "'custom'", value: 'custom' },
    { shown: 'no base table', value: undefined },
  ] as const;

  it.each(
    EXTENSION_MAPPINGS.flatMap((mapping) => FOREIGN_BASE_TABLES.map((entry) => ({ ...entry, table: mapping.legacyTable, mapping }))),
  )('leaves a $table row of $shown to its owner or to legacy', ({ mapping, value }) => {
    expect(accepts(mapping, value)).toBe(false);
  });

  it("splits tclassextend by the row's own baseTable, never by an apply-row discriminator", () => {
    const row = sampleRow(tclassextendMapping);

    expect(tclassextendMapping.acceptsRow({ ...row, baseTable: 'custom' }, 'Program_1.finance_record')).toBe(false);
    expect(tclassextendMapping.acceptsRow({ ...row, baseTable: 'Program_1.finance_record' }, 'custom')).toBe(true);
  });

  it.each([
    { value: 'finance', taken: true },
    { value: 'FINANCE', taken: true },
    { value: 'strategies-content', taken: false },
    { value: 'communications', taken: false },
    { value: 'people', taken: false },
    { value: 'timesheets', taken: false },
    { value: 'extendObject', taken: false },
    { value: undefined, taken: false },
  ])('takes a ttrash row of class-map owner $value: $taken', ({ value, taken }) => {
    expect(accepts(ttrashMapping, value)).toBe(taken);
  });

  it('splits ttrash by its class-map owner, never by its objectClass column', () => {
    expect(ttrashMapping.split).toStrictEqual({ by: 'objectClass', value: OWNER });
    expect(ttrashMapping.acceptsRow({ ...sampleRow(ttrashMapping), objectClass: OWNER })).toBe(false);
  });
});


describe('canonical value forms of a Program_1 record', () => {
  /** An edited fixture record in legacy column names. */
  const LEGACY_RECORD = financeRecordMapping.toLegacy(recordRow({ id: 'A0B1C2D3-0001-4E5F-A0B1C2D3E4F5A6B7', version: 2 }));

  it.each([
    { column: 'lastUpdateByID', shown: 'NULL', value: null, encoded: 'N', param: null },
    { column: 'lastUpdateByID', shown: "''", value: '', encoded: 's0:', param: '' },
    { column: 'title', shown: "''", value: '', encoded: 's0:', param: '' },
    { column: 'amount', shown: "'0.1000'", value: '0.1000', encoded: 'd6:0.1000', param: '0.1000' },
    { column: 'amount', shown: 'the driver number 0.1', value: 0.1, encoded: 'd6:0.1000', param: '0.1000' },
    { column: 'amount', shown: "'-12.3400'", value: '-12.3400', encoded: 'd8:-12.3400', param: '-12.3400' },
    { column: 'amount', shown: 'the driver number -12.34', value: -12.34, encoded: 'd8:-12.3400', param: '-12.3400' },
  ])('encodes $column $shown as $encoded and keeps it through the target row', ({ column, value, encoded, param }) => {
    const mapped = financeRecordMapping.columns.find((entry) => entry.legacy === column);
    if (mapped === undefined) throw new Error(`finance_record maps no column ${column}`);
    const { encoding, target, back } = roundTrip(financeRecordMapping, { ...LEGACY_RECORD, [column]: value });

    expect(encodeValue(mapped.type, value, { scale: mapped.scale })).toBe(encoded);
    expect(decodeRow(financeRecordMapping.legacyColumns, encoding)[column]).toBe(param);
    expect(target[mapped.target]).toBe(param);
    expect(back).toBe(encoding);
  });

  it.each([
    ['.001 text', '2026-06-30 12:00:00.001', 0.001, 0],
    ['.005 text', '2026-06-30 12:00:00.005', 0.005, 7],
    ['.005 driver Date', new Date(2026, 5, 30, 12, 0, 0, 5), 0.005, 7],
  ] as const)('rounds a %s lastUpdate to SQL Server datetime precision on both sides', (_shown, legacy, fractionSeconds, ms) => {
    const wallClock = `2026-06-30T12:00:00.${String(ms).padStart(3, '0')}`;
    const { encoding, target, back } = roundTrip(financeRecordMapping, { ...LEGACY_RECORD, lastUpdate: legacy });

    expect(roundToSqlServerDatetime({ year: 2026, month: 6, day: 30, hour: 12, minute: 0, second: 0, fractionSeconds }).ms).toBe(ms);
    expect(encodeValue('t', legacy)).toBe(`t23:${wallClock}`);
    expect(target.lastupdate).toBe(wallClock.replace('T', ' '));
    expect(back).toBe(encoding);
    // pg reads the stored timestamp(3) back as a local Date.
    expect(financeRecordMapping.encodeLegacy({ ...target, lastupdate: new Date(2026, 5, 30, 12, 0, 0, ms) })).toBe(encoding);
  });
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

  it('leaves the object key, tenant and row version of an apply row to the repository', () => {
    const target = financeAttachmentMapping.toTarget({ ...decoded, [ATTACHMENT_CONTENT_FIELD]: bytes }, { legacyProgramId: PROGRAM_ID });

    expect(Object.keys(target)).toStrictEqual([...financeAttachmentMapping.targetColumns.map((column) => column.name), ATTACHMENT_CONTENT_FIELD]);
    expect(target).not.toHaveProperty('object_key');
  });

  it('maps a stored attachment back to its legacy columns without bytes', () => {
    const { row: stored } = attachmentRow(recordRow(), { fileName: 'scan.pdf', contentType: 'application/pdf', bytes });
    const legacy = financeAttachmentMapping.toLegacy({ ...stored, [ATTACHMENT_CONTENT_FIELD]: bytes });
    const decodedStored = financeAttachmentMapping.decodeLegacy(financeAttachmentMapping.legacyColumns, financeAttachmentMapping.encodeLegacy(stored));

    expect(Object.keys(legacy)).toStrictEqual(financeAttachmentMapping.legacyColumns.map((column) => column.name));
    expect(decodedStored).not.toHaveProperty(ATTACHMENT_CONTENT_FIELD);
  });
});

describe('program bindings of migration applies', () => {
  const APPLY_URL = '/internal/v1/migration/apply';
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp({ seed: { program_binding: [] } });
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** A backfill batch of legacy rows of `tenant`'s `Program_<id>` copy of the mapping's table. */
  function batch(batchId: string, mapping: Mapping, tenant: TenantFixture, legacyRows: readonly Record<string, unknown>[]): ApplyRequest {
    return {
      batchId,
      origin: 'backfill',
      legacyTable: programTableName(programOf(tenant.siteId), mapping.legacyTable),
      tenantId: tenant.tenantId,
      columns: mapping.legacyColumns,
      rows: legacyRows.map((row) => ({ op: 'upsert', row: encodeRow(mapping.legacyColumns, row) })),
    };
  }

  /** A batch of three new fixture records of `tenant`. */
  function recordBatch(batchId: string, tenant: TenantFixture): ApplyRequest {
    const rows = Array.from({ length: 3 }, () => financeRecordMapping.toLegacy(recordRow({ siteid: tenant.siteId })));
    return batch(batchId, financeRecordMapping, tenant, rows);
  }

  async function apply(body: ApplyRequest): Promise<{ status: number; body: ApplyResponse }> {
    const res = await t.app.inject({ method: 'POST', url: APPLY_URL, headers: await headersFor('service:migration', { csrf: false }), payload: body });
    return { status: res.statusCode, body: res.json<ApplyResponse>() };
  }

  /** Committed writes of finance table `table` since the last clear. */
  function writesOf(table: string): RecordedWrite[] {
    return t.db.writes().filter((write) => write.table === `${SCHEMA}.${table}`);
  }

  /** Committed `finance.program_binding` writes since the last clear. */
  function bindingWrites(): { op: string; tenant_id: unknown; site_id: unknown; legacy_program_id: unknown }[] {
    return writesOf(PROGRAM_BINDING.table).map(({ op, row }) => ({ op, tenant_id: row.tenant_id, site_id: row.site_id, legacy_program_id: row.legacy_program_id }));
  }

  it('binds tenant-a to Program_1 and tenant-b to Program_2 once each, however many records a batch folds', async () => {
    for (const { tenant } of PROGRAMS) {
      const body = recordBatch(`bind-${tenant.siteId}`, tenant);

      expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: false, applied: 3, skipped: 0 } });
    }

    expect(bindingWrites()).toStrictEqual(
      PROGRAMS.map(({ program, tenant }) => ({ op: 'insert', tenant_id: tenant.tenantId, site_id: tenant.siteId, legacy_program_id: program })),
    );
    expect(writesOf(FINANCE_RECORD.table).map(({ op, row }) => [op, row.tenant_id, row.legacy_program_id])).toStrictEqual(
      PROGRAMS.flatMap(({ program, tenant }) => Array.from({ length: 3 }, () => ['insert', tenant.tenantId, program])),
    );
  });

  it('keeps the binding of a tenant when a later batch folds another of its Program_<id> tables', async () => {
    await apply(recordBatch('bind-first', TENANT_A));
    t.db.clear();
    const rollups = batch('bind-rollups', financeRollupMapping, TENANT_A, [
      { period: '2026-06', state: 'APPROVED', record_count: 3, total_amount: '300.0000', computed_at: '2026-06-30 12:00:00.000' },
    ]);

    expect(await apply(rollups)).toStrictEqual({ status: 200, body: { batchId: rollups.batchId, duplicate: false, applied: 1, skipped: 0 } });
    expect(bindingWrites()).toStrictEqual([]);
  });

  it('writes nothing for a repeated batch id', async () => {
    const body = recordBatch('bind-repeated', TENANT_B);
    await apply(body);
    t.db.clear();

    expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 } });
    expect(t.db.writes()).toStrictEqual([]);
  });

  /** A backfill batch of dbo `tclassextend` subtypes of tenant-a, one per base table. */
  function subtypeBatch(batchId: string, legacyTable: string, baseTables: readonly string[]): { body: ApplyRequest; ids: string[] } {
    const rows = baseTables.map((baseTable) => ({ ...sampleRow(tclassextendMapping), subTypeID: cfUuid(), baseTable }));
    const body: ApplyRequest = {
      batchId,
      origin: 'backfill',
      legacyTable,
      tenantId: TENANT_A.tenantId,
      columns: tclassextendMapping.legacyColumns,
      rows: rows.map((row) => ({ op: 'upsert', row: encodeRow(tclassextendMapping.legacyColumns, row) })),
    };
    return { body, ids: rows.map((row) => row.subTypeID) };
  }

  it('lands only the finance subtype of a tclassextend batch in finance.extend_subtype, unfolded and binding no program', async () => {
    const { body, ids } = subtypeBatch('extend-subtypes', 'tclassextend', ['Program_1.finance_record', 'custom']);

    expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: false, applied: 1, skipped: 1 } });
    expect(writesOf(EXTEND_SUBTYPE.table).map(({ op, row }) => [op, row.tenant_id, row.subtypeid, row.basetable])).toStrictEqual([
      ['insert', TENANT_A.tenantId, ids[0], 'Program_1.finance_record'],
    ]);
    expect(writesOf(EXTEND_SUBTYPE.table)[0]?.row).not.toHaveProperty(LEGACY_PROGRAM_ID_COLUMN);
    expect(bindingWrites()).toStrictEqual([]);
  });

  it('refuses a Program_<id> copy of tclassextend, which is not a per-program table, writing nothing', async () => {
    const { body } = subtypeBatch('extend-folded', programTableName(PROGRAM_ID, 'tclassextend'), ['Program_1.finance_record']);
    t.db.clear();

    expect((await apply(body)).status).toBe(400);
    expect(t.db.writes()).toStrictEqual([]);
  });

  it.each([
    ['Program_2 records under tenant-a', 2, TENANT_A],
    ['Program_1 records under tenant-b', 1, TENANT_B],
    ['records of Program_3, which synthetic.program_site does not map', 3, TENANT_A],
  ] as const)('rejects %s as invalidParameters and writes nothing', async (_label, program, tenant) => {
    const body = { ...recordBatch(`reject-${String(program)}`, tenant), legacyTable: programTableName(program, financeRecordMapping.legacyTable) };
    const { status, body: answer } = await apply(body);

    expect(status).toBe(400);
    expect(answer).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(t.db.writes()).toStrictEqual([]);
  });
});
