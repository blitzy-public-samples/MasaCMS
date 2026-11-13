// csettings.list inside the shell over the programs-sites fixtures, against csettings/list.cfm and csettings.cfc list();
// list-page.test.ts covers each screen step on its own.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateField } from '@/lib/dates';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import { csettingsScreens } from '@/screens/csettings';
import { listScreen, renderLegacyErrors } from '@/screens/csettings/list';
import type { ScreenDefinition } from '@/screens/registry';
import { SITE_IDS, SITE_LIST, SITE_LIST_BY_ORDERNO, siteTenantA } from '../../fixtures/programs-sites/sites';
import {
  SITE_ERRORS_MULTI,
  SITE_ERRORS_SITEID_REQUIRED,
  SITE_ORDER_RESULT_SUCCESS,
  SITE_ORDER_UPDATE,
} from '../../fixtures/programs-sites/site-errors';
import { adminS2Request, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { domModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel, renderScreenPage } from '../../helpers/screen-context';

// The registry module loads every circuit; screen suites stand in for it with the shell hooks this page renders with.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type ListRequest = ReturnType<typeof adminS2Request>;
type SiteListItem = (typeof SITE_LIST)[number];
type Fields = Readonly<Record<string, string>>;

const LIST_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites');
const ORDER_ROUTE = routeKey('POST', 'programs-sites', '/v1/sites/order');
const CSRF_FIELDS: Fields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };

/** programs-sites answering `listSites` by its `sortBy` and `saveSiteOrder` with the fixture result. */
const routes = (): FakeRouteTable => ({
  [LIST_ROUTE]: ({ query }) => ({ status: 200, body: query.sortBy === 'orderno' ? SITE_LIST_BY_ORDERNO : SITE_LIST }),
  [ORDER_ROUTE]: { status: 200, body: SITE_ORDER_RESULT_SUCCESS },
});

/** Template settings with `vars` laid over them; the host's `MURA_` variables are hidden. */
function useSettings(vars: Fields = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

function registeredList(): ScreenDefinition {
  const def = csettingsScreens.find(({ action }) => action === 'list');
  if (def === undefined) throw new TypeError('csettings.list is not registered');
  return def;
}

const listRequest = (rc: Fields = {}, partial: AdminRequestPartial = {}): ListRequest =>
  adminS2Request({ ...partial, circuit: 'csettings', item: 'list', rc });

interface Page {
  readonly html: string;
  readonly model: DomModel;
  readonly $: CheerioAPI;
  readonly gateway: FakeGatewayClient;
  readonly req: ListRequest;
}

async function renderPage(req: ListRequest): Promise<Page> {
  const gateway = fakeGatewayClient(routes());
  const page = await renderScreenPage(registeredList(), makeScreenContext({ req, gateway }));
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { html: page.html, model: domModel(page.html), $: cheerio.load(page.html), gateway, req };
}

/** The `/v1/sites` calls as `METHOD path`, in call order. */
const siteCalls = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'programs-sites' && path.startsWith('/v1/sites'))
    .map(({ method, path }) => `${method} ${path}`);

/** Every CSRF context identity was asked to issue. */
const csrfContexts = (gateway: FakeGatewayClient): string[] =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path === '/v1/csrf/tokens')
    .flatMap(({ json }) => (json as { contexts: string[] }).contexts);

/** Name and value of each hidden field of the form named `form`. */
const hiddenFields = ($: CheerioAPI, form: string): Array<[string, string]> =>
  $(`form[name="${form}"] input[type="hidden"]`)
    .toArray()
    .map((el): [string, string] => [$(el).attr('name') ?? '', $(el).attr('value') ?? '']);

const valuesOf = (model: DomModel, name: string): string[] =>
  model.controls.filter((control) => control.name === name).map(({ value }) => value);

const actionsOf = (sites: readonly SiteListItem[]): string[] =>
  sites.map(({ siteid }) => (siteid === SITE_IDS.default ? 'Edit' : 'Edit Delete'));

let restoreEnv: () => void;

beforeEach(() => {
  useSettings();
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('csettings.list page', () => {
  it('renders the view inside the shell', async () => {
    const ctx = makeScreenContext({ req: listRequest(), gateway: fakeGatewayClient(routes()) });

    const model = await renderScreenModel(registeredList(), ctx);

    expect(model.title).toBe('Masa CMS - Settings');
    expect(model.headings).toEqual(['Global Settings', 'Current Sites', 'Plugins', 'Install Plugin']);
    expect(model.links).toEqual(
      expect.arrayContaining([
        { href: '/admin/?muraAction=csettings.list', text: 'Sites' },
        { href: './?muraAction=csettings.list&siteSortBy=orderno', text: 'List Sites by Bind Order' },
      ]),
    );
    expect(model.tables).toHaveLength(1);
    expect(valuesOf(model, 'csrf_token')).toEqual(['<token>', '<token>', '<token>']);
  });

  it('opens the Current Sites tab and posts form1 to csettings.list', async () => {
    const { $, gateway } = await renderPage(listRequest());

    const tabs = $('ul.mura-tabs.nav-tabs > li')
      .toArray()
      .map((li) => ({ active: $(li).hasClass('active'), href: $(li).find('a').attr('href'), text: $(li).text().trim() }));
    expect(tabs).toEqual([
      { active: true, href: '#tabCurrentsites', text: 'Current Sites' },
      { active: false, href: '#tabPlugins', text: 'Plugins' },
    ]);
    const form = $('form[name="form1"]');
    expect([form.attr('id'), form.attr('action'), form.attr('method')]).toEqual([
      'form1',
      './?muraAction=csettings.list',
      'post',
    ]);
    expect(hiddenFields($, 'form1')).toEqual([['siteSortBy', 'site'], ...Object.entries(CSRF_FIELDS)]);
    expect(csrfContexts(gateway)).toContain('updatesites');
  });

  it.each<{ label: string; rc: Fields; sortBy: string; sites: readonly SiteListItem[]; toggle: string }>([
    { label: 'site name', rc: {}, sortBy: 'site', sites: SITE_LIST, toggle: 'List Sites by Bind Order' },
    {
      label: 'bind order',
      rc: { siteSortBy: 'orderno' },
      sortBy: 'orderno',
      sites: SITE_LIST_BY_ORDERNO,
      toggle: 'List Sites by Site Name',
    },
  ])('lists sites by $label in the order programs-sites returns', async ({ rc, sortBy, sites, toggle }) => {
    const { model, gateway } = await renderPage(listRequest(rc));

    const listCalls = gateway.calls.filter(({ path }) => path === '/v1/sites');
    expect(listCalls).toEqual([{ service: 'programs-sites', method: 'GET', path: '/v1/sites', query: { sortBy } }]);
    const rows = model.tables[0]?.rows ?? [];
    expect(rows.map((row) => row.slice(-2))).toEqual(sites.map(({ site, domain }) => [site, domain || '-']));
    expect(rows.map((row) => row[0])).toEqual(actionsOf(sites));
    for (const { siteid, site } of sites) {
      expect(model.links).toContainEqual({ href: `./?muraAction=csettings.editsite&siteid=${siteid}`, text: site });
    }
    expect(model.links.map(({ text }) => text)).toContain(toggle);
    expect(valuesOf(model, 'siteSortBy')).toEqual([sortBy]);
  });

  it('numbers the bind-order selects 1..n with each row selected at its position', async () => {
    const { model } = await renderPage(listRequest({ siteSortBy: 'orderno' }));

    const positions = SITE_LIST_BY_ORDERNO.map((_, index) => String(index + 1));
    expect(model.tables[0]?.headers).toEqual(['', 'Bind Order', 'Site', 'Domain']);
    const selects = model.controls.filter(({ name }) => name === 'orderno');
    expect(selects.map(({ value }) => value)).toEqual(positions);
    for (const select of selects) expect(select.options.map(({ label }) => label)).toEqual(positions);
    expect(valuesOf(model, 'orderid')).toEqual(SITE_LIST_BY_ORDERNO.map(({ siteid }) => siteid));
    expect(model.buttons.map(({ text }) => text)).toContain('Update Bind Order');
  });

  it.each([
    { csrf: CSRF_FIELDS, calls: ['POST /v1/sites/order', 'GET /v1/sites'] },
    { csrf: {}, calls: ['GET /v1/sites'] },
  ])('saves the order and deploy flags only under a posted token: $csrf', async ({ csrf, calls }) => {
    const deploy = '0,0,1,0';
    const rc = { siteSortBy: 'orderno', orderno: SITE_ORDER_UPDATE.orderno, orderID: SITE_ORDER_UPDATE.orderID, deploy };

    const { gateway } = await renderPage(listRequest({ ...rc, ...csrf }));

    expect(siteCalls(gateway)).toEqual(calls);
    const saves = gateway.calls.filter(({ path }) => path === '/v1/sites/order');
    expect(saves.map(({ json }) => json)).toEqual(
      calls.length === 2 ? [{ ...SITE_ORDER_UPDATE, deploy, ...CSRF_FIELDS }] : [],
    );
  });

  it.each([
    { java: 'true', forms: ['form1', 'frmNewPlugin', 'frmNewPluginFROMURL'] },
    { java: 'false', forms: ['form1'] },
  ])('follows MURA_JAVAENABLED=$java on the Plugins tab', async ({ java, forms }) => {
    useSettings({ MURA_JAVAENABLED: java });

    const { $, gateway } = await renderPage(listRequest());

    const tab = $('#tabPlugins');
    expect(tab.find('h2').text()).toBe('Install Plugin');
    expect($('.tab-content form').toArray().map((form) => $(form).attr('name'))).toEqual(forms);
    const upload = $('form[name="frmNewPlugin"]');
    if (java === 'true') {
      expect([upload.attr('action'), upload.attr('enctype'), upload.attr('method')]).toEqual([
        './?muraAction=cSettings.deployPlugin',
        'multipart/form-data',
        'post',
      ]);
      expect(upload.find('input[type="file"]').attr('name')).toBe('newPlugin');
      expect(hiddenFields($, 'frmNewPlugin')).toEqual(Object.entries(CSRF_FIELDS));
      expect(csrfContexts(gateway)).toContain('newplugin');
    } else {
      expect(tab.find('.help-block-empty').first().text().trim()).toBe(
        'Java is disabled. Plugin installation is unavailable.',
      );
      expect(csrfContexts(gateway)).not.toContain('newplugin');
    }
    expect(tab.find('.help-block-empty').last().text().trim()).toBe('There are currently no installed plugins.');
  });

  it('shows staging deploy columns with the legacy date mask', async () => {
    useSettings({ MURA_MODE: 'staging' });

    const { model, req } = await renderPage(listRequest());

    const table = model.tables[0];
    expect(table?.headers).toEqual(['', 'Site', 'Domain', 'Batch Deploy', 'Last Deployment']);
    const tenantA = formatDateField(siteTenantA.lastDeployment, req.session.dateKeyFormat);
    expect(tenantA).toBe('10/302/2026');
    expect(table?.rows.map((row) => row.at(-1))).toEqual(
      SITE_LIST.map(({ siteid }) => (siteid === SITE_IDS.tenantA ? tenantA : 'Never')),
    );
    const deploys = model.controls.filter(({ name }) => name === 'deploy');
    expect(deploys.map(({ value }) => value)).toEqual(SITE_LIST.map(({ deploy }) => String(deploy)));
    for (const select of deploys) {
      expect(select.options.map(({ value, label }) => [value, label])).toEqual([
        ['1', 'Yes'],
        ['0', 'No'],
      ]);
    }
    expect(model.buttons.map(({ text }) => text)).toContain('Update Auto Deploy Settings');
  });

  it.each([
    {
      label: 'several messages',
      errors: SITE_ERRORS_MULTI,
      span: ` ${SITE_ERRORS_MULTI.site} <br> ${SITE_ERRORS_MULTI.domain} `,
    },
    { label: 'only a siteid message', errors: SITE_ERRORS_SITEID_REQUIRED, span: ' ' },
  ])('shows the session errors with $label once, then clears them', async ({ errors, span }) => {
    const alert = `<div class="alert alert-error"><span>${span}</span></div>`;
    expect(toString(renderLegacyErrors(errors))).toBe(alert);

    const { html, model, req } = await renderPage(listRequest({}, { session: { mura: { errors } } }));

    expect(html).toContain(alert);
    expect(model.alerts.filter(({ className }) => className === 'alert alert-error')).toEqual([
      { text: span.trim().replace(' <br> ', ' '), className: 'alert alert-error' },
    ]);
    expect(req.sessionWrites.muraValues).toEqual({ errors: '' });
  });

  it('shows no error alert without session errors', async () => {
    const { model } = await renderPage(listRequest());

    expect(model.alerts.filter(({ className }) => className.includes('alert-error'))).toEqual([]);
  });

  // The registry's not-built variant withholds this branch; with the registry mocked, the screen must still not update.
  it('never reaches a core updater for action=updateCore', async () => {
    const { html, gateway } = await renderPage(listRequest({ action: 'updateCore' }));

    expect(siteCalls(gateway)).toEqual(['GET /v1/sites']);
    expect(gateway.calls.map(({ path }) => path).filter((path) => /update|core/i.test(path))).toEqual([]);
    expect(html).not.toContain('Your core files have been updated');
  });

  it('answers refresh with the FW/1 redirect before loading', async () => {
    const gateway = fakeGatewayClient(routes());
    const ctx = makeScreenContext({ req: listRequest({ refresh: '1' }), gateway });

    expect(listScreen.redirect?.(ctx)).toEqual({ kind: 'redirect', action: 'cSettings.list', path: './' });
    await expect(renderScreenPage(registeredList(), ctx)).rejects.toThrow('fires (to cSettings.list)');
    expect(siteCalls(gateway)).toEqual([]);
  });

  it('sends a site admin back without listing sites', async () => {
    const gateway = fakeGatewayClient(routes());
    const req = siteAdminRequest(SITE_IDS.tenantA, { circuit: 'csettings', item: 'list', rc: { siteid: SITE_IDS.tenantA } });

    const page = await renderScreenPage(registeredList(), makeScreenContext({ req, gateway }));

    expect(page).toEqual({ kind: 'redirect', location: './' });
    expect(gateway.calls).toEqual([]);
  });
});
