// Legacy-shaped 503 for every unavailable path: the owner refused, timed out or answered 502/503/504, or the gateway cannot serve.
import {
  LegacyServiceUnavailableError,
  canonicalMethodName,
  unavailableResponseFor,
  type RouteFamily,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { sendLegacyResponse, type FastifyReply, type LegacySurface } from '@opt2/platform/service-kit';

/** Surface a fail-closed 503 is rendered on: the JSON API envelope or the legacy error page. */
export type FailSurface = LegacySurface;

/** Inputs of a fail-closed 503; `method` and `params` are what the API envelope reports. */
export interface FailContext {
  surface: FailSurface;
  method?: string;
  params?: Record<string, unknown>;
}

// Unlike the platform's family-only unavailableSurfaceForFamily, render and feed answer the error page (legacy's
// onError answers their failures outside the JSON envelope), and the opt2 family splits by path below.
/** Families whose 503 is the JSON API envelope: JSON/AJAX and REST (OAuth included), fixtures and the site monitor. */
const API_FAMILY_LIST: readonly RouteFamily[] = ['api', 'rest', 'fixture', 'sitemonitor'];
const API_FAMILIES: ReadonlySet<string> = new Set(API_FAMILY_LIST);

/** OPT-2 namespaces answering in the envelope whatever their family: the stub, the web relay alias and the relay. */
const API_PATH_PREFIXES: readonly string[] = ['/opt2/stub', '/opt2/svc', '/internal/v1/relay'];

/** Envelope prefixes when no route key is known, matched after a leading `/index.cfm` is removed. */
const API_FALLBACK_PREFIXES: readonly string[] = ['/_api/', '/tasks/', '/legacy-fixtures/'];
const INDEX_CFM = /^\/index\.cfm(?=\/|$)/;

/** REST credential-flow keys, which resolve no JSON API method. */
const REST_CREDENTIAL_BODIES: ReadonlySet<string> = new Set(['oauth', 'oauth2', 'tokeninfo']);

const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

// reply-from's own status for a refused connection is 500, so classification reads codes, never that status.
/** Node, undici and reply-from codes of a refused, reset, closed, unreachable, timed-out or malformed exchange. */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'FST_REPLY_FROM_TIMEOUT',
  'FST_REPLY_FROM_HTTP_REQUEST_TIMEOUT',
  'FST_REPLY_FROM_HTTP2_REQUEST_TIMEOUT',
  'FST_REPLY_FROM_HTTP2_SESSION_TIMEOUT',
  'FST_REPLY_FROM_GATEWAY_TIMEOUT',
  'FST_REPLY_FROM_SERVICE_UNAVAILABLE',
  'FST_REPLY_FROM_BAD_GATEWAY',
]);

/** Connection-establishment failure codes, after which the callee never received the request. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Surface of a request's 503 from its route family, or from its path alone when `family` is undefined. */
export function surfaceForFamily(family: string | undefined, path: string): FailSurface {
  const query = path.indexOf('?');
  const lower = (query === -1 ? path : path.slice(0, query)).toLowerCase();
  if (API_PATH_PREFIXES.some((prefix) => isUnder(lower, prefix))) return 'api';
  if (family !== undefined) return API_FAMILIES.has(family) ? 'api' : 'admin';
  const legacyPath = lower.replace(INDEX_CFM, '');
  return API_FALLBACK_PREFIXES.some((prefix) => legacyPath.startsWith(prefix)) ? 'api' : 'admin';
}

// Legacy sets `params.method` to the operation it invokes (jsonApiUtility.cfc:1250-1305, 1451-1466), so the envelope
// reports the resolved operation: in the caller's spelling for a direct method call, otherwise in legacy's.
/** `params.method` legacy holds once the key's operation runs; undefined or the request's value when none is resolved. */
function resolvedMethod(route: RouteKeyResult): string | undefined {
  const supplied = route.params.method;
  if (route.family !== 'api' && route.family !== 'rest') return supplied;
  const body = route.baseKey.slice(route.family.length + 1);
  if (body.startsWith('!') || (route.family === 'rest' && REST_CREDENTIAL_BODIES.has(body))) return supplied;
  const dot = body.indexOf('.');
  const operation = dot === -1 ? body : body.slice(dot + 1);
  if (operation.startsWith('http-')) return supplied;
  const name = operation.startsWith('~') ? operation.slice(1) : operation;
  return supplied !== undefined && supplied.toLowerCase() === name ? supplied : canonicalMethodName(name);
}

/** Fail context of a request; a reload answers on the surface of the route it reloads in front of. */
export function failContextFor(result: RouteKeyResult | undefined, path: string): FailContext {
  if (result === undefined) return { surface: surfaceForFamily(undefined, path) };
  const route = result.afterReload ?? result;
  const surface = surfaceForFamily(route.family, path);
  if (surface === 'admin') return { surface };
  return { surface, method: resolvedMethod(route), params: route.params };
}

/** True for a 502/503/504 status, or an error whose cause chain reports a transport failure or unavailability. */
export function isTargetUnavailable(input: unknown): boolean {
  if (typeof input === 'number') return UNAVAILABLE_STATUSES.has(input);
  const seen = new Set<unknown>();
  for (let error = input; typeof error === 'object' && error !== null && !seen.has(error); ) {
    seen.add(error);
    if (error instanceof LegacyServiceUnavailableError) return true;
    const { code, cause } = error as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && TRANSPORT_FAILURE_CODES.has(code)) return true;
    error = cause;
  }
  return false;
}

/** True when `error` failed to establish the connection, so the callee never received the request. */
export function neverSent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && NOT_SENT_CODES.has(code);
}

/** True for any platform unavailable condition (service, bridge, window, barrier or freeze). */
export function isLegacyUnavailable(error: unknown): error is LegacyServiceUnavailableError {
  return error instanceof LegacyServiceUnavailableError;
}

/** Sends the legacy-shaped 503 of `ctx`, dropping headers copied before it; a reply whose headers left is returned as is. */
export function failClosed(reply: FastifyReply, ctx: FailContext): FastifyReply {
  if (reply.sent || reply.raw.headersSent) return reply;
  for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
  return sendLegacyResponse(reply, unavailableResponseFor(ctx.surface, { method: ctx.method, params: ctx.params }));
}
