// A real identity session of a seeded role user in the gateway's active session mode, and web's relayed service calls with its user token.
import {
  createLocalInvocationMinter,
  loadLocalSigningKeys,
  rolesForService,
  type InvocationMinter,
  type UserClaims,
} from '@opt2/platform/auth';
import { BRIDGE_ASSERTION_HEADER, signBridgeAssertion } from '@opt2/platform/legacy-compat';

import { jsonApiTokens } from '../../src/golden/session.js';
import { createHttpSession, type HttpRequest, type HttpResult, type HttpSession } from '../../src/lib/http.js';
import {
  bridgeHmacKey,
  describedSession,
  legacySessionCookieHeader,
  mintedToken,
  relayPath,
  sessionModeOf,
  snapshotSession,
  targetSessionId,
  type DescribedSession,
  type MintedToken,
  type SessionMode,
} from '../../src/lib/identity-session.js';
import { stateDir } from '../../src/lib/paths.js';
import { cutoverStatus } from '../../src/repro/cutover.js';
import { sessionForSubject } from './admin-login.js';
import { gatewayUrl, legacyUrl, operatorInvoker, serviceUrl } from './stack.js';

/** A target-bound read: forwarding it in legacy-primary mode, the gateway describes the legacy session and identity adopts it. */
export const ADOPTION_PROBE_PATH = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';

const DESCRIBE_PATH = '/gateway/legacy-bridge/cfml/session.cfm';
const DESCRIBE_OP = 'describe';
const DESCRIBE_ASSERTION_OP = `session.${DESCRIBE_OP}`;
const IDENTITY = 'identity';
const GATEWAY = 'gateway';
const WEB = 'web';
const TOKENS_PATH = '/internal/v1/tokens';
const ACTIVE_STATE = 'active';
const FIRST_SERVER_ERROR = 500;

/** One relayed call; `path` is the callee's own path, without its query. */
export interface RelayCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: `/${string}`;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  json?: unknown;
}

/** A seeded user's gateway login as an identity session, with the CSRF tokens and relayed calls web makes for it. */
export interface IdentitySession {
  role: string;
  username: string;
  site: string;
  /** Masa `UserID`, the user token's `sub`. */
  userId: string;
  /** Identity session id: the ColdFusion session id of a legacy-primary login, identity's own id in target-primary. */
  sessionId: string;
  /** Claims of the user token minted when the session was opened. */
  claims: UserClaims;
  /** Single-use CSRF headers for `context` from `generateCSRFTokens` through the gateway, under the session's identity secret. */
  csrfHeaders(context: string): Promise<Record<string, string>>;
  /** Web's call to `service` through the gateway relay, with a freshly minted user token and web's invocation credential. */
  relay(service: string, call: RelayCall): Promise<HttpResult>;
}

/** Local invocation minter of workload `caller`, signing with the stack's generated key pair. */
async function minterFor(caller: string): Promise<InvocationMinter> {
  const keys = await loadLocalSigningKeys(stateDir(), { requirePrivate: true });
  return createLocalInvocationMinter({ keys, caller, roles: rolesForService(caller) });
}

// Identity keys a legacy-primary session by ColdFusion's session.sessionid, which only describe reports.
/** The bridge's read-only describe of the legacy session `session`'s cookies attach. */
async function describe(session: HttpSession, username: string): Promise<DescribedSession> {
  const cookie = legacySessionCookieHeader(await session.cookieHeader());
  const bridge = createHttpSession({ baseUrl: legacyUrl() });
  const result = await bridge.get(DESCRIBE_PATH, {
    query: { op: DESCRIBE_OP },
    headers: {
      accept: 'application/json',
      cookie,
      [BRIDGE_ASSERTION_HEADER]: signBridgeAssertion({ op: DESCRIBE_ASSERTION_OP }, bridgeHmacKey()),
    },
    // A followed redirect would replay the single-use assertion.
    followRedirects: false,
  });
  if (result.status !== 200) throw new Error(`the legacy bridge ${DESCRIBE_ASSERTION_OP} answered ${result.status}`);
  return describedSession(result.json(), username);
}

/** One call to identity's gateway-only internal routes, carrying the gateway's invocation credential. */
async function identityCall(gateway: InvocationMinter, req: Pick<HttpRequest, 'method' | 'path' | 'json'>): Promise<HttpResult> {
  const baseUrl = serviceUrl(IDENTITY);
  const headers = await gateway.headersFor({ name: IDENTITY, url: baseUrl });
  return createHttpSession({ baseUrl }).request({ ...req, headers, followRedirects: false });
}

/** Identity's path `/internal/v1/sessions/{sid}/<leaf>` of session `sessionId`. */
function sessionPath(sessionId: string, leaf: 'state' | 'snapshot'): string {
  return `/internal/v1/sessions/${encodeURIComponent(sessionId)}/${leaf}`;
}

/** The session mode of the gateway's active cut-over version, as its status reports it. */
async function activeSessionMode(): Promise<SessionMode> {
  return sessionModeOf(await cutoverStatus({ gatewayUrl: gatewayUrl(), invoker: await operatorInvoker() }));
}

// In target-primary mode identity issued the session cookies at login, and its JSESSIONID, else CFTOKEN, names the session.
/** Identity's login snapshot of the target-primary session `session`'s identity-issued cookies name. */
async function snapshot(gateway: InvocationMinter, session: HttpSession, username: string): Promise<DescribedSession> {
  const sessionId = targetSessionId(await session.cookieHeader());
  const result = await identityCall(gateway, { method: 'GET', path: sessionPath(sessionId, 'snapshot') });
  if (result.status !== 200) throw new Error(`identity's snapshot of ${username}'s session ${sessionId} answered ${result.status}`);
  return snapshotSession(result.json(), username);
}

/** The logged-in session of `session`: legacy-primary has the gateway adopt it through the probe, target-primary is identity's. */
async function loggedIn(
  mode: SessionMode,
  gateway: InvocationMinter,
  subject: { session: HttpSession; username: string; site: string },
): Promise<DescribedSession> {
  const { session, username, site } = subject;
  if (mode === 'target-primary') return snapshot(gateway, session, username);
  const probe = await session.get(ADOPTION_PROBE_PATH, { query: { siteid: site }, followRedirects: false });
  if (probe.status >= FIRST_SERVER_ERROR) throw new Error(`the adoption probe ${ADOPTION_PROBE_PATH} answered ${probe.status}`);
  return describe(session, username);
}

/** Throws unless identity reports `described` as an active session of its user. */
async function requireAdopted(
  gateway: InvocationMinter,
  described: DescribedSession,
  username: string,
  mode: SessionMode,
): Promise<void> {
  const result = await identityCall(gateway, { method: 'GET', path: sessionPath(described.sessionId, 'state') });
  const body = result.status === 200 ? result.json<{ state?: unknown; userId?: unknown }>() : {};
  const adopted =
    body.state === ACTIVE_STATE &&
    typeof body.userId === 'string' &&
    body.userId.toUpperCase() === described.userId.toUpperCase();
  if (!adopted) {
    throw new Error(`identity holds no active ${mode} session of ${username} (HTTP ${result.status})`);
  }
}

/**
 * Logs the seeded `role` user of tenant-a in through the gateway, finds its identity session in the gateway's active
 * session mode, and mints its user token from identity, as the gateway does for a target-bound request.
 */
export async function openIdentitySession(role: string): Promise<IdentitySession> {
  const subject = await sessionForSubject(role, { origin: 'gateway' });
  const { session, username, site } = subject;
  if (subject.kind !== 'admin' || username === undefined || site === undefined) {
    throw new Error(`${role} is not a seeded admin-login subject`);
  }
  const [mode, gateway, web] = await Promise.all([activeSessionMode(), minterFor(GATEWAY), minterFor(WEB)]);
  const described = await loggedIn(mode, gateway, { session, username, site });
  await requireAdopted(gateway, described, username, mode);

  const mint = async (): Promise<MintedToken> => {
    const result = await identityCall(gateway, {
      method: 'POST',
      path: TOKENS_PATH,
      json: { sessionId: described.sessionId, siteId: site },
    });
    if (result.status !== 200) throw new Error(`identity mintUserToken for ${username} on ${site} answered ${result.status}`);
    return mintedToken(result.json(), { sessionId: described.sessionId, site });
  };
  const { claims } = await mint();
  if (claims.sub.toUpperCase() !== described.userId.toUpperCase()) {
    throw new Error(`identity minted ${username}'s user token for another user`);
  }

  // Web calls the gateway server to server, so the relay session carries no browser cookies.
  const relaySession = createHttpSession({ baseUrl: gatewayUrl() });
  return {
    role,
    username,
    site,
    userId: claims.sub,
    sessionId: described.sessionId,
    claims,
    csrfHeaders: (context) => jsonApiTokens(session, site, context),
    async relay(service, call) {
      const { token } = await mint();
      const path = relayPath(service, call.path);
      const invocation = await web.headersFor({ name: GATEWAY, url: relaySession.baseUrl });
      return relaySession.request({
        method: call.method,
        path,
        query: call.query,
        json: call.json,
        headers: { ...call.headers, ...invocation, authorization: `Bearer ${token}` },
        followRedirects: false,
      });
    },
  };
}
