// A service's 401 or 403 as legacy answers it: a GatewayDenialError, then clogin.logout or secure().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { ADMIN_LOGIN_REDIRECT_ACTION } from '@opt2/platform/legacy-compat';
import { applicationGate, deniedGate, runGate, secure } from '@/lib/access-gate';
import { authenticateRequest } from '@/lib/auth';
import { resetLegacySettingsForTests } from '@/lib/env';
import {
  GatewayDenialError,
  GatewayUnavailableError,
  createGatewayClient,
  setServiceClientForTests,
  type WebServiceName,
} from '@/lib/gateway-client';
import { ORIGINAL_URL_HEADER, buildAdminRequest, type AdminMode, type AdminRequest } from '@/lib/request-context';
import { carchGate } from '@/screens/carch/controller';
import { listGate } from '@/screens/carch/list';
import { editorRequest, noSitesRequest } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  startFakeGateway,
  type FakeGateway,
  type FakeReply,
} from '../helpers/fake-gateway';
import { SUBJECTS, gatewayInvocation, userTokenFor, type WebTestSubject } from '../helpers/tokens';

let restoreEnv: () => void;

/** Replaces every `MURA_` variable with `vars`. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => {
  restoreEnv = useTestEnv();
  useSettings();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('deniedGate', () => {
  const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';

  it.each<[AdminMode, Record<string, string>, string]>([
    ['page', {}, `/admin/?muraAction=${ADMIN_LOGIN_REDIRECT_ACTION}`],
    ['redirect', { MURA_CONTEXT: '/cms' }, '/cms/admin/?muraAction=clogin.logout'],
  ])('sends a 401 in %s mode under %j where the application gate sends a public user', (mode, settings, location) => {
    useSettings(settings);
    // Legacy's gate sends a public user without sites to clogin.logout.
    const gated = noSitesRequest({ s2IsPrivate: false }, { circuit: 'cusers', item: 'list', mode });
    const denied = deniedGate(401, { headers: new Headers({ referer: REFERER }) });

    expect(denied).toEqual({ kind: 'redirect', location });
    expect(denied).toEqual(applicationGate(gated));
  });

  it.each<[AdminMode, Record<string, string>, string]>([
    ['page', { referer: REFERER }, REFERER],
    ['page', {}, './'],
    ['redirect', {}, './'],
    ['raw', { referer: REFERER }, REFERER],
  ])('backs a 403 in %s mode with headers %j up to %s, as secure() of a logged-in user', (mode, headers, location) => {
    const req = { mode, headers: new Headers(headers) };

    expect(deniedGate(403, req)).toEqual({ kind: 'redirect', location });
    expect(deniedGate(403, req)).toEqual(secure(editorRequest(req)));
  });
});

describe('a service answer through the production gateway client', () => {
  const CURRENT_SESSION = routeKey('GET', 'identity', '/v1/sessions/current');
  const SHELL_SITE = routeKey('GET', 'programs-sites', '/v1/sites/default/shell');
  const admin = SUBJECTS.admin;

  /** identity and programs-sites answering the S2 admin's request on `default`. */
  const ADMIN_ROUTES: Readonly<Record<string, FakeReply>> = {
    [CURRENT_SESSION]: {
      status: 200,
      body: {
        sessionId: admin.sid,
        epoch: 0,
        user: { isLoggedIn: true, userID: admin.sub, siteID: admin.site, memberships: 'S2' },
        roles: [...admin.roles],
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: {
      status: 200,
      body: { sites: [{ siteID: 'default', site: 'Default' }] },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: {} },
    [SHELL_SITE]: { status: 200, body: { site: { SiteID: 'default', Site: 'Default' }, isNew: 0 } },
  };

  let fake: FakeGateway;
  let restoreGatewayEnv: () => void;
  let restoreClient: () => void;

  beforeEach(async () => {
    fake = await startFakeGateway(ADMIN_ROUTES);
    restoreGatewayEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
    restoreClient = setServiceClientForTests(undefined);
  });

  afterEach(async () => {
    restoreClient();
    restoreGatewayEnv();
    await fake.close();
  });

  /** The real set-up of the admin's `GET /admin/?muraAction=cusers.list&siteid=default` over the loopback gateway. */
  async function buildOverHttp(): Promise<AdminRequest> {
    const headers = new Headers({ [INVOCATION_HEADER]: `Bearer ${await gatewayInvocation()}` });
    headers.set('authorization', `Bearer ${await userTokenFor(admin)}`);
    const auth = await authenticateRequest(headers, '/admin/');
    const target = '/admin/?muraAction=cusers.list&siteid=default';
    return buildAdminRequest({
      params: { circuit: 'cusers', action: 'list' },
      searchParams: new URLSearchParams(target.split('?')[1]),
      headers: new Headers({ [ORIGINAL_URL_HEADER]: target }),
      auth,
      gateway: createGatewayClient({ userToken: auth.userToken, requestId: 'req-denial', inbound: {} }),
      mode: 'page',
    });
  }

  it('builds the request when every service answers', async () => {
    const request = await buildOverHttp();

    expect(request.site?.siteid).toBe('default');
    expect(fake.requests.map(({ method, path }) => `${method} ${path}`)).toContain(SHELL_SITE);
  });

  it.each<[string, WebServiceName, string, 401 | 403, string]>([
    [CURRENT_SESSION, 'identity', 'getCurrentSession', 401, '/admin/?muraAction=clogin.logout'],
    [CURRENT_SESSION, 'identity', 'getCurrentSession', 403, './'],
    [SHELL_SITE, 'programs-sites', 'getShellSite', 401, '/admin/?muraAction=clogin.logout'],
    [SHELL_SITE, 'programs-sites', 'getShellSite', 403, './'],
  ])('turns %s of %s (%s) answering HTTP %i into the gate redirect', async (key, service, operation, status, to) => {
    fake.setRoute(key, { status, body: { error: { type: 'authorization' } } });

    const error: unknown = await buildOverHttp().catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service, operation, status });
    const carried = { headers: new Headers() };
    expect(deniedGate((error as GatewayDenialError).status, carried)).toEqual({ kind: 'redirect', location: to });
    expect(fake.requests.find(({ path }) => key.endsWith(path))?.headers.authorization).toMatch(/^Bearer /);
  });

  it.each<[string, WebServiceName]>([
    [CURRENT_SESSION, 'identity'],
    [SHELL_SITE, 'programs-sites'],
  ])('keeps a 503 from %s a GatewayUnavailableError', async (key, service) => {
    fake.setRoute(key, { status: 503 });

    const error: unknown = await buildOverHttp().catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).not.toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service, status: 503 });
  });
});

describe('a signed-in user whose token grants no role on the requested site', () => {
  const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=default';
  const SESSION_ROUTES = {
    current: routeKey('GET', 'identity', '/v1/sessions/current'),
    sites: routeKey('GET', 'identity', '/v1/sessions/current/sites'),
    adminState: routeKey('GET', 'identity', '/v1/sessions/current/admin-state'),
  };

  /** The real set-up of `cArch.list&siteid=<site>` under the role-less token identity mints for that site. */
  async function carchListOn(
    subject: WebTestSubject,
    site: string,
    sites: string[],
    referer?: string,
    memberships = 'S2IsPrivate',
  ) {
    const headers = new Headers({ [INVOCATION_HEADER]: `Bearer ${await gatewayInvocation()}` });
    headers.set('authorization', `Bearer ${await userTokenFor(subject, { site, roles: [], s2: false })}`);
    const auth = await authenticateRequest(headers, '/admin/');
    const user = { isLoggedIn: true, userID: subject.sub, siteID: subject.site, memberships };
    const gateway = fakeGatewayClient(
      {
        [SESSION_ROUTES.current]: {
          status: 200,
          body: { sessionId: subject.sid, epoch: 0, user, roles: [], mfaPending: false, blockLoginUntil: null },
        },
        [SESSION_ROUTES.sites]: { status: 200, body: { sites: sites.map((siteID) => ({ siteID, site: siteID })) } },
        [SESSION_ROUTES.adminState]: { status: 200, body: {} },
      },
      { userToken: auth.userToken },
    );
    const query = `muraAction=cArch.list&siteid=${site}`;
    const request = await buildAdminRequest({
      params: { circuit: 'carch', action: 'list' },
      searchParams: new URLSearchParams(query),
      headers: new Headers({ [ORIGINAL_URL_HEADER]: `/admin/?${query}`, ...(referer ? { referer } : {}) }),
      auth,
      gateway,
      mode: 'page',
    });
    return { request, gateway };
  }

  it.each<[string, WebTestSubject, string, string[], string | undefined, string]>([
    ['qa_editor on tenant-a, back to the Referer', SUBJECTS.qaEditor, 'tenant-a', ['default'], REFERER, REFERER],
    ['qa_editor on tenant-a without a Referer', SUBJECTS.qaEditor, 'tenant-a', ['default'], undefined, './'],
    ['the tenant-a site admin on tenant-b', SUBJECTS.siteAdmin, 'tenant-b', ['tenant-a'], REFERER, REFERER],
    [
      'the admin without the S2 membership on an unregistered site',
      SUBJECTS.admin,
      'nosuchsite',
      ['default', 'tenant-a'],
      undefined,
      './',
    ],
  ])('gets secure() past the application gate: %s', async (_label, subject, site, sites, referer, location) => {
    const { request, gateway } = await carchListOn(subject, site, sites, referer);

    expect(gateway.calls.map(({ path }) => path)).toContain('/v1/sessions/current/sites');
    expect(request.session.siteArray).toEqual(sites);
    expect(applicationGate(request)).toEqual({ kind: 'allow' });
    await expect(runGate(request, carchGate)).resolves.toEqual({ kind: 'redirect', location });
  });

  it('admits the S2 admin on an unregistered site at the cArch.list gate alone, by its S2 membership', async () => {
    const sites = ['default', 'tenant-a'];
    const { request } = await carchListOn(SUBJECTS.admin, 'nosuchsite', sites, undefined, 'S2IsPrivate,S2');

    expect([request.isS2, request.session.siteArray]).toEqual([false, sites]);
    await expect(runGate(request, listGate)).resolves.toEqual({ kind: 'allow' });
    await expect(runGate(request, carchGate)).resolves.toEqual({ kind: 'redirect', location: './' });
  });
});
