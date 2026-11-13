/** The `mintUserToken`, `authenticateRequest` and `getJwks` routes: contract shape, gateway-only access, body validation, the REST outcome mapping and tokens verified against the served key set. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  INVOCATION_HEADER,
  LOCAL_USER_TOKEN,
  Roles,
  collectRouteMatrix,
  createUserTokenVerifier,
  userClaimsSchema,
} from '@opt2/platform/auth';
import { LegacyServiceUnavailableError, WWW_AUTHENTICATE } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, fixedClock, loadEnv, systemClock, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import {
  ROLE_SET,
  assertResponseMatchesOpenApi,
  authHeadersFor,
  createThrowawaySchema,
  mintServiceToken,
  mintUserToken,
  pgAvailable,
  subjectSiteFor,
  testVerifier,
  writeTestSecrets,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { DEFAULT_LOGIN_SETTINGS, type LoginSettings } from '../../src/domain/login.js';
import { applyLogin } from '../../src/domain/sessions.js';
import { createTokenService } from '../../src/domain/tokens.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot } from '../../src/repo/tables.js';
import { registerTokenRoutes } from '../../src/routes/internal-tokens.js';
import { createRecordingDb } from '../helpers/memory-repo.js';

type Method = 'GET' | 'POST';
type ContractOperation = Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, ContractOperation>>;
};
const TOKENS = '/internal/v1/tokens';
const AUTHENTICATE = '/internal/v1/authenticate';
const JWKS = '/.well-known/jwks.json';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const SITE = 'tenant-a';
/** A site legacy holds and identity's registry does not, so no REST event of it builds a content renderer. */
const GHOST = 'ghost';
const PASSWORD = 'Secret12';
const USER = 'A0000000-0000-0000-0000000000000001';
const S2_USER = 'A0000000-0000-0000-0000000000000002';
const CLIENT = 'C0000000-0000-0000-0000000000000001';
const CLIENT_SECRET = 'cc-secret';
/** A stored `client_credentials` access token of {@link CLIENT}, acting for {@link USER}. */
const ACCESS_TOKEN = 'T-QUERY';
const REST_PATH = `/_api/rest/v1/${GHOST}/content`;
const TOKEN_PATH = `/_api/rest/v1/${GHOST}/oauth2/token`;
const JSON_BODY = { 'content-type': 'application/json' };
const FAST_SETTINGS: LoginSettings = { password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 }, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const S2_SNAPSHOT: LoginSnapshot = {
  userid: S2_USER,
  username: 'admin',
  siteid: 'default',
  subtype: 'Default',
  password: '',
  fname: 'Ada',
  lname: 'Admin',
  email: 'ada@example.test',
  remoteid: '',
  company: '',
  lastlogin: null,
  passwordcreated: null,
  roleList: 'S2IsPrivate;default,S2IsPrivate,S2,admin;username;default',
  membershipIds: S2_USER,
};

/** The domain `tenant-a` is registered on, whose origins legacy echoes. */
const ORIGIN_DOMAIN = 'localhost';
const ADMIN_DOMAIN = 'admin.example';

/** Registry rows of the in-memory database: `tenant-a` on {@link ORIGIN_DOMAIN}, `default` on no domain. */
const REGISTRY_ROWS = [
  { site_id: 'default', domains: [] as string[] },
  { site_id: SITE, domains: [ORIGIN_DOMAIN] },
].map(({ site_id, domains }) => ({
  site_id,
  tenant_id: tenantIdForSite(site_id),
  public_user_pool_id: site_id,
  private_user_pool_id: site_id,
  category_pool_id: site_id,
  file_pool_id: site_id,
  display_pool_id: site_id,
  content_pool_ids: [site_id],
  public_user_pool_tenant: tenantIdForSite(site_id),
  private_user_pool_tenant: tenantIdForSite(site_id),
  category_pool_tenant: tenantIdForSite(site_id),
  file_pool_tenant: tenantIdForSite(site_id),
  display_pool_tenant: tenantIdForSite(site_id),
  content_pool_tenants: [tenantIdForSite(site_id)],
  domains,
  aggregate_version: 1,
  updated_at: NOW,
}));

/** The single statement that reads every registry entry. */
const REGISTRY_ENTRIES = /^SELECT site_id, tenant_id, .+ FROM identity\.tenant_registry ORDER BY site_id$/;

/** A registry-only store: the site registry answers, every other read finds nothing. */
const REGISTRY_DB = createRecordingDb({ responses: [[REGISTRY_ENTRIES, () => REGISTRY_ROWS]] });

/** Legacy's echo of an allowed `origin`. */
function echoOf(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' };
}

/** A store whose every transaction is unavailable, for the cases that need no database or test its 503. */
const UNAVAILABLE_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new LegacyServiceUnavailableError()),
  withMetadata: () => Promise.reject(new LegacyServiceUnavailableError()),
  end: async () => undefined,
};

const available = await pgAvailable();

let stateDir: string;
let offline: FastifyInstance;
let registered: FastifyInstance;
let online: FastifyInstance | undefined;
let handle: ThrowawaySchema | undefined;

/** An identity app with only the token routes, over `db` and `repo`; `adminDomain` defaults to the environment's. */
async function buildApp(db: TenantDb, repo: IdentityRepository, adminDomain?: string): Promise<FastifyInstance> {
  const app = await createService({
    name: 'identity',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
      OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier('identity'),
    logger: createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  // Minted tokens are verified against the current time, so the token clock is live while the stores keep the fixed one.
  const tokens = createTokenService({
    env: { OPT2_ENV: 'local', OPT2_STATE_DIR: stateDir, GOOGLE_CLOUD_PROJECT: undefined },
    clock: systemClock,
    db,
    repo,
  });
  const deps = { db, repo, clock: CLOCK };
  const rest = { oauth: deps, login: { ...deps, settings: FAST_SETTINGS }, sessions: deps };
  await registerTokenRoutes(app, { tokens, rest, ...(adminDomain === undefined ? {} : { legacy: { adminDomain } }) });
  await app.ready();
  return app;
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-internal-tokens-routes-'));
  await writeTestSecrets(stateDir);
  offline = await buildApp(UNAVAILABLE_DB, createIdentityRepository({ clock: CLOCK }));
  registered = await buildApp(REGISTRY_DB, createIdentityRepository({ clock: CLOCK }), ADMIN_DOMAIN);
  if (!available) return;
  handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
  const { schema } = handle;
  const db = handle.app;
  const repo = createIdentityRepository({ clock: CLOCK, schema });
  await ensureUnitGates(db, IDENTITY_UNITS);
  await withMetadata(db, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
  for (const site of ['default', SITE]) {
    await withMetadata(db, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at, domains) VALUES ($1, $2, $1, $1, $2, $2, 1, $3, $4)',
        [site, tenantIdForSite(site), NOW, site === SITE ? [ORIGIN_DOMAIN] : null],
      ),
    );
  }
  const stored = await bcrypt.hash(PASSWORD, (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
  await withGatedTenant(db, tenantIdForSite('default'), async (tx) => {
    await repo.insertAccount(tx, { userid: USER, username: 'ghost-user', type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: GHOST, remoteid: '', tablist: '' });
    await repo.writeCredential(tx, USER, { password: stored, passwordcreated: new Date(2026, 5, 1, 9, 15, 0) });
    await repo.upsertPersonContact(tx, { user_id: USER, site_id: GHOST, subtype: 'Default', aggregate_version: 1, fname: 'Ghost', lname: 'User', email: 'ghost@example.test', company: '' });
    await repo.insertOAuthClient(tx, {
      clientid: CLIENT, clientsecret: CLIENT_SECRET, siteid: 'default', granttype: 'client_credentials', userid: USER, name: 'cc', created: NOW,
      lastupdate: NOW, description: null, redirecturl: null, lastupdatebidy: null, lastupdateby: null,
    });
    await repo.insertToken(tx, {
      token: ACCESS_TOKEN, granttype: 'client_credentials', clientid: CLIENT, userid: USER, accesscode: null, data: null,
      expires: new Date(NOW.getTime() + 3_600_000),
    });
  });
  await applyLogin({ db, repo, clock: CLOCK }, { sessionId: 'S-S2', snapshot: S2_SNAPSHOT, mode: 'target-primary', siteId: 'default' });
  online = await buildApp(db, repo, '');
});

afterAll(async () => {
  await online?.opt2.shutdown();
  await registered?.opt2.shutdown();
  await offline?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

/** Headers of a `caller` service call, with a user token as well when `withUser` is set. */
async function headersFor(caller: string | null, withUser = false): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (withUser) headers.authorization = `Bearer ${await mintUserToken({ sub: S2_USER, site: SITE, roles: [Roles.systemUser] })}`;
  if (caller !== null) headers[INVOCATION_HEADER] = `Bearer ${await mintServiceToken({ caller, audience: 'identity' })}`;
  return headers;
}

/** Injects a request into `app` and checks the answer against the contract. */
async function send(app: FastifyInstance, method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: method === 'POST' ? { ...headers, ...JSON_BODY } : headers,
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** An `AuthenticateRequest` of a REST request on `path`. */
function restRequest(requestPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { method: 'GET', path: requestPath, siteId: GHOST, headers: {}, query: {}, ...extra };
}

function basic(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/** Asserts that a legacy answer's headers open with exactly `echo` and carry no other CORS header. */
function expectEcho(headers: Record<string, string>, echo: Record<string, string>): void {
  const cors = Object.entries(headers).filter(([name]) => name.startsWith('Access-Control-'));
  expect(cors).toEqual(Object.entries(echo));
  expect(Object.entries(headers).slice(0, cors.length)).toEqual(cors);
}

describe('route declarations', () => {
  it('match the contract operations', () => {
    const declared = collectRouteMatrix(offline).routes.filter((route) => [TOKENS, AUTHENTICATE, JWKS].includes(route.url) && route.method !== 'HEAD');
    const expected = [TOKENS, AUTHENTICATE, JWKS].flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {}).map(([method, operation]) => ({
        method: method.toUpperCase(),
        url: template,
        transport: operation['x-opt2-transport'],
        ...(operation['x-opt2-public'] === true ? { public: true } : { requires: operation['x-opt2-requires'] }),
      })),
    );
    expect(expected).toHaveLength(3);
    expect(declared).toHaveLength(3);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))));
  });
});

describe('access', () => {
  it.each(ROLE_SET.map((subject) => [subject.name, subject] as const))('admits %s to the internal routes only with the gateway credential', async (_name, subject) => {
    const headers = await authHeadersFor(subject, { audience: 'identity' });
    // Every user subject arrives through the gateway; its token must then name the site the body asks for.
    const admitted = (subject.kind === 'user' && subjectSiteFor(subject) === SITE) || subject.caller === 'gateway';
    for (const [url, payload] of [
      [TOKENS, { sessionId: 'S-UNKNOWN', siteId: SITE }],
      [AUTHENTICATE, { ...restRequest(REST_PATH), siteId: SITE }],
    ] as const) {
      const res = await send(offline, 'POST', url, headers, payload);
      expect([401, 403].includes(res.statusCode), `${url} answered ${String(res.statusCode)}`).toBe(!admitted);
    }
  });

  it('refuses callers other than the gateway with 403 and a missing credential with the legacy 401', async () => {
    for (const caller of ['people', 'identity', 'web', 'migration', 'reporting']) {
      expect((await send(offline, 'POST', TOKENS, await headersFor(caller), { sessionId: 'S1', siteId: SITE })).statusCode).toBe(403);
    }
    expect((await send(offline, 'POST', AUTHENTICATE, await headersFor('reporting'), restRequest(REST_PATH))).statusCode).toBe(403);
    const anonymous = await send(offline, 'POST', AUTHENTICATE, {}, restRequest(REST_PATH));
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request' } });
  });

  it.each<[string, string | null, boolean]>([
    ['anonymously', null, false],
    ['to the gateway', 'gateway', false],
    ['to another service presenting a user token', 'people', true],
  ])('publishes the local key set %s', async (_label, caller, withUser) => {
    const res = await send(offline, 'GET', JWKS, await headersFor(caller, withUser));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const jwks = res.json() as JSONWebKeySet;
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
  });
});

describe('request validation', () => {
  it.each<[string, string, unknown]>([
    ['a token request without siteId', TOKENS, { sessionId: 'S1' }],
    ['a token request with an empty sessionId', TOKENS, { sessionId: '', siteId: SITE }],
    ['a token request with an empty siteId', TOKENS, { sessionId: 'S1', siteId: '' }],
    ['an authenticate request without headers', AUTHENTICATE, { method: 'GET', path: REST_PATH, query: {} }],
    ['an authenticate request with a structured header', AUTHENTICATE, restRequest(REST_PATH, { headers: { authorization: { scheme: 'Basic' } } })],
  ])('answers %s with the legacy 400', async (_label, url, payload) => {
    const res = await send(offline, 'POST', url, await headersFor('gateway'), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: 'Invalid parameters' } });
  });
});

describe('without a database', () => {
  it('answers a REST request without credentials as denied, carrying legacy 401 and its WWW-Authenticate', async () => {
    const res = await send(offline, 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: string; sessionId: null; legacyResponse: { status: number; headers: Record<string, string>; body: string } };
    expect(body).toMatchObject({ outcome: 'denied', sessionId: null, legacyResponse: { status: 401 } });
    expect(body.legacyResponse.headers['WWW-Authenticate']).toBe(WWW_AUTHENTICATE.basic);
    expect(JSON.parse(body.legacyResponse.body)).toMatchObject({ error: { message: 'Insufficient Account Permissions' } });
  });

  it.each<[string, Record<string, unknown>]>([
    ['the query', { query: { access_token: 'T' } }],
    ['the form', { form: { client_id: CLIENT } }],
    ['a struct body', { body: { client_id: CLIENT } }],
    ['a repeated header', { headers: { 'x-access-token': ['T'] } }],
  ])('reads a credential from %s, whose lookup in an unavailable store answers the legacy 503', async (_label, extra) => {
    const res = await send(offline, 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, extra));

    expect(res.statusCode).toBe(503);
  });

  it('answers a token request over an unavailable store with the legacy 503', async () => {
    expect((await send(offline, 'POST', TOKENS, await headersFor('gateway'), { sessionId: 'S1', siteId: SITE })).statusCode).toBe(503);
  });

  it('answers the legacy 503 when the registry an Origin echo reads is unavailable', async () => {
    const res = await send(offline, 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, { headers: { origin: 'http://localhost' } }));

    expect(res.statusCode).toBe(503);
  });
});

describe('the Origin echo of a legacy answer', () => {
  const registryReads = (): string[] =>
    REGISTRY_DB.statements()
      .filter((statement) => statement.sql.includes('tenant_registry'))
      .map((statement) => statement.sql);

  it.each<[string, Record<string, string | string[]>, Record<string, string>]>([
    ['an Origin on a registered domain', { origin: 'http://localhost' }, echoOf('http://localhost')],
    ['an Origin on its subdomain, under another header case', { Origin: 'https://www.localhost:8443' }, echoOf('https://www.localhost:8443')],
    ['a repeated Origin field', { origin: ['http://localhost'] }, echoOf('http://localhost')],
    ['an Origin on the admin domain the client host names', { origin: 'http://admin.example', host: 'admin.example:8080' }, echoOf('http://admin.example')],
    ['an Origin on the admin domain another client host misses', { origin: 'http://admin.example', host: 'www.example.test' }, {}],
    ['an Origin off every registered domain', { origin: 'http://localhost.evil.example' }, {}],
    ['no Origin', {}, {}],
  ])('opens the headers of a denied answer to %s', async (_label, headers, echo) => {
    const before = registryReads().length;

    const res = await send(registered, 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, { headers }));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { outcome: string; legacyResponse: { status: number; headers: Record<string, string> } };
    expect(body).toMatchObject({ outcome: 'denied', sessionId: null, legacyResponse: { status: 401 } });
    expect(body.legacyResponse.headers['WWW-Authenticate']).toBe(WWW_AUTHENTICATE.basic);
    expectEcho(body.legacyResponse.headers, echo);
    // Only a request with an Origin reads the registry, in one statement.
    const hasOrigin = Object.keys(headers).some((name) => name.toLowerCase() === 'origin');
    expect(registryReads().slice(before)).toEqual(hasOrigin ? [expect.stringMatching(REGISTRY_ENTRIES)] : []);
  });
});

describe.skipIf(!available)('against PostgreSQL', () => {
  function app(): FastifyInstance {
    if (online === undefined) throw new Error('PostgreSQL is not available');
    return online;
  }

  /** The token of a gateway mint for `sessionId` on `siteId`, verified against the served key set. */
  async function mintVerified(sessionId: string, siteId: string) {
    const res = await send(app(), 'POST', TOKENS, await headersFor('gateway'), { sessionId, siteId });
    expect(res.statusCode).toBe(200);
    const minted = res.json() as { token: string; expiresAt: number; epoch: number; claims: Record<string, unknown> };
    const keySet = createLocalJWKSet((await send(app(), 'GET', JWKS, {})).json() as JSONWebKeySet);
    const verified = await createUserTokenVerifier({ issuer: LOCAL_USER_TOKEN.issuer, audience: LOCAL_USER_TOKEN.audience, keySet }).verify(minted.token);
    expect(verified).toEqual(minted.claims);
    expect(userClaimsSchema.parse(minted.claims)).toEqual(minted.claims);
    expect(minted.expiresAt).toBe(minted.claims.exp);
    return minted;
  }

  it('mints a site-scoped token from the session login snapshot, ignoring claims the body names', async () => {
    const res = await send(app(), 'POST', TOKENS, await headersFor('gateway'), { sessionId: 'S-S2', siteId: SITE, roles: ['s2'], sub: USER });
    const minted = await mintVerified('S-S2', SITE);

    expect(res.json()).toMatchObject({ claims: { sub: S2_USER } });
    expect(minted).toMatchObject({ epoch: 1, claims: { sub: S2_USER, sid: 'S-S2', site: SITE, tid: tenantIdForSite(SITE), roles: ['s2'], s2: true, epoch: 1 } });
  });

  it('refuses reporting a token of a live session with 403, minting nothing', async () => {
    const res = await send(app(), 'POST', TOKENS, await headersFor('reporting'), { sessionId: 'S-S2', siteId: SITE });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(res.json()).not.toHaveProperty('token');
  });

  it.each<[string, string, string, Record<string, unknown>]>([
    ['an unknown site', 'S-S2', 'nowhere', { sub: S2_USER, roles: [], s2: false, tid: tenantIdForSite('nowhere') }],
    ['an unknown session', 'S-UNKNOWN', SITE, { sub: '', roles: [], s2: false, epoch: 0 }],
  ])('mints a token without roles for %s', async (_label, sessionId, siteId, claims) => {
    expect((await mintVerified(sessionId, siteId)).claims).toMatchObject({ sid: sessionId, site: siteId, ...claims });
  });

  it.each<[string, string | string[]]>([
    ['a header', basic('ghost-user', PASSWORD)],
    ['a repeated header', [basic('ghost-user', PASSWORD)]],
  ])('answers Basic user credentials in %s with the authenticated session, whose token carries the user', async (_label, authorization) => {
    const res = await send(app(), 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, { headers: { authorization } }));

    const body = res.json() as { outcome: string; sessionId: string };
    expect(body.outcome).toBe('authenticated');
    expect(body).not.toHaveProperty('legacyResponse');
    expect((await mintVerified(body.sessionId, GHOST)).claims).toMatchObject({ sub: USER, sid: body.sessionId, site: GHOST });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['nothing else sent', {}, []],
    ['a client id and secret in the query and form', { query: { client_id: 'C-unused', client_secret: 'unused', keep: '1' }, form: { client_id: 'C-unused', client_secret: 'unused', keep: '1' } }, ['client_id', 'client_secret']],
    ['a client id in a struct body, in another case', { body: { Client_Id: 'C-unused', keep: '1' } }, ['Client_Id']],
  ])('lists the params legacy consumed for Basic user credentials beside %s', async (_label, extra, consumed) => {
    const res = await send(app(), 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, { headers: { authorization: basic('ghost-user', PASSWORD) }, ...extra }));

    const body = res.json() as { outcome: string; consumedParams: string[] };
    expect(body.outcome).toBe('authenticated');
    expect(body.consumedParams).toEqual(consumed);
  });

  it.each<[string, Record<string, string>]>([
    ['alone', {}],
    ['beside Basic OAuth client credentials, whose retained client id and secret are not listed', { authorization: basic(CLIENT, CLIENT_SECRET) }],
  ])('lists an access token the query sent as consumed %s', async (_label, headers) => {
    // The gateway sends the URL scope as the query and the route key's merged params as the form.
    const sent = { access_token: ACCESS_TOKEN, keep: '1' };

    const res = await send(app(), 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(REST_PATH, { headers, query: sent, form: sent }));

    const body = res.json() as { outcome: string; sessionId: string; consumedParams: string[] };
    expect(body.outcome).toBe('authenticated');
    expect(body.consumedParams).toEqual(['access_token']);
    expect((await mintVerified(body.sessionId, GHOST)).claims).toMatchObject({ sub: USER, sid: body.sessionId });
  });

  it('reads a request naming no site as legacy default, whose registered site answers the REST 500', async () => {
    const { siteId: _siteId, ...unsited } = restRequest(REST_PATH, { headers: { authorization: basic('ghost-user', PASSWORD) } });

    const res = await send(app(), 'POST', AUTHENTICATE, await headersFor('gateway'), unsited);

    expect(res.json()).toMatchObject({ outcome: 'denied', sessionId: null, legacyResponse: { status: 500 } });
  });

  it('answers an OAuth token grant as answered, the form overriding the query and a struct body the form, ignoring key case', async () => {
    const res = await send(
      app(),
      'POST',
      AUTHENTICATE,
      await headersFor('gateway'),
      restRequest(TOKEN_PATH, {
        method: 'POST',
        // The earlier scopes hold the exact-case keys, so only a case-insensitive overwrite leaves the later values.
        query: { grant_type: 'password', client_id: 'C-unknown' },
        form: { CLIENT_ID: CLIENT, Grant_Type: 'refresh_token' },
        body: { GRANT_TYPE: 'client_credentials', client_secret: CLIENT_SECRET },
      }),
    );

    const body = res.json() as { outcome: string; sessionId: null; legacyResponse: { status: number; body: string } };
    expect(body).toMatchObject({ outcome: 'answered', sessionId: null, legacyResponse: { status: 200 } });
    expect(JSON.parse(body.legacyResponse.body)).toMatchObject({ token_type: 'Bearer', expires_in: expect.any(Number) });
  });

  it.each<[string, string, Record<string, string>]>([
    ['an Origin on a registered domain', 'http://localhost', echoOf('http://localhost')],
    ['an Origin off every registered domain', 'http://evil.example', {}],
  ])('answers a token grant to %s with the token behind legacy echo', async (_label, origin, echo) => {
    const query = { grant_type: 'client_credentials', client_id: CLIENT, client_secret: CLIENT_SECRET };

    const res = await send(app(), 'POST', AUTHENTICATE, await headersFor('gateway'), restRequest(TOKEN_PATH, { method: 'POST', headers: { origin }, query }));

    const body = res.json() as { outcome: string; legacyResponse: { status: number; headers: Record<string, string>; body: string } };
    expect(body).toMatchObject({ outcome: 'answered', sessionId: null, legacyResponse: { status: 200 } });
    expect(JSON.parse(body.legacyResponse.body)).toMatchObject({ token_type: 'Bearer' });
    expectEcho(body.legacyResponse.headers, echo);
  });
});
