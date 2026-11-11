// CSRF single use across the seam for legacy-bound requests: identity's claims around legacy's own token validation.
import {
  CSRF_FIELD_EXPIRES,
  CSRF_FIELD_TOKEN,
  CSRF_HEADER_EXPIRES,
  CSRF_HEADER_TOKEN,
  cfDateTimeFormat,
  normaliseRouteKey,
  type RouteKeyResult,
} from '@opt2/platform/legacy-compat';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { CsrfValidation, InventoryFacts, RouteFacts } from '../cutover/types.js';
import type { BridgeClient } from './bridge-client.js';
import type { IdentityClient } from './identity-client.js';
import { isDeletedJarCookie, type JarCookies, type LegacyJar } from './jar.js';
import type { SessionMode } from './mode.js';
import type { SessionRequestInput, SessionResolver } from './resolve.js';

/** Bridge wire time in the legacy server's zone, the space-separated form the bridge parses. */
const WIRE_TIME_MASK = 'yyyy-MM-dd HH:nn:ss.lll';

/** The session-managed JSON API family, whose `X-csrf_token*` headers replace the fields (jsonApiUtility.cfc:837-844). */
const HEADER_FAMILY = 'api';

/** Legacy disables session management for /_api/rest/ (applicationSettings.cfm:179), so no ledger changes there. */
const SESSIONLESS_FAMILY = 'rest';

/** Validation assumed for a route the inventory does not list; a claim legacy leaves unconsumed is released at settle. */
const UNLISTED_VALIDATION: CsrfValidation = 'validates';

/** A legacy-bound request's CSRF state, from before forwarding until the legacy response has completed. */
export interface CsrfHandle {
  /** Identity session id. */
  sessionId: string;
  /** ColdFusion `session.sessionid` the bridge checks the cookies against. */
  legacySessionId: string;
  /** Live jar cookies that attach the legacy session the request runs in. */
  legacyCookies: JarCookies;
  /** Tokens claimed `pending-legacy` for this request. */
  claimedTokens: string[];
  /** Wire time at forwarding start: ledger entries used at or after it were consumed during the request. */
  since: string;
  /** The browser's `User-Agent`, which bridge session calls must forward. */
  userAgent?: string | undefined;
  /** `Set-Cookie` values the client must receive when resolution adopted the legacy session. */
  setCookies: string[];
}

/** The gateway's part of CSRF single use for requests legacy serves; target routes consume through identity. */
export interface CsrfContinuity {
  /**
   * Claims the request's token when its branch validates, before forwarding; a reload key is judged by its
   * `afterReload` route. Undefined when no legacy ledger needs settling.
   */
  beforeLegacy(
    request: SessionRequestInput,
    route: string | RouteKeyResult,
    mode: SessionMode,
  ): Promise<CsrfHandle | undefined>;
  /** After the legacy response: tokens consumed since `startedAt` (else `handle.since`) become used; other claims are released. */
  afterLegacy(handle: CsrfHandle | undefined, startedAt?: Date): Promise<void>;
}

/** Dependencies of {@link createCsrfContinuity}. */
export interface CsrfContinuityOptions {
  identity: Pick<IdentityClient, 'claim' | 'settle'>;
  bridge: Pick<BridgeClient, 'markUsed' | 'usedSince'>;
  sessions: Pick<SessionResolver, 'resolveLegacyBound'>;
  jar: Pick<LegacyJar, 'get'>;
  facts: InventoryFacts;
  /** Stamps `since` and `usedAt`; defaults to the system clock. */
  clock?: Clock;
}

/** The route legacy serves for a request: normalised key, family and requested site. */
interface ServedRoute {
  key: string;
  family: string;
  siteId?: string | undefined;
}

/** The legacy session an identity session runs in on legacy. */
interface AttachedSession {
  legacySessionId: string;
  cookies: JarCookies;
}

/** A request header's value; names arrive lower-cased, repeated values joined as Node joins them. */
function headerText(headers: SessionRequestInput['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** A merged param as a CFML scope reads it: names match case-insensitively, the last spelling wins; simple values only. */
function paramText(params: SessionRequestInput['params'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  let found: unknown;
  for (const [key, value] of Object.entries(params)) if (key.toLowerCase() === wanted) found = value;
  return typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean' ? String(found) : undefined;
}

/** A CSRF field; on the `api` family a present header, even an empty one, replaces the merged param. */
function csrfField(request: SessionRequestInput, family: string, header: string, field: string): string | undefined {
  const fromHeader = family === HEADER_FAMILY ? headerText(request.headers, header) : undefined;
  return fromHeader ?? paramText(request.params, field);
}

/** The CSRF token legacy would validate for the request; undefined when it carries none or an empty one. */
export function csrfTokenFromRequest(request: SessionRequestInput, family: string): string | undefined {
  const token = csrfField(request, family, CSRF_HEADER_TOKEN, CSRF_FIELD_TOKEN);
  // Legacy rejects an empty token before touching the ledger (sessionUserFacade.cfc:217).
  return token === undefined || token === '' ? undefined : token;
}

/** The served route of a computed key or a bare route key; a bare key's family is its `<family>:` prefix. */
function servedRoute(route: string | RouteKeyResult): ServedRoute {
  if (typeof route === 'string') {
    const key = normaliseRouteKey(route);
    return { key, family: key.slice(0, Math.max(key.indexOf(':'), 0)) };
  }
  const served = route.afterReload ?? route;
  return { key: normaliseRouteKey(served.key), family: served.family, siteId: served.siteId ?? route.siteId };
}

/** The jar cookies a browser would still send at `now`. */
function liveCookies(cookies: JarCookies, now: Date): JarCookies {
  return Object.fromEntries(Object.entries(cookies).filter(([, cookie]) => !isDeletedJarCookie(cookie, now)));
}

/** Creates the CSRF continuity over identity's claims, the bridge's ledger ops, session resolution and the jar. */
export function createCsrfContinuity(opts: CsrfContinuityOptions): CsrfContinuity {
  const { identity, bridge, sessions, jar, facts } = opts;
  const clock = opts.clock ?? systemClock;

  function wireTime(at: Date): string {
    return cfDateTimeFormat(at, WIRE_TIME_MASK);
  }

  /** The session's attached legacy session; undefined when its jar names none, so legacy would start a fresh one. */
  async function attachedSession(sessionId: string): Promise<AttachedSession | undefined> {
    const row = await jar.get(sessionId);
    if (row === undefined || row.legacySessionId === null) return undefined;
    const cookies = liveCookies(row.cookies, clock.now());
    return Object.keys(cookies).length > 0 ? { legacySessionId: row.legacySessionId, cookies } : undefined;
  }

  /** Claims `token`; one identity already holds as used goes into the legacy ledger, so legacy rejects it itself. */
  async function claimToken(
    request: SessionRequestInput,
    served: ServedRoute,
    routeFacts: RouteFacts | undefined,
    token: string,
    session: { sessionId: string; attached: AttachedSession; userAgent: string | undefined },
  ): Promise<string[]> {
    const result = await identity.claim({
      sessionId: session.sessionId,
      token,
      expires: csrfField(request, served.family, CSRF_HEADER_EXPIRES, CSRF_FIELD_EXPIRES) ?? '',
      // Legacy alone evaluates the context; the claim carries the inventory's record of it.
      context: routeFacts?.csrfContext ?? '',
    });
    if (result.state === 'pending-legacy') return [token];
    await bridge.markUsed(session.attached.cookies, [{ token, usedAt: wireTime(clock.now()) }], {
      legacySessionId: session.attached.legacySessionId,
      userAgent: session.userAgent,
    });
    return [];
  }

  return {
    async beforeLegacy(request, route, mode) {
      const served = servedRoute(route);
      if (served.family === SESSIONLESS_FAMILY) return undefined;
      const token = csrfTokenFromRequest(request, served.family);
      // Legacy-primary identity re-reads the ledger through describe; only a carried token needs arbitration here.
      if (mode === 'legacy-primary' && token === undefined) return undefined;

      const routeFacts = facts.get(served.key);
      const validates = token !== undefined && (routeFacts?.csrfValidation ?? UNLISTED_VALIDATION) === 'validates';
      const resolution = await sessions.resolveLegacyBound(request, { mode, adopt: validates, siteId: served.siteId });
      if (resolution.kind !== 'session') return undefined;
      const attached = await attachedSession(resolution.sessionId);
      if (attached === undefined) return undefined;

      const userAgent = headerText(request.headers, 'user-agent');
      const claimedTokens =
        validates && token !== undefined
          ? await claimToken(request, served, routeFacts, token, { sessionId: resolution.sessionId, attached, userAgent })
          : [];
      return {
        sessionId: resolution.sessionId,
        legacySessionId: attached.legacySessionId,
        legacyCookies: attached.cookies,
        claimedTokens,
        since: wireTime(clock.now()),
        userAgent,
        setCookies: resolution.setCookies,
      };
    },

    async afterLegacy(handle, startedAt) {
      if (handle === undefined) return;
      const since = startedAt === undefined ? handle.since : wireTime(startedAt);
      const { body } = await bridge.usedSince(handle.legacyCookies, since, {
        legacySessionId: handle.legacySessionId,
        userAgent: handle.userAgent,
      });
      const consumed = body.tokens.map((entry) => entry.token);
      // Ledger keys are CFML struct keys, which match case-insensitively.
      const consumedKeys = new Set(consumed.map((token) => token.toUpperCase()));
      const released = handle.claimedTokens.filter((token) => !consumedKeys.has(token.toUpperCase()));
      if (consumed.length === 0 && released.length === 0) return;
      await identity.settle({ sessionId: handle.sessionId, consumed, released });
    },
  };
}
