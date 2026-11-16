// strategies-content's only route to programs-sites data: the custom image sizes legacy setImageURLs lists.
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/programs-sites.js';

type Schemas = components['schemas'];

/** A site custom image size as programs-sites lists it. */
export type SiteImageSize = Schemas['ImageSize'];

const SITES_SERVICE = 'programs-sites';

const LIST = {
  operationId: 'listSiteCustomImageSizes',
  method: 'GET',
  path: '/internal/v1/sites/{siteId}/image-sizes',
} as const satisfies { operationId: keyof operations; method: 'GET'; path: keyof paths };

const HTTP_OK = 200;

/** strategies-content's calls into programs-sites. */
export interface SitesClient {
  /**
   * `listSiteCustomImageSizes`: `getSite(siteId).getCustomImageSizeIterator()` in iterator order; called as this service.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  customImageSizes(siteId: string): Promise<SiteImageSize[]>;
}

/** Creates strategies-content's programs-sites client over its service client. */
export function createSitesClient(client: ServiceClient): SitesClient {
  return {
    async customImageSizes(siteId) {
      const response = await client.request<Schemas['ImageSizeList']>({
        service: SITES_SERVICE,
        method: LIST.method,
        path: LIST.path.replace('{siteId}', encodeURIComponent(siteId)),
        userToken: null,
      });
      if (response.status !== HTTP_OK) {
        const cause = Object.assign(new Error(`${SITES_SERVICE} ${LIST.operationId} answered HTTP ${response.status}`), {
          code: `HTTP_${response.status}`,
        });
        throw new ServiceUnavailableError(SITES_SERVICE, cause);
      }
      return response.body;
    },
  };
}
