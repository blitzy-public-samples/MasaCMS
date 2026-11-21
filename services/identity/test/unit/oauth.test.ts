/** OAuth tokens and clients, the REST credential exchange and the cwebservice routes of identity, over the in-memory data layer. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  INVALID_ACCESS_TOKEN_HEADER_SEQUENCE,
  LEGACY_ERROR_MAP,
  LEGACY_JSON_CONTENT_TYPE,
  WWW_AUTHENTICATE,
  cfUuid,
  effectiveWwwAuthenticate,
  etag,
  generateCsrfToken,
  isCfUuid,
} from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, fixedClock, mintServiceToken, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { DEFAULT_LOGIN_SETTINGS, type LoginSettings } from '../../src/domain/login.js';
import {
  attachSessionData,
  deleteClient,
  effectiveGrantType,
  expiresAt,
  expiresIn,
  findToken,
  findTokenByAccessCode,
  generateToken,
  isExpired,
  isValidRedirectURI,
  listClients,
  loadClient,
  loadSiteClient,
  saveClient,
  tokenInfo,
  type OAuthDeps,
} from '../../src/domain/oauth.js';
import { sessionSnapshot, sessionState } from '../../src/domain/sessions.js';
import { parseLegacySessionJson, serializeLegacySessionJson, type AcfStruct } from '../../src/legacy/session-json.js';
import { registerAdminOAuthClientRoutes } from '../../src/routes/admin-oauth-clients.js';
import { authenticateRestRequest, type OAuthRouteDeps, type RestAuthInput, type RestAuthOutcome } from '../../src/routes/oauth.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { createMemoryIdentityRepo, createRecordingDb, type IdentitySeed, type MemoryIdentityRepo, type RecordingDb } from '../helpers/memory-repo.js';
import {
  ADMIN_S2,
  SITE_ADMIN_A,
  TEST_PASSWORDS,
  accountRow,
  actorSeed,
  credentialRow,
  groupRow,
  loginSnapshotFixture,
  loginStateRow,
  oauthClientRow,
  oauthTokenRow,
  personContactRow,
  sessionRow,
} from '../helpers/rows.js';

type ClientRow = ReturnType<typeof oauthClientRow>;
type TokenRow = ReturnType<typeof oauthTokenRow>;
type Site = { readonly siteId: string; readonly tenantId: string };

const NOW = new Date(2026, 5, 30, 12, 0, 0, 0);
const CLOCK = fixedClock(NOW);
const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A site no registry here holds, so no REST event of it builds the content renderer that raises on ACF 2023. */
const GHOST = 'ghost';
const CONTENT_PATH = '/_api/rest/v1/ghost/content';
const OAUTH_PATH = '/_api/rest/v1/ghost/oauth';
const OAUTH2_PATH = '/_api/rest/v1/ghost/oauth2';
const TOKEN_INFO_PATH = '/_api/rest/v1/ghost/oauth2/tokeninfo';
const REGISTRY_SQL = /FROM identity\.tenant_registry\b/;
const FAST_LOGIN: LoginSettings = { ...DEFAULT_LOGIN_SETTINGS, password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 } };
const GENERATED_TOKEN = /^000[0-9A-F]{64}$/;
const GENERATED_SECRET = /^[0-9A-F]{64}$/;
const INVALID_TOKEN_ID = "The property named 'token' is not valid";
const HIDDEN_INFO_KEYS = ['csrfsecretkey', 'csrfusedtokens', 'isloggedin', 'lastlogin', 'password'];
const ACF_SESSION_KEYS = ['MURA', 'blockLoginUntil', 'SITEID', 'rememberMe', 'loginAttempts'];

/** A 35-character CF id numbered `n` under the hex digit `prefix`, so ids of one prefix sort by `n`. */
function cfId(prefix: string, n: number): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** `NOW` moved by `ms`. */
function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

const REST_USER = accountRow({ siteid: GHOST, username: 'rest_user' });
const REST_ACCOUNT_SEED: IdentitySeed = {
  accounts: [REST_USER],
  credentials: [credentialRow({ userid: REST_USER.userid, plainPassword: TEST_PASSWORDS.default })],
  loginStates: [loginStateRow({ userid: REST_USER.userid })],
  personContacts: [personContactRow({ user_id: REST_USER.userid, site_id: GHOST, fname: 'Rest', lname: 'User' })],
};

const CC_CLIENT = oauthClientRow({ clientid: cfId('C', 1), clientsecret: 'cc-secret', userid: REST_USER.userid });
const BASIC_CLIENT = oauthClientRow({ clientid: cfId('C', 2), granttype: 'basic', clientsecret: 'basic-secret', userid: REST_USER.userid });
const CODE_CLIENT = oauthClientRow({
  clientid: cfId('C', 3),
  granttype: 'authorization_code',
  clientsecret: 'ac-secret',
  userid: REST_USER.userid,
  redirecturl: 'https://ok.example.test/cb',
});
const PASSWORD_CLIENT = oauthClientRow({ clientid: cfId('C', 4), granttype: 'password', clientsecret: 'pw-secret', userid: REST_USER.userid });

const STORED_USER = cfId('7', 1);
const STORED_SECRET = cfUuid();
/** `session.mura` of a stored login, as `serializeJSON(getSession())` wrote it. */
const STORED_MURA: AcfStruct = {
  subtype: 'Default',
  passwordcreated: '',
  membershipids: '',
  lname: 'Editor',
  isloggedin: true,
  siteid: 'default',
  email: 'qa_editor@example.test',
  csrfusedtokens: {},
  fname: 'QA',
  company: '',
  remoteid: '',
  password: '',
  csrfsecretkey: STORED_SECRET,
  userid: STORED_USER,
  username: 'qa_editor',
  memberships: 'S2IsPrivate;default',
  lastlogin: '',
};
const STORED_SESSION = serializeLegacySessionJson({ mura: STORED_MURA, blockLoginUntil: '', siteid: 'default', rememberMe: '0', loginAttempts: '0' });

/** A stored token of `client` for the REST user, expiring an hour after `NOW` unless `overrides` say otherwise. */
function tokenOf(token: string, client: ClientRow, overrides: Partial<TokenRow> = {}): TokenRow {
  return oauthTokenRow({ token, clientid: client.clientid, userid: REST_USER.userid, expires: at(HOUR_MS), ...overrides });
}

const T_JSON = tokenOf('T-JSON', PASSWORD_CLIENT, { granttype: 'password', userid: STORED_USER, data: STORED_SESSION });
const T_RAW = tokenOf('T-RAW', PASSWORD_CLIENT, { granttype: 'password' });
const T_NOT_JSON = tokenOf('T-NOT-JSON', PASSWORD_CLIENT, { granttype: 'password', data: '{"MURA":' });
const T_EXPIRED = tokenOf('T-EXPIRED', CC_CLIENT, { expires: at(-HOUR_MS) });
const RT_VALID = tokenOf('RT-VALID', CC_CLIENT, { granttype: 'refresh_token', expires: at(DAY_MS) });
const RT_EXPIRED = tokenOf('RT-EXPIRED', CC_CLIENT, { granttype: 'refresh_token', expires: at(-HOUR_MS) });
/** The refresh token a REST grant of {@link CC_CLIENT} reuses, stored in the REST site's tenant with the client. */
const RT_REUSABLE = tokenOf('RT-REUSABLE', CC_CLIENT, { tenant_id: tenantIdForSite(GHOST), granttype: 'refresh_token', expires: at(DAY_MS) });

/** `client` as a client of the REST site, stored in that site's tenant, the only one its token endpoint reads. */
function restSiteClient(client: ClientRow): ClientRow {
  return { ...client, tenant_id: tenantIdForSite(GHOST), siteid: GHOST };
}

const REST_SEED: IdentitySeed = {
  ...REST_ACCOUNT_SEED,
  oauthClients: [CC_CLIENT, BASIC_CLIENT, CODE_CLIENT, PASSWORD_CLIENT].map(restSiteClient),
  oauthTokens: [T_JSON, T_RAW, T_NOT_JSON, T_EXPIRED, RT_VALID, RT_EXPIRED, RT_REUSABLE],
};

/** The `tenant_registry` row of a site whose every pool is the site itself. */
function registryRow({ siteId, tenantId }: Site): Record<string, unknown> {
  const pools = ['public_user_pool', 'private_user_pool', 'category_pool', 'file_pool', 'display_pool'].flatMap((pool) => [
    [`${pool}_id`, siteId],
    [`${pool}_tenant`, tenantId],
  ]);
  return {
    site_id: siteId,
    tenant_id: tenantId,
    ...Object.fromEntries(pools),
    content_pool_ids: [siteId],
    content_pool_tenants: [tenantId],
    domains: [],
    aggregate_version: '1',
    updated_at: NOW,
  };
}

/** Answers the platform registry reads from the rows of `sites`, filtered by the site or tenant a WHERE clause names. */
function registryOf(sites: readonly Site[]): (sql: string, values: readonly unknown[]) => Record<string, unknown>[] {
  const rows = sites.map(registryRow).sort((a, b) => String(a.site_id).localeCompare(String(b.site_id), 'en'));
  return (sql, values) => {
    const wanted = String(values[0] ?? '');
    if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) return rows.filter((row) => String(row.site_id).toLowerCase() === wanted.toLowerCase());
    if (/WHERE tenant_id = \$1/.test(sql)) return rows.filter((row) => row.tenant_id === wanted);
    return rows.map((row) => ({ ...row }));
  };
}

interface Harness {
  db: RecordingDb;
  repo: MemoryIdentityRepo;
  deps: OAuthRouteDeps;
}

/** A recording database whose registry holds `sites` (tenant-a by default) and a memory repository of `seed`, behind every OAuth, login and session dependency. */
function harness(seed: IdentitySeed, opts: { clock?: Clock; sites?: readonly Site[] } = {}): Harness {
  const clock = opts.clock ?? CLOCK;
  const db = createRecordingDb();
  db.respond(REGISTRY_SQL, registryOf(opts.sites ?? [TENANT_A]));
  const repo = createMemoryIdentityRepo(seed, { clock });
  const oauth: OAuthDeps = { db, repo, clock };
  return { db, repo, deps: { oauth, login: { db, repo, clock, settings: FAST_LOGIN }, sessions: { db, repo, clock } } };
}

/** Stored tokens of `tenantId` (tenant-a by default), by token. */
function storedTokens(h: Harness, tenantId: string = TENANT_A.tenantId): string[] {
  return h.repo
    .rows('oauth_token', tenantId)
    .map((row) => row.token)
    .sort();
}

/** Mutations of the OAuth tables since the repository was created or cleared. */
function oauthWrites(repo: MemoryIdentityRepo): ReturnType<MemoryIdentityRepo['writes']> {
  return repo.writes().filter((write) => write.table === 'oauth_client' || write.table === 'oauth_token');
}

describe('OAuth token domain (oauthClientBean.cfc:24-93, oauthTokenBean.cfc:27-57)', () => {
  it('returns the unexpired token of the same client, grant type and user unchanged (oauthClientBean.cfc:31-40)', async () => {
    const stored = tokenOf('T-REUSE', CC_CLIENT);
    const h = harness({ oauthClients: [CC_CLIENT], oauthTokens: [stored] });

    const token = await generateToken(h.deps.oauth, CC_CLIENT);

    expect(token).toEqual({ ...stored, errors: {} });
    expect(oauthWrites(h.repo)).toEqual([]);
  });

  it('creates a new token for another user of the same client and grant', async () => {
    const h = harness({ oauthClients: [CC_CLIENT], oauthTokens: [tokenOf('T-REUSE', CC_CLIENT)] });

    const token = await generateToken(h.deps.oauth, CC_CLIENT, { userId: cfId('A', 9) });

    expect(token.token).toMatch(GENERATED_TOKEN);
    expect(token.userid).toBe(cfId('A', 9));
  });

  it('creates a new hour-long token once the stored one expired, its SHA-256 id failing the 35-character id rule so nothing is stored', async () => {
    const stored = tokenOf('T-REUSE', CC_CLIENT);
    const later = fixedClock(stored.expires.getTime() + SECOND_MS);
    const h = harness({ oauthClients: [CC_CLIENT], oauthTokens: [stored] }, { clock: later });

    const token = await generateToken(h.deps.oauth, CC_CLIENT);

    expect(token.token).not.toBe(stored.token);
    expect(token.token).toMatch(GENERATED_TOKEN);
    expect(isCfUuid(token.token)).toBe(false);
    expect(token).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      granttype: 'client_credentials',
      clientid: CC_CLIENT.clientid,
      userid: REST_USER.userid,
      accesscode: null,
      data: null,
      expires: new Date(later.now().getTime() + HOUR_MS),
    });
    expect(token.errors).toEqual({ token: INVALID_TOKEN_ID });
    expect(storedTokens(h)).toEqual(['T-REUSE']);
  });

  it.each([
    ['client_credentials', ['T-HOUR-OLD', 'T-OTHER-CLIENT']],
    ['authorization_code', ['T-HOUR-OLD', 'T-OTHER-CLIENT']],
    ['password', ['T-DAY-OLD', 'T-HOUR-OLD', 'T-OTHER-CLIENT']],
    ['refresh_token', ['T-DAY-OLD', 'T-HOUR-OLD', 'T-OTHER-CLIENT']],
  ])('after a %s token leaves the client tokens %j: only short-lived grants purge those expired over a day ago (oauthClientBean.cfc:55-64)', async (grantType, kept) => {
    const h = harness({
      oauthClients: [CC_CLIENT, BASIC_CLIENT],
      oauthTokens: [
        tokenOf('T-DAY-OLD', CC_CLIENT, { granttype: grantType, expires: at(-2 * DAY_MS) }),
        tokenOf('T-HOUR-OLD', CC_CLIENT, { granttype: grantType, expires: at(-HOUR_MS) }),
        tokenOf('T-OTHER-CLIENT', BASIC_CLIENT, { granttype: grantType, expires: at(-2 * DAY_MS) }),
      ],
    });

    await generateToken(h.deps.oauth, CC_CLIENT, { grantType });

    expect(storedTokens(h)).toEqual(kept);
  });

  it.each([
    ['authorization_code', at(HOUR_MS)],
    ['AUTHORIZATION_CODE', new Date(2126, 5, 30, 12, 0, 0, 0)],
  ])('gives a %s token a CF-format access code, the lifetime following the case-sensitive listFind (oauthClientBean.cfc:49-58)', async (grantType, expires) => {
    const h = harness({ oauthClients: [CODE_CLIENT] });

    const token = await generateToken(h.deps.oauth, CODE_CLIENT, { grantType });

    expect(isCfUuid(token.accesscode ?? '')).toBe(true);
    expect(token.expires).toEqual(expires);
  });

  it('gives a password token a hundred-year lifetime and no access code', async () => {
    const h = harness({ oauthClients: [PASSWORD_CLIENT] });

    const token = await generateToken(h.deps.oauth, PASSWORD_CLIENT, { grantType: 'password' });

    expect(token).toMatchObject({ accesscode: null, expires: new Date(2126, 5, 30, 12, 0, 0, 0) });
  });

  it('finds a stored token by access code, only of the client named when one is (jsonApiUtility.cfc:601)', async () => {
    const coded = tokenOf('T-CODE', CODE_CLIENT, { granttype: 'authorization_code', accesscode: cfUuid() });
    const code = coded.accesscode ?? '';
    const { deps } = harness({ oauthClients: [CODE_CLIENT], oauthTokens: [coded] });

    expect(await findTokenByAccessCode(deps.oauth, code)).toEqual({ ...coded, errors: {} });
    expect(await findTokenByAccessCode(deps.oauth, code, CODE_CLIENT.clientid)).toEqual({ ...coded, errors: {} });
    expect(await findTokenByAccessCode(deps.oauth, code, CC_CLIENT.clientid)).toBeNull();
    expect(await findTokenByAccessCode(deps.oauth, cfUuid())).toBeNull();
    expect(await findTokenByAccessCode(deps.oauth, '')).toBeNull();
  });

  it('finds a stored token in any registered tenant, of a grant type compared as SQL Server compares it (jsonApiUtility.cfc:488,750)', async () => {
    const { deps } = harness({ oauthTokens: [RT_VALID] });

    expect(await findToken(deps.oauth, { token: 'RT-VALID' })).toEqual({ ...RT_VALID, errors: {} });
    expect(await findToken(deps.oauth, { token: 'RT-VALID', grantType: 'REFRESH_TOKEN' })).toEqual({ ...RT_VALID, errors: {} });
    expect(await findToken(deps.oauth, { token: 'RT-VALID', grantType: 'client_credentials' })).toBeNull();
    expect(await findToken(deps.oauth, { token: 'RT-VALID', grantType: '' })).toBeNull();
    expect(await findToken(deps.oauth, { token: '' })).toBeNull();
    expect(await findToken(deps.oauth, { token: 'NOPE' })).toBeNull();
  });

  it('finds no token of a tenant the registry does not hold', async () => {
    const { deps } = harness({ oauthTokens: [{ ...RT_VALID, tenant_id: TENANT_B.tenantId }] });

    expect(await findToken(deps.oauth, { token: 'RT-VALID' })).toBeNull();
  });

  it('stores session JSON byte-exact on a stored token, and an empty one as NULL (jsonApiUtility.cfc:518-519)', async () => {
    const h = harness({ oauthTokens: [T_RAW] });
    const stored = await findToken(h.deps.oauth, { token: 'T-RAW' });
    if (stored === null) throw new Error('T-RAW is not stored');

    const attached = await attachSessionData(h.deps.oauth, stored, STORED_SESSION);
    expect(attached).toMatchObject({ token: 'T-RAW', data: STORED_SESSION, errors: {} });
    expect(h.repo.rows('oauth_token')[0]?.data).toBe(STORED_SESSION);

    const emptied = await attachSessionData(h.deps.oauth, attached, '');
    expect(emptied.data).toBeNull();
    expect(h.repo.rows('oauth_token')[0]?.data).toBeNull();
  });

  it('inserts a valid token that is not stored yet together with its data', async () => {
    const h = harness({});

    const attached = await attachSessionData(h.deps.oauth, { ...tokenOf('T-NEW', CC_CLIENT), errors: {} }, STORED_SESSION);

    expect(attached.errors).toEqual({});
    expect(h.repo.rows('oauth_token')).toEqual([expect.objectContaining({ token: 'T-NEW', data: STORED_SESSION })]);
  });

  it('keeps the data of a generated token unsaved, as its id fails validation', async () => {
    const h = harness({ oauthClients: [CC_CLIENT] });
    const generated = await generateToken(h.deps.oauth, CC_CLIENT);

    const attached = await attachSessionData(h.deps.oauth, generated, STORED_SESSION);

    expect(attached).toMatchObject({ token: generated.token, data: STORED_SESSION, errors: { token: INVALID_TOKEN_ID } });
    expect(h.repo.rows('oauth_token')).toEqual([]);
  });

  it.each([
    [HOUR_MS, 3600, false],
    [1_500, 1, false],
    [999, 0, true],
    [0, 0, true],
    [-61 * SECOND_MS, -61, true],
  ])('reads a token expiring %d ms after now as expiring in %d s, expired %s (oauthTokenBean.cfc:27-37)', (offsetMs, seconds, expired) => {
    const token = { expires: at(offsetMs) };

    expect(expiresIn(token, CLOCK)).toBe(seconds);
    expect(isExpired(token, CLOCK)).toBe(expired);
  });

  it('counts expiry seconds from the local epoch (utility.cfc:1564-1577)', () => {
    expect(expiresAt({ expires: new Date(1970, 0, 1, 0, 0, 30) })).toBe(30);
  });

  it('answers token info with the stored mura struct minus its secret and login-state keys (oauthTokenBean.cfc:39-57)', () => {
    const info = tokenInfo({ data: STORED_SESSION });

    expect(info).toEqual({
      SUBTYPE: 'Default',
      PASSWORDCREATED: '',
      MEMBERSHIPIDS: '',
      LNAME: 'Editor',
      SITEID: 'default',
      EMAIL: 'qa_editor@example.test',
      FNAME: 'QA',
      COMPANY: '',
      REMOTEID: '',
      USERID: STORED_USER,
      USERNAME: 'qa_editor',
      MEMBERSHIPS: 'S2IsPrivate;default',
    });
  });

  it.each([
    ['NULL data', null],
    ['text that is not JSON', '{"MURA":'],
    ['JSON that is no struct', '[1]'],
    ['a struct without mura', '{"SITEID":"default"}'],
  ])('answers token info of %s with {}', (_label, data) => {
    expect(tokenInfo({ data })).toEqual({});
  });

  it.each([
    [null, 'client_credentials'],
    ['', 'client_credentials'],
    ['basic', 'basic'],
    ['password', 'password'],
  ])('reads stored grant type %j as %s (oauthClientBean.cfc:73-79)', (granttype, expected) => {
    expect(effectiveGrantType({ granttype })).toBe(expected);
  });

  it.each([
    [null, 'https://any.example.test/', true],
    ['', 'https://any.example.test/', true],
    ['https://a.example.test/cb\r\nhttps://b.example.test/cb', 'https://b.example.test/cb', true],
    ['https://a.example.test/cb\r\nhttps://b.example.test/cb', 'https://c.example.test/cb', false],
    ['https://a.example.test/cb|https://b.example.test/cb', 'https://b.example.test/cb', true],
    ['https://a.example.test/cb\r\nhttps://b.example.test/cb\r\nhttps://c.example.test/cb', 'https://c.example.test/cb', false],
    ['https://a.example.test/cb', 'HTTPS://A.EXAMPLE.TEST/CB', true],
  ])('with stored redirects %j accepts %j: %s; only the first CRLF splits and items compare by CFML == (oauthClientBean.cfc:81-93)', (redirecturl, uri, expected) => {
    expect(isValidRedirectURI({ redirecturl }, uri)).toBe(expected);
  });
});

describe('OAuth client domain (cwebservice.cfc:100-124, beanORM.cfc)', () => {
  const ACTOR = { fname: 'Site', lname: 'Admin' };
  const NEW_ID = cfId('D', 1);

  it('lists a page of the site`s clients by clientid with their total, and none for an empty site (list.cfm:78)', async () => {
    const clients = [3, 1, 2].map((n) => oauthClientRow({ clientid: cfId('D', n) }));
    const elsewhere = oauthClientRow({ clientid: cfId('D', 4), siteid: 'other-site' });
    const { deps } = harness({ oauthClients: [...clients, elsewhere] });

    const page = await listClients(deps.oauth, TENANT_A.siteId, { offset: 1, limit: 1 });

    expect(page.total).toBe(3);
    expect(page.items.map((client) => client.clientid)).toEqual([cfId('D', 2)]);
    expect(await listClients(deps.oauth, '', { offset: 0, limit: 10 })).toEqual({ items: [], total: 0 });
  });

  it('loads a client from the requested site`s tenant first, then from any registered tenant (beanORM.cfc:750-925)', async () => {
    const inA = oauthClientRow({ clientid: cfId('D', 1) });
    const inB = oauthClientRow({ clientid: cfId('D', 2), tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId });
    const { deps } = harness({ oauthClients: [inA, inB] });

    expect(await loadClient(deps.oauth, inA.clientid)).toEqual(inA);
    expect(await loadClient(deps.oauth, inB.clientid)).toBeNull();
    expect(await loadClient(deps.oauth, inB.clientid, TENANT_B.siteId)).toEqual(inB);
    expect(await loadClient(deps.oauth, '')).toBeNull();
  });

  it('loads a client of the API site from that site`s tenant alone, in any case of the site id, and unscoped for an empty site (jsonApiUtility.cfc:558; beanORM.cfc:766-767)', async () => {
    const inA = oauthClientRow({ clientid: cfId('D', 1) });
    const inB = oauthClientRow({ clientid: cfId('D', 2), tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId });
    const { db, deps } = harness({ oauthClients: [inA, inB] });

    expect(await loadSiteClient(deps.oauth, inA.clientid, TENANT_A.siteId)).toEqual(inA);
    expect(await loadSiteClient(deps.oauth, inA.clientid, TENANT_A.siteId.toUpperCase())).toEqual(inA);
    expect(await loadSiteClient(deps.oauth, inB.clientid, TENANT_B.siteId)).toEqual(inB);
    expect(await loadSiteClient(deps.oauth, inB.clientid, TENANT_A.siteId)).toBeNull();
    expect(await loadSiteClient(deps.oauth, inA.clientid, TENANT_B.siteId)).toBeNull();
    expect(await loadSiteClient(deps.oauth, inA.clientid, GHOST)).toBeNull();
    expect(await loadSiteClient(deps.oauth, '', TENANT_A.siteId)).toBeNull();
    expect(db.statements().filter((statement) => REGISTRY_SQL.test(statement.sql))).toEqual([]);
    expect(await loadSiteClient(deps.oauth, inA.clientid, '')).toEqual(inA);
    expect(await loadSiteClient(deps.oauth, inB.clientid, '')).toBeNull();
    expect(db.statements().some((statement) => REGISTRY_SQL.test(statement.sql))).toBe(true);
  });

  it('saves a new client with a generated secret, the init dates and the actor as last updater (oauthClientBean.cfc:16-22)', async () => {
    const h = harness({});

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_A.siteId, clientid: NEW_ID, name: 'Feed reader', granttype: 'client_credentials', description: 'Nightly' }, ACTOR);

    expect(saved.errors).toEqual({});
    expect(saved.stored).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      clientid: NEW_ID,
      siteid: TENANT_A.siteId,
      name: 'Feed reader',
      granttype: 'client_credentials',
      description: 'Nightly',
      redirecturl: null,
      userid: null,
      created: NOW,
      lastupdate: NOW,
      lastupdateby: 'Site Admin',
    });
    expect(saved.client.clientsecret).toMatch(GENERATED_SECRET);
    expect(saved.client).toMatchObject({ redirecturl: '', userid: '' });
    expect(h.repo.rows('oauth_client', TENANT_A.tenantId)).toEqual([saved.stored]);
  });

  it('defaults an absent grant type to basic and an anonymous actor to an empty last updater (cwebservice.cfc:90-96)', async () => {
    const h = harness({});

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_A.siteId, clientid: NEW_ID, name: 'Feed reader' }, null);

    expect(saved.stored).toMatchObject({ granttype: 'basic', lastupdateby: null });
    expect(saved.client.lastupdateby).toBe('');
  });

  it.each([
    ['an empty name', { clientid: NEW_ID, name: '' }, { name: "The property named 'name' is not valid" }],
    [
      'no clientid',
      { name: 'Feed reader' },
      { clientid: "The property named 'clientid' is not valid", primarykey: "The primary key 'clientid' is required." },
    ],
  ])('keeps a client with %s unsaved, returning its errors and the generated secret (beanValidator.cfc:183-260)', async (_label, fields, errors) => {
    const h = harness({});

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_A.siteId, ...fields }, ACTOR);

    expect(saved.errors).toEqual(errors);
    expect(saved.stored).toBeNull();
    expect(saved.client.clientsecret).toMatch(GENERATED_SECRET);
    expect(oauthWrites(h.repo)).toEqual([]);
  });

  it('updates a stored client in place, keeping its creation date and a posted secret', async () => {
    const stored = oauthClientRow({ clientid: cfId('D', 5), clientsecret: 'kept-secret', created: at(-DAY_MS), lastupdate: at(-DAY_MS) });
    const later = fixedClock(at(HOUR_MS));
    const h = harness({ oauthClients: [stored] }, { clock: later });

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_A.siteId, clientid: stored.clientid, clientsecret: 'kept-secret', name: 'Renamed' }, ACTOR);

    expect(saved.stored).toMatchObject({ clientsecret: 'kept-secret', name: 'Renamed', created: at(-DAY_MS), lastupdate: at(HOUR_MS) });
    expect(h.repo.rows('oauth_client')).toHaveLength(1);
  });

  it('replaces the secret of a stored client saved without one, as the empty rc default overwrites it', async () => {
    const stored = oauthClientRow({ clientid: cfId('D', 5), clientsecret: 'old-secret' });
    const h = harness({ oauthClients: [stored] });

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_A.siteId, clientid: stored.clientid, name: stored.name }, ACTOR);

    expect(saved.stored?.clientsecret).toMatch(GENERATED_SECRET);
  });

  it('moves a re-sited client to its new site`s tenant, dropping it and its tokens from the old one', async () => {
    const stored = oauthClientRow({ clientid: cfId('D', 6) });
    const h = harness({ oauthClients: [stored], oauthTokens: [tokenOf('T-MOVED', stored)] });

    const saved = await saveClient(h.deps.oauth, { siteid: TENANT_B.siteId, clientid: stored.clientid, clientsecret: 'moved', name: 'Moved' }, ACTOR);

    expect(saved.stored).toMatchObject({ tenant_id: TENANT_B.tenantId, siteid: TENANT_B.siteId });
    expect(h.repo.rows('oauth_client', TENANT_A.tenantId)).toEqual([]);
    expect(storedTokens(h)).toEqual([]);
  });

  it('deletes a client with its tokens and leaves other clients` tokens (beanORM.cfc:698-747)', async () => {
    const doomed = oauthClientRow({ clientid: cfId('D', 7) });
    const h = harness({ oauthClients: [doomed, CC_CLIENT], oauthTokens: [tokenOf('T-DOOMED-1', doomed), tokenOf('T-DOOMED-2', doomed), tokenOf('T-KEPT', CC_CLIENT)] });

    expect(await deleteClient(h.deps.oauth, doomed.clientid)).toBe(true);

    expect(h.repo.rows('oauth_client').map((client) => client.clientid)).toEqual([CC_CLIENT.clientid]);
    expect(storedTokens(h)).toEqual(['T-KEPT']);
    expect(await deleteClient(h.deps.oauth, doomed.clientid)).toBe(false);
  });
});

/** A REST request on `path` for the ghost site; `query` is merged into the params as legacy merges url and form. */
function rest(path: string, opts: { headers?: Record<string, string>; query?: Record<string, string>; params?: Record<string, unknown> } = {}): RestAuthInput {
  const query = opts.query ?? {};
  return { path, httpMethod: 'POST', headers: opts.headers ?? {}, query, params: { ...query, ...opts.params }, siteId: GHOST };
}

/** `Authorization: Basic` of `id:secret`. */
function basic(id: string, secret: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
}

/** The response outcome of `outcome`; fails on a session outcome. */
function answer(outcome: RestAuthOutcome): Extract<RestAuthOutcome, { kind: 'response' }> {
  if (outcome.kind !== 'response') throw new Error(`expected a response outcome, got session ${outcome.sessionId}`);
  return outcome;
}

/** The session outcome of `outcome`; fails on a response outcome. */
function continued(outcome: RestAuthOutcome): Extract<RestAuthOutcome, { kind: 'session' }> {
  if (outcome.kind !== 'session') throw new Error(`expected a session outcome, got ${String(outcome.status)} ${outcome.body}`);
  return outcome;
}

/** The legacy error envelope of `type`, as the catch block of jsonApiUtility.cfc:1318-1402 serializes it for an undefined method. */
function legacyErrorBody(type: keyof typeof LEGACY_ERROR_MAP): string {
  const { message, code } = LEGACY_ERROR_MAP[type];
  return JSON.stringify({ apiversion: 'v1', method: 'invalid', error: { message, code } });
}

/** Asserts the legacy error answer of `type`: its status, exact body and ETag, and the `WWW-Authenticate` legacy left. */
function expectLegacyError(outcome: RestAuthOutcome, type: keyof typeof LEGACY_ERROR_MAP, wwwAuthenticate: string): void {
  const res = answer(outcome);
  const body = legacyErrorBody(type);
  expect(res.status).toBe(LEGACY_ERROR_MAP[type].status);
  expect(res.body).toBe(body);
  expect(res.headers['Content-Type']).toBe(LEGACY_JSON_CONTENT_TYPE);
  expect(res.headers.ETag).toBe(etag(body));
  expect(res.headers['WWW-Authenticate']).toBe(wwwAuthenticate);
}

/** The parsed body of a 200 token answer, checked for the legacy content type, its ETag and no `WWW-Authenticate`. */
function tokenAnswer(outcome: RestAuthOutcome): Record<string, unknown> {
  const res = answer(outcome);
  expect(res.status, res.body).toBe(200);
  expect(res.headers['Content-Type']).toBe(LEGACY_JSON_CONTENT_TYPE);
  expect(res.headers.ETag).toBe(etag(res.body));
  expect(res.headers['WWW-Authenticate']).toBeUndefined();
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('legacy error map of the REST credential refusals (jsonApiUtility.cfc:1318-1340,1390-1400)', () => {
  it.each([
    ['authorization', 401, 'invalid_request', 'Insufficient Account Permissions'],
    ['invalidAccessToken', 401, 'invalid_token', 'Invalid Access Token'],
    ['accessTokenExpired', 401, 'invalid_token', 'Access Token Expired'],
    ['server_error', 500, 'server_error', 'Unhandled Exception'],
  ] as const)('maps %s to %d %s "%s"', (type, status, code, message) => {
    expect(LEGACY_ERROR_MAP[type]).toEqual({ status, code, message });
  });

  it('keeps the second of the two headers legacy sets for an unusable access token (jsonApiUtility.cfc:495-496)', () => {
    expect(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE).toEqual(['Bearer error="invalid_access_token"', 'Bearer']);
    expect(effectiveWwwAuthenticate(INVALID_ACCESS_TOKEN_HEADER_SEQUENCE)).toBe(WWW_AUTHENTICATE.bearer);
  });
});

describe('authenticateRestRequest (jsonApiUtility.cfc:422-835)', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness(REST_SEED);
  });

  /** Runs legacy's REST credential block for `input` over the suite's harness. */
  function restCall(input: RestAuthInput): Promise<RestAuthOutcome> {
    return authenticateRestRequest(h.deps, input);
  }

  type Refusal = readonly [label: string, input: () => RestAuthInput, type: keyof typeof LEGACY_ERROR_MAP, literal: string, constant: string];

  const REFUSALS: readonly Refusal[] = [
    ['Basic user credentials with a wrong password: 401 with Basic (479-480)', () => rest(CONTENT_PATH, { headers: basic('rest_user', 'wrong') }), 'authorization', 'Basic', WWW_AUTHENTICATE.basic],
    ['an unknown access_token: 401 with the Bearer the second setHeader leaves (495-497)', () => rest(CONTENT_PATH, { headers: { Authorization: 'Bearer NOPE' } }), 'invalidAccessToken', 'Bearer', WWW_AUTHENTICATE.bearer],
    ['an access_token of a grant type the access list omits: 401 with Bearer (493-497)', () => rest(CONTENT_PATH, { headers: { Authorization: 'Bearer RT-VALID' } }), 'invalidAccessToken', 'Bearer', WWW_AUTHENTICATE.bearer],
    ['an expired access_token: 401 with invalid_access_token (499-501)', () => rest(CONTENT_PATH, { params: { access_token: 'T-EXPIRED' } }), 'accessTokenExpired', 'Bearer error="invalid_access_token"', WWW_AUTHENTICATE.bearerInvalidAccessToken],
    ['no access_token, client_id or refresh_token on an oauth path: 401 with invalid_client_credentials (551)', () => rest(OAUTH_PATH, { params: { client_secret: 'x' } }), 'authorization', 'Bearer error="invalid_client_credentials"', WWW_AUTHENTICATE.bearerInvalidClientCredentials],
    ['no access_token, client_id or refresh_token on another path: 401 with Basic (553)', () => rest(CONTENT_PATH), 'authorization', 'Basic', WWW_AUTHENTICATE.basic],
    ['an unknown client_id: 401 with invalid_client_credentials (565-566)', () => rest(OAUTH2_PATH, { params: { client_id: cfId('C', 99), grant_type: 'client_credentials' } }), 'authorization', 'Bearer error="invalid_client_credentials"', WWW_AUTHENTICATE.bearerInvalidClientCredentials],
    [
      'an authorization_code grant with an unknown code: 401 with invalid_authorization_code (591-629)',
      () => rest(OAUTH2_PATH, { params: { client_id: CODE_CLIENT.clientid, client_secret: 'ac-secret', grant_type: 'authorization_code', code: 'NOPE', redirect_uri: 'https://ok.example.test/cb' } }),
      'authorization',
      'Bearer error="invalid_authorization_code"',
      WWW_AUTHENTICATE.bearerInvalidAuthorizationCode,
    ],
    [
      'a password grant with bad user credentials: 401 with invalid_client_credentials (630-686)',
      () => rest(OAUTH2_PATH, { params: { client_id: PASSWORD_CLIENT.clientid, grant_type: 'password', username: 'rest_user', password: 'wrong' } }),
      'authorization',
      'Bearer error="invalid_client_credentials"',
      WWW_AUTHENTICATE.bearerInvalidClientCredentials,
    ],
    ['a refresh_token grant without refresh_token: 401 with invalid_client_refresh_token (746-747)', () => rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, grant_type: 'refresh_token' } }), 'authorization', 'Bearer error="invalid_client_refresh_token"', WWW_AUTHENTICATE.bearerInvalidClientRefreshToken],
    [
      'a refresh_token grant with an unknown refresh_token: the unhandled-exception 500 of the uncaught invalid_token (754-762)',
      () => rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, grant_type: 'refresh_token', refresh_token: 'NOPE' } }),
      'server_error',
      'Bearer error="invalid_client_credentials"',
      WWW_AUTHENTICATE.bearerInvalidClientCredentials,
    ],
    ['any other grant_type: 401 with the unclosed invalid_grant_type quote (805-806)', () => rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, grant_type: 'implicit' } }), 'authorization', 'Bearer error="invalid_grant_type', WWW_AUTHENTICATE.bearerInvalidGrantType],
    ['Basic client credentials with a wrong secret: 401 with Basic (829-830)', () => rest(CONTENT_PATH, { headers: basic(BASIC_CLIENT.clientid, 'wrong') }), 'authorization', 'Basic', WWW_AUTHENTICATE.basic],
    ['Basic credentials of a client whose grant is not basic: 401 with Basic (829-830)', () => rest(CONTENT_PATH, { headers: basic(CC_CLIENT.clientid, 'cc-secret') }), 'authorization', 'Basic', WWW_AUTHENTICATE.basic],
    [
      'a client id and secret on a non-oauth path without Basic: 401 with invalid_client_credentials (812-819)',
      () => rest(CONTENT_PATH, { params: { client_id: BASIC_CLIENT.clientid, client_secret: 'basic-secret' } }),
      'authorization',
      'Bearer error="invalid_client_credentials"',
      WWW_AUTHENTICATE.bearerInvalidClientCredentials,
    ],
  ];

  it.each(REFUSALS)('refuses %s', async (_label, input, type, literal, constant) => {
    expect(constant).toBe(literal);

    expectLegacyError(await restCall(input()), type, literal);
  });

  it('logs a fresh request session in as the account of Basic user credentials and drops them from the params (471-477)', async () => {
    const outcome = continued(await restCall(rest(CONTENT_PATH, { headers: basic('rest_user', TEST_PASSWORDS.default), params: { fields: 'title' } })));

    expect(isCfUuid(outcome.sessionId)).toBe(true);
    expect(outcome).toMatchObject({ siteId: GHOST, params: { fields: 'title' } });
    expect(Object.keys(outcome.params)).toEqual(['fields']);
    expect(await sessionState(h.deps.sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: REST_USER.userid, siteId: GHOST });
  });

  it('continues in the session a token`s stored JSON restores, its CSRF secret included (503-504)', async () => {
    const outcome = continued(await restCall(rest(CONTENT_PATH, { headers: { Authorization: 'Bearer T-JSON' } })));

    expect(outcome.params).toEqual({});
    expect(await sessionState(h.deps.sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: STORED_USER });
    expect((await sessionSnapshot(h.deps.sessions, outcome.sessionId))?.csrfSecret).toBe(STORED_SECRET);
  });

  it.each([
    ['no data', T_RAW.token],
    ['data that is not JSON', T_NOT_JSON.token],
  ])('logs the client account in for a token with %s and stores the request session as its byte-exact JSON (518-521)', async (_label, token) => {
    const outcome = continued(await restCall(rest(CONTENT_PATH, { headers: { Authorization: `Bearer ${token}` } })));

    expect(await sessionState(h.deps.sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: REST_USER.userid });
    const data = h.repo.rows('oauth_token').find((row) => row.token === token)?.data ?? null;
    const stored = parseLegacySessionJson(data);
    if (data === null || stored === undefined) throw new Error(`${token} holds no session JSON`);
    expect(serializeLegacySessionJson(stored.session)).toBe(data);
    expect(Object.keys(stored.session)).toEqual(ACF_SESSION_KEYS);
    expect(stored.mura).toMatchObject({ ISLOGGEDIN: true, USERID: REST_USER.userid, USERNAME: 'rest_user', FNAME: 'Rest', LNAME: 'User' });
    expect(stored.get(stored.mura, 'csrfsecretkey')).toBe((await sessionSnapshot(h.deps.sessions, outcome.sessionId))?.csrfSecret);
    expect(tokenInfo({ data })).toMatchObject({ USERID: REST_USER.userid, USERNAME: 'rest_user' });
  });

  it('answers tokeninfo with the bare token struct of the URL token, its info without hidden keys (527-533,4998-5024)', async () => {
    const outcome = await restCall(rest(TOKEN_INFO_PATH, { query: { access_token: 'T-JSON', client_id: 'x' } }));

    const body = tokenAnswer(outcome);
    expect(Object.keys(body)).toEqual(['access_token', 'expires_in', 'token_type', 'expires_at', 'info']);
    expect(body).toMatchObject({ access_token: 'T-JSON', expires_in: 3600, token_type: 'Bearer', expires_at: expiresAt(T_JSON) });
    const info = body.info as Record<string, unknown>;
    expect(Object.keys(info)).toEqual(Object.keys(tokenInfo(T_JSON)).map((key) => key.toLowerCase()));
    expect(info).toMatchObject({ userid: STORED_USER, username: 'qa_editor', siteid: 'default' });
    for (const hidden of HIDDEN_INFO_KEYS) expect(info).not.toHaveProperty(hidden);
  });

  it('answers client_credentials on oauth2 with the bare token struct and the user`s unexpired refresh token (687-739)', async () => {
    const outcome = await restCall(rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, client_secret: 'cc-secret', grant_type: 'client_credentials' } }));

    const body = tokenAnswer(outcome);
    expect(Object.keys(body)).toEqual(['access_token', 'expires_in', 'token_type', 'expires_at', 'refresh_token', 'info']);
    expect(body).toMatchObject({ expires_in: 3600, token_type: 'Bearer', expires_at: expiresAt({ expires: at(HOUR_MS) }), refresh_token: 'RT-REUSABLE' });
    expect(body.access_token).toMatch(GENERATED_TOKEN);
    expect(body.info).toMatchObject({ userid: REST_USER.userid, username: 'rest_user', siteid: GHOST });
  });

  it('answers client_credentials on oauth with the {apiversion, data, method} envelope (659-683)', async () => {
    const outcome = await restCall(rest(OAUTH_PATH, { params: { client_id: CC_CLIENT.clientid, client_secret: 'CC-SECRET', grant_type: 'CLIENT_CREDENTIALS' } }));

    const body = tokenAnswer(outcome);
    expect(Object.keys(body)).toEqual(['apiversion', 'data', 'method']);
    expect(body).toMatchObject({ apiversion: 'v1', method: 'getOAuthToken', data: { token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-REUSABLE' } });
  });

  it('deletes an expired refresh token and answers the unhandled-exception 500 (754-762,1390-1400)', async () => {
    const outcome = await restCall(rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, grant_type: 'refresh_token', refresh_token: 'RT-EXPIRED' } }));

    expectLegacyError(outcome, 'server_error', WWW_AUTHENTICATE.bearerInvalidClientCredentials);
    expect(storedTokens(h)).not.toContain('RT-EXPIRED');
    expect(storedTokens(h)).toContain('RT-VALID');
  });

  it('answers a valid refresh token with a client_credentials access token of its user and the same refresh token (765-799)', async () => {
    const outcome = await restCall(rest(OAUTH2_PATH, { params: { client_id: CC_CLIENT.clientid, grant_type: 'refresh_token', refresh_token: 'RT-VALID' } }));

    const body = tokenAnswer(outcome);
    expect(body).toMatchObject({ refresh_token: 'RT-VALID', token_type: 'Bearer', expires_in: 3600, info: { userid: REST_USER.userid } });
    expect(body.access_token).toMatch(GENERATED_TOKEN);
  });

  it('logs the user of a basic client in for matching Basic client credentials and drops them from the params (822-825)', async () => {
    const outcome = continued(await restCall(rest(CONTENT_PATH, { headers: basic(BASIC_CLIENT.clientid, 'basic-secret'), params: { id: 'x' } })));

    expect(outcome.params).toEqual({ id: 'x' });
    expect(await sessionState(h.deps.sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: REST_USER.userid });
  });

  it('continues anonymous for a basic client whose user is a group, which loginByUserID never logs in (userBean.cfc:768-771)', async () => {
    const group = groupRow({ siteid: GHOST });
    const client = restSiteClient(oauthClientRow({ clientid: cfId('C', 5), granttype: 'basic', clientsecret: 'basic-secret', userid: group.userid }));
    h = harness({ ...REST_SEED, groups: [group], oauthClients: [...(REST_SEED.oauthClients ?? []), client] });

    const outcome = continued(await restCall(rest(CONTENT_PATH, { headers: basic(client.clientid, 'basic-secret') })));

    expect(await sessionState(h.deps.sessions, outcome.sessionId)).toMatchObject({ state: 'active', userId: '' });
  });
});

type Method = 'GET' | 'PUT' | 'DELETE';
const FORM_CONTENT = { 'content-type': 'application/x-www-form-urlencoded' };
const NEW_CLIENT_ID = cfId('E', 1);

/** The four cwebservice routes as a user of `siteId` addresses them, the save with a form that carries no CSRF token. */
function cwebserviceRoutes(siteId: string): ReadonlyArray<readonly [Method, string, string | undefined]> {
  return [
    ['GET', '/v1/oauth-clients', undefined],
    ['GET', `/v1/oauth-clients/${NEW_CLIENT_ID}?siteid=${siteId}`, undefined],
    ['PUT', `/v1/oauth-clients/${NEW_CLIENT_ID}`, new URLSearchParams({ siteid: siteId, name: 'Feed reader' }).toString()],
    ['DELETE', `/v1/oauth-clients/${NEW_CLIENT_ID}?siteid=${siteId}`, undefined],
  ];
}

describe('cwebservice S2 gate in the composed identity app (cwebservice.cfc:80-98)', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await buildTestApp({ clock: CLOCK, env: { LOG_LEVEL: 'fatal' } });
    await test.app.ready();
  });

  afterAll(async () => {
    await test.app.close();
  });

  it.each(cwebserviceRoutes(SITE_ADMIN_A.siteId))('refuses %s %s to a site admin without S2, before any database work', async (method, url, payload) => {
    test.db.clear();

    const res = await test.app.inject({
      method,
      url,
      headers: { ...(await headersFor(Roles.siteAdmin, { site: SITE_ADMIN_A.siteId, sub: SITE_ADMIN_A.account.userid })), ...(payload === undefined ? {} : FORM_CONTENT) },
      payload,
    });

    expect(res.statusCode).toBe(403);
    expect(test.db.statements()).toEqual([]);
  });

  it.each(cwebserviceRoutes(ADMIN_S2.siteId))('admits %s %s for an S2 admin, a save or delete without CSRF tokens writing no OAuth row', async (method, url, payload) => {
    test.db.clear();

    const res = await test.app.inject({
      method,
      url,
      headers: { ...(await headersFor(Roles.s2, { site: ADMIN_S2.siteId, sub: ADMIN_S2.account.userid })), ...(payload === undefined ? {} : FORM_CONTENT) },
      payload,
    });

    expect(res.statusCode, res.body).toBe(200);
    if (method === 'PUT' || method === 'DELETE') expect(res.json()).toMatchObject({ written: false });
    expect(test.db.writes().filter((write) => /^identity\.oauth_(client|token)$/.test(write.table))).toEqual([]);
  });
});

describe('cwebservice save and delete over the memory repository (cwebservice.cfc:100-124)', () => {
  const ADMIN_TENANT = ADMIN_S2.tenant.tenantId;
  const ADMIN_SID = cfUuid();
  const ADMIN_SECRET = cfUuid();
  const EXISTING = oauthClientRow({
    tenant_id: ADMIN_TENANT,
    siteid: ADMIN_S2.siteId,
    clientid: cfId('E', 2),
    clientsecret: 'existing-secret',
    name: 'Existing client',
    created: at(-DAY_MS),
    lastupdate: at(-DAY_MS),
  });
  const OTHER = oauthClientRow({ tenant_id: ADMIN_TENANT, siteid: ADMIN_S2.siteId, clientid: cfId('E', 3) });
  const SEED: IdentitySeed = {
    ...actorSeed(ADMIN_S2),
    sessions: [
      sessionRow({
        tenant_id: ADMIN_TENANT,
        session_id: ADMIN_SID,
        user_id: ADMIN_S2.account.userid,
        site_id: ADMIN_S2.siteId,
        login_snapshot: JSON.stringify(loginSnapshotFixture({ actor: ADMIN_S2 })),
        csrf_secret: ADMIN_SECRET,
      }),
    ],
    oauthClients: [EXISTING, OTHER],
    oauthTokens: [
      oauthTokenRow({ tenant_id: ADMIN_TENANT, token: 'T-EXISTING-1', clientid: EXISTING.clientid }),
      oauthTokenRow({ tenant_id: ADMIN_TENANT, token: 'T-EXISTING-2', clientid: EXISTING.clientid }),
      oauthTokenRow({ tenant_id: ADMIN_TENANT, token: 'T-OTHER', clientid: OTHER.clientid }),
    ],
  };

  let app: FastifyInstance;
  let h: Harness;
  let stateDir: string;
  let relayed: string[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-oauth-'));
    await writeTestSecrets(stateDir);
    const env = loadEnv(undefined, {
      PORT: '8111',
      OPT2_SERVICE_NAME: 'identity',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    });
    h = harness(SEED, { sites: [ADMIN_S2.tenant, TENANT_A] });
    const { db, repo } = h;
    relayed = [];
    const bridge = {
      markUsed(sessionId: string, tokens: readonly { token: string }[]) {
        relayed.push(...tokens.map(({ token }) => `${sessionId}:${token}`));
        return Promise.resolve({ applied: true });
      },
    };
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    app = await createService({ name: 'identity', version: '1.0.0', env, clock: CLOCK, verifierOverride: testVerifier('identity'), logger });
    await registerAdminOAuthClientRoutes(app, {
      oauth: { db, repo, clock: CLOCK },
      sessions: { db, repo, clock: CLOCK },
      csrf: { db, repo, bridge, clock: CLOCK, sleep: () => Promise.resolve() },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.opt2.shutdown();
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Headers of the admin's signed-in session: its user token, naming the seeded session, relayed by the gateway. */
  async function adminHeaders(): Promise<Record<string, string>> {
    const [user, invocation] = await Promise.all([
      mintUserToken({ sub: ADMIN_S2.account.userid, sid: ADMIN_SID, site: ADMIN_S2.siteId, roles: [Roles.systemUser, Roles.s2] }),
      mintServiceToken({ caller: 'gateway', audience: 'identity' }),
    ]);
    return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${invocation}` };
  }

  /** A CSRF token and expiry of `context` under the admin session's secret. */
  function csrfFor(context: string): { token: string; expires: string } {
    return generateCsrfToken({ context, secret: ADMIN_SECRET, now: NOW });
  }

  /** PUTs the edit form of `clientId` with `fields`. */
  async function save(clientId: string, fields: Record<string, string>) {
    return app.inject({ method: 'PUT', url: `/v1/oauth-clients/${clientId}`, headers: { ...(await adminHeaders()), ...FORM_CONTENT }, payload: new URLSearchParams(fields).toString() });
  }

  /** The edit form fields with a CSRF token of `context`. */
  function withCsrf(context: string, fields: Record<string, string>): Record<string, string> {
    const { token, expires } = csrfFor(context);
    return { ...fields, [CSRF_FIELD_TOKEN]: token, [CSRF_FIELD_EXPIRES]: expires };
  }

  /** DELETEs `clientId`, sending `csrf` in the `X-csrf_token` headers. */
  async function remove(clientId: string, csrf?: { token: string; expires: string }) {
    const tokenHeaders = csrf === undefined ? {} : { [CSRF_HEADER_TOKEN]: csrf.token, [CSRF_HEADER_EXPIRES]: csrf.expires };
    return app.inject({ method: 'DELETE', url: `/v1/oauth-clients/${clientId}?siteid=${ADMIN_S2.siteId}`, headers: { ...(await adminHeaders()), ...tokenHeaders } });
  }

  function storedClient(clientId: string): ClientRow | undefined {
    return h.repo.rows('oauth_client', ADMIN_TENANT).find((row) => row.clientid === clientId);
  }

  it('creates a client under a CSRF token of context rc.clientid, consuming the token (cwebservice.cfc:106-110)', async () => {
    const fields = withCsrf(NEW_CLIENT_ID, { siteid: ADMIN_S2.siteId, name: 'Feed reader', granttype: 'client_credentials', redirectURL: 'https://ok.example.test/cb' });

    const res = await save(NEW_CLIENT_ID, fields);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      written: true,
      errors: {},
      client: { clientid: NEW_CLIENT_ID, siteid: ADMIN_S2.siteId, name: 'Feed reader', granttype: 'client_credentials', redirecturl: 'https://ok.example.test/cb', lastupdateby: 'Admin User' },
    });
    expect(storedClient(NEW_CLIENT_ID)).toMatchObject({ name: 'Feed reader', created: NOW, lastupdate: NOW });
    expect(storedClient(NEW_CLIENT_ID)?.clientsecret).toMatch(GENERATED_SECRET);
    expect(relayed).toEqual([`${ADMIN_SID}:${fields[CSRF_FIELD_TOKEN]}`]);
  });

  it('updates a stored client in place, keeping its creation date', async () => {
    const res = await save(EXISTING.clientid, withCsrf(EXISTING.clientid, { siteid: ADMIN_S2.siteId, name: 'Renamed', clientsecret: 'existing-secret', granttype: 'basic' }));

    expect(res.json()).toMatchObject({ written: true, client: { name: 'Renamed', clientsecret: 'existing-secret', granttype: 'basic' } });
    expect(storedClient(EXISTING.clientid)).toMatchObject({ name: 'Renamed', created: at(-DAY_MS), lastupdate: NOW });
  });

  it('returns the validation errors edit.cfm renders and writes nothing (cwebservice.cfc:112-114)', async () => {
    const res = await save(NEW_CLIENT_ID, withCsrf(NEW_CLIENT_ID, { siteid: ADMIN_S2.siteId, name: '' }));

    expect(res.json()).toMatchObject({ written: false, errors: { name: "The property named 'name' is not valid" }, client: { clientid: NEW_CLIENT_ID } });
    expect(storedClient(NEW_CLIENT_ID)).toBeUndefined();
  });

  it.each([
    ['no CSRF token', (fields: Record<string, string>) => fields],
    ['a token of another context', (fields: Record<string, string>) => withCsrf(EXISTING.clientid, fields)],
    ['a forged token', (fields: Record<string, string>) => ({ ...withCsrf(NEW_CLIENT_ID, fields), [CSRF_FIELD_TOKEN]: 'FORGED' })],
  ])('writes nothing for a save with %s, answering the validated client (cwebservice.cfc:108)', async (_label, sign) => {
    const res = await save(NEW_CLIENT_ID, sign({ siteid: ADMIN_S2.siteId, name: 'Feed reader' }));

    expect(res.json()).toMatchObject({ written: false, errors: {}, client: { clientid: NEW_CLIENT_ID, name: 'Feed reader' } });
    expect(oauthWrites(h.repo)).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it('answers a save without siteid with the session site and loads nothing, as legacy redirects first (cwebservice.cfc:101-104)', async () => {
    const res = await save(NEW_CLIENT_ID, withCsrf(NEW_CLIENT_ID, { name: 'Feed reader' }));

    expect(res.json()).toMatchObject({ written: false, errors: {}, client: { siteid: ADMIN_S2.siteId, name: 'Feed reader' } });
    expect(oauthWrites(h.repo)).toEqual([]);
  });

  it('deletes the client and its tokens under a CSRF token of context rc.clientid (cwebservice.cfc:117-124)', async () => {
    const res = await remove(EXISTING.clientid, csrfFor(EXISTING.clientid));

    expect(res.json()).toEqual({ written: true });
    expect(storedClient(EXISTING.clientid)).toBeUndefined();
    expect(storedTokens(h, ADMIN_TENANT)).toEqual(['T-OTHER']);
  });

  it.each([
    ['no CSRF token', () => undefined],
    ['a token of another context', () => csrfFor(OTHER.clientid)],
  ])('keeps the client and its tokens for a delete with %s (cwebservice.cfc:118)', async (_label, csrf) => {
    const res = await remove(EXISTING.clientid, csrf());

    expect(res.json()).toEqual({ written: false });
    expect(storedClient(EXISTING.clientid)).toBeDefined();
    expect(storedTokens(h, ADMIN_TENANT)).toEqual(['T-EXISTING-1', 'T-EXISTING-2', 'T-OTHER']);
    expect(oauthWrites(h.repo)).toEqual([]);
  });

  it('answers a delete of an unknown client as unwritten', async () => {
    const res = await remove(NEW_CLIENT_ID, csrfFor(NEW_CLIENT_ID));

    expect(res.json()).toEqual({ written: false });
    expect(h.repo.rows('oauth_client', ADMIN_TENANT)).toHaveLength(2);
  });
});
