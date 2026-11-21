// Pure parts of an e2e identity session: web's relay path, the gateway's session mode, the session cookies, the bridge
// describe and identity snapshot answers, identity's user-token answer and the local bridge key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userClaimsSchema, type UserClaims } from '@opt2/platform/auth';
import { isLegacySessionCookie, parseCookieHeader, sessionIdForJsessionid } from '@opt2/platform/legacy-compat';
import { secretsDir, type EnvLike } from './paths.js';

/** Gateway route prefix of web's service relay. */
export const RELAY_PREFIX = '/internal/v1/relay';

/** Bridge key file under `${OPT2_STATE_DIR}/secrets/`, as `repro:secrets` writes it. */
export const BRIDGE_KEY_FILE = 'bridge-hmac-key';

/** Variable that carries the bridge key ahead of the key file. */
export const BRIDGE_KEY_VARIABLE = 'OPT2_BRIDGE_HMAC_KEY';

const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;

/** Identity-issued cookie that names the session in target-primary mode. */
const TARGET_SESSION_COOKIE = 'JSESSIONID';

/** Names it instead where legacy sets no `JSESSIONID`, as the gateway re-emits identity's cookies under legacy's names. */
const TARGET_SESSION_FALLBACK_COOKIE = 'CFTOKEN';

/** Which side issues the browser's session cookies, as the gateway's cut-over status reports it. */
export type SessionMode = 'legacy-primary' | 'target-primary';

const SESSION_MODES: readonly SessionMode[] = ['legacy-primary', 'target-primary'];

/** A logged-in session as the bridge's `op=describe` or identity's session snapshot reports it. */
export interface DescribedSession {
  /** Identity session id: ColdFusion `session.sessionid` in legacy-primary, identity's own id in target-primary. */
  sessionId: string;
  /** Masa `UserID` of the logged-in user. */
  userId: string;
}

/** Identity's user token for one session and site. */
export interface MintedToken {
  token: string;
  /** Expiry in epoch seconds. */
  expiresAt: number;
  claims: UserClaims;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Gateway path of web's relayed call to `service` at the callee path `path`. */
export function relayPath(service: string, path: string): string {
  if (!SERVICE_NAME.test(service)) throw new Error(`invalid relay service ${JSON.stringify(service)}`);
  if (!path.startsWith('/')) throw new Error(`relay callee path must start with /, got ${JSON.stringify(path)}`);
  return `${RELAY_PREFIX}/${service}${path}`;
}

/** `Cookie` header of the CFID, CFTOKEN and JSESSIONID values in `cookieHeader`; throws when none has a value. */
export function legacySessionCookieHeader(cookieHeader: string): string {
  const pairs = [...parseCookieHeader(cookieHeader)].filter(([name, value]) => isLegacySessionCookie(name) && value !== '');
  if (pairs.length === 0) throw new Error('the session holds no legacy session cookie (CFID, CFTOKEN or JSESSIONID)');
  return pairs.map(([name, value]) => `${name.toUpperCase()}=${value}`).join('; ');
}

/** The `sessionMode` of the gateway's cut-over status; throws unless it is one the gateway defines. */
export function sessionModeOf(status: unknown): SessionMode {
  const reported = asRecord(status)?.sessionMode;
  const mode = SESSION_MODES.find((known) => known === reported);
  if (mode === undefined) throw new Error(`the gateway's cut-over status reports no session mode (got ${JSON.stringify(reported)})`);
  return mode;
}

/** The identity session id the identity-issued `JSESSIONID`, else `CFTOKEN`, in `cookieHeader` names; throws when it holds none. */
export function targetSessionId(cookieHeader: string): string {
  const cookies = parseCookieHeader(cookieHeader);
  const value = cookies.get(TARGET_SESSION_COOKIE) || cookies.get(TARGET_SESSION_FALLBACK_COOKIE);
  if (value === undefined || value === '') throw new Error('the session holds no identity-issued JSESSIONID or CFTOKEN cookie');
  return sessionIdForJsessionid(value);
}

/** `sessionId` and the user of `user`; throws unless it is logged in as `username`, naming `source` and `subject`. */
function loggedInSession(
  answer: { sessionId: unknown; isLoggedIn: unknown; user: Record<string, unknown> | undefined },
  username: string,
  labels: { source: string; subject: string },
): DescribedSession {
  const { sessionId, isLoggedIn, user } = answer;
  const name = user?.username;
  const userId = user?.userID;
  if (!nonEmpty(sessionId)) throw new Error(`${labels.source} answered no sessionId`);
  if (isLoggedIn !== true || typeof name !== 'string' || name.toLowerCase() !== username.toLowerCase()) {
    throw new Error(`${labels.subject} is not logged in as ${username}`);
  }
  if (!nonEmpty(userId)) throw new Error(`${labels.subject} of ${username} has no userID`);
  return { sessionId, userId };
}

/** Session id and user of a describe answer; throws unless it reports a session logged in as `username`. */
export function describedSession(body: unknown, username: string): DescribedSession {
  const record = asRecord(body);
  return loggedInSession({ sessionId: record?.sessionId, isLoggedIn: record?.isLoggedIn, user: asRecord(record?.user) }, username, {
    source: 'the legacy bridge describe',
    subject: 'the described legacy session',
  });
}

/** Session id and user of identity's session snapshot answer; throws unless its login snapshot is logged in as `username`. */
export function snapshotSession(body: unknown, username: string): DescribedSession {
  const record = asRecord(body);
  const user = asRecord(asRecord(record?.loginSnapshot)?.user);
  return loggedInSession({ sessionId: record?.sessionId, isLoggedIn: user?.isLoggedIn, user }, username, {
    source: "identity's session snapshot",
    subject: 'the identity session',
  });
}

/** Token, expiry and claims of identity's `mintUserToken` answer; throws unless they belong to `expected`. */
export function mintedToken(body: unknown, expected: { sessionId: string; site: string }): MintedToken {
  const record = asRecord(body);
  const token = record?.token;
  const expiresAt = record?.expiresAt;
  if (!nonEmpty(token) || typeof expiresAt !== 'number') throw new Error('identity answered no user token');
  const parsed = userClaimsSchema.safeParse(record?.claims);
  if (!parsed.success) throw new Error('identity answered user-token claims outside the UserClaims contract');
  const claims = parsed.data;
  if (claims.sid !== expected.sessionId) throw new Error('identity minted the user token for another session');
  if (claims.site.toLowerCase() !== expected.site.toLowerCase()) {
    throw new Error(`identity minted the user token for site ${claims.site}, not ${expected.site}`);
  }
  return { token, expiresAt, claims };
}

/** {@link BRIDGE_KEY_VARIABLE}, else the trimmed key file; throws when neither holds a key. */
export function bridgeHmacKey(env: EnvLike = process.env): string {
  const configured = env[BRIDGE_KEY_VARIABLE];
  if (nonEmpty(configured)) return configured;
  const file = join(secretsDir(env), BRIDGE_KEY_FILE);
  let key = '';
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (key === '') {
    throw new Error(`no bridge key: ${BRIDGE_KEY_VARIABLE} is unset and ${file} is missing or empty; run harness/repro/up.sh`);
  }
  return key;
}
