/** Group CRUD and memberships: Masa `tusers` Type=1 rows and their child rows, each save or delete one gated identity transaction. */
import { setTimeout as timerSleep } from 'node:timers/promises';
import {
  LegacyServiceUnavailableError,
  cfDateTimeFormat,
  cfEq,
  cfHash,
  cfIsBoolean,
  cfIsNumeric,
  cfListToArray,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  javaTrim,
  type CfHashAlgorithm,
} from '@opt2/platform/legacy-compat';
import { OperationBlockedError, withGatedTenant, type RepositoryRow } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  siteForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  withTenant,
  type RegistrySource,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';
import type { IdentityEvents } from '../events/publish.js';
import type { ContentClient } from '../legacy/content-client.js';
import { hashNewPassword, type LegacyPasswordConfig } from '../legacy/hash.js';
import { WddxRecordset, cfml2wddx, type WddxValue } from '../legacy/wddx.js';
import {
  READ_PAGE_SIZE,
  charKey,
  type AuditActor,
  type GroupAddressInput as GroupAddressRowInput,
  type GroupAddressUpdate,
  type GroupExtendDataReplacement,
  type GroupInput,
  type GroupMemberPage,
  type GroupMemberRow,
  type GroupRelation,
  type IdentityRepository,
  type KeyedGroupMember,
  type ListPage,
} from '../repo/repository.js';
import type { GroupFeedQuery } from '../repo/group-feed.js';
import { GROUP_TRASH, type GroupAccountRow, type GroupAddressRow, type GroupTrashRow } from '../repo/tables.js';
import { ACCOUNT_OPERATION_UNITS, DEFAULT_ACCOUNT_SETTINGS, USER_CLOSED_WAIT_MS, randomPassword, withOpenAccount, type LegacyErrors } from './account-operations.js';

export type { GroupMemberRow };

/** The session user a group write acts for, from its login snapshot; `isSuperUser` is its `S2` flag. */
export interface GroupActor {
  userId: string;
  fname: string | null;
  lname: string | null;
  isSuperUser: boolean;
}

/** A posted scalar as `legacyParamsOf` delivers it. */
export type GroupFormValue = string | number | boolean;

/** Posted text fields a group save copies onto its row, by legacy form name. */
export interface GroupTextFields {
  groupName?: string;
  fname?: string;
  lname?: string;
  username?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  mobilePhone?: string;
  website?: string;
  subType?: string;
  contactForm?: string;
  remoteID?: string;
  notes?: string;
  description?: string;
  interests?: string;
  photoFileID?: string;
  imName?: string;
  imService?: string;
  tags?: string;
  tablist?: string;
}

/** Posted numeric flags; a value CFML cannot read as a number fails the save, as legacy's SQL does. */
export interface GroupFlagFields {
  isPublic?: GroupFormValue;
  inActive?: GroupFormValue;
  perm?: GroupFormValue;
  s2?: GroupFormValue;
  subscribe?: GroupFormValue;
  /** Ignored unless numeric [legacy: core/mura/user/userBean.cfc:541-547]. */
  keepPrivate?: GroupFormValue;
}

/** Posted address fields `addressBean.set` reads [legacy: core/mura/user/addressBean.cfc:150-179]. */
export interface GroupAddressFields {
  addressID?: string;
  addressName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone?: string;
  fax?: string;
  addressNotes?: string;
  addressURL?: string;
  addressEmail?: string;
  hours?: string;
  longitude?: GroupFormValue;
  latitude?: GroupFormValue;
}

/** A group save as `userManager.create` and `update` receive it; absent fields keep the stored or default value. */
export interface GroupSaveInput extends GroupTextFields, GroupFlagFields {
  userId?: string;
  /** The posted site id, whose user pool the group lands in. */
  siteId?: string;
  password?: string;
  switchToPublic?: GroupFormValue;
  switchToPrivate?: GroupFormValue;
  /** Comma list of the groups the group itself belongs to. */
  groupID?: string;
  /** Comma list of interest category ids. */
  categoryID?: string;
  address?: GroupAddressFields;
  primaryAddressID?: string;
  extendSetID?: string;
  /** Extended values already resolved to attribute ids; stored when `extendSetID` is non-empty. */
  extendData?: readonly GroupExtendDataReplacement[];
  fromMuraTrash?: boolean;
  /** Comma list of the group's OAuth tokens an update deletes. */
  removeToken?: string;
  hKey?: string;
  uKey?: string;
  passedProtect?: GroupFormValue;
  /** `userManager.update` arguments: both flags default to true, `originID` to ''. */
  updateGroups?: boolean;
  updateInterests?: boolean;
  originID?: string;
}

/** A group row without its tenant and event version. */
export type GroupRecord = Omit<GroupAccountRow, 'tenant_id' | 'row_version'>;

/** A save's outcome: the stored group, or nothing written and the posted values echoed with legacy's validation errors. */
export interface GroupSaveResult {
  written: boolean;
  group: GroupRecord;
  errors: LegacyErrors;
}

/** The user pool a save lands in; `poolSiteId` is null for an unregistered site or an empty pool. */
export interface GroupSite {
  poolSiteId: string | null;
  isPublic: number;
  tenantId: string | null;
}

/** A stored group and the tenant holding it. */
export interface GroupLocation {
  tenantId: string;
  group: GroupRecord;
}

/** One `getUserGroups` row: the group and its member count in the pool, null when it has none. */
export type GroupListRow = GroupRecord & { counter: number | null };

/** A member and the group of a membership change. */
export interface MembershipChange {
  userId: string;
  groupId: string;
}

/** Masa settings a group save reads [legacy: core/mura/configBean.cfc:167,217-218,243]. */
export interface GroupSettings {
  password: LegacyPasswordConfig;
  hashAlgorithm: CfHashAlgorithm;
}

/** Masa defaults of the group save settings. */
export const DEFAULT_GROUP_SETTINGS: Readonly<GroupSettings> = Object.freeze({
  password: DEFAULT_ACCOUNT_SETTINGS.password,
  hashAlgorithm: 'CFMX_COMPAT',
});

/** Resource-bundle keys of the group validation messages. */
export type GroupMessageKey = 'captcha.error' | 'captcha.spam';

/** The text of `key` in the resource bundle of `siteId`. */
export type GroupMessages = (siteId: string, key: GroupMessageKey) => string;

/** The `en` texts [legacy: core/modules/v1/core_assets/resource_bundles/en.properties:31,35]. */
export const EN_GROUP_MESSAGES: Readonly<Record<GroupMessageKey, string>> = Object.freeze({
  'captcha.error': "The 'Security Code' entered was not correct.",
  'captcha.spam': 'This submission has been marked as spam.',
});

/** Dependencies of the group operations. */
export interface GroupDeps {
  db: TenantDb;
  repo: IdentityRepository;
  events: IdentityEvents;
  clock: Clock;
  /** Defaults to `DEFAULT_GROUP_SETTINGS`. */
  settings?: GroupSettings;
  /** Defaults to the `en` texts. */
  rb?: GroupMessages;
  /** Wait between closed-user polls; defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** A group delete whose stored photo legacy would delete with it; the photo version is strategies-content data, so identity never deletes the group. */
export class GroupPhotoWithheldError extends LegacyServiceUnavailableError {
  override readonly name: string = 'GroupPhotoWithheldError';

  constructor(readonly groupId: string) {
    super(`Group ${groupId} has a stored photo; deleting it writes strategies-content data`, 'auto', 'group-photo-withheld');
  }
}

/** Why a save identity cannot carry out in one transaction of its own data was halted. */
export type GroupSaveHalt = 'pool-move' | 'origin-interests';

/** A group update halted instead of diverging: a pool switch that moves the group to another tenant, or an origin-scoped interest replace whose categories are strategies-content data. */
export class GroupSaveHaltedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'GroupSaveHaltedError';

  constructor(
    readonly groupId: string,
    readonly halt: GroupSaveHalt,
  ) {
    super(
      halt === 'pool-move'
        ? `Group ${groupId} would move to another user pool's tenant, which one transaction cannot write`
        : `Group ${groupId}'s interest replace is scoped to an origin site's categories, which identity does not hold`,
      'auto',
      `group-${halt}`,
    );
  }
}

const SITE_REQUIRED = "The attribute 'SITEID' is required when saving a user.";
const SITE_MISSING = "The 'SiteID' variable is missing.";
const GROUP_TYPE = 1;
const CLOSED_POLL_MS = 100;
const EXTEND_DATA_TABLE = 'tclassextenddatauseractivity';
// Columns of the bean's empty ADDRESSES query [legacy: core/mura/user/userBean.cfc:162].
const ADDRESS_COLUMNS = [
  'addressid',
  'userid',
  'siteid',
  'address1',
  'address2',
  'city',
  'state',
  'zip',
  'country',
  'isPrimary',
  'addressName',
  'addressNotes',
  'phone',
  'fax',
  'addressURL',
  'longitude',
  'latitude',
  'addressEmail',
  'hours',
] as const;

type TextColumn =
  | 'groupname'
  | 'fname'
  | 'lname'
  | 'username'
  | 'email'
  | 'company'
  | 'jobtitle'
  | 'mobilephone'
  | 'website'
  | 'subtype'
  | 'contactform'
  | 'remoteid'
  | 'notes'
  | 'description'
  | 'interests'
  | 'photofileid'
  | 'imname'
  | 'imservice'
  | 'tags'
  | 'tablist';
type FlagField = Exclude<keyof GroupFlagFields, 'keepPrivate'>;
type FlagColumn = 's2' | 'perm' | 'inactive' | 'ispublic' | 'subscribe' | 'keepprivate';
type AddressTextField = Exclude<keyof GroupAddressFields, 'addressID' | 'longitude' | 'latitude'>;
type AddressTextColumn = Exclude<keyof GroupAddressUpdate, 'userid' | 'siteid' | 'longitude' | 'latitude'>;

/** The bean values a save writes: trimmed text, numeric flags, the group id and its user pool site. */
type GroupValues = Record<TextColumn, string> & Record<FlagColumn, number> & { userid: string; siteid: string };

const TEXT_FIELDS: readonly (readonly [keyof GroupTextFields, TextColumn])[] = [
  ['groupName', 'groupname'],
  ['fname', 'fname'],
  ['lname', 'lname'],
  ['username', 'username'],
  ['email', 'email'],
  ['company', 'company'],
  ['jobTitle', 'jobtitle'],
  ['mobilePhone', 'mobilephone'],
  ['website', 'website'],
  ['subType', 'subtype'],
  ['contactForm', 'contactform'],
  ['remoteID', 'remoteid'],
  ['notes', 'notes'],
  ['description', 'description'],
  ['interests', 'interests'],
  ['photoFileID', 'photofileid'],
  ['imName', 'imname'],
  ['imService', 'imservice'],
  ['tags', 'tags'],
  ['tablist', 'tablist'],
];

const FLAG_FIELDS: readonly (readonly [FlagField, Exclude<FlagColumn, 'keepprivate'>])[] = [
  ['isPublic', 'ispublic'],
  ['inActive', 'inactive'],
  ['perm', 'perm'],
  ['s2', 's2'],
  ['subscribe', 'subscribe'],
];

const FLAG_COLUMNS: readonly FlagColumn[] = ['s2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate'];

const ADDRESS_TEXT_FIELDS: readonly (readonly [AddressTextField, AddressTextColumn])[] = [
  ['addressName', 'addressname'],
  ['address1', 'address1'],
  ['address2', 'address2'],
  ['city', 'city'],
  ['state', 'state'],
  ['zip', 'zip'],
  ['country', 'country'],
  ['phone', 'phone'],
  ['fax', 'fax'],
  ['addressNotes', 'addressnotes'],
  ['addressURL', 'addressurl'],
  ['addressEmail', 'addressemail'],
  ['hours', 'hours'],
];

// userBean.init flags [legacy: core/mura/user/userBean.cfc:145-167]; isPublic=1 is the Member default of the group form, kept as legacy shows it.
const NEW_FLAGS: Readonly<Record<FlagColumn, number>> = Object.freeze({ s2: 0, perm: 0, inactive: 0, ispublic: 1, subscribe: 1, keepprivate: 0 });

/** `bean.setValue` text: trimmed, as legacy trims every simple value [legacy: core/mura/bean/beanExtendable.cfc:236-249]. */
function text(value: string | null | undefined): string {
  return javaTrim(value ?? '');
}

/** A posted scalar as `setValue` stores it: strings trimmed, other scalars as they are. */
function scalar(value: GroupFormValue): string | number | boolean {
  return typeof value === 'string' ? javaTrim(value) : value;
}

/** The items of a posted comma list, after `setGroupID`/`setCategoryID` trim it [legacy: core/mura/user/userBean.cfc:310-371]. */
function listItems(list: string | undefined): string[] {
  return list === undefined ? [] : cfListToArray(javaTrim(list));
}

/** CFML `trim(value) eq '1'`. */
function isOne(value: GroupFormValue | undefined): boolean {
  return value !== undefined && cfEq(String(scalar(value)), '1');
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(charKey));
  const right = new Set(b.map(charKey));
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** The values of a new group bean [legacy: core/mura/user/userBean.cfc:126-182]. */
function newGroupValues(userId: string): GroupValues {
  const texts = Object.fromEntries(TEXT_FIELDS.map(([, column]) => [column, ''])) as Record<TextColumn, string>;
  return { ...texts, subtype: 'Default', ...NEW_FLAGS, userid: userId, siteid: '' };
}

/** The values `userDAO.read` loads; a NULL flag keeps the bean's init value. */
function storedGroupValues(row: GroupAccountRow): GroupValues {
  const texts = Object.fromEntries(TEXT_FIELDS.map(([, column]) => [column, text(row[column])])) as Record<TextColumn, string>;
  const flags = Object.fromEntries(FLAG_COLUMNS.map((column) => [column, row[column] ?? NEW_FLAGS[column]])) as Record<FlagColumn, number>;
  return { ...texts, ...flags, userid: row.userid, siteid: text(row.siteid) };
}

/** `userBean.set` of the posted fields over `base` [legacy: core/mura/user/userBean.cfc:202-225]. */
function withPosted(base: GroupValues, input: GroupSaveInput): GroupValues {
  const values = { ...base };
  for (const [field, column] of TEXT_FIELDS) {
    const posted = input[field];
    if (posted !== undefined) values[column] = javaTrim(posted);
  }
  for (const [field, column] of FLAG_FIELDS) {
    const posted = input[field];
    if (posted !== undefined) values[column] = cfToNumber(scalar(posted));
  }
  const keepPrivate = input.keepPrivate === undefined ? undefined : scalar(input.keepPrivate);
  if (keepPrivate !== undefined && cfIsNumeric(keepPrivate)) values.keepprivate = cfToNumber(keepPrivate);
  return values;
}

/** A group save read from merged legacy params, whose names CFML matches ignoring case. */
export function groupSaveInputFrom(params: Readonly<Record<string, unknown>>): GroupSaveInput {
  const byName = new Map(Object.entries(params).map(([name, value]) => [name.toLowerCase(), value]));
  const read = (name: string): GroupFormValue | undefined => {
    const value = byName.get(name.toLowerCase());
    if (value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    throw new TypeError(`Group field ${name} is not a simple value`);
  };
  const readText = (name: string): string | undefined => {
    const value = read(name);
    return value === undefined ? undefined : String(value);
  };
  const input: GroupSaveInput = {
    userId: readText('userID'),
    siteId: readText('siteID'),
    password: readText('password'),
    keepPrivate: read('keepPrivate'),
    switchToPublic: read('switchToPublic'),
    switchToPrivate: read('switchToPrivate'),
    groupID: readText('groupID'),
    categoryID: readText('categoryID'),
    primaryAddressID: readText('primaryAddressID'),
    extendSetID: readText('extendSetID'),
    fromMuraTrash: byName.has('frommuratrash') ? true : undefined,
    removeToken: readText('removeToken'),
    hKey: readText('hKey'),
    uKey: readText('uKey'),
    passedProtect: read('passedProtect'),
  };
  for (const [field] of TEXT_FIELDS) input[field] = readText(field);
  for (const [field] of FLAG_FIELDS) input[field] = read(field);
  const address: GroupAddressFields = { addressID: readText('addressID'), longitude: read('longitude'), latitude: read('latitude') };
  for (const [field] of ADDRESS_TEXT_FIELDS) address[field] = readText(field);
  input.address = address;
  return input;
}

/** The registry entry of a registered legacy site id; null when unregistered. */
async function siteEntry(source: RegistrySource, siteId: string): Promise<TenantRegistryEntry | null> {
  const tenant = await tenantForRegisteredSite(source, siteId);
  return tenant === null ? null : registryEntryForTenant(source, tenant);
}

/** The user pool and visibility `userBean.set` picks for a posted site, from identity's registry [legacy: core/mura/user/userBean.cfc:227-239]. */
export async function resolveGroupSite(
  source: RegistrySource,
  input: { siteId: string; isPublic: number; switchToPublic?: GroupFormValue; switchToPrivate?: GroupFormValue },
): Promise<GroupSite> {
  const entry = await siteEntry(source, input.siteId);
  const toPublic = isOne(input.switchToPublic);
  const isPublic = toPublic ? 1 : isOne(input.switchToPrivate) ? 0 : input.isPublic;
  const pool = isPublic === 0 ? entry?.privateUserPoolId : entry?.publicUserPoolId;
  const poolSiteId = pool === undefined || pool === null || pool === '' ? null : pool;
  return { poolSiteId, isPublic, tenantId: poolSiteId === null ? null : tenantIdForSite(poolSiteId) };
}

/** The site `addressBean.set` gives a posted address: the posted visibility's user pool, else the posted site [legacy: core/mura/user/addressBean.cfc:171-177]. */
async function addressSiteId(source: RegistrySource, input: GroupSaveInput): Promise<string> {
  const site = text(input.siteId);
  const isPublic = input.isPublic === undefined ? '' : String(scalar(input.isPublic));
  if (site === '' || isPublic === '') return site;
  const entry = await siteEntry(source, site);
  return (cfEq(isPublic, '0') ? entry?.privateUserPoolId : entry?.publicUserPoolId) ?? '';
}

/** `userBean.validate` of a group [legacy: core/mura/user/userBean.cfc:447-522]; identity holds no class-extension definitions, so there are no extended-data errors. */
function validateGroup(deps: GroupDeps, values: GroupValues, input: GroupSaveInput): LegacyErrors {
  if (values.siteid === '') return { siteid: SITE_MISSING };
  const errors: LegacyErrors = {};
  const rb = deps.rb ?? ((_siteId: string, key: GroupMessageKey) => EN_GROUP_MESSAGES[key]);
  const hKey = text(input.hKey);
  if (hKey !== '' && !cfEq(hKey, cfHash(text(input.uKey), (deps.settings ?? DEFAULT_GROUP_SETTINGS).hashAlgorithm))) {
    errors.SecurityCode = rb(values.siteid, 'captcha.error');
  }
  // setPassedProtect keeps the init true unless the posted value is boolean [legacy: core/mura/user/userBean.cfc:557-562].
  const passed = input.passedProtect === undefined ? true : scalar(input.passedProtect);
  if (cfIsBoolean(passed) && !cfToBoolean(passed)) errors.Spam = rb(values.siteid, 'captcha.spam');
  return errors;
}

interface PreparedSave {
  values: GroupValues;
  errors: LegacyErrors;
  /** Tenant of the resolved user pool; null when the save has no site. */
  tenantId: string | null;
}

/** Legacy throws before saving a user without a posted site id [legacy: core/mura/user/userManager.cfc:428-430,597-599]. */
function requireSite(input: GroupSaveInput): void {
  if (input.siteId === undefined || input.siteId === '') throw new Error(SITE_REQUIRED);
}

/** The bean values after `set`, the S2 rules and `validate` [legacy: core/mura/user/userManager.cfc:432-447,576-588]. */
async function prepareSave(deps: GroupDeps, actor: GroupActor, input: GroupSaveInput, base: GroupValues): Promise<PreparedSave> {
  const values = withPosted(base, input);
  const site = text(input.siteId);
  let tenantId: string | null = null;
  if (site === '') {
    values.siteid = '';
  } else {
    const resolved = await resolveGroupSite(deps.db, {
      siteId: site,
      isPublic: values.ispublic,
      switchToPublic: input.switchToPublic,
      switchToPrivate: input.switchToPrivate,
    });
    values.ispublic = resolved.isPublic;
    values.siteid = resolved.poolSiteId ?? '';
    tenantId = resolved.tenantId;
  }
  if (!actor.isSuperUser) values.s2 = 0;
  if (values.s2 !== 0) values.ispublic = 0;
  return { values, errors: validateGroup(deps, values, input), tenantId };
}

function auditActor(actor: GroupActor): AuditActor {
  return { userId: actor.userId, fname: actor.fname, lname: actor.lname, fromSnapshot: true };
}

function recordOf(row: GroupAccountRow): GroupRecord {
  const { tenant_id: _tenant, row_version: _version, ...record } = row;
  return record;
}

/** The bean values as a group record; the stored timestamps, or now as `userBean.init` sets them. The password is never echoed. */
function echoRecord(values: GroupValues, stored: GroupAccountRow | null, now: Date): GroupRecord {
  return {
    ...values,
    type: GROUP_TYPE,
    password: null,
    passwordcreated: stored?.passwordcreated ?? now,
    lastlogin: stored?.lastlogin ?? null,
    lastupdate: stored?.lastupdate ?? now,
    lastupdateby: stored?.lastupdateby ?? '',
    lastupdatebyid: stored?.lastupdatebyid ?? '',
    created: stored?.created ?? now,
    ext: stored?.ext ?? null,
    admin: stored?.admin ?? null,
  };
}

/** The values of a new group bean, as the Edit Group screen shows an unknown id. */
export function newGroupRecord(clock: Clock, userId: string = cfUuid()): GroupRecord {
  return echoRecord(newGroupValues(userId), null, clock.now());
}

/** The row columns `userDAO.create` and `userDAO.update` write; `password` is the stored value, '' for none. */
function groupColumns(values: GroupValues, password: string): GroupInput {
  return { ...values, type: GROUP_TYPE, password };
}

function passwordConfig(deps: GroupDeps): LegacyPasswordConfig {
  return (deps.settings ?? DEFAULT_GROUP_SETTINGS).password;
}

/** A posted coordinate, `addressBean`'s init 0 when absent. */
function coordinate(posted: GroupFormValue | undefined, stored: number | null | undefined): number {
  return posted === undefined ? (stored ?? 0) : cfToNumber(scalar(posted));
}

/** The primary address `userManager.create` adds [legacy: core/mura/user/userManager.cfc:601-611]. */
function primaryAddress(groupId: string, siteId: string, fields: GroupAddressFields = {}): GroupAddressRowInput {
  const row: GroupAddressRowInput = {
    userid: groupId,
    addressid: text(fields.addressID),
    siteid: siteId,
    isprimary: 1,
    longitude: coordinate(fields.longitude, 0),
    latitude: coordinate(fields.latitude, 0),
  };
  for (const [field, column] of ADDRESS_TEXT_FIELDS) row[column] = text(fields[field]);
  return row;
}

/** `readAddress` then `set` of the posted fields, as `updateAddress` writes it [legacy: core/mura/user/userManager.cfc:450-454,504-506]. */
function addressUpdate(groupId: string, siteId: string, stored: GroupAddressRow | undefined, fields: GroupAddressFields = {}): GroupAddressUpdate {
  const row: GroupAddressUpdate = {
    userid: groupId,
    siteid: siteId,
    longitude: coordinate(fields.longitude, stored?.longitude),
    latitude: coordinate(fields.latitude, stored?.latitude),
  };
  for (const [field, column] of ADDRESS_TEXT_FIELDS) {
    const posted = fields[field];
    row[column] = posted === undefined ? text(stored?.[column]) : javaTrim(posted);
  }
  return row;
}

/** Identifiers and time of one `trashManager.throwIn` call. */
interface TrashStamp {
  at: Date;
  /** muraDeleteID, a createUUID() value. */
  deleteId: string;
  /** INSTANCEID, the createUUID() value the bean took at init. */
  instanceId: string;
}

/** A loaded group's `getAllValues()` struct in ACF 2023's cfml2wddx key order, without people-owned extended attributes [legacy: core/mura/trash/trashManager.cfc:174-227]. */
function groupTrashValues(group: GroupAccountRow, groupIds: readonly string[], categoryIds: readonly string[], stamp: TrashStamp): Map<string, WddxValue> {
  // bean.set(rsUser) trims every column to text; setters parse the dates back and setKeepPrivate keeps its init 0 for a NULL.
  const flag = (value: number | null): string => (value === null ? '' : String(value));
  return new Map<string, WddxValue>([
    ['ERRORS', {}],
    ['MOBILEPHONE', text(group.mobilephone)],
    ['LNAME', text(group.lname)],
    ['EMAIL', text(group.email)],
    ['CONTACTFORM', text(group.contactform)],
    ['LASTUPDATE', group.lastupdate ?? ''],
    ['EXTENDDATATABLE', EXTEND_DATA_TABLE],
    ['KEEPPRIVATE', group.keepprivate === null ? 0 : String(group.keepprivate)],
    ['USERID', text(group.userid)],
    ['USERNAME', text(group.username)],
    ['PASSEDPROTECT', true],
    ['muraDeleteID', stamp.deleteId],
    ['type', flag(group.type)],
    ['LASTUPDATEBYID', text(group.lastupdatebyid)],
    ['SUBTYPE', text(group.subtype)],
    ['CATEGORYID', categoryIds.join(',')],
    ['REMOVEOBJECTS', []],
    ['FNAME', text(group.fname)],
    ['COMPANY', text(group.company)],
    ['TABLIST', text(group.tablist)],
    ['NEWFILE', ''],
    ['PASSWORD', ''],
    ['FROMMURACACHE', false],
    ['ISPUBLIC', flag(group.ispublic)],
    ['ADDRESSES', new WddxRecordset(ADDRESS_COLUMNS)],
    ['IMSERVICE', text(group.imservice)],
    ['ISNEW', '0'],
    ['JOBTITLE', text(group.jobtitle)],
    ['WEBSITE', text(group.website)],
    ['LASTLOGIN', group.lastlogin ?? ''],
    ['TAGS', text(group.tags)],
    ['S2', flag(group.s2)],
    ['EXTENDAUTOCOMPLETE', true],
    // setValue trims now() to its CFML string form [legacy: core/mura/trash/trashManager.cfc:179-183].
    ['muraDeleteDateTime', `{ts '${cfDateTimeFormat(stamp.at, 'yyyy-mm-dd HH:nn:ss')}'}`],
    ['ADDOBJECTS', []],
    ['NOTES', text(group.notes)],
    ['CREATED', group.created ?? ''],
    ['GROUPNAME', text(group.groupname)],
    ['PERM', flag(group.perm)],
    ['DESCRIPTION', text(group.description)],
    ['HKEY', ''],
    ['ADDRESSID', ''],
    ['IMNAME', text(group.imname)],
    ['INSTANCEID', stamp.instanceId],
    ['PASSWORDCREATED', group.passwordcreated ?? stamp.at],
    ['PHOTOFILEID', text(group.photofileid)],
    ['INTERESTS', text(group.interests)],
    ['SOURCEITERATOR', ''],
    ['EXTENDSETID', ''],
    ['SITEID', text(group.siteid)],
    ['PRIMARYADDRESSID', ''],
    ['SUBSCRIBE', flag(group.subscribe)],
    ['UKEY', ''],
    ['REMOTEID', text(group.remoteid)],
    ['GROUPID', groupIds.join(',')],
    ['INACTIVE', flag(group.inactive)],
    ['PHOTOFILEEXT', ''],
    ['LASTUPDATEBY', text(group.lastupdateby)],
    ['EXTENDDATA', ''],
  ]);
}

/** The `ttrash` row `throwIn` inserts for a group [legacy: core/mura/trash/trashManager.cfc:229-273]. */
function groupTrashRow(group: GroupAccountRow, actor: GroupActor, sessionSiteId: string, objectString: string, stamp: TrashStamp): Omit<GroupTrashRow, 'tenant_id'> {
  const siteId = text(group.siteid);
  return {
    objectid: group.userid,
    parentid: 'NA',
    siteid: siteId === '' ? sessionSiteId : siteId,
    objectlabel: text(group.groupname),
    objectclass: 'user',
    objecttype: 'Group',
    objectsubtype: text(group.subtype),
    objectstring: objectString,
    // The stored time is the trimmed muraDeleteDateTime text, so it keeps whole seconds.
    deleteddate: new Date(Math.floor(stamp.at.getTime() / 1000) * 1000),
    deletedby: javaTrim(`${actor.fname ?? ''} ${actor.lname ?? ''}`).slice(0, 50),
    deleteid: stamp.deleteId,
    orderno: 1,
  };
}

/** Each registered tenant once, the `first` tenants ahead of the rest. */
async function candidateTenants(db: TenantDb, first: readonly (string | null | undefined)[] = []): Promise<string[]> {
  const preferred = first.filter((tenantId): tenantId is string => typeof tenantId === 'string');
  return [...new Set([...preferred, ...(await registeredTenants(db)).map((entry) => entry.tenantId)])];
}

/** The group `groupId` in any tenant, searching the site's user pools first, as `userDAO.read` finds it by id alone. */
async function locateGroup(deps: GroupDeps, groupId: string, siteId: string): Promise<{ tenantId: string; group: GroupAccountRow } | null> {
  if (groupId === '') return null;
  const entry = siteId === '' ? null : await siteEntry(deps.db, siteId);
  for (const tenantId of await candidateTenants(deps.db, [entry?.privateUserPoolTenant, entry?.publicUserPoolTenant])) {
    const group = await withTenant(deps.db, tenantId, (tx) => deps.repo.findGroup(tx, groupId));
    if (group !== null) return { tenantId, group };
  }
  return null;
}

/** The stored group `groupId` and its tenant, as `userManager.read` loads it; null for an unknown id [legacy: core/mura/user/userDAO.cfc:92-120]. */
export async function findGroupForSite(deps: GroupDeps, input: { groupId: string; siteId: string }): Promise<GroupLocation | null> {
  const located = await locateGroup(deps, input.groupId, text(input.siteId));
  return located === null ? null : { tenantId: located.tenantId, group: recordOf(located.group) };
}

/**
 * The `tusers` rows a name lookup of `userManager.read` selects in a site's two user pools: the groups, and how many accounts
 * (none by `groupname`, which reads Type=1) [legacy: core/mura/user/userManager.cfc:136-148; core/mura/user/userDAO.cfc:122-300].
 */
export async function findPoolRows(
  deps: GroupDeps,
  input: { siteId: string; column: 'groupname' | 'username' | 'remoteid'; value: string },
): Promise<{ groups: GroupLocation[]; accounts: number }> {
  // settingsManager.getSite of an unregistered site id answers the default site.
  const entry = (await siteEntry(deps.db, input.siteId)) ?? (await siteEntry(deps.db, 'default'));
  const pools = new Map<string, Set<string>>();
  const choices = [
    [entry?.publicUserPoolId, entry?.publicUserPoolTenant],
    [entry?.privateUserPoolId, entry?.privateUserPoolTenant],
  ] as const;
  for (const [poolId, tenantId] of choices) {
    if (poolId === undefined || poolId === null || poolId === '' || tenantId === undefined || tenantId === null) continue;
    pools.set(tenantId, (pools.get(tenantId) ?? new Set<string>()).add(poolId));
  }
  const groups: GroupLocation[] = [];
  let accounts = 0;
  for (const [tenantId, poolIds] of pools) {
    const siteIds = [...poolIds];
    await withTenant(deps.db, tenantId, async (tx) => {
      for (const row of await deps.repo.findGroupsByColumn(tx, input.column, input.value, siteIds)) groups.push({ tenantId, group: recordOf(row) });
      if (input.column !== 'groupname') accounts += await deps.repo.countAccountsByColumn(tx, input.column, input.value, siteIds);
    });
  }
  return { groups, accounts };
}

/** Runs `read` until it reports no closed user, sleeping between attempts outside its transactions; OperationBlockedError (the legacy 503) once the sleeps total `USER_CLOSED_WAIT_MS`. */
async function readUnclosed<T>(deps: GroupDeps, read: () => Promise<{ value: T; closed: readonly string[] }>): Promise<T> {
  const sleep = deps.sleep ?? timerSleep;
  for (let waited = 0; ; ) {
    const { value, closed } = await read();
    if (closed.length === 0) return value;
    if (waited >= USER_CLOSED_WAIT_MS) {
      throw new OperationBlockedError([...ACCOUNT_OPERATION_UNITS], `An open account operation keeps user ${[...new Set(closed)].join(', ')} closed`);
    }
    const step = Math.min(CLOSED_POLL_MS, USER_CLOSED_WAIT_MS - waited);
    await sleep(step);
    waited += step;
  }
}

/** The groups of a site's private (`isPublic` 0) or public user pool with member counts, by `Perm` descending then name [legacy: core/mura/user/userGateway.cfc:93-120]. */
export async function listGroups(deps: GroupDeps, input: { siteId: string; isPublic: number }): Promise<GroupListRow[]> {
  const site = await resolveGroupSite(deps.db, { siteId: input.siteId, isPublic: input.isPublic });
  const { poolSiteId, tenantId } = site;
  if (poolSiteId === null || tenantId === null) return [];
  // The pool's members are the membership rows held in the pool's own tenant.
  const counted = await readUnclosed(deps, async () => {
    const { groups, closed } = await withTenant(deps.db, tenantId, (tx) => deps.repo.listCountedGroups(tx, poolSiteId, input.isPublic));
    return { value: groups, closed };
  });
  const rows: GroupListRow[] = counted.map(({ counter, ...group }) => ({ ...recordOf(group), counter }));
  // A stable sort of the name-ordered list; SQL Server sorts a NULL Perm last under DESC.
  return rows.sort((a, b) => (a.perm === b.perm ? 0 : a.perm === null ? 1 : b.perm === null ? -1 : b.perm - a.perm));
}

/** The `relation` rows of `groupIds` in the user pool `listGroups` reads for `siteId` and `isPublic` [legacy: core/mura/user/userGateway.cfc:227-238,525-553]. */
export async function listGroupRelationRows(
  deps: GroupDeps,
  input: { siteId: string; isPublic: number; relation: GroupRelation; groupIds: readonly string[] },
): Promise<RepositoryRow[]> {
  const { tenantId } = await resolveGroupSite(deps.db, { siteId: input.siteId, isPublic: input.isPublic });
  if (tenantId === null || input.groupIds.length === 0) return [];
  return withTenant(deps.db, tenantId, (tx) => deps.repo.listGroupRelationRows(tx, input.relation, input.groupIds));
}

/** One window of a listing of groups and the listing's total. */
export interface GroupListPage {
  rows: GroupListRow[];
  total: number;
}

/** The `page` window of `listGroups`' listing in its order and the listing's total, the window counted and closed as `listGroups` counts and closes it. */
export async function listGroupsPage(deps: GroupDeps, input: { siteId: string; isPublic: number; page: ListPage }): Promise<GroupListPage> {
  const { poolSiteId, tenantId } = await resolveGroupSite(deps.db, { siteId: input.siteId, isPublic: input.isPublic });
  if (poolSiteId === null || tenantId === null) return { rows: [], total: 0 };
  return readUnclosed(deps, async () => {
    const { groups, total, closed } = await withTenant(deps.db, tenantId, (tx) => deps.repo.pageCountedGroups(tx, poolSiteId, input.isPublic, input.page));
    return { value: { rows: groups.map(({ counter, ...group }) => ({ ...recordOf(group), counter })), total }, closed };
  });
}

/** Passes `visit` each cursor page, by userid, of the groups of a site's private (`isPublic` 0) or public user pool: S2 ones only with `includeS2`, only `inactive` ones when given; no member counts. */
export async function scanFeedGroups(
  deps: GroupDeps,
  input: { siteId: string; isPublic: number; includeS2: boolean; inactive?: number },
  visit: (rows: GroupRecord[]) => void,
): Promise<void> {
  const { poolSiteId, tenantId } = await resolveGroupSite(deps.db, { siteId: input.siteId, isPublic: input.isPublic });
  if (poolSiteId === null || tenantId === null) return;
  const opts = { includeS2: input.includeS2, inactive: input.inactive };
  await withTenant(deps.db, tenantId, async (tx) => {
    for await (const page of deps.repo.groupFeedPages(tx, poolSiteId, input.isPublic, opts)) visit(page.map(recordOf));
  });
}

/** The scanFeedGroups selection that `query` filters, in its order: the first `limit` groups and how many it selects up to `top`; no member counts. */
export async function readFeedGroups(
  deps: GroupDeps,
  input: { siteId: string; isPublic: number },
  query: GroupFeedQuery,
): Promise<{ rows: GroupRecord[]; total: number }> {
  const { poolSiteId, tenantId } = await resolveGroupSite(deps.db, { siteId: input.siteId, isPublic: input.isPublic });
  if (poolSiteId === null || tenantId === null) return { rows: [], total: 0 };
  const { rows, total } = await withTenant(deps.db, tenantId, (tx) => deps.repo.readGroupFeed(tx, poolSiteId, input.isPublic, query));
  return { rows: rows.map(recordOf), total };
}

/** The listing's `ORDER BY lower(lname) COLLATE "C" NULLS FIRST, userid` across tenants: NULL keys first, keys by code point, ties by id. */
function memberOrder(a: KeyedGroupMember, b: KeyedGroupMember): number {
  if (a.key !== b.key) {
    if (a.key === null) return -1;
    if (b.key === null) return 1;
    return Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
  }
  const left = charKey(a.member.userid);
  const right = charKey(b.member.userid);
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A promise with its settle functions; its rejection counts as handled, as no consumer may be waiting for it. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** One tenant's member pages, read in a transaction held open until they run out or `close` ends it. */
interface MemberPager {
  /** The next page, null once the pages ran out; rejects with the read's error. */
  pull(): Promise<GroupMemberPage | null>;
  /** Ends the transaction once it is idle; rejects with a read or commit error `pull` has not delivered. */
  close(): Promise<void>;
}

/** Starts the transaction of `tenantId`'s member pages, which reads one page per `pull`. */
function openPager(deps: GroupDeps, tenantId: string, groupId: string, opts: { includeS2?: boolean; limit?: number }): MemberPager {
  let demand = deferred<boolean>();
  let reply = deferred<GroupMemberPage | null>();
  let delivered = false;
  const ended = withTenant(deps.db, tenantId, async (tx) => {
    const pages = deps.repo.memberPages(tx, groupId, opts);
    try {
      while (await demand.promise) {
        demand = deferred();
        const next = await pages.next();
        const answered = reply;
        reply = deferred();
        answered.resolve(next.done === true ? null : next.value);
        if (next.done === true) return;
      }
    } finally {
      await pages.return(undefined);
    }
  });
  const failure = ended.then(
    () => null,
    (error: unknown) => {
      reply.reject(error);
      return { error };
    },
  );
  return {
    pull: () => {
      demand.resolve(true);
      return reply.promise.catch((error: unknown) => {
        delivered = true;
        throw error;
      });
    },
    close: async () => {
      demand.resolve(false);
      const failed = await failure;
      if (failed !== null && !delivered) throw failed.error;
    },
  };
}

/** Closes every pager, then rejects with the first error a close raised. */
async function closePagers(pagers: Set<MemberPager>): Promise<void> {
  const closing = [...pagers];
  pagers.clear();
  const failed = (await Promise.allSettled(closing.map((pager) => pager.close()))).find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}

/** A tenant's current page in the merge and the position of its next row. */
interface MemberHead {
  pager: MemberPager;
  rows: KeyedGroupMember[];
  at: number;
}

/** The next row of `head`; a head in the merge always has one. */
function headRow(head: MemberHead): KeyedGroupMember {
  return head.rows[head.at] as KeyedGroupMember;
}

/** Opens into `open` the pagers of `tenants`, keeping those whose first page lists a member; a first page naming a closure closes every pager and is answered. */
async function openHeads(
  deps: GroupDeps,
  open: Set<MemberPager>,
  tenants: readonly string[],
  groupId: string,
  opts: { includeS2?: boolean; limit?: number },
): Promise<{ value: MemberHead[]; closed: string[] }> {
  const opened: MemberHead[] = [];
  for (const tenantId of tenants) {
    const pager = openPager(deps, tenantId, groupId, opts);
    open.add(pager);
    const page = await pager.pull();
    if (page !== null && page.closed.length > 0) {
      await closePagers(open);
      return { value: [], closed: page.closed };
    }
    if (page === null || page.members.length === 0) {
      open.delete(pager);
      await pager.close();
    } else {
      opened.push({ pager, rows: page.members, at: 0 });
    }
  }
  return { value: opened, closed: [] };
}

/** The members of `heads` in listing order, each tenant's next page pulled once its head runs out and its pager closed once its pages end. */
async function* mergeHeads(heads: MemberHead[], open: Set<MemberPager>): AsyncGenerator<GroupMemberRow, void, undefined> {
  while (heads.length > 0) {
    const head = heads.reduce((best, candidate) => (memberOrder(headRow(candidate), headRow(best)) < 0 ? candidate : best));
    yield headRow(head).member;
    head.at += 1;
    if (head.at < head.rows.length) continue;
    const page = await head.pager.pull();
    if (page === null || page.members.length === 0) {
      heads.splice(heads.indexOf(head), 1);
      open.delete(head.pager);
      await head.pager.close();
    } else {
      head.rows = page.members;
      head.at = 0;
    }
  }
}

/** Members of a group by last name, S2 members only with `includeS2` [legacy: core/mura/user/userDAO.cfc:646-660], streamed from one page per member tenant at a time; each membership row lives in its member's tenant. */
export async function* streamGroupMembers(deps: GroupDeps, groupId: string, opts: { includeS2?: boolean } = {}): AsyncGenerator<GroupMemberRow, void, undefined> {
  const open = new Set<MemberPager>();
  try {
    const heads = await readUnclosed<MemberHead[]>(deps, async () => {
      // Probed one transaction at a time, so no pager connection is held while another is checked out for an empty tenant.
      const holding: string[] = [];
      for (const tenantId of await candidateTenants(deps.db)) {
        const probe = await withTenant(deps.db, tenantId, (tx) => deps.repo.probeMembers(tx, groupId, opts));
        if (probe.closed.length > 0) return { value: [], closed: probe.closed };
        if (probe.listed) holding.push(tenantId);
      }
      return openHeads(deps, open, holding, groupId, opts);
    });
    yield* mergeHeads(heads, open);
  } finally {
    await closePagers(open);
  }
}

/** Every member `streamGroupMembers` yields, in its order. */
export async function listGroupMembers(deps: GroupDeps, groupId: string, opts: { includeS2?: boolean } = {}): Promise<GroupMemberRow[]> {
  const members: GroupMemberRow[] = [];
  for await (const member of streamGroupMembers(deps, groupId, opts)) members.push(member);
  return members;
}

/** A member with the `photoFileExt` legacy left-joins from `tfiles`: null without a photo id, a stored file or its `fileEXT`. */
export type ListedGroupMember = GroupMemberRow & { photofileext: string | null };

/** Most members `resolveMemberPhotos` takes, and the batch size of `streamListedGroupMembers`. */
export const MEMBER_BATCH_SIZE = READ_PAGE_SIZE;

/**
 * `members` in order with their photo extensions, from one strategies-content lookup of their distinct photo ids
 * [legacy: core/mura/user/userDAO.cfc:78,654].
 * @throws RangeError For more than `MEMBER_BATCH_SIZE` members.
 */
export async function resolveMemberPhotos(content: ContentClient, members: readonly GroupMemberRow[]): Promise<ListedGroupMember[]> {
  if (members.length > MEMBER_BATCH_SIZE) throw new RangeError(`A photo lookup takes at most ${MEMBER_BATCH_SIZE} members, not ${members.length}`);
  const extensions = await content.photoFileExts(members.map((member) => member.photofileid));
  return members.map((member) => ({ ...member, photofileext: member.photofileid === null ? null : (extensions.get(member.photofileid) ?? null) }));
}

/** The members `streamGroupMembers` yields, in its order, as batches of at most `MEMBER_BATCH_SIZE` with their photos resolved. */
export async function* streamListedGroupMembers(
  deps: GroupDeps,
  content: ContentClient,
  groupId: string,
  opts: { includeS2?: boolean } = {},
): AsyncGenerator<ListedGroupMember[], void, undefined> {
  let batch: GroupMemberRow[] = [];
  for await (const member of streamGroupMembers(deps, groupId, opts)) {
    batch.push(member);
    if (batch.length === MEMBER_BATCH_SIZE) {
      yield await resolveMemberPhotos(content, batch);
      batch = [];
    }
  }
  if (batch.length > 0) yield await resolveMemberPhotos(content, batch);
}

/** One window of a group's member listing with its photos resolved, and the listing's total. */
export interface GroupMemberListPage {
  members: ListedGroupMember[];
  total: number;
}

/**
 * The `page` window of `streamGroupMembers`' listing in its order, closed as it closes, and the listing's total: each member
 * tenant is counted, then read no further than the window's end, and only the window's photos are resolved.
 */
export async function listGroupMembersPage(
  deps: GroupDeps,
  content: ContentClient,
  groupId: string,
  opts: { includeS2?: boolean; page: ListPage },
): Promise<GroupMemberListPage> {
  const { offset, limit } = opts.page;
  const filter = { includeS2: opts.includeS2 === true };
  const open = new Set<MemberPager>();
  const members: GroupMemberRow[] = [];
  let total: number;
  try {
    const window = await readUnclosed<{ heads: MemberHead[]; total: number }>(deps, async () => {
      // Counted one transaction at a time, as streamGroupMembers probes.
      const holding: string[] = [];
      let counted = 0;
      for (const tenantId of await candidateTenants(deps.db)) {
        const count = await withTenant(deps.db, tenantId, (tx) => deps.repo.countMembers(tx, groupId, filter));
        if (count.closed.length > 0) return { value: { heads: [], total: 0 }, closed: count.closed };
        counted += count.total;
        if (count.total > 0) holding.push(tenantId);
      }
      if (offset >= counted) return { value: { heads: [], total: counted }, closed: [] };
      const opened = await openHeads(deps, open, holding, groupId, { ...filter, limit: offset + limit });
      return { value: { heads: opened.value, total: counted }, closed: opened.closed };
    });
    total = window.total;
    let skipped = 0;
    for await (const member of mergeHeads(window.heads, open)) {
      if (skipped < offset) skipped += 1;
      else if (members.push(member) === limit) break;
    }
  } finally {
    await closePagers(open);
  }
  const listed: ListedGroupMember[] = [];
  for (let start = 0; start < members.length; start += MEMBER_BATCH_SIZE) {
    listed.push(...(await resolveMemberPhotos(content, members.slice(start, start + MEMBER_BATCH_SIZE))));
  }
  return { members: listed, total };
}

/** Publishes the group's own membership set when the save changed it. */
async function publishOwnMemberships(deps: GroupDeps, tx: TenantTx, groupId: string, siteId: string, before: readonly string[]): Promise<void> {
  const after = await deps.repo.membershipGroupIds(tx, groupId);
  if (!sameIdSet(before, after)) await deps.events.publishMembershipChanged(tx, { userId: groupId, siteId, groupIds: after });
}

/** The held memberships of groups of `originId`, the only ones `deleteUserMemberships` then removes [legacy: core/mura/user/userDAO.cfc:502-515]. */
async function originGroupIds(deps: GroupDeps, tenantId: string, groupId: string, originId: string): Promise<string[]> {
  const held = await withTenant(deps.db, tenantId, (tx) => deps.repo.membershipGroupIds(tx, groupId));
  if (held.length === 0) return [];
  const groups = await withTenant(deps.db, tenantIdForSite(originId), (tx) => deps.repo.findGroupsByIds(tx, held));
  return groups.filter((group) => (group.siteid ?? '').toLowerCase() === originId.toLowerCase()).map((group) => group.userid);
}

/** Creates a group as `userManager.create` does [legacy: core/mura/user/userManager.cfc:563-703; core/mura/user/userDAO.cfc:300-355]. */
export async function createGroup(deps: GroupDeps, actor: GroupActor, input: GroupSaveInput): Promise<GroupSaveResult> {
  requireSite(input);
  const userId = input.userId !== undefined && input.userId !== '' ? input.userId : cfUuid();
  const { values, errors, tenantId } = await prepareSave(deps, actor, input, newGroupValues(userId));
  if (tenantId === null || Object.keys(errors).length > 0) {
    return { written: false, group: echoRecord(values, null, deps.clock.now()), errors };
  }
  const fromTrash = input.fromMuraTrash === true;
  const addressSite = fromTrash ? '' : await addressSiteId(deps.db, input);
  const posted = text(input.password);
  const password = (await hashNewPassword(posted === '' ? randomPassword() : posted, passwordConfig(deps))) ?? '';
  const extendSetId = text(input.extendSetID);
  const row = await withGatedTenant(deps.db, tenantId, async (tx) => {
    const { repo, events } = deps;
    // Legacy leaves a deleted group's memberships, so a re-created id may already hold some.
    const before = await repo.membershipGroupIds(tx, userId);
    const group = await repo.insertGroup(tx, groupColumns(values, password), auditActor(actor));
    for (const groupId of listItems(input.groupID)) await repo.addMembership(tx, userId, groupId);
    await repo.clearBadMemberships(tx, { userId, siteId: values.siteid, s2: values.s2, ispublic: values.ispublic });
    const categoryIds = listItems(input.categoryID);
    if (categoryIds.length > 0) await repo.replaceGroupInterests(tx, { groupId: userId, categoryIds, onlyCategoryIds: [] });
    await repo.replaceGroupTags(tx, { groupId: userId, siteId: values.siteid, tags: values.tags });
    if (extendSetId !== '' && input.extendData !== undefined) await repo.replaceGroupExtendData(tx, { groupId: userId, rows: input.extendData });
    // takeOut's file-version restore is strategies-content's; only identity's trash row is removed [legacy: core/mura/trash/trashManager.cfc:405-442].
    if (fromTrash) await repo.delete(tx, GROUP_TRASH.table, { objectid: userId });
    else await repo.insertGroupAddress(tx, primaryAddress(userId, addressSite, input.address));
    await events.publishGroupChanged(tx, group, { deleted: false });
    await publishOwnMemberships(deps, tx, userId, values.siteid, before);
    return group;
  });
  return { written: true, group: recordOf(row), errors: {} };
}

/** Updates a group as `userManager.update` does; without an id it creates one [legacy: core/mura/user/userManager.cfc:404-561; core/mura/user/userDAO.cfc:404-500]. */
export async function updateGroup(deps: GroupDeps, actor: GroupActor, input: GroupSaveInput): Promise<GroupSaveResult> {
  const groupId = input.userId ?? '';
  if (groupId === '') return createGroup(deps, actor, input);
  requireSite(input);
  const located = await locateGroup(deps, groupId, text(input.siteId));
  const base = located === null ? newGroupValues(groupId) : storedGroupValues(located.group);
  const { values, errors, tenantId } = await prepareSave(deps, actor, input, base);
  const echo = echoRecord(values, located?.group ?? null, deps.clock.now());
  // Legacy's UPDATE of an unknown id changes no row; the child rows it then writes would belong to no group here.
  if (located === null || tenantId === null || Object.keys(errors).length > 0) return { written: false, group: echo, errors };
  // A pool switch would move the row and its children to another tenant, which no single transaction can write.
  if (tenantId !== located.tenantId) throw new GroupSaveHaltedError(groupId, 'pool-move');
  const updateGroups = input.updateGroups ?? true;
  const updateInterests = input.updateInterests ?? true;
  const originId = input.originID ?? '';
  // Unposted lists keep the stored rows, which legacy deletes and re-inserts unchanged.
  const groupIds = updateGroups && input.groupID !== undefined ? listItems(input.groupID) : null;
  const categoryIds = updateInterests && input.categoryID !== undefined ? listItems(input.categoryID) : null;
  // An origin-scoped interest delete selects tcontentcategories rows, which are strategies-content data.
  if (originId !== '' && categoryIds !== null) throw new GroupSaveHaltedError(groupId, 'origin-interests');
  const onlyGroupIds = groupIds !== null && originId !== '' ? await originGroupIds(deps, located.tenantId, groupId, originId) : undefined;
  const addressId = text(input.address?.addressID);
  const addressSite = addressId === '' ? '' : await addressSiteId(deps.db, input);
  const posted = text(input.password);
  const password = posted === '' ? '' : ((await hashNewPassword(posted, passwordConfig(deps))) ?? '');
  const extendSetId = text(input.extendSetID);
  const primaryAddressId = text(input.primaryAddressID);
  const tokens = listItems(input.removeToken);
  return withGatedTenant(deps.db, tenantId, async (tx): Promise<GroupSaveResult> => {
    const { repo, events } = deps;
    const before = await repo.membershipGroupIds(tx, groupId);
    // Written first: the update locks the row, so a concurrent delete leaves this transaction without writes.
    const row = await repo.updateGroup(tx, groupId, groupColumns(values, password), auditActor(actor));
    if (row === null) return { written: false, group: echo, errors: {} };
    if (extendSetId !== '' && input.extendData !== undefined) await repo.replaceGroupExtendData(tx, { groupId, rows: input.extendData });
    if (addressId !== '') {
      const stored = (await repo.listGroupAddresses(tx, groupId)).find((address) => charKey(address.addressid) === charKey(addressId));
      await repo.updateGroupAddress(tx, addressId, addressUpdate(groupId, addressSite, stored, input.address));
    }
    if (groupIds !== null) await repo.replaceMemberships(tx, { userId: groupId, groupIds, onlyGroupIds });
    if (updateGroups) await repo.clearBadMemberships(tx, { userId: groupId, siteId: values.siteid, s2: values.s2, ispublic: values.ispublic });
    if (categoryIds !== null) await repo.replaceGroupInterests(tx, { groupId, categoryIds });
    if (primaryAddressId !== '') await repo.setPrimaryGroupAddress(tx, groupId, primaryAddressId);
    await repo.replaceGroupTags(tx, { groupId, siteId: values.siteid, tags: values.tags });
    if (tokens.length > 0) await repo.deleteTokensByUser(tx, groupId, tokens);
    await repo.removePrevRedirects(tx, groupId);
    await events.publishGroupChanged(tx, row, { deleted: false });
    await publishOwnMemberships(deps, tx, groupId, values.siteid, before);
    return { written: true, group: recordOf(row), errors: {} };
  });
}

/** Deletes a group as `userManager.delete` does, leaving its memberships, permissions, addresses, interests and favorites; false for an unknown id [legacy: core/mura/user/userManager.cfc:705-744; core/mura/user/userDAO.cfc:357-378]. */
export async function deleteGroup(deps: GroupDeps, actor: GroupActor, input: { groupId: string; siteId: string }): Promise<boolean> {
  const located = await locateGroup(deps, input.groupId, text(input.siteId));
  if (located === null) return false;
  const stamp: TrashStamp = { at: deps.clock.now(), deleteId: cfUuid(), instanceId: cfUuid() };
  return withGatedTenant(deps.db, located.tenantId, async (tx) => {
    const { repo, events } = deps;
    const group = await repo.findGroup(tx, located.group.userid);
    if (group === null) return false;
    if (text(group.photofileid) !== '') throw new GroupPhotoWithheldError(group.userid);
    const groupId = group.userid;
    if ((await repo.findByKey(tx, GROUP_TRASH.table, { objectid: groupId })) === null) {
      const values = groupTrashValues(group, await repo.membershipGroupIds(tx, groupId), await repo.groupInterestIds(tx, groupId), stamp);
      await repo.insert(tx, GROUP_TRASH.table, groupTrashRow(group, actor, text(input.siteId), cfml2wddx(values), stamp));
    }
    await repo.deleteGroupExtendData(tx, groupId);
    await repo.deleteGroupTags(tx, groupId);
    await repo.deleteTokensByUser(tx, groupId);
    const deleted = await repo.deleteGroupRow(tx, groupId);
    if (deleted === null) return false;
    await events.publishGroupChanged(tx, deleted, { deleted: true });
    return true;
  });
}

/** The tenant and pool site of a user or group id, searched across the registered tenants. */
async function locateMember(deps: GroupDeps, userId: string): Promise<{ tenantId: string; siteId: string } | null> {
  for (const tenantId of await candidateTenants(deps.db)) {
    const found = await withTenant(deps.db, tenantId, async (tx) => {
      const owner = (await deps.repo.findAccountById(tx, userId, { includePending: true })) ?? (await deps.repo.findGroup(tx, userId));
      if (owner === null) return null;
      const siteId = owner.siteid ?? (await siteForTenant(tx, tenantId));
      if (siteId === null) throw new Error(`Member ${userId} has no site id and tenant ${tenantId} no registered site`);
      return { tenantId, siteId };
    });
    if (found !== null) return found;
  }
  return null;
}

/** Runs `change` on the member's membership rows once no account operation keeps the member closed, then publishes the full set when it changed. */
async function changeMembership(deps: GroupDeps, input: MembershipChange, change: (tx: TenantTx) => Promise<boolean>): Promise<boolean> {
  const member = await locateMember(deps, input.userId);
  // Legacy writes the row even for an unknown id, which no screen lists; identity has no tenant to hold it.
  if (member === null) return false;
  return withOpenAccount(
    deps.db,
    member.tenantId,
    input.userId,
    async (tx) => {
      if (!(await change(tx))) return false;
      const groupIds = await deps.repo.membershipGroupIds(tx, input.userId);
      await deps.events.publishMembershipChanged(tx, { userId: input.userId, siteId: member.siteId, groupIds });
      return true;
    },
    { sleep: deps.sleep },
  );
}

/** Adds a user or group to a group unless it is a member [legacy: core/mura/user/userDAO.cfc:545-559]; true when a row was added. */
export function addToGroup(deps: GroupDeps, input: MembershipChange): Promise<boolean> {
  return changeMembership(deps, input, (tx) => deps.repo.addMembership(tx, input.userId, input.groupId));
}

/** Removes a user or group from a group [legacy: core/mura/user/userDAO.cfc:535-543]; true when a row was removed. */
export function removeFromGroup(deps: GroupDeps, input: MembershipChange): Promise<boolean> {
  return changeMembership(deps, input, (tx) => deps.repo.removeMembership(tx, input.userId, input.groupId));
}
