/** `opt2-people resolve-operation` over a throwaway `people` schema: operations their requests left open, resolved directly and through `main`. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, serviceRole, verifyLocalServiceToken, type UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger, validateLogRecord } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, openOperations } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError, fixedClock, type ServiceClient, type ServiceClientOptions } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createCapturingPublisher, createThrowawaySchema, seedRegistry, testSigningKeys, writeTestSecrets, type ThrowawaySchema } from '@opt2/platform/testing';
import { OperationNotFoundError, main, runResolveOperation } from '../../src/cli.js';
import { createFaultHooks, type InjectedFaults } from '../../src/domain/faults.js';
import { normaliseParams } from '../../src/domain/person.js';
import { runRosterOperation, type RosterDeps, type RosterInput } from '../../src/domain/roster-protocol.js';
import { HALT_AFTER_MS, RosterResolutionError, resolveOperation, type RecoveryDeps } from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { PERSON_CHANGED_TOPIC, peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountOperationState, AccountView, IdentityClient } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type RosterOperationRow } from '../../src/repo/tables.js';
import { STALE, captureWrites, cliEnv } from '../helpers/cli-doubles.js';
import { PG_AVAILABLE } from '../helpers/pg-app.js';

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  createPublisher: vi.fn(),
  createServiceClient: vi.fn(),
  createIdentityClient: vi.fn(),
}));

// Pass-through spies; the main tests replace them to run the CLI over the throwaway schema.
vi.mock('@opt2/platform/tenancy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tenancy')>();
  mocks.createPool.mockImplementation(actual.createPool);
  return { ...actual, createPool: mocks.createPool };
});
vi.mock('@opt2/platform/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/events')>();
  mocks.createPublisher.mockImplementation(actual.createPublisher);
  return { ...actual, createPublisher: mocks.createPublisher };
});
vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  mocks.createServiceClient.mockImplementation(actual.createServiceClient);
  return { ...actual, createServiceClient: mocks.createServiceClient };
});
vi.mock('../../src/legacy/identity-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/legacy/identity-client.js')>();
  mocks.createIdentityClient.mockImplementation(actual.createIdentityClient);
  return { ...actual, createIdentityClient: mocks.createIdentityClient };
});

// An hour back, so the CLI's real clock in the main test sees every operation as stale.
const T0 = new Date(Date.now() - 3_600_000);
T0.setMilliseconds(0);
const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const ACTOR = { userId: 'ACTOR-0000-0000-0000000000000000001', fname: 'Ada', lname: 'Admin' };
const instant = (): Promise<void> => Promise.resolve();
const fault = (): Error => new Error('injected fault');

/** Identity's recorded operation states, shared by every double as identity keeps them. */
const identityStates = new Map<string, AccountOperationState>();

/** How one identity double answers. */
interface DoubleBehaviour {
  commit?: 'ok' | 'error';
  stateUnreachable?: boolean;
  down?: boolean;
}

/** An identity double recording the account-operation calls it receives. */
function identityDouble(accounts: Map<string, AccountView>, behaviour: DoubleBehaviour = {}) {
  const calls: string[] = [];
  const down = (): ServiceUnavailableError => new ServiceUnavailableError('identity', new Error('identity down'));
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
  function enter(name: string): void {
    calls.push(name);
    if (behaviour.down === true) throw down();
  }
  const client: IdentityClient = {
    async prepare(userId, operationId, change) {
      enter('prepare');
      identityStates.set(operationId, 'prepared');
      return { ok: true, operationId, userId, kind: change.kind, state: 'prepared' };
    },
    async commit(userId, operationId) {
      enter('commit');
      if (behaviour.commit === 'error') throw down();
      identityStates.set(operationId, 'committed');
      const account = accounts.get(userId);
      if (account === undefined) throw new Error(`no account ${userId}`);
      return { operationId, userId, state: 'committed', writePosition: '777', account, groupIds: ['GROUP-1'] };
    },
    async abort(_userId, operationId) {
      enter('abort');
      if (identityStates.get(operationId) === 'prepared') identityStates.set(operationId, 'aborted');
    },
    async revert(_userId, operationId) {
      enter('revert');
      identityStates.set(operationId, 'reverted');
    },
    async finish(_userId, operationId) {
      enter('finish');
      identityStates.set(operationId, 'finished');
    },
    async operationState(_userId, operationId) {
      enter('state');
      if (behaviour.stateUnreachable === true) throw down();
      return identityStates.get(operationId);
    },
    readAccount: (userId) => Promise.resolve(accounts.get(userId)),
    readAccounts: unused('readAccounts'),
    readAccountsAllSites: unused('readAccountsAllSites'),
    countAccounts: unused('countAccounts'),
    usernameCandidates: unused('usernameCandidates'),
    lookupMemberships: unused('lookupMemberships'),
    userMemberships: unused('userMemberships'),
    membershipGroupIds: () => Promise.resolve(['GROUP-1']),
    siteGroups: unused('siteGroups'),
    userGroupsPage: unused('userGroupsPage'),
    actingUser: unused('actingUser'),
    adminSessionState: unused('adminSessionState'),
    saveAdminSessionState: unused('saveAdminSessionState'),
    sessionSites: unused('sessionSites'),
    loginBlock: unused('loginBlock'),
    groupFavoriteIds: unused('groupFavoriteIds'),
  };
  return { client, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!PG_AVAILABLE)('resolve-operation against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let schema: string;
  let requestRepo: PeopleRepository;
  const capture = createCapturingPublisher();
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  const accounts = new Map<string, AccountView>();

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    schema = handle.schema;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'cli-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'cli-test', state: 'open' });
    await seedRegistry(db);
    requestRepo = createPeopleRepository({ clock: fixedClock(T0), schema });
  });

  beforeEach(() => {
    capture.clear();
    // The main test registers its own runtime for this schema; every other test publishes through the capture.
    createOutbox({ service: 'people', db, publisher: capture, logger, clock: fixedClock(T0), payloadValidators: peoplePayloadValidators });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(A, fn);
  }

  function requestDeps(identity: IdentityClient, injected: InjectedFaults = {}): RosterDeps {
    return { db, repo: requestRepo, events: createPeopleEvents(requestRepo), identity, clock: fixedClock(T0), faults: createFaultHooks(injected, {}), sleep: instant };
  }

  /** Recovery collaborators whose clock stands `ms` after T0. */
  function recoveryDeps(identity: IdentityClient, ms = STALE): RecoveryDeps {
    const clock = fixedClock(new Date(T0.getTime() + ms));
    const repo = createPeopleRepository({ clock, schema });
    return { db, repo, identity, events: createPeopleEvents(repo), clock, logger };
  }

  function claims(): UserClaims {
    return { iss: 'opt2-local-identity', aud: 'opt2-local', sub: ACTOR.userId, sid: 'SESSION-1', tid: A, site: SITE, roles: ['site-admin'], s2: false, epoch: 1, iat: 0, exp: 4_102_444_800 };
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
      tags: 'old',
    };
  }

  /** A stored private user of tenant A with a primary address, and its identity account. */
  async function seedUser(): Promise<{ userId: string; addressId: string }> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await inTenant(async (tx) => {
      await requestRepo.insertPerson(tx, personInput(userId));
      await requestRepo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: SITE, addressname: 'Home', city: 'Oslo', isprimary: 1 });
    });
    accounts.set(userId, { userId, siteId: SITE, username: 'pat', s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null, lastLogin: null, passwordCreated: null, tablist: null });
    return { userId, addressId };
  }

  function rosterInput(userId: string, addressId: string, fname = 'Robin'): RosterInput {
    const params = { userid: userId, siteid: SITE, type: '2', action: 'Update', fname, username: 'robin', ispublic: '0', addressid: addressId, city: 'Bergen' };
    return { kind: 'admin-update', tenantId: A, claims: claims(), acting: ACTOR, params: normaliseParams(params), postedFiles: new Map(), requestId: 'REQ-1' };
  }

  /** A save of a fresh user that its request leaves open as `behaviour` and `injected` make it; resolves to the operation. */
  async function leftOpen(behaviour: DoubleBehaviour, injected: InjectedFaults = {}): Promise<{ userId: string; addressId: string; operation: RosterOperationRow }> {
    const { userId, addressId } = await seedUser();
    const outcome = runRosterOperation(requestDeps(identityDouble(accounts, behaviour).client, injected), rosterInput(userId, addressId));
    await expect(outcome).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    const { rows } = await inTenant((tx) => tx.query<RosterOperationRow>(`SELECT * FROM ${schema}.roster_operation WHERE user_id = $1`, [userId]));
    expect(rows).toHaveLength(1);
    return { userId, addressId, operation: rows[0] as RosterOperationRow };
  }

  function operation(operationId: string): Promise<RosterOperationRow | null> {
    return inTenant((tx) => requestRepo.findRosterOperation(tx, operationId));
  }

  function heldFlags(operationId: string): Promise<boolean[]> {
    return inTenant(async (tx) => (await tx.query<{ held: boolean }>(`SELECT held FROM ${schema}.outbox WHERE operation_id = $1`, [operationId])).rows.map((row) => row.held));
  }

  async function isOpen(operationId: string): Promise<boolean> {
    return (await openOperations(db)).some((open) => open.operationId === operationId);
  }

  it.each([
    ['registered', false],
    ['deleted from the registry', true],
  ])('aborts identity and rolls people back for an operation identity only prepared, found through the registry with its site %s', async (_label, deleted) => {
    const { operation: open } = await leftOpen({ commit: 'error', stateUnreachable: true });
    const identity = identityDouble(accounts);
    if (deleted) await db.withMetadata((tx) => tx.query(`UPDATE ${schema}.tenant_registry SET deleted = true WHERE tenant_id = $1`, [A]));
    try {
      const run = await runResolveOperation(recoveryDeps(identity.client), { operationId: open.operation_id });
      expect(run).toEqual({
        report: { operationId: open.operation_id, tenantId: A, from: 'people-committed', to: 'rolled-back', identityState: 'prepared', outcome: 'aborted' },
        settled: true,
      });
    } finally {
      await seedRegistry(db);
    }
    expect(identity.calls).toEqual(['state', 'abort']);
    expect(await operation(open.operation_id)).toMatchObject({ state: 'rolled-back' });
    expect(await heldFlags(open.operation_id)).toEqual([]);
  });

  it('finishes a committed operation with --to done, releasing its held event and reopening the user', async () => {
    const { userId, addressId, operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    expect(await heldFlags(open.operation_id)).toEqual([true]);
    const identity = identityDouble(accounts);
    const run = await runResolveOperation(recoveryDeps(identity.client), { operationId: open.operation_id, to: 'done', tenant: A });
    expect(run).toEqual({
      report: { operationId: open.operation_id, tenantId: A, from: 'people-committed', to: 'done', identityState: 'committed', outcome: 'finished' },
      settled: true,
    });
    expect(identity.calls).toEqual(['state', 'finish']);
    expect(await heldFlags(open.operation_id)).toEqual([false]);
    expect(capture.published.map((event) => event.topic)).toEqual([PERSON_CHANGED_TOPIC]);
    expect(await isOpen(open.operation_id)).toBe(false);
    // No OperationBlockedError: a later save of the user commits.
    const later = runRosterOperation(requestDeps(identityDouble(accounts).client), rosterInput(userId, addressId, 'Lena'));
    await expect(later).resolves.toMatchObject({ ok: true, userId });
  });

  it('reverts identity and restores people for a committed operation with --to rolled-back', async () => {
    const { userId, operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    const identity = identityDouble(accounts);
    const run = await runResolveOperation(recoveryDeps(identity.client), { operationId: open.operation_id, to: 'rolled-back' });
    expect(run.report).toMatchObject({ from: 'people-committed', to: 'rolled-back', identityState: 'committed', outcome: 'reverted' });
    expect(run.settled).toBe(true);
    expect(identity.calls).toEqual(['state', 'revert']);
    expect(await inTenant((tx) => requestRepo.findPerson(tx, userId))).toMatchObject({ fname: 'Pat' });
    expect(await heldFlags(open.operation_id)).toEqual([]);
  });

  it('refuses --to rolled-back once identity has finished and changes nothing', async () => {
    const { operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    identityStates.set(open.operation_id, 'finished');
    const identity = identityDouble(accounts);
    await expect(runResolveOperation(recoveryDeps(identity.client), { operationId: open.operation_id, to: 'rolled-back' })).rejects.toBeInstanceOf(RosterResolutionError);
    expect(identity.calls).toEqual(['state']);
    expect(await operation(open.operation_id)).toMatchObject({ state: 'people-committed', before_image: open.before_image });
    expect(await heldFlags(open.operation_id)).toEqual([true]);
    expect(await isOpen(open.operation_id)).toBe(true);
  });

  it.each([undefined, A])('throws OperationNotFoundError for an unknown operation id (tenant %s)', async (tenant) => {
    const identity = identityDouble(accounts);
    const args = { operationId: cfUuid(), ...(tenant === undefined ? {} : { tenant }) };
    await expect(runResolveOperation(recoveryDeps(identity.client), args)).rejects.toBeInstanceOf(OperationNotFoundError);
    expect(identity.calls).toEqual([]);
  });

  it('reports a halted operation without --to as unchanged and unsettled, and resolves it with --to', async () => {
    const { operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    const args = { tenantId: A, operationId: open.operation_id };
    const down = identityDouble(accounts, { down: true });
    await resolveOperation(recoveryDeps(down.client), args);
    await expect(resolveOperation(recoveryDeps(down.client, 2 * STALE + HALT_AFTER_MS), args)).resolves.toMatchObject({ action: 'halted' });

    const up = identityDouble(accounts);
    const unchanged = await runResolveOperation(recoveryDeps(up.client), { operationId: open.operation_id });
    expect(unchanged).toEqual({
      report: { operationId: open.operation_id, tenantId: A, from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' },
      settled: false,
    });
    expect(up.calls).toEqual([]);
    const resolved = await runResolveOperation(recoveryDeps(up.client), { operationId: open.operation_id, to: 'rolled-back' });
    expect(resolved).toMatchObject({ report: { from: 'halted', to: 'rolled-back', outcome: 'reverted' }, settled: true });
    expect(up.calls).toEqual(['state', 'revert']);
  });

  it('runs through main as service people: one report line, exit 0, and the publisher, client and pool closed', async () => {
    const { operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    const end = vi.fn(() => Promise.resolve());
    const pool: TenantDb = { schema: db.schema, withTenant: (tenantId, fn, options) => db.withTenant(tenantId, fn, options), withMetadata: (fn, options) => db.withMetadata(fn, options), end };
    const publisher = createCapturingPublisher();
    const closePublisher = vi.spyOn(publisher, 'close');
    const client: ServiceClient = { request: vi.fn(() => Promise.reject(new Error('unexpected service call'))), close: vi.fn(() => Promise.resolve()) };
    const identity = identityDouble(accounts);
    mocks.createPool.mockResolvedValueOnce(pool);
    mocks.createPublisher.mockReturnValueOnce(publisher);
    mocks.createServiceClient.mockReturnValueOnce(client);
    mocks.createIdentityClient.mockReturnValueOnce(identity.client);
    const stateDir = await mkdtemp(join(tmpdir(), 'opt2-people-cli-'));
    await writeTestSecrets(stateDir);
    const stdout = captureWrites(process.stdout);
    captureWrites(process.stderr);

    try {
      expect(await main(['resolve-operation', open.operation_id, '--to', 'done'], cliEnv({ OPT2_STATE_DIR: stateDir }))).toBe(0);
      // The credential identity's account-operation routes check: a local `service:people` token for the callee.
      const { credentials } = mocks.createServiceClient.mock.calls[0]?.[0] as ServiceClientOptions;
      const token = (await credentials.headersFor({ name: 'identity' }))[INVOCATION_HEADER]?.replace(/^Bearer /, '') ?? '';
      const verified = await verifyLocalServiceToken(token, { publicKey: (await testSigningKeys()).publicKey, audience: 'identity' });
      expect(verified).toMatchObject({ name: 'people', roles: expect.arrayContaining([serviceRole('people')]) });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] as string)).toEqual({ operationId: open.operation_id, tenantId: A, from: 'people-committed', to: 'done', identityState: 'committed', outcome: 'finished' });
    expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({ schema: 'people', applicationName: 'opt2-people-cli' }));
    expect(mocks.createServiceClient).toHaveBeenCalledWith(expect.objectContaining({ self: 'people', serviceUrls: { identity: 'http://127.0.0.1:8111' } }));
    expect(mocks.createIdentityClient).toHaveBeenCalledWith(client);
    expect(publisher.published.map((event) => event.topic)).toEqual([PERSON_CHANGED_TOPIC]);
    expect(closePublisher).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  /** A committed operation identity has finished, which only rolling forward can resolve. */
  async function finishedAtIdentity(): Promise<string> {
    const { operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    identityStates.set(open.operation_id, 'finished');
    return open.operation_id;
  }

  /** A committed operation that recovery halted while identity was unreachable. */
  async function halted(): Promise<string> {
    const { operation: open } = await leftOpen({}, { 'after-identity-commit': fault });
    const down = identityDouble(accounts, { down: true }).client;
    const args = { tenantId: A, operationId: open.operation_id };
    await resolveOperation(recoveryDeps(down), args);
    await resolveOperation(recoveryDeps(down, 2 * STALE + HALT_AFTER_MS), args);
    return open.operation_id;
  }

  /** An operation started just now, which its request still holds. */
  async function freshlyStarted(): Promise<string> {
    const repo = createPeopleRepository({ schema });
    return (await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId: cfUuid(), payload: '{}' }))).operation_id;
  }

  it.each<[string, () => Promise<string>, string[], DoubleBehaviour, string, string | undefined]>([
    ['an unknown operation', () => Promise.resolve(cfUuid()), ['--tenant', A], {}, 'no searched tenant holds the roster operation', 'OperationNotFoundError'],
    [
      'a refused combination',
      finishedAtIdentity,
      ['--to', 'rolled-back'],
      {},
      'roster operation refused: its recorded states do not allow the resolution, or another resolution holds it',
      'RosterResolutionError',
    ],
    ['identity unavailable', finishedAtIdentity, ['--to', 'done'], { down: true }, 'identity unavailable; rerun later', 'ServiceUnavailableError'],
    ['an operation left halted', halted, [], {}, 'roster operation is halted; rerun with --to rolled-back or --to done', undefined],
    [
      'an operation its request holds',
      freshlyStarted,
      [],
      {},
      'roster operation is still started: its request or another resolution holds it, or identity is unreachable; rerun later',
      undefined,
    ],
  ])('exits 1 for %s with one fixed log-record.v1 line on stderr, closing everything it opened', async (_label, setUp, flags, behaviour, problem, errorType) => {
    const operationId = await setUp();
    const end = vi.fn(() => Promise.resolve());
    mocks.createPool.mockResolvedValueOnce({ schema: db.schema, withTenant: db.withTenant.bind(db), withMetadata: db.withMetadata.bind(db), end } satisfies TenantDb);
    mocks.createPublisher.mockReturnValueOnce(createCapturingPublisher());
    mocks.createIdentityClient.mockReturnValueOnce(identityDouble(accounts, behaviour).client);
    captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    expect(await main(['resolve-operation', operationId, ...flags], cliEnv())).toBe(1);
    expect(stderr).toHaveLength(1);
    const record = JSON.parse(stderr[0] as string) as Record<string, unknown>;
    expect(validateLogRecord(record)).toStrictEqual({ valid: true, errors: [] });
    expect(record).toMatchObject({ severity: 'ERROR', service: 'people', message: `opt2-people: ${problem}` });
    if (errorType === undefined) expect(record).not.toHaveProperty('error');
    else expect(record).toMatchObject({ error: { type: errorType } });
    expect(stderr.join('')).not.toContain(operationId);
    expect(end).toHaveBeenCalledOnce();
  });
});
