import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_RC_SET } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextendrcsets';

// Live-catalog order, which differs from the beanORM property order; the canonical row encoding follows the catalog.
const LEGACY_COLUMNS = ['subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID'] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_RC_SET declares for its lower-cased name. */
function rcSetColumn(legacy: string): MappingColumn {
  const target = EXTEND_RC_SET.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_RC_SET.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tclassextendrcsets` related-content sets of site subtypes ↔ `programs_sites.extend_rc_set`, keyed by `relatedContentSetID`. */
export const tclassextendrcsetsMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_RC_SET.table is unqualified, EXTEND_RC_SET.unit is the qualified name.
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  columns: LEGACY_COLUMNS.map(rcSetColumn),
  key: ['relatedContentSetID'],
  // The table has no baseTable column: the apply row carries its subtype's tclassextend.baseTable (joined on subTypeID)
  // as the discriminator, and a row whose subtype does not resolve carries none and is rejected.
  split: { by: 'baseTable', value: 'tsettings' },
  // opt2/table-ownership.json resolves this table as siteID-or-umbrella, and TenantSource takes one source: a null or
  // empty siteID loads under the umbrella tenant as an orphan rather than inheriting the subtype's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
