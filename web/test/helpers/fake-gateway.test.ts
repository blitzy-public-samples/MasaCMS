// Tests of the fake gateways: recording of fields that shadow Object.prototype members, and the in-memory client's
// parity with the production client over HTTP.
import { afterEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import {
  GatewayUnavailableError,
  createGatewayClient,
  setServiceClientForTests,
  type GatewayClient,
  type GatewayResponse,
} from '@/lib/gateway-client';
import { useTestEnv } from './env';
import {
  fakeGatewayClient,
  routeKey,
  startFakeGateway,
  type FakeCall,
  type FakeGateway,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type RecordedRequest,
} from './fake-gateway';

type Pairs = [string, string][];
type Recorded = Readonly<Record<string, string | string[]>> | undefined;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const PING_PATH = '/opt2/svc/identity/v1/ping';
const OBJECT_PROTOTYPE = Object.getOwnPropertyDescriptors(Object.prototype);

let fake: FakeGateway | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** The fields one fake recorded for a request carrying `pairs` in its query or form. */
const RECORDERS: readonly (readonly [string, (pairs: Pairs) => Promise<Recorded>])[] = [
  [
    'HTTP fake query',
    async (pairs) => {
      fake = await startFakeGateway();
      await (await fetch(`${fake.url}${PING_PATH}?${new URLSearchParams(pairs)}`)).arrayBuffer();
      return fake.requests[0]?.query;
    },
  ],
  [
    'HTTP fake form',
    async (pairs) => {
      fake = await startFakeGateway();
      const response = await fetch(`${fake.url}${PING_PATH}`, {
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: new URLSearchParams(pairs).toString(),
      });
      await response.arrayBuffer();
      return fake.requests[0]?.form;
    },
  ],
  [
    'in-memory client query',
    async (pairs) => {
      const client = fakeGatewayClient();
      await client.get('identity', '/v1/ping', { query: new URLSearchParams(pairs) });
      return client.calls[0]?.query;
    },
  ],
  [
    'in-memory client form',
    async (pairs) => {
      const client = fakeGatewayClient();
      await client.postForm('identity', '/v1/ping', pairs);
      return client.calls[0]?.form;
    },
  ],
];

/** A single and a repeated field named `name`, with the value each is recorded as. */
function casesOf(name: string): { label: string; name: string; pairs: Pairs; expected: string | string[] }[] {
  return [
    { label: `${name}=a`, name, pairs: [[name, 'a']], expected: 'a' },
    { label: `${name}=a&${name}=b`, name, pairs: [[name, 'a'], [name, 'b']], expected: ['a', 'b'] },
  ];
}

const CASES = ['constructor', 'toString', '__proto__'].flatMap((name) => casesOf(name));

describe.each(RECORDERS)('%s', (_fake, record) => {
  it.each(CASES)('records $label as one own field', async ({ name, pairs, expected }) => {
    const recorded = (await record(pairs)) ?? {};

    expect(Object.keys(recorded)).toEqual([name]);
    expect(Object.getOwnPropertyDescriptor(recorded, name)).toEqual({
      value: expected,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getPrototypeOf(recorded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(OBJECT_PROTOTYPE);
  });
});

describe('in-memory client parity with the production client over HTTP', () => {
  const USER_TOKEN = 'parity-user-token';
  const REQUEST_ID = 'req-parity';
  const CSRF_CONTEXTS = ['login', 'updatecore'];
  const MULTIPART_TYPE = 'multipart/form-data; boundary=B0UND';
  const MULTIPART = Buffer.from(
    '--B0UND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n\u0000\u00ff\r\n--B0UND--\r\n',
    'latin1',
  );
  const SHELL_ROUTE = routeKey('GET', 'programs-sites', '/v1/sites/tenant-a/shell');
  const UNAVAILABLE: FakeReply = { status: 503, headers: { 'content-type': 'text/html' }, body: '<h1>Unavailable</h1>' };
  // Added only by the socket, or minted only by the process-wide client.
  const WIRE_ONLY_HEADERS: readonly string[] = ['host', 'connection', 'content-length', INVOCATION_HEADER];

  const comparable = (request: RecordedRequest): RecordedRequest => ({
    ...request,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([name]) => !WIRE_ONLY_HEADERS.includes(name))),
  });

  const answerOf = ({ status, ok, body, setCookies, location }: GatewayResponse) => ({
    status,
    ok,
    body,
    setCookies,
    location,
  });

  /** `routes` with every request a route answers also collected into `seen`. */
  const collecting = (routes: FakeRouteTable, seen: RecordedRequest[]): FakeRouteTable =>
    Object.fromEntries(
      Object.entries(routes).map(([key, route]) => [
        key,
        (request: RecordedRequest) => {
          seen.push(request);
          return typeof route === 'function' ? route(request) : route;
        },
      ]),
    );

  /** `invoke`'s outcome through the process-wide production client against an HTTP fake set up by `arrange`. */
  async function overHttp<T>(
    arrange: (gateway: FakeGateway) => void | Promise<void>,
    invoke: (client: GatewayClient) => Promise<T>,
  ): Promise<{ outcome: T; requests: RecordedRequest[] }> {
    const gateway = await startFakeGateway();
    fake = gateway;
    await arrange(gateway);
    const restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: gateway.url });
    const restoreClient = setServiceClientForTests(undefined);
    try {
      const outcome = await invoke(createGatewayClient({ userToken: USER_TOKEN, requestId: REQUEST_ID, inbound: {} }));
      return { outcome, requests: gateway.requests };
    } finally {
      restoreClient();
      restoreEnv();
    }
  }

  const inMemory = (routes: FakeRouteTable = {}): FakeGatewayClient =>
    fakeGatewayClient(routes, { userToken: USER_TOKEN, requestId: REQUEST_ID });

  it.each<{
    label: string;
    routes: FakeRouteTable;
    invoke: (client: GatewayClient) => Promise<GatewayResponse>;
    call: FakeCall;
  }>([
    {
      label: 'identity.csrfTokens with one Set-Cookie',
      routes: {
        [routeKey('POST', 'identity', '/v1/csrf/tokens')]: { status: 200, body: { tokens: [] }, setCookies: ['a=1'] },
      },
      invoke: (client) => client.identity.csrfTokens(CSRF_CONTEXTS),
      call: {
        service: 'identity',
        method: 'POST',
        path: '/v1/csrf/tokens',
        json: { contexts: CSRF_CONTEXTS },
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    },
    {
      label: 'programsSites.getShellSite with a site id needing encoding',
      routes: {
        [routeKey('GET', 'programs-sites', '/v1/sites/tenant%20a%2Fb/shell')]: { status: 200, body: { site: 'x' } },
      },
      invoke: (client) => client.programsSites.getShellSite('tenant a/b'),
      call: {
        service: 'programs-sites',
        method: 'GET',
        path: '/v1/sites/tenant%20a%2Fb/shell',
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    },
    {
      label: 'programsSites.hrefDomains',
      routes: {
        [routeKey('GET', 'programs-sites', '/v1/href-domains')]: {
          status: 200,
          body: { allowedDomains: ['localhost'], siteDomain: 'localhost' },
        },
      },
      invoke: (client) => client.programsSites.hrefDomains('tenant-a'),
      call: {
        service: 'programs-sites',
        method: 'GET',
        path: '/v1/href-domains',
        query: { siteid: 'tenant-a' },
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    },
    {
      label: 'postForm with repeated fields, a caller header and a 302 setting two cookies',
      routes: {
        [routeKey('POST', 'identity', '/v1/login')]: {
          status: 302,
          headers: { location: './' },
          setCookies: ['CFID=1; Path=/', 'CFTOKEN=2; Path=/'],
        },
      },
      invoke: (client) =>
        client.postForm(
          'identity',
          '/v1/login',
          [
            ['groupid', 'g1'],
            ['username', 'admin'],
            ['groupid', 'g2'],
          ],
          { query: { siteid: 'default' }, headers: { 'X-Csrf-Token': 'T' } },
        ),
      call: {
        service: 'identity',
        method: 'POST',
        path: '/v1/login',
        query: { siteid: 'default' },
        form: { groupid: ['g1', 'g2'], username: 'admin' },
        headers: { 'x-csrf-token': 'T' },
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    },
    {
      label: 'postMultipart with Blob bytes',
      routes: {
        [routeKey('POST', 'strategies-content', '/v1/files')]: {
          status: 201,
          headers: { 'content-type': 'text/plain;charset=utf-8' },
          body: 'stored',
        },
      },
      invoke: (client) =>
        client.postMultipart(
          'strategies-content',
          '/v1/files',
          { contentType: MULTIPART_TYPE, body: new Blob([new Uint8Array(MULTIPART)]) },
          { query: { siteid: 'default' } },
        ),
      call: {
        service: 'strategies-content',
        method: 'POST',
        path: '/v1/files',
        query: { siteid: 'default' },
        headers: { 'content-type': MULTIPART_TYPE },
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    },
  ])('sends and answers $label as the production client does over HTTP', async ({ routes, invoke, call }) => {
    const seen: RecordedRequest[] = [];
    const client = inMemory(collecting(routes, seen));

    const memory = await invoke(client);
    const { outcome: http, requests } = await overHttp((gateway) => {
      for (const [key, route] of Object.entries(routes)) gateway.setRoute(key, route);
    }, invoke);

    expect(client.calls).toStrictEqual([call]);
    expect(requests).toHaveLength(1);
    expect(seen.map(comparable)).toStrictEqual(requests.map(comparable));
    expect(answerOf(memory)).toStrictEqual(answerOf(http));
    expect(http.headers).toMatchObject(memory.headers);
  });

  it.each<{
    label: string;
    status: number | undefined;
    arrange: (client: FakeGatewayClient) => void;
    arrangeHttp: (gateway: FakeGateway) => void | Promise<void>;
  }>([
    {
      label: 'a 503 answer',
      status: 503,
      arrange: (client) => client.setRoute(SHELL_ROUTE, UNAVAILABLE),
      arrangeHttp: (gateway) => gateway.setRoute(SHELL_ROUTE, UNAVAILABLE),
    },
    {
      label: 'failWith() as a refused connection',
      status: undefined,
      arrange: (client) => client.failWith(),
      arrangeHttp: (gateway) => gateway.refuse(),
    },
  ])('rejects $label with the GatewayUnavailableError of the called service', async ({ status, arrange, arrangeHttp }) => {
    const client = inMemory();
    arrange(client);
    const read = (gateway: GatewayClient): Promise<unknown> =>
      gateway.programsSites.getShellSite('tenant-a').catch((caught: unknown) => caught);

    const memory = await read(client);
    const { outcome: http } = await overHttp(arrangeHttp, read);

    for (const error of [memory, http]) {
      expect(error).toBeInstanceOf(GatewayUnavailableError);
      expect(error).toMatchObject({ service: 'programs-sites', status, message: (http as Error).message });
      const { cause } = error as GatewayUnavailableError;
      if (status === undefined) expect(cause).toBeInstanceOf(ServiceUnavailableError);
      else expect(cause).toBeUndefined();
    }
    expect(client.calls).toStrictEqual([
      {
        service: 'programs-sites',
        method: 'GET',
        path: '/v1/sites/tenant-a/shell',
        userToken: USER_TOKEN,
        requestId: REQUEST_ID,
      },
    ]);
  });

  it('rethrows the error given to failWith unchanged after recording the call', async () => {
    const client = inMemory();
    const error = new Error('boom');
    client.failWith(error);

    await expect(client.identity.currentSession()).rejects.toBe(error);
    expect(client.calls.map(({ service, path }) => `${service} ${path}`)).toEqual(['identity /v1/sessions/current']);
  });
});
