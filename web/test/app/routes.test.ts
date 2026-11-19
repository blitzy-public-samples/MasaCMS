// The admin route modules over the real handlers and screen registry, with the in-memory gateway beneath the production
// platform client as the only data source: each response mode's legacy answer, refusals and the fail-closed 503.
// Segment config and handler delegation are covered with a mocked handler in ./route-adapters.test.ts.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_NOACCESS_ACTION,
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  LEGACY_ERROR_PAGE_HTML,
  adminUnavailableResponse,
  type CsrfTokens,
} from '@opt2/platform/legacy-compat';
import { BUSINESS_DATE, TENANT_A } from '@opt2/platform/testing';
import { LEGACY_VERSION_MENU_PATH, setServiceClientForTests } from '@/lib/gateway-client';
import type { UserUpdateResult } from '@/screens/cusers/update';
import * as adminPage from '../../app/admin/[circuit]/[action]/route';
import * as adminActions from '../../app/admin-actions/[circuit]/[action]/route';
import * as adminRaw from '../../app/admin-raw/[circuit]/[action]/route';
import * as opt2Actions from '../../app/opt2/admin-actions/[module]/[action]/route';
import { LEGACY_VERSION_MENU } from '../fixtures/gateway/version-menu';
import { CSRF_BY_CONTEXT } from '../fixtures/identity/csrf';
import {
  LOGOUT_DELETE_COOKIES,
  SESSION_SET_COOKIES,
  loginSessionAnonymous,
  loginSuccessRedirect,
  logoutAnswer,
} from '../fixtures/identity/session-login';
import { TIMESHEET_IDS, TIMESHEETS_AS_OF, timesheetsAnswersByRole } from '../fixtures/opt2/timesheets';
import { PERSON_IDS } from '../fixtures/people/user-list';
import { duplicateUsernameResult, routeToListUsersResult } from '../fixtures/people/validation-errors';
import { TENANT_A_USERS_CSV_BODY, USERS_CSV_HEADERS, tenantAUsersCsv } from '../fixtures/people/users-csv';
import { profileUpdateSuccess } from '../fixtures/people/profile';
import { siteById, type FixtureSiteId } from '../fixtures/programs-sites/sites';
import { adminS2Session, tenantASiteAdminSession } from '../fixtures/session';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../fixtures/strategies-content/carch';
import { CHANGESET_IDS } from '../fixtures/strategies-content/changesets';
import { promptCountsZero } from '../fixtures/strategies-content/prompts';
import { loaddiffRelay, loadsitemanagerRelay } from '../fixtures/strategies-content/raw';
import { writeResultReRender } from '../fixtures/strategies-content/write-results';
import { useTestEnv } from '../helpers/env';
import {
  LEGACY_SITE_PATHS_KEY,
  inMemoryGateway,
  installedSitePaths,
  routeKey,
  type FakeRoute,
  type FakeRouteTable,
  type InMemoryGateway,
  type RecordedRequest,
} from '../helpers/fake-gateway';
import { adminRequest, formWithCsrf, routeParams, type AdminRequestOptions, type BrowserPart } from '../helpers/requests';
import { SUBJECTS, serviceInvocation, syntheticSubject, type WebTestSubject } from '../helpers/tokens';

// Request log lines are recorded instead of written to stdout.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  logRequest: vi.fn(),
}));

const CURRENT_SESSION = routeKey('GET', 'identity', '/v1/sessions/current');
const SESSION_SITES = routeKey('GET', 'identity', '/v1/sessions/current/sites');
const ADMIN_STATE = routeKey('GET', 'identity', '/v1/sessions/current/admin-state');
const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');
const CSRF_TOKENS = routeKey('POST', 'identity', '/v1/csrf/tokens');
const LOGOUT = routeKey('POST', 'identity', '/v1/sessions/logout');
const LOGIN = routeKey('POST', 'identity', '/v1/sessions/login');
const HREF_DOMAINS = routeKey('GET', 'programs-sites', '/v1/href-domains');
const USER_SITES = routeKey('GET', 'programs-sites', '/v1/user-sites');
const VERSION_MENU = routeKey('GET', 'gateway', LEGACY_VERSION_MENU_PATH);
const UPDATE_USER = routeKey('POST', 'people', '/v1/users:update');
const UPDATE_PROFILE = routeKey('POST', 'people', '/v1/profile:update');
const ROUTE_USER = routeKey('GET', 'people', '/v1/users/route');
const USERS_CSV = routeKey('GET', 'people', '/v1/users/download');
const CARCH_UPDATE = routeKey('POST', 'strategies-content', '/v1/raw/carch/update');
const LOADDIFF = routeKey('GET', 'strategies-content', '/v1/raw/carch/loaddiff');
const LOADSITEMANAGER = routeKey('POST', 'strategies-content', '/v1/raw/carch/loadsitemanager');
const SITEMANAGERTAB = routeKey('GET', 'strategies-content', '/v1/raw/carch/sitemanagertab');
const CHANGESET_ROLLBACK = routeKey(
  'POST',
  'strategies-content',
  `/v1/sites/${TENANT_A.siteId}/changesets/${CHANGESET_IDS.published}/rollback`,
);
const dayActionRoute = (dayId: string, action: string): string =>
  routeKey('POST', 'timesheets', `/v1/timesheets/days/${dayId}/${action}`);

const SITE = TENANT_A.siteId;
const SERVICE_PREFIX = '/opt2/svc/';
const ROOT_CONTENT_ID = '00000000000000000000000000000000001';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

/** The pair the browser posts; web relays it and never validates it. */
const POSTED_CSRF: Readonly<CsrfTokens> = Object.freeze({
  token: 'POSTEDCSRFTOKEN00000000000000000',
  expires: '260630150000000',
});

/** The admin set-up cookies a returning browser sends, so the set-up adds no `Set-Cookie` of its own. */
const RETURNING_BROWSER = Object.freeze({ cookie: 'rb=; ADMINCONTROLWIDTH=300; ADMINSIDEBAR=off' });

/** cUsers.update of Jane Smith's tenant-a system-user record, as the Edit User form posts it. */
const JANE_SMITH_UPDATE = Object.freeze({
  siteid: SITE,
  type: '2',
  action: 'Update',
  userid: PERSON_IDS.janeSmith,
  ispublic: '0',
  username: 'jane_smith',
  fname: 'Jane',
  lname: 'Smith',
  email: 'jane_smith@example.com',
});

const savedUser: UserUpdateResult = { written: true, errors: {}, passwordExpired: false };

/** `fields` as multipart text parts, then `extra`, as a browser without scripts serialises a form. */
const partsOf = (fields: Record<string, string>, ...extra: BrowserPart[]): BrowserPart[] => [
  ...Object.entries(fields).map(([name, value]) => ({ name, value })),
  ...extra,
];

const primaryApprover = syntheticSubject('timesheets.primary-approver');
const employee = syntheticSubject('timesheets.employee');

/** A timesheets day-action post of `dayaction` on `dayid` of the returned sheet. */
const dayAction = (dayid: string, dayaction: string): Record<string, string> =>
  formWithCsrf(
    { siteid: SITE, asOf: BUSINESS_DATE, timesheetid: TIMESHEET_IDS.sheetReturned, dayid, dayaction },
    POSTED_CSRF,
  );

const UNAVAILABLE = adminUnavailableResponse();

type SessionPreset = typeof adminS2Session | typeof tenantASiteAdminSession;

/** identity's tokens per requested context: the fixture pair, else the posted one. */
const issueCsrfTokens: FakeRoute = (request) => {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map(
    (context) =>
      CSRF_BY_CONTEXT[context] ?? {
        context,
        [CSRF_FIELD_TOKEN]: POSTED_CSRF.token,
        [CSRF_FIELD_EXPIRES]: POSTED_CSRF.expires,
      },
  );
  return { status: 200, body: { tokens } };
};

/** Shell, site, CSRF and legacy layout answers every logged-in admin request reads, for each fixture site. */
function baseRoutes(): FakeRouteTable {
  const sites = Object.values(siteById);
  return {
    [SAVE_ADMIN_STATE]: (request) => ({ status: 200, body: request.json ?? {} }),
    [CSRF_TOKENS]: issueCsrfTokens,
    [LEGACY_SITE_PATHS_KEY]: installedSitePaths,
    [USER_SITES]: {
      status: 200,
      body: {
        sites: sites.map((site) => ({
          siteid: site.SiteID,
          site: site.Site,
          orderno: site.orderNo,
          domain: site.Domain,
          domainAlias: site.domainAlias,
          showDashboard: 0,
        })),
      },
    },
    ...Object.fromEntries(
      sites.flatMap((site) => [
        [
          routeKey('GET', 'programs-sites', `/v1/sites/${site.SiteID}/shell`),
          { status: 200, body: { site, isNew: 0 } },
        ],
        [
          routeKey('GET', 'strategies-content', `/v1/sites/${site.SiteID}/header-prompts`),
          { status: 200, body: promptCountsZero },
        ],
      ]),
    ),
    [VERSION_MENU]: { status: 200, body: LEGACY_VERSION_MENU },
  };
}

/** identity's session of `subject`, holding the user struct, sites and selected site of `preset`. */
function sessionRoutes(subject: WebTestSubject, preset: SessionPreset): FakeRouteTable {
  const siteArray: readonly FixtureSiteId[] = preset.siteArray;
  return {
    [CURRENT_SESSION]: {
      status: 200,
      body: {
        sessionId: subject.sid,
        epoch: 0,
        user: preset.mura,
        roles: [...subject.roles],
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [SESSION_SITES]: {
      status: 200,
      body: { sites: siteArray.map((siteID) => ({ siteID, site: siteById[siteID].Site })) },
    },
    [ADMIN_STATE]: { status: 200, body: { siteid: preset.siteid, userFilesPath: preset.userFilesPath } },
  };
}

let gateway: InMemoryGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

beforeEach(() => {
  gateway = inMemoryGateway(baseRoutes());
  restoreEnv = useTestEnv();
  restoreClient = setServiceClientForTests(gateway.client);
});

afterEach(() => {
  restoreClient();
  restoreEnv();
});

function install(routes: FakeRouteTable): void {
  for (const [key, route] of Object.entries(routes)) gateway.setRoute(key, route);
}

/** The opt2/admin-actions exports that take the request alone, by method. */
const OPT2_ACTION_EXPORTS = new Map<string, (request: Request) => Response>([
  ['GET', opt2Actions.GET],
  ['HEAD', opt2Actions.HEAD],
  ['PUT', opt2Actions.PUT],
  ['PATCH', opt2Actions.PATCH],
  ['DELETE', opt2Actions.DELETE],
  ['OPTIONS', opt2Actions.OPTIONS],
]);

/** `request` answered by the route module its web path names, through the export of its method. */
async function serve(request: Request): Promise<Response> {
  const [tree = '', first = '', second = '', third = ''] = new URL(request.url).pathname.split('/').slice(1);
  if (tree === 'opt2' && first === 'admin-actions') {
    if (request.method === 'POST') return opt2Actions.POST(request, routeParams({ module: second, action: third }));
    const handler = OPT2_ACTION_EXPORTS.get(request.method);
    if (handler === undefined) throw new TypeError(`opt2/admin-actions exports no ${request.method}`);
    return handler(request);
  }
  const route = tree === 'admin' ? adminPage : tree === 'admin-actions' ? adminActions : tree === 'admin-raw' ? adminRaw : undefined;
  if (route === undefined) throw new TypeError(`No route module serves ${request.url}`);
  const params = routeParams({ circuit: first, action: second });
  return request.method === 'POST' ? route.POST(request, params) : route.GET(request, params);
}

/** The gateway-forwarded request for web `path` with `opts`, and its answer. */
async function send(path: string, opts: AdminRequestOptions = {}): Promise<{ request: Request; response: Response }> {
  const request = await adminRequest(path, { headers: RETURNING_BROWSER, ...opts });
  return { request, response: await serve(request) };
}

/** Asserts the headers legacy adds to every response. */
function expectLegacyHeaders(response: Response): void {
  expect(response.headers.get('generator')).toBe('Masa CMS 7.6.1');
  expect(response.headers.get('strict-transport-security')).toBe('max-age=1200');
}

/** The requests web relayed to the gateway as `METHOD path`. */
const relayed = (filter: (request: RecordedRequest) => boolean): string[] =>
  gateway.requests.filter(filter).map(({ method, path }) => `${method} ${path}`);

const toService = (service: string) => (request: RecordedRequest) =>
  request.path.startsWith(`${SERVICE_PREFIX}${service}/`);

describe('admin page mode', () => {
  it('POST clogin.login relays the credentials posted in its body to identity, then answers its redirect', async () => {
    install({
      [CURRENT_SESSION]: loginSessionAnonymous,
      [LOGIN]: loginSuccessRedirect,
      [HREF_DOMAINS]: { status: 200, body: { allowedDomains: ['localhost'], siteDomain: 'localhost' } },
    });
    const posted = formWithCsrf(
      { muraAction: 'cLogin.login', username: 'admin', password: 'posted-p@ss,word', isAdminLogin: 'true', compactDisplay: 'false' },
      POSTED_CSRF,
    );

    const { request, response } = await send('/admin/clogin/login', { originalUrl: '/admin/index.cfm', form: posted });

    expect(request.method).toBe('POST');
    expect(new URL(request.url).search).toBe('');
    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(loginSuccessRedirect.body.location);
    expect(response.headers.getSetCookie()).toEqual(expect.arrayContaining([...SESSION_SET_COOKIES]));
    const login = gateway.requests.find((recorded) => `${recorded.method} ${recorded.path}` === LOGIN);
    expect(login?.form).toMatchObject({
      username: 'admin',
      password: 'posted-p@ss,word',
      isAdminLogin: 'true',
      [CSRF_FIELD_TOKEN]: POSTED_CSRF.token,
      [CSRF_FIELD_EXPIRES]: POSTED_CSRF.expires,
    });
  });

  it('POST cEditProfile.update answers 404 for the halted profile save, which stays on legacy, unrelayed', async () => {
    install({
      ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession),
      [UPDATE_PROFILE]: { status: 200, body: profileUpdateSuccess },
    });
    const fields = formWithCsrf({ siteid: SITE, fname: 'Jane', lname: 'Smith', email: 'jane_smith@example.com' }, POSTED_CSRF);

    const { response } = await send('/admin/ceditprofile/update', {
      user: SUBJECTS.siteAdmin,
      parts: partsOf(fields, { name: 'newFile', filename: '' }),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(404);
    expect(relayed(toService('people'))).toEqual([]);
    expect(relayed((recorded) => recorded.method !== 'GET')).toEqual([]);
  });
});

describe('admin-actions redirect mode', () => {
  it('GET clogin.logout ends the session and redirects to home.redirect with identity cookies', async () => {
    install({ ...sessionRoutes(SUBJECTS.admin, adminS2Session), [LOGOUT]: logoutAnswer });

    const { response } = await send('/admin-actions/clogin/logout', { user: SUBJECTS.admin });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    // FW/1 buildURL drops the action of framework.home (core:home.redirect), leaving the bare path.
    expect(response.headers.get('location')).toBe('./');
    expect(response.headers.getSetCookie()).toEqual([...LOGOUT_DELETE_COOKIES]);
    expect(await response.text()).toBe('');
    expect(relayed(toService('identity'))).toContain(LOGOUT);
  });

  it('POST cUsers.update relays a roster create to people with the posted CSRF pair, then routes to listusers', async () => {
    install({
      ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession),
      [UPDATE_USER]: { status: 200, body: savedUser },
      [ROUTE_USER]: { status: 200, body: routeToListUsersResult },
    });
    const fields = { ...JANE_SMITH_UPDATE, action: 'Add', userid: '' };

    const { request, response } = await send('/admin-actions/cusers/update', {
      user: SUBJECTS.siteAdmin,
      form: formWithCsrf(fields, POSTED_CSRF),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`./?muraAction=cUsers.listusers&siteid=${SITE}&ispublic=0`);
    const write = gateway.requests.find((recorded) => `${recorded.method} ${recorded.path}` === UPDATE_USER);
    expect(write?.path.startsWith(`${SERVICE_PREFIX}people/`)).toBe(true);
    expect(write?.form).toMatchObject({
      ...fields,
      [CSRF_FIELD_TOKEN]: POSTED_CSRF.token,
      [CSRF_FIELD_EXPIRES]: POSTED_CSRF.expires,
    });
    expect(write?.headers.authorization).toBe(request.headers.get('authorization'));
    expect(write?.headers['x-serverless-authorization']).toMatch(/^Bearer \S+$/);
    expect(write?.headers['x-serverless-authorization']).not.toBe(request.headers.get('x-serverless-authorization'));
    expect(relayed(toService('people'))).toEqual([UPDATE_USER, ROUTE_USER]);
  });

  it('POST cUsers.update with a validation error preserves the context and redirects to edituser', async () => {
    install({
      ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession),
      [UPDATE_USER]: { status: 200, body: duplicateUsernameResult },
    });

    const { response } = await send('/admin-actions/cusers/update', {
      user: SUBJECTS.siteAdmin,
      form: formWithCsrf({ ...JANE_SMITH_UPDATE, action: 'Add', userid: '' }, POSTED_CSRF),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/^\.\/\?muraAction=cUsers\.edituser&fw1pk=\d+$/);
    const preserveKey = location.slice(location.indexOf('fw1pk=') + 'fw1pk='.length);
    const saved = gateway.requests.filter((recorded) => `${recorded.method} ${recorded.path}` === SAVE_ADMIN_STATE);
    expect(saved).toHaveLength(1);
    const { flash } = saved[0]?.json as { readonly flash: Readonly<Record<string, Readonly<Record<string, string>>>> };
    expect(Object.keys(flash)).toEqual([preserveKey]);
    expect(flash[preserveKey]).toMatchObject({ userid: '', siteid: SITE, username: 'jane_smith' });
    expect(relayed(toService('people'))).toEqual([UPDATE_USER]);
  });

  it.each<[string, AdminRequestOptions]>([
    ['a halted user edit', { form: formWithCsrf(JANE_SMITH_UPDATE, POSTED_CSRF) }],
    ['a user delete', { form: formWithCsrf({ ...JANE_SMITH_UPDATE, action: 'Delete' }, POSTED_CSRF) }],
    ['a photo removal', { form: formWithCsrf({ ...JANE_SMITH_UPDATE, removePhotoFile: 'true' }, POSTED_CSRF) }],
    [
      'a photo upload',
      {
        multipart: {
          ...formWithCsrf(JANE_SMITH_UPDATE, POSTED_CSRF),
          newFile: { name: 'portrait.jpg', type: 'image/jpeg', data: 'synthetic jpeg' },
        },
      },
    ],
  ])('answers 404 for %s, which stays on legacy, without a write', async (_label, body) => {
    install(sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession));

    const { response } = await send('/admin-actions/cusers/update', { user: SUBJECTS.siteAdmin, ...body });

    expectLegacyHeaders(response);
    expect(response.status).toBe(404);
    expect(relayed(toService('people'))).toEqual([]);
    expect(relayed((recorded) => recorded.method !== 'GET')).toEqual([]);
  });

  it('POST cUsers.update of a scriptless Add User form, with an empty newfile text and file part, relays the add to people', async () => {
    install({
      ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession),
      [UPDATE_USER]: { status: 200, body: savedUser },
      [ROUTE_USER]: { status: 200, body: routeToListUsersResult },
    });
    const fields = formWithCsrf({ ...JANE_SMITH_UPDATE, action: 'Add', userid: '' }, POSTED_CSRF);

    const { response } = await send('/admin-actions/cusers/update', {
      user: SUBJECTS.siteAdmin,
      parts: partsOf(fields, { name: 'newfile', value: '' }, { name: 'newfile', filename: '' }),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`./?muraAction=cUsers.listusers&siteid=${SITE}&ispublic=0`);
    expect(relayed(toService('people'))).toEqual([UPDATE_USER, ROUTE_USER]);
  });

  it.each<[string, BrowserPart[]]>([
    ['a newfile text value', [{ name: 'newfile', value: 'x' }, { name: 'newfile', filename: '' }]],
    ['a chosen photo file', [{ name: 'newfile', value: '' }, { name: 'newfile', value: 'png bytes', filename: 'p.png', type: 'image/png' }]],
  ])('answers 404 for a scriptless Add User form with %s, which stays on legacy, without a write', async (_label, photo) => {
    install(sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession));
    const fields = formWithCsrf({ ...JANE_SMITH_UPDATE, action: 'Add', userid: '' }, POSTED_CSRF);

    const { response } = await send('/admin-actions/cusers/update', { user: SUBJECTS.siteAdmin, parts: partsOf(fields, ...photo) });

    expect(response.status).toBe(404);
    expect(relayed(toService('people'))).toEqual([]);
  });

  it('POST cChangesets.rollback answers 404 for the withheld rollback, which stays on legacy, unrelayed', async () => {
    install({
      ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession),
      [CHANGESET_ROLLBACK]: { status: 200, body: { saved: true, errors: {}, redirect: null } },
    });

    const { response } = await send('/admin-actions/cchangesets/rollback', {
      user: SUBJECTS.siteAdmin,
      form: formWithCsrf({ siteid: SITE, changesetID: CHANGESET_IDS.published }, POSTED_CSRF),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(404);
    expect(relayed(toService('strategies-content'))).toEqual([]);
    expect(relayed((recorded) => recorded.method !== 'GET')).toEqual([]);
  });
});

describe('admin-raw response modes', () => {
  beforeEach(() => {
    install(sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession));
  });

  it('GET carch.loaddiff answers the relayed fragment byte for byte, without the layout', async () => {
    install({ [LOADDIFF]: loaddiffRelay });

    const { response } = await send('/admin-raw/carch/loaddiff', {
      user: SUBJECTS.siteAdmin,
      query: { siteid: SITE, contenthistid1: CONTENT_HIST_IDS.aboutUs, contenthistid2: CONTENT_HIST_IDS.home },
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(loaddiffRelay.headers['content-type']);
    const body = await response.text();
    expect(body).toBe(loaddiffRelay.body);
    for (const shell of ['<!DOCTYPE', '<html', 'mura-admin']) expect(body).not.toContain(shell);
  });

  it('POST carch.loadsitemanager answers the relayed JSON text unchanged', async () => {
    install({ [LOADSITEMANAGER]: loadsitemanagerRelay });

    const { response } = await send('/admin-raw/carch/loadsitemanager', {
      user: SUBJECTS.siteAdmin,
      form: {
        siteid: SITE,
        topid: ROOT_CONTENT_ID,
        moduleid: SITE_MANAGER_MODULE_ID,
        sortby: 'orderno',
        sortdirection: 'asc',
      },
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(loadsitemanagerRelay.headers['content-type']);
    expect(await response.text()).toBe(loadsitemanagerRelay.body);
  });

  // The gateway mints a site-less admin request's token for the session's stored site, which web sends as rc.siteid.
  it('GET carch.siteManagerTab without a siteid relays the session site, answers the empty 200 and stores the tab', async () => {
    const flatViewArgs = { [SITE]: { tab: '1' } };
    install({
      [SITEMANAGERTAB]: {
        status: 200,
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'X-Opt2-Session-Effects': JSON.stringify({ mura: { flatViewArgs } }) },
      },
    });
    const referer = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;

    const { request, response } = await send('/admin-raw/carch/sitemanagertab', {
      user: SUBJECTS.siteAdmin,
      query: { muraAction: 'carch.siteManagerTab', tab: '1' },
      headers: { ...RETURNING_BROWSER, referer },
    });

    expectLegacyHeaders(response);
    expect([response.status, response.headers.get('content-type'), response.headers.get('location')]).toEqual([
      200,
      'text/html;charset=UTF-8',
      null,
    ]);
    expect(await response.text()).toBe('');
    const relay = gateway.requests.filter((recorded) => `${recorded.method} ${recorded.path}` === SITEMANAGERTAB);
    expect(relay).toHaveLength(1);
    expect(relay[0]?.query).toMatchObject({ siteid: SUBJECTS.siteAdmin.site, tab: '1' });
    expect(relay[0]?.headers.authorization).toBe(request.headers.get('authorization'));
    const saved = gateway.requests.filter((recorded) => `${recorded.method} ${recorded.path}` === SAVE_ADMIN_STATE);
    expect(saved.map((recorded) => recorded.json)).toEqual([expect.objectContaining({ mura: { flatViewArgs } })]);
  });

  it('GET cUsers.download answers the people CSV as an attachment', async () => {
    install({ [USERS_CSV]: tenantAUsersCsv });

    const { response } = await send('/admin-raw/cusers/download', {
      user: SUBJECTS.siteAdmin,
      query: { siteid: SITE, ispublic: '0' },
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(USERS_CSV_HEADERS['content-type']);
    expect(response.headers.get('content-disposition')).toBe(USERS_CSV_HEADERS['content-disposition']);
    expect(await response.text()).toBe(TENANT_A_USERS_CSV_BODY);
  });

  it('POST carch.update answers 404 for the withheld content save, which stays on legacy, unrelayed', async () => {
    install({
      [CARCH_UPDATE]: {
        status: 200,
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: writeResultReRender,
      },
    });

    const { response } = await send('/admin-raw/carch/update', {
      user: SUBJECTS.siteAdmin,
      form: formWithCsrf(
        {
          siteid: SITE,
          action: 'add',
          contentid: CONTENT_IDS.aboutUs,
          contenthistid: CONTENT_HIST_IDS.aboutUs,
          parentid: ROOT_CONTENT_ID,
          moduleid: SITE_MANAGER_MODULE_ID,
          type: 'Page',
          title: '',
        },
        POSTED_CSRF,
      ),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(404);
    expect(relayed(toService('strategies-content'))).toEqual([]);
    expect(relayed((recorded) => recorded.method !== 'GET')).toEqual([]);
  });
});

describe('opt2 synthetic actions', () => {
  it('POST day-action applies the action with the posted CSRF pair and redirects to the sheet', async () => {
    install({ ...sessionRoutes(primaryApprover, tenantASiteAdminSession), ...timesheetsAnswersByRole.primaryApprover });

    const { response } = await send('/opt2/admin-actions/timesheets/day-action', {
      user: primaryApprover,
      form: dayAction(TIMESHEET_IDS.daySubmitted, 'primary-approve'),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      `/opt2/admin/timesheets/sheet?siteid=${SITE}&asOf=${TIMESHEETS_AS_OF}&timesheetid=${TIMESHEET_IDS.sheetReturned}`,
    );
    const route = dayActionRoute(TIMESHEET_IDS.daySubmitted, 'primary-approve');
    const write = gateway.requests.find((recorded) => `${recorded.method} ${recorded.path}` === route);
    expect(write?.headers['x-csrf_token']).toBe(POSTED_CSRF.token);
  });

  it('POST day-action on a blackout day re-renders the sheet with the 409 message in an alert', async () => {
    install({ ...sessionRoutes(employee, tenantASiteAdminSession), ...timesheetsAnswersByRole.employee });

    const { response } = await send('/opt2/admin-actions/timesheets/day-action', {
      user: employee,
      form: dayAction(TIMESHEET_IDS.dayBlackout, 'submit'),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    const $ = cheerio.load(await response.text());
    expect($('.alert').text()).toContain('blackout');
  });

  it('POST day-action without a timesheets role redirects to cMessage.noaccess', async () => {
    install({ ...sessionRoutes(SUBJECTS.systemUser, tenantASiteAdminSession), ...timesheetsAnswersByRole.employee });

    const { response } = await send('/opt2/admin-actions/timesheets/day-action', {
      user: SUBJECTS.systemUser,
      form: dayAction(TIMESHEET_IDS.daySubmitted, 'primary-approve'),
    });

    expectLegacyHeaders(response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')?.endsWith(`?muraAction=${ADMIN_NOACCESS_ACTION}`)).toBe(true);
    expect(relayed(toService('timesheets'))).toEqual([]);
  });
});

/** One request per route module. */
const ROUTE_TARGETS: ReadonlyArray<{ readonly path: string; readonly opts: AdminRequestOptions }> = [
  { path: '/admin-actions/clogin/logout', opts: {} },
  { path: '/admin-raw/cusers/download', opts: { query: { siteid: SITE, ispublic: '0' } } },
  {
    path: '/opt2/admin-actions/timesheets/day-action',
    opts: { form: dayAction(TIMESHEET_IDS.daySubmitted, 'primary-approve') },
  },
];

const REFUSALS: ReadonlyArray<{
  readonly refusal: string;
  readonly credentials: () => Promise<AdminRequestOptions>;
  readonly status: 401 | 403;
}> = [
  {
    refusal: 'a request without the invocation credential',
    credentials: async () => ({ invocation: false }),
    status: 403,
  },
  {
    refusal: 'a caller other than the gateway',
    credentials: async () => ({ invocation: await serviceInvocation('people') }),
    status: 403,
  },
  { refusal: 'an invalid user token', credentials: async () => ({ userToken: 'not-a-token' }), status: 401 },
];

describe.each(ROUTE_TARGETS)('$path refusals', ({ path, opts }) => {
  // The gateway ↔ web contract answers these bare: no legacy response exists for a caller that is not the gateway.
  it.each(REFUSALS)('refuses $refusal with a bare $status before any relay', async ({ credentials, status }) => {
    install(sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession));

    const { response } = await send(path, { ...opts, user: SUBJECTS.siteAdmin, ...(await credentials()) });

    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
    expect(response.headers.get('generator')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(relayed((recorded) => recorded.path.startsWith(SERVICE_PREFIX))).toEqual([]);
  });
});

describe('fail closed', () => {
  it.each<{
    readonly label: string;
    readonly path: string;
    readonly opts: AdminRequestOptions;
    arrange(): Promise<void> | void;
  }>([
    {
      label: 'admin-actions when the gateway refuses connections',
      path: '/admin-actions/clogin/logout',
      opts: { user: SUBJECTS.admin },
      arrange: () => gateway.refuse(),
    },
    {
      label: 'admin-actions when identity answers 503',
      path: '/admin-actions/clogin/logout',
      opts: { user: SUBJECTS.admin },
      arrange: () => install({ ...sessionRoutes(SUBJECTS.admin, adminS2Session), [LOGOUT]: { status: 503 } }),
    },
    {
      label: 'admin-raw when people answers 503',
      path: '/admin-raw/cusers/download',
      opts: { user: SUBJECTS.siteAdmin, query: { siteid: SITE, ispublic: '0' } },
      arrange: () =>
        install({ ...sessionRoutes(SUBJECTS.siteAdmin, tenantASiteAdminSession), [USERS_CSV]: { status: 503 } }),
    },
    {
      label: 'opt2/admin-actions when timesheets answers 503',
      path: '/opt2/admin-actions/timesheets/day-action',
      opts: { user: primaryApprover, form: dayAction(TIMESHEET_IDS.daySubmitted, 'primary-approve') },
      arrange: () =>
        install({
          ...sessionRoutes(primaryApprover, tenantASiteAdminSession),
          [dayActionRoute(TIMESHEET_IDS.daySubmitted, 'primary-approve')]: { status: 503 },
        }),
    },
  ])('answers the legacy admin 503 from $label', async ({ path, opts, arrange }) => {
    await arrange();

    const { response } = await send(path, opts);

    expectLegacyHeaders(response);
    expect(response.status).toBe(UNAVAILABLE.status);
    expect(response.statusText).toBe(UNAVAILABLE.statusText);
    expect(response.headers.get('content-type')).toBe(UNAVAILABLE.headers['Content-Type']);
    expect(await response.text()).toBe(LEGACY_ERROR_PAGE_HTML);
  });
});
