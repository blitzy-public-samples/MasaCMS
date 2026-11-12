// Reload windows, and the gateway freeze and lock of the start-up guard sequence.
import { randomUUID } from 'node:crypto';

import { createSignalBoundFetch, currentRequestContext } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import { entriesTouching, legacyBoundEntries, loadVersion, type CutoverVersion, type WaitBudget } from '../cutover/index.js';
import { countStartupRows, runStartupGuardSequence, type StartupGuardSteps } from '../legacy/index.js';
import type { UnitCatalog } from '../owners/index.js';
import type { WindowKind } from '../reports/append-log.js';

import type { WindowLifecycle } from './legacy-steps.js';

/** Window label of a guard reload; no cut-over entry carries it. */
export const RELOAD_ROUTE_KEY = 'startup-guard:reload';

/** Kind every reload window is recorded with. */
export const RELOAD_WINDOW_KIND = 'reload' satisfies WindowKind;

// Gateway instances refresh their cut-over state every second; the freeze waits poll at this pace within their budget.
const GATEWAY_POLL_MS = 250;
const CONTENT_UNIT_PREFIX = 'content.';

type WindowCompleteResponse = Awaited<ReturnType<WindowLifecycle['complete']>>;
/** A legacy transaction or pool the start-up predicate is counted through. */
type LegacyScope = Parameters<typeof countStartupRows>[0];

/** Context members a reload window uses. */
export type ReloadContext = Pick<MigrationContext, 'env' | 'config' | 'catalog' | 'legacy'>;
/** Context members the gateway freeze uses. */
export type FreezeContext = Pick<MigrationContext, 'gateway' | 'config'>;
/** Context members the guard runner uses. */
export type GuardRunnerContext = Pick<MigrationContext, 'gateway' | 'config' | 'legacy'>;

/** Outcome of one reload window. */
export interface ReloadWindowResult {
  windowId: string;
  /** Legacy's HTTP status of the reload request. */
  legacyStatus: number;
  windowState: WindowCompleteResponse['state'];
  /** Rows matching Masa's start-up predicate on the live database once the window completed. */
  startupRowsRemaining: number;
}

/** Routes a freeze added at the gateway, and the epoch every live instance had seen once it held. */
export interface FrozenRoutes {
  /** Legacy-bound routes this freeze froze; routes another holder had already frozen stay that holder's. */
  routes: string[];
  epoch: number;
}

/** Outcome of one guard run; `count` is the matching-row count that decided it, null when the caller decided it. */
export interface StartupGuardRunOutcome {
  guarded: boolean;
  count: number | null;
  /** The reload window's result, when the guard sequence ran. */
  reload?: ReloadWindowResult;
}

/** Commits through the start-up guard sequence, serialised with every other guard sequence of the process. */
export interface StartupGuardCommitRunner {
  /**
   * Without `scope` the caller has found matching rows and holds no legacy transaction, so the run waits for the guard
   * lock. With `scope`, the caller's open transaction, rows are counted through it and zero commits directly.
   * @throws StartupGuardBusyError when `scope` has matching rows while another guard sequence holds the lock.
   * @throws StartupGuardFrozenError after commit, with the freeze left in place, as `runStartupGuardSequence` does.
   */
  run(commit: () => Promise<void>, scope?: LegacyScope): Promise<StartupGuardRunOutcome>;
}

/** Rows match the start-up predicate in the caller's transaction while another guard sequence runs; roll back and retry. */
export class StartupGuardBusyError extends Error {
  override readonly name = 'StartupGuardBusyError';

  constructor(readonly count: number) {
    super(`${String(count)} rows would match the start-up predicate while another start-up guard sequence runs`);
  }
}

/** Masa's URL reload key: `MURA_APPRELOADKEY`, which Masa reads over its settings file, else the configured default. */
export function reloadKey(
  config: Pick<MigrationContext['config'], 'startupGuard'>,
  env: Pick<MigrationContext['env'], 'MURA_APPRELOADKEY'>,
): string {
  return env.MURA_APPRELOADKEY ?? config.startupGuard.appreloadKey;
}

/** Sorted ids of the strategies-content units, every unit a reload window leases. */
export function contentUnits(catalog: Pick<UnitCatalog, 'units'>): string[] {
  return catalog
    .units()
    .map((unit) => unit.id)
    .filter((id) => id.startsWith(CONTENT_UNIT_PREFIX))
    .sort();
}

let reloadFetch: typeof globalThis.fetch | undefined;

/**
 * Sends Masa's reload request straight to legacy, since a guard sequence holds every legacy-bound gateway entry frozen.
 * @returns legacy's status, whatever it is: legacy may have re-initialised regardless.
 * @throws the transport failure when no response arrived.
 */
export async function sendReloadRequest(ctx: Pick<MigrationContext, 'env' | 'config'>): Promise<{ status: number }> {
  // No header or body timeout, since a re-initialisation takes as long as it takes. The query carries no `method`, for
  // which Masa skips the reload (onRequestStart_include.cfm:128), and a redirect is not followed into a second reload.
  reloadFetch ??= createSignalBoundFetch();
  const url = new URL(`/?${encodeURIComponent(reloadKey(ctx.config, ctx.env))}`, ctx.env.LEGACY_ORIGIN);
  const response = await reloadFetch(url, { method: 'GET', redirect: 'manual' });
  await response.arrayBuffer();
  return { status: response.status };
}

/**
 * Runs the reload request inside a `reload` write window on every content unit, completing the window even when the
 * request failed, then counts the start-up predicate rows left on the live database. It never starts a guard sequence.
 * @throws the lifecycle's open refusal before legacy runs anything; the transport failure once the window completed.
 */
export async function runReloadWindowWith(ctx: ReloadContext, lifecycle: WindowLifecycle): Promise<ReloadWindowResult> {
  const requestId = currentRequestContext()?.requestId ?? randomUUID();
  const { windowId } = await lifecycle.open(
    { routeKey: RELOAD_ROUTE_KEY, units: contentUnits(ctx.catalog), scope: { table: true }, requestId },
    { kind: RELOAD_WINDOW_KIND },
  );
  const sent = await sendReloadRequest(ctx).then(
    (result) => ({ ok: true as const, status: result.status }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // Legacy may have re-initialised before the transport failed, so the window imports either way.
  let completed: WindowCompleteResponse;
  try {
    completed = await lifecycle.complete(windowId, sent.ok ? { forwarded: true, legacyStatus: sent.status } : { forwarded: true });
  } catch (error) {
    if (sent.ok) throw error;
    throw new AggregateError([sent.error, error], `Reload request failed and completing window ${windowId} failed`);
  }
  if (!sent.ok) throw sent.error;
  const startupRowsRemaining = await countStartupRows(await ctx.legacy.live());
  return { windowId, legacyStatus: sent.status, windowState: completed.state, startupRowsRemaining };
}

// One guard sequence at a time per process: a second one's unfreeze would lift the first one's freeze.
let guardTail: Promise<void> = Promise.resolve();
let guardOccupancy = 0;
const settled = (): void => undefined;

/** Runs `fn` once every earlier holder of the guard lock has settled. */
export function withGuardLock<T>(fn: () => Promise<T>): Promise<T> {
  guardOccupancy += 1;
  const result = guardTail.then(fn).finally(() => {
    guardOccupancy -= 1;
  });
  guardTail = result.then(settled, settled);
  return result;
}

/** Runs `fn` under the guard lock, or returns `{ran: false}` at once while the lock is held or awaited. */
export async function tryGuardLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (guardOccupancy > 0) return { ran: false };
  return { ran: true, value: await withGuardLock(fn) };
}

/** Epoch-acknowledgement and in-flight budget of a guard freeze: the configured freeze acknowledgement budget. */
function freezeBudget(ctx: Pick<MigrationContext, 'config'>): WaitBudget {
  return { timeoutMs: ctx.config.transition.freezeAckTimeoutMs, intervalMs: GATEWAY_POLL_MS };
}

/**
 * Freezes every legacy-bound entry of the active version, waits until every live gateway instance has seen the freeze,
 * then until no live instance holds an in-flight request on those entries other than `exceptRoutes`.
 * @throws GatewayWaitTimeoutError, or any gateway failure, after unfreezing what it froze.
 */
export async function freezeLegacyBound(ctx: FreezeContext, opts: { exceptRoutes?: readonly string[] } = {}): Promise<FrozenRoutes> {
  const status = await ctx.gateway.status();
  // Without an active version the gateway forwards nothing, so no legacy request can start.
  if (status.tableVersion === null) return { routes: [], epoch: status.epoch };
  const version = loadVersion(ctx.config.paths.cutoverDir, status.tableVersion);
  const legacyBound = [...new Set(legacyBoundEntries(version).map((entry) => entry.route))].sort();
  // A transition calls this with its own entries frozen; unfreezing them here would release them before its activation.
  const alreadyFrozen = new Set(status.frozen);
  const routes = legacyBound.filter((route) => !alreadyFrozen.has(route));
  const epoch = routes.length === 0 ? status.epoch : (await ctx.gateway.freeze(routes)).epoch;
  const except = new Set(opts.exceptRoutes);
  try {
    const budget = freezeBudget(ctx);
    await ctx.gateway.awaitEpoch(epoch, budget);
    await ctx.gateway.awaitInflightDrained(legacyBound.filter((route) => !except.has(route)), budget);
  } catch (error) {
    if (routes.length === 0) throw error;
    try {
      await ctx.gateway.unfreeze(routes);
    } catch (unfreezeError) {
      throw new AggregateError([error, unfreezeError], 'Start-up guard freeze wait failed and unfreezing legacy-bound entries failed');
    }
    throw error;
  }
  return { routes, epoch };
}

/** Unfreezes the routes `frozen` froze and waits until every live gateway instance has seen it. */
export async function unfreezeLegacyBound(ctx: FreezeContext, frozen: FrozenRoutes): Promise<void> {
  if (frozen.routes.length === 0) return;
  const status = await ctx.gateway.unfreeze(frozen.routes);
  await ctx.gateway.awaitEpoch(status.epoch, freezeBudget(ctx));
}

/**
 * Routes a window-joined guard leaves out of its in-flight wait: the window's own route, whose legacy request has
 * finished, and every `legacy-write` entry touching a unit the window leases, whose requests wait for those leases.
 * @param leasedTargetUnits the `target`-authoritative units the window leases.
 */
export function drainExclusions(version: CutoverVersion, ownRouteKey: string, leasedTargetUnits: Iterable<string>): string[] {
  const blocked = entriesTouching(version, leasedTargetUnits).filter((entry) => entry.kind === 'legacy-write');
  return [...new Set([ownRouteKey, ...blocked.map((entry) => entry.route)])].sort();
}

/** Steps of one guard sequence: freeze every legacy-bound entry, `commit`, `reload`, unfreeze what was frozen. */
function guardSteps(
  ctx: GuardRunnerContext,
  commit: () => Promise<void>,
  reload: () => Promise<ReloadWindowResult>,
): StartupGuardSteps<void, ReloadWindowResult> {
  let frozen: FrozenRoutes | undefined;
  let reloaded: ReloadWindowResult | undefined;
  return {
    async freezeLegacyBound() {
      frozen = await freezeLegacyBound(ctx);
    },
    commit,
    async runReloadWindow() {
      reloaded = await reload();
      return reloaded;
    },
    async remainingStartupRows() {
      return reloaded?.startupRowsRemaining ?? countStartupRows(await ctx.legacy.live());
    },
    async unfreeze() {
      if (frozen !== undefined) await unfreezeLegacyBound(ctx, frozen);
    },
  };
}

/** Creates the guard runner the projector, transitions and faults commit through; `reload` runs one reload window. */
export function createStartupGuardRunner(
  ctx: GuardRunnerContext,
  reload: () => Promise<ReloadWindowResult>,
): StartupGuardCommitRunner {
  return {
    async run(commit, scope) {
      if (scope === undefined) {
        const sequence = await withGuardLock(() => runStartupGuardSequence(guardSteps(ctx, commit, reload)));
        return { guarded: true, count: null, reload: sequence.reload };
      }
      const count = await countStartupRows(scope);
      if (count === 0) {
        await commit();
        return { guarded: false, count };
      }
      // Waiting would keep the transaction's tcontent locks, on which the running guard's commit or reload can block.
      const attempt = await tryGuardLock(() => runStartupGuardSequence(guardSteps(ctx, commit, reload)));
      if (!attempt.ran) throw new StartupGuardBusyError(count);
      return { guarded: true, count, reload: attempt.value.reload };
    },
  };
}
