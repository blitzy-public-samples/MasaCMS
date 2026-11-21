-- Marks a deleted site's registry row, kept so recovery scans still reach its tenant.
ALTER TABLE programs_sites.tenant_registry ADD COLUMN deleted boolean NOT NULL DEFAULT false;
