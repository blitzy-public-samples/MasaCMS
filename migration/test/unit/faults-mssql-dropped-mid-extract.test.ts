// Unit tests for the mssql-dropped-mid-extract fault script over a fake legacy port, feed and snapshot list.
import { EventEmitter } from 'node:events';

import { REDACTED } from '@opt2/platform/logging';
import type { ConnectionPool, Request } from 'mssql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runFeed, type FeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import { createMigrationContext, type CreateContextOptions, type MigrationContext } from '../../src/context.js';
import { mssqlDroppedMidExtract } from '../../src/faults/scripts/mssql-dropped-mid-extract.js';
import type { FaultEnv, FaultRunOutput } from '../../src/faults/scripts/types.js';
import { createLegacyDb, type LegacyDb } from '../../src/legacy/index.js';
import { latestSnapshot, type SnapshotRecord } from '../../src/snapshot/index.js';

vi.mock('../../src/legacy/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/legacy/index.js')>()),
  createLegacyDb: vi.fn(),
}));

vi.mock('../../src/apply/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/apply/index.js')>()),
  runFeed: vi.fn(),
}));

vi.mock('../../src/snapshot/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/snapshot/index.js')>()),
  latestSnapshot: vi.fn(),
}));

vi.mock('../../src/context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/context.js')>()),
  createMigrationContext: vi.fn(),
}));

const SNAP_3 = 'muradb_opt2_snap_3';
const SNAP_4 = 'muradb_opt2_snap_4';
const MASTER = 'master';
const LIVE = 'muradb';
const ARCHIVE = 'muradb_archive';
// Driver text no redaction pattern masks, so it reaches a log or report only if interpolated there.
const RAW_DRIVER_TEXT = ['tenant', 'payroll', 'row', '4711'].join('-');
const WORKLOAD_REASON =
  'the feed streamed fewer than afterRows snapshot rows; lower afterRows or run the deterministic legacy workload first';

class FakeRequest extends EventEmitter {
  readonly cancel = vi.fn();
}

/** A pool whose requests are event emitters; `connect` resolves with whatever `this` it was called on. */
function fakePool(name: string) {
  const requests: FakeRequest[] = [];
  const pool = {
    name,
    connected: true,
    requests,
    request: vi.fn(() => {
      const created = new FakeRequest();
      requests.push(created);
      return created;
    }),
    close: vi.fn(() => Promise.resolve()),
    connect: vi.fn(function (this: unknown) {
      return Promise.resolve(this);
    }),
  };
  return pool;
}

type FakePool = ReturnType<typeof fakePool>;

/** The base legacy port the script creates, with one fake pool per database name. */
function fakeBase() {
  const pools = new Map<string, FakePool>();
  const poolOf = (name: string): FakePool => {
    let pool = pools.get(name);
    if (pool === undefined) {
      pool = fakePool(name);
      pools.set(name, pool);
    }
    return pool;
  };
  const base = {
    live: vi.fn(() => Promise.resolve(poolOf(LIVE) as unknown as ConnectionPool)),
    database: vi.fn((name: string) => Promise.resolve(poolOf(name) as unknown as ConnectionPool)),
    transaction: vi.fn(() => Promise.resolve('committed')),
    close: vi.fn(() => Promise.resolve()),
  };
  return { base, poolOf };
}

/** A fault env over a context of sentinel ports; only `logger` is exercised. */
function faultEnv() {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const ctx = {
    env: { MURA_DATABASE: LIVE },
    clock: { now: () => new Date('2026-06-30T00:00:00Z') },
    logger,
    db: { schema: 'migration' },
    legacy: { name: 'main-legacy' },
    bridge: { name: 'bridge' },
    catalog: { name: 'catalog' },
    owners: { name: 'owners' },
    gateway: { name: 'gateway' },
    client: { name: 'client' },
  } as unknown as MigrationContext;
  return { env: { ctx, clock: ctx.clock, logger } as unknown as FaultEnv, ctx, logger };
}

function snapshot(seq: number): SnapshotRecord {
  return { seq, databaseName: `muradb_opt2_snap_${String(seq)}` } as SnapshotRecord;
}

/** Opens a streaming request on `pool` and emits `rows` rows on it. */
function streamRows(pool: ConnectionPool, rows: number): FakeRequest {
  const request = pool.request() as unknown as FakeRequest;
  for (let row = 0; row < rows; row++) request.emit('row', { row });
  return request;
}

function feedResult(exitCode: 0 | 1, snapshotSeq = 4): FeedResult {
  return {
    snapshotSeq,
    exitCode,
    reconciliation: { point: `after-feed-${String(snapshotSeq)}`, result: exitCode === 0 ? 'zero-difference' : 'difference', reportPath: '/r.json' },
  } as FeedResult;
}

let base: ReturnType<typeof fakeBase>['base'];
let poolOf: ReturnType<typeof fakeBase>['poolOf'];

beforeEach(() => {
  vi.resetAllMocks();
  ({ base, poolOf } = fakeBase());
  vi.mocked(createLegacyDb).mockReturnValue(base as unknown as LegacyDb);
  vi.mocked(createMigrationContext).mockImplementation((options?: CreateContextOptions) =>
    Promise.resolve({ ...options } as unknown as MigrationContext),
  );
});

describe('mssql-dropped-mid-extract fault script', () => {
  it('is the config fault mssql-dropped-mid-extract and reconciles', () => {
    expect(mssqlDroppedMidExtract.name).toBe('mssql-dropped-mid-extract');
    expect(mssqlDroppedMidExtract.reconciles).toBe(true);
    expect(loadConfig().faults.map((fault) => fault.name)).toContain(mssqlDroppedMidExtract.name);
  });

  it.each([
    [{}, { afterRows: 500 }],
    [{ afterRows: 1 }, { afterRows: 1 }],
    [{ afterRows: 20000 }, { afterRows: 20000 }],
  ])('parses %j as %j', (input, expected) => {
    expect(mssqlDroppedMidExtract.paramsSchema.parse(input)).toStrictEqual(expected);
  });

  it.each([{ afterRows: 0 }, { afterRows: 1.5 }, { afterRows: '500' }, { afterRows: 5, units: [] }])('rejects %j', (input) => {
    expect(mssqlDroppedMidExtract.paramsSchema.safeParse(input).success).toBe(false);
  });

  describe('run', () => {
    it('drops the snapshot connection once after afterRows rows across two snapshot pools and passes when the feed then fails', async () => {
      const { env, ctx, logger } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
      let faultLegacy: LegacyDb | undefined;
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        faultLegacy = feedCtx.legacy;
        const before = await feedCtx.legacy.database(SNAP_3);
        const after = await feedCtx.legacy.database(SNAP_4);
        expect(await feedCtx.legacy.database(SNAP_4)).toBe(after);
        streamRows(before, 3);
        streamRows(after, 2);
        streamRows(after, 4);
        streamRows(before, 1);
        expect(poolOf(SNAP_4).close).toHaveBeenCalledOnce();
        expect(poolOf(SNAP_3).close).not.toHaveBeenCalled();
        throw new Error(`reading dbo.tcontent from database ${SNAP_4} failed`);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 5 });

      const snap3 = poolOf(SNAP_3);
      const snap4 = poolOf(SNAP_4);
      // Once when dropped, then each snapshot pool once more as the run closes the fault's pools.
      expect(snap4.close).toHaveBeenCalledTimes(2);
      expect(snap3.close).toHaveBeenCalledOnce();
      expect(snap4.requests.map((request) => request.cancel.mock.calls.length)).toStrictEqual([1, 0]);
      expect(snap3.requests.every((request) => request.cancel.mock.calls.length === 0)).toBe(true);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(output).toStrictEqual({
        assertions: [
          {
            name: 'connection-dropped',
            status: 'pass',
            detail: { rowsSeen: 10, droppedDatabase: SNAP_4, error: `reading dbo.tcontent from database ${SNAP_4} failed` },
          },
        ],
        details: {
          afterRows: 5,
          rowsSeen: 10,
          droppedDatabase: SNAP_4,
          seqBefore: 3,
          seqAfter: 4,
          error: `reading dbo.tcontent from database ${SNAP_4} failed`,
        },
        state: { resumeSeq: 4 },
      });

      expect(createLegacyDb).toHaveBeenCalledExactlyOnceWith(ctx.env);
      expect(latestSnapshot).toHaveBeenNthCalledWith(1, ctx);
      expect(latestSnapshot).toHaveBeenNthCalledWith(2, ctx);
      expect(base.close).not.toHaveBeenCalled();
      expect(faultLegacy).not.toBe(ctx.legacy);
      expect(createMigrationContext).toHaveBeenCalledExactlyOnceWith({
        env: ctx.env,
        clock: ctx.clock,
        logger: ctx.logger,
        db: ctx.db,
        legacy: faultLegacy,
        bridge: ctx.bridge,
        catalog: ctx.catalog,
        owners: ctx.owners,
        gateway: ctx.gateway,
        client: ctx.client,
      });
    });

    it('leaves non-snapshot pools unwrapped, keeps every other pool member, and closes each pool it opened once', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValue(null);
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        const { legacy } = feedCtx;
        expect(await legacy.live()).toBe(poolOf(LIVE));
        const master = await legacy.database(MASTER);
        expect(master).toBe(poolOf(MASTER));
        streamRows(master, 5);
        streamRows(await legacy.live(), 5);

        const wrapped = await legacy.database(SNAP_3);
        expect(wrapped).not.toBe(poolOf(SNAP_3));
        expect(wrapped.connected).toBe(true);
        await expect(wrapped.connect()).resolves.toBe(poolOf(SNAP_3));
        const fn = vi.fn();
        await expect(legacy.transaction(fn, { database: SNAP_3 })).resolves.toBe('committed');
        expect(base.transaction).toHaveBeenCalledExactlyOnceWith(fn, { database: SNAP_3 });
        await legacy.close();
        return feedResult(0);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 5 });

      // The feed's own close closed them, so the run's close finds nothing left open.
      for (const name of [MASTER, LIVE, SNAP_3]) expect(poolOf(name).close).toHaveBeenCalledOnce();
      expect(poolOf(MASTER).requests[0]?.cancel).not.toHaveBeenCalled();
      expect(base.close).not.toHaveBeenCalled();
      expect(output.assertions).toStrictEqual([
        { name: 'connection-dropped', status: 'fail', detail: { rowsSeen: 0, afterRows: 5 }, reason: WORKLOAD_REASON },
      ]);
      expect(output.state).toStrictEqual({ resumeSeq: undefined });
    });

    it('fails with the workload reason when the feed finishes before afterRows rows streamed', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        streamRows(await feedCtx.legacy.database(SNAP_3), 2);
        streamRows(await feedCtx.legacy.database(SNAP_4), 2);
        return feedResult(0);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 500 });

      expect(poolOf(SNAP_3).close).toHaveBeenCalledOnce();
      expect(poolOf(SNAP_4).close).toHaveBeenCalledOnce();
      expect(poolOf(SNAP_4).requests.every((request) => request.cancel.mock.calls.length === 0)).toBe(true);
      expect(output).toStrictEqual({
        assertions: [{ name: 'connection-dropped', status: 'fail', detail: { rowsSeen: 4, afterRows: 500 }, reason: WORKLOAD_REASON }],
        details: { afterRows: 500, rowsSeen: 4, droppedDatabase: undefined, seqBefore: 3, seqAfter: 4, error: undefined },
        state: { resumeSeq: 4 },
      });
    });

    it('fails when the feed completes although the connection was dropped', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        streamRows(await feedCtx.legacy.database(SNAP_4), 1);
        return feedResult(0);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 1 });

      expect(poolOf(SNAP_4).close).toHaveBeenCalledTimes(2);
      expect(output.assertions).toStrictEqual([
        {
          name: 'connection-dropped',
          status: 'fail',
          detail: { rowsSeen: 1, droppedDatabase: SNAP_4 },
          reason: 'feed completed after the connection drop',
        },
      ]);
    });

    it.each([
      ['an Error', new Error('owner people unavailable'), 'owner people unavailable'],
      ['a non-Error value', 'socket hang up', 'socket hang up'],
    ])('fails with the error when the feed throws %s before the drop', async (_label, thrown, message) => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValue(snapshot(3));
      vi.mocked(runFeed).mockRejectedValueOnce(thrown);

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 500 });

      expect(output).toStrictEqual({
        assertions: [
          {
            name: 'connection-dropped',
            status: 'fail',
            detail: { rowsSeen: 0, afterRows: 500, error: message },
            reason: 'the feed failed before the connection was dropped',
          },
        ],
        details: { afterRows: 500, rowsSeen: 0, droppedDatabase: undefined, seqBefore: 3, seqAfter: 3, error: message },
        state: { resumeSeq: undefined },
      });
      expect(base.database).not.toHaveBeenCalled();
      expect(base.live).not.toHaveBeenCalled();
    });

    it('logs a failed drop-time close as a fixed message with the safe error, and passes once the run closes that pool', async () => {
      const { env, logger } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(null).mockResolvedValueOnce(snapshot(1));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        const pool = await feedCtx.legacy.database('muradb_opt2_snap_1');
        poolOf('muradb_opt2_snap_1').close.mockRejectedValueOnce(new Error(`Connection is closing: ${RAW_DRIVER_TEXT}`));
        streamRows(pool, 2);
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error('reading dbo.tusers from database muradb_opt2_snap_1 failed');
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 2 });

      expect(output.assertions).toHaveLength(1);
      expect(output.assertions[0]?.status).toBe('pass');
      expect(output.state).toStrictEqual({ resumeSeq: 1 });
      expect(poolOf('muradb_opt2_snap_1').close).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn.mock.calls[1]).toStrictEqual([
        { error: expect.objectContaining({ type: 'Error', message: REDACTED }) },
        'fault mssql-dropped-mid-extract: closing the pool of muradb_opt2_snap_1 failed',
      ]);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(RAW_DRIVER_TEXT);
    });

    it('closes the pool of each database a transaction ran on', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValue(null);
      const fn = vi.fn();
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        await feedCtx.legacy.transaction(fn, { database: ARCHIVE });
        await feedCtx.legacy.transaction(fn);
        return feedResult(0);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 5 });

      expect(base.transaction.mock.calls).toStrictEqual([[fn, { database: ARCHIVE }], [fn, undefined]]);
      expect(poolOf(ARCHIVE).close).toHaveBeenCalledOnce();
      expect(poolOf(LIVE).close).toHaveBeenCalledOnce();
      expect(output.assertions.map((assertion) => assertion.name)).toStrictEqual(['connection-dropped']);
    });

    it('skips a pool whose connect failed and retries, at the run close, a pool the feed could not close', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValue(null);
      base.database.mockRejectedValueOnce(new Error('Login failed'));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        await expect(feedCtx.legacy.database(ARCHIVE)).rejects.toThrow('Login failed');
        await feedCtx.legacy.database(MASTER);
        poolOf(MASTER).close.mockRejectedValueOnce(new Error('Cannot close a pool while it is connecting'));
        await expect(feedCtx.legacy.close()).rejects.toThrow('Cannot close a pool while it is connecting');
        return feedResult(0);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 5 });

      expect(poolOf(MASTER).close).toHaveBeenCalledTimes(2);
      expect(poolOf(ARCHIVE).close).not.toHaveBeenCalled();
      expect(output.assertions.map((assertion) => assertion.name)).toStrictEqual(['connection-dropped']);
    });

    it('fails fault-pools-closed with the open count and safe error, never the raw text, when a pool does not close', async () => {
      const { env, logger } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        await feedCtx.legacy.live();
        streamRows(await feedCtx.legacy.database(SNAP_4), 1);
        poolOf(SNAP_4).close.mockRejectedValueOnce(new Error(`pool destroy failed: ${RAW_DRIVER_TEXT}`));
        throw new Error(`reading dbo.tcontent from database ${SNAP_4} failed`);
      });

      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 1 });

      expect(poolOf(LIVE).close).toHaveBeenCalledOnce();
      expect(poolOf(SNAP_4).close).toHaveBeenCalledTimes(2);
      expect(output.assertions).toStrictEqual([
        expect.objectContaining({ name: 'connection-dropped', status: 'pass' }),
        {
          name: 'fault-pools-closed',
          status: 'fail',
          detail: { openPools: 1, error: expect.objectContaining({ type: 'Error', message: REDACTED }) },
          reason: "closing the fault's SQL Server pools failed",
        },
      ]);
      expect(logger.warn).toHaveBeenLastCalledWith(
        { error: expect.objectContaining({ type: 'Error', message: REDACTED }) },
        'fault mssql-dropped-mid-extract: 1 of its SQL Server pools did not close; resume closes them again',
      );
      expect(JSON.stringify([output.assertions, logger.warn.mock.calls])).not.toContain(RAW_DRIVER_TEXT);
    });

    it.each<[string, boolean, boolean, string[], number]>([
      ['before any pool opened', false, false, ['rerun-feed'], 0],
      ['after opening a pool, which the run closes', true, false, ['rerun-feed'], 1],
      ['after opening a pool the run cannot close, which resume closes', true, true, ['close-fault-pools', 'rerun-feed'], 2],
    ])(
      'propagates a failure to build the fault context %s, without running the feed',
      async (_label, opensPool, closeFails, resumeSteps, closeCalls) => {
        const { env, logger } = faultEnv();
        vi.mocked(latestSnapshot).mockResolvedValue(null);
        vi.mocked(createMigrationContext).mockImplementationOnce(async (options?: CreateContextOptions) => {
          if (opensPool) await options?.legacy?.live();
          if (closeFails) poolOf(LIVE).close.mockRejectedValueOnce(new Error(`pool destroy failed: ${RAW_DRIVER_TEXT}`));
          throw new Error('legacy database is not SQL Server');
        });

        await expect(mssqlDroppedMidExtract.run(env, { afterRows: 5 })).rejects.toThrow('legacy database is not SQL Server');
        expect(runFeed).not.toHaveBeenCalled();
        expect(poolOf(LIVE).close).toHaveBeenCalledTimes(opensPool ? 1 : 0);

        vi.mocked(runFeed).mockResolvedValueOnce(feedResult(0, 4));
        const resumed = await mssqlDroppedMidExtract.resume(env, { afterRows: 5 });

        expect(resumed.steps).toStrictEqual(resumeSteps);
        expect(resumed.assertions).toStrictEqual([
          ...(closeFails ? [{ name: 'fault-pools-closed-on-resume', status: 'pass', detail: { closedPools: 1 } }] : []),
          { name: 'resumed-from-watermark', status: 'pass', detail: { snapshotSeq: 4, exitCode: 0 } },
        ]);
        expect(poolOf(LIVE).close).toHaveBeenCalledTimes(closeCalls);
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(RAW_DRIVER_TEXT);
      },
    );
  });

  describe('resume', () => {
    it.each<[string, FaultRunOutput | undefined, object]>([
      ['the recorded snapshot', { assertions: [], state: { resumeSeq: 4 } }, { snapshotSeq: 4 }],
      ['a fresh snapshot when none was recorded', { assertions: [], state: { resumeSeq: undefined } }, {}],
      ['a fresh snapshot when run threw', undefined, {}],
    ])('reruns the feed on the normal context from %s', async (_label, output, options) => {
      const { env, ctx } = faultEnv();
      vi.mocked(runFeed).mockResolvedValueOnce(feedResult(0, 4));

      const resumed = await mssqlDroppedMidExtract.resume(env, { afterRows: 5 }, output);

      expect(runFeed).toHaveBeenCalledExactlyOnceWith(ctx, options);
      expect(createLegacyDb).not.toHaveBeenCalled();
      expect(resumed).toStrictEqual({
        steps: ['rerun-feed'],
        assertions: [{ name: 'resumed-from-watermark', status: 'pass', detail: { snapshotSeq: 4, exitCode: 0 } }],
      });
    });

    it('fails with the reconciliation summary when the rerun does not reconcile to zero', async () => {
      const { env } = faultEnv();
      const result = feedResult(1, 4);
      vi.mocked(runFeed).mockResolvedValueOnce(result);

      const resumed = await mssqlDroppedMidExtract.resume(env, { afterRows: 5 }, { assertions: [], state: { resumeSeq: 4 } });

      expect(resumed).toStrictEqual({
        steps: ['rerun-feed'],
        assertions: [
          {
            name: 'resumed-from-watermark',
            status: 'fail',
            detail: { snapshotSeq: 4, exitCode: 1, reconciliation: result.reconciliation },
            reason: 'the rerun feed did not reconcile to zero difference',
          },
        ],
      });
    });

    it.each<[string, Error | undefined, object, number]>([
      ['passes once the retried close resolves', undefined, { name: 'fault-pools-closed-on-resume', status: 'pass', detail: { closedPools: 1 } }, 0],
      [
        'fails with the open count and safe error when the retried close rejects again',
        new Error(`pool destroy failed again: ${RAW_DRIVER_TEXT}`),
        {
          name: 'fault-pools-closed-on-resume',
          status: 'fail',
          detail: { openPools: 1, error: expect.objectContaining({ type: 'Error', message: REDACTED }) },
          reason: "closing the fault's SQL Server pools failed again",
        },
        1,
      ],
    ])('closes the pool run left open before the rerun feed, and %s', async (_label, retryError, expected, resumeWarnings) => {
      const { env, ctx, logger } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(4));
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        streamRows(await feedCtx.legacy.database(SNAP_4), 1);
        poolOf(SNAP_4).close.mockRejectedValueOnce(new Error(`pool destroy failed: ${RAW_DRIVER_TEXT}`));
        throw new Error(`reading dbo.tcontent from database ${SNAP_4} failed`);
      });
      const output = await mssqlDroppedMidExtract.run(env, { afterRows: 1 });
      expect(output.assertions.map((assertion) => `${assertion.name}:${assertion.status}`)).toStrictEqual([
        'connection-dropped:pass',
        'fault-pools-closed:fail',
      ]);
      const warningsAfterRun = logger.warn.mock.calls.length;
      if (retryError !== undefined) poolOf(SNAP_4).close.mockRejectedValueOnce(retryError);
      vi.mocked(runFeed).mockResolvedValueOnce(feedResult(0, 4));

      const resumed = await mssqlDroppedMidExtract.resume(env, { afterRows: 1 }, output);

      expect(poolOf(SNAP_4).close).toHaveBeenCalledTimes(3);
      expect(runFeed).toHaveBeenLastCalledWith(ctx, { snapshotSeq: 4 });
      expect(resumed).toStrictEqual({
        steps: ['close-fault-pools', 'rerun-feed'],
        assertions: [expected, { name: 'resumed-from-watermark', status: 'pass', detail: { snapshotSeq: 4, exitCode: 0 } }],
      });
      expect(logger.warn.mock.calls.slice(warningsAfterRun)).toStrictEqual(
        resumeWarnings === 0
          ? []
          : [[{ error: expect.objectContaining({ type: 'Error', message: REDACTED }) }, 'fault mssql-dropped-mid-extract: 1 of its SQL Server pools still did not close']],
      );
      expect(JSON.stringify([resumed, logger.warn.mock.calls])).not.toContain(RAW_DRIVER_TEXT);
    });

    it('retries a pool run left open on the first resume only', async () => {
      const { env } = faultEnv();
      vi.mocked(latestSnapshot).mockResolvedValue(null);
      vi.mocked(runFeed).mockImplementationOnce(async (feedCtx) => {
        await feedCtx.legacy.live();
        poolOf(LIVE).close.mockRejectedValueOnce(new Error('pool destroy failed'));
        return feedResult(0);
      });
      await mssqlDroppedMidExtract.run(env, { afterRows: 5 });
      vi.mocked(runFeed).mockResolvedValue(feedResult(0, 4));

      expect((await mssqlDroppedMidExtract.resume(env, { afterRows: 5 })).steps).toStrictEqual(['close-fault-pools', 'rerun-feed']);
      expect((await mssqlDroppedMidExtract.resume(env, { afterRows: 5 })).steps).toStrictEqual(['rerun-feed']);
      expect(poolOf(LIVE).close).toHaveBeenCalledTimes(2);
    });

    it('fails, never rethrows, when the rerun throws', async () => {
      const { env } = faultEnv();
      vi.mocked(runFeed).mockRejectedValueOnce(new Error('Snapshot 4 is failed, so the feed cannot read it'));

      const resumed = await mssqlDroppedMidExtract.resume(env, { afterRows: 5 }, { assertions: [], state: { resumeSeq: 4 } });

      expect(resumed).toStrictEqual({
        steps: ['rerun-feed'],
        assertions: [
          {
            name: 'resumed-from-watermark',
            status: 'fail',
            detail: { snapshotSeq: 4, error: 'Snapshot 4 is failed, so the feed cannot read it' },
          },
        ],
      });
    });
  });
});
