// Unit tests for the SQL Server connection port, using fake pools in place of a server.
import { EventEmitter, once } from 'node:events';

import { createLogger, serializeError, validateLogRecord } from '@opt2/platform/logging';
import sql from 'mssql';
import type { ConnectionPool, Transaction, config as MssqlConfig } from 'mssql';
import { describe, expect, it, vi } from 'vitest';

import { createLegacyDb, MASTER_DATABASE, quoteIdent, type LegacyDbEnv } from '../../src/legacy/legacy-db.js';

const FAKE_SECRET = 'fake-db-secret';

const env: LegacyDbEnv = {
  OPT2_ENV: 'local',
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
  rollbackError: Error | undefined;

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
    setImmediate(callback, this.rollbackError);
  }

  /** Accepts a request and never completes it, so the transaction keeps a request in progress. */
  execSql(): void {
    this.calls.push('execSql');
    this.emit('execSql');
  }
}

interface FakePool {
  config: MssqlConfig;
  connection: FakeConnection;
  closed: number;
  /** The pool object handed out, an EventEmitter as the driver's pool is. */
  emitter: EventEmitter;
  /** Its 'error' listener count when connect() was called. */
  errorListenersAtConnect?: number;
}

/** Pool factory recording every config, with a recording logger; `connectError(n)` decides, possibly later, whether the n-th pool's connect rejects. */
function fakePools(connectError: (index: number) => Error | undefined | Promise<Error | undefined> = () => undefined) {
  const created: FakePool[] = [];
  const logger = { error: vi.fn() };
  const createPool = (config: MssqlConfig): ConnectionPool => {
    const index = created.length;
    const emitter = new EventEmitter();
    const record: FakePool = { config, connection: new FakeConnection(), closed: 0, emitter };
    created.push(record);
    const pool = Object.assign(emitter, {
      connected: true,
      config,
      async connect() {
        record.errorListenersAtConnect = emitter.listenerCount('error');
        const error = await connectError(index);
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
    });
    return pool as unknown as ConnectionPool;
  };
  const pool = (index: number): FakePool => {
    const record = created[index];
    if (record === undefined) throw new Error(`no pool #${index}`);
    return record;
  };
  return { created, createPool, pool, logger };
}

describe('createLegacyDb pools', () => {
  it('shares one live pool between concurrent callers and opens other databases separately', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });

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

  it.each<[LegacyDbEnv['OPT2_ENV'], boolean | undefined, boolean]>([
    ['local', undefined, true],
    ['local', true, true],
    ['local', false, false],
    ['cloud', undefined, false],
    ['cloud', false, false],
    ['cloud', true, false],
  ])('with OPT2_ENV=%s and OPT2_MSSQL_TRUST_SERVER_CERT=%s sets trustServerCertificate=%s', async (mode, trust, expected) => {
    const fake = fakePools();
    const db = createLegacyDb(
      { ...env, OPT2_ENV: mode, OPT2_MSSQL_TRUST_SERVER_CERT: trust },
      { createPool: fake.createPool, logger: fake.logger },
    );
    await db.live();
    await db.database('snapshot_x');
    expect(fake.created.map((p) => p.config.options?.trustServerCertificate)).toEqual([expected, expected]);
  });

  it('evicts a rejected connect, so the next call opens a new pool', async () => {
    const refused = new Error('ESOCKET');
    const fake = fakePools((index) => (index === 0 ? refused : undefined));
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });

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
      logger: fake.logger,
    });

    await expect(db.live()).rejects.toThrow('invalid config');
    await expect(db.live()).resolves.toBeDefined();
  });

  it('close() closes every connected pool, skips failed ones and forgets them all', async () => {
    const fake = fakePools((index) => (index === 2 ? new Error('ELOGIN') : undefined));
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    await db.live();
    await db.database(MASTER_DATABASE);
    await expect(db.database('muradb_opt2_snap_1')).rejects.toThrow('ELOGIN');

    await db.close();
    expect(fake.created.map((p) => p.closed)).toEqual([1, 1, 0]);

    await db.live();
    expect(fake.created).toHaveLength(4);
  });
});

describe('createLegacyDb pool errors', () => {
  it('listens for pool errors before connecting each pool', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    await db.live();
    await db.database(MASTER_DATABASE);

    expect(fake.created.map((p) => p.errorListenersAtConnect)).toEqual([1, 1]);
  });

  it('logs an error emitted on a connected pool once, naming its database and server, and keeps the cached pools', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    const live = await db.live();
    const master = await db.database(MASTER_DATABASE);
    const createFailed = new sql.ConnectionError('Failed to connect to legacy-db.invalid:1433 in 15000ms', 'ETIMEOUT');

    expect(() => fake.pool(1).emitter.emit('error', createFailed)).not.toThrow();

    expect(fake.logger.error).toHaveBeenCalledExactlyOnceWith(
      { error: serializeError(createFailed) },
      'SQL Server pool error on database master at legacy-db.invalid:1433',
    );
    expect(await db.live()).toBe(live);
    expect(await db.database(MASTER_DATABASE)).toBe(master);
    expect(fake.created).toHaveLength(2);
  });

  it('survives an error emitted while connecting and still evicts the pool when its connect then rejects', async () => {
    let failConnect: (error: Error) => void = () => undefined;
    const pending = new Promise<Error>((resolve) => {
      failConnect = resolve;
    });
    const fake = fakePools((index) => (index === 0 ? pending : undefined));
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    const timedOut = new sql.ConnectionError('Failed to connect to legacy-db.invalid:1433 in 15000ms', 'ETIMEOUT');

    const first = db.live();
    expect(() => fake.pool(0).emitter.emit('error', timedOut)).not.toThrow();
    failConnect(timedOut);

    await expect(first).rejects.toBe(timedOut);
    expect(fake.logger.error).toHaveBeenCalledExactlyOnceWith(
      { error: serializeError(timedOut) },
      'SQL Server pool error on database muradb at legacy-db.invalid:1433',
    );
    expect(await db.live()).toBe(fake.pool(1).emitter);
    expect(fake.created).toHaveLength(2);
  });

  it('writes one log-record.v1 line through the platform logger that carries no password', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'migration',
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => void lines.push(line) },
    });
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger });
    await db.live();

    fake.pool(0).emitter.emit('error', new sql.ConnectionError(`Login failed: password=${FAKE_SECRET}`, 'ELOGIN'));

    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0] ?? '');
    expect(validateLogRecord(record)).toEqual({ valid: true, errors: [] });
    expect(record).toMatchObject({
      severity: 'ERROR',
      message: 'SQL Server pool error on database muradb at legacy-db.invalid:1433',
      error: { type: 'ConnectionError' },
    });
    expect(lines[0]).not.toContain(FAKE_SECRET);
  });

  it("keeps the driver's own pool from throwing on an emitted error and logs the driver's acquire failure", async () => {
    const logger = { error: vi.fn() };
    const db = createLegacyDb(env, {
      // A real driver pool whose connect is stubbed, so no server is contacted and its connection pool never opens.
      createPool: (config) => {
        const pool = new sql.ConnectionPool(config);
        pool.connect = async () => pool;
        return pool;
      },
      logger,
    });
    const pool = await db.live();
    expect(pool).toBeInstanceOf(sql.ConnectionPool);

    expect(() => pool.emit('error', new sql.ConnectionError('Connection lost', 'EDRIVER'))).not.toThrow();
    const acquire = (pool as unknown as { acquire(requester: unknown): Promise<unknown> }).acquire(pool);
    await expect(acquire).rejects.toMatchObject({ code: 'ENOTOPEN' });

    expect(logger.error.mock.calls.map(([fields]: unknown[]) => (fields as { error: { type: string } }).error.type)).toEqual([
      'ConnectionError',
      'ConnectionError',
    ]);
    expect(logger.error.mock.calls.map(([, message]: unknown[]) => message)).toEqual([
      'SQL Server pool error on database muradb at legacy-db.invalid:1433',
      'SQL Server pool error on database muradb at legacy-db.invalid:1433',
    ]);
  });
});

describe('createLegacyDb transaction', () => {
  it('commits and returns the result, on the named database', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });

    await expect(db.transaction(async () => 42, { database: 'muradb_opt2_snap_2' })).resolves.toBe(42);
    expect(fake.pool(0).config.database).toBe('muradb_opt2_snap_2');
    expect(fake.pool(0).connection.calls).toEqual(['begin', 'commit']);
  });

  it('runs on the live database by default, rolls back and rethrows the original error', async () => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
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
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
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
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    await db.live();
    const commitFailure = new Error('commit failed');
    fake.pool(0).connection.commitError = commitFailure;

    await expect(db.transaction(async () => 1)).rejects.toMatchObject({ originalError: commitFailure });
    expect(fake.pool(0).connection.calls).toEqual(['begin', 'commit']);
  });

  const rollbackFailure = new Error('connection reset during rollback');

  it.each([
    {
      cause: 'the server rejects the rollback',
      during: async (_tx: Transaction, connection: FakeConnection) => {
        connection.rollbackError = rollbackFailure;
      },
      rollbackError: { originalError: rollbackFailure },
      calls: ['begin', 'rollback'],
    },
    {
      cause: 'a request is still in progress',
      during: async (tx: Transaction, connection: FakeConnection) => {
        const sent = once(connection, 'execSql');
        void tx.request().query('SELECT 1');
        await sent;
      },
      rollbackError: { code: 'EREQINPROG' },
      calls: ['begin', 'execSql'],
    },
  ])('reports the original error with the rollback failure when $cause', async ({ during, rollbackError, calls }) => {
    const fake = fakePools();
    const db = createLegacyDb(env, { createPool: fake.createPool, logger: fake.logger });
    const failure = new Error('apply failed');

    const error: unknown = await db
      .transaction(async (tx) => {
        await during(tx, fake.pool(0).connection);
        throw failure;
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('Transaction failed and its rollback failed');
    const [original, rollback, ...rest] = (error as AggregateError).errors;
    expect(original).toBe(failure);
    expect(rollback).toBeInstanceOf(sql.TransactionError);
    expect(rollback).toMatchObject(rollbackError);
    expect(rest).toEqual([]);
    expect(fake.pool(0).connection.calls).toEqual(calls);
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
