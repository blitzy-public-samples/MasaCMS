// Deny-by-default route declarations, request hooks, role helpers, inbound header stripping and the route matrix of @opt2/platform/auth.
import { fastify, type FastifyInstance, type FastifyRequest, type RouteShorthandOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthDenial,
  INVOCATION_HEADER,
  PUBSUB_INVOKER_ROLE,
  Roles,
  TASKS_INVOKER_ROLE,
  UndeclaredRouteError,
  collectRouteMatrix,
  hasAnyRole,
  isCoreModuleId,
  moduleRole,
  recordedRoutes,
  registerAuth,
  serializeRouteMatrix,
  serviceRole,
  stripInboundAuthHeaders,
  validateRouteConfig,
  type DenialResponse,
  type HeaderMap,
  type Opt2AuthContext,
  type Opt2RouteConfig,
  type RouteMatrixEntry,
  type Transport,
  type TransportAuthenticator,
} from '../../src/auth/index.js';
import {
  TENANT_A,
  TENANT_B,
  mintServiceToken,
  mintTasksInvokerToken,
  mintUserToken,
  pushKeyQuery,
  testVerifier,
} from '../../src/testing/index.js';

const CALLEE = 'stub';
const USER_ID = 'auth-hooks-user';
const USERS_MODULE_ID = `${'0'.repeat(32)}008`;
const PLUGIN_MODULE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const PUSH_URL = '/internal/v1/events/x.y.z.v1';
const SWEEP_URL = '/internal/v1/outbox/sweep';
const PEOPLE_ONLY_URL = '/internal/v1/people/lookup';
const MIGRATION_ONLY_URL = '/internal/v1/migration/gate';
const OPERATOR_ONLY_URL = '/internal/v1/task-queues/sweep/pause';
const SITE_A = TENANT_A.siteId;
const SITE_B = TENANT_B.siteId;

const DENIED_ENVELOPE = {
  apiversion: 'v1',
  method: 'invalid',
  error: { message: 'Insufficient Account Permissions', code: 'invalid_request' },
};

const { transports } = testVerifier(CALLEE);
const handled = vi.fn<(auth: Opt2AuthContext) => void>();
const apps: FastifyInstance[] = [];
let app: FastifyInstance;

async function ok(request: FastifyRequest): Promise<{ ok: true }> {
  handled(request.opt2Auth);
  return { ok: true };
}

function trackedApp(): FastifyInstance {
  const instance = fastify();
  apps.push(instance);
  return instance;
}

function lastAuth(): Opt2AuthContext | undefined {
  return handled.mock.lastCall?.[0];
}

function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

async function invocationFrom(caller: string): Promise<string> {
  return `Bearer ${await mintServiceToken({ caller, audience: CALLEE })}`;
}

/** Headers of a user request as the gateway forwards it: bearer user token plus the gateway's invocation credential. */
async function userHeaders(roles: readonly string[], site: string = SITE_A): Promise<Record<string, string>> {
  const [token, invocation] = await Promise.all([
    mintUserToken({ sub: USER_ID, site, roles }),
    invocationFrom('gateway'),
  ]);
  return { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: invocation };
}

beforeEach(() => {
  handled.mockClear();
  app = trackedApp();
  registerAuth(app, { transports });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

interface InvalidDeclaration {
  label: string;
  url: string;
  config: unknown;
  problem: string;
}

const NEITHER = 'declares neither config.opt2.requires nor config.opt2.public';
const NOT_A_ROLE_LIST = 'config.opt2.requires must be a non-empty array of role strings';

const INVALID_DECLARATIONS: readonly InvalidDeclaration[] = [
  { label: 'no config.opt2', url: '/v1/notes', config: undefined, problem: 'no config.opt2 declaration' },
  { label: 'neither requires nor public', url: '/v1/notes', config: {}, problem: NEITHER },
  { label: 'only a transport and siteCheck', url: '/v1/notes', config: { transport: 'service', siteCheck: false }, problem: NEITHER },
  {
    label: 'both requires and public',
    url: '/v1/notes',
    config: { requires: [Roles.s2], public: true },
    problem: 'declares both config.opt2.requires and config.opt2.public',
  },
  { label: 'an empty requires list', url: '/v1/notes', config: { requires: [] }, problem: NOT_A_ROLE_LIST },
  { label: 'a non-string role', url: '/v1/notes', config: { requires: [Roles.s2, 8] }, problem: NOT_A_ROLE_LIST },
  { label: 'a role string instead of a list', url: '/v1/notes', config: { requires: Roles.s2 }, problem: NOT_A_ROLE_LIST },
  {
    label: 'an unknown transport',
    url: '/v1/notes',
    config: { requires: [Roles.s2], transport: 'smtp' },
    problem: 'unknown transport "smtp"',
  },
  {
    label: 'the service transport on the outbox sweep',
    url: SWEEP_URL,
    config: { requires: [TASKS_INVOKER_ROLE], transport: 'service' },
    problem: 'must declare the cloud-tasks transport, not service',
  },
  {
    label: 'the defaulted transport on a push route',
    url: PUSH_URL,
    config: { requires: [PUBSUB_INVOKER_ROLE] },
    problem: 'must declare the pubsub-push transport, not service',
  },
  {
    label: 'public with the defaulted transport on a push route',
    url: PUSH_URL,
    config: { public: true },
    problem: 'must declare the pubsub-push transport, not service',
  },
  {
    label: 'a managed transport on a service path',
    url: '/v1/notes',
    config: { requires: [Roles.s2], transport: 'cloud-tasks' },
    problem: 'must declare the service transport, not cloud-tasks',
  },
  {
    label: 'public on a push route',
    url: PUSH_URL,
    config: { public: true, transport: 'pubsub-push' },
    problem: 'a pubsub-push route cannot be public',
  },
  {
    label: 'public on a task route',
    url: '/internal/v1/tasks/run',
    config: { public: true, transport: 'cloud-tasks' },
    problem: 'a cloud-tasks route cannot be public',
  },
  {
    label: 'an edge route with requires',
    url: '/v1/proxy',
    config: { requires: [Roles.s2], edge: true },
    problem: 'an edge route must be public on the service transport',
  },
];

interface ValidDeclaration {
  label: string;
  url: string;
  config: Opt2RouteConfig;
  transport: Transport;
}

const VALID_DECLARATIONS: readonly ValidDeclaration[] = [
  { label: 'an anyOf role list', url: '/v1/notes', config: { requires: [Roles.siteAdmin, Roles.s2] }, transport: 'service' },
  { label: 'a public route', url: '/healthz', config: { public: true }, transport: 'service' },
  { label: 'an edge route', url: '/v1/proxy', config: { public: true, edge: true }, transport: 'service' },
  {
    label: 'a site-check opt-out',
    url: '/v1/sites/:siteid/notes',
    config: { requires: [Roles.siteAdmin], siteCheck: false },
    transport: 'service',
  },
  {
    label: 'an explicit service transport on an internal path',
    url: '/internal/v1/migration/apply',
    config: { requires: [Roles.platformMigration], transport: 'service' },
    transport: 'service',
  },
  {
    label: 'the outbox sweep',
    url: SWEEP_URL,
    config: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' },
    transport: 'cloud-tasks',
  },
  {
    label: 'a job',
    url: '/internal/v1/jobs/feed-auto-import',
    config: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' },
    transport: 'cloud-tasks',
  },
  {
    label: 'a push route',
    url: PUSH_URL,
    config: { requires: [PUBSUB_INVOKER_ROLE], transport: 'pubsub-push' },
    transport: 'pubsub-push',
  },
];

function routeOptions(config: unknown): RouteShorthandOptions {
  return config === undefined ? {} : { config: { opt2: config as Opt2RouteConfig } };
}

describe('validateRouteConfig', () => {
  it.each(INVALID_DECLARATIONS)('rejects $label with UndeclaredRouteError', ({ url, config, problem }) => {
    const err = thrownBy(() => validateRouteConfig('POST', url, config as Opt2RouteConfig | undefined));

    expect(err).toBeInstanceOf(UndeclaredRouteError);
    expect(err).toMatchObject({ name: 'UndeclaredRouteError', method: 'POST', url, message: `POST ${url}: ${problem}` });
  });

  it.each(VALID_DECLARATIONS)('returns $label with its transport filled in, leaving the input unchanged', ({ url, config, transport }) => {
    const snapshot = structuredClone(config);

    expect(validateRouteConfig('GET', url, config)).toStrictEqual({ ...config, transport });
    expect(config).toStrictEqual(snapshot);
  });
});

describe('registerAuth start-up', () => {
  it.each(INVALID_DECLARATIONS)('fails app.ready() for a plugin route with $label', async ({ url, config, problem }) => {
    app.register(async (instance) => {
      instance.post(url, routeOptions(config), ok);
    });

    const ready = app.ready();

    await expect(ready).rejects.toBeInstanceOf(UndeclaredRouteError);
    await expect(ready).rejects.toMatchObject({ method: 'POST', url, message: `POST ${url}: ${problem}` });
  });

  it('throws from a root-level declaration without config.opt2', () => {
    expect(() => app.get('/v1/notes', ok)).toThrow(UndeclaredRouteError);
  });

  it('starts cleanly with valid declarations and records each with its transport', async () => {
    app.register(async (instance) => {
      for (const { url, config } of VALID_DECLARATIONS) {
        instance.post(url, { config: { opt2: config } }, ok);
      }
    });

    await app.ready();

    expect(recordedRoutes(app)).toStrictEqual(
      VALID_DECLARATIONS.map(({ url, config, transport }) => ({ method: 'POST', url, config: { ...config, transport } })),
    );
  });
});

describe('request authentication and role checks', () => {
  beforeEach(() => {
    app.get('/v1/admin', { config: { opt2: { requires: [Roles.s2] } } }, ok);
    app.get('/v1/staff', { config: { opt2: { requires: [Roles.siteAdmin, Roles.s2] } } }, ok);
    app.post('/v1/staff', { config: { opt2: { requires: [Roles.siteAdmin, Roles.s2] } } }, ok);
    app.get('/v1/sites/:siteid/staff', { config: { opt2: { requires: [Roles.siteAdmin] } } }, ok);
    app.get('/v1/unchecked', { config: { opt2: { requires: [Roles.siteAdmin], siteCheck: false } } }, ok);
    app.get('/v1/users', { config: { opt2: { requires: [moduleRole(USERS_MODULE_ID)] } } }, ok);
    app.get('/v1/open', { config: { opt2: { public: true } } }, ok);
    app.get('/v1/proxy', { config: { opt2: { public: true, edge: true } } }, ok);
    app.get(PEOPLE_ONLY_URL, { config: { opt2: { requires: [serviceRole('people')] } } }, ok);
    app.get(MIGRATION_ONLY_URL, { config: { opt2: { requires: [Roles.platformMigration] } } }, ok);
    app.get(OPERATOR_ONLY_URL, { config: { opt2: { requires: [Roles.platformOperator] } } }, ok);
    app.post(PUSH_URL, { config: { opt2: { requires: [PUBSUB_INVOKER_ROLE], transport: 'pubsub-push' } } }, ok);
    app.post(SWEEP_URL, { config: { opt2: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' } } }, ok);
  });

  it('answers an anonymous request to a role route with the legacy 401 envelope without running the handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toBe('application/json;charset=utf-8');
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it.each([
    { url: '/v1/admin', roles: [Roles.systemUser, Roles.siteAdmin] },
    { url: '/v1/staff', roles: [Roles.member] },
    { url: '/v1/staff', roles: [] },
    { url: '/v1/users', roles: [Roles.s2, 'm:000'] },
  ])('answers 403 to a user token with $roles on $url', async ({ url, roles }) => {
    const res = await app.inject({ url, headers: await userHeaders(roles) });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it.each([
    { url: '/v1/staff', roles: [Roles.siteAdmin] },
    { url: '/v1/staff', roles: [Roles.systemUser, Roles.s2] },
    { url: '/v1/users', roles: [moduleRole(USERS_MODULE_ID)] },
  ])('admits a user token with $roles on $url', async ({ url, roles }) => {
    const res = await app.inject({ url, headers: await userHeaders(roles) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ ok: true });
    expect(handled).toHaveBeenCalledOnce();
  });

  it('admits an anonymous request to a public route with no identities', async () => {
    const res = await app.inject({ url: '/v1/open' });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()).toEqual({ roles: [], transport: 'service' });
  });

  it('still verifies credentials presented to a public route', async () => {
    const res = await app.inject({ url: '/v1/open', headers: await userHeaders([Roles.member]) });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()?.user).toMatchObject({ sub: USER_ID, roles: [Roles.member] });
  });

  it('answers 401 to a valid user token presented to a public route without an invocation credential', async () => {
    const token = await mintUserToken({ sub: USER_ID, site: SITE_A, roles: [Roles.member] });

    const res = await app.inject({ url: '/v1/open', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a user-role route', url: '/v1/admin', caller: 'people', status: 401 },
    { label: 'a service-role route it lacks', url: PEOPLE_ONLY_URL, caller: 'gateway', status: 403 },
  ])('answers $status to a service caller without a user token on $label', async ({ url, caller, status }) => {
    const res = await app.inject({ url, headers: { [INVOCATION_HEADER]: await invocationFrom(caller) } });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it('admits a service caller holding the service role a route requires', async () => {
    const res = await app.inject({ url: PEOPLE_ONLY_URL, headers: { [INVOCATION_HEADER]: await invocationFrom('people') } });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()).toEqual({
      service: { name: 'people', roles: [serviceRole('people')] },
      roles: [serviceRole('people')],
      transport: 'service',
    });
  });

  const PLATFORM_ROUTES = [
    { url: MIGRATION_ONLY_URL, workload: 'migration', role: Roles.platformMigration },
    { url: OPERATOR_ONLY_URL, workload: 'operator', role: Roles.platformOperator },
  ];
  const WORKLOAD_ROUTES = [{ url: PEOPLE_ONLY_URL, workload: 'people', role: serviceRole('people') }, ...PLATFORM_ROUTES];
  const CLAIMED_WORKLOAD_ROLES = WORKLOAD_ROUTES.map(({ role }) => role);

  it.each(WORKLOAD_ROUTES.flatMap((route) => ['gateway', 'web'].map((caller) => ({ ...route, caller }))))(
    "answers 403 on $url to a user token claiming $role with $caller's invocation credential",
    async ({ url, caller }) => {
      const token = await mintUserToken({ sub: USER_ID, site: SITE_A, roles: [Roles.member, ...CLAIMED_WORKLOAD_ROLES] });

      const res = await app.inject({
        url,
        headers: { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: await invocationFrom(caller) },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
      expect(handled).not.toHaveBeenCalled();
    },
  );

  it.each(PLATFORM_ROUTES)('admits the $workload workload holding $role on $url', async ({ url, workload, role }) => {
    const res = await app.inject({ url, headers: { [INVOCATION_HEADER]: await invocationFrom(workload) } });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()?.service?.name).toBe(workload);
    expect(lastAuth()?.roles).toStrictEqual([serviceRole(workload), role]);
  });

  it('leaves workload roles a user token claims out of request.opt2Auth.roles', async () => {
    const claimed = [Roles.siteAdmin, ...CLAIMED_WORKLOAD_ROLES];

    const res = await app.inject({ url: '/v1/staff', headers: await userHeaders(claimed) });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()?.roles).toStrictEqual([Roles.siteAdmin, serviceRole('gateway')]);
    expect(lastAuth()?.user?.roles).toStrictEqual(claimed);
  });

  it.each([
    { label: 'an expired user token', exp: -300, aud: undefined, message: 'Access Token Expired' },
    { label: 'a user token for another audience', exp: 300, aud: 'another-audience', message: 'Invalid Access Token' },
  ])('answers 401 invalid_token with the bearer challenge to $label', async ({ exp, aud, message }) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintUserToken({ sub: USER_ID, site: SITE_A, roles: [Roles.s2], iat: now - 600, exp: now + exp, aud });

    const res = await app.inject({
      url: '/v1/admin',
      headers: { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: await invocationFrom('gateway') },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_access_token"');
    expect(res.json()).toStrictEqual({ apiversion: 'v1', method: 'invalid', error: { message, code: 'invalid_token' } });
    expect(handled).not.toHaveBeenCalled();
  });

  it('answers 401 to a repeated Authorization header whose first copy is valid, without running the handler', async () => {
    const now = Math.floor(Date.now() / 1000);
    const [valid, expired] = await Promise.all([
      mintUserToken({ sub: USER_ID, site: SITE_A, roles: [Roles.s2] }),
      mintUserToken({ sub: USER_ID, site: SITE_A, roles: [Roles.s2], iat: now - 600, exp: now - 300 }),
    ]);

    const res = await app.inject({
      url: '/v1/admin',
      headers: { Authorization: [`Bearer ${valid}`, `Bearer ${expired}`], [INVOCATION_HEADER]: await invocationFrom('gateway') },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it('exposes the verified user, user token, calling service and merged roles as request.opt2Auth', async () => {
    const roles = [Roles.systemUser, Roles.siteAdmin];
    const token = await mintUserToken({ sub: USER_ID, site: SITE_A, roles });

    const res = await app.inject({
      url: '/v1/staff',
      headers: { authorization: `Bearer ${token}`, [INVOCATION_HEADER]: await invocationFrom('gateway') },
    });

    expect(res.statusCode).toBe(200);
    const auth = lastAuth();
    expect(auth?.transport).toBe('service');
    expect(auth?.roles).toStrictEqual([...roles, serviceRole('gateway')]);
    expect(auth?.userToken).toBe(token);
    expect(auth?.service).toStrictEqual({ name: 'gateway', roles: [serviceRole('gateway')] });
    expect(auth?.user).toMatchObject({
      iss: 'opt2-local-identity',
      aud: 'opt2-local',
      sub: USER_ID,
      tid: TENANT_A.tenantId,
      site: SITE_A,
      roles,
      s2: false,
      epoch: 0,
    });
  });

  it('authenticates a push route by its push key and a task route by its tasks-invoker token', async () => {
    const push = await app.inject({ method: 'POST', url: `${PUSH_URL}?${pushKeyQuery()}`, payload: {} });

    expect(push.statusCode).toBe(200);
    expect(lastAuth()).toEqual({
      service: { name: 'pubsub-invoker', roles: [PUBSUB_INVOKER_ROLE] },
      roles: [PUBSUB_INVOKER_ROLE],
      transport: 'pubsub-push',
    });

    const task = await app.inject({
      method: 'POST',
      url: SWEEP_URL,
      headers: { authorization: `Bearer ${await mintTasksInvokerToken({ audience: CALLEE })}` },
    });

    expect(task.statusCode).toBe(200);
    expect(lastAuth()).toEqual({
      service: { name: 'tasks-invoker', roles: [TASKS_INVOKER_ROLE] },
      roles: [TASKS_INVOKER_ROLE],
      transport: 'cloud-tasks',
    });
  });

  it.each([
    { label: 'a push delivery without its key', url: PUSH_URL, user: false },
    { label: 'a user token on a task route', url: SWEEP_URL, user: true },
  ])('answers 401 to $label', async ({ url, user }) => {
    const headers = user ? await userHeaders([Roles.s2]) : {};

    const res = await app.inject({ method: 'POST', url, headers, payload: {} });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it('admits an edge route without parsing its credentials or checking siteid', async () => {
    const res = await app.inject({ url: `/v1/proxy?siteid=${SITE_B}`, headers: { authorization: 'Basic opaque' } });

    expect(res.statusCode).toBe(200);
    expect(lastAuth()).toStrictEqual({ roles: [], transport: 'service' });
  });

  it('leaves unknown paths to the 404 handler', async () => {
    const res = await app.inject({ url: '/v1/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });

  describe('siteid check against the token site', () => {
    it.each([
      { label: 'a query siteid of another site', url: `/v1/staff?siteid=${SITE_B}` },
      { label: 'a query SiteID of another site', url: `/v1/staff?SiteID=${SITE_B}` },
      { label: "a query siteid equal to the token's tid", url: `/v1/staff?siteid=${TENANT_A.tenantId}` },
      { label: 'a repeated query siteid', url: `/v1/staff?siteid=${SITE_A}&siteid=${SITE_A}` },
      { label: 'a route siteid of another site', url: `/v1/sites/${SITE_B}/staff` },
      { label: 'a body siteid of another site', method: 'POST' as const, url: '/v1/staff', payload: { siteid: SITE_B } },
      {
        label: 'a body siteid of another site behind a matching query siteid',
        method: 'POST' as const,
        url: `/v1/staff?siteid=${SITE_A}`,
        payload: { siteid: SITE_B },
      },
    ])('answers 403 to $label', async ({ method = 'GET', url, payload }) => {
      const res = await app.inject({ method, url, payload, headers: await userHeaders([Roles.siteAdmin]) });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
      expect(handled).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'no siteid', url: '/v1/staff' },
      { label: 'the token site', url: `/v1/staff?siteid=${SITE_A}` },
      { label: 'the token site in upper case', url: `/v1/staff?siteid=${SITE_A.toUpperCase()}` },
      { label: 'an empty siteid', url: '/v1/staff?siteid=' },
      { label: 'the token site in the route', url: `/v1/sites/${SITE_A}/staff` },
      { label: 'the token site in the body', method: 'POST' as const, url: '/v1/staff', payload: { siteid: SITE_A } },
      { label: 'another site on a siteCheck: false route', url: `/v1/unchecked?siteid=${SITE_B}` },
      { label: 'another site inside a JSON array body', method: 'POST' as const, url: '/v1/staff', payload: [{ siteid: SITE_B }] },
    ])('admits $label', async ({ method = 'GET', url, payload }) => {
      const res = await app.inject({ method, url, payload, headers: await userHeaders([Roles.siteAdmin]) });

      expect(res.statusCode).toBe(200);
      expect(handled).toHaveBeenCalledOnce();
    });

    it('skips the check for an anonymous request to a public route', async () => {
      const res = await app.inject({ url: `/v1/open?siteid=${SITE_B}` });

      expect(res.statusCode).toBe(200);
    });
  });
});

describe('registerAuth fallbacks and options', () => {
  it('denies a route registered before registerAuth with 403', async () => {
    const early = trackedApp();
    early.get('/v1/early', ok);
    registerAuth(early, { transports });

    const res = await early.inject({ url: '/v1/early' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toStrictEqual(DENIED_ENVELOPE);
    expect(handled).not.toHaveBeenCalled();
  });

  it('renders denials with renderDenial when given', async () => {
    const custom = trackedApp();
    const renderDenial = vi.fn((denial: AuthDenial) => ({
      status: denial.statusCode,
      headers: { 'x-denial-reason': denial.reason },
      body: denial.type,
    }));
    registerAuth(custom, { transports, renderDenial });
    custom.get('/v1/admin', { config: { opt2: { requires: [Roles.s2] } } }, ok);

    const res = await custom.inject({ url: '/v1/admin' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['x-denial-reason']).toBe('missing-credential');
    expect(res.body).toBe('authorization');
    expect(renderDenial).toHaveBeenCalledOnce();
    expect(renderDenial.mock.calls[0]?.[0]).toBeInstanceOf(AuthDenial);
  });

  it("renders a route's denials, role and site ones included, with the route's own renderDenial", async () => {
    const instanceRender = vi.fn(() => ({ status: 418, headers: {}, body: 'instance' }));
    const rendered: string[] = [];
    const routeRender = async (denial: AuthDenial, request: FastifyRequest): Promise<DenialResponse> => {
      rendered.push(request.url);
      return { status: denial.statusCode, headers: { 'x-denial-reason': denial.reason }, body: `route ${denial.type}` };
    };
    const custom = trackedApp();
    registerAuth(custom, { transports, renderDenial: instanceRender });
    custom.get('/v1/fixture', { config: { opt2: { requires: [Roles.siteAdmin], renderDenial: routeRender } } }, ok);

    const anonymous = await custom.inject({ url: '/v1/fixture' });
    const member = await custom.inject({ url: '/v1/fixture', headers: await userHeaders([Roles.member]) });
    const otherSite = await custom.inject({ url: `/v1/fixture?siteid=${SITE_B}`, headers: await userHeaders([Roles.siteAdmin]) });

    expect([anonymous, member, otherSite].map((res) => [res.statusCode, res.headers['x-denial-reason'], res.body])).toStrictEqual([
      [401, 'missing-credential', 'route authorization'],
      [403, 'forbidden', 'route authorization'],
      [403, 'site-mismatch', 'route authorization'],
    ]);
    expect(rendered).toStrictEqual(['/v1/fixture', '/v1/fixture', `/v1/fixture?siteid=${SITE_B}`]);
    expect(instanceRender).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a missing credential', roles: undefined, query: '', status: 401, reason: 'missing-credential', user: undefined },
    { label: 'a role denial', roles: [Roles.member], query: '', status: 403, reason: 'forbidden', user: USER_ID },
    { label: 'a site mismatch', roles: [Roles.siteAdmin], query: `?siteid=${SITE_B}`, status: 403, reason: 'site-mismatch', user: USER_ID },
  ].flatMap((denial) => ['/v1/plain', '/v1/fixture'].map((url) => ({ ...denial, url }))))(
    'reports $label on $url to onDenial once, with what was verified, before rendering it',
    async ({ roles, query, url, status, reason, user }) => {
      const events: string[] = [];
      const seenUser: Array<string | undefined> = [];
      const render = (by: string) => (denial: AuthDenial): DenialResponse => {
        events.push(`${by} render`);
        return { status: denial.statusCode, headers: {}, body: by };
      };
      const onDenial = vi.fn((denial: AuthDenial, request: FastifyRequest) => {
        events.push(`onDenial ${denial.reason}`);
        seenUser.push((request.opt2Auth as Opt2AuthContext | null)?.user?.sub);
      });
      const custom = trackedApp();
      registerAuth(custom, { transports, renderDenial: render('instance'), onDenial });
      custom.get('/v1/plain', { config: { opt2: { requires: [Roles.siteAdmin] } } }, ok);
      custom.get('/v1/fixture', { config: { opt2: { requires: [Roles.siteAdmin], renderDenial: render('route') } } }, ok);

      const res = await custom.inject({ url: `${url}${query}`, headers: roles === undefined ? {} : await userHeaders(roles) });

      const renderer = url === '/v1/fixture' ? 'route' : 'instance';
      expect([res.statusCode, res.body]).toStrictEqual([status, renderer]);
      expect(onDenial).toHaveBeenCalledOnce();
      expect(onDenial.mock.calls[0]?.[0]).toBeInstanceOf(AuthDenial);
      expect(events).toStrictEqual([`onDenial ${reason}`, `${renderer} render`]);
      expect(seenUser).toStrictEqual([user]);
      expect(handled).not.toHaveBeenCalled();
    },
  );

  it('passes a failing route renderDenial to the error handler', async () => {
    const custom = trackedApp();
    registerAuth(custom, { transports });
    const renderDenial = (): Promise<never> => Promise.reject(new Error('renderer failed'));
    custom.get('/v1/fixture', { config: { opt2: { requires: [Roles.s2], renderDenial } } }, ok);

    const res = await custom.inject({ url: '/v1/fixture' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ statusCode: 500, message: 'renderer failed' });
    expect(handled).not.toHaveBeenCalled();
  });

  it('passes an authentication failure that is not a denial to the error handler', async () => {
    const failing = trackedApp();
    const service: TransportAuthenticator = {
      transport: 'service',
      authenticate: () => Promise.reject(new Error('key source unavailable')),
    };
    registerAuth(failing, { transports: { ...transports, service } });
    failing.get('/v1/admin', { config: { opt2: { requires: [Roles.s2] } } }, ok);

    const res = await failing.inject({ url: '/v1/admin' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ statusCode: 500, message: 'key source unavailable' });
    expect(handled).not.toHaveBeenCalled();
  });
});

describe('role helpers', () => {
  it('builds m:008 for the core Users module and refuses a plugin module id', () => {
    expect(isCoreModuleId(USERS_MODULE_ID)).toBe(true);
    expect(moduleRole(USERS_MODULE_ID)).toBe('m:008');
    expect(isCoreModuleId(PLUGIN_MODULE_ID)).toBe(false);
    expect(() => moduleRole(PLUGIN_MODULE_ID)).toThrow(new TypeError(`Not a core Masa module id: ${PLUGIN_MODULE_ID}`));
  });

  it('builds service:people for the people workload', () => {
    expect(serviceRole('people')).toBe('service:people');
  });

  it.each([
    { granted: ['a', 'b'], required: ['b'], expected: true },
    { granted: ['a'], required: ['c'], expected: false },
    { granted: ['a'], required: [], expected: false },
  ])('hasAnyRole($granted, $required) is $expected', ({ granted, required, expected }) => {
    expect(hasAnyRole(granted, required)).toBe(expected);
  });
});

describe('stripInboundAuthHeaders', () => {
  const INBOUND: HeaderMap = Object.freeze({
    authorization: 'x',
    'x-serverless-authorization': 'y',
    'x-opt2-tenant': 'z',
    'X-Opt2-Other': 'w',
    cookie: 'c',
  });

  it.each([
    { afterExchange: false, expected: { authorization: 'x', cookie: 'c' } },
    { afterExchange: true, expected: { cookie: 'c' } },
  ])('keeps $expected when afterExchange is $afterExchange, leaving the input unchanged', ({ afterExchange, expected }) => {
    const input: HeaderMap = { ...INBOUND };

    expect(stripInboundAuthHeaders(input, { afterExchange })).toStrictEqual(expected);
    expect(input).toStrictEqual(INBOUND);
  });
});

describe('route matrix', () => {
  const MATRIX_DECLARATIONS: ReadonlyArray<(instance: FastifyInstance) => void> = [
    (instance) => instance.get('/v1/notes', { config: { opt2: { requires: [Roles.siteAdmin, Roles.s2] } } }, ok),
    (instance) => instance.post('/v1/notes', { config: { opt2: { requires: [Roles.siteAdmin], siteCheck: false } } }, ok),
    (instance) => instance.get('/healthz', { config: { opt2: { public: true } } }, ok),
    (instance) =>
      instance.post(PUSH_URL, { config: { opt2: { requires: [PUBSUB_INVOKER_ROLE], transport: 'pubsub-push' } } }, ok),
    (instance) =>
      instance.post(SWEEP_URL, { config: { opt2: { requires: [TASKS_INVOKER_ROLE], transport: 'cloud-tasks' } } }, ok),
    (instance) =>
      instance.route({ method: ['GET', 'POST'], url: '/v1/proxy', config: { opt2: { public: true, edge: true } }, handler: ok }),
    (instance) =>
      instance.get('/v1/hosted', { constraints: { host: 'b.example' }, config: { opt2: { requires: [Roles.s2] } } }, ok),
    (instance) => instance.get('/v1/hosted', { constraints: { host: 'a.example' }, config: { opt2: { public: true } } }, ok),
    (instance) => instance.get('/v1/hosted', { constraints: { host: 'c.example' }, config: { opt2: { public: true } } }, ok),
  ];

  const service = (method: string, url: string, rest: Partial<RouteMatrixEntry>): RouteMatrixEntry => ({
    method,
    url,
    transport: 'service',
    ...rest,
    siteCheck: rest.siteCheck ?? true,
  });

  const EXPECTED_ROUTES: RouteMatrixEntry[] = [
    service('GET', '/healthz', { public: true }),
    service('HEAD', '/healthz', { public: true }),
    { method: 'POST', url: PUSH_URL, transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE], siteCheck: true },
    { method: 'POST', url: SWEEP_URL, transport: 'cloud-tasks', requires: [TASKS_INVOKER_ROLE], siteCheck: true },
    service('GET', '/v1/hosted', { public: true }),
    service('GET', '/v1/hosted', { requires: [Roles.s2] }),
    service('HEAD', '/v1/hosted', { public: true }),
    service('HEAD', '/v1/hosted', { requires: [Roles.s2] }),
    service('GET', '/v1/notes', { requires: [Roles.siteAdmin, Roles.s2] }),
    service('HEAD', '/v1/notes', { requires: [Roles.siteAdmin, Roles.s2] }),
    service('POST', '/v1/notes', { requires: [Roles.siteAdmin], siteCheck: false }),
    service('GET', '/v1/proxy', { public: true, edge: true }),
    service('HEAD', '/v1/proxy', { public: true, edge: true }),
    service('POST', '/v1/proxy', { public: true, edge: true }),
  ];

  function declareAll(instance: FastifyInstance, declarations: ReadonlyArray<(instance: FastifyInstance) => void>): void {
    for (const declare of declarations) {
      declare(instance);
    }
  }

  it('lists each declared route and method once, sorted by url then method', async () => {
    declareAll(app, MATRIX_DECLARATIONS);
    await app.ready();

    expect(collectRouteMatrix(app)).toStrictEqual({ routes: EXPECTED_ROUTES });
  });

  it('serializes deterministically as two-space JSON with one trailing newline, whatever the registration order', async () => {
    const reversed = trackedApp();
    registerAuth(reversed, { transports });
    declareAll(app, MATRIX_DECLARATIONS);
    declareAll(reversed, [...MATRIX_DECLARATIONS].reverse());
    await Promise.all([app.ready(), reversed.ready()]);

    const text = serializeRouteMatrix(collectRouteMatrix(app));

    expect(serializeRouteMatrix(collectRouteMatrix(app))).toBe(text);
    expect(serializeRouteMatrix(collectRouteMatrix(reversed))).toBe(text);
    expect(text).toBe(`${JSON.stringify({ routes: EXPECTED_ROUTES }, null, 2)}\n`);
    expect(text.split('\n').slice(0, 3)).toStrictEqual(['{', '  "routes": [', '    {']);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('refuses an instance without registerAuth', () => {
    const bare = trackedApp();

    expect(() => collectRouteMatrix(bare)).toThrow('registerAuth was not applied to this Fastify instance');
    expect(() => recordedRoutes(bare)).toThrow('registerAuth was not applied to this Fastify instance');
  });
});
