// The handlers' request pipeline in every response mode, over a test screen registry and the loopback gateway fake.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import type { ScreenGate } from '@/lib/access-gate';
import { GatewayUnavailableError, setServiceClientForTests } from '@/lib/gateway-client';
import { html } from '@/lib/html';
import { ensureTracing, logRequest, type RequestLogFields } from '@/lib/telemetry';
import type {
  PageControllerRedirect,
  ScreenContext,
  ScreenRequestBody,
  SubmitResult,
  UploadPart,
} from '@/screens/registry';
import { promptCountsZero } from '../fixtures/strategies-content/prompts';
import { siteRecordFor } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway, type RecordedRequest } from '../helpers/fake-gateway';
import { SUBJECTS, gatewayInvocation, serviceInvocation, userTokenFor } from '../helpers/tokens';

const probe = vi.hoisted(() => ({
  submit: undefined as SubmitResult | undefined,
  uploads: undefined as readonly UploadPart[] | undefined,
  body: undefined as ScreenRequestBody | undefined,
  inspect: undefined as ((ctx: ScreenContext) => Promise<void>) | undefined,
  renderError: undefined as Error | undefined,
  redirect: undefined as PageControllerRedirect | undefined,
  /** The controller step answers through a promise, as one that calls a service does. */
  deferRedirect: false,
  steps: [] as string[],
}));

vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(async () => undefined),
  logRequest: vi.fn(),
}));

vi.mock('@/screens/registry', async () => {
  const { html: markup, raw } = await import('@/lib/html');
  const secured: ScreenGate = (req, { secure }) => (req.isLoggedIn ? { kind: 'allow' } : secure());
  const open: ScreenGate = () => ({ kind: 'allow' });
  const base = { owner: 'people', gate: open };
  const submitted = async (ctx: ScreenContext): Promise<SubmitResult> => {
    probe.body = ctx.body;
    await probe.inspect?.(ctx);
    if (probe.submit === undefined) throw new Error('No submit outcome installed');
    return probe.submit;
  };
  const screens = [
    {
      ...base,
      circuit: 'cusers',
      action: 'list',
      mode: 'page',
      gate: secured,
      load: async (ctx: ScreenContext) => {
        await ctx.csrf.prefetch(['listcontext']);
        return 3;
      },
      render: (ctx: ScreenContext, count: number) => {
        if (probe.renderError !== undefined) throw probe.renderError;
        const view = markup`<div id="view">${count} ${ctx.req.session.dateKeyFormat}</div>`;
        return { body: markup`${view}${ctx.csrf.render('listcontext')}` };
      },
    },
    { ...base, circuit: 'cusers', action: 'update', mode: 'redirect', submit: submitted },
    {
      ...base,
      circuit: 'carch',
      action: 'list',
      mode: 'page',
      load: (ctx: ScreenContext) => {
        ctx.req = { ...ctx.req, sessionWrites: { ...ctx.req.sessionWrites, moduleid: '00000000000000000000000000000000003' } };
        return Promise.resolve('derived');
      },
      render: (_ctx: ScreenContext, text: string) => ({ body: markup`<p id="derived">${text}</p>` }),
    },
    {
      ...base,
      circuit: 'carch',
      action: 'loadsitemanager',
      mode: 'json',
      json: () => ({ contentType: 'application/json; charset=utf-8', body: new TextEncoder().encode('{"a" : 1}') }),
    },
    {
      ...base,
      circuit: 'cusers',
      action: 'download',
      mode: 'download',
      download: () => ({
        contentType: 'text/csv',
        body: 'a,b\n',
        headers: { 'Content-Disposition': 'attachment;filename=users.csv' },
        setCookies: ['download=1'],
      }),
    },
    {
      ...base,
      circuit: 'carch',
      action: 'loaddiff',
      mode: 'fragment',
      load: async () => 'diff',
      render: (_ctx: ScreenContext, text: string) => ({
        contentType: 'text/html;charset=UTF-8',
        body: markup`<p>${text}</p>`,
      }),
    },
    {
      ...base,
      circuit: 'csettings',
      action: 'list',
      mode: 'page',
      gate: secured,
      redirect: () => {
        probe.steps.push('redirect');
        return probe.deferRedirect ? Promise.resolve(probe.redirect) : probe.redirect;
      },
      load: async () => {
        probe.steps.push('load');
        return 'sites';
      },
      render: (_ctx: ScreenContext, text: string) => {
        probe.steps.push('render');
        return { body: markup`<p id="sites">${text}</p>` };
      },
    },
    ...(['fragment', 'json', 'download'] as const).map((mode) => ({
      owner: 'people',
      circuit: 'cgateless',
      action: mode,
      mode,
      [mode === 'fragment' ? 'render' : mode]: () => ({ contentType: 'text/plain', body: `${mode} body` }),
    })),
  ];
  const opt2Screen = {
    module: 'timesheets',
    screen: 'sheets',
    roles: [],
    service: 'timesheets',
    gate: secured,
    load: async () => 'sheets',
    render: (_ctx: ScreenContext, text: string) => ({
      body: markup`<p id="opt2">${text}</p>`,
      opt2Module: 'timesheets',
    }),
  };
  const opt2Action = {
    module: 'timesheets',
    action: 'day-action',
    roles: [],
    service: 'timesheets',
    submit: submitted,
  };
  return {
    findScreen: (circuit: string, action: string, _rc: unknown, uploads?: readonly UploadPart[]) => {
      probe.uploads = uploads;
      return screens.find((screen) => screen.circuit === circuit && screen.action === action);
    },
    findOpt2Screen: (module: string, screen: string) =>
      module === opt2Screen.module && screen === opt2Screen.screen ? opt2Screen : undefined,
    findOpt2Action: (module: string, action: string) =>
      module === opt2Action.module && action === opt2Action.action ? opt2Action : undefined,
    shellHooks: { secondaryMenus: {}, contentNav: () => raw('') },
  };
});

const { handleAdminAction, handleAdminPage, handleAdminRaw, handleOpt2Action, renderAdminPage, renderOpt2Page } =
  await import('@/lib/handlers');

const admin = SUBJECTS.admin;
const CURRENT_SESSION = routeKey('GET', 'identity', '/v1/sessions/current');
const ADMIN_STATE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
const FORM = 'application/x-www-form-urlencoded';
const LIST = { circuit: 'cusers', action: 'list' } as const;
const UPDATE = { circuit: 'cusers', action: 'update' } as const;

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

/** identity, programs-sites and strategies-content answering the S2 admin on `default`, and anonymous requests. */
function installRoutes(): void {
  const memberships = 'S2IsPrivate;default,S2IsPrivate,S2';
  fake.setRoute(CURRENT_SESSION, {
    status: 200,
    body: {
      sessionId: admin.sid,
      epoch: 0,
      user: { isLoggedIn: true, userID: admin.sub, siteID: admin.site, memberships, fname: 'Admin', lname: 'User' },
      roles: [...admin.roles],
      mfaPending: false,
      blockLoginUntil: null,
    },
  });
  fake.setRoute(routeKey('GET', 'identity', '/v1/sessions/current/sites'), {
    status: 200,
    body: { sites: [{ siteID: 'default', site: 'Default' }] },
  });
  fake.setRoute(ADMIN_STATE, { status: 200, body: {} });
  fake.setRoute(SAVE_ADMIN_STATE, (request) => ({ status: 200, body: request.json ?? {} }));
  fake.setRoute(routeKey('POST', 'identity', '/v1/csrf/tokens'), (request) => ({
    status: 200,
    body: {
      tokens: (request.json as { contexts: string[] }).contexts.map((context) => ({
        context,
        csrf_token: `TOKEN-${context}`,
        csrf_token_expires: '260630150000000',
      })),
    },
  }));
  fake.setRoute(routeKey('GET', 'programs-sites', '/v1/sites/default/shell'), {
    status: 200,
    body: { site: siteRecordFor('default'), isNew: 0 },
  });
  fake.setRoute(routeKey('GET', 'programs-sites', '/v1/user-sites'), {
    status: 200,
    body: {
      sites: [{ siteid: 'default', site: 'Default', orderno: 1, domain: 'localhost', domainAlias: null, showDashboard: 0 }],
    },
  });
  fake.setRoute(routeKey('GET', 'programs-sites', '/v1/href-domains'), {
    status: 200,
    body: { allowedDomains: ['localhost'], siteDomain: 'localhost' },
  });
  fake.setRoute(routeKey('GET', 'strategies-content', '/v1/sites/default/header-prompts'), {
    status: 200,
    body: promptCountsZero,
  });
}

beforeEach(async () => {
  fake = await startFakeGateway();
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
  installRoutes();
  vi.mocked(logRequest).mockClear();
  Object.assign(probe, {
    submit: undefined,
    uploads: undefined,
    body: undefined,
    inspect: undefined,
    renderError: undefined,
    redirect: undefined,
    deferRedirect: false,
    steps: [],
  });
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

/** Headers the gateway forwards for the S2 admin, or for an anonymous browser. */
async function forwarded(user: 'admin' | 'anonymous' = 'admin', extra: HeadersInit = {}): Promise<Headers> {
  const headers = new Headers({
    [INVOCATION_HEADER]: `Bearer ${await gatewayInvocation()}`,
    'x-forwarded-host': 'localhost',
    'x-forwarded-proto': 'http',
    'x-request-id': 'req-pipeline',
  });
  const token = user === 'admin' ? await userTokenFor(admin) : undefined;
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  for (const [name, value] of new Headers(extra)) headers.set(name, value);
  return headers;
}

async function getRequest(path: string, user: 'admin' | 'anonymous' = 'admin'): Promise<Request> {
  return new Request(`http://web${path}`, { headers: await forwarded(user) });
}

async function postRequest(path: string, body: BodyInit, contentType: string): Promise<Request> {
  return new Request(`http://web${path}`, {
    method: 'POST',
    headers: await forwarded('admin', { 'content-type': contentType }),
    body,
  });
}

const savedStates = (): RecordedRequest[] => fake.requests.filter((r) => `${r.method} ${r.path}` === SAVE_ADMIN_STATE);

const loggedLines = (): RequestLogFields[] => vi.mocked(logRequest).mock.calls.map(([fields]) => fields);

type SavedFlash = { flash: Record<string, Record<string, string>>; nextPreserveKey: number };

describe('page mode', () => {
  it('renders the view in the layout with its CSRF fields and the date key, persisting the session once', async () => {
    const result = await renderAdminPage(LIST, { muraAction: 'cusers.list' }, await forwarded());

    expect(result.kind).toBe('document');
    const body = result.kind === 'document' ? String(result.document.body) : '';
    expect(body).toMatch(/<div id="view">3 \S+<\/div>/);
    expect(body).toContain('value="TOKEN-listcontext"');
    expect(result.kind === 'document' && result.setCookies.length).toBeGreaterThan(0);
    expect(savedStates()).toHaveLength(1);
    expect(loggedLines()).toEqual([
      expect.objectContaining({
        route: 'page:cusers.list',
        statusCode: 200,
        requestId: 'req-pipeline',
        userId: admin.sub,
      }),
    ]);
  });

  it('answers the full layout as a Response with its cache headers and cookies', async () => {
    const response = await handleAdminPage(await getRequest('/admin/cusers/list?muraAction=cusers.list'), LIST);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html;charset=UTF-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await response.text()).toMatch(/^<!DOCTYPE[\s\S]*TOKEN-listcontext/);
  });

  it.each([
    ['an unknown key', { circuit: 'cnope', action: 'zzz' }],
    ['a screen of another mode', UPDATE],
  ])('answers 404 for %s', async (_case, params) => {
    expect(await renderAdminPage(params, {}, await forwarded())).toEqual({ kind: 'not-found' });
    expect((await handleAdminPage(await getRequest('/admin/x/y'), params)).status).toBe(404);
  });

  it('refuses a caller other than the gateway with a bare 403', async () => {
    const headers = await forwarded();
    headers.set(INVOCATION_HEADER, `Bearer ${await serviceInvocation('people')}`);

    const response = await handleAdminPage(new Request('http://web/admin/cusers/list', { headers }), LIST);

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
    expect(await renderAdminPage(LIST, {}, headers)).toEqual({ kind: 'refused', status: 403 });
    expect(fake.requests).toHaveLength(0);
    expect(loggedLines().map(({ statusCode, error }) => [statusCode, error !== undefined])).toEqual([
      [403, true],
      [403, true],
    ]);
  });

  it('sends an anonymous user on a secured screen to the login form', async () => {
    const anonymous = await getRequest('/admin/cusers/list?muraAction=cusers.list', 'anonymous');
    const response = await handleAdminPage(anonymous, LIST);
    const result = await renderAdminPage(LIST, { muraAction: 'cusers.list' }, await forwarded('anonymous'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(result).toMatchObject({ kind: 'redirect', location: response.headers.get('location') });
  });

  it('answers the legacy 503 when identity is unavailable, persisting nothing', async () => {
    fake.setRoute(CURRENT_SESSION, { status: 503, body: 'down' });

    const response = await handleAdminPage(await getRequest('/admin/cusers/list'), LIST);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(await renderAdminPage(LIST, {}, await forwarded())).toEqual({ kind: 'unavailable' });
    expect(savedStates()).toHaveLength(0);
    expect(loggedLines().map(({ statusCode }) => statusCode)).toEqual([503, 503]);
  });

  it('answers a service denial with the access gate redirect', async () => {
    fake.setRoute(CURRENT_SESSION, { status: 401, body: {} });

    const response = await handleAdminPage(await getRequest('/admin/cusers/list'), LIST);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/?muraAction=clogin.logout');
  });

  it('logs an unexpected error once and rethrows it', async () => {
    probe.renderError = new RangeError('render failed');

    await expect(renderAdminPage(LIST, {}, await forwarded())).rejects.toBe(probe.renderError);
    expect(loggedLines()).toEqual([expect.objectContaining({ statusCode: 500, error: probe.renderError })]);
  });

  it('logs a tracing start-up failure once and rethrows it without calling a service', async () => {
    const failure = new Error('tracing failed');
    vi.mocked(ensureTracing).mockRejectedValueOnce(failure);

    await expect(renderAdminPage(LIST, {}, await forwarded())).rejects.toBe(failure);
    expect(fake.requests).toHaveLength(0);
    expect(loggedLines()).toEqual([
      expect.objectContaining({ route: 'page:cusers.list', statusCode: 500, requestId: 'req-pipeline', error: failure }),
    ]);
    expect(loggedLines()[0]?.userId).toBeUndefined();
  });

  it('persists the writes of a request a screen derived in place of its own, with the set-up writes it carries', async () => {
    const result = await renderAdminPage({ circuit: 'carch', action: 'list' }, { muraAction: 'carch.list' }, await forwarded());

    expect(result.kind === 'document' && String(result.document.body)).toContain('<p id="derived">derived</p>');
    expect(savedStates().map(({ json }) => json)).toEqual([
      expect.objectContaining({ moduleid: '00000000000000000000000000000000003', siteid: 'default' }),
    ]);
  });
});

describe('page controller redirect', () => {
  const SITES = { circuit: 'csettings', action: 'list' } as const;
  const QUERY = { muraAction: 'csettings.list', refresh: '', siteid: 'default' };
  const sitesRequest = (user: 'admin' | 'anonymous' = 'admin'): Promise<Request> =>
    getRequest(`/admin/csettings/list?${new URLSearchParams(QUERY)}`, user);
  const lastCookies = (cookies: readonly string[], count: number): readonly string[] =>
    cookies.slice(cookies.length - count);

  it.each([
    ['a plain redirect', { action: 'cSettings.list', path: './' }, './?muraAction=cSettings.list', undefined, []],
    [
      'a preserving redirect with an appended value and relayed cookies',
      { action: 'cSettings.list', path: './', preserve: 'siteid', append: 'siteid', setCookies: ['relayed=1'] },
      './?muraAction=cSettings.list&siteid=default&fw1pk=1',
      { siteid: 'default' },
      ['relayed=1'],
    ],
  ])('answers %s instead of loading and rendering the view', async (_case, fields, location, flash, relayed) => {
    probe.redirect = { kind: 'redirect', ...fields };

    const response = await handleAdminPage(await sitesRequest(), SITES);
    const result = await renderAdminPage(SITES, QUERY, await forwarded());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(lastCookies(response.headers.getSetCookie(), relayed.length)).toEqual(relayed);
    expect(result).toMatchObject({ kind: 'redirect', location });
    expect(result.kind === 'redirect' && lastCookies(result.setCookies, relayed.length)).toEqual(relayed);
    expect(probe.steps).toEqual(['redirect', 'redirect']);
    expect(savedStates().map((saved) => (saved.json as Partial<SavedFlash>).flash?.['1'])).toEqual([flash, flash]);
    expect(loggedLines().map(({ statusCode }) => statusCode)).toEqual([302, 302]);
  });

  it('renders the view after a controller step that does not redirect', async () => {
    const response = await handleAdminPage(await sitesRequest(), SITES);
    const result = await renderAdminPage(SITES, QUERY, await forwarded());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p id="sites">sites</p>');
    expect(result.kind === 'document' && String(result.document.body)).toContain('<p id="sites">sites</p>');
    expect(probe.steps).toEqual(['redirect', 'load', 'render', 'redirect', 'load', 'render']);
  });

  it('answers an asynchronous step\'s location unchanged with its relayed cookies and no flash', async () => {
    const location = './?muraAction=cLogin.main&display=login&status=failed&returnURL=%2Fadmin%2F';
    probe.redirect = { kind: 'location', location, setCookies: ['relayed=1'] };
    probe.deferRedirect = true;

    const response = await handleAdminPage(await sitesRequest(), SITES);
    const result = await renderAdminPage(SITES, QUERY, await forwarded());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(location);
    expect(lastCookies(response.headers.getSetCookie(), 1)).toEqual(['relayed=1']);
    expect(result).toMatchObject({ kind: 'redirect', location });
    expect(result.kind === 'redirect' && lastCookies(result.setCookies, 1)).toEqual(['relayed=1']);
    expect(probe.steps).toEqual(['redirect', 'redirect']);
    expect(savedStates().some(({ json }) => (json as Partial<SavedFlash>).flash !== undefined)).toBe(false);
  });

  it('renders the view after an asynchronous step that does not redirect', async () => {
    probe.deferRedirect = true;

    const response = await handleAdminPage(await sitesRequest(), SITES);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p id="sites">sites</p>');
    expect(probe.steps).toEqual(['redirect', 'load', 'render']);
  });

  it('lets the access gate answer before the controller step runs', async () => {
    probe.redirect = { kind: 'redirect', action: 'cSettings.list', path: './' };

    const response = await handleAdminPage(await sitesRequest('anonymous'), SITES);
    const result = await renderAdminPage(SITES, QUERY, await forwarded('anonymous'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(result).toMatchObject({ kind: 'redirect', location: response.headers.get('location') });
    expect(probe.steps).toEqual([]);
  });
});

describe('redirect mode', () => {
  const submitForm = async (body: string): Promise<Response> =>
    handleAdminAction(await postRequest('/admin-actions/cusers/update?muraAction=cusers.update', body, FORM), UPDATE);

  it('saves the whole context as FW/1 flash and redirects with its preserve key', async () => {
    probe.submit = { kind: 'redirect', action: 'cUsers.edituser', preserve: 'all', path: './' };

    const response = await submitForm('userid=U1&siteid=default');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('./?muraAction=cUsers.edituser&fw1pk=1');
    expect(savedStates()).toHaveLength(1);
    const saved = savedStates()[0]?.json as SavedFlash;
    expect(saved.nextPreserveKey).toBe(2);
    expect(saved.flash['1']).toMatchObject({ userid: 'U1', siteid: 'default', muraAction: 'core:cusers.update' });
  });

  it('purges the context ten keys older, keeps listed keys present and appends listed values', async () => {
    fake.setRoute(ADMIN_STATE, { status: 200, body: { nextPreserveKey: 11, flash: { 1: { a: 'x' }, 5: { b: 'y' } } } });
    probe.submit = {
      kind: 'redirect',
      action: 'cUsers.list',
      preserve: 'userid,absent',
      append: 'siteid,absent',
      path: './',
    };

    const response = await submitForm('userid=U1&siteid=default');

    expect(response.headers.get('location')).toBe('./?muraAction=cUsers.list&siteid=default&fw1pk=11');
    const saved = savedStates()[0]?.json as SavedFlash;
    expect(saved.flash).toEqual({ 5: { b: 'y' }, 11: { userid: 'U1' } });
    expect(saved.nextPreserveKey).toBe(12);
  });

  it('preserves and appends the values the controller set on rc over the request values', async () => {
    probe.submit = {
      kind: 'redirect',
      action: 'cComments.default',
      preserve: 'processed,userid',
      append: 'processed',
      path: './',
      rc: { PROCESSED: 'true', USERID: 'U2' },
    };

    const response = await submitForm('userid=U1&processed=no&siteid=default');

    expect(response.headers.get('location')).toBe('./?muraAction=cComments&processed=true&fw1pk=1');
    const saved = savedStates()[0]?.json as SavedFlash;
    expect(saved.flash['1']).toEqual({ processed: 'true', userid: 'U2' });
  });

  it('passes a service Location through after the set-up cookies', async () => {
    probe.submit = { kind: 'location', location: './', setCookies: ['userid=abc; path=/'] };

    const response = await submitForm('');
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('./');
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.at(-1)).toBe('userid=abc; path=/');
  });

  it('re-renders a validation error inside the layout with status 200', async () => {
    probe.submit = { kind: 'render', view: { body: html`<p id="error">invalid</p>` } };

    const response = await submitForm('name=');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<p id="error">invalid</p>');
  });

  it.each<{ outcome: string; failure?: Error; status?: number }>([
    { outcome: 'its answer', status: 200 },
    { outcome: 'a mapped failure', failure: new GatewayUnavailableError('people', 503), status: 503 },
    { outcome: 'a rethrown failure', failure: new RangeError('screen failed') },
  ])('stages the multipart body for the screen and removes it after $outcome', async ({ failure, status }) => {
    const form = new FormData();
    form.append('title', 'Report');
    form.append('newfile', new File(['%PDF'], 'report.pdf', { type: 'application/pdf' }));
    const encoded = new Request('http://web/', { method: 'POST', body: form });
    const contentType = encoded.headers.get('content-type') ?? '';
    const bytes = Buffer.from(await encoded.arrayBuffer());
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'opt2-web-pipeline-'));
    let reads: Buffer[] = [];
    let staged: string[] = [];
    probe.inspect = async (ctx) => {
      const source = ctx.body?.body;
      if (source === undefined) return;
      const read = async (): Promise<Buffer> => Buffer.from(await new Response(source.stream()).arrayBuffer());
      reads = [await read(), await read()];
      staged = await readdir(tmp);
      if (failure !== undefined) throw failure;
    };
    probe.submit = { kind: 'raw', response: { contentType: 'text/plain', body: 'success' } };

    vi.stubEnv('TMPDIR', tmp);
    try {
      const request = await postRequest('/admin-actions/cusers/update', bytes, contentType);
      const answered = handleAdminAction(request, UPDATE);
      if (status === undefined) await expect(answered).rejects.toBe(failure);
      else expect((await answered).status).toBe(status);
      expect(await readdir(tmp)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await rm(tmp, { recursive: true, force: true });
    }

    expect(staged).toEqual([expect.stringMatching(/^opt2-web-upload-/)]);
    expect(reads).toEqual([bytes, bytes]);
    expect(probe.uploads).toEqual([{ field: 'newfile', filename: 'report.pdf' }]);
    expect(probe.body?.contentType).toBe(contentType);
    expect(probe.body?.body.size).toBe(bytes.length);
    expect(probe.body?.form.get('title')).toBe('Report');
    expect(probe.body?.form.get('newfile')).toMatchObject({ name: 'report.pdf', type: 'application/pdf', size: 0 });
    expect(loggedLines()).toEqual([expect.objectContaining({ statusCode: status ?? 500, error: failure })]);
  });

  it('gives a bodiless request an empty form scope and no body', async () => {
    probe.submit = { kind: 'location', location: './' };

    await handleAdminAction(await getRequest('/admin-actions/cusers/update?muraAction=cusers.update'), UPDATE);

    expect(probe.body).toBeUndefined();
    expect(probe.uploads).toEqual([]);
  });

  it('answers 404 for a screen of another mode', async () => {
    expect((await handleAdminAction(await getRequest('/admin-actions/cusers/list'), LIST)).status).toBe(404);
  });
});

describe('raw mode', () => {
  const raw = async (circuit: string, action: string): Promise<Response> =>
    handleAdminRaw(await getRequest(`/admin-raw/${circuit}/${action}`), { circuit, action });

  it('sends JSON bytes unchanged with the given content type', async () => {
    const response = await raw('carch', 'loadsitemanager');

    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.text()).toBe('{"a" : 1}');
  });

  it('passes download headers and relayed cookies', async () => {
    const response = await raw('cusers', 'download');

    expect(response.headers.get('content-disposition')).toBe('attachment;filename=users.csv');
    expect(response.headers.get('content-type')).toBe('text/csv');
    expect(response.headers.getSetCookie().at(-1)).toBe('download=1');
    expect(await response.text()).toBe('a,b\n');
  });

  it('sends a fragment with the legacy headers', async () => {
    const response = await raw('carch', 'loaddiff');

    expect(await response.text()).toBe('<p>diff</p>');
    expect(response.headers.get('generator')).toBe('Masa CMS 7.6.1');
  });

  it('answers 404 for a page screen', async () => {
    expect((await raw('cusers', 'list')).status).toBe(404);
  });

  it.each(['fragment', 'json', 'download'])('serves a %s screen that declares no gate', async (mode) => {
    const response = await raw('cgateless', mode);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`${mode} body`);
  });
});

describe('synthetic modules', () => {
  it('renders a screen inside the layout and gates an anonymous user', async () => {
    const result = await renderOpt2Page({ module: 'timesheets', screen: 'sheets' }, {}, await forwarded());

    expect(result.kind === 'document' && String(result.document.body)).toContain('<p id="opt2">sheets</p>');
    expect(await renderOpt2Page({ module: 'timesheets', screen: 'unknown' }, {}, await forwarded())).toEqual({
      kind: 'not-found',
    });
    const sheets = { module: 'timesheets', screen: 'sheets' };
    const anonymous = await renderOpt2Page(sheets, {}, await forwarded('anonymous'));
    expect(anonymous.kind).toBe('redirect');
  });

  it('answers a post action like an FW/1 post action', async () => {
    probe.submit = { kind: 'location', location: '/opt2/admin/timesheets/sheets' };

    const response = await handleOpt2Action(
      await postRequest('/opt2/admin-actions/timesheets/day-action', 'id=1', FORM),
      { module: 'timesheets', action: 'day-action' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/opt2/admin/timesheets/sheets');
    expect(probe.body?.form.get('id')).toBe('1');
    expect(loggedLines()).toEqual([
      expect.objectContaining({ route: 'opt2:timesheets.day-action', httpMethod: 'POST' }),
    ]);
  });
});
