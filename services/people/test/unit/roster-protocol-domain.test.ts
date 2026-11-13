/** The roster write protocol's people side over a throwaway `people` schema and an identity double: outcomes per step, the before-image, the user closure and operation statuses. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import {
  OperationBlockedError,
  UnitNotAuthoritativeError,
  closeGates,
  endOperation,
  ensureUnitGates,
  openGates,
  openOperations,
} from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError, fixedClock, type Clock } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createCapturingPublisher, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { createFaultHooks, type InjectedFaults } from '../../src/domain/faults.js';
import { normaliseParams } from '../../src/domain/person.js';
import {
  IDENTITY_OPERATION_UNITS,
  PEOPLE_OPERATION_UNITS,
  PhotoBranchError,
  REQUEST_BUDGET_MS,
  USER_CLOSED_WAIT_MS,
  awaitPersonOpen,
  restoreBeforeImage,
  rosterOperationStatus,
  runRosterOperation,
  type RosterDeps,
  type RosterInput,
  type RosterKind,
} from '../../src/domain/roster-protocol.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type {
  AccountCommitRequest,
  AccountOperationState,
  AccountPrepareRequest,
  AccountView,
  IdentityClient,
  LegacyErrors,
} from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type RosterOperationRow, type RosterState } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const LATER = new Date(2026, 5, 30, 11, 0, 0, 0);
const CLOCK = fixedClock(LATER);
const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const ACTOR = { userId: 'ACTOR-0000-0000-0000000000000000001', fname: 'Ada', lname: 'Admin' };
const instant = (): Promise<void> => Promise.resolve();
// Category ids fill the char(35) key, as Masa's UUIDs do, so stored values come back unpadded.
const CAT = { one: cfUuid(), two: cfUuid(), three: cfUuid() };

describe('roster protocol constants', () => {
  it('names the closure and request waits and the units of both participants', () => {
    expect([USER_CLOSED_WAIT_MS, REQUEST_BUDGET_MS]).toEqual([10_000, 10_000]);
    expect(PEOPLE_OPERATION_UNITS).toEqual(['people.person', 'people.user_address', 'people.user_interest', 'people.user_tag', 'people.extend_data_user_activity', 'people.trash']);
    expect(PEOPLE_OPERATION_UNITS.every((unit) => (PEOPLE_UNITS as readonly string[]).includes(unit))).toBe(true);
    expect(IDENTITY_OPERATION_UNITS).toEqual(['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership']);
  });

  it('answers the photo branch with the legacy 503', () => {
    const error = new PhotoBranchError();
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ name: 'PhotoBranchError', surface: 'auto', reason: 'photo-withheld' });
  });
});

/** How the identity double answers one operation's steps. */
interface DoubleBehaviour {
  prepare?: 'ok' | 'unreachable' | LegacyErrors;
  commit?: 'ok' | 'error' | 'lost-reply';
  stateUnreachable?: boolean;
  finish?: 'ok' | 'error';
}

/** An identity double recording calls and bodies, with account operation states as identity keeps them. */
function identityDouble(accounts: Map<string, AccountView>, behaviour: DoubleBehaviour = {}) {
  const calls: string[] = [];
  const prepared: AccountPrepareRequest[] = [];
  const commits: (AccountCommitRequest | undefined)[] = [];
  const states = new Map<string, AccountOperationState>();
  const down = (): ServiceUnavailableError => new ServiceUnavailableError('identity', new Error('identity down'));
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
  const client: IdentityClient = {
    async prepare(userId, operationId, change) {
      calls.push('prepare');
      prepared.push(change);
      const outcome = behaviour.prepare ?? 'ok';
      if (outcome === 'unreachable') throw down();
      if (outcome !== 'ok') return { ok: false, errors: outcome };
      states.set(operationId, 'prepared');
      return { ok: true, operationId, userId, kind: change.kind, state: 'prepared' };
    },
    async commit(userId, operationId, request) {
      calls.push('commit');
      commits.push(request);
      if (behaviour.commit === 'error') throw down();
      states.set(operationId, 'committed');
      if (behaviour.commit === 'lost-reply') throw down();
      return { operationId, userId, state: 'committed', writePosition: '777' };
    },
    async abort(_userId, operationId) {
      calls.push('abort');
      if (states.get(operationId) === 'prepared') states.set(operationId, 'aborted');
    },
    async finish(_userId, operationId) {
      calls.push('finish');
      if (behaviour.finish === 'error') throw down();
      states.set(operationId, 'finished');
    },
    revert: unused('revert'),
    async operationState(_userId, operationId) {
      calls.push('state');
      if (behaviour.stateUnreachable === true) throw down();
      return states.get(operationId);
    },
    async readAccount(userId) {
      calls.push('readAccount');
      return accounts.get(userId);
    },
    readAccounts: unused('readAccounts'),
    userMemberships: unused('userMemberships'),
    async membershipGroupIds() {
      calls.push('memberships');
      return ['GROUP-1'];
    },
    siteGroups: unused('siteGroups'),
    userGroups: unused('userGroups'),
    actingUser: unused('actingUser'),
  };
  return { client, calls, prepared, commits, states };
}

/** Verified claims of the acting site administrator, with `overrides`. */
function claims(overrides: Partial<UserClaims> = {}): UserClaims {
  return { iss: 'opt2-local-identity', aud: 'opt2-local', sub: ACTOR.userId, sid: 'SESSION-1', tid: A, site: SITE, roles: ['site-admin'], s2: false, epoch: 1, iat: 0, exp: 4_102_444_800, ...overrides };
}

/** A save of `kind` posting `params` in tenant A. */
function rosterInput(kind: RosterKind, params: Record<string, unknown>, extra: Partial<RosterInput> = {}): RosterInput {
  return { kind, tenantId: A, claims: claims(), acting: ACTOR, params: normaliseParams(params), postedFiles: new Map(), requestId: 'REQ-1', ...extra };
}

/** Identity's account columns of a stored private user of tenant A. */
function accountView(userId: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId,
    siteId: SITE,
    username: 'pat',
    s2: 0,
    isPublic: 0,
    inactive: 0,
    type: 2,
    perm: 0,
    admin: 0,
    remoteId: null,
    lastLogin: null,
    passwordCreated: null,
    tablist: null,
    ...overrides,
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

const available = await pgAvailable();

describe.skipIf(!available)('roster protocol against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let schema: string;
  let seedRepo: PeopleRepository;
  let repo: PeopleRepository;
  const capture = createCapturingPublisher();
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  const accounts = new Map<string, AccountView>();

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    schema = handle.schema;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'roster-protocol-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'roster-protocol-test', state: 'open' });
    await seedRegistry(db);
    seedRepo = createPeopleRepository({ clock: fixedClock(NOW), schema });
    repo = createPeopleRepository({ clock: CLOCK, schema });
    createOutbox({ service: 'people', db, publisher: capture, logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    capture.clear();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = A): Promise<T> {
    return db.withTenant(tenant, fn);
  }

  /** Protocol collaborators over the throwaway schema, with `injected` step failures and instant polls. */
  function depsFor(identity: IdentityClient, injected: InjectedFaults = {}, extra: Partial<RosterDeps> = {}): RosterDeps {
    return { db, repo, events: createPeopleEvents(repo), identity, clock: CLOCK, faults: createFaultHooks(injected, {}), sleep: instant, ...extra };
  }

  function personInput(userId: string): PersonInput {
    return {
      userid: userId,
      groupname: '',
      fname: 'Pat',
      lname: 'Lee',
      email: 'pat@example.com',
      company: 'Acme',
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
      tags: 'old',
    };
  }

  /** A stored private user of tenant A with a primary address, one interest and one tag, and its identity account. */
  async function seedUser(account: Partial<AccountView> = {}): Promise<{ userId: string; addressId: string }> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await inTenant(async (tx) => {
      await seedRepo.insertPerson(tx, personInput(userId));
      await seedRepo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: SITE, addressname: 'Home', city: 'Oslo', isprimary: 1 });
      await seedRepo.replaceInterests(tx, userId, [CAT.one]);
      await seedRepo.replaceTags(tx, { userId, siteId: SITE, tags: 'old' });
    });
    accounts.set(userId, accountView(userId, account));
    return { userId, addressId };
  }

  /** The admin update of a seeded user changing person, address, interest and tag values. */
  function updateParams(userId: string, addressId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userid: userId,
      siteid: SITE,
      type: '2',
      action: 'Update',
      fname: 'Robin',
      email: 'robin@example.com',
      username: 'robin',
      ispublic: '0',
      categoryid: CAT.two,
      tags: 'x, y',
      addressid: addressId,
      city: 'Bergen',
      ...extra,
    };
  }

  /** People's rows of `userId`: the person's name, version and dates, address cities, interests and tags. */
  function snapshot(userId: string) {
    return inTenant(async (tx) => {
      const person = await repo.findPerson(tx, userId);
      return {
        fname: person?.fname ?? null,
        rowVersion: person?.row_version ?? null,
        created: person?.created ?? null,
        lastupdate: person?.lastupdate ?? null,
        lastupdateby: person?.lastupdateby ?? null,
        cities: (await repo.listAddresses(tx, userId)).map((row) => row.city),
        interests: (await repo.listInterests(tx, userId)).map((row) => row.categoryid),
        tags: (await repo.listTags(tx, userId)).map((row) => row.tag),
      };
    });
  }

  /** The user's latest roster operation. */
  function operationOf(userId: string): Promise<RosterOperationRow | undefined> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<RosterOperationRow>(`SELECT * FROM ${schema}.roster_operation WHERE user_id = $1 ORDER BY started_at DESC, operation_id`, [userId]);
      return rows[0];
    });
  }

  /** Outbox rows of `operationId`. */
  function outboxOf(operationId: string): Promise<{ held: boolean }[]> {
    return inTenant(async (tx) => (await tx.query<{ held: boolean }>(`SELECT held FROM ${schema}.outbox WHERE operation_id = $1`, [operationId])).rows);
  }

  async function registered(operationId: string): Promise<boolean> {
    return (await openOperations(db)).some((operation) => operation.operationId === operationId);
  }

  const OLD = { fname: 'Pat', cities: ['Oslo'], interests: [CAT.one], tags: ['old'] };
  const NEW = { fname: 'Robin', cities: ['Bergen'], interests: [CAT.two], tags: ['x', 'y'] };

  it('creates a user with its primary address, interests and tags, and finishes both sides', async () => {
    const identity = identityDouble(accounts);
    const userId = cfUuid();
    const params = {
      userid: userId,
      siteid: SITE,
      type: '2',
      action: 'Add',
      s2: '1',
      fname: 'Nia',
      lname: 'Ode',
      email: 'nia@example.com',
      username: 'nia',
      password: 'Secret1x',
      ispublic: '0',
      groupid: 'GROUP-1',
      categoryid: `${CAT.one},${CAT.three}`,
      tags: 'a,b',
      address1: 'Main 1',
      city: 'Oslo',
    };
    const result = await runRosterOperation(depsFor(identity.client), rosterInput('admin-add', params));
    expect(result).toMatchObject({ ok: true, userId, values: { userid: userId, isnew: 0, s2: 0, lastupdateby: 'Ada Admin', lastupdatebyid: ACTOR.userId } });
    expect(identity.calls).toEqual(['readAccount', 'prepare', 'commit', 'finish']);
    expect(identity.prepared[0]).toMatchObject({ kind: 'create', siteId: SITE, groupIds: ['GROUP-1'], account: { UserName: 'nia', Password: 'Secret1x', isPublic: 0, Type: 2 } });
    expect(identity.commits).toEqual([undefined]);
    expect(await snapshot(userId)).toMatchObject({ fname: 'Nia', rowVersion: '1', lastupdateby: 'Ada Admin', cities: ['Oslo'], interests: [CAT.one, CAT.three].sort(), tags: ['a', 'b'] });
    const address = (await inTenant((tx) => repo.listAddresses(tx, userId)))[0];
    expect(address).toMatchObject({ addressname: 'Primary', isprimary: 1, address1: 'Main 1', siteid: SITE });
    expect(address?.addressid).toMatch(CF_UUID);
    const operation = await operationOf(userId);
    expect(operation).toMatchObject({ kind: 'admin-add', state: 'done', error: null, identity_xid: '777' });
    expect(operation?.payload).not.toContain('Secret1x');
    expect(JSON.parse(operation?.payload ?? '{}')).toMatchObject({ operation: 'create', account: { passwordChanged: true } });
    expect(await registered(operation?.operation_id ?? '')).toBe(false);
    expect(await outboxOf(operation?.operation_id ?? '')).toEqual([{ held: false }]);
    expect(capture.published.map((event) => event.envelope.aggregateId)).toEqual([userId]);
  });

  it('generates the user id, and skips the primary address of a user restored from the trash', async () => {
    const identity = identityDouble(accounts);
    const params = { siteid: SITE, type: '2', fname: 'Tor', lname: 'Ash', email: 'tor@example.com', username: 'tor', ispublic: '0', frommuratrash: '1' };
    const result = await runRosterOperation(depsFor(identity.client), rosterInput('json-save', params));
    if (!result.ok) throw new Error('expected success');
    expect(result.userId).toMatch(CF_UUID);
    expect(identity.prepared[0]?.account).not.toHaveProperty('Password');
    expect(await snapshot(result.userId)).toMatchObject({ fname: 'Tor', cities: [] });
  });

  it('updates a stored user without touching created, and re-logs the saving session in at commit', async () => {
    const { userId, addressId } = await seedUser();
    const identity = identityDouble(accounts);
    const input = rosterInput('json-save', updateParams(userId, addressId, { primaryaddressid: addressId }), { sessionReloginId: 'SESSION-1' });
    const result = await runRosterOperation(depsFor(identity.client), input);
    expect(result).toMatchObject({ ok: true, userId, values: { fname: 'Robin', lname: 'Lee', groupid: 'GROUP-1', isnew: 0, errors: {} } });
    expect(await snapshot(userId)).toMatchObject({ ...NEW, rowVersion: '2', created: NOW, lastupdate: LATER });
    expect(identity.prepared[0]).toMatchObject({ kind: 'update', updateGroups: true, groupIds: ['GROUP-1'] });
    expect(identity.commits[0]).toEqual({
      sessionEffects: { reloginSessionId: 'SESSION-1', person: { fname: 'Robin', lname: 'Lee', email: 'robin@example.com', company: 'Acme', subtype: 'Default' } },
    });
  });

  it('saves the session user\'s own profile without its account-level keys or memberships', async () => {
    const { userId } = await seedUser();
    const identity = identityDouble(accounts);
    const input = rosterInput('profile-update', { userid: 'OTHER', siteid: 'tenant-b', fname: 'Kai', email: 'kai@example.com', username: 'pat', ispublic: '1', s2: '1' }, {
      claims: claims({ sub: userId }),
    });
    const result = await runRosterOperation(depsFor(identity.client), input);
    expect(result).toMatchObject({ ok: true, userId, values: { fname: 'Kai', siteid: SITE, ispublic: 0 } });
    expect(identity.prepared[0]).toMatchObject({ kind: 'update', siteId: SITE, updateGroups: false, account: { isPublic: 0, S2: 0 } });
    expect(await snapshot(userId)).toMatchObject({ fname: 'Kai', interests: [CAT.one], tags: ['old'] });
  });

  it('returns legacy\'s merged validation errors, aborting a prepared account, and writes nothing', async () => {
    const { userId, addressId } = await seedUser();
    const usernameTaken = { username: "The username 'robin' that you entered is being used by another user." };
    const refused = identityDouble(accounts, { prepare: usernameTaken });
    const result = await runRosterOperation(depsFor(refused.client), rosterInput('admin-update', updateParams(userId, addressId, { email: '' })));
    if (result.ok) throw new Error('expected validation errors');
    expect(Object.keys(result.errors).sort()).toEqual(['email', 'username']);
    expect(result.errors.username).toBe(usernameTaken.username);
    expect(result.values.errors).toEqual(result.errors);
    expect(refused.calls).not.toContain('abort');

    const accepted = identityDouble(accounts);
    const again = await runRosterOperation(depsFor(accepted.client), rosterInput('admin-update', updateParams(userId, addressId, { email: '' })));
    expect(again).toMatchObject({ ok: false, errors: { email: expect.any(String) } });
    expect(accepted.calls).toEqual(['readAccount', 'readAccount', 'memberships', 'prepare', 'abort']);
    const operation = await operationOf(userId);
    expect(operation).toMatchObject({ state: 'rolled-back', error: 'validation' });
    expect(await registered(operation?.operation_id ?? '')).toBe(false);
    expect(await snapshot(userId)).toMatchObject({ ...OLD, rowVersion: '1' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a posted newFile', { newfile: 'https://example.com/me.png' }],
    ['removePhotoFile=true', { removephotofile: 'TRUE' }],
    ['a boolean removePhotoFile', { removephotofile: true }],
  ])('routes %s to legacy before any read or write', async (_label, photo) => {
    const { userId, addressId } = await seedUser();
    const identity = identityDouble(accounts);
    const error = await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId, photo))));
    expect(error).toBeInstanceOf(PhotoBranchError);
    expect(identity.calls).toEqual([]);
    expect(await operationOf(userId)).toBeUndefined();
  });

  /** One failure of the matrix: where it strikes, and the answer and final state legacy's rules require. */
  interface FailureCase {
    label: string;
    injected?: InjectedFaults;
    behaviour?: DoubleBehaviour;
    answer: 'success' | 'unavailable';
    state: RosterState;
    error?: string | null;
    people: typeof OLD;
    rowVersion?: string;
    identityCalls: string[];
    registered: boolean;
    outbox: { held: boolean }[];
  }

  const fault = (): Error => new Error('injected fault');
  const PROTOCOL_CALLS = ['readAccount', 'readAccount', 'memberships'];

  it.each<FailureCase>([
    {
      label: 'a failure after the intent leaves it started for recovery',
      injected: { 'after-start': fault },
      answer: 'unavailable',
      state: 'started',
      people: OLD,
      identityCalls: [],
      registered: true,
      outbox: [],
    },
    {
      label: 'an unreachable prepare leaves it started for recovery',
      behaviour: { prepare: 'unreachable' },
      answer: 'unavailable',
      state: 'started',
      people: OLD,
      identityCalls: ['prepare'],
      registered: true,
      outbox: [],
    },
    {
      label: 'a failed people commit aborts identity inline',
      injected: { 'after-prepare': fault },
      answer: 'unavailable',
      state: 'rolled-back',
      error: 'people-commit',
      people: OLD,
      rowVersion: '1',
      identityCalls: ['prepare', 'abort'],
      registered: false,
      outbox: [],
    },
    {
      label: 'a failure after the people commit with identity prepared restores the before-image',
      injected: { 'after-people-commit': fault },
      answer: 'unavailable',
      state: 'rolled-back',
      error: 'identity-commit',
      people: OLD,
      rowVersion: '3',
      identityCalls: ['prepare', 'state', 'abort'],
      registered: false,
      outbox: [],
    },
    {
      label: 'a failed identity commit with identity still prepared restores the before-image',
      behaviour: { commit: 'error' },
      answer: 'unavailable',
      state: 'rolled-back',
      error: 'identity-commit',
      people: OLD,
      rowVersion: '3',
      identityCalls: ['prepare', 'commit', 'state', 'abort'],
      registered: false,
      outbox: [],
    },
    {
      label: 'a lost commit reply after identity committed finishes',
      behaviour: { commit: 'lost-reply' },
      answer: 'success',
      state: 'done',
      error: null,
      people: NEW,
      rowVersion: '2',
      identityCalls: ['prepare', 'commit', 'state', 'finish'],
      registered: false,
      outbox: [{ held: false }],
    },
    {
      label: 'a failure after identity committed leaves it people-committed for recovery',
      injected: { 'after-identity-commit': fault },
      answer: 'unavailable',
      state: 'people-committed',
      people: NEW,
      identityCalls: ['prepare', 'commit'],
      registered: true,
      outbox: [{ held: true }],
    },
    {
      label: 'a failure after done still succeeds with the finish pending',
      injected: { 'after-done': fault },
      answer: 'success',
      state: 'done',
      error: 'finish-pending',
      people: NEW,
      identityCalls: ['prepare', 'commit'],
      registered: true,
      outbox: [{ held: false }],
    },
    {
      label: 'a failed finish still succeeds with the finish pending',
      behaviour: { finish: 'error' },
      answer: 'success',
      state: 'done',
      error: 'finish-pending',
      people: NEW,
      identityCalls: ['prepare', 'commit', 'finish'],
      registered: true,
      outbox: [{ held: false }],
    },
  ])('$label', async (failure) => {
    const { userId, addressId } = await seedUser();
    const identity = identityDouble(accounts, failure.behaviour);
    const outcome = runRosterOperation(depsFor(identity.client, failure.injected), rosterInput('admin-update', updateParams(userId, addressId)));
    if (failure.answer === 'success') {
      expect(await outcome).toMatchObject({ ok: true, userId });
    } else {
      expect(await rejection(outcome)).toBeInstanceOf(LegacyServiceUnavailableError);
    }
    expect(identity.calls).toEqual([...PROTOCOL_CALLS, ...failure.identityCalls]);
    expect(await snapshot(userId)).toMatchObject({ ...failure.people, ...(failure.rowVersion === undefined ? {} : { rowVersion: failure.rowVersion }) });
    const operation = await operationOf(userId);
    expect(operation).toMatchObject({ state: failure.state, ...(failure.error === undefined ? {} : { error: failure.error }) });
    expect(await registered(operation?.operation_id ?? '')).toBe(failure.registered);
    expect(await outboxOf(operation?.operation_id ?? '')).toEqual(failure.outbox);
  });

  it('answers 503 once identity stays unreachable past the request budget, leaving the operation people-committed', async () => {
    const { userId, addressId } = await seedUser();
    const identity = identityDouble(accounts, { commit: 'lost-reply', stateUnreachable: true });
    const error = await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId))));
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    const polls = identity.calls.filter((call) => call === 'state').length;
    expect(polls).toBe(REQUEST_BUDGET_MS / 100 + 1);
    expect(await operationOf(userId)).toMatchObject({ state: 'people-committed' });
    expect(await snapshot(userId)).toMatchObject(NEW);
  });

  it('restores a created user\'s rows to nothing when identity never committed', async () => {
    const identity = identityDouble(accounts, { commit: 'error' });
    const userId = cfUuid();
    const params = { userid: userId, siteid: SITE, type: '2', action: 'Add', fname: 'Lo', email: 'lo@example.com', username: 'lo', ispublic: '0', categoryid: CAT.one, tags: 'a' };
    expect(await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-add', params)))).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await snapshot(userId)).toMatchObject({ fname: null, cities: [], interests: [], tags: [] });
    expect(identity.states.get((await operationOf(userId))?.operation_id ?? '')).toBe('aborted');
  });

  /** Records an open roster operation of `userId` in `tenant`, as another request's intent. */
  function openOperation(userId: string, tenant = A): Promise<RosterOperationRow> {
    return inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }), tenant);
  }

  it('waits out another open operation on the user, then answers the legacy 503 and writes nothing', async () => {
    const { userId, addressId } = await seedUser();
    const holder = await openOperation(userId);
    const identity = identityDouble(accounts);
    const error = await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId))));
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(error).toMatchObject({ message: `Roster operation ${holder.operation_id} keeps user ${userId} closed`, units: [...PEOPLE_OPERATION_UNITS, ...IDENTITY_OPERATION_UNITS] });
    expect(identity.calls).toEqual(['readAccount']);
    expect(await snapshot(userId)).toMatchObject(OLD);
  });

  it('retries the intent once after an open operation another tenant holds, then answers the legacy 503', async () => {
    const { userId, addressId } = await seedUser();
    await openOperation(userId, TENANT_B.tenantId);
    const identity = identityDouble(accounts);
    const error = await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId))));
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(error).toMatchObject({ message: `An open roster operation keeps user ${userId} closed` });
    expect(identity.calls).not.toContain('prepare');
  });

  it.each<[string, () => Promise<RosterInput>, string]>([
    ['a save whose pool rule lands in another tenant', async () => {
      const { userId, addressId } = await seedUser();
      return rosterInput('admin-update', updateParams(userId, addressId, { ispublic: '1' }));
    }, 'person-pool-move'],
    ['an admin update of no stored person', async () => rosterInput('admin-update', updateParams(cfUuid(), cfUuid())), 'person-unknown'],
    ['a stored person identity holds no account of', async () => {
      const { userId, addressId } = await seedUser();
      accounts.delete(userId);
      return rosterInput('admin-update', updateParams(userId, addressId));
    }, 'person-unknown'],
  ])('refuses %s with the legacy 503 before the intent', async (_label, build, reason) => {
    const input = await build();
    const identity = identityDouble(accounts);
    const error = await rejection(runRosterOperation(depsFor(identity.client), input));
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ reason });
    expect(identity.calls).not.toContain('prepare');
  });

  it('writes nothing for an action a non-super user cannot take on an S2 user', async () => {
    const { userId, addressId } = await seedUser({ s2: 1 });
    const identity = identityDouble(accounts);
    const result = await runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId, { action: 'Delete' })));
    expect(result).toMatchObject({ ok: true, userId, values: { fname: 'Pat', s2: '1' } });
    expect(identity.calls).not.toContain('prepare');
    expect(await operationOf(userId)).toBeUndefined();
  });

  it('rolls the intent back when a unit is not target-authoritative', async () => {
    for (const operation of await openOperations(db)) await endOperation(db, operation.operationId);
    const { userId, addressId } = await seedUser();
    await closeGates(db, { units: ['people.user_tag'], holderId: 'legacy-tag' });
    await openGates(db, { units: ['people.user_tag'], holderId: 'legacy-tag', state: 'legacy' });
    try {
      const identity = identityDouble(accounts);
      const error = await rejection(runRosterOperation(depsFor(identity.client), rosterInput('admin-update', updateParams(userId, addressId))));
      expect(error).toBeInstanceOf(UnitNotAuthoritativeError);
      expect(identity.calls).not.toContain('prepare');
      expect(await operationOf(userId)).toMatchObject({ state: 'rolled-back', error: 'units-blocked' });
    } finally {
      await closeGates(db, { units: ['people.user_tag'], holderId: 'legacy-tag', allowLegacy: true });
      await openGates(db, { units: ['people.user_tag'], holderId: 'legacy-tag', state: 'open' });
    }
  });

  describe('awaitPersonOpen', () => {
    it('returns at once for an open user, or for the caller\'s own operation', async () => {
      const userId = cfUuid();
      await expect(awaitPersonOpen(db, A, userId, { clock: CLOCK, sleep: instant })).resolves.toBeUndefined();
      const own = await openOperation(userId);
      await expect(awaitPersonOpen(db, A, userId, { clock: CLOCK, sleep: instant, selfOperationId: own.operation_id })).resolves.toBeUndefined();
    });

    it('times out on the injected clock with the legacy 503', async () => {
      const userId = cfUuid();
      await openOperation(userId);
      const slept: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        slept.push(ms);
        return Promise.resolve();
      };
      const error = await rejection(awaitPersonOpen(db, A, userId, { clock: advancingClock(4_000), sleep }));
      expect(error).toBeInstanceOf(OperationBlockedError);
      expect(slept.length).toBeLessThan(5);
    });

    it('waits until the holding operation ends', async () => {
      const userId = cfUuid();
      const holder = await openOperation(userId);
      let polls = 0;
      const sleep = async (): Promise<void> => {
        polls += 1;
        if (polls === 2) await inTenant((tx) => repo.setRosterOperationState(tx, holder.operation_id, { state: 'done' }));
      };
      await expect(awaitPersonOpen(db, A, userId, { clock: CLOCK, sleep })).resolves.toBeUndefined();
      expect(polls).toBe(2);
    });
  });

  it('reports each roster state in the migration handlers\' vocabulary', async () => {
    const rows = new Map<RosterState, string>();
    for (const state of ['started', 'people-committed', 'halted', 'done', 'rolled-back'] as const) {
      const row = await openOperation(cfUuid(), state === 'halted' ? TENANT_B.tenantId : A);
      if (state !== 'started') await inTenant((tx) => repo.setRosterOperationState(tx, row.operation_id, { state }), row.tenant_id);
      rows.set(state, row.operation_id);
    }
    const unknown = cfUuid();
    const statuses = await rosterOperationStatus(db, [...rows.values(), unknown]);
    expect(statuses).toEqual({
      [rows.get('started') ?? '']: 'open',
      [rows.get('people-committed') ?? '']: 'open',
      [rows.get('halted') ?? '']: 'open',
      [rows.get('done') ?? '']: 'done',
      [rows.get('rolled-back') ?? '']: 'rolled-back',
    });
    expect(await rosterOperationStatus(db, [])).toEqual({});
  });

  it('only discards held rows of an operation that never committed people', async () => {
    const userId = cfUuid();
    const row = await openOperation(userId);
    await inTenant(async (tx) => {
      await tx.query(
        `INSERT INTO ${schema}.outbox (tenant_id, event_id, topic, kind, ordering_key, envelope, operation_id, held, created_at) VALUES ($1, gen_random_uuid(), 'people.person.changed.v1', 'state', $2, '{}'::jsonb, $3, true, LOCALTIMESTAMP(3))`,
        [A, userId, row.operation_id],
      );
    });
    await restoreBeforeImage({ db, repo }, A, row);
    expect(await outboxOf(row.operation_id)).toEqual([]);
  });

  it('puts a moved address and a taken-out trash row back with the before-image', async () => {
    const { userId, addressId } = await seedUser();
    const other = await seedUser();
    const trashed = cfUuid();
    await inTenant((tx) =>
      repo.insertTrashIfAbsent(tx, {
        objectid: trashed,
        parentid: '',
        siteid: SITE,
        objectlabel: 'Trashed',
        objectclass: 'user',
        objecttype: '2',
        objectsubtype: 'Default',
        objectstring: '<wddxPacket/>',
        deleteddate: NOW,
        deletedby: 'Ada Admin',
        deleteid: cfUuid(),
        orderno: 1,
      }),
    );
    const moving = identityDouble(accounts, { commit: 'error' });
    const move = rosterInput('admin-update', updateParams(userId, addressId, { addressid: other.addressId }));
    expect(await rejection(runRosterOperation(depsFor(moving.client), move))).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await snapshot(other.userId)).toMatchObject({ cities: ['Oslo'] });
    expect(await snapshot(userId)).toMatchObject({ ...OLD, rowVersion: '3' });

    const restoring = identityDouble(accounts, { commit: 'error' });
    const params = { userid: trashed, siteid: SITE, type: '2', action: 'Add', fname: 'Re', email: 're@example.com', username: 're', ispublic: '0', frommuratrash: '1' };
    expect(await rejection(runRosterOperation(depsFor(restoring.client), rosterInput('admin-add', params)))).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await inTenant((tx) => repo.findByKey(tx, 'trash', { objectid: trashed }))).toMatchObject({ objectlabel: 'Trashed', deleteddate: NOW });
  });

  it('creates the user a JSON API save names when no person holds its id', async () => {
    const userId = cfUuid();
    const identity = identityDouble(accounts);
    const params = { userid: userId, siteid: SITE, type: '2', fname: 'Mo', email: 'mo@example.com', username: 'mo', ispublic: '0' };
    expect(await runRosterOperation(depsFor(identity.client), rosterInput('json-save', params))).toMatchObject({ ok: true, userId });
    expect(identity.prepared[0]).toMatchObject({ kind: 'create' });
    expect(await snapshot(userId)).toMatchObject({ fname: 'Mo', rowVersion: '1' });
  });

  // Last: the user subtype's definitions take part in every later save of the site.
  it('validates and saves extended attributes, and restores them with the before-image', async () => {
    await inTenant(async (tx) => {
      await repo.insert(tx, 'extend_subtype', { subtypeid: 'ST-ROSTER', siteid: SITE, basetable: 'tusers', type: '2', subtype: 'Default' });
      await repo.insert(tx, 'extend_set', { extendsetid: 'SET-ROSTER', subtypeid: 'ST-ROSTER', siteid: SITE, orderno: 1 });
      await repo.insert(tx, 'extend_attribute', { attributeid: 9001, extendsetid: 'SET-ROSTER', siteid: SITE, name: 'shoesize', type: 'TextBox', validation: 'numeric', orderno: 1 });
      await repo.insert(tx, 'extend_attribute', { attributeid: 9002, extendsetid: 'SET-ROSTER', siteid: SITE, name: 'portrait', type: 'File', orderno: 2 });
    });
    const { userId, addressId } = await seedUser();
    const extended = (size: string): Record<string, unknown> => updateParams(userId, addressId, { extendsetid: 'SET-ROSTER', shoesize: size });
    const stored = (): Promise<(string | null)[]> =>
      inTenant(async (tx) => (await repo.listExtendData(tx, [userId])).filter((row) => row.attributeid === 9001).map((row) => row.attributevalue));

    const invalid = await runRosterOperation(depsFor(identityDouble(accounts).client), rosterInput('admin-update', extended('abc')));
    expect(invalid).toMatchObject({ ok: false, errors: { shoesize: expect.any(String) } });
    expect(await stored()).toEqual([]);

    expect(await runRosterOperation(depsFor(identityDouble(accounts).client), rosterInput('admin-update', extended('42')))).toMatchObject({ ok: true });
    expect(await stored()).toEqual(['42']);

    const failing = identityDouble(accounts, { commit: 'error' });
    expect(await rejection(runRosterOperation(depsFor(failing.client), rosterInput('admin-update', extended('43'))))).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(await stored()).toEqual(['42']);
  });
});
