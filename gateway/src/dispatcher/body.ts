// Body parameters of a raw request buffer, read as legacy's form scope and JSON API read them, for route keys.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
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

/** Text parts above this size are not read for keying. */
const MAX_KEYED_FIELD_BYTES = 64 * 1024;
/** Commons FileUpload's part-header limit, past which legacy's parser rejects the body. */
const MAX_PART_HEADER_BYTES = 10 * 1024;
const JSON_PREFIX = 'application/json';
const HEADER_END = Buffer.from('\r\n\r\n');
const CR = 0x0d;
const LF = 0x0a;

/** Header value `type; name=value; name="quoted"` as its lower-cased type and parameters by lower-cased name. */
function parseHeaderValue(value: string): { type: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  let at = value.indexOf(';');
  const type = (at === -1 ? value : value.slice(0, at)).trim().toLowerCase();
  while (at !== -1) {
    const start = at + 1;
    const eq = value.indexOf('=', start);
    const semi = value.indexOf(';', start);
    if (eq === -1 || (semi !== -1 && semi < eq)) {
      at = semi;
      continue;
    }
    const name = value.slice(start, eq).trim().toLowerCase();
    let i = eq + 1;
    while (value[i] === ' ' || value[i] === '\t') i++;
    let parsed: string;
    if (value[i] === '"') {
      // Backslashes are kept and only stop an escaped quote from closing, as Commons FileUpload reads
      // quoted values, so an unescaped Windows path keeps its separators and extension.
      let end = i + 1;
      let escaped = false;
      while (end < value.length && (escaped || value[end] !== '"')) {
        escaped = !escaped && value[end] === '\\';
        end++;
      }
      parsed = value.slice(i + 1, end);
      at = value.indexOf(';', end);
    } else {
      parsed = (semi === -1 ? value.slice(i) : value.slice(i, semi)).trim();
      at = semi;
    }
    if (name !== '') params.set(name, parsed);
  }
  return { type, params };
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

/** Part headers by lower-cased name; folded continuation lines are joined to their header. */
function parsePartHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  let last: string | undefined;
  for (const line of text.split('\r\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && last !== undefined) {
      headers.set(last, `${headers.get(last) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    headers.set(last, line.slice(colon + 1).trim());
  }
  return headers;
}

/** Records one part: a file part by name only, a text part of at most 64 KiB as a form value. */
function readPart(
  buffer: Buffer,
  headerText: string,
  content: { start: number; end: number },
  out: { form: Record<string, string>; files: BodyFile[] },
): void {
  const headers = parsePartHeaders(headerText);
  const disposition = parseHeaderValue(headers.get('content-disposition') ?? '');
  const field = disposition.params.get('name');
  if (disposition.type !== 'form-data' || field === undefined) return;
  const filename = disposition.params.get('filename');
  if (filename !== undefined) {
    const file: BodyFile = { field, filename };
    const contentType = headers.get('content-type');
    if (contentType !== undefined) file.contentType = contentType;
    out.files.push(file);
  } else if (content.end - content.start <= MAX_KEYED_FIELD_BYTES) {
    appendField(out.form, field, buffer.toString('utf8', content.start, content.end));
  }
}

/** Scans `multipart/form-data` parts in place; a malformed body yields the parts read before the fault. */
function parseMultipart(buffer: Buffer, boundary: string): BodyParams {
  const out = { form: {} as Record<string, string>, files: [] as BodyFile[] };
  const dashBoundary = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  // `next` indexes the `--boundary` of a delimiter line; a preamble ends at the first CRLF-led delimiter.
  const opensAtStart = buffer.subarray(0, dashBoundary.length).equals(dashBoundary);
  const afterPreamble = opensAtStart ? -1 : buffer.indexOf(delimiter);
  let next = opensAtStart ? 0 : afterPreamble === -1 ? -1 : afterPreamble + 2;
  while (next !== -1) {
    const lineEnd = next + dashBoundary.length;
    // CRLF opens a part; `--` closes the body; anything else is malformed.
    if (buffer[lineEnd] !== CR || buffer[lineEnd + 1] !== LF) break;
    const headerEnd = buffer.indexOf(HEADER_END, lineEnd);
    if (headerEnd === -1 || headerEnd - lineEnd > MAX_PART_HEADER_BYTES) break;
    const start = headerEnd + HEADER_END.length;
    const end = buffer.indexOf(delimiter, start);
    if (end === -1) break;
    readPart(buffer, buffer.toString('utf8', lineEnd + 2, headerEnd), { start, end }, out);
    next = end + 2;
  }
  return { form: out.form, json: undefined, files: out.files };
}

/** Body params of a raw request buffer by its `Content-Type`; never throws and never touches the buffer's bytes. */
export function bodyParamsFrom(contentType: string | undefined, buffer: Buffer | undefined): BodyParams {
  if (buffer === undefined || buffer.length === 0 || contentType === undefined) return EMPTY_BODY_PARAMS;
  // Legacy compares the header's first 16 characters, case-insensitively, before isJSON (jsonApiUtility.cfc:407-410).
  if (contentType.slice(0, JSON_PREFIX.length).toLowerCase() === JSON_PREFIX) {
    const json = parseJson(buffer);
    return json === undefined ? EMPTY_BODY_PARAMS : { form: {}, json, files: [] };
  }
  const { type, params } = parseHeaderValue(contentType);
  if (type === 'application/x-www-form-urlencoded') {
    return { form: parseUrlEncoded(buffer), json: undefined, files: [] };
  }
  const boundary = params.get('boundary');
  if (type === 'multipart/form-data' && boundary) return parseMultipart(buffer, boundary);
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

/** The `csrf_token` field pair from params, else the `X-csrf_token` header pair; an empty value counts as absent. */
export function tokenFromParams(
  params: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
): { token: string; expires?: string } | undefined {
  const field = paramValue(params, CSRF_FIELD_TOKEN);
  if (field) return tokenPair(field, paramValue(params, CSRF_FIELD_EXPIRES));
  const header = headerValue(headers, CSRF_HEADER_TOKEN);
  if (header) return tokenPair(header, headerValue(headers, CSRF_HEADER_EXPIRES));
  return undefined;
}
