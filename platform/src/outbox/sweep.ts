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
import {
  PUBLISH_STALL_MS,
  dropBlockedRows,
  outboxRuntimeFor,
  publishLockedRows,
  publishPass,
  selectPublishable,
  type OutboxRuntime,
  type PublishPass,
} from './flush.js';
import { registryTenants, type TenantsOf } from './stats.js';

const DEFAULT_BATCH_SIZE = 500;

/** Longest a sweep publishes before it leaves the remaining rows to the next sweep, within the sweep task's 60 s dispatch deadline. */
export const SWEEP_PUBLISH_DEADLINE_MS = 30_000;

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

/** Totals of one sweep: publish outcomes of every batch, tenants swept to the end without error, and each hook's outcome in run order. */
export interface SweepResult {
  published: number;
  failed: number;
  skipped: number;
  tenants: number;
  hooks: { name: string; ok: boolean }[];
}

/**
 * Options of {@link sweepOutbox}; `tenantsOf` defaults to the service's `tenant_registry`, `batchSize` to 500,
 * `publishStallMs` to PUBLISH_STALL_MS and `publishDeadlineMs` to SWEEP_PUBLISH_DEADLINE_MS.
 */
export interface SweepOutboxOptions {
  service: string;
  clock: Clock;
  tenantsOf?: TenantsOf;
  batchSize?: number;
  recoveryHooks?: readonly RecoveryHook[];
  /** Longest wait for one publish; the first publish unconfirmed by then ends the sweep. */
  publishStallMs?: number;
  /** Time from the sweep's start after which it publishes nothing more. */
  publishDeadlineMs?: number;
}

// Pages by seq, so a blocked or failed row is not re-selected within one sweep; a short batch or an aborted pass ends the tenant.
async function sweepTenant(pass: PublishPass, tenantId: string, batchSize: number, totals: SweepResult): Promise<void> {
  const { runtime, signal } = pass;
  const { schema } = runtime.db;
  let after: string | undefined;
  while (!signal.aborted) {
    const page = await runtime.db.withTenant(tenantId, async (tx) => {
      const locked = await selectPublishable(tx, schema, after === undefined ? { limit: batchSize } : { limit: batchSize, after });
      const { rows, blocked } = await dropBlockedRows(tx, schema, locked);
      return { size: locked.length, last: locked.at(-1)?.seq, blocked, summary: await publishLockedRows(tx, runtime, rows, { signal }) };
    });
    totals.published += page.summary.published;
    totals.failed += page.summary.failed;
    totals.skipped += page.summary.skipped + page.blocked;
    if (page.size < batchSize || page.last === undefined) return;
    after = page.last;
  }
}

/**
 * Publishes the unpublished, unheld rows of every listed tenant in its own transactions, then runs the recovery hooks in order.
 * A stalled publish or the publish deadline ends publishing with one warning, leaving the unpublished rest to the next sweep.
 */
export async function sweepOutbox(runtime: OutboxRuntime, opts: SweepOutboxOptions): Promise<SweepResult> {
  const {
    service,
    clock,
    batchSize = DEFAULT_BATCH_SIZE,
    recoveryHooks = [],
    publishStallMs = PUBLISH_STALL_MS,
    publishDeadlineMs = SWEEP_PUBLISH_DEADLINE_MS,
  } = opts;
  const result: SweepResult = { published: 0, failed: 0, skipped: 0, tenants: 0, hooks: [] };
  const pass = publishPass(runtime, publishStallMs, AbortSignal.timeout(publishDeadlineMs));
  // Case-folded as withTenant folds them, so one tenant is never swept twice.
  const tenantIds = new Set((await (opts.tenantsOf ?? registryTenants)(runtime.db)).map((id) => id.toLowerCase()));
  // Sequential, so the sweep holds at most one pooled connection at a time.
  for (const tenantId of tenantIds) {
    try {
      await sweepTenant(pass, tenantId, batchSize, result);
      if (!pass.signal.aborted) result.tenants += 1;
    } catch (err) {
      runtime.logger.error({ tenantId, error: serializeError(err) }, 'outbox sweep failed for tenant');
    }
    if (pass.signal.aborted) {
      runtime.logger.warn(
        { tenantId, error: serializeError(pass.signal.reason) },
        pass.stalled()
          ? `outbox sweep ended early after a publish stalled for ${String(publishStallMs)} ms`
          : `outbox sweep ended early at its ${String(publishDeadlineMs)} ms publish deadline`,
      );
      break;
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
