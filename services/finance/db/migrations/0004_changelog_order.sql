-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Same-row predecessor lookups of the change feed: target rows by key, and target updates by after-image.
CREATE INDEX changelog_key_order_idx ON finance.changelog (tenant_id, "table", md5(key), xid, seq) WHERE origin = 'target';
CREATE INDEX changelog_after_order_idx ON finance.changelog (tenant_id, "table", md5(after), xid, seq) WHERE origin = 'target' AND op = 'update';
