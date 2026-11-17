// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `GET /internal/v1/migration/objects`: the migration service's read of one export job's output bytes from `reporting-exports`. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { StorageObjectNotFoundError, type OpenedObject, type StoragePort } from '@opt2/platform/storage';
import { isTenantId, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { operations } from '../generated/openapi.js';
import { findJobObjectKey } from '../repo/queries.js';
import { EXPORT_BUCKET } from '../repo/tables.js';

type GetExportObjectQuery = operations['migrationGetExportObject']['parameters']['query'];

/** What the route reads: the reporting tenant database and the export storage. */
export interface MigrationObjectRouteDeps {
  db: TenantDb;
  storage: StoragePort;
}

const OBJECTS_PATH = '/internal/v1/migration/objects';
const ROUTE: { opt2: Opt2RouteConfig } = { opt2: { transport: 'service', requires: [Roles.platformMigration] } };
const OCTET_STREAM = 'application/octet-stream';

const querySchema = z.strictObject({
  tenantId: z.string().refine(isTenantId),
  jobId: z.string().refine(isCfUuid),
}) satisfies z.ZodType<GetExportObjectQuery>;

/** The stored output object of the tenant's job, or undefined when the tenant has no such row, the row names no object, or storage holds none under its key. */
async function openExportObject(deps: MigrationObjectRouteDeps, tenantId: string, jobId: string): Promise<OpenedObject | undefined> {
  const key = await withTenant(deps.db, tenantId, (tx) => findJobObjectKey(tx, jobId));
  if (key === null) return undefined;
  try {
    return await deps.storage.open(EXPORT_BUCKET, key);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) return undefined;
    throw err;
  }
}

/** Registers the `platform.migration` read that streams one export job's stored output; the legacy 404 envelope when there is none. */
export function registerMigrationObjectRoute(app: FastifyInstance, deps: MigrationObjectRouteDeps): void {
  app.get(OBJECTS_PATH, { config: ROUTE }, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) throw new LegacyApiError('invalidParameters');
    const opened = await openExportObject(deps, query.data.tenantId, query.data.jobId);
    if (opened === undefined) {
      reply.callNotFound();
      return reply;
    }
    return reply.code(200).headers({ 'Content-Type': OCTET_STREAM, 'Content-Length': String(opened.head.size) }).send(opened.body);
  });
}
