// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Route registry wiring: the fixture and `/v1`/`/v2` modules always, the attachment file route only over local storage. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { collectRouteMatrix } from '@opt2/platform/auth';
import { createLogger } from '@opt2/platform/logging';
import { createService, fixedClock, loadEnv, type BaseEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createLocalStorageAdapter, type LocalStorageAdapter, type StoragePort } from '@opt2/platform/storage';
import type { TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, testVerifier } from '@opt2/platform/testing';
import type { FinanceRepository } from '../../src/repo/repository.js';
import { ATTACHMENT_BUCKET, attachmentObjectKey } from '../../src/repo/tables.js';
import { registerRoutes, type FinanceDeps } from '../../src/routes/index.js';

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as { load: (text: string) => unknown };
const OPENAPI = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
// Contract paths the three route modules serve; `/internal` and `/healthz` belong to platform handlers.
const MODULE_PATH = /^\/(?:legacy-fixtures|v1|v2|opt2\/files)\//;
const FILE_PATH = /^\/opt2\/files\//;
const FILE_ROUTE = 'GET /opt2/files/finance-attachments/:tenantId/:objectName';

const NOW = Date.parse('2026-06-30T12:00:00Z');
const HMAC_KEY = 'finance-routes-index-test-hmac-key';
const ATTACHMENT_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const BYTES = Buffer.from('%PDF-1.4 routes index');
const KEY_A = attachmentObjectKey(TENANT_A.tenantId, ATTACHMENT_ID, 'scan.pdf');

const unused = (): Promise<never> => Promise.reject(new Error('the registry test touches no finance data'));
const db: TenantDb = { schema: 'finance', withTenant: unused, withMetadata: unused, end: () => Promise.resolve() };
const repository = {} as FinanceRepository;
const cloudPort: StoragePort = {
  kind: 'cloud',
  put: unused,
  get: unused,
  stream: unused,
  open: unused,
  delete: unused,
  head: unused,
  signedUrl: unused,
};
// A local-kind port that cannot verify URLs is not the local adapter, so it gets no file route either.
const unverifyingLocalPort: StoragePort = { ...cloudPort, kind: 'local' };

let stateDir: string;
let env: BaseEnv;
let localAdapter: LocalStorageAdapter;
const apps: FastifyInstance[] = [];

/** A finance service with nothing but the platform's own routes. */
async function bareService(): Promise<FastifyInstance> {
  const app = await createService({
    name: 'finance',
    version: '1.0.0',
    env,
    verifierOverride: testVerifier('finance'),
    logger: createLogger({ service: 'finance', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

function deps(storage: StoragePort): FinanceDeps {
  return { db, repository, storage, clock: fixedClock(NOW) };
}

/** `METHOD url` of every declared route. */
async function declared(app: FastifyInstance): Promise<string[]> {
  await app.ready();
  return collectRouteMatrix(app).routes.map((route) => `${route.method} ${route.url}`);
}

/** The ready app `registerRoutes` built over `storage`, and the routes it added to a bare service. */
async function registeredWith(storage: StoragePort): Promise<{ app: FastifyInstance; added: string[] }> {
  const baseline = new Set(await declared(await bareService()));
  const app = await bareService();
  await registerRoutes(app, deps(storage));
  return { app, added: (await declared(app)).filter((route) => !baseline.has(route)).sort() };
}

/** `METHOD :pattern` of every contract operation whose path `include` selects. */
function contractOperations(include: (template: string) => boolean): string[] {
  return Object.entries(OPENAPI.paths)
    .filter(([template]) => include(template))
    .flatMap(([template, item]) =>
      Object.keys(item)
        .filter((method) => HTTP_METHODS.has(method))
        .map((method) => `${method.toUpperCase()} ${template.replace(/\{(\w+)\}/g, ':$1')}`),
    )
    .sort();
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-finance-routes-index-'));
  env = loadEnv(undefined, {
    PORT: '8119',
    OPT2_SERVICE_NAME: 'finance',
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
  });
  localAdapter = await createLocalStorageAdapter({ stateDir, hmacKey: HMAC_KEY, now: () => NOW });
  await localAdapter.put(ATTACHMENT_BUCKET, KEY_A, BYTES, { contentType: 'application/pdf' });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('registerRoutes', () => {
  it('adds every fixture, /v1, /v2 and local file operation of the contract over the local adapter', async () => {
    const expected = contractOperations((template) => MODULE_PATH.test(template));
    expect(expected).toContain(FILE_ROUTE);
    expect((await registeredWith(localAdapter)).added).toEqual(expected);
  });

  it.each([
    ['a cloud port', cloudPort],
    ['a local-kind port without URL verification', unverifyingLocalPort],
  ])('adds the same operations without the file route over %s', async (_label, storage) => {
    const expected = contractOperations((template) => MODULE_PATH.test(template) && !FILE_PATH.test(template));
    expect(expected.length).toBeGreaterThan(0);
    const { app, added } = await registeredWith(storage);
    expect(added).toEqual(expected);
    expect((await app.inject({ method: 'GET', url: await localAdapter.signedUrl(ATTACHMENT_BUCKET, KEY_A) })).statusCode).toBe(404);
  });

  it('serves a local signed URL through the injected adapter, verified at the injected clock', async () => {
    const { app } = await registeredWith(localAdapter);
    const res = await app.inject({ method: 'GET', url: await localAdapter.signedUrl(ATTACHMENT_BUCKET, KEY_A) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
  });
});
