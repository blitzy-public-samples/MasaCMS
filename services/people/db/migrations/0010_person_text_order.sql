-- Case-insensitive, accent-sensitive text order as SQL_Latin1_General_CP1_CI_AS sorts names.
CREATE COLLATION IF NOT EXISTS people.legacy_text_order (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
-- The person name order under legacy_text_order: trailing-space-blind last then first name, NULLs first, then userid.
CREATE INDEX person_tenant_text_name_order_idx ON people.person (
  tenant_id,
  (rtrim(lname)) COLLATE people.legacy_text_order NULLS FIRST,
  (rtrim(fname)) COLLATE people.legacy_text_order NULLS FIRST,
  (rtrim(userid)) COLLATE people.legacy_text_order NULLS FIRST,
  userid
);
