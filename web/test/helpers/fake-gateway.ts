// Fakes of web's only outbound path, the gateway relay: a loopback HTTP server, and the production GatewayClient
// over an in-memory platform client.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import {
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
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
function receivedRequest(req: ServiceRequest): RecordedRequest {
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
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : (body ?? Buffer.alloc(0));
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

/** The production `GatewayClient` over its own in-memory platform client answering `routes`; nothing is sent. */
export function fakeGatewayClient(
  routes: FakeRouteTable = {},
  options: FakeGatewayClientOptions = {},
): FakeGatewayClient {
  const table = new Map<string, FakeRoute>(Object.entries(routes));
  const calls: FakeCall[] = [];
  let failure: { readonly error?: Error } | undefined;

  const transport: ServiceClient = {
    /** Records the call, then answers it from `table` with the bytes web's raw-body requests ask for. */
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      const request = receivedRequest(req);
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
      if (failure !== undefined) {
        const refused = Object.assign(new Error('connect ECONNREFUSED (fake gateway)'), { code: 'ECONNREFUSED' });
        throw failure.error ?? new ServiceUnavailableError('gateway', refused);
      }
      const reply = await answer(table, request);
      return { status: reply.status, headers: receivedHeaders(reply.headers), body: reply.bytes as unknown as T };
    },
    // Nothing to release: the transport holds no connection.
    close: () => Promise.resolve(),
  };

  // An absent request id travels as '', which `receivedRequest` drops, so none is recorded.
  const client = createGatewayClient(
    { userToken: options.userToken, requestId: options.requestId ?? '', inbound: {} },
    transport,
  );

  return {
    ...client,
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
