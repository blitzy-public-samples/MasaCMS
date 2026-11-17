// Closed list of the non-request legacy writers that are prevented from writing outside a write window.
import type { WriterTrigger } from './types.js';

/**
 * Inventory writer fields an entry matches: `component` (or `source.path`) or the exact `condition`, or both, plus the
 * method when named and an overlapping inclusive line span when named.
 */
export type PreventedWriterMatch = {
  readonly method?: string;
  readonly lines?: readonly [number, number];
} & ({ readonly component: string; readonly condition?: string } | { readonly component?: never; readonly condition: string });

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
  readonly condition?: string | null;
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
    // usp_export_job_transition also runs in the POST request (createExport fails jobs without a live runner or
    // whose thread could not start); those writes are request-triggered and go through the gateway. Its
    // thread-triggered writes are these jobs' writes (runExport -> moveJob), so the same wait closes them.
    alsoMatch: [{ component: 'legacy-fixtures/sql/reporting/200_usp_export_job_transition.sql' }],
  },
  {
    id: 'startup-url-conversion',
    trigger: 'appstart',
    mechanism:
      'Start-up guard: harness/repro/lib/legacy-start.sh windows every ColdFusion start, ?appreload is a legacy-write entry run inside a window, and the migration service keeps the start-up predicate (active File or Link tcontent rows with a null body and a filename) empty whenever a legacy request can run.',
    match: { component: 'core/appcfc/onApplicationStart_include.cfm', lines: [892, 929] },
  },
  {
    id: 'startup-deploy-bundle',
    trigger: 'appstart',
    mechanism:
      'harness/repro/lib/legacy-start.sh refuses to start ColdFusion while the bundle Masa deploys at start-up exists (/tmp/MuraBundle.zip when MURA_DATASOURCE is set, else config/setup/deploy/bundle.zip [core/appcfc/applicationSettings.cfm:146; core/appcfc/onApplicationStart_include.cfm:797-811]), and environment.ts records its absence, which up.sh requires.',
    match: {
      condition:
        'config/setup/deploy/bundle.zip exists and the project site has one page (core/appcfc/onApplicationStart_include.cfm:797-811)',
    },
  },
  {
    id: 'startup-project-site',
    trigger: 'appstart',
    mechanism:
      'legacy-start.sh refuses a MURA_PROJECTSITEID other than default and environment.ts records the effective ProjectSiteID as default or an existing site, which up.sh requires, so start-up never creates the project site.',
    match: {
      condition: 'ProjectSiteID is not default and that site does not exist (core/appcfc/onApplicationStart_include.cfm:771)',
    },
  },
  {
    id: 'startup-db-updates',
    trigger: 'appstart',
    mechanism:
      'ColdFusion always starts with MURA_APPLYDBUPDATES=false (legacy-start.sh), so start-up, reload and re-initialisation skip configBean.applyDbUpdates even with appAutoUpdated or url.applyDBUpdates [core/appcfc/onApplicationStart_include.cfm:421-424]; environment.ts records it, which up.sh requires.',
    match: { condition: 'runs only on upgrade from an older version' },
  },
  {
    id: 'startup-plugin-discovery',
    trigger: 'appstart',
    mechanism:
      'ColdFusion always starts with MURA_AUTODISCOVERPLUGINS=false (legacy-start.sh), so start-up never runs pluginManager.discover; environment.ts records it, which up.sh requires.',
    match: {
      condition:
        'autoDiscoverPlugins is true and the plugins folder holds an undeployed plugin or bundle (core/appcfc/onApplicationStart_include.cfm:534; core/mura/plugin/pluginManager.cfc:763-810)',
    },
  },
  {
    id: 'trash-restore-bean',
    trigger: 'appstart',
    mechanism:
      'Only ctrash.restore sets fromMuraTrash, a withheld legacy-write entry that runs inside a write window; no start-up path saves such a bean.',
    match: { condition: 'runs only for a bean carrying fromMuraTrash, which ctrash.restore sets (decision list)' },
  },
  {
    id: 'startup-theme-site-sizes',
    trigger: 'appstart',
    mechanism:
      "The theme-config site.save() (core/mura/extend/extendManager.cfc:1977-2017) runs only when a site's theme declares small, medium or large image sizes; environment.ts records such sites and up.sh requires none.",
    match: { component: 'core/mura/settings/settingsDAO.cfc', method: 'update' },
  },
  // Not listed: the theme-config image-size upsert (settingsImageSizeBean.save via core/mura/extend/extendManager.cfc:1998-2012,
  // core/appcfc/onApplicationStart_include.cfm:844) runs on every start-up, reload and re-initialisation with no closing
  // mechanism, so programs_sites.image_size stays legacy.
]);

function lineSpan(lines: readonly [number, number] | string | undefined): readonly [number, number] | undefined {
  if (typeof lines !== 'string') return lines;
  const found = /^(\d+)-(\d+)$/.exec(lines.trim());
  return found ? [Number(found[1]), Number(found[2])] : undefined;
}

function matches(match: PreventedWriterMatch, writer: WriterRecord, span: readonly [number, number] | undefined): boolean {
  if (match.component !== undefined && writer.component !== match.component && writer.source?.path !== match.component) {
    return false;
  }
  if (match.condition !== undefined && writer.condition !== match.condition) return false;
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
