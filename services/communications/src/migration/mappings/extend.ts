// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Migration-kit mappings of the communications share of the Masa class-extension tables: subtypes on a communications base table. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RC_SET, EXTEND_SET, EXTEND_SUBTYPE } from '../../repo/tables.js';
import type { CommunicationsTableDefinition } from '../../repo/tables.js';

/** Base tables `opt2/table-ownership.json` gives communications, in its row-predicate order. */
const COMMUNICATIONS_BASE_TABLES: readonly string[] = [
  'synthetic.delivery_status',
  'synthetic.message',
  'synthetic.message_template',
  'temailreturnstats',
  'temails',
  'temailstats',
  'tmailinglist',
  'tmailinglistmembers',
];

// Legacy names keep the live-catalog spelling and order of the ownership file; target names and types come from the
// repository definitions. Tenants come from siteID, else the umbrella as an orphan (siteID-or-umbrella), as for the other owners.

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: CommunicationsTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} declares no column for ${name}`);
    return { legacy: name, target: column.name, type: column.type };
  });
}

/** Masa `tclassextend` subtypes on a communications base table ↔ `communications.extend_subtype`, keyed by `subTypeID`. */
export const extendSubtypeMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass',
    'hasAssocFile', 'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: COMMUNICATIONS_BASE_TABLES, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendsets` rows of those subtypes ↔ `communications.extend_set`, keyed by `extendSetID`. */
export const extendSetMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: COMMUNICATIONS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendattributes` rows of those sets ↔ `communications.extend_attribute`, keyed by `attributeID`. */
export const extendAttributeMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendattributes',
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  columns: columnsOf('tclassextendattributes', EXTEND_ATTRIBUTE, [
    'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required',
    'validation', 'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
  ]),
  key: ['attributeID'],
  // The apply row's discriminator is tclassextend.baseTable reached through extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: COMMUNICATIONS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa ORM table `tclassextendrcsets` sets of those subtypes ↔ `communications.extend_rc_set`, keyed by `relatedContentSetID`. */
export const extendRcSetMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  columns: columnsOf('tclassextendrcsets', EXTEND_RC_SET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: COMMUNICATIONS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextenddata` values of those attributes ↔ `communications.extend_data`, keyed by `dataID`. */
export const extendDataMapping: Mapping = defineMapping({
  legacyTable: 'tclassextenddata',
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  columns: columnsOf('tclassextenddata', EXTEND_DATA, [
    'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
  ]),
  key: ['dataID'],
  // The apply row's discriminator is tclassextend.baseTable reached through attributeID ->
  // tclassextendattributes.extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: COMMUNICATIONS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});
