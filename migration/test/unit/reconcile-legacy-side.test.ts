// Unit tests for the legacy side of reconciliation over a fake SQL Server pool, a fake bridge and a small ownership file.
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeKey,
  encodeRow,
  sha256Hex,
  type CanonicalColumn,
  type CanonicalValue,
  type ExportResponse,
} from '@opt2/platform/migration-kit';
import { fixedClock } from '@opt2/platform/service-kit';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { clearCatalogCache, compareCanonicalRows, type CanonicalRow } from '../../src/extract/index.js';
import { UnsupportedFileStoreError, type BridgeClient, type FileListing, type LegacyDb } from '../../src/legacy/index.js';
import { loadUnitCatalog, type ExportParams, type OwnersClient, type UnitCatalog } from '../../src/owners/index.js';
import { DIFFERENCE_LIMIT } from '../../src/reconcile/compare.js';
import { reconcileUnits, type ReconcileContext, type ReconcileSources } from '../../src/reconcile/index.js';
import { readTargetUnitRows } from '../../src/reconcile/target-side.js';
import {
  createTenantResolver,
  describeUnitTable,
  fileUnitIds,
  objectLegacyPath,
  readLegacyObjects,
  readLegacyUnitRows,
  toUnitRow,
  type LegacyUnitRows,
  type ReconcileLegacyDeps,
  type TenantResolver,
  type UnitTableShape,
} from '../../src/reconcile/legacy-side.js';

type Row = Record<string, unknown>;

interface ColumnSpec {
  name: string;
  type: string;
}

interface FakeTable {
  columns: readonly ColumnSpec[];
  primaryKey?: readonly string[];
  identity?: readonly string[];
  rows: readonly Row[];
}

const FROM_TABLE = / FROM \[([^\]]+)\]\.\[([^\]]+)\]/;
const SITES_SQL = 'SELECT DISTINCT [SiteID] FROM [dbo].[tsettings] ORDER BY [SiteID];';
const OWNERS_SQL = 'SELECT [fileID], [siteID] FROM [dbo].[tfiles];';
const TYPES_SQL = 'SELECT [fileID], [contentType], [contentSubType], [fileExt] FROM [dbo].[tfiles];';
const SNAPSHOT_SQL = 'SELECT state, manifest_complete FROM migration.snapshot WHERE seq = $1';
const MANIFEST_PAGE_SQL =
  'SELECT site_id, path, file_id, variant, ext, size, sha256, orphan FROM migration.file_manifest WHERE snapshot_seq = $1 ORDER BY site_id COLLATE "C", path COLLATE "C" LIMIT $2';

const A = tenantIdForSite('tenant-a');
const B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite('umbrella');
const FILE_A = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FILE_X = 'B1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const FILE_N = 'C1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

/** A fake request: catalog, table-list and raw queries answer at once, row requests emit the FROM table's rows. */
class FakeRequest extends EventEmitter {
  stream = false;
  private readonly inputs: Record<string, unknown> = {};

  constructor(
    private readonly tables: Readonly<Record<string, FakeTable>>,
    private readonly raw: Readonly<Record<string, readonly Row[]>>,
  ) {
    super();
  }

  input(name: string, _type: unknown, value: unknown): this {
    this.inputs[name] = value;
    return this;
  }

  pause(): void {}

  resume(): void {}

  cancel(): void {}

  query(text: string): Promise<unknown> {
    if (text.includes('INFORMATION_SCHEMA.COLUMNS')) {
      const spec = this.table(`${String(this.inputs.schema)}.${String(this.inputs.table)}`);
      const sets = [
        (spec?.columns ?? []).map((column, index) => ({
          COLUMN_NAME: column.name,
          DATA_TYPE: column.type,
          IS_NULLABLE: 'YES',
          CHARACTER_MAXIMUM_LENGTH: null,
          NUMERIC_PRECISION: null,
          NUMERIC_SCALE: null,
          ORDINAL_POSITION: index + 1,
        })),
        (spec?.primaryKey ?? []).map((name) => ({ name })),
        (spec?.identity ?? []).map((name) => ({ name })),
      ];
      return Promise.resolve({ recordsets: sets, recordset: sets[0] });
    }
    if (text.includes('DATABASEPROPERTYEX')) return Promise.resolve({ recordset: [{ updateability: 'READ_ONLY' }] });
    if (text.includes('sys.schemas')) {
      return Promise.resolve({
        recordset: Object.keys(this.tables).map((name) => ({ schema_name: name.slice(0, name.indexOf('.')), table_name: name.slice(name.indexOf('.') + 1) })),
      });
    }
    if (!this.stream) {
      const rows = this.raw[text];
      return rows === undefined ? Promise.reject(new Error(`unexpected query: ${text}`)) : Promise.resolve({ recordset: rows });
    }
    const from = FROM_TABLE.exec(text);
    const rows = (from === null ? undefined : this.table(`${String(from[1])}.${String(from[2])}`))?.rows ?? [];
    return new Promise((resolve) => {
      setImmediate(() => {
        for (const row of rows) this.emit('row', row);
        this.emit('done', { rowsAffected: [] });
        resolve({});
      });
    });
  }

  private table(name: string): FakeTable | undefined {
    const lower = name.toLowerCase();
    return Object.entries(this.tables).find(([key]) => key.toLowerCase() === lower)?.[1];
  }
}

let databaseSeq = 0;

/** Fake legacy port: one pool per database name, each answering from its own tables and raw answers. */
function fakeLegacy(databases: Readonly<Record<string, { tables: Record<string, FakeTable>; raw: Record<string, readonly Row[]> }>>) {
  // Catalog metadata is memoised per database name, so every fake gets names of its own.
  const run = String((databaseSeq += 1));
  const pools = new Map<string, ConnectionPool>();
  const named = (name: string): string => `${name}_${run}`;
  for (const [name, content] of Object.entries(databases)) {
    pools.set(named(name), {
      config: { database: named(name) },
      request: () => new FakeRequest(content.tables, content.raw),
    } as unknown as ConnectionPool);
  }
  const database = (name: string): Promise<ConnectionPool> => {
    const pool = pools.get(name);
    return pool === undefined ? Promise.reject(new Error(`no fake database ${name}`)) : Promise.resolve(pool);
  };
  const legacy: LegacyDb = {
    live: () => database(named('live')),
    database,
    transaction: () => Promise.reject(new Error('fake legacy: no transactions')),
    close: () => Promise.resolve(),
  };
  return { legacy, named };
}

const targetOf = (unit: string, owner: string, rowPredicate: string | null, keyColumns: string[], ownedColumns?: string[]) => ({
  unit,
  owner,
  rowPredicate,
  keyColumns,
  ...(ownedColumns === undefined ? { columnPolicy: 'whole-table' } : { columnPolicy: 'explicit', ownedColumns }),
});

const EXTEND_SPLIT = { by: 'baseTable', resolve: 'tclassextendsets.subTypeID = tclassextend.subTypeID' };

/** A minimal ownership file covering every tenant rule and row predicate form. */
const OWNERSHIP = {
  units: [
    { unit: 'people.person', owner: 'people', legacyTables: ['tusers'] },
    { unit: 'identity.group_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'people.user_address', owner: 'people', legacyTables: ['tuseraddresses'] },
    { unit: 'identity.user_address', owner: 'identity', legacyTables: ['tuseraddresses'] },
    { unit: 'identity.membership', owner: 'identity', legacyTables: ['tusersmemb'] },
    { unit: 'identity.user_strike', owner: 'identity', legacyTables: ['tuserstrikes'] },
    { unit: 'identity.membership_note', owner: 'identity', legacyTables: ['tmembnotes'] },
    { unit: 'content.content', owner: 'strategies-content', legacyTables: ['tcontent'] },
    { unit: 'programs_sites.system_object', owner: 'programs-sites', legacyTables: ['tsystemobjects'] },
    { unit: 'timesheets.timesheet', owner: 'timesheets', legacyTables: ['Program_N.timesheet'] },
    { unit: 'content.extend_subtype', owner: 'strategies-content', legacyTables: ['tclassextend'] },
    { unit: 'people.extend_subtype', owner: 'people', legacyTables: ['tclassextend'] },
    { unit: 'content.extend_set', owner: 'strategies-content', legacyTables: ['tclassextendsets'] },
    { unit: 'people.extend_set', owner: 'people', legacyTables: ['tclassextendsets'] },
    { unit: 'content.trash', owner: 'strategies-content', legacyTables: ['ttrash'] },
    { unit: 'people.trash', owner: 'people', legacyTables: ['ttrash'] },
    { unit: 'identity.trash', owner: 'identity', legacyTables: ['ttrash'] },
    { unit: 'finance.attachment', owner: 'finance', legacyTables: ['Program_N.finance_attachment'] },
    { unit: 'reporting.export_job', owner: 'reporting', legacyTables: ['synthetic.export_job'] },
  ],
  tables: [
    {
      table: 'tusers',
      owner: 'split',
      primaryKey: ['UserID'],
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      split: { by: 'Type+column', typeColumn: 'Type' },
      targets: [
        targetOf('people.person', 'people', 'Type = 2', ['UserID', 'SiteID'], ['UserID', 'siteid', 'fname']),
        targetOf('identity.group_account', 'identity', 'Type = 1', ['UserID']),
      ],
    },
    {
      table: 'tuseraddresses',
      owner: 'split',
      primaryKey: ['addressID'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID-or-umbrella',
      split: { by: 'ownerType', parent: { table: 'tusers', join: 'tuseraddresses.userID = tusers.UserID' } },
      targets: [
        targetOf('people.user_address', 'people', 'owner Type = 2', ['addressID']),
        targetOf('identity.user_address', 'identity', 'owner Type = 1', ['addressID']),
      ],
    },
    {
      table: 'tusersmemb',
      owner: 'identity',
      primaryKey: ['UserID', 'GroupID'],
      tenantResolution: 'parent:tusers',
      tenantParent: { table: 'tusers', join: 'tusersmemb.UserID = tusers.UserID' },
      targets: [targetOf('identity.membership', 'identity', null, ['UserID', 'GroupID'])],
    },
    {
      table: 'tuserstrikes',
      owner: 'identity',
      primaryKey: ['username'],
      tenantResolution: 'parent:tusers',
      tenantParent: { table: 'tusers', join: 'tuserstrikes.username = tusers.UserName' },
      targets: [targetOf('identity.user_strike', 'identity', null, ['username'])],
    },
    {
      table: 'tmembnotes',
      owner: 'identity',
      primaryKey: ['noteID'],
      tenantResolution: 'parent:tusersmemb',
      tenantParent: { table: 'tusersmemb', join: 'tusersmemb.UserID = tmembnotes.memberID' },
      targets: [targetOf('identity.membership_note', 'identity', null, ['noteID'])],
    },
    {
      table: 'tcontent',
      owner: 'strategies-content',
      primaryKey: ['ContentHistID'],
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      targets: [targetOf('content.content', 'strategies-content', null, ['ContentHistID'], ['ContentHistID', 'SiteID', 'Title', 'tcontent_ID'])],
    },
    {
      table: 'tsystemobjects',
      owner: 'programs-sites',
      primaryKey: [],
      siteIdColumn: 'SiteID',
      tenantResolution: 'siteID-or-umbrella',
      targets: [targetOf('programs_sites.system_object', 'programs-sites', null, [])],
    },
    {
      table: 'Program_N.timesheet',
      owner: 'timesheets',
      primaryKey: ['timesheet_id'],
      programFold: true,
      tenantResolution: 'program_site',
      targets: [targetOf('timesheets.timesheet', 'timesheets', null, ['timesheet_id'])],
    },
    { table: 'synthetic.program_site', owner: 'programs-sites', primaryKey: ['program_id'], migrated: false, targets: [] },
    {
      table: 'tclassextend',
      owner: 'split',
      primaryKey: ['subTypeID'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID-or-umbrella',
      split: { by: 'baseTable', resolve: 'tclassextend.baseTable' },
      targets: [
        targetOf('content.extend_subtype', 'strategies-content', "baseTable = 'tcontent'", ['subTypeID']),
        targetOf('people.extend_subtype', 'people', "baseTable in ('tusers', 'tusersaddresses')", ['subTypeID']),
      ],
    },
    {
      table: 'tclassextendsets',
      owner: 'split',
      primaryKey: ['extendSetID'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID-or-umbrella',
      split: EXTEND_SPLIT,
      targets: [
        targetOf('content.extend_set', 'strategies-content', "baseTable = 'tcontent'", ['extendSetID']),
        targetOf('people.extend_set', 'people', "baseTable in ('tusers', 'tusersaddresses')", ['extendSetID']),
      ],
    },
    {
      table: 'ttrash',
      owner: 'split',
      primaryKey: ['objectID'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID',
      split: {
        by: 'objectClass',
        classMap: [
          { classes: ['content'], owner: 'strategies-content' },
          { classes: ['user'], ownerBy: 'stored Type', owners: { '1': 'identity', '2': 'people' } },
          { classes: ['address'], ownerBy: "owning user's Type", owners: { '1': 'identity', '2': 'people' } },
          { classes: ['extendObject'], ownerBy: 'baseTable', owners: { tcontent: 'strategies-content', tusers: 'people' } },
          { classes: ['<ORM entity name>'], ownerBy: "owner of the entity's table" },
        ],
      },
      targets: [
        targetOf('content.trash', 'strategies-content', 'classMap owner = strategies-content', ['objectID']),
        targetOf('people.trash', 'people', 'classMap owner = people', ['objectID']),
        targetOf('identity.trash', 'identity', 'classMap owner = identity', ['objectID']),
      ],
    },
    {
      table: 'Program_N.finance_attachment',
      owner: 'finance',
      primaryKey: ['attachment_id'],
      programFold: true,
      tenantResolution: 'program_site',
      targets: [{ ...targetOf('finance.attachment', 'finance', null, ['attachment_id']), objectColumns: { content: 'finance-attachments' } }],
    },
    {
      table: 'synthetic.export_job',
      owner: 'reporting',
      primaryKey: ['job_id'],
      siteIdColumn: 'siteID',
      tenantResolution: 'siteID',
      targets: [{ ...targetOf('reporting.export_job', 'reporting', null, ['job_id']), objectColumns: { OUTPUT: 'reporting-exports' } }],
    },
  ],
};

const varchar = (...names: string[]): ColumnSpec[] => names.map((name) => ({ name, type: 'varchar' }));

const ATTACHMENT_A1 = Buffer.from('program 1 attachment 1');
const ATTACHMENT_A2 = Buffer.from('program 1 attachment 2, longer');
const ATTACHMENT_B1 = Buffer.from('program 2 attachment 1');
const OUTPUT_J1 = Buffer.from('job,output\n1,ok\n');
const OUTPUT_J3 = Buffer.from('%PDF-1.7 export');
const ATTACHMENT_COLUMNS: ColumnSpec[] = [...varchar('attachment_id', 'record_id'), { name: 'content', type: 'varbinary' }, ...varchar('sha256')];
const attachment = (id: string, record: string, content: Buffer): Row => ({ attachment_id: id, record_id: record, content, sha256: sha256Hex(content) });
const exportJob = (id: string, site: string, output: Buffer | null): Row => ({
  job_id: id,
  siteID: site,
  output,
  output_sha256: output === null ? null : sha256Hex(output),
});
/** The object entry the legacy side expects for `bytes` under `legacyPath`. */
const expected = (legacyPath: string, bytes: Buffer, orphan = false) => ({ key: legacyPath, size: bytes.length, sha256: sha256Hex(bytes), orphan });

/** Legacy tables of the main fake database; rows are in primary-key order, as SQL Server returns them. */
const TABLES: Record<string, FakeTable> = {
  'dbo.tusers': {
    columns: [{ name: 'UserID', type: 'varchar' }, { name: 'Type', type: 'int' }, ...varchar('SiteID', 'UserName', 'Fname')],
    primaryKey: ['UserID'],
    rows: [
      { UserID: 'U01', Type: 2, SiteID: 'tenant-a', UserName: 'alice', Fname: 'Alice' },
      { UserID: 'U02', Type: 1, SiteID: 'tenant-a', UserName: 'Editors', Fname: null },
      { UserID: 'U03', Type: 2, SiteID: 'umbrella', UserName: 'bob', Fname: 'Bob' },
      { UserID: 'U04', Type: 2, SiteID: 'tenant-b', UserName: 'ALICE ', Fname: 'Alice B' },
      { UserID: 'U05', Type: 1, SiteID: 'umbrella', UserName: 'Bob', Fname: null },
    ],
  },
  'dbo.tuseraddresses': {
    columns: varchar('addressID', 'userID', 'siteID', 'city'),
    primaryKey: ['addressID'],
    rows: [
      { addressID: 'A1', userID: 'U01', siteID: 'tenant-a', city: 'Leeds' },
      { addressID: 'A2', userID: 'U02', siteID: 'tenant-a', city: 'York' },
      { addressID: 'A3', userID: 'U99', siteID: 'tenant-a', city: 'Hull' },
    ],
  },
  'dbo.tusersmemb': {
    columns: varchar('UserID', 'GroupID'),
    primaryKey: ['UserID', 'GroupID'],
    rows: [
      { UserID: 'U01', GroupID: 'U02' },
      { UserID: 'U99', GroupID: 'U02' },
    ],
  },
  'dbo.tuserstrikes': {
    columns: [{ name: 'username', type: 'varchar' }, { name: 'strikes', type: 'int' }],
    primaryKey: ['username'],
    rows: [
      { username: 'alice', strikes: 2 },
      { username: 'bob', strikes: 1 },
    ],
  },
  'dbo.tcontent': {
    columns: [{ name: 'tcontent_ID', type: 'int' }, ...varchar('SiteID', 'ContentHistID', 'Title', 'Body')],
    primaryKey: ['tcontent_ID'],
    identity: ['tcontent_ID'],
    rows: [
      { tcontent_ID: 7, SiteID: 'tenant-a', ContentHistID: 'C1', Title: 'Home', Body: 'x' },
      { tcontent_ID: 3, SiteID: 'tenant-b', ContentHistID: 'C2', Title: 'About', Body: 'y' },
    ],
  },
  'dbo.tsystemobjects': {
    columns: varchar('SiteID', 'Object', 'Name'),
    rows: [
      { SiteID: 'tenant-a', Object: 'nav', Name: 'Nav' },
      { SiteID: null, Object: 'x', Name: 'X' },
      { SiteID: 'tenant-a', Object: 'nav', Name: 'Nav' },
    ],
  },
  'Program_1.timesheet': {
    columns: [{ name: 'timesheet_id', type: 'int' }, { name: 'person_id', type: 'varchar' }],
    primaryKey: ['timesheet_id'],
    rows: [
      { timesheet_id: 9, person_id: 'U01' },
      { timesheet_id: 10, person_id: 'U01' },
    ],
  },
  'Program_2.timesheet': {
    columns: [{ name: 'timesheet_id', type: 'int' }, { name: 'person_id', type: 'varchar' }],
    primaryKey: ['timesheet_id'],
    rows: [{ timesheet_id: 9, person_id: 'U04' }],
  },
  'synthetic.program_site': {
    columns: [{ name: 'program_id', type: 'int' }, { name: 'siteID', type: 'varchar' }],
    primaryKey: ['program_id'],
    rows: [
      { program_id: 1, siteID: 'tenant-a' },
      { program_id: 2, siteID: 'tenant-b' },
    ],
  },
  'dbo.tclassextend': {
    columns: varchar('subTypeID', 'siteID', 'baseTable', 'type', 'subType'),
    primaryKey: ['subTypeID'],
    rows: [
      { subTypeID: 'S1', siteID: 'tenant-a', baseTable: 'tcontent', type: 'Page', subType: 'Default' },
      { subTypeID: 'S2', siteID: 'tenant-a', baseTable: 'tusers', type: 'User', subType: 'Default' },
    ],
  },
  'dbo.tclassextendsets': {
    columns: varchar('extendSetID', 'subTypeID', 'siteID', 'name'),
    primaryKey: ['extendSetID'],
    rows: [
      { extendSetID: 'E1', subTypeID: 'S1', siteID: 'tenant-a', name: 'Page set' },
      { extendSetID: 'E2', subTypeID: 'S2', siteID: 'tenant-a', name: 'User set' },
      { extendSetID: 'E3', subTypeID: 'S9', siteID: 'tenant-a', name: 'Lost set' },
    ],
  },
  'dbo.ttrash': {
    columns: varchar('objectID', 'parentID', 'siteID', 'objectClass', 'objectType', 'objectSubType'),
    primaryKey: ['objectID'],
    rows: [
      { objectID: 'O1', parentID: 'NA', siteID: 'tenant-a', objectClass: 'content', objectType: 'Page', objectSubType: 'Default' },
      { objectID: 'O2', parentID: 'NA', siteID: 'tenant-a', objectClass: 'user', objectType: 'User', objectSubType: 'Default' },
      { objectID: 'O3', parentID: 'U02', siteID: 'tenant-a', objectClass: 'address', objectType: 'address', objectSubType: 'Default' },
      { objectID: 'O4', parentID: 'U98', siteID: 'tenant-a', objectClass: 'address', objectType: 'address', objectSubType: 'Default' },
      { objectID: 'O5', parentID: 'NA', siteID: 'tenant-a', objectClass: 'extendObject', objectType: 'User', objectSubType: 'Default' },
      { objectID: 'O6', parentID: 'NA', siteID: 'tenant-a', objectClass: 'widget', objectType: 'widget', objectSubType: 'Default' },
      { objectID: 'U98', parentID: 'NA', siteID: 'tenant-a', objectClass: 'user', objectType: 'Group', objectSubType: 'Default' },
    ],
  },
  'Program_1.finance_attachment': {
    columns: ATTACHMENT_COLUMNS,
    primaryKey: ['attachment_id'],
    rows: [attachment('AT1', 'R1', ATTACHMENT_A1), attachment('AT2', 'R1', ATTACHMENT_A2)],
  },
  'Program_2.finance_attachment': { columns: ATTACHMENT_COLUMNS, primaryKey: ['attachment_id'], rows: [attachment('AT1', 'R7', ATTACHMENT_B1)] },
  'synthetic.export_job': {
    columns: [...varchar('job_id', 'siteID'), { name: 'output', type: 'varbinary' }, ...varchar('output_sha256')],
    primaryKey: ['job_id'],
    rows: [exportJob('J1', 'tenant-a', OUTPUT_J1), exportJob('J2', 'tenant-a', null), exportJob('J3', 'tenant-b', OUTPUT_J3)],
  },
};

const RAW: Record<string, readonly Row[]> = {
  [SITES_SQL]: ['default', 'tenant-a', 'tenant-b', 'umbrella'].map((SiteID) => ({ SiteID })),
  [OWNERS_SQL]: [
    { fileID: FILE_A, siteID: 'tenant-a' },
    { fileID: FILE_N, siteID: null },
  ],
  [TYPES_SQL]: [
    { fileID: FILE_A, contentType: 'image', contentSubType: 'jpeg', fileExt: 'jpg' },
    { fileID: FILE_N, contentType: 'image', contentSubType: 'png', fileExt: 'png' },
  ],
};

let dir: string;
let ownershipFile: string;
let catalog: UnitCatalog;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-legacy-side-'));
  ownershipFile = join(dir, 'table-ownership.json');
  await writeFile(ownershipFile, JSON.stringify(OWNERSHIP), 'utf8');
  catalog = loadUnitCatalog(ownershipFile);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  clearCatalogCache();
});

/**
 * Context over the main fake database `muradb` (`tables` replacing tables of the same name) and a fixture-less `bare`
 * one; `db` and `bridge` default to unused fakes.
 */
function setup(overrides: { db?: TenantDb; bridge?: BridgeClient; tables?: Record<string, FakeTable> } = {}) {
  const base = loadConfig();
  const { legacy, named } = fakeLegacy({
    muradb: { tables: { ...TABLES, ...overrides.tables }, raw: RAW },
    bare: { tables: {}, raw: { [SITES_SQL]: [{ SiteID: 'default' }] } },
  });
  const deps = {
    legacy,
    catalog,
    config: { ...base, paths: { ...base.paths, tableOwnership: ownershipFile } },
    db: overrides.db ?? ({} as TenantDb),
    bridge: overrides.bridge ?? ({} as BridgeClient),
  } as ReconcileLegacyDeps;
  return { deps, database: named('muradb'), bare: named('bare') };
}

/** Every tenant's rows of `legacy`, read in tenant order; `legacy` is disposed afterwards. */
async function collect(legacy: LegacyUnitRows): Promise<Map<string, CanonicalRow[]>> {
  const byTenant = new Map<string, CanonicalRow[]>();
  try {
    for (const tenantId of legacy.tenants) {
      const rows: CanonicalRow[] = [];
      for await (const row of legacy.rows(tenantId)) rows.push(row);
      byTenant.set(tenantId, rows);
    }
  } finally {
    await legacy.dispose();
  }
  return byTenant;
}

async function rowsOf(unit: string, legacyTable: string, options: { sortRunBytes?: number; spillDir?: string; tables?: Record<string, FakeTable> } = {}) {
  const { deps, database } = setup({ tables: options.tables });
  const shape = await describeUnitTable(deps, { unit, legacyTable, database });
  const tenants = await createTenantResolver(deps, { database });
  const legacy = await readLegacyUnitRows(deps, shape, { database, tenants, sortRunBytes: options.sortRunBytes, spillDir: options.spillDir });
  const { counts, orphans } = legacy;
  return { shape, counts, orphans, byTenant: await collect(legacy) };
}

const keysOf = (byTenant: Map<string, { row: Readonly<Record<string, unknown>> }[]>, column: string) =>
  Object.fromEntries([...byTenant].map(([tenant, rows]) => [tenant, rows.map((row) => row.row[column])]));

describe('describeUnitTable', () => {
  it('projects the owned columns in catalog order and leaves out a non-key IDENTITY column', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'content.content', legacyTable: 'tcontent', database });
    expect(shape).toEqual({
      unit: 'content.content',
      owner: 'strategies-content',
      legacyTable: 'tcontent',
      keyed: true,
      keyColumns: ['ContentHistID'],
      columns: [
        { name: 'SiteID', type: 's' },
        { name: 'ContentHistID', type: 's' },
        { name: 'Title', type: 's' },
      ],
      excludedColumns: ['tcontent_ID'],
      objectColumns: [],
      folded: false,
    });
  });

  it('matches owned and key columns case-insensitively and answers in catalog spelling', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'people.person', legacyTable: 'tusers', database });
    expect(shape.keyColumns).toEqual(['UserID', 'SiteID']);
    expect(shape.columns.map((column) => column.name)).toEqual(['UserID', 'SiteID', 'Fname']);
  });

  it('appends legacy_program_id to the columns and key of a folded table', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'timesheets.timesheet', legacyTable: 'Program_N.timesheet', database });
    expect(shape.folded).toBe(true);
    expect(shape.keyColumns).toEqual(['timesheet_id', 'legacy_program_id']);
    expect(shape.columns).toEqual([
      { name: 'timesheet_id', type: 'i' },
      { name: 'person_id', type: 's' },
      { name: 'legacy_program_id', type: 'i' },
    ]);
  });

  it('describes a table without a primary key or unit key as keyless', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'programs_sites.system_object', legacyTable: 'tsystemobjects', database });
    expect(shape.keyed).toBe(false);
    expect(shape.keyColumns).toEqual([]);
  });

  it('rejects a unit that takes no rows of the table', async () => {
    const { deps, database } = setup();
    await expect(describeUnitTable(deps, { unit: 'content.content', legacyTable: 'tusers', database })).rejects.toThrow(
      'unit content.content takes no rows of legacy table tusers',
    );
  });

  it.each([
    ['a folded table', 'finance.attachment', 'Program_N.finance_attachment', ['attachment_id', 'record_id', 'sha256', 'legacy_program_id'], 'content'],
    ['a table naming it in another case', 'reporting.export_job', 'synthetic.export_job', ['job_id', 'siteID', 'output_sha256'], 'output'],
  ])('sets the object column of %s apart from the compared columns, in catalog spelling', async (_case, unit, legacyTable, columns, objectColumn) => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit, legacyTable, database });
    expect(shape.columns.map((column) => column.name)).toEqual(columns);
    expect(shape.objectColumns).toEqual([{ name: objectColumn, type: 'b' }]);
  });

  it.each([
    ['an object column the table lacks', 'reporting.export_job', 'synthetic.export_job', { nothing: 'reporting-exports' }, 'object column nothing of unit reporting.export_job is not a column of synthetic.export_job'],
    ['two object columns', 'reporting.export_job', 'synthetic.export_job', { output: 'b', output_sha256: 'b' }, 'object manifests address one object column'],
    ['a composite key', 'people.person', 'tusers', { Fname: 'b' }, 'keyed on [UserID, SiteID]'],
    ['a keyless table', 'programs_sites.system_object', 'tsystemobjects', { Name: 'b' }, 'keyed on []'],
  ])('rejects %s', async (_case, unit, legacyTable, objectColumns, message) => {
    const { deps, database } = setup();
    const odd: UnitCatalog = {
      ...catalog,
      unitsForLegacyTable: (table) => catalog.unitsForLegacyTable(table).map((target) => ({ ...target, objectColumns })),
    };
    await expect(describeUnitTable({ ...deps, catalog: odd }, { unit, legacyTable, database })).rejects.toThrow(message);
  });
});

describe('createTenantResolver', () => {
  it('lists the tenant of every site and the umbrella, sorted', async () => {
    const { deps, database } = setup();
    const tenants = await createTenantResolver(deps, { database });
    expect(tenants.siteTenants()).toEqual([tenantIdForSite('default'), A, B, UMBRELLA].sort());
  });

  it.each([
    ['site column', 'tusers', { SiteID: 'TENANT-A ' }, { tenantId: A, orphan: false }],
    ['null site column', 'tusers', { SiteID: null }, { tenantId: UMBRELLA, orphan: true }],
    ['parent row', 'tusersmemb', { UserID: 'U04' }, { tenantId: B, orphan: false }],
    ['missing parent row', 'tusersmemb', { UserID: 'U99' }, { tenantId: UMBRELLA, orphan: true }],
    ['parents in two tenants', 'tuserstrikes', { username: 'alice' }, { tenantId: UMBRELLA, orphan: true }],
    ['pooled parent', 'tuserstrikes', { username: 'bob' }, { tenantId: UMBRELLA, orphan: false }],
    ['grandparent row', 'tmembnotes', { memberID: 'u01' }, { tenantId: A, orphan: false }],
    ['program_site by column', 'Program_N.timesheet', { legacy_program_id: '2' }, { tenantId: B, orphan: false }],
    ['program_site by schema', 'Program_1.timesheet', {}, { tenantId: A, orphan: false }],
    ['unknown program', 'Program_7.timesheet', {}, { tenantId: UMBRELLA, orphan: true }],
  ])('resolves by %s', async (_case, table, row, expected) => {
    const { deps, database } = setup();
    expect((await createTenantResolver(deps, { database })).resolve(table, row)).toEqual(expected);
  });

  it('places program rows under the umbrella when the fixtures are not loaded', async () => {
    const { deps, bare } = setup();
    const tenants = await createTenantResolver(deps, { database: bare });
    expect(tenants.resolve('Program_1.timesheet', { legacy_program_id: '1' })).toEqual({ tenantId: UMBRELLA, orphan: true });
    expect(tenants.siteTenants()).toEqual([tenantIdForSite('default'), UMBRELLA].sort());
  });

  it.each([
    ['a table the ownership file does not record', 'tunknown', 'records no legacy table tunknown'],
    ['a table without a tenant rule', 'synthetic.program_site', 'has tenant rule "none"'],
  ])('rejects %s', async (_case, table, message) => {
    const { deps, database } = setup();
    const tenants = await createTenantResolver(deps, { database });
    expect(() => tenants.resolve(table, {})).toThrow(message);
  });
});

describe('readLegacyUnitRows', () => {
  it('keeps only the Type 2 rows for the person unit, projected and encoded over its columns', async () => {
    const { shape, byTenant, counts, orphans } = await rowsOf('people.person', 'tusers');
    expect(keysOf(byTenant, 'UserID')).toEqual({ [A]: ['U01'], [UMBRELLA]: ['U03'], [B]: ['U04'] });
    expect([...counts]).toEqual([A, B, UMBRELLA].sort().map((tenantId) => [tenantId, 1]));
    const [row] = byTenant.get(A) ?? [];
    const values = { UserID: 'U01', SiteID: 'tenant-a', Fname: 'Alice' };
    expect(row).toEqual({
      table: 'tusers',
      key: encodeKey(shape.columns, shape.keyColumns, values),
      keyValues: ['U01', 'tenant-a'],
      encoding: encodeRow(shape.columns, values),
      row: values,
    });
    expect(orphans.size).toBe(0);
  });

  it.each([
    ['people.user_address', { [A]: ['A1'] }],
    ['identity.user_address', { [A]: ['A2'] }],
  ])('splits child rows by the owning user type for %s', async (unit, expected) => {
    const { byTenant } = await rowsOf(unit, 'tuseraddresses');
    expect(keysOf(byTenant, 'addressID')).toEqual(expected);
  });

  it.each([
    ['content.extend_subtype', 'tclassextend', 'subTypeID', ['S1']],
    ['people.extend_subtype', 'tclassextend', 'subTypeID', ['S2']],
    ['content.extend_set', 'tclassextendsets', 'extendSetID', ['E1']],
    ['people.extend_set', 'tclassextendsets', 'extendSetID', ['E2']],
  ])('splits %s of %s by base table', async (unit, table, column, expected) => {
    const { byTenant } = await rowsOf(unit, table);
    expect(keysOf(byTenant, column)).toEqual({ [A]: expected });
  });

  it.each([
    ['content.trash', ['O1']],
    ['people.trash', ['O2', 'O5']],
    ['identity.trash', ['O3', 'O4', 'U98']],
  ])('splits trash rows by their class map for %s', async (unit, expected) => {
    const { byTenant } = await rowsOf(unit, 'ttrash');
    expect(keysOf(byTenant, 'objectID')).toEqual({ [A]: expected });
  });

  it.each([
    ['people.trash', { [A]: ['O5'] }],
    ['content.trash', {}],
  ])('assigns trashed extend objects of %s by the single base table their subtype key carries', async (unit, expected) => {
    const subtype = (subTypeID: string, baseTable: string, type: string): Row => ({ subTypeID, siteID: 'tenant-a', baseTable, type, subType: 'Default' });
    const trashed = (objectID: string, objectType: string): Row => ({
      objectID,
      parentID: 'NA',
      siteID: 'tenant-a',
      objectClass: 'extendObject',
      objectType,
      objectSubType: 'Default',
    });
    const tables = {
      // User/Default carries tusers twice, once padded; Page/Default carries two base tables, so it decides nothing.
      'dbo.tclassextend': { ...(TABLES['dbo.tclassextend'] as FakeTable), rows: [subtype('S1', 'tcontent', 'Page'), subtype('S2', 'tusers', 'User'), subtype('S3', 'TUSERS ', 'User'), subtype('S4', 'tsettings', 'Page')] },
      'dbo.ttrash': { ...(TABLES['dbo.ttrash'] as FakeTable), rows: [trashed('O5', 'User'), trashed('O8', 'Page')] },
    };
    const { byTenant } = await rowsOf(unit, 'ttrash', { tables });
    expect(keysOf(byTenant, 'objectID')).toEqual(expected);
  });

  it('places a child without a parent under the umbrella and lists its key as an orphan', async () => {
    const { byTenant, orphans } = await rowsOf('identity.membership', 'tusersmemb');
    expect(keysOf(byTenant, 'UserID')).toEqual({ [A]: ['U01'], [UMBRELLA]: ['U99'] });
    expect(orphans).toEqual(new Map([[UMBRELLA, { keys: [byTenant.get(UMBRELLA)?.[0]?.key], count: 1 }]]));
  });

  it(`lists the first ${String(DIFFERENCE_LIMIT)} orphan keys in extraction order and counts them all`, async () => {
    const members = Array.from({ length: DIFFERENCE_LIMIT + 50 }, (_, index) => ({ UserID: `X${String(index).padStart(3, '0')}`, GroupID: 'U02' }));
    const tables = { 'dbo.tusersmemb': { ...(TABLES['dbo.tusersmemb'] as FakeTable), rows: members } };
    const { byTenant, orphans } = await rowsOf('identity.membership', 'tusersmemb', { tables });
    const keys = (byTenant.get(UMBRELLA) ?? []).map((row) => row.key);
    expect(keys).toHaveLength(DIFFERENCE_LIMIT + 50);
    expect(orphans).toEqual(new Map([[UMBRELLA, { keys: keys.slice(0, DIFFERENCE_LIMIT), count: DIFFERENCE_LIMIT + 50 }]]));
  });

  it('folds Program_<id> rows onto the tenant of their program site, ordered by canonical key text', async () => {
    const { byTenant } = await rowsOf('timesheets.timesheet', 'Program_N.timesheet');
    const a = byTenant.get(A) ?? [];
    expect(a.map((row) => [row.row.timesheet_id, row.legacyProgramId])).toEqual([
      ['10', 1],
      ['9', 1],
    ]);
    expect(a.map((row) => row.keyValues)).toEqual([
      ['10', '1'],
      ['9', '1'],
    ]);
    expect(byTenant.get(B)?.map((row) => [row.row.timesheet_id, row.row.legacy_program_id])).toEqual([['9', '2']]);
  });

  it('compares a keyless table as whole rows and keys its orphans by the SHA-256 of their encoding', async () => {
    const { shape, byTenant, orphans } = await rowsOf('programs_sites.system_object', 'tsystemobjects');
    const rows = byTenant.get(A) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.key === row.encoding && row.keyValues.length === 0)).toBe(true);
    const orphan = encodeRow(shape.columns, { SiteID: null, Object: 'x', Name: 'X' });
    expect(orphans).toEqual(new Map([[UMBRELLA, { keys: [sha256Hex(orphan)], count: 1 }]]));
  });

  it.each([
    ['people.person', 'tusers'],
    ['identity.trash', 'ttrash'],
    ['timesheets.timesheet', 'Program_N.timesheet'],
    ['programs_sites.system_object', 'tsystemobjects'],
  ])('reads %s of %s alike through spilled sort runs, leaving no spill files', async (unit, table) => {
    const spillDir = await mkdtemp(join(dir, 'spill-'));
    const spilled = await rowsOf(unit, table, { sortRunBytes: 1, spillDir });
    expect(spilled).toEqual(await rowsOf(unit, table));
    expect(await readdir(spillDir)).toEqual([]);
  });

  it('removes its spill files when a row fails to resolve', async () => {
    const { deps, database } = setup();
    const real = await createTenantResolver(deps, { database });
    let resolved = 0;
    const tenants: TenantResolver = {
      resolve: (table, row) => {
        resolved += 1;
        if (resolved > 1) throw new Error('resolver failed');
        return real.resolve(table, row);
      },
      siteTenants: () => real.siteTenants(),
    };
    const shape = await describeUnitTable(deps, { unit: 'content.content', legacyTable: 'tcontent', database });
    const spillDir = await mkdtemp(join(dir, 'spill-'));
    await expect(readLegacyUnitRows(deps, shape, { database, tenants, sortRunBytes: 1, spillDir })).rejects.toThrow('resolver failed');
    expect(await readdir(spillDir)).toEqual([]);
  });

  it('builds its own lookups for a resolver it did not create', async () => {
    const { deps, database } = setup();
    const real = await createTenantResolver(deps, { database });
    const tenants: TenantResolver = { resolve: (table, row) => real.resolve(table, row), siteTenants: () => real.siteTenants() };
    const shape = await describeUnitTable(deps, { unit: 'people.user_address', legacyTable: 'tuseraddresses', database });
    const byTenant = await collect(await readLegacyUnitRows(deps, shape, { database, tenants }));
    expect(keysOf(byTenant, 'addressID')).toEqual({ [A]: ['A1'] });
  });

  it('rejects a row predicate it cannot evaluate', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'people.person', legacyTable: 'tusers', database });
    const tenants = await createTenantResolver(deps, { database });
    const odd: UnitCatalog = {
      ...catalog,
      unitsForLegacyTable: (table) => catalog.unitsForLegacyTable(table).map((target) => ({ ...target, rowPredicate: 'Type > 1' })),
    };
    await expect(readLegacyUnitRows({ ...deps, catalog: odd }, shape, { database, tenants })).rejects.toThrow('cannot evaluate');
  });

  it.each([
    [
      'Program_<id> tables per program',
      'finance.attachment',
      'Program_N.finance_attachment',
      new Map([
        [A, [expected('Program_1.finance_attachment/AT1', ATTACHMENT_A1), expected('Program_1.finance_attachment/AT2', ATTACHMENT_A2)]],
        [B, [expected('Program_2.finance_attachment/AT1', ATTACHMENT_B1)]],
      ]),
    ],
    [
      'the qualified table, with no object for a NULL value',
      'reporting.export_job',
      'synthetic.export_job',
      new Map([
        [A, [expected('synthetic.export_job/J1', OUTPUT_J1)]],
        [B, [expected('synthetic.export_job/J3', OUTPUT_J3)]],
      ]),
    ],
  ])('keys the expected objects by legacyPath, naming %s, and leaves the bytes out of the rows', async (_case, unit, table, objects) => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit, legacyTable: table, database });
    const tenants = await createTenantResolver(deps, { database });
    const legacy = await readLegacyUnitRows(deps, shape, { database, tenants });
    expect(legacy.objects).toEqual(objects);
    const rows = [...(await collect(legacy)).values()].flat();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(Object.keys(row.row)).toEqual(shape.columns.map((column) => column.name));
  });

  it('expects no objects of a table without object columns', async () => {
    const { deps, database } = setup();
    const shape = await describeUnitTable(deps, { unit: 'content.content', legacyTable: 'tcontent', database });
    const legacy = await readLegacyUnitRows(deps, shape, { database, tenants: await createTenantResolver(deps, { database }) });
    await legacy.dispose();
    expect(legacy.objects).toEqual(new Map());
  });
});

describe('objectLegacyPath', () => {
  const shape = (legacyTable: string, folded: boolean): Pick<UnitTableShape, 'unit' | 'legacyTable' | 'keyColumns' | 'folded'> => ({
    unit: 'u.t',
    legacyTable,
    keyColumns: folded ? ['id', 'legacy_program_id'] : ['id'],
    folded,
  });

  it.each([
    ['a folded generic name', 'Program_N.finance_attachment', true, 2, 'Program_2.finance_attachment/X'],
    ['a folded physical name', '[Program_1].[finance_attachment]', true, 7, 'Program_7.finance_attachment/X'],
    ['a synthetic table', 'synthetic.export_job', false, undefined, 'synthetic.export_job/X'],
    ['a dbo table', 'dbo.tfiles', false, undefined, 'tfiles/X'],
  ])('names the row of %s', (_case, legacyTable, folded, legacyProgramId, path) => {
    expect(objectLegacyPath(shape(legacyTable, folded), { row: { id: 'X' }, legacyProgramId })).toBe(path);
  });

  it.each([
    ['without a key value', 'synthetic.export_job', false, { id: null }, undefined, 'has no key value'],
    ['of a folded table without a program', 'Program_N.finance_attachment', true, { id: 'X' }, undefined, 'has no program'],
  ])('rejects a row %s', (_case, legacyTable, folded, row, legacyProgramId, message) => {
    expect(() => objectLegacyPath(shape(legacyTable, folded), { row, legacyProgramId })).toThrow(message);
  });
});

describe('toUnitRow', () => {
  const columns: CanonicalColumn[] = [
    { name: 'id', type: 'i' },
    { name: 'name', type: 's' },
  ];

  it.each([
    [true, ['id'], encodeKey(columns, ['id'], { id: '7', name: 'a' }), ['7']],
    [false, [], encodeRow(columns, { id: '7', name: 'a' }), []],
  ])('keys a row (keyed %s)', (keyed, keyColumns, key, keyValues) => {
    const shape: Pick<UnitTableShape, 'legacyTable' | 'keyed' | 'keyColumns' | 'columns'> = { legacyTable: 't', keyed, keyColumns, columns };
    const row = toUnitRow(shape, { id: '7', name: 'a' }, 2);
    expect(row).toMatchObject({ table: 't', legacyProgramId: 2, key, keyValues, encoding: encodeRow(columns, { id: '7', name: 'a' }) });
    expect([row, toUnitRow(shape, { id: '10', name: 'a' })].sort(compareCanonicalRows)[0]?.row.id).toBe(keyed ? '10' : '7');
  });
});

describe('fileUnitIds', () => {
  it("names strategies-content's file_object unit", () => {
    expect(fileUnitIds(loadConfig())).toEqual(['content.file_object']);
  });
});

const listing = (files: { name: string; size?: number; sha256?: string }[], fileStore = 'fileDir'): FileListing => ({
  fileStore,
  serverTime: '2026-06-30T00:00:00Z',
  files: files.map(({ name, size = 3, sha256 = 'AB'.repeat(32) }) => ({ name, fileId: name.slice(0, 35), variant: '', ext: '', size, sha256, lastModified: '' })),
});

describe('readLegacyObjects', () => {
  it('lists the live store per site and keys each object under the tenant of its tfiles row', async () => {
    const listings: Record<string, FileListing> = {
      'tenant-a': listing([{ name: `${FILE_A}.jpg`, size: 5 }, { name: `${FILE_A}_small.jpg` }, { name: `${FILE_X}.pdf` }, { name: 'readme.txt' }]),
      'tenant-b': listing([{ name: `${FILE_A}.jpg` }]),
      default: listing([]),
      umbrella: listing([{ name: `${FILE_N}.png` }]),
    };
    const filesList = vi.fn((siteId: string) => Promise.resolve(listings[siteId] as FileListing));
    const { deps, database } = setup({ bridge: { filesList } as unknown as BridgeClient });
    const objects = await readLegacyObjects(deps, { legacySource: 'live', database });
    const hash = 'ab'.repeat(32);
    expect(objects).toEqual({
      status: 'compared',
      byTenant: new Map([
        [
          A,
          [
            { key: `${A}/${FILE_A}.jpg`, size: 5, sha256: hash, orphan: false },
            { key: `${A}/${FILE_A}_small.jpg`, size: 3, sha256: hash, orphan: false },
          ],
        ],
        [
          UMBRELLA,
          [
            { key: `${UMBRELLA}/${FILE_X}.pdf`, size: 3, sha256: hash, orphan: true },
            { key: `${UMBRELLA}/${FILE_N}.png`, size: 3, sha256: hash, orphan: true },
          ],
        ],
      ]),
    });
    expect(filesList.mock.calls.map(([site]) => site)).toEqual(['default', 'tenant-a', 'tenant-b', 'umbrella']);
  });

  it.each([
    ['a listing of another store', () => Promise.resolve(listing([], 's3')), 's3'],
    ['a bridge 409', () => Promise.reject(new UnsupportedFileStoreError('files.list', { error: 'unsupportedFileStore', message: 's3' })), 's3'],
  ])('halts on %s instead of throwing', async (_case, filesList, store) => {
    const { deps, database } = setup({ bridge: { filesList } as unknown as BridgeClient });
    expect(await readLegacyObjects(deps, { legacySource: 'live', database })).toMatchObject({ status: 'halted', store });
  });

  /** Migration database answering one snapshot row and its manifest. */
  function migrationDb(snapshot: Row | undefined, manifest: readonly Row[] = []): TenantDb {
    const query = (sql: string): Promise<{ rows: readonly Row[] }> => {
      if (sql === SNAPSHOT_SQL) return Promise.resolve({ rows: snapshot === undefined ? [] : [snapshot] });
      if (sql === MANIFEST_PAGE_SQL) return Promise.resolve({ rows: manifest });
      return Promise.reject(new Error(`unexpected statement: ${sql}`));
    };
    return { withMetadata: (fn: (tx: { query: typeof query }) => unknown) => fn({ query }) } as unknown as TenantDb;
  }

  const manifestRow = (siteId: string, name: string, orphan = false): Row => ({
    site_id: siteId,
    path: `${siteId}/cache/file/${name}`,
    file_id: name.slice(0, 35),
    variant: '',
    ext: name.slice(name.lastIndexOf('.') + 1),
    size: '4',
    sha256: 'CD'.repeat(32),
    orphan,
  });

  it("places a snapshot's manifest objects as the transfer does, leaving out misplaced copies", async () => {
    const manifest = [manifestRow('tenant-a', `${FILE_A}.jpg`), manifestRow('tenant-a', `${FILE_X}.pdf`, true), manifestRow('tenant-b', `${FILE_A}.jpg`)];
    const { deps, database } = setup({ db: migrationDb({ state: 'ready', manifest_complete: true }, manifest) });
    const hash = 'cd'.repeat(32);
    expect(await readLegacyObjects(deps, { legacySource: 'snapshot', snapshotSeq: 3, database })).toEqual({
      status: 'compared',
      byTenant: new Map([
        [A, [{ key: `${A}/${FILE_A}.jpg`, size: 4, sha256: hash, orphan: false }]],
        [UMBRELLA, [{ key: `${UMBRELLA}/${FILE_X}.pdf`, size: 4, sha256: hash, orphan: true }]],
      ]),
    });
  });

  it('halts for a ready snapshot without a complete manifest', async () => {
    const { deps, database } = setup({ db: migrationDb({ state: 'ready', manifest_complete: false }) });
    expect(await readLegacyObjects(deps, { legacySource: 'snapshot', snapshotSeq: 3, database })).toMatchObject({ status: 'halted', store: 'unknown' });
  });

  it.each([
    ['an unknown snapshot', undefined, 3, 'unknown snapshot 3'],
    ['a failed snapshot', { state: 'failed', manifest_complete: false }, 3, 'snapshot 3 is failed'],
    ['no snapshot number', undefined, null, 'needs snapshotSeq'],
  ])('rejects %s', async (_case, snapshot, snapshotSeq, message) => {
    const { deps, database } = setup({ db: migrationDb(snapshot) });
    await expect(readLegacyObjects(deps, { legacySource: 'snapshot', snapshotSeq, database })).rejects.toThrow(message);
  });
});

describe('reconciling through spilled sides', () => {
  type ExportRows = { values: Record<string, CanonicalValue>; legacyProgramId?: number }[];
  const PERSON_COLUMNS: CanonicalColumn[] = [
    { name: 'UserID', type: 's' },
    { name: 'SiteID', type: 's' },
    { name: 'Fname', type: 's' },
  ];
  const OBJECT_COLUMNS: CanonicalColumn[] = [
    { name: 'SiteID', type: 's' },
    { name: 'Object', type: 's' },
    { name: 'Name', type: 's' },
  ];
  const TIMESHEET_COLUMNS: CanonicalColumn[] = [
    { name: 'timesheet_id', type: 'i' },
    { name: 'person_id', type: 's' },
  ];
  /** Per unit: the exported legacy table, its columns and each tenant's rows in PostgreSQL key order. */
  const EXPORTS: Record<string, { legacyTable: string; columns: CanonicalColumn[]; tenants: Record<string, ExportRows> }> = {
    'people.person': {
      legacyTable: 'tusers',
      columns: PERSON_COLUMNS,
      tenants: {
        [A]: [{ values: { UserID: 'U01', SiteID: 'tenant-a', Fname: 'Alicia' } }],
        [UMBRELLA]: [{ values: { UserID: 'U03', SiteID: 'umbrella', Fname: 'Bob' } }, { values: { UserID: 'U07', SiteID: 'umbrella', Fname: 'Eve' } }],
      },
    },
    'programs_sites.system_object': {
      legacyTable: 'tsystemobjects',
      columns: OBJECT_COLUMNS,
      tenants: { [A]: [{ values: { SiteID: 'tenant-a', Object: 'nav', Name: 'Nav' } }], [UMBRELLA]: [{ values: { SiteID: null, Object: 'x', Name: 'X' } }] },
    },
    'timesheets.timesheet': {
      legacyTable: 'timesheet',
      columns: TIMESHEET_COLUMNS,
      tenants: {
        [A]: [
          { values: { timesheet_id: '9', person_id: 'U01' }, legacyProgramId: 1 },
          { values: { timesheet_id: '10', person_id: 'U01' }, legacyProgramId: 1 },
        ],
        [B]: [{ values: { timesheet_id: '9', person_id: 'U05' }, legacyProgramId: 2 }],
      },
    },
  };

  /** Owners exporting `EXPORTS` one row per page, a tenant without rows as one empty page of its table. */
  const owners = {
    async *exportPages(_owner: string, params: ExportParams): AsyncGenerator<ExportResponse> {
      const unit = EXPORTS[params.unit];
      if (unit === undefined) throw new Error(`no export of ${params.unit}`);
      const rows = unit.tenants[params.tenantId] ?? [];
      const pages = rows.length === 0 ? [[]] : rows.map((row) => [row]);
      for (const [index, pageRows] of pages.entries()) {
        yield await Promise.resolve({
          unit: params.unit,
          tenantId: params.tenantId,
          next: index === pages.length - 1 ? null : `page-${String(index + 1)}`,
          tables: [
            {
              unit: params.unit,
              legacyTable: unit.legacyTable,
              targetTable: 'schema.table',
              keyless: false,
              columns: unit.columns,
              rows: pageRows.map(({ values, legacyProgramId }) => ({
                key: 'owner-key',
                row: encodeRow(unit.columns, values),
                hash: 'owner-hash',
                ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
              })),
            },
          ],
        });
      }
    },
  } as unknown as OwnersClient;

  const UNITS = ['people.person', 'programs_sites.system_object', 'timesheets.timesheet'];

  function reconcile(sorting: { sortRunBytes?: number; spillDir?: string }, overrides: ReconcileSources = {}) {
    const { deps, database } = setup();
    const ctx = { ...deps, owners, env: {}, clock: fixedClock('2026-06-30T12:00:00.000Z'), gateway: {} } as unknown as ReconcileContext;
    const sources: ReconcileSources = {
      tableVersion: () => Promise.resolve('v0002'),
      legacyRows: (legacyDeps, shape, options) => readLegacyUnitRows(legacyDeps, shape, { ...options, ...sorting }),
      targetRows: (targetDeps, shape, tenantId, options) => readTargetUnitRows(targetDeps, shape, tenantId, { ...options, ...sorting }),
      ...overrides,
    };
    return reconcileUnits(ctx, { point: 'post-cutover', units: UNITS, database }, sources);
  }

  it('measures both sides through spilled runs exactly as in memory', async () => {
    const spillDir = await mkdtemp(join(dir, 'spill-'));
    const inMemory = await reconcile({});
    const spilled = await reconcile({ sortRunBytes: 1, spillDir });

    expect(spilled.units).toEqual(inMemory.units);
    expect(spilled.summary).toEqual(inMemory.summary);
    expect(await readdir(spillDir)).toEqual([]);
    expect(spilled.result).toBe('difference');
    expect(spilled.units.map((entry) => [entry.unit, entry.tenantId, entry.legacyCount, entry.targetCount, entry.differences.map((d) => d.kind)])).toEqual(
      expect.arrayContaining([
        ['people.person', A, 1, 1, ['changed']],
        ['people.person', B, 1, 0, ['missing-in-target']],
        ['people.person', UMBRELLA, 1, 2, ['extra-in-target']],
        ['programs_sites.system_object', A, 2, 1, ['missing-in-target']],
        ['programs_sites.system_object', UMBRELLA, 1, 1, []],
        ['timesheets.timesheet', A, 2, 2, []],
        ['timesheets.timesheet', B, 1, 1, ['changed']],
      ]),
    );
    expect(spilled.units).toHaveLength(7);
    const orphaned = spilled.units.find((entry) => entry.unit === 'programs_sites.system_object' && entry.tenantId === UMBRELLA);
    expect(orphaned?.orphanCount).toBe(1);
    expect(orphaned?.legacySha256).toBe(orphaned?.targetSha256);
  });

  it('removes every spill file when a target read fails mid-table', async () => {
    const spillDir = await mkdtemp(join(dir, 'spill-'));
    let reads = 0;
    const targetRows: ReconcileSources['targetRows'] = async (targetDeps, shape, tenantId, options) => {
      reads += 1;
      if (reads > 2) throw new Error('owner unreachable');
      return readTargetUnitRows(targetDeps, shape, tenantId, { ...options, sortRunBytes: 1, spillDir });
    };

    await expect(reconcile({ sortRunBytes: 1, spillDir }, { targetRows })).rejects.toThrow('owner unreachable');
    expect(await readdir(spillDir)).toEqual([]);
  });
});

describe('reconciling object columns through the owners exports', () => {
  type Manifest = NonNullable<ExportResponse['objects']>;
  interface TenantExport {
    rows: { values: Record<string, CanonicalValue>; legacyProgramId?: number }[];
    objects: Manifest;
  }
  const ATTACHMENT_EXPORT: CanonicalColumn[] = [
    { name: 'attachment_id', type: 's' },
    { name: 'record_id', type: 's' },
    { name: 'sha256', type: 's' },
  ];
  const JOB_EXPORT: CanonicalColumn[] = [
    { name: 'job_id', type: 's' },
    { name: 'siteid', type: 's' },
    { name: 'output_sha256', type: 's' },
  ];
  const UNITS = ['finance.attachment', 'reporting.export_job'];

  /** A stored object as the owners list it: a key of their own, the upper-case hash of the bytes and the row's legacyPath. */
  const stored = (legacyPath: string, bytes: Buffer): Manifest[number] => ({
    key: `tenant/${sha256Hex(legacyPath).slice(0, 12)}.bin`,
    size: bytes.length,
    sha256: sha256Hex(bytes).toUpperCase(),
    contentType: 'application/octet-stream',
    legacyPath,
  });
  const attachmentRow = (id: string, record: string, bytes: Buffer, legacyProgramId: number) => ({
    values: { attachment_id: id, record_id: record, sha256: sha256Hex(bytes) },
    legacyProgramId,
  });
  const jobRow = (id: string, site: string, bytes: Buffer | null) => ({
    values: { job_id: id, siteid: site, output_sha256: bytes === null ? null : sha256Hex(bytes) },
  });

  /** The owners' exports of the legacy fixture data, attachments of tenant A passed through `objectsOfA`. */
  function exports(objectsOfA: (objects: Manifest) => Manifest = (objects) => objects): Record<string, { legacyTable: string; columns: CanonicalColumn[]; tenants: Record<string, TenantExport> }> {
    return {
      'finance.attachment': {
        legacyTable: 'finance_attachment',
        columns: ATTACHMENT_EXPORT,
        tenants: {
          [A]: {
            rows: [attachmentRow('AT1', 'R1', ATTACHMENT_A1, 1), attachmentRow('AT2', 'R1', ATTACHMENT_A2, 1)],
            objects: objectsOfA([stored('Program_1.finance_attachment/AT1', ATTACHMENT_A1), stored('Program_1.finance_attachment/AT2', ATTACHMENT_A2)]),
          },
          [B]: { rows: [attachmentRow('AT1', 'R7', ATTACHMENT_B1, 2)], objects: [stored('Program_2.finance_attachment/AT1', ATTACHMENT_B1)] },
        },
      },
      'reporting.export_job': {
        legacyTable: 'synthetic.export_job',
        columns: JOB_EXPORT,
        tenants: {
          [A]: { rows: [jobRow('J1', 'tenant-a', OUTPUT_J1), jobRow('J2', 'tenant-a', null)], objects: [stored('synthetic.export_job/J1', OUTPUT_J1)] },
          [B]: { rows: [jobRow('J3', 'tenant-b', OUTPUT_J3)], objects: [stored('synthetic.export_job/J3', OUTPUT_J3)] },
        },
      },
    };
  }

  /** Owners serving `served` as one page per tenant, its table always present and its manifest on that page. */
  function ownersOf(served: ReturnType<typeof exports>): OwnersClient {
    return {
      async *exportPages(_owner: string, params: ExportParams): AsyncGenerator<ExportResponse> {
        const unit = served[params.unit];
        if (unit === undefined) throw new Error(`no export of ${params.unit}`);
        const tenant = unit.tenants[params.tenantId] ?? { rows: [], objects: [] };
        const rows = tenant.rows.map(({ values, legacyProgramId }) => ({
          key: 'owner-key',
          row: encodeRow(unit.columns, values),
          hash: 'owner-hash',
          ...(legacyProgramId === undefined ? {} : { legacyProgramId }),
        }));
        const table = { unit: params.unit, legacyTable: unit.legacyTable, targetTable: 'schema.table', keyless: false, columns: unit.columns, rows };
        yield await Promise.resolve({ unit: params.unit, tenantId: params.tenantId, next: null, tables: [table], objects: tenant.objects });
      },
    } as unknown as OwnersClient;
  }

  function reconcile(served: ReturnType<typeof exports>, tables?: Record<string, FakeTable>) {
    const { deps, database } = setup({ tables });
    const ctx = { ...deps, owners: ownersOf(served), env: {}, clock: fixedClock('2026-06-30T12:00:00.000Z'), gateway: {} } as unknown as ReconcileContext;
    return reconcileUnits(ctx, { point: 'post-cutover', units: UNITS, database }, { tableVersion: () => Promise.resolve('v0002') });
  }

  it('compares each legacy value with the stored object of the same legacyPath and finds no difference for equal bytes', async () => {
    const report = await reconcile(exports());

    expect(report.result).toBe('zero-difference');
    expect(report.fileStore.status).toBe('not-applicable');
    const measured = report.units.map((entry) => [entry.unit, entry.tenantId, entry.legacyCount, entry.files?.legacyObjects, entry.files?.targetObjects]);
    expect(measured).toHaveLength(4);
    expect(measured).toEqual(
      expect.arrayContaining([
        ['finance.attachment', A, 2, 2, 2],
        ['finance.attachment', B, 1, 1, 1],
        ['reporting.export_job', A, 2, 1, 1],
        ['reporting.export_job', B, 1, 1, 1],
      ]),
    );
  });

  it('reconciles empty object-backed tables without a shape error', async () => {
    const empty = (name: string): FakeTable => ({ ...(TABLES[name] as FakeTable), rows: [] });
    const served = exports();
    for (const unit of Object.values(served)) unit.tenants = {};
    const tables = { 'Program_1.finance_attachment': empty('Program_1.finance_attachment'), 'Program_2.finance_attachment': empty('Program_2.finance_attachment'), 'synthetic.export_job': empty('synthetic.export_job') };

    const report = await reconcile(served, tables);

    expect(report).toMatchObject({ result: 'zero-difference', units: [] });
  });

  it.each<[string, (objects: Manifest) => Manifest, object]>([
    [
      'a changed stored hash',
      ([first, ...rest]) => [{ ...(first as Manifest[number]), sha256: sha256Hex(ATTACHMENT_B1) }, ...rest],
      { kind: 'object-mismatch', key: 'Program_1.finance_attachment/AT1', column: 'sha256', legacy: sha256Hex(ATTACHMENT_A1), target: sha256Hex(ATTACHMENT_B1) },
    ],
    [
      'a changed stored size',
      ([first, ...rest]) => [{ ...(first as Manifest[number]), size: ATTACHMENT_A1.length + 1 }, ...rest],
      { kind: 'object-mismatch', key: 'Program_1.finance_attachment/AT1', column: 'size', legacy: String(ATTACHMENT_A1.length), target: String(ATTACHMENT_A1.length + 1) },
    ],
    ['a missing target object', (objects) => objects.slice(0, 1), { kind: 'object-missing-in-target', key: 'Program_1.finance_attachment/AT2' }],
    [
      'an extra target object',
      (objects) => [...objects, stored('Program_1.finance_attachment/AT9', ATTACHMENT_B1)],
      { kind: 'object-extra-in-target', key: 'Program_1.finance_attachment/AT9', target: sha256Hex(ATTACHMENT_B1) },
    ],
  ])('reports %s as an object difference with zero tolerance', async (_case, objectsOfA, difference) => {
    const report = await reconcile(exports(objectsOfA));

    expect(report.result).toBe('difference');
    expect(report.summary).toMatchObject({ unitsWithDifferences: 1, differences: 1 });
    const entry = report.units.find((candidate) => candidate.unit === 'finance.attachment' && candidate.tenantId === A);
    expect(entry).toMatchObject({ differenceCount: 1, legacySha256: entry?.targetSha256 });
    expect(entry?.differences).toEqual([expect.objectContaining(difference)]);
  });
});
