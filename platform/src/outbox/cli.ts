#!/usr/bin/env node
// `opt2-outbox` CLI of @opt2/platform/outbox: `replay` republishes stored outbox rows with their original eventId.
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';
import { createPublisher, type EventPublisher } from '../events/index.js';
import { createLogger, serializeError } from '../logging/index.js';
import { EnvValidationError, baseEnvSchema, loadEnv, type BaseEnv } from '../service-kit/index.js';
import { createPool, isTenantId, withTenant, type DbEnv } from '../tenancy/index.js';
import { localTimestamp, outboxTable, rowFromDb } from './ddl.js';
import { createOutbox, dropBlockedRows, publishLockedRows, type OutboxRuntime } from './flush.js';
import { registryTenants, type TenantsOf } from './stats.js';

const USAGE = 'usage: opt2-outbox replay --since <ISO-8601 timestamp> [--tenant <uuid>] [--schema <name>]';

const DEFAULT_BATCH_SIZE = 500;

/** Schemas whose name is not the service name with `-` as `_`. */
const SCHEMA_BY_SERVICE: ReadonlyMap<string, string> = new Map([
  ['programs-sites', 'programs_sites'],
  ['strategies-content', 'content'],
  ['e-signature', 'esignature'],
]);

/** Arguments of `opt2-outbox replay`; `schema` defaults to the schema of `OPT2_SERVICE_NAME`. */
export interface ReplayOptions {
  since: Date;
  tenant?: string;
  schema?: string;
}

/** Options of {@link runReplay}; `tenantsOf` defaults to the service's registry tenants, `batchSize` to 500 rows per page. */
export interface RunReplayOptions {
  runtime: OutboxRuntime;
  since: Date;
  tenant?: string;
  tenantsOf?: TenantsOf;
  batchSize?: number;
}

/** Counts of one replay; `skipped` rows are not republished because an earlier row of their tenant and ordering key failed, is unpublished or is held. */
export interface ReplaySummary {
  replayed: number;
  failed: number;
  skipped: number;
  tenants: number;
}

/** The summary line `main` prints: the replay counts with the schema, `since` and any `--tenant`. */
type ReplayReport = ReplaySummary & { schema: string; since: string; tenant?: string };

/** Invalid command-line usage; answered on stderr with the usage line and exit code 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** Parses `replay` and its options; throws UsageError on any invalid usage. */
export function parseArgs(argv: string[]): ReplayOptions {
  let parsed;
  try {
    parsed = parseCliArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: { since: { type: 'string' }, tenant: { type: 'string' }, schema: { type: 'string' } },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) {
    throw new UsageError('missing subcommand');
  }
  if (positionals.length !== 1 || positionals[0] !== 'replay') {
    throw new UsageError(`unknown subcommand ${JSON.stringify(positionals.join(' '))}`);
  }
  const { since, tenant, schema } = values;
  if (since === undefined) {
    throw new UsageError('missing --since');
  }
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new UsageError(`--since must be an ISO-8601 timestamp, got ${JSON.stringify(since)}`);
  }
  if (tenant !== undefined && !isTenantId(tenant)) {
    throw new UsageError(`--tenant must be a tenant UUID, got ${JSON.stringify(tenant)}`);
  }
  if (schema !== undefined) {
    checkSchema(schema);
  }
  return { since: sinceDate, ...(tenant === undefined ? {} : { tenant }), ...(schema === undefined ? {} : { schema }) };
}

/** Rejects a schema the outbox table name cannot be qualified with. */
function checkSchema(schema: string): void {
  try {
    outboxTable(schema);
  } catch (err) {
    throw new UsageError(`--schema: ${messageOf(err)}`);
  }
}

/** Schema owned by `serviceName`: a fixed name where one is mapped, otherwise the name with `-` as `_`. */
export function serviceSchema(serviceName: string): string {
  return SCHEMA_BY_SERVICE.get(serviceName) ?? serviceName.replaceAll('-', '_');
}

/**
 * Republishes unheld rows created at or after `since` with their stored envelopes, per tenant in `seq` pages up to its last row at the start; stamps only unpublished rows.
 * Waits for rows another transaction holds; after a failed or blocked row, later rows of its ordering key are skipped on every page of its tenant.
 */
export async function runReplay(opts: RunReplayOptions): Promise<ReplaySummary> {
  const { runtime, since, batchSize = DEFAULT_BATCH_SIZE } = opts;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  const { db } = runtime;
  const listed = opts.tenant === undefined ? await (opts.tenantsOf ?? registryTenants)(db) : [opts.tenant];
  // Case-folded as withTenant folds them, so no tenant is replayed twice.
  const tenantIds = new Set(listed.map((id) => id.toLowerCase()));
  const table = outboxTable(db.schema);
  const boundSql = `SELECT max(seq)::text AS bound FROM ${table} WHERE created_at >= $1`;
  const pageSql =
    `SELECT * FROM ${table} WHERE NOT held AND created_at >= $1 AND seq > $2::bigint AND seq <= $3::bigint` +
    ' ORDER BY seq LIMIT $4 FOR UPDATE';
  const createdFrom = localTimestamp(since);
  const failedEvents = new Set<string>();
  const tracked = trackingFailures(runtime, failedEvents);
  const summary: ReplaySummary = { replayed: 0, failed: 0, skipped: 0, tenants: tenantIds.size };

  for (const tenantId of tenantIds) {
    // Per tenant, as outbox rows and their ordering keys are tenant-owned.
    const stoppedKeys = new Set<string>();
    // Rows written after this read are new events their own flush publishes; the bound lets replay end.
    const bound = await withTenant(db, tenantId, async (tx) => {
      const { rows } = await tx.query<{ bound: string | null }>(boundSql, [createdFrom]);
      return rows[0]?.bound ?? null;
    });
    if (bound === null) continue;
    let after = '0';
    for (;;) {
      const page = await withTenant(db, tenantId, async (tx) => {
        const { rows } = await tx.query(pageSql, [createdFrom, after, bound, batchSize]);
        const locked = rows.map(rowFromDb);
        const unblocked = await dropBlockedRows(tx, db.schema, locked);
        const open = unblocked.rows.filter((row) => !stoppedKeys.has(row.orderingKey));
        const result = await publishLockedRows(tx, tracked, open);
        const kept = new Set(unblocked.rows);
        for (const row of locked) {
          if (!kept.has(row) || failedEvents.has(row.eventId)) stoppedKeys.add(row.orderingKey);
        }
        return { result, blocked: locked.length - open.length, size: locked.length, last: locked.at(-1)?.seq };
      });
      summary.replayed += page.result.published;
      summary.failed += page.result.failed;
      summary.skipped += page.result.skipped + page.blocked;
      if (page.last === undefined || page.size < batchSize || BigInt(page.last) >= BigInt(bound)) break;
      after = page.last;
    }
  }
  return summary;
}

/** `runtime` with a publisher that records the eventId of every envelope whose publish fails. */
function trackingFailures(runtime: OutboxRuntime, failedEvents: Set<string>): OutboxRuntime {
  const { publisher } = runtime;
  const tracking: EventPublisher = {
    async publish(topic, envelope) {
      try {
        return await publisher.publish(topic, envelope);
      } catch (err) {
        failedEvents.add(envelope.eventId);
        throw err;
      }
    },
    publishRaw: (topic, message) => publisher.publishRaw(topic, message),
    close: () => publisher.close(),
  };
  return { ...runtime, publisher: tracking };
}

/** Runs `opt2-outbox` with the arguments after the script path; returns 0 when every row was republished, 1 when a row failed or was skipped or on an error, 2 on a usage or environment error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const env = loadEnv(baseEnvSchema);
    const result = await replayFromEnv(args, env);
    await writeStdout(`${JSON.stringify(result)}\n`);
    return result.failed > 0 || result.skipped > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`opt2-outbox: ${err.message}; ${USAGE}\n`);
      return 2;
    }
    if (err instanceof EnvValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`opt2-outbox: ${messageOf(err)}\n`);
    return 1;
  }
}

/** Opens the service's pool and publisher, replays, then closes both. */
async function replayFromEnv(args: ReplayOptions, env: Readonly<BaseEnv>): Promise<ReplayReport> {
  const { dbEnv, projectId } = replaySettings(env);
  const schema = args.schema ?? serviceSchema(env.OPT2_SERVICE_NAME);
  // stderr, so stdout carries only the summary line.
  const logger = createLogger({
    service: env.OPT2_SERVICE_NAME,
    version: await platformVersion(),
    env: env.OPT2_ENV,
    googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    destination: process.stderr,
  });
  const db = await createPool({
    env: dbEnv,
    schema,
    onError: (err) => logger.error({ error: serializeError(err) }, 'database pool error'),
  });
  let publisher: EventPublisher | undefined;
  try {
    publisher = createPublisher({ projectId, emulatorHost: env.PUBSUB_EMULATOR_HOST });
    const runtime = createOutbox({ db, publisher, service: env.OPT2_SERVICE_NAME, logger });
    const result = await runReplay({ runtime, since: args.since, tenant: args.tenant });
    return { schema, since: args.since.toISOString(), ...(args.tenant === undefined ? {} : { tenant: args.tenant }), ...result };
  } finally {
    try {
      await publisher?.close();
    } finally {
      await db.end();
    }
  }
}

/** The pool settings and Pub/Sub project replay needs beyond the base variables; throws EnvValidationError naming each missing one. */
function replaySettings(env: Readonly<BaseEnv>): { dbEnv: DbEnv; projectId: string } {
  const { OPT2_DB_AUTH, PG_DATABASE, GOOGLE_CLOUD_PROJECT } = env;
  if (OPT2_DB_AUTH === undefined || PG_DATABASE === undefined || GOOGLE_CLOUD_PROJECT === undefined) {
    const missing = Object.entries({ OPT2_DB_AUTH, PG_DATABASE, GOOGLE_CLOUD_PROJECT })
      .filter(([, value]) => value === undefined)
      .map(([name]) => `${name}: is required`);
    throw new EnvValidationError(missing, env.OPT2_SERVICE_NAME);
  }
  return { dbEnv: { ...env, OPT2_DB_AUTH, PG_DATABASE }, projectId: GOOGLE_CLOUD_PROJECT };
}

/** Version of @opt2/platform, read from its package.json beside `src` and `dist`. */
async function platformVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes to stdout and resolves once the chunk is flushed. */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(text, (err) => {
      if (err) {
        fail(err);
      } else {
        done();
      }
    });
  });
}

// argv[1] may be a symlinked path (node_modules/@opt2/platform is a link) and Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry)).href) {
  // Explicit exit: a Pub/Sub client that failed mid-close may leave gRPC handles open.
  process.exit(await main());
}
