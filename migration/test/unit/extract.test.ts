// Unit tests for legacy extraction through the extract barrel over the in-memory SQL Server: catalog metadata, canonical
// row order and encoding, the Program_<id> fold, scope filters and the live-table partition.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectionPool, IResult } from 'mssql';
import {
  CanonicalEncodingError,
  LEGACY_PROGRAM_ID_COLUMN,
  canonicalTypeForSqlServer,
  compareEncodings,
  encodeKey,
  encodeRow,
  encodeValue,
  formatCanonicalTimestamp,
  roundToSqlServerDatetime,
} from '@opt2/platform/migration-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CatalogError,
  DYNAMIC_TABLE_PATTERN,
  FoldShapeError,
  MAX_SCOPE_PARAMETERS,
  OPT2_SYNC_SCHEMA,
  TableNotFoundError,
  UnsupportedColumnTypeError,
  bindScope,
  buildScopeFilter,
  clearCatalogCache,
  compareCanonicalRows,
  describeLegacyTable,
  describeStream,
  findColumn,
  listLegacyTables,
  migratableTables,
  partitionLegacyTables,
  readTableCatalog,
  rowInScope,
  streamCanonicalRows,
  streamFoldedRows,
  streamLegacyTable,
  type CanonicalRow,
  type CatalogColumn,
  type CatalogPool,
  type ExtractScope,
  type LegacyTableDeps,
  type MigratableTable,
  type ScopeFilter,
} from '../../src/extract/index.js';
import { createFakeLegacyDb, type FakeLegacyDb, type LegacyColumnDef, type Row } from '../helpers/fake-legacy-db.js';
import {
  FIXTURE_CATALOG,
  TABLES,
  TABLE_NAMES,
  enrolmentRow,
  defineFixtureTables,
  fixtureId,
  imageSizeRow,
  mailingListMemberRow,
  personArchiveRow,
  seedFakeLegacy,
  userRow,
  type FixtureTable,
} from '../helpers/fixtures.js';

const LIVE_DATABASE = 'masa_test';
const ENROLMENT = 'Program_N.enrolment';

let db: FakeLegacyDb;
let scratchDirs: string[];

beforeEach(() => {
  clearCatalogCache();
  db = createFakeLegacyDb();
  scratchDirs = [];
});

afterEach(async () => {
  await db.close();
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opt2-extract-suite-'));
  scratchDirs.push(dir);
  return dir;
}

async function collect(rows: AsyncIterable<CanonicalRow>): Promise<CanonicalRow[]> {
  const out: CanonicalRow[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Asserts `compareCanonicalRows` agrees with the stream order for every adjacent pair; `strict` forbids ties. */
function expectStreamOrder(rows: readonly CanonicalRow[], strict: boolean): void {
  for (let index = 1; index < rows.length; index++) {
    const order = compareCanonicalRows(rows[index - 1] as CanonicalRow, rows[index] as CanonicalRow);
    if (strict) expect(order).toBeLessThan(0);
    else expect(order).toBeLessThanOrEqual(0);
  }
}

function deps(): LegacyTableDeps {
  return { legacy: db, catalog: FIXTURE_CATALOG };
}

/** The live pool with `column` reported by INFORMATION_SCHEMA.COLUMNS as `sqlType`, a type the fake cannot store. */
function retypedPool(pool: ConnectionPool, column: string, sqlType: string): CatalogPool {
  return {
    config: { database: LIVE_DATABASE },
    request: () => {
      const request = pool.request();
      const query = request.query.bind(request) as (command: string) => Promise<IResult<Row>>;
      return Object.assign(request, {
        query: async (command: string): Promise<IResult<Row>> => {
          const result = await query(command);
          const recordsets = (result.recordsets as Row[][]).map((set) =>
            set.map((row) => (row.COLUMN_NAME === column ? { ...row, DATA_TYPE: sqlType } : row)),
          );
          return { ...result, recordsets, recordset: recordsets[0] ?? [] } as unknown as IResult<Row>;
        },
      });
    },
  };
}

// core/setup/db/mssql.sql:270-284
const TFILES_COLUMNS: readonly [name: string, sqlType: string, type: string][] = [
  ['fileID', 'char', 's'],
  ['contentID', 'char', 's'],
  ['siteID', 'nvarchar', 's'],
  ['moduleID', 'char', 's'],
  ['filename', 'nvarchar', 's'],
  ['image', 'varbinary', 'b'],
  ['imageSmall', 'varbinary', 'b'],
  ['imageMedium', 'varbinary', 'b'],
  ['fileSize', 'int', 'i'],
  ['contentType', 'nvarchar', 's'],
  ['contentSubType', 'nvarchar', 's'],
  ['fileExt', 'nvarchar', 's'],
  ['created', 'datetime', 't'],
];

describe('readTableCatalog', () => {
  it('reads dbo.tfiles columns in ORDINAL_POSITION order under its migration-wide name', async () => {
    defineFixtureTables(db, ['tfiles']);
    const catalog = await readTableCatalog(await db.live(), 'dbo.tfiles');
    expect(catalog).toMatchObject({ database: LIVE_DATABASE, schema: 'dbo', table: 'tfiles', qualified: 'tfiles' });
    expect(catalog.columns.map((column) => [column.name, column.sqlType, column.ordinal])).toEqual(
      TFILES_COLUMNS.map(([name, sqlType], index) => [name, sqlType, index + 1]),
    );
  });

  it.each(TFILES_COLUMNS)('maps tfiles.%s (%s) to canonical type %s', async (name, sqlType, type) => {
    defineFixtureTables(db, ['tfiles']);
    const column = findColumn(await readTableCatalog(await db.live(), 'tfiles'), name);
    expect(column?.type).toBe(type);
    expect(column?.type).toBe(canonicalTypeForSqlServer(sqlType).type);
  });

  it.each(TABLE_NAMES)('reports %s with the fixture columns, primary key and key presence', async (name) => {
    const fixture: FixtureTable = TABLES[name];
    const key = fixture.options.primaryKey ?? [];
    defineFixtureTables(db, [name]);
    const catalog = await readTableCatalog(await db.live(), fixture.qualified);
    expect(catalog.columns.map((column) => column.name)).toEqual(fixture.columns.map((column) => column.name));
    expect(catalog.primaryKey).toEqual(key);
    expect(catalog.hasPrimaryKey).toBe(key.length > 0);
  });

  it('reports the tcontent_ID identity of dbo.tcontent', async () => {
    defineFixtureTables(db, ['tcontent']);
    const catalog = await readTableCatalog(await db.live(), 'tcontent');
    expect(catalog.identityColumns).toContain('tcontent_ID');
  });

  it('raises TableNotFoundError for a table the database lacks', async () => {
    defineFixtureTables(db, ['tfiles']);
    const error = await readTableCatalog(await db.live(), 'dbo.tnosuch').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TableNotFoundError);
    expect(error).toMatchObject({ database: LIVE_DATABASE, table: 'tnosuch' });
  });

  it('raises UnsupportedColumnTypeError for a column of a SQL type without a canonical form', async () => {
    db.defineTable('dbo.tvariant', [
      { name: 'id', type: 'int', nullable: false },
      { name: 'payload', type: 'nvarchar', length: 50 },
    ], { primaryKey: ['id'] });
    const error = await readTableCatalog(retypedPool(await db.live(), 'payload', 'sql_variant'), 'tvariant').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnsupportedColumnTypeError);
    expect(error).toBeInstanceOf(CatalogError);
    expect(error).toMatchObject({ database: LIVE_DATABASE, table: 'tvariant', column: 'payload', sqlType: 'sql_variant' });
    expect((error as Error).cause).toBeInstanceOf(CanonicalEncodingError);
  });
});

describe('listLegacyTables', () => {
  it('lists the dbo, synthetic and Program_<n> tables and never the opt2_sync checkpoint', async () => {
    defineFixtureTables(db);
    db.defineTable(`${OPT2_SYNC_SCHEMA}.projector_checkpoint`, [
      { name: 'owner', type: 'nvarchar', length: 64, nullable: false },
      { name: 'tenant_id', type: 'char', length: 36, nullable: false },
      { name: 'cursor', type: 'nvarchar', length: 'max' },
    ], { primaryKey: ['owner', 'tenant_id'] });
    expect(db.rows(`${OPT2_SYNC_SCHEMA}.projector_checkpoint`)).toEqual([]);

    const tables = await listLegacyTables(await db.live());
    const expected = TABLE_NAMES.map((name) => TABLES[name].qualified.replace(/^dbo\./, '')).sort(byCodeUnit);
    expect(tables.map((ref) => ref.qualified)).toEqual(expected);
    expect(new Set(tables.map((ref) => ref.schema))).toEqual(new Set(['dbo', 'synthetic', 'Program_1', 'Program_2']));
    expect(tables.some((ref) => ref.schema.toLowerCase() === OPT2_SYNC_SCHEMA)).toBe(false);
  });
});

/** Rows seeded in descending key order, so a key-ordered stream cannot be insertion order. */
function reverseKeyOrder(rows: Row[], key: string): Row[] {
  return rows.sort((a, b) => byCodeUnit(String(b[key]), String(a[key])));
}

const KEYED_TABLES: readonly [table: string, key: string, extra: () => Row[]][] = [
  ['timagesizes', 'sizeID', () => ['zoom', 'alpha', 'mid', 'hero'].map((name) => imageSizeRow({ name }))],
  ['tusers', 'UserID', () => ['zed.user', 'abe.user', 'kim.user'].map((UserName) => userRow({ UserName }))],
];

describe('streamCanonicalRows on keyed tables', () => {
  it.each(KEYED_TABLES)('streams %s in %s order, each row encoded and keyed by the migration kit', async (table, key, extra) => {
    seedFakeLegacy(db);
    db.seed(table, reverseKeyOrder(extra(), key));
    const driverRows = new Map(db.rows(table).map((row) => [String(row[key]), row]));
    const shape = await describeStream({ legacy: db, table });
    const rows = await collect(streamCanonicalRows({ legacy: db, table }));

    expect(shape).toMatchObject({ keyed: true, keyColumns: [key] });
    expect(rows.map((row) => row.keyValues[0])).toEqual([...driverRows.keys()].sort(byCodeUnit));
    for (const row of rows) {
      expect(row.table).toBe(table);
      expect(row.encoding).toBe(encodeRow(shape.columns, row.row));
      expect(row.encoding).toBe(encodeRow(shape.columns, driverRows.get(String(row.keyValues[0])) as Row));
      expect(row.key).toBe(encodeKey(shape.columns, [key], row.row));
    }
    expectStreamOrder(rows, true);
  });

  it('orders and keys by the keyColumns option instead of the primary key', async () => {
    defineFixtureTables(db, ['timagesizes']);
    db.seed('timagesizes', ['zoom', 'alpha', 'mid', 'hero', 'banner'].map((name) => imageSizeRow({ name })));
    const options = { legacy: db, table: 'timagesizes', keyColumns: ['NAME'] };
    const shape = await describeStream(options);
    const rows = await collect(streamCanonicalRows(options));

    expect(shape.keyColumns).toEqual(['name']);
    expect(shape.selectSql).toContain('ORDER BY [name] COLLATE Latin1_General_BIN2 ASC');
    expect(rows.map((row) => row.row.name)).toEqual(['alpha', 'banner', 'hero', 'mid', 'zoom']);
    expect(rows.map((row) => row.row.sizeID)).not.toEqual(rows.map((row) => row.row.sizeID).sort());
    for (const row of rows) {
      expect(row.keyValues).toEqual([row.row.name]);
      expect(row.key).toBe(encodeKey(shape.columns, ['name'], row.row));
    }
    expectStreamOrder(rows, true);
  });
});

describe('streamCanonicalRows on keyless tables', () => {
  it('streams dbo.tmailinglistmembers sorted by encoding with every duplicate occurrence', async () => {
    seedFakeLegacy(db);
    db.seed('tmailinglistmembers', [
      mailingListMemberRow({ Email: 'zed@example.test' }),
      mailingListMemberRow({ Email: 'abe@example.test', SiteID: 'tenant-b' }),
    ]);
    const shape = await describeStream({ legacy: db, table: 'tmailinglistmembers' });
    const rows = await collect(streamCanonicalRows({ legacy: db, table: 'tmailinglistmembers' }));
    const expected = [...db.multiset('tmailinglistmembers')]
      .flatMap(([encoding, count]) => Array.from({ length: count }, () => encoding))
      .sort(compareEncodings);

    expect(shape).toMatchObject({ keyed: false, keyColumns: [] });
    expect(shape.selectSql).not.toContain('ORDER BY');
    expect(rows.map((row) => row.encoding)).toEqual(expected);
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.encoding === encodeRow(shape.columns, mailingListMemberRow()))).toHaveLength(2);
    for (const row of rows) {
      expect(row.key).toBe(row.encoding);
      expect(row.keyValues).toEqual([]);
      expect(row.encoding).toBe(encodeRow(shape.columns, row.row));
    }
    expectStreamOrder(rows, false);
  });

  it.each<[string, boolean]>([
    ['drained', false],
    ['abandoned after the first row', true],
  ])('spills one-row runs under a 1-byte sortRunBytes, merges them down to two, keeps the in-memory order and removes the runs when %s', async (_label, abandon) => {
    seedFakeLegacy(db, { duplicates: 3 });
    const inMemory = await collect(streamCanonicalRows({ legacy: db, table: 'tmailinglistmembers' }));
    const spillDir = await scratchDir();
    const spilled: CanonicalRow[] = [];
    let runDirs: string[] = [];
    let runFiles: string[] = [];
    for await (const row of streamCanonicalRows({ legacy: db, table: 'tmailinglistmembers', sortRunBytes: 1, spillDir })) {
      if (spilled.length === 0) {
        runDirs = await readdir(spillDir);
        runFiles = await readdir(join(spillDir, runDirs[0] ?? ''));
      }
      spilled.push(row);
      if (abandon) break;
    }

    expect(runDirs).toEqual([expect.stringMatching(/^opt2-extract-/)]);
    expect(inMemory.length).toBeGreaterThan(2);
    expect(runFiles).toHaveLength(2);
    expect(spilled).toEqual(abandon ? inMemory.slice(0, 1) : inMemory);
    expect(await readdir(spillDir)).toEqual([]);
  });
});

/** Seeds `row` into `table` and returns its one canonical row with the encoded columns. */
async function streamOne(table: string, row: Row): Promise<{ row: CanonicalRow; columns: readonly CatalogColumn[] }> {
  db.seed(table, [row]);
  const { columns } = await describeStream({ legacy: db, table });
  const rows = await collect(streamCanonicalRows({ legacy: db, table }));
  expect(rows).toHaveLength(1);
  return { row: rows[0] as CanonicalRow, columns };
}

describe('canonical value forms', () => {
  it.each<[string, string, string]>([
    ['MLID', 'SHORT-ID', 'SHORT-ID'.padEnd(35, ' ')],
    ['Email', 'pad@example.test', 'pad@example.test'],
    ['Email', 'spaced@example.test  ', 'spaced@example.test  '],
    ['fname', ' Reader ', ' Reader '],
  ])('stores %s %j as %j and encodes it with that exact text', async (column, seeded, stored) => {
    defineFixtureTables(db, ['tmailinglistmembers']);
    const { row } = await streamOne('tmailinglistmembers', mailingListMemberRow({ [column]: seeded }));
    expect(row.row[column]).toBe(stored);
    expect(encodeRow([{ name: column, type: 's' }], row.row)).toBe(encodeValue('s', stored));
    expect(row.encoding).toContain(encodeValue('s', stored));
  });

  const WALL = { year: 2026, month: 6, day: 1, hour: 9, minute: 0, second: 0 } as const;

  it.each<[fraction: string, second: number, rounded: string]>([
    ['000', 0, '000'],
    ['001', 0, '000'],
    ['002', 0, '003'],
    ['004', 0, '003'],
    ['005', 0, '007'],
    ['006', 0, '007'],
    ['008', 0, '007'],
    ['998', 0, '997'],
    ['999', 1, '000'],
  ])('rounds datetime .%s to second %i .%s alike on the legacy and target sides', async (fraction, second, rounded) => {
    const inputMs = Number(fraction);
    const expected = `2026-06-01T09:00:0${String(second)}.${rounded}`;
    const at = new Date(WALL.year, WALL.month - 1, WALL.day, WALL.hour, WALL.minute, WALL.second, inputMs);
    const text = `2026-06-01 09:00:00.${fraction}`;
    expect(roundToSqlServerDatetime({ ...WALL, fractionSeconds: inputMs / 1000 })).toEqual({ ...WALL, second, ms: Number(rounded) });
    expect(formatCanonicalTimestamp(at)).toBe(expected);
    expect(formatCanonicalTimestamp(text)).toBe(expected);

    defineFixtureTables(db, ['synthetic.person_archive']);
    const seeded = personArchiveRow({ archive_id: fixtureId(`rounding:${fraction}`), archived_at: at });
    const { row, columns } = await streamOne('synthetic.person_archive', seeded);
    expect(row.row.archived_at).toBe(expected);
    expect(row.encoding).toBe(encodeRow(columns, seeded));
    expect(row.encoding).toBe(encodeRow(columns, { ...seeded, archived_at: text }));
  });

  it('encodes NULL as N and the empty string as s0:, keeping the two rows apart', async () => {
    seedFakeLegacy(db);
    const blanks = (await collect(streamCanonicalRows({ legacy: db, table: 'tmailinglistmembers' }))).filter(
      (row) => row.row.Email === 'blank@example.test',
    );
    const nullRow = blanks.find((row) => row.row.fname === null);
    const emptyRow = blanks.find((row) => row.row.fname === '');
    const fname = [{ name: 'fname', type: 's' as const }];

    expect(blanks).toHaveLength(2);
    expect(encodeRow(fname, nullRow?.row ?? {})).toBe('N');
    expect(encodeRow(fname, emptyRow?.row ?? {})).toBe('s0:');
    expect(nullRow?.encoding).not.toBe(emptyRow?.encoding);
  });
});


const SHARED_COHORT = fixtureId('cohort:shared');

/** Seeds both programs' enrolments in descending key order, with one row identical in both programs. */
function seedEnrolments(): { 1: Row[]; 2: Row[] } {
  const rows = {
    1: reverseKeyOrder(
      [enrolmentRow({ cohort_id: fixtureId('cohort:p1/a') }), enrolmentRow({ cohort_id: fixtureId('cohort:p1/b') }), enrolmentRow({ cohort_id: SHARED_COHORT })],
      'enrolment_id',
    ),
    2: reverseKeyOrder([enrolmentRow({ cohort_id: fixtureId('cohort:p2/a') }), enrolmentRow({ cohort_id: SHARED_COHORT })], 'enrolment_id'),
  };
  db.seed('Program_1.enrolment', rows[1]);
  db.seed('Program_2.enrolment', rows[2]);
  return rows;
}

async function enrolmentTable(): Promise<MigratableTable> {
  const table = migratableTables(FIXTURE_CATALOG, await listLegacyTables(await db.live())).find((entry) => entry.name === ENROLMENT);
  expect(table).toBeDefined();
  return table as MigratableTable;
}

type FoldSource = (table: MigratableTable) => AsyncIterable<CanonicalRow>;

const FOLD_SOURCES: readonly [string, FoldSource][] = [
  ['streamLegacyTable of the migratable table', (table) => streamLegacyTable(deps(), { table })],
  ['streamLegacyTable of the logical name', () => streamLegacyTable(deps(), { table: ENROLMENT })],
  [
    'streamFoldedRows of the parts',
    (table) =>
      streamFoldedRows({
        legacy: db,
        table: table.name,
        keyColumns: table.keyColumns,
        parts: table.physical.map(({ ref, programId }) => ({ ref, programId: programId as number })),
      }),
  ],
];

describe('Program_<id> fold', () => {
  it('describes Program_N.enrolment as one folded, keyed table over both program parts', async () => {
    defineFixtureTables(db);
    const shape = await describeLegacyTable(deps(), { table: await enrolmentTable() });

    expect(shape).toMatchObject({ table: ENROLMENT, folded: true, keyed: true, keyColumns: ['enrolment_id', LEGACY_PROGRAM_ID_COLUMN] });
    expect(shape.parts.map((part) => [part.programId, part.ref.qualified])).toEqual([
      [1, 'Program_1.enrolment'],
      [2, 'Program_2.enrolment'],
    ]);
    expect(shape.columns.map((column) => column.name)).toEqual([
      ...TABLES['Program_1.enrolment'].columns.map((column) => column.name),
      LEGACY_PROGRAM_ID_COLUMN,
    ]);
    expect(shape.columns.at(-1)).toEqual({ name: LEGACY_PROGRAM_ID_COLUMN, type: 'i' });
  });

  it.each(FOLD_SOURCES)('merges both programs through %s with legacy_program_id appended to row, encoding and key', async (_label, source) => {
    defineFixtureTables(db);
    const seeded = seedEnrolments();
    const table = await enrolmentTable();
    const shape = await describeLegacyTable(deps(), { table });
    const plainRows = new Map<number, Map<string, CanonicalRow>>();
    for (const part of shape.parts) {
      const rows = await collect(streamCanonicalRows({ legacy: db, table: part.ref }));
      plainRows.set(part.programId, new Map(rows.map((row) => [String(row.row.enrolment_id), row])));
    }
    const rows = await collect(source(table));

    expect(rows).toHaveLength(seeded[1].length + seeded[2].length);
    expectStreamOrder(rows, true);
    for (const row of rows) {
      const programId = row.legacyProgramId as number;
      const plain = plainRows.get(programId)?.get(String(row.row.enrolment_id));
      const suffix = encodeValue('i', programId);
      expect(plain).toBeDefined();
      expect(row.table).toBe(ENROLMENT);
      expect(row.row[LEGACY_PROGRAM_ID_COLUMN]).toBe(String(programId));
      expect(row.keyValues).toEqual([row.row.enrolment_id, programId]);
      expect(row.encoding).toBe(`${plain?.encoding ?? ''}${suffix}`);
      expect(row.key).toBe(`${plain?.key ?? ''}${suffix}`);
      expect(row.encoding).toBe(encodeRow(shape.columns, row.row));
      expect(row.key).toBe(encodeKey(shape.columns, shape.keyColumns, row.row));
    }
    const shared = rows.filter((row) => row.row.cohort_id === SHARED_COHORT);
    expect(shared.map((row) => row.legacyProgramId)).toEqual([1, 2]);
    expect(new Set(shared.map((row) => row.key)).size).toBe(2);
    expect(new Set(shared.map((row) => row.encoding)).size).toBe(2);
  });

  it.each<[string, (columns: readonly LegacyColumnDef[]) => LegacyColumnDef[]]>([
    ['lacks a column', (columns) => columns.filter((column) => column.name !== 'status')],
    ['orders its columns differently', (columns) => [...columns].reverse()],
  ])('raises FoldShapeError when Program_2.enrolment %s', async (_label, reshape) => {
    defineFixtureTables(db, ['Program_1.enrolment']);
    const fixture: FixtureTable = TABLES['Program_2.enrolment'];
    db.defineTable(fixture.qualified, reshape(fixture.columns), fixture.options);
    const table = await enrolmentTable();
    const described = await describeLegacyTable(deps(), { table }).catch((caught: unknown) => caught);
    const streamed = await collect(streamLegacyTable(deps(), { table })).catch((caught: unknown) => caught);

    for (const error of [described, streamed]) {
      expect(error).toBeInstanceOf(FoldShapeError);
      expect(error).toMatchObject({ table: ENROLMENT });
    }
  });
});

const BEN = String(userRow({ UserName: 'ben.user', SiteID: 'tenant-b' }).UserID);

async function tusersColumns(): Promise<readonly CatalogColumn[]> {
  return (await readTableCatalog(await db.live(), 'tusers')).columns;
}

function paramsOf(filter: ScopeFilter): [string, string, unknown][] {
  return filter.params.map((param) => [param.name, param.column.name, param.value]);
}

describe('scope filters', () => {
  it('binds siteid to the SiteID column case-insensitively with one parameter', async () => {
    defineFixtureTables(db, ['tusers']);
    const filter = buildScopeFilter(await tusersColumns(), { siteid: ['tenant-a'] });

    expect(filter.kind).toBe('filtered');
    expect(filter.whereSql).toBe(' WHERE ([SiteID] IN (@p0))');
    expect(paramsOf(filter)).toEqual([['p0', 'SiteID', 'tenant-a']]);
  });

  it('ORs the terms of two names and numbers their parameters across both', async () => {
    defineFixtureTables(db, ['tusers']);
    const ids = [fixtureId('tusers:a'), fixtureId('tusers:b')];
    const filter = buildScopeFilter(await tusersColumns(), { siteid: ['tenant-a'], userid: ids });

    expect(filter.whereSql).toBe(' WHERE ([SiteID] IN (@p0)) OR ([UserID] IN (@p1, @p2))');
    expect(paramsOf(filter)).toEqual([
      ['p0', 'SiteID', 'tenant-a'],
      ['p1', 'UserID', ids[0]],
      ['p2', 'UserID', ids[1]],
    ]);
  });

  it.each<[string, ExtractScope | undefined, ScopeFilter['reason']]>([
    ['no scope', undefined, 'no-scope'],
    ["the 'table' scope", 'table', 'table-scope'],
    ['a name no column carries', { contentid: [fixtureId('tcontent:any')] }, 'unbound-name'],
    ['an empty value list', { siteid: [] }, 'empty-values'],
    [
      'more than MAX_SCOPE_PARAMETERS values',
      { userid: Array.from({ length: MAX_SCOPE_PARAMETERS + 1 }, (_, index) => fixtureId(`tusers:${String(index)}`)) },
      'too-many-values',
    ],
  ])('reads the whole table for %s', async (_label, scope, reason) => {
    defineFixtureTables(db, ['tusers']);
    const filter = buildScopeFilter(await tusersColumns(), scope);

    expect(filter).toMatchObject({ kind: 'table', reason, whereSql: '', params: [] });
    expect(rowInScope(filter, userRow())).toBe(true);
  });

  it.each<[string, ExtractScope, number]>([
    ['siteid tenant-a', { siteid: ['tenant-a'] }, 2],
    ['SITEID in upper case', { SITEID: ['TENANT-B'] }, 1],
    ['siteid umbrella or one userid', { siteid: ['umbrella'], userid: [BEN] }, 2],
    ['an unknown userid', { userid: [fixtureId('tusers:nobody')] }, 0],
    ["the 'table' scope", 'table', 5],
  ])('streams exactly the tusers rows rowInScope accepts for %s', async (_label, scope, count) => {
    const seeded = seedFakeLegacy(db).tusers;
    const filter = buildScopeFilter(await tusersColumns(), scope);
    const expected = seeded.filter((row) => rowInScope(filter, row)).map((row) => String(row.UserID)).sort(byCodeUnit);
    const rows = await collect(streamCanonicalRows({ legacy: db, table: 'tusers', scope }));

    expect(expected).toHaveLength(count);
    expect(rows.map((row) => String(row.row.UserID))).toEqual(expected);
    for (const row of rows) expect(rowInScope(filter, row.row)).toBe(true);
  });

  it('binds every @pN of the filter as the statement inputs the server receives', async () => {
    const seeded = seedFakeLegacy(db).tusers;
    const scope = { siteid: ['tenant-a', 'umbrella'], userid: [BEN] };
    const filter = buildScopeFilter(await tusersColumns(), scope);
    const expected = seeded.filter((row) => rowInScope(filter, row)).map((row) => String(row.UserID)).sort(byCodeUnit);
    const request = (await db.live()).request();
    bindScope(request, filter);
    db.clearLogs();
    const result = await request.query<{ UserID: string }>(`SELECT [UserID] FROM [dbo].[tusers]${filter.whereSql}`);

    expect(db.statements.map((statement) => statement.params)).toEqual([{ p0: 'tenant-a', p1: 'umbrella', p2: BEN }]);
    expect(result.recordset.map((row) => row.UserID).sort(byCodeUnit)).toEqual(expected);

    db.clearLogs();
    const rows = await collect(streamCanonicalRows({ legacy: db, table: 'tusers', scope }));
    const reads = db.statements.filter((statement) => statement.sql.includes('FROM [dbo].[tusers] WHERE'));
    expect(reads.map((statement) => statement.params)).toEqual([{ p0: 'tenant-a', p1: 'umbrella', p2: BEN }]);
    expect(rows.map((row) => String(row.row.UserID))).toEqual(expected);
  });
});

/** Live tables the fixture ownership leaves on legacy, beside the fixture tables. */
const UNMIGRATED_TABLES: readonly [string, LegacyColumnDef[]][] = [
  ['dbo.tcontenteventreminders', [{ name: 'contentId', type: 'char', length: 35 }, { name: 'siteId', type: 'nvarchar', length: 25 }]],
  ['dbo.tglobals', [{ name: 'appreload', type: 'datetime' }, { name: 'loadlist', type: 'nvarchar', length: 'max' }]],
  ['dbo.fb_contactform', [{ name: 'id', type: 'char', length: 35, nullable: false }]],
  ['dbo.tentity', [{ name: 'entityID', type: 'char', length: 35, nullable: false }]],
];

async function livePartition(): Promise<ReturnType<typeof partitionLegacyTables>> {
  defineFixtureTables(db);
  for (const [qualified, columns] of UNMIGRATED_TABLES) db.defineTable(qualified, columns);
  return partitionLegacyTables(FIXTURE_CATALOG, await listLegacyTables(await db.live()));
}

describe('partitionLegacyTables', () => {
  it('splits the live tables into migratable and skipped sides, each sorted by name', async () => {
    const partition = await livePartition();

    expect(partition.migratable.map((table) => table.name)).toEqual([
      ENROLMENT,
      'synthetic.person_archive',
      'tcontent',
      'tfiles',
      'timagesizes',
      'tmailinglist',
      'tmailinglistmembers',
      'tsettings',
      'tusers',
    ]);
    expect(partition.skipped.map((table) => table.name)).toEqual(['fb_contactform', 'synthetic.program_site', 'tcontenteventreminders', 'tentity', 'tglobals']);
    expect(migratableTables(FIXTURE_CATALOG, await listLegacyTables(await db.live()))).toEqual(partition.migratable);
  });

  it.each<[string, string, boolean]>([
    ['fb_contactform', 'decision-list', true],
    ['synthetic.program_site', 'programs-sites', false],
    ['tcontenteventreminders', 'decision-list', false],
    ['tentity', 'unassigned', false],
    ['tglobals', 'retired', false],
  ])('leaves %s on legacy as %s', async (name, owner, dynamic) => {
    const { skipped } = await livePartition();

    expect(DYNAMIC_TABLE_PATTERN.test(name)).toBe(dynamic);
    expect(skipped.find((table) => table.name === name)).toMatchObject({ owner, physical: [{ qualified: name }] });
  });

  it.each<[string, string, readonly string[], readonly string[], readonly [string, number | undefined][]]>([
    [ENROLMENT, 'programs-sites', ['programs-sites'], ['enrolment_id'], [['Program_1.enrolment', 1], ['Program_2.enrolment', 2]]],
    ['synthetic.person_archive', 'people', ['people'], ['archive_id'], [['synthetic.person_archive', undefined]]],
    ['tcontent', 'strategies-content', ['strategies-content'], ['tcontent_ID'], [['tcontent', undefined]]],
    ['tmailinglistmembers', 'programs-sites', ['programs-sites'], [], [['tmailinglistmembers', undefined]]],
    ['tusers', 'split', ['identity', 'people'], ['UserID'], [['tusers', undefined]]],
  ])('migrates %s owned by %s', async (name, owner, owners, keyColumns, physical) => {
    const { migratable } = await livePartition();
    const table = migratable.find((entry) => entry.name === name);

    expect(table).toMatchObject({ owner, owners, keyColumns, folded: physical.length > 1 });
    expect(table?.physical.map((part) => [part.ref.qualified, part.programId])).toEqual(physical);
  });
});

