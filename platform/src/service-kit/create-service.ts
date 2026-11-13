// Fastify factory of @opt2/platform/service-kit: auth, request context, legacy body parsing, headers, errors, logging and shutdown.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseQuery } from 'node:querystring';
import { Transform, type Readable } from 'node:stream';
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
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_ERROR_STATUS_TEXT,
  LEGACY_HTML_CONTENT_TYPE,
  LegacyApiError,
  LegacyServiceUnavailableError,
  isCfUuid,
  legacyErrorResponse,
  legacyHeaders,
  unavailableResponseFor,
  type UnavailableSurface,
} from '../legacy-compat/index.js';
import { createLogger, fastifyLoggerOptions, serializeError, type LogFields, type Logger } from '../logging/index.js';
import { createPool, type TenantDb } from '../tenancy/index.js';
import { shutdownTracing } from '../tracing/index.js';
import { createServiceClient, type ServiceClient } from './client.js';
import { systemClock, type Clock } from './clock.js';
import { newRequestContext, requestContext, requestIdFrom, type RequestContextStore } from './context.js';
import type { BaseEnv } from './env.js';

/** Surface a request's legacy error responses are rendered on. */
export type LegacySurface = UnavailableSurface;

/** ColdFusion's default maximum POST size: the body, multipart file and field limit of every route. */
export const LEGACY_POST_LIMIT_BYTES = 100 * 1024 * 1024;

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
  /** Path prefixes routed in any letter case, as legacy compares them; a matching path is routed under the spelling given here. */
  noCasePathPrefixes?: readonly string[];
  /** Routes `/legacy-fixtures/cfml/api.cfm/` paths with the module, resource, action and tail segments lower-cased, as api.cfm reads them. */
  legacyFixturePaths?: boolean;
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

declare module 'fastify' {
  interface FastifyInstance {
    opt2: Opt2Runtime;
  }
  interface FastifyRequest {
    opt2: Opt2RequestScope;
  }
}

/** One multipart file part, spooled to a temporary file that is deleted once the response ends. */
interface MultipartFileData {
  field: string;
  filename: string;
  mimetype: string;
  size: number;
  /** Lowercase hex SHA-256 of the part's bytes. */
  sha256: string;
  /** A new read stream of the part's bytes; valid until the response ends. */
  stream(): Readable;
}

/** A file part as `onFile` spooled it: its temporary file, byte count and SHA-256. */
interface SpooledFile {
  part: MultipartFile;
  filepath: string;
  size: number;
  sha256: string;
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
const BODY_LIMIT = Symbol('opt2.service-kit.body-limit');
const RESPONSE_CLOSED = Symbol('opt2.service-kit.response-closed');
const REASON = Symbol('opt2.service-kit.reason');

/** Per-request state kept on module-private symbols. */
interface KitRequestState {
  [CONTEXT]: RequestContextStore | null;
  [FILES]: SpooledFile[] | null;
  /** The body-limit error that aborted the request's multipart parse. */
  [BODY_LIMIT]: FastifyError | null;
  /** Whether a multipart request's response has closed, after which the plugin no longer deletes listed uploads. */
  [RESPONSE_CLOSED]: boolean;
  /** Fixed identifier of why the request was denied or rejected, such as an AuthDenial reason; never request input. */
  [REASON]: string | null;
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

function isMultipartPart(value: unknown): value is MultipartFile | MultipartValue {
  return isPlainObject(value) && (value.type === 'file' || value.type === 'field') && typeof value.fieldname === 'string';
}

/** One url, form or multipart value as a CFML scope holds it: repeated keys joined with `,`, file parts by name. */
function scopeValue(value: unknown): unknown {
  const single = (item: unknown): unknown => {
    if (!isMultipartPart(item)) return item;
    return item.type === 'file' ? item.filename : item.value;
  };
  return Array.isArray(value) ? value.map(single).join(',') : single(value);
}

/** One deserialized JSON value: simple values as strings, null as '', objects and arrays as they are. */
function jsonValue(value: unknown): unknown {
  if (value === null) return '';
  return typeof value === 'object' ? value : String(value);
}

function isJsonRequest(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && contentType.slice(0, 16).toLowerCase() === 'application/json';
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

/** Query then body params as legacy merges url, form and a JSON body: later keys win ignoring case, keeping their spelling. */
export function legacyParamsOf(request: FastifyRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const spelling = new Map<string, string>();
  const put = (key: string, value: unknown): void => {
    const previous = spelling.get(key.toLowerCase());
    if (previous !== undefined) delete params[previous];
    spelling.set(key.toLowerCase(), key);
    // Defined, not assigned, so a `__proto__` key stays a data key.
    Object.defineProperty(params, key, { value, writable: true, enumerable: true, configurable: true });
  };
  if (isPlainObject(request.query)) {
    for (const [key, value] of Object.entries(request.query)) put(key, scopeValue(value));
  }
  if (isPlainObject(request.body)) {
    const json = isJsonRequest(request);
    for (const [key, value] of Object.entries(request.body)) put(key, json ? jsonValue(value) : scopeValue(value));
  }
  return params;
}

/** The spooled multipart file parts of a request, in body order. */
export function multipartFilesOf(request: FastifyRequest): MultipartFileData[] {
  return (stateOf(request)[FILES] ?? []).map(({ part, filepath, size, sha256 }) => ({
    field: part.fieldname,
    filename: part.filename,
    mimetype: part.mimetype,
    size,
    sha256,
    stream: () => createReadStream(filepath),
  }));
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
    logCompletion(request, reply.statusCode, pathOf(request), Math.round(performance.now() - startedAt), error.code);
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

/** Verified tenant and user of a request, for its log lines. */
function scopeFields(request: FastifyRequest): Pick<LogFields, 'tenantId' | 'userId'> {
  const store = stateOf(request)[CONTEXT];
  const fields: Pick<LogFields, 'tenantId' | 'userId'> = {};
  if (store?.tenantId !== undefined) fields.tenantId = store.tenantId;
  if (store?.user?.sub !== undefined) fields.userId = store.user.sub;
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

/** Records why `request` was denied or rejected, for its WARNING line; `reason` is a fixed identifier such as an error type, never request input. */
export function recordOutcomeReason(request: FastifyRequest, reason: string): void {
  stateOf(request)[REASON] = reason;
}

/** Message of the WARNING line a denied (401, 403) or rejected (400) request writes before its completion line. */
const OUTCOME_BY_STATUS: ReadonlyMap<number, string> = new Map([
  [400, 'request rejected'],
  [401, 'request denied'],
  [403, 'request denied'],
]);

/** Writes a request's WARNING line when `statusCode` is a denial or rejection, then its completion line; `route` omits the query string, which can carry credentials. */
function logCompletion(request: FastifyRequest, statusCode: number, route: string, latencyMs: number, reason: string | null): void {
  const outcome = OUTCOME_BY_STATUS.get(statusCode);
  if (outcome !== undefined) {
    request.log.warn(
      { route, httpMethod: request.method, statusCode, ...scopeFields(request) },
      // The fixed reason rides in the message: the logger masks an error record's message that is not a known code.
      reason === null ? outcome : `${outcome}: ${reason}`,
    );
  }
  request.log.info({ route, httpMethod: request.method, statusCode, latencyMs, ...scopeFields(request) }, 'request completed');
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
    throw new Error(`Schema ${schema} needs OPT2_DB_AUTH and PG_DATABASE`);
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
    // In-flight requests finish on close instead of getting Fastify's non-legacy 503.
    return503OnClosing: false,
    // Routes answer only the methods they register; a route serving HEAD declares it.
    exposeHeadRoutes: false,
    routerOptions: { ignoreTrailingSlash: true },
    // Merged onto Fastify's Ajv defaults; admits multi-type schemas without strict-mode warnings.
    ajv: { customOptions: { allowUnionTypes: true } },
    // Without it the router answers a malformed escape or an over-long parameter with its own body, echoing the path.
    frameworkErrors: (error, request, reply) => {
      answerFrameworkError(error, request, reply, surfaceOf);
    },
    ...(rewriteUrl === undefined ? {} : { rewriteUrl }),
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
  app.decorateRequest(FILES, null, []);
  app.decorateRequest(BODY_LIMIT, null, []);
  app.decorateRequest(RESPONSE_CLOSED, false, []);
  app.decorateRequest(REASON, null, []);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: LEGACY_POST_LIMIT_BYTES, fieldSize: LEGACY_POST_LIMIT_BYTES },
    async onFile(part) {
      const state = stateOf(this);
      const filepath = path.join(tmpdir(), `opt2-upload-${randomUUID()}`);
      const file = await open(filepath, 'wx', 0o600);
      if (state[RESPONSE_CLOSED]) {
        // The plugin's premature-close cleanup has already run, so a file listed now would outlive the request.
        await file.close();
        await rm(filepath, { force: true });
        throw new this.server.multipartErrors.PrematureCloseError();
      }
      // Listed once it exists and before it is written, so the plugin's response and premature-close cleanup delete it on every outcome.
      (this.tmpUploads ??= []).push(filepath);
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
      (state[FILES] ??= []).push({ part, filepath, size, sha256: hash.digest('hex') });
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
    // Fires after the multipart plugin's own close listener, which deletes the uploads listed so far.
    reply.raw.once('close', () => {
      stateOf(request)[RESPONSE_CLOSED] = true;
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
  app.addHook('onRequest', (request, _reply, done) => {
    // The HTTP instrumentation names its server span `<method> <route>` from this at response end; unmatched paths keep the method.
    const rpcMetadata = getRPCMetadata(context.active());
    if (rpcMetadata?.type === RPCType.HTTP && request.routeOptions.url !== undefined) rpcMetadata.route = request.routeOptions.url;
    const store = newRequestContext({ requestId: request.id, clock });
    stateOf(request)[CONTEXT] = store;
    request.opt2 = {};
    requestContext.run(store, () => done());
  });
  // Body parsing resumes outside the async context, so the store is entered again.
  app.addHook('preValidation', (request, _reply, done) => {
    const store = stateOf(request)[CONTEXT];
    if (store === null) done();
    else requestContext.run(store, () => done());
  });

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

  app.get('/healthz', { config: { opt2: { public: true } } }, async () => ({ status: 'ok' }));

  const headers = Object.entries(legacyHeaders());
  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [header, value] of headers) {
      if (!reply.hasHeader(header)) reply.header(header, value);
    }
    done(null, payload);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const params = legacyParamsOf(request);
    const method = paramString(params, 'method');
    if (error instanceof AuthDenial) {
      recordOutcomeReason(request, error.reason);
      return sendLegacyResponse(reply, renderAuthDenial(error, request));
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
        }),
      );
    }
    if (error.validation !== undefined) {
      recordOutcomeReason(request, error.code);
      return sendLegacyResponse(reply, legacyErrorResponse('invalidParameters', { method, params }));
    }
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
    const route = request.routeOptions.url ?? pathOf(request);
    logCompletion(request, reply.statusCode, route, Math.round(reply.elapsedTime), stateOf(request)[REASON]);
    done();
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
