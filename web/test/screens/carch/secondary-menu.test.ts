// The carch secondary menu over a fake-gateway ScreenContext: link sets, url CSRF contexts, roles and the shell hook.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { isSafeHtml, toString } from '@/lib/html';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
} from '@/screens/carch/model';
import {
  bindCarchSecondaryMenu,
  carchSecondaryMenu,
  carchSecondaryMenuCsrfContexts,
  renderCarchSecondaryMenu,
  type CarchMenuContent,
  type CarchSecondaryMenuInput,
} from '@/screens/carch/secondary-menu';
import { shellHooks } from '@/screens/registry';
import type { ShellHooks } from '@/shell/types';
import { CONTENT_HIST_IDS, CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply, type RecordedRequest } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type AdminRequest = ReturnType<typeof adminS2Request>;
type MenuContext = ReturnType<typeof makeScreenContext>;
type RcValues = Readonly<Record<string, string>>;

const SITE = 'default';
const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const TOKEN_PREFIX = 'T-';
const ABOUT = CONTENT_IDS.aboutUs;
const ABOUT_HIST = CONTENT_HIST_IDS.aboutUsDraft;
const BANNER = CONTENT_IDS.homeBanner;
const BANNER_HIST = CONTENT_HIST_IDS.homeBanner;
const FORM = CONTENT_IDS.contactForm;
const FORM_HIST = CONTENT_HIST_IDS.contactForm;
const VARIATION = '5C000000-0001-4000-80000000000000F1';
const VARIATION_HIST = '5C000000-0002-4000-80000000000000F1';
const MENU_TAGS: ReadonlySet<string> = new Set(['a', 'i', 'span', 'div', 'ul', 'li']);

/** identity `issueCsrfTokens` answering `T-<context>`, so each href names the context it was rendered for. */
function issuePerContext(request: RecordedRequest): FakeReply {
  const { contexts } = request.json as { readonly contexts: readonly string[] };
  const tokens = contexts.map((context) => ({
    context,
    [CSRF_FIELD_TOKEN]: `${TOKEN_PREFIX}${context}`,
    [CSRF_FIELD_EXPIRES]: FIXED_CSRF.expires,
  }));
  return { status: 200, body: { tokens } };
}

/** The `format='url'` tokens identity issues for `context`. */
const urlTokens = (context: string): string =>
  `&${CSRF_FIELD_TOKEN}=${TOKEN_PREFIX}${context}&${CSRF_FIELD_EXPIRES}=${FIXED_CSRF.expires}`;

/** `rc` of About Us's draft in Site Manager after the carch controller ran; `siteid` comes from the session. */
const ABOUT_RC: RcValues = {
  contentid: ABOUT,
  contenthistid: ABOUT_HIST,
  type: 'Page',
  parentid: ROOT_CONTENT_ID,
  topid: ROOT_CONTENT_ID,
  moduleid: CONTENT_MODULE_ID,
  startrow: '1',
  return: '',
  action: '',
};

type ModuleRc = {
  readonly contentid: string;
  readonly contenthistid: string;
  readonly type: string;
  readonly parentid: string;
  readonly topid: string;
  readonly moduleid: string;
};

/** `rc` of a saved node of `type` at the top of module `moduleId`. */
const moduleRc = (moduleId: string, contentId: string, histId: string, type: string): ModuleRc => ({
  contentid: contentId,
  contenthistid: histId,
  type,
  parentid: moduleId,
  topid: moduleId,
  moduleid: moduleId,
});

const BANNER_RC = moduleRc(COMPONENT_MODULE_ID, BANNER, BANNER_HIST, 'Component');
const FORM_RC = moduleRc(FORM_MODULE_ID, FORM, FORM_HIST, 'Form');
const VARIATION_RC = moduleRc(VARIATION_MODULE_ID, VARIATION, VARIATION_HIST, 'Variation');

/** A carch request on `item`, `rc` laid over {@link ABOUT_RC}. */
const carch = (item: string, rc: RcValues = {}) => ({ circuit: 'cArch', item, rc: { ...ABOUT_RC, ...rc } });

/** A saved, published content bean, `partial` laid over it. */
const bean = (partial: Partial<CarchMenuContent>): CarchMenuContent => ({
  isNew: false,
  type: 'Page',
  subType: 'Default',
  active: 1,
  filename: '',
  contentHistId: '',
  parentId: '',
  menuTitle: '',
  remoteUrl: '',
  fileId: '',
  stats: {},
  ...partial,
});

const ABOUT_US = bean({
  active: 0,
  filename: 'about-us',
  contentHistId: ABOUT_HIST,
  parentId: ROOT_CONTENT_ID,
  menuTitle: 'About Us',
  previewUrl: `http://localhost/about-us/?previewid=${ABOUT_HIST}`,
  editUrl: `./?muraAction=cArch.edit&contenthistid=${ABOUT_HIST}&contentid=${ABOUT}&type=Page&siteid=${SITE}`,
});
const BANNER_BEAN = bean({
  type: 'Component',
  active: 0,
  contentHistId: BANNER_HIST,
  parentId: COMPONENT_MODULE_ID,
  menuTitle: 'Home Banner',
});
const FORM_BEAN = bean({
  type: 'Form',
  active: 0,
  contentHistId: FORM_HIST,
  parentId: FORM_MODULE_ID,
  menuTitle: 'Contact Form',
});
const VARIATION_BEAN = bean({
  type: 'Variation',
  contentHistId: VARIATION_HIST,
  parentId: VARIATION_MODULE_ID,
  menuTitle: 'Spring Promo',
  remoteUrl: 'http://localhost/promo/',
});

/** An unlocked node the user edits and may delete, outside the layout manager. */
const EDITABLE: CarchSecondaryMenuInput = {
  perm: 'editor',
  deletable: true,
  hasLockableNodes: false,
  purgeDrafts: false,
  useLayoutManager: false,
  allowSimpleHTMLForms: true,
};

interface RenderedMenu {
  readonly ctx: MenuContext;
  readonly html: string;
  readonly links: DomLink[];
}

/** Prefetches the menu's url-token contexts as the carch views do, then renders `input` for `req`. */
async function renderMenu(req: AdminRequest, input: CarchSecondaryMenuInput): Promise<RenderedMenu> {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({ [CSRF_ROUTE]: issuePerContext }) });
  await ctx.csrf.prefetch(carchSecondaryMenuCsrfContexts(input.rc ?? req.rc));
  const menu = renderCarchSecondaryMenu(ctx, input);
  expect(isSafeHtml(menu)).toBe(true);
  const html = toString(menu);
  return { ctx, html, links: fragmentModel(html).links };
}

/** Bodies of the identity CSRF calls `ctx` made. */
const csrfCalls = (ctx: MenuContext): unknown[] =>
  ctx.gateway.calls
    .filter((call) => call.service === 'identity' && call.path === '/v1/csrf/tokens')
    .map((call) => call.json);

const queryOf = (href: string): URLSearchParams => new URLSearchParams(href.slice(href.indexOf('?') + 1));

/** `[text, CSRF context]` of each link carrying url tokens, in document order. */
function tokenisedLinks(links: readonly DomLink[]): Array<[string, string]> {
  return links.flatMap(({ href, text }): Array<[string, string]> => {
    const query = queryOf(href);
    const token = query.get(CSRF_FIELD_TOKEN);
    if (token === null) return [];
    expect(query.get(CSRF_FIELD_EXPIRES)).toBe(FIXED_CSRF.expires);
    return [[text, token.slice(TOKEN_PREFIX.length)]];
  });
}

function hrefOf(links: readonly DomLink[], text: string): string {
  const found = links.find((candidate) => candidate.text === text);
  if (found === undefined) throw new Error(`No "${text}" link`);
  return found.href;
}

/** A legacy href and text as the DOM model normalises them. */
const link = (href: string, text: string): DomLink => ({ href: normaliseAdminUrl(href), text });

const ACTIONS = link('#', 'Actions');

/** The node query most items carry after the content id. */
const nodeQuery = (type: string, parentId: string, topId: string, moduleId: string): string =>
  `type=${type}&parentid=${parentId}&topid=${topId}&siteid=${SITE}&startrow=1&moduleid=${moduleId}`;

const ABOUT_QUERY = nodeQuery('Page', ROOT_CONTENT_ID, ROOT_CONTENT_ID, CONTENT_MODULE_ID);

/** About Us's Permissions item on `site`. */
const aboutPermissions = (site: string): DomLink =>
  link(
    `./?muraAction=cPerm.main&contentid=${ABOUT}&type=Page&parentid=${ROOT_CONTENT_ID}&topid=${ROOT_CONTENT_ID}` +
      `&siteid=${site}&moduleid=${CONTENT_MODULE_ID}&startrow=1`,
    'Permissions',
  );

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

let restoreEnv: () => void = () => undefined;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('Site Manager (module 000)', () => {
  it('edit links the node actions, each delete with its own url tokens', async () => {
    const { ctx, links } = await renderMenu(adminS2Request(carch('edit')), { ...EDITABLE, content: ABOUT_US });
    expect(links).toEqual([
      ACTIONS,
      link(`http://localhost/about-us/?previewid=${ABOUT_HIST}`, 'View This Version'),
      link(`./?muraAction=cArch.hist&contentid=${ABOUT}&${ABOUT_QUERY}&compactDisplay=false`, 'Version History'),
      link(
        `./?muraAction=cArch.audit&contentid=${ABOUT}&contenthistid=${ABOUT_HIST}&${ABOUT_QUERY}&compactDisplay=false`,
        'Audit Trail',
      ),
      link(`?muraAction=cArch.export&siteid=${SITE}&contentid=${ABOUT}`, 'Export'),
      link(`?muraAction=cArch.import&contentid=${ABOUT}&moduleid=${CONTENT_MODULE_ID}&siteid=${SITE}`, 'Import'),
      link(
        `./?muraAction=cArch.update&contenthistid=${ABOUT_HIST}&action=delete&contentid=${ABOUT}&${ABOUT_QUERY}` +
          `&return=${urlTokens(`${ABOUT_HIST}delete`)}`,
        'Delete Version',
      ),
      aboutPermissions(SITE),
      link(
        `./?muraAction=cArch.update&action=deleteall&contentid=${ABOUT}&${ABOUT_QUERY}${urlTokens(`${ABOUT}deleteall`)}`,
        'Delete Content',
      ),
    ]);
    expect(tokenisedLinks(links)).toEqual([
      ['Delete Version', `${ABOUT_HIST}delete`],
      ['Delete Content', `${ABOUT}deleteall`],
    ]);
    expect(csrfCalls(ctx)).toEqual([
      { contexts: [`${ABOUT}deleteall`, `${ABOUT_HIST}delete`, `${ABOUT}deletehistall`] },
    ]);
  });

  it('edit in compact display opens with the back button and drops Delete Version', async () => {
    const req = adminS2Request(carch('edit', { compactDisplay: 'true' }));
    const { html, links } = await renderMenu(req, { ...EDITABLE, content: ABOUT_US });
    const back = cheerio.load(html, null, false)('div.nav-module-specific > a.btn[onclick="history.go(-1);"]');
    expect(collapse(back.text())).toBe('Back');
    expect(links.map(({ text }) => text)).toEqual([
      'Actions',
      'View This Version',
      'Version History',
      'Audit Trail',
      'Export',
      'Import',
      'Permissions',
      'Delete Content',
    ]);
    expect(queryOf(hrefOf(links, 'Version History')).get('compactDisplay')).toBe('true');
  });

  const FORGED_RC: RcValues = { s2: '1', isS2: 'true', isSiteAdmin: 'true', memberships: 'S2' };

  it.each([
    { who: 'the S2 admin', site: SITE, shown: true, make: () => adminS2Request(carch('edit', FORGED_RC)) },
    {
      who: 'the tenant-a site admin',
      site: 'tenant-a',
      shown: true,
      make: () => siteAdminRequest('tenant-a', carch('edit', FORGED_RC)),
    },
    { who: 'qa_editor', site: SITE, shown: false, make: () => editorRequest(carch('edit', FORGED_RC)) },
  ])('edit links Permissions for $who: $shown', async ({ site, shown, make }) => {
    const req = make();
    expect(req.rc['siteid']).toBe(site);
    const { links } = await renderMenu(req, { ...EDITABLE, content: ABOUT_US });
    expect(links.filter(({ text }) => text === 'Permissions')).toEqual(shown ? [aboutPermissions(site)] : []);
  });

  it.each(['false', 'true'])('hist with compactDisplay=%s clears the history with its url tokens', async (compactDisplay) => {
    const req = adminS2Request(carch('hist', { compactDisplay }));
    const { html, links } = await renderMenu(req, { ...EDITABLE, content: ABOUT_US });
    const full = compactDisplay === 'false';
    const deleteAll = link(
      `./?muraAction=cArch.update&action=deleteall&contentid=${ABOUT}&${ABOUT_QUERY}&compactDisplay=false` +
        urlTokens(`${ABOUT}deleteall`),
      'Delete Content',
    );
    expect(links).toEqual([
      link(`./?muraAction=cArch.list&siteid=${SITE}&moduleid=${CONTENT_MODULE_ID}`, 'Return to Content Manager'),
      ACTIONS,
      link(
        `./?muraAction=cArch.update&action=deletehistall&contentid=${ABOUT}&${ABOUT_QUERY}` +
          `&compactDisplay=${compactDisplay}${urlTokens(`${ABOUT}deletehistall`)}`,
        'Clear Version History',
      ),
      ...(full ? [deleteAll] : []),
      aboutPermissions(SITE),
    ]);
    expect(queryOf(hrefOf(links, 'Clear Version History')).get('compactDisplay')).toBe(compactDisplay);
    expect(tokenisedLinks(links)).toEqual([
      ['Clear Version History', `${ABOUT}deletehistall`],
      ...(full ? [['Delete Content', `${ABOUT}deleteall`]] : []),
    ]);
    expect(cheerio.load(html, null, false)('a[onclick="history.go(-1);"]').length).toBe(full ? 0 : 1);
  });
});

describe('Components, Forms and Variations modules', () => {
  /** The module's add item of `type`. */
  const addLink = (moduleId: string, type: string, text: string, formType = ''): DomLink =>
    link(
      `./?muraAction=cArch.edit&type=${type}&contentid=&topid=${moduleId}&parentid=${moduleId}&siteid=${SITE}` +
        `&moduleid=${moduleId}${formType === '' ? '' : `&formType=${formType}`}`,
      text,
    );
  const modulePermissions = (moduleId: string): DomLink =>
    link(
      `./?muraAction=cPerm.main&contentid=${moduleId}&topid=${moduleId}&siteid=${SITE}&moduleid=${moduleId}&startrow=1`,
      'Permissions',
    );
  const backToModule = (moduleId: string, text: string): DomLink =>
    link(`./?muraAction=cArch.list&siteid=${SITE}&topid=${moduleId}&parentid=${moduleId}&moduleid=${moduleId}`, text);

  it.each([
    {
      name: 'Components',
      moduleId: COMPONENT_MODULE_ID,
      links: [addLink(COMPONENT_MODULE_ID, 'Component', 'Component'), modulePermissions(COMPONENT_MODULE_ID)],
    },
    {
      name: 'Forms',
      moduleId: FORM_MODULE_ID,
      links: [
        addLink(FORM_MODULE_ID, 'Form', 'Add Form with Form Builder', 'builder'),
        addLink(FORM_MODULE_ID, 'Form', 'Add Form with Editor', 'editor'),
        modulePermissions(FORM_MODULE_ID),
      ],
    },
  ])('$name list links its add items and Permissions', async ({ moduleId, links: expected }) => {
    const rc = { contentid: '', type: '', parentid: moduleId, topid: moduleId, moduleid: moduleId };
    const { links } = await renderMenu(adminS2Request(carch('list', rc)), EDITABLE);
    expect(links).toEqual(expected);
  });

  it.each([
    {
      name: 'Components',
      rc: BANNER_RC,
      content: BANNER_BEAN,
      back: 'Back to Components',
      leading: [],
      exportImport: [
        link(`./?muraAction=cArch.exportcomponent&contentid=${BANNER}`, 'Export'),
        link('./?muraAction=cArch.importcomponent', 'Import'),
      ],
    },
    {
      name: 'Forms',
      rc: FORM_RC,
      content: FORM_BEAN,
      back: 'Back to Forms',
      leading: [
        link(
          `./?muraAction=cArch.datamanager&contentid=${FORM}&siteid=${SITE}&topid=${FORM_MODULE_ID}` +
            `&moduleid=${FORM_MODULE_ID}&type=Form&parentid=${FORM_MODULE_ID}`,
          'Form Data',
        ),
      ],
      exportImport: [
        link(`./?muraAction=cForm.export&contentid=${FORM}`, 'Export'),
        link('./?muraAction=cForm.importform', 'Import'),
      ],
    },
  ])('$name edit links its module set', async ({ rc, content, back, leading, exportImport }) => {
    const { contentid, contenthistid, type, moduleid } = rc;
    const { links } = await renderMenu(adminS2Request(carch('edit', rc)), { ...EDITABLE, content });
    const query = nodeQuery(type, moduleid, moduleid, moduleid);
    expect(links).toEqual([
      backToModule(moduleid, back),
      ...leading,
      ACTIONS,
      link(`./?muraAction=cArch.hist&contentid=${contentid}&${query}&compactDisplay=false`, 'Version History'),
      link(
        `./?muraAction=cArch.audit&contentid=${contentid}&contenthistid=${contenthistid}&${query}&compactDisplay=false`,
        'Audit Trail',
      ),
      link(
        `./?muraAction=cArch.update&contenthistid=${contenthistid}&action=delete&contentid=${contentid}&${query}` +
          `&return=${urlTokens(`${contenthistid}delete`)}`,
        'Delete Version',
      ),
      link(
        `./?muraAction=cPerm.main&contentid=${contentid}&type=${type}&parentid=${moduleid}&topid=${moduleid}` +
          `&siteid=${SITE}&moduleid=${moduleid}&startrow=1`,
        'Permissions',
      ),
      link(
        `./?muraAction=cArch.update&action=deleteall&contentid=${contentid}&${query}${urlTokens(`${contentid}deleteall`)}`,
        'Delete Content',
      ),
      ...exportImport,
    ]);
    expect(tokenisedLinks(links)).toEqual([
      ['Delete Version', `${contenthistid}delete`],
      ['Delete Content', `${contentid}deleteall`],
    ]);
  });

  it('Components hist clears the history and deletes the node with their own url tokens', async () => {
    const components = COMPONENT_MODULE_ID;
    const req = adminS2Request(carch('hist', BANNER_RC));
    const { links } = await renderMenu(req, { ...EDITABLE, content: BANNER_BEAN });
    const query = nodeQuery('Component', components, components, components);
    expect(links).toEqual([
      backToModule(components, 'Back to Components'),
      ACTIONS,
      link(
        `./?muraAction=cArch.update&action=deletehistall&contentid=${BANNER}&${query}&compactDisplay=false` +
          urlTokens(`${BANNER}deletehistall`),
        'Clear Version History',
      ),
      link(
        `./?muraAction=cArch.update&action=deleteall&contentid=${BANNER}&${query}${urlTokens(`${BANNER}deleteall`)}`,
        'Delete Content',
      ),
      link(
        `./?muraAction=cPerm.main&contentid=${BANNER}&type=Component&parentid=${components}&topid=${components}` +
          `&siteid=${SITE}&moduleid=${components}&startrow=1`,
        'Permissions',
      ),
    ]);
    expect(tokenisedLinks(links)).toEqual([
      ['Clear Version History', `${BANNER}deletehistall`],
      ['Delete Content', `${BANNER}deleteall`],
    ]);
  });

  it.each(['', 'display'])('Forms data manager with action=%s deletes the form with its url tokens', async (action) => {
    const forms = FORM_MODULE_ID;
    const req = adminS2Request(carch('datamanager', { ...FORM_RC, action }));
    const { ctx, html, links } = await renderMenu(req, { ...EDITABLE, content: FORM_BEAN });
    const deleteHref =
      `./?muraAction=cArch.update&contentid=${FORM}&type=Form&action=deleteall&topid=00000000000000000000000000000000004` +
      `&siteid=${SITE}&moduleid=${forms}&parentid=${forms}${urlTokens(`${FORM}deleteall`)}`;
    const formData = link(
      `./?muraAction=cArch.datamanager&contentid=${FORM}&type=Form&topid=${forms}&siteid=${SITE}&moduleid=${forms}` +
        `&parentid=${forms}`,
      'Form Data',
    );
    expect(links).toEqual([
      backToModule(forms, 'Back to Forms'),
      link(
        `./?muraAction=cArch.hist&contentid=${FORM}&type=Form&parentid=${forms}&topid=${forms}&siteid=${SITE}` +
          `&startrow=1&moduleid=${forms}`,
        'Version History',
      ),
      ...(action === '' ? [] : [formData]),
      link(
        `./?muraAction=cArch.datamanager&contentid=${FORM}&type=Form&action=display&topid=${forms}&siteid=${SITE}` +
          `&moduleid=${forms}&parentid=${forms}`,
        'Edit Display',
      ),
      link(deleteHref, 'Delete Form'),
      link(
        `./?muraAction=cPerm.main&contentid=${FORM}&type=Form&parentid=${forms}&topid=${forms}&siteid=${SITE}` +
          `&moduleid=${forms}&startrow=1`,
        'Permissions',
      ),
    ]);
    const remove = cheerio.load(html, null, false)('a[title="Delete"]');
    expect(remove.attr('href')).toBe(deleteHref);
    expect(remove.attr('onclick')).toBe("return confirmDialog('Delete\\x20Form\\x3F',this.href)");
    expect(tokenisedLinks(links)).toEqual([['Delete Form', `${FORM}deleteall`]]);
    expect(csrfCalls(ctx)).toEqual([
      { contexts: [`${FORM}deleteall`, `${FORM_HIST}delete`, `${FORM}deletehistall`] },
    ]);
  });

  it('Variations edit previews the version inside its wrapped actions', async () => {
    const variations = VARIATION_MODULE_ID;
    const { html, links } = await renderMenu(adminS2Request(carch('edit', VARIATION_RC)), {
      ...EDITABLE,
      deletable: false,
      content: VARIATION_BEAN,
    });
    const query = nodeQuery('Variation', variations, variations, variations);
    expect(links).toEqual([
      backToModule(variations, 'Back to Variations'),
      ACTIONS,
      link(`http%3A%2F%2Flocalhost%2Fpromo%2F%3Fpreviewid%3D${VARIATION_HIST}`, 'View This Version'),
      link(`./?muraAction=cArch.hist&contentid=${VARIATION}&${query}&compactDisplay=false`, 'Version History'),
      link(
        `./?muraAction=cArch.audit&contentid=${VARIATION}&contenthistid=${VARIATION_HIST}&${query}&compactDisplay=false`,
        'Audit Trail',
      ),
      link(
        `./?muraAction=cPerm.main&contentid=${VARIATION}&type=Variation&parentid=${variations}&topid=${variations}` +
          `&siteid=${SITE}&moduleid=${variations}&startrow=1`,
        'Permissions',
      ),
    ]);
    const items = cheerio.load(html, null, false)('div.nav-module-specific > div.btn-group > ul.dropdown-menu > li');
    expect(items.length).toBe(4);
  });
});

describe('every branch', () => {
  it.each<{ name: string; make: () => AdminRequest; input: CarchSecondaryMenuInput }>([
    { name: 'Site Manager edit', make: () => adminS2Request(carch('edit')), input: { ...EDITABLE, content: ABOUT_US } },
    { name: 'Site Manager hist', make: () => adminS2Request(carch('hist')), input: { ...EDITABLE, content: ABOUT_US } },
    { name: 'Site Manager audit', make: () => editorRequest(carch('audit')), input: { ...EDITABLE, content: ABOUT_US } },
    {
      name: 'Site Manager image details',
      make: () => adminS2Request(carch('imagedetails')),
      input: { ...EDITABLE, content: ABOUT_US },
    },
    {
      name: 'Site Manager image details in compact display',
      make: () => adminS2Request(carch('imagedetails', { compactDisplay: 'true' })),
      input: { ...EDITABLE, useLayoutManager: true, content: { ...ABOUT_US, url: 'http://localhost/about-us/' } },
    },
    {
      name: 'Site Manager multi-file upload without content',
      make: () => adminS2Request(carch('multiFileUpload')),
      input: {},
    },
    { name: 'Site Manager draft', make: () => adminS2Request(carch('draft')), input: {} },
    {
      name: 'a request without an action',
      make: () => ({ ...adminS2Request(carch('edit')), action: '' }),
      input: { ...EDITABLE, content: ABOUT_US },
    },
    { name: 'Components list', make: () => adminS2Request(carch('list', { ...BANNER_RC, contentid: '' })), input: EDITABLE },
    {
      name: 'Components edit',
      make: () => adminS2Request(carch('edit', BANNER_RC)),
      input: { ...EDITABLE, content: BANNER_BEAN },
    },
    {
      name: 'Forms data manager',
      make: () => adminS2Request(carch('datamanager', FORM_RC)),
      input: { ...EDITABLE, content: FORM_BEAN },
    },
    {
      name: 'Forms audit',
      make: () => adminS2Request(carch('audit', FORM_RC)),
      input: { ...EDITABLE, content: FORM_BEAN },
    },
    {
      name: 'Variations hist',
      make: () => adminS2Request(carch('hist', VARIATION_RC)),
      input: { ...EDITABLE, content: VARIATION_BEAN },
    },
    { name: 'Variations draft', make: () => adminS2Request(carch('draft', VARIATION_RC)), input: {} },
  ])('$name renders inside the module wrapper and adds nothing to the legacy links', async ({ make, input }) => {
    const { html, links } = await renderMenu(make(), input);
    expect(html.startsWith('\n<div class="nav-module-specific btn-group">')).toBe(true);
    expect(html.endsWith('</div>\n')).toBe(true);
    const $ = cheerio.load(html, null, false);
    const wrapper = $.root().children();
    expect(wrapper.length).toBe(1);
    expect(wrapper.is('div.nav-module-specific.btn-group')).toBe(true);
    const tags = wrapper
      .find('*')
      .toArray()
      .map((el) => el.tagName);
    expect(tags.filter((tag) => !MENU_TAGS.has(tag))).toEqual([]);
    // Plugin `on…SecondaryNavRender` output would add text outside the links.
    expect(collapse(wrapper.text())).toBe(links.map(({ text }) => text).join(' '));
  });
});

describe('shell hook', () => {
  it('is the registry carch secondary menu', () => {
    const hook: ShellHooks['secondaryMenus']['carch'] = shellHooks.secondaryMenus.carch;
    expect(hook).toBe(carchSecondaryMenu);
  });

  it('renders the input a view bound for its request', async () => {
    const req = adminS2Request(carch('edit'));
    const input: CarchSecondaryMenuInput = { ...EDITABLE, content: ABOUT_US };
    const { ctx, html } = await renderMenu(req, input);
    bindCarchSecondaryMenu(ctx, input);
    expect(shellHooks.secondaryMenus.carch?.(req).value).toBe(html);
  });

  it('renders a request no view bound as the menu without input', () => {
    const req = adminS2Request(carch('multiFileUpload'));
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient() });
    expect(shellHooks.secondaryMenus.carch?.(req).value).toBe(renderCarchSecondaryMenu(ctx, {}).value);
  });
});

