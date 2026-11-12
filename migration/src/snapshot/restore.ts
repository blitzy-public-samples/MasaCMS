// Resets the live legacy database to a snapshot's backup; the caller has already stopped ColdFusion.
import { clearCatalogCache } from '../extract/catalog.js';

import { restoreLiveSql } from './backup.js';
import { requireSnapshot, runMasterStatement, SnapshotError, type SnapshotContext } from './snapshot.js';

/** Outcome of {@link restoreLiveFromSnapshot}. */
export interface RestoreLiveResult {
  seq: number;
  database: string;
  backupPath: string;
  durationMs: number;
}

/** Overwrites the live legacy database from snapshot `seq`'s backup; throws `SnapshotError` first for an unknown or dropped snapshot. */
export async function restoreLiveFromSnapshot(
  ctx: Pick<SnapshotContext, 'env' | 'db' | 'legacy' | 'clock' | 'logger'>,
  seq: number,
): Promise<RestoreLiveResult> {
  const snapshot = await requireSnapshot(ctx, seq);
  if (snapshot.state === 'dropped') {
    throw new SnapshotError(`Snapshot ${String(seq)} was dropped, so its backup ${snapshot.backupPath} no longer exists`);
  }
  const database = ctx.env.MURA_DATABASE;
  const { backupPath } = snapshot;

  // ROLLBACK IMMEDIATE also ends this process's pooled live connections; mssql reconnects them on the next acquire.
  const startedAt = ctx.clock.now();
  await runMasterStatement(ctx, restoreLiveSql(database, backupPath));
  const durationMs = ctx.clock.now().getTime() - startedAt.getTime();
  clearCatalogCache(database);

  ctx.logger.info(
    { latencyMs: durationMs },
    `restored ${database} from snapshot ${String(seq)} (${backupPath}) in ${String(durationMs)} ms`,
  );
  return { seq, database, backupPath, durationMs };
}
