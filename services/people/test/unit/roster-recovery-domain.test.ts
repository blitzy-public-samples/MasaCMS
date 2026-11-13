/** Roster recovery over a throwaway `people` schema and identity doubles: the state matrix, halting, operator runs and claim ownership against overlapping sweeps and requests. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { closeGates, ensureUnitGates, openGates, openOperations } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { ServiceUnavailableError, fixedClock } from '@opt2/platform/service-kit';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createCapturingPublisher, createThrowawaySchema, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { createFaultHooks, type FaultHooks, type InjectedFaults, type RosterStep } from '../../src/domain/faults.js';
import { normaliseParams } from '../../src/domain/person.js';
import { runRosterOperation, type RosterDeps, type RosterInput } from '../../src/domain/roster-protocol.js';
import {
  HALT_AFTER_MS,
  RECOVERY_THRESHOLD_MS,
  RosterResolutionError,
  recoverRosterOperations,
  resolveOperation,
  type RecoveryDeps,
  type ResolveAction,
  type ResolveTarget,
} from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { peoplePayloadValidators } from '../../src/events/topics.js';
import type { AccountOperationState, AccountView, IdentityClient } from '../../src/legacy/identity-client.js';
import { RosterOperationClaimedError, createPeopleRepository, type PeopleRepository, type PersonInput } from '../../src/repo/repository.js';
import { PEOPLE_UNITS, type RosterOperationRow, type RosterState } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 10, 0, 0, 0);
const A = TENANT_A.tenantId;
const SITE = TENANT_A.siteId;
const ACTOR = { userId: 'ACTOR-0000-0000-0000000000000000001', fname: 'Ada', lname: 'Admin' };
const CAT = { one: cfUuid(), two: cfUuid() };
const instant = (): Promise<void> => Promise.resolve();
const fault = (): Error => new Error('injected fault');

/** `ms` after T0. */
function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

/** Identity's recorded operation states, which every double reads and writes as identity keeps them. */
const identityStates = new Map<string, AccountOperationState>();

/** How one identity double answers; `slow` names the call that waits for `release` before answering. */
interface DoubleBehaviour {
  prepare?: 'ok' | 'lost-reply';
  commit?: 'ok' | 'error' | 'lost-reply';
  stateUnreachable?: boolean;
  down?: boolean;
  slow?: 'state' | 'revert';
}

/** An identity double recording its calls; `reached` resolves once the slow call waits. */
function identityDouble(accounts: Map<string, AccountView>, behaviour: DoubleBehaviour = {}) {
  const calls: string[] = [];
  const down = (): ServiceUnavailableError => new ServiceUnavailableError('identity', new Error('identity down'));
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`unexpected identity call ${name}`));
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  async function enter(name: string): Promise<void> {
    calls.push(name);
    if (behaviour.slow === name) {
      reach();
      await released;
    }
    if (behaviour.down === true) throw down();
  }
  const client: IdentityClient = {
    async prepare(userId, operationId, change) {
      await enter('prepare');
      identityStates.set(operationId, 'prepared');
      if (behaviour.prepare === 'lost-reply') throw down();
      return { ok: true, operationId, userId, kind: change.kind, state: 'prepared' };
    },
    async commit(userId, operationId) {
      await enter('commit');
      if (behaviour.commit === 'error') throw down();
      identityStates.set(operationId, 'committed');
      if (behaviour.commit === 'lost-reply') throw down();
      return { operationId, userId, state: 'committed', writePosition: '777' };
    },
    async abort(_userId, operationId) {
      await enter('abort');
      if (identityStates.get(operationId) === 'prepared') identityStates.set(operationId, 'aborted');
    },
    async revert(_userId, operationId) {
      await enter('revert');
      identityStates.set(operationId, 'reverted');
    },
    async finish(_userId, operationId) {
      await enter('finish');
      identityStates.set(operationId, 'finished');
    },
    async operationState(_userId, operationId) {
      await enter('state');
      if (behaviour.stateUnreachable === true) throw down();
      return identityStates.get(operationId);
    },
    readAccount(userId) {
      calls.push('readAccount');
      return Promise.resolve(accounts.get(userId));
    },
    readAccounts: unused('readAccounts'),
    userMemberships: unused('userMemberships'),
    membershipGroupIds() {
      calls.push('memberships');
      return Promise.resolve(['GROUP-1']);
    },
    siteGroups: unused('siteGroups'),
    userGroups: unused('userGroups'),
    actingUser: unused('actingUser'),
    adminSessionState: unused('adminSessionState'),
    saveAdminSessionState: unused('saveAdminSessionState'),
    sessionSites: unused('sessionSites'),
  };
  return { client, calls, reached, release };
}

/** Verified claims of the acting site administrator. */
function claims(): UserClaims {
  return { iss: 'opt2-local-identity', aud: 'opt2-local', sub: ACTOR.userId, sid: 'SESSION-1', tid: A, site: SITE, roles: ['site-admin'], s2: false, epoch: 1, iat: 0, exp: 4_102_444_800 };
}

/** An admin update of `userId` posting `params` in tenant A. */
function rosterInput(params: Record<string, unknown>): RosterInput {
  return { kind: 'admin-update', tenantId: A, claims: claims(), acting: ACTOR, params: normaliseParams(params), postedFiles: new Map(), requestId: 'REQ-1' };
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

const available = await pgAvailable();

describe.skipIf(!available)('roster recovery against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let schema: string;
  let requestRepo: PeopleRepository;
  const capture = createCapturingPublisher();
  const lines: string[] = [];
  const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: (line: string) => void lines.push(line) } });
  const accounts = new Map<string, AccountView>();
  const OLD = { fname: 'Pat', cities: ['Oslo'] };
  const NEW = { fname: 'Robin', cities: ['Bergen'] };

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    db = handle.app;
    schema = handle.schema;
    await ensureUnitGates(db, PEOPLE_UNITS);
    await closeGates(db, { units: PEOPLE_UNITS, holderId: 'roster-recovery-test', allowLegacy: true });
    await openGates(db, { units: PEOPLE_UNITS, holderId: 'roster-recovery-test', state: 'open' });
    await seedRegistry(db);
    requestRepo = createPeopleRepository({ clock: fixedClock(T0), schema });
    createOutbox({ service: 'people', db, publisher: capture, logger, clock: fixedClock(T0), payloadValidators: peoplePayloadValidators });
  });

  afterAll(async () => {
    await handle.drop();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return db.withTenant(A, fn);
  }

  /** Request collaborators at T0, with `injected` step failures and instant polls. */
  function requestDeps(identity: IdentityClient, injected: InjectedFaults = {}, faults?: FaultHooks): RosterDeps {
    return { db, repo: requestRepo, events: createPeopleEvents(requestRepo), identity, clock: fixedClock(T0), faults: faults ?? createFaultHooks(injected, {}), sleep: instant };
  }

  /** Recovery collaborators whose clock, and repository clock, stand `ms` after T0. */
  function recoveryDeps(identity: IdentityClient, ms: number): RecoveryDeps {
    const clock = fixedClock(at(ms));
    const repo = createPeopleRepository({ clock, schema });
    return { db, repo, identity, events: createPeopleEvents(repo), clock, logger };
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

  /** A stored private user of tenant A with a primary address, and its identity account. */
  async function seedUser(): Promise<{ userId: string; addressId: string }> {
    const userId = cfUuid();
    const addressId = cfUuid();
    await inTenant(async (tx) => {
      await requestRepo.insertPerson(tx, personInput(userId));
      await requestRepo.insertAddress(tx, { userid: userId, addressid: addressId, siteid: SITE, addressname: 'Home', city: 'Oslo', isprimary: 1 });
      await requestRepo.replaceInterests(tx, userId, [CAT.one]);
    });
    accounts.set(userId, { userId, siteId: SITE, username: 'pat', s2: 0, isPublic: 0, inactive: 0, type: 2, perm: 0, admin: 0, remoteId: null, lastLogin: null, passwordCreated: null, tablist: null });
    return { userId, addressId };
  }

  /** The admin update of a seeded user changing its name, address city and interest. */
  function updateParams(userId: string, addressId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { userid: userId, siteid: SITE, type: '2', action: 'Update', fname: 'Robin', username: 'robin', ispublic: '0', categoryid: CAT.two, addressid: addressId, city: 'Bergen', ...extra };
  }

  /** People's rows of `userId`: the person's name and version and the address cities. */
  function snapshot(userId: string) {
    return inTenant(async (tx) => {
      const person = await requestRepo.findPerson(tx, userId);
      return { fname: person?.fname ?? null, rowVersion: person?.row_version ?? null, cities: (await requestRepo.listAddresses(tx, userId)).map((row) => row.city) };
    });
  }

  /** The user's only roster operation. */
  async function onlyOperation(userId: string): Promise<RosterOperationRow> {
    const { rows } = await inTenant((tx) => tx.query<RosterOperationRow>(`SELECT * FROM ${schema}.roster_operation WHERE user_id = $1`, [userId]));
    expect(rows).toHaveLength(1);
    return rows[0] as RosterOperationRow;
  }

  function operation(operationId: string): Promise<RosterOperationRow | null> {
    return inTenant((tx) => requestRepo.findRosterOperation(tx, operationId));
  }

  function outboxOf(operationId: string): Promise<{ held: boolean }[]> {
    return inTenant(async (tx) => (await tx.query<{ held: boolean }>(`SELECT held FROM ${schema}.outbox WHERE operation_id = $1`, [operationId])).rows);
  }

  async function registered(operationId: string): Promise<boolean> {
    return (await openOperations(db)).some((open) => open.operationId === operationId);
  }

  /** Committed changes of the operation into `rolled-back`. */
  async function rolledBackTransitions(operationId: string): Promise<number> {
    const sql =
      `SELECT count(*)::int AS n FROM ${schema}.changelog WHERE "table" = 'roster_operation' AND key LIKE $1` +
      " AND after LIKE '%rolled-back%' AND before NOT LIKE '%rolled-back%'";
    return (await inTenant((tx) => tx.query<{ n: number }>(sql, [`%${operationId}%`]))).rows[0]?.n ?? 0;
  }

  /** A save of a seeded user that a request leaves open with `behaviour` and `injected`; resolves to its operation. */
  async function leftOpen(userId: string, addressId: string, behaviour: DoubleBehaviour, injected: InjectedFaults = {}): Promise<RosterOperationRow> {
    const outcome = runRosterOperation(requestDeps(identityDouble(accounts, behaviour).client, injected), rosterInput(updateParams(userId, addressId)));
    expect(await rejection(outcome)).toBeInstanceOf(LegacyServiceUnavailableError);
    return onlyOperation(userId);
  }

  /** One recovery of the state matrix, from what the request left open to the final state of both sides. */
  interface MatrixCase {
    label: string;
    behaviour?: DoubleBehaviour;
    injected?: InjectedFaults;
    identityState?: AccountOperationState;
    to?: ResolveTarget;
    from: RosterState;
    action: ResolveAction;
    state: RosterState;
    people: typeof OLD;
    rowVersion: string;
    calls: string[];
    outbox: { held: boolean }[];
  }

  it.each<MatrixCase>([
    {
      label: 'aborts a started operation whose prepare reply was lost',
      behaviour: { prepare: 'lost-reply' },
      from: 'started',
      action: 'aborted',
      state: 'rolled-back',
      people: OLD,
      rowVersion: '1',
      calls: ['state', 'abort'],
      outbox: [],
    },
    {
      label: 'aborts identity and restores people for a people-committed operation identity never committed',
      behaviour: { commit: 'error', stateUnreachable: true },
      from: 'people-committed',
      action: 'aborted',
      state: 'rolled-back',
      people: OLD,
      rowVersion: '3',
      calls: ['state', 'abort'],
      outbox: [],
    },
    {
      label: 'reverts identity and restores people for a people-committed operation identity committed',
      injected: { 'after-identity-commit': fault },
      from: 'people-committed',
      action: 'reverted',
      state: 'rolled-back',
      people: OLD,
      rowVersion: '3',
      calls: ['state', 'revert'],
      outbox: [],
    },
    {
      label: 'finishes both sides of a committed operation an operator rolls forward',
      injected: { 'after-identity-commit': fault },
      to: 'done',
      from: 'people-committed',
      action: 'finished',
      state: 'done',
      people: NEW,
      rowVersion: '2',
      calls: ['state', 'finish'],
      outbox: [{ held: false }],
    },
    {
      label: 'rolls people forward without a step once identity has finished',
      injected: { 'after-identity-commit': fault },
      identityState: 'finished',
      from: 'people-committed',
      action: 'finished',
      state: 'done',
      people: NEW,
      rowVersion: '2',
      calls: ['state'],
      outbox: [{ held: false }],
    },
    {
      label: 'repeats the pending finish of a done operation',
      injected: { 'after-done': fault },
      from: 'done',
      action: 'finished',
      state: 'done',
      people: NEW,
      rowVersion: '2',
      calls: ['state', 'finish'],
      outbox: [{ held: false }],
    },
  ])('$label', async (matrix) => {
    const { userId, addressId } = await seedUser();
    const outcome = runRosterOperation(requestDeps(identityDouble(accounts, matrix.behaviour).client, matrix.injected), rosterInput(updateParams(userId, addressId)));
    await outcome.catch(() => undefined);
    const open = await onlyOperation(userId);
    if (matrix.identityState !== undefined) identityStates.set(open.operation_id, matrix.identityState);
    const recovery = identityDouble(accounts);
    const resolved = await resolveOperation(recoveryDeps(recovery.client, RECOVERY_THRESHOLD_MS + 1), { tenantId: A, operationId: open.operation_id, ...(matrix.to === undefined ? {} : { to: matrix.to }) });
    expect(resolved).toMatchObject({ operationId: open.operation_id, from: matrix.from, to: matrix.state, action: matrix.action });
    expect(recovery.calls).toEqual(matrix.calls);
    expect(await snapshot(userId)).toMatchObject({ ...matrix.people, rowVersion: matrix.rowVersion });
    const final = await operation(open.operation_id);
    expect(final).toMatchObject({ state: matrix.state, ...(matrix.state === 'done' ? { error: null } : {}) });
    expect(final?.claimed_by).toEqual(expect.any(String));
    expect(await registered(open.operation_id)).toBe(false);
    expect(await outboxOf(open.operation_id)).toEqual(matrix.outbox);
  });

  it('records identity unreachable, halts past HALT_AFTER_MS until an operator resolves the halted operation at once', async () => {
    const { userId, addressId } = await seedUser();
    const open = await leftOpen(userId, addressId, {}, { 'after-identity-commit': fault });
    const args = { tenantId: A, operationId: open.operation_id };
    const down = identityDouble(accounts, { down: true });
    const first = RECOVERY_THRESHOLD_MS + 1;
    expect(await resolveOperation(recoveryDeps(down.client, first), args)).toMatchObject({ action: 'unchanged', to: 'people-committed' });
    expect(await operation(open.operation_id)).toMatchObject({ state: 'people-committed', identity_unreachable_since: at(first) });

    const halting = first + HALT_AFTER_MS + 1;
    expect(await resolveOperation(recoveryDeps(down.client, halting), args)).toMatchObject({ action: 'halted', to: 'halted' });
    expect(lines.filter((line) => line.includes(`roster operation ${open.operation_id} of user ${userId} halted`))).toHaveLength(1);

    const up = identityDouble(accounts);
    expect(await resolveOperation(recoveryDeps(up.client, halting), args)).toMatchObject({ action: 'unchanged', to: 'halted' });
    expect(up.calls).toEqual([]);
    expect(await resolveOperation(recoveryDeps(up.client, halting), { ...args, to: 'rolled-back' })).toMatchObject({ from: 'halted', to: 'rolled-back', action: 'reverted' });
    expect(up.calls).toEqual(['state', 'revert']);
    expect(await snapshot(userId)).toMatchObject({ ...OLD, rowVersion: '3' });
    expect(await registered(open.operation_id)).toBe(false);
  });

  it('never halts a done operation whose finish is pending, however long identity stays unreachable', async () => {
    const { userId, addressId } = await seedUser();
    const outcome = runRosterOperation(requestDeps(identityDouble(accounts).client, { 'after-done': fault }), rosterInput(updateParams(userId, addressId)));
    expect(await outcome).toMatchObject({ ok: true });
    const open = await onlyOperation(userId);
    const args = { tenantId: A, operationId: open.operation_id };
    const down = identityDouble(accounts, { down: true });
    const step = RECOVERY_THRESHOLD_MS + 1;
    for (const ms of [step, 2 * step + HALT_AFTER_MS]) {
      expect(await resolveOperation(recoveryDeps(down.client, ms), args)).toMatchObject({ action: 'unchanged', to: 'done' });
    }
    expect(await operation(open.operation_id)).toMatchObject({ state: 'done', error: 'finish-pending', identity_unreachable_since: at(step) });
    const up = identityDouble(accounts);
    expect(await resolveOperation(recoveryDeps(up.client, 3 * step + HALT_AFTER_MS), args)).toMatchObject({ action: 'finished', to: 'done' });
    expect(await operation(open.operation_id)).toMatchObject({ state: 'done', error: null });
  });

  it('leaves an operation its request still holds alone: an operator\'s run is refused and a sweep claims nothing', async () => {
    const userId = cfUuid();
    const open = await inTenant((tx) => requestRepo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
    const args = { tenantId: A, operationId: open.operation_id };
    const identity = identityDouble(accounts);
    const fresh = RECOVERY_THRESHOLD_MS - 1;
    expect(await rejection(resolveOperation(recoveryDeps(identity.client, fresh), { ...args, to: 'rolled-back' }))).toBeInstanceOf(RosterResolutionError);
    expect(await resolveOperation(recoveryDeps(identity.client, fresh), args)).toMatchObject({ action: 'unchanged', to: 'started' });
    expect(identity.calls).toEqual([]);
    expect(await operation(open.operation_id)).toMatchObject({ state: 'started', claimed_by: null, updated_at: T0 });
    expect(await resolveOperation(recoveryDeps(identity.client, RECOVERY_THRESHOLD_MS + 1), args)).toMatchObject({ action: 'aborted', to: 'rolled-back' });
  });

  it.each(['state', 'revert'] as const)(
    'lets one of two overlapping sweeps resolve an operation while the first stalls in identity\'s %s, and the first never restores',
    async (slow) => {
      const { userId, addressId } = await seedUser();
      const open = await leftOpen(userId, addressId, {}, { 'after-identity-commit': fault });
      const first = identityDouble(accounts, { slow });
      const stalled = recoverRosterOperations(recoveryDeps(first.client, RECOVERY_THRESHOLD_MS + 10_000));
      await first.reached;

      const second = identityDouble(accounts);
      expect(await recoverRosterOperations(recoveryDeps(second.client, 2 * RECOVERY_THRESHOLD_MS + 20_000))).toEqual({ resolved: 1, halted: 0, failed: 0 });
      expect(second.calls).toEqual(['state', 'revert']);
      expect(await snapshot(userId)).toMatchObject({ ...OLD, rowVersion: '3' });
      // The user is open again, and a later save of it commits.
      const later = runRosterOperation(requestDeps(identityDouble(accounts).client), rosterInput(updateParams(userId, addressId, { fname: 'Lena' })));
      expect(await later).toMatchObject({ ok: true, userId });

      first.release();
      expect(await stalled).toEqual({ resolved: 0, halted: 0, failed: 0 });
      expect(first.calls).toEqual(slow === 'state' ? ['state'] : ['state', 'revert']);
      expect(await snapshot(userId)).toMatchObject({ fname: 'Lena', rowVersion: '4', cities: ['Bergen'] });
      expect(await rolledBackTransitions(open.operation_id)).toBe(1);
      expect(await operation(open.operation_id)).toMatchObject({ state: 'rolled-back' });
      expect(lines.filter((line) => line.includes('recovery failed'))).toEqual([]);
    },
  );

  it.each<[string, RosterStep, DoubleBehaviour, ResolveAction]>([
    ['its done transition', 'after-identity-commit', {}, 'reverted'],
    ['its own before-image restore after a failed identity commit', 'after-people-commit', { commit: 'error' }, 'aborted'],
  ])('refuses %s once a recovery claimed and resolved the operation: the legacy 503, a later save kept', async (_label, stallAt, behaviour, action) => {
    const { userId, addressId } = await seedUser();
    let reach: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const stalling: FaultHooks = {
      async at(step) {
        if (step !== stallAt) return;
        reach();
        await released;
      },
    };
    const identity = identityDouble(accounts, behaviour);
    const request = runRosterOperation(requestDeps(identity.client, {}, stalling), rosterInput(updateParams(userId, addressId)));
    await reached;
    const open = await onlyOperation(userId);
    expect(open).toMatchObject({ state: 'people-committed', claimed_by: null });

    const recovery = identityDouble(accounts);
    const resolved = await resolveOperation(recoveryDeps(recovery.client, RECOVERY_THRESHOLD_MS + 1), { tenantId: A, operationId: open.operation_id });
    expect(resolved).toMatchObject({ action, to: 'rolled-back' });
    expect(await outboxOf(open.operation_id)).toEqual([]);
    const later = runRosterOperation(requestDeps(identityDouble(accounts).client), rosterInput(updateParams(userId, addressId, { fname: 'Lena' })));
    expect(await later).toMatchObject({ ok: true, userId });

    release();
    const error = await rejection(request);
    expect(error).toBeInstanceOf(RosterOperationClaimedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({ reason: 'roster-operation-claimed', operationId: open.operation_id });
    expect(identity.calls).not.toContain('finish');
    expect(await snapshot(userId)).toMatchObject({ fname: 'Lena', rowVersion: '4', cities: ['Bergen'] });
    expect(await operation(open.operation_id)).toMatchObject({ state: 'rolled-back' });
    expect(await rolledBackTransitions(open.operation_id)).toBe(1);
  });
});
