-- Lookup and feed indexes: filename and remoteid as bpchar under a primary-strength ICU collation (leakproof, so seekable under forced RLS), category parents, and the live nav feed list.
CREATE COLLATION IF NOT EXISTS content.lookup_ci (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
CREATE INDEX IF NOT EXISTS content_tenant_siteid_filename_ci_idx ON content.content (tenant_id, siteid, ((filename::bpchar) COLLATE content.lookup_ci));
CREATE INDEX IF NOT EXISTS content_tenant_siteid_remoteid_ci_idx ON content.content (tenant_id, siteid, ((remoteid::bpchar) COLLATE content.lookup_ci));
CREATE INDEX IF NOT EXISTS category_tenant_parentid_idx ON content.category (tenant_id, parentid);
CREATE INDEX IF NOT EXISTS content_tenant_siteid_moduleid_isnav_searchexclude_idx ON content.content (tenant_id, siteid, moduleid, isnav, searchexclude) WHERE active = 1 AND approved = 1;
