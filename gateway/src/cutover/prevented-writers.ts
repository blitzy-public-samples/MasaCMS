// Closed list of the non-request legacy writers that are prevented from writing outside a write window.
import type { WriterTrigger } from './types.js';

/** Inventory writer fields an entry matches: `component` (or `source.path`), the method when named, an overlapping inclusive line span when named. */
export interface PreventedWriterMatch {
  readonly component: string;
  readonly method?: string;
  readonly lines?: readonly [number, number];
}

/** A known non-request legacy writer and the mechanism that closes it before it can run. */
export interface PreventedWriter {
  readonly id: string;
  readonly trigger: Exclude<WriterTrigger, 'request'>;
  readonly mechanism: string;
  readonly match: PreventedWriterMatch;
  readonly alsoMatch?: readonly PreventedWriterMatch[];
}

/** Writer record shape `isPreventedWriter` reads; `source.lines` is a `[first, last]` tuple or a `"first-last"` string. */
export interface WriterRecord {
  readonly component: string;
  readonly method?: string;
  readonly trigger: string;
  readonly source?: { readonly path?: string; readonly lines?: readonly [number, number] | string };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Every prevented non-request writer; any other non-request writer of a target-authoritative unit is a validator finding. */
export const PREVENTED_WRITERS: readonly PreventedWriter[] = deepFreeze<PreventedWriter[]>([
  {
    id: 'scheduler-registration',
    trigger: 'appstart',
    mechanism:
      'ColdFusion always starts with MURA_PING=false (harness/repro/lib/legacy-start.sh), so Masa never registers or re-registers the siteMonitor task on start-up, reload or re-initialisation.',
    match: { component: 'core/appcfc/onApplicationStart_include.cfm', lines: [561, 575] },
  },
  {
    id: 'native-sitemonitor-task',
    trigger: 'scheduler',
    mechanism:
      "The native ACF siteMonitor task stays paused until the gateway serves v0001, then scheduler.cfm?op=repoint re-points it at the gateway's /_api/sitemonitor/, so every run is dispatched by the active version and windowed.",
    match: { component: 'core/mura/content/contentServer.cfc', method: 'handleAPIRequest', lines: [669, 747] },
  },
  {
    id: 'fixture-survey-tasks',
    trigger: 'scheduler',
    mechanism:
      'The fixture registers its opt2-survey-* cfschedule tasks against OPT2_GATEWAY_ORIGIN, so their runs are dispatched like any request, and scheduler.cfm?op=pause pauses them before the transition that moves the surveys units.',
    match: { component: 'legacy-fixtures/cfml/modules/surveys.cfc', method: 'handle', lines: [37, 42] },
  },
  {
    id: 'fixture-export-threads',
    trigger: 'thread',
    mechanism:
      'The transition that moves the reporting units waits until every opt2-export-* cfthread job has left queued and running (bounded at 10 minutes) before it closes their gates.',
    // No line span: every thread-triggered record the inventory attributes to createExport belongs to these jobs.
    match: { component: 'legacy-fixtures/cfml/modules/reporting.cfc', method: 'createExport' },
    // usp_export_job_transition runs only inside the job thread (reporting.cfc runExport -> moveJob), so its
    // thread-triggered writes are these jobs' writes and the same wait closes them.
    alsoMatch: [{ component: 'legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql' }],
  },
  {
    id: 'startup-url-conversion',
    trigger: 'appstart',
    mechanism:
      'Start-up guard: harness/repro/lib/legacy-start.sh windows every ColdFusion start, ?appreload is a legacy-write entry run inside a window, and the migration service keeps the start-up predicate (active File or Link tcontent rows with a null body and a filename) empty whenever a legacy request can run.',
    match: { component: 'core/appcfc/onApplicationStart_include.cfm', lines: [892, 929] },
  },
]);

function lineSpan(lines: readonly [number, number] | string | undefined): readonly [number, number] | undefined {
  if (typeof lines !== 'string') return lines;
  const found = /^(\d+)-(\d+)$/.exec(lines.trim());
  return found ? [Number(found[1]), Number(found[2])] : undefined;
}

function matches(match: PreventedWriterMatch, writer: WriterRecord, span: readonly [number, number] | undefined): boolean {
  if (writer.component !== match.component && writer.source?.path !== match.component) return false;
  if (match.method !== undefined && writer.method !== match.method) return false;
  if (match.lines === undefined) return true;
  return span !== undefined && span[0] <= match.lines[1] && match.lines[0] <= span[1];
}

/** The prevented-writer entry covering an inventory writer record, or `undefined` (always for `request` writers). */
export function isPreventedWriter(writer: WriterRecord): PreventedWriter | undefined {
  const span = lineSpan(writer.source?.lines);
  return PREVENTED_WRITERS.find(
    (entry) =>
      entry.trigger === writer.trigger &&
      [entry.match, ...(entry.alsoMatch ?? [])].some((match) => matches(match, writer, span)),
  );
}
