-- strategies-content form response tables from legacy tformresponsepackets and tformresponsequestions; nvarchar columns map to text as the canonical type map sets.
CREATE TABLE content.form_response_packet (
  tenant_id uuid NOT NULL,
  responseid char(35) NOT NULL,
  formid char(35),
  siteid text,
  fieldlist text,
  data text,
  entered timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, responseid)
);
CREATE INDEX form_response_packet_form_idx ON content.form_response_packet (tenant_id, formid, siteid);
ALTER TABLE content.form_response_packet ENABLE ROW LEVEL SECURITY; ALTER TABLE content.form_response_packet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.form_response_packet
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.form_response_question (
  tenant_id uuid NOT NULL,
  responseid char(35) NOT NULL,
  formid char(35) NOT NULL,
  formfield text NOT NULL,
  formvalue text,
  pollvalue text,
  PRIMARY KEY (tenant_id, responseid, formid, formfield)
);
ALTER TABLE content.form_response_question ENABLE ROW LEVEL SECURITY; ALTER TABLE content.form_response_question FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.form_response_question
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
