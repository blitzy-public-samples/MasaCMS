import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn, TenantSource } from '@opt2/platform/migration-kit';
import { CREDENTIAL, GROUP_ACCOUNT, LOGIN_STATE, USER_ACCOUNT } from '../../repo/tables.js';
import type { IdentityUnitTableDefinition } from '../../repo/tables.js';

const LEGACY_TABLE = 'tusers';

// Live tusers spelling in catalog order: core/setup/db/mssql.sql:467-505, then tablist (core/mura/dbUpdates/5.2.1932.cfm:18).
const TUSERS_COLUMNS = [
  'UserID', 'GroupName', 'Fname', 'Lname', 'UserName', 'Password', 'PasswordCreated', 'Email', 'Company', 'JobTitle',
  'mobilePhone', 'Website', 'Type', 'subType', 'Ext', 'ContactForm', 'Admin', 'S2', 'LastLogin', 'LastUpdate',
  'LastUpdateBy', 'LastUpdateByID', 'Perm', 'InActive', 'isPublic', 'SiteID', 'Subscribe', 'notes', 'description',
  'interests', 'keepPrivate', 'photoFileID', 'IMName', 'IMService', 'created', 'remoteID', 'tags', 'tablist',
] as const;

type TusersColumn = (typeof TUSERS_COLUMNS)[number];

// Declared, not left to defineMapping's default: credential and login state do not map SiteID, so it cannot be derived.
const TENANT: TenantSource = { kind: 'site', column: 'SiteID' };

/** Mapping columns for `legacy`, each with the target name and canonical type of its column in `definition`. */
function columnsOf(definition: IdentityUnitTableDefinition, legacy: readonly TusersColumn[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(LEGACY_TABLE, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

// Each split names the row's own Type column: the migration orchestrator sends no separate discriminator for tusers rows.

/** tusers (Type=1) → identity.group_account [mssql.sql:467-505, 5.2.1932.cfm:18]. */
export const tusersGroupAccountMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: GROUP_ACCOUNT.unit,
  unit: GROUP_ACCOUNT.unit,
  columns: columnsOf(GROUP_ACCOUNT, TUSERS_COLUMNS),
  key: GROUP_ACCOUNT.key,
  split: { by: 'Type', value: 1, column: 'Type' },
  tenant: TENANT,
});

/** tusers (Type=2) account columns → identity.user_account [mssql.sql:467-505, 5.2.1932.cfm:18]. */
export const tusersUserAccountMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: USER_ACCOUNT.unit,
  unit: USER_ACCOUNT.unit,
  columns: columnsOf(USER_ACCOUNT, [
    'UserID', 'UserName', 'Type', 'Admin', 'S2', 'Perm', 'InActive', 'isPublic', 'SiteID', 'remoteID', 'tablist',
  ]),
  key: USER_ACCOUNT.key,
  split: { by: 'Type', value: 2, column: 'Type' },
  tenant: TENANT,
});

/** tusers (Type=2) Password and PasswordCreated → identity.credential [mssql.sql:467-505]. */
export const tusersCredentialMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: CREDENTIAL.unit,
  unit: CREDENTIAL.unit,
  columns: columnsOf(CREDENTIAL, ['UserID', 'Password', 'PasswordCreated']),
  key: CREDENTIAL.key,
  split: { by: 'Type', value: 2, column: 'Type' },
  tenant: TENANT,
});

/** tusers (Type=2) LastLogin → identity.login_state [mssql.sql:467-505]. */
export const tusersLoginStateMapping: Mapping = defineMapping({
  legacyTable: LEGACY_TABLE,
  targetTable: LOGIN_STATE.unit,
  unit: LOGIN_STATE.unit,
  columns: columnsOf(LOGIN_STATE, ['UserID', 'LastLogin']),
  key: LOGIN_STATE.key,
  split: { by: 'Type', value: 2, column: 'Type' },
  tenant: TENANT,
});
