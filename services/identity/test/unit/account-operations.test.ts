/** Identity's side of the roster write protocol on the memory repo: operation steps, user closure, session effects and the people-only routes. */
import bcrypt from 'bcryptjs';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import { OperationBlockedError } from '@opt2/platform/migration-kit';
import { TENANT_A, TENANT_B, TENANT_LIST, fixedClock, registryPayloads } from '@opt2/platform/testing';
import {
  ACCOUNT_OPERATION_UNITS,
  AccountSaveHaltedError,
  DEFAULT_ACCOUNT_SETTINGS,
  USER_CLOSED_WAIT_MS,
  abortAccountOperation,
  accountOperationStatus,
  awaitAccountOpen,
  commitAccountOperation,
  finishAccountOperation,
  operationStatus,
  prepareAccountOperation,
  randomPassword,
  revertAccountOperation,
  withOpenAccount,
  type AccountChange,
  type AccountOperationDeps,
  type CommitOutcome,
  type PrepareInput,
  type SessionEffects,
  type StepInput,
  type StepOutcome,
} from '../../src/domain/account-operations.js';
import { MEMBERSHIP_CHANGED_TOPIC, createIdentityEvents } from '../../src/events/publish.js';
import { ACCOUNT_OPERATION, CREDENTIAL, LOGIN_STATE, MEMBERSHIP, SESSION, USER_ACCOUNT, type AccountOperationState, type LoginSnapshot } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import type { IdentitySeed, RecordedWrite } from '../helpers/memory-repo.js';
import { POOLED_MEMBER, SITE_ADMIN_A, TEST_PASSWORDS, accountRow, actorSeed, groupRow, loginSnapshotFixture, sessionRow } from '../helpers/rows.js';

// Vitest's fake timers do not patch node:timers/promises, which the closed-user wait sleeps on, so its setTimeout is
// routed through the global one they do patch.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: (delay?: number, value?: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        globalThis.setTimeout(() => resolve(value), delay);
      }),
  };
});

type Step = 'commit' | 'abort' | 'finish' | 'revert';

const CLOCK = fixedClock(new Date(2026, 5, 30, 15, 0, 0, 0));
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout'] };
const TENANT = TENANT_A.tenantId;
const OPEN_OPERATION = 'identity.open_operation';
const OUTBOX = 'identity.outbox';
const OPERATION_KIND = 'roster-account';
const USERNAME_TAKEN = (username: string): string => `The username '${username}' that you entered is being used by another user.`;

const EDITORS = groupRow({ groupname: 'Editors' });
const ADMIN_GROUP_IDS = SITE_ADMIN_A.memberships.map((membership) => membership.groupid);
const OTHER_POOL_USERNAME = 'other_pool_user';
const SELF_SESSION = sessionRow({
  user_id: SITE_ADMIN_A.account.userid,
  login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: SITE_ADMIN_A })),
});
const ACTORS = actorSeed(SITE_ADMIN_A, POOLED_MEMBER);
const SEED: IdentitySeed = {
  ...ACTORS,
  accounts: [...(ACTORS.accounts ?? []), accountRow({ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId, username: OTHER_POOL_USERNAME })],
  groups: [...(ACTORS.groups ?? []), EDITORS],
  sessions: [SELF_SESSION],
};
const SETTINGS = { ...DEFAULT_ACCOUNT_SETTINGS, password: { ...DEFAULT_ACCOUNT_SETTINGS.password, bcryptLogRounds: 4 } };

const STEP_CALLS: Readonly<Record<Step, (deps: AccountOperationDeps, operationId: string, input: StepInput) => Promise<CommitOutcome | StepOutcome>>> = {
  commit: commitAccountOperation,
  abort: abortAccountOperation,
  finish: finishAccountOperation,
  revert: revertAccountOperation,
};

const PATHS: Readonly<Record<AccountOperationState, readonly Step[]>> = {
  prepared: [],
  committed: ['commit'],
  finished: ['commit', 'finish'],
  aborted: ['abort'],
  reverted: ['commit', 'revert'],
};

const TENANT_OF_SITE: ReadonlyMap<string, string> = new Map(TENANT_LIST.map((fixture) => [fixture.siteId, fixture.tenantId]));

/** `tenant_registry` rows of the platform's three fixture sites, ordered by site id. */
const REGISTRY_ROWS = registryPayloads()
  .map((site) => {
    const tenantOf = (siteId: string | null | undefined): string | null => TENANT_OF_SITE.get(siteId ?? '') ?? null;
    const contentPool = [site.contentPoolIds ?? []].flat();
    return {
      site_id: site.siteId,
      tenant_id: tenantOf(site.siteId),
      public_user_pool_id: site.publicUserPoolId ?? null,
      private_user_pool_id: site.privateUserPoolId ?? null,
      category_pool_id: site.categoryPoolId ?? null,
      file_pool_id: site.filePoolId ?? null,
      display_pool_id: site.displayPoolId ?? null,
      content_pool_ids: contentPool,
      public_user_pool_tenant: tenantOf(site.publicUserPoolId),
      private_user_pool_tenant: tenantOf(site.privateUserPoolId),
      category_pool_tenant: tenantOf(site.categoryPoolId),
      file_pool_tenant: tenantOf(site.filePoolId),
      display_pool_tenant: tenantOf(site.displayPoolId),
      content_pool_tenants: contentPool.map(tenantOf),
      domains: site.domains ?? [],
      aggregate_version: '1',
      updated_at: CLOCK.now(),
    };
  })
  .sort((a, b) => a.site_id.localeCompare(b.site_id));

/** Answers the platform's registry reads: one site by `lower(site_id)`, one tenant by `tenant_id`, otherwise every row. */
function registryAnswer(sql: string, values: readonly unknown[]): Record<string, unknown>[] {
  const [key] = values;
  const rows = /lower\(site_id\) = lower\(\$1\)/.test(sql)
    ? REGISTRY_ROWS.filter((row) => row.site_id === String(key).toLowerCase())
    : /WHERE tenant_id = \$1/.test(sql)
      ? REGISTRY_ROWS.filter((row) => row.tenant_id === key)
      : REGISTRY_ROWS;
  return rows.map((row) => ({ ...row }));
}

/** Legacy `char(35)` id equality: case and trailing spaces ignored; NULL equals nothing. */
function sameId(stored: string | null, wanted: string): boolean {
  return stored !== null && stored.trimEnd().toUpperCase() === wanted.trimEnd().toUpperCase();
}

/** Answers the real repository's `account_operation` reads from the memory repo, so code reading through it sees the operations recorded there. */
function mirrorOperations(t: TestApp): void {
  t.db.respond(/^SELECT .+ FROM "identity"\."account_operation" WHERE /, (sql, values) => {
    const rows = t.repo.rows(ACCOUNT_OPERATION.table, String(values[0]));
    if (/\bstate = ANY\(/.test(sql)) {
      const [, states, userId, username] = values as [unknown, string[], string | null, string | null];
      const open = rows.filter(
        (row) => states.includes(row.state) && ((userId !== null && sameId(row.user_id, userId)) || (username !== null && sameId(row.username, username))),
      );
      return open.slice(0, 1);
    }
    const wanted = /\boperation_id = ANY\(/.test(sql) ? (values[1] as string[]) : [String(values[1])];
    return rows.filter((row) => wanted.some((operationId) => sameId(row.operation_id, operationId)));
  });
}

/** A roster create of a new tenant-a private-pool user into the Editors group. */
function createInput(change: Partial<AccountChange> = {}): PrepareInput {
  return {
    operationId: cfUuid(),
    kind: 'create',
    userId: cfUuid(),
    requestSiteId: TENANT_A.siteId,
    actorUserId: cfUuid(),
    siteId: TENANT_A.siteId,
    actorIsSuperUser: false,
    change: {
      username: 'roster_new',
      password: TEST_PASSWORDS.default,
      s2: 0,
      perm: 0,
      inActive: 0,
      isPublic: 0,
      remoteID: '',
      groupIds: [EDITORS.userid],
      ...change,
    },
  };
}

/** A roster edit of SITE_ADMIN_A that renames it, posts a password and moves it from Admin to Editors. */
function updateInput(change: Partial<AccountChange> = {}): PrepareInput {
  return {
    ...createInput(),
    kind: 'update',
    userId: SITE_ADMIN_A.account.userid,
    change: {
      username: 'site_admin_renamed',
      password: TEST_PASSWORDS.default,
      s2: 0,
      perm: 0,
      inActive: 0,
      isPublic: 0,
      remoteID: 'remote-7',
      groupIds: [EDITORS.userid],
      ...change,
    },
  };
}

/** Runs `step` on `input`'s operation, as `userId` names it (its own user by default). */
function runStep(deps: AccountOperationDeps, input: PrepareInput, step: Step, userId = input.userId): Promise<CommitOutcome | StepOutcome> {
  return STEP_CALLS[step](deps, input.operationId, { userId });
}

/** Prepares `input` and runs `steps`, failing on any refusal. */
async function drive(deps: AccountOperationDeps, input: PrepareInput, steps: readonly Step[]): Promise<void> {
  expect((await prepareAccountOperation(deps, input)).outcome).toBe('prepared');
  for (const step of steps) expect((await runStep(deps, input, step)).outcome).not.toBe('conflict');
}

/** Moves `input` to `state`; `unrecorded` leaves it never prepared. */
async function driveTo(deps: AccountOperationDeps, input: PrepareInput, state: AccountOperationState | 'unrecorded'): Promise<void> {
  if (state !== 'unrecorded') await drive(deps, input, PATHS[state]);
}

/** Write counts of the memory repo and the recording database. */
function writeMarks(t: TestApp): { repo: number; db: number } {
  return { repo: t.repo.writes().length, db: t.db.writes().length };
}

/** Runs `call` twice, checking the repeat answers as the first did and writes nothing; returns the first answer. */
async function repeatsIdentically<T>(t: TestApp, call: () => Promise<T>): Promise<T> {
  const first = await call();
  const marks = writeMarks(t);
  await expect(call()).resolves.toEqual(first);
  expect(writeMarks(t)).toEqual(marks);
  return first;
}

/** Committed writes of `table` binding `value`. */
function writesOf(t: TestApp, table: string, value: string): RecordedWrite[] {
  return t.db.writes().filter((write) => write.table === table && write.values.includes(value));
}

function accountOf(t: TestApp, userId: string) {
  return t.repo.rows(USER_ACCOUNT.table, TENANT).find((row) => sameId(row.userid, userId));
}

function credentialOf(t: TestApp, userId: string) {
  return t.repo.rows(CREDENTIAL.table, TENANT).find((row) => sameId(row.userid, userId));
}

function loginStateOf(t: TestApp, userId: string) {
  return t.repo.rows(LOGIN_STATE.table, TENANT).find((row) => sameId(row.userid, userId));
}

function groupIdsOf(t: TestApp, userId: string): string[] {
  return t.repo
    .rows(MEMBERSHIP.table, TENANT)
    .filter((row) => sameId(row.userid, userId))
    .map((row) => row.groupid)
    .sort();
}

function operationOf(t: TestApp, operationId: string) {
  return t.repo.rows(ACCOUNT_OPERATION.table, TENANT).find((row) => row.operation_id === operationId);
}

function selfSessionOf(t: TestApp) {
  return t.repo.rows(SESSION.table, TENANT).find((row) => row.session_id === SELF_SESSION.session_id);
}

/** Yields real macrotasks until `ready` holds, failing after 5 s of real time. */
async function untilReal(ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error('condition not reached within 5 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The settled value of `promise`, or its rejection reason. */
function settle<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );
}

let t: TestApp;
let deps: AccountOperationDeps;

beforeEach(async () => {
  t = await buildTestApp({ clock: CLOCK, seed: SEED });
  t.db.respond(/FROM identity\.tenant_registry\b/, registryAnswer);
  mirrorOperations(t);
  deps = { db: t.db, repo: t.repo, events: createIdentityEvents(t.repo), clock: CLOCK, settings: SETTINGS };
});

afterEach(async () => {
  vi.useRealTimers();
  await t.app.close();
});

describe('account operation constants', () => {
  it('gates the four identity units an operation writes and keeps a user closed for 10 s', () => {
    expect(ACCOUNT_OPERATION_UNITS).toEqual(['identity.user_account', 'identity.credential', 'identity.login_state', 'identity.membership']);
    expect(USER_CLOSED_WAIT_MS).toBe(10_000);
  });

  it('draws the random password of a create posted without one as 12 alphanumeric characters', () => {
    expect(randomPassword()).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});

describe('a roster create', () => {
  it('prepare reserves a pending account that is neither found, listed nor able to log in, and records the operation prepared', async () => {
    const input = createInput();
    const listed = (): Promise<number> =>
      t.db.withTenant(TENANT, async (tx) => (await t.repo.countListedAccounts(tx, { siteId: TENANT_A.siteId })).count);
    const listedBefore = await listed();

    await expect(prepareAccountOperation(deps, input)).resolves.toEqual({
      outcome: 'prepared',
      operation: { operationId: input.operationId, userId: input.userId, kind: 'create', state: 'prepared', before: null },
    });

    expect(accountOf(t, input.userId)).toMatchObject({ username: 'roster_new', type: 2, siteid: TENANT_A.siteId, ispublic: 0, opt2_state: 'pending' });
    expect(operationOf(t, input.operationId)).toMatchObject({ user_id: input.userId, kind: 'create', state: 'prepared', username: 'roster_new', commit_xid: null });
    expect(credentialOf(t, input.userId)).toBeUndefined();
    expect(await listed()).toBe(listedBefore);
    await t.db.withTenant(TENANT, async (tx) => {
      expect(await t.repo.findAccountById(tx, input.userId)).toBeNull();
      expect(await t.repo.findAccountByUsername(tx, 'roster_new')).toBeNull();
    });
  });

  it('commit activates the account with its credential, login state and memberships, and answers its commit transaction id', async () => {
    const input = createInput();
    await drive(deps, input, []);

    const outcome = await commitAccountOperation(deps, input.operationId, { userId: input.userId });

    expect(outcome).toEqual({
      outcome: 'committed',
      result: { operationId: input.operationId, userId: input.userId, state: 'committed', writePosition: expect.stringMatching(/^\d+$/) },
    });
    const { writePosition } = (outcome as Extract<CommitOutcome, { outcome: 'committed' }>).result;
    expect(operationOf(t, input.operationId)).toMatchObject({ state: 'committed', commit_xid: writePosition });
    expect(accountOf(t, input.userId)?.opt2_state).toBe('active');
    const credential = credentialOf(t, input.userId);
    expect(credential?.passwordcreated).toEqual(CLOCK.now());
    expect(bcrypt.compareSync(TEST_PASSWORDS.default, credential?.password ?? '')).toBe(true);
    expect(loginStateOf(t, input.userId)).toMatchObject({ lastlogin: null });
    expect(groupIdsOf(t, input.userId)).toEqual([EDITORS.userid]);
  });

  it('finish completes the operation, and a later commit still answers the recorded position', async () => {
    const input = createInput();
    await drive(deps, input, []);
    const committed = await commitAccountOperation(deps, input.operationId, { userId: input.userId });

    await expect(finishAccountOperation(deps, input.operationId, { userId: input.userId })).resolves.toEqual({
      outcome: 'stepped',
      step: { operationId: input.operationId, userId: input.userId, state: 'finished' },
    });

    expect(operationOf(t, input.operationId)?.state).toBe('finished');
    await expect(commitAccountOperation(deps, input.operationId, { userId: input.userId })).resolves.toEqual(committed);
  });
});

describe('a roster edit', () => {
  it('prepare records the account, credential date, last login and memberships as the before-image, never the stored password', async () => {
    const input = updateInput();
    const stored = accountOf(t, input.userId);

    const result = await prepareAccountOperation(deps, input);

    expect(result).toEqual({
      outcome: 'prepared',
      operation: {
        operationId: input.operationId,
        userId: input.userId,
        kind: 'update',
        state: 'prepared',
        before: {
          account: {
            userid: SITE_ADMIN_A.account.userid,
            username: SITE_ADMIN_A.account.username,
            type: 2,
            admin: null,
            s2: 0,
            perm: 0,
            inactive: 0,
            ispublic: 0,
            siteid: TENANT_A.siteId,
            remoteid: null,
            tablist: null,
            passwordcreated: SITE_ADMIN_A.credential.passwordcreated?.toISOString(),
            lastlogin: null,
          },
          groupIds: ADMIN_GROUP_IDS,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(String(SITE_ADMIN_A.credential.password));
    expect(accountOf(t, input.userId)).toEqual(stored);
  });

  it('accepts an edit that keeps the user its own username', async () => {
    const input = updateInput({ username: String(SITE_ADMIN_A.account.username) });
    await expect(prepareAccountOperation(deps, input)).resolves.toMatchObject({ outcome: 'prepared' });
  });

  it('commit applies the account, credential and membership change and finish completes it', async () => {
    const input = updateInput();
    await drive(deps, input, ['commit']);

    expect(accountOf(t, input.userId)).toMatchObject({ username: 'site_admin_renamed', remoteid: 'remote-7', opt2_state: 'active' });
    expect(bcrypt.compareSync(TEST_PASSWORDS.default, credentialOf(t, input.userId)?.password ?? '')).toBe(true);
    expect(groupIdsOf(t, input.userId)).toEqual([EDITORS.userid]);

    await expect(finishAccountOperation(deps, input.operationId, { userId: input.userId })).resolves.toMatchObject({
      outcome: 'stepped',
      step: { state: 'finished' },
    });
    expect(operationOf(t, input.operationId)?.state).toBe('finished');
  });

  it('holds the membership event its commit writes under the operation until finish releases it', async () => {
    const input = updateInput();
    await drive(deps, input, ['commit']);

    const [held, ...others] = writesOf(t, OUTBOX, input.operationId);
    expect(others).toEqual([]);
    expect(held?.verb).toBe('INSERT');
    const [, , topic, , , envelope, operationId, isHeld] = held?.values ?? [];
    expect({ topic, operationId, isHeld }).toEqual({ topic: MEMBERSHIP_CHANGED_TOPIC, operationId: input.operationId, isHeld: true });
    expect((JSON.parse(String(envelope)) as { payload: unknown }).payload).toEqual({
      userId: input.userId,
      siteId: TENANT_A.siteId,
      groupIds: [EDITORS.userid],
    });
    expect(t.publisher.published).toEqual([]);

    await runStep(deps, input, 'finish');

    expect(writesOf(t, OUTBOX, input.operationId).map((write) => write.verb)).toEqual(['INSERT', 'UPDATE']);
    expect(writesOf(t, OUTBOX, input.operationId)[1]?.values).toEqual([input.operationId]);
  });
});


describe('rejection and repetition', () => {
  it('aborts a prepared create: deletes the pending account, discards its held events and never releases them', async () => {
    const input = createInput();
    await drive(deps, input, []);

    await expect(abortAccountOperation(deps, input.operationId, { userId: input.userId })).resolves.toEqual({
      outcome: 'stepped',
      step: { operationId: input.operationId, userId: input.userId, state: 'aborted' },
    });

    expect(accountOf(t, input.userId)).toBeUndefined();
    expect(operationOf(t, input.operationId)).toMatchObject({ state: 'aborted', pending_change: null });
    expect(writesOf(t, OUTBOX, input.operationId).map((write) => [write.verb, write.values])).toEqual([['DELETE', [input.operationId]]]);
    expect(t.publisher.published).toEqual([]);
  });

  it('reverts a committed edit to its before-image: account, credential and memberships as stored, held events discarded', async () => {
    const input = updateInput();
    const before = { account: accountOf(t, input.userId), credential: credentialOf(t, input.userId), groupIds: groupIdsOf(t, input.userId) };
    await drive(deps, input, ['commit']);
    expect(accountOf(t, input.userId)?.username).toBe('site_admin_renamed');

    await expect(revertAccountOperation(deps, input.operationId, { userId: input.userId })).resolves.toEqual({
      outcome: 'stepped',
      step: { operationId: input.operationId, userId: input.userId, state: 'reverted' },
    });

    expect({ account: accountOf(t, input.userId), credential: credentialOf(t, input.userId), groupIds: groupIdsOf(t, input.userId) }).toEqual(before);
    expect(operationOf(t, input.operationId)?.state).toBe('reverted');
    expect(writesOf(t, OUTBOX, input.operationId).map((write) => write.verb)).toEqual(['INSERT', 'DELETE']);
    expect(t.publisher.published).toEqual([]);
  });

  // Legacy checkUsername looks for the name among every Type=2 user, whatever their site or pool, and compares under
  // SQL Server's case-insensitive collation [legacy: core/mura/user/userBean.cfc:411-424]. Java's MessageFormat writes a
  // missing argument as its placeholder, so an empty username shows '{1}' [legacy: core/mura/resourceBundle/resourceBundle.cfc:164-192].
  it.each([
    { held: 'by another user of the same pool', username: String(SITE_ADMIN_A.account.username), shown: String(SITE_ADMIN_A.account.username) },
    {
      held: 'by another user under another letter case',
      username: String(SITE_ADMIN_A.account.username).toUpperCase(),
      shown: String(SITE_ADMIN_A.account.username).toUpperCase(),
    },
    { held: 'by a user of another pool', username: OTHER_POOL_USERNAME, shown: OTHER_POOL_USERNAME },
    { held: 'by nobody but is empty', username: '', shown: '{1}' },
  ])('answers a create whose username is held $held with the legacy username error, writing nothing', async ({ username, shown }) => {
    const marks = writeMarks(t);

    await expect(prepareAccountOperation(deps, createInput({ username }))).resolves.toEqual({
      outcome: 'invalid',
      errors: { username: USERNAME_TAKEN(shown) },
    });

    expect(writeMarks(t)).toEqual(marks);
  });

  it('halts an edit whose pool switch would move the account into another user pool tenant, writing nothing', async () => {
    const input = { ...updateInput({ username: String(POOLED_MEMBER.account.username), switchToPrivate: true }), userId: POOLED_MEMBER.account.userid };
    const marks = writeMarks(t);

    const error = await settle(prepareAccountOperation(deps, input));

    expect(error).toBeInstanceOf(AccountSaveHaltedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(writeMarks(t)).toEqual(marks);
  });

  it.each([
    { terminal: 'finish', steps: PATHS.finished },
    { terminal: 'abort', steps: PATHS.aborted },
    { terminal: 'revert', steps: PATHS.reverted },
  ])('answers every repeated step on the way to $terminal with its first answer and writes nothing more', async ({ steps }) => {
    const input = createInput();
    await repeatsIdentically(t, () => prepareAccountOperation(deps, input));
    for (const step of steps) await repeatsIdentically(t, () => runStep(deps, input, step));
  });

  it.each<{ case: string; step: Step | 'prepare'; after: AccountOperationState | 'unrecorded'; state: string; foreign?: boolean }>([
    { case: 'a commit of an operation never prepared', step: 'commit', after: 'unrecorded', state: 'unknown' },
    { case: 'a finish before commit', step: 'finish', after: 'prepared', state: 'prepared' },
    { case: 'a revert before commit', step: 'revert', after: 'prepared', state: 'prepared' },
    { case: 'an abort after commit', step: 'abort', after: 'committed', state: 'committed' },
    { case: 'a commit after abort', step: 'commit', after: 'aborted', state: 'aborted' },
    { case: 'a revert after abort', step: 'revert', after: 'aborted', state: 'aborted' },
    { case: 'a prepare again after abort', step: 'prepare', after: 'aborted', state: 'aborted' },
    { case: 'a finish after revert', step: 'finish', after: 'reverted', state: 'reverted' },
    { case: 'an abort after finish', step: 'abort', after: 'finished', state: 'finished' },
    { case: "a commit naming another user's operation", step: 'commit', after: 'prepared', state: 'prepared', foreign: true },
  ])('refuses $case as a conflict carrying the recorded state $state, writing nothing', async ({ step, after, state, foreign }) => {
    const input = createInput();
    await driveTo(deps, input, after);
    const marks = writeMarks(t);

    const outcome = step === 'prepare' ? await prepareAccountOperation(deps, input) : await runStep(deps, input, step, foreign === true ? cfUuid() : input.userId);

    expect(outcome).toMatchObject({ outcome: 'conflict', operation: { operationId: input.operationId, userId: input.userId, state } });
    expect(writeMarks(t)).toEqual(marks);
  });
});

describe('user closure', () => {
  it.each(['prepared', 'committed'] as const)('keeps the user closed for USER_CLOSED_WAIT_MS while its operation is %s, then answers the legacy 503', async (state) => {
    const input = updateInput();
    await drive(deps, input, PATHS[state]);
    vi.useFakeTimers(FAKE_TIMERS);
    let settled = false;
    const outcome = settle(awaitAccountOpen(t.db, TENANT, input.userId));
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(USER_CLOSED_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(OperationBlockedError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect((error as OperationBlockedError).units).toEqual([...ACCOUNT_OPERATION_UNITS]);
  });

  it('opens the user at once to its own operation', async () => {
    const input = updateInput();
    await drive(deps, input, []);

    await expect(awaitAccountOpen(t.db, TENANT, input.userId, { selfOperationId: input.operationId })).resolves.toBe(0);
  });

  it.each([
    { ending: 'finish', steps: PATHS.finished, state: 'finished' },
    { ending: 'abort', steps: PATHS.aborted, state: 'aborted' },
    { ending: 'revert', steps: PATHS.reverted, state: 'reverted' },
  ])('registers the operation for the unit gates at prepare and drops it, reopening the user, at $ending', async ({ steps, state }) => {
    const input = updateInput();
    await drive(deps, input, []);
    expect(writesOf(t, OPEN_OPERATION, input.operationId).map((write) => [write.verb, write.values])).toEqual([
      ['INSERT', [input.operationId, OPERATION_KIND, [...ACCOUNT_OPERATION_UNITS]]],
    ]);

    for (const step of steps) await runStep(deps, input, step);

    expect(writesOf(t, OPEN_OPERATION, input.operationId).map((write) => [write.verb, write.values])).toEqual([
      ['INSERT', [input.operationId, OPERATION_KIND, [...ACCOUNT_OPERATION_UNITS]]],
      ['DELETE', [input.operationId]],
    ]);
    expect(operationOf(t, input.operationId)?.state).toBe(state);
    await expect(awaitAccountOpen(t.db, TENANT, input.userId)).resolves.toBe(0);
  });

  it('refuses a second operation on a user whose first is open, recording and registering nothing for it', async () => {
    const first = updateInput();
    await drive(deps, first, []);
    const second = updateInput({ username: 'site_admin_second' });
    vi.useFakeTimers(FAKE_TIMERS);

    const outcome = settle(prepareAccountOperation(deps, second));
    await vi.advanceTimersByTimeAsync(USER_CLOSED_WAIT_MS);

    expect(await outcome).toBeInstanceOf(OperationBlockedError);
    expect(operationOf(t, second.operationId)).toBeUndefined();
    expect(writesOf(t, OPEN_OPERATION, second.operationId)).toEqual([]);
    expect(operationOf(t, first.operationId)?.state).toBe('prepared');
  });

  it('lets one of two concurrent operations on a user open and leaves the other without an operation or registration', async () => {
    const inputs = [updateInput({ password: '' }), updateInput({ username: 'site_admin_concurrent', password: '' })];
    vi.useFakeTimers(FAKE_TIMERS);

    const outcomes = Promise.all(inputs.map((input) => settle(prepareAccountOperation(deps, input))));
    await vi.advanceTimersByTimeAsync(USER_CLOSED_WAIT_MS);
    const [first, second] = await outcomes;

    const won = [first, second].map((outcome) => (outcome as { outcome?: unknown }).outcome === 'prepared');
    expect(won.filter(Boolean)).toHaveLength(1);
    const loser = inputs[won.indexOf(false)] as PrepareInput;
    expect(won[0] ? second : first).toBeInstanceOf(OperationBlockedError);
    expect(operationOf(t, loser.operationId)).toBeUndefined();
    expect(writesOf(t, OPEN_OPERATION, loser.operationId).map((write) => write.verb).at(-1) ?? 'DELETE').toBe('DELETE');
    expect(t.repo.rows(ACCOUNT_OPERATION.table, TENANT).filter((row) => row.state === 'prepared')).toHaveLength(1);
  });

  it('runs a withOpenAccount callback for the operation that holds the user, and refuses any other caller after the closed wait', async () => {
    const input = updateInput();
    await drive(deps, input, []);
    const readAccount = (tx: Parameters<Parameters<typeof withOpenAccount>[3]>[0]) => t.repo.findAccountById(tx, input.userId);

    await expect(withOpenAccount(t.db, TENANT, input.userId, readAccount, { selfOperationId: input.operationId })).resolves.toMatchObject({
      username: SITE_ADMIN_A.account.username,
    });

    vi.useFakeTimers(FAKE_TIMERS);
    const blocked = settle(withOpenAccount(t.db, TENANT, input.userId, readAccount));
    await vi.advanceTimersByTimeAsync(USER_CLOSED_WAIT_MS);
    expect(await blocked).toBeInstanceOf(OperationBlockedError);
  });

  it('reports open, done and rolled-back migration statuses by state and leaves out operations never recorded', async () => {
    const states = Object.keys(PATHS) as AccountOperationState[];
    const inputs = states.map((state) => createInput({ username: `status_${state}` }));
    for (const [index, state] of states.entries()) await driveTo(deps, inputs[index] as PrepareInput, state);
    const unrecorded = cfUuid();

    const statuses = await operationStatus(t.db, [...inputs.map((input) => input.operationId), unrecorded]);

    expect(statuses).toEqual(
      Object.fromEntries(
        inputs.map((input, index) => [input.operationId, { prepared: 'open', committed: 'open', finished: 'done', aborted: 'rolled-back', reverted: 'rolled-back' }[states[index] as AccountOperationState]]),
      ),
    );
  });
});


describe('session effects', () => {
  const person = { fname: 'Renamed', lname: 'Admin', email: `site_admin_renamed@${TENANT_A.siteId}.opt2.test`, company: null, subtype: 'Default' };

  it('re-logs in the session people names at commit once finish runs: rebuilt login snapshot, bumped epoch, touched last login', async () => {
    const input = updateInput();
    const sessionEffects: SessionEffects = { reloginSessionId: SELF_SESSION.session_id, person };
    await drive(deps, input, []);
    const stored = selfSessionOf(t);

    await commitAccountOperation(deps, input.operationId, { userId: input.userId, sessionEffects });
    expect(selfSessionOf(t)).toEqual(stored);
    await runStep(deps, input, 'finish');

    const session = selfSessionOf(t);
    expect(session?.epoch).toBe('2');
    expect(session?.csrf_secret).not.toBe(stored?.csrf_secret);
    const snapshot = JSON.parse(String(session?.login_snapshot)) as LoginSnapshot;
    expect(snapshot).toMatchObject({ userid: input.userId, username: 'site_admin_renamed', remoteid: 'remote-7', fname: 'Renamed', lname: 'Admin', email: person.email });
    expect(snapshot.membershipIds.split(',')).toEqual([EDITORS.userid, input.userId]);
    expect(loginStateOf(t, input.userId)?.lastlogin).toEqual(CLOCK.now());
  });

  it('leaves every session and the last login as stored when people signals no re-login', async () => {
    const input = updateInput();
    const sessions = t.repo.rows(SESSION.table);
    const loginState = loginStateOf(t, input.userId);

    await drive(deps, input, PATHS.finished);

    expect(t.repo.rows(SESSION.table)).toEqual(sessions);
    expect(loginStateOf(t, input.userId)).toEqual(loginState);
  });
});

describe('account operation routes', () => {
  const OTHER_CALLERS = ['service:gateway', 'service:timesheets', 's2', 'site-admin'] as const;
  let people: Record<string, string>;

  /** The contract path of `input`'s operation, with the `:action` suffix when given. */
  function operationUrl(input: Pick<PrepareInput, 'userId' | 'operationId'>, action?: string): string {
    return `/internal/v1/accounts/${input.userId}/operations/${input.operationId}${action === undefined ? '' : `:${action}`}`;
  }

  /** The contract's prepare body of `input`. */
  function prepareBody(input: PrepareInput): Record<string, unknown> {
    const { change } = input;
    return {
      kind: input.kind,
      siteId: input.siteId,
      account: {
        UserName: change.username,
        Password: change.password,
        S2: change.s2,
        Perm: change.perm,
        InActive: change.inActive,
        isPublic: change.isPublic,
        Admin: 0,
        remoteID: change.remoteID,
        Type: 2,
      },
      groupIds: [...(change.groupIds ?? [])],
    };
  }

  /** People's invocation credential forwarding a super user's token, which prepare reads its site and S2 rule from. */
  async function prepareHeaders(): Promise<Record<string, string>> {
    return { ...(await headersFor('s2')), ...people };
  }

  beforeEach(async () => {
    people = await headersFor('service:people');
    await t.app.ready();
  });

  it('prepares a roster create for people, reserving a pending account and registering the operation', async () => {
    const input = createInput();

    const res = await t.app.inject({ method: 'POST', url: operationUrl(input, 'prepare'), headers: await prepareHeaders(), payload: prepareBody(input) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operationId: input.operationId, userId: input.userId, kind: 'create', state: 'prepared', before: null });
    const reserved = t.db.writes().filter((write) => write.table === 'identity.user_account' && write.verb === 'INSERT');
    expect(reserved.map((write) => write.values.includes('pending'))).toEqual([true]);
    expect(writesOf(t, OPEN_OPERATION, input.operationId).map((write) => write.verb)).toEqual(['INSERT']);
  });

  it.each([
    { action: 'commit', steps: PATHS.prepared, state: 'committed' },
    { action: 'abort', steps: PATHS.prepared, state: 'aborted' },
    { action: 'finish', steps: PATHS.committed, state: 'finished' },
    { action: 'revert', steps: PATHS.committed, state: 'reverted' },
  ])('answers :$action of a recorded operation with 200 and the state $state', async ({ action, steps, state }) => {
    const input = createInput();
    await drive(deps, input, steps);

    const res = await t.app.inject({ method: 'POST', url: operationUrl(input, action), headers: people });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ operationId: input.operationId, userId: input.userId, state });
  });

  it('answers :commit with the commit transaction id, the identity position X-Opt2-Write-Position carries', async () => {
    const input = createInput();
    await drive(deps, input, []);

    const res = await t.app.inject({ method: 'POST', url: operationUrl(input, 'commit'), headers: people });

    const { writePosition } = res.json() as { writePosition: string };
    expect(writePosition).toMatch(/^\d+$/);
    expect(res.headers['x-opt2-write-position']).toBe(`identity=${writePosition}`);
  });

  it.each([
    { session: "the user's own", own: true, status: 200 },
    { session: "another user's", own: false, status: 403 },
  ])('answers a :commit asking a re-login of $session session with $status', async ({ own, status }) => {
    const input = updateInput();
    await drive(deps, input, []);
    const user = await headersFor('s2', { sub: own ? input.userId : cfUuid() });
    const { sid } = decodeJwt(String(user.authorization).replace(/^Bearer /, ''));

    const res = await t.app.inject({
      method: 'POST',
      url: operationUrl(input, 'commit'),
      headers: { ...user, ...people },
      payload: { sessionEffects: { reloginSessionId: String(sid) } },
    });

    expect(res.statusCode).toBe(status);
  });

  it.each(['commit', 'abort', 'finish', 'revert'])('answers :%s of an operation identity never recorded with 409 and the state unknown', async (action) => {
    const input = createInput();

    const res = await t.app.inject({ method: 'POST', url: operationUrl(input, action), headers: people });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ operationId: input.operationId, userId: input.userId, state: 'unknown' });
  });

  it('reads a recorded operation as the domain records it, and one never recorded as unknown', async () => {
    const input = updateInput();
    await drive(deps, input, []);
    const unrecorded = { userId: input.userId, operationId: cfUuid() };

    const recorded = await t.app.inject({ method: 'GET', url: operationUrl(input), headers: people });
    const missing = await t.app.inject({ method: 'GET', url: operationUrl(unrecorded), headers: people });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toEqual(await accountOperationStatus(deps, input.operationId, { userId: input.userId }));
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ ...unrecorded, state: 'unknown' });
  });

  it('answers the legacy 503 to a prepare that waited USER_CLOSED_WAIT_MS behind another open operation on the user', async () => {
    const first = updateInput();
    await drive(deps, first, []);
    const second = updateInput({ username: 'site_admin_second' });
    const headers = await prepareHeaders();
    vi.useFakeTimers(FAKE_TIMERS);

    const mark = t.db.statements().length;
    const reply = t.app.inject({ method: 'POST', url: operationUrl(second, 'prepare'), headers, payload: prepareBody(second) });
    // Token verification settles on real macrotasks, so time moves only once the handler has reached the closed-user wait.
    await untilReal(() => t.db.statements().slice(mark).some((statement) => /\bstate = ANY\(/.test(statement.sql)));
    let answered = false;
    void reply.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(USER_CLOSED_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await reply;

    expect(res.statusCode).toBe(503);
    expect(res.headers.generator).toBe('Masa CMS 7.6.1');
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
    expect(writesOf(t, OPEN_OPERATION, second.operationId)).toEqual([]);
  });

  it.each([
    { route: 'GET', method: 'GET', action: undefined },
    { route: 'POST :prepare', method: 'POST', action: 'prepare' },
    { route: 'POST :commit', method: 'POST', action: 'commit' },
    { route: 'POST :abort', method: 'POST', action: 'abort' },
    { route: 'POST :finish', method: 'POST', action: 'finish' },
    { route: 'POST :revert', method: 'POST', action: 'revert' },
  ] as const)('refuses $route to every caller but people with 403 before its handler runs', async ({ method, action }) => {
    const input = createInput();
    const mark = t.db.statements().length;

    for (const caller of OTHER_CALLERS) {
      const res = await t.app.inject({
        method,
        url: operationUrl(input, action),
        headers: await headersFor(caller),
        ...(action === 'prepare' ? { payload: prepareBody(input) } : {}),
      });
      expect({ caller, status: res.statusCode }).toEqual({ caller, status: 403 });
    }
    expect(t.db.statements().slice(mark).filter((statement) => /tenant_registry|account_operation|open_operation/.test(statement.sql))).toEqual([]);
  });
});

