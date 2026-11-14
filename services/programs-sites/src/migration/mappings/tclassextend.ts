import { defineMapping } from '@opt2/platform/migration-kit';
import { EXTEND_SUBTYPE } from '../../repo/tables.js';

/** Base tables whose subtypes programs-sites owns, in the order of their opt2/table-ownership.json row predicate. */
export const PROGRAMS_SITES_BASE_TABLES: readonly string[] = ['tsettings', 'synthetic.program_site', 'tdirectories', 'timagesizes', 'tsystemobjects'];

/** Masa `tclassextend` subtypes of a PROGRAMS_SITES_BASE_TABLES base table ↔ `programs_sites.extend_subtype`; tenant from `siteID`, else the umbrella as an orphan. */
export const tclassextendMapping = defineMapping({
  legacyTable: 'tclassextend',
  // defineMapping needs the schema-qualified name, which is the unit; EXTEND_SUBTYPE.table is unqualified.
  targetTable: EXTEND_SUBTYPE.unit,
  unit: EXTEND_SUBTYPE.unit,
  columns: [
    { legacy: 'subTypeID', target: 'subtypeid', type: 's' },
    { legacy: 'siteID', target: 'siteid', type: 's' },
    { legacy: 'baseTable', target: 'basetable', type: 's' },
    { legacy: 'baseKeyField', target: 'basekeyfield', type: 's' },
    { legacy: 'dataTable', target: 'datatable', type: 's' },
    { legacy: 'type', target: 'type', type: 's' },
    { legacy: 'subType', target: 'subtype', type: 's' },
    { legacy: 'isActive', target: 'isactive', type: 'i' },
    { legacy: 'notes', target: 'notes', type: 's' },
    { legacy: 'lastUpdate', target: 'lastupdate', type: 't' },
    { legacy: 'dateCreated', target: 'datecreated', type: 't' },
    { legacy: 'lastUpdateBy', target: 'lastupdateby', type: 's' },
    { legacy: 'hasSummary', target: 'hassummary', type: 'i' },
    { legacy: 'hasBody', target: 'hasbody', type: 'i' },
    { legacy: 'description', target: 'description', type: 's' },
    { legacy: 'availableSubTypes', target: 'availablesubtypes', type: 's' },
    { legacy: 'iconclass', target: 'iconclass', type: 's' },
    { legacy: 'hasAssocFile', target: 'hasassocfile', type: 'i' },
    { legacy: 'hasConfigurator', target: 'hasconfigurator', type: 'i' },
    { legacy: 'adminonly', target: 'adminonly', type: 'i' },
  ],
  key: ['subTypeID'],
  split: { by: 'baseTable', value: PROGRAMS_SITES_BASE_TABLES, column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});
