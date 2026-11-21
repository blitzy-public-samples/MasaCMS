-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
CREATE TABLE finance.tenant_registry (
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
CREATE TABLE finance.tenant_grant (
  grantor_tenant uuid NOT NULL,
  grantee_tenant uuid NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)
);
CREATE TABLE finance.changelog (
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
CREATE INDEX changelog_cursor_idx ON finance.changelog (tenant_id, xid, seq);
CREATE INDEX changelog_operation_idx ON finance.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE finance.changelog ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.changelog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.changelog
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE finance.unit_gate (
  unit text PRIMARY KEY,
  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),
  holder_id text,
  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),
  updated_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  CHECK ((state = 'closed') = (holder_id IS NOT NULL))
);

CREATE TABLE finance.open_operation (
  operation_id text PRIMARY KEY,
  kind text NOT NULL,
  units text[] NOT NULL,
  started_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)
);
CREATE INDEX open_operation_units_idx ON finance.open_operation USING gin (units);

CREATE TABLE finance.migration_batch (
  tenant_id uuid NOT NULL,
  batch_id text NOT NULL,
  legacy_table text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),
  row_count integer NOT NULL,
  applied_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  PRIMARY KEY (tenant_id, batch_id)
);
ALTER TABLE finance.migration_batch ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.migration_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.migration_batch
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE finance.migration_watermark (
  legacy_table text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('forward','reverse')),
  snapshot_seq bigint,
  backup_lsn numeric(25,0),
  finished_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (legacy_table, direction)
);

CREATE TABLE finance.inbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  subscription text NOT NULL,
  received_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),
  PRIMARY KEY (tenant_id, event_id)
);
ALTER TABLE finance.inbox ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE finance.consumer_aggregate_version (
  tenant_id uuid NOT NULL,
  subscription text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_version bigint NULL,
  updated_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)
);
ALTER TABLE finance.consumer_aggregate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.consumer_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.consumer_aggregate_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Finance records folded from Program_N, with their current lifecycle state and version
CREATE TABLE finance.record (
  tenant_id uuid NOT NULL,
  record_id char(35) NOT NULL,
  siteid text NOT NULL,
  title text NOT NULL,
  amount numeric(19,4) NOT NULL,
  period text NOT NULL,
  state text NOT NULL DEFAULT 'IN-PROGRESS',
  version integer NOT NULL DEFAULT 1,
  created timestamp(3) without time zone NOT NULL,
  createdbyid char(35) NOT NULL,
  lastupdate timestamp(3) without time zone,
  lastupdatebyid char(35),
  legacy_program_id integer NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, record_id)
);
ALTER TABLE finance.record ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.record
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX record_state_idx ON finance.record (tenant_id, state);
CREATE INDEX record_period_idx ON finance.record (tenant_id, period);
CREATE INDEX record_list_idx ON finance.record (tenant_id, created, record_id COLLATE "C");

-- One row per create, edit and transition of a record; its UNIQUE key also serves lookups by record
CREATE TABLE finance.record_version (
  tenant_id uuid NOT NULL,
  version_id char(35) NOT NULL,
  record_id char(35) NOT NULL,
  version integer NOT NULL,
  state text NOT NULL,
  title text NOT NULL,
  amount numeric(19,4) NOT NULL,
  period text NOT NULL,
  action text NOT NULL,
  actor_user_id char(35) NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  legacy_program_id integer NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, version_id),
  UNIQUE (tenant_id, record_id, version)
);
ALTER TABLE finance.record_version ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.record_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.record_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Attachment metadata of a record; the bytes are the stored object named by object_key
CREATE TABLE finance.attachment (
  tenant_id uuid NOT NULL,
  attachment_id char(35) NOT NULL,
  record_id char(35) NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 char(64) NOT NULL,
  object_key text NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  createdbyid char(35) NOT NULL,
  legacy_program_id integer NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, attachment_id)
);
ALTER TABLE finance.attachment ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.attachment
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX attachment_record_idx ON finance.attachment (tenant_id, record_id, created, attachment_id COLLATE "C");

-- Record count and total amount per program, period and state
CREATE TABLE finance.rollup (
  tenant_id uuid NOT NULL,
  period text NOT NULL,
  state text NOT NULL,
  record_count integer NOT NULL,
  total_amount numeric(19,4) NOT NULL,
  computed_at timestamp(3) without time zone NOT NULL,
  legacy_program_id integer NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, legacy_program_id, period, state)
);
ALTER TABLE finance.rollup ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.rollup
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Program_<id> schema each tenant's rows were folded from, one per tenant
CREATE TABLE finance.program_binding (
  tenant_id uuid NOT NULL UNIQUE,
  site_id text NOT NULL,
  legacy_program_id integer NOT NULL UNIQUE,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, legacy_program_id)
);
ALTER TABLE finance.program_binding ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.program_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.program_binding
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Attachment objects an uncommitted apply stored, or a committed one replaced, until their collection
CREATE TABLE finance.staged_object (
  tenant_id uuid NOT NULL,
  object_key text NOT NULL,
  attachment_id char(35) NOT NULL,
  state text NOT NULL CHECK (state IN ('staged','superseded')),
  recorded_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, object_key)
);
ALTER TABLE finance.staged_object ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.staged_object FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.staged_object
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
