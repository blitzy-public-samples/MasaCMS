/** Masa addressBean shaping and the userManager address saves over a throwaway `people` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  fixedClock,
  pgAvailable,
  seedRegistry,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import {
  ADDRESS_DEFAULTS,
  applyAddressInput,
  createAddress,
  insertAddressInTx,
  listAddresses,
  primaryAddressFor,
  resolveAddressPoolSite,
  saveAddress,
  setPrimaryAddress,
  updateAddress,
  updateAddressInTx,
  type AddressActor,
  type AddressDeps,
  type AddressValues,
} from '../../src/domain/addresses.js';
import { normaliseParams } from '../../src/domain/person.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type AddressRow, type PersonRow } from '../../src/repo/tables.js';

const CLOCK = fixedClock(new Date(2026, 5, 30, 10, 0, 0, 0));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const USER_ID_REQUIRED = "The attribute 'USERID' is required when saving an address.";
const A = TENANT_A.tenantId;

type AddressSave = typeof createAddress;
const SAVES: readonly [string, AddressSave][] = [
  ['createAddress', createAddress],
  ['updateAddress', updateAddress],
  ['saveAddress', saveAddress],
];

/** A fresh bean with posted `params` set. */
function bean(params: Record<string, unknown>, poolSite?: string): AddressValues {
  return applyAddressInput({ ...ADDRESS_DEFAULTS, errors: {} }, normaliseParams(params), poolSite);
}

/** The error `outcome` rejects with. */
async function rejection(outcome: Promise<unknown>): Promise<unknown> {
  try {
    await outcome;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Save collaborators whose `awaitPersonOpen` records each wait, then resolves or rejects with `refusal`. */
function harness(db: TenantDb, repo: PeopleRepository, refusal?: Error): { deps: AddressDeps; waits: [string, string][] } {
  const waits: [string, string][] = [];
  const deps: AddressDeps = {
    db,
    repo,
    clock: CLOCK,
    awaitPersonOpen: (waitDb, tenantId, userId, opts) => {
      if (waitDb !== db || opts.clock !== CLOCK) return Promise.reject(new Error('awaitPersonOpen got foreign collaborators'));
      waits.push([tenantId, userId]);
      return refusal === undefined ? Promise.resolve() : Promise.reject(refusal);
    },
  };
  return { deps, waits };
}

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
const ACTOR_A: AddressActor = { tid: A, write: { actorUserId: 'ACTOR', requestId: 'REQ-1' } };

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
      const { deps, waits } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO);
      const error = await rejection(save(deps, A, normaliseParams({ userid: 'U1', addressid: 'A1', extendSetID: extendSetId }), ACTOR_A));
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(error).toMatchObject({ message: 'Address extended data is saved by legacy', surface: 'auto', reason: 'address-extdata-withheld' });
      expect(waits).toEqual([]);
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
    const { deps, waits } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO);
    const error = await rejection(save(deps, A, normaliseParams(params), ACTOR_A));
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toMatchObject({ message: USER_ID_REQUIRED });
    expect(waits).toEqual([]);
  });

  it.each(SAVES)('%s waits out an open roster operation on the trimmed owner before its transaction', async (_name, save) => {
    const busy = new Error('roster operation open');
    const { deps, waits } = harness(UNTOUCHABLE_DB, UNTOUCHABLE_REPO, busy);
    await expect(save(deps, A, normaliseParams({ userid: ' U1 ', addressid: 'A1' }), ACTOR_A)).rejects.toBe(busy);
    expect(waits).toEqual([[A, 'U1']]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('addresses against PostgreSQL', () => {
  // Registered sites whose user pool ids are NULL and '' respectively.
  const NULL_POOL_SITE = 'tenant-c';
  const EMPTY_POOL_SITE = 'tenant-d';
  let handle: ThrowawaySchema | undefined;
  let db: TenantDb;
  let schema: string;
  let repo: PeopleRepository;

  beforeAll(async () => {
    const created = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    handle = created;
    db = created.app;
    schema = created.schema;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'addresses-domain-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'addresses-domain-test', state: 'open' });
    await seedRegistry(db);
    await withMetadata(db, async (tx) => {
      const sql =
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, public_user_pool_id, private_user_pool_id, aggregate_version, updated_at)` +
        ' VALUES ($1, $2, $3, $3, 1, LOCALTIMESTAMP(3))';
      await tx.query(sql, [NULL_POOL_SITE, tenantIdForSite(NULL_POOL_SITE), null]);
      await tx.query(sql, [EMPTY_POOL_SITE, tenantIdForSite(EMPTY_POOL_SITE), '']);
    });
    repo = createPeopleRepository({ clock: CLOCK, schema });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = A): Promise<T> {
    return db.withTenant(tenant, fn);
  }

  function personInput(siteid: string): PersonInput {
    return {
      userid: cfUuid(),
      groupname: '',
      fname: 'Pat',
      lname: 'Lee',
      email: 'pat@example.com',
      company: '',
      jobtitle: '',
      mobilephone: '',
      website: '',
      subtype: 'Default',
      contactform: '',
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
      siteid,
      subscribe: 1,
      notes: '',
      description: '',
      interests: '',
      keepprivate: 0,
      photofileid: '',
      imname: '',
      imservice: '',
      tags: '',
    };
  }

  function addPerson(siteid = 'tenant-a', tenant = A): Promise<PersonRow> {
    return inTenant((tx) => repo.insertPerson(tx, personInput(siteid)), tenant);
  }

  /** The `user_address` changelog rows of tenant A, in write order. */
  function addressChanges(): Promise<{ op: string; actor_user_id: string | null; request_id: string | null }[]> {
    const sql = `SELECT op, actor_user_id, request_id FROM ${schema}.changelog WHERE "table" = 'user_address' ORDER BY seq`;
    return inTenant(async (tx) => (await tx.query(sql)).rows as { op: string; actor_user_id: string | null; request_id: string | null }[]);
  }

  function findAddress(addressId: string): Promise<AddressRow | null> {
    return inTenant((tx) => repo.findAddress(tx, addressId));
  }

  /** Expects `outcome` to answer the 503 for `userId`, which is no person of the tenant. */
  async function expectOwnerUnknown(outcome: Promise<unknown>, userId: string): Promise<void> {
    const error = await rejection(outcome);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ message: `User ${userId} is not a person of this tenant`, surface: 'auto', reason: 'address-owner-unknown' });
  }

  describe('the DAO writes and reads', () => {
    it('inserts as userDAO.createAddress, with NULL for empty text and isPrimary truncated', async () => {
      const addressid = cfUuid();
      const userid = cfUuid();
      const values = bean({ addressid, userid, siteid: 'tenant-a', city: 'Oslo', zip: '', phone: null, isprimary: '1.9', longitude: '10.75', latitude: -59.5 });
      const row = await inTenant((tx) => insertAddressInTx(repo, tx, values, ACTOR_A.write));
      expect(row).toMatchObject({
        addressid,
        userid,
        siteid: 'tenant-a',
        addressname: null,
        address1: null,
        address2: null,
        city: 'Oslo',
        state: null,
        zip: null,
        country: null,
        phone: null,
        fax: null,
        isprimary: 1,
        addressnotes: null,
        addressurl: null,
        longitude: 10.75,
        latitude: -59.5,
        addressemail: null,
        hours: null,
      });
      expect((await addressChanges()).at(-1)).toEqual({ op: 'insert', actor_user_id: 'ACTOR', request_id: 'REQ-1' });
    });

    it('rejects a complex text value, writing nothing', async () => {
      const addressid = cfUuid();
      const outcome = inTenant((tx) => insertAddressInTx(repo, tx, bean({ addressid, userid: cfUuid(), city: { name: 'Oslo' } })));
      await expect(outcome).rejects.toThrow(new TypeError('The city value is not a simple value'));
      expect(await findAddress(addressid)).toBeNull();
    });

    it('updates as userDAO.updateAddress, writing the trimmed site text and keeping isPrimary', async () => {
      const addressid = cfUuid();
      const userid = cfUuid();
      await inTenant((tx) => insertAddressInTx(repo, tx, bean({ addressid, userid, siteid: 'tenant-a', city: 'Oslo', isprimary: 1 })));
      const patch = bean({ addressid, userid, city: '', zip: '0150', isprimary: 0, longitude: '5' });
      const updated = await inTenant((tx) => updateAddressInTx(repo, tx, patch, ACTOR_A.write));
      expect(updated).toMatchObject({ addressid, userid, siteid: '', city: null, zip: '0150', isprimary: 1, longitude: 5, latitude: 0 });
      expect(await findAddress(addressid)).toEqual(updated);
    });

    it('answers null updating an unknown id, writing nothing', async () => {
      const before = (await addressChanges()).length;
      const patch = bean({ addressid: cfUuid(), userid: cfUuid(), city: 'Oslo' });
      expect(await inTenant((tx) => updateAddressInTx(repo, tx, patch))).toBeNull();
      expect(await addressChanges()).toHaveLength(before);
    });

    it('sets the only primary address, which lists first', async () => {
      const userid = cfUuid();
      const ids: string[] = [];
      for (const isprimary of [1, 0, 0]) {
        ids.push((await inTenant((tx) => insertAddressInTx(repo, tx, bean({ addressid: cfUuid(), userid, isprimary })))).addressid);
      }
      const [was = '', other = '', chosen = ''] = ids;
      await inTenant((tx) => setPrimaryAddress(repo, tx, userid, chosen, ACTOR_A.write));
      const listed = await inTenant((tx) => listAddresses(repo, tx, userid));
      expect(listed.map((row) => [row.addressid, row.isprimary])).toEqual([[chosen, 1], ...[was, other].sort().map((id) => [id, 0])]);
      expect(await inTenant((tx) => listAddresses(repo, tx, cfUuid()))).toEqual([]);
    });
  });

  describe('resolveAddressPoolSite with a seeded registry', () => {
    it.each<[string, string, Record<string, unknown>, string]>([
      ['the private user pool for isPublic 0', A, { siteid: 'tenant-a', ispublic: '0' }, 'tenant-a'],
      ['the public user pool for isPublic 1', A, { siteid: 'tenant-a', ispublic: '1' }, 'umbrella'],
      ['the public user pool for non-numeric isPublic', A, { siteid: 'tenant-a', ispublic: 'x' }, 'umbrella'],
      ['the private user pool for a JSON number 0', A, { siteid: 'tenant-a', ispublic: 0 }, 'tenant-a'],
      ['the public user pool for a JSON number 1', A, { siteid: 'tenant-a', ispublic: 1 }, 'umbrella'],
      ['the pool of the token tenant, not the posted site', TENANT_B.tenantId, { siteid: 'tenant-a', ispublic: '1' }, 'tenant-b'],
      ['the site for a NULL public pool', tenantIdForSite(NULL_POOL_SITE), { siteid: NULL_POOL_SITE, ispublic: '1' }, NULL_POOL_SITE],
      ['the site for a NULL private pool', tenantIdForSite(NULL_POOL_SITE), { siteid: NULL_POOL_SITE, ispublic: '0' }, NULL_POOL_SITE],
      ['the site for an empty public pool', tenantIdForSite(EMPTY_POOL_SITE), { siteid: EMPTY_POOL_SITE, ispublic: '1' }, EMPTY_POOL_SITE],
      ['the site for an empty private pool', tenantIdForSite(EMPTY_POOL_SITE), { siteid: EMPTY_POOL_SITE, ispublic: '0' }, EMPTY_POOL_SITE],
    ])('answers %s', async (_label, tid, params, expected) => {
      await expect(resolveAddressPoolSite(db, tid, normaliseParams(params))).resolves.toBe(expected);
    });

    it('answers service unavailable for a tenant without a registry entry', async () => {
      const unregistered = tenantIdForSite('tenant-unregistered');
      const error = await rejection(resolveAddressPoolSite(db, unregistered, normaliseParams({ siteid: 'tenant-a', ispublic: '1' })));
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(error).toMatchObject({ message: `Tenant ${unregistered} has no site registry entry`, surface: 'auto', reason: 'tenant-unregistered' });
    });
  });

  describe('createAddress', () => {
    it('inserts at the owner site under a new id after waiting out the owner', async () => {
      const person = await addPerson();
      const { deps, waits } = harness(db, repo);
      const params = { userID: ` ${person.userid} `, siteid: 'tenant-b', city: ' Oslo ', isPrimary: '1' };
      const result = await createAddress(deps, A, normaliseParams(params), ACTOR_A);
      expect(result.address).toMatchObject({ userid: person.userid, siteid: 'tenant-a', city: 'Oslo', isprimary: 1, addressname: null });
      expect(result.address?.addressid).toMatch(CF_UUID);
      expect(result.values).toMatchObject({ addressid: result.address?.addressid, userid: person.userid, siteid: 'tenant-a' });
      expect(waits).toEqual([[A, person.userid]]);
      expect((await addressChanges()).at(-1)).toEqual({ op: 'insert', actor_user_id: 'ACTOR', request_id: 'REQ-1' });
    });

    it('keeps a posted addressid', async () => {
      const person = await addPerson();
      const addressid = cfUuid();
      const result = await createAddress(harness(db, repo).deps, A, normaliseParams({ userid: person.userid, addressid }), ACTOR_A);
      expect(result.address).toMatchObject({ addressid, userid: person.userid });
      expect(await findAddress(addressid)).toEqual(result.address);
    });

    it('keeps the public pool site for an owner without a site', async () => {
      const person = await addPerson('', TENANT_UMBRELLA.tenantId);
      const input = normaliseParams({ userid: person.userid, siteid: 'tenant-a', ispublic: '1' });
      const result = await createAddress(harness(db, repo).deps, TENANT_UMBRELLA.tenantId, input, ACTOR_A);
      expect(result.address).toMatchObject({ userid: person.userid, siteid: 'umbrella' });
    });

    it.each<[string, Record<string, unknown>, number]>([
      ['takes a restored address out of the trash', { fromMuraTrash: 'true' }, 0],
      ['leaves the trash row of an address not restored', {}, 1],
    ])('%s', async (_label, extra, remaining) => {
      const person = await addPerson();
      const addressid = cfUuid();
      await inTenant((tx) =>
        repo.insertTrashIfAbsent(tx, {
          objectid: addressid,
          parentid: person.userid,
          siteid: 'tenant-a',
          objectlabel: 'Home',
          objectclass: 'address',
          objecttype: 'Address',
          objectsubtype: 'Default',
          objectstring: '',
          deleteddate: CLOCK.now(),
          deletedby: 'Ada Admin',
          deleteid: cfUuid(),
          orderno: 1,
        }),
      );
      await createAddress(harness(db, repo).deps, A, normaliseParams({ userid: person.userid, addressid, ...extra }), ACTOR_A);
      const sql = `SELECT objectid FROM ${schema}.trash WHERE objectid = $1`;
      expect(await inTenant(async (tx) => (await tx.query(sql, [addressid])).rows)).toHaveLength(remaining);
    });

    it.each<[string, () => Promise<string>]>([
      ['an unknown user', () => Promise.resolve(cfUuid())],
      ['a person of another tenant', async () => (await addPerson('tenant-b', TENANT_B.tenantId)).userid],
      ['a blank userid', () => Promise.resolve(' ')],
    ])('answers 503 for %s, writing nothing', async (_label, owner) => {
      const userid = await owner();
      const before = (await addressChanges()).length;
      await expectOwnerUnknown(createAddress(harness(db, repo).deps, A, normaliseParams({ userid, city: 'Oslo' }), ACTOR_A), userid.trim());
      expect(await addressChanges()).toHaveLength(before);
    });
  });

  describe('updateAddress', () => {
    it('creates without a posted addressid, waiting once', async () => {
      const person = await addPerson();
      const { deps, waits } = harness(db, repo);
      const result = await updateAddress(deps, A, normaliseParams({ userid: person.userid, addressid: '', city: 'Bergen' }), ACTOR_A);
      expect(result.address).toMatchObject({ userid: person.userid, siteid: 'tenant-a', city: 'Bergen' });
      expect(result.address?.addressid).toMatch(CF_UUID);
      expect(waits).toEqual([[A, person.userid]]);
    });

    it('applies the posted values over the stored address at the owner site, keeping isPrimary', async () => {
      const person = await addPerson();
      const { deps } = harness(db, repo);
      const created = await createAddress(deps, A, normaliseParams({ userid: person.userid, city: 'Oslo', zip: '0150', addressname: 'Home', isprimary: '1' }), ACTOR_A);
      const stored = created.address as AddressRow;
      const params = { userid: person.userid, addressid: stored.addressid, city: 'Bergen', isprimary: '0', siteid: 'tenant-b' };
      const result = await updateAddress(deps, A, normaliseParams(params), ACTOR_A);
      expect(result.address).toEqual({ ...stored, city: 'Bergen' });
      expect(result.values).toMatchObject({ isprimary: '0', city: 'Bergen', zip: '0150', addressname: 'Home', siteid: 'tenant-a' });
      expect((await addressChanges()).at(-1)).toEqual({ op: 'update', actor_user_id: 'ACTOR', request_id: 'REQ-1' });
    });

    it('keeps the stored site for an owner without a site', async () => {
      const person = await addPerson('', TENANT_UMBRELLA.tenantId);
      const { deps } = harness(db, repo);
      const input = normaliseParams({ userid: person.userid, siteid: 'tenant-a', ispublic: '1' });
      const stored = (await createAddress(deps, TENANT_UMBRELLA.tenantId, input, ACTOR_A)).address as AddressRow;
      const update = normaliseParams({ userid: person.userid, addressid: stored.addressid, city: 'Bergen' });
      const result = await updateAddress(deps, TENANT_UMBRELLA.tenantId, update, ACTOR_A);
      expect(result.address).toEqual({ ...stored, siteid: 'umbrella', city: 'Bergen' });
    });

    it.each<[string, () => Promise<string>]>([
      ['a person owner', async () => (await addPerson()).userid],
      ['an unknown owner', () => Promise.resolve(cfUuid())],
    ])('writes nothing for a missing address id with %s', async (_label, owner) => {
      const userid = await owner();
      const addressid = cfUuid();
      const before = (await addressChanges()).length;
      const result = await updateAddress(harness(db, repo).deps, A, normaliseParams({ userid, addressid, city: 'Oslo' }), ACTOR_A);
      expect(result.address).toBeNull();
      expect(result.values).toMatchObject({ addressid, userid, city: 'Oslo' });
      expect(await findAddress(addressid)).toBeNull();
      expect(await addressChanges()).toHaveLength(before);
    });

    it('answers 503 moving a stored address to an owner who is no person, keeping the row', async () => {
      const person = await addPerson();
      const { deps } = harness(db, repo);
      const stored = (await createAddress(deps, A, normaliseParams({ userid: person.userid, city: 'Oslo' }), ACTOR_A)).address as AddressRow;
      const stranger = cfUuid();
      await expectOwnerUnknown(updateAddress(deps, A, normaliseParams({ userid: stranger, addressid: stored.addressid, city: 'Bergen' }), ACTOR_A), stranger);
      expect(await findAddress(stored.addressid)).toEqual(stored);
    });
  });

  describe('saveAddress', () => {
    it('creates an unknown id under that id', async () => {
      const person = await addPerson();
      const addressid = cfUuid();
      const result = await saveAddress(harness(db, repo).deps, A, normaliseParams({ userid: person.userid, addressid, city: 'Oslo' }), ACTOR_A);
      expect(result.address).toMatchObject({ addressid, userid: person.userid, siteid: 'tenant-a', city: 'Oslo', isprimary: 0 });
    });

    it('creates under a new id without a posted addressid', async () => {
      const person = await addPerson();
      const result = await saveAddress(harness(db, repo).deps, A, normaliseParams({ userid: person.userid }), ACTOR_A);
      expect(result.address?.addressid).toMatch(CF_UUID);
      expect(await findAddress(result.address?.addressid ?? '')).toEqual(result.address);
    });

    it('updates a stored id as its stored owner without a posted userid', async () => {
      const person = await addPerson();
      const stored = (await saveAddress(harness(db, repo).deps, A, normaliseParams({ userid: person.userid, city: 'Oslo', zip: '0150' }), ACTOR_A))
        .address as AddressRow;
      const { deps, waits } = harness(db, repo);
      const result = await saveAddress(deps, A, normaliseParams({ addressid: stored.addressid, city: 'Bergen' }), ACTOR_A);
      expect(result.address).toEqual({ ...stored, city: 'Bergen' });
      expect(waits).toEqual([[A, person.userid]]);
    });

    it.each<[string, () => Record<string, unknown>]>([
      ['no addressid', () => ({ city: 'Oslo' })],
      ['an unknown addressid', () => ({ addressid: cfUuid(), city: 'Oslo' })],
    ])('throws the USERID-required error without a posted or stored owner for %s', async (_label, params) => {
      const { deps, waits } = harness(db, repo);
      const before = (await addressChanges()).length;
      const error = await rejection(saveAddress(deps, A, normaliseParams(params()), ACTOR_A));
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect(error).toMatchObject({ message: USER_ID_REQUIRED });
      expect(waits).toEqual([]);
      expect(await addressChanges()).toHaveLength(before);
    });

    it('answers 503 creating for an owner who is no person, writing nothing', async () => {
      const stranger = cfUuid();
      const before = (await addressChanges()).length;
      await expectOwnerUnknown(saveAddress(harness(db, repo).deps, A, normaliseParams({ userid: stranger }), ACTOR_A), stranger);
      expect(await addressChanges()).toHaveLength(before);
    });

    it('answers 503 saving a stored address for an owner who is no person, keeping the row', async () => {
      const person = await addPerson();
      const { deps } = harness(db, repo);
      const stored = (await saveAddress(deps, A, normaliseParams({ userid: person.userid, city: 'Oslo' }), ACTOR_A)).address as AddressRow;
      const stranger = cfUuid();
      await expectOwnerUnknown(saveAddress(deps, A, normaliseParams({ userid: stranger, addressid: stored.addressid, city: 'Bergen' }), ACTOR_A), stranger);
      expect(await findAddress(stored.addressid)).toEqual(stored);
    });
  });
});
