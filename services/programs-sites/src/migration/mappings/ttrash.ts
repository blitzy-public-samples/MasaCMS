import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

const LEGACY_TABLE = 'ttrash';

// Live-catalog order and spelling: core/mura/dbUpdates/5.2.1.2893.cfm:7-18, then deleteid and orderno from 5.7.cfm:105-106.
const LEGACY_COLUMNS = [
  'objectID', 'parentID', 'siteID', 'objectLabel', 'objectClass', 'objectType', 'objectSubType', 'objectstring',
  'deletedDate', 'deletedBy', 'deleteid', 'orderno',
] as const;

/** Mapped column for a legacy column, with the target name and canonical type TRASH declares for its lower-cased name. */
function trashColumn(legacy: string): MappingColumn {
  const target = TRASH.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${TRASH.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `ttrash` rows of site extend objects ↔ `programs_sites.trash`, keyed by `objectID`; `objectstring` is byte-exact WDDX. */
export const ttrashMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: TRASH.table is unqualified, TRASH.unit is the qualified name.
  targetTable: TRASH.unit,
  unit: TRASH.unit,
  columns: LEGACY_COLUMNS.map(trashColumn),
  key: ['objectID'],
  // opt2/table-ownership.json assigns programs-sites the extendObject rows whose subtype has baseTable = tsettings, which
  // no ttrash column holds alone: each apply row's discriminator is its class-map owner, as for identity's share.
  split: { by: 'objectClass', value: 'programs-sites' },
  tenant: { kind: 'site', column: 'siteID' },
});
