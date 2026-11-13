/** Route registry wiring: the carried modules over the injected repository, with the site-monitor routes left to `app.ts`. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { ROLE_SET, TENANT_A, authHeadersFor, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import type { ProgramsSitesRepository } from '../../src/repo/repository.js';
import type { ImageSizeRow } from '../../src/repo/tables.js';
import { registerRoutes, registerSiteMonitorRoutes, type RouteDeps } from '../../src/routes/index.js';

const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
// Contract paths of the site, image size and JSON API `site` modules.
const MODULE_PATH = /^\/v1\/|^\/_api\/(?:json|ajax|rest)\/v1(?:\/|$)/;
const SITE_MONITOR_URLS = [
  '/_api/sitemonitor*',
  '/index.cfm/_api/sitemonitor*',
  '/internal/v1/jobs/sitemonitor',
  '/internal/v1/sitemonitor/state',
];
const SELF_URL = 'http://127.0.0.1:8113';
const SIZE_ROW: ImageSizeRow = {
  tenant_id: TENANT_A.tenantId,
  sizeid: '6A1C9E2B-1D3F-4A5B-8C7D9E0F1A2B3C4D',
  siteid: 'tenant-a',
  name: 'hero-wide',
  height: '400',
  width: 'AUTO',
};

const tx = { tenantId: TENANT_A.tenantId } as unknown as TenantTx;
const tenants: string[] = [];
const db: TenantDb = {
  schema: 'programs_sites',
  withTenant: (tenantId, fn) => {
    tenants.push(tenantId);
    return fn(tx);
  },
  withMetadata: () => Promise.reject(new Error('the registry test reads no metadata')),
  end: async () => undefined,
};

const noTask = (): Promise<never> => Promise.reject(new Error('the registry test schedules no task'));
const port: TaskPort = {
  kind: 'local',
  create: noTask,
  delete: noTask,
  list: noTask,
  get: noTask,
  pauseQueue: noTask,
  resumeQueue: noTask,
  queueState: noTask,
  close: async () => undefined,
};

const listImageSizes = vi.fn(async (_tx: TenantTx, _siteId: string): Promise<ImageSizeRow[]> => [SIZE_ROW]);
const repository = { listImageSizes } as unknown as ProgramsSitesRepository;

let stateDir: string;
let env: BaseEnv;
const apps: FastifyInstance[] = [];

/** A programs-sites service with nothing but the platform's own routes. */
async function bareService(): Promise<FastifyInstance> {
  const app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env,
    verifierOverride: testVerifier('programs-sites'),
    pool: db,
    logger: createLogger({ service: 'programs-sites', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

function deps(): RouteDeps {
  return { db, repository, port, clock: fixedClock(new Date(2026, 5, 30, 12)), serviceUrls: env.OPT2_SERVICE_URLS, env };
}

/** `METHOD url` of every declared route. */
async function declared(app: FastifyInstance): Promise<string[]> {
  await app.ready();
  return collectRouteMatrix(app).routes.map((route) => `${route.method} ${route.url}`);
}

/** The routes `register` adds to a bare service. */
async function addedBy(register: (app: FastifyInstance) => Promise<void>): Promise<{ app: FastifyInstance; added: string[] }> {
  const baseline = new Set(await declared(await bareService()));
  const app = await bareService();
  await register(app);
  return { app, added: (await declared(app)).filter((route) => !baseline.has(route)).sort() };
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-routes-index-'));
  await writeTestSecrets(stateDir);
  env = loadEnv(undefined, {
    PORT: '8113',
    OPT2_SERVICE_NAME: 'programs-sites',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_SERVICE_URLS: JSON.stringify({ 'programs-sites': SELF_URL }),
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
  });
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  tenants.length = 0;
  listImageSizes.mockClear();
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.opt2.shutdown();
});

describe('registerRoutes', () => {
  it('adds exactly the contract operations of the site, image size and JSON API site modules', async () => {
    // A JSON API operation names its Fastify route, served with and without the front controller.
    const expected = [
      ...new Set(
        Object.entries(OPENAPI.paths)
          .filter(([template]) => MODULE_PATH.test(template))
          .flatMap(([template, item]) =>
            Object.entries(item)
              .filter(([method]) => HTTP_METHODS.has(method))
              .flatMap(([method, operation]) => {
                const fastifyPath = operation['x-opt2-fastify-path'];
                const urls = typeof fastifyPath === 'string' ? [fastifyPath, `/index.cfm${fastifyPath}`] : [template.replace(/\{(\w+)\}/g, ':$1')];
                return urls.map((url) => `${method.toUpperCase()} ${url}`);
              }),
          ),
      ),
    ].sort();
    const { added } = await addedBy((app) => registerRoutes(app, deps()));
    expect(expected.filter((route) => route.includes('/_api/'))).toHaveLength(42);
    expect(added).toEqual(expected);
  });

  it('registers no site-monitor route', async () => {
    const { app, added } = await addedBy((app) => registerRoutes(app, deps()));
    expect(added.filter((route) => /sitemonitor/i.test(route))).toEqual([]);
    for (const [method, url] of [
      ['GET', '/_api/sitemonitor'],
      ['POST', '/internal/v1/jobs/sitemonitor'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
  });

  it('serves the image size routes through a domain over the injected repository and database', async () => {
    const { app } = await addedBy((app) => registerRoutes(app, deps()));
    const subject = ROLE_SET.find((candidate) => candidate.name === 's2');
    if (subject === undefined) throw new Error('No role subject s2');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sites/tenant-a/image-sizes',
      headers: await authHeadersFor(subject, { audience: 'programs-sites', site: 'tenant-a' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([expect.objectContaining({ sizeID: SIZE_ROW.sizeid, siteID: 'tenant-a', name: 'hero-wide' })]);
    expect(listImageSizes).toHaveBeenCalledWith(tx, 'tenant-a');
    expect(tenants).toEqual([TENANT_A.tenantId]);
  });
});

describe('registerSiteMonitorRoutes', () => {
  it('accepts the same RouteDeps and adds only the site-monitor routes', async () => {
    const routeDeps = deps();
    const { added: carried } = await addedBy((app) => registerRoutes(app, routeDeps));
    const { added } = await addedBy(async (app) => {
      await registerRoutes(app, routeDeps);
      await registerSiteMonitorRoutes(app, routeDeps);
    });
    const monitor = added.filter((route) => !carried.includes(route));
    expect([...new Set(monitor.map((route) => route.slice(route.indexOf(' ') + 1)))].sort()).toEqual([...SITE_MONITOR_URLS].sort());
  });
});
