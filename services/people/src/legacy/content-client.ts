// People's only route to strategies-content data: the file extensions of user photos and the links of favorites.
import { recordWritePositionsFrom, WRITE_POSITION_HEADER_LC } from '@opt2/platform/migration-kit';
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/strategies-content.js';

type Schemas = components['schemas'];

const CONTENT_SERVICE = 'strategies-content';

type ContentOperation = { operationId: keyof operations; method: 'POST'; path: keyof paths };

const LOOKUP = {
  operationId: 'lookupFileExtensions',
  method: 'POST',
  path: '/internal/v1/files:lookup',
} as const satisfies ContentOperation;

const LINKS = {
  operationId: 'lookupContentLinks',
  method: 'POST',
  path: '/internal/v1/content:links',
} as const satisfies ContentOperation;

const HTTP_OK = 200;

/** Options of one strategies-content call; `timeoutMs` bounds it instead of the service client's timeout. */
export interface ContentCallOptions {
  timeoutMs?: number;
}

/** People's calls into strategies-content. */
export interface ContentClient {
  /** `lookupFileExtensions`: the extension of each listed photo file, keyed by the id as listed; empty ids make no call. */
  photoFileExts(fileIds: readonly (string | null | undefined)[], options?: ContentCallOptions): Promise<Map<string, string>>;
  /** The `photoFileExt` legacy `userDAO.read` joins: `''` for no photo id or an id that names no stored file. */
  photoFileExt(fileId: string | null | undefined): Promise<string>;
  /** `lookupContentLinks`: the `createHref` link of each listed content id of `siteId`, keyed by the id as listed. */
  contentLinks(siteId: string, contentIds: readonly string[]): Promise<Map<string, string>>;
}

/** Creates people's strategies-content client over its service client. */
export function createContentClient(client: ServiceClient): ContentClient {
  /** Posts `json` to `operation` and records the answer's write positions; any status but 200 fails closed. */
  async function post<T>(operation: ContentOperation, json: unknown, call: ContentCallOptions & { userToken?: null } = {}): Promise<T> {
    const response = await client.request<T>({
      service: CONTENT_SERVICE,
      method: operation.method,
      path: operation.path,
      json,
      ...(call.userToken === undefined ? {} : { userToken: call.userToken }),
      ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
    });
    recordWritePositionsFrom(response.headers[WRITE_POSITION_HEADER_LC]);
    if (response.status !== HTTP_OK) {
      const cause = Object.assign(new Error(`${CONTENT_SERVICE} ${operation.operationId} answered HTTP ${String(response.status)}`), {
        code: `HTTP_${String(response.status)}`,
      });
      throw new ServiceUnavailableError(CONTENT_SERVICE, cause);
    }
    return response.body;
  }

  async function photoFileExts(fileIds: readonly (string | null | undefined)[], options?: ContentCallOptions): Promise<Map<string, string>> {
    const extensions = new Map<string, string>();
    const ids = fileIds.filter((id): id is string => typeof id === 'string' && id !== '');
    const lookup: Schemas['FileLookupRequest'] = { fileIds: [...new Set(ids)] };
    if (lookup.fileIds.length === 0) return extensions;
    const found = await post<Schemas['FileExtensionList']>(LOOKUP, lookup, options);
    // Legacy's query reads a NULL fileEXT as ''.
    for (const { fileId, fileExt } of found.items) extensions.set(fileId, fileExt ?? '');
    return extensions;
  }

  return {
    photoFileExts,

    async photoFileExt(fileId) {
      return (await photoFileExts([fileId])).get(fileId ?? '') ?? '';
    },

    async contentLinks(siteId, contentIds) {
      const lookup: Schemas['ContentLinkRequest'] = { siteId, contentIds: [...new Set(contentIds)] };
      // The favorites templates act for no user, so a user token the gateway attached is not forwarded.
      const found = await post<Schemas['ContentLinkList']>(LINKS, lookup, { userToken: null });
      return new Map(found.items.map(({ contentId, href }) => [contentId, href]));
    },
  };
}
