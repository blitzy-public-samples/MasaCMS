-- Last activity of a session, the idle clock legacy's session timeout runs on; existing rows start it at this migration.
ALTER TABLE identity.session ADD COLUMN last_active_at timestamp(3) without time zone NOT NULL DEFAULT LOCALTIMESTAMP(3);
-- Idle sessions of a tenant, oldest first, for the purge each new session runs.
CREATE INDEX session_tenant_last_active_idx ON identity.session (tenant_id, last_active_at);
