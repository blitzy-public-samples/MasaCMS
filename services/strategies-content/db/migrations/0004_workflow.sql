-- strategies-content approval chain and change set tables, one per unit; columns, nullability and constant defaults follow the live legacy catalog, with nvarchar mapped to text by the canonical type map.
CREATE TABLE content.approval_chain (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  chainid char(35) NOT NULL DEFAULT '',
  name text,
  created timestamp(3) without time zone,
  lastupdate timestamp(3) without time zone,
  description text,
  lastupdateby text,
  lastupdatebyid char(35),
  PRIMARY KEY (tenant_id, chainid)
);
ALTER TABLE content.approval_chain ENABLE ROW LEVEL SECURITY; ALTER TABLE content.approval_chain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.approval_chain
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.approval_membership (
  tenant_id uuid NOT NULL,
  groupid char(35) DEFAULT '',
  siteid text DEFAULT '',
  created timestamp(3) without time zone,
  orderno integer DEFAULT 1,
  membershipid char(35) NOT NULL DEFAULT '',
  chainid char(35) DEFAULT '',
  PRIMARY KEY (tenant_id, membershipid)
);
ALTER TABLE content.approval_membership ENABLE ROW LEVEL SECURITY; ALTER TABLE content.approval_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.approval_membership
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.approval_assignment (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  assignmentid char(35) NOT NULL DEFAULT '',
  contentid char(35) DEFAULT '',
  exemptid text,
  chainid char(35) DEFAULT '',
  PRIMARY KEY (tenant_id, assignmentid)
);
ALTER TABLE content.approval_assignment ENABLE ROW LEVEL SECURITY; ALTER TABLE content.approval_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.approval_assignment
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.approval_request (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  userid char(35) DEFAULT '',
  groupid char(35) DEFAULT '',
  created timestamp(3) without time zone,
  status text DEFAULT 'Pending',
  contenthistid char(35) DEFAULT '',
  requestid char(35) NOT NULL DEFAULT '',
  chainid char(35) DEFAULT '',
  PRIMARY KEY (tenant_id, requestid)
);
ALTER TABLE content.approval_request ENABLE ROW LEVEL SECURITY; ALTER TABLE content.approval_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.approval_request
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX approval_request_tenant_id_contenthistid_idx ON content.approval_request (tenant_id, contenthistid);

CREATE TABLE content.approval_action (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  actiontype text DEFAULT '',
  comments text,
  userid char(35) DEFAULT '',
  groupid char(35) DEFAULT '',
  created timestamp(3) without time zone,
  actiontid char(35) NOT NULL DEFAULT '',
  requestid char(35) DEFAULT '',
  parentid char(35) DEFAULT '',
  chainid char(35) DEFAULT '',
  PRIMARY KEY (tenant_id, actiontid)
);
ALTER TABLE content.approval_action ENABLE ROW LEVEL SECURITY; ALTER TABLE content.approval_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.approval_action
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.changeset (
  tenant_id uuid NOT NULL,
  changesetid char(35) NOT NULL,
  siteid text,
  name text,
  description text,
  created timestamp(3) without time zone,
  publishdate timestamp(3) without time zone,
  published smallint,
  lastupdate timestamp(3) without time zone,
  lastupdateby text,
  lastupdatebyid char(35),
  remoteid text,
  remotepubdate timestamp(3) without time zone,
  remotesourceurl text,
  closedate timestamp(3) without time zone,
  PRIMARY KEY (tenant_id, changesetid)
);
ALTER TABLE content.changeset ENABLE ROW LEVEL SECURITY; ALTER TABLE content.changeset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.changeset
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX changeset_tenant_id_publishdate_idx ON content.changeset (tenant_id, publishdate);

CREATE TABLE content.changeset_rollback (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  rollbackid char(35) NOT NULL DEFAULT '',
  changesetid char(35) DEFAULT '',
  previoushistid char(35) DEFAULT '',
  changesethistid char(35) DEFAULT '',
  PRIMARY KEY (tenant_id, rollbackid)
);
ALTER TABLE content.changeset_rollback ENABLE ROW LEVEL SECURITY; ALTER TABLE content.changeset_rollback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.changeset_rollback
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.changeset_category_assign (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  categoryid char(35) DEFAULT '',
  changesetid char(35) DEFAULT '',
  assignmentid char(35) NOT NULL DEFAULT '',
  PRIMARY KEY (tenant_id, assignmentid)
);
ALTER TABLE content.changeset_category_assign ENABLE ROW LEVEL SECURITY; ALTER TABLE content.changeset_category_assign FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.changeset_category_assign
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE content.changeset_tag_assign (
  tenant_id uuid NOT NULL,
  siteid text DEFAULT '',
  changesetid char(35) DEFAULT '',
  assignmentid char(35) NOT NULL DEFAULT '',
  tag text,
  PRIMARY KEY (tenant_id, assignmentid)
);
ALTER TABLE content.changeset_tag_assign ENABLE ROW LEVEL SECURITY; ALTER TABLE content.changeset_tag_assign FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.changeset_tag_assign
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
