/** Registry of the identity route modules; `app.ts` registers the migration, push, outbox-sweep and task-queue routes. */
import { LegacyServiceUnavailableError, cfIsBoolean, cfToBoolean } from '@opt2/platform/legacy-compat';
import type { Clock, FastifyInstance, ServiceClient } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { AccountOperationDeps } from '../domain/account-operations.js';
import { createAccountReads } from '../domain/account-reads.js';
import type { CsrfDeps } from '../domain/csrf.js';
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
import type { IdentityRepository } from '../repo/repository.js';
import { registerAdminGroupRoutes } from './admin-groups.js';
import { registerAdminOAuthClientRoutes } from './admin-oauth-clients.js';
import { registerAdminPermissionRoutes } from './admin-permissions.js';
import { registerAdminSessionRoutes } from './admin-sessions.js';
import { registerAccountReadRoutes } from './internal-account-reads.js';
import { registerAccountRoutes } from './internal-accounts.js';
import { registerCsrfRoutes } from './internal-csrf.js';
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
 * `getSite(siteId)` as far as identity can answer it. The tsettings mail columns are programs-sites data that no
 * operation open to identity serves, so reading one refuses with the legacy 503 instead of mailing with made-up values.
 */
function siteMailSettings(global: LoginMailGlobalSettings): LoginMailSiteSettings {
  const refuse = (column: string): never => {
    throw new LegacyServiceUnavailableError(`tsettings.${column} is programs-sites data identity cannot read`, 'auto', 'site-mail-settings');
  };
  return Object.freeze({
    // The session site list reads only the name, so it gets settingsBean's unset Site rather than a refusal.
    site: '',
    serverPort: global.serverPort,
    context: global.context,
    get contact(): string {
      return refuse('Contact');
    },
    get sendLoginScript(): string {
      return refuse('sendLoginScript');
    },
    get editProfileURL(): string {
      return refuse('editProfileURL');
    },
    get extranetSSL(): boolean {
      return refuse('ExtranetSSL');
    },
    get useSSL(): boolean {
      return refuse('useSSL');
    },
    get extranetPublicRegNotify(): string {
      return refuse('ExtranetPublicRegNotify');
    },
  });
}

/** Masa's login-mail settings with the configBean values identity reads from `MURA_<KEY>`; every site resolves to {@link siteMailSettings}. */
function loginMailSettings(legacy: LegacyApiSettings, env: MasaEnv): LoginMailSettingsSource {
  const global: LoginMailGlobalSettings = Object.freeze({
    ...DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS,
    adminSSL: legacy.adminSSL,
    // Without MURA_PORT configBean holds the starting request's port, which no setting carries.
    serverPort: legacy.serverPort ?? DEFAULT_LOGIN_MAIL_GLOBAL_SETTINGS.serverPort,
    context: legacy.context,
  });
  const site = siteMailSettings(global);
  const stem = urlStemOptions(env);
  return {
    global: () => global,
    site: () => site,
    urlStem: (siteId, filename) => legacyUrlStem(siteId, filename, stem),
  };
}

/** Builds identity's domain dependencies once and registers every identity route module on `app`. */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { repository: repo, db, clock, client } = deps;
  // One parse shared by the JSON API, token and login-mail routes; a malformed value fails start-up.
  const legacy = legacyApiSettings(process.env);
  const events = createIdentityEvents(repo);
  const relay = createBridgeRelay(client);

  const sessions: SessionDeps = { db, repo, clock };
  const csrf: CsrfDeps = { db, repo, bridge: relay, clock };
  const login: LoginDeps = { db, repo, clock, settings: DEFAULT_LOGIN_SETTINGS };
  const groups: GroupDeps = { db, repo, events, clock };
  const permissions: PermissionDeps = { db, repo, events };
  const reverseLookup: ReversePermDeps = { db, repo };
  const oauth: OAuthDeps = { db, repo, clock };
  const loginMail: LoginMailDeps = { db, repo, events, clock, settings: loginMailSettings(legacy, process.env) };
  const accounts: AccountOperationDeps = { db, repo, events, clock };
  const rest: OAuthRouteDeps = { oauth, login, sessions };

  await registerTokenRoutes(app, { tokens: deps.tokens, rest, legacy });
  await registerSessionRoutes(app, { sessions });
  await registerCsrfRoutes(app, { csrf });
  await registerAccountRoutes(app, { accounts });
  // people's account reads are identity contract operations too.
  await registerAccountReadRoutes(app, { db, repo, accountReads: createAccountReads({ repo, clock }) });
  await registerAdminSessionRoutes(app, { login, sessions, csrf, loginMail, permissions, db });
  await registerAdminGroupRoutes(app, { groups, content: createContentClient(client), sessions, csrf });
  await registerAdminPermissionRoutes(app, { permissions, reverseLookup, csrf });
  await registerAdminOAuthClientRoutes(app, { oauth, sessions, csrf });
  await registerLegacyApiRoutes(app, { groups, login, sessions, csrf, rest, client, db, legacy });
}
