// Maps an admin action the active cut-over version serves from the target to the web request, by its inventoried response mode.
import type { RouteKeyResult } from '@opt2/platform/legacy-compat';
import type { AdminResponseMode, ResponseModes } from './response-modes.js';

const ADMIN_PREFIX = 'admin:';

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

/** Request facts the mapping reads; a Fastify request satisfies it. */
export interface AdminRequestLike {
  /** Request target as received: path and query. */
  readonly url: string;
  /** Request-line method, not an `X-HTTP-Method-Override`. */
  readonly method: string;
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

/**
 * Method and body web receives: a page keeps a POST with its body and a HEAD, and gets any other method as a bodiless
 * GET, since legacy fills the form scope only for a POST; the other modes keep both as sent.
 */
function webMethodOf(responseMode: AdminResponseMode, method: string): Pick<AdminWebTarget, 'method' | 'forwardBody'> {
  if (responseMode !== 'page') return { method, forwardBody: true };
  const upper = method.toUpperCase();
  if (upper === 'POST') return { method: upper, forwardBody: true };
  return { method: upper === 'HEAD' ? upper : 'GET', forwardBody: false };
}

/**
 * The web request for an admin action the active version marks `target`: the web path, the original query byte for
 * byte, and the method and body {@link webMethodOf} gives; the dispatcher merges `headers` after stripping inbound
 * `X-OPT2-*` headers.
 * @throws AdminMappingError For a key that is not a core admin action or has no inventoried response mode.
 */
export function mapAdminToWeb({
  result,
  request,
  modes,
}: {
  result: RouteKeyResult;
  request: AdminRequestLike;
  modes: ResponseModes;
}): AdminWebTarget {
  const [circuit, action] = circuitAndAction(result);
  const info = modes.modeFor(result.key);
  if (info === undefined) throw new AdminMappingError(result.key, 'no inventoried response mode');
  const { responseMode, contentType } = info;
  const queryAt = request.url.indexOf('?');
  const webPath = `${WEB_PREFIX_BY_MODE[responseMode]}/${encodeURIComponent(circuit)}/${encodeURIComponent(action)}`;
  const target: AdminWebTarget = {
    path: queryAt === -1 ? webPath : `${webPath}${request.url.slice(queryAt)}`,
    ...webMethodOf(responseMode, request.method),
    headers: Object.freeze({ [ORIGINAL_URL_HEADER]: request.url }),
    responseMode,
  };
  return Object.freeze(contentType === undefined ? target : { ...target, contentType });
}
