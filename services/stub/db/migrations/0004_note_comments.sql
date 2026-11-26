-- Comments on stub notes, written in the note's tenant by its own site or a site it granted `note-comment`.
CREATE TABLE stub.note_comment (
  tenant_id uuid NOT NULL,
  comment_id char(35) NOT NULL,
  note_id char(35) NOT NULL,
  author_site_id text NOT NULL,
  body text NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, comment_id)
);
ALTER TABLE stub.note_comment ENABLE ROW LEVEL SECURITY; ALTER TABLE stub.note_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stub.note_comment
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Keyset order of a note's comment pages; comment_id collates as the list's ORDER BY does.
CREATE INDEX note_comment_note_idx ON stub.note_comment (tenant_id, note_id, created, comment_id COLLATE "C");

-- One row per applied stub.note.commented.v1 delivery, written by the stub's own consumer.
CREATE TABLE stub.note_activity (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  note_id char(35) NOT NULL,
  comment_id char(35) NOT NULL,
  aggregate_version bigint NOT NULL,
  applied_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
ALTER TABLE stub.note_activity ENABLE ROW LEVEL SECURITY; ALTER TABLE stub.note_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stub.note_activity
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Open gates of the comment units; ids are concatenated so rewriteMigrationSql leaves them equal to the service's fixed unit ids.
INSERT INTO stub.unit_gate (unit, state, holder_id, phase) VALUES
  ('stub' || '.note_comment', 'open', NULL, 'quiet'),
  ('stub' || '.note_activity', 'open', NULL, 'quiet')
ON CONFLICT DO NOTHING;
