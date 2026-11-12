// dspZoom, dspZoomNoLinks, renderIcon, carch dsp_close_compact_display.cfm and dsp_configuratorJS.cfm, against legacy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { CONTENT_MODULE_ID } from '@/screens/carch/model';
import {
  closeCompactDisplay,
  type CloseCompactContent,
  type CloseCompactCurrent,
  type CloseCompactDisplayModel,
  type CloseCompactEdited,
  type CloseCompactParent,
} from '@/screens/carch/partials/close-compact-display';
import {
  configuratorJs,
  type ConfiguratorDisplayObject,
  type ConfiguratorJsInput,
} from '@/screens/carch/partials/configurator-js';
import {
  dspZoom,
  dspZoomNoLinks,
  htmlEditFormat,
  renderIcon,
  type ZoomCrumb,
  type ZoomOptions,
} from '@/screens/carch/partials/zoom';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const HOME_ID = '00000000000000000000000000000000001';
const COMPONENTS_MODULE_ID = '00000000000000000000000000000000003';
const NODE_ID = 'C1000000-0000-0000-0000000000000001';
const PARENT_ID = 'C1000000-0000-0000-0000000000000002';

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

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

/** A Site Manager page crumb on `default`; `fields` overrides any member. */
const crumb = (contentid: string, menutitle: string, fields: Partial<ZoomCrumb> = {}): ZoomCrumb => ({
  siteid: 'default',
  contentid,
  type: 'Page',
  menutitle,
  restricted: 0,
  ...fields,
});

const HOME = crumb(HOME_ID, 'Home');

/** dspZoom's non-ajax link to `cArch.list` under the default context and admin directory. */
const listHref = (contentid: string, moduleid = CONTENT_MODULE_ID, siteid = 'default'): string =>
  `/admin/?muraAction=cArch.list&siteid=${siteid}&topid=${contentid}&moduleid=${moduleid}&activeTab=0`;

const zoomCtx = (): Parameters<typeof dspZoom>[0] => ({ req: adminS2Request() });

const zoom = (opts: ZoomOptions): string => toString(dspZoom(zoomCtx(), opts));

const zoomNoLinks = (opts: ZoomOptions): string => toString(dspZoomNoLinks(zoomCtx(), opts));

/** The opening `<li>` tags of `markup`, root first. */
const itemTags = (markup: string): string[] => markup.match(/<li[^>]*>/g) ?? [];

/** The menu titles dspZoomNoLinks printed, root first. */
const plainTitles = (markup: string): string[] =>
  Array.from(markup.matchAll(/<li[^>]*> (?:<strong>)?([^<]*)/g), (match) => match[1] ?? '');

describe('htmlEditFormat', () => {
  it.each([
    ['plain text', 'About Us', 'About Us'],
    ['markup', '<a href="x">R&D</a>', '&lt;a href=&quot;x&quot;&gt;R&amp;D&lt;/a&gt;'],
    ['an entity', '&amp;', '&amp;amp;'],
    ['line breaks', 'a\r\nb\rc\nd', 'a\nbc\nd'],
    ['apostrophes and non-ASCII', "Zoë's café", "Zoë's café"],
  ])('formats %s', (_case, input, expected) => {
    expect(htmlEditFormat(input)).toBe(expected);
  });
});

describe('renderIcon', () => {
  it.each<[string, ZoomCrumb | Readonly<Record<string, unknown>>, string]>([
    [
      'the extension icon class first',
      crumb(NODE_ID, 'R', { type: 'File', fileext: 'pdf', iconclass: 'mi-star' }),
      'mi-star',
    ],
    ['the lower-cased type', crumb(NODE_ID, 'R', { type: 'Calendar' }), 'calendar'],
    ['the type past a NULL icon class', crumb(NODE_ID, 'R', { type: 'Folder', iconclass: null }), 'folder'],
    ['the lower-cased extension of a file', crumb(NODE_ID, 'R', { type: 'File', fileext: 'PDF' }), 'pdf'],
    ['a type matched case-insensitively', crumb(NODE_ID, 'R', { type: 'FILE', fileext: 'Doc' }), 'doc'],
    ['page for a file without fileext', crumb(NODE_ID, 'R', { type: 'File' }), 'page'],
    ['an empty extension for a NULL fileext', crumb(NODE_ID, 'R', { type: 'File', fileext: null }), ''],
    ['keys read case-insensitively', { TYPE: 'File', FileExt: 'XLSX', IconClass: '' }, 'xlsx'],
  ])('returns %s', (_case, source, expected) => {
    expect(renderIcon(source)).toBe(expected);
  });
});

describe('dspZoom', () => {
  it('renders the lone node', () => {
    const markup = dspZoom(zoomCtx(), { crumbdata: [HOME] });
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(
      '<ul class="breadcrumb">\n\t\t\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\thref="' +
        listHref(HOME_ID) +
        '"\n\t\t><i class="page"></i>Home</a></strong></li>\n\t\t</ul>',
    );
  });

  it('renders root to node with sticky locks and escaped titles', () => {
    const node = crumb(NODE_ID, 'R&D <Team>');
    const area = crumb(PARENT_ID, 'Private "Area"', { type: 'Folder', iconclass: 'mi-folder', restricted: 1 });
    expect(zoom({ crumbdata: [node, area, HOME] })).toBe(
      [
        '<ul class="breadcrumb">\n\t\t',
        '\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\thref="',
        listHref(HOME_ID),
        '"\n\t\t\t><i class="page"></i>Home</a></li>\n\t\t',
        '\n\t\t\t<li class="locked">\n\t\t\t<a \n\t\t\t\thref="',
        listHref(PARENT_ID),
        '"\n\t\t\t><i class="mi-folder"></i>Private &quot;Area&quot;</a></li>\n\t\t',
        '\n\t\t<li class="locked"><strong>\n\t\t<a \n\t\t\thref="',
        listHref(NODE_ID),
        '"\n\t\t><i class="page"></i>R&amp;D &lt;Team&gt;</a></strong></li>\n\t\t</ul>',
      ].join(''),
    );
  });

  it('reloads the Site Manager tab with ajax', () => {
    const node = crumb(NODE_ID, 'Footer', { moduleid: COMPONENTS_MODULE_ID, type: 'Component' });
    const onclick = (c: ZoomCrumb, moduleid: string): string =>
      'href="" onclick="return siteManager.loadSiteManagerInTab(function(){siteManager.loadSiteManager(' +
      `'default','${c.contentid}','${moduleid}','','','${c.type}',1)});"`;
    expect(zoom({ crumbdata: [node, HOME], ajax: true, class: 'breadcrumb' })).toBe(
      [
        '<ul class="breadcrumb">\n\t\t',
        `\n\t\t\t<li class="">\n\t\t\t<a \n\t\t\t\t${onclick(HOME, CONTENT_MODULE_ID)}`,
        '\n\t\t\t><i class="page"></i>Home</a></li>\n\t\t',
        `\n\t\t<li class=""><strong>\n\t\t<a \n\t\t\t${onclick(node, COMPONENTS_MODULE_ID)}`,
        '\n\t\t><i class="component"></i>Footer</a></strong></li>\n\t\t</ul>',
      ].join(''),
    );
  });

  it('links under the configured context and admin directory', () => {
    useSettings({ MURA_CONTEXT: '/cms', MURA_ADMINDIR: '/manage' });
    expect(zoom({ crumbdata: [HOME] })).toContain(`href="/cms${listHref(HOME_ID).replace('/admin', '/manage')}"`);
  });

  it('writes the class, ids and module unencoded, defaulting the module to Site Manager', () => {
    const component = crumb(NODE_ID, 'Footer', { siteid: 'my site', moduleid: COMPONENTS_MODULE_ID });
    const unset = crumb(PARENT_ID, 'Blank', { siteid: 'my site', moduleid: null });
    const root = crumb(HOME_ID, 'Home', { siteid: 'my site' });
    const markup = zoom({ crumbdata: [component, unset, root], class: 'a "b"' });
    expect(markup.startsWith('<ul class="a "b"">')).toBe(true);
    expect(Array.from(markup.matchAll(/href="([^"]*)"/g), (match) => match[1])).toEqual([
      listHref(HOME_ID, CONTENT_MODULE_ID, 'my site'),
      listHref(PARENT_ID, '', 'my site'),
      listHref(NODE_ID, COMPONENTS_MODULE_ID, 'my site'),
    ]);
  });

  it.each<[string, Partial<ZoomCrumb>, string]>([
    ['a file extension', { type: 'File', fileext: 'pdf' }, '<li class=" file" data-filetype="pdf">'],
    ['four icon characters', { type: 'File', fileext: 'JPEG2000' }, '<li class=" file" data-filetype="jpeg">'],
    ['an empty extension', { type: 'File', fileext: '' }, '<li class=" file" data-filetype="">'],
    ['an mi- icon class as no file', { type: 'File', fileext: 'pdf', iconclass: 'mi-file-pdf' }, '<li class="">'],
    ['an MI- icon class as no file', { type: 'File', iconclass: 'MI-file' }, '<li class="">'],
    ['the first non-empty icon class part', { type: 'File', iconclass: '-mi-file' }, '<li class="">'],
    ['a page as no file', { type: 'Page', iconclass: 'pdf' }, '<li class="">'],
  ])('tags %s on an ancestor and on the node', (_case, fields, tag) => {
    const file = crumb(NODE_ID, 'Report', fields);
    expect(itemTags(zoom({ crumbdata: [file, file, HOME] }))).toEqual(['<li class="">', tag, tag]);
  });

  it.each<[string, readonly (number | string | null)[], readonly string[]]>([
    ['keeps the lock below a restricted ancestor', [0, 0, 1, 0], ['', 'locked', 'locked', 'locked']],
    ['locks everything below a restricted root', [0, '1'], ['locked', 'locked']],
    ['ignores the restricted node itself', [1, 0, null], ['', '', '']],
    ['locks nothing without a restricted crumb', [0, null], ['', '']],
  ])('%s', (_case, restrictedNodeFirst, classesRootFirst) => {
    const crumbs = restrictedNodeFirst.map((restricted, i) => crumb(`C${i}`, `Crumb ${i}`, { restricted }));
    const classes = itemTags(zoom({ crumbdata: crumbs })).map((tag) => /class="([^"]*)"/.exec(tag)?.[1]);
    expect(classes).toEqual(classesRootFirst);
  });

  it('combines the lock with the file class', () => {
    const file = crumb(NODE_ID, 'Report', { type: 'File', fileext: 'pdf' });
    const locked = crumb(PARENT_ID, 'Private', { restricted: 1 });
    expect(itemTags(zoom({ crumbdata: [file, locked] }))).toEqual([
      '<li class="locked">',
      '<li class="locked file" data-filetype="pdf">',
    ]);
  });

  it('applies the level limits', () => {
    const crumbs = [crumb(NODE_ID, 'Node'), crumb(PARENT_ID, 'Parent'), HOME];
    expect(Array.from(zoom({ crumbdata: crumbs, maxLevels: 2 }).matchAll(/<\/i>([^<]*)<\/a>/g), (m) => m[1])).toEqual([
      'Parent',
      'Node',
    ]);
  });

  it('throws on an empty crumb list', () => {
    expect(() => dspZoom(zoomCtx(), { crumbdata: [] })).toThrow(
      new RangeError('The element at position 1 of the crumb array cannot be found.'),
    );
  });
});

describe('dspZoomNoLinks', () => {
  it('renders root to node with icon and lock classes', () => {
    const node = crumb(NODE_ID, 'R&D <Team>');
    const area = crumb(PARENT_ID, 'Private "Area"', { type: 'Folder', restricted: 1 });
    const markup = dspZoomNoLinks(zoomCtx(), { crumbdata: [node, area, HOME] });
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(
      [
        '\n\t\t<ul class="navZoom">\n\t\t',
        '\n\t\t\t<li class="page "> Home</li>\n\t\t',
        '\n\t\t\t<li class="folder locked"> Private &quot;Area&quot;</li>\n\t\t',
        '\n\t\t<li class="page locked"> <strong>R&amp;D &lt;Team&gt;</strong></li>\n\t\t</ul>',
      ].join(''),
    );
  });

  it('renders the lone node in the given class', () => {
    expect(zoomNoLinks({ crumbdata: [HOME], class: 'crumbs' })).toBe(
      '\n\t\t<ul class="crumbs">\n\t\t\n\t\t<li class="page "> <strong>Home</strong></li>\n\t\t</ul>',
    );
  });

  it.each<[string, Partial<ZoomCrumb>, string]>([
    ['a file extension', { type: 'File', fileext: 'PDF' }, '<li class="pdf  file" data-filetype="pdf">'],
    [
      'four icon characters',
      { type: 'File', fileext: 'jpeg2000' },
      '<li class="jpeg2000  file" data-filetype="jpeg">',
    ],
    ['an mi- icon class as no file', { type: 'File', iconclass: 'mi-file-pdf' }, '<li class="mi-file-pdf ">'],
  ])('tags %s', (_case, fields, tag) => {
    const file = crumb(NODE_ID, 'Report', fields);
    expect(itemTags(zoomNoLinks({ crumbdata: [file, file, HOME] }))).toEqual(['<li class="page ">', tag, tag]);
  });

  it('locks only crumbs within the limit', () => {
    const crumbs = [crumb(NODE_ID, 'Node'), crumb(PARENT_ID, 'Parent'), crumb(HOME_ID, 'Home', { restricted: 1 })];
    expect(itemTags(zoomNoLinks({ crumbdata: crumbs }))).toEqual([
      '<li class="page locked">',
      '<li class="page locked">',
      '<li class="page locked">',
    ]);
    expect(itemTags(zoomNoLinks({ crumbdata: crumbs, maxLevels: 2 }))).toEqual([
      '<li class="page ">',
      '<li class="page ">',
    ]);
  });

  // Running charCount, each title's length plus 3: Node 7, Parent 16, Section 26, Home 33.
  it.each<[string, Omit<ZoomOptions, 'crumbdata'>, readonly string[]]>([
    ['every crumb by default', {}, ['Home', 'Section', 'Parent', 'Node']],
    ['crumbs before the one reaching charLimit', { charLimit: 26 }, ['Parent', 'Node']],
    ['crumbs before the one passing charLimit', { charLimit: 27 }, ['Section', 'Parent', 'Node']],
    ['every crumb under charLimit', { charLimit: 34 }, ['Home', 'Section', 'Parent', 'Node']],
    ['the node when the node reaches charLimit', { charLimit: 7 }, ['Node']],
    ['minLevels over charLimit', { charLimit: 7, minLevels: 3 }, ['Section', 'Parent', 'Node']],
    ['no minLevels beyond the crumb count', { charLimit: 7, minLevels: 5 }, ['Node']],
    ['no minLevels below the count', { minLevels: 2 }, ['Home', 'Section', 'Parent', 'Node']],
    ['maxLevels', { maxLevels: 2 }, ['Parent', 'Node']],
    ['no maxLevels beyond the crumb count', { maxLevels: 5 }, ['Home', 'Section', 'Parent', 'Node']],
    ['maxLevels after minLevels', { minLevels: 3, maxLevels: 2 }, ['Parent', 'Node']],
    ['charLimit under maxLevels', { charLimit: 16, maxLevels: 3 }, ['Node']],
    ['the related-content limits', { charLimit: 90, minLevels: 2 }, ['Home', 'Section', 'Parent', 'Node']],
  ])('prints %s', (_case, limits, titles) => {
    const crumbs = [crumb(NODE_ID, 'Node'), crumb(PARENT_ID, 'Parent'), crumb('S', 'Section'), HOME];
    expect(plainTitles(zoomNoLinks({ crumbdata: crumbs, ...limits }))).toEqual(titles);
  });

  it('counts a NULL menu title as empty', () => {
    const crumbs = [crumb(NODE_ID, 'Node'), crumb(PARENT_ID, 'Parent', { menutitle: null }), HOME];
    expect(plainTitles(zoomNoLinks({ crumbdata: crumbs, charLimit: 11 }))).toEqual(['', 'Node']);
  });

  it('throws on an empty crumb list', () => {
    expect(() => dspZoomNoLinks(zoomCtx(), { crumbdata: [], charLimit: 10 })).toThrow(RangeError);
  });
});

/** A content bean whose URLs name it: `<id>Live` and `<id>Preview`, which esapiEncode leaves unchanged. */
const content = (id: string, fields: Partial<CloseCompactContent> = {}): CloseCompactContent => ({
  active: true,
  isOnDisplay: true,
  type: 'Page',
  contentId: id,
  contentHistId: `${id}HIST`,
  url: `${id}Live`,
  previewUrl: `${id}Preview`,
  ...fields,
});

const current = (id: string, fields: Partial<CloseCompactCurrent> = {}): CloseCompactCurrent => ({
  ...content(id),
  previewUrlForEdited: `${id}PreviewEdited`,
  ...fields,
});

const parent = (id: string, fields: Partial<CloseCompactParent> = {}): CloseCompactParent => ({
  ...content(id),
  previewUrlForParentHistId: `${id}PreviewRequested`,
  parentHistIdExists: true,
  ...fields,
});

const edited = (type: string, fields: Partial<CloseCompactEdited> = {}): CloseCompactEdited => ({
  type,
  contentId: 'EDITED',
  remoteUrl: 'variationRemote',
  active: true,
  ...fields,
});

/** An edit save closing to its live parent `PARENT`, outside the layout manager. */
const closeModel = (fields: Partial<CloseCompactDisplayModel> = {}): CloseCompactDisplayModel => ({
  action: 'edit',
  homeId: '',
  homeUrl: 'homeLive',
  preview: '0',
  edited: edited('Page'),
  fallback: content('PARENT'),
  useLayoutManager: false,
  ...fields,
});

/** The carch.update request after a compact save, `objectInstanceId` in `session.mura`. */
const closeRequest = (objectInstanceId?: string, frontEndProxyLoc = ''): AdminRequest =>
  adminS2Request({
    circuit: 'carch',
    item: 'update',
    session: {
      frontEndProxyLoc,
      ...(objectInstanceId === undefined ? {} : { muraValues: { objectInstanceId } }),
    },
  });

const close = (model: CloseCompactDisplayModel, req: AdminRequest = closeRequest()): string =>
  closeCompactDisplay({ req }, model);

/** The `var cmd` statement of a close document. */
const commandOf = (doc: string): string | undefined => /var cmd=.*;/.exec(doc)?.[0];

/** The `location.href` target and the `setLocation` target of a close document. */
const hrefsOf = (doc: string): readonly (string | undefined)[] => [
  /location\.href="([^"]*)"/.exec(doc)?.[1],
  /location:encodeURIComponent\("([^"]*)"\)/.exec(doc)?.[1],
];

describe('closeCompactDisplay', () => {
  it('renders the setLocation document', () => {
    const fallback = content('PARENT', { url: '/about/' });
    const doc = close(closeModel({ fallback }), closeRequest(undefined, 'http://tenant-a.localhost:8100'));
    expect(doc).toBe(
      [
        '',
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
        '<html xmlns="http://www.w3.org/1999/xhtml">',
        '<head>',
        '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" />',
        '',
        '<script src="/admin/assets/js/jquery/jquery.js?coreversion=7.6.1" type="text/javascript"></script>',
        '<script src="/admin/assets/js/porthole/porthole.min.js?coreversion=7.6.1" type="text/javascript"></script>',
        '<script>',
        '\t',
        '\t\tvar cmd={cmd:\'setLocation\',location:encodeURIComponent("\\x2Fabout\\x2F")};',
        '\t',
        '\tfunction reload(){',
        '\t\tif (top.location != self.location) {',
        '\t\t\tfrontEndProxy = new Porthole.WindowProxy("http\\x3A\\x2F\\x2Ftenant\\x2Da.localhost\\x3A8100/admin/assets/js/porthole/proxy.html");',
        '\t\t\tif (jQuery("#ProxyIFrame").length) {',
        '\t\t\t\tjQuery("#ProxyIFrame").load(function(){',
        "\t\t\t\t\tfrontEndProxy.post({cmd:'scrollToTop'});",
        '\t\t\t\t\tfrontEndProxy.post(cmd);',
        '\t\t\t\t});',
        '\t\t\t}',
        '\t\t\telse {',
        "\t\t\t\tfrontEndProxy.post({cmd:'scrollToTop'});",
        '\t\t\t\tfrontEndProxy.post(cmd);',
        '\t\t\t}',
        '',
        '\t\t} else {',
        '\t\t\tlocation.href="\\x2Fabout\\x2F";',
        '\t\t}',
        '\t}',
        '</script>',
        '',
        '</head>',
        '<body onload="reload()">',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    );
  });

  it('loads assets under the configured context and admin directory', () => {
    useSettings({ MURA_CONTEXT: '/cms', MURA_ADMINDIR: '/manage' });
    const doc = close(closeModel());
    expect(doc).toContain('<script src="/cms/manage/assets/js/jquery/jquery.js?coreversion=7.6.1"');
    expect(doc).toContain('<script src="/cms/manage/assets/js/porthole/porthole.min.js?coreversion=7.6.1"');
    expect(doc).toContain('new Porthole.WindowProxy("/cms/manage/assets/js/porthole/proxy.html")');
  });

  it.each<[string, Partial<CloseCompactDisplayModel>, string]>([
    ['a variation remote URL before the home URL', { edited: edited('Variation'), homeId: 'HOME' }, 'variationRemote'],
    ['the home URL', { homeId: 'HOME', action: 'add', current: current('NEW') }, 'homeLive'],
    ['the edited version of an add', { action: 'add', preview: '1', current: current('NEW') }, 'NEWPreviewEdited'],
    ['a live add', { action: 'ADD', current: current('NEW') }, 'NEWLive'],
    ['an inactive add preview', { action: 'add', current: current('NEW', { active: false }) }, 'NEWPreview'],
    ['an add off display', { action: 'add', current: current('NEW', { isOnDisplay: false }) }, 'NEWPreview'],
    ['the live parent of a File add', { action: 'add', edited: edited('File'), parent: parent('P') }, 'PLive'],
    [
      'the parent of a File add over a preview',
      { action: 'add', preview: '1', edited: edited('File'), parent: parent('P') },
      'PLive',
    ],
    [
      'the requested parent version of a Link add',
      { action: 'add', edited: edited('link'), parent: parent('P'), parentHistId: 'OTHERHIST' },
      'PPreviewRequested',
    ],
    [
      "the live parent when the requested version is the parent's own",
      { action: 'add', edited: edited('File'), parent: parent('P'), parentHistId: 'PHIST' },
      'PLive',
    ],
    [
      'the live parent when the requested version does not exist',
      { action: 'add', edited: edited('File'), parent: parent('P', { parentHistIdExists: false }), parentHistId: 'X' },
      'PLive',
    ],
    [
      'the inactive parent preview of a File add',
      { action: 'add', edited: edited('File'), parent: parent('P', { active: false }) },
      'PPreview',
    ],
    [
      'the requested parent version of a multi-file upload',
      { action: 'multiFileUpload', edited: edited('File'), parent: parent('P'), parentHistId: 'OTHERHIST' },
      'PPreviewRequested',
    ],
    [
      'the parent preview of a multi-file upload not on display',
      { action: 'multifileupload', edited: edited('File'), parent: parent('P', { isOnDisplay: false }) },
      'PPreview',
    ],
    ['the live parent of an edit', {}, 'PARENTLive'],
    ['the parent preview of an edit', { fallback: content('PARENT', { active: false }) }, 'PARENTPreview'],
  ])('sends %s', (_case, fields, href) => {
    expect(hrefsOf(close(closeModel(fields)))).toEqual([href, href]);
  });

  it.each<[string, Partial<CloseCompactDisplayModel>, 'current' | 'parent' | 'fallback']>([
    ['an add', { action: 'add', fallback: undefined }, 'current'],
    ['a File add', { action: 'add', edited: edited('File') }, 'parent'],
    ['a multi-file upload', { action: 'multiFileUpload' }, 'parent'],
    ['an edit', { fallback: undefined }, 'fallback'],
  ])('throws for %s without its bean', (_case, fields, field) => {
    expect(() => close(closeModel(fields))).toThrow(
      new TypeError(`closeCompactDisplay: model.${field} is required for this save`),
    );
  });

  const setLocation = 'var cmd={cmd:\'setLocation\',location:encodeURIComponent("PARENTLive")};';

  it.each<[string, Partial<CloseCompactDisplayModel>, string | undefined, string]>([
    ['outside the layout manager', {}, 'inst-1', setLocation],
    ['without an object instance', { useLayoutManager: true }, '', setLocation],
    [
      'for a saved Form',
      { useLayoutManager: true, action: 'add', edited: edited('Form', { contentId: 'F1' }), current: current('F1') },
      'inst-1',
      "var cmd={cmd:'setObjectParams',reinit:true,instanceid:'inst-1',params:{objectid:'F1'}};",
    ],
    [
      'for a saved component',
      { useLayoutManager: true, homeId: 'HOME', edited: edited('component', { contentId: 'COMP1' }) },
      'inst-1',
      "var cmd={cmd:'setObjectParams',reinit:true,instanceid:'inst-1',params:{objectid:'COMP1'}};",
    ],
    [
      'for other content',
      { useLayoutManager: true, edited: edited('Variation') },
      "in'st",
      "var cmd={cmd:'setObjectParams',reinit:true,instanceid:'in'st',params:{}};",
    ],
    [
      'for the parent an edit reassigns the bean to',
      { useLayoutManager: true, edited: edited('Page'), fallback: content('FORM2', { type: 'Form' }) },
      'inst-1',
      "var cmd={cmd:'setObjectParams',reinit:true,instanceid:'inst-1',params:{objectid:'FORM2'}};",
    ],
  ])('writes the command %s', (_case, fields, instanceId, command) => {
    expect(commandOf(close(closeModel(fields), closeRequest(instanceId)))).toBe(command);
  });

  it('indents the layout-manager command one level deeper', () => {
    const doc = close(closeModel({ useLayoutManager: true }), closeRequest('inst-1'));
    expect(doc).toContain(
      "<script>\n\t\n\t\t\tvar cmd={cmd:'setObjectParams',reinit:true,instanceid:'inst-1',params:{}};\n\t\t\n" +
        '\tfunction reload(){',
    );
    expect(doc).toContain('location.href="PARENTLive";');
  });

  it.each<[string, string | undefined]>([
    ['a set object instance', 'inst-1'],
    ['an unset object instance', undefined],
  ])('clears %s', (_case, instanceId) => {
    const req = closeRequest(instanceId);
    close(closeModel({ useLayoutManager: true }), req);
    expect(req.session.mura).toMatchObject({ objectInstanceId: '' });
    expect(req.sessionWrites.muraValues).toEqual({ objectInstanceId: '' });
  });
});

const FEED: ConfiguratorDisplayObject = {
  objectid: 'feed',
  configuratorInit: 'siteManager.initFeedConfigurator',
  configuratorJS: 'js/feed.js',
};

/** The Layout & Objects panel's values for an edited bean on `default`. */
const configuratorInput = (fields: Partial<ConfiguratorJsInput> = {}): ConfiguratorJsInput => ({
  contentId: NODE_ID,
  parentId: PARENT_ID,
  contentHistId: 'H-REQUEST',
  contentBeanHistId: 'H1000000-0000-0000-0000000000000001',
  customTagGroups: 'Header,Footer',
  displayObjects: [],
  useLayoutManager: false,
  siteAssetPath: '/sites/default',
  ...fields,
});

const configurator = (fields: Partial<ConfiguratorJsInput> = {}): string =>
  toString(configuratorJs({ rb: rbFor('en_US') }, configuratorInput(fields)));

describe('configuratorJs', () => {
  it('renders the globals and one script per configurator', () => {
    const markup = configuratorJs(
      { rb: rbFor('en_US') },
      configuratorInput({
        useLayoutManager: true,
        displayObjects: [
          FEED,
          { objectid: 'nav', configuratorInit: '', configuratorJS: 'js/nav.js' },
          { objectid: 'cta', configuratorInit: 'initCta', configuratorJS: '' },
        ],
      }),
    );
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(
      [
        '\n<script>\n',
        'siteManager.customtaggroups=["Header","Footer"];\n\n',
        "var remoteFeedConfiguratorTitle='Remote\\x20Feed';\n",
        "var localIndexConfiguratorTitle='Local\\x20Index';\n",
        "var tagCloudConfiguratorTitle='Tag\\x20Cloud';\n",
        "var categorySummaryConfiguratorTitle='Category\\x20Summary';\t\n",
        "var slideShowConfiguratorTitle='Slide\\x20Show';\t\n",
        "var relatedContentConfiguratorTitle='Related\\x20Content';\t\n",
        "var siteMapConfiguratorTitle='Site\\x20Map';\t\t\n",
        "var genericConfiguratorTitle='Not\\x20Available';\t\n",
        "var genericConfiguratorMessage='This\\x20display\\x20object\\x20does\\x20not\\x20have\\x20any\\x20configurable\\x20options.';\n",
        "var contentid='C1000000\\x2D0000\\x2D0000\\x2D0000000000000001';\n",
        "var parentid='C1000000\\x2D0000\\x2D0000\\x2D0000000000000002';\n",
        "\nvar contenthistid='H1000000-0000-0000-0000000000000001';\n",
        '\n\nsiteManager.allowopenfeeds=false;\n',
        '\nvar pluginConfigurators=new Array();\n',
        "\n\tpluginConfigurators.push({'objectid':'feed','init':'siteManager.initFeedConfigurator'});\n",
        "\n\tpluginConfigurators.push({'objectid':'cta','init':'initCta'});\n",
        '\n\tsiteManager.layoutmanager=true;\n',
        '\n</script>\n',
        '\n<script type="text/javascript" src="/sites/default/js/feed.js"></script>\n',
        '\n<script type="text/javascript" src="/sites/default/"></script>\n',
      ].join(''),
    );
  });

  it('renders no configurators', () => {
    const markup = configurator({ contentBeanHistId: undefined, useLayoutManager: true });
    expect(markup).toContain("\nvar contenthistid='H\\x2DREQUEST';\n");
    expect(markup.endsWith('\nvar pluginConfigurators=new Array();\n\n</script>\n')).toBe(true);
  });

  it.each<[string, string | undefined, boolean, string, boolean]>([
    ['the bean version with the layout manager', 'H1', true, "var contenthistid='H1';", true],
    ['the bean version without the layout manager', 'H1', false, "var contenthistid='H1';", false],
    ['an empty bean version over the request', '', true, "var contenthistid='';", true],
    ['the request version without a bean', undefined, true, "var contenthistid='H\\x2DREQUEST';", false],
  ])('writes %s', (_case, contentBeanHistId, useLayoutManager, histLine, layoutManager) => {
    const markup = configurator({ contentBeanHistId, useLayoutManager });
    expect(markup).toContain(`\n${histLine}\n`);
    expect(markup.includes('siteManager.layoutmanager=true;')).toBe(layoutManager);
  });

  it.each<[string, string | boolean | undefined, string]>([
    ['unset', undefined, 'false'],
    ['false', false, 'false'],
    ['true', true, 'true'],
    ['a configured string', 'yes', 'yes'],
    ['a configured number', '1', '1'],
  ])('prints allowopenfeeds %s', (_case, allowOpenFeeds, printed) => {
    expect(configurator({ allowOpenFeeds })).toContain(`\nsiteManager.allowopenfeeds=${printed};\n`);
  });

  it.each([
    ['no groups', '', '[]'],
    ['empty items dropped', ',Header,,Footer,', '["Header","Footer"]'],
    ['numbers and booleans as strings', '1,true', '["1","true"]'],
    ['quotes and backslashes escaped, slashes raw', 'a"b,c\\d,e/f', '["a\\"b","c\\\\d","e/f"]'],
    ['short escapes', '\b\f\n\r\t', '["\\b\\f\\n\\r\\t"]'],
    ['other control characters as lowercase \\u', '\u0001\u001f\u007f', '["\\u0001\\u001f\\u007f"]'],
    ['non-ASCII raw', 'Zoë,日本', '["Zoë","日本"]'],
  ])('serializes %s', (_case, customTagGroups, json) => {
    expect(configurator({ customTagGroups })).toContain(`\nsiteManager.customtaggroups=${json};\n`);
  });

  it('writes display-object values and the asset path unencoded', () => {
    const markup = configurator({
      siteAssetPath: '/my site',
      displayObjects: [{ objectid: "o'1", configuratorInit: 'init("x")', configuratorJS: 'a b.js' }],
    });
    expect(markup).toContain("\n\tpluginConfigurators.push({'objectid':'o'1','init':'init(\"x\")'});\n");
    expect(markup).toContain('\n<script type="text/javascript" src="/my site/a b.js"></script>\n');
  });
});
