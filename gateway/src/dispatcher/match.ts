// Route key → active cut-over entry → destination; routing changes only through the active version.
import { stripInboundAuthHeaders } from '@opt2/platform/auth';
import {
  fixtureDispatchPath,
  matchRouteKey,
  scannedRouteKey,
  type RouteKeyOptions,
  type RouteKeyResult,
  type ScannedRouteKeyRequest,
} from '@opt2/platform/legacy-compat';
import type { BaseEnv, Clock } from '@opt2/platform/service-kit';
import { LOCAL_SIGNED_URL_PREFIX, loadStorageHmacKey, verifySignedUrl, type BucketName } from '@opt2/platform/storage';
import { AdminMappingError, mapAdminToWeb, type AdminRequestLike, type AdminWebTarget } from '../admin/map.js';
import type { AdminResponseMode, ResponseModes } from '../admin/response-modes.js';
import type { CutoverState } from '../cutover/state.js';
import type { CutoverEntry, EntryKind, OwningService, RoutingIndex, VariantsFile } from '../cutover/types.js';
import type { BodyParams } from './body.js';
import { failContextFor, type FailContext } from './fail-closed.js';

/** Gateway path prefix web relays its service calls through (`GATEWAY_SERVICE_PREFIX` of the gateway ↔ web contract). */
export const RELAY_ALIAS_PREFIX = '/opt2/svc';

/** Entry kinds whose requests write: they read the epoch and register in `gateway.inflight` before they are routed. */
export const WRITE_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['write', 'legacy-write', 'job']);

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

/** Request facts the matcher reads; a Fastify request satisfies it. */
export interface MatchRequest extends AdminRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

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
  /** Path and query sent to the service: `request.url`, a fixture route's api.cfm dispatch path and query, or an admin action's web path. */
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
  /**
   * The request's route key; for a request halted to legacy, the key it would have had, which its legacy semantics read;
   * for a legacy-bound opt2 request, the key legacy's own pipeline serves it under.
   */
  readonly result: RouteKeyResult;
  readonly entry: CutoverEntry | undefined;
  readonly destination: Exclude<Destination, RelayDestination>;
  readonly failContext: FailContext;
  /** The url scope the key read, as start-up's script protection leaves it. */
  readonly urlScope: Record<string, string>;
  /** Whether legacy's start-up scan fails on the request's url or form scope. */
  readonly scanFailed: boolean;
  /** Cut-over routes besides the entry's whose freeze also holds the request: a reload's own entry and the one behind it. */
  readonly holdRoutes?: readonly string[];
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

/** What serves a routed request: its callee, legacy, or the owner an unavailable target has; undefined without an entry. */
function ownerOf(result: RouteKeyResult, entry: CutoverEntry | undefined, destination: RoutedOutcome['destination']): string | undefined {
  if (destination.kind === 'target') return destination.service;
  if (destination.kind === 'legacy') return 'legacy';
  if (entry === undefined) return undefined;
  // Every target admin action is web's, whatever service owns its entry.
  return result.family === 'admin' ? 'web' : entry.owningService;
}

/** Fail context of a routed request for `url`, with the route key and owner its fail-closed line names. */
export function routedFailContext(
  result: RouteKeyResult,
  entry: CutoverEntry | undefined,
  destination: RoutedOutcome['destination'],
  url: string,
): FailContext {
  const context: FailContext = { ...failContextFor(result, url), route: entry?.route ?? result.key };
  const owner = ownerOf(result, entry, destination);
  return owner === undefined ? context : { ...context, owner };
}

/** A halted request's entry: its unhalted key's entry on legacy, a writer as `legacy-write` so its write window still opens. */
function haltedEntry(entry: CutoverEntry): CutoverEntry {
  return Object.freeze({ ...entry, state: 'legacy', kind: entry.kind === 'write' ? 'legacy-write' : entry.kind });
}

/** The entry of `index` that `key` resolves to, if any. */
function entryOf(index: RoutingIndex, key: RouteKeyResult): CutoverEntry | undefined {
  const route = matchRouteKey(key, index.matchKeys);
  return route === undefined ? undefined : index.entryFor(route);
}

/** A reload request's entry and the other routes whose freeze holds it. */
interface ReloadRouting {
  readonly entry: CutoverEntry | undefined;
  readonly holdRoutes: readonly string[];
}

/**
 * Routing of a reload, which legacy serves and then runs the route behind it: a writer behind it becomes the entry, on
 * legacy as `legacy-write` over its own and the reload's units so its window gates both; otherwise the reload's entry stays.
 */
function reloadRouting(reload: CutoverEntry | undefined, served: CutoverEntry | undefined): ReloadRouting {
  let entry = reload;
  if (served !== undefined && WRITE_KINDS.has(served.kind)) {
    const units = [...new Set([...served.units, ...(reload?.units ?? [])])];
    entry = Object.freeze({ ...served, state: 'legacy', kind: 'legacy-write', units });
  }
  const holdRoutes = [reload, served].flatMap((held) => (held === undefined || held.route === entry?.route ? [] : [held.route]));
  return { entry, holdRoutes: Object.freeze(holdRoutes) };
}

/** A request's key, the entry it routes under, the scan facts it read and, for a reload, the routes also holding it. */
type KeyedMatch = Pick<RoutedOutcome, 'result' | 'entry' | 'urlScope' | 'scanFailed' | 'holdRoutes'>;

/** The scanned key of `request` under `options` and the entry it routes under in `index`, if any. */
function keyedMatch(request: ScannedRouteKeyRequest, options: RouteKeyOptions, index: RoutingIndex | undefined): KeyedMatch {
  const { result: keyed, urlScope, scanFailed, unhalted } = scannedRouteKey(request, options);
  // A key the halt variant replaced has no entry, so legacy serves the request as its unhalted key's legacy entry would.
  const result = unhalted ?? keyed;
  if (index === undefined) return { result, entry: undefined, urlScope, scanFailed };
  const matched = entryOf(index, result);
  // A reload is never halted: scannedRouteKey keys it as sent.
  if (result.afterReload !== undefined) {
    return { result, urlScope, scanFailed, ...reloadRouting(matched, entryOf(index, result.afterReload)) };
  }
  const entry = matched !== undefined && unhalted !== undefined ? haltedEntry(matched) : matched;
  return { result, entry, urlScope, scanFailed };
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
  const legacyOptions: RouteKeyOptions = { ...options, opt2Namespaces: false };
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
        web = mapAdminToWeb({ result, request, modes: deps.modes });
      } catch (error) {
        // A target entry never falls back to legacy.
        if (error instanceof AdminMappingError) return unavailable('admin-unmapped');
        throw error;
      }
      return toWeb(web);
    }
    const { path, search } = splitTarget(request.url);
    const fixturePath = result.family === 'fixture' ? fixtureDispatchPath(path, options) : undefined;
    return toService(entry.owningService, {
      path: fixturePath === undefined ? request.url : `${fixturePath}${search}`,
      isWeb: entry.owningService === 'web',
    });
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

      const keyRequest: ScannedRouteKeyRequest = {
        method: request.method,
        path,
        url: request.url,
        query: queryOf(search),
        form: body.form,
        jsonBody: body.json,
        // A client's X-Opt2-* header is a conclusion, never a fact the key reads; services read the gateway's own.
        headers: stripInboundAuthHeaders(request.headers, { afterExchange: false }),
        multipartFileNames: body.files,
      };
      const keyed = keyedMatch(keyRequest, options, index);
      const routed = (
        { result, entry, urlScope, scanFailed, holdRoutes }: KeyedMatch,
        destination: RoutedOutcome['destination'],
      ): RoutedOutcome => ({
        result,
        entry,
        destination,
        failContext: routedFailContext(result, entry, destination, request.url),
        urlScope,
        scanFailed,
        ...(holdRoutes === undefined ? {} : { holdRoutes }),
      });

      if (index === undefined) return routed(keyed, unavailable('no-active-version'));
      const { result, entry } = keyed;
      // The legacy bridge is reachable only from the gateway and migration, never through the edge.
      if (entry?.owningService === 'gateway') return routed(keyed, NOT_FOUND);
      if (entry === undefined || entry.state === 'legacy') {
        // Legacy serves an OPT-2 namespace path as one of its own (a page, through its root front controller), so it routes as that.
        return routed(result.family === 'opt2' ? keyedMatch(keyRequest, legacyOptions, index) : keyed, LEGACY);
      }
      return routed(keyed, await targetDestination(request, result, entry));
    },
  };
}
