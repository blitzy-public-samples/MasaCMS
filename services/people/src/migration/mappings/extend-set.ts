import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_SET } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextendsets';

/** `tclassextendsets` columns in live-catalog order and spelling; each maps to the EXTEND_SET column of its lower-cased name. */
const LEGACY_COLUMNS = ['extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container'] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_SET declares. */
function extendSetColumn(legacy: string): MappingColumn {
  const target = EXTEND_SET.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_SET.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tclassextendsets` rows of user subtypes (`baseTable` `tusers` or `tusersaddresses`) ↔ `people.extend_set`, keyed by `extendSetID`. */
export const extendSetMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_SET.table is the repository's unqualified name, EXTEND_SET.unit the qualified one.
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: LEGACY_COLUMNS.map(extendSetColumn),
  key: ['extendSetID'],
  // Sets carry no baseTable: each apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  // Sets follow their subtype, so this accepts both base tables extendSubtypeMapping takes, as opt2/table-ownership.json
  // assigns them: Masa's extension-config import stores Address subtypes under `tusersaddresses`.
  split: { by: 'baseTable', value: ['tusers', 'tusersaddresses'] },
  // A mapping takes one tenant source, so this is the ownership file's siteID-or-umbrella rule rather than a parent fallback.
  // Masa saves a set with its subtype's siteID, so a null-siteID set sits under a null-siteID subtype, which also loads under the umbrella.
  tenant: { kind: 'site', column: 'siteID' },
});
