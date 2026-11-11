import sql from 'mssql';
import type { ConnectionPool, Transaction, config as MssqlConfig } from 'mssql';

import type { MigrationEnv } from '../env.js';

/** Settings the port connects with: the Masa datasource account, so unqualified Masa table names resolve as for Masa. */
export type LegacyDbEnv = Pick<
  MigrationEnv,
  'MURA_DBHOST' | 'MURA_DBPORT' | 'MURA_DATABASE' | 'MURA_DBUSERNAME' | 'MURA_DBPASSWORD' | 'OPT2_MSSQL_TRUST_SERVER_CERT'
>;

/** SQL Server connections to the live legacy database and its server's other databases; it executes nothing itself. */
export interface LegacyDb {
  /** Pool on the live legacy database `MURA_DATABASE`. */
  live(): Promise<ConnectionPool>;
  /** Pool on database `name` of the same server, such as a read-only snapshot or `master`; one shared pool per name. */
  database(name: string): Promise<ConnectionPool>;
  /**
   * Runs `fn` in one READ COMMITTED transaction on the live database or `options.database`; commits, or rolls back and rethrows.
   * A rollback failure other than an already-ended transaction is thrown with the original in an AggregateError.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: { database?: string }): Promise<T>;
  /** Closes every pool opened so far. */
  close(): Promise<void>;
}

/** The server's `master` database, used for backup and restore statements. */
export const MASTER_DATABASE = 'master';

/** Whether a rollback failed only because the transaction had already ended, by a server abort or a commit attempt. */
function isAlreadyEnded(error: unknown): boolean {
  return error instanceof sql.TransactionError && (error.code === 'EABORT' || error.code === 'ENOTBEGUN');
}

/** Creates the legacy database port; `options.createPool` replaces the driver's pool constructor, for example in tests. */
export function createLegacyDb(
  env: LegacyDbEnv,
  options: { createPool?: (config: MssqlConfig) => ConnectionPool } = {},
): LegacyDb {
  const createPool = options.createPool ?? ((config: MssqlConfig) => new sql.ConnectionPool(config));
  const pools = new Map<string, Promise<ConnectionPool>>();

  const poolConfig = (database: string): MssqlConfig => ({
    server: env.MURA_DBHOST,
    port: env.MURA_DBPORT,
    database,
    user: env.MURA_DBUSERNAME,
    password: env.MURA_DBPASSWORD,
    // useUTC stays false: legacy datetime values are wall-clock time in the legacy server zone, which is the process TZ.
    options: { useUTC: false, encrypt: true, trustServerCertificate: env.OPT2_MSSQL_TRUST_SERVER_CERT },
  });

  const database = (name: string): Promise<ConnectionPool> => {
    const cached = pools.get(name);
    if (cached !== undefined) return cached;
    const connecting = (async () => createPool(poolConfig(name)).connect())().catch((error: unknown) => {
      // A failed connect is forgotten, so the next call opens a fresh pool.
      if (pools.get(name) === connecting) pools.delete(name);
      throw error;
    });
    pools.set(name, connecting);
    return connecting;
  };

  return {
    live: () => database(env.MURA_DATABASE),
    database,
    async transaction<T>(fn: (tx: Transaction) => Promise<T>, txOptions: { database?: string } = {}): Promise<T> {
      const pool = await database(txOptions.database ?? env.MURA_DATABASE);
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch (rollbackError) {
          if (!isAlreadyEnded(rollbackError)) {
            throw new AggregateError([error, rollbackError], 'Transaction failed and its rollback failed');
          }
        }
        throw error;
      }
    },
    async close(): Promise<void> {
      const pending = [...pools.values()];
      pools.clear();
      const settled = await Promise.allSettled(pending);
      await Promise.all(settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.close()] : [])));
    },
  };
}

/**
 * Bracket-quotes one identifier part (`a]b` becomes `[a]]b]`). Identifiers go through here; values always go through
 * `request.input(name, type, value)` and are never concatenated into SQL text.
 */
export function quoteIdent(name: string): string {
  if (name === '' || name.includes('\u0000')) {
    throw new TypeError('A SQL Server identifier must be non-empty and contain no NUL character');
  }
  return `[${name.replaceAll(']', ']]')}]`;
}
