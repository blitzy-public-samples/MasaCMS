// The handlers' request log line carries the web request span's trace fields, over the tracing SDK and the real logger.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER } from '@opt2/platform/auth';
import { validateLogRecord } from '@opt2/platform/logging';
import {
  SpanKind,
  flushTracing,
  shutdownTracing,
  type MemorySpanExporter,
  type StartTracingOptions,
} from '@opt2/platform/tracing';
import { GatewayUnavailableError, setServiceClientForTests } from '@/lib/gateway-client';
import { createWebLogger, setWebLoggerForTests } from '@/lib/telemetry';
import type { SubmitResult } from '@/screens/registry';
import { siteRecordFor } from '../helpers/admin-request';
import { useTestEnv } from '../helpers/env';
import { routeKey, startFakeGateway, type FakeGateway } from '../helpers/fake-gateway';
import { SUBJECTS, gatewayInvocation, userTokenFor } from '../helpers/tokens';

const tracing = vi.hoisted(() => ({ exporter: undefined as MemorySpanExporter | undefined }));
const screen = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

// Pass-through that swaps the OTLP exporter for an in-memory one, so no span leaves the process.
vi.mock('@opt2/platform/tracing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/tracing')>();
  const exporter = new actual.MemorySpanExporter();
  tracing.exporter = exporter;
  return {
    ...actual,
    startTracing: vi.fn((options: StartTracingOptions) => actual.startTracing({ ...options, exporter })),
  };
});

vi.mock('@/screens/registry', async () => {
  const { raw } = await import('@/lib/html');
  const update = {
    circuit: 'cusers',
    action: 'update',
    mode: 'redirect',
    owner: 'people',
    gate: () => ({ kind: 'allow' }),
    submit: (): Promise<SubmitResult> =>
      screen.failure === undefined
        ? Promise.resolve({ kind: 'location', location: './' })
        : Promise.reject(screen.failure),
  };
  return {
    findScreen: (circuit: string, action: string) => (circuit === 'cusers' && action === 'update' ? update : undefined),
    findOpt2Screen: () => undefined,
    findOpt2Action: () => undefined,
    shellHooks: { secondaryMenus: {}, contentNav: () => raw('') },
  };
});

const { handleAdminAction } = await import('@/lib/handlers');

const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const SPAN_NAME = 'POST redirect:cusers.update';
const admin = SUBJECTS.admin;

let fake: FakeGateway;
const cleanups: (() => void)[] = [];
let lines: Record<string, unknown>[];

beforeEach(async () => {
  fake = await startFakeGateway({
    [routeKey('GET', 'identity', '/v1/sessions/current')]: {
      status: 200,
      body: {
        sessionId: admin.sid,
        epoch: 0,
        user: {
          isLoggedIn: true,
          userID: admin.sub,
          siteID: admin.site,
          memberships: 'S2IsPrivate;default,S2IsPrivate,S2',
        },
        roles: [...admin.roles],
        mfaPending: false,
        blockLoginUntil: null,
      },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/sites')]: {
      status: 200,
      body: { sites: [{ siteID: 'default', site: 'Default' }] },
    },
    [routeKey('GET', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: {} },
    [routeKey('POST', 'identity', '/v1/sessions/current/admin-state')]: { status: 200, body: {} },
    [routeKey('GET', 'programs-sites', '/v1/sites/default/shell')]: {
      status: 200,
      body: { site: siteRecordFor('default'), isNew: 0 },
    },
  });
  cleanups.push(useTestEnv({ OPT2_GATEWAY_URL: fake.url, OTEL_EXPORTER_OTLP_ENDPOINT: undefined }));
  cleanups.push(setServiceClientForTests(undefined));
  lines = [];
  const write = (chunk: string): void => {
    for (const text of chunk.split('\n')) if (text !== '') lines.push(JSON.parse(text) as Record<string, unknown>);
  };
  cleanups.push(setWebLoggerForTests(createWebLogger({ write })));
  screen.failure = undefined;
  await flushTracing();
  tracing.exporter?.reset();
});

afterEach(async () => {
  for (let restore = cleanups.pop(); restore !== undefined; restore = cleanups.pop()) restore();
  await fake.close();
});

afterAll(async () => {
  await shutdownTracing();
});

/** A POST of cusers.update as the gateway forwards it for the S2 admin, continuing the inbound trace. */
async function updateRequest(): Promise<Request> {
  const token = await userTokenFor(admin);
  if (token === undefined) throw new Error('admin has no user token');
  return new Request('http://web/admin-actions/cusers/update?muraAction=cusers.update', {
    method: 'POST',
    headers: {
      [INVOCATION_HEADER]: `Bearer ${await gatewayInvocation()}`,
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
      traceparent: `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`,
      'x-forwarded-host': 'localhost',
      'x-forwarded-proto': 'http',
      'x-request-id': 'req-trace',
    },
    body: 'userid=U1',
  });
}

describe('request log line', () => {
  it.each<{ outcome: string; status: number; failure?: Error; rethrown?: boolean }>([
    { outcome: 'an answered request', status: 302 },
    { outcome: 'a mapped 503', status: 503, failure: new GatewayUnavailableError('people', 503) },
    { outcome: 'a rethrown error', status: 500, failure: new RangeError('screen failed'), rethrown: true },
  ])('identifies the web request span for $outcome', async ({ status, failure, rethrown }) => {
    screen.failure = failure;

    const answered = handleAdminAction(await updateRequest(), { circuit: 'cusers', action: 'update' });
    if (rethrown === true) await expect(answered).rejects.toBe(failure);
    else expect((await answered).status).toBe(status);

    await flushTracing();
    const spans = (tracing.exporter?.getFinishedSpans() ?? []).filter((span) => span.name === SPAN_NAME);
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.parentSpanContext?.spanId).toBe(INBOUND_SPAN_ID);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(validateLogRecord(line).errors).toEqual([]);
    expect(line).toMatchObject({
      message: 'request',
      route: 'redirect:cusers.update',
      httpMethod: 'POST',
      statusCode: status,
      requestId: 'req-trace',
      userId: admin.sub,
      traceId: INBOUND_TRACE_ID,
      spanId: span?.spanContext().spanId,
      traceSampled: true,
    });
    expect(line?.error === undefined).toBe(failure === undefined);
  });
});
