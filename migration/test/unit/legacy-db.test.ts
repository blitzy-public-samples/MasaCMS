// Unit tests for the SQL Server connection port, using fake pools in place of a server.
import { EventEmitter } from 'node:events';

import type { ConnectionPool, config as MssqlConfig } from 'mssql';
import { describe, expect, it } from 'vitest';

import { createLegacyDb, MASTER_DATABASE, quoteIdent, type LegacyDbEnv } from '../../src/legacy/legacy-db.js';

const FAKE_SECRET = 'fake-db-secret';

const env: LegacyDbEnv = {
  MURA_DBHOST: 'legacy-db.invalid',
  MURA_DBPORT: 1433,
  MURA_DATABASE: 'muradb',
  MURA_DBUSERNAME: 'masa',
  MURA_DBPASSWORD: FAKE_SECRET,
  OPT2_MSSQL_TRUST_SERVER_CERT: true,
};

/** Tedious connection surface that `mssql`'s Transaction drives. */
class FakeConnection extends EventEmitter {
  readonly calls: string[] = [];
  commitError: Error | undefined;

  beginTransaction(callback: (err?: Error) => void): void {
    this.calls.push('begin');
    setImmediate(callback);
  }

  commitTransaction(callback: (err?: Error) => void): void {
    this.calls.push('commit');
    setImmediate(callback, this.commitError);
  }

  rollbackTransaction(callback: (err?: Error) => void): void {
    this.calls.push('rollback');
    setImmediate(callback);
  }
}

interface FakePool {
  config: MssqlConfig;
  connection: FakeConnection;
  closed: number;
}

/** Pool factory recording every config; `connectError(n)` decides whether the n-th pool's connect rejects. */
function fakePools(connectError: (index: number) => Error | undefined = () => undefined) {
  const created: FakePool[] = [];
  const createPool = (config: MssqlConfig): ConnectionPool => {
    const index = created.length;
    const record: FakePool = { config, connection: new FakeConnection(), closed: 0 };
    created.push(record);
    const pool = {
      connected: true,
      config,
      async connect() {
        const error = connectError(index);
        if (error !== undefined) throw error;
        return pool;
      },
      async close() {
        record.closed += 1;
      },
      acquire(_request: unknown, callback: (err: Error | null, connection: FakeConnection, cfg: MssqlConfig) => void) {
        setImmediate(callback, null, record.connection, config);
      },
      release() {},
    };
    return pool as unknown as ConnectionPool;
  };
  const pool = (index: number): FakePool => {
    const record = created[index];
    if (record === undefined) throw new Error(`no pool #${index}`);
    return record;
  };
  return { created, createPool, pool };
}

describe('createLegacyDb pools', () => {
  it('shares one live pool between concurrent callers and opens other databases separately', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool });

    const [first, second] = await Promise.all([db.live(), db.live()]);
    expect(first).toBe(second);
    expect(fake.created.map((p) => p.config)).toEqual([
      {
        server: 'legacy-db.invalid',
        port: 1433,
        database: 'muradb',
        user: 'masa',
        password: FAKE_SECRET,
        options: { useUTC: false, encrypt: true, trustServerCertificate: true },
      },
    ]);

    const master = await db.database(MASTER_DATABASE);
    expect(master).not.toBe(first);
    expect(fake.pool(1).config.database).toBe('master');
    expect(await db.database('muradb')).toBe(first);
    expect(fake.created).toHaveLength(2);
  });

  it.each([true, false])('sets trustServerCertificate=%s from the environment', async (trust) => {
    const fake = fakePools();
    await createLegacyDb({ ...env, OPT2_MSSQL_TRUST_SERVER_CERT: trust }, { createPool: fake.createPool }).live();
    expect(fake.pool(0).config.options?.trustServerCertificate).toBe(trust);
  });

  it('evicts a rejected connect, so the next call opens a new pool', async () => {
    const refused = new Error('ESOCKET');
    const fake = fakePools((index) => (index === 0 ? refused : undefined));
    const db = createLegacyDb(env, { createPool: fake.createPool });

    const outcomes = await Promise.allSettled([db.live(), db.live()]);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: refused },
      { status: 'rejected', reason: refused },
    ]);
    expect(fake.created).toHaveLength(1);

    await expect(db.live()).resolves.toBeDefined();
    expect(fake.created).toHaveLength(2);
  });

  it('returns a rejected promise, then a fresh pool, when the pool constructor throws', async () => {
    const fake = fakePools();
    let calls = 0;
    const db = createLegacyDb(env, {
      createPool: (config) => {
        calls += 1;
        if (calls === 1) throw new TypeError('invalid config');
        return fake.createPool(config);
      },
    });

    await expect(db.live()).rejects.toThrow('invalid config');
    await expect(db.live()).resolves.toBeDefined();
  });

  it('close() closes every connected pool, skips failed ones and forgets them all', async () => {
    const fake = fakePools((index) => (index === 2 ? new Error('ELOGIN') : undefined));
    const db = createLegacyDb(env, { createPool: fake.createPool });
    await db.live();
    await db.database(MASTER_DATABASE);
    await expect(db.database('muradb_opt2_snap_1')).rejects.toThrow('ELOGIN');

    await db.close();
    expect(fake.created.map((p) => p.closed)).toEqual([1, 1, 0]);

    await db.live();
    expect(fake.created).toHaveLength(4);
  });
});

describe('createLegacyDb transaction', () => {
  it('commits and returns the result, on the named database', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool });

    await expect(db.transaction(async () => 42, { database: 'muradb_opt2_snap_2' })).resolves.toBe(42);
    expect(fake.pool(0).config.database).toBe('muradb_opt2_snap_2');
    expect(fake.pool(0).connection.calls).toEqual(['begin', 'commit']);
  });

  it('runs on the live database by default, rolls back and rethrows the original error', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool });
    const failure = new Error('apply failed');

    await expect(
      db.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fake.pool(0).config.database).toBe('muradb');
    expect(fake.pool(0).connection.calls).toEqual(['begin', 'rollback']);
  });

  it('rethrows the original error when the server already aborted the transaction', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool });
    const failure = new Error('deadlock victim');

    await expect(
      db.transaction(async () => {
        fake.pool(0).connection.emit('rollbackTransaction');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(fake.pool(0).connection.calls).toEqual(['begin']);
  });

  it('rethrows a commit failure', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool });
    await db.live();
    const commitFailure = new Error('commit failed');
    fake.pool(0).connection.commitError = commitFailure;

    await expect(db.transaction(async () => 1)).rejects.toMatchObject({ originalError: commitFailure });
    expect(fake.pool(0).connection.calls).toEqual(['begin', 'commit']);
  });
});

describe('quoteIdent', () => {
  it.each([
    ['tcontent', '[tcontent]'],
    ['a]b', '[a]]b]'],
    ['x]]y', '[x]]]]y]'],
    ['Program_1', '[Program_1]'],
    ['muradb_opt2_snap_3', '[muradb_opt2_snap_3]'],
    ['name [with] brackets', '[name [with]] brackets]'],
  ])('quotes %j as %j', (name, quoted) => {
    expect(quoteIdent(name)).toBe(quoted);
  });

  it.each(['', 'a\u0000b'])('rejects %j with a TypeError', (name) => {
    expect(() => quoteIdent(name)).toThrow(TypeError);
  });
});
