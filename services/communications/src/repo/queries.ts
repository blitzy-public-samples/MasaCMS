// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Gated reads of schema `communications` with the fixture `communications.cfc` filters and order; every helper takes the caller's open tenant transaction. */
import { createRepository, qualified, type Repository } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import { OWNER } from './repository.js';
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
  type ScheduledTaskOrigin,
  type ScheduledTaskQueue,
  type ScheduledTaskRow,
  type ScheduledTaskStatus,
} from './tables.js';

/** The fixture list's site filter and its validated envelope.cfc page; omitting both paging fields reads every row. */
export type SiteListFilters = { siteId: string } & (
  | { pageIndex: number; itemsPerPage: number }
  | { pageIndex?: undefined; itemsPerPage?: undefined }
);

/** Filters of the fixture template list. */
export type TemplateListFilters = SiteListFilters;

/** Filters of the fixture message list. */
export type MessageListFilters = SiteListFilters;

/** One page of rows and the count of every row the filter matches. */
export interface ListPage<R> {
  items: R[];
  total: number;
}

/** One page of the site's templates. */
export type TemplateListPage = ListPage<MessageTemplateRow>;

/** One page of the site's messages. */
export type MessageListPage = ListPage<MessageRow>;

/** A message with its delivery-status history by `recorded_at`, then `status_id`. */
export interface MessageDetail {
  message: MessageRow;
  history: DeliveryStatusRow[];
}

/** The source whose scheduled tasks are read, such as `{ sourceType: 'survey', sourceId: surveyId }`. */
export interface ScheduledTaskSource {
  sourceType: string;
  sourceId: string;
}

/** The unique queue task of a scheduled-task row. */
export interface QueueTaskName {
  queue: ScheduledTaskQueue;
  queueTaskName: string;
}

const LOGIN_MAIL: MessageSource = 'login-mail';
const QUEUED: MessageState = 'queued';
const SCHEDULED: ScheduledTaskStatus = 'scheduled';
const SUPERSEDED: ScheduledTaskStatus = 'superseded';
const DEQUEUE_PENDING: readonly ScheduledTaskStatus[] = ['superseded', 'cancelled'];
const ADOPTED: ScheduledTaskOrigin = 'adopted';

// scheduled_task has no unit gate (see tables.ts), so its reads only check the tenant transaction.
const UNGATED: readonly string[] = [];

// SQL Server's default collation compares text case-insensitively and ignores trailing spaces.
const SITE_MATCH = 'lower(rtrim(siteid)) = lower(rtrim($1))';
// The contract's ScheduledTaskList order; reminder offsets are never negative, so a launch precedes its reminders.
const TASK_ORDER = 'ORDER BY schedule_time, kind, reminder_n NULLS FIRST, scheduled_task_id';

interface SchemaReads {
  readonly repository: Repository;
  readonly countTemplates: string;
  readonly templatePage: string;
  readonly countMessages: string;
  readonly messagePage: string;
  readonly history: string;
  readonly messageByEventId: string;
  readonly currentTasks: string;
  readonly taskByName: string;
  readonly adoptedTasks: string;
  readonly adoptedTasksNamed: string;
  readonly queuedLoginMail: string;
  readonly unstampedTasks: string;
}

const readsBySchema = new Map<string, SchemaReads>();

/** The read repository and statements of `schema`. */
function prepareReads(schema: string): SchemaReads {
  const template = qualified(schema, MESSAGE_TEMPLATE.table);
  const message = qualified(schema, MESSAGE.table);
  const status = qualified(schema, DELIVERY_STATUS.table);
  const task = qualified(schema, SCHEDULED_TASK.table);
  return Object.freeze({
    repository: createRepository({ owner: OWNER, schema, tables: OWNED_TABLES }),
    countTemplates: `SELECT count(*)::integer AS total FROM ${template} WHERE ${SITE_MATCH}`,
    // A NULL limit reads to the end, for the unpaged list.
    templatePage: `SELECT * FROM ${template} WHERE ${SITE_MATCH} ORDER BY created, template_id OFFSET $2 LIMIT $3`,
    countMessages: `SELECT count(*)::integer AS total FROM ${message} WHERE ${SITE_MATCH}`,
    messagePage: `SELECT * FROM ${message} WHERE ${SITE_MATCH} ORDER BY created, message_id OFFSET $2 LIMIT $3`,
    history: `SELECT * FROM ${status} WHERE message_id = $1 ORDER BY recorded_at, status_id`,
    messageByEventId: `SELECT * FROM ${message} WHERE event_id = $1`,
    currentTasks:
      `SELECT * FROM ${task} WHERE source_type = $1 AND source_id = $2 AND status <> $3` +
      ` AND schedule_version = (SELECT max(schedule_version) FROM ${task} WHERE source_type = $1 AND source_id = $2) ${TASK_ORDER}`,
    taskByName: `SELECT * FROM ${task} WHERE queue = $1 AND queue_task_name = $2`,
    adoptedTasks: `SELECT * FROM ${task} WHERE origin = $1 AND status = $2 ORDER BY created_at, scheduled_task_id`,
    adoptedTasksNamed: `SELECT * FROM ${task} WHERE origin = $1 AND status = $2 AND task_name = ANY($3::text[]) ORDER BY created_at, scheduled_task_id`,
    queuedLoginMail: `SELECT * FROM ${message} WHERE source = $1 AND state = $2 AND created < $3 ORDER BY created, message_id`,
    // A dequeue is due from the status change, which sets updated_at; an enqueue from the insert.
    unstampedTasks:
      `SELECT * FROM ${task} WHERE (status = $1 AND enqueued_at IS NULL AND created_at < $3)` +
      ` OR (status = ANY($2::text[]) AND dequeued_at IS NULL AND updated_at < $3) ORDER BY created_at, scheduled_task_id`,
  });
}

/** The reads of the transaction's schema, which is `communications` except in throwaway test schemas. */
function readsFor(tx: TenantTx): SchemaReads {
  let reads = readsBySchema.get(tx.schema);
  if (reads === undefined) {
    reads = prepareReads(tx.schema);
    readsBySchema.set(tx.schema, reads);
  }
  return reads;
}

/** One page of a site list as envelope.cfc queryPage() reads it: the total first, the page only when it starts before the total. */
async function sitePage<R extends Record<string, unknown>>(
  tx: TenantTx,
  countSql: string,
  pageSql: string,
  filters: SiteListFilters,
): Promise<ListPage<R>> {
  const counted = await tx.query<{ total: number }>(countSql, [filters.siteId]);
  const total = counted.rows[0]?.total ?? 0;
  const offset = filters.itemsPerPage === undefined ? 0 : (filters.pageIndex - 1) * filters.itemsPerPage;
  if (offset >= total) {
    return { items: [], total };
  }
  const { rows } = await tx.query<R>(pageSql, [filters.siteId, offset, filters.itemsPerPage ?? null]);
  return { items: rows, total };
}

/** One page of the site's templates by creation time and id, with the matching total. */
export function listTemplates(tx: TenantTx, filters: TemplateListFilters): Promise<TemplateListPage> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, MESSAGE_TEMPLATE.unit, () =>
    sitePage<MessageTemplateRow>(tx, reads.countTemplates, reads.templatePage, filters),
  );
}

/** The template row with `templateId`; null when the tenant has none. */
export function findTemplate(tx: TenantTx, templateId: string): Promise<MessageTemplateRow | null> {
  return readsFor(tx).repository.findByKey<MessageTemplateRow>(tx, MESSAGE_TEMPLATE.table, { template_id: templateId });
}

/** One page of the site's messages by creation time and id, with the matching total. */
export function listMessages(tx: TenantTx, filters: MessageListFilters): Promise<MessageListPage> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, MESSAGE.unit, () => sitePage<MessageRow>(tx, reads.countMessages, reads.messagePage, filters));
}

/** The message row with `messageId`; null when the tenant has none. */
export function findMessage(tx: TenantTx, messageId: string): Promise<MessageRow | null> {
  return readsFor(tx).repository.findByKey<MessageRow>(tx, MESSAGE.table, { message_id: messageId });
}

/** The message with its delivery-status history in the fixture detail's order; null when the tenant has no such message. */
export function getMessageDetail(tx: TenantTx, messageId: string): Promise<MessageDetail | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, [MESSAGE.unit, DELIVERY_STATUS.unit], async () => {
    const message = await findMessage(tx, messageId);
    if (message === null) {
      return null;
    }
    const { rows } = await tx.query<DeliveryStatusRow>(reads.history, [message.message_id]);
    return { message, history: rows };
  });
}

/** The message a login-mail event with `eventId` created; null when none did. */
export function findMessageByEventId(tx: TenantTx, eventId: string): Promise<MessageRow | null> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, MESSAGE.unit, async () => (await tx.query<MessageRow>(reads.messageByEventId, [eventId])).rows[0] ?? null);
}

/** The source's tasks of its highest schedule version, superseded rows excluded, by schedule time, kind and reminder ordinal. */
export function listScheduledTasksBySource(tx: TenantTx, source: ScheduledTaskSource): Promise<ScheduledTaskRow[]> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    UNGATED,
    async () => (await tx.query<ScheduledTaskRow>(reads.currentTasks, [source.sourceType, source.sourceId, SUPERSEDED])).rows,
  );
}

/** The scheduled task with `taskId`; null when the tenant has none. */
export function findScheduledTask(tx: TenantTx, taskId: string): Promise<ScheduledTaskRow | null> {
  return readsFor(tx).repository.findByKey<ScheduledTaskRow>(tx, SCHEDULED_TASK.table, { scheduled_task_id: taskId });
}

/** The scheduled task of one queue task; null when the tenant has none. */
export function findScheduledTaskByName(tx: TenantTx, name: QueueTaskName): Promise<ScheduledTaskRow | null> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    UNGATED,
    async () => (await tx.query<ScheduledTaskRow>(reads.taskByName, [name.queue, name.queueTaskName])).rows[0] ?? null,
  );
}

/** Adopted tasks still `scheduled`, limited to the fixture task names in `taskNames` when given, by creation time and id. */
export function listAdoptedScheduledTasks(tx: TenantTx, taskNames?: readonly string[]): Promise<ScheduledTaskRow[]> {
  const reads = readsFor(tx);
  return reads.repository.read(tx, UNGATED, async () => {
    const result =
      taskNames === undefined
        ? await tx.query<ScheduledTaskRow>(reads.adoptedTasks, [ADOPTED, SCHEDULED])
        : await tx.query<ScheduledTaskRow>(reads.adoptedTasksNamed, [ADOPTED, SCHEDULED, [...taskNames]]);
    return result.rows;
  });
}

/** Login-mail messages still `queued` that were created before `cutoff`, by creation time and id. */
export function queuedLoginMailOlderThan(tx: TenantTx, cutoff: Date): Promise<MessageRow[]> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    MESSAGE.unit,
    async () => (await tx.query<MessageRow>(reads.queuedLoginMail, [LOGIN_MAIL, QUEUED, cutoff])).rows,
  );
}

/**
 * Tasks whose queue side effect is overdue: `scheduled` without `enqueued_at` created before `cutoff`, and
 * `superseded` or `cancelled` without `dequeued_at` changed before `cutoff`; by creation time and id.
 */
export function unstampedScheduledTasksOlderThan(tx: TenantTx, cutoff: Date): Promise<ScheduledTaskRow[]> {
  const reads = readsFor(tx);
  return reads.repository.read(
    tx,
    UNGATED,
    async () => (await tx.query<ScheduledTaskRow>(reads.unstampedTasks, [SCHEDULED, [...DEQUEUE_PENDING], cutoff])).rows,
  );
}
