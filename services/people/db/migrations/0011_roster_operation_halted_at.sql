-- When recovery halted a roster operation; set once and kept through its resolution.
ALTER TABLE people.roster_operation ADD COLUMN halted_at timestamp(3) without time zone NULL;
-- The operator's listing of a tenant's halted operations, oldest first.
CREATE INDEX roster_operation_tenant_halted_idx ON people.roster_operation (tenant_id, started_at, operation_id) WHERE halted_at IS NOT NULL;
