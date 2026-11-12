// Site Settings editor (`csettings.editSite`): `admin/core/views/csettings/editsite.cfm` around its tab partials.
import { cfUuid, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/programs-sites';
import type { CsrfRenderer } from '@/lib/csrf';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import { isSupportedLocale } from '@/lib/resource-bundles/rb';
import type { ShellView } from '@/shell/document';
import { urlScopeNames } from '@/shell/nav';
import type { PageScreen, ScreenContext } from '../registry';
import { renderBasicTab } from './editsite/basic';
import { renderBundlesTab } from './editsite/bundles';
import { renderContactInfoTab } from './editsite/contact-info';
import { renderDisplayRegionsTab } from './editsite/display-regions';
import { renderEmailTab } from './editsite/email';
import { renderExtendedAttributesTab } from './editsite/extended-attributes';
import { renderExtranetTab } from './editsite/extranet';
import { renderImagesTab } from './editsite/images';
import {
  cfEq,
  type EditSiteBean,
  type EditSiteConfig,
  type EditSiteModel,
  type ExtendAttributeType,
  type ExtendAttributeView,
  type ExtendSetView,
  type PluginScriptTab,
  type SiteOption,
} from './editsite/model';
import { renderModulesTab } from './editsite/modules';
import { renderRazunaTab } from './editsite/razuna';
import { renderSharedResourcesTab } from './editsite/shared-resources';

// The frame strings are the bytes ACF emits for editsite.cfm lines 74-150 and 1341-1378, matched against legacy
// captures: whitespace management drops whitespace-only text between two CFML tags, CFML comments leave the text
// around them, and each partial owns its own line range, so the glue below completes each partial's boundary.

type Schemas = components['schemas'];
type Site = Schemas['Site'];
type SiteListItem = Schemas['SiteListItem'];
type SiteExtendSet = Schemas['SiteExtendSet'];
type SiteExtendAttribute = Schemas['SiteExtendAttribute'];

const NOTHING = raw('');
const ACTIVE = raw(' class="active"');
const USE_MURA_DEFAULT = 'useMuraDefault';
/** configBean `getIndexFile()` default, which the login and edit-profile URL fallbacks start with. */
const INDEX_FILE = '';

// programs-sites serves no global configuration, so the flags it does not carry are the configBean defaults
// (configBean.cfc:177,207-210) that its own effective getters assume, `razuna` is globalConfig().getValue('razuna',
// false), and useLayoutManager() is the core contentRenderer's `layoutmanager=false`: a theme that turns the layout
// manager on is in the legacy web root, which web cannot read.
const UNSERVED_CONFIG = Object.freeze({
  lockableNodes: false,
  dataCollection: true,
  emailBroadcaster: false,
  postBundles: false,
  razuna: false,
  useLayoutManager: false,
});

const ATTRIBUTE_TYPES: readonly ExtendAttributeType[] = Object.freeze([
  'TextBox',
  'Text',
  'TextArea',
  'HTMLEditor',
  'SelectBox',
  'MultiSelectBox',
  'RadioGroup',
  'File',
  'Hidden',
]);

/** `contentRenderer.setDynamicContent`'s tag pattern. */
const MURA_TAG = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;

const DELETE_WARNING = encodeJs(
  'WARNING: A deleted site and all of its files cannot be recovered. Are you sure that you want to continue?',
);

const text = (value: string | null | undefined): string => value ?? '';
const numeric = (value: number | null | undefined): number | string => value ?? '';
const truthy = (value: number | null | undefined): boolean => (value ?? 0) !== 0;

/** `rc.siteBean` as its getters return the served `tsettings` row; `config` gates the module getters. */
function beanOf(site: Site, config: EditSiteConfig): EditSiteBean {
  const loginURL = text(site.loginURL);
  const editProfileURL = text(site.editProfileURL);
  return {
    siteID: site.SiteID,
    site: text(site.Site),
    tagline: text(site.tagline),
    domain: text(site.Domain),
    domainAlias: text(site.domainAlias),
    enforcePrimaryDomain: numeric(site.enforcePrimaryDomain),
    useSSL: truthy(site.useSSL) || truthy(site.ExtranetSSL) ? 1 : 0,
    siteLocale: text(site.siteLocale),
    theme: text(site.theme),
    pageLimit: numeric(site.PageLimit),
    nextN: numeric(site.NextN),
    cache: numeric(site.Cache),
    cacheFreeMemoryThreshold: numeric(site.cacheFreeMemoryThreshold),
    locking: text(site.Locking),
    commentApprovalDefault: numeric(site.CommentApprovalDefault),
    exportLocation: text(site.exportLocation),
    customTagGroups: text(site.customTagGroups),
    enableLockdown: text(site.enableLockdown),
    hasLockableNodes: numeric(site.hasLockableNodes),
    isRemote: numeric(site.isremote),
    remoteContext: text(site.remotecontext),
    remotePort: numeric(site.remoteport),
    resourceDomain: text(site.resourceDomain),
    resourceSSL: numeric(site.resourceSSL),
    reCAPTCHASiteKey: text(site.reCAPTCHASiteKey),
    reCAPTCHASecret: text(site.reCAPTCHASecret),
    reCAPTCHALanguage: text(site.reCAPTCHALanguage),
    contactName: text(site.contactName),
    contactAddress: text(site.contactAddress),
    contactCity: text(site.contactCity),
    contactState: text(site.contactState),
    contactZip: text(site.contactZip),
    contactPhone: text(site.contactPhone),
    contactEmail: text(site.contactEmail),
    publicUserPoolID: text(site.publicUserPoolID),
    privateUserPoolID: text(site.privateUserPoolID),
    displayPoolID: text(site.displayPoolID),
    filePoolID: text(site.filePoolID),
    categoryPoolID: text(site.categoryPoolID),
    contentPoolID: text(site.contentPoolID),
    extranet: numeric(site.Extranet),
    hasFeedManager: numeric(site.feedManager),
    dataCollection: config.dataCollection ? numeric(site.DataCollection) : 0,
    hasComments: numeric(site.hasComments),
    JSONApi: numeric(site.JSONApi),
    emailBroadcaster: config.emailBroadcaster ? numeric(site.EmailBroadcaster) : 0,
    emailBroadcasterLimit: numeric(site.emailBroadcasterLimit),
    hasChangesets: numeric(site.hasChangesets),
    enforceChangesets: numeric(site.enforceChangesets),
    showDashboard: numeric(site.showDashboard),
    scaffolding: numeric(site.scaffolding),
    contact: text(site.Contact),
    mailServerIP: text(site.MailserverIP),
    mailServerSMTPPort: text(site.mailserverSMTPPort),
    mailServerPOPPort: text(site.mailserverPOPPort),
    mailServerUsername: text(site.MailServerUsername),
    mailServerPassword: text(site.MailServerPassword),
    mailServerTLS: text(site.mailserverTLS),
    mailServerSSL: text(site.mailserverSSL),
    useDefaultSMTPServer: numeric(site.useDefaultSMTPServer),
    contentPendingScript: text(site.contentPendingScript),
    contentApprovalScript: text(site.contentApprovalScript),
    contentRejectionScript: text(site.contentRejectionScript),
    contentCanceledScript: text(site.contentCanceledScript),
    sendAuthCodeScript: text(site.sendAuthCodeScript),
    sendLoginScript: text(site.sendLoginScript),
    mailingListConfirmScript: text(site.mailingListConfirmScript),
    accountActivationScript: text(site.accountActivationScript),
    reminderScript: text(site.reminderScript),
    smallImageHeight: text(site.smallImageHeight),
    smallImageWidth: text(site.smallImageWidth),
    mediumImageHeight: text(site.mediumImageHeight),
    mediumImageWidth: text(site.mediumImageWidth),
    largeImageHeight: text(site.largeImageHeight),
    largeImageWidth: text(site.largeImageWidth),
    placeholderImgID: text(site.placeholderImgID),
    extranetPublicReg: numeric(site.ExtranetPublicReg),
    loginURL: loginURL !== '' ? loginURL : `${INDEX_FILE}?display=login`,
    editProfileURL: editProfileURL !== '' ? editProfileURL : `${INDEX_FILE}?display=editProfile`,
    extranetPublicRegNotify: text(site.ExtranetPublicRegNotify),
    columnCount: numeric(site.columnCount),
    primaryColumn: numeric(site.primaryColumn),
    columnNames: text(site.columnNames),
  };
}

/**
 * `contentRenderer.setDynamicContent(value)`, which leaves text without Mura tags unchanged.
 * @throws LegacyServiceUnavailableError For a Mura tag, which only the legacy renderer evaluates.
 */
function dynamicContent(value: string): string {
  if (MURA_TAG.test(value)) {
    throw new LegacyServiceUnavailableError(
      'A site extended attribute holds Mura tags only the legacy renderer evaluates',
      'admin',
      'extend-dynamic-content',
    );
  }
  return value;
}

/** `extendAttribute.setType`: trimmed, `text` in any case read as `TextBox`, a listed type in its canonical casing. */
function attributeType(stored: string): ExtendAttributeType {
  const type = stored.trim();
  if (cfEq(type, 'text')) return 'TextBox';
  // renderAttribute's cfswitch renders no control for an unlisted type, as the partial's default branch does, so the
  // stored type is passed on as it is.
  return ATTRIBUTE_TYPES.find((known) => cfEq(known, type)) ?? (type as ExtendAttributeType);
}

// fileManager.readMeta is not served, so a stored File value shows its download link without the image preview.
/** One attribute as the Extended Attributes tab reads it, with `siteBean.getValue(name, 'useMuraDefault')`. */
function attributeView(attribute: SiteExtendAttribute): ExtendAttributeView {
  const name = text(attribute.name);
  const label = text(attribute.label);
  return {
    attributeID: attribute.attributeID,
    name,
    label: label !== '' ? label : name,
    hint: text(attribute.hint),
    type: attributeType(text(attribute.type)),
    validation: text(attribute.validation),
    regex: text(attribute.regex),
    message: text(attribute.message),
    required: text(attribute.required),
    defaultValue: dynamicContent(text(attribute.defaultValue)),
    optionList: dynamicContent(text(attribute.optionList)),
    optionLabelList: dynamicContent(text(attribute.optionLabelList)),
    value: attribute.value ?? USE_MURA_DEFAULT,
    fileExt: '',
  };
}

/** One extend set; `extendSet.getStyle()` returns `''` at the pinned source. */
function extendSetView(set: SiteExtendSet): ExtendSetView {
  return {
    extendSetID: set.extendSetID,
    categoryID: text(set.categoryID),
    name: text(set.name),
    style: '',
    attributes: set.attributes.map(attributeView),
  };
}

const siteOption = (row: SiteListItem): SiteOption => ({ siteid: row.siteid, site: text(row.site) });

/**
 * `csettings.editSite()` (`rc.siteBean = settingsManager.read(rc.siteid)`) plus every value the view reads.
 * @throws LegacyServiceUnavailableError For Add Site (`rc.siteid` empty): programs-sites defines no operation that
 *   serves a new site's defaults, so the page fails closed instead of inventing them.
 * @throws GatewayDenialError When programs-sites refuses a read (401 or 403).
 */
export async function loadEditSiteModel(ctx: ScreenContext): Promise<EditSiteModel> {
  const { req, gateway } = ctx;
  const requestSiteId = req.rc.siteid ?? '';
  if (requestSiteId === '') {
    throw new LegacyServiceUnavailableError('programs-sites serves no new-site representation', 'admin', 'add-site');
  }
  // settingsManager.getList() lists every site by orderno; programs-sites lists sites to S2 users only, so a site
  // admin's pool selects offer no other site.
  const [detail, sites] = await Promise.all([
    gateway.programsSites.getSite(requestSiteId).then((res) => okBody(res, 'programs-sites', 'getSite')),
    req.isS2
      ? gateway.programsSites
          .listSites({ sortBy: 'orderno', sortDirection: 'asc' })
          .then((res) => okBody(res, 'programs-sites', 'listSites').map(siteOption))
      : Promise.resolve<SiteOption[]>([]),
  ]);
  const config: EditSiteConfig = { javaEnabled: legacySettings().javaEnabled, ...UNSERVED_CONFIG };
  const { session } = req;
  // Values legacy reads from the ColdFusion runtime or the legacy web root that SiteDetail does not carry take the
  // branch legacy renders for none: no themes, locales, reCAPTCHA languages, plugin tabs, export directory or file
  // metadata.
  return {
    bean: beanOf(detail.site, config),
    config,
    rb: ctx.rb,
    isSupportedLocale,
    isS2: req.isS2,
    requestSiteId,
    rcAction: req.rc.action ?? '',
    compactDisplay: req.rc.compactDisplay ?? 'false',
    addSite: urlScopeNames(req).has('addsite'),
    // req.site is getSite(session.siteid), with its default-site fallback; unserved, the broadcaster reads as off.
    sessionSiteEmailBroadcaster: req.site?.emailBroadcaster ?? false,
    exportLocationExists: false,
    sites,
    themes: [],
    hasNonThemeTemplates: false,
    supportedLocales: [],
    recaptchaLanguages: [],
    extendSets: detail.extendSets.map(extendSetView),
    pluginScriptTabs: [],
    placeholderFile: null,
    dateKeyFormat: session.dateKeyFormat,
    locale: session.locale,
    localeHasDayParts: session.localeHasDayParts,
    now: ctx.now,
    newCacheId: cfUuid,
  };
}

/** The module buttons of a named site (lines 88-99). */
function moduleButtons(m: EditSiteModel): SafeHtml {
  const siteIdUrl = raw(encodeUrl(m.requestSiteId));
  const editSite = cfEq(m.rcAction, 'updateFiles')
    ? html`\n\t\t\t\t<a class="btn" href="./?muraAction=cSettings.editSite&siteid=${siteIdUrl}"><i class="mi-pencil"></i> Edit Site</a>\n\t\t\t`
    : NOTHING;
  const bundle = m.config.javaEnabled
    ? html`\n\t\t\t\t<a  class="btn" href="?muraAction=cSettings.selectBundleOptions&siteID=${raw(encodeUrl(m.bean.siteID))}"><i class="mi-gift"></i> Create Site Bundle</a>\n\t\t\t`
    : NOTHING;
  const location = m.bean.exportLocation;
  const exportHtml =
    location !== '' && m.exportLocationExists
      ? html`\n\t\t\t\t<a  class="btn" href="#" onclick="confirmDialog('Export static HTML files to ${raw(encodeJs(`'${location}'`))}.',function(){actionModal('./?muraAction=csettings.exportHTML&siteID=${raw(m.bean.siteID)}')});return false;"><i class="mi-share"></i> Export Static HTML (BETA)</a>\n\t\t\t`
      : NOTHING;
  const trash = m.isS2
    ? html` <a  class="btn" href="./?muraAction=cTrash.list&siteID=${siteIdUrl}"><i class="mi-trash"></i> Trash Bin</a>`
    : NOTHING;
  return html`\n\t\t\t<div class="nav-module-specific btn-group">\n\t\t\t${editSite}${bundle}${exportHtml}\n\t\t\t<a class="btn" href="./?muraAction=cExtend.listSubTypes&siteid=${siteIdUrl}"><i class="mi-list-alt"></i> Class Extensions</a>  ${trash}\n\t\t</div>\n\t`;
}

/** `div.mura-header` (lines 85-101). */
function header(m: EditSiteModel): SafeHtml {
  const buttons = m.requestSiteId === '' ? NOTHING : moduleButtons(m);
  return html`<div class="mura-header">\n\t\t<h1>${m.addSite ? 'Add Site' : 'Site Settings'}</h1>\n\t${buttons}\n\t</div>`;
}

interface Tab {
  readonly id: string;
  readonly label: string;
}

/** `tabList` and `tabLabelList` (lines 126-142), paired. */
function tabsOf(m: EditSiteModel): Tab[] {
  const hasExtendSets = m.extendSets.length > 0;
  const tab = (id: string, label: string): Tab => ({ id, label });
  return [
    tab('tabBasic', 'Basic'),
    tab('tabContactinfo', 'Contact Info'),
    tab('tabSharedresources', 'Shared Resources'),
    tab('tabModules', hasExtendSets ? 'Admin Modules' : 'Modules'),
    tab('tabEmail', 'Email'),
    tab('tabImages', 'Images'),
    tab('tabExtranet', 'Extranet'),
    tab('tabDisplayregions', 'Display Regions'),
    ...(hasExtendSets ? [tab('tabExtendedAttributes', 'Extended Attributes')] : []),
    tab('tabBundles', 'Deploy Bundle'),
    ...(m.config.razuna ? [tab('tabRazuna', 'Razuna')] : []),
    ...m.pluginScriptTabs.map((plugin) => tab(`tab${plugin.cssId}`, plugin.name)),
  ];
}

/** The tab strip (lines 144-148); ids and labels are emitted unencoded, as legacy writes them. */
function tabStrip(tabs: readonly Tab[]): SafeHtml {
  const items = tabs.map(
    ({ id, label }, index) =>
      html`\n\t\t\t\t<li${index === 0 ? ACTIVE : NOTHING}><a href="#${raw(id)}" onclick="return false;"><span>${raw(label)}</span></a></li>\n\t\t\t`,
  );
  return html`<ul class="mura-tabs nav-tabs" data-toggle="tabs">\n\t\t\t\t${join(items)}\n\t\t\t</ul>`;
}

// No legacy capture with an onSiteEdit script exists; the pane keeps the source lines' indentation.
/** One plugin pane (lines 1347-1363) with the plugin's rendered markup. */
function pluginPane(plugin: PluginScriptTab): SafeHtml {
  return html`\n\t\t\n\t\t<div id="tab${raw(plugin.cssId)}" class="tab-pane">\n\t\t\t\n\t\t\t\t<div class="block block-bordered">\n\t\t\t\t\t<!-- block header -->\n\t\t\t\t  <div class="block-header">\n\t\t\t\t\t\t<h3 class="block-title">${raw(plugin.name)}</h3>\n\t\t\t\t  </div><!-- /block header -->\n\t\t\t\t  <div class="block-content">\n\t\t\t\t\t\t\n\t\t\t\t\t\t\t${plugin.html}\n\t\t\t\t\t\t\n\t\t\t\t\t</div> \n\t\t\t\t</div> \n\t\t\t\n\t\t</div> \n\t`;
}

/** Every tab pane in legacy order (lines 150-1364); each partial owns its source lines, the glue joins them. */
function tabPanes(m: EditSiteModel): SafeHtml {
  const gap = raw('\n\n\t\t\n');
  return html`${renderBasicTab(m)}${gap}${renderContactInfoTab(m)}\n\t\t\n${renderSharedResourcesTab(m)}${gap}${renderModulesTab(m)}\n\t\t\n${renderEmailTab(m)}${gap}${renderImagesTab(m)}${gap}${renderExtranetTab(m)}${gap}\t\t${renderDisplayRegionsTab(m)}\n\t\t\n\t\t${renderExtendedAttributesTab(m)}${gap}${renderBundlesTab(m)}\t${renderRazunaTab(m)}${join(m.pluginScriptTabs.map(pluginPane))} `;
}

/** The `actionButtons` save content (lines 110-125): Add for a new site, else Delete (S2, not `default`) and Save. */
function actionButtons(m: EditSiteModel, csrf: CsrfRenderer): SafeHtml {
  const siteID = raw(m.bean.siteID);
  const deleteButton =
    !cfEq(m.bean.siteID, 'default') && m.isS2
      ? html`\n\t\t\t\t\t\t<button type="button" class="btn" onclick="return confirmDialog('${raw(DELETE_WARNING)}',function(){actionModal('./?muraAction=cSettings.updateSite&action=delete&siteid=${siteID}${csrf.render(m.requestSiteId, 'url')}')});"><i class="mi-trash"></i> Delete</button>\n\t\t\t\t\t`
      : NOTHING;
  const buttons =
    m.bean.siteID === ''
      ? html`\n\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');"><i class="mi-plus-circle"></i> Add</button>\n\t\t\t\t\t`
      : html`${deleteButton}\n\t\t\t\t\t<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i> Save Settings</button>\n\t\t\t\t`;
  return html`\n\t\t\t<div class="mura-actions">\n\t\t\t\t<div class="form-actions">\n\t\t\t\t${buttons}\n\t\t\t\t</div> <!-- /.form-actions -->\n\t\t\t</div> <!-- /.mura-actions -->\n\t\t`;
}

/** The view body: header, form, tab strip, panes and footer; CSRF tokens for `rc.siteid` must be fetched. */
function renderEditSite(m: EditSiteModel, csrf: CsrfRenderer): SafeHtml {
  // Captures show one space before the action buttons whenever rc.siteid is set and none on Add Site.
  const beforeActions = m.requestSiteId === '' ? NOTHING : raw(' ');
  return html`\n\t\n\t${header(m)}\n\n\t\t<form novalidate method ="post"  enctype="multipart/form-data" action="./?muraAction=cSettings.updateSite" name="form1"  onsubmit="return validate(this);">\n\t\t\n\t\t\n\t\t<div class="block block-constrain">\n\t\t${tabStrip(tabsOf(m))}\n\t\t<div class="block-content tab-content">\n\t\t\n\t\t${tabPanes(m)}\n\n\n\t\t<div class="load-inline tab-preloader"></div>\n\t\t<script>$('.tab-preloader').spin(spinnerArgs2);</script>\n\t\t${beforeActions}${actionButtons(m, csrf)}\n\t\t\t<input type="hidden" name="action" value="update">\n\t\t\t${csrf.render(m.requestSiteId, 'form')} \n\n\t\t</div>\t\n\t</div>\t\n\n</form>\n`;
}

/** The `csettings.editsite` page; `index.ts` adds its circuit, action, mode, owner and gate. */
export const editSiteScreen: Required<Pick<PageScreen<EditSiteModel>, 'load' | 'render'>> = Object.freeze({
  load: loadEditSiteModel,
  async render(ctx: ScreenContext, model: EditSiteModel): Promise<ShellView> {
    await ctx.csrf.prefetch([model.requestSiteId]);
    return { body: renderEditSite(model, ctx.csrf) };
  },
});
