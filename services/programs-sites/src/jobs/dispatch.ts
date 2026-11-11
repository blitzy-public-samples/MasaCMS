/** Per-step routing of the site monitor: a strategies-content task on the target, or the legacy bridge step through migration. */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  SITEMONITOR_QUEUE,
  assertTaskName,
  isQueueName,
  queueDefinition,
  queuesCreatedBy,
  slotName,
  targetUrl,
  type QueueName,
  type TaskPort,
} from '@opt2/platform/tasks';
import type { Clock, ServiceClient } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import type { SiteMonitorStep, SiteMonitorStepName } from './steps.js';
import type { components as MigrationContract, paths as MigrationPaths } from '../generated/clients/migration.js';
import type { components as ContentContract } from '../generated/clients/strategies-content.js';

type UnitAuthorityResponse = MigrationContract['schemas']['UnitAuthorityResponse'];
type UnitAuthorityQuery = MigrationPaths['/internal/v1/authority']['get']['parameters']['query'];
type LegacyStepWireRequest = MigrationContract['schemas']['LegacyStepRequest'];
type StepTaskPayload = ContentContract['schemas']['SiteMonitorStepPayload'];

const SELF = 'programs-sites';
const MIGRATION = 'migration';
const STEP_TARGET_SERVICE = 'strategies-content';
const AUTHORITY_PATH = '/internal/v1/authority' satisfies keyof MigrationPaths;
const LEGACY_STEPS_PATH = '/internal/v1/legacy-steps' satisfies keyof MigrationPaths;
const DEFAULT_POLL_INTERVAL_MS = 1000;

// Inventory write-set forms migration's UnitId cannot express: a decision-list table has no target unit and never
// moves, and the file store holds the bytes of tfiles rows (fileDAO.cfc:153-209), so it moves with the tfiles unit.
const DECISION_TABLE_PREFIX = 'legacy:';
const FILE_STORE = 'file-store';
const FILE_STORE_UNITS: readonly string[] = ['content.file'];

/** One dispatch of a site-monitor step. */
export interface StepInvocation {
  readonly step: SiteMonitorStep;
  readonly siteId?: string;
  /** Time the legacy method receives; `theTime − 30 min` for the catch-up reminder call. */
  readonly theTime: Date;
  readonly lastMonitored: Date;
  /** The run's `theTime`, from which every task name derives. */
  readonly runAt: Date;
  readonly deadlineAt: Date;
}

/** Where one step ran; `task` is present on the target route. */
export interface StepOutcome {
  readonly step: SiteMonitorStepName;
  readonly siteId?: string;
  readonly route: 'target' | 'legacy';
  readonly theTime: Date;
  readonly task?: { readonly queue: string; readonly name: string; readonly created: boolean };
}

/** Runs one site-monitor step on its executor; a rejection aborts the run. */
export interface StepDispatcher {
  dispatch(inv: StepInvocation): Promise<StepOutcome>;
}

/** One site-monitor step for migration to run on legacy through `jobs.cfm`. */
export interface LegacyStepRequest {
  readonly job: SiteMonitorStepName;
  /** `formatLegacyTime` output. */
  readonly theTime: string;
  /** `formatLegacyTime` output. */
  readonly lastMonitored: string;
  readonly siteId?: string;
  /** The step's write set in the inventory's unit form. */
  readonly units: readonly string[];
}

/** Migration operations the dispatcher uses. */
export interface MigrationJobsPort {
  /** True only when migration reports every unit `target`-authoritative under the active cut-over version. */
  unitsTargetAuthoritative(units: readonly string[]): Promise<boolean>;
  /** Runs the step on legacy, inside a write window where migration needs one; rejects unless it completed. */
  runLegacyStep(req: LegacyStepRequest, deadlineAt: Date): Promise<void>;
}

/** The run deadline passed while a step was still pending; renders as the legacy 503. */
export class SiteMonitorDeadlineError extends LegacyServiceUnavailableError {
  override readonly name: string = 'SiteMonitorDeadlineError';

  constructor(
    readonly step: SiteMonitorStepName,
    readonly siteId?: string,
  ) {
    super(
      `Site monitor deadline passed during step ${step}${siteId === undefined ? '' : ` for site ${siteId}`}`,
      'auto',
      'sitemonitor-deadline',
    );
  }
}

/** `cfDateTimeFormat` mask of the times `jobs.cfm` receives; milliseconds keep the cursor exact. */
export const LEGACY_TIME_MASK = 'yyyy-MM-dd HH:nn:ss.lll';

// strategies-content's LocalTimestamp: the same wall-clock time with a `T` separator.
const TASK_TIME_MASK = "yyyy-MM-dd'T'HH:nn:ss.lll";

/** Legacy wall-clock time of `d`; the process `TZ` is the legacy server zone. */
export function formatLegacyTime(d: Date): string {
  return cfDateTimeFormat(d, LEGACY_TIME_MASK);
}

/** Queue programs-sites creates a step task on: the strategies-content queue routing `targetPath`, else the site-monitor queue. */
export function resolveStepQueue(targetPath: string): QueueName {
  const def = queuesCreatedBy(SELF).find((q) => q.targetService === STEP_TARGET_SERVICE && q.targetPath === targetPath);
  return def !== undefined && isQueueName(def.name) ? def.name : SITEMONITOR_QUEUE;
}

function kebab(step: SiteMonitorStepName): string {
  return step.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Task name of one step of one run, per site; throws `InvalidTaskNameError` outside the Cloud Tasks charset. */
export function stepTaskName(args: { queue: QueueName; runAt: Date; step: SiteMonitorStepName; siteId?: string }): string {
  let name = `${slotName(args.queue, Math.floor(args.runAt.getTime() / 1000))}-${kebab(args.step)}`;
  if (args.siteId !== undefined) {
    const slug = args.siteId.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    // The slug alone can merge distinct site ids, so a digest of the raw id keeps them apart.
    name += `-${slug}-${createHash('sha256').update(args.siteId).digest('hex').slice(0, 8)}`;
  }
  assertTaskName(name);
  return name;
}

function withSite(siteId: string | undefined): { siteId?: string } {
  return siteId === undefined ? {} : { siteId };
}

/** Migration unit ids of an inventory write set, or undefined when a unit never moves to the target. */
function migrationUnits(units: readonly string[]): string[] | undefined {
  const ids = new Set<string>();
  for (const unit of units) {
    if (unit.startsWith(DECISION_TABLE_PREFIX)) return undefined;
    for (const id of unit === FILE_STORE ? FILE_STORE_UNITS : [unit]) ids.add(id);
  }
  return [...ids];
}

function migrationFailure(operation: string, status: number): Error {
  return status === 503
    ? new LegacyServiceUnavailableError(`Migration ${operation} unavailable`, 'auto', 'migration-unavailable')
    : new Error(`Migration ${operation} answered ${String(status)}`);
}

/** Migration port over the service client, which sends programs-sites' invocation credential and, here, no user token. */
export function createMigrationJobsPort(opts: { client: Pick<ServiceClient, 'request'> }): MigrationJobsPort {
  const { client } = opts;
  return {
    async unitsTargetAuthoritative(units) {
      const ids = migrationUnits(units);
      if (ids === undefined) return false;
      const query: UnitAuthorityQuery = { units: ids.join(',') };
      const res = await client.request<UnitAuthorityResponse>({
        service: MIGRATION,
        method: 'GET',
        path: AUTHORITY_PATH,
        query,
        userToken: null,
      });
      if (res.status !== 200) throw migrationFailure('unitAuthority', res.status);
      return res.body.allTarget && ids.every((id) => res.body.units[id] === 'target');
    },

    // coordination gap: migration/contracts/openapi.yaml declares legacyStepRun synchronous, with no start/status
    // pair, so a legacy step outlasting SERVICE_CALL_TIMEOUT_MS fails closed as the client's ServiceUnavailableError.
    async runLegacyStep(req, deadlineAt) {
      // The contract's body carries no units: migration derives the step's write set itself.
      const body: LegacyStepWireRequest = {
        step: req.job,
        theTime: req.theTime,
        lastMonitored: req.lastMonitored,
        deadlineAt: deadlineAt.toISOString(),
        ...withSite(req.siteId),
      };
      const res = await client.request({ service: MIGRATION, method: 'POST', path: LEGACY_STEPS_PATH, json: body, userToken: null });
      if (res.status === 200) return;
      if (res.status === 504) throw new SiteMonitorDeadlineError(req.job, req.siteId);
      throw migrationFailure(`legacyStepRun(${req.job})`, res.status);
    },
  };
}

/** Dependencies of `createStepDispatcher`; `sleep` and `pollIntervalMs` pace the wait for a target task to leave its queue. */
export interface StepDispatcherOptions {
  port: TaskPort;
  migration: MigrationJobsPort;
  /** `OPT2_SERVICE_URLS`. */
  serviceUrls: Readonly<Record<string, string>>;
  clock: Clock;
  sleep?: (ms: number) => Promise<unknown>;
  pollIntervalMs?: number;
}

/** Dispatcher that reads unit authority per invocation and routes the step to its owner's task or to legacy. */
export function createStepDispatcher(opts: StepDispatcherOptions): StepDispatcher {
  const { port, migration, serviceUrls, clock } = opts;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function taskLive(queue: string, name: string): Promise<boolean> {
    let pageToken: string | undefined;
    do {
      const page = await port.list(queue, pageToken === undefined ? {} : { pageToken });
      if (page.tasks.some((task) => task.name === name)) return true;
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return false;
  }

  async function runOnTarget(inv: StepInvocation, targetPath: string): Promise<NonNullable<StepOutcome['task']>> {
    const step = inv.step.step;
    const queue = resolveStepQueue(targetPath);
    const def = queueDefinition(queue);
    const name = stepTaskName({ queue, runAt: inv.runAt, step, siteId: inv.siteId });
    // Explicit target: the fallback queue's own target service is programs-sites.
    const base = targetUrl({ ...def, targetService: STEP_TARGET_SERVICE, targetPath }, serviceUrls);
    const url = inv.siteId === undefined ? base : `${base}?siteid=${encodeURIComponent(inv.siteId)}`;
    const payload: StepTaskPayload = {
      // steps.ts gives a targetPath only to the steps the strategies-content job routes accept.
      step: step as StepTaskPayload['step'],
      theTime: cfDateTimeFormat(inv.theTime, TASK_TIME_MASK),
      lastMonitored: cfDateTimeFormat(inv.lastMonitored, TASK_TIME_MASK),
      ...withSite(inv.siteId),
    };
    // A system task: no tenantId.
    const { created } = await port.create({ queue, name, scheduleTime: clock.now(), url, body: payload, deadlineS: def.deadlineS });
    while (await taskLive(queue, name)) {
      if (clock.now().getTime() >= inv.deadlineAt.getTime()) throw new SiteMonitorDeadlineError(step, inv.siteId);
      await sleep(pollIntervalMs);
    }
    return { queue, name, created };
  }

  return {
    async dispatch(inv) {
      const { step } = inv;
      if (step.perSite !== (inv.siteId !== undefined)) {
        throw new TypeError(`Site-monitor step ${step.step} ${step.perSite ? 'requires' : 'takes no'} siteId`);
      }
      const outcome = { step: step.step, ...withSite(inv.siteId), theTime: inv.theTime };
      const targetPath = step.targetPath;
      if (targetPath !== undefined && (await migration.unitsTargetAuthoritative(step.units))) {
        return { ...outcome, route: 'target', task: await runOnTarget(inv, targetPath) };
      }
      await migration.runLegacyStep(
        {
          job: step.step,
          theTime: formatLegacyTime(inv.theTime),
          lastMonitored: formatLegacyTime(inv.lastMonitored),
          ...withSite(inv.siteId),
          units: step.units,
        },
        inv.deadlineAt,
      );
      return { ...outcome, route: 'legacy' };
    },
  };
}
