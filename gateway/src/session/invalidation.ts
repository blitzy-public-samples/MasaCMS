// Logout and login effects across the seam: a logout on either side ends both sessions; a legacy login is adopted.
import { normaliseRouteKey, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import { serializeError } from '@opt2/platform/logging';
import { systemClock, type Clock } from '@opt2/platform/service-kit';
import type { InventoryFacts, SessionEffect } from '../cutover/types.js';
import type { BridgeCallOptions, BridgeClient } from './bridge-client.js';
import type { AdoptedSession, IdentityClient } from './identity-client.js';
import { isDeletedJarCookie, type JarCookies, type JarRow, type LegacyJar } from './jar.js';
import type { SessionMode } from './mode.js';
import type { SessionStateChecker } from './state-check.js';
import { DEFAULT_SITE_ID, type TokenCache } from './token-cache.js';

/** Identity's logout keys: the admin logout action and the JSON API `logout` method of the session-managed family. */
export const IDENTITY_LOGOUT_ROUTE_KEYS: readonly string[] = Object.freeze(['admin:clogin.logout', 'api:logout']);

/** A session change a legacy-served request makes, as the inventory names it. */
export type LegacySessionChange = Extract<SessionEffect, 'login' | 'logout'>;

/** Browser facts forwarded on a bridge call. */
export type BrowserFacts = Pick<BridgeCallOptions, 'userAgent'>;

/** Request facts of a legacy login that {@link Invalidation.afterLegacyLogin} adopts. */
export interface LegacyLoginFacts extends BrowserFacts {
  /** The browser's legacy session cookies plus any legacy set; read in legacy-primary mode only. */
  cookies?: JarCookies;
  /** The requested legacy site id; else the legacy session's `siteid`, else `default`. */
  siteId?: string;
}

/** Masa's request timeout in seconds when `requesttimeout` is unset [legacy: core/appcfc/applicationSettings.cfm:317]. */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 1000;

/** A legacy logout's outcome: legacy logged the session out, kept its login, or it or identity could not be read. */
export type LegacyLogoutOutcome = 'logged-out' | 'kept' | 'unknown';

/** The legacy session cookies of the browser, from which a legacy logout's outcome is judged. */
export interface LegacyHeldSession extends BrowserFacts {
  cookies: JarCookies;
}

/** What legacy holds for the browser after serving a logout, which {@link Invalidation.afterLegacyLogout} judges. */
export interface LegacyLogoutFacts extends LegacyHeldSession {
  /** The session cookies legacy received, overlaid with those its response set. */
  cookies: JarCookies;
  /** The request's session mode, in which an unknown outcome restores the mark. */
  mode: SessionMode;
}

/** Logger method {@link createInvalidation} uses; Fastify's `app.log` satisfies it. */
export interface InvalidationLogger {
  warn(obj: object, msg: string): void;
}

/** Session follow-up of logouts and legacy logins; a legacy logout's identity end is marked owed before legacy runs. */
export interface Invalidation {
  /** After identity ended the session: ends its legacy session (no database write), forgets jar, tokens and state. */
  afterTargetLogout(sessionId: string, browser?: BrowserFacts): Promise<void>;
  /** Before legacy logs the session out: forgets its tokens and state and durably marks its identity end pending. */
  beforeLegacyLogout(sessionId: string, mode: SessionMode): Promise<void>;
  /**
   * After legacy served a logout: ends the session if legacy logged it out, clears the mark if kept and not re-marked
   * since, else keeps it marked.
   */
  afterLegacyLogout(sessionId: string, legacy: LegacyLogoutFacts): Promise<void>;
  /**
   * Judges a marked session's pending end: ends it if legacy logged it out; a kept session's mark is cleared once no
   * logout can still be running and none re-marked it since. Returns the outcome.
   */
  completePending(sessionId: string, legacy: LegacyHeldSession): Promise<LegacyLogoutOutcome>;
  /** After a legacy login or re-login: adopts the legacy session into identity; undefined without legacy cookies. */
  afterLegacyLogin(
    sessionId: string,
    mode: SessionMode,
    legacy?: LegacyLoginFacts,
  ): Promise<AdoptedSession | undefined>;
}

/** Dependencies of {@link createInvalidation}. */
export interface InvalidationOptions {
  identity: Pick<IdentityClient, 'adopt' | 'end' | 'snapshot'>;
  bridge: Pick<BridgeClient, 'describe' | 'end'>;
  jar: Pick<LegacyJar, 'withSessionLock' | 'get' | 'drop' | 'markIdentityEndPending' | 'clearIdentityEndPending'>;
  tokenCache: Pick<TokenCache, 'drop'>;
  state: Pick<SessionStateChecker, 'forget'>;
  /** Receives unreadable legacy logout evidence; omitted, it goes unlogged. */
  logger?: InvalidationLogger;
  /** Legacy's request timeout in ms, which no logout outlasts; defaults to {@link DEFAULT_REQUEST_TIMEOUT_SECONDS}. */
  requestTimeoutMs?: number;
  /** Ages pending marks; defaults to the system clock. */
  clock?: Clock;
}

const PAGE_PREFIX = 'page:';
const SAVEFORM_SUFFIX = '+saveform';
const LOGOUT_DOACTION = 'logout';
// REST runs without session management (applicationSettings.cfm:179): its logins and logouts touch no browser session.
const SESSIONLESS_PREFIX = 'rest:';

/** A normalised key without its `{variant}` suffix. */
function baseKey(routeKey: string): string {
  const key = normaliseRouteKey(routeKey);
  const brace = key.indexOf('{');
  return brace < 0 ? key : key.slice(0, brace);
}

/** The ordered doaction values of a `page:` key; empty for a plain render, a bare form submission or another family. */
function pageDoactions(routeKey: string): string[] {
  const key = baseKey(routeKey);
  if (!key.startsWith(PAGE_PREFIX)) return [];
  const body = key.slice(PAGE_PREFIX.length);
  const listed = body.endsWith(SAVEFORM_SUFFIX) ? body.slice(0, -SAVEFORM_SUFFIX.length) : body;
  return listed === 'render' || listed === 'saveform' ? [] : listed.split(',');
}

function isIdentityLogout(routeKey: string): boolean {
  return IDENTITY_LOGOUT_ROUTE_KEYS.includes(baseKey(routeKey));
}

function isPageLogout(routeKey: string): boolean {
  return pageDoactions(routeKey).includes(LOGOUT_DOACTION);
}

/** True for a key that logs the session out: identity's logout keys and page keys whose doactions include `logout`. */
export function isLogoutRouteKey(routeKey: string): boolean {
  return isIdentityLogout(routeKey) || isPageLogout(routeKey);
}

/** True for identity's logout keys; asked only of requests the target served. */
export function isTargetLogout(routeKey: string): boolean {
  return isIdentityLogout(routeKey);
}

/** Effects the inventory records for a key; a page key it does not list takes those of each of its doactions. */
function recordedEffects(routeKey: string, facts: InventoryFacts): readonly SessionEffect[] {
  const recorded = facts.get(routeKey);
  if (recorded !== undefined) return recorded.sessionEffects;
  return pageDoactions(routeKey).flatMap((doaction) => facts.get(`${PAGE_PREFIX}${doaction}`)?.sessionEffects ?? []);
}

/**
 * Session change of a legacy-served request: `logout` for a logout key in either session mode, `login` for a recorded
 * login or re-login. A reload key's change is that of the route legacy serves after start-up (`afterReload`).
 */
export function legacySessionEffect(
  route: string | RouteKeyResult,
  facts: InventoryFacts,
): LegacySessionChange | undefined {
  const routeKey = typeof route === 'string' ? route : (route.afterReload ?? route).key;
  if (baseKey(routeKey).startsWith(SESSIONLESS_PREFIX)) return undefined;
  if (isLogoutRouteKey(routeKey)) return 'logout';
  return recordedEffects(routeKey, facts).some((effect) => effect === 'login' || effect === 'relogin')
    ? 'login'
    : undefined;
}

/** The jar cookies a browser would still send. */
function liveCookies(cookies: JarCookies): JarCookies {
  return Object.fromEntries(Object.entries(cookies).filter(([, cookie]) => !isDeletedJarCookie(cookie)));
}

/** Creates the logout and legacy-login handlers over identity, the bridge, the jar and the per-instance caches. */
export function createInvalidation(opts: InvalidationOptions): Invalidation {
  const { identity, bridge, jar, tokenCache, state, logger } = opts;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_SECONDS * 1000;
  const clock = opts.clock ?? systemClock;

  function forget(sessionId: string): void {
    tokenCache.drop(sessionId);
    state.forget(sessionId);
  }

  /**
   * Kept only while legacy holds the login under identity's CSRF secret, which Masa's login and logout both replace
   * with `session.mura` (userUtility.cfc:760-762); logged out without live cookies or an identity session.
   */
  async function logoutOutcome(sessionId: string, held: LegacyHeldSession): Promise<LegacyLogoutOutcome> {
    const cookies = liveCookies(held.cookies);
    if (Object.keys(cookies).length === 0) return 'logged-out';
    try {
      const [described, snapshot] = await Promise.all([
        bridge.describe(cookies, { userAgent: held.userAgent }),
        identity.snapshot(sessionId),
      ]);
      const { isLoggedIn, csrfSecretKey } = described.body;
      return isLoggedIn && snapshot !== undefined && csrfSecretKey === snapshot.csrfSecretKey ? 'kept' : 'logged-out';
    } catch (error) {
      logger?.warn({ error: serializeError(error) }, 'legacy logout outcome unknown; the identity session stays pending');
      return 'unknown';
    }
  }

  /** True once no logout that marked `row` can still run: a repeated mark keeps the first time, but every mark stamps `updatedAt`. */
  function outlivedLogouts(row: JarRow): boolean {
    return clock.now().getTime() - row.updatedAt.getTime() >= requestTimeoutMs;
  }

  /** Forgets tokens and state, ends the identity session as a legacy logout, then drops its jar and any mark. */
  async function endInIdentity(sessionId: string): Promise<void> {
    forget(sessionId);
    await identity.end(sessionId, 'legacy-logout');
    // Dropped in both modes: legacy_session_id is unique, so a kept row would block re-adopting this legacy session.
    await jar.drop(sessionId);
  }

  return {
    async afterTargetLogout(sessionId, browser = {}) {
      forget(sessionId);
      // Under the jar lock: a running hydration finishes first, and one starting later finds the session ended.
      await jar.withSessionLock(sessionId, async (locked) => {
        let row = await locked.get(sessionId);
        if (row?.legacySessionId) {
          await locked.lockNative(row.legacySessionId);
          // A rebind holding that lock may have moved the legacy session to another jar and removed this one.
          row = await locked.get(sessionId);
        }
        if (row === undefined) return;
        const cookies = liveCookies(row.cookies);
        if (Object.keys(cookies).length > 0) {
          const call = { userAgent: browser.userAgent };
          // `end` must name the attached session; a jar that never recorded its id learns it from `describe`.
          const legacySessionId = row.legacySessionId ?? (await bridge.describe(cookies, call)).body.sessionId;
          // A recorded id's lock is already held, and re-requesting it is a no-op.
          await locked.lockNative(legacySessionId);
          await bridge.end(cookies, { ...call, legacySessionId });
        }
        await locked.drop(sessionId);
      });
    },

    async beforeLegacyLogout(sessionId, mode) {
      forget(sessionId);
      // Committed before legacy logs out, so a logout the after-step cannot settle is judged again by the next request.
      await jar.markIdentityEndPending(sessionId, mode);
    },

    async afterLegacyLogout(sessionId, legacy) {
      // Read before judging, so a mark stamped by a later logout survives this one's clear.
      const row = await jar.get(sessionId);
      const outcome = await logoutOutcome(sessionId, legacy);
      if (outcome === 'logged-out') await endInIdentity(sessionId);
      // A reader may have cleared the mark meanwhile; the session's next request judges the logout again.
      else if (outcome === 'unknown') await jar.markIdentityEndPending(sessionId, legacy.mode);
      // A legacy answer that skipped the logout, such as Masa's site-domain redirect, leaves both sessions logged in.
      else if (row?.identityEndPendingAt !== undefined) await jar.clearIdentityEndPending(sessionId, row.updatedAt);
    },

    async completePending(sessionId, legacy) {
      const row = await jar.get(sessionId);
      // A target-primary jar holds the legacy session's cookies, whose names carry identity's values in the browser.
      const held = row?.mode === 'target-primary' ? { ...legacy, cookies: row.cookies } : legacy;
      const outcome = await logoutOutcome(sessionId, held);
      if (outcome === 'logged-out') await endInIdentity(sessionId);
      // A logout still running may apply later; its own after-step then ends the session.
      else if (outcome === 'kept' && row?.identityEndPendingAt !== undefined && outlivedLogouts(row)) {
        await jar.clearIdentityEndPending(sessionId, row.updatedAt);
      }
      return outcome;
    },

    async afterLegacyLogin(sessionId, mode, legacy = {}) {
      // Under the jar lock, so no hydration installs an older snapshot over the login or rebinds around it.
      const adopted = await jar.withSessionLock(sessionId, async (locked) => {
        const row = await locked.get(sessionId);
        // In target-primary mode the browser's CFID/CFTOKEN/JSESSIONID carry identity's values; the jar holds legacy's.
        const source = mode === 'target-primary' ? row?.cookies : (legacy.cookies ?? row?.cookies);
        const cookies = liveCookies(source ?? {});
        if (Object.keys(cookies).length === 0) return undefined;

        const call = { userAgent: legacy.userAgent };
        let { body: describe } = await bridge.describe(cookies, call);
        await locked.lockNative(describe.sessionId);
        const holder = await locked.findByLegacySessionId(describe.sessionId);
        if (holder !== undefined && holder.sessionId !== sessionId && holder.mode === 'target-primary') {
          // That holder may have hydrated or ended the legacy session since it was described.
          const fresh = (await bridge.describe(cookies, call)).body;
          if (fresh.sessionId !== describe.sessionId) return undefined;
          describe = fresh;
        }
        const session = await identity.adopt({ describe, siteId: legacy.siteId || describe.siteId || DEFAULT_SITE_ID });
        if (session.sessionId === sessionId && holder?.sessionId === sessionId) {
          // Legacy already holds the adopted state, so it is recorded as hydrated rather than hydrated over.
          if (mode === 'target-primary') await locked.setHydratedEpoch(sessionId, session.epoch);
        } else {
          // One write replaces the old mapping and any other holder of the legacy session: legacy_session_id is unique.
          await locked.rebind(
            {
              sessionId: session.sessionId,
              legacySessionId: describe.sessionId,
              cookies,
              mode,
              hydratedEpoch: mode === 'target-primary' ? session.epoch : null,
            },
            sessionId,
          );
        }
        return session;
      });
      if (adopted === undefined) return undefined;
      for (const id of new Set([sessionId, adopted.sessionId])) forget(id);
      return adopted;
    },
  };
}
