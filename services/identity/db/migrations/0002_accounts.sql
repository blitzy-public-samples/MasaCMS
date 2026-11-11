-- Identity-owned account, group, membership and permission tables mapped from legacy tusers and its child tables.
-- Table names are the identity unit ids in opt2/table-ownership.json; columns follow the live legacy catalog order and nullability.
CREATE TABLE identity.group_account (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  groupname text,
  fname text,
  lname text,
  username text,
  password text,
  passwordcreated timestamp(3) without time zone,
  email text,
  company text,
  jobtitle text,
  mobilephone text,
  website text,
  type integer,
  subtype text,
  ext integer,
  contactform text,
  admin integer,
  s2 integer,
  lastlogin timestamp(3) without time zone,
  lastupdate timestamp(3) without time zone,
  lastupdateby text,
  lastupdatebyid text,
  perm smallint,
  inactive smallint,
  ispublic integer,
  siteid text,
  subscribe integer,
  notes text,
  description text,
  interests text,
  keepprivate smallint,
  photofileid char(35),
  imname text,
  imservice text,
  created timestamp(3) without time zone,
  remoteid text,
  tags text,
  tablist text,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.group_account ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.group_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.group_account
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- No unique index on username: legacy enforces uniqueness in code, and live data may hold duplicates.
CREATE TABLE identity.user_account (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  username text,
  type integer,
  admin integer,
  s2 integer,
  perm smallint,
  inactive smallint,
  ispublic integer,
  siteid text,
  remoteid text,
  tablist text,
  -- 'pending' while a roster create is prepared but not committed; such accounts cannot log in and are not listed.
  opt2_state text NOT NULL DEFAULT 'active' CHECK (opt2_state IN ('active','pending')),
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.user_account ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_account
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.credential (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  password text,
  passwordcreated timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.credential ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.credential FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.credential
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.login_state (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  lastlogin timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.login_state ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.login_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.login_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.membership (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  groupid char(35) NOT NULL,
  PRIMARY KEY (tenant_id, userid, groupid)
);
ALTER TABLE identity.membership ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.membership
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX membership_tenant_groupid_idx ON identity.membership (tenant_id, groupid);

CREATE TABLE identity.permission (
  tenant_id uuid NOT NULL,
  contentid char(35) NOT NULL,
  groupid char(35) NOT NULL,
  siteid text NOT NULL,
  type text NOT NULL,
  PRIMARY KEY (tenant_id, contentid, groupid, siteid, type)
);
ALTER TABLE identity.permission ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.permission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.permission
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.user_address (
  tenant_id uuid NOT NULL,
  addressid char(35) NOT NULL,
  userid char(35),
  siteid text,
  addressname text,
  address1 text,
  address2 text,
  city text,
  state text,
  zip text,
  country text,
  phone text,
  fax text,
  isprimary smallint,
  addressnotes text,
  addressurl text,
  longitude double precision,
  latitude double precision,
  addressemail text,
  hours text,
  PRIMARY KEY (tenant_id, addressid)
);
ALTER TABLE identity.user_address ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_address FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_address
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.user_interest (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  categoryid char(35) NOT NULL,
  PRIMARY KEY (tenant_id, userid, categoryid)
);
ALTER TABLE identity.user_interest ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_interest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_interest
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.user_tag (
  tenant_id uuid NOT NULL,
  -- Legacy IDENTITY value, copied as is; target-created ids come from the sequence in 0005_child_id_sequences.sql.
  tagid integer NOT NULL,
  userid char(35),
  siteid text,
  tag text,
  PRIMARY KEY (tenant_id, tagid)
);
ALTER TABLE identity.user_tag ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_tag
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.user_favorite (
  tenant_id uuid NOT NULL,
  favoriteid char(35) NOT NULL,
  userid char(35) NOT NULL,
  favoritename text,
  favorite text NOT NULL,
  type text NOT NULL,
  siteid text,
  datecreated timestamp(3) without time zone NOT NULL,
  columnnumber integer,
  rownumber integer,
  maxrssitems integer,
  PRIMARY KEY (tenant_id, favoriteid)
);
ALTER TABLE identity.user_favorite ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_favorite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_favorite
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.extend_data_user_activity (
  tenant_id uuid NOT NULL,
  -- Legacy IDENTITY value, copied as is; target-created ids come from the sequence in 0005_child_id_sequences.sql.
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
ALTER TABLE identity.extend_data_user_activity ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.extend_data_user_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.extend_data_user_activity
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
