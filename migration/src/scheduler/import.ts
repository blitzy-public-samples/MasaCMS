/** Imports the native ColdFusion scheduler capture into `migration.scheduler_state`, idempotently. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z, type Clock } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { MigrationEnv } from '../env.js';
import {
  SCHEDULER_KEYS,
  SchedulerStateConflictError,
  isSiteMonitorTask,
  nativeTaskSchema,
  updateSchedulerKey,
  type NativeTask,
  type NativeTasksRecord,
  type SchedulerDb,
} from './state.js';

/** File name of the first-run capture in `${OPT2_PRISTINE_DIR}`. */
export const NATIVE_TASKS_FILE_NAME = 'native-tasks.json';

/** `${OPT2_PRISTINE_DIR}/native-tasks.json`; an unset directory takes the reproducibility default `$HOME/.opt2/pristine`. */
export function defaultNativeTasksFile(env: Pick<MigrationEnv, 'OPT2_PRISTINE_DIR'>): string {
  return path.join(env.OPT2_PRISTINE_DIR ?? path.join(homedir(), '.opt2', 'pristine'), NATIVE_TASKS_FILE_NAME);
}

/**
 * The first-run capture of ColdFusion's scheduled tasks, as `harness/repro/up.sh` writes `native-tasks.json` (never overwritten):
 * - `capturedAt`: ISO-8601 date-time with `Z` or an offset, taken before ColdFusion is restarted with `MURA_PING=false`;
 *   `null` only for an HTTP import, whose body carries no capture time;
 * - `originalPing`: Masa's `ping` setting as it was then, `null` when unknown;
 * - `siteMonitorTask`: optional name of Masa's monitor task (`scheduler.describe` reports it);
 * - `tasks`: every task in the bridge wire shape
 *   `{task, group, url, port, interval, startDate, startTime, requestTimeOut, operation, paused}`.
 *
 * The import also accepts a `box cfconfig export` document carrying `capturedAt`, `ping` and `scheduledTasks` (an array, or an
 * object keyed by task name), and the `SchedulerImportRequest` body `{nativeTasks, ping}`.
 */
export interface NativeTasksFile {
  capturedAt: string | null;
  originalPing: boolean | string | null;
  siteMonitorTask?: string | null;
  tasks: NativeTask[];
}

/** Schema of a capture in the `native-tasks.json` form. */
export const nativeTasksFileSchema = z.object({
  capturedAt: z.iso.datetime({ offset: true }).nullable(),
  originalPing: z.union([z.boolean(), z.string()]).nullable(),
  siteMonitorTask: z.string().min(1).nullable().default(null),
  tasks: z.array(nativeTaskSchema),
}) satisfies z.ZodType<NativeTasksFile>;

/**
 * Outcome of an import; `unchanged` means the stored capture already had this digest and nothing was written.
 * The HTTP `SchedulerState` answer also carries the quiesce-owned background state, so the route composes it from the stored records.
 */
export interface SchedulerImportResult {
  imported: boolean;
  reason: 'imported' | 'replaced' | 'unchanged';
  /** The capture contains Masa's site-monitor task, so the target's recurring monitor chain may be enabled at hand-off. */
  nativeExisted: boolean;
  siteMonitorTask: string | null;
  taskCount: number;
  sourceSha256: string;
}

/** Raised when a capture is not valid JSON or fails its schema. */
export class SchedulerImportError extends Error {
  override readonly name = 'SchedulerImportError';
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numbers become strings and absent values `""`, as the bridge wire shape has them; other values are left to the schema. */
function wireString(value: unknown): unknown {
  if (value === undefined || value === null) return '';
  return typeof value === 'number' ? String(value) : value;
}

/** Maps one `box cfconfig export` task record, which names the URL `URL` and the port `httpPort`, to the wire shape. */
function exportedTask(entry: unknown, key?: string): unknown {
  if (!isRecord(entry)) return entry;
  const { status } = entry;
  return {
    task: entry.task ?? key,
    group: wireString(entry.group),
    url: wireString(entry.url ?? entry.URL),
    port: wireString(entry.port ?? entry.httpPort),
    interval: wireString(entry.interval),
    startDate: wireString(entry.startDate),
    startTime: wireString(entry.startTime),
    requestTimeOut: wireString(entry.requestTimeOut),
    operation: entry.operation ?? 'HTTPRequest',
    paused: typeof entry.paused === 'boolean' ? entry.paused : typeof status === 'string' && status.toLowerCase() === 'paused',
  };
}

function exportedTasks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => exportedTask(entry));
  return isRecord(value) ? Object.entries(value).map(([key, entry]) => exportedTask(entry, key)) : value;
}

/** The capture in the `native-tasks.json` form, before schema validation. */
function fileShapeOf(raw: unknown): unknown {
  if (!isRecord(raw)) {
    throw new SchedulerImportError('The native task capture must be a JSON object');
  }
  if (Array.isArray(raw.tasks)) return raw;
  if (raw.scheduledTasks !== undefined) {
    return {
      capturedAt: raw.capturedAt,
      originalPing: raw.ping ?? null,
      siteMonitorTask: raw.siteMonitorTask ?? null,
      tasks: exportedTasks(raw.scheduledTasks),
    };
  }
  if (Array.isArray(raw.nativeTasks)) {
    return { capturedAt: null, originalPing: raw.ping, siteMonitorTask: null, tasks: exportedTasks(raw.nativeTasks) };
  }
  throw new SchedulerImportError('The native task capture has no tasks, scheduledTasks or nativeTasks array');
}

/**
 * Validates a capture in any accepted form and returns it in the `native-tasks.json` form, tasks sorted by name then group.
 * @throws SchedulerImportError naming every schema issue.
 */
export function normaliseNativeTasksFile(raw: unknown): NativeTasksFile {
  const parsed = nativeTasksFileSchema.safeParse(fileShapeOf(raw));
  if (!parsed.success) {
    throw new SchedulerImportError(`The native task capture fails its schema: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  const tasks = [...parsed.data.tasks].sort((a, b) => compare(a.task, b.task) || compare(a.group, b.group));
  return { ...parsed.data, tasks };
}

/** JSON with object keys sorted recursively and no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Lowercase hex SHA-256 of a normalised capture's canonical JSON.
 * `capturedAt` is left out, because an HTTP body cannot carry it and the same tasks and `ping` are the same capture.
 */
export function nativeTasksDigest(doc: NativeTasksFile): string {
  const content = { originalPing: doc.originalPing, siteMonitorTask: doc.siteMonitorTask ?? null, tasks: doc.tasks };
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/**
 * Stores a capture as the `nativeTasks` record and the site-monitor definition it holds, in one transaction.
 * @param raw any form `normaliseNativeTasksFile` accepts, the `SchedulerImportRequest` body included.
 * @throws SchedulerImportError when `raw` is invalid.
 * @throws SchedulerStateConflictError when a different capture arrives after the site monitor was handed off to the target.
 */
export async function importNativeTasks(
  deps: { db: SchedulerDb; clock: Clock },
  raw: unknown,
): Promise<SchedulerImportResult> {
  const doc = normaliseNativeTasksFile(raw);
  const sourceSha256 = nativeTasksDigest(doc);
  const siteMonitor = doc.tasks.find((task) => isSiteMonitorTask(task, doc.siteMonitorTask)) ?? null;
  const siteMonitorTask = siteMonitor?.task ?? doc.siteMonitorTask ?? null;
  const now = deps.clock.now();
  const importedAt = now.toISOString();
  const nativeExisted = siteMonitor !== null;

  const reason = await deps.db.withMetadata(async (tx): Promise<SchedulerImportResult['reason']> => {
    // Both keys are locked through state.ts inside this one transaction, so a conflict also undoes the capture write.
    const inTx: SchedulerDb = { withMetadata: (fn) => fn(tx) };
    const seen: { previous: NativeTasksRecord | null } = { previous: null };
    const stored = await updateSchedulerKey(
      inTx,
      SCHEDULER_KEYS.nativeTasks,
      (current) => {
        seen.previous = current;
        if (current?.sourceSha256 === sourceSha256) return current;
        return {
          // An HTTP import carries no capture time; the import time bounds it.
          capturedAt: doc.capturedAt ?? importedAt,
          originalPing: doc.originalPing,
          siteMonitorTask,
          tasks: doc.tasks,
          sourceSha256,
          importedAt,
        };
      },
      now,
    );
    if (stored === seen.previous) return 'unchanged';

    await updateSchedulerKey(
      inTx,
      SCHEDULER_KEYS.siteMonitor,
      (current) => {
        if (current.state === 'target') {
          throw new SchedulerStateConflictError(
            SCHEDULER_KEYS.siteMonitor,
            'the site monitor was handed off to the target, so its capture can no longer be replaced',
          );
        }
        return {
          ...current,
          nativeExisted,
          originalPing: doc.originalPing,
          definition: siteMonitor,
          state: 'legacy',
          updatedAt: importedAt,
        };
      },
      now,
    );
    return seen.previous === null ? 'imported' : 'replaced';
  });

  return { imported: reason !== 'unchanged', reason, nativeExisted, siteMonitorTask, taskCount: doc.tasks.length, sourceSha256 };
}

/**
 * Reads `file` (`opt2-migrate scheduler import --file`) and imports it with `importNativeTasks`; a missing file's error propagates.
 * @throws SchedulerImportError when `file` is not valid JSON, naming the path.
 */
export async function importSchedulerState(
  ctx: Pick<MigrationContext, 'db' | 'clock' | 'logger'>,
  file: string,
): Promise<SchedulerImportResult> {
  const text = await readFile(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SchedulerImportError(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const result = await importNativeTasks(ctx, raw);
  ctx.logger.info(
    `scheduler capture ${file} ${result.reason}: ${String(result.taskCount)} tasks, ` +
      `native site monitor ${result.nativeExisted ? String(result.siteMonitorTask) : 'absent'}, sha256 ${result.sourceSha256}`,
  );
  return result;
}
