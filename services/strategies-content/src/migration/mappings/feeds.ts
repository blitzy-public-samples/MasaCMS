/** Migration-kit mappings of the Masa collection (feed) tables onto `content.feed`, `content.feed_item` and `content.feed_advanced_param`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, TenantSource } from '@opt2/platform/migration-kit';
import { FEED, FEED_ADVANCED_PARAM, FEED_ITEM } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapping columns for the `legacy` names of `legacyTable`, each named and typed (scale included) by its column in `definition`. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** Tenant of a feed child row: its `tcontentfeeds` parent's site, or the umbrella tenant as an orphan when the feed is gone. */
const FEED_PARENT_TENANT: TenantSource = { kind: 'parent', parentLegacyTable: 'tcontentfeeds', columns: { feedID: 'feedID' } };

/** Masa `tcontentfeeds` ↔ `content.feed`, keyed by `feedID`; tenant from `siteID` [mssql.sql:164-191, 5.0.746–6.2.2 additions]. */
export const tcontentfeedsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentfeeds',
  targetTable: FEED.unit,
  unit: FEED.unit,
  columns: columnsOf('tcontentfeeds', FEED, [
    'feedID', 'siteID', 'parentID', 'name', 'isActive', 'isPublic', 'isDefault', 'isFeaturesOnly', 'description',
    'maxItems', 'allowHTML', 'lang', 'lastUpdateBy', 'lastUpdate', 'dateCreated', 'restricted', 'restrictGroups',
    'version', 'channelLink', 'Type', 'sortBy', 'sortDirection', 'nextN', 'displayName', 'displayRatings',
    'displayComments', 'altname', 'remoteID', 'remoteSourceURL', 'remotePubDate', 'imageSize', 'imageHeight',
    'imageWidth', 'displayList', 'showNavOnly', 'showExcludeSearch', 'viewalllink', 'viewalllabel', 'cssclass',
    'autoimport', 'isLocked', 'contentpoolid', 'useCategoryIntersect', 'authtype',
  ]),
  key: FEED.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** Masa `tcontentfeeditems` ↔ `content.feed_item`, keyed by `feedID, itemID` [mssql.sql:157-161,889]; tenant from the parent feed. */
export const tcontentfeeditemsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentfeeditems',
  targetTable: FEED_ITEM.unit,
  unit: FEED_ITEM.unit,
  columns: columnsOf('tcontentfeeditems', FEED_ITEM, ['feedID', 'itemID', 'type']),
  key: FEED_ITEM.key,
  tenant: FEED_PARENT_TENANT,
});

/** Masa `tcontentfeedadvancedparams` ↔ `content.feed_advanced_param`, keyed by `paramID`, `param` as `numeric(18,0)` [mssql.sql:145-154]; tenant from the parent feed. */
export const tcontentfeedadvancedparamsMapping: Mapping = defineMapping({
  legacyTable: 'tcontentfeedadvancedparams',
  targetTable: FEED_ADVANCED_PARAM.unit,
  unit: FEED_ADVANCED_PARAM.unit,
  columns: columnsOf('tcontentfeedadvancedparams', FEED_ADVANCED_PARAM, [
    'paramID', 'feedID', 'param', 'relationship', 'field', 'condition', 'criteria', 'dataType',
  ]),
  key: FEED_ADVANCED_PARAM.key,
  tenant: FEED_PARENT_TENANT,
});
