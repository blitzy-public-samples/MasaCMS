import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_ASSERTION_HEADER,
  MemoryNonceStore,
  encodeBridgePayload,
  verifyBridgeAssertion,
  type BridgeAssertionPayload,
} from '@opt2/platform/legacy-compat';
import { SERVICE_CALL_TIMEOUT_MS, ServiceUnavailableError, fixedClock } from '@opt2/platform/service-kit';
import {
  createBridgeClient,
  createSiteListClient,
  type BridgeClient,
  type BridgeClientOptions,
  type BridgeResult,
  type HydrateBody,
  type LegacyCookies,
  type LegacyDescribe,
  type LegacyDescribeUser,
  type LegacyUsedToken,
} from '../../src/session/bridge-client.js';
import { TEST_BRIDGE_KEY, TEST_CLOCK, UNREACHABLE_URL } from '../helpers/env.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from '../helpers/http-double.js';
import {
  parseWireTime,
  startLegacyOrigin,
  type CreatedSession,
  type LegacyOrigin,
  type LegacySession,
} from '../helpers/legacy-origin.js';

const SESSION_PAGE = '/gateway/legacy-bridge/cfml/session.cfm';
const SITE_PAGE = '/gateway/legacy-bridge/cfml/site.cfm';
// The README's documented test key, not a secret.
const VECTOR_KEY = 'opt2-bridge-test-vector-key-0001';
const VECTOR_NOW_SECONDS = 1782820800;
const VECTOR_JSON =
  '{"aud":"legacy-bridge","op":"session.hydrate","sid":"OPT2TEST_1001_12345678",' +
  '"sub":"9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F","siteId":"default","exp":1782820860,' +
  '"nonce":"3b9f1c2e-7d4a-4e8b-9f6a-1c2d3e4f5a6b"}';
const VECTOR_B64 =
  'eyJhdWQiOiJsZWdhY3ktYnJpZGdlIiwib3AiOiJzZXNzaW9uLmh5ZHJhdGUiLCJzaWQiOiJPUFQyVEVTVF8xMDAxXzEyMzQ1' +
  'Njc4Iiwic3ViIjoiOUMxRDdFMkYtM0E0Qi00QzVELThFOUYwQTFCMkMzRDRFNUYiLCJzaXRlSWQiOiJkZWZhdWx0IiwiZXhw' +
  'IjoxNzgyODIwODYwLCJub25jZSI6IjNiOWYxYzJlLTdkNGEtNGU4Yi05ZjZhLTFjMmQzZTRmNWE2YiJ9';
const VECTOR_MAC = '8c7859b0af8d3c07a627b6fb7f1968d9ae7020f06e86108dd7288f996a1d6a09';

const NOW = new Date(VECTOR_NOW_SECONDS * 1000);
const SERVER_TIME = '2026-06-30T12:00:00.000';
const SINCE = '2026-06-30 11:59:00.000';
const COOKIES: LegacyCookies = { CFID: '1001', CFTOKEN: '12345678', JSESSIONID: 'node01opt2test' };
const COOKIE_HEADER = 'CFID=1001; CFTOKEN=12345678; JSESSIONID=node01opt2test';
const CALL = { legacySessionId: 'OPT2TEST_1001_12345678', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) opt2-test' };

const USER: LegacyDescribeUser = {
  userID: '9C1D7E2F-3A4B-4C5D-8E9F0A1B2C3D4E5F',
  username: 'qa_editor',
  siteID: 'default',
  subtype: 'Default',
  password: '',
  fname: 'Zoë',
  lname: "O'Brien & <QA>",
  email: 'qa_editor@example.com',
  remoteID: '',
  company: '',
  lastlogin: '2026-06-30T11:55:00.000',
  passwordCreated: '2026-01-15T09:30:00.000',
};
const USED: LegacyUsedToken[] = [
  { token: 'USED-TOKEN-0001', usedAt: '2026-06-30T11:58:00.000' },
  { token: 'USED-TOKEN-0002', usedAt: '2026-06-30T11:59:30.250' },
];
const MEMBERSHIPS = `Editor;default;0,S2IsPrivate;default,S2IsPrivate,qa_editor;username;default`;
const MEMBERSHIP_IDS = `EDITOR-GROUP-0001,${USER.userID}`;
const DESCRIBE: LegacyDescribe = {
  sessionId: CALL.legacySessionId,
  isLoggedIn: true,
  user: USER,
  memberships: MEMBERSHIPS,
  membershipIds: MEMBERSHIP_IDS,
  csrfSecretKey: 'OPT2-TEST-CSRF-0001',
  usedTokens: USED,
  siteId: 'default',
  serverTime: SERVER_TIME,
};
const HYDRATE: HydrateBody = {
  snapshot: { user: USER, memberships: MEMBERSHIPS, membershipIds: MEMBERSHIP_IDS },
  csrfSecretKey: 'OPT2-TEST-CSRF-0002',
  usedTokens: USED,
};

interface OpCase {
  op: 'describe' | 'hydrate' | 'markUsed' | 'usedSince' | 'end';
  method: 'GET' | 'POST';
  url: string;
  query: Record<string, string>;
  body: unknown;
  sub: string;
  answer: unknown;
  invoke: (client: BridgeClient) => Promise<BridgeResult<unknown>>;
}

const OP_CASES: OpCase[] = [
  {
    op: 'describe',
    method: 'GET',
    url: `${SESSION_PAGE}?op=describe`,
    query: { op: 'describe' },
    body: undefined,
    sub: '',
    answer: DESCRIBE,
    invoke: (client) => client.describe(COOKIES, CALL),
  },
  {
    op: 'hydrate',
    method: 'POST',
    url: `${SESSION_PAGE}?op=hydrate`,
    query: { op: 'hydrate' },
    body: HYDRATE,
    sub: USER.userID,
    answer: { sessionId: CALL.legacySessionId, hydrated: true, serverTime: SERVER_TIME },
    invoke: (client) => client.hydrate(COOKIES, HYDRATE, CALL),
  },
  {
    op: 'markUsed',
    method: 'POST',
    url: `${SESSION_PAGE}?op=markUsed`,
    query: { op: 'markUsed' },
    body: { tokens: USED },
    sub: '',
    answer: { applied: 2, serverTime: SERVER_TIME },
    invoke: (client) => client.markUsed(COOKIES, USED, CALL),
  },
  {
    op: 'usedSince',
    method: 'GET',
    url: `${SESSION_PAGE}?op=usedSince&since=2026-06-30%2011%3A59%3A00.000`,
    query: { op: 'usedSince', since: SINCE },
    body: undefined,
    sub: '',
    answer: { tokens: USED.slice(1), serverTime: SERVER_TIME },
    invoke: (client) => client.usedSince(COOKIES, SINCE, CALL),
  },
  {
    op: 'end',
    method: 'POST',
    url: `${SESSION_PAGE}?op=end`,
    query: { op: 'end' },
    body: undefined,
    sub: '',
    answer: { ended: true, serverTime: SERVER_TIME },
    invoke: (client) => client.end(COOKIES, CALL),
  },
];

function invokerOf(op: OpCase['op']): OpCase['invoke'] {
  const found = OP_CASES.find((c) => c.op === op);
  if (found === undefined) throw new Error(`no case for ${op}`);
  return found.invoke;
}

function answerByOp(req: RecordedRequest, res: ServerResponse): void {
  const found = OP_CASES.find((c) => c.op === req.query.op);
  sendJson(res, found === undefined ? 404 : 200, found?.answer ?? { error: 'notFound' });
}

function assertionOf(req: RecordedRequest | undefined): string {
  const value = req?.headers[BRIDGE_ASSERTION_HEADER.toLowerCase()];
  expect(value).toEqual(expect.any(String));
  return value as string;
}

function claimsOf(assertion: string): BridgeAssertionPayload {
  const [b64 = ''] = assertion.split('.');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as BridgeAssertionPayload;
}

async function failureOf(pending: Promise<unknown>): Promise<ServiceUnavailableError> {
  const error = await pending.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableError);
  expect(error).toMatchObject({ service: 'legacy-bridge' });
  return error as ServiceUnavailableError;
}

let double: HttpDouble;

function client(overrides: Partial<BridgeClientOptions> = {}): BridgeClient {
  return createBridgeClient({ legacyOrigin: double.url, hmacKey: VECTOR_KEY, clock: fixedClock(NOW), ...overrides });
}

beforeAll(async () => {
  double = await startHttpDouble(answerByOp);
});

beforeEach(() => {
  double.setHandler(answerByOp);
  double.clearRequests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await double.close();
});

describe('bridge assertion signing vector', () => {
  it('reproduces the README vector byte for byte', () => {
    const payload = JSON.parse(VECTOR_JSON) as BridgeAssertionPayload;
    const b64 = encodeBridgePayload(payload);

    expect(b64).toBe(VECTOR_B64);
    expect(Buffer.from(VECTOR_B64, 'base64url').toString('utf8')).toBe(VECTOR_JSON);
    expect(createHmac('sha256', Buffer.from(VECTOR_KEY, 'utf8')).update(b64, 'ascii').digest('hex')).toBe(VECTOR_MAC);
    expect(
      verifyBridgeAssertion(
        `${VECTOR_B64}.${VECTOR_MAC}`,
        VECTOR_KEY,
        new MemoryNonceStore(),
        new Date(VECTOR_NOW_SECONDS * 1000),
      ),
    ).toEqual({ ok: true, payload });
  });
});

describe('createBridgeClient', () => {
  it.each(OP_CASES)('$op sends a signed $method to session.cfm and returns the answer', async (c) => {
    const result = await c.invoke(client());

    expect(result).toEqual({ body: c.answer, setCookies: [] });
    expect(double.requests).toHaveLength(1);
    const [req] = double.requests;
    expect(req?.method).toBe(c.method);
    expect(req?.path).toBe(SESSION_PAGE);
    expect(req?.url).toBe(c.url);
    expect(req?.query).toEqual(c.query);
    expect(req?.headers.cookie).toBe(COOKIE_HEADER);
    expect(req?.headers['user-agent']).toBe(CALL.userAgent);
    expect(req?.headers.accept).toBe('application/json');
    expect(req?.headers['content-type']).toBe(c.body === undefined ? undefined : 'application/json');
    const sent: unknown = req?.body.length === 0 ? undefined : JSON.parse(req?.body.toString('utf8') ?? '');
    expect(sent).toEqual(c.body);

    const assertion = assertionOf(req);
    const claims = claimsOf(assertion);
    const { exp, nonce, ...named } = claims;
    expect(named).toEqual({
      aud: 'legacy-bridge',
      op: `session.${c.op}`,
      sid: CALL.legacySessionId,
      sub: c.sub,
      siteId: '',
    });
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(exp - VECTOR_NOW_SECONDS).toBeGreaterThan(0);
    expect(exp - VECTOR_NOW_SECONDS).toBeLessThanOrEqual(60);
    expect(verifyBridgeAssertion(assertion, VECTOR_KEY, new MemoryNonceStore(), NOW)).toEqual({
      ok: true,
      payload: claims,
    });
  });

  it('signs every call with a fresh nonce the bridge accepts once', async () => {
    const bridge = client();
    for (const c of [...OP_CASES, ...OP_CASES]) await c.invoke(bridge);

    const store = new MemoryNonceStore();
    const assertions = double.requests.map((req) => assertionOf(req));
    for (const assertion of assertions) {
      expect(verifyBridgeAssertion(assertion, VECTOR_KEY, store, NOW)).toMatchObject({ ok: true });
    }
    expect(new Set(assertions.map((a) => claimsOf(a).nonce)).size).toBe(OP_CASES.length * 2);
  });

  it.each([
    ['describe', (bridge: BridgeClient) => bridge.describe(COOKIES)],
    ['hydrate', (bridge: BridgeClient) => bridge.hydrate({}, HYDRATE)],
  ])('%s without call options signs an empty sid', async (_op, invoke) => {
    await invoke(client());

    expect(claimsOf(assertionOf(double.requests[0])).sid).toBe('');
  });

  it('hydrate posts the snapshot body unchanged', async () => {
    await client().hydrate(COOKIES, HYDRATE, CALL);

    expect(double.requests[0]?.body.toString('utf8')).toBe(JSON.stringify(HYDRATE));
  });

  it.each<[string, LegacyCookies, string | undefined]>([
    [
      'forwards only non-empty legacy session cookies',
      { CFID: '1001', CFTOKEN: '', JSESSIONID: 'node01opt2test', userid: 'U-1', userHash: 'H-1' },
      'CFID=1001; JSESSIONID=node01opt2test',
    ],
    [
      'forwards jar entries under their observed name',
      {
        CFID: { name: 'cfid', value: '1001' },
        CFTOKEN: { value: '12345678' },
        JSESSIONID: { name: 'JSESSIONID', value: '' },
      },
      'cfid=1001; CFTOKEN=12345678',
    ],
    ['sends no Cookie header without non-empty session cookies', { CFID: '', userid: 'U-1' }, undefined],
    ['sends no Cookie header without cookies', {}, undefined],
  ])('%s', async (_name, cookies, header) => {
    await client().end(cookies, CALL);

    expect(double.requests[0]?.headers.cookie).toBe(header);
  });

  it('passes fetch only the given headers, manual redirects and the call timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(DESCRIBE)));

    await expect(client({ fetch: fetchMock }).describe({})).resolves.toEqual({ body: DESCRIBE, setCookies: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(target).toBe(`${double.url}${SESSION_PAGE}?op=describe`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', body: undefined });
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(['Accept', BRIDGE_ASSERTION_HEADER].sort());
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(SERVICE_CALL_TIMEOUT_MS);
  });

  it('strips trailing slashes from the legacy origin', async () => {
    await client({ legacyOrigin: `${double.url}//` }).describe(COOKIES, CALL);

    expect(double.requests[0]?.url).toBe(`${SESSION_PAGE}?op=describe`);
  });

  it('returns the Set-Cookie values ColdFusion sent verbatim', async () => {
    const setCookies = [
      'CFID=2002;Path=/;HttpOnly;SameSite=Lax',
      'CFTOKEN=0;Path=/;Expires=Thu, 01 Jan 1970 00:00:00 GMT;HttpOnly',
      'JSESSIONID=node02opt2test.node0; Path=/; HttpOnly',
    ];
    const answer = { sessionId: 'OPT2TEST_2002_0', hydrated: true, serverTime: SERVER_TIME };
    double.setHandler((_req, res) => {
      sendJson(res, 200, answer, { 'set-cookie': setCookies });
    });

    await expect(client().hydrate({}, HYDRATE)).resolves.toEqual({ body: answer, setCookies });
  });

  it.each<{ status: number; op: OpCase['op']; body: string; error?: string; headers?: Record<string, string> }>([
    { status: 302, op: 'describe', body: '', headers: { location: '/followed' } },
    { status: 400, op: 'usedSince', body: '{"error":"badRequest","message":"since"}', error: 'badRequest' },
    { status: 401, op: 'end', body: '' },
    { status: 403, op: 'markUsed', body: '' },
    { status: 409, op: 'markUsed', body: '{"error":"sessionMismatch"}', error: 'sessionMismatch' },
    { status: 409, op: 'hydrate', body: '{"error":"subjectMismatch"}', error: 'subjectMismatch' },
    { status: 500, op: 'describe', body: '{"error":"serverError","message":"expression"}', error: 'serverError' },
    { status: 502, op: 'end', body: '{"error":42}' },
    { status: 503, op: 'usedSince', body: '<html>Service Unavailable</html>' },
  ])('fails closed on HTTP $status from session.$op', async ({ status, op, body, error, headers }) => {
    double.setHandler((_req, res) => {
      sendBytes(res, status, body, headers);
    });

    const failure = await failureOf(invokerOf(op)(client()));

    const detail = error === undefined ? '' : ` ${error}`;
    expect(failure.message).toBe(`Service legacy-bridge unavailable (HTTP_${String(status)})`);
    expect(failure.cause).toMatchObject({
      message: `legacy bridge session.${op} answered HTTP ${String(status)}${detail}`,
      code: `HTTP_${String(status)}`,
      status,
      error,
    });
    expect(double.requests).toHaveLength(1);
  });

  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });

  it.each<[string, typeof fetch]>([
    ['rejects', () => Promise.reject(refused)],
    [
      'throws synchronously',
      () => {
        throw refused;
      },
    ],
  ])('fails closed when fetch %s', async (_how, failingFetch) => {
    const failure = await failureOf(client({ fetch: failingFetch }).describe(COOKIES, CALL));

    expect(failure.cause).toBe(refused);
  });

  it.each(OP_CASES)('session.$op fails closed when the legacy origin refuses connections', async (c) => {
    const failure = await failureOf(c.invoke(client({ legacyOrigin: UNREACHABLE_URL })));

    expect(failure.cause).toBeInstanceOf(TypeError);
    expect(double.requests).toHaveLength(0);
  });

  it.each<[string, (res: ServerResponse) => void]>([
    ['before the headers', () => undefined],
    ['mid-body', (res) => res.writeHead(200, { 'content-type': 'application/json' }).write('{"sessionId":')],
  ])('fails closed when the bridge stalls %s past the call timeout', async (_when, stall) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(50));
    double.setHandler((_req, res) => {
      stall(res);
    });

    const failure = await failureOf(client().describe(COOKIES, CALL));

    expect(spy).toHaveBeenCalledWith(SERVICE_CALL_TIMEOUT_MS);
    expect(failure.cause).toMatchObject({ name: 'TimeoutError' });
  });

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><body>Masa CMS</body></html>', 'text/html; charset=utf-8'],
    ['an empty body', '', 'application/json; charset=utf-8'],
  ])('fails closed on a 2xx with %s', async (_name, body, type) => {
    double.setHandler((_req, res) => {
      sendBytes(res, 200, body, { 'content-type': type });
    });

    const failure = await failureOf(client().usedSince(COOKIES, SINCE, CALL));

    expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  it('refuses an empty HMAC key before sending anything', async () => {
    await expect(client({ hmacKey: '' }).end(COOKIES, CALL)).rejects.toBeInstanceOf(RangeError);

    expect(double.requests).toHaveLength(0);
  });
});

const LEGACY_CSRF = 'OPT2-TEST-CSRF-LEGACY';
const LEGACY_LEDGER: LegacyUsedToken[] = [
  { token: 'LEGACY-TOKEN-0001', usedAt: '2026-06-30T11:50:00.000' },
  { token: 'LEGACY-TOKEN-0002', usedAt: '2026-06-30T11:58:00.000' },
];
const LEGACY_SINCE = '2026-06-30T11:55:00.000';

interface SessionState {
  hydrations: number;
  ended: boolean;
  usedTokens: LegacyUsedToken[];
}

interface LegacyCase {
  op: OpCase['op'];
  method: 'GET' | 'POST';
  sub: string;
  /** JSON body the double receives; undefined when the op sends none. */
  sent: unknown;
  invoke: (bridge: BridgeClient, s: CreatedSession) => Promise<BridgeResult<unknown>>;
  answer: (s: CreatedSession) => unknown;
  after: SessionState;
}

function callOf(s: CreatedSession) {
  return { legacySessionId: s.session.legacySessionId, userAgent: CALL.userAgent };
}

const LEGACY_CASES: LegacyCase[] = [
  {
    op: 'describe',
    method: 'GET',
    sub: '',
    sent: undefined,
    invoke: (bridge, s) => bridge.describe(s.cookies, callOf(s)),
    answer: (s) => ({
      sessionId: s.session.legacySessionId,
      isLoggedIn: true,
      user: USER,
      memberships: MEMBERSHIPS,
      membershipIds: MEMBERSHIP_IDS,
      csrfSecretKey: LEGACY_CSRF,
      usedTokens: LEGACY_LEDGER,
      siteId: 'tenant-a',
      serverTime: SERVER_TIME,
    }),
    after: { hydrations: 0, ended: false, usedTokens: LEGACY_LEDGER },
  },
  {
    op: 'hydrate',
    method: 'POST',
    sub: USER.userID,
    sent: HYDRATE,
    invoke: (bridge, s) => bridge.hydrate(s.cookies, HYDRATE, callOf(s)),
    answer: (s) => ({ sessionId: s.session.legacySessionId, hydrated: true, serverTime: SERVER_TIME }),
    after: { hydrations: 1, ended: false, usedTokens: USED },
  },
  {
    op: 'markUsed',
    method: 'POST',
    sub: '',
    sent: { tokens: USED },
    invoke: (bridge, s) => bridge.markUsed(s.cookies, USED, callOf(s)),
    answer: () => ({ applied: 2, serverTime: SERVER_TIME }),
    after: { hydrations: 0, ended: false, usedTokens: [...LEGACY_LEDGER, ...USED] },
  },
  {
    op: 'usedSince',
    method: 'GET',
    sub: '',
    sent: undefined,
    invoke: (bridge, s) => bridge.usedSince(s.cookies, LEGACY_SINCE, callOf(s)),
    answer: () => ({ tokens: LEGACY_LEDGER.slice(1), serverTime: SERVER_TIME }),
    after: { hydrations: 0, ended: false, usedTokens: LEGACY_LEDGER },
  },
  {
    op: 'end',
    method: 'POST',
    sub: '',
    sent: undefined,
    invoke: (bridge, s) => bridge.end(s.cookies, callOf(s)),
    answer: () => ({ ended: true, serverTime: SERVER_TIME }),
    after: { hydrations: 0, ended: true, usedTokens: [] },
  },
];

function wireDate(text: string): Date {
  const at = parseWireTime(text);
  if (at === undefined) throw new Error(`invalid wire time ${text}`);
  return at;
}

describe('createBridgeClient against the legacy origin double', () => {
  let legacy: LegacyOrigin;

  const bridge = (overrides: Partial<BridgeClientOptions> = {}): BridgeClient =>
    createBridgeClient({ legacyOrigin: legacy.url, hmacKey: TEST_BRIDGE_KEY, clock: TEST_CLOCK, ...overrides });

  // A logged-in tenant-a session as Masa's login left it, with a two-entry CSRF ledger.
  const tenantSession = (): CreatedSession =>
    legacy.createSession({
      user: { ...USER },
      isLoggedIn: true,
      siteId: 'tenant-a',
      memberships: MEMBERSHIPS,
      membershipIds: MEMBERSHIP_IDS,
      csrfSecretKey: LEGACY_CSRF,
      used: new Map(LEGACY_LEDGER.map(({ token, usedAt }) => [token, wireDate(usedAt)])),
    });

  const stateOf = (session: LegacySession): SessionState => ({
    hydrations: session.hydrations,
    ended: session.ended,
    usedTokens: legacy.usedTokens(session.legacySessionId),
  });

  const sessionNamed = (legacySessionId: string): LegacySession => {
    const session = legacy.sessions.get(legacySessionId);
    if (session === undefined) throw new Error(`no legacy session ${legacySessionId}`);
    return session;
  };

  beforeAll(async () => {
    legacy = await startLegacyOrigin();
  });

  beforeEach(() => {
    legacy.clearRequests();
  });

  afterAll(async () => {
    await legacy.close();
  });

  it.each(LEGACY_CASES)(
    'session.$op is signed for the attached session with a TTL of at most 60 s and returns the bridge JSON',
    async (c) => {
      const s = tenantSession();

      const result = await c.invoke(bridge(), s);

      expect(legacy.bridgeCalls).toHaveLength(1);
      const [call] = legacy.bridgeCalls;
      expect(call).toMatchObject({ op: c.op, status: 200, legacySessionId: s.session.legacySessionId });
      expect(result).toEqual({ body: call?.body, setCookies: [] });
      expect(result.body).toEqual(c.answer(s));
      expect(stateOf(s.session)).toEqual(c.after);

      const req = call?.request;
      expect(req?.method).toBe(c.method);
      expect(req?.path).toBe(SESSION_PAGE);
      expect(req?.query.op).toBe(c.op);
      expect(req?.headers.cookie).toBe(legacy.sessionCookieHeader(s.session));
      expect(req?.headers['user-agent']).toBe(CALL.userAgent);
      const sent: unknown = req?.body.length === 0 ? undefined : JSON.parse(req?.body.toString('utf8') ?? '');
      expect(sent).toEqual(c.sent);

      const assertion = assertionOf(req);
      const claims = claimsOf(assertion);
      expect(claims).toMatchObject({
        aud: 'legacy-bridge',
        op: `session.${c.op}`,
        sid: s.session.legacySessionId,
        sub: c.sub,
        siteId: '',
      });
      const ttl = claims.exp - TEST_CLOCK.now().getTime() / 1000;
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
      expect(verifyBridgeAssertion(assertion, TEST_BRIDGE_KEY, new MemoryNonceStore(), TEST_CLOCK.now())).toEqual({
        ok: true,
        payload: claims,
      });
      expect(call?.payload).toEqual(claims);
    },
  );

  it('runs describe, hydrate, markUsed, usedSince and end on one session, each with a distinct nonce', async () => {
    const s = tenantSession();
    const client = bridge();

    for (const c of LEGACY_CASES) await c.invoke(client, s);

    expect(legacy.bridgeCalls.map(({ op, status }) => [op, status])).toEqual(LEGACY_CASES.map(({ op }) => [op, 200]));
    const nonces = legacy.bridgeCalls.map(({ payload }) => payload?.nonce);
    expect(nonces).toEqual(LEGACY_CASES.map(() => expect.stringMatching(/^[0-9a-f]{32}$/)));
    expect(new Set(nonces).size).toBe(LEGACY_CASES.length);
    expect(s.session).toMatchObject({ hydrations: 1, ended: true });
  });

  it('hydrate delivers the snapshot, CSRF secret and used tokens to the legacy session unchanged', async () => {
    const s = tenantSession();

    await bridge().hydrate(s.cookies, HYDRATE, callOf(s));

    expect(JSON.parse(legacy.bridgeCalls[0]?.request.body.toString('utf8') ?? '')).toEqual(HYDRATE);
    expect(s.session).toMatchObject({
      // The double holds datetime user keys as Dates, as session.mura does.
      user: { ...USER, lastlogin: wireDate(USER.lastlogin), passwordCreated: wireDate(USER.passwordCreated) },
      isLoggedIn: true,
      memberships: MEMBERSHIPS,
      membershipIds: MEMBERSHIP_IDS,
      csrfSecretKey: HYDRATE.csrfSecretKey,
    });
    expect(legacy.usedTokens(s.session.legacySessionId)).toEqual(HYDRATE.usedTokens);
  });

  it.each<[string, (client: BridgeClient) => Promise<BridgeResult<{ sessionId: string }>>]>([
    ['describe', (client) => client.describe({}, { userAgent: CALL.userAgent })],
    ['hydrate', (client) => client.hydrate({}, HYDRATE, { userAgent: CALL.userAgent })],
  ])('session.%s without session cookies returns the new session cookies ColdFusion set verbatim', async (_op, invoke) => {
    const result = await invoke(bridge());

    const created = sessionNamed(result.body.sessionId);
    expect(result.setCookies).toEqual([
      `CFID=${created.cfid};path=/;HttpOnly;`,
      `CFTOKEN=${created.cftoken};path=/;HttpOnly;`,
      `JSESSIONID=${created.jsessionid};path=/;HttpOnly;`,
    ]);
    expect(legacy.bridgeCalls[0]?.request.headers.cookie).toBeUndefined();
    expect(claimsOf(assertionOf(legacy.bridgeCalls[0]?.request)).sid).toBe('');
  });

  it.each<[string, Partial<BridgeClientOptions>, string | undefined, number, string | undefined]>([
    ['the guard refuses an assertion signed with another key', { hmacKey: 'not-the-bridge-key' }, undefined, 403, undefined],
    ['the assertion sid names another session', {}, 'OPT2TEST_9999_00000000', 409, 'sessionMismatch'],
  ])('session.end fails closed and leaves the session untouched when %s', async (_case, overrides, sid, status, error) => {
    const s = tenantSession();
    const call = { ...callOf(s), ...(sid === undefined ? {} : { legacySessionId: sid }) };

    const failure = await failureOf(bridge(overrides).end(s.cookies, call));

    expect(failure.cause).toMatchObject({ code: `HTTP_${String(status)}`, status, error });
    expect(legacy.bridgeCalls).toMatchObject([{ op: 'end', status }]);
    expect(stateOf(s.session)).toEqual({ hydrations: 0, ended: false, usedTokens: LEGACY_LEDGER });
  });
});

describe('createSiteListClient', () => {
  const sites = (overrides: Partial<BridgeClientOptions> = {}) =>
    createSiteListClient({ legacyOrigin: double.url, hmacKey: VECTOR_KEY, clock: fixedClock(NOW), ...overrides });

  it('sends a signed GET to site.cfm?op=list without cookies, as the bridge bot', async () => {
    double.setHandler((_req, res) => {
      sendJson(res, 200, { sites: ['default', 'tenant-a'], serverTime: SERVER_TIME });
    });

    await expect(sites().listSites()).resolves.toEqual(['default', 'tenant-a']);

    expect(double.requests).toHaveLength(1);
    const [req] = double.requests;
    expect(req?.method).toBe('GET');
    expect(req?.url).toBe(`${SITE_PAGE}?op=list`);
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers['user-agent']).toBe('opt2-legacy-bridge-bot');
    expect(req?.headers.accept).toBe('application/json');
    expect(req?.body).toHaveLength(0);
    const assertion = assertionOf(req);
    const { exp, nonce, ...named } = claimsOf(assertion);
    expect(named).toEqual({ aud: 'legacy-bridge', op: 'site.list', sid: '', sub: '', siteId: '' });
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(exp - VECTOR_NOW_SECONDS).toBe(60);
    expect(verifyBridgeAssertion(assertion, VECTOR_KEY, new MemoryNonceStore(), NOW)).toMatchObject({ ok: true });
  });

  it.each<[string, unknown[], string[]]>([
    ['keeps string ids', ['default', 'Tenant-A'], ['default', 'Tenant-A']],
    ['coerces numeric ids to strings', ['default', 42, 7.5], ['default', '42', '7.5']],
    ['answers an empty registry', [], []],
  ])('%s', async (_case, answered, expected) => {
    double.setHandler((_req, res) => {
      sendJson(res, 200, { sites: answered, serverTime: SERVER_TIME });
    });

    await expect(sites().listSites()).resolves.toEqual(expected);
  });

  it.each<{ status: number; body: string; error?: string }>([
    { status: 400, body: '{"error":"badRequest","message":"GET required"}', error: 'badRequest' },
    { status: 403, body: '' },
    { status: 404, body: '{"error":"notFound","message":"unknown op"}', error: 'notFound' },
    { status: 500, body: '{"error":"serverError","message":"expression"}', error: 'serverError' },
  ])('fails closed on HTTP $status', async ({ status, body, error }) => {
    double.setHandler((_req, res) => {
      sendBytes(res, status, body);
    });

    const failure = await failureOf(sites().listSites());

    const detail = error === undefined ? '' : ` ${error}`;
    expect(failure.cause).toMatchObject({
      message: `legacy bridge site.list answered HTTP ${String(status)}${detail}`,
      code: `HTTP_${String(status)}`,
      status,
      error,
    });
  });

  it.each([
    ['no sites key', '{"serverTime":"2026-06-30T12:00:00.000"}'],
    ['a string for sites', '{"sites":"default"}'],
    ['a JSON array body', '["default"]'],
    ['a JSON null body', 'null'],
    ['an object entry', '{"sites":["default",{"siteid":"tenant-a"}]}'],
    ['a null entry', '{"sites":[null]}'],
  ])('fails closed on a 2xx with %s', async (_case, body) => {
    double.setHandler((_req, res) => {
      sendBytes(res, 200, body, { 'content-type': 'application/json; charset=utf-8' });
    });

    const failure = await failureOf(sites().listSites());

    expect(failure.cause).toMatchObject({ message: 'legacy bridge site.list answered no list of site ids' });
  });

  it('fails closed on a 2xx that is not JSON', async () => {
    double.setHandler((_req, res) => {
      sendBytes(res, 200, '<html>Masa CMS</html>', { 'content-type': 'text/html' });
    });

    const failure = await failureOf(sites().listSites());

    expect(failure.cause).toBeInstanceOf(SyntaxError);
  });

  it('passes fetch manual redirects and the call timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ sites: ['default'] })));

    await expect(sites({ fetch: fetchMock }).listSites()).resolves.toEqual(['default']);

    const [target, init] = fetchMock.mock.calls[0] ?? [];
    expect(target).toBe(`${double.url}${SITE_PAGE}?op=list`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', body: undefined });
    expect(Object.keys(init?.headers ?? {}).sort()).toEqual(['Accept', 'User-Agent', BRIDGE_ASSERTION_HEADER].sort());
    expect(timeout).toHaveBeenCalledWith(SERVICE_CALL_TIMEOUT_MS);
  });
});
