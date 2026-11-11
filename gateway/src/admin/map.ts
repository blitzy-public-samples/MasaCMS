// Maps an admin action the active cut-over version serves from the target to the web request, by its inventoried response mode.
import type { RouteKeyResult } from '@opt2/platform/legacy-compat';
import type { AdminResponseMode, ResponseModes } from './response-modes.js';

const ADMIN_PREFIX = 'admin:';
const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART = 'multipart/form-data';
const HASH = 0x23;

/** Gateway-authored header carrying the browser's request target as received. */
export const ORIGINAL_URL_HEADER = 'X-Opt2-Original-Url';

/** Web path prefix of each admin response mode. */
export const WEB_PREFIX_BY_MODE: Readonly<Record<AdminResponseMode, string>> = Object.freeze({
  page: '/admin',
  fragment: '/admin-raw',
  json: '/admin-raw',
  download: '/admin-raw',
  redirect: '/admin-actions',
});

/** Request facts the mapping reads; a Fastify request with its raw buffered body satisfies it. */
export interface AdminRequestLike {
  /** Request target as received: path and query. */
  readonly url: string;
  /** Request-line method, not an `X-HTTP-Method-Override`. */
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Raw body `Buffer`, when one was buffered. */
  readonly body?: unknown;
}

/** The request web receives for a target admin action. */
export interface AdminWebTarget {
  /** Web path and query. */
  readonly path: string;
  readonly method: string;
  /** False when web must receive no body, and so no `Content-Type` or `Content-Length`. */
  readonly forwardBody: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly responseMode: AdminResponseMode;
  /** Legacy's content type for the action, where the inventory records one. */
  readonly contentType?: string;
}

/** An admin route key that cannot be mapped to web. */
export class AdminMappingError extends Error {
  override readonly name = 'AdminMappingError';

  constructor(routeKey: string, reason: string) {
    super(`cannot map admin route ${routeKey} to web: ${reason}`);
  }
}

/** `<circuit>` and `<action>` of a core admin base key, without variant braces. */
function circuitAndAction(result: RouteKeyResult): [string, string] {
  const isAdmin = result.family === 'admin' && result.baseKey.startsWith(ADMIN_PREFIX);
  const body = isAdmin ? result.baseKey.slice(ADMIN_PREFIX.length) : '';
  const parts = body.split('.');
  const [circuit, action] = parts;
  if (!isAdmin || body.includes(':') || parts.length !== 2 || !circuit || !action) {
    throw new AdminMappingError(result.key, 'not a core admin action');
  }
  return [circuit, action];
}

/** Media type of the request's `Content-Type`, lower-cased; '' when absent. */
function mediaTypeOf(headers: AdminRequestLike['headers']): string {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const contentType = typeof value === 'string' ? value : (value?.[0] ?? '');
  return (contentType.split(/[;,]/, 1)[0] ?? '').trim().toLowerCase();
}

/**
 * Url-encoded body bytes as query text, unchanged except for the bytes a request target cannot carry (controls,
 * space, `#`, non-ASCII), which are percent-encoded so web decodes the same values instead of failing or truncating.
 */
function queryTextOf(bytes: Buffer): string {
  let text = '';
  for (const byte of bytes) {
    text += byte > 0x20 && byte < 0x7f && byte !== HASH ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return text;
}

/** Form fields a POST carries into a page-mode query: url-encoded bytes, multipart text fields, otherwise none. */
function postedFields(request: AdminRequestLike, form: Readonly<Record<string, string>>): string {
  const mediaType = mediaTypeOf(request.headers);
  if (mediaType === URLENCODED) return Buffer.isBuffer(request.body) ? queryTextOf(request.body) : '';
  if (mediaType !== MULTIPART) return '';
  return Object.entries(form)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * The web request for an admin action the active version marks `target`; the dispatcher merges `headers` after
 * stripping inbound `X-OPT2-*` headers.
 * @param form The body's text fields as `bodyParamsFrom` reads them, in body order; read for a multipart POST to a page.
 * @throws AdminMappingError For a key that is not a core admin action or has no inventoried response mode.
 */
export function mapAdminToWeb({
  result,
  request,
  modes,
  form,
}: {
  result: RouteKeyResult;
  request: AdminRequestLike;
  modes: ResponseModes;
  form: Readonly<Record<string, string>>;
}): AdminWebTarget {
  const [circuit, action] = circuitAndAction(result);
  const info = modes.modeFor(result.key);
  if (info === undefined) throw new AdminMappingError(result.key, 'no inventoried response mode');
  const { responseMode, contentType } = info;
  const page = responseMode === 'page';
  const requestMethod = request.method.toUpperCase();

  const queryAt = request.url.indexOf('?');
  let query = queryAt === -1 ? undefined : request.url.slice(queryAt + 1);
  if (page && requestMethod === 'POST') {
    const fields = postedFields(request, form);
    if (fields !== '') query = query ? `${query}&${fields}` : fields;
  }

  const webPath = `${WEB_PREFIX_BY_MODE[responseMode]}/${encodeURIComponent(circuit)}/${encodeURIComponent(action)}`;
  const target: AdminWebTarget = {
    path: query === undefined ? webPath : `${webPath}?${query}`,
    // A page reads no body and legacy fills its form scope only for a POST, so every method but HEAD becomes GET.
    method: page && requestMethod !== 'HEAD' ? 'GET' : request.method,
    forwardBody: !page,
    headers: Object.freeze({ [ORIGINAL_URL_HEADER]: request.url }),
    responseMode,
  };
  return Object.freeze(contentType === undefined ? target : { ...target, contentType });
}
