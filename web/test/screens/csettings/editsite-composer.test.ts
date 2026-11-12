import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { raw, toString } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { editSiteScreen, loadEditSiteModel } from '@/screens/csettings/editsite';
import { renderBasicTab } from '@/screens/csettings/editsite/basic';
import { renderBundlesTab } from '@/screens/csettings/editsite/bundles';
import { renderContactInfoTab } from '@/screens/csettings/editsite/contact-info';
import { renderDisplayRegionsTab } from '@/screens/csettings/editsite/display-regions';
import { renderEmailTab } from '@/screens/csettings/editsite/email';
import { renderExtendedAttributesTab } from '@/screens/csettings/editsite/extended-attributes';
import { renderExtranetTab } from '@/screens/csettings/editsite/extranet';
import { renderImagesTab } from '@/screens/csettings/editsite/images';
import type { EditSiteModel } from '@/screens/csettings/editsite/model';
import { renderModulesTab } from '@/screens/csettings/editsite/modules';
import { renderRazunaTab } from '@/screens/csettings/editsite/razuna';
import { renderSharedResourcesTab } from '@/screens/csettings/editsite/shared-resources';
import type { ScreenContext } from '@/screens/registry';
import { siteDefault, siteTenantA, siteTenantB, SITE_LIST_BY_ORDERNO } from '../../fixtures/programs-sites/sites';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

// View bodies captured from the legacy oracle with each partial's output replaced by `{{<partial>}}` and the CSRF
// values replaced by X: the bytes this composer owns.
const FRAMES = JSON.parse(
  readFileSync(new URL('../../fixtures/csettings/editsite-frames.json', import.meta.url), 'utf8'),
) as Record<'default' | 'updatefiles' | 'unknown' | 'addsite', string>;

const PARTIALS = [
  ['basic', renderBasicTab],
  ['contact-info', renderContactInfoTab],
  ['shared-resources', renderSharedResourcesTab],
  ['modules', renderModulesTab],
  ['email', renderEmailTab],
  ['images', renderImagesTab],
  ['extranet', renderExtranetTab],
  ['display-regions', renderDisplayRegionsTab],
  ['extended-attributes', renderExtendedAttributesTab],
  ['bundles', renderBundlesTab],
  ['razuna', renderRazunaTab],
] as const;

const SET_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites');
const NEW_SITE = { SiteID: '' };

type Attribute = Record<string, unknown>;

function attribute(overrides: Attribute = {}): Attribute {
  return {
    attributeID: 7,
    extendSetID: 'SET1',
    siteID: 'tenant-b',
    name: 'color',
    label: '',
    hint: null,
    type: ' text ',
    orderno: 1,
    isActive: 1,
    required: 'false',
    validation: null,
    regex: null,
    message: null,
    defaultValue: 'blue',
    optionList: null,
    optionLabelList: null,
    adminonly: 0,
    value: null,
    ...overrides,
  };
}

const extendSet = (attributes: Attribute[]) => ({
  extendSetID: 'SET1',
  subTypeID: 'ST1',
  categoryID: null,
  siteID: 'tenant-b',
  name: 'Extra',
  orderno: 1,
  isActive: 1,
  container: 'Default',
  attributes,
});

/** programs-sites and identity answering for `siteId`; CSRF pairs are `X`/`X` for every context. */
function gatewayFor(siteId: string, site: unknown, extendSets: unknown[] = []): FakeGatewayClient {
  return fakeGatewayClient({
    [routeKey('GET', 'programs-sites', `/v1/sites/${siteId}`)]: {
      status: 200,
      body: { site, isNew: site === NEW_SITE ? 1 : 0, extendSets, imageSizes: [] },
    },
    [SET_ROUTE]: { status: 200, body: SITE_LIST_BY_ORDERNO },
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: (request) => ({
      status: 200,
      body: {
        tokens: (request.json as { contexts: string[] }).contexts.map((context) => ({
          context,
          csrf_token: 'X',
          csrf_token_expires: 'X',
        })),
      },
    }),
  });
}

function editSiteRequest(rc: Record<string, string>, headers?: Headers): AdminRequest {
  return adminS2Request({ circuit: 'csettings', item: 'editsite', rc, ...(headers ? { headers } : {}) });
}

function contextOf(gateway: FakeGatewayClient, req: AdminRequest): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor(req.session.rb),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00'),
  };
}

async function renderBody(ctx: ScreenContext, model: EditSiteModel): Promise<string> {
  return toString((await editSiteScreen.render(ctx, model)).body);
}

/** `body` with each non-empty partial output, in legacy order, replaced by its marker. */
function frameOf(body: string, m: EditSiteModel): string {
  let frame = '';
  let at = 0;
  for (const [name, render] of PARTIALS) {
    const part = toString(render(m));
    if (part === '') continue;
    const index = body.indexOf(part, at);
    expect(index, name).toBeGreaterThanOrEqual(at);
    frame += `${body.slice(at, index)}{{${name}}}`;
    at = index + part.length;
  }
  return frame + body.slice(at);
}

const tabsOf = (body: string): Array<[string, string, boolean]> => {
  const $ = cheerio.load(body);
  return $('ul.mura-tabs li')
    .toArray()
    .map((li) => [$(li).find('a').attr('href') ?? '', $(li).find('span').text(), $(li).hasClass('active')]);
};

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
  restoreEnv();
});

describe('csettings.editsite frame bytes', () => {
  it.each<[keyof typeof FRAMES, string, unknown, Record<string, string>, Partial<EditSiteModel>]>([
    ['default', 'default', siteDefault, { siteid: 'default' }, {}],
    ['updatefiles', 'default', siteDefault, { siteid: 'default', action: 'updateFiles' }, {}],
    ['unknown', 'zzznosuch', NEW_SITE, { siteid: 'zzznosuch' }, {}],
    ['addsite', 'zzznosuch', NEW_SITE, { siteid: 'zzznosuch' }, { requestSiteId: '', addSite: true }],
  ])('%s matches the legacy capture', async (name, siteId, site, rc, patch) => {
    const ctx = contextOf(gatewayFor(siteId, site), editSiteRequest(rc));
    const model = { ...(await loadEditSiteModel(ctx)), ...patch };
    expect(frameOf(await renderBody(ctx, model), model)).toBe(FRAMES[name]);
  });
});

describe('csettings.editsite loader', () => {
  it('reads the site, lists sites by orderno for S2 and fetches the site id CSRF context', async () => {
    const gateway = gatewayFor('default', siteDefault);
    const ctx = contextOf(gateway, editSiteRequest({ siteid: 'default' }));
    const model = await loadEditSiteModel(ctx);
    await renderBody(ctx, model);
    expect(model.sites).toEqual(SITE_LIST_BY_ORDERNO.map(({ siteid, site }) => ({ siteid, site })));
    expect(gateway.calls.find((call) => call.path === '/v1/sites')?.query).toEqual({
      sortBy: 'orderno',
      sortDirection: 'asc',
    });
    expect(gateway.calls.find((call) => call.service === 'identity')?.json).toEqual({ contexts: ['default'] });
    expect(model).toMatchObject({ requestSiteId: 'default', rcAction: '', compactDisplay: 'false', addSite: false });
    expect(model.config).toEqual({
      javaEnabled: true,
      lockableNodes: false,
      dataCollection: true,
      emailBroadcaster: false,
      postBundles: false,
      razuna: false,
      useLayoutManager: false,
    });
  });

  it('applies the settingsBean getters to the served row', async () => {
    const site = {
      ...siteDefault,
      useSSL: 0,
      ExtranetSSL: 1,
      loginURL: null,
      editProfileURL: '',
      EmailBroadcaster: 1,
      DataCollection: 1,
      contactName: null,
      remoteport: null,
    };
    const { bean } = await loadEditSiteModel(contextOf(gatewayFor('default', site), editSiteRequest({ siteid: 'default' })));
    expect(bean).toMatchObject({
      siteID: 'default',
      useSSL: 1,
      loginURL: '?display=login',
      editProfileURL: '?display=editProfile',
      emailBroadcaster: 0,
      dataCollection: 1,
      contactName: '',
      remotePort: '',
      pageLimit: 1000,
      locking: 'none',
    });
  });

  it('maps extend sets as setType, getLabel and getValue read them', async () => {
    const sets = [extendSet([attribute(), attribute({ attributeID: 8, name: 'size', label: 'Size', type: 'selectbox', value: 'L' }), attribute({ attributeID: 9, type: 'Widget' })])];
    const model = await loadEditSiteModel(contextOf(gatewayFor('tenant-b', siteTenantB, sets), editSiteRequest({ siteid: 'tenant-b' })));
    expect(model.extendSets).toHaveLength(1);
    expect(model.extendSets[0]).toMatchObject({ extendSetID: 'SET1', categoryID: '', name: 'Extra', style: '' });
    expect(model.extendSets[0]?.attributes.map(({ type, label, value }) => [type, label, value])).toEqual([
      ['TextBox', 'color', 'useMuraDefault'],
      ['SelectBox', 'Size', 'L'],
      ['Widget', 'color', 'useMuraDefault'],
    ]);
  });

  it('gives a site admin no other sites without asking programs-sites for the list', async () => {
    const gateway = gatewayFor('tenant-a', siteTenantA);
    const req = siteAdminRequest('tenant-a', { circuit: 'csettings', item: 'editsite', rc: { siteid: 'tenant-a' } });
    const model = await loadEditSiteModel(contextOf(gateway, req));
    expect(model.isS2).toBe(false);
    expect(model.sites).toEqual([]);
    expect(gateway.calls.some((call) => call.path === '/v1/sites')).toBe(false);
  });

  it('reads addsite from the URL scope only', async () => {
    const target = '/admin/?muraAction=cSettings.editSite&siteid=default&addsite';
    const fromUrl = editSiteRequest({ siteid: 'default' }, new Headers({ [ORIGINAL_URL_HEADER]: target }));
    const fromForm = editSiteRequest({ siteid: 'default', addsite: '' });
    expect((await loadEditSiteModel(contextOf(gatewayFor('default', siteDefault), fromUrl))).addSite).toBe(true);
    expect((await loadEditSiteModel(contextOf(gatewayFor('default', siteDefault), fromForm))).addSite).toBe(false);
  });

  it('takes javaEnabled from the Masa settings', async () => {
    vi.stubEnv('MURA_JAVAENABLED', 'false');
    resetLegacySettingsForTests();
    const model = await loadEditSiteModel(contextOf(gatewayFor('default', siteDefault), editSiteRequest({ siteid: 'default' })));
    expect(model.config.javaEnabled).toBe(false);
  });

  it('fails closed on Add Site without calling a service', async () => {
    const gateway = gatewayFor('default', siteDefault);
    await expect(loadEditSiteModel(contextOf(gateway, editSiteRequest({ siteid: '' })))).rejects.toMatchObject({
      name: 'LegacyServiceUnavailableError',
      surface: 'admin',
      reason: 'add-site',
    });
    expect(gateway.calls).toEqual([]);
  });

  it.each(['defaultValue', 'optionList', 'optionLabelList'])('fails closed on a Mura tag in %s', async (field) => {
    const sets = [extendSet([attribute({ [field]: 'a^[m]esapiEncode("html","b")[/m]' })])];
    const ctx = contextOf(gatewayFor('tenant-b', siteTenantB, sets), editSiteRequest({ siteid: 'tenant-b' }));
    await expect(loadEditSiteModel(ctx)).rejects.toMatchObject({ reason: 'extend-dynamic-content' });
  });

  it('propagates a denial and unavailability', async () => {
    const gateway = gatewayFor('default', siteDefault);
    gateway.setRoute(routeKey('GET', 'programs-sites', '/v1/sites/default'), { status: 403, body: {} });
    const ctx = contextOf(gateway, editSiteRequest({ siteid: 'default' }));
    await expect(loadEditSiteModel(ctx)).rejects.toBeInstanceOf(GatewayDenialError);
    gateway.failWith();
    await expect(loadEditSiteModel(ctx)).rejects.toBeInstanceOf(GatewayUnavailableError);
  });
});

describe('csettings.editsite render', () => {
  it('offers Delete to S2 on a non-default site, with the site id CSRF query', async () => {
    const ctx = contextOf(gatewayFor('tenant-a', siteTenantA), editSiteRequest({ siteid: 'tenant-a' }));
    const $ = cheerio.load(await renderBody(ctx, await loadEditSiteModel(ctx)));
    const onclick = $('button:contains("Delete")').attr('onclick') ?? '';
    expect(onclick).toMatch(/^return confirmDialog\('WARNING\\x3A\\x20A\\x20deleted\\x20site/);
    expect(onclick).toContain(
      "actionModal('./?muraAction=cSettings.updateSite&action=delete&siteid=tenant-a&csrf_token=X&csrf_token_expires=X')",
    );
    expect($('a:contains("Trash Bin")').attr('href')).toBe('./?muraAction=cTrash.list&siteID=tenant-a');
  });

  it('shows a site admin neither Delete nor Trash Bin', async () => {
    const req = siteAdminRequest('tenant-a', { circuit: 'csettings', item: 'editsite', rc: { siteid: 'tenant-a' } });
    const ctx = contextOf(gatewayFor('tenant-a', siteTenantA), req);
    const body = await renderBody(ctx, await loadEditSiteModel(ctx));
    const $ = cheerio.load(body);
    expect($('button:contains("Delete")')).toHaveLength(0);
    expect($('a:contains("Trash Bin")')).toHaveLength(0);
    expect(body).toContain('Class Extensions</a>  \n\t\t</div>');
  });

  it('adds Extended Attributes, Razuna and plugin tabs with one pane each, Java off and the export link', async () => {
    const ctx = contextOf(gatewayFor('tenant-b', siteTenantB, [extendSet([attribute()])]), editSiteRequest({ siteid: 'tenant-b' }));
    const loaded = await loadEditSiteModel(ctx);
    const model: EditSiteModel = {
      ...loaded,
      bean: { ...loaded.bean, exportLocation: "/srv/o'x" },
      exportLocationExists: true,
      config: { ...loaded.config, razuna: true, javaEnabled: false },
      pluginScriptTabs: [{ name: 'My Plugin', cssId: 'my-plugin', html: raw('<p>plug</p>') }],
    };
    const body = await renderBody(ctx, model);
    const $ = cheerio.load(body);
    const tabs = tabsOf(body);
    expect(tabs.map(([href, label]) => [href, label])).toEqual([
      ['#tabBasic', 'Basic'],
      ['#tabContactinfo', 'Contact Info'],
      ['#tabSharedresources', 'Shared Resources'],
      ['#tabModules', 'Admin Modules'],
      ['#tabEmail', 'Email'],
      ['#tabImages', 'Images'],
      ['#tabExtranet', 'Extranet'],
      ['#tabDisplayregions', 'Display Regions'],
      ['#tabExtendedAttributes', 'Extended Attributes'],
      ['#tabBundles', 'Deploy Bundle'],
      ['#tabRazuna', 'Razuna'],
      ['#tabmy-plugin', 'My Plugin'],
    ]);
    expect(tabs.map(([, , active]) => active)).toEqual(tabs.map((_, index) => index === 0));
    for (const [href] of tabs) expect($(`div${href}.tab-pane`)).toHaveLength(1);
    expect($('#tabmy-plugin h3.block-title').text()).toBe('My Plugin');
    expect($('#tabmy-plugin .block-content p').text()).toBe('plug');
    expect($('a:contains("Create Site Bundle")')).toHaveLength(0);
    expect($('a:contains("Export Static HTML (BETA)")').attr('onclick')).toBe(
      "confirmDialog('Export static HTML files to \\x27\\x2Fsrv\\x2Fo\\x27x\\x27.',function(){actionModal('./?muraAction=csettings.exportHTML&siteID=tenant-b')});return false;",
    );
  });

  it('returns the body alone, for the shell to wrap', async () => {
    const ctx = contextOf(gatewayFor('default', siteDefault), editSiteRequest({ siteid: 'default' }));
    const view = await editSiteScreen.render(ctx, await loadEditSiteModel(ctx));
    expect(Object.keys(view)).toEqual(['body']);
  });
});
