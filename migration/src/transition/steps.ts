// The eight steps of a cut-over transition, their persisted shapes, the abort path and the plan derivation.
import { setTimeout as delay } from 'node:timers/promises';

import type { GatePhase, GateRequest } from '@opt2/platform/migration-kit';
import { callQueueControl, outboxSweepQueue, queuesCreatedBy, reconcileRecurringQueues } from '@opt2/platform/tasks';

import { restartFeedFor } from '../apply/index.js';
import type { MigrationContext } from '../context.js';
import {
  GatewayCallError,
  GatewayWaitTimeoutError,
  currentAuthority,
  diffVersions,
  loadGroups,
  loadVersion,
  type Authority,
  type ChangedEntry,
  type CutoverVersion,
  type GroupsFile,
  type InflightRow,
  type WaitBudget,
} from '../cutover/index.js';
import { diffSnapshotManifests, removeDroppedObjects, transferFiles } from '../files/index.js';
import {
  LegacyRestartError,
  RestartUnavailableError,
  StartupGuardFrozenError,
  countStartupRows,
  opt2SyncReady,
  recoverStartupGuard,
  restartLegacy,
} from '../legacy/index.js';
import { GateConflict, UnknownLegacyTableError, type DataOwner, type UnitCatalog } from '../owners/index.js';
import { DrainTimeoutError, awaitDrained } from '../quiesce/index.js';
import {
  DIFFERENCE_LIMIT,
  fileUnitIds,
  isZeroDifference,
  reconcileUnits,
  writeReconciliationReport,
  type ReconcileReport,
  type ReconcileResult,
} from '../reconcile/index.js';
import type { TransitionStepName } from '../reports/index.js';
import { ProjectionTimeoutError, type Projector } from '../reverse/index.js';
import {
  readSchedulerState,
  siteMonitorJobUnits,
  surveysTouched,
  type PauseResult,
  type RestoreResult,
  type SchedulerScope,
  type SchedulerService,
  type SiteMonitorHandoffResult,
  type SurveysHandoffResult,
} from '../scheduler/index.js';
import { SnapshotBlockedError, latestSnapshot, requireSnapshot, takeSnapshot, type SnapshotRecord } from '../snapshot/index.js';
import {
  LeaseUnavailableError,
  STARTUP_WINDOW_HOLDER_ENV,
  WindowNotFoundError,
  acquireLeases,
  contentUnits,
  importWindow,
  releaseLeases,
  type ImportResult,
  type WindowService,
} from '../windows/index.js';
import { freezeLegacyBound, sendReloadRequest, unfreezeLegacyBound, withGuardLock, type FrozenRoutes } from '../windows/reload.js';

import { assertClaim } from './claim.js';

/** Number of one transition step. */
export type TransitionStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** `migration.transition.state` while a step runs; each step has its own. */
export type TransitionRunningState =
  | 'started'
  | 'quiescing'
  | 'awaiting-inflight'
  | 'draining'
  | 'gates-closed'
  | 'reconciling'
  | 'activating'
  | 'handing-off';

/** Every `migration.transition.state` value. */
export type TransitionState = TransitionRunningState | 'aborting' | 'completed' | 'aborted' | 'failed';

/** States after which a transition no longer changes. */
export const TERMINAL_TRANSITION_STATES = Object.freeze(['completed', 'aborted', 'failed'] as const satisfies readonly TransitionState[]);

/** One step: its number, its `transitions.json` name and the row state while it runs. */
export interface TransitionStepDefinition {
  step: TransitionStepNumber;
  name: TransitionStepName;
  state: TransitionRunningState;
}

/** The steps in execution order. */
export const TRANSITION_STEPS = Object.freeze([
  { step: 1, name: 'transition-set', state: 'started' },
  { step: 2, name: 'stop-new-work', state: 'quiescing' },
  { step: 3, name: 'confirm-inflight-finished', state: 'awaiting-inflight' },
  { step: 4, name: 'drain-effects', state: 'draining' },
  { step: 5, name: 'close-gates', state: 'gates-closed' },
  { step: 6, name: 'final-state-and-reconcile', state: 'reconciling' },
  { step: 7, name: 'activate', state: 'activating' },
  { step: 8, name: 'hand-off-and-reopen', state: 'handing-off' },
] as const satisfies readonly TransitionStepDefinition[]);

/** The migration contract's `Transition.state` for a row state: a failed transition reports as `aborted`. */
export function contractTransitionState(state: TransitionState): 'running' | 'completed' | 'aborted' {
  if (state === 'completed') return 'completed';
  return state === 'aborted' || state === 'failed' ? 'aborted' : 'running';
}

/** What step 1 derives: the transition set `T`, the entries it changes and the facts later steps branch on. */
export interface TransitionPlan {
  /** Active version when the plan was made. */
  from: string;
  to: string;
  /** Units whose authority changes, sorted. */
  setT: string[];
  toTarget: string[];
  toLegacy: string[];
  entriesChanged: ChangedEntry[];
  /** Routes of `legacy-write` entries whose units meet `T`. */
  legacyWriteEntries: string[];
  /** Changed and `legacy-write` routes the active version holds, which the gateway freezes. */
  frozenRoutes: string[];
  /** Owners of `T`. */
  owners: DataOwner[];
  /** The `job` entry changes state. */
  siteMonitorEntryMoves: boolean;
  /** Units of the active version's `job` entry. */
  siteMonitorUnits: string[];
  /** A unit fed by `tcontent`, which Masa's start-up rewrites, becomes `target`-authoritative. */
  contentToTarget: boolean;
  /** A unit fed by the fixture's `cfthread` export jobs is in `T`. */
  exportJobsWriteT: boolean;
  returnsToLegacy: boolean;
}

/** A task queue paused at the service that creates it. */
export interface PausedQueue {
  service: string;
  queue: string;
}

/** A unit gate this transition closed, or may have closed, with the state it is reset to on abort. */
export interface ClosedGate {
  owner: DataOwner;
  unit: string;
  prior: 'open' | 'legacy';
}

/** Step 3's controlled legacy restart while it holds the `target`-authoritative content gates closed around it. */
export interface OrphanRestart {
  /** `target`-authoritative content units whose gates it closed; legacy's start-up may rewrite any of their rows. */
  units: string[];
  /** Gate phase it last set on those gates. */
  phase: GatePhase;
  /** Set just before the restart command runs; from then on no gate of the units reopens before they are imported. */
  restartedAt?: string;
  /** Set once the restart command succeeded, the evidence that no earlier legacy request can still commit; only then are the units imported. */
  completedAt?: string;
  /** Import attempts started; each attempt's apply batch ids are distinct. */
  importAttempts: number;
}

/** Outcome of a {@link TransitionStartupGuard} run: start-up predicate rows before and after any reload. */
export interface StartupGuardResult {
  initialCount: number;
  reloaded: boolean;
  finalCount: number;
}

/** One unit, legacy table and tenant entry a reconciliation found differing. */
export interface DifferingEntry {
  unit: string;
  legacyTable: string | null;
  tenantId: string;
  differenceCount: number;
}

/** Step 6's zero-tolerance reconciliation of a forward transition, kept on the transition because it writes no report file. */
export interface PreActivationReconciliation {
  result: ReconcileResult;
  differences: number;
  unitsWithDifferences: number;
  /** Active cut-over version the comparison saw. */
  tableVersion: string | null;
  snapshotSeq: number | null;
  /** The first {@link DIFFERENCE_LIMIT} differing entries. */
  differingEntries: DifferingEntry[];
}

/** Side effects of the steps so far, persisted as they happen so an abort or a resume finds them. */
export interface TransitionProgress {
  pausedQueues: PausedQueue[];
  schedulerPause?: PauseResult;
  /** Set before the freeze call, so an abort unfreezes even when the freeze's answer was lost. */
  freezeRequested?: boolean;
  freezeEpoch?: number;
  closedGates: ClosedGate[];
  legacyOrphansCleared?: { restartedAt: string; durationMs: number; cleared: number };
  targetOrphans?: InflightRow[];
  targetOrphansCleared?: number;
  /** Content units leased only for a controlled legacy restart. */
  extraLeasedUnits: string[];
  /** The controlled legacy restart in progress; cleared once its gates have reopened. */
  orphanRestart?: OrphanRestart;
  snapshotSeq?: number;
  startupGuard?: StartupGuardResult;
  /** Freeze the start-up guard keeps while rows still match its predicate; recovered before anything is reopened. */
  startupGuardFreeze?: FrozenRoutes;
  preActivationReconciliation?: PreActivationReconciliation;
  /** The written report: `rollback-before` from step 6, or `post-cutover` from step 8 after activation. */
  reconciliation?: { point: string; result: ReconcileResult; differences: number; reportPath: string };
  activatedEpoch?: number;
  handoffs?: { siteMonitor?: SiteMonitorHandoffResult; surveys?: SurveysHandoffResult; restore?: RestoreResult };
  /** Units returned to legacy whose forward feed restarts from a fresh snapshot (`opt2-migrate rollback rebaseline`). */
  rebaselineRequired: string[];
}

/** One step's entry in the transition's step log. */
export interface TransitionStepLog {
  step: TransitionStepNumber;
  name: TransitionStepName;
  startedAt: string;
  finishedAt?: string;
  result?: 'ok' | 'aborted' | 'error';
  detail?: string;
}

/** A `migration.transition` row in camelCase; timestamps are ISO-8601. */
export interface TransitionRecord {
  transitionId: string;
  from: string;
  to: string;
  state: TransitionState;
  /** Last completed step; 0 before step 1 completes. */
  lastStep: 0 | TransitionStepNumber;
  plan?: TransitionPlan;
  progress: TransitionProgress;
  steps: TransitionStepLog[];
  abortReason?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** A step found a blocker; the transition must abort with `reason`. */
export class TransitionAbortedError extends Error {
  override readonly name: string = 'TransitionAbortedError';

  constructor(
    readonly step: TransitionStepNumber,
    readonly reason: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(reason, options);
  }
}

/** Why step 1 refuses a transition before taking any lease. */
export type TransitionPreconditionCode = 'previous-mismatch' | 'same-version' | 'opt2-sync-unavailable';

/** The proposed version cannot follow the active one, or no unit may become `target`-authoritative yet. */
export class TransitionPreconditionError extends Error {
  override readonly name: string = 'TransitionPreconditionError';
  readonly statusCode = 409;

  constructor(
    readonly code: TransitionPreconditionCode,
    message: string,
  ) {
    super(message);
  }
}

/** Converts the rows Masa's start-up would rewrite, keeping every other legacy-bound entry frozen until none is left. */
export interface TransitionStartupGuard {
  /**
   * With matching rows, hands the legacy-bound entries outside `exceptRoutes` to `onFrozen` to record before freezing them,
   * reloads legacy and unfreezes once no row matches; a failed `onFrozen` freezes nothing and a failed freeze unfreezes what
   * it froze, both rethrown.
   * @throws StartupGuardFrozenError, keeping the freeze, when the reload fails or rows still match.
   */
  ensureEmpty(input: { holderId: string; exceptRoutes: string[]; onFrozen(frozen: FrozenRoutes): Promise<void> }): Promise<StartupGuardResult>;
  /** Reloads legacy under a kept freeze and unfreezes it once no row matches. @throws StartupGuardFrozenError, keeping it */
  recover(input: { holderId: string; frozen: FrozenRoutes }): Promise<StartupGuardResult>;
}

/** Ports a step uses; `persist` durably stores progress mid-step. */
export interface StepDeps {
  ctx: MigrationContext;
  projector: Pick<Projector, 'awaitProjection'>;
  windows: Pick<WindowService, 'get'>;
  scheduler: SchedulerService;
  startupGuard: TransitionStartupGuard;
  persist(progress: TransitionProgress): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** What a step returns: the plan (set by step 1) and the progress with its side effects. */
export interface StepOutcome {
  plan?: TransitionPlan;
  progress: TransitionProgress;
}

// Gateway instances refresh their cut-over state every second; epoch and in-flight waits poll at this pace.
const GATEWAY_POLL_MS = 250;
const EXPORT_JOB_POLL_MS = 1000;
/** Masa's start-up rewrites rows of this table (core/appcfc/onApplicationStart_include.cfm:892-929). */
const CONTENT_TABLE = 'tcontent';
const EXPORT_JOB_TABLE = 'synthetic.export_job';
const FILES_TABLE = 'tfiles';
const EXPORT_JOB_TABLE_SQL = "SELECT CASE WHEN OBJECT_ID(N'synthetic.export_job', N'U') IS NULL THEN 0 ELSE 1 END AS present";
const OPEN_EXPORT_JOBS_SQL = "SELECT job_id FROM synthetic.export_job WHERE state IN (N'queued', N'running') ORDER BY job_id";
const POST_CUTOVER_POINT = 'post-cutover';
const ROLLBACK_BEFORE_POINT = 'rollback-before';
/** Gateway answers to an activation that mean the version was refused, never activated. */
const ACTIVATION_REFUSED: ReadonlySet<number> = new Set([400, 409]);

/** Progress of a transition before step 1. */
export function initialTransitionProgress(): TransitionProgress {
  return { pausedQueues: [], closedGates: [], extraLeasedUnits: [], rebaselineRequired: [] };
}

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/** Units the catalog feeds from `table`; none when the ownership file does not list it. */
function tableUnits(catalog: Pick<UnitCatalog, 'unitsForLegacyTable'>, table: string): string[] {
  try {
    return catalog.unitsForLegacyTable(table).map((target) => target.unit);
  } catch (error) {
    if (error instanceof UnknownLegacyTableError) return [];
    throw error;
  }
}

/**
 * Transition set, changed entries, frozen routes and step facts of moving from `active` to `proposed`; arrays are sorted
 * so the persisted plan is deterministic.
 */
export function deriveTransitionPlan(
  active: CutoverVersion,
  proposed: CutoverVersion,
  groups: GroupsFile,
  catalog: Pick<UnitCatalog, 'ownerOf' | 'unitsForLegacyTable'>,
): TransitionPlan {
  const diff = diffVersions(active, proposed, groups);
  const setT = sortedUnique(diff.changedUnits);
  const toTarget = sortedUnique(diff.toTarget);
  const toLegacy = sortedUnique(diff.toLegacy);
  const legacyWriteEntries = sortedUnique(diff.legacyWritesMeetingT.map((entry) => entry.route));
  // The gateway freezes only entries of the active version; a route the proposed version adds routes to legacy until then.
  const activeRoutes = new Set(active.entries.map((entry) => entry.route));
  const frozenRoutes = sortedUnique([...diff.changedEntries.map((entry) => entry.route), ...legacyWriteEntries]).filter((route) =>
    activeRoutes.has(route),
  );
  const meets = (table: string, units: readonly string[]): boolean => tableUnits(catalog, table).some((unit) => units.includes(unit));
  return {
    from: active.tableVersion,
    to: proposed.tableVersion,
    setT,
    toTarget,
    toLegacy,
    entriesChanged: diff.changedEntries,
    legacyWriteEntries,
    frozenRoutes,
    owners: sortedUnique(setT.map((unit) => catalog.ownerOf(unit))),
    siteMonitorEntryMoves: diff.changedEntries.some((change) => change.entry.kind === 'job'),
    siteMonitorUnits: siteMonitorJobUnits(active),
    contentToTarget: meets(CONTENT_TABLE, toTarget),
    exportJobsWriteT: meets(EXPORT_JOB_TABLE, setT),
    returnsToLegacy: toLegacy.length > 0,
  };
}

/**
 * Queues to pause for `owners`: each non-sweep queue a deployed creator makes whose target or creator is an owner, keyed
 * by that creator, which hosts its queue control. Outbox sweeps keep running so effects can drain.
 */
export function queuesToPause(owners: readonly string[], serviceUrls: Readonly<Record<string, string>>): PausedQueue[] {
  const wanted = new Set(owners);
  const pairs = new Map<string, PausedQueue>();
  for (const service of Object.keys(serviceUrls).sort()) {
    for (const queue of queuesCreatedBy(service)) {
      if (queue.name === outboxSweepQueue(queue.targetService)) continue;
      if (!wanted.has(queue.targetService) && !wanted.has(service)) continue;
      pairs.set(`${service}\u0000${queue.name}`, { service, queue: queue.name });
    }
  }
  return [...pairs.values()].sort((a, b) => (a.service === b.service ? compare(a.queue, b.queue) : compare(a.service, b.service)));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Checks that `to` may follow the gateway's active version and derives the plan; it takes no lease.
 * @throws TransitionPreconditionError for the active version itself, a version that does not follow it, or a move to
 *   `target` while the legacy database has no `opt2_sync` schema.
 */
export async function planTransition(
  ctx: Pick<MigrationContext, 'gateway' | 'config' | 'catalog' | 'legacy'>,
  to: string,
): Promise<TransitionPlan> {
  const { tableVersion } = await ctx.gateway.status();
  if (tableVersion === to) throw new TransitionPreconditionError('same-version', `${to} is already the active cut-over version`);
  if (tableVersion === null) {
    throw new TransitionPreconditionError('previous-mismatch', `No cut-over version is active, so ${to} has no version to follow`);
  }
  const { cutoverDir, groupsFile } = ctx.config.paths;
  const proposed = loadVersion(cutoverDir, to);
  if (proposed.previous !== tableVersion) {
    throw new TransitionPreconditionError(
      'previous-mismatch',
      `${to} follows ${proposed.previous ?? 'no version'}, but the active version is ${tableVersion}`,
    );
  }
  const plan = deriveTransitionPlan(loadVersion(cutoverDir, tableVersion), proposed, loadGroups(groupsFile), ctx.catalog);
  if (plan.toTarget.length > 0 && !(await opt2SyncReady(ctx.legacy))) {
    throw new TransitionPreconditionError(
      'opt2-sync-unavailable',
      `The legacy database has no opt2_sync.projector_checkpoint, so ${plan.toTarget.join(', ')} cannot become target-authoritative`,
    );
  }
  return plan;
}

/** State one step works on: the plan, the progress it extends and the holder id of every lease and gate. */
interface StepRun {
  readonly deps: StepDeps;
  readonly ctx: MigrationContext;
  readonly holderId: string;
  readonly plan: TransitionPlan;
  readonly progress: TransitionProgress;
  readonly sleep: (ms: number) => Promise<void>;
  persist(): Promise<void>;
}

function copyProgress(progress: TransitionProgress): TransitionProgress {
  return {
    ...progress,
    pausedQueues: [...progress.pausedQueues],
    closedGates: [...progress.closedGates],
    extraLeasedUnits: [...progress.extraLeasedUnits],
    rebaselineRequired: [...progress.rebaselineRequired],
    ...(progress.handoffs === undefined ? {} : { handoffs: { ...progress.handoffs } }),
  };
}

function gatewayBudget(ctx: Pick<MigrationContext, 'config'>): WaitBudget {
  return { timeoutMs: ctx.config.transition.freezeAckTimeoutMs, intervalMs: GATEWAY_POLL_MS };
}

function describeRows(rows: readonly InflightRow[]): string {
  return rows.map((row) => `${row.side} ${row.route} on instance ${row.instanceId} (${String(row.count)} since ${row.oldestStartedAt})`).join('; ');
}

/** `units` grouped by owner and by the gate state `stateOf` gives each, in owner then state order. */
function byOwnerAndState<S extends string>(
  catalog: Pick<UnitCatalog, 'ownerOf'>,
  units: readonly string[],
  stateOf: (unit: string) => S,
): { owner: DataOwner; state: S; units: string[] }[] {
  const groups = new Map<string, { owner: DataOwner; state: S; units: string[] }>();
  for (const unit of sortedUnique(units)) {
    const owner = catalog.ownerOf(unit);
    const state = stateOf(unit);
    const key = `${owner}\u0000${state}`;
    const group = groups.get(key) ?? { owner, state, units: [] };
    group.units.push(unit);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.owner === b.owner ? compare(a.state, b.state) : compare(a.owner, b.owner)));
}

/** Names a lease holder for an abort reason: a write window with its route and phase, or the bare id. */
async function describeHolder(deps: StepDeps, holderId: string): Promise<string> {
  try {
    const window = await deps.windows.get(holderId);
    return `write window ${holderId} (${window.routeKey}, ${window.state}, phase ${window.phase})`;
  } catch (error) {
    if (error instanceof WindowNotFoundError) return `${holderId} (no write window)`;
    throw error;
  }
}

/** Leases `units` to the transition, keeping those it already holds. @throws TransitionAbortedError naming the other holders */
async function leaseUnits(deps: StepDeps, holderId: string, units: readonly string[], step: TransitionStepNumber): Promise<void> {
  try {
    await acquireLeases(deps.ctx, {
      units: [...units],
      holderId,
      kind: 'transition',
      // A transition waits for other holders' leases as long as a window's open does.
      budgetMs: deps.ctx.config.windows.openBudgetMs,
      sleep: deps.sleep,
    });
  } catch (error) {
    if (!(error instanceof LeaseUnavailableError)) throw error;
    const holders = await Promise.all(error.conflictingHolders.map((holder) => describeHolder(deps, holder)));
    throw new TransitionAbortedError(
      step,
      `Units ${error.units.join(', ')} stay leased by ${holders.length > 0 ? holders.join('; ') : 'another holder'}`,
      { conflictingHolders: error.conflictingHolders },
      { cause: error },
    );
  }
}

/** Waits until every live gateway instance has seen `epoch`. @throws TransitionAbortedError naming the lagging instances */
async function awaitEpochOrAbort(run: StepRun, epoch: number, step: TransitionStepNumber): Promise<void> {
  try {
    await run.ctx.gateway.awaitEpoch(epoch, gatewayBudget(run.ctx));
  } catch (error) {
    if (!(error instanceof GatewayWaitTimeoutError)) throw error;
    throw new TransitionAbortedError(step, error.message, { lagging: error.lagging }, { cause: error });
  }
}

/** Step 1: plans the transition and leases `T`, which waits for any write window on it. */
async function transitionSet(deps: StepDeps, record: TransitionRecord): Promise<TransitionPlan> {
  const plan = await planTransition(deps.ctx, record.to);
  await leaseUnits(deps, record.transitionId, plan.setT, 1);
  return plan;
}

function schedulerScope(plan: TransitionPlan, siteMonitorEntryMoves = plan.siteMonitorEntryMoves): SchedulerScope {
  return { siteMonitorUnits: plan.siteMonitorUnits, siteMonitorEntryMoves };
}

function sameQueue(a: PausedQueue, b: PausedQueue): boolean {
  return a.service === b.service && a.queue === b.queue;
}

/** Step 2: pauses the legacy tasks and owners' queues writing `T`, then freezes its entries until every instance has seen it. */
async function stopNewWork(run: StepRun): Promise<void> {
  const { ctx, plan, progress } = run;
  if (progress.schedulerPause === undefined) {
    progress.schedulerPause = await run.deps.scheduler.pauseFor(plan.setT, schedulerScope(plan));
    await run.persist();
  }
  // Every queue is paused again on a resumed step, since a recorded pause may never have reached its service.
  for (const paused of queuesToPause(plan.owners, ctx.env.OPT2_SERVICE_URLS)) {
    if (!progress.pausedQueues.some((recorded) => sameQueue(recorded, paused))) {
      progress.pausedQueues.push(paused);
      await run.persist();
    }
    await callQueueControl(ctx.client, { ...paused, op: 'pause' });
  }
  if (plan.frozenRoutes.length === 0) return;
  if (progress.freezeRequested !== true) {
    progress.freezeRequested = true;
    await run.persist();
  }
  const { epoch } = await ctx.gateway.freeze(plan.frozenRoutes);
  progress.freezeEpoch = epoch;
  await run.persist();
  await awaitEpochOrAbort(run, epoch, 2);
}

/** Waits for live in-flight writes on the frozen entries; rows of dead instances come back as orphans. */
async function awaitInflight(run: StepRun): Promise<InflightRow[]> {
  try {
    return (await run.ctx.gateway.awaitInflightDrained(run.plan.frozenRoutes, gatewayBudget(run.ctx))).orphans;
  } catch (error) {
    if (!(error instanceof GatewayWaitTimeoutError)) throw error;
    throw new TransitionAbortedError(3, error.message, { pending: error.pending }, { cause: error });
  }
}

/** Members of a step run that the restart import and the start-up guard use; an abort builds one from its record. */
type RestartRun = Pick<StepRun, 'deps' | 'ctx' | 'plan' | 'progress' | 'holderId' | 'persist'>;

/**
 * Runs the start-up guard, or recovers the freeze it kept, with that freeze recorded in the progress until no row matches.
 * @throws StartupGuardFrozenError while the freeze is kept.
 */
async function guardStartup(run: RestartRun): Promise<StartupGuardResult> {
  const { plan, progress, holderId } = run;
  const kept = progress.startupGuardFreeze;
  const onFrozen = async (frozen: FrozenRoutes): Promise<void> => {
    progress.startupGuardFreeze = frozen;
    await run.persist();
  };
  const result =
    kept === undefined
      ? await run.deps.startupGuard.ensureEmpty({ holderId, exceptRoutes: plan.frozenRoutes, onFrozen })
      : await run.deps.startupGuard.recover({ holderId, frozen: kept });
  if (progress.startupGuardFreeze !== undefined) {
    delete progress.startupGuardFreeze;
    await run.persist();
  }
  return result;
}

/** Aborts at `step` while `work` leaves the start-up guard's freeze kept; the abort recovers it before reopening anything. */
async function abortWhileFrozen<T>(step: TransitionStepNumber, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (!(error instanceof StartupGuardFrozenError)) throw error;
    throw new TransitionAbortedError(step, error.message, { remaining: error.remaining }, { cause: error });
  }
}

/** Sets `phase` on the gates of `units` this holder closed, owner by owner. */
async function setGatePhase(run: Pick<StepRun, 'ctx' | 'holderId'>, units: readonly string[], phase: GatePhase): Promise<void> {
  for (const { owner, units: ownerUnits } of byOwnerAndState(run.ctx.catalog, units, () => phase)) {
    await run.ctx.owners.gate(owner, { op: 'phase', units: ownerUnits, holderId: run.holderId, phase });
  }
}

/**
 * Closes the gates of the `target`-authoritative content units for this holder, recorded before the close, then waits until
 * the reverse projector has applied their owners' current writes, so legacy restarts on current data.
 * @throws TransitionAbortedError when another holder holds a gate or the projection does not catch up in time.
 */
async function fenceContentForRestart(run: StepRun): Promise<OrphanRestart> {
  const { ctx, progress, holderId } = run;
  const authority = await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });
  const units = contentUnits(ctx.catalog).filter((unit) => authority.isTargetAuthoritative(unit));
  const previous = progress.orphanRestart;
  const restart: OrphanRestart = { importAttempts: 0, ...previous, units: sortedUnique([...(previous?.units ?? []), ...units]), phase: 'quiet' };
  const fresh = restart.units.filter((unit) => !progress.closedGates.some((gate) => gate.unit === unit));
  progress.closedGates.push(...fresh.map((unit): ClosedGate => ({ owner: ctx.catalog.ownerOf(unit), unit, prior: 'open' })));
  progress.orphanRestart = restart;
  await run.persist();
  const groups = byOwnerAndState(ctx.catalog, restart.units, (): GatePhase => 'quiet');
  if (groups.length === 0) return restart;
  for (const { owner, units: ownerUnits } of groups) {
    try {
      await ctx.owners.gate(owner, { op: 'close', units: ownerUnits, holderId, phase: 'quiet' });
    } catch (error) {
      if (!(error instanceof GateConflict)) throw error;
      throw new TransitionAbortedError(3, `${owner} gates ${error.units.join(', ')} are held by another holder`, { owner, units: error.units }, {
        cause: error,
      });
    }
  }
  try {
    await run.deps.projector.awaitProjection({ owners: groups.map((group) => group.owner), timeoutMs: ctx.config.projection.defaultAwaitTimeoutMs });
  } catch (error) {
    if (!(error instanceof ProjectionTimeoutError)) throw error;
    throw new TransitionAbortedError(3, error.message, { pending: error.pending }, { cause: error });
  }
  await setGatePhase(run, restart.units, 'executing');
  return { ...restart, phase: 'executing' };
}

/** Sets the importing phase on the restart's gates once, recording it. */
async function enterImporting(run: RestartRun, restart: OrphanRestart): Promise<OrphanRestart> {
  if (restart.phase === 'importing') return restart;
  await setGatePhase(run, restart.units, 'importing');
  const importing: OrphanRestart = { ...restart, phase: 'importing' };
  run.progress.orphanRestart = importing;
  await run.persist();
  return importing;
}

/**
 * Imports the restart's units whole, since legacy's start-up may rewrite any of their rows, and converts any start-up
 * predicate rows before their gates reopen; each attempt's number is persisted first, so batch ids never repeat.
 * @throws StartupGuardFrozenError with the guard's freeze kept, or the import failure; the gates stay closed either way.
 */
async function importRestartedContent(run: RestartRun, restart: OrphanRestart): Promise<void> {
  const { ctx, progress, holderId } = run;
  let current = await enterImporting(run, restart);
  if (current.units.length === 0) return;
  const importOnce = async (): Promise<ImportResult> => {
    current = { ...current, importAttempts: current.importAttempts + 1 };
    progress.orphanRestart = current;
    await run.persist();
    const result = await importWindow(ctx, { windowId: holderId, attempt: current.importAttempts, units: current.units, scope: { table: true } });
    ctx.logger.info(
      `Transition ${holderId}: import attempt ${String(current.importAttempts)} after the legacy restart applied ${String(result.rowsImported)} rows`,
    );
    return result;
  };
  const { touchedContent } = await importOnce();
  // A reload converts rows under these still-closed gates, so what it wrote is imported as well.
  if ((touchedContent || progress.startupGuardFreeze !== undefined) && (await guardStartup(run)).reloaded) await importOnce();
}

/**
 * Runs the controlled legacy restart under this holder with the restart's gates still closed, recording its intent before
 * the command and its completion once the command succeeded. @returns the completed restart and the command's duration
 * @throws TransitionAbortedError at step 3 with `details` when the restart is unavailable or fails; nothing records completion
 */
async function restartUnderHolder(
  run: RestartRun,
  restart: OrphanRestart,
  details: unknown,
): Promise<{ restart: OrphanRestart; restartedAt: string; durationMs: number }> {
  const { ctx, progress, holderId } = run;
  const restartedAt = ctx.clock.now().toISOString();
  const intent: OrphanRestart = { units: restart.units, phase: restart.phase, importAttempts: restart.importAttempts, restartedAt };
  progress.orphanRestart = intent;
  await run.persist();
  let durationMs: number;
  try {
    assertClaim();
    // The configuration names no restart budget; the gateway lease duration bounds it, as for a window's restart.
    ({ durationMs } = await restartLegacy(ctx.env, {
      timeoutMs: ctx.config.windows.gatewayLeaseMs,
      extraEnv: { [STARTUP_WINDOW_HOLDER_ENV]: holderId },
    }));
  } catch (error) {
    if (!(error instanceof RestartUnavailableError) && !(error instanceof LegacyRestartError)) throw error;
    throw new TransitionAbortedError(3, `Controlled legacy restart failed: ${error.message}`, details, { cause: error });
  }
  const completed: OrphanRestart = { ...intent, completedAt: ctx.clock.now().toISOString() };
  progress.orphanRestart = completed;
  await run.persist();
  return { restart: completed, restartedAt, durationMs };
}

/**
 * Ends step 3's restart: one cut short before its completion runs again under the still-closed gates, then what legacy's
 * start-up may have written is imported before the fenced gates reopen by holder compare-and-set.
 */
async function finishOrphanRestart(run: StepRun): Promise<void> {
  let restart = run.progress.orphanRestart;
  if (restart === undefined) return;
  if (restart.restartedAt !== undefined) {
    if (restart.completedAt === undefined) ({ restart } = await restartUnderHolder(run, restart, { units: restart.units }));
    await abortWhileFrozen(3, importRestartedContent(run, restart));
  }
  await resetGates(run, restart.units);
  delete run.progress.orphanRestart;
  await run.persist();
}

/**
 * Ends every running legacy request by a controlled restart under this holder, within a write window's restart lifecycle
 * over the content units, and clears the legacy orphans it covers.
 */
async function clearLegacyOrphans(run: StepRun, orphans: readonly InflightRow[]): Promise<void> {
  const { ctx, plan, progress, holderId } = run;
  if ((ctx.env.OPT2_LEGACY_RESTART_CMD ?? '').trim() === '') {
    throw new TransitionAbortedError(
      3,
      `Orphaned legacy-bound writes need a controlled legacy restart, but OPT2_LEGACY_RESTART_CMD is not set: ${describeRows(orphans)}`,
      { orphans },
    );
  }
  // The start-up the restart runs then happens under this holder's leases and gates, so legacy-start.sh opens no window of its own.
  const extra = contentUnits(ctx.catalog).filter((unit) => !plan.setT.includes(unit));
  const missing = extra.filter((unit) => !progress.extraLeasedUnits.includes(unit));
  if (missing.length > 0) {
    progress.extraLeasedUnits = sortedUnique([...progress.extraLeasedUnits, ...missing]);
    await run.persist();
  }
  await leaseUnits(run.deps, holderId, extra, 3);
  const { restart, restartedAt, durationMs } = await restartUnderHolder(run, await fenceContentForRestart(run), { orphans });
  await enterImporting(run, restart);
  const { cleared } = await ctx.gateway.clearOrphans({
    side: 'legacy',
    evidence: { kind: 'legacy-restart', holderId, at: restartedAt },
    instanceIds: sortedUnique(orphans.map((row) => row.instanceId)),
  });
  progress.legacyOrphansCleared = { restartedAt, durationMs, cleared };
  await run.persist();
  ctx.logger.info(`Transition ${holderId}: legacy restarted in ${String(durationMs)} ms, ${String(cleared)} orphaned legacy writes cleared`);
  await finishOrphanRestart(run);
}

/** Waits until the fixture's `cfthread` export jobs have left `queued` and `running`. */
async function awaitExportJobs(run: StepRun): Promise<void> {
  const { ctx } = run;
  const pool = await ctx.legacy.live();
  const table = await pool.request().query<{ present: number }>(EXPORT_JOB_TABLE_SQL);
  if (table.recordset[0]?.present !== 1) return;
  const deadline = ctx.clock.now().getTime() + ctx.config.transition.cfthreadWaitMs;
  for (;;) {
    const { recordset } = await pool.request().query<{ job_id: string }>(OPEN_EXPORT_JOBS_SQL);
    if (recordset.length === 0) return;
    if (ctx.clock.now().getTime() >= deadline) {
      const jobs = recordset.map((row) => row.job_id);
      throw new TransitionAbortedError(3, `Fixture export jobs are still queued or running: ${jobs.join(', ')}`, { jobs });
    }
    await run.sleep(EXPORT_JOB_POLL_MS);
  }
}

/** Step 3: confirms the frozen entries' in-flight writes have finished, clearing orphans only with evidence. */
async function confirmInflightFinished(run: StepRun): Promise<void> {
  const { plan, progress } = run;
  let orphans = plan.frozenRoutes.length === 0 ? [] : await awaitInflight(run);
  const legacyOrphans = orphans.filter((row) => row.side === 'legacy');
  if (legacyOrphans.length > 0) {
    await clearLegacyOrphans(run, legacyOrphans);
    orphans = await awaitInflight(run);
    const left = orphans.filter((row) => row.side === 'legacy');
    if (left.length > 0) {
      throw new TransitionAbortedError(3, `Orphaned legacy-bound writes remain after the restart: ${describeRows(left)}`, { orphans: left });
    }
  } else {
    // A restart a process exit cut short still imports and reopens what it fenced.
    await finishOrphanRestart(run);
  }
  // Closing the gates in step 5 is the evidence that these can no longer commit.
  progress.targetOrphans = orphans.filter((row) => row.side === 'target');
  await run.persist();
  if (plan.exportJobsWriteT) await awaitExportJobs(run);
}

/** Step 4: with the gates still open, waits until `T`'s owners have published and its consumers have received every event. */
async function drainEffects(run: StepRun): Promise<void> {
  const { ctx, plan } = run;
  if (plan.setT.length === 0) return;
  try {
    await awaitDrained(ctx, {
      owners: plan.owners,
      consumersWriting: plan.setT,
      timeoutMs: ctx.config.transition.drainTimeoutMs,
      sleep: run.deps.sleep,
    });
  } catch (error) {
    if (!(error instanceof DrainTimeoutError)) throw error;
    throw new TransitionAbortedError(4, `Effects did not drain: ${error.message}`, { owners: error.owners }, { cause: error });
  }
}

/** Step 5: closes `T`'s gates for this holder, which drains the owners' writers, then clears target orphans on that evidence. */
async function closeGates(run: StepRun): Promise<void> {
  const { ctx, plan, progress, holderId } = run;
  const toTarget = new Set(plan.toTarget);
  const groups = byOwnerAndState(ctx.catalog, plan.setT, (unit): ClosedGate['prior'] => (toTarget.has(unit) ? 'legacy' : 'open'));
  for (const { owner, state: prior, units } of groups) {
    // Recorded before the call, so an abort resets a gate whose close succeeded with its answer lost.
    const fresh = units.filter((unit) => !progress.closedGates.some((gate) => gate.unit === unit));
    if (fresh.length > 0) {
      progress.closedGates.push(...fresh.map((unit) => ({ owner, unit, prior })));
      await run.persist();
    }
    const request: GateRequest = { op: 'close', units, holderId, phase: 'quiet', ...(prior === 'legacy' ? { allowLegacy: true } : {}) };
    try {
      await ctx.owners.gate(owner, request);
    } catch (error) {
      if (!(error instanceof GateConflict)) throw error;
      throw new TransitionAbortedError(5, `${owner} gates ${error.units.join(', ')} are held by another holder`, { owner, units: error.units }, {
        cause: error,
      });
    }
  }
  const orphans = progress.targetOrphans ?? [];
  if (orphans.length === 0) return;
  const { cleared } = await ctx.gateway.clearOrphans({
    side: 'target',
    evidence: { kind: 'gates-closed', holderId, at: ctx.clock.now().toISOString(), units: plan.setT },
    instanceIds: sortedUnique(orphans.map((row) => row.instanceId)),
  });
  progress.targetOrphansCleared = cleared;
  await run.persist();
}

/** The transition's final snapshot, taken once and reused on a resumed step. */
async function transitionSnapshot(run: StepRun): Promise<SnapshotRecord> {
  const { ctx, progress, holderId } = run;
  if (progress.snapshotSeq !== undefined) return requireSnapshot(ctx, progress.snapshotSeq);
  let snapshot: SnapshotRecord;
  try {
    snapshot = await takeSnapshot(ctx, { kind: 'transition', holderId });
  } catch (error) {
    if (!(error instanceof SnapshotBlockedError)) throw error;
    throw new TransitionAbortedError(6, error.message, { leases: error.leases }, { cause: error });
  }
  progress.snapshotSeq = snapshot.seq;
  await run.persist();
  return snapshot;
}

/** Transfers the file-store objects added or changed since the file owners' `tfiles` watermark and deletes those dropped, before the table pass advances it. */
async function transferMovedFiles(run: StepRun, snapshot: SnapshotRecord, fileFeedUnits: readonly string[]): Promise<void> {
  const { ctx, holderId } = run;
  if (!snapshot.manifestComplete) {
    const store = snapshot.fileStore?.status === 'unsupported' ? `: site ${snapshot.fileStore.siteId} uses ${snapshot.fileStore.fileStore}` : '';
    throw new TransitionAbortedError(6, `Snapshot ${String(snapshot.seq)} has no complete file manifest${store}, so the file units cannot move`, {
      fileStore: snapshot.fileStore,
    });
  }
  const owners = sortedUnique(fileFeedUnits.map((unit) => ctx.catalog.ownerOf(unit)));
  const bases = await Promise.all(owners.map(async (owner) => (await ctx.owners.watermark(owner, FILES_TABLE, 'forward'))?.snapshotSeq ?? null));
  const from = bases.some((base) => base === null) ? null : Math.min(...(bases as number[]));
  if (from !== null && from >= snapshot.seq) return;
  const diff = from === null ? undefined : await diffSnapshotManifests(ctx, from, snapshot.seq);
  const result = await transferFiles(ctx, snapshot.seq, diff === undefined ? {} : { only: diff.toTransfer });
  const removal = diff === undefined ? undefined : await removeDroppedObjects(ctx, diff);
  ctx.logger.info(
    `Transition ${holderId}: file objects of snapshot ${String(snapshot.seq)} since ${from === null ? 'none' : String(from)}: ` +
      `${String(result.transferred)} stored, ${String(result.unchanged)} unchanged, ${String(removal?.deleted ?? 0)} deleted`,
  );
}

/** Brings the units moving to `target` to the final snapshot of the quiesced legacy database. */
async function bringToFinalState(run: StepRun): Promise<void> {
  const { ctx, plan } = run;
  const snapshot = await transitionSnapshot(run);
  const fileFeedUnits = tableUnits(ctx.catalog, FILES_TABLE).filter((unit) => plan.toTarget.includes(unit));
  if (fileFeedUnits.length > 0) await transferMovedFiles(run, snapshot, fileFeedUnits);
  // The units are still legacy-authoritative here, so the feed may write them. restartFeedFor brings exactly these units, in
  // dependency order, to the snapshot by comparing each owner's export; a per-table diff would need the extract layer's table model.
  const restarted = await restartFeedFor(ctx, { units: plan.toTarget, snapshotSeq: snapshot.seq });
  ctx.logger.info(`Transition ${run.holderId}: ${String(restarted.tables.length)} table shares brought to snapshot ${String(snapshot.seq)}`);
}

/** Waits until the reverse projector has applied every current write position of the owners of the units moving to `legacy`. */
async function projectToLegacy(run: StepRun): Promise<void> {
  const { ctx, plan } = run;
  const owners = sortedUnique(plan.toLegacy.map((unit) => ctx.catalog.ownerOf(unit)));
  try {
    await run.deps.projector.awaitProjection({ owners, timeoutMs: ctx.config.projection.defaultAwaitTimeoutMs });
  } catch (error) {
    if (!(error instanceof ProjectionTimeoutError)) throw error;
    throw new TransitionAbortedError(6, error.message, { pending: error.pending }, { cause: error });
  }
}

/** Reconciles `T`, and the file units when their objects move, at `point` against the live legacy database with zero tolerance. */
function reconcileT(run: StepRun, point: string, snapshotSeq: number | null): Promise<ReconcileReport> {
  const { ctx, plan } = run;
  const filesMove = tableUnits(ctx.catalog, FILES_TABLE).some((unit) => plan.setT.includes(unit));
  return reconcileUnits(ctx, {
    point,
    units: sortedUnique([...plan.setT, ...(filesMove ? fileUnitIds(ctx.config) : [])]),
    database: ctx.env.MURA_DATABASE,
    snapshotSeq,
    legacySource: 'live',
  });
}

/** Writes `report`, records it as the transition's reconciliation and refuses any difference. @throws TransitionAbortedError at `step` */
async function recordReport(run: StepRun, report: ReconcileReport, step: TransitionStepNumber): Promise<void> {
  const reportPath = await writeReconciliationReport(run.ctx, report);
  const { differences, unitsWithDifferences } = report.summary;
  run.progress.reconciliation = { point: report.point, result: report.result, differences, reportPath };
  await run.persist();
  if (report.result !== 'zero-difference') {
    throw new TransitionAbortedError(
      step,
      `Reconciliation ${report.point} found ${String(differences)} differences in ${String(unitsWithDifferences)} units; see ${reportPath}`,
      run.progress.reconciliation,
    );
  }
}

/** Step 6's reconciliation of `T`: `rollback-before.json` for a return to legacy, else the pre-activation verdict. @throws TransitionAbortedError */
async function reconcileSet(run: StepRun): Promise<void> {
  const { progress } = run;
  const snapshotSeq = progress.snapshotSeq ?? null;
  if (run.plan.returnsToLegacy) {
    await recordReport(run, await reconcileT(run, ROLLBACK_BEFORE_POINT, snapshotSeq), 6);
    return;
  }
  // The post-cut-over point's expectations are compared; the active version is still the one before it.
  const report = await reconcileT(run, POST_CUTOVER_POINT, snapshotSeq);
  const differing = report.units.filter((entry) => !isZeroDifference(entry, entry.files));
  const { differences, unitsWithDifferences } = report.summary;
  progress.preActivationReconciliation = {
    result: report.result,
    differences,
    unitsWithDifferences,
    tableVersion: report.tableVersion,
    snapshotSeq: report.snapshotSeq,
    differingEntries: differing
      .slice(0, DIFFERENCE_LIMIT)
      .map(({ unit, legacyTable, tenantId, differenceCount }) => ({ unit, legacyTable, tenantId, differenceCount })),
  };
  await run.persist();
  if (report.result !== 'zero-difference') {
    const units = sortedUnique(differing.map((entry) => entry.unit));
    throw new TransitionAbortedError(
      6,
      `Reconciliation before activation found ${String(differences)} differences in ${String(unitsWithDifferences)} units: ${units.join(', ')}`,
      progress.preActivationReconciliation,
    );
  }
}

/** Writes a forward transition's `post-cutover.json` after activation, before anything reopens, until it passes. @throws TransitionAbortedError */
async function reconcilePostCutover(run: StepRun): Promise<void> {
  const { ctx, plan, progress } = run;
  if (plan.returnsToLegacy || plan.setT.length === 0) return;
  const done = progress.reconciliation;
  if (done?.point === POST_CUTOVER_POINT && done.result === 'zero-difference') return;
  // Without a transition snapshot a live point records the latest ready one, as `opt2-migrate reconcile` does.
  const snapshotSeq = progress.snapshotSeq ?? (await latestSnapshot(ctx))?.seq ?? null;
  await recordReport(run, await reconcileT(run, POST_CUTOVER_POINT, snapshotSeq), 8);
}

/** Step 6: final state of `T` on both sides, then its reconciliation; any difference aborts. */
async function finalStateAndReconcile(run: StepRun): Promise<void> {
  const { plan, progress } = run;
  if (plan.contentToTarget) {
    progress.startupGuard = await abortWhileFrozen(6, guardStartup(run));
    await run.persist();
  }
  if (plan.toTarget.length > 0) await bringToFinalState(run);
  if (plan.toLegacy.length > 0) await projectToLegacy(run);
  if (plan.setT.length > 0) await reconcileSet(run);
}

/** Step 7: activates the proposed version once and waits until every live instance has seen it. */
async function activate(run: StepRun): Promise<void> {
  const { ctx, plan, progress } = run;
  const status = await ctx.gateway.status();
  let epoch = progress.activatedEpoch ?? status.epoch;
  if (status.tableVersion !== plan.to) {
    let activated: Awaited<ReturnType<MigrationContext['gateway']['activate']>>;
    try {
      activated = await ctx.gateway.activate(plan.to);
    } catch (error) {
      if (!(error instanceof GatewayCallError) || !ACTIVATION_REFUSED.has(error.status)) throw error;
      throw new TransitionAbortedError(7, `The gateway refused to activate ${plan.to} (HTTP ${String(error.status)})`, error.body, {
        cause: error,
      });
    }
    epoch = activated.epoch;
    progress.activatedEpoch = epoch;
    await run.persist();
  }
  await ctx.gateway.awaitEpoch(epoch, gatewayBudget(ctx));
}

/** State the proposed version gives the `job` entry, when the transition changes it. */
function siteMonitorDestination(plan: TransitionPlan): Authority | null {
  return plan.entriesChanged.find((change) => change.entry.kind === 'job')?.to ?? null;
}

/** Resumes every queue the transition paused. */
async function resumeQueues(run: Pick<StepRun, 'ctx' | 'progress' | 'persist'>): Promise<void> {
  const { ctx, progress } = run;
  if (progress.pausedQueues.length === 0) return;
  for (const paused of progress.pausedQueues) await callQueueControl(ctx.client, { ...paused, op: 'resume' });
  progress.pausedQueues = [];
  await run.persist();
}

/** Unfreezes the plan's routes if this transition asked for their freeze. */
async function unfreezeRoutes(run: Pick<StepRun, 'ctx' | 'progress' | 'persist'>, plan: TransitionPlan): Promise<void> {
  const { ctx, progress } = run;
  if (progress.freezeRequested !== true) return;
  await ctx.gateway.unfreeze(plan.frozenRoutes);
  progress.freezeRequested = false;
  await run.persist();
}

/** Step 8: reconciles post-cut-over, hands off the schedulers, reopens `T`'s gates under the new authority, releases the leases and resumes work. */
async function handOffAndReopen(run: StepRun): Promise<void> {
  const { ctx, plan, progress, holderId, deps } = run;
  await reconcilePostCutover(run);
  const handoffs = (progress.handoffs ??= {});
  const monitorTo = siteMonitorDestination(plan);
  if (handoffs.siteMonitor === undefined && plan.siteMonitorEntryMoves && monitorTo === 'target') {
    handoffs.siteMonitor = await deps.scheduler.handOffSiteMonitorToTarget();
    await run.persist();
  }
  if (handoffs.surveys === undefined && surveysTouched(plan.toTarget, ctx.catalog)) {
    handoffs.surveys = await deps.scheduler.handOffSurveysToTarget();
    await run.persist();
  }
  if (handoffs.restore === undefined && plan.toLegacy.length > 0) {
    // Only a monitor whose entry returns to legacy is restored; one handed to the target above stays there.
    handoffs.restore = await deps.scheduler.restoreToLegacy(plan.toLegacy, schedulerScope(plan, plan.siteMonitorEntryMoves && monitorTo === 'legacy'));
    await run.persist();
  }

  const toTarget = new Set(plan.toTarget);
  for (const { owner, state, units } of byOwnerAndState(ctx.catalog, plan.setT, (unit): Authority => (toTarget.has(unit) ? 'target' : 'legacy'))) {
    await ctx.owners.gate(owner, { op: 'open', units, holderId, state: state === 'target' ? 'open' : 'legacy' });
  }
  progress.closedGates = [];
  await run.persist();
  await releaseLeases(ctx, holderId);
  progress.extraLeasedUnits = [];
  await run.persist();

  await unfreezeRoutes(run, plan);
  await resumeQueues(run);
  await deps.scheduler.resumePaused();
  // `ping=false` leaves no native task, and then the target monitor's chain stays absent.
  const { sitemonitor } = await readSchedulerState(ctx.db, ctx.clock.now());
  const reconciled = await reconcileRecurringQueues(ctx.client, {
    serviceUrls: ctx.env.OPT2_SERVICE_URLS,
    withSiteMonitor: sitemonitor.nativeExisted && sitemonitor.state === 'target',
  });
  const failed = reconciled.filter((result) => !result.ok);
  if (failed.length > 0) {
    ctx.logger.warn(
      `Transition ${holderId}: recurring chains not ensured, left to the periodic reconcile: ` +
        failed.map((result) => `${result.queue} on ${result.service}`).join(', '),
    );
  }
  progress.rebaselineRequired = [...plan.toLegacy];
  await run.persist();
}

const STEP_RUNNERS: Readonly<Record<Exclude<TransitionStepNumber, 1>, (run: StepRun) => Promise<void>>> = {
  2: stopNewWork,
  3: confirmInflightFinished,
  4: drainEffects,
  5: closeGates,
  6: finalStateAndReconcile,
  7: activate,
  8: handOffAndReopen,
};

/**
 * Runs one step of `record`; each step is idempotent, so a resumed transition re-runs its first unfinished step.
 * @returns the plan, which step 1 derives, and the progress extended with the step's side effects.
 * @throws TransitionAbortedError when the transition must abort; TransitionPreconditionError from step 1.
 */
export async function runTransitionStep(deps: StepDeps, record: TransitionRecord, step: TransitionStepNumber): Promise<StepOutcome> {
  const progress = copyProgress(record.progress);
  if (step === 1) return { plan: await transitionSet(deps, record), progress };
  const { plan } = record;
  if (plan === undefined) throw new Error(`Transition ${record.transitionId} has no plan, so step ${String(step)} cannot run before step 1`);
  const run: StepRun = {
    deps,
    ctx: deps.ctx,
    holderId: record.transitionId,
    plan,
    progress,
    sleep: deps.sleep ?? ((ms: number) => delay(ms)),
    persist: () => deps.persist(progress),
  };
  await STEP_RUNNERS[step](run);
  return { plan, progress };
}

/** Resets the gates of `only` (default every gate) the transition closed, or may have closed, to their prior state by holder compare-and-set. */
async function resetGates(run: Pick<StepRun, 'ctx' | 'progress' | 'persist' | 'holderId'>, only?: readonly string[]): Promise<void> {
  const { ctx, progress, holderId } = run;
  const priors = new Map(progress.closedGates.map((gate) => [gate.unit, gate.prior]));
  const units = progress.closedGates.map((gate) => gate.unit).filter((unit) => only === undefined || only.includes(unit));
  for (const { owner, state, units: ownerUnits } of byOwnerAndState(ctx.catalog, units, (unit) => priors.get(unit) ?? 'open')) {
    try {
      await ctx.owners.gate(owner, { op: 'open', units: ownerUnits, holderId, state });
    } catch (error) {
      if (!(error instanceof GateConflict)) throw error;
      // A gate another holder took was never closed by this transition.
      ctx.logger.warn(`Transition ${holderId}: gates ${error.units.join(', ')} at ${owner} were not this transition's to reset`);
    }
    progress.closedGates = progress.closedGates.filter((gate) => !ownerUnits.includes(gate.unit));
    await run.persist();
  }
}

/**
 * Undoes the side effects of an unactivated transition in reverse order (a kept start-up guard freeze, the completion and
 * import of a started legacy restart, gates, freeze, queues, legacy tasks, then leases) and returns the cleaned progress;
 * each undo is idempotent and persisted, so a failed abort can be resumed.
 * @throws Error once step 7 has completed or the proposed version is already active; StartupGuardFrozenError or the
 *   import failure, reopening nothing, while a kept guard freeze or a restart's import cannot finish; TransitionAbortedError,
 *   a refusal that keeps every gate, lease and freeze, when a restart without completion fails again.
 */
export async function abortTransition(deps: StepDeps, record: TransitionRecord): Promise<TransitionProgress> {
  const { ctx } = deps;
  const holderId = record.transitionId;
  if (record.lastStep >= 7) throw new Error(`Transition ${holderId} activated ${record.to}; it can no longer abort`);
  const progress = copyProgress(record.progress);
  const run = { ctx, progress, holderId, persist: () => deps.persist(progress) };
  const { plan } = record;
  ctx.logger.warn(`Transition ${holderId} to ${record.to} aborting`);
  if (plan !== undefined && (await ctx.gateway.status()).tableVersion === plan.to) {
    throw new Error(`Transition ${holderId} cannot abort: ${plan.to} is already active`);
  }
  // A kept guard freeze is recovered, and a transition moving content that reached its final state is guarded even without
  // one; while rows still match the start-up predicate this throws, and nothing below reopens legacy traffic.
  if (plan !== undefined && (progress.startupGuardFreeze !== undefined || (plan.contentToTarget && record.lastStep >= 5))) {
    await guardStartup({ ...run, deps, plan });
  }
  const restart = progress.orphanRestart;
  if (plan !== undefined && restart?.restartedAt !== undefined) {
    // Legacy may have run its start-up under these closed gates, so what it wrote is imported before any of them reopens,
    // once a completed restart shows that no earlier legacy request can still commit; a failed one refuses the abort.
    const restartRun = { ...run, deps, plan };
    const evidenced = restart.completedAt === undefined ? (await restartUnderHolder(restartRun, restart, { units: restart.units })).restart : restart;
    await importRestartedContent(restartRun, evidenced);
  }
  await resetGates(run);
  if (restart !== undefined) {
    delete progress.orphanRestart;
    await run.persist();
  }
  if (plan !== undefined) await unfreezeRoutes(run, plan);
  await resumeQueues(run);
  // Only tasks a transition paused are resumed, so this is safe even when the pause's answer was lost.
  if (plan !== undefined) {
    await deps.scheduler.resumePaused();
    delete progress.schedulerPause;
    await run.persist();
  }
  await releaseLeases(ctx, holderId);
  progress.extraLeasedUnits = [];
  await run.persist();
  return progress;
}

/**
 * Creates the start-up guard of a transition: while the transition holds the unit `tcontent` feeds, a reload with every
 * other legacy-bound entry frozen converts the rows. It opens no reload window, whose lease would wait on the
 * transition's own leases.
 */
export function createTransitionStartupGuard(
  ctx: Pick<MigrationContext, 'env' | 'config' | 'gateway' | 'legacy' | 'logger'>,
): TransitionStartupGuard {
  const countLive = async (): Promise<number> => countStartupRows(await ctx.legacy.live());
  // A drive that lost its claim sends no reload; the freeze it recorded stays for the claim's next holder.
  const reload = async (): Promise<{ status: number }> => {
    assertClaim();
    return sendReloadRequest(ctx);
  };
  return {
    async ensureEmpty({ holderId, exceptRoutes, onFrozen }) {
      const initialCount = await countLive();
      if (initialCount === 0) return { initialCount, reloaded: false, finalCount: 0 };
      ctx.logger.info(`Transition ${holderId}: ${String(initialCount)} rows match Masa's start-up predicate; reloading legacy`);
      return withGuardLock(async () => {
        // Recorded before it exists, the freeze is never left unrecorded; legacy already holds the rows, so nothing is
        // committed, and the freeze is lifted only once no row matches.
        const frozen = await freezeLegacyBound(ctx, { exceptRoutes, beforeFreeze: onFrozen });
        await recoverStartupGuard({
          runReloadWindow: reload,
          remainingStartupRows: countLive,
          unfreeze: () => unfreezeLegacyBound(ctx, frozen),
        });
        return { initialCount, reloaded: true, finalCount: 0 };
      });
    },
    async recover({ holderId, frozen }) {
      return withGuardLock(async () => {
        const initialCount = await countLive();
        ctx.logger.info(`Transition ${holderId}: ${String(initialCount)} start-up predicate rows under the kept freeze; reloading legacy`);
        await recoverStartupGuard({
          runReloadWindow: reload,
          remainingStartupRows: countLive,
          unfreeze: () => unfreezeLegacyBound(ctx, frozen),
        });
        return { initialCount, reloaded: true, finalCount: 0 };
      });
    },
  };
}

