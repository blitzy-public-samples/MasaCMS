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

/** Rows a recovery or adoption read returns when the caller sets no limit. */
export const RECOVERY_BATCH_SIZE = 100;

/** Largest limit a recovery or adoption read accepts. */
export const MAX_RECOVERY_BATCH_SIZE = 1000;

/** Keyset position of a batch read: the last row's creation time and id. */
export interface BatchCursor {
  at: Date;
  id: string;
}

/** One batch of a recovery or adoption read: at most `limit` rows (default RECOVERY_BATCH_SIZE), after `after` when given. */
export interface RecoveryBatch {
  limit?: number;
  after?: BatchCursor;
}

/** The cursor that continues a message batch after `row`. */
export function messageCursor(row: MessageRow): BatchCursor {
  return { at: row.created, id: row.message_id };
}

/** The cursor that continues a scheduled-task batch after `row`. */
export function taskCursor(row: ScheduledTaskRow): BatchCursor {
  return { at: row.created_at, id: row.scheduled_task_id };
}

const LOGIN_MAIL: MessageSource = 'login-mail';
const QUEUED: MessageState = 'queued';
const SCHEDULED: ScheduledTaskStatus = 'scheduled';
const SUPERSEDED: ScheduledTaskStatus = 'superseded';
const DEQUEUE_PENDING: readonly ScheduledTaskStatus[] = ['superseded', 'cancelled'];
const ADOPTED: ScheduledTaskOrigin = 'adopted';
const ADOPTED_SCHEDULED = `origin = '${ADOPTED}' AND status = '${SCHEDULED}'`;

// SQL Server's default collation compares text case-insensitively and ignores trailing spaces.
const SITE_MATCH = 'lower(rtrim(siteid)) = lower(rtrim($1))';
// The contract's ScheduledTaskList order; reminder offsets are never negative, so a launch precedes its reminders.
const TASK_ORDER = 'ORDER BY schedule_time, kind, reminder_n NULLS FIRST, scheduled_task_id';
const MESSAGE_KEY = 'created, message_id';
const TASK_KEY = 'created_at, scheduled_task_id';

/** The first-batch and after-cursor statements of one keyset read. */
interface BatchReads {
  readonly first: string;
  readonly after: string;
}

/** Keyset variants of `sql`, whose own parameters end before `$next`; the cursor's parameters, then the limit, follow them. */
function batchReads(sql: string, key: string, next: number): BatchReads {
  return {
    first: `${sql} ORDER BY ${key} LIMIT $${next}`,
    after: `${sql} AND (${key}) > ($${next}, $${next + 1}) ORDER BY ${key} LIMIT $${next + 2}`,
  };
}

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
  readonly adoptedTasks: BatchReads;
  readonly adoptedTasksNamed: BatchReads;
  readonly queuedLoginMail: BatchReads;
  readonly unstampedTasks: BatchReads;
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
    // Constants are literals so the partial indexes' predicates are provable from the statement text.
    adoptedTasks: batchReads(`SELECT * FROM ${task} WHERE ${ADOPTED_SCHEDULED}`, TASK_KEY, 1),
    adoptedTasksNamed: batchReads(`SELECT * FROM ${task} WHERE ${ADOPTED_SCHEDULED} AND task_name = ANY($1::text[])`, TASK_KEY, 2),
    queuedLoginMail: batchReads(
      `SELECT * FROM ${message} WHERE source = '${LOGIN_MAIL}' AND state = '${QUEUED}' AND created < $1`,
      MESSAGE_KEY,
      2,
    ),
    // A dequeue is due from the status change, which sets updated_at; an enqueue from the insert.
    unstampedTasks: batchReads(
      `SELECT * FROM ${task} WHERE ((status = '${SCHEDULED}' AND enqueued_at IS NULL AND created_at < $1)` +
        ` OR (status IN (${DEQUEUE_PENDING.map((s) => `'${s}'`).join(', ')}) AND dequeued_at IS NULL AND updated_at < $1))`,
      TASK_KEY,
      2,
    ),
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
    SCHEDULED_TASK.unit,
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
    SCHEDULED_TASK.unit,
    async () => (await tx.query<ScheduledTaskRow>(reads.taskByName, [name.queue, name.queueTaskName])).rows[0] ?? null,
  );
}

/** The batch limit; throws RangeError unless it is an integer from 1 to MAX_RECOVERY_BATCH_SIZE. */
function batchLimit(limit: number = RECOVERY_BATCH_SIZE): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOVERY_BATCH_SIZE) {
    throw new RangeError(`batch limit must be an integer from 1 to ${MAX_RECOVERY_BATCH_SIZE}, got ${limit}`);
  }
  return limit;
}

/** One batch of `statements` with the read's own `values`. */
async function readBatch<R extends Record<string, unknown>>(
  tx: TenantTx,
  statements: BatchReads,
  values: unknown[],
  limit: number,
  after: BatchCursor | undefined,
): Promise<R[]> {
  const result =
    after === undefined
      ? await tx.query<R>(statements.first, [...values, limit])
      : await tx.query<R>(statements.after, [...values, after.at, after.id, limit]);
  return result.rows;
}

/** One batch of adopted tasks still `scheduled`, limited to the fixture task names in `taskNames` when given, by creation time and id. */
export async function listAdoptedScheduledTasks(
  tx: TenantTx,
  taskNames?: readonly string[],
  batch: RecoveryBatch = {},
): Promise<ScheduledTaskRow[]> {
  const limit = batchLimit(batch.limit);
  const reads = readsFor(tx);
  return reads.repository.read(tx, SCHEDULED_TASK.unit, () =>
    taskNames === undefined
      ? readBatch<ScheduledTaskRow>(tx, reads.adoptedTasks, [], limit, batch.after)
      : readBatch<ScheduledTaskRow>(tx, reads.adoptedTasksNamed, [[...taskNames]], limit, batch.after),
  );
}

/** One batch of login-mail messages still `queued` that were created before `cutoff`, by creation time and id. */
export async function queuedLoginMailOlderThan(tx: TenantTx, cutoff: Date, batch: RecoveryBatch = {}): Promise<MessageRow[]> {
  const limit = batchLimit(batch.limit);
  const reads = readsFor(tx);
  return reads.repository.read(tx, MESSAGE.unit, () => readBatch<MessageRow>(tx, reads.queuedLoginMail, [cutoff], limit, batch.after));
}

/**
 * One batch of tasks whose queue side effect is overdue: `scheduled` without `enqueued_at` created before `cutoff`, and
 * `superseded` or `cancelled` without `dequeued_at` changed before `cutoff`; by creation time and id.
 */
export async function unstampedScheduledTasksOlderThan(tx: TenantTx, cutoff: Date, batch: RecoveryBatch = {}): Promise<ScheduledTaskRow[]> {
  const limit = batchLimit(batch.limit);
  const reads = readsFor(tx);
  return reads.repository.read(tx, SCHEDULED_TASK.unit, () =>
    readBatch<ScheduledTaskRow>(tx, reads.unstampedTasks, [cutoff], limit, batch.after),
  );
}
