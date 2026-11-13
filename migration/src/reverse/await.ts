/** Read-after-write barrier: waits until the projector's SQL Server checkpoints have passed target write positions. */
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { formatWritePosition, isApplied, mergeWritePosition, type WritePositions } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { CurrentAuthority } from '../cutover/index.js';
import type { LegacyDb } from '../legacy/index.js';
import { OwnerCallError, type DataOwner, type OwnersClient, type UnitCatalog } from '../owners/index.js';

import { readCheckpoints, readyHorizonOf, type CheckpointRow } from './apply-legacy.js';

/** Write positions to await, and owners whose current write positions are read first and then awaited. */
export interface AwaitProjectionRequest {
  /** Owner -> committed transaction's xid as a decimal string. */
  positions?: WritePositions;
  owners?: readonly string[];
  /** Budget counted from the call's start; defaults to the configured projection await timeout. */
  timeoutMs?: number;
}

/** The awaited positions, those read for `owners` included, and the time the call took. */
export interface AwaitProjectionResult {
  positions: WritePositions;
  waitedMs: number;
}

/** A position not yet applied, with the tenants whose checkpoint holds it back; none before the first poll. */
export interface PendingPosition {
  owner: string;
  xid: string;
  tenantsBehind: string[];
}

/** The positions were not applied in legacy within the budget; renders as the legacy 503. */
export class ProjectionTimeoutError extends LegacyServiceUnavailableError {
  override readonly name: string = 'ProjectionTimeoutError';

  constructor(
    readonly pending: PendingPosition[],
    readonly timeoutMs: number,
  ) {
    const awaited = formatWritePosition(new Map(pending.map(({ owner, xid }) => [owner, xid])));
    super(`Projection of ${awaited} was not applied in legacy within ${String(timeoutMs)} ms`, 'auto', 'projection-timeout');
  }
}

/** Cancellation and remaining time of one read the call's budget bounds. */
export interface ReadBudget {
  /** Aborts when the budget passes. */
  signal: AbortSignal;
  /** Whole milliseconds left, at least 1. */
  timeoutMs: number;
}

/** Ports and budget of {@link createAwaiter}. */
export interface AwaiterDeps {
  legacy: Pick<LegacyDb, 'live'>;
  owners: Pick<OwnersClient, 'position'>;
  /** Write authority under the active cut-over version; read once per call, within `budget`. */
  authority: (budget: ReadBudget) => Promise<CurrentAuthority>;
  catalog: Pick<UnitCatalog, 'ownerOf'>;
  /** Tenants the projector streams; read on every poll, within `budget`. */
  tenants: (budget: ReadBudget) => Promise<readonly string[]>;
  clock: MigrationContext['clock'];
  /** Replaces the timer, for example in tests. */
  sleep?: (ms: number) => Promise<void>;
  defaults: { timeoutMs: number; pollIntervalMs: number };
}

/** Waits for the reverse projection of target write positions. */
export interface Awaiter {
  /**
   * Resolves once every position is applied in legacy.
   * @throws ProjectionTimeoutError when the budget passes first; ServiceUnavailableError when an owner whose position is read is unavailable.
   */
  awaitProjection(req: AwaitProjectionRequest): Promise<AwaitProjectionResult>;
}

/** Owner answers that mean the owner is unavailable. */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

function checkpointKey(owner: string, tenantId: string): string {
  return `${owner}\u0000${tenantId.toLowerCase()}`;
}

/** Owners holding a `target`-authoritative unit: only their writes reach legacy through the projector. */
function projectedOwners(authority: CurrentAuthority, catalog: Pick<UnitCatalog, 'ownerOf'>): Set<string> {
  return new Set([...authority.targetUnits].map((unit) => catalog.ownerOf(unit)));
}

/**
 * A position is applied once every streamed tenant's checkpoint of its owner has a ready horizon above it, a missing one
 * being behind, and no other checkpoint of the owner, such as a deleted site's, owes effects not ready above it.
 */
function pendingPositions(positions: WritePositions, tenants: readonly string[], checkpoints: readonly CheckpointRow[]): PendingPosition[] {
  const horizons = new Map(checkpoints.map((row) => [checkpointKey(row.owner, row.tenantId), readyHorizonOf(row)]));
  const tenantIds = [...new Set(tenants.map((tenant) => tenant.toLowerCase()))];
  const pending: PendingPosition[] = [];
  for (const [owner, xid] of positions) {
    const notReady = (horizon: string | null | undefined): boolean => horizon === undefined || horizon === null || !isApplied(xid, horizon);
    const tenantsBehind = new Set(tenantIds.filter((tenant) => notReady(horizons.get(checkpointKey(owner, tenant)))));
    for (const row of checkpoints) {
      if (row.owner === owner && row.pendingEffects.length > 0 && notReady(readyHorizonOf(row))) tenantsBehind.add(row.tenantId.toLowerCase());
    }
    if (tenantsBehind.size > 0) pending.push({ owner, xid, tenantsBehind: [...tenantsBehind] });
  }
  return pending;
}

/** Positions whose tenants have not been read yet. */
function unread(positions: WritePositions): PendingPosition[] {
  return [...positions].map(([owner, xid]) => ({ owner, xid, tenantsBehind: [] }));
}

/** Runs `read` within the `remainingMs` left of a budget; on expiry its signal aborts, `expired()` is thrown and its late outcome is dropped. */
async function withinBudget<T>(remainingMs: number, read: (budget: ReadBudget) => Promise<T>, expired: () => Error): Promise<T> {
  if (remainingMs < 0) throw expired();
  const controller = new AbortController();
  const work = read({ signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(remainingMs)) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(expired());
    }, remainingMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    void work.catch(() => undefined);
  }
}

/** Creates the awaiter; it polls `opt2_sync.projector_checkpoint`, committed with the projected rows, at the configured interval. */
export function createAwaiter(deps: AwaiterDeps): Awaiter {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));

  /** The owner's current position; an owner answering 502, 503 or 504 is a ServiceUnavailableError. */
  async function currentPosition(owner: DataOwner, timeoutMs: number): Promise<string> {
    try {
      return (await deps.owners.position(owner, {}, { timeoutMs })).position;
    } catch (error) {
      if (error instanceof OwnerCallError && UNAVAILABLE_STATUSES.has(error.status)) throw new ServiceUnavailableError(owner, error);
      throw error;
    }
  }

  /** `req.positions` merged with each requested owner's current position, keeping the higher xid per owner. */
  async function resolvePositions(req: AwaitProjectionRequest, { timeoutMs }: ReadBudget): Promise<WritePositions> {
    const current = await Promise.all(
      // Request owners are contract `OwnerName` values, each of them a data owner.
      (req.owners ?? []).map(async (owner): Promise<[string, string]> => [owner, await currentPosition(owner as DataOwner, timeoutMs)]),
    );
    return mergeWritePosition(req.positions, new Map(current));
  }

  async function readPending(positions: WritePositions, budget: ReadBudget): Promise<PendingPosition[]> {
    const [tenants, checkpoints] = await Promise.all([
      deps.tenants(budget),
      deps.legacy.live().then((pool) => readCheckpoints(pool, { owners: [...positions.keys()] }, { signal: budget.signal })),
    ]);
    return pendingPositions(positions, tenants, checkpoints);
  }

  return {
    async awaitProjection(req) {
      const timeoutMs = req.timeoutMs ?? deps.defaults.timeoutMs;
      const startedAt = deps.clock.now().getTime();
      const elapsed = (): number => deps.clock.now().getTime() - startedAt;
      // Reported if the budget passes: the positions known so far, then what the last poll found behind.
      let pending = unread(req.positions ?? new Map<string, string>());
      const timedOut = (): ProjectionTimeoutError => new ProjectionTimeoutError(pending, timeoutMs);
      const within = <T>(read: (budget: ReadBudget) => Promise<T>): Promise<T> => withinBudget(timeoutMs - elapsed(), read, timedOut);

      const positions = await within((budget) => resolvePositions(req, budget));
      pending = unread(positions);
      const projected = positions.size === 0 ? new Set<string>() : projectedOwners(await within((budget) => deps.authority(budget)), deps.catalog);
      // Gates reject target writes on `legacy` units and window imports are never projected, so other owners have nothing to await.
      const awaited: WritePositions = new Map([...positions].filter(([owner]) => projected.has(owner)));
      if (awaited.size > 0) pending = unread(awaited);
      for (;;) {
        const behind = awaited.size === 0 ? [] : await within((budget) => readPending(awaited, budget));
        if (behind.length > 0) pending = behind;
        if (elapsed() > timeoutMs) throw timedOut();
        if (behind.length === 0) return { positions, waitedMs: elapsed() };
        const remainingMs = timeoutMs - elapsed();
        if (remainingMs <= 0) throw timedOut();
        await sleep(Math.min(deps.defaults.pollIntervalMs, remainingMs));
      }
    },
  };
}
