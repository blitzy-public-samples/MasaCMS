/** The cUsers group routes over a throwaway `identity` schema: contract shape, the cUsers gate, `before()` defaults and scrubbing, CSRF contexts, S2-record protection, members, the members CSV and a user's memberships. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  assertResponseMatchesOpenApi,
  createCapturingPublisher,
  createThrowawaySchema,
  fixedClock,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { issueTokens, type CsrfDeps } from '../../src/domain/csrf.js';
import type { GroupDeps } from '../../src/domain/groups.js';
import { createIdentityEvents, identityPayloadValidators } from '../../src/events/publish.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
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
  await registerAdminGroupRoutes(app, { groups: groupsDeps(db), sessions: { db, repo, clock: CLOCK }, csrf });
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

    expect(stored.json()).toMatchObject({ isNew: false, group: { UserID: ids.editors, GroupName: 'Editors', Password: null, Type: 1, SiteID: SITE } });
    const fresh = unknown.json<{ isNew: boolean; group: { UserID: string; isPublic: number; subType: string } }>();
    expect(fresh).toMatchObject({ isNew: true, group: { isPublic: 1, subType: 'Default' } });
    expect(fresh.group.UserID).toHaveLength(35);
    expect(fresh.group.UserID).not.toBe(UNKNOWN_GROUP);
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
      blank, blank, blank, blank, blank, blank, blank, '0 ', '"tenant-a "', blank,
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
});
