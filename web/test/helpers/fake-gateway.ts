// Fakes of web's only outbound path, the gateway relay: a loopback HTTP server and an in-memory GatewayClient.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REQUEST_ID_HEADER } from '@opt2/platform/service-kit';
import { GATEWAY_SERVICE_PREFIX } from '@/lib/env';
import {
  GatewayUnavailableError,
  type FormInput,
  type GatewayClient,
  type GatewayRequest,
  type GatewayResponse,
  type HttpMethod,
  type IdentityFacade,
  type MultipartBody,
  type ProgramsSitesFacade,
  type QueryInput,
  type ServicePath,
  type WebServiceName,
} from '@/lib/gateway-client';

const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
// Request targets are origin-form; the base only lets URL parse them.
const TARGET_BASE = 'http://fake-gateway.invalid';

/** A canned gateway answer; a body that is neither a string nor a Buffer is sent as JSON. */
export type FakeReply = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Sent as one `Set-Cookie` header each, in order. */
  readonly setCookies?: readonly string[];
};

/** Headers of a recorded request, names lower-cased. */
export interface RecordedHeaders {
  readonly authorization?: string;
  readonly 'x-serverless-authorization'?: string;
  readonly 'x-request-id'?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly 'x-csrf_token'?: string;
  readonly [name: string]: string | undefined;
}

/** One request as the gateway received it. */
export interface RecordedRequest {
  readonly method: string;
  /** Path without the query, for example `/opt2/svc/people/v1/users`. */
  readonly path: string;
  /** Query fields; a repeated field is an array. */
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly headers: RecordedHeaders;
  /** Body decoded as UTF-8. */
  readonly body: string;
  /** Body bytes as received. */
  readonly bytes: Buffer;
  /** Parsed body of a non-empty JSON request. */
  readonly json?: unknown;
  /** Fields of a URL-encoded form request; a repeated field is an array. */
  readonly form?: Readonly<Record<string, string | string[]>>;
}

/** A fixed reply, or a handler computing one from the request. */
export type FakeRoute = FakeReply | ((request: RecordedRequest) => FakeReply | Promise<FakeReply>);

/** Routes keyed `METHOD /opt2/svc/<service>/<path>`, path without the query. */
export type FakeRouteTable = Readonly<Record<string, FakeRoute>>;

/** Route key of `method` on the service path `path` of `service`, for example `GET /opt2/svc/identity/v1/ping`. */
export function routeKey(method: HttpMethod, service: WebServiceName, path: ServicePath): string {
  return `${method} ${GATEWAY_SERVICE_PREFIX}/${service}${path}`;
}

// An empty JSON 404, which the platform client decodes to `body: undefined` and `raw` returns as no bytes.
const NOT_FOUND: FakeReply = { status: 404, headers: { 'content-type': JSON_CONTENT_TYPE } };

interface EncodedReply {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly bytes: Buffer;
}

function lowerCased(headers: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** Fields in order as own properties, `__proto__` included; a repeated name collected into an array. */
function fields(params: URLSearchParams): Record<string, string | string[]> {
  const result = new Map<string, string | string[]>();
  for (const [name, value] of params) {
    const previous = result.get(name);
    result.set(name, previous === undefined ? value : [previous, value].flat());
  }
  return Object.fromEntries(result);
}

function mediaType(contentType: string | string[] | undefined): string {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (value?.split(';')[0] ?? '').trim().toLowerCase();
}

const isJsonType = (type: string): boolean => type === 'application/json' || type.endsWith('+json');

/** The request `method target` with `headers` and `bytes`, its body parsed by content type. */
function recordRequest(method: string, target: string, headers: RecordedHeaders, bytes: Buffer): RecordedRequest {
  const url = new URL(target, TARGET_BASE);
  const body = bytes.toString('utf8');
  const type = mediaType(headers['content-type']);
  return {
    method,
    path: url.pathname,
    query: fields(url.searchParams),
    headers,
    body,
    bytes,
    json: isJsonType(type) && body !== '' ? (JSON.parse(body) as unknown) : undefined,
    form: type === FORM_CONTENT_TYPE ? fields(new URLSearchParams(body)) : undefined,
  };
}

/** Status, lower-cased headers and bytes of `reply`, as the HTTP fake sends them. */
function encodeReply({ status, headers, body, setCookies = [] }: FakeReply): EncodedReply {
  const encoded: Record<string, string | string[]> = lowerCased(headers);
  let bytes: Buffer;
  if (body === undefined) bytes = Buffer.alloc(0);
  else if (Buffer.isBuffer(body)) bytes = body;
  else if (typeof body === 'string') bytes = Buffer.from(body, 'utf8');
  else {
    bytes = Buffer.from(JSON.stringify(body), 'utf8');
    encoded['content-type'] ??= JSON_CONTENT_TYPE;
  }
  const cookies = [...[encoded['set-cookie'] ?? []].flat(), ...setCookies];
  if (cookies.length > 0) encoded['set-cookie'] = cookies;
  return { status, headers: encoded, bytes };
}

/** The encoded reply of the route matching `request`, else the empty 404. */
async function answer(routes: ReadonlyMap<string, FakeRoute>, request: RecordedRequest): Promise<EncodedReply> {
  const route = routes.get(`${request.method} ${request.path}`) ?? NOT_FOUND;
  return encodeReply(typeof route === 'function' ? await route(request) : route);
}

/** Loopback gateway answering web's relay calls; every request is recorded. */
export interface FakeGateway {
  /** Base URL, for `OPT2_GATEWAY_URL`. */
  readonly url: string;
  readonly requests: RecordedRequest[];
  setRoute(key: string, route: FakeRoute): void;
  /** Stops listening and drops open sockets, so later calls to the same `url` are refused (ECONNREFUSED). */
  refuse(): Promise<void>;
  /** Destroys every open socket, dropping requests in flight. */
  closeConnections(): void;
  /** Stops the server; later calls are no-ops. */
  close(): Promise<void>;
}

function recordedHeaders(headers: IncomingHttpHeaders): RecordedHeaders {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
}

/** Starts a gateway on 127.0.0.1 (port 0) answering `routes`; unrouted requests get an empty 404. */
export async function startFakeGateway(routes: FakeRouteTable = {}): Promise<FakeGateway> {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const requests: RecordedRequest[] = [];

  async function handle(req: IncomingMessage, bytes: Buffer): Promise<EncodedReply> {
    const request = recordRequest(req.method ?? '', req.url ?? '/', recordedHeaders(req.headers), bytes);
    requests.push(request);
    return answer(table, request);
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handle(req, Buffer.concat(chunks)).then(
        ({ status, headers, bytes }) => {
          res.writeHead(status, headers).end(bytes);
        },
        // A failing route handler answers at once rather than leaving the client waiting for its timeout.
        (error: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain;charset=utf-8' }).end(String(error));
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    });
    return stopped;
  };

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    setRoute: (key, route) => {
      table.set(key, route);
    },
    refuse: stop,
    closeConnections: () => server.closeAllConnections(),
    close: stop,
  };
}

/** Parses `web/test/fixtures/<relPath>` as JSON, for example a recorded `{status, headers, body}` reply. */
export function loadFixture<T = unknown>(relPath: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${relPath}`, import.meta.url), 'utf8')) as T;
}

/** One call the in-memory client received. */
export interface FakeCall {
  readonly service: WebServiceName;
  readonly method: HttpMethod;
  /** Service path without the query, path parameters filled, for example `/v1/sites/default`. */
  readonly path: string;
  /** Query fields as the gateway parses them; absent when there are none. */
  readonly query?: Readonly<Record<string, string | string[]>>;
  readonly json?: unknown;
  /** Form fields as the gateway parses them. */
  readonly form?: Readonly<Record<string, string | string[]>>;
  /** Headers the caller set, names lower-cased. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly userToken?: string;
  readonly requestId?: string;
}

/** Per-request facts the in-memory client sends on every call, as `GatewayCallContext` does. */
export interface FakeGatewayClientOptions {
  readonly userToken?: string;
  readonly requestId?: string;
}

/** A `GatewayClient` answering from a route table, with the calls it received. */
export type FakeGatewayClient = GatewayClient & {
  readonly calls: FakeCall[];
  setRoute(key: string, route: FakeRoute): void;
  hasRoute(key: string): boolean;
  /** Makes this and every later call throw `error`, by default a `GatewayUnavailableError` for the called service. */
  failWith(error?: Error): void;
  /** Clears the recorded calls and any `failWith`; routes are kept. */
  reset(): void;
};

type LowerMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

const HTTP_METHODS: Readonly<Record<LowerMethod, HttpMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

type CoreCalls = Pick<GatewayClient, 'call' | 'raw'>;

interface FacadeInput {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: QueryInput;
  readonly json?: unknown;
  readonly form?: FormInput;
  readonly body?: Buffer | string;
  readonly headers?: Readonly<Record<string, string>>;
}

// The helpers below mirror the private request encoding of `@/lib/gateway-client`, so in-memory calls match the wire.

function isQueryObject(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  return typeof value === 'object' && !Array.isArray(value);
}

function queryParams(query: QueryInput): URLSearchParams {
  if (query instanceof URLSearchParams) return query;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (isQueryObject(value)) {
      for (const [key, item] of Object.entries(value)) params.append(key, String(item));
    } else {
      for (const item of [value].flat()) params.append(name, String(item));
    }
  }
  return params;
}

function withQuery(path: string, query: QueryInput | undefined): string {
  const search = query === undefined ? '' : queryParams(query).toString();
  return search === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${search}`;
}

function encodeForm(form: FormInput): string {
  const entries: Iterable<readonly [string, unknown]> =
    Symbol.iterator in form
      ? (form as Iterable<readonly [string, unknown]>)
      : Object.entries(form).flatMap(([name, value]) => [value].flat().map((item): [string, string] => [name, item]));
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') throw new TypeError(`Form field ${name} is a file; send it with postMultipart`);
    params.append(name, value);
  }
  return params.toString();
}

function fillPath(template: ServicePath, params: Readonly<Record<string, unknown>> = {}): ServicePath {
  return template.replace(/\{([^}]+)\}/g, (_segment, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) throw new TypeError(`Missing path parameter ${name} of ${template}`);
    return encodeURIComponent(String(value));
  }) as ServicePath;
}

function facadeRequest(method: LowerMethod, path: ServicePath, input: FacadeInput = {}): GatewayRequest {
  const { params, ...parts } = input;
  return { ...parts, method: HTTP_METHODS[method], path: fillPath(path, params) };
}

async function bytesOf(body: MultipartBody['body']): Promise<Buffer> {
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer());
}

/** The body as the platform service client decodes it: JSON parsed, `text/*` as UTF-8, anything else a Buffer. */
function decodeBody(bytes: Buffer, contentType: string | string[] | undefined): unknown {
  const type = mediaType(contentType);
  if (isJsonType(type)) {
    if (bytes.length === 0) return undefined;
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error('Service gateway (called by web) answered with invalid JSON', { cause: error });
    }
  }
  return type.startsWith('text/') ? bytes.toString('utf8') : bytes;
}

/** Response headers as undici reports them: a header sent once is a string, a repeated one an array. */
function receivedHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const [only, ...more] = [value].flat();
    result[name] = only !== undefined && more.length === 0 ? only : value;
  }
  return result;
}

/** A contract-typed facade of `service` over `core`. */
function serviceFacade<F>(core: CoreCalls, service: WebServiceName): F {
  const untyped = {
    service,
    call: async (method: LowerMethod, path: ServicePath, input?: FacadeInput) =>
      core.call(service, facadeRequest(method, path, input)),
    raw: async (method: LowerMethod, path: ServicePath, input?: FacadeInput) =>
      core.raw(service, facadeRequest(method, path, input)),
  };
  // As in gateway-client: the contract types constrain callers; at runtime every operation is the same request shape.
  return untyped as unknown as F;
}

function identityFacade(core: CoreCalls): IdentityFacade {
  const facade = serviceFacade<Pick<IdentityFacade, 'service' | 'call' | 'raw'>>(core, 'identity');
  return {
    ...facade,
    currentSession: () => facade.call('get', '/v1/sessions/current'),
    sessionSites: () => facade.call('get', '/v1/sessions/current/sites'),
    adminSessionState: () => facade.call('get', '/v1/sessions/current/admin-state'),
    saveAdminSessionState: (state) => facade.call('post', '/v1/sessions/current/admin-state', { json: state }),
    csrfTokens: (contexts) => facade.call('post', '/v1/csrf/tokens', { json: { contexts } }),
  };
}

function programsSitesFacade(core: CoreCalls): ProgramsSitesFacade {
  const facade = serviceFacade<Pick<ProgramsSitesFacade, 'service' | 'call' | 'raw'>>(core, 'programs-sites');
  return {
    ...facade,
    listSites: (query) => facade.call('get', '/v1/sites', { query }),
    getSite: (siteId) => facade.call('get', '/v1/sites/{siteId}', { params: { siteId } }),
    getShellSite: (siteId) => facade.call('get', '/v1/sites/{siteId}/shell', { params: { siteId } }),
  };
}

/** An in-memory `GatewayClient` answering from `routes` with the HTTP fake's keys and replies; nothing is sent. */
export function fakeGatewayClient(
  routes: FakeRouteTable = {},
  options: FakeGatewayClientOptions = {},
): FakeGatewayClient {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const calls: FakeCall[] = [];
  let failure: { readonly error?: Error } | undefined;

  /** Records one call, then answers it as the real client would: 502, 503 and 504 throw, every other status returns. */
  async function dispatch<T>(service: WebServiceName, req: GatewayRequest, raw: boolean): Promise<GatewayResponse<T>> {
    const headers = lowerCased(req.headers);
    if (options.requestId !== undefined) headers[REQUEST_ID_HEADER] = options.requestId;
    // As on the wire, caller-set credentials never pass: `authorization` is the call's user token or absent.
    delete headers['x-serverless-authorization'];
    if (options.userToken === undefined) delete headers.authorization;
    else headers.authorization = `Bearer ${options.userToken}`;
    let body = req.body;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form !== undefined) {
      headers['content-type'] = FORM_CONTENT_TYPE;
      body = encodeForm(req.form);
    }
    const prefix = `${GATEWAY_SERVICE_PREFIX}/${service}`;
    const request = recordRequest(
      req.method,
      withQuery(`${prefix}${req.path}`, req.query),
      headers,
      typeof body === 'string' ? Buffer.from(body, 'utf8') : (body ?? Buffer.alloc(0)),
    );
    calls.push({
      service,
      method: req.method,
      path: request.path.slice(prefix.length),
      ...(Object.keys(request.query).length > 0 ? { query: request.query } : {}),
      ...(req.json !== undefined ? { json: req.json } : {}),
      ...(request.form !== undefined ? { form: request.form } : {}),
      ...(req.headers !== undefined ? { headers: lowerCased(req.headers) } : {}),
      ...(options.userToken !== undefined ? { userToken: options.userToken } : {}),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });

    if (failure !== undefined) throw failure.error ?? new GatewayUnavailableError(service);
    const reply = await answer(table, request);
    if (UNAVAILABLE_STATUSES.has(reply.status)) throw new GatewayUnavailableError(service, reply.status);
    const replyHeaders = receivedHeaders(reply.headers);
    const cookies = reply.headers['set-cookie'];
    const location = replyHeaders.location;
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      headers: replyHeaders,
      body: (raw ? reply.bytes : decodeBody(reply.bytes, replyHeaders['content-type'])) as T,
      setCookies: cookies === undefined ? [] : [cookies].flat(),
      location: Array.isArray(location) ? location[0] : location,
    };
  }

  const core: CoreCalls = {
    call: <T>(service: WebServiceName, request: GatewayRequest) => dispatch<T>(service, request, false),
    raw: (service, request) => dispatch<Buffer>(service, request, true),
  };

  return {
    ...core,
    get: (service, path, opts = {}) => core.call(service, { ...opts, method: 'GET', path }),
    post: (service, path, json, opts = {}) => core.call(service, { ...opts, method: 'POST', path, json }),
    postForm: (service, path, form, opts = {}) => core.call(service, { ...opts, method: 'POST', path, form }),
    postMultipart: async (service, path, multipart, opts = {}) =>
      core.call(service, {
        ...opts,
        method: 'POST',
        path,
        headers: { ...opts.headers, 'content-type': multipart.contentType },
        body: await bytesOf(multipart.body),
      }),
    identity: identityFacade(core),
    people: serviceFacade<GatewayClient['people']>(core, 'people'),
    programsSites: programsSitesFacade(core),
    strategiesContent: serviceFacade<GatewayClient['strategiesContent']>(core, 'strategies-content'),
    communications: serviceFacade<GatewayClient['communications']>(core, 'communications'),
    reporting: serviceFacade<GatewayClient['reporting']>(core, 'reporting'),
    surveys: serviceFacade<GatewayClient['surveys']>(core, 'surveys'),
    timesheets: serviceFacade<GatewayClient['timesheets']>(core, 'timesheets'),
    finance: serviceFacade<GatewayClient['finance']>(core, 'finance'),
    eSignature: serviceFacade<GatewayClient['eSignature']>(core, 'e-signature'),
    calls,
    setRoute: (key, route) => {
      table.set(key, route);
    },
    hasRoute: (key) => table.has(key),
    failWith: (error) => {
      failure = { error };
    },
    reset: () => {
      calls.length = 0;
      failure = undefined;
    },
  };
}

