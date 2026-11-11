// Tests the W3C trace headers forwardToLegacy sends legacy, with and without the SDK's undici instrumentation.
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySpanExporter,
  SpanKind,
  flushTracing,
  shutdownTracing,
  startTracing,
  withExtractedContext,
  type Context,
} from '@opt2/platform/tracing';
import { startHttpDouble, sendBytes, type HttpDouble, type RecordedRequest } from '../helpers/http-double.js';

const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const INBOUND = { traceparent: `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`, tracestate: 'vendor=value' };
const ACTIVE = {
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  tracestate: 'active=1',
};
const SITE_HOST = 'site.example';
const W3C_TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/** A running gateway stand-in that forwards `/plain` and, under `ACTIVE`, `/active` to `legacy`. */
interface Gateway {
  port: number;
  close(): Promise<void>;
}

/** Builds the gateway; fastify loads here so the http instrumentation, when started, patches it. */
async function startGateway(legacy: HttpDouble): Promise<Gateway> {
  const { default: Fastify } = await import('fastify');
  const { default: replyFrom } = await import('@fastify/reply-from');
  const { forwardToLegacy } = await import('../../src/dispatcher/forward-legacy.js');
  type Request = Parameters<typeof forwardToLegacy>[0];
  type Reply = Parameters<typeof forwardToLegacy>[1];

  const app = Fastify();
  await app.register(replyFrom);
  const forward = (request: Request, reply: Reply): Promise<Reply> =>
    forwardToLegacy(request, reply, {
      legacyOrigin: legacy.url,
      headers: request.headers,
      mode: 'stream',
      sessionMode: 'legacy-primary',
      failContext: { surface: 'api' },
    });
  app.get('/plain', (request, reply) => forward(request, reply));
  app.get('/active', (request, reply) => withExtractedContext(ACTIVE, () => forward(request, reply)));
  await app.listen({ host: '127.0.0.1', port: 0 });
  return { port: (app.server.address() as AddressInfo).port, close: () => app.close() };
}

/**
 * Sends `GET path` over a raw socket, so no client instrumentation adds trace headers.
 * Resolves the response text once its `Content-Length` body arrived; the connection is then dropped.
 */
async function sendRaw(port: number, path: string, headers: Record<string, string>): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${SITE_HOST}`, ...Object.entries(headers).map(([n, v]) => `${n}: ${v}`)];
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  let text = '';
  for await (const chunk of socket) {
    text += (chunk as Buffer).toString('latin1');
    const headEnd = text.indexOf('\r\n\r\n');
    const length = /\r\ncontent-length: *(\d+)\r\n/i.exec(text)?.[1];
    if (headEnd !== -1 && length !== undefined && text.length >= headEnd + 4 + Number(length)) break;
  }
  return text;
}

/** Every value legacy received for header `name`, one per header line. */
function rawValues(recorded: RecordedRequest, name: string): string[] {
  return recorded.rawHeaders.filter((_, i, raw) => i % 2 === 1 && raw[i - 1]?.toLowerCase() === name);
}

/** Forwards `path` with the inbound trace headers and returns what legacy received. */
async function forwardedRequest(gateway: Gateway, legacy: HttpDouble, path: string): Promise<RecordedRequest> {
  legacy.clearRequests();
  const response = await sendRaw(gateway.port, path, INBOUND);
  expect(response).toMatch(/^HTTP\/1\.1 200 /);
  expect(legacy.requests).toHaveLength(1);
  return legacy.requests[0] as RecordedRequest;
}

let legacy: HttpDouble;

beforeAll(async () => {
  legacy = await startHttpDouble((_req, res) => sendBytes(res, 200, 'ok', { 'content-type': 'text/plain' }));
});

afterAll(async () => {
  await legacy.close();
});

describe('forwardToLegacy trace headers with the SDK started', () => {
  const exporter = new MemorySpanExporter();
  let gateway: Gateway;

  beforeAll(async () => {
    await startTracing({ serviceName: 'gateway-forward-legacy-trace-test', version: '1.0.0', exporter });
    gateway = await startGateway(legacy);
  });

  afterAll(async () => {
    await gateway.close();
    await shutdownTracing();
  });

  it('sends exactly one traceparent, from the undici client span of the inbound trace, and the inbound tracestate', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(true);
    const recorded = await forwardedRequest(gateway, legacy, '/plain');

    const traceparents = rawValues(recorded, 'traceparent');
    expect(traceparents).toHaveLength(1);
    const [, traceId, parentId] = W3C_TRACEPARENT.exec(traceparents[0] ?? '') ?? [];
    expect(traceId).toBe(INBOUND_TRACE_ID);
    expect(parentId).toBeDefined();
    expect(parentId).not.toBe(INBOUND_SPAN_ID);
    expect(rawValues(recorded, 'tracestate')).toEqual([INBOUND.tracestate]);

    await flushTracing();
    const parent = exporter.getFinishedSpans().find((span) => span.spanContext().spanId === parentId);
    expect(parent?.kind).toBe(SpanKind.CLIENT);
    expect(parent?.spanContext().traceId).toBe(INBOUND_TRACE_ID);
  });

  it('keeps Host and adds X-Forwarded-*', async () => {
    const recorded = await forwardedRequest(gateway, legacy, '/plain');
    expect(recorded.headers).toMatchObject({
      host: SITE_HOST,
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'http',
      'x-forwarded-host': SITE_HOST,
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

describe('forwardToLegacy trace headers without undici instrumentation', () => {
  const otel = createRequire(createRequire(import.meta.url).resolve('@opt2/platform/tracing'))(
    '@opentelemetry/api',
  ) as OtelApi;
  let gateway: Gateway;

  beforeAll(async () => {
    expect(otel.context.setGlobalContextManager(new AlsContextManager(otel.ROOT_CONTEXT))).toBe(true);
    gateway = await startGateway(legacy);
  });

  afterAll(async () => {
    await gateway.close();
    otel.context.disable();
  });

  it('passes the inbound traceparent and tracestate once and unchanged when no span is active', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(false);
    const recorded = await forwardedRequest(gateway, legacy, '/plain');
    expect(rawValues(recorded, 'traceparent')).toEqual([INBOUND.traceparent]);
    expect(rawValues(recorded, 'tracestate')).toEqual([INBOUND.tracestate]);
  });

  it('sends exactly the active span context in place of the inbound one', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(false);
    const recorded = await forwardedRequest(gateway, legacy, '/active');
    expect(rawValues(recorded, 'traceparent')).toEqual([ACTIVE.traceparent]);
    expect(rawValues(recorded, 'tracestate')).toEqual([ACTIVE.tracestate]);
  });
});
