// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Check order, statuses and fixture error bodies of the surveys fixture auth port (legacy-fixtures/cfml/lib/auth.cfc). */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, SYNTHETIC_ROLES, type UserClaims } from '@opt2/platform/auth';
import { createService, loadEnv, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { mintUserToken, testVerifier } from '@opt2/platform/testing';
import { fixtureHandler, fixtureMethod, fixtureSuccess } from '../../src/legacy/fixture-envelope.js';
import {
  FIXTURE_ROLES,
  isSiteAdmin,
  requireAny,
  requireLogin,
  resolveSite,
  rolesHeld,
  userId,
  type FixtureSiteLookup,
} from '../../src/legacy/fixture-auth.js';

const ROUTE = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const FIXTURE_ROUTE = { config: { opt2: { public: true as const, siteCheck: false } } };
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const KNOWN_SITES = new Set(['default', 'tenant-a', 'tenant-b', 'umbrella']);
const lookup: FixtureSiteLookup = { siteExists: async (siteId) => KNOWN_SITES.has(siteId.toLowerCase()) };

const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const DENIED = { code: 'invalid_request', message: 'Insufficient Account Permissions' };

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
    await app.ready();
  });

  afterAll(async () => {
    await app.opt2.shutdown();
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
    ['an anonymous caller without a site', ROUTE, {}, 400, INVALID_PARAMETERS],
    ['an anonymous caller with a valid site', `${ROUTE}?siteid=tenant-a`, {}, 401, DENIED],
    ['a manager with an unknown site', `${ROUTE}?siteid=nosuch`, { roles: [Roles.surveysManager] }, 400, INVALID_PARAMETERS],
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
    ['the supplied site, as spelled', `${ROUTE}?SiteID=TENANT-A`, 'TENANT-A'],
    ['the token site when siteid is absent', ROUTE, 'tenant-a'],
    ['the token site when siteid is empty', `${ROUTE}?siteid=`, 'tenant-a'],
  ])('resolves %s for a manager', async (_case, url, siteid) => {
    const res = await call(url, { roles: [Roles.surveysManager] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ siteid });
  });

  it.each([
    ['a JSON siteid', { siteid: 'tenant-b' }, 200],
    ['a JSON null siteid, falling back to the token site', { siteid: null }, 200],
    ['a JSON array siteid', { siteid: ['tenant-b'] }, 400],
  ])('reads %s on a login-only route', async (_case, payload, status) => {
    const res = await call(`${ROUTE}/X/responses`, { roles: [Roles.member], site: 'tenant-b', payload });
    expect(res.status).toBe(status);
    if (status === 200) expect(res.body.data).toEqual({ siteid: 'tenant-b', userid: USER_ID });
  });
});
