import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { MEMBERSHIP, PERMISSION } from '../../repo/tables.js';
import type { IdentityUnitTableDefinition } from '../../repo/tables.js';

/** Mapping columns for `legacy` names of `legacyTable`, each with the target name and canonical type of its column in `definition`. */
function columnsOf(legacyTable: string, definition: IdentityUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** tusersmemb → identity.membership, in the member's tenant [mssql.sql:528-531,780-785; 7.1.cfm:225-226]. */
export const tusersmembMapping: Mapping = defineMapping({
  legacyTable: 'tusersmemb',
  targetTable: MEMBERSHIP.unit,
  unit: MEMBERSHIP.unit,
  columns: columnsOf('tusersmemb', MEMBERSHIP, ['UserID', 'GroupID']),
  key: MEMBERSHIP.key,
  // A mapping takes one tenant source: the member's tusers row (table-ownership tenantParent). Without that row the
  // platform loads the membership under the umbrella tenant as an orphan; the group's own site is not consulted.
  tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: { UserID: 'UserID' } },
});

/** tpermissions → identity.permission, in the tenant of its own SiteID [mssql.sql:334-339,878-885; 7.1.cfm:22]. */
export const tpermissionsMapping: Mapping = defineMapping({
  legacyTable: 'tpermissions',
  targetTable: PERMISSION.unit,
  unit: PERMISSION.unit,
  columns: columnsOf('tpermissions', PERMISSION, ['ContentID', 'GroupID', 'SiteID', 'Type']),
  key: PERMISSION.key,
  tenant: { kind: 'site', column: 'SiteID' },
});
