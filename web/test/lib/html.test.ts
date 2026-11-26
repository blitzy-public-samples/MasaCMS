import { describe, expect, it } from 'vitest';
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import {
  attr,
  encodeHtml,
  encodeHtmlAttr,
  encodeJs,
  encodeUrl,
  html,
  isSafeHtml,
  join,
  raw,
  toString,
  type HtmlValue,
} from '@/lib/html';

/** Markup string of a one-interpolation template, bracketed so empty output stays visible. */
const render = (value: HtmlValue): string => toString(html`[${value}]`);

describe('html', () => {
  describe('html tag', () => {
    it('encodes interpolated strings', () => {
      expect(toString(html`<p>${'<b>&"x\''}</p>`)).toBe('<p>&lt;b&gt;&amp;&quot;x&#x27;</p>');
    });

    it('keeps literal parts as written', () => {
      expect(toString(html`<a href="/x?a=1&amp;b='2'">"&<"</a>`)).toBe(`<a href="/x?a=1&amp;b='2'">"&<"</a>`);
    });

    it('renders an empty template as empty markup', () => {
      expect(toString(html``)).toBe('');
    });

    it('inserts raw markup unencoded', () => {
      expect(toString(html`<p>${raw('<i>x</i>')}</p>`)).toBe('<p><i>x</i></p>');
    });

    it('inserts nested html unencoded', () => {
      expect(toString(html`<div>${html`<b>${'<'}</b>`}</div>`)).toBe('<div><b>&lt;</b></div>');
    });

    it('joins arrays without a separator, encoding string items only', () => {
      expect(toString(html`<ul>${['<a>', raw('<li>b</li>'), 'c&d']}</ul>`)).toBe('<ul>&lt;a&gt;<li>b</li>c&amp;d</ul>');
    });

    it('renders nested arrays in order', () => {
      expect(render([['x', ['<', raw('&amp;')]], null, 'y'])).toBe('[x&lt;&amp;y]');
    });

    // `true` renders nothing too: html.ts documents every boolean as empty output.
    it.each([null, undefined, false, true])('renders %s as nothing', (value) => {
      expect(render(value)).toBe('[]');
    });

    it.each<[number | bigint, string]>([
      [0, '0'],
      [-1.5, '-1.5'],
      [10n, '10'],
      [1e21, '1e&#x2b;21'],
    ])('encodes number %s as %s', (value, expected) => {
      expect(render(value)).toBe(`[${expected}]`);
    });

    it('returns SafeHtml', () => {
      expect(isSafeHtml(html`<p></p>`)).toBe(true);
    });
  });

  describe('raw', () => {
    it('wraps markup verbatim', () => {
      expect(toString(raw('<script>a&&b</script>'))).toBe('<script>a&&b</script>');
    });

    it('returns frozen markup', () => {
      expect(Object.isFrozen(raw('x'))).toBe(true);
    });
  });

  describe('SafeHtml', () => {
    it('exposes its markup as value', () => {
      expect(raw('<b>').value).toBe('<b>');
    });

    it('stringifies to its markup', () => {
      expect(String(raw('<b>'))).toBe('<b>');
      expect(`${html`<i>${'&'}</i>`}`).toBe('<i>&amp;</i>');
    });

    it('serializes to its markup in JSON', () => {
      expect(JSON.stringify({ m: raw('<b>') })).toBe('{"m":"<b>"}');
    });
  });

  describe('isSafeHtml', () => {
    it.each<[string, unknown]>([
      ['raw', raw('<i>')],
      ['html', html``],
      ['join', join([])],
      ['attr', attr('a', true)],
    ])('is true for %s results', (_, value) => {
      expect(isSafeHtml(value)).toBe(true);
    });

    it.each<[string, unknown]>([
      ['a string', '<i>'],
      ['null', null],
      ['undefined', undefined],
      ['a lookalike object', { value: '<i>', toString: () => '<i>', toJSON: () => '<i>' }],
      ['an object inheriting from markup', Object.create(raw('<i>'))],
    ])('is false for %s', (_, value) => {
      expect(isSafeHtml(value)).toBe(false);
    });
  });

  describe('toString', () => {
    it('returns the markup string', () => {
      const out = toString(html`<p>${'&'}</p>`);
      expect(typeof out).toBe('string');
      expect(out).toBe('<p>&amp;</p>');
    });
  });

  describe('join', () => {
    it('joins with an encoded string separator, encoding string items', () => {
      expect(toString(join(['<a>', raw('<b/>'), 'c'], ' & '))).toBe('&lt;a&gt; &amp; <b/> &amp; c');
    });

    it('keeps a SafeHtml separator', () => {
      expect(toString(join(['a', 'b'], raw('<br>')))).toBe('a<br>b');
    });

    it('defaults to no separator', () => {
      expect(toString(join(['<', raw('<hr>'), '>']))).toBe('&lt;<hr>&gt;');
    });

    it('accepts any iterable', () => {
      expect(toString(join(new Set(['x', '"']), ','))).toBe('x,&quot;');
    });

    it('gives empty markup for no items', () => {
      const out = join([]);
      expect(isSafeHtml(out)).toBe(true);
      expect(toString(out)).toBe('');
    });
  });

  describe('attr', () => {
    it('renders name and attribute-encoded value', () => {
      expect(toString(attr('title', 'a "b" <c>'))).toBe(' title="a&#x20;&quot;b&quot;&#x20;&lt;c&gt;"');
    });

    it('renders numbers', () => {
      expect(toString(attr('size', 3))).toBe(' size="3"');
    });

    it('renders a bare name for true', () => {
      expect(toString(attr('disabled', true))).toBe(' disabled');
    });

    it.each([false, null, undefined])('renders nothing for %s', (value) => {
      expect(toString(attr('disabled', value))).toBe('');
    });
  });

  describe('encodeHtml (esapiEncode html)', () => {
    it('keeps alphanumerics and immune , . - _ space', () => {
      expect(encodeHtml('a, b.c-d_e')).toBe('a, b.c-d_e');
      expect(encodeHtml('AZaz09')).toBe('AZaz09');
    });

    it.each([
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['&', '&amp;'],
      ['"', '&quot;'],
      ["'", '&#x27;'],
      ['/', '&#x2f;'],
      ['=', '&#x3d;'],
      ['`', '&#x60;'],
      ['é', '&eacute;'],
      ['É', '&Eacute;'],
      ['\u00a0', '&nbsp;'],
      ['€', '&euro;'],
      ['中', '&#x4e2d;'],
      ['\t', '&#x9;'],
      ['\n', '&#xa;'],
      ['\r', '&#xd;'],
      ['\u0000', '&#xfffd;'],
      ['\u001f', '&#xfffd;'],
      ['\u007f', '&#xfffd;'],
      ['\u0080', '&#xfffd;'],
      ['\u009f', '&#xfffd;'],
    ])('encodes %j as %s', (input, expected) => {
      expect(encodeHtml(input)).toBe(expected);
    });

    it('encodes a mixed string', () => {
      expect(encodeHtml('<a href="x">O\'Neil & co</a>')).toBe(
        '&lt;a href&#x3d;&quot;x&quot;&gt;O&#x27;Neil &amp; co&lt;&#x2f;a&gt;',
      );
    });

    it.each(['', null, undefined])('gives an empty string for %j', (input) => {
      expect(encodeHtml(input)).toBe('');
    });
  });

  describe('encodeHtmlAttr (esapiEncode html_attr)', () => {
    it('encodes space as &#x20;', () => {
      expect(encodeHtmlAttr('a b')).toBe('a&#x20;b');
    });

    it('keeps alphanumerics and immune , . - _', () => {
      expect(encodeHtmlAttr('a,b.c-d_e9')).toBe('a,b.c-d_e9');
    });

    it.each([
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['&', '&amp;'],
      ['"', '&quot;'],
      ["'", '&#x27;'],
      ['é', '&eacute;'],
      ['\t', '&#x9;'],
      ['\u0001', '&#xfffd;'],
    ])('encodes %j as %s', (input, expected) => {
      expect(encodeHtmlAttr(input)).toBe(expected);
    });

    it.each(['', null, undefined])('gives an empty string for %j', (input) => {
      expect(encodeHtmlAttr(input)).toBe('');
    });
  });

  describe('encodeJs (esapiEncode javascript)', () => {
    it('keeps alphanumerics and immune , . _', () => {
      expect(encodeJs('aZ09,._')).toBe('aZ09,._');
    });

    it.each([
      ["'", '\\x27'],
      ['"', '\\x22'],
      ['<', '\\x3C'],
      ['>', '\\x3E'],
      ['/', '\\x2F'],
      ['\\', '\\x5C'],
      [' ', '\\x20'],
      ['-', '\\x2D'],
      ['\n', '\\x0A'],
      ['\u0000', '\\x00'],
      ['é', '\\xE9'],
      ['\u00ff', '\\xFF'],
      ['\u0100', '\\u0100'],
      ['中', '\\u4E2D'],
      ['\u2028', '\\u2028'],
    ])('encodes %j as %s', (input, expected) => {
      expect(encodeJs(input)).toBe(expected);
    });

    it('neutralises a script break-out', () => {
      const out = encodeJs('</script><script>alert(1)</script>');
      expect(out).toBe('\\x3C\\x2Fscript\\x3E\\x3Cscript\\x3Ealert\\x281\\x29\\x3C\\x2Fscript\\x3E');
      expect(out).not.toMatch(/[<'"]/);
    });

    it.each(['', null, undefined])('gives an empty string for %j', (input) => {
      expect(encodeJs(input)).toBe('');
    });
  });

  describe('encodeUrl (esapiEncode url)', () => {
    it('is the platform esapiUrlEncode', () => {
      expect(encodeUrl).toBe(esapiUrlEncode);
    });

    it.each([
      ['a b', 'a+b'],
      ['+', '%2B'],
      ['&', '%26'],
      ['/', '%2F'],
      ['=', '%3D'],
      ['~', '%7E'],
      ['é', '%C3%A9'],
      ['中', '%E4%B8%AD'],
    ])('encodes %j as %s', (input, expected) => {
      expect(encodeUrl(input)).toBe(expected);
    });

    it('keeps unreserved a-z A-Z 0-9 . - * _', () => {
      expect(encodeUrl('azAZ09.-*_')).toBe('azAZ09.-*_');
    });
  });
});
