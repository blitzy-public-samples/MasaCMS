// Unit tests for the opt2_sync batch and init-legacy, using an in-memory live pool in place of SQL Server.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ConnectionPool } from 'mssql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  initLegacy,
  opt2SyncReady,
  Opt2SyncUnavailableError,
  type InitLegacyLogger,
  type InitLegacyResult,
} from '../../src/legacy/init-legacy.js';
import type { LegacyDb } from '../../src/legacy/legacy-db.js';
import { OPT2_SYNC_SQL_PATH } from '../../src/paths.js';

const sqlText = readFileSync(OPT2_SYNC_SQL_PATH, 'utf8');

const RESULT: InitLegacyResult = { schema: 'opt2_sync', table: 'opt2_sync.projector_checkpoint' };
const SCHEMA_GUARD = /IF\s+SCHEMA_ID\(N'opt2_sync'\)\s+IS\s+NULL\s+EXEC\(N'CREATE\s+SCHEMA\s+opt2_sync'\)/i;
const TABLE_GUARD =
  /IF\s+OBJECT_ID\(N'opt2_sync\.projector_checkpoint',\s*N'U'\)\s+IS\s+NULL\s+CREATE\s+TABLE\s+opt2_sync\.projector_checkpoint\s*\(/i;
const READY_SQL = /\bsys\.tables\b[\s\S]*'opt2_sync'[\s\S]*'projector_checkpoint'/i;
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
const SEEDED_CHECKPOINT = {
  owner: 'people',
  tenant_id: '00000000-0000-4000-8000-00000000000a',
  cursor_xid: '1001',
  cursor_seq: 4,
  applied_horizon: '1002',
  batch_id: 'batch-0001',
  rows_applied: 3,
  updated_at: new Date('2026-01-02T03:04:05.678Z'),
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

/** SQL Server driver error with `message` and the given `number` or `originalError` fields. */
function sqlError(message: string, fields: { number?: number; originalError?: unknown }): Error {
  return Object.assign(new Error(message), { name: 'RequestError', ...fields });
}

/** Resolves on the next event-loop turn, as a driver round trip would. */
function roundTrip(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Live legacy pool stand-in recording batches and queries; the guarded 005 statements create opt2_sync once. */
function fakeLegacy() {
  const state = {
    schema: false,
    table: false,
    emptyRecordset: false,
    checkpointRows: [] as Record<string, unknown>[],
    nextBatchFailure: undefined as { error: unknown } | undefined,
  };
  const batch = vi.fn(async (text: string) => {
    await roundTrip();
    const failure = state.nextBatchFailure;
    state.nextBatchFailure = undefined;
    if (failure !== undefined) throw failure.error;
    if (SCHEMA_GUARD.test(text)) state.schema = true;
    if (TABLE_GUARD.test(text)) state.table = true;
    return { recordset: [], recordsets: [], rowsAffected: [], output: {} };
  });
  const query = vi.fn(async (sql: string) => {
    await roundTrip();
    if (!READY_SQL.test(sql)) throw new Error(`Unexpected query: ${sql}`);
    const recordset = state.emptyRecordset ? [] : [{ n: state.table ? 1 : 0 }];
    return { recordset, recordsets: [recordset], rowsAffected: [recordset.length], output: {} };
  });
  const request = vi.fn(() => ({ batch, query }));
  const live = vi.fn(async () => {
    await roundTrip();
    return { request } as unknown as ConnectionPool;
  });
  return {
    state,
    batch,
    query,
    live,
    legacy: { live } satisfies Pick<LegacyDb, 'live'>,
    /** The next batch rejects with `error`, whatever its type, before touching any object. */
    failNextBatch(error: unknown): void {
      state.nextBatchFailure = { error };
    },
    /** Inserts a checkpoint row; the table must already exist. */
    seedCheckpoint(row: Record<string, unknown>): void {
      if (!state.table) throw new Error('opt2_sync.projector_checkpoint does not exist');
      state.checkpointRows.push(row);
    },
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
    '%s sends 005_opt2_sync.sql once, unchanged, as a batch on the live pool and logs readiness once',
    async (_label, options) => {
      const fake = fakeLegacy();
      const logger = fakeLogger();

      await expect(initLegacy({ legacy: fake.legacy, logger }, options)).resolves.toEqual(RESULT);
      expect(fake.live).toHaveBeenCalledTimes(1);
      expect(fake.batch).toHaveBeenCalledExactlyOnceWith(sqlText);
      expect(fake.query).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
    },
  );

  it('makes opt2SyncReady turn from false to true', async () => {
    const fake = fakeLegacy();

    await expect(opt2SyncReady(fake.legacy)).resolves.toBe(false);
    await initLegacy({ legacy: fake.legacy, logger: fakeLogger() });
    await expect(opt2SyncReady(fake.legacy)).resolves.toBe(true);
    expect(fake.state).toMatchObject({ schema: true, table: true });
    expect(fake.query).toHaveBeenCalledTimes(2);
    expect(fake.batch).toHaveBeenCalledTimes(1);
  });

  it('succeeds again on an initialised database and leaves existing checkpoint rows intact', async () => {
    const fake = fakeLegacy();
    await initLegacy({ legacy: fake.legacy, logger: fakeLogger() });
    fake.seedCheckpoint(SEEDED_CHECKPOINT);
    const logger = fakeLogger();

    await expect(initLegacy({ legacy: fake.legacy, logger })).resolves.toEqual(RESULT);
    expect(fake.state.checkpointRows).toEqual([SEEDED_CHECKPOINT]);
    expect(fake.batch.mock.calls).toEqual([[sqlText], [sqlText]]);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
    await expect(opt2SyncReady(fake.legacy)).resolves.toBe(true);
  });

  const tableDenied = "CREATE TABLE permission denied in database 'muradb'.";
  const refusals: [string, unknown, number, string][] = [
    ...PERMISSION_REFUSALS.map(([number, message]): [string, unknown, number, string] => [
      `error ${String(number)} in number`,
      sqlError(message, { number }),
      number,
      message,
    ]),
    [
      'error 262 in originalError.info.number',
      sqlError(tableDenied, { originalError: { info: { number: 262, message: tableDenied } } }),
      262,
      tableDenied,
    ],
    ['error 15247 without a string message', { number: 15247 }, 15247, 'SQL Server error 15247'],
  ];

  it.each(refusals)(
    'rejects with Opt2SyncUnavailableError for %s, logs nothing and leaves opt2_sync absent',
    async (_label, refusal, sqlErrorNumber, reason) => {
      const fake = fakeLegacy();
      const logger = fakeLogger();
      fake.failNextBatch(refusal);

      const error = await refusalOf(initLegacy({ legacy: fake.legacy, logger }));

      expect(error.name).toBe('Opt2SyncUnavailableError');
      expect(error.sqlErrorNumber).toBe(sqlErrorNumber);
      expect(error.reason).toBe(reason);
      expect(error.reason).not.toBe('');
      expect(error.message).toContain(reason);
      expect(error.cause).toBe(refusal);
      expect(logger.info).not.toHaveBeenCalled();
      expect(fake.state).toMatchObject({ schema: false, table: false });
      await expect(opt2SyncReady(fake.legacy)).resolves.toBe(false);
    },
  );

  it.each([
    [
      'an unlisted SQL Server error number',
      sqlError("There is already an object named 'projector_checkpoint' in the database.", { number: 2714 }),
    ],
    ['an error without a number', new Error('Connection lost - read ECONNRESET')],
    ['an error whose originalError has no info', sqlError('Request failed to complete', { originalError: {} })],
    ['a thrown string', 'socket hang up'],
    ['a thrown null', null],
  ])('propagates %s unchanged and logs nothing', async (_label, thrown) => {
    const fake = fakeLegacy();
    const logger = fakeLogger();
    fake.failNextBatch(thrown);

    await expect(initLegacy({ legacy: fake.legacy, logger })).rejects.toBe(thrown);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('initLegacy sqlPath option', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-init-legacy-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a path string', (file: string): string | URL => file],
    ['a file URL', (file: string): string | URL => pathToFileURL(file)],
  ])('reads and executes the batch file given as %s', async (label, locate) => {
    const file = path.join(dir, `${label.replaceAll(' ', '-')}.sql`);
    const text = `-- ${label} override, übersicht\r\nSELECT 1 AS n;\r\n`;
    await writeFile(file, text, 'utf8');
    const fake = fakeLegacy();
    const logger = fakeLogger();

    await expect(initLegacy({ legacy: fake.legacy, logger }, { sqlPath: locate(file) })).resolves.toEqual(RESULT);
    expect(fake.batch).toHaveBeenCalledExactlyOnceWith(text);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith('opt2_sync ready');
  });
});

describe('opt2SyncReady', () => {
  it('returns false when the readiness query returns no row', async () => {
    const fake = fakeLegacy();
    fake.state.table = true;
    fake.state.emptyRecordset = true;

    await expect(opt2SyncReady(fake.legacy)).resolves.toBe(false);
    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.batch).not.toHaveBeenCalled();
  });
});
