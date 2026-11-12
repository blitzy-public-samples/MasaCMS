// The value structs Masa's JSON API returns for its `user` and `address` entities: userDAO.read and readAddress with
// getAllValues (userBean.cfc, addressBean.cfc, beanExtendable.cfc), then jsonApiUtility getFilteredValues and the save
// return struct. Pure; @opt2/platform/legacy-compat's createApiSerializer turns the results into legacy JSON.
import {
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import type { AccountView } from '../legacy/identity-client.js';
import { ADDRESS, type AddressRow, type PersonRow } from '../repo/tables.js';
import type { ExtendSetData } from './extended-data.js';
import { applyUserInput, fullName, newUserValues, type CfNumeric, type UserValues } from './person.js';

/** The JSON API entities people serves. */
export type PeopleApiEntity = 'user' | 'address';

/** The getAllExtendSetData result a bean merges into its values. */
export type EntityExtendData = Pick<ExtendSetData, 'data' | 'extendSetId'>;

/** One stored user as people and identity hold it. */
export interface UserEntitySource {
  person: PersonRow;
  /** Identity's account columns of the user, read through identity's API. */
  account: AccountView;
  /** Membership group ids, in identity's `readMembershipIDs` order. */
  groupIds: readonly string[];
  /** Interest category ids, in `readInterestGroupIDs` order. */
  categoryIds: readonly string[];
  extend: EntityExtendData;
  /** `tfiles.fileExt` of the photo file the DAO joins; '' without one. */
  photoFileExt: string;
}

/** The clock `userBean.init` reads. */
type Clock = Parameters<typeof newUserValues>[0];

/** The named `addressBean` instance keys, lower-cased, with the `beanExtendable` keys the JSON API shows. */
type AddressBeanFields = {
  addressid: string;
  userid: string;
  siteid: string;
  isprimary: CfNumeric;
  address1: string;
  address2: string;
  fax: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  country: string;
  addressname: string;
  addressemail: string;
  addressnotes: string;
  addressurl: string;
  hours: string;
  longitude: CfNumeric;
  latitude: CfNumeric;
  errors: Record<string, unknown>;
  extenddatatable: string;
  isnew: CfNumeric;
  type: string;
  subtype: string;
  extendsetid: string;
};

/** The `addressBean` instance struct keyed by lower-cased name; extended attributes keep their spelling. */
export type AddressValues = AddressBeanFields & { [key: string]: unknown };

/** `addressBean.init` values (addressBean.cfc:113-139); a new address is not `isnew`. */
export const ADDRESS_BEAN_DEFAULTS: Readonly<AddressBeanFields> = Object.freeze({
  addressid: '',
  userid: '',
  siteid: '',
  isprimary: 0,
  address1: '',
  address2: '',
  fax: '',
  city: '',
  state: '',
  zip: '',
  phone: '',
  country: '',
  addressname: '',
  addressemail: '',
  addressnotes: '',
  addressurl: '',
  hours: '',
  longitude: 0,
  latitude: 0,
  errors: Object.freeze({}),
  extenddatatable: 'tclassextenddatauseractivity',
  isnew: 0,
  type: 'Address',
  subtype: 'Default',
  extendsetid: '',
});

const BEAN_KEYS_REMOVED = [
  'addobjects',
  'removeobjects',
  'sourceiterator',
  'frommuracache',
  'errors',
  'instanceid',
  'primarykey',
  'extenddatatable',
  'extenddata',
  'extendautocomplete',
  'saveerrors',
  'password',
];

/** Keys getFilteredValues removes from an address's values (jsonApiUtility.cfc:2166-2177). */
export const ADDRESS_EXCLUDED_KEYS: readonly string[] = Object.freeze([...BEAN_KEYS_REMOVED]);

/** Keys getFilteredValues removes from a user's or group's values (jsonApiUtility.cfc:2166-2186). */
export const USER_EXCLUDED_KEYS: readonly string[] = Object.freeze([
  ...BEAN_KEYS_REMOVED,
  'ukey',
  'hkey',
  'passedprotect',
  'extendsetid',
  'addresses',
]);

/** Defines `key` as an own data property, so a `__proto__` key stays data. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A simple value as CFML text, `''` for a NULL; throws where ACF refuses a complex value as a string. */
function simpleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** CFML listFindNoCase over a comma list. */
function listFindNoCase(list: string, value: string): boolean {
  const lower = value.toLowerCase();
  return cfListToArray(list).some((item) => item.toLowerCase() === lower);
}

const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

/** Identity's `LocalTimestamp` wall-clock text as the Date the legacy query returns; NULL stays null. */
function accountTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parts = LOCAL_TIMESTAMP.exec(value);
  if (parts === null) throw new TypeError(`${value} is not an identity LocalTimestamp`);
  const [year, month, day, hour, minute, second, ms] = parts.slice(1).map(Number) as [number, number, number, number, number, number, number];
  return new Date(year, month - 1, day, hour, minute, second, ms);
}

/**
 * The `userDAO.read` select list (userDAO.cfc:78) as `bean.set(rsUser)` receives it: lower-cased names, NULL as ''.
 * `set` also re-applies the user-pool rule to the stored SiteID; a stored user already sits in its pool site, so its
 * SiteID stands.
 */
function storedUserColumns({ person, account, photoFileExt }: UserEntitySource): Map<string, unknown> {
  const columns: ReadonlyArray<readonly [string, unknown]> = [
    ['userid', person.userid],
    ['groupname', person.groupname],
    ['fname', person.fname],
    ['lname', person.lname],
    ['username', account.username],
    ['passwordcreated', accountTimestamp(account.passwordCreated)],
    ['email', person.email],
    ['company', person.company],
    ['jobtitle', person.jobtitle],
    ['mobilephone', person.mobilephone],
    ['website', person.website],
    ['type', account.type],
    ['subtype', person.subtype],
    ['contactform', person.contactform],
    ['s2', account.s2],
    ['lastlogin', accountTimestamp(account.lastLogin)],
    ['lastupdate', person.lastupdate],
    ['lastupdateby', person.lastupdateby],
    ['lastupdatebyid', person.lastupdatebyid],
    ['perm', account.perm],
    ['inactive', account.inactive],
    ['ispublic', account.isPublic],
    // tusers.SiteID is an account column; person.siteid holds the same key.
    ['siteid', account.siteId],
    ['subscribe', person.subscribe],
    ['notes', person.notes],
    ['description', person.description],
    ['interests', person.interests],
    ['keepprivate', person.keepprivate],
    ['photofileid', person.photofileid],
    ['imname', person.imname],
    ['imservice', person.imservice],
    ['created', person.created],
    ['remoteid', account.remoteId],
    ['tags', person.tags],
    ['tablist', account.tablist],
    ['photofileext', photoFileExt],
  ];
  return new Map(columns.map(([name, value]) => [name, value ?? '']));
}

/** getAllValues(autocomplete=true): set data appended without overwriting a key in any case, set ids merged (userBean.cfc:246-258). */
function withExtendSetData<V extends Record<string, unknown> & { extendsetid: string }>(values: V, extend: EntityExtendData): V {
  const merged: Record<string, unknown> = { ...values };
  const keys = new Set(Object.keys(merged).map((key) => key.toLowerCase()));
  for (const [name, value] of Object.entries(extend.data)) {
    if (keys.has(name.toLowerCase())) continue;
    keys.add(name.toLowerCase());
    define(merged, name, value);
  }
  let setIds = values.extendsetid;
  for (const id of cfListToArray(extend.extendSetId)) {
    // listFind is case-sensitive.
    if (!cfListToArray(setIds).includes(id)) setIds = cfListAppend(setIds, id);
  }
  merged.extendsetid = setIds;
  return merged as V;
}

/** userDAO.read of a stored user with setUserBeanMetaData, then getAllValues(autocomplete=true) (userDAO.cfc:93-120, 924-933). */
export function userBeanValues(src: UserEntitySource, clock: Clock): UserValues {
  const stored = applyUserInput(newUserValues(clock), storedUserColumns(src));
  const meta = new Map([
    ['groupid', src.groupIds.join(',')],
    ['categoryid', src.categoryIds.join(',')],
  ]);
  return withExtendSetData({ ...applyUserInput(stored, meta), isnew: 0 }, src.extend);
}

type Setter = (values: Record<string, unknown>, value: unknown) => void;

/** A setter assigning a numeric argument only, as `setIsPrimary`, `setLongitude` and `setLatitude` do. */
function numericOnly(key: string): Setter {
  return (values, value) => {
    if (cfIsNumeric(value)) values[key] = value;
  };
}

/** `beanExtendable.setSiteID`/`setType`/`setSubType`: a non-empty trimmed value that differs ignoring case (beanExtendable.cfc:113-137). */
function changedText(key: string): Setter {
  return (values, value) => {
    const text = javaTrim(simpleText(value));
    if (text !== '' && !cfEq(text, simpleText(values[key]))) values[key] = text;
  };
}

/** The `addressBean` setters `setValue` dispatches to, by lower-cased property name. */
const ADDRESS_SETTERS: ReadonlyMap<string, Setter> = new Map<string, Setter>([
  ['isprimary', numericOnly('isprimary')],
  ['longitude', numericOnly('longitude')],
  ['latitude', numericOnly('latitude')],
  ['siteid', changedText('siteid')],
  ['type', changedText('type')],
  ['subtype', changedText('subtype')],
  [
    'errors',
    (values, value) => {
      if (isStruct(value)) values.errors = value;
    },
  ],
]);

/** `addressBean.set` of name-value pairs: `beanExtendable.setValue` trims simple values, then the setter runs or the key is assigned. */
function applyAddressInput(current: AddressValues, input: Iterable<readonly [string, unknown]>): AddressValues {
  const values: Record<string, unknown> = { ...current };
  for (const [key, raw] of input) {
    const value = typeof raw === 'string' ? javaTrim(raw) : typeof raw === 'number' ? cfNumberString(raw) : raw;
    const setter = ADDRESS_SETTERS.get(key.toLowerCase());
    if (setter !== undefined) setter(values, value);
    else define(values, key, value);
  }
  return values as AddressValues;
}

/** The `select * from tuseraddresses` columns of a stored address; `tenant_id` is target-only. */
const ADDRESS_COLUMNS: readonly string[] = ADDRESS.columns.map((column) => column.name).filter((name) => name !== 'tenant_id');

/** userDAO.readAddress of a stored address, then getAllValues (userDAO.cfc:720-747, addressBean.cfc:113-139). */
export function addressBeanValues(src: { address: AddressRow; extend: EntityExtendData }): AddressValues {
  const row: Readonly<Record<string, unknown>> = src.address;
  const stored = applyAddressInput(
    { ...ADDRESS_BEAN_DEFAULTS, errors: {} },
    ADDRESS_COLUMNS.map((name) => [name, row[name] ?? ''] as const),
  );
  return withExtendSetData(stored, src.extend);
}

/** getFilteredValues arguments and the request values it reads, for one user or address. */
export interface FilteredValuesOptions {
  entityName: PeopleApiEntity;
  /** The key whose value becomes `id`. */
  pk: 'userid' | 'addressid';
  /** `url.fields`. */
  fields?: string;
  /** The `expand` list. */
  expandLinks?: string;
  /** getLinks of the entity, built by the route. */
  links: Readonly<Record<string, string>>;
  /** Whether `url.entityname` is non-empty and names this entity, which lets `fields` apply to an expanded entity. */
  isEntityNameMatch: boolean;
  /** Expansion depth reached; save and findNew pass `true`, which counts as 1. */
  expanded?: number | boolean;
  /** isAggregateQuery() of the request. */
  isAggregateQuery?: boolean;
  /** `url.expanddepth` as requested; absent or non-numeric reads as 1. */
  expandDepth?: unknown;
  /** getExtendedData().getAllExtendSetData().data, read by the `extendeddata` field. */
  extendSetData?: EntityExtendData['data'];
  /** Results of the bean getters that read other data (e.g. `addresses`), keyed by lower-cased property; getValue prefers them. */
  getters?: Readonly<Record<string, unknown>>;
  /** The relations {@link expansionTargets} names, as the route's findOne serialized them, keyed by relation name. */
  expansions?: Readonly<Record<string, unknown>>;
}

/** One relation expandEntity expands: the related entity's findOne at the next depth (jsonApiUtility.cfc:2471-2482). */
export interface RelationTarget {
  name: 'user' | 'site';
  entityName: 'user' | 'site';
  id: string;
  expanded: number;
}

/** The hasOne relations of each entity, in property order; a user has none (addressBean.cfc:81-82). */
const RELATIONS: Readonly<Record<PeopleApiEntity, ReadonlyArray<{ name: RelationTarget['name']; column: string }>>> = {
  user: [],
  address: [
    { name: 'user', column: 'userid' },
    { name: 'site', column: 'siteid' },
  ],
};

/** getPrimaryKey() of each bean, as getFilteredValues appends it to `fields`. */
const PRIMARY_KEYS: Readonly<Record<PeopleApiEntity, string>> = { user: 'userID', address: 'addressID' };

type Lookup = (property: string) => unknown;

/** The `get<Property>()` getters getValue prefers that compute from the bean's own values (userBean.cfc:724-816, addressBean.cfc:212-268). */
const OWN_GETTERS: Readonly<Record<PeopleApiEntity, ReadonlyMap<string, (stored: Lookup) => unknown>>> = {
  user: new Map<string, (stored: Lookup) => unknown>([
    ['userid', (stored) => stored('userid')],
    [
      'fullname',
      (stored) =>
        fullName({
          type: simpleText(stored('type')),
          fname: simpleText(stored('fname')),
          lname: simpleText(stored('lname')),
          groupname: simpleText(stored('groupname')),
        }),
    ],
    ['firstname', (stored) => stored('fname') ?? ''],
    ['lastname', (stored) => stored('lname') ?? ''],
    ['primarykey', () => PRIMARY_KEYS.user],
    ['extendbaseid', (stored) => stored('userid')],
    ['entityname', (stored) => userEntityName(stored('type'))],
    ['entitydisplayname', (stored) => userEntityName(stored('type'))],
  ]),
  address: new Map<string, (stored: Lookup) => unknown>([
    ['addressid', (stored) => stored('addressid')],
    ['primarykey', () => PRIMARY_KEYS.address],
    ['extendbaseid', (stored) => stored('addressid')],
    ['entityname', () => 'address'],
    ['entitydisplayname', () => 'address'],
  ]),
};

/** CFML `type == 1` of a user bean. */
function isGroupType(type: unknown): boolean {
  return cfIsNumeric(type) && cfToNumber(type) === 1;
}

/** userBean.getEntityName: `group` for Type 1, else `user`. */
function userEntityName(type: unknown): string {
  return isGroupType(type) ? 'group' : 'user';
}

/** Expansion depth as a number; CFML reads `true` as 1. */
function depthOf(expanded: number | boolean | undefined): number {
  if (typeof expanded === 'boolean') return expanded ? 1 : 0;
  return expanded ?? 0;
}

/** Bean values read case-insensitively, as CFML struct keys resolve. */
function lookupOf(values: Readonly<Record<string, unknown>>): Lookup {
  const byName = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return (property) => byName.get(property.toLowerCase());
}

/** The relations expandEntity follows once getFilteredValues has built the values (jsonApiUtility.cfc:2227-2233, 2424-2484). */
export function expansionTargets(
  values: Readonly<Record<string, unknown>>,
  opts: Pick<FilteredValuesOptions, 'entityName' | 'expandLinks' | 'expanded' | 'isAggregateQuery' | 'expandDepth'>,
): RelationTarget[] {
  const expanded = opts.isAggregateQuery === true ? 0 : depthOf(opts.expanded);
  const expand = opts.expandLinks ?? '';
  const expandDepth = cfIsNumeric(opts.expandDepth) ? cfToNumber(opts.expandDepth) : 1;
  if (!(expanded < expandDepth) || expand === '') return [];
  const expandAll = cfEq(expand, 'all') || cfEq(expand, '*');
  const stored = lookupOf(values);
  return RELATIONS[opts.entityName]
    .filter(({ name }) => expandAll || listFindNoCase(expand, name))
    .map(({ name, column }) => ({ name, entityName: name, id: simpleText(stored(column)), expanded: expanded + 1 }));
}

/** The field list getFilteredValues settles (2084-2131); user and address register no config fields and allow field selection. */
function selectFields(opts: FilteredValuesOptions): { fields: string[]; allFields: boolean } {
  const aggregate = opts.isAggregateQuery === true;
  const doFields = (aggregate ? 0 : depthOf(opts.expanded)) === 0 || opts.isEntityNameMatch;
  let fields = '';
  if (doFields && (opts.fields ?? '') !== '') {
    fields = opts.fields ?? '';
    if (!aggregate) {
      const pk = PRIMARY_KEYS[opts.entityName];
      if (!listFindNoCase(fields, pk)) fields = cfListAppend(fields, pk);
      if (!listFindNoCase(fields, 'siteid')) fields = cfListAppend(fields, 'siteid');
    }
  }
  if (fields !== '' && !listFindNoCase(fields, 'isnew')) fields = cfListAppend(fields, 'isnew');
  const list = cfListToArray(fields);
  // arrayFind is case-sensitive: `ALL` is an ordinary field name.
  return { fields: list, allFields: list.length === 0 || list.includes('*') || list.includes('all') };
}

/** getFilteredValues (jsonApiUtility.cfc:2076-2236) of a user or address; keys are lower-cased, as the serializer writes them. */
export function filteredEntityValues(values: Readonly<Record<string, unknown>>, opts: FilteredValuesOptions): Record<string, unknown> {
  const stored = lookupOf(values);
  const getters = opts.getters ?? {};
  const ownGetters = OWN_GETTERS[opts.entityName];
  /** bean getValue: a getter's result, else the stored value, else '' for a missing property or attribute. */
  const beanValue = (property: string): unknown => {
    const lower = property.toLowerCase();
    if (Object.hasOwn(getters, lower)) return getters[lower];
    const getter = ownGetters.get(lower);
    if (getter !== undefined) return getter(stored);
    return stored(lower) ?? '';
  };
  const vals: Record<string, unknown> = {};
  const put = (key: string, value: unknown): void => define(vals, key.toLowerCase(), value);

  const { fields, allFields } = selectFields(opts);
  if (!allFields) {
    for (const f of fields) {
      if (cfEq(f, 'extendeddata')) {
        for (const [name, value] of Object.entries(opts.extendSetData ?? {})) put(name, value);
      } else if (cfEq(f, 'displayInterval')) {
        // Legacy calls getDisplayInterval(), which neither bean defines.
        throw new TypeError(`The ${opts.entityName} bean has no display interval`);
      } else {
        put(f, beanValue(cfListToArray(f, '.').at(-1) ?? ''));
      }
    }
    delete vals.password;
  } else {
    for (const [key, value] of Object.entries(values)) put(key, value);
    for (const key of opts.entityName === 'user' ? USER_EXCLUDED_KEYS : ADDRESS_EXCLUDED_KEYS) delete vals[key];
  }

  put('id', beanValue(opts.pk));
  if (allFields || fields.includes('links')) put('links', { ...opts.links });
  if (opts.entityName === 'user') put('type', isGroupType(stored('type')) ? 'group' : 'user');
  put('entityname', opts.entityName);

  for (const target of expansionTargets(values, opts)) {
    if (opts.expansions === undefined || !Object.hasOwn(opts.expansions, target.name)) {
      throw new TypeError(`The ${target.name} relation of the ${opts.entityName} was not expanded`);
    }
    put(target.name, opts.expansions[target.name]);
  }
  return vals;
}

/** What the saved bean reports: its `saveErrors` flag and `errors` struct. */
export interface SaveOutcome {
  saveErrors: unknown;
  errors: Readonly<Record<string, unknown>>;
}

/** The save re-applies the posted values when it failed and `saveErrors` is not true (jsonApiUtility.cfc:2047). */
function overlaysRequestValues({ saveErrors, errors }: SaveOutcome): boolean {
  return !(cfIsBoolean(saveErrors) && cfToBoolean(saveErrors)) && Object.keys(errors).length > 0;
}

/**
 * jsonApiUtility.cfc:2047-2056: after a failed save without `saveErrors`, each posted value whose key the re-read bean
 * holds, set through the bean's setters; otherwise the values unchanged. `input` is keyed by lower-cased name.
 */
export function overlayRequestValues(values: UserValues, input: ReadonlyMap<string, unknown>, outcome: SaveOutcome & { entityName: 'user' }): UserValues;
export function overlayRequestValues(
  values: AddressValues,
  input: ReadonlyMap<string, unknown>,
  outcome: SaveOutcome & { entityName: 'address' },
): AddressValues;
export function overlayRequestValues(
  values: UserValues | AddressValues,
  input: ReadonlyMap<string, unknown>,
  outcome: SaveOutcome & { entityName: PeopleApiEntity },
): UserValues | AddressValues {
  if (!overlaysRequestValues(outcome)) return values;
  // CFML struct keys match case-insensitively; a posted key updates the bean's own spelling.
  const spellings = new Map(Object.keys(values).map((key) => [key.toLowerCase(), key]));
  const posted: Array<[string, unknown]> = [];
  for (const [key, value] of input) {
    const spelling = spellings.get(key.toLowerCase());
    if (spelling !== undefined) posted.push([spelling, value]);
  }
  return outcome.entityName === 'user' ? applyUserInput(values as UserValues, new Map(posted)) : applyAddressInput(values as AddressValues, posted);
}

/** The save return struct (jsonApiUtility.cfc:2060-2063): the re-read entity's filtered values, then `saveerrors` and `errors`. */
export function saveResponse(values: Readonly<Record<string, unknown>>, { saveErrors, errors }: SaveOutcome): Record<string, unknown> {
  const response: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) define(response, key, value);
  define(response, 'saveerrors', saveErrors);
  define(response, 'errors', errors);
  return response;
}
