// Route key → active cut-over entry → destination; routing changes only through the active version.
import { stripInboundAuthHeaders } from '@opt2/platform/auth';
import {
  matchRouteKey,
  routeKeyForRequest,
  type RouteKeyOptions,
  type RouteKeyRequest,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import { LOCAL_SIGNED_URL_PREFIX, loadStorageHmacKey, verifySignedUrl, type BucketName } from '@opt2/platform/storage';
import { AdminMappingError, mapAdminToWeb, type AdminRequestLike, type AdminWebTarget } from '../admin/map.js';
import type { AdminResponseMode, ResponseModes } from '../admin/response-modes.js';
import type { CutoverState } from '../cutover/state.js';
import type { CutoverEntry, OwningService, RoutingIndex, VariantsFile } from '../cutover/types.js';
import type { BodyParams } from './body.js';
import { failContextFor, type FailContext } from './fail-closed.js';

/** Gateway path prefix web relays its service calls through (`GATEWAY_SERVICE_PREFIX` of the gateway ↔ web contract). */
export const RELAY_ALIAS_PREFIX = '/opt2/svc';

/** Owner of each bucket, the service its `/opt2/files/<bucket>/**` entry names. */
export const BUCKET_OWNERS: Readonly<Record<BucketName, OwningService>> = Object.freeze({
  'content-files': 'strategies-content',
  'reporting-exports': 'reporting',
  'finance-attachments': 'finance',
  'esignature-documents': 'e-signature',
});

const RELAY_PATH_PREFIX = `${RELAY_ALIAS_PREFIX}/`;
// Decided on the computed key, which is decoded and lower-cased, so no spelling of the path skips verification.
const SIGNED_FILE_KEY_PREFIX = `opt2:${LOCAL_SIGNED_URL_PREFIX}`;

/** Request facts the matcher reads; a Fastify request with its raw buffered body satisfies it. */
export type MatchRequest = AdminRequestLike;

/** Why the gateway cannot serve a request; dispatch answers the legacy-shaped 503. */
export type UnavailableReason = 'no-active-version' | 'admin-unmapped' | 'no-service-url';

/** Web's service call through the relay alias; `relay.ts` validates `service`. */
export interface RelayDestination {
  readonly kind: 'relay';
  readonly service: string;
  /** Service path and the original query string. */
  readonly path: string;
}

/** The untouched legacy origin. */
export interface LegacyDestination {
  readonly kind: 'legacy';
}

/** Fail closed with the legacy 503. */
export interface UnavailableDestination {
  readonly kind: 'unavailable';
  readonly reason: UnavailableReason;
}

/** A body-less answer from the gateway itself. */
export interface BareDestination {
  readonly kind: 'bare';
  readonly status: 403 | 404;
}

/** The owning service, or web for admin actions and web entries. */
export interface TargetDestination {
  readonly kind: 'target';
  readonly service: OwningService;
  readonly serviceUrl: string;
  /** Path and query sent to the service: `request.url`, or the web path of an admin action. */
  readonly path: string;
  readonly isWeb: boolean;
  /** Gateway-authored headers web receives for an admin action. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly responseMode?: AdminResponseMode;
  readonly contentType?: string;
  /** Method web receives for an admin action; absent means the request's own. */
  readonly method?: string;
  /** False when web must receive no body; absent means the body is forwarded. */
  readonly forwardBody?: boolean;
}

/** Where a request goes. */
export type Destination = RelayDestination | LegacyDestination | UnavailableDestination | BareDestination | TargetDestination;

/** A relay alias request, which is not keyed. */
export interface RelayOutcome {
  readonly result: undefined;
  readonly entry: undefined;
  readonly destination: RelayDestination;
  readonly failContext: FailContext;
}

/** A keyed request with the entry it matched, if any. */
export interface RoutedOutcome {
  readonly result: RouteKeyResult;
  readonly entry: CutoverEntry | undefined;
  readonly destination: Exclude<Destination, RelayDestination>;
  readonly failContext: FailContext;
}

/** Outcome of matching one request. */
export type MatchOutcome = RelayOutcome | RoutedOutcome;

/** Resolves requests against a routing index. */
export interface Matcher {
  /** Matches against `index`, by default the cached active version; reads only the storage key, never calls a service. */
  match(request: MatchRequest, body: BodyParams, index?: RoutingIndex): Promise<MatchOutcome>;
}

/** Collaborators of {@link createMatcher}. */
export interface MatcherDeps {
  state: Pick<CutoverState, 'active'>;
  variants: VariantsFile;
  modes: ResponseModes;
  env: Pick<BaseEnv, 'OPT2_SERVICE_URLS' | 'OPT2_STORAGE_ADAPTER' | 'OPT2_STATE_DIR'>;
  clock: Clock;
  /** Legacy registries and settings the key depends on (site registry, admin dir, reload key); variants come from `variants`. */
  routeKeyOptions?: Omit<RouteKeyOptions, 'variants'>;
}

const LEGACY: LegacyDestination = Object.freeze({ kind: 'legacy' });
const NOT_FOUND: BareDestination = Object.freeze({ kind: 'bare', status: 404 });
const FORBIDDEN: BareDestination = Object.freeze({ kind: 'bare', status: 403 });

function unavailable(reason: UnavailableReason): UnavailableDestination {
  return Object.freeze({ kind: 'unavailable', reason });
}

/** Path and `?query` (or '') of a request target. */
function splitTarget(url: string): { path: string; search: string } {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? { path: url, search: '' } : { path: url.slice(0, queryAt), search: url.slice(queryAt) };
}

/** URL scope of a query string; a repeated name maps to its values in order. */
function queryOf(search: string): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(search)) {
    const previous = query.get(name);
    if (previous === undefined) query.set(name, value);
    else if (typeof previous === 'string') query.set(name, [previous, value]);
    else previous.push(value);
  }
  // fromEntries defines own properties, so a `__proto__` parameter stays data.
  return Object.fromEntries(query);
}

/** The relay destination of a path under the alias. */
function relayOf(path: string, search: string): RelayDestination {
  const rest = path.slice(RELAY_PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  const service = slash === -1 ? rest : rest.slice(0, slash);
  const servicePath = slash === -1 ? '' : rest.slice(slash + 1);
  return Object.freeze({ kind: 'relay', service, path: `/${servicePath}${search}` });
}

/** Creates the matcher; the storage HMAC key is read on first signed-URL use, only for the local adapter. */
export function createMatcher(deps: MatcherDeps): Matcher {
  const options: RouteKeyOptions = { ...deps.routeKeyOptions, variants: deps.variants.variants };
  let hmacKey: Promise<Buffer> | undefined;

  /** The memoised key read; a failed read is forgotten so the next request retries it. */
  const storageKey = (): Promise<Buffer> => {
    hmacKey ??= loadStorageHmacKey(deps.env.OPT2_STATE_DIR).catch((error: unknown) => {
      hmacKey = undefined;
      throw error;
    });
    return hmacKey;
  };

  const toService = (
    service: OwningService,
    target: Omit<TargetDestination, 'kind' | 'service' | 'serviceUrl'>,
  ): TargetDestination | UnavailableDestination => {
    const serviceUrl = deps.env.OPT2_SERVICE_URLS[service];
    if (serviceUrl === undefined) return unavailable('no-service-url');
    return Object.freeze({ kind: 'target', service, serviceUrl, ...target });
  };

  const toWeb = (web: AdminWebTarget): TargetDestination | UnavailableDestination => {
    const target = {
      path: web.path,
      isWeb: true,
      extraHeaders: web.headers,
      responseMode: web.responseMode,
      method: web.method,
      forwardBody: web.forwardBody,
    };
    return toService('web', web.contentType === undefined ? target : { ...target, contentType: web.contentType });
  };

  const targetDestination = async (
    request: MatchRequest,
    body: BodyParams,
    result: RouteKeyResult,
    entry: CutoverEntry,
  ): Promise<Exclude<Destination, RelayDestination>> => {
    if (result.key.startsWith(SIGNED_FILE_KEY_PREFIX)) {
      if (deps.env.OPT2_STORAGE_ADAPTER !== 'local') return NOT_FOUND;
      const verified = verifySignedUrl(request.url, deps.clock.now(), await storageKey());
      if (!verified.ok) return FORBIDDEN;
      return toService(entry.owningService, { path: request.url, isWeb: false });
    }
    if (result.family === 'admin') {
      let web: AdminWebTarget;
      try {
        web = mapAdminToWeb({ result, request, modes: deps.modes, form: body.form });
      } catch (error) {
        // A target entry never falls back to legacy.
        if (error instanceof AdminMappingError) return unavailable('admin-unmapped');
        throw error;
      }
      return toWeb(web);
    }
    return toService(entry.owningService, { path: request.url, isWeb: entry.owningService === 'web' });
  };

  return {
    async match(request, body, index = deps.state.active()) {
      const { path, search } = splitTarget(request.url);
      if (path.startsWith(RELAY_PATH_PREFIX)) {
        return {
          result: undefined,
          entry: undefined,
          destination: relayOf(path, search),
          failContext: failContextFor(undefined, request.url),
        };
      }

      const keyRequest: RouteKeyRequest = {
        method: request.method,
        path,
        query: queryOf(search),
        form: body.form,
        jsonBody: body.json,
        // A client's X-Opt2-* header is a conclusion, never a fact the key reads; services read the gateway's own.
        headers: stripInboundAuthHeaders(request.headers, { afterExchange: false }),
        multipartFileNames: body.files,
      };
      const result = routeKeyForRequest(keyRequest, options);
      const routed = (entry: CutoverEntry | undefined, destination: RoutedOutcome['destination']): RoutedOutcome => ({
        result,
        entry,
        destination,
        failContext: failContextFor(result, request.url),
      });

      if (index === undefined) return routed(undefined, unavailable('no-active-version'));
      const route = matchRouteKey(result, index.matchKeys);
      const entry = route === undefined ? undefined : index.entryFor(route);
      if (entry === undefined) return routed(undefined, LEGACY);
      // The legacy bridge is reachable only from the gateway and migration, never through the edge.
      if (entry.owningService === 'gateway') return routed(entry, NOT_FOUND);
      if (entry.state === 'legacy') return routed(entry, LEGACY);
      return routed(entry, await targetDestination(request, body, result, entry));
    },
  };
}
