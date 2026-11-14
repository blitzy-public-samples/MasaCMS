// Scripted fault mssql-dropped-mid-extract: a feed run loses its SQL Server connection while streaming snapshot rows; a rerun resumes from the owners' watermarks.
import type { ConnectionPool, Request } from 'mssql';

import { serializeError } from '@opt2/platform/logging';
import { z } from '@opt2/platform/service-kit';

import { runFeed } from '../../apply/index.js';
import { createMigrationContext } from '../../context.js';
import { createLegacyDb, type LegacyDb } from '../../legacy/index.js';
import { SNAPSHOT_DB_INFIX, latestSnapshot } from '../../snapshot/index.js';
import { fail, pass, type FaultAssertion, type FaultEnv, type FaultScript } from './types.js';

const FAULT = 'mssql-dropped-mid-extract';
const DROPPED = 'connection-dropped';
const RESUMED = 'resumed-from-watermark';
const POOLS_CLOSED = 'fault-pools-closed';
const POOLS_CLOSED_ON_RESUME = 'fault-pools-closed-on-resume';
const RERUN_FEED = 'rerun-feed';
const CLOSE_FAULT_POOLS = 'close-fault-pools';

const paramsSchema = z.object({ afterRows: z.number().int().min(1).default(500) }).strict();

/** Parameters of {@link mssqlDroppedMidExtract}: the streamed snapshot rows, over every snapshot database, after which the connection drops. */
export type MssqlDroppedParams = z.output<typeof paramsSchema>;

/** Snapshot rows the faulted feed streamed, and the snapshot database whose connection was dropped. */
interface DropStats {
  rowsSeen: number;
  dropped: boolean;
  droppedDatabase?: string;
}

/** Pools a close left open, and the first close rejection; `error` is set whenever `open` is not empty. */
interface PoolClosure {
  open: ConnectionPool[];
  error?: unknown;
}

/** The fault's legacy port, its drop counters, and the close that reports which of its pools stayed open. */
interface DroppingLegacyDb {
  legacy: LegacyDb;
  stats: DropStats;
  closePools(): Promise<PoolClosure>;
}

/** Pools of the fault's legacy port whose close failed in `run`, kept for `resume` by the env both receive. */
const unclosedPools = new WeakMap<FaultEnv, ConnectionPool[]>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Closes each of `pools` and returns those whose close rejected; never rejects. */
async function closeEach(pools: readonly ConnectionPool[]): Promise<PoolClosure> {
  const outcomes = await Promise.allSettled(pools.map(async (pool) => pool.close()));
  const open = pools.filter((_pool, index) => outcomes[index]?.status === 'rejected');
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  return rejected === undefined ? { open } : { open, error: rejected.reason };
}

/** Legacy port over its own pools whose snapshot pools drop their connection once `afterRows` rows have streamed from them in total. */
function createDroppingLegacyDb(env: FaultEnv, afterRows: number): DroppingLegacyDb {
  const base = createLegacyDb(env.ctx.env);
  const stats: DropStats = { rowsSeen: 0, dropped: false };
  const wrappers = new WeakMap<ConnectionPool, ConnectionPool>();
  // The base port caches one connect per database name, so this holds each pool it opened for this port.
  const opened = new Set<Promise<ConnectionPool>>();
  const track = (connecting: Promise<ConnectionPool>): Promise<ConnectionPool> => {
    opened.add(connecting);
    return connecting;
  };

  /** Closes every pool opened so far; one whose close rejected stays tracked for the next close. */
  const closePools = async (): Promise<PoolClosure> => {
    const pending = [...opened];
    opened.clear();
    // A failed connect left no pool to close.
    const pools = (await Promise.allSettled(pending)).flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
    const closure = await closeEach([...new Set(pools)]);
    for (const pool of closure.open) opened.add(Promise.resolve(pool));
    return closure;
  };

  const drop = (pool: ConnectionPool, request: Request, database: string): void => {
    stats.dropped = true;
    stats.droppedDatabase = database;
    env.logger.warn(`fault ${FAULT} dropping the connection to ${database} after ${String(stats.rowsSeen)} streamed rows`);
    pool.close().catch((error: unknown) => {
      env.logger.warn({ error: serializeError(error) }, `fault ${FAULT}: closing the pool of ${database} failed`);
    });
    // close() lets the in-use connection finish its query before destroying it, so the streaming read is cancelled too
    // and fails mid-table, as it does when the connection is lost.
    request.cancel();
  };

  const wrap = (pool: ConnectionPool, database: string): ConnectionPool => {
    const request = (): Request => {
      const created = pool.request();
      // The driver emits `row` only for streaming requests, so catalog queries never count.
      created.on('row', () => {
        stats.rowsSeen += 1;
        if (!stats.dropped && stats.rowsSeen >= afterRows) drop(pool, created, database);
      });
      return created;
    };
    return new Proxy(pool, {
      get(target, property) {
        if (property === 'request') return request;
        const value: unknown = Reflect.get(target, property, target);
        // mssql keys pool state by the pool object itself, so every other member runs against the real pool.
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };

  const legacy: LegacyDb = {
    live: () => track(base.live()),
    async database(name: string): Promise<ConnectionPool> {
      const pool = await track(base.database(name));
      if (!name.includes(SNAPSHOT_DB_INFIX)) return pool;
      let wrapped = wrappers.get(pool);
      if (wrapped === undefined) {
        wrapped = wrap(pool, name);
        wrappers.set(pool, wrapped);
      }
      return wrapped;
    },
    async transaction(fn, options) {
      // The base transaction reuses the cached pool of that name, so it runs on the pool tracked here.
      await track(base.database(options?.database ?? env.ctx.env.MURA_DATABASE));
      return base.transaction(fn, options);
    },
    async close(): Promise<void> {
      const { open, error } = await closePools();
      if (open.length > 0) throw error;
    },
  };
  return { legacy, stats, closePools };
}

/** Closes the fault's pools; pools whose close rejected are kept for `resume` and returned as a failed assertion. */
async function closeFaultPools(env: FaultEnv, fault: DroppingLegacyDb): Promise<FaultAssertion | undefined> {
  const { open, error } = await fault.closePools();
  if (open.length === 0) return undefined;
  unclosedPools.set(env, [...(unclosedPools.get(env) ?? []), ...open]);
  env.logger.warn({ error: serializeError(error) }, `fault ${FAULT}: ${String(open.length)} of its SQL Server pools did not close; resume closes them again`);
  return fail(POOLS_CLOSED, { openPools: open.length, error: serializeError(error) }, "closing the fault's SQL Server pools failed");
}

/** Closes the pools `run` left open; passes once none is still open. */
async function closeUnclosedPools(env: FaultEnv, pools: readonly ConnectionPool[]): Promise<FaultAssertion> {
  const { open, error } = await closeEach(pools);
  if (open.length === 0) {
    unclosedPools.delete(env);
    return pass(POOLS_CLOSED_ON_RESUME, { closedPools: pools.length });
  }
  unclosedPools.set(env, open);
  env.logger.warn({ error: serializeError(error) }, `fault ${FAULT}: ${String(open.length)} of its SQL Server pools still did not close`);
  return fail(POOLS_CLOSED_ON_RESUME, { openPools: open.length, error: serializeError(error) }, "closing the fault's SQL Server pools failed again");
}

/** Whether the faulted feed failed because, and only after, its connection was dropped. */
function droppedAssertion(stats: DropStats, afterRows: number, error: string | undefined): FaultAssertion {
  const { rowsSeen, dropped, droppedDatabase } = stats;
  if (error === undefined) {
    return dropped
      ? fail(DROPPED, { rowsSeen, droppedDatabase }, 'feed completed after the connection drop')
      : fail(
          DROPPED,
          { rowsSeen, afterRows },
          'the feed streamed fewer than afterRows snapshot rows; lower afterRows or run the deterministic legacy workload first',
        );
  }
  if (dropped && rowsSeen >= afterRows) return pass(DROPPED, { rowsSeen, droppedDatabase, error });
  return fail(DROPPED, { rowsSeen, afterRows, error }, 'the feed failed before the connection was dropped');
}

/** Drops the SQL Server connection of a feed run mid-extract, then reruns the feed on the snapshot it took, from the stored watermarks. */
export const mssqlDroppedMidExtract: FaultScript<MssqlDroppedParams> = {
  name: FAULT,
  reconciles: true,
  paramsSchema,
  async run(env, { afterRows }) {
    const { ctx } = env;
    const seqBefore = (await latestSnapshot(ctx))?.seq;
    const fault = createDroppingLegacyDb(env, afterRows);
    let failure: { error: unknown } | undefined;
    let poolsClosed: FaultAssertion | undefined;
    try {
      // Every other port is borrowed from ctx, so the derived context owns nothing to close; only the fault's pools are closed.
      const faultCtx = await createMigrationContext({
        env: ctx.env,
        clock: ctx.clock,
        logger: ctx.logger,
        db: ctx.db,
        legacy: fault.legacy,
        bridge: ctx.bridge,
        catalog: ctx.catalog,
        owners: ctx.owners,
        gateway: ctx.gateway,
        client: ctx.client,
      });
      try {
        await runFeed(faultCtx);
      } catch (error) {
        failure = { error };
      }
    } finally {
      poolsClosed = await closeFaultPools(env, fault);
    }

    // The feed takes its snapshot before it extracts, so a new ready snapshot is the one the rerun resumes on.
    const seqAfter = (await latestSnapshot(ctx))?.seq;
    const resumeSeq = seqAfter !== seqBefore ? seqAfter : undefined;
    const error = failure === undefined ? undefined : messageOf(failure.error);
    const { rowsSeen, droppedDatabase } = fault.stats;
    const dropped = droppedAssertion(fault.stats, afterRows, error);
    return {
      assertions: poolsClosed === undefined ? [dropped] : [dropped, poolsClosed],
      details: { afterRows, rowsSeen, droppedDatabase, seqBefore, seqAfter, error },
      state: { resumeSeq },
    };
  },
  async resume(env, _params, output) {
    const steps: string[] = [];
    const assertions: FaultAssertion[] = [];
    const unclosed = unclosedPools.get(env);
    if (unclosed !== undefined) {
      steps.push(CLOSE_FAULT_POOLS);
      assertions.push(await closeUnclosedPools(env, unclosed));
    }
    const recorded = output?.state?.resumeSeq;
    const snapshotSeq = typeof recorded === 'number' ? recorded : undefined;
    steps.push(RERUN_FEED);
    try {
      const result = await runFeed(env.ctx, snapshotSeq === undefined ? {} : { snapshotSeq });
      const detail = { snapshotSeq: result.snapshotSeq, exitCode: result.exitCode };
      assertions.push(
        result.exitCode === 0
          ? pass(RESUMED, detail)
          : fail(RESUMED, { ...detail, reconciliation: result.reconciliation }, 'the rerun feed did not reconcile to zero difference'),
      );
    } catch (error) {
      assertions.push(fail(RESUMED, { snapshotSeq, error: messageOf(error) }));
    }
    return { steps, assertions };
  },
};
