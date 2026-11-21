// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Migration-kit mappings of the e-signature share of the Masa class-extension tables, by subtype `baseTable`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RC_SET, EXTEND_SET, EXTEND_SUBTYPE } from '../../repo/tables.js';
import type { EsignatureTableDefinition } from '../../repo/tables.js';

/** Subtype base tables `opt2/table-ownership.json` gives e-signature: its fixture tables. */
export const ESIGNATURE_BASE_TABLES = Object.freeze(['synthetic.audit_entry', 'synthetic.signature', 'synthetic.signature_request'] as const);

// Legacy names keep the live-catalog spelling and order of opt2/table-ownership.json; target names and canonical types
// come from the repository definitions. Every mapping takes its tenant from siteID, else the umbrella as an orphan, as
// the other owners' shares do, since the ownership file resolves these tables as siteID-or-umbrella.

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: EsignatureTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} declares no column for ${name}`);
    return { legacy: name, target: column.name, type: column.type };
  });
}

/** Masa `tclassextend` e-signature subtypes ↔ `esignature.extend_subtype`, keyed by `subTypeID`. */
export const tclassextendMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  // defineMapping needs a schema-qualified target, which is each definition's unit.
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass',
    'hasAssocFile', 'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: ESIGNATURE_BASE_TABLES, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendsets` rows of e-signature subtypes ↔ `esignature.extend_set`, keyed by `extendSetID`. */
export const tclassextendsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: ESIGNATURE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendattributes` rows of e-signature extend sets ↔ `esignature.extend_attribute`, keyed by `attributeID`. */
export const tclassextendattributesMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendattributes',
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  columns: columnsOf('tclassextendattributes', EXTEND_ATTRIBUTE, [
    'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required',
    'validation', 'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
  ]),
  // The integer identity keeps its legacy value, which tclassextenddata.attributeID references.
  key: ['attributeID'],
  // The apply row's discriminator is tclassextend.baseTable reached through extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: ESIGNATURE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendrcsets` related-content sets of e-signature subtypes ↔ `esignature.extend_rc_set`, keyed by `relatedContentSetID`. */
export const tclassextendrcsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  columns: columnsOf('tclassextendrcsets', EXTEND_RC_SET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: ESIGNATURE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextenddata` values of e-signature attributes ↔ `esignature.extend_data`, keyed by `dataID`. */
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
  split: { by: 'baseTable', value: ESIGNATURE_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});
