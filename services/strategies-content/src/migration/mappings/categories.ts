/** Migration-kit mappings of the Masa category tables onto `content.category` and `content.content_category_assign`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { CATEGORY, CATEGORY_ASSIGN } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapped columns for legacy column names, each taking the name and canonical type of its lower-cased target column. */
function ownedColumns(legacyTable: string, target: ContentUnitTableDefinition, legacyNames: readonly string[]): MappingColumn[] {
  const byName = new Map(target.columns.map((column) => [column.name, column]));
  return legacyNames.map((legacy) => {
    const column = byName.get(legacy.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${target.unit} declares no column for ${legacy}`);
    return { legacy, target: column.name, type: column.type };
  });
}

/** Whole-table mapping whose tenant is the row's own `siteID`; `legacyNames` are in live-catalog spelling and order. */
function siteMapping(legacyTable: string, target: ContentUnitTableDefinition, legacyNames: readonly string[]): Mapping {
  return defineMapping({
    legacyTable,
    // defineMapping needs a schema-qualified target: `target.table` is the repository's unqualified name, `target.unit` the qualified one.
    targetTable: target.unit,
    unit: target.unit,
    columns: ownedColumns(legacyTable, target, legacyNames),
    key: target.key,
    tenant: { kind: 'site', column: 'siteID' },
  });
}

/** Masa `tcontentcategories` ↔ `content.category`, keyed by `categoryID`; pooled categories carry their pool site's tenant. */
export const tcontentcategoriesMapping: Mapping = siteMapping('tcontentcategories', CATEGORY, [
  'categoryID',
  'siteID',
  'parentID',
  'dateCreated',
  'lastUpdate',
  'lastUpdateBy',
  'name',
  'notes',
  'isInterestGroup',
  'isActive',
  'isOpen',
  'sortBy',
  'sortDirection',
  'restrictGroups',
  'path',
  'remoteID',
  'remoteSourceURL',
  'remotePubDate',
  'urltitle',
  'filename',
  'isfeatureable',
]);

/** Masa `tcontentcategoryassign` ↔ `content.content_category_assign`, keyed by `contentHistID` and `categoryID`. */
export const tcontentcategoryassignMapping: Mapping = siteMapping('tcontentcategoryassign', CATEGORY_ASSIGN, [
  'contentHistID',
  'categoryID',
  'contentID',
  'isFeature',
  'orderno',
  'siteID',
  'featureStart',
  'featureStop',
]);
