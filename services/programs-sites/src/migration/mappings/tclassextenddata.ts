import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_DATA } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextenddata';

// Live-catalog order and spelling: the bootstrap columns, then remoteID (5.2.1.2696) and the typed values (5.2.2655).
const LEGACY_COLUMNS = [
  'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_DATA declares for its lower-cased name. */
function extendDataColumn(legacy: string): MappingColumn {
  const target = EXTEND_DATA.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_DATA.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tclassextenddata` values of site attributes (`baseTable = tsettings`) ↔ `programs_sites.extend_data`, keyed by `dataID`. */
export const tclassextenddataMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_DATA.table is unqualified, EXTEND_DATA.unit is the qualified name.
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  columns: LEGACY_COLUMNS.map(extendDataColumn),
  // The integer identity keeps its legacy value; target-created rows take negative ids (0004_extend_data_id_sequence.sql).
  key: ['dataID'],
  // Values carry no baseTable: the apply row's discriminator is tclassextend.baseTable reached through attributeID ->
  // tclassextendattributes.extendSetID -> tclassextendsets.subTypeID, and a row whose chain does not resolve carries none and is rejected.
  split: { by: 'baseTable', value: 'tsettings' },
  // opt2/table-ownership.json resolves this table as siteID-or-umbrella, and TenantSource takes one source: a null or
  // empty siteID loads under the umbrella tenant as an orphan rather than inheriting the attribute's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
