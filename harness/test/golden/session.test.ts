import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
} from '@opt2/platform/legacy-compat';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadCatalogue,
  scenarioById,
  type Catalogue,
  type Scenario,
  type SessionSpec,
  type Step,
} from '../../src/golden/catalogue.js';
import { GoldenConfigError, MissingSecretError } from '../../src/golden/errors.js';
import {
  ADMIN_LOGIN_PATH,
  SEED_CREDENTIALS_FILE,
  adminLogin,
  basicAuth,
  createScenarioContext,
  fetchFormTokens,
  jsonApiTokens,
  oauthClientCredentials,
  originBaseUrl,
  resolvePlaceholders,
  secretValues,
  session,
  type Origin,
  type ScenarioContext,
  type ScenarioInput,
} from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';
import type { EnvLike } from '../../src/lib/paths.js';

const LOGIN_PAGE = readFileSync(new URL('../fixtures/html/admin-login.html', import.meta.url), 'utf8');
const CATALOGUE_FIXTURE = fileURLToPath(new URL('../fixtures/golden/catalogue.valid.yaml', import.meta.url));

const LEGACY_PORT = '8500';
// Nothing listens on this port: every request goes to the scripted fake of its test.
const BASE = 'http://127.0.0.1:8500';
const GATEWAY = 'http://127.0.0.1:8100';
const FORM_TYPE = 'application/x-www-form-urlencoded';

const ADMIN_PASSWORD = 'FIXTURE-ADMIN-PASSWORD';
const EDITOR_PASSWORD = 'FIXTURE-EDITOR-PASSWORD';
const SEED_USER = 'fixture.siteadmin';
const SEED_PASSWORD = 'FIXTURE-SEED-PASSWORD-1';
const OAUTH_CLIENT = 'fixture-client';
const OAUTH_SECRET = 'FIXTURE-OAUTH-SECRET-1';
const GENERATED_NAME = 'pe01-created';
const GENERATED_VALUE = 'FIXTURE-GENERATED-1';
const ACCESS_TOKEN = 'FIXTURE-ACCESS-TOKEN-1';
const LOGIN_TOKEN = 'FIXTURECSRFTOKEN0000000000000001';
const API_TOKEN = 'FIXTURECSRFTOKEN0000000000000009';
const EXPIRES = '260630120000000';
const PAGE_ID = 'FIXTURE-PAGE-A-0001';
const CREATED_ID = 'FIXTURE-USER-CREATED-0001';
const NO_LOGIN: SessionSpec = { login: 'none', via: 'admin' };

// Shape of `SeedCredentials` (legacy-fixtures/seed/src/credentials.ts).
const CREDENTIALS = {
  sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f',
  digest: 'FIXTURE-DIGEST',
  users: { 'tenant-a': { [SEED_USER]: SEED_PASSWORD } },
  roles: { 'tenant-a': { 'site-admin': SEED_USER } },
  oauthClients: { [OAUTH_CLIENT]: OAUTH_SECRET },
  generated: { [GENERATED_NAME]: GENERATED_VALUE },
};

// Shape of `Dataset` as legacy-fixtures/seed/src/writer.ts writes `dataset.json`.
const DATASET = {
  sourceSha: '696383140578f8dea3ece26f80cd7bfb370ddf0f',
  seed: 20260601,
  businessDate: '2026-06-30',
  digest: 'FIXTURE-DIGEST',
  masa: {
    sites: [
      { siteID: 'tenant-a', site: 'Tenant A', orderNo: 1 },
      { siteID: 'tenant-b', site: 'Tenant B', orderNo: 2 },
    ],
    groups: [],
    users: [{ userID: 'FIXTURE-USER-0001', siteID: 'tenant-a', type: 2, isPublic: 0, username: SEED_USER }],
    memberships: [],
    categories: [],
    content: [
      { contentID: 'FIXTURE-FOLDER-A-0001', siteID: 'tenant-a', type: 'Folder', title: 'Folder A' },
      { contentID: 'FIXTURE-PAGE-B-0001', siteID: 'tenant-b', type: 'Page', title: 'Page B' },
      { contentID: PAGE_ID, siteID: 'tenant-a', type: 'Page', title: 'Page A' },
    ],
    files: [],
    oauthClients: [{ clientID: OAUTH_CLIENT, siteID: 'tenant-a', grantType: 'client_credentials' }],
  },
  fixtures: {},
};

/** Every placeholder kind, inside strings, nested objects and arrays, with text around them. */
const TEMPLATE = {
  route: '/admin/?muraAction=cUsers.edituser&userid=${create.data.id}&siteid=${seed.page.siteid}',
  form: {
    admin: 'admin:${secret:admin}',
    editor: '${secret:qa_editor}',
    seeded: ['${user:tenant-a:site-admin}', '<${secret:seed:fixture.siteadmin}>'],
    client: { id: OAUTH_CLIENT, secret: 'secret=${secret:oauth:fixture-client}' },
    generated: '${secret:generated:pe01-created}',
  },
  page: '${seed.page.contentid} (${seed.page.title})',
};

const RESOLVED = {
  route: `/admin/?muraAction=cUsers.edituser&userid=${CREATED_ID}&siteid=tenant-a`,
  form: {
    admin: `admin:${ADMIN_PASSWORD}`,
    editor: EDITOR_PASSWORD,
    seeded: [SEED_USER, `<${SEED_PASSWORD}>`],
    client: { id: OAUTH_CLIENT, secret: `secret=${OAUTH_SECRET}` },
    generated: GENERATED_VALUE,
  },
  page: `${PAGE_ID} (Page A)`,
};

/** One request the fake received; `form` is the decoded body of a form post. */
interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  form?: Record<string, string>;
}

/** Scripted answer to the requests `match` accepts. */
interface Route {
  match(method: string, url: URL, body: string): boolean;
  respond(): Response;
}

interface FakeFetch {
  fetch: FetchLike;
  calls: Call[];
  unmatched: string[];
}

const fakes: FakeFetch[] = [];
let catalogue: Catalogue;
let stateDir: string;
let env: EnvLike;

/** Fetch answering the first route that matches each request; any other request is recorded and rejected. */
function fakeFetch(...routes: Route[]): FakeFetch {
  const fake: FakeFetch = {
    calls: [],
    unmatched: [],
    fetch: async (input, init) => {
      const method = init.method ?? 'GET';
      const url = new URL(input);
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const { body: raw } = init;
      const body = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : '';
      const form = headers['content-type'] === FORM_TYPE ? Object.fromEntries(new URLSearchParams(body)) : undefined;
      fake.calls.push({ method, url, headers, body, ...(form === undefined ? {} : { form }) });
      const route = routes.find((r) => r.match(method, url, body));
      if (route === undefined) {
        fake.unmatched.push(`${method} ${url.pathname}${url.search}`);
        throw new Error(`unscripted request ${method} ${input}`);
      }
      return route.respond();
    },
  };
  fakes.push(fake);
  return fake;
}

/** Route for `method` on exactly `pathAndQuery`. */
function on(method: string, pathAndQuery: string, respond: () => Response): Route {
  return { match: (m, url) => m === method && `${url.pathname}${url.search}` === pathAndQuery, respond };
}

function html(markup: string, headers: [string, string][] = []): Response {
  return new Response(markup, { status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ...headers] });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function redirect(location: string, setCookie: string): Response {
  return new Response(null, { status: 302, headers: [['location', location], ['set-cookie', setCookie]] });
}

function writeJson(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function credentialsPath(): string {
  return join(stateDir, 'secrets', SEED_CREDENTIALS_FILE);
}

function context(scenario: ScenarioInput, fake: FakeFetch = fakeFetch(), ctxEnv: EnvLike = env): ScenarioContext {
  return createScenarioContext(scenario, { origin: 'legacy', env: ctxEnv, fetch: fake.fetch });
}

function stepOf(scenario: Scenario, name: string): Step {
  const step = scenario.steps.find((s) => s.name === name);
  if (step === undefined) throw new Error(`${scenario.id} has no step ${name}`);
  return step;
}

/** What `fn` throws. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

beforeAll(async () => {
  catalogue = await loadCatalogue(CATALOGUE_FIXTURE);
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'opt2-golden-session-'));
  env = {
    OPT2_STATE_DIR: stateDir,
    MURA_ADMIN_PASSWORD: ADMIN_PASSWORD,
    MASA_TEST_EDITOR_PASSWORD: EDITOR_PASSWORD,
    PORT: LEGACY_PORT,
  };
  writeJson(credentialsPath(), CREDENTIALS);
  writeJson(join(stateDir, 'seed', 'dataset.json'), DATASET);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const fake of fakes.splice(0)) expect(fake.unmatched).toStrictEqual([]);
});

describe('origins', () => {
  it.each<[Origin, EnvLike, string]>([
    ['legacy', { PORT: LEGACY_PORT }, BASE],
    ['gateway', {}, GATEWAY],
  ])('addresses the %s origin', (origin, originEnv, expected) => {
    expect(originBaseUrl(origin, originEnv)).toBe(expected);
  });

  it.each<[Origin, string]>([
    ['legacy', BASE],
    ['gateway', GATEWAY],
  ])('points every session of a %s context at that origin', async (origin, expected) => {
    const fake = fakeFetch(on('GET', '/', () => html('<p>ok</p>')));
    const ctx = createScenarioContext(
      { id: 'GS-ID-09', sessions: { admin: NO_LOGIN, editor: NO_LOGIN } },
      { origin, env, fetch: fake.fetch },
    );
    expect(ctx.baseUrl).toBe(expected);
    for (const s of ctx.sessions.values()) await s.get('/');
    expect(fake.calls.map((c) => c.url.href)).toStrictEqual([`${expected}/`, `${expected}/`]);
  });
});

describe('resolvePlaceholders', () => {
  it('resolves every placeholder kind in strings, nested objects and arrays, keeping surrounding text', () => {
    const scenario = scenarioById(catalogue, 'GS-CO-05');
    const ctx = context(scenario);
    ctx.bindings.set('create.data', { id: CREATED_ID });

    expect(resolvePlaceholders(TEMPLATE, ctx)).toStrictEqual(RESOLVED);
    expect(resolvePlaceholders(stepOf(scenario, 'findone').route, ctx)).toBe(
      `/index.cfm/_api/json/v1/tenant-a/content/${PAGE_ID}`,
    );
  });

  it("selects the scenario's seedRefs rows by their where filter", () => {
    const ctx = context(scenarioById(catalogue, 'GS-CO-05'));
    expect(ctx.seedRows.get('page')).toStrictEqual(DATASET.masa.content[2]);
  });

  it('resolves nested secret placeholders and step bindings of the sample catalogue', () => {
    const scenario = scenarioById(catalogue, 'GS-PE-01');
    const ctx = context(scenario);
    expect(resolvePlaceholders(stepOf(scenario, 'login').form, ctx)).toMatchObject({
      username: SEED_USER,
      password: SEED_PASSWORD,
    });

    ctx.bindings.set('form.userid', CREATED_ID);
    const create = stepOf(scenario, 'create');
    expect(resolvePlaceholders(create.route, ctx)).toBe(
      `/admin/?muraAction=cUsers.update&userid=${CREATED_ID}&routeid=`,
    );
    expect(resolvePlaceholders(create.form, ctx)).toMatchObject({
      passwordNoCache: GENERATED_VALUE,
      password2: GENERATED_VALUE,
    });
  });

  interface MissingCase {
    when: string;
    placeholder: string;
    /** Env var left unset, and so the source searched; otherwise the credential file is. */
    unsetEnv?: string;
    removeCredentials?: boolean;
  }

  it.each<MissingCase>([
    { when: 'MURA_ADMIN_PASSWORD is unset', placeholder: '${secret:admin}', unsetEnv: 'MURA_ADMIN_PASSWORD' },
    { when: 'the seed user is unknown', placeholder: '${secret:seed:fixture.nobody}' },
    { when: 'the OAuth client is unknown', placeholder: '${secret:oauth:fixture-unknown}' },
    {
      when: 'the credential file is absent',
      placeholder: '${secret:seed:fixture.siteadmin}',
      removeCredentials: true,
    },
  ])('raises MissingSecretError naming the placeholder when $when', (c) => {
    if (c.removeCredentials === true) rmSync(credentialsPath());
    const ctxEnv = c.unsetEnv === undefined ? env : { ...env, [c.unsetEnv]: undefined };
    const ctx = context({ id: 'GS-ID-05' }, fakeFetch(), ctxEnv);

    const err = thrown(() => resolvePlaceholders({ form: [`pw=${c.placeholder}`] }, ctx));
    expect(err).toBeInstanceOf(MissingSecretError);
    expect(err).toMatchObject({ placeholder: c.placeholder, source: c.unsetEnv ?? credentialsPath() });
  });

  it.each([
    ['a binding no step extracted', '${create.data.id}'],
    ['a seed alias the scenario does not declare', '${seed.absent.contentid}'],
    ['a role the credential file names no user for', '${user:tenant-a:fixture-role}'],
  ])('raises GoldenConfigError prefixed with the scenario id for %s', (_label, placeholder) => {
    const ctx = context({ id: 'GS-ID-05' });

    const err = thrown(() => resolvePlaceholders(`/route?value=${placeholder}`, ctx));
    expect(err).toBeInstanceOf(GoldenConfigError);
    expect((err as GoldenConfigError).message).toMatch(/^GS-ID-05: /);
    expect((err as GoldenConfigError).message).toContain(placeholder);
  });
});

describe('secretValues', () => {
  it('lists every resolved secret value and none of the non-secret ones', () => {
    const ctx = context(scenarioById(catalogue, 'GS-CO-05'));
    ctx.bindings.set('create.data', { id: CREATED_ID });
    expect(secretValues(ctx)).toStrictEqual([]);

    resolvePlaceholders(TEMPLATE, ctx);
    const values = secretValues(ctx);
    expect([...values].sort()).toStrictEqual(
      [ADMIN_PASSWORD, EDITOR_PASSWORD, SEED_PASSWORD, OAUTH_SECRET, GENERATED_VALUE].sort(),
    );
    for (const plain of ['tenant-a', SEED_USER, OAUTH_CLIENT, PAGE_ID, CREATED_ID]) expect(values).not.toContain(plain);
  });
});

describe('legacy authentication helpers', () => {
  const loginPage = (): Response => html(LOGIN_PAGE);

  it('posts the admin login form with its hidden fields and CSRF pair, then keeps the session cookie', async () => {
    const fake = fakeFetch(
      on('GET', ADMIN_LOGIN_PATH, loginPage),
      on('POST', '/admin/index.cfm', () => redirect('./', 'CFID=1001; Path=/')),
      on('GET', '/admin/', () => html('<h1>Site Content</h1>')),
    );
    const s = session(context({ id: 'GS-ID-01', sessions: { admin: NO_LOGIN } }, fake), 'admin');

    const { ok, result } = await adminLogin(s, { username: 'admin', password: ADMIN_PASSWORD });

    expect(ok).toBe(true);
    expect(result.url).toBe(`${BASE}/admin/`);
    expect(fake.calls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toStrictEqual([
      `GET ${ADMIN_LOGIN_PATH}`,
      'POST /admin/index.cfm',
      'GET /admin/',
    ]);
    const [, post, landing] = fake.calls;
    expect(post?.headers['content-type']).toBe(FORM_TYPE);
    expect(post?.form).toStrictEqual({
      username: 'admin',
      password: ADMIN_PASSWORD,
      returnUrl: '',
      muraAction: 'cLogin.login',
      isAdminLogin: 'true',
      compactDisplay: 'true',
      [CSRF_FIELD_TOKEN]: LOGIN_TOKEN,
      [CSRF_FIELD_EXPIRES]: EXPIRES,
    });
    expect(landing?.headers.cookie).toBe('CFID=1001');
    expect(await s.cookieHeader(BASE)).toContain('CFID=1001');
  });

  it.each([
    {
      form: 'form#loginForm',
      selector: 'form#loginForm' as string | undefined,
      token: LOGIN_TOKEN,
      action: '/admin/index.cfm',
      fields: { returnUrl: '', muraAction: 'cLogin.login', isAdminLogin: 'true', compactDisplay: 'true' },
    },
    {
      form: 'the default form',
      selector: undefined,
      token: LOGIN_TOKEN,
      action: '/admin/index.cfm',
      fields: { returnUrl: '', muraAction: 'cLogin.login', isAdminLogin: 'true', compactDisplay: 'true' },
    },
  ])('reads the CSRF pair, hidden fields and action of $form', async ({ selector, token, action, fields }) => {
    const fake = fakeFetch(on('GET', ADMIN_LOGIN_PATH, loginPage));
    const s = session(context({ id: 'GS-ID-04' }, fake));

    expect(await fetchFormTokens(s, ADMIN_LOGIN_PATH, selector)).toStrictEqual({
      token,
      expires: EXPIRES,
      fields,
      action,
      method: 'POST',
    });
  });

  it.each([
    {
      when: 'the page holds no CSRF field',
      path: '/admin/?muraAction=cMessage.noaccess',
      markup: '<form id="search"><input type="hidden" name="q" value=""></form>',
      selector: undefined as string | undefined,
    },
    // Legacy renders the send-login form without a CSRF pair (admin/core/views/clogin/main.cfm:303-330).
    { when: 'form#sendLogin holds none', path: ADMIN_LOGIN_PATH, markup: LOGIN_PAGE, selector: 'form#sendLogin' },
  ])('rejects with GoldenConfigError when $when', async ({ path, markup, selector }) => {
    const fake = fakeFetch(on('GET', path, () => html(markup)));
    const s = session(context({ id: 'GS-ID-02' }, fake));

    await expect(fetchFormTokens(s, path, selector)).rejects.toBeInstanceOf(GoldenConfigError);
  });

  it('turns generateCSRFTokens for a context into the JSON API CSRF headers', async () => {
    const csrfContext = 'FIXTURE context&1';
    const fake = fakeFetch({
      match: (m, url) => m === 'GET' && url.pathname === '/_api/json/v1/tenant-a/generateCSRFTokens',
      respond: () =>
        json({
          apiversion: 'v1',
          method: 'generateCSRFTokens',
          data: { [CSRF_FIELD_TOKEN]: API_TOKEN, [CSRF_FIELD_EXPIRES]: EXPIRES },
        }),
    });
    const s = session(context({ id: 'GS-CO-05' }, fake));

    expect(await jsonApiTokens(s, 'tenant-a', csrfContext)).toStrictEqual({
      [CSRF_HEADER_TOKEN]: API_TOKEN,
      [CSRF_HEADER_EXPIRES]: EXPIRES,
    });
    const [call] = fake.calls;
    expect(call?.method).toBe('GET');
    expect([...(call?.url.searchParams ?? [])]).toStrictEqual([['context', csrfContext]]);
  });

  it('encodes HTTP Basic credentials', () => {
    expect(basicAuth('qa_editor', EDITOR_PASSWORD)).toBe(
      `Basic ${Buffer.from(`qa_editor:${EDITOR_PASSWORD}`).toString('base64')}`,
    );
  });

  it('requests a client_credentials token with the client id and secret in the form body', async () => {
    const fake = fakeFetch(
      on('POST', '/_api/rest/v1/tenant-a/oauth2', () =>
        json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 }),
      ),
    );
    const s = session(context({ id: 'GS-ID-08' }, fake));

    const { accessToken, result } = await oauthClientCredentials(s, {
      site: 'tenant-a',
      clientId: OAUTH_CLIENT,
      secret: OAUTH_SECRET,
    });

    expect(accessToken).toBe(ACCESS_TOKEN);
    expect(result.status).toBe(200);
    const [call] = fake.calls;
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.form).toStrictEqual({
      grant_type: 'client_credentials',
      client_id: OAUTH_CLIENT,
      client_secret: OAUTH_SECRET,
    });
  });
});

describe('createScenarioContext', () => {
  const setsCookie = (): Route =>
    on('GET', '/admin/', () => html('<p>ok</p>', [['set-cookie', 'CFID=2002; Path=/']]));

  it('gives each named session its own cookie jar', async () => {
    const ctx = context({ id: 'GS-ID-09', sessions: { admin: NO_LOGIN, editor: NO_LOGIN } }, fakeFetch(setsCookie()));
    const admin = session(ctx, 'admin');
    const editor = session(ctx, 'editor');

    expect([...ctx.sessions.keys()]).toStrictEqual(['admin', 'editor']);
    expect(admin).not.toBe(editor);
    expect(admin.jar).not.toBe(editor.jar);
    await admin.get('/admin/');
    expect(await admin.cookieHeader()).toBe('CFID=2002');
    expect(await editor.cookieHeader()).toBe('');
  });

  it('shares no cookies or bindings between two contexts of one scenario', async () => {
    const scenario = scenarioById(catalogue, 'GS-ID-01');
    const fake = fakeFetch(setsCookie());
    const first = context(scenario, fake);
    const second = context(scenario, fake);

    expect(first.bindings.size).toBe(0);
    expect(second.bindings.size).toBe(0);
    await session(first, 'admin').get('/admin/');
    first.bindings.set('main.status', 200);

    expect(await session(first, 'admin').cookieHeader()).toBe('CFID=2002');
    expect(await session(second, 'admin').cookieHeader()).toBe('');
    expect(second.bindings.size).toBe(0);
  });
});
