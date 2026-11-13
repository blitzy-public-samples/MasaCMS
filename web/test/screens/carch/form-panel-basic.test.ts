// carch form/dsp_panel_basic.cfm: the content editor's Basic panel and its saved body editor, against legacy captures.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormState, EditPageData } from '@/screens/carch/form/custom-tags';
import { renderPanelBasic } from '@/screens/carch/form/panel-basic';
import { COMPONENT_MODULE_ID, CONTENT_MODULE_ID, FORM_MODULE_ID, ROOT_CONTENT_ID } from '@/screens/carch/model';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';

/** One capture: the new bean's ids the type selector prints, the panel and edit.cfm's `#mura-content-body-render`. */
interface Capture {
  readonly contentId: string;
  readonly contentHistId: string;
  readonly html: string;
  readonly body: string;
}

// `cArch.edit` on the default site of the legacy ACF 2023 server as admin (S2): Home as installed, opened plainly and
// with preview=1, then new Page, Folder, Gallery, Link and File nodes under Home and a new Component. `html` runs from
// the include's leading newline through the blank line before `</cfoutput>`; `body` is the `bodyContent` edit.cfm
// prints inside `#mura-content-body-render` (and `#mura-content-body-inner` for Link and File).
const CAPTURES = JSON.parse(
  readFileSync(new URL('../../fixtures/strategies-content/edit-panel-basic.json', import.meta.url), 'utf8'),
) as Readonly<Record<string, Capture>>;

const capture = (name: string): Capture => {
  const found = CAPTURES[name];
  if (found === undefined) throw new Error(`no capture ${name}`);
  return found;
};

const HOME_HIST_ID = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const NODE_ID = 'C1000000-0000-0000-0000000000000001';
const PARENT_ID = 'C1000000-0000-0000-0000000000000002';
const EMAIL_MODULE_ID = '00000000000000000000000000000000005';

type Bean = Readonly<Record<string, unknown>>;

const NO_LOCK = { lockID: '', lockType: '' };

/** Home as installed. */
const HOME: Bean = {
  contentID: ROOT_CONTENT_ID,
  contentHistID: HOME_HIST_ID,
  parentID: '00000000000000000000000000000000END',
  siteID: 'default',
  type: 'Page',
  subType: 'Default',
  isNew: 0,
  isLocked: 0,
  title: 'Home',
  menuTitle: 'Home',
  urlTitle: 'Home',
  htmlTitle: 'Home',
  moduleAssign: '',
  body: '',
  summary: '',
  responseChart: 0,
  responseMessage: '',
  responseSendTo: '',
  fileID: '',
  fileExt: '',
  majorVersion: 0,
  minorVersion: 0,
  stats: NO_LOCK,
  previewURL: `http://localhost:8080/?previewid=${HOME_HIST_ID}`,
};

/** A new node of `type` with the ids `c` printed. */
const newBean = (type: string, c?: Capture): Bean => ({
  ...HOME,
  contentID: c?.contentId ?? '',
  contentHistID: c?.contentHistId ?? '',
  parentID: '',
  type,
  isNew: 1,
  title: '',
  menuTitle: '',
  urlTitle: '',
  htmlTitle: '',
  previewURL: undefined,
});

/** A stored Page below a stored parent. */
const NODE: Bean = { ...HOME, contentID: NODE_ID, parentID: PARENT_ID, title: 'About', previewURL: undefined };

/** Three crumbs, the node first, as `getCrumbList` orders them. */
const CRUMBS: readonly Bean[] = [{ menutitle: 'About' }, { menutitle: 'Parent <b>&' }, { menutitle: 'Home' }];

const STATE: EditFormState = {
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: true,
  ptype: 'Page',
  compactDisplay: '',
  preview: '0',
};

/** `rc.site` of the installed `default` site. */
const SITE: Bean = { locking: 'none', dataCollection: 1, emailBroadcaster: 0 };

interface Case {
  readonly bean?: Bean;
  readonly type?: string;
  readonly contentid?: string;
  readonly parentid?: string;
  readonly moduleid?: string;
  readonly title?: string;
  readonly site?: Bean;
  readonly crumbData?: readonly Bean[];
  readonly model?: Bean;
  readonly state?: Partial<EditFormState>;
}

/** Renders the panel for one request; `rc.parentid` defaults to the new-node parent Home, as legacy requests it. */
async function render(c: Case = {}): Promise<{ html: string; body: string | undefined }> {
  const bean = c.bean ?? HOME;
  const req = adminS2Request({
    circuit: 'cArch',
    item: 'edit',
    site: { record: { theme: 'default' } },
    rc: {
      type: c.type ?? 'Page',
      contentid: c.contentid ?? (bean.isNew === 1 ? '' : String(bean.contentID)),
      parentid: c.parentid ?? (bean.isNew === 1 ? ROOT_CONTENT_ID : ''),
      moduleid: c.moduleid ?? CONTENT_MODULE_ID,
      ...(c.title === undefined ? {} : { title: c.title }),
    },
  });
  const data: EditPageData = {
    rc: { contentBean: bean, site: c.site ?? SITE, crumbData: c.crumbData ?? [{ menutitle: 'Home' }], ...c.model },
  };
  const state = { ...STATE, ...c.state };
  // The panel and the new-file selector read only the request and its labels.
  const ctx = { req, rb: rbFor(req.session.rb) } as Pick<ScreenContext, 'req' | 'rb'> as ScreenContext;
  const panel = await renderPanelBasic({ ctx, req, data, state });
  expect(isSafeHtml(panel.html)).toBe(true);
  expect(panel.tabId).toBe('tabBasic');
  expect(panel.tabLabel).toBe('Basic');
  const body = panel.bodyContent === undefined ? undefined : toString(panel.bodyContent);
  return { html: toString(panel.html), body };
}

beforeEach(() => {
  vi.stubEnv('MURA_HTMLEDITORTYPE', '');
  vi.stubEnv('MURA_FORMPOLLS', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.edit Basic panel', () => {
  it.each<[string, Case]>([
    ['home', {}],
    ['home-preview', { state: { preview: '1' } }],
    ['page-new', { bean: newBean('Page', capture('page-new')) }],
    ['folder-new', { bean: newBean('Folder', capture('folder-new')), type: 'Folder' }],
    ['gallery-new', { bean: newBean('Gallery'), type: 'Gallery' }],
    ['link-new', { bean: newBean('Link'), type: 'Link' }],
    ['file-new', { bean: newBean('File', capture('file-new')), type: 'File' }],
    [
      'component-new',
      { bean: newBean('Component'), type: 'Component', parentid: COMPONENT_MODULE_ID, moduleid: COMPONENT_MODULE_ID },
    ],
  ])('matches the legacy %s capture byte for byte', async (name, c) => {
    const { html, body } = await render(c);
    expect(html).toBe(capture(name).html);
    expect(body).toBe(capture(name).body);
  });


  it.each<[string, Case, boolean, boolean]>([
    ['a stored node of the Site Manager', { bean: NODE }, true, true],
    ['a new node', { bean: newBean('Page') }, true, false],
    ['the Components module', { bean: NODE, moduleid: COMPONENT_MODULE_ID }, false, false],
    ['a user without the SEO tab', { bean: NODE, state: { tabAssignments: 'Publishing' } }, false, false],
    ['a user with the SEO tab', { bean: NODE, state: { tabAssignments: 'publishing,seo' } }, true, true],
  ])('shows the SEO titles for %s only where the tab applies', async (_case, c, seoTitles, onkeypress) => {
    const { html } = await render(c);
    expect(html.includes('<div id="mura-seo-titles">')).toBe(seoTitles);
    expect(html.includes('<div class="help-block" id="editAdditionalTitles" style="display:none;">')).toBe(seoTitles);
    expect(html.includes(`onkeypress="openDisplay('editAdditionalTitles','Close');"`)).toBe(onkeypress);
  });

  it('prints the stored titles attribute-encoded', async () => {
    const titles = { title: 'A "T" <b>', menuTitle: 'M & m', urlTitle: 'u/t', htmlTitle: "H't" };
    const { html } = await render({ bean: { ...NODE, ...titles } });
    for (const [id, value] of Object.entries(titles)) {
      expect(html).toContain(`id="${id}" name="${id}" value="${encodeHtmlAttr(value)}"  maxlength="255"`);
    }
  });

  it.each<[string, number, string]>([
    ['locked', 1, ' disabled="disabled">'],
    ['unlocked', 0, '>'],
  ])('disables the plain title of %s content', async (_case, isLocked, tail) => {
    const bean = { ...newBean('Component'), isLocked };
    const { html } = await render({ bean, type: 'Component', parentid: COMPONENT_MODULE_ID });
    const menuTitle = '\n\t\t\t     \t\t \t<input type="hidden" id="menuTitle" name="menuTitle" value="">';
    expect(html).toContain(`message="The 'Title' field is required"${tail}${menuTitle}`);
  });

  it('gives a new node the requested title, as edit.cfm does', async () => {
    const { html } = await render({ bean: newBean('Page'), title: 'Requested & new' });
    expect(html).toContain(`id="title" name="title" value="${encodeHtmlAttr('Requested & new')}"`);
  });

  it.each<[string, string, string, boolean]>([
    [PARENT_ID, 'none', NODE_ID, true],
    [PARENT_ID, 'top', NODE_ID, true],
    [PARENT_ID, 'all', NODE_ID, false],
    [ROOT_CONTENT_ID, 'none', NODE_ID, true],
    [ROOT_CONTENT_ID, 'top', NODE_ID, false],
    [ROOT_CONTENT_ID, 'all', NODE_ID, false],
    [PARENT_ID, 'none', ROOT_CONTENT_ID, false],
  ])('under %s, locking %s, node %s: parent selector %s', async (parentid, locking, contentid, movable) => {
    const bean = { ...NODE, contentID: contentid };
    const { html } = await render({ bean, parentid, contentid, site: { ...SITE, locking } });
    const selector = `<span id="mover2" style="display:none"><input type="hidden" name="parentid" value="${parentid}">`;
    const hidden = `\n\t\t\t\t\t<input type="hidden" name="parentid" value="${parentid}">\n\t\t\t\t\n`;
    expect(html.includes('<div class="bigui" id="bigui__selectparent"')).toBe(movable);
    expect(html.includes(selector)).toBe(movable);
    expect(html.includes(hidden)).toBe(!movable);
  });

  it('takes a stored node edited without a parentid to its own parent', async () => {
    const { html } = await render({ bean: NODE, parentid: '', crumbData: CRUMBS });
    expect(html).toContain(`,'${PARENT_ID.replaceAll('-', '\\x2D')}'\n\t\t\t\t\t\t\t\t\t\t\t,''`);
  });

  it.each<[string, Bean, string]>([
    ['a stored node its parent', NODE, 'Parent <b>&'],
    ['a new node its own first crumb', newBean('Page'), 'About'],
  ])('labels the current parent of %s, unencoded', async (_case, bean, label) => {
    const { html } = await render({ bean, crumbData: CRUMBS, parentid: PARENT_ID });
    expect(html).toContain(`<div id="newparent-label">\n\t\t\t\t\t      \t\t\t"<span>${label}</span>"`);
  });

  const ALL_MODULES = [CONTENT_MODULE_ID, COMPONENT_MODULE_ID, FORM_MODULE_ID, EMAIL_MODULE_ID].join(',');

  it.each<[string, number, string, Bean, readonly string[]]>([
    ['a new Component', 1, '', SITE, ['m1']],
    ['every assignment', 0, ALL_MODULES, { ...SITE, emailBroadcaster: 1 }, ['m1', 'm2', 'm3', 'm4']],
    ['Forms off', 0, ALL_MODULES, { ...SITE, dataCollection: 0, emailBroadcaster: true }, ['m1', 'm2', 'm4']],
    ['no assignment', 0, '', SITE, []],
  ])('checks the Component module boxes of %s', async (_case, isNew, moduleAssign, site, checked) => {
    const bean = { ...newBean('Component'), isNew, moduleAssign };
    const { html } = await render({ bean, type: 'Component', parentid: COMPONENT_MODULE_ID, site });
    const box = /<input name="moduleAssign" type="CHECKBOX" id="(m\d)" +value="\d+" (checked )? class="checkbox">/g;
    const boxes = [...html.matchAll(box)];
    const present = ['m1', 'm2', ...(site.dataCollection ? ['m3'] : []), ...(site.emailBroadcaster ? ['m4'] : [])];
    expect(boxes.map((m) => m[1])).toEqual(present);
    expect(boxes.filter((m) => m[2] !== undefined).map((m) => m[1])).toEqual(checked);
  });

  it('keeps the source spacing of the Forms and Email Broadcaster boxes', async () => {
    const site = { ...SITE, emailBroadcaster: 1 };
    const bean = newBean('Component');
    const { html } = await render({ bean, type: 'Component', parentid: COMPONENT_MODULE_ID, site });
    expect(html).toContain(`id="m4"  value="${EMAIL_MODULE_ID}"  class="checkbox"> Email Broadcaster`);
    expect(html).toContain(`value="${FORM_MODULE_ID}"  class="checkbox">Forms\n`);
  });

  it.each<[string, string | undefined, unknown, string | undefined]>([
    ['without polls', undefined, 1, undefined],
    ['with polls off', 'false', 1, undefined],
    ['with polls, unchecked', 'true', 0, ''],
    ['with polls, checked', 'yes', 1, 'checked '],
    ['with polls, checked as a boolean', '1', true, 'checked '],
    ['with polls, unchecked as a boolean', '1', false, ''],
  ])('renders the Form fields %s', async (_case, formPolls, responseChart, poll) => {
    vi.stubEnv('MURA_FORMPOLLS', formPolls);
    resetLegacySettingsForTests();
    const message = 'Thanks <b>';
    const sendTo = 'a@b.c, "x"';
    const bean = { ...NODE, type: 'Form', responseChart, responseMessage: message, responseSendTo: sendTo };
    const { html, body } = await render({ bean, type: 'Form', moduleid: FORM_MODULE_ID });
    const pollBox = '<input name="responseChart" type="CHECKBOX" value="1" ';
    expect(html.includes(pollBox)).toBe(poll !== undefined);
    if (poll !== undefined) expect(html).toContain(`${pollBox}${poll} class="checkbox"> `);
    expect(html).toContain(`<textarea name="responseMessage" rows="4">${encodeHtml(message)}</textarea>`);
    expect(html).toContain(`<input type="text" name="responseSendTo" value="${encodeHtmlAttr(sendTo)}">`);
    expect(body).toContain("{ toolbar:'Form',");
  });

  it.each(['Variation', 'variation'])('saves no body content for a %s', async (type) => {
    expect((await render({ bean: { ...NODE, type }, type })).body).toBeUndefined();
  });

  it('prints the stored body HTML-encoded in the CKEditor textarea', async () => {
    const stored = '<p>A & "b"</p>';
    const { body } = await render({ bean: { ...NODE, body: stored } });
    expect(body).toContain(`<textarea name="body" id="body">${encodeHtml(stored)}</textarea>`);
    expect(body).toContain("{ toolbar:'Default',");
  });

  it.each(['none', 'NONE'])('prints a plain body textarea when htmlEditorType is %s', async (editor) => {
    vi.stubEnv('MURA_HTMLEDITORTYPE', editor);
    resetLegacySettingsForTests();
    const { body } = await render({ bean: NODE });
    expect(body).toBe(
      '\n\t\t\t\t\t\t\t<div id="bodyContainer" class="body-container mura-control-group" style="display:none;">\n' +
        '\t\t\t\t\t\t\t<label>\n\t\t\t\t\t      \t\tContent\n\t\t\t\t\t      \t</label>\n\t\t\t\t\t\t\t' +
        '\n\t\t\t\t\t\t\t\t\t<textarea name="body" id="body"></textarea>\n' +
        '\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t</div>\n\t\t\t\t\t',
    );
  });

  it.each<[string, string, boolean]>([
    ['an empty summary', '', false],
    ['an empty paragraph', '<P></P>', false],
    ['a summary', '<p>Sum</p>', true],
  ])('renders only the FCKeditor script, toggling the summary editor for %s', async (_case, summary, toggles) => {
    vi.stubEnv('MURA_HTMLEDITORTYPE', 'fckeditor');
    resetLegacySettingsForTests();
    const { body } = await render({ bean: { ...HOME, summary }, state: { preview: '1' } });
    const onComplete = 'function FCKeditor_OnComplete( editorInstance ) {\n\t\t\t\t\t\t\t\t\t\t\n';
    const toggle = "toggleDisplay('editSummary','Expand','Close');\n\t\t\t\t\t\t\t\t\teditSummary();";
    expect(body).not.toContain('<textarea');
    expect(body).toContain(`${onComplete}\t\t\t\t\t\t\t\t\t   \tpreview('${String(HOME.previewURL)}','');`);
    expect(body?.includes(toggle)).toBe(toggles);
  });

  it.each<[string, Bean, Partial<EditFormState>, boolean, boolean]>([
    ['by default', {}, {}, true, false],
    ['for extended content', {}, { isExtended: true }, false, false],
    ['with extensions shown by default', { showExtensionsInDefault: 'true' }, {}, true, true],
  ])('opens the body editor and the extended attributes %s', async (_case, model, state, opens, shown) => {
    const { html, body } = await render({ bean: NODE, model, state });
    const ready = 'jQuery(document).ready(function(){\n\t\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t\tshowBodyEditor();';
    expect(body?.includes(ready)).toBe(opens);
    expect(body?.includes('$("#bigui__basic").show();')).toBe(shown);
    expect(html.includes('id="extendedattributes-container-basic"')).toBe(!shown);
    expect(html).toContain('\t\t\t\t<span id="extendset-container-tabbasicbottom" class="extendset-container"></span>');
  });

  const RAZUNA_SITE: Bean = { ...SITE, razunaSettings: { hostname: 'razuna.example' } };

  it.each<[string, Bean, string, boolean]>([
    ['without Razuna settings', SITE, `" class="text mura-5" required="true" message="The 'URL' form field`, false],
    ['with a Razuna hostname', RAZUNA_SITE, '" class="text" required="true" message="', true],
  ])('renders the Link URL field %s', async (_case, site, input, browses) => {
    const url = 'http://x.y/?a=1&b="2"';
    const { body } = await render({ bean: { ...NODE, type: 'Link', body: url }, type: 'Link', site });
    expect(body).toContain(`<input type="text" id="url" name="body" value="${encodeHtmlAttr(url)}${input}`);
    expect(body?.includes(`onclick="renderRazunaWindow('body');return false;"`)).toBe(browses);
  });

  it.each<[string, Case, string]>([
    ['the site locking', { site: { dataCollection: 1 } }, 'rc.site.locking'],
    ['the crumbs of a movable node', { bean: NODE, model: { crumbData: null } }, 'rc.crumbData rows'],
    ['the preview URL', { bean: NODE, state: { preview: '1' } }, 'rc.contentBean.previewURL'],
    ['a Component site flag', { type: 'Component', site: { locking: 'all' } }, 'rc.site.dataCollection'],
  ])('throws when the edit model lacks %s', async (_case, c, missing) => {
    const error = new TypeError(`strategies-content getContentEditModel returned no ${missing}`);
    await expect(render(c)).rejects.toThrow(error);
  });

  it('throws as CFML does when the request lacks rc.type', async () => {
    const rc = { contentid: '', parentid: '', moduleid: CONTENT_MODULE_ID };
    const req = adminS2Request({ circuit: 'cArch', item: 'edit', rc });
    const ctx = { req, rb: rbFor('en') } as Pick<ScreenContext, 'req' | 'rb'> as ScreenContext;
    const data: EditPageData = { rc: { contentBean: HOME, site: SITE } };
    const panel = renderPanelBasic({ ctx, req, data, state: STATE });
    await expect(panel).rejects.toThrow('Element TYPE is undefined in RC.');
  });
});
