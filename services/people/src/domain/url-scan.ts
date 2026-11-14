// Masa's default scriptProtect scan of the url scope (core/appcfc/scriptProtect_include.cfm:5-11; core/mura/Portcullis.cfc:88-231,345-458,597-622).
import { cfIsBoolean, cfIsNumeric, javaTrim } from '@opt2/platform/legacy-compat';

/** Raised where the scan itself fails, which legacy answers with the ColdFusion error page. */
export class UrlScanError extends Error {
  override readonly name: string = 'UrlScanError';
}

/** Masa's default `scriptProtectExceptions` (configBean.cfc:161) plus the `content` Portcullis adds; the filters skip them. */
const EXCEPTION_FIELDS: ReadonlySet<string> = new Set([
  'body', 'source', 'params', 'objectlist1', 'objectlist2', 'objectlist3', 'objectlist4', 'objectlist5', 'objectlist6', 'objectlist7',
  'contenteditfield', 'content',
]);
/** Portcullis's default `tagFilter` (Portcullis.cfc:56). */
const TAG_FILTER = ['script', 'object', 'applet', 'embed', 'form', 'input', 'layer', 'ilayer', 'frame', 'iframe', 'frameset', 'param', 'meta', 'base', 'style', 'xss', 'marquee'];
/** Portcullis's default `wordFilter` as the one alternation REReplaceNoCase runs (Portcullis.cfc:57,439-458). */
const WORD_FILTER =
  /qss|onError|onEvent|onLoad|onClick|onDblClick|onKeyDown|onKeyPress|onKeyUp|onMouseDown|onMouseOut|onMouseUp|onMouseOver|onBlur|onChange|onFocus|onSelect|javascript:|vbscript:|\.cookie|\.toString|:expr|:expression|\.fromCharCode|String\./gi;
const INVALID_MARKER = '[INVALID]';
/** Scope names `isValidCFVariableName` refuses before a dot (Portcullis.cfc:604). */
const CF_SCOPE_NAMES: ReadonlySet<string> = new Set(['session', 'form', 'url', 'server', 'cgi', 'cookie', 'application', 'local']);
/** `stripMSWordFromSimpleValue`'s replaceList pairs (Portcullis.cfc:347). */
const MS_WORD: Readonly<Record<string, string>> = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2014': '--', '\u2015': '--', '\u2026': '...' };
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_SHORT_ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
const ACF_STRING_ESCAPES: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** A value of ACF `deserializeJSON`: integers in Java's long range keep their digits, other numbers are doubles. */
type CfJson =
  | { kind: 'string'; value: string }
  | { kind: 'long'; value: bigint }
  | { kind: 'double'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; items: CfJson[] }
  | { kind: 'struct'; members: Map<string, CfJson> };

/** Portcullis `isValidCFVariableName` (Portcullis.cfc:597-612). */
function isValidCfVariableName(name: string): boolean {
  if (name === '' || name.includes(' ')) return false;
  if (name.includes('.') && CF_SCOPE_NAMES.has((name.split('.').find((part) => part !== '') ?? '').toLowerCase())) return false;
  return /^[A-Za-z]/.test(name);
}

/** ACF JSON text as `deserializeJSON` reads it, or undefined where `isJSON` refuses it: leading zeros pass, a non-finite number does not. */
function parseCfJson(text: string): CfJson | undefined {
  let at = 0;
  const space = (): void => {
    while (at < text.length && text.charCodeAt(at) <= 0x20) at += 1;
  };
  const fail = (): never => {
    throw new SyntaxError(`not JSON at ${String(at)}`);
  };
  const string = (): string => {
    at += 1;
    let out = '';
    for (;;) {
      if (at >= text.length) fail();
      const ch = text.charAt(at);
      at += 1;
      if (ch === '"') return out;
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escape = text.charAt(at);
      at += 1;
      if (escape === 'u') {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail();
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else {
        out += JSON_SHORT_ESCAPES[escape] ?? fail();
      }
    }
  };
  const literal = (word: string, node: CfJson): CfJson => {
    if (!text.startsWith(word, at)) fail();
    at += word.length;
    return node;
  };
  const value = (): CfJson => {
    space();
    const ch = text.charAt(at);
    if (ch === '{') {
      at += 1;
      const members = new Map<string, CfJson>();
      space();
      if (text.charAt(at) === '}') {
        at += 1;
        return { kind: 'struct', members };
      }
      for (;;) {
        space();
        if (text.charAt(at) !== '"') fail();
        const key = string();
        space();
        if (text.charAt(at) !== ':') fail();
        at += 1;
        members.set(key, value());
        space();
        const next = text.charAt(at);
        at += 1;
        if (next === '}') return { kind: 'struct', members };
        if (next !== ',') fail();
      }
    }
    if (ch === '[') {
      at += 1;
      const items: CfJson[] = [];
      space();
      if (text.charAt(at) === ']') {
        at += 1;
        return { kind: 'array', items };
      }
      for (;;) {
        items.push(value());
        space();
        const next = text.charAt(at);
        at += 1;
        if (next === ']') return { kind: 'array', items };
        if (next !== ',') fail();
      }
    }
    if (ch === '"') return { kind: 'string', value: string() };
    if (ch === 't') return literal('true', { kind: 'boolean', value: true });
    if (ch === 'f') return literal('false', { kind: 'boolean', value: false });
    if (ch === 'n') return literal('null', { kind: 'null' });
    JSON_NUMBER.lastIndex = at;
    const token = JSON_NUMBER.exec(text)?.[0] ?? fail();
    at += token.length;
    if (!/[.eE]/.test(token)) {
      const long = BigInt(token);
      if (long >= LONG_MIN && long <= LONG_MAX) return { kind: 'long', value: long };
    }
    const double = Number(token);
    return Number.isFinite(double) ? { kind: 'double', value: double } : fail();
  };
  try {
    const parsed = value();
    space();
    return at === text.length ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Java `Double.toString` of a finite double, from its shortest round-trip digits. */
function javaDouble(n: number): string {
  if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
  const [mantissa = '', exponentText = '0'] = Math.abs(n).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exponentText);
  const sign = n < 0 ? '-' : '';
  if (Math.abs(n) >= 1e-3 && Math.abs(n) < 1e7) {
    if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
    return `${sign}${whole}.${digits.slice(exponent + 1) || '0'}`;
  }
  return `${sign}${digits.charAt(0)}.${digits.slice(1) || '0'}E${String(exponent)}`;
}

/** ACF `serializeJSON` of a deserialized value: `/` and non-ASCII raw, other C0 characters and DEL as `\u00xx`. */
function serializeCfJson(node: CfJson): string {
  switch (node.kind) {
    case 'string':
      return `"${node.value.replace(/["\\\u0000-\u001f\u007f]/g, (ch) => ACF_STRING_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
    case 'long':
      return node.value.toString();
    case 'double':
      return javaDouble(node.value);
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return `[${node.items.map(serializeCfJson).join(',')}]`;
    case 'struct':
      return `{${[...node.members].map(([key, member]) => `${serializeCfJson({ kind: 'string', value: key })}:${serializeCfJson(member)}`).join(',')}}`;
  }
}

/** `stripMSWordFromSimpleValue` (Portcullis.cfc:345-349): Word's quotes, dashes and ellipsis as ASCII, then trimmed. */
function stripMsWordText(text: string): string {
  return javaTrim(text.replace(/[\u2018\u2019\u201c\u201d\u2014\u2015\u2026]/g, (ch) => MS_WORD[ch] ?? ch));
}

/** `stripMSWord` of one deserialized array item (Portcullis.cfc:351-401): text as at the top, arrays item by item, structs untouched. */
function stripMsWordItem(node: CfJson): CfJson {
  switch (node.kind) {
    case 'string':
      return { kind: 'string', value: stripMsWord(node.value) };
    case 'null':
      // Reading an undefined array element fails the request.
      throw new UrlScanError('Element is undefined in a Java object of type class coldfusion.runtime.Array.');
    case 'array':
      return { kind: 'array', items: node.items.map(stripMsWordItem) };
    default:
      return node;
  }
}

/** `stripMSWord` of a url value (Portcullis.cfc:373-401): JSON text other than a number or boolean is read, stripped and serialized again. */
function stripMsWord(text: string): string {
  if (text === '' || cfIsNumeric(text) || cfIsBoolean(text)) return text;
  const node = text === '-' ? undefined : parseCfJson(text);
  if (node === undefined) return stripMsWordText(text);
  switch (node.kind) {
    case 'string':
      return serializeCfJson({ kind: 'string', value: stripMsWordText(node.value) });
    case 'boolean':
      // The deserialized boolean is text to replaceList, which reads it as YES or NO.
      return serializeCfJson({ kind: 'string', value: node.value ? 'YES' : 'NO' });
    case 'null':
      throw new UrlScanError('Variable VALUE is undefined.');
    case 'array':
      return serializeCfJson(stripMsWordItem(node));
    default:
      // A struct is written back untouched; isNumeric has already passed every JSON number.
      return serializeCfJson(node);
  }
}

/** `filterTags` with the default tags (Portcullis.cfc:403-437): each tag, its element where closed, and any end tag become `[INVALID]`. */
function filterTags(text: string): string {
  let clean = stripMsWord(text);
  for (const tag of TAG_FILTER) {
    // ColdFusion's `.` is any character but a line feed.
    const single = `<${tag}[^\\n]*?>|<${tag}[^\\n]*?/>|</${tag}[^\\n]*?>`;
    if (!new RegExp(single, 'i').test(clean)) continue;
    clean = clean.replace(new RegExp(`<${tag}[^\\n]*?>[^\\n]*?</${tag}[^\\n]*?>|<${tag}[^\\n]*?/>|</${tag}[^\\n]*?>`, 'gi'), INVALID_MARKER);
    clean = clean.replace(new RegExp(single, 'gi'), INVALID_MARKER);
  }
  return clean;
}

/** The name a filter writes its result back under: `REReplaceNoCase(item, "[^a-zA-Z0-9_]", "", "All")`. */
function filteredName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * The url scope after `scan(object=url, useTagFilter=true, useWordFilter=true)`: names CFML cannot hold dropped, `&amp;` and
 * NUL removed, then outside the exception fields the tag filter, Word quotes, trimming and the word filter. Names are lower-cased.
 */
export function scanUrlScope(url: ReadonlyMap<string, string>): Map<string, string> {
  const scope = new Map<string, string>();
  for (const [name, value] of url) {
    if (!isValidCfVariableName(name)) continue;
    scope.set(name.replace(/&amp;/gi, '').replace(/amp;/gi, ''), value.replace(/\u0000/g, ''));
  }
  const filtered = [...scope.keys()].filter((name) => !EXCEPTION_FIELDS.has(name));
  for (const name of filtered) scope.set(filteredName(name), filterTags(scope.get(name) ?? ''));
  for (const name of filtered) {
    // The scan's `(\uFFFD|\uFFFD)` pattern turns each replacement character into an apostrophe.
    const trimmed = javaTrim((scope.get(name) ?? '').replace(/\uFFFD/g, "'"));
    scope.set(name, trimmed);
    scope.set(filteredName(name), trimmed.replace(WORD_FILTER, INVALID_MARKER));
  }
  return scope;
}
