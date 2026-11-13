// Stand-in for the legacy Masa origin: pages answered as programmed, and the bridge pages behind the assertion guard.
import { randomInt } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { BRIDGE_ASSERTION_HEADER, MemoryNonceStore, verifyBridgeAssertion } from '@opt2/platform/legacy-compat';
import type { LegacyDescribe, LegacyUsedToken } from '../../src/session/identity-client.js';
import { sendBytes, sendJson, startHttpDouble, type RecordedRequest } from './http-double.js';

/** Web-root directory of the legacy bridge pages. */
export const BRIDGE_DIR = '/gateway/legacy-bridge/cfml';

/** Site ids the bridge's `site.cfm?op=list` reports. */
export const LEGACY_SITES: readonly string[] = Object.freeze(['default', 'tenant-a', 'tenant-b']);

/** JSON content type as legacy's JSON API sends it. */
export const LEGACY_JSON = 'application/json;charset=utf-8';

const SITE_PAGE = `${BRIDGE_DIR}/site.cfm`;
const SESSION_PAGE = `${BRIDGE_DIR}/session.cfm`;
const ASSERTION_HEADER = BRIDGE_ASSERTION_HEADER.toLowerCase();
const USER_KEYS = ['userID', 'username', 'siteID', 'subtype', 'password', 'fname', 'lname', 'email', 'remoteID', 'company'] as const;

/** One ColdFusion session the double holds, addressed by its `CFID` and `CFTOKEN` cookies. */
export interface LegacySession {
  sessionId: string;
  cfid: string;
  cftoken: string;
  usedTokens: LegacyUsedToken[];
}

/** Answers one non-bridge request. */
export type PageHandler = (req: RecordedRequest, res: ServerResponse) => void;

/** The legacy origin double. */
export interface LegacyDouble {
  readonly url: string;
  /** Every request received, bridge calls included. */
  readonly requests: RecordedRequest[];
  /** ColdFusion sessions by `sessionId`. */
  readonly sessions: Map<string, LegacySession>;
  /** Requests a client could have caused: everything except the site registry's periodic `site.cfm?op=list` reads. */
  forwarded(): RecordedRequest[];
  /** Page requests, outside the bridge directory. */
  pages(): RecordedRequest[];
  /** Calls to `session.cfm`. */
  bridgeCalls(): RecordedRequest[];
  /** Creates a session as a browser visit leaves it and returns it with its `Cookie` header. */
  openSession(): { session: LegacySession; cookie: string };
  /** Replaces the page handler; without an argument the default answers are restored. */
  setPages(handler?: PageHandler): void;
  clearRequests(): void;
  close(): Promise<void>;
}

/** `name=value` pairs of a `Cookie` header, by upper-case name. */
function cookiesOf(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (Array.isArray(header) ? header.join('; ') : (header ?? '')).split(';')) {
    const equals = pair.indexOf('=');
    if (equals > 0) cookies.set(pair.slice(0, equals).trim().toUpperCase(), pair.slice(equals + 1).trim());
  }
  return cookies;
}

/** Default pages: a path with a `missing` segment answers legacy's 404 envelope, every other path a JSON page. */
function defaultPage(req: RecordedRequest, res: ServerResponse): void {
  if (/\/missing(?:\/|$)/i.test(req.path)) {
    sendJson(res, 404, { apiversion: 'v1', method: 'findOne', params: {}, error: { code: 'notfound', message: 'Not Found' } }, {
      'content-type': LEGACY_JSON,
    });
    return;
  }
  sendJson(res, 200, { apiversion: 'v1', method: 'findOne', params: {}, data: { path: req.path, method: req.method } }, {
    'content-type': LEGACY_JSON,
  });
}

/** Describe's body for `session`: an anonymous visitor, as Masa's session start leaves `session.mura`. */
function describeOf(session: LegacySession): LegacyDescribe {
  const user = Object.fromEntries(USER_KEYS.map((key) => [key, key === 'subtype' ? 'Default' : '']));
  return {
    sessionId: session.sessionId,
    isLoggedIn: false,
    user: { ...(user as Record<(typeof USER_KEYS)[number], string>), lastlogin: '', passwordCreated: '' },
    memberships: '',
    membershipIds: '',
    csrfSecretKey: `secret-${session.cfid}`,
    usedTokens: [...session.usedTokens],
    siteId: '',
    serverTime: new Date().toISOString().slice(0, 23),
  };
}

/** Starts the legacy origin double; bridge calls must carry an assertion signed with `bridgeKey`. */
export async function startLegacyDouble(bridgeKey: string): Promise<LegacyDouble> {
  const sessions = new Map<string, LegacySession>();
  const nonces = new MemoryNonceStore();
  let pages: PageHandler = defaultPage;

  const newSession = (): LegacySession => {
    const cfid = String(randomInt(100_000, 999_999));
    const cftoken = String(randomInt(10_000_000, 99_999_999));
    const session: LegacySession = { sessionId: `masacms_${cfid}_${cftoken}`, cfid, cftoken, usedTokens: [] };
    sessions.set(session.sessionId, session);
    return session;
  };

  const attached = (req: RecordedRequest): LegacySession | undefined => {
    const cookies = cookiesOf(req.headers.cookie);
    return [...sessions.values()].find((s) => cookies.get('CFID') === s.cfid && cookies.get('CFTOKEN') === s.cftoken);
  };

  /** The guard of the bridge's Application.cfc: an empty 403 unless the assertion verifies for `<page>.<op>`. */
  const verified = (req: RecordedRequest, page: string, res: ServerResponse): { sid: string } | undefined => {
    const header = req.headers[ASSERTION_HEADER];
    const result = typeof header === 'string' ? verifyBridgeAssertion(header, bridgeKey, nonces) : undefined;
    const op = typeof req.query.op === 'string' ? req.query.op : '';
    if (result?.ok !== true || result.payload.op !== `${page}.${op}`) {
      sendBytes(res, 403, '');
      return undefined;
    }
    return { sid: result.payload.sid };
  };

  const sessionPage = (req: RecordedRequest, res: ServerResponse, sid: string): void => {
    const op = req.query.op;
    if (op === 'describe' && req.method === 'GET') {
      const existing = attached(req);
      const session = existing ?? newSession();
      const headers: Record<string, string | string[]> =
        existing === undefined
          ? { 'set-cookie': [`CFID=${session.cfid};Path=/;HttpOnly`, `CFTOKEN=${session.cftoken};Path=/;HttpOnly`] }
          : {};
      sendJson(res, 200, describeOf(session), headers);
      return;
    }
    if (op === 'markUsed' && req.method === 'POST') {
      const session = attached(req);
      if (session === undefined || session.sessionId !== sid) {
        sendJson(res, 409, { error: 'sessionMismatch', message: 'assertion sid differs from the session' });
        return;
      }
      const { tokens } = JSON.parse(req.body.toString('utf8')) as { tokens: LegacyUsedToken[] };
      const fresh = tokens.filter((entry) => !session.usedTokens.some((used) => used.token === entry.token));
      session.usedTokens.push(...fresh);
      sendJson(res, 200, { applied: fresh.length, serverTime: new Date().toISOString().slice(0, 23) });
      return;
    }
    sendJson(res, 404, { error: 'notFound', message: `unsupported op ${String(op)}` });
  };

  const double = await startHttpDouble((req, res) => {
    if (req.path === SITE_PAGE) {
      if (verified(req, 'site', res) === undefined) return;
      if (req.query.op === 'list' && req.method === 'GET') sendJson(res, 200, { sites: [...LEGACY_SITES] });
      else sendJson(res, 404, { error: 'notFound', message: 'unknown op' });
      return;
    }
    if (req.path === SESSION_PAGE) {
      const assertion = verified(req, 'session', res);
      if (assertion !== undefined) sessionPage(req, res, assertion.sid);
      return;
    }
    if (req.path.startsWith(`${BRIDGE_DIR}/`)) {
      sendBytes(res, 404, '');
      return;
    }
    pages(req, res);
  });

  return {
    url: double.url,
    requests: double.requests,
    sessions,
    forwarded: () => double.requests.filter((req) => !(req.path === SITE_PAGE && req.query.op === 'list')),
    pages: () => double.requests.filter((req) => !req.path.startsWith(`${BRIDGE_DIR}/`)),
    bridgeCalls: () => double.requests.filter((req) => req.path === SESSION_PAGE),
    openSession() {
      const session = newSession();
      return { session, cookie: `CFID=${session.cfid}; CFTOKEN=${session.cftoken}` };
    },
    setPages(handler) {
      pages = handler ?? defaultPage;
    },
    clearRequests: () => double.clearRequests(),
    close: () => double.close(),
  };
}
