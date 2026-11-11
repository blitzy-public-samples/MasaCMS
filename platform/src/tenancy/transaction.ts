import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { untilAborted } from '../auth/deadline.js';
import { assertTenantId } from './tenant-id.js';
import { tenancyWarning } from './warning.js';

/** Runs parameterised SQL. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>>;
}

/** Work queued to run after a transaction commits. */
export type CommitCallback = () => void | Promise<void>;

/** Receives the error of a failed commit callback. */
export type CommitErrorHandler = (err: unknown) => void;

/** Members shared by every transaction handle. */
export interface TxBase extends Queryable {
  readonly schema: string;
  /** Queues `cb` to run after COMMIT, awaited in registration order; it never runs on rollback. */
  onCommit(cb: CommitCallback, onError?: CommitErrorHandler): void;
}

/** A transaction whose `app.tenant_id` is `tenantId`. */
export interface TenantTx extends TxBase {
  readonly kind: 'tenant';
  readonly tenantId: string;
}

// Mirrors metadata.ts's MetadataTx so metadata.ts -> transaction.ts stays the only import edge.
/** A transaction over non-tenant tables only; its `app.tenant_id` is empty. */
export interface MetadataTx extends TxBase {
  readonly kind: 'metadata';
}

/** Per-call settings of a transaction. */
export interface TransactionCallOptions {
  /** Aborting rejects with its reason: a pending checkout is dropped, and a held connection is destroyed instead of reused. */
  signal?: AbortSignal;
}

/** The only database handle repositories receive; it deliberately has no raw `query`. */
export interface TenantDb {
  /** Service schema that qualifies `<schema>.tenant_registry` and `<schema>.tenant_grant`. */
  readonly schema: string;
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  withMetadata<T>(fn: (tx: MetadataTx) => Promise<T>, options?: TransactionCallOptions): Promise<T>;
  end(): Promise<void>;
}

/** Settings of the internal transaction runner. */
export interface TransactionRunnerOptions {
  schema: string;
  /** Receives errors of commit callbacks registered without their own handler. */
  onError: CommitErrorHandler;
}

/** Raised when tenant-scoped work runs outside `withTenant`. */
export class OutsideTenantTransactionError extends Error {
  override readonly name = 'OutsideTenantTransactionError';

  constructor() {
    super('No tenant transaction is active in this async context; run the work inside withTenant');
  }
}

/** Raised when a statement or commit callback targets a transaction that has already finished. */
export class TransactionEndedError extends Error {
  override readonly name = 'TransactionEndedError';

  constructor() {
    super('The transaction has ended; statements and commit callbacks must be issued inside its callback');
  }
}

/** Raised when PostgreSQL answers COMMIT by rolling the transaction back. */
export class TransactionRolledBackError extends Error {
  override readonly name = 'TransactionRolledBackError';

  constructor() {
    super('PostgreSQL rolled the transaction back at COMMIT because a statement in it failed');
  }
}

const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";
const warn = tenancyWarning('Commit callback error handler failed: ');

const als = new AsyncLocalStorage<TenantTx | MetadataTx>();
const openTransactions = new WeakSet<TenantTx | MetadataTx>();

interface PendingCallback {
  cb: CommitCallback;
  onError: CommitErrorHandler | undefined;
}

/** The pooled connection a transaction runs on. */
interface Connection extends Queryable {
  release(err?: Error): void;
}

/** A connection checked out under an abort signal. */
interface Lease {
  /** Refuses statements and ignores releases once the lease has ended. */
  readonly client: Connection;
  /** Settles as `run` does; an abort while the connection is held runs `onAbort`, destroys the connection and rejects with the reason. */
  settle<T>(run: () => Promise<T>, onAbort: () => void): Promise<T>;
}

/** The transaction open in this async context, or undefined. */
export function currentTransaction(): TenantTx | MetadataTx | undefined {
  const tx = als.getStore();
  return tx !== undefined && openTransactions.has(tx) ? tx : undefined;
}

/** The tenant transaction open in this async context, or undefined. */
export function currentTenantTx(): TenantTx | undefined {
  const tx = currentTransaction();
  return tx?.kind === 'tenant' ? tx : undefined;
}

/** The open tenant transaction; throws OutsideTenantTransactionError when there is none. */
export function requireTenantTx(): TenantTx {
  const tx = currentTenantTx();
  if (tx === undefined) {
    throw new OutsideTenantTransactionError();
  }
  return tx;
}

/**
 * Runs `fn` in one transaction whose first statement sets `app.tenant_id` transaction-locally to `tenantSetting`.
 * Resolves after COMMIT and every commit callback; on failure rolls back, discards the callbacks and rethrows.
 * An abort of `signal` before the connection returns to the pool ends the transaction and rejects with the abort reason.
 */
export async function runTransaction<X extends TenantTx | MetadataTx, T>(
  pool: Pool,
  opts: TransactionRunnerOptions,
  tenantSetting: string,
  build: (base: TxBase) => X,
  fn: (tx: X) => Promise<T>,
  { signal }: TransactionCallOptions = {},
): Promise<T> {
  const lease = signal === undefined ? undefined : await leaseUntilAborted(pool, signal);
  const client: Connection = lease === undefined ? await pool.connect() : lease.client;
  const callbacks: PendingCallback[] = [];
  let open = true;
  let tx: X | undefined;
  const close = (): void => {
    open = false;
    if (tx !== undefined) {
      openTransactions.delete(tx);
    }
  };
  const base: TxBase = {
    schema: opts.schema,
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string | QueryConfig,
      values?: unknown[],
    ): Promise<QueryResult<R>> => (open ? client.query<R>(text, values) : Promise.reject(new TransactionEndedError())),
    onCommit: (cb: CommitCallback, onError?: CommitErrorHandler): void => {
      if (!open) {
        throw new TransactionEndedError();
      }
      callbacks.push({ cb, onError });
    },
  };

  const run = async (): Promise<T> => {
    let result: T;
    try {
      await client.query('BEGIN');
      await client.query(SET_TENANT_SQL, [tenantSetting]);
      const built = build(base);
      Object.freeze(built);
      tx = built;
      openTransactions.add(built);
      // Closed as soon as fn settles, so a stray statement can never reach the connection after COMMIT or release.
      try {
        result = await als.run(built, () => fn(built));
      } finally {
        close();
      }
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') {
        throw new TransactionRolledBackError();
      }
    } catch (err) {
      close();
      await rollbackAndRelease(client);
      throw err;
    }
    client.release();
    // Callbacks run with no transaction in scope, so a withTenant they open starts its own scope and connection.
    await als.exit(() => runCommitCallbacks(callbacks, opts.onError));
    return result;
  };

  if (lease === undefined) {
    return run();
  }
  return lease.settle(run, () => {
    close();
    callbacks.length = 0;
  });
}

/** Checks out a connection that `signal` can end: an abort drops a pending checkout and destroys a held connection once. */
async function leaseUntilAborted(pool: Pool, signal: AbortSignal): Promise<Lease> {
  const pooled = await checkout(pool, signal);
  let held = true;
  const client: Connection = {
    query: <R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult<R>> =>
      held ? pooled.query<R>(text, values) : Promise.reject(new TransactionEndedError()),
    release: (err?: Error): void => {
      if (held) {
        held = false;
        pooled.release(err);
      }
    },
  };
  const settle = <T>(run: () => Promise<T>, onAbort: () => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        if (!held) {
          return;
        }
        held = false;
        onAbort();
        // An errored release makes pg-pool drop the client and end its socket at once, so the slot never waits on the network.
        pooled.release(toError(signal.reason));
        reject(signal.reason as Error);
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      run()
        .finally(() => {
          signal.removeEventListener('abort', abort);
        })
        .then(resolve, reject);
    });
  return { client, settle };
}

/** `pool.connect()` that rejects with the abort reason as soon as `signal` aborts. */
async function checkout(pool: Pool, signal: AbortSignal): Promise<PoolClient> {
  signal.throwIfAborted();
  const pending = pool.connect();
  try {
    return await untilAborted(pending, signal);
  } catch (err) {
    if (signal.aborted) {
      // pg-pool 3 cannot withdraw a queued checkout, so the client it hands over later goes straight back unused.
      pending.then(
        (client) => {
          client.release();
        },
        () => undefined,
      );
    }
    throw err;
  }
}

/** Runs `fn` in a transaction scoped to `tenantId`; rejects with InvalidTenantIdError before connecting when it is not a UUID. */
export async function runTenantTransaction<T>(
  pool: Pool,
  opts: TransactionRunnerOptions,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const tid = assertTenantId(tenantId);
  return runTransaction(pool, opts, tid, (base): TenantTx => ({ ...base, kind: 'tenant', tenantId: tid }), fn);
}

/** Runs `fn` in a transaction whose RLS tenant is `tenantId`, which must come from verified claims, registry data or a stored grant. */
export function withTenant<T>(db: TenantDb, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.withTenant(tenantId, fn);
}

async function rollbackAndRelease(client: Connection): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    // A connection that cannot roll back may still hold the transaction, so pg must destroy it.
    client.release(toError(rollbackError));
    return;
  }
  client.release();
}

async function runCommitCallbacks(callbacks: readonly PendingCallback[], fallback: CommitErrorHandler): Promise<void> {
  for (const { cb, onError } of callbacks) {
    try {
      await cb();
    } catch (err) {
      report(onError ?? fallback, err);
    }
  }
}

// The write has committed, so neither a callback nor its handler may fail the caller; a failing handler becomes an OPT2_TENANCY diagnostic warning.
function report(handler: CommitErrorHandler, err: unknown): void {
  try {
    const outcome: unknown = handler(err);
    if (outcome instanceof Promise) {
      outcome.catch(warn);
    }
  } catch (handlerError) {
    warn(handlerError);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
