import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { envPort, optionalEnvString } from '../service-kit/index.js';
import { tenantDbFromPool, type TenantDb } from '../tenancy/index.js';

/** PostgreSQL connection settings of the bootstrap user, read from `PG_*`. */
export interface PgConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Login roles a test may connect as. */
export type ThrowawayRole = 'app' | 'migrator';

/** Names of the owner, app and migrator roles of one schema. */
export interface ThrowawayRoles {
  owner: string;
  app: string;
  migrator: string;
}

/** Settings of createThrowawaySchema. */
export interface ThrowawaySchemaOptions {
  /** Package name, e.g. `e-signature`; it prefixes the generated schema and role names. */
  service: string;
  /** Folder of `NNNN_<name>.sql` migrations, applied in file-name order. */
  migrationsDir?: string;
  /** Production schema the SQL names, when it differs from the service name, e.g. `content`. */
  schemaName?: string;
  /** Further SQL applied after the migrations, rewritten the same way. */
  extraSql?: readonly string[];
}

/** A migrated throwaway schema with its role chain and pools. */
export interface ThrowawaySchema {
  readonly schema: string;
  readonly roles: Readonly<ThrowawayRoles>;
  /** Pool of the app role (max 4). */
  readonly appPool: pg.Pool;
  /** Pool of the migrator role (max 1). */
  readonly migratorPool: pg.Pool;
  /** Pool of the bootstrap user (max 2). */
  readonly adminPool: pg.Pool;
  /** The TenantDb over `appPool` that service code under test receives. */
  readonly app: TenantDb;
  /** Opens a further pool as `role` (default max 1); drop() ends it. */
  connect(role: ThrowawayRole, opts?: { max?: number }): pg.Pool;
  /** Ends every pool and removes the schema and its roles; repeated calls share the first call's outcome. */
  drop(): Promise<void>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_FILE = /^\d{4}_.+\.sql$/;
const MAX_IDENTIFIER_BYTES = 63;
const SUFFIX_BYTES = 4;
const LONGEST_ROLE_SUFFIX = '_migrator';
// t_<base>_<suffix> and <base>_<suffix>_migrator must both fit; the role name is the longer one.
const MAX_BASE_LENGTH = MAX_IDENTIFIER_BYTES - 1 - SUFFIX_BYTES * 2 - LONGEST_ROLE_SUFFIX.length;
const PASSWORD_BYTES = 24;
const CONNECT_TIMEOUT_MS = 2000;
const PG_PORT = optionalEnvString(envPort());
const DEFAULT_PG_PORT = 5432;
// Concurrent GRANT/REVOKE on the same pg_database row fail with "tuple concurrently updated".
const BOOTSTRAP_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('opt2.testing.throwaway-schema'))";

/** Reads the bootstrap user's connection settings; throws naming every missing required variable or an invalid PG_PORT. */
export function testPgConfig(env: NodeJS.ProcessEnv = process.env): PgConfig {
  const missing = (['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Throwaway test schemas need ${missing.join(', ')} in the environment`);
  }
  const port = PG_PORT.safeParse(env.PG_PORT);
  if (!port.success) {
    throw new Error(`Throwaway test schemas need PG_PORT to be an integer from 1 to 65535, got ${JSON.stringify(env.PG_PORT)}`);
  }
  return {
    host: env.PG_HOST as string,
    port: port.data ?? DEFAULT_PG_PORT,
    user: env.PG_USER as string,
    password: env.PG_PASSWORD as string,
    database: env.PG_DATABASE as string,
  };
}

/** True when the `PG_*` server accepts a connection within 2 s, false when unreachable; rejects on bad settings or server errors. */
export async function pgAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const client = new pg.Client({ ...testPgConfig(env), connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
  } catch (err) {
    if (err instanceof pg.DatabaseError) {
      throw err;
    }
    return false;
  }
  await client.end();
  return true;
}

/**
 * Rewrites references to schema `from` as `to`: `from.` and `"from".` qualifiers, `SCHEMA from` clauses,
 * and the roles `from_owner`, `from_app`, `from_migrator` as `roles` (default `<to>_owner` and so on).
 */
export function rewriteMigrationSql(sql: string, from: string, to: string, roles?: ThrowawayRoles): string {
  assertIdentifier(from, 'source schema');
  assertIdentifier(to, 'target schema');
  const target: ThrowawayRoles = roles ?? { owner: `${to}_owner`, app: `${to}_app`, migrator: `${to}_migrator` };
  const pattern = new RegExp(
    [
      `(?<![\\w$])${from}_(?<role>owner|app|migrator)(?![\\w$])`,
      `(?<![\\w$."])${from}(?=\\.)`,
      `(?<![\\w$.])"${from}"(?=\\.)`,
      `(?<clause>\\bSCHEMA\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?)(?:(?<quoted>"${from}")|${from}(?![\\w$]))`,
    ].join('|'),
    'gi',
  );
  return sql.replace(pattern, (match: string, ...args: unknown[]) => {
    const groups = args.at(-1) as { role?: string; clause?: string; quoted?: string };
    if (groups.role !== undefined) {
      return target[groups.role.toLowerCase() as keyof ThrowawayRoles];
    }
    if (groups.clause !== undefined) {
      return groups.clause + (groups.quoted === undefined ? to : `"${to}"`);
    }
    return match.startsWith('"') ? `"${to}"` : to;
  });
}

/** Creates a schema with the bootstrap role chain, applies the service's migrations as its owner and returns the handle. */
export async function createThrowawaySchema(opts: ThrowawaySchemaOptions): Promise<ThrowawaySchema> {
  const config = testPgConfig();
  const base = serviceBase(opts.service);
  const from = opts.schemaName ?? base;
  const suffix = randomBytes(SUFFIX_BYTES).toString('hex');
  const stem = `${base.slice(0, MAX_BASE_LENGTH)}_${suffix}`;
  const schema = assertIdentifier(`t_${stem}`, 'schema');
  const roles: ThrowawayRoles = {
    owner: assertIdentifier(`${stem}_owner`, 'role'),
    app: assertIdentifier(`${stem}_app`, 'role'),
    migrator: assertIdentifier(`${stem}_migrator`, 'role'),
  };
  const passwords: Record<ThrowawayRole, string> = { app: randomPassword(), migrator: randomPassword() };

  const adminPool = new pg.Pool({ ...config, max: 2 });
  const pools = new Set<pg.Pool>();
  let dropping: Promise<void> | undefined;
  const drop = (): Promise<void> => (dropping ??= dropAll(adminPool, pools, schema, roles));
  const connect = (role: ThrowawayRole, { max = 1 }: { max?: number } = {}): pg.Pool => {
    if (dropping !== undefined) {
      throw new Error(`Throwaway schema ${schema} has been dropped`);
    }
    const pool = new pg.Pool({ ...config, user: roles[role], password: passwords[role], max });
    pools.add(pool);
    return pool;
  };

  const migratorPool = connect('migrator', { max: 1 });
  const appPool = connect('app', { max: 4 });
  let step = 'bootstrap';
  try {
    await bootstrap(adminPool, config.database, schema, roles, passwords);
    for (const { label, sql } of await scripts(opts)) {
      step = label;
      await inTransaction(migratorPool, async (client) => {
        await client.query(`SET LOCAL ROLE ${quoteIdent(roles.owner)}`);
        await client.query(rewriteMigrationSql(sql, from, schema, roles));
      });
    }
  } catch (err) {
    const failure = new Error(`Throwaway schema ${schema}: ${step} failed: ${errorMessage(err)}`, { cause: err });
    try {
      await drop();
    } catch (dropError) {
      throw new AggregateError([failure, dropError], failure.message);
    }
    throw failure;
  }

  return Object.freeze({
    schema,
    roles: Object.freeze(roles),
    appPool,
    migratorPool,
    adminPool,
    app: tenantDbFromPool(appPool, { schema }),
    connect,
    drop,
  });
}

async function bootstrap(
  adminPool: pg.Pool,
  database: string,
  schema: string,
  roles: ThrowawayRoles,
  passwords: Record<ThrowawayRole, string>,
): Promise<void> {
  const s = quoteIdent(schema);
  const owner = quoteIdent(roles.owner);
  const app = quoteIdent(roles.app);
  const migrator = quoteIdent(roles.migrator);
  // Role chain and grants mirror opt2-db bootstrap, including UPDATE on sequences, so isolation results transfer to the real roles.
  await inTransaction(adminPool, async (client) => {
    await client.query(BOOTSTRAP_LOCK_SQL);
    for (const statement of [
      // A non-superuser CREATEROLE creator needs SET for CREATE SCHEMA … AUTHORIZATION and INHERIT for drop().
      "SET LOCAL createrole_self_grant = 'set, inherit'",
      `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
      `CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${passwords.app}'`,
      `CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${passwords.migrator}'`,
      `CREATE SCHEMA ${s} AUTHORIZATION ${owner}`,
      `GRANT ${owner} TO ${migrator}`,
      `GRANT USAGE ON SCHEMA ${s} TO ${app}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${s} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${app}`,
      `REVOKE ALL ON SCHEMA ${s} FROM PUBLIC`,
      `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${app}, ${migrator}`,
    ]) {
      await client.query(statement);
    }
  });
}

async function scripts(opts: ThrowawaySchemaOptions): Promise<{ label: string; sql: string }[]> {
  const out: { label: string; sql: string }[] = [];
  if (opts.migrationsDir !== undefined) {
    const files = (await readdir(opts.migrationsDir)).filter((name) => MIGRATION_FILE.test(name)).sort();
    for (const file of files) {
      out.push({ label: file, sql: await readFile(join(opts.migrationsDir, file), 'utf8') });
    }
  }
  (opts.extraSql ?? []).forEach((sql, index) => out.push({ label: `extraSql[${index}]`, sql }));
  return out;
}

async function dropAll(adminPool: pg.Pool, pools: ReadonlySet<pg.Pool>, schema: string, roles: ThrowawayRoles): Promise<void> {
  try {
    await Promise.all([...pools].filter((pool) => !pool.ending).map((pool) => pool.end()));
    await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN ($1, $2)', [
      roles.app,
      roles.migrator,
    ]);
    await inTransaction(adminPool, async (client) => {
      await client.query(BOOTSTRAP_LOCK_SQL);
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      const names = [roles.owner, roles.app, roles.migrator];
      const { rows } = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [names]);
      const existing = new Set(rows.map((row) => row.rolname));
      const quoted = names.filter((name) => existing.has(name)).map(quoteIdent).join(', ');
      if (quoted !== '') {
        await client.query(`DROP OWNED BY ${quoted}`);
        await client.query(`DROP ROLE ${quoted}`);
      }
    });
  } finally {
    await adminPool.end();
  }
}

/** Runs `work` between BEGIN and COMMIT on one client; rolls back and rethrows on failure. */
async function inTransaction(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (err) {
    let rollbackError: Error | undefined;
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      // A connection that cannot roll back may still hold the transaction, so pg must destroy it.
      rollbackError = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
    }
    client.release(rollbackError);
    throw err;
  }
  client.release();
}

function serviceBase(service: string): string {
  return service.toLowerCase().replace(/-/g, '_');
}

function assertIdentifier(name: string, label: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new TypeError(`Invalid ${label} identifier ${JSON.stringify(name)}: expected ${String(IDENTIFIER)}`);
  }
  return name;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// base64url needs no escaping inside a quoted SQL literal.
function randomPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
