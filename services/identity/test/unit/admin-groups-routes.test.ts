/** The cUsers group routes over a throwaway `identity` schema: contract shape, the cUsers gate, `before()` defaults and scrubbing, CSRF contexts, S2-record protection, members, the members CSV and a user's memberships. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { consumeEnvelope } from '@opt2/platform/events';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, loadEnv, type FastifyInstance, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testEnvelope,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { issueTokens, type CsrfDeps } from '../../src/domain/csrf.js';
import type { GroupDeps } from '../../src/domain/groups.js';
import { PERSON_CHANGED_TOPIC, PERSON_CONTACT_SUBSCRIPTION, personContactConsumer, type PersonChangedPayload } from '../../src/events/person-contact.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
import { createContentClient } from '../../src/legacy/content-client.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { registerAdminGroupRoutes } from '../../src/routes/admin-groups.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const CONTRACT_PATHS = [
  '/v1/groups',
  '/v1/groups/{groupId}',
  '/v1/groups/{groupId}/members',
  '/v1/groups/{groupId}/members.csv',
  '/v1/groups/{groupId}/members/{userId}',
  '/v1/users/{userId}/memberships',
];
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const SECRET = 'K0000000-0000-0000-0000000000000002';
const ADMIN_USER = 'A0000000-0000-0000-0000000000000001';
const EDITOR_USER = 'A0000000-0000-0000-0000000000000002';
const UNKNOWN_GROUP = 'D0000000-0000-0000-0000000000000001';
const USERS_MODULE = 'm:008';
const SITE_MANAGER = 'm:000';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };

// Gate cases need no database; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: () => Promise.resolve(),
};

const RELAY: BridgeRelay = { markUsed: () => Promise.resolve({ applied: true }) };

const STORED_PHOTO = 'F0000000-0000-0000-0000000000000001';
const MISSING_PHOTO = 'F0000000-0000-0000-0000000000000002';
/** The `tfiles` rows strategies-content's photo lookup answers from, by file id. */
const PHOTO_EXTENSIONS: ReadonlyMap<string, string | null> = new Map([[STORED_PHOTO, 'jpg']]);
const UNAVAILABLE = { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } };
const content = { lookups: [] as string[][], status: 200 };

/** strategies-content behind identity's content client: records each `lookupFileExtensions` call and answers it from PHOTO_EXTENSIONS. */
const CONTENT_SERVICE: ServiceClient = {
  request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
    if (req.service !== 'strategies-content' || req.method !== 'POST' || req.path !== '/internal/v1/files:lookup') {
      return Promise.reject(new Error(`unexpected request ${req.service} ${req.method} ${req.path}`));
    }
    const { fileIds } = req.json as { fileIds: string[] };
    content.lookups.push(fileIds);
    const items = fileIds.flatMap((fileId) => (PHOTO_EXTENSIONS.has(fileId) ? [{ fileId, fileExt: PHOTO_EXTENSIONS.get(fileId) ?? null }] : []));
    return Promise.resolve({ status: content.status, headers: {}, body: (content.status === 200 ? { items } : UNAVAILABLE) as T });
  },
  close: () => Promise.resolve(),
};

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let sequence = 0;
const ids = { editors: '', admins: '', supers: '', members: '', parent: '', beta: '', alpha: '', s2Member: '' };

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}0000000-0000-0000-${String(sequence).padStart(16, '0')}`;
}

function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  return withGatedTenant(handle.app, tenantIdForSite(site), fn);
}

async function registerSite(db: TenantDb, schema: string, site: string, privatePool: string, publicPool: string): Promise<void> {
  await withMetadata(db, (tx) =>
    tx.query(
      `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
        ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
      [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), NOW],
    ),
  );
}

function groupInput(groupname: string, siteid: string, ispublic: 0 | 1, extra: Partial<GroupInput> = {}): GroupInput {
  return {
    groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '', ...extra,
  };
}

async function seedUser(lname: string, s2: number): Promise<string> {
  const userId = nextId('E');
  await gated(SITE, async (tx) => {
    await repo.insertAccount(tx, { userid: userId, username: `u${sequence}`, type: 2, s2, perm: 0, inactive: 0, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
    await repo.upsertPersonContact(tx, { user_id: userId, site_id: SITE, email: `${lname}@example.com`, fname: 'F', lname, company: 'A, B', subtype: null, aggregate_version: 1 });
  });
  return userId;
}

/** Seeds the site's system groups, an S2 group, the umbrella's member group, and three members of Editors. */
async function seed(db: TenantDb, schema: string): Promise<void> {
  await registerSite(db, schema, SITE, SITE, UMBRELLA);
  await registerSite(db, schema, UMBRELLA, UMBRELLA, UMBRELLA);
  await gated(SITE, async (tx) => {
    ids.editors = (await repo.insertGroup(tx, groupInput('Editors', SITE, 0), null)).userid;
    ids.admins = (await repo.insertGroup(tx, groupInput('Admin', SITE, 0, { perm: 1 }), null)).userid;
    ids.supers = (await repo.insertGroup(tx, groupInput('Supers', SITE, 0, { s2: 1, email: 'supers@example.com' }), null)).userid;
    ids.parent = (await repo.insertGroup(tx, groupInput('Parent', SITE, 0), null)).userid;
  });
  await gated(UMBRELLA, async (tx) => {
    ids.members = (await repo.insertGroup(tx, groupInput('Members', UMBRELLA, 1), null)).userid;
  });
  ids.beta = await seedUser('Beta', 0);
  ids.alpha = await seedUser('alpha', 0);
  ids.s2Member = await seedUser('Zed', 1);
  await gated(SITE, async (tx) => {
    for (const member of [ids.beta, ids.alpha, ids.s2Member]) await repo.addMembership(tx, member, ids.editors);
    await repo.addMembership(tx, ids.beta, ids.parent);
    await repo.addMembership(tx, ids.supers, ids.parent);
  });
}

function groupsDeps(db: TenantDb): GroupDeps {
  return {
    db,
    repo,
    events: createIdentityEvents(repo),
    clock: CLOCK,
    settings: { password: { encryptPasswords: true, bcryptPasswords: true, bcryptLogRounds: 4 }, hashAlgorithm: 'CFMX_COMPAT' },
    sleep: () => Promise.resolve(),
  };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-admin-groups-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: identityPayloadValidators });
    await seed(handle.app, schema);
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
  const db = handle?.app ?? NO_DB;
  const csrf: CsrfDeps = { db, repo, bridge: RELAY, clock: CLOCK, sleep: () => Promise.resolve() };
  await registerAdminGroupRoutes(app, { groups: groupsDeps(db), content: createContentClient(CONTENT_SERVICE), sessions: { db, repo, clock: CLOCK }, csrf });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a gateway-relayed call for a `tenant-a` user holding `roles` in session `sid`; null `roles` sends no user token. */
async function headersFor(roles: readonly string[] | null, sid?: string, sub = ADMIN_USER): Promise<Record<string, string>> {
  const headers: Record<string, string> = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity' })}` };
  if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ sub, sid, site: SITE, roles })}`;
  return headers;
}

/** Injects a request, form fields as a form post, and checks the answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, form?: Record<string, string>) {
  const res = await app.inject({
    method,
    url,
    headers: form === undefined ? headers : { ...headers, ...FORM_BODY },
    payload: form === undefined ? undefined : new URLSearchParams(form).toString(),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

const DECLARED: [Method, string][] = [
  ['GET', '/v1/groups'],
  ['POST', '/v1/groups'],
  ['GET', `/v1/groups/${UNKNOWN_GROUP}`],
  ['PUT', `/v1/groups/${UNKNOWN_GROUP}`],
  ['GET', `/v1/groups/${UNKNOWN_GROUP}/members`],
  ['GET', `/v1/groups/${UNKNOWN_GROUP}/members.csv`],
  ['POST', `/v1/groups/${UNKNOWN_GROUP}/members/${ADMIN_USER}`],
  ['DELETE', `/v1/groups/${UNKNOWN_GROUP}/members/${ADMIN_USER}`],
  ['GET', `/v1/users/${ADMIN_USER}/memberships`],
];

describe('route declarations', () => {
  it('match the nine contract operations, each behind the cUsers roles on the service transport', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{groupId}', ':groupId').replace('{userId}', ':userId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        })),
    );
    expect(expected).toHaveLength(9);
    expect(declared).toHaveLength(9);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry): unknown => expect.objectContaining(entry))));
  });
});

describe('cUsers gate', () => {
  it.each(DECLARED)('refuses %s %s to users without s2, site-admin or both module grants with 403', async (method, url) => {
    for (const roles of [[Roles.systemUser], [Roles.member], [Roles.systemUser, USERS_MODULE], [SITE_MANAGER]]) {
      expect((await send(method, url, await headersFor(roles))).statusCode).toBe(403);
    }
  });

  it.each(DECLARED)('answers %s %s without a user token with 401 and for another site with 403', async (method, url) => {
    expect((await send(method, url, await headersFor(null))).statusCode).toBe(401);
    expect((await send(method, `${url}?siteid=tenant-b`, await headersFor([Roles.s2]))).statusCode).toBe(403);
  });

  it.each<[Method, string]>([
    ['POST', '/v1/groups'],
    ['PUT', `/v1/groups/G${UNKNOWN_GROUP.slice(1, 34)}`],
  ])('answers %s %s with a malformed group id as invalid parameters', async (method, url) => {
    const res = await send(method, url, await headersFor([Roles.s2]), { userid: 'not-a-uuid', groupname: 'X' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });

  it.each(
    ['/v1/groups', `/v1/groups/${UNKNOWN_GROUP}/members`].flatMap((path) =>
      ['offset=-1', 'offset=1.5', 'offset=x', 'offset=9007199254740992', 'limit=0', 'limit=1001', 'limit=2.5', 'limit=1&limit=2'].map((query) => `${path}?${query}`),
    ),
  )('answers GET %s with invalid parameters before any read', async (url) => {
    const res = await send('GET', url, await headersFor([Roles.s2]));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
  });
});

describe.skipIf(!available)('cUsers group actions against PostgreSQL', () => {
  /** Inserts an active session of `userId` whose login-time role list is `roleList`, and returns its id. */
  async function newSession(userId: string, roleList: string): Promise<string> {
    const sessionId = `S-groups-${nextId('S')}`;
    const snapshot = {
      userid: userId, username: 'admin', siteid: SITE, subtype: 'Default', password: null, fname: 'Admin', lname: 'User', email: null,
      remoteid: null, company: null, lastlogin: null, passwordcreated: null, roleList, membershipIds: userId,
    };
    await gated(SITE, (tx) =>
      repo.insertSession(tx, { session_id: sessionId, csrf_secret: SECRET, mode: 'target-primary', state: 'active', user_id: userId, site_id: SITE, login_snapshot: JSON.stringify(snapshot) }),
    );
    return sessionId;
  }

  function csrfFields(context: string): Record<string, string> {
    const { token, expires } = issueTokens({ csrfSecret: SECRET }, { context, clock: CLOCK });
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  const admin = async (): Promise<Record<string, string>> => headersFor([Roles.s2, Roles.systemUser], await newSession(ADMIN_USER, `S2,Admin;${SITE};0`));
  const editor = async (): Promise<Record<string, string>> =>
    headersFor([Roles.systemUser, USERS_MODULE, SITE_MANAGER], await newSession(EDITOR_USER, `Editors;${SITE};0`), EDITOR_USER);

  it('lists system groups for an admin and member groups for a module-grant editor asking for system groups', async () => {
    const asAdmin = await send('GET', '/v1/groups?ispublic=0', await admin());
    const asEditor = await send('GET', '/v1/groups?ispublic=0', await editor());

    expect(asAdmin.json<{ items: { GroupName: string; Counter: number | null; Perm: number }[] }>().items.slice(0, 2)).toMatchObject([
      { GroupName: 'Admin', Perm: 1, Counter: null },
      { GroupName: 'Editors', Perm: 0, Counter: 3 },
    ]);
    expect(asEditor.json<{ items: { GroupName: string; isPublic: number }[] }>().items).toEqual([expect.objectContaining({ GroupName: 'Members', isPublic: 1 })]);
  });

  it('reads a stored group without its password, and an unknown id as a new Member group under a fresh id', async () => {
    const stored = await send('GET', `/v1/groups/${ids.editors}`, await admin());
    const unknown = await send('GET', `/v1/groups/${UNKNOWN_GROUP}`, await admin());

    expect(stored.json()).toMatchObject({ isNew: false, group: { UserID: ids.editors, GroupName: 'Editors', Type: 1, SiteID: SITE } });
    const fresh = unknown.json<{ isNew: boolean; group: { UserID: string; isPublic: number; subType: string } }>();
    expect(fresh).toMatchObject({ isNew: true, group: { isPublic: 1, subType: 'Default' } });
    expect(fresh.group.UserID).toHaveLength(35);
    expect(fresh.group.UserID).not.toBe(UNKNOWN_GROUP);
  });

  /** Every object key of `value`, at any depth. */
  function keysOf(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(keysOf);
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }

  it.each<[string, () => Promise<{ json: () => unknown }>]>([
    ['a stored group', async () => send('GET', `/v1/groups/${ids.editors}`, await admin())],
    ['a new group bean', async () => send('GET', `/v1/groups/${UNKNOWN_GROUP}`, await admin())],
    ["a group's members", async () => send('GET', `/v1/groups/${ids.editors}/members`, await admin())],
    ['a created group', async () => {
      const userid = nextId('B');
      return send('POST', '/v1/groups', await admin(), { userid, groupname: 'Keyless', isPublic: '0', ...csrfFields(userid) });
    }],
    ['an updated group', async () => {
      const userid = nextId('B');
      await send('POST', '/v1/groups', await admin(), { userid, groupname: 'Keyless', isPublic: '0', ...csrfFields(userid) });
      return send('PUT', `/v1/groups/${userid}`, await admin(), { groupname: 'Keyless Too', isPublic: '0', ...csrfFields(userid) });
    }],
  ])('leaves Password and PasswordCreated out of %s', async (_case, answer) => {
    const keys = keysOf((await answer()).json());
    expect(keys.some((key) => key === 'UserID' || key === 'userID')).toBe(true);
    expect(keys.filter((key) => /^password(created)?$/i.test(key))).toEqual([]);
  });

  type Body = Record<string, unknown>;
  type Tamper = (body: Body, key: string) => Body;
  it.each<[string, string, string, Tamper]>(
    ['Password', 'PasswordCreated', 'passwordcreated'].flatMap((key): [string, string, string, Tamper][] => [
      ['GroupAccount', key, `/v1/groups/${UNKNOWN_GROUP}`, (body, name) => ({ ...body, group: { ...(body.group as Body), [name]: null } })],
      ['GroupMember', key, `/v1/groups/${UNKNOWN_GROUP}/members`, (body, name) => ({ ...body, items: [{ groupID: UNKNOWN_GROUP, userID: ADMIN_USER, [name]: null }] })],
    ]),
  )('the contract refuses a %s carrying %s', async (_schema, key, url, tamper) => {
    const res = await send('GET', url, await admin());
    const response = { method: 'GET', path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body };
    expect(res.statusCode).toBe(200);
    expect(() => assertResponseMatchesOpenApi(OPENAPI, { ...response, body: JSON.stringify(tamper(res.json(), 'Notes')) })).not.toThrow();
    expect(() => assertResponseMatchesOpenApi(OPENAPI, { ...response, body: JSON.stringify(tamper(res.json(), key)) })).toThrow();
  });

  it('refuses photo and extended-attribute saves as invalid parameters before any write', async () => {
    const userid = nextId('B');
    const withheld: Record<string, string>[] = [{ newFile: 'p.png' }, { removePhotoFile: 'true' }, { extendSetID: 'X' }];
    for (const extra of withheld) {
      const res = await send('POST', '/v1/groups', await admin(), { userid, groupname: 'Withheld', ...extra, ...csrfFields(userid) });
      expect(res.statusCode).toBe(400);
    }
    // A JSON field CFML cannot hold as a simple value is refused alike.
    const listValued = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: { ...(await admin()), 'content-type': 'application/json' },
      payload: JSON.stringify({ userid, groupname: ['A', 'B'], ...csrfFields(userid) }),
    });
    expect(listValued.statusCode).toBe(400);
    expect((await send('GET', `/v1/groups/${userid}`, await admin())).json()).toMatchObject({ isNew: true });
  });

  it('answers a save without a valid token with 500 and writes nothing', async () => {
    const userid = nextId('B');
    const missing = await send('POST', '/v1/groups', await admin(), { userid, groupname: 'NoToken' });
    const otherContext = await send('POST', '/v1/groups', await admin(), { userid, groupname: 'NoToken', ...csrfFields(ids.editors) });

    expect([missing.statusCode, otherContext.statusCode]).toEqual([500, 500]);
    expect((await send('GET', `/v1/groups/${userid}`, await admin())).json()).toMatchObject({ isNew: true });
  });

  it('creates under the posted id as CSRF context, forcing a non-admin to a Member group', async () => {
    const adminGroup = nextId('B');
    const editorGroup = nextId('B');
    const asAdmin = await send('POST', '/v1/groups', await admin(), { userid: adminGroup, groupname: 'Reviewers', isPublic: '0', action: 'Add', type: '1', ...csrfFields(adminGroup) });
    const asEditor = await send('POST', '/v1/groups', await editor(), { userid: editorGroup, groupname: 'Helpers', isPublic: '0', ...csrfFields(editorGroup) });

    expect(asAdmin.json()).toMatchObject({ written: true, errors: {}, group: { UserID: adminGroup, isPublic: 0, SiteID: SITE, LastUpdateBy: 'Admin User' } });
    expect(asEditor.json()).toMatchObject({ written: true, group: { UserID: editorGroup, isPublic: 1, SiteID: UMBRELLA } });
    expect(asAdmin.headers['x-opt2-write-position']).toMatch(/=\d+$/);
  });

  it('updates under the path id as CSRF context, clearing the unposted memberships and fields as before() defaults them', async () => {
    const groupId = nextId('B');
    await send('POST', '/v1/groups', await admin(), { userid: groupId, groupname: 'Old', email: 'old@example.com', isPublic: '0', groupid: ids.parent, ...csrfFields(groupId) });

    const res = await send('PUT', `/v1/groups/${groupId}`, await admin(), { groupname: 'New', isPublic: '0', ...csrfFields(groupId) });

    expect(res.json()).toMatchObject({ written: true, group: { GroupName: 'New', Email: null } });
    expect(await gated(SITE, (tx) => repo.membershipGroupIds(tx, groupId))).toEqual([]);
  });

  it('keeps the login and visibility fields of an S2 group a non-superuser saves', async () => {
    const res = await send('PUT', `/v1/groups/${ids.supers}`, await editor(), {
      groupname: 'Supers', email: 'changed@example.com', isPublic: '1', s2: '0', ...csrfFields(ids.supers),
    });

    expect(res.json()).toMatchObject({ written: true, group: { Email: 'supers@example.com', isPublic: 0, SiteID: SITE } });
  });

  it('lists members by last name with legacy columns, S2 members only for an S2 caller', async () => {
    const asAdmin = await send('GET', `/v1/groups/${ids.editors}/members`, await admin());
    const asEditor = await send('GET', `/v1/groups/${ids.editors}/members`, await editor());

    const members = asAdmin.json<{ items: Record<string, unknown>[] }>().items;
    expect(members.map((member) => member.Lname)).toEqual(['alpha', 'Beta', 'Zed']);
    expect(members[0]).toMatchObject({ groupID: ids.alpha, userID: ids.alpha, Type: 2, S2: 0, SiteID: SITE, JobTitle: null, photoFileExt: null });
    expect(Object.keys(members[0] ?? {}).slice(0, 3)).toEqual(['groupID', 'userID', 'GroupName']);
    expect(asEditor.json<{ items: Record<string, unknown>[] }>().items.map((member) => member.Lname)).toEqual(['alpha', 'Beta']);
  });

  type Page = { items: Record<string, unknown>[]; total: number; nextOffset: number | null };

  it.each<[string, () => Promise<Record<string, string>>, string, (string | null)[], number, number | null]>([
    ['an S2 caller, the first window', admin, 'offset=0&limit=2', ['alpha', 'Beta'], 3, 2],
    ['an S2 caller, a middle window', admin, 'offset=1&limit=1', ['Beta'], 3, 2],
    ['an S2 caller, the last window', admin, 'offset=2&limit=5', ['Zed'], 3, null],
    ['an S2 caller, past the listing', admin, 'offset=3', [], 3, null],
    ['an S2 caller, the defaults', admin, '', ['alpha', 'Beta', 'Zed'], 3, null],
    ['a module-grant editor, without the S2 member', editor, 'offset=1&limit=1', ['Beta'], 2, null],
  ])('pages the members for %s with the listing total and the next offset', async (_case, caller, query, lnames, total, nextOffset) => {
    const res = await send('GET', `/v1/groups/${ids.editors}/members?${query}`, await caller());

    expect(res.statusCode).toBe(200);
    const page = res.json<Page>();
    expect({ lnames: page.items.map((member) => member.Lname), total: page.total, nextOffset: page.nextOffset }).toEqual({ lnames, total, nextOffset });
  });

  it('pages the groups by following nextOffset through windows of every listing row, and answers a window past the listing empty', async () => {
    const headers = await admin();
    const whole = (await send('GET', '/v1/groups?ispublic=0', headers)).json<Page>();
    expect(whole.nextOffset).toBeNull();
    expect(whole.total).toBe(whole.items.length);
    expect(whole.total).toBeGreaterThan(3);

    const walked: Record<string, unknown>[] = [];
    const offsets: number[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      offsets.push(offset);
      const page: Page = (await send('GET', `/v1/groups?ispublic=0&offset=${offset}&limit=2`, headers)).json<Page>();
      expect(page.total).toBe(whole.total);
      walked.push(...page.items);
      offset = page.nextOffset;
    }

    expect(walked).toEqual(whole.items);
    expect(offsets).toEqual(Array.from({ length: Math.ceil(whole.total / 2) }, (_, n) => n * 2));
    expect((await send('GET', `/v1/groups?ispublic=0&offset=${whole.total}`, headers)).json()).toEqual({ items: [], total: whole.total, nextOffset: null });
  });

  it('downloads the members as the legacy users CSV: ACF columnList order, trailing spaces, commas kept, LF ends', async () => {
    const res = await send('GET', `/v1/groups/${ids.editors}/members.csv`, await editor());

    expect(res.headers['content-type']).toBe('text/csv; charset=UTF-8');
    expect(res.headers['content-disposition']).toBe('attachment;filename=users.csv');
    const [header, first, second, end] = res.body.split('\n');
    expect(header).toBe(
      '"COMPANY","CONTACTFORM","CREATED","DESCRIPTION","EMAIL","FNAME","GROUPID","GROUPNAME","IMNAME","IMSERVICE","INACTIVE",' +
        '"INTERESTS","ISPUBLIC","JOBTITLE","KEEPPRIVATE","LASTLOGIN","LASTUPDATE","LASTUPDATEBY","LASTUPDATEBYID","LNAME",' +
        '"MOBILEPHONE","NOTES","PASSWORDCREATED","PERM","PHOTOFILEEXT","PHOTOFILEID","REMOTEID","S2","SITEID","SUBSCRIBE",' +
        '"SUBTYPE","TABLIST","TAGS","TYPE","USERID","USERNAME","WEBSITE"',
    );
    const blank = '" "';
    const cells = [
      '"A, B "', blank, blank, blank, '"alpha@example.com "', '"F "', `"${ids.alpha} "`, blank, blank, blank, '0 ',
      blank, '0 ', blank, blank, blank, blank, blank, blank, '"alpha "',
      blank, blank, blank, '0 ', blank, blank, blank, '0 ', '"tenant-a "', blank,
      blank, blank, blank, '2 ', `"${ids.alpha} "`, expect.stringMatching(/^"u\d+ "$/), blank,
    ];
    expect(first?.split(/,(?=")|,(?=\d)/)).toEqual(cells);
    expect(second).toContain('"Beta "');
    expect(end).toBe('');
  });

  it('adds a member only under a token for <userId><groupId>addtogroup, and removes one without any token', async () => {
    const userId = ids.beta;
    const groupId = ids.admins;
    const url = `/v1/groups/${groupId}/members/${userId}`;

    const noToken = await send('POST', url, await admin());
    const wrongContext = await send('POST', url, await admin(), csrfFields(`${groupId}${userId}addtogroup`));
    const added = await send('POST', url, await admin(), csrfFields(`${userId}${groupId}addtogroup`));
    const again = await send('POST', url, await admin(), csrfFields(`${userId}${groupId}addtogroup`));

    expect([noToken, wrongContext, added, again].map((res) => res.json())).toEqual([{ written: false }, { written: false }, { written: true }, { written: false }]);
    const removed = await send('DELETE', url, await editor());
    expect(removed.json()).toEqual({ written: true });
    expect(await gated(SITE, (tx) => repo.membershipGroupIds(tx, userId))).not.toContain(groupId);
  });

  it("answers a user's memberships with the site's system and member groups and the held groups by name", async () => {
    const res = await send('GET', `/v1/users/${ids.beta}/memberships`, await admin());

    const body = res.json<{ privateGroups: { GroupName: string }[]; publicGroups: { GroupName: string }[]; groupIds: string[] }>();
    expect(body.privateGroups.map((group) => group.GroupName).slice(0, 2)).toEqual(['Admin', 'Editors']);
    expect(body.publicGroups.map((group) => group.GroupName)).toEqual(['Helpers', 'Members']);
    expect(body.groupIds).toEqual([ids.editors, ids.parent]);
  });

  it('answers a session that has ended as a missing credential before any save', async () => {
    const sessionId = await newSession(ADMIN_USER, 'S2');
    await gated(SITE, (tx) => repo.updateSession(tx, sessionId, { state: 'ended' }));
    const groupId = nextId('B');

    const res = await send('POST', '/v1/groups', await headersFor([Roles.s2], sessionId), { userid: groupId, groupname: 'Late', ...csrfFields(groupId) });

    expect(res.statusCode).toBe(401);
  });

  // Oracle: legacy cUsers.list lists the pool its admin Portcullis scan and `before()` scrub leave `ispublic` naming;
  // the scan re-serializes a padded lowercase `true`/`false` and other JSON, none of which is then a boolean.
  it.each<[sent: string, who: 'admin' | 'editor', isPublic: 0 | 1]>([
    [' 0 ', 'admin', 0],
    ['0 ', 'admin', 0],
    ['\t0\n', 'admin', 0],
    ['0\u0000', 'admin', 0],
    ['\u00010', 'admin', 0],
    [' -0', 'admin', 0],
    [' 1 ', 'admin', 1],
    [' false', 'admin', 1],
    [' true', 'admin', 1],
    ['"0"', 'admin', 1],
    ['[0]', 'admin', 1],
    ['\u00a00', 'admin', 1],
    [' 0 ', 'editor', 1],
  ])('lists ispublic %j for an %s as the isPublic %d pool', async (sent, who, isPublic) => {
    const res = await send('GET', `/v1/groups?${new URLSearchParams({ ispublic: sent }).toString()}`, who === 'admin' ? await admin() : await editor());

    const { items, total, nextOffset } = res.json<Page>();
    expect(items.map((item) => item.GroupName)).toContain(isPublic === 0 ? 'Editors' : 'Members');
    expect(new Set(items.map((item) => item.isPublic))).toEqual(new Set([isPublic]));
    expect({ total, nextOffset }).toEqual({ total: items.length, nextOffset: null });
  });

  // The posted form field passes the same scan and scrub before `userBean.set` reads it.
  it.each<[sent: string, isPublic: 0 | 1, site: string]>([
    [' 0 ', 0, SITE],
    ['\t0\n', 0, SITE],
    ['0\u0000', 0, SITE],
    [' 1 ', 1, UMBRELLA],
    [' false', 1, UMBRELLA],
    ['"0"', 1, UMBRELLA],
  ])('creates an admin group posted with isPublic %j as isPublic %d of %s', async (sent, isPublic, site) => {
    const groupId = nextId('B');
    const res = await send('POST', '/v1/groups', await admin(), { userid: groupId, groupname: `Scanned ${groupId}`, isPublic: sent, ...csrfFields(groupId) });

    expect(res.json()).toMatchObject({ written: true, errors: {}, group: { UserID: groupId, isPublic, SiteID: site } });
  });

  describe('member columns', () => {
    const MEMBER_KEYS = [
      'groupID', 'userID', 'GroupName', 'Fname', 'Lname', 'UserName', 'PasswordCreated', 'Email', 'Company', 'JobTitle', 'MobilePhone',
      'Website', 'Type', 'subType', 'ContactForm', 'S2', 'LastLogin', 'LastUpdate', 'LastUpdateBy', 'LastUpdateByID', 'Perm', 'InActive',
      'IsPublic', 'SiteID', 'Subscribe', 'Notes', 'description', 'Interests', 'keepPrivate', 'PhotoFileID', 'IMName', 'IMService',
      'Created', 'RemoteID', 'Tags', 'tablist', 'photoFileExt',
    ];
    /** The keys of a JSON member row: every query column but `PasswordCreated`, which only the CSV carries. */
    const JSON_MEMBER_KEYS = MEMBER_KEYS.filter((key) => key !== 'PasswordCreated');
    const staff = { groupId: '', full: '', bare: '', nested: '' };

    /** The full person state people publishes for `userId`. */
    function personState(userId: string): PersonChangedPayload {
      return {
        userId, siteId: SITE, deleted: false, groupName: null, fname: 'Fay', lname: 'Full', email: 'fay@example.com', company: 'Co',
        jobTitle: 'Analyst', mobilePhone: '555-0100', website: 'https://fay.example.test', subType: 'Default', ext: 4, contactForm: 'cf',
        subscribe: 1, notes: 'n', description: 'd', interests: 'i', keepPrivate: 1, photoFileId: STORED_PHOTO, imName: 'im', imService: 'AIM',
        tags: 't', created: '2025-12-31 23:59:59.997', lastUpdate: '2026-06-30 12:00:00.120', lastUpdateBy: 'Ada Admin', lastUpdateById: ADMIN_USER,
      };
    }

    /** Staff: a fully projected user with credential and login state, a bare user with an unstored photo, and a member group sharing the stored photo. */
    beforeAll(async () => {
      if (handle === undefined) return;
      const { app: db } = handle;
      staff.full = nextId('E');
      staff.bare = nextId('E');
      await gated(SITE, async (tx) => {
        staff.groupId = (await repo.insertGroup(tx, groupInput('Staff', SITE, 0), null)).userid;
        staff.nested = (await repo.insertGroup(tx, groupInput('Nested', SITE, 0, { lname: 'Nest', jobtitle: 'Group Job', perm: 1, tablist: 'Basic', photofileid: STORED_PHOTO }), null)).userid;
        await repo.insertAccount(tx, { userid: staff.full, username: 'ufull', type: 2, s2: 0, perm: 1, inactive: 0, ispublic: 0, siteid: SITE, remoteid: 'R-1', tablist: 'Basic,Advanced' });
        await repo.writeCredential(tx, staff.full, { password: 'hash', passwordcreated: new Date(2026, 0, 2, 3, 4, 5, 670) });
        await repo.touchLastLogin(tx, staff.full, new Date(2026, 5, 29, 8, 0, 0, 3));
        await repo.insertAccount(tx, { userid: staff.bare, username: 'ubare', type: 2, s2: 0, perm: 0, inactive: 1, ispublic: 0, siteid: SITE, remoteid: '', tablist: '' });
        await repo.upsertPersonContact(tx, { user_id: staff.bare, site_id: SITE, email: null, fname: null, lname: 'Bare', company: null, subtype: null, aggregate_version: 1, photofileid: MISSING_PHOTO });
        for (const member of [staff.full, staff.bare, staff.nested]) await repo.addMembership(tx, member, staff.groupId);
      });
      const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', level: 'silent' });
      const envelope = testEnvelope({ topic: PERSON_CHANGED_TOPIC, tenantId: tenantIdForSite(SITE), aggregateId: staff.full, payload: personState(staff.full) });
      await consumeEnvelope(db, personContactConsumer(repo), envelope, { subscription: PERSON_CONTACT_SUBSCRIPTION, messageId: 'staff-1', logger });
    });

    it("answers every readGroupMemberships column: the projected person, identity's account rows, a member group's own row and the photo extension", async () => {
      content.lookups.length = 0;
      const res = await send('GET', `/v1/groups/${staff.groupId}/members`, await admin());

      expect(res.statusCode).toBe(200);
      const { items } = res.json<{ items: Record<string, unknown>[] }>();
      const [bare, full, nested] = items;
      for (const item of items) expect(Object.keys(item)).toEqual(JSON_MEMBER_KEYS);
      expect(full).toEqual({
        groupID: staff.full, userID: staff.full, GroupName: null, Fname: 'Fay', Lname: 'Full', UserName: 'ufull',
        Email: 'fay@example.com', Company: 'Co', JobTitle: 'Analyst', MobilePhone: '555-0100',
        Website: 'https://fay.example.test', Type: 2, subType: 'Default', ContactForm: 'cf', S2: 0, LastLogin: '2026-06-29T08:00:00.003',
        LastUpdate: '2026-06-30T12:00:00.120', LastUpdateBy: 'Ada Admin', LastUpdateByID: ADMIN_USER, Perm: 1, InActive: 0, IsPublic: 0,
        SiteID: SITE, Subscribe: 1, Notes: 'n', description: 'd', Interests: 'i', keepPrivate: 1, PhotoFileID: STORED_PHOTO, IMName: 'im',
        IMService: 'AIM', Created: '2025-12-31T23:59:59.997', RemoteID: 'R-1', Tags: 't', tablist: 'Basic,Advanced', photoFileExt: 'jpg',
      });
      expect(bare).toMatchObject({ userID: staff.bare, Lname: 'Bare', InActive: 1, LastLogin: null, JobTitle: null, PhotoFileID: MISSING_PHOTO, photoFileExt: null });
      expect(nested).toMatchObject({
        userID: staff.nested, Type: 1, GroupName: 'Nested', Lname: 'Nest', JobTitle: 'Group Job', Perm: 1, tablist: 'Basic', subType: 'Default',
        Subscribe: 1, LastUpdate: '2026-06-30T12:00:00.123', Created: '2026-06-30T12:00:00.123', PhotoFileID: STORED_PHOTO, photoFileExt: 'jpg',
      });
      expect(content.lookups).toEqual([[MISSING_PHOTO, STORED_PHOTO]]);
    });

    it('writes the timestamps of the members CSV as ACF renders them, and the photo extension', async () => {
      const res = await send('GET', `/v1/groups/${staff.groupId}/members.csv`, await admin());

      const full = res.body.split('\n').find((line) => line.includes('"ufull "')) ?? '';
      const cells = new Map(MEMBER_KEYS.map((key) => key.toUpperCase()).sort().map((column, i) => [column, full.split(/,(?=")|,(?=\d)/)[i]]));
      expect(Object.fromEntries(['CREATED', 'LASTLOGIN', 'LASTUPDATE', 'PASSWORDCREATED', 'PERM', 'PHOTOFILEEXT', 'REMOTEID', 'TABLIST', 'JOBTITLE'].map((column) => [column, cells.get(column)]))).toEqual({
        CREATED: '"2025-12-31 23:59:59.997 "',
        LASTLOGIN: '"2026-06-29 08:00:00.003 "',
        LASTUPDATE: '"2026-06-30 12:00:00.12 "',
        PASSWORDCREATED: '"2026-01-02 03:04:05.67 "',
        PERM: '1 ',
        PHOTOFILEEXT: '"jpg "',
        REMOTEID: '"R-1 "',
        TABLIST: '"Basic,Advanced "',
        JOBTITLE: '"Analyst "',
      });
    });

    it.each(['members', 'members.csv'])('answers GET %s with the legacy 503 when the photo lookup fails', async (path) => {
      content.status = 503;
      try {
        const res = await send('GET', `/v1/groups/${staff.groupId}/${path}`, await admin());
        expect(res.statusCode).toBe(503);
      } finally {
        content.status = 200;
      }
    });
  });
});
