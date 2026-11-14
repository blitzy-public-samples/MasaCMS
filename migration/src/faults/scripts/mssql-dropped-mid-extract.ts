// Scripted fault mssql-dropped-mid-extract: a feed run loses its SQL Server connection while streaming snapshot rows; a rerun resumes from the owners' watermarks.
import type { ConnectionPool, Request } from 'mssql';

import { z } from '@opt2/platform/service-kit';

import { runFeed } from '../../apply/index.js';
import { createMigrationContext } from '../../context.js';
import { createLegacyDb, type LegacyDb } from '../../legacy/index.js';
import { SNAPSHOT_DB_INFIX, latestSnapshot } from '../../snapshot/index.js';
import { fail, pass, type FaultAssertion, type FaultEnv, type FaultScript } from './types.js';

const FAULT = 'mssql-dropped-mid-extract';
const DROPPED = 'connection-dropped';
const RESUMED = 'resumed-from-watermark';
const RERUN_FEED = 'rerun-feed';

const paramsSchema = z.object({ afterRows: z.number().int().min(1).default(500) }).strict();

/** Parameters of {@link mssqlDroppedMidExtract}: the streamed snapshot rows, over every snapshot database, after which the connection drops. */
export type MssqlDroppedParams = z.output<typeof paramsSchema>;

/** Snapshot rows the faulted feed streamed, and the snapshot database whose connection was dropped. */
interface DropStats {
  rowsSeen: number;
  dropped: boolean;
  droppedDatabase?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Legacy port over its own pools whose snapshot pools drop their connection once `afterRows` rows have streamed from them in total. */
function createDroppingLegacyDb(env: FaultEnv, afterRows: number): { legacy: LegacyDb; stats: DropStats } {
  const base = createLegacyDb(env.ctx.env);
  const stats: DropStats = { rowsSeen: 0, dropped: false };
  const wrappers = new WeakMap<ConnectionPool, ConnectionPool>();

  const drop = (pool: ConnectionPool, request: Request, database: string): void => {
    stats.dropped = true;
    stats.droppedDatabase = database;
    env.logger.warn(`fault ${FAULT} dropping the connection to ${database} after ${String(stats.rowsSeen)} streamed rows`);
    pool.close().catch((error: unknown) => {
      env.logger.warn(`fault ${FAULT}: closing the pool of ${database} failed: ${messageOf(error)}`);
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
    live: () => base.live(),
    async database(name: string): Promise<ConnectionPool> {
      const pool = await base.database(name);
      if (!name.includes(SNAPSHOT_DB_INFIX)) return pool;
      let wrapped = wrappers.get(pool);
      if (wrapped === undefined) {
        wrapped = wrap(pool, name);
        wrappers.set(pool, wrapped);
      }
      return wrapped;
    },
    transaction: (fn, options) => base.transaction(fn, options),
    close: () => base.close(),
  };
  return { legacy, stats };
}

/** Closes the fault's pools, one of which the fault already closed; a close failure is logged, never thrown. */
async function closeFaultPools(env: FaultEnv, legacy: LegacyDb): Promise<void> {
  try {
    await legacy.close();
  } catch (error) {
    env.logger.warn(`fault ${FAULT}: closing its SQL Server pools failed: ${messageOf(error)}`);
  }
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
    let failure: { error: unknown } | undefined;
    try {
      await runFeed(faultCtx);
    } catch (error) {
      failure = { error };
    } finally {
      await closeFaultPools(env, fault.legacy);
    }

    // The feed takes its snapshot before it extracts, so a new ready snapshot is the one the rerun resumes on.
    const seqAfter = (await latestSnapshot(ctx))?.seq;
    const resumeSeq = seqAfter !== seqBefore ? seqAfter : undefined;
    const error = failure === undefined ? undefined : messageOf(failure.error);
    const { rowsSeen, droppedDatabase } = fault.stats;
    return {
      assertions: [droppedAssertion(fault.stats, afterRows, error)],
      details: { afterRows, rowsSeen, droppedDatabase, seqBefore, seqAfter, error },
      state: { resumeSeq },
    };
  },
  async resume(env, _params, output) {
    const recorded = output?.state?.resumeSeq;
    const snapshotSeq = typeof recorded === 'number' ? recorded : undefined;
    try {
      const result = await runFeed(env.ctx, snapshotSeq === undefined ? {} : { snapshotSeq });
      const detail = { snapshotSeq: result.snapshotSeq, exitCode: result.exitCode };
      const assertion =
        result.exitCode === 0
          ? pass(RESUMED, detail)
          : fail(RESUMED, { ...detail, reconciliation: result.reconciliation }, 'the rerun feed did not reconcile to zero difference');
      return { steps: [RERUN_FEED], assertions: [assertion] };
    } catch (error) {
      return { steps: [RERUN_FEED], assertions: [fail(RESUMED, { snapshotSeq, error: messageOf(error) })] };
    }
  },
};
