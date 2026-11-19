// The gateway client's streamed calls and its own Version menu read over the in-memory platform client: an unread
// 2xx stream, bytes otherwise; and the multipart relay of an inbound body.
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, ServiceUnavailableError, type ServiceRequest } from '@opt2/platform/service-kit';
import {
  GatewayUnavailableError,
  LEGACY_VERSION_MENU_PATH,
  createGatewayClient,
  discardStreamed,
  multipartRelay,
  streamedCallOf,
  type GatewayClient,
  type GatewayResponse,
  type MultipartBody,
  type StreamedCall,
  type StreamedResponse,
} from '@/lib/gateway-client';
import { LEGACY_VERSION_MENU } from '../fixtures/gateway/version-menu';
import { useTestEnv } from '../helpers/env';
import { fakeServiceClient, routeKey, type FakeReply, type FakeServiceClient } from '../helpers/fake-gateway';

const PATH = '/v1/users/download';
const ROUTE = routeKey('GET', 'people', PATH);
const QUERY = { siteid: 'default', ispublic: '0', unassigned: '0' };
const CSV_HEADERS = { 'content-type': 'text/csv;charset=UTF-8', 'content-disposition': 'attachment;filename=users.csv' };

let relay: FakeServiceClient;
let sent: ServiceRequest[];
let client: GatewayClient;
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
  sent = [];
  relay = fakeServiceClient({}, (req) => sent.push(req));
  client = createGatewayClient({ requestId: 'req-stream', inbound: {} }, relay);
});

afterEach(() => {
  restoreEnv();
});

type StreamCall = (gateway: GatewayClient) => Promise<StreamedResponse>;

const STREAM_CALLS: ReadonlyArray<[string, StreamCall]> = [
  ['the core call', (gateway) => gateway.stream('people', { method: 'GET', path: PATH, query: QUERY })],
  ['the facade', (gateway) => gateway.people.stream('get', PATH, { query: QUERY })],
];

describe('stream', () => {
  it.each(STREAM_CALLS)('answers a 2xx through %s as the unread stream its producer is still writing', async (_label, invoke) => {
    const producer = new PassThrough();
    producer.write('"USERID"\n');
    relay.setRoute(ROUTE, { status: 200, headers: CSV_HEADERS, body: producer, setCookies: ['CFID=1; Path=/'] });

    const response = await invoke(client);

    expect(sent).toEqual([
      expect.objectContaining({ method: 'GET', path: `/opt2/svc/people${PATH}?siteid=default&ispublic=0&unassigned=0` }),
    ]);
    expect(sent[0]).toMatchObject({ rawBody: true, stream: true });
    expect(response).toMatchObject({ status: 200, ok: true, headers: CSV_HEADERS, setCookies: ['CFID=1; Path=/'] });
    if (!response.ok) throw new TypeError('Expected a 2xx answer');
    expect(response.body).toBeInstanceOf(Readable);
    const chunks = response.body[Symbol.asyncIterator]();
    expect(String((await chunks.next()).value)).toBe('"USERID"\n');
    expect(producer.writableEnded).toBe(false);
    producer.end('"U1"\n');
    expect(String((await chunks.next()).value)).toBe('"U1"\n');
    expect((await chunks.next()).done).toBe(true);
  });

  it.each<[string, StreamCall, string, StreamedCall]>([
    [
      'the core call, without its query',
      (gateway) => gateway.stream('people', { method: 'GET', path: `${PATH}?siteid=default` }),
      ROUTE,
      { service: 'people', operation: `GET ${PATH}` },
    ],
    [
      'the facade, by its path template',
      (gateway) => gateway.identity.stream('get', '/v1/groups/{groupId}/members.csv', { params: { groupId: 'G1' } }),
      routeKey('GET', 'identity', '/v1/groups/G1/members.csv'),
      { service: 'identity', operation: 'GET /v1/groups/{groupId}/members.csv' },
    ],
  ])('records the call a 2xx stream through %s answers', async (_label, invoke, route, call) => {
    relay.setRoute(route, { status: 200, headers: CSV_HEADERS, body: '"USERID"\n' });

    const response = await invoke(client);

    if (!response.ok) throw new TypeError('Expected a 2xx answer');
    expect(streamedCallOf(response.body)).toEqual(call);
    expect(streamedCallOf(new PassThrough())).toBeUndefined();
    discardStreamed(response.body);
  });

  it.each([400, 401, 404, 500])('answers HTTP %i as the received bytes', async (status) => {
    relay.setRoute(ROUTE, { status, headers: { 'content-type': 'text/html;charset=UTF-8' }, body: '<h1>No</h1>' });

    const response = await client.stream('people', { method: 'GET', path: PATH });

    expect(response).toMatchObject({ status, ok: false });
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(response.body).toEqual(Buffer.from('<h1>No</h1>'));
  });

  it.each<[string, (fake: FakeServiceClient) => void, number | undefined]>([
    ...[502, 503, 504].map((status): [string, (fake: FakeServiceClient) => void, number] => [
      `HTTP ${status}`,
      (fake) => fake.setRoute(ROUTE, { status, body: '<h1>Service Unavailable</h1>' } satisfies FakeReply),
      status,
    ]),
    ['a refused connection', (fake) => fake.failWith(), undefined],
  ])('fails closed on %s', async (_label, arrange, status) => {
    arrange(relay);

    const error = await client.stream('people', { method: 'GET', path: PATH }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'people', status });
    if (status === undefined) expect((error as GatewayUnavailableError).cause).toBeInstanceOf(ServiceUnavailableError);
    expect(sent).toHaveLength(1);
  });

  it.each<[string, (gateway: GatewayClient) => Promise<GatewayResponse>]>([
    ['raw', (gateway) => gateway.raw('people', { method: 'GET', path: PATH })],
    ['call', (gateway) => gateway.call('people', { method: 'GET', path: PATH })],
  ])('leaves %s reading the whole body', async (_label, invoke) => {
    relay.setRoute(ROUTE, { status: 200, headers: { 'content-type': 'text/plain' }, body: 'a,b' });

    const response = await invoke(client);

    expect(sent[0]).toMatchObject({ rawBody: true });
    expect(sent[0]).not.toHaveProperty('stream');
    expect(response.body).not.toBeInstanceOf(Readable);
  });
});

describe('discardStreamed', () => {
  it('destroys an unread stream that reports its destruction as an error, raising nothing', async () => {
    // As undici's body does, destroying it unread emits an abort error.
    const body = new Readable({
      read: () => undefined,
      destroy: (error, callback) => callback(error ?? new Error('Request aborted')),
    });

    const closed = new Promise((resolve) => body.once('close', resolve));
    discardStreamed(body);
    await closed;

    expect(body.destroyed).toBe(true);
  });
});

describe('multipartRelay', () => {
  const BOUNDARY = '----opt2relay7';
  const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
  const MULTIPART = [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="newfile"; filename="brochure.pdf"',
    'Content-Type: application/pdf',
    '',
    '%PDF-1.4 synthetic',
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n');
  const SIZED = { 'content-length': String(Buffer.byteLength(MULTIPART)) };

  it.each<[string, () => MultipartBody['body'], Readonly<Record<string, string>>]>([
    ['Uint8Array', () => new TextEncoder().encode(MULTIPART), {}],
    ['ArrayBuffer', () => new TextEncoder().encode(MULTIPART).buffer, {}],
    ['Blob', () => new Blob([MULTIPART]), SIZED],
    ['sized re-readable source', () => ({ size: Buffer.byteLength(MULTIPART), stream: () => new Blob([MULTIPART]).stream() }), SIZED],
    ['ReadableStream', () => new Blob([MULTIPART]).stream(), {}],
  ])('relays a %s body unchanged under its content type', async (_name, body, framing) => {
    const relayed = multipartRelay({ contentType: CONTENT_TYPE, body: body() });
    expect(relayed.headers).toEqual({ 'content-type': CONTENT_TYPE, ...framing });
    const bytes = relayed.body instanceof Readable ? await buffer(relayed.body) : relayed.body;
    expect(bytes.toString('utf8')).toBe(MULTIPART);
  });
});

describe('legacyVersionMenu', () => {
  const MENU_ROUTE = routeKey('GET', 'gateway', LEGACY_VERSION_MENU_PATH);

  it("sends a GET to the gateway's own path with the request id, acting for no user, and decodes the facts", async () => {
    relay.setRoute(MENU_ROUTE, { status: 200, body: LEGACY_VERSION_MENU });

    const response = await createGatewayClient({ userToken: 'user-token', requestId: 'req-menu', inbound: {} }, relay).legacyVersionMenu();

    expect(response).toMatchObject({ status: 200, ok: true, body: LEGACY_VERSION_MENU });
    expect(sent).toEqual([
      expect.objectContaining({
        service: 'gateway',
        method: 'GET',
        path: LEGACY_VERSION_MENU_PATH,
        userToken: null,
        headers: { [REQUEST_ID_HEADER]: 'req-menu' },
        rawBody: true,
      }),
    ]);
  });

  it('returns a denial as relayed', async () => {
    relay.setRoute(MENU_ROUTE, { status: 403, body: { error: 'forbidden' } });

    await expect(client.legacyVersionMenu()).resolves.toMatchObject({ status: 403, ok: false, body: { error: 'forbidden' } });
  });

  it.each<[string, (fake: FakeServiceClient) => void, number | undefined]>([
    ['HTTP 503', (fake) => fake.setRoute(MENU_ROUTE, { status: 503, body: '<h1>Service Unavailable</h1>' }), 503],
    ['a refused connection', (fake) => fake.failWith(), undefined],
  ])('fails closed on %s as the gateway unavailable', async (_label, arrange, status) => {
    arrange(relay);

    const error = await client.legacyVersionMenu().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'gateway', status });
    expect(sent).toHaveLength(1);
  });
});
