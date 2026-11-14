// Unit tests for transactional DDL in the fake legacy database: objects a transaction created go when it rolls back.
import { readFileSync } from 'node:fs';

import type { Request } from 'mssql';
import { describe, expect, it } from 'vitest';

import { MASTER_DATABASE } from '../../src/legacy/legacy-db.js';
import { OPT2_SYNC_SQL_PATH } from '../../src/paths.js';
import { createFakeLegacyDb, type FakeLegacyDb } from '../helpers/fake-legacy-db.js';

const OPT2_SYNC_SQL = readFileSync(OPT2_SYNC_SQL_PATH, 'utf8');
const LIVE = 'masa_test';
const KEYED_TABLE = '(id int NOT NULL PRIMARY KEY, v nvarchar(20) NULL)';
const SCHEMA_AND_TABLE = ["EXEC(N'CREATE SCHEMA s')", 'CREATE TABLE s.t (id int NOT NULL PRIMARY KEY)'];

/** Runs each batch in order on `target`. */
async function runAll(target: { request(): Request }, batches: readonly string[]): Promise<void> {
  for (const text of batches) await target.request().batch(text);
}

/** The `v` column of the first row `sql` returns on `database`. */
async function scalar(fake: FakeLegacyDb, sql: string, database = LIVE): Promise<unknown> {
  const pool = await fake.database(database);
  const result = await pool.request().query<{ v: unknown }>(sql);
  return result.recordset[0]?.v;
}

/** Asserts that no probe a migration suite uses finds `schema.name` in `database`. */
async function expectNoTable(fake: FakeLegacyDb, schema: string, name: string, database = LIVE): Promise<void> {
  const qualified = `${schema}.${name}`;
  expect(await scalar(fake, `SELECT OBJECT_ID(N'${qualified}', N'U') AS v`, database)).toBeNull();
  const pool = await fake.database(database);
  await expect(pool.request().query(`SELECT * FROM ${qualified}`)).rejects.toMatchObject({ name: 'RequestError', number: 208 });
  const listed = await pool.request().query<{ TABLE_SCHEMA: string; TABLE_NAME: string }>('SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES');
  expect(listed.recordset).not.toContainEqual({ TABLE_SCHEMA: schema, TABLE_NAME: name });
  expect(() => fake.rows(qualified, { database })).toThrow(`Invalid object name '${qualified}'`);
}

describe('fake legacy database transactional DDL', () => {
  it.each([
    { label: 'the live database', database: LIVE, qualified: 'dbo.t' },
    { label: 'another database named in three parts', database: 'msdb', qualified: 'msdb.dbo.t' },
  ])('drops a table created in $label, with its rows, when the transaction rolls back', async ({ database, qualified }) => {
    const fake = createFakeLegacyDb();
    const boom = new Error('boom');
    await expect(
      fake.transaction(async (tx) => {
        await runAll(tx, [`CREATE TABLE ${qualified} ${KEYED_TABLE}`, `INSERT INTO ${qualified} (id, v) VALUES (1, N'a')`]);
        const seen = await tx.request().query<{ id: number; v: string }>(`SELECT id, v FROM ${qualified}`);
        expect(seen.recordset).toEqual([{ id: 1, v: 'a' }]);
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expectNoTable(fake, 'dbo', 't', database);
    await (await fake.database(database)).request().batch(`CREATE TABLE ${qualified} ${KEYED_TABLE}`);
    expect(fake.rows('dbo.t', { database })).toEqual([]);
  });

  it('drops a schema created through EXEC and a table created in it, so both can be created again', async () => {
    const fake = createFakeLegacyDb();
    const boom = new Error('boom');
    await expect(
      fake.transaction(async (tx) => {
        await runAll(tx, SCHEMA_AND_TABLE);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await scalar(fake, "SELECT SCHEMA_ID(N's') AS v")).toBeNull();
    await expectNoTable(fake, 's', 't');
    await fake.transaction((tx) => runAll(tx, SCHEMA_AND_TABLE));
    expect(await scalar(fake, "SELECT SCHEMA_ID(N's') AS v")).toEqual(expect.any(Number));
    expect(fake.rows('s.t')).toEqual([]);
  });

  it.each([
    { label: 'a duplicate key', crash: false, error: { name: 'RequestError', number: 2627 } },
    { label: 'an injected crash', crash: true, error: { name: 'CrashInjectedError' } },
  ])('drops a table created before $label failed the transaction', async ({ crash, error }) => {
    const fake = createFakeLegacyDb();
    if (crash) fake.crashAt((statement) => statement.sql.startsWith('INSERT'));
    const batches = ['CREATE TABLE dbo.t (id int NOT NULL PRIMARY KEY)', 'INSERT INTO dbo.t (id) VALUES (1)', 'INSERT INTO dbo.t (id) VALUES (1)'];
    await expect(fake.transaction((tx) => runAll(tx, batches))).rejects.toMatchObject(error);
    await expectNoTable(fake, 'dbo', 't');
  });

  it('leaves nothing of a rolled-back opt2_sync batch, keeps a committed one, and a further run changes nothing', async () => {
    const fake = createFakeLegacyDb();
    const boom = new Error('boom');
    const schemaId = "SELECT SCHEMA_ID(N'opt2_sync') AS v";
    const objectId = "SELECT OBJECT_ID(N'opt2_sync.projector_checkpoint', N'U') AS v";
    await expect(
      fake.transaction(async (tx) => {
        await tx.request().batch(OPT2_SYNC_SQL);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await scalar(fake, schemaId)).toBeNull();
    await expectNoTable(fake, 'opt2_sync', 'projector_checkpoint');

    await fake.transaction((tx) => runAll(tx, [OPT2_SYNC_SQL]));
    const created = { schema: await scalar(fake, schemaId), table: await scalar(fake, objectId) };
    expect(created.schema).toEqual(expect.any(Number));
    expect(created.table).toEqual(expect.any(Number));
    expect(fake.rows('opt2_sync.projector_checkpoint')).toEqual([]);

    await fake.transaction((tx) => runAll(tx, [OPT2_SYNC_SQL]));
    expect({ schema: await scalar(fake, schemaId), table: await scalar(fake, objectId) }).toEqual(created);
    expect(fake.commits).toHaveLength(2);
  });

  it('lets a transaction write and read its new table, and keeps the table and row once it commits', async () => {
    const fake = createFakeLegacyDb();
    await fake.transaction(async (tx) => {
      await runAll(tx, [`CREATE TABLE dbo.t ${KEYED_TABLE}`, "INSERT INTO dbo.t (id, v) VALUES (1, N'a')"]);
      const seen = await tx.request().query<{ id: number; v: string }>('SELECT id, v FROM dbo.t');
      expect(seen.recordset).toEqual([{ id: 1, v: 'a' }]);
    });
    expect(fake.rows('dbo.t')).toEqual([{ id: 1, v: 'a' }]);
    const read = await (await fake.live()).request().query<{ id: number; v: string }>('SELECT id, v FROM dbo.t');
    expect(read.recordset).toEqual([{ id: 1, v: 'a' }]);
  });

  it('drops DDL when an mssql Transaction over the pool rolls back', async () => {
    const fake = createFakeLegacyDb();
    const tx = (await fake.live()).transaction();
    await tx.begin();
    await runAll(tx, SCHEMA_AND_TABLE);
    await tx.rollback();
    expect(await scalar(fake, "SELECT SCHEMA_ID(N's') AS v")).toBeNull();
    await expectNoTable(fake, 's', 't');
  });

  it('drops DDL of a transaction whose connection ROLLBACK IMMEDIATE ends', async () => {
    const fake = createFakeLegacyDb();
    const tx = (await fake.live()).transaction();
    await tx.begin();
    await tx.request().batch('CREATE TABLE dbo.t (id int NOT NULL)');
    await (await fake.database(MASTER_DATABASE)).request().batch(`ALTER DATABASE ${LIVE} SET MULTI_USER WITH ROLLBACK IMMEDIATE`);
    await expectNoTable(fake, 'dbo', 't');
    await expect(tx.rollback()).rejects.toMatchObject({ name: 'TransactionError', code: 'EABORT' });
  });

  it('drops DDL of a transaction whose commit fails on a key another commit took', async () => {
    const fake = createFakeLegacyDb();
    fake.defineTable('dbo.k', [{ name: 'id', type: 'int', nullable: false }], { primaryKey: ['id'] });
    const pool = await fake.live();
    const first = pool.transaction();
    const second = pool.transaction();
    await first.begin();
    await second.begin();
    await runAll(second, ['CREATE TABLE dbo.t (id int NOT NULL)', 'INSERT INTO dbo.k (id) VALUES (1)']);
    await first.request().batch('INSERT INTO dbo.k (id) VALUES (1)');
    await first.commit();
    await expect(second.commit()).rejects.toMatchObject({ name: 'RequestError', number: 2627 });
    await expectNoTable(fake, 'dbo', 't');
    expect(fake.rows('dbo.k')).toEqual([{ id: 1 }]);
  });

  it('keeps an autocommit CREATE TABLE through a later rolled-back transaction that created another table', async () => {
    const fake = createFakeLegacyDb();
    await (await fake.live()).request().batch('CREATE TABLE dbo.kept (id int NOT NULL)');
    const boom = new Error('boom');
    await expect(
      fake.transaction(async (tx) => {
        await tx.request().batch('CREATE TABLE dbo.t (id int NOT NULL)');
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await scalar(fake, "SELECT OBJECT_ID(N'dbo.kept', N'U') AS v")).toEqual(expect.any(Number));
    expect(fake.rows('dbo.kept')).toEqual([]);
    await expectNoTable(fake, 'dbo', 't');
  });
});
