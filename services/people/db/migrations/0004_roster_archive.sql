-- People-only tables: person archive (seam 1), roster write operations, group-name projection.
CREATE TABLE people.person_archive (
  tenant_id uuid NOT NULL,
  archive_id char(35) NOT NULL,
  person_id char(35) NOT NULL,
  siteid text NOT NULL,
  effective_from timestamp(3) without time zone NOT NULL,
  archived_at timestamp(3) without time zone NOT NULL,
  archived_by_id char(35) NULL,
  archived_by text NULL,
  PRIMARY KEY (tenant_id, archive_id),
  UNIQUE (tenant_id, person_id, effective_from)
);
ALTER TABLE people.person_archive ENABLE ROW LEVEL SECURITY; ALTER TABLE people.person_archive FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.person_archive
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Roster write protocol intent; one open or halted operation per user, keyed on user_id alone because CF UUIDs are global.
CREATE TABLE people.roster_operation (
  tenant_id uuid NOT NULL,
  operation_id char(35) NOT NULL,
  kind text NOT NULL,
  user_id char(35) NOT NULL,
  payload jsonb NOT NULL,
  before_image jsonb NULL,
  identity_xid text NULL,
  state text NOT NULL CHECK (state IN ('started','people-committed','done','rolled-back','halted')),
  error text NULL,
  started_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  identity_unreachable_since timestamp(3) without time zone NULL,
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE UNIQUE INDEX roster_operation_open_user_uidx ON people.roster_operation (user_id)
  WHERE state IN ('started','people-committed','halted');
CREATE INDEX roster_operation_state_updated_idx ON people.roster_operation (state, updated_at);
ALTER TABLE people.roster_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE people.roster_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.roster_operation
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Projection of identity.group.changed.v1.
CREATE TABLE people.group_name (
  tenant_id uuid NOT NULL,
  group_id char(35) NOT NULL,
  site_id text,
  group_name text NULL,
  is_public integer NULL,
  deleted boolean NOT NULL DEFAULT false,
  aggregate_version bigint NOT NULL,
  PRIMARY KEY (tenant_id, group_id)
);
ALTER TABLE people.group_name ENABLE ROW LEVEL SECURITY; ALTER TABLE people.group_name FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.group_name
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
