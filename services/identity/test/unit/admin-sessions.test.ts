/** The admin session routes offline: clogin login and logout, the session state and sites the admin screens read, the login mail, the URL helpers, and the public routes' transport in the composed service. */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER, Roles } from '@opt2/platform/auth';
import { ADMIN_HOME_ACTION, CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, adminUrl } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createService, type FastifyInstance } from '@opt2/platform/service-kit';
import { tenantIdForSite, type QueryResultRow } from '@opt2/platform/tenancy';
import { TENANT_A, assertResponseMatchesOpenApi, mintServiceToken, mintUserToken, registryPayloads, testVerifier } from '@opt2/platform/testing';
import { DEFAULT_LOGIN_SETTINGS, type LoginSettings } from '../../src/domain/login.js';
import { DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS, type LoginMailDeps, type LoginMailSiteSettings } from '../../src/domain/login-mail.js';
import { ensureSession, type SessionDeps } from '../../src/domain/sessions.js';
import {
  registerAdminSessionRoutes,
  removeLeadingDoubleSlash,
  sanitizeHref,
  type AdminSessionRouteDeps,
  type HrefContext,
} from '../../src/routes/admin-sessions.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { createRecordingDb } from '../helpers/memory-repo.js';
import { ADMIN_S2, EDITOR, POOLED_MEMBER, SITE_ADMIN_A, TEST_PASSWORDS, type TestActor } from '../helpers/rows.js';

type Method = 'GET' | 'POST';
type Payload = URLSearchParams | Record<string, unknown>;
type Headers = Record<string, string>;
type MailPayload = Parameters<LoginMailDeps['events']['publishLoginMailRequested']>[1];
type IssuedToken = { context: string; csrf_token: string; csrf_token_expires: string };

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
const SERVICE = 'identity';
const DEFAULT_SITE = 'default';
const FORM_BODY = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_BODY = { 'content-type': 'application/json' };
const FAST_LOGIN: LoginSettings = { ...DEFAULT_LOGIN_SETTINGS, password: { ...DEFAULT_LOGIN_SETTINGS.password, bcryptLogRounds: 4 } };
const CLOGIN_MAIN = './?muraAction=clogin.main';
const FAILED_LOGIN =
  './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=&LinkServID=&returnURL=&compactDisplay=false';
const REGISTRY_READ = /FROM identity\.tenant_registry\b/;
const noSleep = (): Promise<void> => Promise.resolve();

/** `tenant_registry` rows of the three platform fixtures and the installed `default` site, in site id order. */
const REGISTRY_ROWS: readonly QueryResultRow[] = [...registryPayloads(), { siteId: DEFAULT_SITE, domains: ['localhost'] }]
  .sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0))
  .map((site) => {
    const pool = (id: string | null | undefined): string => id ?? site.siteId;
    const pools = {
      public_user_pool: pool(site.publicUserPoolId),
      private_user_pool: pool(site.privateUserPoolId),
      category_pool: pool(site.categoryPoolId),
      file_pool: pool(site.filePoolId),
      display_pool: pool(site.displayPoolId),
    };
    const content = [site.contentPoolIds ?? site.siteId].flat();
    return {
      site_id: site.siteId,
      tenant_id: tenantIdForSite(site.siteId),
      ...Object.fromEntries(Object.entries(pools).flatMap(([column, id]) => [[`${column}_id`, id], [`${column}_tenant`, tenantIdForSite(id)]])),
      content_pool_ids: content,
      content_pool_tenants: content.map((id) => tenantIdForSite(id)),
      domains: site.domains ?? [],
      aggregate_version: '1',
      updated_at: TEST_CLOCK.now(),
    };
  });

/** Answers the registry reads of `@opt2/platform/tenancy` from REGISTRY_ROWS, filtered by their site or tenant predicate. */
function registryAnswer(sql: string, values: readonly unknown[]): QueryResultRow[] {
  const [first] = values;
  if (/WHERE lower\(site_id\) = lower\(\$1\)/.test(sql)) {
    return REGISTRY_ROWS.filter((row) => String(row.site_id).toLowerCase() === String(first).toLowerCase());
  }
  if (/WHERE tenant_id = \$1/.test(sql)) return REGISTRY_ROWS.filter((row) => row.tenant_id === first);
  return [...REGISTRY_ROWS];
}

/** Mail settings answering every site by name. */
const MAIL_SETTINGS: LoginMailDeps['settings'] = {
  global: () => DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
  site: (siteId): LoginMailSiteSettings => ({
    site: `Site ${siteId}`,
    contact: 'contact@example.test',
    sendLoginScript: '',
    editProfileURL: '',
    extranetSSL: false,
    useSSL: false,
    serverPort: '',
    context: '',
    extranetPublicRegNotify: '',
  }),
  urlStem: (siteId, filename) => `/${siteId}/${filename}`,
};

const relayed: Array<{ sessionId: string; tokens: string[] }> = [];
const mails: MailPayload[] = [];
let t: TestApp;
let app: FastifyInstance;
let sessions: SessionDeps;
let seq = 0;

beforeAll(async () => {
  t = await buildTestApp();
  await t.app.ready();
  const { repo, clock } = t;
  // buildTestApp's own routes run the SQL repository over an empty recording database, so the session flows run these
  // routes over its memory repository, with the site registry answered from REGISTRY_ROWS.
  const db = createRecordingDb({ responses: [[REGISTRY_READ, registryAnswer]] });
  const bridge: AdminSessionRouteDeps['csrf']['bridge'] = {
    markUsed(sessionId, tokens) {
      relayed.push({ sessionId, tokens: tokens.map((used) => used.token) });
      return Promise.resolve({ applied: true });
    },
  };
  const events: LoginMailDeps['events'] = {
    publishLoginMailRequested(_tx, payload) {
      mails.push(payload);
      return Promise.resolve(null);
    },
  };
  sessions = { db, repo, clock };
  app = await createService({
    name: SERVICE,
    version: '1.0.0',
    env: t.env,
    clock,
    verifierOverride: testVerifier(SERVICE),
    logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  registerWritePositionHeader(app);
  await registerAdminSessionRoutes(app, {
    login: { db, repo, clock, settings: FAST_LOGIN, sleep: noSleep },
    sessions,
    csrf: { db, repo, bridge, clock, sleep: noSleep },
    loginMail: { db, repo, events, clock, settings: MAIL_SETTINGS, sleep: noSleep },
    permissions: { db, repo, events: { publishPermissionChanged: () => Promise.resolve(null) } },
    db,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.opt2.shutdown();
  await t?.app.close();
});

beforeEach(() => {
  relayed.length = 0;
  mails.length = 0;
  t.repo.clear();
  t.db.clear();
});

/** Injects a request into `target`, fields as a form post and an object as JSON, and checks the answer against the contract. */
async function send(target: FastifyInstance, method: Method, url: string, headers: Headers, payload?: Payload) {
  const form = payload instanceof URLSearchParams;
  const res = await target.inject({
    method,
    url,
    headers: payload === undefined ? headers : { ...headers, ...(form ? FORM_BODY : JSON_BODY) },
    payload: payload === undefined ? undefined : form ? payload.toString() : JSON.stringify(payload),
  });
  assertResponseMatchesOpenApi(OPENAPI, { method, path: url, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
  return res;
}

/** Gateway-relayed headers of session `sid`: a user token for `roles` on `site` beside the gateway's invocation credential. */
async function sessionHeaders(sid: string, roles: readonly string[] = [], sub = '', site = DEFAULT_SITE): Promise<Headers> {
  const [user, gateway] = await Promise.all([
    mintUserToken({ sub, sid, site, roles }),
    mintServiceToken({ caller: 'gateway', audience: SERVICE }),
  ]);
  return { authorization: `Bearer ${user}`, [INVOCATION_HEADER]: `Bearer ${gateway}` };
}

/** A new active anonymous session and the headers the gateway relays for it on `site`. */
async function anonymousSession(site = DEFAULT_SITE): Promise<{ sid: string; headers: Headers }> {
  seq += 1;
  const sid = `S-admin-sessions-${String(seq)}`;
  await ensureSession(sessions, { sessionId: sid, mode: 'target-primary' });
  return { sid, headers: await sessionHeaders(sid, [], '', site) };
}

/** The session's token for `context`, issued by the CSRF token route. */
async function issuedToken(headers: Headers, context: string): Promise<IssuedToken> {
  const res = await send(app, 'POST', '/v1/csrf/tokens', headers, { contexts: [context] });
  const [token] = (res.json() as { tokens: IssuedToken[] }).tokens;
  if (token === undefined) throw new Error(`no token issued for ${context}`);
  return token;
}

/** The admin login form as the login page posts it, under the session's token for `context`, `fields` overriding. */
async function loginForm(headers: Headers, fields: Record<string, string>, context = 'login'): Promise<URLSearchParams> {
  const token = await issuedToken(headers, context);
  return new URLSearchParams({
    returnUrl: '',
    muraAction: 'cLogin.login',
    isAdminLogin: 'true',
    compactDisplay: 'false',
    [CSRF_FIELD_TOKEN]: token.csrf_token,
    [CSRF_FIELD_EXPIRES]: token.csrf_token_expires,
    ...fields,
  });
}

/** Logs `actor` into a new session with `password`, `fields` overriding the form; a posted `siteid` is also the token's site. */
async function loginAs(actor: TestActor, password: string, fields: Record<string, string> = {}) {
  const { sid, headers } = await anonymousSession(fields.siteid);
  const form = await loginForm(headers, { username: actor.account.username ?? '', password, ...fields });
  const res = await send(app, 'POST', '/v1/sessions/login', headers, form);
  expect(res.statusCode).toBe(200);
  return { sid, headers, form, body: res.json() as { outcome: string; location: string; epoch: number | null } };
}

/** The stored strike count of `actor`'s username; 0 before the first strike. */
function strikesOf(actor: TestActor): number {
  const row = t.repo.rows('user_strike', actor.tenant.tenantId).find((strike) => strike.username === actor.account.username);
  return row?.strikes ?? 0;
}

describe('the login page state of an anonymous session', () => {
  it('reads no user and no roles, and issues the session its own token for context login', async () => {
    const { sid, headers } = await anonymousSession();
    const other = await anonymousSession();

    const current = await send(app, 'GET', '/v1/sessions/current', headers);
    const token = await issuedToken(headers, 'login');
    const otherToken = await issuedToken(other.headers, 'login');

    expect(current.json()).toMatchObject({ sessionId: sid, epoch: 1, user: { isLoggedIn: false, userID: '' }, roles: [], mfaPending: false, blockLoginUntil: null });
    expect(token.context).toBe('login');
    expect(otherToken.csrf_token).not.toBe(token.csrf_token);
  });
});

describe('clogin.login', () => {
  it.each<[string, TestActor, string, string, string[], boolean]>([
    ['the S2 admin, whose login-time roles hold S2IsPrivate', ADMIN_S2, TEST_PASSWORDS.admin, DEFAULT_SITE, [Roles.s2], true],
    ['a private-pool editor, whose login-time roles hold S2IsPrivate', EDITOR, TEST_PASSWORDS.editor, TENANT_A.siteId, [Roles.systemUser], true],
    ['a public-pool member, whose login-time roles do not', POOLED_MEMBER, TEST_PASSWORDS.pooledMember, TENANT_A.siteId, [Roles.member], false],
  ])('logs in %s under a login token, keeping the session id and bumping its epoch', async (_label, actor, password, siteid, roles, s2IsPrivate) => {
    const { sid, form, body } = await loginAs(actor, password, { siteid });

    const current = await send(app, 'GET', '/v1/sessions/current', await sessionHeaders(sid, roles, actor.account.userid, siteid));

    expect(body).toEqual({ outcome: 'success', location: './', epoch: 2 });
    expect(current.json()).toMatchObject({
      sessionId: sid,
      epoch: 2,
      user: { isLoggedIn: true, userID: actor.account.userid, username: actor.account.username },
    });
    expect((current.json() as { roles: string[] }).roles.includes('S2IsPrivate')).toBe(s2IsPrivate);
    expect(relayed).toEqual([{ sessionId: sid, tokens: [form.get(CSRF_FIELD_TOKEN)] }]);
  });

  it.each([
    ['scheme-relative', '//evil.com/phishing', '/evil.com/phishing'],
    ['on a registered site domain', 'http://tenant-a.opt2.test/admin/', 'http://tenant-a.opt2.test/admin/'],
    ['on an external domain, which takes the default site domain', 'http://external.com/admin/?doaction=logout', 'http://localhost/admin/?'],
  ])('redirects a successful login with a return URL %s, %j, to %j', async (_label, returnUrl, location) => {
    const { body } = await loginAs(EDITOR, TEST_PASSWORDS.editor, { returnUrl });

    expect(body).toMatchObject({ outcome: 'success', location });
  });

  it.each([
    ['a token of another context', 'other', false],
    ['no token', 'login', true],
  ])('redirects a login with %s to clogin.main without attempting it', async (_label, context, dropToken) => {
    const { headers } = await anonymousSession();
    const form = await loginForm(headers, { username: SITE_ADMIN_A.account.username ?? '', password: 'not-the-password' }, context);
    if (dropToken) form.delete(CSRF_FIELD_TOKEN);
    const strikes = strikesOf(SITE_ADMIN_A);
    t.repo.clear();

    const res = await send(app, 'POST', '/v1/sessions/login', headers, form);

    expect(res.json()).toEqual({ outcome: 'csrf-invalid', location: CLOGIN_MAIN, epoch: 1 });
    expect(adminUrl({ circuit: 'clogin', action: 'main', adminDir: '.' })).toBe(CLOGIN_MAIN);
    expect(strikesOf(SITE_ADMIN_A)).toBe(strikes);
    expect(t.repo.writes()).toEqual([]);
    expect(relayed).toEqual([]);
  });

  it('answers bad credentials with the legacy failure redirect and records a strike for the username', async () => {
    const strikes = strikesOf(SITE_ADMIN_A);

    const { sid, body } = await loginAs(SITE_ADMIN_A, 'not-the-password');
    const current = await send(app, 'GET', '/v1/sessions/current', await sessionHeaders(sid));

    expect(body).toEqual({ outcome: 'failed', location: FAILED_LOGIN, epoch: 1 });
    expect(strikesOf(SITE_ADMIN_A)).toBe(strikes + 1);
    expect(current.json()).toMatchObject({ sessionId: sid, epoch: 1, user: { isLoggedIn: false }, roles: [] });
  });
});

describe('clogin.logout', () => {
  it('ends the signed-in session, bumping its epoch, and redirects to home.redirect', async () => {
    const { sid } = await loginAs(EDITOR, TEST_PASSWORDS.editor);
    const headers = await sessionHeaders(sid, [Roles.systemUser], EDITOR.account.userid);

    const res = await send(app, 'POST', '/v1/sessions/logout', headers);
    const current = await send(app, 'GET', '/v1/sessions/current', headers);
    const tokens = await send(app, 'POST', '/v1/csrf/tokens', headers, { contexts: ['login'] });

    expect(res.json()).toEqual({ redirect: { action: ADMIN_HOME_ACTION, params: {} } });
    expect(current.json()).toMatchObject({ sessionId: sid, epoch: 3, user: { isLoggedIn: false }, roles: [] });
    expect(tokens.statusCode).toBe(401);
  });
});

// clogin.main and home.redirect are web screens; identity answers the login-time roles above and this site list they read.
describe('the sites of a signed-in session', () => {
  it.each<[string, TestActor, string, string[], string[]]>([
    ['every registered site to the S2 admin', ADMIN_S2, TEST_PASSWORDS.admin, [Roles.s2], REGISTRY_ROWS.map((row) => String(row.site_id))],
    ['its own site to a member of the site Admin group', SITE_ADMIN_A, TEST_PASSWORDS.siteAdmin, [Roles.systemUser, Roles.siteAdmin], [TENANT_A.siteId]],
    ['no site to an editor without the Site Manager grant', EDITOR, TEST_PASSWORDS.editor, [Roles.systemUser], []],
  ])('lists %s', async (_label, actor, password, roles, siteIds) => {
    const { sid, body } = await loginAs(actor, password);

    const res = await send(app, 'GET', '/v1/sessions/current/sites', await sessionHeaders(sid, roles, actor.account.userid));

    expect(body.outcome).toBe('success');
    expect(res.json()).toEqual({ sites: siteIds.map((siteID) => ({ siteID, site: `Site ${siteID}` })) });
  });
});

describe('the forgot-password form', () => {
  it('sends the login mail through the login-mail domain and answers messagesent', async () => {
    const email = EDITOR.contact.email ?? '';

    const res = await send(app, 'POST', '/v1/login-mail', await headersFor('service:gateway'), new URLSearchParams({ email, siteid: '' }));

    expect(res.json()).toEqual({ status: 'messagesent' });
    expect(mails).toEqual([
      expect.objectContaining({ userId: EDITOR.account.userid, siteId: '', to: email, from: DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS.title, kind: 'forgot-password' }),
    ]);
  });
});

describe('sanitizeHref and removeLeadingDoubleSlash', () => {
  const ctx: HrefContext = {
    siteId: '',
    sessionSiteId: TENANT_A.siteId,
    allowedDomains: ['localhost', `${TENANT_A.siteId}.opt2.test`],
    siteDomain: (siteId) => `${siteId}.opt2.test`,
  };

  it.each([
    ['/feedback-thank-you/', '/feedback-thank-you/'],
    ['https://tenant-a.opt2.test/feedback/', 'https://tenant-a.opt2.test/feedback/'],
    ['https://external.com/feedback/', 'https://tenant-a.opt2.test/feedback/'],
    ['//external.com/path', '/external.com/path'],
    ['//evil.com/phishing', '/evil.com/phishing'],
  ])('sanitizeHref(%j) is %j', (href, expected) => {
    expect(sanitizeHref(href, ctx)).toBe(expected);
  });

  it.each([
    ['//x/y', '/x/y'],
    ['/x/y', '/x/y'],
  ])('removeLeadingDoubleSlash(%j) is %j', (url, expected) => {
    expect(removeLeadingDoubleSlash(url)).toBe(expected);
  });
});

describe('the public admin session routes of the composed service', () => {
  const PUBLIC_ROUTES: ReadonlyArray<[Method, string, Payload | undefined]> = [
    ['GET', '/v1/sessions/current', undefined],
    ['GET', '/v1/sessions/current/admin-state', undefined],
    ['POST', '/v1/sessions/current/admin-state', { siteid: TENANT_A.siteId }],
    ['POST', '/v1/sessions/login', new URLSearchParams({ username: 'qa_editor', password: 'x' })],
    ['POST', '/v1/sessions/logout', undefined],
    ['POST', '/v1/csrf/tokens', { contexts: ['login'] }],
    ['POST', '/v1/login-mail', { email: 'qa_editor@tenant-a.opt2.test' }],
  ];

  it.each(PUBLIC_ROUTES)('refuse %s %s with a user token but no invocation credential, before any statement', async (method, url, payload) => {
    const { authorization = '' } = await headersFor('editor');

    const res = await send(t.app, method, url, { authorization }, payload);

    expect(res.statusCode).toBe(401);
    expect(t.db.statements()).toEqual([]);
  });

  it.each(['service:gateway', 'service:web'])('serve an anonymous caller presenting only the %s invocation credential', async (caller) => {
    const headers = await headersFor(caller);

    const current = await send(t.app, 'GET', '/v1/sessions/current', headers);
    const logout = await send(t.app, 'POST', '/v1/sessions/logout', headers);

    expect(current.json()).toMatchObject({ sessionId: null, epoch: null, user: { isLoggedIn: false }, roles: [] });
    expect(logout.json()).toEqual({ redirect: { action: ADMIN_HOME_ACTION, params: {} } });
    expect(t.db.statements()).toEqual([]);
  });
});
