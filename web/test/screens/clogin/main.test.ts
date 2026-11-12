// Tests of the `clogin.main` login page: oracle DOM parity, every view branch, the send-login call and the redirect.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  MASA_LOGIN_CONFIG,
  cloginMainScreen,
  loadLoginViewState,
  renderLoginView,
  type LoginConfig,
} from '@/screens/clogin/main';
import type { ScreenContext } from '@/screens/registry';
import { CSRF_LOGIN } from '../../fixtures/identity/csrf';
import { adminS2Request, anonymousRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomControl } from '../../helpers/dom-model';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

type CurrentSession = components['schemas']['CurrentSession'];

// `#mura-login` through the view's closing `</script>`, captured from the legacy ACF 2023 server for an anonymous
// session; CSRF token values are `<token>`.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/identity/clogin-main-${name}.html`, import.meta.url), 'utf8');

const NOW = new Date(2026, 5, 30, 12, 0, 0);
const LOGIN_MAIL_PATH = '/v1/login-mail';
const ANONYMOUS_SESSION: CurrentSession = {
  sessionId: 'S0000000-0000-0000-0000000000000001',
  epoch: 0,
  user: { isLoggedIn: false, userID: '' },
  roles: [],
  mfaPending: false,
  blockLoginUntil: null,
};

interface Rendered {
  readonly markup: string;
  readonly gateway: FakeGatewayClient;
}

/** A screen context over `req` whose identity serves `session`, the `login` CSRF pair and the login mail. */
function contextFor(req: AdminRequest, session: Partial<CurrentSession> = {}): ScreenContext {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'identity', '/v1/sessions/current')]: { status: 200, body: { ...ANONYMOUS_SESSION, ...session } },
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: { status: 200, body: { tokens: [CSRF_LOGIN] } },
    [routeKey('POST', 'identity', LOGIN_MAIL_PATH)]: { status: 200, body: { status: 'messagesent' } },
  });
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: NOW,
  };
}

/** The screen's load and render for an anonymous request with `partial`, in a session `session` describes. */
async function render(
  partial: AdminRequestPartial = {},
  session: Partial<CurrentSession> = {},
  config: LoginConfig = MASA_LOGIN_CONFIG,
): Promise<Rendered> {
  const ctx = contextFor(anonymousRequest(partial), session);
  const state = await loadLoginViewState(ctx, config);
  return { markup: toString(renderLoginView(ctx, state)), gateway: ctx.gateway as FakeGatewayClient };
}

const masked = (markup: string): string =>
  markup.replaceAll(CSRF_LOGIN.csrf_token, '<token>').replaceAll(CSRF_LOGIN.csrf_token_expires, '<token>');
const squash = (markup: string): string => markup.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
const count = (markup: string, text: string): number => markup.split(text).length - 1;
const has = (markup: string, selector: string): boolean => cheerio.load(markup, null, false)(selector).length > 0;
const hidden = (name: string, value: string): Pick<DomControl, 'name' | 'type' | 'value'> => ({ name, type: 'hidden', value });
const controlsOf = (markup: string): Array<Pick<DomControl, 'name' | 'type' | 'value'>> =>
  fragmentModel(markup).controls.map(({ name, type, value }) => ({ name, type, value }));
const mailCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.path === LOGIN_MAIL_PATH);

describe('clogin.main view against the legacy oracle', () => {
  it.each([
    ['default', {}],
    ['default', { status: 'challenge' }],
    ['failed', { status: 'failed' }],
    ['denied', { status: 'DENIED' }],
    ['failedchallenge', { failedchallenge: 'true' }],
    ['compact', { compactDisplay: 'true' }],
    ['sendlogin', { status: 'sendlogin', email: 'nobody-c3@example.invalid' }],
  ])('renders the %s capture for rc %j', async (name, rc) => {
    const { markup } = await render({ rc });

    expect(normaliseIds(fragmentModel(markup))).toEqual(normaliseIds(fragmentModel(fixture(name))));
    expect(squash(masked(markup))).toBe(squash(fixture(name)));
  });

  it('reads labels in the session locale, selects the rb cookie and encodes the hidden values', async () => {
    const { markup } = await render({
      rc: { returnURL: '"><x>', compactDisplay: 'a"b' },
      session: { rb: 'de' },
      cookies: new Map([['rb', 'de']]),
    });

    expect(squash(masked(markup))).toBe(squash(fixture('encoded-de')));
  });
});

describe('clogin.main view branches', () => {
  it('prefers a posted rb over the cookie when selecting the language', async () => {
    const { markup } = await render({ rc: { rb: 'fr' }, cookies: new Map([['rb', 'de']]) });
    const select = fragmentModel(markup).controls.find((control) => control.name === 'rb');

    expect(select?.selected).toEqual(['fr']);
  });

  it('blocks the forms while the strike block holds', async () => {
    const { markup, gateway } = await render(
      { rc: { status: 'sendlogin', email: 'admin@example.com' } },
      { blockLoginUntil: '2026-06-30T12:05:00.000' },
    );
    const model = fragmentModel(markup);

    expect(model.alerts).toEqual([{ text: rbFor('en_US').rbKey('login.blocked'), className: 'alert alert-error' }]);
    expect(model.controls).toEqual([]);
    expect(markup).toContain('<!-- mura-primary-login-token -->');
    expect(has(markup, '#mura-password-panel')).toBe(false);
    expect(count(markup, 'csrf_token')).toBe(0);
    expect(mailCalls(gateway)).toEqual([]);
    expect(count(markup, '<div')).toBe(count(markup, '</div>'));
  });

  it('treats an expired strike block as no block', async () => {
    const { markup } = await render({}, { blockLoginUntil: '2026-06-30T11:55:00.000' });

    expect(squash(masked(markup))).toBe(squash(fixture('default')));
  });

  it('requests the login mail once with the posted email and the admin site id', async () => {
    const { markup, gateway } = await render({ rc: { status: 'sendLogin', email: 'admin@example.com' } });

    expect(mailCalls(gateway)).toEqual([
      expect.objectContaining({ method: 'POST', json: { email: 'admin@example.com', siteid: '' } }),
    ]);
    expect(markup).toContain('<p id="pw-response" class="alert alert-error clear-both">');
  });

  it('fails as legacy does when the mail is due without an email', async () => {
    const ctx = contextFor(anonymousRequest({ rc: { status: 'sendLogin' } }));

    await expect(loadLoginViewState(ctx)).rejects.toThrow(new TypeError('Element EMAIL is undefined in RC.'));
    expect(mailCalls(ctx.gateway as FakeGatewayClient)).toEqual([]);
  });

  it('offers no password help and sends no mail when admin login help is off', async () => {
    const { markup, gateway } = await render(
      { rc: { status: 'sendLogin', email: 'admin@example.com' } },
      {},
      { ...MASA_LOGIN_CONFIG, showAdminLoginHelp: false },
    );

    expect(mailCalls(gateway)).toEqual([]);
    expect(has(markup, '#pw-link')).toBe(false);
    expect(has(markup, '#sendLogin')).toBe(false);
    expect(markup).toContain('id="mura-password-panel" >');
    expect(count(markup, '<div')).toBe(count(markup, '</div>'));
  });

  it.each([
    { authcode: '', mfaPerDevice: false, alerts: [] as string[] },
    { authcode: '123456', mfaPerDevice: false, alerts: ['login.authcodeerror'] },
    { authcode: '', mfaPerDevice: true, alerts: ['login.newdevice'] },
    { authcode: '123456', mfaPerDevice: true, alerts: ['login.authcodeerror'] },
  ])('renders the challenge form for authcode "$authcode" and mfaPerDevice $mfaPerDevice', async (c) => {
    const { markup, gateway } = await render(
      { rc: { status: 'challenge', authcode: c.authcode } },
      { mfaPending: true },
      { ...MASA_LOGIN_CONFIG, mfaPerDevice: c.mfaPerDevice },
    );
    const rb = rbFor('en_US');
    const model = fragmentModel(markup);

    expect(model.alerts.map((alert) => alert.text)).toEqual(c.alerts.map((key) => rb.rbKey(key)));
    expect(model.labels).toEqual([rb.rbKey('login.enteremailedauthcode')]);
    expect(model.buttons).toEqual([{ text: rb.rbKey('login.submit'), type: 'submit', hasOnclick: false }]);
    expect(controlsOf(markup)).toEqual([
      { name: 'authcode', type: 'text', value: '' },
      ...(c.mfaPerDevice ? [{ name: 'rememberdevice', type: 'hidden', value: '1' }] : []),
      { name: 'muraAction', type: 'hidden', value: 'cLogin.login' },
      { name: 'status', type: 'hidden', value: 'challenge' },
      { name: 'attemptChallenge', type: 'hidden', value: 'true' },
      { name: 'isadminlogin', type: 'hidden', value: 'true' },
      { name: 'csrf_token', type: 'hidden', value: CSRF_LOGIN.csrf_token },
      { name: 'csrf_token_expires', type: 'hidden', value: CSRF_LOGIN.csrf_token_expires },
    ]);
    expect(markup).toContain('placeholder="Authorization&#x20;Code"');
    expect(has(markup, '#mura-password-panel')).toBe(false);
    expect(mailCalls(gateway)).toEqual([]);
    expect(count(markup, '<div')).toBe(count(markup, '</div>'));
  });

  it('shows the language select without remember-me when MFA is on', async () => {
    const { markup } = await render({}, {}, { ...MASA_LOGIN_CONFIG, mfa: true });
    const names = controlsOf(markup).map((control) => control.name);

    expect(names).not.toContain('rememberMe');
    expect(names).toContain('rb');
    expect(has(markup, '#remember-me')).toBe(false);
  });

  it('renders the enabled OAuth providers in legacy order above the credentials', async () => {
    const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c1&state=u1';
    const azure = 'https://login.microsoftonline.com/t1/oauth2/v2.0/authorize?client_id=c2&state=u1';
    const { markup } = await render({}, {}, { ...MASA_LOGIN_CONFIG, oauth: { azuread: azure, google } });
    const rb = rbFor('en_US');
    const model = fragmentModel(markup);

    expect(model.links.slice(0, 2)).toEqual([
      { href: google, text: rb.rbKey('login.loginwithgoogle') },
      { href: azure, text: rb.rbKey('login.loginwithazuread') },
    ]);
    expect(model.headings[0]).toBe(rb.rbKey('login.loginwithcredentials'));
    expect(markup).toContain(`class="mura-login-auth-btn az"`);
    expect(markup.indexOf('mura-login-auth-wrapper')).toBeLessThan(markup.indexOf('id="username"'));
    expect(markup).toContain('<div class="text-divider"><span>or</span></div>');
  });

  it('renders the credentials form with every hidden field once and the frame sizing only when compact', async () => {
    const plain = await render();
    const compact = await render({ rc: { compactDisplay: 'TRUE' } });

    expect(controlsOf(plain.markup)).toEqual(
      expect.arrayContaining([
        hidden('returnUrl', ''),
        hidden('muraAction', 'cLogin.login'),
        hidden('isAdminLogin', 'true'),
        hidden('compactDisplay', 'false'),
        hidden('status', 'sendlogin'),
        hidden('returnURL', ''),
      ]),
    );
    expect(count(plain.markup, 'name="csrf_token"')).toBe(1);
    expect(plain.markup).not.toContain('setWidth');
    expect(compact.markup).toContain("frontEndProxy.post({cmd:'setWidth',width:400});");
    expect(plain.markup).not.toContain('_missing');
  });

  it('propagates identity unavailability', async () => {
    const ctx = contextFor(anonymousRequest());
    (ctx.gateway as FakeGatewayClient).failWith();

    await expect(loadLoginViewState(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('cloginMainScreen', () => {
  const inventoryMode = (): unknown => {
    const inventory = JSON.parse(
      readFileSync(new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
    ) as { controllers: Array<{ actions: Array<{ id: string; variants: Array<{ responseMode: string }> }> }> };
    const action = inventory.controllers.flatMap((c) => c.actions).find((a) => a.id === 'ctl:clogin.main');
    return action?.variants[0]?.responseMode;
  };

  it('is the identity-owned page of clogin.main, in its inventoried response mode', () => {
    expect(cloginMainScreen).toMatchObject({ circuit: 'clogin', action: 'main', owner: 'identity' });
    expect(cloginMainScreen.mode).toBe(inventoryMode());
  });

  it('sends a private-pool session on to home.redirect as main() does, and lets others through', async () => {
    const helpers = { secure: () => ({ kind: 'allow' }) as const };
    const { gate } = cloginMainScreen;
    if (gate === undefined) throw new TypeError('cloginMainScreen has no gate');

    expect(await gate(adminS2Request(), helpers)).toEqual({ kind: 'redirect', location: './' });
    expect(await gate(anonymousRequest(), helpers)).toEqual({ kind: 'allow' });
  });

  it('loads the state and renders it as the shell view body', async () => {
    const ctx = contextFor(anonymousRequest());
    const state = await cloginMainScreen.load?.(ctx);
    if (state === undefined) throw new TypeError('cloginMainScreen has no load');
    const view = await cloginMainScreen.render(ctx, state);

    expect(squash(masked(toString(view.body)))).toBe(squash(fixture('default')));
  });
});
