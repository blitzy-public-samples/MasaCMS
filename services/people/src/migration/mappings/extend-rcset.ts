import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_RCSET } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextendrcsets';

// Live-catalog order, which differs from the beanORM property order; the canonical row encoding follows the catalog.
const LEGACY_COLUMNS = ['subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID'] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_RCSET declares for its lower-cased name. */
function rcsetColumn(legacy: string): MappingColumn {
  const target = EXTEND_RCSET.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_RCSET.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tclassextendrcsets` related-content sets of user and address subtypes ↔ `people.extend_rc_set`, keyed by `relatedContentSetID`. */
export const extendRcsetMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_RCSET.table is unqualified, EXTEND_RCSET.unit is the qualified name.
  targetTable: EXTEND_RCSET.unit,
  unit: EXTEND_RCSET.unit,
  columns: LEGACY_COLUMNS.map(rcsetColumn),
  key: ['relatedContentSetID'],
  // The table has no baseTable column: the apply row carries its subtype's tclassextend.baseTable (joined on subTypeID)
  // as the discriminator, and a row whose subtype does not resolve carries none and is rejected. People owns both user
  // base tables, as for its subtypes: Masa's extension-config import stores Address subtypes under `tusersaddresses`.
  split: { by: 'baseTable', value: ['tusers', 'tusersaddresses'] },
  // opt2/table-ownership.json resolves this table as siteID-or-umbrella, and TenantSource takes one source: a null or
  // empty siteID loads under the umbrella tenant as an orphan rather than inheriting the subtype's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});

/** Every people mapping of `tclassextendrcsets`. */
export const EXTEND_RCSET_MAPPINGS: readonly Mapping[] = [extendRcsetMapping];
