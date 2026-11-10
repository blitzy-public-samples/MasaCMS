import type { FastifyReply } from 'fastify';
import { legacyHeaders } from '../legacy-compat/index.js';
import { StorageObjectNotFoundError, type BucketName, type StoragePort } from './port.js';

/** Charset ACF's servlet container appends to a `cfcontent` type that names none. */
const LEGACY_RESPONSE_CHARSET = 'UTF-8';

const CHARSET_PARAM = /\s*;\s*charset=/;

// Control bytes Node refuses in a header value; legacy sends CR and LF as spaces and the rest raw.
const UNSENDABLE_HEADER_BYTE = /[\x00-\x08\x0A-\x1F\x7F]/g;

/** Object to stream plus its `tfiles` metadata; `method` is echoed verbatim, as legacy echoes `url.method`. */
export interface LegacyFileOptions {
  storage: StoragePort;
  bucket: BucketName;
  key: string;
  contentType: string;
  fileName: string;
  method: 'inline' | 'attachment' | (string & Record<never, never>);
  lastModified?: Date;
}

/** Header value Node writes as the bytes legacy sends: UTF-8, with unsendable control bytes as spaces. */
export function legacyHeaderValue(s: string): string {
  // ACF on CommandBox (Undertow) sends a header value's UTF-8 bytes, measured on the oracle (`ï` goes out as C3 AF);
  // Node writes one byte per character, so the bytes travel as latin1 characters.
  return Buffer.from(s, 'utf8').toString('latin1').replace(UNSENDABLE_HEADER_BYTE, ' ');
}

/** `cfcontent` type as ACF sends it: a given charset joined as `;charset=`, else `; charset=UTF-8` appended. */
function legacyContentType(type: string): string {
  return CHARSET_PARAM.test(type)
    ? type.replace(CHARSET_PARAM, ';charset=')
    : `${type}; charset=${LEGACY_RESPONSE_CHARSET}`;
}

/** Legacy's 200 file headers: `legacyHeaders()` plus those `streamFile` sets; a video type forces `attachment`. */
export function legacyFileHeaders(p: {
  contentType: string;
  fileName: string;
  method: LegacyFileOptions['method'];
  size: number;
  lastModified?: Date;
}): Record<string, string | string[]> {
  const method = /video/i.test(p.contentType) ? 'attachment' : p.method;
  const headers: Record<string, string | string[]> = { ...legacyHeaders() };
  if (p.lastModified) {
    const httpTime = p.lastModified.toUTCString();
    // streamFile sets Last-Modified inside its cftry and again after it; ACF sends both lines.
    headers['Last-Modified'] = [httpTime, httpTime];
  }
  // Content-Disposition must be stored before Content-Length: Node re-decodes a Content-Disposition that follows
  // a known Content-Length (nodejs/node#46528), which would undo legacyHeaderValue on the wire.
  headers['Content-Disposition'] = legacyHeaderValue(`${method};filename="${p.fileName}"`);
  headers['Content-Length'] = String(p.size);
  headers['Content-Type'] = legacyHeaderValue(legacyContentType(p.contentType));
  return headers;
}

/** Streams the object with legacy's 200 headers; throws `StorageObjectNotFoundError` before any header when absent. */
export async function sendLegacyFile(reply: FastifyReply, opts: LegacyFileOptions): Promise<FastifyReply> {
  // If-Modified-Since is not consulted: ACF 2023 never exposes it as cgi.http_if_modified_since,
  // so streamFile's 304 branch never runs and legacy always answers 200 with the full body.
  const head = await opts.storage.head(opts.bucket, opts.key);
  if (head === null) throw new StorageObjectNotFoundError(opts.bucket, opts.key);
  const body = await opts.storage.stream(opts.bucket, opts.key);
  const headers = legacyFileHeaders({
    contentType: opts.contentType,
    fileName: opts.fileName,
    method: opts.method,
    size: head.size,
    lastModified: opts.lastModified,
  });
  return reply.code(200).headers(headers).send(body);
}
