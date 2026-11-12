// Route-key conflict cases as the exact request and body params the dispatcher matcher consumes.
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import type { RouteKeyConflictCase } from '@opt2/platform/testing';
import { bodyParamsFrom, type BodyParams } from '../../src/dispatcher/body.js';
import type { Matcher } from '../../src/dispatcher/match.js';

/** Boundary of every multipart body this helper encodes. */
export const MULTIPART_TEST_BOUNDARY = '----opt2-gateway-test-boundary';

const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART = `multipart/form-data; boundary=${MULTIPART_TEST_BOUNDARY}`;
const DELIMITER = `--${MULTIPART_TEST_BOUNDARY}`;
const CRLF = '\r\n';
const DEFAULT_FILE_TYPE = 'application/octet-stream';
/** Content of every encoded file part. */
const FILE_BYTES = Buffer.from('opt2 gateway test file', 'latin1');

type CaseRequest = RouteKeyConflictCase['request'];
type MatchInput = Parameters<Matcher['match']>[0];
type Fields = Readonly<Record<string, string | readonly string[]>>;
/** A file part by field and file name, with the content type a case may name. */
interface CaseFile {
  readonly field: string;
  readonly filename: string;
  readonly contentType?: string;
}

/** A request body and the `Content-Type` describing it; without a content type no such header is sent. */
export interface EncodedBody {
  contentType?: string;
  buffer: Buffer;
}

/** The request members the matcher reads, as Node delivers them: lower-cased header names and the raw body. */
export interface FakeEdgeRequest extends MatchInput {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Inputs of {@link fakeEdgeRequest}; `path` is sent verbatim and `query` in insertion order. */
export interface FakeEdgeRequestInit {
  method: string;
  path: string;
  query?: Fields;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: Buffer;
  contentType?: string;
  host?: string;
}

/** Name-value pairs in insertion order, a repeated value once per item. */
function fieldPairs(fields: Fields): Array<[string, string]> {
  return Object.entries(fields).flatMap(([name, value]) =>
    (typeof value === 'string' ? [value] : value).map((item): [string, string] => [name, item]),
  );
}

/** The first header named `name` (lower-case), ignoring case; repeated values joined as Node joins them. */
function headerOf(headers: CaseRequest['headers'], name: string): string | undefined {
  const value = Object.entries(headers).find(([key, v]) => key.toLowerCase() === name && v !== undefined)?.[1];
  return value === undefined || typeof value === 'string' ? value : value.join(', ');
}

function urlEncoded(form: Fields): EncodedBody {
  return { contentType: URLENCODED, buffer: Buffer.from(new URLSearchParams(fieldPairs(form)).toString(), 'utf8') };
}

/** Text parts for the form fields in order, then one part per file, CRLF-delimited and closed. */
function multipart(form: Fields, files: readonly CaseFile[]): EncodedBody {
  const chunks: Buffer[] = [];
  const text = (value: string): void => {
    chunks.push(Buffer.from(value, 'utf8'));
  };
  for (const [name, value] of fieldPairs(form)) {
    text(`${DELIMITER}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`);
  }
  for (const { field, filename, contentType = DEFAULT_FILE_TYPE } of files) {
    text(`${DELIMITER}${CRLF}Content-Disposition: form-data; name="${field}"; filename="${filename}"${CRLF}`);
    text(`Content-Type: ${contentType}${CRLF}${CRLF}`);
    chunks.push(FILE_BYTES);
    text(CRLF);
  }
  text(`${DELIMITER}--${CRLF}`);
  return { contentType: MULTIPART, buffer: Buffer.concat(chunks) };
}

// The case's own Content-Type, not a fixed `application/json`: legacy reads the body only under that prefix
// (jsonApiUtility.cfc:407-412), so a `text/plain` case must reach the matcher as `text/plain`.
function json(request: CaseRequest): EncodedBody {
  const buffer = Buffer.from(JSON.stringify(request.jsonBody), 'utf8');
  const contentType = headerOf(request.headers, 'content-type');
  return contentType === undefined ? { buffer } : { contentType, buffer };
}

/** The form fields and files of a case as one body: multipart with files, url-encoded with a form, else none. */
function fieldsOf(request: CaseRequest): EncodedBody | undefined {
  if (request.multipartFileNames !== undefined) return multipart(request.form ?? {}, request.multipartFileNames);
  return request.form === undefined ? undefined : urlEncoded(request.form);
}

/** The one body a request for `c` carries: multipart when it has files, else its JSON, else its url-encoded form, else none. */
export function encodeCaseBody(c: RouteKeyConflictCase): EncodedBody {
  const { request } = c;
  if (request.multipartFileNames === undefined && request.jsonBody !== undefined) return json(request);
  return fieldsOf(request) ?? { buffer: Buffer.alloc(0) };
}

/** A request as the edge receives it; `host` defaults to `localhost`, and a body sets `content-length`. */
export function fakeEdgeRequest(init: FakeEdgeRequestInit): FakeEdgeRequest {
  if (init.path.includes('?')) throw new Error(`path ${init.path} carries a query string; pass it as \`query\``);
  const search = new URLSearchParams(fieldPairs(init.query ?? {})).toString();
  const headers: FakeEdgeRequest['headers'] = { host: 'localhost' };
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value !== undefined) headers[name.toLowerCase()] = typeof value === 'string' ? value : [...value];
  }
  if (init.host !== undefined) headers.host = init.host;
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  if (init.body !== undefined) headers['content-length'] = String(init.body.length);
  return {
    method: init.method,
    url: search === '' ? init.path : `${init.path}?${search}`,
    headers,
    body: init.body ?? Buffer.alloc(0),
  };
}

/** Throws when a form field, file part or read JSON value of `request` does not come back out of `bodyParamsFrom`. */
function assertCarried(request: CaseRequest, body: BodyParams): void {
  for (const [name, value] of Object.entries(request.form ?? {})) {
    if (body.form[name] !== (typeof value === 'string' ? value : value.join(','))) throw new Error(`form field ${name} is not read back`);
  }
  const names = (files: readonly CaseFile[]): string[] => files.map(({ field, filename }) => `${field}=${filename}`);
  if (!isDeepStrictEqual(names(body.files), names(request.multipartFileNames ?? []))) throw new Error('file parts are not read back');
  if (body.json !== undefined && !isDeepStrictEqual(body.json, request.jsonBody)) throw new Error('JSON body is not read back unchanged');
}

/** The request and body params the matcher receives for `c`; throws, naming the case, when it cannot be sent as given. */
export function matcherInputFromCase(c: RouteKeyConflictCase): { request: FakeEdgeRequest; body: BodyParams } {
  const { request: req } = c;
  try {
    // One HTTP body cannot carry form fields and JSON: the JSON is sent, and the fields are read from their own encoding.
    const fields = req.jsonBody === undefined ? undefined : fieldsOf(req);
    const sent = fields === undefined ? encodeCaseBody(c) : json(req);
    const read = bodyParamsFrom(sent.contentType, sent.buffer, req.method);
    const body = fields === undefined ? read : { ...bodyParamsFrom(fields.contentType, fields.buffer, req.method), json: read.json };
    assertCarried(req, body);
    const hasBody = sent.contentType !== undefined || sent.buffer.length > 0;
    const request = fakeEdgeRequest({
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
      body: hasBody ? sent.buffer : undefined,
      contentType: sent.contentType,
    });
    return { request, body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`route-key case ${c.name} cannot be sent through the matcher: ${reason}`, { cause: error });
  }
}
