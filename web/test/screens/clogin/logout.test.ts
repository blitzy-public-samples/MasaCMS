// clogin.logout against legacy clogin.cfc logout(): identity ends the session, then FW/1 redirects to the admin home.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { fw1RedirectTarget } from '@/lib/urls';
import { cloginLogoutScreen } from '@/screens/clogin/logout';
import type { SubmitResult } from '@/screens/registry';
import { LOGOUT_DELETE_COOKIES, logoutAnswer } from '../../fixtures/identity/session-login';
import { adminS2Request, anonymousRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRoute } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const LOGOUT_ROUTE = routeKey('POST', 'identity', '/v1/sessions/logout');
const USER_TOKEN = 'admin-user-token';

const LOGOUT_CALL = { service: 'identity', method: 'POST', path: '/v1/sessions/logout' } as const;

const HOME_REDIRECT: SubmitResult = {
  kind: 'redirect',
  action: 'home.redirect',
  path: './',
  setCookies: [...LOGOUT_DELETE_COOKIES],
};

/** The gateway answering identity's logout with `route`, under `userToken` when given. */
const gatewayFor = (route: FakeRoute = logoutAnswer, userToken?: string): FakeGatewayClient =>
  fakeGatewayClient({ [LOGOUT_ROUTE]: route }, { userToken });

/** Runs the screen for `req` over `gateway`. */
const submit = (req: AdminRequest, gateway: FakeGatewayClient): Promise<SubmitResult> =>
  cloginLogoutScreen.submit(makeScreenContext({ req, gateway }));

/** The `Location` the redirect-mode handler sends for a FW/1 redirect result of `req`. */
function locationOf(result: SubmitResult, req: AdminRequest): string {
  if (result.kind !== 'redirect') throw new Error(`expected a FW/1 redirect, got ${result.kind}`);
  return fw1RedirectTarget({ action: result.action, path: result.path, queryString: result.queryString, ses: req.ses });
}

describe('clogin.logout', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useTestEnv();
  });
  afterEach(() => {
    restore();
  });

  it('is the identity-owned redirect-mode clogin.logout with no gate or variant', () => {
    expect(cloginLogoutScreen).toMatchObject({
      circuit: 'clogin',
      action: 'logout',
      owner: 'identity',
      mode: 'redirect',
    });
    expect(cloginLogoutScreen.gate).toBeUndefined();
    expect(cloginLogoutScreen.variant).toBeUndefined();
  });

  it('redirects to home.redirect', async () => {
    const req = adminS2Request();

    const result = await submit(req, gatewayFor());

    expect(result).toMatchObject({ kind: 'redirect', action: 'home.redirect', path: './' });
    // FW/1 buildURL emits only the path for the framework home action, so legacy answers `Location: ./`.
    expect(locationOf(result, req)).toBe('./');
  });

  it('passes cookie deletions through', async () => {
    const result = await submit(adminS2Request(), gatewayFor());

    expect(result).toEqual(HOME_REDIRECT);
  });

  it('calls identity once', async () => {
    const gateway = gatewayFor(logoutAnswer, USER_TOKEN);

    await submit(adminS2Request(), gateway);

    expect(gateway.calls).toEqual([{ ...LOGOUT_CALL, userToken: USER_TOKEN }]);
  });

  it('anonymous logout', async () => {
    const req = anonymousRequest();
    const gateway = gatewayFor();

    const result = await submit(req, gateway);

    expect(gateway.calls).toEqual([LOGOUT_CALL]);
    expect(result).toEqual(HOME_REDIRECT);
    expect(locationOf(result, req)).toBe('./');
  });

  it("ignores identity's redirect body", async () => {
    const elsewhere = { ...logoutAnswer, body: { redirect: { action: 'cUsers.list', params: { siteid: 'default' } } } };

    const result = await submit(adminS2Request(), gatewayFor(elsewhere));

    expect(result).toEqual(HOME_REDIRECT);
  });

  it('redirects home when identity rejects the user token', async () => {
    const result = await submit(adminS2Request(), gatewayFor({ status: 401, body: { error: 'invalidAccessToken' } }));

    expect(result).toEqual({ kind: 'redirect', action: 'home.redirect', path: './', setCookies: [] });
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    {
      outage: 'a 503 answer',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(LOGOUT_ROUTE, { status: 503, body: {} }),
    },
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const gateway = gatewayFor();
    arrange(gateway);

    await expect(submit(adminS2Request(), gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it.each([
    { status: 403, type: GatewayDenialError, name: 'GatewayDenialError' },
    { status: 500, type: Error, name: 'Error' },
  ])('rejects with $name when identity answers $status', async ({ status, type, name }) => {
    const failure = await submit(adminS2Request(), gatewayFor({ status, body: {} })).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(type);
    expect(failure).toMatchObject({ name, message: `logout answered HTTP ${status}` });
  });
});
