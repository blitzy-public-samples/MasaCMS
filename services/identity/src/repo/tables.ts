/** Owned tables of schema `identity`, as the platform repository declares them. */
import type { CanonicalColumn, CanonicalType, TableDefinition } from '@opt2/platform/migration-kit';

/** Units of write authority of schema `identity`, as `opt2/table-ownership.json` names them, in migration order. */
export const IDENTITY_UNITS = [
  'identity.group_account',
  'identity.user_account',
  'identity.credential',
  'identity.login_state',
  'identity.membership',
  'identity.permission',
  'identity.user_address',
  'identity.user_interest',
  'identity.user_tag',
  'identity.user_favorite',
  'identity.extend_data_user_activity',
  'identity.user_strike',
  'identity.remote_session',
  'identity.user_device',
  'identity.redirect',
  'identity.oauth_client',
  'identity.oauth_token',
  'identity.trash',
] as const;

/** One identity unit id. */
export type IdentityUnit = (typeof IDENTITY_UNITS)[number];

/** Identity tables without a unit: never migrated, projected or gated, but still written with changelog rows. */
export const NON_UNIT_TABLE_NAMES = ['session', 'csrf_claim', 'account_operation', 'person_contact', 'aggregate_version'] as const;

type NonUnitTableName = (typeof NON_UNIT_TABLE_NAMES)[number];
type TableOfUnit<U extends string> = U extends `identity.${infer T}` ? T : never;

/** Name of one owned `identity` table. */
export type IdentityTableName = TableOfUnit<IdentityUnit> | NonUnitTableName;

/** An identity table definition whose table name is `T`. */
export interface IdentityTableDefinition<T extends IdentityTableName = IdentityTableName> extends TableDefinition {
  table: T;
}

/** A gated identity table definition whose unit is `U`. */
export interface IdentityUnitTableDefinition<U extends IdentityUnit = IdentityUnit> extends IdentityTableDefinition<TableOfUnit<U>> {
  unit: U;
}

type Columns = readonly CanonicalColumn[];
type ColumnName<C extends Columns> = C[number]['name'];
type Key<C extends Columns> = readonly [ColumnName<C>, ...ColumnName<C>[]];

const UNIT_PREFIX = 'identity.';
const TENANT_ID = { name: 'tenant_id', type: 's' } as const satisfies CanonicalColumn;

function unitTable<U extends IdentityUnit, C extends Columns>(unit: U, columns: C, key: Key<C>): IdentityUnitTableDefinition<U> {
  return { table: unit.slice(UNIT_PREFIX.length) as TableOfUnit<U>, columns: [...columns], key: [...key], unit };
}

function nonUnitTable<T extends NonUnitTableName, C extends Columns>(table: T, columns: C, key: Key<C>): IdentityTableDefinition<T> {
  return { table, columns: [...columns], key: [...key] };
}

const GROUP_ACCOUNT_COLUMNS = [
  TENANT_ID,
  { name: 'userid', type: 's' },
  { name: 'groupname', type: 's' },
  { name: 'fname', type: 's' },
  { name: 'lname', type: 's' },
  { name: 'username', type: 's' },
  { name: 'password', type: 's' },
  { name: 'passwordcreated', type: 't' },
  { name: 'email', type: 's' },
  { name: 'company', type: 's' },
  { name: 'jobtitle', type: 's' },
  { name: 'mobilephone', type: 's' },
  { name: 'website', type: 's' },
  { name: 'type', type: 'i' },
  { name: 'subtype', type: 's' },
  { name: 'ext', type: 'i' },
  { name: 'contactform', type: 's' },
  { name: 'admin', type: 'i' },
  { name: 's2', type: 'i' },
  { name: 'lastlogin', type: 't' },
  { name: 'lastupdate', type: 't' },
  { name: 'lastupdateby', type: 's' },
  { name: 'lastupdatebyid', type: 's' },
  { name: 'perm', type: 'i' },
  { name: 'inactive', type: 'i' },
  { name: 'ispublic', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'subscribe', type: 'i' },
  { name: 'notes', type: 's' },
  { name: 'description', type: 's' },
  { name: 'interests', type: 's' },
  { name: 'keepprivate', type: 'i' },
  { name: 'photofileid', type: 's' },
  { name: 'imname', type: 's' },
  { name: 'imservice', type: 's' },
  { name: 'created', type: 't' },
  { name: 'remoteid', type: 's' },
  { name: 'tags', type: 's' },
  { name: 'tablist', type: 's' },
  { name: 'row_version', type: 'i' },
] as const satisfies Columns;

/** `identity.group_account`: Masa `tusers` Type=1 rows, plus the target-only `row_version` of `identity.group.changed.v1`. */
export const GROUP_ACCOUNT = unitTable('identity.group_account', GROUP_ACCOUNT_COLUMNS, ['userid']);

const USER_ACCOUNT_COLUMNS = [
  TENANT_ID,
  { name: 'userid', type: 's' },
  { name: 'username', type: 's' },
  { name: 'type', type: 'i' },
  { name: 'admin', type: 'i' },
  { name: 's2', type: 'i' },
  { name: 'perm', type: 'i' },
  { name: 'inactive', type: 'i' },
  { name: 'ispublic', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'tablist', type: 's' },
  { name: 'opt2_state', type: 's' },
] as const satisfies Columns;

/** `identity.user_account`: account columns of Masa `tusers` Type=2 rows, plus the target-only `opt2_state`. */
export const USER_ACCOUNT = unitTable('identity.user_account', USER_ACCOUNT_COLUMNS, ['userid']);

const CREDENTIAL_COLUMNS = [
  TENANT_ID,
  { name: 'userid', type: 's' },
  { name: 'password', type: 's' },
  { name: 'passwordcreated', type: 't' },
] as const satisfies Columns;

/** `identity.credential`: `Password` and `PasswordCreated` of Masa `tusers` Type=2 rows. */
export const CREDENTIAL = unitTable('identity.credential', CREDENTIAL_COLUMNS, ['userid']);

const LOGIN_STATE_COLUMNS = [TENANT_ID, { name: 'userid', type: 's' }, { name: 'lastlogin', type: 't' }] as const satisfies Columns;

/** `identity.login_state`: `LastLogin` of Masa `tusers` Type=2 rows. */
export const LOGIN_STATE = unitTable('identity.login_state', LOGIN_STATE_COLUMNS, ['userid']);

const MEMBERSHIP_COLUMNS = [TENANT_ID, { name: 'userid', type: 's' }, { name: 'groupid', type: 's' }] as const satisfies Columns;

/** `identity.membership`, from Masa `tusersmemb`. */
export const MEMBERSHIP = unitTable('identity.membership', MEMBERSHIP_COLUMNS, ['userid', 'groupid']);

const PERMISSION_COLUMNS = [
  TENANT_ID,
  { name: 'contentid', type: 's' },
  { name: 'groupid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'type', type: 's' },
] as const satisfies Columns;

/** `identity.permission`, from Masa `tpermissions`. */
export const PERMISSION = unitTable('identity.permission', PERMISSION_COLUMNS, ['contentid', 'groupid', 'siteid', 'type']);

const GROUP_ADDRESS_COLUMNS = [
  TENANT_ID,
  { name: 'addressid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'addressname', type: 's' },
  { name: 'address1', type: 's' },
  { name: 'address2', type: 's' },
  { name: 'city', type: 's' },
  { name: 'state', type: 's' },
  { name: 'zip', type: 's' },
  { name: 'country', type: 's' },
  { name: 'phone', type: 's' },
  { name: 'fax', type: 's' },
  { name: 'isprimary', type: 'i' },
  { name: 'addressnotes', type: 's' },
  { name: 'addressurl', type: 's' },
  { name: 'longitude', type: 'f' },
  { name: 'latitude', type: 'f' },
  { name: 'addressemail', type: 's' },
  { name: 'hours', type: 's' },
] as const satisfies Columns;

// The five group child tables keep the shared legacy table's name and unit id; they hold only rows of Type=1 owners.
/** `identity.user_address`: Masa `tuseraddresses` rows of groups. */
export const GROUP_ADDRESS = unitTable('identity.user_address', GROUP_ADDRESS_COLUMNS, ['addressid']);

const GROUP_INTEREST_COLUMNS = [TENANT_ID, { name: 'userid', type: 's' }, { name: 'categoryid', type: 's' }] as const satisfies Columns;

/** `identity.user_interest`: Masa `tusersinterests` rows of groups. */
export const GROUP_INTEREST = unitTable('identity.user_interest', GROUP_INTEREST_COLUMNS, ['userid', 'categoryid']);

const GROUP_TAG_COLUMNS = [
  TENANT_ID,
  { name: 'tagid', type: 'i' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'tag', type: 's' },
] as const satisfies Columns;

/** `identity.user_tag`: Masa `tuserstags` rows of groups. */
export const GROUP_TAG = unitTable('identity.user_tag', GROUP_TAG_COLUMNS, ['tagid']);

const GROUP_FAVORITE_COLUMNS = [
  TENANT_ID,
  { name: 'favoriteid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'favoritename', type: 's' },
  { name: 'favorite', type: 's' },
  { name: 'type', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'datecreated', type: 't' },
  { name: 'columnnumber', type: 'i' },
  { name: 'rownumber', type: 'i' },
  { name: 'maxrssitems', type: 'i' },
] as const satisfies Columns;

/** `identity.user_favorite`: Masa `tusersfavorites` rows of groups. */
export const GROUP_FAVORITE = unitTable('identity.user_favorite', GROUP_FAVORITE_COLUMNS, ['favoriteid']);

const GROUP_EXTEND_DATA_COLUMNS = [
  TENANT_ID,
  { name: 'dataid', type: 'i' },
  { name: 'baseid', type: 's' },
  { name: 'attributeid', type: 'i' },
  { name: 'siteid', type: 's' },
  { name: 'attributevalue', type: 's' },
  { name: 'remoteid', type: 's' },
  { name: 'datetimevalue', type: 't' },
  { name: 'numericvalue', type: 'f' },
  { name: 'stringvalue', type: 's' },
] as const satisfies Columns;

/** `identity.extend_data_user_activity`: Masa `tclassextenddatauseractivity` rows of groups. */
export const GROUP_EXTEND_DATA = unitTable('identity.extend_data_user_activity', GROUP_EXTEND_DATA_COLUMNS, ['dataid']);

const USER_STRIKE_COLUMNS = [
  TENANT_ID,
  { name: 'username', type: 's' },
  { name: 'strikes', type: 'i' },
  { name: 'lastattempt', type: 't' },
] as const satisfies Columns;

/** `identity.user_strike`, from Masa `tuserstrikes`. */
export const USER_STRIKE = unitTable('identity.user_strike', USER_STRIKE_COLUMNS, ['username']);

const REMOTE_SESSION_COLUMNS = [
  TENANT_ID,
  { name: 'userid', type: 's' },
  { name: 'authtoken', type: 's' },
  { name: 'data', type: 's' },
  { name: 'created', type: 't' },
  { name: 'lastaccessed', type: 't' },
] as const satisfies Columns;

/** `identity.remote_session`, from Masa `tuserremotesessions`. */
export const REMOTE_SESSION = unitTable('identity.remote_session', REMOTE_SESSION_COLUMNS, ['userid']);

const USER_DEVICE_COLUMNS = [
  TENANT_ID,
  { name: 'siteid', type: 's' },
  { name: 'created', type: 't' },
  { name: 'deviceid', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'lastlogin', type: 't' },
] as const satisfies Columns;

/** `identity.user_device`, from the ORM table `tuserdevice`. */
export const USER_DEVICE = unitTable('identity.user_device', USER_DEVICE_COLUMNS, ['deviceid']);

const REDIRECT_COLUMNS = [
  TENANT_ID,
  { name: 'redirectid', type: 's' },
  { name: 'url', type: 's' },
  { name: 'created', type: 't' },
  { name: 'userid', type: 's' },
  { name: 'siteid', type: 's' },
] as const satisfies Columns;

/** `identity.redirect`, from Masa `tredirects`. */
export const REDIRECT = unitTable('identity.redirect', REDIRECT_COLUMNS, ['redirectid']);

const OAUTH_CLIENT_COLUMNS = [
  TENANT_ID,
  { name: 'clientsecret', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'granttype', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'clientid', type: 's' },
  { name: 'name', type: 's' },
  { name: 'created', type: 't' },
  { name: 'lastupdate', type: 't' },
  { name: 'description', type: 's' },
  { name: 'redirecturl', type: 's' },
  // Legacy column name, misspelling included.
  { name: 'lastupdatebidy', type: 's' },
  { name: 'lastupdateby', type: 's' },
] as const satisfies Columns;

/** `identity.oauth_client`, from the ORM table `toauthclients`. */
export const OAUTH_CLIENT = unitTable('identity.oauth_client', OAUTH_CLIENT_COLUMNS, ['clientid']);

const OAUTH_TOKEN_COLUMNS = [
  TENANT_ID,
  { name: 'granttype', type: 's' },
  { name: 'userid', type: 's' },
  { name: 'clientid', type: 's' },
  { name: 'accesscode', type: 's' },
  { name: 'data', type: 's' },
  { name: 'expires', type: 't' },
  { name: 'token', type: 's' },
] as const satisfies Columns;

/** `identity.oauth_token`, from the ORM table `toauthtokens`; `data` is a serialized session document, kept byte-exact. */
export const OAUTH_TOKEN = unitTable('identity.oauth_token', OAUTH_TOKEN_COLUMNS, ['token']);

const GROUP_TRASH_COLUMNS = [
  TENANT_ID,
  { name: 'objectid', type: 's' },
  { name: 'parentid', type: 's' },
  { name: 'siteid', type: 's' },
  { name: 'objectlabel', type: 's' },
  { name: 'objectclass', type: 's' },
  { name: 'objecttype', type: 's' },
  { name: 'objectsubtype', type: 's' },
  { name: 'objectstring', type: 's' },
  { name: 'deleteddate', type: 't' },
  { name: 'deletedby', type: 's' },
  { name: 'deleteid', type: 's' },
  { name: 'orderno', type: 'i' },
] as const satisfies Columns;

/** `identity.trash`: Masa `ttrash` rows of the identity objectClass share; `objectstring` is byte-exact WDDX. */
export const GROUP_TRASH = unitTable('identity.trash', GROUP_TRASH_COLUMNS, ['objectid']);

const SESSION_COLUMNS = [
  TENANT_ID,
  { name: 'session_id', type: 's' },
  { name: 'user_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'login_snapshot', type: 's' },
  { name: 'epoch', type: 'i' },
  { name: 'csrf_secret', type: 's' },
  { name: 'mode', type: 's' },
  { name: 'state', type: 's' },
  { name: 'jar_ref', type: 's' },
  { name: 'created_at', type: 't' },
  { name: 'updated_at', type: 't' },
  { name: 'ended_at', type: 't' },
] as const satisfies Columns;

/** `identity.session`: browser sessions with their login-time snapshot and CSRF secret. */
export const SESSION = nonUnitTable('session', SESSION_COLUMNS, ['session_id']);

const CSRF_CLAIM_COLUMNS = [
  TENANT_ID,
  { name: 'session_id', type: 's' },
  { name: 'token', type: 's' },
  { name: 'state', type: 's' },
  { name: 'request_id', type: 's' },
  { name: 'claimed_at', type: 't' },
  { name: 'used_at', type: 't' },
] as const satisfies Columns;

/** `identity.csrf_claim`: the single-use ledger of CSRF tokens shared with legacy sessions. */
export const CSRF_CLAIM = nonUnitTable('csrf_claim', CSRF_CLAIM_COLUMNS, ['session_id', 'token']);

const ACCOUNT_OPERATION_COLUMNS = [
  TENANT_ID,
  { name: 'operation_id', type: 's' },
  { name: 'user_id', type: 's' },
  { name: 'kind', type: 's' },
  { name: 'state', type: 's' },
  { name: 'username', type: 's' },
  { name: 'pending_change', type: 's' },
  { name: 'before_values', type: 's' },
  { name: 'commit_xid', type: 's' },
  { name: 'created_at', type: 't' },
  { name: 'updated_at', type: 't' },
] as const satisfies Columns;

/** `identity.account_operation`: the account side of a roster write operation. */
export const ACCOUNT_OPERATION = nonUnitTable('account_operation', ACCOUNT_OPERATION_COLUMNS, ['operation_id']);

const PERSON_CONTACT_COLUMNS = [
  TENANT_ID,
  { name: 'user_id', type: 's' },
  { name: 'site_id', type: 's' },
  { name: 'email', type: 's' },
  { name: 'fname', type: 's' },
  { name: 'lname', type: 's' },
  { name: 'company', type: 's' },
  { name: 'subtype', type: 's' },
  { name: 'aggregate_version', type: 'i' },
  { name: 'updated_at', type: 't' },
] as const satisfies Columns;

/** `identity.person_contact`: the projection of `people.person.changed.v1` used for mail and lookup by email. */
export const PERSON_CONTACT = nonUnitTable('person_contact', PERSON_CONTACT_COLUMNS, ['user_id']);

const AGGREGATE_VERSION_COLUMNS = [
  TENANT_ID,
  { name: 'aggregate_type', type: 's' },
  { name: 'aggregate_id', type: 's' },
  { name: 'row_version', type: 'i' },
] as const satisfies Columns;

/** `identity.aggregate_version`: per-aggregate event sequences of membership and permission events. */
export const AGGREGATE_VERSION = nonUnitTable('aggregate_version', AGGREGATE_VERSION_COLUMNS, ['aggregate_type', 'aggregate_id']);

/** Table definitions position for position with the unit tuple `T`. */
type TablesForUnits<T extends readonly IdentityUnit[]> = { readonly [I in keyof T]: IdentityUnitTableDefinition<T[I] & IdentityUnit> };

/** Every unit table, in `IDENTITY_UNITS` order. */
export const UNIT_TABLES: TablesForUnits<typeof IDENTITY_UNITS> = [
  GROUP_ACCOUNT,
  USER_ACCOUNT,
  CREDENTIAL,
  LOGIN_STATE,
  MEMBERSHIP,
  PERMISSION,
  GROUP_ADDRESS,
  GROUP_INTEREST,
  GROUP_TAG,
  GROUP_FAVORITE,
  GROUP_EXTEND_DATA,
  USER_STRIKE,
  REMOTE_SESSION,
  USER_DEVICE,
  REDIRECT,
  OAUTH_CLIENT,
  OAUTH_TOKEN,
  GROUP_TRASH,
];

/** Every owned table, unit tables first, in migration order; the `tables` of the identity repository. */
export const OWNED_TABLES: readonly IdentityTableDefinition[] = [
  ...UNIT_TABLES,
  SESSION,
  CSRF_CLAIM,
  ACCOUNT_OPERATION,
  PERSON_CONTACT,
  AGGREGATE_VERSION,
];

// Row shapes are type aliases, not interfaces, so they stay assignable to the repository's Record<string, unknown> rows.

/** pg value of a canonical tag; int8 columns, which pg returns as decimal strings, are overridden per table. */
type ColumnValue<T extends CanonicalType> = T extends 's' | 'd' ? string : T extends 'i' | 'f' ? number : T extends 't' ? Date : Buffer;

/** A row of columns `C` as pg returns it; `NotNull` columns are never null. */
type RowOf<C extends Columns, NotNull extends ColumnName<C>> = {
  [K in C[number] as K['name']]: ColumnValue<K['type']> | (K['name'] extends NotNull ? never : null);
};

/** Row `R` with the value types `O` names replaced, keeping each column's nullability. */
type Override<R, O extends Partial<Record<keyof R, unknown>>> = {
  [K in keyof R]: K extends keyof O ? O[K] | (null extends R[K] ? null : never) : R[K];
};

/** `user_account.opt2_state`: `pending` while a roster create is prepared but not committed. */
export type AccountState = 'active' | 'pending';
/** `session.mode`. */
export type SessionMode = 'legacy-primary' | 'target-primary';
/** `session.state`. */
export type SessionState = 'active' | 'ended';
/** `csrf_claim.state`. */
export type CsrfClaimState = 'pending-legacy' | 'used';
/** `account_operation.kind`. */
export type AccountOperationKind = 'create' | 'update';
/** `account_operation.state`; `prepared` and `committed` operations are open. */
export type AccountOperationState = 'prepared' | 'committed' | 'aborted' | 'reverted' | 'finished';

/** The user struct and role list `loginByQuery` fixes at login, as `setUserStruct` receives them. */
export interface LoginSnapshot {
  userid: string;
  username: string | null;
  siteid: string | null;
  subtype: string | null;
  password: string | null;
  fname: string | null;
  lname: string | null;
  email: string | null;
  remoteid: string | null;
  company: string | null;
  /** Canonical `t` timestamp text. */
  lastlogin: string | null;
  /** Canonical `t` timestamp text. */
  passwordcreated: string | null;
  /** Comma list of `groupname;siteid;isPublic`, `S2IsPrivate;siteid` and `S2IsPrivate` (or the `S2IsPublic` pair), `S2`, `username;username;siteid`. */
  roleList: string;
  /** Comma list of the member group ids, then the user's own id. */
  membershipIds: string;
}

/** A `group_account` row; the int8 `row_version` arrives as a decimal string. */
export type GroupAccountRow = Override<RowOf<typeof GROUP_ACCOUNT_COLUMNS, 'tenant_id' | 'userid' | 'row_version'>, { row_version: string }>;
/** A `user_account` row. */
export type UserAccountRow = Override<RowOf<typeof USER_ACCOUNT_COLUMNS, 'tenant_id' | 'userid' | 'opt2_state'>, { opt2_state: AccountState }>;
/** A `credential` row. */
export type CredentialRow = RowOf<typeof CREDENTIAL_COLUMNS, 'tenant_id' | 'userid'>;
/** A `login_state` row. */
export type LoginStateRow = RowOf<typeof LOGIN_STATE_COLUMNS, 'tenant_id' | 'userid'>;
/** A `membership` row. */
export type MembershipRow = RowOf<typeof MEMBERSHIP_COLUMNS, 'tenant_id' | 'userid' | 'groupid'>;
/** A `permission` row. */
export type PermissionRow = RowOf<typeof PERMISSION_COLUMNS, 'tenant_id' | 'contentid' | 'groupid' | 'siteid' | 'type'>;
/** A `user_address` row of a group. */
export type GroupAddressRow = RowOf<typeof GROUP_ADDRESS_COLUMNS, 'tenant_id' | 'addressid'>;
/** A `user_interest` row of a group. */
export type GroupInterestRow = RowOf<typeof GROUP_INTEREST_COLUMNS, 'tenant_id' | 'userid' | 'categoryid'>;
/** A `user_tag` row of a group. */
export type GroupTagRow = RowOf<typeof GROUP_TAG_COLUMNS, 'tenant_id' | 'tagid'>;
/** A `user_favorite` row of a group. */
export type GroupFavoriteRow = RowOf<
  typeof GROUP_FAVORITE_COLUMNS,
  'tenant_id' | 'favoriteid' | 'userid' | 'favorite' | 'type' | 'datecreated'
>;
/** An `extend_data_user_activity` row of a group. */
export type GroupExtendDataRow = RowOf<typeof GROUP_EXTEND_DATA_COLUMNS, 'tenant_id' | 'dataid' | 'baseid' | 'attributeid'>;
/** A `user_strike` row. */
export type UserStrikeRow = RowOf<typeof USER_STRIKE_COLUMNS, 'tenant_id' | 'username'>;
/** A `remote_session` row. */
export type RemoteSessionRow = RowOf<typeof REMOTE_SESSION_COLUMNS, 'tenant_id' | 'userid' | 'created' | 'lastaccessed'>;
/** A `user_device` row. */
export type UserDeviceRow = RowOf<typeof USER_DEVICE_COLUMNS, 'tenant_id' | 'deviceid'>;
/** A `redirect` row. */
export type RedirectRow = RowOf<typeof REDIRECT_COLUMNS, 'tenant_id' | 'redirectid'>;
/** An `oauth_client` row. */
export type OAuthClientRow = RowOf<typeof OAUTH_CLIENT_COLUMNS, 'tenant_id' | 'siteid' | 'clientid' | 'name'>;
/** An `oauth_token` row. */
export type OAuthTokenRow = RowOf<typeof OAUTH_TOKEN_COLUMNS, 'tenant_id' | 'clientid' | 'expires' | 'token'>;
/** A `trash` row of the identity share. */
export type GroupTrashRow = RowOf<
  typeof GROUP_TRASH_COLUMNS,
  'tenant_id' | 'objectid' | 'parentid' | 'siteid' | 'objectlabel' | 'objectclass' | 'objecttype' | 'objectsubtype' | 'deletedby'
>;
/** A `session` row; `login_snapshot` is the JSON text of a {@link LoginSnapshot}, and the int8 `epoch` a decimal string. */
export type SessionRow = Override<
  RowOf<typeof SESSION_COLUMNS, 'tenant_id' | 'session_id' | 'epoch' | 'csrf_secret' | 'mode' | 'state' | 'created_at' | 'updated_at'>,
  { epoch: string; mode: SessionMode; state: SessionState }
>;
/** A `csrf_claim` row. */
export type CsrfClaimRow = Override<
  RowOf<typeof CSRF_CLAIM_COLUMNS, 'tenant_id' | 'session_id' | 'token' | 'state' | 'claimed_at'>,
  { state: CsrfClaimState }
>;
/** An `account_operation` row; `pending_change` and `before_values` are JSON text, `commit_xid` the xid8 decimal text. */
export type AccountOperationRow = Override<
  RowOf<typeof ACCOUNT_OPERATION_COLUMNS, 'tenant_id' | 'operation_id' | 'user_id' | 'kind' | 'state' | 'created_at' | 'updated_at'>,
  { kind: AccountOperationKind; state: AccountOperationState }
>;
/** A `person_contact` row; the int8 `aggregate_version` arrives as a decimal string. */
export type PersonContactRow = Override<
  RowOf<typeof PERSON_CONTACT_COLUMNS, 'tenant_id' | 'user_id' | 'aggregate_version' | 'updated_at'>,
  { aggregate_version: string }
>;
/** An `aggregate_version` row; the int8 `row_version` arrives as a decimal string. */
export type AggregateVersionRow = Override<
  RowOf<typeof AGGREGATE_VERSION_COLUMNS, 'tenant_id' | 'aggregate_type' | 'aggregate_id' | 'row_version'>,
  { row_version: string }
>;

