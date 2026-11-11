-- Identity-owned strike, remote-session, device, redirect, OAuth and trash tables mapped from their legacy tables.
-- Table names are the identity unit ids in opt2/table-ownership.json; columns follow the live legacy catalog order and nullability.
CREATE TABLE identity.user_strike (
  tenant_id uuid NOT NULL,
  username text COLLATE identity.legacy_ci NOT NULL,
  strikes integer,
  lastattempt timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, username)
);
ALTER TABLE identity.user_strike ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_strike FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_strike
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX user_strike_tenant_username_idx ON identity.user_strike (tenant_id, ((username::bpchar) COLLATE identity.legacy_ci));

CREATE TABLE identity.remote_session (
  tenant_id uuid NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  authtoken char(32) COLLATE identity.legacy_char_ci,
  data text,
  created timestamp(3) without time zone NOT NULL,
  lastaccessed timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, userid)
);
ALTER TABLE identity.remote_session ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.remote_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.remote_session
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX remote_session_authtoken_idx ON identity.remote_session (authtoken);

CREATE TABLE identity.user_device (
  tenant_id uuid NOT NULL,
  siteid text COLLATE identity.legacy_ci,
  created timestamp(3) without time zone,
  deviceid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  userid char(35) COLLATE identity.legacy_char_ci,
  lastlogin timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, deviceid)
);
ALTER TABLE identity.user_device ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_device FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.user_device
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.redirect (
  tenant_id uuid NOT NULL,
  redirectid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  url text,
  created timestamp(3) without time zone,
  userid char(35) COLLATE identity.legacy_char_ci,
  siteid text COLLATE identity.legacy_ci,
  PRIMARY KEY (tenant_id, redirectid)
);
ALTER TABLE identity.redirect ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.redirect FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.redirect
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX redirect_tenant_userid_idx ON identity.redirect (tenant_id, userid);

CREATE TABLE identity.oauth_client (
  tenant_id uuid NOT NULL,
  clientsecret text,
  siteid text COLLATE identity.legacy_ci NOT NULL,
  granttype text,
  userid char(35) COLLATE identity.legacy_char_ci,
  clientid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  name text NOT NULL,
  created timestamp(3) without time zone,
  lastupdate timestamp(3) without time zone,
  description text,
  redirecturl text,
  -- Legacy column name, misspelling included.
  lastupdatebidy text,
  lastupdateby text,
  PRIMARY KEY (tenant_id, clientid)
);
ALTER TABLE identity.oauth_client ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.oauth_client FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.oauth_client
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE identity.oauth_token (
  tenant_id uuid NOT NULL,
  granttype text COLLATE identity.legacy_ci,
  userid char(35) COLLATE identity.legacy_char_ci,
  clientid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  accesscode text COLLATE identity.legacy_ci,
  -- Serialized session document, stored byte-exact and never parsed.
  data text,
  expires timestamp(3) without time zone NOT NULL,
  token char(35) COLLATE identity.legacy_char_ci NOT NULL,
  PRIMARY KEY (tenant_id, token)
);
ALTER TABLE identity.oauth_token ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.oauth_token FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.oauth_token
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX oauth_token_accesscode_idx ON identity.oauth_token (accesscode);
CREATE INDEX oauth_token_tenant_clientid_idx ON identity.oauth_token (tenant_id, clientid);
CREATE INDEX oauth_token_tenant_userid_idx ON identity.oauth_token (tenant_id, userid);

-- ttrash rows of this service's objectClass split share (group and Type=1 objects); objectstring is byte-exact WDDX.
CREATE TABLE identity.trash (
  tenant_id uuid NOT NULL,
  objectid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  parentid char(35) COLLATE identity.legacy_char_ci NOT NULL,
  siteid text COLLATE identity.legacy_char_ci NOT NULL,
  objectlabel text NOT NULL,
  objectclass text NOT NULL,
  objecttype text NOT NULL,
  objectsubtype text NOT NULL,
  objectstring text,
  deleteddate timestamp(3) without time zone,
  deletedby text NOT NULL,
  deleteid char(35) COLLATE identity.legacy_char_ci,
  orderno integer,
  PRIMARY KEY (tenant_id, objectid)
);
ALTER TABLE identity.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
