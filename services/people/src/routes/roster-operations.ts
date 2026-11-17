// The operator's lists of the roster operations recovery halted, which parity replay records on the exceptions list.
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { listHaltedOperations, type HaltedOperation, type RecoveryDeps } from '../domain/roster-recovery.js';
import type { components, operations } from '../generated/openapi.js';
import type { HaltedRosterCursor } from '../repo/repository.js';

type HaltedRosterOperations = components['schemas']['HaltedRosterOperations'];
type HaltedRosterOperationsPage = components['schemas']['HaltedRosterOperationsPage'];
type HaltedRosterOperation = components['schemas']['HaltedRosterOperation'];
type HaltedRosterQuery = NonNullable<operations['listHaltedRosterOperationsPage']['parameters']['query']>;

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([Roles.platformMigration, Roles.platformOperator]),
});

/** Operations per page when the request names no `limit`. */
const HALTED_PAGE_DEFAULT_LIMIT = 100;
/** The most operations one page returns. */
const HALTED_PAGE_MAX_LIMIT = 1000;

// The listHaltedRosterOperationsPage query as the contract declares it; Fastify validates it once, before the handler.
const HALTED_QUERY = {
  type: 'object',
  properties: {
    after: { type: 'string', minLength: 1, maxLength: 256 },
    limit: { type: 'integer', minimum: 1, maximum: HALTED_PAGE_MAX_LIMIT },
  },
} as const;

const cursorSchema = z.strictObject({ startedAt: z.iso.datetime(), operationId: z.string().min(1).max(35) });

/** The opaque `next` of a page: unpadded base64url of the JSON start time and id of its last operation. */
function encodeCursor(cursor: HaltedRosterCursor): string {
  const json = JSON.stringify({ startedAt: cursor.startedAt.toISOString(), operationId: cursor.operationId });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** The position `after` names; throws the legacy `invalidParameters` error unless it is a `next` this route issued. */
function decodeCursor(after: string): HaltedRosterCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
  } catch {
    throw new LegacyApiError('invalidParameters');
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw new LegacyApiError('invalidParameters');
  return { startedAt: new Date(parsed.data.startedAt), operationId: parsed.data.operationId };
}

/** The contract's `HaltedRosterOperation` of `operation`. */
function haltedItem(operation: HaltedOperation): HaltedRosterOperation {
  return {
    operationId: operation.operationId,
    tenantId: operation.tenantId,
    userId: operation.userId,
    kind: operation.kind,
    state: operation.state,
    startedAt: operation.startedAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    haltedAt: operation.haltedAt.toISOString(),
    identityUnreachableSince: operation.identityUnreachableSince?.toISOString() ?? null,
    units: [...operation.units],
  };
}

/** Registers `listHaltedRosterOperations` and `listHaltedRosterOperationsPage` as the people contract declares them. */
export async function registerRosterOperationRoutes(app: FastifyInstance, deps: Pick<RecoveryDeps, 'db' | 'repo'>): Promise<void> {
  app.get('/internal/v1/roster-operations/halted', { config: { opt2: ROUTE_AUTH } }, async (): Promise<HaltedRosterOperations> => {
    const operations: HaltedRosterOperation[] = [];
    let after: HaltedRosterCursor | null = null;
    do {
      const page = await listHaltedOperations(deps, { after, limit: HALTED_PAGE_MAX_LIMIT });
      operations.push(...page.rows.map(haltedItem));
      after = page.next;
    } while (after !== null);
    return { operations };
  });

  app.get<{ Querystring: HaltedRosterQuery }>(
    '/internal/v2/roster-operations/halted',
    { schema: { querystring: HALTED_QUERY }, config: { opt2: ROUTE_AUTH } },
    async (request): Promise<HaltedRosterOperationsPage> => {
      const { after, limit = HALTED_PAGE_DEFAULT_LIMIT } = request.query;
      const page = await listHaltedOperations(deps, { after: after === undefined ? null : decodeCursor(after), limit });
      return { operations: page.rows.map(haltedItem), next: page.next === null ? null : encodeCursor(page.next) };
    },
  );
}
