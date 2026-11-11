// Appends and upserts entries in the migration service's run logs, `windows.json` and `transitions.json`.
import path from 'node:path';

import { projectReportValue } from './redact.js';
import { readJsonReport, writeJsonReport, type ReportClock, type ReportTarget } from './write-report.js';

/** Phase a write window is in, recorded with the time it was entered. */
export type WindowPhaseName = 'quiet' | 'executing' | 'importing' | 'import-pending' | 'closed';

/** What opened a write window. */
export type WindowKind = 'request' | 'startup' | 'reload' | 'sitemonitor-step';

/** How a write window ended. */
export type WindowOutcome = 'closed' | 'aborted-503' | 'import-pending' | 'resolved-by-operator';

/** One write window; `units` are `<schema>.<table>` ids and `outcome` is absent while the window is open. */
export interface WindowLogEntry {
  windowId: string;
  holderId: string;
  kind: WindowKind;
  routeKey: string;
  units: string[];
  scope: { siteid?: string; userid?: string; contentid?: string; table?: boolean };
  phases: { phase: WindowPhaseName; at: string }[];
  durationMs?: number;
  rowsImported?: Record<string, number>;
  outcome?: WindowOutcome;
}

/** The transition steps, in execution order. */
export const TRANSITION_STEP_NAMES = [
  'transition-set',
  'stop-new-work',
  'confirm-inflight-finished',
  'drain-effects',
  'close-gates',
  'final-state-and-reconcile',
  'activate',
  'hand-off-and-reopen',
] as const;

/** Name of one transition step. */
export type TransitionStepName = (typeof TRANSITION_STEP_NAMES)[number];

/** One cut-over transition; `setT` holds the units whose authority it changes. */
export interface TransitionLogEntry {
  transitionId: string;
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  setT: string[];
  entriesChanged: string[];
  legacyWriteEntries: string[];
  steps: { step: number; name: TransitionStepName; startedAt: string; finishedAt?: string; result?: string }[];
  reconciliation?: unknown;
  outcome?: 'activated' | 'aborted';
  abortReason?: string;
}

/** Run log files under the reports directory. */
export type RunLogFile = 'windows.json' | 'transitions.json';

/** Window duration above which a window is flagged. */
export const WINDOW_FLAG_THRESHOLD_MS = 5000;

/** Counts written as the `summary` of `windows.json`. */
export interface WindowSummary {
  count: number;
  byOutcome: Record<string, number>;
  overThreshold: number;
}

/** Where a run log keeps its entries and which head and default fields it is written with. */
export interface RunLogDescriptor {
  collectionKey: string;
  idKey?: string;
  generatedBy?: string;
  defaults?: Readonly<Record<string, unknown>>;
  // Method syntax keeps the parameter bivariant, so a summariser typed over its own entry type fits.
  summarise?(entries: unknown[], thresholdMs?: number): unknown;
}

/** Counts windows by outcome (`open` while unset) and those whose duration exceeds `thresholdMs`. */
export function summariseWindows(entries: WindowLogEntry[], thresholdMs = WINDOW_FLAG_THRESHOLD_MS): WindowSummary {
  const byOutcome = new Map<string, number>();
  let overThreshold = 0;
  for (const entry of entries) {
    const outcome = entry.outcome ?? 'open';
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    if (entry.durationMs !== undefined && entry.durationMs > thresholdMs) overThreshold += 1;
  }
  return { count: entries.length, byOutcome: Object.fromEntries(byOutcome), overThreshold };
}

/** Descriptor of each run log. */
export const RUN_LOGS: Readonly<Record<RunLogFile, RunLogDescriptor>> = {
  'windows.json': {
    collectionKey: 'windows',
    idKey: 'windowId',
    generatedBy: 'migration/src/windows/',
    defaults: { flagThresholdMs: WINDOW_FLAG_THRESHOLD_MS },
    summarise: summariseWindows,
  },
  'transitions.json': {
    collectionKey: 'transitions',
    idKey: 'transitionId',
    generatedBy: 'migration/src/transition/',
  },
};

const FALLBACK_LOG: RunLogDescriptor = { collectionKey: 'entries' };
const HEAD_KEYS = new Set(['sourceSha', 'generatedBy', 'generatedAt', 'status']);
const queues = new Map<string, Promise<unknown>>();
const ignore = (): void => undefined;

function descriptorFor(file: string): RunLogDescriptor {
  return Object.hasOwn(RUN_LOGS, file) ? RUN_LOGS[file as RunLogFile] : FALLBACK_LOG;
}

/** Runs `fn` once every earlier call for `key` has settled; in-process only. */
function serialise<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const start = (): Promise<T> => fn();
  const result = (queues.get(key) ?? Promise.resolve()).then(start, start);
  const tail = result.then(ignore, ignore);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

/** Rewrites `file` with its collection changed by `mutate`, keeping every other non-head key. */
async function update(
  target: ReportTarget,
  file: string,
  mutate: (entries: unknown[]) => void,
  opts: { clock?: ReportClock } | undefined,
): Promise<void> {
  const descriptor = descriptorFor(file);
  const doc = (await readJsonReport(target.reportsDir, file)) ?? {};
  const current: unknown = doc[descriptor.collectionKey];
  const entries: unknown[] = Array.isArray(current) ? [...(current as unknown[])] : [];
  mutate(entries);
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(doc).filter(([key]) => !HEAD_KEYS.has(key)));
  for (const [key, value] of Object.entries(descriptor.defaults ?? {})) {
    if (!Object.hasOwn(body, key)) body[key] = value;
  }
  body[descriptor.collectionKey] = entries;
  if (descriptor.summarise) {
    const threshold = typeof body.flagThresholdMs === 'number' ? body.flagThresholdMs : undefined;
    body.summary = descriptor.summarise(entries, threshold);
  }
  // A log without a descriptor keeps the generatedBy it already carries.
  const generatedBy = descriptor.generatedBy ?? (typeof doc.generatedBy === 'string' ? doc.generatedBy : undefined);
  await writeJsonReport(target, file, body, { clock: opts?.clock, generatedBy, status: 'recorded' });
}

function logKey(target: ReportTarget, file: string): string {
  return path.resolve(target.reportsDir, file);
}

/** Appends `entry` to the run log `file` under `target.reportsDir`. */
export function appendLogEntry<E extends object>(
  target: ReportTarget,
  file: RunLogFile | string,
  entry: E,
  opts?: { clock?: ReportClock },
): Promise<void> {
  return serialise(logKey(target, file), () =>
    update(
      target,
      file,
      (entries) => {
        entries.push(entry);
      },
      opts,
    ),
  );
}

/** Replaces, in place, the first entry of `file` whose `idKey` equals `entry[idKey]` as written, or appends `entry`. */
export function upsertLogEntry<E extends object>(
  target: ReportTarget,
  file: RunLogFile | string,
  idKey: keyof E & string,
  entry: E,
  opts?: { clock?: ReportClock },
): Promise<void> {
  const idOf = (value: unknown): unknown =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[idKey] : undefined;
  return serialise(logKey(target, file), () =>
    update(
      target,
      file,
      (entries) => {
        // Stored entries hold their projected ids, so the new id is compared in the same form; a throw rejects the call.
        const id = projectReportValue(entry[idKey], idKey);
        const index = entries.findIndex((existing) => idOf(existing) === id);
        if (index === -1) entries.push(entry);
        else entries[index] = entry;
      },
      opts,
    ),
  );
}

/** Entries of the run log `file` under `reportsDir`, or `[]` when the file does not exist. */
export async function readLogEntries<E = Record<string, unknown>>(
  reportsDir: string,
  file: RunLogFile | string,
): Promise<E[]> {
  const doc = await readJsonReport(reportsDir, file);
  const entries: unknown = doc?.[descriptorFor(file).collectionKey];
  return Array.isArray(entries) ? (entries as E[]) : [];
}
