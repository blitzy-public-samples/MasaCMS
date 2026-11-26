import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { INTEREST } from '../../repo/tables.js';

const LEGACY_TABLE = 'tusersinterests';

/** Mapped column for a legacy column, with the name and canonical type of its lower-cased INTEREST column. */
function interestColumn(legacy: string): MappingColumn {
  const column = INTEREST.columns.find((candidate) => candidate.name === legacy.toLowerCase());
  if (column === undefined) throw new MappingError(LEGACY_TABLE, `${INTEREST.unit} has no column ${legacy.toLowerCase()}`);
  const { name: target, ...type } = column;
  return { legacy, target, ...type };
}

/** tusersinterests rows of Type=2 owners → people.user_interest in the owner's tenant, category ids kept as plain references [mssql.sql:522-525,772-777]. */
export const interestMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: INTEREST.unit,
  unit: INTEREST.unit,
  columns: ['userID', 'categoryID'].map(interestColumn),
  key: INTEREST.key,
  // No tusersinterests column holds the owner's Type: each apply row carries its owning tusers row's Type as the
  // discriminator. Naming userID as the split column would compare user ids with 2 and reject every row.
  split: { by: 'Type', value: 2 },
  tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: { userID: 'UserID' } },
});
