-- Last people.person.changed.v1 aggregate version of each deleted person, which a recreated person continues past.
CREATE TABLE people.person_tombstone (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  row_version bigint NOT NULL,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE people.person_tombstone ENABLE ROW LEVEL SECURITY; ALTER TABLE people.person_tombstone FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.person_tombstone
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
