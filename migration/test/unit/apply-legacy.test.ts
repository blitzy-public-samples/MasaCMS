// Unit tests for reverse-projected changes landing in live legacy tables, and for the projector checkpoint, over the in-memory SQL Server fake.
import { readFileSync } from 'node:fs';

import { LEGACY_PROGRAM_ID_COLUMN, encodeRow, programTableName } from '@opt2/platform/migration-kit';
import type { CanonicalColumn, CanonicalValue, ChangeOp, ChangeRow, ProjectedChangeRow } from '@opt2/platform/migration-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readTableCatalog } from '../../src/extract/index.js';
import type { TableCatalog } from '../../src/extract/index.js';
import {
  CHECKPOINT_TABLE,
  ProjectionConflictError,
  applyLegacyChange,
  clearPendingEffects,
  decodeLegacyChange,
  readCheckpoint,
  readCheckpoints,
  summarise,
  upsertCheckpoint,
} from '../../src/reverse/apply-legacy.js';
import type { ApplyLegacyOptions, ApplySummary, CheckpointWrite, LegacyChange, LegacyEffect } from '../../src/reverse/apply-legacy.js';
import { createFakeLegacyDb } from '../helpers/fake-legacy-db.js';
import type { FakeLegacyDb, Row } from '../helpers/fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  TABLES,
  UNITS,
  blackoutRow,
  contentRow,
  defineFixtureTables,
  fixtureId,
  imageSizeRow,
  mailingListMemberRow,
  userRow,
} from '../helpers/fixtures.js';

type OtherParts = NonNullable<ApplyLegacyOptions['fetchOtherParts']>;

const TENANT_A = '0f6b3c52-8d1e-5a7f-9b20-4c3d2e1f0a9b';
const TENANT_B = '7a1d9e44-2c6b-5f80-8e13-9b4a6c5d7e2f';

const SYNC_SQL = readFileSync(new URL('../../sql/005_opt2_sync.sql', import.meta.url), 'utf8');

/** A fake holding every fixture table, `rows` seeded by qualified name, and the checkpoint table the shipped batch creates. */
async function legacyDb(rows: Readonly<Record<string, readonly Row[]>> = {}): Promise<FakeLegacyDb> {
  const fake = createFakeLegacyDb();
  defineFixtureTables(fake);
  for (const [table, seeded] of Object.entries(rows)) fake.seed(table, seeded);
  await (await fake.live()).request().batch(SYNC_SQL);
  fake.clearLogs();
  return fake;
}

function catalogOf(fake: FakeLegacyDb, table: string): Promise<TableCatalog> {
  return fake.live().then((pool) => readTableCatalog(pool, table));
}

/** Catalog columns named in `names`, in catalog order. */
function pick(catalog: TableCatalog, names: readonly string[]): CanonicalColumn[] {
  return catalog.columns.filter((column) => names.includes(column.name));
}

/** The entries of `row` named in `names`. */
function only<T>(row: Readonly<Record<string, T>>, names: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => names.includes(name)));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `row` as an owner's image holds it: integers as decimal text and local Dates as `YYYY-MM-DDTHH:MM:SS.mmm`. */
function canonicalForm(row: Row): Record<string, CanonicalValue> {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]): [string, CanonicalValue] => {
      if (value instanceof Date) {
        const date = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
        return [name, `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`];
      }
      if (typeof value === 'number') return [name, String(value)];
      if (value === null || typeof value === 'string') return [name, value];
      throw new TypeError(`column ${name} has no canonical form`);
    }),
  );
}

/** Columns an ownership target takes from a split legacy table. */
function ownedColumnsOf(table: string, unit: string): readonly string[] {
  const owned = FIXTURE_CATALOG.unitsForLegacyTable(table).find((entry) => entry.unit === unit)?.ownedColumns;
  if (owned === undefined || owned === 'whole-table') throw new Error(`unit ${unit} owns no explicit columns of ${table}`);
  return owned;
}

interface ProjectionInput {
  op: ChangeOp;
  unit: string;
  legacyTable: string;
  /** Columns the owner encodes the unit's legacy images over. */
  columns: readonly CanonicalColumn[];
  /** Key columns of the encoded key; empty encodes the whole row, as for a keyless table. */
  keyColumns: readonly string[];
  before?: Readonly<Record<string, unknown>>;
  after?: Readonly<Record<string, unknown>>;
  changed?: readonly string[];
  operationId?: string;
}

let nextSeq = 1;

/** A changelog row with one legacy projection, its images and key encoded over `input.columns`. */
function projectedRow(input: ProjectionInput): ProjectedChangeRow {
  const image = input.after ?? input.before;
  if (image === undefined) throw new Error('a change needs a before- or after-image');
  const encode = (row: Readonly<Record<string, unknown>> | undefined): string | null => (row === undefined ? null : encodeRow(input.columns, row));
  const keyColumns = input.keyColumns.length === 0 ? input.columns : input.columns.filter((column) => input.keyColumns.includes(column.name));
  const key = encodeRow(keyColumns, image);
  const columns = [...(input.changed ?? [])];
  const row: ChangeRow = {
    xid: '901',
    seq: String(nextSeq++),
    table: input.unit.slice(input.unit.indexOf('.') + 1),
    op: input.op,
    key,
    before: encode(input.before),
    after: encode(input.after),
    columns,
    origin: 'target',
    actorUserId: null,
    actorService: null,
    at: '2026-07-01 10:30:00.000',
    requestId: null,
    operationId: input.operationId ?? null,
  };
  return { ...row, legacy: [{ unit: input.unit, legacyTable: input.legacyTable, key, before: row.before, after: row.after, columns }] };
}

/** Decodes `input`'s projected row for `owner`, as the projector does before applying it. */
function legacyChange(owner: string, input: ProjectionInput, tenantId = TENANT_A): LegacyChange {
  const change = decodeLegacyChange(projectedRow(input), { owner, tenantId, unit: input.unit, columns: input.columns });
  if (change === null) throw new Error(`unit ${input.unit} has no legacy projection`);
  return change;
}

/** Apply options the projector derives from the unit catalog for `change`. */
function optionsFor(change: LegacyChange, tableCatalog: TableCatalog, extra: Partial<ApplyLegacyOptions>): ApplyLegacyOptions {
  const target = FIXTURE_CATALOG.unitsForLegacyTable(change.legacyTable).find((entry) => entry.unit === change.unit);
  if (target === undefined) throw new Error(`unit ${change.unit} takes no rows of ${change.legacyTable}`);
  const siteColumn = FIXTURE_CATALOG.siteColumnOf(change.legacyTable);
  return {
    tableCatalog,
    target,
    split: FIXTURE_CATALOG.isSplit(change.legacyTable),
    ownedColumns: target.ownedColumns,
    keyColumns: FIXTURE_CATALOG.keyColumnsOf(change.legacyTable),
    ...(siteColumn === null ? {} : { siteColumn }),
    ...extra,
  };
}

/** Applies `changes` in one legacy transaction, catalogs read beforehand; resolves with each change's row count. */
async function applyBatch(fake: FakeLegacyDb, changes: readonly LegacyChange[], extra: Partial<ApplyLegacyOptions> = {}): Promise<number[]> {
  const pool = await fake.live();
  const catalogs = new Map<string, TableCatalog>();
  for (const change of changes) catalogs.set(change.physicalTable.qualified, await readTableCatalog(pool, change.physicalTable));
  return fake.transaction(async (tx) => {
    const counts: number[] = [];
    for (const change of changes) {
      const catalog = catalogs.get(change.physicalTable.qualified) as TableCatalog;
      counts.push((await applyLegacyChange(tx, change, optionsFor(change, catalog, extra))).rows);
    }
    return counts;
  });
}

/** Committed rows of `table` keyed by `keyColumn`. */
function rowsByKey(fake: FakeLegacyDb, table: string, keyColumn: string): Map<unknown, Row> {
  return new Map(fake.rows(table).map((row) => [row[keyColumn], row]));
}

/** The error `promise` rejects with. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );
}

describe('applyLegacyChange on a keyed table', () => {
  const TABLE = TABLES.timagesizes.qualified;
  const thumbnail = imageSizeRow();
  const hero = imageSizeRow({ name: 'hero', height: '600', width: '1600' });
  let fake: FakeLegacyDb;
  let catalog: TableCatalog;

  beforeEach(async () => {
    fake = await legacyDb({ [TABLE]: [thumbnail, hero] });
    catalog = await catalogOf(fake, TABLE);
  });

  function sizeChange(op: ChangeOp, images: { before?: Row; after?: Row }, changed?: string[]): LegacyChange {
    return legacyChange('programs-sites', {
      op,
      unit: UNITS.imageSize,
      legacyTable: 'timagesizes',
      columns: catalog.columns,
      keyColumns: ['sizeID'],
      ...(images.before === undefined ? {} : { before: canonicalForm(images.before) }),
      ...(images.after === undefined ? {} : { after: canonicalForm(images.after) }),
      ...(changed === undefined ? {} : { changed }),
    });
  }

  it('inserts, updates and deletes rows by key in one batch, and summarises what the batch touched', async () => {
    const banner = imageSizeRow({ name: 'banner', height: '300', width: '1200' });
    const changes = [
      sizeChange('insert', { after: banner }),
      sizeChange('update', { before: thumbnail, after: { ...thumbnail, width: '150' } }, ['width']),
      sizeChange('delete', { before: hero }),
    ];

    await expect(applyBatch(fake, changes)).resolves.toEqual([1, 1, 1]);

    expect(rowsByKey(fake, TABLE, 'sizeID')).toEqual(
      new Map([
        [banner.sizeID, banner],
        [thumbnail.sizeID, { ...thumbnail, width: '150' }],
      ]),
    );
    const summary: ApplySummary = summarise(changes);
    expect(summary).toEqual({ rows: 3, tables: new Set(['timagesizes']), siteIds: new Set(['tenant-a']), touchesTcontent: false, touchesTsettings: false });
    expect(fake.statements.some((statement) => statement.sql.includes('IDENTITY_INSERT'))).toBe(false);
  });

  it('writes only the changed column of an update, leaving a column legacy holds differently as it is', async () => {
    const ownerView = { ...thumbnail, height: '120' };

    await expect(applyBatch(fake, [sizeChange('update', { before: ownerView, after: { ...ownerView, width: '150' } }, ['width'])])).resolves.toEqual([1]);

    expect(rowsByKey(fake, TABLE, 'sizeID').get(thumbnail.sizeID)).toEqual({ ...thumbnail, width: '150' });
  });

  it('overwrites the non-key columns of a key legacy already holds on insert, adding no row', async () => {
    const resized = { ...thumbnail, height: '120', width: '120' };

    await expect(applyBatch(fake, [sizeChange('insert', { after: resized })])).resolves.toEqual([1]);

    expect(fake.rows(TABLE)).toHaveLength(2);
    expect(rowsByKey(fake, TABLE, 'sizeID').get(thumbnail.sizeID)).toEqual(resized);
    expect(fake.statements.some((statement) => /\bINSERT\s+INTO\b/i.test(statement.sql))).toBe(false);
  });

  it('rejects an update of a key legacy does not hold and commits none of the batch', async () => {
    const banner = imageSizeRow({ name: 'banner' });
    const ghost = imageSizeRow({ name: 'ghost' });
    const update = sizeChange('update', { before: ghost, after: { ...ghost, width: '1' } }, ['width']);

    const error = await rejectionOf(applyBatch(fake, [sizeChange('insert', { after: banner }), update]));

    expect(error).toBeInstanceOf(ProjectionConflictError);
    expect(error).toMatchObject({ table: 'timagesizes', op: 'update', key: update.key });
    expect(rowsByKey(fake, TABLE, 'sizeID')).toEqual(
      new Map([
        [thumbnail.sizeID, thumbnail],
        [hero.sizeID, hero],
      ]),
    );
    expect(fake.commits).toEqual([]);
  });

  it('commits a delete of a key legacy does not hold as zero rows, the row being already absent', async () => {
    await expect(applyBatch(fake, [sizeChange('delete', { before: imageSizeRow({ name: 'ghost' }) })])).resolves.toEqual([0]);

    expect(rowsByKey(fake, TABLE, 'sizeID')).toEqual(
      new Map([
        [thumbnail.sizeID, thumbnail],
        [hero.sizeID, hero],
      ]),
    );
    expect(fake.commits).toHaveLength(1);
  });
});

describe('applyLegacyChange on a table without a primary key', () => {
  it('appends an inserted row as one more occurrence, even of a row legacy already holds', async () => {
    const TABLE = TABLES.tmailinglistmembers.qualified;
    const member = mailingListMemberRow();
    const fake = await legacyDb({ [TABLE]: [member] });
    const catalog = await catalogOf(fake, TABLE);
    const insert = legacyChange('communications', {
      op: 'insert',
      unit: UNITS.mailingListMember,
      legacyTable: 'tmailinglistmembers',
      columns: catalog.columns,
      keyColumns: [],
      after: canonicalForm(member),
    });

    await expect(applyBatch(fake, [insert])).resolves.toEqual([1]);

    expect([...fake.multiset(TABLE).entries()]).toEqual([[encodeRow(catalog.columns, member), 2]]);
  });
});

describe('decodeLegacyChange', () => {
  it('decodes both images back to the rows they were encoded from, NULLs, char(35) padding and datetimes included', async () => {
    const fake = await legacyDb();
    const catalog = await catalogOf(fake, TABLES.tusers.qualified);
    const before = canonicalForm(userRow({ Type: 1, GroupName: 'Padded', photoFileID: 'PHOTO-7'.padEnd(35, ' ') }));
    const after = { ...before, photoFileID: null, LastLogin: '2026-07-01T10:30:15.123', notes: 'trailing  ' };
    const changed = ['photoFileID', 'LastLogin', 'notes'];
    const operationId = fixtureId('operation:padded');

    const change = legacyChange('identity', {
      op: 'update',
      unit: UNITS.groupAccount,
      legacyTable: 'tusers',
      columns: catalog.columns,
      keyColumns: ['UserID'],
      before,
      after,
      changed,
      operationId,
    });

    expect(change.before).toEqual(before);
    expect(change.after).toEqual(after);
    expect(change.before?.photoFileID).toHaveLength(35);
    expect(change).toMatchObject({
      owner: 'identity',
      tenantId: TENANT_A,
      op: 'update',
      legacyTable: 'tusers',
      physicalTable: { schema: 'dbo', table: 'tusers', qualified: 'tusers' },
      changedColumns: changed,
      operationId,
    });
    expect(change.columns).toEqual(catalog.columns);
    expect(change.programId).toBeUndefined();
  });
});

describe('applyLegacyChange on the split tusers table', () => {
  const TABLE = TABLES.tusers.qualified;
  const ana = userRow({ UserName: 'ana.editor', Fname: 'Ana', Lname: 'Editor' });
  const admins = userRow({ Type: 1, GroupName: 'Admin' });
  let fake: FakeLegacyDb;
  let catalog: TableCatalog;

  beforeEach(async () => {
    fake = await legacyDb({ [TABLE]: [ana, admins] });
    catalog = await catalogOf(fake, TABLE);
  });

  function userChange(owner: string, unit: string, columns: readonly CanonicalColumn[], images: { before?: Row; after: Row }, changed?: string[]): LegacyChange {
    return legacyChange(owner, {
      op: images.before === undefined ? 'insert' : 'update',
      unit,
      legacyTable: 'tusers',
      columns,
      keyColumns: ['UserID'],
      ...(images.before === undefined ? {} : { before: canonicalForm(images.before) }),
      after: canonicalForm(images.after),
      ...(changed === undefined ? {} : { changed }),
    });
  }

  it("updates only identity's credential columns of a user row, whatever person columns its image carries", async () => {
    const columns = pick(catalog, ['UserID', 'Password', 'PasswordCreated', 'Fname', 'Email']);
    const before = only(ana, ['UserID', 'Password', 'PasswordCreated', 'Fname', 'Email']);
    const rotated = new Date('2026-07-01T10:30:00');
    const after = { ...before, Password: 'rotated-hash', PasswordCreated: rotated, Fname: 'Stale', Email: 'stale@example.test' };

    await expect(applyBatch(fake, [userChange('identity', UNITS.credential, columns, { before, after }, ['Password', 'PasswordCreated', 'Fname', 'Email'])])).resolves.toEqual([1]);

    const rows = rowsByKey(fake, TABLE, 'UserID');
    expect(rows.get(ana.UserID)).toEqual({ ...ana, Password: 'rotated-hash', PasswordCreated: rotated });
    expect(rows.get(admins.UserID)).toEqual(admins);
  });

  it("inserts a new user row merged with people's part, which it fetches once", async () => {
    const nia = userRow({ UserName: 'nia.new', Fname: 'Nia', Lname: 'New', Company: 'Example Ltd' });
    const accountColumns = ownedColumnsOf('tusers', UNITS.userAccount);
    const personColumns = ['UserID', 'SiteID', ...ownedColumnsOf('tusers', UNITS.person)];
    const insert = userChange('identity', UNITS.userAccount, pick(catalog, accountColumns), { after: only(nia, accountColumns) });
    const fetchOtherParts = vi.fn<OtherParts>(() => Promise.resolve([canonicalForm(only(nia, personColumns))]));

    await expect(applyBatch(fake, [insert], { fetchOtherParts })).resolves.toEqual([1]);

    expect(fetchOtherParts).toHaveBeenCalledTimes(1);
    expect(fetchOtherParts).toHaveBeenCalledWith(insert);
    expect(rowsByKey(fake, TABLE, 'UserID').get(nia.UserID)).toEqual({ ...nia, Password: null, PasswordCreated: null, LastLogin: null });
    expect(fake.rows(TABLE)).toHaveLength(3);
  });

  it('inserts a new user row with only its own columns when no other owner holds a part for the key', async () => {
    const nia = userRow({ UserName: 'nia.new' });
    const accountColumns = ownedColumnsOf('tusers', UNITS.userAccount);
    const insert = userChange('identity', UNITS.userAccount, pick(catalog, accountColumns), { after: only(nia, accountColumns) });
    const fetchOtherParts = vi.fn<OtherParts>(() => Promise.resolve([]));

    await expect(applyBatch(fake, [insert], { fetchOtherParts })).resolves.toEqual([1]);

    expect(fetchOtherParts).toHaveBeenCalledTimes(1);
    const nulls = Object.fromEntries(catalog.columns.filter((column) => !accountColumns.includes(column.name)).map((column) => [column.name, null]));
    expect(rowsByKey(fake, TABLE, 'UserID').get(nia.UserID)).toEqual({ ...only(nia, accountColumns), ...nulls });
  });

  it('writes every changed column of a group row, identity owning groups whole', async () => {
    const lastLogin = new Date('2026-07-01T10:30:00');
    const after = { ...admins, GroupName: 'Administrators', Fname: 'Group', Email: 'admins@example.test', LastLogin: lastLogin };

    await expect(
      applyBatch(fake, [userChange('identity', UNITS.groupAccount, catalog.columns, { before: admins, after }, ['GroupName', 'Fname', 'Email', 'LastLogin'])]),
    ).resolves.toEqual([1]);

    const rows = rowsByKey(fake, TABLE, 'UserID');
    expect(rows.get(admins.UserID)).toEqual(after);
    expect(rows.get(ana.UserID)).toEqual(ana);
  });
});

describe('applyLegacyChange on an identity column and a folded program table', () => {
  it('switches IDENTITY_INSERT on around an insert carrying its identity value, within the batch transaction', async () => {
    const TABLE = TABLES.tcontent.qualified;
    const fake = await legacyDb();
    const catalog = await catalogOf(fake, TABLE);
    const news = contentRow({ tcontent_ID: 42, Filename: 'news', Title: 'News', urltitle: 'news' });
    const insert = legacyChange('strategies-content', {
      op: 'insert',
      unit: UNITS.content,
      legacyTable: 'tcontent',
      columns: catalog.columns,
      keyColumns: ['tcontent_ID'],
      after: canonicalForm(news),
    });

    await expect(applyBatch(fake, [insert])).resolves.toEqual([1]);

    expect(fake.rows(TABLE)).toEqual([news]);
    const written = fake.statements.filter((statement) => statement.txId !== null);
    expect(new Set(written.map((statement) => statement.txId)).size).toBe(1);
    const batch = written.find((statement) => statement.sql.includes('INSERT INTO [dbo].[tcontent]'))?.sql ?? '';
    const on = batch.indexOf('SET IDENTITY_INSERT [dbo].[tcontent] ON');
    expect(on).toBe(0);
    expect(batch.indexOf('INSERT INTO [dbo].[tcontent]')).toBeGreaterThan(on);
    expect(batch.trimEnd().endsWith('SET IDENTITY_INSERT [dbo].[tcontent] OFF;')).toBe(true);
    expect(fake.commits).toHaveLength(1);
  });

  it('writes a folded change to its Program_<id> table without the program column, leaving the other program alone', async () => {
    const dayId = fixtureId('timesheet_day:program-2');
    const sameKeyInProgram1 = blackoutRow({ day_id: dayId, reason: 'program-1-original' });
    const fake = await legacyDb({ [TABLES['Program_1.blackout'].qualified]: [sameKeyInProgram1] });
    const catalog = await catalogOf(fake, programTableName(2, 'blackout'));
    const blackout = blackoutRow({ day_id: dayId });
    const insert = legacyChange('timesheets', {
      op: 'insert',
      unit: UNITS.blackout,
      legacyTable: 'Program_N.blackout',
      columns: [...catalog.columns, { name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' }],
      keyColumns: ['blackout_id', LEGACY_PROGRAM_ID_COLUMN],
      after: { ...canonicalForm(blackout), [LEGACY_PROGRAM_ID_COLUMN]: '2' },
    });

    expect(insert).toMatchObject({ legacyTable: programTableName(2, 'blackout'), programId: 2, physicalTable: { schema: 'Program_2', table: 'blackout' } });
    expect(insert.columns).toEqual(catalog.columns);
    expect(insert.after).toEqual(canonicalForm(blackout));

    await expect(applyBatch(fake, [insert])).resolves.toEqual([1]);

    expect(fake.rows(TABLES['Program_2.blackout'].qualified)).toEqual([blackout]);
    expect(fake.rows(TABLES['Program_1.blackout'].qualified)).toEqual([sameKeyInProgram1]);
    const statements = fake.statements.filter((statement) => statement.txId !== null).map((statement) => statement.sql);
    expect(statements.some((sql) => sql.includes('INSERT INTO [Program_2].[blackout]'))).toBe(true);
    expect(statements.some((sql) => sql.includes('Program_1') || sql.includes(LEGACY_PROGRAM_ID_COLUMN))).toBe(false);
  });
});

describe('projector checkpoint', () => {
  const PURGE: LegacyEffect = { kind: 'purgeCache', siteId: 'tenant-a' };
  const REFRESH: LegacyEffect = { kind: 'siteRefresh', siteId: 'tenant-b' };
  let fake: FakeLegacyDb;

  beforeEach(async () => {
    fake = await legacyDb();
  });

  function checkpoint(fields: Partial<CheckpointWrite> = {}): CheckpointWrite {
    return {
      owner: 'people',
      tenantId: TENANT_A,
      cursorXid: '9007199254740993',
      cursorSeq: '4',
      appliedHorizon: '100',
      batchId: 'batch-1',
      rowsApplied: 3,
      pendingEffects: [],
      ...fields,
    };
  }

  function store(...writes: CheckpointWrite[]): Promise<unknown> {
    return fake.transaction(async (tx) => {
      for (const write of writes) await upsertCheckpoint(tx, write);
    });
  }

  it('inserts the first checkpoint, then updates it, never moving its applied horizon back', async () => {
    const first = await fake.transaction((tx) => upsertCheckpoint(tx, checkpoint()));
    expect(first).toMatchObject({
      owner: 'people',
      tenantId: TENANT_A,
      cursorXid: '9007199254740993',
      cursorSeq: '4',
      appliedHorizon: '100',
      batchId: 'batch-1',
      rowsApplied: 3,
      pendingEffects: [],
      readyHorizon: null,
    });
    expect(first.updatedAt).toBeInstanceOf(Date);

    const second = await fake.transaction((tx) =>
      upsertCheckpoint(tx, checkpoint({ cursorXid: '9007199254741500', cursorSeq: '9', appliedHorizon: '150', batchId: 'batch-2', rowsApplied: 5 })),
    );
    expect(second).toMatchObject({ cursorXid: '9007199254741500', cursorSeq: '9', appliedHorizon: '150', batchId: 'batch-2', rowsApplied: 5 });

    const third = await fake.transaction((tx) =>
      upsertCheckpoint(tx, checkpoint({ cursorXid: '9007199254741600', cursorSeq: '2', appliedHorizon: '120', batchId: 'batch-3', rowsApplied: 1 })),
    );
    expect(third).toMatchObject({ cursorXid: '9007199254741600', cursorSeq: '2', appliedHorizon: '150', batchId: 'batch-3', rowsApplied: 1 });
    expect(fake.rows(CHECKPOINT_TABLE)).toHaveLength(1);
  });

  it('reads one owner and tenant, filters by owner and keeps tenants apart', async () => {
    await store(
      checkpoint({ appliedHorizon: '100' }),
      checkpoint({ tenantId: TENANT_B, appliedHorizon: '200' }),
      checkpoint({ owner: 'identity', appliedHorizon: '300' }),
    );
    await store(checkpoint({ appliedHorizon: '400', batchId: 'batch-2' }));
    const pool = await fake.live();
    const horizons = (rows: { owner: string; tenantId: string; appliedHorizon: string }[]): string[][] =>
      rows.map((row) => [row.owner, row.tenantId, row.appliedHorizon]);

    await expect(readCheckpoint(pool, 'people', TENANT_B)).resolves.toMatchObject({ owner: 'people', tenantId: TENANT_B, appliedHorizon: '200', batchId: 'batch-1' });
    await expect(readCheckpoint(pool, 'timesheets', TENANT_A)).resolves.toBeNull();
    expect(horizons(await readCheckpoints(pool, { owners: ['people'] }))).toEqual([
      ['people', TENANT_A, '400'],
      ['people', TENANT_B, '200'],
    ]);
    expect(horizons(await readCheckpoints(pool))).toEqual([
      ['identity', TENANT_A, '300'],
      ['people', TENANT_A, '400'],
      ['people', TENANT_B, '200'],
    ]);
  });

  it('leaves neither the checkpoint nor the batch rows when the batch transaction rolls back', async () => {
    const catalog = await catalogOf(fake, TABLES.timagesizes.qualified);
    const banner = imageSizeRow({ name: 'banner' });
    const insert = legacyChange('programs-sites', {
      op: 'insert',
      unit: UNITS.imageSize,
      legacyTable: 'timagesizes',
      columns: catalog.columns,
      keyColumns: ['sizeID'],
      after: canonicalForm(banner),
    });
    const abort = new Error('batch aborted after its checkpoint');

    const error = await rejectionOf(
      fake.transaction(async (tx) => {
        await applyLegacyChange(tx, insert, optionsFor(insert, catalog, {}));
        await upsertCheckpoint(tx, checkpoint({ owner: 'programs-sites', rowsApplied: 1 }));
        throw abort;
      }),
    );

    expect(error).toBe(abort);
    await expect(readCheckpoint(await fake.live(), 'programs-sites', TENANT_A)).resolves.toBeNull();
    expect(fake.rows(TABLES.timagesizes.qualified)).toEqual([]);
    expect(fake.rows(CHECKPOINT_TABLE)).toEqual([]);
  });

  it('owes effects with the horizon they started below until the batch that stored them clears them', async () => {
    await store(checkpoint({ appliedHorizon: '100', batchId: 'batch-1' }));
    const owed = await fake.transaction((tx) => upsertCheckpoint(tx, checkpoint({ appliedHorizon: '150', batchId: 'batch-2', pendingEffects: [PURGE] })));
    expect(owed).toMatchObject({ appliedHorizon: '150', pendingEffects: [PURGE], readyHorizon: '100' });
    const stillOwed = await fake.transaction((tx) =>
      upsertCheckpoint(tx, checkpoint({ appliedHorizon: '180', batchId: 'batch-3', pendingEffects: [REFRESH, PURGE] })),
    );
    expect(stillOwed).toMatchObject({ appliedHorizon: '180', pendingEffects: [REFRESH, PURGE], readyHorizon: '100' });
    const pool = await fake.live();

    await clearPendingEffects(pool, { owner: 'people', tenantId: TENANT_A, batchId: 'batch-2' });
    await expect(readCheckpoint(pool, 'people', TENANT_A)).resolves.toMatchObject({ pendingEffects: [REFRESH, PURGE], readyHorizon: '100' });

    await clearPendingEffects(pool, { owner: 'people', tenantId: TENANT_A, batchId: 'batch-3' });
    await expect(readCheckpoint(pool, 'people', TENANT_A)).resolves.toMatchObject({ appliedHorizon: '180', pendingEffects: [], readyHorizon: null });
  });
});
