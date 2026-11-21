// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { encodeHtml, isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import {
  actionButton,
  alertBox,
  block,
  controlGroup,
  detailList,
  formActions,
  GUARDED_NATIVE_SUBMIT,
  GUARDED_SUBMIT,
  gridTable,
  hiddenField,
  hiddenFields,
  pageHeader,
  postForm,
  rowActionsMenu,
  select,
  submitButton,
  textarea,
  textInput,
  valueRows,
  wrappable,
  type GridCell,
  type Label,
} from '@/screens/opt2/shared/markup';

type Case = [string, SafeHtml, string];

const CSRF = raw('<input type="hidden" name="csrf_token" value="t">');
const CSRF_MARKUP = '<input type="hidden" name="csrf_token" value="t">';
const SUBMIT = '<div class="form-actions"><button class="btn mura-primary" type="submit">Save</button>';
const ONSUBMIT = ` onsubmit="return document.getElementById('action-modal') === null ? submitForm(this) : false;"`;

const ROWS: GridCell[][] = [
  ['A&B', 3],
  [raw('<a href="x">y</a>'), null],
  [undefined, 0],
];
const CELLS = [
  ['A&amp;B', '3'],
  ['<a href="x">y</a>', ''],
  ['', '0'],
];

/** Grid markup of ROWS under Name/Count with the variable width on `varWidth`. */
function grid(varWidth: number): string {
  const width = (column: number): string => (column === varWidth ? ' class="var-width"' : '');
  const head = ['Name', 'Count'].map((header, c) => `<th${width(c)}>${header}</th>`).join('');
  const body = CELLS.map((row) => `<tr>${row.map((cell, c) => `<td${width(c)}>${cell}</td>`).join('')}</tr>`).join('');
  return `<table class="mura-table-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed & done' },
];

/** A bundle value carrying an HTML entity, as `de` holds `user.prev`. */
const BUNDLE_LABEL = 'Zur&uuml;ck';

describe('markup', () => {
  it('returns SafeHtml', () => {
    expect(isSafeHtml(pageHeader('x'))).toBe(true);
    expect(isSafeHtml(gridTable([], [], 'x'))).toBe(true);
  });

  it.each<[string, (label: Label) => SafeHtml, (label: string) => string]>([
    ['the pageHeader title', (label) => pageHeader(label), (l) => `<div class="mura-header"><h1>${l}</h1></div>`],
    [
      'a header link',
      (label) => pageHeader('T', [{ label, href: 'h' }]),
      (l) => `<div class="mura-header"><h1>T</h1><div class="nav-module-specific btn-group"><a class="btn" href="h">${l}</a></div></div>`,
    ],
    [
      'a gridTable header',
      (label) => gridTable([label], [['x']], 'none'),
      (l) =>
        `<table class="mura-table-grid"><thead><tr><th class="var-width">${l}</th></tr></thead>` +
        '<tbody><tr><td class="var-width">x</td></tr></tbody></table>',
    ],
    ['the gridTable empty message', (label) => gridTable(['N'], [], label), (l) => `<div class="help-block-empty">${l}</div>`],
    ['the detailList empty message', (label) => detailList([], label), (l) => `<div class="help-block-empty">${l}</div>`],
    [
      'a controlGroup label',
      (label) => controlGroup(label, raw('<input>')),
      (l) => `<div class="mura-control-group"><label>${l}</label><input></div>`,
    ],
    [
      'a valueRows label',
      (label) => valueRows([[label, 'v']]),
      (l) => `<dl><dt>${l}</dt><dd>v</dd></dl>`,
    ],
    [
      'a select option',
      (label) => select('s', [{ value: 'v', label }]),
      (l) => `<select name="s" id="s"><option value="v">${l}</option></select>`,
    ],
    [
      'a formActions button',
      (label) => formActions([{ label }]),
      (l) => `<div class="form-actions"><button class="btn" type="submit">${l}</button></div>`,
    ],
    [
      'a submitButton label',
      (label) => submitButton({ label }),
      (l) => `<button class="btn" type="submit">${l}</button>`,
    ],
    [
      'the postForm submit label',
      (label) => postForm('a', raw(''), label),
      (l) =>
        `<form novalidate="novalidate" action="a" method="post" name="form1"${ONSUBMIT}><div class="form-actions">` +
        `<button class="btn mura-primary" type="submit">${l}</button></div></form>`,
    ],
    [
      'the actionButton label',
      (label) => actionButton(label, 'go'),
      (l) => `<form method="post" action="go"${ONSUBMIT}><button class="btn" type="submit">${l}</button></form>`,
    ],
  ])('keeps a SafeHtml label and encodes a string label in %s', (_, render, expected) => {
    expect(toString(render(raw(BUNDLE_LABEL)))).toBe(expected(BUNDLE_LABEL));
    expect(toString(render(BUNDLE_LABEL))).toBe(expected('Zur&amp;uuml&#x3b;ck'));
  });

  describe('pageHeader', () => {
    it.each<Case>([
      ['the title alone without links', pageHeader('R&D'), '<div class="mura-header"><h1>R&amp;D</h1></div>'],
      [
        'links as a button group',
        pageHeader('Records', [
          { label: 'New', href: 'new' },
          { label: 'A<B', href: 'a b' },
        ]),
        '<div class="mura-header"><h1>Records</h1><div class="nav-module-specific btn-group">' +
          '<a class="btn" href="new">New</a><a class="btn" href="a&#x20;b">A&lt;B</a></div></div>',
      ],
      [
        'the active link as the legacy current button',
        pageHeader('Sends', [
          { label: 'Templates', href: 't', active: false },
          { label: 'Sends', href: 's', active: true },
        ]),
        '<div class="mura-header"><h1>Sends</h1><div class="nav-module-specific btn-group">' +
          '<a class="btn" href="t">Templates</a><a class="btn active" href="s">Sends</a></div></div>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('block', () => {
    it('wraps content in the constrained bordered block', () => {
      expect(toString(block(raw('<p>x</p>')))).toBe(
        '<div class="block block-constrain"><div class="block block-bordered"><div class="block-content"><p>x</p></div></div></div>',
      );
    });
  });

  describe('gridTable', () => {
    it.each<Case>([
      ['the empty message for no rows', gridTable(['Name'], [], 'None <yet>'), '<div class="help-block-empty">None &lt;yet&gt;</div>'],
      ['column 0 variable-width by default', gridTable(['Name', 'Count'], ROWS, 'none'), grid(0)],
      ['column 1 variable-width', gridTable(['Name', 'Count'], ROWS, 'none', { varWidthColumn: 1 }), grid(1)],
      ['no column variable-width out of range', gridTable(['Name', 'Count'], ROWS, 'none', { varWidthColumn: 5 }), grid(5)],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });

    it.each<[string, { varWidthColumn?: number; columnClasses?: ReadonlyArray<string | undefined> }, readonly string[]]>([
      ['no column classes', { columnClasses: [] }, [' class="var-width"', '']],
      ['a class on a fixed-width column', { columnClasses: [undefined, 'hidden-xs'] }, [' class="var-width"', ' class="hidden-xs"']],
      ['classes after var-width', { columnClasses: ['hidden-xs hidden-sm'] }, [' class="var-width hidden-xs hidden-sm"', '']],
      ['an empty class as none', { varWidthColumn: 1, columnClasses: ['', ''] }, ['', ' class="var-width"']],
      ['an encoded class value', { varWidthColumn: 5, columnClasses: ['a"b'] }, [' class="a&quot;b"', '']],
      ['classes past the last column ignored', { columnClasses: [undefined, undefined, 'hidden-xs'] }, [' class="var-width"', '']],
    ])('applies %s to the header and every cell of each column', (_, opts, attrs) => {
      const head = ['Name', 'Count'].map((header, c) => `<th${attrs[c]}>${header}</th>`).join('');
      const body = CELLS.map((row) => `<tr>${row.map((cell, c) => `<td${attrs[c]}>${cell}</td>`).join('')}</tr>`).join('');

      expect(toString(gridTable(['Name', 'Count'], ROWS, 'none', opts))).toBe(
        `<table class="mura-table-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
    });
  });

  describe('rowActionsMenu', () => {
    const SYNC_ALL =
      `jQuery('a.show-actions[aria-expanded]').each(function () {` +
      ` this.setAttribute('aria-expanded', String(!jQuery(this).next('.actions-menu').hasClass('hide'))); });`;
    const toggle = (name: string): string =>
      `<a class="show-actions" href="javascript:;" role="button" aria-expanded="false" aria-label="${name}"` +
      ` onclick="var toggle = this, open = !jQuery(this).next('.actions-menu').hasClass('hide'); setTimeout(function () {` +
      ` if (open) jQuery(toggle).next('.actions-menu').addClass('hide'); else showTableControls(toggle); ${SYNC_ALL}` +
      ` jQuery(document).off('click.opt2RowActions').on('click.opt2RowActions', function () {` +
      ` setTimeout(function () { ${SYNC_ALL} }, 0); }); }, 0);"` +
      ` onkeydown="if (event.key === ' ') { event.preventDefault(); if (!event.repeat) this.click(); }">` +
      '<i class="mi-ellipsis-v" aria-hidden="true"></i></a>';
    const EMPTY_MENU = '<div class="actions-menu hide"><ul class="actions-list"></ul></div>';

    it.each<Case>([
      [
        'the toggle and a hidden menu of icon links, labels and hrefs encoded',
        rowActionsMenu(
          [
            { label: 'Edit', href: 'e?id=1', icon: 'mi-pencil' },
            { label: raw('<b>A</b>'), href: 'a', icon: 'mi-calendar' },
            { label: 'A<B', href: 'b', icon: 'x"y' },
          ],
          'Actions',
        ),
        `${toggle('Actions')}<div class="actions-menu hide"><ul class="actions-list">` +
          '<li><a href="e&#x3f;id&#x3d;1"><i class="mi-pencil" aria-hidden="true"></i>Edit</a></li>' +
          '<li><a href="a"><i class="mi-calendar" aria-hidden="true"></i><b>A</b></a></li>' +
          '<li><a href="b"><i class="x&quot;y" aria-hidden="true"></i>A&lt;B</a></li></ul></div>',
      ],
      ['the toggle and an empty menu for no actions', rowActionsMenu([], 'Actions'), `${toggle('Actions')}${EMPTY_MENU}`],
      ['a bundle label as the toggle name', rowActionsMenu([], raw('Aktionen')), `${toggle('Aktionen')}${EMPTY_MENU}`],
      ['a string toggle name attribute-encoded', rowActionsMenu([], 'A"<B'), `${toggle('A&quot;&lt;B')}${EMPTY_MENU}`],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('detailList', () => {
    it.each<Case>([
      ['the empty message for no items', detailList([], 'None <yet>'), '<div class="help-block-empty">None &lt;yet&gt;</div>'],
      ['one item without a rule', detailList([raw('<p>a</p>')], 'none'), '<p>a</p>'],
      ['a rule between items', detailList([raw('<p>a</p>'), raw('<p>b</p>'), raw('<p>c</p>')], 'none'), '<p>a</p><hr><p>b</p><hr><p>c</p>'],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('alertBox', () => {
    it.each<Case>([
      ['an encoded error by default', alertBox('<b>'), '<div class="alert alert-error"><span>&lt;b&gt;</span></div>'],
      ['an error', alertBox(raw('<b>x</b>'), 'error'), '<div class="alert alert-error"><span><b>x</b></span></div>'],
      ['a warning', alertBox(raw('<b>x</b>'), 'warning'), '<div class="alert alert-warning"><span><b>x</b></span></div>'],
      ['an info', alertBox(raw('<b>x</b>'), 'info'), '<div class="alert alert-info"><span><b>x</b></span></div>'],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('controlGroup', () => {
    it('labels the control', () => {
      expect(toString(controlGroup('A&B', raw('<input>')))).toBe(
        '<div class="mura-control-group"><label>A&amp;B</label><input></div>',
      );
    });

    it.each<[string, SafeHtml, string | undefined, string, string]>([
      ['a text input', textInput('name'), undefined, 'input', 'name'],
      ['a select', select('status', OPTIONS), undefined, 'select', 'status'],
      ['a textarea', textarea('notes'), undefined, 'textarea', 'notes'],
      ['a text input with an explicit id', textInput('name', '', { id: 'person-name' }), undefined, 'input', 'person-name'],
      ['a select with an explicit id', select('status', OPTIONS, 'open', { id: 'sheet-status' }), undefined, 'select', 'sheet-status'],
      ['a textarea with an explicit id', textarea('notes', '', 6, { id: 'day-notes' }), undefined, 'textarea', 'day-notes'],
      ['a read-only textarea', textarea('answer', 'x', 6, { id: 'answer-1', readonly: true }), undefined, 'textarea', 'answer-1'],
      ['foreign markup passed with its id', raw('<input type="checkbox" id="agree" name="agree">'), 'agree', 'input', 'agree'],
    ])('targets the id of %s from its label', (_, control, controlId, tag, id) => {
      const $ = cheerio.load(toString(controlGroup('Label', control, controlId)));
      const label = $('div.mura-control-group > label');
      const field = $(`div.mura-control-group > ${tag}`);
      expect(field.attr('id')).toBe(id);
      expect(label.attr('for')).toBe(id);
      expect(field.prev().get(0)).toBe(label.get(0));
    });

    it.each<Case>([
      [
        'a text input',
        controlGroup('Name', textInput('n', '', { id: 'a"b' })),
        '<div class="mura-control-group"><label for="a&quot;b">Name</label><input name="n" id="a&quot;b" type="text" value=""></div>',
      ],
      [
        'a select',
        controlGroup('Name', select('n', [], undefined, { id: 'a"b' })),
        '<div class="mura-control-group"><label for="a&quot;b">Name</label><select name="n" id="a&quot;b"></select></div>',
      ],
      [
        'a textarea',
        controlGroup('Name', textarea('n', '', 6, { id: 'a"b' })),
        '<div class="mura-control-group"><label for="a&quot;b">Name</label><textarea name="n" id="a&quot;b" rows="6"></textarea></div>',
      ],
    ])('attribute-encodes an explicit id of %s on label and control', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });

    it.each<Case>([
      [
        'a refused control: has-error, its message after the label, described and focused',
        controlGroup('Amount', textInput('amount', 'abc', { error: { message: 'Enter <a> number.', focus: true } })),
        '<div class="mura-control-group has-error"><label for="amount">Amount</label>' +
          '<p class="help-block" id="amount-error">Enter &lt;a&gt; number.</p>' +
          '<input name="amount" id="amount" type="text" value="abc" aria-invalid="true" aria-describedby="amount-error" autofocus></div>',
      ],
      [
        'a refused control that is not the first, unfocused, with its hint after it',
        controlGroup(
          'Signer',
          textInput('signer', 'x', { id: 'sig', error: { message: 'Bad.', focus: false }, hint: raw('<b>Pool</b> user') }),
        ),
        '<div class="mura-control-group has-error"><label for="sig">Signer</label><p class="help-block" id="sig-error">Bad.</p>' +
          '<input name="signer" id="sig" type="text" value="x" aria-invalid="true" aria-describedby="sig-error&#x20;sig-hint">' +
          '<div class="help-block-inline" id="sig-hint"><b>Pool</b> user</div></div>',
      ],
      [
        'a control with a standing hint only',
        controlGroup('Amount', textInput('amount', '1', { hint: 'Up to 4 decimals.' })),
        '<div class="mura-control-group"><label for="amount">Amount</label>' +
          '<input name="amount" id="amount" type="text" value="1" aria-describedby="amount-hint">' +
          '<div class="help-block-inline" id="amount-hint">Up to 4 decimals.</div></div>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('textInput', () => {
    it.each<Case>([
      ['a default text input', textInput('title'), '<input name="title" id="title" type="text" value="">'],
      ['an encoded value', textInput('q', 'a "b"'), '<input name="q" id="q" type="text" value="a&#x20;&quot;b&quot;">'],
      [
        'maxlength and required',
        textInput('amount', '12.5', { type: 'number', maxlength: 10, required: true }),
        '<input name="amount" id="amount" type="number" value="12.5" maxlength="10" required="true">',
      ],
      [
        'a date input that is not required',
        textInput('due', '2026-10-29', { type: 'date', required: false }),
        '<input name="due" id="due" type="date" value="2026-10-29">',
      ],
      [
        'a file input without its value',
        textInput('upload', 'x.pdf', { type: 'file' }),
        '<input name="upload" id="upload" type="file">',
      ],
      [
        'an unrefused input focused, unmarked',
        textInput('title', 'Q2', { focus: true }),
        '<input name="title" id="title" type="text" value="Q2" autofocus>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });

    // validateForm writes data-label into its alert with jQuery .html(), so the attribute holds the label's markup.
    it.each<[string, Label, string, string]>([
      ['a string label, encoded', 'A&B "x" <y>', 'A&amp;B &quot;x&quot; &lt;y&gt;', 'A&B "x" <y>'],
      ['a bundle label, as written', raw(BUNDLE_LABEL), BUNDLE_LABEL, 'Zurück'],
    ])('names a required field by %s in data-label', (_, label, markup, shown) => {
      const input = cheerio.load(toString(textInput('title', '', { required: true, label })), null, false)('input');
      expect(input.attr('data-label')).toBe(markup);
      expect(cheerio.load(input.attr('data-label') ?? '', null, false).text()).toBe(shown);
    });
  });

  describe('select', () => {
    it.each<Case>([
      [
        'the selected option',
        select('status', OPTIONS, 'closed'),
        '<select name="status" id="status"><option value="open">Open</option><option value="closed" selected>Closed &amp; done</option></select>',
      ],
      [
        'no selection',
        select('status', OPTIONS),
        '<select name="status" id="status"><option value="open">Open</option><option value="closed">Closed &amp; done</option></select>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('textarea', () => {
    it.each<Case>([
      ['six empty rows by default', textarea('notes'), '<textarea name="notes" id="notes" rows="6"></textarea>'],
      ['an encoded value', textarea('notes', 'a<b', 3), '<textarea name="notes" id="notes" rows="3">a&lt;b</textarea>'],
      [
        'a read-only value',
        textarea('answer', 'a<b', 3, { readonly: true }),
        '<textarea name="answer" id="answer" rows="3" readonly>a&lt;b</textarea>',
      ],
      [
        'an editable value when readonly is false',
        textarea('notes', '', 6, { readonly: false }),
        '<textarea name="notes" id="notes" rows="6"></textarea>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('valueRows', () => {
    it.each<Case>([
      [
        'one definition list per row, the value encoded like a grid cell',
        valueRows([
          ['Document', 'a<b'],
          ['Version', 3],
          ['Hash', raw('<code>ab</code>')],
          ['Signer', null],
          ['Created By', undefined],
        ]),
        '<dl><dt>Document</dt><dd>a&lt;b</dd></dl>' +
          '<dl><dt>Version</dt><dd>3</dd></dl>' +
          '<dl><dt>Hash</dt><dd><code>ab</code></dd></dl>' +
          '<dl><dt>Signer</dt><dd></dd></dl>' +
          '<dl><dt>Created By</dt><dd></dd></dl>',
      ],
      ['nothing for no rows', valueRows([]), ''],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });

    it('parses as one term and value pair per row, a form value inside its dd, with no label', () => {
      const rows = valueRows([
        ['File Name', raw('<form><button>a.pdf</button></form>')],
        ['Size', 2],
      ]);
      const $ = cheerio.load(toString(rows), null, false);
      const pairs = $('dl')
        .toArray()
        .map((dl) => $(dl).children().toArray().map((child) => [child.tagName, $(child).text()]));

      expect($('label')).toHaveLength(0);
      expect(pairs).toEqual([
        [
          ['dt', 'File Name'],
          ['dd', 'a.pdf'],
        ],
        [
          ['dt', 'Size'],
          ['dd', '2'],
        ],
      ]);
      expect($('dd > form > button').text()).toBe('a.pdf');
    });
  });

  describe('wrappable', () => {
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    it.each<[string, readonly string[]]>([
      ['short words unchanged', ['Q3 close review']],
      ['a 255-character run broken after every 24', [...Array<string>(10).fill('A'.repeat(24)), 'A'.repeat(15)]],
      ['only the unbroken run of a spaced title', ['Q3 ' + 'B'.repeat(24), 'B'.repeat(6) + ' end']],
      ['a run of exactly 24 unchanged', ['C'.repeat(24)]],
      ['a run of 25 broken once', ['C'.repeat(24), 'C']],
      ['HTML specials encoded and counted as one each', ['<&"\'>' + 'x'.repeat(19), '<']],
      ['emoji never split', ['\u{1F600}'.repeat(24), '\u{1F600}']],
      ['a combining mark kept with its base', ['A'.repeat(24) + '\u0301', 'B']],
      ['a skin tone kept with its emoji', ['A'.repeat(23) + '\u{1F44D}\u{1F3FD}', 'C']],
      ['a ZWJ sequence kept whole', ['A'.repeat(23) + family, 'C'.repeat(5)]],
      ['a flag kept whole', ['A'.repeat(23) + '\u{1F1FA}\u{1F1F8}', 'C']],
      ['no-break spaces joining a run', ['Consulting\u00a0services\u00a0for\u00a0', 'the\u00a0quarterly']],
    ])('renders %s', (_, chunks) => {
      const text = chunks.join('');
      const markup = toString(wrappable(text));

      expect(markup).toBe(chunks.map(encodeHtml).join('<wbr>'));
      expect(cheerio.load(markup, null, false).root().text()).toBe(text);
    });
  });

  describe('hiddenField', () => {
    it('encodes name and value', () => {
      expect(toString(hiddenField('id', 'a b'))).toBe('<input type="hidden" name="id" value="a&#x20;b">');
    });
  });

  describe('hiddenFields', () => {
    it.each<Case>([
      [
        'one field per entry in order',
        hiddenFields({ b: '2', a: '1' }),
        '<input type="hidden" name="b" value="2"><input type="hidden" name="a" value="1">',
      ],
      ['nothing for no entries', hiddenFields({}), ''],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('formActions', () => {
    it.each<Case>([
      [
        'primary and named buttons followed by hidden fields',
        formActions(
          [
            { label: 'Save', primary: true },
            { label: 'Reject', name: 'action', value: 'reject' },
            { label: 'Back', primary: false },
          ],
          CSRF,
        ),
        `${SUBMIT}<button class="btn" type="submit" name="action" value="reject">Reject</button>` +
          `<button class="btn" type="submit">Back</button>${CSRF_MARKUP}</div>`,
      ],
      ['an empty row for no buttons', formActions([]), '<div class="form-actions"></div>'],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });

    it.each<[string, SafeHtml]>([
      ['formActions', formActions([{ label: 'Save', primary: true }], CSRF)],
      ['postForm', postForm('save', raw('<p>f</p>'), 'Save', { hidden: CSRF })],
    ])('keeps the %s buttons in the page flow, outside any fixed .mura-actions bar', (_, markup) => {
      const $ = cheerio.load(toString(markup), null, false);

      expect($('.mura-actions')).toHaveLength(0);
      expect($('.form-actions > button.btn.mura-primary').text()).toBe('Save');
    });
  });

  describe('submitButton', () => {
    it('renders a primary named submit posting to its own action', () => {
      expect(toString(submitButton({ label: 'A&B', primary: true, name: 'n', value: 'v', formAction: 'go?x=1' }))).toBe(
        '<button class="btn mura-primary" type="submit" name="n" value="v" formaction="go&#x3f;x&#x3d;1">A&amp;B</button>',
      );
    });
  });

  describe('postForm', () => {
    it.each<Case>([
      [
        'a form1 POST with one primary submit',
        postForm('a/b?x=1', raw('<p>f</p>'), 'Save'),
        `<form novalidate="novalidate" action="a&#x2f;b&#x3f;x&#x3d;1" method="post" name="form1"${ONSUBMIT}><p>f</p>${SUBMIT}</div></form>`,
      ],
      [
        'a multipart form carrying hidden fields',
        postForm('save', raw('<p>f</p>'), 'Save', { multipart: true, hidden: CSRF }),
        `<form novalidate="novalidate" action="save" method="post" enctype="multipart/form-data" name="form1"${ONSUBMIT}><p>f</p>` +
          `${SUBMIT}${CSRF_MARKUP}</div></form>`,
      ],
      [
        'no enctype when multipart is false',
        postForm('save', raw(''), 'Save', { multipart: false }),
        `<form novalidate="novalidate" action="save" method="post" name="form1"${ONSUBMIT}>${SUBMIT}</div></form>`,
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('actionButton', () => {
    it.each<Case>([
      [
        'a bare one-button write form',
        actionButton('Go', 'go'),
        `<form method="post" action="go"${ONSUBMIT}><button class="btn" type="submit">Go</button></form>`,
      ],
      [
        'hidden fields then extra markup before the button',
        actionButton('A&B', 'approve', { id: '7', step: '2' }, CSRF),
        `<form method="post" action="approve"${ONSUBMIT}><input type="hidden" name="id" value="7"><input type="hidden" name="step" value="2">` +
          `${CSRF_MARKUP}<button class="btn" type="submit">A&amp;B</button></form>`,
      ],
      [
        'a download form, submitted natively',
        actionButton('File', 'download', { jobId: '7' }, undefined, { download: true }),
        '<form method="post" action="download"><input type="hidden" name="jobId" value="7"><button class="btn" type="submit">File</button></form>',
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('submit guard', () => {
    /** Runs `markup`'s form `onsubmit` twice under a stub legacy submitForm; returns each result and the sends. */
    function submitTwice(markup: SafeHtml): { results: unknown[]; sent: number } {
      const onsubmit = cheerio.load(toString(markup), null, false)('form').attr('onsubmit');
      if (onsubmit === undefined) throw new TypeError('the form has no onsubmit');
      const ids = new Set<string>();
      let sent = 0;
      const document = { getElementById: (id: string) => (ids.has(id) ? {} : null) };
      const submitForm = (): boolean => {
        ids.add('action-modal');
        sent += 1;
        return false;
      };
      // An inline handler body, run with the page's globals in scope.
      const handler = new Function('document', 'submitForm', onsubmit) as (d: unknown, s: unknown) => unknown;
      const results = [handler.call({}, document, submitForm), handler.call({}, document, submitForm)];
      return { results, sent };
    }

    it.each<[string, SafeHtml]>([
      ['a postForm', postForm('save', raw('<input name="title" value="x">'), 'Save', { hidden: CSRF })],
      ['a write actionButton', actionButton('Approve', 'approve', {}, CSRF)],
      ['a form carrying GUARDED_SUBMIT', raw(`<form method="post" action="upload"${GUARDED_SUBMIT.value}></form>`)],
    ])('submits %s through legacy submitForm once while the first submission is in flight', (_, markup) => {
      expect(submitTwice(markup)).toEqual({ results: [false, false], sent: 1 });
    });

    it('submits a GUARDED_NATIVE_SUBMIT form natively once, keeping its button formaction, under legacy actionModal', () => {
      const onsubmit = cheerio.load(`<form${GUARDED_NATIVE_SUBMIT.value}></form>`, null, false)('form').attr('onsubmit');
      if (onsubmit === undefined) throw new TypeError('the form has no onsubmit');
      const ids = new Set<string>();
      const document = { getElementById: (id: string) => (ids.has(id) ? {} : null) };
      const actionModal = (): boolean => (ids.add('action-modal'), false);
      const handler = new Function('document', 'actionModal', onsubmit) as (d: unknown, a: unknown) => unknown;
      expect([handler.call({}, document, actionModal), handler.call({}, document, actionModal)]).toEqual([true, false]);
    });

    it('leaves a download actionButton to submit natively, as its answer is a file', () => {
      const form = cheerio.load(toString(actionButton('File', 'download', {}, undefined, { download: true })), null, false)(
        'form',
      );
      expect(form.attr('onsubmit')).toBeUndefined();
    });
  });
});
