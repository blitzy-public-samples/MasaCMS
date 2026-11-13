import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormInput, EditFormState } from '@/screens/carch/form/custom-tags';
import { renderLayoutObjectsPanel } from '@/screens/carch/form/panel-layoutobjects';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` of the default site's Home, a child Page and a child Folder, captured from the legacy ACF 2023 server
// as admin and cut from the panel's leading newline through the configurator script's `</script>\n`; the default
// theme with its layout manager on, then off with four regions, custom image sizes and seeded region objects.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/edit-layoutobjects-${name}.html`, import.meta.url), 'utf8');

const ROOT = '00000000000000000000000000000000001';
const CONTENT_MODULE = '00000000000000000000000000000000000';
const HOME_HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const PAGE_ID = '3FC53CE9-CE84-D36C-9FDD421339652522';
const PAGE_HIST = '3FC56571-01B7-3E2B-6DD650DBCA570AFB';
const FOLDER_ID = '3FC582AF-AB4D-90A9-A8A002C8DA69B12F';
const FOLDER_HIST = '3FC58A63-B4F9-FFAC-95C4E9763A389D9F';

const TEMPLATES = [
  'blank.cfm',
  'default.cfm',
  'home.cfm',
  'one_column.cfm',
  'three_column.cfm',
  'two_column_SL.cfm',
  'two_column_SR.cfm',
];

/** `request.inheritedObjects` resolved to Home, with the edit URL legacy builds for it. */
const HOME_INHERITANCE = {
  contentID: ROOT,
  menuTitle: 'Home',
  editURL: `/admin/?muraAction=cArch.edit&contenthistid=${HOME_HIST}&contentid=${ROOT}&type=Page&siteid=default&topid=${ROOT}&parentid=00000000000000000000000000000000END&moduleid=${CONTENT_MODULE}&compactdisplay=No#tabLayoutObjects`,
  perm: 'editor',
};

const STATE: EditFormState = {
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Page',
  compactDisplay: '',
  preview: '0',
};

interface Case {
  readonly request: Readonly<Record<string, string>>;
  readonly rc: Readonly<Record<string, unknown>>;
  readonly state?: Partial<EditFormState>;
}

function site(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    columnCount: 3,
    columnNames: 'Left Column^Main Content^Right Column',
    emailBroadcaster: 0,
    dataCollection: 1,
    hasFeedManager: 1,
    webPath: 'http://localhost:21680',
    templateList: '',
    customTagGroups: '',
    assetPath: '/sites/default',
    customImageSizes: [{ name: 'carouselimage' }, { name: 'hero' }],
    displayObjectLookup: [],
    ...overrides,
  };
}

function bean(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    isNew: 0,
    template: '',
    childTemplate: '',
    inheritObjects: 'Inherit',
    targetParams: '',
    imageSize: 'small',
    imageWidth: 'AUTO',
    imageHeight: 'AUTO',
    nextN: 10,
    displayList: 'Date,Title,Image,Summary,Credits',
    availableDisplayList: 'Date,Title,Image,Summary,Body,ReadMore,Credits,Comments,Tags,Rating',
    ...overrides,
  };
}

/** The view's rc, with templates the select filters out between the theme's layout files. */
function model(overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    rsTemplates: ['inc', ...TEMPLATES.slice(0, 3), 'readme.txt', 'layout.', ...TEMPLATES.slice(3)].map((name) => ({ name })),
    useLayoutManager: true,
    templateArray: [],
    site: site(),
    ...overrides,
  };
}

const PAGE_REQUEST = { contentid: PAGE_ID, contenthistid: PAGE_HIST, parentid: ROOT, type: 'Page' };

const HOME: Case = {
  request: { contentid: ROOT, contenthistid: HOME_HIST, parentid: '00000000000000000000000000000000END', type: 'Page' },
  rc: model({
    contentBean: bean({
      contentID: ROOT,
      contentHistID: HOME_HIST,
      parentID: '00000000000000000000000000000000END',
      template: 'default.cfm',
      inheritObjects: 'Cascade',
      urlStem: '/',
    }),
    inheritedObjects: { ...HOME_INHERITANCE },
  }),
};

const PAGE_BEAN = bean({
  contentID: PAGE_ID,
  contentHistID: PAGE_HIST,
  parentID: ROOT,
  urlStem: '/layout-child-page/',
  displayList: 'Title, Date,Summary',
  availableDisplayList: 'Date,Image,Body,ReadMore,Credits,Comments,Tags,Rating',
});

const PAGE: Case = { request: PAGE_REQUEST, rc: model({ contentBean: PAGE_BEAN, inheritedObjects: HOME_INHERITANCE }) };

const REGIONS_SITE = site({ columnCount: 4 });

const REGIONS_PAGE: Case = {
  request: PAGE_REQUEST,
  rc: model({
    contentBean: PAGE_BEAN,
    inheritedObjects: HOME_INHERITANCE,
    useLayoutManager: false,
    site: REGIONS_SITE,
    rsContentObjects1: [
      {
        object: 'component',
        name: 'Promo <Box> & "Co"',
        objectid: 'AAAA0000-1111-2222-3333444455556666',
        params: '{"a":"<b>&\\u00e9"}',
      },
      { object: 'system', name: 'Site Map', objectid: 'sitemap', params: null },
    ],
    rsContentObjects2: [],
    rsContentObjects3: [{ object: 'navigation', name: 'Peer Nav', objectid: 'peer_nav', params: '{}' }],
  }),
};

const REGIONS_FOLDER: Case = {
  request: { contentid: FOLDER_ID, contenthistid: FOLDER_HIST, parentid: ROOT, type: 'Folder' },
  rc: model({
    contentBean: bean({
      contentID: FOLDER_ID,
      contentHistID: FOLDER_HIST,
      parentID: ROOT,
      urlStem: '/layout-child-folder/',
      imageSize: 'carouselimage',
      nextN: 25,
    }),
    inheritedObjects: HOME_INHERITANCE,
    useLayoutManager: false,
    site: REGIONS_SITE,
  }),
};

function input(c: Case): EditFormInput {
  const req = adminS2Request({
    circuit: 'carch',
    item: 'edit',
    rc: { siteid: 'default', moduleid: CONTENT_MODULE, topid: ROOT, ...c.request },
  });
  // The panel reads only the context's bundle lookup.
  const ctx = { req, rb: rbFor(req.session.rb) } as Pick<ScreenContext, 'req' | 'rb'> as ScreenContext;
  return { ctx, req, data: { rc: c.rc }, state: { ...STATE, ...c.state } };
}

function render(c: Case): string {
  const panel = renderLayoutObjectsPanel(input(c));
  expect(isSafeHtml(panel.html)).toBe(true);
  return toString(panel.html);
}

/** `c` with its rc members replaced. */
const withRc = (c: Case, rc: Readonly<Record<string, unknown>>): Case => ({ ...c, rc: { ...c.rc, ...rc } });

/** `c` with its content bean members replaced. */
const withBean = (c: Case, values: Readonly<Record<string, unknown>>): Case =>
  withRc(c, { contentBean: { ...(c.rc.contentBean as object), ...values } });

/** `c` with its site members replaced. */
const withSite = (c: Case, values: Readonly<Record<string, unknown>>): Case =>
  withRc(c, { site: { ...(c.rc.site as object), ...values } });

describe('carch.edit Layout & Objects panel', () => {
  it.each<[string, Case, string]>([
    ['Home under the layout manager', HOME, 'layoutmanager-home'],
    ['an inheriting Page under the layout manager', PAGE, 'layoutmanager-page'],
    ['Home with empty regions', withSite(withRc(HOME, { useLayoutManager: false }), { columnCount: 4 }), 'regions-home'],
    ['a Page with region objects and list display options', REGIONS_PAGE, 'regions-page'],
    ['a Folder with a custom image size', REGIONS_FOLDER, 'regions-folder'],
  ])('matches the legacy capture of %s byte for byte', (_case, c, name) => {
    expect(render(c)).toBe(fixture(name));
  });

  it('reports its tab id and the label of its heading', () => {
    const panel = renderLayoutObjectsPanel(input(PAGE));
    expect(panel.tabId).toBe('tabLayoutObjects');
    expect(panel.tabLabel).toBe('Layout');
    expect(panel.bodyContent).toBeUndefined();
  });

  it('offers a renderer templateArray in place of the theme files, selecting the content template', () => {
    const markup = render(withBean(withRc(PAGE, { templateArray: ['a.cfm', 'B.cfm'] }), { template: 'b.CFM' }));
    expect(markup).toContain(
      '\n    \t\t\t                  <option value="a.cfm" >a.cfm</option>\n    \t\t\t                ' +
        '\n    \t\t\t                  <option value="B.cfm" selected>B.cfm</option>\n    \t\t\t                ' +
        '\n    \t\t          \t\t</select>',
    );
    expect(markup).toContain('<option value="two_column_SR.cfm" >two_column_SR.cfm</option>\n    \t\t                \n    \t          </select>');
  });

  it('offers the site templateList to the child template select only', () => {
    const markup = render(withBean(withSite(PAGE, { templateList: 'x.cfm^^y.cfm' }), { childTemplate: 'Y.cfm' }));
    expect(markup).toContain(
      '<option value="">none</option>\n    \t\t\t\t\t\t\t' +
        '\n    \t                  <option value="x.cfm" >x.cfm</option>\n    \t                ' +
        '\n    \t                  <option value="y.cfm" selected>y.cfm</option>\n    \t                ' +
        '\n    \t          </select>',
    );
    expect(markup).toContain('<option value="blank.cfm" >blank.cfm</option>\n    \t\t\t\t              ');
  });

  it('fails as legacy does when a non-array renderer templateArray meets a templateList', () => {
    expect(() => render(withSite(withRc(PAGE, { templateArray: 'x.cfm' }), { templateList: 'x.cfm' }))).toThrow(
      TypeError,
    );
    expect(render(withRc(PAGE, { templateArray: 'x.cfm' }))).toBe(fixture('layoutmanager-page'));
  });

  it('falls back to the theme files outside the Site Manager module', () => {
    const c = withRc({ ...PAGE, request: { ...PAGE_REQUEST, moduleid: '00000000000000000000000000000000003' } }, {
      templateArray: ['a.cfm'],
    });
    const markup = render(withSite(c, { templateList: 'x.cfm' }));
    expect(markup).not.toContain('a.cfm');
    expect(markup).not.toContain('x.cfm');
  });

  it.each<[string, string, string, boolean]>([
    ['Page', 'Page', '', true],
    ['Folder', 'Folder', '', true],
    ['Gallery', 'Gallery', '', true],
    ['Calendar (legacy spells it Calender)', 'Calendar', '', false],
    ['Link', 'Link', '', false],
    ['Page without the tab assigned', 'Page', 'Basic,Publishing', false],
    ['Page with the tab assigned', 'Page', 'Basic,list display options', true],
  ])('shows the list display options for %s: %s', (_case, type, tabAssignments, shown) => {
    const markup = render({ ...REGIONS_PAGE, request: { ...PAGE_REQUEST, type }, state: { tabAssignments } });
    expect(markup.includes('<select name="nextN" class="dropdown">')).toBe(shown);
  });

  it('never shows the list display options under the layout manager', () => {
    expect(render(PAGE)).not.toContain('name="nextN"');
  });

  it('shows Custom image dimensions only for the custom size', () => {
    const markup = render(withBean(REGIONS_PAGE, { imageSize: 'Custom', imageWidth: '300', imageHeight: 'AUTO' }));
    expect(markup).toContain('<option value="custom" selected>Custom</option>');
    expect(markup).toContain('<div id="feedCustomImageOptions" class="mura-control-group">');
    expect(markup).toContain('value="300" />');
  });

  it('encodes custom size names and trims field names as legacy does', () => {
    const markup = render(
      withBean(withSite(REGIONS_PAGE, { customImageSizes: [{ name: 'Big & Wide' }] }), {
        displayList: ' Title , Date',
        availableDisplayList: 'Summary,,Body ',
      }),
    );
    expect(markup).toContain('<option value="big & wide">Big &amp; Wide</option>');
    expect(markup).toContain('<li class="ui-state-highlight">Title</li>\n                \n                  <li class="ui-state-highlight">Date</li>');
    expect(markup).toContain('<li class="ui-state-default">Summary</li>\n                \n                  <li class="ui-state-default">Body</li>');
    expect(markup).toContain('value=" Title , Date" name="displayList"/>');
  });

  it('joins each region value with ^ into its objectList', () => {
    const markup = render(REGIONS_PAGE);
    const first = 'component~Promo &lt;Box&gt; &amp; &quot;Co&quot;~AAAA0000-1111-2222-3333444455556666~&#x7b;&quot;a&quot;&#x3a;&quot;&lt;b&gt;&amp;&#x5c;u00e9&quot;&#x7d;';
    expect(markup).toContain(`<input type="hidden" name="objectList1" id="objectList1" value="${first}^system~Site Map~sitemap~">`);
    expect(markup).toContain('\n                                Promo <Box> & "Co"\n\n                                </option>');
    expect(markup).toContain('<input type="hidden" name="objectList4" id="objectList4" value="">');
  });

  it('prints a region name followed by whitespace without the separating space', () => {
    const markup = render(withSite(REGIONS_PAGE, { columnNames: 'Left\t^Main' }));
    expect(markup).toContain('<dt>Left\tContent Objects\n');
    expect(markup).toContain('<dt>Main Content Objects\n');
    expect(markup).toContain('\n                            <dt>\n                            Region 3 Content Objects\n');
  });

  it.each<[string, Readonly<Record<string, unknown>>, string, boolean]>([
    ['the mailing list class with the email broadcaster', { emailBroadcaster: true }, 'value="mailingList"', true],
    ['no form class without data collection', { dataCollection: 'false' }, 'value="form"', false],
    ['no feed classes without the feed manager', { hasFeedManager: 0 }, 'value="remoteFeed"', false],
  ])('offers %s', (_case, values, option, shown) => {
    expect(render(withSite(REGIONS_PAGE, values)).includes(option)).toBe(shown);
  });

  it('prints the mailing list option where legacy places it', () => {
    expect(render(withSite(REGIONS_PAGE, { emailBroadcaster: 1 }))).toContain(
      '<option value="navigation">Navigation</option>\n                              ' +
        '\n                              <option value="mailingList">Mailing Lists</option>\n                              ' +
        '                              \n                              \n                              <option value="folder">',
    );
  });

  it.each<[string, string, string]>([
    ['a link for an author', 'Author', `\n                  <a href='${HOME_INHERITANCE.editURL}'>A &amp; B</a>\n                \n                </div>`],
    ['the plain title with legacy whitespace otherwise', 'read', ':\n                A &amp; B \n                </div>'],
  ])('shows the inherited node as %s', (_case, perm, expected) => {
    const c = withRc(PAGE, { inheritedObjects: { ...HOME_INHERITANCE, menuTitle: 'A & B', perm } });
    expect(render(c)).toContain(expected);
  });

  it('omits the current inheritance when nothing is inherited', () => {
    const markup = render(withRc(PAGE, { inheritedObjects: undefined }));
    expect(markup).not.toContain('help-block">This content node');
    expect(markup).toContain('</label>\n             \n            <label for="ioi" class="radio inline">');
  });

  it.each<[string, string, string]>([
    ['empty', '', 'value="Inherit" checked>'],
    ['inherit in any case', 'INHERIT', 'value="Inherit" checked>'],
    ['cascade', 'cascade', 'value="Cascade" checked>'],
    ['reject', 'Reject', 'value="Reject" checked>'],
  ])('checks the cascade radio of an %s rule', (_case, rule, expected) => {
    const markup = render(withBean(PAGE, { inheritObjects: rule }));
    expect(markup).toContain(expected);
    expect(markup.match(/ checked>/g)).toHaveLength(1);
  });

  it('encodes the preview target params for JavaScript', () => {
    expect(render(withBean(PAGE, { targetParams: "width='1'" }))).toContain(
      "?previewid=3FC56571-01B7-3E2B-6DD650DBCA570AFB','width\\x3D\\x271\\x27');\">preview this content node</a>",
    );
  });

  it.each<[string, Readonly<Record<string, string>>, Readonly<Record<string, unknown>>, string]>([
    ['the stored node parent when the request names none', { parentid: '' }, {}, `'${ROOT}','${PAGE_HIST}',0);`],
    ['an empty parent for a new node', { parentid: '' }, { isNew: 1 }, `'','${PAGE_HIST}',0);`],
  ])('passes %s to the class selector and the configurator', (_case, request, values, expected) => {
    const c = withBean({ ...REGIONS_PAGE, request: { ...PAGE_REQUEST, ...request } }, values);
    const markup = render(c);
    expect(markup).toContain(expected);
    expect(markup).toContain(`var parentid='${values.isNew === 1 ? '' : ROOT}';`);
  });

  it('registers display object configurators and the open feeds setting', () => {
    const markup = render(
      withSite(withRc(REGIONS_PAGE, { allowOpenFeeds: 'true' }), {
        displayObjectLookup: [{ objectid: 'promo', configuratorInit: 'initPromo', configuratorJS: 'promo.js' }],
      }),
    );
    expect(markup).toContain('siteManager.allowopenfeeds=true;');
    expect(markup).toContain("pluginConfigurators.push({'objectid':'promo','init':'initPromo'});");
    expect(markup.endsWith('\n<script type="text/javascript" src="/sites/default/promo.js"></script>\n')).toBe(true);
    expect(markup).not.toContain('siteManager.layoutmanager=true;');
  });

  it.each<[string, Case]>([
    ['the templates', withRc(PAGE, { rsTemplates: undefined })],
    ['the layout manager flag', withRc(PAGE, { useLayoutManager: undefined })],
    ['the region count', withSite(REGIONS_PAGE, { columnCount: undefined })],
    ['the site flags', withSite(REGIONS_PAGE, { dataCollection: null })],
    ['the custom image sizes', withSite(REGIONS_PAGE, { customImageSizes: undefined })],
    ['the display objects', withSite(PAGE, { displayObjectLookup: 'none' })],
    ['a region as rows', withRc(REGIONS_PAGE, { rsContentObjects2: 'none' })],
    ['the inherited node as a struct', withRc(PAGE, { inheritedObjects: 'x' })],
    ['template names as simple values', withRc(PAGE, { templateArray: [{}] })],
    ['the request content id', { ...PAGE, request: { contenthistid: PAGE_HIST, parentid: ROOT, type: 'Page' } }],
  ])('fails when the model lacks %s', (_case, c) => {
    expect(() => render(c)).toThrow(TypeError);
  });
});
