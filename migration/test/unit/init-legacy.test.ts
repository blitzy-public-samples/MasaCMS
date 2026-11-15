// Unit tests for the opt2_sync batch and init-legacy, run against the in-memory legacy database fake.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  initLegacy,
  opt2SyncReady,
  Opt2SyncUnavailableError,
  type InitLegacyLogger,
  type InitLegacyResult,
} from '../../src/legacy/init-legacy.js';
import { OPT2_SYNC_SQL_PATH } from '../../src/paths.js';
import { createTestDirs, type TestDirs } from '../helpers/env.js';
import {
  connectionLost,
  createFakeLegacyDb,
  sqlError,
  type FakeLegacyDb,
  type LegacyColumnDef,
  type Row,
} from '../helpers/fake-legacy-db.js';

const sqlText = readFileSync(OPT2_SYNC_SQL_PATH, 'utf8');

const LIVE = 'muradb';
const CHECKPOINT_TABLE = 'opt2_sync.projector_checkpoint';
const RESULT: InitLegacyResult = { schema: 'opt2_sync', table: CHECKPOINT_TABLE };
const SCHEMA_GUARD = /IF\s+SCHEMA_ID\(N'opt2_sync'\)\s+IS\s+NULL\s+EXEC\(N'CREATE\s+SCHEMA\s+opt2_sync'\)/i;
const TABLE_GUARD =
  /IF\s+OBJECT_ID\(N'opt2_sync\.projector_checkpoint',\s*N'U'\)\s+IS\s+NULL\s+CREATE\s+TABLE\s+opt2_sync\.projector_checkpoint\s*\(/i;
const CHECKPOINT_COLUMNS = [
  'owner',
  'tenant_id',
  'cursor_xid',
  'cursor_seq',
  'applied_horizon',
  'batch_id',
  'rows_applied',
  'updated_at',
  'pending_effects',
  'ready_horizon',
];
const MASA_TABLES = [
  'tcontent',
  'tusers',
  'tsettings',
  'tfiles',
  'tusersmemb',
  'tpermissions',
  'tmailinglist',
  'tmailinglistmembers',
  'tclassextenddata',
  'tredirects',
];
const PERMISSION_REFUSALS: [number, string][] = [
  [229, "The ALTER permission was denied on the object 'opt2_sync', database 'muradb', schema 'opt2_sync'."],
  [230, "The SELECT permission was denied on the column 'owner' of the object 'projector_checkpoint'."],
  [262, "CREATE SCHEMA permission denied in database 'muradb'."],
  [2760, 'The specified schema name "opt2_sync" either does not exist or you do not have permission to use it.'],
  [15247, 'User does not have permission to perform this action.'],
];
const MASA_COLUMNS: LegacyColumnDef[] = [
  { name: 'SiteID', type: 'nvarchar', length: 25, nullable: false },
  { name: 'Title', type: 'nvarchar', length: 255 },
];
const MASA_ROWS: Record<string, Row[]> = {
  'dbo.tsettings': [{ SiteID: 'default', Title: 'Default' }],
  'dbo.tcontent': [{ SiteID: 'default', Title: 'Home' }],
};
const SEEDED_CHECKPOINT: Row = {
  owner: 'people',
  tenant_id: '00000000-0000-4000-8000-00000000000a',
  cursor_xid: 1001,
  cursor_seq: 4,
  applied_horizon: 1002,
  batch_id: 'batch-0001',
  rows_applied: 3,
  updated_at: new Date('2026-01-02T03:04:05.678Z'),
  pending_effects: null,
  ready_horizon: null,
};

/** Items of the parenthesised list after `CREATE TABLE opt2_sync.projector_checkpoint`, split at top-level commas. */
function checkpointTableItems(text: string): string[] {
  const create = text.search(/CREATE\s+TABLE\s+opt2_sync\.projector_checkpoint\s*\(/i);
  if (create < 0) throw new Error('No CREATE TABLE opt2_sync.projector_checkpoint in the batch');
  const items: string[] = [];
  let depth = 0;
  let item = '';
  for (const char of text.slice(text.indexOf('(', create) + 1)) {
    if (char === ')' && depth === 0) return [...items, item.trim()];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(item.trim());
      item = '';
    } else {
      item += char;
    }
  }
  throw new Error('CREATE TABLE opt2_sync.projector_checkpoint has no closing parenthesis');
}

/** A fake legacy server whose live database holds two Masa tables with one row each. */
function masaLegacy(): FakeLegacyDb {
  return createFakeLegacyDb({
    database: LIVE,
    tables: Object.keys(MASA_ROWS).map((qualified) => ({ qualified, columns: MASA_COLUMNS })),
    rows: MASA_ROWS,
  });
}

/** Rows `sql` returns on the live database. */
async function select<T>(fake: FakeLegacyDb, sql: string): Promise<T[]> {
  const pool = await fake.live();
  return (await pool.request().query<T>(sql)).recordset;
}

/** Schemas, tables, columns and primary keys of the live database, as its catalog views report them. */
async function catalogOf(fake: FakeLegacyDb) {
  return {
    schemas: await select<{ name: string }>(fake, 'SELECT name FROM sys.schemas ORDER BY name'),
    tables: await select<{ schema_name: string; name: string; object_id: number; create_date: Date }>(
      fake,
      'SELECT s.name AS schema_name, t.name, t.object_id, t.create_date FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id ORDER BY s.name, t.name',
    ),
    columns: await select<Record<string, unknown>>(
      fake,
      'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION',
    ),
    keys: await select<{ object_id: number; name: string | null; is_primary_key: boolean }>(
      fake,
      'SELECT object_id, name, is_primary_key FROM sys.indexes ORDER BY object_id',
    ),
  };
}

/** Logger whose `info` calls are recorded. */
function fakeLogger() {
  return { info: vi.fn<(msg: string) => void>() } satisfies InitLegacyLogger;
}

/** Awaits an init that must be refused and returns its `Opt2SyncUnavailableError`. */
async function refusalOf(pending: Promise<unknown>): Promise<Opt2SyncUnavailableError> {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Opt2SyncUnavailableError);
  return error as Opt2SyncUnavailableError;
}

describe('005_opt2_sync.sql', () => {
  it('contains no GO separator line, so it runs as one batch', () => {
    expect(sqlText.split(/\r?\n/).filter((line) => line.trim().toUpperCase() === 'GO')).toEqual([]);
  });

  it('creates exactly one schema, opt2_sync, only when SCHEMA_ID finds none', () => {
    expect([...sqlText.matchAll(/CREATE\s+SCHEMA\s+([\w[\]]+)/gi)].map((match) => match[1])).toEqual(['opt2_sync']);
    expect(sqlText).toMatch(SCHEMA_GUARD);
  });

  it('creates exactly one table, opt2_sync.projector_checkpoint, only when OBJECT_ID finds none', () => {
    expect([...sqlText.matchAll(/CREATE\s+TABLE\s+([\w.[\]]+)/gi)].map((match) => match[1])).toEqual([
      'opt2_sync.projector_checkpoint',
    ]);
    expect(sqlText).toMatch(TABLE_GUARD);
  });

  it('defines the checkpoint columns and PK_opt2_sync_projector_checkpoint on (owner, tenant_id)', () => {
    const items = checkpointTableItems(sqlText);
    const isConstraint = (item: string): boolean => /^CONSTRAINT\b/i.test(item);

    expect(items.filter((item) => !isConstraint(item)).map((item) => item.split(/\s+/)[0])).toEqual(
      CHECKPOINT_COLUMNS,
    );
    expect(items.filter(isConstraint)).toEqual([
      expect.stringMatching(
        /^CONSTRAINT\s+PK_opt2_sync_projector_checkpoint\s+PRIMARY\s+KEY\s*\(\s*owner\s*,\s*tenant_id\s*\)$/i,
      ),
    ]);
  });

  it.each([
    ['CREATE TRIGGER', /\bCREATE\s+(?:OR\s+ALTER\s+)?TRIGGER\b/i, 'create or alter trigger trg on tcontent'],
    ['CREATE PROC or PROCEDURE', /\bCREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\b/i, 'Create Proc p as select 1'],
    ['CREATE FUNCTION', /\bCREATE\s+(?:OR\s+ALTER\s+)?FUNCTION\b/i, 'CREATE FUNCTION f() returns int'],
    ['ALTER TABLE', /\bALTER\s+TABLE\b/i, 'alter table tusers add x int'],
    ['ENABLE CHANGE_TRACKING', /\bENABLE\s+CHANGE_TRACKING\b/i, 'ALTER TABLE t ENABLE CHANGE_TRACKING'],
    ['sp_cdc_ call', /\bsp_cdc_/i, 'EXEC sys.sp_cdc_enable_table'],
  ])('contains no %s', (_label, pattern, sample) => {
    expect(sample).toMatch(pattern);
    expect(sqlText).not.toMatch(pattern);
  });

  it.each(MASA_TABLES)('does not name the Masa table %s', (table) => {
    expect(sqlText).not.toMatch(new RegExp(`\\b${table}\\b`, 'i'));
  });

  it('does not reference the dbo schema', () => {
    expect(sqlText).not.toMatch(/\bdbo\./i);
  });
});

describe('initLegacy', () => {
  it.each([
    ['without options', undefined],
    ['with options that set no sqlPath', {}],
  ])(
    '%s sends 005_opt2_sync.sql once, unchanged, as a batch on the live database and logs readiness once',
    async (_label, options) => {
      const fake = masaLegacy();
      const logger = fakeLogger();

      await expect(initLegacy({ legacy: fake, logger }, options)).resolves.toEqual(RESULT);
      expect(fake.statements).toEqual([{ database: LIVE, sql: sqlText, params: {}, txId: null, at: expect.any(Number) }]);
      expect(fake.rows(CHECKPOINT_TABLE)).toEqual([]);
      expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
    },
  );

  it('makes opt2SyncReady turn from false to true', async () => {
    const fake = masaLegacy();

    await expect(opt2SyncReady(fake)).resolves.toBe(false);
    await initLegacy({ legacy: fake, logger: fakeLogger() });
    await expect(opt2SyncReady(fake)).resolves.toBe(true);
    expect(fake.statements.map((statement) => statement.database)).toEqual([LIVE, LIVE, LIVE]);
  });

  it('adds only the opt2_sync schema and its checkpoint table, keyed on (owner, tenant_id), and leaves Masa tables intact', async () => {
    const fake = masaLegacy();
    const before = await catalogOf(fake);

    await initLegacy({ legacy: fake, logger: fakeLogger() });
    const after = await catalogOf(fake);
    const [checkpoint] = after.tables.filter((table) => table.schema_name === 'opt2_sync');

    expect(after.schemas.filter((schema) => !before.schemas.some((known) => known.name === schema.name))).toEqual([
      { name: 'opt2_sync' },
    ]);
    expect(after.tables.filter((table) => table.schema_name !== 'opt2_sync')).toEqual(before.tables);
    expect(checkpoint).toMatchObject({ name: 'projector_checkpoint' });
    expect(after.columns.filter((column) => column.TABLE_SCHEMA !== 'opt2_sync')).toEqual(before.columns);
    expect(
      after.columns
        .filter((column) => column.TABLE_SCHEMA === 'opt2_sync')
        .map((column) => [column.TABLE_NAME, column.COLUMN_NAME, column.DATA_TYPE, column.IS_NULLABLE]),
    ).toEqual([
      ['projector_checkpoint', 'owner', 'nvarchar', 'NO'],
      ['projector_checkpoint', 'tenant_id', 'char', 'NO'],
      ['projector_checkpoint', 'cursor_xid', 'decimal', 'NO'],
      ['projector_checkpoint', 'cursor_seq', 'bigint', 'NO'],
      ['projector_checkpoint', 'applied_horizon', 'decimal', 'NO'],
      ['projector_checkpoint', 'batch_id', 'nvarchar', 'NO'],
      ['projector_checkpoint', 'rows_applied', 'int', 'NO'],
      ['projector_checkpoint', 'updated_at', 'datetime2', 'NO'],
      ['projector_checkpoint', 'pending_effects', 'nvarchar', 'YES'],
      ['projector_checkpoint', 'ready_horizon', 'decimal', 'YES'],
    ]);
    expect(after.keys.filter((key) => key.object_id === checkpoint?.object_id)).toEqual([
      { object_id: checkpoint?.object_id, name: 'PK_opt2_sync_projector_checkpoint', is_primary_key: true },
    ]);
    for (const [table, rows] of Object.entries(MASA_ROWS)) expect(fake.rows(table)).toEqual(rows);
  });

  it('succeeds again on an initialised database without recreating the table or touching its rows', async () => {
    const fake = masaLegacy();
    await initLegacy({ legacy: fake, logger: fakeLogger() });
    fake.seed(CHECKPOINT_TABLE, [SEEDED_CHECKPOINT]);
    const catalog = await catalogOf(fake);
    const rows = fake.rows(CHECKPOINT_TABLE);
    const logger = fakeLogger();

    await expect(initLegacy({ legacy: fake, logger })).resolves.toEqual(RESULT);
    expect(await catalogOf(fake)).toEqual(catalog);
    expect(fake.rows(CHECKPOINT_TABLE)).toEqual(rows);
    expect(rows).toEqual([expect.objectContaining({ owner: 'people', tenant_id: SEEDED_CHECKPOINT.tenant_id })]);
    expect(fake.statements.filter((statement) => statement.sql === sqlText)).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
    await expect(opt2SyncReady(fake)).resolves.toBe(true);
  });

  const tableDenied = "CREATE TABLE permission denied in database 'muradb'.";
  const refusals: [string, unknown, number, string][] = [
    ...PERMISSION_REFUSALS.map(([number, message]): [string, unknown, number, string] => [
      `SQL Server error ${String(number)}`,
      sqlError(number, message),
      number,
      message,
    ]),
    [
      'error 262 carried only in originalError.info.number',
      Object.assign(new Error(tableDenied), { name: 'RequestError', originalError: { info: { number: 262 } } }),
      262,
      tableDenied,
    ],
    ['error 15247 without a string message', { number: 15247 }, 15247, 'SQL Server error 15247'],
  ];

  it.each(refusals)(
    'rejects with Opt2SyncUnavailableError for %s, logs nothing and leaves opt2_sync absent',
    async (_label, refusal, sqlErrorNumber, reason) => {
      const fake = masaLegacy();
      const logger = fakeLogger();
      fake.failNext((statement) => statement.sql === sqlText, refusal);

      const error = await refusalOf(initLegacy({ legacy: fake, logger }));

      expect(error).toMatchObject({ name: 'Opt2SyncUnavailableError', sqlErrorNumber, reason, cause: refusal });
      expect(error.reason).not.toBe('');
      expect(error.message).toContain(reason);
      expect(logger.info).not.toHaveBeenCalled();
      expect(fake.statements.map((statement) => statement.sql)).toEqual([sqlText]);
      await expect(opt2SyncReady(fake)).resolves.toBe(false);
      await expect(select(fake, "SELECT SCHEMA_ID(N'opt2_sync') AS id")).resolves.toEqual([{ id: null }]);
    },
  );

  it.each([
    ['an unlisted SQL Server error number', sqlError(2714)],
    ['a lost connection', connectionLost()],
    ['an error whose originalError has no info', Object.assign(new Error('Request failed'), { originalError: {} })],
    ['a thrown string', 'socket hang up'],
    ['a thrown null', null],
  ])('propagates %s unchanged and logs nothing', async (_label, thrown) => {
    const fake = masaLegacy();
    const logger = fakeLogger();
    fake.failNext((statement) => statement.sql === sqlText, thrown);

    await expect(initLegacy({ legacy: fake, logger })).rejects.toBe(thrown);
    expect(logger.info).not.toHaveBeenCalled();
    await expect(opt2SyncReady(fake)).resolves.toBe(false);
  });
});

describe('initLegacy sqlPath option', () => {
  let dirs: TestDirs | undefined;

  beforeAll(async () => {
    dirs = await createTestDirs();
  });

  afterAll(async () => {
    await dirs?.cleanup();
  });

  it.each([
    ['a path string', (file: string): string | URL => file],
    ['a file URL', (file: string): string | URL => pathToFileURL(file)],
  ])('reads the batch file given as %s and executes its text', async (label, locate) => {
    if (dirs === undefined) throw new Error('Test directories were not created');
    const file = path.join(dirs.stateDir, `${label.replaceAll(' ', '-')}.sql`);
    const text = `-- copy given as ${label}, übersicht\r\n${sqlText}`;
    await writeFile(file, text, 'utf8');
    const fake = masaLegacy();
    const logger = fakeLogger();

    await expect(initLegacy({ legacy: fake, logger }, { sqlPath: locate(file) })).resolves.toEqual(RESULT);
    expect(fake.statements.map((statement) => statement.sql)).toEqual([text]);
    await expect(opt2SyncReady(fake)).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
  });
});
