import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReadOnlyViolation,
  assertReadOnlySql,
  createReadOnlyMssql,
  mssqlConfigFromEnv,
  type MssqlConfig,
  type MssqlDriver,
  type MssqlPool,
  type MssqlRequest,
} from '../../src/lib/mssql.js';
import type { EnvLike } from '../../src/lib/paths.js';

// Placeholder settings; no test reads process.env or opens a connection.
const ENV: EnvLike = {
  MURA_DBHOST: 'sql.fixture.test',
  MURA_DATABASE: 'muradb_fixture',
  MURA_DBUSERNAME: 'fixture-user',
  MURA_DBPASSWORD: 'fixture-pw',
};

const CONFIG: MssqlConfig = {
  server: 'sql.fixture.test',
  port: 1433,
  database: 'muradb_fixture',
  user: 'fixture-user',
  password: 'fixture-pw',
  options: { encrypt: true, trustServerCertificate: true },
};

const START = 'read-only query must start with SELECT or WITH … SELECT';
const SINGLE = 'read-only query must be a single statement';
const uses = (keyword: string): string => `read-only query must not use ${keyword}`;

const WRITE_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'TRUNCATE', 'BULK',
  'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'DENY',
  'EXEC', 'EXECUTE', 'DBCC', 'BACKUP', 'RESTORE', 'WAITFOR', 'SHUTDOWN', 'KILL',
  'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'USE',
  'WRITETEXT', 'UPDATETEXT', 'SET', 'DECLARE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
  'CHECKPOINT', 'RECONFIGURE', 'RAISERROR', 'SETUSER', 'REVERT', 'OPEN', 'ADD',
];

interface FakeDriver {
  driver: MssqlDriver;
  /** Pool configs, one per `ConnectionPool` constructed. */
  configs: MssqlConfig[];
  /** Pool and request calls in order: `connect`, `request`, `input <name>=<json>`, `query <sql>`, `close`. */
  log: string[];
}

/** Driver whose pools record every call and answer each query with `rows`; `connectError` makes `connect` reject. */
function fakeDriver(rows: Record<string, unknown>[] = [], connectError?: Error): FakeDriver {
  const configs: MssqlConfig[] = [];
  const log: string[] = [];
  class FakePool implements MssqlPool {
    constructor(config: MssqlConfig) {
      configs.push(config);
    }

    async connect(): Promise<MssqlPool> {
      log.push('connect');
      if (connectError !== undefined) throw connectError;
      return this;
    }

    request(): MssqlRequest {
      log.push('request');
      const request: MssqlRequest = {
        input(name: string, value: unknown): MssqlRequest {
          log.push(`input ${name}=${JSON.stringify(value)}`);
          return request;
        },
        async query<T = Record<string, unknown>>(sql: string): Promise<{ recordset: T[] }> {
          log.push(`query ${sql}`);
          return { recordset: rows as T[] };
        },
      };
      return request;
    }

    async close(): Promise<void> {
      log.push('close');
    }
  }
  return { driver: { ConnectionPool: FakePool }, configs, log };
}

describe('assertReadOnlySql', () => {
  it.each<[string, string]>([
    ['a plain SELECT', 'SELECT 1'],
    ['lower case with a trailing terminator and whitespace', 'select name from sys.procedures;\n  '],
    ['WITH … SELECT', 'WITH c AS (SELECT 1 AS n) SELECT n FROM c'],
    ['a leading comment', '-- stored-procedure check\nSELECT COUNT(*) FROM sys.procedures'],
    ['keywords and a semicolon inside a string literal', "SELECT 'DROP TABLE tusers; DELETE' AS note"],
    ['a doubled quote inside a literal', "SELECT 'it''s; INSERT' AS note"],
    ['keywords inside comments', 'SELECT 1 /* INSERT INTO t; */ AS n -- DELETE FROM t;'],
    ['keywords as bracketed identifiers, with an escaped bracket', 'SELECT [update], [into]]; drop] FROM [delete]'],
    ['keywords as quoted identifiers, with an escaped quote', 'SELECT "insert", "a""; exec" FROM tusers'],
    ['identifiers that contain keywords', 'SELECT created, updated_at, LastUpdateBy, IsUsed FROM tusers'],
    ['a named parameter', 'SELECT UserID FROM tusers WHERE SiteID = @siteID'],
    ['keywords inside variable, temp-table, pseudo-column and $ names', 'SELECT @delete, $exec, a$exec, t1delete FROM #into'],
    ['identifiers that contain the newer keywords', 'SELECT settings, BeginDate, isOpen, DateAdded, SavedAt FROM tusers'],
    ['columns named next and value, and OFFSET … FETCH NEXT', 'SELECT next, value FROM t ORDER BY next OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY'],
  ])('accepts %s', (_label, sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow();
  });

  it.each<[string, string, string]>([
    ['an empty statement', '', START],
    ['whitespace only', ' \n\t', START],
    ['INSERT', 'INSERT INTO tusers (UserID) VALUES (1)', START],
    ['UPDATE', 'UPDATE tusers SET Fname = NULL', START],
    ['DELETE', 'DELETE FROM tusers', START],
    ['MERGE', 'MERGE tusers AS t USING tusers AS s ON 1 = 0 WHEN NOT MATCHED THEN INSERT DEFAULT VALUES;', START],
    ['EXEC', 'EXEC sp_who', START],
    ['DECLARE', 'DECLARE @n int', START],
    ['SET', 'SET NOCOUNT ON', START],
    ['SELECT hidden in a block comment', '/* SELECT */ DELETE FROM tusers', START],
    ['SELECT hidden in a line comment', '-- SELECT\nDROP TABLE tusers', START],
    ['WITH without SELECT', 'WITH c (n) AS (VALUES (1)) DELETE FROM tusers', START],
    ['a second statement', 'SELECT 1; SELECT 2', SINGLE],
    ['a write after a semicolon', 'SELECT 1; DROP TABLE tusers', SINGLE],
    ['a doubled terminator', 'SELECT 1;;', SINGLE],
    ['a semicolon after a literal that looks like a comment', "SELECT '--'; DROP TABLE tusers", SINGLE],
    ['a semicolon in an unterminated literal', "SELECT 'x; DROP TABLE tusers", SINGLE],
    ['a write after WITH … SELECT', 'WITH c AS (SELECT 1 AS n) DELETE FROM tusers', uses('DELETE')],
    ['SELECT … INTO', 'SELECT * INTO tusers_copy FROM tusers', uses('INTO')],
    ['a second statement without a terminator', 'SELECT 1\nDELETE FROM tusers', uses('DELETE')],
    ['a write after an unterminated block comment', 'SELECT 1 /* DROP TABLE tusers', uses('DROP')],
    ['a lower-case keyword', "select 1 from tusers waitfor delay '0:0:5'", uses('WAITFOR')],
    ['a sequence advance', 'SELECT NEXT VALUE FOR dbo.seq_order AS n', uses('NEXT VALUE FOR')],
    ['a mixed-case sequence advance split by whitespace and a comment', 'SELECT next\n\tValue /* gap */ FOR dbo.seq_order', uses('NEXT VALUE FOR')],
    ['a sequence advance glued to a number', 'SELECT 1NEXT VALUE FOR dbo.seq_order', uses('NEXT VALUE FOR')],
    ['ending a Service Broker conversation', 'SELECT 1 AS n END CONVERSATION @handle', uses('END CONVERSATION')],
    ['UPDATE glued to an integer, ahead of SET', 'SELECT 1UPDATE tusers SET Fname = NULL', uses('UPDATE')],
    ['UPDATE glued to a binary literal', 'SELECT 0xUPDATE tusers SET Fname = NULL', uses('UPDATE')],
    ['INSERT glued to a float exponent', 'SELECT 1EINSERT tusers VALUES (1)', uses('INSERT')],
    ['DELETE glued to a money literal', 'SELECT $1DELETE FROM tusers', uses('DELETE')],
  ])('refuses %s', (_label, sql, message) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlyViolation);
    expect(() => assertReadOnlySql(sql)).toThrow(message);
  });

  it.each(WRITE_KEYWORDS)('refuses the keyword %s after SELECT, in any case, naming it upper-cased', (keyword) => {
    expect(() => assertReadOnlySql(`SELECT 1 AS n ${keyword.toLowerCase()} x`)).toThrow(uses(keyword));
  });

  // SQL Server reads `1DELETE` as the number 1 followed by a DELETE statement.
  it.each([
    'SELECT 1DELETE FROM tusers',
    'SELECT 1UPDATE tusers SET Fname = NULL',
    'SELECT 1.5INSERT tusers VALUES (1)',
  ])('refuses %j, a write keyword glued to a number', (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlyViolation);
  });

  it('raises an Error subclass named ReadOnlyViolation', () => {
    expect(new ReadOnlyViolation('x')).toBeInstanceOf(Error);
    expect(() => assertReadOnlySql('DROP TABLE tusers')).toThrow(
      expect.objectContaining({ name: 'ReadOnlyViolation' }),
    );
  });
});

describe('mssqlConfigFromEnv', () => {
  it('maps MURA_DB* settings, defaults the port to 1433 and trusts the local self-signed certificate', () => {
    expect(mssqlConfigFromEnv(ENV)).toEqual(CONFIG);
  });

  it.each<[string, string, number]>([
    ['a set port', '14330', 14330],
    ['an empty port', '', 1433],
    ['the lowest port', '1', 1],
    ['the highest port', '65535', 65535],
  ])('reads %s from MURA_DBPORT', (_label, value, port) => {
    expect(mssqlConfigFromEnv({ ...ENV, MURA_DBPORT: value }).port).toBe(port);
  });

  it.each(['abc', '1433.5', '0', '-1', '65536'])('refuses MURA_DBPORT=%j, naming the variable', (value) => {
    expect(() => mssqlConfigFromEnv({ ...ENV, MURA_DBPORT: value })).toThrow(
      `MURA_DBPORT is not a valid TCP port: ${value}`,
    );
  });

  it('takes opts.database in place of MURA_DATABASE, also when MURA_DATABASE is unset', () => {
    expect(mssqlConfigFromEnv(ENV, { database: 'muradb_snapshot' }).database).toBe('muradb_snapshot');
    expect(mssqlConfigFromEnv({ ...ENV, MURA_DATABASE: undefined }, { database: 'muradb_snapshot' })).toEqual({
      ...CONFIG,
      database: 'muradb_snapshot',
    });
  });

  it.each<[string, EnvLike, string]>([
    ['host unset', { ...ENV, MURA_DBHOST: undefined }, 'MURA_DBHOST'],
    ['database empty', { ...ENV, MURA_DATABASE: '' }, 'MURA_DATABASE'],
    ['user empty', { ...ENV, MURA_DBUSERNAME: '' }, 'MURA_DBUSERNAME'],
    ['password unset', { ...ENV, MURA_DBPASSWORD: undefined }, 'MURA_DBPASSWORD'],
    ['host and password empty', { ...ENV, MURA_DBHOST: '', MURA_DBPASSWORD: '' }, 'MURA_DBHOST, MURA_DBPASSWORD'],
    ['everything unset', {}, 'MURA_DBHOST, MURA_DATABASE, MURA_DBUSERNAME, MURA_DBPASSWORD'],
  ])('lists the missing settings by name only (%s)', (_label, env, names) => {
    let message = '';
    try {
      mssqlConfigFromEnv(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`SQL Server connection settings missing: ${names}`);
    for (const value of Object.values(env)) {
      if (value) expect(message).not.toContain(value);
    }
  });
});

describe('createReadOnlyMssql', () => {
  it('connects one pool built from the environment before any query', async () => {
    const fake = fakeDriver();
    await createReadOnlyMssql(ENV, { driver: fake.driver });
    expect(fake.configs).toEqual([CONFIG]);
    expect(fake.log).toEqual(['connect']);
  });

  it('builds the pool for deps.database in place of MURA_DATABASE', async () => {
    const fake = fakeDriver();
    await createReadOnlyMssql(ENV, { driver: fake.driver, database: 'muradb_snapshot' });
    expect(fake.configs).toEqual([{ ...CONFIG, database: 'muradb_snapshot' }]);
  });

  it('rejects on missing settings without constructing a pool', async () => {
    const fake = fakeDriver();
    await expect(createReadOnlyMssql({}, { driver: fake.driver })).rejects.toThrow(
      'SQL Server connection settings missing',
    );
    expect(fake.configs).toEqual([]);
  });

  it('rejects with the driver error when the pool cannot connect', async () => {
    const refused = new Error('connect ECONNREFUSED');
    const fake = fakeDriver([], refused);
    await expect(createReadOnlyMssql(ENV, { driver: fake.driver })).rejects.toBe(refused);
  });

  it('binds each parameter by name, runs the statement and returns its recordset', async () => {
    const rows = [{ UserID: 'u-1', SiteID: 'default' }];
    const fake = fakeDriver(rows);
    const client = await createReadOnlyMssql(ENV, { driver: fake.driver });
    const sql = 'SELECT UserID, SiteID FROM tusers WHERE SiteID = @siteID AND Type = @_type2';
    await expect(client.readOnlyQuery(sql, { siteID: 'default', _type2: 2 })).resolves.toEqual(rows);
    expect(fake.log).toEqual(['connect', 'request', 'input siteID="default"', 'input _type2=2', `query ${sql}`]);
  });

  it('runs a statement without parameters and reuses the one connected pool', async () => {
    const fake = fakeDriver([{ n: 0 }]);
    const client = await createReadOnlyMssql(ENV, { driver: fake.driver });
    await client.readOnlyQuery('SELECT COUNT(*) AS n FROM sys.procedures');
    await client.readOnlyQuery('SELECT COUNT(*) AS n FROM sys.triggers');
    expect(fake.configs).toHaveLength(1);
    expect(fake.log).toEqual([
      'connect',
      'request',
      'query SELECT COUNT(*) AS n FROM sys.procedures',
      'request',
      'query SELECT COUNT(*) AS n FROM sys.triggers',
    ]);
  });

  it('refuses a write before creating a request', async () => {
    const fake = fakeDriver();
    const client = await createReadOnlyMssql(ENV, { driver: fake.driver });
    await expect(client.readOnlyQuery('DELETE FROM tusers WHERE UserID = @id', { id: 'u-1' })).rejects.toThrow(
      ReadOnlyViolation,
    );
    expect(fake.log).toEqual(['connect']);
  });

  it.each(['id; DROP TABLE tusers --', '1id', 'site-id', 'site id', '@id', '', 'siteé'])(
    'refuses the parameter name %j before creating a request',
    async (name) => {
      const fake = fakeDriver();
      const client = await createReadOnlyMssql(ENV, { driver: fake.driver });
      const query = client.readOnlyQuery('SELECT 1 WHERE @ok = 1', { ok: 1, [name]: 2 });
      await expect(query).rejects.toThrow(ReadOnlyViolation);
      await expect(query).rejects.toThrow(`invalid SQL parameter name: ${JSON.stringify(name)}`);
      expect(fake.log).toEqual(['connect']);
    },
  );

  it('close() closes the pool', async () => {
    const fake = fakeDriver();
    const client = await createReadOnlyMssql(ENV, { driver: fake.driver });
    await expect(client.close()).resolves.toBeUndefined();
    expect(fake.log).toEqual(['connect', 'close']);
  });
});

describe('default mssql driver', () => {
  afterEach(() => {
    vi.doUnmock('node:module');
    vi.resetModules();
  });

  it('loads the mssql package relative to the module and connects the pool it builds', async () => {
    const fake = fakeDriver();
    const loads: { base: string; id: string }[] = [];
    vi.doMock('node:module', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:module')>();
      return {
        ...actual,
        createRequire: (base: string | URL) => (id: string) => {
          loads.push({ base: String(base), id });
          return fake.driver;
        },
      };
    });
    vi.resetModules();
    const fresh = await import('../../src/lib/mssql.js');
    await fresh.createReadOnlyMssql(ENV);
    expect(loads).toEqual([{ base: new URL('../../src/lib/mssql.ts', import.meta.url).href, id: 'mssql' }]);
    expect(fake.configs).toEqual([CONFIG]);
    expect(fake.log).toEqual(['connect']);
  });

  it('the installed mssql package fits MssqlDriver and takes the config without connecting', () => {
    const driver = createRequire(import.meta.url)('mssql') as MssqlDriver;
    const pool = new driver.ConnectionPool(CONFIG);
    expect(pool).toMatchObject({ connected: false, connecting: false, config: CONFIG });
    expect([typeof pool.connect, typeof pool.request, typeof pool.close]).toEqual(['function', 'function', 'function']);
  });
});
