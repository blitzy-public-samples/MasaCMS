// cUsers.loadExtendedAttributes against cusers/loadextendedattributes.cfm and extendAttribute.renderAttribute with the
// cf_datetimeselector, cf_timeselector, cf_fileselector and cf_filetools tags it calls.
import { readFileSync } from 'node:fs';
import { LEGACY_HTML_CONTENT_TYPE, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeHtmlAttr, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  extendRenderContext,
  legacyJsonEncode,
  loadExtendedAttributesScreen,
  renderExtendAttribute,
  renderExtendSets,
  type ExtendAttributeDefinition,
  type ExtendFileMetaData,
  type ExtendRenderContext,
  type ExtendSetDefinition,
  type ExtendSubject,
  type ExtendValue,
  type LegacyJsonValue,
  type RenderExtendAttributeOptions,
  type RenderExtendSetsOptions,
} from '@/screens/cusers/loadextendedattributes';
import { adminS2Request, editorRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { makeScreenContext } from '../../helpers/screen-context';

const ACTION = { circuit: 'cusers', item: 'loadExtendedAttributes' } as const;
const USER_ID = 'EA000000-0000-0000-0000000000000001';
const FILE_ID = 'F1000000-0000-0000-0000000000000001';
const SET_ID = 'EA000000-0000-0000-00000000000000C1';
const CACHE_ID = /\?cacheID=[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}"/;
// The business clock's date: 2026-06-30 12:00 UTC.
const NOW = new Date('2026-06-30T12:00:00Z');

// cf_datetimeselector as the legacy ACF 2023 server prints it for an empty value under en_US, captured from the
// cChangesets.edit publishDate field, which calls the tag with the attributes renderAttribute passes.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/people/${name}.html`, import.meta.url), 'utf8');

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** A `tclassextendattributes` row with empty text columns, optional and shown to everyone. */
const attribute = (
  attr: Partial<ExtendAttributeDefinition> & Pick<ExtendAttributeDefinition, 'name' | 'type'>,
): ExtendAttributeDefinition => ({
  attributeID: 9001,
  label: '',
  hint: '',
  adminOnly: 0,
  required: 'false',
  validation: '',
  regex: '',
  message: '',
  defaultValue: '',
  optionList: '',
  optionLabelList: '',
  ...attr,
});

/** A user bean holding `values`, whose `getvalue(name, 'useMuraDefault')` answers the default for any other name. */
function subject(values: Readonly<Record<string, ExtendValue>>, files: Readonly<Record<string, ExtendFileMetaData>> = {}): ExtendSubject {
  return {
    userID: USER_ID,
    siteID: 'default',
    valueOf: (name) => values[name] ?? 'useMuraDefault',
    fileMetaData: (name) => files[name],
  };
}

/** A stored file's metadata whose image URL names the requested size. */
const fileMeta = (filename: string, fileExt: string): ExtendFileMetaData => ({
  filename,
  fileExt,
  imageUrl: (size) => `/sites/default/cache/file/${FILE_ID}_${size}.${fileExt}`,
});

/** The render context of the S2 admin's request, or of `req`. */
function renderContext(req: AdminRequest = adminS2Request(ACTION)): ExtendRenderContext {
  return extendRenderContext(makeScreenContext({ req, now: NOW }));
}

/** `renderAttribute` of `attr` as text. */
function rendered(attr: ExtendAttributeDefinition, options: Partial<RenderExtendAttributeOptions> = {}): string {
  return toString(renderExtendAttribute(attr, { value: 'useMuraDefault', context: renderContext(), ...options }));
}

describe('loadExtendedAttributesScreen.load', () => {
  it.each<[string, Readonly<Record<string, unknown>>, boolean]>([
    ['a session holding an edit bean', { editBean: { userID: USER_ID } }, true],
    ['a session without one', {}, false],
  ])('fails closed for %s after clearing session.mura.editBean', async (_label, muraValues, writes) => {
    const ctx = makeScreenContext({ req: adminS2Request({ ...ACTION, session: { muraValues } }) });

    const loaded = loadExtendedAttributesScreen.load!(ctx);

    await expect(loaded).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(loaded).rejects.toMatchObject({ surface: 'admin', reason: 'extend-definitions-unserved' });
    expect(ctx.req.session.muraValues['editBean']).toBeUndefined();
    expect(ctx.req.sessionWrites.muraValues !== undefined).toBe(writes);
  });
});

describe('loadExtendedAttributesScreen.render', () => {
  it('answers the mura.json returnsets, extended before basic, and the trailing space of the view', async () => {
    const ctx = makeScreenContext({ req: adminS2Request({ ...ACTION, rc: { compactDisplay: 'true' } }) });
    const sets = (name: string): ExtendSetDefinition[] => [
      { extendSetID: SET_ID, categoryID: '', name, attributes: [attribute({ name: 'extNote', type: 'TextBox', label: 'Note' })] },
    ];
    const data = { subject: subject({ extNote: 'stored' }), defaultSets: sets('Default Set'), basicSets: sets('Basic Set') };

    const raw = await loadExtendedAttributesScreen.render(ctx, data);
    const body = String(raw.body);

    expect(raw).toMatchObject({ status: 200, contentType: LEGACY_HTML_CONTENT_TYPE });
    expect(body.startsWith('{"extended":"<span class=\\"extendset\\"')).toBe(true);
    expect(body.indexOf('Default Set')).toBeLessThan(body.indexOf('"basic":"'));
    expect(body.indexOf('"basic":"')).toBeLessThan(body.indexOf('Basic Set'));
    expect(body.endsWith('"} ')).toBe(true);
    // The two cfsavecontent blocks close a control group differently; both are JSStringFormat-escaped.
    const extended = body.slice(0, body.indexOf('"basic":"'));
    const basic = body.slice(body.indexOf('"basic":"'));
    expect(extended).toContain('data-required=\\"false\\" />\\n\\n\\t\\t\\t\\t\\t\\t\\n\\t\\t\\t\\t\\t\\t</div>');
    expect(basic).toContain('data-required=\\"false\\" />\\n\\n\\t\\t\\t\\t\\t\\t\\n\\n\\t\\t\\t\\t\\t\\t</div>');
    expect(body).toContain('</div>\\n\\t\\t\\t\\t\\t\\n\\t\\t\\t\\t</span>"');
  });

  it('answers empty returnsets for a subtype without sets', async () => {
    const ctx = makeScreenContext({ req: editorRequest(ACTION) });

    const raw = await loadExtendedAttributesScreen.render(ctx, { subject: subject({}), defaultSets: [], basicSets: [] });

    expect(raw.body).toBe('{"extended":"","basic":""} ');
  });
});

describe('renderExtendSets', () => {
  const options = (overrides: Partial<RenderExtendSetsOptions> = {}): RenderExtendSetsOptions => ({
    container: 'Default',
    context: renderContext(),
    compactDisplay: 'false',
    privileged: true,
    ...overrides,
  });
  const oneSet = (...attributes: ExtendAttributeDefinition[]): ExtendSetDefinition[] => [
    { extendSetID: SET_ID, categoryID: 'CAT1', name: 'Profile & Prefs', attributes },
  ];

  it('wraps each set in its span with the hidden set id and the encoded heading', () => {
    const html = toString(renderExtendSets(oneSet(), subject({}), options()));

    expect(html).toBe(
      `<span class="extendset" extendsetid="${SET_ID}" categoryid="CAT1" >\n\t\t\t\t\t<input name="extendSetID" ` +
        `type="hidden" value="${SET_ID}" />\n\t\t\t\t\t<h2>Profile &amp; Prefs</h2>\n\t\t\t\t\t\n\t\t\t\t</span>`,
    );
  });

  it('labels a hinted attribute with its popover and the label, falling back to the name', () => {
    const html = toString(
      renderExtendSets(oneSet(attribute({ name: 'extNick', type: 'TextBox', hint: 'Shown "publicly"' })), subject({}), options()),
    );

    expect(html).toContain('data-content="Shown&#x20;&quot;publicly&quot;"');
    expect(html).toContain('data-original-title="extNick">\n\t\t\t\t\t\t\t\t\t\textNick <i class="mi-question-circle"></i>');
  });

  it('edits a Hidden attribute as a TextBox', () => {
    const html = toString(renderExtendSets(oneSet(attribute({ name: 'extToken', type: 'Hidden' })), subject({ extToken: 't1' }), options()));

    expect(html).toContain('<input type="text" name="extToken" class="text" id="extToken" data-label="extToken" value="t1"');
    expect(html).not.toContain('type="hidden" name="extToken"');
  });

  it.each<[string, boolean, boolean]>([
    ['an editable URL attribute', true, true],
    ['a read-only URL attribute', false, false],
  ])('offers the asset browser for %s: %s', (_label, privileged, browse) => {
    const attr = attribute({ name: 'extSite', type: 'TextBox', validation: 'URL', adminOnly: 1 });

    const html = toString(renderExtendSets(oneSet(attr), subject({ extSite: 'https://example.com' }), options({ privileged })));

    expect(html.includes('data-target="extSite" data-resourcetype="user"')).toBe(browse);
    expect(html.includes('<i class="mi-folder-open"></i> Browse Assets</button>')).toBe(browse);
  });

  it.each<[string, string, string]>([
    ['ASCII text', 'stored', 'stored \n\t\t\t\t\t\t</div>'],
    ['a no-break space, which Java does not count as whitespace', 'stored\u00a0', 'stored\u00a0 \n\t\t\t\t\t\t</div>'],
    ['an em space, a Unicode space separator', 'stored\u2003', 'stored\u2003\n\t\t\t\t\t\t</div>'],
  ])('prints a read-only value ending in %s as ACF whitespace management does', (_label, value, printed) => {
    const attr = attribute({ name: 'extLocked', type: 'TextBox', adminOnly: 1 });

    const html = toString(renderExtendSets(oneSet(attr), subject({ extLocked: value }), options({ privileged: false })));

    expect(html).toContain(`</label>\n\n\t\t\t\t\t\t\t${printed}`);
    expect(html).not.toContain('name="extLocked"');
  });

  it('closes a Basic control group with the Basic block text', () => {
    const attr = attribute({ name: 'extNote', type: 'TextBox' });

    const basic = toString(renderExtendSets(oneSet(attr), subject({ extNote: 'n' }), options({ container: 'Basic' })));

    expect(basic).toContain('value="n" data-required="false" />\n\n\t\t\t\t\t\t\n\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\n\t\t\t\t</span>');
  });
});

describe('renderExtendAttribute controls', () => {
  it('renders a Hidden attribute with its HTMLEditFormat value, CR dropped', () => {
    expect(rendered(attribute({ name: 'extH', type: 'Hidden', label: 'Tag' }), { value: 'a & "b"\r\n<c>' })).toBe(
      '<input type="hidden" name="extH" id="extH" data-label="Tag" value="a &amp; &quot;b&quot;\n&lt;c&gt;" />',
    );
  });

  it('renders a Regex TextBox with its validation, regex and XMLFormat message', () => {
    const attr = attribute({ name: 'extCode', type: ' text ', required: 'true', validation: 'Regex', regex: '^[a-z]+$', message: "Use 'a-z' <only>" });

    expect(rendered(attr, { value: 'abc' })).toContain(
      '<input type="text" name="extCode" class="text" id="extCode" data-label="extCode" value="abc" data-required="true" ' +
        'data-validate="Regex" data-regex="^[a-z]+$" data-message="Use &apos;a-z&apos; &lt;only&gt;" />',
    );
  });

  it.each<[string, ExtendValue, string]>([
    ['a date object', new Date(2026, 5, 30, 9, 15), '06/181/2026'],
    ['date text in the session locale', '06/30/2026', '06/181/2026'],
    ['blank text', '', ''],
  ])('renders a date TextBox holding %s with the session date key mask', (_label, value, shown) => {
    expect(rendered(attribute({ name: 'extBorn', type: 'TextBox', validation: 'date' }), { value })).toContain(
      `<input type="text" name="extBorn" class="text datepicker" id="extBorn" data-label="extBorn" value="${shown}" ` +
        'data-required="false" data-validate="date" />',
    );
  });

  it('renders a color TextBox as the color picker with its swatch and message', () => {
    const html = rendered(attribute({ name: 'extColor', type: 'TextBox', validation: 'color', message: 'Pick one' }), { value: '#ff0000' });

    expect(html).toContain('<i class="mura-colorpicker-swatch" style="background-color:#ff0000"></i>');
    expect(html).toContain(
      '<input type="text" id="extColor" name="extColor" placeholder="Select Color" autocomplete="off"  value="#ff0000" ' +
        'data-label="extColor" data-required="false" data-message="Pick one">',
    );
  });

  it.each<[string, string, boolean]>([
    ['TextArea', 'TextArea', false],
    ['HTMLEditor', 'HTMLEditor', true],
  ])('renders a %s with its validation after the editor class', (_label, type, editor) => {
    const attr = attribute({ name: 'extBio', type, validation: 'Regex', regex: '.+', message: 'Required' });

    expect(rendered(attr, { value: 'Line <1>' })).toBe(
      `<textarea name="extBio" id="extBio" data-label="extBio" data-required="false" data-message="Required"` +
        `${editor ? ' class="htmlEditor"' : ''} data-validate="Regex" data-regex=".+">Line &lt;1&gt;</textarea>`,
    );
  });

  it.each<[string, string, ExtendValue, readonly string[]]>([
    ['a SelectBox by its value', 'SelectBox', 'b', ['b']],
    ['a MultiSelectBox by its ^ list', 'MultiSelectBox', 'a^c', ['a', 'c']],
    ['a MultiSelectBox by its comma list', 'MultiSelectBox', 'c,b', ['b', 'c']],
  ])('selects the options of %s', (_label, type, value, chosen) => {
    const attr = attribute({ name: 'extPick', type, optionList: 'a^b^c', optionLabelList: 'Apple^Banana^Cherry' });
    const multiple = type === 'MultiSelectBox';

    const html = rendered(attr, { value });

    expect(html.startsWith('<input type="hidden" name="extPick" value="" />')).toBe(multiple);
    expect(html.includes(' multiple="multiple">')).toBe(multiple);
    for (const [option, label] of [['a', 'Apple'], ['b', 'Banana'], ['c', 'Cherry']] as const) {
      const selected = chosen.includes(option) ? ' selected="selected"' : '';
      expect(html).toContain(`<option value="${option}"${selected}>${label}</option>`);
    }
  });

  it('labels select options by their value without a label list and XMLFormats the value', () => {
    const html = rendered(attribute({ name: 'extTier', type: 'SelectBox', optionList: "Gold's^Silver" }), { value: 'Silver' });

    expect(html).toBe(
      '<select name="extTier" id="extTier" data-label="extTier" data-required="false">' +
        '<option value="Gold&apos;s">Gold\'s</option><option value="Silver" selected="selected">Silver</option></select>',
    );
  });

  it('renders a RadioGroup with the stored option checked', () => {
    const attr = attribute({ name: 'extOptIn', type: 'RadioGroup', optionList: 'yes^no', optionLabelList: 'Yes^No' });

    expect(rendered(attr, { value: 'no' })).toBe(
      '<label class="radio inline"><input type="radio" id="extOptIn" name="extOptIn" value="yes" /> Yes</label> ' +
        '<label class="radio inline"><input type="radio" id="extOptIn" name="extOptIn" value="no" checked="checked" /> No</label> ',
    );
  });

  it.each<[string, string]>([
    ['SelectBox', 'SelectBox'],
    ['RadioGroup', 'RadioGroup'],
  ])('fails as listGetAt does when a %s label list is shorter than its options', (_label, type) => {
    const attr = attribute({ name: 'extShort', type, optionList: 'a^b', optionLabelList: 'A' });

    expect(() => rendered(attr, { value: 'a' })).toThrow(new RangeError('Invalid list index 2 of list A'));
  });

  it.each<[string, Partial<ExtendAttributeDefinition>, ExtendValue]>([
    ['an option list', { type: 'SelectBox', optionList: 'a^[mura]renderList()[/mura]' }, 'a'],
    ['a label list', { type: 'RadioGroup', optionList: 'a', optionLabelList: '[m]label()[/m]' }, 'a'],
    ['the default value', { type: 'TextBox', defaultValue: '[MURA]now()[/MURA]' }, 'useMuraDefault'],
  ])('fails closed when %s holds a [mura] tag', (_label, attr, value) => {
    const render = (): string => rendered(attribute({ name: 'extDynamic', type: 'TextBox', ...attr }), { value });

    expect(render).toThrow(LegacyServiceUnavailableError);
    expect(render).toThrow(expect.objectContaining({ surface: 'admin', reason: 'extended-attribute-mura-tag' }));
  });

  it('renders the default value in place of useMuraDefault, and a read-only value bare', () => {
    const attr = attribute({ name: 'extPlan', type: 'TextBox', defaultValue: 'Basic' });

    expect(rendered(attr)).toContain('value="Basic"');
    expect(rendered(attr, { readonly: true })).toBe('Basic');
    expect(rendered(attr, { value: new Date(2026, 5, 30, 14, 5), readonly: true })).toBe("{ts '2026-06-30 14:05:00'}");
    expect(rendered(attr, { value: '<b>raw</b>', readonly: true })).toBe('<b>raw</b>');
  });

  it('renders a File attribute without a bean as a plain file input', () => {
    const attr = attribute({ name: 'extCv', type: 'File', required: 'true', validation: 'Regex', regex: 'pdf$', message: 'PDF only' });

    expect(rendered(attr)).toBe(
      '<input type="file" name="extCv" id="extCv" data-label="extCv" value="" data-required="true" data-validate="Regex" ' +
        'data-regex="pdf$" data-message="PDF only"/>',
    );
  });

  it('renders nothing for a type renderAttribute has no case for', () => {
    expect(rendered(attribute({ name: 'extOdd', type: 'Checkbox' }), { value: 'x' })).toBe('');
  });
});

describe('renderExtendAttribute cf_datetimeselector', () => {
  const when = attribute({ name: 'extWhen', type: 'TextBox', validation: 'datetime', required: 'true', message: 'When?' });
  const dayParts = adminS2Request(ACTION);
  const noDayParts = adminS2Request({ ...ACTION, session: { locale: 'de_DE' } });

  it('prints the tag as the legacy server does for an empty value', () => {
    const html = rendered(attribute({ name: 'publishDate', type: 'TextBox', validation: 'datetime' }), {
      value: '',
      context: renderContext(dayParts),
    });
    const start = html.indexOf('<input type="text" autocomplete="off"');
    const end = html.indexOf('</script>', start) + '</script>'.length;

    expect(html.slice(start, end)).toBe(legacy('cusers-extend-datetimeselector-empty'));
  });

  it('renders the date field, the 12-hour selects with PM, the hidden value and the change script', () => {
    const value = new Date(2026, 5, 30, 14, 5);

    const html = rendered(when, { value, context: renderContext(dayParts) });

    expect(html).toContain(
      '<input type="text" autocomplete="off" class="datepicker span3 mura-datepickerextWhen" value="06/181/2026" ' +
        'maxlength="12" id="mura-datepicker-extWhen"/>',
    );
    expect(html).toContain('<select id="mura-extWhenHour" class="time mura-datepickerextWhen" name="">');
    expect(html).toContain('<option value="2" selected>2</option>');
    expect(html).toContain('<option value="5" selected>05</option>');
    expect(html).toContain('<option value="AM">AM</option><option value="PM" selected>PM</option>');
    expect(html).toContain(
      `<input type="hidden" id="mura-extWhen" name="extWhen" value="${encodeHtmlAttr("{ts '2026-06-30 14:05:00'}")}" ` +
        'data-required="true" data-required="When&#x3f;"/>',
    );
    expect(html).toContain("$('.mura-datepickerextWhen').change(\n\t\t\tfunction(){\n\t\t\t\tparseDateTimeSelector('extWhen');");
  });

  it('fails as LSDateFormat does on text that is no date', () => {
    expect(() => rendered(when, { value: 'soon', context: renderContext(dayParts) })).toThrow('soon');
  });

  it.each<[string, ExtendValue, string, boolean]>([
    ['midnight as 12 AM', new Date(2026, 5, 30, 0, 30), '12', false],
    ['noon as 12 PM', new Date(2026, 5, 30, 12, 0), '12', true],
    ['an empty value as 12 AM', '', '12', false],
  ])('shows %s under a locale with day parts', (_label, value, hour, pm) => {
    const html = rendered(when, { value, context: renderContext(dayParts) });

    expect(html).toContain(`<option value="${hour}" selected>${hour}</option>`);
    expect(html).toContain(`<option value="PM" ${pm ? 'selected' : ''}>PM</option>`);
  });

  it('shows the 24-hour selects without a day part under a locale without day parts', () => {
    const html = rendered(when, { value: new Date(2026, 5, 30, 14, 5), context: renderContext(noDayParts) });

    expect(html).toContain('<select  id="mura-extWhenHour" class="time mura-datepickerextWhen" name="">');
    expect(html).toContain('<option value="0" >0</option>');
    expect(html).toContain('<option value="14" selected>14</option>');
    expect(html).not.toContain('DayPart');
  });

  it('clears a date more than 50 years ahead from the date field and hidden value, keeping its time', () => {
    const html = rendered(when, { value: new Date(2077, 5, 30, 18, 45), context: renderContext(dayParts) });

    expect(html).toContain('maxlength="12" id="mura-datepicker-extWhen"');
    expect(html).toContain('value="" maxlength="12"');
    expect(html).toContain('<input type="hidden" id="mura-extWhen" name="extWhen" value="" ');
    expect(html).toContain('<option value="6" selected>6</option>');
    expect(html).toContain('<option value="45" selected>45</option>');
  });
});

describe('renderExtendAttribute cf_fileselector and cf_filetools', () => {
  const photo = attribute({ attributeID: 9050, name: 'extPhoto', type: 'File', label: 'Photo "ID"', required: 'true' });

  it('renders the selector tabs and inputs of a File attribute without a stored file', () => {
    const html = rendered(photo, { bean: subject({}) });

    expect(html).toContain(
      '<div data-name="extPhoto" data-property="extPhoto" data-fileid="useMuraDefault" data-filetype="File" ' +
        'data-contentid="" data-siteid="default" class="mura-file-selector ">',
    );
    expect(html).toContain(
      '<input name="extPhoto" type="file" class="mura-file-selector-extPhoto"\n\t\t\t\t\t\t' +
        'data-label="Photo&#x20;&quot;ID&quot;" data-label="true"',
    );
    expect(html).toContain('data-label="Photo &quot;ID&quot;" data-label="true" data-validate="" data-regex="" data-message="">');
    expect(html).toContain('placeholder="http://www.domain.com/yourfile.zip"');
    expect(html).not.toContain('mura-control justify');
  });

  it('names the Image file type for a fileid attribute', () => {
    expect(rendered(attribute({ name: 'FileID', type: 'File' }), { bean: subject({}) })).toContain('data-filetype="Image"');
  });

  it.each<[string, string, boolean]>([
    ['a croppable JPG', 'JPG', true],
    ['a PNG', 'png', true],
    ['an SVG, which is not croppable', 'svg', false],
  ])('shows the image tools of %s', (_label, ext, crop) => {
    const bean = subject({ extPhoto: FILE_ID }, { extPhoto: fileMeta(`photo.${ext}`, ext) });

    const html = rendered(photo, { bean, compactDisplay: 'true now', size: 'small' });

    expect(html).toMatch(CACHE_ID);
    expect(html).toContain(`<img id="assocImage" src="/sites/default/cache/file/${FILE_ID}_small.${ext}?cacheID=`);
    expect(html.includes(`muraAction=cArch.imagedetails&userid=${USER_ID}&siteid=default&fileid=${FILE_ID}&compactDisplay=true%20now"`)).toBe(crop);
    expect(html).toContain(`/index.cfm/_api/render/file/?fileid=${FILE_ID}&method=attachment&size=source`);
    expect(html).toContain('<input type="checkbox" name="extDelete9050" value="1" class="deleteFileBox"/>');
    expect(html).not.toContain('mi-file-text-o');
  });

  // filetools.cfm prints compactDisplay through URLEncodedFormat, which leaves only ASCII letters and digits bare.
  it.each<[string, string]>([
    ['.-*_', '%2E%2D%2A%5F'],
    ['a b&c', 'a%20b%26c'],
  ])('URL-encodes compactDisplay %j on the crop link as URLEncodedFormat does', (compactDisplay, encoded) => {
    const bean = subject({ extPhoto: FILE_ID }, { extPhoto: fileMeta('photo.jpg', 'jpg') });

    const html = rendered(photo, { bean, compactDisplay });

    expect(html).toContain(
      `<a class="btn" href="./?muraAction=cArch.imagedetails&userid=${USER_ID}&siteid=default&fileid=${FILE_ID}` +
        `&compactDisplay=${encoded}"><i class="mi-crop"></i></a>`,
    );
  });

  it("shows a document's file name and the bean's file extension class instead of an image", () => {
    const bean = subject({ extPhoto: FILE_ID, fileExt: 'PDF' }, { extPhoto: fileMeta('cv & "notes".pdf', 'pdf') });

    const html = rendered(photo, { bean });

    expect(html).toContain('<div class="mura-file pdf">');
    expect(html).toContain('<i class="mi-file-text-o mi-2x"></i> cv &amp; &quot;notes&quot;.pdf');
    expect(html).not.toContain('assocImage');
    expect(html).toContain('<input type="checkbox" name="extDelete9050"');
  });

  it('omits the document block for a fileid attribute', () => {
    const bean = subject({ fileid: FILE_ID }, { fileid: fileMeta('cv.pdf', 'pdf') });

    const html = rendered(attribute({ attributeID: 9051, name: 'fileid', type: 'File' }), { bean });

    expect(html).not.toContain('mura-file ');
    expect(html).toContain(`?fileid=${FILE_ID}&method=attachment&size=source`);
  });
});

describe('legacyJsonEncode', () => {
  it.each<[string, LegacyJsonValue, string]>([
    ['a number', 7, '7'],
    ['a fraction', 2.5, '2.5'],
    ['numeric text, bare', '0042', '0042'],
    ['text through JSStringFormat', 'say "hi"\n\t\'x\'\\', '"say \\"hi\\"\\n\\t\\\'x\\\'\\\\"'],
    ['an array', [1, 'a', []], '[1,"a",[]]'],
    ['an empty struct', {}, '{}'],
    ['a struct, keys lower-cased in order', { Basic: 'b', Extended: { Nested: 'n' } }, '{"basic":"b","extended":{"nested":"n"}}'],
  ])('encodes %s', (_label, value, json) => {
    expect(legacyJsonEncode(value)).toBe(json);
  });
});
