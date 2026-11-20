/** `migration.backfill_baseline`: the one snapshot the target was backfilled from, kept apart from the owners' feed watermarks. */
import type { MetadataTx } from '@opt2/platform/tenancy';

import type { MigrationContext } from '../context.js';

const READ_BASELINE_SQL = 'SELECT snapshot_seq FROM migration.backfill_baseline';
const RECORD_BASELINE_SQL = 'INSERT INTO migration.backfill_baseline (snapshot_seq, started_at) VALUES ($1, $2) ON CONFLICT DO NOTHING';

async function readBaseline(tx: MetadataTx): Promise<number | null> {
  const result = await tx.query<{ snapshot_seq: number }>(READ_BASELINE_SQL);
  return result.rows[0]?.snapshot_seq ?? null;
}

/** The recorded baseline snapshot, or null before the first backfill. */
export function backfillBaseline(ctx: Pick<MigrationContext, 'db'>): Promise<number | null> {
  return ctx.db.withMetadata(readBaseline);
}

/** Records `snapshotSeq` as the baseline unless one is recorded, and returns the stored one, another snapshot's when a concurrent backfill recorded first. */
export function recordBackfillBaseline(ctx: Pick<MigrationContext, 'db' | 'clock'>, snapshotSeq: number): Promise<number | null> {
  return ctx.db.withMetadata(async (tx) => {
    await tx.query(RECORD_BASELINE_SQL, [snapshotSeq, ctx.clock.now()]);
    return readBaseline(tx);
  });
}
