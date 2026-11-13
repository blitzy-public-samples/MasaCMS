// Header rules every forwarding path shares: forwarded-request facts, legacy response headers and web normalisation.
import { LEGACY_HTML_CONTENT_TYPE, legacyHeaders } from '@opt2/platform/legacy-compat';
import type { FastifyReply, FastifyRequest } from '@opt2/platform/service-kit';

/** RFC 7230 hop-by-hop header names, lower-cased, for responses the dispatcher builds itself. */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Names of the forwarded-request headers the gateway adds to every forward. */
export type ForwardedHeaderName = 'x-forwarded-for' | 'x-forwarded-proto' | 'x-forwarded-host';

/** A header value as one field value, repeated fields joined as Node joins them. */
function fieldValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/** `X-Forwarded-*` for a forward: the client address appended to the inbound chain, inbound proto and host preferred. */
export function forwardedHeaders(request: FastifyRequest): Record<ForwardedHeaderName, string> {
  const client = request.socket.remoteAddress ?? request.ip;
  const chain = fieldValue(request.headers['x-forwarded-for']);
  return {
    'x-forwarded-for': chain ? `${chain}, ${client}` : client,
    'x-forwarded-proto': fieldValue(request.headers['x-forwarded-proto']) || request.protocol,
    'x-forwarded-host': fieldValue(request.headers['x-forwarded-host']) || (request.headers.host ?? request.host),
  };
}

/** Sets each legacy response header (`Generator`, HSTS) the reply lacks; for target and web responses only. */
export function applyLegacyHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(legacyHeaders())) {
    if (!reply.hasHeader(name)) reply.header(name, value);
  }
}

/** The web path a response answered (query allowed) and its status, which select the path-specific rules. */
export interface WebResponseFacts {
  path: string;
  statusCode: number;
}

const WEB_PAGE_PATH = /^\/(?:opt2\/)?admin\/[^/?#]+\/[^/?#]+(?:[?#]|$)/;
const WEB_RUNTIME_ASSET_PATH = /^\/_next\//;
const NEXT_HEADER_PREFIX = 'x-nextjs-';
const NEXT_ROUTER_VARY_MEMBERS: ReadonlySet<string> = new Set([
  'rsc',
  'next-router-state-tree',
  'next-router-prefetch',
  'next-router-segment-prefetch',
]);
const NEXT_REDIRECT_STATUS = 307;
const NEXT_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

/** True for web's page-mode paths: `/admin/<circuit>/<action>` and `/opt2/admin/<module>/<screen>`. */
export function isWebPagePath(path: string): boolean {
  return WEB_PAGE_PATH.test(path);
}

/** True for a page-mode 307 (Next `redirect()`), which the client receives as a 302 with an empty body. */
export function isWebPageRedirect(facts: WebResponseFacts): boolean {
  return facts.statusCode === NEXT_REDIRECT_STATUS && isWebPagePath(facts.path);
}

/** `Vary` without Next's router members; undefined when none remain, the value as sent when none were present. */
function varyWithoutRouterMembers(value: string | string[]): string | string[] | undefined {
  const members = (Array.isArray(value) ? value : [value])
    .flatMap((item) => item.split(','))
    .map((member) => member.trim())
    .filter((member) => member !== '');
  const kept = members.filter((member) => !NEXT_ROUTER_VARY_MEMBERS.has(member.toLowerCase()));
  if (kept.length === members.length) return value;
  return kept.length === 0 ? undefined : kept.join(', ');
}

/**
 * Web response headers as the client receives them, keyed lower-case; `undefined` values dropped, `Set-Cookie` order kept.
 * Without `facts` only the every-mode rules apply; `/_next/**` responses pass unchanged.
 */
export function normaliseWebResponseHeaders(
  headers: Readonly<Record<string, string | number | string[] | undefined>>,
  facts?: WebResponseFacts,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? [...value] : String(value);
  }
  if (facts !== undefined && WEB_RUNTIME_ASSET_PATH.test(facts.path)) return out;

  for (const name of Object.keys(out)) {
    if (name.startsWith(NEXT_HEADER_PREFIX)) delete out[name];
  }
  if (out.vary !== undefined) {
    const vary = varyWithoutRouterMembers(out.vary);
    if (vary === undefined) delete out.vary;
    else out.vary = vary;
  }

  if (facts === undefined || !isWebPagePath(facts.path)) return out;
  out['content-type'] = LEGACY_HTML_CONTENT_TYPE;
  if (facts.statusCode === NEXT_REDIRECT_STATUS) {
    out['cache-control'] = 'no-cache';
    out.pragma = 'no-cache';
    delete out.expires;
    // The 302 is sent without Next's body, so that body's framing must not reach the client.
    delete out['content-length'];
    delete out['transfer-encoding'];
  } else if (out['cache-control'] === NEXT_CACHE_CONTROL) {
    delete out['cache-control'];
  }
  return out;
}

/** A copy of `headers` without `name`, matched case-insensitively. */
export function withoutHeader<T>(headers: Readonly<Record<string, T>>, name: string): Record<string, T> {
  const target = name.toLowerCase();
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== target));
}
