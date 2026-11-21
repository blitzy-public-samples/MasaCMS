-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
CREATE TABLE reporting.tenant_registry (
  site_id text PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE,
  public_user_pool_id text,
  private_user_pool_id text,
  category_pool_id text,
  file_pool_id text,
  display_pool_id text,
  content_pool_ids text[],
  public_user_pool_tenant uuid,
  private_user_pool_tenant uuid,
  category_pool_tenant uuid,
  file_pool_tenant uuid,
  display_pool_tenant uuid,
  content_pool_tenants uuid[],
  domains text[],
  aggregate_version bigint NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL
);
CREATE TABLE reporting.tenant_grant (
  grantor_tenant uuid NOT NULL,
  grantee_tenant uuid NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)
);
CREATE TABLE reporting.changelog (
  tenant_id uuid NOT NULL,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  seq bigserial NOT NULL,
  "table" text NOT NULL,
  op text NOT NULL CHECK (op IN ('insert','update','delete')),
  key text NOT NULL,
  before text,
  after text,
  columns text[] NOT NULL DEFAULT '{}',
  origin text NOT NULL CHECK (origin IN ('target','legacy-window','migration-feed','backfill')),
  actor_user_id text,
  actor_service text,
  at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  request_id text,
  operation_id text,
  PRIMARY KEY (tenant_id, seq),
  CHECK ((op = 'insert' AND before IS NULL AND after IS NOT NULL)
      OR (op = 'update' AND before IS NOT NULL AND after IS NOT NULL)
      OR (op = 'delete' AND before IS NOT NULL AND after IS NULL))
);
CREATE INDEX changelog_cursor_idx ON reporting.changelog (tenant_id, xid, seq);
CREATE INDEX changelog_operation_idx ON reporting.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE reporting.changelog ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.changelog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.changelog
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE reporting.unit_gate (
  unit text PRIMARY KEY,
  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),
  holder_id text,
  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),
  updated_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  CHECK ((state = 'closed') = (holder_id IS NOT NULL))
);

CREATE TABLE reporting.open_operation (
  operation_id text PRIMARY KEY,
  kind text NOT NULL,
  units text[] NOT NULL,
  started_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)
);
CREATE INDEX open_operation_units_idx ON reporting.open_operation USING gin (units);

CREATE TABLE reporting.migration_batch (
  tenant_id uuid NOT NULL,
  batch_id text NOT NULL,
  legacy_table text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),
  row_count integer NOT NULL,
  applied_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  PRIMARY KEY (tenant_id, batch_id)
);
ALTER TABLE reporting.migration_batch ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.migration_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.migration_batch
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE reporting.migration_watermark (
  legacy_table text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('forward','reverse')),
  snapshot_seq bigint,
  backup_lsn numeric(25,0),
  finished_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (legacy_table, direction)
);

CREATE TABLE reporting.inbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  subscription text NOT NULL,
  received_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),
  PRIMARY KEY (tenant_id, event_id)
);
ALTER TABLE reporting.inbox ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE reporting.consumer_aggregate_version (
  tenant_id uuid NOT NULL,
  subscription text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_version bigint NULL,
  updated_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)
);
ALTER TABLE reporting.consumer_aggregate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.consumer_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.consumer_aggregate_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE reporting.outbox (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  event_id uuid PRIMARY KEY,
  topic text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('state','process')),
  ordering_key text NOT NULL,
  envelope jsonb NOT NULL,
  operation_id text NULL,
  held boolean NOT NULL DEFAULT false,
  created_at timestamp(3) without time zone NOT NULL,
  published_at timestamp(3) without time zone NULL
);
CREATE INDEX outbox_unpublished_idx ON reporting.outbox (tenant_id, seq) WHERE published_at IS NULL AND NOT held;
CREATE INDEX outbox_held_idx ON reporting.outbox (tenant_id, operation_id) WHERE held;
CREATE INDEX outbox_created_idx ON reporting.outbox (tenant_id, created_at);
ALTER TABLE reporting.outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE reporting.scheduled_task_queue (
  tenant_id uuid NOT NULL,
  queue text NOT NULL,
  name text NOT NULL,
  schedule_time timestamp(3) without time zone NOT NULL,
  url text NOT NULL,
  body jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  deadline_s integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','deleted')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamp(3) without time zone,
  last_status integer,
  created_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, queue, name)
);
CREATE INDEX scheduled_task_queue_pending_due ON reporting.scheduled_task_queue (tenant_id, schedule_time) WHERE status = 'pending';
CREATE INDEX scheduled_task_queue_lease_expiry ON reporting.scheduled_task_queue (tenant_id, lease_until) WHERE status = 'running';
CREATE INDEX scheduled_task_queue_live ON reporting.scheduled_task_queue (tenant_id, queue, schedule_time, name) WHERE status IN ('pending','running');
CREATE INDEX scheduled_task_queue_tombstone_expiry ON reporting.scheduled_task_queue (tenant_id, updated_at) WHERE status IN ('done','failed','deleted');
ALTER TABLE reporting.scheduled_task_queue ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.scheduled_task_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.scheduled_task_queue
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE TABLE reporting.scheduled_task_queue_state (
  tenant_id uuid NOT NULL,
  queue text NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, queue)
);
ALTER TABLE reporting.scheduled_task_queue_state ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.scheduled_task_queue_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.scheduled_task_queue_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
