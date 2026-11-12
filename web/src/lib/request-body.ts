// Admin request bodies for screens: multipart staged to a private file while its fields are scanned (server-only).
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { MIMEType } from 'node:util';
import type { ReplayableBody } from './gateway-client';

/** A request body as web received it. */
export interface RequestBody {
  /** The inbound `content-type`, multipart boundary included. */
  readonly contentType: string;
  /** The body as received, re-readable from its start; `GatewayClient.postMultipart` takes this object as is. */
  readonly body: ReplayableBody;
  /** Fields in body order, file parts as zero-byte `File`s with name and type; empty for other bodies. */
  readonly form: FormData | URLSearchParams;
}

/** A request body as received, with the form scope it gives. */
export interface ReceivedBody {
  /** The body for screens; absent for a request without one. */
  readonly body?: RequestBody;
  /** Fields in body order, file parts as zero-byte `File`s carrying their name and type. */
  readonly form: FormData | URLSearchParams;
  /** Removes the staged copy of a multipart body; absent when nothing was staged. */
  dispose?(): Promise<void>;
}

const MULTIPART_FORM = 'multipart/form-data';
const URLENCODED_FORM = 'application/x-www-form-urlencoded';
const STAGING_PREFIX = 'opt2-web-upload-';
const STAGED_FILE = 'body';

const CR = 0x0d;
const LF = 0x0a;
const TAB = 0x09;
const SPACE = 0x20;
const DQUOTE = 0x22;
const APOSTROPHE = 0x27;
const STAR = 0x2a;
const DASH = 0x2d;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;
const HEADER_END = Buffer.from('\r\n\r\n');
const EMPTY = Buffer.alloc(0);
const HTTP_TOKEN = /^[-!#$%&'*+.^_`|~A-Za-z0-9]+$/;
// RFC 2045 tspecials: a token byte is any visible ASCII byte but these.
const TSPECIALS = new Set(Array.from('()<>@,;:\\"/[]?=', (char) => char.charCodeAt(0)));
const UTF8 = new TextDecoder();
const UTF8_KEEPING_BOM = new TextDecoder('utf-8', { ignoreBOM: true });

/** The error `Body.formData()` rejects a malformed multipart body with. */
function parsingError(cause: string): TypeError {
  return new TypeError('Failed to parse body as FormData.', { cause: new TypeError(cause) });
}

const isToken = (byte: number): boolean => byte > SPACE && byte < 0x7f && !TSPECIALS.has(byte);
const isBlank = (byte: number): boolean => byte === SPACE || byte === TAB;
const isLineByte = (byte: number): boolean => byte !== CR && byte !== LF;
const startsWithCrlf = (input: Buffer, at: number): boolean => input[at] === CR && input[at + 1] === LF;

/** A read position within a header block. */
interface Cursor {
  position: number;
}

/** The bytes from the cursor while `accept` holds, advancing past them. */
function collect(input: Buffer, cursor: Cursor, accept: (byte: number) => boolean): Buffer {
  const start = cursor.position;
  while (cursor.position < input.length && accept(input[cursor.position] as number)) cursor.position++;
  return input.subarray(start, cursor.position);
}

/** `bytes` without leading (when `leading`) and trailing spaces and tabs. */
function trimBlanks(bytes: Buffer, leading: boolean): Buffer {
  let start = 0;
  let end = bytes.length;
  while (leading && start < end && isBlank(bytes[start] as number)) start++;
  while (end > start && isBlank(bytes[end - 1] as number)) end--;
  return bytes.subarray(start, end);
}

/** The rest of a header line, trailing blanks removed, as Latin-1 text. */
const headerValue = (input: Buffer, cursor: Cursor): string =>
  trimBlanks(collect(input, cursor, isLineByte), false).toString('latin1');

/** One `Content-Disposition` attribute; null when none starts at the cursor. */
function dispositionAttribute(
  input: Buffer,
  cursor: Cursor,
): { readonly name: string; readonly value: string; readonly extended: boolean } | null {
  if (input[cursor.position] === SEMICOLON) cursor.position++;
  collect(input, cursor, isBlank);
  const name = collect(input, cursor, (byte) => isToken(byte) && byte !== STAR);
  if (name.length === 0) return null;
  const extended = input[cursor.position] === STAR;
  if (extended) cursor.position++;
  if (input[cursor.position] !== EQUALS) return null;
  cursor.position++;
  collect(input, cursor, isBlank);
  let value: string;
  if (extended) {
    const raw = collect(input, cursor, (byte) => byte !== SPACE && byte !== CR && byte !== LF && byte !== SEMICOLON);
    const charsetEnd = raw.indexOf(APOSTROPHE);
    const languageEnd = charsetEnd === -1 ? -1 : raw.indexOf(APOSTROPHE, charsetEnd + 1);
    if (languageEnd === -1) throw parsingError('expected charset and language separators in extended value');
    if (raw.subarray(0, charsetEnd).toString('latin1').toLowerCase() !== 'utf-8') {
      throw parsingError('unknown charset, expected utf-8');
    }
    value = decodeURIComponent(UTF8.decode(raw.subarray(languageEnd + 1)));
  } else if (input[cursor.position] === DQUOTE) {
    cursor.position++;
    const quoted = collect(input, cursor, (byte) => isLineByte(byte) && byte !== DQUOTE);
    if (input[cursor.position] !== DQUOTE) throw parsingError('Closing quote not found');
    cursor.position++;
    value = UTF8.decode(quoted).replace(/%0A/gi, '\n').replace(/%0D/gi, '\r').replace(/%22/g, '"');
  } else {
    value = UTF8.decode(collect(input, cursor, isToken));
  }
  return { name: name.toString('latin1').toLowerCase(), value, extended };
}

/** `name` and `filename` of a `Content-Disposition: form-data` value; `filename*` wins over `filename`. */
function disposition(input: Buffer, cursor: Cursor): { name: string; filename: string | null } {
  if (collect(input, cursor, isToken).toString('latin1').toLowerCase() !== 'form-data') {
    throw parsingError('expected form-data for content-disposition header');
  }
  let name: string | null = null;
  let filename: string | null = null;
  let extendedFilename = false;
  while (cursor.position < input.length && !startsWithCrlf(input, cursor.position)) {
    const attribute = dispositionAttribute(input, cursor);
    if (attribute === null) break;
    if (attribute.name === 'name') name = attribute.value;
    else if (attribute.name === 'filename' && (attribute.extended || !extendedFilename)) {
      filename = attribute.value;
      extendedFilename ||= attribute.extended;
    }
  }
  if (name === null) throw parsingError('name attribute is required in content-disposition header');
  return { name, filename };
}

/** What a part's headers say about it. */
interface PartHead {
  readonly name: string;
  /** Present, possibly empty, exactly for a file part. */
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly encoding: string | null;
}

/** The part headers in `block`, which ends with the empty line closing them. */
function partHead(block: Buffer): PartHead {
  const cursor: Cursor = { position: 0 };
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | null = null;
  let encoding: string | null = null;
  while (!startsWithCrlf(block, cursor.position)) {
    const header = trimBlanks(collect(block, cursor, (byte) => isLineByte(byte) && byte !== COLON), true);
    const headerName = header.toString('latin1');
    if (!HTTP_TOKEN.test(headerName)) throw parsingError('header name does not match the field-name token production');
    if (block[cursor.position] !== COLON) throw parsingError('expected :');
    cursor.position++;
    collect(block, cursor, isBlank);
    switch (headerName.toLowerCase()) {
      case 'content-disposition':
        ({ name, filename } = disposition(block, cursor));
        break;
      case 'content-type':
        contentType = headerValue(block, cursor);
        break;
      case 'content-transfer-encoding':
        encoding = headerValue(block, cursor);
        break;
      default:
        collect(block, cursor, isLineByte);
    }
    if (!startsWithCrlf(block, cursor.position)) throw parsingError('expected CRLF');
    cursor.position += 2;
  }
  if (name === null) throw parsingError('header name is null');
  return { name, filename, contentType, encoding };
}

/** The `boundary` parameter of a multipart content type, quoted or not. */
function boundaryOf(contentType: string): string {
  let mimeType: MIMEType;
  try {
    mimeType = new MIMEType(contentType);
  } catch {
    throw parsingError('invalid content-type header');
  }
  const boundary = mimeType.params.get('boundary');
  if (boundary === null) throw parsingError('missing boundary in content-type header');
  return boundary;
}

type ScanState = 'preamble' | 'delimiter' | 'headers' | 'body' | 'done';

/** Incremental `multipart/form-data` parser that keeps part headers and text values, never file bytes. */
class MultipartScanner {
  private readonly dashBoundary: Buffer;
  private readonly delimiter: Buffer;
  private readonly form = new FormData();
  private state: ScanState = 'preamble';
  /** Bytes not yet consumed: a short tail of earlier chunks, then the current chunk. */
  private pending: Buffer = EMPTY;
  /** Header or text-value bytes of the current part consumed so far. */
  private collected: Buffer[] = [];
  private part: PartHead | undefined;

  constructor(boundary: string) {
    this.dashBoundary = Buffer.from(`--${boundary}`, 'utf8');
    this.delimiter = Buffer.from(`\r\n--${boundary}`, 'utf8');
  }

  /** Scans the next body chunk. */
  push(chunk: Uint8Array): void {
    if (this.state === 'done') return;
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    while (this.step());
    // Only the retained tail is copied, so no caller buffer is held past this call.
    this.pending = Buffer.from(this.pending);
  }

  /** The fields once the whole body was scanned. */
  finish(): FormData {
    if (this.state === 'preamble') throw parsingError('no boundary found in multipart body');
    if (this.state !== 'done') throw parsingError('expected boundary after body');
    return this.form;
  }

  /** Drops the first `length` pending bytes. */
  private consume(length: number): void {
    this.pending = this.pending.subarray(length);
  }

  /** Moves pending bytes beyond the last `keep` into `collected` (when `store`) and drops them from `pending`. */
  private retainTail(keep: number, store: boolean): void {
    const cut = Math.max(0, this.pending.length - keep);
    if (store && cut > 0) this.collected.push(Buffer.from(this.pending.subarray(0, cut)));
    this.consume(cut);
  }

  /** Advances one state over `pending`; false when it needs more input. */
  private step(): boolean {
    switch (this.state) {
      case 'preamble': {
        const at = this.pending.indexOf(this.dashBoundary);
        if (at === -1) {
          this.retainTail(this.dashBoundary.length - 1, false);
          return false;
        }
        this.consume(at + this.dashBoundary.length);
        this.state = 'delimiter';
        return true;
      }
      case 'delimiter': {
        if (this.pending.length < 2) return false;
        if (this.pending[0] === DASH && this.pending[1] === DASH) {
          this.state = 'done';
          this.pending = EMPTY;
          return false;
        }
        if (!startsWithCrlf(this.pending, 0)) throw parsingError('expected CRLF');
        this.consume(2);
        this.state = 'headers';
        return true;
      }
      case 'headers': {
        if (this.collected.length === 0 && startsWithCrlf(this.pending, 0)) throw parsingError('header name is null');
        const at = this.pending.indexOf(HEADER_END);
        if (at === -1) {
          this.retainTail(HEADER_END.length - 1, true);
          return false;
        }
        this.collected.push(this.pending.subarray(0, at + HEADER_END.length));
        this.part = partHead(Buffer.concat(this.collected));
        this.collected = [];
        this.consume(at + HEADER_END.length);
        this.state = 'body';
        return true;
      }
      case 'body': {
        const text = this.part?.filename === null;
        const at = this.pending.indexOf(this.delimiter);
        if (at === -1) {
          this.retainTail(this.delimiter.length - 1, text);
          return false;
        }
        if (text) this.collected.push(this.pending.subarray(0, at));
        this.appendPart();
        this.consume(at + this.delimiter.length);
        this.state = 'delimiter';
        return true;
      }
      case 'done':
        return false;
    }
  }

  /** Appends the finished part: a text value UTF-8 decoded with its BOM kept, or a file part's placeholder. */
  private appendPart(): void {
    const part = this.part as PartHead;
    if (part.filename === null) {
      const raw = Buffer.concat(this.collected);
      const bytes = part.encoding === 'base64' ? Buffer.from(raw.toString(), 'base64') : raw;
      this.form.append(part.name, UTF8_KEEPING_BOM.decode(bytes));
    } else {
      this.form.append(part.name, new File([], part.filename, { type: part.contentType ?? 'text/plain' }));
    }
    this.collected = [];
    this.part = undefined;
  }
}

/** A fresh read of `file` from its start on each `stream()`; the file is opened only once the stream is read. */
function stagedBody(file: string, size: number): ReplayableBody {
  return {
    size,
    stream: () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            reader ??= (Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>).getReader();
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel: (reason) => reader?.cancel(reason),
        },
        { highWaterMark: 0 },
      );
    },
  };
}

/** A multipart body spooled to a private staging file while its fields are scanned; malformed bodies reject. */
async function stageMultipart(stream: ReadableStream<Uint8Array>, contentType: string): Promise<ReceivedBody> {
  const scanner = new MultipartScanner(boundaryOf(contentType));
  const dir = await mkdtemp(path.join(tmpdir(), STAGING_PREFIX));
  const file = path.join(dir, STAGED_FILE);
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  try {
    let size = 0;
    await pipeline(
      Readable.fromWeb(stream as NodeReadableStream<Uint8Array>),
      async function* scan(chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          scanner.push(chunk);
          size += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(file, { flags: 'wx', mode: 0o600 }),
    );
    const form = scanner.finish();
    return { body: { contentType, body: stagedBody(file, size), form }, form, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** The body of `request` and its form scope: the fields of an urlencoded or multipart body, else none. */
export async function receiveRequestBody(request: Request): Promise<ReceivedBody> {
  if (request.body === null) return { form: new URLSearchParams() };
  const contentType = request.headers.get('content-type') ?? '';
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (type === MULTIPART_FORM) return stageMultipart(request.body, contentType);
  const bytes = await request.blob();
  const form = new URLSearchParams(type === URLENCODED_FORM ? await bytes.text() : '');
  return { body: { contentType, body: bytes, form }, form };
}
