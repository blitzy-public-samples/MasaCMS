const CONVERT_MARKER = '\\u00';
const MALFORMED_UNICODE = 'Malformed \\uxxxx encoding.';
const HEX_QUAD = /^[0-9a-fA-F]{4}$/;
const LEGACY_KEY_STRIP = /[^a-zA-Z0-9_\-.]/g;
const LINE_TERMINATOR = /\r\n|\r|\n/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LATIN1_CHUNK = 8192;
const MALFORMED = -1;
const MALFORMED_UNIT = Uint8Array.of(0xff);
const JAVA_ESCAPES = new Map([
  ['t', '\t'],
  ['r', '\r'],
  ['n', '\n'],
  ['f', '\f'],
]);

/** Thrown where Java's bundle loading throws: malformed `\uXXXX`, or UTF-8 truncated at end of file. */
export class PropertiesSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertiesSyntaxError';
  }
}

/** Yields [start, end) offsets of the non-empty elements of a CFML list. */
function* listSpans(list: string, delimiters: string): Generator<readonly [number, number]> {
  const length = list.length;
  let index = 0;
  while (index < length) {
    while (index < length && delimiters.includes(list.charAt(index))) index++;
    if (index >= length) return;
    const start = index;
    while (index < length && !delimiters.includes(list.charAt(index))) index++;
    yield [start, index];
  }
}

/** CFML `listLen`: number of non-empty elements; every character of `delimiters` delimits. */
export function cfListLen(list: string, delimiters = ','): number {
  return Array.from(listSpans(list, delimiters)).length;
}

/** CFML `listFirst`: first non-empty element, or `''`. */
export function cfListFirst(list: string, delimiters = ','): string {
  for (const [start, end] of listSpans(list, delimiters)) return list.slice(start, end);
  return '';
}

/** CFML `listRest`: the original text after the first element and the delimiters that follow it. */
export function cfListRest(list: string, delimiters = ','): string {
  for (const [, end] of listSpans(list, delimiters)) {
    let index = end;
    while (index < list.length && delimiters.includes(list.charAt(index))) index++;
    return list.slice(index);
  }
  return '';
}

/** CFML `listGetAt` (1-based); throws `RangeError` for a position outside the list, as CFML errors. */
export function cfListGetAt(list: string, position: number, delimiters = ','): string {
  let current = 0;
  for (const [start, end] of listSpans(list, delimiters)) {
    if (++current === position) return list.slice(start, end);
  }
  throw new RangeError(`Invalid list index ${position}; the list has ${current} elements.`);
}

/** CFML `listToArray`: non-empty elements, untrimmed. */
export function cfListToArray(list: string, delimiters = ','): string[] {
  return Array.from(listSpans(list, delimiters), ([start, end]) => list.slice(start, end));
}

/** ISO-8859-1: every byte becomes the code point of the same value. */
function decodeLatin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += LATIN1_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + LATIN1_CHUNK));
  }
  return text;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/** Byte length of the UTF-8 sequence a lead byte starts, or 0 when Java rejects the lead. */
function sequenceSize(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  return lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
}

/** Java 17 strict UTF-8 verdict: `MALFORMED`, `0` when valid, else the length of a sequence cut off by end of input. */
function javaUtf8Status(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    const size = sequenceSize(lead);
    if (size === 0) return MALFORMED;
    for (let k = 1; k < size; k++) {
      if (index + k >= bytes.length) return bytes.length - index;
      const byte = bytes[index + k] ?? 0;
      if (!isContinuation(byte)) return MALFORMED;
      if (k === 1 && ((lead === 0xe0 && byte < 0xa0) || (lead === 0xf0 && byte < 0x90) || (lead === 0xf4 && byte > 0x8f))) {
        return MALFORMED;
      }
      // Java rejects an encoded surrogate only once its third byte is read.
      if (k === 2 && lead === 0xed && (bytes[index + 1] ?? 0) >= 0xa0) return MALFORMED;
    }
    index += size;
  }
  return 0;
}

/**
 * Decodes as Java 17 `PropertyResourceBundle(InputStream)` does: UTF-8, else ISO-8859-1; a BOM is kept.
 * A file whose only flaw is a truncated final sequence throws `PropertiesSyntaxError`, as Java's `MalformedInputException`.
 */
export function decodeLikePropertyResourceBundle(bytes: Uint8Array): string {
  const status = javaUtf8Status(bytes);
  if (status === MALFORMED) return decodeLatin1(bytes);
  if (status > 0) throw new PropertiesSyntaxError(`Input length = ${status}`);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** Java reports an encoded surrogate (`ED A0..BF`, plus a following continuation byte) as one malformed unit. */
function collapseEncodedSurrogates(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let copied = 0;
  for (let index = bytes.indexOf(0xed); index !== -1; index = bytes.indexOf(0xed, index + 1)) {
    const second = bytes[index + 1];
    if (second === undefined || second < 0xa0 || second > 0xbf) continue;
    parts.push(bytes.subarray(copied, index), MALFORMED_UNIT);
    copied = index + (isContinuation(bytes[index + 2]) ? 3 : 2);
    index = copied - 1;
  }
  if (parts.length === 0) return bytes;
  parts.push(bytes.subarray(copied));
  const collapsed = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    collapsed.set(part, offset);
    offset += part.length;
  }
  return collapsed;
}

/** Decodes as `InputStreamReader(…, "UTF-8")`: each malformed unit becomes U+FFFD; a BOM is kept. */
export function decodeUtf8Replacing(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(collapseEncodedSurrogates(bytes));
}

/** True when the file holds the case-sensitive `\u00` that makes `resourceBundle.cfc` run `convertToUTF`. */
export function hasConvertMarker(input: Uint8Array | string): boolean {
  if (typeof input === 'string') return input.includes(CONVERT_MARKER);
  for (let index = input.indexOf(0x5c); index !== -1; index = input.indexOf(0x5c, index + 1)) {
    if (input[index + 1] === 0x75 && input[index + 2] === 0x30 && input[index + 3] === 0x30) return true;
  }
  return false;
}

function isJavaWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\f';
}

/** Logical lines of `java.util.Properties.LineReader`: comments and blank lines skipped, continuations joined. */
function* javaLogicalLines(text: string): Generator<string> {
  const end = text.length;
  let offset = 0;
  let skipLF = false;
  for (;;) {
    let line = '';
    let skipWhiteSpace = true;
    let appendedLineBegin = false;
    let precedingBackslash = false;
    for (;;) {
      if (offset >= end) {
        if (line.length > 0) yield precedingBackslash ? line.slice(0, -1) : line;
        return;
      }
      const c = text.charAt(offset++);
      if (skipLF) {
        skipLF = false;
        if (c === '\n') continue;
      }
      if (skipWhiteSpace) {
        if (isJavaWhitespace(c)) continue;
        if (!appendedLineBegin && (c === '\r' || c === '\n')) continue;
        skipWhiteSpace = false;
        appendedLineBegin = false;
      }
      if (line.length === 0 && (c === '#' || c === '!')) {
        let terminated = false;
        while (offset < end && !terminated) {
          const next = text.charAt(offset++);
          terminated = next === '\r' || next === '\n';
        }
        if (!terminated) return;
        skipWhiteSpace = true;
        continue;
      }
      if (c !== '\n' && c !== '\r') {
        line += c;
        precedingBackslash = c === '\\' ? !precedingBackslash : false;
        continue;
      }
      if (line.length === 0) {
        skipWhiteSpace = true;
        continue;
      }
      if (offset >= end) {
        yield precedingBackslash ? line.slice(0, -1) : line;
        return;
      }
      if (!precedingBackslash) {
        yield line;
        break;
      }
      line = line.slice(0, -1);
      skipWhiteSpace = true;
      appendedLineBegin = true;
      precedingBackslash = false;
      skipLF = c === '\r';
    }
  }
}

/** `Properties.loadConvert`: resolves `\uXXXX`, `\t`, `\n`, `\r`, `\f` and `\<c>` escapes. */
function loadConvert(raw: string): string {
  if (!raw.includes('\\')) return raw;
  const end = raw.length;
  let out = '';
  let offset = 0;
  while (offset < end) {
    const c = raw.charAt(offset++);
    if (c !== '\\') {
      out += c;
      continue;
    }
    const escaped = raw.charAt(offset++);
    if (escaped !== 'u') {
      out += JAVA_ESCAPES.get(escaped) ?? escaped;
      continue;
    }
    const hex = raw.slice(offset, offset + 4);
    if (!HEX_QUAD.test(hex)) throw new PropertiesSyntaxError(MALFORMED_UNICODE);
    out += String.fromCharCode(Number.parseInt(hex, 16));
    offset += 4;
  }
  return out;
}

/** Parses decoded text as `java.util.Properties.load(Reader)`; keys are case-sensitive and later duplicates win. */
export function parseJavaProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of javaLogicalLines(text)) {
    const limit = line.length;
    let keyLength = 0;
    let valueStart = limit;
    let hasSeparator = false;
    let precedingBackslash = false;
    while (keyLength < limit) {
      const c = line.charAt(keyLength);
      if (!precedingBackslash && (c === '=' || c === ':')) {
        valueStart = keyLength + 1;
        hasSeparator = true;
        break;
      }
      if (!precedingBackslash && isJavaWhitespace(c)) {
        valueStart = keyLength + 1;
        break;
      }
      precedingBackslash = c === '\\' ? !precedingBackslash : false;
      keyLength++;
    }
    while (valueStart < limit) {
      const c = line.charAt(valueStart);
      if (!isJavaWhitespace(c)) {
        if (hasSeparator || (c !== '=' && c !== ':')) break;
        hasSeparator = true;
      }
      valueStart++;
    }
    properties.set(loadConvert(line.slice(0, keyLength)), loadConvert(line.slice(valueStart)));
  }
  return properties;
}

/** The `resourceBundle.cfc LoadResourceBundle` line reader; keys are sanitised and ASCII-lower-cased. */
export function readLegacyLines(text: string): Map<string, string> {
  const bundle = new Map<string, string>();
  for (const line of text.split(LINE_TERMINATOR)) {
    if (line.charAt(0) === '#' || cfListLen(line, '=') <= 1) continue;
    bundle.set(cfListFirst(line, '=').replace(LEGACY_KEY_STRIP, '').toLowerCase(), cfListRest(line, '='));
  }
  return bundle;
}

/** The text `resourceBundle.cfc convertToUTF` leaves in the file: sorted `key=value` lines ending in CR LF. */
export function convertToUtfText(text: string): string {
  const entries = [...parseJavaProperties(text)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const caseInsensitive = new Map(entries.map(([key, value]) => [key.toUpperCase(), value] as const));
  return entries
    .map(([key, value]) => `${key}=${caseInsensitive.get(key.toUpperCase()) ?? value}\r\n`)
    .join('')
    .replace(UNPAIRED_SURROGATE, '?'); // fileWrite's UTF-8 encoder writes '?' for an unpaired surrogate.
}

/** Loads a bundle file (bytes or decoded text) into the map legacy builds; keys are ASCII-lower-cased. */
export function loadBundleText(input: Uint8Array | string): Map<string, string> {
  if (hasConvertMarker(input)) {
    const text = typeof input === 'string' ? input : decodeLikePropertyResourceBundle(input);
    return readLegacyLines(convertToUtfText(text));
  }
  return readLegacyLines(typeof input === 'string' ? input : decodeUtf8Replacing(input));
}
