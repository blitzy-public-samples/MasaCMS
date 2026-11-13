// carch partials: the flat-view category tree (dsp_categories_nest.cfm), js.cfm's request.ajax and the data manager
// response edit form (data_manager/dsp_edit.cfm).
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacySettings, resetLegacySettingsForTests } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderDataEdit, type DataEditInput } from '@/screens/carch/data-manager/edit';
import { categoriesNest, type CategoriesNestOptions, type CategoryNestNode } from '@/screens/carch/partials/categories-nest';
import { carchJs } from '@/screens/carch/partials/js';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

/** Installs `vars` as the legacy settings variables, each `undefined` unsetting it. */
function useSettings(vars: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  resetLegacySettingsForTests();
}

beforeEach(() => useSettings({ MURA_CONTEXT: undefined, MURA_HTMLEDITORTYPE: undefined }));

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch dsp_categories_nest', () => {
  const NEWS = 'C1000000-0000-0000-0000000000000001';
  const LOCAL = 'C1000000-0000-0000-0000000000000002';
  const WORLD = 'C1000000-0000-0000-0000000000000003';
  const ASIA = 'C1000000-0000-0000-0000000000000004';
  const EVENTS = 'C1000000-0000-0000-0000000000000005';
  const LAB = 'C1000000-0000-0000-0000000000000006';

  const TREE: readonly CategoryNestNode[] = [
    {
      categoryID: NEWS,
      name: 'News',
      isOpen: 1,
      hasKids: 2,
      children: [
        { categoryID: LOCAL, name: 'Local', isOpen: true, hasKids: 0 },
        {
          categoryID: WORLD,
          name: 'World',
          isOpen: 0,
          hasKids: true,
          children: [{ categoryID: ASIA, name: 'Asia', isOpen: 1, hasKids: 0 }],
        },
      ],
    },
    // A category whose kids legacy does not list because its count says it has none.
    { categoryID: EVENTS, name: 'Events', isOpen: 2, hasKids: 0, children: [{ categoryID: LAB, name: 'Hidden', isOpen: 1, hasKids: 0 }] },
    { categoryID: LAB, name: 'R&D <Lab>', isOpen: 1, hasKids: false },
  ];

  const render = (opts: Partial<CategoriesNestOptions> = {}): string => {
    const out = categoriesNest({}, { siteId: 'default', tree: TREE, ...opts });
    expect(isSafeHtml(out)).toBe(true);
    return toString(out);
  };

  /** The checkbox legacy prints for an open category, `checked` when listed. */
  const box = (id: string, checked: boolean, name = 'categoryID'): string =>
    `<input type="checkbox" name="${name}" class="checkbox" ${checked ? 'checked' : ''} value="${id}"/> `;

  it('prints the Site Manager filter tree with checkboxes for open categories and the listed ids checked', () => {
    const html = render({ nestLevel: 0, categoryId: `${LOCAL},${ASIA}` });
    expect(html.startsWith('\n<ul id="mura-nodes" class="categories checkboxTree">\n')).toBe(true);
    expect(html).toContain(`<li>\n${box(NEWS, false)}News \n<ul class="categories">\n`);
    expect(html).toContain(`<li>\n${box(LOCAL, true)}Local \n</li>`);
    expect(html).toContain(`<li>\nWorld \n<ul class="categories">\n\n<li>\n${box(ASIA, true)}Asia \n</li>\n`);
    expect(html).toContain('<li>\nEvents \n</li>');
    expect(html).not.toContain('Hidden');
    expect(html).toContain(`<li>\n${box(LAB, false)}R&amp;D &lt;Lab&gt; \n</li>`);
    const $ = cheerio.load(html, null, false);
    expect($('ul').length).toBe(3);
    expect($('ul#mura-nodes').length).toBe(1);
    expect($('ul.checkboxTree').length).toBe(1);
    expect($('input[checked]').map((_, el) => $(el).attr('value')).get()).toEqual([LOCAL, ASIA]);
    expect($('input').map((_, el) => $(el).attr('value')).get()).toEqual([NEWS, LOCAL, ASIA, LAB]);
  });

  it.each<[string, Partial<CategoriesNestOptions>, string]>([
    ['the default level 1', {}, '\n<ul class="categories">\n'],
    ['level 0 without the id', { nestLevel: 0, useId: 0 }, '\n<ul class="categories checkboxTree">\n'],
    ['level 0 with a false useId', { nestLevel: 0, useId: false }, '\n<ul class="categories checkboxTree">\n'],
  ])('opens %s list as legacy does', (_case, opts, head) => {
    expect(render(opts).startsWith(head)).toBe(true);
  });

  it('matches the listed ids exactly and names the checkboxes as given, unencoded', () => {
    const html = render({ categoryId: `${LOCAL.toLowerCase()},,${NEWS}x`, elementName: 'cat"ID' });
    expect(html).toContain(box(NEWS, false, 'cat"ID'));
    expect(fragmentModel(html).controls.filter((c) => c.checked)).toEqual([]);
  });

  it('prints the level below a parent id, and nothing for an unknown or childless one', () => {
    expect(render({ parentId: WORLD })).toBe(`\n<ul class="categories">\n\n<li>\n${box(ASIA, false)}Asia \n</li>\n\n</ul>\n`);
    expect(render({ parentId: 'C1000000-0000-0000-00000000000000FF' })).toBe('');
    expect(render({ parentId: LOCAL })).toBe('');
  });

  it('prints nothing for a site without categories', () => {
    expect(render({ tree: [], nestLevel: 0 })).toBe('');
  });
});

describe('carch js.cfm request.ajax', () => {
  const architecture = (context: string): string =>
    `\n\t<script src="${context}/admin/assets/js/architecture.min.js?coreversion=${legacySettings().version}" type="text/javascript" ></script>\n`;

  const UNLOADED = '\n\t<script type="text/javascript">\n\t  summaryLoaded=false;\n\t</script>\n\n';
  const OPEN = '\n\t<script type="text/javascript">\n\n\t summaryLoaded=true;\n\n\t editSummary = function(){\n\t \t\t';
  const CLOSE = '\n\t\t}\n  </script>\n ';

  const ctxOf = (req: AdminRequest = adminS2Request({ circuit: 'cArch', item: 'edit' })): { req: AdminRequest } => ({ req });

  it.each(['list', 'datamanager', 'editLive'])('prints only the architecture script for action %s', (action) => {
    const out = carchJs(ctxOf(), action);
    expect(isSafeHtml(out)).toBe(true);
    expect(toString(out)).toBe(architecture(''));
  });

  it.each(['edit', 'EDIT'])('loads the summary CKEditor on action %s by default', (action) => {
    const out = toString(carchJs(ctxOf(), action));
    expect(out.startsWith(architecture('') + UNLOADED + OPEN + '\n\t \t\tif(!summaryLoaded){\n')).toBe(true);
    expect(out).toContain("jQuery('#summary').ckeditor(");
    expect(out.endsWith(`\n\t\t\t}\n\t\t\t${CLOSE}`)).toBe(true);
  });

  it.each(['none', 'NONE'])('leaves the summary editor body empty for htmlEditorType %s', (editorType) => {
    useSettings({ MURA_HTMLEDITORTYPE: editorType });
    expect(toString(carchJs(ctxOf(), 'edit'))).toBe(architecture('') + UNLOADED + OPEN + CLOSE);
  });

  it('loads FCKeditor with the context, the session site theme and the session bundle in lower case', () => {
    useSettings({ MURA_HTMLEDITORTYPE: 'FCKeditor', MURA_CONTEXT: '/cms' });
    const req = adminS2Request({ circuit: 'cArch', item: 'edit', site: { record: { theme: 'mytheme' } }, session: { rb: 'de_DE' } });
    const out = toString(carchJs(ctxOf(req), 'edit'));
    expect(out.startsWith(architecture('/cms') + UNLOADED + OPEN)).toBe(true);
    expect(out).toContain('\t\t   \t\tFCKeditor_OnComplete=htmlEditorOnComplete;\n');
    expect(out).toContain('\t\t\t\toFCKeditor.BasePath\t\t= "/cms/wysiwyg/";\n');
    expect(out).toContain("\t\t\t\toFCKeditor.Config.EditorAreaCSS\t= '/cms/themes/mytheme/css/editor.css';\n");
    expect(out).toContain("\t\t\t\toFCKeditor.Config.StylesXmlPath = '/cms/themes/mytheme/css/fckstyles.xml';\n");
    expect(out).toContain("\t\t\t\toFCKeditor.Config.DefaultLanguage='de_de';\n");
    expect(out).not.toContain('CustomConfigurationsPath');
    expect(out).not.toContain('ckeditor(');
  });

  it('points FCKeditor at the installed theme when programs-sites served no session site', () => {
    useSettings({ MURA_HTMLEDITORTYPE: 'fckeditor' });
    const req = { ...adminS2Request({ circuit: 'cArch', item: 'edit' }), site: undefined };
    expect(toString(carchJs(ctxOf(req), 'edit'))).toContain("oFCKeditor.Config.EditorAreaCSS\t= '/themes/default/css/editor.css';");
  });
});

describe('carch data manager response edit form', () => {
  const RESPONSE_ID = 'A1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D';
  const PHOTO_ID = 'F1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D';
  const HOME = '00000000000000000000000000000000001';
  const FORMS = '00000000000000000000000000000000004';
  const LONG = `${'x'.repeat(98)}<&>`;

  function editInput(req: AdminRequest, values: Partial<DataEditInput> = {}): DataEditInput {
    return {
      fieldnames: 'name,,Photo_Attachment,resume_attachment,MESSAGE,missing,a<b>',
      response: {
        responseId: RESPONSE_ID,
        entered: '2026-06-01 13:05:00.0',
        enteredRaw: '2026-06-01 13:05:00.0',
        data: {
          NAME: 'Ann "A" <b>',
          PHOTO_ATTACHMENT: PHOTO_ID,
          resume_attachment: 'resume.pdf',
          message: LONG,
          'A<B>': 'v',
        },
      },
      contentid: HOME,
      siteid: 'default',
      moduleid: FORMS,
      hour1: '0',
      hour2: '23',
      minute1: '0',
      minute2: '59',
      date1: '',
      date2: '',
      sortBy: 'Entered',
      sortDirection: 'asc',
      filterBy: 'NAME',
      keywords: 'k"w <x>',
      dateKeyFormat: req.session.dateKeyFormat,
      locale: req.session.locale,
      ...values,
    };
  }

  async function render(values: Partial<DataEditInput> = {}): Promise<{ html: string; ctx: ReturnType<typeof makeScreenContext> }> {
    const req = adminS2Request({ circuit: 'cArch', item: 'datamanager' });
    const ctx = makeScreenContext({ req });
    const out = await renderDataEdit(ctx, editInput(req, values));
    expect(isSafeHtml(out)).toBe(true);
    return { html: toString(out), ctx };
  }

  it('posts a stored attachment id as a hidden field and the other fields, read in any case, as inputs', async () => {
    const { html } = await render();
    expect(html).toContain('\n  <div class="mura-control">\n    06/152/2026 1:05 PM\n  </div>\n');
    expect(html).toContain(`<input type="hidden" name="Photo_Attachment" value="${PHOTO_ID}">`);
    expect(html).not.toContain('<label>Photo_Attachment</label>');
    const fields = fragmentModel(html).controls.filter((c) => c.tag !== 'input' || c.type !== 'hidden');
    expect(fields.map((c) => [c.tag, c.name, c.value])).toEqual([
      ['input', 'name', 'Ann "A" <b>'],
      ['input', 'resume_attachment', 'resume.pdf'],
      ['textarea', 'MESSAGE', LONG],
      ['input', 'missing', ''],
      ['input', 'a<b>', 'v'],
    ]);
    expect(fragmentModel(html).labels).toEqual(['Date/Time Entered', 'name', 'resume_attachment', 'MESSAGE', 'missing', 'a<b>']);
  });

  it('encodes field names, values and posted state as legacy does', async () => {
    const { html } = await render();
    expect(html).toContain(`<input class="mura-constrain" type="text" name="name" value="${encodeHtmlAttr('Ann "A" <b>')}">`);
    expect(html).toContain(`<textarea class="mura-constrain" name="MESSAGE">${encodeHtml(LONG)}</textarea>`);
    expect(html).toContain(`<label>${encodeHtml('a<b>')}</label>`);
    expect(html).toContain(`name="${encodeHtmlAttr('a<b>')}" value="v"`);
    expect(html).toContain(`<input type="hidden" name="keywords" value="${encodeHtmlAttr('k"w <x>')}">`);
    expect(html).toContain(
      `<input type="hidden" name="fieldlist" value="${encodeHtmlAttr('name,,Photo_Attachment,resume_attachment,MESSAGE,missing,a<b>')}">`,
    );
    expect(html).toContain(`<input type="hidden" name="responseID" value="${RESPONSE_ID}">`);
    expect(html).toContain('<input type="hidden" name="entered" value="2026-06-01 13:05:00.0">');
    expect(html).toContain(String.raw`onclick="submitForm(document.forms.form1,'delete','Delete\x20Response\x3F');"`);
  });

  it.each<[string, string]>([
    ['an attachment that holds no id', 'resume.pdf'],
    ['an id outside an attachment field', PHOTO_ID],
  ])('labels %s as a text field', async (_case, value) => {
    const name = value === PHOTO_ID ? 'photo' : 'Photo_Attachment';
    const { html } = await render({
      fieldnames: name,
      response: { responseId: RESPONSE_ID, entered: '', enteredRaw: '', data: { [name]: value } },
    });
    expect(html).toContain(`<label>${name}</label>`);
    expect(html).toContain(`type="text" name="${name}" value="${encodeHtmlAttr(value)}"`);
  });

  it("closes with the response's CSRF fields, issued for its id", async () => {
    const { html, ctx } = await render();
    expect(html.endsWith(
      `<input type="hidden" name="action" value="update">\n<input type="hidden" name="csrf_token" value="${FIXED_CSRF.token}" /><input type="hidden" name="csrf_token_expires" value="${FIXED_CSRF.expires}" />\n</form>\n`,
    )).toBe(true);
    expect(ctx.gateway.calls.filter((call) => call.path === '/v1/csrf/tokens').map((call) => call.json)).toEqual([
      { contexts: [RESPONSE_ID] },
    ]);
  });
});
