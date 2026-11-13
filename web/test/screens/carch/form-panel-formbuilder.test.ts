// carch form/dsp_panel_formbuilder.cfm: a builder Form's Basic panel, against legacy captures.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { encodeHtmlAttr, isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import type { EditFormState } from '@/screens/carch/form/custom-tags';
import { renderFormBuilder } from '@/screens/carch/form/formbuilder';
import { headFormBuilder } from '@/screens/carch/form/head-formbuilder';
import { renderPanelFormBuilder, type PanelFormBuilderInput } from '@/screens/carch/form/panel-formbuilder';
import { fragmentModel } from '../../helpers/dom-model';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` of a new builder Form (`type=Form&formType=builder`) under the Forms root of the default site, captured
// from the legacy ACF 2023 server as admin: the panel from the include's newline after `<cfoutput>` through
// `\t</div>\n`, and the `bodyContent` edit.cfm prints inside `#mura-content-body-render`, as served.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}.html`, import.meta.url), 'utf8');
const LEGACY_PANEL = fixture('edit-panel-formbuilder');
const LEGACY_BODY_CONTENT = fixture('edit-panel-formbuilder-body');

/** The `createJSONForm` body of the captured form. */
const FORM_JSON = /<textarea id="mura-formdata" name="body">([^<]*)<\/textarea>/.exec(LEGACY_BODY_CONTENT)?.[1] ?? '';

const SUMMARY_TOOLTIP =
  'Create a summary for the content. The summary will display under the title when used in a Masa CMS folder.';

const FORMS_ROOT_ID = '00000000000000000000000000000000004';
const STORED_PARENT_ID = 'C1000000-0000-0000-0000000000000001';

const HEAD = [
  '',
  '<script src="/admin/assets/js/jquery/jquery.jsonform.js" type="text/javascript"></script>',
  '<script src="/admin/assets/js/templatebuilder/jquery.templatebuilder.0.7.js" type="text/javascript"></script>',
  '<script src="/admin/assets/js/minigrid/jquery-ui-minigrid-0.7.js" type="text/javascript"></script>',
  '',
].join('\n');

const FORM_FIELDS =
  '\t\t\t\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>\n\t\t\t\t\t\tConfirmation Message\n' +
  '\t\t\t\t\t</label>\n\t\t\t\t\t<textarea name="responseMessage" rows="4"></textarea>\n\t\t\t\t</div>\n' +
  '\t\t\t\t<div class="mura-control-group">\n' +
  '\t\t\t\t\t<label>Send Data to Email (separate multiple addresses with comma)</label>\n' +
  '\t\t\t\t\t<input type="text" name="responseSendTo" value="">\n\t\t\t\t</div>\n\t\t\t\n';

type Bean = Readonly<Record<string, unknown>>;

/** The new form's bean as the captured edit view holds it. */
const NEW_FORM: Bean = Object.freeze({
  contentID: '45400F13-0A3C-69A3-BFC1FBD7CA5CC123',
  parentID: FORMS_ROOT_ID,
  isNew: 1,
  title: '',
  summary: '',
  body: FORM_JSON,
  responseChart: 0,
  responseMessage: '',
  responseSendTo: '',
});

const STATE: EditFormState = Object.freeze({
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: '',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Form',
  compactDisplay: 'false',
  preview: '0',
});

interface Case {
  readonly bean?: Bean;
  readonly type?: string;
  readonly parentid?: string;
  readonly rb?: RbLookup;
}

function inputOf(c: Case = {}): PanelFormBuilderInput {
  const req = adminS2Request({
    circuit: 'cArch',
    item: 'edit',
    rc: { type: c.type ?? 'Form', parentid: c.parentid ?? FORMS_ROOT_ID },
  });
  const data = { rc: { contentBean: c.bean ?? NEW_FORM } };
  return { ctx: { rb: c.rb ?? rbFor(req.session.rb) }, req, data, state: STATE };
}

function render(c: Case = {}): string {
  const panel = renderPanelFormBuilder(inputOf(c));
  expect(isSafeHtml(panel.html)).toBe(true);
  return toString(panel.html);
}

/** Clears every `MURA_` variable, then sets `vars`, so legacy settings resolve from `vars` alone. */
function useSettings(vars: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();
}

beforeEach(() => {
  useSettings();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('carch.edit builder Form Basic panel', () => {
  it('matches the legacy include byte for byte and names its tab', () => {
    const panel = renderPanelFormBuilder(inputOf());
    expect(toString(panel.html)).toBe(LEGACY_PANEL);
    expect(panel.tabId).toBe('tabBasic');
    expect(panel.tabLabel).toBe('Basic');
  });

  it('returns the form builder as bodyContent, outside the panel', () => {
    const panel = renderPanelFormBuilder(inputOf());
    const bodyContent = panel.bodyContent === undefined ? '' : toString(panel.bodyContent);
    expect(isSafeHtml(panel.bodyContent)).toBe(true);
    // Legacy serves the form builder include with CRLF line ends; renderFormBuilder emits LF, which HTML parses alike.
    expect(bodyContent).toBe(LEGACY_BODY_CONTENT.replaceAll('\r\n', '\n'));
    expect(fragmentModel(bodyContent)).toEqual(fragmentModel(LEGACY_BODY_CONTENT));
    expect(bodyContent).toContain(toString(renderFormBuilder(inputOf())));
    expect(toString(panel.html)).not.toMatch(/bodyContainer|mura-templatebuilder|mura-formdata|<script/);
  });

  it('returns the form builder scripts as htmlHead, outside the panel', () => {
    const panel = renderPanelFormBuilder(inputOf());
    expect(panel.htmlHead === undefined ? '' : toString(panel.htmlHead)).toBe(HEAD);
    expect(toString(headFormBuilder())).toBe(HEAD);
    expect(toString(panel.html)).not.toContain('.js');
  });

  it('encodes the title, parent, message and send-to as legacy does and prints labels raw', () => {
    const rb: RbLookup = { locale: 'en', rbKey: (key) => `<${key}> "&"`, messageFormat: () => '' };
    const markup = render({
      rb,
      parentid: 'p"<1>',
      bean: { ...NEW_FORM, title: 'A "b" <c>', responseMessage: 'Thanks <b>"you"</b>', responseSendTo: 'a@b.c, "d"' },
    });
    expect(markup).toContain(
      'value="A&#x20;&quot;b&quot;&#x20;&lt;c&gt;"  maxlength="255" required="true" ' +
        'message="<sitemanager.content.fields.titlerequired> "&"">',
    );
    expect(markup).toContain('aria-controls="panel-basic"><sitemanager.content.tabs.basic> "&"</a>');
    expect(markup).toContain('\t\t\t\t<sitemanager.content.fields.title> "&"\n\t\t\t</label>');
    expect(markup).toContain('<input type="hidden" name="parentid" value="p&quot;&lt;1&gt;">');
    expect(markup).toContain('rows="4">Thanks &lt;b&gt;&quot;you&quot;&lt;&#x2f;b&gt;</textarea>');
    expect(markup).toContain('<label><sitemanager.content.fields.responsesendto> "&"</label>');
    expect(markup).toContain('name="responseSendTo" value="a&#x40;b.c,&#x20;&quot;d&quot;">');
  });

  it('reads the bean by case-insensitive name and SQL NULL as empty', () => {
    const bean = { BODY: FORM_JSON, ISNEW: 1, Title: null, RESPONSEMESSAGE: 'm', responsesendto: 7 };
    const input = { ...inputOf(), data: { rc: { CONTENTBEAN: bean } } };
    expect(toString(renderPanelFormBuilder(input).html)).toBe(
      LEGACY_PANEL.replace('rows="4"></textarea>', 'rows="4">m</textarea>').replace(
        'name="responseSendTo" value=""',
        'name="responseSendTo" value="7"',
      ),
    );
  });

  const STORED_FORM: Bean = { ...NEW_FORM, isNew: 0, parentID: STORED_PARENT_ID };

  it.each<[string, Case, string]>([
    ['a stored form opened without a parent takes its own', { parentid: '', bean: STORED_FORM }, STORED_PARENT_ID],
    ['a new form keeps the empty parent', { parentid: '' }, ''],
    ['the requested parent wins', { parentid: FORMS_ROOT_ID, bean: STORED_FORM }, FORMS_ROOT_ID],
  ])('fills parentid as edit.cfm does: %s', (_case, c, parentId) => {
    expect(render(c)).toContain(`<input type="hidden" name="parentid" value="${parentId}">`);
  });

  it.each<[string, unknown, string]>([
    ['checked for responseChart 1', 1, 'value="1" checked  class="checkbox">'],
    ['unchecked for responseChart 0', 0, 'value="1"  class="checkbox">'],
    ['unchecked for a NULL responseChart', null, 'value="1"  class="checkbox">'],
  ])('adds the poll checkbox with formpolls set, %s', (_case, responseChart, input) => {
    useSettings({ MURA_FORMPOLLS: 'true' });
    const poll =
      '\t\t\t\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>Form Presentation</label>\n' +
      `\t\t\t\t\t<label for="rc" class="checkbox">\n\t\t\t\t\t\t<input name="responseChart" type="CHECKBOX" ${input} ` +
      'Is this a poll?\n\t\t\t\t\t</label>\n\t\t\t\t\t</div>\n\t\t\t\t\n\t\t\t\t<div class="mura-control-group">';
    const confirmation = '\n\t\t\t\t\t<label>\n\t\t\t\t\t\tConfirmation';
    expect(render({ bean: { ...NEW_FORM, responseChart } })).toBe(
      LEGACY_PANEL.replace(`\t\t\t\n\t\t\t\t<div class="mura-control-group">${confirmation}`, poll + confirmation),
    );
  });

  it.each(['component', 'COMPONENT'])('prints neither summary nor Form fields for type %s', (type) => {
    expect(render({ type })).toBe(LEGACY_PANEL.replace(FORM_FIELDS, '\t\t\t\n'));
  });

  it.each<[string, Record<string, string>, string, string]>([
    ['encodes a stored summary', {}, '<p>Hi & bye</p>', '&lt;p&gt;Hi &amp; bye&lt;&#x2f;p&gt;'],
    ['prints an empty summary for the default editor', {}, '', ''],
    ['seeds an empty paragraph without an HTML editor', { MURA_HTMLEDITORTYPE: 'None' }, '', '<p></p>'],
    ['encodes a stored summary without an HTML editor', { MURA_HTMLEDITORTYPE: 'none' }, 'x<y', 'x&lt;y'],
  ])('adds the summary field for other types and %s', (_case, vars, summary, editor) => {
    useSettings(vars);
    const field =
      '\t\t\t\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>\n' +
      `\t\t\t\t<a href="#" rel="tooltip" title="${encodeHtmlAttr(SUMMARY_TOOLTIP)}">\n` +
      '\t\t\t\t\tSummary\n\t\t\t\t\t\t <i class="mi-question-circle"></i></a>\n' +
      '\t\t\t\t<a href="#" id="editSummaryLink" ' +
      `onclick="javascript: toggleDisplay('editSummary','Expand','Close'); editSummary();return false">\n` +
      '\t\t\t\t\t[Expand]\n\t\t\t\t</a>\n\t\t\t</label>\n' +
      '\t\t\t\t\t<div class="mura-control justify" id="editSummary" style="display:none;">\n' +
      `\t\t\t\t<textarea name="summary" id="summary" cols="96" rows="10">${editor}</textarea>\n` +
      '\t\t\t</div>\n\t\t</div>\n\t\t\t\n\n\t\t\t<span id="extendSetsBasic">';
    expect(render({ type: 'Page', bean: { ...NEW_FORM, summary } })).toBe(
      LEGACY_PANEL.replace('\t\t\t\n\n\t\t\t<span id="extendSetsBasic">', field).replace(FORM_FIELDS, '\t\t\t\n'),
    );
  });

  it.each<[string, Bean, string]>([
    ['no content bean', {}, 'rc.contentBean is not a struct'],
    ['a complex title', { contentBean: { ...NEW_FORM, title: ['t'] } }, 'rc.contentBean.title is not a simple value'],
  ])('rejects an edit model with %s', (_case, rc, message) => {
    const input = { ...inputOf(), data: { rc } };
    expect(() => renderPanelFormBuilder(input)).toThrow(new TypeError(message));
  });

  it('rejects a request without rc.type', () => {
    const input = inputOf();
    const rc = Object.fromEntries(Object.entries(input.req.rc).filter(([name]) => name.toLowerCase() !== 'type'));
    expect(() => renderPanelFormBuilder({ ...input, req: { ...input.req, rc } })).toThrow(
      new TypeError('rc.type is undefined for carch.edit'),
    );
  });
});
