-- Case-insensitive metadata id lookups, indexed as 0009 indexes the file id lookups: (metaid COLLATE legacy_char_ci) stays indexable under forced RLS.
CREATE INDEX file_metadata_tenant_metaid_ci_idx ON content.file_metadata (tenant_id, (metaid COLLATE content.legacy_char_ci));
