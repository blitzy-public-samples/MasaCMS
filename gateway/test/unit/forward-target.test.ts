// Tests forwardToTarget against loopback stand-ins for a service and web: request headers, body, responses and fail closed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createRequire } from 'node:module';
import replyFrom from '@fastify/reply-from';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stripInboundAuthHeaders, type InvocationMinter, type InvocationTarget } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_HTML_CONTENT_TYPE,
  apiUnavailableResponse,
  legacyHeaders,
} from '@opt2/platform/legacy-compat';
import type { WritePositions } from '@opt2/platform/migration-kit';
import {
  MemorySpanExporter,
  SpanKind,
  flushTracing,
  shutdownTracing,
  startTracing,
  withExtractedContext,
  type Context,
} from '@opt2/platform/tracing';
import type { FailContext } from '../../src/dispatcher/fail-closed.js';
import { forwardToTarget, type TargetForwardContext, type TargetUpstream } from '../../src/dispatcher/forward-target.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from '../helpers/http-double.js';

const USER_TOKEN = 'user-token-abc';
const SESSION_ID = 'sess-1';
const REQUEST_ID = 'gw-req-7';
const SITE_HOST = 'site.example';
const API: FailContext = { surface: 'api', method: 'findOne', params: { siteid: 'default' } };
const ADMIN: FailContext = { surface: 'admin' };
const ACTIVE_TRACE = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', tracestate: 'active=1' };

/** Context fields a test sets; the harness fills the collaborators. */
type Overrides = Partial<Omit<TargetForwardContext, 'invocation' | 'barrier'>> & { traced?: boolean };

interface Harness {
  app: FastifyInstance;
  minted: InvocationTarget[];
  recorded: Array<[string, WritePositions]>;
  logs: Array<{ level: number; msg: string }>;
  settled: () => number;
  set(overrides: Overrides): void;
  setMinter(minter: InvocationMinter): void;
  setRecordFailure(error: Error | undefined): void;
}

/** A gateway stand-in whose catch-all forwards to `service` with the current overrides. */
async function startHarness(service: () => HttpDouble): Promise<Harness> {
  const minted: InvocationTarget[] = [];
  const recorded: Array<[string, WritePositions]> = [];
  const logs: Array<{ level: number; msg: string }> = [];
  let settledCount = 0;
  let overrides: Overrides = {};
  let recordFailure: Error | undefined;
  let minter: InvocationMinter = {
    async headersFor(target) {
      minted.push(target);
      return { 'X-Serverless-Authorization': `Bearer inv-${target.name}` };
    },
  };

  const app = Fastify({
    genReqId: () => REQUEST_ID,
    logger: { level: 'warn', stream: { write: (line: string) => logs.push(JSON.parse(line) as { level: number; msg: string }) } },
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  await app.register(replyFrom);

  const forward = (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { traced, ...fields } = overrides;
    const ctx: TargetForwardContext = {
      service: 'people',
      serviceUrl: `${service().url}/`,
      path: request.url,
      headers: stripInboundAuthHeaders(request.headers, { afterExchange: true }),
      mode: 'target-primary',
      isWeb: false,
      failContext: API,
      invocation: minter,
      barrier: {
        async record(sessionId, positions) {
          if (recordFailure !== undefined) throw recordFailure;
          recorded.push([sessionId, positions]);
        },
      },
      onSettled: async () => {
        settledCount += 1;
      },
      ...fields,
    };
    return traced ? withExtractedContext(ACTIVE_TRACE, () => forwardToTarget(request, reply, ctx)) : forwardToTarget(request, reply, ctx);
  };
  app.all('/*', forward);
  await app.ready();

  return {
    app,
    minted,
    recorded,
    logs,
    settled: () => settledCount,
    set(next) {
      overrides = next;
      settledCount = 0;
      minted.length = 0;
      recorded.length = 0;
      logs.length = 0;
    },
    setMinter(next) {
      minter = next;
    },
    setRecordFailure(error) {
      recordFailure = error;
    },
  };
}

/** The single request the double received. */
function only(double: HttpDouble): RecordedRequest {
  expect(double.requests).toHaveLength(1);
  return double.requests[0] as RecordedRequest;
}

/** Waits until onSettled ran, then confirms it ran exactly once. */
async function expectSettledOnce(harness: Harness): Promise<void> {
  await vi.waitFor(() => expect(harness.settled()).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(harness.settled()).toBe(1);
}

let service: HttpDouble;
let legacy: HttpDouble;
let harness: Harness;

beforeAll(async () => {
  service = await startHttpDouble((_req, res) => sendJson(res, 200, { data: 'ok' }));
  legacy = await startHttpDouble((_req, res) => sendBytes(res, 200, 'legacy'));
  harness = await startHarness(() => service);
});

afterEach(() => {
  service.clearRequests();
  service.setHandler((_req, res) => sendJson(res, 200, { data: 'ok' }));
  harness.set({});
  harness.setRecordFailure(undefined);
  harness.setMinter({
    async headersFor(target) {
      harness.minted.push(target);
      return { 'X-Serverless-Authorization': `Bearer inv-${target.name}` };
    },
  });
});

afterAll(async () => {
  await harness.app.close();
  await service.close();
  await legacy.close();
});

describe('forwardToTarget request', () => {
  it('sends the user token, the minted invocation credential, forwarded facts, the request id and the callee host', async () => {
    harness.set({ userToken: USER_TOKEN });
    const res = await harness.app.inject({
      method: 'GET',
      url: '/_api/json/v1/default/content/abc?x=a%20b&y=%E2%82%AC&z',
      headers: {
        host: SITE_HOST,
        authorization: 'Basic Y2xpZW50OnNlY3JldA==',
        'x-serverless-authorization': 'Bearer forged',
        'x-opt2-original-url': '/forged',
        'x-opt2-write-position': 'people=1',
        'x-forwarded-for': '203.0.113.9',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-request-id': 'client-chosen',
      },
    });
    expect(res.statusCode).toBe(200);
    const received = only(service);
    expect(received.url).toBe('/_api/json/v1/default/content/abc?x=a%20b&y=%E2%82%AC&z');
    expect(received.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(received.headers['x-serverless-authorization']).toBe('Bearer inv-people');
    expect(harness.minted).toEqual([{ name: 'people', url: `${service.url}/` }]);
    expect(received.headers.host).toBe(`127.0.0.1:${String(service.port)}`);
    expect(received.headers['x-forwarded-for']).toBe('203.0.113.9, 127.0.0.1');
    expect(received.headers['x-forwarded-proto']).toBe('http');
    expect(received.headers['x-forwarded-host']).toBe(SITE_HOST);
    expect(received.headers['x-request-id']).toBe(REQUEST_ID);
    expect(received.headers.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(Object.keys(received.headers).filter((name) => name.startsWith('x-opt2-'))).toEqual([]);
    expect(received.rawHeaders.filter((value) => value === 'Bearer forged')).toEqual([]);
  });

  it('sends no Authorization without a user token', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes', headers: { authorization: 'Bearer client' } });
    expect(res.statusCode).toBe(200);
    expect(only(service).headers.authorization).toBeUndefined();
  });

  it.each([
    ['application/json', Buffer.from('{ "a" :1,  "b":[ ] }')],
    ['application/octet-stream', Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x7f])],
    ['application/x-www-form-urlencoded', Buffer.from('a=1&a=2&b=%20')],
  ])('forwards a %s body byte for byte', async (contentType, body) => {
    const res = await harness.app.inject({ method: 'POST', url: '/v1/notes', headers: { 'content-type': contentType }, payload: body });
    expect(res.statusCode).toBe(200);
    const received = only(service);
    expect(received.body.equals(body)).toBe(true);
    expect(received.headers['content-type']).toBe(contentType);
    expect(received.headers['content-length']).toBe(String(body.length));
  });

  it('sends the method override without a body, content type or length when the body is not forwarded', async () => {
    harness.set({ method: 'GET', forwardBody: false });
    await harness.app.inject({
      method: 'POST',
      url: '/admin/cusers/list',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'siteid=default',
    });
    const received = only(service);
    expect(received.method).toBe('GET');
    expect(received.body.length).toBe(0);
    expect(received.headers['content-type']).toBeUndefined();
    expect(received.headers['content-length']).toBeUndefined();
  });
});

describe('forwardToTarget web', () => {
  const webHeaders = {
    'x-nextjs-cache': 'HIT',
    vary: 'RSC, Next-Router-State-Tree, Accept-Encoding',
    'content-type': 'text/html; charset=utf-8',
  };

  it('adds the original URL, strips Next router headers and normalises page response headers', async () => {
    service.setHandler((_req, res) => sendBytes(res, 200, '<html></html>', webHeaders));
    harness.set({
      service: 'web',
      isWeb: true,
      failContext: ADMIN,
      path: '/admin/cusers/list?muraAction=cUsers.list',
      extraHeaders: { 'X-Opt2-Original-Url': '/admin/?muraAction=cUsers.list' },
    });
    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/?muraAction=cUsers.list',
      headers: { rsc: '1', 'next-router-state-tree': 'x', 'next-url': '/a', 'next-action': 'b', cookie: 'CFID=1' },
    });
    const received = only(service);
    expect(received.url).toBe('/admin/cusers/list?muraAction=cUsers.list');
    expect(received.headers['x-opt2-original-url']).toBe('/admin/?muraAction=cUsers.list');
    expect(received.headers['x-serverless-authorization']).toBe('Bearer inv-web');
    expect(received.headers.cookie).toBe('CFID=1');
    for (const name of ['rsc', 'next-router-state-tree', 'next-url', 'next-action']) expect(received.headers[name]).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-nextjs-cache']).toBeUndefined();
    expect(res.headers.vary).toBe('Accept-Encoding');
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.body).toBe('<html></html>');
  });

  it('answers a page-mode 307 as an empty 302 with the same Location', async () => {
    service.setHandler((_req, res) =>
      sendBytes(res, 307, '/admin/?muraAction=cLogin.main', { location: '/admin/?muraAction=cLogin.main', 'x-nextjs-redirect': '1' }),
    );
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/home/redirect' });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(302);
    expect(res.body).toBe('');
    expect(res.headers.location).toBe('/admin/?muraAction=cLogin.main');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.pragma).toBe('no-cache');
    await expectSettledOnce(harness);
  });

  it('forwards /_next/ assets with their headers in both directions', async () => {
    service.setHandler((_req, res) => sendBytes(res, 200, 'js', { 'content-type': 'application/javascript', 'x-nextjs-cache': 'HIT' }));
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/_next/static/chunk.js' });
    const res = await harness.app.inject({ method: 'GET', url: '/_next/static/chunk.js', headers: { rsc: '1' } });
    expect(only(service).headers.rsc).toBe('1');
    expect(res.headers['x-nextjs-cache']).toBe('HIT');
    expect(res.headers['content-type']).toBe('application/javascript');
  });

  it('fails closed on a web 500', async () => {
    service.setHandler((_req, res) => sendBytes(res, 500, 'boom'));
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/list' });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
  });
});

describe('forwardToTarget response', () => {
  it('strips the write position and records it for the session', async () => {
    service.setHandler((_req, res) => sendJson(res, 200, { data: 1 }, { 'x-opt2-write-position': 'people=42,identity=41' }));
    harness.set({ sessionId: SESSION_ID });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people', payload: '' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(harness.recorded).toEqual([[SESSION_ID, new Map([['people', '42'], ['identity', '41']])]]);
  });

  it('strips the write position without recording it when there is no session', async () => {
    service.setHandler((_req, res) => sendJson(res, 200, { data: 1 }, { 'x-opt2-write-position': 'people=42' }));
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(harness.recorded).toEqual([]);
  });

  it.each([
    ['a malformed header', 'people=x', undefined],
    ['a failed record', 'people=42', new Error('database down')],
  ])('logs %s at error and still returns the response', async (_label, value, failure) => {
    service.setHandler((_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': value }));
    harness.set({ sessionId: SESSION_ID });
    harness.setRecordFailure(failure);
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'target write position not recorded')).toBe(true);
  });

  it('adds Generator and HSTS when absent and keeps a Generator the service sent', async () => {
    const expected = legacyHeaders();
    let res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers.generator).toBe(expected.Generator);
    expect(res.headers['strict-transport-security']).toBe(expected['Strict-Transport-Security']);

    service.setHandler((_req, res2) => sendJson(res2, 200, {}, { generator: 'Masa CMS 7.6.1 (service)' }));
    res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers.generator).toBe('Masa CMS 7.6.1 (service)');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('replaces Set-Cookie with the mapped list, also when the service sent none', async () => {
    const seen: string[][] = [];
    service.setHandler((_req, res) => sendJson(res, 200, {}, { 'set-cookie': ['CFID=t1; Path=/', 'other=1'] }));
    harness.set({
      mapSetCookies: async (cookies) => {
        seen.push(cookies);
        return ['CFID=mapped; Path=/; HttpOnly', 'extra=2'];
      },
    });
    let res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers['set-cookie']).toEqual(['CFID=mapped; Path=/; HttpOnly', 'extra=2']);

    service.setHandler((_req, res2) => sendJson(res2, 200, {}));
    res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers['set-cookie']).toEqual(['CFID=mapped; Path=/; HttpOnly', 'extra=2']);
    expect(seen).toEqual([['CFID=t1; Path=/', 'other=1'], []]);
  });

  it('passes the upstream status and headers to beforeSend and still sends when it rejects', async () => {
    const upstreams: TargetUpstream[] = [];
    service.setHandler((_req, res) => sendJson(res, 200, { data: 'out' }, { 'set-cookie': 'a=1', 'x-opt2-write-position': 'people=3' }));
    harness.set({
      beforeSend: async (upstream) => {
        upstreams.push(upstream);
        throw new Error('invalidation failed');
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: 'out' });
    expect(upstreams[0]?.statusCode).toBe(200);
    expect(upstreams[0]?.headers['set-cookie']).toEqual(['a=1']);
    expect(upstreams[0]?.headers['x-opt2-write-position']).toBe('people=3');
    expect(harness.logs.some((line) => line.msg === 'target forward beforeSend failed')).toBe(true);
  });

  it('drops hop-by-hop response headers and those Connection lists', async () => {
    service.setHandler((_req, res) =>
      sendJson(res, 200, {}, { connection: 'keep-alive, x-hop', 'keep-alive': 'timeout=1', 'x-hop': '1', 'x-end': '2' }),
    );
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers['x-hop']).toBeUndefined();
    expect(res.headers['keep-alive']).toBeUndefined();
    expect(res.headers['x-end']).toBe('2');
  });

  it('passes a service 500 through unchanged', async () => {
    service.setHandler((_req, res) => sendJson(res, 500, { error: { type: 'server_error' } }));
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { type: 'server_error' } });
    await expectSettledOnce(harness);
  });
});

describe('forwardToTarget fail closed', () => {
  const apiUnavailable = apiUnavailableResponse({ method: API.method, params: API.params });

  /** Asserts the 503 of `surface`, a settled exchange and an untouched legacy stand-in. */
  async function expectFailClosed(res: Awaited<ReturnType<FastifyInstance['inject']>>, surface: 'api' | 'admin'): Promise<void> {
    expect(res.statusCode).toBe(503);
    if (surface === 'api') expect(res.body).toBe(apiUnavailable.body);
    else expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(legacy.requests).toHaveLength(0);
    await expectSettledOnce(harness);
  }

  it.each([
    [502, 'api'],
    [503, 'api'],
    [504, 'api'],
    [502, 'admin'],
    [503, 'admin'],
    [504, 'admin'],
  ] as const)('answers a service %i on the %s surface with the legacy 503', async (status, surface) => {
    service.setHandler((_req, res) => sendBytes(res, status, 'upstream', { 'x-opt2-write-position': 'people=9', 'x-up': '1' }));
    harness.set({ failContext: surface === 'api' ? API : ADMIN, sessionId: SESSION_ID });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    await expectFailClosed(res, surface);
    expect(res.headers['x-up']).toBeUndefined();
    expect(harness.recorded).toEqual([]);
  });

  it('does not retry a GET answered 503', async () => {
    service.setHandler((_req, res) => sendBytes(res, 503, 'busy', { 'retry-after': '0' }));
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.statusCode).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(service.requests).toHaveLength(1);
  });

  it.each(['api', 'admin'] as const)('answers a refused connection on the %s surface with the legacy 503', async (surface) => {
    const closed = await startHttpDouble((_req, res) => sendBytes(res, 200, 'never'));
    await closed.close();
    const refused = await startHarness(() => closed);
    try {
      refused.set({ failContext: surface === 'api' ? API : ADMIN });
      const res = await refused.app.inject({ method: 'GET', url: '/v1/notes' });
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(surface === 'api' ? apiUnavailable.body : LEGACY_ERROR_PAGE_HTML);
      expect(legacy.requests).toHaveLength(0);
      await expectSettledOnce(refused);
    } finally {
      await refused.app.close();
    }
  });

  it('answers a service that stalls past the call timeout with the legacy 503', { timeout: 25_000 }, async () => {
    service.setHandler(() => new Promise<void>((resolve) => setTimeout(resolve, 12_000)));
    const started = Date.now();
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(Date.now() - started).toBeLessThan(12_000);
    await expectFailClosed(res, 'api');
    expect(service.requests).toHaveLength(1);
  });

  it('answers an invalid upstream status with the legacy 503', async () => {
    service.setHandler((_req, res) => sendBytes(res, 600, 'odd'));
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    await expectFailClosed(res, 'api');
  });

  it('fails closed without calling the service when the credential cannot be minted', async () => {
    harness.setMinter({
      async headersFor() {
        throw new Error('metadata server unreachable');
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    await expectFailClosed(res, 'api');
    expect(service.requests).toHaveLength(0);
  });

  it('fails closed without calling the service for a path reply-from rejects', async () => {
    harness.set({ path: '/v1/%2e%2e/secret' });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    await expectFailClosed(res, 'api');
    expect(service.requests).toHaveLength(0);
  });

  it('fails closed when the Set-Cookie mapping fails', async () => {
    harness.set({
      mapSetCookies: async () => {
        throw new Error('jar unavailable');
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    await expectFailClosed(res, 'api');
  });

  it('settles once after a forwarded response completes', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.statusCode).toBe(200);
    await expectSettledOnce(harness);
  });
});

// AsyncLocalStorage context manager, so a span context can be active without the SDK and its undici instrumentation.
class AlsContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  constructor(private readonly root: Context) {}

  active(): Context {
    return this.storage.getStore() ?? this.root;
  }

  with<A extends unknown[], R>(ctx: Context, fn: (...args: A) => R, thisArg?: unknown, ...args: A): R {
    return this.storage.run(ctx, () => fn.apply(thisArg, args));
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

/** The OTel API as the platform resolves it, so the context manager lands in the registry the platform reads. */
interface OtelApi {
  ROOT_CONTEXT: Context;
  context: { setGlobalContextManager(manager: AlsContextManager): boolean; disable(): void };
}

const INBOUND_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** Every value the service received for header `name`, one per header line. */
function rawValues(recorded: RecordedRequest, name: string): string[] {
  return recorded.rawHeaders.filter((_, i, raw) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === name);
}

describe('forwardToTarget trace context without undici instrumentation', () => {
  const otel = createRequire(createRequire(import.meta.url).resolve('@opt2/platform/tracing'))(
    '@opentelemetry/api',
  ) as OtelApi;

  beforeAll(() => {
    expect(otel.context.setGlobalContextManager(new AlsContextManager(otel.ROOT_CONTEXT))).toBe(true);
  });

  afterAll(() => {
    otel.context.disable();
  });

  it('sends exactly the active span context in place of the inbound one', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(false);
    harness.set({ traced: true });
    await harness.app.inject({ method: 'GET', url: '/v1/notes', headers: { traceparent: INBOUND_TRACEPARENT } });
    const received = only(service);
    expect(rawValues(received, 'traceparent')).toEqual([ACTIVE_TRACE.traceparent]);
    expect(rawValues(received, 'tracestate')).toEqual([ACTIVE_TRACE.tracestate]);
  });
});

describe('forwardToTarget trace context with the SDK started', () => {
  const exporter = new MemorySpanExporter();

  beforeAll(async () => {
    await startTracing({ serviceName: 'gateway-forward-target-test', version: '1.0.0', exporter });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it('sends one traceparent, from the client span the instrumentation starts under the active context', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(true);
    harness.set({ traced: true });
    await harness.app.inject({ method: 'GET', url: '/v1/notes', headers: { traceparent: INBOUND_TRACEPARENT } });
    const received = only(service);
    const traceparents = rawValues(received, 'traceparent');
    expect(traceparents).toHaveLength(1);
    const [, traceId, parentId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparents[0] ?? '') ?? [];
    expect(traceId).toBe(ACTIVE_TRACE.traceparent.split('-')[1]);
    expect(rawValues(received, 'tracestate')).toEqual([ACTIVE_TRACE.tracestate]);

    await flushTracing();
    const client = exporter.getFinishedSpans().find((span) => span.spanContext().spanId === parentId);
    expect(client?.kind).toBe(SpanKind.CLIENT);
  });
});
