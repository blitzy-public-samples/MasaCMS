-- Identity-fed group, permission and membership projections for strategies-content node permission checks and group names.
CREATE TABLE content.group_projection (
  tenant_id uuid NOT NULL,
  group_id char(35) NOT NULL,
  site_id varchar(25),
  group_name text,
  is_public smallint,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, group_id)
);
ALTER TABLE content.group_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE content.group_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.group_projection
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.permission_projection (
  tenant_id uuid NOT NULL,
  group_id char(35) NOT NULL,
  site_id varchar(25) NOT NULL,
  content_id varchar(35) NOT NULL,
  type text NOT NULL,
  PRIMARY KEY (tenant_id, group_id, site_id, content_id, type)
);
ALTER TABLE content.permission_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE content.permission_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.permission_projection
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX permission_projection_tenant_site_id_content_id_idx ON content.permission_projection (tenant_id, site_id, content_id);

CREATE TABLE content.membership_projection (
  tenant_id uuid NOT NULL,
  user_id char(35) NOT NULL,
  site_id varchar(25),
  group_id char(35) NOT NULL,
  PRIMARY KEY (tenant_id, user_id, group_id)
);
ALTER TABLE content.membership_projection ENABLE ROW LEVEL SECURITY; ALTER TABLE content.membership_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.membership_projection
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX membership_projection_tenant_group_id_idx ON content.membership_projection (tenant_id, group_id);
