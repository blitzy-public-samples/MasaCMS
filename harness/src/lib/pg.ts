import pg from 'pg';
import type { ClientConfig, QueryConfig } from 'pg';
import type { EnvLike } from './paths.js';

/** Connection surface the catalog client drives; `pg.Client` satisfies it. */
export interface QueryableClient {
  query(config: QueryConfig): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
  /** Subscribes to connection failures reported outside a query's own result. */
  on?(event: 'error', listener: (error: Error) => void): unknown;
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

const CONNECT_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;
// Longer than STATEMENT_TIMEOUT_MS so the server's own cancellation normally fires first.
const STEP_DEADLINE_MS = 35_000;
const END_DEADLINE_MS = 5_000;
// SQLSTATEs of a statement the server cancelled: statement_timeout (57014) and lock_timeout (55P03).
const SERVER_TIMEOUT_CODES: ReadonlySet<unknown> = new Set(['57014', '55P03']);

type TransactionStep = 'BEGIN' | 'statement' | 'ROLLBACK';

/** Ends `client`, destroying its socket if the server has not closed it within END_DEADLINE_MS. */
async function endWithinDeadline(client: pg.Client): Promise<void> {
  const timer = setTimeout(() => client.connection.stream.destroy(), END_DEADLINE_MS);
  try {
    await client.end();
  } finally {
    clearTimeout(timer);
  }
}

const defaultConnect: CatalogConnect = async (config) => {
  const client = new pg.Client(config);
  await client.connect();
  return {
    query: (queryConfig) => client.query(queryConfig),
    end: () => endWithinDeadline(client),
    on: (event, listener) => client.on(event, listener),
  };
};

/** Connection settings of the bootstrap user `PG_USER`, with every transaction read-only by default and bounded connect, lock and statement waits; throws listing each missing or invalid variable. */
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
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
}

/** Connects once as `PG_USER` and returns a client whose queries run one at a time, each in its own read-only transaction; a step past its deadline, a statement the server cancels for its statement or lock timeout, a lost connection or a failed ROLLBACK closes the session for later queries. */
export async function createCatalogClient(
  env: EnvLike = process.env,
  deps: { connect?: CatalogConnect } = {},
): Promise<CatalogClient> {
  const client = await (deps.connect ?? defaultConnect)(pgCatalogConfigFromEnv(env));
  let tail: Promise<unknown> = Promise.resolve();
  let failure: { cause: unknown } | undefined;
  let ended: Promise<void> | undefined;

  client.on?.('error', (error) => {
    failure ??= { cause: error };
  });

  /** Marks the session failed for `cause` and ends its connection, both only the first time. */
  function discard(cause: unknown): void {
    failure ??= { cause };
    ended ??= client.end();
  }

  /** Sends one step of the transaction; past STEP_DEADLINE_MS it discards the session and rejects. */
  function send(step: TransactionStep, config: QueryConfig): Promise<{ rows: unknown[] }> {
    const sent = client.query(config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `PostgreSQL catalog ${step} did not finish within ${STEP_DEADLINE_MS} ms; the catalog session is closed`,
        );
        discard(error);
        reject(error);
      }, STEP_DEADLINE_MS);
    });
    // The race also observes `sent`, so its rejection after the connection is discarded is handled.
    return Promise.race([sent, expired]).finally(() => clearTimeout(timer));
  }

  async function runReadOnly<T>(sql: string, params: readonly unknown[] | undefined): Promise<T[]> {
    if (failure) {
      throw new Error('PostgreSQL catalog session is closed after an earlier failure', { cause: failure.cause });
    }
    await send('BEGIN', { text: 'BEGIN TRANSACTION READ ONLY' });
    const statement: ExtendedQueryConfig = { text: sql, values: [...(params ?? [])], queryMode: 'extended' };
    const outcome = await send('statement', statement).then(
      (result) => ({ ok: true as const, rows: result.rows as T[] }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!outcome.ok && SERVER_TIMEOUT_CODES.has((outcome.error as { code?: unknown } | null | undefined)?.code)) {
      discard(outcome.error);
    }
    // A statement that failed with the session (deadline, server timeout or lost connection) leaves nothing to roll back.
    if (!outcome.ok && failure) throw outcome.error;
    try {
      await send('ROLLBACK', { text: 'ROLLBACK' });
    } catch (rollbackError) {
      discard(rollbackError);
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, rollbackError],
          'PostgreSQL catalog query and its ROLLBACK failed; the catalog session is closed',
        );
      }
      throw new Error('PostgreSQL catalog ROLLBACK failed; the catalog session is closed', { cause: rollbackError });
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.rows;
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
      ended ??= client.end();
      await ended;
    },
  };
}
