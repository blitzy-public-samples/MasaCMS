// strategies-content's only route to programs-sites data: the custom image sizes legacy setImageURLs lists, the site
// settings legacy RSS feeds read through getSite, the `$.siteConfig` flags the Site Manager views test, and the site
// values the JSON API's `site` relations answer.
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/programs-sites.js';

type Schemas = components['schemas'];

/** A site custom image size as programs-sites lists it. */
export type SiteImageSize = Schemas['ImageSize'];

/** A site's RSS settings as programs-sites resolves them. */
export type SiteFeedSettings = Schemas['SiteFeedSettings'];

/** The values the JSON API's findOne of the `site` entity answers. */
export type SiteJsonApiValues = Schemas['JsonApiSite'];

/** A site's `$.siteConfig` flags as programs-sites resolves them. */
export type SiteConfigFlags = Schemas['SiteConfigFlags'];

const SITES_SERVICE = 'programs-sites';

type Operation = { operationId: keyof operations; method: 'GET' | 'POST'; path: keyof paths };

const LIST = {
  operationId: 'listSiteCustomImageSizes',
  method: 'GET',
  path: '/internal/v1/sites/{siteId}/image-sizes',
} as const satisfies Operation;

const LOOKUP = {
  operationId: 'lookupSiteFeedSettings',
  method: 'POST',
  path: '/internal/v1/sites/feed-settings:lookup',
} as const satisfies Operation;

const CONFIG_FLAGS_LOOKUP = {
  operationId: 'lookupSiteConfigFlags',
  method: 'POST',
  path: '/internal/v1/sites/config-flags:lookup',
} as const satisfies Operation;

const JSON_API_LOOKUP = {
  operationId: 'lookupSiteJsonApiValues',
  method: 'POST',
  path: '/internal/v1/sites/json-api-values:lookup',
} as const satisfies Operation;

const HTTP_OK = 200;

/** strategies-content's calls into programs-sites. */
export interface SitesClient {
  /**
   * `listSiteCustomImageSizes`: `getSite(siteId).getCustomImageSizeIterator()` in iterator order; called as this service.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  customImageSizes(siteId: string): Promise<SiteImageSize[]>;
  /**
   * `lookupSiteFeedSettings`: the settings `getSite` resolves for each id, in the order listed; the service calls as itself.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  feedSettings(siteIds: readonly string[]): Promise<SiteFeedSettings[]>;
  /**
   * `lookupSiteConfigFlags`: the flags `getSite` resolves for each id, in the order listed; the service calls as itself.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  configFlags(siteIds: readonly string[]): Promise<SiteConfigFlags[]>;
  /**
   * `lookupSiteJsonApiValues`: the `site` findOne values for each id under the JSON API endpoint `baseUrl`, in the order
   * listed; the service calls as itself.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  jsonApiValues(baseUrl: string, siteIds: readonly string[]): Promise<SiteJsonApiValues[]>;
}

/** Creates strategies-content's programs-sites client over its service client. */
export function createSitesClient(client: ServiceClient): SitesClient {
  /** The answer's body, or the legacy 503 for any other status than 200. */
  async function call<T>(op: Operation, path: string, json?: object): Promise<T> {
    const response = await client.request<T>({ service: SITES_SERVICE, method: op.method, path, ...(json === undefined ? {} : { json }), userToken: null });
    if (response.status !== HTTP_OK) {
      const cause = Object.assign(new Error(`${SITES_SERVICE} ${op.operationId} answered HTTP ${response.status}`), {
        code: `HTTP_${response.status}`,
      });
      throw new ServiceUnavailableError(SITES_SERVICE, cause);
    }
    return response.body;
  }

  return {
    customImageSizes(siteId) {
      return call<Schemas['ImageSizeList']>(LIST, LIST.path.replace('{siteId}', encodeURIComponent(siteId)));
    },
    async feedSettings(siteIds) {
      const body: Schemas['SiteFeedSettingsLookup'] = { siteIds: [...siteIds] };
      return (await call<{ items: SiteFeedSettings[] }>(LOOKUP, LOOKUP.path, body)).items;
    },
    async configFlags(siteIds) {
      const body: Schemas['SiteConfigFlagsLookup'] = { siteIds: [...siteIds] };
      return (await call<Schemas['SiteConfigFlagsList']>(CONFIG_FLAGS_LOOKUP, CONFIG_FLAGS_LOOKUP.path, body)).items;
    },
    async jsonApiValues(baseUrl, siteIds) {
      const body: Schemas['SiteJsonApiValuesLookup'] = { baseUrl, siteIds: [...siteIds] };
      return (await call<{ items: SiteJsonApiValues[] }>(JSON_API_LOOKUP, JSON_API_LOOKUP.path, body)).items;
    },
  };
}
