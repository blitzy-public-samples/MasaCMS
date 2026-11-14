// Multipart part headers scanned as the body streams, framed as busboy frames them, and the content type ColdFusion `fileUpload` reports.

/** A part busboy hands over as a file: its disposition name and media type as busboy reads them, and its `fileUpload` content type. */
interface ScannedFilePart {
  name: string | undefined;
  mimetype: string;
  contentType: string;
}

/** A `Content-Disposition` or `Content-Type` value split as busboy's parseParams splits it: the leading value, then `[key, value]` pairs. */
type Params = Array<string | [key: string, value: string | undefined]>;

/** busboy's `headerSize` limit; past it busboy reads a truncated block, so the scan stops. */
const MAX_HEADER_BYTES = 80 * 1024;
/** busboy's `headerPairs` limit. */
const MAX_HEADER_PAIRS = 2000;
/** @fastify/multipart's default `parts` limit; past it the request fails, so the scan stops. */
const MAX_PARTS = 1000;
/** busboy's longest delimiter, `\r\n--` and the boundary. */
const MAX_DELIMITER_BYTES = 256;

const EMPTY = Buffer.alloc(0);
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const ONE_DASH = Buffer.from('-');
const DASH = 0x2d;
const CR = 0x0d;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;
const LINE_BREAK = /[\r\n]/;
const LATIN1_CHARSETS: ReadonlySet<string> = new Set([
  'latin1',
  'ascii',
  'us-ascii',
  'iso-8859-1',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'windows-1252',
  'iso_8859-1:1987',
  'cp1252',
  'x-cp1252',
]);
const UTF16_CHARSETS: ReadonlySet<string> = new Set(['utf16le', 'utf-16le', 'ucs2', 'ucs-2']);

/** A header string of raw bytes as latin1, decoded as UTF-8 when it holds a non-ASCII byte. */
function utf8Text(binary: string): string {
  return /[^\u0000-\u007F]/.test(binary) ? Buffer.from(binary, 'latin1').toString('utf8') : binary;
}

/** An RFC 2231 extended value's bytes decoded in `charset` as busboy decodes them: unknown charsets as UTF-8. */
function charsetText(binary: string, charset: string): string {
  const name = charset.toLowerCase();
  if (binary === '' || LATIN1_CHARSETS.has(name)) return binary;
  const bytes = Buffer.from(binary, 'latin1');
  if (UTF16_CHARSETS.has(name)) return bytes.toString('utf16le');
  return name === 'base64' ? bytes.toString('base64') : bytes.toString('utf8');
}

/** busboy's fast path for `form-data; name="…"[; filename="…"]`; undefined when the value takes the general path. */
function formDataParams(value: string): Params | undefined {
  const lead = 'form-data; name="';
  if (!value.startsWith(lead)) return undefined;
  let start = lead.length;
  let end = value.indexOf('"', start);
  if (end === -1 || value.includes('\\', start)) return undefined;
  const params: Params = ['form-data', ['name', utf8Text(value.slice(start, end))]];
  let at = end + 1;
  while (at < value.length && value[at] !== ';') at += 1;
  if (at === value.length) return params;
  at += 1;
  while (value[at] === ' ' || value[at] === '\t') at += 1;
  if (!value.startsWith('filename="', at)) return undefined;
  start = at + 'filename="'.length;
  end = value.indexOf('"', start);
  if (end === -1 || value.includes('\\', start)) return undefined;
  params.push(['filename', utf8Text(value.slice(start, end))]);
  return params;
}

/** `value` split as busboy's parseParams splits it: whitespace outside quotes dropped, quoted pairs unescaped, `key*` values decoded. */
function parseParams(value: string): Params {
  if (!value.includes(';')) return [utf8Text(value)];
  const fast = formDataParams(value);
  if (fast !== undefined) return fast;
  const params: Params = [];
  let state: 'key' | 'value' | 'charset' | 'lang' = 'key';
  let charset = '';
  let inQuote = false;
  let escaping = false;
  let index = 0;
  let text = '';
  const settle = (): void => {
    if (charset !== '') {
      const bytes = text.replace(PERCENT_ESCAPE, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
      if (text !== '') text = charsetText(bytes, charset);
      charset = '';
    } else if (text !== '') {
      text = utf8Text(text);
    }
  };
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    if (char === '\\' && inQuote) {
      if (!escaping) {
        escaping = true;
        continue;
      }
      escaping = false;
    } else if (char === '"') {
      if (!escaping) {
        if (inQuote) {
          inQuote = false;
          state = 'key';
          // Text after a closing quote up to the next `;` is dropped.
          while (i + 1 < value.length && value[i + 1] !== ';') i += 1;
        } else {
          inQuote = true;
        }
        continue;
      }
      escaping = false;
    } else {
      if (escaping && inQuote) text += '\\';
      escaping = false;
      if ((state === 'charset' || state === 'lang') && char === "'") {
        if (state === 'charset') {
          state = 'lang';
          // `text` holds the `=` that followed the `*`.
          charset = text.slice(1);
        } else {
          state = 'value';
        }
        text = '';
        continue;
      }
      if (state === 'key' && (char === '*' || char === '=') && params.length > 0) {
        state = char === '*' ? 'charset' : 'value';
        params[index] = [text, undefined];
        text = '';
        continue;
      }
      if (!inQuote && char === ';') {
        state = 'key';
        settle();
        const pair = params[index];
        if (pair === undefined) params[index] = text;
        else if (typeof pair !== 'string') pair[1] = text;
        text = '';
        index += 1;
        continue;
      }
      if (!inQuote && (char === ' ' || char === '\t')) continue;
    }
    text += char;
  }
  settle();
  const pair = params[index];
  if (pair === undefined) {
    if (text !== '') params[index] = text;
  } else if (typeof pair !== 'string') {
    pair[1] = text;
  }
  return params;
}

/** Header values by lower-cased name, as busboy's HeaderParser reads a block: folded lines joined, reading stops at a malformed line. */
function busboyHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  let values: string[] | undefined;
  let pairs = 0;
  for (const line of block.split('\r\n')) {
    if (line === '') continue;
    if (LINE_BREAK.test(line)) break;
    if ((line.startsWith(' ') || line.startsWith('\t')) && values !== undefined) {
      values[values.length - 1] += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) break;
    const name = line.slice(0, colon).toLowerCase();
    const after = line.charAt(colon + 1);
    values = headers.get(name) ?? [];
    headers.set(name, values);
    values.push(line.slice(after === ' ' || after === '\t' ? colon + 2 : colon + 1));
    pairs += 1;
    if (pairs === MAX_HEADER_PAIRS) break;
  }
  return headers;
}

/** ColdFusion `fileUpload`'s `contentType/contentSubType` for a part's header lines after its boundary line; `text/plain` without a Content-Type line. */
export function fileUploadContentType(lines: readonly string[]): string {
  const unfolded: string[] = [];
  for (const line of lines) {
    const last = unfolded.length - 1;
    if ((line.startsWith(' ') || line.startsWith('\t')) && last >= 0) unfolded[last] += line;
    else unfolded.push(line);
  }
  let value: string | undefined;
  for (const line of unfolded) {
    const lower = line.toLowerCase();
    if (!lower.startsWith('content-type:')) continue;
    const space = lower.indexOf(' ');
    // Legacy fails the request on a line without a space; the value after the colon is taken instead.
    value = space === -1 ? lower.slice('content-type:'.length).replace(/^[ \t]+/, '') : lower.slice(space + 1);
  }
  if (value === undefined) return 'text/plain';
  const slash = value.indexOf('/');
  return slash === -1 ? `${value}/${value}` : `${value.slice(0, slash)}/${value.slice(value.lastIndexOf('/') + 1)}`;
}

/** The file part a header block describes, as busboy classifies it; undefined for a part busboy skips or reads as a field. */
function filePartOf(block: Buffer): ScannedFilePart | undefined {
  const headers = busboyHeaders(block.toString('latin1'));
  const disposition = headers.get('content-disposition')?.[0];
  if (disposition === undefined) return undefined;
  const params = parseParams(disposition);
  const [kind] = params;
  if (typeof kind !== 'string' || !/^form-data$/i.test(kind)) return undefined;
  let name: string | undefined;
  let filename: string | undefined;
  for (const param of params) {
    if (typeof param === 'string') continue;
    const [key, value] = param;
    if (/^name$/i.test(key)) name = value;
    else if (/^filename$/i.test(key)) filename = value;
    else continue;
    if (value !== undefined && LINE_BREAK.test(value)) return undefined;
  }
  const type = headers.get('content-type')?.[0];
  let mimetype: string | undefined;
  if (type !== undefined && type !== '' && !/[; \t]/.test(type)) {
    mimetype = type.toLowerCase();
  } else if (type !== undefined) {
    const [media] = parseParams(type);
    if (typeof media === 'string' && media !== '') mimetype = media.toLowerCase();
  }
  mimetype ??= 'text/plain';
  if (mimetype !== 'application/octet-stream' && filename === undefined) return undefined;
  return { name, mimetype, contentType: fileUploadContentType(block.toString('utf8').split('\r\n').slice(1)) };
}

/** Records the file parts of one multipart/form-data body, chunk by chunk, holding a bounded tail and no part bytes. */
export class MultipartHeaderScanner {
  /** Bytes that may open a delimiter, held to the next chunk; busboy reads the body as if a CRLF preceded it. */
  private carry: Buffer = CRLF;
  private state: 'preamble' | 'dashes' | 'header' | 'body' | 'done' = 'preamble';
  private dashes = 0;
  private pushes = 0;
  /** The push whose bytes ended in a lone dash after a delimiter. */
  private dashPush = -1;
  private parts = 0;
  private header: Buffer[] = [];
  private headerBytes = 0;
  /** The last bytes of the header block so far, where a split `\r\n\r\n` can start. */
  private headerTail: Buffer = EMPTY;
  private readonly files: ScannedFilePart[] = [];

  constructor(private readonly delimiter: Buffer) {}

  /** Scans the next chunk of the body. */
  push(chunk: Buffer): void {
    if (this.state === 'done') return;
    this.pushes += 1;
    const data = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    let from = 0;
    for (let at = data.indexOf(this.delimiter); at !== -1; at = data.indexOf(this.delimiter, from)) {
      this.segment(data.subarray(from, at));
      this.matched();
      from = at + this.delimiter.length;
      if (this.isDone()) return;
    }
    const keep = this.partialDelimiter(data, from);
    this.segment(data.subarray(from, data.length - keep));
    this.carry = Buffer.from(data.subarray(data.length - keep));
  }

  /** Takes the earliest untaken file part busboy names `field` with `mimetype`, and those before it, which busboy skipped; returns its `fileUpload` content type. */
  take(field: string, mimetype: string): string | undefined {
    const at = this.files.findIndex((part) => part.name === field && part.mimetype === mimetype);
    if (at === -1) return undefined;
    return this.files.splice(0, at + 1)[at]?.contentType;
  }

  /** Whether scanning has ended: the close delimiter, too many parts or an oversized header block. */
  private isDone(): boolean {
    return this.state === 'done';
  }

  /** Length of the longest tail of `data[from..]` that opens a delimiter. */
  private partialDelimiter(data: Buffer, from: number): number {
    for (let length = Math.min(this.delimiter.length - 1, data.length - from); length > 0; length -= 1) {
      const start = data.length - length;
      if (data[start] === CR && data.subarray(start).equals(this.delimiter.subarray(0, length))) return length;
    }
    return 0;
  }

  /** Bytes between delimiters, read by the current state. */
  private segment(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (this.state === 'dashes') this.afterDelimiter(bytes);
    else if (this.state === 'header') this.headerData(bytes);
  }

  private matched(): void {
    // Dicer drops a delimiter its search reports together with a lone dash before it, which happens when both arrive in one chunk.
    if (this.state === 'dashes' && this.dashes === 1 && this.dashPush === this.pushes) return;
    // A delimiter right after a delimiter opens a part without headers.
    if (this.state === 'dashes') this.startPart();
    if (this.isDone()) return;
    this.state = 'dashes';
    this.dashes = 0;
  }

  /** Bytes after a delimiter: `--` closes the body, anything else opens a part whose header block starts there. */
  private afterDelimiter(bytes: Buffer): void {
    let at = 0;
    while (this.dashes < 2 && at < bytes.length && bytes[at] === DASH) {
      this.dashes += 1;
      at += 1;
    }
    if (this.dashes === 2) {
      this.state = 'done';
      return;
    }
    if (at === bytes.length) {
      this.dashPush = this.pushes;
      return;
    }
    const dashed = this.dashes === 1;
    this.dashes = 0;
    this.startPart();
    if (this.isDone()) return;
    if (dashed) this.headerData(ONE_DASH);
    this.headerData(bytes.subarray(at));
  }

  private startPart(): void {
    this.parts += 1;
    this.state = this.parts > MAX_PARTS ? 'done' : 'header';
    this.header = [];
    this.headerBytes = 0;
    this.headerTail = EMPTY;
  }

  /** Header bytes of the current part; at its `\r\n\r\n` the part is recorded and the rest is its body. */
  private headerData(bytes: Buffer): void {
    if (this.state !== 'header') return;
    const tail = this.headerTail;
    // A terminator starting in the tail lies within the tail and the first three new bytes.
    const seam = Buffer.concat([tail, bytes.subarray(0, HEADER_END.length - 1)]).indexOf(HEADER_END);
    const inBytes = seam === -1 ? bytes.indexOf(HEADER_END) : -1;
    if (seam === -1 && inBytes === -1) {
      this.header.push(Buffer.from(bytes));
      this.headerBytes += bytes.length;
      if (this.headerBytes > MAX_HEADER_BYTES) this.state = 'done';
      const kept = HEADER_END.length - 1;
      this.headerTail = bytes.length >= kept ? Buffer.from(bytes.subarray(-kept)) : Buffer.concat([tail, bytes]).subarray(-kept);
      return;
    }
    const length = this.headerBytes + (seam === -1 ? inBytes : seam - tail.length);
    if (length > MAX_HEADER_BYTES) {
      this.state = 'done';
      return;
    }
    this.state = 'body';
    const part = filePartOf(Buffer.concat([...this.header, bytes]).subarray(0, length));
    if (part !== undefined) this.files.push(part);
  }
}

/** A scanner of a body sent under `contentType`, with its boundary read as busboy reads it; undefined when busboy finds none. */
export function createMultipartHeaderScanner(contentType: string | undefined): MultipartHeaderScanner | undefined {
  if (contentType === undefined) return undefined;
  const param = parseParams(contentType).find((entry) => typeof entry !== 'string' && /^boundary$/i.test(entry[0]));
  const boundary = typeof param === 'string' ? undefined : param?.[1];
  if (boundary === undefined) return undefined;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  return delimiter.length > MAX_DELIMITER_BYTES ? undefined : new MultipartHeaderScanner(delimiter);
}
