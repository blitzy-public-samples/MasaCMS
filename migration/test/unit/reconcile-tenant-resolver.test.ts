// Unit tests for the batch-scoped tenant resolver and readLegacyUnitRows batches over the fake SQL Server's logged reads.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tenantIdForSite } from '@opt2/platform/tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { MAX_SCOPE_PARAMETERS } from '../../src/extract/index.js';
import { loadUnitCatalog, type UnitCatalog } from '../../src/owners/index.js';
import { createTenantResolver, describeUnitTable, readLegacyUnitRows, type ReconcileLegacyDeps } from '../../src/reconcile/legacy-side.js';
import { createFakeLegacyDb, type FakeLegacyDb, type LegacyColumnDef, type Row } from '../helpers/fake-legacy-db.js';

type Deps = Pick<ReconcileLegacyDeps, 'legacy' | 'catalog' | 'config'>;

const DATABASE = 'masa_test';
const A = tenantIdForSite('tenant-a');
const B = tenantIdForSite('tenant-b');
const UMBRELLA = tenantIdForSite('umbrella');
const READ = /FROM \[(\w+)\]\.\[(\w+)\]/;
const SCOPED = / WHERE \(\[\w+\] IN \(/;

const whole = (unit: string, owner: string, rowPredicate: string | null, keyColumns: string[]) => ({ unit, owner, rowPredicate, keyColumns, columnPolicy: 'whole-table' });
const bySite = (siteIdColumn: string) => ({ siteIdColumn, tenantResolution: 'siteID-or-umbrella' });
const byParent = (table: string, parent: string, join: string) => ({ tenantResolution: `parent:${parent}`, tenantParent: { table: parent, join } });

/** Ownership file of one- and two-hop parent rules, a parent fixture table the database lacks and a cycle. */
const OWNERSHIP = {
  units: [
    { unit: 'identity.user_account', owner: 'identity', legacyTables: ['tusers'] },
    { unit: 'identity.membership', owner: 'identity', legacyTables: ['tusersmemb'] },
    { unit: 'identity.user_strike', owner: 'identity', legacyTables: ['tuserstrikes'] },
    { unit: 'identity.membership_note', owner: 'identity', legacyTables: ['tmembnotes'] },
    { unit: 'people.user_address', owner: 'people', legacyTables: ['tuseraddresses'] },
    { unit: 'people.person_archive', owner: 'people', legacyTables: ['synthetic.person_archive'] },
    { unit: 'people.archive_note', owner: 'people', legacyTables: ['synthetic.archive_note'] },
    { unit: 'identity.loop_a', owner: 'identity', legacyTables: ['tloopa'] },
    { unit: 'identity.loop_b', owner: 'identity', legacyTables: ['tloopb'] },
  ],
  tables: [
    { table: 'tusers', owner: 'identity', primaryKey: ['UserID'], ...bySite('SiteID'), targets: [whole('identity.user_account', 'identity', null, ['UserID'])] },
    {
      table: 'tusersmemb',
      owner: 'identity',
      primaryKey: ['UserID', 'GroupID'],
      ...byParent('tusersmemb', 'tusers', 'tusersmemb.UserID = tusers.UserID'),
      targets: [whole('identity.membership', 'identity', null, ['UserID', 'GroupID'])],
    },
    {
      table: 'tuserstrikes',
      owner: 'identity',
      primaryKey: ['username'],
      ...byParent('tuserstrikes', 'tusers', 'tuserstrikes.username = tusers.UserName'),
      targets: [whole('identity.user_strike', 'identity', null, ['username'])],
    },
    {
      table: 'tmembnotes',
      owner: 'identity',
      primaryKey: ['noteID'],
      ...byParent('tmembnotes', 'tusersmemb', 'tusersmemb.UserID = tmembnotes.memberID'),
      targets: [whole('identity.membership_note', 'identity', null, ['noteID'])],
    },
    {
      table: 'tuseraddresses',
      owner: 'split',
      primaryKey: ['addressID'],
      ...bySite('siteID'),
      split: { by: 'ownerType', parent: { table: 'tusers', join: 'tuseraddresses.userID = tusers.UserID' } },
      targets: [whole('people.user_address', 'people', 'owner Type = 2', ['addressID'])],
    },
    {
      table: 'synthetic.person_archive',
      owner: 'people',
      primaryKey: ['archive_id'],
      ...bySite('siteID'),
      targets: [whole('people.person_archive', 'people', null, ['archive_id'])],
    },
    {
      table: 'synthetic.archive_note',
      owner: 'people',
      primaryKey: ['note_id'],
      ...byParent('synthetic.archive_note', 'synthetic.person_archive', 'synthetic.archive_note.archive_id = synthetic.person_archive.archive_id'),
      targets: [whole('people.archive_note', 'people', null, ['note_id'])],
    },
    { table: 'tloopa', owner: 'identity', primaryKey: ['id'], ...byParent('tloopa', 'tloopb', 'tloopa.b = tloopb.id'), targets: [whole('identity.loop_a', 'identity', null, ['id'])] },
    { table: 'tloopb', owner: 'identity', primaryKey: ['id'], ...byParent('tloopb', 'tloopa', 'tloopb.a = tloopa.id'), targets: [whole('identity.loop_b', 'identity', null, ['id'])] },
  ],
};

const text = (...names: string[]): LegacyColumnDef[] => names.map((name) => ({ name, type: 'varchar', length: 50 }));

/**
 * Users across two tenants and the pool: `alice` in two tenants, `dave` twice in one under two site spellings, `carol`
 * without a site; memberships and notes reach them in one and two hops, with missing parents at each hop.
 */
const TABLES: { qualified: string; columns: LegacyColumnDef[]; primaryKey: string[]; rows: Row[] }[] = [
  { qualified: 'dbo.tsettings', columns: text('SiteID'), primaryKey: ['SiteID'], rows: ['tenant-a', 'tenant-b', 'umbrella'].map((SiteID) => ({ SiteID })) },
  {
    qualified: 'dbo.tusers',
    columns: [...text('UserID', 'SiteID', 'UserName'), { name: 'Type', type: 'int' }],
    primaryKey: ['UserID'],
    rows: [
      { UserID: 'U01', SiteID: 'tenant-a', UserName: 'alice', Type: 2 },
      { UserID: 'U02', SiteID: 'tenant-a', UserName: 'Editors', Type: 1 },
      { UserID: 'U03', SiteID: 'umbrella', UserName: 'bob', Type: 2 },
      { UserID: 'U04', SiteID: 'tenant-b', UserName: 'ALICE ', Type: 2 },
      { UserID: 'U05', SiteID: null, UserName: 'carol', Type: 2 },
      { UserID: 'U06', SiteID: 'tenant-b', UserName: 'dave', Type: 2 },
      { UserID: 'U07', SiteID: 'Tenant-B ', UserName: 'Dave', Type: 2 },
    ],
  },
  {
    qualified: 'dbo.tusersmemb',
    columns: text('UserID', 'GroupID'),
    primaryKey: ['UserID', 'GroupID'],
    rows: [
      { UserID: 'U01', GroupID: 'U02' },
      { UserID: 'U04', GroupID: 'U02' },
      { UserID: 'U06', GroupID: 'U02' },
      { UserID: 'U99', GroupID: 'U02' },
    ],
  },
  {
    qualified: 'dbo.tuserstrikes',
    columns: [...text('username'), { name: 'strikes', type: 'int' }],
    primaryKey: ['username'],
    rows: ['alice', 'bob', 'carol', 'dave', 'zed'].map((username) => ({ username, strikes: 1 })),
  },
  {
    qualified: 'dbo.tmembnotes',
    columns: text('noteID', 'memberID'),
    primaryKey: ['noteID'],
    rows: [
      { noteID: 'N1', memberID: 'u01 ' },
      { noteID: 'N2', memberID: 'U99' },
      { noteID: 'N3', memberID: 'U77' },
    ],
  },
  {
    qualified: 'dbo.tuseraddresses',
    columns: text('addressID', 'userID', 'siteID'),
    primaryKey: ['addressID'],
    rows: [
      { addressID: 'A1', userID: 'U01', siteID: 'tenant-a' },
      { addressID: 'A2', userID: 'U02', siteID: 'tenant-a' },
      { addressID: 'A3', userID: 'U04', siteID: 'tenant-b' },
      { addressID: 'A4', userID: 'U98', siteID: 'tenant-b' },
    ],
  },
];

let dir: string;
let ownershipFile: string;
let catalog: UnitCatalog;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-tenant-resolver-'));
  ownershipFile = join(dir, 'table-ownership.json');
  await writeFile(ownershipFile, JSON.stringify(OWNERSHIP), 'utf8');
  catalog = loadUnitCatalog(ownershipFile);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Deps over a fresh fake server holding TABLES plus `extra` rows, reading `batchRows` rows per batch. */
function setup(options: { extra?: Record<string, Row[]>; batchRows?: number } = {}): { deps: Deps; fake: FakeLegacyDb } {
  const fake = createFakeLegacyDb({
    tables: TABLES.map(({ qualified, columns, primaryKey }) => ({ qualified, columns, options: { primaryKey } })),
    rows: Object.fromEntries(TABLES.map(({ qualified, rows }) => [qualified, [...rows, ...(options.extra?.[qualified] ?? [])]])),
  });
  const base = loadConfig();
  const config = {
    ...base,
    paths: { ...base.paths, tableOwnership: ownershipFile },
    backfill: { batchRows: options.batchRows ?? base.backfill.batchRows },
  };
  return { deps: { legacy: fake, catalog, config }, fake };
}

/** Row reads logged by the fake: the table, whether a WHERE … IN bounds it, and its parameter values sorted. */
function reads(fake: FakeLegacyDb): { table: string; scoped: boolean; keys: string[] }[] {
  return fake.statements.flatMap((statement) => {
    const from = READ.exec(statement.sql);
    if (from === null) return [];
    return [{ table: `${String(from[1])}.${String(from[2])}`, scoped: SCOPED.test(statement.sql), keys: Object.values(statement.params).map(String).sort() }];
  });
}

describe('createTenantResolver', () => {
  it('reads no parent table when created, and then only the parent rows a prepared batch joins to', async () => {
    const { deps, fake } = setup();
    fake.clearLogs();

    const tenants = await createTenantResolver(deps, { database: DATABASE });

    expect(reads(fake)).toEqual([{ table: 'dbo.tsettings', scoped: false, keys: [] }]);
    fake.clearLogs();
    await tenants.prepare('tusersmemb', [{ UserID: 'U01' }, { UserID: 'u04 ' }, { UserID: 'U99' }, { UserID: 'U01' }, { UserID: null }]);
    expect(reads(fake)).toEqual([{ table: 'dbo.tusers', scoped: true, keys: ['u01', 'u04', 'u99'] }]);
  });

  it.each([
    ['a parent row', 'tusersmemb', { UserID: 'U01' }, { tenantId: A, orphan: false }],
    ['a parent row in comparison form', 'tusersmemb', { UserID: 'u04 ' }, { tenantId: B, orphan: false }],
    ['a missing parent row', 'tusersmemb', { UserID: 'U99' }, { tenantId: UMBRELLA, orphan: true }],
    ['a null join value', 'tusersmemb', { UserID: null }, { tenantId: UMBRELLA, orphan: true }],
    ['parents in two tenants', 'tuserstrikes', { username: 'alice' }, { tenantId: UMBRELLA, orphan: true }],
    ['a pooled parent', 'tuserstrikes', { username: 'bob' }, { tenantId: UMBRELLA, orphan: false }],
    ['an orphan parent row only', 'tuserstrikes', { username: 'carol' }, { tenantId: UMBRELLA, orphan: true }],
    ['two parent rows of one tenant', 'tuserstrikes', { username: 'dave' }, { tenantId: B, orphan: false }],
    ['a grandparent row', 'tmembnotes', { memberID: 'u01 ' }, { tenantId: A, orphan: false }],
    ['a parent row whose own parent is missing', 'tmembnotes', { memberID: 'U99' }, { tenantId: UMBRELLA, orphan: true }],
    ['a parent fixture table the database lacks', 'synthetic.archive_note', { archive_id: 'R1' }, { tenantId: UMBRELLA, orphan: true }],
  ])('resolves a prepared row through %s', async (_case, table, row, expected) => {
    const { deps } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });

    await tenants.prepare(table, [row]);

    expect(tenants.resolve(table, row)).toEqual(expected);
  });

  it('reads each hop of a parent chain only for the values the previous hop reached', async () => {
    const { deps, fake } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });
    fake.clearLogs();

    await tenants.prepare('tmembnotes', [{ memberID: 'u01 ' }, { memberID: 'U77' }]);

    expect(reads(fake)).toEqual([
      { table: 'dbo.tusersmemb', scoped: true, keys: ['u01', 'u77'] },
      { table: 'dbo.tusers', scoped: true, keys: ['u01'] },
    ]);
    expect(tenants.resolve('tmembnotes', { memberID: 'U01' })).toEqual({ tenantId: A, orphan: false });
    expect(tenants.resolve('tmembnotes', { memberID: 'U77' })).toEqual({ tenantId: UMBRELLA, orphan: true });
  });

  it("throws for a parent-sourced row outside its table's last prepared batch, and needs no batch for a site-sourced one", async () => {
    const { deps } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });
    const unprepared = 'no parent lookup of tusers by UserID was prepared';

    expect(() => tenants.resolve('tusersmemb', { UserID: 'U01' })).toThrow(unprepared);
    expect(tenants.resolve('tusers', { SiteID: 'tenant-a' })).toEqual({ tenantId: A, orphan: false });

    await tenants.prepare('tusersmemb', [{ UserID: 'U01' }]);
    expect(() => tenants.resolve('tusersmemb', { UserID: 'U04' })).toThrow(unprepared);
    await tenants.prepare('tusersmemb', [{ UserID: 'U04' }]);
    expect(() => tenants.resolve('tusersmemb', { UserID: 'U01' })).toThrow(unprepared);
    await tenants.prepare('tuserstrikes', [{ username: 'bob' }]);
    expect(tenants.resolve('tusersmemb', { UserID: 'U04' })).toEqual({ tenantId: B, orphan: false });
    await tenants.prepare('tusersmemb', []);
    expect(() => tenants.resolve('tusersmemb', { UserID: 'U04' })).toThrow(unprepared);
  });

  it('reads nothing for an empty batch or a table whose tenant comes from no parent', async () => {
    const { deps, fake } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });
    fake.clearLogs();

    await tenants.prepare('tusersmemb', []);
    await tenants.prepare('tusers', [{ UserID: 'U01', SiteID: 'tenant-a' }]);

    expect(reads(fake)).toEqual([]);
  });

  it('splits the parent read of a batch with more than MAX_SCOPE_PARAMETERS join values into scoped reads of at most that many', async () => {
    const { deps, fake } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });
    const rows = [{ UserID: 'U01' }, ...Array.from({ length: MAX_SCOPE_PARAMETERS + 1 }, (_, index) => ({ UserID: `X${String(index)}` }))];
    fake.clearLogs();

    await tenants.prepare('tusersmemb', rows);

    expect(reads(fake).map(({ table, scoped, keys }) => [table, scoped, keys.length])).toEqual([
      ['dbo.tusers', true, MAX_SCOPE_PARAMETERS],
      ['dbo.tusers', true, rows.length - MAX_SCOPE_PARAMETERS],
    ]);
    expect(rows.map((row) => tenants.resolve('tusersmemb', row).tenantId)).toEqual([A, ...rows.slice(1).map(() => UMBRELLA)]);
  });

  it('rejects tenant parent joins that form a cycle', async () => {
    const { deps } = setup();
    const tenants = await createTenantResolver(deps, { database: DATABASE });

    await expect(tenants.prepare('tloopa', [{ id: '1', b: '2' }])).rejects.toThrow('tenant parent joins form a cycle through tloopb.id');
  });
});

describe('readLegacyUnitRows batches', () => {
  it.each([
    {
      unit: 'identity.membership',
      table: 'tusersmemb',
      key: 'UserID',
      parentReads: [
        { table: 'dbo.tusers', scoped: true, keys: ['u01', 'u04'] },
        { table: 'dbo.tusers', scoped: true, keys: ['u06', 'u99'] },
      ],
      byTenant: { [A]: ['U01'], [B]: ['U04', 'U06'], [UMBRELLA]: ['U99'] },
    },
    {
      unit: 'people.user_address',
      table: 'tuseraddresses',
      key: 'addressID',
      parentReads: [
        { table: 'dbo.tusers', scoped: true, keys: ['u01', 'u02'] },
        { table: 'dbo.tusers', scoped: true, keys: ['u04', 'u98'] },
      ],
      byTenant: { [A]: ['A1'], [B]: ['A3'] },
    },
  ])('reads the joins and parents of $unit per batch of backfill.batchRows rows', async ({ unit, table, key, parentReads, byTenant }) => {
    const { deps, fake } = setup({ batchRows: 2 });
    const shape = await describeUnitTable(deps, { unit, legacyTable: table, database: DATABASE });
    const tenants = await createTenantResolver(deps, { database: DATABASE });
    fake.clearLogs();

    const legacy = await readLegacyUnitRows(deps, shape, { database: DATABASE, tenants, spillDir: dir });
    const keys: Record<string, unknown[]> = {};
    try {
      for (const tenantId of legacy.tenants) for await (const row of legacy.rows(tenantId)) (keys[tenantId] ??= []).push(row.row[key]);
    } finally {
      await legacy.dispose();
    }

    expect(reads(fake).filter((read) => read.table === 'dbo.tusers')).toEqual(parentReads);
    expect(keys).toEqual(byTenant);
  });
});
