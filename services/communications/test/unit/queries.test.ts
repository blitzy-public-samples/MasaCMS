// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Communications read helpers against a throwaway `communications` schema: fixture order and paging, current task versions, recovery reads, isolation and window gates. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { OutsideTenantTransactionError, tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  findMessage,
  findMessageByEventId,
  findScheduledTask,
  findScheduledTaskByName,
  findTemplate,
  getMessageDetail,
  listAdoptedScheduledTasks,
  listMessages,
  listScheduledTasksBySource,
  listTemplates,
  queuedLoginMailOlderThan,
  unstampedScheduledTasksOlderThan,
  type ListPage,
  type SiteListFilters,
} from '../../src/repo/queries.js';
import { UNITS, type ScheduledTaskRow } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const SURVEY_ID = '11111111-2222-3333-4444555566667777';
const OTHER_SURVEY_ID = '99999999-2222-3333-4444555566667777';
const EVENT_ID = '0b9c7a52-3f2e-4c1d-9a8b-1c2d3e4f5a6b';

/** Local time `minutes` after T0. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** CF-format id whose sort order follows `n`. */
function cfId(n: number): string {
  return `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
}

const available = await pgAvailable();

describe.skipIf(!available)('communications queries against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let tenants = 0;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    tenants += 1;
    tenantA = tenantIdForSite(`communications-queries-a-${tenants}`);
    tenantB = tenantIdForSite(`communications-queries-b-${tenants}`);
  });

  function inTenant<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  async function insert(tx: TenantTx, table: string, row: Record<string, unknown>): Promise<void> {
    const columns = ['tenant_id', ...Object.keys(row)];
    const values = [tx.tenantId, ...Object.values(row)];
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  }

  function insertTemplate(tx: TenantTx, templateId: string, siteid: string, created: Date): Promise<void> {
    return insert(tx, 'message_template', {
      template_id: templateId,
      siteid,
      name: 'Welcome',
      subject: 'Hello {{name}}',
      body_text: 'Text',
      body_html: '',
      created,
      lastupdate: created,
    });
  }

  function insertMessage(tx: TenantTx, messageId: string, siteid: string, created: Date, extra: Record<string, unknown> = {}): Promise<void> {
    return insert(tx, 'message', {
      message_id: messageId,
      siteid,
      to_address: 'to@example.com',
      from_address: 'noreply@opt2.local',
      subject: 'Hello',
      body_text: 'Text',
      body_html: '',
      state: 'queued',
      created,
      source: 'send',
      row_version: 1,
      ...extra,
    });
  }

  function insertStatus(tx: TenantTx, statusId: string, messageId: string, status: string, recordedAt: Date): Promise<void> {
    return insert(tx, 'delivery_status', { status_id: statusId, message_id: messageId, status, recorded_at: recordedAt, source: 'send' });
  }

  interface TaskSeed {
    id: number;
    kind?: 'survey-launch' | 'survey-reminder';
    n?: number | null;
    version?: number;
    status?: string;
    origin?: string;
    scheduleTime?: Date;
    sourceId?: string;
    createdAt?: Date;
    updatedAt?: Date;
    enqueuedAt?: Date | null;
    dequeuedAt?: Date | null;
  }

  function insertTask(tx: TenantTx, seed: TaskSeed): Promise<void> {
    const kind = seed.kind ?? 'survey-reminder';
    const sourceId = seed.sourceId ?? SURVEY_ID;
    const version = seed.version ?? 1;
    const name = kind === 'survey-launch' ? 'launch' : `reminder-${seed.n ?? 1}`;
    return insert(tx, 'scheduled_task', {
      scheduled_task_id: cfId(seed.id),
      task_name: `opt2-survey-${sourceId}-${name}`,
      queue: kind === 'survey-launch' ? 'surveys-launch' : 'communications-reminders',
      queue_task_name: `opt2-survey-${sourceId}-${name}-v${version}`,
      kind,
      source_type: 'survey',
      source_id: sourceId,
      reminder_n: kind === 'survey-launch' ? null : (seed.n ?? 1),
      schedule_time: seed.scheduleTime ?? at(60),
      status: seed.status ?? 'scheduled',
      target_route: `/internal/v1/tasks/reminders/${cfId(seed.id)}`,
      schedule_version: version,
      origin: seed.origin ?? 'event',
      enqueued_at: seed.enqueuedAt === undefined ? at(0) : seed.enqueuedAt,
      dequeued_at: seed.dequeuedAt ?? null,
      created_at: seed.createdAt ?? at(0),
      updated_at: seed.updatedAt ?? seed.createdAt ?? at(0),
    });
  }

  function ids(rows: readonly ScheduledTaskRow[]): string[] {
    return rows.map((row) => row.scheduled_task_id);
  }

  type SeedRow = (tx: TenantTx, id: string, siteid: string, created: Date) => Promise<void>;
  type ListRows = (tx: TenantTx, filters: SiteListFilters) => Promise<ListPage<Record<string, unknown>>>;

  describe.each<[string, SeedRow, ListRows, string]>([
    ['templates', insertTemplate, listTemplates, 'template_id'],
    ['messages', insertMessage, listMessages, 'message_id'],
  ])('the %s list', (_name, seed, list, idColumn) => {
    beforeEach(async () => {
      await inTenant(tenantA, async (tx) => {
        await seed(tx, cfId(3), 'tenant-a', at(1));
        await seed(tx, cfId(2), 'tenant-a', at(1));
        await seed(tx, cfId(1), 'TENANT-A ', at(2));
        await seed(tx, cfId(4), 'tenant-a', at(0));
        await seed(tx, cfId(5), 'other', at(0));
      });
    });

    it.each<[string, SiteListFilters, number[]]>([
      ['every row unpaged', { siteId: 'tenant-a' }, [4, 2, 3, 1]],
      ['the first page', { siteId: 'tenant-a', pageIndex: 1, itemsPerPage: 2 }, [4, 2]],
      ['a short last page, matching the site case-insensitively', { siteId: 'Tenant-A', pageIndex: 2, itemsPerPage: 3 }, [1]],
      ['no rows past the total', { siteId: 'tenant-a', pageIndex: 3, itemsPerPage: 2 }, []],
    ])('reads %s by creation time and id with the site total', async (_case, filters, expected) => {
      const page = await inTenant(tenantA, (tx) => list(tx, filters));

      expect(page.total).toBe(4);
      expect(page.items.map((row) => row[idColumn])).toEqual(expected.map(cfId));
    });

    it('counts nothing for a site without rows', async () => {
      expect(await inTenant(tenantA, (tx) => list(tx, { siteId: 'nobody', pageIndex: 1, itemsPerPage: 50 }))).toEqual({ items: [], total: 0 });
    });
  });

  it('finds a template and a message by id, and null for an unknown id', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertTemplate(tx, cfId(1), 'tenant-a', at(0));
      await insertMessage(tx, cfId(2), 'tenant-a', at(0), { template_id: cfId(1) });
    });

    const [template, message, noTemplate, noMessage] = await inTenant(tenantA, async (tx) => [
      await findTemplate(tx, cfId(1)),
      await findMessage(tx, cfId(2)),
      await findTemplate(tx, cfId(9)),
      await findMessage(tx, cfId(9)),
    ]);

    expect(template).toMatchObject({ tenant_id: tenantA, template_id: cfId(1), subject: 'Hello {{name}}' });
    expect(message).toMatchObject({ tenant_id: tenantA, message_id: cfId(2), template_id: cfId(1), row_version: '1' });
    expect([noTemplate, noMessage]).toEqual([null, null]);
  });

  it('returns a message with its history by recorded time and status id, and null for an unknown message', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertMessage(tx, cfId(1), 'tenant-a', at(0), { state: 'delivered' });
      await insertMessage(tx, cfId(2), 'tenant-a', at(0));
      await insertStatus(tx, cfId(13), cfId(1), 'delivered', at(2));
      await insertStatus(tx, cfId(12), cfId(1), 'sent', at(1));
      await insertStatus(tx, cfId(11), cfId(1), 'queued', at(1));
      await insertStatus(tx, cfId(10), cfId(1), 'queued', at(0));
      await insertStatus(tx, cfId(14), cfId(2), 'queued', at(0));
    });

    const detail = await inTenant(tenantA, (tx) => getMessageDetail(tx, cfId(1)));

    expect(detail?.message).toMatchObject({ message_id: cfId(1), state: 'delivered' });
    expect(detail?.history.map((row) => row.status_id)).toEqual([10, 11, 12, 13].map(cfId));
    expect(detail?.history[0]).toMatchObject({ tenant_id: tenantA, message_id: cfId(1), detail: null, mailpit_id: null });
    expect(await inTenant(tenantA, (tx) => getMessageDetail(tx, cfId(9)))).toBeNull();
  });

  it('finds the message a login-mail event created', async () => {
    await inTenant(tenantA, (tx) => insertMessage(tx, cfId(1), 'tenant-a', at(0), { source: 'login-mail', event_id: EVENT_ID }));

    expect(await inTenant(tenantA, (tx) => findMessageByEventId(tx, EVENT_ID))).toMatchObject({ message_id: cfId(1), event_id: EVENT_ID });
    expect(await inTenant(tenantA, (tx) => findMessageByEventId(tx, '1b9c7a52-3f2e-4c1d-9a8b-1c2d3e4f5a6b'))).toBeNull();
  });

  it('lists only the current schedule version of a source by schedule time, kind and reminder ordinal', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertTask(tx, { id: 1, kind: 'survey-launch', version: 1, status: 'superseded', scheduleTime: at(30) });
      await insertTask(tx, { id: 2, n: 1, version: 1, status: 'superseded', scheduleTime: at(40) });
      await insertTask(tx, { id: 13, n: 2, version: 2, scheduleTime: at(80) });
      await insertTask(tx, { id: 12, n: 1, version: 2, status: 'done', scheduleTime: at(60) });
      await insertTask(tx, { id: 14, n: 3, version: 2, scheduleTime: at(80) });
      await insertTask(tx, { id: 11, kind: 'survey-launch', version: 2, status: 'done', scheduleTime: at(60) });
      await insertTask(tx, { id: 20, kind: 'survey-launch', sourceId: OTHER_SURVEY_ID, version: 3 });
    });

    const [current, unknown] = await inTenant(tenantA, async (tx) => [
      await listScheduledTasksBySource(tx, { sourceType: 'survey', sourceId: SURVEY_ID }),
      await listScheduledTasksBySource(tx, { sourceType: 'survey', sourceId: cfId(99) }),
    ]);

    expect(ids(current)).toEqual([11, 12, 13, 14].map(cfId));
    expect(current.every((row) => row.schedule_version === 2 && row.tenant_id === tenantA)).toBe(true);
    expect(unknown).toEqual([]);
  });

  it('finds a scheduled task by id and by queue task name', async () => {
    await inTenant(tenantA, (tx) => insertTask(tx, { id: 1, kind: 'survey-launch', version: 4 }));
    const queueTaskName = `opt2-survey-${SURVEY_ID}-launch-v4`;

    const [byId, byName, wrongQueue, unknown] = await inTenant(tenantA, async (tx) => [
      await findScheduledTask(tx, cfId(1)),
      await findScheduledTaskByName(tx, { queue: 'surveys-launch', queueTaskName }),
      await findScheduledTaskByName(tx, { queue: 'communications-reminders', queueTaskName }),
      await findScheduledTask(tx, cfId(9)),
    ]);

    expect(byId).toMatchObject({ scheduled_task_id: cfId(1), schedule_version: 4, reminder_n: null });
    expect(byName?.scheduled_task_id).toBe(cfId(1));
    expect([wrongQueue, unknown]).toEqual([null, null]);
  });

  it('lists adopted tasks still scheduled, optionally by fixture task name', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertTask(tx, { id: 3, n: 2, origin: 'adopted', createdAt: at(2) });
      await insertTask(tx, { id: 1, kind: 'survey-launch', origin: 'adopted', createdAt: at(1) });
      await insertTask(tx, { id: 2, n: 1, origin: 'adopted', status: 'cancelled', createdAt: at(1) });
      await insertTask(tx, { id: 4, n: 3, origin: 'event', createdAt: at(0) });
    });

    const [every, named, none] = await inTenant(tenantA, async (tx) => [
      await listAdoptedScheduledTasks(tx),
      await listAdoptedScheduledTasks(tx, [`opt2-survey-${SURVEY_ID}-reminder-2`, `opt2-survey-${SURVEY_ID}-reminder-1`]),
      await listAdoptedScheduledTasks(tx, []),
    ]);

    expect(ids(every)).toEqual([1, 3].map(cfId));
    expect(ids(named)).toEqual([cfId(3)]);
    expect(none).toEqual([]);
  });

  it('lists only stale queued login mail for recovery', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertMessage(tx, cfId(2), 'tenant-a', at(1), { source: 'login-mail' });
      await insertMessage(tx, cfId(1), 'tenant-a', at(1), { source: 'login-mail' });
      await insertMessage(tx, cfId(3), 'tenant-a', at(10), { source: 'login-mail' });
      await insertMessage(tx, cfId(4), 'tenant-a', at(0), { source: 'login-mail', state: 'sent' });
      await insertMessage(tx, cfId(5), 'tenant-a', at(0), { source: 'send' });
    });

    const stale = await inTenant(tenantA, (tx) => queuedLoginMailOlderThan(tx, at(10)));

    expect(stale.map((row) => row.message_id)).toEqual([1, 2].map(cfId));
  });

  it('lists tasks whose enqueue or dequeue stamp is overdue for recovery', async () => {
    await inTenant(tenantA, async (tx) => {
      await insertTask(tx, { id: 1, n: 1, enqueuedAt: null, createdAt: at(1) });
      await insertTask(tx, { id: 2, n: 2, enqueuedAt: null, createdAt: at(10) });
      await insertTask(tx, { id: 3, n: 3, createdAt: at(0) });
      await insertTask(tx, { id: 4, n: 4, status: 'superseded', createdAt: at(0), updatedAt: at(5) });
      await insertTask(tx, { id: 5, n: 5, status: 'cancelled', enqueuedAt: null, createdAt: at(2), updatedAt: at(2) });
      await insertTask(tx, { id: 6, n: 6, status: 'superseded', createdAt: at(0), updatedAt: at(10) });
      await insertTask(tx, { id: 7, n: 7, status: 'superseded', createdAt: at(0), updatedAt: at(5), dequeuedAt: at(5) });
      await insertTask(tx, { id: 8, n: 8, status: 'done', enqueuedAt: null, createdAt: at(0) });
    });

    const stale = await inTenant(tenantA, (tx) => unstampedScheduledTasksOlderThan(tx, at(10)));

    expect(ids(stale)).toEqual([4, 1, 5].map(cfId));
  });

  it("hides another tenant's rows, and a pooled connection after a tenant transaction sees none", async () => {
    await inTenant(tenantB, async (tx) => {
      await insertTemplate(tx, cfId(1), 'tenant-a', at(0));
      await insertMessage(tx, cfId(2), 'tenant-a', at(0), { source: 'login-mail', event_id: EVENT_ID });
      await insertStatus(tx, cfId(3), cfId(2), 'queued', at(0));
      await insertTask(tx, { id: 4, kind: 'survey-launch', origin: 'adopted', enqueuedAt: null });
    });
    const queueTaskName = `opt2-survey-${SURVEY_ID}-launch-v1`;

    const seen = await inTenant(tenantA, async (tx) => [
      await listTemplates(tx, { siteId: 'tenant-a' }),
      await findTemplate(tx, cfId(1)),
      await listMessages(tx, { siteId: 'tenant-a' }),
      await findMessage(tx, cfId(2)),
      await getMessageDetail(tx, cfId(2)),
      await findMessageByEventId(tx, EVENT_ID),
      await listScheduledTasksBySource(tx, { sourceType: 'survey', sourceId: SURVEY_ID }),
      await findScheduledTask(tx, cfId(4)),
      await findScheduledTaskByName(tx, { queue: 'surveys-launch', queueTaskName }),
      await listAdoptedScheduledTasks(tx),
      await queuedLoginMailOlderThan(tx, at(10)),
      await unstampedScheduledTasksOlderThan(tx, at(10)),
    ]);

    expect(seen).toEqual([{ items: [], total: 0 }, null, { items: [], total: 0 }, null, null, null, [], null, null, [], [], []]);
    expect(await inTenant(tenantB, (tx) => getMessageDetail(tx, cfId(2)))).toMatchObject({ message: { tenant_id: tenantB } });
    for (const table of ['message_template', 'message', 'delivery_status', 'scheduled_task']) {
      const { rows } = await handle.appPool.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.${table}`);
      expect(rows[0]?.n).toBe(0);
    }
  });

  it('rejects a read outside its tenant transaction', async () => {
    let ended: TenantTx | undefined;
    await inTenant(tenantA, async (tx) => {
      ended = tx;
    });

    await expect(listMessages(ended as TenantTx, { siteId: 'tenant-a' })).rejects.toBeInstanceOf(OutsideTenantTransactionError);
    await expect(findMessage(ended as TenantTx, cfId(1))).rejects.toBeInstanceOf(OutsideTenantTransactionError);
    await expect(listScheduledTasksBySource(ended as TenantTx, { sourceType: 'survey', sourceId: SURVEY_ID })).rejects.toBeInstanceOf(
      OutsideTenantTransactionError,
    );
  });

  it.each(['executing', 'importing', 'import-pending'])('blocks reads of a unit in a window %s phase, and only that unit', async (phase) => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'closed', holder_id = 'window-1', phase = $1 WHERE unit = $2`, [
        phase,
        'communications.delivery_status',
      ]),
    );
    const budget = { budgetMs: 300 };

    await expect(withGatedTenant(handle.app, tenantA, (tx) => getMessageDetail(tx, cfId(1)), budget)).rejects.toBeInstanceOf(
      UnitReadBlockedError,
    );
    expect(await withGatedTenant(handle.app, tenantA, (tx) => listMessages(tx, { siteId: 'tenant-a' }), budget)).toEqual({ items: [], total: 0 });
    expect(await withGatedTenant(handle.app, tenantA, (tx) => listAdoptedScheduledTasks(tx), budget)).toEqual([]);
  });
});
