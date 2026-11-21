// SQL Server failures of the people statements Masa's cfquery runs, with the cfcatch fields onError's debug page prints
// (core/appcfc/onError_include.cfm:177-288; core/mura/user/userDAO.cfc:300-347, 749-808, 895-914).
import { statementFault, statementValues, type LegacyQueryFault, type QueryFaultEnv, type StatementColumn } from '@opt2/platform/legacy-compat';

/** `userDAO.create`'s inlined values, as CFML text. */
export interface UserInsertInline {
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
export function userInsertSql(v: UserInsertInline): string {
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

/** `userDAO.create`'s INSERT values with a limit, in its column order; identity binds the password's hash, which fits. */
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
export function userInsertFault(inline: UserInsertInline, values: Readonly<Record<string, string | null | undefined>>, env?: QueryFaultEnv): LegacyQueryFault | undefined {
  return statementFault(userInsertSql(inline), 'tusers', statementValues(USER_INSERT_COLUMNS, { ...values, ...inline }), env);
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
