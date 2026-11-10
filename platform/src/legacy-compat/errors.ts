// Port of the Masa JSON API error map and the platform's legacy error classes (jsonApiUtility.cfc:1318-1402).
import { buildEnvelope, paramsWithoutMethod, serializeResponse, type SerializedLegacyResponse } from './envelope.js';
import { isDefinedApiName, isValidVariableName, type ApiNameContext } from './jsonapi-names.js';

/** Exception types `processRequest` catches by name; anything else falls to `catch (Any e)`. */
export type LegacyApiErrorType =
  | 'authorization'
  | 'invalidAccessToken'
  | 'accessTokenExpired'
  | 'disabled'
  | 'invalidParameters'
  | 'invalidEntityCall'
  | 'invalidMethodCall'
  | 'badRequest'
  | 'invalidTokens'
  | 'server_error';

/** Status and error body one catch block answers with. */
export interface LegacyErrorSpec {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const spec = (status: number, code: string, message: string): LegacyErrorSpec => Object.freeze({ status, code, message });

/** The catch blocks of `processRequest`, one row per caught type (jsonApiUtility.cfc:1318-1402). */
export const LEGACY_ERROR_MAP: Readonly<Record<LegacyApiErrorType, LegacyErrorSpec>> = Object.freeze({
  authorization: spec(401, 'invalid_request', 'Insufficient Account Permissions'),
  invalidAccessToken: spec(401, 'invalid_token', 'Invalid Access Token'),
  accessTokenExpired: spec(401, 'invalid_token', 'Access Token Expired'),
  disabled: spec(400, 'invalid_request', 'The JSON API disabled'),
  invalidParameters: spec(400, 'invalid_request', 'Invalid parameters'),
  invalidEntityCall: spec(400, 'invalid_request', 'Invalid reference to persisted entity'),
  invalidMethodCall: spec(400, 'invalid_request', 'Invalid method call'),
  badRequest: spec(400, 'invalid_request', 'Bad Request'),
  invalidTokens: spec(400, 'invalid_request', 'Invalid CSRF tokens'),
  server_error: spec(500, 'server_error', 'Unhandled Exception'),
});

// Legacy throws use exact case. An uncaught type such as 'invalid_token' (jsonApiUtility.cfc:762) is a 500.
/** The map row for `type`, or the `catch (Any e)` row for any type no catch names. */
export function errorSpec(type: string): LegacyErrorSpec {
  return Object.hasOwn(LEGACY_ERROR_MAP, type)
    ? LEGACY_ERROR_MAP[type as LegacyApiErrorType]
    : LEGACY_ERROR_MAP.server_error;
}

// Every catch block names its exception `e`, so `isDefined('e')` holds there (oracle: `?method=e` reports "e").
const CATCH_VARIABLE = 'e';

// Request parameters and cookies never make a bare name defined (searchImplicitScopes=false; oracle:
// `?method=content&content=x` reports "invalid"), so the context carries request facts only, no parameter names.
/** Method an error envelope reports: `param default="undefined"`, then `invalid` unless a defined variable name (jsonApiUtility.cfc:1319-1322). */
export function reportedMethod(method: string | undefined, ctx: ApiNameContext = {}): string {
  const name = method ?? 'undefined';
  if (!isValidVariableName(name)) return 'invalid';
  return name.toLowerCase() === CATCH_VARIABLE || isDefinedApiName(name, ctx) ? name : 'invalid';
}

/** Options of a legacy JSON API error response. */
export interface LegacyErrorResponseOptions {
  /** `params.method` at the throw point; undefined when legacy never set it. */
  method?: string;
  /** Merged request params, echoed only when `suppressAPIParams` is false. */
  params?: Record<string, unknown>;
  /** Request facts deciding which names `isDefined` resolves at the throw point. */
  methodCtx?: ApiNameContext;
  suppressAPIParams?: boolean;
  /** `request.mura404`, which forces status 404. */
  mura404?: boolean;
  /** `WWW-Authenticate` value legacy set before throwing. */
  wwwAuthenticate?: string;
}

/** Error envelope response for an exception of `type`, as the matching catch block serializes it. */
export function legacyErrorResponse(type: string, a: LegacyErrorResponseOptions = {}): SerializedLegacyResponse {
  const { status, code, message } = errorSpec(type);
  const envelope = buildEnvelope({
    method: reportedMethod(a.method, a.methodCtx),
    params: paramsWithoutMethod(a.params ?? {}),
    // Key order follows the ACF wire bytes ({"message":…,"code":…}), so body and ETag match legacy exactly.
    error: { message, code },
  });
  const response = serializeResponse(envelope, {
    statusCode: status,
    suppressAPIParams: a.suppressAPIParams,
    mura404: a.mura404,
  });
  if (a.wwwAuthenticate !== undefined) response.headers['WWW-Authenticate'] = a.wwwAuthenticate;
  return response;
}

// The 403 save-errors response (jsonApiUtility.cfc:1310-1311) is `serializeSaveResult` in envelope.ts, its only implementation.

/** Options a `LegacyApiError` carries to its response. */
export interface LegacyApiErrorOptions {
  method?: string;
  params?: Record<string, unknown>;
  methodCtx?: ApiNameContext;
  wwwAuthenticate?: string;
  data?: unknown;
}

/** A legacy JSON API exception; the service-kit error handler answers it with `legacyErrorResponse`. */
export class LegacyApiError extends Error {
  override readonly name: string = 'LegacyApiError';
  readonly method: string | undefined;
  readonly params: Record<string, unknown> | undefined;
  readonly methodCtx: ApiNameContext | undefined;
  readonly wwwAuthenticate: string | undefined;
  readonly data: unknown;

  constructor(
    readonly type: LegacyApiErrorType | string,
    opts: LegacyApiErrorOptions = {},
  ) {
    super(`${type}: ${errorSpec(type).message}`);
    this.method = opts.method;
    this.params = opts.params;
    this.methodCtx = opts.methodCtx;
    this.wwwAuthenticate = opts.wwwAuthenticate;
    this.data = opts.data;
  }
}

/** Response surface of an unavailable condition; `auto` lets the route family decide. */
export type LegacyErrorSurface = 'api' | 'admin' | 'auto';

/** Base class of every fail-closed and wait-timeout condition; unavailable.ts renders it as the legacy 503. */
export class LegacyServiceUnavailableError extends Error {
  override readonly name: string = 'LegacyServiceUnavailableError';

  constructor(
    message = 'Service Unavailable',
    readonly surface: LegacyErrorSurface = 'auto',
    readonly reason?: string,
  ) {
    super(message);
  }
}
