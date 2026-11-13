// The carch secondary menu and shell hook against carch/dsp_secondary_menu.cfm and the ACF 2023 oracle.
import { describe, expect, it } from 'vitest';
import type { CsrfRenderer } from '@/lib/csrf';
import { encodeHtml, encodeHtmlAttr, isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest, RequestContext } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  bindCarchSecondaryMenu,
  carchSecondaryMenu,
  carchSecondaryMenuCsrfContexts,
  renderCarchSecondaryMenu,
  type CarchMenuContent,
  type CarchSecondaryMenuInput,
} from '@/screens/carch/secondary-menu';
import { makeAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { SUBJECTS, type WebTestSubjectKey } from '../../helpers/tokens';

const SITE_MANAGER = '00000000000000000000000000000000000';
const ROOT = '00000000000000000000000000000000001';
const COMPONENTS = '00000000000000000000000000000000003';
const FORMS = '00000000000000000000000000000000004';
const VARIATIONS = '00000000000000000000000000000000099';
const END = '00000000000000000000000000000000END';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NODE = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const NODE_HIST = '1B2C3D4E-5F60-4718-293A4B5C6D7E8F90';
const PARENT = '0A1B2C3D-4E5F-4061-728394A5B6C7D8E9';
const FILE_ID = '5D4C3B2A-1F0E-4D9C-8B7A695847362514';
const OTHER_USER = '9F8E7D6C-5B4A-4392-8170FEDCBA987654';
const EN = rbFor('en_US');

/** url-format tokens of every context, as identity issues them once fetched. */
const TOKENS: Pick<CsrfRenderer, 'render'> = {
  render: (context, format) => raw(`&csrf_token=${format ?? 'form'}.${context}&csrf_token_expires=E`),
};
const token = (context: string): string => `&csrf_token=url.${context}&csrf_token_expires=E`;
// The oracle's token pair varies per request, so the fake renderer's pair stands in for it.
const CLEAR_TOKEN = token(`${ROOT}deletehistall`);

/** `rc` values carch `before()` params for a request that names none of them. */
const CARCH_RC: Readonly<Record<string, string>> = {
  return: '',
  startrow: '1',
  contentid: '',
  type: 'Page',
  contenthistid: NODE_HIST,
  parentid: '',
  action: '',
  homeID: '',
};

const HOME_RC = { contentid: ROOT, type: 'Page', parentid: END, topid: ROOT, moduleid: SITE_MANAGER };
const MULTI_RC = { contentid: '', parentid: ROOT, topid: ROOT, moduleid: SITE_MANAGER, type: 'File' };
const HOME_EDIT_URL =
  `/admin/?muraAction=cArch.edit&contenthistid=${HOME_HIST}&contentid=${ROOT}&type=Page&siteid=default` +
  `&topid=${ROOT}&parentid=${END}&moduleid=${SITE_MANAGER}&compactdisplay=false`;

const HOME: CarchMenuContent = {
  isNew: false,
  type: 'Page',
  subType: 'Default',
  active: 1,
  filename: '',
  contentHistId: HOME_HIST,
  parentId: END,
  menuTitle: 'Home',
  remoteUrl: '',
  fileId: '',
  stats: {},
};

/** A saved non-root node under PARENT, `partial` laid over it. */
const node = (partial: Partial<CarchMenuContent> = {}): CarchMenuContent => ({
  ...HOME,
  contentHistId: NODE_HIST,
  parentId: PARENT,
  menuTitle: 'News',
  filename: 'news',
  ...partial,
});

const SAVED: CarchSecondaryMenuInput = {
  perm: 'editor',
  deletable: false,
  hasLockableNodes: false,
  purgeDrafts: false,
};
const LOCKED: CarchSecondaryMenuInput = { hasLockableNodes: true };
const LOCK_STATS = { lockID: OTHER_USER, lockType: 'node' };

/** A carch request on `item` for `subject`, its `rc` as the controller leaves it. */
function carch(
  item: string,
  rc: Readonly<Record<string, string>>,
  subject: WebTestSubjectKey = 'admin',
  session?: AdminRequestPartial['session'],
): AdminRequest {
  return makeAdminRequest({ circuit: 'cArch', item, rc: { ...CARCH_RC, ...rc }, session }, subject);
}

/** The markup string, after checking it is markup the shell embeds unescaped. */
function markupOf(menu: SafeHtml): string {
  expect(isSafeHtml(menu)).toBe(true);
  return toString(menu);
}

const render = (req: AdminRequest, input: CarchSecondaryMenuInput, rb: RbLookup = EN): string =>
  markupOf(renderCarchSecondaryMenu({ req, rb, csrf: TOKENS }, input));

const linksOf = (markup: string): DomLink[] => fragmentModel(markup).links;

/** A legacy href and text as the DOM model normalises them. */
const link = (href: string, text: string): DomLink => ({ href: normaliseAdminUrl(href), text });

const ACTIONS = link('#', 'Actions');
const RECURSIVE_CONFIRM =
  'Deleting\\x20\\x27News\\x27\\x20will\\x20also\\x20delete\\x20all\\x20content\\x20nested\\x20beneath\\x20it';
const EMPTY_MENU = '\n<div class="nav-module-specific btn-group">\n\t\n</div>\n';

// dsp_secondary_menu.cfm as the ACF 2023 oracle served it on `default`, to the admin unless named otherwise.
const HOME_HIST_HEAD =
  `\n<div class="nav-module-specific btn-group">\n\t\n\n` +
  `\t\t\t\t<a class="btn" href="./?muraAction=cArch.list&siteid=default` +
  `&moduleid=${SITE_MANAGER}"><i class="mi-arrow-circle-left"></i> Return to Content Manager</a>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t<div class="btn-group">\n` +
  `\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n` +
  `\t\t\t\t\t\t<i class="mi-cogs"></i> Actions\n` +
  `\t\t\t\t\t\t<span class="caret"></span>\n` +
  `\t\t\t\t\t  </a>\n` +
  `\t\t\t\t  <ul class="dropdown-menu drop-right">\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t\t\t<li>\n` +
  `\t\t\t\t\t\t\t<a href="./?muraAction=cArch.update&action=deletehistall&contentid=${ROOT}&type=Page` +
  `&parentid=${END}&topid=${ROOT}&siteid=default&startrow=1&moduleid=${SITE_MANAGER}` +
  `&compactDisplay=false${CLEAR_TOKEN}"` +
  ` onclick="return confirmDialog('Clear\\x20Version\\x20History\\x3F',this.href)">\n` +
  `\t\t\t\t\t\t\t\t<i class="mi-eraser"></i> Clear Version History\n` +
  `\t\t\t\t\t\t\t</a>\n` +
  `\t\t\t\t\t\t</li>\n` +
  `\t\t\t\t\t\n`;
const LEGACY_HOME_HIST =
  HOME_HIST_HEAD +
  `\t\t\t\t\t<li><a href="./?muraAction=cPerm.main&contentid=${ROOT}&type=Page&parentid=${END}&topid=${ROOT}` +
  `&siteid=default&moduleid=${SITE_MANAGER}&startrow=1"><i class="mi-group"></i> Permissions</a></li>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t</ul>\n` +
  `\t\t\t\t</div>\n` +
  `\t\t\t\t\n` +
  `</div>\n`;
// As served to qa_editor, an editor of Home outside the site's Admin group.
const LEGACY_EDITOR_HOME_HIST = `${HOME_HIST_HEAD}\t\t\t\t</ul>\n\t\t\t\t</div>\n\t\t\t\t\n</div>\n`;
const LEGACY_HOME_AUDIT =
  `\n<div class="nav-module-specific btn-group">\n\t\n\n` +
  `\t\t\t\t<a class="btn" href="./?muraAction=cArch.list&siteid=default` +
  `&moduleid=${SITE_MANAGER}"><i class="mi-arrow-circle-left"></i> Return to Content Manager</a>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t<div class="btn-group">\n` +
  `\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n` +
  `\t\t\t\t\t\t<i class="mi-cogs"></i> Actions\n` +
  `\t\t\t\t\t\t<span class="caret"></span>\n` +
  `\t\t\t\t\t  </a>\n` +
  `\t\t\t\t  <ul class="dropdown-menu drop-right">\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t\t<li><a href="./?muraAction=cArch.hist&contentid=${ROOT}&type=Page&parentid=${END}&topid=${ROOT}` +
  `&siteid=default&startrow=1&moduleid=${SITE_MANAGER}` +
  `&compactDisplay=false"><i class="mi-history"></i> Version History</a></li>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t\t<li><a href="./?muraAction=cPerm.main&contentid=${ROOT}&type=Page&parentid=${END}&topid=${ROOT}` +
  `&siteid=default&moduleid=${SITE_MANAGER}&startrow=1"><i class="mi-group"></i> Permissions</a></li>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t</ul>\n` +
  `\t\t\t\t</div>\n` +
  `\t\t\t\t\n` +
  `</div>\n`;
const LEGACY_HOME_EDIT =
  `\n<div class="nav-module-specific btn-group">\n\t\n` +
  `\t\t\t\t<div class="btn-group">\n` +
  `\t\t\t\t\t  <a class="btn dropdown-toggle" data-toggle="dropdown" href="#">\n` +
  `\t\t\t\t\t    <i class="mi-cogs"></i> Actions\n` +
  `\t\t\t\t\t    <span class="caret"></span>\n` +
  `\t\t\t\t\t  </a>\n` +
  `\t\t\t\t\t  <ul class="dropdown-menu drop-right">\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t\t\t<li><a href="http://localhost:8080/?previewid=${HOME_HIST}">` +
  `<i class="mi-eye"></i> View This Version</a></li>\n` +
  `\t\t\t\t\t\n\n\t\t\t\t\n` +
  `\t\t\t\t<li>\n` +
  `\t\t\t\t\t<a href="./?muraAction=cArch.hist&amp;contentid=${ROOT}&amp;type=Page&amp;parentid=${END}` +
  `&amp;topid=${ROOT}&amp;siteid=default&amp;startrow=1&amp;moduleid=${SITE_MANAGER}&amp;compactDisplay=false">\n` +
  `\t\t\t\t\t\t<i class="mi-history"></i> Version History\n` +
  `\t\t\t\t\t</a>\n` +
  `\t\t\t\t</li>\n\n\t\t\t\t\n` +
  `\t\t\t\t<li>\n` +
  `\t\t\t\t\t<a href="./?muraAction=cArch.audit&amp;contentid=${ROOT}&amp;contenthistid=${HOME_HIST}&amp;type=Page` +
  `&amp;parentid=${END}&amp;topid=${ROOT}&amp;siteid=default&amp;startrow=1&amp;moduleid=${SITE_MANAGER}` +
  `&amp;compactDisplay=false">\n` +
  `\t\t\t\t\t\t<i class="mi-sitemap"></i> Audit Trail\n` +
  `\t\t\t\t\t</a>\n` +
  `\t\t\t\t</li>\n\n\t\t\t\t\n` +
  `\t\t\t\t<li>\n` +
  `\t\t\t\t\t<a href="?muraAction=cArch.export&amp;siteid=default&amp;contentid=${ROOT}">\n` +
  `\t\t\t\t\t\t<i class="mi-sign-out"></i> Export\n` +
  `\t\t\t\t\t</a>\n` +
  `\t\t\t\t</li>\n\n\t\t\t\t\n` +
  `\t\t\t\t<li>\n` +
  `\t\t\t\t\t<a href="?muraAction=cArch.import&amp;contentid=${ROOT}&amp;moduleid=${SITE_MANAGER}` +
  `&amp;siteid=default">\n` +
  `\t\t\t\t\t\t<i class="mi-sign-in"></i> Import\n` +
  `\t\t\t\t\t</a>\n` +
  `\t\t\t\t</li>\n\n\t\t\t\t\n` +
  `\t\t\t\t\t<li><a href="./?muraAction=cPerm.main&contentid=${ROOT}&type=Page&parentid=${END}&topid=${ROOT}` +
  `&siteid=default&moduleid=${SITE_MANAGER}&startrow=1"><i class="mi-group"></i> Permissions</a></li>\n` +
  `\t\t\t\t\n` +
  `\t\t\t\t</ul>\n` +
  `\t\t\t\t</div>\n\n\n\t\t\t\n` +
  `</div>\n`;
const LEGACY_BACK =
  `\n<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t\t\n` +
  `\t\t\t\t\t<a class="btn" href="#" title="Back" onclick="window.history.back(); return false;">` +
  `<i class="mi-arrow-circle-left"></i> Back</a>\n` +
  `\t\t\t\t\n` +
  `</div>\n`;
const LEGACY_IMAGE_DETAILS =
  `\n<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t\t\t\n` +
  `\t\t\t\t\t\t<a class="btn" href="${HOME_EDIT_URL}">\n` +
  `\t\t\t\t\t\t\t<i class="mi-arrow-circle-left"></i>\n` +
  `\t\t\t\t\t\t\tBack to Content Form\n` +
  `\t\t\t\t\t\t</a>\n` +
  `\t\t\t\t\t\t\n\t\t\t\t\t\t\n` +
  `\t\t\t\t\t\t\t<a class="btn" href="./?&muraAction=cArch.list&siteid=default&moduleid=${SITE_MANAGER}">\n` +
  `\t\t\t\t\t\t\t\t<i class="mi-list-alt"></i>\n` +
  `\t\t\t\t\t\t\t\tReturn to Content Manager\n` +
  `\t\t\t\t\t\t\t</a>\n` +
  `\t\t\t\t\t\t\n` +
  `</div>\n`;

/** The oracle's menu for a new item of `moduleId`, its back link labelled `label`. */
const legacyNewItem = (moduleId: string, label: string): string =>
  `\n<div class="nav-module-specific btn-group">\n\t\n` +
  `\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.list&siteid=default&topid=${moduleId}&parentid=${moduleId}` +
  `&moduleid=${moduleId}"><i class="mi-arrow-circle-left"></i>\n` +
  `\t\t\t\t\t${label} \n` +
  `\t\t\t\t\t</a>\n` +
  `\t\t\t\t\t\n` +
  `</div>\n`;

const newIn = (moduleid: string, type: string): Record<string, string> => ({
  type,
  contentid: '',
  topid: moduleid,
  parentid: moduleid,
  moduleid,
});

interface MenuCase {
  readonly name: string;
  readonly req: () => AdminRequest;
  readonly input: CarchSecondaryMenuInput;
}

describe('renderCarchSecondaryMenu', () => {
  it.each<MenuCase & { legacy: string }>([
    {
      name: 'the history of Home',
      req: () => carch('hist', HOME_RC),
      input: { ...SAVED, content: HOME },
      legacy: LEGACY_HOME_HIST,
    },
    {
      name: 'the history of Home for qa_editor',
      req: () => carch('hist', HOME_RC, 'qaEditor'),
      input: { ...SAVED, content: HOME },
      legacy: LEGACY_EDITOR_HOME_HIST,
    },
    {
      name: 'the audit of Home',
      req: () => carch('audit', HOME_RC),
      input: { ...SAVED, content: HOME },
      legacy: LEGACY_HOME_AUDIT,
    },
    {
      name: 'the edit form of Home',
      req: () => carch('edit', { ...HOME_RC, contenthistid: HOME_HIST }),
      input: { ...SAVED, content: { ...HOME, previewUrl: `http://localhost:8080/?previewid=${HOME_HIST}` } },
      legacy: LEGACY_HOME_EDIT,
    },
    {
      name: 'a new form',
      req: () => carch('edit', { ...newIn(FORMS, 'Form'), formType: 'builder' }),
      input: { ...SAVED, content: { ...HOME, isNew: true, type: 'Form' } },
      legacy: legacyNewItem(FORMS, 'Back to Forms'),
    },
    {
      name: 'a new component',
      req: () => carch('edit', newIn(COMPONENTS, 'Component')),
      input: { ...SAVED, content: { ...HOME, isNew: true, type: 'Component' } },
      legacy: legacyNewItem(COMPONENTS, 'Back to Components'),
    },
    {
      name: 'a new variation',
      req: () => carch('edit', newIn(VARIATIONS, 'Variation')),
      input: { ...SAVED, content: { ...HOME, isNew: true, type: 'Variation' } },
      legacy: legacyNewItem(VARIATIONS, 'Back to Variations'),
    },
    {
      name: 'a new component in the compact layout manager',
      req: () => carch('edit', { ...newIn(COMPONENTS, 'Component'), compactDisplay: 'true' }),
      input: { ...SAVED, content: { ...HOME, isNew: true, type: 'Component' }, useLayoutManager: true },
      legacy: EMPTY_MENU,
    },
    {
      name: 'a new page',
      req: () => carch('edit', { ...newIn(SITE_MANAGER, 'Page'), parentid: ROOT, topid: ROOT }),
      input: { ...SAVED, content: { ...HOME, isNew: true } },
      legacy: EMPTY_MENU,
    },
    { name: 'the multi-file upload', req: () => carch('multiFileUpload', MULTI_RC), input: {}, legacy: LEGACY_BACK },
    {
      name: 'the image details of Home',
      req: () => carch('imagedetails', { contenthistid: HOME_HIST, moduleid: SITE_MANAGER }),
      input: { content: { ...HOME, editUrl: HOME_EDIT_URL }, hasLockableNodes: false },
      legacy: LEGACY_IMAGE_DETAILS,
    },
    {
      name: 'the image details of Home for qa_editor',
      req: () => carch('imagedetails', { contenthistid: HOME_HIST, moduleid: SITE_MANAGER }, 'qaEditor'),
      input: { content: { ...HOME, editUrl: HOME_EDIT_URL }, hasLockableNodes: false },
      legacy: LEGACY_IMAGE_DETAILS,
    },
  ])('matches the oracle bytes for $name', ({ req, input, legacy }) => {
    expect(render(req(), input)).toBe(legacy);
  });

  it('opens with the compact back button outside the layout manager', () => {
    const out = render(carch('edit', { ...newIn(FORMS, 'Form'), compactDisplay: 'true' }), {
      ...SAVED,
      content: { ...HOME, isNew: true, type: 'Form' },
      useLayoutManager: false,
    });

    expect(out).toBe(
      '\n<div class="nav-module-specific btn-group">\n\t\n\t\t<a class="btn" onclick="history.go(-1);">' +
        '<i class="mi-arrow-circle-left"></i>  Back</a>\n\t\n</div>\n',
    );
  });

  // `rc.compactDisplay eq 'true'` reads the value the admin scan leaves, as the oracle's layout choice for each shows.
  it.each<[string, boolean]>([
    [' TRUE', true],
    ['tr\u0000ue', true],
    ['\u0001yes', true],
    [' 1.0 ', true],
    [' true', false],
    ['2', false],
  ])('opens with the compact back button for compactDisplay %j: %s', (compactDisplay, shown) => {
    const input = { ...SAVED, content: { ...HOME, isNew: true, type: 'Form' }, useLayoutManager: false };
    const menu = (value: string): string => render(carch('edit', { ...newIn(FORMS, 'Form'), compactDisplay: value }), input);

    expect(menu(compactDisplay) === menu('true')).toBe(shown);
    expect(menu(compactDisplay).includes('onclick="history.go(-1);"')).toBe(shown);
  });

  it('reads input.rc over the request rc by case-insensitive name', () => {
    const rc: RequestContext = {
      ModuleID: SITE_MANAGER,
      ContentID: NODE,
      Type: 'Page',
      ParentID: END,
      TopID: ROOT,
      SITEID: 'default',
      StartRow: '1',
      compactdisplay: 'false',
    };
    const scope = `&topid=${ROOT}&siteid=default&moduleid=${SITE_MANAGER}`;

    expect(linksOf(render(carch('audit', HOME_RC), { ...SAVED, rc, content: HOME }))).toEqual([
      link(`./?muraAction=cArch.list&siteid=default&moduleid=${SITE_MANAGER}`, 'Return to Content Manager'),
      ACTIONS,
      link(
        `./?muraAction=cArch.hist&contentid=${NODE}&type=Page&parentid=${END}${scope}&startrow=1&compactDisplay=false`,
        'Version History',
      ),
      link(`./?muraAction=cPerm.main&contentid=${NODE}&type=Page&parentid=${END}${scope}&startrow=1`, 'Permissions'),
    ]);
  });

  it.each<MenuCase>([
    {
      name: 'the forms module on its file upload',
      req: () => carch('multiFileUpload', newIn(FORMS, 'Form')),
      input: {},
    },
    { name: 'Site Manager on its list', req: () => carch('list', HOME_RC), input: {} },
  ])('renders an empty menu for $name', ({ req, input }) => {
    expect(render(req(), input)).toBe(EMPTY_MENU);
  });

  it.each<MenuCase & { message: string }>([
    {
      name: 'an rc without moduleid',
      req: () => carch('hist', HOME_RC),
      input: { rc: {} },
      message: 'Element MODULEID is undefined in RC.',
    },
    {
      name: 'a history without content',
      req: () => carch('hist', HOME_RC),
      input: {},
      message: 'Element CONTENTBEAN is undefined in RC.',
    },
    {
      name: 'content without the lock setting',
      req: () => carch('hist', HOME_RC),
      input: { content: HOME },
      message: "$.siteConfig('hasLockableNodes') is undefined.",
    },
    {
      name: 'the compact display without the layout manager flag',
      req: () => carch('list', { ...HOME_RC, compactDisplay: 'true' }),
      input: {},
      message: 'rc.$.useLayoutManager() is undefined.',
    },
    {
      name: 'a draft without rc.perm',
      req: () => carch('edit', { ...HOME_RC, contentid: NODE }),
      input: { content: node({ active: 0, previewUrl: '/news/' }), hasLockableNodes: false },
      message: 'Element PERM is undefined in RC.',
    },
    {
      name: 'a history without rc.deletable',
      req: () => carch('audit', HOME_RC),
      input: { content: HOME, perm: 'editor', hasLockableNodes: false },
      message: 'Element DELETABLE is undefined in RC.',
    },
    {
      name: 'a data manager without content',
      req: () => carch('datamanager', { ...HOME_RC, moduleid: FORMS }),
      input: { perm: 'editor' },
      message: 'isLockedBySomeoneElse is undefined.',
    },
    {
      name: 'a draft without the purge setting',
      req: () => carch('edit', { ...newIn(VARIATIONS, 'Variation'), contentid: NODE }, 'qaEditor'),
      input: { ...SAVED, content: node({ type: 'Variation', active: 0 }), purgeDrafts: undefined },
      message: 'application.configBean.getPurgeDrafts() is undefined.',
    },
    {
      name: 'the forms list without the simple forms setting',
      req: () => carch('list', { moduleid: FORMS, topid: FORMS }),
      input: { perm: 'editor' },
      message: "application.configBean.getValue('allowSimpleHTMLForms') is undefined.",
    },
    {
      name: 'a file preview without the resource path',
      req: () => carch('edit', { ...HOME_RC, contentid: NODE, type: 'File' }),
      input: { ...SAVED, content: node({ type: 'File', filename: 'doc.pdf' }) },
      message: 'getResourcePath(complete=1) is undefined.',
    },
    {
      name: 'the compact view without the content URL',
      req: () => carch('imagedetails', { ...HOME_RC, compactDisplay: 'true' }),
      input: { content: HOME, hasLockableNodes: false, useLayoutManager: true },
      message: 'rc.contentBean.getURL() is undefined.',
    },
  ])('fails as CFML does for $name', ({ req, input, message }) => {
    expect(() => render(req(), input)).toThrow(expect.objectContaining({ name: 'TypeError', message }));
  });

  it.each([
    ['Back to Forms', 'Back to Forms '],
    ['Back\t', 'Back\t'],
    ['', ''],
    ['Zur\u00A0', 'Zur\u00A0 '],
    ['Wide\u3000', 'Wide\u3000'],
  ])('follows the back label %j with the space legacy prints', (label, shown) => {
    const rb: RbLookup = {
      locale: 'en_US',
      rbKey: (key) => (key === 'sitemanager.backtoforms' ? label : EN.rbKey(key)),
      messageFormat: (pattern, args) => EN.messageFormat(pattern, args),
    };
    const out = render(carch('edit', newIn(FORMS, 'Form')), { ...SAVED, content: { ...HOME, isNew: true } }, rb);

    expect(out).toContain(`<i class="mi-arrow-circle-left"></i>\n\t\t\t\t\t${shown}\n\t\t\t\t\t</a>`);
  });
});

describe('the Components, Forms and Variations list', () => {
  const listRc = (moduleid: string): Record<string, string> => ({ moduleid, topid: moduleid });
  const add = (type: string, moduleid: string, text: string, suffix = ''): DomLink =>
    link(
      `./?muraAction=cArch.edit&type=${type}&contentid=&topid=${moduleid}&parentid=${moduleid}&siteid=default` +
        `&moduleid=${moduleid}${suffix}`,
      text,
    );
  const perms = (moduleid: string): DomLink =>
    link(
      `./?muraAction=cPerm.main&contentid=${moduleid}&topid=${moduleid}&siteid=default&moduleid=${moduleid}&startrow=1`,
      'Permissions',
    );

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'components for the admin',
      req: () => carch('list', listRc(COMPONENTS)),
      input: { perm: 'editor' },
      links: [add('Component', COMPONENTS, 'Component'), perms(COMPONENTS)],
    },
    {
      name: 'forms with simple HTML forms',
      req: () => carch('list', listRc(FORMS)),
      input: { perm: 'editor', allowSimpleHTMLForms: true },
      links: [
        add('Form', FORMS, 'Add Form with Form Builder', '&formType=builder'),
        add('Form', FORMS, 'Add Form with Editor', '&formType=editor'),
        perms(FORMS),
      ],
    },
    {
      name: 'forms for an editor',
      req: () => carch('list', listRc(FORMS), 'qaEditor'),
      input: { perm: 'editor', allowSimpleHTMLForms: false },
      links: [add('Form', FORMS, 'Add Form with Form Builder', '&formType=builder')],
    },
    {
      name: 'variations',
      req: () => carch('list', listRc(VARIATIONS)),
      input: { perm: 'author' },
      links: [perms(VARIATIONS)],
    },
    {
      name: 'a module the user may not see',
      req: () => carch('list', listRc(FORMS)),
      input: { perm: 'none' },
      links: [],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it('prints the buttons as legacy does', () => {
    const out = render(carch('list', listRc(COMPONENTS)), { perm: 'editor' });

    expect(out).toBe(
      '\n<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.edit' +
        `&type=Component&contentid=&topid=${COMPONENTS}&parentid=${COMPONENTS}&siteid=default` +
        `&moduleid=${COMPONENTS}"><i class="mi-plus-circle"></i> Component</a>\n\t\t\t\t\t\t\n` +
        '\t\t\t\t\t\t\t<a class="btn " href="./?muraAction=cPerm.main' +
        `&contentid=${COMPONENTS}&topid=${COMPONENTS}&siteid=default&moduleid=${COMPONENTS}&startrow=1">` +
        '<i class="mi-group"></i> Permissions</a>\n\t\t\t\t\t\t\n</div>\n',
    );
  });

  it('renders nothing for a module the user may not see', () => {
    expect(render(carch('list', listRc(FORMS)), { perm: 'none' })).toBe(EMPTY_MENU);
  });

  it.each(REQUESTED_SITE_CASES)('links Permissions for $who only when it administers that site', (testCase) => {
    const req = testCase.request({ circuit: 'cArch', item: 'list', rc: { ...CARCH_RC, ...listRc(COMPONENTS) } });
    const { siteid } = testCase;
    const addComponent = link(
      `./?muraAction=cArch.edit&type=Component&contentid=&topid=${COMPONENTS}&parentid=${COMPONENTS}&siteid=${siteid}` +
        `&moduleid=${COMPONENTS}`,
      'Component',
    );
    const permissions = link(
      `./?muraAction=cPerm.main&contentid=${COMPONENTS}&topid=${COMPONENTS}&siteid=${siteid}&moduleid=${COMPONENTS}` +
        '&startrow=1',
      'Permissions',
    );

    expect(linksOf(render(req, { perm: 'editor' }))).toEqual(
      testCase.administers ? [addComponent, permissions] : [addComponent],
    );
  });

  it("checks the site of the view's rc, which its links carry", () => {
    const req = carch('list', listRc(COMPONENTS), 'siteAdmin', { siteid: 'tenant-a' });
    const rc: RequestContext = { ...CARCH_RC, ...listRc(COMPONENTS), siteid: 'tenant-b', compactdisplay: 'false' };

    expect(linksOf(render(req, { perm: 'editor', rc })).map(({ text }) => text)).toEqual(['Component']);
  });
});

describe('the form data manager', () => {
  const rc = { moduleid: FORMS, topid: FORMS, contentid: NODE, type: 'Form' };
  const form: CarchSecondaryMenuInput = { ...SAVED, content: node({ type: 'Form' }) };
  const scope = `&topid=${FORMS}&siteid=default&moduleid=${FORMS}&parentid=${FORMS}`;
  const back = link(
    `./?muraAction=cArch.list&siteid=default&topid=${FORMS}&parentid=${FORMS}&moduleid=${FORMS}`,
    'Back to Forms',
  );
  const history = link(
    `./?muraAction=cArch.hist&contentid=${NODE}&type=Form&parentid=${FORMS}&topid=${FORMS}&siteid=default&startrow=1` +
      `&moduleid=${FORMS}`,
    'Version History',
  );
  const data = link(`./?muraAction=cArch.datamanager&contentid=${NODE}&type=Form${scope}`, 'Form Data');
  const display = link(
    `./?muraAction=cArch.datamanager&contentid=${NODE}&type=Form&action=display${scope}`,
    'Edit Display',
  );
  const remove = link(
    `./?muraAction=cArch.update&contentid=${NODE}&type=Form&action=deleteall${scope}${token(`${NODE}deleteall`)}`,
    'Delete Form',
  );
  const perms = link(
    `./?muraAction=cPerm.main&contentid=${NODE}&type=Form&parentid=${FORMS}&topid=${FORMS}&siteid=default` +
      `&moduleid=${FORMS}&startrow=1`,
    'Permissions',
  );

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'the responses for the admin',
      req: () => carch('datamanager', rc),
      input: form,
      links: [back, history, display, remove, perms],
    },
    {
      name: 'a data manager action for the admin',
      req: () => carch('datamanager', { ...rc, action: 'display' }),
      input: form,
      links: [back, history, data, display, remove, perms],
    },
    {
      name: 'the responses for an author',
      req: () => carch('datamanager', rc, 'qaEditor'),
      input: { ...form, perm: 'author' },
      links: [back, history],
    },
    {
      name: 'a form locked by someone else',
      req: () => carch('datamanager', rc),
      input: { ...form, ...LOCKED, content: node({ type: 'Form', stats: LOCK_STATS }) },
      links: [back, history, perms],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it('titles and confirms the data actions as legacy does', () => {
    const out = render(carch('datamanager', { ...rc, action: 'display' }), form);

    expect(out).toContain(
      '<a class="btn" title="sitemanager.content.managedate_missing" href="./?muraAction=cArch.datamanager',
    );
    expect(out).toContain('<a class="btn" title="Edit Display" href=');
    expect(out).toContain(
      `${token(`${NODE}deleteall`)}" onClick="return confirmDialog('Delete\\x20Form\\x3F',this.href)">` +
        '<i class="mi-trash"></i> Delete Form</a>',
    );
  });
});

describe('the Components, Forms and Variations edit form', () => {
  const rc = (moduleid: string, type: string, extra: Record<string, string> = {}): Record<string, string> => ({
    moduleid,
    topid: moduleid,
    parentid: moduleid,
    contentid: NODE,
    contenthistid: NODE_HIST,
    type,
    ...extra,
  });
  const query = (moduleid: string, type: string): string =>
    `&type=${type}&parentid=${moduleid}&topid=${moduleid}&siteid=default&startrow=1&moduleid=${moduleid}`;
  const back = (moduleid: string, text: string): DomLink =>
    link(`./?muraAction=cArch.list&siteid=default&topid=${moduleid}&parentid=${moduleid}&moduleid=${moduleid}`, text);
  const history = (moduleid: string, type: string, compact = 'false'): DomLink =>
    link(
      `./?muraAction=cArch.hist&contentid=${NODE}${query(moduleid, type)}&compactDisplay=${compact}`,
      'Version History',
    );
  const audit = (moduleid: string, type: string, compact = 'false'): DomLink =>
    link(
      `./?muraAction=cArch.audit&contentid=${NODE}&contenthistid=${NODE_HIST}${query(moduleid, type)}` +
        `&compactDisplay=${compact}`,
      'Audit Trail',
    );
  const perms = (moduleid: string, type: string): DomLink =>
    link(
      `./?muraAction=cPerm.main&contentid=${NODE}&type=${type}&parentid=${PARENT}&topid=${moduleid}&siteid=default` +
        `&moduleid=${moduleid}&startrow=1`,
      'Permissions',
    );
  const removeAll = (moduleid: string, type: string): DomLink =>
    link(
      `./?muraAction=cArch.update&action=deleteall&contentid=${NODE}${query(moduleid, type)}` +
        token(`${NODE}deleteall`),
      'Delete Content',
    );
  const formData = link(
    `./?muraAction=cArch.datamanager&contentid=${NODE}&siteid=default&topid=${FORMS}&moduleid=${FORMS}&type=Form` +
      `&parentid=${FORMS}`,
    'Form Data',
  );
  const deleteVersion = (moduleid: string, type: string, ret: string): DomLink =>
    link(
      `./?muraAction=cArch.update&contenthistid=${NODE_HIST}&action=delete&contentid=${NODE}${query(moduleid, type)}` +
        `&return=${ret}${token(`${NODE_HIST}delete`)}`,
      'Delete Version',
    );
  const formExport = [
    link(`./?muraAction=cForm.export&contentid=${NODE}`, 'Export'),
    link('./?muraAction=cForm.importform', 'Import'),
  ];
  const componentExport = [
    link(`./?muraAction=cArch.exportcomponent&contentid=${NODE}`, 'Export'),
    link('./?muraAction=cArch.importcomponent', 'Import'),
  ];
  const savedForm: CarchSecondaryMenuInput = { ...SAVED, deletable: true, content: node({ type: 'Form' }) };
  const compactComponent: CarchSecondaryMenuInput = {
    ...SAVED,
    content: node({ type: 'Component' }),
    useLayoutManager: true,
  };
  const remotePreview = `https%3A%2F%2Fremote.example%2Fpage%3Fpreviewid%3D${NODE_HIST}`;
  const draftVariation: CarchSecondaryMenuInput = {
    ...SAVED,
    content: node({ type: 'Variation', active: 0, remoteUrl: 'https://remote.example/page' }),
  };

  it.each<MenuCase & { links: DomLink[]; wrapped: boolean }>([
    {
      name: 'a saved form for the admin',
      req: () => carch('edit', rc(FORMS, 'Form')),
      input: savedForm,
      links: [
        back(FORMS, 'Back to Forms'),
        formData,
        ACTIONS,
        history(FORMS, 'Form'),
        audit(FORMS, 'Form'),
        perms(FORMS, 'Form'),
        removeAll(FORMS, 'Form'),
        ...formExport,
      ],
      wrapped: true,
    },
    {
      name: 'a compact saved form for the admin',
      req: () => carch('update', rc(FORMS, 'Form', { compactDisplay: 'true' })),
      input: { ...savedForm, deletable: false, useLayoutManager: true },
      links: [
        formData,
        ACTIONS,
        history(FORMS, 'Form', 'true'),
        audit(FORMS, 'Form', 'true'),
        perms(FORMS, 'Form'),
        ...formExport,
      ],
      wrapped: true,
    },
    {
      name: 'a compact component for an editor',
      req: () => carch('edit', rc(COMPONENTS, 'Component', { compactDisplay: 'true' }), 'qaEditor'),
      input: compactComponent,
      links: [
        ACTIONS,
        history(COMPONENTS, 'Component', 'true'),
        audit(COMPONENTS, 'Component', 'true'),
        ...componentExport,
      ],
      wrapped: false,
    },
    {
      name: 'a draft variation for the admin',
      req: () => carch('edit', rc(VARIATIONS, 'Variation', { return: 'a b&c' })),
      input: draftVariation,
      links: [
        back(VARIATIONS, 'Back to Variations'),
        ACTIONS,
        link(remotePreview, 'View This Version'),
        history(VARIATIONS, 'Variation'),
        audit(VARIATIONS, 'Variation'),
        deleteVersion(VARIATIONS, 'Variation', 'a+b%26c'),
        perms(VARIATIONS, 'Variation'),
      ],
      wrapped: true,
    },
  ])('links $name', ({ req, input, links, wrapped }) => {
    const out = render(req(), input);

    expect(linksOf(out)).toEqual(links);
    expect(out.includes('<div class="btn-group">')).toBe(wrapped);
    const close = wrapped ? '\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t' : '';
    expect(out.endsWith(`</ul>\n\t\t\t\t\t\t${close}\n</div>\n`)).toBe(true);
  });

  it('prints the form items as legacy does', () => {
    const out = render(carch('edit', rc(FORMS, 'Form')), savedForm);

    expect(out).toContain(`&type=Form&parentid=${FORMS}"><i class="mi-wrench"></i> Form Data</a></li>\n`);
    expect(out).toContain(
      `${token(`${NODE}deleteall`)}"\n\t\t\t\t\t\t\t` +
        `onclick="return confirmDialog('Delete\\x20Content\\x3F',this.href)">` +
        '<i class="mi-trash"></i>  Delete Content</a></li>',
    );
    expect(out).toContain(`<a href="./?muraAction=cForm.export&contentid=${NODE}"><i class="mi-save"></i>  Export</a>`);
  });

  it('encodes the variation preview and return as legacy does', () => {
    const out = render(carch('edit', rc(VARIATIONS, 'Variation', { return: 'a b&c' })), draftVariation);

    expect(out).toContain(`<li><a href="${remotePreview}"><i class="mi-eye"></i> View This Version</a></li>`);
    expect(out).toContain(
      `&return=a+b%26c${token(`${NODE_HIST}delete`)}"` +
        ` onclick="return confirmDialog('Delete\\x20Version\\x3F',this.href)">`,
    );
  });

  it.each<MenuCase & { shown: boolean }>([
    {
      name: 'an editor when drafts are purged',
      req: () => carch('edit', rc(VARIATIONS, 'Variation'), 'qaEditor'),
      input: { ...draftVariation, purgeDrafts: true },
      shown: true,
    },
    {
      name: 'an editor',
      req: () => carch('edit', rc(VARIATIONS, 'Variation'), 'qaEditor'),
      input: draftVariation,
      shown: false,
    },
    {
      name: 'a user without node permission when drafts are purged',
      req: () => carch('edit', rc(VARIATIONS, 'Variation'), 'qaEditor'),
      input: { ...draftVariation, perm: 'none', purgeDrafts: true },
      shown: false,
    },
    {
      name: 'a site admin',
      req: () => carch('edit', rc(VARIATIONS, 'Variation'), 'siteAdmin', { siteid: 'tenant-a' }),
      input: draftVariation,
      shown: true,
    },
    {
      name: 'a site admin on a site its token does not serve, as isAdminUser() reads its own site',
      req: () => carch('edit', rc(VARIATIONS, 'Variation'), 'siteAdmin', { siteid: 'tenant-b' }),
      input: draftVariation,
      shown: true,
    },
    {
      name: 'the admin on a node locked by someone else',
      req: () => carch('edit', rc(VARIATIONS, 'Variation')),
      input: { ...draftVariation, ...LOCKED, content: node({ type: 'Variation', active: 0, stats: LOCK_STATS }) },
      shown: false,
    },
    {
      name: 'the admin on a node the admin locked',
      req: () => carch('edit', rc(VARIATIONS, 'Variation')),
      input: {
        ...draftVariation,
        ...LOCKED,
        content: node({ type: 'Variation', active: 0, stats: { lockID: SUBJECTS.admin.sub, lockType: 'node' } }),
      },
      shown: true,
    },
    {
      name: 'the admin in the compact display',
      req: () => carch('edit', rc(VARIATIONS, 'Variation', { compactDisplay: 'true' })),
      input: { ...draftVariation, useLayoutManager: true },
      shown: false,
    },
    {
      name: 'the admin on the active version',
      req: () => carch('edit', rc(VARIATIONS, 'Variation')),
      input: { ...draftVariation, content: node({ type: 'Variation' }) },
      shown: false,
    },
  ])('offers Delete Version to $name as legacy does', ({ req, input, shown }) => {
    expect(linksOf(render(req(), input)).some(({ text }) => text === 'Delete Version')).toBe(shown);
  });
});

describe('the Components, Forms and Variations history', () => {
  const rc = (moduleid: string, type: string): Record<string, string> => ({
    moduleid,
    topid: moduleid,
    parentid: moduleid,
    contentid: NODE,
    type,
  });
  const query = (moduleid: string, type: string): string =>
    `&type=${type}&parentid=${moduleid}&topid=${moduleid}&siteid=default&startrow=1&moduleid=${moduleid}`;
  const back = (moduleid: string, text: string): DomLink =>
    link(`./?muraAction=cArch.list&siteid=default&topid=${moduleid}&parentid=${moduleid}&moduleid=${moduleid}`, text);
  const clear = (moduleid: string, type: string): DomLink =>
    link(
      `./?muraAction=cArch.update&action=deletehistall&contentid=${NODE}${query(moduleid, type)}&compactDisplay=false` +
        token(`${NODE}deletehistall`),
      'Clear Version History',
    );
  const formData = link(
    `./?muraAction=cArch.datamanager&contentid=${NODE}&siteid=default&topid=${FORMS}&moduleid=${FORMS}&type=Form` +
      `&parentid=${FORMS}`,
    'Form Data',
  );
  const perms = link(
    `./?muraAction=cPerm.main&contentid=${NODE}&type=Form&parentid=${PARENT}&topid=${FORMS}&siteid=default` +
      `&moduleid=${FORMS}&startrow=1`,
    'Permissions',
  );
  const form: CarchSecondaryMenuInput = { ...SAVED, deletable: true, content: node({ type: 'Form' }) };
  const variation: CarchSecondaryMenuInput = { ...SAVED, content: node({ type: 'Variation' }) };

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'a form history for the admin',
      req: () => carch('hist', rc(FORMS, 'Form')),
      input: form,
      links: [
        back(FORMS, 'Back to Forms'),
        ACTIONS,
        formData,
        clear(FORMS, 'Form'),
        link(
          `./?muraAction=cArch.update&action=deleteall&contentid=${NODE}${query(FORMS, 'Form')}` +
            token(`${NODE}deleteall`),
          'Delete Content',
        ),
        perms,
      ],
    },
    {
      name: 'a component audit for an author',
      req: () => carch('audit', rc(COMPONENTS, 'Component'), 'qaEditor'),
      input: { ...SAVED, perm: 'author', content: node({ type: 'Component' }) },
      links: [
        back(COMPONENTS, 'Back to Components'),
        ACTIONS,
        link(
          `./?muraAction=cArch.hist&contentid=${NODE}${query(COMPONENTS, 'Component')}&compactDisplay=false`,
          'Version History',
        ),
      ],
    },
    {
      name: 'a variation history for an editor when drafts are purged',
      req: () => carch('hist', rc(VARIATIONS, 'Variation'), 'qaEditor'),
      input: { ...variation, purgeDrafts: true },
      links: [back(VARIATIONS, 'Back to Variations'), ACTIONS, clear(VARIATIONS, 'Variation')],
    },
    {
      name: 'a variation history for an editor',
      req: () => carch('hist', rc(VARIATIONS, 'Variation'), 'qaEditor'),
      input: variation,
      links: [back(VARIATIONS, 'Back to Variations'), ACTIONS],
    },
    {
      name: 'a locked form history for the admin',
      req: () => carch('hist', rc(FORMS, 'Form')),
      input: { ...form, ...LOCKED, content: node({ type: 'Form', stats: LOCK_STATS }) },
      links: [back(FORMS, 'Back to Forms'), ACTIONS, formData, perms],
    },
    {
      name: 'a new form',
      req: () => carch('hist', rc(FORMS, 'Form')),
      input: { ...form, content: node({ type: 'Form', isNew: true }) },
      links: [back(FORMS, 'Back to Forms')],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it('prints the history menu as legacy does', () => {
    const out = render(carch('hist', rc(FORMS, 'Form')), form);

    expect(out.startsWith(
      '\n<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t\t<a class="btn" href="./?muraAction=cArch.list' +
        `&siteid=default&topid=${FORMS}&parentid=${FORMS}&moduleid=${FORMS}"><i class="mi-arrow-circle-left"></i>\n` +
        '\t\t\t\t\t\tBack to Forms \n\t\t\t\t\t</a>\n\t\t\t\t\t\n\t\t\t\t\t<div class="btn-group">\n',
    )).toBe(true);
    expect(out).toContain(
      '<ul class="dropdown-menu drop-right">\n\n\n\t\t\t\t\t\n\t\t\t\t\t\t<li><a href="./?muraAction=cArch.datamanager',
    );
    expect(out).toContain(`\n\t\t\t\t\t\t\t\t\t<i class="mi-eraser"></i> Clear Version History\n`);
    expect(out.endsWith('</ul>\n\t\t\t\t\t</div>\n\t\t\t\t\t\n</div>\n')).toBe(true);
  });
});

describe('the Site Manager edit form', () => {
  const rc = (extra: Record<string, string> = {}): Record<string, string> => ({
    moduleid: SITE_MANAGER,
    topid: ROOT,
    parentid: PARENT,
    contentid: NODE,
    contenthistid: NODE_HIST,
    type: 'Folder',
    ...extra,
  });
  const query = (type = 'Folder'): string =>
    `&type=${type}&parentid=${PARENT}&topid=${ROOT}&siteid=default&startrow=1&moduleid=${SITE_MANAGER}`;
  const history = (type = 'Folder', compact = 'false'): DomLink =>
    link(`./?muraAction=cArch.hist&contentid=${NODE}${query(type)}&compactDisplay=${compact}`, 'Version History');
  const audit = (type = 'Folder', compact = 'false'): DomLink =>
    link(
      `./?muraAction=cArch.audit&contentid=${NODE}&contenthistid=${NODE_HIST}${query(type)}&compactDisplay=${compact}`,
      'Audit Trail',
    );
  const exportImport = [
    link(`?muraAction=cArch.export&siteid=default&contentid=${NODE}`, 'Export'),
    link(`?muraAction=cArch.import&contentid=${NODE}&moduleid=${SITE_MANAGER}&siteid=default`, 'Import'),
  ];
  const deleteVersion = link(
    `./?muraAction=cArch.update&contenthistid=${NODE_HIST}&action=delete&contentid=${NODE}${query()}&return=` +
      token(`${NODE_HIST}delete`),
    'Delete Version',
  );
  const perms = link(
    `./?muraAction=cPerm.main&contentid=${NODE}&type=Folder&parentid=${PARENT}&topid=${ROOT}&siteid=default` +
      `&moduleid=${SITE_MANAGER}&startrow=1`,
    'Permissions',
  );
  const removeAll = link(
    `./?muraAction=cArch.update&action=deleteall&contentid=${NODE}${query()}${token(`${NODE}deleteall`)}`,
    'Delete Content',
  );
  const preview = link(`http://localhost:8080/news/?previewid=${NODE_HIST}`, 'View This Version');
  const draft: CarchSecondaryMenuInput = {
    ...SAVED,
    deletable: true,
    content: node({ type: 'Folder', active: 0, previewUrl: `http://localhost:8080/news/?previewid=${NODE_HIST}` }),
  };
  const file: CarchSecondaryMenuInput = {
    ...SAVED,
    content: node({ type: 'File', filename: 'doc.pdf', fileId: FILE_ID }),
    resourcePath: 'http://localhost:8080',
  };

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'a deletable draft folder for the admin',
      req: () => carch('edit', rc()),
      input: draft,
      links: [ACTIONS, preview, history(), audit(), ...exportImport, deleteVersion, perms, removeAll],
    },
    {
      name: 'a draft locked by someone else',
      req: () => carch('update', rc()),
      input: { ...draft, ...LOCKED, content: node({ type: 'Folder', active: 0, stats: LOCK_STATS, previewUrl: '/x/' }) },
      links: [ACTIONS, link('/x/', 'View This Version'), history(), audit(), ...exportImport, perms],
    },
    {
      name: 'a draft for a user without node permission',
      req: () => carch('edit', rc(), 'qaEditor'),
      input: { ...draft, perm: 'none', deletable: false },
      links: [ACTIONS, preview, history(), audit(), ...exportImport],
    },
    {
      name: 'a draft in the compact display',
      req: () => carch('edit', rc({ compactDisplay: 'true' })),
      input: { ...draft, deletable: false, useLayoutManager: false },
      links: [ACTIONS, preview, history('Folder', 'true'), audit('Folder', 'true'), ...exportImport, perms],
    },
    {
      name: 'a page without a filename',
      req: () => carch('edit', rc({ type: 'Page' }), 'qaEditor'),
      input: { ...SAVED, perm: 'author', content: node({ filename: '' }) },
      links: [ACTIONS, history('Page'), audit('Page'), ...exportImport],
    },
    {
      name: 'a component with a filename',
      req: () => carch('edit', rc({ type: 'Component' }), 'qaEditor'),
      input: { ...SAVED, content: node({ type: 'Component' }) },
      links: [ACTIONS, history('Component'), audit('Component'), ...exportImport],
    },
    {
      name: 'a file',
      req: () => carch('edit', rc({ type: 'File' }), 'qaEditor'),
      input: file,
      links: [ACTIONS, link('#', 'View This Version'), history('File'), audit('File'), ...exportImport],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it('prints the draft items as legacy does', () => {
    const out = render(carch('edit', rc({ return: 'a b&c' })), draft);

    expect(out).toContain(
      `&return=a b&c${token(`${NODE_HIST}delete`)}"` +
        ` onclick="return confirmDialog('Delete\\x20Version\\x3F',this.href)">`,
    );
    expect(out).toContain(
      `${token(`${NODE}deleteall`)}"\n\t\t\t\t\tonclick="return confirmDialog(` +
        `'${RECURSIVE_CONFIRM}',this.href)"><i class="mi-trash"></i> Delete Content</a></li>`,
    );
    expect(out.endsWith('</ul>\n\t\t\t\t</div>\n\n\n\t\t\t\n</div>\n')).toBe(true);
  });

  it('previews a file through the render API', () => {
    const out = render(carch('edit', rc({ type: 'File' })), file);

    expect(out).toContain(
      '<li><a href="#" href="#" onclick="return preview(' +
        `'http://localhost:8080/index.cfm/_api/render/file/?fileID=${FILE_ID}');">` +
        '<i class="mi-eye"></i> View This Version</a></li>',
    );
  });

  it('links the scaffolded related entities', () => {
    const out = render(carch('edit', rc()), {
      ...SAVED,
      content: node({
        previewUrl: '/news/',
        hasManyProps: [
          { cfc: 'widget', scaffold: true, pluralName: 'Widgets & Co', displayName: 'Widget' },
          { cfc: 'hidden', pluralName: 'Hidden', displayName: 'Hidden' },
        ],
        hasOneProps: [
          { cfc: 'owner thing', scaffold: true, pluralName: 'Owners', displayName: "Owner's" },
          { cfc: 'skipped', scaffold: false, pluralName: 'Skipped', displayName: 'Skipped' },
        ],
      }),
    });
    const related = (cfc: string, text: string): DomLink =>
      link(
        `./?muraAction=cArch.list&activeTab=2&entityid=${NODE}&entityname=content&siteid=default&relatesto=${cfc}`,
        text,
      );

    expect(linksOf(out).slice(-2)).toEqual([
      related('widget', 'Widgets & Co'),
      related('owner+thing', "Owners Owner's"),
    ]);
    expect(out).toContain(`<i class="mi-cube"></i> ${encodeHtml('Widgets & Co')}</a></li>\n\t\t\t\t\t\t`);
    expect(out).toContain(`&relatesto=owner+thing"><i class="mi-cube"></i> Owners Owner's</a></li>`);
  });
});

describe('the Site Manager history', () => {
  const query = `&type=Page&parentid=${PARENT}&topid=${ROOT}&siteid=default&startrow=1&moduleid=${SITE_MANAGER}`;
  const rc = { moduleid: SITE_MANAGER, topid: ROOT, parentid: PARENT, contentid: NODE, type: 'Page' };
  const back = link(`./?muraAction=cArch.list&siteid=default&moduleid=${SITE_MANAGER}`, 'Return to Content Manager');
  const history = (compact: string): DomLink =>
    link(`./?muraAction=cArch.hist&contentid=${NODE}${query}&compactDisplay=${compact}`, 'Version History');
  const perms = link(
    `./?muraAction=cPerm.main&contentid=${NODE}&type=Page&parentid=${PARENT}&topid=${ROOT}&siteid=default` +
      `&moduleid=${SITE_MANAGER}&startrow=1`,
    'Permissions',
  );
  const removeAll = link(
    `./?muraAction=cArch.update&action=deleteall&contentid=${NODE}${query}&compactDisplay=false` +
      token(`${NODE}deleteall`),
    'Delete Content',
  );
  // rc.type and rc.parentid, not the bean's, fill the Permissions link here.
  const folder: CarchSecondaryMenuInput = {
    ...SAVED,
    deletable: true,
    content: node({ type: 'Folder', parentId: OTHER_USER }),
  };

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'a history for a user without node permission',
      req: () => carch('hist', rc, 'qaEditor'),
      input: { ...SAVED, perm: 'none', content: node() },
      links: [back, ACTIONS],
    },
    {
      name: 'a history locked by someone else',
      req: () => carch('hist', rc),
      input: { ...folder, ...LOCKED, content: node({ stats: LOCK_STATS }) },
      links: [back, ACTIONS, perms],
    },
    {
      name: 'the audit of a deletable folder',
      req: () => carch('audit', rc),
      input: folder,
      links: [back, ACTIONS, history('false'), removeAll, perms],
    },
    {
      name: 'the audit in the compact layout manager',
      req: () => carch('audit', { ...rc, compactDisplay: 'true' }),
      input: { ...folder, useLayoutManager: true },
      links: [back, ACTIONS, history('true'), perms],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it('confirms a recursive delete with the menu title', () => {
    const out = render(carch('audit', rc), { ...folder, content: node({ type: 'Folder', menuTitle: 'News, Events' }) });

    expect(out).toContain(
      `${token(`${NODE}deleteall`)}"\n\t\t\t\t\t\tonclick="return confirmDialog(` +
        `'${RECURSIVE_CONFIRM}',this.href)" ><i class="mi-trash"></i> Delete Content</a></li>`,
    );
  });

  it('confirms a plain delete for a type outside the node-level list', () => {
    const out = render(carch('audit', rc), { ...folder, nodeLevelList: ['Page'] });

    expect(out).toContain(`onclick="return confirmDialog('Delete\\x20Content\\x3F',this.href)" ><i class="mi-trash">`);
  });

  it('offers only the way back for a new node', () => {
    expect(render(carch('hist', rc), { ...SAVED, content: node({ isNew: true }) })).toBe(
      '\n<div class="nav-module-specific btn-group">\n\t\n\n\t\t\t\t<a class="btn" href="./?muraAction=cArch.list' +
        `&siteid=default&moduleid=${SITE_MANAGER}"><i class="mi-arrow-circle-left"></i> Return to Content Manager</a>` +
        '\n\t\t\t\t\n</div>\n',
    );
  });
});

describe('the image details and multi-file upload', () => {
  const back = link(HOME_EDIT_URL, 'Back to Content Form');
  const content: CarchSecondaryMenuInput = { content: { ...HOME, editUrl: HOME_EDIT_URL }, hasLockableNodes: false };

  it.each([
    ['false', true],
    ['no', true],
    ['0', true],
    ['', false],
    ['true', false],
    ['YES ', false],
    ['1', false],
    // Oracle: cArch.multiFileUpload compares the scanned value, so a padded lowercase word re-serialized as "NO" fails.
    [' false', false],
    [' FALSE', true],
    ['\u0001no', true],
    ['fa\u0000lse', true],
    [' 0 ', true],
  ])('shows Back without content for compactDisplay %j: %s', (compactDisplay, shown) => {
    const out = render(carch('multiFileUpload', { ...MULTI_RC, compactDisplay }), { useLayoutManager: true });

    expect(out.includes('onclick="window.history.back(); return false;"')).toBe(shown);
  });

  it.each<MenuCase & { links: DomLink[] }>([
    {
      name: 'a site admin of the site, by case-insensitive id',
      req: () => carch('imagedetails', { ...HOME_RC, siteid: 'TENANT-A' }, 'siteAdmin', { siteid: 'tenant-a' }),
      input: content,
      links: [
        back,
        link(`./?&muraAction=cArch.list&siteid=TENANT-A&moduleid=${SITE_MANAGER}`, 'Return to Content Manager'),
      ],
    },
    {
      name: 'a site admin of another site',
      req: () => carch('multiFileUpload', { ...HOME_RC, siteid: 'tenant-b' }, 'siteAdmin', { siteid: 'tenant-a' }),
      input: content,
      links: [back],
    },
  ])('links $name', ({ req, input, links }) => {
    expect(linksOf(render(req(), input))).toEqual(links);
  });

  it.each<{ name: string; rc: RequestContext; homeUrl?: string; location: string }>([
    {
      name: 'the content without a home',
      rc: { ...CARCH_RC, ...HOME_RC, compactDisplay: 'true' },
      location: 'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fnews\\x2F',
    },
    {
      name: 'the home it was opened from',
      rc: { ...CARCH_RC, ...HOME_RC, compactDisplay: 'true', homeID: ROOT },
      homeUrl: 'http://localhost:8080/',
      location: 'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2F',
    },
    {
      name: 'the content of an rc without homeID',
      rc: { ...HOME_RC, siteid: 'default', compactDisplay: 'true' },
      location: 'http\\x3A\\x2F\\x2Flocalhost\\x3A8080\\x2Fnews\\x2F',
    },
  ])('views $name in the compact display', ({ rc, homeUrl, location }) => {
    const out = render(carch('imagedetails', HOME_RC), {
      rc,
      content: { ...HOME, url: 'http://localhost:8080/news/' },
      hasLockableNodes: false,
      useLayoutManager: true,
      homeUrl,
    });

    expect(out).toBe(
      '\n<div class="nav-module-specific btn-group">\n\t\n\t\t\t\t\t\t<a class="btn" href="#" onclick="frontEndProxy.' +
        `post({cmd:'setLocation',location:'${location}'}); return false;">` +
        '\n\t\t\t\t\t\t\t<i class="mi-globe"></i>\n\t\t\t\t\t\t\tView Content\n\t\t\t\t\t\t</a>\n\t\t\t\t\t\n</div>\n',
    );
  });

  it('fails as CFML does for a home without its URL', () => {
    const rc = { ...CARCH_RC, ...HOME_RC, compactDisplay: 'true', homeID: ROOT };
    expect(() =>
      render(carch('imagedetails', HOME_RC), { rc, content: HOME, hasLockableNodes: false, useLayoutManager: true }),
    ).toThrow(
      expect.objectContaining({
        name: 'TypeError',
        message: 'application.contentManager.getActiveContent(rc.homeid).getURL() is undefined.',
      }),
    );
  });
});

describe('carchSecondaryMenuCsrfContexts', () => {
  it('lists the url token contexts the menu renders', () => {
    expect(carchSecondaryMenuCsrfContexts({ contentid: NODE, contenthistid: NODE_HIST })).toEqual([
      `${NODE}deleteall`,
      `${NODE_HIST}delete`,
      `${NODE}deletehistall`,
    ]);
  });

  it('fails as CFML does without rc.contenthistid', () => {
    expect(() => carchSecondaryMenuCsrfContexts({ contentid: NODE })).toThrow(
      expect.objectContaining({ name: 'TypeError', message: 'Element CONTENTHISTID is undefined in RC.' }),
    );
  });
});

describe('carchSecondaryMenu', () => {
  it('renders the bound input for its own request only', () => {
    const req = carch('audit', HOME_RC);
    bindCarchSecondaryMenu({ req, rb: EN, csrf: TOKENS }, { ...SAVED, content: HOME });

    expect(markupOf(carchSecondaryMenu(req))).toBe(LEGACY_HOME_AUDIT);
    expect(() => carchSecondaryMenu(carch('audit', HOME_RC))).toThrow('Element CONTENTBEAN is undefined in RC.');
  });

  it('renders an unbound request as a view without content', () => {
    expect(markupOf(carchSecondaryMenu(carch('multiFileUpload', MULTI_RC)))).toBe(LEGACY_BACK);
  });

  it("labels an unbound request in the session's bundle", () => {
    const out = markupOf(carchSecondaryMenu(carch('multiFileUpload', MULTI_RC, 'admin', { rb: 'de' })));

    expect(out).toContain(`title="${encodeHtmlAttr('Zur&uuml;ck')}"`);
    expect(linksOf(out)).toEqual([{ href: '#', text: 'Zur&uuml;ck' }]);
  });
});
