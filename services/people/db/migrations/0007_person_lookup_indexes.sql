-- Case-insensitive id uniqueness and lookups under legacy_char_ci (SQL Server's char equality; char comparison ignores trailing spaces).
-- Index columns carry the collation, not lower() expressions: forced row security keeps non-leakproof functions of a column out of index conditions.
CREATE UNIQUE INDEX person_tenant_ci_userid_uidx ON people.person (tenant_id, userid COLLATE people.legacy_char_ci);
CREATE UNIQUE INDEX user_address_tenant_ci_addressid_uidx ON people.user_address (tenant_id, addressid COLLATE people.legacy_char_ci);
CREATE INDEX user_address_tenant_ci_userid_idx ON people.user_address (tenant_id, userid COLLATE people.legacy_char_ci);
CREATE UNIQUE INDEX user_interest_tenant_ci_key_uidx ON people.user_interest (tenant_id, userid COLLATE people.legacy_char_ci, categoryid COLLATE people.legacy_char_ci);
CREATE INDEX user_tag_tenant_ci_userid_idx ON people.user_tag (tenant_id, userid COLLATE people.legacy_char_ci);
CREATE INDEX user_favorite_tenant_ci_userid_idx ON people.user_favorite (tenant_id, userid COLLATE people.legacy_char_ci);
CREATE INDEX extend_data_user_activity_tenant_ci_baseid_idx ON people.extend_data_user_activity (tenant_id, baseid COLLATE people.legacy_char_ci);
CREATE UNIQUE INDEX trash_tenant_ci_objectid_uidx ON people.trash (tenant_id, objectid COLLATE people.legacy_char_ci);
CREATE INDEX extend_set_tenant_ci_subtypeid_idx ON people.extend_set (tenant_id, subtypeid COLLATE people.legacy_char_ci);
CREATE UNIQUE INDEX person_archive_tenant_ci_person_effective_uidx ON people.person_archive (tenant_id, person_id COLLATE people.legacy_char_ci, effective_from);
DROP INDEX people.roster_operation_open_user_uidx;
CREATE UNIQUE INDEX roster_operation_open_user_uidx ON people.roster_operation (user_id COLLATE people.legacy_char_ci)
  WHERE state IN ('started','people-committed','halted');
CREATE UNIQUE INDEX group_name_tenant_ci_group_id_uidx ON people.group_name (tenant_id, group_id COLLATE people.legacy_char_ci);
CREATE UNIQUE INDEX person_tombstone_tenant_ci_userid_uidx ON people.person_tombstone (tenant_id, userid COLLATE people.legacy_char_ci);
-- The person listing order: names case-insensitively with NULLs first, then userid.
DROP INDEX people.person_tenant_lname_fname_idx;
CREATE INDEX person_tenant_name_order_idx ON people.person (tenant_id, lower(lname) NULLS FIRST, lower(fname) NULLS FIRST, userid);
