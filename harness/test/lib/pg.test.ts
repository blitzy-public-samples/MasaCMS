import type { ClientConfig, QueryConfig } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { EnvLike } from '../../src/lib/paths.js';
import {
  createCatalogClient,
  pgCatalogConfigFromEnv,
  type CatalogConnect,
  type QueryableClient,
} from '../../src/lib/pg.js';

/** Stand-in for `pg.Client` that opens no socket; records each instance's config and calls. */
const pgDouble = vi.hoisted(() => {
  const clients: { config: unknown; log: unknown[] }[] = [];
  class Client {
    private readonly entry: { config: unknown; log: unknown[] };
    constructor(config: unknown) {
      this.entry = { config, log: [] };
      clients.push(this.entry);
    }
    async connect(): Promise<void> {
      this.entry.log.push('connect');
    }
    async query(config: unknown): Promise<{ rows: unknown[] }> {
      this.entry.log.push(config);
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.entry.log.push('end');
    }
  }
  return { clients, Client };
});

vi.mock('pg', () => ({ default: { Client: pgDouble.Client } }));

// Placeholder settings only; every connection is a fake, so nothing reaches PostgreSQL.
const ENV: EnvLike = {
  PG_HOST: 'catalog.invalid',
  PG_PORT: '6543',
  PG_USER: 'fixture_user',
  PG_PASSWORD: 'fixture-pw',
  PG_DATABASE: 'fixture_db',
};

const SETTINGS_ERROR = 'PostgreSQL catalog client settings missing or invalid: ';
const BEGIN: QueryConfig = { text: 'BEGIN TRANSACTION READ ONLY' };
const ROLLBACK: QueryConfig = { text: 'ROLLBACK' };

type Answer = (config: QueryConfig) => Promise<{ rows: unknown[] }>;

/** ENV with `overrides` applied; an `undefined` override removes the variable. */
function envWith(overrides: EnvLike): EnvLike {
  const env: EnvLike = { ...ENV, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

/** Query config the client sends for the caller's statement. */
function statement(text: string, values: unknown[] = []): QueryConfig & { queryMode: 'extended' } {
  return { text, values, queryMode: 'extended' };
}

/** Fake connection answering every query with `answer`; logs each query config and `end` in call order. */
function fakeConnection(answer: Answer = async () => ({ rows: [] })): {
  connect: CatalogConnect;
  configs: ClientConfig[];
  log: (QueryConfig | 'end')[];
} {
  const configs: ClientConfig[] = [];
  const log: (QueryConfig | 'end')[] = [];
  const client: QueryableClient = {
    async query(config) {
      log.push(config);
      return answer(config);
    },
    async end() {
      log.push('end');
    },
  };
  const connect: CatalogConnect = async (config) => {
    configs.push(config);
    return client;
  };
  return { connect, configs, log };
}

/** Answer giving `rows` for the caller's statement and none for BEGIN or ROLLBACK. */
function statementRows(rows: unknown[]): Answer {
  return async (config) => ({ rows: config.text === BEGIN.text || config.text === ROLLBACK.text ? [] : rows });
}

/** Promise resolved from outside, holding a query in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves once every pending microtask has run. */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('pgCatalogConfigFromEnv', () => {
  it('maps the PG_* variables to a read-only connection config for PG_USER', () => {
    expect(pgCatalogConfigFromEnv(ENV)).toEqual({
      host: 'catalog.invalid',
      port: 6543,
      user: 'fixture_user',
      password: 'fixture-pw',
      database: 'fixture_db',
      application_name: 'opt2-harness-catalog',
      options: '-c default_transaction_read_only=on',
    });
  });

  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
  ])('defaults PG_PORT to 5432 when it is %s', (_label, value) => {
    expect(pgCatalogConfigFromEnv(envWith({ PG_PORT: value })).port).toBe(5432);
  });

  it('does not require PG_PASSWORD', () => {
    expect(pgCatalogConfigFromEnv(envWith({ PG_PASSWORD: undefined })).password).toBeUndefined();
  });

  it.each<[string, EnvLike, string]>([
    ['PG_HOST is unset', { PG_HOST: undefined }, 'PG_HOST'],
    ['PG_USER is empty', { PG_USER: '' }, 'PG_USER'],
    ['PG_DATABASE is unset', { PG_DATABASE: undefined }, 'PG_DATABASE'],
    ['all required variables are missing', { PG_HOST: '', PG_USER: undefined, PG_DATABASE: '' }, 'PG_HOST, PG_USER, PG_DATABASE'],
    ['PG_PORT is not numeric', { PG_PORT: 'abc' }, 'PG_PORT (not a port number: abc)'],
    ['PG_PORT is 0', { PG_PORT: '0' }, 'PG_PORT (not a port number: 0)'],
    ['PG_PORT is above 65535', { PG_PORT: '65536' }, 'PG_PORT (not a port number: 65536)'],
    ['PG_PORT is not an integer', { PG_PORT: '54.32' }, 'PG_PORT (not a port number: 54.32)'],
    ['a variable is missing and PG_PORT is invalid', { PG_DATABASE: '', PG_PORT: 'abc' }, 'PG_DATABASE, PG_PORT (not a port number: abc)'],
  ])('throws one Error naming each problem when %s', (_label, overrides, problems) => {
    expect(() => pgCatalogConfigFromEnv(envWith(overrides))).toThrow(new Error(`${SETTINGS_ERROR}${problems}`));
  });
});

describe('createCatalogClient', () => {
  it('connects once, before any query, with the config derived from env', async () => {
    const fake = fakeConnection();
    await createCatalogClient(ENV, { connect: fake.connect });
    expect(fake.configs).toEqual([pgCatalogConfigFromEnv(ENV)]);
    expect(fake.log).toEqual([]);
  });

  it('without an injected connect, connects a pg.Client built from the env config and queries through it', async () => {
    const catalog = await createCatalogClient(ENV);
    expect(pgDouble.clients).toEqual([{ config: pgCatalogConfigFromEnv(ENV), log: ['connect'] }]);
    await catalog.query('SELECT 1');
    await catalog.close();
    expect(pgDouble.clients[0]?.log).toEqual(['connect', BEGIN, statement('SELECT 1'), ROLLBACK, 'end']);
  });

  it('rejects with the settings error without connecting', async () => {
    const fake = fakeConnection();
    await expect(createCatalogClient(envWith({ PG_HOST: '' }), { connect: fake.connect })).rejects.toThrow(
      new Error(`${SETTINGS_ERROR}PG_HOST`),
    );
    expect(fake.configs).toEqual([]);
  });

  it('rejects with the error the connection attempt raises', async () => {
    const refused = new Error('connection refused');
    const connect: CatalogConnect = async () => {
      throw refused;
    };
    await expect(createCatalogClient(ENV, { connect })).rejects.toBe(refused);
  });

  it.each<[string, readonly unknown[] | undefined, unknown[]]>([
    ['with params', ['fixture_user'], ['fixture_user']],
    ['without params', undefined, []],
  ])('runs a query %s as the only statement of a read-only transaction that is rolled back', async (_label, params, values) => {
    const rows = [{ rolname: 'fixture_user' }];
    const fake = fakeConnection(statementRows(rows));
    const catalog = await createCatalogClient(ENV, { connect: fake.connect });
    const sql = 'SELECT rolname FROM pg_roles WHERE rolname = $1';
    await expect(catalog.query(sql, params)).resolves.toEqual(rows);
    expect(fake.log).toEqual([BEGIN, statement(sql, values), ROLLBACK]);
  });

  it.each<[string, string, QueryConfig[]]>([
    ['BEGIN', BEGIN.text, [BEGIN]],
    ['statement', 'SELECT 1', [BEGIN, statement('SELECT 1'), ROLLBACK]],
    ['ROLLBACK', ROLLBACK.text, [BEGIN, statement('SELECT 1'), ROLLBACK]],
  ])('rejects only the query whose %s fails; the query queued behind it still runs', async (_step, failingText, failedLog) => {
    const failure = new Error(`${failingText} failed`);
    let failed = false;
    const fake = fakeConnection(async (config) => {
      if (!failed && config.text === failingText) {
        failed = true;
        throw failure;
      }
      return { rows: config.text === 'SELECT 2' ? [{ n: 2 }] : [] };
    });
    const catalog = await createCatalogClient(ENV, { connect: fake.connect });
    const first = catalog.query('SELECT 1');
    const second = catalog.query('SELECT 2');
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toEqual([{ n: 2 }]);
    expect(fake.log).toEqual([...failedLog, BEGIN, statement('SELECT 2'), ROLLBACK]);
  });

  it('runs queries one at a time in call order, each caller receiving its own rows', async () => {
    const held = deferred<{ rows: unknown[] }>();
    const fake = fakeConnection(async (config) =>
      config.text === 'SELECT 1' ? held.promise : { rows: config.text === 'SELECT 2' ? [{ n: 2 }] : [] },
    );
    const catalog = await createCatalogClient(ENV, { connect: fake.connect });
    const first = catalog.query('SELECT 1');
    const second = catalog.query('SELECT 2');
    await settled();
    expect(fake.log).toEqual([BEGIN, statement('SELECT 1')]);
    held.resolve({ rows: [{ n: 1 }] });
    await expect(first).resolves.toEqual([{ n: 1 }]);
    await expect(second).resolves.toEqual([{ n: 2 }]);
    expect(fake.log).toEqual([BEGIN, statement('SELECT 1'), ROLLBACK, BEGIN, statement('SELECT 2'), ROLLBACK]);
  });

  it('close() ends the connection once, after every queued query has finished', async () => {
    const held = deferred<{ rows: unknown[] }>();
    const fake = fakeConnection(async (config) => (config.text === 'SELECT 1' ? held.promise : { rows: [] }));
    const catalog = await createCatalogClient(ENV, { connect: fake.connect });
    const queries = Promise.all([catalog.query('SELECT 1'), catalog.query('SELECT 2')]);
    const closed = catalog.close();
    await settled();
    expect(fake.log).toEqual([BEGIN, statement('SELECT 1')]);
    held.resolve({ rows: [] });
    await expect(closed).resolves.toBeUndefined();
    await queries;
    expect(fake.log).toEqual([BEGIN, statement('SELECT 1'), ROLLBACK, BEGIN, statement('SELECT 2'), ROLLBACK, 'end']);
  });

  it('close() still ends the connection after a query has failed', async () => {
    const failure = new Error('SELECT 1 failed');
    const fake = fakeConnection(async (config) => {
      if (config.text === 'SELECT 1') throw failure;
      return { rows: [] };
    });
    const catalog = await createCatalogClient(ENV, { connect: fake.connect });
    const failed = catalog.query('SELECT 1');
    await expect(catalog.close()).resolves.toBeUndefined();
    await expect(failed).rejects.toBe(failure);
    expect(fake.log).toEqual([BEGIN, statement('SELECT 1'), ROLLBACK, 'end']);
  });
});
