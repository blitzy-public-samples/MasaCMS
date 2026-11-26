import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OUTBOX_SWEEP_INTERVAL_S,
  SCHEDULED_TASK_QUEUE_TABLE,
  createLocalTaskAdapter,
  ensureRecurring,
  outboxSweepQueue,
  recurringSpec,
  scheduledTaskQueueSql,
  type LocalTaskPort,
  type TaskLogger,
} from '../../src/tasks/index.js';
import { SYSTEM_TENANT_ID, tenantRegistrySql, withTenant } from '../../src/tenancy/index.js';
import { businessClock, createThrowawaySchema, pgAvailable, seedRegistry, writeTestSecrets, type ThrowawaySchema } from '../../src/testing/index.js';

const SERVICE = 'stub';
const QUEUE = outboxSweepQueue(SERVICE);
const SERVICE_URLS = { stub: 'http://127.0.0.1:8199' } as const;
// Mid-slot, so the task is named for its slot's start, not for now.
const CLOCK = businessClock('12:07:30');
const silentLogger: TaskLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const available = await pgAvailable();

describe.skipIf(!available)('outbox sweep chain on the local task adapter', () => {
  let handle: ThrowawaySchema;
  let stateDir: string;
  let port: LocalTaskPort;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: SERVICE, extraSql: [tenantRegistrySql(SERVICE), scheduledTaskQueueSql(SERVICE)] });
    await seedRegistry(handle.app);
    stateDir = await mkdtemp(join(tmpdir(), 'opt2-sweep-chain-'));
    await writeTestSecrets(stateDir);
    port = await createLocalTaskAdapter({
      db: handle.app,
      stateDir,
      serviceUrls: { ...SERVICE_URLS },
      clock: CLOCK,
      logger: silentLogger,
      autoStart: false,
    });
  });

  afterAll(async () => {
    await port?.close();
    await handle?.drop();
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  /** Deletes the stored row of `name` outright, leaving no tombstone; resolves to the rows deleted. */
  async function loseTask(name: string): Promise<number> {
    return withTenant(handle.app, SYSTEM_TENANT_ID, async (tx) => {
      const { rowCount } = await tx.query(
        `DELETE FROM ${handle.schema}.${SCHEDULED_TASK_QUEUE_TABLE} WHERE tenant_id = $1 AND queue = $2 AND name = $3`,
        [tx.tenantId, QUEUE, name],
      );
      return rowCount ?? 0;
    });
  }

  it('re-creates the current slot task of a chain whose last task is lost, then leaves it alone while live [events:sweepChainRecreated]', async () => {
    const opts = { ...recurringSpec(QUEUE, SERVICE_URLS), clock: CLOCK };
    const slotS = Math.floor(CLOCK.now().getTime() / 1000 / OUTBOX_SWEEP_INTERVAL_S) * OUTBOX_SWEEP_INTERVAL_S;
    const name = `stub-outbox-sweep-${String(slotS)}`;
    const created = { queue: QUEUE, name, created: true, reason: 'created-current' };

    expect(await ensureRecurring(port, opts)).toEqual(created);
    expect(await loseTask(name)).toBe(1);
    expect((await port.list(QUEUE)).tasks).toEqual([]);

    expect(await ensureRecurring(port, opts)).toEqual(created);
    expect(await port.get(QUEUE, name)).toEqual({ queue: QUEUE, name, scheduleTime: new Date(slotS * 1000), status: 'pending', attempts: 0 });

    expect(await ensureRecurring(port, opts)).toEqual({ ...created, created: false, reason: 'live' });
    expect((await port.list(QUEUE)).tasks.map((task) => task.name)).toEqual([name]);
  });
});
