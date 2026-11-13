import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublisher,
  decodeEnvelopeData,
  eventTypeOf,
  eventsSql,
  schemaVersionOf,
  validateEnvelope,
  type EventEnvelope,
  type EventPublisher,
} from '../../src/events/index.js';
import { createLogger } from '../../src/logging/index.js';
import { migrationKitSql } from '../../src/migration-kit/index.js';
import {
  FLUSH_DEADLINE_MS,
  OutboxNotConfiguredError,
  OutboxTransactionError,
  createOutbox,
  discardOperation,
  localTimestamp,
  outboxSql,
  outboxTable,
  releaseOperation,
  resetOutboxRuntimes,
  rowFromDb,
  selectPublishable,
  sweepOutbox,
  writeOutbox,
  type OutboxOrigin,
  type OutboxRow,
  type OutboxRuntime,
  type OutboxWriteInput,
} from '../../src/outbox/index.js';
import { createService, loadEnv } from '../../src/service-kit/index.js';
import { scheduledTaskQueueSql } from '../../src/tasks/index.js';
import { rlsSql, tenantRegistrySql, withTenant, type TenantTx } from '../../src/tenancy/index.js';
import {
  ROLE_SET,
  TENANT_A,
  TENANT_B,
  authHeadersFor,
  businessClock,
  createCapturingPublisher,
  createTestSubscription,
  createTestTopic,
  createThrowawaySchema,
  pgAvailable,
  pubsubEmulatorAvailable,
  seedRegistry,
  testVerifier,
  type CapturingPublisher,
  type RoleSubject,
  type TestSubscription,
  type ThrowawaySchema,
} from '../../src/testing/index.js';

const SERVICE = 'stub';
const PG_VARS = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const NOTES_ROUTE = '/test/notes';
const clock = businessClock();
const STAMP = localTimestamp(clock.now());
const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
// Nothing listens on the discard port, so every publish through it stays pending while the client retries.
const UNREACHABLE_PUBSUB_HOST = '127.0.0.1:9';
// Room for the flush's own statements beyond its deadline.
const FLUSH_MARGIN_MS = 1_000;

interface NotePayload {
  noteId: string;
  value: string;
}

/** A message pulled from an emulator subscription, with its data decoded as an envelope. */
interface ReceivedEvent {
  envelope: EventEnvelope;
  attributes: Record<string, string>;
  orderingKey?: string;
}

let handle: ThrowawaySchema;
let emulator: EventPublisher;
let stateTopic: string;
let processTopic: string;
let stateSub: TestSubscription;
let processSub: TestSubscription;
const cleanups: (() => Promise<unknown>)[] = [];

/** Throws naming every variable or server the suite needs that is missing or unreachable. */
async function requireBackends(): Promise<void> {
  const problems: string[] = [];
  const missingPg = PG_VARS.filter((name) => !process.env[name]);
  if (missingPg.length > 0) {
    problems.push(`set ${missingPg.join(', ')}`);
  } else if (!(await pgAvailable())) {
    problems.push(`PostgreSQL at PG_HOST/PG_PORT ${process.env.PG_HOST}:${process.env.PG_PORT} is unreachable`);
  }
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    problems.push('set PUBSUB_EMULATOR_HOST');
  } else if (!(await pubsubEmulatorAvailable())) {
    problems.push(`the Pub/Sub emulator at PUBSUB_EMULATOR_HOST ${process.env.PUBSUB_EMULATOR_HOST} is unreachable`);
  }
  if (problems.length > 0) {
    throw new Error(`The outbox flush suite needs PostgreSQL 16 and the Pub/Sub emulator: ${problems.join('; ')}`);
  }
}

/** DDL of the tenant-owned aggregate table the business writes update, for schema `stub`. */
function testAggregateSql(): string {
  return [
    `CREATE TABLE ${SERVICE}.test_aggregate (`,
    '  tenant_id uuid NOT NULL,',
    '  aggregate_id text NOT NULL,',
    '  version integer NOT NULL,',
    '  value text,',
    '  PRIMARY KEY (tenant_id, aggregate_id)',
    ');',
    rlsSql(SERVICE, 'test_aggregate'),
  ].join('\n');
}

/** Registers the outbox runtime of the throwaway schema over `publisher`. */
function outboxWith(publisher: EventPublisher): OutboxRuntime {
  return createOutbox({ service: SERVICE, db: handle.app, publisher, logger, clock });
}

/** Registers an outbox runtime over a fresh capturing publisher. */
function capturingOutbox(): { runtime: OutboxRuntime; capture: CapturingPublisher } {
  const capture = createCapturingPublisher();
  return { runtime: outboxWith(capture), capture };
}

/** A note event for `aggregateId` on `topic`; `extra` overrides any field. */
function noteEvent(topic: string, aggregateId: string, extra: Partial<OutboxWriteInput<NotePayload>> = {}): OutboxWriteInput<NotePayload> {
  return {
    topic,
    kind: 'state',
    aggregateType: 'note',
    aggregateId,
    aggregateVersion: 1,
    payload: { noteId: aggregateId, value: `value ${aggregateId}` },
    ...extra,
  };
}

/** Upserts the note's aggregate row and writes its event in `tx`, as a producer's business write does. */
async function saveNote(tx: TenantTx, input: OutboxWriteInput<NotePayload>): Promise<EventEnvelope<NotePayload> | null> {
  await tx.query(
    `INSERT INTO "${handle.schema}".test_aggregate (tenant_id, aggregate_id, version, value) VALUES ($1, $2, $3, $4)` +
      ' ON CONFLICT (tenant_id, aggregate_id) DO UPDATE SET version = EXCLUDED.version, value = EXCLUDED.value',
    [tx.tenantId, input.aggregateId, input.aggregateVersion, input.payload.value],
  );
  return writeOutbox(tx, input);
}

/** Outbox rows of `tenantId`, read as the app role under RLS, in seq order. */
async function outboxRows(tenantId: string): Promise<OutboxRow[]> {
  return withTenant(handle.app, tenantId, async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM ${outboxTable(handle.schema)} ORDER BY seq`);
    return rows.map(rowFromDb);
  });
}

/** The outbox rows of `tenantId` carrying `eventId`. */
async function rowsFor(tenantId: string, eventId: string): Promise<OutboxRow[]> {
  return (await outboxRows(tenantId)).filter((row) => row.eventId === eventId);
}

/** Counts the aggregate rows of `tenantId` with `aggregateId`, read under RLS. */
async function aggregateCount(tenantId: string, aggregateId: string): Promise<number> {
  return withTenant(handle.app, tenantId, async (tx) => {
    const { rowCount } = await tx.query(`SELECT 1 FROM "${handle.schema}".test_aggregate WHERE aggregate_id = $1`, [aggregateId]);
    return rowCount ?? 0;
  });
}

/** Pulls and acks messages until every id in `eventIds` arrived or `deadlineMs` passed; returns every message pulled. */
async function pullUntil(subscription: TestSubscription, eventIds: readonly string[], deadlineMs = 10_000): Promise<ReceivedEvent[]> {
  const deadline = Date.now() + deadlineMs;
  const pending = new Set(eventIds);
  const received: ReceivedEvent[] = [];
  while (pending.size > 0 && Date.now() < deadline) {
    for (const message of await subscription.pull(pending.size, Math.max(1, deadline - Date.now()))) {
      const envelope = decodeEnvelopeData(message.data) as EventEnvelope;
      received.push({
        envelope,
        attributes: message.attributes,
        ...(message.orderingKey === undefined ? {} : { orderingKey: message.orderingKey }),
      });
      pending.delete(envelope.eventId);
    }
  }
  return received;
}

/** The pulled messages carrying `eventId`. */
function withEventId(received: readonly ReceivedEvent[], eventId: string): ReceivedEvent[] {
  return received.filter((message) => message.envelope.eventId === eventId);
}

/** Envelopes the capturing publisher accepted for `eventId`. */
function capturedFor(capture: CapturingPublisher, eventId: string): EventEnvelope[] {
  return capture.published.filter((entry) => entry.envelope.eventId === eventId).map((entry) => entry.envelope);
}

/** Envelopes the capturing publisher accepted for notes of `aggregateId`. */
function capturedForAggregate(capture: CapturingPublisher, aggregateId: string): EventEnvelope[] {
  return capture.published.filter((entry) => entry.envelope.aggregateId === aggregateId).map((entry) => entry.envelope);
}

/** The authorisation-matrix subject named `name`. */
function subject(name: string): RoleSubject {
  const found = ROLE_SET.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`ROLE_SET has no subject ${name}`);
  }
  return found;
}

/** A local environment for the stub service; nothing listens, so the port and JWKS URL are never used. */
function serviceEnv() {
  return loadEnv(undefined, {
    PORT: '8199',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: tmpdir(),
    TZ: 'UTC',
  });
}

/** Creates an emulator topic with one pull subscription, both deleted after the suite. */
async function topicWithSubscription(): Promise<{ topic: string; subscription: TestSubscription }> {
  const topic = await createTestTopic(SERVICE);
  cleanups.push(() => topic.delete());
  const subscription = await createTestSubscription(topic, { consumer: SERVICE });
  cleanups.push(() => subscription.delete());
  return { topic: topic.name, subscription };
}

describe('outbox writer and in-request flush against PostgreSQL and the Pub/Sub emulator', () => {
  beforeAll(async () => {
    await requireBackends();
    handle = await createThrowawaySchema({
      service: SERVICE,
      extraSql: [
        outboxSql(SERVICE),
        eventsSql(SERVICE),
        tenantRegistrySql(SERVICE),
        migrationKitSql(SERVICE),
        scheduledTaskQueueSql(SERVICE),
        testAggregateSql(),
      ],
    });
    cleanups.push(() => handle.drop());
    await seedRegistry(handle.app);
    ({ topic: stateTopic, subscription: stateSub } = await topicWithSubscription());
    ({ topic: processTopic, subscription: processSub } = await topicWithSubscription());
    // The emulator helpers default to project opt2-local, so the publisher must too.
    emulator = createPublisher({
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local',
      emulatorHost: process.env.PUBSUB_EMULATOR_HOST,
    });
    cleanups.push(() => emulator.close());
  });

  afterEach(() => {
    resetOutboxRuntimes();
  });

  afterAll(async () => {
    resetOutboxRuntimes();
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'outbox flush suite cleanup failed');
    }
  });

  it('publishes and stamps published_at before the route responds', async () => {
    outboxWith(emulator);
    const app = await createService({ name: SERVICE, version: '1.0.0', env: serviceEnv(), verifierOverride: testVerifier(SERVICE), logger });
    try {
      app.post(NOTES_ROUTE, { config: { opt2: { requires: ['s2'] } } }, async (request) => {
        const aggregateId = randomUUID();
        const envelope = await withTenant(handle.app, request.opt2.tenantId ?? '', (tx) =>
          saveNote(tx, noteEvent(stateTopic, aggregateId)),
        );
        return { eventId: envelope?.eventId, aggregateId };
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: NOTES_ROUTE,
        headers: await authHeadersFor(subject('s2'), { audience: SERVICE, site: TENANT_A.siteId }),
      });

      expect(res.statusCode).toBe(200);
      const { eventId, aggregateId } = res.json<{ eventId: string; aggregateId: string }>();
      const rows = await rowsFor(TENANT_A.tenantId, eventId);
      expect(rows).toMatchObject([{ tenantId: TENANT_A.tenantId, held: false, publishedAt: STAMP }]);
      expect(await aggregateCount(TENANT_A.tenantId, aggregateId)).toBe(1);

      const received = withEventId(await pullUntil(stateSub, [eventId]), eventId);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        envelope: rows[0]?.envelope,
        orderingKey: aggregateId,
        attributes: { eventId, tenantId: TENANT_A.tenantId, aggregateVersion: '1' },
      });
    } finally {
      await app.close();
    }
  });

  it('writes exactly one row per call with its own seq and publishes the rows only after commit, in seq order', async () => {
    const { capture } = capturingOutbox();
    const aggregateId = randomUUID();

    const written = await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const first = await saveNote(tx, noteEvent(stateTopic, aggregateId));
      const second = await saveNote(tx, noteEvent(stateTopic, aggregateId, { aggregateVersion: 2 }));
      const { rows } = await tx.query<{ event_id: string }>(
        `SELECT event_id FROM ${outboxTable(handle.schema)} WHERE ordering_key = $1 ORDER BY seq`,
        [aggregateId],
      );
      expect(rows.map((row) => row.event_id)).toEqual([first?.eventId, second?.eventId]);
      expect(capture.published).toEqual([]);
      return [first, second];
    });

    const rows = (await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId);
    expect(rows.map((row) => row.eventId)).toEqual(written.map((envelope) => envelope?.eventId));
    expect(BigInt(rows[0]?.seq ?? 0)).toBeLessThan(BigInt(rows[1]?.seq ?? 0));
    rows.forEach((row, index) => {
      expect(row).toMatchObject({
        tenantId: TENANT_A.tenantId,
        topic: stateTopic,
        kind: 'state',
        orderingKey: aggregateId,
        envelope: written[index],
        operationId: null,
        held: false,
        createdAt: STAMP,
        publishedAt: STAMP,
      });
    });
    expect(capture.published).toEqual(written.map((envelope) => ({ topic: stateTopic, envelope })));
  });

  it('writes no row and publishes nothing when the business transaction rolls back', async () => {
    const { capture } = capturingOutbox();
    const aggregateId = randomUUID();
    let eventId: string | undefined;

    await expect(
      withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
        eventId = (await saveNote(tx, noteEvent(stateTopic, aggregateId)))?.eventId;
        throw new Error('business rule rejected the note');
      }),
    ).rejects.toThrow('business rule rejected the note');

    expect(eventId).toBeDefined();
    expect(await rowsFor(TENANT_A.tenantId, String(eventId))).toEqual([]);
    expect(await aggregateCount(TENANT_A.tenantId, aggregateId)).toBe(0);
    expect(capture.published).toEqual([]);
  });

  it('stamps the transaction tenant and topic-derived fields on the envelope, whatever tenant the payload names', async () => {
    const { capture } = capturingOutbox();
    const aggregateId = randomUUID();

    const envelope = await withTenant(handle.app, TENANT_B.tenantId, (tx) =>
      writeOutbox(tx, {
        topic: stateTopic,
        kind: 'state',
        aggregateType: 'note',
        aggregateId,
        aggregateVersion: 3,
        payload: { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId },
      }),
    );

    expect(envelope).toMatchObject({
      tenantId: TENANT_B.tenantId,
      producer: SERVICE,
      eventType: eventTypeOf(stateTopic),
      schemaVersion: schemaVersionOf(stateTopic),
      aggregateType: 'note',
      aggregateId,
      aggregateVersion: 3,
      occurredAt: clock.now().toISOString(),
      payload: { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId },
    });
    expect(validateEnvelope(envelope)).toMatchObject({ ok: true });
    expect(capture.published).toEqual([{ topic: stateTopic, envelope }]);
    expect(await rowsFor(TENANT_B.tenantId, String(envelope?.eventId))).toMatchObject([{ tenantId: TENANT_B.tenantId }]);
    expect(await rowsFor(TENANT_A.tenantId, String(envelope?.eventId))).toEqual([]);
  });

  it('holds operation rows through commit and sweeps until released, then publishes them once', async () => {
    const { runtime, capture } = capturingOutbox();
    const operationId = randomUUID();
    const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      saveNote(tx, noteEvent(stateTopic, randomUUID(), { operationId })),
    );
    const eventId = String(envelope?.eventId);

    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ operationId, held: true, publishedAt: null }]);
    await sweepOutbox(runtime, { service: SERVICE, clock });
    expect(capturedFor(capture, eventId)).toEqual([]);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ held: true, publishedAt: null }]);

    await expect(withTenant(handle.app, TENANT_B.tenantId, (tx) => releaseOperation(tx, operationId))).resolves.toBe(0);
    const released = await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      const count = await releaseOperation(tx, operationId);
      expect(capturedFor(capture, eventId)).toEqual([]);
      return count;
    });

    expect(released).toBe(1);
    expect(capturedFor(capture, eventId)).toEqual([envelope]);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ operationId, held: false, publishedAt: STAMP }]);

    await sweepOutbox(runtime, { service: SERVICE, clock });
    await expect(withTenant(handle.app, TENANT_A.tenantId, (tx) => discardOperation(tx, operationId))).resolves.toBe(0);
    expect(capturedFor(capture, eventId)).toHaveLength(1);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toHaveLength(1);
  });

  it('discards the held rows of an abandoned operation so no sweep ever publishes them', async () => {
    const { runtime, capture } = capturingOutbox();
    const operationId = randomUUID();
    const aggregateId = randomUUID();
    await withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      await saveNote(tx, noteEvent(stateTopic, aggregateId, { operationId }));
      await saveNote(tx, noteEvent(stateTopic, aggregateId, { operationId, aggregateVersion: 2 }));
    });

    await expect(withTenant(handle.app, TENANT_B.tenantId, (tx) => discardOperation(tx, operationId))).resolves.toBe(0);
    await expect(withTenant(handle.app, TENANT_A.tenantId, (tx) => discardOperation(tx, operationId))).resolves.toBe(2);

    expect((await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId)).toEqual([]);
    await sweepOutbox(runtime, { service: SERVICE, clock });
    expect(capturedForAggregate(capture, aggregateId)).toEqual([]);
  });

  describe.each<OutboxOrigin>(['backfill', 'migration-feed'])('a write with origin %s', (origin) => {
    it('suppresses a process event: no envelope, no row, while the business write commits', async () => {
      const { capture } = capturingOutbox();
      const aggregateId = randomUUID();

      const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
        saveNote(tx, noteEvent(processTopic, aggregateId, { kind: 'process', origin })),
      );

      expect(envelope).toBeNull();
      expect((await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId)).toEqual([]);
      expect(await aggregateCount(TENANT_A.tenantId, aggregateId)).toBe(1);
      expect(capture.published).toEqual([]);
    });

    it('stores a state event and publishes it after commit', async () => {
      outboxWith(emulator);
      const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
        saveNote(tx, noteEvent(stateTopic, randomUUID(), { origin })),
      );
      const eventId = String(envelope?.eventId);

      expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ kind: 'state', publishedAt: STAMP }]);
      expect(withEventId(await pullUntil(stateSub, [eventId]), eventId)).toHaveLength(1);
    });
  });

  it.each<{ label: string; origin?: OutboxOrigin }>([
    { label: 'target', origin: 'target' },
    { label: 'legacy-window', origin: 'legacy-window' },
    { label: 'no' },
  ])('stores and publishes a process event written with $label origin', async ({ origin }) => {
    outboxWith(emulator);
    const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      saveNote(tx, noteEvent(processTopic, randomUUID(), { kind: 'process', ...(origin === undefined ? {} : { origin }) })),
    );
    const eventId = String(envelope?.eventId);

    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ kind: 'process', publishedAt: STAMP }]);
    expect(withEventId(await pullUntil(processSub, [eventId]), eventId)).toHaveLength(1);
  });

  it('leaves a row whose flush publish failed to the next sweep, which publishes it once', async () => {
    const { runtime, capture } = capturingOutbox();
    capture.failNext(1);
    const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) => saveNote(tx, noteEvent(stateTopic, randomUUID())));
    const eventId = String(envelope?.eventId);

    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ held: false, publishedAt: null }]);
    expect(capturedFor(capture, eventId)).toEqual([]);

    await expect(sweepOutbox(runtime, { service: SERVICE, clock })).resolves.toMatchObject({ failed: 0, tenants: 3 });
    expect(capturedFor(capture, eventId)).toEqual([envelope]);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ publishedAt: STAMP }]);

    await sweepOutbox(runtime, { service: SERVICE, clock });
    expect(capturedFor(capture, eventId)).toHaveLength(1);
  });

  it('answers a write within the flush deadline while Pub/Sub is unreachable and leaves its row to the sweep, which publishes it once', async () => {
    const unreachable = createPublisher({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'opt2-local', emulatorHost: UNREACHABLE_PUBSUB_HOST });
    // close() first flushes the publish the client still retries, so it is bounded rather than awaited.
    cleanups.push(() => Promise.race([unreachable.close(), sleep(1_000)]));
    outboxWith(unreachable);

    const started = performance.now();
    const envelope = await withTenant(handle.app, TENANT_A.tenantId, (tx) => saveNote(tx, noteEvent(stateTopic, randomUUID())));
    expect(performance.now() - started).toBeLessThan(FLUSH_DEADLINE_MS + FLUSH_MARGIN_MS);
    const eventId = String(envelope?.eventId);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ held: false, publishedAt: null }]);

    const { runtime, capture } = capturingOutbox();
    await expect(sweepOutbox(runtime, { service: SERVICE, clock })).resolves.toMatchObject({ failed: 0, tenants: 3 });
    expect(capturedFor(capture, eventId)).toEqual([envelope]);
    expect(await rowsFor(TENANT_A.tenantId, eventId)).toMatchObject([{ publishedAt: STAMP }]);

    await sweepOutbox(runtime, { service: SERVICE, clock });
    expect(capturedFor(capture, eventId)).toHaveLength(1);
  });

  it("answers a write within the flush deadline while another transaction locks its key's earlier row, then the sweep publishes both in seq order", async () => {
    const { runtime, capture } = capturingOutbox();
    const aggregateId = randomUUID();
    capture.failNext(1);
    const first = await withTenant(handle.app, TENANT_A.tenantId, (tx) => saveNote(tx, noteEvent(stateTopic, aggregateId)));

    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markLocked = (_rows: OutboxRow[]): void => undefined;
    const locked = new Promise<OutboxRow[]>((resolve) => {
      markLocked = resolve;
    });
    const holder = withTenant(handle.app, TENANT_A.tenantId, async (tx) => {
      markLocked(await selectPublishable(tx, handle.schema, { limit: 500 }));
      await released;
    });
    try {
      expect((await locked).map((row) => row.eventId)).toContain(first?.eventId);

      const started = performance.now();
      const second = await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
        saveNote(tx, noteEvent(stateTopic, aggregateId, { aggregateVersion: 2 })),
      );
      expect(performance.now() - started).toBeLessThan(FLUSH_DEADLINE_MS + FLUSH_MARGIN_MS);
      const unpublished = (await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId);
      expect(unpublished.map((row) => [row.eventId, row.publishedAt])).toEqual([
        [first?.eventId, null],
        [second?.eventId, null],
      ]);
      expect(capturedForAggregate(capture, aggregateId)).toEqual([]);

      release();
      await holder;
      await expect(sweepOutbox(runtime, { service: SERVICE, clock })).resolves.toMatchObject({ failed: 0, tenants: 3 });
      expect(capturedForAggregate(capture, aggregateId)).toEqual([first, second]);
      expect((await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId)).toMatchObject([
        { publishedAt: STAMP },
        { publishedAt: STAMP },
      ]);
    } finally {
      release();
      await holder;
    }
  });

  it('rejects a write inside a metadata transaction with OutboxTransactionError', async () => {
    capturingOutbox();
    await expect(
      handle.app.withMetadata((tx) => writeOutbox(tx as unknown as TenantTx, noteEvent(stateTopic, randomUUID()))),
    ).rejects.toThrow(new OutboxTransactionError('metadata'));
  });

  it('rejects a write to a schema without a registered runtime with OutboxNotConfiguredError and rolls the business write back', async () => {
    const aggregateId = randomUUID();
    const write = withTenant(handle.app, TENANT_A.tenantId, (tx) => saveNote(tx, noteEvent(stateTopic, aggregateId)));

    await expect(write).rejects.toBeInstanceOf(OutboxNotConfiguredError);
    await expect(write).rejects.toMatchObject({ schema: handle.schema });
    expect(await aggregateCount(TENANT_A.tenantId, aggregateId)).toBe(0);
    expect((await outboxRows(TENANT_A.tenantId)).filter((row) => row.orderingKey === aggregateId)).toEqual([]);
  });
});
