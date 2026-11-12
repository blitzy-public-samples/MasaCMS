/** Migration-kit mappings of the strategies-content share (`baseTable = tcontent`) of the Masa class-extension tables. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RCSET, EXTEND_SET, EXTEND_SUBTYPE } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Base table of content subtypes; Masa gives it to Page, Folder, Component, File, Link, Calendar, Gallery, Base and Form. */
const CONTENT_BASE_TABLE = 'tcontent';

// Legacy names keep the live-catalog spelling and order of opt2/table-ownership.json; target names and canonical types
// come from the repository definitions. defineMapping needs a schema-qualified target, which is each definition's unit.
// Every mapping takes its tenant from siteID, else the umbrella as an orphan: TenantSource takes one source, and the
// ownership file resolves these tables as siteID-or-umbrella rather than through a parent, as the people and
// programs-sites shares do, so the three owners place a row with the same tenant.

/** Mapping columns for the `legacy` names of `legacyTable`, each typed and named by its column in `definition`. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} declares no column for ${name}`);
    return { legacy: name, target: column.name, type: column.type };
  });
}

/** Masa `tclassextend` content subtypes (`baseTable = tcontent`) ↔ `content.extend_subtype`, keyed by `subTypeID`. */
export const tclassextendMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  // Bootstrap columns, then hasSummary and hasBody (5.6.1), description and availableSubTypes (5.7), iconclass,
  // hasAssocFile and hasConfigurator (6.1) and adminonly (6.2.2).
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass',
    'hasAssocFile', 'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: CONTENT_BASE_TABLE, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendsets` rows of content subtypes ↔ `content.extend_set`, keyed by `extendSetID`. */
export const tclassextendsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  // Bootstrap columns, then container (5.2.1806).
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  // Sets carry no baseTable: each apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: CONTENT_BASE_TABLE },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextendattributes` rows of content extend sets ↔ `content.extend_attribute`, keyed by `attributeID`. */
export const tclassextendattributesMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendattributes',
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  // Bootstrap columns (validate renamed to validation by 5.0.408), then adminonly (6.2.2).
  columns: columnsOf('tclassextendattributes', EXTEND_ATTRIBUTE, [
    'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required',
    'validation', 'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
  ]),
  // The integer identity keeps its legacy value, which tclassextenddata.attributeID references.
  key: ['attributeID'],
  // The apply row's discriminator is tclassextend.baseTable reached through extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: CONTENT_BASE_TABLE },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa ORM table `tclassextendrcsets` related-content sets of content subtypes ↔ `content.extend_rc_set`, keyed by `relatedContentSetID`. */
export const tclassextendrcsetsMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RCSET.unit,
  unit: EXTEND_RCSET.unit,
  // Live-catalog order, which differs from the beanORM property order; the canonical row encoding follows the catalog.
  columns: columnsOf('tclassextendrcsets', EXTEND_RCSET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  // The apply row's discriminator is its subtype's tclassextend.baseTable, joined on subTypeID.
  split: { by: 'baseTable', value: CONTENT_BASE_TABLE },
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tclassextenddata` values of content attributes ↔ `content.extend_data`, keyed by `dataID`; `baseID` is a `contentHistID`. */
export const tclassextenddataMapping: Mapping = defineMapping({
  legacyTable: 'tclassextenddata',
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  // Bootstrap columns, then remoteID (5.2.1.2696) and the typed values datetimevalue, numericvalue and stringvalue (5.2.2655).
  columns: columnsOf('tclassextenddata', EXTEND_DATA, [
    'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
  ]),
  key: ['dataID'],
  // The apply row's discriminator is tclassextend.baseTable reached through attributeID ->
  // tclassextendattributes.extendSetID -> tclassextendsets.subTypeID.
  split: { by: 'baseTable', value: CONTENT_BASE_TABLE },
  tenant: { kind: 'site', column: 'siteID' },
});
