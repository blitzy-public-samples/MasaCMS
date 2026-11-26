// Re-baselines the target copy of the rollback set R once the rollback version has returned it to legacy.
import { readFileSync } from 'node:fs';

import { restartFeedFor, type RestartFeedResult } from '../apply/index.js';
import type { MigrationContext } from '../context.js';
import { stateDirPath } from '../paths.js';
import { writeFileAtomic } from '../reports/index.js';
import { takeSnapshot, type SnapshotRecord } from '../snapshot/index.js';

import { ROLLBACK_VERSION, computeRollbackSet } from './set.js';

/** One re-baseline of R: the fresh snapshot its units were re-baselined at and the feed restart's outcome. */
export interface RebaselineRecord {
  tableVersion: string;
  groups: string[];
  units: string[];
  snapshotSeq: SnapshotRecord['seq'];
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601. */
  finishedAt: string;
  feed: RestartFeedResult;
}

/** Snapshot and feed operations {@link rebaselineRollbackSet} calls; each defaults to the real one. */
export interface RebaselineDeps {
  takeSnapshot: typeof takeSnapshot;
  restartFeedFor: typeof restartFeedFor;
}

/** The gateway's active version is not the rollback version, so R's units may still be `target`-authoritative. */
export class RollbackNotActiveError extends Error {
  override readonly name = 'RollbackNotActiveError';
  readonly exitCode = 1;

  constructor(readonly activeVersion: string | null) {
    const active = activeVersion ?? 'none';
    super(`The forward feed restarts for R only once ${ROLLBACK_VERSION} is active; the gateway's active version is ${active}`);
  }
}

/** `<stateDir>/rollback/rebaseline.json`; `stateDir` must be absolute. */
export function rebaselineRecordPath(stateDir: string): string {
  return stateDirPath(stateDir, 'rollback', 'rebaseline.json');
}

/** The last written re-baseline record, or `undefined` when none exists; read and parse errors propagate. */
export function readRebaselineRecord(stateDir: string): RebaselineRecord | undefined {
  const filePath = rebaselineRecordPath(stateDir);
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text) as RebaselineRecord;
}

/**
 * Takes a fresh `rebaseline` snapshot, restarts the forward feed for R's units from it and writes the record to
 * {@link rebaselineRecordPath} under `OPT2_STATE_DIR`.
 * @throws RollbackNotActiveError, before any snapshot, when the active version is not the rollback version.
 */
export async function rebaselineRollbackSet(ctx: MigrationContext, deps: Partial<RebaselineDeps> = {}): Promise<RebaselineRecord> {
  const snapshotWith = deps.takeSnapshot ?? takeSnapshot;
  const restartWith = deps.restartFeedFor ?? restartFeedFor;
  const startedAt = ctx.clock.now().toISOString();

  const set = computeRollbackSet(ctx);
  const { tableVersion } = await ctx.gateway.status();
  if (tableVersion !== ROLLBACK_VERSION) throw new RollbackNotActiveError(tableVersion);

  const snapshot = await snapshotWith(ctx, { kind: 'rebaseline' });
  const feed = await restartWith(ctx, { units: set.units, snapshotSeq: snapshot.seq });

  const record: RebaselineRecord = {
    tableVersion: ROLLBACK_VERSION,
    groups: set.groups,
    units: set.units,
    snapshotSeq: snapshot.seq,
    startedAt,
    finishedAt: ctx.clock.now().toISOString(),
    feed,
  };
  await writeFileAtomic(rebaselineRecordPath(ctx.env.OPT2_STATE_DIR), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
