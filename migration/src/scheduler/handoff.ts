/** Scheduler hand-off: moves Masa's ACF `siteMonitor` task between ColdFusion and the target. */
import { setTimeout as delay } from 'node:timers/promises';

import { SITEMONITOR_QUEUE, callQueueControl, queueDefinition, reconcileRecurringQueues } from '@opt2/platform/tasks';

import type { MigrationContext } from '../context.js';
import type { CutoverVersion } from '../cutover/index.js';
import type { components } from '../generated/openapi.js';
import type { SchedulerDescription } from '../legacy/index.js';
import { importSchedulerRequest, type SchedulerImportRequest, type SchedulerImportResult } from './import.js';
import {
  SCHEDULER_KEYS,
  isSiteMonitorTask,
  readSchedulerState,
  updateSchedulerKey,
  type NativeTask,
  type PauseReason,
  type SchedulerStateSnapshot,
  type SiteMonitorRecord,
} from './state.js';

/** The context members the scheduler hand-off uses; service calls go through the `platform.migration` clients only. */
export type SchedulerContext = Pick<MigrationContext, 'env' | 'db' | 'bridge' | 'owners' | 'client' | 'clock' | 'logger'>;

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
  /** Imports a validated `SchedulerImportRequest` body with `importSchedulerRequest`. */
  importState(body: SchedulerImportRequest): Promise<SchedulerImportResult>;
  /** Pauses the legacy tasks whose steps write `units` before the gateway freeze. */
  pauseFor(units: Iterable<string>, scope: SchedulerScope): Promise<PauseResult>;
  /** After activation, deletes the native monitor, seeds programs-sites' cursor and enables its chain when a native task existed. */
  handOffSiteMonitorToTarget(point?: SiteMonitorHandoffPoint): Promise<SiteMonitorHandoffResult>;
  /** Returns the site monitor to ColdFusion, re-pointed at the gateway, when the transition moves its `job` entry. */
  restoreToLegacy(scope: SchedulerScope): Promise<RestoreResult>;
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
const TASK_TOKEN_PARAM = 'opt2TaskToken';

/** Sorted, de-duplicated units of the `job` entries of `version`. */
export function siteMonitorJobUnits(version: Pick<CutoverVersion, 'entries'>): string[] {
  return [...new Set(version.entries.filter((entry) => entry.kind === 'job').flatMap((entry) => entry.units))].sort();
}

/** Reads the stored records and `scheduler.describe` in parallel. */
export async function schedulerStatus(ctx: Pick<SchedulerContext, 'db' | 'bridge' | 'clock'>): Promise<SchedulerStatus> {
  const [stored, live] = await Promise.all([readSchedulerState(ctx.db, ctx.clock.now()), ctx.bridge.schedulerDescribe()]);
  return { stored, live };
}

/** Maps a status and the quiesce-owned background state to the contract's `SchedulerState`, task URLs as `displayUrl` returns them. */
export function schedulerStateView(status: SchedulerStatus, background: BackgroundStateView): SchedulerStateView {
  const { sitemonitor, nativeTasks } = status.stored;
  const liveMonitor = status.live.tasks.filter((task) => isSiteMonitorTask(task, status.live.siteMonitorTask));

  const tasks = liveMonitor.map((task) => taskView(task, task.paused ? 'paused' : 'active'));
  if (tasks.length === 0 && sitemonitor.definition !== null) {
    tasks.push(taskView(sitemonitor.definition, sitemonitor.state === 'target' ? 'deleted' : 'captured'));
  }

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

/** `url` without any `opt2TaskToken` query parameter, a callback credential a captured task definition may carry. */
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

  return {
    state: () => schedulerStatus(ctx),

    importState: (body) => importSchedulerRequest({ db: ctx.db, clock: ctx.clock }, body),

    async pauseFor(units, scope) {
      const unitList = [...units];
      const live = await describe();
      const { sitemonitor } = await stored();
      const monitorTouched = scope.siteMonitorEntryMoves || unitList.some((unit) => scope.siteMonitorUnits.includes(unit));
      const siteMonitor = sitemonitor.state === 'legacy' && monitorTouched ? await pauseMonitor(live, 'transition') : [];
      return { siteMonitor };
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

    async restoreToLegacy(scope) {
      const { sitemonitor } = await stored();
      const siteMonitor = scope.siteMonitorEntryMoves && sitemonitor.state === 'target' ? await restoreMonitor(sitemonitor) : [];
      return { siteMonitor };
    },

    async resumePaused() {
      const { sitemonitor } = await stored();
      let siteMonitor: string[] = [];
      if (sitemonitor.state === 'legacy' && sitemonitor.nativePaused === 'transition') {
        const names = monitorNames(await describe());
        if (names.length > 0) siteMonitor = (await step('resume', () => ctx.bridge.schedulerResume({ tasks: names }))).tasks;
        await updateMonitor((current) => (current.nativePaused === 'transition' ? { ...current, nativePaused: null } : current));
        log('resume site monitor', nameList(siteMonitor));
      }
      return { siteMonitor };
    },

    async pauseAll() {
      const live = await describe();
      const { sitemonitor } = await stored();
      const siteMonitor = sitemonitor.state === 'legacy' ? await pauseMonitor(live, 'suspend') : [];
      return { siteMonitor };
    },

    async restoreAll() {
      const { sitemonitor } = await stored();
      let siteMonitor: string[] = [];
      const { definition } = sitemonitor;
      if (sitemonitor.nativeExisted && sitemonitor.state === 'legacy' && definition !== null) {
        siteMonitor = (await step('restore', () => ctx.bridge.schedulerRestore({ tasks: [definition], repoint: true, paused: false }))).tasks;
        log('restore site monitor', nameList(siteMonitor));
      }
      await updateMonitor((current) => (current.nativePaused === null ? current : { ...current, nativePaused: null }));
      return { siteMonitor };
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
