// Identity's only route to strategies-content data: the file extensions of group member photos.
import { recordWritePositionsFrom, WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/strategies-content.js';

type Schemas = components['schemas'];

const CONTENT_SERVICE = 'strategies-content';

const LOOKUP = {
  operationId: 'lookupFileExtensions',
  method: 'POST',
  path: '/internal/v1/files:lookup',
} as const satisfies { operationId: keyof operations; method: 'POST'; path: keyof paths };

const HTTP_OK = 200;

/** Identity's calls into strategies-content. */
export interface ContentClient {
  /**
   * `lookupFileExtensions`: the `fileEXT` (null when NULL) of each listed id naming a stored file, keyed by the id as listed; blank ids are skipped, and none left makes no call.
   * @throws ServiceUnavailableError When strategies-content answers anything but 200.
   */
  photoFileExts(fileIds: readonly (string | null)[]): Promise<Map<string, string | null>>;
}

/** Creates identity's strategies-content client over its service client. */
export function createContentClient(client: ServiceClient): ContentClient {
  return {
    async photoFileExts(fileIds) {
      const extensions = new Map<string, string | null>();
      // SQL Server's char equality ignores trailing spaces, so an all-space id matches no stored CF UUID.
      const ids = fileIds.filter((id): id is string => id !== null && id.replace(/ +$/, '') !== '');
      const lookup: Schemas['FileLookupRequest'] = { fileIds: [...new Set(ids)] };
      if (lookup.fileIds.length === 0) return extensions;
      const response = await client.request<Schemas['FileExtensionList']>({
        service: CONTENT_SERVICE,
        method: LOOKUP.method,
        path: LOOKUP.path,
        json: lookup,
      });
      recordWritePositionsFrom(response.headers[WRITE_POSITION_HEADER_LC]);
      if (response.status !== HTTP_OK) {
        const cause = Object.assign(new Error(`${CONTENT_SERVICE} ${LOOKUP.operationId} answered HTTP ${response.status}`), {
          code: `HTTP_${response.status}`,
        });
        throw new ServiceUnavailableError(CONTENT_SERVICE, cause);
      }
      for (const { fileId, fileExt } of response.body.items) extensions.set(fileId, fileExt);
      return extensions;
    },
  };
}
