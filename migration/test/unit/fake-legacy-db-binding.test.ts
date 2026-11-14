// Unit tests for name binding in the in-memory SQL Server fake: names bind before any row is read, as on SQL Server.
import { describe, expect, it } from 'vitest';

import { createFakeLegacyDb, type FakeLegacyDb } from '../helpers/fake-legacy-db.js';

/** A fake with an empty keyed table, a filled table and a child table of the filled one. */
function fakeServer(): FakeLegacyDb {
  return createFakeLegacyDb({
    tables: [
      {
        qualified: 'dbo.empty_table',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'nvarchar', length: 50 },
          { name: 'amount', type: 'decimal', precision: 10, scale: 2 },
        ],
        options: { primaryKey: ['id'] },
      },
      {
        qualified: 'dbo.filled',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'name', type: 'nvarchar', length: 50 },
        ],
        options: { primaryKey: ['id'] },
      },
      {
        qualified: 'dbo.child',
        columns: [
          { name: 'id', type: 'int', nullable: false },
          { name: 'ref', type: 'int' },
        ],
        options: { primaryKey: ['id'] },
      },
    ],
    rows: {
      'dbo.filled': [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
      'dbo.child': [
        { id: 10, ref: 1 },
        { id: 11, ref: 1 },
        { id: 12, ref: 2 },
      ],
    },
  });
}

/** Runs `sql` through the LegacyDb live pool of a fresh fake. */
async function query(sql: string): Promise<{ recordset: unknown; rowsAffected: number[] }> {
  const pool = await fakeServer().live();
  return pool.request().query(sql);
}

describe('fake legacy database name binding', () => {
  it.each([
    ['a select-list column', 'SELECT missing FROM dbo.empty_table', 207],
    ['a qualified column', 'SELECT e.missing FROM dbo.empty_table e', 207],
    ['an unknown qualifier', 'SELECT x.id FROM dbo.empty_table', 4104],
    ['a WHERE column', 'SELECT id FROM dbo.empty_table WHERE missing = 1', 207],
    ['a JOIN ON column with the left table empty', 'SELECT e.id FROM dbo.empty_table e INNER JOIN dbo.filled f ON f.missing = e.id', 207],
    ['an ORDER BY name that is neither alias nor column', 'SELECT id AS k FROM dbo.empty_table ORDER BY missing', 207],
    ['a CASE branch', 'SELECT CASE WHEN id > 0 THEN name ELSE missing END AS v FROM dbo.empty_table', 207],
    ['an aggregate argument', 'SELECT MAX(missing) AS m FROM dbo.empty_table', 207],
    ['a scalar subquery column', 'SELECT (SELECT TOP (1) f.name FROM dbo.filled f WHERE f.missing = e.id) AS v FROM dbo.empty_table e', 207],
    ['a scalar subquery of two columns', 'SELECT (SELECT TOP (1) f.id, f.name FROM dbo.filled f) AS v FROM dbo.empty_table', 116],
    ['an undeclared variable', 'SELECT id FROM dbo.empty_table WHERE id = @undeclared', 137],
    ['an aggregate in WHERE', 'SELECT id FROM dbo.empty_table WHERE COUNT(*) > 0', 147],
    ['an UPDATE WHERE column', "UPDATE dbo.empty_table SET name = N'x' WHERE missing = 1", 207],
    ['an UPDATE SET source column', 'UPDATE dbo.empty_table SET name = missing', 207],
    ['a DELETE WHERE column', 'DELETE FROM dbo.empty_table WHERE missing = 1', 207],
    ['a table-valued function argument', "SELECT file_exists FROM sys.dm_os_file_exists(ISNULL(N'/not-found', missingColumn)) WHERE 1 = 0", 207],
    [
      'a joined table-valued function argument',
      "SELECT e.id FROM dbo.empty_table e INNER JOIN sys.dm_os_file_exists(ISNULL(N'/not-found', missingColumn)) f ON 1 = 1",
      207,
    ],
  ])('rejects %s over an empty table: %s', async (_label, sql, number) => {
    await expect(query(sql)).rejects.toMatchObject({ name: 'RequestError', number });
  });

  it.each([
    ['a CASE branch not taken', 'SELECT CASE WHEN id > 0 THEN name ELSE missing END AS v FROM dbo.filled'],
    ['the right side of a false AND', 'SELECT id FROM dbo.filled WHERE 1 = 0 AND missing = 1'],
    ['the right side of a true OR', 'SELECT id FROM dbo.filled WHERE 1 = 1 OR missing = 1'],
    ['an ISNULL fallback not needed', 'SELECT ISNULL(name, missing) AS v FROM dbo.filled'],
    ['a CASE branch not taken outside a query', 'DECLARE @v int; SET @v = CASE WHEN 1 = 1 THEN 1 ELSE missing END'],
  ])('rejects a missing column in %s, which evaluation never reaches: %s', async (_label, sql) => {
    await expect(query(sql)).rejects.toMatchObject({ name: 'RequestError', number: 207 });
  });

  it.each([
    ['an IF condition after a false AND', 'IF 1 = 0 AND (SELECT COUNT(*) FROM dbo.filled WHERE missing = 1) > 0 SELECT 1', 207],
    ['an IF condition after a true OR', 'IF 1 = 1 OR @undeclared = 1 SELECT 1', 137],
    ['a SET expression', 'DECLARE @v int; SET @v = ISNULL(1, (SELECT TOP (1) missing FROM dbo.empty_table))', 207],
    ['a DECLARE initialiser', 'DECLARE @v int = ISNULL(1, (SELECT TOP (1) missing FROM dbo.empty_table))', 207],
    ['a DECLARE initialiser naming a variable of the same DECLARE', 'DECLARE @a int = 1, @b int = @a', 137],
    ['an INSERT VALUES expression', "INSERT INTO dbo.empty_table (id, name) VALUES (1, ISNULL(N'a', (SELECT TOP (1) missing FROM dbo.filled)))", 207],
    ['a SELECT variable assignment', 'DECLARE @v int; SELECT @v = ISNULL(1, (SELECT TOP (1) missing FROM dbo.filled))', 207],
    ['an EXEC text expression', "EXEC(N'SELECT ' + @undeclared)", 137],
    ['the TOP of a subquery that never runs', 'SELECT ISNULL(1, (SELECT TOP (@undeclared) id FROM dbo.filled)) AS v', 137],
    ['a DELETE TOP expression', 'DELETE TOP (ISNULL(1, (SELECT TOP (1) missing FROM dbo.filled))) FROM dbo.empty_table', 207],
    ['a DELETE WHERE column after a TOP that fails on its value', "DELETE TOP (CAST(N'x' AS int)) FROM dbo.empty_table WHERE missing = 1", 207],
    ['a DELETE WHERE column after a negative TOP', 'DELETE TOP (-1) FROM dbo.empty_table WHERE missing = 1', 207],
  ])('rejects a name in %s that reads no rows, wherever evaluation stops: %s', async (_label, sql, number) => {
    const fake = fakeServer();
    const pool = await fake.live();
    await expect(pool.request().query(sql)).rejects.toMatchObject({ name: 'RequestError', number });
    expect(fake.rows('dbo.empty_table')).toEqual([]);
  });

  it.each([
    ['a schema guard', "IF SCHEMA_ID(N'nope') IS NULL SELECT 1 AS v", [{ v: 1 }], []],
    ['a false AND over a declared variable', 'DECLARE @p int; IF 1 = 0 AND @p = 1 SELECT 1 AS v ELSE SELECT 2 AS v', [{ v: 2 }], []],
    [
      'an UPDATE-then-INSERT upsert',
      "UPDATE dbo.empty_table SET name = N'x' WHERE id = 1; IF @@ROWCOUNT = 0 INSERT INTO dbo.empty_table (id, name) VALUES (1, N'x')",
      undefined,
      [{ id: 1, name: 'x', amount: null }],
    ],
    ['a DECLARE initialiser naming a variable of an earlier DECLARE', 'DECLARE @a int = 1; DECLARE @b int = @a; SELECT @b AS v', [{ v: 1 }], []],
  ])('runs %s that reads no rows: %s', async (_label, sql, recordset, rows) => {
    const fake = fakeServer();
    const pool = await fake.live();
    const result = await pool.request().query(sql);
    expect(result.recordset).toEqual(recordset);
    expect(fake.rows('dbo.empty_table')).toEqual(rows);
  });

  it.each([
    ["SELECT ISNULL(1, (SELECT file_exists FROM sys.dm_os_file_exists(CAST(N'bad-int' AS int)))) AS n", [{ n: 1 }]],
    ["SELECT file_exists FROM sys.dm_os_file_exists(N'/definitely/not/here')", [{ file_exists: 0 }]],
  ])('evaluates a table-valued function argument only when its source is read: %s', async (sql, recordset) => {
    const result = await query(sql);
    expect(result.recordset).toEqual(recordset);
  });

  it('rejects a missing column over an empty table inside a LegacyDb transaction', async () => {
    const fake = fakeServer();
    await expect(fake.transaction(async (tx) => tx.request().query('SELECT missing FROM dbo.empty_table'))).rejects.toMatchObject({
      name: 'RequestError',
      number: 207,
    });
  });

  it.each([
    ['SELECT id, name FROM dbo.empty_table WHERE id = 1 ORDER BY name', []],
    ['DECLARE @id int = 1; SELECT id FROM dbo.empty_table WHERE id = @id', []],
    ['SELECT (SELECT COUNT(*) FROM dbo.child c WHERE c.ref = e.id) AS n FROM dbo.empty_table e', []],
    ["UPDATE dbo.empty_table SET name = N'x', amount = amount WHERE id = 1", undefined],
    ['DELETE FROM dbo.empty_table WHERE id = 1', undefined],
  ])('runs a valid statement over an empty table: %s', async (sql, recordset) => {
    const result = await query(sql);
    expect(result.rowsAffected).toEqual([0]);
    expect(result.recordset).toEqual(recordset);
  });

  it('keeps the declared column types of an empty result', async () => {
    const result = await query('SELECT name, amount FROM dbo.empty_table');
    expect(result.recordset).toEqual([]);
    expect((result.recordset as { columns: unknown }).columns).toMatchObject({
      name: { index: 0, length: 50, nullable: true },
      amount: { index: 1, precision: 10, scale: 2, nullable: true },
    });
  });

  it('aggregates an empty table into one row', async () => {
    const result = await query('SELECT COUNT(*) AS n, MAX(id) AS m FROM dbo.empty_table');
    expect(result.recordset).toEqual([{ n: 0, m: null }]);
  });

  it('orders by a select-list alias', async () => {
    const result = await query('SELECT name AS label FROM dbo.filled ORDER BY label DESC');
    expect(result.recordset).toEqual([{ label: 'b' }, { label: 'a' }]);
  });

  it('binds a correlated subquery to its outer row', async () => {
    const result = await query('SELECT f.id, (SELECT COUNT(*) FROM dbo.child c WHERE c.ref = f.id) AS n FROM dbo.filled f ORDER BY f.id');
    expect(result.recordset).toEqual([
      { id: 1, n: 2 },
      { id: 2, n: 1 },
    ]);
  });

  it.each([
    "SELECT CASE WHEN id > 0 THEN id ELSE CAST(N'abc' AS int) END AS v FROM dbo.filled ORDER BY id",
    "SELECT CASE WHEN id > 0 THEN id ELSE CAST(N'abc' AS int) + 1 END AS v FROM dbo.filled ORDER BY id",
  ])('runs a CASE whose untaken branch fails only on its value: %s', async (sql) => {
    const result = await query(sql);
    expect(result.recordset).toEqual([{ v: 1 }, { v: 2 }]);
  });
});
