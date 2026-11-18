// Fastify factory of @opt2/platform/service-kit: auth, request context, legacy body parsing, headers, errors, logging and shutdown.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseQuery } from 'node:querystring';
import { Transform, type Duplex, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart, { type MultipartFile, type MultipartValue } from '@fastify/multipart';
import { context, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';
import Fastify, { errorCodes, type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  AuthDenial,
  createAuthFromEnv,
  registerAuth,
  renderAuthDenial,
  type AuthOverrides,
  type AuthSetup,
  type Opt2AuthContext,
} from '../auth/index.js';
import {
  LEGACY_BAD_REQUEST_RESPONSE,
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LEGACY_REQUEST_HEAD_LIMIT_BYTES,
  LegacyApiError,
  LegacyServiceUnavailableError,
  cfNumberString,
  isCfUuid,
  isJsonContentType,
  legacyErrorResponse,
  legacyHeaders,
  legacyScopesFrom,
  unavailableResponseFor,
  type LegacyScopes,
  type UnavailableSurface,
} from '../legacy-compat/index.js';
import { createLogger, fastifyLoggerOptions, serializeError, type LogFields, type Logger } from '../logging/index.js';
import { DatabaseUnavailableError, createPool, type TenantDb } from '../tenancy/index.js';
import { shutdownTracing } from '../tracing/index.js';
import { createServiceClient, SERVICE_CALL_TIMEOUT_MS, type ServiceClient } from './client.js';
import { systemClock, type Clock } from './clock.js';
import {
  newRequestContext,
  RequestAbortedError,
  requestContext,
  requestIdFrom,
  UnpublishedEventsError,
  type RequestContextStore,
} from './context.js';
import { EnvValidationError, type BaseEnv } from './env.js';
import { EVENT_SCOPE, eventScopeOf, type EventLogScope } from './event-scope.js';
import { createMultipartHeaderScanner, type MultipartHeaderScanner } from './multipart-headers.js';

/** Surface a request's legacy error responses are rendered on. */
export type LegacySurface = UnavailableSurface;

/** Memory bound of every route's body and multipart file and field; legacy reads non-POST and chunked bodies of any size. */
export const LEGACY_POST_LIMIT_BYTES = 100 * 1024 * 1024;

/** Largest POST Content-Length the legacy servlet container accepts; it answers a larger one with its Post Size page. */
export const LEGACY_MAX_POST_CONTENT_LENGTH = 20 * 1024 * 1024 + 1;

/**
 * Default request-head limit (Node `maxHeaderSize`): legacy's, plus 64 KiB for what the gateway adds to a head it
 * forwards (user and invocation tokens, `X-Forwarded-*`, trace context, request id), so a head the gateway admits is admitted here.
 */
export const SERVICE_MAX_HEADER_SIZE = LEGACY_REQUEST_HEAD_LIMIT_BYTES + 64 * 1024;

/** Log `route` of a request no route matched or the router rejected; never its path, which can carry session ids, secrets or PII. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** Options of {@link createService}. */
export interface CreateServiceOptions<E extends BaseEnv = BaseEnv> {
  name: string;
  /** Package version, written as the log `version`. */
  version: string;
  /** Parsed environment from `loadEnv`. */
  env: E;
  /** Auth pieces replacing those built from `env`, such as a test signer's verifiers. */
  verifierOverride?: AuthOverrides;
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Prebuilt database; excludes `schema`. */
  pool?: TenantDb;
  /** Schema whose pool createService opens from `env`; excludes `pool`. */
  schema?: string;
  /** Defaults to a stdout logger for this service. */
  logger?: Logger;
  /** Defaults to {@link defaultSurfaceOf}. */
  surfaceOf?: (request: FastifyRequest) => LegacySurface;
  /** Root-served path prefixes routed in any letter case, as legacy compares them; a matching path is routed under the spelling given here. */
  noCasePathPrefixes?: readonly string[];
  /** Routes `/legacy-fixtures/cfml/api.cfm/` paths with the module, resource, action and tail segments lower-cased, as api.cfm reads them. */
  legacyFixturePaths?: boolean;
  /** Answers legacy's start-up scan failure with its error page on root-served paths; defaults to true. */
  legacyStartupScan?: boolean;
  /** Whether the legacy servlet container refuses the request target; a refused one gets the container's empty 400 ahead of every other check. */
  containerRefusesTarget?: (request: FastifyRequest) => boolean;
  /** Whether a request skips the start-up scan, as a path naming no template does, whose 404 a scan fault leaves standing on legacy. */
  skipsStartupScan?: (request: FastifyRequest) => boolean;
  /** Request-head limit, also the path-parameter limit; defaults to {@link SERVICE_MAX_HEADER_SIZE}. A head over it gets legacy's bare 400. */
  maxHeaderSize?: number;
}

/** Process runtime of one service, decorated as `app.opt2`. */
export interface Opt2Runtime<E extends BaseEnv = BaseEnv> {
  readonly name: string;
  readonly version: string;
  readonly env: E;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly auth: AuthSetup;
  readonly client: ServiceClient;
  readonly db?: TenantDb;
  /** Closes the server, the service client and the pool, then stops tracing; runs once, attempts every step, rejects with the failure or an AggregateError. */
  shutdown(): Promise<void>;
}

/** Tenant and site of a request, from verified user claims only; decorated as `request.opt2`. */
export interface Opt2RequestScope {
  tenantId?: string;
  site?: string;
}

/** What a handler records for its request's log lines with {@link recordLogScope}. */
export interface RequestLogScope {
  /** Fixed route identifier, such as a route key, logged in place of the route template; never raw request input. */
  route?: string;
  /** Tenant and user of an identity the handler established itself; a verified token's own win. */
  tenantId?: string;
  userId?: string;
}

/** Route `config.opt2Log`: how service-kit logs the route's requests. */
export interface Opt2RouteLogConfig {
  /** Level of the completion line of a response below 400, `debug` for a polling route; defaults to `info`. */
  successLevel?: 'debug' | 'info';
}

/** Route `config.opt2Outbox`: the answer of a request whose committed outbox events were not all published. */
export interface Opt2RouteOutboxConfig {
  /**
   * `withhold` (default) closes the socket unanswered; `unavailable` answers the legacy 503 with {@link UNPUBLISHED_EVENTS_HEADER},
   * for an idempotent route whose caller re-sends it, and bounds the flush by the caller's SERVICE_CALL_TIMEOUT_MS.
   */
  incompleteFlush?: 'withhold' | 'unavailable';
}

/** Header of the 503 a route set to `incompleteFlush: 'unavailable'` answers: the count of its committed events left to the outbox sweep. */
export const UNPUBLISHED_EVENTS_HEADER = 'X-Opt2-Unpublished-Events';

/** Time kept, inside the caller's SERVICE_CALL_TIMEOUT_MS, for a route set to `incompleteFlush: 'unavailable'` to answer after its flush. */
export const FLUSH_ANSWER_MARGIN_MS = 1_000;

declare module 'fastify' {
  interface FastifyInstance {
    opt2: Opt2Runtime;
  }
  interface FastifyRequest {
    opt2: Opt2RequestScope;
  }
  interface FastifyContextConfig {
    opt2Log?: Opt2RouteLogConfig;
    opt2Outbox?: Opt2RouteOutboxConfig;
  }
}

/** One multipart file part, spooled to a temporary file that is deleted once the response ends. */
interface MultipartFileData {
  field: string;
  filename: string;
  mimetype: string;
  /** The part's content type as ColdFusion `fileUpload` reports it, parameters included; `mimetype` when its headers were not scanned. */
  contentType: string;
  size: number;
  /** Lowercase hex SHA-256 of the part's bytes. */
  sha256: string;
  /** A new read stream of the part's bytes; valid until the response ends. */
  stream(): Readable;
}

/** A file part as `onFile` spooled it: its temporary file, byte count, SHA-256 and `fileUpload` content type. */
interface SpooledFile {
  part: MultipartFile;
  filepath: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** A legacy-compat response object; `statusText` sets the reason phrase. */
interface LegacyResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer | Readable;
  statusText?: string;
}

const CONTEXT = Symbol('opt2.service-kit.context');
const FILES = Symbol('opt2.service-kit.files');
const UPLOADS = Symbol('opt2.service-kit.uploads');
const PART_HEADERS = Symbol('opt2.service-kit.part-headers');
const BODY_LIMIT = Symbol('opt2.service-kit.body-limit');
const RESPONSE_CLOSED = Symbol('opt2.service-kit.response-closed');
const REASON = Symbol('opt2.service-kit.reason');
const LOG_SCOPE = Symbol('opt2.service-kit.log-scope');
const DISCONNECT = Symbol('opt2.service-kit.disconnect');
const CONTAINER = Symbol('opt2.service-kit.container');

/** Per-request state kept on module-private symbols. */
interface KitRequestState {
  [CONTEXT]: RequestContextStore | null;
  /** Aborts with a RequestAbortedError once the response closes before it ended, which is the client disconnecting. */
  [DISCONNECT]: AbortSignal | null;
  [FILES]: SpooledFile[] | null;
  /** Temporary files the request spooled that are not yet deleted. */
  [UPLOADS]: string[] | null;
  /** The part headers of a multipart request's body, scanned as it streams. */
  [PART_HEADERS]: MultipartHeaderScanner | null;
  /** The body-limit error that aborted the request's multipart parse. */
  [BODY_LIMIT]: FastifyError | null;
  /** Whether a multipart request's response has closed, after which no further upload is spooled. */
  [RESPONSE_CLOSED]: boolean;
  /** Fixed identifier of why the request was denied or rejected, such as an AuthDenial reason; never request input. */
  [REASON]: string | null;
  /** Route and identity the handler recorded for the request's log lines. */
  [LOG_SCOPE]: RequestLogScope | null;
  /** Whether the response is the legacy servlet container's own, which carries none of Masa's headers. */
  [CONTAINER]: boolean;
  [EVENT_SCOPE]: EventLogScope | null;
}

const ADMIN_PREFIXES: readonly string[] = ['/admin/', '/admin-actions/', '/admin-raw/'];

function stateOf(request: FastifyRequest): KitRequestState {
  return request as unknown as KitRequestState;
}

function pathOf(request: FastifyRequest): string {
  const query = request.url.indexOf('?');
  return query === -1 ? request.url : request.url.slice(0, query);
}

/** Shape of a no-case prefix: a `/`-led printable-ASCII path without `%`, `?` or `#`. */
const NO_CASE_PREFIX = /^\/(?:(?![%?#])[!-~])*$/;

/** Index just past the lead of `url` that reads as `prefix` ignoring case, each `%XX` decoded to its byte; -1 when none. */
function noCaseLeadEnd(url: string, prefix: string): number {
  const want = prefix.toLowerCase();
  let at = 0;
  for (let i = 0; i < want.length; i += 1) {
    let got = url.charAt(at);
    if (got === '%') {
      try {
        // `%2F` reads as `/`, as the legacy container decodes it before contentServer compares the path.
        got = decodeURIComponent(url.slice(at, at + 3));
      } catch {
        // A malformed escape is left for the router to reject.
        return -1;
      }
      at += 3;
    } else {
      at += 1;
    }
    if (got.toLowerCase() !== want.charAt(i)) return -1;
  }
  return at;
}

/** Fastify `rewriteUrl` respelling the longest of `prefixes` that a raw URL starts with, ignoring case, as declared; the rest stays byte for byte. */
function noCaseRewrite(prefixes: readonly string[]): (req: { url?: string }) => string {
  const invalid = prefixes.find((prefix) => !NO_CASE_PREFIX.test(prefix));
  if (invalid !== undefined) throw new TypeError(`noCasePathPrefixes entry ${JSON.stringify(invalid)} is not a /-led ASCII path`);
  const longestFirst = [...prefixes].sort((a, b) => b.length - a.length);
  return (req) => {
    const url = req.url ?? '';
    for (const prefix of longestFirst) {
      const end = noCaseLeadEnd(url, prefix);
      if (end !== -1) return prefix + url.slice(end);
    }
    return url;
  };
}

/** Front controller of the legacy fixtures; the container matches it case-sensitively. */
const FIXTURE_PREFIX = '/legacy-fixtures/cfml/api.cfm/';

/** A `%XX` escape or an ASCII capital letter. */
const SEGMENT_PART = /%([0-9A-Fa-f]{2})|[A-Z]/g;

/** An RFC 3986 unreserved character. */
const UNRESERVED_CHAR = /^[A-Za-z0-9._~-]$/;

/** `segment` lower-cased with its escaped unreserved characters decoded; other escapes stay as sent. */
function lowerSegment(segment: string): string {
  return segment.replace(SEGMENT_PART, (part, hex: string | undefined) => {
    if (hex === undefined) return part.toLowerCase();
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_CHAR.test(char) ? char.toLowerCase() : part;
  });
}

/** Fastify `rewriteUrl` lower-casing segments 1, 2, 4 and a non-UUID 5 of a 2..5-segment api.cfm path, as api.cfm does; the rest stays byte for byte. */
function legacyFixtureRewrite(req: { url?: string }): string {
  const url = req.url ?? '';
  if (!url.startsWith(FIXTURE_PREFIX)) return url;
  const query = url.indexOf('?');
  const end = query === -1 ? url.length : query;
  const segments = url.slice(FIXTURE_PREFIX.length, end).split('/');
  // A trailing `/` is no segment; ignoreTrailingSlash routes it.
  const count = segments.length - (segments.at(-1) === '' ? 1 : 0);
  if (count < 2 || count > 5) return url;
  const lowered = segments.map((segment, i) =>
    i === 2 || (i === 4 && isCfUuid(lowerSegment(segment))) ? segment : lowerSegment(segment),
  );
  return FIXTURE_PREFIX + lowered.join('/') + url.slice(end);
}

/** A key-value object, including fast-querystring's null-rooted dictionaries; never arrays, buffers or streams. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null;
}

/** One deserialized JSON value: simple values as text in the `scalars` form, null as '', objects and arrays as they are. */
function jsonValue(value: unknown, scalars: LegacyParamsOptions['jsonScalars']): unknown {
  if (value === null) return '';
  if (typeof value === 'object') return value;
  if (scalars === 'cfml') {
    if (typeof value === 'boolean') return value ? 'YES' : 'NO';
    if (typeof value === 'number') return cfNumberString(value);
  }
  return String(value);
}

function isJsonRequest(request: FastifyRequest): boolean {
  return isJsonContentType(request.headers['content-type']);
}

/** The value under `key` ignoring case, when it is a string. */
function paramString(params: Record<string, unknown>, key: string): string | undefined {
  const found = Object.keys(params).find((name) => name.toLowerCase() === key);
  const value = found === undefined ? undefined : params[found];
  return typeof value === 'string' ? value : undefined;
}

/** `admin` for `/admin` and the admin, admin-actions and admin-raw paths; `api` otherwise. */
export function defaultSurfaceOf(request: FastifyRequest): LegacySurface {
  const path = pathOf(request);
  return path === '/admin' || ADMIN_PREFIXES.some((prefix) => path.startsWith(prefix)) ? 'admin' : 'api';
}

/** Leads of the paths legacy serves through Masa's own start-up (root and module ajax Application.cfc), whose scan runs unguarded. */
const ROOT_SERVED_LEADS: readonly string[] = ['/_api', '/index.cfm', '/tasks', '/core', '/legacy-fixtures'];

/** Whether `path` is a root-served lead, lies under one, or starts with one of the service's no-case API prefixes. */
function isRootServed(path: string, noCasePrefixes: readonly string[]): boolean {
  return (
    ROOT_SERVED_LEADS.some((lead) => path === lead || path.startsWith(`${lead}/`)) ||
    noCasePrefixes.some((prefix) => path.startsWith(prefix))
  );
}

/** Whether a request on a root-served path, as sent or as routed, fails legacy's start-up scan; before body parsing only the url scope counts. */
function failsRootScan(request: FastifyRequest, noCasePrefixes: readonly string[]): boolean {
  // The router decodes escapes such as `%5F` that the path as sent keeps.
  const paths = [pathOf(request), request.routeOptions.url];
  if (!paths.some((path) => path !== undefined && isRootServed(path, noCasePrefixes))) return false;
  const { url, form } = legacyScopesOf(request);
  return url.failed || form.failed;
}

/** The url and form scopes as Masa's start-up script protection leaves them, failure flags included, and a JSON body as sent. */
export function legacyScopesOf(request: FastifyRequest): LegacyScopes {
  return legacyScopesFrom(request);
}

/** Options of {@link legacyParamsOf}. */
export interface LegacyParamsOptions {
  /** 'string' (default): JSON body booleans and numbers as `String(value)`; 'cfml': as CFML toString renders them (YES/NO, ACF numbers). */
  jsonScalars?: 'string' | 'cfml';
}

/** Legacy's script-protected url then form scope, or JSON body: later keys win ignoring case, keeping their spelling. */
export function legacyParamsOf(request: FastifyRequest, options: LegacyParamsOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const spelling = new Map<string, string>();
  const put = (key: string, value: unknown): void => {
    const previous = spelling.get(key.toLowerCase());
    if (previous !== undefined) delete params[previous];
    spelling.set(key.toLowerCase(), key);
    // Defined, not assigned, so a `__proto__` key stays a data key.
    Object.defineProperty(params, key, { value, writable: true, enumerable: true, configurable: true });
  };
  const { url, form, jsonBody } = legacyScopesOf(request);
  const body = isPlainObject(jsonBody) ? Object.entries(jsonBody).map(([key, item]) => [key, jsonValue(item, options.jsonScalars)] as const) : form.entries;
  for (const [key, value] of [...url.entries, ...body]) put(key, value);
  return params;
}

/** The spooled multipart file parts of a request, in body order. */
export function multipartFilesOf(request: FastifyRequest): MultipartFileData[] {
  return (stateOf(request)[FILES] ?? []).map(({ part, filepath, size, sha256, contentType }) => ({
    field: part.fieldname,
    filename: part.filename,
    mimetype: part.mimetype,
    contentType,
    size,
    sha256,
    stream: () => createReadStream(filepath),
  }));
}

/** Replaces `part` in its body with the field part the multipart plugin attaches for a text part holding `value`. */
function attachAsField(part: MultipartFile, value: string): void {
  const field: MultipartValue<string> = {
    type: 'field',
    fieldname: part.fieldname,
    mimetype: part.mimetype,
    encoding: part.encoding,
    value,
    fieldnameTruncated: false,
    valueTruncated: false,
    fields: part.fields,
  };
  const held = part.fields[part.fieldname];
  if (Array.isArray(held)) held[held.indexOf(part)] = field;
  else part.fields[part.fieldname] = field;
}

/** Deletes the request's spooled uploads once, skipping missing files; never rejects, logging each failed delete. */
async function removeUploads(request: FastifyRequest): Promise<void> {
  const state = stateOf(request);
  const uploads = state[UPLOADS];
  if (uploads === null) return;
  state[UPLOADS] = null;
  const results = await Promise.allSettled(uploads.map((filepath) => rm(filepath, { force: true })));
  for (const result of results) {
    if (result.status === 'rejected') {
      request.log.error({ ...scopeFields(request), error: serializeError(result.reason) }, 'upload cleanup failed');
    }
  }
}

/** Writes a legacy-compat response object: status, reason phrase when given, headers and exact body. */
export function sendLegacyResponse(reply: FastifyReply, res: LegacyResponse): FastifyReply {
  if (res.statusText !== undefined) reply.raw.statusMessage = res.statusText;
  return reply.code(res.status).headers(res.headers).send(res.body);
}

/** The legacy error page at `status`, as legacy `onError` and the admin 404 answer. */
function adminErrorPage(status: number, statusText?: string): LegacyResponse {
  return { status, statusText, headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE }, body: LEGACY_ERROR_PAGE_HTML };
}

/** The answer to an unmatched route: the admin 404 page, or the 404 invalidMethodCall envelope. */
function notFoundResponse(request: FastifyRequest, surface: LegacySurface): LegacyResponse {
  if (surface === 'admin') return adminErrorPage(404);
  const params = legacyParamsOf(request);
  return legacyErrorResponse('invalidMethodCall', { method: paramString(params, 'method'), params, mura404: true });
}

/** Fastify `frameworkErrors`: answers a request the router rejected before any hook ran, and writes its log lines. */
function answerFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
  surfaceOf: (request: FastifyRequest) => LegacySurface,
): void {
  // reply.elapsedTime stays 0 outside the route lifecycle, so latency is timed here.
  const startedAt = performance.now();
  reply.raw.once('finish', () => {
    // This request lacks the decorated reason slot, so the router's fixed error code is passed as the reason.
    logCompletion(request, reply.statusCode, UNMATCHED_ROUTE, Math.round(performance.now() - startedAt), error.code);
  });
  if (error.code === 'FST_ERR_BAD_URL') {
    // Legacy's servlet container rejects a malformed path escape before Masa runs: an empty 400 that closes the connection.
    reply.code(400).header('Connection', 'close').send();
    return;
  }
  // The router rejects before the query string is parsed, and the legacy params read it.
  const query = request.url.indexOf('?');
  request.query = parseQuery(query === -1 ? '' : request.url.slice(query + 1));
  const surface = surfaceOf(request);
  let res: LegacyResponse;
  if (error.code === 'FST_ERR_MAX_PARAM_LENGTH') {
    res = notFoundResponse(request, surface);
  } else {
    request.log.error({ error: serializeError(error) }, 'unhandled error');
    const params = legacyParamsOf(request);
    res =
      surface === 'admin'
        ? adminErrorPage(500, LEGACY_ERROR_STATUS_TEXT)
        : legacyErrorResponse('server_error', { method: paramString(params, 'method'), params });
  }
  // onSend does not run here either; the response's own headers override these.
  reply.headers(legacyHeaders());
  sendLegacyResponse(reply, res);
}

/** Fastify's own request errors below 500, such as an oversized body or an unsupported media type. */
function isFastifyClientError(error: FastifyError): boolean {
  return typeof error.code === 'string' && error.code.startsWith('FST_') && (error.statusCode ?? 500) < 500;
}

const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

/** Whether `err` is Fastify's body-limit error, a body over {@link LEGACY_POST_LIMIT_BYTES}, which service-kit answers as the container's Post Size page. */
export function isBodyTooLargeError(err: unknown): err is FastifyError & { code: typeof BODY_TOO_LARGE } {
  return err instanceof Error && (err as Partial<FastifyError>).code === BODY_TOO_LARGE;
}

/** Service-to-service routes: no legacy request reaches them, and migration sends them batches and file objects of any size. */
const INTERNAL_PREFIX = '/internal/';

/** Whether the legacy container refuses `req` before Masa runs: a POST declaring more than {@link LEGACY_MAX_POST_CONTENT_LENGTH} bytes. */
function exceedsLegacyPostSize(req: IncomingMessage): boolean {
  if (req.method !== 'POST' || (req.url ?? '').startsWith(INTERNAL_PREFIX)) return false;
  return Number(req.headers['content-length']) > LEGACY_MAX_POST_CONTENT_LENGTH;
}

/** The legacy container's answer to a POST over its size limit. */
const POST_SIZE_EXCEEDED: LegacyResponse = {
  status: 400,
  statusText: 'Post Size exceeds the maximum limit.',
  headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE },
  body: '<html><head><title>Error</title></head><body>Post Size exceeds the maximum limit.</body></html>',
};

/** Answers the container's Post Size page without Masa's headers, recording the body-limit code as the rejection reason. */
function sendPostSizeExceeded(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  stateOf(request)[CONTAINER] = true;
  recordOutcomeReason(request, BODY_TOO_LARGE);
  return sendLegacyResponse(reply, POST_SIZE_EXCEEDED);
}

/** Rejection reason of a request target the legacy container refuses. */
const TARGET_REFUSED = 'container-refused-target';

/** Answers the container's refusal of a request target: an empty 400 that closes the connection, hijacked so it carries no Date, Generator or HSTS header. */
function sendTargetRefused(request: FastifyRequest, reply: FastifyReply): void {
  recordOutcomeReason(request, TARGET_REFUSED);
  reply.hijack();
  reply.raw.sendDate = false;
  reply.raw.writeHead(400, { 'Content-Length': '0', Connection: 'close' });
  reply.raw.end();
}

/**
 * Whether `err` is PostgreSQL refusing a value its text or JSON columns cannot hold, such as one with a NUL (U+0000):
 * 22021 for text, 22P05 for a `\u0000` escape in JSON input.
 */
export function isUnstorableTextError(err: unknown): err is { code: '22021' | '22P05' } {
  if (typeof err !== 'object' || err === null) return false;
  const { code, severity, file } = err as { code?: unknown; severity?: unknown; file?: unknown };
  if (typeof severity !== 'string') return false;
  // 22P05 is also an encoding conversion's untranslatable character (mbutils.c), which no stored client value causes.
  return code === '22021' || (code === '22P05' && file === 'jsonfuncs.c');
}

/** Tenant, user and recorded event of a request, for its log lines; verified values win over recorded ones, both over the delivery's tenant. */
function scopeFields(request: FastifyRequest): Pick<LogFields, 'tenantId' | 'userId' | 'eventId'> {
  const { [CONTEXT]: store, [LOG_SCOPE]: recorded } = stateOf(request);
  const event = eventScopeOf(request);
  const fields: Pick<LogFields, 'tenantId' | 'userId' | 'eventId'> = {};
  const tenantId = store?.tenantId ?? recorded?.tenantId ?? event?.tenantId;
  if (tenantId !== undefined) fields.tenantId = tenantId;
  const userId = store?.user?.sub ?? recorded?.userId;
  if (userId !== undefined) fields.userId = userId;
  if (event?.eventId !== undefined) fields.eventId = event.eventId;
  return fields;
}

/** Copies the identities registerAuth verified into the request store, `request.opt2` and the active span's attributes. */
function bindVerifiedScope(request: FastifyRequest): void {
  const store = stateOf(request)[CONTEXT];
  const verified = request.opt2Auth as Opt2AuthContext | null;
  const { user, userToken, service } = verified ?? {};
  if (store !== null) {
    Object.assign(store, { user, userToken, service, tenantId: user?.tid, site: user?.site });
  }
  request.opt2 = { tenantId: user?.tid, site: user?.site };
  const span = trace.getActiveSpan();
  if (span !== undefined) {
    if (request.routeOptions.url !== undefined) span.setAttribute('http.route', request.routeOptions.url);
    span.setAttribute('opt2.request_id', request.id);
    if (user !== undefined) {
      span.setAttributes({ 'opt2.tenant_id': user.tid, 'opt2.site': user.site, 'enduser.id': user.sub });
    }
    if (service !== undefined) span.setAttribute('opt2.caller', service.name);
  }
}

/** Opts a read into abandonment: once its client disconnects, `throwIfRequestAborted()` and service calls of `request` throw RequestAbortedError. */
export function abandonOnDisconnect(request: FastifyRequest): void {
  const { [CONTEXT]: store, [DISCONNECT]: signal } = stateOf(request);
  if (store !== null && signal !== null) store.signal = signal;
}

/** Records why `request` was denied or rejected, for its WARNING line; `reason` is a fixed identifier such as an error type, never request input. */
export function recordOutcomeReason(request: FastifyRequest, reason: string): void {
  stateOf(request)[REASON] = reason;
}

/** Records `scope` for the request's log lines; a field `scope` leaves undefined or empty keeps its earlier recorded value. */
export function recordLogScope(request: FastifyRequest, scope: RequestLogScope): void {
  const state = stateOf(request);
  const recorded = state[LOG_SCOPE];
  state[LOG_SCOPE] = {
    route: scope.route || recorded?.route,
    tenantId: scope.tenantId || recorded?.tenantId,
    userId: scope.userId || recorded?.userId,
  };
}

/** Log `route` of a request: the recorded route, else the matched route template, else {@link UNMATCHED_ROUTE}. */
function loggedRouteOf(request: FastifyRequest): string {
  return stateOf(request)[LOG_SCOPE]?.route ?? request.routeOptions.url ?? UNMATCHED_ROUTE;
}

/** Message of the WARNING line a denied (401, 403) or rejected (400) request writes before its completion line. */
const OUTCOME_BY_STATUS: ReadonlyMap<number, string> = new Map([
  [400, 'request rejected'],
  [401, 'request denied'],
  [403, 'request denied'],
]);

/**
 * Writes a request's WARNING line when `statusCode` is a denial or rejection, then its completion line, at the route's
 * `opt2Log.successLevel` below 400; `route` is from {@link loggedRouteOf} or {@link UNMATCHED_ROUTE}, never request input.
 */
function logCompletion(request: FastifyRequest, statusCode: number, route: string, latencyMs: number, reason: string | null): void {
  const outcome = OUTCOME_BY_STATUS.get(statusCode);
  if (outcome !== undefined) {
    request.log.warn(
      { route, httpMethod: request.method, statusCode, ...scopeFields(request) },
      // The fixed reason rides in the message: the logger masks an error record's message that is not a known code.
      reason === null ? outcome : `${outcome}: ${reason}`,
    );
  }
  const level = statusCode < 400 ? (request.routeOptions.config.opt2Log?.successLevel ?? 'info') : 'info';
  request.log[level]({ route, httpMethod: request.method, statusCode, latencyMs, ...scopeFields(request) }, 'request completed');
}

function serviceUrlsOf(env: BaseEnv): Record<string, string> {
  return {
    ...env.OPT2_SERVICE_URLS,
    ...(env.OPT2_GATEWAY_URL === undefined ? {} : { gateway: env.OPT2_GATEWAY_URL }),
    ...(env.OPT2_MIGRATION_URL === undefined ? {} : { migration: env.OPT2_MIGRATION_URL }),
  };
}

async function openPool(env: BaseEnv, schema: string, logger: Logger): Promise<TenantDb> {
  const { OPT2_DB_AUTH, PG_DATABASE } = env;
  if (OPT2_DB_AUTH === undefined || PG_DATABASE === undefined) {
    const missing = Object.entries({ OPT2_DB_AUTH, PG_DATABASE }).filter(([, value]) => value === undefined);
    throw new EnvValidationError(missing.map(([key]) => `${key}: is required`), env.OPT2_SERVICE_NAME);
  }
  return createPool({
    env: { ...env, OPT2_DB_AUTH, PG_DATABASE },
    schema,
    onError: (err) => logger.error({ error: serializeError(err) }, 'database pool error'),
  });
}

/** Builds a service's Fastify instance with auth, context, parsers, legacy headers and errors, health, logging and shutdown; routes come after. */
export async function createService<E extends BaseEnv>(options: CreateServiceOptions<E>): Promise<FastifyInstance> {
  const { name, version, env, clock = systemClock, surfaceOf = defaultSurfaceOf, noCasePathPrefixes = [] } = options;
  const { maxHeaderSize = SERVICE_MAX_HEADER_SIZE } = options;
  if (options.pool !== undefined && options.schema !== undefined) {
    throw new TypeError('createService accepts either pool or schema, not both');
  }
  const rewrites = [
    ...(options.legacyFixturePaths === true ? [legacyFixtureRewrite] : []),
    ...(noCasePathPrefixes.length === 0 ? [] : [noCaseRewrite(noCasePathPrefixes)]),
  ];
  const rewriteUrl =
    rewrites.length === 0
      ? undefined
      : (req: { url?: string }) => rewrites.reduce((url, rewrite) => rewrite({ url }), req.url ?? '');
  const logger =
    options.logger ??
    createLogger({
      service: name,
      version,
      env: env.OPT2_ENV,
      level: env.LOG_LEVEL,
      googleCloudProject: env.GOOGLE_CLOUD_PROJECT,
    });
  const auth = await createAuthFromEnv(env, options.verifierOverride);
  const db = options.pool ?? (options.schema === undefined ? undefined : await openPool(env, options.schema, logger));
  const client = createServiceClient({ serviceUrls: serviceUrlsOf(env), self: name, credentials: auth.invocationMinter });

  const app = Fastify({
    ...fastifyLoggerOptions(logger),
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers),
    bodyLimit: LEGACY_POST_LIMIT_BYTES,
    http: { maxHeaderSize },
    // In-flight requests finish on close instead of getting Fastify's non-legacy 503.
    return503OnClosing: false,
    // Routes answer only the methods they register; a route serving HEAD declares it.
    exposeHeadRoutes: false,
    // Legacy caps no path parameter, so only the request head the HTTP parser admits bounds one; ColdFusion session ids exceed Fastify's 100.
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: maxHeaderSize },
    // Merged onto Fastify's Ajv defaults; admits multi-type schemas without strict-mode warnings, and an
    // `additionalProperties: false` schema rejects an unknown property instead of Fastify's default of stripping it.
    ajv: { customOptions: { allowUnionTypes: true, removeAdditional: false } },
    // Without it the router answers a malformed escape or an over-long parameter with its own body, echoing the path.
    frameworkErrors: (error, request, reply) => {
      answerFrameworkError(error, request, reply, surfaceOf);
    },
    ...(rewriteUrl === undefined ? {} : { rewriteUrl }),
  });
  // A head over the limit gets legacy's bare 400; ahead of Fastify's listener, which answers every other client error and leaves a destroyed socket alone.
  app.server.prependListener('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (error.code !== 'HPE_HEADER_OVERFLOW' || socket.destroyed) return;
    if (socket.writable) socket.write(LEGACY_BAD_REQUEST_RESPONSE);
    socket.destroy();
  });

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      // Each step runs even when an earlier one fails, so no owned handle stays open.
      for (const step of [() => app.close(), () => client.close(), () => db?.end(), () => shutdownTracing()]) {
        try {
          await step();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, `Shutdown of ${name} failed in several steps`);
      if (failures.length === 1) throw failures[0];
    })());
  const runtime: Opt2Runtime<E> = Object.freeze({ name, version, env, clock, logger, auth, client, db, shutdown });
  app.decorate('opt2', runtime);
  app.decorateRequest('opt2', null, []);
  app.decorateRequest(CONTEXT, null, []);
  app.decorateRequest(DISCONNECT, null, []);
  app.decorateRequest(FILES, null, []);
  app.decorateRequest(UPLOADS, null, []);
  app.decorateRequest(PART_HEADERS, null, []);
  app.decorateRequest(BODY_LIMIT, null, []);
  app.decorateRequest(RESPONSE_CLOSED, false, []);
  app.decorateRequest(REASON, null, []);
  app.decorateRequest(LOG_SCOPE, null, []);
  app.decorateRequest(CONTAINER, false, []);
  app.decorateRequest(EVENT_SCOPE, null, []);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    attachFieldsToBody: true,
    // ColdFusion holds every part without a file name as form text, whatever its type. The plugin would parse a
    // JSON-typed one, so it is streamed to onFile, which attaches its text as a field.
    isPartAFile: (_field, contentType, filename) => filename !== undefined || isJsonContentType(contentType),
    limits: { fileSize: LEGACY_POST_LIMIT_BYTES, fieldSize: LEGACY_POST_LIMIT_BYTES },
    async onFile(part) {
      const state = stateOf(this);
      // Typed as always present, but a JSON-typed field part has none.
      const sentName: string | undefined = part.filename;
      if (sentName === undefined) {
        let text: string;
        try {
          // UTF-8, JSON's one encoding: the plugin passes no part charset for a streamed part.
          text = (await part.toBuffer()).toString('utf8');
        } catch (err) {
          throw state[BODY_LIMIT] ?? err;
        }
        attachAsField(part, text);
        return;
      }
      // Parts arrive in body order, each after the scanner has read its headers.
      const contentType = state[PART_HEADERS]?.take(part.fieldname, part.mimetype) ?? part.mimetype;
      const filepath = path.join(tmpdir(), `opt2-upload-${randomUUID()}`);
      const file = await open(filepath, 'wx', 0o600);
      if (state[RESPONSE_CLOSED]) {
        // The premature-close cleanup has already run, so a file listed now would outlive the request.
        await file.close();
        await rm(filepath, { force: true });
        throw new this.server.multipartErrors.PrematureCloseError();
      }
      // Listed once it exists and before it is written, so the response or premature-close cleanup deletes it on every outcome.
      // Kept out of the plugin's tmpUploads, which both its response and close cleanup unlink.
      (state[UPLOADS] ??= []).push(filepath);
      const hash = createHash('sha256');
      let size = 0;
      const digest = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(part.file, digest, file.createWriteStream());
      } catch (err) {
        // A file the body limit destroyed reports a premature close; the limit is the request's error.
        throw state[BODY_LIMIT] ?? err;
      }
      (state[FILES] ??= []).push({ part, filepath, size, sha256: hash.digest('hex'), contentType });
    },
  });
  // Multipart reads the raw request past bodyLimit, so its bytes are counted against the same limit here.
  app.addHook('preParsing', (request, reply, payload, done) => {
    if (request.mediaType !== 'multipart/form-data') {
      done(null, payload);
      return;
    }
    const tooLarge = (): FastifyError => {
      reply.header('connection', 'close');
      return new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE();
    };
    if (Number(request.headers['content-length']) > LEGACY_POST_LIMIT_BYTES) {
      done(tooLarge());
      return;
    }
    // A finished response's uploads are deleted by onResponse; a close without finish may skip onResponse, so it deletes them.
    let finished = false;
    reply.raw.once('finish', () => {
      finished = true;
    });
    reply.raw.once('close', () => {
      stateOf(request)[RESPONSE_CLOSED] = true;
      if (!finished) void removeUploads(request);
    });
    const raw = request.raw;
    let received = 0;
    const count = (chunk: Buffer): void => {
      received += chunk.length;
      if (received <= LEGACY_POST_LIMIT_BYTES) return;
      raw.removeListener('data', count);
      raw.unpipe();
      const error = tooLarge();
      stateOf(request)[BODY_LIMIT] = error;
      // Fails the multipart parse, which listens for errors on the raw request.
      raw.emit('error', error);
    };
    // Paused first, so the listener does not start the stream; multipart's pipe resumes it.
    raw.pause();
    raw.on('data', count);
    // Ahead of multipart's own listener, so busboy hands a file part over only once its headers are scanned.
    const scanner = createMultipartHeaderScanner(request.headers['content-type']);
    if (scanner !== undefined) {
      stateOf(request)[PART_HEADERS] = scanner;
      raw.on('data', (chunk: Buffer) => scanner.push(chunk));
    }
    done(null, payload);
  });
  const parseJson = app.getDefaultJsonParser('remove', 'remove') as (
    request: FastifyRequest,
    body: string,
    done: (err: Error | null, body?: unknown) => void,
  ) => void;
  app.removeContentTypeParser('application/json');
  // Legacy ignores a body that is not JSON, so an empty or invalid one parses to undefined; prototype keys are dropped.
  const parseLegacyJson: typeof parseJson = (request, body, done) => {
    parseJson(request, body, (err, value) => {
      done(null, err === null ? value : undefined);
    });
  };
  app.addContentTypeParser<string>('application/json', { parseAs: 'string' }, parseLegacyJson);
  // Legacy reads any type starting with `application/json` as JSON; every other type stays a raw Buffer.
  app.addContentTypeParser<Buffer>('*', { parseAs: 'buffer' }, (request, body, done) => {
    if (isJsonRequest(request)) parseLegacyJson(request, body.toString('utf8'), done);
    else done(null, body);
  });

  // Registered before auth, so the auth hooks and the handler run inside the request context.
  app.addHook('onRequest', (request, reply, done) => {
    // The HTTP instrumentation names its server span `<method> <route>` from this at response end; unmatched paths keep the method.
    const rpcMetadata = getRPCMetadata(context.active());
    if (rpcMetadata?.type === RPCType.HTTP && request.routeOptions.url !== undefined) rpcMetadata.route = request.routeOptions.url;
    const store = newRequestContext({ requestId: request.id, clock });
    // System time, not the injected clock: the caller's timeout runs on real time.
    if (request.routeOptions.config.opt2Outbox?.incompleteFlush === 'unavailable') store.flushBy = Date.now() + SERVICE_CALL_TIMEOUT_MS - FLUSH_ANSWER_MARGIN_MS;
    stateOf(request)[CONTEXT] = store;
    // Fastify's request.signal also aborts once a body is consumed; only a response closing unended means the client left.
    const disconnect = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) disconnect.abort(new RequestAbortedError());
    });
    stateOf(request)[DISCONNECT] = disconnect.signal;
    request.opt2 = {};
    requestContext.run(store, () => done());
  });
  // Body parsing resumes outside the async context, so the store is entered again.
  app.addHook('preValidation', (request, _reply, done) => {
    const store = stateOf(request)[CONTEXT];
    if (store === null) done();
    else requestContext.run(store, () => done());
  });

  // The container refuses a request target before its POST size check, the start-up scan or auth run.
  const { containerRefusesTarget, skipsStartupScan } = options;
  if (containerRefusesTarget !== undefined) {
    app.addHook('onRequest', (request, reply, done) => {
      if (containerRefusesTarget(request)) sendTargetRefused(request, reply);
      else done();
    });
  }
  // The container refuses an oversized POST before any auth or Masa code runs.
  app.addHook('onRequest', (request, reply, done) => {
    if (exceedsLegacyPostSize(request.raw)) sendPostSizeExceeded(request, reply);
    else done();
  });
  // Node would send `100 Continue` first; the container sends none to a POST it refuses, so Node then closes the connection.
  app.server.on('checkContinue', (req: IncomingMessage, res) => {
    if (!exceedsLegacyPostSize(req)) res.writeContinue();
    app.server.emit('request', req, res);
  });
  // Legacy scans url and form before any route or login check: the url scope here, ahead of auth, the form once parsed.
  const answerScanFailure = (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    if (!failsRootScan(request, noCasePathPrefixes) || skipsStartupScan?.(request) === true) {
      done();
      return;
    }
    request.log.error(scopeFields(request), 'script protection scan failed');
    sendLegacyResponse(reply, adminErrorPage(500, LEGACY_ERROR_STATUS_TEXT));
  };
  if (options.legacyStartupScan !== false) {
    app.addHook('onRequest', (request, reply, done) => {
      answerScanFailure(request, reply, done);
    });
    app.addHook('preValidation', (request, reply, done) => {
      answerScanFailure(request, reply, done);
    });
  }

  registerAuth(app, {
    transports: auth.transports,
    // A hook-time denial skips the scope hook below, so what was verified before it is bound here.
    onDenial: (denial, request) => {
      recordOutcomeReason(request, denial.reason);
      bindVerifiedScope(request);
    },
  });

  // Registered after auth, so it reads verified identities only.
  app.addHook('onRequest', (request, _reply, done) => {
    bindVerifiedScope(request);
    done();
  });

  // Liveness probes carry no invocation credential.
  app.get('/healthz', { config: { opt2: { public: true, invocationOptional: true } } }, async () => ({ status: 'ok' }));

  const headers = Object.entries(legacyHeaders());
  app.addHook('onSend', (request, reply, payload, done) => {
    if (stateOf(request)[CONTAINER]) {
      done(null, payload);
      return;
    }
    for (const [header, value] of headers) {
      if (!reply.hasHeader(header)) reply.header(header, value);
    }
    done(null, payload);
  });
  // Withholds the success answer of a request whose committed outbox events were not all published; an error answer passes unchanged.
  app.addHook('onSend', (request, reply, payload, done) => {
    const unpublished = stateOf(request)[CONTEXT]?.unpublishedEvents;
    if (unpublished !== undefined && unpublished.length > 0 && reply.statusCode < 400) done(new UnpublishedEventsError(unpublished));
    else done(null, payload);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof UnpublishedEventsError && request.routeOptions.config.opt2Outbox?.incompleteFlush !== 'unavailable') {
      const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
      request.log.warn(
        { route, httpMethod: request.method, latencyMs: Math.round(reply.elapsedTime), ...scopeFields(request), error: serializeError(error) },
        'request abandoned: outbox publish of its committed events incomplete',
      );
      // No answer, as when the process exits before its flush: the rows stay committed and the sweep publishes them.
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    if (error instanceof RequestAbortedError) {
      const route = loggedRouteOf(request);
      request.log.info({ route, httpMethod: request.method, latencyMs: Math.round(reply.elapsedTime), ...scopeFields(request) }, 'request abandoned');
      // 499 is the client-closed-request code; the socket is gone, so it never reaches the wire.
      return reply.code(499).send();
    }
    const params = legacyParamsOf(request);
    const method = paramString(params, 'method');
    if (error instanceof AuthDenial) {
      recordOutcomeReason(request, error.reason);
      return sendLegacyResponse(reply, renderAuthDenial(error, request));
    }
    // The rows stay committed and the sweep publishes their events; the caller re-sends the request, which its route answers idempotently.
    if (error instanceof UnpublishedEventsError) {
      const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
      request.log.warn(
        { route, httpMethod: request.method, latencyMs: Math.round(reply.elapsedTime), ...scopeFields(request), error: serializeError(error) },
        'request answered 503: outbox publish of its committed events incomplete',
      );
      reply.header(UNPUBLISHED_EVENTS_HEADER, String(error.eventIds.length));
      return sendLegacyResponse(reply, unavailableResponseFor(surfaceOf(request), { method, params }));
    }
    // A database outage is a failure, so it logs at ERROR; its surface is always 'auto'.
    if (error instanceof DatabaseUnavailableError) {
      request.log.error({ ...scopeFields(request), error: serializeError(error) }, 'database unavailable');
      return sendLegacyResponse(reply, unavailableResponseFor(surfaceOf(request), { method, params }));
    }
    if (error instanceof LegacyServiceUnavailableError) {
      request.log.warn({ ...scopeFields(request), error: serializeError(error) }, 'service unavailable');
      // A surface the error names wins over the one its path selects.
      const surface = error.surface === 'auto' ? surfaceOf(request) : error.surface;
      return sendLegacyResponse(reply, unavailableResponseFor(surface, { method, params }));
    }
    if (isUnstorableTextError(error)) {
      recordOutcomeReason(request, error.code);
      return sendLegacyResponse(reply, legacyErrorResponse('invalidParameters', { method, params }));
    }
    if (error instanceof LegacyApiError) {
      recordOutcomeReason(request, error.type);
      return sendLegacyResponse(
        reply,
        legacyErrorResponse(error.type, {
          method: error.method ?? method,
          params: error.params ?? params,
          methodCtx: error.methodCtx,
          wwwAuthenticate: error.wwwAuthenticate,
          stacktrace: error.stacktrace,
        }),
      );
    }
    if (error.validation !== undefined) {
      recordOutcomeReason(request, error.code);
      return sendLegacyResponse(reply, legacyErrorResponse('invalidParameters', { method, params }));
    }
    // A body over the memory bound gets the closest legacy rejection, the container's Post Size page.
    if (isBodyTooLargeError(error)) return sendPostSizeExceeded(request, reply);
    if (isFastifyClientError(error)) {
      recordOutcomeReason(request, error.code);
      return sendLegacyResponse(reply, legacyErrorResponse('badRequest', { method, params }));
    }
    request.log.error({ ...scopeFields(request), error: serializeError(error) }, 'unhandled error');
    return sendLegacyResponse(
      reply,
      surfaceOf(request) === 'admin'
        ? adminErrorPage(500, LEGACY_ERROR_STATUS_TEXT)
        : legacyErrorResponse('server_error', { method, params }),
    );
  });

  app.setNotFoundHandler((request, reply) => sendLegacyResponse(reply, notFoundResponse(request, surfaceOf(request))));

  app.addHook('onResponse', (request, reply, done) => {
    const route = loggedRouteOf(request);
    logCompletion(request, reply.statusCode, route, Math.round(reply.elapsedTime), stateOf(request)[REASON]);
    done();
  });
  // After the completion line, so deleting a request's uploads never delays it.
  app.addHook('onResponse', async (request) => {
    await removeUploads(request);
  });

  const onSigterm = (): void => {
    shutdown().catch((err: unknown) => {
      const failures: unknown[] = err instanceof AggregateError ? err.errors : [err];
      for (const failure of failures) logger.error({ error: serializeError(failure) }, 'shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', onSigterm);
  app.addHook('onClose', (_instance, done) => {
    process.removeListener('SIGTERM', onSigterm);
    done();
  });

  return app;
}
