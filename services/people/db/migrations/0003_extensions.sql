-- Class-extension definitions of baseTable tusers and tusersaddresses; read-only to people, written by migration apply.
CREATE TABLE people.extend_subtype (
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
CREATE INDEX extend_subtype_tenant_type_subtype_idx ON people.extend_subtype (tenant_id, type, subtype);
ALTER TABLE people.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE people.extend_set (
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
CREATE INDEX extend_set_tenant_subtypeid_idx ON people.extend_set (tenant_id, subtypeid);
ALTER TABLE people.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE people.extend_attribute (
  tenant_id uuid NOT NULL,
  -- Legacy IDENTITY value; no sequence, because only migration apply writes this table.
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
CREATE INDEX extend_attribute_tenant_extendsetid_idx ON people.extend_attribute (tenant_id, extendsetid);
ALTER TABLE people.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ORM catalog column order of tclassextendrcsets; the ORM declares name required, so it is NOT NULL.
CREATE TABLE people.extend_rc_set (
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
ALTER TABLE people.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
