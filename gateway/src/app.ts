// Composition root of the gateway: service-kit plus the cut-over, session, admin and dispatcher modules; never listens.
import { randomUUID } from 'node:crypto';
import replyFrom from '@fastify/reply-from';
import { LEGACY_REQUEST_HEAD_LIMIT_BYTES } from '@opt2/platform/legacy-compat';
import {
  LEGACY_POST_LIMIT_BYTES,
  baseEnvSchema,
  checkProcessEnv,
  createService,
  envUrl,
  loadEnv,
  optionalEnvString,
  requiredEnvString,
  systemClock,
  z,
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
import { loadInventoryFacts, loadTableOwnership, loadVariants } from './cutover/loader.js';
import { resolveGatewayPaths } from './cutover/paths.js';
import { registerCutoverRoutes } from './cutover/routes.js';
import { createCutoverState } from './cutover/state.js';
import type { LoadedInventoryFacts, OwnershipUnit, RoutingIndex } from './cutover/types.js';
import { createSessionBarrier } from './dispatcher/barrier.js';
import { registerEdgeRoute, type DispatcherDeps } from './dispatcher/dispatch.js';
import { createMatcher, type MatcherDeps } from './dispatcher/match.js';
import { RELAY_SERVICES, registerRelayRoutes, type RelayDeps } from './dispatcher/relay.js';
import { replyFromOptions } from './dispatcher/response-head.js';
import { createSiteRegistry } from './dispatcher/site-registry.js';
import { createWriteWindowClient } from './dispatcher/write-window.js';
import { jarIdleLimitMs, sessionTimeoutMinutes, trackJarActivity } from './session/activity.js';
import { createBridgeClient, createSiteListClient, type BridgeClient } from './session/bridge-client.js';
import { createSessionCarry } from './session/carry.js';
import { createCsrfContinuity } from './session/csrf.js';
import { createHydrator } from './session/hydration.js';
import { createIdentityClient, type IdentityClient } from './session/identity-client.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, createInvalidation } from './session/invalidation.js';
import { createLegacyJar } from './session/jar.js';
import { registerMarkUsedRoute } from './session/mark-used-route.js';
import { sessionModeFor } from './session/mode.js';
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

/** Services the gateway calls in every environment: the relay services, identity among them, and web. */
const REQUIRED_SERVICES: readonly string[] = [...RELAY_SERVICES, 'web'];

/** True for a Masa setting that is an expression, `${…}` or `{{…}}`, which the gateway does not evaluate. */
function isSettingExpression(value: string): boolean {
  return (value.startsWith('${') && value.endsWith('}')) || (value.startsWith('{{') && value.endsWith('}}'));
}

/**
 * Base variables plus LEGACY_ORIGIN, OPT2_CUTOVER_DIR, OPT2_BRIDGE_HMAC_KEY, Masa's reload key, `appreload` when blank
 * or unset, Masa's session timeout in minutes, read as identity reads it: unset or an expression as unset, and Masa's
 * request timeout in seconds, 1000 when blank or unset.
 */
const gatewayVariables = baseEnvSchema.extend({
  LEGACY_ORIGIN: envUrl(),
  OPT2_CUTOVER_DIR: optionalEnvString(),
  OPT2_BRIDGE_HMAC_KEY: requiredEnvString(),
  MURA_APPRELOADKEY: requiredEnvString(z.string().default('appreload')),
  MURA_SESSIONTIMEOUT: z
    .preprocess(
      (value) => (typeof value === 'string' && !isSettingExpression(value) ? value : undefined),
      z
        .string()
        .refine((value) => value.trim() === '' || Number.isFinite(Number(value)), 'must be blank or a number of minutes')
        .optional(),
    )
    .transform(sessionTimeoutMinutes),
  MURA_REQUESTTIMEOUT: z
    .string()
    .refine(
      (value) => value.trim() === '' || (Number.isFinite(Number(value)) && Number(value) > 0),
      'must be blank or a positive number of seconds',
    )
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? DEFAULT_REQUEST_TIMEOUT_SECONDS : Number(value))),
});

/** Gateway variables requiring its own name, its database and each callee's URL: the required services, the stub locally, and migration. */
export const gatewayEnvSchema = gatewayVariables.superRefine(
  (env, ctx) => {
    // createService maps OPT2_MIGRATION_URL over the map's entry, so either one names migration.
    const callees = [...REQUIRED_SERVICES, ...(env.OPT2_ENV === 'local' ? ['stub'] : []), 'migration'];
    checkProcessEnv(env, ctx, { service: SERVICE_NAME, callees, database: true });
  },
  // Runs even when other variables failed, so loadEnv lists every issue at once.
  { when: () => true },
);

/** Parsed gateway environment. */
export type GatewayEnv = Readonly<LoadedEnv<typeof gatewayEnvSchema>>;

/** Route-key settings legacy configures: the reload key, the entities' remote functions, and the verified site registry when given. */
export function routeKeyOptionsOf(
  env: Pick<GatewayEnv, 'MURA_APPRELOADKEY'>,
  facts: Pick<LoadedInventoryFacts, 'entityRemoteFunctions'>,
  siteExists?: (siteId: string) => boolean,
): NonNullable<MatcherDeps['routeKeyOptions']> {
  const options = { appReloadKey: env.MURA_APPRELOADKEY, entityRemoteFunctions: facts.entityRemoteFunctions };
  return siteExists === undefined ? options : { ...options, siteExists };
}

const NO_OWNERS: ReadonlySet<string> = new Set();

/** Owners of the active version's `target`-authoritative units, the only ones the reverse projector writes; memoised per routing index. */
export function projectedOwnersOf(
  units: readonly Pick<OwnershipUnit, 'unit' | 'owner'>[],
  active: () => RoutingIndex | undefined,
): () => ReadonlySet<string> {
  let seen: { index: RoutingIndex; owners: ReadonlySet<string> } | undefined;
  return () => {
    // A stale cache reads as no version, so the version last seen stays in force until a refresh succeeds.
    const index = active() ?? seen?.index;
    if (index === undefined) return NO_OWNERS;
    if (seen?.index !== index) {
      const owners = units.filter(({ unit }) => index.unitAuthority(unit) === 'target').map(({ owner }) => owner);
      seen = { index, owners: new Set(owners) };
    }
    return seen.owners;
  };
}

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
  /** False skips loading the active version and the site registry, and their refresh loops (route matrix export); defaults to true. */
  startBackground?: boolean;
}

/** `admin` for paths under the legacy admin directory, the admin route family; `api` for every other path. */
function surfaceOf(request: FastifyRequest): LegacySurface {
  const query = request.url.indexOf('?');
  const path = (query === -1 ? request.url : request.url.slice(0, query)).toLowerCase();
  return path === ADMIN_DIR || path.startsWith(`${ADMIN_DIR}/`) ? 'admin' : 'api';
}

/** Builds the gateway Fastify app with its internal routes and edge catch-all registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(gatewayEnvSchema);
  const clock = options.clock ?? systemClock;
  const instanceId = options.instanceId ?? randomUUID();
  const legacyOrigin = options.legacyOrigin ?? env.LEGACY_ORIGIN;

  // Read before createService opens a pool, so an invalid cut-over or inventory file fails without leaking one.
  const paths = resolveGatewayPaths(env);
  const [variants, facts, ownership] = await Promise.all([loadVariants(paths), loadInventoryFacts(paths), loadTableOwnership(paths)]);

  const app = await createService({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    env,
    clock,
    // Public ingress admits allUsers, so Cloud Run vouches for no caller: the gateway verifies invocation credentials itself.
    verifierOverride: { invocationTrust: 'verify', ...options.verifierOverride },
    surfaceOf,
    // Legacy answers its own start-up scan failures; the gateway relays the request.
    legacyStartupScan: false,
    // Clients reach legacy through the gateway, so it admits exactly the request heads legacy admits.
    maxHeaderSize: LEGACY_REQUEST_HEAD_LIMIT_BYTES,
    // createService takes an injected pool or the schema whose pool it opens, never both; `shutdown()` ends either.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });
  const { db, client, auth } = app.opt2;
  if (db === undefined) throw new Error(`${SERVICE_NAME}: createService opened no database`);
  // createService already maps OPT2_MIGRATION_URL into the service client, so no second client is built for migration.
  const migrationClient = options.migrationClient ?? client;

  // Forwarders pass absolute legacy and service URLs, so reply-from has no base.
  await app.register(replyFrom, replyFromOptions());

  const state = createCutoverState({ db, clock, paths, instanceId, logger: app.log, variants });
  const inflight = createInflightStore({ db, instanceId, unitsOf: (route) => state.active()?.entryFor(route)?.units });

  const identity = options.identityClient ?? createIdentityClient(client);
  const bridge = options.bridgeClient ?? createBridgeClient({ legacyOrigin, hmacKey: env.OPT2_BRIDGE_HMAC_KEY, clock });
  const jar = createLegacyJar(db, { purgeIdleAfterMs: jarIdleLimitMs(env.MURA_SESSIONTIMEOUT) });
  const tokenCache = createTokenCache({ identity, clock });
  // Every check that finds a session active is its activity, so the jar's idle clock runs as identity's does.
  const stateCheck = trackJarActivity({
    states: createSessionStateChecker({ identity, clock, tokenCache }),
    jar,
    clock,
    logger: app.log,
  });
  const projectedOwners = projectedOwnersOf(ownership.units, () => state.active());
  const barrier = createSessionBarrier({ db, client: migrationClient, projectedOwners });
  const hydrator = createHydrator({ identity, bridge, jar, barrier, clock });
  const carry = createSessionCarry({ identity, bridge, jar, clock });
  const resolver = createSessionResolver({
    identity,
    bridge,
    jar,
    state: stateCheck,
    clock,
    attachmentIdleMs: env.MURA_SESSIONTIMEOUT * 60_000,
  });
  const csrf = createCsrfContinuity({ identity, bridge, sessions: resolver, jar, facts, clock });
  const invalidation = createInvalidation({
    identity,
    bridge,
    jar,
    tokenCache,
    state: stateCheck,
    logger: app.log,
    requestTimeoutMs: env.MURA_REQUESTTIMEOUT * 1000,
    clock,
  });

  const modes = createResponseModes(facts);
  // Site existence and host binding come only from legacy's own registry; with background loops off, route keys keep their
  // every-site default and a remote CFC proxy call's token site is its siteid.
  const siteList = createSiteListClient({ legacyOrigin, hmacKey: env.OPT2_BRIDGE_HMAC_KEY, clock });
  const sites =
    options.startBackground === false ? undefined : createSiteRegistry({ list: () => siteList.listSites(), logger: app.log });
  const routeKeyOptions = routeKeyOptionsOf(env, facts, sites?.siteExists);
  const matcher = createMatcher({ state, variants, modes, env, clock, routeKeyOptions });
  const windows = createWriteWindowClient({ client: migrationClient, facts });
  const relay: RelayDeps = {
    env,
    invocation: auth.invocationMinter,
    barrier,
    sessionMode: () => sessionModeFor(state.active()),
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
    identity,
    sites,
    stateCheck,
    hydrator,
    carry,
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

  if (sites !== undefined) {
    app.addHook('onReady', async () => {
      await state.start();
      await sites.start();
    });
    app.addHook('onClose', async () => {
      state.stop();
      sites.stop();
    });
  }
  return app;
}
