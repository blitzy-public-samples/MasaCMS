// Tests of web's gateway client against the loopback fake gateway, signing with the platform test keys.
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { LEGACY_ERROR_PAGE_HTML, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import {
  REQUEST_ID_HEADER,
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import {
  GatewayDenialError,
  GatewayUnavailableError,
  WEB_SERVICE_NAMES,
  assertNotDenied,
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
import { legacyUnavailable } from '@/lib/responses';
import { useTestEnv } from '../helpers/env';
import {
  routeKey,
  startFakeGateway,
  type FakeGateway,
  type FakeReply,
  type FakeRoute,
  type RecordedRequest,
} from '../helpers/fake-gateway';
import { SUBJECTS, userTokenFor } from '../helpers/tokens';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const CSV_FIXTURE = new URL('../fixtures/strategies-content/downloaddata.csv', import.meta.url);
const INBOUND_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const INBOUND_TRACESTATE = 'opt2=web-test,vendor=1';
const ANONYMOUS: GatewayCallContext = { requestId: 'req-anonymous', inbound: {} };

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

beforeEach(async () => {
  fake = await startFakeGateway();
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

const jsonReply = (body: unknown, status = 200): FakeReply => ({ status, body });

const OK = jsonReply({ ok: true });

function route(method: HttpMethod, service: WebServiceName, path: ServicePath, reply: FakeRoute): void {
  fake.setRoute(routeKey(method, service, path), reply);
}

/** The single request the fake gateway recorded. */
function onlyRequest(): RecordedRequest {
  expect(fake.requests).toHaveLength(1);
  return fake.requests[0] as RecordedRequest;
}

const requestLine = ({ method, path }: RecordedRequest): string => `${method} ${path}`;

/** Raw user token of the installed admin. */
async function adminToken(): Promise<string> {
  const token = await userTokenFor(SUBJECTS.admin);
  if (token === undefined) throw new TypeError('SUBJECTS.admin has no user token');
  return token;
}

/** Unverified claims of a `Bearer <jwt>` header value. */
function claimsOf(bearer: string): Record<string, unknown> {
  const [, payload = ''] = bearer.replace(/^Bearer /, '').split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

type FacadeKey = Exclude<keyof GatewayClient, 'call' | 'raw' | 'get' | 'post' | 'postForm' | 'postMultipart'>;

/** A facade with its contract types erased, so one table drives every service. */
interface UntypedFacade {
  readonly service: WebServiceName;
  call(method: string, path: ServicePath, input?: object): Promise<GatewayResponse>;
  raw(method: string, path: ServicePath, input?: object): Promise<GatewayResponse<Buffer>>;
}

const facade = (client: GatewayClient, key: FacadeKey): UntypedFacade => client[key] as unknown as UntypedFacade;

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
  it.each(WEB_SERVICE_NAMES)('relays %s calls to /opt2/svc/<service>/<path>', async (service) => {
    route('GET', service, '/v1/ping', jsonReply({ service }));
    const client = createGatewayClient(ANONYMOUS);

    const got = await client.get(service, '/v1/ping');
    const called = await client.call(service, { method: 'GET', path: '/v1/ping' });

    expect(got).toMatchObject({ status: 200, ok: true, body: { service } });
    expect(called.body).toEqual({ service });
    expect(fake.requests.map(requestLine)).toEqual([
      `GET /opt2/svc/${service}/v1/ping`,
      `GET /opt2/svc/${service}/v1/ping`,
    ]);
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
    route('GET', service, '/v1/items/a%2Fb%20c', jsonReply({ key }));
    const bound = facade(createGatewayClient(ANONYMOUS), key);

    const called = await bound.call('get', '/v1/items/{id}', {
      params: { id: 'a/b c' },
      query: { siteid: 'tenant-a' },
    });
    const raw = await bound.raw('get', '/v1/items/{id}', { params: { id: 'a/b c' } });

    expect(bound.service).toBe(service);
    expect(called.body).toEqual({ key });
    expect(raw.body).toEqual(Buffer.from(JSON.stringify({ key })));
    expect(fake.requests.map((request) => [requestLine(request), request.query])).toEqual([
      [`GET /opt2/svc/${service}/v1/items/a%2Fb%20c`, { siteid: 'tenant-a' }],
      [`GET /opt2/svc/${service}/v1/items/a%2Fb%20c`, {}],
    ]);
  });

  it.each<[string, HttpMethod]>([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
  ])('sends a facade %s as HTTP %s', async (method, httpMethod) => {
    route(httpMethod, 'people', '/v1/people/p-1', OK);

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
    expect(fake.requests).toHaveLength(0);
  });
});

describe('named operations', () => {
  const CSRF_CONTEXTS = ['B1D6A2C4-0E0A-4C47-9E3D2A1B0C9D8E7F', ''];
  const ADMIN_STATE = { siteid: 'tenant-a', flash: { '3': { msg: 'Saved' } }, nextPreserveKey: 4 };

  it.each<{
    operation: string;
    invoke: (client: GatewayClient) => Promise<GatewayResponse>;
    method: HttpMethod;
    service: WebServiceName;
    path: ServicePath;
    query?: Readonly<Record<string, string>>;
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
      operation: 'identity.adminSessionState',
      invoke: (client) => client.identity.adminSessionState(),
      method: 'GET',
      service: 'identity',
      path: '/v1/sessions/current/admin-state',
    },
    {
      operation: 'identity.saveAdminSessionState',
      invoke: (client) => client.identity.saveAdminSessionState(ADMIN_STATE),
      method: 'POST',
      service: 'identity',
      path: '/v1/sessions/current/admin-state',
      json: ADMIN_STATE,
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
      operation: 'identity.reversePermLookUp',
      invoke: (client) => client.identity.reversePermLookUp(),
      method: 'GET',
      service: 'identity',
      path: '/v1/permissions/reverse-lookup',
    },
    {
      operation: 'programsSites.listSites with a sort',
      invoke: (client) => client.programsSites.listSites({ sortBy: 'site', sortDirection: 'desc' }),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/sites',
      query: { sortBy: 'site', sortDirection: 'desc' },
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
    {
      operation: 'programsSites.getShellSite',
      invoke: (client) => client.programsSites.getShellSite('tenant a/b'),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/sites/tenant%20a%2Fb/shell',
    },
    {
      operation: 'programsSites.userSites with a host',
      invoke: (client) => client.programsSites.userSites('admin.example.com:8080'),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/user-sites',
      query: { host: 'admin.example.com:8080' },
    },
    {
      operation: 'programsSites.userSites',
      invoke: (client) => client.programsSites.userSites(),
      method: 'GET',
      service: 'programs-sites',
      path: '/v1/user-sites',
    },
  ])(
    'sends $operation as $method to $service at $path',
    async ({ invoke, method, service, path: servicePath, query = {}, json }) => {
      route(method, service, servicePath, jsonReply({ answered: true }));

      const response = await invoke(createGatewayClient(ANONYMOUS));

      expect(response).toMatchObject({ status: 200, ok: true, body: { answered: true } });
      const request = onlyRequest();
      expect(requestLine(request)).toBe(`${method} /opt2/svc/${service}${servicePath}`);
      expect(Object.entries(request.query)).toEqual(Object.entries(query));
      if (json === undefined) {
        expect(request.bytes).toHaveLength(0);
      } else {
        expect(request.headers['content-type']).toBe('application/json');
        expect(request.json).toEqual(json);
      }
    },
  );
});

describe('queries and bodies', () => {
  // The fake records decoded fields in first-seen order, with a repeated name's values grouped.
  it.each<{ label: string; path: ServicePath; query?: QueryInput; fields: Array<[string, string | string[]]> }>([
    { label: 'no query', path: '/v1/list', fields: [] },
    { label: 'an empty query', path: '/v1/list', query: {}, fields: [] },
    {
      label: 'pairs in order, arrays repeated and nullish values skipped',
      path: '/v1/list',
      query: { siteid: 'tenant-a', tag: ['a b', 'c&d'], skipped: null, missing: undefined, page: 2, active: false },
      fields: [
        ['siteid', 'tenant-a'],
        ['tag', ['a b', 'c&d']],
        ['page', '2'],
        ['active', 'false'],
      ],
    },
    {
      label: 'an object value expanded into its own pairs',
      path: '/v1/list',
      query: { sort: { sortBy: 'lname', sortDirection: 'desc' }, q: 'x' },
      fields: [
        ['sortBy', 'lname'],
        ['sortDirection', 'desc'],
        ['q', 'x'],
      ],
    },
    {
      label: 'URLSearchParams unchanged',
      path: '/v1/list',
      query: new URLSearchParams([
        ['b', '2'],
        ['a', '1'],
        ['b', '3'],
      ]),
      fields: [
        ['b', ['2', '3']],
        ['a', '1'],
      ],
    },
    {
      label: 'a path that already has a query',
      path: '/v1/list?fixed=1',
      query: { more: 'yes' },
      fields: [
        ['fixed', '1'],
        ['more', 'yes'],
      ],
    },
  ])('sends $label', async ({ path: servicePath, query, fields }) => {
    await createGatewayClient(ANONYMOUS).get('people', servicePath, { query });

    const request = onlyRequest();
    expect(request.path).toBe('/opt2/svc/people/v1/list');
    expect(Object.entries(request.query)).toEqual(fields);
  });

  it('sends a JSON body intact and decodes the JSON answer', async () => {
    const json = { name: 'Zoë "Q" Ångström', count: 3, nested: { list: [1, null, true] }, empty: '' };
    route('POST', 'people', '/v1/people', {
      status: 201,
      headers: { 'X-Opt2-Write-Position': '42' },
      body: { created: json },
    });

    const response = await createGatewayClient(ANONYMOUS).post('people', '/v1/people', json, {
      query: { siteid: 'tenant-a' },
      headers: { 'X-Csrf-Token': 'T0K3N' },
    });

    expect(response).toMatchObject({ status: 201, ok: true, body: { created: json } });
    expect(response.headers['x-opt2-write-position']).toBe('42');
    const request = onlyRequest();
    expect(requestLine(request)).toBe('POST /opt2/svc/people/v1/people');
    expect(request.query).toEqual({ siteid: 'tenant-a' });
    expect(request.headers).toMatchObject({ 'content-type': 'application/json', 'x-csrf-token': 'T0K3N' });
    expect(request.json).toEqual(json);
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
    expect(request.bytes).toEqual(body);
  });

  const formData = (entries: ReadonlyArray<readonly [string, string]>): FormData => {
    const data = new FormData();
    for (const [name, value] of entries) data.append(name, value);
    return data;
  };

  it.each<{ label: string; form: FormInput; body: string }>([
    { label: 'a record', form: { a: '1', b: 'x y' }, body: 'a=1&b=x+y' },
    {
      label: 'a record with reserved characters',
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
    expect(requestLine(request)).toBe('POST /opt2/svc/identity/v1/login');
    expect(request.query).toEqual({ siteid: 'default' });
    expect(request.headers['content-type']).toBe(FORM_CONTENT_TYPE);
    expect(request.body).toBe(body);
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
    expect(fake.requests).toHaveLength(0);
  });

  const MULTIPART = Buffer.from(
    '--B0UND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n' +
      '\u0000\u00ff\u0080\r\n--B0UND--\r\n',
    'latin1',
  );

  const LENGTH = { 'content-length': String(MULTIPART.length) };
  const CHUNKED = { 'transfer-encoding': 'chunked' };

  it.each<[string, () => MultipartBody['body'], Readonly<Record<string, string>>]>([
    ['Uint8Array', () => new Uint8Array(MULTIPART), LENGTH],
    [
      'Uint8Array view into a larger buffer',
      () => new Uint8Array(Buffer.concat([Buffer.from('xx'), MULTIPART, Buffer.from('yy')])).subarray(2, -2),
      LENGTH,
    ],
    ['ArrayBuffer', () => new Uint8Array(MULTIPART).buffer, LENGTH],
    ['Blob', () => new Blob([new Uint8Array(MULTIPART)]), LENGTH],
    [
      'sized re-readable source',
      () => ({ size: MULTIPART.length, stream: () => new Blob([new Uint8Array(MULTIPART)]).stream() }),
      LENGTH,
    ],
    ['ReadableStream', () => new Blob([new Uint8Array(MULTIPART)]).stream(), CHUNKED],
  ])('relays a multipart %s body unchanged with its own content type', async (_kind, body, framing) => {
    const contentType = 'multipart/form-data; boundary=B0UND';

    await createGatewayClient(ANONYMOUS).postMultipart(
      'strategies-content',
      '/v1/files',
      { contentType, body: body() },
      { query: { siteid: 'default' }, headers: { 'Content-Type': 'text/plain', 'X-Csrf-Token': 'T' } },
    );

    const request = onlyRequest();
    expect(requestLine(request)).toBe('POST /opt2/svc/strategies-content/v1/files');
    expect(request.query).toEqual({ siteid: 'default' });
    expect(request.headers).toMatchObject({ 'content-type': contentType, 'x-csrf-token': 'T', ...framing });
    expect(request.headers['content-length'] === undefined).toBe(framing === CHUNKED);
    expect(request.bytes).toEqual(MULTIPART);
  });

  it('streams a re-readable source afresh for each relay', async () => {
    const source = { size: MULTIPART.length, stream: () => new Blob([new Uint8Array(MULTIPART)]).stream() };
    const multipart = { contentType: 'multipart/form-data; boundary=B0UND', body: source };
    const client = createGatewayClient(ANONYMOUS);

    for (let sent = 0; sent < 2; sent++) await client.postMultipart('strategies-content', '/v1/files', multipart);

    expect(fake.requests.map(({ bytes }) => bytes)).toEqual([MULTIPART, MULTIPART]);
  });
});


describe('credentials and request headers', () => {
  it('sends Bearer <userToken> exactly and the web invocation credential for the gateway', async () => {
    const token = await adminToken();

    await createGatewayClient({ userToken: token, requestId: 'req-42', inbound: {} }).get('people', '/v1/me', {
      headers: { Authorization: 'Bearer forged', [INVOCATION_HEADER]: 'Bearer forged', 'X-Request-Id': 'spoofed' },
    });

    const { headers } = onlyRequest();
    expect(headers.authorization).toBe(`Bearer ${token}`);
    expect(headers[REQUEST_ID_HEADER]).toBe('req-42');
    const invocation = headers[INVOCATION_HEADER] ?? '';
    expect(invocation).toMatch(/^Bearer [^\s,]+$/);
    expect(invocation).not.toContain(token);
    expect(claimsOf(invocation)).toMatchObject({ sub: 'service:web', aud: 'gateway' });
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
    expect(request.headers[REQUEST_ID_HEADER]).toBe('req-anon-7');
    await expect(
      testVerifier('gateway').invocationVerifier.verify(request.headers[INVOCATION_HEADER] ?? ''),
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

    const { headers } = onlyRequest();
    expect(headers.traceparent).toBe(traceparent);
    expect(headers.tracestate).toBe(tracestate);
    expect(headers.cookie).toBeUndefined();
  });
});

describe('answers', () => {
  const COOKIES = ['CFID=web-test-1; Path=/; HttpOnly', 'CFTOKEN=web-test-2; Path=/; HttpOnly'];

  it.each<[string, (client: GatewayClient) => Promise<GatewayResponse>]>([
    ['raw', (client) => client.raw('identity', { method: 'POST', path: '/v1/login', form: { username: 'admin' } })],
    ['postForm', (client) => client.postForm('identity', '/v1/login', { username: 'admin' })],
  ])('returns a 302 from %s unfollowed, with its Location and every Set-Cookie in order', async (_kind, invoke) => {
    route('POST', 'identity', '/v1/login', {
      status: 302,
      headers: { location: './?muraAction=cusers.list', 'cache-control': 'no-cache', pragma: 'no-cache' },
      setCookies: COOKIES,
    });

    const response = await invoke(createGatewayClient(ANONYMOUS));

    expect(response).toMatchObject({ status: 302, ok: false, location: './?muraAction=cusers.list' });
    expect(response.setCookies).toEqual(COOKIES);
    expect(response.headers).toMatchObject({
      location: './?muraAction=cusers.list',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'set-cookie': COOKIES,
    });
    expect(requestLine(onlyRequest())).toBe('POST /opt2/svc/identity/v1/login');
  });

  it.each<{ label: string; setCookies?: string[]; expected: string[] }>([
    { label: 'one Set-Cookie', setCookies: ['a=1; Path=/'], expected: ['a=1; Path=/'] },
    { label: 'no Set-Cookie or Location', expected: [] },
  ])('reports $label', async ({ setCookies, expected }) => {
    route('GET', 'identity', '/v1/sessions/current', { status: 200, body: 'x', setCookies });

    const response = await createGatewayClient(ANONYMOUS).get('identity', '/v1/sessions/current');

    expect(response.setCookies).toEqual(expected);
    expect(response.location).toBeUndefined();
  });

  it('returns a text/csv body byte-for-byte from raw() while call() decodes it as UTF-8', async () => {
    // A UTF-8 BOM before the legacy capture and a Latin-1 byte after it: UTF-8 decoding would alter the latter.
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      await readFile(CSV_FIXTURE),
      Buffer.from([0xe9, 0x0d, 0x0a]),
    ]);
    const disposition = 'attachment; filename="downloaddata.csv"';
    route('GET', 'strategies-content', '/v1/forms/f-1/data', {
      status: 200,
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
    expect(fake.requests).toHaveLength(2);
  });

  it.each([400, 404, 500])('returns HTTP %i as a response, not as unavailability', async (status) => {
    route('GET', 'finance', '/v1/finance/records', jsonReply({ error: `status ${status}` }, status));

    const response = await createGatewayClient(ANONYMOUS).get('finance', '/v1/finance/records');

    expect(response).toMatchObject({ status, ok: false, body: { error: `status ${status}` } });
    expect(isUnavailable(response)).toBe(false);
    expect(onlyRequest().method).toBe('GET');
  });

  it('returns an unrouted path as an empty 404 response', async () => {
    const response = await createGatewayClient(ANONYMOUS).get('finance', '/v1/unknown');

    expect(response).toMatchObject({ status: 404, ok: false, body: undefined, setCookies: [] });
    expect(isUnavailable(response)).toBe(false);
  });

  it.each([502, 503, 504])('fails closed on HTTP %i after exactly one request', async (status) => {
    route('GET', 'timesheets', '/v1/timesheets/sheets', {
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
    const page = legacyUnavailable();
    expect(page.status).toBe(503);
    expect(await page.text()).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(fake.requests).toHaveLength(1);
  });

  it.each<{ status: number; label: string; body: string }>(
    [502, 503, 504].flatMap((status) => [
      { status, label: 'malformed JSON', body: '{"truncated":' },
      { status, label: 'an HTML page labelled JSON', body: '<html><body><h1>Service Unavailable</h1></body></html>' },
    ]),
  )('fails closed on HTTP $status with $label without decoding it', async ({ status, body }) => {
    route('GET', 'timesheets', '/v1/timesheets/sheets', {
      status,
      headers: { 'content-type': 'application/json' },
      body,
    });

    const error = await createGatewayClient(ANONYMOUS)
      .get('timesheets', '/v1/timesheets/sheets')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'timesheets', status });
    expect(isUnavailable(error)).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('fails closed when the gateway refuses the connection', async () => {
    await fake.refuse();

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
    expect(fake.requests).toHaveLength(0);
  });

  it('fails closed after exactly one request when the gateway drops the connection mid-response', async () => {
    route('GET', 'reporting', '/v1/reporting/exports', () => {
      fake.closeConnections();
      return OK;
    });

    const error = await createGatewayClient(ANONYMOUS)
      .get('reporting', '/v1/reporting/exports')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'reporting', status: undefined });
    expect((error as GatewayUnavailableError).cause).toBeInstanceOf(ServiceUnavailableError);
    expect(isUnavailable(error)).toBe(true);
    expect(fake.requests).toHaveLength(1);
  });

  it('propagates an undecodable JSON answer unchanged instead of failing closed', async () => {
    route('GET', 'communications', '/v1/templates', {
      status: 200,
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

describe('assertNotDenied', () => {
  const operation = 'GET /v1/raw/cform/getfieldtype';

  it.each<{ status: number; denied: boolean }>([
    { status: 401, denied: true },
    { status: 403, denied: true },
    { status: 200, denied: false },
    { status: 302, denied: false },
    { status: 404, denied: false },
    { status: 500, denied: false },
  ])('raises GatewayDenialError for HTTP $status: $denied', ({ status, denied }) => {
    let thrown: unknown;
    try {
      assertNotDenied({ status }, 'strategies-content', operation);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown instanceof GatewayDenialError).toBe(denied);
    expect(thrown).toEqual(
      denied
        ? expect.objectContaining({
            service: 'strategies-content',
            operation,
            status,
            message: `${operation} answered HTTP ${status}`,
          })
        : undefined,
    );
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
    route('GET', 'people', '/v1/x', OK);

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
      headers: { [REQUEST_ID_HEADER]: 'req-anonymous' },
      userToken: null,
      rawBody: true,
    });
    expect(relayed.body).toEqual({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('sends each client created with its own service client through that client alone', async () => {
    const stubbed = (body: string) => {
      const request = vi.fn<(req: ServiceRequest) => Promise<ServiceResponse>>(async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(body),
      }));
      return { request, client: { request: request as ServiceClient['request'], close: () => Promise.resolve() } };
    };
    const first = stubbed('first');
    const second = stubbed('second');
    route('GET', 'people', '/v1/x', OK);
    const firstClient = createGatewayClient(ANONYMOUS, first.client);
    const secondClient = createGatewayClient({ requestId: 'req-second', inbound: {} }, second.client);

    const answers = [
      await secondClient.get('finance', '/v1/y'),
      await firstClient.get('people', '/v1/x'),
      await createGatewayClient(ANONYMOUS).get('people', '/v1/x'),
      await firstClient.raw('people', { method: 'GET', path: '/v1/z' }),
    ];

    expect(answers.map(({ body }) => body)).toEqual(['second', 'first', { ok: true }, Buffer.from('first')]);
    expect(first.request.mock.calls.map(([req]) => [req.path, req.headers])).toEqual([
      ['/opt2/svc/people/v1/x', { [REQUEST_ID_HEADER]: 'req-anonymous' }],
      ['/opt2/svc/people/v1/z', { [REQUEST_ID_HEADER]: 'req-anonymous' }],
    ]);
    expect(second.request.mock.calls.map(([req]) => [req.path, req.headers])).toEqual([
      ['/opt2/svc/finance/v1/y', { [REQUEST_ID_HEADER]: 'req-second' }],
    ]);
    expect(fake.requests.map(requestLine)).toEqual(['GET /opt2/svc/people/v1/x']);
  });

  it('keeps the client built at first use until reset, then rebuilds from the environment', async () => {
    route('GET', 'people', '/v1/x', OK);
    const refused = await startFakeGateway();
    await refused.refuse();
    const client = createGatewayClient(ANONYMOUS);
    await client.get('people', '/v1/x');

    const restore = useTestEnv({ OPT2_GATEWAY_URL: refused.url });
    try {
      await client.get('people', '/v1/x');
      setServiceClientForTests(undefined);
      await expect(client.get('people', '/v1/x')).rejects.toBeInstanceOf(GatewayUnavailableError);
    } finally {
      restore();
    }
    expect(fake.requests).toHaveLength(2);
  });
});

