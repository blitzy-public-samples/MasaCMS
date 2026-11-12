/** Read-after-write barrier: waits until the projector's SQL Server checkpoints have passed target write positions. */
import { setTimeout as delay } from 'node:timers/promises';

import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { formatWritePosition, isApplied, mergeWritePosition, type WritePositions } from '@opt2/platform/migration-kit';

import type { MigrationContext } from '../context.js';
import type { CurrentAuthority } from '../cutover/index.js';
import type { LegacyDb } from '../legacy/index.js';
import type { DataOwner, OwnersClient, UnitCatalog } from '../owners/index.js';

import { readCheckpoints, type CheckpointRow } from './apply-legacy.js';

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

/** A position not yet applied, with the tenants whose checkpoint is missing or at or below it. */
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

/** Ports and budget of {@link createAwaiter}. */
export interface AwaiterDeps {
  legacy: Pick<LegacyDb, 'live'>;
  owners: Pick<OwnersClient, 'position'>;
  /** Write authority under the active cut-over version; read once per call. */
  authority: () => Promise<CurrentAuthority>;
  catalog: Pick<UnitCatalog, 'ownerOf'>;
  /** Tenants the projector streams; read on every poll. */
  tenants: () => Promise<readonly string[]>;
  clock: MigrationContext['clock'];
  /** Replaces the timer, for example in tests. */
  sleep?: (ms: number) => Promise<void>;
  defaults: { timeoutMs: number; pollIntervalMs: number };
}

/** Waits for the reverse projection of target write positions. */
export interface Awaiter {
  /** Resolves once every position is applied in legacy. @throws ProjectionTimeoutError when the budget passes first. */
  awaitProjection(req: AwaitProjectionRequest): Promise<AwaitProjectionResult>;
}

function checkpointKey(owner: string, tenantId: string): string {
  return `${owner}\u0000${tenantId.toLowerCase()}`;
}

/** Owners holding a `target`-authoritative unit: only their writes reach legacy through the projector. */
function projectedOwners(authority: CurrentAuthority, catalog: Pick<UnitCatalog, 'ownerOf'>): Set<string> {
  return new Set([...authority.targetUnits].map((unit) => catalog.ownerOf(unit)));
}

/** A position is applied once every tenant's checkpoint of its owner has an applied horizon above it; a missing checkpoint is behind. */
function pendingPositions(positions: WritePositions, tenants: readonly string[], checkpoints: readonly CheckpointRow[]): PendingPosition[] {
  const horizons = new Map(checkpoints.map((row) => [checkpointKey(row.owner, row.tenantId), row.appliedHorizon]));
  const tenantIds = [...new Set(tenants.map((tenant) => tenant.toLowerCase()))];
  const pending: PendingPosition[] = [];
  for (const [owner, xid] of positions) {
    const tenantsBehind = tenantIds.filter((tenant) => {
      const horizon = horizons.get(checkpointKey(owner, tenant));
      return horizon === undefined || !isApplied(xid, horizon);
    });
    if (tenantsBehind.length > 0) pending.push({ owner, xid, tenantsBehind });
  }
  return pending;
}

/** Creates the awaiter; it polls `opt2_sync.projector_checkpoint`, committed with the projected rows, at the configured interval. */
export function createAwaiter(deps: AwaiterDeps): Awaiter {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));

  /** `req.positions` merged with each requested owner's current position, keeping the higher xid per owner. */
  async function resolvePositions(req: AwaitProjectionRequest): Promise<WritePositions> {
    const current = await Promise.all(
      // Request owners are contract `OwnerName` values, each of them a data owner.
      (req.owners ?? []).map(async (owner): Promise<[string, string]> => [owner, (await deps.owners.position(owner as DataOwner)).position]),
    );
    return mergeWritePosition(req.positions, new Map(current));
  }

  async function readPending(positions: WritePositions): Promise<PendingPosition[]> {
    const [tenants, checkpoints] = await Promise.all([
      deps.tenants(),
      deps.legacy.live().then((pool) => readCheckpoints(pool, { owners: [...positions.keys()] })),
    ]);
    return pendingPositions(positions, tenants, checkpoints);
  }

  return {
    async awaitProjection(req) {
      const timeoutMs = req.timeoutMs ?? deps.defaults.timeoutMs;
      const startedAt = deps.clock.now().getTime();
      const elapsed = (): number => deps.clock.now().getTime() - startedAt;
      const positions = await resolvePositions(req);
      const projected = positions.size === 0 ? new Set<string>() : projectedOwners(await deps.authority(), deps.catalog);
      // Gates reject target writes on `legacy` units and window imports are never projected, so other owners have nothing to await.
      const awaited: WritePositions = new Map([...positions].filter(([owner]) => projected.has(owner)));
      for (;;) {
        const pending = awaited.size === 0 ? [] : await readPending(awaited);
        if (pending.length === 0) return { positions, waitedMs: elapsed() };
        const remainingMs = timeoutMs - elapsed();
        if (remainingMs <= 0) throw new ProjectionTimeoutError(pending, timeoutMs);
        await sleep(Math.min(deps.defaults.pollIntervalMs, remainingMs));
      }
    },
  };
}
