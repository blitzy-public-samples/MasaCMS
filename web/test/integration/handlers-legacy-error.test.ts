// Real registered screens whose request legacy fails at run time, through the handlers and the loopback gateway:
// legacy's 500 debug page for a fault web reproduces, else its error page.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LegacyFaultError,
  legacyDebugPageHtml,
  legacyHeaders,
} from '@opt2/platform/legacy-compat';
import { resetLegacySettingsForTests } from '@/lib/env';
import { setServiceClientForTests } from '@/lib/gateway-client';
import { handleAdminAction, handleAdminPage, type AdminRouteParams } from '@/lib/handlers';
import { encodeHtml } from '@/lib/html';
import { logRequest } from '@/lib/telemetry';
import { siteRecordFor } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway, type FakeRouteTable } from '../helpers/fake-gateway';
import { adminRequest, type AdminRequestOptions } from '../helpers/requests';
import { FIXED_CSRF, shellRoutes } from '../helpers/screen-context';
import { SUBJECTS } from '../helpers/tokens';

// Request log lines are recorded instead of written to stdout.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  logRequest: vi.fn(),
}));

const SITE = 'default';
const HOME = '00000000000000000000000000000000001';
const FORMS_MODULE = '00000000000000000000000000000000004';
const TOP_MODULE = '00000000000000000000000000000000000';
const RESPONSE_ID = '75CFADFF-8ECE-DBCF-0A633A519B114133';
const USER_ID = 'A1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D';
const SAVE_ADMIN_STATE = routeKey('POST', 'identity', '/v1/sessions/current/admin-state');

/** identity's session of the S2 admin on `default`, the site and shell reads, then `routes`. */
function sessionRoutes(routes: FakeRouteTable): FakeRouteTable {
  const admin = SUBJECTS.admin;
  return shellRoutes({
    [routeKey('GET', 'identity', '/v1/sessions/current')]: {
      status: 200,
      body: {
        sessionId: admin.sid,
        epoch: 0,
        user: {
          isLoggedIn: true,
          userID: admin.sub,
          siteID: admin.site,
          memberships: 'S2IsPrivate;default,S2IsPrivate,S2',
          fname: 'Admin',
          lname: 'User',
        },
        roles: [...admin.roles],
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: { status: 200, body: { sites: [{ siteID: SITE, site: 'Default' }] } },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: { siteid: SITE } },
    [SAVE_ADMIN_STATE]: (request) => ({ status: 200, body: request.json ?? {} }),
    [routeKey('GET', 'programs-sites', `/v1/sites/${SITE}/shell`)]: { status: 200, body: { site: siteRecordFor(SITE), isNew: 0 } },
    [routeKey('GET', 'programs-sites', '/v1/href-domains')]: { status: 200, body: { allowedDomains: ['localhost'], siteDomain: 'localhost' } },
    ...routes,
  });
}

/** strategies-content's listFormResponses model of a form with the one response the edit panel reads. */
const FORM_RESPONSES = {
  status: 200,
  body: {
    rc: {
      contentBean: {
        contentID: HOME,
        contentHistID: '6300ED69-1320-5CC3-F922E3012E2C6BAE',
        title: 'Home',
        body: '',
        responseDisplayFields: '',
        sortBy: 'orderno',
        sortDirection: 'asc',
        nextN: 10,
        type: 'Page',
        subType: 'Default',
        active: 1,
        filename: '',
        parentID: '00000000000000000000000000000000END',
        menuTitle: 'Home',
        remoteURL: '',
        fileID: '',
        isNew: 0,
        stats: { lockID: '', lockType: '' },
      },
      perm: 'editor',
      hasLockableNodes: 0,
      useLayoutManager: true,
      rsDataInfo: { firstentered: '2026-06-01 13:05:00.0', lastentered: '2026-06-01 13:05:00.0', countentered: 1 },
      fieldnames: 'NAME',
      rsData: [
        { responseID: RESPONSE_ID, entered: '2026-06-01 13:05:00.0', data: { RESPONSEID: RESPONSE_ID, FIELDNAMES: 'NAME', NAME: 'Ann' } },
      ],
      scheme: 'http',
      domain: 'localhost',
      serverPort: ':23580',
      context: '',
    },
  },
};

/**
 * One carried request legacy fails at run time: how web receives it, the services' answers, the failure web logs and
 * whether that failure is the fault legacy's debug page names.
 */
interface FailingCase {
  readonly label: string;
  readonly handle: typeof handleAdminPage;
  readonly path: string;
  readonly params: AdminRouteParams;
  readonly request: AdminRequestOptions;
  readonly routes: FakeRouteTable;
  readonly route: string;
  readonly cause: string;
  readonly fault: boolean;
}

/** The `cUsers.update{type=2,action=update}` post with a refused token, people answering it with `reply`. */
function refusedUserUpdate(label: string, reply: { readonly status: number; readonly body: unknown }, cause: string, fault: boolean): FailingCase {
  return {
    label,
    handle: handleAdminAction,
    path: '/admin-actions/cusers/update',
    params: { circuit: 'cusers', action: 'update' },
    request: {
      query: { muraAction: 'cUsers.update', userid: USER_ID },
      form: {
        type: '2',
        action: 'Update',
        userid: USER_ID,
        siteid: SITE,
        fname: 'Pat',
        lname: 'Lee',
        csrf_token: 'BOGUS',
        csrf_token_expires: FIXED_CSRF.expires,
      },
    },
    routes: { [routeKey('POST', 'people', '/v1/users:update')]: reply },
    route: 'redirect:cusers.update',
    cause,
    fault,
  };
}

const CASES: readonly FailingCase[] = [
  {
    label: "cPerm.main in Site Manager for a malformed contentid, whose empty crumb list fails legacy's dspZoom before identity's 400 is read",
    handle: handleAdminPage,
    path: '/admin/cperm/main',
    params: { circuit: 'cperm', action: 'main' },
    request: { query: { muraAction: 'cPerm.main', contentid: 'junk', siteid: SITE, moduleid: TOP_MODULE } },
    routes: {
      [routeKey('GET', 'identity', '/v1/permissions/content/junk')]: { status: 400, body: { error: { type: 'badRequest' } } },
      [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/content/junk/crumbs`)]: { status: 200, body: { rc: { crumbdata: [] } } },
      [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/approval-chains`)]: { status: 200, body: { rc: { chains: [] } } },
    },
    route: 'page:cperm.main',
    cause: 'The element at position 1 cannot be found.',
    fault: true,
  },
  {
    label: 'cArch.datamanager editing a response without hour1 or minute1',
    handle: handleAdminPage,
    path: '/admin/carch/datamanager',
    params: { circuit: 'carch', action: 'datamanager' },
    request: {
      query: {
        muraAction: 'cArch.datamanager',
        contentid: HOME,
        siteid: SITE,
        moduleid: FORMS_MODULE,
        topid: FORMS_MODULE,
        parentid: FORMS_MODULE,
        type: 'Form',
        action: 'edit',
        responseid: RESPONSE_ID,
      },
    },
    routes: { [routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/forms/${HOME}/responses`)]: FORM_RESPONSES },
    route: 'page:carch.datamanager',
    cause: 'Element HOUR1 is undefined in RC.',
    fault: true,
  },
  refusedUserUpdate(
    "cUsers.update{type=2,action=update} under a refused token, whose 500 server_error people's stacktrace names as the unset user bean",
    {
      status: 500,
      body: {
        apiversion: 'v1',
        method: 'invalid',
        error: {
          message: 'Unhandled Exception',
          code: 'server_error',
          stacktrace: { message: 'Element RC.userBean is undefined in ARGUMENTS.', type: 'Expression' },
        },
      },
    },
    'Element RC.userBean is undefined in ARGUMENTS.',
    true,
  ),
  refusedUserUpdate(
    'cUsers.update{type=2,action=update} whose 500 server_error from people names no fault, as for a value its column cannot store',
    { status: 500, body: { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error' } } },
    'updateUser answered HTTP 500',
    false,
  ),
];

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

beforeEach(async () => {
  fake = await startFakeGateway();
  // Unset, the setting takes the settings template's `debuggingenabled=true`.
  vi.stubEnv('MURA_DEBUGGINGENABLED', undefined);
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
  vi.mocked(logRequest).mockClear();
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  await fake.close();
});

/** Runs `failing` through its handler and checks legacy's 500 status line and headers, one ERROR line and no session write; returns the body. */
async function failedBody({ handle, path, params, request, routes, route, cause }: FailingCase): Promise<string> {
  for (const [key, reply] of Object.entries(sessionRoutes(routes))) fake.setRoute(key, reply);

  const response = await handle(await adminRequest(path, { user: 'admin', ...request }), params);

  expect(response.status).toBe(500);
  expect(response.statusText).toBe(LEGACY_ERROR_STATUS_TEXT);
  expect(response.headers.get('content-type')).toBe(LEGACY_HTML_CONTENT_TYPE);
  expect(response.headers.get('generator')).toBe(legacyHeaders().Generator);
  const lines = vi.mocked(logRequest).mock.calls.map(([fields]) => fields);
  expect(lines).toEqual([expect.objectContaining({ route, statusCode: 500, error: expect.objectContaining({ message: cause }) })]);
  expect(fake.requests.map(({ method, path: called }) => `${method} ${called}`)).not.toContain(SAVE_ADMIN_STATE);
  return response.text();
}

it.each(CASES.filter(({ fault }) => fault))("answers $label with legacy's debug page of that fault", async (failing) => {
  const body = await failedBody(failing);

  expect(body).toBe(legacyDebugPageHtml(new LegacyFaultError(failing.cause), encodeHtml));
  expect(body).toContain(`<h1>500 Error</h1><h2>${failing.cause}<br /></h2><h3>Type:Expression<br /></h3></div>`);
  expect(body).not.toContain('<title>');
});

it.each(CASES.filter(({ fault }) => !fault))("answers $label with legacy's error page", async (failing) => {
  expect(await failedBody(failing)).toBe(LEGACY_ERROR_PAGE_HTML);
});

it.each(CASES.filter(({ fault }) => fault))('answers $label with the error page when MURA_DEBUGGINGENABLED is false', async (failing) => {
  vi.stubEnv('MURA_DEBUGGINGENABLED', 'false');
  resetLegacySettingsForTests();

  expect(await failedBody(failing)).toBe(LEGACY_ERROR_PAGE_HTML);
});
