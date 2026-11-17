-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
-- Marks a deleted site's registry row, kept so recovery scans still reach its tenant.
ALTER TABLE reporting.tenant_registry ADD COLUMN deleted boolean NOT NULL DEFAULT false;
