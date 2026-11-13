// cwebservice edit, save and before() screens against admin/core/controllers/cwebservice.cfc and edit.cfm.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfUuid } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/people';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  CWEBSERVICE_RC_DEFAULTS,
  applyCwebserviceDefaults,
  cwebserviceGate,
  cwebserviceScreens,
} from '@/screens/cwebservice';
import { loadEditState, renderEditView, type WebServiceEditState } from '@/screens/cwebservice/edit';
import { submitSave } from '@/screens/cwebservice/save';
import type { PageScreen, RedirectScreen, ScreenContext } from '@/screens/registry';
import {
  OAUTH_CLIENT_IDS,
  existingClientEdit,
  newClientEdit,
  oauthClients,
  saveErrors,
} from '../../fixtures/identity/oauth-clients';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request, anonymousRequest, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRoute,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// A new client id is a random CF UUID; the spy lets a test pin the one the loader draws.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

type UserListRow = components['schemas']['UserListRow'];

const SITE = 'default';
const STORED = OAUTH_CLIENT_IDS.clientCredentials;
const UNSAVED = '0A000000-0000-0000-00000000000000FF';
const REST_ENDPOINT = 'http://localhost/_api/rest/v1/default';
const LIST_REDIRECT = { kind: 'redirect', action: 'cwebservice.list', append: 'siteid', path: './' } as const;
const URL_TOKENS = `&${CSRF_FIELD_TOKEN}=${FIXED_CSRF.token}&${CSRF_FIELD_EXPIRES}=${FIXED_CSRF.expires}`;

const clientPath = (clientid: string): ServicePath => `/v1/oauth-clients/${clientid}`;
const USERS_ROUTE = routeKey('GET', 'people', '/v2/users');

/** People's private-pool accounts as one `listUsersV2` page. */
const ACCOUNTS: readonly UserListRow[] = [
  { UserID: USER_IDS.admin, Fname: 'Admin', Lname: 'User' },
  { UserID: USER_IDS.qaEditor, Fname: ' QA ', Lname: null },
];

/** `listUsersV2` answering the 1000-row page `startrow` names over `rows`. */
function usersPage(rows: readonly UserListRow[]): FakeRoute {
  return (request) => {
    const page = Number(request.query.startrow);
    const numberofpages = Math.max(1, Math.ceil(rows.length / 1000));
    const items = rows.slice((page - 1) * 1000, page * 1000);
    const nextn = {
      totalrecords: rows.length,
      recordsperpage: 1000,
      numberofpages,
      currentpagenumber: page,
      firstpage: 1,
      lastpage: numberofpages,
      next: page < numberofpages ? page * 1000 + 1 : 1,
      previous: Math.max(1, (page - 2) * 1000 + 1),
      through: Math.min(rows.length, page * 1000),
      startrow: (page - 1) * 1000 + 1,
    };
    return { status: 200, body: { items, nextn, listUnassignedUsers: [] } };
  };
}

/** The S2 admin on `cwebservice.<item>` of `default` with `rc`. */
const adminOn = (item: string, rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  adminS2Request({ circuit: 'cwebservice', item, rc });

/** A context whose people lists {@link ACCOUNTS} and whose identity answers `routes`. */
function contextFor(
  req: AdminRequest,
  routes: Readonly<Record<string, FakeRoute>> = {},
): ScreenContext & {
  gateway: FakeGatewayClient;
} {
  return makeScreenContext({ req, gateway: fakeGatewayClient({ [USERS_ROUTE]: usersPage(ACCOUNTS), ...routes }) });
}

function pageOf(action: string): PageScreen<unknown> {
  const def = cwebserviceScreens.find((candidate) => candidate.action === action);
  if (def === undefined || def.mode !== 'page') throw new Error(`cwebservice.${action} is not a registered page`);
  return def;
}

const caught = (promise: Promise<unknown>): Promise<unknown> => promise.catch((error: unknown) => error);

const STORED_STATE: WebServiceEditState = {
  clientid: STORED,
  clientsecret: 'fixture-secret-not-real-0001',
  siteid: SITE,
  name: 'Fixture REST Client',
  description: 'Synthetic client for REST access with client credentials.',
  granttype: 'client_credentials',
  userid: USER_IDS.admin,
  redirecturl: '',
  exists: true,
};

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
  // The endpoint's host part follows the legacy settings, so each test starts from the defaults without the index file.
  for (const name of ['MURA_PORT', 'MURA_CONTEXT', 'MURA_INDEXFILEINURLS']) vi.stubEnv(name, undefined);
  vi.stubEnv('MURA_INDEXFILEINAPI', 'false');
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  restore();
});

describe('cwebservice before()', () => {
  it.each<[string, () => AdminRequest, boolean]>([
    ['the S2 admin', () => adminOn('list'), true],
    ['the tenant-a site admin', () => siteAdminRequest('tenant-a', { circuit: 'cwebservice', item: 'list' }), false],
    ['the editor', () => editorRequest({ circuit: 'cwebservice', item: 'list' }), false],
  ])('decides for %s', (_who, request, allowed) => {
    const secure = vi.fn(() => ({ kind: 'redirect', location: './' }) as const);

    expect(cwebserviceGate(request(), { secure })).toEqual(
      allowed ? { kind: 'allow' } : { kind: 'redirect', location: './' },
    );
    expect(secure).toHaveBeenCalledTimes(allowed ? 0 : 1);
  });

  it('adds each param default the rc lacks in any case, granttype defaulting to basic', () => {
    const rc = applyCwebserviceDefaults({ siteid: SITE, ClientID: STORED, GRANTTYPE: 'implicit' });

    expect(rc).toMatchObject({ ...CWEBSERVICE_RC_DEFAULTS, siteid: SITE, clientid: STORED, granttype: 'implicit' });
    expect(applyCwebserviceDefaults({}).granttype).toBe('basic');
  });

  it('loads the list on the before() defaults', async () => {
    const ctx = contextFor(adminOn('list'), {
      [routeKey('GET', 'identity', '/v1/oauth-clients')]: {
        status: 200,
        body: { items: oauthClients, total: 3, nextOffset: null },
      },
    });

    await expect(pageOf('list').load?.(ctx)).resolves.toEqual({ clients: oauthClients });
    expect(ctx.req.rc).toMatchObject({ ...CWEBSERVICE_RC_DEFAULTS, siteid: SITE });
  });

  it('relays delete on the before() defaults, then redirects to the list', async () => {
    const ctx = contextFor(
      adminOn('delete', { clientid: STORED, [CSRF_FIELD_TOKEN]: 'T', [CSRF_FIELD_EXPIRES]: 'E' }),
      {
        [routeKey('DELETE', 'identity', clientPath(STORED))]: { status: 200, body: { deleted: true } },
      },
    );
    const def = cwebserviceScreens.find((candidate) => candidate.action === 'delete') as RedirectScreen;

    await expect(def.submit(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls).toEqual([
      expect.objectContaining({
        service: 'identity',
        method: 'DELETE',
        path: clientPath(STORED),
        query: { siteid: SITE },
        form: { [CSRF_FIELD_TOKEN]: 'T', [CSRF_FIELD_EXPIRES]: 'E' },
      }),
    ]);
  });
});

describe('loadEditState', () => {
  it("reads a stored client of rc.siteid, its NULL columns as ''", async () => {
    const basic = oauthClients[1];
    const ctx = contextFor(adminOn('edit', { clientid: OAUTH_CLIENT_IDS.basic }), {
      [routeKey('GET', 'identity', clientPath(OAUTH_CLIENT_IDS.basic))]: {
        status: 200,
        body: { client: basic, exists: true },
      },
    });

    await expect(loadEditState(ctx)).resolves.toEqual({
      clientid: OAUTH_CLIENT_IDS.basic,
      clientsecret: 'fixture-secret-not-real-0002',
      siteid: SITE,
      name: 'Fixture Basic Client',
      description: '',
      granttype: 'basic',
      userid: USER_IDS.qaEditor,
      redirecturl: '',
      exists: true,
    });
    expect(ctx.gateway.calls).toEqual([
      { service: 'identity', method: 'GET', path: clientPath(OAUTH_CLIENT_IDS.basic), query: { siteid: SITE } },
    ]);
  });

  it('reads a stored client without a grant type as client_credentials', async () => {
    const ctx = contextFor(adminOn('edit', { clientid: STORED }), {
      [routeKey('GET', 'identity', clientPath(STORED))]: {
        status: 200,
        body: { ...existingClientEdit, client: { ...existingClientEdit.client, granttype: null } },
      },
    });

    await expect(loadEditState(ctx)).resolves.toEqual(STORED_STATE);
  });

  it.each<[string, FakeReply]>([
    ['identity finds no stored client', { status: 200, body: newClientEdit }],
    ['the id is no CF UUID (400)', { status: 400, body: {} }],
    ['the client is unknown (404)', { status: 404, body: {} }],
  ])('loads a new bean with the id and site set when %s', async (_when, reply) => {
    const ctx = contextFor(adminOn('edit', { clientid: UNSAVED }), {
      [routeKey('GET', 'identity', clientPath(UNSAVED))]: reply,
    });

    await expect(loadEditState(ctx)).resolves.toEqual({
      clientid: UNSAVED,
      clientsecret: '',
      siteid: SITE,
      name: '',
      description: '',
      granttype: 'basic',
      userid: '',
      redirecturl: '',
      exists: false,
    });
  });

  it("draws a fresh CF UUID for an empty rc.clientid and leaves an empty site to the token's", async () => {
    vi.mocked(cfUuid).mockReturnValueOnce(UNSAVED);
    const ctx = contextFor(adminOn('edit', { clientid: '', siteid: '' }));

    await expect(loadEditState(ctx)).resolves.toMatchObject({ clientid: UNSAVED, siteid: '', exists: false });
    expect(ctx.gateway.calls).toEqual([{ service: 'identity', method: 'GET', path: clientPath(UNSAVED) }]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const ctx = contextFor(adminOn('edit', { clientid: STORED }), {
      [routeKey('GET', 'identity', clientPath(STORED))]: { status, body: {} },
    });

    const error = await caught(loadEditState(ctx));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'identity', operation: 'getOAuthClient', status });
  });

  it('fails closed when identity is unavailable', async () => {
    const ctx = contextFor(adminOn('edit', { clientid: STORED }), {
      [routeKey('GET', 'identity', clientPath(STORED))]: { status: 503, body: {} },
    });

    await expect(loadEditState(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('renderEditView', () => {
  async function render(state: WebServiceEditState, req: AdminRequest = adminOn('edit', { clientid: state.clientid })) {
    const ctx = contextFor(req);
    return toString((await renderEditView(ctx, state)).body);
  }

  it('shows a stored client with its REST endpoints, Basic header, token link and delete action', async () => {
    const markup = await render(STORED_STATE);
    const model = fragmentModel(markup);
    const basic = Buffer.from(`${STORED}:fixture-secret-not-real-0001`, 'utf8').toString('base64');

    expect(model.headings).toEqual(['Edit Web Service']);
    expect(model.links.map(({ text }) => text)).toEqual([
      'Back to Web Services',
      'Generate Access Token',
      REST_ENDPOINT,
      `${REST_ENDPOINT}/oauth2`,
      `${REST_ENDPOINT}/oauth2?grant_type=client_credentials&client_id=${STORED}&client_secretfixture-secret-not-real-0001`,
    ]);
    expect(cheerio.load(markup, null, false).root().text()).toContain(`Authorization: Basic ${basic}`);
    expect(model.controls.find(({ name }) => name === 'granttype')?.selected).toEqual(['client_credentials']);
    expect(model.controls.find(({ name }) => name === 'userid')?.options).toEqual([
      { value: '', label: '-- Select Account --', selected: false },
      { value: USER_IDS.admin, label: 'Admin User', selected: true },
      { value: USER_IDS.qaEditor, label: 'QA', selected: false },
    ]);
    expect(model.buttons.map(({ text }) => text)).toEqual(['Delete', 'Update']);
    expect(markup).toContain(
      `onclick="confirmDialog('Delete Web Service?','./?muraAction=cwebservice.delete&clientid=${STORED}&siteid=${SITE}${URL_TOKENS}');"`,
    );
    expect(model.alerts).toEqual([
      {
        text: 'IMPORTANT: When using web services in production this site should be set to use SSL (HTTPS).',
        className: 'alert alert-error',
      },
    ]);
  });

  it('shows a new client with Add only and no endpoints or token link', async () => {
    const markup = await render({ ...STORED_STATE, clientid: UNSAVED, granttype: 'basic', exists: false });
    const model = fragmentModel(markup);

    expect(model.headings).toEqual(['Add Web Service']);
    expect(model.links.map(({ text }) => text)).toEqual(['Back to Web Services']);
    expect(model.buttons.map(({ text }) => text)).toEqual(['Add']);
    expect(markup).not.toContain('Authorization: Basic');
  });

  it('omits the token link for a stored client of another grant type', async () => {
    const markup = await render({
      ...STORED_STATE,
      granttype: 'authorization_code',
      redirecturl: 'https://example.com/cb',
    });

    expect(fragmentModel(markup).links.map(({ text }) => text)).not.toContain('Generate Access Token');
    expect(fragmentModel(markup).controls.find(({ name }) => name === 'redirectURL')?.value).toBe(
      'https://example.com/cb',
    );
  });

  it("lists the bean's messages HTML-encoded, skipping siteID while counting it for the <br> separators", async () => {
    const errors = { name: 'Name <required>', siteID: 'Site missing', granttype: 'Bad grant' };
    const markup = await render({ ...STORED_STATE, errors });

    expect(markup).toContain(
      '<div class="alert alert-error"><span> Name &lt;required&gt; <br> Bad grant </span></div>',
    );
    expect(markup).not.toContain('Site missing');
  });

  it('drops the SSL warning on a site set to use SSL', async () => {
    const req = adminS2Request({
      circuit: 'cwebservice',
      item: 'edit',
      rc: { clientid: STORED },
      site: { record: { useSSL: 1 } },
    });
    const model = fragmentModel(await render(STORED_STATE, req));

    expect(model.alerts).toEqual([]);
    expect(model.links.find(({ text }) => text.endsWith('/_api/rest/v1/default'))?.text).toBe(
      'https://localhost/_api/rest/v1/default',
    );
  });

  it.each<[string, Record<string, string | undefined>, string]>([
    [
      'the index file when the API URLs carry it',
      { MURA_INDEXFILEINAPI: 'true' },
      'http://localhost/index.cfm/_api/rest/v1/default',
    ],
    [
      'the configured port and context',
      { MURA_PORT: '8888', MURA_CONTEXT: '/cms' },
      'http://localhost:8888/cms/_api/rest/v1/default',
    ],
  ])('builds the endpoint with %s', async (_label, env, endpoint) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    resetLegacySettingsForTests();

    expect(fragmentModel(await render(STORED_STATE)).links[2]?.text).toBe(endpoint);
  });

  it('builds the endpoint from the request host and rc.siteid when no site data is served', async () => {
    const req: AdminRequest = { ...adminOn('edit', { clientid: STORED }), site: undefined, https: true };

    expect(fragmentModel(await render(STORED_STATE, req)).links[2]?.text).toBe(
      'https://localhost/_api/rest/v1/default',
    );
  });
});

describe('cwebservice.edit page', () => {
  const editRoute = { [routeKey('GET', 'identity', clientPath(STORED))]: { status: 200, body: existingClientEdit } };

  it('renders the stored client in the shell for the S2 admin, on the before() defaults', async () => {
    const ctx = contextFor(adminOn('edit', { clientid: STORED }), editRoute);

    const page = await renderScreenPage(pageOf('edit'), ctx);

    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    expect(page.html).toContain('<h1>Edit Web Service</h1>');
    expect(page.html).toContain(`<input type=hidden id="clientid" name="clientid" value="${STORED}">`);
    expect(ctx.req.rc).toMatchObject({ ...CWEBSERVICE_RC_DEFAULTS, clientid: STORED, siteid: SITE });
  });

  it.each<[string, () => AdminRequest, RegExp]>([
    [
      'the tenant-a site admin',
      () => siteAdminRequest('tenant-a', { circuit: 'cwebservice', item: 'edit', rc: { clientid: STORED } }),
      /^\.\/$/,
    ],
    [
      'an anonymous user',
      () => anonymousRequest({ circuit: 'cwebservice', item: 'edit', rc: { clientid: STORED } }),
      /^\.\/\?muraAction=cLogin\.main&returnURL=/,
    ],
  ])('secures %s before identity is read', async (_who, request, location) => {
    const ctx = contextFor(request(), editRoute);

    const page = await renderScreenPage(pageOf('edit'), ctx);

    expect(page.kind === 'redirect' ? page.location : page.kind).toMatch(location);
    expect(ctx.gateway.calls.filter(({ path }) => path === clientPath(STORED))).toEqual([]);
  });

  it('answers an identity 403 with cMessage.noaccess', async () => {
    const ctx = contextFor(adminOn('edit', { clientid: STORED }), {
      [routeKey('GET', 'identity', clientPath(STORED))]: { status: 403, body: {} },
    });

    await expect(renderScreenPage(pageOf('edit'), ctx)).resolves.toEqual({
      kind: 'redirect',
      location: '/admin/?muraAction=cMessage.noaccess',
    });
  });
});

describe('cwebservice.save', () => {
  const FORM = {
    clientid: STORED,
    name: 'Renamed <client>',
    description: 'New description',
    granttype: 'client_credentials',
    userid: USER_IDS.admin,
    redirecturl: '',
    clientsecret: 'fixture-secret-not-real-0001',
    [CSRF_FIELD_TOKEN]: 'T',
    [CSRF_FIELD_EXPIRES]: 'E',
  };
  const saved = (errors: Readonly<Record<string, string>>): FakeReply => ({
    status: 200,
    body: { written: Object.keys(errors).length === 0, client: existingClientEdit.client, errors },
  });
  const saveRoutes = (reply: FakeReply) => ({
    [routeKey('PUT', 'identity', clientPath(STORED))]: reply,
    [routeKey('GET', 'identity', clientPath(STORED))]: { status: 200, body: existingClientEdit },
  });

  it("relays the fields set(rc) applies under identity's names, then redirects to the list", async () => {
    const ctx = contextFor(adminOn('save', FORM), saveRoutes(saved({})));

    await expect(submitSave(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls).toEqual([
      {
        service: 'identity',
        method: 'PUT',
        path: clientPath(STORED),
        form: {
          siteid: SITE,
          name: 'Renamed <client>',
          description: 'New description',
          granttype: 'client_credentials',
          userid: USER_IDS.admin,
          redirectURL: '',
          clientsecret: 'fixture-secret-not-real-0001',
          [CSRF_FIELD_TOKEN]: 'T',
          [CSRF_FIELD_EXPIRES]: 'E',
        },
      },
    ]);
  });

  it('sends only the fields rc carries, so identity keeps the stored values of the others', async () => {
    const ctx = contextFor(adminOn('save', { clientid: STORED, name: 'Only name' }), saveRoutes(saved({})));

    await expect(submitSave(ctx)).resolves.toEqual(LIST_REDIRECT);
    expect(ctx.gateway.calls[0]?.form).toEqual({ siteid: SITE, name: 'Only name' });
  });

  it("redirects to the list on the session's site without saving when rc has no siteid", async () => {
    const base = adminOn('save', FORM);
    const rc = Object.fromEntries(Object.entries(base.rc).filter(([name]) => name.toLowerCase() !== 'siteid'));
    const ctx = contextFor({ ...base, rc }, saveRoutes(saved({})));

    await expect(submitSave(ctx)).resolves.toEqual({ ...LIST_REDIRECT, rc: { siteid: SITE } });
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('re-renders the form with the posted values and the errors identity reports', async () => {
    const ctx = contextFor(adminOn('save', FORM), saveRoutes(saved(saveErrors)));

    const outcome = await submitSave(ctx);

    expect(outcome.kind).toBe('render');
    if (outcome.kind !== 'render') return;
    const markup = toString(outcome.view.body);
    const model = fragmentModel(markup);
    expect(model.headings).toEqual(['Edit Web Service']);
    expect(model.controls.find(({ name }) => name === 'name')?.value).toBe('Renamed <client>');
    expect(model.alerts[0]).toEqual({ text: "The property named 'name' is not valid", className: 'alert alert-error' });
    expect(ctx.gateway.calls.map(({ method, service }) => `${service} ${method}`)).toEqual([
      'identity PUT',
      'identity GET',
      'people GET',
      'identity POST',
    ]);
  });

  it.each([401, 403] as const)('raises GatewayDenialError for HTTP %i', async (status) => {
    const error = await caught(submitSave(contextFor(adminOn('save', FORM), saveRoutes({ status, body: {} }))));

    expect(error).toBeInstanceOf(GatewayDenialError);
    expect(error).toMatchObject({ service: 'identity', operation: 'saveOAuthClient', status });
  });

  it('fails on a rejected request', async () => {
    await expect(submitSave(contextFor(adminOn('save', FORM), saveRoutes({ status: 400, body: {} })))).rejects.toThrow(
      'saveOAuthClient answered HTTP 400',
    );
  });

  describe('as the registered page', () => {
    const save = (): PageScreen<unknown> => pageOf('save');

    it('answers the list redirect from its controller step when identity reports no errors', async () => {
      const ctx = contextFor(adminOn('save', FORM), saveRoutes(saved({})));

      await expect(save().redirect?.(ctx)).resolves.toEqual(LIST_REDIRECT);
      expect(ctx.req.rc).toMatchObject({ ...CWEBSERVICE_RC_DEFAULTS, ...FORM });
    });

    it('renders the re-rendered form its controller step kept, inside the shell', async () => {
      const ctx = contextFor(adminOn('save', FORM), saveRoutes(saved(saveErrors)));

      const page = await renderScreenPage(save(), ctx);

      expect(page.kind).toBe('document');
      if (page.kind !== 'document') return;
      expect(domModel(page.html).alerts).toContainEqual({
        text: "The property named 'name' is not valid",
        className: 'alert alert-error',
      });
    });

    it('refuses to render without a view from its controller step', () => {
      const ctx = contextFor(adminOn('save', FORM));

      expect(() => save().render(ctx, undefined)).toThrow(
        'cwebservice.save rendered without a view from its controller step',
      );
    });

    it('secures a non-S2 user before identity is written', async () => {
      const ctx = contextFor(editorRequest({ circuit: 'cwebservice', item: 'save', rc: FORM }), saveRoutes(saved({})));

      await expect(renderScreenPage(save(), ctx)).resolves.toEqual({ kind: 'redirect', location: './' });
      expect(ctx.gateway.calls.filter(({ method }) => method === 'PUT')).toEqual([]);
    });
  });
});
