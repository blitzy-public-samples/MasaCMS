import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { DIRECTORY } from '../../repo/tables.js';

const LEGACY_TABLE = 'tdirectories';

/** `tdirectories` columns in live-catalog order and spelling; each maps to the DIRECTORY column of its lower-cased name. */
const LEGACY_COLUMNS = ['dirID', 'siteID', 'subdir', 'editfilename'] as const;

/** Mapped column for a legacy column, with the target name and canonical type DIRECTORY declares. */
function directoryColumn(legacy: string): MappingColumn {
  const target = DIRECTORY.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${DIRECTORY.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tdirectories` ↔ `programs_sites.directory`, keyed by `dirID`, tenant from the row's own `siteID`. */
export const tdirectoriesMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: DIRECTORY.table is the repository's unqualified name, DIRECTORY.unit the qualified one.
  targetTable: DIRECTORY.unit,
  unit: DIRECTORY.unit,
  columns: LEGACY_COLUMNS.map(directoryColumn),
  key: ['dirID'],
  tenant: { kind: 'site', column: 'siteID' },
});
