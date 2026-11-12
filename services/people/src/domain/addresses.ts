// Masa addressBean values and userManager address saves (addressBean.cfc, userManager.cfc:596-611, 860-937,
// userDAO.cfc:749-869) over people's `people.user_address` rows of Type=2 users.
import { withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { registryEntryForTenant, type RegistrySource, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { LegacyServiceUnavailableError, cfEq, cfIsNumeric, cfNumberString, cfToNumber, cfUuid, javaTrim } from '@opt2/platform/legacy-compat';
import type { Clock } from '@opt2/platform/service-kit';
import type { AddressInput, AddressUpdate, PeopleRepository } from '../repo/repository.js';
import { ADDRESS, type AddressRow } from '../repo/tables.js';
import type { CfNumeric } from './person.js';
import { takeOut } from './trash.js';

// Address delete is not built: the decision list withholds `admin:cusers.updateaddress{action=delete}` and
// `api:address.delete`, so it keeps running on legacy.

/** The named `addressBean` instance keys, lower-cased, with the `beanExtendable` keys its init sets. */
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

/** The `addressBean` instance struct keyed by lower-cased name; every other posted key is kept as the bean keeps it. */
export type AddressValues = AddressBeanFields & { [key: string]: unknown };

/** `addressBean.init` values (addressBean.cfc:113-139) plus beanExtendable's empty `extendSetID`. */
export const ADDRESS_DEFAULTS: Readonly<AddressBeanFields> = Object.freeze({
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

const USER_ID_REQUIRED = "The attribute 'USERID' is required when saving an address.";

/** The text columns the DAO binds, which the repository stores as NULL when ''. */
const TEXT_COLUMNS = [
  'siteid', 'phone', 'fax', 'address1', 'address2', 'city', 'state', 'zip', 'addressname', 'country', 'addressnotes',
  'addressurl', 'addressemail', 'hours',
] as const;

/** The `select * from tuseraddresses` columns of a stored address; `tenant_id` is target-only. */
const STORED_COLUMNS: readonly string[] = ADDRESS.columns.map((column) => column.name).filter((name) => name !== 'tenant_id');

/** A fresh bean's values. */
function newAddressValues(): AddressValues {
  return { ...ADDRESS_DEFAULTS, errors: {} };
}

/** A simple value as CFML text, '' for a NULL; throws where ACF refuses a complex value as a string. */
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

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Defines `key` as an own data property, so a posted `__proto__` stays a data key. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** `beanExtendable.setSiteID`/`setType`/`setSubType`: a non-empty value whose trimmed form differs ignoring case (beanExtendable.cfc:113-137). */
function setChanged(values: Record<string, unknown>, key: string, value: string): void {
  const trimmed = javaTrim(value);
  if (value !== '' && !cfEq(trimmed, simpleText(values[key], key))) values[key] = trimmed;
}

type Setter = (values: Record<string, unknown>, value: unknown) => void;

/** A setter assigning a numeric argument only, as `setIsPrimary`, `setLongitude` and `setLatitude` do. */
function numericOnly(key: string): Setter {
  return (values, value) => {
    if (cfIsNumeric(value)) values[key] = value;
  };
}

function changed(key: string): Setter {
  return (values, value) => setChanged(values, key, simpleText(value, key));
}

/** The `addressBean` setters `setValue` dispatches to, by lower-cased property name. */
const ADDRESS_SETTERS: ReadonlyMap<string, Setter> = new Map<string, Setter>([
  ['isprimary', numericOnly('isprimary')],
  ['longitude', numericOnly('longitude')],
  ['latitude', numericOnly('latitude')],
  ['siteid', changed('siteid')],
  ['type', changed('type')],
  ['subtype', changed('subtype')],
  [
    'errors',
    (values, value) => {
      if (isStruct(value)) values.errors = value;
    },
  ],
]);

/** The user pool `addressBean.set` moves the address to: only with a non-blank posted `siteid` and `isPublic` (addressBean.cfc:170-176). */
function addressPool(input: ReadonlyMap<string, unknown>): 'private' | 'public' | null {
  const siteId = input.get('siteid');
  const isPublic = input.get('ispublic');
  if (siteId === undefined || siteId === null || isPublic === undefined || isPublic === null) return null;
  const flag = simpleText(isPublic, 'isPublic');
  if (javaTrim(simpleText(siteId, 'siteid')) === '' || javaTrim(flag) === '') return null;
  return cfEq(flag, '0') ? 'private' : 'public';
}

/**
 * `addressBean.set` of a parameter struct (addressBean.cfc:150-179): each key through its setter, else assigned (simple
 * values trimmed); then, when `input` holds a non-blank `siteid` and `isPublic`, `poolSite` through `setSiteID`.
 */
export function applyAddressInput(current: AddressValues, input: ReadonlyMap<string, unknown>, poolSite?: string): AddressValues {
  const values: Record<string, unknown> = { ...current };
  for (const [key, raw] of input) {
    const value = setterArgument(raw);
    const setter = ADDRESS_SETTERS.get(key.toLowerCase());
    if (setter !== undefined) setter(values, value);
    else define(values, key, value);
  }
  if (poolSite !== undefined && addressPool(input) !== null) setChanged(values, 'siteid', poolSite);
  return values as AddressValues;
}

/**
 * The pool site `applyAddressInput` takes for `input`: the private (`isPublic` 0) or public user pool of the token tenant
 * `tid`'s registry entry; undefined when the pool rule does not apply. Throws the legacy 503 for an unregistered tenant.
 */
export async function resolveAddressPoolSite(
  registry: RegistrySource,
  tid: string,
  input: ReadonlyMap<string, unknown>,
): Promise<string | undefined> {
  const pool = addressPool(input);
  if (pool === null) return undefined;
  const entry = await registryEntryForTenant(registry, tid);
  if (entry === null) {
    throw new LegacyServiceUnavailableError(`Tenant ${tid} has no site registry entry`, 'auto', 'tenant-unregistered');
  }
  // settingsBean answers an empty pool id with the site's own id.
  const poolId = pool === 'private' ? entry.privateUserPoolId : entry.publicUserPoolId;
  return poolId === null || poolId === '' ? entry.siteId : poolId;
}

/**
 * The primary address `userManager.create` inserts with a new user (userManager.cfc:601-611); undefined for a user
 * restored from the trash. Its `siteid` stays as `set` leaves it: create does not re-stamp the user's site.
 */
export function primaryAddressFor(userId: string, input: ReadonlyMap<string, unknown>, poolSite?: string): AddressValues | undefined {
  if (input.has('frommuratrash')) return undefined;
  const values = applyAddressInput(newAddressValues(), input, poolSite);
  if (simpleText(values.addressid, 'addressid') === '') values.addressid = cfUuid();
  values.userid = userId;
  values.isprimary = 1;
  if (simpleText(values.addressname, 'addressname') === '') values.addressname = 'Primary';
  return values;
}

/** The text columns of a bean as the DAO binds them. */
function textColumns(address: AddressValues): Record<(typeof TEXT_COLUMNS)[number], string> {
  const columns = {} as Record<(typeof TEXT_COLUMNS)[number], string>;
  for (const column of TEXT_COLUMNS) columns[column] = simpleText(address[column], column);
  return columns;
}

/** Inserts the address as `userDAO.createAddress` does (userDAO.cfc:776-805); SQL Server truncates the inlined `isPrimary`. */
export function insertAddressInTx(repo: PeopleRepository, tx: TenantTx, address: AddressValues, ctx: WriteContext = {}): Promise<AddressRow> {
  const row: AddressInput = {
    ...textColumns(address),
    addressid: simpleText(address.addressid, 'addressid'),
    userid: simpleText(address.userid, 'userid'),
    isprimary: Math.trunc(cfToNumber(address.isprimary)),
    longitude: cfToNumber(address.longitude),
    latitude: cfToNumber(address.latitude),
  };
  return repo.insertAddress(tx, row, ctx);
}

/** Updates the address `address.addressid` as `userDAO.updateAddress` does (userDAO.cfc:749-774), leaving `isPrimary`; null when absent. */
export function updateAddressInTx(repo: PeopleRepository, tx: TenantTx, address: AddressValues, ctx: WriteContext = {}): Promise<AddressRow | null> {
  const patch: AddressUpdate = {
    ...textColumns(address),
    userid: simpleText(address.userid, 'userid'),
    longitude: cfToNumber(address.longitude),
    latitude: cfToNumber(address.latitude),
  };
  return repo.updateAddress(tx, simpleText(address.addressid, 'addressid'), patch, ctx);
}

/** Makes `addressId` the user's only primary address (userDAO.cfc:845-857). */
export function setPrimaryAddress(repo: PeopleRepository, tx: TenantTx, userId: string, addressId: string, ctx: WriteContext = {}): Promise<void> {
  return repo.setPrimaryAddress(tx, userId, addressId, ctx);
}

/** The user's addresses, primary first (userDAO.cfc:859-869), read once no write window blocks the unit. */
export function listAddresses(repo: PeopleRepository, tx: TenantTx, userId: string): Promise<AddressRow[]> {
  return repo.listAddresses(tx, userId);
}

/** Collaborators of the request-level saves; `awaitPersonOpen` is the roster protocol's wait on a user an open operation closes. */
export interface AddressDeps {
  db: TenantDb;
  repo: PeopleRepository;
  clock: Clock;
  awaitPersonOpen: (db: TenantDb, tenantId: string, userId: string, opts: { clock: Clock }) => Promise<void>;
}

/** Who saves: the token tenant whose registry entry the pool rule reads, and the audit context of the writes. */
export interface AddressActor {
  tid: string;
  write: WriteContext;
}

/** The saved bean's values and its stored row; `address` is null when an update matched no row, as legacy's UPDATE does. */
export interface AddressSaveResult {
  values: AddressValues;
  address: AddressRow | null;
}

/** A posted value as text; '' when absent or NULL. */
function postedText(input: ReadonlyMap<string, unknown>, key: string): string {
  return simpleText(input.get(key), key);
}

/** The posted `userid` the managers require, trimmed as the bean holds it; a missing or empty one throws legacy's custom error, a 500. */
function requiredUserId(input: ReadonlyMap<string, unknown>): string {
  const userId = postedText(input, 'userid');
  if (userId === '') throw new Error(USER_ID_REQUIRED);
  return javaTrim(userId);
}

// The `{extdata}` branches are withheld on the decision list (`admin:cusers.updateaddress{extdata}`,
// `api:address.save{extdata}`) and routed to legacy, so a posted `extendSetID`, even empty, is refused before any write.
function assertNoExtendedData(input: ReadonlyMap<string, unknown>): void {
  if (input.has('extendsetid')) {
    throw new LegacyServiceUnavailableError('Address extended data is saved by legacy', 'auto', 'address-extdata-withheld');
  }
}

/** An address whose owner is no person of the tenant belongs to a group (identity's share) or to no user, so people writes none. */
function ownerUnknown(userId: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`User ${userId} is not a person of this tenant`, 'auto', 'address-owner-unknown');
}

/** `userDAO.readAddress` of a stored row: `set(rs)` with NULL read as '' (userDAO.cfc:720-733). */
function storedValues(row: AddressRow): AddressValues {
  const columns: Readonly<Record<string, unknown>> = row;
  return applyAddressInput(newAddressValues(), new Map(STORED_COLUMNS.map((name) => [name, columns[name] ?? ''] as const)));
}

/** createAddress after `set` (userManager.cfc:877-896): the owner's site, the posted or a new id, the insert, then takeOut. */
async function createInTx(
  deps: AddressDeps,
  tx: TenantTx,
  values: AddressValues,
  postedId: string,
  input: ReadonlyMap<string, unknown>,
  write: WriteContext,
): Promise<AddressSaveResult> {
  const userId = simpleText(values.userid, 'userid');
  const person = await deps.repo.findPerson(tx, userId);
  if (person === null) throw ownerUnknown(userId);
  setChanged(values, 'siteid', person.siteid ?? '');
  values.addressid = postedId === '' ? cfUuid() : postedId;
  const address = await insertAddressInTx(deps.repo, tx, values, write);
  await takeOut(deps.repo, tx, values.addressid, input, { write });
  return { values, address };
}

/** updateAddress after `set` (userManager.cfc:922-934): the owner's site, then the UPDATE, which matches no row for an unknown id. */
async function updateInTx(deps: AddressDeps, tx: TenantTx, values: AddressValues, stored: boolean, write: WriteContext): Promise<AddressSaveResult> {
  const userId = simpleText(values.userid, 'userid');
  const person = await deps.repo.findPerson(tx, userId);
  if (person === null) {
    if (!stored) return { values, address: null };
    throw ownerUnknown(userId);
  }
  setChanged(values, 'siteid', person.siteid ?? '');
  return { values, address: await updateAddressInTx(deps.repo, tx, values, write) };
}

/** userManager.createAddress (userManager.cfc:860-897) of the person in tenant `tenantId`; `cusers.updateAddress` Add. */
export async function createAddress(
  deps: AddressDeps,
  tenantId: string,
  input: ReadonlyMap<string, unknown>,
  actor: AddressActor,
): Promise<AddressSaveResult> {
  const userId = requiredUserId(input);
  assertNoExtendedData(input);
  await deps.awaitPersonOpen(deps.db, tenantId, userId, { clock: deps.clock });
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    const values = applyAddressInput(newAddressValues(), input, await resolveAddressPoolSite(tx, actor.tid, input));
    return createInTx(deps, tx, values, postedText(input, 'addressid'), input, actor.write);
  });
}

/** userManager.updateAddress (userManager.cfc:899-937): createAddress without a posted `addressid`, else the stored address with `input` applied. */
export async function updateAddress(
  deps: AddressDeps,
  tenantId: string,
  input: ReadonlyMap<string, unknown>,
  actor: AddressActor,
): Promise<AddressSaveResult> {
  const userId = requiredUserId(input);
  const addressId = postedText(input, 'addressid');
  if (addressId === '') return createAddress(deps, tenantId, input, actor);
  assertNoExtendedData(input);
  await deps.awaitPersonOpen(deps.db, tenantId, userId, { clock: deps.clock });
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    const stored = await deps.repo.findAddress(tx, addressId);
    const current = stored === null ? newAddressValues() : storedValues(stored);
    const values = applyAddressInput(current, input, await resolveAddressPoolSite(tx, actor.tid, input));
    return updateInTx(deps, tx, values, stored !== null, actor.write);
  });
}

/**
 * The JSON API `address` save (jsonApiUtility.cfc:2010-2029, addressBean.cfc:258-268): the stored address with `input`
 * applied, then updateAddress when its id is stored, else createAddress. The userid check reads the merged values.
 */
export async function saveAddress(
  deps: AddressDeps,
  tenantId: string,
  input: ReadonlyMap<string, unknown>,
  actor: AddressActor,
): Promise<AddressSaveResult> {
  assertNoExtendedData(input);
  const addressId = postedText(input, 'addressid');
  const find = (tx: TenantTx): Promise<AddressRow | null> => (addressId === '' ? Promise.resolve(null) : deps.repo.findAddress(tx, addressId));
  // Without a posted userid the stored owner saves, so the address is read first to know whose operation to wait out.
  const owner = input.has('userid') ? postedText(input, 'userid') : simpleText((await withGatedTenant(deps.db, tenantId, find))?.userid, 'userid');
  const userId = javaTrim(owner);
  if (userId === '') throw new Error(USER_ID_REQUIRED);
  await deps.awaitPersonOpen(deps.db, tenantId, userId, { clock: deps.clock });
  return withGatedTenant(deps.db, tenantId, async (tx) => {
    const stored = await find(tx);
    const current = stored === null ? newAddressValues() : storedValues(stored);
    const values = applyAddressInput(current, input, await resolveAddressPoolSite(tx, actor.tid, input));
    if (stored !== null) return updateInTx(deps, tx, values, true, actor.write);
    return createInTx(deps, tx, values, simpleText(values.addressid, 'addressid'), input, actor.write);
  });
}
