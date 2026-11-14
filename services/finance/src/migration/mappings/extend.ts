// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Migration-kit mappings of the finance share (`baseTable` a finance table) of the Masa class-extension tables. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RC_SET, EXTEND_SET, EXTEND_SUBTYPE, type FinanceTableDefinition } from '../../repo/tables.js';

/** Base tables opt2/table-ownership.json gives finance, as the row predicate of each finance extension unit lists them. */
export const FINANCE_BASE_TABLES = Object.freeze([
  'Program_1.finance_attachment',
  'Program_1.finance_record',
  'Program_1.finance_record_version',
  'Program_1.finance_rollup',
  'Program_2.finance_attachment',
  'Program_2.finance_record',
  'Program_2.finance_record_version',
  'Program_2.finance_rollup',
  'synthetic.finance_transition',
] as const);

// Legacy names keep the live-catalog spelling and order of opt2/table-ownership.json; target names and canonical types
// come from the repository definitions. These rows live in Masa dbo tables, so nothing is folded: the tenant is siteID,
// else the umbrella as an orphan, as the ownership file resolves them (siteID-or-umbrella).

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: FinanceTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} declares no column for ${name}`);
    return { legacy: name, target: column.name, type: column.type };
  });
}

/** Masa `tclassextend` finance subtypes ↔ `finance.extend_subtype`, keyed by `subTypeID`; the split reads the row's own `baseTable`. */
export const tclassextendMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass',
    'hasAssocFile', 'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: FINANCE_BASE_TABLES, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendsets` rows of finance subtypes ↔ `finance.extend_set`, keyed by `extendSetID`. */
export const tclassextendsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: FINANCE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendattributes` rows of finance extend sets ↔ `finance.extend_attribute`, keyed by `attributeID`. */
export const tclassextendattributesMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendattributes',
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  columns: columnsOf('tclassextendattributes', EXTEND_ATTRIBUTE, [
    'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required',
    'validation', 'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
  ]),
  key: ['attributeID'],
  // The apply row's discriminator is tclassextend.baseTable reached through extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: FINANCE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendrcsets` related-content sets of finance subtypes ↔ `finance.extend_rc_set`, keyed by `relatedContentSetID`. */
export const tclassextendrcsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  columns: columnsOf('tclassextendrcsets', EXTEND_RC_SET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: FINANCE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextenddata` values of finance attributes ↔ `finance.extend_data`, keyed by `dataID`. */
export const tclassextenddataMapping: Mapping = defineMapping({
  legacyTable: 'tclassextenddata',
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  columns: columnsOf('tclassextenddata', EXTEND_DATA, [
    'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
  ]),
  key: ['dataID'],
  // The apply row's discriminator is tclassextend.baseTable reached through attributeID ->
  // tclassextendattributes.extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: FINANCE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});
