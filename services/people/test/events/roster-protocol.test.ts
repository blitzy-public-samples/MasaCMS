/** The roster write protocol through people's four carried Type=2 save entry points, over a throwaway schema and the identity double. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { OperationBlockedError, WRITE_POSITION_HEADER, openOperations, parseWritePosition } from '@opt2/platform/migration-kit';
import { TENANT_A, assertResponseMatchesOpenApi, mintTasksInvokerToken } from '@opt2/platform/testing';
import { SERVICE_NAME } from '../../src/app.js';
import { OperationNotFoundError, main, runResolveOperation } from '../../src/cli.js';
import { createFaultHooks, type InjectedFaults, type RosterStep } from '../../src/domain/faults.js';
import { REQUEST_BUDGET_MS, USER_CLOSED_WAIT_MS, awaitPersonOpen, type RosterKind } from '../../src/domain/roster-protocol.js';
import { HALT_AFTER_MS, RECOVERY_THRESHOLD_MS, type RecoveryDeps } from '../../src/domain/roster-recovery.js';
import { createPeopleEvents } from '../../src/events/publish.js';
import { PERSON_CHANGED_TOPIC } from '../../src/events/topics.js';
import type { LegacyErrors } from '../../src/legacy/identity-client.js';
import { createPeopleRepository, type PeopleRepository } from '../../src/repo/repository.js';
import { FINISH_PENDING_ERROR, type PersonRow, type RosterOperationRow, type RosterState } from '../../src/repo/tables.js';
import { PEOPLE_SWEEP_QUEUE } from '../../src/tasks/port.js';
import { PG_AVAILABLE, createMutableClock, headersFor, userHeaders, withPgApp, type MutableClock, type PgTestApp } from '../helpers/app.js';
import {
  CSV_QUIRK_PERSONS,
  DEFAULT_PEOPLE_SEED,
  MODULE_008_ONLY_PERSON,
  MODULE_USER_A,
  MODULE_USER_A_PERSON,
  SITE_ADMIN_A,
  SYSTEM_USER_A,
  SYSTEM_USER_A_PERSON,
  accountsForSeed,
  seedPeople,
  type TestActor,
} from '../helpers/fixtures.js';
import { createIdentityDouble, type DoubleOperationState } from '../helpers/identity-double.js';

const CONTRACT = parse(readFileSync(fileURLToPath(new URL('../../contracts/openapi.yaml', import.meta.url)), 'utf8')) as object;
const FORM = Object.freeze({ 'content-type': 'application/x-www-form-urlencoded' });
const SITE = TENANT_A.siteId;
const TENANT = TENANT_A.tenantId;
const SEED = DEFAULT_PEOPLE_SEED[TENANT] ?? {};
const CSRF_EXPIRES = '260630130000000';
const CATEGORY = 'CA7E6081-0000-0000-0000000000000001';
const USERNAME_TAKEN: LegacyErrors = Object.freeze({ username: "The username 'robin_roster' that you entered is being used by another user." });
/** The person, address and account values one save posts. */
interface SaveValues {
  fname: string;
  lname: string;
  username: string;
  city: string;
  tags: readonly string[];
}
/** The values every save posts and every successful save leaves on both sides. */
const NEW: Readonly<SaveValues> = Object.freeze({ fname: 'Robin', lname: 'Roster', username: 'robin_roster', city: 'Bergen', tags: ['delta', 'gamma'] });
/** The legacy `server_error` envelope of a people 503. */
const LEGACY_503 = Object.freeze({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
/** How far real time may fall short of a timer's delay. */
const TIMER_SLACK_MS = 50;
/** Longest wait for an asynchronous effect a test observes, such as a held call reaching the double. */
const OBSERVE_TIMEOUT_MS = 5_000;
// Changelog reads stop at the cluster-wide snapshot horizon, which another session's open transaction on the shared server can hold back.
const HORIZON_TIMEOUT_MS = 15_000;
const instant = (): Promise<void> => Promise.resolve();

/** One people app over a seeded throwaway schema, with the faults, clock and repository a case drives. */
interface World extends PgTestApp {
  readonly clock: MutableClock;
  readonly injected: InjectedFaults;
  readonly repo: PeopleRepository;
}

/** One answer of the app, with the time it took. */
interface Answer {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: unknown;
  elapsedMs: number;
}

/** A form post of one entry point. */
interface SaveRequest {
  url: string;
  form: Record<string, string>;
}

/** One carried entry point whose closure includes identity units. */
interface EntryPoint {
  kind: RosterKind;
  actor: TestActor;
  creates: boolean;
  /** Whether the save posts an address, interests and tags as well as person and account values. */
  writesChildren: boolean;
  /** The user one case saves: a fresh id for a create, else a seeded person. */
  target(): string;
  request(userId: string, values?: Partial<SaveValues>): SaveRequest;
  expectSaved(answer: Answer, userId: string): void;
  expectInvalid(answer: Answer, errors: LegacyErrors): void;
}

/** People's rows of a user and identity's account: what the protocol keeps equal on both sides. */
interface BothSides {
  people: Awaited<ReturnType<typeof snapshotPeople>>;
  account: unknown;
}

/** A fresh CF-format id for a created user. */
function newUserId(): string {
  const hex = randomUUID().replace(/-/g, '').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 32)}`;
}

/** The seeded tenant-a person `userId`. */
function seededPerson(userId: string): PersonRow {
  const person = SEED.persons?.find((row) => row.userid === userId);
  if (person === undefined) throw new TypeError(`No seeded tenant-a person ${userId}`);
  return person;
}

/** A form's CSRF pair; the double accepts each token once per session. */
function csrf(): Record<string, string> {
  return { csrf_token: randomUUID(), csrf_token_expires: CSRF_EXPIRES };
}

/** The `cUsers.update` form of a Type=2 update changing person, address, interest, tag and account values. */
function adminUpdateForm(userId: string, values: Partial<SaveValues> = {}): Record<string, string> {
  const merged = { ...NEW, ...values };
  const address = SEED.addresses?.find((row) => row.userid === userId);
  return {
    ...csrf(),
    type: '2',
    action: 'Update',
    userid: userId,
    siteid: SITE,
    fname: merged.fname,
    lname: merged.lname,
    email: seededPerson(userId).email ?? `${merged.username}@tenant-a.opt2.test`,
    username: merged.username,
    ispublic: '0',
    categoryid: CATEGORY,
    tags: merged.tags.join(','),
    ...(address === undefined ? {} : { addressid: address.addressid, city: merged.city }),
  };
}

const ADMIN_ADD: EntryPoint = {
  kind: 'admin-add',
  actor: SITE_ADMIN_A,
  creates: true,
  writesChildren: true,
  target: newUserId,
  request: (userId, values = {}) => {
    const merged = { ...NEW, ...values };
    return {
      url: '/v1/users:update',
      form: {
        ...csrf(),
        type: '2',
        action: 'Add',
        userid: userId,
        siteid: SITE,
        fname: merged.fname,
        lname: merged.lname,
        email: `${merged.username}@tenant-a.opt2.test`,
        username: merged.username,
        password: 'test-only-pass',
        ispublic: '0',
        categoryid: CATEGORY,
        tags: merged.tags.join(','),
        address1: '9 Harbour Road',
        city: merged.city,
      },
    };
  },
  expectSaved: expectAdminSaved,
  expectInvalid: expectFormRerendered,
};

const ADMIN_UPDATE: EntryPoint = {
  kind: 'admin-update',
  actor: SITE_ADMIN_A,
  creates: false,
  writesChildren: true,
  target: () => SYSTEM_USER_A_PERSON.userid,
  request: (userId, values) => ({ url: '/v1/users:update', form: adminUpdateForm(userId, values) }),
  expectSaved: expectAdminSaved,
  expectInvalid: expectFormRerendered,
};

const JSON_SAVE: EntryPoint = {
  kind: 'json-save',
  actor: MODULE_USER_A,
  creates: false,
  writesChildren: false,
  target: () => SYSTEM_USER_A_PERSON.userid,
  request: (userId, values = {}) => {
    const merged = { ...NEW, ...values };
    return {
      url: `/_api/json/v1/${SITE}/user`,
      form: { ...csrf(), userid: userId, siteid: SITE, fname: merged.fname, lname: merged.lname, username: merged.username },
    };
  },
  expectSaved: (answer, userId) => {
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ apiversion: 'v1', data: { userid: userId, fname: NEW.fname, lname: NEW.lname, errors: {} } });
  },
  expectInvalid: (answer, errors) => {
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ apiversion: 'v1', data: { fname: NEW.fname, errors } });
  },
};

const PROFILE_UPDATE: EntryPoint = {
  kind: 'profile-update',
  actor: SYSTEM_USER_A,
  creates: false,
  writesChildren: false,
  target: () => SYSTEM_USER_A.sub,
  request: (userId, values = {}) => {
    const merged = { ...NEW, ...values };
    const form = { ...csrf(), fname: merged.fname, lname: merged.lname, email: seededPerson(userId).email ?? '', username: merged.username };
    return { url: '/v1/profile:update', form };
  },
  expectSaved: (answer) => {
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ written: true, redirect: { action: 'home.redirect', params: {} }, errors: {} });
  },
  expectInvalid: expectFormRerendered,
};

/** Every carried entry point the protocol runs under. */
const ENTRY_POINTS: readonly EntryPoint[] = [ADMIN_ADD, ADMIN_UPDATE, JSON_SAVE, PROFILE_UPDATE];

/** `cUsers.update`'s success: the bean was written and `route()` redirects to the user list. */
function expectAdminSaved(answer: Answer): void {
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ written: true, redirect: { action: 'cUsers.listusers', params: { siteid: SITE } }, errors: {} });
}

/** An admin or profile save's validation answer: nothing written, the form re-rendered from the retained bean and the errors. */
function expectFormRerendered(answer: Answer, errors: LegacyErrors): void {
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ written: false, errors, userBean: { Fname: NEW.fname } });
  expect(answer.body).not.toHaveProperty('redirect');
}

/** The legacy 503 a rejected save answers. */
function expectUnavailable(answer: Answer): void {
  expect(answer.status).toBe(503);
  expect(answer.body).toMatchObject(LEGACY_503);
}

/** Runs `fn` against people over a fresh schema seeded with the fixed people dataset, its accounts held by the identity double. */
async function inWorld(fn: (world: World) => Promise<void>): Promise<void> {
  const clock = createMutableClock();
  const injected: InjectedFaults = {};
  const identity = createIdentityDouble({ clock, accounts: accountsForSeed(DEFAULT_PEOPLE_SEED) });
  const outcome = await withPgApp(
    async (ctx) => {
      await seedPeople(ctx.db, DEFAULT_PEOPLE_SEED);
      await fn({ ...ctx, clock, injected, repo: createPeopleRepository({ clock, schema: ctx.db.schema }) });
      return true as const;
    },
    { identity, clock, faults: createFaultHooks(injected, {}) },
  );
  if (outcome !== true) throw new Error(outcome.reason);
}

/** Sends one request as `actor`, checks the answer against people's contract and times it. */
async function send(world: World, method: 'GET' | 'POST', url: string, actor: TestActor, form?: Record<string, string>): Promise<Answer> {
  const headers = { ...(await userHeaders(actor)), ...(form === undefined ? {} : FORM) };
  const started = performance.now();
  const res = await world.app.inject({ method, url, headers, ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }) });
  const elapsedMs = performance.now() - started;
  assertResponseMatchesOpenApi(CONTRACT, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return { status: res.statusCode, headers: res.headers, body: res.json(), elapsedMs };
}

/** Posts `entry`'s save of `userId` as its actor. */
function save(world: World, entry: EntryPoint, userId: string, values?: Partial<SaveValues>): Promise<Answer> {
  const { url, form } = entry.request(userId, values);
  return send(world, 'POST', url, entry.actor, form);
}

/** `SYSTEM_USER_A`'s Edit Profile read, which shows people's first name beside identity's user name. */
function readProfile(world: World): Promise<Answer> {
  return send(world, 'GET', '/v1/profile', SYSTEM_USER_A);
}

/** People's rows of `userId`: the person without its `row_version`, which a restore moves on, and its child rows. */
async function snapshotPeople(world: World, userId: string) {
  return world.db.withTenant(TENANT, async (tx) => {
    const person = await world.repo.findPerson(tx, userId);
    const { row_version: _version, ...columns } = person ?? { row_version: '' };
    const byJson = <R>(rows: R[]): R[] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      person: person === null ? null : columns,
      addresses: byJson(await world.repo.listAddresses(tx, userId)),
      interests: byJson(await world.repo.listInterests(tx, userId)),
      tags: byJson(await world.repo.listTags(tx, userId)),
      extendData: byJson(await world.repo.listExtendData(tx, [userId])),
    };
  });
}

/** People's rows and identity's account of `userId`. */
async function bothSides(world: World, userId: string): Promise<BothSides> {
  return { people: await snapshotPeople(world, userId), account: structuredClone(world.identity.account(userId)) ?? null };
}

/** Every roster operation of `userId`, oldest first. */
function rosterOperations(world: World, userId: string): Promise<RosterOperationRow[]> {
  return world.db.withTenant(TENANT, async (tx) => {
    const sql = `SELECT * FROM ${tx.schema}.roster_operation WHERE user_id = $1 ORDER BY started_at, updated_at, operation_id`;
    return (await tx.query<RosterOperationRow>(sql, [userId])).rows;
  });
}

/** The single roster operation of `userId`. */
async function rosterOperation(world: World, userId: string): Promise<RosterOperationRow> {
  const operations = await rosterOperations(world, userId);
  expect(operations).toHaveLength(1);
  return operations[0] as RosterOperationRow;
}

/** The outbox rows and the number of changelog rows carrying `operationId`. */
function heldRows(world: World, operationId: string): Promise<{ outbox: { held: boolean; published: boolean }[]; changelog: number }> {
  return world.db.withTenant(TENANT, async (tx) => {
    const outbox = await tx.query<{ held: boolean; published: boolean }>(
      `SELECT held, published_at IS NOT NULL AS published FROM ${tx.schema}.outbox WHERE operation_id = $1 ORDER BY seq`,
      [operationId],
    );
    const changelog = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${tx.schema}.changelog WHERE operation_id = $1`, [operationId]);
    return { outbox: outbox.rows, changelog: changelog.rows[0]?.count ?? 0 };
  });
}

/** The changelog rows the migration `changes` read returns for `operationId` and the status it reports for them, once they are below the horizon. */
async function changesFor(world: World, operationId: string): Promise<{ rows: number; status: string | undefined }> {
  const headers = await headersFor('service:migration');
  const deadline = performance.now() + HORIZON_TIMEOUT_MS;
  for (;;) {
    const url = `/internal/v1/migration/changes?tenantId=${TENANT}&limit=10000`;
    const res = await world.app.inject({ method: 'GET', url, headers });
    expect(res.statusCode).toBe(200);
    assertResponseMatchesOpenApi(CONTRACT, { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    const page = res.json() as { rows: { operationId: string | null }[]; operations: Record<string, string> };
    const rows = page.rows.filter((row) => row.operationId === operationId).length;
    if (rows > 0) return { rows, status: page.operations[operationId] };
    if (performance.now() > deadline) throw new Error(`No changelog row of operation ${operationId} reached the changes horizon`);
    await delay(100);
  }
}

/** The `people.person.changed.v1` envelopes published for `userId`. */
function publishedFor(world: World, userId: string) {
  return world.publisher.published.filter((event) => event.topic === PERSON_CHANGED_TOPIC && event.envelope.aggregateId === userId);
}

/** Delivers one `people-outbox-sweep` task as Cloud Tasks does and returns its totals; every recovery hook must succeed. */
async function sweep(world: World): Promise<{ published: number; hooks: { name: string; ok: boolean }[] }> {
  const name = `${PEOPLE_SWEEP_QUEUE}-${String(Math.floor(world.clock.now().getTime() / 1000))}`;
  const url = '/internal/v1/outbox/sweep';
  const res = await world.app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE_NAME })}`,
      'x-cloudtasks-taskname': name,
      'x-cloudtasks-queuename': PEOPLE_SWEEP_QUEUE,
    },
    payload: { queue: PEOPLE_SWEEP_QUEUE, name, tenantId: null, payload: null },
  });
  expect(res.statusCode).toBe(200);
  assertResponseMatchesOpenApi(CONTRACT, { method: 'POST', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  const result = res.json() as { published: number; hooks: { name: string; ok: boolean }[] };
  expect(result.hooks).toEqual([{ name: 'roster-operations', ok: true }]);
  return result;
}

/** Ages every open operation past `RECOVERY_THRESHOLD_MS` and sweeps once. */
function recover(world: World): ReturnType<typeof sweep> {
  world.clock.advance(RECOVERY_THRESHOLD_MS + 1);
  return sweep(world);
}

/** Resolves once `predicate` holds; fails after `OBSERVE_TIMEOUT_MS`. */
async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = performance.now() + OBSERVE_TIMEOUT_MS;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(10);
  }
}

/** Identity's recorded state of `operationId`; undefined when it never prepared it. */
function identityState(world: World, operationId: string): DoubleOperationState | undefined {
  return world.identity.operation(operationId)?.state;
}

/** An error thrown at `step` by the fault hooks. */
function faultAt(step: RosterStep): Error {
  return new Error(`injected fault ${step}`);
}

/** Recovery collaborators over the world's database, clock and identity double, as `opt2-people` builds them. */
function recoveryDeps(world: World): RecoveryDeps {
  return {
    db: world.db,
    repo: world.repo,
    identity: world.identity.identityClient,
    events: createPeopleEvents(world.repo),
    clock: world.clock,
    logger: world.app.opt2.logger,
  };
}

/** The user is open again on both sides: no `open_operation` row of the operation, no open roster operation, identity not closing it. */
async function expectReopened(world: World, userId: string, operationId: string): Promise<void> {
  expect((await openOperations(world.db)).map((open) => open.operationId)).not.toContain(operationId);
  expect(await world.db.withTenant(TENANT, (tx) => world.repo.findOpenRosterOperation(tx, userId))).toBeNull();
  expect(world.identity.isUserClosed(userId)).toBe(false);
}

/** A rejection is total: both sides as before, the operation rolled back and reopened, and no event or projection of it ever released. */
async function expectRejected(world: World, userId: string, before: BothSides, operationId: string): Promise<void> {
  expect(await bothSides(world, userId)).toEqual(before);
  expect(await rosterOperation(world, userId)).toMatchObject({ operation_id: operationId, state: 'rolled-back' });
  await expectReopened(world, userId, operationId);
  await sweep(world);
  expect(publishedFor(world, userId)).toEqual([]);
  expect((await heldRows(world, operationId)).outbox).toEqual([]);
  expect(await changesFor(world, operationId)).toMatchObject({ status: 'rolled-back' });
}

/** Both sides hold the save's new values, children included where the entry point posts them. */
async function expectNewValues(world: World, entry: EntryPoint, userId: string): Promise<void> {
  const { people, account } = await bothSides(world, userId);
  expect(people.person).toMatchObject({ fname: NEW.fname, lname: NEW.lname });
  expect(account).toMatchObject({ username: NEW.username });
  if (!entry.writesChildren) return;
  expect(people.addresses.map((row) => row.city)).toContain(NEW.city);
  expect(people.interests.map((row) => row.categoryid)).toEqual([CATEGORY]);
  expect(people.tags.map((row) => row.tag).sort()).toEqual(NEW.tags);
}

/** Makes identity's status reads unreachable and spends the request budget at the first one, so the request cannot learn identity's outcome. */
function spendBudgetAtStatus(world: World): Promise<void> {
  world.identity.failAt('status', 'unreachable', { times: Infinity });
  const hold = world.identity.holdAt('status');
  return hold.reached.then(() => {
    world.clock.advance(REQUEST_BUDGET_MS);
    hold.release();
  });
}


describe.skipIf(!PG_AVAILABLE)('roster write protocol against PostgreSQL', () => {
  describe.each(ENTRY_POINTS)('$kind', (entry) => {
    it('answers success only once both sides hold the new values, with both write positions and one released person event', () =>
      inWorld(async (world) => {
        const userId = entry.target();
        const answer = await save(world, entry, userId);
        entry.expectSaved(answer, userId);
        const operation = await rosterOperation(world, userId);
        const { operation_id: operationId } = operation;
        const identityOperation = world.identity.operation(operationId);
        expect(identityOperation).toMatchObject({ kind: entry.creates ? 'create' : 'update', state: 'finished' });
        expect(operation).toMatchObject({ kind: entry.kind, state: 'done', error: null, identity_xid: identityOperation?.xid });
        const raw = answer.headers[WRITE_POSITION_HEADER.toLowerCase()];
        const positions = parseWritePosition(typeof raw === 'number' ? String(raw) : raw);
        expect(positions.get('identity')).toBe(identityOperation?.xid);
        expect(positions.get(SERVICE_NAME)).toMatch(/^\d+$/);
        await expectNewValues(world, entry, userId);
        await expectReopened(world, userId, operationId);
        expect(publishedFor(world, userId)).toHaveLength(1);
        expect(await heldRows(world, operationId)).toMatchObject({ outbox: [{ held: false, published: true }] });
        expect(await changesFor(world, operationId)).toMatchObject({ status: 'done' });
      }));

    it("answers prepare's legacy validation errors unchanged, changing neither side and leaving no operation open", () =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        world.identity.setPrepareErrors(userId, USERNAME_TAKEN);
        entry.expectInvalid(await save(world, entry, userId), USERNAME_TAKEN);
        expect(world.identity.operations.size).toBe(0);
        const { operation_id: operationId } = await rosterOperation(world, userId);
        await expectRejected(world, userId, before, operationId);
      }));

    it.each<[string, (world: World) => void, DoubleOperationState | undefined]>([
      ['identity answering prepare with an error', (world) => world.identity.failAt('prepare', 'error'), undefined],
      ['a people failure right after the durable intent', (world) => Object.assign(world.injected, { 'after-start': faultAt('after-start') }), undefined],
      ["the loss of prepare's reply", (world) => world.identity.failAt('prepare', 'lost-reply'), 'aborted'],
    ])('answers the legacy 503 for %s and leaves the operation started until recovery aborts it, changing neither side', (_label, arm, aborted) =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        arm(world);
        expectUnavailable(await save(world, entry, userId));
        delete world.injected['after-start'];
        const operation = await rosterOperation(world, userId);
        expect(operation).toMatchObject({ state: 'started', before_image: null });
        expect((await openOperations(world.db)).map((open) => open.operationId)).toContain(operation.operation_id);
        expect(await bothSides(world, userId)).toEqual(before);
        await recover(world);
        expect(identityState(world, operation.operation_id)).toBe(aborted);
        await expectRejected(world, userId, before, operation.operation_id);
      }));

    it('aborts identity inline and answers the legacy 503 when the people commit fails', () =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        world.injected['after-prepare'] = faultAt('after-prepare');
        expectUnavailable(await save(world, entry, userId));
        const { operation_id: operationId } = await rosterOperation(world, userId);
        expect(world.identity.operation(operationId)?.history).toEqual(['prepared', 'aborted']);
        await expectRejected(world, userId, before, operationId);
      }));

    it.each<[string, (world: World) => void]>([
      ['identity answering its commit with an error', (world) => world.identity.failAt('commit', 'error')],
      ['a people failure before the identity commit', (world) => Object.assign(world.injected, { 'after-people-commit': faultAt('after-people-commit') })],
    ])("restores people's before-image, aborts identity and answers the legacy 503 for %s while identity is still prepared", (_label, arm) =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        arm(world);
        expectUnavailable(await save(world, entry, userId));
        const { operation_id: operationId } = await rosterOperation(world, userId);
        expect(world.identity.requests.some((request) => request.operationId === 'getAccountOperation')).toBe(true);
        expect(world.identity.operation(operationId)?.history).toEqual(['prepared', 'aborted']);
        await expectRejected(world, userId, before, operationId);
      }));

    it("finishes both sides and answers success when identity committed but its commit reply was lost", () =>
      inWorld(async (world) => {
        const userId = entry.target();
        world.identity.failAt('commit', 'lost-reply');
        entry.expectSaved(await save(world, entry, userId), userId);
        const operation = await rosterOperation(world, userId);
        expect(operation).toMatchObject({ state: 'done', error: null });
        expect(world.identity.operation(operation.operation_id)?.history).toEqual(['prepared', 'committed', 'finished']);
        await expectNewValues(world, entry, userId);
        await expectReopened(world, userId, operation.operation_id);
      }));

    it('answers the legacy 503 for a people failure after the identity commit and keeps the user closed until recovery reverts both sides', () =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        world.injected['after-identity-commit'] = faultAt('after-identity-commit');
        expectUnavailable(await save(world, entry, userId));
        delete world.injected['after-identity-commit'];
        const operation = await rosterOperation(world, userId);
        expect(operation.state).toBe('people-committed');
        expect(identityState(world, operation.operation_id)).toBe('committed');
        expect(world.identity.isUserClosed(userId)).toBe(true);
        expect(publishedFor(world, userId)).toEqual([]);
        expect(await heldRows(world, operation.operation_id)).toMatchObject({ outbox: [{ held: true, published: false }] });
        expect(await changesFor(world, operation.operation_id)).toMatchObject({ status: 'open' });
        await recover(world);
        expect(identityState(world, operation.operation_id)).toBe('reverted');
        await expectRejected(world, userId, before, operation.operation_id);
      }));

    it('answers the legacy 503 when identity committed but stays unreachable for the request budget, and recovery reverts both sides', () =>
      inWorld(async (world) => {
        const userId = entry.target();
        const before = await bothSides(world, userId);
        world.identity.failAt('commit', 'lost-reply');
        const spent = spendBudgetAtStatus(world);
        const answer = await save(world, entry, userId);
        await spent;
        world.identity.clearFaults();
        expectUnavailable(answer);
        const operation = await rosterOperation(world, userId);
        expect(operation.state).toBe('people-committed');
        expect(identityState(world, operation.operation_id)).toBe('committed');
        await recover(world);
        expect(identityState(world, operation.operation_id)).toBe('reverted');
        await expectRejected(world, userId, before, operation.operation_id);
      }));

    it.each<[string, (world: World) => void]>([
      ['identity answering finish with an error', (world) => world.identity.failAt('finish', 'error')],
      ['a people failure before the finish call', (world) => Object.assign(world.injected, { 'after-done': faultAt('after-done') })],
    ])('answers success with both sides committed for %s, and recovery repeats the finish', (_label, arm) =>
      inWorld(async (world) => {
        const userId = entry.target();
        arm(world);
        const answer = await save(world, entry, userId);
        delete world.injected['after-done'];
        entry.expectSaved(answer, userId);
        const operation = await rosterOperation(world, userId);
        expect(operation).toMatchObject({ state: 'done', error: FINISH_PENDING_ERROR });
        expect(identityState(world, operation.operation_id)).toBe('committed');
        await expectNewValues(world, entry, userId);
        expect(publishedFor(world, userId)).toHaveLength(1);
        await recover(world);
        expect(await rosterOperation(world, userId)).toMatchObject({ state: 'done', error: null });
        expect(identityState(world, operation.operation_id)).toBe('finished');
        await expectReopened(world, userId, operation.operation_id);
      }));
  });
});


describe.skipIf(!PG_AVAILABLE)('observers of a user in an open roster operation', () => {
  it('keeps a read of the user waiting until the operation ends, then shows all new values on both sides, never a mix', () =>
    inWorld(async (world) => {
      const userId = ADMIN_UPDATE.target();
      const hold = world.identity.holdAt('commit');
      const saved = save(world, ADMIN_UPDATE, userId);
      await hold.reached;
      const { operation_id: operationId } = await rosterOperation(world, userId);
      const accountReads = (): number => world.identity.requests.filter((request) => request.operationId === 'getAccount').length;
      const readsBefore = accountReads();
      let settled = false;
      const read = readProfile(world).then((answer) => {
        settled = true;
        return { answer, identityAtRead: identityState(world, operationId) };
      });
      await until(() => accountReads() > readsBefore, "the read's account request reaching identity");
      expect(settled).toBe(false);
      hold.release();
      ADMIN_UPDATE.expectSaved(await saved, userId);
      const { answer, identityAtRead } = await read;
      expect(identityAtRead).toBe('finished');
      expect(answer).toMatchObject({ status: 200, body: { user: { UserID: userId, Fname: NEW.fname, UserName: NEW.username } } });
    }));

  it('answers a read the open operation keeps closed past USER_CLOSED_WAIT_MS with the legacy 503', () =>
    inWorld(async (world) => {
      const userId = ADMIN_UPDATE.target();
      const hold = world.identity.holdAt('commit');
      const saved = save(world, ADMIN_UPDATE, userId);
      await hold.reached;
      const blocked = await readProfile(world);
      expectUnavailable(blocked);
      expect(blocked.elapsedMs).toBeGreaterThanOrEqual(USER_CLOSED_WAIT_MS - TIMER_SLACK_MS);
      hold.release();
      ADMIN_UPDATE.expectSaved(await saved, userId);
      expect(await readProfile(world)).toMatchObject({ status: 200, body: { user: { Fname: NEW.fname, UserName: NEW.username } } });
    }), 30_000);

  it('makes a second save of the user wait out USER_CLOSED_WAIT_MS and answer the legacy 503, leaving the first save to succeed alone', () =>
    inWorld(async (world) => {
      const userId = ADMIN_UPDATE.target();
      const hold = world.identity.holdAt('commit');
      const first = save(world, ADMIN_UPDATE, userId);
      await hold.reached;
      const second = await save(world, ADMIN_UPDATE, userId, { fname: 'Casey', username: 'casey_second' });
      expectUnavailable(second);
      expect(second.elapsedMs).toBeGreaterThanOrEqual(USER_CLOSED_WAIT_MS - TIMER_SLACK_MS);
      hold.release();
      ADMIN_UPDATE.expectSaved(await first, userId);
      await expectNewValues(world, ADMIN_UPDATE, userId);
      expect(await rosterOperations(world, userId)).toHaveLength(1);
      expect([...world.identity.operations.values()].filter((operation) => operation.userId === userId)).toHaveLength(1);
    }), 30_000);
});

describe.skipIf(!PG_AVAILABLE)('held rows of an open roster operation', () => {
  it('holds the person event unpublished through a sweep and reports its changelog rows open, then releases exactly one event at done', () =>
    inWorld(async (world) => {
      const userId = ADMIN_UPDATE.target();
      const hold = world.identity.holdAt('commit');
      const saved = save(world, ADMIN_UPDATE, userId);
      await hold.reached;
      const { operation_id: operationId } = await rosterOperation(world, userId);
      const open = await heldRows(world, operationId);
      expect(open.outbox).toEqual([{ held: true, published: false }]);
      expect(open.changelog).toBeGreaterThan(0);
      expect(await changesFor(world, operationId)).toMatchObject({ status: 'open' });
      expect(await sweep(world)).toMatchObject({ published: 0 });
      expect((await heldRows(world, operationId)).outbox).toEqual([{ held: true, published: false }]);
      expect(publishedFor(world, userId)).toEqual([]);
      hold.release();
      ADMIN_UPDATE.expectSaved(await saved, userId);
      expect((await heldRows(world, operationId)).outbox).toEqual([{ held: false, published: true }]);
      const published = publishedFor(world, userId);
      expect(published).toHaveLength(1);
      expect(published[0]?.envelope.payload).toMatchObject({ userId, fname: NEW.fname, lname: NEW.lname });
      expect(await changesFor(world, operationId)).toMatchObject({ status: 'done' });
    }));
});

/** One operation a request left open, as recovery finds it and as one stale sweep resolves it. */
interface StaleOperation {
  label: string;
  userId: string;
  /** Leaves the user's admin update open in the `recorded` states. */
  leaveOpen(world: World, userId: string): Promise<void>;
  recorded: [RosterState, DoubleOperationState | undefined];
  resolved: [RosterState, DoubleOperationState];
  /** Whether resolution rolls both sides back rather than finishing them. */
  rolledBack: boolean;
}

/** An admin update whose identity status reads stay unreachable for the request budget after the commit fails as `commit` makes it. */
async function leaveUnanswered(world: World, userId: string, commit: 'error' | 'lost-reply'): Promise<void> {
  world.identity.failAt('commit', commit);
  const spent = spendBudgetAtStatus(world);
  expectUnavailable(await save(world, ADMIN_UPDATE, userId));
  await spent;
  world.identity.clearFaults();
}

const STALE_OPERATIONS: readonly StaleOperation[] = [
  {
    label: 'started with identity prepared',
    userId: MODULE_USER_A_PERSON.userid,
    leaveOpen: async (world, userId) => {
      world.identity.failAt('prepare', 'lost-reply');
      expectUnavailable(await save(world, ADMIN_UPDATE, userId));
    },
    recorded: ['started', 'prepared'],
    resolved: ['rolled-back', 'aborted'],
    rolledBack: true,
  },
  {
    label: 'people-committed with identity prepared',
    userId: MODULE_008_ONLY_PERSON.userid,
    leaveOpen: (world, userId) => leaveUnanswered(world, userId, 'error'),
    recorded: ['people-committed', 'prepared'],
    resolved: ['rolled-back', 'aborted'],
    rolledBack: true,
  },
  {
    label: 'people-committed with identity committed',
    userId: CSV_QUIRK_PERSONS[0]?.userid ?? '',
    leaveOpen: (world, userId) => leaveUnanswered(world, userId, 'lost-reply'),
    recorded: ['people-committed', 'committed'],
    resolved: ['rolled-back', 'reverted'],
    rolledBack: true,
  },
  {
    label: 'done with the finish pending',
    userId: SYSTEM_USER_A_PERSON.userid,
    leaveOpen: async (world, userId) => {
      world.identity.failAt('finish', 'error');
      ADMIN_UPDATE.expectSaved(await save(world, ADMIN_UPDATE, userId), userId);
    },
    recorded: ['done', 'committed'],
    resolved: ['done', 'finished'],
    rolledBack: false,
  },
];

/** The roster and identity states of every stale operation's user, in `STALE_OPERATIONS` order. */
function staleStates(world: World): Promise<[RosterState, DoubleOperationState | undefined][]> {
  return Promise.all(
    STALE_OPERATIONS.map(async ({ userId }) => {
      const operation = await rosterOperation(world, userId);
      return [operation.state, identityState(world, operation.operation_id)] as [RosterState, DoubleOperationState | undefined];
    }),
  );
}

/** Leaves an admin update people-committed with identity committed, then keeps identity unreachable until recovery halts it. */
async function haltOperation(world: World): Promise<{ userId: string; operationId: string; before: BothSides }> {
  const userId = ADMIN_UPDATE.target();
  const before = await bothSides(world, userId);
  world.injected['after-identity-commit'] = faultAt('after-identity-commit');
  expectUnavailable(await save(world, ADMIN_UPDATE, userId));
  delete world.injected['after-identity-commit'];
  const { operation_id: operationId } = await rosterOperation(world, userId);
  world.identity.setUnreachable(true);
  await recover(world);
  expect(await rosterOperation(world, userId)).toMatchObject({ state: 'people-committed', identity_unreachable_since: world.clock.now() });
  world.clock.advance(HALT_AFTER_MS);
  await recover(world);
  return { userId, operationId, before };
}

describe.skipIf(!PG_AVAILABLE)('roster recovery, halting and opt2-people resolve-operation', () => {
  it('leaves operations younger than RECOVERY_THRESHOLD_MS to their requests and resolves each stale one by its recorded state in one sweep', () =>
    inWorld(async (world) => {
      const startedAt = world.clock.now();
      const before = new Map<string, BothSides>();
      for (const stale of STALE_OPERATIONS) {
        before.set(stale.userId, await bothSides(world, stale.userId));
        await stale.leaveOpen(world, stale.userId);
        world.clock.set(startedAt);
      }
      const recorded = STALE_OPERATIONS.map((stale) => stale.recorded);
      expect(await staleStates(world)).toEqual(recorded);
      await sweep(world);
      expect(await staleStates(world)).toEqual(recorded);
      await recover(world);
      expect(await staleStates(world)).toEqual(STALE_OPERATIONS.map((stale) => stale.resolved));
      for (const stale of STALE_OPERATIONS) {
        const { operation_id: operationId } = await rosterOperation(world, stale.userId);
        await expectReopened(world, stale.userId, operationId);
        if (stale.rolledBack) expect(await bothSides(world, stale.userId), stale.label).toEqual(before.get(stale.userId));
        else await expectNewValues(world, ADMIN_UPDATE, stale.userId);
      }
    }));

  it('halts an operation identity stays unreachable for past HALT_AFTER_MS and keeps its user closed on both sides', () =>
    inWorld(async (world) => {
      const { userId, operationId } = await haltOperation(world);
      expect(await rosterOperation(world, userId)).toMatchObject({ operation_id: operationId, state: 'halted' });
      expect((await openOperations(world.db)).map((open) => open.operationId)).toContain(operationId);
      expect(world.identity.isUserClosed(userId)).toBe(true);
      await expect(awaitPersonOpen(world.db, TENANT, userId, { clock: world.clock, sleep: instant })).rejects.toBeInstanceOf(OperationBlockedError);
      await recover(world);
      expect(await rosterOperation(world, userId)).toMatchObject({ state: 'halted' });
    }));

  it('resolves a halted operation only with resolve-operation --to, restoring both sides and reopening the user', () =>
    inWorld(async (world) => {
      const { userId, operationId, before } = await haltOperation(world);
      world.identity.setUnreachable(false);
      const deps = recoveryDeps(world);
      expect(await runResolveOperation(deps, { operationId })).toEqual({
        report: { operationId, tenantId: TENANT, from: 'halted', to: 'halted', identityState: null, outcome: 'unchanged' },
        settled: false,
      });
      expect(await runResolveOperation(deps, { operationId, to: 'rolled-back' })).toEqual({
        report: { operationId, tenantId: TENANT, from: 'halted', to: 'rolled-back', identityState: 'committed', outcome: 'reverted' },
        settled: true,
      });
      expect(identityState(world, operationId)).toBe('reverted');
      await expectRejected(world, userId, before, operationId);
      expect(await readProfile(world)).toMatchObject({ status: 200, body: { user: { UserID: userId, Fname: SYSTEM_USER_A_PERSON.fname } } });
    }));

  it('exits 2 on a resolve-operation usage error and rejects an operation id no tenant holds with OperationNotFoundError', () =>
    inWorld(async (world) => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(await main(['resolve-operation'], {})).toBe(2);
      } finally {
        stderr.mockRestore();
      }
      await expect(runResolveOperation(recoveryDeps(world), { operationId: newUserId() })).rejects.toBeInstanceOf(OperationNotFoundError);
      expect(world.identity.requests).toEqual([]);
    }));
});

