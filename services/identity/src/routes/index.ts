/** Registry of the identity route modules; `app.ts` registers the migration, push, outbox-sweep and task-queue routes. */
import { LegacyServiceUnavailableError, cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import type { Clock, FastifyInstance, ServiceClient } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { AccountOperationDeps } from '../domain/account-operations.js';
import { createAccountReads } from '../domain/account-reads.js';
import type { CsrfDeps } from '../domain/csrf.js';
import { createGroupFavoriteReads } from '../domain/group-favorites.js';
import type { GroupDeps } from '../domain/groups.js';
import { DEFAULT_LOGIN_SETTINGS, type LoginDeps } from '../domain/login.js';
import {
  DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
  legacyUrlStem,
  type LoginMailDeps,
  type LoginMailGlobalSettings,
  type LoginMailSettingsSource,
  type LoginMailSiteSettings,
  type UrlStemOptions,
} from '../domain/login-mail.js';
import type { OAuthDeps } from '../domain/oauth.js';
import type { PermissionDeps, ReversePermDeps } from '../domain/permissions.js';
import type { SessionDeps } from '../domain/sessions.js';
import type { TokenService } from '../domain/tokens.js';
import { createIdentityEvents } from '../events/publish.js';
import { createBridgeRelay } from '../legacy/bridge-relay.js';
import { createContentClient } from '../legacy/content-client.js';
import { createSitesClient, type SiteMailSettings, type SitesClient } from '../legacy/sites-client.js';
import type { IdentityRepository } from '../repo/repository.js';
import { registerAdminGroupRoutes } from './admin-groups.js';
import { registerAdminOAuthClientRoutes } from './admin-oauth-clients.js';
import { registerAdminPermissionRoutes } from './admin-permissions.js';
import { registerAdminSessionRoutes } from './admin-sessions.js';
import { registerAccountReadRoutes } from './internal-account-reads.js';
import { registerAccountRoutes } from './internal-accounts.js';
import { registerCsrfRoutes } from './internal-csrf.js';
import { registerGroupFavoriteRoutes } from './internal-group-favorites.js';
import { registerSessionRoutes } from './internal-sessions.js';
import { registerTokenRoutes } from './internal-tokens.js';
import { legacyApiSettings, registerLegacyApiRoutes, type LegacyApiSettings } from './legacy-api.js';
import type { OAuthRouteDeps } from './oauth.js';

// `app.ts` routes the JSON API families in any letter case, behind `/index.cfm` and the configBean context.
export { legacyApiPrefixes, legacyApiSettings } from './legacy-api.js';

// No logger or service env: no route module or domain operation reads them.
/** Runtime dependencies `app.ts` passes to the route registry. */
export type RouteDeps = {
  repository: IdentityRepository;
  db: TenantDb;
  clock: Clock;
  client: ServiceClient;
  tokens: TokenService;
};

/** The process environment, which carries Masa's `MURA_<KEY>` configuration. */
type MasaEnv = Readonly<Record<string, string | undefined>>;

/** A configBean flag from `MURA_<KEY>`: the settings template's value when unset, configBean's default when not a CFML boolean, which its setter ignores. */
function masaFlag(env: MasaEnv, key: string, values: { template: boolean; bean: boolean }): boolean {
  const value = env[key];
  if (value === undefined) return values.template;
  return cfIsBoolean(value) ? cfToBoolean(value) : values.bean;
}

/** The configBean URL flags getURLStem reads [legacy: core/mura/configBean.cfc:151-154; core/templates/settings.template.cfm:50,54,113]. */
function urlStemOptions(env: MasaEnv): UrlStemOptions {
  return {
    siteIdInUrls: masaFlag(env, 'MURA_SITEIDINURLS', { template: false, bean: true }),
    indexFileInUrls: masaFlag(env, 'MURA_INDEXFILEINURLS', { template: true, bean: true }),
    hashUrls: masaFlag(env, 'MURA_HASHURLS', { template: false, bean: false }),
  };
}

/**
 * `getSite(siteId)` from programs-sites' answer: a remote site's own port and context, else configBean's
 * [legacy: core/mura/settings/settingsBean.cfc:1395-1414]. An edit-profile URL only CFML can evaluate refuses with the
 * legacy 503 when read, so only a mail that needs it fails.
 */
function siteMailSettings(found: SiteMailSettings, global: LoginMailGlobalSettings): LoginMailSiteSettings {
  const { editProfileURL } = found;
  return Object.freeze({
    site: found.site,
    contact: found.contact,
    sendLoginScript: found.sendLoginScript,
    extranetSSL: found.extranetSSL,
    useSSL: found.useSSL,
    serverPort: found.remote?.serverPort ?? global.serverPort,
    context: found.remote?.context ?? global.context,
    extranetPublicRegNotify: found.extranetPublicRegNotify,
    get editProfileURL(): string {
      if (editProfileURL === null) {
        throw new LegacyServiceUnavailableError(`The editProfileURL of site ${found.siteID} holds Mura tags only CFML evaluates (EX-LOGIN-MAIL-TAGGED-URL)`, 'auto', 'site-mail-settings');
      }
      return editProfileURL;
    },
  });
}

/** Masa's login-mail settings: configBean values identity reads from `MURA_<KEY>`, site settings from programs-sites. */
function loginMailSettings(legacy: LegacyApiSettings, env: MasaEnv, sites: SitesClient): LoginMailSettingsSource {
  const global: LoginMailGlobalSettings = Object.freeze({
    ...DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
    adminSSL: legacy.adminSSL,
    // Without MURA_PORT configBean holds the starting request's port, which no setting carries.
    serverPort: legacy.serverPort ?? DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS.serverPort,
    context: legacy.context,
  });
  const stem = urlStemOptions(env);
  const lookup = async (siteId: string): Promise<SiteMailSettings> => {
    const [found] = await sites.mailSettings([siteId]);
    if (found === undefined) throw new Error(`programs-sites answered no mail settings for site '${siteId}'`);
    return found;
  };
  return {
    global: () => global,
    site: async (siteId) => siteMailSettings(await lookup(siteId), global),
    // getURLStem reads the site id only with siteIdInUrls, so only then is its stored form looked up.
    urlStem: async (siteId, filename) => legacyUrlStem(stem.siteIdInUrls ? (await lookup(siteId)).siteID : siteId, filename, stem),
  };
}

/** Builds identity's domain dependencies once and registers every identity route module on `app`. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { repository: repo, db, clock, client } = deps;
  // One parse shared by the JSON API, token and login-mail routes; a malformed value fails start-up.
  const legacy = legacyApiSettings(process.env);
  const events = createIdentityEvents(repo);
  const relay = createBridgeRelay(client);

  const sessions: SessionDeps = { db, repo, clock, sessionTimeoutMinutes: legacy.sessionTimeout };
  const csrf: CsrfDeps = { db, repo, bridge: relay, clock };
  const login: LoginDeps = { db, repo, clock, settings: DEFAULT_LOGIN_SETTINGS };
  const groups: GroupDeps = { db, repo, events, clock };
  const permissions: PermissionDeps = { db, repo, events };
  const reverseLookup: ReversePermDeps = { db, repo };
  const oauth: OAuthDeps = { db, repo, clock };
  const loginMail: LoginMailDeps = { db, repo, events, clock, settings: loginMailSettings(legacy, process.env, createSitesClient(client)) };
  const accounts: AccountOperationDeps = { db, repo, events, clock };
  const rest: OAuthRouteDeps = { oauth, login, sessions };

  await registerTokenRoutes(app, { tokens: deps.tokens, rest, legacy });
  await registerSessionRoutes(app, { sessions });
  await registerCsrfRoutes(app, { csrf });
  await registerAccountRoutes(app, { accounts });
  // people's account reads are identity contract operations too.
  await registerAccountReadRoutes(app, { db, repo, accountReads: createAccountReads({ repo, clock }) });
  registerGroupFavoriteRoutes(app, { db, groupFavorites: createGroupFavoriteReads({ repo }) });
  await registerAdminSessionRoutes(app, { login, sessions, csrf, loginMail, permissions, db });
  await registerAdminGroupRoutes(app, { groups, content: createContentClient(client), sessions, csrf });
  await registerAdminPermissionRoutes(app, { permissions, reverseLookup, csrf });
  await registerAdminOAuthClientRoutes(app, { oauth, sessions, csrf });
  await registerLegacyApiRoutes(app, { groups, login, sessions, csrf, rest, client, db, legacy });
}
