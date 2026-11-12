/** Scheduler hand-off: moves Masa's ACF `siteMonitor` task and the fixture `opt2-survey-*` tasks between ColdFusion and the target. */
import { setTimeout as delay } from 'node:timers/promises';

import { decodeRow } from '@opt2/platform/migration-kit';
import { SITEMONITOR_QUEUE, callQueueControl, queueDefinition, reconcileRecurringQueues } from '@opt2/platform/tasks';
import { tenantIdForSite } from '@opt2/platform/tenancy';

import type { MigrationContext } from '../context.js';
import type { CutoverVersion } from '../cutover/index.js';
import type { components } from '../generated/openapi.js';
import type { SchedulerDescription } from '../legacy/index.js';
import type { AdoptScheduledTask, AdoptScheduledTasksRequest, UnitCatalog } from '../owners/index.js';
import { importNativeTasks, type SchedulerImportResult } from './import.js';
import {
  SCHEDULER_KEYS,
  SURVEY_TASK_PREFIX,
  isSiteMonitorTask,
  isSurveyTask,
  readSchedulerState,
  updateSchedulerKey,
  type NativeTask,
  type PauseReason,
  type SchedulerStateSnapshot,
  type SiteMonitorRecord,
  type SurveyTasksRecord,
} from './state.js';

/** The context members the scheduler hand-off uses; service calls go through the `platform.migration` clients only. */
export type SchedulerContext = Pick<MigrationContext, 'env' | 'db' | 'bridge' | 'owners' | 'client' | 'catalog' | 'clock' | 'logger'>;

/** Injectable wait of a restoration's in-flight wait. */
export interface SchedulerServiceOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Default 2000 ms. */
  pollIntervalMs?: number;
}

/** How a transition touches the `/_api/sitemonitor` `job` entry. */
export interface SchedulerScope {
  /** Units of the cut-over `job` entry, as `siteMonitorJobUnits` returns them. */
  siteMonitorUnits: readonly string[];
  /** The transition changes the `job` entry's state. */
  siteMonitorEntryMoves: boolean;
}

/** The legacy cursor at the quiesced point of a site-monitor hand-off. */
export interface SiteMonitorHandoffPoint {
  /** `application.lastMonitored` as a bridge wire time; `undefined` reads it through the bridge now, `null` means legacy has no cursor. */
  lastMonitored?: string | null;
}

/** ACF task names an operation affected, per kind. */
export interface SchedulerTaskNames {
  siteMonitor: string[];
  surveys: string[];
}

/** Task names paused on ColdFusion. */
export type PauseResult = SchedulerTaskNames;

/** Task names resumed on ColdFusion. */
export type ResumeResult = SchedulerTaskNames;

/** Task names recreated on ColdFusion. */
export type RestoreResult = SchedulerTaskNames;

/** Outcome of handing the site monitor to programs-sites. */
export interface SiteMonitorHandoffResult {
  deletedTasks: string[];
  /** The cursor seeded into programs-sites; `null` when legacy had none. */
  cursor: string | null;
  /** The `programs-sites-sitemonitor` chain was ensured, which happens only when a native task existed. */
  recurringEnabled: boolean;
}

/** Outcome of adopting the fixture survey tasks into communications. */
export interface SurveysHandoffResult {
  adopted: string[];
  deleted: string[];
}

/** Outcome of `repointNative`. */
export interface RepointResult {
  repointed: boolean;
  tasks: string[];
}

/** The stored hand-off records beside ColdFusion's live scheduler. */
export interface SchedulerStatus {
  stored: SchedulerStateSnapshot;
  live: SchedulerDescription;
}

/** `SchedulerState` of the migration contract. */
export type SchedulerStateView = components['schemas']['SchedulerState'];

/** `BackgroundState` of the migration contract, owned by the quiesce module. */
export type BackgroundStateView = components['schemas']['BackgroundState'];

type NativeTaskView = components['schemas']['NativeTask'];

/** A hand-off side effect failed; `step` names it and `cause` holds the bridge, owner or queue-control error. */
export class SchedulerHandoffError extends Error {
  override readonly name = 'SchedulerHandoffError';
  readonly step: string;

  constructor(step: string, message: string, options?: ErrorOptions) {
    super(`Scheduler hand-off step ${step} failed: ${message}`, options);
    this.step = step;
  }
}

/** The scheduler hand-off operations of a transition, `opt2-ops` and `up.sh`. */
export interface SchedulerService {
  /** The stored records and the live scheduler; a bridge error propagates unwrapped. */
  state(): Promise<SchedulerStatus>;
  /** Imports a native task capture in any form `importNativeTasks` accepts. */
  importState(body: unknown): Promise<SchedulerImportResult>;
  /** Pauses the legacy tasks whose steps write `units` before the gateway freeze, capturing the survey definitions first. */
  pauseFor(units: Iterable<string>, scope: SchedulerScope): Promise<PauseResult>;
  /** After activation, deletes the native monitor, seeds programs-sites' cursor and enables its chain when a native task existed. */
  handOffSiteMonitorToTarget(point?: SiteMonitorHandoffPoint): Promise<SiteMonitorHandoffResult>;
  /** After activation, adopts the survey tasks as communications' Cloud Tasks and deletes them on ColdFusion. */
  handOffSurveysToTarget(): Promise<SurveysHandoffResult>;
  /** Returns the site monitor and the still-pending survey tasks to ColdFusion, re-pointed at the gateway. */
  restoreToLegacy(units: Iterable<string>, scope: SchedulerScope): Promise<RestoreResult>;
  /** Resumes the tasks `pauseFor` paused that are still on legacy. */
  resumePaused(): Promise<ResumeResult>;
  /** Pauses every legacy-held task for `opt2-ops drain-and-suspend`. */
  pauseAll(): Promise<PauseResult>;
  /** Recreates the captured legacy-held tasks, re-pointed, for `opt2-ops resume`. */
  restoreAll(): Promise<RestoreResult>;
  /** Recreates the native monitor against the gateway and resumes it, when one was captured and is still on legacy. */
  repointNative(): Promise<RepointResult>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const SITEMONITOR_SERVICE = 'programs-sites';
const SURVEYS_OWNER = 'surveys';
const SURVEY_SCHEDULE_UNIT = 'surveys.survey_schedule';
const SURVEY_TASK_NAME = /^opt2-survey-([0-9A-Za-z-]{35})-(?:launch|reminder-[1-9][0-9]*)$/;
const TASK_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TASK_TIME = /^\d{2}:\d{2}:\d{2}$/;
const TASK_TOKEN_PARAM = 'opt2TaskToken';

/** Sorted, de-duplicated units of the `job` entries of `version`. */
export function siteMonitorJobUnits(version: Pick<CutoverVersion, 'entries'>): string[] {
  return [...new Set(version.entries.filter((entry) => entry.kind === 'job').flatMap((entry) => entry.units))].sort();
}

/** True when any of `units` belongs to the surveys service. */
export function surveysTouched(units: Iterable<string>, catalog: Pick<UnitCatalog, 'ownerOf'>): boolean {
  for (const unit of units) {
    if (catalog.ownerOf(unit) === SURVEYS_OWNER) return true;
  }
  return false;
}

/** Reads the stored records and `scheduler.describe` in parallel. */
export async function schedulerStatus(ctx: Pick<SchedulerContext, 'db' | 'bridge' | 'clock'>): Promise<SchedulerStatus> {
  const [stored, live] = await Promise.all([readSchedulerState(ctx.db, ctx.clock.now()), ctx.bridge.schedulerDescribe()]);
  return { stored, live };
}

/** Maps a status and the quiesce-owned background state to the contract's `SchedulerState`, task tokens removed from URLs. */
export function schedulerStateView(status: SchedulerStatus, background: BackgroundStateView): SchedulerStateView {
  const { sitemonitor, surveyTasks, nativeTasks } = status.stored;
  const liveMonitor = status.live.tasks.filter((task) => isSiteMonitorTask(task, status.live.siteMonitorTask));
  const liveSurveys = status.live.tasks.filter(isSurveyTask);
  const liveSurveyNames = new Set(liveSurveys.map((task) => task.task));

  const tasks = liveMonitor.map((task) => taskView(task, task.paused ? 'paused' : 'active'));
  if (tasks.length === 0 && sitemonitor.definition !== null) {
    tasks.push(taskView(sitemonitor.definition, sitemonitor.state === 'target' ? 'deleted' : 'captured'));
  }
  const fixtureTasks = [
    ...liveSurveys.map((task) => taskView(task, task.paused ? 'paused' : 'active')),
    ...surveyTasks.definitions
      .filter((task) => !liveSurveyNames.has(task.task))
      .map((task) => taskView(task, surveyTasks.state === 'adopted' ? 'deleted' : 'captured')),
  ];

  const handedOff = sitemonitor.state === 'target';
  return {
    ping: pingValue(sitemonitor.originalPing ?? nativeTasks?.originalPing ?? null),
    nativeTaskExisted: sitemonitor.nativeExisted,
    siteMonitor: {
      state: siteMonitorViewState(sitemonitor, liveMonitor),
      ...(handedOff && sitemonitor.handedOffAt !== undefined ? { handedOffAt: sitemonitor.handedOffAt } : {}),
      ...(handedOff && typeof sitemonitor.cursorHandedOff === 'string' ? { lastMonitored: sitemonitor.cursorHandedOff } : {}),
    },
    tasks,
    fixtureTasks,
    background,
  };
}

function siteMonitorViewState(record: SiteMonitorRecord, live: readonly NativeTask[]): SchedulerStateView['siteMonitor']['state'] {
  if (record.state === 'target') return 'handed-off';
  if (live.length > 0) return live.every((task) => task.paused) ? 'paused' : 'active';
  return record.nativeExisted ? 'captured' : 'none';
}

function taskView(task: NativeTask, status: NativeTaskView['status']): NativeTaskView {
  return {
    name: task.task,
    status,
    url: displayUrl(task.url),
    interval: task.interval,
    requestTimeOut: task.requestTimeOut,
    startDate: task.startDate,
    startTime: task.startTime,
  };
}

/** `url` without the fixture task token, which authorises the task's callback. */
function displayUrl(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(TASK_TOKEN_PARAM);
  return parsed.toString();
}

/** Masa's `ping` as a boolean; a setting text other than true, false, yes or no is unknown. */
function pingValue(ping: boolean | string | null): boolean | null {
  if (typeof ping !== 'string') return ping;
  const text = ping.trim().toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  return text === 'false' || text === 'no' ? false : null;
}

function byName(a: NativeTask, b: NativeTask): number {
  return a.task < b.task ? -1 : a.task > b.task ? 1 : 0;
}

function uniqueSorted(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

/** Task names for a log line. */
function nameList(list: readonly string[]): string {
  return list.length === 0 ? 'none' : list.join(', ');
}

function monitorNames(live: SchedulerDescription): string[] {
  return uniqueSorted(live.tasks.filter((task) => isSiteMonitorTask(task, live.siteMonitorTask)).map((task) => task.task));
}

/** Live and stored definitions by name; the stored `paused` flag, captured before pausing, wins. */
function mergeDefinitions(live: readonly NativeTask[], stored: readonly NativeTask[]): NativeTask[] {
  const merged = new Map(live.map((task) => [task.task, task]));
  for (const task of stored) {
    const current = merged.get(task.task);
    merged.set(task.task, current === undefined ? task : { ...current, paused: task.paused });
  }
  return [...merged.values()].sort(byName);
}

/** The live survey definitions, merged with the stored ones only when those were captured by a pause still in force. */
function capturedSurveyDefinitions(live: SchedulerDescription, stored: SurveyTasksRecord): NativeTask[] {
  const surveys = live.tasks.filter(isSurveyTask);
  return stored.paused === null ? [...surveys].sort(byName) : mergeDefinitions(surveys, stored.definitions);
}

/** A survey task in communications' adoption form, with the survey id its schedule version is looked up by. */
function parseSurveyTask(task: NativeTask): Omit<AdoptScheduledTask, 'scheduleVersion'> & { surveyId: string } {
  const surveyId = SURVEY_TASK_NAME.exec(task.task)?.[1];
  const siteId = URL.canParse(task.url) ? new URL(task.url).searchParams.get('siteid') : null;
  if (surveyId === undefined || siteId === null || siteId === '' || !TASK_DATE.test(task.startDate) || !TASK_TIME.test(task.startTime)) {
    throw new SchedulerHandoffError('adopt', `survey task ${task.task} lacks a survey id, siteid, mm/dd/yyyy start date or HH:mm:ss start time`);
  }
  return {
    name: task.task,
    siteId,
    scheduleTime: `${task.startDate.replace(TASK_DATE, '$3-$1-$2')}T${task.startTime}.000`,
    surveyId: surveyId.toUpperCase(),
  };
}

/** Runs one side effect, wrapping its failure in a `SchedulerHandoffError` named `name`. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SchedulerHandoffError) throw error;
    throw new SchedulerHandoffError(name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** Creates the scheduler hand-off service; its only state is `migration.scheduler_state`, written after each completed side effect. */
export function createSchedulerService(ctx: SchedulerContext, options: SchedulerServiceOptions = {}): SchedulerService {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = (): Date => ctx.clock.now();
  const log = (stepName: string, detail: string): void => {
    ctx.logger.info(`scheduler hand-off ${stepName}: ${detail}`);
  };
  const stored = (): Promise<SchedulerStateSnapshot> => readSchedulerState(ctx.db, now());
  const describe = (): Promise<SchedulerDescription> => step('describe', () => ctx.bridge.schedulerDescribe());
  const updateMonitor = (fn: (current: SiteMonitorRecord) => SiteMonitorRecord): Promise<SiteMonitorRecord> =>
    updateSchedulerKey(ctx.db, SCHEDULER_KEYS.siteMonitor, fn, now());
  const updateSurveys = (fn: (current: SurveyTasksRecord) => SurveyTasksRecord): Promise<SurveyTasksRecord> =>
    updateSchedulerKey(ctx.db, SCHEDULER_KEYS.surveyTasks, fn, now());
  const siteMonitorQueue = (op: 'pause' | 'resume') =>
    step(`queue-${op}`, () => callQueueControl(ctx.client, { service: SITEMONITOR_SERVICE, queue: SITEMONITOR_QUEUE, op }));

  async function pauseMonitor(live: SchedulerDescription, reason: PauseReason): Promise<string[]> {
    const names = monitorNames(live);
    if (names.length === 0) return [];
    const { tasks } = await step('pause', () => ctx.bridge.schedulerPause({ tasks: names }));
    await updateMonitor((current) => (current.nativePaused === null ? { ...current, nativePaused: reason } : current));
    log(`pause site monitor (${reason})`, nameList(tasks));
    return tasks;
  }

  async function pauseSurveys(live: SchedulerDescription, reason: PauseReason): Promise<string[]> {
    let definitions: NativeTask[] = [];
    // Stored before the pause, so the flags each task had before it survive.
    await updateSurveys((current) => {
      definitions = capturedSurveyDefinitions(live, current);
      return definitions.length === 0 ? current : { ...current, definitions, paused: current.paused ?? reason };
    });
    if (definitions.length === 0) return [];
    const { tasks } = await step('pause', () => ctx.bridge.schedulerPause({ prefix: SURVEY_TASK_PREFIX }));
    log(`pause survey tasks (${reason})`, nameList(tasks));
    return tasks;
  }

  /** Schedule version per upper-case survey id, read from the surveys owner's export of each site's tenant. */
  async function scheduleVersions(siteIds: ReadonlySet<string>): Promise<Map<string, number>> {
    const owner = ctx.catalog.ownerOf(SURVEY_SCHEDULE_UNIT);
    const versions = new Map<string, number>();
    for (const siteId of siteIds) {
      for await (const page of ctx.owners.exportPages(owner, { unit: SURVEY_SCHEDULE_UNIT, tenantId: tenantIdForSite(siteId) })) {
        for (const table of page.tables) {
          for (const { row } of table.rows) {
            const { survey_id: surveyId, schedule_version: version } = decodeRow(table.columns, row);
            if (typeof surveyId === 'string' && typeof version === 'string') versions.set(surveyId.toUpperCase(), Number(version));
          }
        }
      }
    }
    return versions;
  }

  // An ACF task carries no schedule version, and communications and surveys supersede tasks of an older version, so the
  // version comes from the surveys owner, whose rows the transition reconciled with legacy before activation.
  async function adoptRequest(definitions: readonly NativeTask[]): Promise<AdoptScheduledTasksRequest> {
    const tasks = definitions.map(parseSurveyTask);
    const versions = await step('schedule-versions', () => scheduleVersions(new Set(tasks.map((task) => task.siteId))));
    return {
      tasks: tasks.map(({ surveyId, ...task }) => {
        const scheduleVersion = versions.get(surveyId);
        if (scheduleVersion === undefined) {
          throw new SchedulerHandoffError('adopt', `survey ${surveyId} of task ${task.name} has no schedule in ${SURVEY_SCHEDULE_UNIT}`);
        }
        return { ...task, scheduleVersion };
      }),
    };
  }

  /** Recreates survey definitions re-pointed at the gateway, keeping the paused flag each had before it was paused. */
  async function restoreSurveyDefinitions(definitions: readonly NativeTask[]): Promise<string[]> {
    const restored: string[] = [];
    for (const paused of [false, true]) {
      const tasks = definitions.filter((task) => task.paused === paused);
      if (tasks.length === 0) continue;
      restored.push(...(await step('restore', () => ctx.bridge.schedulerRestore({ tasks, repoint: true, paused }))).tasks);
    }
    return restored;
  }

  // SiteMonitorState reports no run in progress, so a run dispatched before the pause is awaited until its queue deadline.
  async function awaitInflightRuns(pausedAt: number): Promise<void> {
    const deadlineMs = queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000;
    let slept = 0;
    for (;;) {
      const left = deadlineMs - Math.max(now().getTime() - pausedAt, slept);
      if (left <= 0) return;
      const ms = Math.min(pollIntervalMs, left);
      await sleep(ms);
      slept += ms;
    }
  }

  async function restoreMonitor(record: SiteMonitorRecord): Promise<string[]> {
    await siteMonitorQueue('pause');
    await updateMonitor((current) => (current.targetTriggerDisabled ? current : { ...current, targetTriggerDisabled: true }));
    log('pause target trigger', SITEMONITOR_QUEUE);

    await awaitInflightRuns(now().getTime());
    log('await in-flight runs', `${SITEMONITOR_QUEUE} quiet`);

    const { lastMonitored } = await step('cursor-read', () => ctx.owners.siteMonitorState());
    if (lastMonitored !== null) {
      await step('cursor-restore', () => ctx.bridge.jobsRun('setCursor', { value: lastMonitored }));
      log('hand cursor back', `lastMonitored ${lastMonitored}`);
    }

    let restored: string[] = [];
    const { definition } = record;
    if (record.nativeExisted && definition !== null) {
      restored = (await step('restore', () => ctx.bridge.schedulerRestore({ tasks: [definition], repoint: true, paused: false }))).tasks;
      log('restore site monitor', nameList(restored));
    }
    await updateMonitor((current) => ({ ...current, state: 'legacy', nativePaused: null }));
    return restored;
  }

  async function restoreSurveys(record: SurveyTasksRecord): Promise<string[]> {
    let current = record;
    for (const name of record.adoptedNames) {
      const { cancelled } = await step('cancel', () => ctx.owners.cancelAdoptedScheduledTasks({ names: [name] }));
      // A task that already ran on the target cancels nothing and is never recreated; progress is kept per name.
      current = await updateSurveys((stateNow) => ({
        ...stateNow,
        adoptedNames: stateNow.adoptedNames.filter((adopted) => adopted !== name),
        definitions: cancelled > 0 ? stateNow.definitions : stateNow.definitions.filter((task) => task.task !== name),
      }));
    }
    const { definitions } = current;
    log('cancel adopted survey tasks', `pending ${nameList(definitions.map((task) => task.task))}`);

    const restored = await restoreSurveyDefinitions(definitions);
    await updateSurveys((stateNow) => ({ ...stateNow, state: 'legacy', definitions, adoptedNames: [], paused: null }));
    log('restore survey tasks', nameList(restored));
    return restored;
  }

  return {
    state: () => schedulerStatus(ctx),

    importState: (body) => importNativeTasks({ db: ctx.db, clock: ctx.clock }, body),

    async pauseFor(units, scope) {
      const unitList = [...units];
      const live = await describe();
      const { sitemonitor, surveyTasks } = await stored();
      const monitorTouched = scope.siteMonitorEntryMoves || unitList.some((unit) => scope.siteMonitorUnits.includes(unit));
      const siteMonitor = sitemonitor.state === 'legacy' && monitorTouched ? await pauseMonitor(live, 'transition') : [];
      const surveys =
        surveyTasks.state === 'legacy' && surveysTouched(unitList, ctx.catalog) ? await pauseSurveys(live, 'transition') : [];
      return { siteMonitor, surveys };
    },

    async handOffSiteMonitorToTarget(point = {}) {
      const { sitemonitor } = await stored();
      if (sitemonitor.state === 'target') {
        log('site monitor', 'already handed off');
        return { deletedTasks: [], cursor: sitemonitor.cursorHandedOff ?? null, recurringEnabled: false };
      }

      const live = await describe();
      const { definition } = sitemonitor;
      const names = uniqueSorted([
        ...monitorNames(live),
        ...(sitemonitor.nativeExisted && definition !== null ? [definition.task] : []),
      ]);
      let deletedTasks: string[] = [];
      if (names.length > 0) {
        await step('pause', () => ctx.bridge.schedulerPause({ tasks: names }));
        deletedTasks = (await step('delete', () => ctx.bridge.schedulerDelete({ tasks: names }))).tasks;
        log('delete site monitor', nameList(deletedTasks));
      }

      const cursor =
        point.lastMonitored !== undefined
          ? point.lastMonitored
          : (await step('cursor-read', () => ctx.bridge.getCursor())).lastMonitored;
      // Without a cursor programs-sites starts from one minute before its first run, as Masa's cfparam does.
      if (cursor !== null) {
        await step('cursor-seed', () => ctx.owners.putSiteMonitorState({ lastMonitored: cursor }));
        log('seed target cursor', `lastMonitored ${cursor}`);
      }

      // With no native task (`ping=false`) the monitor never ran on a schedule, so the target chain stays absent.
      const recurringEnabled = sitemonitor.nativeExisted;
      if (recurringEnabled) {
        if (sitemonitor.targetTriggerDisabled) {
          await siteMonitorQueue('resume');
          await updateMonitor((current) => ({ ...current, targetTriggerDisabled: false }));
          log('resume target trigger', SITEMONITOR_QUEUE);
        }
        const results = await step('reconcile', () =>
          reconcileRecurringQueues(ctx.client, {
            serviceUrls: ctx.env.OPT2_SERVICE_URLS,
            withSiteMonitor: true,
            queues: [SITEMONITOR_QUEUE],
          }),
        );
        const failed = results.filter((result) => !result.ok);
        if (failed.length > 0) {
          throw new SchedulerHandoffError(
            'reconcile',
            failed.map((result) => `${result.queue} on ${result.service}: ${result.error ?? 'not ensured'}`).join('; '),
          );
        }
        log('ensure target chain', SITEMONITOR_QUEUE);
      }

      await updateMonitor((current) => ({
        ...current,
        state: 'target',
        cursorHandedOff: cursor,
        nativePaused: null,
        handedOffAt: now().toISOString(),
      }));
      return { deletedTasks, cursor, recurringEnabled };
    },

    async handOffSurveysToTarget() {
      const { surveyTasks } = await stored();
      if (surveyTasks.state === 'adopted') {
        log('survey tasks', `already adopted ${nameList(surveyTasks.adoptedNames)}`);
        return { adopted: surveyTasks.adoptedNames, deleted: [] };
      }

      await step('pause', () => ctx.bridge.schedulerPause({ prefix: SURVEY_TASK_PREFIX }));
      const live = await describe();
      let definitions: NativeTask[] = [];
      // Stored before adoption, so a restoration after a crash still has the definitions.
      await updateSurveys((current) => {
        definitions = capturedSurveyDefinitions(live, current);
        return { ...current, definitions, paused: current.paused ?? 'transition' };
      });
      const adopted = definitions.map((task) => task.task);
      if (definitions.length > 0) {
        const request = await adoptRequest(definitions);
        await step('adopt', () => ctx.owners.adoptScheduledTasks(request));
        log('adopt survey tasks', nameList(adopted));
      }

      const { tasks: deleted } = await step('delete', () => ctx.bridge.schedulerDelete({ prefix: SURVEY_TASK_PREFIX }));
      log('delete survey tasks', nameList(deleted));
      await updateSurveys((current) => ({
        ...current,
        state: 'adopted',
        definitions,
        adoptedNames: adopted,
        adoptedAt: now().toISOString(),
        paused: null,
      }));
      return { adopted, deleted };
    },

    async restoreToLegacy(units, scope) {
      const unitList = [...units];
      const { sitemonitor, surveyTasks } = await stored();
      const siteMonitor = scope.siteMonitorEntryMoves && sitemonitor.state === 'target' ? await restoreMonitor(sitemonitor) : [];
      const surveys =
        surveyTasks.state === 'adopted' && surveysTouched(unitList, ctx.catalog) ? await restoreSurveys(surveyTasks) : [];
      return { siteMonitor, surveys };
    },

    async resumePaused() {
      const { sitemonitor, surveyTasks } = await stored();
      let siteMonitor: string[] = [];
      if (sitemonitor.state === 'legacy' && sitemonitor.nativePaused === 'transition') {
        const names = monitorNames(await describe());
        if (names.length > 0) siteMonitor = (await step('resume', () => ctx.bridge.schedulerResume({ tasks: names }))).tasks;
        await updateMonitor((current) => (current.nativePaused === 'transition' ? { ...current, nativePaused: null } : current));
        log('resume site monitor', nameList(siteMonitor));
      }

      let surveys: string[] = [];
      if (surveyTasks.state === 'legacy' && surveyTasks.paused === 'transition') {
        const names = surveyTasks.definitions.filter((task) => !task.paused).map((task) => task.task);
        if (names.length > 0) surveys = (await step('resume', () => ctx.bridge.schedulerResume({ tasks: names }))).tasks;
        await updateSurveys((current) => (current.paused === 'transition' ? { ...current, paused: null } : current));
        log('resume survey tasks', nameList(surveys));
      }
      return { siteMonitor, surveys };
    },

    async pauseAll() {
      const live = await describe();
      const { sitemonitor, surveyTasks } = await stored();
      const siteMonitor = sitemonitor.state === 'legacy' ? await pauseMonitor(live, 'suspend') : [];
      const surveys = surveyTasks.state === 'legacy' ? await pauseSurveys(live, 'suspend') : [];
      return { siteMonitor, surveys };
    },

    async restoreAll() {
      const { sitemonitor, surveyTasks } = await stored();
      let siteMonitor: string[] = [];
      const { definition } = sitemonitor;
      if (sitemonitor.nativeExisted && sitemonitor.state === 'legacy' && definition !== null) {
        siteMonitor = (await step('restore', () => ctx.bridge.schedulerRestore({ tasks: [definition], repoint: true, paused: false }))).tasks;
        log('restore site monitor', nameList(siteMonitor));
      }
      await updateMonitor((current) => (current.nativePaused === null ? current : { ...current, nativePaused: null }));

      // Only definitions captured by a pause still in force are current; older ones would overwrite rescheduled tasks.
      let surveys: string[] = [];
      if (surveyTasks.state === 'legacy' && surveyTasks.paused !== null) {
        surveys = await restoreSurveyDefinitions(surveyTasks.definitions);
        await updateSurveys((current) => ({ ...current, paused: null }));
        log('restore survey tasks', nameList(surveys));
      }
      return { siteMonitor, surveys };
    },

    async repointNative() {
      const { sitemonitor } = await stored();
      const { definition } = sitemonitor;
      if (!sitemonitor.nativeExisted || sitemonitor.state !== 'legacy' || definition === null) {
        log('repoint site monitor', 'skipped: no native task on legacy');
        return { repointed: false, tasks: [] };
      }
      const { tasks } = await step('repoint', () => ctx.bridge.schedulerRepoint(definition));
      await updateMonitor((current) => (current.nativePaused === null ? current : { ...current, nativePaused: null }));
      log('repoint site monitor', nameList(tasks));
      return { repointed: true, tasks };
    },
  };
}
