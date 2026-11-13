/** People's observer reads over a throwaway `people` schema: user lists, searches and the Edit User, Edit Address and profile reads against roster saves and open operations. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles, type UserClaims } from '@opt2/platform/auth';
import { cfUuid, type LegacyQuery } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { OperationBlockedError, closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, fixedClock, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  testVerifier,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createFaultHooks, type FaultHooks } from '../../src/domain/faults.js';
import { normaliseParams } from '../../src/domain/person.js';
import { USER_CLOSED_WAIT_MS, runRosterOperation, type RosterDeps } from '../../src/domain/roster-protocol.js';
import { getAdvancedSearch, getSearch, getUsers, newAdvancedSearchCriteria, type SearchDeps, type ViewerScope } from '../../src/domain/search.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountPrepareRequest, AccountView, IdentityClient } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type RosterOperationRow } from '../../src/repo/tables.js';
import { registerAdminProfileRoutes } from '../../src/routes/admin-profile.js';
import { registerAdminUserRoutes } from '../../src/routes/admin-users.js';
import { accountListed, ilikeC } from '../helpers/search-doubles.js';

const SERVICE = 'people';
const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const ADMIN = 'ADMIN000-0000-0000-0000000000000001';
const instant = (): Promise<void> => Promise.resolve();

/** Open transactions and held advisory locks of the schema's app role. */
interface Holds {
  transactions: number;
  advisoryLocks: number;
}

const NO_HOLDS: Holds = { transactions: 0, advisoryLocks: 0 };
/** No user of this world holds a stored membership. */
const NO_MEMBERSHIPS: ReadonlyMap<string, readonly string[]> = new Map();

/** What one read shows of a user: people's first name beside identity's user name. */
interface Seen {
  fname: unknown;
  username: unknown;
}

/** A route's non-200 answer. */
class StatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
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

/** The error `outcome` rejects with. */
async function rejection(outcome: Promise<unknown>): Promise<unknown> {
  try {
    await outcome;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Identity's account of a private user of tenant A named `pat`. */
function accountOf(userId: string): AccountView {
  return { userId, siteId: SITE, username: 'pat', s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null, lastLogin: null, passwordCreated: null, tablist: null };
}

/** The person row of `userId`: Pat Observed of tenant A. */
function personInput(userId: string): PersonInput {
  return {
    userid: userId, groupname: '', fname: 'Pat', lname: 'Observed', email: 'pat@example.com', company: '', jobtitle: '', mobilephone: '',
    website: '', subtype: 'Default', contactform: '', lastupdateby: 'Pat Observed', lastupdatebyid: userId, siteid: SITE, subscribe: 1,
    notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '', tags: '',
  };
}

/** What a user query shows of `userId`; undefined when it lists no such user. */
function listed(query: LegacyQuery, userId: string): Seen | undefined {
  const row = query.rows.find((candidate) => (candidate.UserID ?? candidate.userID) === userId);
  return row === undefined ? undefined : { fname: row.Fname, username: row.UserName };
}

/** Claims of the site administrator saving through the roster protocol. */
const ROSTER_CLAIMS: UserClaims = { iss: 'opt2-local-identity', aud: 'opt2-local', sub: ADMIN, sid: 'SESSION-1', tid: A, site: SITE, roles: ['site-admin'], s2: false, epoch: 1, iat: 0, exp: 4_102_444_800 };

const available = await pgAvailable();

describe.skipIf(!available)('roster observers against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let repo: PeopleRepository;
  let app: FastifyInstance;
  const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  const accounts = new Map<string, AccountView>();
  /** The observers' identity calls, in order. */
  const calls: string[] = [];
  /** The app role's holds as each observer identity call starts. */
  const holds: Holds[] = [];
  /** Runs once as the observers' account read number `at` (0-based) starts. */
  let hook: { at: number; run: () => Promise<void> } | undefined;
  /** Runs once as an observer's people read returns a person row of `userId`, inside that read's transaction. */
  let readHook: { userId: string; run: () => Promise<void> } | undefined;
  /** The repository the observers read through: `repo` with `readHook` after its person reads. */
  let observedRepo: PeopleRepository;
  let clock: Clock = CLOCK;
  let sleep: (ms: number) => Promise<unknown> = instant;
  const liveClock: Clock = { now: () => clock.now() };
  const liveSleep = (ms: number): Promise<unknown> => sleep(ms);
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
  /** What afterAll releases, last acquired first. */
  const cleanups: (() => Promise<unknown>)[] = [];

  async function appHolds(): Promise<Holds> {
    const sql =
      'SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE usename = $1 AND xact_start IS NOT NULL) AS transactions,' +
      " (SELECT count(*)::int FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.usename = $1 AND l.locktype = 'advisory') AS advisory_locks";
    const [row] = (await handle.adminPool.query<{ transactions: number; advisory_locks: number }>(sql, [handle.roles.app])).rows;
    return { transactions: row?.transactions ?? -1, advisoryLocks: row?.advisory_locks ?? -1 };
  }

  /** Records an observer identity call with the holds at its start, then runs a hook due at this account read. */
  async function observed(call: string): Promise<void> {
    const accountReads = calls.filter((name) => name !== 'memberships').length;
    calls.push(call);
    holds.push(await appHolds());
    const due = hook;
    if (due !== undefined && call !== 'memberships' && due.at === accountReads) {
      hook = undefined;
      await due.run();
    }
  }

  /** The identity the observers read through. */
  const observerIdentity: IdentityClient = {
    prepare: unused('prepare'),
    commit: unused('commit'),
    abort: unused('abort'),
    finish: unused('finish'),
    revert: unused('revert'),
    operationState: unused('operationState'),
    async readAccount(userId) {
      await observed('readAccount');
      return accounts.get(userId);
    },
    async readAccounts(userIds, where) {
      await observed('readAccounts');
      return new Map(userIds.flatMap((id) => {
        const account = accounts.get(id);
        return account === undefined || !accountListed(account, where, NO_MEMBERSHIPS) ? [] : [[id, account] as const];
      }));
    },
    readAccountsAllSites: unused('readAccountsAllSites'),
    // The count and the username prefilter precede the observed reads, so they are not observer calls.
    countAccounts: (request) => Promise.resolve([...accounts.values()].filter((account) => accountListed(account, request.where, NO_MEMBERSHIPS)).length),
    usernameCandidates(request) {
      const like = ilikeC(request.pattern);
      const items = [...accounts.values()]
        .filter((account) => accountListed(account, request.where, NO_MEMBERSHIPS) && account.username !== null && like(account.username))
        .map((account) => ({ userId: account.userId, username: account.username as string }));
      return Promise.resolve({ items: items.slice(0, request.limit), complete: items.length <= request.limit });
    },
    async lookupMemberships(userIds) {
      await observed('memberships');
      return new Map(userIds.map((id) => [id, []]));
    },
    // The Edit User read takes the login block after its observed bean read.
    loginBlock: () => Promise.resolve(null),
    userMemberships: unused('userMemberships'),
    async membershipGroupIds() {
      await observed('memberships');
      return [];
    },
    siteGroups: () => Promise.resolve([]),
    userGroups: unused('userGroups'),
    actingUser: unused('actingUser'),
    adminSessionState: unused('adminSessionState'),
    saveAdminSessionState: unused('saveAdminSessionState'),
    sessionSites: () => Promise.resolve([]),
  };

  /** The identity a roster save runs against: its commit applies the prepared user name to `accounts`. */
  function saverIdentity(): IdentityClient {
    const prepared = new Map<string, AccountPrepareRequest>();
    return {
      prepare(userId, operationId, change) {
        prepared.set(operationId, change);
        return Promise.resolve({ ok: true, operationId, userId, kind: change.kind, state: 'prepared' });
      },
      commit(userId, operationId) {
        const change = prepared.get(operationId);
        const stored = accounts.get(userId);
        if (change !== undefined && stored !== undefined) accounts.set(userId, { ...stored, username: change.account.UserName });
        return Promise.resolve({ operationId, userId, state: 'committed', writePosition: '42' });
      },
      abort: () => Promise.resolve(),
      finish: () => Promise.resolve(),
      revert: unused('revert'),
      operationState: unused('operationState'),
      readAccount: (userId) => Promise.resolve(accounts.get(userId)),
      readAccounts: unused('readAccounts'),
      readAccountsAllSites: unused('readAccountsAllSites'),
      countAccounts: unused('countAccounts'),
      usernameCandidates: unused('usernameCandidates'),
      lookupMemberships: unused('lookupMemberships'),
      loginBlock: unused('loginBlock'),
      userMemberships: unused('userMemberships'),
      membershipGroupIds: () => Promise.resolve([]),
      siteGroups: unused('siteGroups'),
      userGroups: unused('userGroups'),
      actingUser: unused('actingUser'),
      adminSessionState: unused('adminSessionState'),
      saveAdminSessionState: unused('saveAdminSessionState'),
      sessionSites: unused('sessionSites'),
    };
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    cleanups.push(() => handle.drop());
    db = handle.app;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'roster-observers-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'roster-observers-test', state: 'open' });
    await seedRegistry(db);
    repo = createPeopleRepository({ clock: CLOCK, schema: handle.schema });
    const afterRead = async <T>(found: T, userIds: readonly (string | undefined)[]): Promise<T> => {
      const due = readHook;
      if (due !== undefined && userIds.includes(due.userId)) {
        readHook = undefined;
        await due.run();
      }
      return found;
    };
    observedRepo = {
      ...repo,
      findPerson: async (tx, userId) => {
        const row = await repo.findPerson(tx, userId);
        return afterRead(row, [row?.userid]);
      },
      listPersonsForSite: async (tx, siteId, opts) => {
        const rows = await repo.listPersonsForSite(tx, siteId, opts);
        return afterRead(rows, rows.map((row) => row.userid));
      },
      queryPersons: async (tx, query) => {
        const rows = await repo.queryPersons(tx, query);
        return afterRead(rows, rows.map((row) => row.userid));
      },
      pagePersonsInOrder: async (tx, scope, opts) => {
        const page = await repo.pagePersonsInOrder(tx, scope, opts);
        return afterRead(page, page.rows.map((row) => row.userid));
      },
      pageQueryPersons: async (tx, query, opts) => {
        const page = await repo.pageQueryPersons(tx, query, opts);
        return afterRead(page, page.rows.map((row) => row.userid));
      },
    };
    createOutbox({ service: SERVICE, db, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: peoplePayloadValidators });
    const roster: RosterDeps = { db, repo: observedRepo, events: createPeopleEvents(repo), identity: observerIdentity, clock: liveClock, faults: createFaultHooks({}, {}), sleep: liveSleep };
    app = await createService({
      name: SERVICE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8112',
        OPT2_SERVICE_NAME: SERVICE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: process.env.TZ ?? 'UTC',
      }),
      verifierOverride: testVerifier(SERVICE),
      pool: db,
      logger,
    });
    cleanups.push(() => app.close());
    await registerAdminUserRoutes(app, { db, repository: observedRepo, identity: observerIdentity, clock: liveClock, sleep: liveSleep });
    await registerAdminProfileRoutes(app, { roster });
    await app.ready();
  });

  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  beforeEach(() => {
    calls.length = 0;
    holds.length = 0;
    hook = undefined;
    readHook = undefined;
    clock = CLOCK;
    sleep = instant;
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(A, fn);
  }

  /** Pat Observed, user name `pat`, with one address in Oslo. */
  async function seedUser(): Promise<{ userId: string; addressId: string }> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await inTenant(async (tx) => {
      await repo.insertPerson(tx, personInput(userId));
      await repo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: SITE, addressname: 'Home', city: 'Oslo', isprimary: 1 });
    });
    accounts.set(userId, accountOf(userId));
    return { userId, addressId };
  }

  function openOperation(userId: string): Promise<RosterOperationRow> {
    return inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
  }

  function endOperation(operationId: string): Promise<unknown> {
    return inTenant((tx) => repo.setRosterOperationState(tx, operationId, { state: 'done' }));
  }

  /** The admin update renaming `userId` to Robin with user name `robin`, run to success through the roster protocol. */
  async function rename(userId: string, faults: FaultHooks = createFaultHooks({}, {})): Promise<void> {
    const params = { userid: userId, siteid: SITE, type: '2', action: 'Update', fname: 'Robin', lname: 'Observed', email: 'robin@example.com', username: 'robin', ispublic: '0' };
    const deps: RosterDeps = { db, repo, events: createPeopleEvents(repo), identity: saverIdentity(), clock: CLOCK, faults, sleep: instant };
    const input = { kind: 'admin-update' as const, tenantId: A, claims: ROSTER_CLAIMS, acting: { userId: ADMIN, fname: 'Ada', lname: 'Admin' }, params: normaliseParams(params), postedFiles: new Map<string, string>(), requestId: 'REQ-ROSTER' };
    const result = await runRosterOperation(deps, input);
    if (!result.ok) throw new Error(`The roster save failed: ${JSON.stringify(result.errors)}`);
  }

  function searchDeps(): SearchDeps {
    return { db, repo: observedRepo, identity: observerIdentity, clock: liveClock, sleep: liveSleep };
  }

  /** A route's 200 body; any other answer rejects with its status. */
  async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await app.inject({ method: 'GET', url, headers });
    if (res.statusCode !== 200) throw new StatusError(res.statusCode);
    return res.json<Record<string, unknown>>();
  }

  /** Headers of web's call for `sub` of tenant A holding `roles`. */
  async function headersFor(sub: string, roles: readonly string[]): Promise<Record<string, string>> {
    const [user, caller] = await Promise.all([
      mintUserToken({ sub, sid: `SESSION-${sub}`, site: SITE, roles: [...roles] }),
      mintServiceToken({ caller: 'web', audience: SERVICE }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${caller}` };
  }

  /** The first name and user name of a route's person record. */
  function recordSeen(body: Record<string, unknown>): Seen {
    const user = body.user as Record<string, unknown>;
    return { fname: user.Fname, username: user.UserName };
  }

  /** Asserts the legacy 503 of `userId` kept closed by `holder`: the domain error, or a route's 503. */
  function expectClosed(error: unknown, holder: RosterOperationRow, userId: string): void {
    if (error instanceof StatusError) {
      expect(error.status).toBe(503);
      return;
    }
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(error).toMatchObject({ message: `Roster operation ${holder.operation_id} keeps user ${userId} closed` });
  }

  /** One observer read: what it shows of a user, the identity calls an undisturbed attempt makes and how many of them locate the user first. */
  interface Observer {
    read: (userId: string) => Promise<Seen | undefined>;
    attempt: readonly string[];
    lead: number;
  }

  const viewer: ViewerScope = { tid: A, site: SITE, isS2: true };
  const OBSERVERS: [string, Observer][] = [
    ['getUsers', { read: async (userId) => listed(await getUsers(searchDeps(), viewer, { siteid: SITE, ispublic: 0 }), userId), attempt: ['readAccounts'], lead: 0 }],
    ['getSearch', { read: async (userId) => listed(await getSearch(searchDeps(), viewer, { search: 'Observed', isPublic: 0 }), userId), attempt: ['readAccounts'], lead: 0 }],
    [
      'getAdvancedSearch over both user pools',
      { read: async (userId) => listed(await getAdvancedSearch(searchDeps(), viewer, { ...newAdvancedSearchCriteria(), ispublic: '' }), userId), attempt: ['readAccounts'], lead: 0 },
    ],
    [
      'the Edit User read',
      {
        read: async (userId) => recordSeen(await getJson(`/v1/users/edit?userid=${userId}&ispublic=0`, await headersFor(ADMIN, [Roles.siteAdmin, Roles.systemUser]))),
        attempt: ['readAccount', 'memberships'],
        lead: 0,
      },
    ],
    ['the profile read', { read: async (userId) => recordSeen(await getJson('/v1/profile', await headersFor(userId, [Roles.systemUser]))), attempt: ['readAccount', 'readAccount'], lead: 1 }],
  ];

  it.each(OBSERVERS)('%s reads once with no roster operation in its way, holding no transaction or lock while identity answers', async (_name, observer) => {
    const { userId } = await seedUser();
    expect(await observer.read(userId)).toEqual({ fname: 'Pat', username: 'pat' });
    expect(calls).toEqual(observer.attempt);
    expect(holds).toEqual(observer.attempt.map(() => NO_HOLDS));
  });

  it.each(OBSERVERS)('%s reads again after a roster save completing between its people and identity reads, showing only the new values', async (_name, observer) => {
    const { userId } = await seedUser();
    hook = { at: observer.lead, run: () => rename(userId) };
    expect(await observer.read(userId)).toEqual({ fname: 'Robin', username: 'robin' });
    expect(hook).toBeUndefined();
    expect(calls).toEqual([...observer.attempt, ...observer.attempt.slice(observer.lead)]);
    expect(holds.every((held) => held.transactions === 0 && held.advisoryLocks === 0)).toBe(true);
  });

  it.each(OBSERVERS)('%s reads again after a roster save open before its people read finishes inside it, showing only the new values', async (_name, observer) => {
    const { userId } = await seedUser();
    let prepared: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (prepared = resolve));
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    const save = rename(userId, {
      async at(step) {
        if (step !== 'after-prepare') return;
        prepared();
        await resumed;
      },
    });
    await reached;
    readHook = {
      userId,
      run: async () => {
        resume();
        await save;
      },
    };
    expect(await observer.read(userId)).toEqual({ fname: 'Robin', username: 'robin' });
    expect(readHook).toBeUndefined();
    expect(calls).toEqual(observer.attempt);
  });

  it.each(OBSERVERS)('%s waits out an open operation on the user without holding a transaction or lock, then reads once', async (_name, observer) => {
    const { userId } = await seedUser();
    const holder = await openOperation(userId);
    const polled: Holds[] = [];
    sleep = async () => {
      polled.push(await appHolds());
      if (polled.length === 2) await endOperation(holder.operation_id);
    };
    expect(await observer.read(userId)).toEqual({ fname: 'Pat', username: 'pat' });
    expect(polled).toEqual([NO_HOLDS, NO_HOLDS]);
    expect(calls).toEqual(observer.attempt);
  });

  it.each(OBSERVERS)('%s answers the legacy 503 once the wait for an open operation is spent, reading no identity data', async (_name, observer) => {
    const { userId } = await seedUser();
    const holder = await openOperation(userId);
    clock = advancingClock(2_500);
    try {
      expectClosed(await rejection(observer.read(userId)), holder, userId);
      expect(calls).toEqual(observer.attempt.slice(0, observer.lead));
    } finally {
      await endOperation(holder.operation_id);
    }
  });

  it('waits out an operation that opened between the people and identity reads, then reads again', async () => {
    const { userId } = await seedUser();
    let holder: RosterOperationRow | undefined;
    hook = {
      at: 0,
      run: async () => {
        holder = await openOperation(userId);
      },
    };
    let polls = 0;
    sleep = async () => {
      polls += 1;
      if (holder !== undefined) await endOperation(holder.operation_id);
    };
    expect(listed(await getUsers(searchDeps(), viewer, { siteid: SITE, ispublic: 0 }), userId)).toEqual({ fname: 'Pat', username: 'pat' });
    expect(polls).toBe(1);
    expect(calls).toEqual(['readAccounts', 'readAccounts']);
  });

  it('spends the wait on the injected sleeps when the clock stands still', async () => {
    const { userId } = await seedUser();
    const holder = await openOperation(userId);
    const slept: number[] = [];
    sleep = (ms) => {
      slept.push(ms);
      return Promise.resolve();
    };
    try {
      expectClosed(await rejection(getUsers(searchDeps(), viewer, { siteid: SITE, ispublic: 0 })), holder, userId);
      expect(slept.reduce((sum, ms) => sum + ms, 0)).toBe(USER_CLOSED_WAIT_MS);
    } finally {
      await endOperation(holder.operation_id);
    }
  });

  it.each(OBSERVERS.filter(([name]) => name === 'getUsers' || name === 'the Edit User read'))(
    '%s answers the legacy 503 within the user-closed wait behind an intent holding the user\'s roster lock while it queues for the tenant\'s',
    async (_name, observer) => {
      const { userId } = await seedUser();
      let release: () => void = () => undefined;
      let held: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      const holding = new Promise<void>((resolve) => (held = resolve));
      const reader = inTenant(async (tx) => {
        await repo.lockRosterTenant(tx, 'shared');
        held();
        await released;
      });
      await holding;
      const queued = openOperation(userId);
      const waiting = "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND l.locktype = 'advisory' AND a.usename = $1";
      while ((await handle.adminPool.query(waiting, [handle.roles.app])).rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      clock = { now: () => new Date() };
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const started = Date.now();
      const error = await rejection(observer.read(userId));
      const elapsed = Date.now() - started;
      const whileHeld = await appHolds();
      release();
      await reader;
      await endOperation((await queued).operation_id);
      if (error instanceof StatusError) expect(error.status).toBe(503);
      else expect(error).toBeInstanceOf(OperationBlockedError);
      expect(elapsed).toBeGreaterThanOrEqual(USER_CLOSED_WAIT_MS - 500);
      expect(elapsed).toBeLessThan(USER_CLOSED_WAIT_MS + 1_500);
      expect(whileHeld.transactions).toBeGreaterThanOrEqual(2);
      expect(calls).toEqual([]);
      expect(await appHolds()).toEqual(NO_HOLDS);
    },
  );

  describe('the Edit Address read', () => {
    const readAddress = async (addressId: string): Promise<unknown> =>
      ((await getJson(`/v1/users/address?addressid=${addressId}`, await headersFor(ADMIN, [Roles.siteAdmin, Roles.systemUser]))).address as { city?: unknown }).city;

    it('waits out an open operation on the address owner without holding a transaction or lock, then reads the address', async () => {
      const { userId, addressId } = await seedUser();
      const holder = await openOperation(userId);
      const polled: Holds[] = [];
      sleep = async () => {
        polled.push(await appHolds());
        if (polled.length === 2) await endOperation(holder.operation_id);
      };
      expect(await readAddress(addressId)).toBe('Oslo');
      expect(polled).toEqual([NO_HOLDS, NO_HOLDS]);
      expect(calls).toEqual([]);
    });

    it('answers the legacy 503 once the wait for the owner is spent', async () => {
      const { userId, addressId } = await seedUser();
      const holder = await openOperation(userId);
      clock = advancingClock(2_500);
      try {
        expectClosed(await rejection(readAddress(addressId)), holder, userId);
      } finally {
        await endOperation(holder.operation_id);
      }
    });
  });
});
