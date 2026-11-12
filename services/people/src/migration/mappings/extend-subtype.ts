import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping } from '@opt2/platform/migration-kit';
import { EXTEND_SUBTYPE } from '../../repo/tables.js';

/** Masa `tclassextend` user, group and address subtypes ↔ `people.extend_subtype`; tenant from `siteID`, else the umbrella as an orphan. */
export const extendSubtypeMapping: Mapping = defineMapping({
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
  // People owns both user base tables: Masa's extension-config import stores Address subtypes under `tusersaddresses`.
  split: { by: 'baseTable', value: ['tusers', 'tusersaddresses'], column: 'baseTable' },
  tenant: { kind: 'site', column: 'siteID' },
});
