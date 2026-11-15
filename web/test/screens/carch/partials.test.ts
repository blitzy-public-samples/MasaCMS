// The carch partials rendered through a screen context over the fake gateway, against the legacy views they port.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeJs, isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import { categoriesNest, type CategoryNestNode } from '@/screens/carch/partials/categories-nest';
import {
  closeCompactDisplay,
  type CloseCompactContent,
  type CloseCompactDisplayModel,
  type CloseCompactParent,
} from '@/screens/carch/partials/close-compact-display';
import { configuratorJs, type ConfiguratorJsInput } from '@/screens/carch/partials/configurator-js';
import { displayErrors, type DisplayErrors } from '@/screens/carch/partials/display-errors';
import { draftPromptJs } from '@/screens/carch/partials/draft-prompt-js';
import { carchJs } from '@/screens/carch/partials/js';
import { scaffold } from '@/screens/carch/partials/scaffold';
import { status, type StatusContent, type StatusModel } from '@/screens/carch/partials/status';
import {
  dspZoom,
  dspZoomNoLinks,
  htmlEditFormat,
  renderIcon,
  type ZoomCrumb,
  type ZoomOptions,
} from '@/screens/carch/partials/zoom';
import { statusModalPending } from '../../fixtures/strategies-content/approval-chains';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { CATEGORY_IDS } from '../../fixtures/strategies-content/categories';
import { USER_IDS } from '../../fixtures/session';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

const SITE_MANAGER_MODULE = '00000000000000000000000000000000000';
const COMPONENTS_MODULE = '00000000000000000000000000000000003';
const SCAFFOLD_MODULE = '00000000000000000000000000000000016';
const HOME_ID = '00000000000000000000000000000000001';
const SITE = 'tenant-a';
const WEB = `http://${SITE}.localhost:8100`;

type Req = ReturnType<typeof adminS2Request>;

let restoreEnv: () => void;

beforeEach(() => {
  // legacySettings() reads process.env rather than the parsed web env, so the editor type is pinned there.
  vi.stubEnv('MURA_HTMLEDITORTYPE', undefined);
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

/** The screen context of `req` over a fake gateway answering the shell and identity CSRF routes. */
const contextFor = (req: Req) => makeScreenContext({ req, gateway: fakeGatewayClient() });

/** The markup of a partial's SafeHtml. */
function markupOf(h: SafeHtml): string {
  expect(isSafeHtml(h)).toBe(true);
  return toString(h);
}

/** `<context><adminDir>` as the partials print it. */
const adminRoot = (): string => `${legacySettings().context}${legacySettings().adminDir}`;

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('displayErrors', () => {
  it.each<[string, DisplayErrors, string]>([
    ['skips siteID', { title: 'Title required', siteID: 'default' }, 'Title required <br> '],
    ['skips siteid', [['siteid', 'default'], ['title', 'Title required']], 'Title required '],
    ['keeps markup raw', { title: '<b>Title</b> required' }, '<b>Title</b> required '],
    ['counts siteID in the br rule', { title: 'A', siteID: 'default', body: 'B' }, 'A <br> B '],
    ['keeps legacy order', [['body', 'B'], ['title', 'A']], 'B <br> A '],
  ])('%s', (_name, errors, expected) => {
    expect(markupOf(displayErrors(errors))).toBe(expected);
  });
});

/** A tenant-a Page crumb; `fields` overrides any member. */
const crumb = (contentid: string, menutitle: string, fields: Partial<ZoomCrumb> = {}): ZoomCrumb => ({
  siteid: SITE,
  contentid,
  type: 'Page',
  menutitle,
  restricted: 0,
  ...fields,
});

const NODE = crumb(CONTENT_IDS.aboutTeam, 'Team');
const PARENT = crumb(CONTENT_IDS.aboutUs, 'About Us', { type: 'Folder' });
const ROOT = crumb(HOME_ID, 'Home');
const CRUMBS = [NODE, PARENT, ROOT];

/** dspZoom's `cArch.list` link of `c`, normalised as the DOM model holds it. */
const listHref = (c: ZoomCrumb, moduleid = SITE_MANAGER_MODULE): string =>
  normaliseAdminUrl(
    `${adminRoot()}/?muraAction=cArch.list&siteid=${c.siteid}&topid=${c.contentid}&moduleid=${moduleid}&activeTab=0`,
  );

describe('dspZoom', () => {
  const zoom = (opts: ZoomOptions): string => markupOf(dspZoom(contextFor(adminS2Request()), opts));

  // Legacy dspZoom links the node too, inside <strong>; only dspZoomNoLinks leaves crumbs unlinked.
  it('links every crumb root first', () => {
    const markup = zoom({ crumbdata: CRUMBS });
    expect(markup.startsWith('<ul class="breadcrumb">')).toBe(true);
    expect(fragmentModel(markup).links).toEqual([
      { href: listHref(ROOT), text: 'Home' },
      { href: listHref(PARENT), text: 'About Us' },
      { href: listHref(NODE), text: 'Team' },
    ]);
    expect(markup).toContain('<i class="folder"></i>About Us</a></li>');
    expect(markup).toMatch(/<strong>\s*<a \s*href="[^"]*"\s*><i class="page"><\/i>Team<\/a><\/strong><\/li>\s*<\/ul>$/);
  });

  it.each<[string, Partial<ZoomOptions>, string[]]>([
    ['charLimit', { charLimit: 10 }, ['Team']],
    ['charLimit under minLevels', { charLimit: 10, minLevels: 2 }, ['About Us', 'Team']],
    ['minLevels beyond the crumbs', { charLimit: 10, minLevels: 4 }, ['Team']],
    ['maxLevels', { maxLevels: 2 }, ['About Us', 'Team']],
    ['a charLimit never reached', { charLimit: 100 }, ['Home', 'About Us', 'Team']],
  ])('applies %s', (_name, opts, titles) => {
    expect(fragmentModel(zoom({ crumbdata: CRUMBS, ...opts })).links.map((link) => link.text)).toEqual(titles);
  });

  it('reloads the Site Manager tab for ajax', () => {
    const node = crumb(NODE.contentid, 'Team', { moduleid: COMPONENTS_MODULE });
    const markup = zoom({ crumbdata: [node, ROOT], ajax: true });
    expect(fragmentModel(markup).links.map((link) => link.href)).toEqual(['', '']);
    expect(markup).toContain(
      'href="" onclick="return siteManager.loadSiteManagerInTab(function(){siteManager.loadSiteManager(' +
        `'${SITE}','${NODE.contentid}','${COMPONENTS_MODULE}','','','Page',1)});"`,
    );
    expect(markup).not.toContain('cArch.list');
  });

  it('locks every crumb after a restricted ancestor', () => {
    const markup = zoom({ crumbdata: [NODE, PARENT, { ...ROOT, restricted: 1 }] });
    expect(markup.match(/<li[^>]*>/g)).toEqual(['<li class="locked">', '<li class="locked">', '<li class="locked">']);
  });

  it('encodes menu titles', () => {
    const markup = zoom({ crumbdata: [crumb(NODE.contentid, 'R&D <News>')] });
    expect(markup).toContain('<i class="page"></i>R&amp;D &lt;News&gt;</a>');
    expect(fragmentModel(markup).links[0]?.text).toBe('R&D <News>');
  });
});

describe('dspZoomNoLinks', () => {
  it('prints unlinked crumbs', () => {
    const file = crumb(NODE.contentid, 'Brochure', { type: 'File', fileext: 'PDF' });
    const markup = markupOf(dspZoomNoLinks(contextFor(adminS2Request()), { crumbdata: [file, PARENT, ROOT] }));
    expect(markup).toContain('<ul class="navZoom">');
    expect(markup).not.toContain('<a');
    expect(fragmentModel(markup).links).toEqual([]);
    expect(markup).toContain('<li class="page "> Home</li>');
    expect(markup).toContain('<li class="folder "> About Us</li>');
    expect(markup).toContain('<li class="pdf  file" data-filetype="pdf"> <strong>Brochure</strong></li>');
  });
});

describe('renderIcon', () => {
  it.each<[string, Partial<ZoomCrumb>, string]>([
    ['Page', { type: 'Page' }, 'page'],
    ['Folder', { type: 'Folder' }, 'folder'],
    ['File with fileExt', { type: 'File', fileext: 'PDF' }, 'pdf'],
    ['File without fileExt', { type: 'File' }, 'page'],
    ['Link', { type: 'Link' }, 'link'],
    ['Component', { type: 'Component' }, 'component'],
    ['Form', { type: 'Form' }, 'form'],
    ['restricted', { type: 'Page', restricted: 1 }, 'page'],
    ['icon class', { type: 'File', fileext: 'pdf', iconclass: 'mi-star' }, 'mi-star'],
  ])('returns the %s icon', (_name, fields, expected) => {
    expect(renderIcon(crumb(NODE.contentid, 'Team', fields))).toBe(expected);
  });
});

describe('htmlEditFormat', () => {
  it('encodes as ACF HTMLEditFormat', () => {
    expect(htmlEditFormat('<a href="x">R&D</a>\r\n\'s')).toBe('&lt;a href=&quot;x&quot;&gt;R&amp;D&lt;/a&gt;\n\'s');
  });
});

/** A category without children; `isOpen` 1 renders its checkbox. */
const leaf = (categoryID: string, name: string, isOpen = 1): CategoryNestNode => ({
  categoryID,
  name,
  isOpen,
  hasKids: 0,
});

const CATEGORY_TREE: readonly CategoryNestNode[] = [
  {
    categoryID: CATEGORY_IDS.topics,
    name: 'General Topics',
    isOpen: 1,
    hasKids: 2,
    children: [leaf(CATEGORY_IDS.topicsNews, 'News'), leaf(CATEGORY_IDS.topicsEvents, 'Events & Calendar')],
  },
  leaf(CATEGORY_IDS.restricted, 'Restricted Notices', 0),
];

describe('categoriesNest', () => {
  const nest = (opts: Partial<Parameters<typeof categoriesNest>[1]> = {}): string =>
    markupOf(categoriesNest(contextFor(adminS2Request()), { siteId: SITE, tree: CATEGORY_TREE, ...opts }));

  it.each<[string, Partial<Parameters<typeof categoriesNest>[1]>, string]>([
    ['nestLevel 0', { nestLevel: 0 }, '<ul id="mura-nodes" class="categories checkboxTree">'],
    ['nestLevel 0 without useId', { nestLevel: 0, useId: 0 }, '<ul class="categories checkboxTree">'],
    ['nestLevel 1', { nestLevel: 1 }, '<ul class="categories">'],
  ])('opens the top list at %s', (_name, opts, opening) => {
    const markup = nest(opts);
    expect(markup.split('\n')[1]).toBe(opening);
    expect(occurrences(markup, '<ul class="categories">')).toBe(opts.nestLevel === 0 ? 1 : 2);
  });

  it('checks the selected categoryId', () => {
    const markup = nest({ nestLevel: 0, categoryId: CATEGORY_IDS.topicsNews });
    const { controls } = fragmentModel(markup);
    expect(controls.map(({ name, type, value, checked }) => ({ name, type, value, checked }))).toEqual([
      { name: 'categoryID', type: 'checkbox', value: CATEGORY_IDS.topics, checked: false },
      { name: 'categoryID', type: 'checkbox', value: CATEGORY_IDS.topicsNews, checked: true },
      { name: 'categoryID', type: 'checkbox', value: CATEGORY_IDS.topicsEvents, checked: false },
    ]);
    expect(markup).toContain(
      `<input type="checkbox" name="categoryID" class="checkbox" checked value="${CATEGORY_IDS.topicsNews}"/> News `,
    );
    expect(markup).toContain('Events &amp; Calendar ');
    expect(markup).toContain('\n<li>\nRestricted Notices \n</li>');
  });

  it('renders the level below parentId under elementName', () => {
    const markup = nest({ parentId: CATEGORY_IDS.topics, elementName: 'filterCategoryID' });
    expect(fragmentModel(markup).controls.map((control) => [control.name, control.value])).toEqual([
      ['filterCategoryID', CATEGORY_IDS.topicsNews],
      ['filterCategoryID', CATEGORY_IDS.topicsEvents],
    ]);
    expect(markup).not.toContain('General Topics');
  });

  it('renders nothing for a leaf parentId', () => {
    expect(nest({ parentId: CATEGORY_IDS.restricted })).toBe('');
  });
});

describe('draftPromptJs', () => {
  it('renders the draft prompt script', () => {
    const ctx = contextFor(editorRequest());
    const markup = markupOf(draftPromptJs(ctx));
    expect(occurrences(markup, '<script')).toBe(1);
    for (const text of [
      '$(function(){\n\tinitDraftPrompt();\n});',
      'function draftprompt(e){',
      `url: "./index.cfm?muraAction=carch.draftpromptdata&contentid=" + node.attr('data-contentid')`,
      `title:"${encodeJs(ctx.rb.rbKey('sitemanager.draftprompt.title'))}",`,
      '$("#locknodetoggle").on("change",function(){',
      'actionModal(href);',
      "$('a.draftprompt').click(draftprompt);",
    ]) {
      expect(markup).toContain(text);
    }
  });
});

describe('carchJs', () => {
  const architecture = (): string =>
    `\n\t<script src="${adminRoot()}/assets/js/architecture.min.js?coreversion=7.6.1" ` +
    'type="text/javascript" ></script>\n';
  const js = (action: string): string => markupOf(carchJs(contextFor(adminS2Request()), action));

  it.each(['list', 'draft', 'hist'])('renders only the architecture script for %s', (action) => {
    expect(js(action)).toBe(architecture());
  });

  it.each(['edit', 'Edit'])('loads the summary CKEditor for %s', (action) => {
    const markup = js(action);
    expect(markup.startsWith(architecture())).toBe(true);
    for (const text of [
      '<script type="text/javascript">\n\t  summaryLoaded=false;\n\t</script>',
      'summaryLoaded=true;',
      'editSummary = function(){',
      'if(!summaryLoaded){',
      "jQuery('#summary').ckeditor(",
      "{ toolbar:'Summary',",
      "customConfig : 'config.js.cfm'},",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).not.toContain('FCKeditor');
    expect(markup).not.toContain('/plugins/');
  });

  it('loads FCKeditor when configured', () => {
    vi.stubEnv('MURA_HTMLEDITORTYPE', 'fckeditor');
    resetLegacySettingsForTests();
    const markup = js('edit');
    expect(markup).toContain("var oFCKeditor = new FCKeditor( 'summary' ) ;");
    expect(markup).toContain(`oFCKeditor.BasePath\t\t= "${legacySettings().context}/wysiwyg/";`);
    expect(markup).toContain('oFCKeditor.ToolbarSet\t\t\t= "Summary";');
    expect(markup).toContain("oFCKeditor.Config.DefaultLanguage='en_us';");
    expect(markup).not.toContain('ckeditor(');
    expect(markup).not.toContain('fckconfig.js.cfm');
  });

  it('omits the editor loader for none', () => {
    vi.stubEnv('MURA_HTMLEDITORTYPE', 'none');
    resetLegacySettingsForTests();
    const markup = js('edit');
    expect(markup).toContain('editSummary = function(){');
    expect(markup).not.toContain('if(!summaryLoaded){');
  });
});

/** Variable names and `sitemanager.configurator.` keys of the nine configurator titles. */
const CONFIGURATOR_TITLES = [
  ['remoteFeedConfiguratorTitle', 'remotefeedtitle'],
  ['localIndexConfiguratorTitle', 'localindextitle'],
  ['tagCloudConfiguratorTitle', 'tagcloudtitle'],
  ['categorySummaryConfiguratorTitle', 'categorysummarytitle'],
  ['slideShowConfiguratorTitle', 'slideshowtitle'],
  ['relatedContentConfiguratorTitle', 'relatedcontenttitle'],
  ['siteMapConfiguratorTitle', 'sitemaptitle'],
  ['genericConfiguratorTitle', 'generictitle'],
  ['genericConfiguratorMessage', 'genericmessage'],
] as const;

const CONFIGURATOR_INPUT: ConfiguratorJsInput = {
  contentId: CONTENT_IDS.aboutUs,
  parentId: HOME_ID,
  contentHistId: CONTENT_HIST_IDS.aboutUs,
  customTagGroups: 'A,B',
  displayObjects: [
    { objectid: 'feed', configuratorInit: 'initFeedConfigurator', configuratorJS: 'js/feed.js' },
    { objectid: 'plain', configuratorInit: '', configuratorJS: 'js/plain.js' },
    { objectid: 'nav', configuratorInit: 'initNavConfigurator', configuratorJS: 'js/nav.js' },
  ],
  useLayoutManager: true,
  siteAssetPath: `/sites/${SITE}`,
};

describe('configuratorJs', () => {
  const ctx = () => contextFor(siteAdminRequest(SITE));
  const configurator = (fields: Partial<ConfiguratorJsInput> = {}): string =>
    markupOf(configuratorJs(ctx(), { ...CONFIGURATOR_INPUT, ...fields }));

  it.each([
    ['A,B', '["A","B"]'],
    ['A^B', '["A^B"]'],
    ['A,,B', '["A","B"]'],
    ['', '[]'],
  ])('serializes customTagGroups %j', (groups, json) => {
    expect(configurator({ customTagGroups: groups })).toContain(`\nsiteManager.customtaggroups=${json};\n`);
  });

  it('encodes the configurator titles', () => {
    const { rb } = ctx();
    const markup = configurator();
    for (const [name, key] of CONFIGURATOR_TITLES) {
      expect(markup).toContain(`var ${name}='${encodeJs(rb.rbKey(`sitemanager.configurator.${key}`))}';`);
    }
  });

  it('writes the content ids', () => {
    const markup = configurator();
    expect(markup).toContain(`var contentid='${encodeJs(CONTENT_IDS.aboutUs)}';`);
    expect(markup).toContain(`var parentid='${encodeJs(HOME_ID)}';`);
    expect(markup).toContain(`var contenthistid='${encodeJs(CONTENT_HIST_IDS.aboutUs)}';`);
    expect(markup).not.toContain('siteManager.layoutmanager');
  });

  it('writes the content bean history id raw with the layout manager', () => {
    const markup = configurator({ contentBeanHistId: CONTENT_HIST_IDS.aboutUsDraft });
    expect(markup).toContain(`var contenthistid='${CONTENT_HIST_IDS.aboutUsDraft}';`);
    expect(markup).toContain('\n\tsiteManager.layoutmanager=true;\n');
  });

  it.each<[ConfiguratorJsInput['allowOpenFeeds'], string]>([
    [undefined, 'false'],
    [true, 'true'],
  ])('sets allowopenfeeds for %s', (allowOpenFeeds, literal) => {
    expect(configurator({ allowOpenFeeds })).toContain(`\nsiteManager.allowopenfeeds=${literal};\n`);
  });

  it('pushes one configurator per display object with an init', () => {
    const markup = configurator();
    expect(occurrences(markup, 'pluginConfigurators.push(')).toBe(2);
    expect(markup).toContain("pluginConfigurators.push({'objectid':'feed','init':'initFeedConfigurator'});");
    expect(markup).toContain("pluginConfigurators.push({'objectid':'nav','init':'initNavConfigurator'});");
    expect(markup).toContain(`<script type="text/javascript" src="/sites/${SITE}/js/feed.js"></script>`);
    expect(markup).toContain(`<script type="text/javascript" src="/sites/${SITE}/js/nav.js"></script>`);
    expect(markup).not.toContain("'objectid':'plain'");
    expect(markup).not.toContain('js/plain.js');
    expect(markup).not.toContain('/plugins/');
  });
});

const ABOUT_URL = `${WEB}/about-us/`;
const NEWS_URL = `${WEB}/news/`;

/** An active, on-display tenant-a page; `fields` overrides any member. */
const closeContent = (fields: Partial<CloseCompactContent> = {}): CloseCompactContent => ({
  active: true,
  isOnDisplay: true,
  type: 'Page',
  contentId: CONTENT_IDS.aboutUs,
  contentHistId: CONTENT_HIST_IDS.aboutUs,
  url: ABOUT_URL,
  previewUrl: `${ABOUT_URL}?previewid=${CONTENT_HIST_IDS.aboutUs}`,
  ...fields,
});

/** The News parent of a File or Link save; `fields` overrides any member. */
const closeParent = (fields: Partial<CloseCompactParent> = {}): CloseCompactParent => ({
  ...closeContent({
    contentId: CONTENT_IDS.news,
    contentHistId: CONTENT_HIST_IDS.news,
    url: NEWS_URL,
    previewUrl: `${NEWS_URL}?previewid=${CONTENT_HIST_IDS.news}`,
  }),
  previewUrlForParentHistId: `${NEWS_URL}?previewid=${CONTENT_HIST_IDS.newsArticleDraft}`,
  parentHistIdExists: true,
  ...fields,
});

/** A Page add without the layout manager; `fields` overrides any member. */
const closeModel = (fields: Partial<CloseCompactDisplayModel> = {}): CloseCompactDisplayModel => ({
  action: 'add',
  homeId: '',
  homeUrl: '',
  preview: '0',
  edited: { type: 'Page', contentId: CONTENT_IDS.aboutUs, remoteUrl: '', active: true },
  useLayoutManager: false,
  ...fields,
});

const FILE_EDITED = { type: 'File', contentId: CONTENT_IDS.brochurePdf, remoteUrl: '', active: true } as const;
const CURRENT_PREVIEW = `${ABOUT_URL}?previewID=${CONTENT_HIST_IDS.aboutUsDraft}`;
const CURRENT = { ...closeContent(), previewUrlForEdited: CURRENT_PREVIEW };

describe('closeCompactDisplay', () => {
  const close = (req: Req, model: CloseCompactDisplayModel): string => closeCompactDisplay(contextFor(req), model);

  it('returns the XHTML close document', () => {
    const doc = close(adminS2Request(), closeModel({ current: CURRENT }));
    expect(typeof doc).toBe('string');
    expect(
      doc.startsWith(
        '\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ' +
          '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n' +
          '<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n' +
          '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />\n',
      ),
    ).toBe(true);
    expect(doc).toContain(
      `<script src="${adminRoot()}/assets/js/jquery/jquery.js?coreversion=7.6.1" type="text/javascript"></script>\n` +
        `<script src="${adminRoot()}/assets/js/porthole/porthole.min.js?coreversion=7.6.1" ` +
        'type="text/javascript"></script>\n',
    );
    expect(doc).toContain(`frontEndProxy = new Porthole.WindowProxy("${adminRoot()}/assets/js/porthole/proxy.html");`);
    expect(doc.endsWith('</head>\n<body onload="reload()">\n</body>\n</html>\n')).toBe(true);
  });

  it.each<[string, Partial<CloseCompactDisplayModel>, string]>([
    ['preview', { preview: '1', current: CURRENT }, CURRENT_PREVIEW],
    ['live current', { current: CURRENT }, ABOUT_URL],
    [
      'inactive',
      { current: { ...CURRENT, active: false } },
      `${ABOUT_URL}?previewid=${CONTENT_HIST_IDS.aboutUs}`,
    ],
    [
      'parent fallback',
      { edited: FILE_EDITED, parent: closeParent(), parentHistId: CONTENT_HIST_IDS.newsArticleDraft },
      `${NEWS_URL}?previewid=${CONTENT_HIST_IDS.newsArticleDraft}`,
    ],
    ['live parent', { edited: FILE_EDITED, parent: closeParent(), parentHistId: CONTENT_HIST_IDS.news }, NEWS_URL],
    [
      'multiFileUpload parent off display',
      { action: 'multiFileUpload', edited: FILE_EDITED, parent: closeParent({ isOnDisplay: false }) },
      `${NEWS_URL}?previewid=${CONTENT_HIST_IDS.news}`,
    ],
    ['home', { homeId: HOME_ID, homeUrl: `${WEB}/` }, `${WEB}/`],
    [
      'variation',
      { edited: { type: 'Variation', contentId: CONTENT_IDS.homeBanner, remoteUrl: `${WEB}/promo/`, active: true } },
      `${WEB}/promo/`,
    ],
    ['saved content parent', { action: 'update', fallback: closeContent({ url: NEWS_URL }) }, NEWS_URL],
  ])('sends the front end to the %s URL', (_name, fields, href) => {
    const doc = close(adminS2Request(), closeModel(fields));
    expect(doc).toContain(`var cmd={cmd:'setLocation',location:encodeURIComponent("${encodeJs(href)}")};`);
    expect(doc).toContain(`location.href="${encodeJs(href)}";`);
  });

  it('requires the branch bean', () => {
    expect(() => close(adminS2Request(), closeModel())).toThrow(/model\.current/);
  });

  it.each<[string, string]>([
    ['Form', `params:{objectid:'${CONTENT_IDS.contactForm}'}`],
    ['Component', `params:{objectid:'${CONTENT_IDS.contactForm}'}`],
    ['Page', 'params:{}'],
  ])('posts setObjectParams for a %s instance', (type, params) => {
    const req = adminS2Request({ session: { muraValues: { objectInstanceId: 'INSTANCE-1' } } });
    const doc = close(
      req,
      closeModel({
        action: 'update',
        useLayoutManager: true,
        fallback: closeContent({ type, contentId: CONTENT_IDS.contactForm }),
      }),
    );
    expect(doc).toContain(`var cmd={cmd:'setObjectParams',reinit:true,instanceid:'INSTANCE-1',${params}};`);
    expect(doc).not.toContain("cmd:'setLocation'");
    expect(req.session.mura).toMatchObject({ objectInstanceId: '' });
    expect(req.sessionWrites).toMatchObject({ muraValues: { objectInstanceId: '' } });
  });

  it('keeps setLocation without the layout manager', () => {
    const req = adminS2Request({ session: { muraValues: { objectInstanceId: 'INSTANCE-1' } } });
    const doc = close(req, closeModel({ homeId: HOME_ID, homeUrl: `${WEB}/` }));
    expect(doc).toContain(`var cmd={cmd:'setLocation',location:encodeURIComponent("${encodeJs(`${WEB}/`)}")};`);
    expect(req.sessionWrites).toMatchObject({ muraValues: { objectInstanceId: '' } });
  });
});

const STATUS_CONTENT: StatusContent = {
  contentId: CONTENT_IDS.newsLocked,
  siteId: SITE,
  contentHistId: CONTENT_HIST_IDS.newsLocked,
  approvalStatus: '',
  display: 1,
  displayIntervalDesc: '',
  conflicts: [],
};

const LOCKER = { fname: 'Ann', lname: 'Lee', email: 'ann@example.com' } as const;
const OTHER_LOCK = { lockID: USER_IDS.s2PrivateMember, lockType: 'node' } as const;

/** The status markup for `req`, its DOM model and the CSRF contexts identity was asked for. */
async function renderStatus(req: Req, fields: Partial<StatusModel>) {
  const ctx = contextFor(req);
  const markup = markupOf(
    await status(ctx, { hasLockableNodes: true, stats: {}, content: STATUS_CONTENT, parentType: 'Folder', ...fields }),
  );
  const contexts = ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.method === 'POST' && call.path === '/v1/csrf/tokens')
    .flatMap((call) => (call.json as { readonly contexts: readonly string[] }).contexts);
  return { rb: ctx.rb, markup, model: fragmentModel(markup), contexts };
}

const UNLOCK_CONTEXT = `${STATUS_CONTENT.contentId}unlocknode`;

describe('status', () => {
  it('shows the lock held by the current user', async () => {
    const req = siteAdminRequest(SITE);
    const { rb, markup, model, contexts } = await renderStatus(req, {
      stats: { lockID: req.session.mura.userID, lockType: 'node' },
    });
    const unlockLabel = rb.rbKey('sitemanager.content.fields.unlocknode');
    expect(markup).toContain('<p id="msg-node-locked" class="alert alert-error">');
    expect(markup).not.toContain('display:none');
    expect(markup).not.toContain('<p id="msg-node-locked-else"');
    expect(model.alerts).toEqual([
      {
        className: 'alert alert-error',
        text: `${rb.rbKey('sitemanager.content.fields.youvelockednode')} ${unlockLabel}`,
      },
    ]);
    expect(model.links).toEqual([{ href: '#', text: unlockLabel }]);
    expect(contexts).toEqual([UNLOCK_CONTEXT]);
    expect(markup).toContain(`contentid:"${STATUS_CONTENT.contentId}",`);
    expect(markup).toContain(`siteid:"${SITE}",`);
    expect(markup).toContain(`csrf_token:'${FIXED_CSRF.token}',`);
    expect(markup).toContain(`csrf_token_expires: '${FIXED_CSRF.expires}'`);
    expect(markup).not.toContain('approvalModalContainer');
  });

  it.each<[string, () => Req, boolean]>([
    ['S2', () => adminS2Request(), true],
    ['a site admin', () => siteAdminRequest(SITE), true],
    ['an editor', () => editorRequest(), false],
  ])('shows the lock held by someone else to %s', async (_name, request, unlock) => {
    const { rb, markup, model, contexts } = await renderStatus(request(), { stats: OTHER_LOCK, lockedBy: LOCKER });
    expect(markup).toContain('<p id="msg-node-locked-else" class="alert alert-error">');
    expect(model.alerts[0]?.text).toContain('Ann Lee');
    const mailto = {
      href: `mailto:${LOCKER.email}?subject=${rb.rbKey('sitemanager.nodeunlockrequest')}`,
      text: rb.rbKey('sitemanager.requestnoderelease'),
    };
    const unlockLink = { href: '#', text: rb.rbKey('sitemanager.content.fields.unlocknode') };
    expect(model.links).toEqual(unlock ? [mailto, unlockLink] : [mailto]);
    expect(markup).toContain("$('.form-actions').hide();\n\t\t\t\tlockedbysomeonelse=true;");
    expect(contexts).toEqual([UNLOCK_CONTEXT]);
  });

  it('omits the approval block when showApprovalStatus is undefined', async () => {
    const { markup, contexts } = await renderStatus(adminS2Request(), {
      hasLockableNodes: false,
      content: { ...STATUS_CONTENT, approvalStatus: 'Pending' },
    });
    expect(markup.trim()).toBe('');
    expect(contexts).toEqual([]);
  });

  it.each([
    ['Pending', 'sitemanager.content.pendingmessage'],
    ['Rejected', 'sitemanager.content.rejectedmessage'],
  ])('links the %s approval status', async (approvalStatus, messageKey) => {
    const { rb, markup, model, contexts } = await renderStatus(siteAdminRequest(SITE), {
      hasLockableNodes: false,
      showApprovalStatus: true,
      content: { ...STATUS_CONTENT, approvalStatus },
    });
    const viewDetails = rb.rbKey('sitemanager.content.viewdetails');
    expect(markup).toContain('id="approvalModalContainer"></div>');
    expect(model.alerts).toEqual([{ className: 'alert alert-error', text: `${rb.rbKey(messageKey)}: ${viewDetails}` }]);
    expect(model.links).toEqual([{ href: '#', text: viewDetails }]);
    expect(markup).toContain(
      `onclick="return viewStatusInfo('${encodeJs(STATUS_CONTENT.contentHistId)}','${encodeJs(SITE)}');"`,
    );
    expect(markup).toContain('function applyApprovalAction(requestid,action,comment,siteid){');
    expect(markup).toContain(
      `csrf_token:'${FIXED_CSRF.token}',\n\t\t\t\t\tcsrf_token_expires: '${FIXED_CSRF.expires}'`,
    );
    expect(markup).toContain(`window.location.href.replace('${STATUS_CONTENT.contentHistId}',data.contenthistid);`);
    expect(contexts).toEqual(['approvalaction']);
  });

  it('defines the apply action the pending status modal calls', async () => {
    const { markup } = await renderStatus(siteAdminRequest(SITE), {
      hasLockableNodes: false,
      showApprovalStatus: false,
      content: { ...STATUS_CONTENT, approvalStatus: 'Pending' },
    });
    expect(fragmentModel(markup).alerts).toEqual([]);
    expect(markup).toContain('function applyApprovalAction(requestid,action,comment,siteid){');
    expect(fragmentModel(statusModalPending.body).buttons).toContainEqual({
      text: 'Apply',
      type: 'button',
      hasOnclick: true,
    });
    expect(statusModalPending.body).toContain('onclick="applyApprovalAction(');
    expect(statusModalPending.body).toContain(`'${encodeJs(SITE)}');"/>`);
  });

  it.each<[string, string, string]>([
    ['a full page', '', 'target="_blank"'],
    ['compact display', 'true', 'target="_top"'],
  ])('lists calendar conflicts in %s', async (_name, compactDisplay, target) => {
    const editUrl = `./?muraAction=cArch.edit&contentid=${CONTENT_IDS.eventItem}&siteid=${SITE}`;
    const dates = [`${WEB}/events/_/date/2026/7/4/`, `${WEB}/events/_/date/2026/7/5/`];
    const { rb, markup, model } = await renderStatus(siteAdminRequest(SITE, { rc: { compactDisplay } }), {
      hasLockableNodes: false,
      showApprovalStatus: true,
      parentType: 'Calendar',
      content: {
        ...STATUS_CONTENT,
        display: 2,
        displayIntervalDesc: 'Every day',
        conflicts: [
          {
            editUrl,
            title: 'Board & Staff',
            details: dates.map((href, i) => ({ href, displayStart: new Date(2026, 6, 4 + i, 10) })),
          },
        ],
      },
    });
    expect(model.alerts.map((alert) => alert.className)).toEqual(['alert alert-info', 'alert alert-error']);
    expect(model.alerts[0]?.text).toBe(`${rb.rbKey('sitemanager.content.fields.display')}: Every day`);
    const heading = rb.rbKey('sitemanager.content.fields.displayinterval.schedulingconflicts');
    expect(model.alerts[1]?.text).toContain(`${heading}:`);
    expect(model.links.map((link) => link.href)).toEqual([normaliseAdminUrl(editUrl), ...dates]);
    expect(model.links[0]?.text).toBe('Board & Staff:');
    expect(occurrences(markup, target)).toBe(2);
    expect(markup).toContain('Board &amp; Staff:</strong></a>');
  });

  it('skips calendar notices under other parents', async () => {
    const { model } = await renderStatus(siteAdminRequest(SITE), {
      hasLockableNodes: false,
      showApprovalStatus: true,
      content: { ...STATUS_CONTENT, display: 2, displayIntervalDesc: 'Every day' },
    });
    expect(model.alerts).toEqual([]);
  });
});

const SCAFFOLD_TEMPLATES = [
  'scaffold-crumb-template',
  'scaffold-error-template',
  'scaffold-all-template',
  'scaffold-list-template',
  'scaffold-form-template',
];

describe('scaffold', () => {
  const permissionsLink = (siteId: string): string =>
    `<a class="btn" href="./?muraAction=cPerm.module&contentid=${SCAFFOLD_MODULE}&siteid=${siteId}` +
    `&moduleid=${SCAFFOLD_MODULE}">`;

  it('mounts the scaffolder', () => {
    const markup = markupOf(scaffold(contextFor(editorRequest()), { siteId: 'default' }));
    expect(markup).toContain('<script>\n\tvar Assembler = "";\n\tvar Scaffolder = "";\n\tvar Master = "";\n');
    expect(markup).toContain('<script src="/core/vendor/vue/vue.js"></script>');
    const { adminDir } = legacySettings();
    expect(markup).toContain(`<script src="${adminDir}/assets/js/scaffold/scaffolder.min.js"></script>`);
    expect(markup).toContain('<div id="container-scaffold">');
    for (const id of SCAFFOLD_TEMPLATES) expect(markup).toContain(`<template id="${id}">`);
  });

  // isSuperUser() prints listFindNoCase's position of S2 in the memberships (the third for the S2 preset), else 0.
  it.each<[string, () => Req, string, string, boolean]>([
    ['S2', () => adminS2Request(), 'default', '3', true],
    ['a site admin', () => siteAdminRequest(SITE), SITE, '0', true],
    ['an editor', () => editorRequest(), 'default', '0', false],
  ])('renders the permissions buttons for %s', (_name, request, siteId, superUser, buttons) => {
    const ctx = contextFor(request());
    const markup = markupOf(scaffold(ctx, { siteId }));
    expect(markup).toContain(`\n  var IsSuperUser = ${superUser};\n`);
    expect(occurrences(markup, permissionsLink(siteId))).toBe(buttons ? 2 : 0);
    expect(markup.includes(`<i class="mi-group"></i> ${ctx.rb.rbKey('sitemanager.permissions')}</a>`)).toBe(buttons);
  });
});
