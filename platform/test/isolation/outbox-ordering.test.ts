import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope, EventPublisher } from '../../src/events/index.js';
import { createLogger } from '../../src/logging/index.js';
import { runReplay } from '../../src/outbox/cli.js';
import { outboxSql } from '../../src/outbox/ddl.js';
import { createOutbox, resetOutboxRuntimes, type OutboxRuntime } from '../../src/outbox/flush.js';
import { sweepOutbox, type SweepResult } from '../../src/outbox/sweep.js';
import { releaseOperation, writeOutbox, type OutboxWriteInput } from '../../src/outbox/writer.js';
import { systemClock } from '../../src/service-kit/index.js';
import { tenantIdForSite } from '../../src/tenancy/index.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';

const WAIT_MS = 10_000;
const TOPIC = 'stub.note.created.v1';
// Seqs above 2^53 collide as Numbers, so only exact bigint handling keeps them apart.
const FIRST_SEQ = '9007199254740993';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `promise`, rejected when it has not settled within WAIT_MS. */
async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`)), WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Polls `check` until it holds; throws after WAIT_MS. */
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`);
    await sleep(25);
  }
}

/** True once `promise` has settled, checked without waiting for it. */
function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

/** A publisher recording each envelope's eventId on arrival; a gated eventId's publish waits until its gate opens. */
function gatedPublisher() {
  const order: string[] = [];
  const gates = new Map<string, { reached: Deferred<void>; opened: Deferred<void> }>();
  const publisher: EventPublisher = {
    async publish(_topic, envelope) {
      order.push(envelope.eventId);
      const gate = gates.get(envelope.eventId);
      if (gate !== undefined) {
        gate.reached.resolve();
        await gate.opened.promise;
      }
      return `msg-${envelope.eventId}`;
    },
    publishRaw: () => Promise.reject(new Error('the outbox publishes envelopes only')),
    close: () => Promise.resolve(),
  };
  const gate = (eventId: string) => {
    const entry = { reached: deferred(), opened: deferred() };
    gates.set(eventId, entry);
    return { reached: entry.reached.promise, open: () => entry.opened.resolve() };
  };
  const openAll = () => {
    for (const entry of gates.values()) entry.opened.resolve();
  };
  return { publisher, order, gate, openAll };
}

/** A publisher whose every publish rejects, as in a process that cannot reach Pub/Sub. */
const unavailable: EventPublisher = {
  publish: () => Promise.reject(new Error('Pub/Sub unavailable')),
  publishRaw: () => Promise.reject(new Error('Pub/Sub unavailable')),
  close: () => Promise.resolve(),
};

function note(aggregateId: string, operationId?: string): OutboxWriteInput {
  return {
    topic: TOPIC,
    kind: 'state',
    aggregateType: 'note',
    aggregateId,
    aggregateVersion: 1,
    payload: { aggregateId },
    ...(operationId === undefined ? {} : { operationId }),
  };
}

const available = await pgAvailable();

describe.skipIf(!available)('outbox per-aggregate order against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let table: string;
  let current: ReturnType<typeof gatedPublisher> | undefined;
  let runtime: OutboxRuntime;
  let failing: OutboxRuntime;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'outbox-order',
      extraSql: [outboxSql('outbox_order'), `ALTER TABLE outbox_order.outbox ALTER COLUMN seq RESTART WITH ${FIRST_SEQ};`],
    });
    table = `${handle.schema}.outbox`;
  });

  afterAll(async () => {
    resetOutboxRuntimes();
    await handle?.drop();
  });

  // A failed test must not leave a flush waiting on a closed gate.
  afterEach(() => {
    current?.openAll();
  });

  /** A fresh gated publisher behind `runtime`, and `failing` beside it. */
  function setUp(): ReturnType<typeof gatedPublisher> {
    const live = gatedPublisher();
    current = live;
    const logger = createLogger({ service: 'stub', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    runtime = createOutbox({ service: 'stub', db: handle.app, publisher: live.publisher, logger, clock: systemClock });
    failing = { ...runtime, publisher: unavailable };
    return live;
  }

  /** Writes `inputs` in one tenant transaction through `rt`; resolves `written` before COMMIT and `done` after its flush. */
  async function request(tenantId: string, inputs: readonly OutboxWriteInput[], rt: OutboxRuntime = runtime) {
    const written = deferred<EventEnvelope[]>();
    const done = handle.app.withTenant(tenantId, async (tx) => {
      const envelopes: EventEnvelope[] = [];
      for (const input of inputs) envelopes.push((await writeOutbox(tx, input, rt)) as EventEnvelope);
      written.resolve(envelopes);
      return envelopes;
    });
    done.catch((err: unknown) => written.reject(err));
    return { envelopes: await within(written.promise, 'the outbox write'), done };
  }

  /** Writes `inputs` and waits for the transaction and its flush. */
  async function write(tenantId: string, inputs: readonly OutboxWriteInput[], rt: OutboxRuntime = runtime): Promise<EventEnvelope[]> {
    const { done } = await request(tenantId, inputs, rt);
    return within(done, 'the write and its flush');
  }

  function ids(envelopes: readonly (EventEnvelope | undefined)[]): string[] {
    return envelopes.map((envelope) => (envelope as EventEnvelope).eventId);
  }

  /** Event ids of `tenantId`'s published rows. */
  async function publishedIds(tenantId: string): Promise<string[]> {
    return handle.app.withTenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ event_id: string }>(`SELECT event_id FROM ${table} WHERE published_at IS NOT NULL ORDER BY seq`);
      return rows.map((row) => row.event_id);
    });
  }

  /** Backends of the app role waiting for a lock. */
  async function lockWaiters(): Promise<number> {
    const { rows } = await handle.adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1 AND wait_event_type = 'Lock'",
      [handle.roles.app],
    );
    return rows[0]?.n ?? 0;
  }

  function sweep(tenantId: string, batchSize: number): Promise<SweepResult> {
    return sweepOutbox(runtime, { service: 'stub', clock: systemClock, tenantsOf: () => Promise.resolve([tenantId]), batchSize });
  }

  it('starts seq beyond 2^53', async () => {
    setUp();
    const tenant = tenantIdForSite('ordering-seq');
    const [envelope] = await write(tenant, [note('note-seq')]);
    const seq = await handle.app.withTenant(tenant, async (tx) => {
      const { rows } = await tx.query<{ seq: string }>(`SELECT seq::text AS seq FROM ${table} WHERE event_id = $1`, [envelope?.eventId]);
      return rows[0]?.seq;
    });
    expect(BigInt(seq as string) >= BigInt(FIRST_SEQ)).toBe(true);
  });

  it('publishes two concurrent flushes of one aggregate in seq order, each stamping its row before its request answers', async () => {
    const live = setUp();
    const tenant = tenantIdForSite('ordering-flushes');
    const first = await request(tenant, [note('note-k')]);
    const firstId = ids(first.envelopes)[0] as string;
    const gate = live.gate(firstId);
    await within(gate.reached, 'the first flush to publish');

    const second = await request(tenant, [note('note-k')]);
    const secondId = ids(second.envelopes)[0] as string;
    const secondDone = settledFlag(second.done);
    await until(async () => (await lockWaiters()) >= 1, 'the second flush to wait for the first row');
    expect(live.order).toEqual([firstId]);
    expect(secondDone()).toBe(false);

    gate.open();
    await within(first.done, 'the first request');
    expect(await publishedIds(tenant)).toContain(firstId);
    await within(second.done, 'the second request');
    expect(await publishedIds(tenant)).toEqual([firstId, secondId]);
    expect(live.order).toEqual([firstId, secondId]);
  });

  it('keeps seq order when an in-request flush waits behind a sweep publishing the same aggregate', async () => {
    const live = setUp();
    const tenant = tenantIdForSite('ordering-sweep-first');
    const backlog = [...(await write(tenant, [note('note-k')], failing)), ...(await write(tenant, [note('note-k')], failing))];
    const gate = live.gate(ids(backlog)[0] as string);
    const swept = sweep(tenant, 10);
    await within(gate.reached, 'the sweep to publish the first backlog row');

    const late = await request(tenant, [note('note-k')]);
    await until(async () => (await lockWaiters()) >= 1, 'the flush to wait for the sweep');
    expect(live.order).toEqual(ids(backlog).slice(0, 1));

    gate.open();
    await expect(within(swept, 'the sweep')).resolves.toEqual({ published: 2, failed: 0, skipped: 0, tenants: 1, hooks: [] });
    await within(late.done, 'the late request');
    expect(live.order).toEqual(ids([...backlog, ...late.envelopes]));
    expect(await publishedIds(tenant)).toEqual(ids([...backlog, ...late.envelopes]));
  });

  it('never lets a sweep publish a later row while a flush publishes an earlier row of its aggregate', async () => {
    const live = setUp();
    const tenant = tenantIdForSite('ordering-flush-first');
    const first = await request(tenant, [note('note-k')]);
    const gate = live.gate(ids(first.envelopes)[0] as string);
    await within(gate.reached, 'the flush to publish the first row');
    // Its own flush, with a publisher that cannot reach Pub/Sub, waits for the first row before failing.
    const later = await request(tenant, [note('note-k')], failing);
    await until(async () => (await lockWaiters()) >= 1, 'the later flush to wait for the first row');

    await expect(within(sweep(tenant, 10), 'a sweep during the flush')).resolves.toEqual({
      published: 0,
      failed: 0,
      skipped: 1,
      tenants: 1,
      hooks: [],
    });
    expect(live.order).toEqual(ids(first.envelopes));

    gate.open();
    await within(first.done, 'the first request');
    await within(later.done, 'the later request');
    await expect(within(sweep(tenant, 10), 'a sweep after the flush')).resolves.toMatchObject({ published: 1, skipped: 0 });
    expect(live.order).toEqual(ids([...first.envelopes, ...later.envelopes]));
  });

  it('holds a later row behind an earlier held row of its aggregate until releaseOperation, publishing other aggregates', async () => {
    const live = setUp();
    const tenant = tenantIdForSite('ordering-held');
    const held = await write(tenant, [note('note-k', 'op-held')]);
    const [later, other] = await write(tenant, [note('note-k'), note('note-l')]);
    expect(live.order).toEqual(ids([other]));

    await expect(within(sweep(tenant, 10), 'a sweep while the operation is open')).resolves.toMatchObject({ published: 0, skipped: 1 });
    expect(await publishedIds(tenant)).toEqual(ids([other]));

    await within(
      handle.app.withTenant(tenant, (tx) => releaseOperation(tx, 'op-held', runtime)),
      'the release and its flush',
    );
    expect(live.order).toEqual(ids([other, ...held]));
    await expect(within(sweep(tenant, 10), 'a sweep after the release')).resolves.toMatchObject({ published: 1, skipped: 0 });
    expect(live.order).toEqual(ids([other, ...held, later]));
    expect(await publishedIds(tenant)).toEqual(ids([...held, later, other]));
  });

  it.each([1, 2])('sweeps past blocked rows in batches of %i and still publishes later aggregates', async (batchSize) => {
    const live = setUp();
    const tenant = tenantIdForSite(`ordering-paging-${batchSize}`);
    await write(tenant, [note('note-k', `op-paging-${batchSize}`)]);
    // Rows whose own flushes could not publish: two behind the held row, then two of other aggregates.
    await write(tenant, [note('note-k')], failing);
    await write(tenant, [note('note-k')], failing);
    const others = [...(await write(tenant, [note('note-m')], failing)), ...(await write(tenant, [note('note-n')], failing))];

    await expect(within(sweep(tenant, batchSize), 'the sweep')).resolves.toEqual({
      published: 2,
      failed: 0,
      skipped: 2,
      tenants: 1,
      hooks: [],
    });
    expect(live.order).toEqual(ids(others));
    expect(await publishedIds(tenant)).toEqual(ids(others));
  });

  it('waits for a row another transaction holds and replays every row of the range', async () => {
    setUp();
    const tenant = tenantIdForSite('ordering-replay-wait');
    const since = new Date(Date.now() - 60_000);
    const written: EventEnvelope[] = [];
    for (const key of ['note-a', 'note-b', 'note-a', 'note-c', 'note-b']) written.push(...(await write(tenant, [note(key)])));
    const replayed = gatedPublisher();

    const holder = await handle.appPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await holder.query(`SELECT seq FROM ${table} WHERE event_id = $1 FOR UPDATE`, [written[2]?.eventId]);

      const replay = runReplay({ runtime: { ...runtime, publisher: replayed.publisher }, since, tenant, batchSize: 2 });
      const replayDone = settledFlag(replay);
      await until(async () => (await lockWaiters()) >= 1, 'the replay to wait for the held row');
      expect(replayed.order).toEqual(ids(written.slice(0, 2)));
      expect(replayDone()).toBe(false);

      await holder.query('COMMIT');
      await expect(within(replay, 'the replay')).resolves.toEqual({ replayed: written.length, failed: 0, skipped: 0, tenants: 1 });
      expect(replayed.order).toEqual(ids(written));
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('stops replay at the last row of the range at its start while new rows arrive', async () => {
    const live = setUp();
    const tenant = tenantIdForSite('ordering-replay-bound');
    const since = new Date(Date.now() - 60_000);
    const written = [
      ...(await write(tenant, [note('note-a')])),
      ...(await write(tenant, [note('note-b')])),
      ...(await write(tenant, [note('note-c')])),
    ];
    const replayed = gatedPublisher();
    const gate = replayed.gate(ids(written)[1] as string);

    try {
      const replay = runReplay({ runtime: { ...runtime, publisher: replayed.publisher }, since, tenant, batchSize: 1 });
      await within(gate.reached, 'the replay to reach the second row');
      const arrived = [...(await write(tenant, [note('note-d')])), ...(await write(tenant, [note('note-e')]))];
      gate.open();

      await expect(within(replay, 'the replay')).resolves.toEqual({ replayed: written.length, failed: 0, skipped: 0, tenants: 1 });
      expect(replayed.order).toEqual(ids(written));
      expect(live.order).toEqual(ids([...written, ...arrived]));
    } finally {
      replayed.openAll();
    }
  });

  it('stops replay of a held aggregate in its own tenant only, republishing that aggregate in the next tenant', async () => {
    setUp();
    const tenantA = tenantIdForSite('ordering-replay-held-a');
    const tenantB = tenantIdForSite('ordering-replay-open-b');
    const since = new Date(Date.now() - 60_000);
    await write(tenantA, [note('note-k', 'op-replay-held')]);
    await write(tenantA, [note('note-k')]);
    const open = await write(tenantB, [note('note-k')]);
    const replayed = gatedPublisher();

    const replay = runReplay({ runtime: { ...runtime, publisher: replayed.publisher }, since, tenantsOf: () => Promise.resolve([tenantA, tenantB]) });

    await expect(within(replay, 'the replay')).resolves.toEqual({ replayed: 1, failed: 0, skipped: 1, tenants: 2 });
    expect(replayed.order).toEqual(ids(open));
    expect(await publishedIds(tenantA)).toEqual([]);
    expect(await publishedIds(tenantB)).toEqual(ids(open));
  });
});
