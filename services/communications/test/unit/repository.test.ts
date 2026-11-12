// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications repository helpers against a throwaway `communications` schema: fixture row writes, one changelog row per write, gates and write positions. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  ensureUnitGates,
  requestMigrationAuthority,
  withGatedTenant,
} from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  OWNER,
  SCHEMA,
  createCommunicationsRepository,
  type CommunicationsRepository,
  type NewAdoptedScheduledTask,
  type NewMessage,
  type NewScheduledTask,
  type NewTemplate,
} from '../../src/repo/repository.js';
import { OWNED_TABLES, UNITS, type MessageRow, type ScheduledTaskRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const EVENT_ID = '0b9c7a52-3f2e-4c1d-9a8b-1c2d3e4f5a6b';
const TEMPLATE: NewTemplate = { siteId: 'tenant-a', name: 'Welcome', subject: 'Hello', bodyText: 'Text', bodyHtml: '<p>Html</p>' };
const MESSAGE: NewMessage = {
  siteId: 'tenant-a',
  toAddress: 'to@example.com',
  fromAddress: 'noreply@opt2.local',
  subject: 'Hello',
  bodyText: 'Text',
  bodyHtml: '',
  source: 'send',
};

interface LoggedChange {
  table: string;
  op: string;
  origin: string;
  actor_user_id: string | null;
  request_id: string | null;
  xid: string;
}

function launchTask(over: Partial<NewScheduledTask> = {}): NewScheduledTask {
  return {
    taskName: 'opt2-survey-S1-launch',
    queue: 'surveys-launch',
    queueTaskName: 'opt2-survey-S1-launch-v1',
    kind: 'survey-launch',
    sourceType: 'survey',
    sourceId: '11111111-2222-3333-4444555566667777',
    scheduleTime: new Date(2026, 6, 1, 9, 0, 0),
    targetRoute: '/internal/v1/tasks/surveys/S1/launch',
    scheduleVersion: 1,
    origin: 'event',
    ...over,
  };
}

function adoptedTask(over: Partial<NewAdoptedScheduledTask> = {}): NewAdoptedScheduledTask {
  const { origin: _origin, ...task } = launchTask(over);
  return task;
}

/** Runs `run` with the process time zone set to `tz`, then restores the previous one. */
async function inTimeZone<T>(tz: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('communications repository identity', () => {
  it('extends the platform repository of the owned tables and exposes it as base', () => {
    const repository = createCommunicationsRepository({ clock: fixedClock(NOW) });

    expect([OWNER, SCHEMA]).toEqual(['communications', 'communications']);
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'communications', schema: 'communications' });
    expect(repository.base).toMatchObject({ owner: 'communications', schema: 'communications' });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table))).toEqual([...OWNED_TABLES]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('communications repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: CommunicationsRepository;
  let tenants = 0;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createCommunicationsRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    tenants += 1;
    tenantId = tenantIdForSite(`communications-repository-${tenants}`);
  });

  async function setGates(state: 'open' | 'legacy' | 'closed'): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = 'quiet'`, [
        state,
        state === 'closed' ? 'test-holder' : null,
      ]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenantId, fn);
  }

  function changelog(): Promise<LoggedChange[]> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<LoggedChange>(
        `SELECT "table", op, origin, actor_user_id, request_id, xid::text AS xid FROM ${handle.schema}.changelog ORDER BY seq`,
      );
      return rows;
    });
  }

  function ops(changes: LoggedChange[]): string[] {
    return changes.map((change) => `${change.op} ${change.table}`);
  }

  function newMessage(extra: Partial<NewMessage> = {}): Promise<MessageRow> {
    return inTenant((tx) => repository.insertMessage(tx, { ...MESSAGE, ...extra }));
  }

  it('inserts a template created now with lastupdate equal to created, logging the caller context', async () => {
    const template = await inTenant((tx) => repository.insertTemplate(tx, TEMPLATE, { actorUserId: 'U1', requestId: 'req-1' }));

    expect(template).toMatchObject({
      tenant_id: tenantId,
      siteid: 'tenant-a',
      name: 'Welcome',
      subject: 'Hello',
      body_text: 'Text',
      body_html: '<p>Html</p>',
    });
    expect(template.template_id).toMatch(CF_UUID);
    expect(template.created.getTime()).toBe(NOW.getTime());
    expect(template.lastupdate?.getTime()).toBe(NOW.getTime());
    expect(await changelog()).toMatchObject([
      { table: 'message_template', op: 'insert', origin: 'target', actor_user_id: 'U1', request_id: 'req-1' },
    ]);
  });

  it('inserts a queued send message at row_version 1, or a login-mail message with its own id and event', async () => {
    const sent = await newMessage();
    const loginMail = await newMessage({ messageId: 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000', source: 'login-mail', eventId: EVENT_ID });

    expect(sent).toMatchObject({ state: 'queued', template_id: null, event_id: null, sent_at: null, source: 'send', row_version: '1' });
    expect(sent.message_id).toMatch(CF_UUID);
    expect(sent.created.getTime()).toBe(NOW.getTime());
    expect(loginMail).toMatchObject({ message_id: 'AAAAAAAA-BBBB-CCCC-DDDDEEEEFFFF0000', source: 'login-mail', event_id: EVENT_ID });
    expect(ops(await changelog())).toEqual(['insert message', 'insert message']);
  });

  it('increments row_version by one per state change and sets sent_at only for sent', async () => {
    const message = await newMessage();
    const at = new Date(NOW.getTime() + 10);

    const sent = await inTenant((tx) => repository.setMessageState(tx, { messageId: message.message_id, state: 'sent', at }));
    const delivered = await inTenant((tx) => repository.setMessageState(tx, { messageId: message.message_id, state: 'delivered' }));
    const resent = await inTenant((tx) => repository.setMessageState(tx, { messageId: message.message_id, state: 'sent' }));

    expect(sent).toMatchObject({ state: 'sent', row_version: '2' });
    expect(sent?.sent_at?.getTime()).toBe(at.getTime());
    expect(delivered).toMatchObject({ state: 'delivered', row_version: '3' });
    expect(delivered?.sent_at?.getTime()).toBe(at.getTime());
    expect(resent?.sent_at?.getTime()).toBe(NOW.getTime());
    expect(await inTenant((tx) => repository.setMessageState(tx, { messageId: MISSING_ID, state: 'sent' }))).toBeNull();
    expect(ops(await changelog())).toEqual(['insert message', 'update message', 'update message', 'update message']);
  });

  it('gives concurrent state changes distinct row versions', async () => {
    const message = await newMessage();

    const changed = await Promise.all(
      [1, 2, 3].map(() => inTenant((tx) => repository.setMessageState(tx, { messageId: message.message_id, state: 'sent' }))),
    );

    expect(changed.map((row) => row?.row_version).sort()).toEqual(['2', '3', '4']);
  });

  it('appends statuses at least 10 ms apart per message and stores an empty detail or mailpit id as NULL', async () => {
    const message = await newMessage();
    const other = await newMessage();

    const history = await inTenant(async (tx) => [
      await repository.appendDeliveryStatus(tx, { messageId: message.message_id, state: 'queued', source: 'send', detail: '', mailpitId: '' }),
      await repository.appendDeliveryStatus(tx, { messageId: message.message_id, state: 'sent', source: 'send' }),
      await repository.appendDeliveryStatus(tx, { messageId: message.message_id, state: 'delivered', source: 'send', mailpitId: 'MP1' }),
    ]);
    const failed = await inTenant((tx) =>
      repository.appendDeliveryStatus(tx, { messageId: other.message_id, state: 'failed', source: 'login-mail', detail: 'smtp-error' }),
    );

    expect(history.map((row) => [row.status, row.recorded_at.getTime() - NOW.getTime(), row.mailpit_id, row.detail])).toEqual([
      ['queued', 0, null, null],
      ['sent', 10, null, null],
      ['delivered', 20, 'MP1', null],
    ]);
    expect(history[0]?.status_id).toMatch(CF_UUID);
    expect(failed).toMatchObject({ status: 'failed', source: 'login-mail', detail: 'smtp-error' });
    expect(failed.recorded_at.getTime()).toBe(NOW.getTime());
  });

  it('inserts scheduled tasks as scheduled, then sets their status and stamps', async () => {
    const [launch, reminder] = await inTenant((tx) =>
      repository.insertScheduledTasks(tx, [
        launchTask(),
        launchTask({
          taskName: 'opt2-survey-S1-reminder-1',
          queue: 'communications-reminders',
          queueTaskName: 'opt2-survey-S1-reminder-1-v1',
          kind: 'survey-reminder',
          n: 1,
          origin: 'adopted',
        }),
      ]),
    );
    const taskId = launch?.scheduled_task_id ?? '';

    expect(launch).toMatchObject({ status: 'scheduled', reminder_n: null, enqueued_at: null, dequeued_at: null, origin: 'event' });
    expect(launch?.created_at.getTime()).toBe(NOW.getTime());
    expect(taskId).toMatch(CF_UUID);
    expect(reminder).toMatchObject({ kind: 'survey-reminder', queue: 'communications-reminders', reminder_n: 1, origin: 'adopted' });
    expect((await inTenant((tx) => repository.stampEnqueued(tx, taskId)))?.enqueued_at?.getTime()).toBe(NOW.getTime());
    expect(await inTenant((tx) => repository.setScheduledTaskStatus(tx, taskId, 'superseded'))).toMatchObject({ status: 'superseded' });
    expect((await inTenant((tx) => repository.stampDequeued(tx, taskId)))?.dequeued_at?.getTime()).toBe(NOW.getTime());
    expect(ops(await changelog())).toEqual([
      'insert scheduled_task',
      'insert scheduled_task',
      'update scheduled_task',
      'update scheduled_task',
      'update scheduled_task',
    ]);
  });

  it.each([
    ['setScheduledTaskStatus', (tx: TenantTx) => repository.setScheduledTaskStatus(tx, MISSING_ID, 'done')],
    ['stampEnqueued', (tx: TenantTx) => repository.stampEnqueued(tx, MISSING_ID)],
    ['stampDequeued', (tx: TenantTx) => repository.stampDequeued(tx, MISSING_ID)],
  ])('%s answers null for an absent task', async (_name, write) => {
    expect(await inTenant(write)).toBeNull();
    expect(await changelog()).toEqual([]);
  });

  it('rolls the row and its changelog row back together', async () => {
    await expect(
      inTenant(async (tx) => {
        await repository.insertTemplate(tx, TEMPLATE);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const templates = await inTenant(async (tx) => (await tx.query(`SELECT 1 FROM ${handle.schema}.message_template`)).rows);
    expect(templates).toEqual([]);
    expect(await changelog()).toEqual([]);
  });

  it('rejects writes to legacy units, scheduled tasks included', async () => {
    const [task] = await inTenant((tx) => repository.insertScheduledTasks(tx, [launchTask()]));
    const taskId = task?.scheduled_task_id ?? '';
    await setGates('legacy');

    await expect(newMessage()).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(inTenant((tx) => repository.insertTemplate(tx, TEMPLATE))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(inTenant((tx) => repository.insertScheduledTasks(tx, [launchTask()]))).rejects.toBeInstanceOf(
      UnitNotAuthoritativeError,
    );
    await expect(inTenant((tx) => repository.setScheduledTaskStatus(tx, taskId, 'cancelled'))).rejects.toBeInstanceOf(
      UnitNotAuthoritativeError,
    );
    await expect(inTenant((tx) => repository.stampEnqueued(tx, taskId))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    await expect(inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]))).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
  });

  it.each(['closed', 'legacy'] as const)('lets scheduled-task writes of a platform.migration request pass a %s gate', async (state) => {
    await setGates(state);
    const service = { name: 'migration', roles: ['platform.migration'] };
    const store = { ...newRequestContext({ requestId: `req-adopt-${state}` }), service };

    const cancelled = await runWithRequestContext(store, () =>
      inTenant(async (tx) => {
        const ctx = { authority: requestMigrationAuthority() };
        const [adopted] = await repository.insertScheduledTasks(tx, [launchTask({ origin: 'adopted' })], ctx);
        return repository.setScheduledTaskStatus(tx, adopted?.scheduled_task_id ?? '', 'cancelled', ctx);
      }),
    );

    expect(cancelled).toMatchObject({ origin: 'adopted', status: 'cancelled' });
    expect((await changelog()).map((change) => [change.op, change.table, change.request_id])).toEqual([
      ['insert', 'scheduled_task', `req-adopt-${state}`],
      ['update', 'scheduled_task', `req-adopt-${state}`],
    ]);
  });

  function adoptedRows(tenant = tenantId): Promise<Pick<ScheduledTaskRow, 'scheduled_task_id' | 'task_name' | 'status'>[]> {
    return handle.app.withTenant(tenant, async (tx) => {
      const { rows } = await tx.query<Pick<ScheduledTaskRow, 'scheduled_task_id' | 'task_name' | 'status'>>(
        `SELECT scheduled_task_id, task_name, status FROM ${handle.schema}.scheduled_task WHERE origin = 'adopted' ORDER BY task_name`,
      );
      return rows;
    });
  }

  it('adopts a task name once: a repeat, in a later call or the same one, returns the stored row unchanged', async () => {
    const [first] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]));
    const again = await inTenant((tx) =>
      repository.adoptScheduledTasks(tx, [adoptedTask({ queueTaskName: 'opt2-survey-S1-launch-v2', scheduleVersion: 2 }), adoptedTask()]),
    );

    expect(first).toMatchObject({ created: true, row: { origin: 'adopted', status: 'scheduled', queue_task_name: 'opt2-survey-S1-launch-v1' } });
    expect(first?.row.scheduled_task_id).toMatch(CF_UUID);
    expect(again).toEqual([
      { created: false, row: first?.row },
      { created: false, row: first?.row },
    ]);
    expect(await adoptedRows()).toHaveLength(1);
    expect(ops(await changelog())).toEqual(['insert scheduled_task']);
  });

  it('gives the second occurrence of a name within one call the row the first created', async () => {
    const [first, second] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask(), adoptedTask()]));

    expect([first?.created, second?.created]).toEqual([true, false]);
    expect(second?.row).toEqual(first?.row);
    expect(ops(await changelog())).toEqual(['insert scheduled_task']);
  });

  it('creates one row when two tenant transactions adopt the same task concurrently', async () => {
    const adopt = (): Promise<{ created: boolean; id: string }> =>
      inTenant(async (tx) => {
        const [adopted] = await repository.adoptScheduledTasks(tx, [adoptedTask()]);
        // Holding the name lock past the other transaction's start makes it wait for this commit.
        await tx.query('SELECT pg_sleep(0.2)');
        return { created: adopted?.created ?? false, id: adopted?.row.scheduled_task_id ?? '' };
      });

    const results = await Promise.all([adopt(), adopt()]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await adoptedRows()).toHaveLength(1);
    expect(ops(await changelog())).toEqual(['insert scheduled_task']);
  });

  it('reactivates a cancelled adoption in place with the new schedule and cleared stamps', async () => {
    const [adopted] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]));
    const taskId = adopted?.row.scheduled_task_id ?? '';
    await inTenant(async (tx) => {
      await repository.stampEnqueued(tx, taskId);
      await repository.setScheduledTaskStatus(tx, taskId, 'cancelled');
      await repository.stampDequeued(tx, taskId);
    });
    const next = {
      queueTaskName: 'opt2-survey-S1-launch-v2',
      scheduleTime: new Date(2026, 6, 2, 9, 0, 0),
      targetRoute: '/internal/v1/tasks/surveys/S1/launch?v=2',
      scheduleVersion: 2,
    };

    const [reactivated] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask(next)]));

    expect(reactivated).toMatchObject({
      created: true,
      row: {
        scheduled_task_id: taskId,
        origin: 'adopted',
        status: 'scheduled',
        queue_task_name: next.queueTaskName,
        target_route: next.targetRoute,
        schedule_version: 2,
        enqueued_at: null,
        dequeued_at: null,
      },
    });
    expect(reactivated?.row.schedule_time.getTime()).toBe(next.scheduleTime.getTime());
    expect(await adoptedRows()).toEqual([{ scheduled_task_id: taskId, task_name: 'opt2-survey-S1-launch', status: 'scheduled' }]);
    expect(ops(await changelog())).toEqual([
      'insert scheduled_task',
      'update scheduled_task',
      'update scheduled_task',
      'update scheduled_task',
      'update scheduled_task',
    ]);
  });

  it('returns the written instant of a local time repeated by daylight saving, on insert and on reactivation', async () => {
    const scheduleTime = new Date('2026-11-01T06:30:00.000Z');
    const [inserted, reactivated, walls] = await inTimeZone('America/New_York', async () => {
      const [event] = await inTenant((tx) => repository.insertScheduledTasks(tx, [launchTask({ scheduleTime })]));
      const [adopted] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask({ queueTaskName: 'opt2-survey-S1-launch-v2' })]));
      const adoptedId = adopted?.row.scheduled_task_id ?? '';
      await inTenant((tx) => repository.setScheduledTaskStatus(tx, adoptedId, 'cancelled'));
      const [again] = await inTenant((tx) =>
        repository.adoptScheduledTasks(tx, [adoptedTask({ queueTaskName: 'opt2-survey-S1-launch-v3', scheduleTime })]),
      );
      const stored = await inTenant(async (tx) => {
        const { rows } = await tx.query<{ wall: string }>(
          `SELECT schedule_time::text AS wall FROM ${handle.schema}.scheduled_task ORDER BY queue_task_name`,
        );
        return rows.map((row) => row.wall);
      });
      return [event, again?.row, stored] as const;
    });

    expect(inserted?.schedule_time.toISOString()).toBe(scheduleTime.toISOString());
    expect(reactivated?.schedule_time.toISOString()).toBe(scheduleTime.toISOString());
    expect(walls).toEqual(['2026-11-01 01:30:00', '2026-11-01 01:30:00']);
  });

  it('resolves a function target route with the row id, on insert and on reactivation', async () => {
    const route = (scheduledTaskId: string): string => `/internal/v1/tasks/reminders/${scheduledTaskId}`;
    const [inserted] = await inTenant((tx) =>
      repository.insertScheduledTasks(tx, [launchTask({ queueTaskName: 'opt2-survey-S1-launch-v9', targetRoute: route })]),
    );
    const [adopted] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]));
    const adoptedId = adopted?.row.scheduled_task_id ?? '';
    await inTenant((tx) => repository.setScheduledTaskStatus(tx, adoptedId, 'cancelled'));

    const [reactivated] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask({ targetRoute: route })]));

    expect(inserted?.target_route).toBe(route(inserted?.scheduled_task_id ?? ''));
    expect(reactivated?.row).toMatchObject({ scheduled_task_id: adoptedId, target_route: route(adoptedId) });
  });


  it.each(['done', 'superseded'] as const)('returns a %s adoption unchanged', async (status) => {
    const [adopted] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]));
    const stored = await inTenant((tx) => repository.setScheduledTaskStatus(tx, adopted?.row.scheduled_task_id ?? '', status));

    const [again] = await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask({ scheduleVersion: 2 })]));

    expect(again).toEqual({ created: false, row: stored });
    expect(ops(await changelog())).toEqual(['insert scheduled_task', 'update scheduled_task']);
  });

  it('adopts the same task name independently per tenant', async () => {
    const otherTenant = tenantIdForSite(`communications-repository-${tenants}-other`);

    const [mine, theirs] = await Promise.all([
      inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()])),
      handle.app.withTenant(otherTenant, (tx) => repository.adoptScheduledTasks(tx, [adoptedTask()])),
    ]);

    expect([mine[0]?.created, theirs[0]?.created]).toEqual([true, true]);
    expect(mine[0]?.row.scheduled_task_id).not.toBe(theirs[0]?.row.scheduled_task_id);
    expect(await adoptedRows()).toHaveLength(1);
    expect(await adoptedRows(otherTenant)).toHaveLength(1);
  });

  it('routes adopted tasks of insertScheduledTasks through adoption, so a repeat reuses the row', async () => {
    const [first] = await inTenant((tx) => repository.insertScheduledTasks(tx, [launchTask({ origin: 'adopted' })]));
    const [event, again] = await inTenant((tx) =>
      repository.insertScheduledTasks(tx, [
        launchTask({ queueTaskName: 'opt2-survey-S1-launch-event-v1' }),
        launchTask({ origin: 'adopted', queueTaskName: 'opt2-survey-S1-launch-v2' }),
      ]),
    );

    expect(again).toEqual(first);
    expect(event).toMatchObject({ origin: 'event', task_name: 'opt2-survey-S1-launch' });
    expect(await adoptedRows()).toHaveLength(1);
    expect(ops(await changelog())).toEqual(['insert scheduled_task', 'insert scheduled_task']);
  });

  it('rejects a second adopted row with the same task name in the schema itself', async () => {
    await inTenant((tx) => repository.adoptScheduledTasks(tx, [adoptedTask()]));

    await expect(
      inTenant((tx) =>
        tx.query(
          `INSERT INTO ${handle.schema}.scheduled_task (tenant_id, scheduled_task_id, task_name, queue, queue_task_name, kind, source_type,` +
            ' source_id, schedule_time, status, target_route, schedule_version, origin, created_at, updated_at)' +
            ` SELECT tenant_id, $1, task_name, queue, queue_task_name || '-copy', kind, source_type, source_id, schedule_time, status,` +
            ` target_route, schedule_version, origin, created_at, updated_at FROM ${handle.schema}.scheduled_task`,
          [MISSING_ID],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'scheduled_task_adopted_name_key' });
  });

  it.each<[string, (messageId: string) => (tx: TenantTx) => Promise<unknown>]>([
    ['insertTemplate', (_id: string) => (tx: TenantTx) => repository.insertTemplate(tx, TEMPLATE)],
    ['insertScheduledTasks', (_id: string) => (tx: TenantTx) => repository.insertScheduledTasks(tx, [launchTask()])],
    ['setMessageState', (id: string) => (tx: TenantTx) => repository.setMessageState(tx, { messageId: id, state: 'sent' })],
    ['appendDeliveryStatus', (id: string) => (tx: TenantTx) => repository.appendDeliveryStatus(tx, { messageId: id, state: 'sent', source: 'send' })],
  ])('%s waits on a closed gate, then fails with GateClosedError', async (_name, write) => {
    const message = await newMessage();
    await setGates('closed');
    const started = Date.now();

    await expect(withGatedTenant(handle.app, tenantId, write(message.message_id), { budgetMs: 300 })).rejects.toBeInstanceOf(GateClosedError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('records the communications write position of the commit inside a request', async () => {
    const store = newRequestContext({ requestId: 'req-position' });

    await runWithRequestContext(store, () => newMessage());

    const [logged] = await changelog();
    expect(store.writePositions.get('communications')).toBe(logged?.xid);
    expect(logged?.request_id).toBe('req-position');
  });
});
