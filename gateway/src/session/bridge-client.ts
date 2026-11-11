// Signed client of the legacy bridge's session.cfm: describe, hydrate, CSRF ledger and end of a ColdFusion session.
import { BRIDGE_ASSERTION_HEADER, isLegacySessionCookie, signBridgeAssertion } from '@opt2/platform/legacy-compat';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, type Clock } from '@opt2/platform/service-kit';
import type { LegacyDescribe, LegacyDescribeUser, LegacyUsedToken } from './identity-client.js';

export type { LegacyDescribe, LegacyDescribeUser, LegacyUsedToken } from './identity-client.js';

const SESSION_PAGE = '/gateway/legacy-bridge/cfml/session.cfm';
const BRIDGE_SERVICE = 'legacy-bridge';
const ASSERTION_TTL_SECONDS = 30;

/** One legacy cookie: its value, or a jar entry carrying `value` and optionally the observed `name`. */
export type LegacyCookieValue = string | { readonly name?: string; readonly value: string };

/** Cookies by name; only `CFID`, `CFTOKEN` and `JSESSIONID` with a non-empty value reach the bridge. */
export type LegacyCookies = Readonly<Record<string, LegacyCookieValue>>;

/** Per-call facts about the browser session the cookies belong to. */
export interface BridgeCallOptions {
  /** ColdFusion `session.sessionid` of the cookies (describe's `sessionId`, kept in the jar); signed as `sid`. */
  legacySessionId?: string;
  /** The browser's `User-Agent`, forwarded because Masa cuts the session to 2 s for an empty or bot-like agent. */
  userAgent?: string;
}

// The bridge answers 409 sessionMismatch unless `sid` equals session.sessionid, which the cookies alone do not reveal.
/** Options of the ops the bridge checks against the attached session, so the legacy session id is required. */
export interface BridgeSessionCall extends BridgeCallOptions {
  legacySessionId: string;
}

/** `op=hydrate` body: identity's login snapshot, CSRF secret and used-token ledger for the session. */
export interface HydrateBody {
  snapshot: {
    /** The describe `user` keys; never a `groupID`, which would override `membershipIds`. */
    user: LegacyDescribeUser;
    /** `loginByQuery` role list, comma-delimited. */
    memberships: string;
    /** Group ids plus the user id, comma-delimited. */
    membershipIds: string;
  };
  csrfSecretKey: string;
  usedTokens: LegacyUsedToken[];
}

/** `op=hydrate` answer: the hydrated session's id. */
export interface HydrateResult {
  sessionId: string;
  hydrated: true;
  serverTime: string;
}

/** `op=markUsed` answer: the number of tokens newly added to the ledger. */
export interface MarkUsedResult {
  applied: number;
  serverTime: string;
}

/** `op=usedSince` answer: ledger entries used at or after `since`, under the bridge's key `tokens`. */
export interface UsedSinceResult {
  tokens: LegacyUsedToken[];
  serverTime: string;
}

/** `op=end` answer. */
export interface EndResult {
  ended: true;
  serverTime: string;
}

/** A bridge answer with the raw `Set-Cookie` values ColdFusion sent, for example a new session's cookies. */
export interface BridgeResult<T> {
  body: T;
  setCookies: string[];
}

/** The gateway's calls into the legacy session through `session.cfm`. */
export interface BridgeClient {
  /** `op=describe`: the attached session as Masa's login left it; creates a session when the cookies attach none. */
  describe(cookies: LegacyCookies, call?: BridgeCallOptions): Promise<BridgeResult<LegacyDescribe>>;
  /** `op=hydrate`: installs the snapshot without a login; `legacySessionId` is required when cookies are sent. */
  hydrate(cookies: LegacyCookies, body: HydrateBody, call?: BridgeCallOptions): Promise<BridgeResult<HydrateResult>>;
  /** `op=markUsed`: adds tokens to the session's used-token ledger. */
  markUsed(
    cookies: LegacyCookies,
    tokens: LegacyUsedToken[],
    call: BridgeSessionCall,
  ): Promise<BridgeResult<MarkUsedResult>>;
  /** `op=usedSince`: ledger entries used at or after `since`, a legacy wire time. */
  usedSince(cookies: LegacyCookies, since: string, call: BridgeSessionCall): Promise<BridgeResult<UsedSinceResult>>;
  /** `op=end`: logs the session out without a database write and invalidates it. */
  end(cookies: LegacyCookies, call: BridgeSessionCall): Promise<BridgeResult<EndResult>>;
}

/** Construction options of {@link createBridgeClient}. */
export interface BridgeClientOptions {
  /** `LEGACY_ORIGIN`, addressed directly. */
  legacyOrigin: string;
  /** `OPT2_BRIDGE_HMAC_KEY`. */
  hmacKey: string;
  clock: Clock;
  fetch?: typeof fetch;
}

type SessionOp = 'describe' | 'hydrate' | 'markUsed' | 'usedSince' | 'end';

interface OpSpec {
  method: 'GET' | 'POST';
  sub?: string;
  query?: Record<string, string>;
  json?: unknown;
}

/** `Cookie` header of the legacy session cookies, or undefined when there are none. */
function legacyCookieHeader(cookies: LegacyCookies): string | undefined {
  const pairs: string[] = [];
  for (const [key, cookie] of Object.entries(cookies)) {
    const name = typeof cookie === 'string' ? key : (cookie.name ?? key);
    const value = typeof cookie === 'string' ? cookie : cookie.value;
    // An empty value is a legacy deletion, which a browser would not send back either.
    if (isLegacySessionCookie(name) && value !== '') pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/** The bridge's `error` token from an error body, or undefined for the guard's bodiless answers. */
function errorToken(text: string): string | undefined {
  try {
    const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

/** The legacy-shaped 503 for a non-2xx bridge answer. */
function httpFailure(op: SessionOp, status: number, error: string | undefined): ServiceUnavailableError {
  const detail = error === undefined ? '' : ` ${error}`;
  const cause = Object.assign(new Error(`legacy bridge session.${op} answered HTTP ${String(status)}${detail}`), {
    code: `HTTP_${String(status)}`,
    status,
    error,
  });
  return new ServiceUnavailableError(BRIDGE_SERVICE, cause);
}

/** Creates the bridge session client; every call carries a freshly signed single-use assertion. */
export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const origin = opts.legacyOrigin.replace(/\/+$/, '');
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send<T>(
    op: SessionOp,
    spec: OpSpec,
    cookies: LegacyCookies,
    call: BridgeCallOptions = {},
  ): Promise<BridgeResult<T>> {
    let target = `${origin}${SESSION_PAGE}?op=${op}`;
    for (const [name, value] of Object.entries(spec.query ?? {})) target += `&${name}=${encodeURIComponent(value)}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = legacyCookieHeader(cookies);
    if (cookie !== undefined) headers.Cookie = cookie;
    if (call.userAgent !== undefined) headers['User-Agent'] = call.userAgent;
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }
    // Signed last, right before sending, so no assertion outlives its one request.
    headers[BRIDGE_ASSERTION_HEADER] = signBridgeAssertion(
      {
        op: `session.${op}`,
        sid: call.legacySessionId,
        sub: spec.sub,
        ttlSeconds: ASSERTION_TTL_SECONDS,
        now: opts.clock.now(),
      },
      opts.hmacKey,
    );

    let response: Response;
    let text: string;
    try {
      response = await doFetch(target, {
        method: spec.method,
        headers,
        body,
        // A followed redirect would replay the single-use assertion; the bridge answers none.
        redirect: 'manual',
        signal: AbortSignal.timeout(SERVICE_CALL_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (err) {
      throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
    }
    if (!response.ok) throw httpFailure(op, response.status, errorToken(text));

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch (err) {
      throw new ServiceUnavailableError(BRIDGE_SERVICE, err);
    }
    return { body: parsed, setCookies: response.headers.getSetCookie() };
  }

  return {
    describe: (cookies, call) => send<LegacyDescribe>('describe', { method: 'GET' }, cookies, call),

    hydrate: (cookies, body, call) =>
      send<HydrateResult>('hydrate', { method: 'POST', sub: body.snapshot.user.userID, json: body }, cookies, call),

    markUsed: (cookies, tokens, call) =>
      send<MarkUsedResult>('markUsed', { method: 'POST', json: { tokens } }, cookies, call),

    usedSince: (cookies, since, call) =>
      send<UsedSinceResult>('usedSince', { method: 'GET', query: { since } }, cookies, call),

    end: (cookies, call) => send<EndResult>('end', { method: 'POST' }, cookies, call),
  };
}
