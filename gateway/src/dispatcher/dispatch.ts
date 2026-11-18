// Edge dispatcher: every client request goes to its target service, web or legacy by the active cut-over version alone.
import {
  AuthDenial,
  renderAuthDenial,
  requestToAuthRequest,
  stripInboundAuthHeaders,
  type AuthResult,
  type AuthSetup,
  type Opt2RouteConfig,
} from '@opt2/platform/auth';
import {
  REQUEST_START_COOKIE_NAMES,
  REST_CONSUMED_PARAMS_HEADER,
  UNREGISTERED_SITEID_HEADER,
  isLegacySessionCookie,
  isLegacySessionManaged,
  negotiatesIdentityEncoding,
  parseCookieHeader,
  parseSetCookie,
  requestStartSetCookies,
  type RequestStartOptions,
  type RouteFamily,
} from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import {
  recordLogScope,
  requireRequestContext,
  sendLegacyResponse,
  type Clock,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { InflightSide, InflightStore } from '../cutover/inflight.js';
import type { CutoverState } from '../cutover/state.js';
import type { CutoverEntry, InventoryFacts, RoutingIndex } from '../cutover/types.js';
import type { SessionCarry } from '../session/carry.js';
import type { CsrfContinuity, CsrfHandle } from '../session/csrf.js';
import type { Hydrator } from '../session/hydration.js';
import type { IdentityClient } from '../session/identity-client.js';
import { isTargetLogout, legacySessionEffect, type Invalidation, type LegacyLoginFacts } from '../session/invalidation.js';
import {
  absorbLegacySetCookies,
  isDeletedJarCookie,
  legacyCookieHeader,
  requestSessionCookies,
  targetSetCookiesFrom,
  type JarCookies,
} from '../session/jar.js';
import { sessionModeFor, type SessionMode } from '../session/mode.js';
import {
  sessionIdFromTargetCookies,
  type LegacyBoundResolution,
  type SessionRequestInput,
  type SessionResolution,
  type SessionResolver,
} from '../session/resolve.js';
import type { SessionStateChecker } from '../session/state-check.js';
import { DEFAULT_SITE_ID, type TokenCache } from '../session/token-cache.js';
import type { SessionBarrier } from './barrier.js';
import { UnreadableBodyError, bodyParamsFrom, type BodyParams } from './body.js';
import { failClosed, failContextFor, isTargetUnavailable, unavailableCauseOf, type FailCause, type FailContext } from './fail-closed.js';
import {
  forwardToLegacy,
  type LegacyBeforeSendResult,
  type LegacyForwardContext,
  type LegacySettlement,
  type LegacyUpstream,
} from './forward-legacy.js';
import { forwardToTarget } from './forward-target.js';
import { FIXTURE_AUTHORIZATION_HEADER, applyIdentityEncoding, forwardedHost } from './headers.js';
import {
  RELAY_ALIAS_PREFIX,
  WRITE_KINDS,
  type LegacyDestination,
  type MatchOutcome,
  type Matcher,
  type RelayDestination,
  type RoutedOutcome,
  type TargetDestination,
  type UnavailableReason,
} from './match.js';
import { SAFE_METHODS, isRelayCaller, relayHandler, type RelayDeps } from './relay.js';
import type { SiteRegistry } from './site-registry.js';
import type { WindowCompleteInput, WriteWindowClient } from './write-window.js';

/** Methods of the edge operations (`edgeDelete|Get|Head|Options|Patch|Post|Put`). */
export const EDGE_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const;

/** Longest a request waits for its frozen entry before answering the legacy 503, in milliseconds. */
export const FREEZE_WAIT_MS = 30_000;

/** Route of the edge catch-all. */
export const EDGE_ROUTE_URL = '/*';

/** Route the log lines of a relay alias request carry. */
export const RELAY_ALIAS_ROUTE = `${RELAY_ALIAS_PREFIX}/:service/*`;

const EDGE_ROUTE_CONFIG: Opt2RouteConfig = Object.freeze({ public: true, edge: true });

/** Namespace of the gateway's own routes; the edge dispatches nothing under it. */
const INTERNAL_NAMESPACE = '/internal/v1';

/** Families whose target routes legacy's servlet container and request start never serve: web's runtime files, OPT-2 paths, the bridge. */
const NO_LEGACY_START_FAMILIES: ReadonlySet<RouteFamily> = new Set<RouteFamily>(['static', 'opt2', 'bridge']);

/** Collaborators of the dispatcher; `app.ts` builds each once. */
export interface DispatcherDeps {
  matcher: Matcher;
  state: Pick<CutoverState, 'active' | 'readEpochForWrite' | 'isFrozen' | 'waitUnfrozen'>;
  inflight: Pick<InflightStore, 'register' | 'remove' | 'abandon'>;
  windows: WriteWindowClient;
  barrier: Pick<SessionBarrier, 'declare' | 'record' | 'release' | 'awaitForSession' | 'awaitPositions' | 'awaitOwners'>;
  resolver: SessionResolver;
  tokenCache: Pick<TokenCache, 'get'>;
  /** Identity's record of a session's selected admin site and login snapshot, read for site-less web and fixture requests. */
  identity: Pick<IdentityClient, 'adminSite' | 'snapshot'>;
  /** Legacy's site registry, which decides a remote CFC proxy call's user-token site ({@link cfcTokenSite}); absent, the `siteid` alone decides. */
  sites?: Pick<SiteRegistry, 'siteExists' | 'bindToDomain'>;
  stateCheck: Pick<SessionStateChecker, 'check'>;
  hydrator: Hydrator;
  /** Installs identity's shared session values in the legacy session of a legacy-bound admin request, and imports legacy's changes after it. */
  carry: SessionCarry;
  csrf: CsrfContinuity;
  invalidation: Invalidation;
  /** Inventory facts legacy session effects are read from. */
  facts: InventoryFacts;
  /** The gateway's transports (relay alias) and invocation minter (target forwards). */
  auth: Pick<AuthSetup, 'transports' | 'invocationMinter'>;
  relay: RelayDeps;
  /** Legacy Masa origin, e.g. `http://127.0.0.1:8080`. */
  legacyOrigin: string;
  /** configBean `secureCookies` and `cookieDomain`, which utility.setCookie applies to the request start's cookies. */
  cookieSettings: Required<Pick<RequestStartOptions, 'secure' | 'domain'>>;
  /** Bounds the freeze wait. */
  clock: Clock;
}

/** Handler of the edge catch-all. */
export type EdgeHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>;

/** A keyed outcome the gateway forwards, to a target or to legacy. */
type ForwardedOutcome = RoutedOutcome & { destination: TargetDestination | LegacyDestination };

/** A request routed by one routing index and ready to forward. */
interface Route {
  outcome: ForwardedOutcome;
  index: RoutingIndex | undefined;
}

/** Outcome of opening a write window: routed inside it, or routing changed and the window was closed. */
type WindowAttempt = { ready: true; route: Route } | { ready: false; outcome: RoutedOutcome };

/** Runs `run`; a failure is logged and swallowed, because the step it belongs to must not stop the ones after it. */
async function guarded<T>(request: FastifyRequest, message: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    request.log.error({ error: serializeError(error) }, message);
    return undefined;
  }
}

/** Resources one request holds until a forwarder takes them over: its in-flight row, write window and CSRF claims. */
class Exchange {
  row: { route: string; side: InflightSide } | undefined;
  windowId: string | undefined;
  csrfHandle: CsrfHandle | undefined;
  csrfStartedAt: Date | undefined;
  /** Set once a forwarder owns the row, the window and the claims. */
  forwarded = false;
  private csrfSettlement: Promise<void> | undefined;

  constructor(
    readonly request: FastifyRequest,
    readonly reply: FastifyReply,
    readonly requestId: string,
    readonly body: BodyParams,
    private readonly deps: Pick<DispatcherDeps, 'inflight' | 'windows' | 'csrf'>,
  ) {}

  /** Replaces this request's in-flight row; the row is recorded first, so an insert of uncertain outcome is still removed. */
  async register(route: string, side: InflightSide, windowId?: string): Promise<void> {
    await this.dropRow();
    this.row = { route, side };
    await this.deps.inflight.register({ requestId: this.requestId, route, side, windowId });
  }

  async dropRow(): Promise<void> {
    if (this.row === undefined) return;
    this.row = undefined;
    await this.deps.inflight.remove(this.requestId);
  }

  /** Leaves this request's row to evidence as an orphan, because the target may still commit its write. */
  async abandonRow(): Promise<void> {
    if (this.row === undefined) return;
    this.row = undefined;
    await this.deps.inflight.abandon(this.requestId);
  }

  /** Settles the CSRF claims once: tokens legacy consumed become used, the rest are released. */
  settleCsrf(): Promise<void> {
    this.csrfSettlement ??= this.deps.csrf.afterLegacy(this.csrfHandle, this.csrfStartedAt);
    return this.csrfSettlement;
  }

  /** Reports the window's outcome to migration once; the client never throws. */
  async closeWindow(input: WindowCompleteInput): Promise<void> {
    const windowId = this.windowId;
    if (windowId === undefined) return;
    this.windowId = undefined;
    await this.deps.windows.complete(windowId, input);
  }

  /** Releases whatever no forwarder took over: the window first, then the claims and the row. */
  async release(): Promise<void> {
    if (this.forwarded) return;
    await this.closeWindow({ forwarded: false });
    await guarded(this.request, 'edge CSRF claim release failed', () => this.settleCsrf());
    await guarded(this.request, 'edge in-flight row removal failed', () => this.dropRow());
  }
}

/** Takes the request's CSRF claims while its barrier is awaited; the exchange holds them even when the barrier fails. */
async function claimBehind(ex: Exchange, barrier: Promise<void>, claim: Promise<CsrfHandle | undefined>): Promise<void> {
  const [awaited, claimed] = await Promise.allSettled([barrier, claim]);
  if (claimed.status === 'fulfilled') ex.csrfHandle = claimed.value;
  if (awaited.status === 'rejected') throw awaited.reason;
  if (claimed.status === 'rejected') throw claimed.reason;
}

function isForwarded(outcome: RoutedOutcome): outcome is ForwardedOutcome {
  return outcome.destination.kind === 'target' || outcome.destination.kind === 'legacy';
}

/** Side a destination is forwarded to. */
function sideOf(outcome: RoutedOutcome): InflightSide {
  return outcome.destination.kind === 'target' ? 'target' : 'legacy';
}

/** The keyed outcome of a request already matched as keyed; the relay alias is decided by the path alone. */
function keyed(outcome: MatchOutcome): RoutedOutcome {
  if (outcome.result === undefined) throw new Error('a keyed edge request re-matched as the relay alias');
  return outcome;
}

/** Route a request's log lines carry: its matched entry's route key, else its computed key; {@link RELAY_ALIAS_ROUTE} for the relay alias. */
function loggedRouteOf(outcome: MatchOutcome): string {
  if (outcome.result === undefined) return RELAY_ALIAS_ROUTE;
  return outcome.entry?.route ?? outcome.result.key;
}

/** The entry when its requests register as writes. */
function writeEntryOf(outcome: RoutedOutcome): CutoverEntry | undefined {
  return outcome.entry !== undefined && WRITE_KINDS.has(outcome.entry.kind) ? outcome.entry : undefined;
}

/** `target`-authoritative units of a legacy-bound `legacy-write` entry, which its window must gate. */
function windowUnits(outcome: RoutedOutcome, index: RoutingIndex): string[] {
  const { entry } = outcome;
  if (entry?.kind !== 'legacy-write' || outcome.destination.kind !== 'legacy') return [];
  return entry.units.filter((unit) => index.unitAuthority(unit) === 'target');
}

function sameUnits(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((unit) => set.has(unit));
}

function pathOf(url: string): string {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/** Whether the router reads `url` as in the gateway's own namespace: the path before `?` or `#`, percent-decoded, case-sensitive. */
function isInternalPath(url: string): boolean {
  // The router decoded the same path before matching, so decodeURI cannot throw here.
  const path = decodeURI(url.split(/[?#]/, 1)[0] ?? url);
  return path === INTERNAL_NAMESPACE || path.startsWith(`${INTERNAL_NAMESPACE}/`);
}

function userAgentOf(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  return Array.isArray(value) ? value[0] : value;
}

/** The session input of a keyed request: its original headers, scanned URL scope, scan outcome and the route key's merged params. */
function sessionInputOf(request: FastifyRequest, outcome: RoutedOutcome): SessionRequestInput {
  return {
    path: pathOf(request.url),
    httpMethod: request.method,
    headers: request.headers,
    query: outcome.urlScope,
    params: outcome.result.params,
    scanFailed: outcome.scanFailed,
  };
}

/** `extras` not already in `list`, each once, followed by `list` unchanged. */
function prepend(extras: readonly string[], list: readonly string[]): string[] {
  return [...[...new Set(extras)].filter((value) => !list.includes(value)), ...list];
}

/** `Set-Cookie` values a resolution hands the client. */
function setCookiesOf(resolution: LegacyBoundResolution | undefined): string[] {
  return resolution === undefined || resolution.kind === 'response' ? [] : resolution.setCookies;
}

/** The request start's `Set-Cookie` values for the client's own request, as legacy would send them at `now` under `settings`. */
function requestStartCookiesOf(
  request: FastifyRequest,
  body: BodyParams,
  now: Date,
  settings: DispatcherDeps['cookieSettings'],
): string[] {
  return requestStartSetCookies(
    {
      cookieHeader: request.headers.cookie,
      userAgent: userAgentOf(request),
      query: request.query,
      url: request.url,
      form: body.form,
      sessionManaged: isLegacySessionManaged(pathOf(request.url)),
    },
    { now, secure: settings.secure, domain: settings.domain },
  );
}

/** `list` without request-start cookies, then `start` with the `MXP_TRACKINGID` legacy's session owes in `list` kept for its own; `list` alone without `start`. */
function withRequestStartCookies(list: readonly string[], start: readonly string[] | undefined): string[] {
  if (start === undefined) return [...list];
  const nameOf = (value: string): string => parseSetCookie(value).name.toLowerCase();
  const owedTracking = list.findLast((value) => nameOf(value) === 'mxp_trackingid');
  return [
    ...list.filter((value) => !REQUEST_START_COOKIE_NAMES.has(nameOf(value))),
    ...start.map((value) => (owedTracking !== undefined && nameOf(value) === 'mxp_trackingid' ? owedTracking : value)),
  ];
}

/**
 * The destination's extra headers plus, when REST credential handling consumed params, the header naming them for the callee's
 * route key, {@link UNREGISTERED_SITEID_HEADER} when the user token stands in for a `siteid` naming no registered site, and
 * {@link FIXTURE_AUTHORIZATION_HEADER} with `fixtureAuthorization`, a fixture request's inbound `Authorization`, when given.
 */
function targetExtraHeaders(
  destination: TargetDestination,
  resolution: SessionResolution | undefined,
  unregisteredSiteId: boolean,
  fixtureAuthorization: string | undefined,
): Readonly<Record<string, string>> | undefined {
  const consumed = resolution === undefined || resolution.kind === 'response' ? [] : (resolution.consumedParams ?? []);
  if (consumed.length === 0 && !unregisteredSiteId && fixtureAuthorization === undefined) return destination.extraHeaders;
  return {
    ...destination.extraHeaders,
    ...(consumed.length === 0 ? {} : { [REST_CONSUMED_PARAMS_HEADER]: consumed.join(',') }),
    ...(unregisteredSiteId ? { [UNREGISTERED_SITEID_HEADER]: 'true' } : {}),
    ...(fixtureAuthorization === undefined ? {} : { [FIXTURE_AUTHORIZATION_HEADER]: fixtureAuthorization }),
  };
}

/** A request's user-token site, and whether it stands in for a present, non-empty `siteid` naming no registered site. */
interface TokenSite {
  siteId: string;
  unregisteredSiteId: boolean;
}

/**
 * A remote CFC proxy call's user-token site: a registered `siteid`; else the request host's site, which an absent `siteid` takes
 * only where legacy's default binds it without redirecting; else `default`.
 */
function cfcTokenSite(request: FastifyRequest, siteId: string | undefined, sites: NonNullable<DispatcherDeps['sites']>): TokenSite {
  if (siteId !== undefined && sites.siteExists(siteId)) return { siteId, unregisteredSiteId: false };
  const bound = sites.bindToDomain(forwardedHost(request));
  // Only an absent siteid takes the bindToDomain() default (commentsProxy.cfc:88-112), whose isAdmin=false redirects a
  // partial match and the admin domain before the method runs (contentServer.cfc:196-217).
  const hostSite = siteId === undefined && bound?.match === 'partial' ? undefined : bound?.siteId;
  return { siteId: hostSite ?? DEFAULT_SITE_ID, unregisteredSiteId: siteId !== undefined && siteId !== '' };
}

/** The browser's `Cookie` header with its legacy session cookies swapped in place for the jar's live ones; other cookies unchanged. */
function legacyCookieHeaderFor(browser: string | undefined, jar: JarCookies, now: Date): string {
  const pairs = new Map<string, string>();
  for (const [key, cookie] of Object.entries(jar)) {
    const pair = legacyCookieHeader({ [key]: cookie }, now);
    if (pair !== '') pairs.set(key.toUpperCase(), pair);
  }
  const out: string[] = [];
  for (const segment of (browser ?? '').split(';')) {
    const trimmed = segment.trim();
    if (trimmed === '') continue;
    const equals = trimmed.indexOf('=');
    const name = (equals === -1 ? trimmed : trimmed.slice(0, equals)).trim().toUpperCase();
    if (!isLegacySessionCookie(name)) {
      out.push(trimmed);
      continue;
    }
    const pair = pairs.get(name);
    if (pair === undefined) continue;
    out.push(pair);
    pairs.delete(name);
  }
  out.push(...pairs.values());
  return out.join('; ');
}

/** Target `Set-Cookie` values as the client receives them: a live session cookie the jar holds takes the jar's name and attributes. */
function clientTargetSetCookies(jar: JarCookies, setCookies: readonly string[], now: Date): string[] {
  return setCookies.map((value) => {
    const { name } = parseSetCookie(value);
    if (!isLegacySessionCookie(name)) return value;
    const key = name.toUpperCase();
    const held = jar[key];
    const issued = absorbLegacySetCookies([value]).sessionCookies[key];
    // A deletion keeps identity's own form, so its expiry reaches the browser.
    if (held === undefined || issued === undefined || isDeletedJarCookie(held, now) || isDeletedJarCookie(issued, now)) {
      return value;
    }
    return targetSetCookiesFrom({ [key]: held }, { [key]: issued.value }, now)[0] ?? value;
  });
}

/** Fail-closed cause of a destination the gateway cannot serve. */
function unservedCause(reason: UnavailableReason, ctx: FailContext): FailCause {
  if (reason === 'no-active-version') return { reason: 'no cut-over version is active' };
  if (reason === 'admin-unmapped') return { reason: 'admin action has no web mapping' };
  return { reason: `${ctx.owner ?? 'owning service'} has no service URL` };
}

/** Fail-closed cause of an entry whose freeze outlasted the wait, which no unavailability caused. */
function frozenCause(ctx: FailContext): FailCause {
  return { reason: `${ctx.owner ?? 'route'} entry frozen past the ${FREEZE_WAIT_MS} ms wait`, level: 'warn' };
}

/** Fail-closed cause of an unavailable dependency that stopped a request before it was forwarded. */
function beforeForwardingCause(error: unknown, ctx: FailContext): FailCause {
  const to = ctx.owner === undefined ? '' : ` to ${ctx.owner}`;
  return { reason: `${unavailableCauseOf(error)} before forwarding${to}`, error };
}

/** Answers a destination the gateway serves itself: the legacy-shaped 503 or a body-less status. */
function answer(reply: FastifyReply, outcome: RoutedOutcome): void {
  const { destination } = outcome;
  if (destination.kind === 'unavailable') failClosed(reply, outcome.failContext, unservedCause(destination.reason, outcome.failContext));
  else if (destination.kind === 'bare') reply.code(destination.status).send();
}

/** Creates the edge handler; each step is delegated to the collaborator that owns it. */
export function createDispatcher(deps: DispatcherDeps): EdgeHandler {
  const { matcher, state, windows, clock } = deps;

  /** Waits until `route` is unfrozen within what is left before `deadline`; false once it has passed. */
  const unfrozenBy = async (route: string, deadline: number): Promise<boolean> => {
    const remaining = deadline - clock.now().getTime();
    return remaining > 0 && (await state.waitUnfrozen(route, remaining));
  };

  /** The first frozen route holding a request: its entry's `route`, then the routes its outcome holds it by. */
  const frozenHold = (outcome: RoutedOutcome, route: string | undefined): string | undefined =>
    [...(route === undefined ? [] : [route]), ...(outcome.holdRoutes ?? [])].find((held) => state.isFrozen(held));

  /** Web's service call through the relay alias: only web's verified invocation credential opens it; a user token is optional. */
  const relay = async (request: FastifyRequest, reply: FastifyReply, destination: RelayDestination): Promise<FastifyReply> => {
    let verified: AuthResult;
    try {
      verified = await deps.auth.transports.service.authenticate(requestToAuthRequest(request), { optional: true });
    } catch (error) {
      if (error instanceof AuthDenial) return sendLegacyResponse(reply, renderAuthDenial(error, request));
      throw error;
    }
    recordLogScope(request, { tenantId: verified.user?.tid, userId: verified.user?.sub });
    const caller = verified.service;
    if (!isRelayCaller(caller)) return sendLegacyResponse(reply, renderAuthDenial(AuthDenial.forbidden(), request));
    const auth = { userToken: verified.userToken, user: verified.user, caller };
    return relayHandler(request, reply, { service: destination.service, path: destination.path, auth }, deps.relay);
  };

  /** Opens the entry's write window, re-registers the row with it, and confirms that routing did not change meanwhile. */
  const openWindow = async (
    ex: Exchange,
    outcome: RoutedOutcome,
    entry: CutoverEntry,
    units: string[],
  ): Promise<WindowAttempt> => {
    // Masa's start-up rewrites `tcontent` rows across the table, so a reload's window takes the reload key's scope.
    const scopeKey = outcome.result.family === 'reload' ? outcome.result.baseKey : entry.route;
    // Units written beyond the entry's own route have rows no keyScope of that route bounds.
    const scope =
      outcome.tableScope === true ? { table: true as const } : windows.scope(scopeKey, outcome.result.params, { siteid: outcome.result.siteId });
    const { windowId } = await windows.open({ routeKey: entry.route, units, scope, requestId: ex.requestId });
    ex.windowId = windowId;
    // The store has no upsert, so the row is inserted again with the window and routing re-read after it, as after a freeze.
    await ex.register(entry.route, 'legacy', windowId);
    const { index } = await state.readEpochForWrite();
    const current = keyed(await matcher.match(ex.request, ex.body, index));
    if (
      isForwarded(current) &&
      current.destination.kind === 'legacy' &&
      current.entry?.route === entry.route &&
      frozenHold(current, entry.route) === undefined &&
      sameUnits(windowUnits(current, index), units)
    ) {
      return { ready: true, route: { outcome: current, index } };
    }
    await ex.closeWindow({ forwarded: false });
    await ex.dropRow();
    return { ready: false, outcome: current };
  };

  /** Routes by the active version, waiting out freezes within one budget; undefined once the reply is answered. */
  const routeRequest = async (
    ex: Exchange,
    first: RoutedOutcome,
    firstIndex: RoutingIndex | undefined,
  ): Promise<Route | undefined> => {
    const deadline = clock.now().getTime() + FREEZE_WAIT_MS;
    let outcome = first;
    let index = firstIndex;
    for (;;) {
      if (!isForwarded(outcome)) {
        await ex.dropRow();
        answer(ex.reply, outcome);
        return undefined;
      }
      const entry = writeEntryOf(outcome);
      if (entry === undefined) {
        await ex.dropRow();
        const frozen = frozenHold(outcome, outcome.entry?.route);
        if (frozen === undefined) return { outcome, index };
        if (!(await unfrozenBy(frozen, deadline))) {
          failClosed(ex.reply, outcome.failContext, frozenCause(outcome.failContext));
          return undefined;
        }
        index = state.active();
        outcome = keyed(await matcher.match(ex.request, ex.body, index));
        continue;
      }
      // Registered before the epoch is read, so a transition that freezes this entry waits for the row.
      if (ex.row?.route !== entry.route || ex.row.side !== sideOf(outcome)) await ex.register(entry.route, sideOf(outcome));
      const fresh = (await state.readEpochForWrite()).index;
      index = fresh;
      const current = keyed(await matcher.match(ex.request, ex.body, fresh));
      if (!isForwarded(current) || writeEntryOf(current)?.route !== entry.route || sideOf(current) !== ex.row?.side) {
        outcome = current;
        continue;
      }
      const frozen = frozenHold(current, entry.route);
      if (frozen !== undefined) {
        await ex.dropRow();
        if (!(await unfrozenBy(frozen, deadline))) {
          failClosed(ex.reply, current.failContext, frozenCause(current.failContext));
          return undefined;
        }
        outcome = current;
        continue;
      }
      const units = windowUnits(current, fresh);
      if (units.length === 0) return { outcome: current, index: fresh };
      const attempt = await openWindow(ex, current, entry, units);
      if (attempt.ready) return attempt.route;
      outcome = attempt.outcome;
    }
  };

  /** Ends the legacy session a target-primary browser's ended identity session still holds, as its logout owed. */
  const endOwedLegacySession = async (request: FastifyRequest, userAgent: string | undefined): Promise<void> => {
    const named = sessionIdFromTargetCookies(parseCookieHeader(request.headers.cookie));
    if (named === undefined) return;
    // The check is memoised, so the resolver's own check of the same session reuses this read.
    const check = await deps.stateCheck.check(named);
    if (check.state !== 'active') await deps.invalidation.afterTargetLogout(named, { userAgent });
  };

  /** The session user's `siteID`; '' for a missing or ended session. */
  const userSiteOf = async (sessionId: string): Promise<string> => {
    const siteId = (await deps.identity.snapshot(sessionId))?.loginSnapshot.user.siteID;
    return typeof siteId === 'string' ? siteId : '';
  };

  /**
   * A request's user-token site: its `siteid`, else the session's selected site for web or user's site for a fixture, else
   * `default`. With the site registry, a remote CFC proxy call's is its {@link cfcTokenSite}.
   */
  const tokenSiteOf = async (
    request: FastifyRequest,
    result: RoutedOutcome['result'],
    destination: TargetDestination,
    sessionId: string,
  ): Promise<TokenSite> => {
    // comments.js sends `siteid=undefined` (its `data-siteidid` typo), which names no site, and legacy then loads the comment
    // by id alone; the request host's site is the one whose tenant the target can serve it in.
    if (result.family === 'cfc' && deps.sites !== undefined) return cfcTokenSite(request, result.siteId, deps.sites);
    if (result.siteId !== undefined && result.siteId !== '') return { siteId: result.siteId, unregisteredSiteId: false };
    let selected = '';
    // Web's admin set-up, which also serves the OPT-2 screens, fills a missing rc.siteid from session.siteid (admin/Application.cfc:384-412).
    if (result.family === 'admin' || destination.isWeb) selected = await deps.identity.adminSite(sessionId);
    // The fixture's resolveSite falls back to the session user's siteID (legacy-fixtures/cfml/lib/auth.cfc:27-31).
    else if (result.family === 'fixture') selected = await userSiteOf(sessionId);
    return { siteId: selected === '' ? DEFAULT_SITE_ID : selected, unregisteredSiteId: false };
  };

  /**
   * Whether a resolved session goes on as itself: a flagged one only when its pending logout is judged kept, from the
   * jar's legacy cookies in target-primary, else the request's own.
   */
  const keptThroughPending = async (
    request: FastifyRequest,
    resolution: Extract<LegacyBoundResolution, { sessionId: string }>,
    mode: SessionMode,
    userAgent: string | undefined,
  ): Promise<boolean> => {
    if (resolution.identityEndPending !== true) return true;
    const cookies =
      mode === 'target-primary' && resolution.kind === 'session'
        ? resolution.legacyCookies
        : requestSessionCookies(request.headers.cookie, {}, clock.now());
    return (await deps.invalidation.completePending(resolution.sessionId, { userAgent, cookies })) === 'kept';
  };

  /** Forwards to the owning service or web with the session's site-scoped user token and the gateway's own credential. */
  const toTarget = async (ex: Exchange, route: Route, destination: TargetDestination, mode: SessionMode): Promise<FastifyReply> => {
    const { request, reply } = ex;
    const { result, entry } = route.outcome;
    const userAgent = userAgentOf(request);
    const legacyStart = !NO_LEGACY_START_FAMILIES.has(result.family);
    const identityEncoding = legacyStart && negotiatesIdentityEncoding(request.headers['accept-encoding']);
    const startCookies = legacyStart ? requestStartCookiesOf(request, ex.body, clock.now(), deps.cookieSettings) : undefined;
    let resolution: SessionResolution | undefined;
    let sessionId: string | undefined;
    let userToken: string | undefined;
    let unregisteredSiteId = false;
    let jar: JarCookies = {};
    // A static entry is a file, so no session is resolved for it.
    if (entry?.kind !== 'static') {
      if (mode === 'target-primary') await endOwedLegacySession(request, userAgent);
      resolution = await deps.resolver.resolveSession(sessionInputOf(request, route.outcome), {
        family: result.family,
        mode,
        siteId: result.siteId,
      });
      if (resolution.kind === 'response') {
        if (identityEncoding) applyIdentityEncoding(reply);
        return sendLegacyResponse(reply, resolution);
      }
      // A legacy logout of the session began: unless legacy shows it kept the login, the request goes on anonymously.
      if (resolution.kind === 'session' && (await keptThroughPending(request, resolution, mode, userAgent))) {
        const check = await deps.stateCheck.check(resolution.sessionId);
        if (check.state === 'active') {
          sessionId = resolution.sessionId;
          jar = resolution.legacyCookies;
          const tokenSite = await tokenSiteOf(request, result, destination, sessionId);
          unregisteredSiteId = tokenSite.unregisteredSiteId;
          const minted = await deps.tokenCache.get(sessionId, tokenSite.siteId, check.epoch);
          userToken = minted.token;
          recordLogScope(request, { tenantId: minted.claims.tid, userId: minted.claims.sub });
        } else {
          await deps.invalidation.afterTargetLogout(resolution.sessionId, { userAgent });
        }
      }
    }
    const extras = setCookiesOf(resolution);
    const loggedOut = sessionId;
    const logoutKey = entry?.route ?? result.key;
    const loggedIn = legacySessionEffect(result, deps.facts) === 'login' ? sessionId : undefined;
    ex.forwarded = true;
    return forwardToTarget(request, reply, {
      service: destination.service,
      serviceUrl: destination.serviceUrl,
      path: destination.path,
      headers: stripInboundAuthHeaders(request.headers, { afterExchange: true }),
      userToken,
      // A fixture task run's Basic credential is stripped with Authorization, so it reaches the service in its own header.
      extraHeaders: targetExtraHeaders(
        destination,
        resolution,
        unregisteredSiteId,
        result.family === 'fixture' ? request.headers.authorization : undefined,
      ),
      method: destination.method,
      forwardBody: destination.forwardBody,
      rawTarget: destination.rawTarget,
      sessionId,
      // A safe method writes nothing, unless X-HTTP-Method-Override makes the request one that does.
      declaresWrite:
        writeEntryOf(route.outcome) !== undefined && !(SAFE_METHODS.has(request.method) && SAFE_METHODS.has(result.httpMethod)),
      mode,
      isWeb: destination.isWeb,
      failContext: route.outcome.failContext,
      invocation: deps.auth.invocationMinter,
      barrier: deps.barrier,
      mapSetCookies: async (setCookies) =>
        withRequestStartCookies(
          prepend(extras, mode === 'target-primary' ? clientTargetSetCookies(jar, setCookies, clock.now()) : setCookies),
          startCookies,
        ),
      identityEncoding,
      beforeSend: async () => {
        if (loggedOut !== undefined && isTargetLogout(logoutKey)) {
          await deps.invalidation.afterTargetLogout(loggedOut, { userAgent });
        }
        // Identity has committed the login's epoch bump by now, and the session id is kept, so its next request re-reads it.
        if (loggedIn !== undefined) deps.invalidation.afterTargetLogin(loggedIn);
      },
      onSettled: ex.row === undefined ? undefined : () => ex.dropRow(),
      onAbandoned: ex.row === undefined ? undefined : () => ex.abandonRow(),
    });
  };

  /** Forwards to legacy behind the barrier, with the session's hydrated jar cookies, carried values and CSRF claims, inside any open window. */
  const toLegacy = async (ex: Exchange, route: Route, mode: SessionMode): Promise<FastifyReply> => {
    const { request, reply } = ex;
    const { outcome } = route;
    const { result, entry } = outcome;
    const userAgent = userAgentOf(request);
    const input = sessionInputOf(request, outcome);
    const isStatic = entry?.kind === 'static';
    let resolution: LegacyBoundResolution | undefined;
    let sessionId: string | undefined;
    let cookieHeader: string | undefined;
    // A static entry is a file: it reads no session or data, so it needs no barrier, hydration or claim. Its response maps
    // only a session legacy creates for a target-primary browser naming none; a named session's cookies reach legacy unmapped.
    const mapsSessionCookies =
      !isStatic || (mode === 'target-primary' && sessionIdFromTargetCookies(parseCookieHeader(request.headers.cookie)) === undefined);
    if (!isStatic) {
      if (mode === 'target-primary') await endOwedLegacySession(request, userAgent);
      resolution = await deps.resolver.resolveLegacyBound(input, {
        mode,
        adopt: mode === 'target-primary',
        siteId: result.siteId,
      });
      if (resolution.kind === 'response') return sendLegacyResponse(reply, resolution);
      if (resolution.kind === 'unverified') {
        request.log.warn({ route: result.key }, 'edge legacy-bound session unverified: identity unavailable');
      }
      let barrier: Promise<void> | undefined;
      if (resolution.kind !== 'none') {
        sessionId = resolution.sessionId;
        // A legacy logout of a flagged session began: unless legacy shows it kept the login, legacy sees no session.
        const anonymous = !(await keptThroughPending(request, resolution, mode, userAgent));
        if (mode === 'target-primary') {
          await deps.barrier.awaitForSession(sessionId);
          const check = anonymous ? undefined : await deps.stateCheck.check(sessionId);
          const row =
            check?.state === 'active' ? await deps.hydrator.ensureHydrated(sessionId, check.epoch, { userAgent }) : undefined;
          if (check !== undefined && check.state !== 'active') await deps.invalidation.afterTargetLogout(sessionId, { userAgent });
          // Without a hydrated jar the session is gone, and legacy sees the request anonymously.
          if (row === undefined) sessionId = undefined;
          cookieHeader = legacyCookieHeaderFor(request.headers.cookie, row?.cookies ?? {}, clock.now());
        } else {
          // The claim reads no hydrated jar in legacy-primary, so it is taken while the barrier is awaited.
          barrier = deps.barrier.awaitForSession(sessionId);
          const legacyCookies = resolution.kind === 'session' ? resolution.legacyCookies : {};
          if (Object.keys(legacyCookies).length > 0) {
            cookieHeader = legacyCookieHeaderFor(request.headers.cookie, legacyCookies, clock.now());
          }
          if (anonymous) sessionId = undefined;
        }
      }
      const claim = deps.csrf.beforeLegacy(input, result, mode);
      if (barrier === undefined) ex.csrfHandle = await claim;
      else await claimBehind(ex, barrier, claim);
      // Only admin views read the carried Site Manager values from the legacy session.
      if (sessionId !== undefined && result.family === 'admin') await deps.carry.beforeLegacy(sessionId, mode, { userAgent });
      ex.csrfStartedAt = clock.now();
    }
    const extras = [...setCookiesOf(resolution), ...(ex.csrfHandle?.setCookies ?? [])];
    const session = sessionId;
    const sentCookies = cookieHeader ?? request.headers.cookie;

    /** The session cookies legacy holds for the browser after its response: those it received, overlaid with those it set. */
    const heldCookies = (legacySetCookies: readonly string[]): JarCookies => {
      const set = absorbLegacySetCookies(legacySetCookies).sessionCookies;
      return { ...requestSessionCookies(sentCookies, set, clock.now()), ...set };
    };

    /** The browser's legacy session cookies plus those legacy set, for adopting a legacy login. */
    const loginFacts = (legacySetCookies: readonly string[]): LegacyLoginFacts => ({
      userAgent,
      siteId: result.siteId,
      cookies: heldCookies(legacySetCookies),
    });

    const effect = legacySessionEffect(result, deps.facts);
    /** What beforeSend saw of legacy's response; a login is adopted only once it and legacy's completion both happened. */
    let afterHeaders: { adopted: string | undefined; legacySetCookies: readonly string[] } | undefined;
    let completed = false;

    /** Adopts a legacy login into identity, run by whichever of beforeSend and legacy's completion comes second. */
    const adoptLogin = async (): Promise<void> => {
      if (effect !== 'login' || afterHeaders === undefined) return;
      const { adopted, legacySetCookies } = afterHeaders;
      const loggedIn = adopted ?? session ?? ex.csrfHandle?.sessionId;
      // With no identity session yet, the next target-bound request adopts the logged-in legacy session.
      if (loggedIn === undefined) return;
      await guarded(request, 'edge adoption of legacy login failed', () =>
        deps.invalidation.afterLegacyLogin(loggedIn, mode, loginFacts(legacySetCookies)),
      );
    };

    /** Maps legacy's session cookies at its headers and ends identity's session after a logout legacy performed. */
    const beforeSend = async (upstream: LegacyUpstream): Promise<LegacyBeforeSendResult | undefined> => {
      const legacySetCookies = upstream.headers['set-cookie'] ?? [];
      let setCookies: string[] | undefined;
      let adopted: string | undefined;
      if (mode === 'target-primary') {
        const after = await guarded(request, 'edge adoption after legacy failed', () =>
          deps.resolver.adoptAfterLegacy(input, { mode, setCookies: legacySetCookies, siteId: result.siteId }),
        );
        if (after?.kind === 'session') adopted = after.sessionId;
        // Without the adoption's answer legacy's session cookies are withheld and its other cookies pass.
        const own =
          after === undefined || after.kind === 'response'
            ? legacySetCookies.filter((value) => !isLegacySessionCookie(parseSetCookie(value).name))
            : after.setCookies;
        setCookies = prepend(extras, own);
      } else if (extras.length > 0) {
        setCookies = prepend(extras, legacySetCookies);
      }
      if (effect === 'logout' && session !== undefined) {
        // Not guarded: a failure answers the 503, so legacy's logout is not acknowledged while identity's session lives unmarked.
        await deps.invalidation.afterLegacyLogout(session, { userAgent, cookies: heldCookies(legacySetCookies), mode });
      }
      afterHeaders = { adopted, legacySetCookies };
      // Legacy may have completed already, as it always has in buffer mode; the login is then adopted here.
      if (completed) await adoptLogin();
      return setCookies === undefined ? undefined : { setCookies };
    };

    /**
     * Legacy can no longer commit: once it completed, claims settle from its final ledger and the shared session values
     * it changed reach identity before its last byte leaves; a request it never received releases its window and
     * claims. The row goes either way.
     */
    const onSettled = async (settlement: LegacySettlement): Promise<void> => {
      if (settlement === 'not-sent') {
        await ex.closeWindow({ forwarded: false });
        await guarded(request, 'edge CSRF release after an unsent legacy request failed', () => ex.settleCsrf());
      } else {
        await guarded(request, 'edge CSRF settlement after legacy failed', () => ex.settleCsrf());
        // A login or logout changes the session through adoption or invalidation, so its values are not imported.
        if (session !== undefined && result.family === 'admin' && effect !== 'login' && effect !== 'logout') {
          await guarded(request, 'edge import of shared session values after legacy failed', () =>
            deps.carry.afterLegacy(session, mode, { userAgent }),
          );
        }
        completed = true;
        // beforeSend may have run already, as it does at legacy's headers in stream mode; the login is then adopted here.
        if (afterHeaders !== undefined) await adoptLogin();
      }
      await guarded(request, 'edge in-flight row removal failed', () => ex.dropRow());
    };

    const context: Omit<LegacyForwardContext, 'mode'> = {
      legacyOrigin: deps.legacyOrigin,
      headers: stripInboundAuthHeaders(request.headers, { afterExchange: false }),
      cookieHeader,
      sessionMode: mode,
      beforeSend: mapsSessionCookies ? beforeSend : undefined,
      onSettled,
      failContext: outcome.failContext,
    };
    // Marked before legacy can log out, so an identity end that later fails stays owed; a failed mark forwards nothing.
    if (effect === 'logout' && session !== undefined) await deps.invalidation.beforeLegacyLogout(session, mode);
    const windowed = ex.windowId !== undefined;
    ex.forwarded = true;
    if (!windowed) return forwardToLegacy(request, reply, { ...context, mode: 'stream' });
    // An exchange that ends uncertainly never settles, so its window waits for migration's evidence that legacy stopped.
    return forwardToLegacy(request, reply, {
      ...context,
      mode: 'buffer',
      // Migration records only an HTTP status (100-599); one Fastify rejects is left out, so the window still closes.
      onBuffered: ({ statusCode }) => {
        const status = statusCode >= 100 && statusCode <= 599 ? { legacyStatus: statusCode } : {};
        return ex.closeWindow({ forwarded: true, ...status });
      },
    });
  };

  return async (request, reply) => {
    // A method or path the gateway's own routes lack answers service-kit's legacy 404, never legacy or a target.
    if (isInternalPath(request.url)) {
      reply.callNotFound();
      return reply;
    }
    const { requestId } = requireRequestContext();
    let body: BodyParams;
    try {
      body = bodyParamsFrom(request.headers['content-type'], Buffer.isBuffer(request.body) ? request.body : undefined, request.method);
    } catch (error) {
      if (!(error instanceof UnreadableBodyError)) throw error;
      // Without the body's params the route key is unknown, so neither side may serve the request.
      return failClosed(reply, failContextFor(undefined, request.url), { reason: 'request body unreadable', error, level: 'warn' });
    }
    const index = state.active();
    const first = await matcher.match(request, body, index);
    recordLogScope(request, { route: loggedRouteOf(first) });
    if (first.result === undefined) return relay(request, reply, first.destination);
    const ex = new Exchange(request, reply, requestId, body, deps);
    try {
      const route = await routeRequest(ex, first, index);
      if (route === undefined) return reply;
      const mode = sessionModeFor(route.index);
      const { destination } = route.outcome;
      if (destination.kind === 'target') return await toTarget(ex, route, destination, mode);
      return await toLegacy(ex, route, mode);
    } catch (error) {
      await ex.release();
      if (!isTargetUnavailable(error)) throw error;
      return failClosed(reply, first.failContext, beforeForwardingCause(error, first.failContext));
    } finally {
      await ex.release();
    }
  };
}

/** Registers the edge catch-all for every edge method; `app`'s content parser must keep each body a raw Buffer. */
export function registerEdgeRoute(app: FastifyInstance, deps: DispatcherDeps): void {
  app.route({
    method: [...EDGE_METHODS],
    url: EDGE_ROUTE_URL,
    exposeHeadRoute: false,
    config: { opt2: EDGE_ROUTE_CONFIG },
    handler: createDispatcher(deps),
  });
}
