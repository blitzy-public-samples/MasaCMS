// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Check order, statuses and fixture error bodies of the communications fixture auth port (legacy-fixtures/cfml/lib/auth.cfc). */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Roles, SYNTHETIC_ROLES, type UserClaims } from '@opt2/platform/auth';
import { createService, loadEnv, type FastifyInstance, type FastifyRequest } from '@opt2/platform/service-kit';
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { mintUserToken, testVerifier } from '@opt2/platform/testing';
import { fixtureHandler, fixtureMethod, fixtureSuccess } from '../../src/legacy/fixture-envelope.js';
import {
  FIXTURE_ROLES,
  requireAny,
  requireLogin,
  resolveSite,
  rolesHeld,
  userId,
  type FixtureSiteLookup,
} from '../../src/legacy/fixture-auth.js';

const PREFIX = '/legacy-fixtures/cfml/api.cfm/communications';
const FIXTURE_ROUTE = { config: { opt2: { public: true as const, siteCheck: false } } };
const USER_ID = '6F9619FF-8B86-D011-B42D00C04FC964FF';
const MESSAGE_ID = '7A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9';
const KNOWN_SITES = new Set(['default', 'tenant-a', 'tenant-b', 'umbrella']);
const lookup: FixtureSiteLookup = { siteExists: (siteId) => Promise.resolve(KNOWN_SITES.has(siteId.toLowerCase())) };

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

/** Resolved site, or the thrown error type, of one direct resolveSite call. */
async function siteOutcome(params: Record<string, unknown>, user?: UserClaims): Promise<string> {
  try {
    return `site:${await resolveSite(requestWith(user), params, lookup)}`;
  } catch (error) {
    return `error:${(error as { type: string }).type}`;
  }
}

describe('FIXTURE_ROLES', () => {
  it('names the role-map.json and auth.cfc communications sender group', () => {
    const roleMap = JSON.parse(
      readFileSync(new URL('../../../identity/config/role-map.json', import.meta.url), 'utf8'),
    ) as { groups: { groupName: string; role: string }[] };
    const authCfc = readFileSync(new URL('../../../../legacy-fixtures/cfml/lib/auth.cfc', import.meta.url), 'utf8');
    expect(FIXTURE_ROLES.sender).toBe(Roles.communicationsSender);
    expect(roleMap.groups).toContainEqual({ groupName: FIXTURE_ROLES.sender, role: FIXTURE_ROLES.sender });
    expect(authCfc).toContain(`"${FIXTURE_ROLES.sender}"`);
    expect(Object.isFrozen(FIXTURE_ROLES)).toBe(true);
  });
});

describe('direct checks', () => {
  it.each<[string, Record<string, unknown>, UserClaims | undefined, string]>([
    ['the supplied site, as spelled', { SiteID: 'TENANT-A' }, claims([]), 'site:TENANT-A'],
    ['the token site when siteid is absent', {}, claims([]), 'site:tenant-a'],
    ['the token site when siteid is null', { siteid: null }, claims([]), 'site:tenant-a'],
    ['a guest caller with a known site', { siteid: 'tenant-b' }, undefined, 'site:tenant-b'],
    ['a guest caller without a site', { siteid: '' }, undefined, 'error:invalidParameters'],
    ['an unknown site before the token-site check', { siteid: 'nosuch' }, claims([]), 'error:invalidParameters'],
    ['a non-string siteid', { siteid: ['tenant-a'] }, claims([]), 'error:invalidParameters'],
    ['another site than the token site', { siteid: 'tenant-b' }, claims([]), 'error:forbidden'],
  ])('resolveSite with %s', async (_case, params, user, expected) => {
    expect(await siteOutcome(params, user)).toBe(expected);
  });

  it('requireLogin returns the verified claims, and throws authorization when anonymous', () => {
    const user = claims([Roles.member]);
    expect(requireLogin(requestWith(user))).toBe(user);
    expect(() => requireLogin(requestWith())).toThrow(expect.objectContaining({ type: 'authorization' }));
  });

  it.each<[string, string[], string[], string | undefined]>([
    ['the sender role ignoring case', [Roles.communicationsSender], ['COMMUNICATIONS.SENDER'], undefined],
    ['any one of several wanted roles', [Roles.communicationsSender], [Roles.surveysManager, FIXTURE_ROLES.sender], undefined],
    ['no wanted role', [Roles.surveysManager], [FIXTURE_ROLES.sender], 'forbidden'],
    ['S2 without the role group', [Roles.systemUser, Roles.s2], [FIXTURE_ROLES.sender], 'forbidden'],
    ['a wanted role outside the fixture roles', [Roles.siteAdmin], [Roles.siteAdmin], 'forbidden'],
  ])('requireAny with %s', (_case, held, wanted, error) => {
    const user = claims(held, held.includes(Roles.s2));
    const check = (): UserClaims => requireAny(requestWith(user), wanted);
    if (error === undefined) expect(check()).toBe(user);
    else expect(check).toThrow(expect.objectContaining({ type: error }));
  });

  it('requireAny throws authorization before any role check when anonymous', () => {
    expect(() => requireAny(requestWith(), [FIXTURE_ROLES.sender])).toThrow(
      expect.objectContaining({ type: 'authorization' }),
    );
  });

  it('rolesHeld keeps only fixture roles, in auth.cfc order', () => {
    const user = claims([Roles.communicationsSender, Roles.systemUser, Roles.financePreparer, 'm:008']);
    expect(rolesHeld(requestWith(user))).toEqual([Roles.financePreparer, Roles.communicationsSender]);
    expect(rolesHeld(requestWith())).toEqual([]);
  });

  it('userId is the token subject, and empty when anonymous', () => {
    expect(userId(requestWith(claims([])))).toBe(USER_ID);
    expect(userId(requestWith())).toBe('');
  });
});

describe('fixture check order through app.inject', () => {
  let app: FastifyInstance;

  /** The five communications fixture routes: method, path and envelope method. */
  const ROUTES: ReadonlyArray<readonly ['GET' | 'POST', string, string]> = [
    ['GET', `${PREFIX}/templates`, fixtureMethod('templates')],
    ['POST', `${PREFIX}/templates`, fixtureMethod('templates')],
    ['GET', `${PREFIX}/messages`, fixtureMethod('messages')],
    ['POST', `${PREFIX}/messages`, fixtureMethod('messages')],
    ['GET', `${PREFIX}/messages/${MESSAGE_ID}`, fixtureMethod('messages')],
  ];

  beforeAll(async () => {
    app = await createService({
      name: 'communications',
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8115',
        OPT2_SERVICE_NAME: 'communications',
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier('communications'),
    });
    const handler = (method: string) =>
      fixtureHandler(method, async (request, reply, ctx) => {
        const siteid = await resolveSite(request, ctx.params, lookup);
        requireLogin(request);
        requireAny(request, [FIXTURE_ROLES.sender]);
        return fixtureSuccess(reply, { ...ctx, data: { siteid, userid: userId(request) } });
      });
    app.get(`${PREFIX}/templates`, FIXTURE_ROUTE, handler(fixtureMethod('templates')));
    app.post(`${PREFIX}/templates`, FIXTURE_ROUTE, handler(fixtureMethod('templates')));
    app.get(`${PREFIX}/messages`, FIXTURE_ROUTE, handler(fixtureMethod('messages')));
    app.post(`${PREFIX}/messages`, FIXTURE_ROUTE, handler(fixtureMethod('messages')));
    app.get(`${PREFIX}/messages/:id`, FIXTURE_ROUTE, handler(fixtureMethod('messages')));
    await app.ready();
  });

  afterAll(async () => {
    await app.opt2.shutdown();
  });

  /** Status and parsed envelope of one injected request; params travel in the query (GET) or a JSON body (POST). */
  async function call(
    method: 'GET' | 'POST',
    url: string,
    params: Record<string, unknown>,
    token?: { roles: readonly string[]; site?: string; s2?: boolean },
  ): Promise<{ status: number; body: { method: string; data?: Record<string, unknown>; error?: unknown } }> {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      const bearer = await mintUserToken({ site: token.site ?? 'tenant-a', roles: token.roles, s2: token.s2, sub: USER_ID });
      headers.authorization = `Bearer ${bearer}`;
    }
    const query = method === 'GET' ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : '';
    if (method === 'POST') headers['content-type'] = 'application/json';
    const res = await app.inject({
      method,
      url: `${url}${query}`,
      headers,
      ...(method === 'POST' ? { payload: JSON.stringify(params) } : {}),
    });
    return { status: res.statusCode, body: JSON.parse(res.body) as never };
  }

  const ORDER_CASES: ReadonlyArray<
    readonly [string, Record<string, unknown>, { roles: string[]; site?: string } | undefined, number, unknown]
  > = [
    ['an anonymous caller with an unknown site', { siteid: 'nosuch' }, undefined, 400, INVALID_PARAMETERS],
    ['an anonymous caller without a site', {}, undefined, 400, INVALID_PARAMETERS],
    ['an anonymous caller with a valid site', { siteid: 'tenant-a' }, undefined, 401, DENIED],
    ['a sender with an unknown site', { siteid: 'nosuch' }, { roles: [Roles.communicationsSender] }, 400, INVALID_PARAMETERS],
    ['a sender token for another site', { siteid: 'tenant-b' }, { roles: [Roles.communicationsSender] }, 403, DENIED],
    ['a user without communications.sender', { siteid: 'tenant-a' }, { roles: [Roles.systemUser] }, 403, DENIED],
  ];

  it.each(ROUTES.flatMap(([method, url, envelopeMethod]) => ORDER_CASES.map((c) => [method, url, envelopeMethod, ...c] as const)))(
    '%s %s denies %s',
    async (method, url, envelopeMethod, _case, params, token, status, error) => {
      const res = await call(method, url, params, token);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ method: envelopeMethod, error });
    },
  );

  /** Token roles of each persona the fixture denies, and of the one it allows. */
  const PERSONAS: ReadonlyArray<
    readonly [string, { roles: readonly string[]; site?: string; s2?: boolean } | undefined, number]
  > = [
    ['anonymous', undefined, 401],
    [Roles.member, { roles: [Roles.member] }, 403],
    [Roles.systemUser, { roles: [Roles.systemUser] }, 403],
    ['editor', { roles: [Roles.systemUser, 'm:000'] }, 403],
    [Roles.siteAdmin, { roles: [Roles.systemUser, Roles.siteAdmin] }, 403],
    [Roles.s2, { roles: [Roles.systemUser, Roles.s2], s2: true }, 403],
    ['other-tenant', { roles: [Roles.systemUser, Roles.siteAdmin], site: 'tenant-b' }, 403],
    ...SYNTHETIC_ROLES.filter((role) => role !== FIXTURE_ROLES.sender).map(
      (role) => [role, { roles: [Roles.systemUser, role] }, 403] as const,
    ),
    [FIXTURE_ROLES.sender, { roles: [Roles.systemUser, FIXTURE_ROLES.sender] }, 200],
  ];

  it.each(ROUTES.flatMap(([method, url]) => PERSONAS.map((p) => [method, url, ...p] as const)))(
    '%s %s answers %s with the fixture status',
    async (method, url, _persona, token, status) => {
      const res = await call(method, url, { siteid: 'tenant-a' }, token);
      expect(res.status).toBe(status);
      if (status === 200) expect(res.body.data).toEqual({ siteid: 'tenant-a', userid: USER_ID });
      else expect(res.body.error).toEqual(DENIED);
    },
  );
});
