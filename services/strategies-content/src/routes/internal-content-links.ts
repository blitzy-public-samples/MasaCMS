/** `lookupContentLinks`: the `createHref` link legacy's favorites template builds for a content id of a site. */
import { serviceRole, type Opt2RouteConfig } from '@opt2/platform/auth';
import { LegacyApiError, LegacyServiceUnavailableError, cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import { EnvValidationError, z, type FastifyInstance } from '@opt2/platform/service-kit';
import { siteForTenant, tenantForRegisteredSite, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import type { components } from '../generated/openapi.js';
import { registrySite } from '../jobs/feed-auto-import.js';
import { createHref, type LegacySiteUrlConfig } from '../legacy/content-urls.js';
import { readActiveIn } from '../repo/content-queries.js';

type ContentLinkRequest = components['schemas']['ContentLinkRequest'];
type ContentLink = components['schemas']['ContentLink'];
type ContentLinkList = components['schemas']['ContentLinkList'];

/** The process environment, which carries Masa's `MURA_<KEY>` configuration. */
export type MasaEnv = Readonly<Record<string, string | undefined>>;

/** The database the lookup reads, and the environment its configBean URL settings come from. */
export interface ContentLinksRouteDeps {
  db: TenantDb;
  env: MasaEnv;
}

/** The configBean values a relative `createHref` link reads; the registry site supplies the rest. */
export type ContentLinkUrlSettings = Pick<
  LegacySiteUrlConfig,
  'context' | 'siteIdInUrls' | 'indexFileInUrls' | 'hashUrls' | 'legacyIndexFileLocation' | 'siteAssetPath'
>;

/** A configBean flag from `MURA_<KEY>`: the settings template's value when unset, configBean's default when not a CFML boolean, which its setter ignores. */
function masaFlag(env: MasaEnv, key: string, values: { template: boolean; bean: boolean }): boolean {
  const value = env[key];
  if (value === undefined) return values.template;
  return cfIsBoolean(value) ? cfToBoolean(value) : values.bean;
}

/** A `${expr}` or `{{expr}}` value, which Masa start-up evaluates as CFML; with no CFML runtime here it reads as unset. */
function isExpression(value: string): boolean {
  return (value.startsWith('${') && value.endsWith('}')) || (value.startsWith('{{') && value.endsWith('}}'));
}

/** `env[key]`, undefined when unset or an expression. */
function literal(env: MasaEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || isExpression(value) ? undefined : value;
}

/** configBean `context` from `MURA_CONTEXT`: blank by default, else the path less one trailing `/` or `\` (`cleanFilePath`). */
function masaContext(env: MasaEnv): string {
  const value = literal(env, 'MURA_CONTEXT');
  if (value === undefined || /^\s*$/.test(value)) return '';
  if (!/^[/\\][^\s?#]*$/.test(value)) {
    throw new EnvValidationError(['MURA_CONTEXT: must be blank or a path from / or \\'], 'strategies-content');
  }
  return /[/\\]$/.test(value) ? value.slice(0, -1) : value;
}

/** `getValue('legacyIndexFileLocation', false)` from `MURA_LEGACYINDEXFILELOCATION`, which getURLStem's `<cfif>` needs as a CFML boolean. */
function masaLegacyIndexFileLocation(env: MasaEnv): boolean {
  const value = literal(env, 'MURA_LEGACYINDEXFILELOCATION');
  if (value === undefined) return false;
  if (!cfIsBoolean(value)) {
    throw new EnvValidationError(['MURA_LEGACYINDEXFILELOCATION: must be a CFML boolean'], 'strategies-content');
  }
  return cfToBoolean(value);
}

/**
 * The configBean URL settings from `MURA_<KEY>` variables, which Masa start-up applies whatever their section, else
 * the settings template's values [legacy: core/appcfc/onApplicationStart_include.cfm:168-182;
 * core/mura/configBean.cfc:151-154,231,2172-2178; core/templates/settings.template.cfm:22,50,54,113]; throws
 * EnvValidationError for a malformed `MURA_CONTEXT` or `MURA_LEGACYINDEXFILELOCATION`.
 */
export function contentLinkUrlSettings(env: MasaEnv): ContentLinkUrlSettings {
  const siteDir = literal(env, 'MURA_SITEDIR') ?? 'sites';
  return {
    context: masaContext(env),
    siteIdInUrls: masaFlag(env, 'MURA_SITEIDINURLS', { template: false, bean: true }),
    indexFileInUrls: masaFlag(env, 'MURA_INDEXFILEINURLS', { template: true, bean: true }),
    hashUrls: masaFlag(env, 'MURA_HASHURLS', { template: false, bean: false }),
    legacyIndexFileLocation: masaLegacyIndexFileLocation(env),
    // configBean getSiteAssetPath().
    siteAssetPath: siteDir === '' ? '' : `/${siteDir}`,
  };
}

const LINKS_PATH = '/internal/v1/content::links';

// The favorites templates run for anonymous visitors, so people calls with its own identity and no user token.
const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([serviceRole('people')]),
});

const linksBodySchema = z.strictObject({
  siteId: z.string().min(1).max(25),
  contentIds: z
    .array(z.string().min(1).max(1000))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
}) satisfies z.ZodType<ContentLinkRequest>;

/**
 * The link of each listed id: its active version in `siteId` (contentBean.loadBy), or an empty filename when none
 * loads, through createHref with the site of the request as the event's site and `settings` over the registry
 * site's URL values (saveFavorite.cfm:85-86).
 */
export async function lookupContentLinks(
  db: TenantDb,
  settings: ContentLinkUrlSettings,
  siteId: string,
  contentIds: readonly string[],
): Promise<ContentLink[]> {
  // The tenant comes from the site registry, never from the caller.
  const tenantId = await tenantForRegisteredSite(db, siteId);
  if (tenantId === null) {
    throw new LegacyServiceUnavailableError(`Site ${siteId} is not registered`, 'auto', 'tenant-unregistered');
  }
  const urls: LegacySiteUrlConfig = { ...(await registrySite(db, tenantId, siteId)).urls, ...settings };
  const versions = await withTenant(db, tenantId, async (tx) => {
    // tcontent.siteid holds the registered spelling, which legacy's case-insensitive comparison matches in any case.
    const registered = (await siteForTenant(tx, tenantId)) ?? siteId;
    return readActiveIn(tx, { siteId: registered, contentIds });
  });
  return contentIds.map((contentId) => ({
    contentId,
    href: createHref(urls, { filename: versions.get(contentId)?.filename ?? '', contentId, eventSiteId: siteId }),
  }));
}

/**
 * Registers `lookupContentLinks`, people's read of the content links its favorites answers carry, under the URL
 * settings of `deps.env`; throws EnvValidationError for a malformed one.
 */
export function registerContentLinksRoutes(app: FastifyInstance, deps: ContentLinksRouteDeps): void {
  const { db } = deps;
  const settings = contentLinkUrlSettings(deps.env);

  app.post<{ Reply: ContentLinkList }>(LINKS_PATH, { config: { opt2: ROUTE_AUTH } }, async (request) => {
    const body = linksBodySchema.safeParse(request.body);
    if (!body.success) {
      throw new LegacyApiError('invalidParameters');
    }
    return { items: await lookupContentLinks(db, settings, body.data.siteId, body.data.contentIds) };
  });
}
