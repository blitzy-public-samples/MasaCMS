// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `communications.message.delivery-status-changed.v1` outbox over a throwaway PostgreSQL schema: in-request flush, sweep and its successor task. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventPublisher } from '@opt2/platform/events';
import { MIGRATION_PATH_PREFIX, type GateRequest } from '@opt2/platform/migration-kit';
import { outboxTable, rowFromDb, type OutboxRow, type SweepResult } from '@opt2/platform/outbox';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_PATH,
  outboxSweepQueue,
  recurringSpec,
  slotName,
  slotStartS,
  successorSlotS,
  type TaskWireBody,
} from '@opt2/platform/tasks';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  mintTasksInvokerToken,
  pgAvailable,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import type { MessageDetailView, MessageInput } from '../../src/domain/messages.js';
import { DELIVERY_STATUS_CHANGED_TOPIC } from '../../src/events/delivery-status-changed.js';
import { DELIVERY_STATUS, MESSAGE } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';

const SERVICE = 'communications';
const SENDER = 'communications.sender';
const SWEEP_QUEUE = outboxSweepQueue(SERVICE);
const MESSAGES_URL = `${FIXTURE_PREFIX}/messages?siteid=${TENANT_A.siteId}`;
const CSRF_HEADERS = { 'x-csrf_token': 'OUTBOX-SUITE-TOKEN', 'x-csrf_token_expires': '260630130000000' };
const GATE_UNITS = [MESSAGE.unit, DELIVERY_STATUS.unit];
const GATE_HOLDER = 'communications-outbox-events-suite';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_SKIP = !process.env.PG_HOST ? 'PG_HOST not set' : (await pgAvailable()) ? undefined : `${process.env.PG_HOST} unreachable`;

describe.skipIf(PG_SKIP !== undefined)(`delivery-status outbox${PG_SKIP === undefined ? '' : ` (requires PostgreSQL: ${PG_SKIP})`}`, () => {
  const capturing = createCapturingPublisher();
  let failing = false;
  let schema!: ThrowawaySchema;
  let ctx!: TestApp<TenantDb, FakeTaskPort, EventPublisher>;
  let nowS!: number;
  let intervalS!: number;

  // While `failing`, every publish rejects as an unreachable Pub/Sub would, so flushed rows stay committed and unpublished.
  const publisher: EventPublisher = {
    async publish(topic, envelope) {
      if (failing) throw new Error('publisher unavailable');
      return capturing.publish(topic, envelope);
    },
    async publishRaw(topic, message) {
      if (failing) throw new Error('publisher unavailable');
      return capturing.publishRaw(topic, message);
    },
    close: () => capturing.close(),
  };

  /** Captured delivery-status events of `messageId`, in publish order. */
  const captured = (messageId: string) =>
    capturing.published.filter((event) => event.topic === DELIVERY_STATUS_CHANGED_TOPIC && event.envelope.aggregateId === messageId);

  /** POSTs `body` to the migration gate endpoint as the migration service. */
  async function gate(body: GateRequest) {
    return ctx.app.inject({ method: 'POST', url: `${MIGRATION_PATH_PREFIX}/gate`, headers: await headersFor('service:migration'), payload: body });
  }

  /** States of the gates the send writes through. */
  async function gateStates(): Promise<string[]> {
    const res = await gate({ op: 'status', units: [...GATE_UNITS] });
    expect(res.statusCode).toBe(200);
    return res.json<{ units: { state: string }[] }>().units.map((unit) => unit.state);
  }

  /** Sends a message through the fixture route as a tenant-a sender; returns its detail. */
  async function send(subject: string): Promise<MessageDetailView> {
    const input: MessageInput = { to: 'recipient@tenant-a.example', subject, bodyText: 'Outbox suite body' };
    const res = await ctx.app.inject({
      method: 'POST',
      url: MESSAGES_URL,
      headers: { ...(await headersFor(SENDER, { site: TENANT_A.siteId })), ...CSRF_HEADERS },
      payload: input,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ method: string; data: MessageDetailView }>();
    expect(body).toMatchObject({ method: 'communications.messages', data: { subject, state: 'delivered' } });
    expect(body.data.history.map((entry) => entry.status)).toEqual(['queued', 'sent', 'delivered']);
    return body.data;
  }

  /** The message's delivery-status outbox rows in `seq` order, read under tenant-a's RLS. */
  async function outboxRows(messageId: string): Promise<OutboxRow[]> {
    const { rows } = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
      tx.query(`SELECT * FROM ${outboxTable(schema.schema)} WHERE topic = $1 AND ordering_key = $2 ORDER BY seq`, [
        DELIVERY_STATUS_CHANGED_TOPIC,
        messageId,
      ]),
    );
    return rows.map(rowFromDb);
  }

  /** Stored delivery-status history rows of the message. */
  async function historyCount(messageId: string): Promise<number> {
    const { rows } = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema.schema}".${DELIVERY_STATUS.table} WHERE message_id = $1`, [messageId]),
    );
    return rows[0]?.n ?? 0;
  }

  /** Sends a message while the publisher is down; returns its committed, unpublished outbox rows. */
  async function unflushedRows(subject: string): Promise<OutboxRow[]> {
    failing = true;
    const { message_id: messageId } = await send(subject);
    failing = false;
    const rows = await outboxRows(messageId);
    expect(rows).toHaveLength(await historyCount(messageId));
    expect(rows.map((row) => row.publishedAt)).toEqual(rows.map(() => null));
    expect(captured(messageId)).toEqual([]);
    return rows;
  }

  /** Delivers the sweep chain task of slot `slotS` as the local Cloud Tasks adapter does. */
  async function sweep(slotS: number) {
    const name = slotName(SWEEP_QUEUE, slotS);
    const body = { queue: SWEEP_QUEUE, name, tenantId: null, payload: {} } satisfies TaskWireBody;
    return ctx.app.inject({
      method: 'POST',
      url: OUTBOX_SWEEP_PATH,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
        [CLOUD_TASKS_HEADERS.taskName]: name,
        [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
      },
      payload: body,
    });
  }

  /** Live sweep chain tasks on the fake port with name `name`. */
  const chainTasks = (name: string) => ctx.taskPort.byQueue(SWEEP_QUEUE).filter((task) => task.name === name);

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
    // buildTestApp seeds the registry of the handle's own schema before it builds.
    ctx = await buildTestApp({ db: schema.app, publisher });
    nowS = Math.floor(ctx.clock.now().getTime() / 1000);
    intervalS = recurringSpec(SWEEP_QUEUE, ctx.env.OPT2_SERVICE_URLS).intervalS;

    if ((await gateStates()).some((state) => state !== 'open')) {
      const opening: GateRequest[] = [
        { op: 'close', units: [...GATE_UNITS], holderId: GATE_HOLDER, allowLegacy: true },
        { op: 'open', units: [...GATE_UNITS], holderId: GATE_HOLDER },
      ];
      for (const request of opening) {
        expect((await gate(request)).statusCode).toBe(200);
      }
    }
    expect(await gateStates()).toEqual(GATE_UNITS.map(() => 'open'));
  });

  afterEach(() => {
    failing = false;
    ctx?.taskPort.failCreate(0);
  });

  afterAll(async () => {
    await ctx?.app.close();
    await schema?.drop();
  });

  it('flushes after commit', async () => {
    const { message_id: messageId } = await send('In-request flush');

    const rows = await outboxRows(messageId);
    expect(rows).toHaveLength(await historyCount(messageId));
    expect(rows.map((row) => row.publishedAt)).not.toContain(null);

    const events = captured(messageId);
    expect(events.map((event) => event.envelope.eventId)).toEqual(rows.map((row) => row.eventId));
    const versions = events.map((event) => event.envelope.aggregateVersion);
    expect(versions.slice(1).every((version, i) => version > (versions[i] as number))).toBe(true);
  });

  it('sweep publishes rows left unpublished', async () => {
    const unflushed = await unflushedRows('Unflushed');
    const [{ orderingKey: messageId }] = unflushed as [OutboxRow, ...OutboxRow[]];
    const slot = slotStartS(nowS, intervalS);
    const successorS = successorSlotS(slot, nowS, intervalS);

    const res = await sweep(slot);

    expect(res.statusCode).toBe(200);
    expect(res.json<SweepResult>()).toMatchObject({ published: unflushed.length, failed: 0 });
    expect((await outboxRows(messageId)).map((row) => row.publishedAt)).not.toContain(null);
    expect(captured(messageId).map((event) => event.envelope.eventId)).toEqual(unflushed.map((row) => row.eventId));
    expect(chainTasks(slotName(SWEEP_QUEUE, successorS))).toEqual([
      expect.objectContaining({ queue: SWEEP_QUEUE, scheduleTime: new Date(successorS * 1000) }),
    ]);
  });

  it('answers 503 and publishes nothing when the successor task cannot be created', async () => {
    const unflushed = await unflushedRows('Successor unavailable');
    const [{ orderingKey: messageId }] = unflushed as [OutboxRow, ...OutboxRow[]];
    const slot = slotStartS(nowS, intervalS) + 5 * intervalS;
    const successor = slotName(SWEEP_QUEUE, successorSlotS(slot, nowS, intervalS));

    ctx.taskPort.failCreate();
    const refused = await sweep(slot);

    expect(refused.statusCode).toBe(503);
    expect((await outboxRows(messageId)).map((row) => row.publishedAt)).toEqual(unflushed.map(() => null));
    expect(captured(messageId)).toEqual([]);
    expect(chainTasks(successor)).toEqual([]);

    const retried = await sweep(slot);

    expect(retried.statusCode).toBe(200);
    expect(chainTasks(successor)).toHaveLength(1);
    expect(captured(messageId).map((event) => event.envelope.eventId)).toEqual(unflushed.map((row) => row.eventId));
  });
});
