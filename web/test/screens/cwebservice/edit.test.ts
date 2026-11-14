import { cfUuid } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/identity';
import { encodeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cwebserviceScreens } from '@/screens/cwebservice';
import { loadEditState, renderEditView } from '@/screens/cwebservice/edit';
import { effectiveGrantType } from '@/screens/cwebservice/list';
import type { PageScreen } from '@/screens/registry';
import { CSRF_BY_CONTEXT, CSRF_CWEBSERVICE } from '../../fixtures/identity/csrf';
import {
  OAUTH_CLIENT_IDS,
  existingClientEdit,
  newClientEdit,
  oauthClients,
  saveErrors,
} from '../../fixtures/identity/oauth-clients';
import { PERSON_IDS, tenantASystemUsersPage } from '../../fixtures/people/user-list';
import { adminS2Request, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeRoute,
  type FakeRouteTable,
} from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

// A pass-through spy, so one test can pin the id a new client draws.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

type OAuthClientDetail = components['schemas']['OAuthClientDetail'];
type OAuthClient = OAuthClientDetail['client'];
type LegacyErrors = components['schemas']['LegacyErrors'];

const SITE = 'default';
const STORED = existingClientEdit.client;
const CSRF_PATH = '/v1/csrf/tokens';
const USERS_PATH = '/v2/users';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const BACK_HREF = './?muraAction=cwebservice.list&siteid=&default';
const SSL_ALERT = {
  text: 'IMPORTANT: When using web services in production this site should be set to use SSL (HTTPS).',
  className: 'alert alert-error',
};
const NEW_CLIENT_LABELS = ['Name', 'Description', 'Authorization Mode', 'Connected Account', 'Redirect_URI'];
const STORED_CLIENT_LABELS = [
  ...NEW_CLIENT_LABELS,
  'Endpoint',
  'OAuth Endpoint',
  'Username',
  'Password',
  'Basic Authentication Header',
  'client_id',
  'client_secret',
  'Example Usage of',
];
const GRANT_TYPES = [
  ['basic', 'Basic'],
  ['client_credentials', 'OAuth2 (client_credentials)'],
  ['authorization_code', 'OAuth2 (authorization_code)'],
  ['implicit', 'OAuth2 (implicit)'],
  ['password', 'OAuth2 (password)'],
] as const;

const clientPath = (clientid: string) => `/v1/oauth-clients/${clientid}` as const;

/** The fixture client with `clientid`. */
function fixtureClient(clientid: string): OAuthClient {
  const client = oauthClients.find((candidate) => candidate.clientid === clientid);
  if (client === undefined) throw new Error(`No fixture client ${clientid}`);
  return client;
}

/** identity `issueCsrfTokens`: each context's fixture pair, else the fixed pair. */
const issueTokens: FakeRoute = (request) => {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map(
    (context) =>
      CSRF_BY_CONTEXT[context] ?? { context, csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires },
  );
  return { status: 200, body: { tokens } };
};

/** identity serving each of `details` under its client id and the CSRF pairs; people listing tenant-a's system users. */
function editRoutes(...details: readonly OAuthClientDetail[]): FakeRouteTable {
  return {
    [routeKey('POST', 'identity', CSRF_PATH)]: issueTokens,
    [routeKey('GET', 'people', USERS_PATH)]: { status: 200, body: tenantASystemUsersPage },
    ...Object.fromEntries(
      details.map((detail) => [
        routeKey('GET', 'identity', clientPath(detail.client.clientid)),
        { status: 200, body: detail },
      ]),
    ),
  };
}

const editRequest = (clientid: string, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'cwebservice', item: 'edit', rc: { clientid, siteid: SITE } });

function editPage(): PageScreen<unknown> {
  const def = cwebserviceScreens.find(({ action }) => action === 'edit');
  if (def === undefined || def.mode !== 'page') throw new Error('cwebservice.edit is not a registered page');
  return def;
}

interface RenderedEdit {
  readonly $: cheerio.CheerioAPI;
  readonly page: DomModel;
  readonly header: DomModel;
  readonly form: DomModel;
  readonly gateway: FakeGatewayClient;
}

/** The edit page in the shell for `req` over `routes`, modelled whole, by its `.mura-header` and by `form1`. */
async function renderEdit(
  req: AdminRequest,
  routes: FakeRouteTable = editRoutes(existingClientEdit),
): Promise<RenderedEdit> {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(routes) });
  const page = await renderScreenPage(editPage(), ctx);
  if (page.kind !== 'document') throw new Error(`cwebservice.edit redirected to ${page.location}`);
  const $ = cheerio.load(page.html);
  return {
    $,
    page: domModel(page.html),
    header: fragmentModel($.html($('.mura-header:has(h1)'))),
    form: fragmentModel($.html($('form[name="form1"]'))),
    gateway: ctx.gateway,
  };
}

/** The form control named `name`. */
function control(model: DomModel, name: string): DomModel['controls'][number] {
  const found = model.controls.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`No control named ${name}`);
  return found;
}

/** The form1 control group whose label reads exactly `label`. */
function group($: cheerio.CheerioAPI, label: string) {
  return $('form[name="form1"] .mura-control-group').filter((_, el) => $(el).children('label').text() === label);
}

/** `markup` without the whitespace around its tags. */
const tagsTight = (markup: string): string => markup.replace(/\s*(<[^>]*>)\s*/g, '$1').trim();

/** The CSRF contexts identity was asked for. */
const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path === CSRF_PATH)
    .flatMap(({ json }) => (json as { contexts: string[] }).contexts);

/** The hidden clientid of form1. */
const hiddenClientId = ($: cheerio.CheerioAPI): string =>
  $('form[name="form1"] input[type="hidden"][name="clientid"]').attr('value') ?? '';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cwebservice.edit of a stored client', () => {
  it('heads Edit Web Service with the legacy back link', async () => {
    const { $, page, header } = await renderEdit(editRequest(STORED.clientid));
    const back = $('.mura-header a.btn').first();

    expect(page.headings).toContain('Edit Web Service');
    expect(header.headings).toEqual(['Edit Web Service']);
    expect(back.text().trim()).toBe('Back to Web Services');
    expect(back.attr('href')).toBe(BACK_HREF);
  });

  it.each<[string, boolean, OAuthClient]>([
    ['client_credentials', true, fixtureClient(OAUTH_CLIENT_IDS.clientCredentials)],
    ['basic', false, fixtureClient(OAUTH_CLIENT_IDS.basic)],
    ['authorization_code', false, fixtureClient(OAUTH_CLIENT_IDS.authorizationCode)],
  ])('selects the effective mode of grant type %s; Generate Access Token: %s', async (_grant, tokenLink, client) => {
    const { form, header } = await renderEdit(editRequest(client.clientid), editRoutes({ client, exists: true }));

    expect(header.links.map(({ text }) => text).includes('Generate Access Token')).toBe(tokenLink);
    expect(control(form, 'granttype').selected).toEqual([effectiveGrantType(client.granttype)]);
    expect(control(form, 'redirectURL').value).toBe(client.redirecturl ?? '');
    expect(control(form, 'description').value).toBe(client.description ?? '');
  });

  it('posts form1 to cwebservice.save without browser validation', async () => {
    const { $ } = await renderEdit(editRequest(STORED.clientid));
    const form = $('form[name="form1"]');

    expect(form).toHaveLength(1);
    expect(form.attr('action')).toBe('./?muraAction=cwebservice.save');
    expect(form.attr('method')).toBe('post');
    expect(form.is('[novalidate]')).toBe(true);
  });

  it('fills the controls from the stored client', async () => {
    const { $, form } = await renderEdit(editRequest(STORED.clientid));

    expect(control(form, 'name').value).toBe(STORED.name);
    expect($('form[name="form1"] input[name="name"]').attr('maxlength')).toBe('50');
    expect(control(form, 'description')).toMatchObject({ tag: 'textarea', value: STORED.description });
    expect(control(form, 'granttype').options).toEqual(
      GRANT_TYPES.map(([value, label]) => ({ value, label, selected: value === effectiveGrantType(STORED.granttype) })),
    );
    expect(control(form, 'redirectURL')).toMatchObject({ tag: 'textarea', value: STORED.redirecturl });
    expect(control(form, 'userid').selected).toEqual([]);
  });

  it("lists people's system users as Connected Accounts, the client's selected", async () => {
    const client = { ...STORED, userid: PERSON_IDS.samLee };
    const { form } = await renderEdit(editRequest(client.clientid), editRoutes({ client, exists: true }));

    expect(control(form, 'userid').options).toEqual([
      { value: '', label: '-- Select Account --', selected: false },
      ...tenantASystemUsersPage.items.map(({ UserID, Fname, Lname }) => ({
        value: UserID,
        label: `${Fname ?? ''} ${Lname ?? ''}`.trim(),
        selected: UserID === PERSON_IDS.samLee,
      })),
    ]);
  });

  it("reads the client and the site's system users through the gateway", async () => {
    const { gateway } = await renderEdit(editRequest(STORED.clientid));

    expect(gateway.calls.filter(({ path }) => path === clientPath(STORED.clientid))).toEqual([
      expect.objectContaining({ service: 'identity', query: { siteid: SITE } }),
    ]);
    const people = gateway.calls.filter(({ service }) => service === 'people');
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ path: USERS_PATH, query: { siteid: SITE, ispublic: '0' } });
  });

  it('labels every control group, endpoints and credentials included', async () => {
    const { page, form } = await renderEdit(editRequest(STORED.clientid));

    expect(form.labels).toEqual(STORED_CLIENT_LABELS);
    expect(page.labels).toEqual(expect.arrayContaining(STORED_CLIENT_LABELS));
  });

  it('shows the client id and secret as Basic and OAuth2 credentials', async () => {
    const { $ } = await renderEdit(editRequest(STORED.clientid));
    const shown = (label: string): string => group($, label).children('div').text().trim();
    const basic = Buffer.from(`${STORED.clientid}:${STORED.clientsecret}`).toString('base64');

    expect(shown('Username')).toBe(STORED.clientid);
    expect(shown('client_id')).toBe(STORED.clientid);
    expect(shown('Password')).toBe(STORED.clientsecret);
    expect(shown('client_secret')).toBe(STORED.clientsecret);
    expect(shown('Basic Authentication Header')).toBe(`Authorization: Basic ${basic}`);
  });

  it('links the REST and OAuth endpoints and the example token request, its text without client_secret=', async () => {
    const { $ } = await renderEdit(editRequest(STORED.clientid));
    const link = (label: string) => group($, label).find('a');
    const endpoint = link('Endpoint').attr('href') ?? '';
    const example = `/oauth2?grant_type=client_credentials&client_id=${STORED.clientid}`;

    expect(endpoint).toMatch(/\/_api\/rest\/v1\/default$/);
    expect(link('Endpoint').text()).toBe(endpoint);
    expect(link('OAuth Endpoint').attr('href')).toBe(`${endpoint}/oauth2`);
    expect(link('Example Usage of').attr('href')).toBe(`${endpoint}${example}&client_secret=${STORED.clientsecret}`);
    expect(link('Example Usage of').text()).toBe(`${endpoint}${example}&client_secret${STORED.clientsecret}`);
  });

  it("offers Delete with the client's URL CSRF pair and Update, never Add", async () => {
    const { $, form } = await renderEdit(editRequest(STORED.clientid));
    const onclick = $('form[name="form1"] button')
      .filter((_, el) => $(el).text().trim() === 'Delete')
      .attr('onclick');

    expect(form.buttons.map(({ text }) => text)).toEqual(['Delete', 'Update']);
    expect(onclick).toContain(
      `confirmDialog('Delete Web Service?','./?muraAction=cwebservice.delete&clientid=${STORED.clientid}` +
        `&siteid=${STORED.siteid}&csrf_token=${CSRF_CWEBSERVICE.csrf_token}` +
        `&csrf_token_expires=${CSRF_CWEBSERVICE.csrf_token_expires}')`,
    );
  });

  it("carries the bean's ids, secret and CSRF pair as hidden fields, in order", async () => {
    const { $ } = await renderEdit(editRequest(STORED.clientid));
    const hidden = $('form[name="form1"] input[type="hidden"]')
      .toArray()
      .map((el) => [$(el).attr('name'), $(el).attr('value')]);

    expect(hidden).toEqual([
      ['siteid', STORED.siteid],
      ['clientid', STORED.clientid],
      ['clientsecret', STORED.clientsecret],
      ['csrf_token', CSRF_CWEBSERVICE.csrf_token],
      ['csrf_token_expires', CSRF_CWEBSERVICE.csrf_token_expires],
    ]);
  });

  it.each<[string, AdminRequestPartial, readonly (typeof SSL_ALERT)[]]>([
    ['warns about SSL on a site without it', {}, [SSL_ALERT]],
    ['raises no error alert on a site using SSL', { site: { record: { useSSL: 1 } } }, []],
  ])('%s', async (_case, partial, alerts) => {
    const { page } = await renderEdit(editRequest(STORED.clientid, partial));

    expect(page.alerts.filter(({ className }) => className.split(' ').includes('alert-error'))).toEqual(alerts);
  });
});

describe('cwebservice.edit of a new client', () => {
  it("renders identity's defaulted client under the id drawn for an empty rc.clientid", async () => {
    const drawn = newClientEdit.client.clientid;
    vi.mocked(cfUuid).mockReturnValueOnce(drawn);
    const { $, page, header, form, gateway } = await renderEdit(editRequest(''), editRoutes(newClientEdit));

    expect(page.headings).toContain('Add Web Service');
    expect(header.headings).toEqual(['Add Web Service']);
    expect(header.links.map(({ text }) => text)).toEqual(['Back to Web Services']);
    expect(hiddenClientId($)).toBe(drawn);
    expect(gateway.calls.filter(({ path }) => path === clientPath(drawn))).toHaveLength(1);
    expect(csrfContexts(gateway)).toContain(drawn);
    expect(form.buttons.map(({ text }) => text)).toEqual(['Add']);
    expect(form.labels).toEqual(NEW_CLIENT_LABELS);
    expect(control(form, 'granttype').selected).toEqual(['basic']);
    expect(control(form, 'siteid').value).toBe(SITE);
    expect(control(form, 'clientsecret').value).toBe('');
  });

  it('draws a fresh 35-character CF UUID on every render', async () => {
    const ids: string[] = [];
    for (let render = 0; render < 2; render += 1) {
      const { $, gateway } = await renderEdit(editRequest(''), editRoutes());
      const id = hiddenClientId($);

      expect(id).toMatch(CF_UUID);
      expect(id).toHaveLength(35);
      expect(gateway.calls.filter(({ path }) => path === clientPath(id))).toHaveLength(1);
      expect(csrfContexts(gateway)).toContain(id);
      expect($('form[name="form1"] button').text().trim()).toBe('Add');
      ids.push(id);
    }

    expect(new Set(ids).size).toBe(2);
  });
});

describe('cwebservice.edit error alert', () => {
  /** Error alerts of the stored client's view carrying `errors`, on a site using SSL; `html` is the span's own markup. */
  async function errorAlerts(errors: LegacyErrors): Promise<Array<{ className: string; html: string; text: string }>> {
    const req = editRequest(STORED.clientid, { site: { record: { useSSL: 1 } } });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient(editRoutes(existingClientEdit)) });
    const view = await renderEditView(ctx, { ...(await loadEditState(ctx)), errors });
    // Read from the markup itself: cheerio re-serialises entities.
    return [...toString(view.body).matchAll(/<div class="(alert alert-error)"><span>([\s\S]*?)<\/span><\/div>/g)].map(
      ([, className = '', inner = '']) => ({
        className,
        html: tagsTight(inner),
        text: cheerio.load(inner, null, false).root().text(),
      }),
    );
  }

  it.each<[string, LegacyErrors, string | null]>([
    ['one message', { name: 'm1' }, 'm1'],
    ['two messages', { name: 'm1', granttype: 'm2' }, 'm1<br>m2'],
    ['siteid skipped', { siteid: 's', name: 'm1' }, 'm1'],
    ['SITEID skipped', { SITEID: 's', name: 'm1' }, 'm1'],
    ['siteID counted for the separator', { name: 'm1', siteID: 'x' }, 'm1<br>'],
    ['only siteID', { siteID: 'x' }, ''],
    ['no errors', {}, null],
  ])('displays %s as utility.displayErrors does', async (_case, errors, expected) => {
    const alerts = await errorAlerts(errors);

    expect(alerts.map(({ html }) => html)).toEqual(expected === null ? [] : [expected]);
  });

  it('shows the save errors identity reports', async () => {
    const messages = Object.entries(saveErrors)
      .filter(([key]) => key.toLowerCase() !== 'siteid')
      .map(([, message]) => message);
    const [alert, ...others] = await errorAlerts(saveErrors);

    expect(others).toEqual([]);
    expect(alert?.className).toBe('alert alert-error');
    expect(alert?.html).toBe(messages.map(encodeHtml).join('<br>'));
    for (const message of messages) expect(alert?.text).toContain(message);
  });
});
