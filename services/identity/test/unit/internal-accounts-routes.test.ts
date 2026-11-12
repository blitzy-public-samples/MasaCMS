/** The roster account-operation routes over a throwaway `identity` schema: contract shape, people-only access, path binding, validation and the domain outcomes as statuses. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, fixedClock, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  createThrowawaySchema,
  findOperation,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountOperationDeps } from '../../src/domain/account-operations.js';
import { applyLogin } from '../../src/domain/sessions.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type SessionRow, type UserAccountRow } from '../../src/repo/tables.js';
import { registerAccountRoutes } from '../../src/routes/internal-accounts.js';

type Method = 'GET' | 'POST';
type Action = 'prepare' | 'commit' | 'abort' | 'finish' | 'revert';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const BASE_TEMPLATE = '/internal/v1/accounts/{userId}/operations/{operationId}';
const ACTIONS: readonly Action[] = ['prepare', 'commit', 'abort', 'finish', 'revert'];
const CONTRACT_PATHS = [BASE_TEMPLATE, ...ACTIONS.map((action) => `${BASE_TEMPLATE}:${action}`)];
const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const ACTOR = 'A0000000-0000-0000-0000000000000999';
const SOME_USER = 'A0000000-0000-0000-0000000000000001';
const OTHER_USER = 'A0000000-0000-0000-0000000000000002';
const SOME_OPERATION = 'C0000000-0000-0000-0000000000000001';
const SOME_SESSION = 'S-0000000000000001';
const EDITORS = 'B0000000-0000-0000-0000000000000001';
const AUTHORS = 'B0000000-0000-0000-0000000000000002';
const MEMBERS = 'B0000000-0000-0000-0000000000000003';
const JSON_BODY = { 'content-type': 'application/json' };

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: async () => undefined,
};

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let seq = 100;

/** A fresh 35-character CF UUID under the hex digit `prefix`. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}0000000-0000-0000-${String(seq).padStart(16, '0')}`;
}

/** The operation path of `userId` and `operationId`, with the `:action` suffix when given. */
function opUrl(userId: string, operationId: string, action?: string): string {
  return `/internal/v1/accounts/${userId}/operations/${operationId}${action === undefined ? '' : `:${action}`}`;
}

async function registerSite(schema: string, db: TenantDb, site: string, privatePool: string, publicPool: string): Promise<void> {
  await withMetadata(db, (tx) =>
    tx.query(
      `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
        ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
      [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), NOW],
    ),
  );
}

/** A Type=1 group of `site` named `groupname`. */
function groupInput(userid: string, groupname: string, site: string, ispublic: number): GroupInput {
  return {
    userid, groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid: site,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-internal-accounts-routes-'));
  await writeTestSecrets(stateDir);
  const clock = fixedClock(NOW);
  repo = createIdentityRepository({ clock });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: createCapturingPublisher(), logger, clock, payloadValidators: identityPayloadValidators });
    await registerSite(schema, handle.app, SITE, SITE, UMBRELLA);
    await registerSite(schema, handle.app, UMBRELLA, UMBRELLA, UMBRELLA);
    await withGatedTenant(handle.app, tenantIdForSite(SITE), async (tx) => {
      await repo.insertGroup(tx, groupInput(EDITORS, 'Editors', SITE, 0), null);
      await repo.insertGroup(tx, groupInput(AUTHORS, 'Authors', SITE, 0), null);
    });
    await withGatedTenant(handle.app, tenantIdForSite(UMBRELLA), (tx) => repo.insertGroup(tx, groupInput(MEMBERS, 'Members', UMBRELLA, 1), null));
  }
  app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerWritePositionHeader(app);
  // Four bcrypt rounds and no closed-user sleeps keep the suite fast.
  const accounts: AccountOperationDeps = {
    db: handle?.app ?? NO_DB,
    repo,
    events: createIdentityEvents(repo),
    clock,
    settings: { ...DEFAULT_ACCOUNT_SETTINGS, password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 } },
    sleep: async () => undefined,
  };
  await registerAccountRoutes(app, { accounts });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a `caller` service call, carrying the actor's user token unless `withUser` is false. */
async function headersFor(caller: string | null, withUser = true): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: ACTOR, site: SITE, roles: [Roles.s2] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  return headers;
}

/** Headers of a people call forwarding the user token of `sub` in session `sid`, who holds no S2. */
async function selfHeaders(sub: string, sid: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await mintUserToken({ sub, sid, site: SITE, roles: [] })}`,
    [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'people', audience: 'identity' })}`,
  };
}

const REQUEST_PROBES = new Map<string, object>();

/** Checks a request body, as it travels, against the `requestBody` the contract declares for the operation. */
function assertRequestMatchesOpenApi(method: Method, url: string, payload: unknown): void {
  const { template, operation } = findOperation(OPENAPI, method, url);
  const key = `${method} ${template}`;
  // A request body has a response's `content` shape, so the response checker validates it; one probe per operation.
  const probe = REQUEST_PROBES.get(key) ?? { ...OPENAPI, paths: { [template]: { [method.toLowerCase()]: { responses: { '200': operation['requestBody'] } } } } };
  REQUEST_PROBES.set(key, probe);
  assertResponseMatchesOpenApi(probe, { method, path: url, status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
}

/** Injects a request and checks its body and every declared answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
  if (payload !== undefined) assertRequestMatchesOpenApi(method, url, payload);
  const res = await app.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, ...JSON_BODY },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** An `AccountPrepareRequest` for `username` in the token's site private pool. */
function prepareBody(kind: 'create' | 'update', username: string, account: Record<string, unknown> = {}) {
  return {
    kind,
    siteId: SITE,
    account: { UserName: username, Password: 'Secret12', S2: 0, Perm: 0, InActive: 0, isPublic: 0, Admin: 0, remoteID: '', Type: 2, ...account },
    groupIds: [],
  };
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/internal/v1/accounts'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: (operation['x-opt2-fastify-path'] as string | undefined) ?? template.replace('{userId}', ':userId').replace('{operationId}', ':operationId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        })),
    );
    expect(expected).toHaveLength(6);
    expect(declared).toHaveLength(6);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
  });
});

describe('auth denials', () => {
  it.each<[Method, string, unknown]>([
    ['GET', opUrl(SOME_USER, SOME_OPERATION), undefined],
    ...ACTIONS.map((action): [Method, string, unknown] => [
      'POST',
      opUrl(SOME_USER, SOME_OPERATION, action),
      action === 'prepare' ? prepareBody('create', 'denied') : undefined,
    ]),
  ])('refuse %s %s to callers other than people', async (method, url, payload) => {
    for (const caller of ['gateway', 'identity', 'web', 'migration', 'strategies-content']) {
      expect((await send(method, url, await headersFor(caller), payload)).statusCode).toBe(403);
      expect((await send(method, url, await headersFor(caller, false), payload)).statusCode).toBe(403);
    }
    expect((await send(method, url, await headersFor(null), payload)).statusCode).toBe(401);
  });

  it('answer a prepare without the forwarded user token as a missing credential', async () => {
    const res = await send('POST', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), await headersFor('people', false), prepareBody('create', 'anon'));

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it.each<[string, () => Promise<Record<string, string>>, number]>([
    ['without the forwarded user token', () => headersFor('people', false), 401],
    ["for a user other than the token's", () => selfHeaders(OTHER_USER, SOME_SESSION), 403],
    ["for a session other than the token's", () => selfHeaders(SOME_USER, 'S-0000000000000002'), 403],
    ['for an S2 actor saving another user', () => headersFor('people'), 403],
  ])('refuse a commit carrying session effects %s before any step', async (_label, headers, status) => {
    const body = { sessionEffects: { reloginSessionId: SOME_SESSION } };
    const res = await send('POST', opUrl(SOME_USER, SOME_OPERATION, 'commit'), await headers(), body);

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });
});

describe('request validation', () => {
  it('answers an action outside the five as an unregistered route does', async () => {
    const headers = await headersFor('people');
    const unknownAction = await app.inject({ method: 'POST', url: opUrl(SOME_USER, SOME_OPERATION, 'delete'), headers });
    const unregistered = await app.inject({ method: 'POST', url: '/internal/v1/accounts/nowhere', headers });

    expect(unknownAction.statusCode).toBe(404);
    expect([unknownAction.statusCode, unknownAction.json()]).toEqual([unregistered.statusCode, unregistered.json()]);
  });

  it.each<[string, string, unknown]>([
    ['an operation id that is no CF UUID', opUrl(SOME_USER, 'not-an-id', 'commit'), undefined],
    ['a user id that is no CF UUID', opUrl('not-an-id', SOME_OPERATION, 'finish'), undefined],
    ['a prepare without a body', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), undefined],
    ['a kind the contract does not name', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), { ...prepareBody('create', 'x'), kind: 'delete' }],
    ['an S2 flag other than 0 or 1', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), prepareBody('create', 'x', { S2: 3 })],
    ['a Type other than 2', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), prepareBody('create', 'x', { Type: 1 })],
    ['a group id that is no CF UUID', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), { ...prepareBody('create', 'x'), groupIds: ['g'] }],
    ['an updateGroups that is no boolean', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), { ...prepareBody('update', 'x'), updateGroups: 'some' }],
    ['a tablist that is no text', opUrl(SOME_USER, SOME_OPERATION, 'prepare'), prepareBody('create', 'x', { tablist: { tab: 'Basic' } })],
    ['a commit body that is no object', opUrl(SOME_USER, SOME_OPERATION, 'commit'), 'sessionEffects'],
    ['session effects without a session id', opUrl(SOME_USER, SOME_OPERATION, 'commit'), { sessionEffects: { reloginSessionId: '' } }],
    ['session effects with partial person fields', opUrl(SOME_USER, SOME_OPERATION, 'commit'), { sessionEffects: { reloginSessionId: SOME_SESSION, person: { fname: 'Pat' } } }],
  ])('answers %s with the legacy 400', async (_label, url, payload) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { ...(await headersFor('people')), ...(payload === undefined ? {} : JSON_BODY) },
      payload: payload === undefined ? undefined : JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });
});

describe.skipIf(!available)('operations against PostgreSQL', () => {
  function db(): TenantDb {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    return handle.app;
  }

  function accountOf(userId: string, site = SITE): Promise<UserAccountRow | null> {
    return withTenant(db(), tenantIdForSite(site), (tx) => repo.findAccountById(tx, userId, { includePending: true }));
  }

  async function membershipsOf(userId: string): Promise<string[]> {
    return (await withTenant(db(), tenantIdForSite(SITE), (tx) => repo.membershipGroupIds(tx, userId))).sort();
  }

  function sessionOf(sessionId: string): Promise<SessionRow | null> {
    return withTenant(db(), tenantIdForSite(SITE), (tx) => repo.findSession(tx, sessionId));
  }

  async function pendingChangeOf(operationId: string, site = SITE): Promise<Record<string, unknown>> {
    const row = await withTenant(db(), tenantIdForSite(site), (tx) => repo.findAccountOperation(tx, operationId));
    return JSON.parse(row?.pending_change ?? 'null') as Record<string, unknown>;
  }

  /** Prepares, commits (with `commitBody` when given) and finishes `body` through the routes; answers the operation id. */
  async function applied(userId: string, body: object, commitBody?: unknown): Promise<string> {
    const people = await headersFor('people');
    const op = nextId('C');
    expect((await send('POST', opUrl(userId, op, 'prepare'), people, body)).statusCode).toBe(200);
    expect((await send('POST', opUrl(userId, op, 'commit'), people, commitBody)).statusCode).toBe(200);
    expect((await send('POST', opUrl(userId, op, 'finish'), people)).statusCode).toBe(200);
    return op;
  }

  /** A logged-in session of the tenant-a user `userId`. */
  async function loggedIn(userId: string, username: string): Promise<string> {
    const sessionId = `S-${nextId('D')}`;
    await applyLogin(
      { db: db(), repo, clock: fixedClock(NOW) },
      {
        sessionId,
        tenantId: tenantIdForSite(SITE),
        snapshot: {
          userid: userId, username, siteid: SITE, subtype: 'Default', password: null, fname: 'Old', lname: 'Name', email: 'old@example.test',
          remoteid: '', company: '', lastlogin: null, passwordcreated: null, roleList: `${username};username;${SITE}`, membershipIds: userId,
        },
        mode: 'target-primary',
        siteId: SITE,
      },
    );
    return sessionId;
  }

  it('prepares, commits and finishes a create, answering repeats with the recorded outcome and recovery reads without a user token', async () => {
    const userId = nextId('A');
    const op = nextId('C');
    const people = await headersFor('people');

    const prepared = await send('POST', opUrl(userId, op, 'prepare'), people, prepareBody('create', 'routes-one'));
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toMatchObject({ operationId: op, userId, kind: 'create', state: 'prepared', before: null });
    expect((await send('POST', opUrl(userId, op, 'prepare'), people, prepareBody('create', 'routes-one'))).json()).toMatchObject({ state: 'prepared' });
    expect((await send('GET', opUrl(userId, op), people)).json()).toMatchObject({ state: 'prepared' });

    const committed = await send('POST', opUrl(userId, op, 'commit'), people);
    expect(committed.statusCode).toBe(200);
    const result = committed.json() as { writePosition: string };
    expect(result).toMatchObject({ operationId: op, userId, state: 'committed' });
    expect(committed.headers['x-opt2-write-position']).toBe(`identity=${result.writePosition}`);
    expect((await send('POST', opUrl(userId, op, 'commit'), people)).json()).toEqual(result);

    const finished = await send('POST', opUrl(userId, op, 'finish'), people);
    expect([finished.statusCode, finished.json()]).toEqual([200, { operationId: op, userId, state: 'finished' }]);
    expect((await send('POST', opUrl(userId, op, 'finish'), people)).json()).toEqual({ operationId: op, userId, state: 'finished' });
    const late = await send('POST', opUrl(userId, op, 'abort'), people);
    expect([late.statusCode, late.json().state]).toEqual([409, 'finished']);
    expect((await send('GET', opUrl(userId, op), await headersFor('people', false))).json()).toMatchObject({ state: 'finished' });
    expect((await accountOf(userId))?.opt2_state).toBe('active');
  });

  it('answers a username another account holds with the legacy errors struct unchanged', async () => {
    const res = await send('POST', opUrl(nextId('A'), nextId('C'), 'prepare'), await headersFor('people'), prepareBody('create', 'routes-one'));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ username: "The username 'routes-one' that you entered is being used by another user." });
  });

  it('aborts a prepared create, deleting its pending account, and refuses a later commit', async () => {
    const userId = nextId('A');
    const op = nextId('C');
    const recovery = await headersFor('people', false);
    expect((await send('POST', opUrl(userId, op, 'prepare'), await headersFor('people'), prepareBody('create', 'routes-two'))).statusCode).toBe(200);
    expect((await accountOf(userId))?.opt2_state).toBe('pending');

    const aborted = await send('POST', opUrl(userId, op, 'abort'), recovery);
    expect([aborted.statusCode, aborted.json()]).toEqual([200, { operationId: op, userId, state: 'aborted' }]);
    expect((await send('POST', opUrl(userId, op, 'abort'), recovery)).statusCode).toBe(200);
    expect(await accountOf(userId)).toBeNull();
    const refused = await send('POST', opUrl(userId, op, 'commit'), recovery);
    expect([refused.statusCode, refused.json().state]).toEqual([409, 'aborted']);
    const reprepared = await send('POST', opUrl(userId, op, 'prepare'), await headersFor('people'), prepareBody('create', 'routes-two'));
    expect([reprepared.statusCode, reprepared.json().state]).toEqual([409, 'aborted']);
  });

  it('reads an operation identity never recorded as unknown, and refuses its steps with that state', async () => {
    const userId = nextId('A');
    const never = nextId('C');
    const recovery = await headersFor('people', false);

    expect((await send('GET', opUrl(userId, never), recovery)).json()).toEqual({ operationId: never, userId, state: 'unknown' });
    for (const action of ['commit', 'abort', 'finish', 'revert'] as const) {
      const res = await send('POST', opUrl(userId, never, action), recovery);
      expect([res.statusCode, res.json().state]).toEqual([409, 'unknown']);
    }
  });

  it('reverts a committed update to the account recorded at prepare', async () => {
    const userId = nextId('A');
    const people = await headersFor('people');
    const create = nextId('C');
    await send('POST', opUrl(userId, create, 'prepare'), people, prepareBody('create', 'routes-three'));
    await send('POST', opUrl(userId, create, 'commit'), people);
    await send('POST', opUrl(userId, create, 'finish'), people);
    const before = await accountOf(userId);

    const update = nextId('C');
    const prepared = await send('POST', opUrl(userId, update, 'prepare'), people, prepareBody('update', 'routes-three-renamed', { Password: undefined, remoteID: 'R1' }));
    expect(prepared.json()).toMatchObject({ kind: 'update', before: { account: { username: 'routes-three' } } });
    await send('POST', opUrl(userId, update, 'commit'), people);
    expect((await accountOf(userId))?.username).toBe('routes-three-renamed');

    const reverted = await send('POST', opUrl(userId, update, 'revert'), people);
    expect([reverted.statusCode, reverted.json().state]).toEqual([200, 'reverted']);
    expect(await accountOf(userId)).toEqual(before);
  });

  it('answers a prepare on a user another open operation keeps closed with the legacy 503', async () => {
    const userId = nextId('A');
    const people = await headersFor('people');
    await send('POST', opUrl(userId, nextId('C'), 'prepare'), people, prepareBody('create', 'routes-four'));

    expect((await send('POST', opUrl(userId, nextId('C'), 'prepare'), people, prepareBody('create', 'routes-four'))).statusCode).toBe(503);
  });

  it("accepts the token site's public pool site as siteId and refuses a pool the registry does not give that visibility", async () => {
    const people = await headersFor('people');
    const publicPool = await send('POST', opUrl(nextId('A'), nextId('C'), 'prepare'), people, {
      ...prepareBody('create', 'routes-five', { isPublic: 1, S2: undefined }),
      siteId: UMBRELLA,
    });
    const wrongPool = await send('POST', opUrl(nextId('A'), nextId('C'), 'prepare'), people, { ...prepareBody('create', 'routes-six'), siteId: UMBRELLA });

    expect(publicPool.statusCode).toBe(200);
    expect(await accountOf(publicPool.json().userId, UMBRELLA)).toMatchObject({ s2: 0, ispublic: 1, siteid: UMBRELLA, opt2_state: 'pending' });
    expect(wrongPool.statusCode).toBe(400);
  });

  it('answers the prepare of an update whose pool switch would move the account to another tenant with the legacy 503, recording nothing', async () => {
    const userId = nextId('A');
    const people = await headersFor('people');
    const create = nextId('C');
    await send('POST', opUrl(userId, create, 'prepare'), people, prepareBody('create', 'routes-seven'));
    await send('POST', opUrl(userId, create, 'commit'), people);
    await send('POST', opUrl(userId, create, 'finish'), people);
    const before = await accountOf(userId);
    const move = nextId('C');

    const res = await send('POST', opUrl(userId, move, 'prepare'), people, {
      ...prepareBody('update', 'routes-seven', { isPublic: 1, S2: undefined }),
      siteId: UMBRELLA,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error' } });
    expect((await send('GET', opUrl(userId, move), people)).json()).toEqual({ operationId: move, userId, state: 'unknown' });
    expect(await accountOf(userId)).toEqual(before);
    expect(await accountOf(userId, UMBRELLA)).toBeNull();
  });

  it.each<[string, 'create' | 'update', string | null | undefined, string | null]>([
    ['stores a created tablist trimmed', 'create', ' Basic ', 'Basic'],
    ['stores an empty created tablist as NULL', 'create', '', null],
    ['writes an updated tablist', 'update', 'Extended', 'Extended'],
    ['stores an emptied tablist as NULL', 'update', '', null],
    ['clears a tablist sent as null', 'update', null, null],
    ['keeps the stored tablist when none is sent', 'update', undefined, 'Basic'],
  ])('%s', async (_label, kind, tablist, stored) => {
    const userId = nextId('A');
    const username = `routes-tabs-${seq}`;
    if (kind === 'update') await applied(userId, prepareBody('create', username, { tablist: 'Basic' }));

    const account = { ...(kind === 'update' ? { Password: undefined } : {}), ...(tablist === undefined ? {} : { tablist }) };
    await applied(userId, prepareBody(kind, username, account));

    expect((await accountOf(userId))?.tablist).toBe(stored);
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['replaces every membership by default', {}, [AUTHORS]],
    ['keeps the memberships as stored with updateGroups false', { updateGroups: false }, [EDITORS, MEMBERS]],
    ['replaces only the memberships of the originID site', { originID: SITE }, [AUTHORS, MEMBERS]],
    ['replaces every membership under a blank originID', { originID: '' }, [AUTHORS]],
  ])('%s', async (_label, controls, expected) => {
    const userId = nextId('A');
    const username = `routes-groups-${seq}`;
    await applied(userId, { ...prepareBody('create', username), groupIds: [EDITORS, MEMBERS] });

    await applied(userId, { ...prepareBody('update', username, { Password: undefined }), groupIds: [AUTHORS], ...controls });

    expect(await membershipsOf(userId)).toEqual([...expected].sort());
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string, Partial<UserAccountRow>]>([
    ['switchToPublic picks the public pool over isPublic 0', { isPublic: 0 }, { switchToPublic: true }, UMBRELLA, { s2: 0, ispublic: 1 }],
    ['switchToPrivate picks the private pool over isPublic 1', { isPublic: 1 }, { switchToPrivate: true }, SITE, { s2: 0, ispublic: 0 }],
    ['switchToPublic wins over switchToPrivate', { isPublic: 0 }, { switchToPublic: true, switchToPrivate: true }, UMBRELLA, { s2: 0, ispublic: 1 }],
    ['an S2 save keeps the public pool its visibility chose and is stored private', { isPublic: 1, S2: 1 }, {}, UMBRELLA, { s2: 1, ispublic: 0 }],
    ['an S2 save switched to public keeps the public pool and is stored private', { isPublic: 0, S2: 1 }, { switchToPublic: true }, UMBRELLA, { s2: 1, ispublic: 0 }],
  ])('%s', async (_label, account, switches, pool, stored) => {
    const userId = nextId('A');

    await applied(userId, { ...prepareBody('create', `routes-pool-${seq}`, account), siteId: pool, ...switches });

    expect(await accountOf(userId, pool)).toMatchObject({ ...stored, siteid: pool, opt2_state: 'active' });
  });

  it('refuses a pool the posted switch does not pick', async () => {
    const res = await send('POST', opUrl(nextId('A'), nextId('C'), 'prepare'), await headersFor('people'), {
      ...prepareBody('create', `routes-pool-${seq}`, { isPublic: 1 }),
      switchToPrivate: true,
      siteId: UMBRELLA,
    });

    expect(res.statusCode).toBe(400);
  });

  it('records no session effects for a commit whose body has none', async () => {
    const op = await applied(nextId('A'), prepareBody('create', `routes-empty-${seq}`), {});

    expect(await pendingChangeOf(op)).not.toHaveProperty('sessionEffects');
  });

  it("records a self-save's session effects at commit and logs only that session in again at finish", async () => {
    const userId = nextId('A');
    const username = `routes-self-${seq}`;
    await applied(userId, prepareBody('create', username));
    const own = await loggedIn(userId, username);
    const other = await loggedIn(userId, username);
    const [ownBefore, otherBefore] = [await sessionOf(own), await sessionOf(other)];
    // The token's sub matches the path user as legacy compares user ids, ignoring case.
    const self = await selfHeaders(userId.toLowerCase(), own);
    const op = nextId('C');
    const person = { fname: 'Sam', lname: 'Self', email: 'sam@example.test', company: 'Acme', subtype: 'Default' };
    const update = prepareBody('update', username, { Password: undefined, remoteID: 'R-self' });
    expect((await send('POST', opUrl(userId, op, 'prepare'), self, update)).statusCode).toBe(200);

    const committed = await send('POST', opUrl(userId, op, 'commit'), self, { sessionEffects: { reloginSessionId: own, person } });
    expect(committed.statusCode).toBe(200);
    expect(await pendingChangeOf(op)).toMatchObject({ sessionEffects: { reloginSessionId: own, person } });
    expect(await sessionOf(own)).toEqual(ownBefore);

    const finished = await send('POST', opUrl(userId, op, 'finish'), await headersFor('people', false));
    expect([finished.statusCode, finished.json().state]).toEqual([200, 'finished']);
    const after = await sessionOf(own);
    expect(after).toMatchObject({ user_id: userId, state: 'active', epoch: String(Number(ownBefore?.epoch) + 1) });
    expect(JSON.parse(after?.login_snapshot ?? '{}')).toMatchObject({ userid: userId, username, remoteid: 'R-self', ...person });
    expect(await sessionOf(other)).toEqual(otherBefore);
  });

});
