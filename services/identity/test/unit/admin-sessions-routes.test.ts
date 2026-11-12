/** The admin session routes over a throwaway `identity` schema: `sanitizeHref` and `removeLeadingDoubleSlash`, contract shape and auth, clogin login and logout redirects, the session's sites and admin state, CSRF token issue and the login mail. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { INVOCATION_HEADER, Roles, collectRouteMatrix } from '@opt2/platform/auth';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, deleteCookieLegacy } from '@opt2/platform/legacy-compat';
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
import { issueTokens } from '../../src/domain/csrf.js';
import { DEFAULT_LOGIN_SETTINGS, LOGIN_SESSION_KEYS, type LoginSettings } from '../../src/domain/login.js';
import { DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, type LoginMailDeps, type LoginMailSiteSettings } from '../../src/domain/login-mail.js';
import { ensureSession } from '../../src/domain/sessions.js';
import type { BridgeRelay } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository, type AccountInput, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { IDENTITY_UNITS } from '../../src/repo/tables.js';
import { registerAdminSessionRoutes, removeLeadingDoubleSlash, sanitizeHref, type HrefContext } from '../../src/routes/admin-sessions.js';

type Method = 'GET' | 'POST';
type Payload = URLSearchParams | Record<string, unknown>;

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const CONTRACT_PATHS = [
  '/v1/sessions/current',
  '/v1/sessions/current/sites',
  '/v1/sessions/current/admin-state',
  '/v1/sessions/login',
  '/v1/sessions/logout',
  '/v1/csrf/tokens',
  '/v1/login-mail',
];
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const PASSWORD = 'Secret12';
const DEFAULT = 'default';
const SITE_A = 'tenant-a';
const UMBRELLA = 'umbrella';
const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const FAST_SETTINGS: LoginSettings = { password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 }, strikes: DEFAULT_LOGIN_SETTINGS.strikes };
const LOGOUT_COOKIES = ['userHash', 'userid'].map((name) => deleteCookieLegacy(name, {}, NOW));

// Unit and auth cases run without PostgreSQL; the stub fails any SQL they would reach.
const NO_DB: TenantDb = {
  schema: 'identity',
  withTenant: () => Promise.reject(new Error('no database in this run')),
  withMetadata: () => Promise.reject(new Error('no database in this run')),
  end: () => Promise.resolve(),
};

const NO_RELAY: BridgeRelay = { markUsed: () => Promise.resolve({ applied: true }) };

/** Login-mail settings answering each site by name, recording the site ids asked for. */
function recordingMailSettings(): LoginMailDeps['settings'] & { sitesAsked: string[] } {
  const sitesAsked: string[] = [];
  const site = (siteId: string): LoginMailSiteSettings => ({
    site: `Site ${siteId}`,
    contact: 'contact@example.test',
    sendLoginScript: '',
    editProfileURL: '',
    extranetSSL: false,
    useSSL: false,
    serverPort: '',
    context: '',
    extranetPublicRegNotify: '',
  });
  return {
    sitesAsked,
    global: () => ({ ...DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, title: 'Masa Admin' }),
    site: (siteId) => {
      sitesAsked.push(siteId);
      return site(siteId);
    },
    urlStem: (siteId, filename) => `/${siteId}/${filename}`,
  };
}

/** Login-mail events recorded by payload. */
function recordingMailEvents(): LoginMailDeps['events'] & { payloads: Array<{ siteId: string; from: string; to: string }> } {
  const payloads: Array<{ siteId: string; from: string; to: string }> = [];
  return {
    payloads,
    publishLoginMailRequested(_tx, payload) {
      payloads.push({ siteId: payload.siteId, from: payload.from, to: payload.to });
      return Promise.resolve(null);
    },
  };
}

const available = await pgAvailable();

let stateDir: string;
let app: FastifyInstance;
let handle: ThrowawaySchema | undefined;
let repo: IdentityRepository;
let seq = 0;
const mailSettings = recordingMailSettings();
const mailEvents = recordingMailEvents();

/** A 35-character CF UUID numbered by the next sequence value under hex digit `prefix`. */
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}0000000-0000-0000-${String(seq).padStart(16, '0')}`;
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-admin-sessions-routes-'));
  await writeTestSecrets(stateDir);
  repo = createIdentityRepository({ clock: CLOCK });
  if (available) {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle?.schema ?? ''}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
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
  const sleep = (): Promise<void> => Promise.resolve();
  await registerAdminSessionRoutes(app, {
    login: { db, repo, clock: CLOCK, settings: FAST_SETTINGS, sleep },
    sessions: { db, repo, clock: CLOCK },
    csrf: { db, repo, bridge: NO_RELAY, clock: CLOCK, sleep },
    loginMail: { db, repo, events: mailEvents, clock: CLOCK, settings: mailSettings, sleep },
    permissions: { db, repo, events: { publishPermissionChanged: () => Promise.resolve(null) } },
    db,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await handle?.drop();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  mailSettings.sitesAsked.length = 0;
  mailEvents.payloads.length = 0;
});

/** Headers of a gateway-relayed call; null `roles` sends no user token, null `caller` no invocation credential. */
async function headersFor(
  roles: readonly string[] | null,
  opts: { sid?: string; sub?: string; site?: string; caller?: string | null } = {},
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (roles !== null) {
    headers.authorization = `Bearer ${await mintUserToken({ sub: opts.sub ?? '', sid: opts.sid, site: opts.site ?? DEFAULT, roles })}`;
  }
  const caller = opts.caller === undefined ? 'gateway' : opts.caller;
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

describe('sanitizeHref', () => {
  const ctx: HrefContext = { siteId: '', sessionSiteId: DEFAULT, allowedDomains: ['localhost'], siteDomain: () => 'localhost' };

  // Values captured from utility.sanitizeHref on the legacy instance, whose domain list and site domain are both 'localhost'.
  it.each([
    ['/feedback/', '/feedback/'],
    ['//evil.com/p', '/evil.com/p'],
    ['//evil.com/x', '/evil.com/x'],
    ['//', '/'],
    ['///x', '/x'],
    ['//x', '/x'],
    ['http://localhost/page', 'http://localhost/page'],
    ['http://evil.com/page', 'http://localhost/page'],
    ['HTTP://evil.com/page', 'HTTP://localhost/page'],
    ['http://localhost//evil.com/x', 'http://localhost/x'],
    ['http://host//evil.com/p', 'http://localhost/p'],
    ['http://evil.com', 'http://localhost'],
    ['http:foo', 'localhost'],
    [':http://evil.com/x', 'http://localhost/x'],
    ['  http://evil.com/x  ', 'http://localhost/x'],
    ['\u0001http://evil.com/x', 'http://localhost/x'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['ftp://evil.com/x', 'ftp://evil.com/x'],
    ['x', 'x'],
    ['   ', '   '],
    ['', ''],
    ['https://localhost:8080/x', 'https://localhost:8080/x'],
    ['http://evil.com:8080/a', 'http://localhost:8080/a'],
    ['http://user@evil.com/x', 'http://localhost/x'],
    ['http://evil.com/a//b.com/c//d', 'http://localhost/a/c'],
    ['http://localhost/evil.com', 'http://localhost/evil.com'],
    ['http://ht/x', 'localhosttp://ht/x'],
    ['http://LOCALHOST/x', 'http://LOCALHOST/x'],
    ['http://evil.com?q=1', 'http://localhost'],
    ['https://evil.com/a/b//', 'https://localhost/a/b//'],
  ])('sanitizeHref(%j) is %j', (href, expected) => {
    expect(sanitizeHref(href, ctx)).toBe(expected);
  });

  it('fails where legacy fails on a path right after the scheme', () => {
    expect(() => sanitizeHref('http:///path', ctx)).toThrow(RangeError);
  });

  it('resolves the site domain of the named site, else of the session site, and inserts it literally', () => {
    const asked: string[] = [];
    const site = (siteId: string): string => {
      asked.push(siteId);
      return '$&.example.com';
    };
    const allowed = { allowedDomains: ['www.example.com,Alias.example.com', ''], siteDomain: site };

    expect(sanitizeHref('https://alias.EXAMPLE.com/a', { ...allowed, siteId: '', sessionSiteId: SITE_A })).toBe('https://alias.EXAMPLE.com/a');
    expect(sanitizeHref('https://evil.com/a', { ...allowed, siteId: 'tenant-b', sessionSiteId: SITE_A })).toBe('https://$&.example.com/a');
    expect(sanitizeHref('/relative', { ...allowed, siteId: '', sessionSiteId: SITE_A })).toBe('/relative');
    expect(asked).toEqual([SITE_A, 'tenant-b']);
  });
});

describe('removeLeadingDoubleSlash', () => {
  it.each([
    ['//', '/'],
    ['//x', '/x'],
    ['///x', '/x'],
    ['  //evil.com/p  ', '/evil.com/p'],
    ['/a', '/a'],
    ['http://evil.com', 'http://evil.com'],
    ['   ', ''],
    ['', ''],
  ])('removeLeadingDoubleSlash(%j) is %j', (url, expected) => {
    expect(removeLeadingDoubleSlash(url)).toBe(expected);
  });
});

describe('route declarations', () => {
  it('match the contract operations of the admin session paths', () => {
    const declared = collectRouteMatrix(app).routes.filter((route) => CONTRACT_PATHS.includes(route.url));
    const expected = CONTRACT_PATHS.flatMap((template) =>
      Object.entries(OPENAPI.paths[template] ?? {})
        .filter(([method]) => method !== 'parameters')
        .map(([method, operation]) => ({
          method: method.toUpperCase(),
          url: template,
          transport: operation['x-opt2-transport'],
          ...(operation['x-opt2-public'] === true ? { public: true } : { requires: operation['x-opt2-requires'] }),
        })),
    );

    expect(expected).toHaveLength(8);
    expect(declared).toHaveLength(8);
    expect(declared).toEqual(expect.arrayContaining(expected.map((entry): unknown => expect.objectContaining(entry))));
    // Only the admin-state save, whose `siteid` is the session's selected site, skips the token-site check.
    expect(declared.filter((route) => !route.siteCheck).map((route) => `${route.method} ${route.url}`)).toEqual(['POST /v1/sessions/current/admin-state']);
  });
});

describe('without a session', () => {
  it('reads the anonymous session without a user token', async () => {
    const res = await send('GET', '/v1/sessions/current', await headersFor(null));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessionId: null,
      epoch: null,
      user: { isLoggedIn: false, userID: '', siteID: '', subtype: 'Default', username: '', fname: '', lname: '', company: '', lastlogin: '', passwordCreated: '', email: '', remoteID: '', memberships: '', membershipids: '', showTrace: false },
      roles: [],
      mfaPending: false,
      blockLoginUntil: null,
    });
  });

  it('redirects a login without a user token to clogin.main as a failed CSRF check', async () => {
    const res = await send('POST', '/v1/sessions/login', await headersFor(null), new URLSearchParams({ username: 'admin', password: PASSWORD }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'csrf-invalid', location: './?muraAction=clogin.main', epoch: null });
  });

  it('logs out by deleting the remember-me cookies and redirecting to home.redirect', async () => {
    const res = await send('POST', '/v1/sessions/logout', await headersFor(null, { caller: null }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirect: { action: 'home.redirect', params: {} } });
    expect(res.headers['set-cookie']).toEqual(LOGOUT_COOKIES);
    expect(LOGOUT_COOKIES[0]).toMatch(/^userHash=;expires=.*;path=\/;HttpOnly;$/);
  });

  it('answers the login mail of an address legacy does not accept with the sent message, mailing nothing', async () => {
    const res = await send('POST', '/v1/login-mail', await headersFor(null), { email: 'not-an-address', siteid: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'messagesent' });
    expect(mailEvents.payloads).toEqual([]);
  });

  it.each<[string, Method, string, Payload | undefined, () => Promise<Record<string, string>>, number]>([
    ['admin state without a user token', 'GET', '/v1/sessions/current/admin-state', undefined, () => headersFor(null), 401],
    ['admin state without an invocation credential', 'GET', '/v1/sessions/current/admin-state', undefined, () => headersFor([Roles.systemUser], { caller: null }), 401],
    ['an admin state save without a user token', 'POST', '/v1/sessions/current/admin-state', { siteid: DEFAULT }, () => headersFor(null), 401],
    ['CSRF tokens without a user token', 'POST', '/v1/csrf/tokens', { contexts: ['login'] }, () => headersFor(null), 401],
    ['sites for a member', 'GET', '/v1/sessions/current/sites', undefined, () => headersFor([Roles.member]), 403],
    ['sites without a user token', 'GET', '/v1/sessions/current/sites', undefined, () => headersFor(null), 401],
    ['CSRF tokens for no context', 'POST', '/v1/csrf/tokens', { contexts: [] }, () => headersFor([Roles.systemUser]), 400],
    ['a login mail without an address', 'POST', '/v1/login-mail', { siteid: '' }, () => headersFor(null), 400],
    ['a login naming another site', 'POST', '/v1/sessions/login?siteid=tenant-b', new URLSearchParams({ username: 'a' }), () => headersFor([]), 403],
  ])('refuses %s', async (_label, method, url, payload, headers, status) => {
    const res = await send(method, url, await headers(), payload);

    expect(res.statusCode).toBe(status);
  });

  it('answers a service credential holding s2 without a user token on the site list as a missing credential', async () => {
    const headers = { [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: 'identity', roles: [Roles.s2] })}` };

    const res = await send('GET', '/v1/sessions/current/sites', headers);

    expect(res.statusCode).toBe(401);
  });
});

describe.skipIf(!available)('admin sessions against PostgreSQL', () => {
  let bcryptStored: string;
  const users = { admin: '', editor: '', member: '' };

  function gated<T>(site: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    return withGatedTenant(handle.app, tenantIdForSite(site), fn);
  }

  async function registerSite(site: string, privatePool: string, publicPool: string, domains: string[]): Promise<void> {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    const { schema } = handle;
    await withMetadata(handle.app, (tx) =>
      tx.query(
        `INSERT INTO ${schema}.tenant_registry (site_id, tenant_id, private_user_pool_id, public_user_pool_id,` +
          ' private_user_pool_tenant, public_user_pool_tenant, domains, aggregate_version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)',
        [site, tenantIdForSite(site), privatePool, publicPool, tenantIdForSite(privatePool), tenantIdForSite(publicPool), domains, NOW],
      ),
    );
  }

  function groupInput(groupname: string, siteid: string): GroupInput {
    return {
      groupname, fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
      website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid,
      subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '',
    };
  }

  async function seedUser(username: string, site: string, account: Partial<AccountInput>, groupIds: string[] = []): Promise<string> {
    const userId = nextId('A');
    await gated(site, async (tx) => {
      await repo.insertAccount(tx, { userid: userId, username, type: 2, s2: 0, perm: 0, inactive: 0, ispublic: 0, siteid: site, remoteid: '', tablist: '', ...account });
      await repo.writeCredential(tx, userId, { password: bcryptStored, passwordcreated: NOW });
      await repo.upsertPersonContact(tx, { user_id: userId, site_id: site, subtype: 'Default', aggregate_version: 1, fname: username, lname: 'User', email: `${username}@example.test`, company: '' });
      if (groupIds.length > 0) await repo.replaceMemberships(tx, { userId, groupIds });
    });
    return userId;
  }

  /** A new active anonymous session and its CSRF secret. */
  async function newSession(): Promise<{ sid: string; csrfSecret: string }> {
    if (handle === undefined) throw new Error('PostgreSQL is not available');
    const sid = `S-${nextId('5')}`;
    const { csrfSecret } = await ensureSession({ db: handle.app, repo, clock: CLOCK }, { sessionId: sid, mode: 'target-primary' });
    return { sid, csrfSecret };
  }

  /** The admin login form with a login CSRF token of `csrfSecret`, `fields` overriding. */
  function loginForm(csrfSecret: string, fields: Record<string, string>): URLSearchParams {
    const { token, expires } = issueTokens({ csrfSecret }, { context: 'login', clock: CLOCK });
    return new URLSearchParams({
      returnUrl: '',
      muraAction: 'cLogin.login',
      isAdminLogin: 'true',
      compactDisplay: 'false',
      [CSRF_FIELD_TOKEN]: token,
      [CSRF_FIELD_EXPIRES]: expires,
      ...fields,
    });
  }

  async function loginAs(username: string, fields: Record<string, string> = {}): Promise<{ sid: string; body: Record<string, unknown> }> {
    const { sid, csrfSecret } = await newSession();
    const res = await send('POST', '/v1/sessions/login', await headersFor([], { sid }), loginForm(csrfSecret, { username, password: PASSWORD, ...fields }));
    expect(res.statusCode).toBe(200);
    return { sid, body: res.json() };
  }

  beforeAll(async () => {
    bcryptStored = await bcrypt.hash(PASSWORD, (await bcrypt.genSalt(4)).replace(/^\$2b\$/, '$2a$'));
    await registerSite(DEFAULT, DEFAULT, DEFAULT, ['localhost']);
    await registerSite(SITE_A, SITE_A, UMBRELLA, ['a.example.test', 'alias-a.example.test']);
    await registerSite(UMBRELLA, UMBRELLA, UMBRELLA, ['umbrella.example.test']);
    const editors = await gated(SITE_A, (tx) => repo.insertGroup(tx, groupInput('Editors', SITE_A), null));
    const readers = await gated(SITE_A, (tx) => repo.insertGroup(tx, groupInput('Readers', SITE_A), null));
    await gated(SITE_A, (tx) => repo.replaceModulePermissions(tx, { moduleId: SITE_MANAGER_MODULE, siteId: SITE_A, groupIds: [editors.userid] }));
    users.admin = await seedUser('siteadmin', DEFAULT, { s2: 1 });
    users.editor = await seedUser('editor', SITE_A, {}, [editors.userid]);
    users.member = await seedUser('reader', SITE_A, {}, [readers.userid]);
  });

  it('logs in to ./ keeping the session id, then reads the user struct and login-time roles', async () => {
    const { sid, body } = await loginAs('siteadmin');

    expect(body).toMatchObject({ outcome: 'success', location: './' });
    const current = await send('GET', '/v1/sessions/current', await headersFor([Roles.s2], { sid, sub: users.admin }));
    expect(current.json()).toMatchObject({
      sessionId: sid,
      epoch: body.epoch,
      user: { isLoggedIn: true, userID: users.admin, username: 'siteadmin', siteID: DEFAULT, fname: 'siteadmin' },
      roles: expect.arrayContaining(['S2IsPrivate', 'S2']),
      mfaPending: false,
      blockLoginUntil: null,
    });
    expect(current.json().user).not.toHaveProperty('password');
  });

  it.each([
    [{ linkServID: 'L-1' }, './?LinkServID=L-1'],
    [{ returnUrl: '/admin/?muraAction=cArch.list&doaction=logout' }, '/admin/?muraAction=cArch.list&'],
    [{ returnUrl: 'http://evil.com/admin/?doaction=logoutdoaction=logout&x=1' }, 'http://localhost/admin/?&x=1'],
    [{ returnUrl: 'https://alias-a.example.test//evil.com/admin/' }, 'https://alias-a.example.test/admin/'],
    [{ returnUrl: '//evil.com/admin/' }, '/evil.com/admin/'],
  ])('redirects a successful login with %j to %j', async (fields, location) => {
    const { body } = await loginAs('editor', fields);

    expect(body).toMatchObject({ outcome: 'success', location });
  });

  it('redirects a failed admin login to the login page with the legacy parameters, encoded as URLEncodedFormat', async () => {
    const { sid, csrfSecret } = await newSession();
    const form = loginForm(csrfSecret, {
      username: 'editor',
      password: 'wrong',
      rememberMe: '1',
      contentid: 'C-1',
      linkServID: 'L-1',
      returnUrl: 'http://x.test/a-b_c.d?e=f g~',
      compactDisplay: 'true',
    });

    const res = await send('POST', '/v1/sessions/login', await headersFor([], { sid }), form);

    expect(res.json()).toEqual({
      outcome: 'failed',
      location:
        './?muraAction=cLogin.main&display=login&status=failed&rememberMe=1&contentid=C-1&LinkServID=L-1' +
        '&returnURL=http%3A%2F%2Fx%2Etest%2Fa%2Db%5Fc%2Ed%3Fe%3Df%20g%7E&compactDisplay=true',
      epoch: 1,
    });
  });

  it('answers a held strike block as blocked and shows the block on the current session', async () => {
    await gated(SITE_A, async (tx) => {
      await repo.ensureStrike(tx, 'reader', NOW);
      await repo.setStrike(tx, 'reader', { strikes: 5, lastattempt: NOW });
    });
    const { sid, body } = await loginAs('reader');

    expect(body).toEqual({
      outcome: 'blocked',
      location: './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=&LinkServID=&returnURL=&compactDisplay=false',
      epoch: 1,
    });
    const current = await send('GET', '/v1/sessions/current', await headersFor([], { sid }));
    expect(current.json()).toMatchObject({ user: { isLoggedIn: false }, roles: [], blockLoginUntil: expect.stringMatching(/^2026-06-30T12:1\d:\d\d\.\d{3}$/) });
    const state = await send('GET', '/v1/sessions/current/admin-state', await headersFor([], { sid }));
    expect(state.json()).not.toHaveProperty(LOGIN_SESSION_KEYS.blockLoginUntil);
  });

  it('refuses a token of another CSRF context and consumes a valid token even when no credentials are posted', async () => {
    const { sid, csrfSecret } = await newSession();
    const other = issueTokens({ csrfSecret }, { context: 'other', clock: CLOCK });
    const headers = await headersFor([], { sid });
    const wrongContext = new URLSearchParams({ username: 'editor', password: PASSWORD, [CSRF_FIELD_TOKEN]: other.token, [CSRF_FIELD_EXPIRES]: other.expires });

    const refused = await send('POST', '/v1/sessions/login', headers, wrongContext);
    const form = loginForm(csrfSecret, { username: 'editor' });
    const unattempted = await send('POST', '/v1/sessions/login', headers, form);
    form.set('password', PASSWORD);
    const reused = await send('POST', '/v1/sessions/login', headers, form);

    expect(refused.json()).toEqual({ outcome: 'csrf-invalid', location: './?muraAction=clogin.main', epoch: 1 });
    expect(unattempted.json()).toEqual({ outcome: 'unattempted', location: '', epoch: 1 });
    expect(reused.json()).toEqual({ outcome: 'csrf-invalid', location: './?muraAction=clogin.main', epoch: 1 });
  });

  it.each([
    ['an MFA challenge attempt, which needs the MFA login legacy never started', { attemptChallenge: 'true' }],
    ['a failed login without isAdminLogin, whose target is the site login URL', { password: 'wrong', isAdminLogin: '' }],
  ])('fails %s', async (_label, fields) => {
    const { sid, csrfSecret } = await newSession();
    const form = loginForm(csrfSecret, { username: 'editor', password: PASSWORD, ...fields });
    if (fields.isAdminLogin === '') form.delete('isAdminLogin');

    const res = await send('POST', '/v1/sessions/login', await headersFor([], { sid }), form);

    expect(res.statusCode).toBe(500);
  });

  it('lists every registered site for an S2 user and the granted sites for a module grant, by site id', async () => {
    const { sid: adminSid } = await loginAs('siteadmin');
    const { sid: editorSid } = await loginAs('editor');
    const { sid: anonymousSid } = await newSession();

    const admin = await send('GET', '/v1/sessions/current/sites', await headersFor([Roles.s2], { sid: adminSid, sub: users.admin }));
    const editor = await send('GET', '/v1/sessions/current/sites', await headersFor([Roles.systemUser], { sid: editorSid, sub: users.editor, site: SITE_A }));
    const anonymous = await send('GET', '/v1/sessions/current/sites', await headersFor([Roles.systemUser], { sid: anonymousSid }));

    expect(admin.json()).toEqual({
      sites: [DEFAULT, SITE_A, UMBRELLA].map((siteID) => ({ siteID, site: `Site ${siteID}` })),
    });
    expect(editor.json()).toEqual({ sites: [{ siteID: SITE_A, site: `Site ${SITE_A}` }] });
    expect(anonymous.json()).toEqual({ sites: [] });
  });

  it('lists no site for a private user without the Site Manager grant', async () => {
    const { sid, csrfSecret } = await newSession();
    await gated(SITE_A, async (tx) => {
      await repo.ensureStrike(tx, 'reader', NOW);
      await repo.setStrike(tx, 'reader', { strikes: 0, lastattempt: NOW });
    });
    const res = await send('POST', '/v1/sessions/login', await headersFor([], { sid }), loginForm(csrfSecret, { username: 'reader', password: PASSWORD }));
    expect(res.json()).toMatchObject({ outcome: 'success' });

    const sites = await send('GET', '/v1/sessions/current/sites', await headersFor([Roles.systemUser], { sid, sub: users.member, site: SITE_A }));

    expect(sites.json()).toEqual({ sites: [] });
  });

  it('ends the session at logout, bumping its epoch and reading it anonymous', async () => {
    const { sid, body } = await loginAs('siteadmin');
    const headers = await headersFor([Roles.s2], { sid, sub: users.admin });

    const res = await send('POST', '/v1/sessions/logout', headers);
    const current = await send('GET', '/v1/sessions/current', headers);

    expect(res.headers['set-cookie']).toEqual(LOGOUT_COOKIES);
    expect(current.json()).toMatchObject({ sessionId: sid, epoch: Number(body.epoch) + 1, user: { isLoggedIn: false }, roles: [] });
  });

  it('issues one login-formula token per context under the session secret, and none for an ended session', async () => {
    const { sid, csrfSecret } = await newSession();
    const headers = await headersFor([], { sid });

    const res = await send('POST', '/v1/csrf/tokens', headers, { contexts: ['login', 'ctx-2'] });
    await send('POST', '/v1/sessions/logout', headers);
    const ended = await send('POST', '/v1/csrf/tokens', headers, { contexts: ['login'] });

    const expected = ['login', 'ctx-2'].map((context) => {
      const { token, expires } = issueTokens({ csrfSecret }, { context, clock: CLOCK });
      return { context, csrf_token: token, csrf_token_expires: expires };
    });
    expect(res.json()).toEqual({ tokens: expected });
    expect(ended.statusCode).toBe(401);
  });

  it('stores admin values whole by key, drops the read-only default-password flag, and refuses an ended session', async () => {
    const { sid } = await newSession();
    const headers = await headersFor([], { sid });
    const first = { siteid: SITE_A, paramArray: [{ Field: 'tusers.lname', Relationship: 'Contains', Criteria: 'Ada', Condition: 'AND' }], mura: { errors: { a: 1 } } };

    const saved = await send('POST', '/v1/sessions/current/admin-state', headers, { ...first, hasdefaultpassword: true });
    const merged = await send('POST', '/v1/sessions/current/admin-state', headers, { mura: { objectInstanceId: 'x' }, dashboardSpan: 30 });
    const read = await send('GET', '/v1/sessions/current/admin-state', headers);
    await send('POST', '/v1/sessions/logout', headers);
    const ended = await send('POST', '/v1/sessions/current/admin-state', headers, { siteid: DEFAULT });
    const endedRead = await send('GET', '/v1/sessions/current/admin-state', headers);

    expect(saved.json()).toEqual(first);
    expect(merged.json()).toEqual({ ...first, mura: { objectInstanceId: 'x' }, dashboardSpan: 30 });
    expect(read.json()).toEqual(merged.json());
    expect(ended.statusCode).toBe(401);
    expect(endedRead.json()).toEqual({});
  });

  it('sends the forgot-password mail with an empty site id from the forwarded host, checking no CSRF token', async () => {
    const headers = { ...(await headersFor(null)), 'x-forwarded-host': 'admin.example.test:8080' };

    const res = await send('POST', '/v1/login-mail', headers, new URLSearchParams({ email: 'editor@example.test', siteid: '' }));

    expect(res.json()).toEqual({ status: 'messagesent' });
    expect(mailEvents.payloads).toEqual([{ siteId: '', from: 'Masa Admin', to: 'editor@example.test' }]);
    expect(mailSettings.sitesAsked).toEqual([]);
  });
});
