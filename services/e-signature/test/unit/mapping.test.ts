// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The e-signature mappings against table ownership: column coverage, units, fixture keys and tenancy, canonical audit-entry rows and backfill applies. */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  MIGRATION_PATH_PREFIX,
  decodeRow,
  diffCoverage,
  encodeRow,
  encodeValue,
  mappingCoverage,
  resolveTenant,
  sha256Hex,
  type ApplyRequest,
  type ApplyResponse,
  type Mapping,
  type TenantLookups,
  type TenantSource,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '@opt2/platform/testing';
import { auditEntryMapping, mappings, signatureMapping, signatureRequestMapping, units } from '../../src/migration/mappings/index.js';
import { AUDIT_ENTRY, OWNER, SCHEMA, SIGNATURE, SIGNATURE_REQUEST, type EsignatureTableDefinition } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type RecordedWrite, type TestApp } from '../helpers/app.js';
import { SIGNER_USER_ID, migrationHeaders } from '../helpers/tokens.js';
import { CHAIN_VECTORS, VECTOR_REQUEST_ID, chainEntries } from '../helpers/vectors.js';

interface OwnershipTarget {
  unit: string;
  rowPredicate: string | null;
  keyColumns: string[];
  ownedColumns: string[];
}

interface OwnershipTable {
  table: string;
  siteIdColumn: string | null;
  tenantResolution: string | null;
  tenantParent?: { table: string; join: string };
  split?: { by: string };
  targets?: OwnershipTarget[];
}

interface Ownership {
  units: { unit: string; owner: string; legacyTables: string[] }[];
  tables: OwnershipTable[];
}

/** One e-signature target of table ownership with the legacy table it is filed under. */
interface OwnedTarget {
  table: OwnershipTable;
  target: OwnershipTarget;
}

const OWNERSHIP = JSON.parse(readFileSync(new URL('../../../../opt2/table-ownership.json', import.meta.url), 'utf8')) as Ownership;
const OWNED_UNITS = OWNERSHIP.units.filter((unit) => unit.owner === OWNER);
const OWNED_UNIT_IDS: ReadonlySet<string> = new Set(OWNED_UNITS.map((unit) => unit.unit));
const OWNED_TARGETS: readonly OwnedTarget[] = OWNERSHIP.tables.flatMap((table) =>
  (table.targets ?? []).filter((target) => OWNED_UNIT_IDS.has(target.unit)).map((target) => ({ table, target })),
);

/** The fixture-table mappings, parent request first, with the repository table each fills. */
const FIXTURE_MAPPINGS: readonly { mapping: Mapping; definition: EsignatureTableDefinition }[] = [
  { mapping: signatureRequestMapping, definition: SIGNATURE_REQUEST },
  { mapping: signatureMapping, definition: SIGNATURE },
  { mapping: auditEntryMapping, definition: AUDIT_ENTRY },
];

/** Target-only columns of every e-signature table, which no legacy column maps onto. */
const TARGET_ONLY: ReadonlySet<string> = new Set(['tenant_id', 'row_version']);

/** Split values a target's row predicate names: a quoted `baseTable in (...)` list, or the owner of `classMap owner = <owner>`. */
function predicateValues(predicate: string | null): string[] {
  const listed = /^\w+ in \((.+)\)$/.exec(predicate ?? '')?.[1];
  if (listed !== undefined) return listed.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));
  const owner = /^classMap owner = (\S+)$/.exec(predicate ?? '')?.[1];
  if (owner === undefined) throw new Error(`row predicate ${JSON.stringify(predicate)} names no split values`);
  return [owner];
}

/** The key `mappingCoverage` files a target under: its legacy table, suffixed `{<by>=<values>}` when the table is split. */
function coverageKeyOf({ table, target }: OwnedTarget): string {
  return table.split === undefined ? table.table : `${table.table}{${table.split.by}=${predicateValues(target.rowPredicate).join(',')}}`;
}

/** The tenant source ownership resolves a fixture table to: its site column, or the parent row its join names. */
function ownershipTenant(table: OwnershipTable): TenantSource {
  if (table.tenantResolution === 'siteID' && table.siteIdColumn !== null) return { kind: 'site', column: table.siteIdColumn };
  const parent = table.tenantParent;
  const join = /^(.+)\.([^.]+) = (.+)\.([^.]+)$/.exec(parent?.join ?? '');
  if (parent === undefined || join === null || table.tenantResolution !== `parent:${parent.table}` || join[1] !== table.table || join[3] !== parent.table) {
    throw new Error(`${table.table}: ownership names no site column or parent join`);
  }
  return { kind: 'parent', parentLegacyTable: parent.table, columns: { [join[2] ?? '']: join[4] ?? '' } };
}

/** The ownership target of a fixture mapping. */
function ownedTargetOf(mapping: Mapping): OwnedTarget {
  const found = OWNED_TARGETS.find(({ table, target }) => table.table === mapping.legacyTable && target.unit === mapping.unit);
  if (found === undefined) throw new Error(`ownership assigns no target of ${mapping.legacyTable} onto ${mapping.unit}`);
  return found;
}

/** The declared tenant source of a mapping. */
function tenantSourceOf(mapping: Mapping): TenantSource {
  if (mapping.tenant === undefined) throw new Error(`${mapping.legacyTable} declares no tenant source`);
  return mapping.tenant;
}

/** Parent lookups as the orchestrator answers them, recording each ask: the vector request is of tenant-a, any other request is unknown. */
function parentLookups(asked: [string, Record<string, unknown>][] = []): TenantLookups {
  return {
    umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
    parentSiteId(parentLegacyTable, parentKey) {
      asked.push([parentLegacyTable, parentKey]);
      return parentKey.request_id === VECTOR_REQUEST_ID ? TENANT_A.siteId : null;
    },
  };
}

const DOCUMENT = Buffer.from('%PDF-1.7\n\u00e9\u0000\u00ff', 'latin1');

/** The vector chain's request as the fixture stores it. */
const REQUEST_ROW: Readonly<Record<string, unknown>> = {
  request_id: VECTOR_REQUEST_ID,
  siteID: TENANT_A.siteId,
  document_name: 'contract.pdf',
  document_sha256: sha256Hex(DOCUMENT),
  document: DOCUMENT,
  signer_user_id: SIGNER_USER_ID,
  state: 'SIGNED',
  created: new Date(2026, 5, 29, 23, 59, 59, 997),
  createdByID: SIGNER_USER_ID,
};

/** The stored vector chain as legacy rows; the fixture spells every audit_entry column as its stored row does. */
function storedRows(): Record<string, unknown>[] {
  return chainEntries().map((entry) => ({ ...entry }));
}

/** Stored vector-chain entry `index` as a legacy row. */
function storedRow(index: number): Record<string, unknown> {
  const row = storedRows()[index];
  if (row === undefined) throw new Error(`the vector chain has no entry ${String(index)}`);
  return row;
}

/** The typed-name signature of the vector request as the fixture stores it. */
const SIGNATURE_ROW: Readonly<Record<string, unknown>> = {
  signature_id: 'ABCDEF01-2345-6789-5000000000000001',
  request_id: VECTOR_REQUEST_ID,
  typed_name: 'Zo\u00eb \u00dcnal',
  signer_user_id: SIGNER_USER_ID,
  signed_at: new Date(2026, 5, 30, 12, 0, 0, 0),
};

describe('e-signature mapping coverage', () => {
  it('maps exactly the legacy columns table ownership assigns to e-signature, across every mapping', () => {
    const expected = Object.fromEntries(OWNED_TARGETS.map((entry) => [coverageKeyOf(entry), entry.target.ownedColumns]));
    const diff = diffCoverage(expected, mappingCoverage(mappings));

    expect(diff, JSON.stringify(diff, null, 2)).toStrictEqual({ missing: {}, extra: {} });
  });

  it('owns in table ownership exactly its units, each fed by the one legacy table its mapping reads', () => {
    const byUnit = (entries: [string, string[]][]): [string, string[]][] => entries.sort(([a], [b]) => a.localeCompare(b));

    expect([...OWNED_UNIT_IDS].sort()).toStrictEqual([...units].sort());
    expect(byUnit(OWNED_UNITS.map((unit) => [unit.unit, unit.legacyTables]))).toStrictEqual(
      byUnit(mappings.map((mapping) => [mapping.unit, [mapping.legacyTable]])),
    );
    expect(OWNED_TARGETS).toHaveLength(units.length);
  });

  it('lists the fixture mappings first, the parent request before the signature and audit entries that take its tenant', () => {
    expect(mappings.slice(0, FIXTURE_MAPPINGS.length)).toStrictEqual(FIXTURE_MAPPINGS.map(({ mapping }) => mapping));
  });

  it.each(FIXTURE_MAPPINGS.map(({ mapping, definition }) => [mapping.legacyTable, definition.unit, mapping, definition] as const))(
    'maps %s onto %s with the ownership key and tenant source and every repository column but tenant_id and row_version',
    (_legacyTable, unit, mapping, definition) => {
      const { table, target } = ownedTargetOf(mapping);

      expect([mapping.targetTable, mapping.unit]).toStrictEqual([unit, unit]);
      expect(mapping.key).toStrictEqual(target.keyColumns);
      expect(definition.key).toStrictEqual(target.keyColumns.map((column) => column.toLowerCase()));
      expect([mapping.keyless, mapping.split, mapping.fold]).toStrictEqual([false, undefined, undefined]);
      expect(mapping.tenant).toStrictEqual(ownershipTenant(table));
      expect(mapping.targetColumns).toStrictEqual(definition.columns.filter((column) => !TARGET_ONLY.has(column.name)));
      expect(mapping.columns.map((column) => column.target)).toStrictEqual(mapping.legacyColumns.map((column) => column.name.toLowerCase()));
    },
  );
});

describe('share definitions behind the class-extension mappings', () => {
  const TABLES = '../../src/repo/tables.js';

  afterEach(() => {
    vi.doUnmock(TABLES);
    vi.resetModules();
  });

  it('refuses to load a share mapping whose repository definition lacks a legacy column ownership assigns', async () => {
    vi.resetModules();
    vi.doMock(TABLES, async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/repo/tables.js')>();
      const columns = actual.EXTEND_DATA.columns.filter((column) => column.name !== 'stringvalue');
      return { ...actual, EXTEND_DATA: { ...actual.EXTEND_DATA, columns } };
    });

    await expect(import('../../src/migration/mappings/extend.js')).rejects.toMatchObject({
      name: 'MappingError',
      table: 'tclassextenddata',
      message: 'tclassextenddata: esignature.extend_data declares no column for stringvalue',
    });
  });
});

describe('tenant of a fixture row', () => {
  const requestSource = tenantSourceOf(signatureRequestMapping);

  it.each<{ siteID: string; tenant: TenantFixture; siteId: string }>([
    { siteID: 'tenant-a', tenant: TENANT_A, siteId: 'tenant-a' },
    { siteID: 'Tenant-A', tenant: TENANT_A, siteId: 'Tenant-A' },
    { siteID: 'TENANT-A  ', tenant: TENANT_A, siteId: 'TENANT-A' },
    { siteID: 'tenant-b', tenant: TENANT_B, siteId: 'tenant-b' },
  ])('resolves a request of siteID $siteID to the tenant of site $tenant.siteId', ({ siteID, tenant, siteId }) => {
    expect(resolveTenant(requestSource, { ...REQUEST_ROW, siteID }, parentLookups())).toStrictEqual({ tenantId: tenant.tenantId, siteId, orphan: false });
    expect(tenant.tenantId).toBe(tenantIdForSite(tenant.siteId));
  });

  it.each([null, '', '   '])('places a request of siteID %j under the umbrella tenant as an orphan', (siteID) => {
    expect(resolveTenant(requestSource, { ...REQUEST_ROW, siteID }, parentLookups())).toStrictEqual({
      tenantId: TENANT_UMBRELLA.tenantId,
      siteId: DEFAULT_UMBRELLA_SITE_ID,
      orphan: true,
    });
  });

  const CHILDREN = [
    ['synthetic.signature', signatureMapping, SIGNATURE_ROW],
    ['synthetic.audit_entry', auditEntryMapping, storedRow(0)],
  ] as const;

  it.each(CHILDREN)('gives a %s row the tenant of its parent request, asked by request_id', (_legacyTable, mapping, row) => {
    const asked: [string, Record<string, unknown>][] = [];

    expect(resolveTenant(tenantSourceOf(mapping), row, parentLookups(asked))).toStrictEqual({ tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, orphan: false });
    expect(asked).toStrictEqual([['synthetic.signature_request', { request_id: VECTOR_REQUEST_ID }]]);
  });

  it.each(CHILDREN.flatMap(([legacyTable, mapping, row]) => [
    [legacyTable, 'an unknown request', mapping, { ...row, request_id: 'ABCDEF01-2345-6789-FFFFFFFFFFFFFFFF' }] as const,
    [legacyTable, 'no request_id', mapping, { ...row, request_id: null }] as const,
  ]))('places a %s row of %s under the umbrella tenant as an orphan', (_legacyTable, _shown, mapping, row) => {
    expect(resolveTenant(tenantSourceOf(mapping), row, parentLookups())).toStrictEqual({
      tenantId: tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID),
      siteId: TENANT_UMBRELLA.siteId,
      orphan: true,
    });
  });
});

describe('canonical audit entry rows', () => {
  const columns = auditEntryMapping.legacyColumns;

  /** A legacy row's encoding, its target row, and the encoding of the legacy row that target maps back to. */
  function roundTrip(row: Readonly<Record<string, unknown>>): { encoding: string; target: Record<string, unknown>; back: string } {
    const encoding = encodeRow(columns, row);
    const target = auditEntryMapping.toTarget(auditEntryMapping.decodeLegacy(columns, encoding));
    return { encoding, target, back: encodeRow(columns, auditEntryMapping.toLegacy(target)) };
  }

  it.each(chainEntries().map((row, index) => [row.seq, row, CHAIN_VECTORS[index]] as const))(
    'encodes the hashes of chain entry %i as lowercase hex and keeps the stored row byte-exact through its target row',
    (_seq, row, vector) => {
      const { encoding, target, back } = roundTrip({ ...row });
      const decoded = decodeRow(columns, encoding);

      expect(encoding).toContain(`b64:${vector?.prevHex ?? ''}b64:${vector?.entryHex ?? ''}`);
      expect(Buffer.from(vector?.entryHex ?? '', 'hex').equals(row.entry_hash)).toBe(true);
      expect([decoded.prev_hash, decoded.entry_hash]).toStrictEqual([row.prev_hash, row.entry_hash]);
      expect([target.prev_hash, target.entry_hash]).toStrictEqual([row.prev_hash, row.entry_hash]);
      expect(decoded.at).toBe(vector?.canonical.split('|').at(-1));
      expect(target.at).toBe(decoded.at?.toString().replace('T', ' '));
      expect(back).toBe(encoding);
      expect(auditEntryMapping.encodeLegacy(target)).toBe(encoding);
      // pg reads timestamp(3) back as a local Date and bytea as a Buffer.
      expect(auditEntryMapping.encodeLegacy({ ...target, at: row.at, seq: row.seq })).toBe(encoding);
    },
  );

  const STORED = storedRow(3);

  it.each([
    { shown: 'NULL', detail: null, encoded: 'N' },
    { shown: "''", detail: '', encoded: 's0:' },
    { shown: 'text holding : | CR LF, control characters and a non-BMP pen', detail: 'a:b|c\r\n\u0007\u001f\t\u{1F58B}', encoded: 's14:a:b|c\r\n\u0007\u001f\t\u{1F58B}' },
    { shown: 'the vector names', detail: CHAIN_VECTORS[3]?.input.detail ?? '', encoded: 's21:Zo\u00eb \u00dcnal \u2013 \u7f72\u540d' },
  ])('encodes detail $shown with its UTF-8 byte length and keeps it byte-exact through the target row', ({ detail, encoded }) => {
    const { encoding, target, back } = roundTrip({ ...STORED, detail });

    expect(encodeValue('s', detail)).toBe(encoded);
    expect(encoding).toContain(`${encoded}t23:`);
    expect(decodeRow(columns, encoding).detail).toBe(detail);
    expect(target.detail).toBe(detail);
    expect(back).toBe(encoding);
  });

  it.each([
    ['a driver Date', CHAIN_VECTORS[0]?.input.at],
    ['wall-clock text', '2026-06-29 23:59:59.999'],
    ['ISO text', '2026-06-29T23:59:59.999'],
  ] as const)('rounds an at of 23:59:59.999 given as %s into the next day, as the datetime column stores it', (_shown, at) => {
    const stored = storedRow(0);
    const { encoding, target, back } = roundTrip({ ...stored, at });

    expect(encodeValue('t', at)).toBe('t23:2026-06-30T00:00:00.000');
    expect(target.at).toBe('2026-06-30 00:00:00.000');
    expect(back).toBe(encoding);
    expect(encoding).toBe(encodeRow(columns, stored));
  });

  it('maps the target row back to the legacy columns in catalog order', () => {
    const { target } = roundTrip(STORED);

    expect(Object.keys(auditEntryMapping.toLegacy(target))).toStrictEqual(columns.map((column) => column.name));
    expect(Object.keys(target)).toStrictEqual(auditEntryMapping.targetColumns.map((column) => column.name));
  });
});

describe('backfill applies of the fixture tables', () => {
  const APPLY_URL = `${MIGRATION_PATH_PREFIX}/apply`;
  let t: TestApp;

  beforeEach(async () => {
    t = await buildTestApp();
  });

  afterEach(async () => {
    await t.app.close();
  });

  /** A backfill batch of legacy rows of `mapping`'s fixture table for tenant-a. */
  function batch(batchId: string, mapping: Mapping, rows: readonly Readonly<Record<string, unknown>>[]): ApplyRequest {
    return {
      batchId,
      origin: 'backfill',
      legacyTable: mapping.legacyTable,
      tenantId: TENANT_A.tenantId,
      columns: [...mapping.legacyColumns],
      rows: rows.map((row) => ({ op: 'upsert', row: encodeRow(mapping.legacyColumns, row) })),
    };
  }

  async function apply(body: ApplyRequest, headers?: Record<string, string>): Promise<{ status: number; body: ApplyResponse }> {
    const res = await t.app.inject({ method: 'POST', url: APPLY_URL, headers: headers ?? (await migrationHeaders()), payload: body });
    return { status: res.statusCode, body: res.json<ApplyResponse>() };
  }

  /** Committed writes of e-signature table `table` since the last clear. */
  function writesOf(table: string): RecordedWrite[] {
    return t.db.writes().filter((write) => write.table === `${SCHEMA}.${table}`);
  }

  const BATCHES = [
    { mapping: signatureRequestMapping, definition: SIGNATURE_REQUEST, rows: [REQUEST_ROW] },
    { mapping: signatureMapping, definition: SIGNATURE, rows: [SIGNATURE_ROW] },
    { mapping: auditEntryMapping, definition: AUDIT_ENTRY, rows: storedRows() },
  ];

  it('stores the request, its signature and its audit chain under the batch tenant byte-exact, with one backfill changelog row per row', async () => {
    for (const { mapping, rows } of BATCHES) {
      const body = batch(`backfill-${mapping.legacyTable}`, mapping, rows);

      expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: false, applied: rows.length, skipped: 0 } });
    }

    for (const { mapping, definition, rows } of BATCHES) {
      const stored = writesOf(definition.table);

      expect(stored.map(({ op, tenantId, row }) => [op, tenantId, row.tenant_id])).toStrictEqual(rows.map(() => ['insert', TENANT_A.tenantId, TENANT_A.tenantId]));
      expect(stored.map(({ row }) => mapping.encodeLegacy(row))).toStrictEqual(rows.map((row) => encodeRow(mapping.legacyColumns, row)));
      expect(
        writesOf('changelog')
          .filter(({ row }) => row.table === definition.table)
          .map(({ row }) => [row.op, row.origin, row.tenant_id, row.request_id]),
      ).toStrictEqual(rows.map(() => ['insert', 'backfill', TENANT_A.tenantId, `backfill-${mapping.legacyTable}`]));
    }
  });

  it('answers a repeated batch id as a duplicate and writes nothing', async () => {
    const body = batch('backfill-repeated', signatureRequestMapping, [REQUEST_ROW]);
    await apply(body);
    t.db.clear();

    expect(await apply(body)).toStrictEqual({ status: 200, body: { batchId: body.batchId, duplicate: true, applied: 0, skipped: 0 } });
    expect(t.db.writes()).toStrictEqual([]);
  });

  it('rejects a request of another site in a tenant-a batch as invalidParameters and writes nothing', async () => {
    const { status } = await apply(batch('backfill-foreign-site', signatureRequestMapping, [{ ...REQUEST_ROW, siteID: TENANT_B.siteId }]));

    expect(status).toBe(400);
    expect(t.db.writes()).toStrictEqual([]);
  });

  it.each(['s2', 'service:operator'])('refuses the apply of %s, which lacks platform.migration, and writes nothing', async (subject) => {
    const { status } = await apply(batch(`backfill-${subject}`, signatureRequestMapping, [REQUEST_ROW]), await headersFor(subject));

    expect(status).toBe(403);
    expect(t.db.writes()).toStrictEqual([]);
  });
});
