// Web's service relay: forwards web's calls to the ten services' versioned APIs with the verified user token and the gateway's own credential.
import {
  AuthDenial,
  hasAnyRole,
  serviceRole,
  stripInboundAuthHeaders,
  type InvocationMinter,
  type Opt2RouteConfig,
  type ServiceIdentity,
  type UserClaims,
} from '@opt2/platform/auth';
import { PATH_PAIRS_HEADER } from '@opt2/platform/legacy-compat';
import {
  LEGACY_POST_LIMIT_BYTES,
  type BaseEnv,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { FailContext } from './fail-closed.js';
import { forwardToTarget, type TargetForwardContext } from './forward-target.js';

/** Service folder names web may call through the relay; the stub is not a relay target. */
export const RELAY_SERVICES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
] as const;

/** One relay target service. */
export type RelayService = (typeof RELAY_SERVICES)[number];

/** Methods of the canonical relay operations (`relayGet|Post|Put|Patch|Delete`). */
export const RELAY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Route of the canonical relay operations. */
export const RELAY_ROUTE_URL = '/internal/v1/relay/:service/*';

/** Role web's invocation credential carries, the only one that opens the relay. */
export const RELAY_CALLER_ROLE = serviceRole('web');

/** Path segments before the callee path: `internal`, `v1`, `relay` and the service. */
const RELAY_PREFIX_SEGMENTS = 4;

/** First callee path segments the relay forwards: the services' public versioned APIs. */
const RELAY_API_VERSIONS: ReadonlySet<string> = new Set(['v1', 'v2']);

/** Origin a callee path is resolved against, as the forward resolves it after the service URL. */
const PATH_RESOLUTION_ORIGIN = 'http://relay.invalid';

// The callee runs its own site check against the same verified token; the alias reaches the relay without the
// platform preHandler, so the canonical form skips it too and both forms stay one transparent pipe.
const RELAY_ROUTE_CONFIG: Opt2RouteConfig = Object.freeze({
  transport: 'service',
  requires: Object.freeze([RELAY_CALLER_ROLE]),
  siteCheck: false,
});

const RELAY_FAIL_CONTEXT: FailContext = Object.freeze({ surface: 'api', route: RELAY_ROUTE_URL });

const RELAY_SERVICE_SET: ReadonlySet<string> = new Set(RELAY_SERVICES);

/** Methods that never write, so their forwarded calls declare nothing in the session barrier. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Identities a relayed call acts for, as the caller verified them. */
export interface RelayAuth {
  /** Raw verified bearer user token, forwarded unchanged. */
  userToken?: string;
  user?: UserClaims;
  /** Verified calling workload; web. */
  caller: ServiceIdentity;
}

/** One relayed call: the callee, its path with the original query, and the verified identities. */
export interface RelayTarget {
  service: string;
  /** Callee path and the original query string, as received. */
  path: string;
  auth: RelayAuth;
}

/** Collaborators of the relay; `app.ts` builds them once. */
export interface RelayDeps {
  env: Pick<BaseEnv, 'OPT2_SERVICE_URLS'>;
  /** Mints the gateway's own invocation credential for the callee. */
  invocation: InvocationMinter;
  barrier: TargetForwardContext['barrier'];
  /** Session mode of the active version, reported with forwarding failures. */
  sessionMode: () => TargetForwardContext['mode'];
}

/** Whether `name` is a relay target. */
export function isRelayService(name: string): name is RelayService {
  return RELAY_SERVICE_SET.has(name);
}

// The platform hook accepts the union of user and service roles, so the role is checked on the credential alone.
/** Whether the verified invocation credential itself is web's. */
export function isRelayCaller(identity: ServiceIdentity | undefined): identity is ServiceIdentity {
  return identity !== undefined && hasAnyRole(identity.roles, [RELAY_CALLER_ROLE]);
}

/** Callee path and raw query of a canonical relay URL: everything after `/internal/v1/relay/<service>`, undecoded. */
function servicePathOf(url: string): string {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const search = queryAt === -1 ? '' : url.slice(queryAt);
  let slash = 0;
  for (let segment = 0; segment < RELAY_PREFIX_SEGMENTS && slash !== -1; segment++) {
    slash = path.indexOf('/', slash + 1);
  }
  return `${slash === -1 ? '/' : path.slice(slash)}${search}`;
}

/**
 * Whether the callee routes `path` (path and raw query) under its public versioned API: the first segment of the path
 * it receives, once dot segments and backslashes are resolved as the forward resolves them, decodes to `v1` or `v2`.
 */
function isVersionedApiPath(path: string): boolean {
  const queryAt = path.indexOf('?');
  const pathPart = queryAt === -1 ? path : path.slice(0, queryAt);
  if (!pathPart.startsWith('/')) return false;
  const [, first = ''] = new URL(`${PATH_RESOLUTION_ORIGIN}${pathPart}`).pathname.split('/', 2);
  try {
    return RELAY_API_VERSIONS.has(decodeURIComponent(first));
  } catch {
    // A malformed escape names no route of the callee.
    return false;
  }
}

/**
 * Forwards a verified web call to `target.service` once; an unknown or unconfigured service, or a callee path outside
 * its public versioned API, answers the legacy 404.
 * @returns The reply, sent or being streamed.
 */
export async function relayHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  target: RelayTarget,
  deps: RelayDeps,
): Promise<FastifyReply> {
  const serviceUrl = isRelayService(target.service) ? deps.env.OPT2_SERVICE_URLS[target.service] : undefined;
  if (serviceUrl === undefined || !isVersionedApiPath(target.path)) {
    // The service-kit not-found handler answers legacy's 404 invalidMethodCall envelope, as the contract declares.
    reply.callNotFound();
    return reply;
  }
  // Web alone reaches the relay, so its path-pair header is the one X-Opt2-* header the callee receives from it.
  const pathPairs = request.headers[PATH_PAIRS_HEADER.toLowerCase()];
  return forwardToTarget(request, reply, {
    service: target.service,
    serviceUrl,
    path: target.path,
    headers: stripInboundAuthHeaders(request.headers, { afterExchange: true }),
    ...(typeof pathPairs === 'string' ? { extraHeaders: { [PATH_PAIRS_HEADER]: pathPairs } } : {}),
    userToken: target.auth.userToken,
    sessionId: target.auth.user?.sid,
    declaresWrite: !SAFE_METHODS.has(request.method),
    mode: deps.sessionMode(),
    isWeb: false,
    failContext: RELAY_FAIL_CONTEXT,
    invocation: deps.invocation,
    barrier: deps.barrier,
  });
}

/** Registers the canonical relay operations in their own context, whose one parser keeps every body a raw Buffer. */
export async function registerRelayRoutes(app: FastifyInstance, deps: RelayDeps): Promise<void> {
  await app.register(async (relay) => {
    relay.removeAllContentTypeParsers();
    relay.addContentTypeParser<Buffer>('*', { parseAs: 'buffer', bodyLimit: LEGACY_POST_LIMIT_BYTES }, (_request, body, done) =>
      done(null, body),
    );
    for (const method of RELAY_METHODS) {
      relay.route<{ Params: { service: string } }>({
        method,
        url: RELAY_ROUTE_URL,
        exposeHeadRoute: false,
        config: { opt2: RELAY_ROUTE_CONFIG },
        handler: async (request, reply) => {
          const { service, user, userToken } = request.opt2Auth;
          if (!isRelayCaller(service)) throw AuthDenial.forbidden();
          const auth: RelayAuth = { userToken, user, caller: service };
          return relayHandler(request, reply, { service: request.params.service, path: servicePathOf(request.url), auth }, deps);
        },
      });
    }
  });
}
