/** Outbox sweep: publishes rows no in-request flush published, per registry tenant, from the self-rescheduling `<svc>-outbox-sweep` chain. */
import { serializeError, type Logger } from '../logging/index.js';
import type { Clock, FastifyInstance } from '../service-kit/index.js';
import {
  OUTBOX_SWEEP_PATH,
  outboxSweepQueue,
  recurringHandler,
  recurringSpec,
  registerTaskRoute,
  type QueueName,
  type TaskPort,
} from '../tasks/index.js';
import { dropBlockedRows, outboxRuntimeFor, publishLockedRows, selectPublishable, type OutboxRuntime } from './flush.js';
import { registryTenants, type TenantsOf } from './stats.js';

const DEFAULT_BATCH_SIZE = 500;

/** What a recovery hook receives on each sweep. */
export interface RecoveryContext {
  service: string;
  runtime: OutboxRuntime;
  clock: Clock;
  logger: Logger;
}

/** Service-specific work run after each sweep has published, such as resolving operations left open too long. */
export interface RecoveryHook {
  name: string;
  run(ctx: RecoveryContext): Promise<void>;
}

/** Options of {@link registerOutboxSweep}; omitted members default from `app.opt2` and the task queue registry. */
export interface RegisterOutboxSweepOptions {
  service: string;
  port: TaskPort;
  /** Defaults to the runtime registered for `app.opt2.db.schema`. */
  runtime?: OutboxRuntime;
  /** Defaults to `outboxSweepQueue(service)`. */
  queue?: QueueName;
  /** Base URL per service, the sweep's own included; defaults to `app.opt2.env.OPT2_SERVICE_URLS`. */
  serviceUrls?: Record<string, string>;
  /** Defaults to `app.opt2.clock`. */
  clock?: Clock;
  recoveryHooks?: readonly RecoveryHook[];
  /** Defaults to every tenant of the service's `tenant_registry`. */
  tenantsOf?: TenantsOf;
  /** Rows locked per transaction; defaults to 500. */
  batchSize?: number;
}

/** Totals of one sweep: publish outcomes of every batch, tenants swept without error, and each hook's outcome in run order. */
export interface SweepResult {
  published: number;
  failed: number;
  skipped: number;
  tenants: number;
  hooks: { name: string; ok: boolean }[];
}

/** Options of {@link sweepOutbox}; `tenantsOf` defaults to the service's `tenant_registry`, `batchSize` to 500. */
export interface SweepOutboxOptions {
  service: string;
  clock: Clock;
  tenantsOf?: TenantsOf;
  batchSize?: number;
  recoveryHooks?: readonly RecoveryHook[];
}

// Pages by seq, so a blocked or failed row is not re-selected within one sweep; a short batch ends the tenant.
async function sweepTenant(runtime: OutboxRuntime, tenantId: string, batchSize: number, totals: SweepResult): Promise<void> {
  const { schema } = runtime.db;
  let after: string | undefined;
  for (;;) {
    const page = await runtime.db.withTenant(tenantId, async (tx) => {
      const locked = await selectPublishable(tx, schema, after === undefined ? { limit: batchSize } : { limit: batchSize, after });
      const { rows, blocked } = await dropBlockedRows(tx, schema, locked);
      return { size: locked.length, last: locked.at(-1)?.seq, blocked, summary: await publishLockedRows(tx, runtime, rows) };
    });
    totals.published += page.summary.published;
    totals.failed += page.summary.failed;
    totals.skipped += page.summary.skipped + page.blocked;
    if (page.size < batchSize || page.last === undefined) return;
    after = page.last;
  }
}

/** Publishes the unpublished, unheld rows of every listed tenant in its own transactions, then runs the recovery hooks in order. */
export async function sweepOutbox(runtime: OutboxRuntime, opts: SweepOutboxOptions): Promise<SweepResult> {
  const { service, clock, batchSize = DEFAULT_BATCH_SIZE, recoveryHooks = [] } = opts;
  const result: SweepResult = { published: 0, failed: 0, skipped: 0, tenants: 0, hooks: [] };
  // Case-folded as withTenant folds them, so one tenant is never swept twice.
  const tenantIds = new Set((await (opts.tenantsOf ?? registryTenants)(runtime.db)).map((id) => id.toLowerCase()));
  // Sequential, so the sweep holds at most one pooled connection at a time.
  for (const tenantId of tenantIds) {
    try {
      await sweepTenant(runtime, tenantId, batchSize, result);
      result.tenants += 1;
    } catch (err) {
      runtime.logger.error({ tenantId, error: serializeError(err) }, 'outbox sweep failed for tenant');
    }
  }
  for (const hook of recoveryHooks) {
    try {
      await hook.run({ service, runtime, clock, logger: runtime.logger });
      result.hooks.push({ name: hook.name, ok: true });
    } catch (err) {
      // log-record.v1 admits no hook field, so the hook is named in the message.
      runtime.logger.error({ error: serializeError(err) }, `outbox sweep recovery hook ${hook.name} failed`);
      result.hooks.push({ name: hook.name, ok: false });
    }
  }
  return result;
}

function registeredRuntime(app: FastifyInstance): OutboxRuntime {
  const { db } = app.opt2;
  if (db === undefined) {
    throw new TypeError('registerOutboxSweep needs opts.runtime when the service has no database');
  }
  return outboxRuntimeFor(db.schema);
}

/** Registers POST `/internal/v1/outbox/sweep` as the chain task of the service's sweep queue: successor first, then the sweep. */
export function registerOutboxSweep(app: FastifyInstance, opts: RegisterOutboxSweepOptions): void {
  const { service, port, recoveryHooks, tenantsOf, batchSize } = opts;
  // Resolved at registration, so a service that never called createOutbox fails at start-up rather than on its first sweep.
  const runtime = opts.runtime ?? registeredRuntime(app);
  const clock = opts.clock ?? app.opt2.clock;
  const spec = recurringSpec(opts.queue ?? outboxSweepQueue(service), opts.serviceUrls ?? app.opt2.env.OPT2_SERVICE_URLS);
  registerTaskRoute(app, OUTBOX_SWEEP_PATH, {
    scope: 'system',
    handler: recurringHandler({ ...spec, port, clock }, () =>
      sweepOutbox(runtime, { service, clock, recoveryHooks, tenantsOf, batchSize }),
    ),
  });
}
