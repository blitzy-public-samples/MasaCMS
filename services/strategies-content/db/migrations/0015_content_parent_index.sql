-- Child lookups by parent id across a tenant's sites, as the Site Manager tree's haskids count reads them.
CREATE INDEX IF NOT EXISTS content_tenant_parentid_idx ON content.content (tenant_id, parentid);
