// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Dead letters, nacks behind a closed unit gate, and their `opt2-events replay`, on communications' login-mail push route against a throwaway schema. */
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEAD_LETTER_REASON_ATTRIBUTE,
  INBOX_TABLE,
  createPublisher,
  decodeEnvelopeData,
  dlqReplaySubscriptionName,
  dlqTopicName,
  encodeEnvelope,
  originalAttributes,
  subscriptionName,
  type DeadLetterReason,
  type EventEnvelope,
  type EventPublisher,
} from '@opt2/platform/events';
import { MIGRATION_PATH_PREFIX, UNIT_GATE_TABLE, qualified, type GateRequest } from '@opt2/platform/migration-kit';
import { isTenantId, tenantIdForSite, withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_LIST,
  createThrowawaySchema,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushTo,
  seedRegistry,
  withEnvelopeTenant,
  withoutTenant,
  type TenantlessEnvelope,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import { DELIVERY_STATUS_CHANGED_TOPIC } from '../../src/events/delivery-status-changed.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { DELIVERY_STATUS, MESSAGE } from '../../src/repo/tables.js';
import { buildTestApp, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';
import { envelopeFor, loginMailPayload, producerValidator } from '../helpers/payloads.js';

interface DeadLetterCase {
  label: string;
  reason: DeadLetterReason;
  envelope: (messageId: string) => TenantlessEnvelope;
}

const LOGIN_MAIL_DLQ = dlqTopicName(LOGIN_MAIL_SUBSCRIPTION);
const GATE_PATH = `${MIGRATION_PATH_PREFIX}/gate`;
const GATE_HOLDER = 'window-dlq-suite';
const UNREGISTERED_TENANT = tenantIdForSite('no-such-site');
const FIXTURE_TENANTS: readonly string[] = TENANT_LIST.map(({ tenantId }) => tenantId);

const DEAD_LETTER_CASES: DeadLetterCase[] = [
  {
    label: 'a missing tenant',
    reason: 'missing-tenant',
    envelope: (messageId) => withoutTenant(envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: TENANT_A.tenantId })),
  },
  {
    label: 'an invalid tenant (a site id, not a UUID)',
    reason: 'invalid-tenant',
    envelope: (messageId) => withEnvelopeTenant(envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId })), TENANT_A.siteId),
  },
  {
    label: 'an invalid tenant (an unregistered UUID)',
    reason: 'invalid-tenant',
    envelope: (messageId) => envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: UNREGISTERED_TENANT }),
  },
  {
    label: 'a schema-invalid payload',
    reason: 'schema-invalid',
    envelope: (messageId) => {
      const { subject: _subject, ...payload } = loginMailPayload({ messageId });
      return envelopeFor(LOGIN_MAIL_TOPIC, payload, { tenantId: TENANT_A.tenantId });
    },
  },
];

let messageIds = 0;

/** The next CF UUID of a fixed sequence, so no case can see another case's message row. */
function nextMessageId(): string {
  messageIds += 1;
  return `D1000000-0000-4000-${messageIds.toString(16).toUpperCase().padStart(16, '0')}`;
}

// An unset PG_HOST means no PostgreSQL is configured; pgAvailable would reject on the missing settings.
const pgReason = process.env.PG_HOST ? 'requires PostgreSQL: server unreachable' : 'requires PostgreSQL: PG_HOST not set';
const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)(`communications login-mail push route${available ? '' : ` (${pgReason})`}`, () => {
  let schema: ThrowawaySchema;
  let ctx: TestApp<TenantDb>;

  /** Rows of `table` whose `column` is `value`, summed over the fixture tenants and `extraTenant` when it is a UUID; RLS hides them from any other session. */
  async function countRows(table: string, column: string, value: string, extraTenant?: string): Promise<number> {
    const tenants = new Set(FIXTURE_TENANTS);
    if (isTenantId(extraTenant)) tenants.add(extraTenant.toLowerCase());
    let total = 0;
    for (const tenantId of tenants) {
      total += await withTenant(schema.app, tenantId, async (tx) => {
        const { rowCount } = await tx.query(`SELECT 1 FROM ${qualified(schema.schema, table)} WHERE ${column} = $1`, [value]);
        return rowCount ?? 0;
      });
    }
    return total;
  }

  async function gate(body: GateRequest) {
    return ctx.app.inject({ method: 'POST', url: GATE_PATH, headers: await headersFor('service:migration'), payload: body });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
    });
    await seedRegistry(schema.app, schema.schema);
    ctx = await buildTestApp({ db: schema.app, seedRegistry: false });
    // Start-up registers every gate legacy-authoritative; login-mail writes need the message units target-authoritative.
    await withMetadata(schema.app, (tx) =>
      tx.query(
        `UPDATE ${qualified(schema.schema, UNIT_GATE_TABLE)} SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`,
        [[MESSAGE.unit, DELIVERY_STATUS.unit]],
      ),
    );
  });

  beforeEach(() => {
    ctx.publisher.clear();
  });

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  describe('dead letters and nacks', () => {
    it.each(DEAD_LETTER_CASES)('dead-letters $label', async ({ reason, envelope: build }) => {
      const messageId = nextMessageId();
      const envelope = build(messageId);
      const sentBefore = ctx.mail.sent.length;
      // Only the schema case may fail the producer schema, so the tenant cases are rejected for their tenant alone.
      expect(producerValidator(LOGIN_MAIL_TOPIC).validatePayload(envelope.payload).ok).toBe(reason !== 'schema-invalid');

      const response = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope);

      expect(response.statusCode).toBe(204);
      expect(ctx.publisher.raw.map(({ topic }) => topic)).toEqual([LOGIN_MAIL_DLQ]);
      const [letter] = ctx.publisher.raw;
      expect(letter?.message.attributes[DEAD_LETTER_REASON_ATTRIBUTE]).toBe(reason);
      expect(letter?.message.data).toEqual(encodeEnvelope(envelope as EventEnvelope));
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId, envelope.tenantId)).toBe(0);
      expect(await countRows(MESSAGE.table, 'message_id', messageId, envelope.tenantId)).toBe(0);
      expect(ctx.mail.sent).toHaveLength(sentBefore);
    });

    it('nacks while the message gate is closed', { timeout: 45_000 }, async () => {
      const messageId = nextMessageId();
      const envelope = envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: TENANT_A.tenantId });
      const delivery = randomUUID();
      const sentBefore = ctx.mail.sent.length;

      const closed = await gate({ op: 'close', units: [MESSAGE.unit], holderId: GATE_HOLDER });
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toEqual({ units: [{ unit: MESSAGE.unit, state: 'closed', holderId: GATE_HOLDER, phase: 'quiet' }] });

      const nacked = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope, { messageId: delivery, deliveryAttempt: 1 });

      // The consumer's message read fences the gate before its insert, so the closed gate nacks as GateRaceError without the gate wait.
      expect(nacked.statusCode).toBe(503);
      expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId)).toBe(0);
      expect(await countRows(MESSAGE.table, 'message_id', messageId)).toBe(0);
      expect(ctx.mail.sent).toHaveLength(sentBefore);

      const reopened = await gate({ op: 'open', units: [MESSAGE.unit], holderId: GATE_HOLDER });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json()).toEqual({ units: [{ unit: MESSAGE.unit, state: 'open', holderId: null, phase: 'quiet' }] });

      const redelivered = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope, { messageId: delivery, deliveryAttempt: 2 });

      expect(redelivered.statusCode).toBe(204);
      expect(ctx.publisher.deadLetters(LOGIN_MAIL_SUBSCRIPTION)).toEqual([]);
      expect(await countRows(INBOX_TABLE, 'event_id', envelope.eventId)).toBe(1);
      expect(await countRows(MESSAGE.table, 'message_id', messageId)).toBe(1);
      expect(ctx.mail.sent).toHaveLength(sentBefore + 1);
    });
  });
});

/** A message as an emulator pull subscription received it. */
interface Received {
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey?: string;
}

/** Body of the emulator's `:pull` answer. */
interface PullResponse {
  receivedMessages?: Array<{ ackId: string; message: { data?: string; attributes?: Record<string, string>; orderingKey?: string } }>;
}

const runFile = promisify(execFile);
const OPT2_EVENTS_BIN = fileURLToPath(new URL('../../node_modules/.bin/opt2-events', import.meta.url));
// A project of its own per run: replay republishes to the fixed login-mail topic, which must never reach a live topology.
const REPLAY_PROJECT = `${process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local'}-dlq-${randomBytes(4).toString('hex')}`;
const REPLAY_SOURCE = dlqReplaySubscriptionName(LOGIN_MAIL_SUBSCRIPTION);
const LOGIN_MAIL_OBSERVER = subscriptionName('observer', LOGIN_MAIL_TOPIC);
const DLQ_OBSERVER = `${LOGIN_MAIL_DLQ}.observer`;
// The app's outbox publishes delivery-status changes after commit, so that topic must exist too.
const REPLAY_TOPICS = [LOGIN_MAIL_TOPIC, LOGIN_MAIL_DLQ, DELIVERY_STATUS_CHANGED_TOPIC];
const REPLAY_SUBSCRIPTIONS: ReadonlyArray<readonly [name: string, topic: string]> = [
  [LOGIN_MAIL_OBSERVER, LOGIN_MAIL_TOPIC],
  [REPLAY_SOURCE, LOGIN_MAIL_DLQ],
  [DLQ_OBSERVER, LOGIN_MAIL_DLQ],
];
const REPLAY_IDLE_SECONDS = '2';
const PULL_DEADLINE_MS = 10_000;
// Quiet time after the last pulled message before a pull window closes; an empty subscription is watched this long.
const PULL_QUIET_MS = 1_000;
const WAIT = { timeout: 10_000, interval: 50 };
// Time for a second after-commit send, were one queued, to reach the fake transport.
const SETTLE_MS = 250;

/** Calls the emulator REST API under the replay project; throws on a non-2xx status other than `tolerated`. */
async function emulator(method: 'PUT' | 'POST' | 'DELETE', resource: string, body?: unknown, tolerated?: number): Promise<unknown> {
  const response = await fetch(`http://${process.env.PUBSUB_EMULATOR_HOST}/v1/projects/${REPLAY_PROJECT}/${resource}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok && response.status !== tolerated) {
    throw new Error(`Pub/Sub emulator ${method} ${resource} answered ${response.status}: ${text}`);
  }
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

/** Pulls and acks `subscription` until it stays quiet for PULL_QUIET_MS after `count` messages, or PULL_DEADLINE_MS passes. */
async function pullAll(subscription: string, count: number): Promise<Received[]> {
  const received: Received[] = [];
  const deadline = Date.now() + PULL_DEADLINE_MS;
  let lastArrival = Date.now();
  while (Date.now() < deadline && (received.length < count || Date.now() - lastArrival < PULL_QUIET_MS)) {
    // Without returnImmediately the emulator holds an empty pull open for about 90 s.
    const { receivedMessages = [] } = (await emulator('POST', `subscriptions/${subscription}:pull`, {
      maxMessages: 100,
      returnImmediately: true,
    })) as PullResponse;
    if (receivedMessages.length === 0) {
      await sleep(100);
      continue;
    }
    lastArrival = Date.now();
    await emulator('POST', `subscriptions/${subscription}:acknowledge`, { ackIds: receivedMessages.map(({ ackId }) => ackId) });
    for (const { message } of receivedMessages) {
      received.push({
        data: Buffer.from(message.data ?? '', 'base64'),
        attributes: { ...message.attributes },
        ...(message.orderingKey ? { orderingKey: message.orderingKey } : {}),
      });
    }
  }
  return received;
}

/** Runs the installed `opt2-events replay` bin for the login-mail subscription; resolves to its JSON summary line once it exits 0. */
async function replayLoginMail(): Promise<unknown> {
  const { stdout } = await runFile(
    OPT2_EVENTS_BIN,
    ['replay', '--subscription', LOGIN_MAIL_SUBSCRIPTION, '--project', REPLAY_PROJECT, '--idle-seconds', REPLAY_IDLE_SECONDS],
    { env: { ...process.env } },
  );
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as unknown;
}

const emulatorAvailable = await pubsubEmulatorAvailable();
const replayAvailable = available && emulatorAvailable;
const replayReason = available ? 'requires the Pub/Sub emulator: PUBSUB_EMULATOR_HOST unset or unreachable' : pgReason;

describe.skipIf(!replayAvailable)(`communications login-mail DLQ replay${replayAvailable ? '' : ` (${replayReason})`}`, () => {
  let schema: ThrowawaySchema;
  let ctx: TestApp<TenantDb, FakeTaskPort, EventPublisher>;

  /** `columns` of the `table` rows whose `column` is `value`, over every fixture tenant. */
  async function rowsWhere<T extends Record<string, unknown>>(table: string, columns: string, column: string, value: string): Promise<T[]> {
    const rows: T[] = [];
    for (const tenantId of FIXTURE_TENANTS) {
      const result = await withTenant(schema.app, tenantId, (tx) =>
        tx.query<T>(`SELECT ${columns} FROM ${qualified(schema.schema, table)} WHERE ${column} = $1`, [value]),
      );
      rows.push(...result.rows);
    }
    return rows;
  }

  beforeAll(async () => {
    for (const topic of REPLAY_TOPICS) await emulator('PUT', `topics/${topic}`, {});
    for (const [name, topic] of REPLAY_SUBSCRIPTIONS) {
      await emulator('PUT', `subscriptions/${name}`, { topic: `projects/${REPLAY_PROJECT}/topics/${topic}`, enableMessageOrdering: true });
    }
    schema = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
    });
    // No registry yet: the consumer rejects every tenant as invalid-tenant until the case seeds it.
    ctx = await buildTestApp({
      db: schema.app,
      seedRegistry: false,
      publisher: createPublisher({ projectId: REPLAY_PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST }),
    });
    await withMetadata(schema.app, (tx) =>
      tx.query(
        `UPDATE ${qualified(schema.schema, UNIT_GATE_TABLE)} SET state = 'open', holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`,
        [[MESSAGE.unit, DELIVERY_STATUS.unit]],
      ),
    );
  });

  afterAll(async () => {
    try {
      for (const [name] of REPLAY_SUBSCRIPTIONS) await emulator('DELETE', `subscriptions/${name}`, undefined, 404);
      for (const topic of REPLAY_TOPICS) await emulator('DELETE', `topics/${topic}`, undefined, 404);
    } finally {
      try {
        await ctx?.app.close();
      } finally {
        await schema?.drop();
      }
    }
  });

  it('replays a dead letter once to its original topic', { timeout: 90_000 }, async () => {
    const messageId = nextMessageId();
    const envelope = envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload({ messageId }), { tenantId: TENANT_A.tenantId });
    const data = encodeEnvelope(envelope);
    const summary = { subscription: LOGIN_MAIL_SUBSCRIPTION, source: REPLAY_SOURCE, topic: LOGIN_MAIL_TOPIC, stoppedBy: 'idle' };

    const rejected = [await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope), await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, envelope)];

    expect(rejected.map(({ statusCode }) => statusCode)).toEqual([204, 204]);
    const letters = await pullAll(DLQ_OBSERVER, 2);
    expect(letters.map((letter) => letter.attributes[DEAD_LETTER_REASON_ATTRIBUTE])).toEqual(['invalid-tenant', 'invalid-tenant']);
    expect(letters.map((letter) => letter.attributes.eventId)).toEqual([envelope.eventId, envelope.eventId]);
    expect(letters.map((letter) => letter.data)).toEqual([data, data]);
    expect(await rowsWhere(INBOX_TABLE, 'event_id', 'event_id', envelope.eventId)).toEqual([]);
    expect(await rowsWhere(MESSAGE.table, 'message_id', 'message_id', messageId)).toEqual([]);
    expect(ctx.mail.sent).toEqual([]);

    await seedRegistry(schema.app, schema.schema);

    expect(await replayLoginMail()).toEqual({ ...summary, replayed: 2 });
    const copies = await pullAll(LOGIN_MAIL_OBSERVER, 2);
    expect(copies.map((copy) => copy.data)).toEqual([data, data]);
    expect(copies.map((copy) => copy.attributes)).toEqual(letters.map((letter) => originalAttributes(letter.attributes)));
    expect(copies.map((copy) => copy.attributes[DEAD_LETTER_REASON_ATTRIBUTE])).toEqual([undefined, undefined]);
    expect(copies.map((copy) => copy.orderingKey)).toEqual([envelope.aggregateId, envelope.aggregateId]);

    // Each copy is pushed as Pub/Sub would deliver it, and the first is redelivered under its delivery id.
    const deliveries = copies.map((copy) => ({ copy, delivery: randomUUID() }));
    const statuses: number[] = [];
    for (const { copy, delivery } of [...deliveries, ...deliveries.slice(0, 1)]) {
      const response = await pushTo(ctx.app, LOGIN_MAIL_SUBSCRIPTION, decodeEnvelopeData(copy.data) as EventEnvelope, {
        messageId: delivery,
        attributes: copy.attributes,
        orderingKey: copy.orderingKey,
      });
      statuses.push(response.statusCode);
    }

    expect(statuses).toEqual([204, 204, 204]);
    // The send and its delivery confirmation run after the consumer's transaction commits, outside the push request.
    await vi.waitFor(() => expect(ctx.mail.sent).toHaveLength(1), WAIT);
    await vi.waitFor(async () => {
      expect(await rowsWhere(MESSAGE.table, 'state', 'message_id', messageId)).toEqual([{ state: 'delivered' }]);
    }, WAIT);
    await sleep(SETTLE_MS);
    expect(await rowsWhere(INBOX_TABLE, 'event_id, subscription, status', 'event_id', envelope.eventId)).toEqual([
      { event_id: envelope.eventId, subscription: LOGIN_MAIL_SUBSCRIPTION, status: 'applied' },
    ]);
    expect(await rowsWhere(MESSAGE.table, 'message_id, event_id', 'message_id', messageId)).toEqual([
      { message_id: messageId, event_id: envelope.eventId },
    ]);
    expect(ctx.mail.sent).toHaveLength(1);
    expect(ctx.mail.sent[0]).toMatchObject({ messageId });
    expect(await pullAll(DLQ_OBSERVER, 0)).toEqual([]);

    expect(await replayLoginMail()).toEqual({ ...summary, replayed: 0 });
    expect(await pullAll(LOGIN_MAIL_OBSERVER, 0)).toEqual([]);
    expect(ctx.mail.sent).toHaveLength(1);
  });
});
