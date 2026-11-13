/** The roster protocol's per-user fence over a throwaway `people` schema: fenced address saves and archive reads and writes against open operations, intents and rollbacks. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { OperationBlockedError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError, fixedClock, type Clock } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createCapturingPublisher, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { createAddress, saveAddress, updateAddress, type AddressActor, type AddressDeps } from '../../src/domain/addresses.js';
import { archivePerson, getPersonArchive, type ArchiveDeps } from '../../src/domain/archive.js';
import { createFaultHooks } from '../../src/domain/faults.js';
import type { PersonFence } from '../../src/domain/person-fence.js';
import { normaliseParams } from '../../src/domain/person.js';
import {
  IDENTITY_OPERATION_UNITS,
  PEOPLE_OPERATION_UNITS,
  PersonClosedSignal,
  REQUEST_BUDGET_MS,
  USER_CLOSED_WAIT_MS,
  fencePersons,
  personFence,
  restoreBeforeImage,
  runRosterOperation,
  withPersonsOpen,
  type RosterDeps,
  type RosterInput,
} from '../../src/domain/roster-protocol.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountOperationState, AccountView, IdentityClient } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type AddressRow, type RosterOperationRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const ACTOR: AddressActor = { tid: A, write: { actorUserId: 'ACTOR', requestId: 'REQ-1' } };
const ARCHIVER = { userId: 'ACTOR', fname: 'Ada', lname: 'Admin', isLoggedIn: true };
const instant = (): Promise<void> => Promise.resolve();

/** A clock that moves `stepMs` on at every reading. */
function advancingClock(stepMs: number): Clock {
  let at = NOW.getTime();
  return {
    now: () => {
      at += stepMs;
      return new Date(at);
    },
  };
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

/** A promise with its resolver. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** Identity's account of a private user of tenant A. */
function accountOf(userId: string): AccountView {
  return { userId, siteId: SITE, username: 'robin', s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null, lastLogin: null, passwordCreated: null, tablist: null };
}

/** An identity double whose commit is unreachable, so a roster save that reaches it rolls back; `calls` records each call. */
function failingCommitIdentity(accounts: ReadonlyMap<string, AccountView>): { client: IdentityClient; calls: string[] } {
  const calls: string[] = [];
  const states = new Map<string, AccountOperationState>();
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
  const client: IdentityClient = {
    prepare(userId, operationId, change) {
      calls.push('prepare');
      states.set(operationId, 'prepared');
      return Promise.resolve({ ok: true, operationId, userId, kind: change.kind, state: 'prepared' });
    },
    commit() {
      calls.push('commit');
      return Promise.reject(new ServiceUnavailableError('identity', new Error('identity down')));
    },
    abort(_userId, operationId) {
      calls.push('abort');
      states.set(operationId, 'aborted');
      return Promise.resolve();
    },
    operationState(_userId, operationId) {
      calls.push('state');
      return Promise.resolve(states.get(operationId));
    },
    readAccount(userId) {
      calls.push('readAccount');
      return Promise.resolve(accounts.get(userId));
    },
    membershipGroupIds() {
      calls.push('memberships');
      return Promise.resolve([]);
    },
    finish: unused('finish'),
    revert: unused('revert'),
    readAccounts: unused('readAccounts'),
    userMemberships: unused('userMemberships'),
    siteGroups: unused('siteGroups'),
    userGroups: unused('userGroups'),
    actingUser: unused('actingUser'),
    adminSessionState: unused('adminSessionState'),
    saveAdminSessionState: unused('saveAdminSessionState'),
    sessionSites: unused('sessionSites'),
  };
  return { client, calls };
}

/** Claims of the site administrator saving through the roster protocol. */
const ROSTER_CLAIMS: UserClaims = { iss: 'opt2-local-identity', aud: 'opt2-local', sub: 'ACTOR', sid: 'SESSION-1', tid: A, site: SITE, roles: ['site-admin'], s2: false, epoch: 1, iat: 0, exp: 4_102_444_800 };

/** The admin update of `userId` posting the address `addressId`, which moves that address to the user. */
function movingUpdate(userId: string, addressId: string): RosterInput {
  const params = { userid: userId, siteid: SITE, type: '2', action: 'Update', fname: 'Robin', email: 'robin@example.com', username: 'robin', ispublic: '0', addressid: addressId, city: 'Roster' };
  return { kind: 'admin-update', tenantId: A, claims: ROSTER_CLAIMS, acting: { userId: 'ACTOR', fname: 'Ada', lname: 'Admin' }, params: normaliseParams(params), postedFiles: new Map(), requestId: 'REQ-ROSTER' };
}

describe('personFence', () => {
  it('carries the protocol fence and runner', () => {
    expect(personFence).toEqual({ fencePersons, withPersonsOpen });
    expect(Object.isFrozen(personFence)).toBe(true);
  });

  it('signals a closed user as the legacy 503 it answers when unhandled', () => {
    const closed = new PersonClosedSignal('U1', 'OP-1');
    expect(closed).toBeInstanceOf(OperationBlockedError);
    expect(closed).toMatchObject({ name: 'PersonClosedSignal', userId: 'U1', operationId: 'OP-1', reason: 'operation-blocked' });
    expect(closed.message).toBe('Roster operation OP-1 keeps user U1 closed');
    expect(closed.units).toEqual([...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('roster fence against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'roster-fence-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'roster-fence-test', state: 'open' });
    await seedRegistry(db);
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'people', db, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
  });

  afterAll(async () => {
    await handle.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(A, fn);
  }

  /** The protocol fence whose waits run on `clock` and `sleep`. */
  function fenceOn(sleep: (ms: number) => Promise<unknown>, clock: Clock = CLOCK): PersonFence {
    return { fencePersons, withPersonsOpen: (fenceDb, tenantId, fn, opts) => withPersonsOpen(fenceDb, tenantId, fn, { ...opts, clock, sleep }) };
  }

  function addressDeps(fence: PersonFence, addressRepo: PeopleRepository = repo): AddressDeps {
    return { db, repo: addressRepo, clock: CLOCK, fence };
  }

  function archiveDeps(fence: PersonFence): ArchiveDeps {
    return { db, repo, events: createPeopleEvents(repo), clock: CLOCK, fence };
  }

  function personInput(userId: string): PersonInput {
    return {
      userid: userId,
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
      lastupdateby: 'Pat Lee',
      lastupdatebyid: userId,
      siteid: SITE,
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

  /** A person of tenant A with one address in Oslo, archived from 2026-01-01 when `archived`. */
  async function seedPerson(archived = false): Promise<{ userId: string; addressId: string }> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await inTenant(async (tx) => {
      await repo.insertPerson(tx, personInput(userId));
      await repo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: SITE, city: 'Oslo', isprimary: 1 });
      if (archived) {
        await repo.insertPersonArchive(tx, { person_id: userId, siteid: SITE, effective_from: new Date(2026, 0, 1), archived_by_id: null, archived_by: null });
      }
    });
    return { userId, addressId };
  }

  function openOperation(userId: string): Promise<RosterOperationRow> {
    return inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
  }

  function endOperation(operationId: string, state: 'done' | 'rolled-back' = 'done'): Promise<unknown> {
    return inTenant((tx) => repo.setRosterOperationState(tx, operationId, { state }));
  }

  function addresses(userId: string): Promise<AddressRow[]> {
    return inTenant((tx) => repo.listAddresses(tx, userId));
  }

  /** The people commit of `operation` as the protocol stores it: the user's before-image, then its address `addressId` written. */
  async function commitPeople(operation: RosterOperationRow, userId: string, addressId: string): Promise<RosterOperationRow> {
    const person = await inTenant((tx) => repo.findPerson(tx, userId));
    const image = { existed: true, person, addresses: await addresses(userId), interests: [], tags: [], extendData: [] };
    const committed = await inTenant(async (tx) => {
      await repo.updateAddress(tx, addressId, { userid: userId, city: 'Roster' }, { origin: 'target', operationId: operation.operation_id });
      return repo.setRosterOperationState(tx, operation.operation_id, { state: 'people-committed', beforeImage: JSON.stringify(image) });
    });
    if (committed === null) throw new Error(`Roster operation ${operation.operation_id} is missing`);
    return committed;
  }

  /** People rows a save of `userId` may have written: its address cities and archive records. */
  async function written(userId: string): Promise<{ cities: (string | null)[]; archived: boolean }> {
    const cities = (await addresses(userId)).map((row) => row.city);
    return { cities, archived: (await inTenant((tx) => repo.findPersonArchive(tx, userId))) !== null };
  }

  /** Open transactions and held advisory locks of the schema's app role. */
  async function appHolds(): Promise<{ transactions: number; advisoryLocks: number }> {
    const sql =
      'SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE usename = $1 AND xact_start IS NOT NULL) AS transactions,' +
      " (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.usename = $1 AND l.locktype = 'advisory') AS advisory_locks";
    const [row] = (await handle.adminPool.query<{ transactions: number; advisory_locks: number }>(sql, [handle.roles.app])).rows;
    return { transactions: row?.transactions ?? -1, advisoryLocks: row?.advisory_locks ?? -1 };
  }

  /** Resolves once a transaction of the app role waits for an advisory lock. */
  async function advisoryWaiter(): Promise<void> {
    const sql = "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.locktype = 'advisory' AND a.usename = $1";
    while ((await handle.adminPool.query(sql, [handle.roles.app])).rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  type Save = (fence: PersonFence, user: { userId: string; addressId: string }) => Promise<unknown>;
  // Each save of the user's own rows, and whether its person needs an archive record first.
  const SAVES: [string, Save, boolean][] = [
    ['createAddress', (fence, { userId }) => createAddress(addressDeps(fence), A, normaliseParams({ userid: userId, city: 'Bergen' }), ACTOR), false],
    ['updateAddress', (fence, { userId, addressId }) => updateAddress(addressDeps(fence), A, normaliseParams({ userid: userId, addressid: addressId, city: 'Bergen' }), ACTOR), false],
    ['saveAddress', (fence, { addressId }) => saveAddress(addressDeps(fence), A, normaliseParams({ addressid: addressId, city: 'Bergen' }), ACTOR), false],
    ['archivePerson', (fence, { userId }) => archivePerson(archiveDeps(fence), { tenantId: A, input: { userId, effectiveFrom: '2026-07-01' }, actor: ARCHIVER }), false],
    ['getPersonArchive', (fence, { userId }) => getPersonArchive(archiveDeps(fence), { tenantId: A, userId }), true],
  ];

  it.each(SAVES)('%s answers the legacy 503 once the wait is spent, holding no transaction or lock while it waits', async (_name, save, archived) => {
    const user = await seedPerson(archived);
    const holder = await openOperation(user.userId);
    const before = await written(user.userId);
    const holds: { transactions: number; advisoryLocks: number }[] = [];
    const sleep = async (): Promise<void> => {
      holds.push(await appHolds());
    };
    const error = await rejection(save(fenceOn(sleep, advancingClock(2_500)), user));
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(error).not.toBeInstanceOf(PersonClosedSignal);
    expect(error).toMatchObject({ message: `Roster operation ${holder.operation_id} keeps user ${user.userId} closed`, units: [...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS] });
    expect(holds.length).toBeGreaterThan(0);
    expect(holds.every((held) => held.transactions === 0 && held.advisoryLocks === 0)).toBe(true);
    expect(await written(user.userId)).toEqual(before);
  });

  it.each(SAVES)('%s proceeds once the operation closing its user ends', async (name, save, archived) => {
    const user = await seedPerson(archived);
    const holder = await openOperation(user.userId);
    let polls = 0;
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls === 2) await endOperation(holder.operation_id);
    };
    await save(fenceOn(sleep), user);
    expect(polls).toBe(2);
    const expected: Record<string, { cities: string[]; archived: boolean }> = {
      createAddress: { cities: ['Oslo', 'Bergen'], archived: false },
      updateAddress: { cities: ['Bergen'], archived: false },
      saveAddress: { cities: ['Bergen'], archived: false },
      archivePerson: { cities: ['Oslo'], archived: true },
      getPersonArchive: { cities: ['Oslo'], archived: true },
    };
    const after = await written(user.userId);
    expect({ ...after, cities: [...after.cities].sort().reverse() }).toEqual(expected[name]);
  });

  it('spends the wait on the injected sleeps when the clock stands still', async () => {
    const { userId } = await seedPerson();
    await openOperation(userId);
    const slept: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    };
    const error = await rejection(withPersonsOpen(db, A, (tx) => fencePersons(tx, [userId]), { clock: CLOCK, sleep }));
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
  });

  it.each<[string, (id: string) => string]>([
    ['lower-case', (id) => id.toLowerCase()],
    ['trailing-space', (id) => `${id}  `],
  ])('closes a %s spelling of a user whose operation is stored under another, but not to that operation itself', async (_label, spell) => {
    const { userId } = await seedPerson();
    const holder = await openOperation(userId);
    const closed = await rejection(inTenant((tx) => fencePersons(tx, [cfUuid(), spell(userId)])));
    expect(closed).toBeInstanceOf(PersonClosedSignal);
    expect(closed).toMatchObject({ userId, operationId: holder.operation_id });
    await expect(inTenant((tx) => fencePersons(tx, [spell(userId)], { selfOperationId: holder.operation_id }))).resolves.toBeUndefined();
  });

  it('passes any other failure through at once', async () => {
    const failure = new Error('save failed');
    let slept = 0;
    const sleep = (): Promise<void> => {
      slept += 1;
      return Promise.resolve();
    };
    await expect(withPersonsOpen(db, A, () => Promise.reject(failure), { clock: CLOCK, sleep })).rejects.toBe(failure);
    expect(slept).toBe(0);
  });

  it('delays an intent of another spelling of the user while a fenced save is in flight, so its before-image holds the save', async () => {
    const { userId } = await seedPerson();
    const inserted = signal();
    const release = signal();
    // The save's insert holds its transaction open until released.
    const holding: PeopleRepository = {
      ...repo,
      insertAddress: async (tx, row, ctx) => {
        const stored = await repo.insertAddress(tx, row, ctx);
        inserted.resolve();
        await release.promise;
        return stored;
      },
    };
    const order: string[] = [];
    const save = createAddress(addressDeps(personFence, holding), A, normaliseParams({ userid: userId, city: 'Bergen' }), ACTOR).then((result) => {
      order.push('save');
      return result;
    });
    await inserted.promise;
    const intent = openOperation(userId.toLowerCase()).then((row) => {
      order.push('intent');
      return row;
    });
    await advisoryWaiter();
    expect(order).toEqual([]);
    release.resolve();
    const saved = (await save).address as AddressRow;
    const operation = await intent;
    expect(order).toEqual(['save', 'intent']);

    // The people commit of that operation captures the save, so rolling the operation back keeps it.
    await restoreBeforeImage({ db, repo }, A, await commitPeople(operation, userId, saved.addressid));
    await endOperation(operation.operation_id, 'rolled-back');
    expect((await addresses(userId)).map((row) => row.city).sort()).toEqual(['Bergen', 'Oslo']);
  });

  it('keeps an address save that waited out a roster rollback', async () => {
    const { userId, addressId } = await seedPerson();
    const operation = await openOperation(userId);
    const committed = await commitPeople(operation, userId, addressId);
    let polls = 0;
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls > 1) return;
      await restoreBeforeImage({ db, repo }, A, committed);
      await endOperation(operation.operation_id, 'rolled-back');
    };
    const saved = await createAddress(addressDeps(fenceOn(sleep)), A, normaliseParams({ userid: userId, city: 'Bergen' }), ACTOR);
    expect(polls).toBe(1);
    const stored = await addresses(userId);
    expect(stored.map((row) => [row.addressid, row.city])).toEqual(
      expect.arrayContaining([
        [addressId, 'Oslo'],
        [saved.address?.addressid, 'Bergen'],
      ]),
    );
    expect(stored).toHaveLength(2);
  });

  it.each<[string, 'stored' | 'posted', typeof updateAddress]>([
    ['updateAddress', 'stored', updateAddress],
    ['updateAddress', 'posted', updateAddress],
    ['saveAddress', 'stored', saveAddress],
    ['saveAddress', 'posted', saveAddress],
  ])('%s moving an address answers the legacy 503 while its %s owner is closed, keeping the row', async (_name, closedOwner, save) => {
    const from = await seedPerson();
    const to = await seedPerson();
    const closedUser = closedOwner === 'stored' ? from.userId : to.userId;
    const holder = await openOperation(closedUser);
    const stored = await inTenant((tx) => repo.findAddress(tx, from.addressId));
    const input = normaliseParams({ userid: to.userId, addressid: from.addressId, city: 'Bergen' });
    const error = await rejection(save(addressDeps(fenceOn(instant, advancingClock(2_500))), A, input, ACTOR));
    expect(error).toMatchObject({ message: `Roster operation ${holder.operation_id} keeps user ${closedUser} closed` });
    expect(await inTenant((tx) => repo.findAddress(tx, from.addressId))).toEqual(stored);
  });

  describe('a roster update moving another user\'s address', () => {
    const accounts = new Map<string, AccountView>();

    function rosterDeps(identity: IdentityClient, rosterRepo: PeopleRepository = repo): RosterDeps {
      return { db, repo: rosterRepo, events: createPeopleEvents(rosterRepo), identity, clock: CLOCK, faults: createFaultHooks({}, {}), sleep: instant };
    }

    /** The user's latest roster operation. */
    function operationOf(userId: string): Promise<RosterOperationRow | undefined> {
      return inTenant(async (tx) => {
        const { rows } = await tx.query<RosterOperationRow>(`SELECT * FROM ${handle.schema}.roster_operation WHERE user_id = $1 ORDER BY started_at DESC, operation_id`, [userId]);
        return rows[0];
      });
    }

    /** Resolves once a transaction of the app role waits for any lock, or once `done` settles. */
    async function lockWaiter(done: Promise<unknown>): Promise<void> {
      let settled = false as boolean;
      void done.finally(() => (settled = true)).catch(() => undefined);
      const sql = 'SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.usename = $1';
      while (!settled && (await handle.adminPool.query(sql, [handle.roles.app])).rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    /** `repo` whose first address update holds its transaction open until `release`, after its write when `afterWrite`, else before it. */
    function pausingRepo(afterWrite: boolean, paused: () => void, release: Promise<void>): PeopleRepository {
      let first = true;
      return {
        ...repo,
        updateAddress: async (tx, addressId, patch, ctx) => {
          const pause = first;
          first = false;
          if (pause && !afterWrite) {
            paused();
            await release;
          }
          const row = await repo.updateAddress(tx, addressId, patch, ctx);
          if (pause && afterWrite) {
            paused();
            await release;
          }
          return row;
        },
      };
    }

    it.each<[string, 'save-first' | 'roster-first', string]>([
      ['in flight as the people commit starts lands in the before-image', 'save-first', 'Bergen'],
      ['starting inside the people commit lands after the rollback', 'roster-first', 'Oslo'],
    ])('keeps a fenced save of the stored owner through the rollback: a save %s', async (_label, first, imaged) => {
      const owner = await seedPerson();
      const saver = await seedPerson();
      accounts.set(saver.userId, accountOf(saver.userId));
      const identity = failingCommitIdentity(accounts);
      const paused = signal();
      const release = signal();
      const ownSave = (saveRepo: PeopleRepository): Promise<unknown> =>
        saveAddress(addressDeps(personFence, saveRepo), A, normaliseParams({ addressid: owner.addressId, city: 'Bergen' }), ACTOR);
      const rosterSave = (rosterRepo: PeopleRepository): Promise<unknown> =>
        rejection(runRosterOperation(rosterDeps(identity.client, rosterRepo), movingUpdate(saver.userId, owner.addressId)));
      let save: Promise<unknown>;
      let roster: Promise<unknown>;
      if (first === 'save-first') {
        save = ownSave(pausingRepo(true, paused.resolve, release.promise));
        await paused.promise;
        roster = rosterSave(repo);
        await lockWaiter(roster);
      } else {
        roster = rosterSave(pausingRepo(false, paused.resolve, release.promise));
        await paused.promise;
        save = ownSave(repo);
        await lockWaiter(save);
      }
      release.resolve();
      const [error] = await Promise.all([roster, save]);
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(identity.calls).toEqual(['readAccount', 'readAccount', 'memberships', 'prepare', 'commit', 'state', 'abort']);
      const operation = await operationOf(saver.userId);
      expect(operation).toMatchObject({ state: 'rolled-back', error: 'identity-commit' });
      const image = JSON.parse(operation?.before_image ?? '{}') as { addresses: AddressRow[] };
      expect(image.addresses.find((row) => row.addressid === owner.addressId)).toMatchObject({ userid: owner.userId, city: imaged });
      expect(await inTenant((tx) => repo.findAddress(tx, owner.addressId))).toMatchObject({ userid: owner.userId, city: 'Bergen' });
      expect((await addresses(saver.userId)).map((row) => row.city)).toEqual(['Oslo']);
    });

    /** Resolves once `count` transactions of the app role wait for a lock. */
    async function lockWaiters(count: number): Promise<void> {
      const sql = 'SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.usename = $1';
      while (((await handle.adminPool.query<{ n: number }>(sql, [handle.roles.app])).rows[0]?.n ?? 0) < count) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    /** `repo` whose `method` call for `id` holds its transaction open until `release`, once, after the call returns. */
    function pausingAt(method: 'findPerson' | 'findAddressForUpdate', id: string, paused: () => void, release: Promise<void>): PeopleRepository {
      let first = true;
      const call = async (tx: TenantTx, key: string): Promise<unknown> => {
        const row = await repo[method](tx, key);
        if (first && key === id) {
          first = false;
          paused();
          await release;
        }
        return row;
      };
      return { ...repo, [method]: call };
    }

    it('restores the save its people commit waited for and keeps a later move: one address saved twice around a roster rollback', async () => {
      const [original, destination, intermediate] = [await seedPerson(), await seedPerson(), await seedPerson()];
      accounts.set(intermediate.userId, accountOf(intermediate.userId));
      const identity = failingCommitIdentity(accounts);
      const [firstPaused, firstRelease, prepared, peopleCommitted, rosterRelease] = [signal(), signal(), signal(), signal(), signal()];
      const move = (saveRepo: PeopleRepository, userid: string, city: string) =>
        saveAddress(addressDeps(personFence, saveRepo), A, normaliseParams({ addressid: original.addressId, userid, city }), ACTOR);
      // The first save holds the address once its owners are fenced, before its write.
      const first = move(pausingAt('findPerson', destination.userId, firstPaused.resolve, firstRelease.promise), destination.userId, 'Independent');
      await firstPaused.promise;
      let secondSettled = false as boolean;
      const second = move(repo, intermediate.userId, 'Intermediate').finally(() => (secondSettled = true));
      await lockWaiters(1);
      const faults = {
        async at(step: string) {
          if (step === 'after-prepare') prepared.resolve();
          if (step !== 'after-people-commit') return;
          peopleCommitted.resolve();
          await rosterRelease.promise;
        },
      };
      const roster = rejection(runRosterOperation({ ...rosterDeps(identity.client), faults }, movingUpdate(intermediate.userId, original.addressId)));
      await prepared.promise;
      await lockWaiters(2);
      expect(secondSettled).toBe(false);
      firstRelease.resolve();
      expect((await first).address).toMatchObject({ userid: destination.userId, city: 'Independent' });
      await peopleCommitted.promise;
      expect(secondSettled).toBe(false);
      rosterRelease.resolve();
      expect(await roster).toBeInstanceOf(LegacyServiceUnavailableError);
      expect((await second).address).toMatchObject({ userid: intermediate.userId, city: 'Intermediate' });
      const operation = await operationOf(intermediate.userId);
      expect(operation).toMatchObject({ state: 'rolled-back', error: 'identity-commit' });
      const image = JSON.parse(operation?.before_image ?? '{}') as { addresses: AddressRow[] };
      expect(image.addresses.find((row) => row.addressid === original.addressId)).toMatchObject({ userid: destination.userId, city: 'Independent' });
      expect(await inTenant((tx) => repo.findAddress(tx, original.addressId))).toMatchObject({ userid: intermediate.userId, city: 'Intermediate' });
    });

    it('runs saves moving one address to different users one after the other, without deadlock', async () => {
      const [from, toFirst, toSecond] = [await seedPerson(), await seedPerson(), await seedPerson()];
      const [paused, release] = [signal(), signal()];
      const order: string[] = [];
      const move = (saveRepo: PeopleRepository, userid: string, city: string) =>
        saveAddress(addressDeps(personFence, saveRepo), A, normaliseParams({ addressid: from.addressId, userid, city }), ACTOR).then((result) => {
          order.push(city);
          return result;
        });
      const first = move(pausingAt('findPerson', toFirst.userId, paused.resolve, release.promise), toFirst.userId, 'Bergen');
      await paused.promise;
      const second = move(repo, toSecond.userId, 'Tromso');
      await lockWaiters(1);
      release.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['Bergen', 'Tromso']);
      expect(await inTenant((tx) => repo.findAddress(tx, from.addressId))).toMatchObject({ userid: toSecond.userId, city: 'Tromso' });
    });

    it('runs a roster update moving an address beside a save moving its user\'s primary address the other way, without deadlock', async () => {
      const [owner, saver] = [await seedPerson(), await seedPerson()];
      accounts.set(saver.userId, accountOf(saver.userId));
      const identity = failingCommitIdentity(accounts);
      const [prepared, go, savePaused, saveRelease] = [signal(), signal(), signal(), signal()];
      const faults = {
        async at(step: string) {
          if (step !== 'after-prepare') return;
          prepared.resolve();
          await go.promise;
        },
      };
      // The update makes the moved address the saver's primary one, so its people commit also writes the saver's own address.
      const input = movingUpdate(saver.userId, owner.addressId);
      input.params.set('primaryaddressid', owner.addressId);
      const roster = rejection(runRosterOperation({ ...rosterDeps(identity.client), faults }, input));
      await prepared.promise;
      const save = saveAddress(
        addressDeps(personFence, pausingAt('findAddressForUpdate', saver.addressId, savePaused.resolve, saveRelease.promise)),
        A,
        normaliseParams({ addressid: saver.addressId, userid: owner.userId, city: 'Bergen' }),
        ACTOR,
      );
      await savePaused.promise;
      go.resolve();
      await lockWaiters(1);
      saveRelease.resolve();
      const [error, saved] = await Promise.all([roster, save]);
      expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(identity.calls).toEqual(['readAccount', 'readAccount', 'memberships', 'prepare', 'commit', 'state', 'abort']);
      expect(await operationOf(saver.userId)).toMatchObject({ state: 'rolled-back', error: 'identity-commit' });
      expect(saved.address).toMatchObject({ addressid: saver.addressId, userid: owner.userId, city: 'Bergen' });
      expect(await inTenant((tx) => repo.findAddress(tx, owner.addressId))).toMatchObject({ userid: owner.userId, city: 'Oslo' });
    });

    it.each<[number, string[], Record<string, unknown>, Record<string, unknown>]>([
      [9_000, ['abort'], { name: 'OperationBlockedError' }, { state: 'rolled-back', error: 'people-commit' }],
      [REQUEST_BUDGET_MS, [], { reason: 'roster-budget' }, { state: 'started', error: null }],
    ])('ends the people commit\'s wait for a closed stored owner within the request budget after a prepare of %i ms', async (prepareMs, after, answer, state) => {
      const owner = await seedPerson();
      const saver = await seedPerson();
      accounts.set(saver.userId, accountOf(saver.userId));
      const holder = await openOperation(owner.userId);
      const identity = failingCommitIdentity(accounts);
      let elapsed = 0;
      const client: IdentityClient = {
        ...identity.client,
        async prepare(...args) {
          const prepared = await identity.client.prepare(...args);
          elapsed += prepareMs;
          return prepared;
        },
      };
      const clock: Clock = { now: () => new Date(NOW.getTime() + elapsed) };
      const sleep = (ms: number): Promise<void> => {
        elapsed += ms;
        return Promise.resolve();
      };
      try {
        const error = await rejection(runRosterOperation({ ...rosterDeps(client), clock, sleep }, movingUpdate(saver.userId, owner.addressId)));
        expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
        expect(error).toMatchObject(answer);
        expect(elapsed).toBeLessThanOrEqual(REQUEST_BUDGET_MS);
        expect(identity.calls).toEqual(['readAccount', 'readAccount', 'memberships', 'prepare', ...after]);
        expect(await operationOf(saver.userId)).toMatchObject({ ...state, before_image: null });
      } finally {
        await endOperation(holder.operation_id);
        const left = await operationOf(saver.userId);
        if (left?.state === 'started') await endOperation(left.operation_id, 'rolled-back');
      }
    });

    it('answers the legacy 503 once the wait for an open operation of the stored owner is spent, changing nothing', async () => {
      const owner = await seedPerson();
      const saver = await seedPerson();
      accounts.set(saver.userId, accountOf(saver.userId));
      const holder = await openOperation(owner.userId);
      const moved = await inTenant((tx) => repo.findAddress(tx, owner.addressId));
      const person = await inTenant((tx) => repo.findPerson(tx, saver.userId));
      const identity = failingCommitIdentity(accounts);
      let slept = 0;
      const sleep = (): Promise<void> => {
        slept += 1;
        return Promise.resolve();
      };
      const error = await rejection(runRosterOperation({ ...rosterDeps(identity.client), sleep }, movingUpdate(saver.userId, owner.addressId)));
      expect(error).toBeInstanceOf(OperationBlockedError);
      expect(error).toMatchObject({ message: `Roster operation ${holder.operation_id} keeps user ${owner.userId} closed` });
      expect(slept).toBeGreaterThan(0);
      expect(identity.calls).toEqual(['readAccount', 'readAccount', 'memberships', 'prepare', 'abort']);
      expect(await operationOf(saver.userId)).toMatchObject({ state: 'rolled-back', error: 'people-commit', before_image: null });
      expect(await inTenant((tx) => repo.findAddress(tx, owner.addressId))).toEqual(moved);
      expect(await inTenant((tx) => repo.findPerson(tx, saver.userId))).toEqual(person);
      expect((await addresses(saver.userId)).map((row) => row.city)).toEqual(['Oslo']);
    });
  });

  describe('behind an intent that holds the user\'s roster lock while it queues for the tenant\'s', () => {
    const realClock: Clock = { now: () => new Date() };
    const timer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it.each<[string, (user: { userId: string; addressId: string }, calls: string[]) => Promise<unknown>]>([
      ['archivePerson', ({ userId }) => archivePerson({ ...archiveDeps(personFence), clock: realClock }, { tenantId: A, input: { userId, effectiveFrom: '2026-07-01' }, actor: ARCHIVER })],
      [
        'a roster save of that user',
        ({ userId, addressId }, calls) => {
          const identity = failingCommitIdentity(new Map([[userId, accountOf(userId)]]));
          const deps: RosterDeps = { db, repo, events: createPeopleEvents(repo), identity: identity.client, clock: realClock, faults: createFaultHooks({}, {}), sleep: timer };
          return runRosterOperation(deps, movingUpdate(userId, addressId)).finally(() => calls.push(...identity.calls));
        },
      ],
    ])('%s answers the legacy 503 within the user-closed wait while the tenant lock is still held', async (_label, call) => {
      const user = await seedPerson();
      const before = await written(user.userId);
      const [held, release] = [signal(), signal()];
      const reader = inTenant(async (tx) => {
        await repo.lockRosterTenant(tx, 'shared');
        held.resolve();
        await release.promise;
      });
      await held.promise;
      const queued = openOperation(user.userId);
      await advisoryWaiter();
      const calls: string[] = [];
      const started = Date.now();
      const error = await rejection(call(user, calls));
      const elapsed = Date.now() - started;
      const whileHeld = await appHolds();
      release.resolve();
      await reader;
      await endOperation((await queued).operation_id);
      expect(error).toBeInstanceOf(OperationBlockedError);
      expect(elapsed).toBeGreaterThanOrEqual(USER_CLOSED_WAIT_MS - 500);
      expect(elapsed).toBeLessThan(USER_CLOSED_WAIT_MS + 1_500);
      expect(whileHeld.transactions).toBeGreaterThanOrEqual(2);
      expect(calls).toEqual([]);
      expect(await appHolds()).toEqual({ transactions: 0, advisoryLocks: 0 });
      expect(await written(user.userId)).toEqual(before);
    });
  });

  it.each<[string, () => Promise<unknown>, string]>([
    [
      'a repeated archive',
      async () => {
        const { userId } = await seedPerson(true);
        return archivePerson(archiveDeps(personFence), { tenantId: A, input: { userId, effectiveFrom: '2026-07-01' } });
      },
      'badRequest',
    ],
    ['an archive of no person', () => archivePerson(archiveDeps(personFence), { tenantId: A, input: { userId: cfUuid(), effectiveFrom: '2026-07-01' } }), 'notFound'],
    [
      'a read of a person without a record',
      async () => {
        const { userId } = await seedPerson();
        return getPersonArchive(archiveDeps(personFence), { tenantId: A, userId });
      },
      'notFound',
    ],
  ])('answers %s with the fixture error', async (_label, call, type) => {
    const error = await rejection(call());
    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type });
  });

  it('stores and reads the archive record of an open person', async () => {
    const { userId } = await seedPerson();
    const stored = await archivePerson(archiveDeps(personFence), { tenantId: A, input: { userId, effectiveFrom: '2026-07-01' }, actor: ARCHIVER });
    expect(stored).toMatchObject({ personid: userId, siteid: SITE, effectivefrom: '2026-07-01T00:00:00' });
    expect(await getPersonArchive(archiveDeps(personFence), { tenantId: A, userId })).toEqual(stored);
  });
});
