-- Marks a deleted site's registry row, kept so recovery scans still reach its tenant.
ALTER TABLE content.tenant_registry ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
