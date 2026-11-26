// Escape-by-default markup primitives and the ESAPI 2.5 encoders behind legacy `esapiEncode` (server-only).

/** Markup this module vouches for; only `html`, `raw`, `join` and `attr` create one, and it is frozen. */
class SafeHtml {
  readonly #markup: string;

  constructor(markup: string) {
    this.#markup = markup;
    Object.freeze(this);
  }

  /** The markup string. */
  get value(): string {
    return this.#markup;
  }

  /** The markup string, so `String(h)` and template literals yield the markup. */
  toString(): string {
    return this.#markup;
  }

  /** The markup string, so `JSON.stringify` embeds the markup rather than `{}`. */
  toJSON(): string {
    return this.#markup;
  }

  /** Brand check on the private field, which no object outside this module can carry. */
  static has(v: unknown): v is SafeHtml {
    return typeof v === 'object' && v !== null && #markup in v;
  }
}

export type { SafeHtml };

/**
 * Interpolation value of {@link html}: markup is kept, strings and numbers are HTML-encoded, `null`, `undefined` and
 * booleans render nothing, arrays render each element in order.
 */
export type HtmlValue = SafeHtml | string | number | bigint | boolean | null | undefined | readonly HtmlValue[];

/** True only for markup created by this module; a plain string never passes. */
export function isSafeHtml(v: unknown): v is SafeHtml {
  return SafeHtml.has(v);
}

function renderValue(value: HtmlValue): string {
  if (isSafeHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return encodeHtml(String(value));
}

/** Tagged template: literal parts are kept as written, interpolations follow {@link HtmlValue}. */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) out += renderValue(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

/** Wraps trusted markup (verbatim legacy inline scripts, already-encoded fragments) without encoding it. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Concatenates `items` with `separator`; strings are HTML-encoded, markup is kept. */
export function join(items: Iterable<SafeHtml | string>, separator: SafeHtml | string = ''): SafeHtml {
  return new SafeHtml(Array.from(items, renderValue).join(renderValue(separator)));
}

/** ` name="value"` with the value HTML-attribute-encoded, ` name` for `true`, nothing for `false`/`null`/`undefined`. */
export function attr(name: string, value: string | number | boolean | null | undefined): SafeHtml {
  if (value === true) return new SafeHtml(` ${name}`);
  if (value === false || value === null || value === undefined) return new SafeHtml('');
  return new SafeHtml(` ${name}="${encodeHtmlAttr(String(value))}"`);
}

/** The markup string of `h`, for response bodies. */
export function toString(h: SafeHtml): string {
  return h.value;
}

const IMMUNE_HTML: ReadonlySet<number> = new Set([0x2c, 0x2e, 0x2d, 0x5f, 0x20]);
const IMMUNE_HTML_ATTR: ReadonlySet<number> = new Set([0x2c, 0x2e, 0x2d, 0x5f]);
const IMMUNE_JAVASCRIPT: ReadonlySet<number> = new Set([0x2c, 0x2e, 0x5f]);

/** Entity names of ESAPI `HTMLEntityCodec` by code point. */
const ENTITY_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
  [0x22, 'quot'], [0x26, 'amp'], [0x3c, 'lt'], [0x3e, 'gt'], [0xa0, 'nbsp'], [0xa1, 'iexcl'], [0xa2, 'cent'],
  [0xa3, 'pound'], [0xa4, 'curren'], [0xa5, 'yen'], [0xa6, 'brvbar'], [0xa7, 'sect'], [0xa8, 'uml'], [0xa9, 'copy'],
  [0xaa, 'ordf'], [0xab, 'laquo'], [0xac, 'not'], [0xad, 'shy'], [0xae, 'reg'], [0xaf, 'macr'], [0xb0, 'deg'],
  [0xb1, 'plusmn'], [0xb2, 'sup2'], [0xb3, 'sup3'], [0xb4, 'acute'], [0xb5, 'micro'], [0xb6, 'para'], [0xb7, 'middot'],
  [0xb8, 'cedil'], [0xb9, 'sup1'], [0xba, 'ordm'], [0xbb, 'raquo'], [0xbc, 'frac14'], [0xbd, 'frac12'],
  [0xbe, 'frac34'], [0xbf, 'iquest'], [0xc0, 'Agrave'], [0xc1, 'Aacute'], [0xc2, 'Acirc'], [0xc3, 'Atilde'],
  [0xc4, 'Auml'], [0xc5, 'Aring'], [0xc6, 'AElig'], [0xc7, 'Ccedil'], [0xc8, 'Egrave'], [0xc9, 'Eacute'],
  [0xca, 'Ecirc'], [0xcb, 'Euml'], [0xcc, 'Igrave'], [0xcd, 'Iacute'], [0xce, 'Icirc'], [0xcf, 'Iuml'], [0xd0, 'ETH'],
  [0xd1, 'Ntilde'], [0xd2, 'Ograve'], [0xd3, 'Oacute'], [0xd4, 'Ocirc'], [0xd5, 'Otilde'], [0xd6, 'Ouml'],
  [0xd7, 'times'], [0xd8, 'Oslash'], [0xd9, 'Ugrave'], [0xda, 'Uacute'], [0xdb, 'Ucirc'], [0xdc, 'Uuml'],
  [0xdd, 'Yacute'], [0xde, 'THORN'], [0xdf, 'szlig'], [0xe0, 'agrave'], [0xe1, 'aacute'], [0xe2, 'acirc'],
  [0xe3, 'atilde'], [0xe4, 'auml'], [0xe5, 'aring'], [0xe6, 'aelig'], [0xe7, 'ccedil'], [0xe8, 'egrave'],
  [0xe9, 'eacute'], [0xea, 'ecirc'], [0xeb, 'euml'], [0xec, 'igrave'], [0xed, 'iacute'], [0xee, 'icirc'],
  [0xef, 'iuml'], [0xf0, 'eth'], [0xf1, 'ntilde'], [0xf2, 'ograve'], [0xf3, 'oacute'], [0xf4, 'ocirc'],
  [0xf5, 'otilde'], [0xf6, 'ouml'], [0xf7, 'divide'], [0xf8, 'oslash'], [0xf9, 'ugrave'], [0xfa, 'uacute'],
  [0xfb, 'ucirc'], [0xfc, 'uuml'], [0xfd, 'yacute'], [0xfe, 'thorn'], [0xff, 'yuml'], [0x152, 'OElig'],
  [0x153, 'oelig'], [0x160, 'Scaron'], [0x161, 'scaron'], [0x178, 'Yuml'], [0x192, 'fnof'], [0x2c6, 'circ'],
  [0x2dc, 'tilde'], [0x391, 'Alpha'], [0x392, 'Beta'], [0x393, 'Gamma'], [0x394, 'Delta'], [0x395, 'Epsilon'],
  [0x396, 'Zeta'], [0x397, 'Eta'], [0x398, 'Theta'], [0x399, 'Iota'], [0x39a, 'Kappa'], [0x39b, 'Lambda'],
  [0x39c, 'Mu'], [0x39d, 'Nu'], [0x39e, 'Xi'], [0x39f, 'Omicron'], [0x3a0, 'Pi'], [0x3a1, 'Rho'], [0x3a3, 'Sigma'],
  [0x3a4, 'Tau'], [0x3a5, 'Upsilon'], [0x3a6, 'Phi'], [0x3a7, 'Chi'], [0x3a8, 'Psi'], [0x3a9, 'Omega'],
  [0x3b1, 'alpha'], [0x3b2, 'beta'], [0x3b3, 'gamma'], [0x3b4, 'delta'], [0x3b5, 'epsilon'], [0x3b6, 'zeta'],
  [0x3b7, 'eta'], [0x3b8, 'theta'], [0x3b9, 'iota'], [0x3ba, 'kappa'], [0x3bb, 'lambda'], [0x3bc, 'mu'], [0x3bd, 'nu'],
  [0x3be, 'xi'], [0x3bf, 'omicron'], [0x3c0, 'pi'], [0x3c1, 'rho'], [0x3c2, 'sigmaf'], [0x3c3, 'sigma'],
  [0x3c4, 'tau'], [0x3c5, 'upsilon'], [0x3c6, 'phi'], [0x3c7, 'chi'], [0x3c8, 'psi'], [0x3c9, 'omega'],
  [0x3d1, 'thetasym'], [0x3d2, 'upsih'], [0x3d6, 'piv'], [0x2002, 'ensp'], [0x2003, 'emsp'], [0x2009, 'thinsp'],
  [0x200c, 'zwnj'], [0x200d, 'zwj'], [0x200e, 'lrm'], [0x200f, 'rlm'], [0x2013, 'ndash'], [0x2014, 'mdash'],
  [0x2018, 'lsquo'], [0x2019, 'rsquo'], [0x201a, 'sbquo'], [0x201c, 'ldquo'], [0x201d, 'rdquo'], [0x201e, 'bdquo'],
  [0x2020, 'dagger'], [0x2021, 'Dagger'], [0x2022, 'bull'], [0x2026, 'hellip'], [0x2030, 'permil'], [0x2032, 'prime'],
  [0x2033, 'Prime'], [0x2039, 'lsaquo'], [0x203a, 'rsaquo'], [0x203e, 'oline'], [0x2044, 'frasl'], [0x20ac, 'euro'],
  [0x2111, 'image'], [0x2118, 'weierp'], [0x211c, 'real'], [0x2122, 'trade'], [0x2135, 'alefsym'], [0x2190, 'larr'],
  [0x2191, 'uarr'], [0x2192, 'rarr'], [0x2193, 'darr'], [0x2194, 'harr'], [0x21b5, 'crarr'], [0x21d0, 'lArr'],
  [0x21d1, 'uArr'], [0x21d2, 'rArr'], [0x21d3, 'dArr'], [0x21d4, 'hArr'], [0x2200, 'forall'], [0x2202, 'part'],
  [0x2203, 'exist'], [0x2205, 'empty'], [0x2207, 'nabla'], [0x2208, 'isin'], [0x2209, 'notin'], [0x220b, 'ni'],
  [0x220f, 'prod'], [0x2211, 'sum'], [0x2212, 'minus'], [0x2217, 'lowast'], [0x221a, 'radic'], [0x221d, 'prop'],
  [0x221e, 'infin'], [0x2220, 'ang'], [0x2227, 'and'], [0x2228, 'or'], [0x2229, 'cap'], [0x222a, 'cup'],
  [0x222b, 'int'], [0x2234, 'there4'], [0x223c, 'sim'], [0x2245, 'cong'], [0x2248, 'asymp'], [0x2260, 'ne'],
  [0x2261, 'equiv'], [0x2264, 'le'], [0x2265, 'ge'], [0x2282, 'sub'], [0x2283, 'sup'], [0x2284, 'nsub'],
  [0x2286, 'sube'], [0x2287, 'supe'], [0x2295, 'oplus'], [0x2297, 'otimes'], [0x22a5, 'perp'], [0x22c5, 'sdot'],
  [0x2308, 'lceil'], [0x2309, 'rceil'], [0x230a, 'lfloor'], [0x230b, 'rfloor'], [0x2329, 'lang'], [0x232a, 'rang'],
  [0x25ca, 'loz'], [0x2660, 'spades'], [0x2663, 'clubs'], [0x2665, 'hearts'], [0x2666, 'diams'],
]);

function isAsciiAlphanumeric(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/** C0 controls other than tab, LF and CR, plus DEL and C1 controls, which ESAPI replaces with U+FFFD. */
function isUnprintable(cp: number): boolean {
  return (cp <= 0x1f && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

/** ESAPI 2.5 `HTMLEntityCodec.encode(immune, s)`, one code point at a time. */
function encodeEntities(s: string, immune: ReadonlySet<number>): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    // ESAPI tests immunity on the code point cast to one UTF-16 unit, so e.g. U+10020 passes wherever space is immune.
    if (immune.has(cp & 0xffff) || isAsciiAlphanumeric(cp)) {
      out += ch;
    } else if (isUnprintable(cp)) {
      out += '&#xfffd;';
    } else {
      const name = ENTITY_NAMES.get(cp);
      out += name === undefined ? `&#x${cp.toString(16)};` : `&${name};`;
    }
  }
  return out;
}

/** `esapiEncode('html', s)`: immune `,` `.` `-` `_` and space; `null`/`undefined` give `''`. */
export function encodeHtml(s: string | null | undefined): string {
  return s == null ? '' : encodeEntities(s, IMMUNE_HTML);
}

/** `esapiEncode('html_attr', s)`: immune `,` `.` `-` `_`; `null`/`undefined` give `''`. */
export function encodeHtmlAttr(s: string | null | undefined): string {
  return s == null ? '' : encodeEntities(s, IMMUNE_HTML_ATTR);
}

/**
 * `esapiEncode('javascript', s)`: immune `,` `.` `_`; other BMP non-alphanumerics as `\xHH` below 256, else `\uHHHH`;
 * `null`/`undefined` give `''`.
 */
export function encodeJs(s: string | null | undefined): string {
  if (s == null) return '';
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    // Supplementary code points pass through unencoded, as ESAPI 2.5's JavaScriptCodec emits them; escaping their
    // UTF-16 units would change legacy output.
    if (cp > 0xffff || IMMUNE_JAVASCRIPT.has(cp) || isAsciiAlphanumeric(cp)) {
      out += ch;
    } else if (cp < 0x100) {
      out += `\\x${cp.toString(16).toUpperCase().padStart(2, '0')}`;
    } else {
      out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return out;
}

/** `esapiEncode('url', s)`, provided by the platform as `esapiUrlEncode` and aliased `encodeUrl`. */
export { esapiUrlEncode, esapiUrlEncode as encodeUrl } from '@opt2/platform/legacy-compat';
