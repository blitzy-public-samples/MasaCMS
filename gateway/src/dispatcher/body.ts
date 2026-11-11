// Body parameters of a raw request buffer, read as legacy's form scope and JSON API read them, for route keys.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  type RouteFamily,
  type RouteKeyRequest,
} from '@opt2/platform/legacy-compat';

/** One multipart file part by field and file name; its bytes stay in the request buffer. */
export type BodyFile = NonNullable<RouteKeyRequest['multipartFileNames']>[number] & { contentType?: string };

/** Form, JSON and multipart-file facts of a request body, assignable to the `RouteKeyRequest` fields as they are. */
export interface BodyParams {
  /** Url-encoded or multipart text fields; repeated names comma-joined in body order. */
  form: Record<string, string>;
  // Any JSON value, not only an object: route-key turns a non-struct body into legacy's server_error key,
  // as legacy's structAppend of it throws once isJSON has passed (jsonApiUtility.cfc:408-412).
  /** The parsed body when legacy's `application/json` prefix gate and `isJSON` pass; otherwise undefined. */
  json: RouteKeyRequest['jsonBody'];
  files: BodyFile[];
}

// Frozen at run time but typed mutable, so a caller passes the fields to RouteKeyRequest without copying.
const NO_FILES = Object.freeze([]) as unknown as BodyFile[];

/** Params of a request without a keyed body; frozen. */
export const EMPTY_BODY_PARAMS: Readonly<BodyParams> = Object.freeze({
  form: Object.freeze<Record<string, string>>({}),
  json: undefined,
  files: NO_FILES,
});

/** A body whose facts the gateway cannot establish as legacy reads them, or one legacy rejects before any CFML runs. */
export class UnreadableBodyError extends Error {
  override readonly name = 'UnreadableBodyError';
}

const JSON_PREFIX = 'application/json';
/** A header that opens with the multipart media type, leading blanks aside, as legacy's multipart parser requires. */
const MULTIPART_OPENING = /^[ \t\r\n]*multipart\/form-data/i;
/** Legacy multipart parser's readLine chunk and part buffer sizes. */
const LINE_CHUNK = 8 * 1024;
const PART_BUFFER = 64 * 1024;
const LF = 0x0a;

type Decoder = (bytes: Buffer) => string;

// Java decodes an encoded surrogate (ED A0-BF ..) to one U+FFFD where Node emits one per byte.
const utf8: Decoder = (bytes) => {
  let text = '';
  let from = 0;
  for (let at = bytes.indexOf(0xed); at !== -1 && at + 1 < bytes.length; at = bytes.indexOf(0xed, at + 1)) {
    const second = bytes[at + 1] ?? 0;
    if (second < 0xa0 || second > 0xbf) continue;
    text += `${bytes.toString('utf8', from, at)}\uFFFD`;
    from = at + 2 < bytes.length && ((bytes[at + 2] ?? 0) & 0xc0) === 0x80 ? at + 3 : at + 2;
    at = from - 1;
  }
  return text + bytes.toString('utf8', from);
};
const latin1: Decoder = (bytes) => bytes.toString('latin1');
const ascii: Decoder = (bytes) => latin1(bytes).replace(/[\x80-\xff]/g, '\uFFFD');

/** UTF-16 code units as a string. */
const fromUnits = (units: Uint16Array): string => Buffer.from(units.buffer, units.byteOffset, units.byteLength).toString('utf16le');

/** Java's UTF-16 decoder: `mark` honours and drops a leading BOM; a lone low surrogate, a high one with its next unit, or a tail is one U+FFFD. */
function utf16(littleEndian: boolean, mark: boolean): Decoder {
  return (bytes) => {
    const lead = bytes.length < 2 ? -1 : ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
    const marked = mark && (lead === 0xfeff || lead === 0xfffe);
    const little = marked ? lead === 0xfffe : littleEndian;
    const unit = (at: number): number => ((bytes[little ? at + 1 : at] ?? 0) << 8) | (bytes[little ? at : at + 1] ?? 0);
    const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
    const units = new Uint16Array((bytes.length >> 1) + 1);
    let length = 0;
    let at = marked ? 2 : 0;
    for (; at + 1 < bytes.length; at += 2) {
      const c = unit(at);
      if (isLow(c)) {
        units[length++] = 0xfffd;
      } else if (c < 0xd800 || c > 0xdbff) {
        units[length++] = c;
      } else if (bytes.length - at < 4) {
        break;
      } else {
        const low = unit((at += 2));
        units[length++] = isLow(low) ? c : 0xfffd;
        if (isLow(low)) units[length++] = low;
      }
    }
    if (at < bytes.length) units[length++] = 0xfffd;
    return fromUnits(units.subarray(0, length));
  };
}

/** Java's view of Node's single-byte table for `label`: ASCII as is; private-use, C1 (unless `c1` keeps 0x80-0x9F) and `undefinedBytes` as U+FFFD. */
function singleByte(label: string, c1: boolean, undefinedBytes: readonly number[] = []): Decoder {
  let table: Uint16Array | undefined;
  return (bytes) => {
    if (table === undefined) {
      const chars = new TextDecoder(label).decode(Uint8Array.from({ length: 256 }, (_, byte) => byte));
      table = Uint16Array.from({ length: 256 }, (_, byte) => {
        const char = chars.charCodeAt(byte);
        if (byte < 0x80 || (c1 && byte < 0xa0)) return byte;
        const javaUndefined = undefinedBytes.includes(byte) || (char >= 0xe000 && char <= 0xf8ff) || (!c1 && char >= 0x80 && char <= 0x9f);
        return javaUndefined ? 0xfffd : char;
      });
    }
    const units = new Uint16Array(bytes.length);
    for (let at = 0; at < bytes.length; at++) units[at] = table[bytes[at] ?? 0] ?? 0xfffd;
    return fromUnits(units);
  };
}

/** Node's single-byte table for `label` as it stands, private-use characters included, for a Java table identical to it. */
function wholeSingleByte(label: string): Decoder {
  let decoder: InstanceType<typeof TextDecoder> | undefined;
  return (bytes) => (decoder ??= new TextDecoder(label)).decode(bytes);
}

/** Java charsets decoded as legacy decodes them, each with its Java name and aliases, lower-cased. */
const CHARSETS: ReadonlyArray<readonly [Decoder, string]> = [
  [utf8, 'utf-8 utf8 unicode-1-1-utf-8'],
  [latin1, 'iso-8859-1 819 8859_1 ibm-819 ibm819 iso8859-1 iso8859_1 iso_8859-1 iso_8859-1:1987 iso_8859_1 cp819 csisolatin1 iso-ir-100 l1 latin1'],
  [ascii, 'us-ascii 646 ansi_x3.4-1968 ansi_x3.4-1986 ascii ibm367 iso646-us iso_646.irv:1991 ascii7 cp367 csascii default iso-ir-6 iso_646.irv:1983 us'],
  [utf16(false, true), 'utf-16 utf_16 unicodebig unicode utf16'],
  [utf16(false, false), 'utf-16be iso-10646-ucs-2 utf_16be unicodebigunmarked x-utf-16be'],
  [utf16(true, false), 'utf-16le utf_16le unicodelittleunmarked x-utf-16le'],
  [utf16(true, true), 'x-utf-16le-bom unicodelittle'],
  [singleByte('ibm866', false), 'ibm866 866 cp866 csibm866 ibm-866'],
  [singleByte('iso-8859-2', true), 'iso-8859-2 8859_2 912 iso8859-2 iso_8859-2 iso_8859-2:1987 cp912 csisolatin2 ibm-912 ibm912 iso-ir-101 iso8859_2 l2 latin2'],
  [singleByte('iso-8859-3', true), 'iso-8859-3 8859_3 913 iso8859-3 iso_8859-3 iso_8859-3:1988 cp913 csisolatin3 ibm-913 ibm913 iso-ir-109 iso8859_3 l3 latin3'],
  [singleByte('iso-8859-4', true), 'iso-8859-4 8859_4 914 iso_8859-4 iso_8859-4:1988 cp914 csisolatin4 ibm-914 ibm914 iso-ir-110 iso8859-4 iso8859_4 l4 latin4'],
  [singleByte('iso-8859-5', true), 'iso-8859-5 8859_5 915 iso8859-5 iso_8859-5 iso_8859-5:1988 cp915 csisolatincyrillic cyrillic ibm-915 ibm915 iso-ir-144 iso8859_5'],
  [singleByte('iso-8859-6', true), 'iso-8859-6 1089 8859_6 asmo-708 ecma-114 iso8859-6 iso_8859-6 iso_8859-6:1987 arabic cp1089 csisolatinarabic ibm-1089 ibm1089 iso-ir-127 iso8859_6'],
  [singleByte('iso-8859-7', true), 'iso-8859-7 813 8859_7 ecma-118 elot_928 iso_8859-7 iso_8859-7:1987 cp813 csisolatingreek greek greek8 ibm-813 ibm813 iso-ir-126 iso8859-7 iso8859_7 sun_eu_greek'],
  [singleByte('iso-8859-8', true), 'iso-8859-8 8859_8 916 iso8859-8 iso_8859-8 iso_8859-8:1988 cp916 csisolatinhebrew hebrew ibm-916 ibm916 iso-ir-138 iso8859_8'],
  [singleByte('windows-1254', true), 'iso-8859-9 8859_9 920 iso8859-9 iso_8859-9 iso_8859-9:1989 cp920 csisolatin5 ibm-920 ibm920 iso-ir-148 iso8859_9 l5 latin5'],
  [singleByte('iso-8859-13', true), 'iso-8859-13 8859_13 iso8859-13 iso8859_13 iso_8859-13'],
  [singleByte('iso-8859-13', true), 'x-ibm921 921 cp921 ibm-921 ibm921'],
  [singleByte('iso-8859-15', true), 'iso-8859-15 8859_15 923 ibm-923 ibm923 iso8859-15 iso8859_15 iso8859_15_fdis iso_8859-15 l9 latin0 latin9 latin-9 cp923 csiso885915 csisolatin0 csisolatin9'],
  [singleByte('koi8-r', false), 'koi8-r cskoi8r koi8 koi8_r'],
  [singleByte('koi8-u', false), 'koi8-u koi8_u'],
  [wholeSingleByte('macintosh'), 'x-macroman macroman'],
  [singleByte('windows-874', false, [0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97]), 'tis-620 tis620 tis620.2533'],
  [singleByte('windows-874', true), 'x-iso-8859-11 iso-8859-11 iso8859_11'],
  [singleByte('windows-874', false), 'x-windows-874 ms-874 ms874 windows-874'],
  [singleByte('windows-1250', false), 'windows-1250 cp1250 cp5346'],
  [singleByte('windows-1251', false), 'windows-1251 ansi-1251 cp1251 cp5347'],
  [singleByte('windows-1252', false), 'windows-1252 cp1252 cp5348 ibm-1252 ibm1252'],
  [singleByte('windows-1253', false, [0xaa]), 'windows-1253 cp1253 cp5349'],
  [singleByte('windows-1254', false), 'windows-1254 cp1254 cp5350'],
  [singleByte('windows-1255', false), 'windows-1255 cp1255'],
  [singleByte('windows-1256', false), 'windows-1256 cp1256'],
  [singleByte('windows-1257', false), 'windows-1257 cp1257 cp5353'],
  [singleByte('windows-1258', false), 'windows-1258 cp1258'],
];
const DECODERS: ReadonlyMap<string, Decoder> = new Map(CHARSETS.flatMap(([decoder, names]) => names.split(' ').map((name) => [name, decoder] as const)));

/** A legal Java charset name (Charset.checkName); no other text, blanks included, names a charset. */
const CHARSET_NAME = /^[A-Za-z0-9][A-Za-z0-9+\-:_.]*$/;

function decoderFor(charset: string): Decoder {
  const decoder = CHARSET_NAME.test(charset) ? DECODERS.get(charset.toLowerCase()) : undefined;
  if (decoder === undefined) throw new UnreadableBodyError(`charset ${JSON.stringify(charset)} is not decoded`);
  return decoder;
}

const HTTP_BLANKS = ' \t\r\n';
/** Java's Character.isWhitespace over a whole string, as HttpCore's TextUtils.isBlank tests a charset. */
const JAVA_BLANK = /^[\t-\r\x1c-\x20\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/;

/**
 * HttpCore's TokenParser read of a token, or with `quoted` a value, from `at` to a `stops` character; inner blank runs become one space.
 * @returns The text and the index it stops at.
 */
function tokenAt(value: string, at: number, stops: string, quoted: boolean): [string, number] {
  const endsRun = (c: string): boolean => stops.includes(c) || HTTP_BLANKS.includes(c) || (quoted && c === '"');
  let text = '';
  let blank = false;
  while (at < value.length && !stops.includes(value.charAt(at))) {
    const c = value.charAt(at);
    if (HTTP_BLANKS.includes(c)) {
      blank = true;
      at++;
      continue;
    }
    if (blank && text !== '') text += ' ';
    blank = false;
    if (quoted && c === '"') {
      // A backslash escapes `"` and `\` and is kept before any other character; CR and LF are dropped.
      let escaped = false;
      for (at++; at < value.length; at++) {
        const q = value.charAt(at);
        if (escaped) {
          text += q === '"' || q === '\\' ? q : `\\${q}`;
        } else if (q === '"') {
          at++;
          break;
        } else if (q !== '\\' && q !== '\r' && q !== '\n') {
          text += q;
        }
        escaped = !escaped && q === '\\';
      }
      continue;
    }
    for (; at < value.length && !endsRun(value.charAt(at)); at++) text += value.charAt(at);
  }
  return [text, at];
}

type Pair = [name: string, value: string | undefined];

/** HttpCore's name-value pair read from `at`, without a value when no `=` follows the name, and the index past its delimiter. */
function pairAt(header: string, at: number): [Pair, number] {
  const [name, nameEnd] = tokenAt(header, at, '=;,', false);
  if (header.charAt(nameEnd) !== '=') return [[name, undefined], nameEnd + 1];
  const [value, valueEnd] = tokenAt(header, nameEnd + 1, ';,', true);
  return [[name, value], valueEnd + 1];
}

/** HttpCore's first header element of a `Content-Type` value, skipping elements with neither name nor value; undefined when none is left. */
function firstElementOf(header: string): { name: string; params: Pair[] } | undefined {
  for (let at = 0; at < header.length; ) {
    let element: Pair;
    [element, at] = pairAt(header, at);
    const params: Pair[] = [];
    if (at < header.length && header.charAt(at - 1) !== ',') {
      do {
        let param: Pair;
        [param, at] = pairAt(header, at);
        params.push(param);
      } while (at < header.length && header.charAt(at - 1) !== ',');
    }
    if (element[0] !== '' || element[1] !== undefined) return { name: element[0], params };
  }
  return undefined;
}

/** The request charset as legacy's HttpCore ContentType.parse reads it: the first element's first `charset` parameter; undefined when absent or blank. */
function requestCharsetOf(params: readonly Pair[]): string | undefined {
  const value = params.find(([name]) => name.toLowerCase() === 'charset')?.[1];
  return value === undefined || JAVA_BLANK.test(value) ? undefined : value;
}

/** CFML form scope append: a repeated name joins its values with `,`; `__proto__` stays a data key. */
function appendField(form: Record<string, string>, name: string, value: string): void {
  const previous = Object.hasOwn(form, name) ? form[name] : undefined;
  const joined = previous === undefined ? value : `${previous},${value}`;
  Object.defineProperty(form, name, { value: joined, writable: true, enumerable: true, configurable: true });
}

function parseUrlEncoded(buffer: Buffer): Record<string, string> {
  const form: Record<string, string> = {};
  // The leading `&` stops URLSearchParams from dropping a leading `?`, which the servlet parser keeps in the name.
  for (const [name, value] of new URLSearchParams(`&${buffer.toString('utf8')}`)) appendField(form, name, value);
  return form;
}

function parseJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** `--` and the boundary as legacy reads it from the raw header: all after the last `boundary=`, outer quotes removed. */
function boundaryOf(contentType: string): string {
  const at = contentType.lastIndexOf('boundary=');
  const value = at === -1 ? '' : contentType.slice(at + 'boundary='.length);
  if (value === '') throw new UnreadableBodyError('multipart boundary is missing');
  if (!value.startsWith('"')) return `--${value}`;
  const close = value.lastIndexOf('"');
  if (close === 0) throw new UnreadableBodyError('multipart boundary quote is not closed');
  return `--${value.slice(1, close)}`;
}

/** Legacy's multipart parser (Adobe's com.oreilly MultipartParser) reading one request buffer in place. */
class MultipartReader {
  private at = 0;

  constructor(
    private readonly buffer: Buffer,
    private readonly decode: Decoder,
  ) {}

  /** The next line without its `\n`, or its last two chars after a `\r`; null at the end of the body. */
  readLine(decode: Decoder = this.decode): string | null {
    let line = '';
    let read: number;
    // Chunks are decoded one by one; a chunk of exactly 8 KiB continues the line, even after its `\n`.
    do {
      const limit = Math.min(this.at + LINE_CHUNK, this.buffer.length);
      const lf = this.buffer.subarray(this.at, limit).indexOf(LF);
      read = (lf === -1 ? limit : this.at + lf + 1) - this.at;
      line += decode(this.buffer.subarray(this.at, this.at + read));
      this.at += read;
    } while (read === LINE_CHUNK);
    if (line === '') return null;
    if (line.length >= 2 && line[line.length - 2] === '\r') return line.slice(0, -2);
    return line.endsWith('\n') ? line.slice(0, -1) : line;
  }

  /** The next part's header lines, blank-led lines appended to the one before; undefined when no part follows. */
  readHeaders(): string[] | undefined {
    let line = this.readLine();
    if (line === '') return undefined;
    const headers: string[] = [];
    while (line !== null && line !== '') {
      let next = this.readLine();
      while (next !== null && (next.startsWith(' ') || next.startsWith('\t'))) {
        line += next;
        next = this.readLine();
      }
      headers.push(line);
      line = next;
    }
    // Legacy drops a part whose headers run to the end of the body and keeps the parts before it.
    return line === null ? undefined : headers;
  }

  /** The content up to the next line opening with the boundary, as PartInputStream's 64 KiB fills read it. */
  readContent(boundary: Buffer): { start: number; end: number } {
    const start = this.at;
    const maxRead = PART_BUFFER - boundary.length - 2;
    // Every fill after the first starts with the two bytes the one before held back.
    for (let count = 0; count < maxRead; count = 2) {
      while (count < maxRead) {
        if (this.at >= this.buffer.length) throw new UnreadableBodyError('multipart part ends before its boundary');
        const line = this.at;
        const lf = this.buffer.subarray(line, Math.min(line + PART_BUFFER - count, this.buffer.length)).indexOf(LF);
        const read = lf === -1 ? Math.min(PART_BUFFER - count, this.buffer.length - line) : lf + 1;
        this.at += read;
        // Legacy drops the two bytes before the boundary line, whatever they are.
        if (read >= boundary.length && boundary.equals(this.buffer.subarray(line, line + boundary.length))) {
          return { start, end: Math.max(start, line - 2) };
        }
        count += read;
      }
    }
    // A boundary too long for the buffer leaves a fill nothing to read, which ends the part; one pending byte fails it.
    if (this.at - start === 1) throw new UnreadableBodyError('multipart part buffer is in an illegal state');
    return { start, end: Math.max(start, this.at - 2) };
  }
}

/** Name and cut file name of a `Content-Disposition` line, found as legacy's extractDispositionInfo finds them. */
function dispositionOf(line: string, lower: string): { name: string; filename?: string } {
  const at = lower.indexOf('content-disposition: ');
  const semi = lower.indexOf(';');
  if (at === -1 || semi === -1 || lower.slice(at + 'content-disposition: '.length, semi) !== 'form-data') {
    throw new UnreadableBodyError('multipart content disposition is not form-data');
  }
  const nameAt = lower.indexOf('name="', semi);
  const nameEnd = nameAt === -1 ? -1 : lower.indexOf('"', nameAt + 'name="'.length);
  if (nameEnd === -1) throw new UnreadableBodyError('multipart content disposition has no quoted name');
  // Indexes found in the lower-cased line, which İ lengthens, slice the original one; past its end Java throws.
  if (nameEnd > line.length) throw new UnreadableBodyError('multipart content disposition name ends past the line');
  const name = line.slice(nameAt + 'name="'.length, nameEnd);
  const fileAt = lower.indexOf('filename="', nameEnd + 2);
  const fileEnd = fileAt === -1 ? -1 : line.indexOf('"', fileAt + 'filename="'.length);
  if (fileEnd === -1) return { name };
  const filename = line.slice(fileAt + 'filename="'.length, fileEnd);
  return { name, filename: filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1) };
}

/** A part's disposition, content type and charset from its header lines; later lines overwrite earlier ones. */
function partOf(lines: readonly string[]): { name: string; filename?: string; contentType?: string; charset?: string } {
  let disposition: { name: string; filename?: string } | undefined;
  let contentType: string | undefined;
  let charset: string | undefined;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('content-disposition:')) {
      disposition = dispositionOf(line, lower);
    } else if (lower.startsWith('content-type:')) {
      const space = lower.indexOf(' ');
      if (space === -1) throw new UnreadableBodyError('multipart content type has no value');
      contentType = lower.slice(space + 1);
      const at = contentType.indexOf('charset=');
      if (at !== -1) charset = contentType.slice(at + 'charset='.length).split(';')[0];
    }
  }
  // Legacy's form scope fails on a part without a name.
  if (disposition === undefined) throw new UnreadableBodyError('multipart part has no content disposition');
  return { ...disposition, contentType, charset };
}

/**
 * Text fields and file parts of a multipart body as legacy's form scope reads them; file bytes are not read.
 * @param formType Whether the media type is `multipart/form-data`; legacy checks the body's opening under any other but reads no part.
 */
function parseMultipart(contentType: string, decode: Decoder, buffer: Buffer | undefined, formType: boolean): BodyParams {
  // Legacy's multipart parser reads nothing under a header that does not open with its media type.
  if (!MULTIPART_OPENING.test(contentType)) return EMPTY_BODY_PARAMS;
  const boundary = boundaryOf(contentType);
  if (buffer === undefined || buffer.length === 0) return EMPTY_BODY_PARAMS;
  // Legacy answers 500 for any body under a boundary outside ASCII.
  if (/[\u0080-\uffff]/.test(boundary)) throw new UnreadableBodyError('multipart boundary is not ASCII');
  const reader = new MultipartReader(buffer, decode);
  // No preamble: the first line must open with the boundary. Legacy reads it before applying the request charset.
  if (reader.readLine(latin1)?.startsWith(boundary) !== true) {
    throw new UnreadableBodyError('multipart body does not open with its boundary');
  }
  if (!formType) return EMPTY_BODY_PARAMS;
  const boundaryBytes = Buffer.from(boundary, 'latin1');
  const form: Record<string, string> = {};
  const files: BodyFile[] = [];
  // Parts after a close delimiter are read like any other.
  for (let lines = reader.readHeaders(); lines !== undefined; lines = reader.readHeaders()) {
    const part = partOf(lines);
    const content = reader.readContent(boundaryBytes);
    if (part.filename === undefined) {
      const decodeValue = part.charset === undefined ? decode : decoderFor(part.charset);
      appendField(form, part.name, decodeValue(buffer.subarray(content.start, content.end)));
    } else {
      const file: BodyFile = { field: part.name, filename: part.filename };
      if (part.contentType !== undefined) file.contentType = part.contentType;
      files.push(file);
    }
  }
  return { form, json: undefined, files };
}

/**
 * Body params of a raw request buffer by its `Content-Type`, read without changing the buffer.
 * @param method The request line's method, not an `X-HTTP-Method-Override`.
 * @throws UnreadableBodyError For a POST body legacy rejects or the gateway cannot read as legacy does.
 */
export function bodyParamsFrom(contentType: string | undefined, buffer: Buffer | undefined, method = 'POST'): BodyParams {
  if (contentType === undefined) return EMPTY_BODY_PARAMS;
  // Legacy compares the header's first 16 characters, case-insensitively, before isJSON (jsonApiUtility.cfc:407-410).
  if (contentType.slice(0, JSON_PREFIX.length).toLowerCase() === JSON_PREFIX) {
    const json = buffer === undefined ? undefined : parseJson(buffer);
    return json === undefined ? EMPTY_BODY_PARAMS : { form: {}, json, files: [] };
  }
  // Legacy fills the form scope for a POST request line only.
  if (method.toUpperCase() !== 'POST') return EMPTY_BODY_PARAMS;
  // Legacy's HttpCore parse fails a header without an element and a charset Java rejects or lacks; lacking Java's table, the gateway checks the name.
  const element = firstElementOf(contentType);
  if (element === undefined) throw new UnreadableBodyError('content type has no media type');
  const charset = requestCharsetOf(element.params);
  if (charset !== undefined && !CHARSET_NAME.test(charset)) throw new UnreadableBodyError(`charset ${JSON.stringify(charset)} is not a legal name`);
  const type = element.name.toLowerCase();
  // Legacy decodes multipart parts and a url-encoded body in the request charset; the gateway reads those only in a charset it decodes.
  if (type === 'multipart/form-data') return parseMultipart(contentType, charset === undefined ? utf8 : decoderFor(charset), buffer, true);
  // Legacy rejects a multipart header's boundary even without a body; under another media type it reads the opening line alone, as ISO-8859-1.
  if (MULTIPART_OPENING.test(contentType)) return parseMultipart(contentType, latin1, buffer, false);
  if (type === 'application/x-www-form-urlencoded' && buffer !== undefined && buffer.length > 0) {
    if (charset !== undefined) decoderFor(charset);
    return { form: parseUrlEncoded(buffer), json: undefined, files: [] };
  }
  return EMPTY_BODY_PARAMS;
}

/** A simple value as CFML reads it as a string: JSON null as '', complex values as undefined. */
function simpleValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return value === null ? '' : undefined;
}

/** The value under `name` ignoring case, the last spelling winning as in a CFML scope; simple values only. */
export function paramValue(params: Record<string, unknown>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  let found: unknown;
  for (const [key, value] of Object.entries(params)) if (key.toLowerCase() === wanted) found = value;
  return simpleValue(found);
}

/** Header `name` ignoring case; repeated values joined with `, `. */
function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? value : value.join(', ');
  }
  return undefined;
}

function tokenPair(token: string, expires: string | undefined): { token: string; expires?: string } {
  return expires ? { token, expires } : { token };
}

/** The CSRF field pair legacy validates; on family `api` each present `X-csrf_token*` header, even empty, replaces its field. */
export function tokenFromParams(
  params: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  family: RouteFamily,
): { token: string; expires?: string } | undefined {
  const fromHeader = (name: string): string | undefined => (family === 'api' ? headerValue(headers, name) : undefined);
  const token = fromHeader(CSRF_HEADER_TOKEN) ?? paramValue(params, CSRF_FIELD_TOKEN);
  if (!token) return undefined;
  return tokenPair(token, fromHeader(CSRF_HEADER_EXPIRES) ?? paramValue(params, CSRF_FIELD_EXPIRES));
}
