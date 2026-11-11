// Tests of web's gateway client against a loopback fake gateway, signing with the platform test keys.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, LOCAL_USER_TOKEN, Roles } from '@opt2/platform/auth';
import { LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  loadEnv,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, mintUserToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import {
  MemorySpanExporter,
  SpanKind,
  activeSpanIds,
  shutdownTracing,
  startSpan,
  startTracing,
} from '@opt2/platform/tracing';
import { setWebAuthRuntimeForTests } from '@/lib/auth';
import { GATEWAY_SERVICE_PREFIX, setWebEnvForTests, webEnvSchema, type WebEnv } from '@/lib/env';
import {
  GatewayUnavailableError,
  WEB_SERVICE_NAMES,
  createGatewayClient,
  isUnavailable,
  setServiceClientForTests,
  type FormInput,
  type GatewayCallContext,
  type GatewayClient,
  type GatewayRequest,
  type GatewayResponse,
  type HttpMethod,
  type MultipartBody,
  type QueryInput,
  type ServicePath,
  type WebServiceName,
} from '@/lib/gateway-client';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const CSV_FIXTURE = new URL('../fixtures/strategies-content/downloaddata.csv', import.meta.url);
const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;
const INBOUND_TRACESTATE = 'opt2=web-test,vendor=1';
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const ANONYMOUS: GatewayCallContext = { requestId: 'req-anonymous', inbound: {} };

/** One request as the fake gateway received it. */
interface RecordedRequest {
  readonly method: string;
  /** Path and query as sent. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
}

/** A fake gateway answer; `destroy` sends the head and part of the body, then drops the socket. */
type FakeReply =
  | { readonly status?: number; readonly headers?: OutgoingHttpHeaders; readonly body?: string | Buffer }
  | { readonly destroy: true };

/** Loopback HTTP server standing in for the gateway's `/opt2/svc/<service>/<path>` relay. */
interface FakeGateway {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** Answers `method` on `/opt2/svc/<service><path>`, whatever the query; unrouted requests get 404. */
  route(method: HttpMethod, service: WebServiceName, path: ServicePath, reply: FakeReply): void;
  close(): Promise<void>;
}

async function listening(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startFakeGateway(): Promise<FakeGateway> {
  const routes = new Map<string, FakeReply>();
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '/';
      const method = req.method ?? '';
      requests.push({ method, url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
      const reply = routes.get(`${method} ${new URL(url, 'http://gateway.test').pathname}`);
      if (reply === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`No route for ${method} ${url}`);
      } else if ('destroy' in reply) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
        res.write('{"partial":', () => res.destroy());
      } else {
        res.writeHead(reply.status ?? 200, reply.headers).end(reply.body);
      }
    });
  });
  const url = await listening(server);
  return {
    url,
    requests,
    route(method, service, servicePath, reply) {
      routes.set(`${method} ${GATEWAY_SERVICE_PREFIX}/${service}${servicePath}`, reply);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** Base URL of a loopback port nothing listens on, so connections are refused. */
async function refusedUrl(): Promise<string> {
  const server = createServer();
  const url = await listening(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

const jsonReply = (body: unknown, status = 200): FakeReply => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

const OK = jsonReply({ ok: true });

let root: string;
let stateDir: string;
let gateway: FakeGateway;
let restoreEnv: () => void;
let restoreRuntime: () => void;
let restoreClient: () => void;

/** Local web environment relaying through `gatewayUrl`, with the test keys in its state directory. */
function webEnvFor(gatewayUrl: string): WebEnv {
  return loadEnv(webEnvSchema, {
    NODE_ENV: 'test',
    PORT: '8101',
    OPT2_ENV: 'local',
    OPT2_STATE_DIR: stateDir,
    OPT2_JWKS_URL: 'http://127.0.0.1:8111/.well-known/jwks.json',
    OPT2_TOKEN_ISSUER: LOCAL_USER_TOKEN.issuer,
    OPT2_TOKEN_AUDIENCE: LOCAL_USER_TOKEN.audience,
    OPT2_GATEWAY_URL: gatewayUrl,
    TZ: 'UTC',
  });
}

/** Tenant-a system-user token. */
function userToken(): Promise<string> {
  return mintUserToken({ sub: 'web-gateway-client-user', site: TENANT_A.siteId, roles: [Roles.systemUser] });
}

/** The single request the gateway recorded. */
function onlyRequest(): RecordedRequest {
  expect(gateway.requests).toHaveLength(1);
  return gateway.requests[0] as RecordedRequest;
}

/** Every value of header `name` as received, repeats included. */
function headerValues(request: RecordedRequest, name: string): string[] {
  return request.rawHeaders.filter((_, index, raw) => index % 2 === 1 && raw[index - 1]?.toLowerCase() === name);
}

const requestLine = ({ method, url }: RecordedRequest): string => `${method} ${url}`;

type FacadeKey = Exclude<keyof GatewayClient, 'call' | 'raw' | 'get' | 'post' | 'postForm' | 'postMultipart'>;

/** A facade with its contract types erased, so one table drives every service. */
interface UntypedFacade {
  readonly service: WebServiceName;
  call(method: string, path: ServicePath, input?: object): Promise<GatewayResponse>;
  raw(method: string, path: ServicePath, input?: object): Promise<GatewayResponse<Buffer>>;
}

const facade = (client: GatewayClient, key: FacadeKey): UntypedFacade => client[key] as unknown as UntypedFacade;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-web-gateway-client-'));
  stateDir = path.join(root, 'state');
  await writeTestSecrets(stateDir);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  gateway = await startFakeGateway();
  restoreEnv = setWebEnvForTests(webEnvFor(gateway.url));
  restoreRuntime = setWebAuthRuntimeForTests(undefined);
  restoreClient = setServiceClientForTests(undefined);
});

afterEach(async () => {
  restoreClient();
  restoreRuntime();
  restoreEnv();
  await gateway.close();
});

describe('constants', () => {
  it('names the ten services web calls', () => {
    expect(WEB_SERVICE_NAMES).toEqual([
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
    ]);
  });

  it('bounds each call by the 10 s platform service-call timeout', () => {
    expect(SERVICE_CALL_TIMEOUT_MS).toBe(10_000);
  });
});

describe('routing', () => {
  it.each(WEB_SERVICE_NAMES)('relays %s calls to GET /opt2/svc/<service>/<path>', async (service) => {
    gateway.route('GET', service, '/v1/probe', jsonReply({ service }));

    const response = await createGatewayClient(ANONYMOUS).get(service, '/v1/probe');

    expect(response).toMatchObject({ status: 200, ok: true, body: { service } });
    expect(requestLine(onlyRequest())).toBe(`GET /opt2/svc/${service}/v1/probe`);
  });

  it.each<[FacadeKey, WebServiceName]>([
    ['identity', 'identity'],
    ['people', 'people'],
    ['programsSites', 'programs-sites'],
    ['strategiesContent', 'strategies-content'],
    ['communications', 'communications'],
    ['reporting', 'reporting'],
    ['surveys', 'surveys'],
    ['timesheets', 'timesheets'],
    ['finance', 'finance'],
    ['eSignature', 'e-signature'],
  ])('sends %s facade calls under /opt2/svc/%s with path parameters encoded', async (key, service) => {
    gateway.route('GET', service, '/v1/items/a%2Fb%20c', jsonReply({ key }));
    const bound = facade(createGatewayClient(ANONYMOUS), key);

    const called = await bound.call('get', '/v1/items/{id}', {
      params: { id: 'a/b c' },
      query: { siteid: 'tenant-a' },
    });
    const raw = await bound.raw('get', '/v1/items/{id}', { params: { id: 'a/b c' } });

    expect(bound.service).toBe(service);
    expect(called.body).toEqual({ key });
    expect(raw.body).toEqual(Buffer.from(JSON.stringify({ key })));
    expect(gateway.requests.map(requestLine)).toEqual([
      `GET /opt2/svc/${service}/v1/items/a%2Fb%20c?siteid=tenant-a`,
      `GET /opt2/svc/${service}/v1/items/a%2Fb%20c`,
    ]);
  });

  it.each<[string, HttpMethod]>([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
  ])('sends a facade %s as HTTP %s', async (method, httpMethod) => {
    gateway.route(httpMethod, 'people', '/v1/people/p-1', OK);

    const response = await facade(createGatewayClient(ANONYMOUS), 'people').call(method, '/v1/people/{personId}', {
      params: { personId: 'p-1' },
    });

    expect(response.status).toBe(200);
    expect(requestLine(onlyRequest())).toBe(`${httpMethod} /opt2/svc/people/v1/people/p-1`);
  });

  it.each([undefined, null])('refuses a facade call whose path parameter is %s, sending nothing', async (siteId) => {
    const error = await facade(createGatewayClient(ANONYMOUS), 'programsSites')
      .call('get', '/v1/sites/{siteId}', { params: { siteId } })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('Missing path parameter siteId of /v1/sites/{siteId}');
    expect(gateway.requests).toHaveLength(0);
  });
});

describe('named operations', () => {
  const CSRF_CONTEXTS = ['B1D6A2C4-0E0A-4C47-9E3D2A1B0C9D8E7F', ''];

  it.each<{
    operation: string;
    invoke: (client: GatewayClient) => Promise<GatewayResponse>;
    method: HttpMethod;
    service: WebServiceName;
    path: ServicePath;
    search?: string;
    json?: unknown;
  }>([
    {
      operation: 'identity.currentSession',
      invoke: (client) => client.identity.currentSession(),
      method: 'GET',
      service: 'identity',
      path: '/v1/sessions/current',
    },
    {
      operation: 'identity.sessionSites',
      invoke: (client) => client.identity.sessionSites(),
      method: 'GET',
      service: 'identity',
      path: '/v1/sessions/current/sites',
    },
    {
      operation: 'identity.csrfTokens',
      invoke: (client) => client.identity.csrfTokens(CSRF_CONTEXTS),
      method: 'POST',
      service: 'identity',
      path: '/v1/csrf/tokens',
      json: { contexts: CSRF_CONTEXTS },
    },
    {
      operation: 'programsSites.listSites with a sort',
      invoke: (client) => client.programsSites.listSites({ sortBy: 'site', sortDirection: 'desc' }),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/sites',
      search: '?sortBy=site&sortDirection=desc',
    },
    {
      operation: 'programsSites.listSites',
      invoke: (client) => client.programsSites.listSites(),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/sites',
    },
    {
      operation: 'programsSites.getSite',
      invoke: (client) => client.programsSites.getSite('tenant a/b'),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/sites/tenant%20a%2Fb',
    },
  ])(
    'sends $operation as $method to $service at $path',
    async ({ invoke, method, service, path: servicePath, search = '', json }) => {
      gateway.route(method, service, servicePath, jsonReply({ answered: true }));

      const response = await invoke(createGatewayClient(ANONYMOUS));

      expect(response).toMatchObject({ status: 200, ok: true, body: { answered: true } });
      const request = onlyRequest();
      expect(requestLine(request)).toBe(`${method} /opt2/svc/${service}${servicePath}${search}`);
      if (json === undefined) {
        expect(request.body).toHaveLength(0);
      } else {
        expect(request.headers['content-type']).toBe('application/json');
        expect(JSON.parse(request.body.toString('utf8'))).toEqual(json);
      }
    },
  );
});

describe('queries and bodies', () => {
  it.each<{ label: string; path: ServicePath; query?: QueryInput; url: string }>([
    { label: 'no query', path: '/v1/list', url: '/v1/list' },
    { label: 'an empty query', path: '/v1/list', query: {}, url: '/v1/list' },
    {
      label: 'pairs in order, arrays repeated and nullish values skipped',
      path: '/v1/list',
      query: { siteid: 'tenant-a', tag: ['a b', 'c&d'], skipped: null, missing: undefined, page: 2, active: false },
      url: '/v1/list?siteid=tenant-a&tag=a+b&tag=c%26d&page=2&active=false',
    },
    {
      label: 'an object value expanded into its own pairs',
      path: '/v1/list',
      query: { sort: { sortBy: 'lname', sortDirection: 'desc' }, q: 'x' },
      url: '/v1/list?sortBy=lname&sortDirection=desc&q=x',
    },
    {
      label: 'URLSearchParams unchanged',
      path: '/v1/list',
      query: new URLSearchParams([
        ['b', '2'],
        ['a', '1'],
        ['b', '3'],
      ]),
      url: '/v1/list?b=2&a=1&b=3',
    },
    {
      label: 'a path that already has a query',
      path: '/v1/list?fixed=1',
      query: { more: 'yes' },
      url: '/v1/list?fixed=1&more=yes',
    },
  ])('sends $label', async ({ path: servicePath, query, url }) => {
    await createGatewayClient(ANONYMOUS).get('people', servicePath, { query });

    expect(onlyRequest().url).toBe(`/opt2/svc/people${url}`);
  });

  it('sends a JSON body intact and decodes the JSON answer', async () => {
    const json = { name: 'Zoë "Q" Ångström', count: 3, nested: { list: [1, null, true] }, empty: '' };
    gateway.route('POST', 'people', '/v1/people', {
      status: 201,
      headers: { 'content-type': 'application/json', 'X-Opt2-Write-Position': '42' },
      body: JSON.stringify({ created: json }),
    });

    const response = await createGatewayClient(ANONYMOUS).post('people', '/v1/people', json, {
      query: { siteid: 'tenant-a' },
      headers: { 'X-Csrf-Token': 'T0K3N' },
    });

    expect(response).toMatchObject({ status: 201, ok: true, body: { created: json } });
    expect(response.headers['x-opt2-write-position']).toBe('42');
    const request = onlyRequest();
    expect(requestLine(request)).toBe('POST /opt2/svc/people/v1/people?siteid=tenant-a');
    expect(request.headers).toMatchObject({ 'content-type': 'application/json', 'x-csrf-token': 'T0K3N' });
    expect(JSON.parse(request.body.toString('utf8'))).toEqual(json);
  });

  it.each<{ label: string; parts: Omit<GatewayRequest, 'method' | 'path'>; contentType?: string; body: Buffer }>([
    {
      label: 'json over form and body',
      parts: { json: { a: 1 }, form: { b: '2' }, body: 'c' },
      contentType: 'application/json',
      body: Buffer.from('{"a":1}'),
    },
    {
      label: 'form over body and the caller content type',
      parts: { form: { b: '2' }, body: 'c', headers: { 'Content-Type': 'text/plain' } },
      contentType: FORM_CONTENT_TYPE,
      body: Buffer.from('b=2'),
    },
    {
      label: 'a raw body with the caller content type',
      parts: { body: Buffer.from([0x00, 0xff, 0x7b]), headers: { 'Content-Type': 'application/octet-stream' } },
      contentType: 'application/octet-stream',
      body: Buffer.from([0x00, 0xff, 0x7b]),
    },
    { label: 'no body', parts: {}, body: Buffer.alloc(0) },
  ])('sends $label', async ({ parts, contentType, body }) => {
    await createGatewayClient(ANONYMOUS).call('people', { ...parts, method: 'PUT', path: '/v1/people/p-1' });

    const request = onlyRequest();
    expect(request.headers['content-type']).toBe(contentType);
    expect(request.body).toEqual(body);
  });

  const formData = (entries: ReadonlyArray<readonly [string, string]>): FormData => {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  };

  it.each<{ label: string; form: FormInput; body: string }>([
    {
      label: 'a record',
      form: { username: 'admin', password: 'p&ss w=rd+', returnUrl: '', isAdminLogin: 'true' },
      body: 'username=admin&password=p%26ss+w%3Drd%2B&returnUrl=&isAdminLogin=true',
    },
    {
      label: 'a record with array values repeated',
      form: { groupid: ['g1', 'g2'], z: 'last' },
      body: 'groupid=g1&groupid=g2&z=last',
    },
    { label: 'URLSearchParams', form: new URLSearchParams('b=1&a=2&b=3'), body: 'b=1&a=2&b=3' },
    {
      label: 'an iterable with repeated entries',
      form: [
        ['b', '1'],
        ['a', '2'],
        ['b', '3'],
      ],
      body: 'b=1&a=2&b=3',
    },
    {
      label: 'FormData string fields',
      form: formData([
        ['csrf_token', 'T'],
        ['siteid', 'default'],
        ['csrf_token', 'U'],
      ]),
      body: 'csrf_token=T&siteid=default&csrf_token=U',
    },
  ])('posts $label URL-encoded in field order', async ({ form, body }) => {
    await createGatewayClient(ANONYMOUS).postForm('identity', '/v1/login', form, { query: { siteid: 'default' } });

    const request = onlyRequest();
    expect(requestLine(request)).toBe('POST /opt2/svc/identity/v1/login?siteid=default');
    expect(request.headers['content-type']).toBe(FORM_CONTENT_TYPE);
    expect(request.body.toString('utf8')).toBe(body);
  });

  it('refuses a form carrying a file, sending nothing', async () => {
    const form = new FormData();
    form.append('siteid', 'default');
    form.append('upload', new Blob(['x']), 'a.txt');

    const error = await createGatewayClient(ANONYMOUS)
      .postForm('strategies-content', '/v1/files', form)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('Form field upload is a file; send it with postMultipart');
    expect(gateway.requests).toHaveLength(0);
  });

  const MULTIPART = Buffer.from(
    '--B0UND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n' +
      '\u0000\u00ff\u0080\r\n--B0UND--\r\n',
    'latin1',
  );

  it.each<[string, () => MultipartBody['body']]>([
    ['Uint8Array', () => new Uint8Array(MULTIPART)],
    ['ArrayBuffer', () => new Uint8Array(MULTIPART).buffer],
    ['Blob', () => new Blob([new Uint8Array(MULTIPART)])],
    ['ReadableStream', () => new Blob([new Uint8Array(MULTIPART)]).stream()],
  ])('relays a multipart %s body unchanged with its own content type', async (_kind, body) => {
    const contentType = 'multipart/form-data; boundary=B0UND';

    await createGatewayClient(ANONYMOUS).postMultipart(
      'strategies-content',
      '/v1/files',
      { contentType, body: body() },
      { query: { siteid: 'default' }, headers: { 'Content-Type': 'text/plain', 'X-Csrf-Token': 'T' } },
    );

    const request = onlyRequest();
    expect(requestLine(request)).toBe('POST /opt2/svc/strategies-content/v1/files?siteid=default');
    expect(request.headers).toMatchObject({ 'content-type': contentType, 'x-csrf-token': 'T' });
    expect(request.body).toEqual(MULTIPART);
  });
});

describe('credentials and request headers', () => {
  it('sends Bearer <userToken> exactly and the web invocation credential for the gateway', async () => {
    const token = await userToken();

    await createGatewayClient({ userToken: token, requestId: 'req-42', inbound: {} }).get('people', '/v1/me', {
      headers: { Authorization: 'Bearer forged', [INVOCATION_HEADER]: 'Bearer forged', 'X-Request-Id': 'spoofed' },
    });

    const request = onlyRequest();
    const { headers } = request;
    expect(headerValues(request, 'authorization')).toEqual([`Bearer ${token}`]);
    expect(headerValues(request, 'x-request-id')).toEqual(['req-42']);
    expect(headerValues(request, INVOCATION_HEADER)).toHaveLength(1);
    const invocation = String(headers[INVOCATION_HEADER]);
    expect(invocation).toMatch(/^Bearer \S+$/);
    expect(invocation).not.toBe(`Bearer ${token}`);
    expect(invocation).not.toContain(token);
    await expect(testVerifier('gateway').invocationVerifier.verify(invocation)).resolves.toMatchObject({ name: 'web' });
    await expect(testVerifier('people').invocationVerifier.verify(invocation)).rejects.toMatchObject({
      reason: 'invalid-credential',
    });
  });

  it.each<[string, Readonly<Record<string, string>>]>([
    ['no Authorization header', {}],
    ['a caller-supplied Authorization header', { Authorization: 'Bearer forged' }],
  ])('sends no Authorization for an anonymous call with %s', async (_label, headers) => {
    await createGatewayClient({ requestId: 'req-anon-7', inbound: {} }).get('identity', '/v1/sessions/current', {
      headers,
    });

    const request = onlyRequest();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-request-id']).toBe('req-anon-7');
    await expect(
      testVerifier('gateway').invocationVerifier.verify(String(request.headers[INVOCATION_HEADER])),
    ).resolves.toMatchObject({ name: 'web' });
  });

  it.each<{ label: string; inbound: HeadersInit; traceparent?: string; tracestate?: string }>([
    {
      label: 'a header record',
      inbound: { traceparent: INBOUND_TRACEPARENT, tracestate: INBOUND_TRACESTATE },
      traceparent: INBOUND_TRACEPARENT,
      tracestate: INBOUND_TRACESTATE,
    },
    {
      label: 'a Headers instance',
      inbound: new Headers({ Traceparent: INBOUND_TRACEPARENT, TraceState: INBOUND_TRACESTATE, Cookie: 'a=1' }),
      traceparent: INBOUND_TRACEPARENT,
      tracestate: INBOUND_TRACESTATE,
    },
    {
      label: 'header pairs',
      inbound: [
        ['traceparent', INBOUND_TRACEPARENT],
        ['tracestate', INBOUND_TRACESTATE],
      ],
      traceparent: INBOUND_TRACEPARENT,
      tracestate: INBOUND_TRACESTATE,
    },
    { label: 'a traceparent alone', inbound: { traceparent: INBOUND_TRACEPARENT }, traceparent: INBOUND_TRACEPARENT },
    { label: 'a tracestate alone, sending neither', inbound: { tracestate: INBOUND_TRACESTATE } },
    { label: 'headers without trace context, sending neither', inbound: { cookie: 'a=1' } },
  ])('copies the inbound trace context from $label', async ({ inbound, traceparent, tracestate }) => {
    await createGatewayClient({ requestId: 'req-trace', inbound }).get('people', '/v1/me');

    const request = onlyRequest();
    expect(headerValues(request, 'traceparent')).toEqual(traceparent === undefined ? [] : [traceparent]);
    expect(headerValues(request, 'tracestate')).toEqual(tracestate === undefined ? [] : [tracestate]);
    expect(request.headers.cookie).toBeUndefined();
  });
});

describe('answers', () => {
  it('returns a 302 unfollowed with its Location and every Set-Cookie in order', async () => {
    const cookies = ['MURA_SESSION=abc; Path=/; HttpOnly', 'mura_rid=xyz; Path=/', 'MURA_SESSION=def; Path=/admin'];
    gateway.route('POST', 'identity', '/v1/login', {
      status: 302,
      headers: { location: './?muraAction=cDashboard.main', 'set-cookie': cookies },
    });

    const response = await createGatewayClient(ANONYMOUS).postForm('identity', '/v1/login', { username: 'admin' });

    expect(response).toMatchObject({ status: 302, ok: false, location: './?muraAction=cDashboard.main' });
    expect(response.setCookies).toEqual(cookies);
    expect(requestLine(onlyRequest())).toBe('POST /opt2/svc/identity/v1/login');
  });

  it.each<{ label: string; headers: OutgoingHttpHeaders; setCookies: string[]; location?: string }>([
    { label: 'one Set-Cookie', headers: { 'set-cookie': 'a=1; Path=/' }, setCookies: ['a=1; Path=/'] },
    { label: 'no Set-Cookie or Location', headers: {}, setCookies: [] },
    { label: 'two Location headers', headers: { Location: ['/first', '/second'] }, setCookies: [], location: '/first' },
  ])('reports $label', async ({ headers, setCookies, location }) => {
    gateway.route('GET', 'identity', '/v1/sessions/current', { headers, body: 'x' });

    const response = await createGatewayClient(ANONYMOUS).get('identity', '/v1/sessions/current');

    expect(response.setCookies).toEqual(setCookies);
    expect(response.location).toBe(location);
  });

  it('returns a text/csv body byte-for-byte from raw() while call() decodes it as UTF-8', async () => {
    // A UTF-8 BOM before the legacy capture and a Latin-1 byte after it: UTF-8 decoding would alter the latter.
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      await readFile(CSV_FIXTURE),
      Buffer.from([0xe9, 0x0d, 0x0a]),
    ]);
    const disposition = 'attachment; filename="downloaddata.csv"';
    gateway.route('GET', 'strategies-content', '/v1/forms/f-1/data', {
      headers: { 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': disposition },
      body: csv,
    });
    const client = createGatewayClient(ANONYMOUS);

    const raw = await client.raw('strategies-content', { method: 'GET', path: '/v1/forms/f-1/data' });
    const decoded = await client.call<string>('strategies-content', { method: 'GET', path: '/v1/forms/f-1/data' });

    expect(Buffer.isBuffer(raw.body)).toBe(true);
    expect(raw.body.equals(csv)).toBe(true);
    expect(raw.headers).toMatchObject({
      'content-type': 'text/csv; charset=UTF-8',
      'content-disposition': disposition,
    });
    expect(decoded.body).toBe(csv.toString('utf8'));
    expect(gateway.requests).toHaveLength(2);
  });

  it.each([400, 404, 500])('returns HTTP %i as a response, not as unavailability', async (status) => {
    gateway.route('GET', 'finance', '/v1/finance/records', jsonReply({ error: `status ${status}` }, status));

    const response = await createGatewayClient(ANONYMOUS).get('finance', '/v1/finance/records');

    expect(response).toMatchObject({ status, ok: false, body: { error: `status ${status}` } });
    expect(isUnavailable(response)).toBe(false);
    expect(onlyRequest().method).toBe('GET');
  });

  it.each([502, 503, 504])('fails closed on HTTP %i after exactly one request', async (status) => {
    gateway.route('GET', 'timesheets', '/v1/timesheets/sheets', {
      status,
      headers: { 'content-type': 'text/html' },
      body: '<h1>Service Unavailable</h1>',
    });

    const error = await createGatewayClient(ANONYMOUS)
      .get('timesheets', '/v1/timesheets/sheets')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(error).toMatchObject({
      name: 'GatewayUnavailableError',
      service: 'timesheets',
      status,
      surface: 'admin',
      reason: 'gateway-unavailable',
      message: `Service timesheets unavailable through the gateway (HTTP ${status})`,
    });
    expect((error as GatewayUnavailableError).cause).toBeUndefined();
    expect(isUnavailable(error)).toBe(true);
    expect(gateway.requests).toHaveLength(1);
  });

  it('fails closed when the gateway refuses the connection', async () => {
    setWebEnvForTests(webEnvFor(await refusedUrl()));

    const error = await createGatewayClient(ANONYMOUS)
      .get('surveys', '/v1/surveys')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({
      service: 'surveys',
      status: undefined,
      message: 'Service surveys unavailable through the gateway (no answer)',
    });
    expect((error as GatewayUnavailableError).cause).toBeInstanceOf(ServiceUnavailableError);
    expect(isUnavailable(error)).toBe(true);
  });

  it('fails closed after exactly one request when the gateway drops the socket mid-response', async () => {
    gateway.route('GET', 'reporting', '/v1/reporting/exports', { destroy: true });

    const error = await createGatewayClient(ANONYMOUS)
      .get('reporting', '/v1/reporting/exports')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'reporting', status: undefined });
    expect((error as GatewayUnavailableError).cause).toBeInstanceOf(ServiceUnavailableError);
    expect(gateway.requests).toHaveLength(1);
  });

  it('propagates an undecodable JSON answer unchanged instead of failing closed', async () => {
    gateway.route('GET', 'communications', '/v1/templates', {
      headers: { 'content-type': 'application/json' },
      body: '{"truncated":',
    });

    const error = await createGatewayClient(ANONYMOUS)
      .get('communications', '/v1/templates')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LegacyServiceUnavailableError);
    expect((error as Error).message).toBe('Service gateway (called by web) answered with invalid JSON');
    expect(isUnavailable(error)).toBe(false);
  });
});

describe('isUnavailable', () => {
  it.each<{ label: string; value: unknown; expected: boolean }>([
    { label: 'a GatewayUnavailableError', value: new GatewayUnavailableError('people', 503), expected: true },
    { label: 'another legacy unavailability error', value: new LegacyServiceUnavailableError(), expected: true },
    { label: 'a 502 response', value: { status: 502 }, expected: true },
    { label: 'a 503 response', value: { status: 503 }, expected: true },
    { label: 'a 504 response', value: { status: 504 }, expected: true },
    { label: 'a 500 response', value: { status: 500 }, expected: false },
    { label: 'a 200 response', value: { status: 200 }, expected: false },
    { label: 'a string status', value: { status: '503' }, expected: false },
    { label: 'another error', value: new Error('boom'), expected: false },
    { label: 'null', value: null, expected: false },
    { label: 'undefined', value: undefined, expected: false },
  ])('is $expected for $label', ({ value, expected }) => {
    expect(isUnavailable(value)).toBe(expected);
  });
});

describe('setServiceClientForTests', () => {
  it('installs a client and restores the previous one', async () => {
    const request = vi.fn<(req: ServiceRequest) => Promise<ServiceResponse>>(async () => ({
      status: 200,
      headers: {},
      body: 'stubbed',
    }));
    const restore = setServiceClientForTests({ request: request as ServiceClient['request'], close: async () => {} });
    gateway.route('GET', 'people', '/v1/x', OK);

    const stubbed = await createGatewayClient(ANONYMOUS).get('people', '/v1/x');
    restore();
    const relayed = await createGatewayClient(ANONYMOUS).get('people', '/v1/x');

    expect(stubbed).toMatchObject({ status: 200, ok: true, body: 'stubbed', setCookies: [] });
    expect(request).toHaveBeenCalledExactlyOnceWith({
      service: 'gateway',
      method: 'GET',
      path: '/opt2/svc/people/v1/x',
      json: undefined,
      body: undefined,
      headers: { 'x-request-id': 'req-anonymous' },
      userToken: null,
      rawBody: false,
    });
    expect(relayed.body).toEqual({ ok: true });
    expect(gateway.requests).toHaveLength(1);
  });

  it('keeps the client built at first use until reset, then rebuilds from the environment', async () => {
    gateway.route('GET', 'people', '/v1/x', OK);
    const client = createGatewayClient(ANONYMOUS);
    await client.get('people', '/v1/x');
    setWebEnvForTests(webEnvFor(await refusedUrl()));

    await client.get('people', '/v1/x');
    setServiceClientForTests(undefined);

    await expect(client.get('people', '/v1/x')).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(gateway.requests).toHaveLength(2);
  });
});

describe('with the tracing SDK started', () => {
  beforeAll(async () => {
    await startTracing({
      serviceName: 'web-gateway-client-test',
      version: '0.0.0',
      exporter: new MemorySpanExporter(),
    });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  const inbound = { traceparent: INBOUND_TRACEPARENT, tracestate: INBOUND_TRACESTATE };

  it('continues the active span instead of the inbound context', async () => {
    gateway.route('GET', 'people', '/v1/me', OK);

    const caller = await startSpan('caller', SpanKind.SERVER, async () => {
      await createGatewayClient({ requestId: 'req-span', inbound }).get('people', '/v1/me');
      return activeSpanIds();
    });

    const received = headerValues(onlyRequest(), 'traceparent');
    expect(received).toHaveLength(1);
    const [, traceId, parentId] = TRACEPARENT.exec(received[0] ?? '') ?? [];
    expect(traceId).toBe(caller?.traceId);
    expect(traceId).not.toBe(INBOUND_TRACE_ID);
    expect(parentId).not.toBe(caller?.spanId);
  });

  it('continues the inbound trace through one client span when no span is active', async () => {
    gateway.route('GET', 'people', '/v1/me', OK);

    await createGatewayClient({ requestId: 'req-inbound', inbound: new Headers(inbound) }).get('people', '/v1/me');

    const request = onlyRequest();
    const received = headerValues(request, 'traceparent');
    expect(received).toHaveLength(1);
    const [, traceId, parentId] = TRACEPARENT.exec(received[0] ?? '') ?? [];
    expect(traceId).toBe(INBOUND_TRACE_ID);
    expect(parentId).not.toBe(INBOUND_SPAN_ID);
    expect(headerValues(request, 'tracestate')).toEqual([INBOUND_TRACESTATE]);
  });
});
