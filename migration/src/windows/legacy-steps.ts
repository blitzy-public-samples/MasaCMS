// Legacy site-monitor steps run through the bridge's `jobs.cfm`, inside a write window when they write `target`-authoritative units.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { currentRequestContext, z } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import { currentAuthority } from '../cutover/index.js';
import type { components } from '../generated/openapi.js';
import { BridgeTimeoutError, type BridgeJobName, type BridgeJobParams, type BridgeJobResult } from '../legacy/index.js';
import type { WindowKind } from '../reports/append-log.js';

type Schemas = components['schemas'];
type LegacyStepRequest = Schemas['LegacyStepRequest'];
type WindowOpenRequest = Schemas['WindowOpenRequest'];
type WindowOpenResponse = Schemas['WindowOpenResponse'];
type WindowCompleteRequest = Schemas['WindowCompleteRequest'];
type WindowCompleteResponse = Schemas['WindowCompleteResponse'];

/** `legacyStepRun`'s 200 body. */
export type LegacyStepResponse = Schemas['LegacyStepResponse'];

/** Route key of the site-monitor `job` cut-over entry; every legacy step window opens under it. */
export const LEGACY_STEP_ROUTE_KEY = 'sitemonitor:run';

/** Kind every legacy step window is recorded with. */
export const LEGACY_STEP_WINDOW_KIND = 'sitemonitor-step' satisfies WindowKind;

/** The write-window operations a legacy step uses; the window service passes its own. */
export interface WindowLifecycle {
  open(request: WindowOpenRequest, opts: { kind: WindowKind }): Promise<WindowOpenResponse>;
  complete(windowId: string, request: WindowCompleteRequest): Promise<WindowCompleteResponse>;
}

/** One legacy step: the `legacyStepRun` body. */
export interface LegacyStepInput extends Pick<LegacyStepRequest, 'step' | 'theTime' | 'lastMonitored' | 'siteId'> {
  /** Time by which the step must answer; it bounds the bridge call, which otherwise takes the bridge's own bound. */
  readonly deadlineAt?: LegacyStepRequest['deadlineAt'];
  /** Write set in the inventory's unit form (`<schema>.<table>`, `legacy:<table>`, `file-store`); the inventory's write set of `step` when absent. */
  readonly units?: readonly string[];
}

/** The `legacyStepRun` body, and the state the step's window ended in when it ran in one; the body admits no window state. */
export interface LegacyStepResult {
  response: LegacyStepResponse;
  windowState?: WindowCompleteResponse['state'];
}

/** The context part a legacy step needs. */
export type LegacyStepContext = Pick<MigrationContext, 'bridge' | 'gateway' | 'config' | 'catalog' | 'logger' | 'clock'>;

/**
 * The bridge step did not complete; renders as `legacyStepRun`'s legacy 503, with the bridge failure as `cause`.
 * `windowId` names the window it ran in, which was still completed.
 */
export class LegacyStepFailedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'LegacyStepFailedError';

  constructor(
    readonly step: BridgeJobName,
    readonly siteId: string | undefined,
    readonly windowId: string | undefined,
    override readonly cause: unknown,
  ) {
    super(`Legacy site-monitor step ${step}${siteId === undefined ? '' : ` for site ${siteId}`} did not complete`, 'auto', 'legacy-step-failed');
  }
}

/**
 * `deadlineAt` passed, or the bridge's bound expired, before the step answered; renders as `legacyStepRun`'s 504, and as
 * the 503 wherever only the base class is mapped. After a bridge timeout `windowId`'s window is left executing, since
 * legacy may still be running the step.
 */
export class LegacyStepDeadlineError extends LegacyStepFailedError {
  override readonly name: string = 'LegacyStepDeadlineError';
  override readonly reason: string = 'legacy-step-deadline';

  constructor(step: BridgeJobName, siteId: string | undefined, windowId: string | undefined, cause: unknown) {
    super(step, siteId, windowId, cause);
    this.message = `Legacy site-monitor step ${step}${siteId === undefined ? '' : ` for site ${siteId}`} did not complete before its deadline`;
  }
}

// Inventory unit forms with no unit id of their own: a decision-list table never moves, and the file store holds the
// bytes of tfiles rows (fileDAO.cfc:153-209), so it moves with the tfiles units.
const DECISION_TABLE_PREFIX = 'legacy:';
const FILE_STORE = 'file-store';
const FILE_STORE_TABLE = 'tfiles';

/** Label of each job's step in the inventory's `scheduledJobs[].steps[].step`; `setCursor` sets only `application.lastMonitored`. */
const INVENTORY_STEPS: Readonly<Record<BridgeJobName, string | null>> = {
  sendReminders: 'reminders',
  emailSend: 'email-send',
  publishScheduledChangesets: 'changeset-publish',
  trackBounces: 'bounces',
  feedAutoImport: 'feed-import',
  purgeDisplayWindow: 'cache-purge',
  clearOldCommands: 'cluster-cleanup',
  onGlobalMonitor: 'plugin-events',
  onSiteMonitor: 'plugin-events',
  setCursor: null,
};

const inventorySchema = z.object({
  scheduledJobs: z.array(
    z.object({
      routeKey: z.string(),
      steps: z.array(z.object({ step: z.string(), writeSet: z.array(z.object({ unit: z.string().min(1) })) })),
    }),
  ),
});

const writeSetsByInventory = new Map<string, ReadonlyMap<string, readonly string[]>>();

/** Write set of each site-monitor step label of the inventory at `file`, read once per file. */
function inventoryWriteSets(file: string): ReadonlyMap<string, readonly string[]> {
  const cached = writeSetsByInventory.get(file);
  if (cached !== undefined) return cached;
  const inventory = inventorySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const job = inventory.scheduledJobs.find((entry) => entry.routeKey === LEGACY_STEP_ROUTE_KEY);
  if (job === undefined) throw new Error(`${file} records no ${LEGACY_STEP_ROUTE_KEY} scheduled job`);
  const writeSets = new Map(job.steps.map((entry) => [entry.step, entry.writeSet.map((write) => write.unit)] as const));
  writeSetsByInventory.set(file, writeSets);
  return writeSets;
}

/** Sorted migration unit ids of a write set in the inventory's unit form. */
function migrationUnits(catalog: LegacyStepContext['catalog'], units: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const unit of units) {
    if (unit.startsWith(DECISION_TABLE_PREFIX)) continue;
    if (unit !== FILE_STORE) ids.add(unit);
    else for (const target of catalog.unitsForLegacyTable(FILE_STORE_TABLE)) ids.add(target.unit);
  }
  return [...ids].sort();
}

/**
 * Sorted migration unit ids the step writes, from the inventory's write set of the step.
 * @throws Error when the inventory records no site-monitor job or no such step.
 */
export function legacyStepUnits(ctx: Pick<LegacyStepContext, 'config' | 'catalog'>, step: BridgeJobName): string[] {
  const label = INVENTORY_STEPS[step];
  if (label === null) return [];
  const file = ctx.config.paths.inventory;
  const writeSet = inventoryWriteSets(file).get(label);
  if (writeSet === undefined) throw new Error(`${file} records no site-monitor step ${label} for job ${step}`);
  return migrationUnits(ctx.catalog, writeSet);
}

/** Query values of the bridge call: the orchestrator's cursor, or for `setCursor` the run time, which jobs.cfm reads from `value`. */
function bridgeParams(input: LegacyStepInput): BridgeJobParams {
  if (input.step === 'setCursor') return { value: input.theTime };
  return { siteId: input.siteId, theTime: input.theTime, lastMonitored: input.lastMonitored };
}

/** The `legacyStepRun` body of a step the bridge ran; its wire time is legacy wall-clock time in the process zone. */
function stepResponse(step: BridgeJobName, result: BridgeJobResult, windowId?: string): LegacyStepResponse {
  return {
    step,
    // jobsRun resolves only on the bridge's 2xx, which jobs.cfm sends once the step's manager method returned.
    completed: true,
    // The contract's date-time carries an offset; the bridge's wire time has none.
    serverTime: new Date(result.serverTime).toISOString(),
    ...(result.siteId === undefined ? {} : { siteId: result.siteId }),
    ...(windowId === undefined ? {} : { windowId }),
  };
}

/** Milliseconds left before the step's `deadlineAt`, read afresh on each call; undefined without one. */
function timeLeft(ctx: Pick<LegacyStepContext, 'clock'>, input: LegacyStepInput): number | undefined {
  return input.deadlineAt === undefined ? undefined : Date.parse(input.deadlineAt) - ctx.clock.now().getTime();
}

/** True once a step's `deadlineAt` has passed. */
function deadlinePassed(left: number | undefined): boolean {
  return left !== undefined && left <= 0;
}

/** Runs the bridge step within `timeoutMs`; a bridge timeout becomes {@link LegacyStepDeadlineError}, any other rejection {@link LegacyStepFailedError}. */
async function runBridgeStep(
  ctx: LegacyStepContext,
  input: LegacyStepInput,
  timeoutMs: number | undefined,
  windowId?: string,
): Promise<{ ok: true; result: BridgeJobResult } | { ok: false; error: LegacyStepFailedError }> {
  try {
    const params = bridgeParams(input);
    const result = await (timeoutMs === undefined
      ? ctx.bridge.jobsRun(input.step, params)
      : ctx.bridge.jobsRun(input.step, params, { timeoutMs }));
    return { ok: true, result };
  } catch (error) {
    const failure =
      error instanceof BridgeTimeoutError
        ? new LegacyStepDeadlineError(input.step, input.siteId, windowId, error)
        : new LegacyStepFailedError(input.step, input.siteId, windowId, error);
    return { ok: false, error: failure };
  }
}

/**
 * Runs one site-monitor step on legacy through `jobs.cfm` before its `deadlineAt`, inside a `sitemonitor-step` write
 * window when its write set includes a `target`-authoritative unit. The window is completed with `forwarded: true` even
 * when the bridge call fails, with `forwarded: false` when the deadline passed while it opened, and not at all after a
 * bridge timeout, since legacy may still be running the step.
 * @throws the lifecycle's open refusal unchanged, before legacy runs anything; LegacyStepDeadlineError when the deadline
 *   passed or the bridge timed out; LegacyStepFailedError when the step did not complete.
 */
export async function runLegacyStepWith(
  ctx: LegacyStepContext,
  lifecycle: WindowLifecycle,
  input: LegacyStepInput,
): Promise<LegacyStepResult> {
  const { step, siteId } = input;
  if (deadlinePassed(timeLeft(ctx, input))) throw new LegacyStepDeadlineError(step, siteId, undefined, undefined);
  // The legacyStepRun body carries no units, so the step's write set comes from the inventory unless a caller passes one.
  const units = input.units === undefined ? legacyStepUnits(ctx, step) : migrationUnits(ctx.catalog, input.units);
  // A step with no migration unit can never need a window, so it reads no authority.
  const authority = units.length === 0 ? undefined : await currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths });

  if (authority === undefined || !units.some((unit) => authority.isTargetAuthoritative(unit))) {
    const left = timeLeft(ctx, input);
    if (deadlinePassed(left)) throw new LegacyStepDeadlineError(step, siteId, undefined, undefined);
    const run = await runBridgeStep(ctx, input, left);
    if (!run.ok) throw run.error;
    return { response: stepResponse(step, run.result) };
  }

  const requestId = currentRequestContext()?.requestId ?? randomUUID();
  const { windowId } = await lifecycle.open(
    {
      routeKey: LEGACY_STEP_ROUTE_KEY,
      units,
      scope: siteId === undefined ? { table: true } : { keys: { siteid: siteId } },
      requestId,
    },
    { kind: LEGACY_STEP_WINDOW_KIND },
  );
  const stepLabel = siteId === undefined ? step : `${step} for site ${siteId}`;
  const left = timeLeft(ctx, input);
  if (deadlinePassed(left)) {
    // Legacy has run nothing, so the window closes without an import.
    await lifecycle.complete(windowId, { forwarded: false });
    throw new LegacyStepDeadlineError(step, siteId, windowId, undefined);
  }
  const run = await runBridgeStep(ctx, input, left, windowId);
  if (!run.ok && run.error.cause instanceof BridgeTimeoutError) {
    ctx.logger.warn({ requestId }, `Legacy step ${stepLabel} did not answer within ${String(run.error.cause.timeoutMs)} ms; window ${windowId} is left executing`);
    throw run.error;
  }
  // Legacy may have committed even when the bridge call failed, so the window always imports.
  let completed: WindowCompleteResponse;
  try {
    completed = await lifecycle.complete(windowId, { forwarded: true });
  } catch (error) {
    if (run.ok) throw error;
    throw new AggregateError([run.error, error], `Legacy step ${step} failed and completing window ${windowId} failed`);
  }

  // The window record has no field for the step, so this line links the two.
  if (completed.state === 'closed') ctx.logger.info({ requestId }, `Legacy step ${stepLabel} ran in window ${windowId}, closed`);
  else ctx.logger.warn({ requestId }, `Legacy step ${stepLabel} left window ${windowId} ${completed.state}`);

  if (!run.ok) throw run.error;
  return { response: stepResponse(step, run.result, windowId), windowState: completed.state };
}
