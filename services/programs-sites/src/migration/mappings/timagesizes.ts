import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { IMAGE_SIZE } from '../../repo/tables.js';

const LEGACY_TABLE = 'timagesizes';
const TARGET_COLUMNS = new Map(IMAGE_SIZE.columns.map((column) => [column.name, column]));

/** Mapped column for a legacy column, taking the name and canonical type of its lower-cased `image_size` column. */
function owned(legacy: string): MappingColumn {
  const target = TARGET_COLUMNS.get(legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `image_size has no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `timagesizes` ↔ `programs_sites.image_size`; programs-sites owns every row, and its tenant is the row's own `siteID`. */
export const timagesizesMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target; the unit is that name, and IMAGE_SIZE.table is its unqualified repository form.
  targetTable: IMAGE_SIZE.unit,
  unit: IMAGE_SIZE.unit,
  // Live-catalog spelling and order of core/mura/dbUpdates/5.7.cfm:94-102.
  columns: ['sizeID', 'siteID', 'name', 'height', 'width'].map(owned),
  // Key names resolve case-insensitively to the mapped legacy columns, whose lower-cased names owned() ties to the target names.
  key: IMAGE_SIZE.key,
  tenant: { kind: 'site', column: 'siteID' },
});
