// The people reads of the cUsers admin circuit: group and user lists, search, advanced search, the Edit User and Edit
// Address reads, and `route()` with its return-URL sanitising [legacy: admin/core/controllers/cusers.cfc:172-451,498-518].
import { Roles, hasAnyRole, serviceRole, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import {
  LegacyServiceUnavailableError,
  accessControlOriginDomains,
  cfDateTimeFormat,
  cfEq,
  cfIsNumeric,
  cfListToArray,
  cfNumberString,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  createApiSerializer,
  esapiUrlEncode,
  javaTrim,
  type ApiKeyHint,
  type LegacyQuery,
} from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type Clock, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  registryEntries,
  registryEntryForTenant,
  tenantForRegisteredSite,
  tenantIdForSite,
  withTenant,
  type TenantDb,
  type TenantRegistryEntry,
  type TenantTx,
} from '@opt2/platform/tenancy';
import { listAddresses } from '../domain/addresses.js';
import { extendSetData, type ExtendValue } from '../domain/extended-data.js';
import { newUserValues, type UserValues } from '../domain/person.js';
import { awaitPersonOpen, observePersons, type PersonObserver, type PersonObserverDeps } from '../domain/roster-protocol.js';
import {
  buildAdvancedSearchCriteria,
  getAdvancedSearch,
  getAdvancedSearchPage,
  getAllSitesUsers,
  getAllSitesUsersPage,
  getSearch,
  getSearchPage,
  getUnassignedUsers,
  getUsers,
  getUsersPage,
  newAdvancedSearchCriteria,
  numericArgument,
  pageRows,
  type AdvancedSearchCriteria,
  type NextN,
  type SearchDeps,
  type UsersPage,
  type UsersPaging,
  type UsersQueryArgs,
} from '../domain/search.js';
import { addressesQuery, filteredEntityValues, userBeanValues, withExtendSetData } from '../domain/user-entity.js';
import type { components, operations } from '../generated/openapi.js';
import type { AdminSessionState, GroupSummary, IdentityClient, SessionSite, UserGroupRow } from '../legacy/identity-client.js';
import type { PeopleRepository } from '../repo/repository.js';
import type { AddressRow, ExtendSubtypeRow, PersonRow } from '../repo/tables.js';
import {
  AdminDenial,
  CUSERS_ROUTE_REQUIRES,
  isSuperViewer,
  normaliseCusersParams,
  requireCusersAccess,
  sendAdminDenial,
  viewerScopeFor,
  type CusersContext,
  type CusersParamsOptions,
} from './access.js';

type Schemas = components['schemas'];
type PersonRecord = Schemas['PersonRecord'];
type AddressRecord = Schemas['AddressRecord'];
type GroupOption = Schemas['GroupOption'];
type UserListRow = Schemas['UserListRow'];
type RouteRedirect = Schemas['RouteRedirect'];
type CurrentUserQuery = operations['readCurrentUser']['parameters']['query'];

/** What the cUsers reads use; `photoFileExts` is strategies-content's photo lookup, without which every `photoFileExt` is ''. */
export type AdminUserRouteDeps = {
  db: TenantDb;
  repository: PeopleRepository;
  identity: IdentityClient;
  clock: Clock;
  photoFileExts?: SearchDeps['photoFileExts'];
  /** Waits between closed-user polls; defaults to a timer. */
  sleep?: SearchDeps['sleep'];
  /** The roster protocol's wait on a user an open operation closes; defaults to `awaitPersonOpen`. */
  awaitPersonOpen?: (db: TenantDb, tenantId: string, userId: string, opts: { clock: Clock }) => Promise<void>;
};

/** What `sanitizeHref` checks an absolute URL against. */
export interface HrefOptions {
  /** `getSite(session.siteid).getDomain()`, which replaces a host outside `allowedDomains`. */
  siteDomain: string;
  /** settingsManager `getAccessControlOriginDomainList()` entries. */
  allowedDomains: readonly string[];
}

/** The `rc` values `route()` reads. */
export type RouteContext = Pick<CusersContext, 'routeid' | 'returnurl' | 'siteid' | 'ispublic'>;

const CUSERS_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: CUSERS_ROUTE_REQUIRES });

// `siteid=all` is no site, so the handler's own `before()` check holds every other value to the token's site.
const LIST_USERS_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: CUSERS_ROUTE_REQUIRES, siteCheck: false });

// Only identity's `findCurrentUser` reads it; the auth hooks hold `siteid` to a present user token's site.
const CURRENT_USER_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('identity')]) });

// The readCurrentUser query as the contract declares it; Fastify validates it once, before the handler.
const CURRENT_USER_QUERY = {
  type: 'object',
  required: ['siteid', 'endpoint', 'adminpath'],
  properties: {
    siteid: { type: 'string', minLength: 1 },
    fields: { type: 'string' },
    expand: { type: 'string' },
    expanddepth: { type: 'string' },
    endpoint: { type: 'string', minLength: 1 },
    adminpath: { type: 'string', minLength: 1 },
    groupids: { type: 'string' },
  },
} as const;

/** userBean properties whose datatype registerEntity hints for the JSON API serializer (jsonApiUtility.cfc:261-271; userBean.cfc:78-123). */
const USER_ENTITY_HINTS: readonly ApiKeyHint[] = Object.freeze([
  ...['type', 's2', 'perm', 'inactive', 'ispublic', 'subscribe', 'keepprivate', 'isnew'].map((key): ApiKeyHint => ({ key, hint: 'integer' })),
  ...['passwordcreated', 'lastlogin', 'lastupdate', 'created'].map((key): ApiKeyHint => ({ key, hint: 'date' })),
]);

/** addressBean `numeric` properties registerEntity hints as floats, which an `addresses` query's cells take (addressBean.cfc:83-98). */
const ADDRESS_ENTITY_HINTS: readonly ApiKeyHint[] = Object.freeze(['isprimary', 'longitude', 'latitude'].map((key): ApiKeyHint => ({ key, hint: 'float' })));

/** `tusers` columns in bootstrap casing without `Password`, plus `photoFileExt`, with the kind each value takes on the wire. */
const TUSERS_COLUMNS: ReadonlyArray<readonly [name: string, kind: 's' | 'i' | 't']> = [
  ['UserID', 's'], ['GroupName', 's'], ['Fname', 's'], ['Lname', 's'], ['UserName', 's'], ['PasswordCreated', 't'],
  ['Email', 's'], ['Company', 's'], ['JobTitle', 's'], ['mobilePhone', 's'], ['Website', 's'], ['Type', 'i'],
  ['subType', 's'], ['Ext', 'i'], ['ContactForm', 's'], ['Admin', 'i'], ['S2', 'i'], ['LastLogin', 't'],
  ['LastUpdate', 't'], ['LastUpdateBy', 's'], ['LastUpdateByID', 's'], ['Perm', 'i'], ['InActive', 'i'], ['isPublic', 'i'],
  ['SiteID', 's'], ['Subscribe', 'i'], ['notes', 's'], ['description', 's'], ['interests', 's'], ['keepPrivate', 'i'],
  ['photoFileID', 's'], ['photoFileExt', 's'], ['IMName', 's'], ['IMService', 's'], ['created', 't'], ['remoteID', 's'],
  ['tags', 's'], ['tablist', 's'],
];

/** Bootstrap spelling of each `tusers` column, by lower-cased name. */
const TUSERS_SPELLING: ReadonlyMap<string, string> = new Map(TUSERS_COLUMNS.map(([name]) => [name.toLowerCase(), name]));

/** `tuseraddresses` columns in bootstrap casing. */
const ADDRESS_COLUMNS = [
  'addressID', 'userID', 'siteID', 'addressName', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone', 'fax',
  'isPrimary', 'addressNotes', 'addressURL', 'longitude', 'latitude', 'addressEmail', 'hours',
] as const;

const DEFAULT_SITE_ID = 'default';
const EDIT_BEAN_KEY = 'editbean';

// ---- route() and URL sanitising [legacy: core/mura/utility.cfc:1326-1469] ----

/** CFML `listFirst(s, delim)`: the first non-empty item, or `''`. */
function listFirst(s: string, delim: string): string {
  return cfListToArray(s, delim)[0] ?? '';
}

/** utility `parseDomain`: the host of `scheme://host…`, else the input; a leading `//` reads the first path item. */
export function parseDomain(url: string): string {
  const parsed = /^\w+:\/\/([^/:]+)[\s\S]*$/.exec(url)?.[1] ?? url;
  return parsed.length > 1 && parsed.startsWith('//') ? listFirst(parsed.slice(2), '/') : parsed;
}

/** utility `removeLeadingDoubleSlash`: a trimmed `//x` becomes `/x`, exactly `//` becomes `/`, anything else is only trimmed. */
export function removeLeadingDoubleSlash(url: string): string {
  let clean = javaTrim(url);
  if (clean.length > 1 && clean.startsWith('//')) {
    clean = clean.length > 2 ? clean.slice(2) : '';
    if (!clean.startsWith('/')) clean = `/${clean}`;
  }
  return clean;
}

/**
 * utility `sanitizeHref`: a scheme-relative href becomes root-relative, `//host` runs are cut from an http(s) path, and an
 * http(s) host outside `allowedDomains` becomes `siteDomain`; anything else passes trimmed, a blank href unchanged.
 * @throws RangeError For an http(s) URL whose path starts right after `://`, where ACF's `left(…, 0)` fails.
 */
export function sanitizeHref(href: string, { siteDomain, allowedDomains }: HrefOptions): string {
  let clean = javaTrim(href);
  if (clean === '') return href;
  if (clean.length > 1 && clean.startsWith('//')) {
    if (clean.length === 2) return '/';
    clean = clean.slice(2);
    return clean.startsWith('/') ? clean : `/${clean}`;
  }
  const scheme = listFirst(clean, ':');
  if (!['http', 'https'].includes(scheme.toLowerCase())) return clean;

  const protocolEnd = clean.indexOf('://');
  if (protocolEnd >= 0) {
    const afterProtocol = clean.slice(protocolEnd + 3);
    const slashAt = afterProtocol.indexOf('/');
    if (slashAt === 0) throw new RangeError(`sanitizeHref: no host before the path of ${clean}`);
    if (slashAt > 0) {
      const pathPart = afterProtocol.slice(slashAt).replace(/\/\/[^/]+/g, '');
      clean = `${scheme}://${afterProtocol.slice(0, slashAt)}${pathPart}`;
    }
  }
  const urlDomain = parseDomain(clean);
  const lower = urlDomain.toLowerCase();
  if (urlDomain !== '' && !allowedDomains.some((domain) => domain.toLowerCase() === lower)) {
    // CFML replace() swaps the first occurrence, case-sensitively, inserting the domain literally.
    clean = clean.replace(urlDomain, () => siteDomain);
  }
  return clean;
}

/**
 * cusers `route()`'s target: the sanitised `returnurl`, else `cUsers.listusers`, or `cUsers.editgroup` of a non-empty
 * `routeid`, each appending what FW/1's `append` names [legacy: admin/core/controllers/cusers.cfc:377-398].
 */
export function routeRedirect(ctx: RouteContext, sanitize: (href: string) => string): RouteRedirect {
  if (ctx.routeid !== '') return { action: 'cUsers.editgroup', params: { siteid: ctx.siteid, userid: ctx.routeid } };
  if (ctx.returnurl !== '') return { url: sanitize(removeLeadingDoubleSlash(ctx.returnurl)) };
  return { action: 'cUsers.listusers', params: { siteid: ctx.siteid, ispublic: ctx.ispublic } };
}

/**
 * `sanitizeHref` over people's site registry: every site's origin domains, and the domain of the session site (the
 * token's site), with getSite's `default` fallback; a site without a domain gives ''.
 */
export async function hrefSanitizer(db: TenantDb, claims: Pick<UserClaims, 'site'>): Promise<(href: string) => string> {
  const entries = await registryEntries(db);
  const allowedDomains = accessControlOriginDomains(entries.map((entry) => ({ domain: entry.domains.join(',') })), {});
  // getSite reads a ColdFusion struct, whose keys match ignoring case.
  const named = (id: string): TenantRegistryEntry | undefined => entries.find((entry) => entry.siteId.toLowerCase() === id.toLowerCase());
  const site = (claims.site === '' ? undefined : named(claims.site)) ?? named(DEFAULT_SITE_ID);
  const siteDomain = site?.domains[0] ?? '';
  return (href) => sanitizeHref(href, { siteDomain, allowedDomains });
}

// ---- Wire shapes of the contract ----

/** A wall-clock Date as the contract's `LocalTimestamp`. */
function localTimestamp(value: Date): string {
  return cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss.lll').replace(' ', 'T');
}

/** A query cell on the wire: dates as `LocalTimestamp`, everything else as the query holds it. */
function wireCell(value: unknown): unknown {
  return value instanceof Date ? localTimestamp(value) : value;
}

/** A legacy user query row with its `tusers` columns in bootstrap casing. */
function userListRow(row: Readonly<Record<string, unknown>>): UserListRow {
  const wire: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const name = TUSERS_SPELLING.get(column.toLowerCase()) ?? column;
    Object.defineProperty(wire, name, { value: wireCell(value), writable: true, enumerable: true, configurable: true });
  }
  return wire as UserListRow;
}

/** The ids of user query rows. */
function userIdsOf(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  return rows.map((row) => String(userListRow(row).UserID));
}

/** `utility.getNextN`'s struct under the contract's lower-cased keys. */
function wireNextN(n: NextN): Schemas['NextN'] {
  return {
    totalrecords: n.TotalRecords,
    recordsperpage: n.RecordsPerPage,
    numberofpages: n.NumberOfPages,
    currentpagenumber: n.CurrentPageNumber,
    firstpage: n.firstPage,
    lastpage: n.lastPage,
    next: n.next,
    previous: n.previous,
    through: n.through,
    startrow: n.startrow,
  };
}

/** The cusers paging of `rc` after `before()`. */
function pagingOf(ctx: CusersContext): UsersPaging {
  return { startRow: ctx.startrow, recordsPerPage: ctx.recordsperpage };
}

/** The nextN of the page cusers shows for `rows` [legacy: admin/core/controllers/cusers.cfc:498-518]. */
function pageNextN(rows: readonly unknown[], ctx: CusersContext): Schemas['NextN'] {
  return wireNextN(pageRows(rows, pagingOf(ctx)).nextn);
}

/** One `getUserGroups` row; a NULL `Type` is left out, as the contract allows only 1. */
function groupListRow(row: UserGroupRow): Schemas['GroupListRow'] {
  return {
    UserID: row.userId,
    Email: row.email,
    GroupName: row.groupName,
    ...(row.type === null ? {} : { Type: 1 as const }),
    LastLogin: row.lastLogin,
    LastUpdate: row.lastUpdate,
    LastUpdateBy: row.lastUpdateBy,
    LastUpdateByID: row.lastUpdateById,
    Counter: row.counter,
    Perm: row.perm,
    isPublic: row.isPublic,
  };
}

/** One `getPrivateGroups`/`getPublicGroups` row; `Site` is `tsettings.Site` when the session's site list names it. */
function groupOption(group: GroupSummary, siteNames: ReadonlyMap<string, string>): GroupOption {
  const site = siteNames.get(group.siteId.toLowerCase());
  return {
    UserID: group.groupId,
    GroupName: group.groupName,
    ...(site === undefined ? {} : { Site: site }),
    SiteID: group.siteId,
    isPublic: group.isPublic,
    Perm: group.perm,
  };
}

/** Site names of the session's site list, by lower-cased site id. */
function siteNamesOf(sites: readonly SessionSite[]): Map<string, string> {
  return new Map(sites.map((site) => [site.siteID.toLowerCase(), site.site]));
}

/** A `tuseraddresses` row in bootstrap casing. */
function addressRecord(row: AddressRow): AddressRecord {
  const columns: Readonly<Record<string, unknown>> = row;
  return Object.fromEntries(ADDRESS_COLUMNS.map((name) => [name, columns[name.toLowerCase()] ?? null])) as AddressRecord;
}

/** The `rsAddress` of an address the user bean does not hold: no stored column, under the bean's ids. */
function newAddressRecord(addressId: string, userId: string): AddressRecord {
  const empty = Object.fromEntries(ADDRESS_COLUMNS.map((name) => [name, null])) as Record<string, null>;
  return { ...empty, addressID: addressId === '' ? cfUuid() : addressId, userID: userId };
}

/** One `tusers` bean value on the wire as its column kind holds it; NULL as `''` stays `''` for text. */
function personValue(value: unknown, kind: 's' | 'i' | 't'): unknown {
  if (kind === 'i') return cfIsNumeric(value) ? cfToNumber(value) : null;
  if (kind === 't') return value instanceof Date ? localTimestamp(value) : null;
  if (typeof value === 'number') return cfNumberString(value);
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** A user bean as the contract's `tusers` row; `Ext` and `Admin` are columns the bean does not hold. */
function personRecord(values: UserValues, columns: { ext: number | null; admin: number | null }): PersonRecord {
  const source: Readonly<Record<string, unknown>> = { ...values, ext: columns.ext, admin: columns.admin };
  const record: Record<string, unknown> = {};
  for (const [name, kind] of TUSERS_COLUMNS) record[name] = personValue(source[name.toLowerCase()], kind);
  return record as PersonRecord;
}

/** Extended attribute values as text; a date as CFML prints a date object. */
function extendedValues(data: Readonly<Record<string, ExtendValue>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(data)) {
    const text = value instanceof Date ? `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}` : value;
    Object.defineProperty(values, name, { value: text, writable: true, enumerable: true, configurable: true });
  }
  return values;
}

/** One class extension subtype of the user type select. */
function subTypeOption(row: ExtendSubtypeRow): Schemas['SubTypeOption'] {
  return { subTypeID: row.subtypeid, type: row.type ?? '', subType: row.subtype ?? '' };
}

// ---- Tenants, user pools and the user bean ----

/** One user pool: the legacy pool site and the tenant holding its rows. */
interface UserPool {
  siteId: string;
  tenantId: string;
}

/** The registry entry of the token's tenant; an unregistered tenant answers the legacy 503. */
async function tokenSite(db: TenantDb, claims: Pick<UserClaims, 'tid'>): Promise<TenantRegistryEntry> {
  const entry = await registryEntryForTenant(db, claims.tid);
  if (entry === null) throw new LegacyServiceUnavailableError(`Tenant ${claims.tid} has no site registry entry`, 'auto', 'tenant-unregistered');
  return entry;
}

/** `getPublicUserPoolID()` or `getPrivateUserPoolID()` of the site; settingsBean reads an empty pool id as the site's own. */
function userPool(entry: TenantRegistryEntry, isPublic: boolean): UserPool {
  const poolId = isPublic ? entry.publicUserPoolId : entry.privateUserPoolId;
  const siteId = poolId === null || poolId === '' ? entry.siteId : poolId;
  return { siteId, tenantId: (isPublic ? entry.publicUserPoolTenant : entry.privateUserPoolTenant) ?? tenantIdForSite(siteId) };
}

/** The tenants the token's site may read users in: its own, then its public and private user pools. */
function userTenants(entry: TenantRegistryEntry, first?: string): string[] {
  return [...new Set([...(first === undefined ? [] : [first]), entry.tenantId, userPool(entry, true).tenantId, userPool(entry, false).tenantId])];
}

/** A scrubbed CFML boolean as a pool flag: a number as given, else `true` 1 and `false` 0. */
function poolFlag(value: string): number {
  return cfIsNumeric(value) ? cfToNumber(value) : cfToBoolean(value) ? 1 : 0;
}

/** A request value by name, matched ignoring case as a CFML scope matches it; undefined when absent. */
function contextValue(ctx: CusersContext, name: string): unknown {
  const wanted = name.toLowerCase();
  const key = Object.keys(ctx.params).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : ctx.params[key];
}

/** A simple request or bean value as CFML text; `''` for a missing or complex one. */
function simpleText(value: unknown): string {
  if (typeof value === 'number') return cfNumberString(value);
  return typeof value === 'string' || typeof value === 'boolean' ? String(value) : '';
}

/** A user as `userManager.read(userid)` builds it, with the rows the edit screens show [legacy: core/mura/user/userDAO.cfc:92-120]. */
interface UserBean {
  values: UserValues;
  exists: boolean;
  /** The tenant holding the person; undefined for a new bean. */
  tenantId?: string;
  ext: number | null;
  admin: number | null;
  addresses: AddressRow[];
  groupIds: string[];
  categoryIds: string[];
  extendedAttributes: Record<string, string>;
  /** `getExtendedData().getAllExtendSetData().data`, as the JSON API's `extendeddata` field reads it. */
  extendData: Readonly<Record<string, ExtendValue>>;
}

/** A new bean: `userBean.init` values with the id `getUserID()` generates; legacy `read` of an unknown id never fails. */
function newUserBean(clock: Clock): UserBean {
  return {
    values: { ...newUserValues(clock), userid: cfUuid() },
    exists: false,
    ext: null,
    admin: null,
    addresses: [],
    groupIds: [],
    categoryIds: [],
    extendedAttributes: {},
    extendData: {},
  };
}

/** The roster observer collaborators of `deps`. */
function observerDeps(deps: AdminUserRouteDeps): PersonObserverDeps {
  return { db: deps.db, repo: deps.repository, clock: deps.clock, sleep: deps.sleep };
}

/** The person `userId` with its interests, addresses and extended data, from the first of `tenants` that holds it, fenced in each. */
async function findPersonRows(deps: AdminUserRouteDeps, observer: PersonObserver, tenants: readonly string[], userId: string) {
  const { repository: repo } = deps;
  const read = async (tx: TenantTx) => {
    const person: PersonRow | null = await repo.findPerson(tx, userId);
    if (person === null) return null;
    const categoryIds = (await repo.listInterests(tx, person.userid)).map((row) => row.categoryid);
    const addresses = await listAddresses(repo, tx, person.userid);
    // getAllValues builds the bean's extended data for its site, Type 2 and subtype (beanExtendable.cfc:139-151).
    const extend = await extendSetData(repo, tx, person.userid, { siteId: person.siteid ?? '', type: '2', subtype: person.subtype ?? '' });
    return { person, categoryIds, addresses, extend };
  };
  for (const tenantId of tenants) {
    const found = await observer.read(tenantId, read, (rows) => (rows === null ? [] : [rows.person.userid]), [userId]);
    if (found !== null) return { tenantId, ...found };
  }
  return null;
}

/**
 * `userManager.read(userid)` within the token's user tenants: people's rows with identity's account and memberships, observed together;
 * `memberships` are the user's group ids identity already supplied, which then are not read from identity.
 */
async function readUserBean(deps: AdminUserRouteDeps, entry: TenantRegistryEntry, userId: string, memberships?: readonly string[]): Promise<UserBean> {
  if (userId === '') return newUserBean(deps.clock);
  const read = await observePersons(
    observerDeps(deps),
    (observer) => findPersonRows(deps, observer, userTenants(entry), userId),
    async (stored) => {
      // A person identity does not list (a missing or pending account) has no complete `tusers` row to read.
      const account = stored === null ? undefined : await deps.identity.readAccount(stored.person.userid);
      if (stored === null || account === undefined) return null;
      const groupIds = memberships === undefined ? await deps.identity.membershipGroupIds(stored.person.userid) : [...memberships];
      return { stored, account, groupIds };
    },
  );
  if (read === null) return newUserBean(deps.clock);
  const { stored, account, groupIds } = read;
  const { person } = stored;
  const photoFileId = person.photofileid ?? '';
  const photoFileExt =
    deps.photoFileExts === undefined || photoFileId === '' ? '' : ((await deps.photoFileExts([photoFileId])).get(photoFileId) ?? '');
  const source = { person, account, groupIds, categoryIds: stored.categoryIds, extend: stored.extend, photoFileExt };
  return {
    values: userBeanValues(source, deps.clock),
    exists: true,
    tenantId: stored.tenantId,
    ext: person.ext,
    admin: account.admin,
    addresses: stored.addresses,
    groupIds,
    categoryIds: stored.categoryIds,
    extendedAttributes: extendedValues(stored.extend.data),
    extendData: stored.extend.data,
  };
}

/** `getAddressByID(addressID)` with the address's extended data, from the first of `tenants` that holds it, while its owner is open. */
async function findAddressRows(deps: AdminUserRouteDeps, tenants: readonly string[], addressId: string) {
  const read = async (tx: TenantTx) => {
    const row = await deps.repository.findAddress(tx, addressId);
    return row === null ? null : { row, extend: await extendSetData(deps.repository, tx, row.addressid) };
  };
  const owner = (found: Awaited<ReturnType<typeof read>>): string[] => {
    const userId = found?.row.userid ?? null;
    return userId === null ? [] : [userId];
  };
  const people = async (observer: PersonObserver) => {
    for (const tenantId of tenants) {
      const found = await observer.read(tenantId, read, owner);
      if (found !== null) return found;
    }
    return null;
  };
  return observePersons(observerDeps(deps), people, (found) => Promise.resolve(found));
}

// ---- The current user of the JSON API's findCurrentUser [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2268-2382] ----

/** `userManager.read` of the token's own user, once no open roster operation closes it in the token site's user tenants. */
async function readTokenUser(deps: AdminUserRouteDeps, claims: UserClaims, memberships: readonly string[]): Promise<UserBean> {
  const entry = await tokenSite(deps.db, claims);
  const awaitOpen = deps.awaitPersonOpen ?? awaitPersonOpen;
  for (const tenantId of userTenants(entry)) await awaitOpen(deps.db, tenantId, claims.sub, { clock: deps.clock });
  return readUserBean(deps, entry, claims.sub, memberships);
}

/** A bean no row loaded, seeded with the call's site as `$.getBean('user')` seeds it, with that site's extended defaults (cfobject.cfc:138-149; userBean.cfc:246-258). */
async function seededNewBean(deps: AdminUserRouteDeps, bean: UserBean, siteId: string): Promise<UserBean> {
  const tenantId = await tenantForRegisteredSite(deps.db, siteId);
  if (tenantId === null) throw new LegacyServiceUnavailableError(`Site ${siteId} has no site registry entry`, 'auto', 'tenant-unregistered');
  const values = { ...bean.values, siteid: siteId };
  const scope = { siteId, type: '2', subtype: String(values.subtype) };
  const extend = await withTenant(deps.db, tenantId, (tx) => extendSetData(deps.repository, tx, values.userid, scope));
  return { ...bean, values: withExtendSetData(values, extend), extendData: extend.data };
}

/** `getLinks(user, editablecheck=true)`; the edit link only for a logged-in system user whom AllowAction admits (jsonApiUtility.cfc:1809-1818,3374-3440; userBean.cfc:818-824). */
function currentUserLinks(claims: UserClaims | undefined, values: UserValues, query: CurrentUserQuery): Record<string, string> {
  const base = query.endpoint;
  const userId = values.userid;
  const links: Record<string, string> = { entities: base };
  const roles = claims?.roles ?? [];
  const superUser = hasAnyRole(roles, [Roles.s2]) || claims?.s2 === true;
  const systemUser = superUser || hasAnyRole(roles, [Roles.systemUser]);
  const sub = claims?.sub ?? '';
  // getModulePerm of the Users module, or the caller's own record.
  const allowAction = superUser || hasAnyRole(roles, CUSERS_ROUTE_REQUIRES) || (sub !== '' && cfEq(userId, sub));
  if (sub !== '' && systemUser && allowAction) {
    links.edit = `${query.adminpath}/?muraAction=cusers.edituser&siteid=${esapiUrlEncode(values.siteid)}&userid=${esapiUrlEncode(userId)}`;
  }
  links.all = `${base}/user`;
  links.properties = `${base}/user/properties`;
  links.self = `${base}/user/${userId}`;
  links.permissions = `${base}/user/${userId}/permissions`;
  return links;
}

/** `findOne(entityName='user', id=currentUser('userid'), method='findCurrentUser')`, which runs neither allowAccess nor allowRead. */
async function readCurrentUser(deps: AdminUserRouteDeps, claims: UserClaims | undefined, query: CurrentUserQuery): Promise<Record<string, unknown>> {
  const loaded = claims === undefined || claims.sub === '' ? newUserBean(deps.clock) : await readTokenUser(deps, claims, cfListToArray(query.groupids ?? ''));
  const bean = loaded.exists ? loaded : await seededNewBean(deps, loaded, query.siteid);
  return filteredEntityValues(bean.values, {
    entityName: 'user',
    pk: 'userid',
    fields: query.fields,
    expandLinks: query.expand,
    expandDepth: query.expanddepth,
    links: currentUserLinks(claims, bean.values, query),
    isEntityNameMatch: true,
    expanded: 0,
    extendSetData: bean.extendData,
    getters: { addresses: addressesQuery(bean.addresses) },
  });
}

// ---- Advanced-search criteria and the session's retained values ----

/** The session's advanced-search criteria as identity holds them, with admin request start-up's `param` defaults [legacy: admin/Application.cfc:459-466]. */
function storedCriteria(state: AdminSessionState): AdvancedSearchCriteria {
  const defaults = newAdvancedSearchCriteria();
  return {
    paramArray: (state.paramArray ?? []).map((row) => ({
      field: row.Field,
      relationship: row.Relationship,
      criteria: row.Criteria,
      condition: row.Condition,
    })),
    paramCount: state.paramCount ?? defaults.paramCount,
    paramCircuit: state.paramCircuit ?? defaults.paramCircuit,
    paramCategories: state.paramCategories ?? defaults.paramCategories,
    paramGroups: state.paramGroups ?? defaults.paramGroups,
    inActive: state.inActive ?? defaults.inActive,
    membersOnly: state.membersOnly ?? defaults.membersOnly,
    visitorStatus: state.visitorStatus ?? defaults.visitorStatus,
  };
}

/** Criteria under the legacy `session` names identity stores them by. */
function sessionCriteria(criteria: AdvancedSearchCriteria): AdminSessionState {
  return {
    paramArray: criteria.paramArray.map((row) => ({
      Field: row.field,
      Relationship: row.relationship,
      Criteria: row.criteria,
      Condition: row.condition,
    })),
    paramCount: criteria.paramCount,
    paramCircuit: criteria.paramCircuit,
    paramCategories: criteria.paramCategories,
    paramGroups: criteria.paramGroups,
    inActive: criteria.inActive,
    membersOnly: String(criteria.membersOnly),
    visitorStatus: criteria.visitorStatus,
  };
}

/** The criteria the search form shows. */
function wireCriteria(criteria: AdvancedSearchCriteria): Schemas['StoredSearchCriteria'] {
  const { paramArray, inActive, paramCategories, paramGroups, membersOnly, visitorStatus } = sessionCriteria(criteria);
  return {
    paramArray: paramArray ?? [],
    inActive: inActive ?? '',
    paramCategories: paramCategories ?? '',
    paramGroups: paramGroups ?? '',
    membersOnly: membersOnly ?? 'false',
    visitorStatus: visitorStatus ?? 'All',
  };
}

/** `StructDelete(session.mura, 'editBean')`: identity replaces the stored `mura` values whole, without the retained bean. */
async function clearRetainedEditBean(identity: IdentityClient): Promise<void> {
  const { mura } = await identity.adminSessionState();
  if (mura === undefined) return;
  const kept = Object.entries(mura).filter(([key]) => key.toLowerCase() !== EDIT_BEAN_KEY);
  if (kept.length === Object.keys(mura).length) return;
  await identity.saveAdminSessionState({ mura: Object.fromEntries(kept) });
}

// ---- Handlers ----

/** A request the cUsers gate admitted: the caller's verified claims and the request context after `before()`. */
interface Admitted {
  claims: UserClaims;
  ctx: CusersContext;
  /** The merged request values as admin request start-up reads them, before `before()` defaults any. */
  params: Readonly<Record<string, unknown>>;
}

/** A route handler behind cUsers `before()`: a refused gate answers the denial, every other request runs `handler`. */
function cusersHandler<R>(handler: (admitted: Admitted) => Promise<R>, options?: CusersParamsOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<R | undefined> => {
    const access = requireCusersAccess(request);
    if (access instanceof AdminDenial) {
      await sendAdminDenial(reply, access);
      return undefined;
    }
    const params = legacyParamsOf(request);
    return handler({ claims: access, ctx: normaliseCusersParams(params, access, options), params });
  };
}

/** One API version of the cUsers user list reads: `L` answers the list and the search, `A` the advanced search. */
interface UserListReads<L, A> {
  /** `cUsers.listUsers`; `siteid=all` reads every site for S2 [legacy: admin/core/controllers/cusers.cfc:184-217]. */
  listUsers(admitted: Admitted): Promise<L>;
  /** `cUsers.search` [legacy: admin/core/controllers/cusers.cfc:402-427]. */
  searchUsers(admitted: Admitted): Promise<L>;
  /** `cUsers.advancedSearch` over `criteria` [legacy: admin/core/controllers/cusers.cfc:429-451]. */
  advancedSearch(admitted: Admitted, criteria: AdvancedSearchCriteria): Promise<A>;
}

/** Registers the cUsers reads people serves: lists, searches, the edit reads and `route()`. */
export async function registerAdminUserRoutes(app: FastifyInstance, deps: AdminUserRouteDeps): Promise<void> {
  const { identity } = deps;
  const search: SearchDeps = { db: deps.db, repo: deps.repository, identity, photoFileExts: deps.photoFileExts, clock: deps.clock, sleep: deps.sleep };

  /** A user list page on the wire; `listUnassignedUsers` marks its people without a stored group membership, or all with `allUnassigned`. */
  async function userListPage(page: UsersPage<Record<string, unknown>>, allUnassigned: boolean): Promise<Schemas['UserListPageV2']> {
    const ids = userIdsOf(page.rows);
    // The view marks only the rows it shows, so the unassigned ids of the page stand for legacy's whole unassigned query.
    const memberships = allUnassigned || ids.length === 0 ? new Map<string, string[]>() : await identity.lookupMemberships(ids);
    return {
      items: page.rows.map(userListRow),
      nextn: wireNextN(page.nextn),
      listUnassignedUsers: allUnassigned ? ids : ids.filter((id) => (memberships.get(id) ?? []).length === 0),
    };
  }

  /** The search form of an advanced-search answer: no unassigned mark, the criteria and the group options [legacy: admin/core/controllers/cusers.cfc:429-451]. */
  async function advancedSearchForm(ctx: CusersContext, criteria: AdvancedSearchCriteria): Promise<Pick<Schemas['AdvancedSearchPage'], 'listUnassignedUsers' | 'criteria' | 'groups'>> {
    // `rc.ispublic == 1` picks the member groups; the view reads no group, so their site names are not looked up.
    const groups = await identity.siteGroups(ctx.siteid, poolFlag(ctx.ispublic) === 1 ? 1 : 0);
    // The action sets no `rc.listUnassignedUsers`, so the list marks no row.
    return { listUnassignedUsers: [], criteria: wireCriteria(criteria), groups: groups.map((group) => groupOption(group, new Map())) };
  }

  /** Registers `reads` under `prefix` behind the cUsers gate, each route with its roles and service transport. */
  function registerUserListReads<L, A>(prefix: '/v1' | '/v2', reads: UserListReads<L, A>): void {
    app.get(`${prefix}/users`, { config: { opt2: LIST_USERS_AUTH } }, cusersHandler((admitted) => reads.listUsers(admitted), { allowAllSites: true }));
    app.get(`${prefix}/users/search`, { config: { opt2: CUSERS_AUTH } }, cusersHandler((admitted) => reads.searchUsers(admitted)));
    // `cUsers.advancedSearch` of the session's stored criteria.
    app.get(
      `${prefix}/users/advanced-search`,
      { config: { opt2: CUSERS_AUTH } },
      cusersHandler(async (admitted) => reads.advancedSearch(admitted, storedCriteria(await identity.adminSessionState()))),
    );
    // Admin request start-up's capture of a non-empty `param`, then `cUsers.advancedSearch` [legacy: admin/Application.cfc:459-498].
    app.post(
      `${prefix}/users/advanced-search`,
      { config: { opt2: CUSERS_AUTH } },
      cusersHandler(async (admitted) => {
        const previous = storedCriteria(await identity.adminSessionState());
        const criteria = buildAdvancedSearchCriteria(new Map(Object.entries(admitted.params)), previous);
        if (criteria !== previous) await identity.saveAdminSessionState(sessionCriteria(criteria));
        return reads.advancedSearch(admitted, criteria);
      }),
    );
  }

  // `cUsers.list` [legacy: admin/core/controllers/cusers.cfc:177-182, core/mura/user/userGateway.cfc:93-122]
  app.get(
    '/v1/users/groups',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ ctx }): Promise<Schemas['UserGroupsPage']> => {
      // userManager's numeric `isPublic` rejects a boolean word before any read [legacy: core/mura/user/userManager.cfc:119-123].
      const groups = await identity.userGroups(ctx.siteid, numericArgument(ctx.ispublic, 'isPublic', 'getUserGroups'));
      return { items: groups.map(groupListRow), nextn: pageNextN(groups, ctx) };
    }),
  );

  // `/v1` answers every match, with every unassigned user of the pool.
  registerUserListReads<Schemas['UserListPage'], Schemas['AdvancedSearchPage']>('/v1', {
    async listUsers({ claims, ctx }) {
      const viewer = viewerScopeFor(claims);
      const users = (args: Omit<UsersQueryArgs, 'siteid'>): Promise<LegacyQuery> =>
        cfEq(ctx.siteid, 'all') ? getAllSitesUsers(search, viewer, args) : getUsers(search, viewer, { ...args, siteid: ctx.siteid });
      const rs = await users({ ispublic: ctx.ispublic, isunassigned: ctx.unassigned });
      // With `unassigned` set, the unassigned query is the list query itself.
      const unassigned = cfToBoolean(ctx.unassigned) ? rs : await users({ ispublic: ctx.ispublic, isunassigned: 1 });
      return { items: rs.rows.map(userListRow), nextn: pageNextN(rs.rows, ctx), listUnassignedUsers: userIdsOf(unassigned.rows) };
    },
    async searchUsers({ claims, ctx }) {
      const viewer = viewerScopeFor(claims);
      const rs = await getSearch(search, viewer, { search: ctx.search, siteid: ctx.siteid, isPublic: ctx.ispublic });
      const unassigned = await getUnassignedUsers(search, viewer, { siteid: ctx.siteid, ispublic: ctx.ispublic });
      return { items: rs.rows.map(userListRow), nextn: pageNextN(rs.rows, ctx), listUnassignedUsers: userIdsOf(unassigned.rows) };
    },
    async advancedSearch({ claims, ctx }, criteria) {
      const form = await advancedSearchForm(ctx, criteria);
      const rs = await getAdvancedSearch(search, viewerScopeFor(claims), criteria, { siteid: ctx.siteid, isPublic: ctx.ispublic });
      return { items: rs.rows.map(userListRow), nextn: pageNextN(rs.rows, ctx), ...form };
    },
  });

  // `/v2` answers only the people of the page `nextn` selects, and marks only theirs.
  registerUserListReads<Schemas['UserListPageV2'], Schemas['AdvancedSearchPageV2']>('/v2', {
    async listUsers({ claims, ctx }) {
      const viewer = viewerScopeFor(claims);
      const args = { ispublic: ctx.ispublic, isunassigned: ctx.unassigned };
      const page = cfEq(ctx.siteid, 'all')
        ? await getAllSitesUsersPage(search, viewer, args, pagingOf(ctx))
        : await getUsersPage(search, viewer, { ...args, siteid: ctx.siteid }, pagingOf(ctx));
      // With `unassigned` set, the unassigned query is the list query itself.
      return userListPage(page, cfToBoolean(ctx.unassigned));
    },
    async searchUsers({ claims, ctx }) {
      const query = { search: ctx.search, siteid: ctx.siteid, isPublic: ctx.ispublic };
      const page = await getSearchPage(search, viewerScopeFor(claims), query, pagingOf(ctx));
      // An empty term reads no pool, but the unassigned query still reads the site's: an unregistered tenant answers 503.
      if (query.search === '') await tokenSite(deps.db, claims);
      // Every search row is a user of the pool `getUnassignedUsers` reads, so it is unassigned exactly when it has no membership.
      return userListPage(page, false);
    },
    async advancedSearch({ claims, ctx }, criteria) {
      const form = await advancedSearchForm(ctx, criteria);
      const options = { siteid: ctx.siteid, isPublic: ctx.ispublic };
      const page = await getAdvancedSearchPage(search, viewerScopeFor(claims), criteria, options, pagingOf(ctx));
      return { items: page.rows.map(userListRow), nextn: wireNextN(page.nextn), ...form };
    },
  });

  // `cUsers.editUser` and the view's set-up [legacy: admin/core/controllers/cusers.cfc:243-261, admin/core/views/cusers/edituser.cfm:79-113]
  app.get(
    '/v1/users/edit',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ claims, ctx }): Promise<Schemas['UserEditData']> => {
      const entry = await tokenSite(deps.db, claims);
      const bean = await readUserBean(deps, entry, ctx.userid);
      const setIsPublic = contextValue(ctx, 'setispublic');
      const tempIsPublic = setIsPublic !== undefined && ctx.isAdmin ? setIsPublic : bean.values.ispublic;
      const [sites, privateGroups, publicGroups] = await Promise.all([
        identity.sessionSites(),
        identity.siteGroups(ctx.siteid, 0),
        identity.siteGroups(ctx.siteid, 1),
      ]);
      const siteNames = siteNamesOf(sites);
      // The view's `userPoolID`: the private pool for an admin on the System Users side, else the public pool.
      const pool = userPool(entry, !(poolFlag(ctx.ispublic) === 0 && ctx.isAdmin));
      const subTypes = await withTenant(deps.db, pool.tenantId, (tx) => deps.repository.listExtendSubtypes(tx, { siteId: pool.siteId, types: ['2'] }));
      const blockedUntil = bean.exists && bean.values.username !== ''
        ? await identity.loginBlock(bean.values.userid, contextValue(ctx, 'removeblock') !== undefined)
        : null;
      return {
        user: personRecord(bean.values, bean),
        isNew: !bean.exists,
        tempIsPublic: poolFlag(simpleText(tempIsPublic)),
        lockedSuper: bean.exists && cfToBoolean(bean.values.s2) && !isSuperViewer(claims),
        blockedUntil,
        addresses: bean.addresses.map(addressRecord),
        privateGroups: privateGroups.map((group) => groupOption(group, siteNames)),
        publicGroups: publicGroups.map((group) => groupOption(group, siteNames)),
        groupIds: bean.groupIds,
        categoryIds: bean.categoryIds,
        subTypes: subTypes.filter((row) => row.isactive === 1).map(subTypeOption),
        extendedAttributes: bean.extendedAttributes,
        // Site names are not people's: identity's site selector list stands for `getList()`, ordered by site id, not `orderno`.
        sites,
        // editUser reads the bean fresh; a failed save's values reach the form through the FW/1 flash web restores.
        errors: {},
        retained: false,
      };
    }),
  );

  // `cUsers.editAddress` and the view's `getAddressByID` [legacy: admin/core/controllers/cusers.cfc:284-288, admin/core/views/cusers/editaddress.cfm:77-79]
  app.get(
    '/v1/users/address',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ claims, ctx }): Promise<Schemas['AddressEditData']> => {
      const entry = await tokenSite(deps.db, claims);
      const bean = await readUserBean(deps, entry, ctx.userid);
      const addressId = simpleText(contextValue(ctx, 'addressid'));
      const found = addressId === '' ? null : await findAddressRows(deps, userTenants(entry, bean.tenantId), addressId);
      return {
        user: personRecord(bean.values, bean),
        address: found === null ? newAddressRecord(addressId, bean.values.userid) : addressRecord(found.row),
        isNew: found === null,
        extendedAttributes: found === null ? {} : extendedValues(found.extend.data),
      };
    }),
  );

  // `cUsers.route` [legacy: admin/core/controllers/cusers.cfc:377-398]
  app.get(
    '/v1/users/route',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ claims, ctx }): Promise<Schemas['RouteResult']> => {
      await clearRetainedEditBean(identity);
      const sanitize = ctx.routeid === '' && ctx.returnurl !== '' ? await hrefSanitizer(deps.db, claims) : (href: string) => href;
      return { redirect: routeRedirect(ctx, sanitize) };
    }),
  );

  // The user read of identity's JSON API `findCurrentUser`, in the JSON API's serialization [legacy: core/mura/client/api/json/v1/jsonApiUtility.cfc:2268-2290]
  app.get<{ Querystring: CurrentUserQuery }>(
    '/internal/v1/users/current',
    { schema: { querystring: CURRENT_USER_QUERY }, config: { opt2: CURRENT_USER_AUTH } },
    async (request, reply) => {
      const data = await readCurrentUser(deps, request.opt2Auth.user, request.query);
      return reply.type('application/json').send(createApiSerializer([...USER_ENTITY_HINTS, ...ADDRESS_ENTITY_HINTS]).serialize({ data }));
    },
  );
}
