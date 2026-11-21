// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
import { AuthDenial } from '@opt2/platform/auth';
import type { Clock, FastifyInstance } from '@opt2/platform/service-kit';
import {
  LOCAL_SIGNED_URL_PREFIX,
  StorageObjectNotFoundError,
  legacyHeaderValue,
  type LocalStorageAdapter,
  type OpenedObject,
} from '@opt2/platform/storage';
import { EXPORT_BUCKET } from '../repo/tables.js';

const EXPORT_FILE_ROUTE = `${LOCAL_SIGNED_URL_PREFIX}${EXPORT_BUCKET}/:tenantId/:objectName`;

/** The local storage adapter, which verifies the URLs it signs, and the clock verification reads. */
export interface ExportFileRouteDeps {
  storage: LocalStorageAdapter;
  clock: Clock;
}

interface ExportObjectParams {
  tenantId: string;
  objectName: string;
}

/** Registers `GET /opt2/files/reporting-exports/:tenantId/:objectName`, serving an export object to a valid local signed URL. */
export function registerExportFileRoute(app: FastifyInstance, deps: ExportFileRouteDeps): void {
  app.get<{ Params: ExportObjectParams }>(
    EXPORT_FILE_ROUTE,
    { config: { opt2: { public: true, transport: 'service' } } },
    async (request, reply) => {
      const { tenantId, objectName } = request.params;
      const verified = deps.storage.verifySignedUrl(request.url, deps.clock.now().getTime());
      if (!verified.ok || verified.bucket !== EXPORT_BUCKET || verified.key !== `${tenantId}/${objectName}`) {
        throw AuthDenial.forbidden(!verified.ok && verified.reason === 'expired' ? 'expired-credential' : 'invalid-credential');
      }
      // One open, not head then stream, so the length sent is that of the stored version whose bytes are streamed.
      let opened: OpenedObject;
      try {
        opened = await deps.storage.open(EXPORT_BUCKET, verified.key);
      } catch (err) {
        // The service's not-found handler answers the legacy 404 envelope.
        if (err instanceof StorageObjectNotFoundError) {
          reply.callNotFound();
          return reply;
        }
        throw err;
      }
      const headers: Record<string, string> = {};
      // Content-Disposition goes before Content-Length: Node re-decodes one that follows a known length (nodejs/node#46528).
      if (verified.disposition !== undefined) headers['Content-Disposition'] = legacyHeaderValue(verified.disposition);
      headers['Content-Length'] = String(opened.head.size);
      headers['Content-Type'] = legacyHeaderValue(opened.head.contentType);
      return reply.code(200).headers(headers).send(opened.body);
    },
  );
}
