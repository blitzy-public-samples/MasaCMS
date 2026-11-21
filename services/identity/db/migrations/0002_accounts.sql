-- Identity-owned account, group, membership and permission tables mapped from legacy tusers and its child tables.
-- Table names are the identity unit ids in opt2/table-ownership.json; columns follow the live legacy catalog order and nullability.
-- SQL Server SQL_Latin1_General_CP1_CI_AS equality over the CP1252 values legacy binds: legacy_ci for nvarchar, legacy_char_ci for char/varchar.
CREATE COLLATION identity.legacy_ci (provider = icu, locale = 'und', deterministic = false, rules = E'&a=A&b=B&c=C&d=D&e=E&f=F&g=G&h=H&i=I&j=J&k=K&l=L&m=M&n=N&o=O&p=P&q=Q&r=R&s=S&t=T&u=U&v=V&w=W&x=X&y=Y&z=Z&\u00E0=\u00C0&\u00E1=\u00C1&\u00E2=\u00C2&\u00E3=\u00C3&\u00E4=\u00C4&\u00E5=\u00C5&\u00E7=\u00C7&\u00E8=\u00C8&\u00E9=\u00C9&\u00EA=\u00CA&\u00EB=\u00CB&\u00EC=\u00CC&\u00ED=\u00CD&\u00EE=\u00CE&\u00EF=\u00CF&\u00F0=\u00D0&\u00F1=\u00D1&\u00F2=\u00D2&\u00F3=\u00D3&\u00F4=\u00D4&\u00F5=\u00D5&\u00F6=\u00D6&\u00F8=\u00D8&\u00F9=\u00D9&\u00FA=\u00DA&\u00FB=\u00DB&\u00FC=\u00DC&\u00FD=\u00DD&\u0161=\u0160&\u017E=\u017D&\u00FF=\u0178&1=\u00B9&2=\u00B2&3=\u00B3&ae=\u00E6=\u00C6&oe=\u0153=\u0152&ss=\u00DF&th=\u00FE=\u00DE&\'\u0009\'<\u0001<\u0002<\u0003<\u0004<\u0005<\u0006<\u0007<\u0008<\u000E<\u000F<\u0010<\u0011<\u0012<\u0013<\u0014<\u0015<\u0016<\u0017<\u0018<\u0019<\u001A<\u001B<\u001C<\u001D<\u001E<\u001F<\u007F<\u00AD');
CREATE COLLATION identity.legacy_char_ci (provider = icu, locale = 'und', deterministic = false, rules = E'&a=A&b=B&c=C&d=D&e=E&f=F&g=G&h=H&i=I&j=J&k=K&l=L&m=M&n=N&o=O&p=P&q=Q&r=R&s=S&t=T&u=U&v=V&w=W&x=X&y=Y&z=Z&\u00E0=\u00C0&\u00E1=\u00C1&\u00E2=\u00C2&\u00E3=\u00C3&\u00E4=\u00C4&\u00E5=\u00C5&\u00E6=\u00C6&\u00E7=\u00C7&\u00E8=\u00C8&\u00E9=\u00C9&\u00EA=\u00CA&\u00EB=\u00CB&\u00EC=\u00CC&\u00ED=\u00CD&\u00EE=\u00CE&\u00EF=\u00CF&\u00F0=\u00D0&\u00F1=\u00D1&\u00F2=\u00D2&\u00F3=\u00D3&\u00F4=\u00D4&\u00F5=\u00D5&\u00F6=\u00D6&\u00F8=\u00D8&\u00F9=\u00D9&\u00FA=\u00DA&\u00FB=\u00DB&\u00FC=\u00DC&\u00FD=\u00DD&\u00FE=\u00DE&\u0161<<<\u0160&\u017E<<<\u017D&\u00FF<<<\u0178&\'\u0009\'<\u0001<\u0002<\u0003<\u0004<\u0005<\u0006<\u0007<\u0008<\u000E<\u000F<\u0010<\u0011<\u0012<\u0013<\u0014<\u0015<\u0016<\u0017<\u0018<\u0019<\u001A<\u001B<\u001C<\u001D<\u001E<\u001F<\u007F<\u00AD');
CREATE TABLE identity.group_account (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
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
  siteid text COLLATE identity.legacy_ci,
  subscribe integer,
  notes text,
  description text,
  interests text,
  keepprivate smallint,
  photofileid char(35) COLLATE identity.legacy_char_ci,
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
-- Name lookups compare (name::bpchar COLLATE legacy_ci), which is leakproof and so indexable under forced RLS; lower() is not.
CREATE INDEX group_account_tenant_groupname_idx ON identity.group_account (tenant_id, ((groupname::bpchar) COLLATE identity.legacy_ci), siteid);
CREATE INDEX group_account_tenant_siteid_ispublic_idx ON identity.group_account (tenant_id, siteid, ispublic, lower(groupname) NULLS FIRST, userid);

-- No unique index on username: legacy enforces uniqueness in code, and live data may hold duplicates.
CREATE TABLE identity.user_account (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  username text,
  type integer,
  admin integer,
  s2 integer,
  perm smallint,
  inactive smallint,
  ispublic integer,
  siteid text COLLATE identity.legacy_ci,
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
CREATE INDEX user_account_tenant_username_idx ON identity.user_account (tenant_id, ((username::bpchar) COLLATE identity.legacy_ci), userid);

CREATE TABLE identity.credential (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
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
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  lastlogin timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.login_state ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.login_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.login_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.membership (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  groupid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  PRIMARY KEY (tenant_id, userid, groupid)
);
ALTER TABLE identity.membership ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.membership
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX membership_tenant_groupid_idx ON identity.membership (tenant_id, groupid);

CREATE TABLE identity.permission (
  tenant_id uuid NOT NULL,
  contentid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  groupid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  siteid text COLLATE identity.legacy_ci NOT NULL,
  type text COLLATE identity.legacy_ci NOT NULL,
  PRIMARY KEY (tenant_id, contentid, groupid, siteid, type)
);
ALTER TABLE identity.permission ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.permission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.permission
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX permission_tenant_groupid_idx ON identity.permission (tenant_id, groupid, siteid, type);

CREATE TABLE identity.user_address (
  tenant_id uuid NOT NULL,
  addressid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci,
  siteid text COLLATE identity.legacy_ci,
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
CREATE INDEX user_address_tenant_userid_idx ON identity.user_address (tenant_id, userid);

CREATE TABLE identity.user_interest (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  categoryid char(35) COLLATE identity.legacy_char_ci NOT NULL,
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
  userid char(35) COLLATE identity.legacy_char_ci,
  siteid text COLLATE identity.legacy_char_ci,
  tag text,
  PRIMARY KEY (tenant_id, tagid)
);
ALTER TABLE identity.user_tag ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_tag
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX user_tag_tenant_userid_idx ON identity.user_tag (tenant_id, userid, tagid);

CREATE TABLE identity.user_favorite (
  tenant_id uuid NOT NULL,
  favoriteid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  favoritename text,
  favorite text NOT NULL,
  type text NOT NULL,
  siteid text COLLATE identity.legacy_char_ci,
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
CREATE INDEX user_favorite_tenant_userid_idx ON identity.user_favorite (tenant_id, userid, favoriteid);

CREATE TABLE identity.extend_data_user_activity (
  tenant_id uuid NOT NULL,
  -- Legacy IDENTITY value, copied as is; target-created ids come from the sequence in 0005_child_id_sequences.sql.
  dataid integer NOT NULL,
  baseid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  attributeid integer NOT NULL,
  siteid text COLLATE identity.legacy_ci,
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
CREATE INDEX extend_data_user_activity_tenant_baseid_idx ON identity.extend_data_user_activity (tenant_id, baseid, attributeid, dataid);
