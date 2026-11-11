import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DestinationStream } from 'pino';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { INVOCATION_HEADER, PUBSUB_INVOKER_ROLE, recordedRoutes } from '../../src/auth/index.js';
import type { ConsumerDefinition } from '../../src/events/consumer.js';
import { DeadLetterError, type DeadLetterReason } from '../../src/events/dlq.js';
import type { EventPublisher } from '../../src/events/publisher.js';
import {
  ConsumerRegistrationError,
  PushBodyError,
  buildPushBody,
  decodePushBody,
  registerConsumers,
  registerPushSubscription,
  type PushSubscriptionOptions,
} from '../../src/events/push.js';
import { createLogger, validateLogRecord } from '../../src/logging/index.js';
import { createService } from '../../src/service-kit/create-service.js';
import { loadEnv } from '../../src/service-kit/env.js';
import type { TenantDb, TenantTx } from '../../src/tenancy/index.js';
import { TENANT_A, TENANT_B } from '../../src/testing/fixtures.js';
import { mintServiceToken, mintUserToken, pushKeyQuery, testVerifier } from '../../src/testing/tokens.js';

const SERVICE = 'stub';
const TOPIC = 'stub.note.created.v1';
const SUBSCRIPTION = `${SERVICE}.${TOPIC}`;
const DLQ_TOPIC = `${SUBSCRIPTION}.dlq`;
const PUSH_ROUTE = `/internal/v1/events/${SUBSCRIPTION}`;
const PUSH_URL = `${PUSH_ROUTE}?${pushKeyQuery()}`;
const EVENT_ID = '3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const MESSAGE_ID = 'msg-1';
const ORDERING_KEY = 'note-1';

interface NotePayload {
  noteId: string;
  text: string;
}

type LogLine = Record<string, unknown>;

/** Inline payload schema of a `stub.note.*` topic; `extra` adds or replaces root keywords. */
function noteSchema(extra: Record<string, unknown> = {}): object {
  return {
    'x-opt2-kind': 'process',
    type: 'object',
    required: ['noteId', 'text'],
    additionalProperties: false,
    properties: { noteId: { type: 'string', minLength: 1 }, text: { type: 'string' } },
    ...extra,
  };
}

/** A valid `stub.note.created` v1 envelope of tenant A as plain JSON; an override set to undefined drops the key. */
function envelopeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType: 'stub.note.created',
    schemaVersion: '1.2.0',
    tenantId: TENANT_A.tenantId,
    occurredAt: '2026-03-04T05:06:07.000Z',
    producer: 'stub',
    aggregateType: 'note',
    aggregateId: ORDERING_KEY,
    aggregateVersion: 3,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    correlationId: 'corr-1',
    payload: { noteId: ORDERING_KEY, text: 'hello' },
    ...overrides,
  };
}

/** Pub/Sub attributes mirroring the default envelope. */
function envelopeAttributesOf(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const attributes: Record<string, string | undefined> = {
    eventId: EVENT_ID,
    eventType: 'stub.note.created',
    schemaVersion: '1.2.0',
    tenantId: TENANT_A.tenantId,
    aggregateVersion: '3',
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The push body the emulator sends for `data` on the test subscription. */
function pushBodyFor(data: string, attributes: Record<string, string> = envelopeAttributesOf(), subscription = SUBSCRIPTION) {
  return buildPushBody({
    data,
    attributes,
    messageId: MESSAGE_ID,
    subscription,
    project: 'opt2-test',
    orderingKey: ORDERING_KEY,
    publishTime: '2026-03-04T05:06:08.000Z',
    deliveryAttempt: 2,
  });
}

/** EventPublisher fake whose `publishRaw` resolves to a message id unless `failure` is given. */
function fakePublisher(failure?: Error) {
  return {
    publish: vi.fn<EventPublisher['publish']>(() => Promise.resolve('unused')),
    publishRaw: vi.fn<EventPublisher['publishRaw']>(() =>
      failure === undefined ? Promise.resolve('dlq-message-1') : Promise.reject(failure),
    ),
    close: vi.fn<EventPublisher['close']>(() => Promise.resolve()),
  };
}

/** TenantDb fake: every tenant transaction records its SQL and reports one affected row; no metadata transaction is allowed. */
function memoryDb(): TenantDb & { readonly statements: Array<{ tenantId: string; text: string }> } {
  const statements: Array<{ tenantId: string; text: string }> = [];
  const txFor = (tenantId: string): TenantTx => ({
    kind: 'tenant',
    tenantId,
    schema: SERVICE,
    query: ((text: unknown) => {
      statements.push({ tenantId, text: String(text) });
      return Promise.resolve({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] });
    }) as TenantTx['query'],
    onCommit: () => undefined,
  });
  return {
    schema: SERVICE,
    statements,
    withTenant: (tenantId, fn) => fn(txFor(tenantId)),
    withMetadata: () => Promise.reject(new Error('push delivery opens no metadata transaction')),
    end: () => Promise.resolve(),
  };
}

type NoteConsumer = Omit<ConsumerDefinition<NotePayload>, 'checkTenant' | 'apply'> & {
  checkTenant: Mock<NonNullable<ConsumerDefinition<NotePayload>['checkTenant']>>;
  apply: Mock<ConsumerDefinition<NotePayload>['apply']>;
};

/** A `process` consumer of the test topic; its re-check passes and its effect does nothing unless overridden, both as mocks. */
function noteConsumer(overrides: Partial<ConsumerDefinition<NotePayload>> = {}): NoteConsumer {
  const { checkTenant = () => true, apply = () => undefined, ...declarations } = overrides;
  return { topic: TOPIC, kind: 'process', ...declarations, checkTenant: vi.fn(checkTenant), apply: vi.fn(apply) };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A createService app of the stub service with the test transports and a captured logger; `pool` becomes `app.opt2.db`. */
async function serviceApp(pool?: TenantDb): Promise<{ app: FastifyInstance; lines: LogLine[] }> {
  const lines: LogLine[] = [];
  const destination: DestinationStream = { write: (chunk: string) => void lines.push(JSON.parse(chunk) as LogLine) };
  const app = await createService({
    name: SERVICE,
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '26499',
      OPT2_SERVICE_NAME: SERVICE,
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: path.join(tmpdir(), 'opt2-events-push-unit-unused'),
      TZ: 'UTC',
    }),
    verifierOverride: testVerifier(SERVICE),
    logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination }),
    ...(pool === undefined ? {} : { pool }),
  });
  apps.push(app);
  return { app, lines };
}

/** The stub app with the test subscription mounted over a fresh memory database, fake publisher and consumer. */
async function mounted(opts: { consumer?: NoteConsumer; publisher?: ReturnType<typeof fakePublisher> } = {}) {
  const db = memoryDb();
  const publisher = opts.publisher ?? fakePublisher();
  const consumer = opts.consumer ?? noteConsumer();
  const { app, lines } = await serviceApp(db);
  registerPushSubscription(app, { subscription: SUBSCRIPTION, consumer, payloadSchema: noteSchema(), publisher });
  return { app, lines, db, publisher, consumer };
}

/** POSTs `payload` to the push route, objects as JSON, with the push key unless `url` replaces it. */
function deliver(app: FastifyInstance, payload: unknown, opts: { url?: string; headers?: Record<string, string> } = {}) {
  return app.inject({ method: 'POST', url: opts.url ?? PUSH_URL, headers: opts.headers, payload: payload as object });
}

/** The error `fn` throws; fails when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/** Log lines whose message matches `pattern`. */
function linesMatching(lines: LogLine[], pattern: RegExp): LogLine[] {
  return lines.filter((line) => typeof line.message === 'string' && pattern.test(line.message));
}

describe('push delivery route', () => {
  it('acks a valid delivery with 204 after consuming it once in the envelope tenant', async () => {
    const { app, db, publisher, consumer } = await mounted();
    const response = await deliver(app, pushBodyFor(JSON.stringify(envelopeJson())));

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(consumer.apply).toHaveBeenCalledTimes(1);
    const [tx, envelope, ctx] = consumer.apply.mock.calls[0] ?? [];
    expect(tx).toMatchObject({ kind: 'tenant', tenantId: TENANT_A.tenantId });
    expect(envelope).toEqual(envelopeJson());
    expect(ctx).toMatchObject({
      subscription: SUBSCRIPTION,
      messageId: MESSAGE_ID,
      destinationTenantId: TENANT_A.tenantId,
      isFanout: false,
      deliveryAttempt: 2,
    });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.tenantId).toBe(TENANT_A.tenantId);
    expect(db.statements[0]?.text).toMatch(/^INSERT INTO stub\.inbox /);
    expect(publisher.publishRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['an upper-case tenantId attribute of the same tenant', { tenantId: TENANT_A.tenantId.toUpperCase() }],
    ['no tenantId attribute', { tenantId: undefined }],
  ])('consumes a delivery with %s', async (_name, attributes) => {
    const { app, publisher, consumer } = await mounted();
    const response = await deliver(app, pushBodyFor(JSON.stringify(envelopeJson()), envelopeAttributesOf(attributes)));

    expect(response.statusCode).toBe(204);
    expect(consumer.apply).toHaveBeenCalledTimes(1);
    expect(publisher.publishRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['has no message object', { subscription: SUBSCRIPTION }, undefined],
    ['has no messageId', { message: { data: '' }, subscription: SUBSCRIPTION }, undefined],
    ['carries data that is not base64', { message: { messageId: MESSAGE_ID, data: '***' }, subscription: SUBSCRIPTION }, undefined],
    ['is not JSON', '{"message":', 'application/json'],
  ])('answers 400, a nack, to a body that %s', async (_name, payload, contentType) => {
    const { app, lines, publisher, consumer } = await mounted();
    const response = await deliver(app, payload, contentType === undefined ? {} : { headers: { 'content-type': contentType } });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('');
    expect(consumer.apply).not.toHaveBeenCalled();
    expect(publisher.publishRaw).not.toHaveBeenCalled();
    expect(linesMatching(lines, new RegExp(`^malformed push body on ${SUBSCRIPTION.replaceAll('.', '\\.')}: `))).toHaveLength(1);
  });

  it.each<[string, string, Record<string, string>, DeadLetterReason, string, string | undefined]>([
    ['message data that is not JSON', 'not json', envelopeAttributesOf(), 'schema-invalid', 'message data is not JSON', undefined],
    ['empty message data', '', envelopeAttributesOf(), 'schema-invalid', 'message data is not JSON', undefined],
    ['JSON that is not an object', '[1,2,3]', envelopeAttributesOf(), 'schema-invalid', 'message data is not a JSON object', undefined],
    [
      'an envelope without tenantId',
      JSON.stringify(envelopeJson({ tenantId: undefined })),
      {},
      'missing-tenant',
      'envelope has no tenantId',
      EVENT_ID,
    ],
    ['an empty tenantId', JSON.stringify(envelopeJson({ tenantId: '' })), {}, 'missing-tenant', 'envelope has no tenantId', EVENT_ID],
    ['a null tenantId', JSON.stringify(envelopeJson({ tenantId: null })), {}, 'missing-tenant', 'envelope has no tenantId', EVENT_ID],
    [
      'a tenantId that is not a UUID',
      JSON.stringify(envelopeJson({ tenantId: 'tenant-a' })),
      {},
      'invalid-tenant',
      'envelope tenantId is not a UUID',
      EVENT_ID,
    ],
    [
      'a tenantId of another type',
      JSON.stringify(envelopeJson({ tenantId: 42 })),
      {},
      'invalid-tenant',
      'envelope tenantId is not a UUID',
      EVENT_ID,
    ],
    [
      'an envelope breaking the envelope contract',
      JSON.stringify(envelopeJson({ aggregateVersion: 0 })),
      envelopeAttributesOf(),
      'schema-invalid',
      'envelope fails #/properties/aggregateVersion/minimum',
      EVENT_ID,
    ],
    [
      'an envelope of another event type',
      JSON.stringify(envelopeJson({ eventType: 'stub.note.deleted' })),
      envelopeAttributesOf(),
      'schema-invalid',
      `envelope eventType does not belong to topic ${TOPIC}`,
      EVENT_ID,
    ],
    [
      'an envelope of another major version',
      JSON.stringify(envelopeJson({ schemaVersion: '2.0.0' })),
      envelopeAttributesOf(),
      'schema-invalid',
      `envelope schemaVersion major does not belong to topic ${TOPIC}`,
      EVENT_ID,
    ],
    [
      'a payload breaking the topic schema',
      JSON.stringify(envelopeJson({ payload: { noteId: '' } })),
      envelopeAttributesOf(),
      'schema-invalid',
      'payload fails #/required, #/properties/noteId/minLength',
      EVENT_ID,
    ],
    [
      'a tenantId attribute naming another tenant',
      JSON.stringify(envelopeJson()),
      envelopeAttributesOf({ tenantId: TENANT_B.tenantId }),
      'tenant-mismatch',
      'tenantId attribute differs from the envelope tenantId',
      EVENT_ID,
    ],
  ])('dead-letters %s with its reason and acks with 204', async (_name, data, attributes, reason, detail, eventId) => {
    const { app, lines, publisher, consumer } = await mounted();
    const response = await deliver(app, pushBodyFor(data, attributes));

    expect(response.statusCode).toBe(204);
    expect(consumer.apply).not.toHaveBeenCalled();
    expect(publisher.publishRaw).toHaveBeenCalledTimes(1);
    expect(publisher.publishRaw).toHaveBeenCalledWith(DLQ_TOPIC, {
      data: Buffer.from(data, 'utf8'),
      attributes: { ...attributes, reason },
      orderingKey: ORDERING_KEY,
    });
    const warnings = linesMatching(lines, / dead-lettered as /);
    expect(warnings.map((line) => line.message)).toEqual([
      `delivery ${MESSAGE_ID} on ${SUBSCRIPTION} dead-lettered as ${reason}: ${detail}`,
    ]);
    expect(warnings[0]?.eventId).toBe(eventId);
  });

  it.each<[string, Partial<ConsumerDefinition<NotePayload>>, DeadLetterReason, RegExp]>([
    [
      'the effect throws with a detail',
      { apply: () => Promise.reject(new DeadLetterError('invalid-tenant', 'site not registered')) },
      'invalid-tenant',
      /dead-lettered as invalid-tenant: rejected by the consumer$/,
    ],
    [
      'the effect throws without a detail',
      { apply: () => Promise.reject(new DeadLetterError('schema-invalid')) },
      'schema-invalid',
      /dead-lettered as schema-invalid: rejected by the consumer$/,
    ],
    [
      'the tenant re-check fails',
      { checkTenant: () => false },
      'tenant-mismatch',
      /dead-lettered as tenant-mismatch: rejected by the consumer$/,
    ],
  ])('dead-letters a DeadLetterError raised while consuming when %s', async (_name, overrides, reason, logged) => {
    const { app, lines, publisher } = await mounted({ consumer: noteConsumer(overrides) });
    const data = JSON.stringify(envelopeJson());
    const response = await deliver(app, pushBodyFor(data));

    expect(response.statusCode).toBe(204);
    expect(publisher.publishRaw).toHaveBeenCalledTimes(1);
    expect(publisher.publishRaw).toHaveBeenCalledWith(DLQ_TOPIC, {
      data: Buffer.from(data, 'utf8'),
      attributes: { ...envelopeAttributesOf(), reason },
      orderingKey: ORDERING_KEY,
    });
    const warnings = linesMatching(lines, logged);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.eventId).toBe(EVENT_ID);
  });

  const PERSONAL_DATA = /jane|smith|example\.org/i;

  it.each<{
    name: string;
    data: string;
    attributes: Record<string, string>;
    consumer?: Partial<ConsumerDefinition<NotePayload>>;
    reason: DeadLetterReason;
    detail: string;
    eventId: string | undefined;
  }>([
    {
      name: 'a name as eventId without a tenantId',
      data: JSON.stringify(envelopeJson({ eventId: 'Jane Smith', tenantId: undefined })),
      attributes: {},
      reason: 'missing-tenant',
      detail: 'envelope has no tenantId',
      eventId: undefined,
    },
    {
      name: 'an email address as eventId and a name as tenantId',
      data: JSON.stringify(envelopeJson({ eventId: 'jane.doe@example.org', tenantId: 'Jane Smith' })),
      attributes: {},
      reason: 'invalid-tenant',
      detail: 'envelope tenantId is not a UUID',
      eventId: undefined,
    },
    {
      name: 'an envelope property named after a person',
      data: JSON.stringify(envelopeJson({ 'Jane Smith': 'jane.doe@example.org' })),
      attributes: envelopeAttributesOf(),
      reason: 'schema-invalid',
      detail: 'envelope fails #/additionalProperties',
      eventId: EVENT_ID,
    },
    {
      name: 'a payload property named after a person and a value breaking the schema',
      data: JSON.stringify(
        envelopeJson({ payload: { noteId: ORDERING_KEY, text: { name: 'Jane Smith' }, 'Jane Smith': 'jane.doe@example.org' } }),
      ),
      attributes: envelopeAttributesOf(),
      reason: 'schema-invalid',
      detail: 'payload fails #/additionalProperties, #/properties/text/type',
      eventId: EVENT_ID,
    },
    {
      name: 'an eventType made of a name',
      data: JSON.stringify(envelopeJson({ eventType: 'jane.smith.created' })),
      attributes: envelopeAttributesOf(),
      reason: 'schema-invalid',
      detail: `envelope eventType does not belong to topic ${TOPIC}`,
      eventId: EVENT_ID,
    },
    {
      name: 'a consumer DeadLetterError detail naming a person',
      data: JSON.stringify(envelopeJson()),
      attributes: envelopeAttributesOf(),
      consumer: {
        apply: () => Promise.reject(new DeadLetterError('tenant-mismatch', 'person Jane Smith <jane.doe@example.org> is elsewhere')),
      },
      reason: 'tenant-mismatch',
      detail: 'rejected by the consumer',
      eventId: EVENT_ID,
    },
  ])('keeps personal data of $name out of every log line', async ({ data, attributes, consumer, reason, detail, eventId }) => {
    const { app, lines, publisher } = await mounted({ consumer: noteConsumer(consumer) });
    const response = await deliver(app, pushBodyFor(data, attributes));

    expect(response.statusCode).toBe(204);
    expect(publisher.publishRaw).toHaveBeenCalledTimes(1);
    expect(publisher.publishRaw).toHaveBeenCalledWith(DLQ_TOPIC, {
      data: Buffer.from(data, 'utf8'),
      attributes: { ...attributes, reason },
      orderingKey: ORDERING_KEY,
    });
    expect(lines).not.toHaveLength(0);
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toMatch(PERSONAL_DATA);
      expect(validateLogRecord(line)).toEqual({ valid: true, errors: [] });
    }
    const warnings = linesMatching(lines, / dead-lettered as /);
    expect(warnings.map((line) => line.message)).toEqual([
      `delivery ${MESSAGE_ID} on ${SUBSCRIPTION} dead-lettered as ${reason}: ${detail}`,
    ]);
    expect(Object.hasOwn(warnings[0] ?? {}, 'eventId')).toBe(eventId !== undefined);
    expect(warnings[0]?.eventId).toBe(eventId);
  });

  it('nacks with 500 when the dead letter cannot be published', async () => {
    const publisher = fakePublisher(new Error('pubsub unavailable'));
    const { app, consumer } = await mounted({ publisher });
    const response = await deliver(app, pushBodyFor('not json'));

    expect(response.statusCode).toBe(500);
    expect(publisher.publishRaw).toHaveBeenCalledTimes(1);
    expect(consumer.apply).not.toHaveBeenCalled();
  });

  it('nacks with 500 and publishes no dead letter when consuming fails', async () => {
    const consumer = noteConsumer({ apply: () => Promise.reject(new Error('database unavailable')) });
    const { app, lines, publisher } = await mounted({ consumer });
    const response = await deliver(app, pushBodyFor(JSON.stringify(envelopeJson())));

    expect(response.statusCode).toBe(500);
    expect(publisher.publishRaw).not.toHaveBeenCalled();
    expect(linesMatching(lines, /^unhandled error$/)).toHaveLength(1);
  });
});

describe('push route authentication', () => {
  it('declares the pubsub-push transport and the pubsub-invoker role', async () => {
    const { app } = await mounted();
    expect(recordedRoutes(app).filter((route) => route.url === PUSH_ROUTE)).toEqual([
      { method: 'POST', url: PUSH_ROUTE, config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] } },
    ]);
  });

  it.each<[string, string, () => Promise<Record<string, string>>]>([
    ['no push key', PUSH_ROUTE, () => Promise.resolve({})],
    ['a wrong push key', `${PUSH_ROUTE}?${pushKeyQuery('not-the-key')}`, () => Promise.resolve({})],
    [
      'only a user token',
      PUSH_ROUTE,
      async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: 'push-user', site: TENANT_A.siteId, roles: ['s2'] })}`,
        [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'gateway', audience: SERVICE })}`,
      }),
    ],
    [
      'a user token beside the push key',
      PUSH_URL,
      async () => ({
        authorization: `Bearer ${await mintUserToken({ sub: 'push-user', site: TENANT_A.siteId, roles: ['s2'] })}`,
      }),
    ],
    [
      'only a service invocation token',
      PUSH_ROUTE,
      async () => ({ [INVOCATION_HEADER]: `Bearer ${await mintServiceToken({ caller: 'people', audience: SERVICE })}` }),
    ],
  ])('refuses a request with %s with 401 before the handler runs', async (_name, url, headers) => {
    const { app, db, publisher, consumer } = await mounted();
    const response = await deliver(app, pushBodyFor(JSON.stringify(envelopeJson())), { url, headers: await headers() });

    expect(response.statusCode).toBe(401);
    expect(consumer.apply).not.toHaveBeenCalled();
    expect(db.statements).toEqual([]);
    expect(publisher.publishRaw).not.toHaveBeenCalled();
  });
});

describe('push subscription registration', () => {
  it.each<[string, Partial<PushSubscriptionOptions<NotePayload>>, RegExp, boolean]>([
    ['an invalid subscription name', { subscription: 'Stub.note' }, /: invalid subscription name$/, true],
    [
      'a topic other than the subscription topic',
      { topic: 'stub.note.deleted.v1' },
      /topic stub\.note\.deleted\.v1 and consumer topic stub\.note\.created\.v1 must both be stub\.note\.created\.v1$/,
      false,
    ],
    [
      'a consumer of another topic',
      { consumer: noteConsumer({ topic: 'stub.note.deleted.v1' }) },
      /consumer topic stub\.note\.deleted\.v1 must both be stub\.note\.created\.v1$/,
      false,
    ],
    ['a payload schema without x-opt2-kind', { payloadSchema: { type: 'object' } }, /: payload schema does not compile$/, true],
    ['a payload schema Ajv cannot compile', { payloadSchema: noteSchema({ type: 'no-such-type' }) }, /does not compile$/, true],
    [
      'a consumer kind other than x-opt2-kind',
      { consumer: noteConsumer({ kind: 'state' }) },
      /consumer kind state differs from the schema's x-opt2-kind process$/,
      false,
    ],
    [
      'a consumer fanout the schema does not declare',
      { consumer: noteConsumer({ fanout: 'userPool' }) },
      /consumer fanout userPool differs from the schema's x-opt2-tenant-fanout undefined$/,
      false,
    ],
    [
      'a schema fanout the consumer does not declare',
      { payloadSchema: noteSchema({ 'x-opt2-tenant-fanout': 'userPool' }) },
      /consumer fanout undefined differs from the schema's x-opt2-tenant-fanout userPool$/,
      false,
    ],
    [
      'a consumer supersedes the schema does not declare',
      { consumer: noteConsumer({ supersedes: true }) },
      /consumer supersedes differs from the schema's x-opt2-supersedes$/,
      false,
    ],
    [
      'a schema supersedes the consumer does not declare',
      { payloadSchema: noteSchema({ 'x-opt2-supersedes': true }) },
      /consumer supersedes differs from the schema's x-opt2-supersedes$/,
      false,
    ],
  ])('fails registration on %s', async (_name, overrides, message, hasCause) => {
    const { app } = await serviceApp(memoryDb());
    const options = {
      subscription: SUBSCRIPTION,
      consumer: noteConsumer(),
      payloadSchema: noteSchema(),
      publisher: fakePublisher(),
      ...overrides,
    };
    const error = thrownBy(() => registerPushSubscription(app, options));

    expect(error).toBeInstanceOf(ConsumerRegistrationError);
    expect(error).toMatchObject({ name: 'ConsumerRegistrationError' });
    expect((error as Error).message).toMatch(new RegExp(`^Push subscription ${options.subscription.replaceAll('.', '\\.')}: `));
    expect((error as Error).message).toMatch(message);
    expect((error as Error).cause !== undefined).toBe(hasCause);
    expect(recordedRoutes(app).some((route) => route.url.startsWith('/internal/v1/events/'))).toBe(false);
  });

  it('fails registration when neither the db option nor the service supplies a database', async () => {
    const { app } = await serviceApp();
    const error = thrownBy(() =>
      registerPushSubscription(app, {
        subscription: SUBSCRIPTION,
        consumer: noteConsumer(),
        payloadSchema: noteSchema(),
        publisher: fakePublisher(),
      }),
    );

    expect(error).toBeInstanceOf(ConsumerRegistrationError);
    expect((error as Error).message).toBe(
      `Push subscription ${SUBSCRIPTION}: no database: pass db or create the service with a pool or schema`,
    );
  });

  it('consumes through the db option when the service has no database', async () => {
    const { app } = await serviceApp();
    const db = memoryDb();
    const consumer = noteConsumer();
    registerPushSubscription(app, {
      subscription: SUBSCRIPTION,
      topic: TOPIC,
      consumer,
      payloadSchema: noteSchema(),
      publisher: fakePublisher(),
      db,
    });
    const response = await deliver(app, pushBodyFor(JSON.stringify(envelopeJson())));

    expect(response.statusCode).toBe(204);
    expect(consumer.apply).toHaveBeenCalledTimes(1);
    expect(db.statements).toHaveLength(1);
  });
});

describe('registerConsumers', () => {
  it('mounts one push route per consumer at /internal/v1/events/<service>.<topic>', async () => {
    const { app } = await serviceApp();
    const db = memoryDb();
    const created = noteConsumer();
    const deleted = noteConsumer({ topic: 'stub.note.deleted.v1' });
    registerConsumers(app, {
      service: SERVICE,
      consumers: [
        { consumer: created, payloadSchema: noteSchema() },
        { consumer: deleted, payloadSchema: noteSchema() },
      ],
      publisher: fakePublisher(),
      db,
    });

    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/v1/events/'))).toEqual([
      { method: 'POST', url: PUSH_ROUTE, config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] } },
      {
        method: 'POST',
        url: '/internal/v1/events/stub.stub.note.deleted.v1',
        config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
      },
    ]);
    const data = JSON.stringify(envelopeJson({ eventType: 'stub.note.deleted' }));
    const response = await deliver(app, pushBodyFor(data, envelopeAttributesOf(), 'stub.stub.note.deleted.v1'), {
      url: `/internal/v1/events/stub.stub.note.deleted.v1?${pushKeyQuery()}`,
    });

    expect(response.statusCode).toBe(204);
    expect(deleted.apply).toHaveBeenCalledTimes(1);
    expect(created.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['a service name that is not a name segment', 'Stub', TOPIC],
    ['a consumer topic that is not a topic name', SERVICE, 'stub.note'],
  ])('fails registration on %s', async (_name, service, topic) => {
    const { app } = await serviceApp(memoryDb());
    const error = thrownBy(() =>
      registerConsumers(app, {
        service,
        consumers: [{ consumer: noteConsumer({ topic }), payloadSchema: noteSchema() }],
        publisher: fakePublisher(),
      }),
    );

    expect(error).toBeInstanceOf(ConsumerRegistrationError);
    expect((error as Error).message).toBe(`Consumer of ${topic} for service ${service}: invalid name`);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});

describe('decodePushBody', () => {
  it('decodes the bytes, attributes and delivery details of a push body', () => {
    const attributes = { tenantId: TENANT_A.tenantId };
    const decoded = decodePushBody({
      message: {
        data: Buffer.from('hello', 'utf8').toString('base64'),
        attributes,
        messageId: MESSAGE_ID,
        publishTime: '2026-03-04T05:06:08.000Z',
        orderingKey: ORDERING_KEY,
      },
      subscription: `projects/opt2-test/subscriptions/${SUBSCRIPTION}`,
      deliveryAttempt: 3,
    });

    expect(decoded).toEqual({
      data: Buffer.from('hello', 'utf8'),
      attributes,
      messageId: MESSAGE_ID,
      publishTime: '2026-03-04T05:06:08.000Z',
      orderingKey: ORDERING_KEY,
      deliveryAttempt: 3,
      subscription: `projects/opt2-test/subscriptions/${SUBSCRIPTION}`,
    });
    expect(decoded.attributes).not.toBe(attributes);
  });

  it.each([
    ['message_id and publish_time aliases', { message_id: 'alias-id', publish_time: 'alias-time' }, 'alias-id', 'alias-time'],
    [
      'camel-case names over their aliases',
      { messageId: 'camel-id', message_id: 'alias-id', publishTime: 'camel-time', publish_time: 'alias-time' },
      'camel-id',
      'camel-time',
    ],
    ['an alias behind an empty camel-case name', { messageId: '', message_id: 'alias-id', publishTime: '' }, 'alias-id', undefined],
  ])('reads %s', (_name, message, messageId, publishTime) => {
    const decoded = decodePushBody({ message, subscription: SUBSCRIPTION });

    expect(decoded.messageId).toBe(messageId);
    expect(decoded.publishTime).toBe(publishTime);
    expect('publishTime' in decoded).toBe(publishTime !== undefined);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('decodes %s data to empty bytes and omits empty optional fields', (_name, data) => {
    const decoded = decodePushBody({
      message: { data, messageId: MESSAGE_ID, orderingKey: '', attributes: null },
      subscription: SUBSCRIPTION,
    });

    expect(decoded).toEqual({ data: Buffer.alloc(0), attributes: {}, messageId: MESSAGE_ID, subscription: SUBSCRIPTION });
    expect(Object.keys(decoded).sort()).toEqual(['attributes', 'data', 'messageId', 'subscription']);
  });

  it('decodes URL-safe base64 like the standard alphabet', () => {
    const decoded = decodePushBody({ message: { data: '-_8=', messageId: MESSAGE_ID }, subscription: SUBSCRIPTION });
    expect(decoded.data).toEqual(Buffer.from('+/8=', 'base64'));
  });

  it.each<[string, unknown, string]>([
    ['null', null, 'push body has no message object'],
    ['a string', 'message', 'push body has no message object'],
    ['an array', [], 'push body has no message object'],
    ['a body without message', { subscription: SUBSCRIPTION }, 'push body has no message object'],
    ['a string message', { message: 'hello', subscription: SUBSCRIPTION }, 'push body has no message object'],
    ['an array message', { message: [], subscription: SUBSCRIPTION }, 'push body has no message object'],
    ['a message without messageId', { message: {}, subscription: SUBSCRIPTION }, 'message has no messageId'],
    ['an empty messageId', { message: { messageId: '' }, subscription: SUBSCRIPTION }, 'message has no messageId'],
    ['a numeric messageId', { message: { messageId: 7 }, subscription: SUBSCRIPTION }, 'message has no messageId'],
    ['a body without subscription', { message: { messageId: MESSAGE_ID } }, 'push body has no subscription'],
    ['an empty subscription', { message: { messageId: MESSAGE_ID }, subscription: '' }, 'push body has no subscription'],
    [
      'a non-string attribute',
      { message: { messageId: MESSAGE_ID, attributes: { aggregateVersion: 3 } }, subscription: SUBSCRIPTION },
      'message.attributes is not a map of strings',
    ],
    [
      'array attributes',
      { message: { messageId: MESSAGE_ID, attributes: ['tenantId'] }, subscription: SUBSCRIPTION },
      'message.attributes is not a map of strings',
    ],
    [
      'string attributes',
      { message: { messageId: MESSAGE_ID, attributes: 'tenantId=a' }, subscription: SUBSCRIPTION },
      'message.attributes is not a map of strings',
    ],
    ['data outside the base64 alphabet', { message: { messageId: MESSAGE_ID, data: 'a*b=' }, subscription: SUBSCRIPTION }, 'message.data is not base64'],
    ['padding inside the data', { message: { messageId: MESSAGE_ID, data: 'ab=c' }, subscription: SUBSCRIPTION }, 'message.data is not base64'],
    ['data of an impossible length', { message: { messageId: MESSAGE_ID, data: 'abcde' }, subscription: SUBSCRIPTION }, 'message.data is not base64'],
    ['numeric data', { message: { messageId: MESSAGE_ID, data: 42 }, subscription: SUBSCRIPTION }, 'message.data is not base64'],
    [
      'a string deliveryAttempt',
      { message: { messageId: MESSAGE_ID }, subscription: SUBSCRIPTION, deliveryAttempt: '2' },
      'deliveryAttempt is not an integer',
    ],
    [
      'a fractional deliveryAttempt',
      { message: { messageId: MESSAGE_ID }, subscription: SUBSCRIPTION, deliveryAttempt: 1.5 },
      'deliveryAttempt is not an integer',
    ],
    [
      'an unsafe deliveryAttempt',
      { message: { messageId: MESSAGE_ID }, subscription: SUBSCRIPTION, deliveryAttempt: 2 ** 53 },
      'deliveryAttempt is not an integer',
    ],
  ])('rejects %s with a PushBodyError', (_name, body, message) => {
    const error = thrownBy(() => decodePushBody(body));

    expect(error).toBeInstanceOf(PushBodyError);
    expect(error).toMatchObject({ name: 'PushBodyError', message });
  });
});

describe('buildPushBody', () => {
  it('names the bare subscription and omits optional fields without a project', () => {
    expect(buildPushBody({ data: 'hello', messageId: MESSAGE_ID, subscription: SUBSCRIPTION })).toEqual({
      message: {
        data: Buffer.from('hello', 'utf8').toString('base64'),
        attributes: {},
        messageId: MESSAGE_ID,
        message_id: MESSAGE_ID,
      },
      subscription: SUBSCRIPTION,
    });
  });

  it('names the subscription resource of the project and carries every optional field', () => {
    const attributes = { tenantId: TENANT_A.tenantId };
    const body = buildPushBody({
      data: Buffer.from('hello', 'utf8'),
      attributes,
      messageId: MESSAGE_ID,
      subscription: SUBSCRIPTION,
      project: 'opt2-test',
      orderingKey: ORDERING_KEY,
      publishTime: '2026-03-04T05:06:08.000Z',
      deliveryAttempt: 4,
    });

    expect(body).toEqual({
      message: {
        data: Buffer.from('hello', 'utf8').toString('base64'),
        attributes,
        messageId: MESSAGE_ID,
        message_id: MESSAGE_ID,
        publishTime: '2026-03-04T05:06:08.000Z',
        publish_time: '2026-03-04T05:06:08.000Z',
        orderingKey: ORDERING_KEY,
      },
      subscription: `projects/opt2-test/subscriptions/${SUBSCRIPTION}`,
      deliveryAttempt: 4,
    });
    expect(body.message.attributes).not.toBe(attributes);
  });

  it.each([
    ['a string as UTF-8', 'héllo ✓'],
    ['a Buffer unchanged', Buffer.from('héllo ✓', 'utf8')],
    ['a Uint8Array unchanged', new Uint8Array(Buffer.from('héllo ✓', 'utf8'))],
  ])('encodes %s', (_name, data) => {
    const body = buildPushBody({ data, messageId: MESSAGE_ID, subscription: SUBSCRIPTION });
    expect(body.message.data).toBe(Buffer.from('héllo ✓', 'utf8').toString('base64'));
  });
});
