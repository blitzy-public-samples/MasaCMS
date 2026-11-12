import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { EXTEND_DATA } from '../../repo/tables.js';

const LEGACY_TABLE = 'tclassextenddatauseractivity';

// Live-catalog order and spelling: the bootstrap columns, then remoteID (5.2.1.2696) and the typed values (5.2.2655).
const LEGACY_COLUMNS = [
  'dataID', 'baseID', 'attributeID', 'siteID', 'attributeValue', 'remoteID', 'datetimevalue', 'numericvalue', 'stringvalue',
] as const;

/** Mapped column for a legacy column, with the target name and canonical type EXTEND_DATA declares for its lower-cased name. */
function extendDataColumn(legacy: string): MappingColumn {
  const target = EXTEND_DATA.columns.find((column) => column.name === legacy.toLowerCase());
  if (target === undefined) throw new MappingError(LEGACY_TABLE, `${EXTEND_DATA.unit} declares no column for ${legacy}`);
  return { legacy, target: target.name, type: target.type };
}

/** tclassextenddatauseractivity values of Type=2 users and their addresses → people.extend_data_user_activity [mssql.sql:551-557,821-822; 5.2.1.2696.cfm:15; 5.2.2655.cfm:198-204]. */
export const extendDataMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  // defineMapping needs a schema-qualified target: EXTEND_DATA.table is unqualified, EXTEND_DATA.unit is the qualified name.
  targetTable: EXTEND_DATA.unit,
  unit: EXTEND_DATA.unit,
  columns: LEGACY_COLUMNS.map(extendDataColumn),
  // The integer identity keeps its legacy value; target-created rows draw from people.extend_data_user_activity_dataid_seq.
  key: ['dataID'],
  // Values hold no Type: the apply row's discriminator is the owning tusers.Type, reached through baseID = UserID or, for
  // address values, baseID = tuseraddresses.addressID then userID, as table ownership's split joins give it. This is
  // identity's Type=1 rule with value 2, so a row whose owner does not resolve carries no discriminator and neither side takes it.
  split: { by: 'Type', value: 2 },
  // Table ownership resolves this table as siteID-or-umbrella and TenantSource takes one source, so the tenant comes from
  // siteID rather than the owner row, as for identity's share. Masa saves user values with the user's SiteID and address
  // values with the address's, which is its user's (core/mura/user/userManager.cfc:643-647,887-888,926-931), so both give the owner's tenant.
  tenant: { kind: 'site', column: 'siteID' },
});
