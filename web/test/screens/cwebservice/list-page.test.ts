// cwebservice.list against legacy cwebservice/list.cfm: the session site's OAuth clients from identity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  authModeLabel,
  effectiveGrantType,
  listScreen,
  loadList,
  renderList,
  type WebServiceClient,
} from '@/screens/cwebservice/list';
import type { ScreenContext } from '@/screens/registry';
import { CSRF_CWEBSERVICE } from '../../fixtures/identity/csrf';
import { oauthClientRows } from '../../fixtures/identity/oauth-clients';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

type IssuedCsrfToken = components['schemas']['CsrfTokenSet']['tokens'][number];

const LIST_PATH = '/v1/oauth-clients';
const LIST_ROUTE = routeKey('GET', 'identity', LIST_PATH);
const CSRF_PATH = '/v1/csrf/tokens';
const CSRF_ROUTE = routeKey('POST', 'identity', CSRF_PATH);

const SSL_ALERT = {
  text: 'When using web services in production, this site should be set to use SSL (HTTPS).',
  className: 'alert alert-error',
};
const EMPTY_NOTICE =
  '<div class="help-block-empty">There currently are no web services configured for this site.</div>';
const SHOW_ACTIONS =
  '<a class="show-actions" href="javascript:;"  onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>';

const CREDENTIALS_CLIENT: WebServiceClient = {
  clientid: CSRF_CWEBSERVICE.context,
  siteid: 'default',
  name: 'Reporting <Feed> & Co',
  granttype: 'client_credentials',
  lastupdate: '2026-10-29T15:45:07.000',
};

const BASIC_CLIENT: WebServiceClient = {
  clientid: '0A000000-0000-0000-0000000000000002',
  siteid: 'default',
  name: 'Legacy Basic',
  granttype: 'basic',
  lastupdate: null,
};

const CSRF_BASIC: IssuedCsrfToken = {
  context: BASIC_CLIENT.clientid,
  csrf_token: '0000000000000000000000000000000000000000000000000000000000000008',
  csrf_token_expires: CSRF_CWEBSERVICE.csrf_token_expires,
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

/** `req` with no `siteid` in rc. */
function withoutRcSiteId(req: AdminRequest): AdminRequest {
  const rc = Object.fromEntries(Object.entries(req.rc).filter(([name]) => name.toLowerCase() !== 'siteid'));
  return { ...req, rc };
}

/** A gateway whose identity issues the CSRF pairs of both clients. */
function csrfGateway(): FakeGatewayClient {
  return fakeGatewayClient({ [CSRF_ROUTE]: { status: 200, body: { tokens: [CSRF_CWEBSERVICE, CSRF_BASIC] } } });
}

const addLink = (siteParam: string): string =>
  `<a class="btn" href="./?muraAction=cwebservice.edit&clientid=&siteid=&${siteParam}">` +
  '<i class="mi-plus-circle"></i> Add New Web Service</a>';

const editHref = (clientid: string, siteParam: string): string =>
  `./?muraAction=cwebservice.edit&clientid=${clientid}&siteid=${siteParam}`;

const deleteLink = (clientid: string, siteParam: string, pair: IssuedCsrfToken): string =>
  `<a href="./?muraAction=cwebservice.delete&clientid=${clientid}&siteid=${siteParam}` +
  `&csrf_token=${pair.csrf_token}&csrf_token_expires=${pair.csrf_token_expires}"` +
  ` onClick="return confirmDialog('Delete Web Service?',this.href)"><i class="mi-trash"></i>Delete</a>`;

describe('cwebservice.list', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('is a frozen page screen over loadList and renderList', () => {
    expect(listScreen).toEqual({ mode: 'page', load: loadList, render: renderList });
    expect(Object.isFrozen(listScreen)).toBe(true);
  });

  describe('effectiveGrantType', () => {
    it.each([
      { stored: null, expected: 'client_credentials' },
      { stored: undefined, expected: 'client_credentials' },
      { stored: '', expected: 'client_credentials' },
      { stored: 'basic', expected: 'basic' },
      { stored: 'implicit', expected: 'implicit' },
    ])('reads $stored as $expected', ({ stored, expected }) => {
      expect(effectiveGrantType(stored)).toBe(expected);
    });
  });

  describe('authModeLabel', () => {
    it.each([
      { grantType: 'client_credentials', expected: 'OAuth2 (client_credentials)' },
      { grantType: 'authorization_code', expected: 'OAuth2 (authorization_code)' },
      { grantType: 'implicit', expected: 'OAuth2 (implicit)' },
      { grantType: 'password', expected: 'OAuth2 (password)' },
      { grantType: 'Password', expected: 'OAuth2 (password)' },
      { grantType: 'basic', expected: 'Basic' },
      { grantType: '', expected: 'Basic' },
    ])('labels "$grantType" as $expected', ({ grantType, expected }) => {
      expect(authModeLabel(grantType)).toBe(expected);
    });
  });

  describe('loadList', () => {
    it("lists session.siteid's clients through identity in identity's order, as one window of 1000", async () => {
      const gateway = fakeGatewayClient({
        [LIST_ROUTE]: { status: 200, body: { items: [BASIC_CLIENT, CREDENTIALS_CLIENT], total: 2, nextOffset: null } },
      });
      const req = adminS2Request({
        circuit: 'cwebservice',
        item: 'list',
        session: { siteid: 'tenant-a' },
        rc: { siteid: 'default' },
      });

      await expect(loadList(contextFor(req, gateway))).resolves.toEqual({
        clients: [BASIC_CLIENT, CREDENTIALS_CLIENT],
      });
      expect(gateway.calls).toEqual([
        {
          service: 'identity',
          method: 'GET',
          path: LIST_PATH,
          query: { siteid: 'tenant-a', offset: '0', limit: '1000' },
        },
      ]);
    });

    it('lists only the first 1000 clients when the site holds more, as the legacy iterator shows them', async () => {
      const window = Array.from({ length: 1000 }, (_, n) => ({
        ...oauthClientRows[n % oauthClientRows.length],
        clientid: `0B000000-0000-0000-${String(n).padStart(16, '0')}`,
      }));
      const gateway = fakeGatewayClient({
        [LIST_ROUTE]: { status: 200, body: { items: window, total: 1003, nextOffset: 1000 } },
      });

      await expect(loadList(contextFor(adminS2Request(), gateway))).resolves.toEqual({ clients: window });
      expect(gateway.calls).toHaveLength(1);
    });

    it('lists no clients and calls nothing when the session has no site', async () => {
      const gateway = fakeGatewayClient();
      const req = adminS2Request({ circuit: 'cwebservice', item: 'list', session: { siteid: '' } });

      await expect(loadList(contextFor(req, gateway))).resolves.toEqual({ clients: [] });
      expect(gateway.calls).toEqual([]);
    });

    it.each([
      { outage: 'the gateway refusing the call', arrange: (gateway: FakeGatewayClient) => gateway.failWith() },
      {
        outage: 'a 503 answer',
        arrange: (gateway: FakeGatewayClient) => gateway.setRoute(LIST_ROUTE, { status: 503, body: {} }),
      },
    ])('propagates GatewayUnavailableError on $outage', async ({ arrange }) => {
      const gateway = fakeGatewayClient();
      arrange(gateway);

      await expect(loadList(contextFor(adminS2Request(), gateway))).rejects.toBeInstanceOf(GatewayUnavailableError);
    });

    it.each([
      { status: 401, type: GatewayDenialError, name: 'GatewayDenialError' },
      { status: 403, type: GatewayDenialError, name: 'GatewayDenialError' },
      { status: 500, type: Error, name: 'Error' },
    ])('rejects with $name when identity answers $status', async ({ status, type, name }) => {
      const gateway = fakeGatewayClient({ [LIST_ROUTE]: { status, body: {} } });

      const failure = await loadList(contextFor(adminS2Request(), gateway)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ name, message: `listOAuthClients answered HTTP ${status}` });
    });
  });

  describe('renderList', () => {
    it('renders the header and the empty-state notice without issuing CSRF tokens', async () => {
      const gateway = fakeGatewayClient();

      const view = await renderList(contextFor(adminS2Request(), gateway), { clients: [] });
      const body = toString(view.body);

      expect(Object.keys(view)).toEqual(['body']);
      expect(body).toContain(addLink('default'));
      expect(body).toContain(EMPTY_NOTICE);
      expect(fragmentModel(body)).toMatchObject({ headings: ['Web Services'], tables: [], alerts: [SSL_ALERT] });
      expect(gateway.calls).toEqual([]);
    });

    it.each([
      { site: 'useSSL 0', req: () => adminS2Request({ site: { record: { useSSL: 0 } } }), alerts: [SSL_ALERT] },
      { site: 'useSSL 1', req: () => adminS2Request({ site: { record: { useSSL: 1 } } }), alerts: [] },
      {
        site: 'useSSL NULL, ExtranetSSL 1',
        req: () => adminS2Request({ site: { record: { useSSL: null, ExtranetSSL: 1 } } }),
        alerts: [],
      },
      {
        site: 'useSSL NULL, ExtranetSSL 0',
        req: () => adminS2Request({ site: { record: { useSSL: null, ExtranetSSL: 0 } } }),
        alerts: [SSL_ALERT],
      },
      {
        site: 'useSSL 0, ExtranetSSL 1',
        req: () => adminS2Request({ site: { record: { useSSL: 0, ExtranetSSL: 1 } } }),
        alerts: [SSL_ALERT],
      },
      { site: 'no useSSL column', req: () => adminS2Request(), alerts: [SSL_ALERT] },
      { site: 'no site data', req: () => ({ ...adminS2Request(), site: undefined }), alerts: [SSL_ALERT] },
    ])('shows the SSL alert as legacy does for $site', async ({ req, alerts }) => {
      const view = await renderList(contextFor(req(), fakeGatewayClient()), { clients: [] });

      expect(fragmentModel(toString(view.body)).alerts).toEqual(alerts);
    });

    it('renders a row per client with edit and CSRF delete links, issuing tokens in one call', async () => {
      const gateway = csrfGateway();

      const view = await renderList(contextFor(adminS2Request(), gateway), {
        clients: [CREDENTIALS_CLIENT, BASIC_CLIENT],
      });
      const body = toString(view.body);

      expect(gateway.calls).toEqual([
        {
          service: 'identity',
          method: 'POST',
          path: CSRF_PATH,
          json: { contexts: [CREDENTIALS_CLIENT.clientid, BASIC_CLIENT.clientid] },
        },
      ]);
      expect(fragmentModel(body).tables).toEqual([
        {
          headers: ['', 'Name', 'Auth Mode', 'Last Update'],
          rows: [
            ['Edit Delete', 'Reporting <Feed> & Co', 'OAuth2 (client_credentials)', '10/302/2026 3:45:07 PM'],
            ['Edit Delete', 'Legacy Basic', 'Basic', ''],
          ],
        },
      ]);
      expect(body.split(SHOW_ACTIONS)).toHaveLength(3);
      for (const [client, pair] of [
        [CREDENTIALS_CLIENT, CSRF_CWEBSERVICE],
        [BASIC_CLIENT, CSRF_BASIC],
      ] as const) {
        expect(body).toContain(`<a href="${editHref(client.clientid, 'default')}"><i class="mi-pencil"></i>Edit</a>`);
        expect(body).toContain(deleteLink(client.clientid, 'default', pair));
      }
      expect(body).toContain(
        `<a title="Edit" href="${editHref(CREDENTIALS_CLIENT.clientid, 'default')}">` +
          'Reporting &lt;Feed&gt; &amp; Co</a>',
      );
      expect(body).not.toContain(EMPTY_NOTICE);
    });

    it.each([
      { locale: 'en_US', expected: '10/302/2026 3:45:07 PM' },
      { locale: 'de_DE', expected: '302.10.2026 15:45:07' },
    ])('formats Last Update under the $locale session date key', async ({ locale, expected }) => {
      const req = adminS2Request({ session: { locale } });

      const view = await renderList(contextFor(req, csrfGateway()), { clients: [CREDENTIALS_CLIENT] });

      expect(fragmentModel(toString(view.body)).tables[0]?.rows[0]?.[3]).toBe(expected);
    });

    it.each([
      { rc: 'siteid tenant-a', req: () => adminS2Request({ rc: { siteid: 'tenant-a' } }), siteParam: 'tenant-a' },
      { rc: 'no siteid', req: () => withoutRcSiteId(adminS2Request()), siteParam: '' },
      { rc: 'siteid "de fault"', req: () => adminS2Request({ rc: { siteid: 'de fault' } }), siteParam: 'de+fault' },
      { rc: 'siteid "a%b&c"', req: () => adminS2Request({ rc: { siteid: 'a%b&c' } }), siteParam: 'a%25b%26c' },
    ])('takes the link site id from rc with $rc', async ({ req, siteParam }) => {
      const view = await renderList(contextFor(req(), csrfGateway()), { clients: [CREDENTIALS_CLIENT] });
      const body = toString(view.body);

      expect(body).toContain(addLink(siteParam));
      expect(body).toContain(`<a href="${editHref(CREDENTIALS_CLIENT.clientid, siteParam)}">`);
      expect(body).toContain(deleteLink(CREDENTIALS_CLIENT.clientid, siteParam, CSRF_CWEBSERVICE));
    });

    it('rejects a last update that is not a date', async () => {
      const client: WebServiceClient = { ...CREDENTIALS_CLIENT, lastupdate: 'yesterday' };

      const failure = await renderList(contextFor(adminS2Request(), csrfGateway()), { clients: [client] }).catch(
        (e: unknown) => e,
      );

      expect(failure).toBeInstanceOf(RangeError);
      expect(failure).toMatchObject({ message: 'The value yesterday cannot be converted to a date.' });
    });

    it('propagates GatewayUnavailableError when CSRF issuance is unavailable', async () => {
      const gateway = csrfGateway();
      gateway.failWith();

      await expect(
        renderList(contextFor(adminS2Request(), gateway), { clients: [CREDENTIALS_CLIENT] }),
      ).rejects.toBeInstanceOf(GatewayUnavailableError);
    });
  });
});
