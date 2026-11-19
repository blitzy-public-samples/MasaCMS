/** Migration-kit mappings of the identity share of the Masa class-extension tables: subtypes whose `baseTable` is an identity table. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, SplitRule, TenantSource } from '@opt2/platform/migration-kit';
import { EXTEND_ATTRIBUTE, EXTEND_DATA, EXTEND_RC_SET, EXTEND_SET, EXTEND_SUBTYPE } from '../../repo/tables.js';
import type { IdentityUnitTableDefinition } from '../../repo/tables.js';

/** Base tables of identity subtypes, as the identity row predicate of opt2/table-ownership.json lists them. */
const IDENTITY_BASE_TABLES = [
  'toauthclients',
  'toauthtokens',
  'tpermissions',
  'tredirects',
  'tuserdevice',
  'tuserremotesessions',
  'tusersmemb',
  'tuserstrikes',
] as const;

// Sets, attributes, related-content sets and values carry no baseTable: each apply row's discriminator is its subtype's
// tclassextend.baseTable, reached through subTypeID, extendSetID -> subTypeID, or attributeID -> extendSetID -> subTypeID.
const BY_SUBTYPE_BASE_TABLE: SplitRule = { by: 'baseTable', value: IDENTITY_BASE_TABLES };

// Ownership resolves these tables as siteID-or-umbrella, so every owner of a subtype places its rows in the same tenant.
const SITE_ID: TenantSource = { kind: 'site', column: 'siteID' };

// Kept per module: mapping modules export only mappings, which the barrel re-exports.
/** Mapping columns for `legacy` (live-catalog spelling and order), each with the target name and canonical type of its column in `definition`. */
function columnsOf(legacyTable: string, definition: IdentityUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** tclassextend rows of identity base tables → identity.extend_subtype [mssql.sql:569-582; 5.6.1.cfm:51-52; 5.7.cfm:3-4; 6.1.cfm:61-63; 6.2.2.cfm:5]. */
export const tclassextendIdentityMapping: Mapping = defineMapping({
  legacyTable: 'tclassextend',
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: columnsOf('tclassextend', EXTEND_SUBTYPE, [
    'subTypeID', 'siteID', 'baseTable', 'baseKeyField', 'dataTable', 'type', 'subType', 'isActive', 'notes', 'lastUpdate',
    'dateCreated', 'lastUpdateBy', 'hasSummary', 'hasBody', 'description', 'availableSubTypes', 'iconclass', 'hasAssocFile',
    'hasConfigurator', 'adminonly',
  ]),
  key: ['subTypeID'],
  split: { by: 'baseTable', value: IDENTITY_BASE_TABLES, column: 'baseTable' },
  tenant: SITE_ID,
});

/** tclassextendsets rows of identity subtypes → identity.extend_set [mssql.sql:605-613; 5.2.1806.cfm:158]. */
export const tclassextendsetsIdentityMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendsets',
  targetTable: EXTEND_SET.unit,
  unit: EXTEND_SET.unit,
  columns: columnsOf('tclassextendsets', EXTEND_SET, [
    'extendSetID', 'subTypeID', 'categoryID', 'siteID', 'name', 'orderno', 'isActive', 'container',
  ]),
  key: ['extendSetID'],
  split: BY_SUBTYPE_BASE_TABLE,
  tenant: SITE_ID,
});

/** tclassextendattributes rows of identity extend sets → identity.extend_attribute [mssql.sql:585-602; 6.2.2.cfm:4]. */
export const tclassextendattributesIdentityMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendattributes',
  targetTable: EXTEND_ATTRIBUTE.unit,
  unit: EXTEND_ATTRIBUTE.unit,
  columns: columnsOf('tclassextendattributes', EXTEND_ATTRIBUTE, [
    'attributeID', 'extendSetID', 'siteID', 'name', 'label', 'hint', 'type', 'orderno', 'isActive', 'required', 'validation',
    'regex', 'message', 'defaultValue', 'optionList', 'optionLabelList', 'adminonly',
  ]),
  key: ['attributeID'],
  split: BY_SUBTYPE_BASE_TABLE,
  tenant: SITE_ID,
});

/** tclassextendrcsets rows of identity subtypes → identity.extend_rc_set, in live-catalog order [extendRelatedContentSetBean.cfc:1]. */
export const tclassextendrcsetsIdentityMapping: Mapping = defineMapping({
  legacyTable: 'tclassextendrcsets',
  targetTable: EXTEND_RC_SET.unit,
  unit: EXTEND_RC_SET.unit,
  columns: columnsOf('tclassextendrcsets', EXTEND_RC_SET, [
    'subTypeID', 'availableSubTypes', 'siteID', 'entitytype', 'name', 'orderNo', 'relatedContentSetID',
  ]),
  key: ['relatedContentSetID'],
  split: BY_SUBTYPE_BASE_TABLE,
  tenant: SITE_ID,
});

/** tclassextenddata values of identity attributes → identity.extend_data [mssql.sql:560-566; 5.2.1.2696.cfm:88; 5.2.2655.cfm:53-59]. */
export const tclassextenddataIdentityMapping: Mapping = defineMapping({
  legacyTable: 'tclassextenddata',
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  columns: columnsOf('tclassextenddata', EXTEND_DATA, [
    'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
  ]),
  key: ['dataID'],
  split: BY_SUBTYPE_BASE_TABLE,
  tenant: SITE_ID,
});
