// csettings.list against legacy csettings/list.cfm, the csettings.cfc list() step and utility displayErrors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/programs-sites';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { listScreen, renderLegacyErrors } from '@/screens/csettings/list';
import type { ScreenContext } from '@/screens/registry';
import { SITE_IDS, SITE_LIST, SITE_LIST_BY_ORDERNO, siteListItemById } from '../../fixtures/programs-sites/sites';
import { adminS2Request, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

type SiteListItem = components['schemas']['SiteListItem'];
/** String fields: an rc, a set of `MURA_` variables or an errors struct. */
type Fields = Readonly<Record<string, string>>;

const LIST_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites');
const ORDER_ROUTE = routeKey('POST', 'programs-sites', '/v1/sites/order');
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const EXPIRES = '261112191044236';
const TOKEN = 'F'.repeat(64);

// Every optional hook is set; the first test checks the keys.
const screen = listScreen as Required<typeof listScreen>;

/** Replaces every `MURA_` variable with `vars`, so legacy settings take the template defaults. */
function useSettings(vars: Fields = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

/** Identity issuing `T-<context>` / EXPIRES for every requested context. */
function csrfGateway(): FakeGatewayClient {
  return fakeGatewayClient({
    [CSRF_ROUTE]: (request) => ({
      status: 200,
      body: {
        tokens: (request.json as { contexts: string[] }).contexts.map((context) => ({
          context,
          csrf_token: `T-${context}`,
          csrf_token_expires: EXPIRES,
        })),
      },
    }),
  });
}

function contextFor(req: AdminRequest, gateway: FakeGatewayClient = csrfGateway()): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

const listRequest = (rc: Fields = {}, partial: AdminRequestPartial = {}): AdminRequest =>
  adminS2Request({ ...partial, circuit: 'csettings', item: 'list', rc });

interface Rendered {
  readonly markup: string;
  readonly model: DomModel;
  readonly gateway: FakeGatewayClient;
}

async function renderList(
  sites: readonly SiteListItem[],
  rc: Fields = {},
  partial: AdminRequestPartial = {},
): Promise<Rendered> {
  const gateway = csrfGateway();
  const view = await screen.render(contextFor(listRequest(rc, partial), gateway), { sites });
  expect(isSafeHtml(view.body)).toBe(true);
  const markup = toString(view.body);
  return { markup, model: fragmentModel(markup), gateway };
}

/** The contexts identity was asked to issue, in call order. */
const csrfContexts = (gateway: FakeGatewayClient): unknown[] =>
  gateway.calls.filter(({ service }) => service === 'identity').map(({ json }) => (json as { contexts: unknown }).contexts);

const controlValues = (model: DomModel, name: string): string[] =>
  model.controls.filter((control) => control.name === name).map(({ value }) => value);

const editLink = (siteid: string): string =>
  `<li class="edit"><a href="./?muraAction=cSettings.editSite&siteid=${siteid}"><i class="mi-pencil"></i>Edit</a></li>`;

const UPDATE_CORE_WARNING =
  'WARNING: Do not update your core files unless you have backed up your current Masa CMS install.';
const MSSQL_NOTE =
  '\\n\\nIf your are using MSSQL you must uncheck Maintain Connections in your CF administrator datasource settings before proceeding. You may turn it back on after the update is complete.';
const updateCoreLink = (note: string): string =>
  `<a class="btn" href="#" onclick="confirmDialog('${UPDATE_CORE_WARNING}${note}',function(){actionModal('./?muraAction=cSettings.list&action=updateCore&csrf_token=T-updatecore&csrf_token_expires=${EXPIRES}')});return false;"><i class="mi-cloud-download"></i> Update Core Files</a>`;
const JAVA_DISABLED = 'Java is disabled. Plugin installation is unavailable.';
const NO_PLUGINS = 'There are currently no installed plugins.';

describe('csettings.list', () => {
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

  it('is frozen with the controller redirect, load and render steps', () => {
    expect(Object.isFrozen(listScreen)).toBe(true);
    expect(Object.keys(listScreen).sort()).toEqual(['load', 'redirect', 'render']);
  });

  describe('redirect', () => {
    it.each<Fields>([{ refresh: '1' }, { refresh: '' }, { Refresh: 'true' }])(
      'answers fw.redirect to cSettings.list at ./ for rc %o',
      (rc) => {
        const gateway = csrfGateway();

        expect(screen.redirect(contextFor(listRequest(rc), gateway))).toEqual({
          kind: 'redirect',
          action: 'cSettings.list',
          path: './',
        });
        expect(gateway.calls).toEqual([]);
      },
    );

    it.each<Fields>([{}, { siteSortBy: 'orderno' }, { action: 'deploy' }])('renders the view for rc %o', (rc) => {
      expect(screen.redirect(contextFor(listRequest(rc)))).toBeUndefined();
    });
  });

  describe('load', () => {
    it.each<{ rc: Fields; sortBy: string }>([
      { rc: {}, sortBy: 'site' },
      { rc: { siteSortBy: 'orderno' }, sortBy: 'orderno' },
      { rc: { csrf_token: '', orderno: '2,1', orderid: 'tenant-a,default' }, sortBy: 'site' },
    ])('lists sites by $sortBy without saving for rc $rc', async ({ rc, sortBy }) => {
      const gateway = fakeGatewayClient({ [LIST_ROUTE]: { status: 200, body: SITE_LIST } });

      await expect(screen.load(contextFor(listRequest(rc), gateway))).resolves.toEqual({ sites: SITE_LIST });
      expect(gateway.calls).toEqual([{ service: 'programs-sites', method: 'GET', path: '/v1/sites', query: { sortBy } }]);
    });

    it('saves the posted order and deploy flags under the posted token, then lists', async () => {
      const gateway = fakeGatewayClient({
        [ORDER_ROUTE]: { status: 200, body: { written: true, sites: SITE_LIST_BY_ORDERNO } },
        [LIST_ROUTE]: { status: 200, body: SITE_LIST_BY_ORDERNO },
      });
      const rc = {
        siteSortBy: 'orderno',
        orderno: '1,2,3,4',
        orderid: 'default,umbrella,tenant-a,tenant-b',
        deploy: '0,0,1,0',
        csrf_token: TOKEN,
        csrf_token_expires: EXPIRES,
      };

      await expect(screen.load(contextFor(listRequest(rc), gateway))).resolves.toEqual({ sites: SITE_LIST_BY_ORDERNO });
      expect(gateway.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
        'POST /v1/sites/order',
        'GET /v1/sites',
      ]);
      expect(gateway.calls[0]).toMatchObject({
        service: 'programs-sites',
        json: {
          orderno: '1,2,3,4',
          orderID: 'default,umbrella,tenant-a,tenant-b',
          deploy: '0,0,1,0',
          csrf_token: TOKEN,
          csrf_token_expires: EXPIRES,
          sortBy: 'orderno',
          sortDirection: 'asc',
        },
      });
      expect(gateway.calls[1]).toMatchObject({ query: { sortBy: 'orderno' } });
    });

    it('posts blank list fields and the default sort when only a token is posted', async () => {
      const gateway = fakeGatewayClient({
        [ORDER_ROUTE]: { status: 200, body: { written: false, sites: SITE_LIST } },
        [LIST_ROUTE]: { status: 200, body: SITE_LIST },
      });

      await screen.load(contextFor(listRequest({ csrf_token: TOKEN }), gateway));

      expect(gateway.calls[0]?.json).toEqual({
        orderno: '',
        orderID: '',
        deploy: '',
        csrf_token: TOKEN,
        csrf_token_expires: '',
        sortBy: 'site',
        sortDirection: 'asc',
      });
    });

    it.each([
      { failing: ORDER_ROUTE, status: 403, type: GatewayDenialError, operation: 'saveSiteOrder', calls: 1 },
      { failing: ORDER_ROUTE, status: 400, type: Error, operation: 'saveSiteOrder', calls: 1 },
      { failing: LIST_ROUTE, status: 401, type: GatewayDenialError, operation: 'listSites', calls: 2 },
      { failing: LIST_ROUTE, status: 500, type: Error, operation: 'listSites', calls: 2 },
    ])('rejects when $operation answers $status', async ({ failing, status, type, operation, calls }) => {
      const gateway = fakeGatewayClient({
        [ORDER_ROUTE]: { status: 200, body: { written: true, sites: SITE_LIST } },
        [LIST_ROUTE]: { status: 200, body: SITE_LIST },
      });
      gateway.setRoute(failing, { status, body: {} });

      const failure = await screen
        .load(contextFor(listRequest({ csrf_token: TOKEN, csrf_token_expires: EXPIRES }), gateway))
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ message: `${operation} answered HTTP ${status}` });
      expect(gateway.calls).toHaveLength(calls);
    });
  });

  describe('render', () => {
    it('renders the header, both tabs and the sites by name with the template settings', async () => {
      const { markup, model, gateway } = await renderList(SITE_LIST);

      expect(model.headings).toEqual(['Global Settings', 'Current Sites', 'Plugins', 'Install Plugin']);
      expect(markup).toContain(updateCoreLink(''));
      expect(model.links).toEqual(
        expect.arrayContaining([
          { href: './?muraAction=csettings.list&siteSortBy=orderno', text: 'List Sites by Bind Order' },
          { href: '#tabCurrentsites', text: 'Current Sites' },
          { href: '#tabPlugins', text: 'Plugins' },
        ]),
      );
      expect(model.tables).toEqual([
        {
          headers: ['', 'Site', 'Domain'],
          rows: [
            ['Edit', 'Default', 'localhost'],
            ['Edit Delete', 'Tenant A', 'tenant-a.localhost'],
            ['Edit Delete', 'Tenant B', 'tenant-b.localhost'],
            ['Edit Delete', 'Umbrella', 'umbrella.localhost'],
          ],
        },
      ]);
      for (const { siteid } of SITE_LIST) expect(markup).toContain(editLink(siteid));
      expect(markup).toContain(
        `<li class="delete"><a href="#" onclick="confirmDialog('WARNING\\x3A\\x20A\\x20deleted\\x20site\\x20and\\x20all\\x20of\\x20its\\x20files\\x20cannot\\x20be\\x20recovered.\\x20Are\\x20you\\x20sure\\x20that\\x20you\\x20want\\x20to\\x20delete\\x20the\\x20site\\x20named\\x20\\x27TENANT\\x20A\\x27\\x3F',function(){actionModal('./?muraAction=cSettings.updateSite&action=delete&siteid=tenant-a&csrf_token=T-tenant-a&csrf_token_expires=${EXPIRES}')});return false;"><i class="mi-trash"></i>Delete</a></li>`,
      );
      expect(markup).not.toContain('siteid=default&csrf_token');
      expect(markup).toContain(
        `\t\t\t\t\t<input type="hidden" name="siteSortBy" value="site" />\n\t\t\t\t\t<input type="hidden" name="csrf_token" value="T-updatesites" /><input type="hidden" name="csrf_token_expires" value="${EXPIRES}" /> \n\t\t\t</form>`,
      );
      expect(markup).not.toContain('mura-actions');
      expect(markup).not.toContain('class="deploy"');
      expect(model.buttons.map(({ text }) => text)).toEqual(['Via Upload', 'Via URL', 'Deploy', 'Deploy']);
      expect(model.labels).toEqual(['Plugin File', 'Plugin URL']);
      expect(controlValues(model, 'csrf_token')).toEqual(['T-updatesites', 'T-newplugin', 'T-newplugin']);
      expect(markup).toContain(NO_PLUGINS);
      expect(markup).not.toContain(JAVA_DISABLED);
      expect(model.alerts).toEqual([]);
      expect(csrfContexts(gateway)).toEqual([['updatesites', 'updatecore', 'newplugin', 'tenant-a', 'tenant-b', 'umbrella']]);
    });

    it.each(['orderno', 'OrderNo'])('renders the bind-order view for siteSortBy=%s', async (siteSortBy) => {
      const { markup, model } = await renderList(SITE_LIST_BY_ORDERNO, { siteSortBy });

      expect(model.links).toContainEqual({
        href: './?muraAction=csettings.list&siteSortBy=site',
        text: 'List Sites by Site Name',
      });
      expect(markup).not.toContain('List Sites by Bind Order');
      expect(model.tables[0]?.headers).toEqual(['', 'Bind Order', 'Site', 'Domain']);
      const orders = model.controls.filter(({ name }) => name === 'orderno');
      expect(orders.map(({ value }) => value)).toEqual(['1', '2', '3', '4']);
      for (const order of orders) expect(order.options.map(({ value }) => value)).toEqual(['1', '2', '3', '4']);
      expect(controlValues(model, 'orderid')).toEqual(['default', 'umbrella', 'tenant-a', 'tenant-b']);
      expect(markup).toContain(
        '<td><select name="orderno" class="dropdown">\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t<option value="1" selected>1</option>',
      );
      expect(markup).toContain(
        '<button type="button" class="btn mura-primary" onclick="document.form1.submit();"><i class="mi-check"></i> Update Bind Order</button>',
      );
      expect(markup).not.toContain('Update Auto Deploy Settings');
      expect(controlValues(model, 'siteSortBy')).toEqual([siteSortBy]);
    });

    it('adds staging Deploy actions and batch-deploy columns, dates in the session mask', async () => {
      useSettings({ MURA_MODE: 'staging' });

      const { markup, model } = await renderList(SITE_LIST);

      expect(model.tables[0]?.headers).toEqual(['', 'Site', 'Domain', 'Batch Deploy', 'Last Deployment']);
      // The admin date mask's known issue: 2026-10-29 shows as 10/302/2026.
      expect(model.tables[0]?.rows).toEqual([
        ['Edit Deploy', 'Default', 'localhost', 'Yes No', 'Never'],
        ['Edit Deploy Delete', 'Tenant A', 'tenant-a.localhost', 'Yes No', '10/302/2026'],
        ['Edit Deploy Delete', 'Tenant B', 'tenant-b.localhost', 'Yes No', 'Never'],
        ['Edit Deploy Delete', 'Umbrella', 'umbrella.localhost', 'Yes No', 'Never'],
      ]);
      expect(controlValues(model, 'deploy')).toEqual(['0', '1', '0', '0']);
      expect(markup).toContain(
        `<li class="deploy"><a href="?muraAction=cSettings.list&action=deploy&siteid=tenant-a" onclick="return confirmDialog('Deploy Tenant\\x20A to production?',this.href);"><i class="mi-download"></i>Deploy</a></li>`,
      );
      expect(markup).toContain(
        '<button type="button" class="btn" onclick="document.form1.submit();"><i class="mi-check"></i>Update Auto Deploy Settings</button>',
      );
      expect(markup).not.toContain('Update Bind Order');
    });

    it('keeps staging Deploy actions but no deploy columns in the bind-order view', async () => {
      useSettings({ MURA_MODE: 'Staging' });

      const { markup, model } = await renderList(SITE_LIST_BY_ORDERNO, { siteSortBy: 'orderno' });

      expect(model.tables[0]?.headers).toEqual(['', 'Bind Order', 'Site', 'Domain']);
      expect(markup.match(/<li class="deploy">/g)).toHaveLength(4);
      expect(controlValues(model, 'deploy')).toEqual([]);
      expect(markup).not.toContain('Update Auto Deploy Settings');
    });

    it.each<{ vars: Fields; contexts: string[]; present: string[]; absent: string[] }>([
      {
        vars: { MURA_ALLOWAUTOUPDATES: 'false' },
        contexts: ['updatesites', 'newplugin'],
        present: [NO_PLUGINS],
        absent: ['Update Core Files', JAVA_DISABLED],
      },
      {
        vars: { MURA_DBTYPE: 'mssql' },
        contexts: ['updatesites', 'updatecore', 'newplugin'],
        present: [updateCoreLink(MSSQL_NOTE)],
        absent: [JAVA_DISABLED],
      },
      {
        vars: { MURA_JAVAENABLED: 'false' },
        contexts: ['updatesites', 'updatecore'],
        present: [
          '\n\t\t<h2>Install Plugin</h2>\n\t\t\n\n    <div class="help-block-empty">\n      Java is disabled. Plugin installation is unavailable.\n    </div>\n\n      \n\t\t\t\t<div class="help-block-empty">',
        ],
        absent: ['frmNewPlugin', 'apptypefile', 'T-newplugin'],
      },
    ])('follows global settings $vars', async ({ vars, contexts, present, absent }) => {
      useSettings(vars);

      const { markup, gateway } = await renderList([siteListItemById[SITE_IDS.default]]);

      for (const text of present) expect(markup).toContain(text);
      for (const text of absent) expect(markup).not.toContain(text);
      expect(csrfContexts(gateway)).toEqual([contexts]);
    });

    it('echoes site names unencoded, encodes domains and dashes empty ones', async () => {
      const sites: SiteListItem[] = [
        { siteid: 'a-site', site: '<b>A&B</b>', domain: 'a&b.example.test', orderno: 1, deploy: 0, lastDeployment: null },
        { siteid: 'b-site', site: null, domain: '', orderno: 2, deploy: null, lastDeployment: null },
        { siteid: 'c-site', site: 'C', domain: null, orderno: 3, deploy: 0, lastDeployment: null },
      ];

      const { markup, model } = await renderList(sites);

      expect(markup).toContain('href="./?muraAction=cSettings.editSite&siteid=a-site"><b>A&B</b></a></td>');
      expect(markup).toContain('\t\t\t\t\t\t<td>\n\t\t\t\t\t\t\ta&amp;b.example.test \n\t\t\t\t\t\t</td>');
      expect(markup).toContain('the\\x20site\\x20named\\x20\\x27\\x27\\x3F');
      expect(model.tables[0]?.rows.map((row) => row.slice(1))).toEqual([
        ['A&B', 'a&b.example.test'],
        ['', '-'],
        ['C', '-'],
      ]);
    });

    it.each([
      { siteSortBy: 'a"b<c>', attr: 'a&quot;b&lt;c&gt;' },
      { siteSortBy: 'domain', attr: 'domain' },
    ])('html_attr-encodes siteSortBy $siteSortBy in the hidden field', async ({ siteSortBy, attr }) => {
      const { markup, model } = await renderList(SITE_LIST, { siteSortBy });

      expect(markup).toContain(`<input type="hidden" name="siteSortBy" value="${attr}" />`);
      expect(model.tables[0]?.headers).toEqual(['', 'Site', 'Domain']);
    });

    it.each([
      { sitesUpdated: '<p class="alert alert-success">Sites updated.</p>', shown: true },
      { sitesUpdated: ' \t ', shown: false },
    ])('echoes rc.sitesUpdated raw only when it is not blank: $sitesUpdated', async ({ sitesUpdated, shown }) => {
      const { markup } = await renderList(SITE_LIST, { sitesUpdated });

      const afterHeader = markup.slice(
        markup.indexOf('</div> <!-- /.mura-header -->'),
        markup.indexOf('<div class="block block-constrain">'),
      );
      expect(afterHeader.includes(sitesUpdated)).toBe(shown);
      if (!shown) expect(afterHeader).toBe('</div> <!-- /.mura-header -->\n\n\n\n\t');
    });

    it('shows the session errors struct raw in an error alert before the tabs', async () => {
      const errors = { name: 'The Site Name is required.', siteID: 'default', email: '<b>Email</b> is invalid.' };

      const { markup, model } = await renderList(SITE_LIST, {}, { session: { mura: { errors } } });

      expect(markup).toContain(
        '\n\t\t<div class="alert alert-error"><span> The Site Name is required. <br> <b>Email</b> is invalid. </span></div>\n\t\t\n\n\t<div class="block block-constrain">',
      );
      expect(model.alerts).toEqual([
        { text: 'The Site Name is required. Email is invalid.', className: 'alert alert-error' },
      ]);
    });

    it.each([
      { label: 'a key named Errors', mura: { Errors: { title: 'Bad title.' } }, text: 'Bad title.' },
      { label: 'non-string messages', mura: { errors: { count: 3, blank: null } }, text: '3' },
    ])('shows session errors for $label', async ({ mura, text }) => {
      const { model } = await renderList(SITE_LIST, {}, { session: { mura } });

      expect(model.alerts).toEqual([{ text, className: 'alert alert-error' }]);
    });

    it.each([
      { label: 'no errors value', errors: undefined },
      { label: 'the view reset ""', errors: '' },
      { label: 'an empty struct', errors: {} },
      { label: 'an array', errors: ['Bad'] },
    ])('shows no error alert for $label', async ({ errors }) => {
      const { markup, model } = await renderList(SITE_LIST, {}, { session: { mura: { errors } } });

      expect(model.alerts).toEqual([]);
      expect(markup).not.toContain('alert-error');
    });
  });

  describe('renderLegacyErrors', () => {
    it.each<{ errors: Fields; span: string }>([
      { errors: { a: 'A', b: 'B' }, span: ' A <br> B ' },
      { errors: { siteID: 'x', a: 'A' }, span: ' A ' },
      { errors: { a: 'A', SITEID: 'x' }, span: ' A <br> ' },
      { errors: { a: 'A', siteid: 'x', b: 'B' }, span: ' A <br> B ' },
      { errors: { siteID: 'x' }, span: ' ' },
      { errors: { a: 'A ', b: '' }, span: ' A <br> ' },
    ])('writes displayErrors of $errors', ({ errors, span }) => {
      expect(toString(renderLegacyErrors(errors))).toBe(`<div class="alert alert-error"><span>${span}</span></div>`);
    });
  });
});
