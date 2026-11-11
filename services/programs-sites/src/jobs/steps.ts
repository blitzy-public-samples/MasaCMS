/** Static table of the legacy `/_api/sitemonitor` steps, in legacy order, with each step's write set and target route. */

/** Site-monitor step; also the `job=` value `gateway/legacy-bridge/cfml/jobs.cfm` accepts. */
export type SiteMonitorStepName =
  | 'sendReminders'
  | 'emailSend'
  | 'publishScheduledChangesets'
  | 'trackBounces'
  | 'feedAutoImport'
  | 'purgeDisplayWindow'
  | 'clearOldCommands'
  | 'onGlobalMonitor'
  | 'onSiteMonitor'
  | 'setCursor';

/** Target service owning a step's work; null when the step has no target owner and always runs on legacy. */
export type StepOwner = 'communications' | 'strategies-content' | null;

/** Site setting that must be set for a per-site step to run for that site. */
export type SiteGate = 'EmailBroadcaster' | 'FeedManager';

/** One step of the site-monitor run. */
export interface SiteMonitorStep {
  readonly step: SiteMonitorStepName;
  readonly owner: StepOwner;
  /** Write set in the inventory's unit form: `<schema>.<table>`, `legacy:<table>` or `file-store`; sorted. */
  readonly units: readonly string[];
  /** Strategies-content task route, without query string; present only on steps the target can run. */
  readonly targetPath?: string;
  readonly perSite: boolean;
  readonly gate?: SiteGate;
  /**
   * Label of the same legacy call in the inventory's `scheduledJobs[].steps[].step`, which names steps differently
   * and records both plugin events as one step; absent where the inventory records no step.
   */
  readonly inventoryStep?: string;
  /** Legacy location, for traceability rows. */
  readonly source: { readonly path: string; readonly lines: string };
}

const CONTENT_SERVER = 'core/mura/content/contentServer.cfc';

function frozen(def: SiteMonitorStep): SiteMonitorStep {
  return Object.freeze({ ...def, units: Object.freeze([...def.units]), source: Object.freeze({ ...def.source }) });
}

/** Every site-monitor step in legacy execution order. */
export const SITE_MONITOR_STEPS: readonly SiteMonitorStep[] = Object.freeze([
  // legacy: contentServer.cfc:677-681 catch-up runs this step first for theTime - 30 min when the minutes differ.
  frozen({
    step: 'sendReminders',
    owner: null,
    units: ['legacy:tcontenteventreminders'],
    perSite: false,
    inventoryStep: 'reminders',
    source: { path: CONTENT_SERVER, lines: '679-683' },
  }),
  frozen({
    step: 'emailSend',
    owner: 'communications',
    units: ['communications.email', 'communications.email_return_stat', 'communications.email_stat'],
    perSite: false,
    inventoryStep: 'email-send',
    source: { path: CONTENT_SERVER, lines: '685' },
  }),
  // Content saves here can write legacy:tcontenteventreminders (decision list), so this and feedAutoImport stay on
  // legacy until every unit is target-authoritative; targetPath is the route they take from then on.
  frozen({
    step: 'publishScheduledChangesets',
    owner: 'strategies-content',
    units: [
      'content.approval_action',
      'content.approval_request',
      'content.changeset',
      'content.changeset_category_assign',
      'content.changeset_rollback',
      'content.changeset_tag_assign',
      'content.content',
      'content.content_assignment',
      'content.content_category_assign',
      'content.content_object',
      'content.content_related',
      'content.content_stats',
      'content.content_tag',
      'content.extend_data',
      'content.file',
      'content.file_metadata',
      'content.filename_archive',
      'content.public_submission_approval',
      'content.source_map',
      'file-store',
      'legacy:tcontenteventreminders',
    ],
    targetPath: '/internal/v1/jobs/publish-scheduled-changesets',
    perSite: false,
    inventoryStep: 'changeset-publish',
    source: { path: CONTENT_SERVER, lines: '687' },
  }),
  // legacy: contentServer.cfc:694 discards the listAppend result, so the mail-server dedupe never skips a site.
  frozen({
    step: 'trackBounces',
    owner: 'communications',
    units: ['communications.email_return_stat', 'communications.email_stat'],
    perSite: true,
    gate: 'EmailBroadcaster',
    inventoryStep: 'bounces',
    source: { path: CONTENT_SERVER, lines: '689-696' },
  }),
  frozen({
    step: 'feedAutoImport',
    owner: 'strategies-content',
    units: [
      'content.approval_action',
      'content.approval_request',
      'content.changeset',
      'content.changeset_category_assign',
      'content.changeset_tag_assign',
      'content.content',
      'content.content_assignment',
      'content.content_category_assign',
      'content.content_object',
      'content.content_related',
      'content.content_stats',
      'content.content_tag',
      'content.extend_data',
      'content.file',
      'content.file_metadata',
      'content.filename_archive',
      'content.public_submission_approval',
      'content.source_map',
      'file-store',
      'legacy:tcontenteventreminders',
    ],
    targetPath: '/internal/v1/jobs/feed-auto-import',
    perSite: true,
    gate: 'FeedManager',
    inventoryStep: 'feed-import',
    source: { path: CONTENT_SERVER, lines: '697-699' },
  }),
  frozen({
    step: 'purgeDisplayWindow',
    owner: null,
    units: [],
    perSite: false,
    inventoryStep: 'cache-purge',
    source: { path: CONTENT_SERVER, lines: '702-733' },
  }),
  frozen({
    step: 'clearOldCommands',
    owner: null,
    units: ['legacy:tclustercommands', 'legacy:tclusterpeers'],
    perSite: false,
    inventoryStep: 'cluster-cleanup',
    source: { path: CONTENT_SERVER, lines: '735' },
  }),
  frozen({
    step: 'onGlobalMonitor',
    owner: null,
    units: [],
    perSite: false,
    inventoryStep: 'plugin-events',
    source: { path: CONTENT_SERVER, lines: '737' },
  }),
  frozen({
    step: 'onSiteMonitor',
    owner: null,
    units: [],
    perSite: true,
    inventoryStep: 'plugin-events',
    source: { path: CONTENT_SERVER, lines: '739-743' },
  }),
  frozen({
    step: 'setCursor',
    owner: null,
    units: [],
    perSite: false,
    source: { path: CONTENT_SERVER, lines: '745' },
  }),
]);

/** Steps that carry a target route, in legacy order. */
export const TARGET_CAPABLE_STEPS: readonly SiteMonitorStepName[] = Object.freeze(
  SITE_MONITOR_STEPS.filter((s) => s.targetPath !== undefined).map((s) => s.step),
);

const BY_NAME = Object.freeze(Object.fromEntries(SITE_MONITOR_STEPS.map((s) => [s.step, s]))) as Readonly<
  Record<SiteMonitorStepName, SiteMonitorStep>
>;

/** Table entry of the named step. */
export function stepNamed(name: SiteMonitorStepName): SiteMonitorStep {
  return BY_NAME[name];
}
