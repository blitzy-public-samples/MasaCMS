// Unit tests of the rollback re-baseline over injected snapshot and feed operations and the committed cut-over files.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RestartFeedOptions, RestartFeedResult } from '../../src/apply/index.js';
import { loadConfig } from '../../src/config.js';
import type { MigrationContext } from '../../src/context.js';
import type { MigrationEnv } from '../../src/env.js';
import { snapshotsDir } from '../../src/paths.js';
import {
  ROLLBACK_VERSION,
  RollbackNotActiveError,
  computeRollbackSet,
  readRebaselineRecord,
  rebaselineRecordPath,
  rebaselineRollbackSet,
  type RebaselineDeps,
} from '../../src/rollback/index.js';
import { backupFileName, snapshotDatabaseNameFor, type SnapshotRecord } from '../../src/snapshot/index.js';
import { TEST_SOURCE_SHA, createMutableClock, createTestDirs, testEnv, type TestDirs } from '../helpers/env.js';
import { createCallLog, createGatewayDouble, type CallLog } from '../helpers/gateway-double.js';

const config = loadConfig();
const STARTED_AT = '2026-06-30T12:00:00.000Z';
const SNAPSHOT_MS = 90_000;
const FEED_MS = 45_000;
const FINISHED_AT = new Date(Date.parse(STARTED_AT) + SNAPSHOT_MS + FEED_MS).toISOString();
const FRESH_SEQ = 42;

/** Steps of a re-baseline a test can make reject. */
type Step = 'status' | keyof RebaselineDeps;

interface Harness {
  ctx: MigrationContext;
  log: CallLog;
  deps: { takeSnapshot: Mock<RebaselineDeps['takeSnapshot']>; restartFeedFor: Mock<RebaselineDeps['restartFeedFor']> };
  /** Makes the next call of `step` reject with `error` once it is logged. */
  failNext(step: Step, error: Error): void;
}

let dirs: TestDirs;

beforeEach(async () => {
  dirs = await createTestDirs();
});

afterEach(async () => {
  await dirs.cleanup();
});

/** The `ready` snapshot takeSnapshot returns for a re-baseline. */
function freshSnapshot(env: MigrationEnv, takenAt: Date): SnapshotRecord {
  return {
    seq: FRESH_SEQ,
    kind: 'rebaseline',
    state: 'ready',
    databaseName: snapshotDatabaseNameFor(env.MURA_DATABASE, FRESH_SEQ),
    backupPath: path.join(snapshotsDir(env.OPT2_STATE_DIR), backupFileName(FRESH_SEQ)),
    checkpointLsn: '41000000012800001',
    lastLsn: '41000000014400001',
    takenAt,
    transitionId: null,
    sourceSha: TEST_SOURCE_SHA,
    manifestComplete: true,
    fileStore: { status: 'ok', objects: 0 },
  };
}

/** The outcome restartFeedFor reports for `options`. */
function feedResult(options: RestartFeedOptions): RestartFeedResult {
  return {
    snapshotSeq: FRESH_SEQ,
    units: [...options.units],
    tables: [
      {
        table: 'dbo.tusers',
        owner: 'identity',
        catchUp: null,
        rebaseline: { units: ['identity.user_account'], inserts: 3, updates: 1, deletes: 0, batches: 1 },
      },
    ],
  };
}

/** A context of the committed config, a gateway double at `active`, a mutable clock and the suite's state directory. */
function harness(active: string | null): Harness {
  const log = createCallLog();
  const clock = createMutableClock(STARTED_AT);
  const gateway = createGatewayDouble({ active, log, clock });
  const env = testEnv({ dirs });
  const narrow: Pick<MigrationContext, 'env' | 'config' | 'clock' | 'gateway'> = { env, config, clock, gateway };
  const queued = new Map<keyof RebaselineDeps, Error>();
  const rejectIfQueued = (step: keyof RebaselineDeps): void => {
    const error = queued.get(step);
    queued.delete(step);
    if (error !== undefined) throw error;
  };

  const takeSnapshot = vi.fn<RebaselineDeps['takeSnapshot']>(async (_ctx, opts) => {
    log.append('snapshot', 'takeSnapshot', opts);
    rejectIfQueued('takeSnapshot');
    clock.advance(SNAPSHOT_MS);
    return freshSnapshot(env, clock.now());
  });
  const restartFeedFor = vi.fn<RebaselineDeps['restartFeedFor']>(async (_ctx, options) => {
    log.append('apply', 'restartFeedFor', options);
    rejectIfQueued('restartFeedFor');
    clock.advance(FEED_MS);
    return feedResult(options);
  });

  return {
    ctx: narrow as MigrationContext,
    log,
    deps: { takeSnapshot, restartFeedFor },
    failNext(step, error) {
      if (step === 'status') gateway.failNext('status', error);
      else queued.set(step, error);
    },
  };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('rebaselineRollbackSet', () => {
  it.each([
    { active: 'v0002', shown: 'v0002' },
    { active: null, shown: 'none' },
  ])('refuses with RollbackNotActiveError while $shown is active, before any snapshot', async ({ active, shown }) => {
    const h = harness(active);

    const error = await rebaselineRollbackSet(h.ctx, h.deps).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RollbackNotActiveError);
    expect(error).toMatchObject({ name: 'RollbackNotActiveError', activeVersion: active, exitCode: 1 });
    expect((error as Error).message).toContain(`only once ${ROLLBACK_VERSION} is active; the gateway's active version is ${shown}`);
    expect(h.deps.takeSnapshot).not.toHaveBeenCalled();
    expect(h.deps.restartFeedFor).not.toHaveBeenCalled();
    expect(h.log.ops()).toEqual(['status']);
    expect(readRebaselineRecord(dirs.stateDir)).toBeUndefined();
  });

  it('takes a fresh snapshot, then restarts the feed for exactly R from it, and writes the record it returns', async () => {
    const h = harness(ROLLBACK_VERSION);
    const R = computeRollbackSet(h.ctx);
    expect(R.units).toEqual(expect.arrayContaining(['people.person_archive', 'timesheets.blackout']));

    const record = await rebaselineRollbackSet(h.ctx, h.deps);

    expect(h.log.ops()).toEqual(['status', 'takeSnapshot', 'restartFeedFor']);
    expect(h.deps.takeSnapshot).toHaveBeenCalledExactlyOnceWith(h.ctx, { kind: 'rebaseline' });
    expect(h.deps.restartFeedFor).toHaveBeenCalledExactlyOnceWith(h.ctx, { units: R.units, snapshotSeq: FRESH_SEQ });
    expect(h.deps.takeSnapshot.mock.calls[0]?.[0]).toBe(h.ctx);
    expect(h.deps.restartFeedFor.mock.calls[0]?.[0]).toBe(h.ctx);
    expect(record).toEqual({
      tableVersion: ROLLBACK_VERSION,
      groups: R.groups,
      units: R.units,
      snapshotSeq: FRESH_SEQ,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      feed: feedResult({ units: R.units }),
    });

    const file = rebaselineRecordPath(dirs.stateDir);
    expect(file).toBe(path.join(dirs.stateDir, 'rollback', 'rebaseline.json'));
    expect(readRebaselineRecord(dirs.stateDir)).toEqual(record);
    expect(await readFile(file, 'utf8')).toBe(`${JSON.stringify(record, null, 2)}\n`);
    expect(await readdir(path.dirname(file))).toEqual(['rebaseline.json']);
  });

  describe.each<{ step: Step; ops: string[] }>([
    { step: 'status', ops: ['status'] },
    { step: 'takeSnapshot', ops: ['status', 'takeSnapshot'] },
    { step: 'restartFeedFor', ops: ['status', 'takeSnapshot', 'restartFeedFor'] },
  ])('when $step rejects', ({ step, ops }) => {
    it('rejects with that error, calls no later step and writes no record', async () => {
      const h = harness(ROLLBACK_VERSION);
      const failure = new Error(`${step} failed`);
      h.failNext(step, failure);

      await expect(rebaselineRollbackSet(h.ctx, h.deps)).rejects.toBe(failure);

      expect(h.log.ops()).toEqual(ops);
      expect(readRebaselineRecord(dirs.stateDir)).toBeUndefined();
    });

    it('leaves the record of an earlier successful re-baseline unchanged', async () => {
      const h = harness(ROLLBACK_VERSION);
      await rebaselineRollbackSet(h.ctx, h.deps);
      const file = rebaselineRecordPath(dirs.stateDir);
      const earlier = await readFile(file, 'utf8');
      h.log.clear();
      const failure = new Error(`${step} failed`);
      h.failNext(step, failure);

      await expect(rebaselineRollbackSet(h.ctx, h.deps)).rejects.toBe(failure);

      expect(h.log.ops()).toEqual(ops);
      expect(await readFile(file, 'utf8')).toBe(earlier);
      expect(await readdir(path.dirname(file))).toEqual(['rebaseline.json']);
    });
  });
});

describe('readRebaselineRecord', () => {
  it('returns undefined when no record has been written', () => {
    expect(readRebaselineRecord(dirs.stateDir)).toBeUndefined();
  });

  it.each([
    { holds: 'truncated JSON', prepare: (file: string) => writeFile(file, '{"tableVersion": "v0003",'), type: SyntaxError, props: {} },
    { holds: 'a directory', prepare: (file: string) => mkdir(file), type: Error, props: { code: 'EISDIR' } },
  ])('throws when the record path holds $holds', async ({ prepare, type, props }) => {
    const file = rebaselineRecordPath(dirs.stateDir);
    await mkdir(path.dirname(file), { recursive: true });
    await prepare(file);

    const error = thrownBy(() => readRebaselineRecord(dirs.stateDir));

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject(props);
  });
});

describe('rebaselineRecordPath', () => {
  it('places the record at rollback/rebaseline.json under an absolute state directory', () => {
    expect(rebaselineRecordPath('/var/opt2/state')).toBe('/var/opt2/state/rollback/rebaseline.json');
  });

  it('throws for a relative state directory', () => {
    expect(() => rebaselineRecordPath('opt2/state')).toThrow('State directory must be an absolute path, got "opt2/state"');
  });
});
