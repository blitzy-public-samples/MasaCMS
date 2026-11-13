-- Lookups of a tenant's roster operations by user id in every state, under legacy_char_ci.
-- The index column carries the collation, not a lower() expression: forced row security keeps non-leakproof functions of a column out of index conditions.
CREATE INDEX roster_operation_tenant_ci_user_id_idx ON people.roster_operation (tenant_id, user_id COLLATE people.legacy_char_ci);
