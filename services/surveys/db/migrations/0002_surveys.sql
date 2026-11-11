-- SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Surveys owned by a site.
CREATE TABLE surveys.survey (
  tenant_id uuid NOT NULL,
  survey_id char(35) NOT NULL,
  siteid varchar(25) NOT NULL,
  title varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  created timestamp(3) without time zone NOT NULL,
  createdbyid char(35) NOT NULL,
  lastupdate timestamp(3) without time zone NULL,
  lastupdatebyid char(35) NULL,
  launched_at timestamp(3) without time zone NULL,
  PRIMARY KEY (tenant_id, survey_id)
);
ALTER TABLE surveys.survey ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.survey FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.survey
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX survey_site_idx ON surveys.survey (tenant_id, siteid);

-- Launch schedule of a survey, at most one per survey; row_version is its scheduled event's aggregate version.
CREATE TABLE surveys.survey_schedule (
  tenant_id uuid NOT NULL,
  schedule_id char(35) NOT NULL,
  survey_id char(35) NOT NULL,
  launch_at timestamp(3) without time zone NOT NULL,
  schedule_version integer NOT NULL,
  task_name varchar(100) NOT NULL,
  task_token_hash char(64) NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  row_version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, schedule_id),
  UNIQUE (tenant_id, survey_id)
);
ALTER TABLE surveys.survey_schedule ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.survey_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.survey_schedule
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Reminder tasks of a scheduled survey.
CREATE TABLE surveys.survey_reminder (
  tenant_id uuid NOT NULL,
  reminder_id char(35) NOT NULL,
  survey_id char(35) NOT NULL,
  offset_minutes integer NOT NULL,
  remind_at timestamp(3) without time zone NOT NULL,
  task_name varchar(100) NOT NULL,
  task_token_hash char(64) NOT NULL,
  sent_at timestamp(3) without time zone NULL,
  PRIMARY KEY (tenant_id, reminder_id)
);
ALTER TABLE surveys.survey_reminder ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.survey_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.survey_reminder
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX survey_reminder_survey_idx ON surveys.survey_reminder (tenant_id, survey_id);

-- Sites, and optionally groups within them, that a survey targets; a NULL group_name is one distinct value, as in SQL Server.
CREATE TABLE surveys.survey_target (
  tenant_id uuid NOT NULL,
  target_id char(35) NOT NULL,
  survey_id char(35) NOT NULL,
  siteid varchar(25) NOT NULL,
  group_name varchar(255) NULL,
  created timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, target_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, survey_id, siteid, group_name)
);
ALTER TABLE surveys.survey_target ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.survey_target FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.survey_target
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Survey responses, kept under the survey site with the respondent site alongside; answers is byte-exact text.
CREATE TABLE surveys.survey_response (
  tenant_id uuid NOT NULL,
  response_id char(35) NOT NULL,
  survey_id char(35) NOT NULL,
  siteid varchar(25) NOT NULL,
  respondentsiteid varchar(25) NOT NULL,
  respondent_user_id char(35) NOT NULL,
  answers text NOT NULL,
  created timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, response_id)
);
ALTER TABLE surveys.survey_response ENABLE ROW LEVEL SECURITY; ALTER TABLE surveys.survey_response FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON surveys.survey_response
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX survey_response_survey_idx ON surveys.survey_response (tenant_id, survey_id);
