// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listScheduledTasks`: surveys' read of the launch and reminder tasks communications scheduled for one source. */
import type { Readable } from 'node:stream';
import { AuthDenial, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { JSON_CONTENT_TYPE, jsonListStream, z, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components, operations } from '../generated/openapi.js';
import {
  listScheduledTaskPage,
  type ScheduledTaskPage,
  type ScheduledTaskPageKey,
  type ScheduledTaskSource,
  type ScheduledTaskViewRow,
} from '../repo/queries.js';
import { SCHEDULED_TASK_KINDS } from '../repo/tables.js';
import { taskNameSchema } from './adoption.js';

type ScheduledTask = components['schemas']['ScheduledTask'];
type ScheduledTaskList = components['schemas']['ScheduledTaskList'];
type ListQuery = operations['listScheduledTasks']['parameters']['query'];

/** The query as Fastify parses it: a parameter sent once is a string, one sent repeatedly an array. */
type WireQuery = Omit<ListQuery, 'taskName'> & { taskName?: string | string[] };

/** The validated query: the source, the page asked for when `limit` or `after` was sent, and the task names asked for. */
type ListRequest = Pick<ListQuery, 'sourceType' | 'sourceId'> & { limit?: number; after?: ScheduledTaskPageKey; taskName?: string[] };

// Declared here rather than imported from the route registry, which imports this module; the registry's context stays assignable.
/** The database the listing reads. */
export interface ScheduledTaskRouteDeps {
  db: TenantDb;
}

/** Fastify path of `listScheduledTasks`. */
export const SCHEDULED_TASKS_PATH = '/internal/v1/scheduled-tasks';

/** Tasks a page holds when the caller sends `after` without `limit`. */
export const SCHEDULED_TASK_PAGE_SIZE = 100;

/** Largest `limit`, and the batch size the unpaged list is read in. */
export const MAX_SCHEDULED_TASK_PAGE_SIZE = 1000;

/** Most `taskName` values one list call names. */
export const MAX_TASK_NAMES = 100;

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('surveys')]),
});

// The contract's `LocalTimestamp`: wall-clock time in the legacy server's zone, to the millisecond, without an offset.
const LOCAL_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";
const CF_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;
const DIGITS = /^[1-9][0-9]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// The milliseconds of a PostgreSQL timestamp a JavaScript date can hold, from 4714-11-24 BC.
const timestampMs = z.int().min(-210_866_803_200_000).max(8_640_000_000_000_000);

const pageKeySchema = z.strictObject({
  version: z.int().min(1),
  at: timestampMs.transform((ms) => new Date(ms)),
  kind: z.enum(SCHEDULED_TASK_KINDS),
  n: z.int().min(1).nullable(),
  id: z.string().regex(CF_UUID),
}) satisfies z.ZodType<ScheduledTaskPageKey>;

/** The opaque `next` of a page key: base64url JSON, the schedule time in epoch milliseconds. */
export function encodePageKey(key: ScheduledTaskPageKey): string {
  return Buffer.from(JSON.stringify({ ...key, at: key.at.getTime() }), 'utf8').toString('base64url');
}

/** The JSON a base64url cursor carries; undefined when it carries none, which the page key schema refuses. */
function cursorJson(text: string): unknown {
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

const listQuerySchema = z.object({
  sourceType: z.enum(['survey']),
  sourceId: z.string().regex(CF_UUID),
  limit: z.string().regex(DIGITS).transform(Number).pipe(z.int().max(MAX_SCHEDULED_TASK_PAGE_SIZE)).optional(),
  after: z.string().regex(BASE64URL).transform(cursorJson).pipe(pageKeySchema).optional(),
  taskName: z.union([taskNameSchema.transform((name) => [name]), z.array(taskNameSchema).max(MAX_TASK_NAMES)]).optional(),
}) satisfies z.ZodType<ListRequest, WireQuery>;

/** One stored task as the contract's `ScheduledTask`, without tenant, ids or queue stamps. */
export function toScheduledTask(row: ScheduledTaskViewRow): ScheduledTask {
  return {
    taskName: row.task_name,
    kind: row.kind,
    n: row.reminder_n,
    targetRoute: row.target_route,
    scheduleTime: cfDateTimeFormat(row.schedule_time, LOCAL_TIMESTAMP_MASK),
    status: row.status,
    scheduleVersion: row.schedule_version,
    queue: row.queue,
  };
}

/** The source's current-version tasks as `ScheduledTaskList`, in the rows' order; `scheduleVersion` is the rows', else `after`'s, else null. */
export function toScheduledTaskList(request: ListRequest, rows: readonly ScheduledTaskViewRow[], next: string | null): ScheduledTaskList {
  return {
    sourceType: request.sourceType,
    sourceId: request.sourceId,
    scheduleVersion: rows[0]?.schedule_version ?? request.after?.version ?? null,
    items: rows.map(toScheduledTask),
    next,
  };
}

/** The tasks of `first` and of every page after it, each later page read in its own tenant transaction on `first`'s schedule version. */
async function* taskBatches(
  db: TenantDb,
  tenantId: string,
  source: ScheduledTaskSource,
  taskNames: readonly string[] | undefined,
  first: ScheduledTaskPage,
): AsyncGenerator<ScheduledTask[]> {
  let page = first;
  yield page.rows.map(toScheduledTask);
  while (page.next !== null) {
    const after = page.next;
    page = await withTenant(db, tenantId, (tx) => listScheduledTaskPage(tx, source, { limit: MAX_SCHEDULED_TASK_PAGE_SIZE, after, taskNames }));
    yield page.rows.map(toScheduledTask);
  }
}

/** Registers `listScheduledTasks`, callable only by surveys with the end user's token, whose tenant it reads. */
export async function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): Promise<void> {
  const { db } = deps;

  app.get<{ Reply: ScheduledTaskList | Readable }>(SCHEDULED_TASKS_PATH, { config: { opt2: ROUTE_AUTH } }, async (request, reply) => {
    // The tenant comes only from the forwarded user token; the invocation credential alone names no tenant.
    const { tenantId } = request.opt2;
    if (tenantId === undefined) {
      throw AuthDenial.unauthenticated('missing-credential');
    }
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new LegacyApiError('invalidParameters');
    }
    const { limit, after, taskName: taskNames, ...source } = query.data;
    if (limit === undefined && after === undefined) {
      // The first batch is read before the answer starts, so its failures answer as errors; the rest stream as the reader takes them.
      const first = await withTenant(db, tenantId, (tx) =>
        listScheduledTaskPage(tx, source, { limit: MAX_SCHEDULED_TASK_PAGE_SIZE, taskNames }),
      );
      const head = { sourceType: source.sourceType, sourceId: source.sourceId, scheduleVersion: first.rows[0]?.schedule_version ?? null };
      const batches = taskBatches(db, tenantId, source, taskNames, first);
      return reply.type(JSON_CONTENT_TYPE).send(jsonListStream(head, 'items', batches, { next: null }));
    }
    const page = await withTenant(db, tenantId, (tx) =>
      listScheduledTaskPage(tx, source, { limit: limit ?? SCHEDULED_TASK_PAGE_SIZE, after, taskNames }),
    );
    return toScheduledTaskList(query.data, page.rows, page.next === null ? null : encodePageKey(page.next));
  });
}
