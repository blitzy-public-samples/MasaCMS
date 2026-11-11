/** The `getAccount`, `lookupAccounts` and `listSiteGroups` routes over a throwaway `identity` schema: answers, contract shape, auth denials and the legacy 503s. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { createAccountReads } from '../../src/domain/account-reads.js';
import { registerAccountReadRoutes } from '../../src/routes/internal-account-reads.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';

type ContractOperation = Record<string, unknown>;
type Method = 'GET' | 'POST';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const CONTRACT_PATHS = ['/internal/v1/accounts/{userId}', '/internal/v1/accounts:lookup', '/internal/v1/groups'];
const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const SHORT_MS = 300;
const JSON_BODY = { 'content-type': 'application/json' };

function id(n: number, prefix = 'C'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

const ACTIVE = id(1);
const PENDING = id(2);
const PUBLIC = id(3);
const OTHER_TENANT = id(4);
const GROUP = id(5, 'D');
const MISSING = id(99);
const ACTIVE_RECORD = {
  UserID: ACTIVE,
  SiteID: 'tenant-a',
  UserName: 'ada',
  Type: 2,
  Admin: 1,
  S2: 1,
  Perm: 0,
  InActive: 0,
  isPublic: 0,
  remoteID: 'r-1',
  PasswordCreated: '2026-06-01T09:15:00.000',
  LastLogin: '2026-06-30T09:15:00.250',
  tablist: 'Basic,Extended',
};
const PUBLIC_RECORD = {
  UserID: PUBLIC,
  SiteID: 'umbrella',
  UserName: null,
  Type: 2,
  Admin: null,
  S2: 0,
  Perm: 0,
  InActive: 0,
  isPublic: 1,
  remoteID: null,
  PasswordCreated: null,
  LastLogin: null,
  tablist: null,
};

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: async () => undefined,
};

function account(userid: string, username: string, overrides: Partial<AccountInput> = {}): AccountInput {
  return { userid, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: 'tenant-a', remoteid: '', tablist: '', ...overrides };
}

function groupInput(overrides: Partial<GroupInput>): GroupInput {
  return {
    groupname: 'Editors', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: 'tenant-a',
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...overrides,
  };
}

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;

function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  return withGatedTenant(handle.app, tenantIdForSite(site), fn);
}

async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  const { schema } = handle;
  await withMetadata(handle.app, (tx) => tx.query(sql.replaceAll('$schema', schema), params));
}

async function registerSite(site: string, privatePool: string, publicPool: string): Promise<void> {
  await adminQuery(
    'INSERT INTO $schema.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id, private_user_pool_tenant,' +
      ' public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
    [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), CLOCK.now()],
  );
}

async function seed(): Promise<void> {
  await registerSite('tenant-a', 'tenant-a', 'umbrella');
  await registerSite('umbrella', 'umbrella', 'umbrella');
  await registerSite('tenant-b', 'tenant-b', 'tenant-b');
  await gated('tenant-a', async (tx) => {
    await repo.insertAccount(tx, account(ACTIVE, 'ada', { admin: 1, s2: 1, remoteid: 'r-1', tablist: 'Basic,Extended' }));
    await repo.writeCredential(tx, ACTIVE, { password: 'stored-hash', passwordcreated: new Date(2026, 5, 1, 9, 15, 0) });
    await repo.touchLastLogin(tx, ACTIVE, new Date(2026, 5, 30, 9, 15, 0, 250));
    await repo.insertAccount(tx, account(PENDING, 'pat', { opt2_state: 'pending' }));
    await repo.insertGroup(tx, groupInput({ userid: GROUP, groupname: 'Admin', perm: 1 }), null);
    await repo.insertGroup(tx, groupInput({ groupname: 'editors' }), null);
    await repo.insertGroup(tx, groupInput({ groupname: 'Authors' }), null);
  });
  await gated('umbrella', async (tx) => {
    await repo.insertAccount(tx, account(PUBLIC, '', { ispublic: 1, siteid: 'umbrella' }));
    await repo.insertGroup(tx, groupInput({ groupname: 'Members', ispublic: 1, siteid: 'umbrella' }), null);
  });
  await gated('tenant-b', (tx) => repo.insertAccount(tx, account(OTHER_TENANT, 'bea', { siteid: 'tenant-b' })));
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-account-read-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await adminQuery("UPDATE $schema.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'");
    await seed();
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
  const accountReads = createAccountReads({ repo, closedUserWaitMs: SHORT_MS, gateWaitMs: SHORT_MS });
  await registerAccountReadRoutes(app, { db: handle?.app ?? NO_DB, accountReads });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a `caller` service call made for a user of `site`; no `site` sends the invocation credential alone. */
async function headersFor(caller: string | null, site: string | null = 'tenant-a'): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (site !== null) {
    headers.authorization = `Bearer ${await mintUserToken({ sub: 'test-editor', site, roles: [Roles.systemUser] })}`;
  }
  if (caller !== null) {
    headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  }
  return headers;
}

/** Injects a request and checks the answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, ...JSON_BODY },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.method !== 'HEAD' && route.url !== '/healthz');
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: (operation['x-opt2-fastify-path'] as string | undefined) ?? template.replace('{userId}', ':userId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        })),
    );
    expect(expected).toHaveLength(3);
    expect(declared).toHaveLength(3);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
  });
});

describe('auth denials', () => {
  it.each([
    ['GET', `/internal/v1/accounts/${ACTIVE}`, undefined],
    ['POST', '/internal/v1/accounts:lookup', { userIds: [ACTIVE] }],
    ['GET', '/internal/v1/groups?ispublic=0', undefined],
  ] as const)('refuse %s %s to callers other than people and to people without a user token', async (method, url, payload) => {
    for (const caller of ['gateway', 'strategies-content', 'identity']) {
      expect((await send(method, url, await headersFor(caller), payload)).statusCode).toBe(403);
    }
    expect((await send(method, url, await headersFor(null), payload)).statusCode).toBe(401);
    expect((await send(method, url, await headersFor('people', null), payload)).statusCode).toBe(401);
  });

  it.each([
    ['GET', `/internal/v1/accounts/${ACTIVE}?siteid=tenant-b`, undefined],
    ['POST', '/internal/v1/accounts:lookup?siteid=umbrella', { userIds: [ACTIVE] }],
    ['GET', '/internal/v1/groups?siteid=tenant-b&ispublic=0', undefined],
  ] as const)('answer %s %s, whose siteid is not the token site, with 403', async (method, url, payload) => {
    const res = await send(method, url, await headersFor('people'), payload);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
  });

  it.each([
    ['no body', undefined],
    ['no userIds', {}],
    ['an empty list', { userIds: [] }],
    ['a repeated id', { userIds: [ACTIVE, ACTIVE] }],
    ['an id that is no CF UUID', { userIds: ['not-a-uuid'] }],
  ])('answer a lookup with %s with the legacy 400', async (_label, payload) => {
    const res = await send('POST', '/internal/v1/accounts:lookup', await headersFor('people'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });

  it.each(['/internal/v1/groups', '/internal/v1/groups?ispublic=2', '/internal/v1/groups?ispublic=0&siteid='])(
    'answer %s with the legacy 400',
    async (url) => {
      expect((await send('GET', url, await headersFor('people'))).statusCode).toBe(400);
    },
  );
});

describe.skipIf(!available)('reads against PostgreSQL', () => {
  beforeEach(async () => {
    await adminQuery("UPDATE $schema.unit_gate SET phase = 'quiet'");
  });

  it('answers getAccount with the 13 identity columns of a stored account in either pool of the token site', async () => {
    const headers = await headersFor('people');

    expect((await send('GET', `/internal/v1/accounts/${ACTIVE}`, headers)).json()).toEqual(ACTIVE_RECORD);
    expect((await send('GET', `/internal/v1/accounts/${PUBLIC}?siteid=TENANT-A`, headers)).json()).toEqual(PUBLIC_RECORD);
  });

  it.each([
    ['a missing user', MISSING],
    ['a group', GROUP],
    ['a pending account', PENDING],
    ['a user outside the token site\'s pools', OTHER_TENANT],
  ])('answers getAccount for %s with the legacy 404', async (_label, userId) => {
    const res = await send('GET', `/internal/v1/accounts/${userId}`, await headersFor('people'));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Invalid method call' } });
  });

  it('answers lookupAccounts with the found users in request order', async () => {
    const res = await send('POST', '/internal/v1/accounts:lookup', await headersFor('people'), {
      userIds: [PUBLIC, MISSING, GROUP, PENDING, OTHER_TENANT, ACTIVE],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [PUBLIC_RECORD, ACTIVE_RECORD] });
  });

  it.each([
    ['0', [['Admin', 1, 'tenant-a'], ['Authors', 0, 'tenant-a'], ['editors', 0, 'tenant-a']], 0],
    ['1', [['Members', 0, 'umbrella']], 1],
  ])('answers listSiteGroups with ispublic=%s from the matching user pool', async (ispublic, expected, isPublic) => {
    const res = await send('GET', `/internal/v1/groups?siteid=tenant-a&ispublic=${ispublic}`, await headersFor('people'));

    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<{ GroupName: string; Perm: number; SiteID: string; isPublic: number; UserID: string }> };
    expect(items.map((group) => [group.GroupName, group.Perm, group.SiteID])).toEqual(expected);
    expect(items.every((group) => group.isPublic === isPublic)).toBe(true);
    if (isPublic === 0) expect(items[0]?.UserID).toBe(GROUP);
  });

  it('answers the legacy 503 while an account operation keeps the user closed past the wait', async () => {
    const op = await gated('tenant-a', (tx) => repo.insertAccountOperation(tx, { user_id: ACTIVE, kind: 'update', state: 'committed' }));
    try {
      const headers = await headersFor('people');
      for (const [method, url, payload] of [
        ['GET', `/internal/v1/accounts/${ACTIVE}`, undefined],
        ['POST', '/internal/v1/accounts:lookup', { userIds: [MISSING, ACTIVE] }],
      ] as const) {
        const res = await send(method, url, headers, payload);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ error: { message: 'Unhandled Exception' } });
      }
    } finally {
      await gated('tenant-a', (tx) => repo.setAccountOperationState(tx, op.operation_id, ['committed'], 'finished'));
    }
    expect((await send('GET', `/internal/v1/accounts/${ACTIVE}`, await headersFor('people'))).statusCode).toBe(200);
  });

  it.each([
    ['identity.user_account', 'GET', `/internal/v1/accounts/${ACTIVE}`, undefined],
    ['identity.credential', 'POST', '/internal/v1/accounts:lookup', { userIds: [ACTIVE] }],
    ['identity.group_account', 'GET', '/internal/v1/groups?ispublic=0', undefined],
  ] as const)('answers the legacy 503 while a window executes on %s past the gate wait', async (unit, method, url, payload) => {
    await adminQuery("UPDATE $schema.unit_gate SET phase = 'executing' WHERE unit = $1", [unit]);

    expect((await send(method, url, await headersFor('people'), payload)).statusCode).toBe(503);
  });
});
