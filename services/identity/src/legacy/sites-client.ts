// Identity's only route to programs-sites data: the site settings legacy login mail reads through getSite.
import { ServiceUnavailableError, type ServiceClient } from '@opt2/platform/service-kit';
import type { components, operations, paths } from '../generated/clients/programs-sites.js';

type Schemas = components['schemas'];

/** A site's login-mail settings as programs-sites resolves them. */
export type SiteMailSettings = Schemas['SiteMailSettings'];

const SITES_SERVICE = 'programs-sites';

const LOOKUP = {
  operationId: 'lookupSiteMailSettings',
  method: 'POST',
  path: '/internal/v1/sites/mail-settings:lookup',
} as const satisfies { operationId: keyof operations; method: 'POST'; path: keyof paths };

const HTTP_OK = 200;

/** Identity's calls into programs-sites. */
export interface SitesClient {
  /**
   * `lookupSiteMailSettings`: the settings `getSite` resolves for each id, in the order listed; identity calls as itself.
   * @throws ServiceUnavailableError When programs-sites answers anything but 200.
   */
  mailSettings(siteIds: readonly string[]): Promise<SiteMailSettings[]>;
}

/** Creates identity's programs-sites client over its service client. */
export function createSitesClient(client: ServiceClient): SitesClient {
  return {
    async mailSettings(siteIds) {
      const lookup: Schemas['SiteMailSettingsLookup'] = { siteIds: [...siteIds] };
      const response = await client.request<Schemas['SiteMailSettingsList']>({
        service: SITES_SERVICE,
        method: LOOKUP.method,
        path: LOOKUP.path,
        json: lookup,
        userToken: null,
      });
      if (response.status !== HTTP_OK) {
        const cause = Object.assign(new Error(`${SITES_SERVICE} ${LOOKUP.operationId} answered HTTP ${response.status}`), {
          code: `HTTP_${response.status}`,
        });
        throw new ServiceUnavailableError(SITES_SERVICE, cause);
      }
      return response.body.items;
    },
  };
}
