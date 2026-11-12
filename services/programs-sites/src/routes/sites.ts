/**
 * Site-settings routes of `csettings.list`, `editSite`, `updateSite{action=Update}`, the admin layout's site read and
 * the admin gate's `sanitizeHref`.
 */
import { AuthDenial, Roles, assertSiteMatches, serviceRole, type UserClaims } from '@opt2/platform/auth';
import { cfEq } from '@opt2/platform/legacy-compat';
import {
  csrfPreHandler,
  legacyParamsOf,
  z,
  type FastifyInstance,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { SiteListOptions, SitesDomain } from '../domain/sites.js';
import type { components } from '../generated/openapi.js';
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

// legacy: csettings.cfc:103 params siteSortBy to `site`; getList's direction defaults to `asc`.
const DEFAULT_SORT_BY = 'site';

const UPDATE_SITES_CONTEXT = 'updatesites';

/** Path bounds of `SiteId`. */
const SITE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['siteId'],
  properties: { siteId: { type: 'string', minLength: 1, maxLength: 25 } },
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

/** `rc.siteID`: the posted `siteid`, or the request's site when absent or empty (admin Application.cfc:401-412). */
function rcSiteId(request: FastifyRequest): string {
  const posted = fieldText(legacyParamsOf(request), 'siteid');
  return posted === undefined || posted === '' ? (request.params as SiteParams).siteId : posted;
}

/** The Edit Site form as `rc` holds it: url then form fields, with `siteid` resolved as `rcSiteId` resolves it. */
function updateFormOf(request: FastifyRequest): Record<string, unknown> {
  const form = legacyParamsOf(request);
  const key = Object.keys(form).find((name) => name.toLowerCase() === 'siteid') ?? 'siteid';
  form[key] = rcSiteId(request);
  return form;
}

/**
 * Registers `GET /v1/sites`, `POST /v1/sites/order`, `GET /v1/sites/:siteId`, `GET /v1/sites/:siteId/shell`,
 * `POST /v1/sites/:siteId/update` and `GET /v1/href-domains`.
 */
export async function registerSiteRoutes(app: FastifyInstance, deps: SiteRouteDeps): Promise<void> {
  /** Sites screen rows for an S2 user [csettings.cfc:97-114]. */
  app.get<{ Reply: Schemas['SiteListItem'][] }>(
    '/v1/sites',
    { config: { opt2: { transport: 'service', requires: S2_ONLY } } },
    async (request) => deps.sites.listSites(deps.db, userOf(request), listOptionsOf(legacyParamsOf(request))),
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

  /** Edit Site save of an existing site; a failed CSRF check writes nothing [csettings.cfc:170-225]. */
  app.post<{ Params: SiteParams; Reply: Schemas['SiteUpdateResult'] }>(
    '/v1/sites/:siteId/update',
    {
      config: { opt2: { transport: 'service', requires: S2_OR_SITE_ADMIN } },
      schema: { params: SITE_PARAMS_SCHEMA },
      preHandler: [validateUpdateForm, csrfPreHandler({ contextOf: rcSiteId, onReject: markCsrfRejected })],
    },
    async (request) => {
      const claims = userOf(request);
      const { siteId } = request.params;
      assertSiteMatches(siteId, claims);
      if (csrfRejected.has(request)) {
        const { site } = await deps.sites.readSite(deps.db, claims, siteId);
        return { written: false, errors: {}, site };
      }
      return deps.sites.updateSite(deps.db, claims, siteId, updateFormOf(request));
    },
  );

  /** Registry domains the admin gate sanitizes the login return URL against (utility.sanitizeHref); the user token is optional. */
  app.get<{ Reply: Schemas['HrefDomains'] }>(
    '/v1/href-domains',
    { config: { opt2: { transport: 'service', requires: GATEWAY_ONLY } } },
    async (request) => deps.sites.hrefDomains(deps.db, fieldText(legacyParamsOf(request), 'siteid') ?? ''),
  );
}
