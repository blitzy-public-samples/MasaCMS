// Page-mode entry points over the real screen registry, with the loopback gateway fake as the only data source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { setServiceClientForTests } from '@/lib/gateway-client';
import { renderAdminPage, renderOpt2Page, type AdminPageResult } from '@/lib/handlers';
import { logRequest } from '@/lib/telemetry';
import { OPT2_NAV_MODULES, serializeAdminDocument, type AdminDocument } from '@/shell/document';
import { CSRF_BY_CONTEXT, CSRF_LOGIN } from '../fixtures/identity/csrf';
import { loginPageDefault, loginSessionAnonymous } from '../fixtures/identity/session-login';
import { timesheetsAnswersByRole } from '../fixtures/opt2/timesheets';
import { siteById, type FixtureSiteId } from '../fixtures/programs-sites/sites';
import { sessionPresets } from '../fixtures/session';
import { domModel } from '../helpers/dom-model';
import { useTestEnv } from '../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway, type FakeRoute, type FakeRouteTable } from '../helpers/fake-gateway';
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

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

function install(routes: FakeRouteTable): void {
  for (const [key, route] of Object.entries(routes)) fake.setRoute(key, route);
}

/** Next's awaited `searchParams` of `url`: repeated names as arrays. */
function searchParamsOf(url: string): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of new URL(url).searchParams) {
    const previous = record[name];
    record[name] = previous === undefined ? value : [previous, value].flat();
  }
  return record;
}

async function adminPage(circuit: string, action: string, opts: AdminRequestOptions = {}): Promise<AdminPageResult> {
  const request = await adminRequest(`/admin/${circuit}/${action}`, opts);
  return renderAdminPage({ circuit, action }, searchParamsOf(request.url), request.headers);
}

async function opt2Page(module: string, screen: string, opts: AdminRequestOptions = {}): Promise<AdminPageResult> {
  const request = await adminRequest(`/opt2/admin/${module}/${screen}`, opts);
  return renderOpt2Page({ module, screen }, searchParamsOf(request.url), request.headers);
}

function documentOf(result: AdminPageResult): AdminDocument {
  if (result.kind !== 'document') throw new Error(`Expected a document, got ${JSON.stringify(result)}`);
  return result.document;
}

/** The call wrote one request log line, with `route` and `statusCode`. */
function expectLogged(route: string, statusCode: number): void {
  expect(vi.mocked(logRequest).mock.calls.map(([fields]) => fields)).toEqual([
    expect.objectContaining({ route, httpMethod: 'GET', statusCode }),
  ]);
}

const gatewayCalls = (): string[] => fake.requests.map(({ method, path }) => `${method} ${path}`);

beforeEach(async () => {
  fake = await startFakeGateway(BASE_ROUTES);
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
  vi.mocked(logRequest).mockClear();
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

describe('renderAdminPage', () => {
  it.each<{ layout: AdminDocument['layout']; query: Record<string, string>; view: typeof loginPageDefault }>([
    { layout: 'template', query: {}, view: loginPageDefault },
    { layout: 'compact', query: { compactDisplay: 'true' }, view: { ...loginPageDefault, compactDisplay: 'true' } },
  ])('renders clogin.main in the $layout layout for an anonymous browser', async ({ layout, query, view }) => {
    const doc = documentOf(await adminPage('clogin', 'main', { query }));

    expect(doc.layout).toBe(layout);
    expect(doc.title).toMatch(/^Masa CMS/);
    const { controls } = domModel(serializeAdminDocument(doc));
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

  it('sends an anonymous browser on a secured screen to the login form with its return URL', async () => {
    const result = await adminPage('cusers', 'list');

    expect(result).toMatchObject({
      kind: 'redirect',
      location: expect.stringMatching(/^\.\/\?muraAction=cLogin\.main&returnURL=/),
    });
    expect(result.kind === 'redirect' && decodeURIComponent(result.location)).toContain('muraAction=cusers.list');
    expectLogged('page:cusers.list', 302);
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

    const result = await adminPage('cusers', 'list', { user: SUBJECTS.member });

    expect(result).toMatchObject({ kind: 'redirect', location: '/admin/?muraAction=clogin.logout' });
    expectLogged('page:cusers.list', 302);
  });

  it.each([
    ['the gateway refuses connections', (): Promise<void> => fake.refuse()],
    [
      'identity answers 503 for the session',
      async (): Promise<void> => fake.setRoute(CURRENT_SESSION, { status: 503, body: 'down' }),
    ],
  ])('answers unavailable when %s', async (_case, fail) => {
    await fail();

    expect(await adminPage('clogin', 'main')).toEqual({ kind: 'unavailable' });
    expectLogged('page:clogin.main', 503);
  });

  it('answers not-found for an action no screen serves', async () => {
    expect(await adminPage('cnope', 'zzz')).toEqual({ kind: 'not-found' });
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
  ])('refuses a request $caller before any gateway call', async ({ opts, status }) => {
    expect(await adminPage('cusers', 'list', await opts())).toEqual({ kind: 'refused', status });
    expect(fake.requests).toHaveLength(0);
    expectLogged('page:cusers.list', status);
  });
});

describe('renderOpt2Page', () => {
  const query = { siteid: TENANT_A.SiteID };

  it('renders the timesheets sheet list inside the shell for an employee', async () => {
    if (timesheetsNav === undefined) throw new Error('OPT2_NAV_MODULES has no timesheets entry');
    install({ ...tenantAUserRoutes(employee), ...timesheetsAnswersByRole.employee });

    const doc = documentOf(await opt2Page(timesheetsNav.module, timesheetsNav.screen, { user: employee, query }));

    const body = String(doc.body);
    expect(body).toContain('class="mura-header"');
    expect(body).toContain('mura-table-grid');
    expect(gatewayCalls()).toContain(TIMESHEETS_SHEETS);
    expectLogged(`opt2:timesheets.${timesheetsNav.screen}`, 200);
  });

  it.each([
    ['an unknown screen', 'timesheets', 'nope'],
    ['an unknown module', 'nope', 'sheets'],
  ])('answers not-found for %s', async (_case, module, screen) => {
    install(tenantAUserRoutes(employee));

    expect(await opt2Page(module, screen, { user: employee, query })).toEqual({ kind: 'not-found' });
    expectLogged(`opt2:${module}.${screen}`, 404);
  });

  it('sends a user without a timesheets role to cMessage.noaccess without calling timesheets', async () => {
    install({ ...tenantAUserRoutes(SUBJECTS.systemUser), ...timesheetsAnswersByRole.employee });

    const result = await opt2Page('timesheets', 'sheets', { user: SUBJECTS.systemUser, query });

    expect(result).toMatchObject({ kind: 'redirect', location: '/admin/?muraAction=cMessage.noaccess' });
    expect(gatewayCalls().filter((call) => call.includes('/opt2/svc/timesheets/'))).toEqual([]);
    expectLogged('opt2:timesheets.sheets', 302);
  });

  it('answers unavailable when timesheets answers 503', async () => {
    install({ ...tenantAUserRoutes(employee), [TIMESHEETS_SHEETS]: { status: 503, body: 'down' } });

    expect(await opt2Page('timesheets', 'sheets', { user: employee, query })).toEqual({ kind: 'unavailable' });
    expectLogged('opt2:timesheets.sheets', 503);
  });
});

