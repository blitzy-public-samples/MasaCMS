// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `listScheduledTasks`: surveys' read of the launch and reminder tasks communications scheduled for one source. */
import { AuthDenial, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, cfDateTimeFormat } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components, operations } from '../generated/openapi.js';
import { listScheduledTasksBySource } from '../repo/queries.js';
import type { ScheduledTaskRow } from '../repo/tables.js';

type ScheduledTask = components['schemas']['ScheduledTask'];
type ScheduledTaskList = components['schemas']['ScheduledTaskList'];
type ListQuery = operations['listScheduledTasks']['parameters']['query'];

// Declared here rather than imported from the route registry, which imports this module; the registry's context stays assignable.
/** The database the listing reads. */
export interface ScheduledTaskRouteDeps {
  db: TenantDb;
}

/** Fastify path of `listScheduledTasks`. */
export const SCHEDULED_TASKS_PATH = '/internal/v1/scheduled-tasks';

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('surveys')]),
});

// The contract's `LocalTimestamp`: wall-clock time in the legacy server's zone, to the millisecond, without an offset.
const LOCAL_TIMESTAMP_MASK = "yyyy-mm-dd'T'HH:nn:ss.lll";
const CF_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;

const listQuerySchema = z.object({
  sourceType: z.enum(['survey']),
  sourceId: z.string().regex(CF_UUID),
}) satisfies z.ZodType<ListQuery>;

/** One stored task as the contract's `ScheduledTask`, without tenant, ids or queue stamps. */
export function toScheduledTask(row: ScheduledTaskRow): ScheduledTask {
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

/** The source's current-version tasks as `ScheduledTaskList`, in the rows' order; `scheduleVersion` is null without rows. */
export function toScheduledTaskList(source: ListQuery, rows: readonly ScheduledTaskRow[]): ScheduledTaskList {
  return {
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    scheduleVersion: rows[0]?.schedule_version ?? null,
    items: rows.map(toScheduledTask),
  };
}

/** Registers `listScheduledTasks`, callable only by surveys with the end user's token, whose tenant it reads. */
export async function registerScheduledTaskRoutes(app: FastifyInstance, deps: ScheduledTaskRouteDeps): Promise<void> {
  const { db } = deps;

  app.get<{ Reply: ScheduledTaskList }>(SCHEDULED_TASKS_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    // The tenant comes only from the forwarded user token; the invocation credential alone names no tenant.
    const { tenantId } = request.opt2;
    if (tenantId === undefined) {
      throw AuthDenial.unauthenticated('missing-credential');
    }
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      throw new LegacyApiError('invalidParameters');
    }
    const rows = await withTenant(db, tenantId, (tx) => listScheduledTasksBySource(tx, query.data));
    return toScheduledTaskList(query.data, rows);
  });
}
