import pg from 'pg';
import type { ClientConfig, QueryConfig } from 'pg';
import type { EnvLike } from './paths.js';

/** Connection surface the catalog client drives; `pg.Client` satisfies it. */
export interface QueryableClient {
  query(config: QueryConfig): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** Opens the one connection a catalog client uses. */
export type CatalogConnect = (config: ClientConfig) => Promise<QueryableClient>;

/** Read-only catalog query client over one connection. */
export interface CatalogClient {
  /** Rows of `sql`, run with `params` as the only statement of a read-only transaction that is rolled back. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Ends the connection once queued queries have finished. */
  close(): Promise<void>;
}

// @types/pg omits `queryMode`, which pg honours: 'extended' forces Parse/Bind/Execute, so the text must be one statement.
type ExtendedQueryConfig = QueryConfig & { queryMode: 'extended' };

const REQUIRED_ENV = ['PG_HOST', 'PG_USER', 'PG_DATABASE'] as const;

const defaultConnect: CatalogConnect = async (config) => {
  const client = new pg.Client(config);
  await client.connect();
  return client;
};

/** Connection settings of the bootstrap user `PG_USER`, with every transaction read-only by default; throws listing each missing or invalid variable. */
export function pgCatalogConfigFromEnv(env: EnvLike = process.env): ClientConfig {
  // An empty PG_PORT means the default, like an unset one; a non-numeric one fails here, not at connect.
  const port = Number(env.PG_PORT || 5432);
  const problems: string[] = REQUIRED_ENV.filter((name) => !env[name]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PG_PORT (not a port number: ${env.PG_PORT})`);
  if (problems.length > 0) {
    throw new Error(`PostgreSQL catalog client settings missing or invalid: ${problems.join(', ')}`);
  }
  return {
    host: env.PG_HOST,
    port,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE,
    application_name: 'opt2-harness-catalog',
    options: '-c default_transaction_read_only=on',
  };
}

/** Connects once as `PG_USER` and returns a client whose queries run one at a time, each in its own read-only transaction. */
export async function createCatalogClient(
  env: EnvLike = process.env,
  deps: { connect?: CatalogConnect } = {},
): Promise<CatalogClient> {
  const client = await (deps.connect ?? defaultConnect)(pgCatalogConfigFromEnv(env));
  let tail: Promise<unknown> = Promise.resolve();

  async function runReadOnly<T>(sql: string, params: readonly unknown[] | undefined): Promise<T[]> {
    await client.query({ text: 'BEGIN TRANSACTION READ ONLY' });
    try {
      const statement: ExtendedQueryConfig = { text: sql, values: [...(params ?? [])], queryMode: 'extended' };
      const result = await client.query(statement);
      return result.rows as T[];
    } finally {
      await client.query({ text: 'ROLLBACK' });
    }
  }

  return {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const run = tail.then(() => runReadOnly<T>(sql, params));
      // The chain only orders calls; each caller still receives its own rejection from `run`.
      tail = run.catch(() => undefined);
      return run;
    },
    async close(): Promise<void> {
      await tail;
      await client.end();
    },
  };
}
