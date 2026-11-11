-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
CREATE TABLE timesheets.tenant_registry (
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
CREATE TABLE timesheets.tenant_grant (
  grantor_tenant uuid NOT NULL,
  grantee_tenant uuid NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)
);
CREATE TABLE timesheets.changelog (
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
CREATE INDEX changelog_cursor_idx ON timesheets.changelog (tenant_id, xid, seq);
CREATE INDEX changelog_operation_idx ON timesheets.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE timesheets.changelog ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.changelog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.changelog
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.unit_gate (
  unit text PRIMARY KEY,
  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),
  holder_id text,
  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),
  updated_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  CHECK ((state = 'closed') = (holder_id IS NOT NULL))
);

CREATE TABLE timesheets.open_operation (
  operation_id text PRIMARY KEY,
  kind text NOT NULL,
  units text[] NOT NULL,
  started_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)
);
CREATE INDEX open_operation_units_idx ON timesheets.open_operation USING gin (units);

CREATE TABLE timesheets.migration_batch (
  tenant_id uuid NOT NULL,
  batch_id text NOT NULL,
  legacy_table text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),
  row_count integer NOT NULL,
  applied_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  PRIMARY KEY (tenant_id, batch_id)
);
ALTER TABLE timesheets.migration_batch ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.migration_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.migration_batch
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.migration_watermark (
  legacy_table text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('forward','reverse')),
  snapshot_seq bigint,
  backup_lsn numeric(25,0),
  finished_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (legacy_table, direction)
);

CREATE TABLE timesheets.inbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  subscription text NOT NULL,
  received_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),
  PRIMARY KEY (tenant_id, event_id)
);
ALTER TABLE timesheets.inbox ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.consumer_aggregate_version (
  tenant_id uuid NOT NULL,
  subscription text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_version bigint NULL,
  updated_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)
);
ALTER TABLE timesheets.consumer_aggregate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.consumer_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.consumer_aggregate_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.outbox (
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
CREATE INDEX outbox_unpublished_idx ON timesheets.outbox (tenant_id, seq) WHERE published_at IS NULL AND NOT held;
CREATE INDEX outbox_held_idx ON timesheets.outbox (tenant_id, operation_id) WHERE held;
CREATE INDEX outbox_created_idx ON timesheets.outbox (tenant_id, created_at);
ALTER TABLE timesheets.outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Owned units
CREATE TABLE timesheets.timesheet (
  tenant_id uuid NOT NULL,
  timesheet_id char(35) NOT NULL,
  person_id char(35) NOT NULL,
  siteid text NOT NULL,
  period_start timestamp(3) without time zone NOT NULL,
  period_end timestamp(3) without time zone NOT NULL,
  due_date timestamp(3) without time zone NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  lastupdate timestamp(3) without time zone,
  lastupdatebyid char(35),
  legacy_program_id integer NOT NULL,
  PRIMARY KEY (tenant_id, timesheet_id)
);
CREATE INDEX timesheet_person_idx ON timesheets.timesheet (tenant_id, person_id);
ALTER TABLE timesheets.timesheet ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.timesheet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.timesheet
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.timesheet_day (
  tenant_id uuid NOT NULL,
  day_id char(35) NOT NULL,
  timesheet_id char(35) NOT NULL,
  work_date timestamp(3) without time zone NOT NULL,
  hours numeric(19,4) NOT NULL,
  state text NOT NULL DEFAULT 'DRAFT',
  lastupdate timestamp(3) without time zone,
  lastupdatebyid char(35),
  legacy_program_id integer NOT NULL,
  PRIMARY KEY (tenant_id, day_id)
);
CREATE INDEX timesheet_day_timesheet_idx ON timesheets.timesheet_day (tenant_id, timesheet_id);
ALTER TABLE timesheets.timesheet_day ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.timesheet_day FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.timesheet_day
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.approval_action (
  tenant_id uuid NOT NULL,
  action_id char(35) NOT NULL,
  day_id char(35) NOT NULL,
  action text NOT NULL,
  role text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  actor_user_id char(35) NOT NULL,
  comment text,
  created timestamp(3) without time zone NOT NULL,
  legacy_program_id integer NOT NULL,
  PRIMARY KEY (tenant_id, action_id)
);
CREATE INDEX approval_action_day_idx ON timesheets.approval_action (tenant_id, day_id);
ALTER TABLE timesheets.approval_action ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.approval_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.approval_action
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE timesheets.blackout (
  tenant_id uuid NOT NULL,
  blackout_id char(35) NOT NULL,
  day_id char(35) NOT NULL,
  person_id char(35) NOT NULL,
  archive_id char(35),
  reason text NOT NULL DEFAULT 'person-archived',
  created timestamp(3) without time zone NOT NULL,
  legacy_program_id integer NOT NULL,
  PRIMARY KEY (tenant_id, blackout_id),
  UNIQUE (tenant_id, day_id)
);
ALTER TABLE timesheets.blackout ENABLE ROW LEVEL SECURITY; ALTER TABLE timesheets.blackout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timesheets.blackout
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
