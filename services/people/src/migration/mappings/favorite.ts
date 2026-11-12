import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { FAVORITE } from '../../repo/tables.js';

const LEGACY_TABLE = 'tusersfavorites';

// Live tusersfavorites spelling in catalog order (core/setup/db/mssql.sql:508-519); `favorite` content ids stay plain ids.
const LEGACY_COLUMNS = [
  'favoriteID', 'userID', 'favoriteName', 'favorite', 'type', 'siteID', 'dateCreated', 'columnNumber', 'rowNumber',
  'maxRSSItems',
] as const;

/** Mapped column for a legacy column, with the name and canonical type of its lower-cased `user_favorite` column. */
function owned(legacy: string): MappingColumn {
  const column = FAVORITE.columns.find((candidate) => candidate.name === legacy.toLowerCase());
  if (column === undefined) throw new MappingError(LEGACY_TABLE, `${FAVORITE.unit} has no column ${legacy.toLowerCase()}`);
  const { name: target, ...type } = column;
  return { legacy, target, ...type };
}

/** tusersfavorites rows of Type=2 owners → people.user_favorite [mssql.sql:508-519,765-769; 7.1.cfm:211-212]. */
export const favoriteMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: FAVORITE.unit,
  unit: FAVORITE.unit,
  columns: LEGACY_COLUMNS.map(owned),
  key: FAVORITE.key,
  // No split column: a named column must hold the Type itself, and userID holds the owner's id. Each apply row's
  // discriminator is its owning tusers row's Type, joined on userID; a row without an owner carries none and is rejected.
  split: { by: 'Type', value: 2 },
  // Table ownership resolves tusersfavorites as siteID-or-umbrella, as identity's share does, never by the owner's site.
  tenant: { kind: 'site', column: 'siteID' },
});
