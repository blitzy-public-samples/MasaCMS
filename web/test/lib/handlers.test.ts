// Page-mode entry points over the real screen registry, with the in-memory gateway relay as the only data source.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { setServiceClientForTests } from '@/lib/gateway-client';
import { handleAdminPage, handleOpt2Page } from '@/lib/handlers';
import { logRequest } from '@/lib/telemetry';
import { OPT2_NAV_MODULES } from '@/shell/document';
import { CSRF_BY_CONTEXT, CSRF_LOGIN } from '../fixtures/identity/csrf';
import { loginPageDefault, loginSessionAnonymous } from '../fixtures/identity/session-login';
import { timesheetsAnswersByRole } from '../fixtures/opt2/timesheets';
import { siteById, type FixtureSiteId } from '../fixtures/programs-sites/sites';
import { sessionPresets } from '../fixtures/session';
import { domModel } from '../helpers/dom-model';
import { useTestEnv } from '../helpers/env';
import {
  fakeServiceClient,
  routeKey,
  type FakeRoute,
  type FakeRouteTable,
  type FakeServiceClient,
} from '../helpers/fake-gateway';
import { adminRequest, type AdminRequestOptions } from '../helpers/requests';
import { SUBJECTS, serviceInvocation, syntheticSubject, type WebTestSubject } from '../helpers/tokens';

// The spans stay in-process: the SDK, and with it the OTLP exporter, is never started.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(async () => undefined),
  logRequest: vi.fn(),
}));

const CURRENT_SESSION = routeKey('GET', 'identity', '/v1/sessions/current');
const SESSION_SITES = routeKey('GET', 'identity', '/v1/sessions/current/sites');
const ADMIN_STATE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
const CSRF_TOKENS = routeKey('POST', 'identity', '/v1/csrf/tokens');
const HREF_DOMAINS = routeKey('GET', 'programs-sites', '/v1/href-domains');
const USER_SITES = routeKey('GET', 'programs-sites', '/v1/user-sites');
const TIMESHEETS_SHEETS = routeKey('GET', 'timesheets', '/v1/timesheets/sheets');
const shellSiteRoute = (siteId: string): string => routeKey('GET', 'programs-sites', `/v1/sites/${siteId}/shell`);
const headerPromptsRoute = (siteId: string): string =>
  routeKey('GET', 'strategies-content', `/v1/sites/${siteId}/header-prompts`);

const TENANT_A_ID: FixtureSiteId = 'tenant-a';
const TENANT_A = siteById[TENANT_A_ID];
const NO_PROMPTS = Object.freeze({ drafts: 0, submissions: 0, approvals: 0, expires: 0, pendingChangesets: 0 });

const employee = syntheticSubject('timesheets.employee');
const timesheetsNav = OPT2_NAV_MODULES.find((entry) => entry.module === 'timesheets');

/** The admin set-up cookies of a browser that sends none, in the order legacy sets them. */
const ADMIN_COOKIES: readonly SentCookie[] = [
  { name: 'rb', value: '', path: '/', persistent: true, httpOnly: true, sameSite: 'Lax' },
  { name: 'ADMINCONTROLWIDTH', value: '300', path: '/', persistent: true, httpOnly: false, sameSite: undefined },
  { name: 'ADMINSIDEBAR', value: 'off', path: '/', persistent: true, httpOnly: false, sameSite: undefined },
];
const RB_COOKIE: SentCookie = { name: 'RB', value: 'de', path: '/', persistent: true, httpOnly: true, sameSite: 'Lax' };
const ADMIN_COOKIE_HEADER = 'rb=; ADMINCONTROLWIDTH=300; ADMINSIDEBAR=off';

/** identity `issueCsrfTokens` answering each requested context with its fixture pair. */
const issueCsrfTokens: FakeRoute = (request) => {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  return { status: 200, body: { tokens: contexts.flatMap((context) => CSRF_BY_CONTEXT[context] ?? []) } };
};

/** programs-sites `listUserSites` row of a fixture site. */
function userSite(siteId: FixtureSiteId): Readonly<Record<string, unknown>> {
  const site = siteById[siteId];
  return {
    siteid: site.SiteID,
    site: site.Site,
    orderno: site.orderNo,
    domain: site.Domain,
    domainAlias: site.domainAlias,
    showDashboard: 0,
  };
}

/** An anonymous session on `default`, plus the shell reads of a `tenant-a` session. */
const BASE_ROUTES: FakeRouteTable = {
  [CURRENT_SESSION]: loginSessionAnonymous,
  [ADMIN_STATE]: { status: 200, body: {} },
  [SAVE_ADMIN_STATE]: (request) => ({ status: 200, body: request.json ?? {} }),
  [CSRF_TOKENS]: issueCsrfTokens,
  [HREF_DOMAINS]: {
    status: 200,
    body: { allowedDomains: [siteById.default.Domain], siteDomain: siteById.default.Domain },
  },
  [USER_SITES]: { status: 200, body: { sites: [userSite(TENANT_A_ID)] } },
  [shellSiteRoute(TENANT_A_ID)]: { status: 200, body: { site: TENANT_A, isNew: 0 } },
  [headerPromptsRoute(TENANT_A_ID)]: { status: 200, body: NO_PROMPTS },
};

/** What identity holds for a logged-in session. */
interface IdentitySession {
  readonly user: Readonly<Record<string, unknown>>;
  readonly siteArray: readonly FixtureSiteId[];
  readonly adminState?: Readonly<Record<string, unknown>>;
}

/** identity's current session, administered sites and stored admin state for `subject`. */
function identityRoutes(subject: WebTestSubject, session: IdentitySession): FakeRouteTable {
  return {
    [CURRENT_SESSION]: {
      status: 200,
      body: {
        sessionId: subject.sid,
        epoch: 0,
        user: session.user,
        roles: [...subject.roles],
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [SESSION_SITES]: {
      status: 200,
      body: { sites: session.siteArray.map((siteID) => ({ siteID, site: siteById[siteID].Site })) },
    },
    [ADMIN_STATE]: { status: 200, body: session.adminState ?? {} },
  };
}

/** identity's session of a private (system) user of `tenant-a` who administers that site. */
function tenantAUserRoutes(subject: WebTestSubject): FakeRouteTable {
  return identityRoutes(subject, {
    user: {
      isLoggedIn: true,
      userID: subject.sub,
      siteID: subject.site,
      memberships: `S2IsPrivate;${subject.site},S2IsPrivate`,
    },
    siteArray: [TENANT_A_ID],
  });
}

let fake: FakeServiceClient;
let restoreEnv: () => void;
let restoreClient: () => void;

function install(routes: FakeRouteTable): void {
  for (const [key, route] of Object.entries(routes)) fake.setRoute(key, route);
}

async function adminPage(circuit: string, action: string, opts: AdminRequestOptions = {}): Promise<Response> {
  return handleAdminPage(await adminRequest(`/admin/${circuit}/${action}`, opts), { circuit, action });
}

async function opt2Page(module: string, screen: string, opts: AdminRequestOptions = {}): Promise<Response> {
  return handleOpt2Page(await adminRequest(`/opt2/admin/${module}/${screen}`, opts), { module, screen });
}

/** One `Set-Cookie` as the browser stores it. */
interface SentCookie {
  readonly name: string;
  readonly value: string;
  readonly path: string | undefined;
  /** Carries an expiry, so it outlives the browser session. */
  readonly persistent: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string | undefined;
}

/** The `Set-Cookie` headers of `response`, in order. */
function sentCookies(response: Response): SentCookie[] {
  return response.headers.getSetCookie().map((header) => {
    const [pair = '', ...parts] = header.split(';').map((part) => part.trim());
    const attributes = new Map(
      parts.filter((part) => part !== '').map((part) => {
        const at = part.indexOf('=');
        return at < 0 ? [part.toLowerCase(), ''] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)];
      }),
    );
    const at = pair.indexOf('=');
    return {
      name: pair.slice(0, at),
      value: pair.slice(at + 1),
      path: attributes.get('path'),
      persistent: attributes.has('expires'),
      httpOnly: attributes.has('httponly'),
      sameSite: attributes.get('samesite'),
    };
  });
}

/** The call wrote one request log line, with `route` and `statusCode`. */
function expectLogged(route: string, statusCode: number): void {
  expect(vi.mocked(logRequest).mock.calls.map(([fields]) => fields)).toEqual([
    expect.objectContaining({ route, httpMethod: 'GET', statusCode }),
  ]);
}

const gatewayCalls = (): string[] => fake.requests.map(({ method, path }) => `${method} ${path}`);

beforeEach(() => {
  fake = fakeServiceClient(BASE_ROUTES);
  restoreEnv = useTestEnv();
  restoreClient = setServiceClientForTests(fake);
  vi.mocked(logRequest).mockClear();
});

afterEach(() => {
  restoreClient();
  restoreEnv();
});

/** One layout of clogin.main: its query and the view state, body class and cache headers legacy answers with. */
interface LoginLayout {
  readonly layout: string;
  readonly query: Record<string, string>;
  readonly view: typeof loginPageDefault;
  readonly bodyClass: RegExp;
  readonly cacheControl: string | null;
  readonly expires: string | null;
}

const LOGIN_LAYOUTS: readonly LoginLayout[] = [
  {
    layout: 'template',
    query: {},
    view: loginPageDefault,
    bodyClass: /^mura-admin /,
    cacheControl: 'no-cache, no-store, must-revalidate',
    expires: '06 Nov 1994 08:37:34 GMT',
  },
  {
    layout: 'compact',
    query: { compactDisplay: 'true' },
    view: { ...loginPageDefault, compactDisplay: 'true' },
    bodyClass: /^compact modal-wrapper$/,
    cacheControl: null,
    expires: null,
  },
];

describe('handleAdminPage', () => {
  it.each(LOGIN_LAYOUTS)('renders clogin.main in the $layout layout for an anonymous browser', async (layout) => {
    const { query, view } = layout;
    const response = await adminPage('clogin', 'main', { query });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(layout.cacheControl);
    expect(response.headers.get('expires')).toBe(layout.expires);
    const markup = await response.text();
    expect(cheerio.load(markup)('body').attr('class')).toMatch(layout.bodyClass);
    const { title, controls } = domModel(markup);
    expect(title).toMatch(/^Masa CMS/);
    expect(controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'username', type: 'text' }),
        expect.objectContaining({ name: 'password', type: 'password' }),
        expect.objectContaining({ name: CSRF_FIELD_TOKEN, type: 'hidden', value: CSRF_LOGIN.csrf_token }),
        expect.objectContaining({ name: CSRF_FIELD_EXPIRES, type: 'hidden', value: CSRF_LOGIN.csrf_token_expires }),
        expect.objectContaining({ name: 'returnUrl', type: 'hidden', value: view.returnURL }),
      ]),
    );
    const compactValues = controls.filter(({ name }) => name === 'compactDisplay').map(({ value }) => value);
    expect([...new Set(compactValues)]).toEqual([view.compactDisplay]);
    expectLogged('page:clogin.main', 200);
  });

  it.each(LOGIN_LAYOUTS)('answers the $layout layout as the complete legacy document', async ({ query }) => {
    const markup = await (await adminPage('clogin', 'main', { query })).text();

    expect(markup).toMatch(/^<!DOCTYPE html>\n/);
    expect(markup.match(/<head>/g)).toHaveLength(1);
    expect(markup.match(/<body[\s>]/g)).toHaveLength(1);
    const head = markup.slice(markup.indexOf('<head>'), markup.indexOf('</head>'));
    expect(markup.indexOf('</head>')).toBeLessThan(markup.indexOf('<body'));
    expect(head).toMatch(/<title>Masa CMS[^<]*<\/title>/);
    expect(head).toMatch(/<link rel="icon" href="[^"]*\/favicon\.ico[^"]*"/);
    expect(markup).toMatch(/<html lang="[^"]+" class="mura[^"]*">/);
    expect(markup).toMatch(/<body id="clogin" class="[^"]+">/);
    expect(markup).not.toContain('d.documentElement');
    expect(markup).not.toContain('/_next/');
  });

  it('sends an anonymous browser on a secured screen to the login form with its return URL', async () => {
    const response = await adminPage('cusers', 'list');

    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/^\.\/\?muraAction=cLogin\.main&returnURL=/);
    expect(decodeURIComponent(location)).toContain('muraAction=cusers.list');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('expires')).toBeNull();
    expect(await response.text()).toBe('');
    expectLogged('page:cusers.list', 302);
  });

  it.each([
    { outcome: 'the 200', circuit: 'clogin', action: 'main', status: 200 },
    { outcome: 'the 302', circuit: 'cusers', action: 'list', status: 302 },
  ])('sets the admin cookies on $outcome of a browser that sends none', async ({ circuit, action, status }) => {
    const response = await adminPage(circuit, action);

    expect(response.status).toBe(status);
    expect(sentCookies(response)).toEqual(ADMIN_COOKIES);
  });

  it.each<{ label: string; cookie?: string; query: Record<string, string>; cookies: readonly SentCookie[] }>([
    { label: 'sends the admin cookies', cookie: ADMIN_COOKIE_HEADER, query: {}, cookies: [] },
    {
      label: 'sends none and asks for ?rb=de',
      query: { rb: 'de' },
      cookies: [...ADMIN_COOKIES.slice(0, 1), RB_COOKIE, ...ADMIN_COOKIES.slice(1)],
    },
    {
      label: 'sends the admin cookies and asks for ?rb=de',
      cookie: ADMIN_COOKIE_HEADER,
      query: { rb: 'de' },
      cookies: [RB_COOKIE],
    },
  ])('sets only the cookies legacy sets when the browser $label', async ({ cookie, query, cookies }) => {
    const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
    const response = await adminPage('clogin', 'main', { query, headers });

    expect(response.status).toBe(200);
    expect(sentCookies(response)).toEqual(cookies);
  });

  it('sends a logged-in public-pool user who administers no site to clogin.logout', async () => {
    const preset = sessionPresets.noSites;
    install(
      identityRoutes(SUBJECTS.member, {
        user: preset.mura,
        siteArray: preset.siteArray,
        adminState: { siteid: preset.siteid, userFilesPath: preset.userFilesPath },
      }),
    );

    const response = await adminPage('cusers', 'list', { user: SUBJECTS.member });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/?muraAction=clogin.logout');
    expectLogged('page:cusers.list', 302);
  });

  it.each([
    ['the gateway refuses connections', (): void => fake.failWith()],
    ['identity answers 503 for the session', (): void => fake.setRoute(CURRENT_SESSION, { status: 503, body: 'down' })],
  ])('answers the legacy 503 when %s', async (_case, fail) => {
    fail();

    const response = await adminPage('clogin', 'main');

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(LEGACY_ERROR_PAGE_HTML);
    expectLogged('page:clogin.main', 503);
  });

  it('answers 404 for an action no screen serves', async () => {
    expect((await adminPage('cnope', 'zzz')).status).toBe(404);
    expectLogged('page:cnope.zzz', 404);
  });

  it.each<{ caller: string; opts: () => Promise<AdminRequestOptions>; status: 401 | 403 }>([
    { caller: 'without the gateway invocation', opts: async () => ({ invocation: false }), status: 403 },
    {
      caller: 'invoked by another workload',
      opts: async () => ({ invocation: await serviceInvocation('people') }),
      status: 403,
    },
    { caller: 'with an invalid user token', opts: async () => ({ userToken: 'not-a-token' }), status: 401 },
  ])('refuses a request $caller with a bare status before any gateway call', async ({ opts, status }) => {
    const response = await adminPage('cusers', 'list', await opts());

    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    expectLogged('page:cusers.list', status);
  });
});

describe('handleOpt2Page', () => {
  const query = { siteid: TENANT_A.SiteID };

  it('renders the timesheets sheet list inside the shell for an employee', async () => {
    if (timesheetsNav === undefined) throw new Error('OPT2_NAV_MODULES has no timesheets entry');
    install({ ...tenantAUserRoutes(employee), ...timesheetsAnswersByRole.employee });

    const response = await opt2Page(timesheetsNav.module, timesheetsNav.screen, { user: employee, query });

    expect(response.status).toBe(200);
    const markup = await response.text();
    expect(markup).toMatch(/^<!DOCTYPE html>\n/);
    expect(markup).toContain('class="mura-header"');
    expect(markup).toContain('mura-table-grid');
    expect(gatewayCalls()).toContain(TIMESHEETS_SHEETS);
    expectLogged(`opt2:timesheets.${timesheetsNav.screen}`, 200);
  });

  it.each([
    ['an unknown screen', 'timesheets', 'nope'],
    ['an unknown module', 'nope', 'sheets'],
  ])('answers 404 for %s', async (_case, module, screen) => {
    install(tenantAUserRoutes(employee));

    expect((await opt2Page(module, screen, { user: employee, query })).status).toBe(404);
    expectLogged(`opt2:${module}.${screen}`, 404);
  });

  it('sends a user without a timesheets role to cMessage.noaccess with the admin cookies', async () => {
    install({ ...tenantAUserRoutes(SUBJECTS.systemUser), ...timesheetsAnswersByRole.employee });

    const response = await opt2Page('timesheets', 'sheets', { user: SUBJECTS.systemUser, query });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/?muraAction=cMessage.noaccess');
    expect(sentCookies(response)).toEqual(ADMIN_COOKIES);
    expect(gatewayCalls().filter((call) => call.includes('/opt2/svc/timesheets/'))).toEqual([]);
    expectLogged('opt2:timesheets.sheets', 302);
  });

  it('answers the legacy 503 when timesheets answers 503', async () => {
    install({ ...tenantAUserRoutes(employee), [TIMESHEETS_SHEETS]: { status: 503, body: 'down' } });

    const response = await opt2Page('timesheets', 'sheets', { user: employee, query });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(LEGACY_ERROR_PAGE_HTML);
    expectLogged('opt2:timesheets.sheets', 503);
  });
});
