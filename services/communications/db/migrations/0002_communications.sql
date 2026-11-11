-- SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
-- synthetic.message_template: reusable subject and body templates.
CREATE TABLE communications.message_template (
  tenant_id uuid NOT NULL,
  template_id char(35) NOT NULL,
  siteid text NOT NULL,
  name text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  lastupdate timestamp(3) without time zone NULL,
  PRIMARY KEY (tenant_id, template_id)
);
ALTER TABLE communications.message_template ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.message_template FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.message_template
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Site list order. Under RLS the non-leakproof lower(rtrim(siteid)) match can only filter it, never bound the scan; the statistics estimate that filter.
CREATE INDEX message_template_site_created_idx ON communications.message_template (tenant_id, created, template_id) INCLUDE (siteid);
CREATE STATISTICS communications.message_template_site_stat ON (lower(rtrim(siteid))) FROM communications.message_template;

-- synthetic.message: outbound messages; source, event_id and row_version are target-only.
CREATE TABLE communications.message (
  tenant_id uuid NOT NULL,
  message_id char(35) NOT NULL,
  siteid text NOT NULL,
  template_id char(35) NULL,
  to_address text NOT NULL,
  from_address text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  created timestamp(3) without time zone NOT NULL,
  sent_at timestamp(3) without time zone NULL,
  source text NOT NULL DEFAULT 'send' CHECK (source IN ('send','login-mail')),
  event_id uuid NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, message_id),
  UNIQUE (tenant_id, event_id)
);
ALTER TABLE communications.message ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.message
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Site list order, as for message_template.
CREATE INDEX message_site_created_idx ON communications.message (tenant_id, created, message_id) INCLUDE (siteid);
CREATE STATISTICS communications.message_site_stat ON (lower(rtrim(siteid))) FROM communications.message;
-- Login-mail recovery batches.
CREATE INDEX message_login_mail_queued_idx ON communications.message (tenant_id, created, message_id) WHERE source = 'login-mail' AND state = 'queued';

-- synthetic.delivery_status: append-only delivery history per message; source is target-only.
CREATE TABLE communications.delivery_status (
  tenant_id uuid NOT NULL,
  status_id char(35) NOT NULL,
  message_id char(35) NOT NULL,
  status text NOT NULL,
  detail text NULL,
  mailpit_id text NULL,
  recorded_at timestamp(3) without time zone NOT NULL,
  source text NOT NULL DEFAULT 'send' CHECK (source IN ('send','login-mail')),
  PRIMARY KEY (tenant_id, status_id)
);
ALTER TABLE communications.delivery_status ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.delivery_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.delivery_status
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX delivery_status_message_idx ON communications.delivery_status (tenant_id, message_id, recorded_at, status_id);

-- Survey launch and reminder tasks, from survey.scheduled events or adopted ACF tasks; no legacy table.
CREATE TABLE communications.scheduled_task (
  tenant_id uuid NOT NULL,
  scheduled_task_id char(35) NOT NULL,
  task_name text NOT NULL,
  queue text NOT NULL,
  queue_task_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('survey-launch','survey-reminder')),
  source_type text NOT NULL,
  source_id char(35) NOT NULL,
  reminder_n integer NULL,
  schedule_time timestamp(3) without time zone NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','done','superseded','cancelled')),
  target_route text NOT NULL,
  schedule_version integer NOT NULL,
  origin text NOT NULL,
  enqueued_at timestamp(3) without time zone NULL,
  dequeued_at timestamp(3) without time zone NULL,
  created_at timestamp(3) without time zone NOT NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, scheduled_task_id),
  UNIQUE (tenant_id, queue, queue_task_name)
);
ALTER TABLE communications.scheduled_task ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.scheduled_task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.scheduled_task
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX scheduled_task_source_idx ON communications.scheduled_task (tenant_id, source_type, source_id);
-- Stamp recovery batches.
CREATE INDEX scheduled_task_unstamped_idx ON communications.scheduled_task (tenant_id, created_at, scheduled_task_id)
  WHERE (status = 'scheduled' AND enqueued_at IS NULL) OR (status IN ('superseded', 'cancelled') AND dequeued_at IS NULL);
-- Adopted-task batches.
CREATE INDEX scheduled_task_adopted_idx ON communications.scheduled_task (tenant_id, created_at, scheduled_task_id) WHERE origin = 'adopted' AND status = 'scheduled';
-- One adopted row per ACF task name.
CREATE UNIQUE INDEX scheduled_task_adopted_name_key ON communications.scheduled_task (tenant_id, task_name) WHERE origin = 'adopted';

-- temails (mapping-only; cemail is legacy-served).
CREATE TABLE communications.email (
  tenant_id uuid NOT NULL,
  emailid char(35) NOT NULL,
  siteid text NULL,
  subject text NULL,
  bodytext text NULL,
  bodyhtml text NULL,
  createddate timestamp(3) without time zone NULL,
  deliverydate timestamp(3) without time zone NULL,
  status smallint NULL,
  grouplist text NULL,
  lastupdateby text NULL,
  lastupdatebyid text NULL,
  numbersent integer NOT NULL,
  replyto text NULL,
  format text NULL,
  fromlabel text NULL,
  isdeleted smallint NOT NULL,
  template text NULL,
  PRIMARY KEY (tenant_id, emailid)
);
ALTER TABLE communications.email ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.email FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.email
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- temailstats (mapping-only, keyless).
CREATE TABLE communications.email_stat (
  tenant_id uuid NOT NULL,
  emailid char(35) NULL,
  email text NULL,
  emailopen integer NOT NULL,
  returnclick integer NOT NULL,
  bounce integer NOT NULL,
  sent integer NOT NULL,
  created timestamp(3) without time zone NULL,
  legacy_row_hash text NOT NULL,
  occurrence integer NOT NULL,
  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)
);
ALTER TABLE communications.email_stat ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.email_stat FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.email_stat
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- temailreturnstats (mapping-only, keyless).
CREATE TABLE communications.email_return_stat (
  tenant_id uuid NOT NULL,
  emailid char(35) NULL,
  email text NULL,
  url text NULL,
  created timestamp(3) without time zone NULL,
  legacy_row_hash text NOT NULL,
  occurrence integer NOT NULL,
  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)
);
ALTER TABLE communications.email_return_stat ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.email_return_stat FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.email_return_stat
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tmailinglist (mapping-only, keyless; cmailinglist is legacy-served).
CREATE TABLE communications.mailing_list (
  tenant_id uuid NOT NULL,
  mlid char(35) NULL,
  siteid text NULL,
  name text NULL,
  description text NULL,
  lastupdate timestamp(3) without time zone NULL,
  ispurge integer NULL,
  ispublic integer NULL,
  legacy_row_hash text NOT NULL,
  occurrence integer NOT NULL,
  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)
);
ALTER TABLE communications.mailing_list ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.mailing_list FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.mailing_list
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- tmailinglistmembers (mapping-only, keyless).
CREATE TABLE communications.mailing_list_member (
  tenant_id uuid NOT NULL,
  mlid char(35) NULL,
  email text NULL,
  siteid text NULL,
  fname text NULL,
  lname text NULL,
  company text NULL,
  isverified smallint NOT NULL,
  created timestamp(3) without time zone NULL,
  legacy_row_hash text NOT NULL,
  occurrence integer NOT NULL,
  PRIMARY KEY (tenant_id, legacy_row_hash, occurrence)
);
ALTER TABLE communications.mailing_list_member ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.mailing_list_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.mailing_list_member
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ttrash rows of objectClass email and mailinglist, this service's split share (mapping-only); objectstring is byte-exact WDDX.
CREATE TABLE communications.trash (
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
ALTER TABLE communications.trash ENABLE ROW LEVEL SECURITY; ALTER TABLE communications.trash FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON communications.trash
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
