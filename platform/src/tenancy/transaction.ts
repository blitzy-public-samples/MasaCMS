import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { assertTenantId } from './tenant-id.js';

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

// Declared here rather than imported from metadata.ts, which declares the same shape, so this file
// compiles without metadata.ts and the tenancy modules keep metadata.ts -> transaction.ts as their only edge.
/** A transaction over non-tenant tables only; its `app.tenant_id` is empty. */
export interface MetadataTx extends TxBase {
  readonly kind: 'metadata';
}

/** The only database handle repositories receive; it deliberately has no raw `query`. */
export interface TenantDb {
  /** Service schema that qualifies `<schema>.tenant_registry` and `<schema>.tenant_grant`. */
  readonly schema: string;
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  withMetadata<T>(fn: (tx: MetadataTx) => Promise<T>): Promise<T>;
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

const SET_TENANT_SQL = "SELECT set_config('app.tenant_id', $1, true)";
const WARNING_CODE = 'OPT2_TENANCY';

const als = new AsyncLocalStorage<TenantTx | MetadataTx>();
const openTransactions = new WeakSet<TenantTx | MetadataTx>();

interface PendingCallback {
  cb: CommitCallback;
  onError: CommitErrorHandler | undefined;
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
 */
export async function runTransaction<X extends TenantTx | MetadataTx, T>(
  pool: Pool,
  opts: TransactionRunnerOptions,
  tenantSetting: string,
  build: (base: TxBase) => X,
  fn: (tx: X) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
    await client.query('COMMIT');
  } catch (err) {
    close();
    await rollbackAndRelease(client);
    throw err;
  }
  client.release();
  // Callbacks run with no transaction in scope, so a withTenant they open starts its own scope and connection.
  await als.exit(() => runCommitCallbacks(callbacks, opts.onError));
  return result;
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

async function rollbackAndRelease(client: PoolClient): Promise<void> {
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

// The write has committed, so neither a callback nor its handler may fail the caller; a failing handler becomes a process warning.
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

function warn(err: unknown): void {
  const error = toError(err);
  process.emitWarning(`Commit callback error handler failed: ${error.message}`, { code: WARNING_CODE, detail: error.stack });
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
