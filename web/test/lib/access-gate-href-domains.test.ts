// The login return URL of an anonymous request, sanitized against programs-sites' registry domains and never the Host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError } from '@/lib/gateway-client';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import type { HrefDomains } from '@/lib/urls';
import { adminS2Request, anonymousRequest, buildTestAdminRequest } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../helpers/fake-gateway';

const HREF_DOMAINS = routeKey('GET', 'programs-sites', '/v1/href-domains');

/** programs-sites' answers for the legacy oracle's `default` site in each captured configuration. */
const PRISTINE: HrefDomains = { allowedDomains: ['localhost'], siteDomain: 'localhost' };
const ALIASED: HrefDomains = {
  allowedDomains: ['localhost', 'alias.example', 'Second.Alias.test'],
  siteDomain: 'localhost',
};
const MOVED: HrefDomains = {
  allowedDomains: ['Site.Example', 'alias.example', 'Second.Alias.test'],
  siteDomain: 'Site.Example',
};

/** The `Location` legacy sends an anonymous `GET /admin/?<query>`, from its encoded `returnURL`. */
const login = (returnUrl: string, compactDisplay = 'false'): string =>
  `./?muraAction=cLogin.main&returnURL=${returnUrl}&compactDisplay=${compactDisplay}`;

const LIST = 'muraAction=cusers.list';

/** {@link login} for `GET /admin/?muraAction=cusers.list` with `host` in the return URL. */
const listLocation = (host: string): string =>
  login(`http%3A%2F%2F${host}%3A23280%2Fadmin%2F%3F%26muraAction%3Dcusers.list`);

let restoreEnv: () => void;

/** Masa settings of the legacy oracle the Locations were captured from, with `vars` laid over them. */
function useSettings(vars: Readonly<Record<string, string>> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  vi.stubEnv('MURA_PORT', '23280');
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

/** The real set-up of an anonymous `GET /admin/?<query>` from `host`, with programs-sites answering `domains`. */
async function anonymousGet(
  host: string,
  query: string,
  domains: HrefDomains,
): Promise<{ request: AdminRequest; gateway: FakeGatewayClient }> {
  const gateway = fakeGatewayClient({ [HREF_DOMAINS]: { status: 200, body: domains } });
  const request = await buildTestAdminRequest({
    circuit: 'cusers',
    action: 'list',
    gateway,
    headers: { 'x-forwarded-host': host, [ORIGINAL_URL_HEADER]: `/admin/?${query}` },
  });
  return { request, gateway };
}

describe('secure() of an anonymous request', () => {
  // Captured from the legacy oracle with `curl -H "Host: <host>" /admin/?<query>`; its URL scope order varies between
  // runs, so each query is compared in the order legacy was seen to emit it. The admin-domain rows follow
  // configBean.getCurrentAdminDomain, as the shared oracle's admin domain cannot be configured.
  it.each<[string, string, string, string, HrefDomains, string]>([
    ['an unregistered host', '', 'evil.example:23280', LIST, PRISTINE, listLocation('localhost')],
    ['an IP host', '', '127.0.0.1:23280', LIST, PRISTINE, listLocation('localhost')],
    ['an unregistered host in another case', '', 'EVIL.example:23280', LIST, PRISTINE, listLocation('localhost')],
    ['an unregistered host without a port', '', 'evil.example', LIST, PRISTINE, listLocation('localhost')],
    ['the site domain', '', 'localhost:23280', LIST, PRISTINE, listLocation('localhost')],
    ['a registered alias', '', 'alias.example:23280', LIST, ALIASED, listLocation('alias.example')],
    ['a registered alias in another case', '', 'ALIAS.EXAMPLE:23280', LIST, ALIASED, listLocation('ALIAS.EXAMPLE')],
    ['a second alias line', '', 'second.alias.test:23280', LIST, ALIASED, listLocation('second.alias.test')],
    ['an unregistered host beside aliases', '', 'evil.example:23280', LIST, ALIASED, listLocation('localhost')],
    ['an unregistered host of a moved site', '', 'evil.example:23280', LIST, MOVED, listLocation('Site.Example')],
    ['a host the site no longer has', '', 'localhost:23280', LIST, MOVED, listLocation('Site.Example')],
    ['the moved site domain in another case', '', 'site.example:23280', LIST, MOVED, listLocation('site.example')],
    [
      'a site id naming no site',
      '',
      'evil.example:23280',
      `${LIST}&siteid=nosuch`,
      MOVED,
      login('http%3A%2F%2FSite.Example%3A23280%2Fadmin%2F%3F%26muraAction%3Dcusers.list%26siteid%3Dnosuch'),
    ],
    [
      'an empty site id',
      '',
      'evil.example:23280',
      `${LIST}&siteid=`,
      PRISTINE,
      login('http%3A%2F%2Flocalhost%3A23280%2Fadmin%2F%3F%26muraAction%3Dcusers.list%26siteid%3D'),
    ],
    [
      'the default site in another host case',
      '',
      'LOCALHOST:23280',
      `${LIST}&siteid=default`,
      PRISTINE,
      login('http%3A%2F%2FLOCALHOST%3A23280%2Fadmin%2F%3F%26muraAction%3Dcusers.list%26siteid%3Ddefault'),
    ],
    [
      'a compact display',
      '',
      'evil.example:23280',
      `compactDisplay=true&${LIST}`,
      PRISTINE,
      login('http%3A%2F%2Flocalhost%3A23280%2Fadmin%2F%3F%26compactDisplay%3Dtrue%26muraAction%3Dcusers.list', 'true'),
    ],
    ['an admin host when no admin domain is set', '', 'admin.example:23280', LIST, PRISTINE, listLocation('localhost')],
    ['an admin domain host', 'admin.example', 'Admin.Example:23280', LIST, PRISTINE, listLocation('Admin.Example')],
    [
      'one of several admin domains',
      'cms.example,admin.example',
      'admin.example:23280',
      LIST,
      PRISTINE,
      listLocation('admin.example'),
    ],
    ['a host that is no admin domain', 'admin.example', 'evil.example', LIST, PRISTINE, listLocation('localhost')],
  ])('sends the legacy Location for %s', async (_label, adminDomain, host, query, domains, location) => {
    useSettings({ MURA_ADMINDOMAIN: adminDomain });
    const { request } = await anonymousGet(host, query, domains);

    expect(secure(request)).toEqual({ kind: 'redirect', location });
  });

  // Legacy switches session.siteid to any registered rc.siteid (admin/Application.cfc:384-391), which web cannot
  // verify for an anonymous user, so the unswitched id goes to programs-sites, whose getSite fallback decides.
  it.each([
    ['no site id', LIST, 'default', 'default', 'localhost'],
    ['a site id naming no site', `${LIST}&siteid=nosuch`, '', 'nosuch', 'localhost'],
    ['another registered site', `${LIST}&siteid=tenant-a`, '', 'tenant-a', 'tenant-a.example'],
  ])('asks programs-sites for the site of %s', async (_label, query, sessionSiteId, siteid, siteDomain) => {
    const domains: HrefDomains = { allowedDomains: ['localhost', 'tenant-a.example'], siteDomain };
    const { request, gateway } = await anonymousGet('evil.example:23280', query, domains);

    expect(request.session.siteid).toBe(sessionSiteId);
    expect(gateway.calls).toEqual([
      expect.objectContaining({ service: 'programs-sites', path: '/v1/href-domains', query: { siteid } }),
    ]);
    expect(secure(request)).toMatchObject({
      location: expect.stringContaining(`returnURL=http%3A%2F%2F${siteDomain}%3A23280%2Fadmin%2F`),
    });
  });

  it('prefers domains the caller supplies over the request ones', () => {
    const request = anonymousRequest({ serverName: 'alias.example', httpHost: 'alias.example:23280' });

    expect(secure(request, { hrefDomains: ALIASED })).toEqual({
      kind: 'redirect',
      location: login('http%3A%2F%2Falias.example%3A23280%2Fadmin%2F%3F%26muraAction%3Dhome.redirect'),
    });
    expect(secure(request)).toEqual({
      kind: 'redirect',
      location: login('http%3A%2F%2Flocalhost%3A23280%2Fadmin%2F%3F%26muraAction%3Dhome.redirect'),
    });
  });

  it('refuses to fall back to the Host when no registry domains were loaded', () => {
    const request: AdminRequest = { ...anonymousRequest({ serverName: 'evil.example' }), hrefDomains: undefined };

    expect(() => secure(request)).toThrow(TypeError);
  });

  it('raises a GatewayDenialError when programs-sites refuses the read', async () => {
    const gateway = fakeGatewayClient({ [HREF_DOMAINS]: { status: 403 } });

    const built = buildTestAdminRequest({ circuit: 'cusers', action: 'list', gateway });
    await expect(built).rejects.toBeInstanceOf(GatewayDenialError);
    await expect(built).rejects.toMatchObject({
      service: 'programs-sites',
      operation: 'getHrefDomains',
      status: 403,
      message: 'getHrefDomains answered HTTP 403',
    });
  });
});

describe('secure() of a logged-in request', () => {
  it('loads no registry domains and returns to the referrer', async () => {
    const gateway = fakeGatewayClient();
    const request = await buildTestAdminRequest({ circuit: 'cusers', action: 'list', user: 'admin', gateway });

    expect(request.hrefDomains).toBeUndefined();
    expect(gateway.calls.map(({ path }) => path)).not.toContain('/v1/href-domains');
    expect(secure(adminS2Request({ headers: new Headers({ referer: 'http://localhost:23280/admin/' }) }))).toEqual({
      kind: 'redirect',
      location: 'http://localhost:23280/admin/',
    });
  });
});
