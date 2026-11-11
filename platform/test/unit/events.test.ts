import { fileURLToPath } from 'node:url';
import type { PubSub } from '@google-cloud/pubsub';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEAD_LETTER_REASONS,
  DeadLetterError,
  describeDeadLetter,
  isDeadLetterReason,
  originalAttributes,
  publishDeadLetter,
  type DeadLetterDescription,
} from '../../src/events/dlq.js';
import {
  ENVELOPE_ATTRIBUTE_KEYS,
  EnvelopeTenantError,
  buildEnvelope,
  currentConsumedEnvelope,
  decodeEnvelopeData,
  encodeEnvelope,
  envelopeAttributes,
  runWithConsumedEnvelope,
  type BuildEnvelopeInput,
  type EventEnvelope,
} from '../../src/events/envelope.js';
import {
  InvalidEventNameError,
  PUSH_PATH_PREFIX,
  consumerOfSubscription,
  dlqReplaySubscriptionName,
  dlqTopicName,
  eventTypeOf,
  isTopicName,
  parseTopic,
  pushPath,
  schemaVersionOf,
  subscriptionName,
  topicName,
  topicOfSubscription,
  topicSchemaRelativePath,
} from '../../src/events/naming.js';
import { EnvelopePublishError, createPublisher, type PublisherOptions, type RawMessage } from '../../src/events/publisher.js';
import { buildPushBody, decodePushBody, type DecodedPush, type PushBodyInput } from '../../src/events/push.js';
import {
  ENVELOPE_SCHEMA_ID,
  TopicSchemaError,
  compileTopicSchema,
  envelopeSchema,
  readTopicSchema,
  topicMeta,
  validateEnvelope,
  type TopicValidator,
} from '../../src/events/validation.js';
import { newRequestContext, runWithRequestContext } from '../../src/service-kit/context.js';
import { InvalidTenantIdError } from '../../src/tenancy/tenant-id.js';
import { runTenantTransaction } from '../../src/tenancy/transaction.js';
import { createCapturingPublisher, testEnvelope } from '../../src/testing/events.js';
import { TENANT_A, TENANT_B } from '../../src/testing/fixtures.js';
import {
  MemorySpanExporter,
  SpanKind,
  SpanStatusCode,
  flushTracing,
  shutdownTracing,
  startSpan,
  startTracing,
} from '../../src/tracing/index.js';

const pubsubConstructor = vi.hoisted(() => vi.fn());

vi.mock('@google-cloud/pubsub', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/pubsub')>()),
  PubSub: pubsubConstructor,
}));

const SEGMENT_FORM = 'a name segment matching ^[a-z][a-z0-9-]*$';
const TOPIC_FORM = '<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const SUBSCRIPTION_FORM = '<consumer>.<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const MAJOR_FORM = 'a positive integer major version';

const TOPIC = 'people.person.archived.v1';
const SUBSCRIPTION = 'timesheets.people.person.archived.v1';

const CATALOGUE_TOPICS = [
  'programs-sites.site.changed.v1',
  'identity.group.changed.v1',
  'identity.permission.changed.v1',
  'identity.membership.changed.v1',
  'identity.login-mail.requested.v1',
  'people.person.changed.v1',
  'people.person.archived.v1',
  'surveys.survey.scheduled.v1',
  'communications.message.delivery-status-changed.v1',
  'stub.note.created.v1',
];

const INVALID_TOPICS: ReadonlyArray<readonly [string, string]> = [
  ['an empty string', ''],
  ['a missing major', 'people.person.archived'],
  ['a major without the v prefix', 'people.person.archived.1'],
  ['major zero', 'people.person.archived.v0'],
  ['a zero-padded major', 'people.person.archived.v01'],
  ['an upper-case segment', 'People.person.archived.v1'],
  ['a segment starting with a digit', 'people.1person.archived.v1'],
  ['a segment starting with a hyphen', 'people.person.-archived.v1'],
  ['an underscore', 'people.person_record.archived.v1'],
  ['an empty segment', 'people..archived.v1'],
  ['an extra segment', 'people.person.record.archived.v1'],
  ['a dead-letter suffix', `${TOPIC}.dlq`],
  ['surrounding whitespace', ` ${TOPIC} `],
  ['a trailing newline', `${TOPIC}\n`],
];

const INVALID_SUBSCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['an empty string', ''],
  ['a name without a dot', 'timesheets'],
  ['a bare topic', TOPIC],
  ['an empty consumer', `.${TOPIC}`],
  ['an upper-case consumer', `Timesheets.${TOPIC}`],
  ['a consumer starting with a digit', `1timesheets.${TOPIC}`],
  ['a topic without a major', 'timesheets.people.person.archived'],
  ['a topic with major zero', 'timesheets.people.person.archived.v0'],
  ['a dead-letter topic', `${SUBSCRIPTION}.dlq`],
  ['a push path', `${PUSH_PATH_PREFIX}${SUBSCRIPTION}`],
  ['a trailing space', `${SUBSCRIPTION} `],
];

const TOPIC_HELPERS: ReadonlyArray<readonly [string, (topic: string) => unknown]> = [
  ['parseTopic', parseTopic],
  ['eventTypeOf', eventTypeOf],
  ['schemaVersionOf', schemaVersionOf],
  ['topicSchemaRelativePath', topicSchemaRelativePath],
  ['subscriptionName', (topic) => subscriptionName('timesheets', topic)],
];

const SUBSCRIPTION_HELPERS: ReadonlyArray<readonly [string, (subscription: string) => string]> = [
  ['consumerOfSubscription', consumerOfSubscription],
  ['topicOfSubscription', topicOfSubscription],
  ['pushPath', pushPath],
  ['dlqTopicName', dlqTopicName],
  ['dlqReplaySubscriptionName', dlqReplaySubscriptionName],
];

/** Asserts that `fn` throws an InvalidEventNameError quoting `value` and naming the `expected` form. */
function expectNameError(fn: () => unknown, value: string, expected: string): void {
  expect(fn).toThrow(InvalidEventNameError);
  expect(fn).toThrow(`Invalid event name "${value}": expected ${expected}`);
}

describe('InvalidEventNameError', () => {
  it('is a named Error quoting the value and the expected form', () => {
    const error = new InvalidEventNameError('Bad.Name', 'a form');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidEventNameError');
    expect(error.message).toBe('Invalid event name "Bad.Name": expected a form');
  });
});

describe('topicName', () => {
  it('defaults the major version to 1', () => {
    expect(topicName('people', 'person', 'archived')).toBe(TOPIC);
  });

  it('appends an explicit major version', () => {
    expect(topicName('surveys', 'survey', 'scheduled', 2)).toBe('surveys.survey.scheduled.v2');
  });

  it.each([
    { service: 'People', entity: 'person', event: 'archived', bad: 'People' },
    { service: '', entity: 'person', event: 'archived', bad: '' },
    { service: 'people', entity: 'person_record', event: 'archived', bad: 'person_record' },
    { service: 'people', entity: '1person', event: 'archived', bad: '1person' },
    { service: 'people', entity: 'person', event: 'archived.v1', bad: 'archived.v1' },
    { service: 'people', entity: 'person', event: '-archived', bad: '-archived' },
  ])('rejects segment "$bad"', ({ service, entity, event, bad }) => {
    expectNameError(() => topicName(service, entity, event), bad, SEGMENT_FORM);
  });

  it('rejects a non-string segment', () => {
    expectNameError(() => topicName('people', null as unknown as string, 'archived'), 'null', SEGMENT_FORM);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects major %s',
    (major) => {
      expectNameError(() => topicName('people', 'person', 'archived', major), String(major), MAJOR_FORM);
    },
  );
});

describe('parseTopic', () => {
  it('splits a topic into its segments and numeric major', () => {
    expect(parseTopic('communications.message.delivery-status-changed.v12')).toEqual({
      service: 'communications',
      entity: 'message',
      event: 'delivery-status-changed',
      major: 12,
    });
  });

  it.each(CATALOGUE_TOPICS)('round-trips %s through topicName', (topic) => {
    const { service, entity, event, major } = parseTopic(topic);
    expect(topicName(service, entity, event, major)).toBe(topic);
  });
});

describe.each(TOPIC_HELPERS)('%s', (_helperName, helper) => {
  it.each(INVALID_TOPICS)('rejects %s', (_label, topic) => {
    expectNameError(() => helper(topic), topic, TOPIC_FORM);
  });
});

describe('isTopicName', () => {
  it.each(CATALOGUE_TOPICS)('accepts %s', (topic) => {
    expect(isTopicName(topic)).toBe(true);
  });

  it.each<readonly [string, unknown]>([
    ...INVALID_TOPICS,
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['an object', {}],
    ['an array holding a topic', [TOPIC]],
  ])('rejects %s', (_label, value) => {
    expect(isTopicName(value)).toBe(false);
  });
});

describe('topic-derived names', () => {
  it.each([
    [
      'people.person.archived.v1',
      'people.person.archived',
      '1.0.0',
      'services/people/contracts/events/people.person.archived.v1.json',
    ],
    [
      'programs-sites.site.changed.v1',
      'programs-sites.site.changed',
      '1.0.0',
      'services/programs-sites/contracts/events/programs-sites.site.changed.v1.json',
    ],
    [
      'communications.message.delivery-status-changed.v1',
      'communications.message.delivery-status-changed',
      '1.0.0',
      'services/communications/contracts/events/communications.message.delivery-status-changed.v1.json',
    ],
    [
      'surveys.survey.scheduled.v12',
      'surveys.survey.scheduled',
      '12.0.0',
      'services/surveys/contracts/events/surveys.survey.scheduled.v12.json',
    ],
  ])('derives the event type, schema version and schema path of %s', (topic, eventType, schemaVersion, schemaPath) => {
    expect(eventTypeOf(topic)).toBe(eventType);
    expect(schemaVersionOf(topic)).toBe(schemaVersion);
    expect(topicSchemaRelativePath(topic)).toBe(schemaPath);
  });
});

describe('subscriptionName', () => {
  it('prefixes the topic with the consumer service', () => {
    expect(subscriptionName('timesheets', TOPIC)).toBe(SUBSCRIPTION);
  });

  it.each(['Timesheets', '', '1timesheets', 'time_sheets', 'timesheets.people'])('rejects consumer "%s"', (consumer) => {
    expectNameError(() => subscriptionName(consumer, TOPIC), consumer, SEGMENT_FORM);
  });
});

describe('subscription parts', () => {
  it.each([
    ['timesheets', 'people.person.archived.v1'],
    ['strategies-content', 'identity.group.changed.v1'],
    ['communications', 'surveys.survey.scheduled.v2'],
  ])('splits the %s subscription to %s at its first dot', (consumer, topic) => {
    const subscription = subscriptionName(consumer, topic);
    expect(consumerOfSubscription(subscription)).toBe(consumer);
    expect(topicOfSubscription(subscription)).toBe(topic);
  });
});

describe('delivery and dead-letter names', () => {
  it('mounts the push route under /internal/v1/events/', () => {
    expect(PUSH_PATH_PREFIX).toBe('/internal/v1/events/');
    expect(pushPath(SUBSCRIPTION)).toBe('/internal/v1/events/timesheets.people.person.archived.v1');
  });

  it('names the dead-letter topic <subscription>.dlq', () => {
    expect(dlqTopicName(SUBSCRIPTION)).toBe('timesheets.people.person.archived.v1.dlq');
  });

  it('names the replay pull subscription <subscription>.dlq.replay', () => {
    expect(dlqReplaySubscriptionName(SUBSCRIPTION)).toBe('timesheets.people.person.archived.v1.dlq.replay');
  });
});

describe.each(SUBSCRIPTION_HELPERS)('%s', (_helperName, helper) => {
  it.each(INVALID_SUBSCRIPTIONS)('rejects %s', (_label, subscription) => {
    expectNameError(() => helper(subscription), subscription, SUBSCRIPTION_FORM);
  });
});

interface ArchivedPayload {
  personId: string;
  siteId: string;
  effectiveFrom: string;
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;
const EVENT_ID = '3f1e2d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
const CONSUMED_EVENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PERSON_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const OCCURRED_AT = '2026-06-30T12:00:00.000Z';
const CHANGED_TOPIC = 'people.person.changed.v1';
const ENVELOPE_CONTRACT_URL = new URL('../../contracts/event-envelope.v1.json', import.meta.url);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;
const RAW_DATA = Buffer.from('not an envelope', 'utf8');
const RAW_ATTRIBUTES = { reason: 'schema' };

/** Archive-event input with only the required fields, so every optional field takes its default. */
const ARCHIVED_INPUT: BuildEnvelopeInput<ArchivedPayload> = {
  topic: TOPIC,
  tenantId: TENANT_A.tenantId,
  aggregateType: 'person',
  aggregateId: PERSON_ID,
  aggregateVersion: 3,
  payload: { personId: PERSON_ID, siteId: TENANT_A.siteId, effectiveFrom: '2026-06-30' },
};

/** Fixed event id, time and trace for deterministic envelopes. */
const FIXED = { eventId: EVENT_ID, occurredAt: OCCURRED_AT, trace: { traceparent: TRACEPARENT } };

/** The archive envelope with fixed id, time and trace, then `overrides`. */
function archivedEnvelope(overrides: Partial<BuildEnvelopeInput<ArchivedPayload>> = {}): EventEnvelope<ArchivedPayload> {
  return buildEnvelope({ ...ARCHIVED_INPUT, ...FIXED, ...overrides });
}

/** Upstream envelope whose consumption scopes the envelopes built inside it. */
const CONSUMED = buildEnvelope({
  topic: 'surveys.survey.scheduled.v1',
  tenantId: TENANT_A.tenantId,
  aggregateType: 'survey',
  aggregateId: 'survey-7',
  aggregateVersion: 2,
  payload: {},
  eventId: CONSUMED_EVENT_ID,
  occurredAt: OCCURRED_AT,
  correlationId: 'corr-upstream',
  trace: { traceparent: TRACEPARENT },
});

/** Runs `fn` inside a tenant transaction on a stand-in pool whose statements all succeed. */
function inTenantTransaction<T>(tenantId: string, fn: () => T): Promise<T> {
  const client = {
    query: (text: string): Promise<{ command: string }> => Promise.resolve({ command: text }),
    release: (): void => undefined,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return runTenantTransaction(pool, { schema: 'people', onError: () => undefined }, tenantId, () => Promise.resolve().then(fn));
}

/** Runs `fn` inside a consumed-envelope scope and/or a request context with id `req-1`. */
function inScopes<T>(consumed: boolean, request: boolean, fn: () => T): T {
  const inRequest = request ? () => runWithRequestContext(newRequestContext({ requestId: 'req-1' }), fn) : fn;
  return consumed ? runWithConsumedEnvelope(CONSUMED, inRequest) : inRequest();
}

const exporter = new MemorySpanExporter();

beforeAll(async () => {
  await startTracing({ serviceName: 'events-test', version: '1.0.0', exporter });
});

afterAll(async () => {
  await shutdownTracing();
});

describe('buildEnvelope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills every contract field in the contract property order', () => {
    const envelope = archivedEnvelope({
      trace: { traceparent: TRACEPARENT, tracestate: 'vendor=1' },
      correlationId: 'corr-1',
      causationId: CONSUMED_EVENT_ID,
    });
    expect(envelope).toEqual({
      eventId: EVENT_ID,
      eventType: 'people.person.archived',
      schemaVersion: '1.0.0',
      tenantId: TENANT_A.tenantId,
      occurredAt: OCCURRED_AT,
      producer: 'people',
      aggregateType: 'person',
      aggregateId: PERSON_ID,
      aggregateVersion: 3,
      traceparent: TRACEPARENT,
      tracestate: 'vendor=1',
      correlationId: 'corr-1',
      causationId: CONSUMED_EVENT_ID,
      payload: ARCHIVED_INPUT.payload,
    });
    expect(Object.keys(envelope)).toEqual(Object.keys(envelopeSchema().properties as Record<string, unknown>));
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it('mints a v4 event id, the current time and a self correlation when they are omitted', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(OCCURRED_AT));
    const envelope = buildEnvelope(ARCHIVED_INPUT);
    expect(envelope.eventId).toMatch(UUID_V4);
    expect(buildEnvelope(ARCHIVED_INPUT).eventId).not.toBe(envelope.eventId);
    expect(envelope.occurredAt).toBe(OCCURRED_AT);
    expect(envelope.correlationId).toBe(envelope.eventId);
    expect(envelope).not.toHaveProperty('causationId');
    expect(envelope).not.toHaveProperty('tracestate');
    expect(validateEnvelope(envelope).ok).toBe(true);
  });

  it.each([
    ['a Date as its ISO string', new Date('2026-06-30T14:00:00+02:00'), '2026-06-30T12:00:00.000Z'],
    ['an RFC 3339 string unchanged', '2026-06-30T14:00:00+02:00', '2026-06-30T14:00:00+02:00'],
  ])('stamps occurredAt from %s', (_label, occurredAt, expected) => {
    expect(archivedEnvelope({ occurredAt }).occurredAt).toBe(expected);
  });

  it('accepts a producer equal to the topic service', () => {
    expect(archivedEnvelope({ producer: 'people' }).producer).toBe('people');
  });

  it('rejects a producer other than the topic service', () => {
    expectNameError(() => archivedEnvelope({ producer: 'identity' }), 'identity', `producer "people" of topic ${TOPIC}`);
  });

  it('rejects a malformed topic', () => {
    expectNameError(() => archivedEnvelope({ topic: 'people.person.archived' }), 'people.person.archived', TOPIC_FORM);
  });
});

describe('buildEnvelope trace context', () => {
  it.each([
    ['keeps a non-empty tracestate', 'vendor=1', 'vendor=1'],
    ['drops an empty tracestate', '', undefined],
  ])('%s from an explicit carrier', (_label, tracestate, expected) => {
    const envelope = archivedEnvelope({ trace: { traceparent: TRACEPARENT, tracestate } });
    expect(envelope.traceparent).toBe(TRACEPARENT);
    expect(envelope.tracestate).toBe(expected);
    expect('tracestate' in envelope).toBe(expected !== undefined);
  });

  it('joins the active span when no carrier is given', async () => {
    const [envelope, ids] = await startSpan('request', SpanKind.SERVER, (span) => [
      buildEnvelope(ARCHIVED_INPUT),
      span.spanContext(),
    ] as const);
    expect(envelope.traceparent).toBe(`00-${ids.traceId}-${ids.spanId}-01`);
  });

  it('mints a fresh sampled root outside any span', () => {
    const first = buildEnvelope(ARCHIVED_INPUT).traceparent;
    expect(first).toMatch(ROOT_TRACEPARENT);
    expect(buildEnvelope(ARCHIVED_INPUT).traceparent).not.toBe(first);
  });
});

describe('buildEnvelope correlation and causation', () => {
  it.each<{
    source: string;
    consumed: boolean;
    request: boolean;
    input: Partial<BuildEnvelopeInput<ArchivedPayload>>;
    correlationId: string;
    causationId: string | undefined;
  }>([
    {
      source: 'the explicit ids',
      consumed: true,
      request: true,
      input: { correlationId: 'corr-1', causationId: 'cause-1' },
      correlationId: 'corr-1',
      causationId: 'cause-1',
    },
    {
      source: 'the consumed envelope',
      consumed: true,
      request: true,
      input: {},
      correlationId: 'corr-upstream',
      causationId: CONSUMED_EVENT_ID,
    },
    { source: 'the request id', consumed: false, request: true, input: {}, correlationId: 'req-1', causationId: undefined },
    { source: 'the new event id', consumed: false, request: false, input: {}, correlationId: EVENT_ID, causationId: undefined },
  ])('takes them from $source', ({ consumed, request, input, correlationId, causationId }) => {
    const envelope = inScopes(consumed, request, () => archivedEnvelope(input));
    expect(envelope.correlationId).toBe(correlationId);
    expect(envelope.causationId).toBe(causationId);
    expect('causationId' in envelope).toBe(causationId !== undefined);
  });

  it('exposes the consumed envelope across awaits, only inside its scope', async () => {
    expect(currentConsumedEnvelope()).toBeUndefined();
    const seen = await runWithConsumedEnvelope(CONSUMED, async () => {
      await Promise.resolve();
      return currentConsumedEnvelope();
    });
    expect(seen).toBe(CONSUMED);
    expect(currentConsumedEnvelope()).toBeUndefined();
  });
});

describe('buildEnvelope tenant', () => {
  it('lower-cases an explicit tenant outside a tenant transaction', () => {
    expect(archivedEnvelope({ tenantId: TENANT_A.tenantId.toUpperCase() }).tenantId).toBe(TENANT_A.tenantId);
  });

  it.each([
    [
      'without a tenantId',
      undefined,
      EnvelopeTenantError,
      'An envelope built outside a tenant transaction needs an explicit tenantId',
    ],
    ['with a tenantId that is not a UUID', TENANT_A.siteId, InvalidTenantIdError, `Invalid tenant id: "${TENANT_A.siteId}"`],
  ])('throws outside a tenant transaction %s', (_label, tenantId, errorClass, message) => {
    const build = () => archivedEnvelope({ tenantId });
    expect(build).toThrow(errorClass);
    expect(build).toThrow(message);
  });

  it.each([
    ['omitted', undefined],
    ['repeated in upper case', TENANT_A.tenantId.toUpperCase()],
  ])('takes the transaction tenant when the tenantId is %s', async (_label, tenantId) => {
    const envelope = await inTenantTransaction(TENANT_A.tenantId, () => archivedEnvelope({ tenantId }));
    expect(envelope.tenantId).toBe(TENANT_A.tenantId);
  });

  it('rejects a tenantId other than the transaction tenant', async () => {
    const built = inTenantTransaction(TENANT_A.tenantId, () => archivedEnvelope({ tenantId: TENANT_B.tenantId }));
    await expect(built).rejects.toThrow(EnvelopeTenantError);
    await expect(built).rejects.toThrow(
      `Envelope tenantId "${TENANT_B.tenantId}" differs from the transaction tenant ${TENANT_A.tenantId}`,
    );
  });
});

describe('envelopeAttributes', () => {
  it.each([
    ['without a tracestate', {}, [...ENVELOPE_ATTRIBUTE_KEYS]],
    ['with a tracestate', { tracestate: 'vendor=1' }, [...ENVELOPE_ATTRIBUTE_KEYS, 'tracestate']],
  ])('mirrors the envelope as string attributes %s', (_label, extra, keys) => {
    const attributes = envelopeAttributes(archivedEnvelope({ trace: { traceparent: TRACEPARENT, ...extra } }));
    expect(attributes).toEqual({
      eventId: EVENT_ID,
      eventType: 'people.person.archived',
      schemaVersion: '1.0.0',
      tenantId: TENANT_A.tenantId,
      aggregateVersion: '3',
      traceparent: TRACEPARENT,
      ...extra,
    });
    expect(Object.keys(attributes)).toEqual(keys);
  });
});

describe('encodeEnvelope and decodeEnvelopeData', () => {
  const envelope = archivedEnvelope({ payload: { personId: PERSON_ID, siteId: 'zoë-✓', effectiveFrom: '2026-06-30' } });
  const data = encodeEnvelope(envelope);

  it('encodes the envelope as UTF-8 JSON', () => {
    expect(data).toBeInstanceOf(Buffer);
    expect(data.toString('utf8')).toBe(JSON.stringify(envelope));
  });

  it.each<readonly [string, (bytes: Buffer) => Buffer | Uint8Array | string]>([
    ['a Buffer', (bytes) => bytes],
    [
      'a Uint8Array view inside a larger buffer',
      (bytes) => {
        const backing = new Uint8Array(bytes.length + 8);
        backing.set(bytes, 5);
        return backing.subarray(5, 5 + bytes.length);
      },
    ],
    ['a string', (bytes) => bytes.toString('utf8')],
  ])('decodes %s back to the envelope', (_label, as) => {
    expect(decodeEnvelopeData(as(data))).toEqual(envelope);
  });

  it('throws a SyntaxError for data that is not JSON', () => {
    expect(() => decodeEnvelopeData(RAW_DATA)).toThrow(SyntaxError);
  });
});

const SAMPLE_SCHEMA_ID = 'urn:opt2:test:events:sample.v1';

/** Topic payload schema using both registered formats and x-opt2 annotations below its root. */
const SAMPLE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: SAMPLE_SCHEMA_ID,
  'x-opt2-kind': 'process',
  'x-opt2-tenant-fanout': 'userPool',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    at: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string', 'x-opt2-pii': false } },
  },
  allOf: [{ 'x-opt2-note': 'annotation inside an array' }],
};
const SAMPLE_PAYLOAD = { id: EVENT_ID, at: OCCURRED_AT };

/** Archive payload validator compiled from a local topic schema. */
const archivedValidator = compileTopicSchema({
  $id: 'urn:opt2:test:events:people.person.archived.v1',
  'x-opt2-kind': 'process',
  'x-opt2-tenant-fanout': 'userPool',
  type: 'object',
  additionalProperties: false,
  required: ['personId', 'siteId', 'effectiveFrom'],
  properties: {
    personId: { type: 'string', minLength: 1 },
    siteId: { type: 'string', minLength: 1 },
    effectiveFrom: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
  },
});

describe('envelope contract', () => {
  it('exposes the contract $id and hands out independent copies', () => {
    const copy = envelopeSchema();
    expect(copy.$id).toBe(ENVELOPE_SCHEMA_ID);
    copy.required = [];
    expect(envelopeSchema().required).toContain('eventId');
    expect(validateEnvelope({}).ok).toBe(false);
  });

  it.each([
    ['a file URL', ENVELOPE_CONTRACT_URL],
    ['a file path', fileURLToPath(ENVELOPE_CONTRACT_URL)],
  ])('reads a schema file from %s', (_label, location) => {
    expect(readTopicSchema(location)).toEqual(envelopeSchema());
  });
});

describe('validateEnvelope', () => {
  const envelope = archivedEnvelope();

  it('accepts a built envelope and returns it', () => {
    const result = validateEnvelope(envelope);
    expect(result.ok && result.value).toBe(envelope);
  });

  it.each<readonly [string, unknown, string[], string[]]>([
    ['a non-object', 'text', ['/ must be object'], ['#/type']],
    [
      'a missing field',
      Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'eventId')),
      ["/ must have required property 'eventId'"],
      ['#/required'],
    ],
    [
      'two missing fields under one schema path',
      Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'eventId' && key !== 'tenantId')),
      ["/ must have required property 'eventId'", "/ must have required property 'tenantId'"],
      ['#/required'],
    ],
    ['an unknown field', { ...envelope, extra: 1 }, ['/ must NOT have additional properties (extra)'], ['#/additionalProperties']],
    [
      'every invalid field at once',
      { ...envelope, aggregateVersion: 0, payload: [] },
      ['/aggregateVersion must be >= 1', '/payload must be object'],
      ['#/properties/aggregateVersion/minimum', '#/properties/payload/type'],
    ],
  ])('reports %s as "<instancePath> <message>" errors and distinct schema paths', (_label, value, errors, schemaPaths) => {
    expect(validateEnvelope(value)).toEqual({ ok: false, errors, schemaPaths });
  });
});

describe('topicMeta', () => {
  it.each([
    ['a state topic', { 'x-opt2-kind': 'state' }, { kind: 'state' }],
    [
      'a superseding process topic',
      { 'x-opt2-kind': 'process', 'x-opt2-supersedes': true },
      { kind: 'process', supersedes: true },
    ],
    [
      'a fanned-out process topic',
      { 'x-opt2-kind': 'process', 'x-opt2-tenant-fanout': 'userPool', 'x-opt2-supersedes': false },
      { kind: 'process', fanout: 'userPool', supersedes: false },
    ],
  ])('reads %s', (_label, schema, meta) => {
    expect(topicMeta(schema)).toStrictEqual(meta);
  });

  it.each([
    [
      'a missing kind, labelled by $id',
      { $id: 'urn:opt2:test:no-kind' },
      'urn:opt2:test:no-kind: x-opt2-kind must be one of state, process, got undefined',
    ],
    [
      'an unknown kind, labelled by title',
      { title: 'Sample', 'x-opt2-kind': 'command' },
      'Sample: x-opt2-kind must be one of state, process, got "command"',
    ],
    [
      'an unknown fan-out',
      { 'x-opt2-kind': 'state', 'x-opt2-tenant-fanout': 'site' },
      'topic schema: x-opt2-tenant-fanout must be one of userPool, got "site"',
    ],
    [
      'supersedes on a state topic',
      { 'x-opt2-kind': 'state', 'x-opt2-supersedes': true },
      'topic schema: x-opt2-supersedes must be a boolean on a process topic',
    ],
    [
      'a non-boolean supersedes',
      { 'x-opt2-kind': 'process', 'x-opt2-supersedes': 'yes' },
      'topic schema: x-opt2-supersedes must be a boolean on a process topic',
    ],
  ])('rejects %s, as compileTopicSchema does', (_label, schema, message) => {
    for (const read of [topicMeta, compileTopicSchema]) {
      expect(() => read(schema)).toThrow(TopicSchemaError);
      expect(() => read(schema)).toThrow(message);
    }
  });
});

describe('compileTopicSchema', () => {
  const sample = compileTopicSchema<typeof SAMPLE_PAYLOAD>(SAMPLE_SCHEMA);

  it('returns the declarations, the $id and a payload validator', () => {
    expect(sample.meta).toStrictEqual({ kind: 'process', fanout: 'userPool' });
    expect(sample.schemaId).toBe(SAMPLE_SCHEMA_ID);
    expect(sample.validatePayload(SAMPLE_PAYLOAD)).toEqual({ ok: true, value: SAMPLE_PAYLOAD });
  });

  it.each([
    ['an upper-case UUID', { ...SAMPLE_PAYLOAD, id: EVENT_ID.toUpperCase() }],
    ['an offset date-time with a fraction', { ...SAMPLE_PAYLOAD, at: '2024-02-29T14:00:00.123456+02:00' }],
    ['annotated array items', { ...SAMPLE_PAYLOAD, tags: ['a'] }],
  ])('accepts %s', (_label, payload) => {
    expect(sample.validatePayload(payload).ok).toBe(true);
  });

  it.each<readonly [string, unknown, string[], string[]]>([
    ['a missing property', { id: EVENT_ID }, ["/ must have required property 'at'"], ['#/required']],
    [
      'an unknown property',
      { ...SAMPLE_PAYLOAD, extra: true },
      ['/ must NOT have additional properties (extra)'],
      ['#/additionalProperties'],
    ],
    ['a value that is not a UUID', { ...SAMPLE_PAYLOAD, id: 'person-1' }, ['/id must match format "uuid"'], ['#/properties/id/format']],
    [
      'a calendar-invalid date-time',
      { ...SAMPLE_PAYLOAD, at: '2026-02-29T12:00:00Z' },
      ['/at must match format "date-time"'],
      ['#/properties/at/format'],
    ],
    ['a date without a time', { ...SAMPLE_PAYLOAD, at: '2026-06-30' }, ['/at must match format "date-time"'], ['#/properties/at/format']],
  ])('reports %s', (_label, payload, errors, schemaPaths) => {
    expect(sample.validatePayload(payload)).toEqual({ ok: false, errors, schemaPaths });
  });

  it('reuses the validator of a $id registered with the same content', () => {
    const again = compileTopicSchema(structuredClone(SAMPLE_SCHEMA));
    expect(again.schemaId).toBe(SAMPLE_SCHEMA_ID);
    expect(again.validatePayload(SAMPLE_PAYLOAD).ok).toBe(true);
    expect(again.validatePayload({ id: 'person-1' }).ok).toBe(false);
  });

  it('rejects a $id registered with different content', () => {
    const changed = { ...SAMPLE_SCHEMA, required: ['id'] };
    expect(() => compileTopicSchema(changed)).toThrow(TopicSchemaError);
    expect(() => compileTopicSchema(changed)).toThrow(`Schema ${SAMPLE_SCHEMA_ID} is already registered with different content`);
  });

  it('frees the $id of a schema that fails to compile', () => {
    const broken = {
      $id: 'urn:opt2:test:events:retry.v1',
      'x-opt2-kind': 'state',
      type: 'object',
      required: ['n'],
      properties: { n: { type: 'integr' } },
    };
    expect(() => compileTopicSchema(broken)).toThrow('schema is invalid');
    const fixed = compileTopicSchema({ ...broken, properties: { n: { type: 'integer' } } });
    expect(fixed.validatePayload({ n: 1 }).ok).toBe(true);
    expect(fixed.validatePayload({ n: 'one' })).toEqual({
      ok: false,
      errors: ['/n must be integer'],
      schemaPaths: ['#/properties/n/type'],
    });
  });

  it('compiles a schema without $id repeatedly, leaving schemaId unset', () => {
    const schema = { 'x-opt2-kind': 'state', type: 'object', required: ['n'], properties: { n: { type: 'integer' } } };
    const first = compileTopicSchema(schema);
    const second = compileTopicSchema(schema);
    expect(first).not.toHaveProperty('schemaId');
    expect(first.validatePayload({ n: 1 }).ok).toBe(true);
    expect(second.validatePayload({}).ok).toBe(false);
  });

  it('rejects keywords outside the x-opt2- prefix in strict mode', () => {
    expect(() => compileTopicSchema({ 'x-opt2-kind': 'state', type: 'object', 'x-custom': true })).toThrow(
      'unknown keyword: "x-custom"',
    );
  });
});

/** Pub/Sub topic stand-in recording what the publisher hands it. */
class FakeTopic {
  readonly published: unknown[] = [];
  readonly resumed: string[] = [];
  readonly name: string;
  readonly options: unknown;
  private readonly client: FakePubSub;

  constructor(name: string, options: unknown, client: FakePubSub) {
    this.name = name;
    this.options = options;
    this.client = client;
  }

  publishMessage(message: unknown): Promise<string> {
    this.published.push(message);
    const failure = this.client.publishFailure;
    return failure === undefined ? Promise.resolve(`${this.name}#${this.published.length}`) : Promise.reject(failure);
  }

  resumePublishing(orderingKey: string): void {
    this.resumed.push(orderingKey);
  }

  flush(): Promise<void> {
    this.client.log.push(`flush ${this.name}`);
    const failure = this.client.flushFailure;
    return failure === undefined ? Promise.resolve() : Promise.reject(failure);
  }
}

/** Pub/Sub client stand-in handing out recording topics. */
class FakePubSub {
  readonly topics: FakeTopic[] = [];
  readonly log: string[] = [];
  publishFailure: Error | undefined;
  flushFailure: Error | undefined;

  topic(name: string, options?: unknown): FakeTopic {
    const topic = new FakeTopic(name, options, this);
    this.topics.push(topic);
    return topic;
  }

  close(): Promise<void> {
    this.log.push('close');
    return Promise.resolve();
  }
}

/** A publisher over a fresh FakePubSub. */
function fakePublisher(payloadValidators?: ReadonlyMap<string, TopicValidator>) {
  const pubsub = new FakePubSub();
  const publisher = createPublisher({ projectId: 'opt2-test', pubsub: pubsub as unknown as PubSub, payloadValidators });
  return { pubsub, publisher };
}

/** Finished `outbox.publish` spans. */
function publishSpans() {
  return exporter.getFinishedSpans().filter((span) => span.name === 'outbox.publish');
}

describe('EnvelopePublishError', () => {
  it('is a named Error listing every rejection', () => {
    const error = new EnvelopePublishError(TOPIC, ['/a must be x', '/b must be y']);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EnvelopePublishError');
    expect(error.errors).toEqual(['/a must be x', '/b must be y']);
    expect(error.message).toBe(`Envelope rejected for topic "${TOPIC}": /a must be x; /b must be y`);
  });
});

describe('createPublisher', () => {
  beforeEach(async () => {
    await flushTracing();
    exporter.reset();
  });

  it('publishes the encoded envelope with its attributes, ordered by aggregateId', async () => {
    const { pubsub, publisher } = fakePublisher(new Map([[TOPIC, archivedValidator]]));
    const envelope = archivedEnvelope();
    await expect(publisher.publish(TOPIC, envelope)).resolves.toBe(`${TOPIC}#1`);
    expect(pubsub.topics.map(({ name, options }) => [name, options])).toEqual([[TOPIC, { messageOrdering: true }]]);
    expect(pubsub.topics[0]?.published).toEqual([
      { data: encodeEnvelope(envelope), attributes: envelopeAttributes(envelope), orderingKey: PERSON_ID },
    ]);
  });

  it('keeps one ordered topic handle per topic name', async () => {
    const { pubsub, publisher } = fakePublisher();
    const ids = [
      await publisher.publish(TOPIC, archivedEnvelope()),
      await publisher.publish(CHANGED_TOPIC, archivedEnvelope({ topic: CHANGED_TOPIC })),
      await publisher.publish(TOPIC, archivedEnvelope({ aggregateVersion: 4 })),
    ];
    expect(ids).toEqual([`${TOPIC}#1`, `${CHANGED_TOPIC}#1`, `${TOPIC}#2`]);
    expect(pubsub.topics.map(({ name }) => name)).toEqual([TOPIC, CHANGED_TOPIC]);
  });

  it.each<{ reason: string; topic: string; envelope: () => unknown; errors: string[] }>([
    {
      reason: 'an envelope that breaks the contract',
      topic: TOPIC,
      envelope: () => ({ ...archivedEnvelope(), aggregateVersion: 0 }),
      errors: ['/aggregateVersion must be >= 1'],
    },
    {
      reason: 'a contract failure ahead of the topic checks',
      topic: 'not-a-topic',
      envelope: () => ({ ...archivedEnvelope(), extra: 1 }),
      errors: ['/ must NOT have additional properties (extra)'],
    },
    {
      reason: 'a malformed topic name',
      topic: 'people.person.archived',
      envelope: () => archivedEnvelope(),
      errors: ['topic "people.person.archived" is not <service>.<entity>.<event>.v<major>'],
    },
    {
      reason: 'another event type',
      topic: CHANGED_TOPIC,
      envelope: () => archivedEnvelope(),
      errors: [`/eventType must be people.person.changed on topic ${CHANGED_TOPIC}`],
    },
    {
      reason: 'another major version',
      topic: 'people.person.archived.v2',
      envelope: () => archivedEnvelope(),
      errors: ['/schemaVersion must be 2.0.0 on topic people.person.archived.v2'],
    },
    {
      reason: 'another event type and major version',
      topic: 'people.person.changed.v2',
      envelope: () => archivedEnvelope(),
      errors: [
        '/eventType must be people.person.changed on topic people.person.changed.v2',
        '/schemaVersion must be 2.0.0 on topic people.person.changed.v2',
      ],
    },
    {
      reason: 'a payload the topic schema rejects, rebased under /payload',
      topic: TOPIC,
      envelope: () => archivedEnvelope({ payload: { personId: '', siteId: TENANT_A.siteId } as ArchivedPayload }),
      errors: ["/payload must have required property 'effectiveFrom'", '/payload/personId must NOT have fewer than 1 characters'],
    },
  ])('rejects $reason before publishing', async ({ topic, envelope, errors }) => {
    const { pubsub, publisher } = fakePublisher(new Map([[TOPIC, archivedValidator]]));
    const rejected = await publisher.publish(topic, envelope() as EventEnvelope).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(EnvelopePublishError);
    expect((rejected as EnvelopePublishError).errors).toEqual(errors);
    expect(pubsub.topics).toEqual([]);
  });

  it('applies a payload validator only to its own topic', async () => {
    const { publisher } = fakePublisher(new Map([[CHANGED_TOPIC, archivedValidator]]));
    const envelope = archivedEnvelope({ payload: { personId: '', siteId: TENANT_A.siteId } as ArchivedPayload });
    await expect(publisher.publish(TOPIC, envelope)).resolves.toBe(`${TOPIC}#1`);
  });

  it('publishes in an outbox.publish producer span parented to the envelope trace', async () => {
    const { publisher } = fakePublisher();
    await publisher.publish(TOPIC, archivedEnvelope());
    await flushTracing();
    const spans = publishSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.kind).toBe(SpanKind.PRODUCER);
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes).toEqual({
      'messaging.system': 'gcp_pubsub',
      'messaging.destination.name': TOPIC,
      'messaging.message.id': `${TOPIC}#1`,
    });
  });

  it('rethrows a failed publish, resumes its ordering key and marks the span failed', async () => {
    const { pubsub, publisher } = fakePublisher();
    const failure = new Error('publish failed');
    pubsub.publishFailure = failure;
    await expect(publisher.publish(TOPIC, archivedEnvelope())).rejects.toBe(failure);
    expect(pubsub.topics[0]?.resumed).toEqual([PERSON_ID]);
    await flushTracing();
    const [span] = publishSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).not.toHaveProperty('messaging.message.id');
  });

  it.each<readonly [string, RawMessage, RawMessage]>([
    [
      'with its ordering key',
      { data: RAW_DATA, attributes: RAW_ATTRIBUTES, orderingKey: 'key-1' },
      { data: RAW_DATA, attributes: RAW_ATTRIBUTES, orderingKey: 'key-1' },
    ],
    ['without an ordering key', { data: RAW_DATA, attributes: RAW_ATTRIBUTES }, { data: RAW_DATA, attributes: RAW_ATTRIBUTES }],
    [
      'dropping an empty ordering key',
      { data: RAW_DATA, attributes: RAW_ATTRIBUTES, orderingKey: '' },
      { data: RAW_DATA, attributes: RAW_ATTRIBUTES },
    ],
  ])('publishes a raw message unchecked %s', async (_label, message, handed) => {
    const { pubsub, publisher } = fakePublisher();
    const dlq = dlqTopicName(SUBSCRIPTION);
    await expect(publisher.publishRaw(dlq, message)).resolves.toBe(`${dlq}#1`);
    expect(pubsub.topics[0]?.options).toEqual({ messageOrdering: true });
    expect(pubsub.topics[0]?.published).toStrictEqual([handed]);
  });

  it('rethrows a failed raw publish with no ordering key to resume', async () => {
    const { pubsub, publisher } = fakePublisher();
    const failure = new Error('publish failed');
    pubsub.publishFailure = failure;
    await expect(publisher.publishRaw(TOPIC, { data: RAW_DATA, attributes: RAW_ATTRIBUTES })).rejects.toBe(failure);
    expect(pubsub.topics[0]?.resumed).toEqual([]);
  });

  it('flushes every topic used once, then closes the client', async () => {
    const { pubsub, publisher } = fakePublisher();
    await publisher.publish(TOPIC, archivedEnvelope());
    await publisher.publish(CHANGED_TOPIC, archivedEnvelope({ topic: CHANGED_TOPIC }));
    await publisher.close();
    expect(pubsub.log).toEqual([`flush ${TOPIC}`, `flush ${CHANGED_TOPIC}`, 'close']);
    await publisher.close();
    expect(pubsub.log).toEqual([`flush ${TOPIC}`, `flush ${CHANGED_TOPIC}`, 'close', 'close']);
  });

  it('closes the client when a flush fails, then rethrows the flush error', async () => {
    const { pubsub, publisher } = fakePublisher();
    const failure = new Error('flush failed');
    pubsub.flushFailure = failure;
    await publisher.publish(TOPIC, archivedEnvelope());
    await expect(publisher.close()).rejects.toBe(failure);
    expect(pubsub.log).toEqual([`flush ${TOPIC}`, 'close']);
  });
});

describe('createPublisher client construction', () => {
  afterEach(() => {
    pubsubConstructor.mockReset();
  });

  it.each<readonly [string, PublisherOptions, object]>([
    ['a client from the project id alone', { projectId: 'opt2-test' }, { projectId: 'opt2-test' }],
    [
      'a plaintext emulator client for emulatorHost',
      { projectId: 'opt2-test', emulatorHost: 'emulator.test:8085' },
      { projectId: 'opt2-test', apiEndpoint: 'emulator.test:8085', emulatorMode: true },
    ],
  ])('constructs %s and publishes through it', async (_label, options, expected) => {
    const pubsub = new FakePubSub();
    pubsubConstructor.mockImplementation(function () {
      return pubsub;
    });
    const publisher = createPublisher(options);
    expect(pubsubConstructor.mock.calls).toStrictEqual([[expected]]);
    await publisher.publish(TOPIC, archivedEnvelope());
    await publisher.close();
    expect(pubsub.topics.map(({ published }) => published.length)).toEqual([1]);
    expect(pubsub.log).toEqual([`flush ${TOPIC}`, 'close']);
  });
});

const DELIVERY_ATTRIBUTES = envelopeAttributes(archivedEnvelope());

/** Attributes Pub/Sub's dead-letter policy adds when it forwards a delivery of SUBSCRIPTION. */
const FORWARDED_ATTRIBUTES = {
  CloudPubSubDeadLetterSourceSubscription: `projects/opt2-test/subscriptions/${SUBSCRIPTION}`,
  CloudPubSubDeadLetterSourceSubscriptionProject: 'opt2-test',
  CloudPubSubDeadLetterSourceDeliveryCount: '5',
  CloudPubSubDeadLetterSourceDeliveryErrorMessage: 'push endpoint answered 503',
  CloudPubSubDeadLetterSourceTopicPublishTime: OCCURRED_AT,
};

describe('dead-letter reasons', () => {
  it('lists the four reasons a consumer dead-letters instead of nacking', () => {
    expect(DEAD_LETTER_REASONS).toEqual(['missing-tenant', 'invalid-tenant', 'schema-invalid', 'tenant-mismatch']);
  });

  it.each([...DEAD_LETTER_REASONS])('recognises %s', (reason) => {
    expect(isDeadLetterReason(reason)).toBe(true);
  });

  it.each([undefined, null, '', 'Schema-Invalid', 'timeout', 1])('rejects %j', (value) => {
    expect(isDeadLetterReason(value)).toBe(false);
  });

  it.each([
    ['without a detail', undefined, 'Dead letter: tenant-mismatch'],
    ['with a detail', 'attribute differs', 'Dead letter: tenant-mismatch: attribute differs'],
  ])('names the reason of a DeadLetterError %s', (_label, detail, message) => {
    const error = new DeadLetterError('tenant-mismatch', detail);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'DeadLetterError', reason: 'tenant-mismatch', message });
    expect(error.detail).toBe(detail);
  });
});

describe('publishDeadLetter', () => {
  it.each([
    ['with its ordering key', PERSON_ID],
    ['without an ordering key', undefined],
  ])('publishes the delivery %s to <subscription>.dlq as a consumer letter', async (_label, orderingKey) => {
    const publisher = createCapturingPublisher();
    const letter = { subscription: SUBSCRIPTION, data: RAW_DATA, attributes: DELIVERY_ATTRIBUTES, orderingKey };
    await expect(publishDeadLetter(publisher, { ...letter, reason: 'schema-invalid' })).resolves.toBe('1');
    expect(publisher.raw).toStrictEqual([
      {
        topic: dlqTopicName(SUBSCRIPTION),
        message: {
          data: RAW_DATA,
          attributes: { ...DELIVERY_ATTRIBUTES, reason: 'schema-invalid' },
          ...(orderingKey === undefined ? {} : { orderingKey }),
        },
      },
    ]);
    const published = publisher.raw[0]?.message.attributes ?? {};
    expect(describeDeadLetter(published)).toStrictEqual({ origin: 'consumer', reason: 'schema-invalid' });
    expect(originalAttributes(published)).toStrictEqual(DELIVERY_ATTRIBUTES);
  });
});

describe('describeDeadLetter', () => {
  it.each<readonly [string, Record<string, string>, DeadLetterDescription]>([
    ['a consumer letter', { ...DELIVERY_ATTRIBUTES, reason: 'missing-tenant' }, { origin: 'consumer', reason: 'missing-tenant' }],
    ['a consumer letter with an unknown reason', { ...DELIVERY_ATTRIBUTES, reason: 'timeout' }, { origin: 'consumer' }],
    ['attributes without any dead-letter key', {}, { origin: 'consumer' }],
    [
      'a forwarded letter naming its source subscription resource',
      { ...DELIVERY_ATTRIBUTES, ...FORWARDED_ATTRIBUTES },
      { origin: 'pubsub', sourceSubscription: SUBSCRIPTION, deliveryCount: 5 },
    ],
    [
      'a forwarded letter naming its bare source subscription',
      { CloudPubSubDeadLetterSourceSubscription: SUBSCRIPTION, CloudPubSubDeadLetterSourceDeliveryCount: '12' },
      { origin: 'pubsub', sourceSubscription: SUBSCRIPTION, deliveryCount: 12 },
    ],
    [
      'a forwarded letter whose delivery count is not a decimal integer',
      { ...FORWARDED_ATTRIBUTES, CloudPubSubDeadLetterSourceDeliveryCount: '5.0' },
      { origin: 'pubsub', sourceSubscription: SUBSCRIPTION },
    ],
    [
      'a forwarded letter with empty source fields',
      { CloudPubSubDeadLetterSourceSubscription: '', CloudPubSubDeadLetterSourceDeliveryCount: '' },
      { origin: 'pubsub' },
    ],
    ['a letter carrying only a publish time', { CloudPubSubDeadLetterSourceTopicPublishTime: OCCURRED_AT }, { origin: 'pubsub' }],
  ])('describes %s', (_label, attributes, description) => {
    expect(describeDeadLetter(attributes)).toStrictEqual(description);
  });
});

describe('originalAttributes', () => {
  it.each([
    ['a consumer letter', { ...DELIVERY_ATTRIBUTES, reason: 'schema-invalid' }],
    ['a forwarded letter', { ...DELIVERY_ATTRIBUTES, ...FORWARDED_ATTRIBUTES }],
    ['an unlisted CloudPubSubDeadLetter attribute', { ...DELIVERY_ATTRIBUTES, CloudPubSubDeadLetterFutureField: 'x' }],
  ])('restores the delivery attributes of %s, leaving the letter unchanged', (_label, attributes) => {
    const before = { ...attributes };
    expect(originalAttributes(attributes)).toStrictEqual(DELIVERY_ATTRIBUTES);
    expect(attributes).toStrictEqual(before);
  });

  it('keeps attributes that only resemble the stripped names', () => {
    const lookalikes = { reasons: 'a', Reason: 'b', cloudPubSubDeadLetterSourceSubscription: 'c', xCloudPubSubDeadLetter: 'd' };
    expect(originalAttributes(lookalikes)).toStrictEqual(lookalikes);
  });
});

describe('push body round trip', () => {
  const envelope = testEnvelope({ topic: TOPIC, tenantId: TENANT_A.tenantId, aggregateId: 'A1', aggregateVersion: 3, payload: {} });
  const required: PushBodyInput = {
    data: encodeEnvelope(envelope),
    attributes: envelopeAttributes(envelope),
    messageId: 'm1',
    subscription: SUBSCRIPTION,
  };

  it.each<readonly [string, Partial<PushBodyInput>, Partial<DecodedPush>]>([
    ['with only the required fields', {}, {}],
    [
      'with every delivery detail',
      { orderingKey: envelope.aggregateId, publishTime: OCCURRED_AT, deliveryAttempt: 2 },
      { orderingKey: envelope.aggregateId, publishTime: OCCURRED_AT, deliveryAttempt: 2 },
    ],
    [
      'naming the subscription resource of a project',
      { project: 'opt2-test' },
      { subscription: `projects/opt2-test/subscriptions/${SUBSCRIPTION}` },
    ],
  ])('decodes what buildPushBody builds %s', (_label, extra, expected) => {
    const decoded = decodePushBody(buildPushBody({ ...required, ...extra }));
    expect(decoded).toStrictEqual({
      data: encodeEnvelope(envelope),
      attributes: envelopeAttributes(envelope),
      messageId: 'm1',
      subscription: SUBSCRIPTION,
      ...expected,
    });
    expect(validateEnvelope(decodeEnvelopeData(decoded.data))).toEqual({ ok: true, value: envelope });
  });
});

