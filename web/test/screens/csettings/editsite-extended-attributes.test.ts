import * as cheerio from 'cheerio';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import { renderExtendedAttributesTab } from '@/screens/csettings/editsite/extended-attributes';
import type { EditSiteModel, ExtendAttributeView, ExtendSetView } from '@/screens/csettings/editsite/model';

// Expected markup is the legacy server's output for the same definitions and values (ACF 2023, en_US and de_DE).
const T = (n: number): string => '\t'.repeat(n);
const IMG = 'C33EXT01-0000-0000-00000000000000F1';
const PDF = 'C33EXT01-0000-0000-00000000000000F2';
const SET_ID = 'C33EXT01-0000-0000-0000000000000003';

type AttributeInput = Partial<ExtendAttributeView> & Pick<ExtendAttributeView, 'name' | 'label' | 'type'>;

function attr(a: AttributeInput): ExtendAttributeView {
  return {
    attributeID: 90001,
    hint: '',
    validation: '',
    regex: '',
    message: '',
    required: 'false',
    defaultValue: '',
    optionList: '',
    optionLabelList: '',
    value: 'useMuraDefault',
    fileExt: '',
    ...a,
  };
}

function extendSet(attributes: readonly ExtendAttributeView[], over: Partial<ExtendSetView> = {}): ExtendSetView {
  return { extendSetID: SET_ID, categoryID: 'CAT1,CAT2', name: 'Second', style: '', attributes, ...over };
}

function model(extendSets: readonly ExtendSetView[], over: Partial<EditSiteModel> = {}): EditSiteModel {
  let cacheIds = 0;
  return {
    bean: { siteID: 'default' },
    extendSets,
    dateKeyFormat: 'MM/DD/YYYY',
    locale: 'en_US',
    localeHasDayParts: true,
    now: new Date(2026, 10, 11, 9, 0, 0),
    newCacheId: () => `CACHE-${(cacheIds += 1)}`,
    ...over,
  } as unknown as EditSiteModel;
}

const render = (attributes: readonly ExtendAttributeView[], over: Partial<EditSiteModel> = {}): string =>
  toString(renderExtendedAttributesTab(model([extendSet(attributes)], over)));

const LABEL_OPEN = `\n${T(7)}<div class="mura-control-group">\n${T(9)}<label>`;
const LABEL_CLOSE = `\n${T(8)}</label>\n${T(9)}\n${T(9)}`;
const GROUP_CLOSE = `\n${T(8)}</div>\n${T(6)}`;

/** The label content and control markup of the only attribute group in `out`. */
function group(out: string): { label: string; control: string } {
  const start = out.indexOf(LABEL_OPEN) + LABEL_OPEN.length;
  const labelEnd = out.indexOf(LABEL_CLOSE, start);
  const controlEnd = out.lastIndexOf(GROUP_CLOSE);
  return { label: out.slice(start, labelEnd), control: out.slice(labelEnd + LABEL_CLOSE.length, controlEnd) };
}

/** A TextBox control as legacy leaves it: blank line, the markup at depth 7, blank line, depth 6. */
const textBlock = (markup: string): string => `\n\n${T(7)}${markup}\n\n${T(6)}`;

let savedContext: string | undefined;
beforeEach(() => {
  savedContext = process.env.MURA_CONTEXT;
  delete process.env.MURA_CONTEXT;
  resetLegacySettingsForTests();
});
afterEach(() => {
  if (savedContext === undefined) delete process.env.MURA_CONTEXT;
  else process.env.MURA_CONTEXT = savedContext;
  resetLegacySettingsForTests();
});

// The legacy server ran in UTC with its clock at the model's `now`.
const systemZone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T09:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
  if (systemZone === undefined) delete process.env.TZ;
  else process.env.TZ = systemZone;
});

describe('csettings.editsite extended attributes tab', () => {
  it('renders nothing without extend sets', () => {
    expect(toString(renderExtendedAttributesTab(model([])))).toBe('');
  });

  it('pane, set wrapper and control group frame', () => {
    const out = render([attr({ name: 'set2Text', label: 'Set Two', type: 'TextBox', value: 'two' })]);
    const control = textBlock(
      '<input type="text" name="set2Text" class="text" id="set2Text" data-label="Set Two" value="two" data-required="false" />',
    );
    expect(out).toBe(
      [
        `\n${T(4)}<div id="tabExtendedAttributes" class="tab-pane">`,
        `\n${T(3)}<div class="block block-bordered">`,
        `\n${T(4)}<!-- block header -->`,
        `\n${T(3)}  <div class="block-header">`,
        `\n${T(5)}<h3 class="block-title">Extended Attributes</h3>`,
        `\n${T(3)}  </div>`,
        `\n${T(3)}  <!-- /block header -->`,
        `\n${T(3)}  <div class="block-content">${T(5)}`,
        `\n${T(6)}<span class="extendset" extendsetid="${SET_ID}" categoryid="CAT1,CAT2" >`,
        `\n${T(5)}<input name="extendSetID" type="hidden" value="${SET_ID}"/>`,
        `\n${T(5)}<div class="block block-bordered">`,
        `\n${T(7)}<h2>Second</h2>\n${T(7)}`,
        `${LABEL_OPEN}\n${T(9)}Set Two ${LABEL_CLOSE}${control}${GROUP_CLOSE}`,
        `\n${T(6)}</div>`,
        `\n${T(5)}</span>\n${T(5)}`,
        `\n${T(3)}</div> \n${T(2)}</div> \n${T(1)}</div> \n${T(2)}`,
      ].join(''),
    );
  });

  it('sets follow each other with their raw name and style', () => {
    const first = extendSet([], { extendSetID: 'S1', categoryID: '', name: 'Site <Options> & More' });
    const second = extendSet([], { extendSetID: 'S2', style: 'style="display:none;"' });
    const out = toString(renderExtendedAttributesTab(model([first, second])));
    expect(out).toContain('<h2>Site <Options> & More</h2>');
    expect(out).toContain(`</span>\n${T(5)}\n${T(6)}<span class="extendset" extendsetid="S2" categoryid="CAT1,CAT2" style="display:none;">`);
    const $ = cheerio.load(out);
    expect($('span.extendset').map((_, el) => $(el).attr('extendsetid')).get()).toEqual(['S1', 'S2']);
    expect($('input[name=extendSetID]').map((_, el) => $(el).attr('value')).get()).toEqual(['S1', 'S2']);
  });

  it.each<[string, AttributeInput, string]>([
    [
      'TextBox',
      { name: 'tbPlain', label: 'Plain <Text>', type: 'TextBox', value: 'Hello <World> & "q"' },
      textBlock(
        '<input type="text" name="tbPlain" class="text" id="tbPlain" data-label="Plain &lt;Text&gt;" value="Hello &lt;World&gt; &amp; &quot;q&quot;" data-required="false" />',
      ),
    ],
    [
      'TextBox date in the session date mask',
      { name: 'tbDate', label: 'Date Field', type: 'TextBox', validation: 'Date', message: 'Enter a date', value: "{ts '2026-11-30 00:00:00'}" },
      textBlock(
        '<input type="text" name="tbDate" class="text datepicker" id="tbDate" data-label="Date Field" value="11/334/2026" data-required="false" data-validate="Date" data-message="Enter a date" />',
      ),
    ],
    [
      'TextBox date beyond 50 years',
      { name: 'tbDateFar', label: 'Date Far', type: 'TextBox', validation: 'date', value: "{ts '2099-12-31 00:00:00'}" },
      textBlock(
        '<input type="text" name="tbDateFar" class="text datepicker" id="tbDateFar" data-label="Date Far" value="12/365/2099" data-required="false" data-validate="date" />',
      ),
    ],
    [
      'TextBox Regex',
      { name: 'tbRegex', label: 'Regex', type: 'TextBox', required: 'true', validation: 'Regex', regex: '^[a-z]+$', message: 'lower only', value: 'abc' },
      textBlock(
        '<input type="text" name="tbRegex" class="text" id="tbRegex" data-label="Regex" value="abc" data-required="true" data-validate="Regex" data-regex="^[a-z]+$" data-message="lower only" />',
      ),
    ],
    [
      'TextBox color',
      { name: 'tbColor', label: 'Colour', type: 'TextBox', validation: 'Color', message: 'Pick one', value: '#ff0000' },
      [
        `\n\n${T(7)}<div class="input-group mura-colorpicker">`,
        `\n${T(8)}<span class="input-group-addon"><i class="mura-colorpicker-swatch" style="background-color:#ff0000"></i></span>`,
        `\n${T(8)}<input type="text" id="tbColor" name="tbColor" placeholder="Select Color" autocomplete="off"  value="#ff0000" data-label="Colour" data-required="false" data-message="Pick one">`,
        `\n${T(7)}</div>\n\n${T(6)}`,
      ].join(''),
    ],
    [
      'TextBox color from its default',
      { name: 'tbColorDefault', label: 'Color Default', type: 'TextBox', validation: 'color', defaultValue: '<red>' },
      [
        `\n\n${T(7)}<div class="input-group mura-colorpicker">`,
        `\n${T(8)}<span class="input-group-addon"><i class="mura-colorpicker-swatch" style="background-color:&lt;red&gt;"></i></span>`,
        `\n${T(8)}<input type="text" id="tbColorDefault" name="tbColorDefault" placeholder="Select Color" autocomplete="off"  value="&lt;red&gt;" data-label="Color Default" data-required="false">`,
        `\n${T(7)}</div>\n\n${T(6)}`,
      ].join(''),
    ],
    [
      'Hidden edited as a TextBox from its default',
      { name: 'hiddenOne', label: 'Hidden One', type: 'Hidden', defaultValue: 'hidden <default>' },
      textBlock(
        '<input type="text" name="hiddenOne" class="text" id="hiddenOne" data-label="Hidden One" value="hidden &lt;default&gt;" data-required="false" />',
      ),
    ],
    [
      'TextArea',
      { name: 'taPlain', label: 'Area', type: 'TextArea', value: 'line1 <b>x</b>' },
      '<textarea name="taPlain" id="taPlain" data-label="Area" data-required="false">line1 &lt;b&gt;x&lt;/b&gt;</textarea>',
    ],
    [
      'HTMLEditor',
      { name: 'htmlEd', label: 'Html', type: 'HTMLEditor', validation: 'Numeric', value: '<p>Hi</p>' },
      '<textarea name="htmlEd" id="htmlEd" data-label="Html" data-required="false" class="htmlEditor" data-validate="Numeric">&lt;p&gt;Hi&lt;/p&gt;</textarea>',
    ],
    [
      'lower-case textarea type',
      { name: 'taLower', label: 'Ta Lower', type: 'textarea' as ExtendAttributeView['type'], validation: 'Regex', regex: '^x$', message: 'm', value: 'hello & bye' },
      '<textarea name="taLower" id="taLower" data-label="Ta Lower" data-required="false" data-message="m" data-validate="Regex" data-regex="^x$">hello &amp; bye</textarea>',
    ],
    [
      'lower-case htmleditor type from its default',
      { name: 'htmlLower', label: 'Html Lower', type: 'htmleditor' as ExtendAttributeView['type'], defaultValue: 'dflt' },
      '<textarea name="htmlLower" id="htmlLower" data-label="Html Lower" data-required="false" class="htmlEditor">dflt</textarea>',
    ],
    [
      'SelectBox with labels',
      { name: 'selOne', label: 'Select', type: 'SelectBox', optionList: 'a^b^c&d', optionLabelList: 'Alpha^Beta^<Gamma>', value: 'b' },
      '<select name="selOne" id="selOne" data-label="Select" data-required="false"><option value="a">Alpha</option><option value="b" selected="selected">Beta</option><option value="c&amp;d"><Gamma></option></select>',
    ],
    [
      'SelectBox matched through a comma list',
      { name: 'selComma', label: 'Sel Comma', type: 'SelectBox', optionList: 'c^d^a,b', value: 'q,c' },
      '<select name="selComma" id="selComma" data-label="Sel Comma" data-required="false"><option value="c" selected="selected">c</option><option value="d">d</option><option value="a,b">a,b</option></select>',
    ],
    [
      'MultiSelectBox with an empty list element',
      { name: 'selMulti', label: 'Multi', type: 'MultiSelectBox', optionList: 'x^^y^z', value: 'x^z' },
      '<input type="hidden" name="selMulti" value="" /><select name="selMulti" id="selMulti" data-label="Multi" data-required="false" multiple="multiple"><option value="x" selected="selected">x</option><option value="y">y</option><option value="z" selected="selected">z</option></select>',
    ],
    [
      'MultiSelectBox list matches are textual',
      { name: 'selNum', label: 'Sel Num', type: 'MultiSelectBox', optionList: '01^2^3', optionLabelList: 'One^Two^Three', value: '1^3' },
      '<input type="hidden" name="selNum" value="" /><select name="selNum" id="selNum" data-label="Sel Num" data-required="false" multiple="multiple"><option value="01">One</option><option value="2">Two</option><option value="3" selected="selected">Three</option></select>',
    ],
    [
      'RadioGroup with labels',
      { name: 'radioG', label: 'Radio', type: 'RadioGroup', required: 'true', message: 'pick', optionList: '1^2^3', optionLabelList: 'One^Two^Three', value: '2' },
      '<label class="radio inline"><input type="radio" id="radioG" name="radioG" value="1" /> One</label> <label class="radio inline"><input type="radio" id="radioG" name="radioG" value="2" checked="checked" /> Two</label> <label class="radio inline"><input type="radio" id="radioG" name="radioG" value="3" /> Three</label> ',
    ],
    [
      'RadioGroup from its default',
      { name: 'radioNoLabels', label: 'Radio Plain', type: 'RadioGroup', optionList: 'a^b', defaultValue: 'b' },
      '<label class="radio inline"><input type="radio" id="radioNoLabels" name="radioNoLabels" value="a" /> a</label> <label class="radio inline"><input type="radio" id="radioNoLabels" name="radioNoLabels" value="b" checked="checked" /> b</label> ',
    ],
    [
      'File with a stored value',
      { name: 'fileImg', label: 'Image File', type: 'File', value: IMG, fileExt: 'PNG' },
      '<input type="file" name="fileImg" id="fileImg" data-label="Image File" value="" data-required="false"/>',
    ],
    [
      'File with Regex validation',
      { name: 'fileNone', label: 'Empty File', type: 'File', required: 'true', validation: 'Regex', regex: '\\.pdf$', message: 'pdf only' },
      '<input type="file" name="fileNone" id="fileNone" data-label="Empty File" value="" data-required="true" data-validate="Regex" data-regex="\\.pdf$" data-message="pdf only"/>',
    ],
    ['unknown type', { name: 'bogus', label: 'Bogus', type: 'Bogus' as ExtendAttributeView['type'] }, ''],
  ])('control: %s', (_title, input, expected) => {
    expect(group(render([attr(input)])).control).toBe(expected);
  });

  const hintHead = (content: string, title: string, label: string): string =>
    [
      `\n${T(9)}\n${T(10)}<span data-toggle="popover" title="" data-placement="right"`,
      `\n${T(9)}  \tdata-content="${content}"`,
      `\n${T(9)}  \tdata-original-title="${title}">`,
      `\n${T(9)}  \t${label} <i class="mi-question-circle"></i></span>\n${T(11)}`,
    ].join('');
  const preview = (n: number): string =>
    `\n${T(11)}<a href="./index.cfm?muraAction=cArch.imagedetails&siteid=default&fileid=${IMG}"><img id="assocImage" src="/index.cfm/_api/render/small/?fileid=${IMG}&cacheID=CACHE-${n}" /></a>\n${T(10)}`;
  const fileTools = (fileId: string): string =>
    [
      `\n${T(11)}<a href="/index.cfm/_api/render/file/?fileID=${fileId}" target="_blank">[Download]</a>`,
      `\n${T(11)}<input type="checkbox" value="true" name="extDelete90011"/>`,
      `\n${T(11)}Delete\n${T(10)}`,
    ].join('');

  it.each<[string, AttributeInput, string]>([
    ['bare label', { name: 'a', label: 'Date Field', type: 'TextBox' }, `\n${T(9)}Date Field `],
    [
      'hint popover',
      { name: 'a', label: 'Plain <Text>', hint: 'Hint "quoted" & <b>bold</b>', type: 'TextBox' },
      hintHead(
        'Hint&#x20;&quot;quoted&quot;&#x20;&amp;&#x20;&lt;b&gt;bold&lt;&#x2f;b&gt;',
        'Plain&#x20;&lt;Text&gt;',
        'Plain <Text>',
      ),
    ],
    [
      'image file with hint',
      { name: 'a', label: 'Image File', hint: 'an image', type: 'File', value: IMG, fileExt: 'PNG', attributeID: 90011 },
      hintHead('an&#x20;image', 'Image&#x20;File', 'Image File') + preview(1) + fileTools(IMG),
    ],
    [
      'image file without hint',
      { name: 'a', label: 'Img No Hint', type: 'File', value: IMG, fileExt: 'jpeg', attributeID: 90011 },
      `\n${T(9)}Img No Hint ${preview(1)}${fileTools(IMG)}`,
    ],
    [
      'other file without hint',
      { name: 'a', label: 'Pdf File', type: 'File', value: PDF, fileExt: 'pdf', attributeID: 90011 },
      `\n${T(9)}Pdf File ${fileTools(PDF)}`,
    ],
    [
      'other file with hint',
      { name: 'a', label: 'Pdf Hint', hint: 'pdf hint', type: 'File', value: PDF, fileExt: 'pdf', attributeID: 90011 },
      hintHead('pdf&#x20;hint', 'Pdf&#x20;Hint', 'Pdf Hint') + fileTools(PDF),
    ],
    ['file without a stored value', { name: 'a', label: 'Empty File', type: 'File', fileExt: 'png' }, `\n${T(9)}Empty File `],
    ['file with an empty value', { name: 'a', label: 'Empty File', type: 'File', value: '', fileExt: 'png' }, `\n${T(9)}Empty File `],
  ])('label: %s', (_title, input, expected) => {
    expect(group(render([attr(input)])).label).toBe(expected);
  });

  it('file links use the context, URL-encoded ids and one cache id per preview', () => {
    process.env.MURA_CONTEXT = '/ctx';
    resetLegacySettingsForTests();
    const issued: string[] = [];
    const out = render(
      [
        attr({ name: 'f', label: 'F', type: 'File', value: 'a b&c', fileExt: 'jpg' }),
        attr({ name: 'g', label: 'G', type: 'File', value: 'doc', fileExt: 'pdf' }),
      ],
      { newCacheId: () => `ID${issued.push('x')}` },
    );
    const $ = cheerio.load(out);
    expect($('img#assocImage').attr('src')).toBe('/ctx/index.cfm/_api/render/small/?fileid=a+b%26c&cacheID=ID1');
    expect($('a[target=_blank]').map((_, el) => $(el).attr('href')).get()).toEqual([
      '/ctx/index.cfm/_api/render/file/?fileID=a+b%26c',
      '/ctx/index.cfm/_api/render/file/?fileID=doc',
    ]);
    expect(issued).toHaveLength(1);
  });

  it('ACF XMLFormat and HTMLEditFormat forms', () => {
    const out = render([
      attr({ name: 't', label: "Ün'\r&", type: 'TextArea', message: 'é"', value: "a'\r\n/é<" }),
      attr({ name: 'r', label: 'R', type: 'RadioGroup', optionList: "o'ÿ^p", value: "o'ÿ" }),
    ]);
    expect(out).toContain(
      `<textarea name="t" id="t" data-label="&#xdc;n&apos;&amp;" data-required="false" data-message="&#xe9;&quot;">a'\n/é&lt;</textarea>`,
    );
    expect(out).toContain(`value="o&apos;&#xff;" checked="checked" /> o'ÿ</label> `);
  });

  it('a label list shorter than the options fails as listGetAt does', () => {
    const select = attr({ name: 's', label: 'S', type: 'SelectBox', optionList: 'a^b', optionLabelList: 'A' });
    expect(() => render([select])).toThrow(RangeError);
  });

  it.each<[string, string, string, Partial<ExtendAttributeView>, string]>([
    ['a US string', 'en_US', 'MM/DD/YYYY', { value: '06/30/2026' }, '06/181/2026'],
    ['a day-first string in the session locale', 'en_GB', 'DD/MM/YYYY', { value: '01/06/2026' }, '152/06/2026'],
    ['a German long date', 'de_DE', 'DD.MM.YYYY', { value: '30. Juni 2026' }, '181.06.2026'],
    ['a French month name', 'fr_FR', 'DD/MM/YYYY', { value: '30 juin 2026' }, '181/06/2026'],
    ['a long date-time with a Java zone name', 'en_US', 'MM/DD/YYYY', { value: 'June 30, 2026 at 11:30:00 PM EST' }, '07/182/2026'],
    ['a number as a date serial', 'en_US', 'MM/DD/YYYY', { value: '2026' }, '07/199/1905'],
    ['a blank value', 'en_US', 'MM/DD/YYYY', { value: '  ' }, ''],
    ['the default value', 'de_DE', 'DD.MM.YYYY', { value: 'useMuraDefault', defaultValue: '30.06.2026' }, '181.06.2026'],
  ])('TextBox date shows %s as LSDateFormat does', (_title, locale, mask, input, shown) => {
    const tb = attr({ name: 'tbDate', label: 'Date Field', type: 'TextBox', validation: 'date', ...input });
    expect(group(render([tb], { dateKeyFormat: mask, locale })).control).toBe(
      textBlock(
        `<input type="text" name="tbDate" class="text datepicker" id="tbDate" data-label="Date Field" value="${shown}" data-required="false" data-validate="date" />`,
      ),
    );
  });

  it('TextBox date fails as LSDateFormat does on an unreadable value', () => {
    const tb = attr({ name: 'tbDate', label: 'Date Field', type: 'TextBox', validation: 'date', value: 'garbage' });
    expect(() => render([tb])).toThrow(new Error('garbage is an invalid date format.'));
  });

  describe('datetime selector', () => {
    const selects = /(<select[^>]*>).*?(<\/select>)/g;
    const skeleton = (date: string, hidden: string, dayParts: boolean): string =>
      [
        `\n<input type="text" autocomplete="off" class="datepicker span3 mura-datepickerdt" value="${date}" maxlength="12" id="mura-datepicker-dt"/> `,
        dayParts
          ? `\n\t\t<select id="mura-dtHour" class="time mura-datepickerdt" name="">…</select>`
          : `\n\t\t<select  id="mura-dtHour" class="time mura-datepickerdt" name="">…</select>`,
        `\n\t\n\n\t<select id="mura-dtMinute" class="time mura-datepickerdt" name="">…</select>\n\n\t\n`,
        dayParts ? `\t\t<select id="mura-dtDayPart" class="time mura-datepickerdt" name="">…</select>\n\t\n` : '',
        `<input type="hidden" id="mura-dt" name="dt" value="${hidden}" data-required="true" data-required="Bad&#x20;&quot;date&quot;"/>`,
        `\n<script>\n\t$(function(){\n\t\t$('.mura-datepickerdt').change(\n\t\t\tfunction(){\n\t\t\t\tparseDateTimeSelector('dt');\n\t\t\t}\n\t\t);\n\t});\n</script>\n`,
      ].join('');
    const stamp = '&#x7b;ts&#x20;&#x27;2026-11-30&#x20;14&#x3a;05&#x3a;00&#x27;&#x7d;';

    it.each<[string, string, boolean, string, string, string, string, string, string, string | undefined, number]>([
      ['afternoon with day parts', "{ts '2026-11-30 14:05:00'}", true, 'MM/DD/YYYY', 'en_US', '11/334/2026', stamp, '2', '5', 'PM', 12],
      ['midnight hour is 12 AM', "{ts '2026-01-02 00:07:00'}", true, 'MM/DD/YYYY', 'en_US', '01/02/2026', '&#x7b;ts&#x20;&#x27;2026-01-02&#x20;00&#x3a;07&#x3a;00&#x27;&#x7d;', '12', '7', undefined, 12],
      ['beyond 50 years blanks the date but keeps the time', "{ts '2099-06-01 23:45:00'}", true, 'MM/DD/YYYY', 'en_US', '', '', '11', '45', 'PM', 12],
      ['empty value', '', true, 'MM/DD/YYYY', 'en_US', '', '', '12', '0', undefined, 12],
      ['ISO value', '2026-11-30T12:30', true, 'MM/DD/YYYY', 'en_US', '11/334/2026', '2026-11-30T12&#x3a;30', '12', '30', 'PM', 12],
      ['without day parts', "{ts '2026-11-30 14:05:00'}", false, 'DD.MM.YYYY', 'de_DE', '334.11.2026', stamp, '14', '5', undefined, 24],
      ['US string with a time', '06/30/2026 2:05 PM', true, 'MM/DD/YYYY', 'en_US', '06/181/2026', '06&#x2f;30&#x2f;2026&#x20;2&#x3a;05&#x20;PM', '2', '5', 'PM', 12],
      ['day-first string read in the session locale', '01/06/2026 09:30', false, 'DD/MM/YYYY', 'en_GB', '152/06/2026', '01&#x2f;06&#x2f;2026&#x20;09&#x3a;30', '9', '30', undefined, 24],
      ['German string with a time', '30.06.2026 14:05', false, 'DD.MM.YYYY', 'de_DE', '181.06.2026', '30.06.2026&#x20;14&#x3a;05', '14', '5', undefined, 24],
      ['number as a date serial', '2026', true, 'MM/DD/YYYY', 'en_US', '07/199/1905', '2026', '12', '0', undefined, 12],
      ['legacy string beyond 50 years', '12/31/2099', true, 'MM/DD/YYYY', 'en_US', '', '', '12', '0', undefined, 12],
      ['legacy string just inside 50 years', '11/10/2077', true, 'MM/DD/YYYY', 'en_US', '11/314/2077', '11&#x2f;10&#x2f;2077', '12', '0', undefined, 12],
      ['blank value kept in the hidden field', '  ', true, 'MM/DD/YYYY', 'en_US', '', '&#x20;&#x20;', '12', '0', undefined, 12],
    ])('%s', (_title, value, dayParts, mask, locale, date, hidden, hour, minute, dayPart, hourCount) => {
      const dt = attr({ name: 'dt', label: 'Date Time', type: 'TextBox', required: 'true', validation: 'DateTime', message: 'Bad "date"', value });
      const control = group(render([dt], { dateKeyFormat: mask, locale, localeHasDayParts: dayParts })).control;
      expect(control.replace(selects, '$1…$2')).toBe(skeleton(date, hidden, dayParts));
      const $ = cheerio.load(control);
      expect($('#mura-dtHour option').length).toBe(hourCount);
      expect($('#mura-dtHour option[selected]').map((_, el) => $(el).attr('value')).get()).toEqual([hour]);
      expect($('#mura-dtMinute option[selected]').map((_, el) => $(el).attr('value')).get()).toEqual([minute]);
      expect($('#mura-dtMinute option').first().text()).toBe('00');
      expect($('#mura-dtDayPart option[selected]').attr('value')).toBe(dayPart);
    });

    it.each([
      ['an unreadable value', 'en_US', 'MM/DD/YYYY', 'garbage', 'garbage is an invalid date format.'],
      ['a locale date that hour() cannot read', 'de_DE', 'DD.MM.YYYY', '30. Juni 2026', '30. Juni 2026 is an invalid date or time string.'],
      ['a locale date hour() rejects outright', 'fr_FR', 'DD/MM/YYYY', 'lundi 1 décembre 2031', 'The value lundi 1 décembre 2031 cannot be converted to a date.'],
    ])('fails as legacy does on %s', (_title, locale, mask, value, message) => {
      const dt = attr({ name: 'dt', label: 'Date Time', type: 'TextBox', validation: 'datetime', value });
      expect(() => render([dt], { dateKeyFormat: mask, locale, localeHasDayParts: false })).toThrow(new Error(message));
    });

    it('option markup and encoded names', () => {
      const dt = attr({ name: "d'x", label: 'D', type: 'TextBox', validation: 'datetime', value: "{ts '2026-11-30 14:05:00'}" });
      const control = group(render([dt])).control;
      expect(control).toContain('<option value="1" >1</option><option value="2" selected>2</option>');
      expect(control).toContain('<option value="4" >04</option><option value="5" selected>05</option>');
      expect(control).toContain('<option value="AM">AM</option><option value="PM" selected>PM</option>');
      expect(control).toContain('id="mura-d&#x27;xHour" class="time mura-datepickerd&#x27;x" name=""');
      expect(control).toContain('name="d&#x27;x"');
      expect(control).toContain("parseDateTimeSelector('d\\x27x');");
    });
  });
});
