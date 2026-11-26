import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { PERSON } from '../../repo/tables.js';

const LEGACY_TABLE = 'tusers';

// Live tusers spelling of the person share in catalog order (core/setup/db/mssql.sql:467-505); identity owns the rest.
const LEGACY_COLUMNS = [
  'UserID', 'GroupName', 'Fname', 'Lname', 'Email', 'Company', 'JobTitle', 'mobilePhone', 'Website', 'subType', 'Ext',
  'ContactForm', 'LastUpdate', 'LastUpdateBy', 'LastUpdateByID', 'SiteID', 'Subscribe', 'notes', 'description',
  'interests', 'keepPrivate', 'photoFileID', 'IMName', 'IMService', 'created', 'tags',
] as const;

/** Mapped column for a legacy column, with the name and canonical type of its lower-cased `person` column. */
function owned(legacy: string): MappingColumn {
  const column = PERSON.columns.find((candidate) => candidate.name === legacy.toLowerCase());
  if (column === undefined) throw new MappingError(LEGACY_TABLE, `${PERSON.unit} has no column ${legacy.toLowerCase()}`);
  const { name: target, ...type } = column;
  return { legacy, target, ...type };
}

/** People's person columns of tusers Type=2 rows → people.person [mssql.sql:467-505]. */
export const personMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: PERSON.unit,
  unit: PERSON.unit,
  columns: LEGACY_COLUMNS.map(owned),
  // The legacy primary key is UserID alone (core/mura/dbUpdates/7.1.cfm:204-205); SiteID is carried as a join column, not a key part.
  key: PERSON.key,
  // Names the row's own Type column, as identity's tusers splits do: the orchestrator sends no separate discriminator.
  split: { by: 'Type', value: 2, column: 'Type' },
  tenant: { kind: 'site', column: 'SiteID' },
});
