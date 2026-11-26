-- Set before a legacy logout of the jar's session runs; stays until identity confirms that session's end (dropping the jar removes it).
ALTER TABLE gateway.legacy_jar ADD COLUMN identity_end_pending_at timestamp(3) without time zone NULL;
