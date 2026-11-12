// Unit tests for the legacy side of reconciliation over a fake SQL Server pool, a fake bridge and a small ownership file.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeKey, encodeRow, sha256Hex, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { tenantIdForSite, type TenantDb } from '@opt2/platform/tenancy';
import type { ConnectionPool } from 'mssql';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { clearCatalogCache, compareCanonicalRows } from '../../src/extract/index.js';
import { UnsupportedFileStoreError, type BridgeClient, type FileListing, type LegacyDb } from '../../src/legacy/index.js';
import { loadUnitCatalog, type UnitCatalog } from '../../src/owners/index.js';
import {
  createTenantResolver,
  describeUnitTable,
  fileUnitIds,
  readLegacyObjects,
  readLegacyUnitRows,
  toUnitRow,
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
  ],
};

const varchar = (...names: string[]): ColumnSpec[] => names.map((name) => ({ name, type: 'varchar' }));

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

/** Context over the main fake database `muradb` and a fixture-less `bare` one; `db` and `bridge` default to unused fakes. */
function setup(overrides: { db?: TenantDb; bridge?: BridgeClient } = {}) {
  const base = loadConfig();
  const { legacy, named } = fakeLegacy({
    muradb: { tables: TABLES, raw: RAW },
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

async function rowsOf(unit: string, legacyTable: string) {
  const { deps, database } = setup();
  const shape = await describeUnitTable(deps, { unit, legacyTable, database });
  const tenants = await createTenantResolver(deps, { database });
  return { shape, ...(await readLegacyUnitRows(deps, shape, { database, tenants })) };
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
    const { shape, byTenant, orphans } = await rowsOf('people.person', 'tusers');
    expect(keysOf(byTenant, 'UserID')).toEqual({ [A]: ['U01'], [UMBRELLA]: ['U03'], [B]: ['U04'] });
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

  it('places a child without a parent under the umbrella and lists its key as an orphan', async () => {
    const { byTenant, orphans } = await rowsOf('identity.membership', 'tusersmemb');
    expect(keysOf(byTenant, 'UserID')).toEqual({ [A]: ['U01'], [UMBRELLA]: ['U99'] });
    expect(orphans).toEqual(new Map([[UMBRELLA, [byTenant.get(UMBRELLA)?.[0]?.key]]]));
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
    expect(orphans).toEqual(new Map([[UMBRELLA, [sha256Hex(orphan)]]]));
  });

  it('builds its own lookups for a resolver it did not create', async () => {
    const { deps, database } = setup();
    const real = await createTenantResolver(deps, { database });
    const tenants: TenantResolver = { resolve: (table, row) => real.resolve(table, row), siteTenants: () => real.siteTenants() };
    const shape = await describeUnitTable(deps, { unit: 'people.user_address', legacyTable: 'tuseraddresses', database });
    const { byTenant } = await readLegacyUnitRows(deps, shape, { database, tenants });
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
