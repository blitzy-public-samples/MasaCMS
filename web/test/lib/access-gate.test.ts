// The admin access gate against legacy: Application.cfc 443-452, controller.cfc secure() and FW/1 redirect().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_LOGIN_REDIRECT_ACTION, ADMIN_NOACCESS_ACTION, esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { applicationGate, runGate, secure, type GateDecision, type ScreenGate } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { noSitesSession, s2PrivateMemberSession } from '../fixtures/session';
import {
  adminS2Request,
  anonymousRequest,
  buildTestAdminRequest,
  editorRequest,
  makeAdminRequest,
  noSitesRequest,
  type AdminRequestPartial,
} from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';

const ALLOW: GateDecision = { kind: 'allow' };
const redirect = (location: string): GateDecision => ({ kind: 'redirect', location });

const LOGOUT = '/admin/?muraAction=clogin.logout';
const NOACCESS = '/admin/?muraAction=cMessage.noaccess';

const EXAMPLE_DOMAINS = { allowedDomains: ['example.test'], siteDomain: 'example.test' } as const;
const REFERER = 'http://example.test/admin/?muraAction=cusers.list';

/** FW/1 `redirect(action='cLogin.main', append='returnURL,compactDisplay', path='./')` for these rc values. */
function loginRedirect(returnUrl: string, compactDisplay?: string): GateDecision {
  const tail = compactDisplay === undefined ? '' : `&compactDisplay=${esapiUrlEncode(compactDisplay)}`;
  return redirect(`./?muraAction=cLogin.main&returnURL=${esapiUrlEncode(returnUrl)}${tail}`);
}

/** An anonymous `cusers.list` request from `example.test`, whose registry domains include that host. */
const anonymousListRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  anonymousRequest({
    circuit: 'cusers',
    item: 'list',
    currentUrl: './?&muraAction=cusers.list',
    serverName: 'example.test',
    httpHost: 'example.test',
    hrefDomains: EXAMPLE_DOMAINS,
    ...partial,
  });

let restoreEnv: () => void;

/** Lays `vars` over `process.env` and reinstalls the test environment, so legacy settings are re-read. */
function withSettings(vars: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  restoreEnv();
  restoreEnv = useTestEnv();
}

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

describe('applicationGate (Application.cfc 443-452)', () => {
  it('sends a site-less user without S2IsPrivate to clogin.logout', () => {
    const decision = applicationGate(noSitesRequest({ s2IsPrivate: false }, { circuit: 'cusers', item: 'list' }));

    expect(decision).toEqual(redirect(LOGOUT));
    const location = decision.kind === 'redirect' ? decision.location : '';
    expect(new URLSearchParams(location.split('?')[1]).get('muraAction')).toBe(ADMIN_LOGIN_REDIRECT_ACTION);
  });

  it('sends a site-less S2IsPrivate user to cMessage.noaccess', () => {
    const decision = applicationGate(noSitesRequest({ s2IsPrivate: true }, { circuit: 'cusers', item: 'list' }));

    expect(decision).toEqual(redirect(NOACCESS));
    const location = decision.kind === 'redirect' ? decision.location : '';
    expect(new URLSearchParams(location.split('?')[1]).get('muraAction')).toBe(ADMIN_NOACCESS_ACTION);
  });

  it.each<[boolean, string, GateDecision]>([
    [false, 'core:cmessage.noaccess', redirect(LOGOUT)],
    [false, 'core:ceditprofile.edit', redirect(LOGOUT)],
    [false, 'core:csettings.list', redirect(LOGOUT)],
    [false, '', redirect(LOGOUT)],
    [false, 'core:clogin.main', ALLOW],
    [false, 'core:CLogin.main', ALLOW],
    [false, 'clogin.login', ALLOW],
    [true, 'core:cusers.list', redirect(NOACCESS)],
    [true, 'core:home.redirect', redirect(NOACCESS)],
    [true, '', redirect(NOACCESS)],
    [true, 'core:cmessage.noaccess', ALLOW],
    [true, 'core:cMessage.noaccess', ALLOW],
    [true, 'core:ceditprofile.edit', ALLOW],
    [true, 'core:cEditProfile.edit', ALLOW],
    [true, 'cEditprofile.update', ALLOW],
    [true, 'core:clogin.main', ALLOW],
  ])('answers a site-less user (S2IsPrivate %s) on %j', (s2IsPrivate, muraAction, expected) => {
    expect(applicationGate(noSitesRequest({ s2IsPrivate }, { rc: { muraAction } }))).toEqual(expected);
  });

  it.each<[string, 'member' | 'systemUser', string, GateDecision]>([
    ['S2IsPublic', 'member', noSitesSession.mura.memberships, redirect(LOGOUT)],
    ['S2IsPrivate', 'systemUser', s2PrivateMemberSession.mura.memberships, redirect(NOACCESS)],
    [
      'a lower-case s2isprivate',
      'systemUser',
      s2PrivateMemberSession.mura.memberships.replaceAll('S2IsPrivate', 's2isprivate'),
      redirect(LOGOUT),
    ],
  ])('reads %s from the memberships identity holds, case-sensitively', async (_label, user, memberships, expected) => {
    const request = await buildTestAdminRequest({
      circuit: 'cusers',
      action: 'list',
      user,
      sessionState: { mura: { memberships }, siteArray: [] },
    });

    expect(request.session.siteArray).toEqual([]);
    expect(applicationGate(request)).toEqual(expected);
  });

  it.each<[string, (partial: AdminRequestPartial) => AdminRequest]>([
    ['the S2 admin', adminS2Request],
    ['qa_editor', editorRequest],
    [
      'a public member with a site',
      (partial) => makeAdminRequest({ ...partial, session: { siteArray: ['default'] } }, 'member'),
    ],
  ])('lets %s through on any action', (_label, build) => {
    for (const muraAction of ['core:cusers.list', 'core:csettings.editsite', 'core:cmessage.noaccess', '']) {
      const request = build({ rc: { muraAction } });
      expect(request.session.siteArray.length).toBeGreaterThan(0);
      expect(applicationGate(request)).toEqual(ALLOW);
    }
  });

  it.each(['core:cusers.list', 'core:csettings.editsite', ''])('lets an anonymous user through on %j', (muraAction) => {
    const request = anonymousRequest({ rc: { muraAction } });

    expect(request.session.siteArray).toEqual([]);
    expect(applicationGate(request)).toEqual(ALLOW);
  });

  it.each<[boolean, string]>([
    [false, '/cms/admin/?muraAction=clogin.logout'],
    [true, '/cms/admin/?muraAction=cMessage.noaccess'],
  ])('prefixes the configured context (S2IsPrivate %s)', (s2IsPrivate, location) => {
    withSettings({ MURA_CONTEXT: '/cms' });

    expect(applicationGate(noSitesRequest({ s2IsPrivate }, { circuit: 'cusers', item: 'list' }))).toEqual(
      redirect(location),
    );
  });
});

describe('secure (controller.cfc 83-92)', () => {
  it.each<[string, boolean, string]>([
    ['80', false, 'http://example.test/admin/?&muraAction=cusers.list'],
    ['443', true, 'https://example.test/admin/?&muraAction=cusers.list'],
    ['8080', false, 'http://example.test:8080/admin/?&muraAction=cusers.list'],
  ])('sends an anonymous user to cLogin.main with the return URL on port %s', (port, https, returnUrl) => {
    withSettings({ MURA_PORT: port });

    expect(secure(anonymousListRequest({ https }))).toEqual(loginRedirect(returnUrl, 'false'));
  });

  // Oracle: anonymous cArch.list answered 302 with each raw value as the admin scan leaves it.
  it.each<[value: string, scanned: string]>([
    ['true', 'true'],
    [' TRUE', 'TRUE'],
    ['tr\u0000ue', 'true'],
    [' 1.0 ', '1.0'],
    [' true', '"YES"'],
    [' false', '"NO"'],
    ['abc ', 'abc'],
  ])('carries compactDisplay %j into the login redirect as %j', (value, scanned) => {
    const request = anonymousListRequest({ rc: { compactDisplay: value } });

    expect(secure(request)).toEqual(loginRedirect('http://example.test/admin/?&muraAction=cusers.list', scanned));
  });

  it('appends no compactDisplay when rc holds none', () => {
    const request: AdminRequest = { ...anonymousListRequest(), rc: { muraAction: 'core:cusers.list' } };

    expect(secure(request)).toEqual(loginRedirect('http://example.test/admin/?&muraAction=cusers.list'));
  });

  it.each<[string, HeadersInit, string]>([
    ['the referrer', { referer: REFERER }, REFERER],
    ['./ without a referrer', {}, './'],
    ['./ for an empty referrer', { referer: '' }, './'],
  ])('sends a logged-in user back to %s (utility.cfc backUp)', (_label, headers, location) => {
    expect(secure(adminS2Request({ headers: new Headers(headers) }))).toEqual(redirect(location));
  });
});

describe('runGate', () => {
  it('returns the application redirect without calling the screen gate', async () => {
    const screenGate = vi.fn<ScreenGate>(() => ALLOW);

    const request = noSitesRequest({ s2IsPrivate: false }, { circuit: 'cusers', item: 'list' });

    const decision = await runGate(request, screenGate);

    expect(decision).toEqual(redirect(LOGOUT));
    expect(screenGate).not.toHaveBeenCalled();
  });

  it('allows a request the application gate allows when there is no screen gate', async () => {
    await expect(runGate(adminS2Request({ circuit: 'cusers', item: 'list' }))).resolves.toEqual(ALLOW);
  });

  it.each<[string, ScreenGate]>([
    ['a synchronous', () => redirect(NOACCESS)],
    [
      'an asynchronous',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return redirect(NOACCESS);
      },
    ],
  ])('returns the decision of %s screen gate', async (_label, gate) => {
    const request = editorRequest({ circuit: 'cusers', item: 'list' });
    const screenGate = vi.fn(gate);

    await expect(runGate(request, screenGate)).resolves.toEqual(redirect(NOACCESS));
    expect(screenGate).toHaveBeenCalledExactlyOnceWith(request, { secure: expect.any(Function) });
  });

  it('hands the screen gate secure() for the same request', async () => {
    const gate: ScreenGate = (_req, { secure: secureRequest }) => secureRequest();

    await expect(runGate(anonymousListRequest(), gate)).resolves.toEqual(
      loginRedirect('http://example.test/admin/?&muraAction=cusers.list', 'false'),
    );
    await expect(runGate(adminS2Request({ headers: new Headers({ referer: REFERER }) }), gate)).resolves.toEqual(
      redirect(REFERER),
    );
  });

  it('passes its options to the screen gate secure()', async () => {
    const gate: ScreenGate = (_req, { secure: secureRequest }) => secureRequest();
    const request = anonymousListRequest({ hrefDomains: { allowedDomains: ['localhost'], siteDomain: 'localhost' } });

    await expect(runGate(request, gate, { hrefDomains: EXAMPLE_DOMAINS })).resolves.toEqual(
      loginRedirect('http://example.test/admin/?&muraAction=cusers.list', 'false'),
    );
    await expect(runGate(request, gate)).resolves.toEqual(
      loginRedirect('http://localhost/admin/?&muraAction=cusers.list', 'false'),
    );
  });
});
