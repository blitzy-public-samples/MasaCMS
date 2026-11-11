import { createRequire } from 'node:module';

import type { EnvLike } from './paths.js';

/** One driver request; parameters bind by name and are referenced as `@name` in the SQL text. */
export interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query<T = Record<string, unknown>>(sql: string): Promise<{ recordset: T[] }>;
}

/** Connection pool of the `mssql` driver, reduced to what the harness calls. */
export interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
}

/** Structural shape of the CommonJS `mssql` module, which ships no TypeScript types. */
export interface MssqlDriver {
  ConnectionPool: new (config: MssqlConfig) => MssqlPool;
}

/** Connection settings passed to `ConnectionPool`. */
export interface MssqlConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  options: { encrypt: boolean; trustServerCertificate: boolean };
}

/** Client that runs single read-only statements against the legacy SQL Server database. */
export interface ReadOnlyMssql {
  readOnlyQuery<T = Record<string, unknown>>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
  close(): Promise<void>;
}

/** Raised for a statement or parameter the read-only guard refuses. */
export class ReadOnlyViolation extends Error {
  override name = 'ReadOnlyViolation';
}

// Openers of string literals and [bracketed] or "quoted" identifiers, mapped to their closers; a doubled closer is escaped.
const CLOSERS: Readonly<Record<string, string>> = { "'": "'", '[': ']', '"': '"' };
const UNTERMINATED = 'read-only query has an unterminated comment, literal or quoted identifier';
// Skips keywords inside names (letter, _, @, # or non-money $ first); T-SQL ends a number before one (1DELETE, 0xUPDATE).
const WRITE_KEYWORD =
  /(?<!(?<![\w@#$])(?:[A-Za-z_@#]|\$(?!\d))[\w@#$]*)(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|CREATE|ALTER|DROP|TRUNCATE|BACKUP|RESTORE|INTO|GRANT|REVOKE|DENY|DBCC|OPENROWSET|OPENQUERY|OPENDATASOURCE|BULK|WAITFOR|SHUTDOWN|KILL|USE|WRITETEXT|UPDATETEXT|SET|DECLARE|BEGIN|COMMIT|ROLLBACK|SAVE|CHECKPOINT|RECONFIGURE|RAISERROR|SETUSER|REVERT|OPEN|ADD|NEXT\s+VALUE\s+FOR|END\s+CONVERSATION)\b/i;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns `sql` with comments, string literals and quoted identifiers replaced by spaces, lexed as SQL Server does:
 * block comments nest and `--` ends at CR or LF. Throws `ReadOnlyViolation` for an unterminated one.
 */
function blankNonCode(sql: string): string {
  let code = '';
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const closer = CLOSERS[sql.charAt(i)];
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\r' && sql[i] !== '\n') i += 1;
    } else if (sql.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (i >= sql.length) throw new ReadOnlyViolation(UNTERMINATED);
        const pair = sql.slice(i, i + 2);
        if (pair === '/*' || pair === '*/') {
          depth += pair === '/*' ? 1 : -1;
          i += 2;
        } else {
          i += 1;
        }
      } while (depth > 0);
    } else if (closer !== undefined) {
      do {
        const end = sql.indexOf(closer, i + 1);
        if (end < 0) throw new ReadOnlyViolation(UNTERMINATED);
        i = end + 1;
      } while (sql[i] === closer);
    } else {
      code += sql.charAt(i);
      i += 1;
      continue;
    }
    code += ' '.repeat(i - start);
  }
  return code;
}

/**
 * Throws `ReadOnlyViolation` unless `sql` lexes completely and is one `SELECT` (or `WITH … SELECT`) statement, at
 * most one trailing `;`, and free of write, DDL, execution, transaction, external-data, session and sequence keywords
 * outside comments, literals and quoted identifiers.
 */
export function assertReadOnlySql(sql: string): void {
  const code = blankNonCode(sql);
  const first = /^\s*([A-Za-z]+)\b/.exec(code)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && !(first === 'WITH' && /\bSELECT\b/i.test(code))) {
    throw new ReadOnlyViolation('read-only query must start with SELECT or WITH … SELECT');
  }
  if (/;(?!\s*$)/.test(code)) {
    throw new ReadOnlyViolation('read-only query must be a single statement');
  }
  const keyword = WRITE_KEYWORD.exec(code)?.[1];
  if (keyword !== undefined) {
    throw new ReadOnlyViolation(`read-only query must not use ${keyword.toUpperCase().replace(/\s+/g, ' ')}`);
  }
}

function envValue(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Connection settings from `MURA_DB*` variables; `opts.database` replaces `MURA_DATABASE`, e.g. for a restored snapshot. */
export function mssqlConfigFromEnv(env: EnvLike = process.env, opts: { database?: string } = {}): MssqlConfig {
  const server = envValue(env, 'MURA_DBHOST');
  const database = opts.database ?? envValue(env, 'MURA_DATABASE');
  const user = envValue(env, 'MURA_DBUSERNAME');
  const password = envValue(env, 'MURA_DBPASSWORD');
  if (server === undefined || database === undefined || user === undefined || password === undefined) {
    const settings = { MURA_DBHOST: server, MURA_DATABASE: database, MURA_DBUSERNAME: user, MURA_DBPASSWORD: password };
    const missing = Object.keys(settings).filter((name) => settings[name as keyof typeof settings] === undefined);
    throw new Error(`SQL Server connection settings missing: ${missing.join(', ')}`);
  }
  const port = Number(envValue(env, 'MURA_DBPORT') ?? 1433);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MURA_DBPORT is not a valid TCP port: ${env.MURA_DBPORT}`);
  }
  // Local SQL Server 2022 Express presents a self-signed certificate.
  return { server, port, database, user, password, options: { encrypt: true, trustServerCertificate: true } };
}

/**
 * Connects to the legacy database and returns a client that only runs statements passing `assertReadOnlySql`, each
 * inside a transaction it always rolls back.
 */
export async function createReadOnlyMssql(
  env: EnvLike = process.env,
  deps: { driver?: MssqlDriver; database?: string } = {},
): Promise<ReadOnlyMssql> {
  const config = mssqlConfigFromEnv(env, deps.database === undefined ? {} : { database: deps.database });
  const driver = deps.driver ?? (createRequire(import.meta.url)('mssql') as MssqlDriver);
  const pool = await new driver.ConnectionPool(config).connect();
  return {
    async readOnlyQuery<T = Record<string, unknown>>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
      assertReadOnlySql(sql);
      const entries = Object.entries(params);
      // The driver splices parameter names into the batch it sends, so a name must be a plain identifier.
      const badName = entries.find(([name]) => !PARAM_NAME.test(name))?.[0];
      if (badName !== undefined) {
        throw new ReadOnlyViolation(`invalid SQL parameter name: ${JSON.stringify(badName)}`);
      }
      const request = pool.request();
      for (const [name, value] of entries) {
        request.input(name, value);
      }
      // XACT_ABORT and the closing rollback undo any write the lexical guard misses; the recordset stays the SELECT's.
      const batch = `SET XACT_ABORT ON;\nBEGIN TRANSACTION;\n${sql}\nIF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;`;
      return (await request.query<T>(batch)).recordset;
    },
    close: () => pool.close(),
  };
}
