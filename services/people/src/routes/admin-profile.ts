// The Edit Profile routes of `cEditProfile.edit` and `cEditProfile.update` without a photo or extended attributes.
import type { UserClaims } from '@opt2/platform/auth';
import {
  ADMIN_HOME_ACTION,
  LegacyServiceUnavailableError,
  PHOTO_CONDITION,
  cfDateTimeFormat,
  cfIsNumeric,
  cfToNumber,
  routeKeyForEntryPoint,
  type VariantCondition,
  type VariantDeclaration,
} from '@opt2/platform/legacy-compat';
import {
  csrfPreHandler,
  legacyParamsOf,
  multipartFilesOf,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { tenantForRegisteredSite, type TenantTx } from '@opt2/platform/tenancy';
import { listAddresses } from '../domain/addresses.js';
import { EXTEND_CONFIG_DEFAULTS, extendSetData, type ExtendValue } from '../domain/extended-data.js';
import { normaliseParams, type UserValues } from '../domain/person.js';
import { PhotoBranchError, observePersons, runRosterOperation, type RosterDeps } from '../domain/roster-protocol.js';
import { userBeanValues } from '../domain/user-entity.js';
import type { LegacyErrors } from '../domain/validation.js';
import type { components } from '../generated/openapi.js';
import type { AccountView } from '../legacy/identity-client.js';
import { AdminDenial, PROFILE_ROUTE_REQUIRES, normaliseProfileParams, requireLoggedIn, sendAdminDenial } from './access.js';

type Schemas = components['schemas'];
type ProfileData = Schemas['ProfileData'];
type UpdateResult = Schemas['UpdateResult'];
type PersonRecord = Schemas['PersonRecord'];
type AddressRecord = Schemas['AddressRecord'];
type SubTypeOption = Schemas['SubTypeOption'];

type PeopleRepo = RosterDeps['repo'];
type AddressRow = Awaited<ReturnType<typeof listAddresses>>[number];
type SubtypeRow = Awaited<ReturnType<PeopleRepo['listExtendSubtypes']>>[number];

/** Dependencies of {@link registerAdminProfileRoutes}: the roster write protocol's collaborators, which the reads share. */
export interface AdminProfileRouteDeps {
  roster: RosterDeps;
}

/** `muraAction` of the profile save, whose withheld variants the gateway keys. */
const PROFILE_UPDATE_ACTION = 'cEditProfile.update';

/** Route key of the profile save. */
const PROFILE_UPDATE_ROUTE = 'admin:ceditprofile.update';

/** The withheld branches of the profile save, declared as the gateway's variants declare them; they keep running on legacy. */
const WITHHELD_VARIANTS: readonly VariantDeclaration[] = Object.freeze([
  Object.freeze({ route: PROFILE_UPDATE_ROUTE, variant: 'photo', when: Object.freeze([PHOTO_CONDITION]) }),
  Object.freeze({
    route: PROFILE_UPDATE_ROUTE,
    variant: 'extdata',
    when: Object.freeze([Object.freeze<VariantCondition>({ param: 'extendSetID', nonEmpty: true })]),
  }),
]);

/** Request names that select the admin action; the profile save keeps its own whatever the body posts. */
const ACTION_PARAMS: ReadonlySet<string> = new Set(['muraaction', 'fuseaction']);

/** `fw.redirect(action="home.redirect", path="./")` of a successful save [legacy: admin/core/controllers/ceditprofile.cfc:136-138]. */
const HOME_REDIRECT: Schemas['AdminRedirect'] = Object.freeze({ action: ADMIN_HOME_ACTION, params: Object.freeze({}) });

/** How a bean value is written into its record column. */
type ColumnKind = 'text' | 'integer' | 'timestamp';

/** The `userDAO.read` columns the bean holds, in bootstrap order, by record name and bean key; UserID, Type and SiteID are set apart. */
const PERSON_RECORD_COLUMNS: ReadonlyArray<readonly [column: string, key: string, kind: ColumnKind]> = Object.freeze([
  ['GroupName', 'groupname', 'text'],
  ['Fname', 'fname', 'text'],
  ['Lname', 'lname', 'text'],
  ['UserName', 'username', 'text'],
  ['PasswordCreated', 'passwordcreated', 'timestamp'],
  ['Email', 'email', 'text'],
  ['Company', 'company', 'text'],
  ['JobTitle', 'jobtitle', 'text'],
  ['mobilePhone', 'mobilephone', 'text'],
  ['Website', 'website', 'text'],
  ['subType', 'subtype', 'text'],
  ['ContactForm', 'contactform', 'text'],
  ['S2', 's2', 'integer'],
  ['LastLogin', 'lastlogin', 'timestamp'],
  ['LastUpdate', 'lastupdate', 'timestamp'],
  ['LastUpdateBy', 'lastupdateby', 'text'],
  ['LastUpdateByID', 'lastupdatebyid', 'text'],
  ['Perm', 'perm', 'integer'],
  ['InActive', 'inactive', 'integer'],
  ['isPublic', 'ispublic', 'integer'],
  ['Subscribe', 'subscribe', 'integer'],
  ['notes', 'notes', 'text'],
  ['description', 'description', 'text'],
  ['interests', 'interests', 'text'],
  ['keepPrivate', 'keepprivate', 'integer'],
  ['photoFileID', 'photofileid', 'text'],
  ['IMName', 'imname', 'text'],
  ['IMService', 'imservice', 'text'],
  ['created', 'created', 'timestamp'],
  ['remoteID', 'remoteid', 'text'],
  ['tags', 'tags', 'text'],
  ['photoFileExt', 'photofileext', 'text'],
  ['tablist', 'tablist', 'text'],
] as const);

/** Defines `key` as an own data property, so a `__proto__` key stays data. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A date as the contract's `LocalTimestamp`: wall-clock time in the legacy server's zone, with milliseconds. */
function localTimestamp(date: Date): string {
  return cfDateTimeFormat(date, 'yyyy-MM-dd HH:nn:ss.lll').replace(' ', 'T');
}

// The save has already refused complex values (splitUserValues), and the bean's setters leave its text columns strings.
/** A bean value in its record column: a date not yet set, or text that is no integer, reads as NULL. */
function recordValue(value: unknown, kind: ColumnKind): string | number | null {
  if (kind === 'timestamp') return value instanceof Date ? localTimestamp(value) : null;
  if (kind === 'integer') return cfIsNumeric(value) && Number.isInteger(cfToNumber(value)) ? cfToNumber(value) : null;
  return typeof value === 'string' ? value : null;
}

/** `rc.userBean` as the contract's person record, in bootstrap column casing. */
function personRecord(values: UserValues): PersonRecord {
  const record: Record<string, unknown> = {};
  for (const [column, key, kind] of PERSON_RECORD_COLUMNS) define(record, column, recordValue(values[key], kind));
  return { ...record, UserID: values.userid, Type: 2, SiteID: values.siteid };
}

/** A stored address of `userId` in bootstrap column casing. */
function addressRecord(row: AddressRow, userId: string): AddressRecord {
  return {
    addressID: row.addressid,
    userID: row.userid ?? userId,
    siteID: row.siteid,
    addressName: row.addressname,
    address1: row.address1,
    address2: row.address2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    country: row.country,
    phone: row.phone,
    fax: row.fax,
    isPrimary: row.isprimary,
    addressNotes: row.addressnotes,
    addressURL: row.addressurl,
    longitude: row.longitude,
    latitude: row.latitude,
    addressEmail: row.addressemail,
    hours: row.hours,
  };
}

/** `getSubTypesByType(type=2, siteID, activeOnly=true)`: the active user subtypes, in type then subtype order. */
function activeSubTypes(rows: readonly SubtypeRow[]): SubTypeOption[] {
  return rows.filter((row) => row.isactive === 1).map((row) => ({ subTypeID: row.subtypeid, type: row.type ?? '', subType: row.subtype ?? '' }));
}

/** Extended attribute values as text; a date attribute in the contract's timestamp form. */
function attributeValues(data: Readonly<Record<string, ExtendValue>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(data)) define(values, name, value instanceof Date ? localTimestamp(value) : value);
  return values;
}

/** The errors struct as the contract's field-to-message map; a user save's errors hold messages only. */
function messageMap(errors: Readonly<LegacyErrors>): Schemas['LegacyErrors'] {
  const messages: Record<string, string> = {};
  for (const [field, message] of Object.entries(errors)) {
    if (typeof message !== 'string') throw new TypeError(`The ${field} error is a struct, not a message`);
    define(messages, field, message);
  }
  return messages;
}

/** The verified session user that `profileGate` admitted. */
function profileUser(request: FastifyRequest): UserClaims {
  const claims = requireLoggedIn(request);
  if (claims instanceof AdminDenial) throw claims.auth;
  return claims;
}

/** cEditProfile `before()`: a caller who is not logged in gets the `secure()` denial. */
async function profileGate(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const claims = requireLoggedIn(request);
  return claims instanceof AdminDenial ? sendAdminDenial(reply, claims) : undefined;
}

/** The withheld variant a profile save selects, keyed by the shared route-key function as the gateway keys it. */
function withheldVariantOf(request: FastifyRequest): string | undefined {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(legacyParamsOf(request))) {
    if (typeof value === 'string' && !ACTION_PARAMS.has(name.toLowerCase())) define(params, name, value);
  }
  const multipartFileNames = multipartFilesOf(request).map(({ field, filename }) => ({ field, filename }));
  const entry = { kind: 'admin', action: PROFILE_UPDATE_ACTION, params, multipartFileNames } as const;
  return routeKeyForEntryPoint(entry, { variants: WITHHELD_VARIANTS }).variant;
}

/** Answers a withheld branch with the legacy 503 before its CSRF token is consumed, so nothing is written on either side. */
async function refuseWithheldBranch(request: FastifyRequest): Promise<void> {
  const variant = withheldVariantOf(request);
  if (variant === 'photo') throw new PhotoBranchError();
  if (variant !== undefined) {
    throw new LegacyServiceUnavailableError(`The ${variant} branch of ${PROFILE_UPDATE_ACTION} is served by legacy`, 'auto', `${variant}-withheld`);
  }
}

/** A refused token skips the save, and legacy then fails on the unset `rc.userBean` (ceditprofile/update.cfm:76). */
function failOnUnsetUserBean(): never {
  throw new Error(`${PROFILE_UPDATE_ACTION} refused its CSRF token; legacy fails on the unset rc.userBean`);
}

/** The legacy 503 of a session user identity holds no account of. */
function accountUnknown(userId: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`User ${userId} has no account in the token site's user pools`, 'auto', 'person-unknown');
}

/** The session user's account and the tenant of its user-pool site, from identity and the site registry only. */
async function sessionAccount(roster: RosterDeps, claims: UserClaims): Promise<{ account: AccountView; tenantId: string }> {
  const account = await roster.identity.readAccount(claims.sub);
  if (account === undefined) throw accountUnknown(claims.sub);
  const tenantId = await tenantForRegisteredSite(roster.db, account.siteId);
  if (tenantId === null) {
    throw new LegacyServiceUnavailableError(`Site ${account.siteId} has no site registry entry`, 'auto', 'tenant-unregistered');
  }
  return { account, tenantId };
}

// The bean's memberships are left empty: the screen shows none, and identity lists them only to cUsers callers.
/** `edit()`: `userManager.read(session.mura.userID)` and the data of every Edit Profile tab [legacy: admin/core/controllers/ceditprofile.cfc:117-123]. */
async function readProfile(roster: RosterDeps, claims: UserClaims): Promise<ProfileData> {
  // The located account names the tenant, which no roster save moves; the profile shows the account read with the person.
  const { account: located, tenantId } = await sessionAccount(roster, claims);
  const config = roster.extendConfig ?? EXTEND_CONFIG_DEFAULTS;
  const readPerson = async (tx: TenantTx) => {
    const person = await roster.repo.findPerson(tx, claims.sub);
    if (person === null) return null;
    const categoryIds = (await roster.repo.listInterests(tx, person.userid)).map((row) => row.categoryid);
    const addresses = await listAddresses(roster.repo, tx, person.userid);
    const scope = { siteId: person.siteid ?? '', type: '2', subtype: person.subtype ?? '' };
    const extend = await extendSetData(roster.repo, tx, person.userid, scope, config);
    const subtypes = await roster.repo.listExtendSubtypes(tx, { siteId: located.siteId, types: ['2'] });
    return { person, categoryIds, addresses, extend, subtypes };
  };
  const { stored, account } = await observePersons(
    roster,
    (observer) => observer.read(tenantId, readPerson, (rows) => (rows === null ? [] : [rows.person.userid]), [claims.sub]),
    async (rows) => ({ stored: rows, account: rows === null ? undefined : await roster.identity.readAccount(claims.sub) }),
  );
  if (stored === null) {
    throw new LegacyServiceUnavailableError(`User ${claims.sub} is not a person of this tenant`, 'auto', 'person-unknown');
  }
  if (account === undefined) throw accountUnknown(claims.sub);
  const { person, categoryIds, addresses, extend, subtypes } = stored;
  const values = userBeanValues({ person, account, groupIds: [], categoryIds, extend, photoFileExt: '' }, roster.clock);
  return {
    user: personRecord(values),
    addresses: addresses.map((row) => addressRecord(row, person.userid)),
    categoryIds,
    subTypes: activeSubTypes(subtypes),
    extendedAttributes: attributeValues(extend.data),
    errors: {},
    retained: false,
  };
}

/** `update()`: the session user's own save under the roster write protocol, with `updateGroups=false` [legacy: admin/core/controllers/ceditprofile.cfc:125-141]. */
async function updateProfile(roster: RosterDeps, request: FastifyRequest): Promise<UpdateResult> {
  const claims = profileUser(request);
  const { tenantId } = await sessionAccount(roster, claims);
  // The domain takes `userid` and `siteid` from the session user and drops `isPublic`, `s2`, `type` and `groupID`.
  const result = await runRosterOperation(roster, {
    kind: 'profile-update',
    tenantId,
    claims,
    acting: await roster.identity.actingUser(claims.sid),
    params: normaliseParams(normaliseProfileParams(legacyParamsOf(request))),
    postedFiles: new Map(multipartFilesOf(request).map((file) => [file.field, file.filename])),
    requestId: request.id,
  });
  if (result.ok) return { written: true, redirect: HOME_REDIRECT, errors: {} };
  return { written: false, errors: messageMap(result.errors), userBean: personRecord(result.values) };
}

/** Registers `GET /v1/profile` (`getProfile`) and `POST /v1/profile:update` (`updateProfile`). */
export async function registerAdminProfileRoutes(app: FastifyInstance, deps: AdminProfileRouteDeps): Promise<void> {
  app.get<{ Reply: ProfileData }>(
    '/v1/profile',
    { config: { opt2: { transport: 'service', requires: PROFILE_ROUTE_REQUIRES } }, preHandler: profileGate },
    async (request) => readProfile(deps.roster, profileUser(request)),
  );

  app.post<{ Reply: UpdateResult }>(
    '/v1/profile::update',
    {
      // The posted `siteid` is the user's pool site, which legacy overwrites with the session user's and never scopes by.
      config: { opt2: { transport: 'service', requires: PROFILE_ROUTE_REQUIRES, siteCheck: false } },
      // Legacy validates with no context, so the token's context is ''.
      preHandler: [profileGate, refuseWithheldBranch, csrfPreHandler({ contextOf: () => '', onReject: failOnUnsetUserBean })],
    },
    async (request) => updateProfile(deps.roster, request),
  );
}
