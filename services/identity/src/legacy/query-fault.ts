// SQL Server failures of the identity statements Masa's cfquery runs, with the cfcatch fields onError's debug page prints
// (core/appcfc/onError_include.cfm:177-288; core/mura/user/userDAO.cfc:300-347, 404-455, 749-808, 895-914; core/mura/permission.cfc:643-669).
import {
  primaryKeyFault,
  statementFault,
  statementValues,
  windows1252Text,
  type LegacyQueryFault,
  type QueryFaultEnv,
  type StatementColumn,
} from '@opt2/platform/legacy-compat';

/** The values `userDAO.create` and `userDAO.update` inline, as CFML text. */
export interface UserInline {
  userid: string;
  s2: string;
  type: string;
  inactive: string;
  perm: string;
  ispublic: string;
  subscribe: string;
  keepprivate: string;
}

/** `userDAO.create`'s INSERT as cfcatch reports it. */
export function userInsertSql(v: UserInline): string {
  return (
    'INSERT INTO tusers  (UserID, RemoteID, s2, Fname, Lname, Password, PasswordCreated,\n\t\tEmail, GroupName, Type, subType, ContactForm, ' +
    'LastUpdate, lastupdateby, lastupdatebyid,InActive, username,  perm, isPublic,\n\t\tcompany,jobtitle,subscribe,siteid,website,notes,mobilePhone,' +
    '\n\t\tdescription,interests,photoFileID,keepPrivate,IMName,IMService,created,tags, tablist)\n     VALUES(\n' +
    `         '${v.userid}',\n\t\t  (param 1) ,\n\t\t ${v.s2},\n\t\t  (param 2) ,\n\t\t   (param 3) ,\n          (param 4) ,\n` +
    `\t\t  (param 5) ,\n\t\t  (param 6) ,\n          (param 7) ,\n         ${v.type},\n\t\t  (param 8) ,\n         (param 9) ,\n` +
    `\t\t  (param 10) ,\n\t\t  (param 11) ,\n\t\t  (param 12) ,\n\t\t ${v.inactive},\n\t\t  (param 13) ,\n\t\t  ${v.perm},\n` +
    `\t\t  ${v.ispublic},\n\t\t    (param 14) ,\n\t\t    (param 15) ,\n\t\t  ${v.subscribe},\n\t\t    (param 16) ,\n\t\t   (param 17) ,\n` +
    `\t\t  (param 18) ,\n\t\t  (param 19) ,\n\t\t   (param 20) ,\n\t\t  (param 21) ,\n\t\t  (param 22) ,\n\t\t${v.keepprivate},\n` +
    '\t\t  (param 23) ,\n\t\t  (param 24) ,\n\t\t  (param 25) ,\n\t\t  (param 26) ,\n\t\t  (param 27) \n\t\t )'
  );
}

/** `userDAO.create`'s INSERT values with a limit, in its column order; the password is its hash, which fits. */
const USER_INSERT_COLUMNS: readonly StatementColumn[] = [
  ['text', 'UserID', 'userid', 35],
  ['text', 'remoteID', 'remoteid', 50],
  ['inline', 's2', 'int'],
  ['text', 'Fname', 'fname', 50],
  ['text', 'Lname', 'lname', 50],
  ['text', 'Email', 'email', 255],
  ['text', 'GroupName', 'groupname', 255],
  ['inline', 'type', 'int'],
  ['text', 'subType', 'subtype', 50],
  ['text', 'LastUpdateBy', 'lastupdateby', 50],
  ['text', 'LastUpdateByID', 'lastupdatebyid', 35],
  ['inline', 'inactive', 'tinyint'],
  ['text', 'UserName', 'username', 255],
  ['inline', 'perm', 'tinyint'],
  ['inline', 'ispublic', 'int'],
  ['text', 'Company', 'company', 50],
  ['text', 'JobTitle', 'jobtitle', 50],
  ['inline', 'subscribe', 'int'],
  ['text', 'SiteID', 'siteid', 50],
  ['text', 'Website', 'website', 255],
  ['text', 'mobilePhone', 'mobilephone', 50],
  ['text', 'photoFileID', 'photofileid', 35],
  ['inline', 'keepprivate', 'tinyint'],
  ['text', 'IMName', 'imname', 100],
  ['text', 'IMService', 'imservice', 50],
  ['text', 'tablist', 'tablist', 255],
];

/** The failure of `userDAO.create`'s INSERT for the bound `values`, keyed by lower-cased column; undefined when none. */
export function userInsertFault(inline: UserInline, values: Readonly<Record<string, string | null | undefined>>, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  return statementFault(userInsertSql(inline), 'tusers', statementValues(USER_INSERT_COLUMNS, { ...values, ...inline }), env);
}

/** The values `userDAO.update` inlines, which set no Perm but the site id. */
export type UserUpdateInline = Omit<UserInline, 'perm'> & { siteid: string };

/** `userDAO.update`'s UPDATE as cfcatch reports it; a posted password adds its two parameters. */
export function userUpdateSql(v: UserUpdateInline, withPassword: boolean): string {
  let n = 0;
  const p = (): string => `(param ${(n += 1)})`;
  const head = `UPDATE tusers SET\n\t\t RemoteID =   ${p()} ,\n\t  \t Fname =   ${p()} ,\n\t  \t Lname =   ${p()} ,\n\t  \t GroupName =   ${p()} ,\n         Email =   ${p()} ,\n        \n`;
  const password = withPassword ? `\t\t Password =  ${p()} ,\n\t\t passwordCreated = ${p()} ,\n\t\t \n` : '';
  return (
    `${head}${password}\t\t s2 =${v.s2},\n         Type = ${v.type},\n\t\t subType =  ${p()} ,\n         ContactForm =  ${p()} ,\n` +
    `\t\t LastUpdate =  ${p()} ,\n\t\t LastUpdateBy =   ${p()} ,\n\t\t LastUpdateByID =  ${p()} ,\n\t\t\n\t\t InActive = ${v.inactive},\n` +
    `\t\t username =  ${p()} ,\n\t\t isPublic = ${v.ispublic},\n\t\t\n\t\t company =   ${p()} ,\n\t\t jobtitle =   ${p()} ,\n` +
    `\t\t website =   ${p()} ,\n\t\t notes =   ${p()} ,\n\t\t subscribe=${v.subscribe},\n\t\t siteid = '${v.siteid}',\n` +
    `\t\t MobilePhone =  ${p()} ,\n\t\t Description =  ${p()} ,\n\t\t Interests =  ${p()} ,\n\t\t PhotoFileID =  ${p()} ,\n` +
    `\t\t keepPrivate = ${v.keepprivate},\n\t\t IMName =  ${p()} ,\n\t\t IMService =  ${p()} ,\n\t\t Tags =  ${p()} ,\n` +
    `\t\t TabList=  ${p()} \n\n       WHERE UserID = '${v.userid}'`
  );
}

/** `userDAO.update`'s SET values with a limit, in its SET order; the password, when set, is its hash, which fits. */
const USER_UPDATE_COLUMNS: readonly StatementColumn[] = [
  ['text', 'remoteID', 'remoteid', 50],
  ['text', 'Fname', 'fname', 50],
  ['text', 'Lname', 'lname', 50],
  ['text', 'GroupName', 'groupname', 255],
  ['text', 'Email', 'email', 255],
  ['inline', 's2', 'int'],
  ['inline', 'type', 'int'],
  ['text', 'subType', 'subtype', 50],
  ['text', 'LastUpdateBy', 'lastupdateby', 50],
  ['text', 'LastUpdateByID', 'lastupdatebyid', 35],
  ['inline', 'inactive', 'tinyint'],
  ['text', 'UserName', 'username', 255],
  ['inline', 'ispublic', 'int'],
  ['text', 'Company', 'company', 50],
  ['text', 'JobTitle', 'jobtitle', 50],
  ['text', 'Website', 'website', 255],
  ['inline', 'subscribe', 'int'],
  ['text', 'SiteID', 'siteid', 50],
  ['text', 'mobilePhone', 'mobilephone', 50],
  ['text', 'photoFileID', 'photofileid', 35],
  ['inline', 'keepprivate', 'tinyint'],
  ['text', 'IMName', 'imname', 100],
  ['text', 'IMService', 'imservice', 50],
  ['text', 'tablist', 'tablist', 255],
];

/** The failure of `userDAO.update`'s UPDATE, when it matches a row, for the bound `values`; undefined when none. */
export function userUpdateFault(
  inline: UserUpdateInline,
  withPassword: boolean,
  values: Readonly<Record<string, string | null | undefined>>,
  env?: QueryFaultEnv,
): LegacyQueryFault | undefined {
  return statementFault(userUpdateSql(inline, withPassword), 'tusers', statementValues(USER_UPDATE_COLUMNS, { ...values, ...inline }), env);
}

/** `createTags`' INSERT as cfcatch reports it. */
export const TAG_INSERT_SQL =
  'insert into tuserstags (userid,siteid,tag)\n\t\t\t\t\tvalues(\n\t\t\t\t\t\t (param 1) ,\n\t\t\t\t\t\t (param 2) ,\n\t\t\t\t\t\t (param 3) \n\t\t\t\t\t\t)';

/** The truncation one `createTags` insert fails on; undefined when the row fits. */
export function tagInsertFault(row: { userid: string | null; siteid: string | null; tag: string | null }, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  const values = [
    { column: 'userID', width: 35, value: row.userid },
    { column: 'siteid', width: 25, value: row.siteid },
    { column: 'tag', width: 100, value: row.tag },
  ];
  return statementFault(TAG_INSERT_SQL, 'tuserstags', values, env);
}

/** `createAddress`' inlined values, as CFML text. */
export interface AddressInsertInline {
  addressid: string;
  userid: string;
  isprimary: string;
  longitude: string;
  latitude: string;
}

/** `createAddress`' INSERT as cfcatch reports it. */
export function addressInsertSql(v: AddressInsertInline): string {
  return (
    'INSERT INTO tuseraddresses  (AddressID,UserID,siteID,\n\t\tphone,fax,address1, address2, city, state, zip ,\n\t\taddressName,country,' +
    `isPrimary,addressNotes,addressURL,\n\t\tlongitude,latitude,addressEmail,hours)\n     VALUES(\n        '${v.addressid}',\n\t\t'${v.userid}',\n` +
    '\t\t (param 1) ,\n\t\t (param 2) ,\n\t\t (param 3) ,\n\t\t (param 4) ,\n\t\t (param 5) ,\n\t\t (param 6) ,\n\t\t (param 7) ,\n' +
    `\t\t (param 8) ,\n\t\t (param 9) ,\n\t\t (param 10) ,\n\t\t${v.isprimary},\n\t\t (param 11) ,\n\t\t (param 12) ,\n\t\t${v.longitude},\n` +
    `\t\t${v.latitude},\n\t\t (param 13) ,\n\t\t (param 14) \n\t\t  )`
  );
}

/** `updateAddress`' inlined values, as CFML text. */
export interface AddressUpdateInline {
  siteid: string;
  longitude: string;
  latitude: string;
}

/** `updateAddress`' UPDATE as cfcatch reports it. */
export function addressUpdateSql(v: AddressUpdateInline): string {
  return (
    'UPDATE tuseraddresses SET\n\t\tphone =   (param 1) ,\n\t\taddress1 =   (param 2) ,\n\t\taddress2 =   (param 3) ,\n\t\tcity =   (param 4) ,\n' +
    '\t\tstate =   (param 5) ,\n\t\tzip =   (param 6) ,\n\t\tfax =   (param 7) ,\n\t\taddressNotes =   (param 8) ,\n' +
    `\t\tsiteid = '${v.siteid}',\n\t\tUserID =  (param 9) ,\n\t\taddressName=   (param 10) ,\n\t\tcountry=   (param 11) ,\n` +
    `\t\taddressURL= (param 12) ,\n\t\tlongitude = ${v.longitude},\n\t\tlatitude = ${v.latitude},\n\t\taddressEmail= (param 13) ,\n` +
    '\t\thours =   (param 14) \n       WHERE AddressID =  (param 15) '
  );
}

/** `createAddress`' INSERT values with a limit, in its column order. */
const ADDRESS_INSERT_COLUMNS: readonly StatementColumn[] = [
  ['text', 'addressID', 'addressid', 35],
  ['text', 'userID', 'userid', 35],
  ['text', 'siteID', 'siteid', 50],
  ['text', 'phone', 'phone', 50],
  ['text', 'fax', 'fax', 50],
  ['text', 'address1', 'address1', 50],
  ['text', 'address2', 'address2', 50],
  ['text', 'city', 'city', 50],
  ['text', 'state', 'state', 50],
  ['text', 'zip', 'zip', 50],
  ['text', 'addressName', 'addressname', 50],
  ['text', 'country', 'country', 50],
  ['inline', 'isprimary', 'tinyint'],
  ['text', 'addressURL', 'addressurl', 200],
  ['inline', 'longitude', 'float'],
  ['inline', 'latitude', 'float'],
  ['text', 'addressEmail', 'addressemail', 100],
];

/** `updateAddress`' SET values with a limit, in its SET order. */
const ADDRESS_UPDATE_COLUMNS: readonly StatementColumn[] = [
  ['text', 'phone', 'phone', 50],
  ['text', 'address1', 'address1', 50],
  ['text', 'address2', 'address2', 50],
  ['text', 'city', 'city', 50],
  ['text', 'state', 'state', 50],
  ['text', 'zip', 'zip', 50],
  ['text', 'fax', 'fax', 50],
  ['text', 'siteID', 'siteid', 50],
  ['text', 'userID', 'userid', 35],
  ['text', 'addressName', 'addressname', 50],
  ['text', 'country', 'country', 50],
  ['text', 'addressURL', 'addressurl', 200],
  ['inline', 'longitude', 'float'],
  ['inline', 'latitude', 'float'],
  ['text', 'addressEmail', 'addressemail', 100],
];

/** The failure of `createAddress`' INSERT for the bound `values`, keyed by lower-cased column; undefined when none. */
export function addressInsertFault(inline: AddressInsertInline, values: Readonly<Record<string, string | null | undefined>>, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  return statementFault(addressInsertSql(inline), 'tuseraddresses', statementValues(ADDRESS_INSERT_COLUMNS, { ...values, ...inline }), env);
}

/** The failure of `updateAddress`' UPDATE, when it matches a row, for the bound `values`; undefined when none. */
export function addressUpdateFault(inline: AddressUpdateInline, values: Readonly<Record<string, string | null | undefined>>, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  return statementFault(addressUpdateSql(inline), 'tuseraddresses', statementValues(ADDRESS_UPDATE_COLUMNS, { ...values, ...inline }), env);
}

/** `updateModule`'s INSERT as cfcatch reports it. */
export const PERMISSION_INSERT_SQL =
  "Insert Into tpermissions  (ContentID,GroupID,Type,siteid)\n\t\tvalues(\n\t\t (param 1) ,\n\t\t (param 2) ,\n\t\t'module',\n\t\t (param 3) \n\t\t)";

/** One `updateModule` insert: the module's content id, a listed group id and the site id. */
export interface PermissionInsert {
  contentid: string;
  groupid: string;
  siteid: string;
}

/** The truncation one `updateModule` insert fails on; undefined when the row fits. */
export function permissionInsertFault(row: PermissionInsert, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  const values = [
    { column: 'ContentID', width: 35, value: row.contentid },
    { column: 'GroupID', width: 35, value: row.groupid },
    { column: 'SiteID', width: 25, value: row.siteid },
  ];
  return statementFault(PERMISSION_INSERT_SQL, 'tpermissions', values, env);
}

/** The primary-key violation of an `updateModule` insert repeating an earlier row, quoting the key as stored: `char(35)` ids padded, each cut to its width. */
export function permissionKeyFault(row: PermissionInsert): LegacyQueryFault {
  const char35 = (value: string): string => windows1252Text(value).padEnd(35).slice(0, 35);
  const key = [char35(row.contentid), char35(row.groupid), windows1252Text(row.siteid).slice(0, 25), 'module'].join(', ');
  return primaryKeyFault(PERMISSION_INSERT_SQL, 'PK_tpermissions', 'tpermissions', key);
}
