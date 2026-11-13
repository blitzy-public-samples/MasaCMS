// The people reads of the cUsers admin circuit: group and user lists, search, advanced search, the Edit User and Edit
// Address reads, and `route()` with its return-URL sanitising [legacy: admin/core/controllers/cusers.cfc:172-451,498-518].
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
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
  javaTrim,
  type LegacyQuery,
} from '@opt2/platform/legacy-compat';
import { legacyParamsOf, type Clock, type FastifyInstance, type FastifyReply, type FastifyRequest } from '@opt2/platform/service-kit';
import {
  registeredTenants,
  registryEntryForTenant,
  tenantIdForSite,
  withMetadata,
  withTenant,
  type TenantDb,
  type TenantRegistryEntry,
} from '@opt2/platform/tenancy';
import { listAddresses } from '../domain/addresses.js';
import { extendSetData, type ExtendValue } from '../domain/extended-data.js';
import { newUserValues, type UserValues } from '../domain/person.js';
import {
  buildAdvancedSearchCriteria,
  getAdvancedSearch,
  getSearch,
  getUnassignedUsers,
  getUsers,
  newAdvancedSearchCriteria,
  pageRows,
  searchAllSites,
  type AdvancedSearchCriteria,
  type NextN,
  type SearchDeps,
  type ViewerScope,
} from '../domain/search.js';
import { userBeanValues } from '../domain/user-entity.js';
import type { components } from '../generated/openapi.js';
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

/** What the cUsers reads use; `photoFileExts` is strategies-content's photo lookup, without which every `photoFileExt` is ''. */
export type AdminUserRouteDeps = {
  db: TenantDb;
  repository: PeopleRepository;
  identity: IdentityClient;
  clock: Clock;
  photoFileExts?: SearchDeps['photoFileExts'];
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

/** Every site registry entry, origin domains included, in site id order. */
function registryEntries(db: TenantDb): Promise<TenantRegistryEntry[]> {
  return withMetadata(db, async (tx) => {
    const entries: TenantRegistryEntry[] = [];
    for (const { tenantId } of await registeredTenants(tx)) {
      const entry = await registryEntryForTenant(tx, tenantId);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  });
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

/** The ids of a user query's rows. */
function userIdsOf(query: LegacyQuery): string[] {
  return query.rows.map((row) => String(userListRow(row).UserID));
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

/** The nextN of the page cusers shows for `rows` [legacy: admin/core/controllers/cusers.cfc:498-518]. */
function pageNextN(rows: readonly unknown[], ctx: CusersContext): Schemas['NextN'] {
  return wireNextN(pageRows(rows, { startRow: ctx.startrow, recordsPerPage: ctx.recordsperpage }).nextn);
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
  };
}

/** The person `userId` with its interests, addresses and extended data, from the first of `tenants` that holds it. */
async function findPersonRows(deps: AdminUserRouteDeps, tenants: readonly string[], userId: string) {
  const { repository: repo } = deps;
  for (const tenantId of tenants) {
    const found = await withTenant(deps.db, tenantId, async (tx) => {
      const person: PersonRow | null = await repo.findPerson(tx, userId);
      if (person === null) return null;
      const categoryIds = (await repo.listInterests(tx, person.userid)).map((row) => row.categoryid);
      const addresses = await listAddresses(repo, tx, person.userid);
      // getAllValues builds the bean's extended data for its site, Type 2 and subtype (beanExtendable.cfc:139-151).
      const extend = await extendSetData(repo, tx, person.userid, { siteId: person.siteid ?? '', type: '2', subtype: person.subtype ?? '' });
      return { person, categoryIds, addresses, extend };
    });
    if (found !== null) return { tenantId, ...found };
  }
  return null;
}

/** `userManager.read(userid)` within the token's user tenants: people's rows with identity's account and memberships. */
async function readUserBean(deps: AdminUserRouteDeps, entry: TenantRegistryEntry, userId: string): Promise<UserBean> {
  const stored = userId === '' ? null : await findPersonRows(deps, userTenants(entry), userId);
  // A person identity does not list (a missing or pending account) has no complete `tusers` row to read.
  const account = stored === null ? undefined : await deps.identity.readAccount(stored.person.userid);
  if (stored === null || account === undefined) return newUserBean(deps.clock);
  const { person } = stored;
  const groupIds = await deps.identity.membershipGroupIds(person.userid);
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
  };
}

/** `getAddressByID(addressID)` with the address's extended data, from the first of `tenants` that holds it. */
async function findAddressRows(deps: AdminUserRouteDeps, tenants: readonly string[], addressId: string) {
  for (const tenantId of tenants) {
    const found = await withTenant(deps.db, tenantId, async (tx) => {
      const row = await deps.repository.findAddress(tx, addressId);
      return row === null ? null : { row, extend: await extendSetData(deps.repository, tx, row.addressid) };
    });
    if (found !== null) return found;
  }
  return null;
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

/** Registers the cUsers reads people serves: lists, searches, the edit reads and `route()`. */
export async function registerAdminUserRoutes(app: FastifyInstance, deps: AdminUserRouteDeps): Promise<void> {
  const { identity } = deps;
  const search: SearchDeps = { db: deps.db, repo: deps.repository, identity, photoFileExts: deps.photoFileExts };

  /** cusers `advancedSearch()` over `criteria`: the result rows and the group options of the form [legacy: admin/core/controllers/cusers.cfc:429-451]. */
  async function advancedSearchPage({ claims, ctx }: Admitted, criteria: AdvancedSearchCriteria): Promise<Schemas['AdvancedSearchPage']> {
    // `rc.ispublic == 1` picks the member groups; the view reads no group, so their site names are not looked up.
    const groups = await identity.siteGroups(ctx.siteid, poolFlag(ctx.ispublic) === 1 ? 1 : 0);
    const rs = await getAdvancedSearch(search, viewerScopeFor(claims), criteria, { siteid: ctx.siteid, isPublic: ctx.ispublic });
    // The action sets no `rc.listUnassignedUsers`, so the list marks no row.
    return {
      items: rs.rows.map(userListRow),
      nextn: pageNextN(rs.rows, ctx),
      listUnassignedUsers: [],
      criteria: wireCriteria(criteria),
      groups: groups.map((group) => groupOption(group, new Map())),
    };
  }

  // `cUsers.list` [legacy: admin/core/controllers/cusers.cfc:177-182, core/mura/user/userGateway.cfc:93-122]
  app.get(
    '/v1/users/groups',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ ctx }): Promise<Schemas['UserGroupsPage']> => {
      const groups = await identity.userGroups(ctx.siteid, poolFlag(ctx.ispublic));
      return { items: groups.map(groupListRow), nextn: pageNextN(groups, ctx) };
    }),
  );

  // `cUsers.listUsers`; `siteid=all` reads every site for S2 [legacy: admin/core/controllers/cusers.cfc:184-217]
  app.get(
    '/v1/users',
    { config: { opt2: LIST_USERS_AUTH } },
    cusersHandler(
      async ({ claims, ctx }): Promise<Schemas['UserListPage']> => {
        const viewer = viewerScopeFor(claims);
        const allSites = cfEq(ctx.siteid, 'all');
        const users = (args: { ispublic: string; isunassigned: unknown }): Promise<LegacyQuery> =>
          allSites
            ? searchAllSites(search, viewer, (scope: ViewerScope, siteid: string) => getUsers(search, scope, { ...args, siteid }))
            : getUsers(search, viewer, { ...args, siteid: ctx.siteid });
        const rs = await users({ ispublic: ctx.ispublic, isunassigned: ctx.unassigned });
        // With `unassigned` set, the unassigned query is the list query itself.
        const unassigned = cfToBoolean(ctx.unassigned) ? rs : await users({ ispublic: ctx.ispublic, isunassigned: 1 });
        return { items: rs.rows.map(userListRow), nextn: pageNextN(rs.rows, ctx), listUnassignedUsers: userIdsOf(unassigned) };
      },
      { allowAllSites: true },
    ),
  );

  // `cUsers.search` [legacy: admin/core/controllers/cusers.cfc:402-427]
  app.get(
    '/v1/users/search',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async ({ claims, ctx }): Promise<Schemas['UserListPage']> => {
      const viewer = viewerScopeFor(claims);
      const rs = await getSearch(search, viewer, { search: ctx.search, siteid: ctx.siteid, isPublic: ctx.ispublic });
      const unassigned = await getUnassignedUsers(search, viewer, { siteid: ctx.siteid, ispublic: ctx.ispublic });
      return { items: rs.rows.map(userListRow), nextn: pageNextN(rs.rows, ctx), listUnassignedUsers: userIdsOf(unassigned) };
    }),
  );

  // `cUsers.advancedSearch` of the session's stored criteria.
  app.get(
    '/v1/users/advanced-search',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async (admitted) => advancedSearchPage(admitted, storedCriteria(await identity.adminSessionState()))),
  );

  // Admin request start-up's capture of a non-empty `param`, then `cUsers.advancedSearch` [legacy: admin/Application.cfc:459-498].
  app.post(
    '/v1/users/advanced-search',
    { config: { opt2: CUSERS_AUTH } },
    cusersHandler(async (admitted) => {
      const previous = storedCriteria(await identity.adminSessionState());
      const criteria = buildAdvancedSearchCriteria(new Map(Object.entries(admitted.params)), previous);
      if (criteria !== previous) await identity.saveAdminSessionState(sessionCriteria(criteria));
      return advancedSearchPage(admitted, criteria);
    }),
  );

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
      return {
        user: personRecord(bean.values, bean),
        isNew: !bean.exists,
        tempIsPublic: poolFlag(simpleText(tempIsPublic)),
        lockedSuper: bean.exists && cfToBoolean(bean.values.s2) && !isSuperViewer(claims),
        // Login strikes are identity's, and its contract serves no read of another user's block.
        blockedUntil: null,
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
}
