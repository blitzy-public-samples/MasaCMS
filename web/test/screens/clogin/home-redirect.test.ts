// home.cfc redirect() against legacy, over programs-sites' getUserSites and bindToDomain answer (tested there).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/programs-sites';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import { homeRedirectScreen } from '@/screens/clogin/home-redirect';
import type { SubmitResult } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type UserSite = components['schemas']['UserSite'];

const USER_SITES = routeKey('GET', 'programs-sites', '/v1/user-sites');
const SITE_MANAGER_TAIL = '&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001';

/** `./?muraAction=cArch.list` for `siteid`, as FW/1 appends `siteid,moduleid,topid`. */
const siteManager = (siteid: string): string => `./?muraAction=cArch.list&siteid=${siteid}${SITE_MANAGER_TAIL}`;

/** A `listUserSites` row; `site` defaults to the id and the dashboard is hidden. */
function userSite(siteid: string, orderno: number | null, extra: Partial<UserSite> = {}): UserSite {
  return { siteid, site: siteid, orderno, domain: 'localhost', domainAlias: null, showDashboard: 0, ...extra };
}

/** programs-sites' answer: `sites` in its name order and the site the host binds to. */
const sitesReply = (sites: readonly UserSite[], boundSiteId: string | null = null): FakeReply => ({
  status: 200,
  body: { sites, boundSiteId },
});

/** The `Location` the screen answers `req` with. */
async function locationFor(req: AdminRequest, gateway: FakeGatewayClient = fakeGatewayClient()): Promise<string> {
  const result: SubmitResult = await homeRedirectScreen.submit(makeScreenContext({ req, gateway }));
  if (result.kind !== 'location') throw new TypeError(`Expected a location result, got ${result.kind}`);
  return result.location;
}

/** Headers of a request the gateway forwarded for `host`. */
const forwardedFor = (host: string): AdminRequestPartial => ({ headers: new Headers({ 'x-forwarded-host': host }) });

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('homeRedirectScreen', () => {
  it('is the identity-owned redirect action of the home circuit, with the inventoried response mode', () => {
    const inventory = JSON.parse(
      readFileSync(new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
    ) as { controllers: Array<{ actions: Array<{ variants: Array<{ id: string; responseMode: string }> }> }> };
    const variant = inventory.controllers
      .flatMap((controller) => controller.actions.flatMap((action) => action.variants))
      .find((candidate) => candidate.id === 'ctl:home.redirect');
    expect(homeRedirectScreen).toMatchObject({ circuit: 'home', action: 'redirect', owner: 'identity' });
    expect(homeRedirectScreen.mode).toBe(variant?.responseMode);
  });

  it('lets every request through its own gate', async () => {
    const secure = vi.fn();
    const { gate } = homeRedirectScreen;
    if (gate === undefined) throw new TypeError('homeRedirectScreen has no gate');
    expect(await gate(anonymousRequest(), { secure })).toEqual({ kind: 'allow' });
    expect(secure).not.toHaveBeenCalled();
  });
});

describe('home.redirect target', () => {
  it('sends an anonymous user to the login form without reading any site', async () => {
    const gateway = fakeGatewayClient();
    expect(await locationFor(anonymousRequest(), gateway)).toBe('./?muraAction=clogin.main');
    expect(gateway.calls).toEqual([]);
  });

  it('builds the target in SES form when the request carried path segments', async () => {
    expect(await locationFor(anonymousRequest({ ses: true }))).toBe(
      buildUrl('clogin.main', './', '', { ses: true }),
    );
  });

  it.each<[string, AdminRequestPartial, string]>([
    ['a non-empty X-Forwarded-Host', forwardedFor('tenant-a.example.com:8080'), 'tenant-a.example.com:8080'],
    [
      'the Host without X-Forwarded-Host',
      { headers: new Headers(), httpHost: 'alias.example.com:8443' },
      'alias.example.com:8443',
    ],
    [
      'the server name without either',
      { headers: new Headers({ 'x-forwarded-host': '' }), httpHost: '', serverName: 'x.test' },
      'x.test',
    ],
  ])('sends %s for programs-sites to bind, and opens the bound Site Manager', async (_name, partial, host) => {
    const sites = [userSite('default', 1), userSite('tenant-a', 2)];
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply(sites, 'tenant-a') });
    expect(await locationFor(adminS2Request(partial), gateway)).toBe(siteManager('tenant-a'));
    expect(gateway.calls).toEqual([
      { service: 'programs-sites', method: 'GET', path: '/v1/user-sites', query: { host } },
    ]);
  });

  it.each([
    ['binds no site, as on the admin domain', null],
    ['binds a site the user does not administer', 'tenant-c'],
    ['binds a site whose id differs only in case', 'TENANT-B'],
  ])('opens the first administered site by bind order, then name, when the host %s', async (_name, bound) => {
    const sites = [userSite('default', 5), userSite('tenant-a', 1), userSite('tenant-b', 1)];
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply(sites, bound) });
    expect(await locationFor(editorRequest(forwardedFor('admin.example.com')), gateway)).toBe(siteManager('tenant-a'));
  });

  it.each([
    ['after', [userSite('default', 1), userSite('tenant-a', null)]],
    ['before', [userSite('tenant-a', null), userSite('default', 1)]],
  ])('opens a site without a bind order first when listed %s an ordered one', async (_name, sites) => {
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply(sites) });
    expect(await locationFor(adminS2Request(), gateway)).toBe(siteManager('tenant-a'));
  });

  it('opens the dashboard of a private user when the chosen site shows it', async () => {
    const sites = [userSite('default', 1), userSite('tenant-a', 2, { showDashboard: 1 })];
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply(sites, 'tenant-a') });
    expect(await locationFor(adminS2Request(), gateway)).toBe('./?muraAction=cDashboard.main&siteid=tenant-a');
  });

  it.each<[string, Partial<UserSite>, AdminRequestPartial]>([
    ['a public-pool user', { showDashboard: 1 }, { session: { mura: { memberships: 'S2' } } }],
    ['a site that hides it', { showDashboard: 0 }, {}],
  ])('opens the Site Manager instead of the dashboard for %s', async (_name, site, partial) => {
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply([userSite('default', 1, site)], 'default') });
    expect(await locationFor(adminS2Request(partial), gateway)).toBe(siteManager('default'));
  });

  it('decides the dashboard by the chosen site, not the served one', async () => {
    const sites = [userSite('default', 1, { showDashboard: 1 }), userSite('tenant-a', 2)];
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply(sites, 'tenant-a') });
    const req = adminS2Request({ site: { record: { showDashboard: 1 } } });
    expect(await locationFor(req, gateway)).toBe(siteManager('tenant-a'));
  });

  it.each([
    ['a private user to the no-access message', true, './?muraAction=cMessage.noAccess'],
    ['a public user to the login form', false, './?muraAction=clogin.main'],
  ])('sends %s when programs-sites lists no administered site', async (_name, s2IsPrivate, expected) => {
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply([], 'default') });
    expect(await locationFor(noSitesRequest({ s2IsPrivate }), gateway)).toBe(expected);
  });

  it('URL-encodes the site id it appends', async () => {
    const gateway = fakeGatewayClient({ [USER_SITES]: sitesReply([userSite('tenant a&b', 1)]) });
    expect(await locationFor(adminS2Request(), gateway)).toBe(siteManager('tenant+a%26b'));
  });

  it('propagates gateway unavailability', async () => {
    const gateway = fakeGatewayClient();
    gateway.failWith();
    await expect(locationFor(adminS2Request(), gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('propagates a refused site list as a denial', async () => {
    const gateway = fakeGatewayClient({ [USER_SITES]: { status: 403, body: { error: 'forbidden' } } });
    await expect(locationFor(adminS2Request(), gateway)).rejects.toBeInstanceOf(GatewayDenialError);
  });
});
