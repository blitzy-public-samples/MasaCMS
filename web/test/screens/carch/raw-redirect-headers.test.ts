// carch raw redirects through the production admin-raw adapter and registry: legacy's cflocation headers and cookies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServiceClientForTests } from '@/lib/gateway-client';
import * as adminRaw from '../../../app/admin-raw/[circuit]/[action]/route';
import { siteRecordFor } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway } from '../../helpers/fake-gateway';
import { adminRequest, routeParams } from '../../helpers/requests';
import { SUBJECTS } from '../../helpers/tokens';

// The spans stay in-process: the SDK, and with it the OTLP exporter, is never started.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(() => Promise.resolve(undefined)),
  logRequest: vi.fn(),
}));

const SITE = 'default';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
const HIST_ID = 'D0000000-0000-0000-0000000000000002';
const FILE_ID = 'F0000000-0000-0000-0000000000000003';
const ATTACHMENT = `/index.cfm/_api/render/file/?fileid=${FILE_ID}&method=attachment`;
const REFERER = `http://localhost/admin/?muraAction=cArch.list&siteid=${SITE}`;
const SERVICE_COOKIE = 'CFTOKEN=0;Path=/;HttpOnly';
const CSRF_FIELDS = { csrf_token: 'POSTEDTOKEN', csrf_token_expires: '261231235959000' } as const;
const DENIED = { apiversion: 'v1', method: 'carch', error: { message: 'Denied', code: 'denied' } };
const LOCKFILE_PATH = '/v1/raw/carch/lockfile';
const STATUSMODAL_PATH = '/v1/raw/carch/statusmodal';
const OBJECT_PARAMS_PATH = `/v1/sites/${SITE}/content/versions/${HIST_ID}/object-params` as const;
// The cookies the request set-up sets for a browser that sent none (request-context adminCookies), in order.
const SETUP_COOKIES = ['rb', 'ADMINCONTROLWIDTH', 'ADMINSIDEBAR'];

const admin = SUBJECTS.admin;
let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

beforeEach(async () => {
  const lock = {
    status: 302,
    headers: { Location: ATTACHMENT, 'X-Opt2-Write-Position': '7' },
    setCookies: [SERVICE_COOKIE],
  };
  fake = await startFakeGateway({
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
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: {
      status: 200,
      body: { sites: [{ siteID: SITE, site: 'Default' }] },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: { siteid: SITE } },
    [routeKey('POST', 'identity', '/v1/sessions/current/admin-state')]: (request) => ({
      status: 200,
      body: request.json ?? {},
    }),
    [routeKey('GET', 'programs-sites', `/v1/sites/${SITE}/shell`)]: {
      status: 200,
      body: { site: siteRecordFor(SITE), isNew: 0 },
    },
    [routeKey('GET', 'programs-sites', '/v1/href-domains')]: {
      status: 200,
      body: { allowedDomains: ['localhost'], siteDomain: 'localhost' },
    },
    [routeKey('GET', 'strategies-content', LOCKFILE_PATH)]: lock,
    [routeKey('POST', 'strategies-content', LOCKFILE_PATH)]: lock,
    [routeKey('GET', 'strategies-content', STATUSMODAL_PATH)]: { status: 403, body: DENIED },
    [routeKey('POST', 'strategies-content', OBJECT_PARAMS_PATH)]: { status: 403, body: DENIED },
  });
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

/** The requests the fake received for the strategies-content `path` with `method`. */
const serviceCalls = (method: string, path: string) =>
  fake.requests.filter((request) => request.method === method && request.path.endsWith(`/strategies-content${path}`));

/** The `Set-Cookie` names of `response`, in order. */
const cookieNames = (response: Response): string[] =>
  response.headers.getSetCookie().map((cookie) => cookie.slice(0, cookie.indexOf('=')));

/** Asserts `response` is legacy's `cflocation` 302 to `location`, with no internal header. */
function expectLegacyRedirect(response: Response, location: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(location);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('content-type')).toBe('text/html;charset=UTF-8');
  expect(response.headers.get('generator')).toBe('Masa CMS 7.6.1');
  expect([...response.headers.keys()].filter((name) => name.startsWith('x-opt2-'))).toEqual([]);
}

describe('carch raw redirects through the admin-raw route', () => {
  it.each([
    ['GET', { query: { siteid: SITE, contentid: CONTENT_ID } }],
    ['POST', { form: { siteid: SITE, contentid: CONTENT_ID, ...CSRF_FIELDS } }],
  ] as const)('answers a %s carch.lockfile with the relayed download redirect', async (method, body) => {
    const request = await adminRequest('/admin-raw/carch/lockfile', { user: 'admin', ...body });

    const response = await adminRaw[method](request, routeParams({ circuit: 'carch', action: 'lockfile' }));

    expectLegacyRedirect(response, ATTACHMENT);
    expect(cookieNames(response)).toEqual([...SETUP_COOKIES, 'CFTOKEN']);
    expect(response.headers.getSetCookie().at(-1)).toBe(SERVICE_COOKIE);
    expect(await response.text()).toBe('');
    expect(serviceCalls(method, LOCKFILE_PATH)).toHaveLength(1);
  });

  it.each([
    [
      'the carch.statusmodal relay',
      'statusmodal',
      STATUSMODAL_PATH,
      { query: { siteid: SITE, contenthistid: HIST_ID } },
    ],
    [
      'the carch.updateobjectparams write',
      'updateobjectparams',
      OBJECT_PARAMS_PATH,
      { form: { siteid: SITE, contenthistid: HIST_ID, regionid: '2', object: 'feed', ...CSRF_FIELDS } },
    ],
  ] as const)('answers a 403 on %s with the secure() redirect', async (_name, action, path, body) => {
    const request = await adminRequest(`/admin-raw/carch/${action}`, {
      user: 'admin',
      headers: { referer: REFERER },
      ...body,
    });
    const method = 'form' in body ? 'POST' : 'GET';

    const response = await adminRaw[method](request, routeParams({ circuit: 'carch', action }));

    expectLegacyRedirect(response, REFERER);
    expect(cookieNames(response)).toEqual(SETUP_COOKIES);
    expect(await response.text()).toBe('');
    expect(serviceCalls(method, path)).toHaveLength(1);
  });
});
