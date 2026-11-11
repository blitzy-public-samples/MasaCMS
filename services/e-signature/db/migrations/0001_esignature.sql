-- SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Platform tables
CREATE TABLE esignature.tenant_registry (
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
CREATE TABLE esignature.tenant_grant (
  grantor_tenant uuid NOT NULL,
  grantee_tenant uuid NOT NULL,
  kind text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (grantor_tenant, grantee_tenant, kind, resource_id)
);
CREATE TABLE esignature.changelog (
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
CREATE INDEX changelog_cursor_idx ON esignature.changelog (tenant_id, xid, seq);
CREATE INDEX changelog_operation_idx ON esignature.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;
ALTER TABLE esignature.changelog ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.changelog FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.changelog
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.unit_gate (
  unit text PRIMARY KEY,
  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),
  holder_id text,
  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),
  updated_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  CHECK ((state = 'closed') = (holder_id IS NOT NULL))
);

CREATE TABLE esignature.open_operation (
  operation_id text PRIMARY KEY,
  kind text NOT NULL,
  units text[] NOT NULL,
  started_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)
);
CREATE INDEX open_operation_units_idx ON esignature.open_operation USING gin (units);

CREATE TABLE esignature.migration_batch (
  tenant_id uuid NOT NULL,
  batch_id text NOT NULL,
  legacy_table text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),
  row_count integer NOT NULL,
  applied_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  PRIMARY KEY (tenant_id, batch_id)
);
ALTER TABLE esignature.migration_batch ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.migration_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.migration_batch
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.migration_watermark (
  legacy_table text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('forward','reverse')),
  snapshot_seq bigint,
  backup_lsn numeric(25,0),
  finished_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (legacy_table, direction)
);

CREATE TABLE esignature.inbox (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  subscription text NOT NULL,
  received_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  status text NOT NULL CHECK (status IN ('applied','stale','superseded')),
  PRIMARY KEY (tenant_id, event_id)
);
ALTER TABLE esignature.inbox ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.inbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.consumer_aggregate_version (
  tenant_id uuid NOT NULL,
  subscription text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  last_version bigint NULL,
  updated_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3),
  PRIMARY KEY (tenant_id, subscription, aggregate_type, aggregate_id)
);
ALTER TABLE esignature.consumer_aggregate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.consumer_aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.consumer_aggregate_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.outbox (
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
CREATE INDEX outbox_unpublished_idx ON esignature.outbox (tenant_id, seq) WHERE published_at IS NULL AND NOT held;
CREATE INDEX outbox_held_idx ON esignature.outbox (tenant_id, operation_id) WHERE held;
CREATE INDEX outbox_created_idx ON esignature.outbox (tenant_id, created_at);
ALTER TABLE esignature.outbox ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.outbox
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Owned units
CREATE TABLE esignature.signature_request (
  tenant_id uuid NOT NULL,
  request_id char(35) NOT NULL,
  siteid varchar(25) NOT NULL,
  document_name varchar(255) NOT NULL,
  document_sha256 char(64) NOT NULL,
  document bytea,
  signer_user_id char(35) NOT NULL,
  state varchar(10) NOT NULL DEFAULT 'PENDING',
  created timestamp(3) without time zone NOT NULL,
  createdbyid char(35) NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT pk_signature_request PRIMARY KEY (request_id),
  CONSTRAINT ck_signature_request_state CHECK (state IN ('PENDING','SIGNED'))
);
ALTER TABLE esignature.signature_request ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.signature_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.signature_request
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX ix_signature_request_tenant_created_request ON esignature.signature_request (tenant_id, created, request_id COLLATE "C");

CREATE TABLE esignature.signature (
  tenant_id uuid NOT NULL,
  signature_id char(35) NOT NULL,
  request_id char(35) NOT NULL,
  typed_name varchar(255) NOT NULL,
  signer_user_id char(35) NOT NULL,
  signed_at timestamp(3) without time zone NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT pk_signature PRIMARY KEY (signature_id),
  CONSTRAINT uq_signature_request_id UNIQUE (request_id)
);
ALTER TABLE esignature.signature ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.signature FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.signature
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.audit_entry (
  tenant_id uuid NOT NULL,
  entry_id char(35) NOT NULL,
  request_id char(35) NOT NULL,
  seq integer NOT NULL,
  action varchar(30) NOT NULL,
  actor_user_id char(35),
  detail text,
  at timestamp(3) without time zone NOT NULL,
  prev_hash bytea NOT NULL,
  entry_hash bytea NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  CONSTRAINT pk_audit_entry PRIMARY KEY (entry_id),
  CONSTRAINT uq_audit_entry_request_seq UNIQUE (request_id, seq),
  CONSTRAINT ck_audit_entry_prev_hash CHECK (octet_length(prev_hash) = 32),
  CONSTRAINT ck_audit_entry_entry_hash CHECK (octet_length(entry_hash) = 32)
);
ALTER TABLE esignature.audit_entry ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.audit_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.audit_entry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX ix_audit_entry_tenant_request_seq ON esignature.audit_entry (tenant_id, request_id, seq);
