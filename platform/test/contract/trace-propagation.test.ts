import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvocationMinter } from '../../src/auth/index.js';
import {
  buildEnvelope,
  consumeEnvelope,
  createPublisher,
  decodeEnvelopeData,
  subscriptionName,
  type ConsumeOptions,
  type ConsumeOutcome,
  type EventEnvelope,
  type PublisherOptions,
  type RawMessage,
} from '../../src/events/index.js';
import { createServiceClient, type ServiceClient } from '../../src/service-kit/index.js';
import { buildCloudTask, type CloudTaskRequest } from '../../src/tasks/cloud-adapter.js';
import { tenantDbFromPool, type Pool } from '../../src/tenancy/index.js';
import { TENANT_A } from '../../src/testing/fixtures.js';
import {
  activeSpanIds,
  assertTraceContinuity,
  checkTraceContinuity,
  contextFromEnvelope,
  extractHttpContext,
  flushTracing,
  MemorySpanExporter,
  shutdownTracing,
  SpanKind,
  startSpan,
  startTracing,
  taskHeaders,
  toContinuitySpan,
  TraceContinuityError,
  type ContinuityResult,
  type ContinuitySpan,
  type ReadableSpan,
  type SpanSelector,
  type TraceCarrier,
} from '../../src/tracing/index.js';

const INBOUND = {
  traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  tracestate: 'opt2=contract',
};
const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_PARENT_ID = '00f067aa0ba902b7';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const TOPIC = 'people.person.archived.v1';
const SUBSCRIPTION = subscriptionName('timesheets', TOPIC);
const PERSON_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SCHEDULE_TIME = new Date('2026-06-30T12:00:00Z');
const TASK_BUILD = {
  project: 'opt2-plan',
  location: 'us-central1',
  invokerEmail: 'opt2-tasks-invoker@opt2-plan.iam.gserviceaccount.com',
};

const GATEWAY_SPAN = 'GET /contract/archive';
const HTTP_CLIENT_SPAN = { name: 'POST', kind: SpanKind.CLIENT };
const CALLEE_SPAN = 'POST /internal/v1/contract';
const PUBLISH_SPAN = 'outbox.publish';
const CONSUMER_SPAN = `events.consume ${SUBSCRIPTION}`;
const TASK_SPAN = 'POST /internal/v1/tasks/contract';
const EXPECTED: SpanSelector[] = [GATEWAY_SPAN, HTTP_CLIENT_SPAN, CALLEE_SPAN, PUBLISH_SPAN, CONSUMER_SPAN, TASK_SPAN];

interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
}

interface PublishedMessage {
  topic: string;
  options: unknown;
  message: RawMessage;
  messageId: string;
}

interface ChainOptions {
  dropEnvelopeContext?: boolean;
  dropTaskContext?: boolean;
  inbound?: Record<string, string>;
}

interface ChainResult {
  gatewaySpanId: string | undefined;
  http: ReceivedRequest;
  envelope: EventEnvelope;
  published: PublishedMessage;
  decoded: EventEnvelope;
  outcome: ConsumeOutcome;
  consumerSpanId: string | undefined;
  localTask: Partial<TraceCarrier>;
  cloudTask: CloudTaskRequest;
  spans: ReadableSpan[];
}

const exporter = new MemorySpanExporter();
const credentials: InvocationMinter = {
  headersFor: () => Promise.resolve({ 'X-Serverless-Authorization': 'Bearer contract' }),
};
const logger: ConsumeOptions['logger'] = {
  info: () => undefined,
  child: () => logger,
} as unknown as ConsumeOptions['logger'];
const db = tenantDbFromPool(fakePool(), { schema: 'contract_trace' });

let server: Server;
let client: ServiceClient;
let received: ReceivedRequest[] = [];

/** pg pool stand-in whose every statement succeeds and reports one affected row. */
function fakePool(): Pool {
  const pooled = {
    query: (text: string) => Promise.resolve({ command: text.split(' ', 1)[0], rows: [], rowCount: 1 }),
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(pooled), on: () => undefined, end: () => Promise.resolve() } as unknown as Pool;
}

/** Pub/Sub client stand-in recording every message into `published`. */
function fakePubSub(published: PublishedMessage[]): PublisherOptions['pubsub'] {
  const pubsub = {
    topic: (name: string, options: unknown) => ({
      publishMessage: (message: RawMessage) => {
        const messageId = `contract-${published.length + 1}`;
        published.push({ topic: name, options, message, messageId });
        return Promise.resolve(messageId);
      },
      resumePublishing: () => undefined,
      flush: () => Promise.resolve(),
    }),
    close: () => Promise.resolve(),
  };
  return pubsub as unknown as PublisherOptions['pubsub'];
}

/** Runs `fn` in a SERVER span of a fresh process context whose only parent is the trace carried by `headers`. */
function inServerSpan<T>(headers: Record<string, string | string[] | undefined>, name: string, fn: () => Promise<T>): Promise<T> {
  return context.with(extractHttpContext(headers, ROOT_CONTEXT), () => startSpan(name, SpanKind.SERVER, fn));
}

/** Trace id and parent span id of a W3C `traceparent`. */
function parseTraceparent(value: unknown): { traceId: string; parentId: string } {
  expect(value).toMatch(TRACEPARENT);
  const [, traceId = '', parentId = ''] = String(value).split('-');
  return { traceId, parentId };
}

/** The `traceparent`/`tracestate` entries present in `carrier`. */
function traceEntries(carrier: object): Partial<TraceCarrier> {
  return Object.fromEntries(
    Object.entries(carrier).filter(([name]) => name === 'traceparent' || name === 'tracestate'),
  ) as Partial<TraceCarrier>;
}

/** Spans of `run` named `name`, in continuity shape. */
function spansNamed(run: ChainResult, name: string): ContinuitySpan[] {
  return run.spans.map(toContinuitySpan).filter((span) => span.name === name);
}

/** The result carried by the TraceContinuityError that `spans` raise. */
function continuityFailure(spans: ReadableSpan[]): ContinuityResult {
  try {
    assertTraceContinuity(spans, { expectedSpanNames: EXPECTED });
  } catch (err) {
    expect(err).toBeInstanceOf(TraceContinuityError);
    return (err as TraceContinuityError).result;
  }
  throw new Error('trace continuity held although a hop dropped its context');
}

/** Gateway -> people over HTTP -> envelope -> Pub/Sub -> timesheets consumer -> Cloud Task, each hop seeded only by its carrier. */
async function runChain(options: ChainOptions = {}): Promise<ChainResult> {
  const { dropEnvelopeContext = false, dropTaskContext = false, inbound = INBOUND } = options;
  received = [];
  const published: PublishedMessage[] = [];
  const publisher = createPublisher({ projectId: 'opt2-contract', pubsub: fakePubSub(published) });

  const gatewaySpanId = await inServerSpan(inbound, GATEWAY_SPAN, async () => {
    const response = await client.request({ service: 'people', method: 'POST', path: '/internal/v1/contract', json: {} });
    expect(response.status).toBe(200);
    return activeSpanIds()?.spanId;
  });
  expect(received).toHaveLength(1);
  const [http] = received as [ReceivedRequest];

  const envelope = await inServerSpan(http.headers, CALLEE_SPAN, async () => {
    const build = () =>
      db.withTenant(TENANT_A.tenantId, () =>
        Promise.resolve(
          buildEnvelope({
            topic: TOPIC,
            aggregateType: 'person',
            aggregateId: PERSON_ID,
            aggregateVersion: 1,
            occurredAt: SCHEDULE_TIME,
            payload: { personId: PERSON_ID, siteId: TENANT_A.siteId, effectiveFrom: '2026-06-30' },
          }),
        ),
      );
    const built = await (dropEnvelopeContext ? context.with(ROOT_CONTEXT, build) : build());
    await publisher.publish(TOPIC, built);
    return built;
  });
  await publisher.close();
  expect(published).toHaveLength(1);
  const [message] = published as [PublishedMessage];
  const decoded = decodeEnvelopeData(message.message.data) as EventEnvelope;

  const consumed: { spanId?: string; localTask?: Partial<TraceCarrier>; cloudTask?: CloudTaskRequest } = {};
  const outcome = await context.with(ROOT_CONTEXT, () =>
    consumeEnvelope(
      db,
      {
        topic: TOPIC,
        kind: 'process',
        checkTenant: () => true,
        apply: () => {
          consumed.spanId = activeSpanIds()?.spanId;
          // The local adapter stores exactly these headers with each task row and needs PostgreSQL to dispatch it.
          consumed.localTask = taskHeaders();
          const build = () =>
            buildCloudTask(
              {
                queue: 'communications-reminders',
                name: 'contract-trace',
                scheduleTime: SCHEDULE_TIME,
                url: 'http://communications.test/internal/v1/tasks/contract',
                body: { personId: PERSON_ID },
                deadlineS: 60,
                tenantId: TENANT_A.tenantId,
              },
              TASK_BUILD,
            );
          consumed.cloudTask = dropTaskContext ? context.with(ROOT_CONTEXT, build) : build();
        },
      },
      decoded,
      { subscription: SUBSCRIPTION, messageId: message.messageId, logger },
    ),
  );
  const { localTask, cloudTask } = consumed;
  if (localTask === undefined || cloudTask === undefined) throw new Error('the consumer did not apply the event');

  await inServerSpan(cloudTask.httpRequest.headers, TASK_SPAN, () => Promise.resolve());
  await flushTracing();
  return {
    gatewaySpanId,
    http,
    envelope,
    published: message,
    decoded,
    outcome,
    consumerSpanId: consumed.spanId,
    localTask,
    cloudTask,
    spans: exporter.getFinishedSpans(),
  };
}

beforeAll(async () => {
  await startTracing({ serviceName: 'platform-contract-trace', version: '0.0.0', exporter });
  // A loopback callee, not a MockAgent: under the SDK only the undici instrumentation injects trace context, and a MockAgent bypasses it.
  server = createServer((req, res) => {
    received.push({ headers: req.headers, rawHeaders: req.rawHeaders });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = createServiceClient({ serviceUrls: { people: `http://127.0.0.1:${port}` }, self: 'gateway', credentials });
});

beforeEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await shutdownTracing();
});

describe('trace context propagation', () => {
  it('keeps one trace across HTTP, Pub/Sub and Cloud Tasks hops', async () => {
    const run = await runChain();

    expect(() => assertTraceContinuity(run.spans, { expectedSpanNames: EXPECTED })).not.toThrow();
    const result = checkTraceContinuity(run.spans, { expectedSpanNames: EXPECTED });
    expect(result).toMatchObject({ ok: true, traceId: INBOUND_TRACE_ID, problems: [] });
    const [gateway, httpClient, callee, publish, consumer, task] = result.matched as [
      ContinuitySpan,
      ContinuitySpan,
      ContinuitySpan,
      ContinuitySpan,
      ContinuitySpan,
      ContinuitySpan,
    ];
    for (const span of result.matched) expect(span.traceId).toBe(INBOUND_TRACE_ID);

    expect(gateway).toMatchObject({ kind: SpanKind.SERVER, parentSpanId: INBOUND_PARENT_ID, spanId: run.gatewaySpanId });
    expect(httpClient.parentSpanId).toBe(gateway.spanId);
    expect(run.http.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === 'traceparent')).toHaveLength(1);
    expect(parseTraceparent(run.http.headers.traceparent)).toEqual({ traceId: INBOUND_TRACE_ID, parentId: httpClient.spanId });
    expect(run.http.headers.tracestate).toBe(INBOUND.tracestate);
    expect(callee).toMatchObject({ kind: SpanKind.SERVER, parentSpanId: httpClient.spanId });

    expect(parseTraceparent(run.envelope.traceparent)).toEqual({ traceId: INBOUND_TRACE_ID, parentId: callee.spanId });
    expect(run.envelope.tracestate).toBe(INBOUND.tracestate);
    expect(publish).toMatchObject({ kind: SpanKind.PRODUCER, parentSpanId: callee.spanId });
    expect(run.published.topic).toBe(TOPIC);
    expect(run.published.message.orderingKey).toBe(run.envelope.aggregateId);
    expect(run.published.message.attributes.traceparent).toBe(run.envelope.traceparent);
    expect(run.published.message.attributes.tracestate).toBe(run.envelope.tracestate);
    expect(run.decoded).toEqual(run.envelope);

    const extracted = trace.getSpanContext(contextFromEnvelope(run.decoded));
    expect(extracted).toMatchObject({ traceId: INBOUND_TRACE_ID, spanId: callee.spanId, isRemote: true });
    expect(run.outcome.destinations).toEqual([{ tenantId: TENANT_A.tenantId, result: 'applied' }]);
    expect(consumer).toMatchObject({ kind: SpanKind.CONSUMER, parentSpanId: callee.spanId, spanId: run.consumerSpanId });

    expect(parseTraceparent(run.localTask.traceparent)).toEqual({ traceId: INBOUND_TRACE_ID, parentId: consumer.spanId });
    expect(run.localTask.tracestate).toBe(INBOUND.tracestate);
    const taskHeadersSent = run.cloudTask.httpRequest.headers;
    expect(parseTraceparent(taskHeadersSent.traceparent)).toEqual({ traceId: INBOUND_TRACE_ID, parentId: consumer.spanId });
    expect(taskHeadersSent.tracestate).toBe(INBOUND.tracestate);
    expect(task).toMatchObject({ kind: SpanKind.SERVER, parentSpanId: consumer.spanId });
  });

  it('reports a broken trace when the producer drops context', async () => {
    const run = await runChain({ dropEnvelopeContext: true });
    const envelopeTraceId = parseTraceparent(run.envelope.traceparent).traceId;
    expect(envelopeTraceId).not.toBe(INBOUND_TRACE_ID);

    expect(() => assertTraceContinuity(run.spans, { expectedSpanNames: EXPECTED })).toThrow(TraceContinuityError);
    const result = continuityFailure(run.spans);
    expect(result).toMatchObject({ ok: false, matched: [] });
    expect(result.traceId).toBeUndefined();
    const [consumer] = spansNamed(run, CONSUMER_SPAN);
    const [gateway] = spansNamed(run, GATEWAY_SPAN);
    expect(new Set([gateway?.traceId, consumer?.traceId]).size).toBe(2);
    expect(consumer?.traceId).toBe(envelopeTraceId);
    expect(result.problems[0]).toMatch(/^broken chain: expected spans do not share one traceId/);
    expect(result.problems[0]).toContain(`${GATEWAY_SPAN} -> [${INBOUND_TRACE_ID}]`);
    expect(result.problems[0]).toContain(`${CONSUMER_SPAN} -> [${envelopeTraceId}]`);
  });

  it('reports a broken trace when a task is created outside the active context', async () => {
    const run = await runChain({ dropTaskContext: true });
    expect(traceEntries(run.cloudTask.httpRequest.headers)).toEqual({});
    expect(parseTraceparent(run.localTask.traceparent).traceId).toBe(INBOUND_TRACE_ID);

    expect(() => assertTraceContinuity(run.spans, { expectedSpanNames: EXPECTED })).toThrow(TraceContinuityError);
    const result = continuityFailure(run.spans);
    expect(result).toMatchObject({ ok: false, matched: [] });
    const [task] = spansNamed(run, TASK_SPAN);
    expect(task?.parentSpanId).toBeUndefined();
    expect(task?.traceId).not.toBe(INBOUND_TRACE_ID);
    expect(result.problems[0]).toContain(`${CONSUMER_SPAN} -> [${INBOUND_TRACE_ID}]`);
    expect(result.problems[0]).toContain(`${TASK_SPAN} -> [${task?.traceId}]`);
  });

  it.each([
    { label: 'with an inbound tracestate', inbound: INBOUND, tracestate: INBOUND.tracestate },
    { label: 'without an inbound tracestate', inbound: { traceparent: INBOUND.traceparent }, tracestate: undefined },
  ])('emits W3C trace headers $label', async ({ inbound, tracestate }) => {
    const run = await runChain({ inbound });
    const carriers = {
      http: run.http.headers,
      envelope: run.envelope,
      attributes: run.published.message.attributes,
      wire: run.decoded,
      localTask: run.localTask,
      cloudTask: run.cloudTask.httpRequest.headers,
    };
    for (const [hop, carrier] of Object.entries(carriers)) {
      const entries = traceEntries(carrier);
      const { traceId } = parseTraceparent(entries.traceparent);
      expect(traceId, hop).toBe(INBOUND_TRACE_ID);
      expect(Object.keys(entries).sort(), hop).toEqual(tracestate === undefined ? ['traceparent'] : ['traceparent', 'tracestate']);
      expect(entries.tracestate, hop).toBe(tracestate);
    }
  });
});
