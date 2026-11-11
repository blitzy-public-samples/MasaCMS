import { CSRF_HEADER_EXPIRES, CSRF_HEADER_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSpec } from '../../src/golden/catalogue.js';
import { GoldenConfigError, MissingSecretError } from '../../src/golden/errors.js';
import {
  adminLogin,
  basicAuth,
  createScenarioContext,
  fetchFormTokens,
  jsonApiLogin,
  jsonApiTokens,
  loginSession,
  loginSessions,
  oauthClientCredentials,
  publicLogin,
  session,
  type ScenarioContext,
  type SecretStore,
  type SeedStore,
} from '../../src/golden/session.js';
import { createHttpSession, type FetchLike, type HttpSession } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

// No listener on this port; every request goes to the scripted fetch of its test.
const BASE = 'http://127.0.0.1:8500';
const SCENARIO = 'GS-ID-01';
const LOGIN_PAGE = '/admin/?muraAction=clogin.main';
const TOKEN = 'FIXTURECSRFTOKEN0001';
const EXPIRES = '260101120000000';
const CHALLENGE_TOKEN = 'FIXTURECSRFTOKEN0000';
const OTHER_TOKEN = 'FIXTURECSRFTOKEN0002';
const OTHER_EXPIRES = '260101130000000';
const ADMIN_PASSWORD = 'FIXTURE-admin pass&word=1 ü';
const EDITOR_PASSWORD = 'FIXTURE-editor-password';
const MEMBER = 'FIXTURE-member';
const MEMBER_PASSWORD = 'FIXTURE-member-password';
const NO_PASSWORD_MEMBER = 'FIXTURE-nopass';
const CLIENT_ID = 'FIXTURE-client';
const CLIENT_SECRET = 'FIXTURE-client-secret';
const ACCESS_TOKEN = 'FIXTURE-access-token';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const SESSION_COOKIES = ['CFID=FIXTURE-cfid; Path=/; HttpOnly', 'CFTOKEN=FIXTURE-cftoken; Path=/; HttpOnly'];
const SESSION_COOKIE_HEADER = 'CFID=FIXTURE-cfid; CFTOKEN=FIXTURE-cftoken';
const MOBILE_COOKIE = 'mobileFormat=false; Path=/';

/** One request the scripted fetch received, headers as the session sent them (lower-cased names). */
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Next request a fake expects, and its answer. */
interface Exchange {
  method: 'GET' | 'POST';
  path: string;
  reply: Response;
}

interface FakeLegacy {
  fetch: FetchLike;
  calls: Call[];
  pending: Exchange[];
  unmatched: string[];
}

const fakes: FakeLegacy[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) {
    expect(fake.unmatched).toStrictEqual([]);
    expect(fake.pending.map((e) => `${e.method} ${e.path}`)).toStrictEqual([]);
  }
});

/** Fetch stub answering exactly `script`, in order; any other request is recorded and rejected. */
function fakeLegacy(...script: Exchange[]): FakeLegacy {
  const fake: FakeLegacy = {
    calls: [],
    pending: [...script],
    unmatched: [],
    fetch: async (url, init) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? init.body : undefined;
      fake.calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body });
      const next = fake.pending[0];
      if (next === undefined || next.method !== method || new URL(next.path, BASE).href !== url) {
        fake.unmatched.push(`${method} ${url}`);
        throw new Error(`unscripted request ${method} ${url}`);
      }
      fake.pending.shift();
      return next.reply;
    },
  };
  fakes.push(fake);
  return fake;
}

function cookieHeaders(setCookie: readonly string[]): [string, string][] {
  return setCookie.map((line) => ['set-cookie', line]);
}

function page(markup: string, opts: { status?: number; setCookie?: readonly string[] } = {}): Response {
  return new Response(`<!DOCTYPE html><html><body>${markup}</body></html>`, {
    status: opts.status ?? 200,
    headers: [['content-type', 'text/html; charset=utf-8'], ...cookieHeaders(opts.setCookie ?? [])],
  });
}

function redirect(location: string, setCookie: readonly string[] = []): Response {
  return new Response(null, { status: 302, headers: [['location', location], ...cookieHeaders(setCookie)] });
}

function json(body: unknown, status = 200, setCookie: readonly string[] = []): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: [['content-type', 'application/json; charset=utf-8'], ...cookieHeaders(setCookie)],
  });
}

function get(path: string, reply: Response): Exchange {
  return { method: 'GET', path, reply };
}

function post(path: string, reply: Response): Exchange {
  return { method: 'POST', path, reply };
}

function httpSession(fake: FakeLegacy): HttpSession {
  return createHttpSession({ baseUrl: BASE, fetch: fake.fetch });
}

/** Decoded fields of a call's form-encoded body, in order. */
function formFields(call: Call | undefined): [string, string][] {
  return [...new URLSearchParams(call?.body ?? '')];
}

/** The error `promise` rejects with, asserted to be a GoldenConfigError. */
async function configError(promise: Promise<unknown>): Promise<GoldenConfigError> {
  const err: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(GoldenConfigError);
  return err as GoldenConfigError;
}

function csrfInputs(token = TOKEN, expires = EXPIRES): string {
  return (
    `<input type="hidden" name="csrf_token" value="${token}" />` +
    `<input type="hidden" name="csrf_token_expires" value="${expires}" />`
  );
}

const ADMIN_CHALLENGE_FORM = `
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm">
  <input id="authcode" name="authcode" type="text" />
  <input type="hidden" name="muraAction" value="cLogin.login">
  <input type="hidden" name="status" value="challenge">
  ${csrfInputs(CHALLENGE_TOKEN)}
</form>`;

// Masa's admin login page: the MFA challenge form#loginForm, the credentials form#loginForm, then sendLogin.
const ADMIN_LOGIN_PAGE = `${ADMIN_CHALLENGE_FORM}
<form novalidate="novalidate" id="loginForm" name="frmLogin" method="post" action="index.cfm">
  <input id="username" name="username" type="text" autofocus="autofocus">
  <input id="password" type="password" name="password" autocomplete="off">
  <input type="checkbox" id="rememberMe" name="rememberMe" value="1">
  <input name="returnUrl" type="hidden">
  <input type="hidden" name="muraAction" value="cLogin.login">
  <input type="HIDDEN" name="isAdminLogin" value="true">
  <input type="hidden" name="compactDisplay" value="false">
  <input type="hidden" name="muraAction" value="cLogin.ignored">
  <input type="hidden" name="" value="unnamed">
  <input type="hidden" name="username" value="FIXTURE-hidden-username">
  ${csrfInputs()}
</form>
<form novalidate="novalidate" id="sendLogin" name="sendLogin" method="post" action="./?muraAction=cLogin.main">
  <input id="email" name="email" type="text">
  <input type="hidden" name="status" value="sendlogin" />
</form>`;

function adminPosted(username: string, password: string): [string, string][] {
  return [
    ['username', username],
    ['password', password],
    ['returnUrl', ''],
    ['muraAction', 'cLogin.login'],
    ['isAdminLogin', 'true'],
    ['compactDisplay', 'false'],
    ['csrf_token', TOKEN],
    ['csrf_token_expires', EXPIRES],
  ];
}

/** Accepted admin login: login page, POST redirected to home.redirect, then to the Site Content landing. */
function adminAccepted(setCookie: readonly string[] = SESSION_COOKIES): Exchange[] {
  return [
    get(LOGIN_PAGE, page(ADMIN_LOGIN_PAGE, { setCookie })),
    post('/admin/index.cfm', redirect('./?muraAction=home.redirect', [MOBILE_COOKIE])),
    get('/admin/?muraAction=home.redirect', redirect('./?muraAction=cArch.list&siteid=default')),
    get('/admin/?muraAction=cArch.list&siteid=default', page('<h1>Masa CMS - Site Content</h1>')),
  ];
}

/** Refused admin login: legacy redirects back to clogin.main. */
function adminRefused(): Exchange[] {
  return [
    get(LOGIN_PAGE, page(ADMIN_LOGIN_PAGE, { setCookie: SESSION_COOKIES })),
    post('/admin/index.cfm', redirect('./?muraAction=clogin.main&linkServID=')),
    get('/admin/?muraAction=clogin.main&linkServID=', page(ADMIN_LOGIN_PAGE)),
  ];
}

describe('adminLogin', () => {
  it.each([
    { cookies: 'CFID and CFTOKEN', setCookie: SESSION_COOKIES, sent: SESSION_COOKIE_HEADER },
    { cookies: 'JSESSIONID', setCookie: ['JSESSIONID=FIXTURE-jsession; Path=/'], sent: 'JSESSIONID=FIXTURE-jsession' },
  ])(
    'posts the credentials form#loginForm form-encoded with its hidden fields and CSRF pair and is ok with $cookies',
    async ({ setCookie, sent }) => {
      const fake = fakeLegacy(...adminAccepted(setCookie));
      const s = httpSession(fake);

      const { result, ok } = await adminLogin(s, { username: 'admin', password: ADMIN_PASSWORD });

      expect(ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.url).toBe(`${BASE}/admin/?muraAction=cArch.list&siteid=default`);
      expect(result.hops.map((hop) => hop.method)).toStrictEqual(['POST', 'GET', 'GET']);
      const login = fake.calls[1];
      expect(login?.headers['content-type']).toBe(FORM_TYPE);
      expect(login?.headers.cookie).toBe(sent);
      expect(formFields(login)).toStrictEqual(adminPosted('admin', ADMIN_PASSWORD));
      expect(login?.body).toContain('password=FIXTURE-admin+pass%26word%3D1+%C3%BC&');
      expect(fake.calls[2]).toMatchObject({ method: 'GET', body: undefined });
      expect(await s.cookieHeader()).toBe(`${sent}; mobileFormat=false`);
    },
  );

  it.each([
    { outcome: 'redirects back to clogin.main', script: adminRefused },
    {
      outcome: 'leaves clogin without setting a legacy session cookie',
      script: (): Exchange[] => [
        get(LOGIN_PAGE, page(ADMIN_LOGIN_PAGE, { setCookie: [MOBILE_COOKIE] })),
        post('/admin/index.cfm', redirect('./?muraAction=home.redirect')),
        get('/admin/?muraAction=home.redirect', page('<h1>FIXTURE dashboard</h1>')),
      ],
    },
  ])('is not ok when legacy $outcome', async ({ script }) => {
    const fake = fakeLegacy(...script());

    const { result, ok } = await adminLogin(httpSession(fake), { username: 'admin', password: ADMIN_PASSWORD });

    expect(ok).toBe(false);
    expect(result.hops[0]?.method).toBe('POST');
  });

  it.each([
    { content: 'no form#loginForm', markup: '<h1>FIXTURE maintenance</h1>', status: 503 },
    { content: 'only the challenge form#loginForm', markup: ADMIN_CHALLENGE_FORM, status: 200 },
  ])('throws GoldenConfigError without posting when the login page holds $content', async ({ markup, status }) => {
    const fake = fakeLegacy(get(LOGIN_PAGE, page(markup, { status })));

    const err = await configError(adminLogin(httpSession(fake), { username: 'admin', password: ADMIN_PASSWORD }));

    expect(err.message).toBe(`no admin login form at /admin/ (status ${status})`);
  });
});

const EDIT_USER = '/admin/?muraAction=cUsers.edituser&userid=FIXTURE-user-id&siteid=default';

const EDIT_USER_PAGE = `
<form id="globalSearch" action="./" method="get"><input type="hidden" name="muraAction" value="cArch.search"></form>
<form id="form1" name="form1" action="./?muraAction=cUsers.update&amp;userid=FIXTURE-user-id" method="post">
  <input type="text" name="fname" value="Fixture">
  <input type="hidden" name="siteid" value="default">
  <input type="hidden" name="action" value="update">
  <input type="hidden" name="siteid" value="ignored">
  ${csrfInputs()}
</form>
<form id="form2" action="./?muraAction=cUsers.update&amp;action=delete" method="post">
  <input type="hidden" name="action" value="delete">
  ${csrfInputs(OTHER_TOKEN, OTHER_EXPIRES)}
</form>`;

describe('fetchFormTokens', () => {
  const form1 = {
    token: TOKEN,
    expires: EXPIRES,
    fields: { siteid: 'default', action: 'update' },
    action: '/admin/?muraAction=cUsers.update&userid=FIXTURE-user-id',
    method: 'POST',
  };
  const form2 = {
    token: OTHER_TOKEN,
    expires: OTHER_EXPIRES,
    fields: { action: 'delete' },
    action: '/admin/?muraAction=cUsers.update&action=delete',
    method: 'POST',
  };

  it.each([
    { selector: undefined, shown: 'default form', expected: form1 },
    { selector: '#form2', shown: '#form2', expected: form2 },
    { selector: '#globalSearch, #form2', shown: '#globalSearch, #form2', expected: form2 },
  ])(
    'returns the first $shown match holding csrf_token, its other hidden fields, action and method',
    async ({ selector, expected }) => {
      const fake = fakeLegacy(get(EDIT_USER, page(EDIT_USER_PAGE, { setCookie: SESSION_COOKIES })));
      const s = httpSession(fake);

      await expect(fetchFormTokens(s, EDIT_USER, selector)).resolves.toStrictEqual(expected);
      expect(await s.cookieHeader()).toBe(SESSION_COOKIE_HEADER);
    },
  );

  it.each([
    { attrs: '', action: '/admin/?muraAction=cArch.edit&contenthistid=FIXTURE-hist', method: 'GET' },
    {
      attrs: 'action="  " method="post"',
      action: '/admin/?muraAction=cArch.edit&contenthistid=FIXTURE-hist',
      method: 'POST',
    },
    { attrs: 'action="index.cfm" method="Post"', action: '/admin/index.cfm', method: 'POST' },
    {
      attrs: `action="${BASE}/admin/?muraAction=cArch.update"`,
      action: '/admin/?muraAction=cArch.update',
      method: 'GET',
    },
    {
      attrs: 'action="https://sso.example.test/login?next=1" method="post"',
      action: 'https://sso.example.test/login?next=1',
      method: 'POST',
    },
  ])('resolves form attributes [$attrs] to action $action and method $method', async ({ attrs, action, method }) => {
    const path = '/admin/?muraAction=cArch.edit&contenthistid=FIXTURE-hist';
    const fake = fakeLegacy(get(path, page(`<form ${attrs}>${csrfInputs()}</form>`)));

    const tokens = await fetchFormTokens(httpSession(fake), path);

    expect(tokens).toStrictEqual({ token: TOKEN, expires: EXPIRES, fields: {}, action, method });
  });

  it('resolves an absent action against the page reached after redirects', async () => {
    const fake = fakeLegacy(
      get('/tenant-a/edit-profile/', redirect('/tenant-a/?display=editprofile')),
      get('/tenant-a/?display=editprofile', page(`<form method="post">${csrfInputs()}</form>`)),
    );

    const tokens = await fetchFormTokens(httpSession(fake), '/tenant-a/edit-profile/');

    expect(tokens.action).toBe('/tenant-a/?display=editprofile');
  });

  it('returns empty strings for a csrf_token without a value and an absent csrf_token_expires', async () => {
    const fake = fakeLegacy(get('/admin/', page('<form method="post"><input type="hidden" name="csrf_token"></form>')));

    const tokens = await fetchFormTokens(httpSession(fake), '/admin/');

    expect(tokens).toStrictEqual({ token: '', expires: '', fields: {}, action: '/admin/', method: 'POST' });
  });

  it.each([
    {
      selector: undefined,
      shown: 'the default form',
      markup: '<form action="./"><input type="hidden" name="muraAction" value="cArch.search"></form>',
      status: 200,
      message: 'no form with a csrf_token field at /admin/ (status 200)',
    },
    {
      selector: '#form3',
      shown: '#form3',
      markup: EDIT_USER_PAGE,
      status: 200,
      message: 'no #form3 with a csrf_token field at /admin/ (status 200)',
    },
    {
      selector: undefined,
      shown: 'the default form',
      markup: '<h1>FIXTURE not found</h1>',
      status: 404,
      message: 'no form with a csrf_token field at /admin/ (status 404)',
    },
  ])(
    'throws GoldenConfigError naming $shown when no match holds csrf_token (status $status)',
    async ({ selector, markup, status, message }) => {
      const fake = fakeLegacy(get(EDIT_USER, page(markup, { status })));

      const err = await configError(fetchFormTokens(httpSession(fake), EDIT_USER, selector));

      expect(err.message).toBe(message);
    },
  );
});

describe('jsonApiTokens', () => {
  it.each([
    { site: 'default', context: 'login', path: '/_api/json/v1/default/generateCSRFTokens?context=login' },
    {
      site: 'tenant a/b',
      context: 'FIXTURE-user-id&x=1',
      path: '/_api/json/v1/tenant%20a%2Fb/generateCSRFTokens?context=FIXTURE-user-id%26x%3D1',
    },
  ])('GETs generateCSRFTokens for site $site with context $context in the session', async ({ site, context, path }) => {
    const envelope = {
      apiversion: 'v1',
      method: 'generateCSRFTokens',
      params: { siteid: site, context, method: 'generateCSRFTokens' },
      data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES },
    };
    const fake = fakeLegacy(get(path, json(envelope)));
    const s = httpSession(fake);
    await s.jar.setCookie(SESSION_COOKIES[0] ?? '', BASE);

    const headers = await jsonApiTokens(s, site, context);

    expect(headers).toStrictEqual({ [CSRF_HEADER_TOKEN]: TOKEN, [CSRF_HEADER_EXPIRES]: EXPIRES });
    expect(Object.keys(headers)).toStrictEqual(['X-csrf_token', 'X-csrf_token_expires']);
    expect(fake.calls).toMatchObject([{ method: 'GET', url: `${BASE}${path}`, body: undefined }]);
    expect(fake.calls[0]?.headers.cookie).toBe('CFID=FIXTURE-cfid');
  });

  it.each([
    { shape: 'at the top level', body: { csrf_token: TOKEN, csrf_token_expires: EXPIRES } },
    { shape: 'under a null data', body: { data: null, csrf_token: TOKEN, csrf_token_expires: EXPIRES } },
    {
      shape: 'under data ahead of the top level',
      body: {
        data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES },
        csrf_token: OTHER_TOKEN,
        csrf_token_expires: OTHER_EXPIRES,
      },
    },
  ])('reads the CSRF pair $shape', async ({ body }) => {
    const fake = fakeLegacy(get('/_api/json/v1/default/generateCSRFTokens?context=login', json(body)));

    const headers = await jsonApiTokens(httpSession(fake), 'default', 'login');

    expect(headers).toStrictEqual({ [CSRF_HEADER_TOKEN]: TOKEN, [CSRF_HEADER_EXPIRES]: EXPIRES });
  });

  const withoutTokens = 'generateCSRFTokens for default answered 200 without CSRF tokens';
  const notJson = (status: number): string =>
    `generateCSRFTokens for default answered ${status} at /_api/json/v1/default/generateCSRFTokens without a JSON object`;

  it.each([
    { answer: 'an empty data object', reply: (): Response => json({ data: {} }), message: withoutTokens },
    {
      answer: 'an empty csrf_token',
      reply: (): Response => json({ data: { csrf_token: '', csrf_token_expires: EXPIRES } }),
      message: withoutTokens,
    },
    {
      answer: 'no csrf_token_expires',
      reply: (): Response => json({ data: { csrf_token: TOKEN } }),
      message: withoutTokens,
    },
    {
      answer: 'non-string tokens',
      reply: (): Response => json({ data: { csrf_token: 1, csrf_token_expires: 2 } }),
      message: withoutTokens,
    },
    {
      answer: 'an HTML error page',
      reply: (): Response => page(`<h1>FIXTURE error ${TOKEN}</h1>`, { status: 500 }),
      message: notJson(500),
    },
    { answer: 'a JSON array', reply: (): Response => json([TOKEN, EXPIRES]), message: notJson(200) },
  ])('throws GoldenConfigError, quoting no body, when legacy answers $answer', async ({ reply, message }) => {
    const fake = fakeLegacy(get('/_api/json/v1/default/generateCSRFTokens?context=login', reply()));

    const err = await configError(jsonApiTokens(httpSession(fake), 'default', 'login'));

    expect(err.message).toBe(message);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('basicAuth', () => {
  it.each([
    ['FIXTURE-user', 'FIXTURE-pass'],
    ['FIXTURE-ü', 'pa:ss word?>'],
  ])('encodes %s:%s as UTF-8 base64 behind "Basic "', (user, pass) => {
    const utf8 = String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`));

    expect(basicAuth(user, pass)).toBe(`Basic ${btoa(utf8)}`);
  });
});

describe('oauthClientCredentials', () => {
  const tokenPath = '/_api/rest/v1/tenant-a/oauth2';

  it.each([
    { shape: 'at the top level', body: { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 } },
    { shape: 'under data', body: { data: { access_token: ACCESS_TOKEN } } },
  ])(
    'posts client_credentials with the secret in the form body and returns the access_token $shape',
    async ({ body }) => {
      const fake = fakeLegacy(post(tokenPath, json(body)));

      const { accessToken, result } = await oauthClientCredentials(httpSession(fake), {
        site: 'tenant-a',
        clientId: CLIENT_ID,
        secret: CLIENT_SECRET,
      });

      expect(accessToken).toBe(ACCESS_TOKEN);
      expect(result.status).toBe(200);
      expect(result.json()).toStrictEqual(body);
      const call = fake.calls[0];
      expect(call?.url).toBe(`${BASE}${tokenPath}`);
      expect(call?.headers['content-type']).toBe(FORM_TYPE);
      expect(call?.headers.authorization).toBeUndefined();
      expect(formFields(call)).toStrictEqual([
        ['grant_type', 'client_credentials'],
        ['client_id', CLIENT_ID],
        ['client_secret', CLIENT_SECRET],
      ]);
    },
  );

  it.each([
    {
      answer: 'an invalid_client error',
      reply: (): Response => json({ error: 'invalid_client', error_description: 'FIXTURE description' }, 401),
      message: `OAuth token request for ${CLIENT_ID} answered 401 without access_token`,
    },
    {
      answer: 'an empty access_token',
      reply: (): Response => json({ access_token: '' }),
      message: `OAuth token request for ${CLIENT_ID} answered 200 without access_token`,
    },
    {
      answer: 'an HTML error page',
      reply: (): Response => page('<h1>FIXTURE bad gateway</h1>', { status: 502 }),
      message: `OAuth token request for ${CLIENT_ID} answered 502 at ${tokenPath} without a JSON object`,
    },
  ])('throws GoldenConfigError without the secret when legacy answers $answer', async ({ reply, message }) => {
    const fake = fakeLegacy(post(tokenPath, reply()));

    const err = await configError(
      oauthClientCredentials(httpSession(fake), { site: 'tenant-a', clientId: CLIENT_ID, secret: CLIENT_SECRET }),
    );

    expect(err.message).toBe(message);
    expect(err.message).not.toContain(CLIENT_SECRET);
  });
});

describe('jsonApiLogin', () => {
  const tokensPath = '/_api/json/v1/tenant-b/generateCSRFTokens?context=login';
  const loginPath = '/_api/json/v1/tenant-b/login';
  const tokens = (): Response =>
    json({ data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES } }, 200, SESSION_COOKIES);
  const member = { site: 'tenant-b', username: MEMBER, password: MEMBER_PASSWORD };

  it.each([
    { answer: { data: { status: 'success' } }, ok: true },
    { answer: { status: 'success' }, ok: true },
    { answer: { data: { status: 'failed' } }, ok: false },
    { answer: { data: { status: 'Invalid CSFR Tokens' } }, ok: false },
  ])('posts the credentials with login-context X-csrf_token headers; ok is $ok for $answer', async ({ answer, ok }) => {
    const fake = fakeLegacy(get(tokensPath, tokens()), post(loginPath, json(answer)));
    const s = httpSession(fake);

    const login = await jsonApiLogin(s, member);

    expect(login.ok).toBe(ok);
    expect(login.result.url).toBe(`${BASE}${loginPath}`);
    const call = fake.calls[1];
    expect(call?.headers).toMatchObject({
      'x-csrf_token': TOKEN,
      'x-csrf_token_expires': EXPIRES,
      'content-type': FORM_TYPE,
      cookie: SESSION_COOKIE_HEADER,
    });
    expect(formFields(call)).toStrictEqual([
      ['username', MEMBER],
      ['password', MEMBER_PASSWORD],
    ]);
    expect(await s.cookieHeader()).toBe(SESSION_COOKIE_HEADER);
  });

  it('throws GoldenConfigError when the login answer is not a JSON object', async () => {
    const fake = fakeLegacy(
      get(tokensPath, tokens()),
      post(loginPath, page('<h1>FIXTURE error</h1>', { status: 500 })),
    );

    const err = await configError(jsonApiLogin(httpSession(fake), member));

    expect(err.message).toBe(`JSON API login on tenant-b answered 500 at ${loginPath} without a JSON object`);
  });

  it('does not post the credentials when generateCSRFTokens yields no tokens', async () => {
    const fake = fakeLegacy(get(tokensPath, json({ data: {} })));

    const err = await configError(jsonApiLogin(httpSession(fake), member));

    expect(err.message).toBe('generateCSRFTokens for tenant-b answered 200 without CSRF tokens');
    expect(fake.calls).toHaveLength(1);
  });
});

const PUBLIC_LOGIN = '/tenant-a/?display=login';

// Masa's login display object: the MFA challenge form, the credentials form, then the send-login form.
const PUBLIC_LOGIN_PAGE = `
<form role="form" id="login" class="mura-login-form" name="frmLogin" method="post" novalidate="novalidate">
  <input type="text" id="txtUsername" name="authcode">
  ${csrfInputs(CHALLENGE_TOKEN)}
  <input type="hidden" name="doaction" value="login">
  <input type="hidden" name="status" value="challenge">
</form>
<form role="form" id="login" class="mura-login-form" name="frmLogin" method="post" novalidate="novalidate">
  <input type="text" id="txtUsername" name="username">
  <input type="password" id="txtPassword" name="password" autocomplete="off">
  <input type="checkbox" id="cbRememberMe" name="rememberMe" value="1">
  <input type="hidden" name="doaction" value="login">
  <input type="hidden" name="linkServID" value="">
  <input type="hidden" name="returnURL" value="/tenant-a/members/">
  ${csrfInputs()}
</form>
<form name="form2" class="mura-send-login" method="post" id="sendLogin" novalidate="novalidate">
  <input id="txtEmail" name="email" type="text">
  <input type="hidden" name="doaction" value="sendlogin">
</form>`;

const FAILED_QUERY = 'rememberMe=0&contentid=&LinkServID=&returnURL=%2Ftenant-a%2Fmembers%2F';

/** Accepted public login: login page, POST redirected to returnURL. */
function publicAccepted(setCookie: readonly string[] = SESSION_COOKIES): Exchange[] {
  return [
    get(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE, { setCookie })),
    post(PUBLIC_LOGIN, redirect('/tenant-a/members/')),
    get('/tenant-a/members/', page('<h1>FIXTURE members</h1>')),
  ];
}

describe('publicLogin', () => {
  it.each([
    { outcome: 'redirects to returnURL', script: publicAccepted, ok: true },
    {
      outcome: 'redirects with status=failed after other parameters',
      script: (): Exchange[] => [
        get(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE, { setCookie: SESSION_COOKIES })),
        post(PUBLIC_LOGIN, redirect(`/tenant-a/?display=login&status=failed&${FAILED_QUERY}`)),
        get(`/tenant-a/?display=login&status=failed&${FAILED_QUERY}`, page(PUBLIC_LOGIN_PAGE)),
      ],
      ok: false,
    },
    {
      outcome: 'redirects with STATUS=FAILED first',
      script: (): Exchange[] => [
        get(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE, { setCookie: SESSION_COOKIES })),
        post(PUBLIC_LOGIN, redirect(`/tenant-a/?STATUS=FAILED&${FAILED_QUERY}`)),
        get(`/tenant-a/?STATUS=FAILED&${FAILED_QUERY}`, page(PUBLIC_LOGIN_PAGE)),
      ],
      ok: false,
    },
    {
      outcome: 'renders the login form in place',
      script: (): Exchange[] => [
        get(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE, { setCookie: SESSION_COOKIES })),
        post(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE)),
      ],
      ok: false,
    },
  ])(
    'posts the password form to its own page with hidden fields and CSRF pair; ok is $ok when legacy $outcome',
    async ({ script, ok }) => {
      const fake = fakeLegacy(...script());
      const s = httpSession(fake);

      const login = await publicLogin(s, { site: 'tenant-a', username: MEMBER, password: MEMBER_PASSWORD });

      expect(login.ok).toBe(ok);
      const call = fake.calls[1];
      expect(call?.headers['content-type']).toBe(FORM_TYPE);
      expect(call?.headers.cookie).toBe(SESSION_COOKIE_HEADER);
      expect(formFields(call)).toStrictEqual([
        ['doaction', 'login'],
        ['linkServID', ''],
        ['returnURL', '/tenant-a/members/'],
        ['username', MEMBER],
        ['password', MEMBER_PASSWORD],
        ['csrf_token', TOKEN],
        ['csrf_token_expires', EXPIRES],
      ]);
      expect(await s.cookieHeader()).toBe(SESSION_COOKIE_HEADER);
    },
  );

  it('throws GoldenConfigError without posting when no password form holds csrf_token', async () => {
    const markup = `
<form id="login" method="post"><input type="text" name="authcode">${csrfInputs(CHALLENGE_TOKEN)}</form>
<form action="?nocache=1" name="loginForm" method="post"><input type="password" name="password"></form>`;
    const fake = fakeLegacy(get(PUBLIC_LOGIN, page(markup)));

    const err = await configError(
      publicLogin(httpSession(fake), { site: 'tenant-a', username: MEMBER, password: MEMBER_PASSWORD }),
    );

    expect(err.message).toBe('no form:has(input[name="password"]) with a csrf_token field at /tenant-a/ (status 200)');
  });
});

interface FakeSecrets extends SecretStore {
  /** Lookups in order, `secret:<name>` or `user:<site>:<role>`. */
  asked: string[];
}

/** Secret store over fixed placeholder values; unknown names throw as the real store does. */
function fakeSecrets(): FakeSecrets {
  const secrets: Record<string, string> = {
    admin: ADMIN_PASSWORD,
    qa_editor: EDITOR_PASSWORD,
    [`seed:${MEMBER}`]: MEMBER_PASSWORD,
  };
  const usernames: Record<string, string> = {
    'tenant-a:member': MEMBER,
    'tenant-b:member': MEMBER,
    'tenant-a:nopass': NO_PASSWORD_MEMBER,
  };
  const asked: string[] = [];
  const returned = new Set<string>();
  return {
    asked,
    secret(name) {
      asked.push(`secret:${name}`);
      const value = secrets[name];
      if (value === undefined) throw new MissingSecretError(`\${secret:${name}}`, 'FIXTURE-secrets');
      returned.add(value);
      return value;
    },
    username(site, role) {
      asked.push(`user:${site}:${role}`);
      const value = usernames[`${site}:${role}`];
      if (value === undefined) throw new GoldenConfigError(`\${user:${site}:${role}} has no username`);
      return value;
    },
    values: () => [...returned],
  };
}

const NO_SEED: SeedStore = {
  select: (ref) => {
    throw new GoldenConfigError(`no seed row for ${ref.as}`);
  },
  businessDate: () => '2026-01-01',
};

/** Legacy-origin context over `fake` with fresh fake secrets; `env` never touches process.env. */
function scenarioContext(
  fake: FakeLegacy,
  sessions: Record<string, SessionSpec> | undefined,
  env: EnvLike = {},
): { ctx: ScenarioContext; secrets: FakeSecrets } {
  const secrets = fakeSecrets();
  const ctx = createScenarioContext(
    { id: SCENARIO, sessions },
    { origin: 'legacy', env: { LEGACY_ORIGIN: `${BASE}/`, ...env }, fetch: fake.fetch, secrets, seed: NO_SEED },
  );
  return { ctx, secrets };
}

const ADMIN_SPEC: SessionSpec = { login: 'admin', via: 'admin' };
const EDITOR_SPEC: SessionSpec = { login: 'qa_editor', via: 'admin' };
const API_SPEC: SessionSpec = { login: 'seed:tenant-b:member', via: 'jsonapi' };
const PUBLIC_SPEC: SessionSpec = { login: 'seed:tenant-a:member', via: 'public' };
const REST_SPEC: SessionSpec = { login: 'none', via: 'rest-basic' };

describe('loginSession', () => {
  it.each([
    { spec: ADMIN_SPEC, env: {}, username: 'admin', password: ADMIN_PASSWORD, asked: ['secret:admin'] },
    {
      spec: ADMIN_SPEC,
      env: { MURA_ADMIN_USERNAME: '' },
      username: 'admin',
      password: ADMIN_PASSWORD,
      asked: ['secret:admin'],
    },
    {
      spec: ADMIN_SPEC,
      env: { MURA_ADMIN_USERNAME: 'FIXTURE-admin' },
      username: 'FIXTURE-admin',
      password: ADMIN_PASSWORD,
      asked: ['secret:admin'],
    },
    { spec: EDITOR_SPEC, env: {}, username: 'qa_editor', password: EDITOR_PASSWORD, asked: ['secret:qa_editor'] },
  ])(
    'logs login $spec.login in through the admin login form as $username (env $env)',
    async ({ spec, env, username, password, asked }) => {
      const fake = fakeLegacy(...adminAccepted());
      const { ctx, secrets } = scenarioContext(fake, { editor: spec }, env);

      await loginSession(ctx, 'editor', spec);

      expect(formFields(fake.calls[1])).toStrictEqual(adminPosted(username, password));
      expect(secrets.asked).toStrictEqual(asked);
      expect(await session(ctx, 'editor').cookieHeader()).toBe(`${SESSION_COOKIE_HEADER}; mobileFormat=false`);
    },
  );

  it.each([
    {
      spec: API_SPEC,
      script: (): Exchange[] => [
        get(
          '/_api/json/v1/tenant-b/generateCSRFTokens?context=login',
          json({ data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES } }),
        ),
        post('/_api/json/v1/tenant-b/login', json({ data: { status: 'success' } })),
      ],
      asked: ['user:tenant-b:member', `secret:seed:${MEMBER}`],
    },
    {
      spec: PUBLIC_SPEC,
      script: publicAccepted,
      asked: ['user:tenant-a:member', `secret:seed:${MEMBER}`],
    },
  ])('logs seeded login $spec.login in via $spec.via on the site that stores it', async ({ spec, script, asked }) => {
    const fake = fakeLegacy(...script());
    const { ctx, secrets } = scenarioContext(fake, { member: spec });

    await loginSession(ctx, 'member', spec);

    expect(formFields(fake.calls[1])).toEqual(
      expect.arrayContaining([
        ['username', MEMBER],
        ['password', MEMBER_PASSWORD],
      ]),
    );
    expect(secrets.asked).toStrictEqual(asked);
  });

  it.each<{ spec: SessionSpec }>([
    { spec: { login: 'none', via: 'admin' } },
    { spec: { login: 'admin', via: 'rest-basic' } },
    { spec: { login: 'seed:tenant-a:member', via: 'client-credentials' } },
  ])('sends nothing and reads no secret for login $spec.login via $spec.via', async ({ spec }) => {
    const fake = fakeLegacy();
    const { ctx, secrets } = scenarioContext(fake, { rest: spec });

    await loginSession(ctx, 'rest', spec);

    expect(fake.calls).toStrictEqual([]);
    expect(secrets.asked).toStrictEqual([]);
    expect(await session(ctx, 'rest').cookieHeader()).toBe('');
  });

  it.each([
    {
      spec: EDITOR_SPEC,
      script: adminRefused,
      message: `${SCENARIO}: session member could not log in as qa_editor via admin (status 200 at /admin/)`,
    },
    {
      spec: API_SPEC,
      script: (): Exchange[] => [
        get(
          '/_api/json/v1/tenant-b/generateCSRFTokens?context=login',
          json({ data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES } }),
        ),
        post('/_api/json/v1/tenant-b/login', json({ data: { status: 'failed' } })),
      ],
      message: `${SCENARIO}: session member could not log in as ${MEMBER} via jsonapi (status 200 at /_api/json/v1/tenant-b/login)`,
    },
    {
      spec: PUBLIC_SPEC,
      script: (): Exchange[] => [
        get(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE)),
        post(PUBLIC_LOGIN, page(PUBLIC_LOGIN_PAGE)),
      ],
      message: `${SCENARIO}: session member could not log in as ${MEMBER} via public (status 200 at /tenant-a/)`,
    },
  ])(
    'throws GoldenConfigError naming session, account and via, never the password, when $spec.via refuses',
    async ({ spec, script, message }) => {
      const fake = fakeLegacy(...script());
      const { ctx } = scenarioContext(fake, { member: spec });

      const err = await configError(loginSession(ctx, 'member', spec));

      expect(err.message).toBe(message);
      expect(err.message).not.toMatch(/FIXTURE-(editor|member)-password/);
    },
  );

  it.each([
    { login: 'FIXTURE-unknown', message: `${SCENARIO}: unknown session login FIXTURE-unknown` },
    { login: 'seed:tenant-a:ghost', message: `${SCENARIO}: \${user:tenant-a:ghost} has no username` },
  ])('throws a scenario-prefixed GoldenConfigError without a request for login $login', async ({ login, message }) => {
    const spec = { login, via: 'admin' } as SessionSpec;
    const fake = fakeLegacy();
    const { ctx } = scenarioContext(fake, { member: spec });

    const err = await configError(loginSession(ctx, 'member', spec));

    expect(err.message).toBe(message);
    expect(err.cause).toBeInstanceOf(GoldenConfigError);
    expect(fake.calls).toStrictEqual([]);
  });

  it('propagates MissingSecretError unprefixed when a seeded account has no password', async () => {
    const spec: SessionSpec = { login: 'seed:tenant-a:nopass', via: 'public' };
    const fake = fakeLegacy();
    const { ctx } = scenarioContext(fake, { member: spec });

    const err: unknown = await loginSession(ctx, 'member', spec).catch((reason: unknown) => reason);

    expect(err).toBeInstanceOf(MissingSecretError);
    expect((err as MissingSecretError).placeholder).toBe(`\${secret:seed:${NO_PASSWORD_MEMBER}}`);
  });

  it('throws GoldenConfigError for a session the scenario does not declare', async () => {
    const fake = fakeLegacy();
    const { ctx } = scenarioContext(fake, { editor: EDITOR_SPEC });

    const err = await configError(loginSession(ctx, 'ghost', EDITOR_SPEC));

    expect(err.message).toBe(`${SCENARIO}: no session ghost; declared: editor`);
  });
});

describe('loginSessions', () => {
  it('logs every declared session in, in declaration order, each into its own cookie jar', async () => {
    const editorCookies = ['CFID=FIXTURE-cfid-editor; Path=/', 'CFTOKEN=FIXTURE-cftoken-editor; Path=/'];
    const apiCookies = ['CFID=FIXTURE-cfid-api; Path=/', 'CFTOKEN=FIXTURE-cftoken-api; Path=/'];
    const fake = fakeLegacy(
      ...adminAccepted(editorCookies),
      get(
        '/_api/json/v1/tenant-b/generateCSRFTokens?context=login',
        json({ data: { csrf_token: TOKEN, csrf_token_expires: EXPIRES } }, 200, apiCookies),
      ),
      post('/_api/json/v1/tenant-b/login', json({ data: { status: 'success' } })),
    );
    const sessions = { editor: EDITOR_SPEC, rest: REST_SPEC, api: API_SPEC };
    const { ctx, secrets } = scenarioContext(fake, sessions);

    await loginSessions(ctx, { sessions });

    expect(secrets.asked).toStrictEqual(['secret:qa_editor', 'user:tenant-b:member', `secret:seed:${MEMBER}`]);
    expect(fake.calls.at(-1)?.headers.cookie).toBe('CFID=FIXTURE-cfid-api; CFTOKEN=FIXTURE-cftoken-api');
    expect(await session(ctx, 'editor').cookieHeader()).toBe(
      'CFID=FIXTURE-cfid-editor; CFTOKEN=FIXTURE-cftoken-editor; mobileFormat=false',
    );
    expect(await session(ctx, 'api').cookieHeader()).toBe('CFID=FIXTURE-cfid-api; CFTOKEN=FIXTURE-cftoken-api');
    expect(await session(ctx, 'rest').cookieHeader()).toBe('');
  });

  it.each([{ scenario: {} }, { scenario: { sessions: {} } }])('sends nothing for $scenario', async ({ scenario }) => {
    const fake = fakeLegacy();
    const { ctx, secrets } = scenarioContext(fake, undefined);

    await loginSessions(ctx, scenario);

    expect(fake.calls).toStrictEqual([]);
    expect(secrets.asked).toStrictEqual([]);
  });

  it('stops at the first session legacy refuses, leaving later sessions logged out', async () => {
    const fake = fakeLegacy(...adminRefused());
    const sessions = { editor: EDITOR_SPEC, api: API_SPEC };
    const { ctx, secrets } = scenarioContext(fake, sessions);

    const err = await configError(loginSessions(ctx, { sessions }));

    expect(err.message).toBe(
      `${SCENARIO}: session editor could not log in as qa_editor via admin (status 200 at /admin/)`,
    );
    expect(secrets.asked).toStrictEqual(['secret:qa_editor']);
    expect(await session(ctx, 'api').cookieHeader()).toBe('');
  });
});
