// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** The only write path of schema `communications`: the platform repository plus the row writes the fixture `communications.cfc` performs. */
import { createRepository, qualified, type Repository, type WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { LegacyServiceUnavailableError, cfUuid } from '@opt2/platform/legacy-compat';
import {
  DELIVERY_STATUS,
  MESSAGE,
  MESSAGE_TEMPLATE,
  OWNED_TABLES,
  SCHEDULED_TASK,
  type DeliveryStatusRow,
  type MessageRow,
  type MessageSource,
  type MessageState,
  type MessageTemplateRow,
  type ScheduledTaskKind,
  type ScheduledTaskOrigin,
  type ScheduledTaskQueue,
  type ScheduledTaskRow,
  type ScheduledTaskStatus,
} from './tables.js';

/** Service name the communications write positions carry. */
export const OWNER = 'communications';

/** Schema the communications service owns. */
export const SCHEMA = 'communications';

// The fixture's nextInstant: statuses of one message stay at least 10 ms apart, so datetime's 1/300 s rounding keeps their order.
const STATUS_SPACING_MS = 10;
const ADOPTED: ScheduledTaskOrigin = 'adopted';
const ADVISORY_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const ENQUEUE_DUE: ReadonlySet<ScheduledTaskStatus> = new Set<ScheduledTaskStatus>(['scheduled']);
const DEQUEUE_DUE: ReadonlySet<ScheduledTaskStatus> = new Set<ScheduledTaskStatus>(['superseded', 'cancelled']);

/** Columns a new or reactivated task takes from its schedule: `scheduled` unless `expired`, not yet enqueued or dequeued. */
function scheduleColumns(
  task: NewAdoptedScheduledTask,
): Omit<ScheduledTaskRow, 'tenant_id' | 'scheduled_task_id' | 'task_name' | 'origin' | 'created_at' | 'updated_at'> {
  return {
    queue: task.queue,
    queue_task_name: task.queueTaskName,
    kind: task.kind,
    source_type: task.sourceType,
    source_id: task.sourceId,
    reminder_n: task.n ?? null,
    schedule_time: task.scheduleTime,
    status: task.expired === true ? 'expired' : 'scheduled',
    target_route: task.targetRoute,
    schedule_version: task.scheduleVersion,
    enqueued_at: null,
    dequeued_at: null,
  };
}

/** Columns of a new template that the caller supplies; `siteId` is the token's `site`. */
export interface NewTemplate {
  siteId: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

/** Columns of a new message; `messageId` defaults to a new CF UUID, `state` to `queued`, `templateId` and `eventId` to null. */
export interface NewMessage {
  messageId?: string;
  siteId: string;
  templateId?: string | null;
  toAddress: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  state?: MessageState;
  source: MessageSource;
  /** The `identity.login-mail.requested.v1` event id; login mail only. */
  eventId?: string | null;
}

/** A message state change; `at` (default: the clock) becomes `sent_at` for `sent`, so pass the status row's `recorded_at` to match it. */
export interface MessageStateChange {
  messageId: string;
  state: MessageState;
  at?: Date;
}

/** One delivery-status history row; an empty `detail` or `mailpitId` is stored as NULL, as the fixture stores it. */
export interface NewDeliveryStatus {
  messageId: string;
  state: MessageState;
  detail?: string | null;
  mailpitId?: string | null;
  source: MessageSource;
}

/** One scheduled task to record; the repository assigns its id, `status = 'scheduled'` (`expired` when flagged) and its timestamps. */
export interface NewScheduledTask {
  /** The fixture ACF task name, `opt2-survey-<surveyId>-launch|reminder-<n>`. */
  taskName: string;
  queue: ScheduledTaskQueue;
  queueTaskName: string;
  /** Queue task name of a cancelled adoption adopted again, from the tombstoned name it holds; absent keeps `queueTaskName`. */
  reactivatedQueueTaskName?: (currentQueueTaskName: string) => string;
  kind: ScheduledTaskKind;
  sourceType: string;
  sourceId: string;
  /** 1-based reminder ordinal (`reminder_n`); absent or null for a launch. */
  n?: number | null;
  scheduleTime: Date;
  /** Fixed route the task calls: its queue's registry target path. */
  targetRoute: string;
  scheduleVersion: number;
  origin: ScheduledTaskOrigin;
  /** A task the legacy scheduler misfires at registration: stored `expired`, which no queue side effect follows. */
  expired?: boolean;
}

/** One captured ACF task to adopt; adoption sets `origin = 'adopted'`. */
export type NewAdoptedScheduledTask = Omit<NewScheduledTask, 'origin'>;

/** The adopted row of a task name; `created` is false when an existing adoption was returned unchanged. */
export interface AdoptedScheduledTask {
  row: ScheduledTaskRow;
  created: boolean;
}

/** Domain writes of schema `communications`; each runs in the caller's open tenant transaction and never opens one. */
export interface CommunicationsWrites {
  /** Inserts a template created now, with `lastupdate` equal to `created` as the fixture writes it. */
  insertTemplate(tx: TenantTx, input: NewTemplate, ctx?: WriteContext): Promise<MessageTemplateRow>;
  /** Inserts a message created now at `row_version` 1. */
  insertMessage(tx: TenantTx, input: NewMessage, ctx?: WriteContext): Promise<MessageRow>;
  /** Sets `state` (and `sent_at` for `sent`) and increments `row_version` by one; null when the message is absent. */
  setMessageState(tx: TenantTx, change: MessageStateChange, ctx?: WriteContext): Promise<MessageRow | null>;
  /** Appends one history row, recorded now or 10 ms after the message's latest status when that is closer. */
  appendDeliveryStatus(tx: TenantTx, input: NewDeliveryStatus, ctx?: WriteContext): Promise<DeliveryStatusRow>;
  /** Inserts every event task as `scheduled` (`expired` when flagged), not yet enqueued or dequeued, and adopts adopted ones by name; returns the rows in input order. */
  insertScheduledTasks(tx: TenantTx, tasks: readonly NewScheduledTask[], ctx?: WriteContext): Promise<ScheduledTaskRow[]>;
  /**
   * Adopts each task once per task name: inserts it, reactivates a cancelled adoption, or returns the existing row; in input order.
   * Throws LegacyServiceUnavailableError for a cancelled adoption without `dequeued_at`, whose queue task may still exist.
   */
  adoptScheduledTasks(tx: TenantTx, tasks: readonly NewAdoptedScheduledTask[], ctx?: WriteContext): Promise<AdoptedScheduledTask[]>;
  /** Sets a task's `status`; null when the task is absent or, given `expected`, its locked row is in another status. */
  setScheduledTaskStatus(
    tx: TenantTx,
    taskId: string,
    status: ScheduledTaskStatus,
    ctx?: WriteContext,
    expected?: ScheduledTaskStatus,
  ): Promise<ScheduledTaskRow | null>;
  /** Stamps `enqueued_at` now, once the task port has created `queueTaskName`; null unless the task still holds it and is `scheduled`. */
  stampEnqueued(tx: TenantTx, taskId: string, queueTaskName: string, ctx?: WriteContext): Promise<ScheduledTaskRow | null>;
  /** Stamps `dequeued_at` now, once the task port has removed `queueTaskName`; null unless the task still holds it, superseded or cancelled. */
  stampDequeued(tx: TenantTx, taskId: string, queueTaskName: string, ctx?: WriteContext): Promise<ScheduledTaskRow | null>;
}

/** The platform repository of schema `communications`, its `base` for migration handlers, and the domain writes. */
export type CommunicationsRepository = Repository & { readonly base: Repository } & CommunicationsWrites;

/** Settings of `createCommunicationsRepository`; `schema` differs from `communications` only for throwaway test schemas. */
export interface CommunicationsRepositoryOptions {
  clock: Clock;
  schema?: string;
}

/** Builds the communications repository over the platform repository of `OWNED_TABLES`. */
export function createCommunicationsRepository({ clock, schema = SCHEMA }: CommunicationsRepositoryOptions): CommunicationsRepository {
  const base = createRepository({ owner: OWNER, schema, tables: OWNED_TABLES, clock });
  const lockMessageSql = `SELECT * FROM ${qualified(schema, MESSAGE.table)} WHERE message_id = $1 FOR UPDATE`;
  const lastStatusSql = `SELECT max(recorded_at) AS last FROM ${qualified(schema, DELIVERY_STATUS.table)} WHERE message_id = $1`;
  const adoptedByNameSql = `SELECT * FROM ${qualified(schema, SCHEDULED_TASK.table)} WHERE origin = '${ADOPTED}' AND task_name = $1 FOR UPDATE`;
  const lockTaskSql = `SELECT * FROM ${qualified(schema, SCHEDULED_TASK.table)} WHERE scheduled_task_id = $1 FOR UPDATE`;

  /** Recorded time of the message's next status, as the fixture's `nextInstant` computes it. */
  async function nextInstant(tx: TenantTx, messageId: string): Promise<Date> {
    const last = await base.read(
      tx,
      DELIVERY_STATUS.unit,
      async () => (await tx.query<{ last: Date | null }>(lastStatusSql, [messageId])).rows[0]?.last ?? null,
    );
    const at = clock.now();
    return last !== null && at.getTime() - last.getTime() < STATUS_SPACING_MS ? new Date(last.getTime() + STATUS_SPACING_MS) : at;
  }

  function insertTemplate(tx: TenantTx, input: NewTemplate, ctx: WriteContext = {}): Promise<MessageTemplateRow> {
    const now = clock.now();
    const row: Omit<MessageTemplateRow, 'tenant_id'> = {
      template_id: cfUuid(),
      siteid: input.siteId,
      name: input.name,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml,
      created: now,
      lastupdate: now,
    };
    return base.insert<MessageTemplateRow>(tx, MESSAGE_TEMPLATE.table, row, ctx);
  }

  function insertMessage(tx: TenantTx, input: NewMessage, ctx: WriteContext = {}): Promise<MessageRow> {
    const row: Omit<MessageRow, 'tenant_id'> = {
      message_id: input.messageId ?? cfUuid(),
      siteid: input.siteId,
      template_id: input.templateId ?? null,
      to_address: input.toAddress,
      from_address: input.fromAddress,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: input.bodyHtml,
      state: input.state ?? 'queued',
      created: clock.now(),
      sent_at: null,
      source: input.source,
      event_id: input.eventId ?? null,
      row_version: '1',
    };
    return base.insert<MessageRow>(tx, MESSAGE.table, row, ctx);
  }

  async function setMessageState(tx: TenantTx, change: MessageStateChange, ctx: WriteContext = {}): Promise<MessageRow | null> {
    // A locking read rather than findByKey: a concurrent change must not read the same row_version, which is the event's aggregate version.
    const current = await base.read(
      tx,
      MESSAGE.unit,
      async () => (await tx.query<MessageRow>(lockMessageSql, [change.messageId])).rows[0] ?? null,
    );
    if (current === null) {
      return null;
    }
    const patch: Partial<MessageRow> = {
      state: change.state,
      // int8 arrives as a decimal string.
      row_version: String(BigInt(current.row_version) + 1n),
    };
    if (change.state === 'sent') {
      patch.sent_at = change.at ?? clock.now();
    }
    return base.update<MessageRow>(tx, MESSAGE.table, { message_id: current.message_id }, patch, ctx);
  }

  async function appendDeliveryStatus(tx: TenantTx, input: NewDeliveryStatus, ctx: WriteContext = {}): Promise<DeliveryStatusRow> {
    const row: Omit<DeliveryStatusRow, 'tenant_id'> = {
      status_id: cfUuid(),
      message_id: input.messageId,
      status: input.state,
      detail: input.detail || null,
      mailpit_id: input.mailpitId || null,
      recorded_at: await nextInstant(tx, input.messageId),
      source: input.source,
    };
    return base.insert<DeliveryStatusRow>(tx, DELIVERY_STATUS.table, row, ctx);
  }

  /** Inserts `task` as a new row created at `now`. */
  async function insertScheduledTask(tx: TenantTx, task: NewScheduledTask, now: Date, ctx: WriteContext): Promise<ScheduledTaskRow> {
    const scheduledTaskId = cfUuid();
    const row: Omit<ScheduledTaskRow, 'tenant_id'> = {
      scheduled_task_id: scheduledTaskId,
      task_name: task.taskName,
      origin: task.origin,
      ...scheduleColumns(task),
      created_at: now,
      updated_at: now,
    };
    const stored = await base.insert<ScheduledTaskRow>(tx, SCHEDULED_TASK.table, row, ctx);
    // A timestamp without time zone drops the offset, so a repeated wall time read back would take its earlier occurrence.
    return { ...stored, schedule_time: task.scheduleTime };
  }

  /** Serialises adoptions of the same task names in the tenant; names are locked in sorted order so adopters never deadlock. */
  async function lockAdoptedNames(tx: TenantTx, taskNames: readonly string[]): Promise<void> {
    for (const taskName of [...new Set(taskNames)].sort()) {
      await tx.query(ADVISORY_LOCK_SQL, [`${schema}.${SCHEDULED_TASK.table}:adopted:${tx.tenantId}:${taskName}`]);
    }
  }

  /** Adopts one task whose name the caller has locked. */
  async function adoptScheduledTask(
    tx: TenantTx,
    task: NewAdoptedScheduledTask,
    now: Date,
    ctx: WriteContext,
  ): Promise<AdoptedScheduledTask> {
    const current = await base.read(
      tx,
      SCHEDULED_TASK.unit,
      async () => (await tx.query<ScheduledTaskRow>(adoptedByNameSql, [task.taskName])).rows[0],
    );
    if (current === undefined) {
      return { row: await insertScheduledTask(tx, { ...task, origin: ADOPTED }, now, ctx), created: true };
    }
    if (current.status !== 'cancelled') {
      return { row: current, created: false };
    }
    if (current.dequeued_at === null) {
      // Reactivation moves the row to another queue task, so a queue task its cancellation did not delete would be on no row.
      throw new LegacyServiceUnavailableError(
        `Adopted task ${current.task_name}: queue task ${current.queue_task_name} on ${current.queue} is not confirmed deleted`,
        'auto',
        'queue-task-not-dequeued',
      );
    }
    // Restoration cancelled this adoption; the name keeps one adopted row, so the same row is scheduled again.
    const columns = scheduleColumns(task);
    const queueTaskName = task.reactivatedQueueTaskName?.(current.queue_task_name) ?? columns.queue_task_name;
    const row = await updateScheduledTask(tx, current.scheduled_task_id, { ...columns, queue_task_name: queueTaskName }, ctx);
    // The instant written, as insertScheduledTask returns it.
    return { row: { ...(row as ScheduledTaskRow), schedule_time: task.scheduleTime }, created: true };
  }

  async function insertScheduledTasks(
    tx: TenantTx,
    tasks: readonly NewScheduledTask[],
    ctx: WriteContext = {},
  ): Promise<ScheduledTaskRow[]> {
    await lockAdoptedNames(tx, tasks.filter((task) => task.origin === ADOPTED).map((task) => task.taskName));
    const now = clock.now();
    const stored: ScheduledTaskRow[] = [];
    for (const task of tasks) {
      stored.push(
        task.origin === ADOPTED ? (await adoptScheduledTask(tx, task, now, ctx)).row : await insertScheduledTask(tx, task, now, ctx),
      );
    }
    return stored;
  }

  async function adoptScheduledTasks(
    tx: TenantTx,
    tasks: readonly NewAdoptedScheduledTask[],
    ctx: WriteContext = {},
  ): Promise<AdoptedScheduledTask[]> {
    await lockAdoptedNames(tx, tasks.map((task) => task.taskName));
    const now = clock.now();
    const adopted: AdoptedScheduledTask[] = [];
    for (const task of tasks) {
      adopted.push(await adoptScheduledTask(tx, task, now, ctx));
    }
    return adopted;
  }

  /** Sets `patch` and `updated_at` on one scheduled task; null when it is absent. */
  function updateScheduledTask(
    tx: TenantTx,
    taskId: string,
    patch: Partial<ScheduledTaskRow>,
    ctx: WriteContext,
  ): Promise<ScheduledTaskRow | null> {
    return base.update<ScheduledTaskRow>(tx, SCHEDULED_TASK.table, { scheduled_task_id: taskId }, { ...patch, updated_at: clock.now() }, ctx);
  }

  /** The task's row, locked FOR UPDATE until `tx` ends; undefined when it is absent. */
  function lockTask(tx: TenantTx, taskId: string): Promise<ScheduledTaskRow | undefined> {
    return base.read(tx, SCHEDULED_TASK.unit, async () => (await tx.query<ScheduledTaskRow>(lockTaskSql, [taskId])).rows[0]);
  }

  async function setScheduledTaskStatus(
    tx: TenantTx,
    taskId: string,
    status: ScheduledTaskStatus,
    ctx: WriteContext = {},
    expected?: ScheduledTaskStatus,
  ): Promise<ScheduledTaskRow | null> {
    // Checked on the locked row, so a status another transaction committed after the caller's read is never overwritten.
    if (expected !== undefined && (await lockTask(tx, taskId))?.status !== expected) {
      return null;
    }
    return updateScheduledTask(tx, taskId, { status }, ctx);
  }

  /** Locks the task and answers whether it still holds `queueTaskName` in a status of `due`. */
  async function holdsQueueTask(
    tx: TenantTx,
    taskId: string,
    queueTaskName: string,
    due: ReadonlySet<ScheduledTaskStatus>,
  ): Promise<boolean> {
    // A reactivation moves the same row to a new queue task, so a port call on an earlier one must not stamp it.
    const current = await lockTask(tx, taskId);
    return current !== undefined && current.queue_task_name === queueTaskName && due.has(current.status);
  }

  async function stampEnqueued(
    tx: TenantTx,
    taskId: string,
    queueTaskName: string,
    ctx: WriteContext = {},
  ): Promise<ScheduledTaskRow | null> {
    if (!(await holdsQueueTask(tx, taskId, queueTaskName, ENQUEUE_DUE))) {
      return null;
    }
    return updateScheduledTask(tx, taskId, { enqueued_at: clock.now() }, ctx);
  }

  async function stampDequeued(
    tx: TenantTx,
    taskId: string,
    queueTaskName: string,
    ctx: WriteContext = {},
  ): Promise<ScheduledTaskRow | null> {
    if (!(await holdsQueueTask(tx, taskId, queueTaskName, DEQUEUE_DUE))) {
      return null;
    }
    return updateScheduledTask(tx, taskId, { dequeued_at: clock.now() }, ctx);
  }

  return Object.freeze({
    ...base,
    base,
    insertTemplate,
    insertMessage,
    setMessageState,
    appendDeliveryStatus,
    insertScheduledTasks,
    adoptScheduledTasks,
    setScheduledTaskStatus,
    stampEnqueued,
    stampDequeued,
  });
}
