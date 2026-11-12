/** The `cperm` main, module and updatemodule routes and the reverse lookup over a throwaway `identity` schema: contract shape, s2 and site-admin access, node verdicts, module grants, the posted `moduleid` as CSRF context and redirect key, and the token-site lookup. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
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
import { issueTokens, type CsrfDeps } from '../../src/domain/csrf.js';
import type { PermissionDeps } from '../../src/domain/permissions.js';
import { applyLogin } from '../../src/domain/sessions.js';
import type { BridgeRelay, LegacyUsedToken } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot } from '../../src/repo/tables.js';
import { registerAdminPermissionRoutes } from '../../src/routes/admin-permissions.js';

type Method = 'GET' | 'PUT';
type Payload = URLSearchParams | Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const CONTRACT_PATHS = ['/v1/permissions/content/{contentId}', '/v1/permissions/modules/{moduleId}', '/v1/permissions/reverse-lookup'];
const LOOKUP_URL = '/v1/permissions/reverse-lookup';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const SITE = 'tenant-a';
const UMBRELLA = 'umbrella';
const SECRET = 'K0000000-0000-0000-0000000000000001';
const ADMIN_USER = 'A0000000-0000-0000-0000000000000001';
const NODE = 'C0000000-0000-0000-0000000000000001';
const UNGRANTED_NODE = 'C0000000-0000-0000-0000000000000002';
const PLUGIN_MODULE = 'B0000000-0000-0000-0000000000000001';
const UNKNOWN_GROUP = 'D0000000-0000-0000-0000000000000001';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const HOME_CONTENT = '00000000000000000000000000000000001';
const USERS_MODULE = '00000000000000000000000000000000008';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: () => Promise.resolve(),
};

/** A relay that records each mark-used call. */
function recordingRelay(): BridgeRelay & { calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] } {
  const calls: { sessionId: string; tokens: readonly LegacyUsedToken[] }[] = [];
  return {
    calls,
    markUsed(sessionId, tokens) {
      calls.push({ sessionId, tokens });
      return Promise.resolve({ applied: true });
    },
  };
}

/** Permission events recorded by group and site. */
function recordingEvents(): PermissionDeps['events'] & { published: { groupId: string; siteId: string }[] } {
  const published: { groupId: string; siteId: string }[] = [];
  return {
    published,
    publishPermissionChanged(_tx, input) {
      published.push({ groupId: input.groupId, siteId: input.siteId });
      return Promise.resolve(null);
    },
  };
}

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let sessionSeq = 0;
const relay = recordingRelay();
const events = recordingEvents();
const groups = { editors: '', authors: '', siteAdmin: '', umbrellaStaff: '', members: '', umbrellaAdmin: '' };

function contentUrl(contentId: string, query = ''): string {
  return `/v1/permissions/content/${contentId}${query}`;
}

function moduleUrl(moduleId: string, query = ''): string {
  return `/v1/permissions/modules/${moduleId}${query}`;
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

function groupInput(groupname: string, siteid: string, ispublic: 0 | 1): GroupInput {
  return {
    groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
    website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic, siteid,
    subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
    remoteid: '', tags: '', tablist: '',
  };
}

/** Seeds the site's private-pool groups, the umbrella pool's groups and the node grants `cperm.main` reads. */
async function seed(db: TenantDb, schema: string): Promise<void> {
  await registerSite(db, schema, SITE, SITE, UMBRELLA);
  await registerSite(db, schema, UMBRELLA, UMBRELLA, UMBRELLA);
  await gated(SITE, async (tx) => {
    groups.editors = (await repo.insertGroup(tx, groupInput('Editors', SITE, 0), null)).userid;
    groups.siteAdmin = (await repo.insertGroup(tx, groupInput('Admin', SITE, 0), null)).userid;
    groups.authors = (await repo.insertGroup(tx, groupInput('authors', SITE, 0), null)).userid;
  });
  await gated(UMBRELLA, async (tx) => {
    groups.members = (await repo.insertGroup(tx, groupInput('Members', UMBRELLA, 1), null)).userid;
    groups.umbrellaAdmin = (await repo.insertGroup(tx, groupInput('Admin', UMBRELLA, 1), null)).userid;
    groups.umbrellaStaff = (await repo.insertGroup(tx, groupInput('Umbrella Staff', UMBRELLA, 0), null)).userid;
  });
  await gated(SITE, (tx) =>
    repo.replaceNodePermissions(tx, {
      contentId: NODE,
      siteId: SITE,
      grants: [
        { groupId: groups.editors, type: 'Read' },
        { groupId: groups.editors, type: 'Editor' },
        { groupId: groups.members, type: 'Deny' },
        { groupId: groups.umbrellaStaff, type: 'Author' },
      ],
    }),
  );
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-admin-permissions-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
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
  const csrf: CsrfDeps = { db, repo, bridge: relay, clock: CLOCK, sleep: () => Promise.resolve() };
  await registerAdminPermissionRoutes(app, { permissions: { db, repo, events }, reverseLookup: { db, repo }, csrf });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  relay.calls.length = 0;
  events.published.length = 0;
});

/** Headers of a gateway-relayed call for a `site` user holding `roles` in session `sid`; null `roles` sends no user token, null `caller` no invocation credential. */
async function headersFor(roles: readonly string[] | null, sid?: string, caller: string | null = 'gateway', site = SITE): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (roles !== null) headers.authorization = `Bearer ${await mintUserToken({ sub: ADMIN_USER, sid, site, roles })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  return headers;
}

/** Injects a request, form fields as a form post and an object as JSON, and checks the answer against the contract. */
async function send(method: Method, url: string, headers: Record<string, string>, payload?: Payload) {
  const form = payload instanceof URLSearchParams;
  const res = await app.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, ...(form ? FORM_BODY : JSON_BODY) },
    payload: payload === undefined ? undefined : form ? payload.toString() : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

const DECLARED_ROUTES: [Method, string, Payload | undefined][] = [
  ['GET', contentUrl(NODE), undefined],
  ['GET', moduleUrl(USERS_MODULE), undefined],
  ['PUT', moduleUrl(USERS_MODULE), new URLSearchParams({ moduleid: USERS_MODULE })],
];

describe('route declarations', () => {
  it('match the four contract operations, the reverse lookup public, with no route for cperm.update', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/permissions'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{contentId}', ':contentId').replace('{moduleId}', ':moduleId'),
          transport: operation['x-opt2-transport'],
          ...(operation['x-opt2-public'] === true ? { public: true } : { requires: operation['x-opt2-requires'] }),
        })),
    );
    expect(Object.keys(OPENAPI.paths).filter((template) => template.startsWith('/v1/permissions'))).toEqual(CONTRACT_PATHS);
    expect(expected).toHaveLength(4);
    expect(declared).toHaveLength(4);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry): unknown => expect.objectContaining(entry))));
    expect(declared.find((route) => route.url === LOOKUP_URL)).toMatchObject({ method: 'GET', public: true, siteCheck: true });
  });
});

describe('auth denials', () => {
  it.each(DECLARED_ROUTES)('refuse %s %s to users holding neither s2 nor site-admin', async (method, url, payload) => {
    for (const roles of [[Roles.systemUser], [Roles.member], [Roles.systemUser, 'm:008'], []]) {
      const res = await send(method, url, await headersFor(roles), payload);

      expect(res.statusCode).toBe(403);
    }
    expect(events.published).toEqual([]);
  });

  it.each(DECLARED_ROUTES)('answer %s %s without a user token or without an invocation credential with 401', async (method, url, payload) => {
    const noUser = await send(method, url, await headersFor(null), payload);
    const noInvocation = await send(method, url, await headersFor([Roles.s2], undefined, null), payload);

    expect([noUser.statusCode, noInvocation.statusCode]).toEqual([401, 401]);
    expect(noUser.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each<[Method, string, Payload | undefined]>([...DECLARED_ROUTES, ['GET', LOOKUP_URL, undefined]])('refuse %s %s for a siteid other than the token site', async (method, url, payload) => {
    const res = await send(method, `${url}?siteid=tenant-b`, await headersFor([Roles.s2]), payload);

    expect(res.statusCode).toBe(403);
  });

  it.each(DECLARED_ROUTES)('answer %s %s for a service credential holding s2 without a user token as a missing credential', async (method, url, payload) => {
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity', roles: [Roles.s2] })}` };

    const res = await send(method, url, headers, payload);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each<[string, () => Promise<Record<string, string>>]>([
    ['without a user token', () => headersFor(null)],
    ['without an invocation credential', () => headersFor([Roles.s2], undefined, null)],
    ['for a service credential holding s2 without a user token', async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity', roles: [Roles.s2] })}` })],
  ])('answer the public reverse lookup %s with 401 as a missing credential', async (_label, headers) => {
    const res = await send('GET', LOOKUP_URL, await headers());

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

describe('updatemodule redirects', () => {
  it.each<[string, string, Record<string, string>]>([
    ['00000000000000000000000000000000004', 'cUsers.list', {}],
    ['00000000000000000000000000000000005', 'cEmail.list', {}],
    ['00000000000000000000000000000000007', 'cForm.list', {}],
    [USERS_MODULE, 'cUsers.list', {}],
    ['00000000000000000000000000000000009', 'cMailingList.list', {}],
    [SITE_MANAGER_MODULE, 'cArch.list', { topid: HOME_CONTENT, moduleid: SITE_MANAGER_MODULE }],
    ['00000000000000000000000000000000010', 'cCategory.list', {}],
    ['00000000000000000000000000000000011', 'cFeed.list', {}],
    ['00000000000000000000000000000000014', 'cChangesets.list', {}],
    ['00000000000000000000000000000000015', 'cComments.default', {}],
    ['00000000000000000000000000000000016', 'cArch.list', { activeTab: '2' }],
    [PLUGIN_MODULE, 'cPlugins.list', {}],
  ])('send posted moduleid %s to %s, writing nothing without a CSRF token', async (moduleid, action, extra) => {
    const res = await send('PUT', moduleUrl(moduleid), await headersFor([Roles.s2]), new URLSearchParams({ moduleid, groupid: UNKNOWN_GROUP }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ written: false, redirect: { action, params: { siteid: SITE, ...extra } } });
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(events.published).toEqual([]);
  });

  it('compare the posted moduleid as CFML == does, numerically when both sides are numeric, and append siteid as the request spells it', async () => {
    const headers = await headersFor([Roles.siteAdmin, Roles.systemUser]);

    const users = await send('PUT', moduleUrl(USERS_MODULE, '?siteid=TENANT-A'), headers, new URLSearchParams({ moduleid: '8' }));
    const siteManager = await send('PUT', moduleUrl(USERS_MODULE), headers, new URLSearchParams({ moduleid: '0' }));

    expect(users.json()).toEqual({ written: false, redirect: { action: 'cUsers.list', params: { siteid: 'TENANT-A' } } });
    expect(siteManager.json()).toEqual({
      written: false,
      redirect: { action: 'cArch.list', params: { siteid: SITE, topid: HOME_CONTENT, moduleid: SITE_MANAGER_MODULE } },
    });
  });

  it('take the path id as moduleid when the form posts none', async () => {
    const res = await send('PUT', moduleUrl('00000000000000000000000000000000005'), await headersFor([Roles.s2]), new URLSearchParams({ groupid: UNKNOWN_GROUP }));

    expect(res.json()).toEqual({ written: false, redirect: { action: 'cEmail.list', params: { siteid: SITE } } });
  });
});

describe.skipIf(!available)('cperm screens against PostgreSQL', () => {
  /** Inserts an active session of the admin user under the test secret and returns its id. */
  async function newSession(): Promise<string> {
    sessionSeq += 1;
    const sessionId = `S-perm-${sessionSeq}`;
    await gated(SITE, (tx) =>
      repo.insertSession(tx, { session_id: sessionId, csrf_secret: SECRET, mode: 'target-primary', state: 'active', user_id: ADMIN_USER, site_id: SITE }),
    );
    return sessionId;
  }

  /** A CSRF token and expiry for `context` under the test secret, issued `minutesAgo` before the fixed clock; one context and time give one token. */
  function tokenFor(context: string, minutesAgo = 0): { token: string; expires: string } {
    return issueTokens({ csrfSecret: SECRET }, { context, clock: fixedClock(NOW.getTime() - minutesAgo * 60_000) });
  }

  /** The CSRF form fields of a token for `context`. */
  function csrfFields(context: string): Record<string, string> {
    const { token, expires } = tokenFor(context);
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  /** The module's grants as `cperm.module` answers them, as `groupName: granted` pairs. */
  async function moduleGrants(moduleId: string): Promise<Record<string, boolean>[]> {
    const res = await send('GET', moduleUrl(moduleId), await headersFor([Roles.s2]));
    expect(res.statusCode).toBe(200);
    const body = res.json<{ privateGroups: { groupName: string; granted: boolean }[]; publicGroups: { groupName: string; granted: boolean }[] }>();
    return [body.privateGroups, body.publicGroups].map((list) => Object.fromEntries(list.map((group) => [group.groupName, group.granted])));
  }

  it("answer cperm.main with each system group but Admin, then each member group, by name with the node verdict in legacy precedence", async () => {
    const res = await send('GET', contentUrl(NODE), await headersFor([Roles.s2]));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      contentId: NODE,
      siteId: SITE,
      groups: [
        { groupId: groups.authors, groupName: 'authors', perm: 'none' },
        { groupId: groups.editors, groupName: 'Editors', perm: 'editor' },
      ],
      publicGroups: [
        { groupId: groups.umbrellaAdmin, groupName: 'Admin', perm: 'none' },
        { groupId: groups.members, groupName: 'Members', perm: 'deny' },
      ],
    });
  });

  it('answer cperm.main to a site-admin for a node without grants with every verdict none and siteId as the request spells it', async () => {
    const res = await send('GET', contentUrl(UNGRANTED_NODE, '?siteid=TENANT-A'), await headersFor([Roles.siteAdmin, Roles.systemUser]));

    expect(res.statusCode).toBe(200);
    const body = res.json<{ siteId: string; groups: { perm: string }[]; publicGroups: { perm: string }[] }>();
    expect(body.siteId).toBe('TENANT-A');
    expect([...body.groups, ...body.publicGroups].map((group) => group.perm)).toEqual(['none', 'none', 'none', 'none']);
  });

  it('answer cperm.module with module grants matched to groups ignoring id case, and no grant from node rows', async () => {
    const moduleId = '00000000000000000000000000000000007';
    await gated(SITE, (tx) => repo.replaceModulePermissions(tx, { moduleId, siteId: SITE, groupIds: [groups.editors.toLowerCase(), groups.members] }));

    const res = await send('GET', moduleUrl(moduleId, `?siteid=${SITE}`), await headersFor([Roles.siteAdmin, Roles.systemUser]));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      moduleId,
      siteId: SITE,
      privateGroups: [
        { groupId: groups.authors, groupName: 'authors', granted: false },
        { groupId: groups.editors, groupName: 'Editors', granted: true },
      ],
      publicGroups: [
        { groupId: groups.umbrellaAdmin, groupName: 'Admin', granted: false },
        { groupId: groups.members, groupName: 'Members', granted: true },
      ],
    });
    expect(await moduleGrants(NODE)).toEqual([
      { authors: false, Editors: false },
      { Admin: false, Members: false },
    ]);
  });

  it('save a form post with a valid token once, replacing the grants, and leave them on a missing or reused token', async () => {
    const moduleId = '00000000000000000000000000000000010';
    const sessionId = await newSession();
    const headers = await headersFor([Roles.s2], sessionId);
    const redirect = { action: 'cCategory.list', params: { siteid: SITE } };
    const form = (fields: Record<string, string>) =>
      new URLSearchParams([['groupid', groups.authors], ['groupid', groups.members], ['moduleid', moduleId], ...Object.entries(fields)]);

    const missing = await send('PUT', moduleUrl(moduleId), headers, form({}));
    expect(missing.json()).toEqual({ written: false, redirect });
    expect(await moduleGrants(moduleId)).toEqual([
      { authors: false, Editors: false },
      { Admin: false, Members: false },
    ]);

    const issued = tokenFor(moduleId);
    const fields = { [CSRF_FIELD_TOKEN]: issued.token, [CSRF_FIELD_EXPIRES]: issued.expires };
    const saved = await send('PUT', moduleUrl(moduleId), headers, form(fields));
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ written: true, redirect });
    expect(saved.headers['x-opt2-write-position']).toMatch(/^identity=/);
    expect(events.published).toHaveLength(2);
    expect(events.published).toEqual(
      expect.arrayContaining([
        { groupId: groups.authors, siteId: SITE },
        { groupId: groups.members, siteId: SITE },
      ]),
    );
    expect(relay.calls).toEqual([{ sessionId, tokens: [{ token: issued.token, usedAt: NOW }] }]);
    expect(await moduleGrants(moduleId)).toEqual([
      { authors: true, Editors: false },
      { Admin: false, Members: true },
    ]);

    events.published.length = 0;
    const reused = await send('PUT', moduleUrl(moduleId), headers, new URLSearchParams({ moduleid: moduleId, ...fields }));
    expect(reused.json()).toEqual({ written: false, redirect });
    expect(events.published).toEqual([]);
    expect((await moduleGrants(moduleId))[0]).toEqual({ authors: true, Editors: false });
  });

  it('save a JSON body with a groupid array and the token in headers, and clear every grant when no groupid is posted', async () => {
    const moduleId = '00000000000000000000000000000000011';
    const sessionId = await newSession();
    const headers = await headersFor([Roles.siteAdmin, Roles.systemUser], sessionId);
    const tokenHeaders = (minutesAgo: number): Record<string, string> => {
      const { token, expires } = tokenFor(moduleId, minutesAgo);
      return { [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: expires };
    };

    const saved = await send('PUT', moduleUrl(moduleId), { ...headers, ...tokenHeaders(0) }, { groupid: [groups.editors, groups.members], moduleid: moduleId });
    expect(saved.json()).toEqual({ written: true, redirect: { action: 'cFeed.list', params: { siteid: SITE } } });
    expect(await moduleGrants(moduleId)).toEqual([
      { authors: false, Editors: true },
      { Admin: false, Members: true },
    ]);

    const cleared = await send('PUT', moduleUrl(moduleId), { ...headers, ...tokenHeaders(1) }, { moduleid: moduleId });
    expect(cleared.json()).toMatchObject({ written: true });
    expect(await moduleGrants(moduleId)).toEqual([
      { authors: false, Editors: false },
      { Admin: false, Members: false },
    ]);
  });

  it('validate the token against the posted moduleid and write the grants under the path id', async () => {
    const pathModule = '00000000000000000000000000000000014';
    const sessionId = await newSession();
    const headers = await headersFor([Roles.s2], sessionId);
    const redirect = { action: 'cArch.list', params: { siteid: SITE, topid: HOME_CONTENT, moduleid: SITE_MANAGER_MODULE } };
    const form = (context: string) => new URLSearchParams({ groupid: groups.authors, moduleid: SITE_MANAGER_MODULE, ...csrfFields(context) });

    const pathContext = await send('PUT', moduleUrl(pathModule), headers, form(pathModule));
    expect(pathContext.json()).toEqual({ written: false, redirect });
    expect((await moduleGrants(pathModule))[0]).toEqual({ authors: false, Editors: false });

    const postedContext = await send('PUT', moduleUrl(pathModule), headers, form(SITE_MANAGER_MODULE));
    expect(postedContext.json()).toEqual({ written: true, redirect });
    expect((await moduleGrants(pathModule))[0]).toEqual({ authors: true, Editors: false });
    expect((await moduleGrants(SITE_MANAGER_MODULE))[0]).toEqual({ authors: false, Editors: false });
  });

  // tenant-a pools its public users in umbrella, so umbrella's lookup reaches tenant-a's Admin group; the token carries no roles.
  it.each<{ when: string; roleList: string | null; site: string; granted: boolean }>([
    { when: "a member of the site's private-pool Admin group", roleList: 'Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate', site: SITE, granted: true },
    { when: "a member of a public-pool member site's Admin group", roleList: 'Admin;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate', site: UMBRELLA, granted: true },
    { when: 'a private-pool user without Users access', roleList: 'Editors;tenant-a;0,S2IsPrivate;tenant-a,S2IsPrivate', site: UMBRELLA, granted: false },
    { when: 'a session without a login', roleList: null, site: SITE, granted: false },
  ])('answer the reverse lookup of the token site for $when with granted $granted', async ({ roleList, site, granted }) => {
    sessionSeq += 1;
    const sessionId = `S-reverse-${String(sessionSeq)}`;
    if (roleList !== null) {
      const snapshot: LoginSnapshot = {
        userid: ADMIN_USER, username: 'site_admin', siteid: SITE, subtype: 'Default', password: 'stored-hash', fname: '', lname: '', email: '',
        remoteid: '', company: '', lastlogin: null, passwordcreated: null, roleList, membershipIds: ADMIN_USER,
      };
      await applyLogin({ db: handle?.app ?? NO_DB, repo, clock: CLOCK }, { sessionId, tenantId: tenantIdForSite(SITE), snapshot, mode: 'target-primary', siteId: SITE });
    }

    const res = await send('GET', LOOKUP_URL, await headersFor([], sessionId, 'web', site));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ granted });
  });
});
