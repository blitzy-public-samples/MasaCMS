import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { TAG } from '../../repo/tables.js';

const LEGACY_TABLE = 'tuserstags';

/** `tuserstags` columns in live-catalog order and spelling (core/setup/db/mssql.sql:616-621). */
const LEGACY_COLUMNS = ['tagID', 'userID', 'siteid', 'tag'] as const;

/** Mapped column for a legacy column, with the target name and canonical type of its lower-cased TAG column. */
function tagColumn(legacy: string): MappingColumn {
  const column = TAG.columns.find((candidate) => candidate.name === legacy.toLowerCase());
  if (column === undefined) throw new MappingError(LEGACY_TABLE, `${TAG.unit} has no column ${legacy.toLowerCase()}`);
  const { name: target, ...type } = column;
  return { legacy, target, ...type };
}

/** tuserstags rows of Type=2 owners → people.user_tag, keeping the legacy identity tagID [mssql.sql:616-621,865-868]. */
export const tagMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: TAG.unit,
  unit: TAG.unit,
  columns: LEGACY_COLUMNS.map(tagColumn),
  key: TAG.key,
  // No `column`: tuserstags holds no Type, and a split column names the row's own discriminator. Each apply row carries
  // its owner's tusers.Type, joined on userID; a row whose owner is absent carries none and is rejected.
  split: { by: 'Type', value: 2 },
  // Table ownership resolves tuserstags as siteID-or-umbrella rather than through the owner row. Masa writes the owner's
  // SiteID into siteid (core/mura/user/userDAO.cfc:904-909), so both give the owner's tenant; a null siteid loads as an umbrella orphan.
  tenant: { kind: 'site', column: 'siteid' },
});
