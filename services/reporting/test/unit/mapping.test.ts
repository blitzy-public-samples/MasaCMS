// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The reporting mappings against table ownership and the reporting tables: column coverage, units, canonical round trips, export output bytes, session tracking names, tenancy and the apply of export output. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  MappingError,
  decodeRow,
  diffCoverage,
  encodeRow,
  encodeValue,
  mappingCoverage,
  resolveTenant,
  sha256Hex,
  type CanonicalValue,
  type Mapping,
  type ResolvedTenant,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { exportDefinitionMapping, exportJobMapping, mappings, sessionTrackingMapping, units } from '../../src/migration/mappings/index.js';
import {
  EXPORT_BUCKET,
  EXPORT_OUTPUT_FIELD,
  OUTPUT_SLOTS,
  OWNED_TABLES,
  OWNER,
  UNITS,
  exportObjectKey,
  type ExportFormat,
} from '../../src/repo/tables.js';
import { LEGACY_EXPORT_DEFINITION_ROWS, LEGACY_EXPORT_JOB_ROWS, LEGACY_SESSION_TRACKING_ROWS } from '../helpers/fixtures.js';
import { defineMappingApplyCases } from '../helpers/mapping-apply-cases.js';

type LegacyRow = Readonly<Record<string, CanonicalValue>>;

interface OwnershipTarget {
  unit: string;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
  objectColumns?: Record<string, string>;
}

interface OwnershipTable {
  table: string;
  columns: string[];
  addedColumns?: { column: string; source: string }[];
  siteIdColumn?: string;
  tenantResolution: string | null;
  rowIdentity: 'key' | 'multiset';
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string }[];
  tables: OwnershipTable[];
}

/** A reporting target of table ownership with the legacy table it is taken from. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

const OWNERSHIP = JSON.parse(await readFile(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS: readonly string[] = OWNERSHIP.units.filter((unit) => unit.owner === OWNER).map((unit) => unit.unit);
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => OWNED_UNITS.includes(target.unit)).map((target) => ({ table, target })),
);

/** Target columns reporting manages itself: the tenant, the export object key and the row version. */
const TARGET_MANAGED: ReadonlySet<string> = new Set(['tenant_id', 'object_key', 'row_version']);
const LOOKUPS: TenantLookups = { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID };
const UMBRELLA_ORPHAN: ResolvedTenant = { tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID), siteId: DEFAULT_UMBRELLA_SITE_ID, orphan: true };
const SAMPLES: readonly (readonly [Mapping, readonly LegacyRow[]])[] = [
  [exportDefinitionMapping, LEGACY_EXPORT_DEFINITION_ROWS],
  [exportJobMapping, LEGACY_EXPORT_JOB_ROWS],
  [sessionTrackingMapping, LEGACY_SESSION_TRACKING_ROWS],
];
const SAMPLE_CASES = SAMPLES.flatMap(([mapping, rows]) => rows.map((row, index) => ({ name: `${mapping.legacyTable} row ${String(index + 1)}`, mapping, row })));

/** Row `index` of a fixture; throws when the fixture holds fewer rows. */
function rowAt(rows: readonly LegacyRow[], index: number): LegacyRow {
  const row = rows[index];
  if (row === undefined) throw new Error(`fixture has no row ${String(index)}`);
  return row;
}

/** The ownership table of `legacyTable`. */
function ownershipTable(legacyTable: string): OwnershipTable {
  const table = OWNERSHIP.tables.find((candidate) => candidate.table === legacyTable);
  if (table === undefined) throw new Error(`table ownership lists no ${legacyTable}`);
  return table;
}

/** Legacy columns a target owns: every catalog column of a whole-table target, else its `ownedColumns`. */
function ownedColumns({ table, target }: OwnedTarget): string[] {
  return target.columnPolicy === 'whole-table' ? table.columns : target.ownedColumns;
}

/** The one mapping of the target's legacy table onto its unit. */
function mappingFor({ table, target }: OwnedTarget): Mapping {
  const found = mappings.filter((mapping) => mapping.legacyTable === table.table && mapping.unit === target.unit);
  const [mapping] = found;
  if (found.length !== 1 || mapping === undefined) throw new Error(`${String(found.length)} mappings of ${table.table} onto ${target.unit}`);
  return mapping;
}

/** The declared tenant source of `mapping`. */
function tenantSource(mapping: Mapping): TenantSource {
  if (mapping.tenant === undefined) throw new Error(`${mapping.legacyTable} declares no tenant source`);
  return mapping.tenant;
}

/** The values of `row` that `mapping` owns, keyed by legacy name in catalog order. */
function ownedValues(mapping: Mapping, row: LegacyRow): Record<string, CanonicalValue> {
  return Object.fromEntries(mapping.legacyColumns.map((column): [string, CanonicalValue] => [column.name, row[column.name] ?? null]));
}

/** `row` without its `output` value. */
function withoutOutput(row: LegacyRow): Record<string, CanonicalValue> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== EXPORT_OUTPUT_FIELD));
}

/** A sample row's encoding and the target row its decoded values map to. */
function mapSample(mapping: Mapping, row: LegacyRow): { encoding: string; target: Record<string, unknown> } {
  const encoding = encodeRow(mapping.legacyColumns, row);
  return { encoding, target: mapping.toTarget(decodeRow(mapping.legacyColumns, encoding)) };
}

describe('reporting mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to reporting, its declared object columns aside', () => {
    // Object columns are owned through the object store rather than the row encoding; toTarget carries them (asserted below).
    const expected = Object.fromEntries(
      OWNED_TARGETS.map((entry) => [entry.table.table, ownedColumns(entry).filter((column) => !Object.hasOwn(entry.target.objectColumns ?? {}, column))]),
    );
    const diff = diffCoverage(expected, mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('declares one object column, the export output that toTarget carries into reporting-exports', () => {
    const objectColumns = OWNED_TARGETS.flatMap(({ table, target }) =>
      Object.entries(target.objectColumns ?? {}).map(([column, bucket]) => [table.table, column, bucket]),
    );

    expect(objectColumns).toStrictEqual([[exportJobMapping.legacyTable, EXPORT_OUTPUT_FIELD, EXPORT_BUCKET]]);
  });

  it.each(OWNED_TARGETS.map((entry) => [entry.table.table, entry.target.unit, entry] as const))(
    'maps %s onto %s with its key and its siteID tenant',
    (_legacyTable, unit, entry) => {
      const mapping = mappingFor(entry);

      expect(mapping.targetTable).toBe(unit);
      expect(mapping.key).toStrictEqual(entry.target.keyColumns);
      expect(mapping.keyless).toBe(entry.table.rowIdentity === 'multiset');
      expect(mapping.tenant).toStrictEqual({ kind: 'site', column: entry.table.siteIdColumn });
      expect(['siteID', 'siteID-or-umbrella']).toContain(entry.table.tenantResolution);
    },
  );

  it('declares one mapping per reporting unit in UNITS order, definitions before jobs before session tracking', () => {
    const named = [exportDefinitionMapping, exportJobMapping, sessionTrackingMapping];

    expect(units).toBe(UNITS);
    expect(OWNED_UNITS).toStrictEqual([...UNITS]);
    expect(mappings.map((mapping) => mapping.unit)).toStrictEqual([...UNITS]);
    expect(mappings.map((mapping) => named.indexOf(mapping))).toStrictEqual([0, 1, 2]);
    expect(Object.isFrozen(mappings)).toBe(true);
  });

  it.each(mappings.map((mapping) => [mapping.unit, mapping] as const))(
    'targets the %s columns of its reporting table besides tenant_id, object_key and row_version',
    (unit, mapping) => {
      const table = OWNED_TABLES.find((definition) => definition.unit === unit);

      expect(mapping.targetColumns).toStrictEqual(table?.columns.filter((column) => !TARGET_MANAGED.has(column.name)));
    },
  );
});

describe('canonical round trips of the legacy samples', () => {
  it.each(SAMPLE_CASES)('decodes $name to its canonical values and maps it to a target row that encodes back byte-exact', ({ mapping, row }) => {
    const { encoding, target } = mapSample(mapping, row);
    const decoded = decodeRow(mapping.legacyColumns, encoding);

    expect(decoded).toStrictEqual(ownedValues(mapping, row));
    expect(mapping.decodeLegacy(mapping.legacyColumns, encoding)).toStrictEqual(decoded);
    expect(mapping.encodeLegacy(target)).toBe(encoding);
    expect(decodeRow(mapping.legacyColumns, encodeRow(mapping.legacyColumns, mapping.toLegacy(target)))).toStrictEqual(decoded);
  });

  it.each([
    { table: 'tsessiontracking', mapping: sessionTrackingMapping, row: rowAt(LEGACY_SESSION_TRACKING_ROWS, 1), column: 'userid', shown: 'NULL', value: null, encoded: 'N' },
    { table: 'tsessiontracking', mapping: sessionTrackingMapping, row: rowAt(LEGACY_SESSION_TRACKING_ROWS, 1), column: 'userid', shown: "''", value: '', encoded: 's0:' },
    { table: 'tsessiontracking', mapping: sessionTrackingMapping, row: rowAt(LEGACY_SESSION_TRACKING_ROWS, 1), column: 'query_string', shown: "''", value: '', encoded: 's0:' },
    { table: 'tsessiontracking', mapping: sessionTrackingMapping, row: rowAt(LEGACY_SESSION_TRACKING_ROWS, 1), column: 'query_string', shown: 'NULL', value: null, encoded: 'N' },
    { table: 'synthetic.export_job', mapping: exportJobMapping, row: rowAt(LEGACY_EXPORT_JOB_ROWS, 1), column: 'error', shown: "''", value: '', encoded: 's0:' },
    { table: 'synthetic.export_job', mapping: exportJobMapping, row: rowAt(LEGACY_EXPORT_JOB_ROWS, 1), column: 'error', shown: 'NULL', value: null, encoded: 'N' },
  ])('encodes $table $column $shown as $encoded and keeps it through the target row', ({ mapping, row, column, value, encoded }) => {
    const mapped = mapping.columns.find((entry) => entry.legacy === column);
    if (mapped === undefined) throw new Error(`${mapping.legacyTable} maps no column ${column}`);
    const { encoding, target } = mapSample(mapping, { ...row, [column]: value });

    expect(encodeValue(mapped.type, value)).toBe(encoded);
    expect(decodeRow(mapping.legacyColumns, encoding)[column]).toBe(value);
    expect(target[mapped.target]).toBe(value);
    expect(mapping.encodeLegacy(target)).toBe(encoding);
  });

  it.each([
    ['the sample definition', rowAt(LEGACY_EXPORT_DEFINITION_ROWS, 0).columns as string],
    ['spaced, escaped and non-ASCII JSON', '[ "timesheet_id" ,\n\t"caf\\u00e9", "naïve:\\"x\\"" ]'],
  ])('keeps the columns text of %s byte-exact and never parses it', (_shown, text) => {
    const { encoding, target } = mapSample(exportDefinitionMapping, { ...rowAt(LEGACY_EXPORT_DEFINITION_ROWS, 0), columns: text });

    expect(target.columns).toBe(text);
    expect(encoding.endsWith(encodeValue('s', text))).toBe(true);
    expect(exportDefinitionMapping.encodeLegacy(target)).toBe(encoding);
  });
});

describe('export job output bytes', () => {
  const done = rowAt(LEGACY_EXPORT_JOB_ROWS, 0);
  const bytes = done[EXPORT_OUTPUT_FIELD];
  const columnsOnly = exportJobMapping.toTarget(withoutOutput(done));

  it('keeps output out of the row encoding and out of the target row of a row without it', () => {
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(exportJobMapping.legacyColumns.map((column) => column.name)).not.toContain(EXPORT_OUTPUT_FIELD);
    expect(columnsOnly).not.toHaveProperty(EXPORT_OUTPUT_FIELD);
    expect(Object.isFrozen(exportJobMapping)).toBe(true);
  });

  it('carries the legacy bytes as a Buffer beside their output_sha256, leaving tenant, object key and row version to the repository', () => {
    const target = exportJobMapping.toTarget(done);

    expect(target[EXPORT_OUTPUT_FIELD]).toBe(bytes);
    expect(target.output_sha256).toBe(sha256Hex(bytes as Buffer));
    expect(Object.keys(target)).toStrictEqual([...exportJobMapping.targetColumns.map((column) => column.name), EXPORT_OUTPUT_FIELD]);
    for (const managed of TARGET_MANAGED) expect(target).not.toHaveProperty(managed);
  });

  it.each([['OUTPUT'], ['Output']])('carries the bytes of a legacy %s column under output', (name) => {
    expect(exportJobMapping.toTarget({ ...withoutOutput(done), [name]: bytes ?? null })).toStrictEqual({ ...columnsOnly, [EXPORT_OUTPUT_FIELD]: bytes });
  });

  it('carries the NULL output of a job without bytes as null', () => {
    const queued = rowAt(LEGACY_EXPORT_JOB_ROWS, 1);

    expect(queued[EXPORT_OUTPUT_FIELD]).toBeNull();
    expect(exportJobMapping.toTarget(queued)[EXPORT_OUTPUT_FIELD]).toBeNull();
  });

  it('maps a stored job back to its legacy columns without fabricating output bytes', () => {
    const stored = {
      tenant_id: TENANT_A.tenantId,
      ...columnsOnly,
      object_key: exportObjectKey(TENANT_A.tenantId, String(done.job_id), done.format as ExportFormat, OUTPUT_SLOTS[0]),
      row_version: '1',
    };
    const legacy = exportJobMapping.toLegacy(stored);

    expect(Object.keys(legacy)).toStrictEqual(exportJobMapping.legacyColumns.map((column) => column.name));
    expect(legacy).not.toHaveProperty(EXPORT_OUTPUT_FIELD);
    expect(exportJobMapping.encodeLegacy(stored)).toBe(encodeRow(exportJobMapping.legacyColumns, done));
  });
});

describe('tsessiontracking', () => {
  const visit = rowAt(LEGACY_SESSION_TRACKING_ROWS, 0);
  const table = ownershipTable(sessionTrackingMapping.legacyTable);

  it('maps the 17 bootstrap columns and the fname, lname and company columns dbUpdates 6.1.1 adds, typed as the legacy DDL types them', () => {
    const types = Object.fromEntries(sessionTrackingMapping.legacyColumns.map((column) => [column.name, column.type]));

    expect(sessionTrackingMapping.legacyColumns.map((column) => column.name)).toStrictEqual(table.columns);
    expect(sessionTrackingMapping.legacyColumns.slice(-3).map((column) => column.name)).toStrictEqual(table.addedColumns?.map((added) => added.column));
    expect(Object.entries(types).filter(([, type]) => type !== 's')).toStrictEqual([
      ['trackingID', 'i'],
      ['entered', 't'],
    ]);
  });

  it('names every target column with the lower-cased legacy name and maps the target row back to the legacy spelling', () => {
    const { target } = mapSample(sessionTrackingMapping, visit);

    expect(sessionTrackingMapping.columns.filter((column) => column.target !== column.legacy.toLowerCase())).toStrictEqual([]);
    expect(Object.keys(target)).toStrictEqual(table.columns.map((name) => name.toLowerCase()));
    expect(target).toMatchObject({ trackingid: '1', siteid: TENANT_A.siteId, urltoken: visit.urlToken, originalurltoken: visit.originalUrlToken });
    expect(Object.keys(sessionTrackingMapping.toLegacy(target))).toStrictEqual(table.columns);
  });

  it('keeps trackingID an integer: canonical integer text as the pg parameter, and the int4 pg reads back encodes identically', () => {
    const { encoding, target } = mapSample(sessionTrackingMapping, visit);
    const read = { ...target, trackingid: 1, entered: new Date(String(visit.entered)) };

    expect(sessionTrackingMapping.key).toStrictEqual(['trackingID']);
    expect(target.trackingid).toBe('1');
    expect(sessionTrackingMapping.encodeLegacy(read)).toBe(encoding);
    expect(() => sessionTrackingMapping.toTarget({ ...visit, trackingID: '1.5' })).toThrow(MappingError);
  });
});

describe('tenant of a legacy row', () => {
  it('places rows with no site under the umbrella fixture tenant', () => {
    expect(UMBRELLA_ORPHAN.tenantId).toBe(TENANT_UMBRELLA.tenantId);
  });

  it.each(
    SAMPLES.flatMap(([mapping, rows]) =>
      [
        { shown: "'tenant-a'", site: TENANT_A.siteId, expected: { tenantId: tenantIdForSite(TENANT_A.siteId), siteId: TENANT_A.siteId, orphan: false } },
        { shown: "space-padded 'tenant-a'", site: `${TENANT_A.siteId}   `, expected: { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, orphan: false } },
        // resolveTenant consults no registry: an unregistered site names its own tenant, and the orchestrator decides whether the site exists.
        { shown: 'an unregistered site', site: 'no-such-site', expected: { tenantId: tenantIdForSite('no-such-site'), siteId: 'no-such-site', orphan: false } },
        { shown: 'NULL', site: null, expected: UMBRELLA_ORPHAN },
        { shown: "''", site: '', expected: UMBRELLA_ORPHAN },
      ].map((entry) => ({ ...entry, table: mapping.legacyTable, mapping, row: { ...rowAt(rows, 0), siteID: entry.site } })),
    ),
  )('resolves a $table row with siteID $shown', ({ mapping, row, expected }) => {
    expect(resolveTenant(tenantSource(mapping), row, LOOKUPS)).toStrictEqual(expected);
  });

  it.each([
    ['the tsessiontracking visit with a NULL siteID', sessionTrackingMapping, rowAt(LEGACY_SESSION_TRACKING_ROWS, 2)],
    ['the export definition with an empty siteID', exportDefinitionMapping, rowAt(LEGACY_EXPORT_DEFINITION_ROWS, 3)],
  ])('loads %s under the umbrella tenant as an orphan', (_shown, mapping, row) => {
    expect(resolveTenant(tenantSource(mapping), row, LOOKUPS)).toStrictEqual(UMBRELLA_ORPHAN);
  });
});

defineMappingApplyCases('recording');
