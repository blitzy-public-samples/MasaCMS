// clogin.logout against legacy clogin.cfc logout(): identity ends the session, then FW/1 redirects to the admin home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { cloginLogoutScreen } from '@/screens/clogin/logout';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request, anonymousRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const LOGOUT_ROUTE = routeKey('POST', 'identity', '/v1/sessions/logout');

// The cookie deletions loginManager.logout() emits, in the form the ACF 2023 oracle sends them.
const LOGOUT_COOKIES = [
  'userHash=;expires=Thu, 12-Nov-2026 15:30:45 GMT;path=/;HttpOnly;',
  'userid=;expires=Thu, 12-Nov-2026 15:30:45 GMT;path=/;HttpOnly;',
] as const;

// A redirect other than the controller's, to show identity's body never picks the target.
const LOGGED_OUT: FakeReply = {
  status: 200,
  body: { redirect: { action: 'cUsers.list', params: { siteid: 'default' } } },
  setCookies: LOGOUT_COOKIES,
};

const HOME_REDIRECT: SubmitResult = {
  kind: 'redirect',
  action: 'home.redirect',
  path: './',
  setCookies: [...LOGOUT_COOKIES],
};

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** The `Location` the redirect-mode handler sends for a FW/1 redirect result. */
function locationOf(result: SubmitResult): string {
  if (result.kind !== 'redirect') throw new Error(`expected a FW/1 redirect, got ${result.kind}`);
  return fw1RedirectTarget({ action: result.action, path: result.path, queryString: result.queryString });
}

describe('clogin.logout', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('is the identity-owned redirect-mode clogin.logout with no screen gate or variant', () => {
    expect(cloginLogoutScreen).toMatchObject({
      circuit: 'clogin',
      action: 'logout',
      owner: 'identity',
      mode: 'redirect',
    });
    expect(cloginLogoutScreen.gate).toBeUndefined();
    expect(cloginLogoutScreen.variant).toBeUndefined();
  });

  it.each([
    { caller: 'a logged-in admin', request: adminS2Request, userToken: 'admin-user-token' },
    { caller: 'an anonymous caller', request: anonymousRequest, userToken: undefined },
  ])('for $caller, ends the session once through identity and redirects home with its cookies', async (row) => {
    const gateway = fakeGatewayClient({ [LOGOUT_ROUTE]: LOGGED_OUT }, { userToken: row.userToken });

    const result = await cloginLogoutScreen.submit(contextFor(row.request(), gateway));

    const token = row.userToken === undefined ? {} : { userToken: row.userToken };
    expect(gateway.calls).toEqual([{ service: 'identity', method: 'POST', path: '/v1/sessions/logout', ...token }]);
    expect(result).toEqual(HOME_REDIRECT);
    // FW/1 buildURL drops the home action, so legacy answers `Location: ./`.
    expect(locationOf(result)).toBe('./');
  });

  it('redirects home when identity rejects the user token, as legacy does for a session already gone', async () => {
    const gateway = fakeGatewayClient({ [LOGOUT_ROUTE]: { status: 401, body: { error: 'invalidAccessToken' } } });

    const result = await cloginLogoutScreen.submit(contextFor(adminS2Request(), gateway));

    expect(result).toEqual({ kind: 'redirect', action: 'home.redirect', path: './', setCookies: [] });
  });

  it.each([
    { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
    {
      outage: 'a 503 answer',
      arrange: (gateway: FakeGatewayClient) => gateway.setRoute(LOGOUT_ROUTE, { status: 503, body: {} }),
    },
  ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
    const gateway = fakeGatewayClient();
    arrange(gateway);

    await expect(cloginLogoutScreen.submit(contextFor(adminS2Request(), gateway))).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });

  it.each([
    { status: 403, type: GatewayDenialError, name: 'GatewayDenialError' },
    { status: 500, type: Error, name: 'Error' },
  ])('rejects with $name when identity answers $status', async ({ status, type, name }) => {
    const gateway = fakeGatewayClient({ [LOGOUT_ROUTE]: { status, body: {} } });

    const failure = await cloginLogoutScreen.submit(contextFor(adminS2Request(), gateway)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(type);
    expect(failure).toMatchObject({ name, message: `logout answered HTTP ${status}` });
  });
});
