// People's only route to strategies-content data: the file extensions of user photos.
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

/** People's calls into strategies-content. */
export interface ContentClient {
  /** `lookupFileExtensions`: the extension of each listed photo file, keyed by the id as listed; empty ids make no call. */
  photoFileExts(fileIds: readonly (string | null | undefined)[]): Promise<Map<string, string>>;
  /** The `photoFileExt` legacy `userDAO.read` joins: `''` for no photo id or an id that names no stored file. */
  photoFileExt(fileId: string | null | undefined): Promise<string>;
}

/** Creates people's strategies-content client over its service client. */
export function createContentClient(client: ServiceClient): ContentClient {
  async function photoFileExts(fileIds: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const extensions = new Map<string, string>();
    const ids = fileIds.filter((id): id is string => typeof id === 'string' && id !== '');
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
        code: `HTTP_${String(response.status)}`,
      });
      throw new ServiceUnavailableError(CONTENT_SERVICE, cause);
    }
    // Legacy's query reads a NULL fileEXT as ''.
    for (const { fileId, fileExt } of response.body.items) extensions.set(fileId, fileExt ?? '');
    return extensions;
  }

  return {
    photoFileExts,

    async photoFileExt(fileId) {
      return (await photoFileExts([fileId])).get(fileId ?? '') ?? '';
    },
  };
}
