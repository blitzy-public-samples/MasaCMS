// Fastify factory of @opt2/platform/service-kit: auth, request context, legacy body parsing, headers, errors, logging and shutdown.
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart, { type MultipartFile, type MultipartValue } from '@fastify/multipart';
import { trace } from '@opentelemetry/api';
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

/** One buffered multipart file part. */
interface MultipartFileData {
  field: string;
  filename: string;
  mimetype: string;
  data: Buffer;
}

/** A legacy-compat response object; `statusText` sets the reason phrase. */
interface LegacyResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  statusText?: string;
}

const CONTEXT = Symbol('opt2.service-kit.context');
const FILES = Symbol('opt2.service-kit.files');
const BODY_LIMIT = Symbol('opt2.service-kit.body-limit');

/** Per-request state kept on module-private symbols. */
interface KitRequestState {
  [CONTEXT]: RequestContextStore | null;
  [FILES]: MultipartFile[] | null;
  /** The body-limit error that aborted the request's multipart parse. */
  [BODY_LIMIT]: FastifyError | null;
}

const ADMIN_PREFIXES: readonly string[] = ['/admin/', '/admin-actions/', '/admin-raw/'];

function stateOf(request: FastifyRequest): KitRequestState {
  return request as unknown as KitRequestState;
}

function pathOf(request: FastifyRequest): string {
  const query = request.url.indexOf('?');
  return query === -1 ? request.url : request.url.slice(0, query);
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

/** The buffered multipart file parts of a request, in body order. */
export function multipartFilesOf(request: FastifyRequest): MultipartFileData[] {
  return (stateOf(request)[FILES] ?? []).map((part) => ({
    field: part.fieldname,
    filename: part.filename,
    mimetype: part.mimetype,
    data: part.value as Buffer,
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

/** Fastify's own request errors below 500, such as an oversized body or an unsupported media type. */
function isFastifyClientError(error: FastifyError): boolean {
  return typeof error.code === 'string' && error.code.startsWith('FST_') && (error.statusCode ?? 500) < 500;
}

/** Verified tenant and user of a request, for its log lines. */
function scopeFields(request: FastifyRequest): Pick<LogFields, 'tenantId' | 'userId'> {
  const store = stateOf(request)[CONTEXT];
  const fields: Pick<LogFields, 'tenantId' | 'userId'> = {};
  if (store?.tenantId !== undefined) fields.tenantId = store.tenantId;
  if (store?.user?.sub !== undefined) fields.userId = store.user.sub;
  return fields;
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
  const { name, version, env, clock = systemClock, surfaceOf = defaultSurfaceOf } = options;
  if (options.pool !== undefined && options.schema !== undefined) {
    throw new TypeError('createService accepts either pool or schema, not both');
  }
  const logger =
    options.logger ??
    createLogger({ service: name, version, env: env.OPT2_ENV, googleCloudProject: env.GOOGLE_CLOUD_PROJECT });
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

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: { fileSize: LEGACY_POST_LIMIT_BYTES, fieldSize: LEGACY_POST_LIMIT_BYTES },
    async onFile(part) {
      const state = stateOf(this);
      try {
        part.value = await part.toBuffer();
      } catch (err) {
        // A file the body limit destroyed reports a premature close; the limit is the request's error.
        throw state[BODY_LIMIT] ?? err;
      }
      (state[FILES] ??= []).push(part);
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

  registerAuth(app, { transports: auth.transports });

  // Registered after auth, so it reads verified identities only.
  app.addHook('onRequest', (request, _reply, done) => {
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
      return sendLegacyResponse(reply, renderAuthDenial(error, request));
    }
    if (error instanceof LegacyServiceUnavailableError) {
      request.log.warn({ ...scopeFields(request), error: serializeError(error) }, 'service unavailable');
      // A surface the error names wins over the one its path selects.
      const surface = error.surface === 'auto' ? surfaceOf(request) : error.surface;
      return sendLegacyResponse(reply, unavailableResponseFor(surface, { method, params }));
    }
    if (error instanceof LegacyApiError) {
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
      return sendLegacyResponse(reply, legacyErrorResponse('invalidParameters', { method, params }));
    }
    if (isFastifyClientError(error)) {
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

  app.setNotFoundHandler((request, reply) => {
    if (surfaceOf(request) === 'admin') {
      return sendLegacyResponse(reply, adminErrorPage(404));
    }
    const params = legacyParamsOf(request);
    return sendLegacyResponse(
      reply,
      legacyErrorResponse('invalidMethodCall', { method: paramString(params, 'method'), params, mura404: true }),
    );
  });

  app.addHook('onResponse', (request, reply, done) => {
    // The path only: query strings can carry credentials such as the local push key.
    request.log.info(
      {
        route: request.routeOptions.url ?? pathOf(request),
        httpMethod: request.method,
        statusCode: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
        ...scopeFields(request),
      },
      'request completed',
    );
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
