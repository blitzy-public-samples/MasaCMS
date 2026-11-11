// Web's only data path: service calls relayed by the gateway under GATEWAY_SERVICE_PREFIX (server-only).
import type { InvocationMinter } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  createServiceClient,
  decodeServiceBody,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { activeSpanIds, withExtractedContext } from '@opt2/platform/tracing';
import type { paths as CommunicationsPaths } from '@/generated/clients/communications';
import type { paths as ESignaturePaths } from '@/generated/clients/e-signature';
import type { paths as FinancePaths } from '@/generated/clients/finance';
import type { paths as IdentityPaths } from '@/generated/clients/identity';
import type { paths as PeoplePaths } from '@/generated/clients/people';
import type { paths as ProgramsSitesPaths } from '@/generated/clients/programs-sites';
import type { paths as ReportingPaths } from '@/generated/clients/reporting';
import type { paths as StrategiesContentPaths } from '@/generated/clients/strategies-content';
import type { paths as SurveysPaths } from '@/generated/clients/surveys';
import type { paths as TimesheetsPaths } from '@/generated/clients/timesheets';
import { webAuthRuntime } from './auth';
import { GATEWAY_SERVICE_PREFIX, webEnv } from './env';

/** Service folder names the gateway relays web's calls to. */
export const WEB_SERVICE_NAMES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
] as const;

/** One of the ten services web calls through the gateway. */
export type WebServiceName = (typeof WEB_SERVICE_NAMES)[number];

// The gateway is the platform client's only callee, so the invocation credential's audience is always the gateway.
const GATEWAY_CALLEE = 'gateway';
const WEB_CALLER = 'web';
// The platform client's own callee label, so decode errors read as they would from the client.
const GATEWAY_LABEL = `Service ${GATEWAY_CALLEE} (called by ${WEB_CALLER})`;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Per-request facts every call carries. */
export interface GatewayCallContext {
  /** Raw bearer user token exactly as the gateway attached it, an anonymous session's included; absent without one. */
  readonly userToken?: string;
  readonly requestId: string;
  /** Inbound request headers; their `traceparent`/`tracestate` continue the trace when no span is active. */
  readonly inbound: HeadersInit;
}

/** HTTP methods of a service call. */
export type HttpMethod = ServiceRequest['method'];

/** Service path, for example `/v1/sites`. */
export type ServicePath = `/${string}`;

export type QueryValue = string | number | boolean;

/** Query parameters in order; null and undefined are skipped and an object value expands into its own pairs. */
export type QueryInput =
  | URLSearchParams
  | Readonly<Record<string, QueryValue | readonly QueryValue[] | Readonly<Record<string, QueryValue>> | null | undefined>>;

/** Form fields in order; array values and repeated entries repeat the field. */
export type FormInput =
  | URLSearchParams
  | FormData
  | Iterable<readonly [string, string]>
  | Readonly<Record<string, string | readonly string[]>>;

/** One call to a service through the gateway. */
export interface GatewayRequest {
  readonly method: HttpMethod;
  readonly path: ServicePath;
  readonly query?: QueryInput;
  /** Body sent as `application/json`; takes precedence over `form` and `body`. */
  readonly json?: unknown;
  /** Body sent as `application/x-www-form-urlencoded`, fields in the given order; takes precedence over `body`. */
  readonly form?: FormInput;
  /** Raw body; the caller sets its content type in `headers`. */
  readonly body?: Buffer | string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Query and headers of the convenience calls. */
export type GatewayRequestOptions = Pick<GatewayRequest, 'query' | 'headers'>;

/** A multipart body relayed with its original `content-type`, boundary included. */
export interface MultipartBody {
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array;
}

/** The gateway's answer with every status, headers and body as relayed. */
export interface GatewayResponse<T = unknown> {
  readonly status: number;
  /** Whether the status is 2xx. */
  readonly ok: boolean;
  /** Response headers with lower-cased names. */
  readonly headers: Readonly<Record<string, string | string[]>>;
  readonly body: T;
  /** Every `Set-Cookie` value, unchanged and in order. */
  readonly setCookies: readonly string[];
  /** The `Location` header, unchanged. */
  readonly location?: string;
}

/** The owning service is unreachable or the gateway answered 502, 503 or 504; renders as the legacy admin 503. */
export class GatewayUnavailableError extends LegacyServiceUnavailableError {
  override readonly name: string = 'GatewayUnavailableError';

  constructor(
    readonly service: WebServiceName,
    /** Gateway status; undefined when the gateway itself could not be reached or did not answer in time. */
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(
      `Service ${service} unavailable through the gateway (${status === undefined ? 'no answer' : `HTTP ${status}`})`,
      'admin',
      'gateway-unavailable',
    );
  }
}

/** Whether `value` is an unavailability error or a response with an unavailable status (502, 503, 504). */
export function isUnavailable(value: unknown): boolean {
  if (value instanceof LegacyServiceUnavailableError) return true;
  const status = (value as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && UNAVAILABLE_STATUSES.has(status);
}

/** Web's invocation credential, minted by the auth runtime (local signer or Google ID token). */
const webInvocationMinter: InvocationMinter = {
  async headersFor(target, opts) {
    return (await webAuthRuntime()).invocationMinter.headersFor(target, opts);
  },
};

let serviceClient: ServiceClient | undefined;

/** The process-wide platform client, whose only callee is the gateway. */
function processServiceClient(): ServiceClient {
  serviceClient ??= createServiceClient({
    serviceUrls: { [GATEWAY_CALLEE]: webEnv().OPT2_GATEWAY_URL },
    self: WEB_CALLER,
    credentials: webInvocationMinter,
  });
  return serviceClient;
}

/** Installs `client` (`undefined` rebuilds from the environment on next use); returns a restore function. */
export function setServiceClientForTests(client: ServiceClient | undefined): () => void {
  const previous = serviceClient;
  serviceClient = client;
  return () => {
    serviceClient = previous;
  };
}

function lowerCased(headers: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function isIterable<T>(value: object): value is Iterable<T> {
  return Symbol.iterator in value;
}

function isQueryObject(value: QueryValue | readonly QueryValue[] | object): value is Readonly<Record<string, QueryValue>> {
  return typeof value === 'object' && !Array.isArray(value);
}

/** Query pairs in the given order. */
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

/** `path` with the query appended, form-encoded as browsers encode it. */
function withQuery(path: string, query: QueryInput | undefined): string {
  const search = query === undefined ? '' : queryParams(query).toString();
  return search === '' ? path : `${path}${path.includes('?') ? '&' : '?'}${search}`;
}

/** The URL-encoded form body, fields in the given order. */
function encodeForm(form: FormInput): string {
  const entries: Iterable<readonly [string, unknown]> = isIterable<readonly [string, unknown]>(form)
    ? form
    : Object.entries(form).flatMap(([name, value]) => [value].flat().map((item): [string, string] => [name, item]));
  const params = new URLSearchParams();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') throw new TypeError(`Form field ${name} is a file; send it with postMultipart`);
    params.append(name, value);
  }
  return params.toString();
}

/** Runs `send` so the platform client propagates the active span, else the inbound trace context unchanged. */
function withInboundTrace<T>(inbound: HeadersInit, headers: Record<string, string>, send: () => Promise<T>): Promise<T> {
  if (activeSpanIds() !== undefined) return send();
  const received = new Headers(inbound);
  const traceparent = received.get('traceparent') ?? undefined;
  const tracestate = received.get('tracestate') ?? undefined;
  return withExtractedContext({ traceparent, tracestate }, () => {
    // Without a registered context manager the extraction never becomes active (and nothing injects), so copy as received.
    if (activeSpanIds() === undefined && traceparent !== undefined) {
      headers.traceparent = traceparent;
      if (tracestate !== undefined) headers.tracestate = tracestate;
    }
    return send();
  });
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toGatewayResponse<T>({ status, headers, body }: ServiceResponse<T>): GatewayResponse<T> {
  const cookies = headers['set-cookie'];
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    setCookies: cookies === undefined ? [] : [cookies].flat(),
    location: firstValue(headers.location),
  };
}

/** Sends one call through the gateway, failing closed on unavailability; every other status is returned. */
async function send<T>(
  ctx: GatewayCallContext,
  service: WebServiceName,
  req: GatewayRequest,
  rawBody: boolean,
): Promise<GatewayResponse<T>> {
  const headers = lowerCased(req.headers);
  headers[REQUEST_ID_HEADER] = ctx.requestId;
  let body = req.body;
  if (req.json === undefined && req.form !== undefined) {
    headers['content-type'] = FORM_CONTENT_TYPE;
    body = encodeForm(req.form);
  }
  const request: ServiceRequest = {
    service: GATEWAY_CALLEE,
    method: req.method,
    path: withQuery(`${GATEWAY_SERVICE_PREFIX}/${service}${req.path}`, req.query),
    json: req.json,
    body,
    headers,
    // Web has no request context, so null keeps an anonymous call anonymous instead of falling back to one.
    userToken: ctx.userToken ?? null,
    // Bytes always, so an unavailable status fails closed whatever its body; decoded below otherwise.
    rawBody: true,
  };
  let response: ServiceResponse<Buffer>;
  try {
    response = await withInboundTrace(ctx.inbound, headers, () => processServiceClient().request<Buffer>(request));
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw new GatewayUnavailableError(service, undefined, error);
    throw error;
  }
  if (UNAVAILABLE_STATUSES.has(response.status)) throw new GatewayUnavailableError(service, response.status);
  const decoded = rawBody
    ? response.body
    : decodeServiceBody(response.body, response.headers['content-type'], GATEWAY_LABEL);
  return toGatewayResponse({ ...response, body: decoded as T });
}

type LowerMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

const HTTP_METHODS: Readonly<Record<LowerMethod, HttpMethod>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

/** Path templates of a generated `paths` type. */
export type PathOf<Paths> = Extract<keyof Paths, ServicePath>;

/** Methods a generated path item defines. */
export type MethodOf<Item> = {
  [M in LowerMethod & keyof Item]-?: undefined extends Item[M] ? never : M;
}[LowerMethod & keyof Item];

/** The generated operation of `method` on a path item. */
export type OperationOf<Item, M extends LowerMethod> = Exclude<Item[M & keyof Item], undefined>;

type ParametersOf<Op> = Op extends { parameters: infer Parameters } ? Parameters : never;

/** Path parameters of an operation; `never` when its path has none. */
export type PathParamsOf<Op> = Exclude<ParametersOf<Op> extends { path?: infer Path } ? Path : never, undefined>;

/** Query parameters of an operation; `never` when it declares none. */
export type QueryOf<Op> = Exclude<ParametersOf<Op> extends { query?: infer Query } ? Query : never, undefined>;

type RequestContentOf<Op> = Op extends { requestBody?: infer Body }
  ? [Exclude<Body, undefined>] extends [never]
    ? never
    : Exclude<Body, undefined> extends { content: infer Content }
      ? Content
      : never
  : never;

/** JSON request body of an operation; `never` when it accepts none. */
export type JsonBodyOf<Op> = [RequestContentOf<Op>] extends [never]
  ? never
  : RequestContentOf<Op> extends { 'application/json': infer Json }
    ? Json
    : never;

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226 | '2XX';
type ResponsesOf<Op> = Op extends { responses: infer Responses } ? Responses : never;
type ContentBodyOf<Response> = Response extends { content: infer Content } ? Content[keyof Content] : undefined;

/** Body of an operation's 2xx responses as `call` decodes it. */
export type SuccessBodyOf<Op> = {
  [S in keyof ResponsesOf<Op>]: S extends SuccessStatus ? ContentBodyOf<ResponsesOf<Op>[S]> : never;
}[keyof ResponsesOf<Op>];

/** A typed call's answer: the contract's success body when `ok`, otherwise the body as relayed. */
export type OperationResponse<Op> =
  | (GatewayResponse<SuccessBodyOf<Op>> & { readonly ok: true })
  | (GatewayResponse<unknown> & { readonly ok: false });

type PathInputOf<Op> = [PathParamsOf<Op>] extends [never]
  ? { readonly params?: never }
  : { readonly params: PathParamsOf<Op> };

type QueryInputOf<Op> = [QueryOf<Op>] extends [never]
  ? { readonly query?: never }
  : ParametersOf<Op> extends { query: object }
    ? { readonly query: QueryOf<Op> }
    : { readonly query?: QueryOf<Op> };

/** Request parts of a typed call: `params` fill the `{name}` segments of the path template. */
export type OperationInput<Op> = PathInputOf<Op> &
  QueryInputOf<Op> & {
    readonly json?: JsonBodyOf<Op>;
    readonly form?: FormInput;
    readonly body?: Buffer | string;
    readonly headers?: Readonly<Record<string, string>>;
  };

type InputArgs<Op> = object extends OperationInput<Op> ? [input?: OperationInput<Op>] : [input: OperationInput<Op>];

/** Calls bound to one service and typed by its generated contract. */
export interface ServiceFacade<Paths> {
  readonly service: WebServiceName;
  /** Calls `method` on the contract path template `path`. */
  call<P extends PathOf<Paths>, M extends MethodOf<Paths[P]>>(
    method: M,
    path: P,
    ...input: InputArgs<OperationOf<Paths[P], M>>
  ): Promise<OperationResponse<OperationOf<Paths[P], M>>>;
  /** As `call`, with the body returned as the received bytes. */
  raw<P extends PathOf<Paths>, M extends MethodOf<Paths[P]>>(
    method: M,
    path: P,
    ...input: InputArgs<OperationOf<Paths[P], M>>
  ): Promise<GatewayResponse<Buffer>>;
}

type IdentityOperation<P extends PathOf<IdentityPaths>, M extends MethodOf<IdentityPaths[P]>> = OperationOf<
  IdentityPaths[P],
  M
>;
type ProgramsSitesOperation<P extends PathOf<ProgramsSitesPaths>, M extends MethodOf<ProgramsSitesPaths[P]>> = OperationOf<
  ProgramsSitesPaths[P],
  M
>;
type CurrentSessionOperation = IdentityOperation<'/v1/sessions/current', 'get'>;
type SessionSitesOperation = IdentityOperation<'/v1/sessions/current/sites', 'get'>;
type CsrfTokensOperation = IdentityOperation<'/v1/csrf/tokens', 'post'>;
type ListSitesOperation = ProgramsSitesOperation<'/v1/sites', 'get'>;
type GetSiteOperation = ProgramsSitesOperation<'/v1/sites/{siteId}', 'get'>;

/** Identity calls, plus the session and CSRF operations the shell and lib use. */
export interface IdentityFacade extends ServiceFacade<IdentityPaths> {
  /** The session's user struct and login-time roles (`getCurrentSession`). */
  currentSession(): Promise<OperationResponse<CurrentSessionOperation>>;
  /** Sites the session may administer, the admin `siteArray` (`listCurrentSessionSites`). */
  sessionSites(): Promise<OperationResponse<SessionSitesOperation>>;
  /** One token pair per legacy CSRF context, in request order (`issueCsrfTokens`). */
  csrfTokens(contexts: JsonBodyOf<CsrfTokensOperation>['contexts']): Promise<OperationResponse<CsrfTokensOperation>>;
}

/** Programs-sites calls, plus the site reads the shell and lib use. */
export interface ProgramsSitesFacade extends ServiceFacade<ProgramsSitesPaths> {
  /** Every site, sorted as the Sites screen sorts them (`listSites`). */
  listSites(query?: QueryOf<ListSitesOperation>): Promise<OperationResponse<ListSitesOperation>>;
  /** One site with the data of every Edit Site tab (`getSite`). */
  getSite(siteId: PathParamsOf<GetSiteOperation>['siteId']): Promise<OperationResponse<GetSiteOperation>>;
}

/** Service calls of one web request, all relayed by the gateway. */
export interface GatewayClient {
  /** Sends one call: JSON bodies parsed, `text/*` decoded as UTF-8, anything else a Buffer. */
  call<T = unknown>(service: WebServiceName, request: GatewayRequest): Promise<GatewayResponse<T>>;
  /** Sends one call and returns the body as the received bytes, for fragment, JSON and download passthrough. */
  raw(service: WebServiceName, request: GatewayRequest): Promise<GatewayResponse<Buffer>>;
  get<T = unknown>(service: WebServiceName, path: ServicePath, options?: GatewayRequestOptions): Promise<GatewayResponse<T>>;
  /** POSTs `json` as `application/json`. */
  post<T = unknown>(
    service: WebServiceName,
    path: ServicePath,
    json: unknown,
    options?: GatewayRequestOptions,
  ): Promise<GatewayResponse<T>>;
  /** POSTs `form` URL-encoded with its field names and order unchanged. */
  postForm<T = unknown>(
    service: WebServiceName,
    path: ServicePath,
    form: FormInput,
    options?: GatewayRequestOptions,
  ): Promise<GatewayResponse<T>>;
  /** POSTs an inbound multipart body unchanged, with its own content type and boundary. */
  postMultipart<T = unknown>(
    service: WebServiceName,
    path: ServicePath,
    multipart: MultipartBody,
    options?: GatewayRequestOptions,
  ): Promise<GatewayResponse<T>>;
  readonly identity: IdentityFacade;
  readonly people: ServiceFacade<PeoplePaths>;
  readonly programsSites: ProgramsSitesFacade;
  readonly strategiesContent: ServiceFacade<StrategiesContentPaths>;
  readonly communications: ServiceFacade<CommunicationsPaths>;
  readonly reporting: ServiceFacade<ReportingPaths>;
  readonly surveys: ServiceFacade<SurveysPaths>;
  readonly timesheets: ServiceFacade<TimesheetsPaths>;
  readonly finance: ServiceFacade<FinancePaths>;
  readonly eSignature: ServiceFacade<ESignaturePaths>;
}

type CoreCalls = Pick<GatewayClient, 'call' | 'raw'>;

interface UntypedInput {
  readonly params?: Readonly<Record<string, unknown>>;
  readonly query?: QueryInput;
  readonly json?: unknown;
  readonly form?: FormInput;
  readonly body?: Buffer | string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** `template` with each `{name}` segment replaced by the URI-encoded parameter. */
function fillPath(template: ServicePath, params: Readonly<Record<string, unknown>> = {}): ServicePath {
  return template.replace(/\{([^}]+)\}/g, (_segment, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) throw new TypeError(`Missing path parameter ${name} of ${template}`);
    return encodeURIComponent(String(value));
  }) as ServicePath;
}

function facadeRequest(method: LowerMethod, path: ServicePath, input: UntypedInput = {}): GatewayRequest {
  const { params, ...parts } = input;
  return { ...parts, method: HTTP_METHODS[method], path: fillPath(path, params) };
}

/** A contract-typed facade over `core` for `service`. */
function serviceFacade<Paths>(core: CoreCalls, service: WebServiceName): ServiceFacade<Paths> {
  const untyped = {
    service,
    call: async (method: LowerMethod, path: ServicePath, input?: UntypedInput) =>
      core.call(service, facadeRequest(method, path, input)),
    raw: async (method: LowerMethod, path: ServicePath, input?: UntypedInput) =>
      core.raw(service, facadeRequest(method, path, input)),
  };
  // The contract types constrain callers; at runtime every operation is the same request shape.
  return untyped as unknown as ServiceFacade<Paths>;
}

function identityFacade(core: CoreCalls): IdentityFacade {
  const facade = serviceFacade<IdentityPaths>(core, 'identity');
  return {
    ...facade,
    currentSession: () => facade.call('get', '/v1/sessions/current'),
    sessionSites: () => facade.call('get', '/v1/sessions/current/sites'),
    csrfTokens: (contexts) => facade.call('post', '/v1/csrf/tokens', { json: { contexts } }),
  };
}

function programsSitesFacade(core: CoreCalls): ProgramsSitesFacade {
  const facade = serviceFacade<ProgramsSitesPaths>(core, 'programs-sites');
  return {
    ...facade,
    listSites: (query) => facade.call('get', '/v1/sites', { query }),
    getSite: (siteId) => facade.call('get', '/v1/sites/{siteId}', { params: { siteId } }),
  };
}

// Buffered, not streamed: the platform client sends only Buffer or string bodies.
async function bytesOf(body: MultipartBody['body']): Promise<Buffer> {
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer());
}

/** The service calls of one web request, carrying its user token, request id and trace context. */
export function createGatewayClient(ctx: GatewayCallContext): GatewayClient {
  const core: CoreCalls = {
    call: <T>(service: WebServiceName, request: GatewayRequest) => send<T>(ctx, service, request, false),
    raw: (service, request) => send<Buffer>(ctx, service, request, true),
  };
  return {
    ...core,
    get: (service, path, options = {}) => core.call(service, { ...options, method: 'GET', path }),
    post: (service, path, json, options = {}) => core.call(service, { ...options, method: 'POST', path, json }),
    postForm: (service, path, form, options = {}) => core.call(service, { ...options, method: 'POST', path, form }),
    postMultipart: async (service, path, multipart, options = {}) =>
      core.call(service, {
        ...options,
        method: 'POST',
        path,
        headers: { ...options.headers, 'content-type': multipart.contentType },
        body: await bytesOf(multipart.body),
      }),
    identity: identityFacade(core),
    people: serviceFacade(core, 'people'),
    programsSites: programsSitesFacade(core),
    strategiesContent: serviceFacade(core, 'strategies-content'),
    communications: serviceFacade(core, 'communications'),
    reporting: serviceFacade(core, 'reporting'),
    surveys: serviceFacade(core, 'surveys'),
    timesheets: serviceFacade(core, 'timesheets'),
    finance: serviceFacade(core, 'finance'),
    eSignature: serviceFacade(core, 'e-signature'),
  };
}
