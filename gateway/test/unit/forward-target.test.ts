// Tests forwardToTarget against loopback stand-ins for a service and web: request headers, body, responses and fail closed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
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
import { serializeError } from '@opt2/platform/logging';
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
import { BarrierTimeoutError } from '../../src/dispatcher/barrier.js';
import type { FailContext } from '../../src/dispatcher/fail-closed.js';
import { forwardToTarget, type TargetForwardContext, type TargetUpstream } from '../../src/dispatcher/forward-target.js';
import {
  sendBytes,
  sendJson,
  startHttpDouble,
  type DoubleHandler,
  type HttpDouble,
  type RecordedRequest,
} from '../helpers/http-double.js';

const USER_TOKEN = 'user-token-abc';
const SESSION_ID = 'sess-1';
const REQUEST_ID = 'gw-req-7';
const SITE_HOST = 'site.example';
const API: FailContext = { surface: 'api', method: 'findOne', params: { siteid: 'default' } };
const ADMIN: FailContext = { surface: 'admin' };
const ACTIVE_TRACE = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', tracestate: 'active=1' };

/** Context fields a test sets; the harness fills the collaborators. */
type Overrides = Partial<Omit<TargetForwardContext, 'invocation' | 'barrier'>> & { traced?: boolean };

/** One parsed gateway log record. */
interface LogLine {
  level: number;
  msg: string;
  error?: unknown;
}

/** A projection await the barrier was asked for: the unrecorded positions, or the owners of an unparsed header. */
type Confirmation = ['positions', WritePositions] | ['owners', string[]];

interface Harness {
  app: FastifyInstance;
  minted: InvocationTarget[];
  /** Recorded positions, with the declared owner whose declaration the record ended when there is one. */
  recorded: Array<[string, WritePositions] | [string, WritePositions, string]>;
  /** Declarations as session, owner and the number of requests the service had received when it was made. */
  declared: Array<[string, string, number]>;
  released: Array<[string, string]>;
  confirmations: Confirmation[];
  logs: LogLine[];
  settled: () => number;
  set(overrides: Overrides): void;
  setMinter(minter: InvocationMinter): void;
  setRecordFailure(error: Error | undefined): void;
  setDeclareFailure(error: Error | undefined): void;
  setReleaseFailure(error: Error | undefined): void;
  /** Answers every projection await; resolves at once by default. */
  setConfirm(confirm: () => Promise<void>): void;
}

/** A gateway stand-in whose catch-all forwards to `service` with the current overrides. */
async function startHarness(service: () => HttpDouble): Promise<Harness> {
  const minted: InvocationTarget[] = [];
  const recorded: Harness['recorded'] = [];
  const declared: Harness['declared'] = [];
  const released: Harness['released'] = [];
  const confirmations: Confirmation[] = [];
  const logs: LogLine[] = [];
  let settledCount = 0;
  let overrides: Overrides = {};
  let recordFailure: Error | undefined;
  let declareFailure: Error | undefined;
  let releaseFailure: Error | undefined;
  let confirm: () => Promise<void> = () => Promise.resolve();
  let minter: InvocationMinter = {
    async headersFor(target) {
      minted.push(target);
      return { 'X-Serverless-Authorization': `Bearer inv-${target.name}` };
    },
  };

  const app = Fastify({
    genReqId: () => REQUEST_ID,
    logger: { level: 'warn', stream: { write: (line: string) => logs.push(JSON.parse(line) as LogLine) } },
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
        async declare(sessionId, owner) {
          if (declareFailure !== undefined) throw declareFailure;
          declared.push([sessionId, owner, service().requests.length]);
        },
        async record(sessionId, positions, declaredOwner) {
          if (recordFailure !== undefined) throw recordFailure;
          recorded.push(declaredOwner === undefined ? [sessionId, positions] : [sessionId, positions, declaredOwner]);
        },
        async release(sessionId, owner) {
          if (releaseFailure !== undefined) throw releaseFailure;
          released.push([sessionId, owner]);
        },
        awaitPositions(positions) {
          confirmations.push(['positions', positions]);
          return confirm();
        },
        awaitOwners(owners) {
          confirmations.push(['owners', [...owners]]);
          return confirm();
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
    declared,
    released,
    confirmations,
    logs,
    settled: () => settledCount,
    set(next) {
      overrides = next;
      settledCount = 0;
      minted.length = 0;
      recorded.length = 0;
      declared.length = 0;
      released.length = 0;
      confirmations.length = 0;
      logs.length = 0;
    },
    setMinter(next) {
      minter = next;
    },
    setRecordFailure(error) {
      recordFailure = error;
    },
    setDeclareFailure(error) {
      declareFailure = error;
    },
    setReleaseFailure(error) {
      releaseFailure = error;
    },
    setConfirm(next) {
      confirm = next;
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
  harness.setDeclareFailure(undefined);
  harness.setReleaseFailure(undefined);
  harness.setConfirm(() => Promise.resolve());
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

  const unconfirmed: Array<[string, string, Error | undefined, Confirmation]> = [
    ['a failed record', 'people=42,identity=41', new Error('database down'), ['positions', new Map([['people', '42'], ['identity', '41']])]],
    ['a malformed header', ' identity=x, identity=4,,', undefined, ['owners', ['identity', 'people']]],
  ];

  it.each(unconfirmed)('logs %s at error and releases the response only once legacy confirmed it', async (_label, value, failure, expected) => {
    service.setHandler((_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': value }));
    harness.set({ sessionId: SESSION_ID });
    harness.setRecordFailure(failure);
    let confirmed!: () => void;
    harness.setConfirm(
      () =>
        new Promise<void>((resolve) => {
          confirmed = resolve;
        }),
    );
    let answered = false;
    const pending = harness.app.inject({ method: 'POST', url: '/v1/people' }).then((res) => {
      answered = true;
      return res;
    });
    await vi.waitFor(() => expect(harness.confirmations).toEqual([expected]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    confirmed();
    const res = await pending;
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(harness.recorded).toEqual([]);
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'target write position not recorded')).toBe(true);
  });

  it.each(unconfirmed)('answers %s legacy cannot confirm with the legacy 503', async (_label, value, failure, expected) => {
    service.setHandler((_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': value, 'x-up': '1' }));
    harness.set({ sessionId: SESSION_ID });
    harness.setRecordFailure(failure);
    harness.setConfirm(() => Promise.reject(new BarrierTimeoutError(value, new Error('migration unavailable'))));
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailableResponse({ method: API.method, params: API.params }).body);
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(res.headers['x-up']).toBeUndefined();
    expect(harness.confirmations).toEqual([expected]);
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'target response failed')).toBe(true);
    await expectSettledOnce(harness);
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

  it('passes the upstream status and headers to beforeSend and answers the legacy 503 without its cookies when it rejects', async () => {
    const upstreams: TargetUpstream[] = [];
    const deletion = 'JSESSIONID=;expires=Thu, 01-Jan-1970 00:00:00 GMT;path=/;';
    service.setHandler((_req, res) =>
      sendJson(res, 200, { data: 'out' }, { 'set-cookie': [deletion, 'a=1'], 'x-opt2-write-position': 'people=3' }),
    );
    harness.set({
      sessionId: SESSION_ID,
      mapSetCookies: async (cookies) => cookies,
      beforeSend: async (upstream) => {
        upstreams.push(upstream);
        throw new Error('invalidation failed');
      },
    });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/?muraAction=cLogin.logout' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailableResponse({ method: API.method, params: API.params }).body);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-opt2-write-position']).toBeUndefined();
    expect(upstreams[0]?.statusCode).toBe(200);
    expect(upstreams[0]?.headers['set-cookie']).toEqual([deletion, 'a=1']);
    expect(upstreams[0]?.headers['x-opt2-write-position']).toBe('people=3');
    expect(harness.recorded).toEqual([[SESSION_ID, new Map([['people', '3']])]]);
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'target forward beforeSend failed')).toBe(true);
    await expectSettledOnce(harness);
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
    harness.set({ failContext: surface === 'api' ? API : ADMIN, sessionId: SESSION_ID, declaresWrite: true });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    await expectFailClosed(res, surface);
    expect(res.headers['x-up']).toBeUndefined();
    expect(harness.recorded).toEqual([]);
    expect(harness.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(harness.released).toEqual([]);
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

  it.each([
    ['stalls past the call timeout', false],
    ['receives the write, stalls past the call timeout, then commits it', true],
  ])(
    'answers a service that %s with the legacy 503 and keeps the in-flight registration',
    { timeout: 25_000 },
    async (_label, commits) => {
      let committed!: () => void;
      const commit = new Promise<void>((resolve) => {
        committed = resolve;
      });
      service.setHandler(async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        committed();
        if (commits) sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': 'people=77' });
      });
      harness.set({ sessionId: SESSION_ID, declaresWrite: true });
      const started = Date.now();
      const res = await harness.app.inject({ method: 'POST', url: '/v1/people', payload: 'name=late' });
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(res.statusCode).toBe(503);
      expect(res.body).toBe(apiUnavailable.body);
      expect(service.requests).toHaveLength(1);
      await commit;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(harness.settled()).toBe(0);
      expect(harness.recorded).toEqual([]);
      expect(harness.declared).toEqual([[SESSION_ID, 'people', 0]]);
      expect(harness.released).toEqual([]);
      const uncertain = harness.logs.filter((line) => line.msg === 'target exchange ended uncertainly; in-flight registration kept');
      expect(uncertain.map((line) => line.level)).toEqual([40]);
      expect(Object.keys(uncertain[0]?.error as object).sort()).toEqual(expect.arrayContaining(['message', 'type']));
    },
  );

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

describe('forwardToTarget settles only a target response that completed', () => {
  const UNCERTAIN = 'target exchange ended uncertainly; in-flight registration kept';

  /** What one client of a listening gateway received. */
  interface ClientOutcome {
    status: number | undefined;
    body: Buffer;
    /** False when the response was cut before its end. */
    complete: boolean;
  }

  /** Sends one POST to `port` on its own connection; `onData` runs on each response chunk. */
  function send(port: number, onData?: (req: ClientRequest) => void): { req: ClientRequest; outcome: Promise<ClientOutcome> } {
    const chunks: Buffer[] = [];
    let status: number | undefined;
    let finish: (complete: boolean) => void = () => undefined;
    const outcome = new Promise<ClientOutcome>((resolve) => {
      let done = false;
      finish = (complete) => {
        if (done) return;
        done = true;
        resolve({ status, body: Buffer.concat(chunks), complete });
      };
    });
    const req = httpRequest({ host: '127.0.0.1', port, path: '/v1/people', method: 'POST', agent: false }, (res) => {
      status = res.statusCode;
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        onData?.(req);
      });
      res.once('end', () => finish(true));
      res.once('error', () => finish(false));
      res.once('close', () => finish(res.complete));
    });
    req.once('error', () => finish(false));
    req.end('name=held');
    return { req, outcome };
  }

  /** A listening harness over `target`, closed by `stop`. */
  async function listening(target: HttpDouble): Promise<{ h: Harness; port: number }> {
    const h = await startHarness(() => target);
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    return { h, port: (h.app.server.address() as AddressInfo).port };
  }

  it('keeps the exchange unsettled when the target resets after its headers and part of its body', async () => {
    const target = await startHttpDouble(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      res.write(Buffer.alloc(100, 0x61));
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.socket?.destroy();
    });
    const { h, port } = await listening(target);
    try {
      const outcome = await send(port).outcome;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(outcome.status).toBe(200);
      expect(outcome.complete).toBe(false);
      expect(outcome.body.length).toBeLessThan(1000);
      expect(h.settled()).toBe(0);
      const uncertain = h.logs.filter((line) => line.msg === UNCERTAIN);
      expect(uncertain.map((line) => line.level)).toEqual([40]);
      expect(uncertain[0]?.error).toMatchObject({ type: expect.any(String), message: expect.any(String) });
    } finally {
      await h.app.close();
      await target.close();
    }
  });

  it.each(['the target received the request', 'the first byte arrived'])(
    'settles once, only after the target ended, when the client went away once %s',
    async (moment) => {
      let received!: () => void;
      const arrived = new Promise<void>((resolve) => {
        received = resolve;
      });
      let ended = false;
      const target = await startHttpDouble(async (_req, res) => {
        received();
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Chunked, so the response ends with `res.end()` rather than with its last counted byte.
        res.writeHead(200, { 'content-type': 'text/plain' });
        for (let sent = 0; sent < 8; sent += 1) {
          res.write(Buffer.alloc(1024, 0x61));
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        ended = true;
        res.end();
      });
      const { h, port } = await listening(target);
      const endedAtSettle: boolean[] = [];
      h.set({
        onSettled: async () => {
          endedAtSettle.push(ended);
        },
      });
      try {
        const firstByte = moment === 'the first byte arrived';
        const client = send(port, firstByte ? (req) => req.destroy() : undefined);
        if (!firstByte) {
          await arrived;
          client.req.destroy();
        }
        expect((await client.outcome).complete).toBe(false);
        await vi.waitFor(() => expect(endedAtSettle).toHaveLength(1), { timeout: 3000 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(endedAtSettle).toEqual([true]);
        expect(h.logs.filter((line) => line.msg === UNCERTAIN)).toEqual([]);
      } finally {
        await h.app.close();
        await target.close();
      }
    },
  );
});

describe('forwardToTarget write declaration', () => {
  const apiUnavailable = apiUnavailableResponse({ method: API.method, params: API.params });
  const WITH_POSITION: DoubleHandler = (_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': 'people=42' });

  it('declares the write before the service receives it and ends the declaration with the recorded positions', async () => {
    service.setHandler(WITH_POSITION);
    harness.set({ sessionId: SESSION_ID, declaresWrite: true });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(201);
    expect(harness.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(harness.recorded).toEqual([[SESSION_ID, new Map([['people', '42']]), 'people']]);
    expect(harness.released).toEqual([]);
  });

  const MALFORMED: DoubleHandler = (_req, res) => sendJson(res, 201, {}, { 'x-opt2-write-position': 'people=x' });
  const unconfirmable = (): Promise<void> => Promise.reject(new BarrierTimeoutError('owners:people', new Error('migration unavailable')));

  it.each<{
    label: string;
    handler: DoubleHandler;
    overrides: Overrides;
    recordFailure?: Error;
    confirm?: () => Promise<void>;
    status: number;
    releases: boolean;
  }>([
    { label: 'a response without a write position', handler: (_req, res) => sendJson(res, 200, {}), overrides: {}, status: 200, releases: true },
    {
      label: 'an unrecorded write position legacy confirmed',
      handler: WITH_POSITION,
      overrides: {},
      recordFailure: new Error('database down'),
      status: 201,
      releases: true,
    },
    { label: 'a malformed write position legacy confirmed', handler: MALFORMED, overrides: {}, status: 201, releases: true },
    {
      label: 'an unrecorded write position legacy cannot confirm',
      handler: WITH_POSITION,
      overrides: {},
      recordFailure: new Error('database down'),
      confirm: unconfirmable,
      status: 503,
      releases: false,
    },
    { label: 'a malformed write position legacy cannot confirm', handler: MALFORMED, overrides: {}, confirm: unconfirmable, status: 503, releases: false },
    {
      label: 'a response the gateway fails closed',
      handler: (_req, res) => sendJson(res, 200, {}),
      overrides: { mapSetCookies: () => Promise.reject(new Error('jar unavailable')) },
      status: 503,
      releases: false,
    },
  ])('$label answers $status and releases the declaration: $releases', async ({ handler, overrides, recordFailure, confirm, status, releases }) => {
    service.setHandler(handler);
    harness.set({ sessionId: SESSION_ID, declaresWrite: true, ...overrides });
    harness.setRecordFailure(recordFailure);
    if (confirm !== undefined) harness.setConfirm(confirm);
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(status);
    await expectSettledOnce(harness);
    expect(harness.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(harness.released).toEqual(releases ? [[SESSION_ID, 'people']] : []);
    expect(harness.recorded).toEqual([]);
  });

  it.each<[string, Overrides]>([
    ['web', { service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/update' }],
    ['a request without a session', { sessionId: undefined }],
  ])('declares nothing for %s', async (_label, overrides) => {
    harness.set({ sessionId: SESSION_ID, declaresWrite: true, ...overrides });
    await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(service.requests).toHaveLength(1);
    expect(harness.declared).toEqual([]);
    expect(harness.released).toEqual([]);
  });

  it('still answers the response when its declaration cannot be released', async () => {
    harness.set({ sessionId: SESSION_ID, declaresWrite: true });
    harness.setReleaseFailure(new Error('database down'));
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: 'ok' });
    expect(harness.logs.filter((line) => line.msg === 'target write declaration not released').map((line) => line.level)).toEqual([50]);
  });

  it('answers a failed declaration with the legacy 503 without calling the service', async () => {
    harness.set({ sessionId: SESSION_ID, declaresWrite: true });
    harness.setDeclareFailure(new Error('database down'));
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailable.body);
    expect(service.requests).toHaveLength(0);
    expect(harness.released).toEqual([]);
    expect(harness.logs.filter((line) => line.msg === 'target write declaration failed').map((line) => line.level)).toEqual([50]);
    await expectSettledOnce(harness);
  });

  it.each(['the connection is refused', 'reply-from rejects the path'])(
    'releases the declaration of a request the service never received when %s',
    async (label) => {
      const closed = await startHttpDouble((_req, res) => sendBytes(res, 200, 'never'));
      await closed.close();
      const refused = label === 'the connection is refused';
      const h = refused ? await startHarness(() => closed) : harness;
      try {
        h.set({ sessionId: SESSION_ID, declaresWrite: true, ...(refused ? {} : { path: '/v1/%2e%2e/secret' }) });
        const res = await h.app.inject({ method: 'POST', url: '/v1/people' });
        expect(res.statusCode).toBe(503);
        expect(res.body).toBe(apiUnavailable.body);
        await vi.waitFor(() => expect(h.released).toEqual([[SESSION_ID, 'people']]));
        expect(h.declared).toEqual([[SESSION_ID, 'people', 0]]);
        await expectSettledOnce(h);
      } finally {
        if (refused) await h.app.close();
      }
    },
  );
});

describe('forwardToTarget logs failures through serializeError', () => {
  const SECRET = 'CFID=s3cr3t-value';

  it.each<[string, (failure: Error) => void]>([
    [
      'invocation credential for target forward failed',
      (failure) =>
        harness.setMinter({
          headersFor: () => Promise.reject(failure),
        }),
    ],
    ['target response failed', (failure) => harness.set({ mapSetCookies: () => Promise.reject(failure) })],
    ['target forward onSettled failed', (failure) => harness.set({ onSettled: () => Promise.reject(failure) })],
    ['target forward beforeSend failed', (failure) => harness.set({ beforeSend: () => Promise.reject(failure) })],
    [
      'target write declaration failed',
      (failure) => {
        harness.set({ sessionId: SESSION_ID, declaresWrite: true });
        harness.setDeclareFailure(failure);
      },
    ],
    [
      'target write declaration not released',
      (failure) => {
        harness.set({ sessionId: SESSION_ID, declaresWrite: true });
        harness.setReleaseFailure(failure);
      },
    ],
    [
      'target write position not recorded',
      (failure) => {
        service.setHandler((_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': 'people=42' }));
        harness.set({ sessionId: SESSION_ID });
        harness.setRecordFailure(failure);
      },
    ],
  ])('logs %s with the serialized error only', async (message, fail) => {
    const failure = new Error(SECRET);
    fail(failure);
    await harness.app.inject({ method: 'POST', url: '/v1/people' });
    await vi.waitFor(() => expect(harness.logs.some((line) => line.msg === message)).toBe(true));
    const line = harness.logs.find((record) => record.msg === message);
    expect(line?.level).toBe(50);
    expect(line?.error).toEqual(serializeError(failure));
    expect(JSON.stringify(harness.logs)).not.toContain('s3cr3t');
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
