// clogin.login against legacy clogin.cfc login(): identity logs in and answers the redirect, or login.cfm renders.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { cloginLoginScreen } from '@/screens/clogin/login';
import { cloginMainScreen, type LoginViewState } from '@/screens/clogin/main';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '@/screens/registry';
import { CSRF_LOGIN } from '../../fixtures/identity/csrf';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, normaliseIds } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type LoginOutcome = components['schemas']['LoginOutcome'];

const LOGIN_ROUTE = routeKey('POST', 'identity', '/v1/sessions/login');
const FAILED_LOCATION =
  './?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=&LinkServID=' +
  '&returnURL=%2Fadmin%2F%3FmuraAction%3DcUsers%2Elist&compactDisplay=false';
const CHALLENGE_LOCATION =
  './?muraAction=cLogin.main&display=login&status=challenge&failedchallenge=false&rememberMe=0&contentid=' +
  '&LinkServID=&returnURL=&compactDisplay=false';
const REMEMBER_ME_COOKIES = [
  'userid=5A000000-0000-0000-0000000000000001;expires=Sat, 30-Jun-2046 12:00:00 GMT;path=/;HttpOnly;',
  'userHash=ABCDEF;expires=Sat, 30-Jun-2046 12:00:00 GMT;path=/;HttpOnly;',
] as const;

/** The admin login form as main.cfm posts it, with the `login` token pair. */
const POSTED = Object.freeze({
  username: 'admin',
  password: 'secret-p@ss,word',
  rememberMe: '1',
  rb: 'en_US',
  returnUrl: '/admin/?muraAction=cUsers.list',
  muraAction: 'cLogin.login',
  isAdminLogin: 'true',
  compactDisplay: 'false',
  csrf_token: CSRF_LOGIN.csrf_token,
  csrf_token_expires: CSRF_LOGIN.csrf_token_expires,
});

const CSRF_PAIR = Object.freeze({
  csrf_token: CSRF_LOGIN.csrf_token,
  csrf_token_expires: CSRF_LOGIN.csrf_token_expires,
});

/** The login values of {@link POSTED} identity receives, with the session site the set-up put in rc. */
const SENT = Object.freeze({
  username: POSTED.username,
  password: POSTED.password,
  rememberMe: POSTED.rememberMe,
  returnUrl: POSTED.returnUrl,
  isAdminLogin: POSTED.isAdminLogin,
  compactDisplay: POSTED.compactDisplay,
  csrf_token: POSTED.csrf_token,
  csrf_token_expires: POSTED.csrf_token_expires,
  siteid: 'default',
});

const ANONYMOUS_SESSION = {
  sessionId: 'S0000000-0000-0000-0000000000000001',
  epoch: 0,
  user: { isLoggedIn: false, userID: '' },
  roles: [],
  mfaPending: false,
  blockLoginUntil: null,
};

const outcome = (body: LoginOutcome, setCookies: readonly string[] = []): FakeReply => ({
  status: 200,
  body,
  setCookies,
});

const UNATTEMPTED = outcome({ outcome: 'unattempted', location: '', epoch: 0 });
const LOGGED_IN = outcome({ outcome: 'success', location: './', epoch: 1 });

/** A gateway whose identity answers the login with `login` and serves the anonymous session and `login` tokens. */
function identityGateway(login: FakeReply): FakeGatewayClient {
  return fakeGatewayClient({
    [LOGIN_ROUTE]: login,
    [routeKey('GET', 'identity', '/v1/sessions/current')]: { status: 200, body: ANONYMOUS_SESSION },
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: { status: 200, body: { tokens: [CSRF_LOGIN] } },
  });
}

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext & { gateway: FakeGatewayClient } {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date(2026, 5, 30, 12, 0, 0),
  };
}

const loginRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  anonymousRequest({ circuit: 'clogin', item: 'login', ...partial });

/** The controller step's answer for `req` while identity answers `login`, with the gateway it called. */
async function step(req: AdminRequest, login: FakeReply): Promise<{
  result: PageControllerRedirect | undefined;
  gateway: FakeGatewayClient;
}> {
  const gateway = identityGateway(login);
  const result = await cloginLoginScreen.redirect?.(contextFor(req, gateway));
  return { result, gateway };
}

const loginCalls = (gateway: FakeGatewayClient) =>
  gateway.calls.filter((call) => call.service === 'identity' && call.path === '/v1/sessions/login');

/** `screen`'s load and render for `ctx`, as page mode runs them after the controller step. */
async function viewMarkup(screen: PageScreen<LoginViewState>, ctx: ScreenContext): Promise<string> {
  const state = await screen.load?.(ctx);
  if (state === undefined) throw new TypeError(`${screen.action} has no load`);
  return toString((await screen.render(ctx, state)).body);
}

describe('clogin.login', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('is the identity-owned page action of clogin.login, ungated, in its inventoried response mode', () => {
    const inventory = JSON.parse(
      readFileSync(new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
    ) as { controllers: Array<{ actions: Array<{ id: string; variants: Array<{ responseMode: string }> }> }> };
    const action = inventory.controllers.flatMap((c) => c.actions).find((a) => a.id === 'ctl:clogin.login');

    expect(cloginLoginScreen).toMatchObject({ circuit: 'clogin', action: 'login', owner: 'identity' });
    expect(cloginLoginScreen.mode).toBe(action?.variants[0]?.responseMode);
    expect(cloginLoginScreen.gate).toBeUndefined();
    expect(Object.isFrozen(cloginLoginScreen)).toBe(true);
  });

  it.each<[string, LoginOutcome['outcome'], string]>([
    ['a login', 'success', './'],
    ['a login with a return URL', 'success', 'http://localhost/admin/?muraAction=cUsers.list'],
    ['a failed login', 'failed', FAILED_LOCATION],
    ['a login while the strike block holds', 'blocked', FAILED_LOCATION],
    ['an MFA challenge', 'challenge', CHALLENGE_LOCATION],
  ])('passes the location of %s through unchanged with identity cookies', async (_case, kind, location) => {
    const reply = outcome({ outcome: kind, location, epoch: 1 }, REMEMBER_ME_COOKIES);
    const { result } = await step(loginRequest({ rc: POSTED }), reply);

    expect(result).toEqual({ kind: 'location', location, setCookies: [...REMEMBER_ME_COOKIES] });
  });

  it('answers a rejected token with the FW/1 redirect to clogin.main', async () => {
    const reply = outcome({ outcome: 'csrf-invalid', location: './?muraAction=clogin.main', epoch: 0 });
    const { result } = await step(loginRequest({ rc: POSTED }), reply);

    expect(result).toEqual({ kind: 'redirect', action: 'clogin.main', path: './', setCookies: [] });
    if (result?.kind !== 'redirect') throw new TypeError('expected an FW/1 redirect');
    expect(fw1RedirectTarget({ action: result.action, path: result.path })).toBe('./?muraAction=clogin.main');
  });

  it('posts every login value once and unchanged, the session site included and nothing else', async () => {
    const { gateway } = await step(loginRequest({ rc: POSTED }), LOGGED_IN);

    expect(loginCalls(gateway)).toEqual([expect.objectContaining({ method: 'POST', form: SENT })]);
    expect(loginCalls(gateway)[0]?.json).toBeUndefined();
  });

  it.each([
    ['the challenge form', { status: 'challenge', attemptChallenge: 'true', isadminlogin: 'true', authcode: '123456' }],
    ['a remembered device', { attemptChallenge: 'yes', rememberdevice: '1', failedchallenge: 'false', linkServID: 'L1' }],
  ])('posts the fields of %s under their posted names', async (_case, fields) => {
    const rc = { ...fields, contentid: 'C2', ...CSRF_PAIR };
    const { gateway } = await step(loginRequest({ rc }), LOGGED_IN);

    expect(loginCalls(gateway)[0]?.form).toEqual({ ...rc, compactDisplay: 'false', siteid: 'default' });
  });

  it.each([
    ['in the URL only', {}, {}],
    ['with only the username posted', { username: 'admin' }, { username: 'admin' }],
    ['in another case', { USERNAME: 'admin', Password: 'x' }, { username: 'admin', password: 'x' }],
  ])('sends the credentials only as posted when they arrive %s', async (_case, formScope, sent) => {
    const rc = { username: 'admin', password: 'x', ...CSRF_PAIR };
    const { gateway } = await step(loginRequest({ rc, formScope }), UNATTEMPTED);

    expect(loginCalls(gateway)[0]?.form).toEqual({ ...sent, ...CSRF_PAIR, compactDisplay: 'false', siteid: 'default' });
  });

  it.each<[string, () => AdminRequest]>([
    ['an anonymous session', () => loginRequest({ rc: { csrf_token: POSTED.csrf_token } })],
    ['a private-pool session clogin.main redirects', () => adminS2Request({ circuit: 'clogin', item: 'login' })],
  ])('renders login.cfm as the clogin.main view when no login ran, for %s', async (_case, request) => {
    const req = request();
    const ctx = contextFor(req, identityGateway(UNATTEMPTED));
    const main = contextFor(req, identityGateway(UNATTEMPTED));

    expect(await cloginLoginScreen.redirect?.(ctx)).toBeUndefined();
    const markup = await viewMarkup(cloginLoginScreen, ctx);

    expect(markup).toBe(await viewMarkup(cloginMainScreen, main));
    expect(normaliseIds(fragmentModel(markup)).controls.map((control) => control.name)).toContain('username');
  });

  it('shows the incorrect authorization code alert for a posted failedchallenge', async () => {
    const ctx = contextFor(loginRequest({ rc: { failedchallenge: 'true' } }), identityGateway(UNATTEMPTED));

    expect(await cloginLoginScreen.redirect?.(ctx)).toBeUndefined();
    expect(fragmentModel(await viewMarkup(cloginLoginScreen, ctx)).alerts).toEqual([
      { text: rbFor('en_US').rbKey('login.incorrectauthorizationcode'), className: 'alert alert-error' },
    ]);
  });

  it.each<[string, FakeReply, unknown]>([
    ['a 401 as a denial', { status: 401 }, GatewayDenialError],
    ['a 500 as an error', { status: 500, body: 'Element MFA.USERNAME is undefined in SESSIONDATA.' }, Error],
  ])('raises identity %s', async (_case, reply, type) => {
    await expect(step(loginRequest({ rc: POSTED }), reply)).rejects.toBeInstanceOf(type);
  });

  it('propagates identity unavailability without a retry', async () => {
    const gateway = identityGateway(LOGGED_IN);
    gateway.failWith();
    const ctx = contextFor(loginRequest({ rc: POSTED }), gateway);

    await expect(cloginLoginScreen.redirect?.(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(loginCalls(gateway)).toHaveLength(1);
  });

  it.each([
    ['posted with the page-mode query', '/admin/index.cfm', SENT],
    ['carried in the browser URL', '/admin/index.cfm?username=admin', { ...SENT, username: undefined }],
  ])('takes the credentials from the form scope when they are %s', async (_case, target, sent) => {
    const gateway = identityGateway(LOGGED_IN);
    const req = await buildTestAdminRequest({
      circuit: 'clogin',
      action: 'login',
      query: POSTED,
      headers: { [ORIGINAL_URL_HEADER]: target },
      gateway,
      mode: 'page',
    });

    await cloginLoginScreen.redirect?.(contextFor(req, gateway));

    // toEqual treats an undefined member as absent.
    expect(loginCalls(gateway)[0]?.form).toEqual({ ...sent, siteid: req.rc.siteid });
  });
});
