// A service's 401 or 403 as the legacy access gate answers it: a GatewayDenialError, then clogin.logout or noaccess.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION } from '@opt2/platform/legacy-compat';
import { applicationGate, deniedGate } from '@/lib/access-gate';
import { authenticateRequest } from '@/lib/auth';
import { resetLegacySettingsForTests } from '@/lib/env';
import {
  GatewayDenialError,
  GatewayUnavailableError,
  createGatewayClient,
  setServiceClientForTests,
  type WebServiceName,
} from '@/lib/gateway-client';
import { ORIGINAL_URL_HEADER, buildAdminRequest, type AdminRequest } from '@/lib/request-context';
import { noSitesRequest } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway, type FakeReply } from '../helpers/fake-gateway';
import { SUBJECTS, gatewayInvocation, userTokenFor } from '../helpers/tokens';

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
  it.each<[401 | 403, Record<string, string>, string]>([
    [401, {}, `/admin/?muraAction=${ADMIN_LOGIN_REDIRECT_ACTION}`],
    [403, {}, `/admin/?muraAction=${ADMIN_NOACCESS_ACTION}`],
    [401, { MURA_CONTEXT: '/cms' }, '/cms/admin/?muraAction=clogin.logout'],
    [403, { MURA_CONTEXT: '/cms', MURA_ADMINDIR: '/manage' }, '/cms/manage/?muraAction=cMessage.noaccess'],
  ])('sends a %i under %j where the application gate sends it', (status, settings, location) => {
    useSettings(settings);
    // Legacy's gate sends a public user without sites to clogin.logout and a private one to cMessage.noaccess.
    const gated = noSitesRequest({ s2IsPrivate: status === 403 }, { circuit: 'cusers', item: 'list' });

    expect(deniedGate(status)).toEqual({ kind: 'redirect', location });
    expect(deniedGate(status)).toEqual(applicationGate(gated));
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
    [CURRENT_SESSION, 'identity', 'getCurrentSession', 403, '/admin/?muraAction=cMessage.noaccess'],
    [SHELL_SITE, 'programs-sites', 'getShellSite', 401, '/admin/?muraAction=clogin.logout'],
    [SHELL_SITE, 'programs-sites', 'getShellSite', 403, '/admin/?muraAction=cMessage.noaccess'],
  ])('turns %s of %s (%s) answering HTTP %i into the gate redirect', async (key, service, operation, status, to) => {
    fake.setRoute(key, { status, body: { error: { type: 'authorization' } } });

    const error: unknown = await buildOverHttp().catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service, operation, status });
    expect(deniedGate((error as GatewayDenialError).status)).toEqual({ kind: 'redirect', location: to });
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
