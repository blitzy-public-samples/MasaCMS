import pg from 'pg';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { Connector, AuthTypes, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { GoogleAuth } from 'google-auth-library';
import { runTenantTransaction, type TenantDb, type CommitErrorHandler, type Queryable } from './transaction.js';
import { runMetadataTransaction } from './metadata.js';
import { openListener, type NotificationListener } from './listener.js';
import { tenancyWarning } from './warning.js';

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
  /** Receives client connection errors, outside any trace, and commit-callback errors; defaults to an OPT2_TENANCY diagnostic warning. */
  onError?: CommitErrorHandler;
}

/** Settings of tenantDbFromPool. */
export interface TenantDbOptions {
  schema: string;
  /** As CreatePoolOptions.onError. */
  onError?: CommitErrorHandler;
  /** Runs after the pool has ended, e.g. to close the Cloud SQL connector. */
  onEnd?: () => Promise<void> | void;
}

/** pg.PoolConfig as pg-pool runs it: onConnect is awaited and its rejection fails the connect; @types/pg declares void. */
type AwaitedConnectPoolConfig = Omit<pg.PoolConfig, 'onConnect'> & { onConnect?: (client: pg.ClientBase) => Promise<void> | void };

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const SERVICE_ACCOUNT_SUFFIX = '.gserviceaccount.com';
const DEFAULT_LISTEN_TIMEOUT_MS = 10_000;
const SET_TIME_ZONE_SQL = "SELECT set_config('TimeZone', $1, false)";
// SQLSTATE invalid_parameter_value: PostgreSQL's tzdata has no zone of that name.
const INVALID_PARAMETER_VALUE = '22023';
// Unary, because pg emits a pool 'error' with the client as a second argument.
const warn = tenancyWarning();

/** Cloud SQL IAM database user for a service-account email: the email without its `.gserviceaccount.com` suffix. */
export function iamDbUser(email: string): string {
  return email.endsWith(SERVICE_ACCOUNT_SUFFIX) ? email.slice(0, -SERVICE_ACCOUNT_SUFFIX.length) : email;
}

/** Wraps `pool` in a frozen TenantDb that exposes only tenant and metadata transactions and LISTEN sessions; throws TypeError for an invalid schema. */
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
  // Socket events run in the async context the connection was opened in, which is not the trace of the failure.
  const onClientError = (err: Error): void => context.with(ROOT_CONTEXT, () => onError(err));
  const checkedOut = new WeakMap<pg.PoolClient, (err: Error) => void>();
  // An idle client's error is emitted on the pool; without a listener it would crash the process.
  pool.on('error', onClientError);
  // pg-pool detaches its idle listener while a client is checked out, so the client gets its own until release.
  pool.on('acquire', (client) => {
    let reported = false;
    // A lost connection emits its error and then "Connection terminated unexpectedly"; only the first is reported.
    const listener = (err: Error): void => {
      if (!reported) {
        reported = true;
        onClientError(err);
      }
    };
    checkedOut.set(client, listener);
    client.on('error', listener);
  });
  pool.on('release', (_err, client) => {
    const listener = checkedOut.get(client);
    if (listener !== undefined) {
      checkedOut.delete(client);
      client.removeListener('error', listener);
    }
  });
  const listeners = new Set<NotificationListener>();
  // Set as end() starts: pool.ending turns true only once every listener has closed.
  let ending = false;
  const db: TenantDb = {
    schema: opts.schema,
    withTenant: (tenantId, fn, options) => runTenantTransaction(pool, runnerOpts, tenantId, fn, options),
    withMetadata: (fn, options) => runMetadataTransaction(pool, runnerOpts, fn, options),
    listen: (channel, handlers) => {
      if (ending || pool.ending) throw new Error('Cannot listen on a TenantDb after end()');
      // Outside the pool, so a session still listening never serves a transaction and pool.end() never waits for it.
      const inner = openListener(() => new pg.Client(listenerConfig(pool.options)), channel, handlers);
      const listener: NotificationListener = {
        close: () => {
          listeners.delete(listener);
          return inner.close();
        },
      };
      listeners.add(listener);
      return listener;
    },
    end: async () => {
      ending = true;
      try {
        // The pool ends even when a listener fails to close; the first such failure is rethrown after it.
        const closes = await Promise.allSettled([...listeners].map((listener) => listener.close()));
        await pool.end();
        const failed = closes.find((close): close is PromiseRejectedResult => close.status === 'rejected');
        if (failed !== undefined) throw failed.reason;
      } finally {
        await opts.onEnd?.();
      }
    },
  };
  return Object.freeze(db);
}

/**
 * The pool's client settings, own descriptors copied so the hidden password and connector stream carry over, with
 * connect and LISTEN each bounded by its positive `connectionTimeoutMillis`, else DEFAULT_LISTEN_TIMEOUT_MS.
 */
function listenerConfig(options: pg.PoolConfig): pg.ClientConfig {
  const config = Object.defineProperties<pg.ClientConfig>({}, Object.getOwnPropertyDescriptors(options));
  // Departs from the Minimal Change rule's ban on new timeouts: pg waits forever by default, and a listener that never
  // starts would leave its local task dispatcher, outbox sweeps included, idle.
  const configured = options.connectionTimeoutMillis ?? 0;
  const timeoutMs = configured > 0 ? configured : DEFAULT_LISTEN_TIMEOUT_MS;
  config.connectionTimeoutMillis = timeoutMs;
  config.query_timeout = timeoutMs;
  return config;
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
    onConnect: sessionTimeZoneSetter(),
  } satisfies AwaitedConnectPoolConfig);
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
    const pool = new pg.Pool({
      ...clientOpts,
      user,
      database: env.PG_DATABASE,
      max,
      application_name: applicationName,
      onConnect: sessionTimeZoneSetter(),
    } satisfies AwaitedConnectPoolConfig);
    return { pool, onEnd: () => connector.close() };
  } catch (err) {
    // The connector schedules certificate refreshes that would otherwise keep the process alive.
    connector.close();
    throw err;
  }
}

/** Returns a hook that sets a connection's TimeZone to the process zone, so LOCALTIMESTAMP matches localTimestamp(). */
export function sessionTimeZoneSetter(): (client: Queryable) => Promise<void> {
  let accepted: string | undefined;
  return async (client) => {
    const candidates = processZoneSpellings();
    // The spelling PostgreSQL accepted on an earlier connection goes first, while it still names the process zone.
    const ordered =
      accepted !== undefined && candidates.includes(accepted) ? [accepted, ...candidates.filter((zone) => zone !== accepted)] : candidates;
    let rejection: unknown;
    for (const zone of ordered) {
      try {
        await client.query(SET_TIME_ZONE_SQL, [zone]);
        accepted = zone;
        return;
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== INVALID_PARAMETER_VALUE) throw err;
        rejection = err;
      }
    }
    throw rejection;
  };
}

/** Spellings of the zone Date applies, in the order PostgreSQL is asked to accept them. */
function processZoneSpellings(): string[] {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Date applies UTC when TZ names no known zone: 'Foo/Bar' resolves to undefined, '' to Etc/Unknown.
  if (!resolved || resolved === 'Etc/Unknown') return ['UTC'];
  // PostgreSQL's tzdata may lack either spelling: US/Eastern as given, or Asia/Calcutta as ICU's id for Asia/Kolkata.
  return [...new Set([process.env.TZ, resolved].filter((zone): zone is string => !!zone))];
}

async function serviceAccountDbUser(): Promise<string> {
  const { client_email: email } = await new GoogleAuth().getCredentials();
  if (!email) {
    throw new Error('OPT2_DB_AUTH=iam without PG_USER needs a service-account email from Google credentials');
  }
  return iamDbUser(email);
}
