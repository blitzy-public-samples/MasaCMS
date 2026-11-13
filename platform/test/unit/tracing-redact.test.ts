import type * as Http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Span,
  type SpanStatus,
} from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { REDACTED } from '../../src/logging/redact.js';
import { SERVICE_CALLERS } from '../../src/testing/tokens.js';
import { startSpan } from '../../src/tracing/propagation.js';
import { RedactingSpanExporter } from '../../src/tracing/redact.js';
import {
  flushTracing,
  MemorySpanExporter,
  shutdownTracing,
  startTracing,
  type ReadableSpan,
  type SpanExporter,
} from '../../src/tracing/sdk.js';

/** Synthetic credential assembled at run time, so no literal secret appears in source. */
const SECRET = ['c10', 'sentinel', 'value'].join('-');
const PATH = '/internal/v1/events/people-person-archived';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const PARENT_SPAN_ID = 'b7ad6b7169203331';
const LINKED_SPAN_ID = '53995c3f42cd8ad8';
const UNAVAILABLE = 'Service identity unavailable (ECONNREFUSED)';

/** Plain finished server span; `overrides` replace its members. */
function readable(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  const spanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
  return {
    name: 'GET',
    kind: SpanKind.SERVER,
    spanContext: () => spanContext,
    parentSpanContext: { traceId: TRACE_ID, spanId: PARENT_SPAN_ID, traceFlags: TraceFlags.SAMPLED, isRemote: true },
    startTime: [1_700_000_000, 100],
    endTime: [1_700_000_001, 250],
    duration: [1, 150],
    ended: true,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    resource: resourceFromAttributes({ 'service.name': 'tracing-redact-c10-worker' }),
    instrumentationScope: { name: '@opentelemetry/instrumentation-http', version: '0.300.0' },
    droppedAttributesCount: 1,
    droppedEventsCount: 2,
    droppedLinksCount: 3,
    ...overrides,
  };
}

/** The copy of `span` a {@link RedactingSpanExporter} hands its delegate. */
function redact(span: ReadableSpan): ReadableSpan {
  const memory = new MemorySpanExporter();
  new RedactingSpanExporter(memory).export([span], () => undefined);
  const [copy] = memory.getFinishedSpans();
  if (!copy) throw new Error('no span exported');
  return copy;
}

/** Everything an exporter could serialise from `spans`, ids and resource included. */
function serialized(spans: ReadableSpan[]): string {
  return JSON.stringify(
    spans.map((span) => ({ ...span, spanContext: span.spanContext(), resource: span.resource.attributes })),
  );
}

describe('RedactingSpanExporter', () => {
  it.each<{ key: string; value: AttributeValue; expected: AttributeValue }>([
    { key: 'url.query', value: `?key=${SECRET}&token=${SECRET}&${SECRET}`, expected: `?key=${REDACTED}&token=${REDACTED}&${REDACTED}` },
    { key: 'url.query', value: `page=2&sort=${SECRET}&${SECRET}=`, expected: `page=${REDACTED}&sort=${REDACTED}&${REDACTED}` },
    {
      key: 'url.full',
      value: `http://user:${SECRET}@people:8112${PATH}?key=${SECRET}&${SECRET}#top`,
      expected: `http://${REDACTED}@people:8112${PATH}?key=${REDACTED}&${REDACTED}#top`,
    },
    { key: 'url.full', value: `http://people:8112${PATH}`, expected: `http://people:8112${PATH}` },
    { key: 'url.path', value: `/opt2/stub/x/${SECRET}%40example.test/next`, expected: `/opt2/stub/x/${REDACTED}/next` },
    {
      key: 'url.full',
      value: `http://stub:8199/opt2/stub/x/${SECRET}%40example.test?key=${SECRET}`,
      expected: `http://stub:8199/opt2/stub/x/${REDACTED}?key=${REDACTED}`,
    },
    { key: 'url.path', value: `/opt2/stub/x/${SECRET}%2540example.test/next`, expected: `/opt2/stub/x/${REDACTED}/next` },
    { key: 'url.path', value: `/opt2/stub/y/password%3d${SECRET}`, expected: `/opt2/stub/y/password%3d${REDACTED}` },
    {
      key: 'url.full',
      value: `http://stub:8199/opt2/stub/y/token%253A${SECRET}`,
      expected: `http://stub:8199/opt2/stub/y/token%253A${REDACTED}`,
    },
    { key: 'http.target', value: `/cb/%3Fexpires%3D1%26sig%3D${SECRET}`, expected: `/cb/%3Fexpires%3D1%26sig%3D${REDACTED}` },
    { key: 'opt2.note', value: `%7B%22password%22%3A%22${SECRET}%22%7D`, expected: `%7B%22password%22%3A${REDACTED}` },
    { key: 'http.target', value: `${PATH}?key=${SECRET}&token=${SECRET}`, expected: `${PATH}?key=${REDACTED}&token=${REDACTED}` },
    { key: 'http.url', value: `https://REDACTED:REDACTED@h${PATH}?code=${SECRET}`, expected: `https://${REDACTED}@h${PATH}?code=${REDACTED}` },
    {
      key: 'db.query.text',
      value: `CREATE ROLE c10_people_app LOGIN PASSWORD '${SECRET}'`,
      expected: `CREATE ROLE c10_people_app LOGIN PASSWORD '${REDACTED}'`,
    },
    {
      key: 'db.statement',
      value: `SELECT "full""name" FROM people.person WHERE email = '${SECRET}''s' AND note = E'it\\'s ${SECRET}' AND body = $q$${SECRET}$q$ AND alt = $$${SECRET}$$ AND id = $1`,
      expected: `SELECT "full""name" FROM people.person WHERE email = '${REDACTED}' AND note = '${REDACTED}' AND body = '${REDACTED}' AND alt = '${REDACTED}' AND id = $1`,
    },
    {
      key: 'db.query.text',
      value: `-- don't log\nALTER ROLE r PASSWORD '${SECRET}' /* it's */`,
      expected: `-- ${REDACTED}\nALTER ROLE r PASSWORD '${REDACTED}' /* ${REDACTED} */`,
    },
    { key: 'db.query.text', value: `SELECT 1 WHERE x = '${SECRET}`, expected: `SELECT ${REDACTED} WHERE x = '${REDACTED}'` },
    { key: 'db.query.text', value: `SELECT "open FROM t WHERE x = '${SECRET}'`, expected: `SELECT '${REDACTED}'` },
    { key: 'db.postgresql.values', value: [SECRET, `${SECRET}@example.com`], expected: [REDACTED, REDACTED] },
    { key: 'http.request.header.authorization', value: [`Bearer ${SECRET}`], expected: [REDACTED] },
    { key: 'http.request.header.proxy-authorization', value: [`Basic ${SECRET}`], expected: [REDACTED] },
    { key: 'http.request.header.x-serverless-authorization', value: [SECRET], expected: [REDACTED] },
    { key: 'http.request.header.cookie', value: [`sid=${SECRET}`], expected: [REDACTED] },
    { key: 'http.response.header.set-cookie', value: [`a=${SECRET}`, `b=${SECRET}`], expected: [REDACTED, REDACTED] },
    { key: 'opt2.note', value: `retry token=${SECRET} for ${SECRET}@example.com`, expected: `retry token=${REDACTED} for ${REDACTED}` },
    { key: 'opt2.tags', value: [`password=${SECRET}`, 'plain'], expected: [`password=${REDACTED}`, 'plain'] },
    { key: 'exception.message', value: `invalid input syntax for type uuid: "${SECRET}"`, expected: REDACTED },
    { key: 'exception.message', value: UNAVAILABLE, expected: UNAVAILABLE },
    { key: 'exception.message', value: `Service ${SECRET}@example.com unavailable (ECONNREFUSED)`, expected: REDACTED },
    {
      key: 'exception.stacktrace',
      value: `SyntaxError: Unexpected token 'o', "of ${SECRET}" is not valid JSON\n    at JSON.parse (<anonymous>)`,
      expected: `${REDACTED}\n    at JSON.parse (<anonymous>)`,
    },
  ])('masks $key value $value', ({ key, value, expected }) => {
    const copy = redact(readable({ attributes: { [key]: value } }));

    expect(copy.attributes[key]).toEqual(expected);
    expect(serialized([copy])).not.toContain(SECRET);
  });

  it('keeps safe attributes and every identity, timing, resource and scope member', () => {
    const attributes: Attributes = {
      'http.request.method': 'GET',
      'url.path': PATH,
      'url.scheme': 'http',
      'http.route': '/internal/v1/events/:subscription',
      'http.response.status_code': 200,
      'server.port': 8112,
      'opt2.retried': false,
      'opt2.sizes': [1, 2, 3],
      'opt2.flags': [true, false],
      'opt2.ids': [TRACE_ID, '6f1f1c1e-8b0a-4c47-9f6d-0a6d2ad1c1c2'],
    };
    const span = readable({ name: 'GET /internal/v1/events/:subscription', attributes });

    const copy = redact(span);

    expect(copy).not.toBe(span);
    expect(copy.attributes).toEqual(attributes);
    expect(copy.spanContext()).toEqual(span.spanContext());
    expect(copy).toMatchObject({
      name: 'GET /internal/v1/events/:subscription',
      kind: SpanKind.SERVER,
      parentSpanContext: span.parentSpanContext,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      ended: true,
      status: span.status,
      droppedAttributesCount: 1,
      droppedEventsCount: 2,
      droppedLinksCount: 3,
    });
    expect(copy.resource).toBe(span.resource);
    expect(copy.instrumentationScope).toBe(span.instrumentationScope);
  });

  it.each<{ name: string; path: string; expected?: string }>([
    { name: 'a double-encoded email', path: `/opt2/stub/x/${SECRET}%2540example.test`, expected: `/opt2/stub/x/${REDACTED}` },
    { name: 'an encoded secret pair', path: `/opt2/stub/y/session%3A${SECRET}`, expected: `/opt2/stub/y/session%3A${REDACTED}` },
    { name: 'an e-signature path', path: '/opt2/e-signature/envelopes/A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6%3Asign' },
    {
      name: 'an encoded object path',
      path: '/opt2/files/esignature-documents%2Fedec963e-3516-5bb6-845d-d01a710e32a7%2Fesignature%3A1.pdf',
    },
    { name: 'a word containing sig', path: '/opt2/people/Designation%3DManager' },
    { name: 'malformed escapes', path: '/opt2/stub/y/password%3G1/x%2Gsig%3D1/bob%254example.test' },
  ])('applies one result for $name to the span name, url.path and url.full', ({ path, expected = path }) => {
    const copy = redact(readable({ name: `GET ${path}`, attributes: { 'url.path': path, 'url.full': `http://stub:8199${path}` } }));

    expect(copy.name).toBe(`GET ${expected}`);
    expect(copy.attributes).toEqual({ 'url.path': expected, 'url.full': `http://stub:8199${expected}` });
    expect(serialized([copy])).not.toContain(SECRET);
  });

  it.each(SERVICE_CALLERS)('keeps the client span name of callee %s', (service) => {
    expect(redact(readable({ name: `POST ${service}`, kind: SpanKind.CLIENT })).name).toBe(`POST ${service}`);
  });

  it.each<{ name: string; status: SpanStatus; expected: SpanStatus }>([
    {
      name: 'a URL with userinfo',
      status: { code: SpanStatusCode.ERROR, message: `connect ECONNREFUSED http://u:${SECRET}@people:8112${PATH}?key=${SECRET}` },
      expected: { code: SpanStatusCode.ERROR, message: REDACTED },
    },
    {
      name: 'a database error echoing a literal',
      status: { code: SpanStatusCode.ERROR, message: `syntax error at or near "'${SECRET}'"` },
      expected: { code: SpanStatusCode.ERROR, message: REDACTED },
    },
    { name: 'no message', status: { code: SpanStatusCode.OK }, expected: { code: SpanStatusCode.OK } },
    {
      name: 'a safe service-unavailable text',
      status: { code: SpanStatusCode.ERROR, message: UNAVAILABLE },
      expected: { code: SpanStatusCode.ERROR, message: UNAVAILABLE },
    },
  ])('masks a status message with $name', ({ status, expected }) => {
    const copy = redact(readable({ status }));

    expect(copy.status).toEqual(expected);
    expect(serialized([copy])).not.toContain(SECRET);
  });

  it('masks the span name, events and links without touching the original', () => {
    const linkContext = { traceId: TRACE_ID, spanId: LINKED_SPAN_ID, traceFlags: TraceFlags.SAMPLED };
    const stack = `Error: GET ${PATH}?key=${SECRET} failed\n    at handler (/srv/people/dist/main.js:10:5)`;
    const span = readable({
      name: `deliver token=${SECRET}`,
      status: { code: SpanStatusCode.ERROR, message: `password=${SECRET}` },
      events: [
        {
          name: 'exception',
          time: [1_700_000_000, 500],
          attributes: { 'exception.type': 'Error', 'exception.message': `password=${SECRET}`, 'exception.stacktrace': stack },
          droppedAttributesCount: 0,
        },
        { name: `retry for ${SECRET}@example.com`, time: [1_700_000_000, 600] },
      ],
      links: [{ context: linkContext, attributes: { 'opt2.cause': `session=${SECRET}`, 'opt2.attempt': 2 } }],
    });
    const before = structuredClone({ ...span, spanContext: undefined, resource: undefined });

    const copy = redact(span);

    expect(serialized([copy])).not.toContain(SECRET);
    expect(copy.name).toBe(`deliver token=${REDACTED}`);
    expect(copy.status).toEqual({ code: SpanStatusCode.ERROR, message: REDACTED });
    expect(copy.events).toEqual([
      {
        name: 'exception',
        time: [1_700_000_000, 500],
        attributes: {
          'exception.type': 'Error',
          'exception.message': REDACTED,
          'exception.stacktrace': `Error: ${REDACTED}\n    at handler (/srv/people/dist/main.js:10:5)`,
        },
        droppedAttributesCount: 0,
      },
      { name: `retry for ${REDACTED}`, time: [1_700_000_000, 600], attributes: undefined },
    ]);
    expect(copy.links).toEqual([{ context: linkContext, attributes: { 'opt2.cause': `session=${REDACTED}`, 'opt2.attempt': 2 } }]);
    expect(structuredClone({ ...span, spanContext: undefined, resource: undefined })).toEqual(before);
  });

  it('masks literals in a database span name derived from query text', () => {
    const copy = redact(readable({ name: `pg.query:SELECT'${SECRET}' app`, attributes: { 'db.query.text': `SELECT'${SECRET}'` } }));

    expect(copy.name).toBe(`pg.query:SELECT'${REDACTED}' app`);
    expect(redact(readable({ name: 'pg.query:SELECT app', attributes: { 'db.query.text': 'SELECT 1' } })).name).toBe(
      'pg.query:SELECT app',
    );
  });

  it('passes the export result through and delegates flush and shutdown', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const delegate: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error('collector down') }),
      shutdown,
    };
    const exporter = new RedactingSpanExporter(delegate);
    const done = vi.fn();
    const flushed = new MemorySpanExporter();
    const forceFlush = vi.spyOn(flushed, 'forceFlush');

    exporter.export([readable()], done);

    expect(done).toHaveBeenCalledWith({ code: ExportResultCode.FAILED, error: new Error('collector down') });
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await exporter.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
    await new RedactingSpanExporter(flushed).forceFlush();
    expect(forceFlush).toHaveBeenCalledOnce();
  });
});

describe('tracing privacy end to end', () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  async function traced(): Promise<MemorySpanExporter> {
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName: 'tracing-redact-c10-worker', version: '1.0.0', exporter });
    return exporter;
  }

  it('exports HTTP and undici client and server spans without query values or credentials, keeping their trace', async () => {
    const exporter = await traced();
    const http = createRequire(import.meta.url)('http') as typeof Http;
    const received: string[] = [];
    const server = http.createServer((request, response) => {
      received.push(request.url ?? '');
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const target = `${PATH}?key=${SECRET}&token=${SECRET}&${SECRET}`;
    try {
      await startSpan('deliver', SpanKind.INTERNAL, async () => {
        await new Promise<void>((resolve, reject) => {
          http
            .get({ host: '127.0.0.1', port, path: target, auth: `user:${SECRET}`, agent: false }, (response) => {
              response.resume();
              response.on('end', resolve);
            })
            .on('error', reject);
        });
        const response = await fetch(`http://127.0.0.1:${port}${target}`);
        await response.text();
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await flushTracing();
    const spans = exporter.getFinishedSpans();
    const outer = spans.find((span) => span.name === 'deliver');
    const clients = spans.filter((span) => span.kind === SpanKind.CLIENT);
    const servers = spans.filter((span) => span.kind === SpanKind.SERVER);

    expect(received).toEqual([target, target]);
    expect(clients.map((span) => span.instrumentationScope.name).sort()).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-undici',
    ]);
    expect(servers).toHaveLength(2);
    const text = serialized(spans);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(Buffer.from(`user:${SECRET}`).toString('base64'));
    for (const client of clients) {
      expect(client.name).toBe('GET');
      expect(client.spanContext().traceId).toBe(outer?.spanContext().traceId);
      expect(client.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
      expect(client.attributes['url.full']).toMatch(new RegExp(`:${port}${PATH}\\?key=\\[REDACTED\\]&token=\\[REDACTED\\]&\\[REDACTED\\]$`));
      expect(client.attributes['http.response.status_code']).toBe(200);
      const server = servers.find((span) => span.parentSpanContext?.spanId === client.spanContext().spanId);
      expect(server?.spanContext().traceId).toBe(outer?.spanContext().traceId);
      expect(server?.attributes['url.path']).toBe(PATH);
      expect(server?.attributes['url.query']).toBe(`key=${REDACTED}&token=${REDACTED}&${REDACTED}`);
      expect(server?.ended).toBe(true);
    }
  });

  const SYSTEM_MESSAGE = 'connect ECONNREFUSED';
  const DATABASE_MESSAGE = 'PostgreSQL error 22P02';

  it.each<{ name: string; thrown: unknown; recorded: unknown; type: string | undefined; message: string }>([
    {
      name: 'an Error',
      thrown: new Error(`GET ${PATH}?key=${SECRET} failed for ${SECRET}@example.com`),
      recorded: { name: 'Error', message: REDACTED, stack: expect.stringMatching(/^Error: \[REDACTED\]\n {4}at \S/) },
      type: 'Error',
      message: REDACTED,
    },
    {
      name: 'a system error',
      thrown: Object.assign(new Error(`connect ECONNREFUSED token=${SECRET}`), { code: 'ECONNREFUSED', syscall: 'connect' }),
      recorded: { name: 'Error', code: 'ECONNREFUSED', message: SYSTEM_MESSAGE, stack: expect.stringMatching(/^Error: connect ECONNREFUSED\n {4}at \S/) },
      type: 'ECONNREFUSED',
      message: SYSTEM_MESSAGE,
    },
    {
      name: 'a database error echoing its input',
      thrown: Object.assign(new Error(`invalid input syntax for type uuid: "${SECRET}"`), { code: '22P02', severity: 'ERROR' }),
      recorded: { name: 'Error', code: '22P02', message: DATABASE_MESSAGE, stack: expect.stringMatching(/^Error: PostgreSQL error 22P02\n {4}at \S/) },
      type: '22P02',
      message: DATABASE_MESSAGE,
    },
    { name: 'a string', thrown: `password=${SECRET}`, recorded: REDACTED, type: undefined, message: REDACTED },
  ])('startSpan records $name without its secret and rethrows it unchanged', async ({ thrown, recorded, type, message }) => {
    const exporter = await traced();
    let recordException: MockInstance<Span['recordException']> | undefined;

    await expect(
      startSpan('fail', SpanKind.INTERNAL, (span) => {
        recordException = vi.spyOn(span, 'recordException');
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await flushTracing();
    const [span] = exporter.getFinishedSpans();

    expect(recordException?.mock.calls).toEqual([[recorded]]);
    expect(JSON.stringify(recordException?.mock.calls)).not.toContain(SECRET);
    expect(String(thrown instanceof Error ? thrown.stack : thrown)).toContain(SECRET);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events[0]?.attributes?.['exception.message']).toBe(message);
    expect(span?.events[0]?.attributes?.['exception.type']).toBe(type);
    expect(serialized(span ? [span] : [])).not.toContain(SECRET);
  });
});
