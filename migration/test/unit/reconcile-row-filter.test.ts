// Unit tests for the per-row unit filter and its scoped join lookups over the fake SQL Server, held to readLegacyUnitRows.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CanonicalValue } from '@opt2/platform/migration-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { MAX_SCOPE_PARAMETERS, streamLegacyTable } from '../../src/extract/index.js';
import { loadUnitCatalog, type UnitCatalog } from '../../src/owners/index.js';
import {
  JoinLookups,
  createTenantResolver,
  createUnitRowFilter,
  describeUnitTable,
  readLegacyUnitRows,
  type ReconcileLegacyDeps,
} from '../../src/reconcile/legacy-side.js';
import { createFakeLegacyDb, type FakeLegacyDb, type LegacyColumnDef, type Row } from '../helpers/fake-legacy-db.js';

type Values = Readonly<Record<string, CanonicalValue>>;
type Deps = Pick<ReconcileLegacyDeps, 'legacy' | 'catalog' | 'config'>;

const DATABASE = 'masa_test';
const USER_READ = /FROM \[dbo\]\.\[(\w+)\]/;

const whole = (unit: string, owner: string, rowPredicate: string, keyColumns: string[]) => ({ unit, owner, rowPredicate, keyColumns, columnPolicy: 'whole-table' });
const bySite = { siteIdColumn: 'siteID', tenantResolution: 'siteID-or-umbrella' };

/** Ownership file of the split forms the row filter evaluates: a column, an owner join, resolve chains and a class map. */
const OWNERSHIP = {
  units: [
    { unit: 'identity.group_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'people.person', owner: 'people', legacyTables: ['tusers'] },
    { unit: 'identity.user_address', owner: 'identity', legacyTables: ['tuseraddresses'] },
    { unit: 'people.user_address', owner: 'people', legacyTables: ['tuseraddresses'] },
    { unit: 'content.extend_subtype', owner: 'strategies-content', legacyTables: ['tclassextend'] },
    { unit: 'people.extend_subtype', owner: 'people', legacyTables: ['tclassextend'] },
    { unit: 'content.extend_set', owner: 'strategies-content', legacyTables: ['tclassextendsets'] },
    { unit: 'people.extend_set', owner: 'people', legacyTables: ['tclassextendsets'] },
    { unit: 'content.extend_attribute', owner: 'strategies-content', legacyTables: ['tclassextendattributes'] },
    { unit: 'people.extend_attribute', owner: 'people', legacyTables: ['tclassextendattributes'] },
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
      targets: [whole('identity.group_account', 'identity', 'Type = 1', ['UserID']), whole('people.person', 'people', 'Type = 2', ['UserID'])],
    },
    {
      table: 'tuseraddresses',
      owner: 'split',
      primaryKey: ['addressID'],
      ...bySite,
      split: { by: 'ownerType', parent: { table: 'tusers', join: 'tuseraddresses.userID = tusers.UserID' } },
      targets: [whole('identity.user_address', 'identity', 'owner Type = 1', ['addressID']), whole('people.user_address', 'people', 'owner Type = 2', ['addressID'])],
    },
    {
      table: 'tclassextend',
      owner: 'split',
      primaryKey: ['subTypeID'],
      ...bySite,
      split: { by: 'baseTable', resolve: 'tclassextend.baseTable' },
      targets: [
        whole('content.extend_subtype', 'strategies-content', "baseTable = 'tcontent'", ['subTypeID']),
        whole('people.extend_subtype', 'people', "baseTable in ('tusers', 'tusersaddresses')", ['subTypeID']),
      ],
    },
    {
      table: 'tclassextendsets',
      owner: 'split',
      primaryKey: ['extendSetID'],
      ...bySite,
      split: { by: 'baseTable', resolve: 'tclassextendsets.subTypeID = tclassextend.subTypeID' },
      targets: [
        whole('content.extend_set', 'strategies-content', "baseTable = 'tcontent'", ['extendSetID']),
        whole('people.extend_set', 'people', "baseTable in ('tusers', 'tusersaddresses')", ['extendSetID']),
      ],
    },
    {
      table: 'tclassextendattributes',
      owner: 'split',
      primaryKey: ['attributeID'],
      ...bySite,
      split: {
        by: 'baseTable',
        resolve: 'tclassextendattributes.extendSetID = tclassextendsets.extendSetID, then tclassextendsets.subTypeID = tclassextend.subTypeID',
      },
      targets: [
        whole('content.extend_attribute', 'strategies-content', "baseTable = 'tcontent'", ['attributeID']),
        whole('people.extend_attribute', 'people', "baseTable in ('tusers', 'tusersaddresses')", ['attributeID']),
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
        ],
      },
      targets: [
        whole('content.trash', 'strategies-content', 'classMap owner = strategies-content', ['objectID']),
        whole('people.trash', 'people', 'classMap owner = people', ['objectID']),
        whole('identity.trash', 'identity', 'classMap owner = identity', ['objectID']),
      ],
    },
  ],
};

const text = (...names: string[]): LegacyColumnDef[] => names.map((name) => ({ name, type: 'varchar', length: 50 }));

/** Fake tables in key order: unmatched joins, a case- and space-variant join value and every class-map rule. */
const TABLES: { qualified: string; columns: LegacyColumnDef[]; primaryKey: string[]; rows: Row[] }[] = [
  { qualified: 'dbo.tsettings', columns: text('SiteID'), primaryKey: ['SiteID'], rows: [{ SiteID: 'tenant-a' }, { SiteID: 'tenant-b' }] },
  {
    qualified: 'dbo.tusers',
    columns: [...text('UserID', 'SiteID'), { name: 'Type', type: 'int' }],
    primaryKey: ['UserID'],
    rows: [
      { UserID: 'U01', SiteID: 'tenant-a', Type: 2 },
      { UserID: 'U02', SiteID: 'tenant-a', Type: 1 },
      { UserID: 'U03', SiteID: 'tenant-b', Type: 2 },
    ],
  },
  {
    qualified: 'dbo.tuseraddresses',
    columns: text('addressID', 'userID', 'siteID'),
    primaryKey: ['addressID'],
    rows: [
      { addressID: 'A1', userID: 'U01', siteID: 'tenant-a' },
      { addressID: 'A2', userID: 'U02', siteID: 'tenant-a' },
      { addressID: 'A3', userID: 'U99', siteID: 'tenant-a' },
      { addressID: 'A4', userID: 'u03 ', siteID: 'tenant-b' },
      { addressID: 'A5', userID: null, siteID: 'tenant-b' },
    ],
  },
  {
    qualified: 'dbo.tclassextend',
    columns: text('subTypeID', 'siteID', 'baseTable', 'type', 'subType'),
    primaryKey: ['subTypeID'],
    rows: [
      { subTypeID: 'S1', siteID: 'tenant-a', baseTable: 'tcontent', type: 'Page', subType: 'Default' },
      { subTypeID: 'S2', siteID: 'tenant-a', baseTable: 'tusers', type: 'User', subType: 'Default' },
      { subTypeID: 'S3', siteID: 'tenant-b', baseTable: 'tsettings', type: 'Site', subType: 'Default' },
    ],
  },
  {
    qualified: 'dbo.tclassextendsets',
    columns: text('extendSetID', 'subTypeID', 'siteID'),
    primaryKey: ['extendSetID'],
    rows: [
      { extendSetID: 'E1', subTypeID: 'S1', siteID: 'tenant-a' },
      { extendSetID: 'E2', subTypeID: 'S2', siteID: 'tenant-a' },
      { extendSetID: 'E3', subTypeID: 'S9', siteID: 'tenant-a' },
    ],
  },
  {
    qualified: 'dbo.tclassextendattributes',
    columns: [{ name: 'attributeID', type: 'int' }, ...text('extendSetID', 'siteID')],
    primaryKey: ['attributeID'],
    rows: [
      { attributeID: 1, extendSetID: 'E1', siteID: 'tenant-a' },
      { attributeID: 2, extendSetID: 'E2', siteID: 'tenant-a' },
      { attributeID: 3, extendSetID: 'E3', siteID: 'tenant-a' },
      { attributeID: 4, extendSetID: 'E8', siteID: 'tenant-a' },
    ],
  },
  {
    qualified: 'dbo.ttrash',
    columns: text('objectID', 'parentID', 'siteID', 'objectClass', 'objectType', 'objectSubType'),
    primaryKey: ['objectID'],
    rows: [
      { objectID: 'O1', parentID: 'NA', siteID: 'tenant-a', objectClass: 'content', objectType: 'Page', objectSubType: 'Default' },
      { objectID: 'O2', parentID: 'NA', siteID: 'tenant-a', objectClass: 'user', objectType: 'User', objectSubType: 'Default' },
      { objectID: 'O3', parentID: 'U02', siteID: 'tenant-a', objectClass: 'address', objectType: 'address', objectSubType: 'Default' },
      { objectID: 'O4', parentID: 'U98', siteID: 'tenant-a', objectClass: 'address', objectType: 'address', objectSubType: 'Default' },
      { objectID: 'O5', parentID: 'NA', siteID: 'tenant-a', objectClass: 'extendObject', objectType: 'User', objectSubType: 'Default' },
      { objectID: 'O6', parentID: 'NA', siteID: 'tenant-a', objectClass: 'widget', objectType: 'widget', objectSubType: 'Default' },
      { objectID: 'O7', parentID: 'U01', siteID: 'tenant-a', objectClass: 'address', objectType: 'address', objectSubType: 'Default' },
      { objectID: 'U98', parentID: 'NA', siteID: 'tenant-a', objectClass: 'user', objectType: 'Group', objectSubType: 'Default' },
    ],
  },
];

let dir: string;
let ownershipFile: string;
let catalog: UnitCatalog;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-row-filter-'));
  ownershipFile = join(dir, 'table-ownership.json');
  await writeFile(ownershipFile, JSON.stringify(OWNERSHIP), 'utf8');
  catalog = loadUnitCatalog(ownershipFile);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deps over a fresh fake server holding TABLES, with `extra` rows appended to their tables. */
function setup(extra: Record<string, Row[]> = {}): { deps: Deps; fake: FakeLegacyDb } {
  const fake = createFakeLegacyDb({
    tables: TABLES.map(({ qualified, columns, primaryKey }) => ({ qualified, columns, options: { primaryKey } })),
    rows: Object.fromEntries(TABLES.map(({ qualified, rows }) => [qualified, [...rows, ...(extra[qualified] ?? [])]])),
  });
  const base = loadConfig();
  const deps: Deps = { legacy: fake, catalog, config: { ...base, paths: { ...base.paths, tableOwnership: ownershipFile } } };
  return { deps, fake };
}

/** Canonical rows of `table`, as the feed's diff streams them. */
async function tableRows(deps: Deps, table: string): Promise<Values[]> {
  const rows: Values[] = [];
  for await (const row of streamLegacyTable(deps, { table, database: DATABASE })) rows.push(row.row);
  return rows;
}

/** Keys of the rows reconciliation selects for `unit`. */
async function selected(deps: Deps, unit: string, table: string, key: string): Promise<string[]> {
  const shape = await describeUnitTable(deps, { unit, legacyTable: table, database: DATABASE });
  const tenants = await createTenantResolver(deps, { database: DATABASE });
  const legacy = await readLegacyUnitRows(deps, shape, { database: DATABASE, tenants, spillDir: dir });
  const keys: string[] = [];
  try {
    for (const tenantId of legacy.tenants) for await (const row of legacy.rows(tenantId)) keys.push(String(row.row[key]));
  } finally {
    await legacy.dispose();
  }
  return keys.sort();
}

/** Keys of the rows of `table` the unit's row filter accepts after preparing them all. */
async function filtered(deps: Deps, unit: string, table: string, key: string): Promise<string[]> {
  const filter = await createUnitRowFilter(deps, { unit, legacyTable: table, database: DATABASE, lookups: new JoinLookups(deps) });
  const rows = await tableRows(deps, table);
  await filter.prepare(rows);
  const keys: string[] = [];
  for (const row of rows) if (await filter.accepts(row)) keys.push(String(row[key]));
  return keys.sort();
}

/** User-table reads logged by the fake: the table, whether a WHERE … IN bounds it, and its parameter values sorted. */
function reads(fake: FakeLegacyDb): { table: string; scoped: boolean; keys: string[] }[] {
  return fake.statements.flatMap((statement) => {
    const table = USER_READ.exec(statement.sql)?.[1];
    if (table === undefined) return [];
    const keys = Object.values(statement.params).map((value) => String(value));
    return [{ table, scoped: / WHERE \(\[\w+\] IN \(/.test(statement.sql), keys: keys.sort() }];
  });
}

describe('createUnitRowFilter', () => {
  it.each([
    { form: 'a row column', unit: 'people.person', table: 'tusers', key: 'UserID', accepted: ['U01', 'U03'] },
    { form: 'a row column', unit: 'people.extend_subtype', table: 'tclassextend', key: 'subTypeID', accepted: ['S2'] },
    { form: 'an owner join', unit: 'people.user_address', table: 'tuseraddresses', key: 'addressID', accepted: ['A1', 'A4'] },
    { form: 'an owner join', unit: 'identity.user_address', table: 'tuseraddresses', key: 'addressID', accepted: ['A2'] },
    { form: 'a resolve join', unit: 'content.extend_set', table: 'tclassextendsets', key: 'extendSetID', accepted: ['E1'] },
    { form: 'a two-hop resolve chain', unit: 'people.extend_attribute', table: 'tclassextendattributes', key: 'attributeID', accepted: ['2'] },
    { form: 'a two-hop resolve chain', unit: 'content.extend_attribute', table: 'tclassextendattributes', key: 'attributeID', accepted: ['1'] },
    { form: 'the class map', unit: 'content.trash', table: 'ttrash', key: 'objectID', accepted: ['O1'] },
    { form: 'the class map', unit: 'people.trash', table: 'ttrash', key: 'objectID', accepted: ['O2', 'O5', 'O7'] },
    { form: 'the class map', unit: 'identity.trash', table: 'ttrash', key: 'objectID', accepted: ['O3', 'O4', 'U98'] },
  ])('accepts exactly the rows reconciliation selects for $unit through $form', async ({ unit, table, key, accepted }) => {
    const { deps } = setup();

    const expected = await selected(deps, unit, table, key);

    expect(expected).toEqual(accepted);
    expect(await filtered(deps, unit, table, key)).toEqual(expected);
  });

  it('reads each class-map join only for the keys the prepared rows reach', async () => {
    const { deps, fake } = setup();
    const filter = await createUnitRowFilter(deps, { unit: 'people.trash', legacyTable: 'ttrash', database: DATABASE, lookups: new JoinLookups(deps) });
    const rows = await tableRows(deps, 'ttrash');
    fake.clearLogs();

    await filter.prepare(rows);

    expect(reads(fake)).toEqual([
      { table: 'tusers', scoped: true, keys: ['u01', 'u02', 'u98'] },
      { table: 'ttrash', scoped: true, keys: ['u01', 'u02', 'u98'] },
      { table: 'tclassextend', scoped: true, keys: ['tenant-a'] },
    ]);
  });

  it('splits a join read over more than MAX_SCOPE_PARAMETERS keys into scoped reads of at most that many', async () => {
    const extra = Array.from({ length: MAX_SCOPE_PARAMETERS + 1 }, (_, index) => ({
      addressID: `X${String(index).padStart(5, '0')}`,
      userID: `N${String(index)}`,
      siteID: 'tenant-a',
    }));
    const { deps, fake } = setup({ 'dbo.tuseraddresses': extra });
    const filter = await createUnitRowFilter(deps, { unit: 'people.user_address', legacyTable: 'tuseraddresses', database: DATABASE, lookups: new JoinLookups(deps) });
    const rows = await tableRows(deps, 'tuseraddresses');
    fake.clearLogs();

    await filter.prepare(rows);

    const lookups = reads(fake);
    expect(lookups.map(({ table, scoped, keys }) => [table, scoped, keys.length])).toEqual([
      ['tusers', true, MAX_SCOPE_PARAMETERS],
      ['tusers', true, extra.length + 4 - MAX_SCOPE_PARAMETERS],
    ]);
    expect(lookups.flatMap(({ keys }) => keys).sort()).toEqual([...extra.map((row) => row.userID.toLowerCase()), 'u01', 'u02', 'u03', 'u99'].sort());
    const accepted: string[] = [];
    for (const row of rows) if (await filter.accepts(row)) accepted.push(String(row.addressID));
    expect(accepted).toEqual(['A1', 'A4']);
    expect(reads(fake)).toHaveLength(2);
  });

  it('judges a row no batch prepared, holds its keys until clear() and reads them again afterwards', async () => {
    const { deps, fake } = setup();
    const lookups = new JoinLookups(deps);
    const filter = await createUnitRowFilter(deps, { unit: 'people.extend_attribute', legacyTable: 'tclassextendattributes', database: DATABASE, lookups });
    const [content, people] = await tableRows(deps, 'tclassextendattributes');
    if (content === undefined || people === undefined) throw new Error('tclassextendattributes holds no rows');
    const chain = [
      { table: 'tclassextendsets', scoped: true, keys: ['e2'] },
      { table: 'tclassextend', scoped: true, keys: ['s2'] },
    ];
    fake.clearLogs();

    expect(await filter.accepts(people)).toBe(true);
    expect(reads(fake)).toEqual(chain);
    expect(await filter.accepts(people)).toBe(true);
    expect(reads(fake)).toEqual(chain);

    lookups.clear();
    fake.clearLogs();

    expect(await filter.accepts(people)).toBe(true);
    expect(reads(fake)).toEqual(chain);
    expect(await filter.accepts(content)).toBe(false);
  });
});
