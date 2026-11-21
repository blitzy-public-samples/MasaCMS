-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
-- synthetic.export_definition: data source and column list per site.
CREATE TABLE reporting.export_definition (
  tenant_id uuid NOT NULL,
  definition_id char(35) NOT NULL,
  siteid text NOT NULL,
  name text NOT NULL,
  source text NOT NULL,
  columns text NOT NULL,
  PRIMARY KEY (tenant_id, definition_id)
);
ALTER TABLE reporting.export_definition ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.export_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.export_definition
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- synthetic.export_job: object_key names the reporting-exports object that replaces the fixture output bytes; row_version is target-only.
CREATE TABLE reporting.export_job (
  tenant_id uuid NOT NULL,
  job_id char(35) NOT NULL,
  siteid text NOT NULL,
  definition_id char(35) NOT NULL,
  format text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  requested_by_id char(35) NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  started_at timestamp(3) without time zone NULL,
  finished_at timestamp(3) without time zone NULL,
  error text NULL,
  file_name text NULL,
  content_type text NULL,
  object_key text NULL,
  output_sha256 char(64) NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, job_id)
);
CREATE INDEX export_job_state_idx ON reporting.export_job (tenant_id, state);
CREATE INDEX export_job_created_idx ON reporting.export_job (tenant_id, created, job_id COLLATE "C");
CREATE INDEX export_job_object_idx ON reporting.export_job (tenant_id, job_id COLLATE "C") WHERE object_key IS NOT NULL;
ALTER TABLE reporting.export_job ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.export_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.export_job
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tsessiontracking (legacy-served writer); trackingid carries the legacy key value, so it has no default.
CREATE TABLE reporting.session_tracking (
  tenant_id uuid NOT NULL,
  trackingid integer NOT NULL,
  contentid char(35) NULL,
  siteid text NULL,
  userid char(35) NULL,
  remote_addr text NULL,
  server_name text NULL,
  query_string text NULL,
  referer text NULL,
  user_agent text NULL,
  script_name text NULL,
  urltoken text NOT NULL,
  entered timestamp(3) without time zone NOT NULL,
  country text NULL,
  lang text NULL,
  locale text NULL,
  keywords text NULL,
  originalurltoken text NULL,
  fname text NULL,
  lname text NULL,
  company text NULL,
  PRIMARY KEY (tenant_id, trackingid)
);
CREATE INDEX session_tracking_entered_idx ON reporting.session_tracking (tenant_id, entered);
CREATE INDEX session_tracking_site_idx ON reporting.session_tracking (tenant_id, siteid);
ALTER TABLE reporting.session_tracking ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.session_tracking FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.session_tracking
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
