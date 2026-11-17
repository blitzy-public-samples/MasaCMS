// Tests of the fake gateways: recording of fields that shadow Object.prototype members, the in-memory clients' parity
// with the production client over HTTP, and the in-memory gateway's parity with the HTTP fake.
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import { testVerifier } from '@opt2/platform/testing';
import {
  GatewayUnavailableError,
  createGatewayClient,
  discardStreamed,
  setServiceClientForTests,
  type GatewayClient,
  type GatewayResponse,
} from '@/lib/gateway-client';
import { useTestEnv } from '../helpers/env';
import {
  fakeGatewayClient,
  fakeServiceClient,
  inMemoryGateway,
  routeKey,
  startFakeGateway,
  type FakeCall,
  type FakeGateway,
  type FakeGatewayClient,
  type FakeReply,
  type FakeRouteTable,
  type FakeServiceClient,
  type InMemoryGateway,
  type RecordedRequest,
} from '../helpers/fake-gateway';

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
    { userToken }: { userToken?: string } = { userToken: USER_TOKEN },
  ): Promise<{ outcome: T; requests: RecordedRequest[] }> {
    const gateway = await startFakeGateway();
    fake = gateway;
    await arrange(gateway);
    const restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: gateway.url });
    const restoreClient = setServiceClientForTests(undefined);
    try {
      const outcome = await invoke(createGatewayClient({ userToken, requestId: REQUEST_ID, inbound: {} }));
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
        headers: { 'content-type': MULTIPART_TYPE, 'content-length': String(MULTIPART.length) },
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

  it.each<{ label: string; reply: FakeReply }>([
    {
      label: 'a 2xx CSV',
      reply: { status: 200, headers: { 'content-type': 'text/csv;charset=UTF-8' }, body: '"USERID"\n', setCookies: ['a=1'] },
    },
    { label: 'a 404 page', reply: { status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>No</h1>' } },
  ])('answers a streamed call with $label as the production client does over HTTP', async ({ reply }) => {
    const csvRoute = routeKey('GET', 'people', '/v1/users/download');
    const read = async (gateway: GatewayClient) => {
      const response = await gateway.stream('people', { method: 'GET', path: '/v1/users/download' });
      const { body } = response;
      const received = body instanceof Readable ? { stream: String(await buffer(body)) } : { bytes: String(body) };
      return { ...answerOf(response), body: received };
    };

    const memory = await read(inMemory({ [csvRoute]: reply }));
    const { outcome: http } = await overHttp((gateway) => gateway.setRoute(csvRoute, reply), read);

    expect(memory).toStrictEqual(http);
  });

  it('rethrows the error given to failWith unchanged after recording the call', async () => {
    const client = inMemory();
    const error = new Error('boom');
    client.failWith(error);

    await expect(client.identity.currentSession()).rejects.toBe(error);
    expect(client.calls.map(({ service, path }) => `${service} ${path}`)).toEqual(['identity /v1/sessions/current']);
  });

  const SHELL: FakeReply = { status: 200, body: { site: 'x' } };
  const readShell = (client: GatewayClient): Promise<GatewayResponse> => client.programsSites.getShellSite('tenant-a');
  const overRelay = (relay: FakeServiceClient, userToken: string | undefined): GatewayClient =>
    createGatewayClient({ userToken, requestId: REQUEST_ID, inbound: {} }, relay);

  it.each([
    { label: 'a user token', userToken: USER_TOKEN, authorization: `Bearer ${USER_TOKEN}` },
    { label: 'no user token', userToken: undefined, authorization: undefined },
  ])(
    'fakeServiceClient records a request with $label as the HTTP fake receives it',
    async ({ userToken, authorization }) => {
      const relay = fakeServiceClient({ [SHELL_ROUTE]: SHELL });

      const memory = await readShell(overRelay(relay, userToken));
      const { outcome: http, requests } = await overHttp(
        (gateway) => gateway.setRoute(SHELL_ROUTE, SHELL),
        readShell,
        { userToken },
      );

      expect(relay.requests.map(comparable)).toStrictEqual(requests.map(comparable));
      expect(relay.requests.map(({ headers }) => headers.authorization)).toEqual([authorization]);
      expect(answerOf(memory)).toStrictEqual(answerOf(http));
    },
  );

  it('fakeServiceClient records a failed request and fails every request until reset, keeping its routes', async () => {
    const relay = fakeServiceClient({ [SHELL_ROUTE]: SHELL });
    const client = overRelay(relay, USER_TOKEN);
    relay.failWith();

    await expect(readShell(client)).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(readShell(client)).rejects.toBeInstanceOf(GatewayUnavailableError);
    expect(relay.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /opt2/svc/programs-sites/v1/sites/tenant-a/shell',
      'GET /opt2/svc/programs-sites/v1/sites/tenant-a/shell',
    ]);

    relay.reset();
    expect(relay.requests).toEqual([]);
    expect(relay.hasRoute(SHELL_ROUTE)).toBe(true);
    expect((await readShell(client)).status).toBe(200);
    expect(relay.requests).toHaveLength(1);
  });
});

describe('inMemoryGateway parity with the HTTP fake beneath the production client', () => {
  const USER_TOKEN = 'parity-user-token';
  const REQUEST_ID = 'req-parity';
  const CSV_PATH = '/v1/users/download';
  const CSV_ROUTE = routeKey('GET', 'people', CSV_PATH);
  const CSV_HEADERS = { 'content-type': 'text/csv;charset=UTF-8', 'content-disposition': 'attachment;filename=users.csv' };
  const MULTIPART_TYPE = 'multipart/form-data; boundary=B0UND';
  const MULTIPART = Buffer.from(
    '--B0UND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\n\u0000\u00ff\r\n--B0UND--\r\n',
    'latin1',
  );
  // Sixteen 64 KiB chunks, more than a body stream buffers, so the reader pauses and resumes the producer.
  const LARGE_CSV = Buffer.alloc(16 * 65_536, '"U1"\n');
  // Request headers only the socket adds; the invocation credential differs per mint, so it is verified instead.
  const WIRE_REQUEST_HEADERS: readonly string[] = ['host', 'connection', 'content-length', 'transfer-encoding', INVOCATION_HEADER];
  const WIRE_RESPONSE_HEADERS: readonly string[] = ['date', 'connection', 'keep-alive', 'content-length', 'transfer-encoding'];

  let http: FakeGateway;
  let memory: InMemoryGateway;
  let restoreEnv: () => void;

  beforeEach(async () => {
    http = await startFakeGateway();
    fake = http;
    memory = inMemoryGateway();
    restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: http.url });
  });

  afterEach(() => {
    restoreEnv();
  });

  const without = <T>(record: Readonly<Record<string, T>>, names: readonly string[]): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([name]) => !names.includes(name)));

  const comparable = (request: RecordedRequest): RecordedRequest => ({
    ...request,
    headers: without(request.headers, WIRE_REQUEST_HEADERS),
  });

  /** `invoke`'s outcome through the production platform client `client`, the process-wide one when undefined. */
  async function over<T>(client: ServiceClient | undefined, invoke: (gateway: GatewayClient) => Promise<T>): Promise<T> {
    const restoreClient = setServiceClientForTests(client);
    try {
      return await invoke(createGatewayClient({ userToken: USER_TOKEN, requestId: REQUEST_ID, inbound: {} }));
    } finally {
      restoreClient();
    }
  }

  /** The parts of `response` a caller sees, a streamed body read whole as text, which compares faster than bytes. */
  const answerOf = async ({ status, ok, headers, body, setCookies, location }: GatewayResponse) => ({
    status,
    ok,
    headers,
    body: body instanceof Readable ? { streamed: String(await buffer(body)) } : body,
    setCookies,
    location,
  });

  it.each<{ label: string; routes: FakeRouteTable; invoke: (gateway: GatewayClient) => Promise<GatewayResponse> }>([
    {
      label: 'a JSON post answered with one Set-Cookie',
      routes: { [routeKey('POST', 'identity', '/v1/csrf/tokens')]: { status: 200, body: { tokens: [] }, setCookies: ['a=1'] } },
      invoke: (gateway) => gateway.identity.csrfTokens(['login', 'updatecore']),
    },
    {
      label: 'a form post with repeated fields and a caller header answered 302 with two cookies',
      routes: {
        [routeKey('POST', 'identity', '/v1/login')]: {
          status: 302,
          headers: { location: './' },
          setCookies: ['CFID=1; Path=/', 'CFTOKEN=2; Path=/'],
        },
      },
      invoke: (gateway) =>
        gateway.postForm(
          'identity',
          '/v1/login',
          [
            ['groupid', 'g1'],
            ['username', 'admin'],
            ['groupid', 'g2'],
          ],
          { query: { siteid: 'default' }, headers: { 'X-Csrf-Token': 'T' } },
        ),
    },
    {
      label: 'a multipart stream of unknown length',
      routes: {
        [routeKey('POST', 'strategies-content', '/v1/files')]: {
          status: 201,
          headers: { 'content-type': 'text/plain;charset=utf-8' },
          body: 'stored',
        },
      },
      invoke: (gateway) =>
        gateway.postMultipart('strategies-content', '/v1/files', {
          contentType: MULTIPART_TYPE,
          body: new Blob([new Uint8Array(MULTIPART)]).stream(),
        }),
    },
    {
      label: 'a streamed 2xx produced as text chunks',
      routes: { [CSV_ROUTE]: () => ({ status: 200, headers: CSV_HEADERS, body: Readable.from(['"USERID"\n', '"U1"\n']) }) },
      invoke: (gateway) => gateway.stream('people', { method: 'GET', path: CSV_PATH }),
    },
    {
      label: 'a streamed 2xx larger than the reader buffers',
      routes: {
        [CSV_ROUTE]: () => ({
          status: 200,
          headers: CSV_HEADERS,
          body: Readable.from(Array.from({ length: 16 }, (_, index) => LARGE_CSV.subarray(index * 65_536, (index + 1) * 65_536))),
        }),
      },
      invoke: (gateway) => gateway.stream('people', { method: 'GET', path: CSV_PATH }),
    },
    {
      label: 'an unrouted call answered by the empty 404',
      routes: {},
      invoke: (gateway) => gateway.get('identity', '/v1/unrouted'),
    },
  ])('records and answers $label as the HTTP fake does', async ({ routes, invoke }) => {
    for (const [key, route] of Object.entries(routes)) {
      http.setRoute(key, route);
      memory.setRoute(key, route);
    }

    const overHttp = await answerOf(await over(undefined, invoke));
    const inMemory = await answerOf(await over(memory.client, invoke));

    expect(memory.requests).toHaveLength(1);
    expect(memory.requests.map(comparable)).toStrictEqual(http.requests.map(comparable));
    await expect(
      testVerifier('gateway').invocationVerifier.verify(memory.requests[0]?.headers[INVOCATION_HEADER] ?? ''),
    ).resolves.toMatchObject({ name: 'web' });
    expect({ ...inMemory, headers: undefined }).toStrictEqual({ ...overHttp, headers: undefined });
    expect(inMemory.headers).toStrictEqual(without(overHttp.headers, WIRE_RESPONSE_HEADERS));
  });

  it('fails a refused call as the HTTP fake does, recording neither', async () => {
    await http.refuse();
    memory.refuse();
    const read = (gateway: GatewayClient): Promise<unknown> =>
      gateway.programsSites.getShellSite('tenant-a').catch((caught: unknown) => caught);

    const overHttp = (await over(undefined, read)) as GatewayUnavailableError;
    const inMemory = (await over(memory.client, read)) as GatewayUnavailableError;

    for (const error of [overHttp, inMemory]) {
      expect(error).toBeInstanceOf(GatewayUnavailableError);
      expect(error).toMatchObject({ service: 'programs-sites', status: undefined, message: overHttp.message });
      expect(error.cause).toBeInstanceOf(ServiceUnavailableError);
    }
    expect(inMemory.cause).toMatchObject({ message: (overHttp.cause as Error).message });
    expect(memory.requests).toEqual([]);
    expect(http.requests).toEqual([]);
  });

  it.each<[string, () => ServiceClient | undefined]>([
    ['the HTTP fake', () => undefined],
    ['the in-memory gateway', () => memory.client],
  ])('ends the producer when the reader discards an unread streamed 2xx over %s', async (_label, client) => {
    const producer = new PassThrough();
    producer.write('"USERID"\n');
    const reply: FakeReply = { status: 200, headers: CSV_HEADERS, body: producer };
    http.setRoute(CSV_ROUTE, reply);
    memory.setRoute(CSV_ROUTE, reply);
    const closed = new Promise((resolve) => producer.once('close', resolve));

    const response = await over(client(), (gateway) => gateway.stream('people', { method: 'GET', path: CSV_PATH }));
    discardStreamed(response.body);
    await closed;

    expect(producer.destroyed).toBe(true);
    expect(producer.writableEnded).toBe(false);
  });
});

