// Legacy-shaped 503 for every unavailable path: the owner refused, timed out or answered 502/503/504, or the gateway cannot serve.
import {
  LegacyServiceUnavailableError,
  buildEnvelope,
  canonicalMethodName,
  errorSpec,
  fixtureDispatchItems,
  isCfUuid,
  legacyHeaders,
  paramsWithoutMethod,
  serializeResponse,
  unavailableResponseFor,
  type LegacyUnavailableResponse,
  type RouteFamily,
  type RouteKeyOptions,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { ServiceUnavailableError, sendLegacyResponse, type FastifyReply, type LegacySurface } from '@opt2/platform/service-kit';

/** Surface a fail-closed 503 is rendered on: the JSON API envelope or the legacy error page. */
export type FailSurface = LegacySurface;

/** Inputs of a fail-closed 503; `method` and `params` are what the API envelope reports, `route` what its log line names. */
export interface FailContext {
  surface: FailSurface;
  method?: string;
  params?: Record<string, unknown>;
  /** True when `method` is the fixture front controller's: the 503 is the fixture envelope, reporting it as is. */
  fixture?: boolean;
  /** Route key: the matched entry's route, else the computed key. */
  route?: string;
  /** What serves the route: its callee service, `web` or `legacy`. */
  owner?: string;
}

/** Why a request fails closed, written as its one `fail-closed` line. */
export interface FailCause {
  /** Fixed text after `fail-closed: `, naming what failed; never request input. */
  reason: string;
  /** The failure behind the 503, logged as `error`. */
  error?: unknown;
  /** `warn` for a 503 that no unavailability or fault caused; `error` by default. */
  level?: 'error' | 'warn';
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

/** The modules the fixture front controller dispatches (legacy-fixtures/cfml/api.cfm:5). */
const FIXTURE_MODULES: ReadonlySet<string> = new Set(['people']);
/** api.cfm's method for a path outside its grammar. */
const FIXTURE_INVALID_METHOD = 'invalid';
const FIXTURE_MAX_SEGMENTS = 5;

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

// api.cfm reads the method from its path info alone, never from a `method` parameter (api.cfm:36-58).
/** api.cfm's method for its path_info `items` as fixtureDispatchItems reads them: `<module>.<resource>[.<action>][.<tail>]`, a CF UUID tail left out. */
function fixtureMethodOf(items: readonly string[] | undefined): string {
  if (items === undefined || items.length > FIXTURE_MAX_SEGMENTS) return FIXTURE_INVALID_METHOD;
  const [module, resource, , action, tail] = items;
  if (module === undefined || resource === undefined || !FIXTURE_MODULES.has(module)) return FIXTURE_INVALID_METHOD;
  const parts = [module, resource];
  if (action !== undefined) parts.push(action);
  if (tail !== undefined && !isCfUuid(tail)) parts.push(tail);
  return parts.join('.');
}

/** Fail context of a request on `path` under the configBean `opts.context`; a reload answers on the surface of the route it reloads in front of. */
export function failContextFor(
  result: RouteKeyResult | undefined,
  path: string,
  opts: Pick<RouteKeyOptions, 'context'> = {},
): FailContext {
  if (result === undefined) return { surface: surfaceForFamily(undefined, path) };
  const route = result.afterReload ?? result;
  const surface = surfaceForFamily(route.family, path);
  if (surface === 'admin') return { surface };
  if (route.family === 'fixture') {
    const query = path.indexOf('?');
    const items = fixtureDispatchItems(query === -1 ? path : path.slice(0, query), opts);
    return { surface, method: fixtureMethodOf(items), params: route.params, fixture: true };
  }
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

/** What an unavailable `error` names: its callee, else its platform reason, else `dependency unavailable`. */
export function unavailableCauseOf(error: unknown): string {
  if (error instanceof ServiceUnavailableError) return `${error.service} unavailable`;
  if (error instanceof LegacyServiceUnavailableError && error.reason !== undefined) return error.reason.replaceAll('-', ' ');
  return 'dependency unavailable';
}

// Params are suppressed and an error carries no data, so the fixture serializer hints and useDataNamespace change no byte.
/** The fixture envelope's 503 naming `method` as is: envelope.cfc `fail` writes the `server_error` row code first. */
function fixtureUnavailableResponse(method: string, params: Record<string, unknown> = {}): LegacyUnavailableResponse {
  const { code, message } = errorSpec('server_error');
  const { headers, body } = serializeResponse(buildEnvelope({ method, params: paramsWithoutMethod(params), error: { code, message } }));
  return { status: 503, headers: { ...headers, ...legacyHeaders() }, body };
}

/** The legacy-shaped 503 of `ctx`. */
function unavailableResponseOf(ctx: FailContext): LegacyUnavailableResponse {
  if (ctx.fixture === true && ctx.surface === 'api' && ctx.method !== undefined) {
    return fixtureUnavailableResponse(ctx.method, ctx.params);
  }
  return unavailableResponseFor(ctx.surface, { method: ctx.method, params: ctx.params });
}

/**
 * Sends the legacy-shaped 503 of `ctx`, dropping headers copied before it, and logs `cause` as its one `fail-closed` line;
 * a reply whose headers left is returned as is, unlogged.
 */
export function failClosed(reply: FastifyReply, ctx: FailContext, cause: FailCause): FastifyReply {
  if (reply.sent || reply.raw.headersSent) return reply;
  const fields = {
    route: ctx.route,
    httpMethod: reply.request.method,
    statusCode: 503,
    ...(cause.error === undefined ? {} : { error: serializeError(cause.error) }),
  };
  if (cause.level === 'warn') reply.log.warn(fields, `fail-closed: ${cause.reason}`);
  else reply.log.error(fields, `fail-closed: ${cause.reason}`);
  for (const name of Object.keys(reply.getHeaders())) reply.removeHeader(name);
  return sendLegacyResponse(reply, unavailableResponseOf(ctx));
}
