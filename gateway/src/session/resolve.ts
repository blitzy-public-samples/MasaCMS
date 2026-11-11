// Session resolution: the identity session a gateway request acts in, legacy-session adoption and the jar mapping.
import { parseCookieHeader, type RouteFamily } from '@opt2/platform/legacy-compat';
import { IDENTITY_SERVICE, ServiceUnavailableError } from '@opt2/platform/service-kit';
import type { BridgeClient } from './bridge-client.js';
import type { AdoptedSession, IdentityClient, LegacyDescribe, RestAuthOutcome } from './identity-client.js';
import {
  absorbLegacySetCookies,
  isDeletedJarCookie,
  keptSession,
  legacySetCookiesFrom,
  requestSessionCookies,
  targetSetCookiesFrom,
  type AbsorbedSetCookies,
  type JarCookie,
  type JarCookies,
  type JarRow,
  type JarUpsert,
  type LegacyJar,
} from './jar.js';
import type { SessionMode } from './mode.js';
import type { SessionStateChecker } from './state-check.js';

/** Legacy `siteid` fallback when a request names no site (contentServer.cfc:610-622). */
const DEFAULT_SITE_ID = 'default';

/** Identity's target-primary session id is the `JSESSIONID` value it issues; `CFID` and `CFTOKEN` carry no id. */
const TARGET_SESSION_COOKIE = 'JSESSIONID';

/** The client request facts session resolution reads; header names are lower-cased, as Node delivers them. */
export interface SessionRequestInput {
  path: string;
  httpMethod: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  /** The route key's merged params: query, then form, then a JSON body, as legacy merges them. */
  params: Record<string, unknown>;
}

/** The session a request acts in, legacy's own answer, or no session; `setCookies` are added to the client response. */
export type SessionResolution =
  | {
      kind: 'session';
      sessionId: string;
      epoch: number;
      mode: SessionMode;
      /**
       * Session cookies legacy receives in place of the request's own: the jar's in target-primary, the restored jar's
       * right after a switch back, else none (the browser's own pass unchanged).
       */
      legacyCookies: Record<string, JarCookie>;
      setCookies: string[];
    }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }
  | { kind: 'none'; setCookies: string[] };

/** Options of {@link SessionResolver.resolveSession}. */
export interface ResolveSessionOptions {
  family: RouteFamily;
  mode: SessionMode;
  /** The requested legacy site id; absent or empty falls back to `default`. */
  siteId?: string | undefined;
}

/** Options of {@link SessionResolver.resolveLegacyBound}. */
export interface LegacyBoundOptions {
  mode: SessionMode;
  /** Whether a live legacy session that maps to no identity session is adopted. */
  adopt: boolean;
  /** The requested legacy site id; absent or empty falls back to `default`. */
  siteId?: string | undefined;
}

/** Options of {@link SessionResolver.adoptAfterLegacy}. */
export interface AfterLegacyOptions {
  mode: SessionMode;
  /** The legacy response's raw `Set-Cookie` values, in order. */
  setCookies: readonly string[];
  /** The requested legacy site id; absent or empty falls back to `default`. */
  siteId?: string | undefined;
}

/** Maps browser requests to identity sessions and keeps `gateway.legacy_jar` in step; a request switches back once. */
export interface SessionResolver {
  /** The session of a target-bound request; REST is sessionless and answered by identity's credential rules. */
  resolveSession(request: SessionRequestInput, options: ResolveSessionOptions): Promise<SessionResolution>;
  /** The session of a legacy-bound request, adopting an unmapped live legacy session only when `adopt` is true. */
  resolveLegacyBound(request: SessionRequestInput, options: LegacyBoundOptions): Promise<SessionResolution>;
  /** The `Set-Cookie` values a legacy response hands the client: unchanged in legacy-primary, else target values. */
  adoptAfterLegacy(request: SessionRequestInput, options: AfterLegacyOptions): Promise<SessionResolution>;
}

/** Dependencies of {@link createSessionResolver}. */
export interface SessionResolverOptions {
  identity: IdentityClient;
  bridge: BridgeClient;
  jar: LegacyJar;
  state: SessionStateChecker;
}

/** An active identity session named by the browser's target cookies, with its jar row. */
interface TargetSession {
  sessionId: string;
  epoch: number;
  row: JarRow | undefined;
}

/** A legacy session the browser's cookies attach, as the bridge describes it. */
interface AttachedSession {
  describe: LegacyDescribe;
  /** Session cookies ColdFusion set while describing, with legacy's attributes. */
  observed: JarCookies;
}

/** An identity session adopted from a legacy session, with the jar mapping it. */
interface Adoption {
  adopted: AdoptedSession;
  row: JarRow;
}

/** The jar of an adopted legacy session; legacy holds the adopted state, so target-primary owes it no hydration. */
function adoptedJar(
  adopted: AdoptedSession,
  legacySessionId: string,
  cookies: JarCookies,
  mode: SessionMode,
): JarUpsert {
  return {
    sessionId: adopted.sessionId,
    legacySessionId,
    cookies,
    mode,
    hydratedEpoch: mode === 'target-primary' ? adopted.epoch : null,
  };
}

/** The identity session id in identity-issued cookies, or undefined when they carry none. */
export function sessionIdFromTargetCookies(cookies: ReadonlyMap<string, string>): string | undefined {
  const value = cookies.get(TARGET_SESSION_COOKIE);
  return value === undefined || value === '' ? undefined : value;
}

/** A request header's value; repeated fields join as one `Cookie` header does. */
function headerValue(headers: SessionRequestInput['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join('; ') : value;
}

/** Request headers without absent entries, as identity's contract carries them. */
function presentHeaders(headers: SessionRequestInput['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) out[name] = value;
  return out;
}

/** Jar cookies a browser still holds: deletions and expired entries are left out. */
function liveCookies(cookies: JarCookies): JarCookies {
  return Object.fromEntries(Object.entries(cookies).filter(([, cookie]) => !isDeletedJarCookie(cookie)));
}

/** The request's session cookies with a value, named and attributed from `observed` where legacy set them. */
function requestCookies(request: SessionRequestInput, observed?: JarCookies): JarCookies {
  return liveCookies(requestSessionCookies(headerValue(request.headers, 'cookie'), observed));
}

/** The values of the request's session cookies by upper-case name: in target-primary, the target values. */
function requestCookieValues(request: SessionRequestInput): Record<string, string> {
  return Object.fromEntries(Object.entries(requestCookies(request)).map(([key, cookie]) => [key, cookie.value]));
}

function isEmpty(cookies: JarCookies): boolean {
  return Object.keys(cookies).length === 0;
}

function none(setCookies: string[] = []): SessionResolution {
  return { kind: 'none', setCookies };
}

/** A session resolution; only target-primary swaps the jar's cookies in for the request's own. */
function session(
  sessionId: string,
  epoch: number,
  mode: SessionMode,
  row: JarRow | undefined,
  setCookies: string[],
): SessionResolution {
  const legacyCookies = mode === 'target-primary' ? (row?.cookies ?? {}) : {};
  return { kind: 'session', sessionId, epoch, mode, legacyCookies, setCookies };
}

/** Identity's legacy answer for a `denied` or `answered` outcome; without one, identity counts as unavailable. */
function legacyAnswer(outcome: RestAuthOutcome): SessionResolution {
  const answer = outcome.legacyResponse;
  if (answer === undefined) {
    const cause = new Error(`authenticate ${outcome.outcome} without legacyResponse`);
    throw new ServiceUnavailableError(IDENTITY_SERVICE, cause);
  }
  return { kind: 'response', status: answer.status, headers: answer.headers, body: answer.body };
}

/** `Set-Cookie` values handing the browser identity's issued cookies under the jar's legacy names and attributes. */
function reissue(jarCookies: JarCookies, issuedSetCookies: readonly string[]): string[] {
  const issued = absorbLegacySetCookies(issuedSetCookies);
  const values: Record<string, string> = {};
  const unmatched: JarCookies = {};
  for (const [key, cookie] of Object.entries(issued.sessionCookies)) {
    values[key] = cookie.value;
    // A cookie legacy never set keeps identity's own form, so the session id still reaches the browser.
    if (!Object.hasOwn(jarCookies, key)) unmatched[key] = cookie;
  }
  return [...targetSetCookiesFrom(jarCookies, values), ...legacySetCookiesFrom(unmatched), ...issued.otherSetCookies];
}

/** Creates the session resolver over identity, the legacy bridge, the jar and the session-state checker. */
export function createSessionResolver(opts: SessionResolverOptions): SessionResolver {
  const { identity, bridge, jar, state } = opts;

  /** The active identity session the browser's target cookies name; an ended or unknown one names none. */
  async function targetSession(request: SessionRequestInput): Promise<TargetSession | undefined> {
    const sessionId = sessionIdFromTargetCookies(parseCookieHeader(headerValue(request.headers, 'cookie')));
    if (sessionId === undefined) return undefined;
    const check = await state.check(sessionId);
    if (check.state !== 'active') return undefined;
    return { sessionId, epoch: check.epoch, row: await jar.get(sessionId) };
  }

  /** `op=describe` with the browser's `User-Agent`, which keeps Masa from cutting the session to 2 s. */
  function describeSession(request: SessionRequestInput, cookies: JarCookies) {
    return bridge.describe(cookies, { userAgent: headerValue(request.headers, 'user-agent') });
  }

  /** The legacy session `sent` attaches; undefined when ColdFusion created a new one because `sent` named none. */
  async function describeAttached(
    request: SessionRequestInput,
    sent: JarCookies,
  ): Promise<AttachedSession | undefined> {
    if (isEmpty(sent)) return undefined;
    const described = await describeSession(request, sent);
    const observed = absorbLegacySetCookies(described.setCookies).sessionCookies;
    return keptSession(sent, observed) ? { describe: described.body, observed } : undefined;
  }

  /** Identity's adoption of a described legacy session, at the requested site or legacy's default. */
  function adoptInIdentity(describe: LegacyDescribe, siteId: string | undefined) {
    return identity.adopt({ describe, siteId: siteId || DEFAULT_SITE_ID });
  }

  /**
   * Adopts the legacy session `sent` was described as into identity and maps its jar to the adopted session alone;
   * undefined when, described again under its lock, `sent` names another legacy session.
   */
  async function adopt(
    request: SessionRequestInput,
    sent: JarCookies,
    described: LegacyDescribe,
    cookies: JarCookies,
    mode: SessionMode,
    siteId: string | undefined,
  ): Promise<Adoption | undefined> {
    const holder = await jar.findByLegacySessionId(described.sessionId);
    if (holder?.mode !== 'target-primary') {
      const adopted = await adoptInIdentity(described, siteId);
      return { adopted, row: await jar.rebind(adoptedJar(adopted, described.sessionId, cookies, mode)) };
    }
    // A target-primary holder may be hydrating or ending that legacy session, so it is described again under its lock.
    return jar.withNativeLock(described.sessionId, async (locked) => {
      const fresh = (await describeSession(request, sent)).body;
      if (fresh.sessionId !== described.sessionId) return undefined;
      const adopted = await adoptInIdentity(fresh, siteId);
      return { adopted, row: await locked.rebind(adoptedJar(adopted, fresh.sessionId, cookies, mode)) };
    });
  }

  /** Target-primary adoption of the live legacy session the request's cookies attach. */
  async function adoptIntoTarget(request: SessionRequestInput, siteId: string | undefined): Promise<SessionResolution> {
    const sent = requestCookies(request);
    const attached = await describeAttached(request, sent);
    if (attached === undefined) return none();
    const cookies = requestCookies(request, attached.observed);
    const adoption = await adopt(request, sent, attached.describe, cookies, 'target-primary', siteId);
    if (adoption === undefined) return none();
    const { adopted, row } = adoption;
    return session(adopted.sessionId, adopted.epoch, 'target-primary', row, reissue(cookies, adopted.setCookie));
  }

  /** Sessionless REST: identity applies legacy's credential rules and may answer on legacy's behalf. */
  async function restSession(
    request: SessionRequestInput,
    mode: SessionMode,
    siteId: string | undefined,
  ): Promise<SessionResolution> {
    const outcome = await identity.authenticate({
      method: request.httpMethod,
      path: request.path,
      siteId: siteId || DEFAULT_SITE_ID,
      headers: presentHeaders(request.headers),
      query: request.query,
      // Merged params already hold the query and the JSON body, so identity's query-then-form merge reproduces them.
      form: request.params,
    });
    if (outcome.outcome === 'denied' || outcome.outcome === 'answered') return legacyAnswer(outcome);
    if (outcome.outcome === 'anonymous' || outcome.sessionId === null) return none();
    const check = await state.check(outcome.sessionId);
    return check.state === 'active' ? session(outcome.sessionId, check.epoch, mode, undefined, []) : none();
  }

  /** Target-primary: identity-issued cookies name the session; legacy cookies opened before cut-over are adopted. */
  async function targetPrimarySession(request: SessionRequestInput, siteId: string | undefined) {
    const found = await targetSession(request);
    if (found !== undefined) return session(found.sessionId, found.epoch, 'target-primary', found.row, []);
    return adoptIntoTarget(request, siteId);
  }

  /**
   * Back in legacy-primary: the jar's legacy session is re-adopted and its cookies are handed back to the browser;
   * undefined when another target-primary jar's session changed it to one its cookies no longer name.
   */
  function switchBack(
    request: SessionRequestInput,
    targetRow: JarRow,
    siteId: string | undefined,
  ): Promise<SessionResolution | undefined> {
    return jar.withSessionLock(targetRow.sessionId, async (locked) => {
      // A concurrent switch back may have rebound it already; its cookies then restore the same session.
      const current = (await locked.get(targetRow.sessionId)) ?? targetRow;
      const sent = liveCookies(current.cookies);
      let described = await describeSession(request, sent);
      await locked.lockNative(described.body.sessionId);
      const holder = await locked.findByLegacySessionId(described.body.sessionId);
      if (holder !== undefined && holder.sessionId !== targetRow.sessionId && holder.mode === 'target-primary') {
        // That holder may have hydrated or ended the legacy session since it was described.
        const fresh = await describeSession(request, sent);
        if (fresh.body.sessionId !== described.body.sessionId) return undefined;
        described = fresh;
      }
      const absorbed = absorbLegacySetCookies(described.setCookies);
      const cookies = { ...current.cookies, ...absorbed.sessionCookies };
      const adopted = await adoptInIdentity(described.body, siteId);
      // Identity keys legacy-primary sessions by the legacy session id, so a superseded mapping must not stay findable.
      const stored = await locked.rebind(
        adoptedJar(adopted, described.body.sessionId, cookies, 'legacy-primary'),
        targetRow.sessionId,
      );
      const setCookies = [...legacySetCookiesFrom(stored.cookies), ...absorbed.otherSetCookies];
      // The browser still sends the target values on this request, so legacy receives the restored jar's.
      return {
        kind: 'session',
        sessionId: adopted.sessionId,
        epoch: adopted.epoch,
        mode: 'legacy-primary',
        legacyCookies: stored.cookies,
        setCookies,
      };
    });
  }

  /** The switch back of the target-primary jar the request's target cookie names; undefined when it names none. */
  async function restoreTargetJar(request: SessionRequestInput, siteId: string | undefined) {
    const candidate = sessionIdFromTargetCookies(parseCookieHeader(headerValue(request.headers, 'cookie')));
    const targetRow = candidate === undefined ? undefined : await jar.get(candidate);
    return targetRow?.mode === 'target-primary' ? switchBack(request, targetRow, siteId) : undefined;
  }

  /** Switch backs by request object, so each legacy-primary resolution of one request acts in the restored session. */
  const restorations = new WeakMap<SessionRequestInput, Promise<SessionResolution | undefined>>();

  /** The restored session of a legacy-primary request, shared by its every resolution; a failed one is not kept. */
  function restoredSession(request: SessionRequestInput, siteId: string | undefined) {
    const known = restorations.get(request);
    if (known !== undefined) return known;
    const pending = restoreTargetJar(request, siteId);
    restorations.set(request, pending);
    pending.catch(() => {
      if (restorations.get(request) === pending) restorations.delete(request);
    });
    return pending;
  }

  /** Legacy-primary: the browser's legacy cookies pass unchanged, and identity mirrors the session they attach. */
  async function legacyPrimarySession(request: SessionRequestInput, siteId: string | undefined) {
    const restored = await restoredSession(request, siteId);
    if (restored !== undefined) return restored;
    const sent = requestCookies(request);
    const described = await describeSession(request, sent);
    const absorbed = absorbLegacySetCookies(described.setCookies);
    const cookies = { ...requestCookies(request, absorbed.sessionCookies), ...absorbed.sessionCookies };
    const adoption = await adopt(request, sent, described.body, cookies, 'legacy-primary', siteId);
    if (adoption === undefined) return none();
    const { adopted, row } = adoption;
    // ColdFusion's own Set-Cookie values reach the browser as legacy would have set them.
    return session(adopted.sessionId, adopted.epoch, 'legacy-primary', row, [...described.setCookies]);
  }

  /**
   * Target-primary: legacy cookies set on an existing session go to its jar, unless that jar was dropped or rebound
   * away since it was read; the browser keeps the target values.
   */
  async function absorbIntoSession(
    request: SessionRequestInput,
    found: TargetSession,
    absorbed: AbsorbedSetCookies,
  ): Promise<SessionResolution> {
    const stored = await jar.withSessionLock(found.sessionId, async (locked) => {
      let row = await locked.get(found.sessionId);
      if (row?.legacySessionId) {
        await locked.lockNative(row.legacySessionId);
        // A rebind holding that lock may have moved the legacy session to another jar and removed this one.
        row = await locked.get(found.sessionId);
      }
      // Writing now would recreate a jar a logout or rebind removed.
      if (found.row !== undefined && row === undefined) return undefined;
      const previous = row?.cookies ?? {};
      const replaced = Object.entries(absorbed.sessionCookies).some(
        ([key, cookie]) => Object.hasOwn(previous, key) && previous[key]?.value !== cookie.value,
      );
      return locked.upsert({
        sessionId: found.sessionId,
        // A replaced cookie means a new legacy session, which is neither known by id nor hydrated yet.
        legacySessionId: replaced ? null : (row?.legacySessionId ?? null),
        cookies: absorbed.sessionCookies,
        mode: 'target-primary',
        hydratedEpoch: replaced ? null : (row?.hydratedEpoch ?? null),
      });
    });
    const setCookies = [
      ...targetSetCookiesFrom(absorbed.sessionCookies, requestCookieValues(request)),
      ...absorbed.otherSetCookies,
    ];
    return session(found.sessionId, found.epoch, 'target-primary', stored, setCookies);
  }

  /** Target-primary first contact through legacy: the session legacy just created is adopted. */
  async function adoptFromResponse(
    request: SessionRequestInput,
    absorbed: AbsorbedSetCookies,
    siteId: string | undefined,
  ): Promise<SessionResolution> {
    const cookies = { ...requestCookies(request, absorbed.sessionCookies), ...absorbed.sessionCookies };
    const sent = liveCookies(cookies);
    const attached = await describeAttached(request, sent);
    const adoption =
      attached === undefined
        ? undefined
        : await adopt(request, sent, attached.describe, cookies, 'target-primary', siteId);
    // Without a live legacy session only legacy's deletions are passed on; legacy values never reach the browser.
    if (adoption === undefined) {
      return none([...targetSetCookiesFrom(absorbed.sessionCookies, {}), ...absorbed.otherSetCookies]);
    }
    const { adopted, row } = adoption;
    return session(adopted.sessionId, adopted.epoch, 'target-primary', row, [
      ...reissue(cookies, adopted.setCookie),
      ...absorbed.otherSetCookies,
    ]);
  }

  return {
    async resolveSession(request, { family, mode, siteId }) {
      // Legacy disables session management for /_api/rest/ (applicationSettings.cfm:179), so cookies are never read.
      if (family === 'rest') return restSession(request, mode, siteId);
      return mode === 'target-primary' ? targetPrimarySession(request, siteId) : legacyPrimarySession(request, siteId);
    },

    async resolveLegacyBound(request, { mode, adopt: adoptUnmapped, siteId }) {
      if (mode === 'target-primary') {
        const found = await targetSession(request);
        if (found !== undefined) return session(found.sessionId, found.epoch, 'target-primary', found.row, []);
        return adoptUnmapped ? adoptIntoTarget(request, siteId) : none();
      }
      // Restoring a mapped session is not adopting an unmapped one, so `adopt` does not gate it.
      const restored = await restoredSession(request, siteId);
      if (restored !== undefined) return restored;
      const sent = requestCookies(request);
      if (isEmpty(sent)) return none();
      const described = await describeSession(request, sent);
      const mapped = await jar.findByLegacySessionId(described.body.sessionId);
      if (mapped !== undefined) {
        const check = await state.check(mapped.sessionId);
        if (check.state === 'active') return session(mapped.sessionId, check.epoch, 'legacy-primary', mapped, []);
      }
      if (!adoptUnmapped) return none();
      const observed = absorbLegacySetCookies(described.setCookies).sessionCookies;
      if (!keptSession(sent, observed)) return none();
      const cookies = requestCookies(request, observed);
      const adoption = await adopt(request, sent, described.body, cookies, 'legacy-primary', siteId);
      if (adoption === undefined) return none();
      return session(adoption.adopted.sessionId, adoption.adopted.epoch, 'legacy-primary', adoption.row, []);
    },

    async adoptAfterLegacy(request, { mode, setCookies, siteId }) {
      if (mode === 'legacy-primary') return none([...setCookies]);
      const absorbed = absorbLegacySetCookies(setCookies);
      const found = await targetSession(request);
      if (isEmpty(absorbed.sessionCookies)) {
        return found === undefined
          ? none([...setCookies])
          : session(found.sessionId, found.epoch, 'target-primary', found.row, [...setCookies]);
      }
      return found === undefined
        ? adoptFromResponse(request, absorbed, siteId)
        : absorbIntoSession(request, found, absorbed);
    },
  };
}
