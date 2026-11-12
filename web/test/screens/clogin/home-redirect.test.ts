// home.cfc redirect() against legacy: getUserSites, bindToDomain(isAdmin=true) and the landing redirect it sends.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessClock } from '@opt2/platform/testing';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import { bindToAdminDomain, homeRedirectScreen, userSites, type HomeSite } from '@/screens/clogin/home-redirect';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const LIST_SITES = routeKey('GET', 'programs-sites', '/v1/sites');
const SITE_MANAGER_TAIL = '&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001';

/** `./?muraAction=cArch.list` for `siteid`, as FW/1 appends `siteid,moduleid,topid`. */
const siteManager = (siteid: string): string => `./?muraAction=cArch.list&siteid=${siteid}${SITE_MANAGER_TAIL}`;

/** A site row; `site` defaults to the id. */
function homeSite(siteid: string, orderno: number | null, domain: string, extra: Partial<HomeSite> = {}): HomeSite {
  return { siteid, site: siteid, orderno, domain, domainAlias: '', ...extra };
}

/** A `listSites` row as programs-sites serves it, with any extra `tsettings` columns. */
function listedSite(
  siteid: string,
  site: string | null,
  orderno: number | null,
  domain: string | null,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { siteid, site, domain, orderno, deploy: 0, lastDeployment: null, ...extra };
}

const listReply = (...rows: Array<Record<string, unknown>>): FakeReply => ({ status: 200, body: rows });

/** The screen context `req` is submitted in, over `gateway`. */
function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: { locale: 'en_US', rbKey: (key) => `${key}_missing`, messageFormat: (pattern) => pattern },
    hooks: { secondaryMenus: {} },
    now: businessClock().now(),
  };
}

/** The `Location` the screen answers `req` with. */
async function locationFor(req: AdminRequest, gateway: FakeGatewayClient = fakeGatewayClient()): Promise<string> {
  const result: SubmitResult = await homeRedirectScreen.submit(contextFor(req, gateway));
  if (result.kind !== 'location') throw new TypeError(`Expected a location result, got ${result.kind}`);
  return result.location;
}

/** Headers of a request the gateway forwarded for `host`. */
const forwardedFor = (host: string): AdminRequestPartial => ({ headers: new Headers({ 'x-forwarded-host': host }) });

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  useSettings();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('userSites', () => {
  const sites = [
    homeSite('tenant-b', 1, 'b.test', { site: 'tenant B' }),
    homeSite('default', 2, 'localhost', { site: 'Default' }),
    homeSite('tenant-a', 3, 'a.test', { site: 'Tenant A' }),
  ];
  const ids = (list: readonly HomeSite[]): string[] => list.map((site) => site.siteid);

  it.each([
    ['an S2 user sees every site', ['tenant-a'], true, ['default', 'tenant-a', 'tenant-b']],
    ['a user sees the sites of siteArray', ['tenant-b', 'default'], false, ['default', 'tenant-b']],
    ['siteArray ids match case-sensitively', ['Tenant-A', 'default'], false, ['default']],
    ['an empty siteArray gives no site', [], false, []],
  ])('%s, in site-name order', (_name, siteArray, isS2, expected) => {
    expect(ids(userSites(sites, siteArray, isS2))).toEqual(expected);
  });
});

describe('bindToAdminDomain', () => {
  it.each([
    [
      'a complete match beats an earlier partial match',
      [homeSite('www', 1, 'www.example.com'), homeSite('apex', 2, 'example.com')],
      'example.com',
      'apex',
    ],
    [
      'a complete match ignores case and the port',
      [homeSite('a', 1, 'other.test'), homeSite('b', 2, 'Example.COM')],
      'example.com:8080',
      'b',
    ],
    [
      'an alias on a CRLF- or LF-separated line matches completely',
      [homeSite('a', 1, 'a.test'), homeSite('b', 2, 'b.test', { domainAlias: 'x.test\r\n\r\nalias.test\ny.test' })],
      'ALIAS.test',
      'b',
    ],
    [
      'a partial match finds the host inside a domain or alias',
      [homeSite('a', 1, 'a.test'), homeSite('b', 2, 'b.test', { domainAlias: 'cms.example.org' })],
      'example',
      'b',
    ],
    [
      'a partial match is case-sensitive, so the first site by bind order is the fallback',
      [homeSite('late', 9, 'www.example.com'), homeSite('null', null, 'n.test'), homeSite('early', 1, 'e.test')],
      'Example',
      'null',
    ],
  ])('%s', (_name, sites, host, expected) => {
    expect(bindToAdminDomain(sites, host, '')).toBe(expected);
  });

  it('answers --none-- on the admin domain, compared without case', () => {
    expect(bindToAdminDomain([homeSite('a', 1, 'a.test')], 'ADMIN.example.com:443', 'admin.example.com')).toBe(
      '--none--',
    );
  });

  it('answers an empty id when there is no site', () => {
    expect(bindToAdminDomain([], 'localhost', 'admin.example.com')).toBe('');
  });
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

  it('opens the Site Manager of the site bound to the request host', async () => {
    const gateway = fakeGatewayClient({
      [LIST_SITES]: listReply(
        listedSite('default', 'Default', 1, 'localhost'),
        listedSite('tenant-a', 'Tenant A', 2, 'tenant-a.example.com'),
      ),
    });
    expect(await locationFor(adminS2Request(forwardedFor('tenant-a.example.com:8080')), gateway)).toBe(
      siteManager('tenant-a'),
    );
    expect(gateway.calls).toMatchObject([
      { service: 'programs-sites', path: '/v1/sites', query: { sortBy: 'site', sortDirection: 'asc' } },
    ]);
  });

  it('binds by the served alias the site list omits', async () => {
    const gateway = fakeGatewayClient({
      [LIST_SITES]: listReply(
        listedSite('tenant-a', 'Tenant A', 1, 'tenant-a.example.com'),
        listedSite('default', 'Default', 2, 'localhost'),
      ),
    });
    const req = adminS2Request({
      ...forwardedFor('alias.example.com'),
      site: { record: { domainAlias: 'x.example.com\r\nalias.example.com' } },
    });
    expect(await locationFor(req, gateway)).toBe(siteManager('default'));
  });

  it('binds by a listed alias, reading the Host when no X-Forwarded-Host came', async () => {
    const gateway = fakeGatewayClient({
      [LIST_SITES]: listReply(
        listedSite('tenant-a', null, 1, null),
        listedSite('default', 'Default', 2, 'localhost', { domainAlias: 'alias.example.com' }),
      ),
    });
    const req = adminS2Request({ headers: new Headers(), httpHost: 'alias.example.com:8443', serverName: 'x' });
    expect(await locationFor(req, gateway)).toBe(siteManager('default'));
  });

  it('on the admin domain, opens the first site by bind order, name order breaking ties', async () => {
    useSettings({ MURA_ADMINDOMAIN: 'admin.example.com' });
    const gateway = fakeGatewayClient({
      [LIST_SITES]: listReply(
        listedSite('default', 'Default', 5, 'localhost'),
        listedSite('tenant-a', 'Tenant A', 1, 'a.example.org'),
        listedSite('tenant-b', 'Tenant B', 1, 'b.example.org'),
      ),
    });
    expect(await locationFor(adminS2Request(forwardedFor('ADMIN.example.com')), gateway)).toBe(
      siteManager('tenant-a'),
    );
  });

  it('opens the first administered site when the bound site is not administered', async () => {
    const gateway = fakeGatewayClient();
    const req = editorRequest({ ...forwardedFor('localhost'), session: { siteArray: ['tenant-b', 'tenant-a'] } });
    expect(await locationFor(req, gateway)).toBe(siteManager('tenant-a'));
    expect(gateway.calls).toEqual([]);
  });

  it.each([
    ['the served setting', { site: { record: { showDashboard: 1 } } }, {}],
    ['a listed true', {}, { showDashboard: 'true' }],
    ['a listed yes', {}, { showDashboard: 'YES' }],
  ])('opens the dashboard of a private user when %s shows it', async (_name, partial, listed) => {
    const gateway = fakeGatewayClient({
      [LIST_SITES]: listReply(listedSite('default', 'Default', 1, 'localhost', listed)),
    });
    expect(await locationFor(adminS2Request(partial as AdminRequestPartial), gateway)).toBe(
      './?muraAction=cDashboard.main&siteid=default',
    );
  });

  it.each([
    ['a public-pool user', { site: { record: { showDashboard: 1 } }, session: { mura: { memberships: 'S2' } } }],
    ['a site that hides it', { site: { record: { showDashboard: 0 } } }],
    ['a non-boolean setting', { site: { record: { showDashboard: null } } }],
  ])('opens the Site Manager instead of the dashboard for %s', async (_name, partial) => {
    const gateway = fakeGatewayClient({ [LIST_SITES]: listReply(listedSite('default', 'Default', 1, 'localhost')) });
    expect(await locationFor(adminS2Request(partial as AdminRequestPartial), gateway)).toBe(siteManager('default'));
  });

  it.each([
    ['a private user to the no-access message', true, './?muraAction=cMessage.noAccess'],
    ['a public user to the login form', false, './?muraAction=clogin.main'],
  ])('sends %s when no site is administered', async (_name, s2IsPrivate, expected) => {
    expect(await locationFor(noSitesRequest({ s2IsPrivate }))).toBe(expected);
  });

  it('sends an S2 user to the no-access message when programs-sites lists no site', async () => {
    const gateway = fakeGatewayClient({ [LIST_SITES]: listReply() });
    expect(await locationFor(adminS2Request(), gateway)).toBe('./?muraAction=cMessage.noAccess');
  });

  it('URL-encodes the site id it appends', async () => {
    const gateway = fakeGatewayClient({ [LIST_SITES]: listReply(listedSite('tenant a&b', 'Odd', 1, 'localhost')) });
    expect(await locationFor(adminS2Request(), gateway)).toBe(siteManager('tenant+a%26b'));
  });

  it('propagates gateway unavailability', async () => {
    const gateway = fakeGatewayClient();
    gateway.failWith();
    await expect(locationFor(adminS2Request(), gateway)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it('propagates a refused site list as a denial', async () => {
    const gateway = fakeGatewayClient({ [LIST_SITES]: { status: 403, body: { error: 'forbidden' } } });
    await expect(locationFor(adminS2Request(), gateway)).rejects.toBeInstanceOf(GatewayDenialError);
  });
});
