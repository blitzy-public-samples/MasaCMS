-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Finance's split shares of Masa dbo tables (mapping-only): class-extension rows whose subtype's baseTable is a finance
-- table, and ttrash rows whose class-map owner is finance. Columns follow the live legacy catalog order and nullability.

-- tclassextend subtypes whose baseTable is a finance table.
CREATE TABLE finance.extend_subtype (
  tenant_id uuid NOT NULL,
  subtypeid char(35) NOT NULL,
  siteid text,
  basetable text,
  basekeyfield text,
  datatable text,
  type text,
  subtype text,
  isactive smallint,
  notes text,
  lastupdate timestamp(3) without time zone,
  datecreated timestamp(3) without time zone,
  lastupdateby text,
  hassummary smallint,
  hasbody smallint,
  description text,
  availablesubtypes text,
  iconclass text,
  hasassocfile smallint,
  hasconfigurator integer,
  adminonly integer,
  PRIMARY KEY (tenant_id, subtypeid)
);
ALTER TABLE finance.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tclassextendsets rows of those subtypes.
CREATE TABLE finance.extend_set (
  tenant_id uuid NOT NULL,
  extendsetid char(35) NOT NULL,
  subtypeid char(35),
  categoryid text,
  siteid text,
  name text,
  orderno integer,
  isactive smallint,
  container text,
  PRIMARY KEY (tenant_id, extendsetid)
);
ALTER TABLE finance.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_set_tenant_subtypeid_idx ON finance.extend_set (tenant_id, subtypeid);

-- tclassextendattributes rows of those sets; attributeid keeps its legacy identity value.
CREATE TABLE finance.extend_attribute (
  tenant_id uuid NOT NULL,
  attributeid integer NOT NULL,
  extendsetid char(35),
  siteid text,
  name text,
  label text,
  hint text,
  type text,
  orderno integer,
  isactive smallint,
  required text,
  validation text,
  regex text,
  message text,
  defaultvalue text,
  optionlist text,
  optionlabellist text,
  adminonly integer,
  PRIMARY KEY (tenant_id, attributeid)
);
ALTER TABLE finance.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_attribute_tenant_extendsetid_idx ON finance.extend_attribute (tenant_id, extendsetid);

-- tclassextendrcsets related-content sets of those subtypes.
CREATE TABLE finance.extend_rc_set (
  tenant_id uuid NOT NULL,
  subtypeid text,
  availablesubtypes text,
  siteid text,
  entitytype text,
  name text NOT NULL,
  orderno integer,
  relatedcontentsetid char(35) NOT NULL,
  PRIMARY KEY (tenant_id, relatedcontentsetid)
);
ALTER TABLE finance.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_rc_set_tenant_subtypeid_idx ON finance.extend_rc_set (tenant_id, subtypeid);

-- tclassextenddata values of those attributes; dataid keeps its legacy identity value.
CREATE TABLE finance.extend_data (
  tenant_id uuid NOT NULL,
  dataid integer NOT NULL,
  baseid char(35) NOT NULL,
  attributeid integer NOT NULL,
  siteid text,
  attributevalue text,
  remoteid text,
  datetimevalue timestamp(3) without time zone,
  numericvalue double precision,
  stringvalue text,
  PRIMARY KEY (tenant_id, dataid)
);
ALTER TABLE finance.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_data_tenant_baseid_idx ON finance.extend_data (tenant_id, baseid);

-- ttrash extendObject rows of those subtypes; objectstring is byte-exact WDDX.
CREATE TABLE finance.trash (
  tenant_id uuid NOT NULL,
  objectid char(35) NOT NULL,
  parentid char(35) NOT NULL,
  siteid text NOT NULL,
  objectlabel text NOT NULL,
  objectclass text NOT NULL,
  objecttype text NOT NULL,
  objectsubtype text NOT NULL,
  objectstring text,
  deleteddate timestamp(3) without time zone,
  deletedby text NOT NULL,
  deleteid char(35),
  orderno integer,
  PRIMARY KEY (tenant_id, objectid)
);
ALTER TABLE finance.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE finance.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
