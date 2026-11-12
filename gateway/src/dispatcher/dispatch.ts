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
import { isLegacySessionCookie, parseCookieHeader, parseSetCookie } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import {
  requireRequestContext,
  sendLegacyResponse,
  type Clock,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import type { InflightSide, InflightStore } from '../cutover/inflight.js';
import type { CutoverState } from '../cutover/state.js';
import type { CutoverEntry, EntryKind, InventoryFacts, RoutingIndex } from '../cutover/types.js';
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
  type SessionRequestInput,
  type SessionResolution,
  type SessionResolver,
} from '../session/resolve.js';
import type { SessionStateChecker } from '../session/state-check.js';
import { DEFAULT_SITE_ID, type TokenCache } from '../session/token-cache.js';
import type { SessionBarrier } from './barrier.js';
import { UnreadableBodyError, bodyParamsFrom, type BodyParams } from './body.js';
import { failClosed, failContextFor, isTargetUnavailable } from './fail-closed.js';
import {
  forwardToLegacy,
  type LegacyBeforeSendResult,
  type LegacyForwardContext,
  type LegacySettlement,
  type LegacyUpstream,
} from './forward-legacy.js';
import { forwardToTarget } from './forward-target.js';
import type {
  LegacyDestination,
  MatchOutcome,
  Matcher,
  RelayDestination,
  RoutedOutcome,
  TargetDestination,
} from './match.js';
import { isRelayCaller, relayHandler, type RelayDeps } from './relay.js';
import type { WindowCompleteInput, WriteWindowClient } from './write-window.js';

/** Methods of the edge operations (`edgeDelete|Get|Head|Options|Patch|Post|Put`). */
export const EDGE_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const;

/** Longest a request waits for its frozen entry before answering the legacy 503, in milliseconds. */
export const FREEZE_WAIT_MS = 30_000;

/** Route of the edge catch-all. */
export const EDGE_ROUTE_URL = '/*';

const EDGE_ROUTE_CONFIG: Opt2RouteConfig = Object.freeze({ public: true, edge: true });

/** Entry kinds whose requests read the epoch and register in `gateway.inflight` before they are routed. */
const WRITE_KINDS: ReadonlySet<EntryKind> = new Set<EntryKind>(['write', 'legacy-write', 'job']);

/** Collaborators of the dispatcher; `app.ts` builds each once. */
export interface DispatcherDeps {
  matcher: Matcher;
  state: Pick<CutoverState, 'active' | 'readEpochForWrite' | 'isFrozen' | 'waitUnfrozen'>;
  inflight: Pick<InflightStore, 'register' | 'remove'>;
  windows: WriteWindowClient;
  barrier: Pick<SessionBarrier, 'declare' | 'record' | 'release' | 'awaitForSession' | 'awaitPositions' | 'awaitOwners'>;
  resolver: SessionResolver;
  tokenCache: Pick<TokenCache, 'get'>;
  /** Identity's record of the admin site a session selected, read for site-less admin requests. */
  identity: Pick<IdentityClient, 'adminSite'>;
  stateCheck: Pick<SessionStateChecker, 'check'>;
  hydrator: Hydrator;
  csrf: CsrfContinuity;
  invalidation: Invalidation;
  /** Inventory facts legacy session effects are read from. */
  facts: InventoryFacts;
  /** The gateway's transports (relay alias) and invocation minter (target forwards). */
  auth: Pick<AuthSetup, 'transports' | 'invocationMinter'>;
  relay: RelayDeps;
  /** Legacy Masa origin, e.g. `http://127.0.0.1:8080`. */
  legacyOrigin: string;
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

/** URL scope of a request target; a repeated name holds its values comma-joined, as a CFML scope does. */
function urlScope(url: string): Record<string, string> {
  const queryAt = url.indexOf('?');
  const scope = new Map<string, string>();
  if (queryAt !== -1) {
    for (const [name, value] of new URLSearchParams(url.slice(queryAt + 1))) {
      const previous = scope.get(name);
      scope.set(name, previous === undefined ? value : `${previous},${value}`);
    }
  }
  // fromEntries defines own properties, so a `__proto__` parameter stays data.
  return Object.fromEntries(scope);
}

function userAgentOf(request: FastifyRequest): string | undefined {
  const value = request.headers['user-agent'];
  return Array.isArray(value) ? value[0] : value;
}

/** The session input of a keyed request: its original headers, URL scope and the route key's merged params. */
function sessionInputOf(request: FastifyRequest, outcome: RoutedOutcome): SessionRequestInput {
  return {
    path: pathOf(request.url),
    httpMethod: request.method,
    headers: request.headers,
    query: urlScope(request.url),
    params: outcome.result.params,
  };
}

/** `extras` not already in `list`, each once, followed by `list` unchanged. */
function prepend(extras: readonly string[], list: readonly string[]): string[] {
  return [...[...new Set(extras)].filter((value) => !list.includes(value)), ...list];
}

/** `Set-Cookie` values a resolution hands the client. */
function setCookiesOf(resolution: SessionResolution | undefined): string[] {
  return resolution === undefined || resolution.kind === 'response' ? [] : resolution.setCookies;
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

/** Answers a destination the gateway serves itself: the legacy-shaped 503 or a body-less status. */
function answer(reply: FastifyReply, outcome: RoutedOutcome): void {
  const { destination } = outcome;
  if (destination.kind === 'unavailable') failClosed(reply, outcome.failContext);
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

  /** Web's service call through the relay alias: only web's verified invocation credential opens it; a user token is optional. */
  const relay = async (request: FastifyRequest, reply: FastifyReply, destination: RelayDestination): Promise<FastifyReply> => {
    let verified: AuthResult;
    try {
      verified = await deps.auth.transports.service.authenticate(requestToAuthRequest(request), { optional: true });
    } catch (error) {
      if (error instanceof AuthDenial) return sendLegacyResponse(reply, renderAuthDenial(error, request));
      throw error;
    }
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
    const scope = windows.scope(entry.route, outcome.result.params, { siteid: outcome.result.siteId });
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
      !state.isFrozen(entry.route) &&
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
        const route = outcome.entry?.route;
        if (route === undefined || !state.isFrozen(route)) return { outcome, index };
        if (!(await unfrozenBy(route, deadline))) {
          failClosed(ex.reply, outcome.failContext);
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
      if (state.isFrozen(entry.route)) {
        await ex.dropRow();
        if (!(await unfrozenBy(entry.route, deadline))) {
          failClosed(ex.reply, current.failContext);
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

  /** The site a request's user token is for: its `siteid`, else an admin session's selected site, else `default`. */
  const tokenSiteOf = async (result: RoutedOutcome['result'], sessionId: string): Promise<string> => {
    if (result.siteId !== undefined && result.siteId !== '') return result.siteId;
    // An admin request without a site acts in session.siteid, as legacy's set-up fills rc.siteid (admin/Application.cfc:384-412).
    const selected = result.family === 'admin' ? await deps.identity.adminSite(sessionId) : '';
    return selected === '' ? DEFAULT_SITE_ID : selected;
  };

  /** Forwards to the owning service or web with the session's site-scoped user token and the gateway's own credential. */
  const toTarget = async (ex: Exchange, route: Route, destination: TargetDestination, mode: SessionMode): Promise<FastifyReply> => {
    const { request, reply } = ex;
    const { result, entry } = route.outcome;
    const userAgent = userAgentOf(request);
    let resolution: SessionResolution | undefined;
    let sessionId: string | undefined;
    let userToken: string | undefined;
    let jar: JarCookies = {};
    // A static entry is a file, so no session is resolved for it.
    if (entry?.kind !== 'static') {
      if (mode === 'target-primary') await endOwedLegacySession(request, userAgent);
      resolution = await deps.resolver.resolveSession(sessionInputOf(request, route.outcome), {
        family: result.family,
        mode,
        siteId: result.siteId,
      });
      if (resolution.kind === 'response') return sendLegacyResponse(reply, resolution);
      if (resolution.kind === 'session' && resolution.identityEndPending === true) {
        // A legacy logout of the session began: once identity confirmed the end, the request goes on anonymously.
        await deps.invalidation.completePending(resolution.sessionId);
      } else if (resolution.kind === 'session') {
        const check = await deps.stateCheck.check(resolution.sessionId);
        if (check.state === 'active') {
          sessionId = resolution.sessionId;
          jar = resolution.legacyCookies;
          userToken = await deps.tokenCache.get(sessionId, await tokenSiteOf(result, sessionId), check.epoch);
        } else {
          await deps.invalidation.afterTargetLogout(resolution.sessionId, { userAgent });
        }
      }
    }
    const extras = setCookiesOf(resolution);
    const loggedOut = sessionId;
    const logoutKey = entry?.route ?? result.key;
    ex.forwarded = true;
    return forwardToTarget(request, reply, {
      service: destination.service,
      serviceUrl: destination.serviceUrl,
      path: destination.path,
      headers: stripInboundAuthHeaders(request.headers, { afterExchange: true }),
      userToken,
      extraHeaders: destination.extraHeaders,
      method: destination.method,
      forwardBody: destination.forwardBody,
      sessionId,
      declaresWrite: writeEntryOf(route.outcome) !== undefined,
      mode,
      isWeb: destination.isWeb,
      failContext: route.outcome.failContext,
      invocation: deps.auth.invocationMinter,
      barrier: deps.barrier,
      mapSetCookies: async (setCookies) =>
        prepend(extras, mode === 'target-primary' ? clientTargetSetCookies(jar, setCookies, clock.now()) : setCookies),
      beforeSend: async () => {
        if (loggedOut !== undefined && isTargetLogout(logoutKey)) {
          await deps.invalidation.afterTargetLogout(loggedOut, { userAgent });
        }
      },
      onSettled: ex.row === undefined ? undefined : () => ex.dropRow(),
    });
  };

  /** Forwards to legacy behind the barrier, with the session's hydrated jar cookies and CSRF claims, inside any open window. */
  const toLegacy = async (ex: Exchange, route: Route, mode: SessionMode): Promise<FastifyReply> => {
    const { request, reply } = ex;
    const { outcome } = route;
    const { result, entry } = outcome;
    const userAgent = userAgentOf(request);
    const input = sessionInputOf(request, outcome);
    const isStatic = entry?.kind === 'static';
    let resolution: SessionResolution | undefined;
    let sessionId: string | undefined;
    let cookieHeader: string | undefined;
    // A static entry is a file: it reads no session or data, so it needs no barrier, hydration or claim.
    if (!isStatic) {
      if (mode === 'target-primary') await endOwedLegacySession(request, userAgent);
      resolution = await deps.resolver.resolveLegacyBound(input, {
        mode,
        adopt: mode === 'target-primary',
        siteId: result.siteId,
      });
      if (resolution.kind === 'response') return sendLegacyResponse(reply, resolution);
      if (resolution.kind === 'session') {
        sessionId = resolution.sessionId;
        // A legacy logout of a flagged session began: identity's end completes first, and legacy sees no session.
        const ended = resolution.identityEndPending === true;
        if (ended) await deps.invalidation.completePending(sessionId);
        await deps.barrier.awaitForSession(sessionId);
        if (mode === 'target-primary') {
          const check = ended ? undefined : await deps.stateCheck.check(sessionId);
          const row =
            check?.state === 'active' ? await deps.hydrator.ensureHydrated(sessionId, check.epoch, { userAgent }) : undefined;
          if (check !== undefined && check.state !== 'active') await deps.invalidation.afterTargetLogout(sessionId, { userAgent });
          // Without a hydrated jar the session is gone, and legacy sees the request anonymously.
          if (row === undefined) sessionId = undefined;
          cookieHeader = legacyCookieHeaderFor(request.headers.cookie, row?.cookies ?? {}, clock.now());
        } else {
          if (Object.keys(resolution.legacyCookies).length > 0) {
            cookieHeader = legacyCookieHeaderFor(request.headers.cookie, resolution.legacyCookies, clock.now());
          }
          if (ended) sessionId = undefined;
        }
      }
      ex.csrfHandle = await deps.csrf.beforeLegacy(input, result, mode);
      ex.csrfStartedAt = clock.now();
    }
    const extras = [...setCookiesOf(resolution), ...(ex.csrfHandle?.setCookies ?? [])];
    const session = sessionId;
    const sentCookies = cookieHeader ?? request.headers.cookie;

    /** The browser's legacy session cookies plus those legacy set, for adopting a legacy login. */
    const loginFacts = (legacySetCookies: readonly string[]): LegacyLoginFacts => {
      const set = absorbLegacySetCookies(legacySetCookies).sessionCookies;
      const cookies = { ...requestSessionCookies(sentCookies, set, clock.now()), ...set };
      return { userAgent, siteId: result.siteId, cookies };
    };

    const effect = legacySessionEffect(result, mode, deps.facts);
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

    /** Maps legacy's session cookies at its headers and ends identity's session after a legacy logout. */
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
        // Not guarded: a failure answers the 503, so legacy's logout is not acknowledged while identity's session lives.
        await deps.invalidation.afterLegacyLogout(session);
      }
      afterHeaders = { adopted, legacySetCookies };
      // Legacy may have completed already, as it always has in buffer mode; the login is then adopted here.
      if (completed) await adoptLogin();
      return setCookies === undefined ? undefined : { setCookies };
    };

    /**
     * Legacy can no longer commit: once it completed, claims settle from its final ledger before its last byte leaves;
     * a request it never received releases its window and claims. The row goes either way.
     */
    const onSettled = async (settlement: LegacySettlement): Promise<void> => {
      if (settlement === 'not-sent') {
        await ex.closeWindow({ forwarded: false });
        await guarded(request, 'edge CSRF release after an unsent legacy request failed', () => ex.settleCsrf());
      } else {
        await guarded(request, 'edge CSRF settlement after legacy failed', () => ex.settleCsrf());
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
      beforeSend: isStatic ? undefined : beforeSend,
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
      onBuffered: (res) => ex.closeWindow({ forwarded: true, legacyStatus: res.statusCode }),
    });
  };

  return async (request, reply) => {
    const { requestId } = requireRequestContext();
    let body: BodyParams;
    try {
      body = bodyParamsFrom(request.headers['content-type'], Buffer.isBuffer(request.body) ? request.body : undefined, request.method);
    } catch (error) {
      if (!(error instanceof UnreadableBodyError)) throw error;
      // Without the body's params the route key is unknown, so neither side may serve the request.
      request.log.warn({ error: serializeError(error) }, 'edge request body unreadable');
      return failClosed(reply, failContextFor(undefined, request.url));
    }
    const index = state.active();
    const first = await matcher.match(request, body, index);
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
      request.log.warn({ error: serializeError(error) }, 'edge dependency unavailable before forwarding');
      return failClosed(reply, first.failContext);
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
