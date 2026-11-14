-- Schema migration: coordination state of the migration service

CREATE TABLE migration.snapshot (
  seq integer PRIMARY KEY,
  database_name text NOT NULL UNIQUE,
  backup_file text NOT NULL,
  checkpoint_lsn numeric(25,0),
  last_lsn numeric(25,0),
  kind text NOT NULL CHECK (kind IN ('seed', 'workload', 'transition', 'rebaseline', 'checkpoint', 'feed')),
  transition_id text,
  state text NOT NULL CHECK (state IN ('creating', 'ready', 'failed', 'dropped')),
  manifest_complete boolean NOT NULL DEFAULT false,
  taken_at timestamp(3) without time zone NOT NULL,
  source_sha text NOT NULL
);

CREATE TABLE migration.transition (
  transition_id text PRIMARY KEY,
  from_version text NOT NULL,
  to_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'quiescing', 'awaiting-inflight', 'draining', 'gates-closed', 'reconciling', 'activating', 'handing-off', 'completed', 'aborting', 'aborted', 'failed')),
  step smallint NOT NULL CHECK (step BETWEEN 1 AND 8),
  units text[] NOT NULL,
  entries jsonb NOT NULL,
  frozen_routes text[] NOT NULL DEFAULT '{}',
  paused jsonb NOT NULL DEFAULT '{}',
  closed_gates jsonb NOT NULL DEFAULT '{}',
  snapshot_seq integer,
  reconciliation jsonb,
  error jsonb,
  requested_by text NOT NULL,
  started_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  finished_at timestamp(3) without time zone,
  claimed_by text,
  claim_expires_at timestamp(3) without time zone
);
CREATE UNIQUE INDEX transition_active_uidx ON migration.transition ((true)) WHERE state NOT IN ('completed', 'aborted', 'failed');

CREATE TABLE migration.write_window (
  window_id text PRIMARY KEY,
  route_key text NOT NULL,
  units text[] NOT NULL,
  scope jsonb NOT NULL,
  request_id text,
  kind text NOT NULL CHECK (kind IN ('request', 'legacy-step', 'startup', 'reload')),
  state text NOT NULL CHECK (state IN ('opening', 'open', 'closed', 'failed', 'import-pending', 'resolved')),
  phase text CHECK (phase IN ('quiet', 'executing', 'importing', 'import-pending')),
  closed_gates jsonb NOT NULL DEFAULT '{}',
  closing_gates jsonb NOT NULL DEFAULT '{}',
  phases jsonb NOT NULL DEFAULT '[]',
  lease_expires_at timestamp(3) without time zone,
  legacy_status integer,
  rows_imported integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  outcome text,
  error jsonb,
  opened_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  closed_at timestamp(3) without time zone,
  claimed_by text,
  claim_expires_at timestamp(3) without time zone
);
CREATE INDEX write_window_state_idx ON migration.write_window (state);

CREATE TABLE migration.unit_lease (
  unit text PRIMARY KEY,
  holder_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('window', 'transition')),
  acquired_at timestamp(3) without time zone NOT NULL
);
CREATE INDEX unit_lease_holder_idx ON migration.unit_lease (holder_id);

CREATE TABLE migration.projector_cursor (
  owner text NOT NULL,
  tenant_id uuid NOT NULL,
  cursor text NOT NULL, -- <xid>:<seq>
  applied_horizon numeric(20,0) NOT NULL,
  batches bigint NOT NULL DEFAULT 0,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (owner, tenant_id)
);

-- Keys per src/scheduler/state.ts SCHEDULER_KEYS: sitemonitor (SiteMonitorRecord), nativeTasks (NativeTasksRecord), surveyTasks (SurveyTasksRecord); background is reserved for the quiesce module
CREATE TABLE migration.scheduler_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE migration.file_manifest (
  snapshot_seq integer NOT NULL,
  site_id text COLLATE "C" NOT NULL,
  path text COLLATE "C" NOT NULL,
  file_id char(35) NOT NULL,
  variant text NOT NULL, -- '' | _source | _small | _medium
  ext text NOT NULL,
  size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  orphan boolean NOT NULL,
  last_modified timestamp(3) without time zone,
  object_key text,
  transferred_at timestamp(3) without time zone,
  PRIMARY KEY (snapshot_seq, site_id, path)
);
CREATE INDEX file_manifest_file_id_idx ON migration.file_manifest (file_id);
