// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The e-signature class-extension and ttrash share mappings against table ownership, their DDL and a throwaway schema. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  closeGates,
  diffCoverage,
  encodeRow,
  ensureUnitGates,
  mappingCoverage,
  openGates,
  resolveTenant,
  type CanonicalColumn,
  type Mapping,
  type MappingColumn,
} from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, checkCatalog, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  mappings,
  tclassextendMapping,
  tclassextendattributesMapping,
  tclassextenddataMapping,
  tclassextendrcsetsMapping,
  tclassextendsetsMapping,
  trashMapping,
  units,
} from '../../src/migration/mappings/index.js';
import { ESIGNATURE_BASE_TABLES } from '../../src/migration/mappings/extend.js';
import { createEsignatureRepository } from '../../src/repo/repository.js';
import { OWNED_TABLES, OWNER, UNITS, type EsignatureTableDefinition } from '../../src/repo/tables.js';

interface OwnershipTarget {
  unit: string;
  owner: string;
  rowPredicate: string | null;
  keyColumns: string[];
  columnPolicy: 'whole-table' | 'explicit';
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  columns: string[];
  siteIdColumn: string | null;
  split?: {
    by: string;
    baseTableOwners?: Record<string, string>;
    classMap?: { classes: string[]; owners?: Record<string, string> }[];
  };
  targets?: OwnershipTarget[];
}

/** One e-signature share target with its legacy table, mapping and repository definition. */
interface Share {
  table: OwnershipTable;
  target: OwnershipTarget;
  mapping: Mapping;
  definition: EsignatureTableDefinition;
}

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const OWNERSHIP = JSON.parse(read('../../../../opt2/table-ownership.json')) as { tables: OwnershipTable[] };
const SHARE_MAPPINGS = [
  tclassextendMapping,
  tclassextendsetsMapping,
  tclassextendattributesMapping,
  tclassextendrcsetsMapping,
  tclassextenddataMapping,
  trashMapping,
] as const;
const SITE_ID = TENANT_A.siteId;
const IN_LIST = /^baseTable in \((.+)\)$/;
const CLASS_MAP_OWNER = /^classMap owner = (\S+)$/;

/** The split values a target's row predicate names: a quoted `baseTable in (...)` list or a class-map owner. */
function predicateValues(predicate: string | null): string[] {
  const list = IN_LIST.exec(predicate ?? '')?.[1];
  if (list !== undefined) return list.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
  const owner = CLASS_MAP_OWNER.exec(predicate ?? '')?.[1];
  if (owner === undefined) throw new Error(`row predicate "${String(predicate)}" names no split values`);
  return [owner];
}

const SHARES: readonly Share[] = SHARE_MAPPINGS.map((mapping) => {
  const table = OWNERSHIP.tables.find((candidate) => candidate.table === mapping.legacyTable);
  const target = table?.targets?.find((candidate) => candidate.unit === mapping.unit);
  const definition = OWNED_TABLES.find((candidate) => candidate.unit === mapping.unit);
  if (table === undefined || target === undefined || definition === undefined) throw new Error(`no ownership target or table for ${mapping.unit}`);
  return { table, target, mapping, definition };
});

/** Legacy columns each share owns, filed under the key `mappingCoverage` gives a split mapping. */
function expectedCoverage(): Record<string, string[]> {
  return Object.fromEntries(
    SHARES.map(({ table, target }): [string, string[]] => [
      `${table.table}{${table.split?.by ?? ''}=${predicateValues(target.rowPredicate).join(',')}}`,
      target.columnPolicy === 'whole-table' ? table.columns : target.ownedColumns,
    ]),
  );
}

// Sample rows leave the first column NULL and the second empty; both are nullable in the legacy catalog.
const NULL_AND_EMPTY: Readonly<Record<string, readonly [nullColumn: string, emptyColumn: string]>> = {
  tclassextend: ['notes', 'iconclass'],
  tclassextendsets: ['categoryID', 'container'],
  tclassextendattributes: ['hint', 'optionLabelList'],
  tclassextendrcsets: ['availableSubTypes', 'entitytype'],
  tclassextenddata: ['attributeValue', 'remoteID'],
  ttrash: ['deleteid', 'deletedBy'],
};

/** A driver-shaped legacy value distinct per position; text is 35 characters with CR LF and a non-ASCII letter, so char(35) keeps it. */
function sampleValue(column: CanonicalColumn, position: number): unknown {
  if (column.type === 'i') return position + 1;
  if (column.type === 'f') return position + 0.25;
  if (column.type === 't') return new Date(2026, 5, 30, 12, 0, position % 60, 3);
  if (column.type === 's') return `${String(position)}\r\n\u00e9:${column.name}`.padEnd(35, 'x').slice(0, 35);
  throw new Error(`no sample value for canonical type ${column.type} of ${column.name}`);
}

/** A sample legacy row of site `tenant-a` that e-signature owns, with its NULL and empty columns. */
function sampleRow(mapping: Mapping): { row: Record<string, unknown>; nullColumn: MappingColumn; emptyColumn: MappingColumn } {
  const row: Record<string, unknown> = Object.fromEntries(
    mapping.legacyColumns.map((column, position): [string, unknown] => [column.name, sampleValue(column, position)]),
  );
  row.siteID = SITE_ID;
  if (mapping.split?.column !== undefined) row[mapping.split.column] = ESIGNATURE_BASE_TABLES[1];
  const [nullName, emptyName] = NULL_AND_EMPTY[mapping.legacyTable] ?? [];
  const nullColumn = mapping.columns.find((column) => column.legacy === nullName);
  const emptyColumn = mapping.columns.find((column) => column.legacy === emptyName);
  if (nullColumn === undefined || emptyColumn === undefined) throw new Error(`${mapping.legacyTable}: no mapped NULL and empty sample columns`);
  row[nullColumn.legacy] = null;
  row[emptyColumn.legacy] = '';
  return { row, nullColumn, emptyColumn };
}

/** The discriminator an apply row of `mapping` carries when its split has no column: the owned value it names first. */
function ownedDiscriminator(mapping: Mapping): string | undefined {
  return mapping.split?.column === undefined ? (mapping === trashMapping ? OWNER : ESIGNATURE_BASE_TABLES[0]) : undefined;
}

describe('e-signature share coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to each e-signature share', () => {
    const diff = diffCoverage(expectedCoverage(), mappingCoverage(SHARE_MAPPINGS));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('names the base tables ownership resolves to e-signature, in each extension predicate and the extendObject class map', () => {
    const owned = (owners: Record<string, string> | undefined): string[] =>
      Object.entries(owners ?? {}).filter(([, owner]) => owner === OWNER).map(([baseTable]) => baseTable).sort();
    const extension = SHARES.filter(({ mapping }) => mapping !== trashMapping);
    const trash = OWNERSHIP.tables.find((table) => table.table === 'ttrash');
    const extendObject = trash?.split?.classMap?.find((rule) => rule.classes.includes('extendObject'));

    expect(extension.map(({ target }) => predicateValues(target.rowPredicate))).toStrictEqual(extension.map(() => [...ESIGNATURE_BASE_TABLES]));
    expect(extension.map(({ table }) => owned(table.split?.baseTableOwners))).toStrictEqual(extension.map(() => [...ESIGNATURE_BASE_TABLES]));
    expect(owned(extendObject?.owners)).toStrictEqual([...ESIGNATURE_BASE_TABLES]);
  });

  it.each(SHARES.map((share) => [share.mapping.legacyTable, share] as const))(
    'maps %s onto its unit with the ownership key, the site tenant and every target column but tenant_id',
    (_legacyTable, { table, target, mapping, definition }) => {
      expect(mapping.targetTable).toBe(target.unit);
      expect(mapping.key).toStrictEqual(target.keyColumns);
      expect(mapping.keyless).toBe(false);
      expect(mapping.tenant).toStrictEqual({ kind: 'site', column: table.siteIdColumn });
      expect(mapping.targetColumns.map((column) => column.name)).toStrictEqual(definition.columns.slice(1).map((column) => column.name));
    },
  );

  it('registers one mapping per unit in UNITS order and exposes UNITS', () => {
    expect(mappings.map((mapping) => mapping.unit)).toStrictEqual([...UNITS]);
    expect(mappings.slice(-SHARE_MAPPINGS.length)).toStrictEqual([...SHARE_MAPPINGS]);
    expect(units).toBe(UNITS);
  });
});

describe('e-signature share row round trips', () => {
  it.each(SHARE_MAPPINGS.map((mapping) => [mapping.legacyTable, mapping] as const))(
    'accepts a sample %s row and keeps it byte-exact through its target row, tenant from siteID',
    (_legacyTable, mapping) => {
      const { row, nullColumn, emptyColumn } = sampleRow(mapping);
      const encoding = encodeRow(mapping.legacyColumns, row);
      const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));

      expect(mapping.acceptsRow(row, ownedDiscriminator(mapping))).toBe(true);
      expect([target[nullColumn.target], target[emptyColumn.target]]).toStrictEqual([null, '']);
      expect(mapping.encodeLegacy(target)).toBe(encoding);
      expect(encodeRow(mapping.legacyColumns, mapping.toLegacy(target))).toBe(encoding);
      expect(resolveTenant(mapping.tenant ?? { kind: 'umbrella' }, row, { umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID })).toStrictEqual({
        tenantId: TENANT_A.tenantId,
        siteId: SITE_ID,
        orphan: false,
      });
    },
  );
});

describe('e-signature split ownership', () => {
  const accepted = [...ESIGNATURE_BASE_TABLES, 'SYNTHETIC.Signature_Request  '];
  const rejected = ['tcontent', 'temails', 'custom', '', null];
  const joined = [tclassextendsetsMapping, tclassextendattributesMapping, tclassextendrcsetsMapping, tclassextenddataMapping];

  it.each(accepted.map((value) => [value] as const))('takes a tclassextend row whose own baseTable is %j', (baseTable) => {
    expect(tclassextendMapping.acceptsRow({ ...sampleRow(tclassextendMapping).row, baseTable }, 'tcontent')).toBe(true);
  });

  it.each(rejected.map((value) => [value] as const))('refuses a tclassextend row whose own baseTable is %j', (baseTable) => {
    expect(tclassextendMapping.acceptsRow({ ...sampleRow(tclassextendMapping).row, baseTable }, ESIGNATURE_BASE_TABLES[0])).toBe(false);
  });

  it.each(joined.flatMap((mapping) => accepted.map((value) => [mapping.legacyTable, value, mapping] as const)))(
    'takes a %s row whose subtype baseTable is %j',
    (_legacyTable, discriminator, mapping) => {
      expect(mapping.acceptsRow(sampleRow(mapping).row, discriminator)).toBe(true);
    },
  );

  it.each(joined.flatMap((mapping) => [...rejected, undefined].map((value) => [mapping.legacyTable, value, mapping] as const)))(
    'refuses a %s row whose subtype baseTable is %j',
    (_legacyTable, discriminator, mapping) => {
      expect(mapping.acceptsRow(sampleRow(mapping).row, discriminator)).toBe(false);
    },
  );

  it.each([
    ['e-signature', true],
    ['E-Signature ', true],
    ['esignature', false],
    ['communications', false],
    ['people', false],
    ['extendObject', false],
    [null, false],
    [undefined, false],
  ] as const)('decides a ttrash row of class-map owner %j as %s, whatever its own objectClass', (owner, expected) => {
    const row = { ...sampleRow(trashMapping).row, objectClass: 'extendObject' };
    expect(trashMapping.acceptsRow(row, owner)).toBe(expected);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('e-signature shares against PostgreSQL', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'e-signature',
      schemaName: 'esignature',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await closeGates(handle.app, { units: UNITS, holderId: 'extend-mappings-test', allowLegacy: true });
    await openGates(handle.app, { units: UNITS, holderId: 'extend-mappings-test', state: 'open' });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('creates every share table with row-level security enabled, forced and covered by its tenant policy', async () => {
    const tables = new Set(SHARES.map(({ definition }) => `${handle.schema}.${definition.table}`));
    const { rows } = await handle.adminPool.query<{ relname: string }>(
      "SELECT c.relname::text AS relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'",
      [handle.schema],
    );

    expect(rows.map((row) => `${handle.schema}.${row.relname}`).filter((name) => tables.has(name)).sort()).toStrictEqual([...tables].sort());
    expect((await checkCatalog(handle)).filter((finding) => tables.has(finding.object))).toStrictEqual([]);
  });

  it.each(SHARES.map((share) => [share.mapping.legacyTable, share] as const))(
    'stores a sample %s row through the repository byte-exact, visible to its tenant only',
    async (_legacyTable, { mapping, definition }) => {
      const repository = createEsignatureRepository({ db: handle.app });
      const encoding = encodeRow(mapping.legacyColumns, sampleRow(mapping).row);
      const target = mapping.toTarget(mapping.decodeLegacy(mapping.legacyColumns, encoding));
      const key = Object.fromEntries(definition.key.map((column) => [column, target[column]]));

      const stored = await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
        await repository.upsert(tx, definition.table, target);
        return repository.findByKey<Record<string, unknown>>(tx, definition.table, key);
      });
      const elsewhere = await handle.app.withTenant(TENANT_B.tenantId, (tx) => repository.findByKey(tx, definition.table, key));

      expect(stored).toMatchObject({ tenant_id: TENANT_A.tenantId });
      expect(mapping.encodeLegacy(stored ?? {})).toBe(encoding);
      expect(elsewhere).toBeNull();
    },
  );
});
