import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { ADDRESS } from '../../repo/tables.js';

const LEGACY_TABLE = 'tuseraddresses';

// Live tuseraddresses spelling in catalog order (core/setup/db/mssql.sql:444-465).
const LEGACY_COLUMNS = [
  'addressID', 'userID', 'siteID', 'addressName', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone',
  'fax', 'isPrimary', 'addressNotes', 'addressURL', 'longitude', 'latitude', 'addressEmail', 'hours',
] as const;

/** Mapped column for a legacy column, with the name and canonical type of its lower-cased `user_address` column. */
function owned(legacy: string): MappingColumn {
  const column = ADDRESS.columns.find((candidate) => candidate.name === legacy.toLowerCase());
  if (column === undefined) throw new MappingError(LEGACY_TABLE, `${ADDRESS.unit} has no column ${legacy.toLowerCase()}`);
  const { name: target, ...type } = column;
  return { legacy, target, ...type };
}

/** tuseraddresses rows of Type=2 owners → people.user_address [mssql.sql:444-465,758-762]. */
export const addressMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: ADDRESS.unit,
  unit: ADDRESS.unit,
  columns: LEGACY_COLUMNS.map(owned),
  key: ADDRESS.key,
  // No `column`: a split column is read from the row itself, and address rows hold no Type (userID is the owner's id).
  // Each apply row carries its owning tusers row's Type as the discriminator, as for identity's Type=1 share.
  split: { by: 'Type', value: 2 },
  // Table ownership resolves this table as siteID-or-umbrella rather than through the owner: Masa stores the owner's
  // user-pool site in the address siteID (core/mura/user/addressBean.cfc:170-175), so both give the owner's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
