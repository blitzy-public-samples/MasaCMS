import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { PERSON_ARCHIVE } from '../../repo/tables.js';

/** Fixture `synthetic.person_archive` → `people.person_archive` [legacy-fixtures/sql/people/100_person_archive.sql]. */
export const personArchiveMapping: Mapping = defineMapping({
  legacyTable: 'synthetic.person_archive',
  // defineMapping needs the schema-qualified name, which is the unit; PERSON_ARCHIVE.table is unqualified.
  targetTable: PERSON_ARCHIVE.unit,
  unit: PERSON_ARCHIVE.unit,
  columns: [
    { legacy: 'archive_id', target: 'archive_id', type: 's' },
    { legacy: 'person_id', target: 'person_id', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'effective_from', target: 'effective_from', type: 't' },
    { legacy: 'archived_at', target: 'archived_at', type: 't' },
    { legacy: 'archived_by_id', target: 'archived_by_id', type: 's' },
    { legacy: 'archived_by', target: 'archived_by', type: 's' },
  ],
  key: PERSON_ARCHIVE.key,
  // Tenant from siteID, as opt2/table-ownership.json resolves this table, not through the person's tusers row: the
  // fixture stores the person's own tusers.SiteID (a pooled person's pool site), so both yield the person's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
