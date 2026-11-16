/** Registry of the strategies-content route modules and the shared context each receives; it registers no route itself. */
import type { UserClaims } from '@opt2/platform/auth';
import {
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  type BaseEnv,
  type Clock,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import type { StoragePort } from '@opt2/platform/storage';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type DomainDeps } from '../domain/context.js';
import type { ContentRepository } from '../repo/repository.js';
import { registerCommentsProxyRoutes } from './comments-proxy.js';
import { FEED_PATHS, registerFeedRoutes } from './feed.js';
import { registerFileRoutes } from './files.js';
import { registerContentLinksRoutes } from './internal-content-links.js';
import { registerFileLookupRoutes } from './internal-file-lookup.js';
import { JSON_API_PREFIXES, registerJsonApiRoutes } from './jsonapi.js';
import { registerMigrationObjectRoutes } from './migration-objects.js';
import { RENDER_PREFIXES, registerRenderRoutes } from './render.js';
import { registerRaterRoutes } from './rater.js';
import { VARIATION_PATH, registerVariationRoutes } from './variation.js';
import { registerCarchRoutes } from './v1/carch.js';
import { registerCategoryRoutes } from './v1/ccategory.js';
import { registerChainRoutes } from './v1/cchain.js';
import { registerChangesetRoutes } from './v1/cchangesets.js';
import { registerCommentAdminRoutes } from './v1/ccomments.js';
import { registerFeedAdminRoutes } from './v1/cfeed.js';
import { registerFormRoutes } from './v1/cform.js';
import { registerHeaderPromptRoutes } from './v1/header-prompts.js';
import { registerNavRoutes } from './v1/cnav.js';
import { registerRawRoutes } from './v1/raw.js';

// app.ts parses this environment and imports this registry, so the type is stated here structurally rather than
// imported from app.ts; the environment app.ts loads with its content schema is assignable to it.
/** The parsed service environment: the base variables plus configBean `variations` from `MURA_VARIATIONS`. */
type ContentEnv = BaseEnv & { MURA_VARIATIONS: boolean };

/** Runtime dependencies `app.ts` passes to the route registry; `db` defaults to the service pool `app.opt2.db`. */
export interface RouteDeps {
  env: ContentEnv;
  repository: ContentRepository;
  storage: StoragePort;
  taskPort: TaskPort;
  clock: Clock;
  db?: TenantDb;
}

/**
 * handleAPIRequest leads these modules serve, which legacy matches with CFML's case-insensitive `eq` (contentServer.cfc:610-668)
 * and the shared route key matches in any case; `app.ts` passes them to createService as `noCasePathPrefixes`.
 */
export const LEGACY_API_PREFIXES: readonly string[] = Object.freeze([...JSON_API_PREFIXES, ...FEED_PATHS, ...RENDER_PREFIXES, VARIATION_PATH]);

/** Shared context every strategies-content route module receives from `registerRoutes`. */
export interface ContentRouteContext {
  domain: DomainDeps;
  storage: StoragePort;
  taskPort: TaskPort;
  env: ContentEnv;
  clock: Clock;
  actorFor(request: FastifyRequest): Promise<Actor>;
}

/** identity's `session.mura` path (getCurrentSession), read with the caller's forwarded user token. */
const CURRENT_SESSION_PATH = '/v1/sessions/current';

/** The part of identity's CurrentSession the audit name comes from: the session's login-time user struct. */
interface CurrentSessionNames {
  user: { fname?: string; lname?: string };
}

/**
 * The legacy audit name `session.mura.fname & " " & session.mura.lname` of the caller's session, as identity holds it.
 * @throws ServiceUnavailableError when identity is unreachable or answers non-2xx, which renders the legacy 503.
 */
async function sessionFullName(client: ServiceClient): Promise<string> {
  const res = await client.request<CurrentSessionNames>({ service: IDENTITY_SERVICE, method: 'GET', path: CURRENT_SESSION_PATH });
  if (res.status < 200 || res.status > 299) {
    throw new ServiceUnavailableError(IDENTITY_SERVICE, Object.assign(new Error(`${IDENTITY_SERVICE} answered HTTP ${res.status}`), { code: `HTTP_${res.status}` }));
  }
  return `${res.body.user.fname ?? ''} ${res.body.user.lname ?? ''}`;
}

// The circuit gates and the JSON API resolve the actor before a handler knows whether it writes, and GET raw actions
// (carch.update, cfeed.update, savequickedit) write LastUpdateBy; Actor.fullName is read synchronously inside those
// writes, so the name is fetched with the actor of every signed-in request, once.
/** The actor of the request's verified claims, with its session's audit name for a signed-in user. */
async function resolveActor(client: ServiceClient, claims: UserClaims | undefined): Promise<Actor> {
  if (claims === undefined) return actorFromClaims(undefined, '');
  // The anonymous principal (`sub` '') keeps its token's site and tenant but, like legacy's anonymous session, is not logged in.
  if (claims.sub === '') return { ...actorFromClaims(claims, ''), isLoggedIn: false };
  return actorFromClaims(claims, await sessionFullName(client));
}

/**
 * Builds the shared route context once and registers every strategies-content route module on `app`.
 * @throws Error At start-up when neither `deps.db` nor `app.opt2.db` provides the tenant database.
 */
export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { env, repository, storage, taskPort, clock } = deps;
  const db = deps.db ?? app.opt2.db;
  if (db === undefined) throw new Error('strategies-content routes need a tenant database: pass RouteDeps.db or create the service with a pool');
  const domain: DomainDeps = { db, repository, clock, config: { ...CONTENT_CONFIG_DEFAULTS, variations: env.MURA_VARIATIONS } };

  const actors = new WeakMap<FastifyRequest, Promise<Actor>>();
  const actorFor = (request: FastifyRequest): Promise<Actor> => {
    let actor = actors.get(request);
    if (actor === undefined) {
      actor = resolveActor(app.opt2.client, request.opt2Auth.user);
      actors.set(request, actor);
    }
    return actor;
  };
  const ctx: ContentRouteContext = { domain, storage, taskPort, env, clock, actorFor };

  registerMigrationObjectRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerRenderRoutes(app, ctx);
  registerFeedRoutes(app, ctx);
  registerVariationRoutes(app, ctx);
  registerCommentsProxyRoutes(app, ctx);
  registerRaterRoutes(app, ctx);
  registerJsonApiRoutes(app, ctx);
  await registerCarchRoutes(app, ctx);
  await registerChangesetRoutes(app, ctx);
  await registerCommentAdminRoutes(app, ctx);
  await registerCategoryRoutes(app, ctx);
  await registerFeedAdminRoutes(app, ctx);
  await registerChainRoutes(app, ctx);
  await registerFormRoutes(app, ctx);
  await registerNavRoutes(app, ctx);
  await registerRawRoutes(app, ctx);
  // Contract operations of modules that take narrower deps: the admin header prompts and the people lookups.
  await registerHeaderPromptRoutes(app, { domain });
  await registerFileLookupRoutes(app, { db });
  // The configBean URL settings come from Masa's MURA_<KEY> variables, which the parsed service env does not carry.
  registerContentLinksRoutes(app, { db, env: process.env });
}
