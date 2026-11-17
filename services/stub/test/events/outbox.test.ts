/** Outbox recovery of the stub over a throwaway PostgreSQL schema per case: a failed in-request flush, the sweep chain, and a Pub/Sub emulator round trip. */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher, decodeEnvelopeData, encodeEnvelope, envelopeAttributes, type EventEnvelope } from '@opt2/platform/events';
import {
  CLOUD_TASKS_HEADERS,
  OUTBOX_SWEEP_INTERVAL_S,
  OUTBOX_SWEEP_PATH,
  outboxSweepQueue,
  slotName,
  slotStartS,
  successorSlotS,
  taskWireBody,
} from '@opt2/platform/tasks';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  mintTasksInvokerToken,
  pgAvailable,
  pubsubEmulatorAvailable,
  pushTo,
  runCleanup,
  seedRegistry,
  testEnvelope,
  type CapturingPublisher,
  type TestSubscription,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { newNote, noteCreatedPayload } from '../../src/domain/note.js';
import { NOTE_CREATED_SUBSCRIPTION, NOTE_CREATED_TOPIC } from '../../src/events/topics.js';
import { TEST_CLOCK, buildDbApp, createFakeTaskPort, headersFor, type FakeTaskPort, type TestApp } from '../helpers/app.js';

type OutboxRow = { event_id: string; topic: string; ordering_key: string; published_at: Date | null };
type ProjectionRow = { note_id: string; apply_count: number };

const pg = await pgAvailable();
const emulator = await pubsubEmulatorAvailable();

const SERVICE = 'stub';
const QUEUE = outboxSweepQueue(SERVICE);
const INTERVAL_S = OUTBOX_SWEEP_INTERVAL_S;
const NOW_S = Math.floor(TEST_CLOCK.now().getTime() / 1000);
const slot = slotStartS(NOW_S, INTERVAL_S);
// The project the emulator helpers create their topics and subscriptions in.
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local';

describe.skipIf(!pg)('outbox-pubsub-idempotent-consumer', () => {
  let capturing: CapturingPublisher;
  let taskPort: FakeTaskPort;
  let schema: ThrowawaySchema;
  let app: TestApp<TenantDb, CapturingPublisher>['app'];

  // Each case gets its own schema, publisher, task port and app, whose start-up creates the `slot` chain task.
  beforeEach(async () => {
    capturing = createCapturingPublisher();
    taskPort = createFakeTaskPort();
    schema = await createThrowawaySchema({
      service: SERVICE,
      migrationsDir: fileURLToPath(new URL('../../db/migrations/', import.meta.url)),
    });
    await seedRegistry(schema.app, schema.schema);
    ({ app } = await buildDbApp(schema, { publisher: capturing, taskPort, clock: TEST_CLOCK }));
  });

  // Shutdown also ends schema.app, the pool the app was given; drop() skips a pool already ending.
  // Both are idempotent, so releasing the previous case's handles again after a failed beforeEach is harmless.
  afterEach(() => runCleanup('stub outbox case', [() => app?.opt2.shutdown(), () => schema?.drop()]));

  /** Outbox rows of `tenantId` in insertion order. */
  function outboxRows(tenantId: string): Promise<OutboxRow[]> {
    return withTenant(schema.app, tenantId, async (tx) => {
      const sql = `SELECT event_id, topic, ordering_key, published_at FROM "${schema.schema}".outbox ORDER BY seq`;
      return (await tx.query<OutboxRow>(sql)).rows;
    });
  }

  /** Projection rows of `noteId` visible to `tenantId`. */
  function projectionRows(tenantId: string, noteId: string): Promise<ProjectionRow[]> {
    return withTenant(schema.app, tenantId, async (tx) => {
      const sql = `SELECT note_id, apply_count FROM "${schema.schema}".note_projection WHERE note_id = $1`;
      return (await tx.query<ProjectionRow>(sql, [noteId])).rows;
    });
  }

  /** Creates a note as a tenant-A system user while its in-request flush fails, which abandons the request unanswered; resolves to the note id its committed outbox row carries. */
  async function createUnflushedNote(title: string): Promise<string> {
    capturing.failNext();
    const headers = await headersFor('system-user', { site: TENANT_A.siteId });
    await expect(app.inject({ method: 'POST', url: '/opt2/stub/notes', headers, payload: { title, body: '' } })).rejects.toMatchObject({
      code: 'LIGHT_ECONNRESET',
    });
    const rows = (await outboxRows(TENANT_A.tenantId)).filter((row) => row.topic === NOTE_CREATED_TOPIC);
    expect(rows).toHaveLength(1);
    return rows[0]?.ordering_key ?? '';
  }

  /** Delivers the recorded sweep chain task of `slotS` as Cloud Tasks would, `retry` being its prior failed attempts. */
  async function sweep(slotS: number, retry = 0) {
    const name = slotName(QUEUE, slotS);
    const task = taskPort.tasks.find((candidate) => candidate.queue === QUEUE && candidate.name === name);
    if (task === undefined) throw new Error(`No ${QUEUE} task was created for slot ${String(slotS)}`);
    return app.inject({
      method: 'POST',
      url: OUTBOX_SWEEP_PATH,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
        [CLOUD_TASKS_HEADERS.taskName]: name,
        [CLOUD_TASKS_HEADERS.queueName]: QUEUE,
        [CLOUD_TASKS_HEADERS.retryCount]: String(retry),
        [CLOUD_TASKS_HEADERS.executionCount]: String(retry),
        [CLOUD_TASKS_HEADERS.eta]: String(slotS),
      },
      payload: taskWireBody(task),
    });
  }

  it('failed in-request flush leaves the row unpublished', async () => {
    const noteId = await createUnflushedNote('swept');

    const rows = (await outboxRows(TENANT_A.tenantId)).filter((row) => row.ordering_key === noteId);
    expect(rows).toEqual([expect.objectContaining({ topic: NOTE_CREATED_TOPIC, published_at: null })]);
    expect(capturing.published).toEqual([]);
    const note = await app.inject({ method: 'GET', url: `/opt2/stub/notes/${noteId}`, headers: await headersFor('system-user', { site: TENANT_A.siteId }) });
    expect(note.statusCode).toBe(200);
  });

  it('sweep publishes the row once and schedules its successor', async () => {
    const noteId = await createUnflushedNote('swept');
    const seeded = (await outboxRows(TENANT_A.tenantId)).filter((row) => row.ordering_key === noteId);
    expect(seeded).toEqual([expect.objectContaining({ topic: NOTE_CREATED_TOPIC, published_at: null })]);
    const eventId = seeded[0]?.event_id;

    const res = await sweep(slot);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ published: 1, failed: 0 });
    expect(capturing.published.map(({ topic, envelope }) => ({ topic, eventId: envelope.eventId }))).toEqual([
      { topic: NOTE_CREATED_TOPIC, eventId },
    ]);
    const [row] = (await outboxRows(TENANT_A.tenantId)).filter((candidate) => candidate.event_id === eventId);
    expect(row?.published_at).toBeInstanceOf(Date);

    const successorS = successorSlotS(slot, NOW_S, INTERVAL_S);
    expect(successorS).toBe(slot + INTERVAL_S);
    expect(taskPort.tasks.filter((task) => task.name === slotName(QUEUE, successorS))).toEqual([
      expect.objectContaining({
        queue: QUEUE,
        scheduleTime: new Date(successorS * 1000),
        url: expect.stringContaining(OUTBOX_SWEEP_PATH),
      }),
    ]);

    const next = await sweep(successorS);
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ published: 0, failed: 0 });
    expect(capturing.published).toHaveLength(1);
  });

  it('sweep answers 503 when the successor cannot be created', async () => {
    const noteId = await createUnflushedNote('held back');
    const unpublished = async (): Promise<OutboxRow[]> =>
      (await outboxRows(TENANT_A.tenantId)).filter((row) => row.ordering_key === noteId && row.published_at === null);
    expect(await unpublished()).toHaveLength(1);

    taskPort.failCreate();
    const failed = await sweep(slot);
    expect(failed.statusCode).toBe(503);
    expect(capturing.published).toEqual([]);
    expect(await unpublished()).toHaveLength(1);

    taskPort.failCreate(false);
    const retried = await sweep(slot, 1);
    expect(retried.statusCode).toBe(200);
    expect(capturing.published.map(({ envelope }) => envelope.aggregateId)).toEqual([noteId]);
    expect(await unpublished()).toEqual([]);
  });

  it.skipIf(!emulator)('emulator round trip reaches the consumer', async () => {
    const topic = await createTestTopic('stub-note');
    const publisher = createPublisher({ projectId: PROJECT, emulatorHost: process.env.PUBSUB_EMULATOR_HOST });
    let sub: TestSubscription | undefined;
    try {
      sub = await createTestSubscription(topic);
      const note = newNote({ title: 'emulated', body: '' }, TEST_CLOCK);
      const envelope = testEnvelope({
        topic: NOTE_CREATED_TOPIC,
        tenantId: TENANT_A.tenantId,
        aggregateId: note.noteId,
        aggregateVersion: note.rowVersion,
        payload: noteCreatedPayload(note),
      });
      await publisher.publishRaw(topic.name, {
        data: encodeEnvelope(envelope),
        attributes: envelopeAttributes(envelope),
        orderingKey: envelope.aggregateId,
      });

      const [message, ...extra] = await sub.pull(1, 10_000);
      expect(extra).toEqual([]);
      if (message === undefined) throw new Error(`No message arrived on ${sub.name}`);
      const delivered = decodeEnvelopeData(message.data) as EventEnvelope;
      expect(delivered).toEqual(envelope);

      const res = await pushTo(app, NOTE_CREATED_SUBSCRIPTION, delivered);
      expect(res.statusCode).toBe(204);
      expect(await projectionRows(TENANT_A.tenantId, note.noteId)).toEqual([{ note_id: note.noteId, apply_count: 1 }]);
    } finally {
      await runCleanup('emulator round trip', [() => publisher.close(), () => sub?.delete(), () => topic.delete()]);
    }
  });
});
