import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextendattributes';

// Live-catalog order and spelling: the bootstrap columns (validate renamed to validation by 5.0.408), then adminonly from 6.2.2.
const LEGACY_COLUMNS = [
  'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required',
  'validation', 'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_ATTRIBUTE declares for its lower-cased name. */
function extendAttributeColumn(legacy: string): MappingColumn {
  const target = EXTEND_ATTRIBUTE.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_ATTRIBUTE.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** Masa `tclassextendattributes` rows of user extend sets (`baseTable` `tusers` or `tusersaddresses`) ↔ `people.extend_attribute`, keyed by `attributeID`. */
export const extendAttributeMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_ATTRIBUTE.table is unqualified, EXTEND_ATTRIBUTE.unit is the qualified name.
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  columns: LEGACY_COLUMNS.map(extendAttributeColumn),
  // The integer identity keeps its legacy value, which tclassextenddata.attributeID and tclassextenddatauseractivity.attributeID reference.
  key: ['attributeID'],
  // Attributes carry no baseTable: the apply row's discriminator is tclassextend.baseTable reached through
  // extendSetID -> tclassextendsets.subTypeID, and a row whose chain does not resolve carries none and is rejected.
  // Attributes follow their set, so this accepts both base tables extendSetMapping takes, as opt2/table-ownership.json
  // assigns them: Masa's extension-config import stores Address subtypes under `tusersaddresses`.
  split: { by: 'baseTable', value: ['tusers', 'tusersaddresses'] },
  // opt2/table-ownership.json resolves this table as siteID-or-umbrella, and TenantSource takes one source: a null or
  // empty siteID loads under the umbrella tenant as an orphan rather than inheriting the set's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
