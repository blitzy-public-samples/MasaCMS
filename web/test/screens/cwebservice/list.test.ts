import { cfJavaDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deniedGate, secure, type GateDecision } from '@/lib/access-gate';
import { parseLegacyDate } from '@/lib/dates';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { CWEBSERVICE_RC_DEFAULTS, cwebserviceScreens } from '@/screens/cwebservice';
import { authModeLabel, effectiveGrantType, type WebServiceClient } from '@/screens/cwebservice/list';
import type { PageScreen, ScreenDefinition } from '@/screens/registry';
import { OAUTH_CLIENT_IDS, emptyOAuthClients, oauthClientRows } from '../../fixtures/identity/oauth-clients';
import {
  adminS2Request,
  anonymousRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { domModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const SITE = 'default';
const LIST_PATH = '/v1/oauth-clients';
const CSRF_PATH = '/v1/csrf/tokens';
const ACTIONS = ['list', 'edit', 'save', 'delete'] as const;
const REFERER = 'http://localhost/admin/?muraAction=cArch.list&siteid=tenant-a';
const ADD_HREF = './?muraAction=cwebservice.edit&clientid=&siteid=&default';
const EMPTY_NOTICE = 'There currently are no web services configured for this site.';
const SSL_ALERT = {
  text: 'When using web services in production, this site should be set to use SSL (HTTPS).',
  className: 'alert alert-error',
};

const editHref = (clientid: string): string => `./?muraAction=cwebservice.edit&clientid=${clientid}&siteid=${SITE}`;

const deleteHref = (clientid: string): string =>
  `./?muraAction=cwebservice.delete&clientid=${clientid}&siteid=${SITE}` +
  `&csrf_token=${FIXED_CSRF.token}&csrf_token_expires=${FIXED_CSRF.expires}`;

/** The registered cwebservice definition of `action`. */
function definition(action: string): ScreenDefinition {
  const def = cwebserviceScreens.find((candidate) => candidate.action === action);
  if (def === undefined) throw new Error(`cwebservice.${action} is not registered`);
  return def;
}

function listPage(): PageScreen<unknown> {
  const def = definition('list');
  if (def.mode !== 'page') throw new Error('cwebservice.list is not a page');
  return def;
}

/** The `before()` decision of `action` for `req`, with the controller's real `secure()`. */
async function decide(action: string, req: AdminRequest): Promise<GateDecision> {
  const { gate } = definition(action);
  if (gate === undefined) throw new Error(`cwebservice.${action} has no gate`);
  return gate(req, { secure: () => secure(req) });
}

/** identity's `listOAuthClients` answering `clients` as one page. */
const listRoutes = (clients: readonly WebServiceClient[]): FakeRouteTable => ({
  [routeKey('GET', 'identity', LIST_PATH)]: {
    status: 200,
    body: { items: clients, total: clients.length, nextOffset: null },
  },
});

const listRequest = (partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ circuit: 'cwebservice', item: 'list', ...partial });

/** Last Update as list.cfm formats it under `req`'s session. */
function lastUpdateText(req: AdminRequest, value: string | null | undefined): string {
  const date = parseLegacyDate(value);
  if (date === null) throw new Error(`${String(value)} is not a date`);
  return `${cfJavaDateFormat(date, req.session.dateKeyFormat)} ${cfLsTimeFormat(date, 'medium', req.session.locale)}`;
}

/** The list page in the shell for `req`, over identity answering `routes`. */
async function renderList(
  req: AdminRequest,
  routes: FakeRouteTable,
): Promise<{ html: string; $: cheerio.CheerioAPI; gateway: FakeGatewayClient }> {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
  const page = await renderScreenPage(listPage(), ctx);
  if (page.kind !== 'document') throw new Error(`cwebservice.list redirected to ${page.location}`);
  return { html: page.html, $: cheerio.load(page.html), gateway: ctx.gateway };
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cwebservice circuit', () => {
  it('defaults rc as before() params', () => {
    expect(CWEBSERVICE_RC_DEFAULTS).toEqual({
      clientid: '',
      clientsecret: '',
      name: '',
      description: '',
      granttype: 'basic',
      redirecturl: '',
      userid: '',
    });
  });

  it('registers the four identity actions', () => {
    expect(cwebserviceScreens.map(({ circuit, action, owner, mode }) => ({ circuit, action, owner, mode }))).toEqual([
      { circuit: 'cwebservice', action: 'list', owner: 'identity', mode: 'page' },
      { circuit: 'cwebservice', action: 'edit', owner: 'identity', mode: 'page' },
      // save.cfm is the view of save(), so the inventory records save as a page action.
      { circuit: 'cwebservice', action: 'save', owner: 'identity', mode: 'page' },
      { circuit: 'cwebservice', action: 'delete', owner: 'identity', mode: 'redirect' },
    ]);
  });

  it.each(ACTIONS)('lets the S2 admin through %s', async (action) => {
    await expect(decide(action, adminS2Request({ circuit: 'cwebservice', item: action }))).resolves.toEqual({
      kind: 'allow',
    });
  });

  const secured = ACTIONS.flatMap((action) => [
    {
      action,
      who: 'the tenant-a site admin',
      req: () => siteAdminRequest('tenant-a', { circuit: 'cwebservice', item: action }),
      expected: { kind: 'redirect', location: './' },
    },
    {
      action,
      who: 'a site admin claiming S2 in rc',
      req: () =>
        siteAdminRequest('tenant-a', {
          circuit: 'cwebservice',
          item: action,
          rc: { s2: '1', memberships: 'S2', isS2: 'true' },
        }),
      expected: { kind: 'redirect', location: './' },
    },
    {
      action,
      who: 'a site admin with a Referer',
      req: () =>
        siteAdminRequest('tenant-a', {
          circuit: 'cwebservice',
          item: action,
          headers: new Headers({ referer: REFERER }),
        }),
      expected: { kind: 'redirect', location: REFERER },
    },
    {
      action,
      who: 'an anonymous user',
      req: () => anonymousRequest({ circuit: 'cwebservice', item: action }),
      expected: { kind: 'redirect', location: expect.stringContaining('muraAction=cLogin.main') as unknown },
    },
  ]);

  it.each(secured)('secures $action for $who', async ({ action, req, expected }) => {
    const request = req();

    const decision = await decide(action, request);

    expect(decision).toEqual(secure(request));
    expect(decision).toEqual(expected);
  });
});

describe('grant types', () => {
  it.each(['client_credentials', 'authorization_code', 'password'])('keeps the stored %s', (stored) => {
    expect(effectiveGrantType(stored)).toBe(stored);
  });

  it('labels an unknown grant type Basic', () => {
    expect(authModeLabel('custom')).toBe('Basic');
  });
});

describe('cwebservice.list page', () => {
  it('renders the header, the add link and one grid table', async () => {
    const { html, $ } = await renderList(listRequest(), listRoutes(oauthClientRows));

    expect(domModel(html).headings).toContain('Web Services');
    const add = $('.mura-header .nav-module-specific a.btn');
    expect(add.attr('href')).toBe(ADD_HREF);
    expect(add.text().trim()).toBe('Add New Web Service');
    expect($('table.mura-table-grid')).toHaveLength(1);
    expect($('table.mura-table-grid thead th').toArray().map((th) => $(th).text().trim())).toEqual([
      '',
      'Name',
      'Auth Mode',
      'Last Update',
    ]);
  });

  it("renders a row per client in identity's order", async () => {
    const req = listRequest();

    const { html } = await renderList(req, listRoutes(oauthClientRows));
    const { tables } = domModel(html);

    expect(oauthClientRows.map(({ clientid }) => clientid)).toEqual([
      OAUTH_CLIENT_IDS.clientCredentials,
      OAUTH_CLIENT_IDS.basic,
      OAUTH_CLIENT_IDS.authorizationCode,
    ]);
    expect(tables).toEqual([
      {
        headers: ['', 'Name', 'Auth Mode', 'Last Update'],
        rows: oauthClientRows.map((client) => [
          'Edit Delete',
          client.name,
          authModeLabel(effectiveGrantType(client.granttype)),
          lastUpdateText(req, client.lastupdate),
        ]),
      },
    ]);
    expect(tables[0]?.rows.map((row) => row[2])).toEqual([
      'OAuth2 (client_credentials)',
      'Basic',
      'OAuth2 (authorization_code)',
    ]);
  });

  it('links each row to edit and to a CSRF-guarded delete', async () => {
    const { $ } = await renderList(listRequest(), listRoutes(oauthClientRows));
    const rows = $('table.mura-table-grid tbody tr').toArray();

    expect(rows).toHaveLength(oauthClientRows.length);
    rows.forEach((tr, index) => {
      const { clientid, name } = oauthClientRows[index] as WebServiceClient;
      const nameLink = $(tr).find('td.var-width a');
      const editLink = $(tr).find('li.edit a');
      const deleteLink = $(tr).find('li.delete a');

      expect({ title: nameLink.attr('title'), href: nameLink.attr('href'), text: nameLink.text() }).toEqual({
        title: 'Edit',
        href: editHref(clientid),
        text: name,
      });
      expect({ href: editLink.attr('href'), text: editLink.text() }).toEqual({
        href: editHref(clientid),
        text: 'Edit',
      });
      expect({
        href: deleteLink.attr('href'),
        onclick: deleteLink.attr('onclick'),
        text: deleteLink.text(),
      }).toEqual({
        href: deleteHref(clientid),
        onclick: "return confirmDialog('Delete Web Service?',this.href)",
        text: 'Delete',
      });
    });
  });

  it('issues CSRF tokens once per client', async () => {
    const { gateway } = await renderList(listRequest(), listRoutes(oauthClientRows));

    const contexts = gateway.calls
      .filter(({ service, method, path }) => service === 'identity' && method === 'POST' && path === CSRF_PATH)
      .flatMap(({ json }) => (json as { readonly contexts: readonly string[] }).contexts);

    for (const { clientid } of oauthClientRows) {
      expect(contexts.filter((context) => context === clientid)).toHaveLength(1);
    }
  });

  it("lists the session site's clients through identity", async () => {
    const { gateway } = await renderList(listRequest(), listRoutes(oauthClientRows));

    expect(gateway.calls.filter(({ path }) => path === LIST_PATH)).toEqual([
      { service: 'identity', method: 'GET', path: LIST_PATH, query: { siteid: SITE, offset: '0', limit: '1000' } },
    ]);
  });

  it.each([
    { site: 'a site without SSL', req: () => listRequest(), shown: true },
    { site: 'a site set to use SSL', req: () => listRequest({ site: { record: { useSSL: 1 } } }), shown: false },
  ])('shows the SSL alert as legacy does on $site', async ({ req, shown }) => {
    const { html } = await renderList(req(), listRoutes(oauthClientRows));

    const { alerts } = domModel(html);

    if (shown) expect(alerts).toContainEqual(SSL_ALERT);
    else expect(alerts).not.toContainEqual(SSL_ALERT);
  });

  it('renders the empty notice without a table', async () => {
    const { html, $ } = await renderList(listRequest(), listRoutes(emptyOAuthClients));

    expect(
      $('.help-block-empty')
        .toArray()
        .map((el) => $(el).text()),
    ).toEqual([EMPTY_NOTICE]);
    expect(domModel(html).tables).toEqual([]);
    expect($('.nav-module-specific a.btn').attr('href')).toBe(ADD_HREF);
    expect($('.nav-module-specific a.btn').text().trim()).toBe('Add New Web Service');
  });

  it.each([
    {
      who: 'the tenant-a site admin',
      req: () => siteAdminRequest('tenant-a', { circuit: 'cwebservice', item: 'list' }),
    },
    { who: 'an anonymous user', req: () => anonymousRequest({ circuit: 'cwebservice', item: 'list' }) },
  ])('secures $who before identity is listed', async ({ req }) => {
    const request = req();
    const ctx = makeScreenContext({ req: request, gateway: fakeGatewayClient(listRoutes(oauthClientRows)) });

    await expect(renderScreenPage(listPage(), ctx)).resolves.toEqual(secure(request));
    expect(ctx.gateway.calls.filter(({ path }) => path === LIST_PATH)).toEqual([]);
  });

  it('propagates an unavailable gateway', async () => {
    const ctx = makeScreenContext({ req: listRequest(), gateway: fakeGatewayClient(listRoutes(oauthClientRows)) });
    ctx.gateway.failWith();

    await expect(renderScreenPage(listPage(), ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it.each([401, 403] as const)('answers an identity %i with the access gate', async (status) => {
    const routes = { [routeKey('GET', 'identity', LIST_PATH)]: { status, body: {} } };
    const ctx = makeScreenContext({ req: listRequest(), gateway: fakeGatewayClient(routes) });

    await expect(renderScreenPage(listPage(), ctx)).resolves.toEqual(deniedGate(status));
  });
});
