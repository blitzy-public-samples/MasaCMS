-- site-monitor cursor
CREATE TABLE programs_sites.sitemonitor_state (
  tenant_id uuid NOT NULL,
  id smallint NOT NULL DEFAULT 1,
  last_monitored timestamp(3) without time zone,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (id = 1)
);
ALTER TABLE programs_sites.sitemonitor_state ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.sitemonitor_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.sitemonitor_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
