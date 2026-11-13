// Reload windows, and the gateway freeze and lock of the start-up guard sequence.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { serializeError } from '@opt2/platform/logging';
import { createSignalBoundFetch, currentRequestContext } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import { entriesTouching, legacyBoundEntries, loadVersion, type CutoverVersion, type WaitBudget } from '../cutover/index.js';
import { countStartupRows } from '../legacy/index.js';
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
export type GuardRunnerContext = Pick<MigrationContext, 'gateway' | 'config' | 'legacy' | 'logger'>;

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
}

/** Commits through the start-up guard sequence, serialised with every other guard sequence of the process. */
export interface StartupGuardCommitRunner {
  /**
   * Resolves once `commit` has committed with every legacy-bound entry frozen. The reload windows and the unfreeze run
   * on without the caller, whose progress the windows' projection wait may need, and repeat until no row matches.
   * A commit made while any runner on the same gateway client holds the freeze joins it. Without `scope` the caller has
   * found matching rows and holds no legacy transaction, so the run joins the held freeze or waits for the guard lock.
   * With `scope`, the caller's open transaction, rows are counted through it and zero commits directly.
   * @throws StartupGuardBusyError when `scope` has matching rows while another guard sequence or joined commit runs.
   * @throws the freeze or commit failure, after unfreezing what the run froze.
   */
  run(commit: () => Promise<void>, scope?: LegacyScope): Promise<StartupGuardRunOutcome>;
  /** Resolves once no runner on this runner's gateway client holds a freeze. */
  settled(): Promise<void>;
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

/** Runs holders one at a time in call order; `busy` while one runs or waits. */
interface Lock {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly busy: boolean;
}

const settled = (): void => undefined;

function createLock(): Lock {
  let tail: Promise<void> = Promise.resolve();
  let occupancy = 0;
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      occupancy += 1;
      const result = tail.then(fn).finally(() => {
        occupancy -= 1;
      });
      tail = result.then(settled, settled);
      return result;
    },
    get busy() {
      return occupancy > 0;
    },
  };
}

// One guard sequence at a time per process: a second one's unfreeze would lift the first one's freeze.
const guardLock = createLock();

/** Runs `fn` once every earlier holder of the guard lock has settled. */
export function withGuardLock<T>(fn: () => Promise<T>): Promise<T> {
  return guardLock.run(fn);
}

/** Runs `fn` under the guard lock, or returns `{ran: false}` at once while the lock is held or awaited. */
export async function tryGuardLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (guardLock.busy) return { ran: false };
  return { ran: true, value: await guardLock.run(fn) };
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

/** The freeze of a gateway's guard runners, held from a guarded commit until no row matches the start-up predicate. */
interface HeldFreeze {
  frozen: FrozenRoutes;
  /** False from the first unfreeze attempt, which may lift the freeze in part; later commits then freeze again. */
  joinable: boolean;
}

/** Guard state every runner on one gateway client shares. */
interface GuardSession {
  /** Serialises commits joining the held freeze with its final count and unfreeze; always taken after the guard lock. */
  lock: Lock;
  held: HeldFreeze | undefined;
  /** Reload loop of the held freeze, run by the runner whose commit created it. */
  lifting: Promise<void> | undefined;
}

const guardSessions = new WeakMap<GuardRunnerContext['gateway'], GuardSession>();

/** The guard session of `gateway`, created on first use. */
function guardSessionOf(gateway: GuardRunnerContext['gateway']): GuardSession {
  let shared = guardSessions.get(gateway);
  if (shared === undefined) {
    shared = { lock: createLock(), held: undefined, lifting: undefined };
    guardSessions.set(gateway, shared);
  }
  return shared;
}

/** Freezes every legacy-bound entry and runs `commit`; a failure unfreezes what this call froze and is rethrown. */
async function freezeAndCommit(ctx: FreezeContext, commit: () => Promise<void>): Promise<FrozenRoutes> {
  const frozen = await freezeLegacyBound(ctx);
  try {
    await commit();
  } catch (error) {
    try {
      await unfreezeLegacyBound(ctx, frozen);
    } catch (unfreezeError) {
      throw new AggregateError([error, unfreezeError], 'Start-up guard step failed and unfreezing legacy-bound entries failed');
    }
    throw error;
  }
  return frozen;
}

/**
 * Creates the guard runner the projector, transitions and faults commit through; `reload` runs one reload window.
 * Runners on one gateway client share one freeze and count one legacy database; commits made while it is held join it.
 * Reload windows repeat every `windows.importRetryMs` until the live database has no matching row, then the freeze is
 * lifted.
 * @param opts.sleep replaces the retry timer, for example in tests.
 */
export function createStartupGuardRunner(
  ctx: GuardRunnerContext,
  reload: () => Promise<ReloadWindowResult>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): StartupGuardCommitRunner {
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const shared = guardSessionOf(ctx.gateway);
  const session = shared.lock;

  /** Commits under the held freeze; false, committing nothing, when none is held. */
  const joinHeld = (commit: () => Promise<void>): Promise<boolean> =>
    session.run(async () => {
      if (shared.held?.joinable !== true) return false;
      await commit();
      return true;
    });

  /** Unfreezes once the live database has no matching row; false, keeping the freeze, otherwise. */
  async function unfreezeWhenClear(current: HeldFreeze): Promise<boolean> {
    const count = await countStartupRows(await ctx.legacy.live());
    if (count > 0) {
      ctx.logger.warn(`${String(count)} rows still match the start-up predicate after a reload window; legacy-bound entries stay frozen`);
      return false;
    }
    current.joinable = false;
    await unfreezeLegacyBound(ctx, current.frozen);
    shared.held = undefined;
    return true;
  }

  /** Runs reload windows until the freeze is lifted, retrying after any failure. */
  async function lift(current: HeldFreeze): Promise<void> {
    for (;;) {
      try {
        await reload();
        // Under the guard lock, so no other guard sequence commits between the count and the unfreeze.
        if (await withGuardLock(() => session.run(() => unfreezeWhenClear(current)))) return;
      } catch (error) {
        ctx.logger.warn({ error: serializeError(error) }, 'Start-up guard reload window or unfreeze failed; legacy-bound entries stay frozen');
      }
      await sleep(ctx.config.windows.importRetryMs);
    }
  }

  /** Holds `frozen` until lifted, merged into a freeze still held after a failed unfreeze. */
  function hold(frozen: FrozenRoutes): void {
    const { held } = shared;
    if (held !== undefined) {
      held.frozen = { routes: [...new Set([...held.frozen.routes, ...frozen.routes])].sort(), epoch: frozen.epoch };
      held.joinable = true;
      return;
    }
    const current: HeldFreeze = { frozen, joinable: true };
    shared.held = current;
    const loop: Promise<void> = lift(current).finally(() => {
      if (shared.lifting === loop) shared.lifting = undefined;
    });
    shared.lifting = loop;
  }

  return {
    async run(commit, scope) {
      if (scope === undefined) {
        if (!(await joinHeld(commit))) {
          await withGuardLock(async () => {
            if (!(await joinHeld(commit))) hold(await freezeAndCommit(ctx, commit));
          });
        }
        return { guarded: true, count: null };
      }
      const count = await countStartupRows(scope);
      if (count === 0) {
        await commit();
        return { guarded: false, count };
      }
      // Waiting would keep the transaction's tcontent locks, on which a running guard's commit or count can block.
      const attempt = await tryGuardLock(async () => {
        if (shared.held?.joinable !== true) {
          hold(await freezeAndCommit(ctx, commit));
          return true;
        }
        if (session.busy) return false;
        await session.run(commit);
        return true;
      });
      if (!attempt.ran || !attempt.value) throw new StartupGuardBusyError(count);
      return { guarded: true, count };
    },
    async settled() {
      while (shared.lifting !== undefined) await shared.lifting;
    },
  };
}
