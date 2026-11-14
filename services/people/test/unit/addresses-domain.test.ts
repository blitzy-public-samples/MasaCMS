/** Masa addressBean shaping and the userManager address save refusals, over doubles that run no statement. */
import { describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A } from '@opt2/platform/testing';
import {
  ADDRESS_DEFAULTS,
  applyAddressInput,
  createAddress,
  primaryAddressFor,
  resolveAddressPoolSite,
  saveAddress,
  updateAddress,
} from '../../src/domain/addresses.js';
import { normaliseParams } from '../../src/domain/person.js';
import type { PeopleRepository } from '../../src/repo/repository.js';
import { ACTOR_A, CF_UUID, USER_ID_REQUIRED, bean, harness, rejection, type AddressSave } from '../helpers/address-saves.js';

const A = TENANT_A.tenantId;

const SAVES: readonly [string, AddressSave][] = [
  ['createAddress', createAddress],
  ['updateAddress', updateAddress],
  ['saveAddress', saveAddress],
];

/** A database and repository that fail on any use, so a refusal that never reaches them read and wrote nothing. */
const UNTOUCHABLE_DB: TenantDb = {
  schema: 'people',
  withTenant: () => Promise.reject(new Error('unexpected tenant transaction')),
  withMetadata: () => Promise.reject(new Error('unexpected registry read')),
  end: () => Promise.resolve(),
};
const UNTOUCHABLE_REPO = new Proxy({} as PeopleRepository, {
  get: (_target, key) => {
    throw new Error(`unexpected repository use: ${String(key)}`);
  },
});
/** A database whose tenant transactions get a handle that runs no statement, so only the collaborators act. */
const STATEMENTLESS_DB: TenantDb = {
  ...UNTOUCHABLE_DB,
  withTenant: (tenantId, fn) =>
    fn({ kind: 'tenant', tenantId, schema: 'people', query: () => Promise.reject(new Error('unexpected statement')), onCommit: () => undefined }),
};
/** A repository that holds no address and fails on any other use. */
const ADDRESSLESS_REPO = new Proxy({} as PeopleRepository, {
  get: (_target, key) => {
    if (key === 'findAddress' || key === 'findAddressForUpdate') return () => Promise.resolve(null);
    throw new Error(`unexpected repository use: ${String(key)}`);
  },
});

describe('ADDRESS_DEFAULTS', () => {
  it('holds the addressBean.init values with an empty extendSetID', () => {
    expect(ADDRESS_DEFAULTS).toEqual({
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
      errors: {},
      extenddatatable: 'tclassextenddatauseractivity',
      isnew: 0,
      type: 'Address',
      subtype: 'Default',
      extendsetid: '',
    });
    expect([Object.isFrozen(ADDRESS_DEFAULTS), Object.isFrozen(ADDRESS_DEFAULTS.errors)]).toEqual([true, true]);
  });
});

describe('applyAddressInput', () => {
  const current = bean({ siteid: 'tenant-a' });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['trims simple values and keeps other keys', { city: ' Oslo\t', note: ' x ' }, { city: 'Oslo', note: 'x' }],
    ['makes numbers text', { zip: 150, longitude: 10.5 }, { zip: '150', longitude: '10.5' }],
    ['takes trimmed numeric text for isPrimary, longitude and latitude', { isprimary: ' 1 ', latitude: '-33.9' }, { isprimary: '1', latitude: '-33.9' }],
    ['ignores non-numeric isPrimary, longitude and latitude', { isprimary: 'yes', longitude: 'east', latitude: '' }, { isprimary: 0, longitude: 0, latitude: 0 }],
    ['ignores a siteid equal ignoring case, and an empty type', { siteid: 'TENANT-A', type: '' }, { siteid: 'tenant-a', type: 'Address' }],
    ['sets a differing siteid and subtype trimmed', { siteid: ' tenant-b ', subtype: ' Office ' }, { siteid: 'tenant-b', subtype: 'Office' }],
    ['takes a struct errors value', { errors: { city: 'required' } }, { errors: { city: 'required' } }],
    ['ignores a simple errors value', { errors: 'none' }, { errors: {} }],
    ['keeps complex values untrimmed', { tags: [' a '], geo: { lat: ' 1 ' } }, { tags: [' a '], geo: { lat: ' 1 ' } }],
  ])('%s', (_label, params, expected) => {
    expect(applyAddressInput(current, normaliseParams(params))).toMatchObject(expected);
  });

  it('keeps a posted __proto__ as a data key', () => {
    const values = applyAddressInput(current, normaliseParams(JSON.parse('{"__proto__": {"polluted": 1}}') as Record<string, unknown>));
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('leaves the current values unchanged', () => {
    const before = structuredClone(current);
    applyAddressInput(current, normaliseParams({ city: 'Oslo', siteid: 'tenant-b', errors: { a: 'b' } }));
    expect(current).toEqual(before);
  });

  it('throws for a complex siteid', () => {
    expect(() => applyAddressInput(current, normaliseParams({ siteid: { id: 'tenant-b' } }))).toThrow(new TypeError('The siteid value is not a simple value'));
  });

  it.each<[string, Record<string, unknown>, string | undefined, string]>([
    ['moves to the pool site with a siteid and isPublic', { siteid: 'tenant-a', ispublic: '1' }, 'umbrella', 'umbrella'],
    ['moves to the pool site after the posted siteid', { siteid: 'tenant-b', isPublic: '0' }, 'tenant-a', 'tenant-a'],
    ['ignores the pool site without isPublic', { siteid: 'tenant-b' }, 'umbrella', 'tenant-b'],
    ['ignores the pool site for a NULL isPublic', { siteid: 'tenant-b', ispublic: null }, 'umbrella', 'tenant-b'],
    ['ignores the pool site for a blank isPublic', { siteid: 'tenant-b', ispublic: ' ' }, 'umbrella', 'tenant-b'],
    ['ignores the pool site for a blank siteid', { siteid: ' ', ispublic: '1' }, 'umbrella', ''],
    ['ignores a pool site equal ignoring case', { siteid: 'UMBRELLA', ispublic: '1' }, 'umbrella', 'UMBRELLA'],
    ['sets no pool site when none is resolved', { siteid: 'tenant-b', ispublic: '1' }, undefined, 'tenant-b'],
  ])('%s', (_label, params, poolSite, siteid) => {
    expect(bean(params, poolSite).siteid).toBe(siteid);
  });
});

describe('resolveAddressPoolSite without the pool rule', () => {
  it.each<[string, Record<string, unknown>]>([
    ['no isPublic', { siteid: 'tenant-a' }],
    ['no siteid', { ispublic: '0' }],
    ['a NULL siteid', { siteid: null, ispublic: '1' }],
    ['a blank siteid', { siteid: ' \t', ispublic: '1' }],
    ['a blank isPublic', { siteid: 'tenant-a', ispublic: '' }],
  ])('answers undefined without a registry read for %s', async (_label, params) => {
    await expect(resolveAddressPoolSite(UNTOUCHABLE_DB, A, normaliseParams(params))).resolves.toBeUndefined();
  });
});

describe('primaryAddressFor', () => {
  it('answers undefined for a user restored from the trash', () => {
    expect(primaryAddressFor('U1', normaliseParams({ fromMuraTrash: 'true', city: 'Oslo' }))).toBeUndefined();
  });

  it('makes a new primary address named Primary for the user', () => {
    const values = primaryAddressFor('U1', normaliseParams({ userid: 'OTHER', city: ' Oslo ', isprimary: '0' }));
    expect(values).toMatchObject({ userid: 'U1', isprimary: 1, addressname: 'Primary', city: 'Oslo', siteid: '' });
    expect(values?.addressid).toMatch(CF_UUID);
  });

  it('keeps a posted addressid and addressname and takes the pool site', () => {
    const values = primaryAddressFor('U1', normaliseParams({ addressid: ' A1 ', addressname: 'Home', siteid: 'tenant-a', ispublic: '1' }), 'umbrella');
    expect(values).toMatchObject({ addressid: 'A1', userid: 'U1', isprimary: 1, addressname: 'Home', siteid: 'umbrella' });
  });
});

describe('address save refusals', () => {
  it.each(SAVES.flatMap(([name, save]) => ['', 'SET-1'].map((extendSetId) => [name, save, extendSetId] as const)))(
    '%s refuses a posted extendSetID %j before any read or write',
    async (_name, save, extendSetId) => {
      const { deps, fenced } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO);
      const error = await rejection(save(deps, A, normaliseParams({ userid: 'U1', addressid: 'A1', extendSetID: extendSetId }), ACTOR_A));
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(error).toMatchObject({ message: 'Address extended data is saved by legacy', surface: 'auto', reason: 'address-extdata-withheld' });
      expect(fenced).toEqual([]);
    },
  );

  it('saveAddress refuses extendSetID before it looks up the stored owner', async () => {
    const { deps } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO);
    const error = await rejection(saveAddress(deps, A, normaliseParams({ addressid: 'A1', extendsetid: '' }), ACTOR_A));
    expect(error).toMatchObject({ reason: 'address-extdata-withheld' });
  });

  it.each<[string, AddressSave, Record<string, unknown>]>([
    ['createAddress', createAddress, {}],
    ['createAddress', createAddress, { userid: '', extendsetid: '' }],
    ['updateAddress', updateAddress, { addressid: 'A1' }],
    ['updateAddress', updateAddress, { userid: '', addressid: 'A1', extendsetid: '' }],
    ['saveAddress', saveAddress, { userid: '' }],
    ['saveAddress', saveAddress, { userid: ' \t', addressid: 'A1' }],
  ])('%s throws the USERID-required error for %j', async (_name, save, params) => {
    const { deps, fenced } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO);
    const error = await rejection(save(deps, A, normaliseParams(params), ACTOR_A));
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toMatchObject({ message: USER_ID_REQUIRED });
    expect(fenced).toEqual([]);
  });

  it.each(SAVES)('%s fences the trimmed owner inside its transaction before any write', async (_name, save) => {
    const busy = new Error('roster operation open');
    const { deps, fenced } = harness(STATEMENTLESS_DB, ADDRESSLESS_REPO, busy);
    await expect(save(deps, A, normaliseParams({ userid: ' U1 ', addressid: 'A1' }), ACTOR_A)).rejects.toBe(busy);
    expect(fenced).toEqual([[A, 'U1']]);
  });
});
