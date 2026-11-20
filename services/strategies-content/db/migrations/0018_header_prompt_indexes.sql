-- Header prompt count indexes over leakproof columns, so seekable under forced RLS: unapproved drafts outside change sets by update time, and expiring active content.
CREATE INDEX IF NOT EXISTS content_tenant_siteid_active_lastupdate_draft_idx ON content.content (tenant_id, siteid, active, lastupdate) WHERE approved = 0 AND changesetid IS NULL;
CREATE INDEX IF NOT EXISTS content_tenant_siteid_expires_idx ON content.content (tenant_id, siteid, expires) WHERE active = 1 AND expires IS NOT NULL;
