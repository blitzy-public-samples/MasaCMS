// CSRF claims of legacy-bound admin requests through the whole gateway; csrf.ts's stub-level cases are in csrf-continuity.test.ts.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, generateCsrfToken, type CsrfTokens } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CsrfValidation } from '../../src/cutover/types.js';
import { IDENTITY_OPERATIONS, type ClaimInput, type SettleInput } from '../../src/session/identity-client.js';
import { buildTestGateway, type TestGateway } from '../helpers/app.js';
import { TEST_CLOCK } from '../helpers/env.js';
import { BRIDGE_SESSION_PATH, type CreatedSession, type LegacyResponseSpec } from '../helpers/legacy-origin.js';

const SESSION_ID = 's-1';
const LEGACY_SESSION_ID = 'OPT2CSRF_1001_10000001';
const SECRET = '11111111-2222-3333-4444555566667777';
const USER_ID = '00000000000000000000000000000000001';
const CONTENT_ID = '00000000000000000000000000000000003';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) OPT2-test';
const LEGACY_COOKIES = { CFID: '1001', CFTOKEN: '10000001', JSESSIONID: LEGACY_SESSION_ID } as const;
/** Context of `admin:cperm.update` as the committed inventory records it. */
const CPERM_UPDATE_CONTEXT = 'rc.contentid';
const REJECTION: LegacyResponseSpec = {
  status: 200,
  headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  body: '<p>legacy refused a reused token</p>',
};

type CsrfCall = { op: 'claim'; body: ClaimInput } | { op: 'settle'; body: SettleInput };

interface AdminRequest {
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  form?: Record<string, string>;
}

let gateway: TestGateway;
let browser: CreatedSession;

beforeEach(async () => {
  // v0001 keeps every group legacy, so the login group is legacy and sessions are legacy-primary.
  gateway = await buildTestGateway({
    version: 'v0001',
    seed: {
      jars: [
        {
          session_id: SESSION_ID,
          legacy_session_id: LEGACY_SESSION_ID,
          mode: 'legacy-primary',
          cookies: Object.fromEntries(
            Object.entries(LEGACY_COOKIES).map(([name, value]) => [name, { name, value, attributes: 'path=/;HttpOnly' }]),
          ),
        },
      ],
    },
  });
  browser = gateway.legacy.createSession({
    legacySessionId: LEGACY_SESSION_ID,
    cfid: LEGACY_COOKIES.CFID,
    cftoken: LEGACY_COOKIES.CFTOKEN,
    jsessionid: LEGACY_COOKIES.JSESSIONID,
    csrfSecretKey: SECRET,
    user: { userID: USER_ID, username: 'admin', siteID: 'default' },
  });
  gateway.identity.setSession({
    sessionId: SESSION_ID,
    userId: USER_ID,
    epoch: 1,
    state: 'active',
    mode: 'legacy-primary',
    legacySessionId: LEGACY_SESSION_ID,
  });
});

afterEach(async () => {
  await gateway.close();
});

/** A token the legacy session's secret issues for `context`. */
function tokenFor(context: string): CsrfTokens {
  return generateCsrfToken({ context, secret: SECRET, now: TEST_CLOCK.now() });
}

function fieldsOf(tokens: CsrfTokens): Record<string, string> {
  return { [CSRF_FIELD_TOKEN]: tokens.token, [CSRF_FIELD_EXPIRES]: tokens.expires };
}

/** Sends an admin request from the browser holding the legacy session's cookies. */
function sendAdmin({ method, query = {}, form }: AdminRequest) {
  const search = new URLSearchParams(query).toString();
  return gateway.app.inject({
    method,
    url: search === '' ? '/admin/' : `/admin/?${search}`,
    headers: {
      cookie: browser.cookieHeader,
      'user-agent': USER_AGENT,
      ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    ...(form === undefined ? {} : { payload: new URLSearchParams(form).toString() }),
  });
}

/** Identity's claim and settle calls in arrival order, with their bodies. */
function csrfCalls(): CsrfCall[] {
  const ops = new Map<string, CsrfCall['op']>([
    [IDENTITY_OPERATIONS.claim.path, 'claim'],
    [IDENTITY_OPERATIONS.settle.path, 'settle'],
  ]);
  return gateway.identity.requests.flatMap((req): CsrfCall[] => {
    const op = ops.get(req.path);
    return op === undefined ? [] : [{ op, body: JSON.parse(req.body.toString('utf8')) } as CsrfCall];
  });
}

/** What legacy received in order: bridge session ops by name, page requests by method. */
function legacyTrail(): string[] {
  return gateway.legacy.requests.map((req) => (req.path === BRIDGE_SESSION_PATH ? `bridge:${String(req.query.op)}` : `page:${req.method}`));
}

describe('CSRF claims of a legacy-bound admin request in legacy-primary mode', () => {
  it.each([true, false])(
    'claims a validating branch token pending-legacy, then settles it from the ledger legacy left (consumed: %s)',
    async (consumed) => {
      const tokens = tokenFor(CONTENT_ID);
      if (consumed) gateway.legacy.consumeTokenDuringNextRequest(LEGACY_SESSION_ID, tokens.token);

      const res = await sendAdmin({ method: 'POST', form: { muraAction: 'cPerm.update', contentid: CONTENT_ID, ...fieldsOf(tokens) } });

      expect(res.statusCode).toBe(200);
      expect(csrfCalls()).toEqual<CsrfCall[]>([
        {
          op: 'claim',
          body: { sessionId: SESSION_ID, token: tokens.token, expires: tokens.expires, context: CPERM_UPDATE_CONTEXT },
        },
        {
          op: 'settle',
          body: { sessionId: SESSION_ID, consumed: consumed ? [tokens.token] : [], released: consumed ? [] : [tokens.token] },
        },
      ]);
      expect(gateway.identity.claimAttempts).toEqual([
        { sessionId: SESSION_ID, token: tokens.token, taken: true, state: 'pending-legacy' },
      ]);
      expect(gateway.identity.claimState(SESSION_ID, tokens.token)).toBe(consumed ? 'used' : undefined);
      expect(gateway.legacy.usedTokens(LEGACY_SESSION_ID).map((entry) => entry.token)).toEqual(consumed ? [tokens.token] : []);
    },
  );

  it('claims the form token over a query token, as the merged params let the form win', async () => {
    const queried = tokenFor('query-context');
    const posted = tokenFor(CONTENT_ID);

    await sendAdmin({
      method: 'POST',
      query: { muraAction: 'cPerm.update', ...fieldsOf(queried) },
      form: { contentid: CONTENT_ID, ...fieldsOf(posted) },
    });

    expect(gateway.identity.claimAttempts.map((attempt) => attempt.token)).toEqual([posted.token]);
    expect(csrfCalls()[0]?.body).toMatchObject({ token: posted.token, expires: posted.expires });
  });

  it("puts a token identity already holds as used into the legacy ledger before forwarding, and returns legacy's own answer unchanged", async () => {
    const tokens = tokenFor(CONTENT_ID);
    gateway.identity.setClaim(SESSION_ID, tokens.token, 'used');
    // Legacy's validateCSRFTokens refuses a token its ledger already holds.
    gateway.legacy.setResponse((_req, session) => (session?.used.has(tokens.token) === true ? REJECTION : {}));

    const res = await sendAdmin({ method: 'POST', form: { muraAction: 'cPerm.update', contentid: CONTENT_ID, ...fieldsOf(tokens) } });

    expect(res.statusCode).toBe(REJECTION.status);
    expect(res.headers['content-type']).toBe('text/html;charset=UTF-8');
    expect(res.body).toBe(REJECTION.body);
    const trail = legacyTrail();
    expect(trail.filter((step) => step === 'page:POST')).toHaveLength(1);
    expect(trail).toContain('bridge:markUsed');
    expect(trail.indexOf('bridge:markUsed')).toBeLessThan(trail.indexOf('page:POST'));
    expect(gateway.identity.claimAttempts).toEqual([{ sessionId: SESSION_ID, token: tokens.token, taken: false, state: 'used' }]);
    expect(gateway.identity.claimState(SESSION_ID, tokens.token)).toBe('used');
    expect(gateway.legacy.usedTokens(LEGACY_SESSION_ID).map((entry) => entry.token)).toEqual([tokens.token]);
  });

  it.each<{ validation: CsrfValidation; method: AdminRequest['method']; muraAction: string; context: string }>([
    { validation: 'bypassed', method: 'POST', muraAction: 'cArch.approvalaction', context: 'approvalaction' },
    { validation: 'none', method: 'GET', muraAction: 'cPerm.main', context: '' },
  ])('takes no claim on a $validation branch ($muraAction) and leaves the token usable on both sides', async ({ method, muraAction, context }) => {
    const tokens = tokenFor(context);
    const fields = { muraAction, ...fieldsOf(tokens) };

    const res = await sendAdmin(method === 'GET' ? { method, query: fields } : { method, form: fields });

    expect(res.statusCode).toBe(200);
    expect(gateway.identity.claimAttempts).toEqual([]);
    expect(csrfCalls()).toEqual([]);
    // The session still resolved, so its ledger was read once legacy answered.
    expect(legacyTrail()).toContain('bridge:usedSince');
    expect(legacyTrail()).not.toContain('bridge:markUsed');
    expect(gateway.identity.claimState(SESSION_ID, tokens.token)).toBeUndefined();
    expect(gateway.legacy.usedTokens(LEGACY_SESSION_ID)).toEqual([]);
  });
});
