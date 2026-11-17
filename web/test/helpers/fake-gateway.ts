// Fakes of web's only outbound path, the gateway relay: a loopback HTTP server, the production platform client over an
// in-memory transport, an in-memory platform client, and the production GatewayClient over it.
import { readFileSync } from 'node:fs';
import { STATUS_CODES, createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import {
  Agent,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  createServiceClient,
  type Dispatcher,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { webAuthRuntime } from '@/lib/auth';
import { GATEWAY_SERVICE_PREFIX } from '@/lib/env';
import {
  WEB_SERVICE_NAMES,
  createGatewayClient,
  type GatewayClient,
  type HttpMethod,
  type ServicePath,
  type WebServiceName,
} from '@/lib/gateway-client';

const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
// Request targets are origin-form; the base only lets URL parse them.
const TARGET_BASE = 'http://fake-gateway.invalid';

/**
 * A canned gateway answer; a body that is neither a string, a Buffer nor a `Readable` is sent as JSON. A `Readable` is
 * sent as it produces, so a route can model a slow producer; it is read once, so a route function creates one per call.
 */
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
  readonly body: Buffer | Readable;
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

/** Status, lower-cased headers and bytes (or the stream) of `reply`, as the HTTP fake sends them. */
function encodeReply({ status, headers, body, setCookies = [] }: FakeReply): EncodedReply {
  const encoded: Record<string, string | string[]> = lowerCased(headers);
  let encodedBody: Buffer | Readable;
  if (body === undefined) encodedBody = Buffer.alloc(0);
  else if (Buffer.isBuffer(body) || body instanceof Readable) encodedBody = body;
  else if (typeof body === 'string') encodedBody = Buffer.from(body, 'utf8');
  else {
    encodedBody = Buffer.from(JSON.stringify(body), 'utf8');
    encoded['content-type'] ??= JSON_CONTENT_TYPE;
  }
  const cookies = [...[encoded['set-cookie'] ?? []].flat(), ...setCookies];
  if (cookies.length > 0) encoded['set-cookie'] = cookies;
  return { status, headers: encoded, body: encodedBody };
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
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          // A client that hangs up early destroys a streamed body, as it would a real producer's.
          if (body instanceof Readable) pipeline(body, res, () => undefined);
          else res.end(body);
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

/** Response headers as undici reports them: a header sent once is a string, a repeated one an array. */
function receivedHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const [only, ...more] = [value].flat();
    result[name] = only !== undefined && more.length === 0 ? only : value;
  }
  return result;
}

const RELAY_PREFIX = `${GATEWAY_SERVICE_PREFIX}/`;

/** The relayed service named by the first segment of `path` under the gateway's service prefix. */
function relayedService(path: string): WebServiceName {
  const name = path.startsWith(RELAY_PREFIX) ? path.slice(RELAY_PREFIX.length).split('/')[0] : undefined;
  const service = WEB_SERVICE_NAMES.find((known) => known === name);
  if (service === undefined) throw new TypeError(`${path} is not a gateway service path`);
  return service;
}

/** `req` as the gateway receives it from the platform client, which mints no invocation credential here. */
async function receivedRequest(req: ServiceRequest): Promise<RecordedRequest> {
  if (req.query !== undefined || req.form !== undefined) {
    throw new TypeError('Web sends its query in the path and its form as the body');
  }
  const headers = lowerCased(req.headers);
  if (headers[REQUEST_ID_HEADER] === '') delete headers[REQUEST_ID_HEADER];
  delete headers[INVOCATION_HEADER];
  if (typeof req.userToken === 'string') headers.authorization = `Bearer ${req.userToken}`;
  else delete headers.authorization;
  let body = req.body;
  if (req.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.json);
  }
  let bytes: Buffer;
  if (typeof body === 'string') bytes = Buffer.from(body, 'utf8');
  else if (body instanceof Readable) bytes = await buffer(body);
  else bytes = body ?? Buffer.alloc(0);
  return recordRequest(req.method, req.path, headers, bytes);
}

/** Headers of `req` the caller set: without the request id and a form body's content type, which web adds. */
function callerHeaders(req: ServiceRequest): Record<string, string> {
  const headers = lowerCased(req.headers);
  delete headers[REQUEST_ID_HEADER];
  const formBody = req.json === undefined && typeof req.body === 'string';
  if (formBody && headers['content-type'] === FORM_CONTENT_TYPE) delete headers['content-type'];
  return headers;
}

/** The body the platform client returns for `reply`: a streamed 2xx unread as a byte stream, anything else read whole. */
async function bodyOf(req: ServiceRequest, { status, body }: EncodedReply): Promise<Buffer | Readable> {
  if (req.stream !== true || status < 200 || status > 299) return body instanceof Readable ? buffer(body) : body;
  if (body instanceof Readable) return body;
  return Readable.from(body.length === 0 ? [] : [body], { objectMode: false });
}

/** An in-memory platform `ServiceClient` in the gateway's place, recording each request as the HTTP fake does. */
export type FakeServiceClient = ServiceClient & {
  readonly requests: RecordedRequest[];
  setRoute(key: string, route: FakeRoute): void;
  hasRoute(key: string): boolean;
  /** Makes this and every later request throw `error`, by default the platform's error for a refused connection. */
  failWith(error?: Error): void;
  /** Clears the recorded requests and any `failWith`; routes are kept. */
  reset(): void;
};

/**
 * A platform client answering `routes` with the bytes web's raw-body requests ask for, or a streamed 2xx body as a
 * stream; nothing is sent.
 * @param onRequest Called with each request and its record, before any `failWith` error is thrown.
 */
export function fakeServiceClient(
  routes: FakeRouteTable = {},
  onRequest?: (req: ServiceRequest, request: RecordedRequest) => void,
): FakeServiceClient {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  let failure: { readonly error?: Error } | undefined;

  return {
    requests,
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      const request = await receivedRequest(req);
      requests.push(request);
      onRequest?.(req, request);
      if (failure !== undefined) {
        const refused = Object.assign(new Error('connect ECONNREFUSED (fake gateway)'), { code: 'ECONNREFUSED' });
        throw failure.error ?? new ServiceUnavailableError('gateway', refused);
      }
      const reply = await answer(table, request);
      return { status: reply.status, headers: receivedHeaders(reply.headers), body: (await bodyOf(req, reply)) as T };
    },
    // Nothing to release: the client holds no connection.
    close: () => Promise.resolve(),
    setRoute: (key, route) => {
      table.set(key, route);
    },
    hasRoute: (key) => table.has(key),
    failWith: (error) => {
      failure = { error };
    },
    reset: () => {
      requests.length = 0;
      failure = undefined;
    },
  };
}

/** The production `GatewayClient` over its own {@link fakeServiceClient} answering `routes`; nothing is sent. */
export function fakeGatewayClient(
  routes: FakeRouteTable = {},
  options: FakeGatewayClientOptions = {},
): FakeGatewayClient {
  const calls: FakeCall[] = [];
  const relay = fakeServiceClient(routes, (req, request) => {
    const service = relayedService(request.path);
    const headers = callerHeaders(req);
    calls.push({
      service,
      method: req.method,
      path: request.path.slice(`${RELAY_PREFIX}${service}`.length),
      ...(Object.keys(request.query).length > 0 ? { query: request.query } : {}),
      ...(req.json !== undefined ? { json: req.json } : {}),
      ...(request.form !== undefined ? { form: request.form } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(options.userToken !== undefined ? { userToken: options.userToken } : {}),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
  });

  // An absent request id travels as '', which `receivedRequest` drops, so none is recorded.
  const client = createGatewayClient(
    { userToken: options.userToken, requestId: options.requestId ?? '', inbound: {} },
    relay,
  );

  return {
    ...client,
    calls,
    setRoute: relay.setRoute,
    hasRoute: relay.hasRoute,
    failWith: relay.failWith,
    reset: () => {
      calls.length = 0;
      relay.reset();
    },
  };
}

/** A gateway answering in memory beneath the production platform client; every request it receives is recorded. */
export interface InMemoryGateway {
  /** The production platform client over this gateway, for `setServiceClientForTests`. */
  readonly client: ServiceClient;
  readonly requests: RecordedRequest[];
  setRoute(key: string, route: FakeRoute): void;
  /** Fails this and every later request as a refused connection (ECONNREFUSED), unrecorded as the HTTP fake's are. */
  refuse(): void;
}

/** Headers the platform client dispatches, names lower-cased and a repeated value joined, as the gateway receives them. */
function dispatchedHeaders(headers: Dispatcher.DispatchOptions['headers']): RecordedHeaders {
  if (headers === undefined || headers === null) return {};
  if (Array.isArray(headers) || Symbol.iterator in headers) {
    throw new TypeError('The platform client dispatches its headers as a record');
  }
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name.toLowerCase(), [value].flat().join(', ')]],
    ),
  );
}

/** The bytes of a dispatched request body. */
async function dispatchedBytes(body: Dispatcher.DispatchOptions['body']): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Readable) return buffer(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError('The platform client dispatches a string, bytes or a Readable as the body');
}

/**
 * An undici interceptor answering each dispatch from `respond` without calling the dispatcher it wraps. A streamed reply
 * is delivered as it is produced, paused while the reader is full, and destroyed when the reader aborts.
 */
function inMemoryTransport(
  respond: (opts: Dispatcher.DispatchOptions) => Promise<EncodedReply>,
): Dispatcher.DispatcherComposeInterceptor {
  return () => (opts, handler) => {
    let source: Readable | undefined;
    let aborted = false;
    let paused = false;
    let reason: Error | null = null;
    let settled = false;
    const controller: Dispatcher.DispatchController = {
      get aborted() {
        return aborted;
      },
      get paused() {
        return paused;
      },
      get reason() {
        return reason;
      },
      // undici's body stream aborts without a reason when its reader destroys it.
      abort(error: Error | undefined) {
        if (aborted || settled) return;
        aborted = true;
        reason = error ?? new Error('Request aborted');
        source?.destroy();
        handler.onResponseError?.(controller, reason);
      },
      pause() {
        paused = true;
      },
      resume() {
        paused = false;
        source?.resume();
      },
    };
    const fail = (error: Error): void => {
      if (aborted || settled) return;
      settled = true;
      handler.onResponseError?.(controller, error);
    };
    const end = (): void => {
      settled = true;
      handler.onResponseEnd?.(controller, {});
    };

    handler.onRequestStart?.(controller, {});
    void respond(opts).then(({ status, headers, body }) => {
      if (aborted) {
        if (body instanceof Readable) body.destroy();
        return;
      }
      handler.onResponseStart?.(controller, status, receivedHeaders(headers), STATUS_CODES[status]);
      if (!(body instanceof Readable)) {
        if (body.length > 0) handler.onResponseData?.(controller, body);
        end();
        return;
      }
      source = body;
      body.on('data', (chunk: Buffer | string) => {
        // A socket delivers bytes whatever the producer wrote.
        handler.onResponseData?.(controller, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (paused) body.pause();
      });
      body.once('end', end);
      body.once('error', fail);
    }, fail);
    return true;
  };
}

/**
 * A gateway answering `routes` in memory beneath the production platform client, which sends the user token and web's
 * minted invocation credential as it does over HTTP; unrouted requests get an empty 404, and nothing leaves the process.
 */
export function inMemoryGateway(routes: FakeRouteTable = {}): InMemoryGateway {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  let refused = false;

  async function respond({ method, path, headers, body }: Dispatcher.DispatchOptions): Promise<EncodedReply> {
    if (refused) throw Object.assign(new Error('connect ECONNREFUSED (in-memory gateway)'), { code: 'ECONNREFUSED' });
    const request = recordRequest(method, path, dispatchedHeaders(headers), await dispatchedBytes(body));
    requests.push(request);
    // A failing route handler answers at once, as the HTTP fake answers it.
    return answer(table, request).catch((error: unknown) =>
      encodeReply({ status: 500, headers: { 'content-type': 'text/plain;charset=utf-8' }, body: String(error) }),
    );
  }

  const client = createServiceClient({
    serviceUrls: { gateway: TARGET_BASE },
    self: 'web',
    // Web's own minter, as the process-wide client uses it: the installed auth runtime signs for the gateway.
    credentials: {
      headersFor: async (target, opts) => (await webAuthRuntime()).invocationMinter.headersFor(target, opts),
    },
    dispatcher: new Agent().compose(inMemoryTransport(respond)),
  });

  return {
    client,
    requests,
    setRoute: (key, route) => {
      table.set(key, route);
    },
    refuse: () => {
      refused = true;
    },
  };
}

