// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the communications schema, its scheduled-task routes and its login-mail consumer against PostgreSQL. */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, INBOX_TABLE, dlqTopicName, type DeadLetterReason } from '@opt2/platform/events';
import { cfUuid, errorSpec } from '@opt2/platform/legacy-compat';
import { CHANGELOG_TABLE, closeGates, openGates } from '@opt2/platform/migration-kit';
import { CLOUD_TASKS_HEADERS, QUEUES, TaskTenantMismatchError, taskWireBody, type CreateTaskInput } from '@opt2/platform/tasks';
import { withTenant, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  mintTasksInvokerToken,
  pgAvailable,
  pushTo,
  seedRegistry,
  withoutTenant,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SURVEY_TASK_QUEUES, portTaskName, taskPayload, taskTarget } from '../../src/domain/survey-tasks.js';
import { LOGIN_MAIL_SUBSCRIPTION } from '../../src/events/consumers.js';
import { LOGIN_MAIL_TOPIC } from '../../src/events/login-mail.js';
import { OWNER, createCommunicationsRepository, type CommunicationsRepository } from '../../src/repo/repository.js';
import {
  DELIVERY_STATUS,
  MESSAGE,
  MESSAGE_TEMPLATE,
  OWNED_TABLES,
  SCHEDULED_TASK,
  UNITS,
  type DeliveryStatusRow,
  type EmailReturnStatRow,
  type EmailRow,
  type EmailStatRow,
  type MailingListMemberRow,
  type MailingListRow,
  type MessageRow,
  type MessageTemplateRow,
  type ScheduledTaskRow,
  type TrashRow,
} from '../../src/repo/tables.js';
import { SCHEDULED_TASKS_PATH, toScheduledTask } from '../../src/routes/scheduled-tasks.js';
import { REMINDER_TASK_PATH } from '../../src/tasks/reminder.js';
import { TEST_CLOCK, buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { envelopeFor, loginMailPayload } from '../helpers/payloads.js';

type Row = Record<string, unknown>;
type Fresh<R> = Omit<R, 'tenant_id'>;
type KeylessManaged = 'legacy_row_hash' | 'occurrence';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
// An unset PG_HOST skips the suite without probing the server.
const PG_READY = Boolean(process.env.PG_HOST) && (await pgAvailable());
const GATE_HOLDER = 'communications-isolation-setup';
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const REMINDER_QUEUE = SURVEY_TASK_QUEUES['survey-reminder'];
const SOURCE_TYPE = 'survey';
const SCHEDULE_VERSION = 1;
const MISSING_TENANT: DeadLetterReason = 'missing-tenant';

let schema: ThrowawaySchema | undefined;
let repo: CommunicationsRepository | undefined;
let ctx: TestApp<TenantDb> | undefined;

/** Returns `value`; throws naming `what` when the beforeAll that sets it failed. */
function setUp<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The ${what} was not set up; see the beforeAll failure`);
  }
  return value;
}

const created = (): ThrowawaySchema => setUp(schema, 'throwaway communications schema');
const repository = (): CommunicationsRepository => setUp(repo, 'communications repository');
const running = (): TestApp<TenantDb> => setUp(ctx, 'communications app');

/** SHA-256 hex digest of a fresh UUID, shaped like a stored `legacy_row_hash`. */
function rowHash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

/** Hash and first occurrence of a fresh keyless row, which the repository computes itself on its writes. */
function keyless(): Pick<EmailStatRow, KeylessManaged> {
  return { legacy_row_hash: rowHash(), occurrence: 1 };
}

// Fresh rows of every owned table, typed by its row shape so each NOT NULL and CHECK value of 0002_communications.sql is met.
const SAMPLE_ROWS = {
  message_template: (tenant: TenantFixture): Fresh<MessageTemplateRow> => ({
    template_id: cfUuid(),
    siteid: tenant.siteId,
    name: `Isolation template ${tenant.key}`,
    subject: `Isolation subject ${tenant.key}`,
    body_text: 'Isolation body',
    body_html: '<p>Isolation body</p>',
    created: TEST_CLOCK.now(),
    lastupdate: TEST_CLOCK.now(),
  }),
  message: (tenant: TenantFixture): Fresh<MessageRow> => ({
    message_id: cfUuid(),
    siteid: tenant.siteId,
    template_id: null,
    to_address: `member@${tenant.siteId}.example`,
    from_address: `no-reply@${tenant.siteId}.example`,
    subject: `Isolation message ${tenant.key}`,
    body_text: 'Isolation body',
    body_html: '<p>Isolation body</p>',
    state: 'queued',
    created: TEST_CLOCK.now(),
    sent_at: null,
    source: 'send',
    event_id: null,
    row_version: '1',
  }),
  delivery_status: (): Fresh<DeliveryStatusRow> => ({
    status_id: cfUuid(),
    message_id: cfUuid(),
    status: 'queued',
    detail: null,
    mailpit_id: null,
    recorded_at: TEST_CLOCK.now(),
    source: 'send',
  }),
  scheduled_task: (): Fresh<ScheduledTaskRow> => {
    const sourceId = cfUuid();
    const taskName = `opt2-survey-${sourceId}-reminder-1`;
    return {
      scheduled_task_id: cfUuid(),
      task_name: taskName,
      queue: REMINDER_QUEUE,
      queue_task_name: portTaskName(taskName, SCHEDULE_VERSION),
      kind: 'survey-reminder',
      source_type: SOURCE_TYPE,
      source_id: sourceId,
      reminder_n: 1,
      schedule_time: TEST_CLOCK.now(),
      status: 'scheduled',
      target_route: `/internal/v1/tasks/reminders/${cfUuid()}`,
      schedule_version: SCHEDULE_VERSION,
      origin: 'event',
      enqueued_at: null,
      dequeued_at: null,
      created_at: TEST_CLOCK.now(),
      updated_at: TEST_CLOCK.now(),
    };
  },
  email: (tenant: TenantFixture): Fresh<EmailRow> => ({
    emailid: cfUuid(),
    siteid: tenant.siteId,
    subject: `Isolation email ${tenant.key}`,
    bodytext: 'Isolation body',
    bodyhtml: null,
    createddate: TEST_CLOCK.now(),
    deliverydate: null,
    status: 0,
    grouplist: null,
    lastupdateby: 'Isolation',
    lastupdatebyid: cfUuid(),
    numbersent: 0,
    replyto: null,
    format: 'Text',
    fromlabel: null,
    isdeleted: 0,
    template: null,
  }),
  email_stat: (tenant: TenantFixture): Fresh<EmailStatRow> => ({
    emailid: cfUuid(),
    email: `member@${tenant.siteId}.example`,
    emailopen: 0,
    returnclick: 0,
    bounce: 0,
    sent: 1,
    created: TEST_CLOCK.now(),
    ...keyless(),
  }),
  email_return_stat: (tenant: TenantFixture): Fresh<EmailReturnStatRow> => ({
    emailid: cfUuid(),
    email: `member@${tenant.siteId}.example`,
    url: `http://${tenant.siteId}.opt2.test/isolation`,
    created: TEST_CLOCK.now(),
    ...keyless(),
  }),
  mailing_list: (tenant: TenantFixture): Fresh<MailingListRow> => ({
    mlid: cfUuid(),
    siteid: tenant.siteId,
    name: `Isolation list ${tenant.key}`,
    description: null,
    lastupdate: TEST_CLOCK.now(),
    ispurge: 0,
    ispublic: 1,
    ...keyless(),
  }),
  mailing_list_member: (tenant: TenantFixture): Fresh<MailingListMemberRow> => ({
    mlid: cfUuid(),
    email: `member-${randomUUID()}@${tenant.siteId}.example`,
    siteid: tenant.siteId,
    fname: 'Member',
    lname: tenant.key,
    company: null,
    isverified: 1,
    created: TEST_CLOCK.now(),
    ...keyless(),
  }),
  trash: (tenant: TenantFixture): Fresh<TrashRow> => ({
    objectid: cfUuid(),
    parentid: cfUuid(),
    siteid: tenant.siteId,
    objectlabel: `Isolation trash ${tenant.key}`,
    objectclass: 'email',
    objecttype: 'Email',
    objectsubtype: 'Default',
    objectstring: null,
    deleteddate: TEST_CLOCK.now(),
    deletedby: 'Isolation',
    deleteid: null,
    orderno: null,
  }),
} satisfies Readonly<Record<string, (tenant: TenantFixture) => Row>>;

/** A fresh `table` row of `tenant`, without `tenant_id`, that meets every constraint of the table. */
function rowFor(table: string, tenant: TenantFixture): Row {
  if (!Object.hasOwn(SAMPLE_ROWS, table)) {
    throw new TypeError(`The communications isolation suite has no sample row for table ${table}`);
  }
  return SAMPLE_ROWS[table as keyof typeof SAMPLE_ROWS](tenant);
}

/** Stores the sample message of `tenant` through the repository. */
function insertSampleMessage(tx: TenantTx, tenant: TenantFixture): Promise<MessageRow> {
  const row = SAMPLE_ROWS.message(tenant);
  return repository().insertMessage(tx, {
    siteId: row.siteid,
    toAddress: row.to_address,
    fromAddress: row.from_address,
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    source: row.source,
  });
}

/** Stores reminder `n` of survey `sourceId` as the survey.scheduled consumer does, its route naming the stored row. */
async function insertReminderTask(tx: TenantTx, sourceId: string, n = 1): Promise<ScheduledTaskRow> {
  const taskName = `opt2-survey-${sourceId}-reminder-${String(n)}`;
  const serviceUrls = running().env.OPT2_SERVICE_URLS;
  const rows = await repository().insertScheduledTasks(tx, [
    {
      taskName,
      queue: REMINDER_QUEUE,
      queueTaskName: portTaskName(taskName, SCHEDULE_VERSION),
      kind: 'survey-reminder',
      sourceType: SOURCE_TYPE,
      sourceId,
      n,
      scheduleTime: TEST_CLOCK.now(),
      targetRoute: (scheduledTaskId) => taskTarget({ queue: REMINDER_QUEUE, surveyId: sourceId, scheduledTaskId }, serviceUrls).route,
      scheduleVersion: SCHEDULE_VERSION,
      origin: 'event',
    },
  ]);
  return rows[0] as ScheduledTaskRow;
}

/** Writes one `table` row of `tenant` through the communications repository, under the tenant of `tx`. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const writes = repository();
  switch (table) {
    case MESSAGE_TEMPLATE.table: {
      const row = SAMPLE_ROWS.message_template(tenant);
      await writes.insertTemplate(tx, {
        siteId: row.siteid,
        name: row.name,
        subject: row.subject,
        bodyText: row.body_text,
        bodyHtml: row.body_html,
      });
      return;
    }
    case MESSAGE.table:
      await insertSampleMessage(tx, tenant);
      return;
    case DELIVERY_STATUS.table: {
      const { message_id: messageId } = await insertSampleMessage(tx, tenant);
      const { status, source } = SAMPLE_ROWS.delivery_status();
      await writes.appendDeliveryStatus(tx, { messageId, state: status, source });
      return;
    }
    case SCHEDULED_TASK.table:
      await insertReminderTask(tx, cfUuid());
      return;
    default:
      await writes.base.insert(tx, table, rowFor(table, tenant));
  }
}

/** Every row of `table` visible in `tx`. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** Rows of `table` matching `where` that each fixture tenant sees, by fixture key. */
async function countsOf(table: string, where = 'true', values: unknown[] = []): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const tenant of TENANT_LIST) {
    counts[tenant.key] = await withTenant(created().app, tenant.tenantId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${tx.schema}"."${table}" WHERE ${where}`, values);
      return rows[0]?.n ?? 0;
    });
  }
  return counts;
}

/** The stored scheduled task `taskId` as `tenant` sees it, or undefined. */
async function storedTask(tenant: TenantFixture, taskId: string): Promise<ScheduledTaskRow | undefined> {
  return withTenant(created().app, tenant.tenantId, async (tx) => {
    const { rows } = await tx.query<ScheduledTaskRow>(
      `SELECT * FROM "${tx.schema}"."${SCHEDULED_TASK.table}" WHERE scheduled_task_id = $1`,
      [taskId],
    );
    return rows[0];
  });
}

const NONE = Object.fromEntries(TENANT_LIST.map(({ key }) => [key, 0]));

describe.skipIf(!PG_READY)('communications isolation (requires PG_HOST)', () => {
  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'communications', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    repo = createCommunicationsRepository({ clock: TEST_CLOCK, schema: schema.schema });
    ctx = await buildTestApp({ db: schema.app });
    // The app's onReady inserts every missing gate as `legacy`; a transition makes a unit authoritative by closing and reopening it.
    await closeGates(schema.app, { units: UNITS, holderId: GATE_HOLDER, allowLegacy: true });
    await openGates(schema.app, { units: UNITS, holderId: GATE_HOLDER });
  }, 60_000);

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  }, 60_000);

  it('creates the outbox, event, migration-kit, task and tenancy tables with RLS forced on the tenant-owned ones', async () => {
    await expectPlatformTables(created(), { groups: ALL_PLATFORM_GROUPS });
  });

  // The shared suite also checks the catalog and pooled-connection reuse of every owned table, so neither is repeated here.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'communications owned tables',
      tables: OWNED_TABLES.map(({ table }) => table),
      writeAs,
      readAs,
      rowFor,
    },
  );

  describe('scheduled tasks of one survey in tenants A and B', () => {
    const sourceId = cfUuid();
    let tenantATask: ScheduledTaskRow | undefined;
    let tenantBTask: ScheduledTaskRow | undefined;

    beforeAll(async () => {
      const db = created().app;
      tenantATask = await withTenant(db, TENANT_A.tenantId, (tx) => insertReminderTask(tx, sourceId, 1));
      tenantBTask = await withTenant(db, TENANT_B.tenantId, (tx) => insertReminderTask(tx, sourceId, 2));
    });

    it('tenant B never sees tenant A tasks', async () => {
      const foreign = setUp(tenantATask, 'tenant A reminder');
      const headers = {
        ...(await headersFor('surveys.manager', { site: TENANT_B.siteId })),
        ...(await headersFor('service:surveys')),
      };
      const res = await running().app.inject({
        method: 'GET',
        url: `${SCHEDULED_TASKS_PATH}?sourceType=${SOURCE_TYPE}&sourceId=${sourceId}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toEqual([toScheduledTask(setUp(tenantBTask, 'tenant B reminder'))]);
      expect(res.body).not.toContain(foreign.task_name);
      expect(res.body).not.toContain(foreign.scheduled_task_id);
    });

    it('refuses a tenant B reminder task naming the tenant A reminder and writes nothing', async () => {
      const app = running();
      const foreign = setUp(tenantATask, 'tenant A reminder');
      const ref = { queue: REMINDER_QUEUE, surveyId: sourceId, scheduledTaskId: foreign.scheduled_task_id };
      const source = { kind: foreign.kind, surveyId: sourceId, siteId: TENANT_A.siteId, scheduleVersion: SCHEDULE_VERSION, n: foreign.reminder_n };
      const task: CreateTaskInput = {
        queue: REMINDER_QUEUE,
        name: foreign.queue_task_name,
        scheduleTime: TEST_CLOCK.now(),
        url: taskTarget(ref, app.env.OPT2_SERVICE_URLS).url,
        body: taskPayload(source, foreign.scheduled_task_id),
        deadlineS: QUEUES[REMINDER_QUEUE].deadlineS,
        tenantId: TENANT_B.tenantId,
      };
      const before = {
        task: await storedTask(TENANT_A, foreign.scheduled_task_id),
        messages: await countsOf(MESSAGE.table),
        changelog: await countsOf(CHANGELOG_TABLE),
      };
      app.client.clear();

      const res = await app.app.inject({
        method: 'POST',
        url: new URL(task.url).pathname,
        headers: {
          authorization: `Bearer ${await mintTasksInvokerToken({ audience: OWNER })}`,
          [CLOUD_TASKS_HEADERS.taskName]: task.name,
          [CLOUD_TASKS_HEADERS.queueName]: task.queue,
        },
        payload: { ...taskWireBody(task) },
      });

      const refusal = errorSpec(new TaskTenantMismatchError(TENANT_B.tenantId, task.name).type);
      expect(res.statusCode).toBe(refusal.status);
      expect(res.json()).toMatchObject({ error: { code: refusal.code, message: refusal.message } });
      expect(before.task?.status).toBe('scheduled');
      expect(await storedTask(TENANT_A, foreign.scheduled_task_id)).toEqual(before.task);
      expect(await countsOf(MESSAGE.table)).toEqual(before.messages);
      expect(await countsOf(CHANGELOG_TABLE)).toEqual(before.changelog);
      expect(app.mail.sent).toEqual([]);
      expect(app.client.requestsTo('surveys')).toEqual([]);
    });
  });

  // Here rather than through the shared suite's `event` option, which would push a second time and checks neither inbox nor mail.
  it('acks a login-mail event without a tenant, dead-letters it once as missing-tenant and records nothing', async () => {
    const app = running();
    const envelope = withoutTenant(envelopeFor(LOGIN_MAIL_TOPIC, loginMailPayload(), { tenantId: TENANT_A.tenantId }));
    const messagesBefore = await countsOf(MESSAGE.table);
    app.publisher.clear();

    const res = await pushTo(app.app, LOGIN_MAIL_SUBSCRIPTION, envelope);

    expect(res.statusCode).toBe(204);
    expect(app.publisher.raw.map(({ topic, message }) => ({ topic, reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE] }))).toEqual([
      { topic: dlqTopicName(LOGIN_MAIL_SUBSCRIPTION), reason: MISSING_TENANT },
    ]);
    expect(app.publisher.published).toEqual([]);
    expect(await countsOf(MESSAGE.table, 'event_id = $1', [envelope.eventId])).toEqual(NONE);
    expect(await countsOf(INBOX_TABLE, 'event_id = $1', [envelope.eventId])).toEqual(NONE);
    expect(await countsOf(MESSAGE.table)).toEqual(messagesBefore);
    expect(app.mail.sent).toEqual([]);
  });
});

