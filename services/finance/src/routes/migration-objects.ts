// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `GET /internal/v1/migration/objects`: the migration service's read of one attachment's bytes from `finance-attachments`. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { StorageObjectNotFoundError, type OpenedObject, type StoragePort } from '@opt2/platform/storage';
import { isTenantId, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { operations } from '../generated/openapi.js';
import { findAttachmentObjectKey } from '../repo/queries.js';
import { ATTACHMENT_BUCKET } from '../repo/tables.js';

type GetAttachmentObjectQuery = operations['migrationGetAttachmentObject']['parameters']['query'];

/** What the route reads: the finance tenant database and the attachment storage. */
export interface MigrationObjectRouteDeps {
  db: TenantDb;
  storage: StoragePort;
}

const OBJECTS_PATH = '/internal/v1/migration/objects';
const ROUTE: { opt2: Opt2RouteConfig } = { opt2: { transport: 'service', requires: [Roles.platformMigration] } };
const OCTET_STREAM = 'application/octet-stream';

const querySchema = z.strictObject({
  tenantId: z.string().refine(isTenantId),
  attachmentId: z.string().refine(isCfUuid),
}) satisfies z.ZodType<GetAttachmentObjectQuery>;

/** The stored object of the tenant's attachment, or undefined when the tenant has no such row or storage holds no object under its key. */
async function openAttachmentObject(deps: MigrationObjectRouteDeps, tenantId: string, attachmentId: string): Promise<OpenedObject | undefined> {
  // Migration reads pass any gate state: the projector reads while a window or transition holds the unit's gate.
  const key = await withTenant(deps.db, tenantId, (tx) => findAttachmentObjectKey(tx, attachmentId));
  if (key === null) return undefined;
  try {
    return await deps.storage.open(ATTACHMENT_BUCKET, key);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) return undefined;
    throw err;
  }
}

/** Registers the `platform.migration` read that streams one attachment's stored bytes; the legacy 404 envelope when there are none. */
export function registerMigrationObjectRoute(app: FastifyInstance, deps: MigrationObjectRouteDeps): void {
  app.get(OBJECTS_PATH, { config: ROUTE }, async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) throw new LegacyApiError('invalidParameters');
    const opened = await openAttachmentObject(deps, query.data.tenantId, query.data.attachmentId);
    if (opened === undefined) {
      reply.callNotFound();
      return reply;
    }
    return reply.code(200).headers({ 'Content-Type': OCTET_STREAM, 'Content-Length': String(opened.head.size) }).send(opened.body);
  });
}
