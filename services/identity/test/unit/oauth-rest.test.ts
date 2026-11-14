/** REST credential exchange and OAuth token endpoints through `authenticateRestRequest`, against legacy's observed ACF 2023 answers and a throwaway `identity` schema. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyServiceUnavailableError, WWW_AUTHENTICATE, etag } from '@opt2/platform/legacy-compat';
import { ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { DEFAULT_LOGIN_SETTINGS, type LoginSettings } from '../../src/domain/login.js';
import { expiresAt, findOAuthUser, findToken, type OAuthDeps } from '../../src/domain/oauth.js';
import { sessionState, type SessionDeps } from '../../src/domain/sessions.js';
import { parseLegacySessionJson } from '../../src/legacy/session-json.js';
import { createIdentityRepository, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { authenticateRestRequest, type OAuthRouteDeps, type RestAuthInput, type RestAuthOutcome } from '../../src/routes/oauth.js';

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const HOUR_MS = 3_600_000;
const PASSWORD = 'Secret12';
const DEFAULT = 'default';
const SITE_A = 'tenant-a';
/** A site legacy holds and identity's registry does not, so no REST event of it builds a content renderer. */
const GHOST = 'ghost';
const FAST_SETTINGS: LoginSettings = { password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 }, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const STORED_SESSION = readFileSync(new URL('../fixtures/legacy/oauth-token-data.json', import.meta.url), 'utf8');
const STORED_USER = '7E3C1A20-5B4D-4F6E-8A9B0C1D2E3F4A5B';
/** `info` of the stored session as legacy answered it, keys and order included. */
const STORED_INFO =
  '{"subtype":"Default","passwordcreated":"2026-06-30T10:20:30","membershipids":"4D2B9E10-3A6C-4B7D-9E8F0A1B2C3D4E5F,7E3C1A20-5B4D-4F6E-8A9B0C1D2E3F4A5B",' +
  '"lname":"Editor","siteid":"default","email":"qa.editor@example.com","fname":"QA","company":"","remoteid":"","userid":"7E3C1A20-5B4D-4F6E-8A9B0C1D2E3F4A5B",' +
  '"username":"qa_editor","memberships":"Editor;default;0,S2IsPrivate;default,S2IsPrivate,qa_editor;username;default"}';
const LEGACY_JSON_TYPE = 'application/json;charset=utf-8';

/** Error bodies exactly as legacy sent them. */
const BODY = {
  authorization: '{"apiversion":"v1","method":"invalid","error":{"message":"Insufficient Account Permissions","code":"invalid_request"}}',
  invalidAccessToken: '{"apiversion":"v1","method":"invalid","error":{"message":"Invalid Access Token","code":"invalid_token"}}',
  accessTokenExpired: '{"apiversion":"v1","method":"invalid","error":{"message":"Access Token Expired","code":"invalid_token"}}',
  invalidParameters: '{"apiversion":"v1","method":"invalid","error":{"message":"Invalid parameters","code":"invalid_request"}}',
  unhandled: '{"apiversion":"v1","method":"invalid","error":{"message":"Unhandled Exception","code":"server_error"}}',
} as const;

const FAILING_DB = (err: Error): TenantDb => ({
  schema: 'identity',
  withTenant: () => Promise.reject(err),
  withMetadata: () => Promise.reject(err),
  end: () => Promise.resolve(),
});

/** Route deps over `db`; `repo` is never reached without a database. */
function depsOver(db: TenantDb, repo: IdentityRepository): OAuthRouteDeps {
  const oauth: OAuthDeps = { db, repo, clock: CLOCK };
  return { oauth, login: { db, repo, clock: CLOCK, settings: FAST_SETTINGS }, sessions: { db, repo, clock: CLOCK } };
}

/** A REST request on `path` for `siteId`, its params merged from the query and `params` as legacy merges them. */
function rest(path: string, opts: { siteId?: string; headers?: Record<string, string>; query?: Record<string, string>; params?: Record<string, unknown> } = {}): RestAuthInput {
  const query = opts.query ?? {};
  return { path, httpMethod: 'POST', headers: opts.headers ?? {}, query, params: { ...query, ...opts.params }, siteId: opts.siteId ?? DEFAULT };
}

function basic(id: string, secret: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
}

/** The response outcome of `outcome`; fails on a session outcome. */
function answer(outcome: RestAuthOutcome): Extract<RestAuthOutcome, { kind: 'response' }> {
  if (outcome.kind !== 'response') throw new Error(`expected a response outcome, got ${JSON.stringify(outcome)}`);
  return outcome;
}

/** The session outcome of `outcome`; fails on a response outcome. */
function continued(outcome: RestAuthOutcome): Extract<RestAuthOutcome, { kind: 'session' }> {
  if (outcome.kind !== 'session') throw new Error(`expected a session outcome, got ${outcome.status} ${outcome.body}`);
  return outcome;
}

/** Asserts a legacy error answer: status, exact body, its ETag, and the `WWW-Authenticate` legacy left (absent for none). */
function expectError(outcome: RestAuthOutcome, status: number, body: string, wwwAuthenticate?: string): void {
  const res = answer(outcome);
  expect(res.status).toBe(status);
  expect(res.body).toBe(body);
  expect(res.headers['Content-Type']).toBe(LEGACY_JSON_TYPE);
  expect(res.headers.ETag).toBe(etag(body));
  expect(res.headers['WWW-Authenticate']).toBe(wwwAuthenticate);
}

describe('authenticateRestRequest without a database', () => {
  const deps = depsOver(FAILING_DB(new Error('no database in this run')), createIdentityRepository({ clock: CLOCK }));

  it.each([
    ['a non-oauth path', '/_api/rest/v1/default/content', 'Basic'],
    ['a six-segment oauth path', '/_api/rest/v1/default/oauth2/token', 'Bearer error="invalid_client_credentials"'],
    ['a five-segment path ending oauth', '/_api/rest/v1/default/oauth', 'Bearer error="invalid_client_credentials"'],
    ['a five-segment path with oauth2 fourth', '/_api/rest/v1/oauth2/token', 'Bearer error="invalid_client_credentials"'],
    ['an OAUTH path, which listFind matches case-sensitively', '/_api/rest/v1/default/OAUTH', 'Basic'],
  ])('refuses no credentials on %s with %s (jsonApiUtility.cfc:534-556)', async (_label, path, header) => {
    const outcome = await authenticateRestRequest(deps, rest(path, { params: { client_secret: 'x' } }));

    expectError(outcome, 401, BODY.authorization, header);
  });

  it('names the missing-credential headers by the platform constants', async () => {
    const onOAuth = answer(await authenticateRestRequest(deps, rest('/_api/rest/v1/default/oauth')));
    const offOAuth = answer(await authenticateRestRequest(deps, rest('/_api/rest/v1/default/content')));

    expect(onOAuth.headers['WWW-Authenticate']).toBe(WWW_AUTHENTICATE.bearerInvalidClientCredentials);
    expect(offOAuth.headers['WWW-Authenticate']).toBe(WWW_AUTHENTICATE.basic);
  });

  it.each(['abc', 'YWJ', 'YWJjZA', 'YWJjZA=', 'YW-j', '=YWJj', 'Basic'])(
    'answers Basic %j, which ACF toBinary rejects, with the unhandled-exception 500 (jsonApiUtility.cfc:458)',
    async (value) => {
      const outcome = await authenticateRestRequest(deps, rest('/_api/rest/v1/default/content', { headers: { Authorization: `Basic ${value}` } }));

      expectError(outcome, 500, BODY.unhandled);
    },
  );

  it('reads a lower-case basic scheme and a ":" pair as an empty client id, refused as an unknown client (jsonApiUtility.cfc:457-460,560-566)', async () => {
    const outcome = await authenticateRestRequest(deps, rest('/_api/rest/v1/default/content', { headers: { authorization: 'basic Og==' } }));

    expectError(outcome, 401, BODY.authorization, 'Bearer error="invalid_client_credentials"');
  });

  it('answers a refresh token without a client id with the 500 of an undefined params.client_id (jsonApiUtility.cfc:558)', async () => {
    const outcome = await authenticateRestRequest(deps, rest('/_api/rest/v1/default/oauth2', { params: { refresh_token: 'R' } }));

    expectError(outcome, 500, BODY.unhandled);
  });

  it('propagates an unavailable store to the legacy 503 and answers any other failure as the unhandled exception', async () => {
    const unavailable = new LegacyServiceUnavailableError();
    const down = depsOver(FAILING_DB(unavailable), createIdentityRepository({ clock: CLOCK }));
    const input = rest('/_api/rest/v1/default/content', { headers: { Authorization: 'Bearer T' } });

    await expect(authenticateRestRequest(down, input)).rejects.toBe(unavailable);
    expectError(await authenticateRestRequest(deps, input), 500, BODY.unhandled);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('authenticateRestRequest against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let deps: OAuthRouteDeps;
  let sessions: SessionDeps;
  let seq = 0;
  const users = { ghost: '', site: '' };
  const clients = {
    ccGhost: '', ccSite: '', ccNoUser: '', password: '', bearer: '', basicGhost: '', basicSite: '', basicNoUser: '', code: '',
    ccGhostOnDefault: '', passwordOnDefault: '', ccOnSiteA: '', basicOnSiteA: '',
  };

  function nextId(prefix: string): string {
    seq += 1;
    return `${prefix}0000000-0000-0000-${String(seq).padStart(16, '0')}`;
  }

  function gated<T>(fn: (tx: TenantTx) => Promise<T>, siteId = DEFAULT): Promise<T> {
    return withGatedTenant(handle.app, tenantIdForSite(siteId), fn);
  }

  async function registerSite(site: string): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, aggregate_version, updated_at) VALUES ($1, $2, $1, $1, $2, $2, 1, $3)',
        [site, tenantIdForSite(site), NOW],
      ),
    );
  }

  /** An active account of the default tenant whose stored site is `siteId`. */
  async function seedUser(username: string, siteId: string, stored: string): Promise<string> {
    const userId = nextId('A');
    await gated(async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: siteId, remoteid: '', tablist: '' });
      await repo.writeCredential(tx, userId, { password: stored, passwordcreated: new Date(2026, 5, 1, 9, 15, 0) });
      await repo.upsertPersonContact(tx, { user_id: userId, site_id: siteId, subtype: 'Default', aggregate_version: 1, fname: 'Ghost', lname: 'User', email: 'ghost@example.test', company: '' });
    });
    return userId;
  }

  /** A client of `siteId`, stored in that site's tenant, the only one the token endpoint reads for a request of the site. */
  async function seedClient(siteId: string, granttype: string, clientsecret: string, userid: string | null, redirecturl: string | null = null): Promise<string> {
    const clientid = nextId('C');
    await gated(
      (tx) =>
        repo.insertOAuthClient(tx, {
          clientid, clientsecret, siteid: siteId, granttype, userid, name: granttype, created: NOW, lastupdate: NOW,
          description: null, redirecturl, lastupdatebidy: null, lastupdateby: null,
        }),
      siteId,
    );
    return clientid;
  }

  /** A token in the tenant of `opts.siteId`, DEFAULT when absent; token lookups read only registered tenants, a grant's reuse only the client's. */
  async function seedToken(token: string, granttype: string, clientid: string, userid: string, opts: { data?: string; accesscode?: string; expiresInMs?: number; siteId?: string } = {}): Promise<void> {
    await gated(
      (tx) =>
        repo.insertToken(tx, {
          token, granttype, clientid, userid, accesscode: opts.accesscode ?? null, data: opts.data ?? null,
          expires: new Date(NOW.getTime() + (opts.expiresInMs ?? HOUR_MS)),
        }),
      opts.siteId,
    );
  }

  function call(path: string, opts: Parameters<typeof rest>[1] = {}): Promise<RestAuthOutcome> {
    return authenticateRestRequest(deps, rest(path, opts));
  }

  function grant(path: string, params: Record<string, unknown>, siteId = GHOST): Promise<RestAuthOutcome> {
    return call(path, { siteId, params });
  }

  /** The parsed JSON body of a 200 answer. */
  function okJson(outcome: RestAuthOutcome): Record<string, unknown> {
    const res = answer(outcome);
    expect(res.status, res.body).toBe(200);
    expect(res.headers.ETag).toBe(etag(res.body));
    expect(res.headers['WWW-Authenticate']).toBeUndefined();
    return JSON.parse(res.body) as Record<string, unknown>;
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    deps = depsOver(handle.app, repo);
    sessions = deps.sessions;
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    await registerSite(DEFAULT);
    await registerSite(SITE_A);
    const stored = await bcrypt.hash(PASSWORD, (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
    users.ghost = await seedUser('ghost-user', GHOST, stored);
    users.site = await seedUser('site-user', DEFAULT, stored);
    clients.ccGhost = await seedClient(GHOST, 'client_credentials', 'cc-secret', users.ghost);
    clients.ccSite = await seedClient(DEFAULT, 'client_credentials', 'cc-secret', users.site);
    clients.ccNoUser = await seedClient(GHOST, 'client_credentials', 'cc-secret', null);
    clients.password = await seedClient(GHOST, 'password', 'pw-secret', users.ghost);
    clients.bearer = await seedClient(DEFAULT, 'password', 'pw-secret', users.ghost);
    clients.basicGhost = await seedClient(GHOST, 'basic', 'basic-secret', users.ghost);
    clients.basicSite = await seedClient(GHOST, 'basic', 'basic-secret', users.site);
    clients.basicNoUser = await seedClient(GHOST, 'basic', 'basic-secret', null);
    clients.code = await seedClient(GHOST, 'authorization_code', 'ac-secret', users.ghost, 'https://ok.example.test/cb\r\nhttps://other.example.test/cb');
    clients.ccGhostOnDefault = await seedClient(DEFAULT, 'client_credentials', 'cc-secret', users.ghost);
    clients.passwordOnDefault = await seedClient(DEFAULT, 'password', 'pw-secret', users.ghost);
    clients.ccOnSiteA = await seedClient(SITE_A, 'client_credentials', 'cc-secret', users.ghost);
    clients.basicOnSiteA = await seedClient(SITE_A, 'basic', 'basic-secret', users.ghost);
    await seedToken('T-JSON', 'password', clients.bearer, STORED_USER, { data: STORED_SESSION });
    await seedToken('T-RAW-GHOST', 'password', clients.bearer, users.ghost);
    await seedToken('T-RAW-SITE', 'password', clients.bearer, users.site);
    await seedToken('T-EXP', 'client_credentials', clients.ccGhost, users.ghost, { expiresInMs: -HOUR_MS });
    await seedToken('T-REFRESH', 'refresh_token', clients.ccGhost, users.ghost);
    await seedToken('T-NOCLIENT', 'password', nextId('C'), users.ghost);
    await seedToken('T-NOUSER', 'password', clients.bearer, nextId('A'));
    await seedToken('T-NOTJSON', 'password', clients.bearer, users.ghost, { data: '{"MURA":' });
    await seedToken('T-ARRAY', 'password', clients.bearer, users.ghost, { data: '[1]' });
    await seedToken('RT-GHOST', 'refresh_token', clients.ccGhost, users.ghost);
    await seedToken('RT-EXP', 'refresh_token', clients.ccGhost, users.ghost, { expiresInMs: -HOUR_MS });
    await seedToken('RT-REUSABLE', 'refresh_token', clients.ccGhost, users.ghost, { siteId: GHOST });
    await seedToken('T-CODE-JSON', 'authorization_code', clients.code, users.ghost, { data: STORED_SESSION, accesscode: 'CODE-JSON' });
    await seedToken('T-CODE-RAW', 'authorization_code', clients.code, users.ghost, { accesscode: 'CODE-RAW' });
  });

  afterAll(async () => {
    await (handle as ThrowawaySchema | undefined)?.drop();
  });

  describe('Basic credentials of a user account (jsonApiUtility.cfc:471-481)', () => {
    it('logs a fresh request session in as the account and drops the credentials from the params', async () => {
      const outcome = continued(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: basic('ghost-user', PASSWORD), params: { fields: 'title' } }));

      expect(outcome).toMatchObject({ siteId: GHOST, params: { fields: 'title' } });
      expect(outcome.params).not.toHaveProperty('client_id');
      expect(outcome.params).not.toHaveProperty('client_secret');
      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: users.ghost, siteId: GHOST });
    });

    it('refuses bad credentials with Basic, reporting the request method when it is a defined name', async () => {
      const outcome = await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: basic('ghost-user', 'wrong'), params: { method: 'findOne' } });

      expectError(outcome, 401, BODY.authorization.replace('"invalid"', '"findOne"'), WWW_AUTHENTICATE.basic);
    });

    it('answers the 500 legacy raises for a registered site, before any lookup or header', async () => {
      expectError(await call('/_api/rest/v1/default/content', { headers: basic('ghost-user', PASSWORD) }), 500, BODY.unhandled);
    });
  });

  describe('access tokens (jsonApiUtility.cfc:483-533)', () => {
    it.each([
      ['an unknown token', { Authorization: 'Bearer NOPE' }, BODY.invalidAccessToken, 'Bearer'],
      ['a refresh token, whose grant type is not an access grant', { Authorization: 'Bearer T-REFRESH' }, BODY.invalidAccessToken, 'Bearer'],
      ['an expired token', { Authorization: 'Bearer T-EXP' }, BODY.accessTokenExpired, 'Bearer error="invalid_access_token"'],
      ['a token of a missing client', { Authorization: 'Bearer T-NOCLIENT' }, BODY.invalidAccessToken, 'Bearer error="invalid_access_token"'],
      ['a token of a missing user', { Authorization: 'Bearer T-NOUSER' }, BODY.invalidAccessToken, 'Bearer error="invalid_access_token"'],
      ['X-access-token over X-access_token', { 'x-access_token': 'T-JSON', 'x-access-token': 'NOPE' }, BODY.invalidAccessToken, 'Bearer'],
      ['Bearer over X-access-token', { 'X-access-token': 'T-JSON', Authorization: 'Bearer NOPE' }, BODY.invalidAccessToken, 'Bearer'],
    ])('refuses %s', async (_label, headers, body, header) => {
      expectError(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers }), 401, body, header);
    });

    it('sends the header the second of legacy`s two setHeader calls leaves for an unknown token', async () => {
      const res = answer(await call('/_api/rest/v1/ghost/content', { headers: { Authorization: 'Bearer NOPE' } }));

      expect(res.headers['WWW-Authenticate']).toBe(WWW_AUTHENTICATE.bearer);
    });

    it('adopts the session JSON a token stores as the request session', async () => {
      const outcome = continued(await call('/_api/rest/v1/default/content', { headers: { Authorization: 'Bearer T-JSON' }, params: { access_token: 'ignored' } }));

      expect(outcome.params).toEqual({});
      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: STORED_USER });
    });

    it('logs the token user in and stores the request session as the token data', async () => {
      const outcome = continued(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: { Authorization: 'Bearer T-RAW-GHOST' } }));

      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ userId: users.ghost });
      const stored = parseLegacySessionJson((await findToken(deps.oauth, { token: 'T-RAW-GHOST' }))?.data);
      expect(Object.keys(stored?.session ?? {})).toEqual(['MURA', 'blockLoginUntil', 'SITEID', 'rememberMe', 'loginAttempts']);
      expect(stored?.mura).toMatchObject({ ISLOGGEDIN: true, USERID: users.ghost, USERNAME: 'ghost-user', SITEID: GHOST, PASSWORDCREATED: 'June, 01 2026 09:15:00' });
      expect(stored?.session.SITEID).toBe(DEFAULT);
    });

    it.each([
      ['a token user of a registered site, whose login raises', 'T-RAW-SITE'],
      ['stored data that is JSON but no struct', 'T-ARRAY'],
    ])('answers %s with the unhandled-exception 500', async (_label, token) => {
      expectError(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: { Authorization: `Bearer ${token}` } }), 500, BODY.unhandled);
    });

    it('logs in for stored data that is not JSON', async () => {
      const outcome = continued(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: { Authorization: 'Bearer T-NOTJSON' } }));

      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ userId: users.ghost });
    });

    it.each([
      ['six segments ending tokeninfo', '/_api/rest/v1/default/oauth2/tokeninfo'],
      ['five segments ending TOKENINFO', '/_api/rest/v1/default/TOKENINFO'],
    ])('answers tokeninfo on %s with the bare token struct of the URL token (jsonApiUtility.cfc:527-533,4998-5024)', async (_label, path) => {
      const token = await findToken(deps.oauth, { token: 'T-JSON' });
      const outcome = await call(path, { query: { access_token: 'T-JSON', client_id: 'x' }, headers: { 'X-access-token': 'T-JSON' } });

      const body = `{"access_token":"T-JSON","expires_in":3600,"token_type":"Bearer","expires_at":${String(expiresAt(token ?? { expires: NOW }))},"info":${STORED_INFO}}`;
      expect(answer(outcome)).toEqual({ kind: 'response', status: 200, headers: { 'Content-Type': LEGACY_JSON_TYPE, ETag: etag(body) }, body });
    });

    it('needs both URL parameters for tokeninfo, else continues as a token request', async () => {
      expect((await call('/_api/rest/v1/default/oauth2/tokeninfo', { query: { access_token: 'T-JSON' } })).kind).toBe('session');
    });

    it('answers tokeninfo of an expired URL token after a valid Bearer one with invalidParameters', async () => {
      const outcome = await call('/_api/rest/v1/default/oauth2/tokeninfo', { query: { access_token: 'T-EXP', client_id: 'x' }, headers: { Authorization: 'Bearer T-JSON' } });

      expectError(outcome, 400, BODY.invalidParameters);
    });
  });

  describe('client ids (jsonApiUtility.cfc:557-833)', () => {
    it('refuses an unknown client', async () => {
      expectError(await grant('/_api/rest/v1/ghost/oauth2', { client_id: nextId('C'), grant_type: 'client_credentials' }), 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
    });

    it('answers client_credentials on oauth2 with the bare token struct, the user`s unexpired refresh token and the logged-in session info', async () => {
      const body = okJson(await grant('/_api/rest/v1/ghost/oauth2', { client_id: clients.ccGhost, client_secret: 'cc-secret', grant_type: 'client_credentials' }));

      expect(Object.keys(body)).toEqual(['access_token', 'expires_in', 'token_type', 'expires_at', 'refresh_token', 'info']);
      expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-REUSABLE' });
      expect(body.access_token).toMatch(/^000[0-9A-F]{64}$/);
      expect(body.info).toEqual({
        subtype: 'Default', passwordcreated: '2026-06-01T09:15:00', membershipids: users.ghost, lname: 'User', siteid: GHOST, email: 'ghost@example.test',
        fname: 'Ghost', company: '', remoteid: '', userid: users.ghost, username: 'ghost-user', memberships: `S2IsPrivate;${GHOST},S2IsPrivate,ghost-user;username;${GHOST}`,
      });
    });

    it('compares the grant type and client secret case-insensitively, as CFML == does', async () => {
      okJson(await grant('/_api/rest/v1/oauth2/token', { client_id: clients.ccGhost, client_secret: 'CC-SECRET', grant_type: 'CLIENT_CREDENTIALS' }));
    });

    it('answers client_credentials on oauth with the {apiversion, data, method} envelope', async () => {
      const outcome = await grant('/_api/rest/v1/ghost/oauth', { client_id: clients.ccGhost, client_secret: 'cc-secret', grant_type: 'client_credentials' });

      const body = okJson(outcome);
      expect(Object.keys(body)).toEqual(['apiversion', 'data', 'method']);
      expect(body).toMatchObject({ apiversion: 'v1', method: 'getOAuthToken', data: { token_type: 'Bearer', expires_in: 3600 } });
    });

    it.each([
      ['a wrong secret', { client_id: 'ccGhost', client_secret: 'nope', grant_type: 'client_credentials' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['a client without a user', { client_id: 'ccNoUser', client_secret: 'cc-secret', grant_type: 'client_credentials' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['no client secret', { client_id: 'ccGhost', grant_type: 'client_credentials' }, 500, BODY.unhandled, undefined],
      ['a password grant of a client_credentials client', { client_id: 'ccGhost', grant_type: 'password' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['bad user credentials', { client_id: 'password', grant_type: 'password', username: 'ghost-user', password: 'nope' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['a code of a client with another secret', { client_id: 'code', client_secret: 'nope', grant_type: 'authorization_code' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidAuthorizationCode],
      ['an unknown code', { client_id: 'code', client_secret: 'ac-secret', grant_type: 'authorization_code', code: 'NOPE' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidAuthorizationCode],
      ['an unlisted redirect', { client_id: 'code', client_secret: 'ac-secret', grant_type: 'authorization_code', code: 'CODE-JSON', redirect_uri: 'https://evil.example.test/' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidAuthorizationCode],
      ['no refresh token', { client_id: 'ccGhost', grant_type: 'refresh_token' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientRefreshToken],
      ['an unknown refresh token', { client_id: 'ccGhost', grant_type: 'refresh_token', refresh_token: 'NOPE' }, 500, BODY.unhandled, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['an unknown grant type', { client_id: 'ccGhost', grant_type: 'implicit' }, 401, BODY.authorization, 'Bearer error="invalid_grant_type'],
      ['no grant type', { client_id: 'ccGhost' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidGrantType],
    ] as const)('refuses %s on the token endpoint', async (_label, params, status, body, header) => {
      const named = { ...params, client_id: clients[params.client_id] };

      expectError(await grant('/_api/rest/v1/ghost/oauth2', named), status, body, header);
    });

    it('deletes an expired refresh token and answers the unhandled exception with the client-credentials header', async () => {
      const outcome = await grant('/_api/rest/v1/ghost/oauth2', { client_id: clients.ccGhost, grant_type: 'refresh_token', refresh_token: 'RT-EXP' });

      expectError(outcome, 500, BODY.unhandled, 'Bearer error="invalid_client_credentials"');
      expect(await findToken(deps.oauth, { token: 'RT-EXP' })).toBeNull();
    });

    it('answers a refresh token with a client_credentials token of its user and the same refresh token', async () => {
      const body = okJson(await grant('/_api/rest/v1/ghost/oauth2', { client_id: clients.ccGhost, grant_type: 'refresh_token', refresh_token: 'RT-GHOST' }));

      expect(body).toMatchObject({ refresh_token: 'RT-GHOST', token_type: 'Bearer', expires_in: 3600 });
    });

    it('answers the password grant with the account found by the credentials', async () => {
      const body = okJson(await grant('/_api/rest/v1/ghost/oauth2', { client_id: clients.password, grant_type: 'password', username: 'ghost-user', password: PASSWORD }));

      expect(body).toMatchObject({ token_type: 'Bearer', refresh_token: expect.stringMatching(/^000/), info: { userid: users.ghost } });
    });

    it.each([
      ['a code whose token stores session JSON, answering that session', 'CODE-JSON', 'T-CODE-JSON', STORED_USER],
      ['a code whose token stores none, answering the session of the login it runs', 'CODE-RAW', 'T-CODE-RAW', 'ghost'],
    ])('answers %s bare on an oauth path, with a new refresh token (jsonApiUtility.cfc:591-629)', async (_label, code, token, infoUser) => {
      const params = { client_id: clients.code, client_secret: 'ac-secret', grant_type: 'authorization_code', code, redirect_uri: 'https://other.example.test/cb' };

      const body = okJson(await grant('/_api/rest/v1/ghost/oauth', params));

      expect(body).toMatchObject({ access_token: token, token_type: 'Bearer', refresh_token: expect.stringMatching(/^000/) });
      expect(body.info).toMatchObject({ userid: infoUser === 'ghost' ? users.ghost : infoUser });
    });

    it.each([
      ['a password grant, whose lookup raises', { client_id: 'passwordOnDefault', grant_type: 'password', username: 'ghost-user', password: PASSWORD }, '/_api/rest/v1/default/oauth2'],
      ['a client_credentials login of a registered-site user', { client_id: 'ccSite', client_secret: 'cc-secret', grant_type: 'client_credentials' }, '/_api/rest/v1/default/oauth2'],
      ['the envelope of a registered site', { client_id: 'ccGhostOnDefault', client_secret: 'cc-secret', grant_type: 'client_credentials' }, '/_api/rest/v1/default/oauth'],
    ] as const)('answers %s with the unhandled-exception 500 legacy raises in REST mode', async (_label, params, path) => {
      expectError(await grant(path, { ...params, client_id: clients[params.client_id] }, DEFAULT), 500, BODY.unhandled);
    });

    it.each(
      (
        [
          ['another registered site', DEFAULT],
          ['a site identity does not register', GHOST],
          ['an unknown site', 'nosuchsite'],
        ] as const
      ).flatMap(([siteLabel, site]) => (['oauth', 'oauth2', 'content'] as const).map((resource) => [resource, siteLabel, site] as const)),
    )('refuses valid credentials of a tenant-a client on %s of %s as an unknown client (jsonApiUtility.cfc:558; beanORM.cfc:766-767)', async (resource, _siteLabel, site) => {
      const credentials =
        resource === 'content'
          ? { headers: basic(clients.basicOnSiteA, 'basic-secret') }
          : { params: { client_id: clients.ccOnSiteA, client_secret: 'cc-secret', grant_type: 'client_credentials' } };

      expectError(await call(`/_api/rest/v1/${site}/${resource}`, { siteId: site, ...credentials }), 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials);
    });

    it('finds a client on its own site named in upper case: the token on an unregistered site, the REST-mode 500 on a registered one', async () => {
      const params = { client_secret: 'cc-secret', grant_type: 'client_credentials' };

      okJson(await grant('/_api/rest/v1/GHOST/oauth2', { ...params, client_id: clients.ccGhost }, GHOST.toUpperCase()));
      expectError(await grant('/_api/rest/v1/TENANT-A/oauth', { ...params, client_id: clients.ccOnSiteA }, SITE_A.toUpperCase()), 500, BODY.unhandled);
    });

    it('logs a basic client`s user in on a non-oauth path and drops the client credentials', async () => {
      const outcome = continued(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: basic(clients.basicGhost, 'basic-secret'), params: { id: 'x' } }));

      expect(outcome.params).toEqual({ id: 'x' });
      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ userId: users.ghost });
    });

    it('continues anonymous for a basic client without a user', async () => {
      const outcome = continued(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: basic(clients.basicNoUser, 'basic-secret') }));

      expect(await sessionState(sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: '' });
    });

    it.each([
      ['a wrong secret', basic('basicGhost', 'nope'), 401, BODY.authorization, WWW_AUTHENTICATE.basic],
      ['a client that is not basic', basic('ccGhost', 'cc-secret'), 401, BODY.authorization, WWW_AUTHENTICATE.basic],
      ['client headers without Basic', { 'X-client-id': 'basicGhost', 'X-client-secret': 'basic-secret' }, 401, BODY.authorization, WWW_AUTHENTICATE.bearerInvalidClientCredentials],
      ['a user of a registered site, whose login raises', basic('basicSite', 'basic-secret'), 500, BODY.unhandled, undefined],
    ] as const)('answers %s on a non-oauth path', async (_label, headers, status, body, header) => {
      const named = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, nameClients(value)]));

      expectError(await call('/_api/rest/v1/ghost/content', { siteId: GHOST, headers: named }), status, body, header);
    });
  });

  describe('findOAuthUser', () => {
    it('finds an account or a group by id and nothing for an empty or unknown id', async () => {
      const group = await gated((tx) =>
        repo.insertGroup(
          tx,
          {
            groupname: 'Clients', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '', website: '',
            type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: SITE_A, subscribe: 1, notes: '',
            description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '', remoteid: '', tags: '', tablist: '',
          },
          null,
        ),
      );

      expect(await findOAuthUser(deps.oauth, users.ghost)).toEqual({ userId: users.ghost, siteId: GHOST });
      expect(await findOAuthUser(deps.oauth, group.userid)).toEqual({ userId: group.userid, siteId: SITE_A });
      expect(await findOAuthUser(deps.oauth, '')).toBeNull();
      expect(await findOAuthUser(deps.oauth, null)).toBeNull();
      expect(await findOAuthUser(deps.oauth, nextId('A'))).toBeNull();
    });
  });

  /** Replaces client keys of `clients` inside a header value (a Basic pair or a client id) with their seeded ids. */
  function nameClients(value: string): string {
    const decoded = value.startsWith('Basic ') ? Buffer.from(value.slice(6), 'base64').toString('utf8') : undefined;
    if (decoded === undefined) return clients[value as keyof typeof clients] ?? value;
    const [id = '', secret = ''] = decoded.split(':');
    return basic(clients[id as keyof typeof clients] ?? id, secret).authorization ?? value;
  }
});
