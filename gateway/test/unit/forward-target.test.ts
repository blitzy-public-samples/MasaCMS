// Tests forwardToTarget against loopback stand-ins for a service and web: request headers, body, responses and fail closed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import replyFrom from '@fastify/reply-from';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stripInboundAuthHeaders, type InvocationMinter, type InvocationTarget } from '@opt2/platform/auth';
import {
  LEGACY_ERROR_PAGE_HTML,
  LEGACY_HTML_CONTENT_TYPE,
  apiUnavailableResponse,
  legacyHeaders,
} from '@opt2/platform/legacy-compat';
import { createLogger, fastifyLoggerOptions, serializeError, validateLogRecord, type Logger } from '@opt2/platform/logging';
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
import {
  TARGET_FORWARD_TIMEOUT_MS,
  forwardToTarget,
  type TargetForwardContext,
  type TargetUpstream,
} from '../../src/dispatcher/forward-target.js';
import { replyFromOptions } from '../../src/dispatcher/response-head.js';
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
const API: FailContext = { surface: 'api', method: 'findOne', params: { siteid: 'default' }, route: 'api:content.findone' };
const ADMIN: FailContext = { surface: 'admin' };
// forwardToTarget's lines other than fail-closed ones, naming the harness's default callee and session mode.
const NOT_RECORDED = 'target write position from people (target-primary) not recorded';
const NOT_RELEASED = 'target write declaration for people (target-primary) not released';
const SETTLE_FAILED = 'target forward to people (target-primary) onSettled failed';
const UNCERTAIN = 'target exchange with people (target-primary) ended uncertainly; in-flight registration kept';
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

/**
 * A gateway stand-in whose catch-all forwards to `service` through `forwardTo` with the current overrides; `logger` replaces the
 * `logs` capture, and `gatewayAgent` forwards through the gateway's own reply-from dispatcher.
 */
async function startHarness(
  service: () => HttpDouble,
  {
    logger,
    forwardTo = forwardToTarget,
    gatewayAgent = false,
  }: { logger?: Logger; forwardTo?: typeof forwardToTarget; gatewayAgent?: boolean } = {},
): Promise<Harness> {
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

  const app =
    logger === undefined
      ? Fastify({
          genReqId: () => REQUEST_ID,
          logger: { level: 'warn', stream: { write: (line: string) => logs.push(JSON.parse(line) as LogLine) } },
        })
      : Fastify({
          genReqId: () => REQUEST_ID,
          // This package's own LogController: Fastify checks it by instanceof, and the platform's resolves another copy.
          loggerInstance: fastifyLoggerOptions(logger).loggerInstance,
          logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
        });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  await app.register(replyFrom, gatewayAgent ? replyFromOptions() : {});

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
    return traced ? withExtractedContext(ACTIVE_TRACE, () => forwardTo(request, reply, ctx)) : forwardTo(request, reply, ctx);
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

  it('passes a page-mode 302 through with its Location, cache headers and ordered cookies', async () => {
    const cookies = ['rb=;path=/;HttpOnly;SameSite=Lax;', 'ADMINCONTROLWIDTH=300;path=/;', 'ADMINSIDEBAR=off;path=/;'];
    service.setHandler((_req, res) =>
      sendBytes(res, 302, '', {
        location: './?muraAction=cLogin.main&returnURL=%2Fadmin%2F',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'set-cookie': cookies,
      }),
    );
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/list?muraAction=cUsers.list' });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/?muraAction=cUsers.list' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('./?muraAction=cLogin.main&returnURL=%2Fadmin%2F');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers['set-cookie']).toEqual(cookies);
  });

  it.each<{ label: string; cacheHeaders: Record<string, string>; expected: string | undefined }>([
    {
      label: "Next's own Cache-Control",
      cacheHeaders: { 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' },
      expected: undefined,
    },
    {
      label: "the full layout's Cache-Control and Expires",
      cacheHeaders: { 'cache-control': 'no-cache, no-store, must-revalidate', expires: '06 Nov 1994 08:37:34 GMT' },
      expected: 'no-cache, no-store, must-revalidate',
    },
  ])('answers a page 200 carrying $label with Cache-Control $expected', async ({ cacheHeaders, expected }) => {
    service.setHandler((_req, res) => sendBytes(res, 200, '<html></html>', { ...webHeaders, ...cacheHeaders }));
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/list?muraAction=cUsers.list' });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/?muraAction=cUsers.list' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(expected);
  });

  it('forwards /_next/ assets with their headers in both directions', async () => {
    service.setHandler((_req, res) => sendBytes(res, 200, 'js', { 'content-type': 'application/javascript', 'x-nextjs-cache': 'HIT' }));
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/_next/static/chunk.js' });
    const res = await harness.app.inject({ method: 'GET', url: '/_next/static/chunk.js', headers: { rsc: '1' } });
    expect(only(service).headers.rsc).toBe('1');
    expect(res.headers['x-nextjs-cache']).toBe('HIT');
    expect(res.headers['content-type']).toBe('application/javascript');
  });

  it("passes a web 500 through with web's body and legacy headers", async () => {
    service.setHandler((_req, res) => sendBytes(res, 500, LEGACY_ERROR_PAGE_HTML, { 'content-type': LEGACY_HTML_CONTENT_TYPE }));
    harness.set({ service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/list' });
    const res = await harness.app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(LEGACY_ERROR_PAGE_HTML);
    expect(res.headers['content-type']).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(res.headers.generator).toBe(legacyHeaders().Generator);
    expect(harness.logs.filter((line) => line.msg.startsWith('fail-closed'))).toEqual([]);
    await expectSettledOnce(harness);
  });
});

describe('forwardToTarget reason phrase', () => {
  /** Status line and body one client of `port` receives for `GET /admin/`. */
  function statusLineOf(port: number): Promise<{ status: number | undefined; reason: string | undefined; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/admin/', method: 'GET', agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => resolve({ status: res.statusCode, reason: res.statusMessage, body: Buffer.concat(chunks).toString('utf8') }));
        res.once('error', reject);
      });
      req.once('error', reject);
      req.end();
    });
  }

  const WEB: Overrides = { service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/cusers/list' };

  // A UTF-8 phrase as the status line carries it: Node writes and reads the line's bytes as latin1.
  const UTF8_PHRASE = Buffer.from('Fehler \u00e9', 'utf8').toString('latin1');

  it.each<{ label: string; overrides: Overrides; status: number; sent: string; reason: string; body: string }>([
    { label: "web's legacy error page", overrides: WEB, status: 500, sent: 'An Error Occurred', reason: 'An Error Occurred', body: LEGACY_ERROR_PAGE_HTML },
    { label: "a service's legacy 500", overrides: {}, status: 500, sent: 'An Error Occurred', reason: 'An Error Occurred', body: '{}' },
    { label: 'a service 404 with its own phrase', overrides: {}, status: 404, sent: 'Nothing Here', reason: 'Nothing Here', body: '' },
    { label: 'a UTF-8 phrase, byte for byte', overrides: {}, status: 500, sent: UTF8_PHRASE, reason: UTF8_PHRASE, body: '{}' },
    { label: 'an empty phrase', overrides: {}, status: 500, sent: '', reason: 'Internal Server Error', body: '{}' },
    { label: "web's page redirect, rewritten to 302", overrides: WEB, status: 307, sent: 'Temporary Redirect', reason: 'Found', body: '' },
  ])('answers $label over the socket with reason "$reason"', async ({ overrides, status, sent, reason, body }) => {
    const target = await startHttpDouble((_req, res) => {
      res.writeHead(status, sent, status === 307 ? { location: '/admin/?muraAction=cusers.list' } : {});
      res.end(body);
    });
    const h = await startHarness(() => target, { gatewayAgent: true });
    try {
      h.set(overrides);
      await h.app.listen({ host: '127.0.0.1', port: 0 });
      const answered = await statusLineOf((h.app.server.address() as AddressInfo).port);
      expect(answered).toEqual({ status: status === 307 ? 302 : status, reason, body });
      expect(h.logs.filter((line) => line.msg.startsWith('fail-closed'))).toEqual([]);
    } finally {
      await h.app.close();
      await target.close();
    }
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
    expect(harness.logs.some((line) => line.level === 50 && line.msg === NOT_RECORDED)).toBe(true);
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
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'fail-closed: people response failed')).toBe(true);
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

  it.each<{ label: string; ctx: Overrides; status: number; upstream: Record<string, string>; expected: string | undefined }>([
    { label: 'a service 200 when identity is negotiated', ctx: { identityEncoding: true }, status: 200, upstream: {}, expected: 'identity' },
    { label: 'a service 500 when identity is negotiated', ctx: { identityEncoding: true }, status: 500, upstream: {}, expected: 'identity' },
    {
      label: 'a service response naming its own encoding',
      ctx: { identityEncoding: true },
      status: 200,
      upstream: { 'content-encoding': 'gzip' },
      expected: 'gzip',
    },
    { label: 'a service 200 when identity is not negotiated', ctx: {}, status: 200, upstream: {}, expected: undefined },
    {
      label: 'a page-mode 302 when identity is negotiated',
      ctx: { identityEncoding: true, service: 'web', isWeb: true, failContext: ADMIN, path: '/admin/home/redirect' },
      status: 307,
      upstream: { location: '/admin/?muraAction=cLogin.main' },
      expected: 'identity',
    },
    { label: 'the legacy 503 of an unavailable service', ctx: { identityEncoding: true }, status: 503, upstream: {}, expected: undefined },
  ])('answers $label with Content-Encoding $expected', async ({ ctx, status, upstream, expected }) => {
    service.setHandler((_req, res) => sendBytes(res, status, '', upstream));
    harness.set(ctx);
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.headers['content-encoding']).toBe(expected);
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
    expect(harness.logs.some((line) => line.level === 50 && line.msg === 'fail-closed: people response withheld: beforeSend failed')).toBe(true);
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

  it.each(
    ([502, 503, 504] as const).flatMap((status) =>
      (['api', 'admin'] as const).flatMap((surface) =>
        [true, false].map((positioned) => ({ status, surface, positioned, ends: positioned ? 'records its position' : 'releases it' })),
      ),
    ),
  )('answers a declared write the service answers $status on the $surface surface with the legacy 503 and $ends', async ({ status, surface, positioned }) => {
    const position: Record<string, string> = positioned ? { 'x-opt2-write-position': 'people=9' } : {};
    service.setHandler((_req, res) => {
      sendBytes(res, status, 'upstream', { ...position, 'x-up': '1' });
    });
    harness.set({ failContext: surface === 'api' ? API : ADMIN, sessionId: SESSION_ID, declaresWrite: true });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    await expectFailClosed(res, surface);
    expect(res.headers['x-up']).toBeUndefined();
    expect(harness.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(harness.recorded).toEqual(positioned ? [[SESSION_ID, new Map([['people', '9']]), 'people']] : []);
    expect(harness.released).toEqual(positioned ? [] : [[SESSION_ID, 'people']]);
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

  it("bounds a forward by the owner's 30 s gate wait plus the 10 s call bound", () => {
    expect(TARGET_FORWARD_TIMEOUT_MS).toBe(40_000);
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

  it.each<{ label: string; path: string; base: string; received: string }>([
    {
      label: 'an encoded backslash item closing with ..',
      path: '/legacy-fixtures/cfml/api.cfm/finance/records/x%5C../versions?siteid=tenant-a',
      base: '/',
      received: '/legacy-fixtures/cfml/api.cfm/finance/records/x%5C../versions?siteid=tenant-a',
    },
    {
      label: 'an item closing with ..',
      path: '/legacy-fixtures/cfml/api.cfm/finance/records/x../versions',
      base: '/',
      received: '/legacy-fixtures/cfml/api.cfm/finance/records/x../versions',
    },
    {
      label: "an item closing with .. after the callee's base path",
      path: '/legacy-fixtures/cfml/api.cfm/finance/records/x../versions?a=%2e%2e',
      base: '/svc//',
      received: '/svc/legacy-fixtures/cfml/api.cfm/finance/records/x../versions?a=%2e%2e',
    },
  ])('sends a raw target with $label byte for byte, past what reply-from rejects', async ({ path, base, received }) => {
    const raw = await startHarness(() => service, { gatewayAgent: true });
    try {
      raw.set({ path, rawTarget: true, serviceUrl: `${service.url}${base}` });
      const res = await raw.app.inject({ method: 'GET', url: '/v1/notes' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: 'ok' });
      expect(only(service).url).toBe(received);
      expect(raw.logs.filter((line) => line.msg.startsWith('fail-closed'))).toEqual([]);
      await expectSettledOnce(raw);
    } finally {
      await raw.app.close();
    }
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

describe('forwardToTarget fail-closed line', () => {
  it.each<[string, number | 'refused', Overrides, string, boolean]>([
    ['a refused connection', 'refused', {}, 'fail-closed: people unavailable', true],
    ['a service 502', 502, {}, 'fail-closed: people unavailable: answered 502', false],
    ['a service 503', 503, {}, 'fail-closed: people unavailable: answered 503', false],
    ['a service 504', 504, {}, 'fail-closed: people unavailable: answered 504', false],
    ...([502, 503, 504] as const).map((status): [string, number, Overrides, string, boolean] => [
      `a web ${status}`,
      status,
      { service: 'web', isWeb: true, path: '/admin/cusers/list' },
      `fail-closed: web unavailable: answered ${status}`,
      false,
    ]),
  ])('logs %s as one ERROR line naming the owner, the route key and the 503', async (_case, failure, overrides, message, hasError) => {
    let h = harness;
    if (failure === 'refused') {
      const closed = await startHttpDouble((_req, res) => sendBytes(res, 200, 'never'));
      await closed.close();
      h = await startHarness(() => closed);
    } else {
      service.setHandler((_req, res) => sendBytes(res, failure, 'upstream'));
    }
    try {
      h.set(overrides);
      const res = await h.app.inject({ method: 'GET', url: '/v1/notes' });
      expect(res.statusCode).toBe(503);
      const lines = h.logs.filter((line) => line.msg.startsWith('fail-closed'));
      expect(lines).toEqual([
        expect.objectContaining({ level: 50, msg: message, route: API.route, httpMethod: 'GET', statusCode: 503 }),
      ]);
      if (hasError) expect(lines[0]?.error).toMatchObject({ type: expect.any(String), message: expect.any(String) });
      else expect(lines[0]).not.toHaveProperty('error');
    } finally {
      if (failure === 'refused') await h.app.close();
    }
  });
});

describe('forwardToTarget settles only a target response that completed', () => {
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
    expect(harness.logs.filter((line) => line.msg === NOT_RELEASED).map((line) => line.level)).toEqual([50]);
  });

  it('answers a failed declaration with the legacy 503 without calling the service', async () => {
    harness.set({ sessionId: SESSION_ID, declaresWrite: true });
    harness.setDeclareFailure(new Error('database down'));
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailable.body);
    expect(service.requests).toHaveLength(0);
    expect(harness.released).toEqual([]);
    expect(harness.logs.filter((line) => line.msg === 'fail-closed: write declaration for people failed').map((line) => line.level)).toEqual([50]);
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
      'fail-closed: invocation credential for people failed',
      (failure) =>
        harness.setMinter({
          headersFor: () => Promise.reject(failure),
        }),
    ],
    ['fail-closed: people response failed', (failure) => harness.set({ mapSetCookies: () => Promise.reject(failure) })],
    [SETTLE_FAILED, (failure) => harness.set({ onSettled: () => Promise.reject(failure) })],
    ['fail-closed: people response withheld: beforeSend failed', (failure) => harness.set({ beforeSend: () => Promise.reject(failure) })],
    [
      'fail-closed: write declaration for people failed',
      (failure) => {
        harness.set({ sessionId: SESSION_ID, declaresWrite: true });
        harness.setDeclareFailure(failure);
      },
    ],
    [
      NOT_RELEASED,
      (failure) => {
        harness.set({ sessionId: SESSION_ID, declaresWrite: true });
        harness.setReleaseFailure(failure);
      },
    ],
    [
      NOT_RECORDED,
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
    expect(line).not.toHaveProperty('service');
    expect(line).not.toHaveProperty('sessionMode');
    expect(JSON.stringify(harness.logs)).not.toContain('s3cr3t');
  });
});

describe('forwardToTarget lines through the platform logger', () => {
  const chunks: string[] = [];
  let platformHarness: Harness;

  beforeAll(async () => {
    const destination = { write: (chunk: string) => void chunks.push(chunk) };
    platformHarness = await startHarness(() => service, {
      logger: createLogger({ service: 'gateway', version: '1.0.0', env: 'local', level: 'warn', destination }),
    });
  });

  afterEach(() => {
    chunks.length = 0;
    platformHarness.set({});
    platformHarness.setRecordFailure(undefined);
    platformHarness.setReleaseFailure(undefined);
  });

  afterAll(async () => {
    await platformHarness.app.close();
  });

  /** Every record written so far. */
  const records = (): Array<Record<string, unknown>> =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const FINANCE: Overrides = { service: 'finance', mode: 'legacy-primary', sessionId: SESSION_ID };

  it.each<[string, (h: Harness, failure: Error) => void]>([
    ['target forward to finance (legacy-primary) onSettled failed', (h, failure) => h.set({ ...FINANCE, onSettled: () => Promise.reject(failure) })],
    [
      'target write declaration for finance (legacy-primary) not released',
      (h, failure) => {
        h.set({ ...FINANCE, declaresWrite: true });
        h.setReleaseFailure(failure);
      },
    ],
    [
      'target write position from finance (legacy-primary) not recorded',
      (h, failure) => {
        service.setHandler((_req, res) => sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': 'finance=42' }));
        h.set(FINANCE);
        h.setRecordFailure(failure);
      },
    ],
  ])('writes `%s` as a log-record.v1 ERROR line naming the callee and session mode', async (message, fail) => {
    const failure = new Error('store down');
    fail(platformHarness, failure);
    await platformHarness.app.inject({ method: 'POST', url: '/v1/finance' });
    await vi.waitFor(() => expect(records().some((record) => record.message === message)).toBe(true));
    for (const record of records()) expect(validateLogRecord(record), JSON.stringify(record)).toStrictEqual({ valid: true, errors: [] });
    expect(records().find((record) => record.message === message)).toMatchObject({
      severity: 'ERROR',
      service: 'gateway',
      requestId: REQUEST_ID,
      error: serializeError(failure),
    });
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
  const [, ACTIVE_TRACE_ID, ACTIVE_SPAN_ID] = ACTIVE_TRACE.traceparent.split('-');
  let side: HttpDouble;

  /** Exported client spans of the active trace; a span still open is not among them. */
  async function activeClientSpans(): Promise<ReturnType<MemorySpanExporter['getFinishedSpans']>> {
    await flushTracing();
    return exporter
      .getFinishedSpans()
      .filter((span) => span.kind === SpanKind.CLIENT && span.spanContext().traceId === ACTIVE_TRACE_ID);
  }

  beforeAll(async () => {
    await startTracing({ serviceName: 'gateway-forward-target-test', version: '1.0.0', exporter });
    side = await startHttpDouble((_req, res) => {
      sendBytes(res, 200, 'side');
    });
  });

  afterEach(() => {
    exporter.reset();
    side.clearRequests();
  });

  afterAll(async () => {
    await side.close();
    await shutdownTracing();
  });

  it.each([
    ['people', false],
    ['web', true],
  ] as const)(
    'sends one traceparent, from the client span `GET %s` started under the active context',
    async (callee, isWeb) => {
      expect(channel('undici:request:create').hasSubscribers).toBe(true);
      harness.set({ traced: true, service: callee, isWeb });
      await harness.app.inject({
        method: 'GET',
        url: '/v1/notes?token=s3cr3t',
        headers: { traceparent: INBOUND_TRACEPARENT },
      });
      const received = only(service);
      const traceparents = rawValues(received, 'traceparent');
      expect(traceparents).toHaveLength(1);
      const [, traceId, parentId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparents[0] ?? '') ?? [];
      expect(traceId).toBe(ACTIVE_TRACE_ID);
      expect(rawValues(received, 'tracestate')).toEqual([ACTIVE_TRACE.tracestate]);

      const clients = await activeClientSpans();
      expect(clients.map((span) => span.name)).toEqual([`GET ${callee}`]);
      expect(clients[0]?.spanContext().spanId).toBe(parentId);
      expect(clients[0]?.parentSpanContext?.spanId).toBe(ACTIVE_SPAN_ID);
    },
  );

  it('runs its hooks outside the callee context, so the calls they make keep their own names', async () => {
    const call = async (hook: string): Promise<void> => {
      await (await fetch(`${side.url}/${hook}`)).arrayBuffer();
    };
    harness.set({
      traced: true,
      mapSetCookies: async (setCookies) => {
        await call('mapSetCookies');
        return setCookies;
      },
      beforeSend: () => call('beforeSend'),
      onSettled: () => call('onSettled'),
    });
    const res = await harness.app.inject({ method: 'POST', url: '/v1/people', payload: 'name=a' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(async () => {
      expect(await activeClientSpans()).toHaveLength(4);
    });

    const names = Object.fromEntries((await activeClientSpans()).map((span) => [String(span.attributes['url.path']), span.name]));
    expect(names).toEqual({ '/v1/people': 'POST people', '/mapSetCookies': 'GET', '/beforeSend': 'GET', '/onSettled': 'GET' });
  });

  it.each([
    ['answers a GET 503', 503],
    ['refuses the connection', undefined],
  ] as const)('names the one client span `GET people` of a forward whose service %s', async (_label, status) => {
    const target = await startHttpDouble((_req, res) => {
      sendBytes(res, status ?? 200, 'busy', { 'retry-after': '0' });
    });
    if (status === undefined) await target.close();
    const h = await startHarness(() => target);
    try {
      h.set({ traced: true });
      const res = await h.app.inject({ method: 'GET', url: '/v1/notes' });
      expect(res.statusCode).toBe(503);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const clients = await activeClientSpans();
      expect(clients.map((span) => span.name)).toEqual(['GET people']);
      if (status === undefined) expect(clients[0]?.attributes['error.type']).toBe('ECONNREFUSED');
      else expect(clients[0]?.attributes['http.response.status_code']).toBe(status);
    } finally {
      await h.app.close();
      await target.close();
    }
  });

  it.each<[string, () => void]>([
    [
      'a path reply-from rejects',
      () => {
        harness.set({ traced: true, path: '/v1/%2e%2e/secret' });
      },
    ],
    [
      'an invocation credential that cannot be minted',
      () => {
        harness.set({ traced: true });
        harness.setMinter({ headersFor: () => Promise.reject(new Error('metadata server unreachable')) });
      },
    ],
  ])('starts no client span for a forward refused before sending: %s', async (_label, refuse) => {
    refuse();
    const res = await harness.app.inject({ method: 'GET', url: '/v1/notes' });
    expect(res.statusCode).toBe(503);
    expect(service.requests).toHaveLength(0);
    await expectSettledOnce(harness);
    expect(await activeClientSpans()).toEqual([]);
  });

  it.each([
    ['reads the whole streamed response', false],
    ['goes away after the first streamed byte', true],
  ] as const)('ends the one client span `POST people` once a listening client %s', async (_label, abort) => {
    const target = await startHttpDouble(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      for (let sent = 0; sent < 8; sent += 1) {
        res.write(Buffer.alloc(1024, 0x61));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      res.end();
    });
    const h = await startHarness(() => target);
    await h.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      h.set({ traced: true });
      const received = await new Promise<number>((resolve) => {
        let length = 0;
        const req = httpRequest(
          { host: '127.0.0.1', port: (h.app.server.address() as AddressInfo).port, path: '/v1/people', method: 'POST', agent: false },
          (res) => {
            res.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (abort) req.destroy();
            });
            res.once('end', () => {
              resolve(length);
            });
            res.once('close', () => {
              resolve(length);
            });
          },
        );
        req.once('error', () => {
          resolve(length);
        });
        req.end('name=streamed');
      });
      if (!abort) expect(received).toBe(8 * 1024);

      await vi.waitFor(
        async () => {
          expect(await activeClientSpans()).toHaveLength(1);
        },
        { timeout: 3000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const clients = await activeClientSpans();
      expect(clients.map((span) => span.name)).toEqual(['POST people']);
      expect(clients[0]?.attributes['http.response.status_code']).toBe(200);
    } finally {
      await h.app.close();
      await target.close();
    }
  });
});

describe('forwardToTarget with both terms of its bound shortened', () => {
  const CALL_MS = 1_500;
  const GATE_MS = 2_500;
  const BOUND_MS = CALL_MS + GATE_MS;
  /** undici's fast timers fire up to one 499 ms tick before or after their delay. */
  const TIMER_SLACK_MS = 500;
  /** How long a stalled service holds the write before it may commit, well past the bound and its slack. */
  const STALL_MS = BOUND_MS + 2_000;
  const apiUnavailable = apiUnavailableResponse({ method: API.method, params: API.params });
  let bounded: Harness;

  beforeAll(async () => {
    // Fake timers cannot drive undici's process-wide fast-timer clock, so forwardToTarget is reloaded over shortened terms.
    vi.resetModules();
    vi.doMock('@opt2/platform/service-kit', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@opt2/platform/service-kit')>()),
      SERVICE_CALL_TIMEOUT_MS: CALL_MS,
    }));
    vi.doMock('@opt2/platform/migration-kit', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@opt2/platform/migration-kit')>()),
      GATE_WAIT_MS: GATE_MS,
    }));
    const shortened = await import('../../src/dispatcher/forward-target.js');
    expect(shortened.TARGET_FORWARD_TIMEOUT_MS).toBe(BOUND_MS);
    bounded = await startHarness(() => service, { forwardTo: shortened.forwardToTarget });
  });

  afterEach(() => {
    bounded.set({});
  });

  afterAll(async () => {
    await bounded.app.close();
    vi.doUnmock('@opt2/platform/service-kit');
    vi.doUnmock('@opt2/platform/migration-kit');
    vi.resetModules();
  });

  it.each<{
    label: string;
    status: number;
    headers: Record<string, string>;
    body: string;
    recorded: Harness['recorded'];
    released: Harness['released'];
  }>([
    {
      label: 'commits past the call bound',
      status: 201,
      headers: { 'x-opt2-write-position': 'people=42' },
      body: JSON.stringify({ data: 1 }),
      recorded: [[SESSION_ID, new Map([['people', '42']]), 'people']],
      released: [],
    },
    {
      label: "answers the legacy 503 once the owner's gate wait ends",
      status: 503,
      headers: {},
      body: apiUnavailable.body,
      recorded: [],
      released: [[SESSION_ID, 'people']],
    },
  ])('passes on the answer of a service that $label, and settles the exchange', async ({ status, headers, body, recorded, released }) => {
    service.setHandler(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, GATE_MS));
      sendJson(res, status, { data: 1 }, headers);
    });
    bounded.set({ sessionId: SESSION_ID, declaresWrite: true });
    const started = Date.now();
    const res = await bounded.app.inject({ method: 'POST', url: '/v1/people', payload: 'name=late' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(GATE_MS);
    expect(res.statusCode).toBe(status);
    expect(res.body).toBe(body);
    await expectSettledOnce(bounded);
    expect(bounded.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(bounded.recorded).toEqual(recorded);
    expect(bounded.released).toEqual(released);
  });

  it.each([
    ['stalls past the bound', false],
    ['receives the write, stalls past the bound, then commits it', true],
  ])('answers a service that %s with the legacy 503 and keeps the in-flight registration', async (_label, commits) => {
    let committed!: () => void;
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    service.setHandler(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, STALL_MS));
      committed();
      if (commits) sendJson(res, 201, { data: 1 }, { 'x-opt2-write-position': 'people=77' });
    });
    bounded.set({ sessionId: SESSION_ID, declaresWrite: true });
    const started = Date.now();
    const res = await bounded.app.inject({ method: 'POST', url: '/v1/people', payload: 'name=late' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - TIMER_SLACK_MS);
    expect(elapsed).toBeLessThan(STALL_MS);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(apiUnavailable.body);
    expect(service.requests).toHaveLength(1);
    await commit;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bounded.settled()).toBe(0);
    expect(bounded.recorded).toEqual([]);
    expect(bounded.declared).toEqual([[SESSION_ID, 'people', 0]]);
    expect(bounded.released).toEqual([]);
    const uncertain = bounded.logs.filter((line) => line.msg === UNCERTAIN);
    expect(uncertain.map((line) => line.level)).toEqual([40]);
    expect(Object.keys(uncertain[0]?.error as object).sort()).toEqual(expect.arrayContaining(['message', 'type']));
  });
});
