-- Durable intents for content-files publication and recovery.
CREATE TABLE IF NOT EXISTS content.staged_object (
  tenant_id uuid NOT NULL,
  stage_id char(35) NOT NULL,
  object_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('migration','upload')),
  file_id char(35) NOT NULL,
  variant text NOT NULL,
  ext text NOT NULL,
  size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  content_type text,
  state text NOT NULL DEFAULT 'staged' CHECK (state IN ('staged','committed')),
  recorded_at timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3),
  PRIMARY KEY (tenant_id, stage_id)
);
ALTER TABLE content.staged_object ENABLE ROW LEVEL SECURITY; ALTER TABLE content.staged_object FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content.staged_object;
CREATE POLICY tenant_isolation ON content.staged_object
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS staged_object_tenant_recorded_at_idx ON content.staged_object (tenant_id, recorded_at);
