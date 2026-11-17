-- Last activity of the jar's session, the idle clock legacy's session timeout runs on; existing rows start it at this migration.
ALTER TABLE gateway.legacy_jar ADD COLUMN last_active_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3);
-- Idle jars, oldest first, for the purge each new jar runs.
CREATE INDEX legacy_jar_idle_idx ON gateway.legacy_jar (last_active_at);
