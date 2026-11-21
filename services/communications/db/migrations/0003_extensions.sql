-- SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Class-extension rows whose subtype baseTable is a communications table (mapping-only; cextend is legacy-served); written only by migration apply.
CREATE TABLE communications.extend_subtype (
  tenant_id uuid NOT NULL,
  subtypeid char(35) NOT NULL,
  siteid text NULL,
  basetable text NULL,
  basekeyfield text NULL,
  datatable text NULL,
  type text NULL,
  subtype text NULL,
  isactive smallint NULL,
  notes text NULL,
  lastupdate timestamp(3) without time zone NULL,
  datecreated timestamp(3) without time zone NULL,
  lastupdateby text NULL,
  hassummary smallint NULL,
  hasbody smallint NULL,
  description text NULL,
  availablesubtypes text NULL,
  iconclass text NULL,
  hasassocfile smallint NULL,
  hasconfigurator integer NULL,
  adminonly integer NULL,
  PRIMARY KEY (tenant_id, subtypeid)
);
ALTER TABLE communications.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE communications.extend_set (
  tenant_id uuid NOT NULL,
  extendsetid char(35) NOT NULL,
  subtypeid char(35) NULL,
  categoryid text NULL,
  siteid text NULL,
  name text NULL,
  orderno integer NULL,
  isactive smallint NULL,
  container text NULL,
  PRIMARY KEY (tenant_id, extendsetid)
);
ALTER TABLE communications.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_set_tenant_subtypeid_idx ON communications.extend_set (tenant_id, subtypeid);

-- attributeid keeps its legacy IDENTITY value, which extend_data.attributeid references.
CREATE TABLE communications.extend_attribute (
  tenant_id uuid NOT NULL,
  attributeid integer NOT NULL,
  extendsetid char(35) NULL,
  siteid text NULL,
  name text NULL,
  label text NULL,
  hint text NULL,
  type text NULL,
  orderno integer NULL,
  isactive smallint NULL,
  required text NULL,
  validation text NULL,
  regex text NULL,
  message text NULL,
  defaultvalue text NULL,
  optionlist text NULL,
  optionlabellist text NULL,
  adminonly integer NULL,
  PRIMARY KEY (tenant_id, attributeid)
);
ALTER TABLE communications.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_attribute_tenant_extendsetid_idx ON communications.extend_attribute (tenant_id, extendsetid);

-- ORM table tclassextendrcsets in live-catalog column order; the ORM declares name required.
CREATE TABLE communications.extend_rc_set (
  tenant_id uuid NOT NULL,
  subtypeid text NULL,
  availablesubtypes text NULL,
  siteid text NULL,
  entitytype text NULL,
  name text NOT NULL,
  orderno integer NULL,
  relatedcontentsetid char(35) NOT NULL,
  PRIMARY KEY (tenant_id, relatedcontentsetid)
);
ALTER TABLE communications.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_rc_set_tenant_subtypeid_idx ON communications.extend_rc_set (tenant_id, subtypeid);

-- dataid keeps its legacy IDENTITY value; no sequence, because only migration apply writes this table.
CREATE TABLE communications.extend_data (
  tenant_id uuid NOT NULL,
  dataid integer NOT NULL,
  baseid char(35) NOT NULL,
  attributeid integer NOT NULL,
  siteid text NULL,
  attributevalue text NULL,
  remoteid text NULL,
  datetimevalue timestamp(3) without time zone NULL,
  numericvalue double precision NULL,
  stringvalue text NULL,
  PRIMARY KEY (tenant_id, dataid)
);
ALTER TABLE communications.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_data_tenant_baseid_idx ON communications.extend_data (tenant_id, baseid);
