// SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Migration-kit mappings of the timesheets share of the Masa class-extension tables: subtypes whose `baseTable` is a timesheets table. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RC_SET, EXTEND_SET, EXTEND_SUBTYPE } from '../../repo/tables.js';
import type { tables } from '../../repo/tables.js';

/** One timesheets table definition. */
type TimesheetsTableDefinition = (typeof tables)[number];

/** Base tables `opt2/table-ownership.json` gives timesheets, in its row-predicate order; each Program_N schema is named on its own. */
export const TIMESHEETS_BASE_TABLES = Object.freeze([
  'Program_1.approval_action',
  'Program_1.blackout',
  'Program_1.timesheet',
  'Program_1.timesheet_day',
  'Program_2.approval_action',
  'Program_2.blackout',
  'Program_2.timesheet',
  'Program_2.timesheet_day',
  'synthetic.timesheet_transition',
  'synthetic.transition_rule',
] as const);

// These rows live in Masa's dbo tables, not in a Program_<id> schema, so they are not folded: the tenant is the row's
// siteID, else the umbrella as an orphan, as the other owners of these tables place them.

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: TimesheetsTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} declares no column for ${name}`);
    return { legacy: name, target: column.name, type: column.type };
  });
}

/** Masa `tclassextend` subtypes of a timesheets base table ↔ `timesheets.extend_subtype`, keyed by `subTypeID`. */
export const tclassextendMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  // Mapping targets are schema-qualified: EXTEND_SUBTYPE.unit, not the repository's bare EXTEND_SUBTYPE.table.
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass',
    'hasAssocFile', 'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: TIMESHEETS_BASE_TABLES, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendsets` rows of timesheets subtypes ↔ `timesheets.extend_set`, keyed by `extendSetID`. */
export const tclassextendsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  // Sets carry no baseTable: each apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: TIMESHEETS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendattributes` rows of timesheets extend sets ↔ `timesheets.extend_attribute`, keyed by `attributeID`. */
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
  split: { by: 'baseTable', value: TIMESHEETS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa ORM table `tclassextendrcsets` related-content sets of timesheets subtypes ↔ `timesheets.extend_rc_set`, keyed by `relatedContentSetID`. */
export const tclassextendrcsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  // Live-catalog order, which differs from the beanORM property order; the canonical row encoding follows the catalog.
  columns: columnsOf('tclassextendrcsets', EXTEND_RC_SET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: TIMESHEETS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextenddata` values of timesheets attributes ↔ `timesheets.extend_data`, keyed by `dataID`. */
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
  split: { by: 'baseTable', value: TIMESHEETS_BASE_TABLES },
  tenant: { kind: 'site', column: 'siteID' },
});
