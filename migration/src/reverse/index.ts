/** Reverse projection: the projector factory and the public surface of its loop, barrier and checkpoints. */
import type { MigrationContext } from '../context.js';
import { currentAuthority } from '../cutover/index.js';

import { createAwaiter, type AwaitProjectionRequest, type AwaitProjectionResult } from './await.js';
import { createProjectorLoop, liveTenantSites, type CycleResult, type ProjectorHooks, type StartupGuardRunner } from './projector.js';

export { PROJECTOR_LOCK_KEY } from './projector.js';
export type { ProjectorHooks, OperationChangePoint, StartupGuardRunner, CycleResult } from './projector.js';
export { ProjectionTimeoutError } from './await.js';
export type { AwaitProjectionRequest, AwaitProjectionResult, PendingPosition, ReadBudget } from './await.js';
export { CHECKPOINT_TABLE, readCheckpoints, ProjectionConflictError } from './apply-legacy.js';
export type { CheckpointRow, LegacyEffect } from './apply-legacy.js';

/** The reverse projector loop together with the read-after-write barrier over its checkpoints. */
export interface Projector {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<CycleResult>;
  awaitProjection(req: AwaitProjectionRequest): Promise<AwaitProjectionResult>;
}

/** Creates the projector loop and its awaiter; the awaiter reads the loop's tenant set, or the live `tsettings` before the first cycle. */
export function createProjector(ctx: MigrationContext, opts: { hooks?: ProjectorHooks; startupGuard: StartupGuardRunner }): Projector {
  const loop = createProjectorLoop(ctx, { hooks: opts.hooks ?? {}, startupGuard: opts.startupGuard });
  const awaiter = createAwaiter({
    legacy: ctx.legacy,
    owners: ctx.owners,
    catalog: ctx.catalog,
    authority: ({ timeoutMs }) => currentAuthority({ gateway: ctx.gateway, config: ctx.config.paths, timeoutMs }),
    tenants: async ({ signal }) => loop.lastTenants() ?? [...(await liveTenantSites(ctx.legacy, { signal })).keys()],
    clock: ctx.clock,
    defaults: { timeoutMs: ctx.config.projection.defaultAwaitTimeoutMs, pollIntervalMs: ctx.config.projection.idlePollMs },
  });
  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    runOnce: () => loop.runOnce(),
    awaitProjection: (req) => awaiter.awaitProjection(req),
  };
}
