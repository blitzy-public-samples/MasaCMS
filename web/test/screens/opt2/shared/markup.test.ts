import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, raw, toString, type SafeHtml } from '@/lib/html';
import {
  actionButton,
  alertBox,
  block,
  controlGroup,
  formActions,
  gridTable,
  hiddenField,
  hiddenFields,
  pageHeader,
  postForm,
  select,
  textarea,
  textInput,
  type GridCell,
} from '@/screens/opt2/shared/markup';

type Case = [string, SafeHtml, string];

const CSRF = raw('<input type="hidden" name="csrf_token" value="t">');
const CSRF_MARKUP = '<input type="hidden" name="csrf_token" value="t">';
const SUBMIT = '<div class="mura-actions"><div class="form-actions"><button class="btn mura-primary" type="submit">Save</button>';

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

describe('markup', () => {
  it('returns SafeHtml', () => {
    expect(isSafeHtml(pageHeader('x'))).toBe(true);
    expect(isSafeHtml(gridTable([], [], 'x'))).toBe(true);
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
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
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
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
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
          `<button class="btn" type="submit">Back</button>${CSRF_MARKUP}</div></div>`,
      ],
      ['an empty bar for no buttons', formActions([]), '<div class="mura-actions"><div class="form-actions"></div></div>'],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('postForm', () => {
    it.each<Case>([
      [
        'a form1 POST with one primary submit',
        postForm('a/b?x=1', raw('<p>f</p>'), 'Save'),
        `<form novalidate="novalidate" action="a&#x2f;b&#x3f;x&#x3d;1" method="post" name="form1"><p>f</p>${SUBMIT}</div></div></form>`,
      ],
      [
        'a multipart form carrying hidden fields',
        postForm('save', raw('<p>f</p>'), 'Save', { multipart: true, hidden: CSRF }),
        '<form novalidate="novalidate" action="save" method="post" enctype="multipart/form-data" name="form1"><p>f</p>' +
          `${SUBMIT}${CSRF_MARKUP}</div></div></form>`,
      ],
      [
        'no enctype when multipart is false',
        postForm('save', raw(''), 'Save', { multipart: false }),
        `<form novalidate="novalidate" action="save" method="post" name="form1">${SUBMIT}</div></div></form>`,
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });

  describe('actionButton', () => {
    it.each<Case>([
      ['a bare one-button form', actionButton('Go', 'go'), '<form method="post" action="go"><button class="btn" type="submit">Go</button></form>'],
      [
        'hidden fields then extra markup before the button',
        actionButton('A&B', 'approve', { id: '7', step: '2' }, CSRF),
        '<form method="post" action="approve"><input type="hidden" name="id" value="7"><input type="hidden" name="step" value="2">' +
          `${CSRF_MARKUP}<button class="btn" type="submit">A&amp;B</button></form>`,
      ],
    ])('renders %s', (_, markup, expected) => {
      expect(toString(markup)).toBe(expected);
    });
  });
});
