// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Check order, statuses and fixture error bodies of the surveys fixture auth port (legacy-fixtures/cfml/lib/auth.cfc). */
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Roles, SYNTHETIC_ROLES, type UserClaims } from '@opt2/platform/auth';
import {
  createService,
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  loadEnv,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from '@opt2/platform/service-kit';
import { sha256Hex } from '@opt2/platform/migration-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { mintUserToken, testVerifier } from '@opt2/platform/testing';
import { fixtureHandler, fixtureMethod, fixtureSuccess } from '../../src/legacy/fixture-envelope.js';
import {
  FIXTURE_ROLES,
  checkTaskToken,
  isSiteAdmin,
  isSiteMember,
  requireAny,
  requireCsrf,
  requireLogin,
  resolveSite,
  rolesHeld,
  taskTokenOf,
  userId,
  type FixtureSiteLookup,
} from '../../src/legacy/fixture-auth.js';

const ROUTE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const FIXTURE_ROUTE = { config: { opt2: { public: true as const, siteCheck: false } } };
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const KNOWN_SITES = new Set(['default', 'tenant-a', 'tenant-b', 'umbrella']);
const lookup: FixtureSiteLookup = {
  registeredSite: (siteId) => Promise.resolve(KNOWN_SITES.has(siteId.toLowerCase()) ? siteId.toLowerCase() : undefined),
};

const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const DENIED = { code: 'invalid_request', message: 'Insufficient Account Permissions' };
const INVALID_TOKENS = { code: 'invalid_request', message: 'Invalid CSRF tokens' };

const SURVEY_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const EXPIRES = '260630120000123';
const PARAM_TOKENS = { csrf_token: 'PARAM-TOKEN', csrf_token_expires: EXPIRES };
const HEADER_TOKENS = { 'x-csrf_token': 'HEADER-TOKEN', 'x-csrf_token_expires': '260630120000999' };

/** A request carrying only the verified auth context, as the platform hooks attach it. */
function requestWith(user?: UserClaims): FastifyRequest {
  return { opt2Auth: { user, roles: user?.roles ?? [], transport: 'service' } } as unknown as FastifyRequest;
}

/** Verified claims of a tenant-a user holding `roles`. */
function claims(roles: string[], s2 = false): UserClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: USER_ID,
    sid: 'session-1',
    tid: tenantIdForSite('tenant-a'),
    site: 'tenant-a',
    roles,
    s2,
    epoch: 0,
    iat: now,
    exp: now + 300,
  };
}

describe('FIXTURE_ROLES', () => {
  it('holds the role-map.json roles in auth.cfc order, spelled once by the platform', () => {
    const roleMap = JSON.parse(
      readFileSync(new URL('../../../identity/config/role-map.json', import.meta.url), 'utf8'),
    ) as { groups: { role: string }[] };
    expect([...FIXTURE_ROLES]).toEqual(roleMap.groups.map((group) => group.role));
    expect(FIXTURE_ROLES).toBe(SYNTHETIC_ROLES);
  });
});

describe('direct checks', () => {
  it('requireLogin returns the verified claims, and throws authorization when anonymous', () => {
    const user = claims([Roles.member]);
    expect(requireLogin(requestWith(user))).toBe(user);
    expect(() => requireLogin(requestWith())).toThrow(expect.objectContaining({ type: 'authorization' }));
  });

  it.each<[string, string[], string[], string | undefined]>([
    ['a wanted role ignoring case', [Roles.surveysManager], ['SURVEYS.MANAGER'], undefined],
    ['any one of several wanted roles', [Roles.financeApprover], [Roles.surveysManager, Roles.financeApprover], undefined],
    ['no wanted role', [Roles.financePreparer], [Roles.surveysManager], 'forbidden'],
    ['S2 without the role group', [Roles.systemUser, Roles.s2], [Roles.surveysManager], 'forbidden'],
    ['a wanted role outside the fixture roles', [Roles.siteAdmin], [Roles.siteAdmin], 'forbidden'],
  ])('requireAny with %s', (_case, held, wanted, error) => {
    const user = claims(held, held.includes(Roles.s2));
    const check = (): UserClaims => requireAny(requestWith(user), wanted);
    if (error === undefined) expect(check()).toBe(user);
    else expect(check).toThrow(expect.objectContaining({ type: error }));
  });

  it('requireAny throws authorization before any role check when anonymous', () => {
    expect(() => requireAny(requestWith(), [Roles.surveysManager])).toThrow(expect.objectContaining({ type: 'authorization' }));
  });

  it('rolesHeld keeps only fixture roles, in FIXTURE_ROLES order', () => {
    const user = claims([Roles.surveysManager, Roles.systemUser, Roles.timesheetsEmployee, 'm:008']);
    expect(rolesHeld(requestWith(user))).toEqual([Roles.timesheetsEmployee, Roles.surveysManager]);
    expect(rolesHeld(requestWith())).toEqual([]);
  });

  it.each<[string, string[], boolean, boolean]>([
    ['the s2 claim', [], true, true],
    ['the s2 role', [Roles.s2], false, true],
    ['the site-admin role', [Roles.siteAdmin], false, true],
    ['a system user', [Roles.systemUser, Roles.surveysManager], false, false],
  ])('isSiteAdmin with %s', (_case, roles, s2, expected) => {
    expect(isSiteAdmin(requestWith(claims(roles, s2)))).toBe(expected);
  });

  it('isSiteAdmin is false and userId empty when anonymous', () => {
    expect(isSiteAdmin(requestWith())).toBe(false);
    expect(userId(requestWith())).toBe('');
    expect(userId(requestWith(claims([])))).toBe(USER_ID);
  });
});

describe('requireCsrf', () => {
  const MANAGER = claims([Roles.surveysManager]);

  /** A `method` request with url `query` and `headers`, whose identity client answers consume calls with `valid`. */
  function csrfRequest(
    method: string,
    user: UserClaims | undefined,
    query: Record<string, string>,
    headers: Record<string, string> = {},
    valid = true,
  ): { request: FastifyRequest; consume: ReturnType<typeof vi.fn> } {
    const consume = vi.fn(async () => ({ status: 200, headers: {}, body: { valid } }));
    const request = {
      method,
      headers,
      query,
      body: undefined,
      opt2Auth: { user, roles: user?.roles ?? [], transport: 'service' },
      server: { opt2: { client: { request: consume } } },
    } as unknown as FastifyRequest;
    return { request, consume };
  }

  it.each<[string, string, UserClaims | undefined, Record<string, string>]>([
    ['a GET', 'GET', MANAGER, {}],
    ['a HEAD', 'HEAD', MANAGER, {}],
    ['a POST overridden to GET', 'POST', MANAGER, { 'x-http-method-override': 'get' }],
    ['an anonymous POST', 'POST', undefined, {}],
  ])('skips %s without calling identity', async (_case, method, user, headers) => {
    const { request, consume } = csrfRequest(method, user, {}, headers);
    await expect(requireCsrf(request, {} as FastifyReply, SURVEY_ID)).resolves.toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>, string, string]>([
    ['the param token', {}, PARAM_TOKENS.csrf_token, EXPIRES],
    ['the X-csrf_token headers over the params', HEADER_TOKENS, 'HEADER-TOKEN', '260630120000999'],
  ])('has identity consume %s for the route context once per request', async (_case, headers, token, expires) => {
    const { request, consume } = csrfRequest('POST', MANAGER, PARAM_TOKENS, headers);
    await requireCsrf(request, {} as FastifyReply, SURVEY_ID);
    await requireCsrf(request, {} as FastifyReply, SURVEY_ID);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith({
      service: IDENTITY_SERVICE,
      method: 'POST',
      path: CSRF_CONSUME_PATH,
      json: { sessionId: MANAGER.sid, token, expires, context: SURVEY_ID },
    });
  });

  it.each<[string, Record<string, string>, boolean, number]>([
    ['a token identity rejects', PARAM_TOKENS, false, 1],
    ['no token, without calling identity', { csrf_token_expires: EXPIRES }, true, 0],
    ['no expiry, without calling identity', { csrf_token: 'PARAM-TOKEN' }, true, 0],
  ])('throws invalidTokens for %s', async (_case, query, valid, identityCalls) => {
    const { request, consume } = csrfRequest('POST', MANAGER, query, {}, valid);
    await expect(requireCsrf(request, {} as FastifyReply, SURVEY_ID)).rejects.toMatchObject({ type: 'invalidTokens' });
    expect(consume).toHaveBeenCalledTimes(identityCalls);
  });
});

describe('fixture check order through app.inject', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createService({
      name: 'surveys',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8117',
        OPT2_SERVICE_NAME: 'surveys',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('surveys'),
    });
    app.get(
      ROUTE,
      FIXTURE_ROUTE,
      fixtureHandler(fixtureMethod('surveys'), async (request, reply, ctx) => {
        const siteid = await resolveSite(request, ctx.params, lookup);
        requireAny(request, [Roles.surveysManager]);
        return fixtureSuccess(reply, { ...ctx, data: { siteid } });
      }),
    );
    app.post(
      `${ROUTE}/:id/responses`,
      FIXTURE_ROUTE,
      fixtureHandler(fixtureMethod('surveys', 'responses'), async (request, reply, ctx) => {
        const siteid = await resolveSite(request, ctx.params, lookup);
        requireLogin(request);
        return fixtureSuccess(reply, { ...ctx, data: { siteid, userid: userId(request) } });
      }),
    );
    app.post(
      `${ROUTE}/:id/schedule`,
      FIXTURE_ROUTE,
      fixtureHandler(fixtureMethod('surveys', 'schedule'), async (request, reply, ctx) => {
        const siteid = await resolveSite(request, ctx.params, lookup);
        requireAny(request, [Roles.surveysManager]);
        await requireCsrf(request, reply, (request.params as { id: string }).id);
        return fixtureSuccess(reply, { ...ctx, data: { siteid } });
      }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.opt2.shutdown();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Status and parsed envelope of one injected request. */
  async function call(
    url: string,
    opts: { roles?: string[]; site?: string; tid?: string; payload?: unknown } = {},
  ): Promise<{ status: number; body: { method: string; data?: Record<string, unknown>; error?: unknown } }> {
    const headers: Record<string, string> = {};
    if (opts.roles !== undefined) {
      const token = await mintUserToken({ site: opts.site ?? 'tenant-a', tid: opts.tid, roles: opts.roles, sub: USER_ID });
      headers.authorization = `Bearer ${token}`;
    }
    if (opts.payload !== undefined) headers['content-type'] = 'application/json';
    const res = await app.inject({
      method: opts.payload === undefined ? 'GET' : 'POST',
      url,
      headers,
      ...(opts.payload === undefined ? {} : { payload: JSON.stringify(opts.payload) }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as never };
  }

  it.each([
    ['an anonymous caller with an unknown site', `${ROUTE}?siteid=nosuch`, {}, 400, INVALID_PARAMETERS],
    ['an anonymous caller without a site, as default', ROUTE, {}, 401, DENIED],
    ['an anonymous caller with a whitespace-only site, as default', `${ROUTE}?siteid=%20%09`, {}, 401, DENIED],
    ['an anonymous caller with a valid site', `${ROUTE}?siteid=tenant-a`, {}, 401, DENIED],
    ['a manager with an unknown site', `${ROUTE}?siteid=nosuch`, { roles: [Roles.surveysManager] }, 400, INVALID_PARAMETERS],
    [
      'a manager with a site padded by a non-ASCII space',
      `${ROUTE}?siteid=%C2%A0tenant-a`,
      { roles: [Roles.surveysManager] },
      400,
      INVALID_PARAMETERS,
    ],
    ['a user without surveys.manager', `${ROUTE}?siteid=tenant-a`, { roles: [Roles.systemUser] }, 403, DENIED],
    [
      'a tenant-a token on tenant-b with a matching tid',
      `${ROUTE}?siteid=tenant-b`,
      { roles: [Roles.surveysManager], tid: tenantIdForSite('tenant-b') },
      403,
      DENIED,
    ],
  ])('denies %s with the fixture error', async (_case, url, opts, status, error) => {
    const res = await call(url, opts);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ method: 'surveys.surveys', error });
  });

  it.each([
    ['the registered id of a case-variant site', `${ROUTE}?SiteID=TENANT-A`, 'tenant-a'],
    ['the token site when siteid is absent', ROUTE, 'tenant-a'],
    ['the token site when siteid is empty', `${ROUTE}?siteid=`, 'tenant-a'],
    ['the token site when siteid is only whitespace', `${ROUTE}?siteid=%20`, 'tenant-a'],
    ['a query site with a leading space', `${ROUTE}?siteid=%20tenant-a`, 'tenant-a'],
    ['a query site with a trailing space', `${ROUTE}?siteid=tenant-a%20`, 'tenant-a'],
    ['a case-variant query site with a trailing tab', `${ROUTE}?siteid=TENANT-A%09`, 'tenant-a'],
    ['a query site padded by control characters', `${ROUTE}?siteid=%00tenant-a%0D%0A`, 'tenant-a'],
  ])('resolves %s for a manager', async (_case, url, siteid) => {
    const res = await call(url, { roles: [Roles.surveysManager] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ siteid });
  });

  it.each<[string, string, unknown, number]>([
    ['a JSON siteid', '', { siteid: 'tenant-b' }, 200],
    ['a JSON null siteid, falling back to the token site', '', { siteid: null }, 200],
    ['a case-variant JSON siteid, as its registered id', '', { siteid: 'TENANT-B' }, 200],
    ['a JSON siteid over the query siteid', '?siteid=nosuch', { siteid: 'tenant-b' }, 200],
    ['a padded query siteid beside a JSON body without one', '?siteid=%20tenant-b%09', {}, 200],
    ['a JSON array siteid', '', { siteid: ['tenant-b'] }, 400],
    ['a JSON siteid with a leading space', '', { siteid: ' tenant-b' }, 400],
    ['a JSON siteid with a trailing tab', '', { siteid: 'TENANT-B\t' }, 400],
    ['a whitespace-only JSON siteid', '', { siteid: ' ' }, 400],
    ['a padded JSON siteid over the query siteid', '?siteid=tenant-b', { siteid: 'tenant-b ' }, 400],
  ])('reads %s on a login-only route', async (_case, query, payload, status) => {
    const res = await call(`${ROUTE}/X/responses${query}`, { roles: [Roles.member], site: 'tenant-b', payload });
    expect(res.status).toBe(status);
    if (status === 200) expect(res.body.data).toEqual({ siteid: 'tenant-b', userid: USER_ID });
    else expect(res.body.error).toEqual(INVALID_PARAMETERS);
  });

  it.each<[string, string, number]>([
    ['a leading space', ' tenant-b', 200],
    ['a case variant with a trailing tab', 'TENANT-B\t', 200],
    ['only whitespace, as the token site', ' ', 200],
    ['a non-ASCII space', '\u00a0tenant-b', 400],
  ])('trims a form siteid holding %s on a login-only route', async (_case, siteid, status) => {
    const token = await mintUserToken({ site: 'tenant-b', roles: [Roles.member], sub: USER_ID });
    const res = await app.inject({
      method: 'POST',
      url: `${ROUTE}/X/responses`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ siteid }).toString(),
    });
    expect(res.statusCode).toBe(status);
    if (status === 200) expect(res.json()).toMatchObject({ data: { siteid: 'tenant-b', userid: USER_ID } });
    else expect(res.json()).toMatchObject({ error: INVALID_PARAMETERS });
  });

  /** Injects a tenant-a JSON schedule POST for SURVEY_ID with `headers`, carrying a user token when `roles` is given. */
  async function schedule(roles: string[] | undefined, headers: Record<string, string>) {
    const auth: Record<string, string> = {};
    if (roles !== undefined) auth.authorization = `Bearer ${await mintUserToken({ site: 'tenant-a', roles, sub: USER_ID })}`;
    return app.inject({
      method: 'POST',
      url: `${ROUTE}/${SURVEY_ID}/schedule?siteid=tenant-a`,
      headers: { ...auth, ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ launchAt: '2026-07-01T09:00:00Z' }),
    });
  }

  it.each<[string, string[] | undefined, Record<string, string>, boolean, number, unknown, number]>([
    ['an anonymous caller', undefined, HEADER_TOKENS, true, 401, DENIED, 0],
    ['a user without surveys.manager, before the token check', [Roles.systemUser], {}, true, 403, DENIED, 0],
    ['a manager without a token', [Roles.surveysManager], {}, true, 400, INVALID_TOKENS, 0],
    ['a manager whose token identity rejects', [Roles.surveysManager], HEADER_TOKENS, false, 400, INVALID_TOKENS, 1],
  ])('answers a schedule POST from %s in check order', async (_case, roles, headers, valid, status, error, calls) => {
    const consume = vi.spyOn(app.opt2.client, 'request').mockResolvedValue({ status: 200, headers: {}, body: { valid } });
    const res = await schedule(roles, headers);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ method: 'surveys.surveys.schedule', error });
    expect(consume).toHaveBeenCalledTimes(calls);
  });

  it('runs a manager schedule POST once identity consumes its token for the survey id', async () => {
    const consume = vi.spyOn(app.opt2.client, 'request').mockResolvedValue({ status: 200, headers: {}, body: { valid: true } });
    const res = await schedule([Roles.surveysManager], HEADER_TOKENS);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { siteid: 'tenant-a' } });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0]).toMatchObject({
      path: CSRF_CONSUME_PATH,
      json: { token: HEADER_TOKENS['x-csrf_token'], context: SURVEY_ID },
    });
  });
});

describe('site membership and task tokens', () => {
  it.each<[string, string[], boolean, boolean]>([
    ['the s2 claim', [], true, true],
    ['a private-pool system user', [Roles.systemUser], false, true],
    ['a public-pool member', [Roles.member], false, true],
    ['only a fixture role group', [Roles.surveysManager], false, false],
    ['only site-admin', [Roles.siteAdmin], false, false],
  ])('isSiteMember with %s', (_case, roles, s2, expected) => {
    expect(isSiteMember(requestWith(claims(roles, s2)))).toBe(expected);
  });

  it('isSiteMember is false when anonymous', () => {
    expect(isSiteMember(requestWith())).toBe(false);
  });

  it.each<[string, Record<string, unknown> | undefined, string]>([
    ['absent', {}, ''],
    ['without a query', undefined, ''],
    ['read ignoring case, the last spelling winning', { opt2TaskToken: 'first', OPT2TASKTOKEN: 'last' }, 'last'],
    ['repeated, comma-joined as the url scope joins it', { opt2TaskToken: ['a', 'b'] }, 'a,b'],
  ])('taskTokenOf a query %s', (_case, query, expected) => {
    expect(taskTokenOf({ query } as unknown as FastifyRequest)).toBe(expected);
  });

  it.each<[string, string, string, boolean]>([
    ['the token whose hash is stored', 'secret', sha256Hex('secret'), true],
    ['another token', 'other', sha256Hex('secret'), false],
    ['the upper-case hash', 'secret', sha256Hex('secret').toUpperCase(), false],
    ['no stored hash', '', '', false],
  ])('checkTaskToken accepts only %s', (_case, token, stored, expected) => {
    expect(checkTaskToken(token, stored)).toBe(expected);
  });
});
