// Composition root of the gateway: service-kit plus the cut-over, session, admin and dispatcher modules; never listens.
import { randomUUID } from 'node:crypto';
import replyFrom from '@fastify/reply-from';
import {
  LEGACY_POST_LIMIT_BYTES,
  baseEnvSchema,
  createService,
  envUrl,
  loadEnv,
  optionalEnvString,
  requiredEnvString,
  systemClock,
  type Clock,
  type CreateServiceOptions,
  type FastifyInstance,
  type FastifyRequest,
  type LegacySurface,
  type LoadedEnv,
  type ServiceClient,
} from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import { createResponseModes } from './admin/response-modes.js';
import { createInflightStore } from './cutover/inflight.js';
import { loadInventoryFacts, loadVariants } from './cutover/loader.js';
import { resolveGatewayPaths } from './cutover/paths.js';
import { registerCutoverRoutes } from './cutover/routes.js';
import { createCutoverState, type CutoverState } from './cutover/state.js';
import { createSessionBarrier } from './dispatcher/barrier.js';
import { registerEdgeRoute, type DispatcherDeps } from './dispatcher/dispatch.js';
import { createMatcher } from './dispatcher/match.js';
import { registerRelayRoutes, type RelayDeps } from './dispatcher/relay.js';
import { createWriteWindowClient } from './dispatcher/write-window.js';
import { createBridgeClient, type BridgeClient } from './session/bridge-client.js';
import { createCsrfContinuity } from './session/csrf.js';
import { createHydrator } from './session/hydration.js';
import { createIdentityClient, type IdentityClient } from './session/identity-client.js';
import { createInvalidation } from './session/invalidation.js';
import { createLegacyJar } from './session/jar.js';
import { registerMarkUsedRoute } from './session/mark-used-route.js';
import { createSessionResolver } from './session/resolve.js';
import { createSessionStateChecker } from './session/state-check.js';
import { createTokenCache } from './session/token-cache.js';

/** Service name, as `OPT2_SERVICE_NAME` and the log `service`. */
export const SERVICE_NAME = 'gateway';

/** Equals `info.version` of `contracts/openapi.yaml`. */
export const SERVICE_VERSION = '1.0.0';

/** The gateway's own coordination schema, the only one it reaches. */
const SCHEMA = 'gateway';

/** Legacy admin directory (configBean `adminDir` default), matched without case as route keys match it. */
const ADMIN_DIR = '/admin';

/** Base variables plus the legacy origin, the optional cut-over directory and the legacy-bridge HMAC key. */
export const gatewayEnvSchema = baseEnvSchema.extend({
  LEGACY_ORIGIN: envUrl(),
  OPT2_CUTOVER_DIR: optionalEnvString(),
  OPT2_BRIDGE_HMAC_KEY: requiredEnvString(),
});

/** Parsed gateway environment. */
export type GatewayEnv = Readonly<LoadedEnv<typeof gatewayEnvSchema>>;

/** Collaborators `buildApp` uses instead of building its own from the environment. */
export interface BuildAppOptions {
  env?: GatewayEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  /** Gateway-schema pool; createService opens one from `env` when absent. */
  db?: TenantDb;
  /** Id this instance heartbeats as; a random UUID when absent. */
  instanceId?: string;
  /** Replaces `env.LEGACY_ORIGIN` for forwarding and the bridge. */
  legacyOrigin?: string;
  identityClient?: IdentityClient;
  /** Client of migration's window and projection-await calls; defaults to the app's service client. */
  migrationClient?: ServiceClient;
  bridgeClient?: BridgeClient;
  /** False skips loading the active version and the refresh loop (route matrix export); defaults to true. */
  startBackground?: boolean;
}

type SessionMode = ReturnType<RelayDeps['sessionMode']>;

/** `admin` for paths under the legacy admin directory, the admin route family; `api` for every other path. */
function surfaceOf(request: FastifyRequest): LegacySurface {
  const query = request.url.indexOf('?');
  const path = (query === -1 ? request.url : request.url.slice(0, query)).toLowerCase();
  return path === ADMIN_DIR || path.startsWith(`${ADMIN_DIR}/`) ? 'admin' : 'api';
}

// Restates session/mode.ts's rule (the login group's authority decides): that module is not a declared dependency here.
/** Session mode of the cached active version; `legacy-primary` while none is active. */
function sessionModeOf(state: Pick<CutoverState, 'active'>): SessionMode {
  return state.active()?.loginGroupAuthority() === 'target' ? 'target-primary' : 'legacy-primary';
}

/** Builds the gateway Fastify app with its internal routes and edge catch-all registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(gatewayEnvSchema);
  const clock = options.clock ?? systemClock;
  const instanceId = options.instanceId ?? randomUUID();
  const legacyOrigin = options.legacyOrigin ?? env.LEGACY_ORIGIN;

  // Read before createService opens a pool, so an invalid cut-over or inventory file fails without leaking one.
  const paths = resolveGatewayPaths(env);
  const [variants, facts] = await Promise.all([loadVariants(paths), loadInventoryFacts(paths)]);

  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    // Public ingress admits allUsers, so Cloud Run vouches for no caller: the gateway verifies invocation credentials itself.
    verifierOverride: { invocationTrust: 'verify', ...options.verifierOverride },
    surfaceOf,
    // createService takes an injected pool or the schema whose pool it opens, never both; `shutdown()` ends either.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });
  const { db, client, auth } = app.opt2;
  if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);
  // createService already maps OPT2_MIGRATION_URL into the service client, so no second client is built for migration.
  const migrationClient = options.migrationClient ?? client;

  // Forwarders pass absolute legacy and service URLs, so reply-from has no base.
  await app.register(replyFrom);

  const state = createCutoverState({ db, clock, paths, instanceId, logger: app.log, variants });
  const inflight = createInflightStore({ db, instanceId, unitsOf: (route) => state.active()?.entryFor(route)?.units });

  const identity = options.identityClient ?? createIdentityClient(client);
  const bridge = options.bridgeClient ?? createBridgeClient({ legacyOrigin, hmacKey: env.OPT2_BRIDGE_HMAC_KEY, clock });
  const jar = createLegacyJar(db);
  const tokenCache = createTokenCache({ identity, clock });
  const stateCheck = createSessionStateChecker({ identity, clock, tokenCache });
  const barrier = createSessionBarrier({ db, client: migrationClient });
  const hydrator = createHydrator({ identity, bridge, jar, barrier, clock });
  const resolver = createSessionResolver({ identity, bridge, jar, state: stateCheck });
  const csrf = createCsrfContinuity({ identity, bridge, sessions: resolver, jar, facts, clock });
  const invalidation = createInvalidation({ identity, bridge, jar, tokenCache, state: stateCheck });

  const modes = createResponseModes(facts);
  const matcher = createMatcher({ state, variants, modes, env, clock });
  const windows = createWriteWindowClient({ client: migrationClient, facts });
  const relay: RelayDeps = {
    env,
    invocation: auth.invocationMinter,
    barrier,
    sessionMode: () => sessionModeOf(state),
  };

  await registerCutoverRoutes(app, { state, inflight });
  await registerMarkUsedRoute(app, { jar, bridge });
  await registerRelayRoutes(app, relay);

  const deps: DispatcherDeps = {
    matcher,
    state,
    inflight,
    windows,
    barrier,
    resolver,
    tokenCache,
    stateCheck,
    hydrator,
    csrf,
    invalidation,
    facts,
    auth,
    relay,
    legacyOrigin,
    clock,
  };
  // The edge's one parser keeps every body a raw Buffer, so legacy and services receive the request bytes unchanged.
  await app.register(async (edge) => {
    edge.removeAllContentTypeParsers();
    edge.addContentTypeParser<Buffer>('*', { parseAs: 'buffer', bodyLimit: LEGACY_POST_LIMIT_BYTES }, (_request, body, done) =>
      done(null, body),
    );
    registerEdgeRoute(edge, deps);
  });

  if (options.startBackground !== false) {
    app.addHook('onReady', async () => {
      await state.start();
    });
    app.addHook('onClose', async () => {
      state.stop();
    });
  }
  return app;
}
