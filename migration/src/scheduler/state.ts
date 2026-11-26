/** Scheduler hand-off records, their schemas and the only read/write path to `migration.scheduler_state`. */
import { z } from '@opt2/platform/service-kit';
import type { MetadataTx, TenantDb } from '@opt2/platform/tenancy';
import type { ScheduledTaskDefinition } from '../legacy/index.js';

/** Qualified name of the scheduler state table. */
export const SCHEDULER_STATE_TABLE = 'migration.scheduler_state';

/** Row keys this module owns; `background` belongs to the quiesce module and is never read or written here. */
export const SCHEDULER_KEYS = {
  siteMonitor: 'sitemonitor',
  nativeTasks: 'nativeTasks',
} as const;

/** A scheduler state row key. */
export type SchedulerKey = (typeof SCHEDULER_KEYS)[keyof typeof SCHEDULER_KEYS];

/** An ACF scheduled task in the bridge wire shape. */
export type NativeTask = ScheduledTaskDefinition;

/** Who paused the ACF tasks: a transition's quiesce step, or `opt2-ops drain-and-suspend`. */
export type PauseReason = 'transition' | 'suspend';

/** Hand-off state of Masa's native `siteMonitor` task (key `sitemonitor`). */
export interface SiteMonitorRecord {
  /** The first-run capture contained Masa's monitor task. */
  nativeExisted: boolean;
  /** Masa's `ping` setting as captured before ColdFusion was restarted with `MURA_PING=false`. */
  originalPing: boolean | string | null;
  /** The captured monitor task definition. */
  definition: NativeTask | null;
  /** `application.lastMonitored` in the bridge wire time format, as seeded into programs-sites at hand-off. */
  cursorHandedOff?: string | null;
  state: 'legacy' | 'target';
  nativePaused: PauseReason | null;
  /** The `programs-sites-sitemonitor` queue was paused by a restoration to legacy. */
  targetTriggerDisabled: boolean;
  handedOffAt?: string;
  updatedAt: string;
}

/** The imported first-run capture of every ACF task (key `nativeTasks`). */
export interface NativeTasksRecord {
  capturedAt: string;
  originalPing: boolean | string | null;
  siteMonitorTask: string | null;
  tasks: NativeTask[];
  /** Lowercase hex SHA-256 of the normalised capture. */
  sourceSha256: string;
  importedAt: string;
}

/** The record type stored under each key. */
export interface SchedulerRecordMap {
  sitemonitor: SiteMonitorRecord;
  nativeTasks: NativeTasksRecord;
}

/** The value `updateSchedulerKey` passes to its callback: the stored record, else its default, which is `null` for `nativeTasks`. */
export type SchedulerCurrent<K extends SchedulerKey> = SchedulerRecordMap[K] | (K extends 'nativeTasks' ? null : never);

/** Every record this module owns, with defaults substituted for absent rows; the API's `SchedulerState` view is mapped from it. */
export interface SchedulerStateSnapshot {
  sitemonitor: SiteMonitorRecord;
  nativeTasks: NativeTasksRecord | null;
}

/** The database handle the scheduler state needs. */
export type SchedulerDb = Pick<TenantDb, 'withMetadata'>;

const pingSchema = z.union([z.boolean(), z.string()]).nullable();
const pauseReasonSchema = z.enum(['transition', 'suspend']);
const stampSchema = z.iso.datetime({ offset: true });

/** Schema of a task in the bridge wire shape. */
export const nativeTaskSchema = z.object({
  task: z.string().min(1),
  group: z.string(),
  url: z.string(),
  port: z.string(),
  interval: z.string(),
  startDate: z.string(),
  startTime: z.string(),
  requestTimeOut: z.string(),
  operation: z.string(),
  paused: z.boolean(),
  expired: z.boolean().optional(),
}) satisfies z.ZodType<NativeTask>;

/** Schema of the `sitemonitor` record. */
export const siteMonitorRecordSchema = z.object({
  nativeExisted: z.boolean(),
  originalPing: pingSchema,
  definition: nativeTaskSchema.nullable(),
  cursorHandedOff: z.string().nullable().optional(),
  state: z.enum(['legacy', 'target']),
  nativePaused: pauseReasonSchema.nullable(),
  targetTriggerDisabled: z.boolean(),
  handedOffAt: stampSchema.optional(),
  updatedAt: stampSchema,
}) satisfies z.ZodType<SiteMonitorRecord>;

/** Schema of the `nativeTasks` record. */
export const nativeTasksRecordSchema = z.object({
  capturedAt: z.string().min(1),
  originalPing: pingSchema,
  siteMonitorTask: z.string().nullable(),
  tasks: z.array(nativeTaskSchema),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  importedAt: stampSchema,
}) satisfies z.ZodType<NativeTasksRecord>;

/** The `sitemonitor` record before any capture: no native task, still on legacy. */
export function defaultSiteMonitorRecord(now: Date): SiteMonitorRecord {
  return {
    nativeExisted: false,
    originalPing: null,
    definition: null,
    state: 'legacy',
    nativePaused: null,
    targetTriggerDisabled: false,
    updatedAt: now.toISOString(),
  };
}

/** Raised when a scheduler state value fails its key's schema. */
export class SchedulerStateError extends Error {
  override readonly name = 'SchedulerStateError';
  readonly key: string;

  constructor(key: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.key = key;
  }
}

/** Raised when an operation contradicts the recorded scheduler state. */
export class SchedulerStateConflictError extends Error {
  override readonly name = 'SchedulerStateConflictError';
  readonly key: SchedulerKey;
  readonly reason: string;

  constructor(key: SchedulerKey, reason: string, options?: ErrorOptions) {
    super(`Scheduler state ${key} conflict: ${reason}`, options);
    this.key = key;
    this.reason = reason;
  }
}

const ACF_MONITOR_TASK = /\/index\.cfm\/_api\/sitemonitor\/?$/i;
const MONITOR_URL = /\/_api\/sitemonitor\/?(?:\?|$)/i;

/**
 * True when `task` is Masa's site-monitor task: named `name`, `siteMonitor` (Lucee) or `<webRoot>/index.cfm/_api/sitemonitor/` (ACF),
 * or requesting `/_api/sitemonitor`.
 * @param name the task name `scheduler.describe` reports for Masa's monitor, when known.
 */
export function isSiteMonitorTask(task: Pick<NativeTask, 'task' | 'url'>, name?: string | null): boolean {
  if ((name ?? '') !== '' && task.task === name) {
    return true;
  }
  return task.task.toLowerCase() === 'sitemonitor' || ACF_MONITOR_TASK.test(task.task) || MONITOR_URL.test(task.url);
}

interface KeySpec<K extends SchedulerKey> {
  schema: z.ZodType<SchedulerRecordMap[K]>;
  /** The record carries `updatedAt`, which `updateSchedulerKey` stamps. */
  stamped: boolean;
  fallback: (now: Date) => SchedulerCurrent<K>;
}

const KEY_SPECS: { readonly [K in SchedulerKey]: KeySpec<K> } = {
  sitemonitor: { schema: siteMonitorRecordSchema, stamped: true, fallback: defaultSiteMonitorRecord },
  nativeTasks: { schema: nativeTasksRecordSchema, stamped: false, fallback: () => null },
};

const OWNED_KEYS: readonly SchedulerKey[] = Object.values(SCHEDULER_KEYS);
const SELECT_KEYS_SQL = `SELECT key, value FROM ${SCHEDULER_STATE_TABLE} WHERE key = ANY($1::text[])`;
const SELECT_KEY_SQL = `SELECT value FROM ${SCHEDULER_STATE_TABLE} WHERE key = $1`;
const SELECT_KEY_FOR_UPDATE_SQL = `${SELECT_KEY_SQL} FOR UPDATE`;
// FOR UPDATE locks nothing while the row is absent, so the advisory lock also serialises the first write of a key.
const LOCK_KEY_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const UPSERT_SQL =
  `INSERT INTO ${SCHEDULER_STATE_TABLE} (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ` +
  'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at';

/** The spec of `key`; untyped callers naming another key, such as `background`, are refused before any statement runs. */
function specFor<K extends SchedulerKey>(key: K): KeySpec<K> {
  if (!Object.hasOwn(KEY_SPECS, key)) {
    throw new TypeError(`${String(key)} is not a scheduler state key`);
  }
  return KEY_SPECS[key];
}

function parseRecord<K extends SchedulerKey>(spec: KeySpec<K>, key: K, value: unknown, origin: 'stored' | 'new'): SchedulerRecordMap[K] {
  const parsed = spec.schema.safeParse(value);
  if (!parsed.success) {
    throw new SchedulerStateError(key, `The ${origin} ${key} scheduler state fails its schema: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Reads the record stored under `key`, or `null` when the row is absent; throws SchedulerStateError when it fails its schema. */
export async function readSchedulerKey<K extends SchedulerKey>(db: SchedulerDb, key: K): Promise<SchedulerRecordMap[K] | null> {
  const spec = specFor(key);
  const { rows } = await db.withMetadata((tx) => tx.query<{ value: unknown }>(SELECT_KEY_SQL, [key]));
  const row = rows[0];
  return row === undefined ? null : parseRecord(spec, key, row.value, 'stored');
}

/** Reads every record this module owns in one transaction, substituting defaults stamped with `now` for absent rows. */
export async function readSchedulerState(db: SchedulerDb, now: Date): Promise<SchedulerStateSnapshot> {
  const { rows } = await db.withMetadata((tx) =>
    tx.query<{ key: string; value: unknown }>(SELECT_KEYS_SQL, [OWNED_KEYS]),
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const read = <K extends SchedulerKey>(key: K): SchedulerRecordMap[K] | null =>
    stored.has(key) ? parseRecord(specFor(key), key, stored.get(key), 'stored') : null;
  return {
    sitemonitor: read(SCHEDULER_KEYS.siteMonitor) ?? defaultSiteMonitorRecord(now),
    nativeTasks: read(SCHEDULER_KEYS.nativeTasks),
  };
}

/** Validates `value` against its key's schema and upserts it in `tx`; returns the record as stored. */
export async function writeSchedulerKey<K extends SchedulerKey>(
  tx: MetadataTx,
  key: K,
  value: SchedulerRecordMap[K],
): Promise<SchedulerRecordMap[K]> {
  const record = parseRecord(specFor(key), key, value, 'new');
  await tx.query(UPSERT_SQL, [key, JSON.stringify(record)]);
  return record;
}

/**
 * Locks `key`, passes its record (or default) to `fn` and stores the result with `updatedAt` stamped from `now`, in one transaction.
 * `fn` must not perform side effects; it may throw to abort, and returning `current` itself leaves the row untouched.
 * @returns the stored record, or `current` when `fn` returned it.
 */
export async function updateSchedulerKey<K extends SchedulerKey>(
  db: SchedulerDb,
  key: K,
  fn: (current: SchedulerCurrent<K>) => SchedulerRecordMap[K],
  now: Date,
): Promise<SchedulerRecordMap[K]> {
  const spec = specFor(key);
  return db.withMetadata(async (tx) => {
    await tx.query(LOCK_KEY_SQL, [`${SCHEDULER_STATE_TABLE}:${key}`]);
    const { rows } = await tx.query<{ value: unknown }>(SELECT_KEY_FOR_UPDATE_SQL, [key]);
    const row = rows[0];
    const current: SchedulerCurrent<K> = row === undefined ? spec.fallback(now) : parseRecord(spec, key, row.value, 'stored');
    const next = fn(current);
    if (next === current) {
      return next;
    }
    return writeSchedulerKey(tx, key, spec.stamped ? { ...next, updatedAt: now.toISOString() } : next);
  });
}
