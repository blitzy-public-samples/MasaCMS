-- Identity session, CSRF claim, roster account operation, person-contact projection and producer sequence tables.
-- Tenant is the account's (anonymous: nil system tenant); login_snapshot is the loginByQuery result fixed at login; jar_ref keys the gateway's cookie jar.
CREATE TABLE identity.session (
  tenant_id uuid NOT NULL,
  session_id text NOT NULL,
  user_id char(35),
  site_id text,
  -- JSON text, not jsonb: changelog images encode every column canonically as text, and pg returns jsonb as parsed objects.
  login_snapshot text,
  epoch bigint NOT NULL DEFAULT 0,
  csrf_secret char(35) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('legacy-primary','target-primary')),
  state text NOT NULL CHECK (state IN ('active','ended')),
  jar_ref text,
  created_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  ended_at timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (session_id)
);
ALTER TABLE identity.session ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.session
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Single-use CSRF token claims, in the owning session's tenant; the primary key lets exactly one concurrent claim win.
CREATE TABLE identity.csrf_claim (
  tenant_id uuid NOT NULL,
  session_id text NOT NULL,
  token text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending-legacy','used')),
  request_id text,
  claimed_at timestamp(3) without time zone NOT NULL,
  used_at timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, session_id, token)
);
ALTER TABLE identity.csrf_claim ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.csrf_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.csrf_claim
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX csrf_claim_claimed_at_idx ON identity.csrf_claim (claimed_at);

-- Account side of a roster operation; prepared and committed operations are open and keep the user closed.
CREATE TABLE identity.account_operation (
  tenant_id uuid NOT NULL,
  operation_id char(35) NOT NULL,
  user_id char(35) COLLATE identity.legacy_char_ci NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','update')),
  state text NOT NULL CHECK (state IN ('prepared','committed','aborted','reverted','finished')),
  username text,
  -- JSON text, as session.login_snapshot.
  pending_change text,
  before_values text,
  commit_xid xid8,
  created_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, operation_id)
);
ALTER TABLE identity.account_operation ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.account_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.account_operation
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE UNIQUE INDEX account_operation_open_user_idx ON identity.account_operation (tenant_id, user_id)
  WHERE state IN ('prepared','committed');
CREATE UNIQUE INDEX account_operation_open_username_idx ON identity.account_operation (tenant_id, ((username::bpchar) COLLATE identity.legacy_ci))
  WHERE state IN ('prepared','committed') AND username IS NOT NULL;

-- Projection of people.person.changed.v1 for mail and lookup by email.
CREATE TABLE identity.person_contact (
  tenant_id uuid NOT NULL,
  user_id char(35) COLLATE identity.legacy_char_ci NOT NULL,
  site_id text,
  email text,
  fname text,
  lname text,
  company text,
  subtype text,
  aggregate_version bigint NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE identity.person_contact ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.person_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.person_contact
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX person_contact_tenant_email_idx ON identity.person_contact (tenant_id, ((email::bpchar) COLLATE identity.legacy_ci), user_id);

-- Per-aggregate event sequence of identity's topics; it outlives a deleted group, so a recreated group continues it.
CREATE TABLE identity.aggregate_version (
  tenant_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, aggregate_type, aggregate_id)
);
ALTER TABLE identity.aggregate_version ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.aggregate_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.aggregate_version
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
