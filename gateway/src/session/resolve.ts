// Session resolution: the identity session a gateway request acts in, legacy-session adoption and the jar mapping.
import { parseCookieHeader, type RouteFamily } from '@opt2/platform/legacy-compat';
import { IDENTITY_SERVICE, ServiceUnavailableError } from '@opt2/platform/service-kit';
import type { BridgeClient } from './bridge-client.js';
import type { IdentityClient, LegacyDescribe, RestAuthOutcome } from './identity-client.js';
import {
  absorbLegacySetCookies,
  isDeletedJarCookie,
  legacySetCookiesFrom,
  requestSessionCookies,
  targetSetCookiesFrom,
  type AbsorbedSetCookies,
  type JarCookie,
  type JarCookies,
  type JarRow,
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
      /** The jar's legacy session cookies, sent only to legacy. */
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

/** Maps browser requests to identity sessions and keeps `gateway.legacy_jar` in step. */
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

/** True when describing kept the session `sent` names: ColdFusion set no session cookie to another value. */
function keptSession(sent: JarCookies, observed: JarCookies): boolean {
  return !isEmpty(sent) && Object.entries(observed).every(([key, cookie]) => sent[key]?.value === cookie.value);
}

function none(setCookies: string[] = []): SessionResolution {
  return { kind: 'none', setCookies };
}

function session(
  sessionId: string,
  epoch: number,
  mode: SessionMode,
  row: JarRow | undefined,
  setCookies: string[],
): SessionResolution {
  return { kind: 'session', sessionId, epoch, mode, legacyCookies: row?.cookies ?? {}, setCookies };
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

  /** Adopts a described legacy session into identity and records its jar. */
  async function adopt(described: LegacyDescribe, cookies: JarCookies, mode: SessionMode, siteId: string | undefined) {
    const adopted = await identity.adopt({ describe: described, siteId: siteId || DEFAULT_SITE_ID });
    const row = await jar.upsert({
      sessionId: adopted.sessionId,
      legacySessionId: described.sessionId,
      cookies,
      mode,
      // Legacy already holds the adopted state, so target-primary owes it no hydration at this epoch.
      hydratedEpoch: mode === 'target-primary' ? adopted.epoch : null,
    });
    return { adopted, row };
  }

  /** Target-primary adoption of the live legacy session the request's cookies attach. */
  async function adoptIntoTarget(request: SessionRequestInput, siteId: string | undefined): Promise<SessionResolution> {
    const attached = await describeAttached(request, requestCookies(request));
    if (attached === undefined) return none();
    const cookies = requestCookies(request, attached.observed);
    const { adopted, row } = await adopt(attached.describe, cookies, 'target-primary', siteId);
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

  /** Back in legacy-primary: the jar's legacy session is re-adopted and its cookies are handed back to the browser. */
  async function switchBack(request: SessionRequestInput, row: JarRow, siteId: string | undefined) {
    const described = await describeSession(request, liveCookies(row.cookies));
    const absorbed = absorbLegacySetCookies(described.setCookies);
    const cookies = { ...row.cookies, ...absorbed.sessionCookies };
    const { adopted, row: stored } = await adopt(described.body, cookies, 'legacy-primary', siteId);
    // Identity keys legacy-primary sessions by the legacy session id, so a superseded mapping must not stay findable.
    if (stored.sessionId !== row.sessionId) await jar.drop(row.sessionId);
    const setCookies = [...legacySetCookiesFrom(stored.cookies), ...absorbed.otherSetCookies];
    return session(adopted.sessionId, adopted.epoch, 'legacy-primary', stored, setCookies);
  }

  /** Legacy-primary: the browser's legacy cookies pass unchanged, and identity mirrors the session they attach. */
  async function legacyPrimarySession(request: SessionRequestInput, siteId: string | undefined) {
    const candidate = sessionIdFromTargetCookies(parseCookieHeader(headerValue(request.headers, 'cookie')));
    const targetRow = candidate === undefined ? undefined : await jar.get(candidate);
    if (targetRow?.mode === 'target-primary') return switchBack(request, targetRow, siteId);
    const described = await describeSession(request, requestCookies(request));
    const absorbed = absorbLegacySetCookies(described.setCookies);
    const cookies = { ...requestCookies(request, absorbed.sessionCookies), ...absorbed.sessionCookies };
    const { adopted, row } = await adopt(described.body, cookies, 'legacy-primary', siteId);
    // ColdFusion's own Set-Cookie values reach the browser as legacy would have set them.
    return session(adopted.sessionId, adopted.epoch, 'legacy-primary', row, [...described.setCookies]);
  }

  /** Target-primary: legacy cookies set on an existing session go to its jar; the browser keeps the target values. */
  async function absorbIntoSession(
    request: SessionRequestInput,
    found: TargetSession,
    absorbed: AbsorbedSetCookies,
  ): Promise<SessionResolution> {
    const previous = found.row?.cookies ?? {};
    const replaced = Object.entries(absorbed.sessionCookies).some(
      ([key, cookie]) => Object.hasOwn(previous, key) && previous[key]?.value !== cookie.value,
    );
    const stored = await jar.upsert({
      sessionId: found.sessionId,
      // A replaced cookie means a new legacy session, which is neither known by id nor hydrated yet.
      legacySessionId: replaced ? null : (found.row?.legacySessionId ?? null),
      cookies: absorbed.sessionCookies,
      mode: 'target-primary',
      hydratedEpoch: replaced ? null : (found.row?.hydratedEpoch ?? null),
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
    const attached = await describeAttached(request, liveCookies(cookies));
    // Without a live legacy session only legacy's deletions are passed on; legacy values never reach the browser.
    if (attached === undefined) {
      return none([...targetSetCookiesFrom(absorbed.sessionCookies, {}), ...absorbed.otherSetCookies]);
    }
    const { adopted, row } = await adopt(attached.describe, cookies, 'target-primary', siteId);
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
      const { adopted, row } = await adopt(described.body, requestCookies(request, observed), 'legacy-primary', siteId);
      return session(adopted.sessionId, adopted.epoch, 'legacy-primary', row, []);
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
