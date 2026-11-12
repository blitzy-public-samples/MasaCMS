// Masa userBean and userManager value shaping of a Type=2 user before a save: defaults, setters, the user-pool rule,
// controller input restrictions and the split into people's person columns and identity's account change.
import {
  LegacyServiceUnavailableError,
  cfEq,
  cfIsBoolean,
  cfIsDate,
  cfIsDateText,
  cfIsNumeric,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfToBoolean,
  cfToNumber,
  javaTrim,
  legacyQuery,
  type LegacyQuery,
} from '@opt2/platform/legacy-compat';
import { registryEntryForTenant, tenantIdForSite, type RegistrySource, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import type { UserClaims } from '@opt2/platform/auth';
import type { AccountPrepareRequest, ActingUser } from '../legacy/identity-client.js';
import type { AuditActor } from '../repo/repository.js';
import { PERSON, PERSON_COLUMNS, type PersonRow } from '../repo/tables.js';

export { lastUpdateInfo, type AuditActor } from '../repo/repository.js';

/** A numeric bean property: a number, or the posted text CFML treats as one until the DAO inlines it. */
export type CfNumeric = number | string;

/** A date bean property: a Date once parsed, else `''` or text no date parser accepted. */
export type CfDate = Date | string;

/** The named `userBean` instance keys, lower-cased [legacy: core/mura/user/userBean.cfc:77-182]. */
type UserBeanFields = {
  userid: string;
  remoteid: string;
  groupname: string;
  fname: string;
  lname: string;
  username: string;
  password: string;
  passwordcreated: CfDate;
  email: string;
  company: string;
  jobtitle: string;
  website: string;
  mobilephone: string;
  type: CfNumeric;
  subtype: string;
  s2: CfNumeric;
  // init sets `contactform`, the column name; the `contactFormat` cfproperty never becomes an instance key.
  contactform: string;
  lastlogin: CfDate;
  lastupdate: CfDate;
  lastupdateby: string;
  lastupdatebyid: string;
  created: CfDate;
  perm: CfNumeric;
  inactive: CfNumeric;
  ispublic: CfNumeric;
  siteid: string;
  subscribe: CfNumeric;
  notes: string;
  groupid: string;
  categoryid: string;
  primaryaddressid: string;
  addressid: string;
  addresses: unknown;
  description: string;
  interests: string;
  photofileid: string;
  photofileext: string;
  keepprivate: CfNumeric;
  imname: string;
  imservice: string;
  tags: string;
  hkey: string;
  ukey: string;
  passedprotect: boolean | string;
  extendsetid: string;
  extenddatatable: string;
  errors: Record<string, unknown>;
  isnew: CfNumeric;
  tablist: string;
  newfile: string;
};

/** The `userBean` instance struct keyed by lower-cased name; every other posted key is kept as the bean keeps it. */
export type UserValues = UserBeanFields & { [key: string]: unknown };

/** `userBean.init` values that are not the clock's `now()`. */
export type UserBeanDefaults = Omit<UserBeanFields, 'passwordcreated' | 'lastupdate' | 'created'>;

/** The address query columns of `userBean.init` [legacy: core/mura/user/userBean.cfc:162]. */
const ADDRESS_QUERY_COLUMNS = [
  'addressid', 'userid', 'siteid', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'isPrimary', 'addressName',
  'addressNotes', 'phone', 'fax', 'addressURL', 'longitude', 'latitude', 'addressEmail', 'hours',
];

function emptyAddresses(): LegacyQuery {
  return legacyQuery([...ADDRESS_QUERY_COLUMNS], []);
}

/** `userBean.init` defaults; the "Member" default of `ispublic` 1 is legacy's and stays. */
export const USER_BEAN_DEFAULTS: Readonly<UserBeanDefaults> = Object.freeze({
  userid: '',
  remoteid: '',
  groupname: '',
  fname: '',
  lname: '',
  username: '',
  password: '',
  email: '',
  company: '',
  jobtitle: '',
  website: '',
  mobilephone: '',
  type: 2,
  subtype: 'Default',
  s2: 0,
  contactform: '',
  lastlogin: '',
  lastupdateby: '',
  lastupdatebyid: '',
  perm: 0,
  inactive: 0,
  ispublic: 1,
  siteid: '',
  subscribe: 1,
  notes: '',
  groupid: '',
  categoryid: '',
  primaryaddressid: '',
  addressid: '',
  addresses: Object.freeze(emptyAddresses()),
  description: '',
  interests: '',
  photofileid: '',
  photofileext: '',
  keepprivate: 0,
  imname: '',
  imservice: '',
  tags: '',
  hkey: '',
  ukey: '',
  passedprotect: true,
  extendsetid: '',
  extenddatatable: 'tclassextenddatauseractivity',
  errors: Object.freeze({}),
  isnew: 1,
  tablist: '',
  newfile: '',
});

/** A new bean's values: the defaults plus `passwordcreated`, `lastupdate` and `created` at `clock.now()`. */
export function newUserValues(clock: Clock): UserValues {
  const now = clock.now().getTime();
  return {
    ...USER_BEAN_DEFAULTS,
    passwordcreated: new Date(now),
    lastupdate: new Date(now),
    created: new Date(now),
    addresses: emptyAddresses(),
    errors: {},
  };
}

/** Request parameters keyed by lower-cased name; a key repeated in another casing keeps the later value, as a CFML struct does. */
export function normaliseParams(params: Readonly<Record<string, unknown>>): Map<string, unknown> {
  const normalised = new Map<string, unknown>();
  for (const [key, value] of Object.entries(params)) normalised.set(key.toLowerCase(), value);
  return normalised;
}

/** A simple value as CFML text: `''` for a NULL; throws where ACF rejects a complex value as a string. */
function simpleText(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  throw new TypeError(`The ${name} value is not a simple value`);
}

/** The argument `beanExtendable.setValue` passes on: simple values trimmed, which makes numbers text; others unchanged. */
function setterArgument(value: unknown): unknown {
  if (typeof value === 'string') return javaTrim(value);
  if (typeof value === 'number') return cfNumberString(value);
  return value;
}

function isLegacyQuery(value: unknown): value is LegacyQuery {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'query';
}

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !isLegacyQuery(value);
}

/** CFML `isDate` of a setter argument. */
function isDateArgument(value: unknown): boolean {
  return cfIsDate(value) || (typeof value === 'string' && cfIsDateText(value));
}

/** CFML `parseDateTime` of an argument `isDate` accepted. */
function parseDateTimeArgument(value: unknown): Date {
  return value instanceof Date ? value : cfParseDateTimeText(simpleText(value, 'date'));
}

const ISO_DATE_TIME = /\d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/;
// CFML's Perl5 `\s` is the five ASCII whitespace characters, not JavaScript's Unicode set.
const SPACED_DATE_TIME = /\d\d\d\d-\d\d-\d\d[ \t\n\r\f]\d\d:\d\d:\d\d/;

/** `bean.parseDateArg`: a parsed date, the text itself when parsing throws, or `''` [legacy: core/mura/bean/bean.cfc:278-301]. */
function parseDateArg(value: unknown): CfDate {
  if (value instanceof Date) return value;
  let text = simpleText(value, 'date');
  if (ISO_DATE_TIME.test(text)) text = text.replace('T', ' ');
  const parse = (parser: (s: string) => Date): CfDate => {
    try {
      return parser(text);
    } catch {
      return text;
    }
  };
  if (!SPACED_DATE_TIME.test(text) && cfLsIsDate(text)) return parse(cfLsParseDateTime);
  if (cfIsDateText(text)) return parse(cfParseDateTimeText);
  return '';
}

type Setter = (values: Record<string, unknown>, value: unknown) => void;

/** A setter assigning `key` only when `accepts` holds, as the guarded bean setters do. */
function guarded(key: string, accepts: (value: unknown) => boolean, convert: (value: unknown) => unknown = (value) => value): Setter {
  return (values, value) => {
    if (accepts(value)) values[key] = convert(value);
  };
}

/** A setter assigning the converted argument to `key`. */
function assigns(key: string, convert: (value: unknown) => unknown): Setter {
  return (values, value) => {
    values[key] = convert(value);
  };
}

const trimmedText = (name: string) => (value: unknown): string => javaTrim(simpleText(value, name));

/** `userBean.setType`: numeric as is, 'group' (any case) 1, any other text 2 [legacy: core/mura/user/userBean.cfc:753-766]. */
function legacyType(value: unknown): number {
  if (cfIsNumeric(value)) return cfToNumber(value);
  return cfEq(simpleText(value, 'type'), 'group') ? 1 : 2;
}

/** `beanExtendable.setSubType`/`setSiteID`: a non-empty trimmed value that differs ignoring case [legacy: core/mura/bean/beanExtendable.cfc:122-137]. */
function changedText(key: string): Setter {
  return (values, value) => {
    const text = javaTrim(simpleText(value, key));
    if (text !== '' && !cfEq(text, simpleText(values[key], key))) values[key] = text;
  };
}

/** The bean setters `setValue` dispatches to, by lower-cased property name. */
const SETTERS: ReadonlyMap<string, Setter> = new Map<string, Setter>([
  ['lastupdateby', assigns('lastupdateby', (value) => trimmedText('lastUpdateBy')(value).slice(0, 50))],
  ['lastlogin', guarded('lastlogin', isDateArgument, parseDateTimeArgument)],
  ['passwordcreated', guarded('passwordcreated', isDateArgument, parseDateTimeArgument)],
  ['lastupdate', assigns('lastupdate', parseDateArg)],
  ['created', assigns('created', parseDateArg)],
  ['groupid', assigns('groupid', trimmedText('groupID'))],
  ['categoryid', assigns('categoryid', trimmedText('categoryID'))],
  ['usernamenocache', assigns('username', trimmedText('Username'))],
  ['passwordnocache', assigns('password', trimmedText('Password'))],
  ['addresses', guarded('addresses', (value) => !isLegacyQuery(value))],
  ['keepprivate', guarded('keepprivate', cfIsNumeric, cfToNumber)],
  ['passedprotect', guarded('passedprotect', cfIsBoolean)],
  ['type', assigns('type', legacyType)],
  ['firstname', assigns('fname', (value) => value)],
  ['lastname', assigns('lname', (value) => value)],
  ['subtype', changedText('subtype')],
  ['siteid', changedText('siteid')],
  ['errors', guarded('errors', isStruct)],
]);

/** `userBean.set` of a parameter struct: each key through its setter, else assigned (simple values trimmed). */
export function applyUserInput(current: UserValues, input: ReadonlyMap<string, unknown>): UserValues {
  const values: Record<string, unknown> = { ...current };
  for (const [key, raw] of input) {
    const value = setterArgument(raw);
    const setter = SETTERS.get(key);
    if (setter !== undefined) {
      setter(values, value);
    } else {
      // Defined, not assigned, so a posted `__proto__` stays a data key.
      Object.defineProperty(values, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return values as UserValues;
}

/** The user-pool site, pool tenant and `isPublic` a save lands in. */
export interface UserSite {
  /** The legacy pool site id, written to `tusers.SiteID` and the address and tag `siteid`. */
  siteId: string;
  poolTenantId: string;
  isPublic: CfNumeric;
}

const SITE_ID_REQUIRED = "The attribute 'SITEID' is required when saving a user.";

/** A numeric property as a number when CFML reads it as one, else its text. */
function numericValue(value: unknown, name: string): CfNumeric {
  return cfIsNumeric(value) ? cfToNumber(value) : simpleText(value, name);
}

function userPool(entry: TenantRegistryEntry, isPublic: boolean): { siteId: string; tenantId: string } {
  // settingsBean defaults an empty pool id to the site's own id.
  const siteId = (isPublic ? entry.publicUserPoolId : entry.privateUserPoolId) ?? entry.siteId;
  const tenantId = (isPublic ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId);
  return { siteId, tenantId };
}

/** The `userBean.set` pool rule for a posted `siteid`, over `applyUserInput`'s result and the `tid` registry entry [legacy: core/mura/user/userBean.cfc:227-239]. */
export async function resolveUserSite(
  registry: RegistrySource,
  tid: string,
  data: ReadonlyMap<string, unknown>,
  current: UserValues,
): Promise<UserSite> {
  const currentSite = simpleText(current.siteid, 'siteid');
  const isPublic = numericValue(current.ispublic, 'ispublic');
  if (javaTrim(simpleText(data.get('siteid'), 'siteid')) === '') {
    if (javaTrim(currentSite) === '') throw new Error(SITE_ID_REQUIRED);
    return { siteId: currentSite, poolTenantId: tenantIdForSite(javaTrim(currentSite)), isPublic };
  }
  // One registry read: the entry carries the pool tenants poolTenantFor would read.
  const entry = await registryEntryForTenant(registry, tid);
  if (entry === null) {
    throw new LegacyServiceUnavailableError(`Tenant ${tid} has no site registry entry`, 'auto', 'tenant-unregistered');
  }
  const flag = (name: string): boolean => cfEq(javaTrim(simpleText(data.get(name), name)), '1');
  if (flag('switchtopublic')) {
    const pool = userPool(entry, true);
    return { siteId: pool.siteId, poolTenantId: pool.tenantId, isPublic: 1 };
  }
  if (flag('switchtoprivate')) {
    const pool = userPool(entry, false);
    return { siteId: pool.siteId, poolTenantId: pool.tenantId, isPublic: 0 };
  }
  const pool = userPool(entry, !(typeof isPublic === 'number' && isPublic === 0));
  // setSiteID keeps the current id when the pool id differs only in case [legacy: core/mura/bean/beanExtendable.cfc:131-137].
  const siteId = pool.siteId !== '' && !cfEq(javaTrim(pool.siteId), currentSite) ? javaTrim(pool.siteId) : currentSite;
  return { siteId, poolTenantId: pool.tenantId, isPublic };
}

/** `userBean.getFullName`: trimmed first and last name for a user, the group name otherwise. */
export function fullName(v: Pick<UserValues, 'type' | 'fname' | 'lname' | 'groupname'>): string {
  if (cfEq(simpleText(v.type, 'type'), '2')) return javaTrim(`${simpleText(v.fname, 'fname')} ${simpleText(v.lname, 'lname')}`);
  return simpleText(v.groupname, 'groupname');
}

/** Who acts in `cusers.update`: a super user, and whether the stored user named by a CF UUID `userid` is S2. */
export interface AdminRestriction {
  actorIsSuperUser: boolean;
  targetIsS2: boolean;
}

/** Keys a non-super user cannot post for an S2 user [legacy: admin/core/controllers/cusers.cfc:301-307]. */
const S2_TARGET_PROTECTED_KEYS = ['username', 'password', 'password2', 'passwordnocache', 'email', 'inactive', 'ispublic'] as const;

/** The `cusers` input rules of `before()` and `update` [legacy: admin/core/controllers/cusers.cfc:97-99, 294-313]. */
export function restrictAdminInput(
  input: ReadonlyMap<string, unknown>,
  { actorIsSuperUser, targetIsS2 }: AdminRestriction,
): { input: Map<string, unknown>; action: string } {
  const restricted = new Map(input);
  let action = simpleText(restricted.get('action'), 'action');
  if (!actorIsSuperUser) {
    restricted.delete('s2');
    if (targetIsS2) {
      for (const key of S2_TARGET_PROTECTED_KEYS) restricted.delete(key);
      if (cfEq(action, 'delete')) {
        action = 'invalid';
        restricted.set('action', action);
      }
    }
  }
  return { input: restricted, action };
}

/** Keys `ceditprofile.update` removes before saving. */
const PROFILE_STRIPPED_KEYS = ['ispublic', 's2', 'type', 'groupid'] as const;

/** The `ceditprofile.update` input: the session user's `userid` and `siteid`, without the account-level keys; save with `updateGroups=false`. */
export function restrictProfileInput(
  input: ReadonlyMap<string, unknown>,
  session: { userId: string; siteId: string },
): Map<string, unknown> {
  const restricted = new Map(input);
  restricted.set('userid', session.userId);
  restricted.set('siteid', session.siteId);
  for (const key of PROFILE_STRIPPED_KEYS) restricted.delete(key);
  return restricted;
}

/** `userManager` update/create: only a super user keeps `s2`, and an S2 user is never public [legacy: core/mura/user/userManager.cfc:438-445]. */
export function applySuperUserRule(values: UserValues, actorIsSuperUser: boolean): UserValues {
  const next: UserValues = { ...values };
  if (!actorIsSuperUser) next.s2 = 0;
  if (cfToBoolean(next.s2)) next.ispublic = 0;
  return next;
}

/** The DAO's `null="#iif(x neq '',…)#"` rule: an empty string is written as NULL. */
export function nullIfEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

/** A flag as the DAO's inlined `#value#` lands in an int column: SQL Server truncates decimals; non-numeric text fails. */
function sqlInteger(value: unknown): number {
  return Math.trunc(cfToNumber(value));
}

/** One of people's 24 `tusers` columns. */
export type PersonColumn = (typeof PERSON_COLUMNS)[number];

/** People's columns of a user save, as `people.person` stores them. */
export type PersonWrite = Pick<PersonRow, PersonColumn>;

/** Identity's account, credential and membership part of a user save: the `:prepare` body without `kind`. */
export type AccountWrite = Omit<AccountPrepareRequest, 'kind'>;

const PERSON_COLUMN_TYPES: ReadonlyMap<string, string> = new Map(PERSON.columns.map((column) => [column.name, column.type]));

function personColumnValue(column: PersonColumn, value: unknown): unknown {
  // userDAO never writes Ext, and writes LastUpdate and created as now() [legacy: core/mura/user/userDAO.cfc:304-307, 411-453].
  if (column === 'ext') return null;
  switch (PERSON_COLUMN_TYPES.get(column)) {
    case 't':
      return value instanceof Date ? value : null;
    case 'i':
      return sqlInteger(value);
    default:
      return nullIfEmpty(simpleText(value, column));
  }
}

/** The values of a Type=2 user save split into people's person columns and identity's `:prepare` account change. */
export function splitUserValues(values: UserValues): { person: PersonWrite; account: AccountWrite } {
  if (sqlInteger(values.type) !== 2) throw new TypeError('splitUserValues splits Type=2 users only');
  const person: Record<string, unknown> = {};
  for (const column of PERSON_COLUMNS) person[column] = personColumnValue(column, values[column]);

  const fields: AccountWrite['account'] = {
    UserName: simpleText(values.username, 'username'),
    // The contract carries S2 as 0|1; legacy grants S2 for any non-zero value [legacy: core/mura/user/userUtility.cfc:332].
    S2: sqlInteger(values.s2) === 0 ? 0 : 1,
    Perm: sqlInteger(values.perm),
    InActive: sqlInteger(values.inactive),
    isPublic: sqlInteger(values.ispublic),
    // userBean has no Admin property, so a save carries 0 unless the values hold one; tablist is not part of the contract.
    Admin: values.admin === undefined ? 0 : sqlInteger(values.admin),
    remoteID: simpleText(values.remoteid, 'remoteid'),
    Type: 2,
  };
  // userDAO.update writes Password and passwordCreated only for a posted password [legacy: core/mura/user/userDAO.cfc:417-420].
  const password = simpleText(values.password, 'password');
  if (password !== '') fields.Password = password;

  const groupIds = simpleText(values.groupid, 'groupid')
    .split(',')
    .filter((id) => id !== '');
  return {
    person: person as PersonWrite,
    account: { siteId: simpleText(values.siteid, 'siteid'), account: fields, groupIds },
  };
}

/** The actor `lastUpdateInfo` stamps: the logged-in session user from verified claims and identity's names; undefined when anonymous. */
export function auditActorFor(claims: UserClaims | undefined, acting: ActingUser | undefined): AuditActor | undefined {
  if (claims === undefined || acting === undefined) return undefined;
  return { userId: claims.sub, fname: acting.fname, lname: acting.lname, isLoggedIn: true };
}
