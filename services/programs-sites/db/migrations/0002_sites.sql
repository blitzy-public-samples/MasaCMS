-- programs-sites owned site tables
-- Columns follow the live legacy catalog order and nullability; one table per programs-sites unit in opt2/table-ownership.json.
CREATE TABLE programs_sites.site (
  tenant_id uuid NOT NULL,
  siteid text NOT NULL,
  site text,
  maxnestlevel integer,
  pagelimit integer,
  locking text,
  domain text,
  exportlocation text,
  filedir text,
  contact text,
  mailserverip text,
  mailserverusername text,
  mailserverpassword text,
  emailbroadcaster integer,
  extranet integer,
  extranetpublicreg integer,
  extranetpublicregnotify text,
  extranetssl integer,
  cache integer,
  viewdepth integer,
  nextn integer,
  datacollection integer,
  columncount integer,
  columnnames text,
  primarycolumn integer,
  publicsubmission integer,
  archivedate timestamp(3) without time zone,
  contactname text,
  contactaddress text,
  contactcity text,
  contactstate text,
  contactzip text,
  contactemail text,
  contactphone text,
  privateuserpoolid text,
  publicuserpoolid text,
  orderno integer,
  emailbroadcasterlimit integer NOT NULL,
  feedmanager integer,
  displaypoolid text,
  gallerymainscaleby text,
  gallerymainscale integer,
  gallerysmallscaleby text,
  gallerysmallscale integer,
  gallerymediumscaleby text,
  gallerymediumscale integer,
  sendloginscript text,
  mailinglistconfirmscript text,
  publicsubmissionapprovalscript text,
  reminderscript text,
  loginurl text,
  editprofileurl text,
  commentapprovaldefault smallint,
  deploy smallint,
  lastdeployment timestamp(3) without time zone,
  accountactivationscript text,
  googleapikey text,
  usedefaultsmtpserver smallint,
  theme text,
  mailserversmtpport text,
  mailserverpopport text,
  mailservertls text,
  mailserverssl text,
  sitelocale text,
  domainalias text,
  cachecapacity integer,
  cachefreememorythreshold integer,
  tagline text,
  haschangesets smallint,
  baseid char(35),
  enforceprimarydomain smallint,
  enforcechangesets smallint,
  smallimageheight text,
  smallimagewidth text,
  mediumimageheight text,
  mediumimagewidth text,
  largeimageheight text,
  largeimagewidth text,
  contentapprovalscript text,
  contentrejectionscript text,
  hascomments integer,
  haslockablenodes integer,
  enablelockdown text,
  customtaggroups text,
  filepoolid text,
  categorypoolid text,
  contentpoolid text,
  sendauthcodescript text,
  recaptchasitekey text,
  recaptchasecret text,
  recaptchalanguage text,
  jsonapi integer,
  usessl integer,
  isremote integer,
  resourcessl integer,
  resourcedomain text,
  remoteport integer,
  remotecontext text,
  contentpendingscript text,
  contentcanceledscript text,
  showdashboard integer,
  placeholderimgid text,
  placeholderimgext text,
  scaffolding integer,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, siteid)
);
ALTER TABLE programs_sites.site ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.site FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.site
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE programs_sites.image_size (
  tenant_id uuid NOT NULL,
  sizeid char(35) NOT NULL,
  siteid text,
  name text,
  height text,
  width text,
  PRIMARY KEY (tenant_id, sizeid)
);
ALTER TABLE programs_sites.image_size ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.image_size FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.image_size
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX image_size_tenant_siteid_idx ON programs_sites.image_size (tenant_id, siteid);

CREATE TABLE programs_sites.directory (
  tenant_id uuid NOT NULL,
  dirid char(35) NOT NULL,
  siteid text,
  subdir text,
  editfilename text,
  PRIMARY KEY (tenant_id, dirid)
);
ALTER TABLE programs_sites.directory ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.directory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.directory
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX directory_tenant_siteid_idx ON programs_sites.directory (tenant_id, siteid);

CREATE TABLE programs_sites.system_object (
  tenant_id uuid NOT NULL,
  object text,
  siteid text,
  name text,
  orderno integer,
  legacy_row_hash char(64) NOT NULL,
  occurrence integer NOT NULL,
  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)
);
ALTER TABLE programs_sites.system_object ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.system_object FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.system_object
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX system_object_tenant_siteid_idx ON programs_sites.system_object (tenant_id, siteid);

CREATE TABLE programs_sites.extend_data (
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
ALTER TABLE programs_sites.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX extend_data_tenant_baseid_idx ON programs_sites.extend_data (tenant_id, baseid);

CREATE TABLE programs_sites.extend_subtype (
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
ALTER TABLE programs_sites.extend_subtype ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.extend_subtype FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.extend_subtype
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE programs_sites.extend_set (
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
ALTER TABLE programs_sites.extend_set ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.extend_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.extend_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE programs_sites.extend_attribute (
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
ALTER TABLE programs_sites.extend_attribute ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.extend_attribute FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.extend_attribute
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE programs_sites.extend_rc_set (
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
ALTER TABLE programs_sites.extend_rc_set ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.extend_rc_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.extend_rc_set
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE programs_sites.trash (
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
ALTER TABLE programs_sites.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE programs_sites.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON programs_sites.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
