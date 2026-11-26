-- Schema migration: the snapshot the target was backfilled from, recorded before its first batch

CREATE TABLE migration.backfill_baseline (
  snapshot_seq integer PRIMARY KEY,
  started_at timestamp(3) without time zone NOT NULL
);
CREATE UNIQUE INDEX backfill_baseline_single_uidx ON migration.backfill_baseline ((true));
