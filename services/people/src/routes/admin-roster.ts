// The people writes of the cUsers admin circuit: the Type=2 add and update of `cUsers.update` under the roster write
// protocol, and `cUsers.updateAddress` [legacy: admin/core/controllers/cusers.cfc:290-375].
import type { Opt2RouteConfig, UserClaims } from '@opt2/platform/auth';
import {
  LegacyServiceUnavailableError,
  PHOTO_CONDITION,
  cfDateTimeFormat,
  cfEq,
  cfIsNumeric,
  cfNumberString,
  cfToNumber,
  isCfUuid,
  javaTrim,
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
import { tenantForRegisteredSite } from '@opt2/platform/tenancy';
import { createAddress, updateAddress, type AddressActor, type AddressDeps } from '../domain/addresses.js';
import { expirePasswordsSetting, passwordExpired } from '../domain/password-expiry.js';
import { applyUserInput, newUserValues, normaliseParams, resolveUserSite, restrictAdminInput, type UserValues } from '../domain/person.js';
import { PhotoBranchError, personFence, runRosterOperation, type RosterDeps, type RosterKind } from '../domain/roster-protocol.js';
import type { LegacyErrors } from '../domain/validation.js';
import type { components } from '../generated/openapi.js';
import type { AccountView } from '../legacy/identity-client.js';
import { AdminDenial, CUSERS_ROUTE_REQUIRES, normaliseCusersParams, requireCusersAccess, sendAdminDenial, type CusersContext } from './access.js';
import { hrefSanitizer, routeRedirect } from './admin-users.js';

type Schemas = components['schemas'];
type UpdateResult = Schemas['UpdateResult'];
type RouteResult = Schemas['RouteResult'];
type RouteRedirect = Schemas['RouteRedirect'];
type AdminRedirect = Schemas['AdminRedirect'];
type PersonRecord = Schemas['PersonRecord'];

/** Dependencies of {@link registerAdminRosterRoutes}: the roster write protocol's collaborators, which the address saves share. */
export interface AdminRosterRouteDeps {
  roster: RosterDeps;
  /** configBean `expirePasswords`; defaults to `MURA_EXPIREPASSWORDS` of `process.env`. */
  expirePasswords?: number;
}

const CUSERS_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: CUSERS_ROUTE_REQUIRES });

const UPDATE_ACTION = 'cUsers.update';
const UPDATE_ADDRESS_ACTION = 'cUsers.updateAddress';
const UPDATE_ROUTE = 'admin:cusers.update';
const UPDATE_ADDRESS_ROUTE = 'admin:cusers.updateaddress';

/** A condition holding when the request's `param` equals `value` under CFML `==`. */
function equals(param: string, value: string): VariantCondition {
  return Object.freeze<VariantCondition>({ param, equals: value });
}

/** A save posting a non-empty `extendSetID`, which writes extended attributes. */
const EXTDATA: VariantCondition = Object.freeze<VariantCondition>({ param: 'extendSetID', nonEmpty: true });

/** A declaration of `route`'s `variant`, frozen. */
function declare(route: string, variant: string, when: VariantCondition[]): VariantDeclaration {
  return Object.freeze({ route, variant, when: Object.freeze(when) });
}

/** The gateway's `cUsers.update` variants in its declaration order, the first that holds winning. */
const UPDATE_VARIANTS: readonly VariantDeclaration[] = Object.freeze([
  declare(UPDATE_ROUTE, 'photo', [PHOTO_CONDITION]),
  declare(UPDATE_ROUTE, 'type=2,action=add,extdata', [equals('type', '2'), equals('action', 'Add'), EXTDATA]),
  declare(UPDATE_ROUTE, 'type=2,action=update,extdata', [equals('type', '2'), equals('action', 'Update'), EXTDATA]),
  declare(UPDATE_ROUTE, 'type=1,action=delete', [equals('type', '1'), equals('action', 'Delete')]),
  declare(UPDATE_ROUTE, 'type=1,extdata', [equals('type', '1'), EXTDATA]),
  declare(UPDATE_ROUTE, 'type=2,action=add', [equals('type', '2'), equals('action', 'Add')]),
  declare(UPDATE_ROUTE, 'type=2,action=delete', [equals('type', '2'), equals('action', 'Delete')]),
  declare(UPDATE_ROUTE, 'type=2,action=update', [equals('type', '2'), equals('action', 'Update')]),
  declare(UPDATE_ROUTE, 'type=1', [equals('type', '1')]),
]);

/** The `cUsers.update` variants people carries, with the roster kind each runs as. */
const CARRIED_SAVES: ReadonlyMap<string, RosterKind> = new Map<string, RosterKind>([
  ['type=2,action=add', 'admin-add'],
  ['type=2,action=update', 'admin-update'],
]);

/** The gateway's `cUsers.updateAddress` variants; both stay on legacy, and only the base action is carried. */
const UPDATE_ADDRESS_VARIANTS: readonly VariantDeclaration[] = Object.freeze([
  declare(UPDATE_ADDRESS_ROUTE, 'action=delete', [equals('action', 'Delete')]),
  declare(UPDATE_ADDRESS_ROUTE, 'extdata', [Object.freeze<VariantCondition>({ anyOf: Object.freeze([EXTDATA, equals('extendSetID', '')]) })]),
]);

/** Request names selecting the admin action, left out because each route keys its own action. */
const ACTION_PARAMS: ReadonlySet<string> = new Set(['muraaction', 'fuseaction']);

/** The address saves of `rc.action`, matched under CFML `==`; any other action writes nothing. */
const ADDRESS_SAVES: ReadonlyArray<readonly [action: string, save: typeof createAddress]> = Object.freeze([
  ['Update', updateAddress],
  ['Add', createAddress],
]);

/** The `tusers` values a user bean holds, in bootstrap casing without `Password` and `PasswordCreated`, with the kind each takes on the wire. */
const BEAN_COLUMNS: ReadonlyArray<readonly [name: string, kind: 's' | 'i' | 't']> = Object.freeze([
  ['UserID', 's'], ['GroupName', 's'], ['Fname', 's'], ['Lname', 's'], ['UserName', 's'],
  ['Email', 's'], ['Company', 's'], ['JobTitle', 's'], ['mobilePhone', 's'], ['Website', 's'], ['Type', 'i'],
  ['subType', 's'], ['ContactForm', 's'], ['S2', 'i'], ['LastLogin', 't'], ['LastUpdate', 't'], ['LastUpdateBy', 's'],
  ['LastUpdateByID', 's'], ['Perm', 'i'], ['InActive', 'i'], ['isPublic', 'i'], ['SiteID', 's'], ['Subscribe', 'i'],
  ['notes', 's'], ['description', 's'], ['interests', 's'], ['keepPrivate', 'i'], ['photoFileID', 's'],
  ['photoFileExt', 's'], ['IMName', 's'], ['IMService', 's'], ['created', 't'], ['remoteID', 's'], ['tags', 's'],
  ['tablist', 's'],
] as const);

/** A request cUsers `before()` admitted: the verified caller and the request context after its defaults and scrubbing. */
interface Admitted {
  claims: UserClaims;
  ctx: CusersContext;
}

/** An admitted user save and the roster kind its variant runs as. */
interface AdmittedSave extends Admitted {
  kind: RosterKind;
}

const admittedSaves = new WeakMap<FastifyRequest, AdmittedSave>();
const admittedAddresses = new WeakMap<FastifyRequest, Admitted>();

/** Address saves whose CSRF token identity refused; they write nothing and still redirect. */
const refusedAddressTokens = new WeakSet<FastifyRequest>();

/** Defines `key` as an own data property, so a posted `__proto__` stays a data key. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** What the admitting preHandler recorded for `request`. */
function admittedOf<T>(admitted: WeakMap<FastifyRequest, T>, request: FastifyRequest): T {
  const found = admitted.get(request);
  if (found === undefined) throw new Error(`${request.routeOptions.url ?? request.url} ran without its cUsers gate`);
  return found;
}

/** The variant the gateway keys `request` by, from its simple params and file parts through the shared route-key function. */
function variantOf(request: FastifyRequest, action: string, variants: readonly VariantDeclaration[]): string | undefined {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(legacyParamsOf(request))) {
    if (typeof value === 'string' && !ACTION_PARAMS.has(name.toLowerCase())) define(params, name, value);
  }
  const multipartFileNames = multipartFilesOf(request).map(({ field, filename }) => ({ field, filename }));
  return routeKeyForEntryPoint({ kind: 'admin', action, params, multipartFileNames }, { variants }).variant;
}

// The gateway keeps these branches on legacy; one that reaches people anyway answers the legacy 503 before its token
// is consumed, so neither side records any change.
/** The legacy 503 of a branch of `action` that legacy serves. */
function withheldBranch(action: string, variant: string | undefined): LegacyServiceUnavailableError {
  if (variant === 'photo') return new PhotoBranchError();
  const branch = variant ?? 'base';
  return new LegacyServiceUnavailableError(`The ${branch} branch of ${action} is served by legacy`, 'auto', `${branch}-withheld`);
}

/** cUsers `before()`: the caller's claims and request context, or the denial `secure()` answers with. */
async function admit(request: FastifyRequest, reply: FastifyReply): Promise<Admitted | undefined> {
  const claims = requireCusersAccess(request);
  if (claims instanceof AdminDenial) {
    await sendAdminDenial(reply, claims);
    return undefined;
  }
  return { claims, ctx: normaliseCusersParams(legacyParamsOf(request), claims) };
}

/** The user save's gate and branch check: only a Type=2 add or update without a photo or extended attributes runs here. */
async function admitUserSave(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const admitted = await admit(request, reply);
  if (admitted === undefined) return reply;
  const variant = variantOf(request, UPDATE_ACTION, UPDATE_VARIANTS);
  const kind = variant === undefined ? undefined : CARRIED_SAVES.get(variant);
  if (kind === undefined) throw withheldBranch(UPDATE_ACTION, variant);
  admittedSaves.set(request, { ...admitted, kind });
  return undefined;
}

// Address delete is withheld with its extended-data branch: its closure reaches strategies-content's ratings and files.
/** The address save's gate and branch check: a delete or extended attributes stay on legacy. */
async function admitAddressSave(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const admitted = await admit(request, reply);
  if (admitted === undefined) return reply;
  const variant = variantOf(request, UPDATE_ADDRESS_ACTION, UPDATE_ADDRESS_VARIANTS);
  if (variant !== undefined) throw withheldBranch(UPDATE_ADDRESS_ACTION, variant);
  admittedAddresses.set(request, admitted);
  return undefined;
}

/** A refused token skips the save, and legacy then fails reading the unset `rc.userBean` (cusers.cfc:343). */
function failOnUnsetUserBean(): never {
  throw new Error(`${UPDATE_ACTION} refused its CSRF token; legacy fails on the unset rc.userBean`);
}

/** A refused token only skips the address write; the handler still redirects. */
function skipAddressWrite(request: FastifyRequest): void {
  refusedAddressTokens.add(request);
}

/** A date as the contract's `LocalTimestamp`: wall-clock time in the legacy server's zone, with milliseconds. */
function localTimestamp(date: Date): string {
  return cfDateTimeFormat(date, 'yyyy-mm-dd HH:nn:ss.lll').replace(' ', 'T');
}

/** A bean value in its column's wire form: a date not yet parsed, text that is no integer, or a complex value is NULL. */
function wireValue(value: unknown, kind: 's' | 'i' | 't'): string | number | null {
  if (kind === 't') return value instanceof Date ? localTimestamp(value) : null;
  if (kind === 'i') return cfIsNumeric(value) && Number.isInteger(cfToNumber(value)) ? cfToNumber(value) : null;
  if (typeof value === 'number') return cfNumberString(value);
  return typeof value === 'string' ? value : null;
}

/** A failed save's bean as `rc.userBean` reaches the re-opened form: its columns and the posted `groupid` and `categoryid` lists. */
function retainedBean(values: UserValues): PersonRecord {
  const record: Record<string, unknown> = {};
  for (const [name, kind] of BEAN_COLUMNS) define(record, name, wireValue(values[name.toLowerCase()], kind));
  define(record, 'groupid', values.groupid);
  define(record, 'categoryid', values.categoryid);
  return record as PersonRecord;
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

/** The stored user the S2 restriction reads: only a CF UUID `userid` names one, and only for a caller who is not S2. */
async function restrictionTarget(roster: RosterDeps, claims: UserClaims, userId: string): Promise<AccountView | undefined> {
  return claims.s2 || !isCfUuid(userId) ? undefined : roster.identity.readAccount(userId);
}

/**
 * The user-pool tenant a save lands in, by the pool rule the protocol applies to the bean; an update whose `isPublic`
 * the S2 restriction removed keeps the stored account's.
 */
async function saveTenant(
  roster: RosterDeps,
  claims: UserClaims,
  kind: RosterKind,
  params: ReadonlyMap<string, unknown>,
  target: AccountView | undefined,
): Promise<string> {
  const fresh = newUserValues(roster.clock);
  const stripped = kind === 'admin-update' && target !== undefined && !params.has('ispublic');
  const base = stripped ? applyUserInput(fresh, new Map([['ispublic', target.isPublic]])) : fresh;
  return (await resolveUserSite(roster.db, claims.tid, params, applyUserInput(base, params))).poolTenantId;
}

/** `route()` after a save; FW/1's `append` carries no `ispublic` that the S2 restriction removed from `rc`. */
async function savedRedirect(roster: RosterDeps, claims: UserClaims, ctx: CusersContext, params: ReadonlyMap<string, unknown>): Promise<RouteRedirect> {
  const sanitize = ctx.routeid === '' && ctx.returnurl !== '' ? await hrefSanitizer(roster.db, claims) : (href: string) => href;
  const redirect = routeRedirect(ctx, sanitize);
  if (params.has('ispublic') || !('params' in redirect)) return redirect;
  return { ...redirect, params: Object.fromEntries(Object.entries(redirect.params).filter(([name]) => name !== 'ispublic')) };
}

// A failed save answers without `redirect`: the form re-renders from `userBean` and `errors`, which web keeps in
// `session.mura.editBean` before it redirects to `cUsers.edituser` with `preserve='all'`.
/** `update()` of a Type=2 add or update: the S2 restrictions, the save under the roster write protocol, then `route()` [legacy: admin/core/controllers/cusers.cfc:290-353]. */
async function saveUser(roster: RosterDeps, expirePasswords: number, request: FastifyRequest): Promise<UpdateResult> {
  const { claims, ctx, kind } = admittedOf(admittedSaves, request);
  const target = await restrictionTarget(roster, claims, ctx.userid);
  const { input: params } = restrictAdminInput(normaliseParams(ctx.params), {
    actorIsSuperUser: claims.s2,
    targetIsS2: (target?.s2 ?? 0) !== 0,
  });
  const result = await runRosterOperation(roster, {
    kind,
    tenantId: await saveTenant(roster, claims, kind, params, target),
    claims,
    acting: await roster.identity.actingUser(claims.sid),
    params,
    postedFiles: new Map(multipartFilesOf(request).map((file) => [file.field, file.filename])),
    requestId: request.id,
  });
  if (!result.ok) {
    const expired = passwordExpired(result.values, expirePasswords, roster.clock.now());
    return { written: false, errors: messageMap(result.errors), userBean: retainedBean(result.values), passwordExpired: expired };
  }
  return { written: true, redirect: await savedRedirect(roster, claims, ctx, params), errors: {} };
}

/**
 * The tenant of the address owner's user pool, from identity's account of the token site's pools; without an account,
 * the token's tenant, where the save writes no row for a person that tenant does not hold.
 */
async function ownerTenant(roster: RosterDeps, claims: UserClaims, userId: string): Promise<string> {
  const id = javaTrim(userId);
  const account = isCfUuid(id) ? await roster.identity.readAccount(id) : undefined;
  if (account === undefined) return claims.tid;
  const tenantId = await tenantForRegisteredSite(roster.db, account.siteId);
  if (tenantId === null) {
    throw new LegacyServiceUnavailableError(`Site ${account.siteId} has no site registry entry`, 'auto', 'tenant-unregistered');
  }
  return tenantId;
}

/** The switch on `rc.action`: `Update` or `Add` saves one address of `rc.userid`; whether a row was written. */
async function writeAddress(addresses: AddressDeps, roster: RosterDeps, request: FastifyRequest, { claims, ctx }: Admitted): Promise<boolean> {
  const input = normaliseParams(ctx.params);
  const action = input.get('action');
  const save = typeof action === 'string' ? ADDRESS_SAVES.find(([name]) => cfEq(action, name))?.[1] : undefined;
  if (save === undefined) return false;
  const actor: AddressActor = { tid: claims.tid, write: { origin: 'target', actorUserId: claims.sub, requestId: request.id } };
  const { address } = await save(addresses, await ownerTenant(roster, claims, ctx.userid), input, actor);
  return address !== null;
}

/** Where `updateAddress()` redirects; `cUsers.edituser` carries the keys FW/1 preserves for it. */
function addressRedirect(ctx: CusersContext): AdminRedirect {
  if (cfEq(ctx.routeid, 'editprofile')) return { action: 'cEditProfile.edit', params: {} };
  return { action: 'cUsers.edituser', params: { siteid: ctx.siteid, userid: ctx.userid, routeid: ctx.routeid } };
}

/** `updateAddress()`: the address save once identity accepted the token, then the redirect either way; validation errors are ignored [legacy: admin/core/controllers/cusers.cfc:355-375]. */
async function saveAddress(addresses: AddressDeps, roster: RosterDeps, request: FastifyRequest): Promise<RouteResult> {
  const admitted = admittedOf(admittedAddresses, request);
  const written = !refusedAddressTokens.has(request) && (await writeAddress(addresses, roster, request, admitted));
  return { written, redirect: addressRedirect(admitted.ctx) };
}

/** Registers `POST /v1/users:update` (`updateUser`) and `POST /v1/users/addresses:update` (`updateAddress`). */
export async function registerAdminRosterRoutes(app: FastifyInstance, deps: AdminRosterRouteDeps): Promise<void> {
  const { roster } = deps;
  const addresses: AddressDeps = { db: roster.db, repo: roster.repo, clock: roster.clock, fence: personFence };
  const expirePasswords = deps.expirePasswords ?? expirePasswordsSetting(process.env);

  app.post<{ Reply: UpdateResult }>(
    '/v1/users::update',
    {
      config: { opt2: CUSERS_AUTH },
      preHandler: [
        admitUserSave,
        csrfPreHandler({ contextOf: (request) => admittedOf(admittedSaves, request).ctx.userid, onReject: failOnUnsetUserBean }),
      ],
    },
    async (request) => saveUser(roster, expirePasswords, request),
  );

  app.post<{ Reply: RouteResult }>(
    '/v1/users/addresses::update',
    {
      config: { opt2: CUSERS_AUTH },
      preHandler: [
        admitAddressSave,
        csrfPreHandler({ contextOf: (request) => `updateaddress${admittedOf(admittedAddresses, request).ctx.userid}`, onReject: skipAddressWrite }),
      ],
    },
    async (request) => saveAddress(addresses, roster, request),
  );
}
