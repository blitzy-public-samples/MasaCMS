/** The `cwebservice` list, edit, save and delete routes over a throwaway `identity` schema: contract shape, the S2 gate, request validation, the session-site list, new-client defaults, the save without `siteid`, CSRF-gated writes, validation errors and the token cascade. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN, cfUuid } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { ensureUnitGates, registerWritePositionHeader, withGatedTenant } from '@opt2/platform/migration-kit';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, withMetadata, withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
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
import type { BridgeRelay, LegacyUsedToken } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS, type LoginSnapshot, type OAuthClientRow } from '../../src/repo/tables.js';
import { registerAdminOAuthClientRoutes } from '../../src/routes/admin-oauth-clients.js';

type Method = 'GET' | 'PUT' | 'DELETE';
type Payload = URLSearchParams | Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const CONTRACT_PATHS = ['/v1/oauth-clients', '/v1/oauth-clients/{clientId}'];
const LIST_URL = '/v1/oauth-clients';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 120);
const NOW_TEXT = '2026-06-30T12:00:00.120';
const CLOCK = fixedClock(NOW);
const SITE = 'tenant-a';
const OTHER_SITE = 'tenant-b';
const SECRET = 'K0000000-0000-0000-0000000000000002';
const ADMIN_USER = 'A0000000-0000-0000-0000000000000002';
const NEW_CLIENT = 'E0000000-0000-0000-0000000000000001';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

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

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let sessionSeq = 0;
const relay = recordingRelay();

function clientUrl(clientId: string, query = ''): string {
  return `/v1/oauth-clients/${clientId}${query}`;
}

function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  return withGatedTenant(handle.app, tenantIdForSite(site), fn);
}

async function registerSite(db: TenantDb, schema: string, site: string): Promise<void> {
  await withMetadata(db, (tx) =>
    tx.query(
      `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
        ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
      [site, tenantIdForSite(site), NOW],
    ),
  );
}

/** The stored client `clientId` of `site`'s tenant; null when absent. */
function storedClient(clientId: string, site = SITE): Promise<OAuthClientRow | null> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  return withTenant(handle.app, tenantIdForSite(site), (tx) => repo.findOAuthClient(tx, clientId));
}

/** The stored token `token` of `site`'s tenant; null when absent. */
function storedToken(token: string, site = SITE): Promise<unknown> {
  if (handle === undefined) throw new Error('PostgreSQL is not available');
  return withTenant(handle.app, tenantIdForSite(site), (tx) => repo.findToken(tx, token));
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-admin-oauth-clients-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const { schema } = handle;
    repo = createIdentityRepository({ clock: CLOCK, schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await registerSite(handle.app, schema, SITE);
    await registerSite(handle.app, schema, OTHER_SITE);
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
  await registerAdminOAuthClientRoutes(app, { oauth: { db, repo, clock: CLOCK }, sessions: { db, repo, clock: CLOCK }, csrf });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  relay.calls.length = 0;
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
  ['GET', LIST_URL, undefined],
  ['GET', clientUrl(NEW_CLIENT), undefined],
  ['PUT', clientUrl(NEW_CLIENT), new URLSearchParams({ name: 'Feed reader' })],
  ['DELETE', clientUrl(NEW_CLIENT), undefined],
];

describe('route declarations', () => {
  it('match the four contract operations, each requiring s2 on the service transport', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => route.url.startsWith('/v1/oauth-clients'));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template.replace('{clientId}', ':clientId'),
          transport: operation['x-opt2-transport'],
          requires: operation['x-opt2-requires'],
        })),
    );
    expect(Object.keys(OPENAPI.paths).filter((template) => template.startsWith('/v1/oauth-clients'))).toEqual(CONTRACT_PATHS);
    expect(expected).toHaveLength(4);
    expect(declared).toHaveLength(4);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry): unknown => expect.objectContaining({ ...entry, requires: [Roles.s2] }))));
  });
});

describe('auth denials', () => {
  it.each(DECLARED_ROUTES)('refuse %s %s to users without s2', async (method, url, payload) => {
    for (const roles of [[Roles.siteAdmin, Roles.systemUser], [Roles.systemUser, 'm:008'], [Roles.member], []]) {
      const res = await send(method, url, await headersFor(roles), payload);

      expect(res.statusCode).toBe(403);
    }
  });

  it.each(DECLARED_ROUTES)('answer %s %s without a user token, without an invocation credential, or with an s2 service credential alone with 401', async (method, url, payload) => {
    const serviceOnly = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity', roles: [Roles.s2] })}` };

    const answers = await Promise.all([
      send(method, url, await headersFor(null), payload),
      send(method, url, await headersFor([Roles.s2], undefined, null), payload),
      send(method, url, serviceOnly, payload),
    ]);

    expect(answers.map((res) => res.statusCode)).toEqual([401, 401, 401]);
    expect(answers[0]?.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(answers[2]?.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it.each(DECLARED_ROUTES)('refuse %s %s for a siteid other than the token site', async (method, url, payload) => {
    const res = await send(method, `${url}?siteid=${OTHER_SITE}`, await headersFor([Roles.s2]), payload);

    expect(res.statusCode).toBe(403);
  });

  it('refuse a save whose posted siteid differs from the token site', async () => {
    const res = await send('PUT', clientUrl(NEW_CLIENT), await headersFor([Roles.s2]), new URLSearchParams({ siteid: OTHER_SITE, name: 'Feed reader' }));

    expect(res.statusCode).toBe(403);
  });
});

describe('request validation', () => {
  it.each<[Method, string, Payload | undefined]>([
    ['GET', clientUrl('E0000000'), undefined],
    ['PUT', clientUrl(`${NEW_CLIENT}0`), new URLSearchParams({ name: 'Feed reader' })],
    ['DELETE', clientUrl('not-a-client-id-of-thirty-five-chars'), undefined],
    ['PUT', clientUrl(NEW_CLIENT), new URLSearchParams({ siteid: SITE, name: 'N'.repeat(51) })],
    ['PUT', clientUrl(NEW_CLIENT), new URLSearchParams({ siteid: SITE, name: 'Feed reader', granttype: 'refresh_token' })],
    ['PUT', clientUrl(NEW_CLIENT), { siteid: SITE, name: 'Feed reader', router: { url: './' } }],
    ['PUT', clientUrl(NEW_CLIENT), undefined],
    ['GET', `${LIST_URL}?siteid=`, undefined],
  ])('answer %s %s with the shared invalidParameters 400 before any read or write', async (method, url, payload) => {
    const res = await send(method, url, await headersFor([Roles.s2]), payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_request', message: 'Invalid parameters' } });
    expect(relay.calls).toEqual([]);
  });
});

describe('save without siteid', () => {
  it('answer the posted values under the token site, unwritten and without errors, reading and consuming nothing', async () => {
    const res = await send('PUT', clientUrl(NEW_CLIENT), await headersFor([Roles.s2]), new URLSearchParams({ name: 'Feed reader', redirectURL: 'https://a.example/cb' }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      written: false,
      client: {
        clientid: NEW_CLIENT,
        clientsecret: '',
        siteid: SITE,
        userid: '',
        name: 'Feed reader',
        description: '',
        granttype: 'basic',
        redirecturl: 'https://a.example/cb',
        created: null,
        lastupdate: null,
        lastupdateby: '',
        lastupdatebidy: '',
      },
      errors: {},
    });
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(relay.calls).toEqual([]);
  });
});

describe.skipIf(!available)('cwebservice screens against PostgreSQL', () => {
  const SNAPSHOT: LoginSnapshot = {
    userid: ADMIN_USER, username: 'admin', siteid: SITE, subtype: 'Default', password: null, fname: 'Ada', lname: 'Admin', email: 'admin@example.com',
    remoteid: null, company: null, lastlogin: null, passwordcreated: null, roleList: 'S2', membershipIds: ADMIN_USER,
  };

  /** Inserts an active signed-in session of the admin user under the test secret and returns its id. */
  async function newSession(): Promise<string> {
    sessionSeq += 1;
    const sessionId = `S-oauth-${sessionSeq}`;
    await gated(SITE, (tx) =>
      repo.insertSession(tx, {
        session_id: sessionId, csrf_secret: SECRET, mode: 'target-primary', state: 'active', user_id: ADMIN_USER, site_id: SITE,
        login_snapshot: JSON.stringify(SNAPSHOT),
      }),
    );
    return sessionId;
  }

  /** The CSRF form fields of a token for `context` under the test secret, issued `minutesAgo` before the fixed clock. */
  function csrfFields(context: string, minutesAgo = 0): Record<string, string> {
    const { token, expires } = issueTokens({ csrfSecret: SECRET }, { context, clock: fixedClock(NOW.getTime() - minutesAgo * 60_000) });
    return { [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  /** Stores a client of `site` with `values` laid over a Basic client. */
  async function seedClient(site: string, values: Partial<OAuthClientRow> = {}): Promise<OAuthClientRow> {
    return gated(site, (tx) =>
      repo.insertOAuthClient(tx, {
        clientid: cfUuid(), clientsecret: 'S3CRET', siteid: site, granttype: 'basic', userid: null, name: 'Seeded', created: NOW, lastupdate: NOW,
        description: null, redirecturl: null, lastupdatebidy: null, lastupdateby: 'Seed Er', ...values,
      }),
    );
  }

  it('list the token site clients by clientid, an empty grant type read as client_credentials, ignoring the requested site spelling', async () => {
    const first = await seedClient(SITE, { clientid: '10000000-0000-0000-0000000000000001', name: 'First', granttype: '' });
    const second = await seedClient(SITE, { clientid: '10000000-0000-0000-0000000000000002', name: 'Second', granttype: 'password', description: 'Two' });
    await seedClient(OTHER_SITE, { clientid: '10000000-0000-0000-0000000000000003', name: 'Elsewhere' });

    const res = await send('GET', `${LIST_URL}?siteid=TENANT-A`, await headersFor([Roles.s2]));

    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { clientid: string; name: string; granttype: string; description: string | null; created: string }[] }>().items;
    const seeded = items.filter((item) => item.clientid.startsWith('10000000'));
    expect(seeded.map(({ clientid, name, granttype, description }) => ({ clientid, name, granttype, description }))).toEqual([
      { clientid: first.clientid, name: 'First', granttype: 'client_credentials', description: null },
      { clientid: second.clientid, name: 'Second', granttype: 'password', description: 'Two' },
    ]);
    expect(seeded[0]?.created).toMatch(LOCAL_TIMESTAMP);
  });

  it('answer edit with the stored client, and an unknown id with the new bean init leaves under the requested site', async () => {
    const stored = await seedClient(SITE, { name: 'Stored', granttype: 'client_credentials', userid: ADMIN_USER });
    const headers = await headersFor([Roles.s2], await newSession());

    const found = await send('GET', clientUrl(stored.clientid), headers);
    const missing = await send('GET', clientUrl(NEW_CLIENT, `?siteid=${SITE}`), headers);

    expect(found.json()).toMatchObject({
      exists: true,
      client: { clientid: stored.clientid, siteid: SITE, name: 'Stored', clientsecret: 'S3CRET', granttype: 'client_credentials', userid: ADMIN_USER, lastupdateby: 'Seed Er' },
    });
    expect(missing.json()).toEqual({
      exists: false,
      client: {
        clientid: NEW_CLIENT, clientsecret: '', siteid: SITE, userid: '', name: '', description: '', granttype: 'basic', redirecturl: '',
        created: NOW_TEXT, lastupdate: NOW_TEXT, lastupdateby: 'Ada Admin', lastupdatebidy: '',
      },
    });
  });

  it('save a new client once under a valid token, generating its secret and stamping the session user, and skip the write on a reused token', async () => {
    const clientId = cfUuid();
    const sessionId = await newSession();
    const headers = await headersFor([Roles.s2], sessionId);
    const fields = csrfFields(clientId);
    const form = new URLSearchParams({ siteid: SITE, clientid: clientId, name: 'Feed reader', granttype: 'client_credentials', description: 'Reads feeds', ...fields });

    const saved = await send('PUT', clientUrl(clientId), headers, form);

    expect(saved.statusCode).toBe(200);
    const body = saved.json<{ written: boolean; errors: object; client: { clientsecret: string; lastupdateby: string; name: string } }>();
    expect(body).toMatchObject({ written: true, errors: {}, client: { name: 'Feed reader', lastupdateby: 'Ada Admin' } });
    expect(body.client.clientsecret).toMatch(/^[0-9A-F]{64}$/);
    expect(saved.headers['x-opt2-write-position']).toMatch(/^identity=/);
    expect(relay.calls).toEqual([{ sessionId, tokens: [{ token: fields[CSRF_FIELD_TOKEN], usedAt: NOW }] }]);
    expect(await storedClient(clientId)).toMatchObject({ name: 'Feed reader', granttype: 'client_credentials', clientsecret: body.client.clientsecret });

    const reused = await send('PUT', clientUrl(clientId), headers, new URLSearchParams({ siteid: SITE, name: 'Renamed', clientsecret: body.client.clientsecret, ...fields }));

    expect(reused.json()).toMatchObject({ written: false, errors: {}, client: { name: 'Renamed' } });
    expect((await storedClient(clientId))?.name).toBe('Feed reader');
  });

  it('update a stored client from a JSON body with the token in headers, reading redirectURL in any case', async () => {
    const stored = await seedClient(SITE, { name: 'Before' });
    const { [CSRF_FIELD_TOKEN]: token = '', [CSRF_FIELD_EXPIRES]: expires = '' } = csrfFields(stored.clientid, 1);
    const headers = { ...(await headersFor([Roles.s2], await newSession())), [CSRF_HEADER_TOKEN]: token, [CSRF_HEADER_EXPIRES]: expires };

    const res = await send('PUT', clientUrl(stored.clientid), headers, {
      siteid: SITE, name: 'After', granttype: 'authorization_code', RedirectUrl: 'https://a.example/cb', clientsecret: 'S3CRET',
    });

    expect(res.json()).toMatchObject({ written: true, errors: {}, client: { name: 'After', redirecturl: 'https://a.example/cb', clientsecret: 'S3CRET' } });
    expect(await storedClient(stored.clientid)).toMatchObject({ name: 'After', granttype: 'authorization_code', redirecturl: 'https://a.example/cb' });
  });

  it.each<[string, (clientId: string) => Record<string, string>]>([
    ['without a token', () => ({})],
    ['with a token of another context', () => csrfFields(NEW_CLIENT)],
  ])('validate but never write a save %s, answering the validation errors', async (_label, tokenOf) => {
    const clientId = cfUuid();
    const headers = await headersFor([Roles.s2], await newSession());

    const valid = await send('PUT', clientUrl(clientId), headers, new URLSearchParams({ siteid: SITE, name: 'Unsaved', ...tokenOf(clientId) }));
    const invalid = await send('PUT', clientUrl(clientId), headers, new URLSearchParams({ siteid: SITE, name: '', ...tokenOf(clientId) }));

    expect(valid.json()).toMatchObject({ written: false, errors: {}, client: { name: 'Unsaved', clientsecret: '' } });
    expect(invalid.json()).toMatchObject({ written: false, errors: { name: "The property named 'name' is not valid" } });
    expect(valid.headers['x-opt2-write-position']).toBeUndefined();
    expect(await storedClient(clientId)).toBeNull();
  });

  it('answer the validation errors of a save under a valid token, an empty posted siteid included, and write nothing', async () => {
    const clientId = cfUuid();
    const headers = await headersFor([Roles.s2], await newSession());

    const res = await send('PUT', clientUrl(clientId), headers, new URLSearchParams({ siteid: '', name: '', ...csrfFields(clientId) }));

    expect(res.statusCode).toBe(200);
    const body = res.json<{ written: boolean; errors: Record<string, string>; client: { clientsecret: string } }>();
    expect(body.written).toBe(false);
    expect(Object.keys(body.errors).sort()).toEqual(['name', 'siteid']);
    expect(body.client.clientsecret).toMatch(/^[0-9A-F]{64}$/);
    expect(relay.calls).toHaveLength(1);
    expect(await storedClient(clientId)).toBeNull();
  });

  it('delete a client and its tokens under a URL token, and keep both without one', async () => {
    const stored = await seedClient(SITE, { name: 'Doomed' });
    const token = `000${'E'.repeat(32)}`;
    await gated(SITE, (tx) =>
      repo.insertToken(tx, { token, clientid: stored.clientid, granttype: 'client_credentials', userid: null, accesscode: null, data: null, expires: NOW }),
    );
    const headers = await headersFor([Roles.s2], await newSession());

    const kept = await send('DELETE', clientUrl(stored.clientid, `?siteid=${SITE}`), headers);
    expect(kept.json()).toEqual({ written: false });
    expect(await storedClient(stored.clientid)).not.toBeNull();
    expect(await storedToken(token)).not.toBeNull();

    const query = new URLSearchParams({ siteid: SITE, ...csrfFields(stored.clientid) });
    const deleted = await send('DELETE', clientUrl(stored.clientid, `?${query.toString()}`), headers);

    expect(deleted.json()).toEqual({ written: true });
    expect(deleted.headers['x-opt2-write-position']).toMatch(/^identity=/);
    expect(await storedClient(stored.clientid)).toBeNull();
    expect(await storedToken(token)).toBeNull();
  });

  it('delete under form-posted token fields, and answer written false for an unknown client', async () => {
    const stored = await seedClient(SITE, { name: 'Posted' });
    const headers = await headersFor([Roles.s2], await newSession());

    const deleted = await send('DELETE', clientUrl(stored.clientid), headers, new URLSearchParams(csrfFields(stored.clientid)));
    const unknown = await send('DELETE', clientUrl(NEW_CLIENT), headers, new URLSearchParams(csrfFields(NEW_CLIENT)));

    expect([deleted.json(), unknown.json()]).toEqual([{ written: true }, { written: false }]);
    expect(await storedClient(stored.clientid)).toBeNull();
  });

  it('stamp no audit name when the token session is unknown', async () => {
    const res = await send('GET', clientUrl(NEW_CLIENT), await headersFor([Roles.s2], 'S-oauth-unknown'));

    expect(res.json()).toMatchObject({ exists: false, client: { lastupdateby: '' } });
  });
});
