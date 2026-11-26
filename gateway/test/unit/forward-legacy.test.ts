// Tests that the composed gateway proxies unmoved routes to legacy byte for byte, and how credentials differ for target-bound routes.
import { Buffer } from 'node:buffer';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { testVerifier } from '@opt2/platform/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import type { RecordedRequest } from '../helpers/http-double.js';
import type { LegacyEcho } from '../helpers/legacy-origin.js';
import type { TargetEcho } from '../helpers/target-double.js';

const SITE_HOST = 'tenant-a.example.test';
const PAGE_URL = '/index.cfm/some/page?b=2&a=1&a=3';
const BASIC = 'Basic YWRtaW46eA==';
const FORGED_INVOCATION = 'Bearer forged';
const FORGED_HEADERS = {
  'X-OPT2-Bridge-Assertion': 'forged',
  'X-Opt2-Anything': 'x',
  'X-Serverless-Authorization': FORGED_INVOCATION,
};
/** Bytes no UTF-8 decoder round-trips: NUL, 0xff, a lone continuation byte and a truncated sequence. */
const REQUEST_BYTES = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0xe2, 0x82, 0x0d, 0x0a, 0x00]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0xc0, 0x00]);
const LEGACY_SET_COOKIES = ['A=1;path=/;', 'B=2;path=/;HttpOnly;'];
/** Every header the legacy double's Node server sends for a programmed text answer. */
const LEGACY_SENT_HEADERS: ReadonlySet<string> = new Set([
  'x-legacy-double',
  'content-type',
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);
/** Content-Type values without a media type; Node delivers an empty one as ''. */
const NO_MEDIA_TYPES = [';charset=utf-8', ',', ';', '; boundary=x', ''];
/** Legacy's servlet container answer to a POST under such a Content-Type, sent before any CFML runs. */
const CONTAINER_500 = {
  status: 500,
  headers: { 'content-type': 'text/html;charset=UTF-8' },
  body: '<html><head><title>ERROR</title></head><body>Error processing request</body></html>',
};

let gateway: TestGateway | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

/** A gateway with v0001 active, so every inventoried route is legacy-bound and the stub is target-bound. */
async function v0001(): Promise<TestGateway> {
  gateway = await buildTestGateway({ version: 'v0001' });
  return gateway;
}

/** Page requests legacy received, bridge calls left out. */
function pages(g: TestGateway): RecordedRequest[] {
  return g.legacy.requests.filter((req) => !req.path.startsWith('/gateway/legacy-bridge/'));
}

/** The one page request legacy received. */
function onlyPage(g: TestGateway): RecordedRequest {
  const received = pages(g);
  expect(received).toHaveLength(1);
  return received[0] as RecordedRequest;
}

/** GETs raw `target` from the listening gateway on its own connection, so no client URL parsing folds or encodes it. */
function rawGet(g: TestGateway, target: string): Promise<{ status: number | undefined; body: Buffer }> {
  const { port } = g.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: target, headers: { host: SITE_HOST }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Sends `method` to raw `target` on its own connection, with `headers` in order and `body` as given. */
function rawSend(
  g: TestGateway,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: Buffer }> {
  const { port } = g.app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: target,
        headers: { host: SITE_HOST, ...headers, 'content-length': String(body.length) },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Lower-cased header names in `rawHeaders` that `names` lists, in the order they were sent. */
function sentOrderOf(rawHeaders: readonly string[], names: readonly string[]): string[] {
  return rawHeaders
    .filter((_, index) => index % 2 === 0)
    .map((name) => name.toLowerCase())
    .filter((name) => names.includes(name));
}

/** Lower-cased names of the `x-opt2-*` headers in `headers`. */
function opt2HeaderNames(headers: Record<string, unknown>): string[] {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith('x-opt2-'));
}

describe('legacy forwarding under v0001', () => {
  it('legacy request bytes, path, query and Host reach legacy unchanged, with X-Forwarded-* added', async () => {
    const g = await v0001();

    const res = await g.app.inject({
      method: 'POST',
      url: PAGE_URL,
      headers: { host: SITE_HOST, 'x-custom': 'Keep', 'content-type': 'application/octet-stream' },
      payload: REQUEST_BYTES,
    });

    expect(res.statusCode).toBe(200);
    const received = onlyPage(g);
    expect(received.body.equals(REQUEST_BYTES)).toBe(true);
    expect(received.method).toBe('POST');
    expect(received.url).toBe(PAGE_URL);
    expect(received.headers['x-custom']).toBe('Keep');
    expect(received.headers['content-type']).toBe('application/octet-stream');
    const echo = res.json<LegacyEcho>();
    expect(echo).toMatchObject({
      path: '/index.cfm/some/page',
      url: PAGE_URL,
      query: { b: '2', a: ['1', '3'] },
      host: SITE_HOST,
      forwarded: { for: '127.0.0.1', proto: 'http', host: SITE_HOST },
      contentType: 'application/octet-stream',
    });
    expect(Buffer.from(echo.bodyBase64, 'base64').equals(REQUEST_BYTES)).toBe(true);
  });

  it('strips inbound X-OPT2-* and X-Serverless-Authorization headers but keeps Authorization for legacy', async () => {
    const g = await v0001();

    const res = await g.app.inject({
      method: 'GET',
      url: PAGE_URL,
      headers: { host: SITE_HOST, authorization: BASIC, ...FORGED_HEADERS },
    });

    expect(res.statusCode).toBe(200);
    const received = onlyPage(g);
    expect(opt2HeaderNames(received.headers)).toEqual([]);
    expect(received.headers[INVOCATION_HEADER]).toBeUndefined();
    expect(received.headers.authorization).toBe(BASIC);
    expect(res.json<LegacyEcho>().authorization).toBe(BASIC);
  });

  it('legacy response status, bytes, headers and Set-Cookie order pass through unchanged', async () => {
    const g = await v0001();
    const { cookieHeader } = g.legacy.createSession();
    g.legacy.setResponse({
      status: 201,
      headers: { 'content-type': 'image/png', 'x-legacy': 'v', 'cache-control': 'no-store' },
      body: PNG_BYTES,
      setCookies: LEGACY_SET_COOKIES,
    });

    const res = await g.app.inject({ method: 'GET', url: PAGE_URL, headers: { host: SITE_HOST, cookie: cookieHeader } });

    expect(res.statusCode).toBe(201);
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(res.headers).toMatchObject({ 'content-type': 'image/png', 'x-legacy': 'v', 'cache-control': 'no-store' });
    expect(res.headers['set-cookie']).toEqual(LEGACY_SET_COOKIES);
    expect(onlyPage(g).headers.cookie).toBe(cookieHeader);
  });

  it('legacy session Set-Cookie values pass unchanged in legacy-primary mode', async () => {
    const g = await v0001();
    const { cookieHeader, setCookies } = g.legacy.createSession();
    g.legacy.setResponse({ setCookies: 'session' });

    const res = await g.app.inject({ method: 'GET', url: PAGE_URL, headers: { host: SITE_HOST, cookie: cookieHeader } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toEqual(setCookies);
  });

  it('adds no Generator, HSTS or other gateway header to a legacy response', async () => {
    const g = await v0001();
    const { cookieHeader } = g.legacy.createSession();
    g.legacy.setResponse({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<p>legacy</p>' });

    const res = await g.app.inject({ method: 'GET', url: PAGE_URL, headers: { host: SITE_HOST, cookie: cookieHeader } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<p>legacy</p>');
    expect(res.headers.generator).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(Object.keys(res.headers).filter((name) => !LEGACY_SENT_HEADERS.has(name))).toEqual([]);
  });

  it.each<{ status: number; headers: Record<string, string>; body: string }>([
    { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<h1>500 - Internal Server Error</h1>' },
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<h1>404 - Not Found</h1>' },
    { status: 302, headers: { location: '/admin/?muraAction=cLogin.main&returnURL=%2Fsome%2Fpage' }, body: '' },
  ])('a legacy $status passes its status, body and headers through unrewritten', async ({ status, headers, body }) => {
    const g = await v0001();
    const { cookieHeader } = g.legacy.createSession();
    g.legacy.setResponse({ status, headers, body });

    const res = await g.app.inject({ method: 'GET', url: PAGE_URL, headers: { host: SITE_HOST, cookie: cookieHeader } });

    expect(res.statusCode).toBe(status);
    expect(res.rawPayload.equals(Buffer.from(body))).toBe(true);
    expect(res.headers).toMatchObject(headers);
    if (!('location' in headers)) expect(res.headers.location).toBeUndefined();
  });

  it.each([
    '/default/../',
    '/default/%2e%2e/',
    '/admin/%2e%2e/index.cfm',
    '/core/%2e%2e/index.cfm',
    '/a/./b/../',
    '/%2e/',
    '/default/%2E%2E/x',
    '/a//b/../c',
    '/a%2F..%2Fb',
    '/legacy-fixtures/cfml/api.cfm/people/x/%2e%2e/persons',
    '/default/?q=%E0%A4%A',
    '/default/?',
  ])("%s reaches legacy as the raw request target, and the client gets legacy's answer", async (target) => {
    const g = await v0001();
    await g.app.listen({ host: '127.0.0.1', port: 0 });
    g.legacy.setResponse({ status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>404 - Not Found</h1>' });

    const res = await rawGet(g, target);

    expect(onlyPage(g).url).toBe(target);
    expect(res.status).toBe(404);
    expect(res.body.toString()).toBe('<h1>404 - Not Found</h1>');
  });

  it("answers a malformed path escape with legacy's bare 400 before dispatch, as legacy's container rejects it", async () => {
    const g = await v0001();
    await g.app.listen({ host: '127.0.0.1', port: 0 });

    const res = await rawGet(g, '/x/%E0%A4%A');

    expect(res).toEqual({ status: 400, body: Buffer.alloc(0) });
    expect(pages(g)).toEqual([]);
  });

  it.each(NO_MEDIA_TYPES.flatMap((contentType) => [REQUEST_BYTES, Buffer.alloc(0)].map((body) => ({ contentType, body }))))(
    "a POST under Content-Type \"$contentType\" with a $body.length-byte body reaches legacy as sent, and the client gets legacy's 500",
    async ({ contentType, body }) => {
      const g = await v0001();
      await g.app.listen({ host: '127.0.0.1', port: 0 });
      g.legacy.setResponse(CONTAINER_500);

      const res = await rawSend(g, 'POST', PAGE_URL, { 'x-before': '1', 'content-type': contentType, 'x-after': '2' }, body);

      expect(res.status).toBe(CONTAINER_500.status);
      expect(res.headers['content-type']).toBe(CONTAINER_500.headers['content-type']);
      expect(res.body.toString()).toBe(CONTAINER_500.body);
      const received = onlyPage(g);
      expect(received.method).toBe('POST');
      expect(received.url).toBe(PAGE_URL);
      expect(received.headers['content-type']).toBe(contentType);
      expect(sentOrderOf(received.rawHeaders, ['x-before', 'content-type', 'x-after'])).toEqual(['x-before', 'content-type', 'x-after']);
      expect(received.body.equals(body)).toBe(true);
    },
  );

  it.each([
    { method: 'POST', contentType: 'text' },
    { method: 'POST', contentType: 'text/' },
    { method: 'POST', contentType: '/plain' },
    { method: 'POST', contentType: 'a b/c' },
    { method: 'POST', contentType: '=' },
    { method: 'POST', contentType: ',text/plain' },
    { method: 'PUT', contentType: ';charset=utf-8' },
    { method: 'PATCH', contentType: ',' },
    { method: 'DELETE', contentType: ';' },
    { method: 'OPTIONS', contentType: '; boundary=x' },
  ])('a $method under Content-Type "$contentType", which Fastify refuses, reaches legacy as sent, and the client gets its answer', async ({ method, contentType }) => {
    const g = await v0001();
    await g.app.listen({ host: '127.0.0.1', port: 0 });

    const res = await rawSend(g, method, PAGE_URL, { 'content-type': contentType }, REQUEST_BYTES);

    expect(res.status).toBe(200);
    const received = onlyPage(g);
    expect(received.method).toBe(method);
    expect(received.headers['content-type']).toBe(contentType);
    expect(received.body.equals(REQUEST_BYTES)).toBe(true);
    const echo = JSON.parse(res.body.toString()) as LegacyEcho;
    expect(echo.contentType).toBe(contentType);
    expect(Buffer.from(echo.bodyBase64, 'base64').equals(REQUEST_BYTES)).toBe(true);
  });

  it("a target-bound request never carries the client's Authorization or forged invocation credential", async () => {
    const g = await v0001();
    const stub = g.targets.stub;
    if (stub === undefined) throw new Error('buildTestGateway started no stub double');

    const res = await g.app.inject({
      method: 'GET',
      url: '/opt2/stub/notes',
      headers: { host: SITE_HOST, authorization: BASIC, ...FORGED_HEADERS },
    });

    expect(res.statusCode).toBe(200);
    expect(pages(g)).toEqual([]);
    const [echo] = stub.echoes() as [TargetEcho];
    expect(stub.requests).toHaveLength(1);
    expect(echo.authorization).not.toBe(BASIC);
    if (echo.authorization !== undefined) {
      expect(echo.authorization).toMatch(/^Bearer \S+$/);
      // A token the user verifier accepts was minted by identity, so the gateway attached it.
      await expect(testVerifier().userVerifier.verify(echo.authorization.slice('Bearer '.length))).resolves.toBeDefined();
    }
    expect(echo.serverlessAuthorization).toBeDefined();
    expect(echo.serverlessAuthorization).not.toBe(FORGED_INVOCATION);
    const caller = await testVerifier('stub').invocationVerifier.verify(echo.serverlessAuthorization ?? '');
    expect(caller.name).toBe('gateway');
    const forwarded = stub.requests[0]?.headers ?? {};
    expect(forwarded['x-opt2-bridge-assertion']).toBeUndefined();
    expect(forwarded['x-opt2-anything']).toBeUndefined();
  });
});

describe('legacy forwarding under v0002', () => {
  const FIXTURE = '/legacy-fixtures/cfml/api.cfm';
  const PERSON_ID = '00532E14-B51F-226C-36938FA3E4A6396C';
  it.each([`${FIXTURE}/people/persons/..%5C..%5Cweb.config`, `${FIXTURE}/people/persons/..%5C..%5Cweb.config/archive`])(
    "a POST to %s, whose fixture entry is target, reaches legacy as the raw request target, and the client gets legacy's answer",
    async (target) => {
      gateway = await buildTestGateway({ version: 'v0002' });
      await gateway.app.listen({ host: '127.0.0.1', port: 0 });
      gateway.legacy.setResponse({ status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>404 - Not Found</h1>' });

      const res = await rawSend(gateway, 'POST', target, {}, Buffer.alloc(0));

      expect(onlyPage(gateway).url).toBe(target);
      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe('<h1>404 - Not Found</h1>');
      expect(Object.values(gateway.targets).flatMap((double) => double.requests)).toEqual([]);
    },
  );

  it.each(NO_MEDIA_TYPES)(
    "a POST to the target person archive entry under Content-Type %j reaches legacy as sent, never a service, and the client gets legacy's 500",
    async (contentType) => {
      const target = `${FIXTURE}/people/persons/${PERSON_ID}/archive`;
      gateway = await buildTestGateway({ version: 'v0002' });
      await gateway.app.listen({ host: '127.0.0.1', port: 0 });
      gateway.legacy.setResponse(CONTAINER_500);

      const res = await rawSend(gateway, 'POST', target, { 'content-type': contentType }, REQUEST_BYTES);

      expect(res.status).toBe(CONTAINER_500.status);
      expect(res.headers['content-type']).toBe(CONTAINER_500.headers['content-type']);
      expect(res.body.toString()).toBe(CONTAINER_500.body);
      const received = onlyPage(gateway);
      expect(received.url).toBe(target);
      expect(received.headers['content-type']).toBe(contentType);
      expect(received.body.equals(REQUEST_BYTES)).toBe(true);
      expect(Object.values(gateway.targets).flatMap((double) => double.requests)).toEqual([]);
    },
  );

  it('sends a fixture path reply-from cannot parse, whose entry is target, to people as the raw request target, never to legacy', async () => {
    const target = `${FIXTURE}/people/persons/x%5C../archive`;
    const notFound = '{"apiversion":"v1","error":{"code":"invalid_request","message":"Not Found"}}';
    gateway = await buildTestGateway({ version: 'v0002' });
    await gateway.app.listen({ host: '127.0.0.1', port: 0 });
    gateway.targets.people?.setResponse({ status: 404, headers: { 'content-type': 'application/json' }, body: notFound });

    const res = await rawSend(gateway, 'POST', target, {}, Buffer.alloc(0));

    expect(gateway.targets.people?.requests.map((req) => req.url)).toEqual([target]);
    expect(res.status).toBe(404);
    expect(res.body.toString()).toBe(notFound);
    expect(pages(gateway)).toEqual([]);
  });
});
