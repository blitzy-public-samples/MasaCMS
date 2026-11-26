/** `lookupFileExtensions`: the `fileEXT` legacy `userDAO` and `userGateway` join from `tfiles` for user photo ids. */
import { AuthDenial, serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { awaitReadable, qualified } from '@opt2/platform/migration-kit';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { poolTenantFor, withMetadata, withTenant, type PoolKind, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';

type FileLookupRequest = components['schemas']['FileLookupRequest'];
type FileExtension = components['schemas']['FileExtension'];
type FileExtensionList = components['schemas']['FileExtensionList'];

/** The database the lookup reads. */
export interface FileLookupRouteDeps {
  db: TenantDb;
}

type FileRow = { fileid: string; fileext: string | null };

const LOOKUP_PATH = '/internal/v1/files::lookup';
const FILE_UNIT = 'content.file';
const FILE_TABLE = 'file';
const USER_POOLS: readonly PoolKind[] = ['publicUser', 'privateUser'];

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('people'), serviceRole('identity')]),
});

const lookupBodySchema = z.strictObject({
  fileIds: z
    .array(z.string().min(1).max(35))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
}) satisfies z.ZodType<FileLookupRequest>;

/** SQL Server's equality key of a char(35) id: trailing spaces and case ignored. */
function idKey(id: string): string {
  return id.replace(/ +$/, '').toUpperCase();
}

/** The file-pool tenants of the public and private user pools of `tenantId`, without repeats. */
function photoFileTenants(db: TenantDb, tenantId: string): Promise<string[]> {
  return withMetadata(db, async (tx) => {
    const tenants = new Set<string>();
    for (const kind of USER_POOLS) {
      const userPool = await poolTenantFor(tx, tenantId, kind);
      const filePool = userPool === null ? null : await poolTenantFor(tx, userPool, 'file');
      if (filePool !== null) tenants.add(filePool);
    }
    return [...tenants];
  });
}

/** The `fileid` and `fileext` of the rows of `tenantId`'s `content.file` that `candidates` name. */
function storedFiles(db: TenantDb, tenantId: string, candidates: readonly string[]): Promise<FileRow[]> {
  return withTenant(db, tenantId, async (tx) => {
    await awaitReadable(tx, [FILE_UNIT]);
    // Stored ids are single-case CF UUIDs, so the listed, upper- and lower-case forms compared as bpchar reproduce
    // SQL Server's case- and trailing-space-insensitive equality while the (tenant_id, fileid) key still applies.
    const { rows } = await tx.query<FileRow>(
      `SELECT fileid, fileext FROM ${qualified(tx.schema, FILE_TABLE)} WHERE fileid = ANY($1::bpchar[])`,
      [candidates],
    );
    return rows;
  });
}

/** The extension of each listed id that names a stored file in the photo file pools of `tenantId`, in listed order. */
async function lookupFileExtensions(db: TenantDb, tenantId: string, fileIds: readonly string[]): Promise<FileExtension[]> {
  const candidates = [...new Set(fileIds.flatMap((id) => [id, id.toUpperCase(), id.toLowerCase()]))];
  const found = new Map<string, string | null>();
  for (const tenant of await photoFileTenants(db, tenantId)) {
    for (const row of await storedFiles(db, tenant, candidates)) found.set(idKey(row.fileid), row.fileext);
  }
  return fileIds.flatMap((fileId) => {
    const key = idKey(fileId);
    return found.has(key) ? [{ fileId, fileExt: found.get(key) ?? null }] : [];
  });
}

/** Registers `lookupFileExtensions`, people's and identity's read of user photo file extensions. */
export async function registerFileLookupRoutes(app: FastifyInstance, deps: FileLookupRouteDeps): Promise<void> {
  const { db } = deps;

  app.post<{ Reply: FileExtensionList }>(LOOKUP_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const claims = request.opt2Auth.user;
    if (claims === undefined) {
      throw AuthDenial.unauthenticated('missing-credential');
    }
    const body = lookupBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new LegacyApiError('invalidParameters');
    }
    return { items: await lookupFileExtensions(db, claims.tid, body.data.fileIds) };
  });
}
