/**
 * Site-settings routes of `csettings.list`, `editSite`, the refused `updateSite`, the admin layout's site read, the
 * admin gate's `sanitizeHref`, identity's login-mail settings, and strategies-content's feed settings, Site Manager
 * flags and JSON API site values.
 */
import { AuthDenial, Roles, assertSiteMatches, serviceRole, type UserClaims } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError, cfEq } from '@opt2/platform/legacy-compat';
import {
  csrfPreHandler,
  legacyParamsOf,
  z,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { SiteListOptions, SitesDomain } from '../domain/sites.js';
import type { components } from '../generated/openapi.js';
import type { JsonApiSiteValues } from '../legacy/json-api-site.js';
import { legacyParamsGuard } from './legacy-params.js';

type Schemas = components['schemas'];

interface SiteParams {
  siteId: components['parameters']['SiteId'];
}

/** Dependencies of `registerSiteRoutes`. */
export interface SiteRouteDeps {
  db: TenantDb;
  sites: SitesDomain;
}

const S2_ONLY = [Roles.s2] as const;
const S2_OR_SITE_ADMIN = [Roles.s2, Roles.siteAdmin] as const;
const PRIVATE_ADMIN = [Roles.s2, Roles.siteAdmin, Roles.systemUser] as const;
const GATEWAY_ONLY = [serviceRole('gateway')] as const;
const IDENTITY_ONLY = [serviceRole('identity')] as const;
const STRATEGIES_CONTENT_ONLY = [serviceRole('strategies-content')] as const;

const MAIL_SETTINGS_LOOKUP_PATH = '/internal/v1/sites/mail-settings::lookup';
const FEED_SETTINGS_LOOKUP_PATH = '/internal/v1/sites/feed-settings::lookup';
const CONFIG_FLAGS_LOOKUP_PATH = '/internal/v1/sites/config-flags::lookup';
const JSON_API_VALUES_LOOKUP_PATH = '/internal/v1/sites/json-api-values::lookup';

// legacy: csettings.cfc:103 params siteSortBy to `site`; getList's direction defaults to `asc`.
const DEFAULT_SORT_BY = 'site';

const UPDATE_SITES_CONTEXT = 'updatesites';

/** Path bounds of `SiteId`. */
const SITE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['siteId'],
  properties: { siteId: { type: 'string', minLength: 1, maxLength: 25 } },
} as const;

/** Query of `listSitesV2`, `limit` defaulted. */
interface SitePageQuery {
  limit: number;
  after?: string;
}

/** Bounds of `ListPageSize` and `SitePageAfter`. */
const SITE_PAGE_QUERY_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
    after: { type: 'string', minLength: 1, maxLength: 25 },
  },
} as const;

const optionalText = z.string().optional();

/** `SiteOrderUpdate` over lower-cased names. */
const validateOrderForm = legacyParamsGuard(
  z.looseObject({
    orderid: z.string(),
    orderno: optionalText,
    deploy: optionalText,
    sortby: optionalText,
    sortdirection: optionalText,
    csrf_token: optionalText,
    csrf_token_expires: optionalText,
  }),
);

const mailSettingsLookupSchema = z.strictObject({
  siteIds: z.array(z.string()).min(1),
}) satisfies z.ZodType<Schemas['SiteMailSettingsLookup']>;

const feedSettingsLookupSchema = z.strictObject({
  siteIds: z.array(z.string()).min(1),
}) satisfies z.ZodType<Schemas['SiteFeedSettingsLookup']>;

const configFlagsLookupSchema = z.strictObject({
  siteIds: z.array(z.string()).min(1),
}) satisfies z.ZodType<Schemas['SiteConfigFlagsLookup']>;

const jsonApiValuesLookupSchema = z.strictObject({
  baseUrl: z.string(),
  siteIds: z.array(z.string()).min(1),
}) satisfies z.ZodType<Schemas['SiteJsonApiValuesLookup']>;

/** `SiteUpdate` over lower-cased names: `action` equal to `Update` under CFML `==`, and every field a simple value. */
const validateUpdateForm = legacyParamsGuard(
  z.object({ siteid: z.string(), action: z.string().refine((action) => cfEq(action, 'Update')) }).catchall(z.string()),
);

// A failed CSRF check skips the writes and is not an error, as `validateCSRFTokens` gates them in legacy.
const csrfRejected = new WeakSet<FastifyRequest>();

function markCsrfRejected(request: FastifyRequest): void {
  csrfRejected.add(request);
}

/** Verified user claims; every route calling it requires a user role, so their absence is a missing credential. */
function userOf(request: FastifyRequest): UserClaims {
  const { user } = request.opt2Auth;
  if (user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return user;
}

/** A merged url/form field as `rc` holds it, ignoring case; query values and guarded form values are always text. */
function fieldText(params: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(params).find((candidate) => candidate.toLowerCase() === lower);
  const value = key === undefined ? undefined : params[key];
  return typeof value === 'string' ? value : undefined;
}

/** The list sort as `csettings.list` passes it to `getList`; the domain applies legacy's fallbacks. */
function listOptionsOf(params: Readonly<Record<string, unknown>>): SiteListOptions {
  return {
    sortBy: fieldText(params, 'sortBy') ?? DEFAULT_SORT_BY,
    sortDirection: fieldText(params, 'sortDirection'),
  };
}

/** Aborts once the client disconnects, or at once if it already has, before the response has been ended. */
function clientGoneSignal(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  // writableEnded, not writableFinished: an injected reply closes unflushed, and once ended the list's work is done.
  const abortUnlessEnded = (): void => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  // A disconnect before the handler, during authentication say, has already destroyed the reply and emitted 'close'.
  if (reply.raw.destroyed) abortUnlessEnded();
  else reply.raw.once('close', abortUnlessEnded);
  return controller.signal;
}

/** `list` under a signal that aborts once the client disconnects; an abandoned list is logged instead of answered. */
async function untilClientGone<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  claims: UserClaims,
  list: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const signal = clientGoneSignal(reply);
  try {
    return await list(signal);
  } catch (err) {
    if (!signal.aborted || err !== signal.reason) throw err;
    // The client has gone, so nothing is sent.
    request.log.info(
      {
        route: request.routeOptions.url,
        httpMethod: request.method,
        latencyMs: Math.round(reply.elapsedTime),
        tenantId: claims.tid,
        userId: claims.sub,
      },
      'client closed the request',
    );
    return undefined;
  }
}

/**
 * Registers `GET /v1/sites`, `GET /v2/sites`, `POST /v1/sites/order`, `GET /v1/sites/:siteId`, `GET /v1/sites/:siteId/shell`,
 * `GET /v1/sites/:siteId/user-pool-sites`, the refusing `POST /v1/sites/:siteId/update`, `GET /v1/href-domains`,
 * `POST /internal/v1/sites/mail-settings:lookup`, `POST /internal/v1/sites/feed-settings:lookup`,
 * `POST /internal/v1/sites/config-flags:lookup` and `POST /internal/v1/sites/json-api-values:lookup`.
 */
export async function registerSiteRoutes(app: FastifyInstance, deps: SiteRouteDeps): Promise<void> {
  /** Sites screen rows for an S2 user [csettings.cfc:97-114]. */
  app.get<{ Reply: Schemas['SiteListItem'][] }>(
    '/v1/sites',
    { config: { opt2: { transport: 'service', requires: S2_ONLY } } },
    async (request, reply) => {
      const claims = userOf(request);
      return untilClientGone(request, reply, claims, (signal) =>
        deps.sites.listSites(deps.db, claims, { ...listOptionsOf(legacyParamsOf(request)), signal }),
      );
    },
  );

  /** One page of the Sites screen rows in registry site-id order, for an S2 user. */
  app.get<{ Querystring: SitePageQuery; Reply: Schemas['SiteListPage'] }>(
    '/v2/sites',
    { config: { opt2: { transport: 'service', requires: S2_ONLY } }, schema: { querystring: SITE_PAGE_QUERY_SCHEMA } },
    async (request, reply) => {
      const claims = userOf(request);
      const { limit, after } = request.query;
      return untilClientGone(request, reply, claims, (signal) => deps.sites.listSitePage(deps.db, claims, { limit, after, signal }));
    },
  );

  /** Bind order and batch-deploy save of the Sites screen, then its rows [csettings.cfc:108-112]. */
  app.post<{ Reply: Schemas['SiteOrderResult'] }>(
    '/v1/sites/order',
    {
      config: { opt2: { transport: 'service', requires: S2_ONLY } },
      preHandler: [
        validateOrderForm,
        csrfPreHandler({ contextOf: () => UPDATE_SITES_CONTEXT, onReject: markCsrfRejected }),
      ],
    },
    async (request) => {
      const claims = userOf(request);
      const params = legacyParamsOf(request);
      const list = listOptionsOf(params);
      if (csrfRejected.has(request)) {
        return { written: false, sites: await deps.sites.listSites(deps.db, claims, list) };
      }
      return deps.sites.saveOrderAndDeploy(deps.db, claims, {
        ...list,
        orderno: fieldText(params, 'orderno'),
        orderID: fieldText(params, 'orderID'),
        deploy: fieldText(params, 'deploy'),
      });
    },
  );

  /** Edit Site data of one site [csettings.cfc:116-118]. */
  app.get<{ Params: SiteParams; Reply: Schemas['SiteDetail'] }>(
    '/v1/sites/:siteId',
    { config: { opt2: { transport: 'service', requires: S2_OR_SITE_ADMIN } } },
    async (request) => {
      const claims = userOf(request);
      const { siteId } = request.params;
      assertSiteMatches(siteId, claims);
      return deps.sites.readSite(deps.db, claims, siteId);
    },
  );

  /** Site settings the admin layout reads, for every private admin user [nav.cfm:119-207]. */
  app.get<{ Params: SiteParams; Reply: Schemas['ShellSiteDetail'] }>(
    '/v1/sites/:siteId/shell',
    { config: { opt2: { transport: 'service', requires: PRIVATE_ADMIN } } },
    async (request) => {
      const claims = userOf(request);
      const { siteId } = request.params;
      assertSiteMatches(siteId, claims);
      return deps.sites.readShellSite(deps.db, claims, siteId);
    },
  );

  /** Settings of the site's user pool sites, which `getSite(bean.siteid)` reads for a pooled user [filetools.cfm:37]. */
  app.get<{ Params: SiteParams; Reply: Schemas['UserPoolSites'] }>(
    '/v1/sites/:siteId/user-pool-sites',
    { config: { opt2: { transport: 'service', requires: PRIVATE_ADMIN } } },
    async (request) => {
      const claims = userOf(request);
      const { siteId } = request.params;
      assertSiteMatches(siteId, claims);
      return deps.sites.readUserPoolSites(deps.db, claims, siteId);
    },
  );

  /** Edit Site save [csettings.cfc:170-225]: its Update branch is withheld, so a valid form answers the legacy 503. */
  app.post<{ Params: SiteParams }>(
    '/v1/sites/:siteId/update',
    {
      config: { opt2: { transport: 'service', requires: S2_OR_SITE_ADMIN } },
      schema: { params: SITE_PARAMS_SCHEMA },
      preHandler: [validateUpdateForm],
    },
    async (request) => {
      assertSiteMatches(request.params.siteId, userOf(request));
      throw new LegacyServiceUnavailableError('The Edit Site save is withheld and served by legacy', 'auto', 'withheld');
    },
  );

  /** Registry domains the admin gate sanitizes the login return URL against (utility.sanitizeHref); the user token is optional. */
  app.get<{ Reply: Schemas['HrefDomains'] }>(
    '/v1/href-domains',
    { config: { opt2: { transport: 'service', requires: GATEWAY_ONLY } } },
    async (request) => deps.sites.hrefDomains(deps.db, fieldText(legacyParamsOf(request), 'siteid') ?? ''),
  );

  /** Site settings identity's forgot-password and send-login mail read through getSite [userUtility.cfc:518-540]. */
  app.post<{ Reply: Schemas['SiteMailSettingsList'] }>(
    MAIL_SETTINGS_LOOKUP_PATH,
    { config: { opt2: { transport: 'service', requires: IDENTITY_ONLY } } },
    async (request) => {
      const body = mailSettingsLookupSchema.safeParse(request.body);
      if (!body.success) throw new LegacyApiError('badRequest');
      return { items: await deps.sites.readMailSettings(deps.db, body.data.siteIds) };
    },
  );

  /** Site settings strategies-content's RSS writers read through getSite [feedApiUtility.cfc:257-446]. */
  app.post<{ Reply: Schemas['SiteFeedSettingsList'] }>(
    FEED_SETTINGS_LOOKUP_PATH,
    { config: { opt2: { transport: 'service', requires: STRATEGIES_CONTENT_ONLY } } },
    async (request) => {
      const body = feedSettingsLookupSchema.safeParse(request.body);
      if (!body.success) throw new LegacyApiError('badRequest');
      return { items: await deps.sites.readFeedSettings(deps.db, body.data.siteIds) };
    },
  );

  /** The `$.siteConfig` flags strategies-content's Site Manager views test through getSite [MasaScope.cfc:304-330]. */
  app.post<{ Reply: Schemas['SiteConfigFlagsList'] }>(
    CONFIG_FLAGS_LOOKUP_PATH,
    { config: { opt2: { transport: 'service', requires: STRATEGIES_CONTENT_ONLY } } },
    async (request) => {
      const body = configFlagsLookupSchema.safeParse(request.body);
      if (!body.success) throw new LegacyApiError('badRequest');
      return { items: await deps.sites.readConfigFlags(deps.db, body.data.siteIds) };
    },
  );

  /** The `site` entity's findOne values strategies-content's JSON API expands and reads by path [jsonApiUtility.cfc:2292-2384]. */
  app.post<{ Reply: { items: JsonApiSiteValues[] } }>(
    JSON_API_VALUES_LOOKUP_PATH,
    { config: { opt2: { transport: 'service', requires: STRATEGIES_CONTENT_ONLY } } },
    async (request) => {
      const body = jsonApiValuesLookupSchema.safeParse(request.body);
      if (!body.success) throw new LegacyApiError('badRequest');
      return { items: await deps.sites.readJsonApiValues(deps.db, body.data.baseUrl, body.data.siteIds) };
    },
  );
}
