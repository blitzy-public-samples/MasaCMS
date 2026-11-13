/** `/internal/v1/migration/objects`: the migration service's transfer of legacy file-store objects into `content-files`, and its read of them back. */
import { Roles, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type Clock, type FastifyInstance } from '@opt2/platform/service-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { components, operations } from '../generated/openapi.js';
import {
  openMigrationObject,
  storeMigrationObject,
  type FileVariant,
  type MigrationObjectRequest,
  type StoreObjectDeps,
  type StoredObjectResult,
} from '../migration/objects.js';

type PutObjectQuery = operations['migrationPutObject']['parameters']['query'];
type GetObjectQuery = operations['migrationGetObject']['parameters']['query'];
type FileObject = components['schemas']['FileObject'];

/** The route context these routes read: a structural subset of `ContentRouteContext`, so this module needs nothing from the `routes/index.ts` that registers it. */
export interface MigrationObjectRouteContext {
  domain: Pick<StoreObjectDeps, 'db' | 'repository'>;
  storage: StoragePort;
  clock: Clock;
}

const OBJECTS_PATH = '/internal/v1/migration/objects';
const ROUTE: { opt2: Opt2RouteConfig } = { opt2: { transport: 'service', requires: [Roles.platformMigration] } };
const OCTET_STREAM = 'application/octet-stream';

// The contract's parameter patterns: a CF UUID file id, a variant suffix that cannot leave the key's directory, and the object key.
const CF_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;
const VARIANT = /^(_[^/\\\u0000-\u001F\u007F]+)?$/;
const OBJECT_KEY = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\/[A-Za-z0-9-]{35}(_[^/\\\u0000-\u001F\u007F]+)?\.[A-Za-z0-9]+$/;

const putQuerySchema = z.strictObject({
  tenantId: z.guid(),
  fileId: z.string().regex(CF_ID),
  variant: z.custom<FileVariant>((value) => typeof value === 'string' && VARIANT.test(value)),
  ext: z.string().regex(/^[^/\\]+$/),
  contentType: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}) satisfies z.ZodType<PutObjectQuery>;

const getQuerySchema = z.strictObject({ key: z.string().regex(OBJECT_KEY) }) satisfies z.ZodType<GetObjectQuery>;

/** The contract's `FileObject` of a stored object; the other result fields are the service's own. */
function fileObjectOf(stored: StoredObjectResult): FileObject {
  return { key: stored.key, size: stored.size, sha256: stored.sha256, created: stored.created };
}

/** Registers the `platform.migration` object upload and read of `content-files`. */
export function registerMigrationObjectRoutes(app: FastifyInstance, ctx: MigrationObjectRouteContext): void {
  const deps: StoreObjectDeps = { db: ctx.domain.db, repository: ctx.domain.repository, storage: ctx.storage, clock: ctx.clock };

  /** Stores the raw body as the object the query names, once per SHA-256. */
  app.post(OBJECTS_PATH, { config: ROUTE }, async (request): Promise<FileObject> => {
    const query = putQuerySchema.safeParse(request.query);
    if (!query.success || !Buffer.isBuffer(request.body)) throw new LegacyApiError('invalidParameters');
    const req: MigrationObjectRequest = { ...query.data, bytes: request.body };
    return fileObjectOf(await storeMigrationObject(deps, req));
  });

  // The reverse projection reads object bytes here: the export manifest carries no URL and signed downloads need a user token.
  /** Streams the stored bytes of the object under `key`; the legacy 404 envelope when the key's tenant records none. */
  app.get(OBJECTS_PATH, { config: ROUTE }, async (request, reply) => {
    const query = getQuerySchema.safeParse(request.query);
    if (!query.success) throw new LegacyApiError('invalidParameters');
    const opened = await openMigrationObject(deps, query.data.key);
    if (opened === null) {
      reply.callNotFound();
      return reply;
    }
    return reply.code(200).headers({ 'Content-Type': OCTET_STREAM, 'Content-Length': String(opened.head.size) }).send(opened.body);
  });
}
