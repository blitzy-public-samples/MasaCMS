import type * as Http from 'node:http';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  context,
  createTraceState,
  INVALID_SPAN_CONTEXT,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeSpanIds,
  contextFromEnvelope,
  currentTraceparent,
  extractHttpContext,
  injectHttpHeaders,
  pubsubAttributes,
  startSpan,
  taskHeaders,
  withExtractedContext,
  type HeaderBag,
  type TraceCarrier,
} from '../../src/tracing/propagation.js';
import {
  assertTraceContinuity,
  checkTraceContinuity,
  spansFromOtlpJsonLines,
  toContinuitySpan,
  TraceContinuityError,
  type ContinuitySpan,
  type SpanSelector,
} from '../../src/tracing/continuity.js';
import {
  flushTracing,
  MemorySpanExporter,
  shutdownTracing,
  startTracing,
  type ReadableSpan,
} from '../../src/tracing/sdk.js';

const otlpUrls = vi.hoisted((): string[] => []);

vi.mock('@opentelemetry/exporter-trace-otlp-http', async () => {
  const { ExportResultCode } = await import('@opentelemetry/core');
  return {
    OTLPTraceExporter: class {
      constructor(config: { url: string }) {
        otlpUrls.push(config.url);
      }

      export(_spans: unknown[], done: (result: { code: number }) => void): void {
        done({ code: ExportResultCode.SUCCESS });
      }

      shutdown(): Promise<void> {
        return Promise.resolve();
      }

      forceFlush(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

const SERVICE = { serviceName: 'tracing-test', version: '1.2.3' };
const ENDPOINT_VAR = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
const TRACESTATE = 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7';
const FRESH_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

class FailingShutdownExporter extends MemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.reject(new Error('collector unreachable'));
  }
}

function remoteContext(traceState?: string): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
    ...(traceState === undefined ? {} : { traceState: createTraceState(traceState) }),
  });
}

async function exported(exporter: MemorySpanExporter): Promise<ReadableSpan[]> {
  await flushTracing();
  return exporter.getFinishedSpans();
}

function loadHttp(): typeof Http {
  return createRequire(import.meta.url)('http') as typeof Http;
}

async function getOnce(http: typeof Http, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
        response.resume();
        response.on('end', resolve);
      })
      .on('error', reject);
  });
}

function clientSpans(spans: ReadableSpan[]): ReadableSpan[] {
  return spans.filter((span) => span.kind === SpanKind.CLIENT);
}

afterAll(async () => {
  await shutdownTracing();
});

describe('tracing sdk', () => {
  const savedEndpoint = process.env[ENDPOINT_VAR];

  afterEach(async () => {
    await shutdownTracing();
    if (savedEndpoint === undefined) {
      delete process.env[ENDPOINT_VAR];
    } else {
      process.env[ENDPOINT_VAR] = savedEndpoint;
    }
  });

  it('flushTracing and shutdownTracing are no-ops before start', async () => {
    await expect(flushTracing()).resolves.toBeUndefined();
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });

  it('exports spans with the service resource and registers the W3C propagator', async () => {
    const exporter = new MemorySpanExporter();
    await startTracing({ ...SERVICE, exporter });

    await startSpan('work', SpanKind.INTERNAL, () => undefined);
    const [span] = await exported(exporter);

    expect(span?.name).toBe('work');
    expect(span?.resource.attributes[ATTR_SERVICE_NAME]).toBe('tracing-test');
    expect(span?.resource.attributes[ATTR_SERVICE_VERSION]).toBe('1.2.3');
    expect(propagation.fields()).toEqual(['traceparent', 'tracestate']);
  });

  it('memory exporter returns copies, keeps spans across shutdown and clears on reset', async () => {
    const exporter = new MemorySpanExporter();
    await startTracing({ ...SERVICE, exporter });
    await startSpan('kept', SpanKind.INTERNAL, () => undefined);

    const spans = await exported(exporter);
    spans.length = 0;
    await shutdownTracing();

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['kept']);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    exporter.reset();
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('ignores a second start until shutdown', async () => {
    const first = new MemorySpanExporter();
    const second = new MemorySpanExporter();
    await startTracing({ ...SERVICE, exporter: first });
    await startTracing({ serviceName: 'other', version: '9.9.9', exporter: second });

    await startSpan('once', SpanKind.INTERNAL, () => undefined);
    const spans = await exported(first);

    expect(spans.map((span) => span.name)).toEqual(['once']);
    expect(spans[0]?.resource.attributes[ATTR_SERVICE_NAME]).toBe('tracing-test');
    expect(second.getFinishedSpans()).toEqual([]);
  });

  it('re-enables instrumentation for modules loaded before a restart', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const first = new MemorySpanExporter();
      await startTracing({ ...SERVICE, exporter: first });
      const http = loadHttp();
      await getOnce(http, port);
      expect(clientSpans(await exported(first))).toHaveLength(1);
      await shutdownTracing();

      const second = new MemorySpanExporter();
      await startTracing({ ...SERVICE, exporter: second });
      await getOnce(http, port);

      expect(clientSpans(await exported(second))).toHaveLength(1);
      expect(clientSpans(first.getFinishedSpans())).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    { endpoint: undefined, env: undefined, url: 'http://localhost:4318/v1/traces' },
    { endpoint: undefined, env: '', url: 'http://localhost:4318/v1/traces' },
    { endpoint: undefined, env: '  ', url: 'http://localhost:4318/v1/traces' },
    { endpoint: undefined, env: 'http://127.0.0.1:4318/', url: 'http://127.0.0.1:4318/v1/traces' },
    { endpoint: 'http://collector:4318//', env: 'http://127.0.0.1:4318', url: 'http://collector:4318/v1/traces' },
  ])('exports over OTLP/HTTP to $url for endpoint $endpoint and variable "$env"', async ({ endpoint, env, url }) => {
    if (env === undefined) {
      delete process.env[ENDPOINT_VAR];
    } else {
      process.env[ENDPOINT_VAR] = env;
    }
    otlpUrls.length = 0;

    await startTracing(endpoint === undefined ? SERVICE : { ...SERVICE, endpoint });

    expect(otlpUrls).toEqual([url]);
  });

  it('unpatches and unregisters when the final export fails, so tracing restarts', async () => {
    const http = loadHttp();
    const original = http.request;
    await startTracing({ ...SERVICE, exporter: new FailingShutdownExporter() });
    loadHttp();
    expect(http.request).not.toBe(original);

    await expect(shutdownTracing()).rejects.toThrow('collector unreachable');

    expect(http.request).toBe(original);
    expect(propagation.fields()).toEqual([]);
    expect(context.with(remoteContext(), () => trace.getSpanContext(context.active()))).toBeUndefined();
    await expect(startSpan('detached', SpanKind.INTERNAL, (span) => span.isRecording())).resolves.toBe(false);

    const next = new MemorySpanExporter();
    await startTracing({ ...SERVICE, exporter: next });
    await startSpan('restarted', SpanKind.INTERNAL, () => undefined);
    expect((await exported(next)).map((span) => span.name)).toEqual(['restarted']);
  });
});

describe('tracing propagation', () => {
  const exporter = new MemorySpanExporter();

  beforeAll(async () => {
    await startTracing({ ...SERVICE, exporter });
  });

  beforeEach(async () => {
    await flushTracing();
    exporter.reset();
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  describe('injectHttpHeaders', () => {
    it('writes trace headers for the context, replacing other casings and keeping other headers', () => {
      const headers = { 'content-type': 'application/json', TraceParent: 'stale', TRACESTATE: 'stale' };

      const result = injectHttpHeaders(headers, remoteContext(TRACESTATE));

      expect(result).toBe(headers);
      expect(result).toEqual({ 'content-type': 'application/json', traceparent: TRACEPARENT, tracestate: TRACESTATE });
    });

    it('drops a stale tracestate when the context has none', () => {
      expect(injectHttpHeaders({ tracestate: 'stale' }, remoteContext())).toEqual({ traceparent: TRACEPARENT });
    });

    it('leaves headers untouched without a valid span context', () => {
      expect(injectHttpHeaders({ traceparent: 'kept' }, ROOT_CONTEXT)).toEqual({ traceparent: 'kept' });
    });

    it('defaults to the active span', async () => {
      const [headers, ids] = await startSpan('outbound', SpanKind.CLIENT, () => [injectHttpHeaders({}), activeSpanIds()] as const);

      expect(headers.traceparent).toBe(`00-${ids?.traceId}-${ids?.spanId}-01`);
    });
  });

  describe('extractHttpContext', () => {
    it.each<{ name: string; carrier: HeaderBag }>([
      { name: 'a lower-case record', carrier: { traceparent: TRACEPARENT } },
      { name: 'a mixed-case record', carrier: { TraceParent: TRACEPARENT } },
      { name: 'an array value', carrier: { traceparent: [TRACEPARENT, 'ignored'] } },
      { name: 'an undefined casing beside a defined one', carrier: { traceparent: undefined, Traceparent: TRACEPARENT } },
      { name: 'Fetch Headers', carrier: new Headers({ traceparent: TRACEPARENT }) },
    ])('reads the remote parent from $name', ({ carrier }) => {
      expect(trace.getSpanContext(extractHttpContext(carrier, ROOT_CONTEXT))).toMatchObject({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    });

    it('reads tracestate alongside traceparent', () => {
      const ctx = extractHttpContext({ traceparent: TRACEPARENT, tracestate: TRACESTATE }, ROOT_CONTEXT);

      expect(trace.getSpanContext(ctx)?.traceState?.serialize()).toBe(TRACESTATE);
    });

    it.each<{ name: string; carrier: HeaderBag }>([
      { name: 'no trace headers', carrier: { 'content-type': 'text/plain' } },
      { name: 'a malformed traceparent', carrier: { traceparent: 'garbage' } },
      { name: 'a numeric traceparent', carrier: { traceparent: 7 } },
      { name: 'empty Fetch Headers', carrier: new Headers() },
    ])('returns the base context for $name', ({ carrier }) => {
      const base = remoteContext();

      expect(extractHttpContext(carrier, base)).toBe(base);
    });

    it('header getter lists record names and none for Headers', () => {
      const extract = vi.spyOn(W3CTraceContextPropagator.prototype, 'extract');
      try {
        extractHttpContext({ traceparent: TRACEPARENT }, ROOT_CONTEXT);
        const getter = extract.mock.calls[0]?.[2];

        expect(getter?.keys({ traceparent: TRACEPARENT, 'x-request-id': 'r1' })).toEqual(['traceparent', 'x-request-id']);
        expect(getter?.keys(new Headers({ traceparent: TRACEPARENT }))).toEqual([]);
      } finally {
        extract.mockRestore();
      }
    });
  });

  describe('currentTraceparent', () => {
    it('returns the active span context', async () => {
      const [carrier, ids] = await startSpan('produce', SpanKind.PRODUCER, () => [currentTraceparent(), activeSpanIds()] as const);

      expect(carrier).toEqual({ traceparent: `00-${ids?.traceId}-${ids?.spanId}-01` });
    });

    it('carries the active tracestate', () => {
      expect(withExtractedContext({ traceparent: TRACEPARENT, tracestate: TRACESTATE }, currentTraceparent)).toEqual({
        traceparent: TRACEPARENT,
        tracestate: TRACESTATE,
      });
    });

    it('mints a fresh sampled root without an active span', () => {
      const first = currentTraceparent();
      const second = currentTraceparent();

      expect(Object.keys(first)).toEqual(['traceparent']);
      expect(first.traceparent).toMatch(FRESH_TRACEPARENT);
      expect(second.traceparent).toMatch(FRESH_TRACEPARENT);
      expect(second.traceparent).not.toBe(first.traceparent);
    });
  });

  describe('contextFromEnvelope', () => {
    it('returns the active context with the envelope parent', () => {
      const ctx = contextFromEnvelope({ traceparent: TRACEPARENT, tracestate: TRACESTATE });

      expect(trace.getSpanContext(ctx)).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID, isRemote: true });
      expect(trace.getSpanContext(ctx)?.traceState?.serialize()).toBe(TRACESTATE);
    });

    it.each<{ name: string; carrier: Partial<TraceCarrier> }>([
      { name: 'no traceparent', carrier: {} },
      { name: 'only a tracestate', carrier: { tracestate: TRACESTATE } },
      { name: 'a malformed traceparent', carrier: { traceparent: 'garbage' } },
    ])('returns the active context unchanged for $name', ({ carrier }) => {
      const active = remoteContext();

      expect(context.with(active, () => contextFromEnvelope(carrier))).toBe(active);
    });
  });

  describe('withExtractedContext', () => {
    it('parents spans started inside to the producer and returns the result', async () => {
      const result = await withExtractedContext({ traceparent: TRACEPARENT }, () =>
        startSpan('consume', SpanKind.CONSUMER, () => 'done'),
      );
      const [span] = await exported(exporter);

      expect(result).toBe('done');
      expect(span?.kind).toBe(SpanKind.CONSUMER);
      expect(span?.spanContext().traceId).toBe(TRACE_ID);
      expect(span?.parentSpanContext?.spanId).toBe(SPAN_ID);
    });
  });

  describe('pubsubAttributes', () => {
    it.each<{ name: string; carrier: TraceCarrier; attributes: Record<string, string> }>([
      { name: 'traceparent only', carrier: { traceparent: TRACEPARENT }, attributes: { traceparent: TRACEPARENT } },
      {
        name: 'traceparent and tracestate',
        carrier: { traceparent: TRACEPARENT, tracestate: TRACESTATE },
        attributes: { traceparent: TRACEPARENT, tracestate: TRACESTATE },
      },
      {
        name: 'an empty tracestate',
        carrier: { traceparent: TRACEPARENT, tracestate: '' },
        attributes: { traceparent: TRACEPARENT },
      },
    ])('mirrors $name', ({ carrier, attributes }) => {
      expect(pubsubAttributes(carrier)).toEqual(attributes);
    });

    it('defaults to the active trace context', async () => {
      const [attributes, ids] = await startSpan('publish', SpanKind.PRODUCER, () => [pubsubAttributes(), activeSpanIds()] as const);

      expect(attributes).toEqual({ traceparent: `00-${ids?.traceId}-${ids?.spanId}-01` });
    });
  });

  describe('taskHeaders', () => {
    it('returns trace headers for the context', () => {
      expect(taskHeaders(remoteContext(TRACESTATE))).toEqual({ traceparent: TRACEPARENT, tracestate: TRACESTATE });
    });

    it('returns no headers without an active span', () => {
      expect(taskHeaders()).toEqual({});
    });

    it('defaults to the active span', async () => {
      const [headers, ids] = await startSpan('enqueue', SpanKind.CLIENT, () => [taskHeaders(), activeSpanIds()] as const);

      expect(headers).toEqual({ traceparent: `00-${ids?.traceId}-${ids?.spanId}-01` });
    });
  });

  describe('activeSpanIds', () => {
    it('returns the ids and sampled flag of the active span', async () => {
      const [ids, spanContext] = await startSpan('ids', SpanKind.INTERNAL, (span) => [activeSpanIds(), span.spanContext()] as const);

      expect(ids).toEqual({ traceId: spanContext.traceId, spanId: spanContext.spanId, traceSampled: true });
    });

    it('reports an unsampled remote parent', () => {
      expect(withExtractedContext({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-00` }, activeSpanIds)).toEqual({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceSampled: false,
      });
    });

    it.each<{ name: string; ctx: Context }>([
      { name: 'no span', ctx: ROOT_CONTEXT },
      { name: 'an invalid span', ctx: trace.setSpanContext(ROOT_CONTEXT, INVALID_SPAN_CONTEXT) },
    ])('returns undefined for $name', ({ ctx }) => {
      expect(context.with(ctx, activeSpanIds)).toBeUndefined();
    });
  });

  describe('startSpan', () => {
    it.each<{ name: string; fn: () => number | Promise<number> }>([
      { name: 'synchronous', fn: () => 42 },
      { name: 'asynchronous', fn: () => Promise.resolve(42) },
    ])('returns the $name result and ends the span with its kind and attributes', async ({ fn }) => {
      await expect(startSpan('call', SpanKind.SERVER, fn, { 'opt2.case': 'ok' })).resolves.toBe(42);
      const [span] = await exported(exporter);

      expect(span).toMatchObject({
        name: 'call',
        kind: SpanKind.SERVER,
        ended: true,
        attributes: { 'opt2.case': 'ok' },
        status: { code: SpanStatusCode.UNSET },
      });
    });

    it.each<{ name: string; thrown: unknown; event: Record<string, string> }>([
      {
        name: 'an Error',
        thrown: new Error('boom'),
        event: { 'exception.type': 'Error', 'exception.message': 'boom' },
      },
      { name: 'a string', thrown: 'boom', event: { 'exception.message': 'boom' } },
    ])('records $name as an exception, marks the span failed and rethrows', async ({ thrown, event }) => {
      await expect(
        startSpan('fail', SpanKind.INTERNAL, () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
      const [span] = await exported(exporter);

      expect(span?.ended).toBe(true);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.events).toHaveLength(1);
      expect(span?.events[0]?.name).toBe('exception');
      expect(span?.events[0]?.attributes).toMatchObject(event);
    });
  });
});

describe('trace continuity', () => {
  const TRACE_A = 'a'.repeat(32);
  const TRACE_B = 'b'.repeat(32);
  const ARCHIVE_CHAIN: SpanSelector[] = [
    { name: 'POST', service: 'gateway', kind: SpanKind.SERVER },
    { service: 'gateway', kind: SpanKind.CLIENT },
    { name: 'POST', service: 'people', kind: SpanKind.SERVER },
    'outbox.publish',
    /^events\.consume /,
  ];

  function plain(name: string, traceId: string, spanId: string, parentSpanId?: string): ContinuitySpan {
    return parentSpanId === undefined ? { name, traceId, spanId } : { name, traceId, spanId, parentSpanId };
  }

  async function hop<T>(serviceName: string, fn: () => Promise<T>): Promise<{ result: T; spans: ReadableSpan[] }> {
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName, version: '1.0.0', exporter });
    try {
      const result = await fn();
      return { result, spans: await exported(exporter) };
    } finally {
      await shutdownTracing();
    }
  }

  async function archiveTrace(consumer: 'extracted' | 'dropped'): Promise<ReadableSpan[]> {
    const gateway = await hop('gateway', () =>
      startSpan('POST', SpanKind.SERVER, () => startSpan('POST', SpanKind.CLIENT, () => injectHttpHeaders({}))),
    );
    const people = await hop('people', () =>
      context.with(extractHttpContext(gateway.result, ROOT_CONTEXT), () =>
        startSpan('POST', SpanKind.SERVER, () => startSpan('outbox.publish', SpanKind.PRODUCER, currentTraceparent)),
      ),
    );
    const timesheets = await hop('timesheets', () => {
      const consume = (): Promise<void> =>
        startSpan('events.consume people.person.archived.v1', SpanKind.CONSUMER, () => undefined);
      return consumer === 'extracted' ? withExtractedContext(people.result, consume) : context.with(ROOT_CONTEXT, consume);
    });
    return [...gateway.spans, ...people.spans, ...timesheets.spans];
  }

  afterEach(async () => {
    await shutdownTracing();
  });

  it('passes an archive chain propagated across gateway, people and timesheets', async () => {
    const spans = await archiveTrace('extracted');
    const root = spans.find((span) => span.kind === SpanKind.SERVER && span.resource.attributes[ATTR_SERVICE_NAME] === 'gateway');

    const result = assertTraceContinuity(spans, { expectedSpanNames: ARCHIVE_CHAIN });

    expect(result).toEqual(checkTraceContinuity(spans, { expectedSpanNames: ARCHIVE_CHAIN }));
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.traceId).toBe(root?.spanContext().traceId);
    expect(result.matched.map((span) => [span.name, span.service, span.kind])).toEqual([
      ['POST', 'gateway', SpanKind.SERVER],
      ['POST', 'gateway', SpanKind.CLIENT],
      ['POST', 'people', SpanKind.SERVER],
      ['outbox.publish', 'people', SpanKind.PRODUCER],
      ['events.consume people.person.archived.v1', 'timesheets', SpanKind.CONSUMER],
    ]);
    expect(result.matched[0]).toEqual({
      name: 'POST',
      traceId: root?.spanContext().traceId,
      spanId: root?.spanContext().spanId,
      kind: SpanKind.SERVER,
      service: 'gateway',
    });
  });

  it('reports a broken chain and throws when the consumer drops the extracted context', async () => {
    const spans = await archiveTrace('dropped');
    const gatewayTrace = spans[0]?.spanContext().traceId;
    const consumerTrace = spans.find((span) => span.kind === SpanKind.CONSUMER)?.spanContext().traceId;

    const result = checkTraceContinuity(spans, { expectedSpanNames: ARCHIVE_CHAIN });

    expect(consumerTrace).not.toBe(gatewayTrace);
    expect(result).toEqual({
      ok: false,
      matched: [],
      problems: [
        'broken chain: expected spans do not share one traceId (' +
          `POST@gateway(SERVER) -> [${gatewayTrace}], @gateway(CLIENT) -> [${gatewayTrace}], ` +
          `POST@people(SERVER) -> [${gatewayTrace}], outbox.publish -> [${gatewayTrace}], ` +
          `^events\\.consume  -> [${consumerTrace}])`,
      ],
    });
    let thrown: unknown;
    try {
      assertTraceContinuity(spans, { expectedSpanNames: ARCHIVE_CHAIN });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TraceContinuityError);
    expect(thrown).toMatchObject({
      name: 'TraceContinuityError',
      message: `trace continuity broken: ${result.problems.join('; ')}`,
      result,
    });
  });

  it('accepts a consumer parented to the server span instead of the publish span', () => {
    const spans = [
      plain('consume', TRACE_A, '0000000000000004', '0000000000000002'),
      plain('publish', TRACE_A, '0000000000000003', '0000000000000002'),
      plain('server', TRACE_A, '0000000000000002', '0000000000000001'),
      plain('gateway', TRACE_A, '0000000000000001'),
    ];

    const result = checkTraceContinuity(spans, { expectedSpanNames: ['gateway', 'publish', 'consume'] });

    expect(result).toEqual({ ok: true, traceId: TRACE_A, matched: [spans[3], spans[1], spans[0]], problems: [] });
  });

  it('returns the first root trace whose chain is intact', () => {
    const spans = [
      plain('root', TRACE_A, '00000000000000a1'),
      plain('leaf', TRACE_A, '00000000000000a2'),
      plain('root', TRACE_B, '00000000000000b1'),
      plain('leaf', TRACE_B, '00000000000000b2', '00000000000000b1'),
    ];

    const result = checkTraceContinuity(spans, { expectedSpanNames: ['root', /leaf/g] });

    expect(result).toEqual({ ok: true, traceId: TRACE_B, matched: [spans[2], spans[3]], problems: [] });
  });

  it.each<{ name: string; selectors: SpanSelector[]; problems: string[] }>([
    { name: 'an unmatched name', selectors: ['root', 'absent'], problems: ['missing span: absent'] },
    {
      name: 'unmatched pattern, service and kind selectors',
      selectors: [/^ro/, { name: /^x/, service: 'svc' }, { kind: SpanKind.CONSUMER }, { service: 'people' }],
      problems: ['missing span: ^x@svc', 'missing span: (CONSUMER)', 'missing span: @people'],
    },
    { name: 'an unmatched root', selectors: [{ name: 'gateway', kind: SpanKind.SERVER }], problems: ['missing span: gateway(SERVER)'] },
    { name: 'no selectors', selectors: [], problems: ['no expected spans given'] },
  ])('reports $name', ({ selectors, problems }) => {
    const spans = [{ ...plain('root', TRACE_A, '0000000000000001'), kind: SpanKind.SERVER, service: 'gateway' }];

    expect(checkTraceContinuity(spans, { expectedSpanNames: selectors })).toEqual({ ok: false, matched: [], problems });
  });

  it.each<{ name: string; spans: ContinuitySpan[]; problems: string[] }>([
    {
      name: 'a dangling parent',
      spans: [plain('root', TRACE_A, '0000000000000001'), plain('leaf', TRACE_A, '0000000000000003', '0000000000000002')],
      problems: ['dangling parent 0000000000000002 of leaf'],
    },
    {
      name: 'a missing parent link',
      spans: [plain('root', TRACE_A, '0000000000000001'), plain('leaf', TRACE_A, '0000000000000002')],
      problems: ['no parent link: leaf'],
    },
    {
      name: 'a span under another root',
      spans: [
        plain('root', TRACE_A, '0000000000000001'),
        plain('other', TRACE_A, '0000000000000002'),
        plain('leaf', TRACE_A, '0000000000000003', '0000000000000002'),
      ],
      problems: ['leaf does not descend from root'],
    },
    {
      name: 'a parent cycle',
      spans: [
        plain('root', TRACE_A, '0000000000000001'),
        plain('leaf', TRACE_A, '0000000000000002', '0000000000000003'),
        plain('loop', TRACE_A, '0000000000000003', '0000000000000002'),
      ],
      problems: ['leaf does not descend from root'],
    },
  ])('reports $name', ({ spans, problems }) => {
    expect(checkTraceContinuity(spans, { expectedSpanNames: ['root', 'leaf'] })).toEqual({ ok: false, matched: [], problems });
  });

  it('reports every failing match of the trace in which most selectors matched', () => {
    const spans = [
      plain('root', TRACE_A, '00000000000000a1'),
      plain('root', TRACE_B, '00000000000000b1'),
      plain('mid', TRACE_B, '00000000000000b2'),
      plain('mid', TRACE_B, '00000000000000b3', '00000000000000ff'),
      plain('leaf', TRACE_A, '00000000000000a2', '00000000000000a1'),
      plain('leaf', TRACE_B, '00000000000000b4', '00000000000000b1'),
    ];

    expect(checkTraceContinuity(spans, { expectedSpanNames: ['root', 'mid', /leaf/g] })).toEqual({
      ok: false,
      matched: [],
      problems: ['no parent link: mid', 'dangling parent 00000000000000ff of mid'],
    });
  });

  it('prefixes a broken chain when the best trace still lacks selectors', () => {
    const spans = [
      plain('root', TRACE_A, '0000000000000001'),
      plain('mid', TRACE_A, '0000000000000002'),
      plain('leaf', TRACE_B, '0000000000000003'),
    ];

    expect(checkTraceContinuity(spans, { expectedSpanNames: ['root', 'mid', 'leaf'] }).problems).toEqual([
      `broken chain: expected spans do not share one traceId (root -> [${TRACE_A}], mid -> [${TRACE_A}], leaf -> [${TRACE_B}])`,
      'no parent link: mid',
    ]);
  });

  it('matches every span for an empty selector', () => {
    const spans = [plain('root', TRACE_A, '0000000000000001'), plain('child', TRACE_A, '0000000000000002', '0000000000000001')];

    expect(checkTraceContinuity(spans, { expectedSpanNames: ['root', {}] })).toMatchObject({ ok: true, matched: [spans[0], spans[1]] });
    expect(checkTraceContinuity([spans[0] as ContinuitySpan], { expectedSpanNames: ['root', {}] }).problems).toEqual([
      'no parent link: *',
    ]);
  });

  it('returns a span already in continuity shape unchanged', () => {
    const span = plain('root', TRACE_A, '0000000000000001');

    expect(toContinuitySpan(span)).toBe(span);
  });

  describe('spansFromOtlpJsonLines', () => {
    const GATEWAY_LINE = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.version', value: { stringValue: '1.0.0' } }, { key: 'service.name', value: { stringValue: 'gateway' } }] },
          scopeSpans: [
            {
              scope: { name: '@opentelemetry/instrumentation-http' },
              spans: [
                { traceId: TRACE_A, spanId: '0000000000000001', parentSpanId: '', name: 'POST', kind: 2 },
                { traceId: TRACE_A, spanId: '0000000000000002', parentSpanId: '0000000000000001', name: 'POST', kind: 'SPAN_KIND_CLIENT' },
              ],
            },
          ],
        },
      ],
    });
    const PEOPLE_LINE = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'people' } }] },
          instrumentationLibrarySpans: [
            {
              spans: [
                { traceId: TRACE_A, spanId: '0000000000000003', parentSpanId: '0000000000000002', name: 'POST', kind: 'SPAN_KIND_SERVER' },
                { traceId: TRACE_A, spanId: '0000000000000004', parentSpanId: '0000000000000003', name: 'outbox.publish', kind: 4 },
              ],
            },
          ],
        },
        {
          scopeSpans: [
            {
              spans: [
                { traceId: TRACE_B, spanId: '0000000000000005', kind: 0 },
                { traceId: TRACE_B, spanId: '0000000000000006', name: 'odd', kind: 'SPAN_KIND_UNKNOWN' },
              ],
            },
            {},
          ],
        },
      ],
    });

    it('parses resource, scope and legacy library spans, skipping blank lines', () => {
      const spans = spansFromOtlpJsonLines(`\n${GATEWAY_LINE}\r\n   \n${PEOPLE_LINE}\n`);

      expect(spans).toStrictEqual([
        { name: 'POST', traceId: TRACE_A, spanId: '0000000000000001', kind: SpanKind.SERVER, service: 'gateway' },
        {
          name: 'POST',
          traceId: TRACE_A,
          spanId: '0000000000000002',
          parentSpanId: '0000000000000001',
          kind: SpanKind.CLIENT,
          service: 'gateway',
        },
        {
          name: 'POST',
          traceId: TRACE_A,
          spanId: '0000000000000003',
          parentSpanId: '0000000000000002',
          kind: SpanKind.SERVER,
          service: 'people',
        },
        {
          name: 'outbox.publish',
          traceId: TRACE_A,
          spanId: '0000000000000004',
          parentSpanId: '0000000000000003',
          kind: SpanKind.PRODUCER,
          service: 'people',
        },
        { name: '', traceId: TRACE_B, spanId: '0000000000000005' },
        { name: 'odd', traceId: TRACE_B, spanId: '0000000000000006' },
      ]);
      expect(
        checkTraceContinuity(spans, { expectedSpanNames: [{ service: 'gateway', kind: SpanKind.SERVER }, ...ARCHIVE_CHAIN.slice(1, 4)] }),
      ).toMatchObject({ ok: true, traceId: TRACE_A });
    });

    it.each([
      { name: 'an empty export', text: '' },
      { name: 'a request without resource spans', text: '{}\nnull' },
    ])('returns no spans for $name', ({ text }) => {
      expect(spansFromOtlpJsonLines(text)).toEqual([]);
    });

    it('names the line of malformed JSON', () => {
      expect(() => spansFromOtlpJsonLines(`${GATEWAY_LINE}\n\n{"resourceSpans": [`)).toThrow(/^malformed OTLP JSON on line 3: /);
    });
  });
});
