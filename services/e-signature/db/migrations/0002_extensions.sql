-- SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Split shares of the Masa class-extension tables (subtype baseTable synthetic.audit_entry, synthetic.signature or
-- synthetic.signature_request) and of ttrash (class-map owner e-signature); columns in live-catalog order and nullability.
CREATE TABLE esignature.extend_subtype (
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
ALTER TABLE esignature.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE esignature.extend_set (
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
ALTER TABLE esignature.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_set_tenant_subtypeid_idx ON esignature.extend_set (tenant_id, subtypeid);

CREATE TABLE esignature.extend_attribute (
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
ALTER TABLE esignature.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_attribute_tenant_extendsetid_idx ON esignature.extend_attribute (tenant_id, extendsetid);

CREATE TABLE esignature.extend_rc_set (
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
ALTER TABLE esignature.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_rc_set_tenant_subtypeid_idx ON esignature.extend_rc_set (tenant_id, subtypeid);

CREATE TABLE esignature.extend_data (
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
ALTER TABLE esignature.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_data_tenant_baseid_idx ON esignature.extend_data (tenant_id, baseid);

-- objectstring is byte-exact WDDX.
CREATE TABLE esignature.trash (
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
ALTER TABLE esignature.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE esignature.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON esignature.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
