-- People-owned person data: tusers person columns of Type=2 rows and the user-owned rows of the split child tables.
-- Table names are the people unit ids in opt2/table-ownership.json; columns follow the live legacy catalog order and nullability.
CREATE TABLE people.person (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  groupname text,
  fname text,
  lname text,
  email text,
  company text,
  jobtitle text,
  mobilephone text,
  website text,
  subtype text,
  ext integer,
  contactform text,
  lastupdate timestamp(3) without time zone,
  lastupdateby text,
  lastupdatebyid text,
  -- Join key copied from the account split; identity.user_account owns it.
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
  tags text,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, userid)
);
CREATE INDEX person_tenant_lname_fname_idx ON people.person (tenant_id, lname, fname);
CREATE INDEX person_tenant_lower_email_idx ON people.person (tenant_id, lower(email));
ALTER TABLE people.person ENABLE ROW LEVEL SECURITY; ALTER TABLE people.person FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.person
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE people.user_address (
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
CREATE INDEX user_address_tenant_userid_idx ON people.user_address (tenant_id, userid);
ALTER TABLE people.user_address ENABLE ROW LEVEL SECURITY; ALTER TABLE people.user_address FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.user_address
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE people.user_interest (
  tenant_id uuid NOT NULL,
  userid char(35) NOT NULL,
  categoryid char(35) NOT NULL,
  PRIMARY KEY (tenant_id, userid, categoryid)
);
ALTER TABLE people.user_interest ENABLE ROW LEVEL SECURITY; ALTER TABLE people.user_interest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.user_interest
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE people.user_tag (
  tenant_id uuid NOT NULL,
  tagid integer NOT NULL,
  userid char(35),
  siteid text,
  tag text,
  PRIMARY KEY (tenant_id, tagid)
);
CREATE INDEX user_tag_tenant_userid_idx ON people.user_tag (tenant_id, userid);
ALTER TABLE people.user_tag ENABLE ROW LEVEL SECURITY; ALTER TABLE people.user_tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.user_tag
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- The tagid and dataid sequences issue target ids; migration apply keeps each above the max id of the whole legacy table.
CREATE SEQUENCE people.user_tag_tagid_seq AS integer OWNED BY people.user_tag.tagid;

CREATE TABLE people.user_favorite (
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
CREATE INDEX user_favorite_tenant_userid_idx ON people.user_favorite (tenant_id, userid);
ALTER TABLE people.user_favorite ENABLE ROW LEVEL SECURITY; ALTER TABLE people.user_favorite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.user_favorite
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Extended data of Type=2 users and of their addresses, whose rows carry the address id as baseid.
CREATE TABLE people.extend_data_user_activity (
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
CREATE INDEX extend_data_user_activity_tenant_baseid_idx ON people.extend_data_user_activity (tenant_id, baseid);
CREATE INDEX extend_data_user_activity_tenant_attributeid_idx ON people.extend_data_user_activity (tenant_id, attributeid);
ALTER TABLE people.extend_data_user_activity ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_data_user_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_data_user_activity
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE SEQUENCE people.extend_data_user_activity_dataid_seq AS integer OWNED BY people.extend_data_user_activity.dataid;

-- tclassextenddata rows of tusers subtypes; Masa saves user and address data to extend_data_user_activity, so no sequence.
CREATE TABLE people.extend_data (
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
CREATE INDEX extend_data_tenant_baseid_idx ON people.extend_data (tenant_id, baseid);
CREATE INDEX extend_data_tenant_attributeid_idx ON people.extend_data (tenant_id, attributeid);
ALTER TABLE people.extend_data ENABLE ROW LEVEL SECURITY; ALTER TABLE people.extend_data FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.extend_data
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ttrash rows whose objectClass split share is people's (Type=2 users, their addresses, user extensions); objectstring is byte-exact WDDX.
CREATE TABLE people.trash (
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
CREATE INDEX trash_tenant_deleteid_idx ON people.trash (tenant_id, deleteid);
CREATE INDEX trash_tenant_deleteddate_idx ON people.trash (tenant_id, deleteddate);
ALTER TABLE people.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE people.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON people.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
