// csettings.editsite against admin/core/views/csettings/editsite.cfm, cf_fileselector/cf_filetools and editSite().
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString, type SafeHtml } from '@/lib/html';
import { csettingsScreens } from '@/screens/csettings';
import { editSiteScreen, loadEditSiteModel } from '@/screens/csettings/editsite';
import { renderBasicTab } from '@/screens/csettings/editsite/basic';
import { renderBundlesTab } from '@/screens/csettings/editsite/bundles';
import { renderContactInfoTab } from '@/screens/csettings/editsite/contact-info';
import { renderDisplayRegionsTab } from '@/screens/csettings/editsite/display-regions';
import { renderEmailTab } from '@/screens/csettings/editsite/email';
import { renderExtendedAttributesTab } from '@/screens/csettings/editsite/extended-attributes';
import { renderExtranetTab } from '@/screens/csettings/editsite/extranet';
import {
  renderFileSelector,
  renderFileTools,
  type FileSelectorOptions,
} from '@/screens/csettings/editsite/file-selector';
import { renderImagesTab } from '@/screens/csettings/editsite/images';
import { cfEq, cfListFind, checked, selected, type EditSiteModel } from '@/screens/csettings/editsite/model';
import { renderModulesTab } from '@/screens/csettings/editsite/modules';
import { renderRazunaTab } from '@/screens/csettings/editsite/razuna';
import { renderSharedResourcesTab } from '@/screens/csettings/editsite/shared-resources';
import {
  SITE_DETAIL_IDS,
  siteDetailDefault,
  siteDetailTenantA,
  siteDetailTenantAWithExtendSets,
} from '../../fixtures/programs-sites/site-detail';
import { SITE_IDS, SITE_LIST_BY_ORDERNO } from '../../fixtures/programs-sites/sites';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomControl, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeRouteTable } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenModel } from '../../helpers/screen-context';

// registry.ts imports circuit barrels this suite does not load; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Req = ReturnType<typeof adminS2Request>;
type SiteDetail = typeof siteDetailTenantA;
type Patch = (m: EditSiteModel) => EditSiteModel;

const tenantA = siteDetailTenantA.site;
const LIST_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites');
const BASE_TABS: ReadonlyArray<readonly [string, string]> = [
  ['tabBasic', 'Basic'],
  ['tabContactinfo', 'Contact Info'],
  ['tabSharedresources', 'Shared Resources'],
  ['tabModules', 'Modules'],
  ['tabEmail', 'Email'],
  ['tabImages', 'Images'],
  ['tabExtranet', 'Extranet'],
  ['tabDisplayregions', 'Display Regions'],
  ['tabBundles', 'Deploy Bundle'],
];
const EXTEND_TABS: ReadonlyArray<readonly [string, string]> = [
  ...BASE_TABS.slice(0, 3),
  ['tabModules', 'Admin Modules'],
  ...BASE_TABS.slice(4, 8),
  ['tabExtendedAttributes', 'Extended Attributes'],
  ['tabBundles', 'Deploy Bundle'],
];

/** programs-sites answering `detail` and, for S2, the site list in orderno order. */
const routesFor = (detail: SiteDetail): FakeRouteTable => ({
  [routeKey('GET', 'programs-sites', `/v1/sites/${detail.site.SiteID}`)]: { status: 200, body: detail },
  [LIST_ROUTE]: { status: 200, body: SITE_LIST_BY_ORDERNO },
});

const editSite = (rc: Readonly<Record<string, string>>) => ({ circuit: 'csettings', item: 'editsite', rc });
const s2 = (siteid: string, rc: Readonly<Record<string, string>> = {}): Req => adminS2Request(editSite({ siteid, ...rc }));
const siteAdmin = (): Req => siteAdminRequest(SITE_IDS.tenantA, editSite({ siteid: SITE_IDS.tenantA }));

const contextFor = (detail: SiteDetail, req: Req) => makeScreenContext({ req, gateway: fakeGatewayClient(routesFor(detail)) });

/** The loaded model of `detail` for `req`. */
const modelFor = (detail: SiteDetail = siteDetailTenantA, req: Req = s2(detail.site.SiteID)): Promise<EditSiteModel> =>
  loadEditSiteModel(contextFor(detail, req));

/** The view body of `detail` for `req`, its model passed through `patch` before rendering. */
async function renderPage(detail: SiteDetail, req: Req, patch: Patch = (m) => m) {
  const ctx = contextFor(detail, req);
  const markup = toString((await editSiteScreen.render(ctx, patch(await loadEditSiteModel(ctx)))).body);
  return { ctx, markup, $: cheerio.load(markup) };
}

const fragment = (h: SafeHtml): DomModel => fragmentModel(toString(h));
const $of = (h: SafeHtml) => cheerio.load(toString(h), null, false);
const named = (dom: DomModel, name: string): DomControl[] => dom.controls.filter((c) => c.name === name);
const valueOf = (dom: DomModel, name: string): string | undefined => named(dom, name)[0]?.value;
const selectedOf = (dom: DomModel, name: string): string[] | undefined => named(dom, name)[0]?.selected;
const radios = (dom: DomModel, name: string): Array<[string, boolean]> =>
  named(dom, name).map((c) => [c.value, c.checked]);
const checkedOf = (dom: DomModel, name: string): string[] =>
  named(dom, name)
    .filter((c) => c.checked)
    .map((c) => c.value);
const namesOf = (dom: DomModel): string[] => [...new Set(dom.controls.map((c) => c.name).filter((n) => n !== ''))];

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  restoreEnv();
});

describe('editsite loader', () => {
  it.each<[string, () => Req, string[]]>([
    ['S2 reads the site and the site list', () => s2(SITE_IDS.tenantA), ['/v1/sites/tenant-a', '/v1/sites']],
    ['site admin reads the site only', siteAdmin, ['/v1/sites/tenant-a']],
  ])('%s', async (_case, req, paths) => {
    const ctx = contextFor(siteDetailTenantA, req());
    const model = await loadEditSiteModel(ctx);
    const calls = ctx.gateway.calls.filter((c) => c.service === 'programs-sites');
    expect(calls.map((c) => c.path)).toEqual(paths);
    expect(model.bean.siteID).toBe(SITE_IDS.tenantA);
    expect(model.sites.length).toBe(paths.length === 2 ? SITE_LIST_BY_ORDERNO.length : 0);
  });

  it('Add Site fails closed', async () => {
    await expect(modelFor(siteDetailTenantA, s2(''))).rejects.toMatchObject({ reason: 'add-site' });
  });
});

describe('editsite composer', () => {
  it('header: S2 module buttons', async () => {
    const { $ } = await renderPage(siteDetailTenantA, s2(SITE_IDS.tenantA));
    expect($('div.mura-header h1').text()).toBe('Site Settings');
    const links = $('div.mura-header div.nav-module-specific.btn-group a.btn')
      .toArray()
      .map((a) => [$(a).text().trim(), $(a).attr('href')]);
    expect(links).toEqual([
      ['Create Site Bundle', '?muraAction=cSettings.selectBundleOptions&siteID=tenant-a'],
      ['Class Extensions', './?muraAction=cExtend.listSubTypes&siteid=tenant-a'],
      ['Trash Bin', './?muraAction=cTrash.list&siteID=tenant-a'],
    ]);
    expect($('a:contains("Export Static HTML (BETA)")')).toHaveLength(0);
    expect($('a:contains("Edit Site")')).toHaveLength(0);
  });

  it('header: site admin has no Trash Bin', async () => {
    const { $ } = await renderPage(siteDetailTenantA, siteAdmin());
    expect($('div.nav-module-specific a.btn').toArray().map((a) => $(a).text().trim())).toEqual([
      'Create Site Bundle',
      'Class Extensions',
    ]);
  });

  it('header: Edit Site on updateFiles', async () => {
    const { $ } = await renderPage(siteDetailTenantA, s2(SITE_IDS.tenantA, { action: 'updateFiles' }));
    expect($('div.nav-module-specific a.btn').first().text().trim()).toBe('Edit Site');
    expect($('a:contains("Edit Site")').attr('href')).toBe('./?muraAction=cSettings.editSite&siteid=tenant-a');
  });

  it('header: no Create Site Bundle with Java off', async () => {
    vi.stubEnv('MURA_JAVAENABLED', 'false');
    resetLegacySettingsForTests();
    const { $ } = await renderPage(siteDetailTenantA, s2(SITE_IDS.tenantA));
    expect($('a:contains("Create Site Bundle")')).toHaveLength(0);
    expect($('a:contains("Class Extensions")')).toHaveLength(1);
  });

  it('form: legacy attributes, hidden action and site CSRF', async () => {
    const { $, ctx } = await renderPage(siteDetailTenantA, s2(SITE_IDS.tenantA));
    const form = $('form[name="form1"]');
    expect(form).toHaveLength(1);
    expect([form.attr('method'), form.attr('enctype'), form.attr('action'), form.attr('onsubmit')]).toEqual([
      'post',
      'multipart/form-data',
      './?muraAction=cSettings.updateSite',
      'return validate(this);',
    ]);
    expect(form.find('input[type="hidden"][name="action"]').val()).toBe('update');
    expect(form.find('input[name="csrf_token"]').val()).toBe(FIXED_CSRF.token);
    expect(form.find('input[name="csrf_token_expires"]').val()).toBe(FIXED_CSRF.expires);
    const csrfCalls = ctx.gateway.calls.filter((c) => c.service === 'identity' && c.path === '/v1/csrf/tokens');
    expect(csrfCalls.map((c) => c.json)).toEqual([{ contexts: [SITE_IDS.tenantA] }]);
    expect(form.find('button:contains("Save Settings")').attr('onclick')).toBe(
      "submitForm(document.forms.form1,'update');",
    );
  });

  it.each<[string, SiteDetail, () => Req, number]>([
    ['S2 on tenant-a', siteDetailTenantA, () => s2(SITE_IDS.tenantA), 1],
    ['S2 on default', siteDetailDefault, () => s2(SITE_IDS.default), 0],
    ['site admin on tenant-a', siteDetailTenantA, siteAdmin, 0],
  ])('form: Delete for %s', async (_case, detail, req, count) => {
    const { $ } = await renderPage(detail, req());
    expect($('div.mura-actions button:contains("Delete")')).toHaveLength(count);
    expect($('div.mura-actions button:contains("Save Settings")')).toHaveLength(1);
  });

  it.each<[string, SiteDetail, Patch, ReadonlyArray<readonly [string, string]>]>([
    ['no extend sets', siteDetailTenantA, (m) => m, BASE_TABS],
    ['extend sets', siteDetailTenantAWithExtendSets, (m) => m, EXTEND_TABS],
    ['Razuna on', siteDetailTenantA, (m) => ({ ...m, config: { ...m.config, razuna: true } }), [...BASE_TABS, ['tabRazuna', 'Razuna']]],
  ])('tabs: %s', async (_case, detail, patch, expected) => {
    const { $ } = await renderPage(detail, s2(SITE_IDS.tenantA), patch);
    const items = $('ul.mura-tabs.nav-tabs > li').toArray();
    expect(items.map((li) => [$(li).find('a').attr('href'), $(li).find('a > span').text()])).toEqual(
      expected.map(([id, label]) => [`#${id}`, label]),
    );
    expect(items.map((li) => $(li).hasClass('active'))).toEqual(expected.map((_, index) => index === 0));
    for (const [id] of expected) expect($(`div.tab-pane[id="${id}"]`), id).toHaveLength(1);
    expect($('div.tab-pane')).toHaveLength(expected.length);
    expect($('#tabBasic').hasClass('active')).toBe(true);
  });

  it.each<[string, () => Req]>([
    ['S2', () => s2(SITE_IDS.tenantA)],
    ['site admin', siteAdmin],
  ])('page: renders in the shell for %s', async (_case, req) => {
    const def = csettingsScreens.find((d) => d.action === 'editsite');
    if (def === undefined) throw new Error('csettings.editsite is not registered');
    const dom = await renderScreenModel(def, contextFor(siteDetailTenantA, req()));
    expect(dom.headings).toContain('Site Settings');
    expect(valueOf(dom, 'siteid')).toBe(SITE_IDS.tenantA);
    expect(valueOf(dom, 'csrf_token')).toBe('<token>');
  });
});

describe('editsite basic tab', () => {
  it('basic: tenant-a controls, values and states', async () => {
    const dom = fragment(renderBasicTab(await modelFor()));
    expect(namesOf(dom)).toEqual([
      'siteid',
      'site',
      'tagline',
      'domain',
      'domainAlias',
      'enforcePrimaryDomain',
      'useSSL',
      'siteLocale',
      'theme',
      'pagelimit',
      'nextN',
      'cache',
      'cacheFreeMemoryThreshold',
      'locking',
      'CommentApprovalDefault',
      'exportLocation',
      'customTagGroups',
      'enableLockdown',
      'IsRemote',
      'remotecontext',
      'remoteport',
      'resourcedomain',
      'resourceSSL',
      'reCAPTCHASiteKey',
      'reCAPTCHASecret',
      'reCAPTCHALanguage',
    ]);
    expect(named(dom, 'siteid').map((c) => [c.type, c.value])).toEqual([['hidden', tenantA.SiteID]]);
    expect(
      ['site', 'tagline', 'domain', 'domainAlias', 'exportLocation', 'customTagGroups', 'reCAPTCHASiteKey', 'reCAPTCHASecret'].map(
        (name) => valueOf(dom, name),
      ),
    ).toEqual([
      tenantA.Site,
      tenantA.tagline,
      tenantA.Domain,
      tenantA.domainAlias,
      tenantA.exportLocation,
      tenantA.customTagGroups,
      tenantA.reCAPTCHASiteKey,
      tenantA.reCAPTCHASecret,
    ]);
    expect(['pagelimit', 'nextN', 'cacheFreeMemoryThreshold', 'remotecontext', 'remoteport', 'resourcedomain'].map((name) => valueOf(dom, name))).toEqual(
      [tenantA.PageLimit, tenantA.NextN, tenantA.cacheFreeMemoryThreshold, tenantA.remotecontext, tenantA.remoteport, tenantA.resourceDomain].map(
        String,
      ),
    );
    expect(
      ['enforcePrimaryDomain', 'useSSL', 'cache', 'locking', 'CommentApprovalDefault', 'IsRemote', 'resourceSSL'].map((name) =>
        checkedOf(dom, name),
      ),
    ).toEqual([['1'], ['1'], ['1'], ['top'], ['0'], ['0'], ['0']]);
    expect(selectedOf(dom, 'siteLocale')).toEqual([]);
    expect(named(dom, 'theme')[0]?.options).toEqual([]);
    expect(selectedOf(dom, 'enableLockdown')).toEqual(['']);
    expect(selectedOf(dom, 'reCAPTCHALanguage')).toEqual(['']);
  });

  it('basic: runtime lists, content locking and Add Site id', async () => {
    const m = await modelFor();
    const dom = fragment(
      renderBasicTab({
        ...m,
        requestSiteId: '',
        config: { ...m.config, lockableNodes: true },
        supportedLocales: ['German (Standard)', 'English (US)'],
        themes: ['alt', 'default'],
        hasNonThemeTemplates: true,
        recaptchaLanguages: [
          { label: 'English (UK)', value: 'en-GB' },
          { label: 'Arabic', value: 'ar' },
        ],
      }),
    );
    expect(named(dom, 'siteid').map((c) => [c.type, c.value])).toEqual([['text', tenantA.SiteID]]);
    expect(checkedOf(dom, 'hasLockableNodes')).toEqual(['1']);
    expect(named(dom, 'siteLocale')[0]?.options.map((o) => o.value)).toEqual(['', 'English (US)', 'German (Standard)']);
    expect(selectedOf(dom, 'siteLocale')).toEqual(['English (US)']);
    expect(named(dom, 'theme')[0]?.options.map((o) => o.value)).toEqual(['', 'alt', 'default']);
    expect(selectedOf(dom, 'theme')).toEqual(['default']);
    expect(named(dom, 'reCAPTCHALanguage')[0]?.options.map((o) => o.value)).toEqual(['', 'ar', 'en-GB']);
    expect(selectedOf(dom, 'reCAPTCHALanguage')).toEqual(['', 'en-GB']);
  });

  it('basic: reCAPTCHA notice and invalid export location', async () => {
    const m = await modelFor(siteDetailDefault);
    const $ = $of(renderBasicTab({ ...m, bean: { ...m.bean, exportLocation: '/srv/export' } }));
    expect($('p.help-block:contains("not a valid directory")')).toHaveLength(1);
    expect($('div.help-block-inline')).toHaveLength(1);
    expect($('a[href="http://www.google.com/recaptcha/admin"]')).toHaveLength(1);
  });
});

describe('editsite contact info tab', () => {
  it.each<[string, string | null | undefined]>([
    ['contactName', tenantA.contactName],
    ['contactAddress', tenantA.contactAddress],
    ['contactCity', tenantA.contactCity],
    ['contactState', tenantA.contactState],
    ['contactZip', tenantA.contactZip],
    ['contactPhone', tenantA.contactPhone],
    ['contactEmail', tenantA.contactEmail],
  ])('contact: %s', async (name, expected) => {
    const dom = fragment(renderContactInfoTab(await modelFor()));
    expect(named(dom, name).map((c) => [c.type, c.value])).toEqual([['text', expected]]);
  });
});

describe('editsite shared resources tab', () => {
  const others = SITE_LIST_BY_ORDERNO.filter((s) => s.siteid !== SITE_IDS.tenantA).map((s) => [s.siteid, s.site]);

  it.each<[string, string[]]>([
    ['publicUserPoolID', [SITE_IDS.umbrella]],
    ['privateUserPoolID', []],
    ['displayPoolID', [SITE_IDS.umbrella]],
    ['filePoolID', [SITE_IDS.umbrella]],
    ['categoryPoolID', [SITE_IDS.umbrella]],
  ])('shared resources: %s excludes the site', async (name, expected) => {
    const [select] = named(fragment(renderSharedResourcesTab(await modelFor())), name);
    expect(select?.type).toBe('select-one');
    expect(select?.options.map((o) => [o.value, o.label])).toEqual([['', 'This site'], ...others]);
    expect(select?.selected).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ['stored list', tenantA.contentPoolID ?? '', [SITE_IDS.tenantA]],
    ['other sites', 'umbrella,tenant-b', [SITE_IDS.umbrella, SITE_IDS.tenantB]],
    ['empty elements', ',,tenant-a,,default', [SITE_IDS.tenantA, SITE_IDS.default]],
  ])('shared resources: content pool, %s', async (_case, contentPoolID, expected) => {
    const m = await modelFor();
    const [select] = named(fragment(renderSharedResourcesTab({ ...m, bean: { ...m.bean, contentPoolID } })), 'contentPoolID');
    expect(select?.type).toBe('select-multiple');
    expect(select?.options[0]).toEqual({ value: SITE_IDS.tenantA, label: 'This site', selected: expected.includes(SITE_IDS.tenantA) });
    expect(select?.options.slice(1).map((o) => [o.value, o.label])).toEqual(others);
    expect([...(select?.selected ?? [])].sort()).toEqual([...expected].sort());
  });

  it('shared resources: site admin sees only This site', async () => {
    const dom = fragment(renderSharedResourcesTab(await modelFor(siteDetailTenantA, siteAdmin())));
    expect(named(dom, 'publicUserPoolID')[0]?.options.map((o) => o.value)).toEqual(['']);
    expect(named(dom, 'contentPoolID')[0]?.options.map((o) => o.value)).toEqual([SITE_IDS.tenantA]);
  });
});

describe('editsite modules tab', () => {
  const GROUPS = ['extranet', 'hasFeedManager', 'dataCollection', 'hasComments', 'JSONAPI', 'hasChangesets', 'enforceChangesets', 'showDashboard', 'scaffolding'];

  it.each<[string, SiteDetail, string[]]>([
    ['default', siteDetailDefault, ['0', '1', '1', '1', '0', '1', '0', '0', '1']],
    ['tenant-a', siteDetailTenantA, ['1', '1', '1', '1', '1', '1', '1', '1', '1']],
  ])('modules: Off/On groups for %s', async (_case, detail, expected) => {
    const dom = fragment(renderModulesTab(await modelFor(detail)));
    expect(namesOf(dom)).toEqual(GROUPS);
    for (const name of GROUPS) expect(named(dom, name).map((c) => [c.type, c.value]), name).toEqual([['radio', '0'], ['radio', '1']]);
    expect(GROUPS.map((name) => checkedOf(dom, name).join())).toEqual(expected);
  });

  it('modules: global flags gate Forms Manager, JSON API and Email Broadcaster', async () => {
    const m = await modelFor();
    const dom = fragment(
      renderModulesTab({
        ...m,
        config: { ...m.config, dataCollection: false, useLayoutManager: true, emailBroadcaster: true },
        bean: { ...m.bean, emailBroadcaster: 1 },
      }),
    );
    expect(namesOf(dom)).toEqual(['extranet', 'hasFeedManager', 'hasComments', 'EmailBroadcaster', 'EmailBroadcasterLimit', 'hasChangesets', 'enforceChangesets', 'showDashboard', 'scaffolding']);
    expect(checkedOf(dom, 'EmailBroadcaster')).toEqual(['1']);
    expect(valueOf(dom, 'EmailBroadcasterLimit')).toBe(String(tenantA.emailBroadcasterLimit));
  });
});

describe('editsite email tab', () => {
  it('email: TLS/SSL string radios and server fields', async () => {
    const dom = fragment(renderEmailTab(await modelFor()));
    expect(radios(dom, 'mailServerTLS')).toEqual([['true', true], ['false', false]]);
    expect(radios(dom, 'mailServerSSL')).toEqual([['true', false], ['false', true]]);
    expect(['contact', 'MailServerIP', 'MailServerSMTPPort', 'MailServerPOPPort'].map((name) => valueOf(dom, name))).toEqual([
      tenantA.Contact,
      tenantA.MailserverIP,
      tenantA.mailserverSMTPPort,
      tenantA.mailserverPOPPort,
    ]);
    expect(valueOf(dom, 'contentApprovalScript')).toBe(tenantA.contentApprovalScript);
  });

  it.each<[number, boolean]>([
    [0, false],
    [1, true],
  ])('email: useDefaultSMTPServer=%s disables Test Email Settings: %s', async (useDefaultSMTPServer, disabled) => {
    const m = await modelFor();
    const markup = renderEmailTab({ ...m, bean: { ...m.bean, useDefaultSMTPServer } });
    expect(radios(fragment(markup), 'useDefaultSMTPServer')).toEqual([['1', disabled], ['0', !disabled]]);
    expect($of(markup)('button#testEmailSettings').is('[disabled]')).toBe(disabled);
  });
});


describe('editsite images tab', () => {
  it('images: sizes, custom images and placeholder selector', async () => {
    const markup = renderImagesTab(await modelFor());
    const $ = $of(markup);
    const dom = fragment(markup);
    expect($('div#tabImages h3.block-title').text()).toBe('Image Galleries');
    expect(
      ['smallImageHeight', 'smallImageWidth', 'mediumImageHeight', 'mediumImageWidth', 'largeImageHeight', 'largeImageWidth'].map(
        (name) => valueOf(dom, name),
      ),
    ).toEqual([
      tenantA.smallImageHeight,
      tenantA.smallImageWidth,
      tenantA.mediumImageHeight,
      tenantA.mediumImageWidth,
      tenantA.largeImageHeight,
      tenantA.largeImageWidth,
    ]);
    const script = $('script').text();
    expect(script).toContain('muraAction=cSettings.loadcustomimage&');
    expect(script).toContain('muraAction=cSettings.loadcustomimages&');
    expect($('#custom-images-container')).toHaveLength(1);
    const selector = $('div.mura-file-selector');
    expect(selector).toHaveLength(1);
    expect(selector.attr('data-fileid')).toBe(tenantA.placeholderImgID);
    expect(selector.find('input[type="file"][name="newPlaceholderImg"]')).toHaveLength(1);
    expect($('input[name="deletePlaceholderImg"]')).toHaveLength(0);
  });

  it('images: no custom images without a site id', async () => {
    const m = await modelFor();
    const $ = $of(renderImagesTab({ ...m, bean: { ...m.bean, siteID: '' } }));
    expect($('script')).toHaveLength(0);
    expect($('#custom-images-container')).toHaveLength(0);
    expect($('div.mura-file-selector input[type="file"][name="newPlaceholderImg"]')).toHaveLength(1);
  });
});

describe('editsite file selector', () => {
  const META = { fileId: SITE_DETAIL_IDS.tenantAPlaceholderImgId, fileExt: 'png', imageUrl: '/sites/tenant-a/medium.png' };

  async function options(extra: Partial<FileSelectorOptions> = {}): Promise<FileSelectorOptions> {
    const m = await modelFor();
    return {
      name: 'newPlaceholderImg',
      property: 'placeholderImgID',
      fileId: m.bean.placeholderImgID,
      siteId: m.bean.siteID,
      deleteKey: 'deletePlaceholderImg',
      compactDisplay: 'false',
      locked: '0',
      fileMeta: null,
      rb: m.rb,
      newCacheId: () => 'CACHE-ID',
      ...extra,
    };
  }

  it.each<[string, { hostname: string; apiKey: string } | undefined, number, number]>([
    ['without Razuna', undefined, 0, 0],
    ['with a Razuna hostname', { hostname: 'dam.example.test', apiKey: '' }, 1, 0],
    ['with a Razuna API key', { hostname: '', apiKey: 'not-a-real-key' }, 0, 1],
    ['with both', { hostname: 'dam.example.test', apiKey: 'not-a-real-key' }, 1, 1],
  ])('file selector: %s', async (_case, razuna, button, urlDiv) => {
    const $ = $of(renderFileSelector(await options({ razuna })));
    expect($('div.mura-file-selector').attr('data-filetype')).toBe('File');
    expect($('button.mura-file-type-selector').toArray().map((b) => $(b).attr('value'))).toEqual(
      ['Upload', 'URL', 'Existing', ...(button === 1 ? ['URL-Razuna'] : [])],
    );
    expect($('button.btn-razuna-icon')).toHaveLength(button);
    expect($('div.mura-file-url-razuna')).toHaveLength(urlDiv);
    if (urlDiv === 1) expect($('input.razuna-url').attr('placeholder')).toBe(`http://${razuna?.hostname ?? ''}`);
  });

  it('file tools: nothing without file metadata', async () => {
    expect(toString(renderFileTools(await options()))).toBe('');
  });

  it.each<[string, number]>([
    ['png', 1],
    ['PDF', 0],
  ])('file tools: %s file', async (fileExt, preview) => {
    const $ = $of(renderFileTools(await options({ fileMeta: { ...META, fileExt } })));
    expect($('img#assocImage')).toHaveLength(preview);
    if (preview === 1) expect($('img#assocImage').attr('src')).toBe(`${META.imageUrl}?cacheID=CACHE-ID`);
    expect($('a.download-file').attr('onclick')).toContain(
      `/index.cfm/_api/render/file/?fileid=${tenantA.placeholderImgID}&method=attachment&size=source`,
    );
    expect($('input[type="checkbox"][name="deletePlaceholderImg"]').val()).toBe('1');
  });

  it('file tools: the images tab shows a stored placeholder', async () => {
    const m = await modelFor();
    const $ = $of(renderImagesTab({ ...m, placeholderFile: META }));
    expect($('div.mura-file-selector img#assocImage')).toHaveLength(1);
    expect($('div.mura-file-selector input[name="deletePlaceholderImg"]')).toHaveLength(1);
  });
});

describe('editsite extranet tab', () => {
  it('extranet: registration radios and stored URLs', async () => {
    const dom = fragment(renderExtranetTab(await modelFor()));
    expect(radios(dom, 'extranetpublicreg')).toEqual([['0', false], ['1', true]]);
    expect(['loginURL', 'editProfileURL', 'ExtranetPublicRegNotify'].map((name) => valueOf(dom, name))).toEqual([
      tenantA.loginURL,
      tenantA.editProfileURL,
      tenantA.ExtranetPublicRegNotify,
    ]);
  });

  it('extranet: URL fallbacks for an empty bean value', async () => {
    const detail: SiteDetail = { ...siteDetailTenantA, site: { ...tenantA, loginURL: '', editProfileURL: null } };
    const dom = fragment(renderExtranetTab(await modelFor(detail)));
    expect([valueOf(dom, 'loginURL'), valueOf(dom, 'editProfileURL')]).toEqual(['?display=login', '?display=editProfile']);
  });

  it('extranet: notify list echoed unencoded', async () => {
    const m = await modelFor();
    const markup = toString(renderExtranetTab({ ...m, bean: { ...m.bean, extranetPublicRegNotify: 'a@x.test&b@y.test' } }));
    expect(markup).toContain('name="ExtranetPublicRegNotify" type="text" value="a@x.test&b@y.test"');
  });
});

describe('editsite display regions tab', () => {
  const ONE_TO_TWENTY = Array.from({ length: 20 }, (_, index) => String(index + 1));

  it.each<[string, number, string[]]>([
    ['stored count', 3, ['3']],
    ['stored 0', 0, ['1']],
  ])('display regions: %s', async (_case, columnCount, expected) => {
    const m = await modelFor();
    const dom = fragment(renderDisplayRegionsTab({ ...m, bean: { ...m.bean, columnCount } }));
    expect(named(dom, 'columnCount')[0]?.options.map((o) => o.value)).toEqual(ONE_TO_TWENTY);
    expect(selectedOf(dom, 'columnCount')).toEqual(expected);
    expect(named(dom, 'primaryColumn')[0]?.options.map((o) => o.value)).toEqual(ONE_TO_TWENTY);
    expect(selectedOf(dom, 'primaryColumn')).toEqual([String(tenantA.primaryColumn)]);
    expect(valueOf(dom, 'columnNames')).toBe(tenantA.columnNames);
  });
});

describe('editsite extended attributes tab', () => {
  it('extended attributes: one span per set with its controls', async () => {
    const markup = renderExtendedAttributesTab(await modelFor(siteDetailTenantAWithExtendSets));
    const $ = $of(markup);
    const dom = fragment(markup);
    const sets = siteDetailTenantAWithExtendSets.extendSets;
    expect($('div#tabExtendedAttributes.tab-pane')).toHaveLength(1);
    expect($('span.extendset').toArray().map((s) => $(s).attr('extendsetid'))).toEqual(sets.map((s) => s.extendSetID));
    expect(named(dom, 'extendSetID').map((c) => [c.type, c.value])).toEqual(sets.map((s) => ['hidden', s.extendSetID]));
    expect($('span.extendset h2').toArray().map((h) => $(h).text())).toEqual(sets.map((s) => s.name));
    expect(namesOf(dom).filter((name) => name !== 'extendSetID')).toEqual(
      sets.flatMap((s) => s.attributes.map((a) => a.name)),
    );
    expect(named(dom, 'programCode').map((c) => [c.type, c.value])).toEqual([['text', 'PRG-001']]);
    const [region] = named(dom, 'programRegion');
    expect(region?.options.map((o) => [o.value, o.label])).toEqual([
      ['north', 'North'],
      ['south', 'South'],
      ['east', 'East'],
      ['west', 'West'],
    ]);
    expect(region?.selected).toEqual(['north']);
  });

  it('extended attributes: omitted without sets', async () => {
    expect(toString(renderExtendedAttributesTab(await modelFor()))).toBe('');
  });
});

describe('editsite bundles tab', () => {
  it.each<[string, SiteDetail, string | undefined]>([
    ['default', siteDetailDefault, undefined],
    ['tenant-a', siteDetailTenantA, 'display:none;'],
  ])('bundles: S2 on %s', async (_case, detail, usersStyle) => {
    const markup = renderBundlesTab(await modelFor(detail));
    const $ = $of(markup);
    const dom = fragment(markup);
    expect(radios(dom, 'bundleImportKeyMode')).toEqual([['copy', true], ['publish', false]]);
    expect(radios(dom, 'bundleImportRenderingMode')).toEqual([['all', false], ['theme', false], ['none', true]]);
    expect($('#bundleImportUsersModeLI')).toHaveLength(1);
    expect($('#bundleImportUsersModeLI').attr('style')).toBe(usersStyle);
    expect($('#bundleImportMailingListMembersMode')).toHaveLength(0);
    expect(named(dom, 'serverBundlePath').map((c) => c.type)).toEqual(['text']);
    expect(named(dom, 'bundleFile').map((c) => [c.type, c.value])).toEqual([['hidden', '']]);
  });

  it('bundles: site admin gets Theme Only checked', async () => {
    const markup = renderBundlesTab(await modelFor(siteDetailTenantA, siteAdmin()));
    const dom = fragment(markup);
    expect(named(dom, 'bundleImportKeyMode')).toEqual([]);
    expect(radios(dom, 'bundleImportRenderingMode')).toEqual([['theme', true], ['none', true]]);
    expect($of(markup)('#bundleImportUsersModeLI')).toHaveLength(0);
    expect(named(dom, 'serverBundlePath')).toHaveLength(1);
  });

  it('bundles: upload input and mailing lists with their flags on', async () => {
    const m = await modelFor();
    const markup = renderBundlesTab({ ...m, config: { ...m.config, postBundles: true }, sessionSiteEmailBroadcaster: true });
    const dom = fragment(markup);
    expect(named(dom, 'bundleFile').map((c) => c.type)).toEqual(['file']);
    expect(named(dom, 'bundleImportMailingListMembersMode').map((c) => c.type)).toEqual(['checkbox']);
    expect($of(markup)('strong:contains("(Preferred)")')).toHaveLength(1);
  });

  it('bundles: Java disabled notice', async () => {
    const m = await modelFor();
    const markup = renderBundlesTab({ ...m, config: { ...m.config, javaEnabled: false } });
    expect($of(markup)('div.help-block-empty').text().trim()).toBe('Java is disabled. This feature is unavailable.');
    expect(fragment(markup).controls).toEqual([]);
  });
});

describe('editsite razuna tab', () => {
  it('razuna: nothing when off', async () => {
    expect(toString(renderRazunaTab(await modelFor()))).toBe('');
  });

  it('razuna: empty settings pane when on', async () => {
    const m = await modelFor();
    const markup = renderRazunaTab({ ...m, config: { ...m.config, razuna: true } });
    expect($of(markup)('div#tabRazuna.tab-pane')).toHaveLength(1);
    expect(fragment(markup).controls.map((c) => [c.name, c.type, c.value])).toEqual([
      ['servertype', 'hidden', 'local'],
      ['hostname', 'text', ''],
      ['hostid', 'text', ''],
      ['damPath', 'text', ''],
      ['apikey', 'text', ''],
    ]);
  });
});

describe('editsite model helpers', () => {
  it.each<[boolean, string]>([
    [true, ' checked'],
    [false, ''],
  ])('checked(%s)', (cond, expected) => {
    expect(toString(checked(cond))).toBe(expected);
  });

  it.each<[boolean, string]>([
    [true, ' selected'],
    [false, ''],
  ])('selected(%s)', (cond, expected) => {
    expect(toString(selected(cond))).toBe(expected);
  });

  it.each<[unknown, unknown, boolean]>([
    ['1', 1, true],
    ['true', true, true],
    ['yes', 1, true],
    ['Abc', 'abc', true],
    ['', 0, false],
    [null, '', true],
    ['1.', '1', false],
  ])('cfEq(%j, %j) is %s', (a, b, expected) => {
    expect(cfEq(a, b)).toBe(expected);
  });

  it.each<[string, string, string | undefined, boolean]>([
    ['a,b,c', 'b', undefined, true],
    ['a,b,c', 'd', undefined, false],
    ['a;b', 'b', ';', true],
    ['a,,b', 'b', undefined, true],
    ['a,,b', '', undefined, false],
    ['A,b', 'a', undefined, false],
    ['a;b,c', 'c', ';,', true],
  ])('cfListFind(%j, %j, %j) is %s', (list, value, delim, expected) => {
    expect(cfListFind(list, value, delim)).toBe(expected);
  });
});

