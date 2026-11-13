#!/usr/bin/env node
// `opt2-outbox` CLI of @opt2/platform/outbox: `replay` republishes stored outbox rows with their original eventId.
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseCliArgs } from 'node:util';
import { createPublisher, type EventPublisher } from '../events/index.js';
import { createLogger, serializeError } from '../logging/index.js';
import { EnvValidationError, baseEnvSchema, requiredEnvString, z } from '../service-kit/index.js';
import { createPool, isTenantId, withTenant } from '../tenancy/index.js';
import { localTimestamp, outboxTable, rowFromDb } from './ddl.js';
import { PUBLISH_STALL_MS, createOutbox, dropBlockedRows, publishLockedRows, publishPass, type OutboxRuntime } from './flush.js';
import { registryTenants, type TenantsOf } from './stats.js';

const USAGE = 'usage: opt2-outbox replay --since <ISO-8601 timestamp> [--tenant <uuid>] [--schema <name>]';

const HELP = `${USAGE}

Republishes the outbox rows created at or after --since with their original eventId, per tenant in seq order, and
stamps only the unpublished ones. Held rows are left out, and the later rows of a key with a failed, unpublished or held
row are skipped. A publish still unconfirmed after ${String(PUBLISH_STALL_MS / 1000)} s counts as failed and ends the replay.
Prints one JSON summary line.
  --since <timestamp>   date, time and zone, such as 2026-06-30T00:00:00Z or 2026-06-30T09:00+05:30 (required)
  --tenant <uuid>       replay only this tenant (default: every tenant in the schema's tenant_registry)
  --schema <name>       outbox schema (default: the schema of OPT2_SERVICE_NAME)
  -h, --help            print this help
Environment:
  OPT2_SERVICE_NAME     service whose outbox is replayed (required)
  OPT2_ENV              local or cloud (required)
  TZ                    time zone the service stores outbox timestamps in (required)
  OPT2_DB_AUTH          password (OPT2_ENV=local) or iam (OPT2_ENV=cloud) (required)
  PG_DATABASE           database (required)
  PG_USER               database user (required)
  PG_HOST               database host (required when OPT2_DB_AUTH=password)
  PG_PORT               database port (required when OPT2_DB_AUTH=password)
  PG_PASSWORD           database password (required when OPT2_DB_AUTH=password; must be unset when iam)
  CLOUD_SQL_INSTANCE    <project>:<region>:<instance> (required when OPT2_DB_AUTH=iam)
  GOOGLE_CLOUD_PROJECT  Pub/Sub project (required)
  PUBSUB_EMULATOR_HOST  Pub/Sub emulator host:port; without it Cloud Pub/Sub is called (must be unset when OPT2_ENV=cloud)
Exit codes: 0 every row republished, 1 a row failed or was skipped, or an error, 2 usage or environment error.
`;

// Seconds and fraction optional, zone mandatory: Date reads a bare date as UTC and a zone-less time as local time.
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const DEFAULT_BATCH_SIZE = 500;

/** Schemas whose name is not the service name with `-` as `_`. */
const SCHEMA_BY_SERVICE: ReadonlyMap<string, string> = new Map([
  ['programs-sites', 'programs_sites'],
  ['strategies-content', 'content'],
  ['e-signature', 'esignature'],
]);

const PASSWORD_DB_KEYS = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD'] as const;
const IAM_DB_KEYS = ['CLOUD_SQL_INSTANCE', 'PG_USER'] as const;

/** Variables replay reads; TZ stays required because outbox timestamps are stored as wall times in the service's zone. */
const replayEnvSchema = baseEnvSchema
  .pick({
    OPT2_SERVICE_NAME: true,
    OPT2_ENV: true,
    PG_HOST: true,
    PG_PORT: true,
    PG_DATABASE: true,
    PG_USER: true,
    PG_PASSWORD: true,
    OPT2_DB_AUTH: true,
    CLOUD_SQL_INSTANCE: true,
    PUBSUB_EMULATOR_HOST: true,
    GOOGLE_CLOUD_PROJECT: true,
    TZ: true,
  })
  .extend({
    OPT2_DB_AUTH: requiredEnvString(z.enum(['password', 'iam'])),
    PG_DATABASE: requiredEnvString(),
    GOOGLE_CLOUD_PROJECT: requiredEnvString(),
  })
  .superRefine(
    (env, ctx) => {
      // The database and Pub/Sub mode rules of loadEnv, in its wording, for variables without an issue of their own.
      const reported = new Set(ctx.issues.map((issue) => issue.path?.[0]));
      const flag = (key: string, message: string): void => {
        if (!reported.has(key)) ctx.addIssue({ code: 'custom', path: [key], message });
      };
      if (!reported.has('OPT2_DB_AUTH')) {
        const when = `OPT2_DB_AUTH=${env.OPT2_DB_AUTH}`;
        const password = env.OPT2_DB_AUTH === 'password';
        for (const key of password ? PASSWORD_DB_KEYS : IAM_DB_KEYS) {
          if (env[key] === undefined) flag(key, `is required when ${when}`);
        }
        if (!password && env.PG_PASSWORD !== undefined) flag('PG_PASSWORD', `must be unset when ${when}`);
        const mode = password ? 'local' : 'cloud';
        if (env.OPT2_ENV !== mode) flag('OPT2_ENV', `must be ${mode} when ${when}`);
      }
      if (env.OPT2_ENV === 'cloud' && env.PUBSUB_EMULATOR_HOST !== undefined) {
        flag('PUBSUB_EMULATOR_HOST', 'must be unset when OPT2_ENV=cloud');
      }
    },
    // Beside the variables' own issues, so one error lists them all; never for a source that is not an object.
    { when: ({ value }) => typeof value === 'object' && value !== null },
  );

/** Parsed variables of {@link replayEnvSchema}; also the pool settings createPool takes. */
type ReplayEnv = z.output<typeof replayEnvSchema>;

/** Arguments of `opt2-outbox replay`; `schema` defaults to the schema of `OPT2_SERVICE_NAME`. */
export interface ReplayOptions {
  since: Date;
  tenant?: string;
  schema?: string;
}

/** Options of {@link runReplay}; `tenantsOf` defaults to the service's registry tenants, `batchSize` to 500 rows per page, `publishStallMs` to PUBLISH_STALL_MS. */
export interface RunReplayOptions {
  runtime: OutboxRuntime;
  since: Date;
  tenant?: string;
  tenantsOf?: TenantsOf;
  batchSize?: number;
  /** Longest wait for one publish; the first publish unconfirmed by then ends the replay. */
  publishStallMs?: number;
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

/** Parses `replay` and its options; `'help'` when `--help` or `-h` is given; throws UsageError on any invalid usage. */
export function parseArgs(argv: string[]): ReplayOptions | 'help' {
  let parsed;
  try {
    parsed = parseCliArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        since: { type: 'string' },
        tenant: { type: 'string' },
        schema: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(messageOf(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    return 'help';
  }
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
  const sinceDate = isoInstant(since);
  if (sinceDate === undefined) {
    throw new UsageError(
      `--since must be an ISO-8601 timestamp with a date, time and zone, such as 2026-06-30T00:00:00Z, got ${JSON.stringify(since)}`,
    );
  }
  if (tenant !== undefined && !isTenantId(tenant)) {
    throw new UsageError(`--tenant must be a tenant UUID, got ${JSON.stringify(tenant)}`);
  }
  if (schema !== undefined) {
    checkSchema(schema);
  }
  return { since: sinceDate, ...(tenant === undefined ? {} : { tenant }), ...(schema === undefined ? {} : { schema }) };
}

/** The instant of an ISO-8601 date-time with a zone whose date and time exist; undefined for any other text. */
function isoInstant(text: string): Date | undefined {
  const match = ISO_TIMESTAMP.exec(text);
  if (match === null) return undefined;
  const wall = `${match[1] as string}:${match[2] ?? '00'}`;
  // Date rolls 2026-02-30 over to March 2 and T24:00 to the next day, so the wall time must survive a round trip.
  const asUtc = new Date(`${wall}Z`);
  if (Number.isNaN(asUtc.getTime()) || asUtc.toISOString().slice(0, 19) !== wall) return undefined;
  const instant = new Date(text);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
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
 * The first stalled publish counts as failed and ends the replay with one warning.
 */
export async function runReplay(opts: RunReplayOptions): Promise<ReplaySummary> {
  const { runtime, since, batchSize = DEFAULT_BATCH_SIZE, publishStallMs = PUBLISH_STALL_MS } = opts;
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
  const pass = publishPass(runtime, publishStallMs);
  const tracked = trackingFailures(pass.runtime, failedEvents);
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
        const result = await publishLockedRows(tx, tracked, open, { signal: pass.signal });
        const kept = new Set(unblocked.rows);
        for (const row of locked) {
          if (!kept.has(row) || failedEvents.has(row.eventId)) stoppedKeys.add(row.orderingKey);
        }
        return { result, blocked: locked.length - open.length, size: locked.length, last: locked.at(-1)?.seq };
      });
      summary.replayed += page.result.published;
      summary.failed += page.result.failed;
      summary.skipped += page.result.skipped + page.blocked;
      if (pass.signal.aborted || page.last === undefined || page.size < batchSize || BigInt(page.last) >= BigInt(bound)) break;
      after = page.last;
    }
    if (pass.signal.aborted) {
      runtime.logger.warn(
        { tenantId, error: serializeError(pass.signal.reason) },
        `outbox replay ended early after a publish stalled for ${String(publishStallMs)} ms`,
      );
      break;
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

/** Runs `opt2-outbox` with the arguments after the script path; returns 0 when every row was republished or help was printed, 1 when a row failed or was skipped or on an error, 2 on a usage or environment error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args === 'help') {
      await writeStdout(HELP);
      return 0;
    }
    const env = loadReplayEnv(process.env);
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

/** Parses the variables replay reads with their mode rules; throws EnvValidationError listing every invalid or missing one. */
function loadReplayEnv(source: NodeJS.ProcessEnv): ReplayEnv {
  const result = replayEnvSchema.safeParse(source, {
    error: (issue) => (issue.input === undefined ? 'is required' : undefined),
  });
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(issues, 'opt2-outbox');
  }
  return result.data;
}

/** Opens the service's pool and publisher, replays, then closes both. */
async function replayFromEnv(args: ReplayOptions, env: ReplayEnv): Promise<ReplayReport> {
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
    env,
    schema,
    onError: (err) => logger.error({ error: serializeError(err) }, 'database pool error'),
  });
  let publisher: EventPublisher | undefined;
  try {
    publisher = createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT, emulatorHost: env.PUBSUB_EMULATOR_HOST });
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
