/** Signed downloads of `content-files` objects: `getFileDownloadUrl` issues them, `getLocalContentFile` serves the local adapter's. */
import { AuthDenial, Roles, moduleRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, isCfUuid } from '@opt2/platform/legacy-compat';
import { z, type Clock, type FastifyInstance, type FastifyReply } from '@opt2/platform/service-kit';
import {
  LOCAL_SIGNED_URL_PREFIX,
  SIGNED_URL_TTL_S,
  StorageObjectNotFoundError,
  contentFileKey,
  legacyHeaderValue,
  type ContentFileVariant,
  type LocalStorageAdapter,
  type OpenedObject,
  type StoragePort,
} from '@opt2/platform/storage';
import type { DomainDeps } from '../domain/context.js';
import { withPoolTenant } from '../domain/pools.js';
import type { components, operations } from '../generated/openapi.js';
import { CONTENT_FILES_BUCKET } from '../migration/objects.js';

/** The route context these routes read: a structural subset of `ContentRouteContext`, so this module needs nothing from the `routes/index.ts` that registers it. */
export interface FileRouteContext {
  domain: Pick<DomainDeps, 'db' | 'repository'>;
  storage: StoragePort;
  clock: Clock;
}

/** The contract's `SignedUrl`: a URL valid for `SIGNED_URL_TTL_S` seconds and the instant it expires. */
export type SignedUrl = components['schemas']['SignedUrl'];

type DownloadUrlQuery = NonNullable<operations['getFileDownloadUrl']['parameters']['query']>;

/** The object a download signs and its Content-Disposition; `fileName` alone gives the contract's default `attachment`. */
export interface ContentDownload {
  objectKey: string;
  fileName?: string;
  disposition?: string;
}

/** Content-Disposition type of a download. */
export type DownloadMethod = NonNullable<DownloadUrlQuery['method']>;

const DOWNLOAD_URL_PATH = '/v1/sites/:siteid/files/:fileid/download-url';
const LOCAL_FILE_PATH = `${LOCAL_SIGNED_URL_PREFIX}${CONTENT_FILES_BUCKET}/:tenantId/:objectName`;
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';

// The legacy file entity's read gate (x-opt2-entity-access `file`); the auth preHandler compares `siteid` with the token's site.
const DOWNLOAD_AUTH: { opt2: Opt2RouteConfig } = {
  opt2: { transport: 'service', requires: [Roles.s2, Roles.siteAdmin, moduleRole(SITE_MANAGER_MODULE_ID)] },
};
// The HMAC over bucket, key, expiry and disposition is the credential.
const LOCAL_FILE_AUTH: { opt2: Opt2RouteConfig } = { opt2: { transport: 'service', public: true } };

const VARIANT = /^(_[^/\\\u0000-\u001F\u007F]+)?$/;

const downloadQuerySchema = z.object({
  variant: z.custom<ContentFileVariant>((value) => typeof value === 'string' && VARIANT.test(value)).default(''),
  method: z.enum(['inline', 'attachment']).default('attachment'),
}) satisfies z.ZodType<DownloadUrlQuery>;

/** fileManager.streamFile's Content-Disposition `<method>;filename="<fileName>"`; a video content type forces `attachment`. */
export function contentDisposition(method: DownloadMethod, fileName: string, contentType = ''): string {
  return `${/video/i.test(contentType) ? 'attachment' : method};filename="${fileName}"`;
}

/** Signs a `content-files` download valid for `SIGNED_URL_TTL_S` seconds. */
export async function signContentDownload(ctx: Pick<FileRouteContext, 'storage' | 'clock'>, download: ContentDownload): Promise<SignedUrl> {
  // Read before signing and truncated to the second, so the reported expiry is never later than the one the adapter signs.
  const issuedS = Math.floor(ctx.clock.now().getTime() / 1000);
  const disposition =
    download.disposition ?? (download.fileName === undefined ? undefined : contentDisposition('attachment', download.fileName));
  const url = await ctx.storage.signedUrl(CONTENT_FILES_BUCKET, download.objectKey, {
    expiresS: SIGNED_URL_TTL_S,
    ...(disposition === undefined ? {} : { disposition }),
  });
  return { url, expiresAt: new Date((issuedS + SIGNED_URL_TTL_S) * 1000).toISOString() };
}

/** The local adapter, the only storage port whose signed URLs this service verifies and serves. */
function isLocalStorage(storage: StoragePort): storage is LocalStorageAdapter {
  return storage.kind === 'local' && 'verifySignedUrl' in storage && typeof storage.verifySignedUrl === 'function';
}

/** The legacy 404 envelope of the service's not-found handler. */
function notFound(reply: FastifyReply): FastifyReply {
  reply.callNotFound();
  return reply;
}

/** Registers `getFileDownloadUrl` and `getLocalContentFile`. */
export function registerFileRoutes(app: FastifyInstance, ctx: FileRouteContext): void {
  const { domain, storage, clock } = ctx;

  /** The signed URL of the file's original or `variant` rendition, read in the token tenant's file pool; 404 when either is not stored. */
  app.get<{ Params: { siteid: string; fileid: string } }>(DOWNLOAD_URL_PATH, { config: DOWNLOAD_AUTH }, async (request, reply) => {
    const claims = request.opt2Auth.user;
    if (claims === undefined) throw AuthDenial.unauthenticated('missing-credential');
    const query = downloadQuerySchema.safeParse(request.query);
    if (!query.success) throw new LegacyApiError('invalidParameters');
    const { fileid } = request.params;
    if (!isCfUuid(fileid)) return notFound(reply);

    const file = await withPoolTenant(domain.db, claims.tid, 'file', async (tx, poolTenantId) => {
      const row = await domain.repository.files.readFileMeta(tx, fileid);
      return row === null ? null : { row, poolTenantId };
    });
    if (file === null) return notFound(reply);

    const { row, poolTenantId } = file;
    // Keyed by the requested id and the stored extension, as renderFile builds the file path.
    const objectKey = contentFileKey({ tenantId: poolTenantId, fileId: fileid, variant: query.data.variant, ext: row.fileext ?? '' });
    if ((await storage.head(CONTENT_FILES_BUCKET, objectKey)) === null) return notFound(reply);

    const contentType = `${row.contenttype ?? ''}/${row.contentsubtype ?? ''}`;
    return signContentDownload(ctx, {
      objectKey,
      disposition: contentDisposition(query.data.method, row.filename ?? '', contentType),
    });
  });

  /** Streams the object a valid local signed URL names; 403 for a malformed, wrong or expired signature, 404 when nothing is stored. */
  app.get<{ Params: { tenantId: string; objectName: string } }>(LOCAL_FILE_PATH, { config: LOCAL_FILE_AUTH }, async (request, reply) => {
    // Cloud signed URLs address Cloud Storage directly.
    if (!isLocalStorage(storage)) return notFound(reply);
    const { tenantId, objectName } = request.params;
    const verified = storage.verifySignedUrl(request.url, clock.now().getTime());
    if (!verified.ok || verified.bucket !== CONTENT_FILES_BUCKET || verified.key !== `${tenantId}/${objectName}`) {
      throw AuthDenial.forbidden(!verified.ok && verified.reason === 'expired' ? 'expired-credential' : 'invalid-credential');
    }
    // One open, not head then stream, so the length sent is that of the stored version whose bytes are streamed.
    let opened: OpenedObject;
    try {
      opened = await storage.open(CONTENT_FILES_BUCKET, verified.key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) return notFound(reply);
      throw err;
    }
    const headers: Record<string, string> = {};
    // Content-Disposition goes before Content-Length: Node re-decodes one that follows a known length (nodejs/node#46528).
    if (verified.disposition !== undefined) headers['Content-Disposition'] = legacyHeaderValue(verified.disposition);
    headers['Content-Length'] = String(opened.head.size);
    headers['Content-Type'] = legacyHeaderValue(opened.head.contentType);
    return reply.code(200).headers(headers).send(opened.body);
  });
}
