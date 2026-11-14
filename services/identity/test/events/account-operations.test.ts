/** Identity's side of the roster write protocol against PostgreSQL: held membership events, open-operation exclusivity, user closure, gate blocking and the commit write position. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { WRITE_POSITION_HEADER_LC, parseWritePosition, withGatedTenant, type GateRequest } from '@opt2/platform/migration-kit';
import { OUTBOX_SWEEP_INTERVAL_S, slotName } from '@opt2/platform/tasks';
import {
  TENANT_A,
  createThrowawaySchema,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pgAvailable,
  seedRegistry,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { ACCOUNT_OPERATION_UNITS, OperationBlockedError, USER_CLOSED_WAIT_MS, awaitAccountOpen } from '../../src/domain/account-operations.js';
import { addToGroup, type GroupDeps } from '../../src/domain/groups.js';
import { DEFAULT_LOGIN_SETTINGS, login, type LoginDeps } from '../../src/domain/login.js';
import { MEMBERSHIP_CHANGED_TOPIC, createIdentityEvents } from '../../src/events/publish.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { ACCOUNT_OPERATION, CREDENTIAL, IDENTITY_UNITS, LOGIN_STATE, MEMBERSHIP, USER_ACCOUNT, type GroupAccountRow } from '../../src/repo/tables.js';
import { SWEEP_QUEUE, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { SITE_ADMIN_A, TEST_PASSWORDS, groupRow } from '../helpers/rows.js';

const sleepControl = vi.hoisted(() => ({ hook: undefined as ((ms: number) => Promise<void>) | undefined }));

// The app's closed-user waits sleep through a named import of node:timers/promises, which fake timers do not reach.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: async <T>(ms?: number, value?: T, options?: Parameters<typeof actual.setTimeout>[2]): Promise<T> => {
      const hook = sleepControl.hook;
      if (hook === undefined) return actual.setTimeout(ms, value, options);
      await hook(ms ?? 0);
      return value as T;
    },
  };
});

type Step = 'prepare' | 'commit' | 'abort' | 'finish' | 'revert';
type Kind = 'create' | 'update';

interface OperationRow extends Record<string, unknown> {
  operation_id: string;
  user_id: string;
  kind: Kind;
  state: string;
  username: string | null;
  commit_xid: string | null;
}

interface OpenOperationRow extends Record<string, unknown> {
  operation_id: string;
  kind: string;
  units: string[];
}

interface OutboxRow extends Record<string, unknown> {
  event_id: string;
  topic: string;
  held: boolean;
  published_at: Date | null;
  envelope: { eventId: string; payload: unknown };
}

interface GateRow extends Record<string, unknown> {
  unit: string;
  state: string;
  holder_id: string | null;
}

/** The identity rows of one user a roster operation writes. */
interface IdentityRows {
  account: Record<string, unknown> | undefined;
  credential: Record<string, unknown> | undefined;
  loginState: Record<string, unknown> | undefined;
  groupIds: string[];
}

/** An instant sleep summing the delays it is asked for. */
interface SleepRecorder {
  readonly sleep: (ms: number) => Promise<void>;
  total(): number;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const GATE_HOLDER = 'account-operations-events-suite';
const MEMBERSHIP_UNIT = MEMBERSHIP.unit;
const OPEN_STATES = ['prepared', 'committed'];
// Group columns the repository sets itself on insert.
const SERVICE_SET_GROUP_COLUMNS: ReadonlySet<string> = new Set([
  'tenant_id', 'userid', 'passwordcreated', 'lastlogin', 'lastupdate', 'lastupdateby', 'lastupdatebyid', 'created', 'ext', 'admin', 'row_version',
]);
const LEGACY_UNAVAILABLE = { apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } };

// An unset PG_HOST skips the suite without probing the server.
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('identity account operations against PostgreSQL', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let publisher!: CapturingPublisher;
  let clock!: TestApp['clock'];
  let repo!: IdentityRepository;
  let groupOne!: string;
  let groupTwo!: string;

  /** `<throwaway schema>.<table>`. */
  const table = (name: string): string => `${schema.schema}.${name}`;

  /** Rows of `sql` read through the admin pool in one transaction scoped to `tenantId` (tenant-a by default; null for non-tenant tables). */
  async function adminRows<R extends Record<string, unknown>>(sql: string, params: unknown[] = [], tenantId: string | null = TENANT_A.tenantId): Promise<R[]> {
    const client = await schema.adminPool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query<R>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** The `account_operation` row of `operationId`, or undefined. */
  async function opRow(operationId: string): Promise<OperationRow | undefined> {
    const [row] = await adminRows<OperationRow>(
      `SELECT operation_id, user_id, kind, state, username, commit_xid::text AS commit_xid FROM ${table(ACCOUNT_OPERATION.table)} WHERE operation_id = $1`,
      [operationId],
    );
    return row;
  }

  /** The open `account_operation` rows of `userId`. */
  function openRowsOfUser(userId: string): Promise<Array<Pick<OperationRow, 'operation_id' | 'state'>>> {
    return adminRows(`SELECT operation_id, state FROM ${table(ACCOUNT_OPERATION.table)} WHERE user_id = $1 AND state = ANY($2::text[])`, [userId, OPEN_STATES]);
  }

  /** The `open_operation` registrations of `operationId`. */
  function openOperationRows(operationId: string): Promise<OpenOperationRow[]> {
    return adminRows<OpenOperationRow>(`SELECT operation_id, kind, units FROM ${table('open_operation')} WHERE operation_id = $1`, [operationId], null);
  }

  /** The outbox rows `operationId` wrote, in `seq` order. */
  function outboxForOperation(operationId: string): Promise<OutboxRow[]> {
    return adminRows<OutboxRow>(
      `SELECT event_id::text AS event_id, topic, held, published_at, envelope FROM ${table('outbox')} WHERE operation_id = $1 ORDER BY seq`,
      [operationId],
    );
  }

  /** The `unit_gate` row of `unit`. */
  async function gateRow(unit: string): Promise<GateRow | undefined> {
    const [row] = await adminRows<GateRow>(`SELECT unit, state, holder_id FROM ${table('unit_gate')} WHERE unit = $1`, [unit], null);
    return row;
  }

  /** The user's account, credential and login-state rows and sorted group ids. */
  async function identityRows(userId: string): Promise<IdentityRows> {
    const one = async (name: string): Promise<Record<string, unknown> | undefined> =>
      (await adminRows(`SELECT * FROM ${table(name)} WHERE userid = $1`, [userId]))[0];
    const memberships = await adminRows<{ groupid: string }>(`SELECT groupid FROM ${table(MEMBERSHIP.table)} WHERE userid = $1 ORDER BY groupid`, [userId]);
    return {
      account: await one(USER_ACCOUNT.table),
      credential: await one(CREDENTIAL.table),
      loginState: await one(LOGIN_STATE.table),
      groupIds: memberships.map((row) => row.groupid),
    };
  }

  /** Changelog and outbox row counts of tenant-a. */
  async function writeCounts(): Promise<{ changelog: number; outbox: number }> {
    const [row] = await adminRows<{ changelog: number; outbox: number }>(
      `SELECT (SELECT count(*)::int FROM ${table('changelog')}) AS changelog, (SELECT count(*)::int FROM ${table('outbox')}) AS outbox`,
    );
    return row ?? { changelog: 0, outbox: 0 };
  }

  /** Event ids the capturing publisher received. */
  function publishedIds(): string[] {
    return publisher.published.map((event) => event.envelope.eventId);
  }

  /** Headers of people relaying a tenant-a site admin's user token, as the protocol's only caller. */
  async function peopleHeaders(): Promise<Record<string, string>> {
    const [user, people] = await Promise.all([
      mintUserToken({ sub: SITE_ADMIN_A.account.userid, site: TENANT_A.siteId, roles: [Roles.systemUser, Roles.siteAdmin] }),
      mintServiceToken({ caller: 'people', audience: 'identity' }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${people}` };
  }

  /** Injects one step of `operationId` on `userId`, as people unless `headers` are given. */
  async function op(userId: string, operationId: string, step: Step, body?: object, headers?: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/internal/v1/accounts/${userId}/operations/${operationId}:${step}`,
      headers: headers ?? (await peopleHeaders()),
      ...(body === undefined ? {} : { payload: body }),
    });
  }

  /** A prepare body for a tenant-a private-pool roster user. */
  function prepareBody(kind: Kind, username: string, groupIds: readonly string[], account: Record<string, unknown> = {}) {
    return {
      kind,
      siteId: TENANT_A.siteId,
      account: { UserName: username, Password: TEST_PASSWORDS.default, S2: 0, Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2, ...account },
      groupIds: [...groupIds],
    };
  }

  /** An update body that keeps the stored password. */
  function updateBody(username: string, groupIds: readonly string[], account: Record<string, unknown> = {}) {
    return prepareBody('update', username, groupIds, { Password: undefined, ...account });
  }

  /** Prepares an update of `user` to `groupIds` under a fresh operation id; answers the id. */
  async function prepareUpdate(user: { userId: string; username: string }, groupIds: readonly string[]): Promise<string> {
    const operationId = cfUuid();
    expect((await op(user.userId, operationId, 'prepare', updateBody(user.username, groupIds))).statusCode).toBe(200);
    return operationId;
  }

  /** Creates an active tenant-a user in `groupIds` through prepare, commit and finish. */
  async function seedUser(groupIds: readonly string[]): Promise<{ userId: string; username: string }> {
    const userId = cfUuid();
    const username = `roster_${userId.slice(0, 8).toLowerCase()}`;
    const operationId = cfUuid();
    expect((await op(userId, operationId, 'prepare', prepareBody('create', username, groupIds))).statusCode).toBe(200);
    expect((await op(userId, operationId, 'commit')).statusCode).toBe(200);
    expect((await op(userId, operationId, 'finish')).statusCode).toBe(200);
    return { userId, username };
  }

  /** POSTs `body` to the migration gate route as the migration service. */
  async function gate(body: GateRequest) {
    return app.inject({ method: 'POST', url: '/internal/v1/migration/gate', headers: await headersFor('service:migration'), payload: body });
  }

  /** Runs the current slot's outbox sweep task as the local Cloud Tasks adapter delivers it. */
  async function sweep(): Promise<void> {
    const name = slotName(SWEEP_QUEUE, Math.floor(clock.now().getTime() / 1000 / OUTBOX_SWEEP_INTERVAL_S) * OUTBOX_SWEEP_INTERVAL_S);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/outbox/sweep',
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'identity' })}`,
        'x-cloudtasks-taskname': name,
        'x-cloudtasks-queuename': SWEEP_QUEUE,
      },
      payload: { queue: SWEEP_QUEUE, name, tenantId: null, payload: {} },
    });
    expect(res.statusCode).toBe(200);
  }

  /** An instant sleep that sums its delays and runs `onFirst` before the first one returns. */
  function sleepRecorder(onFirst?: () => Promise<void>): SleepRecorder {
    let total = 0;
    let first = onFirst;
    return {
      sleep: async (ms) => {
        total += ms;
        const run = first;
        first = undefined;
        await run?.();
      },
      total: () => total,
    };
  }

  /** A tenant-a private-pool group input named `groupname`. */
  function groupInput(groupname: string): GroupInput {
    const row: Record<string, unknown> = { ...groupRow({ groupname }) };
    return Object.fromEntries(Object.entries(row).filter(([column]) => !SERVICE_SET_GROUP_COLUMNS.has(column))) as GroupInput;
  }

  /** Login dependencies over the throwaway schema, pacing closed-user waits with `sleep`. */
  function loginDeps(sleep: (ms: number) => Promise<void>): LoginDeps {
    return { db: schema.app, repo, clock, settings: DEFAULT_LOGIN_SETTINGS, sleep };
  }

  /** Group dependencies over the throwaway schema, pacing closed-user waits with `sleep`. */
  function groupDeps(sleep: (ms: number) => Promise<void>): GroupDeps {
    return { db: schema.app, repo, events: createIdentityEvents(repo), clock, sleep };
  }

  /** A credential login of `username` into a fresh tenant-a session. */
  function loginAs(deps: LoginDeps, username: string) {
    return login(deps, { username, password: TEST_PASSWORDS.default, sessionId: cfUuid(), mode: 'target-primary', siteId: TENANT_A.siteId });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app, publisher, clock } = await buildTestApp({ db: schema.app }));
    await app.ready();
    repo = createIdentityRepository({ clock, schema: schema.schema });
    const units = [...IDENTITY_UNITS];
    for (const request of [
      { op: 'close', units, holderId: GATE_HOLDER, allowLegacy: true },
      { op: 'open', units, holderId: GATE_HOLDER },
    ] satisfies GateRequest[]) {
      expect((await gate(request)).statusCode).toBe(200);
    }
    const groups = await withGatedTenant(schema.app, TENANT_A.tenantId, async (tx): Promise<GroupAccountRow[]> => [
      await repo.insertGroup(tx, groupInput('Roster Editors'), null),
      await repo.insertGroup(tx, groupInput('Roster Authors'), null),
    ]);
    [groupOne, groupTwo] = groups.map((group) => group.userid) as [string, string];
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  beforeEach(() => {
    publisher.clear();
  });

  afterEach(() => {
    sleepControl.hook = undefined;
  });

  describe('held events', () => {
    it('keeps a membership event held through commit and a sweep, and publishes it with its event id at finish', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupTwo]);

      expect((await op(user.userId, operationId, 'commit')).statusCode).toBe(200);
      const rows = await outboxForOperation(operationId);
      expect(rows).toHaveLength(1);
      const [held] = rows as [OutboxRow];
      expect(held).toMatchObject({ topic: MEMBERSHIP_CHANGED_TOPIC, held: true, published_at: null });
      expect(held.envelope).toMatchObject({ eventId: held.event_id, payload: { userId: user.userId, siteId: TENANT_A.siteId, groupIds: [groupTwo] } });
      expect(publishedIds()).not.toContain(held.event_id);

      await sweep();
      expect(await outboxForOperation(operationId)).toEqual([held]);
      expect(publishedIds()).not.toContain(held.event_id);

      expect((await op(user.userId, operationId, 'finish')).statusCode).toBe(200);
      const [released] = (await outboxForOperation(operationId)) as [OutboxRow];
      expect(released).toMatchObject({ event_id: held.event_id, held: false });
      expect(released.published_at).toBeInstanceOf(Date);
      expect(publisher.published.filter((event) => event.envelope.eventId === held.event_id)).toEqual([
        { topic: MEMBERSHIP_CHANGED_TOPIC, envelope: expect.objectContaining({ eventId: held.event_id, payload: held.envelope.payload }) },
      ]);
    });

    it('aborts a prepared create: deletes its pending account, writes and publishes no event and records aborted', async () => {
      const userId = cfUuid();
      const operationId = cfUuid();
      const username = `roster_abort_${userId.slice(0, 8).toLowerCase()}`;
      expect((await op(userId, operationId, 'prepare', prepareBody('create', username, [groupOne]))).statusCode).toBe(200);
      expect((await identityRows(userId)).account).toMatchObject({ username, opt2_state: 'pending' });

      const aborted = await op(userId, operationId, 'abort');
      expect([aborted.statusCode, aborted.json()]).toEqual([200, { operationId, userId, state: 'aborted' }]);
      const repeated = await op(userId, operationId, 'abort');
      expect([repeated.statusCode, repeated.json()]).toEqual([200, { operationId, userId, state: 'aborted' }]);

      expect(await identityRows(userId)).toEqual({ account: undefined, credential: undefined, loginState: undefined, groupIds: [] });
      expect(await outboxForOperation(operationId)).toEqual([]);
      expect(await openOperationRows(operationId)).toEqual([]);
      expect(await opRow(operationId)).toMatchObject({ state: 'aborted' });
      expect(publisher.published).toEqual([]);
    });

    it('reverts a committed update to the rows recorded at prepare and never publishes its discarded events', async () => {
      const user = await seedUser([groupOne]);
      const before = await identityRows(user.userId);
      const operationId = cfUuid();
      const change = prepareBody('update', `${user.username}_renamed`, [groupTwo], { Password: 'opt2-test-changed', remoteID: 'R-revert' });
      expect((await op(user.userId, operationId, 'prepare', change)).statusCode).toBe(200);
      expect((await op(user.userId, operationId, 'commit')).statusCode).toBe(200);
      const committed = await identityRows(user.userId);
      expect(committed.account).toMatchObject({ username: `${user.username}_renamed`, remoteid: 'R-revert' });
      expect(committed.credential?.password).not.toEqual(before.credential?.password);
      expect(committed.groupIds).toEqual([groupTwo]);
      const discarded = await outboxForOperation(operationId);
      expect(discarded.map((row) => [row.topic, row.held])).toEqual([[MEMBERSHIP_CHANGED_TOPIC, true]]);

      const reverted = await op(user.userId, operationId, 'revert');
      expect([reverted.statusCode, reverted.json()]).toEqual([200, { operationId, userId: user.userId, state: 'reverted' }]);
      expect((await op(user.userId, operationId, 'revert')).json()).toEqual({ operationId, userId: user.userId, state: 'reverted' });

      expect(await identityRows(user.userId)).toEqual(before);
      expect(await outboxForOperation(operationId)).toEqual([]);
      await sweep();
      expect(publishedIds()).not.toContain(discarded[0]?.event_id);
      expect(await opRow(operationId)).toMatchObject({ state: 'reverted' });
      expect(await openOperationRows(operationId)).toEqual([]);
    });

    it('answers repeated prepare, commit and finish with the recorded outcome and writes nothing more', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupTwo]);
      const committed = await op(user.userId, operationId, 'commit');
      expect(committed.statusCode).toBe(200);
      const afterCommit = await writeCounts();

      const prepareAgain = await op(user.userId, operationId, 'prepare', updateBody(user.username, [groupTwo]));
      expect([prepareAgain.statusCode, prepareAgain.json().state]).toEqual([200, 'committed']);
      const commitAgain = await op(user.userId, operationId, 'commit');
      expect([commitAgain.statusCode, commitAgain.json()]).toEqual([200, committed.json()]);
      expect(await writeCounts()).toEqual(afterCommit);

      const finished = await op(user.userId, operationId, 'finish');
      expect(finished.statusCode).toBe(200);
      const afterFinish = await writeCounts();
      const finishAgain = await op(user.userId, operationId, 'finish');
      expect([finishAgain.statusCode, finishAgain.json()]).toEqual([200, finished.json()]);
      expect(await writeCounts()).toEqual(afterFinish);
      expect((await outboxForOperation(operationId)).map((row) => row.held)).toEqual([false]);
    });
  });

  describe('one open operation per user and per username', () => {
    const rawOperations: string[] = [];

    /** Inserts a tenant-a `account_operation` row directly; answers its operation id. */
    async function insertOperationRow(row: { userId: string; username: string; state?: string; kind?: Kind }): Promise<string> {
      const operationId = cfUuid();
      rawOperations.push(operationId);
      await adminRows(
        `INSERT INTO ${table(ACCOUNT_OPERATION.table)} (tenant_id, operation_id, user_id, kind, state, username, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, localtimestamp(3), localtimestamp(3))`,
        [TENANT_A.tenantId, operationId, row.userId, row.kind ?? 'update', row.state ?? 'prepared', row.username],
      );
      return operationId;
    }

    afterEach(async () => {
      await adminRows(`DELETE FROM ${table(ACCOUNT_OPERATION.table)} WHERE operation_id = ANY($1::text[])`, [rawOperations.splice(0)]);
    });

    it.each<[string, (userId: string) => string]>([
      ['the same user id', (userId) => userId],
      ['the user id in another letter case', (userId) => userId.toLowerCase()],
    ])('refuses a second open operation row for %s with 23505', async (_label, sameUser) => {
      const userId = cfUuid();
      await insertOperationRow({ userId, username: `raw_${userId.slice(0, 8)}_one` });

      await expect(insertOperationRow({ userId: sameUser(userId), username: `raw_${userId.slice(0, 8)}_two`, state: 'committed' })).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('refuses open operations of two users named Roster.User and roster.user with 23505', async () => {
      await insertOperationRow({ userId: cfUuid(), username: 'Roster.User', kind: 'create' });

      await expect(insertOperationRow({ userId: cfUuid(), username: 'roster.user', kind: 'create' })).rejects.toMatchObject({ code: '23505' });
    });

    it.each(['finished', 'aborted', 'reverted'])('admits a new open operation for the user and username once the earlier one is %s', async (state) => {
      const userId = cfUuid();
      const earlier = await insertOperationRow({ userId, username: 'Roster.Again' });
      await adminRows(`UPDATE ${table(ACCOUNT_OPERATION.table)} SET state = $2 WHERE operation_id = $1`, [earlier, state]);

      await expect(insertOperationRow({ userId, username: 'roster.again' })).resolves.toEqual(expect.any(String));
    });

    it('answers a second prepare on a user with an open operation with the legacy 503 after the closed-user wait, keeping one open row', async () => {
      const user = await seedUser([groupOne]);
      const first = await prepareUpdate(user, [groupOne]);
      const second = cfUuid();
      const waits = sleepRecorder();
      sleepControl.hook = waits.sleep;

      const res = await op(user.userId, second, 'prepare', updateBody(user.username, [groupTwo]));
      sleepControl.hook = undefined;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(LEGACY_UNAVAILABLE);
      expect(waits.total()).toBe(USER_CLOSED_WAIT_MS);
      expect(await openRowsOfUser(user.userId)).toEqual([{ operation_id: first, state: 'prepared' }]);
      expect(await opRow(second)).toBeUndefined();
      expect(await openOperationRows(second)).toEqual([]);
      expect((await op(user.userId, first, 'abort')).statusCode).toBe(200);
    });

    it('answers a create whose username another open create holds in another letter case with the legacy username error', async () => {
      const holder = { userId: cfUuid(), operationId: cfUuid() };
      expect((await op(holder.userId, holder.operationId, 'prepare', prepareBody('create', 'Roster.Case', []))).statusCode).toBe(200);
      const userId = cfUuid();
      const operationId = cfUuid();

      const res = await op(userId, operationId, 'prepare', prepareBody('create', 'roster.case', []));

      expect([res.statusCode, res.json()]).toEqual([400, { username: "The username 'roster.case' that you entered is being used by another user." }]);
      expect(await opRow(operationId)).toBeUndefined();
      expect(await openOperationRows(operationId)).toEqual([]);
      expect((await identityRows(userId)).account).toBeUndefined();
      expect((await op(holder.userId, holder.operationId, 'abort')).statusCode).toBe(200);
    });
  });

  describe('user closure while an operation is open', () => {
    it('makes a login of the closed user wait out USER_CLOSED_WAIT_MS and refuse with the legacy 503, leaving login_state unchanged', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupOne]);
      const before = await identityRows(user.userId);
      const waits = sleepRecorder();

      const refused = await loginAs(loginDeps(waits.sleep), user.username).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(OperationBlockedError);
      expect(refused).toBeInstanceOf(LegacyServiceUnavailableError);
      expect(waits.total()).toBe(USER_CLOSED_WAIT_MS);
      expect((await identityRows(user.userId)).loginState).toEqual(before.loginState);
      expect((await op(user.userId, operationId, 'abort')).statusCode).toBe(200);
    });

    it('makes addToGroup for the closed user wait out the wait and refuse, writing no membership and no event', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupOne]);
      const counts = await writeCounts();
      const waits = sleepRecorder();

      const refused = await addToGroup(groupDeps(waits.sleep), { userId: user.userId, groupId: groupTwo }).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(OperationBlockedError);
      expect(waits.total()).toBe(USER_CLOSED_WAIT_MS);
      expect((await identityRows(user.userId)).groupIds).toEqual([groupOne]);
      expect(await writeCounts()).toEqual(counts);
      expect((await op(user.userId, operationId, 'abort')).statusCode).toBe(200);
    });

    it('answers a membership removal for the closed user with the legacy 503 after the wait', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupOne]);
      const waits = sleepRecorder();
      sleepControl.hook = waits.sleep;

      const res = await app.inject({ method: 'DELETE', url: `/v1/groups/${groupOne}/members/${user.userId}`, headers: await headersFor(Roles.siteAdmin) });
      sleepControl.hook = undefined;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject(LEGACY_UNAVAILABLE);
      expect(waits.total()).toBe(USER_CLOSED_WAIT_MS);
      expect((await identityRows(user.userId)).groupIds).toEqual([groupOne]);
      expect((await op(user.userId, operationId, 'abort')).statusCode).toBe(200);
    });

    it("refuses awaitAccountOpen while another operation is open and admits the operation's own caller", async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupOne]);
      const waits = sleepRecorder();
      const unused = sleepRecorder();

      await expect(awaitAccountOpen(schema.app, TENANT_A.tenantId, user.userId, { sleep: waits.sleep })).rejects.toBeInstanceOf(OperationBlockedError);
      expect(waits.total()).toBe(USER_CLOSED_WAIT_MS);
      await expect(awaitAccountOpen(schema.app, TENANT_A.tenantId, user.userId, { sleep: unused.sleep, selfOperationId: operationId })).resolves.toBe(0);

      expect((await op(user.userId, operationId, 'abort')).statusCode).toBe(200);
      await expect(awaitAccountOpen(schema.app, TENANT_A.tenantId, user.userId, { sleep: unused.sleep })).resolves.toBe(0);
      expect(unused.total()).toBe(0);
    });

    it('lets a waiting login complete with legacy success once the operation finishes', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupOne]);
      expect((await op(user.userId, operationId, 'commit')).statusCode).toBe(200);
      const before = await identityRows(user.userId);
      const waits = sleepRecorder(async () => {
        expect((await op(user.userId, operationId, 'finish')).statusCode).toBe(200);
      });

      const result = await loginAs(loginDeps(waits.sleep), user.username);

      expect(result).toMatchObject({ ok: true, snapshot: { userid: user.userId, username: user.username } });
      expect(waits.total()).toBeGreaterThan(0);
      expect(waits.total()).toBeLessThan(USER_CLOSED_WAIT_MS);
      expect(await opRow(operationId)).toMatchObject({ state: 'finished' });
      expect(before.loginState).toMatchObject({ lastlogin: null });
      expect((await identityRows(user.userId)).loginState).toMatchObject({ lastlogin: clock.now() });
    });
  });

  describe('open operations against gate closing', () => {
    it('registers every account unit under the operation and keeps identity.membership from closing until finish', async () => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupTwo]);
      const holderId = `account-operations-gate-${cfUuid()}`;

      expect(await openOperationRows(operationId)).toEqual([{ operation_id: operationId, kind: 'roster-account', units: [...ACCOUNT_OPERATION_UNITS] }]);
      const refused = await gate({ op: 'close', units: [MEMBERSHIP_UNIT], holderId, timeoutMs: 1 });
      expect(refused.statusCode).toBe(503);
      expect(await gateRow(MEMBERSHIP_UNIT)).toMatchObject({ state: 'open', holder_id: null });

      let settled = false;
      const closing = gate({ op: 'close', units: [MEMBERSHIP_UNIT], holderId }).finally(() => {
        settled = true;
      });
      expect((await op(user.userId, operationId, 'commit')).statusCode).toBe(200);
      expect(settled).toBe(false);
      expect(await gateRow(MEMBERSHIP_UNIT)).toMatchObject({ state: 'open', holder_id: null });

      expect((await op(user.userId, operationId, 'finish')).statusCode).toBe(200);
      expect(await openOperationRows(operationId)).toEqual([]);
      expect((await closing).statusCode).toBe(200);
      expect(await gateRow(MEMBERSHIP_UNIT)).toMatchObject({ state: 'closed', holder_id: holderId });

      expect((await gate({ op: 'open', units: [MEMBERSHIP_UNIT], holderId })).statusCode).toBe(200);
      expect(await gateRow(MEMBERSHIP_UNIT)).toMatchObject({ state: 'open', holder_id: null });
    });
  });

  describe('commit write position', () => {
    it("answers a commit with its transaction's xid in the body and X-Opt2-Write-Position, as its changelog rows record it", async () => {
      const user = await seedUser([groupOne]);
      const operationId = cfUuid();
      const change = updateBody(user.username, [groupTwo], { Password: 'opt2-test-position' });
      expect((await op(user.userId, operationId, 'prepare', change)).statusCode).toBe(200);
      const [last] = await adminRows<{ seq: string }>(`SELECT coalesce(max(seq), 0)::text AS seq FROM ${table('changelog')}`);

      const res = await op(user.userId, operationId, 'commit');

      expect(res.statusCode).toBe(200);
      const { writePosition } = res.json() as { writePosition: string };
      expect(writePosition).toMatch(/^\d+$/);
      const header = res.headers[WRITE_POSITION_HEADER_LC];
      expect(header).toEqual(expect.any(String));
      expect([...parseWritePosition(String(header))]).toEqual([['identity', writePosition]]);
      const logged = await adminRows<{ xid: string; table: string; operation_id: string | null }>(
        `SELECT xid::text AS xid, "table", operation_id FROM ${table('changelog')} WHERE seq > $1 ORDER BY seq`,
        [last?.seq ?? '0'],
      );
      expect(new Set(logged.map((row) => row.xid))).toEqual(new Set([writePosition]));
      const ofOperation = logged.filter((row) => row.operation_id === operationId).map((row) => row.table);
      expect(ofOperation).toEqual(expect.arrayContaining([ACCOUNT_OPERATION.table, USER_ACCOUNT.table, CREDENTIAL.table, MEMBERSHIP.table]));
      expect(await opRow(operationId)).toMatchObject({ state: 'committed', commit_xid: writePosition });
      expect((await op(user.userId, operationId, 'finish')).statusCode).toBe(200);
    });
  });

  describe('invocation credentials', () => {
    it.each<[string, () => Promise<Record<string, string>>]>([
      ['a user token relayed by the gateway', () => headersFor(Roles.siteAdmin)],
      ["another service's credential", () => headersFor('service:timesheets')],
      ['no credential', async () => ({})],
    ])('refuses every step presented with %s before it runs', async (_label, credentials) => {
      const user = await seedUser([groupOne]);
      const operationId = await prepareUpdate(user, [groupTwo]);
      const headers = await credentials();
      const fresh = cfUuid();

      const prepare = await op(user.userId, fresh, 'prepare', updateBody(user.username, [groupTwo]), headers);
      expect([401, 403]).toContain(prepare.statusCode);
      for (const step of ['commit', 'abort', 'finish', 'revert'] as const) {
        const res = await op(user.userId, operationId, step, undefined, headers);
        expect([401, 403]).toContain(res.statusCode);
      }

      expect(await opRow(fresh)).toBeUndefined();
      expect(await opRow(operationId)).toMatchObject({ state: 'prepared' });
      expect((await identityRows(user.userId)).groupIds).toEqual([groupOne]);
      expect((await op(user.userId, operationId, 'abort')).statusCode).toBe(200);
    });
  });
});
