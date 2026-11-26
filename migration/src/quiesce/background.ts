// Background suspension of `opt2-ops drain-and-suspend`, persisted under key `background` of `migration.scheduler_state`.
import { z } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';
import { SCHEDULER_STATE_TABLE, SchedulerStateError, type BackgroundStateView } from '../scheduler/index.js';
import type { SavedPushConfig } from './subscriptions.js';

/** Row key of the background record; `scheduler/state.ts` never reads or writes it. */
export const BACKGROUND_KEY = 'background';

const stampSchema = z.iso.datetime({ offset: true });

const savedPushConfigSchema = z.record(z.string(), z.unknown()) satisfies z.ZodType<SavedPushConfig>;

/** Schema of the background record, the contract's `BackgroundRecord`. */
export const backgroundRecordSchema = z.object({
  suspended: z.boolean(),
  since: stampSchema.nullable(),
  reason: z.string().nullable(),
  /** Push config per subscription id before the switch to pull; values survive jsonb exactly, key order does not. */
  pushConfigs: z.record(z.string(), savedPushConfigSchema),
  pausedQueues: z.array(z.object({ service: z.string().min(1), queue: z.string().min(1) }).strict()),
  /** ACF task names `SchedulerService.pauseAll()` reported paused. */
  pausedTasks: z.array(z.string()),
  resumedAt: stampSchema.nullable().optional(),
}) satisfies z.ZodType<components['schemas']['BackgroundRecord']>;

/** What drain-and-suspend paused, so resume restores exactly that. */
export type BackgroundRecord = z.infer<typeof backgroundRecordSchema>;

/** The record while nothing is suspended; also what `get()` returns when no row exists. */
export function defaultBackgroundRecord(): BackgroundRecord {
  return { suspended: false, since: null, reason: null, pushConfigs: {}, pausedQueues: [], pausedTasks: [] };
}

/** The contract's `BackgroundState` view of `record`; a null `since` is omitted. */
export function backgroundStateView(record: BackgroundRecord): BackgroundStateView {
  return record.since === null ? { suspended: record.suspended } : { suspended: record.suspended, since: record.since };
}

/** Reads and writes the background record. */
export interface BackgroundStateApi {
  /** Whether background work is suspended; one small query. */
  isSuspended(): Promise<boolean>;
  /** The stored record, or the default when no row exists. @throws SchedulerStateError when the stored value fails its schema. */
  get(): Promise<BackgroundRecord>;
  /** Stores `record` as suspended, `since` defaulting to now; the latest write wins. @returns the stored record. */
  suspend(record: BackgroundRecord): Promise<BackgroundRecord>;
  /** Stores the default record with `resumedAt` = now. @returns the stored record. */
  resume(): Promise<BackgroundRecord>;
}

const SELECT_SQL = `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`;
const UPSERT_SQL =
  `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ` +
  'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at';

function parseStored(value: unknown): BackgroundRecord {
  const parsed = backgroundRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new SchedulerStateError(
      BACKGROUND_KEY,
      `The stored ${BACKGROUND_KEY} scheduler state fails its schema: ${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/** The background record in the `migration` schema, read and written in non-tenant transactions. */
export function createBackgroundState(ctx: Pick<MigrationContext, 'db' | 'clock'>): BackgroundStateApi {
  const get = async (): Promise<BackgroundRecord> => {
    const { rows } = await ctx.db.withMetadata((tx) => tx.query<{ value: unknown }>(SELECT_SQL, [BACKGROUND_KEY]));
    const row = rows[0];
    return row === undefined ? defaultBackgroundRecord() : parseStored(row.value);
  };
  const store = async (record: BackgroundRecord): Promise<BackgroundRecord> => {
    await ctx.db.withMetadata((tx) => tx.query(UPSERT_SQL, [BACKGROUND_KEY, JSON.stringify(record)]));
    return record;
  };
  return {
    get,
    isSuspended: async () => (await get()).suspended,
    suspend: (record) => store({ ...record, suspended: true, since: record.since ?? ctx.clock.now().toISOString() }),
    resume: () => store({ ...defaultBackgroundRecord(), resumedAt: ctx.clock.now().toISOString() }),
  };
}

/** Callee name of the migration service in the service client's URL map. */
const MIGRATION_SERVICE = 'migration';

interface BackgroundOperation {
  readonly operationId: keyof operations;
  readonly path: keyof paths;
}

const OPERATIONS = Object.freeze({
  suspend: { operationId: 'backgroundSuspend', path: '/internal/v1/background:suspend' },
  resume: { operationId: 'backgroundResume', path: '/internal/v1/background:resume' },
} as const satisfies Record<string, BackgroundOperation>);

type SuspendBody = operations['backgroundSuspend']['requestBody']['content']['application/json'];

/** The migration service answered a background operation outside 2xx; `body` is its answer unchanged. */
export class BackgroundCallError extends Error {
  override readonly name: string = 'BackgroundCallError';

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const message = (body as { error?: { message?: unknown } } | null | undefined)?.error?.message;
    super(`Migration ${operation} answered HTTP ${String(status)}${typeof message === 'string' ? `: ${message}` : ''}`);
  }
}

/**
 * The background record for processes other than the migration service: reads use the database; suspend and resume go to the running service as `platform.operator`.
 * @throws BackgroundCallError from suspend and resume on a non-2xx answer.
 */
export function remoteBackgroundState(ctx: Pick<MigrationContext, 'db' | 'clock' | 'clientAs'>): BackgroundStateApi {
  const local = createBackgroundState(ctx);
  const post = async (operation: BackgroundOperation, json?: SuspendBody): Promise<BackgroundRecord> => {
    const response = await ctx
      .clientAs('operator')
      .request<BackgroundStateView>({ service: MIGRATION_SERVICE, method: 'POST', path: operation.path, json, userToken: null });
    if (response.status < 200 || response.status > 299) {
      throw new BackgroundCallError(operation.operationId, response.status, response.body);
    }
    return local.get();
  };
  return {
    get: local.get,
    isSuspended: local.isSuspended,
    suspend: (record) => post(OPERATIONS.suspend, record),
    resume: () => post(OPERATIONS.resume),
  };
}
