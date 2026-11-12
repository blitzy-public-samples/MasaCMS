import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, SplitRule, TenantSource } from '@opt2/platform/migration-kit';
import { GROUP_ADDRESS, GROUP_EXTEND_DATA, GROUP_FAVORITE, GROUP_INTEREST, GROUP_TAG } from '../../repo/tables.js';
import type { IdentityUnitTableDefinition } from '../../repo/tables.js';

/** Mapping columns for `legacy` (live-catalog spelling and order), each with the target name and canonical type of its column in `definition`. */
function columnsOf(legacyTable: string, definition: IdentityUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

// Child rows hold no Type: each apply row's discriminator is the Type of its owning tusers row, reached through the
// table-ownership split join (userID, or baseID for extended data). A row whose owner is absent carries no discriminator
// and is rejected, as the identity rowPredicate `owner Type = 1` reads; people's `owner Type = 2` rejects it as well.
const GROUP_OWNER: SplitRule = { by: 'Type', value: 1 };

// Table ownership resolves addresses, tags, favorites and extended data as siteID-or-umbrella: the row's own site column,
// else the umbrella as an orphan, never the owning group's site. Only tusersinterests, which has no site column, takes its owner's tenant.
const SITE_ID: TenantSource = { kind: 'site', column: 'siteID' };

/** tuseraddresses rows of Type=1 owners → identity.user_address [mssql.sql:444-465,759-762]. */
export const tuseraddressesGroupMapping: Mapping = defineMapping({
  legacyTable: 'tuseraddresses',
  targetTable: GROUP_ADDRESS.unit,
  unit: GROUP_ADDRESS.unit,
  columns: columnsOf('tuseraddresses', GROUP_ADDRESS, [
    'addressID', 'userID', 'siteID', 'addressName', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone',
    'fax', 'isPrimary', 'addressNotes', 'addressURL', 'longitude', 'latitude', 'addressEmail', 'hours',
  ]),
  key: GROUP_ADDRESS.key,
  split: GROUP_OWNER,
  tenant: SITE_ID,
});

/** tusersinterests rows of Type=1 owners → identity.user_interest, in the owner's tenant [mssql.sql:520-523,773-777]. */
export const tusersinterestsGroupMapping: Mapping = defineMapping({
  legacyTable: 'tusersinterests',
  targetTable: GROUP_INTEREST.unit,
  unit: GROUP_INTEREST.unit,
  columns: columnsOf('tusersinterests', GROUP_INTEREST, ['userID', 'categoryID']),
  key: GROUP_INTEREST.key,
  split: GROUP_OWNER,
  tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: { userID: 'UserID' } },
});

/** tuserstags rows of Type=1 owners → identity.user_tag [mssql.sql:616-621,865-868]. */
export const tuserstagsGroupMapping: Mapping = defineMapping({
  legacyTable: 'tuserstags',
  targetTable: GROUP_TAG.unit,
  unit: GROUP_TAG.unit,
  columns: columnsOf('tuserstags', GROUP_TAG, ['tagID', 'userID', 'siteid', 'tag']),
  key: GROUP_TAG.key,
  split: GROUP_OWNER,
  tenant: { kind: 'site', column: 'siteid' },
});

/** tusersfavorites rows of Type=1 owners → identity.user_favorite [mssql.sql:507-518,766-769]. */
export const tusersfavoritesGroupMapping: Mapping = defineMapping({
  legacyTable: 'tusersfavorites',
  targetTable: GROUP_FAVORITE.unit,
  unit: GROUP_FAVORITE.unit,
  columns: columnsOf('tusersfavorites', GROUP_FAVORITE, [
    'favoriteID', 'userID', 'favoriteName', 'favorite', 'type', 'siteID', 'dateCreated', 'columnNumber', 'rowNumber',
    'maxRSSItems',
  ]),
  key: GROUP_FAVORITE.key,
  split: GROUP_OWNER,
  tenant: SITE_ID,
});

/** tclassextenddatauseractivity rows of Type=1 owners → identity.extend_data_user_activity [mssql.sql:551-557; 5.2.1.2696.cfm:15; 5.2.2655.cfm:198-204; 7.1.cfm:260-263]. */
export const tclassextenddatauseractivityGroupMapping: Mapping = defineMapping({
  legacyTable: 'tclassextenddatauseractivity',
  targetTable: GROUP_EXTEND_DATA.unit,
  unit: GROUP_EXTEND_DATA.unit,
  columns: columnsOf('tclassextenddatauseractivity', GROUP_EXTEND_DATA, [
    'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
  ]),
  key: GROUP_EXTEND_DATA.key,
  split: GROUP_OWNER,
  tenant: SITE_ID,
});
