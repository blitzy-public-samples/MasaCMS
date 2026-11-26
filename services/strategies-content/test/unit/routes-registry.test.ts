/** The route registry: every contract operation it owns is registered, and `actorFor` builds the verified actor with its audit name. */
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRouteMatrix, type RouteMatrixEntry, type UserClaims } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import {
  IDENTITY_SERVICE,
  ServiceUnavailableError,
  createService,
  loadEnv,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { createLocalStorageAdapter } from '@opt2/platform/storage';
import { testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { SERVICE, TEST_CLOCK, createFakeTaskPort, createRecordingDb, testEnv } from '../helpers/app.js';

// registerNavRoutes registers nothing (raw.ts serves cnav), so wrapping it is how the suite reads the context the registry built.
const built: ContentRouteContext[] = [];
vi.mock('../../src/routes/v1/cnav.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/routes/v1/cnav.js')>();
  return {
    ...original,
    registerNavRoutes: async (app: FastifyInstance, ctx: ContentRouteContext) => {
      built.push(ctx);
      await original.registerNavRoutes(app, ctx);
    },
  };
});

const { registerRoutes } = await import('../../src/routes/index.js');

type Json = Record<string, unknown>;

/** Contract paths `app.ts` and the platform register: healthz, migration-kit, push, job and task-queue routes. */
const REGISTERED_ELSEWHERE: readonly RegExp[] = [
  /^\/healthz$/,
  /^\/internal\/v1\/migration\/(apply|export|changes|position|watermark|gate)$/,
  /^\/internal\/v1\/events\//,
  /^\/internal\/v1\/jobs\//,
  /^\/internal\/v1\/task-queues\//,
];

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: '8A2B4C6D-1E3F-5A7B-9C0D1E2F3A4B5C6D',
  sid: 'session-1',
  tid: '0b5f3c1e-8a7d-5e4f-9c3b-2a1d0e9f8c7b',
  site: 'tenant-a',
  roles: ['system-user'],
  s2: false,
  epoch: 1,
  iat: 1_780_000_000,
  exp: 1_780_000_300,
};

const identity = { status: 200, calls: 0 };
let stateDir: string;
let app: FastifyInstance;
let ctx: ContentRouteContext;

/** identity's getCurrentSession; any other service call fails the test. */
function identityDouble<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
  if (req.service !== IDENTITY_SERVICE || req.method !== 'GET' || req.path !== '/v1/sessions/current') {
    return Promise.reject(new Error(`unexpected service call ${req.service} ${req.method} ${req.path}`));
  }
  identity.calls += 1;
  const body = identity.status === 200 ? { user: { isLoggedIn: true, userID: CLAIMS.sub, fname: 'Ada', lname: 'Lovelace' } } : {};
  return Promise.resolve({ status: identity.status, headers: {}, body: body as T });
}

/** A service app with only the registry's routes, over the recording pool unless `pool` is false. */
async function buildRegistryApp(opts: { variations: boolean; sortPermission?: string; identityUrl?: string; pool?: boolean }): Promise<FastifyInstance> {
  const urls = opts.identityUrl === undefined ? {} : { OPT2_SERVICE_URLS: JSON.stringify({ [IDENTITY_SERVICE]: opts.identityUrl }) };
  const env = { ...loadEnv(undefined, { ...testEnv(stateDir), ...urls }), MURA_VARIATIONS: opts.variations, MURA_SORTPERMISSION: opts.sortPermission ?? '' };
  const db = createRecordingDb();
  const service = await createService({
    name: SERVICE,
    version: '1.0.0',
    env,
    clock: TEST_CLOCK,
    verifierOverride: testVerifier(SERVICE),
    ...(opts.pool === false ? {} : { pool: db }),
    logger: createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  try {
    const storage = await createLocalStorageAdapter({ stateDir, hmacKey: 'opt2-routes-registry-test-key', now: () => TEST_CLOCK.now().getTime() });
    const repository = createContentRepository({ clock: TEST_CLOCK, schema: db.schema });
    await registerRoutes(service, { env, repository, storage, taskPort: createFakeTaskPort(), clock: TEST_CLOCK });
    return service;
  } catch (err) {
    await service.close();
    throw err;
  }
}

/** A request carrying only what the auth hooks verified. */
function requestWith(user: UserClaims | undefined): FastifyRequest {
  return { opt2Auth: { ...(user === undefined ? {} : { user }), roles: [], transport: 'service' } } as unknown as FastifyRequest;
}

/** A route in comparable text form: method, Fastify path, transport, sorted roles and the public flag. */
function routeText(method: string, url: string, transport: unknown, requires: readonly string[] | undefined, isPublic: boolean): string {
  return `${method} ${url} ${String(transport)} [${[...(requires ?? [])].sort().join(',')}]${isPublic ? ' public' : ''}`;
}

/** The contract operations the registry owns, as Fastify registers them (a trailing `{path}` is the `*` wildcard). */
function contractRoutes(): string[] {
  const doc = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, Json>> };
  const routes: string[] = [];
  for (const [template, item] of Object.entries(doc.paths)) {
    if (REGISTERED_ELSEWHERE.some((pattern) => pattern.test(template))) continue;
    for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
      const op = item[method];
      if (op === undefined) continue;
      const fastifyPath = op['x-opt2-fastify-path'] as string | string[] | undefined;
      const urls = fastifyPath === undefined ? [template.replace(/\{path\}$/, '*').replace(/\{(\w+)\}/g, ':$1')] : [fastifyPath].flat();
      const requires = Array.isArray(op['x-opt2-requires']) ? (op['x-opt2-requires'] as string[]) : undefined;
      for (const url of urls) routes.push(routeText(method.toUpperCase(), url, op['x-opt2-transport'], requires, op['x-opt2-public'] === true));
    }
  }
  return [...new Set(routes)].sort();
}

function registered(route: RouteMatrixEntry): string {
  return routeText(route.method, route.url, route.transport, route.requires, route.public === true);
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-strategies-content-routes-'));
  await writeTestSecrets(stateDir);
  app = await buildRegistryApp({ variations: true });
  ctx = built.at(-1) as ContentRouteContext;
  Object.defineProperty(app.opt2.client, 'request', { value: identityDouble, writable: true, configurable: true, enumerable: true });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  Object.assign(identity, { status: 200, calls: 0 });
});

describe('registerRoutes', () => {
  it('registers every contract operation it owns, with the contract transport and roles, and nothing else', () => {
    const actual = [...new Set(collectRouteMatrix(app).routes.filter((route) => !REGISTERED_ELSEWHERE.some((p) => p.test(route.url))).map(registered))].sort();
    expect(actual).toEqual(contractRoutes());
  });

  it.each([
    [true, true],
    [false, false],
  ])('builds the domain config from configBean defaults with variations=%s from MURA_VARIATIONS', async (variations, expected) => {
    const other = variations ? app : await buildRegistryApp({ variations });
    try {
      const context = variations ? ctx : (built.at(-1) as ContentRouteContext);
      expect(context.domain.config).toEqual({ ...CONTENT_CONFIG_DEFAULTS, variations: expected });
      expect(context.env.MURA_VARIATIONS).toBe(expected);
      expect(context.domain.db).toBe(other.opt2.db);
    } finally {
      if (other !== app) await other.close();
    }
  });

  it('builds the domain config sortPermission from MURA_SORTPERMISSION as written', async () => {
    const other = await buildRegistryApp({ variations: false, sortPermission: 'Author' });
    try {
      expect((built.at(-1) as ContentRouteContext).domain.config).toEqual({ ...CONTENT_CONFIG_DEFAULTS, sortPermission: 'Author' });
    } finally {
      await other.close();
    }
  });

  it('fails start-up without a tenant database', async () => {
    await expect(buildRegistryApp({ variations: false, pool: false })).rejects.toThrow(/tenant database/);
  });
});

describe('actorFor', () => {
  it.each<[string, UserClaims | undefined, Json]>([
    ['no user token', undefined, { userId: '', fullName: '', isLoggedIn: false, siteId: '', tenantId: '' }],
    ['the anonymous principal', { ...CLAIMS, sub: '', roles: [] }, { userId: '', fullName: '', isLoggedIn: false, siteId: 'tenant-a', tenantId: CLAIMS.tid }],
  ])('builds a signed-out actor for %s without calling identity', async (_label, claims, expected) => {
    expect(await ctx.actorFor(requestWith(claims))).toMatchObject(expected);
    expect(identity.calls).toBe(0);
  });

  it("names a signed-in actor with its session's fname and lname, once per request", async () => {
    const request = requestWith(CLAIMS);
    const [first, second] = await Promise.all([ctx.actorFor(request), ctx.actorFor(request)]);
    expect(second).toBe(first);
    expect(first).toEqual({
      userId: CLAIMS.sub,
      fullName: 'Ada Lovelace',
      isLoggedIn: true,
      s2: false,
      roles: ['system-user'],
      siteId: 'tenant-a',
      tenantId: CLAIMS.tid,
      sessionId: 'session-1',
    });
    expect(identity.calls).toBe(1);
    await ctx.actorFor(requestWith(CLAIMS));
    expect(identity.calls).toBe(2);
  });

  it('fails closed with the legacy 503 error when identity answers non-2xx', async () => {
    identity.status = 503;
    await expect(ctx.actorFor(requestWith(CLAIMS))).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('fails closed with the legacy 503 error when identity is unreachable', async () => {
    const other = await buildRegistryApp({ variations: false, identityUrl: 'http://127.0.0.1:9' });
    try {
      await expect((built.at(-1) as ContentRouteContext).actorFor(requestWith(CLAIMS))).rejects.toBeInstanceOf(ServiceUnavailableError);
    } finally {
      await other.close();
    }
  });
});
