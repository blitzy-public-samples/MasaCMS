import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  context,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type ContextManager,
} from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { errors, MockAgent } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, type InvocationMinter, type InvocationTarget } from '../../src/auth/index.js';
import { LegacyServiceUnavailableError } from '../../src/legacy-compat/index.js';
import { createLogger } from '../../src/logging/index.js';
import {
  createServiceClient,
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  UnknownServiceError,
  type ServiceClient,
  type ServiceClientOptions,
  type ServiceRequest,
} from '../../src/service-kit/client.js';
import {
  currentRequestContext,
  newRequestContext,
  REQUEST_ID_HEADER,
  runWithRequestContext,
} from '../../src/service-kit/context.js';
import { createService } from '../../src/service-kit/create-service.js';
import { baseEnvSchema, loadEnv } from '../../src/service-kit/env.js';
import { testVerifier } from '../../src/testing/index.js';
import {
  activeSpanIds,
  MemorySpanExporter,
  shutdownTracing,
  SpanKind,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';

const IDENTITY = 'http://identity.test';
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubMinter(): InvocationMinter & { headersFor: ReturnType<typeof vi.fn> } {
  return {
    headersFor: vi.fn(async (target: InvocationTarget) => ({
      'X-Serverless-Authorization': `Bearer svc-${target.name}`,
    })),
  };
}

// AsyncLocalStorage context manager, so a span can be active without the SDK and its undici instrumentation.
class AlsContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
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

describe('SERVICE_CALL_TIMEOUT_MS', () => {
  it('is ten seconds', () => {
    expect(SERVICE_CALL_TIMEOUT_MS).toBe(10000);
  });
});

describe('createServiceClient with a MockAgent', () => {
  let agent: MockAgent;
  let minter: ReturnType<typeof stubMinter>;
  let client: ServiceClient;

  function makeClient(extra: Partial<ServiceClientOptions> = {}): ServiceClient {
    return createServiceClient({
      serviceUrls: { identity: IDENTITY, people: 'http://people.test' },
      self: 'gateway',
      credentials: minter,
      dispatcher: agent,
      ...extra,
    });
  }

  function lastCall() {
    const call = agent.getCallHistory()?.lastCall();
    if (call === undefined) throw new Error('no request reached the MockAgent');
    return call;
  }

  function callCount(): number {
    return agent.getCallHistory()?.calls().length ?? 0;
  }

  function replyOk(path = '/internal/v1/x', method = 'GET'): void {
    agent.get(IDENTITY).intercept({ path: (p) => p.startsWith(path), method }).reply(200, '');
  }

  beforeEach(() => {
    agent = new MockAgent({ enableCallHistory: true });
    agent.disableNetConnect();
    minter = stubMinter();
    client = makeClient();
  });

  afterEach(async () => {
    await client.close();
    await agent.close();
  });

  it('resolves the URL from serviceUrls and repeats array query values, skipping undefined ones', async () => {
    replyOk();
    await client.request({
      service: 'identity',
      method: 'GET',
      path: '/internal/v1/x',
      query: { a: '1', b: ['x', 'y'], c: undefined },
    });
    expect(lastCall().fullUrl).toBe(`${IDENTITY}/internal/v1/x?a=1&b=x&b=y`);
    expect(lastCall().method).toBe('GET');
  });

  it('throws UnknownServiceError before minting or sending anything', async () => {
    const err = await client.request({ service: 'nope', method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownServiceError);
    expect(err).toMatchObject({ name: 'UnknownServiceError', service: 'nope' });
    expect(minter.headersFor).not.toHaveBeenCalled();
    expect(callCount()).toBe(0);
  });

  it('forwards the request context token and adds no X-OPT2 headers', async () => {
    replyOk();
    const store = { ...newRequestContext({ requestId: 'req-1' }), userToken: 'ctx-token', tenantId: 't-1', site: 'a' };
    await runWithRequestContext(store, () => client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x' }));
    const headers = lastCall().headers ?? {};
    expect(headers.authorization).toBe('Bearer ctx-token');
    expect(Object.keys(headers).filter((name) => /^x-opt2-/i.test(name))).toEqual([]);
  });

  it.each<[string, Record<string, string> | undefined, boolean, string | undefined]>([
    ['sends the active request id', undefined, true, 'req-1'],
    ['keeps a caller-supplied one over the active request id', { 'X-Request-Id': 'caller-7' }, true, 'caller-7'],
    ['keeps a caller-supplied one outside a request', { 'x-request-id': 'cli-1' }, false, 'cli-1'],
    ['sends none outside a request', undefined, false, undefined],
  ])('request id: %s', async (_label, headers, inRequest, expected) => {
    replyOk();
    const run = () => client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x', headers });
    await (inRequest ? runWithRequestContext(newRequestContext({ requestId: 'req-1' }), run) : run());
    const sent = Object.entries(lastCall().headers ?? {}).filter(([name]) => name.toLowerCase() === REQUEST_ID_HEADER);
    expect(sent).toEqual(expected === undefined ? [] : [[REQUEST_ID_HEADER, expected]]);
  });

  it.each<[string, Partial<ServiceRequest>, string | undefined]>([
    ['an explicit token wins over the context token', { userToken: 'explicit' }, 'Bearer explicit'],
    ['null sends no Authorization, even a caller-supplied one', { userToken: null, headers: { Authorization: 'Basic x' } }, undefined],
    ['undefined keeps a caller Authorization when the context has no token', { headers: { Authorization: 'Basic x' } }, 'Basic x'],
  ])('user token: %s', async (_label, extra, expected) => {
    replyOk();
    const store = { ...newRequestContext(), userToken: 'ctx-token' };
    const run = () => client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x', ...extra });
    await (extra.headers === undefined ? runWithRequestContext(store, run) : run());
    expect(lastCall().headers?.authorization).toBe(expected);
  });

  it('sends the minted invocation credential for the callee in place of any caller-supplied one', async () => {
    replyOk();
    await client.request({
      service: 'identity',
      method: 'GET',
      path: '/internal/v1/x',
      headers: { 'X-Serverless-Authorization': 'Bearer forwarded' },
    });
    expect(minter.headersFor).toHaveBeenCalledWith(
      { name: 'identity', url: IDENTITY },
      { signal: expect.any(AbortSignal) as unknown },
    );
    expect(lastCall().headers?.[INVOCATION_HEADER]).toBe('Bearer svc-identity');
    expect(Object.keys(lastCall().headers ?? {}).filter((n) => n.toLowerCase() === INVOCATION_HEADER)).toHaveLength(1);
  });

  it.each<[string, Partial<ServiceRequest>, string, string]>([
    ['json', { json: { a: 1, b: 'é' } }, 'application/json', '{"a":1,"b":"é"}'],
    ['form', { form: { a: '1 2', b: ['x', 'y'] } }, 'application/x-www-form-urlencoded', 'a=1+2&b=x&b=y'],
    ['raw', { body: 'raw-bytes', headers: { 'Content-Type': 'application/octet-stream' } }, 'application/octet-stream', 'raw-bytes'],
  ])('sends a %s body with its content type', async (_label, extra, contentType, body) => {
    replyOk('/internal/v1/x', 'POST');
    await client.request({ service: 'identity', method: 'POST', path: '/internal/v1/x', ...extra });
    expect(lastCall().headers?.['content-type']).toBe(contentType);
    expect(lastCall().body).toBe(body);
  });

  it.each<[string, string | undefined, string | Buffer, unknown]>([
    ['application/json with a charset', 'application/json; charset=utf-8', '{"data":{"id":"x"}}', { data: { id: 'x' } }],
    ['the shunter JSON type', 'application/x-shunter+json; charset=utf-8', '{"shunter":true}', { shunter: true }],
    ['any +json type', 'application/problem+json', '[1,2]', [1, 2]],
    ['an empty JSON body', 'application/json', '', undefined],
    ['text/*', 'text/html;charset=UTF-8', '<p>hi</p>', '<p>hi</p>'],
    ['a binary type', 'application/pdf', Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3])],
    ['no content type', undefined, 'abc', Buffer.from('abc')],
  ])('decodes %s', async (_label, contentType, data, expected) => {
    agent
      .get(IDENTITY)
      .intercept({ path: '/x' })
      .reply(200, data, { headers: contentType === undefined ? {} : { 'Content-Type': contentType } });
    const res = await client.request({ service: 'identity', method: 'GET', path: '/x' });
    expect(res.body).toEqual(expected);
  });

  it.each<[string, string, string]>([
    ['JSON', 'application/json;charset=utf-8', '{"html":"<a href=\\"\\/x\\">\\u00e9<\\/a>"}'],
    ['invalid JSON', 'application/json', '{bad'],
    ['text', 'text/csv', 'a,b\r\n1,2\r\n'],
  ])('returns %s bytes untouched with rawBody', async (_label, contentType, data) => {
    agent.get(IDENTITY).intercept({ path: '/x' }).reply(200, data, { headers: { 'Content-Type': contentType } });
    const res = await client.request<Buffer>({ service: 'identity', method: 'GET', path: '/x', rawBody: true });
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.toString('utf8')).toBe(data);
  });

  it('throws an Error naming the callee for invalid JSON', async () => {
    agent.get(IDENTITY).intercept({ path: '/x' }).reply(200, '{bad', { headers: { 'content-type': 'application/json' } });
    const err = await client.request({ service: 'identity', method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ServiceUnavailableError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Service identity (called by gateway) answered with invalid JSON');
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('exposes response headers with lower-cased names, including the write position', async () => {
    agent
      .get(IDENTITY)
      .intercept({ path: '/x', method: 'POST' })
      .reply(200, '{}', {
        headers: {
          'Content-Type': 'application/json',
          'X-Opt2-Write-Position': 'people=101,identity=99',
          'Set-Cookie': ['a=1', 'b=2'],
        },
      });
    const res = await client.request({ service: 'identity', method: 'POST', path: '/x' });
    expect(res.headers['x-opt2-write-position']).toBe('people=101,identity=99');
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(Object.keys(res.headers).every((name) => name === name.toLowerCase())).toBe(true);
  });

  it('returns a 503 response as data', async () => {
    agent
      .get(IDENTITY)
      .intercept({ path: '/x' })
      .reply(503, '{"error":"down"}', { headers: { 'content-type': 'application/json' } });
    const res = await client.request({ service: 'identity', method: 'GET', path: '/x' });
    expect(res).toMatchObject({ status: 503, body: { error: 'down' } });
  });

  it('times out a delayed reply as ServiceUnavailableError after exactly one attempt', async () => {
    client = makeClient({ timeoutMs: 50 });
    agent.get(IDENTITY).intercept({ path: '/x' }).reply(200, 'late').delay(2_000).persist();
    const started = Date.now();
    const err = await client.request({ service: 'identity', method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toMatchObject({ service: 'identity', reason: 'service-unavailable', surface: 'auto' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(callCount()).toBe(1);
  });

  it.each<[string, number, number, 'ok' | 'timeout']>([
    ['shortens', 5_000, 50, 'timeout'],
    ['extends', 50, 5_000, 'ok'],
  ])('a per-call timeoutMs %s the client timeout for that call only', async (_label, clientMs, callMs, outcome) => {
    client = makeClient({ timeoutMs: clientMs });
    agent.get(IDENTITY).intercept({ path: '/x' }).reply(200, 'late').delay(300).persist();
    const outcomeOf = (req: ServiceRequest): Promise<unknown> =>
      client.request(req).then(
        () => 'ok',
        (e: unknown) => (e instanceof ServiceUnavailableError ? 'timeout' : e),
      );
    await expect(outcomeOf({ service: 'identity', method: 'GET', path: '/x', timeoutMs: callMs })).resolves.toBe(outcome);
    await expect(outcomeOf({ service: 'identity', method: 'GET', path: '/x' })).resolves.toBe(
      outcome === 'ok' ? 'timeout' : 'ok',
    );
  });

  it.each<[string, Error, string]>([
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'ECONNRESET'],
    ['ENOTFOUND', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), 'ENOTFOUND'],
    ['EHOSTUNREACH', Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }), 'EHOSTUNREACH'],
    ['ConnectTimeoutError', new errors.ConnectTimeoutError(), 'UND_ERR_CONNECT_TIMEOUT'],
    ['HeadersTimeoutError', new errors.HeadersTimeoutError(), 'UND_ERR_HEADERS_TIMEOUT'],
    ['BodyTimeoutError', new errors.BodyTimeoutError(), 'UND_ERR_BODY_TIMEOUT'],
    ['SocketError', new errors.SocketError('other side closed'), 'UND_ERR_SOCKET'],
  ])('maps %s to ServiceUnavailableError', async (_label, cause, code) => {
    agent.get(IDENTITY).intercept({ path: '/x', method: 'POST' }).replyWithError(cause);
    const err = await client
      .request({ service: 'identity', method: 'POST', path: '/x', json: { secret: 'body-value' }, userToken: 'tok-value' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ name: 'ServiceUnavailableError', service: 'identity', cause });
    expect((err as Error).message).toBe(`Service identity unavailable (${code})`);
    expect(callCount()).toBe(1);
  });

  it('propagates any other dispatch error unchanged', async () => {
    const boom = new Error('boom');
    agent.get(IDENTITY).intercept({ path: '/x' }).replyWithError(boom);
    await expect(client.request({ service: 'identity', method: 'GET', path: '/x' })).rejects.toBe(boom);
  });

  it('propagates a minter failure unchanged without sending', async () => {
    const failure = new TypeError('No URL for invocation target identity');
    minter.headersFor.mockRejectedValueOnce(failure);
    await expect(client.request({ service: 'identity', method: 'GET', path: '/x' })).rejects.toBe(failure);
    expect(callCount()).toBe(0);
  });

  it.each<[string, (signal: AbortSignal) => Promise<Record<string, string>>]>([
    ['ignores the signal', () => new Promise(() => undefined)],
    [
      'honours the signal',
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('minter aborted'));
          });
        }),
    ],
  ])('cuts a stalled minter that %s at the deadline as ServiceUnavailableError without sending', async (_label, stall) => {
    let given: AbortSignal | undefined;
    const stalled: InvocationMinter = {
      headersFor: (_target, opts) => {
        given = opts?.signal;
        return given === undefined ? Promise.reject(new Error('no signal')) : stall(given);
      },
    };
    client = makeClient({ timeoutMs: 50, credentials: stalled });
    replyOk('/x');
    const started = Date.now();
    const err = await client.request({ service: 'identity', method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toMatchObject({ service: 'identity', reason: 'service-unavailable', surface: 'auto' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(given?.aborted).toBe(true);
    expect(given?.reason).toMatchObject({ name: 'TimeoutError' });
    expect(callCount()).toBe(0);
  });

  it('charges credential acquisition and the reply to one deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      let given: AbortSignal | undefined;
      const slow: InvocationMinter = {
        async headersFor(target, opts) {
          given = opts?.signal;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { 'X-Serverless-Authorization': `Bearer svc-${target.name}` };
        },
      };
      client = makeClient({ timeoutMs: 200, credentials: slow });
      agent.get(IDENTITY).intercept({ path: '/x' }).reply(200, 'late').delay(2_000);
      const err = await client.request({ service: 'identity', method: 'GET', path: '/x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      expect(callCount()).toBe(1);
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(timeout).toHaveBeenCalledWith(200);
      expect(given).toBe(timeout.mock.results[0]?.value);
      expect(given?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it('leaves an injected dispatcher open on close', async () => {
    const close = vi.spyOn(agent, 'close');
    await client.close();
    expect(close).not.toHaveBeenCalled();
  });

  describe('trace context without the SDK', () => {
    const manager = new AlsContextManager();
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    };

    beforeAll(() => {
      expect(context.setGlobalContextManager(manager)).toBe(true);
    });

    afterAll(() => {
      context.disable();
    });

    it('injects a W3C traceparent for the active span', async () => {
      replyOk();
      await context.with(trace.setSpanContext(context.active(), spanContext), () =>
        client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x' }),
      );
      const traceparent = String(lastCall().headers?.traceparent);
      expect(traceparent).toMatch(TRACEPARENT);
      expect(traceparent).toBe(`00-${spanContext.traceId}-${spanContext.spanId}-01`);
    });

    it('sends no traceparent when no span is active', async () => {
      replyOk();
      await client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x' });
      expect(lastCall().headers?.traceparent).toBeUndefined();
    });
  });
});

describe('createServiceClient with its own Agent', () => {
  let server: Server;
  let base: string;
  const seen: IncomingMessage[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req);
      if (req.url === '/slow') {
        setTimeout(() => res.end('late'), 2_000).unref();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  function ownClient(extra: Partial<ServiceClientOptions> = {}): ServiceClient {
    return createServiceClient({ serviceUrls: { echo: base }, self: 'people', credentials: stubMinter(), ...extra });
  }

  it('calls the callee and closes its Agent on close', async () => {
    const client = ownClient();
    await expect(client.request({ service: 'echo', method: 'GET', path: '/ok' })).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    await client.close();
    const err = await client.request({ service: 'echo', method: 'GET', path: '/ok' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errors.UndiciError);
    expect(err).not.toBeInstanceOf(ServiceUnavailableError);
  });

  it('maps a refused connection to ServiceUnavailableError', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const client = ownClient({ serviceUrls: { echo: `http://127.0.0.1:${port}` } });
    const err = await client.request({ service: 'echo', method: 'GET', path: '/' }).catch((e: unknown) => e);
    await client.close();
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect((err as Error).message).toBe('Service echo unavailable (ECONNREFUSED)');
  });

  it('bounds a slow callee by the timeout', async () => {
    const client = ownClient({ timeoutMs: 100 });
    const started = Date.now();
    const err = await client.request({ service: 'echo', method: 'GET', path: '/slow' }).catch((e: unknown) => e);
    await client.close();
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect((err as Error).message).toBe('Service echo unavailable (TimeoutError)');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen).toHaveLength(1);
  });

  describe('with the tracing SDK started', () => {
    const exporter = new MemorySpanExporter();

    beforeAll(async () => {
      await startTracing({ serviceName: 'service-kit-client-test', version: '0.0.0', exporter });
    });

    afterAll(async () => {
      await shutdownTracing();
    });

    it('sends exactly one traceparent, from the undici client span', async () => {
      const client = ownClient();
      const caller = await startSpan('caller', SpanKind.SERVER, async () => {
        await client.request({ service: 'echo', method: 'GET', path: '/ok' });
        return activeSpanIds();
      });
      await client.close();
      const received = seen[0]?.rawHeaders.filter((_, i, raw) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === 'traceparent');
      expect(received).toHaveLength(1);
      const [, traceId, parentId] = TRACEPARENT.exec(received?.[0] ?? '') ?? [];
      expect(traceId).toBe(caller?.traceId);
      expect(parentId).not.toBe(caller?.spanId);
    });
  });
});

describe('createService client across one hop', () => {
  let callee: Server;
  let app: FastifyInstance;
  const received: string[][] = [];

  beforeAll(async () => {
    callee = createServer((req, res) => {
      received.push(req.rawHeaders.filter((_, i, raw) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === REQUEST_ID_HEADER));
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => callee.listen(0, '127.0.0.1', resolve));
    const env = loadEnv(baseEnvSchema, {
      PORT: '26112',
      OPT2_SERVICE_NAME: 'people',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_SERVICE_URLS: JSON.stringify({ identity: `http://127.0.0.1:${String((callee.address() as AddressInfo).port)}` }),
      OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-service-kit-client-state'),
      TZ: 'UTC',
    });
    const logger = createLogger({ service: 'people', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    app = await createService({ name: 'people', version: '1.0.0', env, verifierOverride: testVerifier('people'), logger });
    app.get('/hop', { config: { opt2: { public: true } } }, async () => {
      await app.opt2.client.request({ service: 'identity', method: 'GET', path: '/internal/v1/x' });
      return { requestId: currentRequestContext()?.requestId };
    });
  });

  afterAll(async () => {
    await app.opt2.shutdown();
    callee.closeAllConnections();
    await new Promise<void>((resolve) => {
      callee.close(() => {
        resolve();
      });
    });
  });

  beforeEach(() => {
    received.length = 0;
  });

  it.each<[string, Record<string, string>, string | undefined]>([
    ['the inbound X-Request-Id', { 'X-Request-Id': 'r-hop-1' }, 'r-hop-1'],
    ['the id the caller generated', {}, undefined],
  ])('carries %s to the callee', async (_label, headers, inbound) => {
    const res = await app.inject({ method: 'GET', url: '/hop', headers });
    expect(res.statusCode).toBe(200);
    const { requestId } = res.json<{ requestId: string }>();
    expect(requestId).toEqual(inbound ?? expect.stringMatching(UUID));
    expect(received).toEqual([[requestId]]);
  });
});
