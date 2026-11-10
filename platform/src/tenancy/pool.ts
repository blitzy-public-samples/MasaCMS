import pg from 'pg';
import { Connector, AuthTypes, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import { runTenantTransaction, type TenantDb, type CommitErrorHandler } from './transaction.js';
import { runMetadataTransaction } from './metadata.js';

/** Database settings createPool reads; a structural subset of the service-kit environment. */
export interface DbEnv {
  OPT2_DB_AUTH: 'password' | 'iam';
  PG_HOST?: string;
  PG_PORT?: number | string;
  PG_DATABASE: string;
  PG_USER?: string;
  PG_PASSWORD?: string;
  CLOUD_SQL_INSTANCE?: string;
}

/** Settings of createPool. */
export interface CreatePoolOptions {
  env: DbEnv;
  /** Schema the service owns, e.g. `programs_sites`; never derived from the service name. */
  schema: string;
  max?: number;
  applicationName?: string;
  /** Receives idle-client and commit-callback errors; defaults to a process warning. */
  onError?: CommitErrorHandler;
}

/** Settings of tenantDbFromPool. */
export interface TenantDbOptions {
  schema: string;
  onError?: CommitErrorHandler;
  /** Runs after the pool has ended, e.g. to close the Cloud SQL connector. */
  onEnd?: () => Promise<void> | void;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const SERVICE_ACCOUNT_SUFFIX = '.gserviceaccount.com';
const WARNING_CODE = 'OPT2_TENANCY';

/** Cloud SQL IAM database user for a service-account email: the email without its `.gserviceaccount.com` suffix. */
export function iamDbUser(email: string): string {
  return email.endsWith(SERVICE_ACCOUNT_SUFFIX) ? email.slice(0, -SERVICE_ACCOUNT_SUFFIX.length) : email;
}

/** Wraps `pool` in a frozen TenantDb that exposes only tenant and metadata transactions; throws TypeError for an invalid schema. */
export function tenantDbFromPool(pool: pg.Pool, opts: TenantDbOptions): TenantDb {
  assertSchema(opts.schema);
  return buildTenantDb(pool, opts);
}

/** Opens the pg pool of one service schema with password (local) or Cloud SQL IAM (cloud) authentication. */
export async function createPool(opts: CreatePoolOptions): Promise<TenantDb> {
  assertSchema(opts.schema);
  const { pool, onEnd } = opts.env.OPT2_DB_AUTH === 'iam' ? await iamPool(opts) : { pool: passwordPool(opts), onEnd: undefined };
  return buildTenantDb(pool, { schema: opts.schema, onError: opts.onError, onEnd });
}

function assertSchema(schema: string): void {
  if (!SCHEMA_NAME.test(schema)) {
    throw new TypeError(`Invalid schema name ${JSON.stringify(schema)}: expected ${String(SCHEMA_NAME)}`);
  }
}

function buildTenantDb(pool: pg.Pool, opts: TenantDbOptions): TenantDb {
  const onError = opts.onError ?? warn;
  const runnerOpts = { schema: opts.schema, onError };
  // An idle client's error is emitted on the pool; without a listener it would crash the process.
  pool.on('error', onError);
  const db: TenantDb = {
    schema: opts.schema,
    withTenant: (tenantId, fn) => runTenantTransaction(pool, runnerOpts, tenantId, fn),
    withMetadata: (fn) => runMetadataTransaction(pool, runnerOpts, fn),
    end: async () => {
      try {
        await pool.end();
      } finally {
        await opts.onEnd?.();
      }
    },
  };
  return Object.freeze(db);
}

function passwordPool({ env, max, applicationName }: CreatePoolOptions): pg.Pool {
  const missing = (['PG_HOST', 'PG_USER', 'PG_PASSWORD'] as const).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`OPT2_DB_AUTH=password requires ${missing.join(', ')}`);
  }
  return new pg.Pool({
    host: env.PG_HOST,
    port: env.PG_PORT === undefined ? 5432 : Number(env.PG_PORT),
    database: env.PG_DATABASE,
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    max,
    application_name: applicationName,
  });
}

async function iamPool({ env, max, applicationName }: CreatePoolOptions): Promise<{ pool: pg.Pool; onEnd: () => void }> {
  if (!env.CLOUD_SQL_INSTANCE) {
    throw new Error('OPT2_DB_AUTH=iam requires CLOUD_SQL_INSTANCE');
  }
  const connector = new Connector();
  try {
    const clientOpts = await connector.getOptions({
      instanceConnectionName: env.CLOUD_SQL_INSTANCE,
      authType: AuthTypes.IAM,
      ipType: IpAddressTypes.PRIVATE,
    });
    const user = env.PG_USER || (await serviceAccountDbUser());
    // No password: the connector's stream authenticates with short-lived IAM tokens.
    const pool = new pg.Pool({ ...clientOpts, user, database: env.PG_DATABASE, max, application_name: applicationName });
    return { pool, onEnd: () => connector.close() };
  } catch (err) {
    // The connector schedules certificate refreshes that would otherwise keep the process alive.
    connector.close();
    throw err;
  }
}

async function serviceAccountDbUser(): Promise<string> {
  const { client_email: email } = await new GoogleAuth().getCredentials();
  if (!email) {
    throw new Error('OPT2_DB_AUTH=iam without PG_USER needs a service-account email from Google credentials');
  }
  return iamDbUser(email);
}

// The string form keeps the warning code; process.emitWarning drops it when given an Error. Stderr only: stdout carries log-record.v1 lines.
function warn(err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  process.emitWarning(error.message, { code: WARNING_CODE, detail: error.stack });
}
