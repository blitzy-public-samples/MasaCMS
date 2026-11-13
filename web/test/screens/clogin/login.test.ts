// clogin.login against legacy clogin.cfc login(): identity logs in and answers the redirect, or login.cfm renders.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { fw1RedirectTarget } from '@/lib/urls';
import { cloginLoginScreen } from '@/screens/clogin/login';
import { cloginMainScreen, renderLoginView, type LoginViewState } from '@/screens/clogin/main';
import type { PageControllerRedirect, PageScreen, ScreenContext } from '@/screens/registry';
import { CSRF_LOGIN } from '../../fixtures/identity/csrf';
import {
  SESSION_SET_COOKIES,
  loginCsrfFailureRedirect,
  loginFailureRedirect,
  loginPageFailed,
  loginSessionAnonymous,
  loginSuccessDefault,
  loginSuccessRedirect,
} from '../../fixtures/identity/session-login';
import { USER_IDS } from '../../fixtures/session';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { fragmentModel, normaliseIds } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeCall,
  type FakeGatewayClient,
  type FakeReply,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type LoginOutcome = components['schemas']['LoginOutcome'];

const LOGIN_PATH = '/v1/sessions/login';
const LOGIN_ROUTE = routeKey('POST', 'identity', LOGIN_PATH);
const FAILED_PREFIX = './?muraAction=cLogin.main&display=login&status=failed';
const CHALLENGE_LOCATION =
  './?muraAction=cLogin.main&display=login&status=challenge&failedchallenge=false&rememberMe=0&contentid=' +
  '&LinkServID=&returnURL=&compactDisplay=false';
const REMEMBER_ME_COOKIES = [
  'userid=5A000000-0000-0000-0000000000000001;expires=Sat, 30-Jun-2046 12:00:00 GMT;path=/;HttpOnly;',
  'userHash=ABCDEF;expires=Sat, 30-Jun-2046 12:00:00 GMT;path=/;HttpOnly;',
] as const;

const CSRF_PAIR = Object.freeze({
  csrf_token: CSRF_LOGIN.csrf_token,
  csrf_token_expires: CSRF_LOGIN.csrf_token_expires,
});

/** The admin login form as main.cfm posts it, with the `login` token pair. */
const POSTED = Object.freeze({
  username: 'admin',
  password: 'placeholder-p@ss,word',
  rememberMe: '1',
  rb: 'en_US',
  returnUrl: '/admin/?muraAction=cUsers.list',
  muraAction: 'cLogin.login',
  isAdminLogin: 'true',
  compactDisplay: 'false',
  ...CSRF_PAIR,
});

/** Posted names that read like identity; the login body never carries them. */
const FORGED = Object.freeze({
  userid: USER_IDS.admin,
  roles: 's2,site-admin',
  s2: '1',
  isS2: 'true',
  tid: 'tenant-a',
  tenantId: 'tenant-a',
});

/** What identity receives of {@link POSTED}, plus the session site in rc; `rb` and `muraAction` are no login values. */
const SENT = Object.freeze({
  username: POSTED.username,
  password: POSTED.password,
  rememberMe: POSTED.rememberMe,
  returnUrl: POSTED.returnUrl,
  isAdminLogin: POSTED.isAdminLogin,
  compactDisplay: POSTED.compactDisplay,
  ...CSRF_PAIR,
  siteid: 'default',
});

const outcome = (body: LoginOutcome, setCookies: readonly string[] = []): FakeReply => ({
  status: 200,
  body,
  setCookies,
});

const UNATTEMPTED = outcome({ outcome: 'unattempted', location: '', epoch: 0 });

/** A gateway whose identity answers the login with `login` and serves the anonymous session and `login` tokens. */
function identityGateway(login: FakeReply): FakeGatewayClient {
  return fakeGatewayClient({
    [LOGIN_ROUTE]: login,
    [routeKey('GET', 'identity', '/v1/sessions/current')]: loginSessionAnonymous,
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: { status: 200, body: { tokens: [CSRF_LOGIN] } },
  });
}

const loginRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  anonymousRequest({ circuit: 'clogin', item: 'login', ...partial });

const loginContext = (req: AdminRequest, login: FakeReply): ScreenContext & { gateway: FakeGatewayClient } =>
  makeScreenContext({ req, gateway: identityGateway(login) });

/** The controller step's answer to `form` posted anonymously while identity answers `answer`. */
async function submit(
  answer: FakeReply,
  form: Readonly<Record<string, string>>,
  partial: AdminRequestPartial = {},
): Promise<{
  result: PageControllerRedirect | undefined;
  calls: readonly FakeCall[];
  ctx: ScreenContext & { gateway: FakeGatewayClient };
}> {
  const ctx = loginContext(loginRequest({ rc: form, ...partial }), answer);
  const result = await cloginLoginScreen.redirect?.(ctx);
  return { result, calls: ctx.gateway.calls, ctx };
}

const loginCalls = (calls: readonly FakeCall[]): FakeCall[] =>
  calls.filter((call) => call.service === 'identity' && call.path === LOGIN_PATH);

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

  it('answers a login with its return URL and the session cookies', async () => {
    const { result } = await submit(loginSuccessRedirect, POSTED);

    expect(result).toEqual({
      kind: 'location',
      location: loginSuccessRedirect.body.location,
      setCookies: [...SESSION_SET_COOKIES],
    });
  });

  it('answers a login without a return URL with ./ and the session cookies', async () => {
    const { result } = await submit(loginSuccessDefault, { ...POSTED, returnUrl: '' });

    expect(result).toEqual({ kind: 'location', location: './', setCookies: [...SESSION_SET_COOKIES] });
  });

  it('passes a failed login redirect through unchanged without cookies', async () => {
    const { result } = await submit(loginFailureRedirect, POSTED);

    expect(result).toEqual({ kind: 'location', location: loginFailureRedirect.body.location, setCookies: [] });
    if (result?.kind !== 'location') throw new TypeError('expected a location');
    expect(result.location.startsWith(FAILED_PREFIX)).toBe(true);
  });

  it.each<[string, LoginOutcome['outcome'], string]>([
    ['a login while the strike block holds', 'blocked', loginFailureRedirect.body.location],
    ['an MFA challenge', 'challenge', CHALLENGE_LOCATION],
  ])('passes the location of %s through unchanged with identity cookies', async (_case, kind, location) => {
    const { result } = await submit(outcome({ outcome: kind, location, epoch: 1 }, REMEMBER_ME_COOKIES), POSTED);

    expect(result).toEqual({ kind: 'location', location, setCookies: [...REMEMBER_ME_COOKIES] });
  });

  it('answers a rejected token with the FW/1 redirect to clogin.main', async () => {
    const { result } = await submit(loginCsrfFailureRedirect, POSTED);

    expect(result).toEqual({ kind: 'redirect', action: 'clogin.main', path: './', setCookies: [] });
    if (result?.kind !== 'redirect') throw new TypeError('expected an FW/1 redirect');
    const target = fw1RedirectTarget({ action: result.action, path: result.path });
    expect(target).toBe(loginCsrfFailureRedirect.body.location);
  });

  it('posts every login value once and unchanged, the session site included and nothing else', async () => {
    const { calls } = await submit(loginSuccessDefault, { ...POSTED, ...FORGED });

    expect(calls).toEqual([
      expect.objectContaining({ service: 'identity', method: 'POST', path: LOGIN_PATH, form: SENT }),
    ]);
    expect(calls[0]?.form).toMatchObject(CSRF_PAIR);
    expect(calls[0]?.json).toBeUndefined();
  });

  it.each([
    ['the challenge form', { status: 'challenge', attemptChallenge: 'true', isadminlogin: 'true', authcode: '123456' }],
    ['a remembered device', { attemptChallenge: 'yes', rememberdevice: '1', failedchallenge: 'false', linkServID: 'L1' }],
  ])('posts the fields of %s under their posted names', async (_case, fields) => {
    const rc = { ...fields, contentid: 'C2', ...CSRF_PAIR };
    const { calls } = await submit(loginSuccessDefault, rc);

    expect(loginCalls(calls)[0]?.form).toEqual({ ...rc, compactDisplay: 'false', siteid: 'default' });
  });

  it.each([
    ['in the URL only', {}, {}],
    ['with only the username posted', { username: 'admin' }, { username: 'admin' }],
    ['in another case', { USERNAME: 'admin', Password: 'x' }, { username: 'admin', password: 'x' }],
  ])('sends the credentials only as posted when they arrive %s', async (_case, formScope, sent) => {
    const rc = { username: 'admin', password: 'x', ...CSRF_PAIR };
    const { calls } = await submit(UNATTEMPTED, rc, { formScope });

    expect(loginCalls(calls)[0]?.form).toEqual({ ...sent, ...CSRF_PAIR, compactDisplay: 'false', siteid: 'default' });
  });

  it('re-renders login.cfm with the failed alert when no login ran', async () => {
    const { result, ctx } = await submit(UNATTEMPTED, { status: 'failed', ...CSRF_PAIR });
    expect(result).toBeUndefined();

    const state = await cloginLoginScreen.load?.(ctx);
    expect(state).toEqual(loginPageFailed);
    const markup = toString((await cloginLoginScreen.render(ctx, loginPageFailed)).body);
    const model = fragmentModel(markup);
    const $ = cheerio.load(markup, null, false);
    const loginForm = fragmentModel($.html($('#loginForm')));

    expect(model).toEqual(fragmentModel(toString(renderLoginView(ctx, loginPageFailed))));
    expect(model.alerts).toEqual([{ text: ctx.rb.rbKey('login.failed'), className: 'alert alert-error' }]);
    expect(loginForm.controls.map(({ name, type, value }) => ({ name, type, value }))).toEqual(
      expect.arrayContaining([
        { name: 'username', type: 'text', value: '' },
        { name: 'password', type: 'password', value: '' },
        { name: 'csrf_token', type: 'hidden', value: CSRF_LOGIN.csrf_token },
        { name: 'csrf_token_expires', type: 'hidden', value: CSRF_LOGIN.csrf_token_expires },
      ]),
    );
  });

  // template.cfm:312 leaves out #mura-content only for core:cLogin.main.
  it.each([
    ['login', 1],
    ['main', 0],
  ])('renders clogin.%s in the shell with %i #mura-content wrapper', async (item, wrappers) => {
    const req = loginRequest({ item, rc: { status: 'failed', ...CSRF_PAIR } });
    const screen = item === 'login' ? cloginLoginScreen : cloginMainScreen;
    const page = await renderScreenPage(screen, loginContext(req, UNATTEMPTED));
    if (page.kind !== 'document') throw new TypeError(`expected a document, got a redirect to ${page.location}`);
    const $ = cheerio.load(page.html);

    expect($('#mura-content')).toHaveLength(wrappers);
    expect($('#loginForm')).toHaveLength(1);
  });

  it.each<[string, () => AdminRequest]>([
    ['an anonymous session', () => loginRequest({ rc: { csrf_token: POSTED.csrf_token } })],
    ['a private-pool session clogin.main redirects', () => adminS2Request({ circuit: 'clogin', item: 'login' })],
  ])('renders login.cfm as the clogin.main view when no login ran, for %s', async (_case, request) => {
    const req = request();
    const ctx = loginContext(req, UNATTEMPTED);
    const main = loginContext(req, UNATTEMPTED);

    expect(await cloginLoginScreen.redirect?.(ctx)).toBeUndefined();
    const markup = await viewMarkup(cloginLoginScreen, ctx);

    expect(markup).toBe(await viewMarkup(cloginMainScreen, main));
    expect(normaliseIds(fragmentModel(markup)).controls.map((control) => control.name)).toContain('username');
  });

  it('shows the incorrect authorization code alert for a posted failedchallenge', async () => {
    const ctx = loginContext(loginRequest({ rc: { failedchallenge: 'true' } }), UNATTEMPTED);

    expect(await cloginLoginScreen.redirect?.(ctx)).toBeUndefined();
    expect(fragmentModel(await viewMarkup(cloginLoginScreen, ctx)).alerts).toEqual([
      { text: rbFor('en_US').rbKey('login.incorrectauthorizationcode'), className: 'alert alert-error' },
    ]);
  });

  it.each<[string, FakeReply, unknown]>([
    ['a 401 as a denial', { status: 401 }, GatewayDenialError],
    ['a 500 as an error', { status: 500, body: 'Element MFA.USERNAME is undefined in SESSIONDATA.' }, Error],
  ])('raises identity %s', async (_case, reply, type) => {
    await expect(submit(reply, POSTED)).rejects.toBeInstanceOf(type);
  });

  it('propagates identity unavailability without a retry', async () => {
    const ctx = loginContext(loginRequest({ rc: POSTED }), loginSuccessDefault);
    ctx.gateway.failWith();

    await expect(cloginLoginScreen.redirect?.(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(loginCalls(ctx.gateway.calls)).toHaveLength(1);
  });

  it.each([
    ['posted with the page-mode query', '/admin/index.cfm', SENT],
    ['carried in the browser URL', '/admin/index.cfm?username=admin', { ...SENT, username: undefined }],
  ])('takes the credentials from the form scope when they are %s', async (_case, target, sent) => {
    const gateway = identityGateway(loginSuccessDefault);
    const req = await buildTestAdminRequest({
      circuit: 'clogin',
      action: 'login',
      query: POSTED,
      headers: { [ORIGINAL_URL_HEADER]: target },
      gateway,
      mode: 'page',
    });

    await cloginLoginScreen.redirect?.(makeScreenContext({ req, gateway }));

    // toEqual treats an undefined member as absent.
    expect(loginCalls(gateway.calls)[0]?.form).toEqual({ ...sent, siteid: req.rc.siteid });
  });
});
