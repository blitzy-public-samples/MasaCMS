// Internal route through which web reads the first-touch path values legacy's live site beans give a browser request.
import { serviceRole } from '@opt2/platform/auth';
import type { FastifyInstance } from '@opt2/platform/service-kit';
import type { operations } from '../generated/openapi.js';
import type { SitePathsClient } from './bridge-client.js';

type SitePathsQuery = operations['legacySitePaths']['parameters']['query'];

const SITE_PATHS_URL = '/internal/v1/legacy-site-paths';

const SITE = { type: 'string', maxLength: 255 } as const;
/** A header field value: visible ASCII, spaces and tabs. */
const HEADER_VALUE = { type: 'string', maxLength: 1024, pattern: '^[\\t\\x20-\\x7e]*$' } as const;

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sessionSite', 'host'],
  properties: {
    sessionSite: { ...SITE, minLength: 1 },
    host: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[\\x21-\\x7e]+$' },
    forwardedProto: HEADER_VALUE,
    frontEndHttps: HEADER_VALUE,
    apiSite: SITE,
    feedSite: SITE,
    themeSite: SITE,
    initSite: SITE,
  },
  anyOf: [{ required: ['apiSite'] }, { required: ['feedSite'] }, { required: ['themeSite'] }, { required: ['initSite'] }],
} as const;

/** Registers `GET /internal/v1/legacy-site-paths` (`legacySitePaths`), callable by web only. */
export async function registerSitePathsRoute(app: FastifyInstance, deps: { sitePaths: SitePathsClient }): Promise<void> {
  app.get<{ Querystring: SitePathsQuery }>(
    SITE_PATHS_URL,
    {
      exposeHeadRoute: false,
      schema: { querystring: QUERY_SCHEMA },
      config: { opt2: { transport: 'service', requires: [serviceRole('web')] } },
    },
    async (request) => {
      const { sessionSite, host, forwardedProto, frontEndHttps, apiSite, feedSite, themeSite, initSite } = request.query;
      // Every bridge failure propagates as the legacy 503 (fail closed).
      return deps.sitePaths.paths({ sessionSite, apiSite, feedSite, themeSite, initSite }, { host, forwardedProto, frontEndHttps });
    },
  );
}
