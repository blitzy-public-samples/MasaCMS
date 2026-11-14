-- SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Surveys share of the Masa class-extension tables (subtype baseTable a synthetic.survey* table) and of ttrash
-- (extendObject rows of those subtypes); written by migration apply only. Columns follow the live legacy catalog.
CREATE TABLE surveys.extend_subtype (
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
ALTER TABLE surveys.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE surveys.extend_set (
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
ALTER TABLE surveys.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_set_tenant_subtypeid_idx ON surveys.extend_set (tenant_id, subtypeid);

CREATE TABLE surveys.extend_attribute (
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
ALTER TABLE surveys.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_attribute_tenant_extendsetid_idx ON surveys.extend_attribute (tenant_id, extendsetid);

CREATE TABLE surveys.extend_rc_set (
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
ALTER TABLE surveys.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_rc_set_tenant_subtypeid_idx ON surveys.extend_rc_set (tenant_id, subtypeid);

CREATE TABLE surveys.extend_data (
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
ALTER TABLE surveys.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_data_tenant_baseid_idx ON surveys.extend_data (tenant_id, baseid);

-- objectstring is byte-exact WDDX.
CREATE TABLE surveys.trash (
  tenant_id uuid NOT NULL,
  objectid char(35) NOT NULL,
  parentid char(35) NOT NULL,
  siteid text NOT NULL,
  objectlabel text NOT NULL,
  objectclass text NOT NULL,
  objecttype text NOT NULL,
  objectsubtype text NOT NULL,
  objectstring text NULL,
  deleteddate timestamp(3) without time zone NULL,
  deletedby text NOT NULL,
  deleteid char(35) NULL,
  orderno integer NULL,
  PRIMARY KEY (tenant_id, objectid)
);
ALTER TABLE surveys.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
