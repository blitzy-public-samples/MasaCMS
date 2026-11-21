import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { GROUP_TRASH, OAUTH_CLIENT, OAUTH_TOKEN, REDIRECT, REMOTE_SESSION, USER_DEVICE, USER_STRIKE } from '../../repo/tables.js';
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

/** tuserstrikes → identity.user_strike [5.2.0.cfm:316-335]. */
export const tuserstrikesMapping: Mapping = defineMapping({
  legacyTable: 'tuserstrikes',
  targetTable: USER_STRIKE.unit,
  unit: USER_STRIKE.unit,
  columns: columnsOf('tuserstrikes', USER_STRIKE, ['username', 'strikes', 'lastAttempt']),
  key: USER_STRIKE.key,
  // Strikes hold only a username: the tenant is that of the account with that UserName, else the umbrella (orphan),
  // the same tenant login uses for its strike reads and writes.
  tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: { username: 'UserName' } },
});

/** tuserremotesessions → identity.remote_session [5.2.0.cfm:86-107]. */
export const tuserremotesessionsMapping: Mapping = defineMapping({
  legacyTable: 'tuserremotesessions',
  targetTable: REMOTE_SESSION.unit,
  unit: REMOTE_SESSION.unit,
  columns: columnsOf('tuserremotesessions', REMOTE_SESSION, ['userID', 'authToken', 'data', 'created', 'lastAccessed']),
  key: REMOTE_SESSION.key,
  tenant: { kind: 'parent', parentLegacyTable: 'tusers', columns: { userID: 'UserID' } },
});

// A mapping takes one tenant source, so tuserdevice and tredirects follow the ownership rule siteID-or-umbrella:
// a row without a siteID (pre-7.0 redirects) loads under the umbrella as an orphan rather than under its user's tenant.

/** tuserdevice → identity.user_device [userDeviceBean.cfc:1-7]. */
export const tuserdeviceMapping: Mapping = defineMapping({
  legacyTable: 'tuserdevice',
  targetTable: USER_DEVICE.unit,
  unit: USER_DEVICE.unit,
  columns: columnsOf('tuserdevice', USER_DEVICE, ['siteID', 'created', 'deviceid', 'userID', 'lastLogin']),
  key: USER_DEVICE.key,
  tenant: { kind: 'site', column: 'siteID' },
});

/** tredirects → identity.redirect [mssql.sql:342-346, 7.0.cfm:32-36, userRedirectBean.cfc:1-6]. */
export const tredirectsMapping: Mapping = defineMapping({
  legacyTable: 'tredirects',
  targetTable: REDIRECT.unit,
  unit: REDIRECT.unit,
  columns: columnsOf('tredirects', REDIRECT, ['redirectID', 'URL', 'created', 'userid', 'siteid']),
  key: REDIRECT.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** toauthclients → identity.oauth_client [oauthClientBean.cfc:1-14]. */
export const toauthclientsMapping: Mapping = defineMapping({
  legacyTable: 'toauthclients',
  targetTable: OAUTH_CLIENT.unit,
  unit: OAUTH_CLIENT.unit,
  columns: columnsOf('toauthclients', OAUTH_CLIENT, [
    'clientsecret', 'siteid', 'granttype', 'userid', 'clientid', 'name', 'created', 'lastupdate', 'description',
    'redirecturl', 'lastupdatebidy', 'lastupdateby',
  ]),
  key: OAUTH_CLIENT.key,
  tenant: { kind: 'site', column: 'siteid' },
});

/** toauthtokens → identity.oauth_token, tenant of the owning client [oauthTokenBean.cfc:1-8]. */
export const toauthtokensMapping: Mapping = defineMapping({
  legacyTable: 'toauthtokens',
  targetTable: OAUTH_TOKEN.unit,
  unit: OAUTH_TOKEN.unit,
  columns: columnsOf('toauthtokens', OAUTH_TOKEN, ['granttype', 'userid', 'clientid', 'accessCode', 'data', 'expires', 'token']),
  key: OAUTH_TOKEN.key,
  tenant: { kind: 'parent', parentLegacyTable: 'toauthclients', columns: { clientid: 'clientid' } },
});

/** ttrash rows whose class-map owner is identity → identity.trash [5.2.1.2893.cfm:7-18, 5.7.cfm:104-107]. */
export const ttrashGroupMapping: Mapping = defineMapping({
  legacyTable: 'ttrash',
  targetTable: GROUP_TRASH.unit,
  unit: GROUP_TRASH.unit,
  columns: columnsOf('ttrash', GROUP_TRASH, [
    'objectID', 'parentID', 'siteID', 'objectLabel', 'objectClass', 'objectType', 'objectSubType', 'objectstring',
    'deletedDate', 'deletedBy', 'deleteid', 'orderno',
  ]),
  key: GROUP_TRASH.key,
  // The identity share (`group`, `user` stored as a Group, `address` of a Type=1 owner) needs the stored or owning
  // user's Type, which no ttrash column holds alone: each apply row's discriminator is its class-map owner.
  split: { by: 'objectClass', value: 'identity' },
  tenant: { kind: 'site', column: 'siteID' },
});
