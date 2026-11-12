/** Migration-kit mapping of the strategies-content objectClass share of Masa `ttrash` onto `content.trash`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { TRASH } from '../../repo/tables.js';

const LEGACY_TABLE = 'ttrash';

// Live-catalog spelling and order: core/mura/dbUpdates/5.2.1.2893.cfm:7-18, then deleteid and orderno from 5.7.cfm:105-106.
const LEGACY_COLUMNS = [
  'objectID', 'parentID', 'siteID', 'objectLabel', 'objectClass', 'objectType', 'objectSubType', 'objectstring',
  'deletedDate', 'deletedBy', 'deleteid', 'orderno',
] as const;

/** Mapped column for a legacy column, taking the name and canonical type TRASH declares for its lower-cased name. */
function trashColumn(legacy: string): MappingColumn {
  const target = TRASH.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${TRASH.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `ttrash` rows whose class-map owner is strategies-content ↔ `content.trash`, keyed by `objectID`; `objectstring` is byte-exact WDDX. */
export const ttrashMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: TRASH.table is unqualified, TRASH.unit is the qualified name.
  targetTable: TRASH.unit,
  unit: TRASH.unit,
  columns: LEGACY_COLUMNS.map(trashColumn),
  key: ['objectID'],
  // The content share is content, feed, category and changeset plus extendObject rows whose subtype has
  // baseTable = tcontent, which no ttrash column holds: like the identity, people and programs-sites shares, the split
  // takes each apply row's class-map owner as its discriminator rather than matching the objectClass column.
  split: { by: 'objectClass', value: 'strategies-content' },
  tenant: { kind: 'site', column: 'siteID' },
});
